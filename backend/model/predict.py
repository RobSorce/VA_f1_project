"""
LSTM Prediction Module (PyTorch)
Load trained model and predict next 5 lap times + pit probability.
Fallback chain: PyTorch model → fallback mean → heuristic.
"""
import numpy as np
import json
import math
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / 'saved'

_model = None
_scaler = None
_config = None
_fallback_mean = None
_loaded = False

# Check PyTorch availability
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False


def _load_model():
    global _model, _scaler, _config, _fallback_mean, _loaded
    _loaded = True

    config_path = MODEL_DIR / 'model_config.json'
    model_path = MODEL_DIR / 'lstm_model.pt'
    scaler_path = MODEL_DIR / 'scaler.pkl'
    fallback_path = MODEL_DIR / 'lstm_fallback_mean.npy'

    # Load config
    if config_path.exists():
        with open(config_path) as f:
            _config = json.load(f)

    # Try PyTorch model
    if TORCH_AVAILABLE and model_path.exists() and _config:
        try:
            from model.train import F1LapPredictor
            model = F1LapPredictor(
                n_features=_config['n_features'],
                hidden1=_config.get('hidden1', 64),
                hidden2=_config.get('hidden2', 32),
                pred_len=_config['pred_len'],
            )
            model.load_state_dict(torch.load(model_path, map_location='cpu', weights_only=True))
            model.eval()
            _model = model
            logger.info("Loaded PyTorch LSTM model")
        except Exception as e:
            logger.warning(f"Failed to load PyTorch model: {e}")

    # Load scaler
    if scaler_path.exists():
        try:
            import joblib
            _scaler = joblib.load(scaler_path)
            logger.info("Loaded StandardScaler")
        except Exception as e:
            logger.warning(f"Failed to load scaler: {e}")

    # Fallback mean
    if fallback_path.exists():
        _fallback_mean = np.load(fallback_path)
        logger.info("Loaded fallback mean predictor")

    if _model is None and _fallback_mean is None:
        logger.warning("No trained model found. Using heuristic prediction.")


