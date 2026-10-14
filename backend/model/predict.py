"""
Lap-time forecast and pit probability (PyTorch LSTM and baselines).

The window is built by model/features.py build_window from the session lap
rows at a clock (the function training used), never from client-side
features. The served methods are the ones chosen in
model/saved/forecast_selection.json (written by scripts/evaluate_forecast.py)
on the VALIDATION races: lap times by the mean absolute error over laps
+1..+5, the pit probability by the Brier score. The test races take no part
in the choice; every response names the method and carries the held-out
(test races) numbers of all methods from that file.
A method that cannot run here (no torch, no model, a model the selection did
not evaluate) is skipped for the next one in the held-out ranking.
"""
import hashlib
import json
import logging
import math
from pathlib import Path

import numpy as np

from model import baselines
from model.features import FEATURES, PREDICT_LEN, build_window, rows_from_legacy_laps
from model.pit_timing import optimal_pit_lap as _pit_lap_from_probability

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / 'saved'
SELECTION_FILE = 'forecast_selection.json'

_model = None
_scaler = None
_config = None
_fallback_mean = None
_selection = None
_lstm_issue = None
_loaded = False

# Check PyTorch availability
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False


def model_fingerprint(model_dir: Path = None) -> str:
    """sha1 of lstm_model.pt (None when missing): ties the selection file's
    LSTM numbers to the weights they were measured on."""
    path = Path(model_dir or MODEL_DIR) / 'lstm_model.pt'
    if not path.exists():
        return None
    return hashlib.sha1(path.read_bytes()).hexdigest()


def _load_model(check_fingerprint=True):
    """Load the artefacts. check_fingerprint=False keeps an LSTM that the
    selection file did not evaluate (scripts/evaluate_forecast.py, which
    evaluates it)."""
    global _model, _scaler, _config, _fallback_mean, _selection, _lstm_issue, _loaded
    _loaded = True
    _model = _scaler = _config = _fallback_mean = _selection = None
    _lstm_issue = None

    config_path = MODEL_DIR / 'model_config.json'
    model_path = MODEL_DIR / 'lstm_model.pt'
    scaler_path = MODEL_DIR / 'scaler.pkl'
    fallback_path = MODEL_DIR / 'lstm_fallback_mean.npy'
    selection_path = MODEL_DIR / SELECTION_FILE

    # Load config
    if config_path.exists():
        with open(config_path) as f:
            _config = json.load(f)
    if _config is not None and _config.get('features') != FEATURES:
        _lstm_issue = 'the saved model was trained on other features (retrain: model/prepare_data.py, model/train.py)'
        _config = None

    # Try PyTorch model
    if not TORCH_AVAILABLE:
        _lstm_issue = _lstm_issue or 'PyTorch is not installed'
    elif _config and model_path.exists():
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
            _lstm_issue = f'the model could not be loaded ({e})'
            logger.warning(f"Failed to load PyTorch model: {e}")
    elif _lstm_issue is None:
        _lstm_issue = 'no trained model in model/saved'

    # Load scaler
    if scaler_path.exists():
        try:
            import joblib
            _scaler = joblib.load(scaler_path)
            logger.info("Loaded StandardScaler")
        except Exception as e:
            logger.warning(f"Failed to load scaler: {e}")
    if _model is not None and _scaler is None:
        _model = None
        _lstm_issue = 'no input scaler (model/saved/scaler.pkl)'

    # Fallback mean (kept for the artefact set; the served fallback is the
    # next method of the held-out ranking)
    if fallback_path.exists():
        _fallback_mean = np.load(fallback_path)

    if selection_path.exists():
        with open(selection_path, encoding='utf-8') as f:
            _selection = json.load(f)
        if check_fingerprint and _model is not None and _selection.get('model_fingerprint') != model_fingerprint():
            # Retrained after the evaluation: its held-out numbers are not this model's
            _model = None
            _lstm_issue = 'the model changed after the evaluation (run scripts/evaluate_forecast.py)'
    else:
        logger.warning("No %s: run scripts/evaluate_forecast.py", SELECTION_FILE)


def reload():
    """Read the artefacts again (after a retrain or a new evaluation)."""
    _load_model()


def _ensure_loaded():
    if not _loaded:
        _load_model()


def lstm_available() -> bool:
    _ensure_loaded()
    return _model is not None