def predict_laps(last_10_laps: list, tsne_context: list = None,
                 current_lap: int = None, driver: str = None,
                 max_lap: int = None) -> dict:
    """
    Predict next 5 lap times and pit probability with derived metrics.

    Args:
        last_10_laps: list of dicts with lap features
        tsne_context: optional list of t-SNE point IDs for enrichment
        current_lap: current lap number (for derived metrics)
        driver: driver abbreviation
        max_lap: total laps in race

    Returns:
        Enriched prediction dict with predicted_times, pit_probability,
        optimal_pit_lap, predicted_stints, driver_predictions, summary.
    """
    global _model, _scaler, _config, _fallback_mean, _loaded

    if not _loaded:
        _load_model()

    # Build feature matrix from input
    compound_map = {'SOFT': 0, 'MEDIUM': 1, 'HARD': 2, 'INTERMEDIATE': 3, 'WET': 4}

    features = []
    for lap in last_10_laps[-10:]:
        feat = [
            lap.get('lap_time', 90.0),
            lap.get('sector1', 30.0),
            lap.get('sector2', 30.0),
            lap.get('sector3', 30.0),
            compound_map.get(lap.get('compound', 'MEDIUM'), 1),
            lap.get('tyre_life', 10),
            lap.get('fuel_estimate', 0.5),
            lap.get('track_temp', 35.0),
            lap.get('position', 10),
            lap.get('gap_to_leader', 5.0),
            lap.get('gap_ahead', 1.0),
            lap.get('drs', 0),
        ]
        features.append(feat)

    # Pad if less than 10 laps
    while len(features) < 10:
        features.insert(0, features[0] if features else [90.0] * 12)

    X = np.array([features], dtype=np.float32)
    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)

    predicted_times = None
    pit_prob = None
    model_used = "heuristic"

    if _model is not None and _scaler is not None and _config is not None:
        try:
            # Apply scaler
            n_feat = X.shape[2]
            X_flat = X.reshape(-1, n_feat)
            X_scaled = _scaler.transform(X_flat).reshape(1, 10, n_feat).astype(np.float32)

            # Run model
            with torch.no_grad():
                X_tensor = torch.tensor(X_scaled)
                raw_pred = _model(X_tensor).numpy()[0]

            # Inverse transform predicted times (first 5 values are normalized)
            y_mean = _config.get('y_time_mean', 90.0)
            y_std = _config.get('y_time_std', 5.0)
            predicted_times = (raw_pred[:5] * y_std + y_mean).tolist()

            # Pit probability via sigmoid (model outputs logit)
            pit_prob = float(1.0 / (1.0 + math.exp(-float(raw_pred[5]))))

            model_used = "lstm"
        except Exception as e:
            logger.warning(f"Model prediction failed: {e}")

    if predicted_times is None and _fallback_mean is not None and _config is not None:
        y_mean = _config.get('y_time_mean', 90.0)
        y_std = _config.get('y_time_std', 5.0)
        predicted_times = (_fallback_mean[:5] * y_std + y_mean).tolist()
        pit_prob = float(1.0 / (1.0 + math.exp(-float(_fallback_mean[5])))) if len(_fallback_mean) > 5 else 0.1
        model_used = "fallback_mean"

    if predicted_times is None:
        out = _heuristic_prediction(last_10_laps, tsne_context, current_lap, driver, max_lap)
        out['is_heuristic'] = True
        out['model_used'] = 'heuristic'
        return out

    # Clamp predicted times to reasonable range
    predicted_times = [round(max(60.0, min(200.0, t)), 3) for t in predicted_times]

    # t-SNE context enrichment (informational only — no arbitrary penalty)
    summary = f"LSTM prediction ({model_used}) based on last {min(10, len(last_10_laps))} laps."
    if tsne_context:
        summary += f" Enriched with {len(tsne_context)} similar historical races."

    # Derived metrics
    current_compound = last_10_laps[-1].get('compound', 'MEDIUM') if last_10_laps else 'MEDIUM'
    tyre_life = last_10_laps[-1].get('tyre_life', 10) if last_10_laps else 10
    c_lap = current_lap or (last_10_laps[-1].get('lap_number', 30) if last_10_laps else 30)
    m_lap = max_lap or 60

    optimal_pit_lap = _compute_optimal_pit_lap(pit_prob, c_lap, m_lap, tyre_life)
    predicted_stints = _compute_predicted_stints(driver, current_compound, c_lap, optimal_pit_lap, m_lap)
    position_change = _compute_position_change(predicted_times, last_10_laps)

    result = {
        'predicted_times': predicted_times,
        'pit_probability': round(pit_prob, 3),
        'optimal_pit_lap': optimal_pit_lap,
        'predicted_stints': predicted_stints,
        'driver_predictions': {},
        'summary': summary,
        'model_used': model_used,
        'is_heuristic': model_used not in ('lstm',),
    }

    if driver:
        result['driver_predictions'][driver] = {
            'predicted_position_change': position_change,
        }
        result['predicted_laps'] = {driver: predicted_times}
        result['positions'] = {driver: position_change}

    return result


def _compute_optimal_pit_lap(pit_prob, current_lap, max_lap, tyre_life):
    """Estimate optimal pit lap from pit probability and tyre life."""
    if pit_prob > 0.5:
        # High pit probability — pit soon
        laps_until_pit = max(1, math.ceil(-math.log(1 - min(pit_prob, 0.99)) * 5))
    else:
        # Low pit probability — estimate from tyre life
        # Typical stint lengths: SOFT ~18, MEDIUM ~25, HARD ~35
        remaining_tyre = max(1, 25 - tyre_life)
        laps_until_pit = remaining_tyre

    optimal = current_lap + laps_until_pit
    return max(current_lap + 1, min(optimal, max_lap - 2))  # Clamp to valid range