def lstm_outputs(windows):
    """(deltas (B, PREDICT_LEN) s, pit probabilities (B,)) of the LSTM for a
    batch of unscaled build_window feature arrays (B, SEQUENCE_LEN, N_FEATURES)."""
    _ensure_loaded()
    if _model is None:
        raise RuntimeError(f'LSTM unavailable: {_lstm_issue}')
    X = np.asarray(windows, dtype=np.float32)
    n, seq, nf = X.shape
    Xs = _scaler.transform(X.reshape(-1, nf)).reshape(n, seq, nf).astype(np.float32)
    Xs = np.nan_to_num(Xs, nan=0.0, posinf=0.0, neginf=0.0)
    with torch.no_grad():
        raw = _model(torch.tensor(Xs)).numpy()
    deltas = raw[:, :PREDICT_LEN] * _config['y_delta_std'] + _config['y_delta_mean']
    pit = 1.0 / (1.0 + np.exp(-raw[:, PREDICT_LEN]))
    return deltas, pit


def lap_time_forecasts(ctx, selection=None, lstm=None):
    """{method: [PREDICT_LEN lap times]} of every method that can run on this
    window; lstm = (deltas row, pit) when already computed (batch evaluation)."""
    sel = _selection if selection is None else selection
    params = (sel or {}).get('baselines', {})
    out = {'persistence': baselines.persistence(ctx)}
    out['stint_linear'], _ = baselines.stint_linear(ctx)
    if params.get('compound_slopes') is not None:
        out['compound_mean'] = baselines.compound_mean(ctx, params['compound_slopes'])
    if lstm is None and lstm_available():
        d, p = lstm_outputs(ctx['features'][None, :, :])
        lstm = (d[0], p[0])
    if lstm is not None:
        out['lstm'] = [ctx['ref_time'] + float(v) for v in lstm[0]]
    return out


def pit_probabilities(ctx, selection=None, lstm=None):
    """{method: pit probability} of every pit method that can run on this window."""
    sel = _selection if selection is None else selection
    params = (sel or {}).get('baselines', {})
    out = {}
    if lstm is None and lstm_available():
        d, p = lstm_outputs(ctx['features'][None, :, :])
        lstm = (d[0], p[0])
    if lstm is not None:
        out['lstm'] = float(lstm[1])
    if params.get('logistic') is not None:
        out['tyre_age_logistic'] = baselines.tyre_age_logistic(ctx, params['logistic'])
    if params.get('base_rate') is not None:
        out['base_rate'] = baselines.base_rate(ctx, params['base_rate'])
    return out


def _pick(kind, available):
    """(method, note) for 'lap_time' or 'pit': the first method of the held-out
    ranking of the selection file that is available here."""
    block = (_selection or {}).get(kind)
    if not block:
        if kind == 'lap_time':
            return 'persistence', (f'No held-out evaluation ({SELECTION_FILE} missing: run '
                                   'scripts/evaluate_forecast.py): persistence, the reference forecast, is shown.')
        first = next((m for m in baselines.PIT_METHODS if m in available), None)
        return first, f'No held-out evaluation ({SELECTION_FILE} missing): pit probability not ranked.'
    for m in block['ranking']:
        if m in available:
            note = None
            if m != block['selected']:
                note = (f"{baselines.METHOD_LABELS[block['selected']]} has the best {_selection_set_name(block)} "
                        f"score but cannot run here ({_lstm_issue or 'unavailable'}): the next best, "
                        f"{baselines.METHOD_LABELS[m]}, is used.")
            return m, note
    return None, 'No ranked method can run here.'


def _selection_set_name(block):
    """Races the selection file chose on: 'validation' (scripts/evaluate_forecast.py),
    'held-out' for a file written before the choice moved to the validation races."""
    return 'validation' if block.get('selection_set') == 'val' else 'held-out'


def _held_out_block(kind):
    """Every method's held-out (test races) number; the choice was made on
    selected_on (the validation races), so the served method's number here
    is not the one it was picked on."""
    block = (_selection or {}).get(kind)
    if not block:
        return None
    metric = block['metric']
    return {
        'metric': metric,
        'races': (_selection.get('split') or {}).get('test'),
        'values': {m: v['test'] for m, v in block['methods'].items()},
        'ranking': block.get('test_ranking') or block['ranking'],
        'best': (block.get('test_ranking') or block['ranking'])[0],
        'selected_on': _selection_set_name(block),
        'selection_races': (_selection.get('split') or {}).get('val') if block.get('selection_set') == 'val' else None,
        'selection_values': {m: v.get(block.get('selection_set') or 'test') for m, v in block['methods'].items()},
        'selection_ranking': block['ranking'],
        'selected': block['selected'],
    }


def _lstm_note(method):
    """Plain statement of where the LSTM stands: on the races the choice was
    made on (validation) and on the held-out test races. It says so when the
    LSTM loses on either."""
    block = (_selection or {}).get('lap_time')
    if not block or 'lstm' not in block['methods']:
        return None
    on = _selection_set_name(block)
    key = 'val' if on == 'validation' else 'test'
    lstm = block['methods']['lstm']
    best = block['selected']
    test_best = (block.get('test_ranking') or block['ranking'])[0]
    label = baselines.METHOD_LABELS
    if best == 'lstm':
        if on == 'held-out' or test_best == 'lstm':
            extra = '' if on == 'held-out' else f", and the best held-out test MAE ({lstm['test']:.3f} s)"
            return f"The LSTM has the best {on} MAE ({lstm[key]:.3f} s over laps +1..+5){extra}."
        return (f"The LSTM has the best validation MAE ({lstm['val']:.3f} s), so it is served, but it does not beat "
                f"{label[test_best]} on the held-out test races (MAE {lstm['test']:.3f} s vs "
                f"{block['methods'][test_best]['test']:.3f} s over laps +1..+5).")
    held = '' if on == 'held-out' else (f"; held-out test MAE {lstm['test']:.3f} s vs "
                                       f"{block['methods'][best]['test']:.3f} s")
    return (f"The LSTM does not beat {label[best]} on the {on} races "
            f"(MAE {lstm[key]:.3f} s vs {block['methods'][best][key]:.3f} s over laps +1..+5{held}), "
            f"so {label[method] if method else 'no method'} is shown.")


def _no_window(ctx, feature_source, session_now):
    return {
        'driver': ctx['driver'], 'origin_lap': ctx['origin_lap'], 'session_now': session_now,
        'target_laps': [], 'predicted_times': [], 'method': None, 'method_label': None,
        'method_forecasts': {}, 'held_out': _held_out_block('lap_time'), 'lstm_selected': False,
        'lstm_note': _lstm_note(None), 'method_note': None,
        'pit_probability': None, 'pit_method': None, 'pit_probabilities': {},
        'pit_held_out': _held_out_block('pit'), 'pit_note': None, 'optimal_pit_lap': None, 'predicted_stints': [],
        'driver_predictions': {ctx['driver']: {}} if ctx['driver'] else {},
        'summary': ctx['reason'], 'model_used': None, 'is_heuristic': True,
        'window': {'laps': ctx['window_laps'], 'ref_lap': None, 'ref_time': None,
                   'features': FEATURES, 'values': None},
        'feature_source': feature_source, 'reason': ctx['reason'],
    }