def _compute_predicted_stints(driver, current_compound, current_lap, optimal_pit_lap, max_lap):
    """Generate predicted stint schedule."""
    stints = []

    # Current stint
    stints.append({
        'driver': driver or 'UNK',
        'compound': current_compound,
        'lap_start': current_lap,
        'length': optimal_pit_lap - current_lap,
    })

    # Next stint after predicted pit
    compound_order = {'SOFT': 'HARD', 'MEDIUM': 'HARD', 'HARD': 'MEDIUM', 'INTERMEDIATE': 'INTERMEDIATE', 'WET': 'WET'}
    next_compound = compound_order.get(current_compound, 'MEDIUM')

    remaining = max_lap - optimal_pit_lap
    if remaining > 0:
        stints.append({
            'driver': driver or 'UNK',
            'compound': next_compound,
            'lap_start': optimal_pit_lap,
            'length': remaining,
        })

    return stints


def _compute_position_change(predicted_times, last_10_laps):
    """Estimate position change from predicted pace trend."""
    if not last_10_laps or not predicted_times:
        return 0

    recent_times = [l.get('lap_time', 90.0) for l in last_10_laps[-3:] if l.get('lap_time', 0) > 0]
    if not recent_times:
        return 0

    recent_avg = np.mean(recent_times)
    pred_avg = np.mean(predicted_times[:3])

    # If predicted pace is improving (faster), positive position change
    diff = recent_avg - pred_avg
    if diff > 0.3:
        return 1  # Gaining ~1 position
    elif diff < -0.3:
        return -1  # Losing ~1 position
    return 0


def _heuristic_prediction(last_10_laps, tsne_context=None,
                          current_lap=None, driver=None, max_lap=None):
    """Fallback heuristic when no model is available."""
    if not last_10_laps:
        return {
            'predicted_times': [90.0] * 5,
            'pit_probability': 0.1,
            'optimal_pit_lap': 30,
            'predicted_stints': [],
            'driver_predictions': {},
            'summary': 'Heuristic prediction (no model available).',
        }

    times = [l.get('lap_time', 90.0) for l in last_10_laps if l.get('lap_time', 0) > 0]
    if not times:
        times = [90.0]

    avg_time = float(np.mean(times[-5:]))
    tyre_life = last_10_laps[-1].get('tyre_life', 10) if last_10_laps else 10
    deg_rate = 0.03

    predicted = [round(avg_time + deg_rate * (i + 1), 3) for i in range(5)]
    pit_prob = min(1.0, max(0.0, (tyre_life - 15) * 0.05)) if tyre_life > 15 else 0.05

    current_compound = last_10_laps[-1].get('compound', 'MEDIUM') if last_10_laps else 'MEDIUM'
    c_lap = current_lap or (last_10_laps[-1].get('lap_number', 30) if last_10_laps else 30)
    m_lap = max_lap or 60

    optimal_pit_lap = _compute_optimal_pit_lap(pit_prob, c_lap, m_lap, tyre_life)
    predicted_stints = _compute_predicted_stints(driver, current_compound, c_lap, optimal_pit_lap, m_lap)
    position_change = _compute_position_change(predicted, last_10_laps)

    summary = f"Heuristic: avg {avg_time:.1f}s + {deg_rate}s/lap degradation."
    if tsne_context:
        summary += f" Context: {len(tsne_context)} similar races."

    result = {
        'predicted_times': predicted,
        'pit_probability': round(pit_prob, 3),
        'optimal_pit_lap': optimal_pit_lap,
        'predicted_stints': predicted_stints,
        'driver_predictions': {},
        'summary': summary,
        'model_used': 'heuristic',
        'is_heuristic': True,
    }

    if driver:
        result['driver_predictions'][driver] = {
            'predicted_position_change': position_change,
        }
        result['predicted_laps'] = {driver: predicted}
        result['positions'] = {driver: position_change}

    return result