def forecast_from_context(ctx, max_lap=None, tsne_context=None, feature_source='cache', session_now=None):
    """The /api/predict/lstm response of one build_window context."""
    _ensure_loaded()
    if ctx['features'] is None:
        return _no_window(ctx, feature_source, session_now)
    driver = ctx['driver']
    lstm = None
    if lstm_available():
        d, p = lstm_outputs(ctx['features'][None, :, :])
        lstm = (d[0], p[0])
    times = lap_time_forecasts(ctx, lstm=lstm)
    pits = pit_probabilities(ctx, lstm=lstm)
    method, method_note = _pick('lap_time', times)
    pit_method, pit_note = _pick('pit', pits)
    predicted = [round(float(t), 3) for t in times[method]]
    pit_prob = pits.get(pit_method)

    c_lap = ctx['origin_lap']
    # The race distance comes from the caller (the cached race's last lap, or
    # the max_lap a live client sends); without it no pit lap or stint is
    # projected (never a guessed distance nor the laps run so far)
    m_lap = int(max_lap) if max_lap else None
    pit_projection_reason = None
    if m_lap is None:
        optimal = None
        pit_projection_reason = ('Race distance unknown (no max_lap = total race laps sent): '
                                 'no pit lap or stint is projected.')
    else:
        optimal = _compute_optimal_pit_lap(pit_prob, c_lap, m_lap) if pit_prob is not None else None
    stints = (_compute_predicted_stints(driver, ctx['origin_compound'] or 'UNKNOWN', c_lap, optimal, m_lap)
              if optimal is not None else [])

    label = baselines.METHOD_LABELS[method]
    held = _held_out_block('lap_time')
    summary = (f"{label} forecast of laps {c_lap + 1}-{c_lap + PREDICT_LEN} from {ctx['n_clean']} clean laps "
               f"(laps {ctx['window_laps'][0]}-{ctx['window_laps'][-1]}) completed by lap {c_lap}.")
    if held and method in held['values']:
        summary += f" Held-out MAE {held['values'][method]:.3f} s ({len(held['races'] or [])} test races)."
    if tsne_context:
        summary += f" Enriched with {len(tsne_context)} similar historical races."

    result = {
        'driver': driver,
        'origin_lap': c_lap,
        'session_now': session_now,
        'target_laps': list(range(c_lap + 1, c_lap + PREDICT_LEN + 1)),
        'predicted_times': predicted,
        'method': method,
        'method_label': label,
        'method_forecasts': {m: [round(float(t), 3) for t in v] for m, v in times.items()},
        'held_out': held,
        'lstm_selected': method == 'lstm',
        'lstm_note': _lstm_note(method),
        'method_note': method_note,
        'pit_probability': round(float(pit_prob), 3) if pit_prob is not None else None,
        'pit_method': pit_method,
        'pit_probabilities': {m: round(float(p), 3) for m, p in pits.items()},
        'pit_held_out': _held_out_block('pit'),
        'pit_note': pit_note,
        'optimal_pit_lap': optimal,
        'predicted_stints': stints,
        'pit_projection_reason': pit_projection_reason,
        # No per-driver position change: it compared the driver with himself (L4)
        'driver_predictions': {driver: {}} if driver else {},
        'summary': summary,
        'model_used': method,
        'is_heuristic': method != 'lstm',
        'window': {
            'laps': ctx['window_laps'],
            'ref_lap': ctx['ref_lap'],
            'ref_time': ctx['ref_time'],
            'features': FEATURES,
            'values': np.round(ctx['features'], 4).tolist(),
        },
        'feature_source': feature_source,
        'reason': None,
    }
    if driver:
        result['predicted_laps'] = {driver: predicted}
    return result


def predict_from_rows(lap_rows, driver, session_now=None, lap=None, weather_rows=None,
                      max_lap=None, tsne_context=None, feature_source='cache') -> dict:
    """Forecast of one driver at a clock from session lap rows (build_window)."""
    ctx = build_window(lap_rows, driver, session_now=session_now, weather_rows=weather_rows, lap=lap)
    return forecast_from_context(ctx, max_lap=max_lap, tsne_context=tsne_context,
                                 feature_source=feature_source, session_now=session_now)


def predict_laps(last_10_laps: list, tsne_context: list = None,
                 current_lap: int = None, driver: str = None,
                 max_lap: int = None) -> dict:
    """
    Legacy entry: the lap dicts of the old request (lap_time, tyre_life,
    compound, position, gap_ahead, track_temp, lap_number, ...) read as lap
    rows (features.rows_from_legacy_laps) through the same window builder.
    The dicts carry no track status or pit times: every lap is taken as
    green and on track, so prefer predict_from_rows on the session rows.
    """
    drv = driver or 'UNK'
    rows = rows_from_legacy_laps(last_10_laps, drv, current_lap)
    out = predict_from_rows(rows, drv, max_lap=max_lap, tsne_context=tsne_context, feature_source='legacy_laps')
    if not driver:
        out['driver_predictions'] = {}
        out.pop('predicted_laps', None)
    return out


def _compute_optimal_pit_lap(pit_prob, current_lap, max_lap, tyre_life=None):
    """Projected pit lap from the pit probability: model/pit_timing.py
    optimal_pit_lap, the one mapping shared with api/routers/predictions.py
    (non-increasing in pit_prob, no jump at 0.5). tyre_life is not used: the
    probability already comes from the tyre-life features."""
    return _pit_lap_from_probability(pit_prob, current_lap, max_lap)


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


def _heuristic_prediction(last_10_laps, tsne_context=None,
                          current_lap=None, driver=None, max_lap=None):
    """The heuristic twin of the router's built-in fallback
    (api/routers/predictions.py _builtin_heuristic, used only when this
    module cannot be imported); kept identical to it
    (tests/test_predictions_pit_timing.py). Not on the serving path: the
    served forecast is a held-out ranked method (forecast_from_context)."""
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
        'method': 'heuristic',
        'is_heuristic': True,
    }

    if driver:
        # No position change: a driver's own pace says nothing about his rivals (L4)
        result['driver_predictions'][driver] = {}
        result['predicted_laps'] = {driver: predicted}

    return result
