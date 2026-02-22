"""
Prediction API Routes
LSTM inference and degradation regression endpoints.

Endpoints:
  POST /api/predict/lstm         - Predict next 5 lap times using LSTM or heuristic fallback
  POST /api/predict/degradation  - Linear regression on selected lap range, projected pit lap
"""
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import numpy as np
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# Graceful import: model.predict depends on PyTorch which may not be installed.
# If the import fails we fall back to a local heuristic so the router still loads.
try:
    from model.predict import predict_laps as _predict_laps
    PREDICT_AVAILABLE = True
except Exception as e:
    logger.warning(f"model.predict not available ({e}). LSTM endpoint will use built-in heuristic.")
    PREDICT_AVAILABLE = False


def _builtin_heuristic(last_10_laps: list, tsne_context: list = None,
                       current_lap: int = None, driver: str = None,
                       max_lap: int = None) -> dict:
    """Fallback lap-time prediction when the model module cannot be loaded."""
    import math

    times = [l.get("lap_time", 90.0) for l in last_10_laps if l.get("lap_time", 0) > 0]
    if not times:
        times = [90.0]

    avg_time = float(np.mean(times[-5:]))
    tyre_life = last_10_laps[-1].get("tyre_life", 10) if last_10_laps else 10
    deg_rate = 0.03  # assumed ~0.03 s/lap degradation

    predicted = [round(avg_time + deg_rate * (i + 1), 3) for i in range(5)]
    pit_prob = min(1.0, max(0.0, (tyre_life - 15) * 0.05)) if tyre_life > 15 else 0.05

    c_lap = current_lap or 30
    m_lap = max_lap or 60
    current_compound = last_10_laps[-1].get("compound", "MEDIUM") if last_10_laps else "MEDIUM"

    # Optimal pit lap
    if pit_prob > 0.5:
        laps_until_pit = max(1, math.ceil(-math.log(1 - min(pit_prob, 0.99)) * 5))
    else:
        laps_until_pit = max(1, 25 - tyre_life)
    optimal_pit_lap = min(c_lap + laps_until_pit, m_lap - 2)

    # Predicted stints
    compound_order = {"SOFT": "HARD", "MEDIUM": "HARD", "HARD": "MEDIUM",
                      "INTERMEDIATE": "INTERMEDIATE", "WET": "WET"}
    next_compound = compound_order.get(current_compound, "MEDIUM")
    predicted_stints = [
        {"driver": driver or "UNK", "compound": current_compound,
         "lap_start": c_lap, "length": optimal_pit_lap - c_lap},
    ]
    remaining = m_lap - optimal_pit_lap
    if remaining > 0:
        predicted_stints.append(
            {"driver": driver or "UNK", "compound": next_compound,
             "lap_start": optimal_pit_lap, "length": remaining}
        )

    summary = f"Heuristic: avg {avg_time:.1f}s + {deg_rate}s/lap degradation."
    if tsne_context:
        summary += f" Context: {len(tsne_context)} similar races."

    result = {
        "predicted_times": predicted,
        "pit_probability": round(pit_prob, 3),
        "optimal_pit_lap": optimal_pit_lap,
        "predicted_stints": predicted_stints,
        "driver_predictions": {},
        "summary": summary,
    }

    if driver:
        result["driver_predictions"][driver] = {"predicted_position_change": 0}
        result["predicted_laps"] = {driver: predicted}
        result["positions"] = {driver: 0}

    return result


router = APIRouter(prefix="/api/predict", tags=["predictions"])


# -- Request models --------------------------------------------------------

class LSTMRequest(BaseModel):
    last_10_laps: List[Dict[str, Any]]
    driver: Optional[str] = None
    year: Optional[int] = None
    round: Optional[int] = None
    current_lap: Optional[int] = None
    max_lap: Optional[int] = None
    tsne_context: Optional[List[str]] = None


class DegradationRequest(BaseModel):
    year: int
    round: int
    drivers: List[str]
    lap_start: int
    lap_end: int


# -- Endpoints -------------------------------------------------------------

@router.post("/lstm")
async def predict_lstm(request: LSTMRequest):
    """
    LSTM inference with optional t-SNE context.

    Accepts the last 10 laps of feature dicts and returns predicted next 5
    lap times plus pit-stop probability, optimal pit lap, predicted stints,
    and driver predictions. Falls back to a heuristic if PyTorch / trained
    model is not available.
    """
    if PREDICT_AVAILABLE:
        try:
            result = _predict_laps(
                request.last_10_laps,
                request.tsne_context,
                current_lap=request.current_lap,
                driver=request.driver,
                max_lap=request.max_lap,
            )
        except Exception as e:
            logger.warning(f"predict_laps failed, using heuristic: {e}")
            result = _builtin_heuristic(
                request.last_10_laps, request.tsne_context,
                current_lap=request.current_lap, driver=request.driver,
                max_lap=request.max_lap,
            )
    else:
        result = _builtin_heuristic(
            request.last_10_laps, request.tsne_context,
            current_lap=request.current_lap, driver=request.driver,
            max_lap=request.max_lap,
        )

    return result


@router.post("/degradation")
async def predict_degradation(request: DegradationRequest):
    """
    Linear regression on a brushed lap range.

    For each requested driver, fits ``lap_time = slope * lap + intercept``
    over the selected lap window and returns:
      - slope (degradation per lap in seconds)
      - intercept
      - optimal_pit_lap (projected lap where degradation exceeds 1.5 s)
      - undercut_window [start, end]
    """
    try:
        from data.extractors.fastf1_extractor import FastF1Extractor

        ext = FastF1Extractor()
        session = ext.get_session(request.year, request.round, "R")
        lap_times = ext.extract_lap_times(session)

        if "LapTimeSeconds" not in lap_times.columns and "LapTime" in lap_times.columns:
            lap_times["LapTimeSeconds"] = lap_times["LapTime"].dt.total_seconds()

        results = []
        for driver in request.drivers:
            driver_laps = lap_times[
                (lap_times["Driver"] == driver)
                & (lap_times["LapNumber"] >= request.lap_start)
                & (lap_times["LapNumber"] <= request.lap_end)
                & (lap_times["LapTimeSeconds"] > 0)
                & (lap_times["LapTimeSeconds"] < 200)
            ].sort_values("LapNumber")

            if len(driver_laps) < 3:
                continue

            x = driver_laps["LapNumber"].values.astype(float)
            y = driver_laps["LapTimeSeconds"].values.astype(float)

            # Linear regression
            slope, intercept = np.polyfit(x, y, 1)

            # Projected optimal pit lap (when deg exceeds threshold)
            threshold = 1.5  # seconds slower than stint start
            if slope > 0:
                optimal_pit_lap = int((threshold / slope) + x[0])
            else:
                optimal_pit_lap = request.lap_end

            results.append({
                "driver": driver,
                "slope": round(float(slope), 4),
                "intercept": round(float(intercept), 2),
                "lap_start": request.lap_start,
                "lap_end": request.lap_end,
                "optimal_pit_lap": optimal_pit_lap,
                "degradation_per_lap": round(float(slope), 4),
            })

        if results:
            primary = results[0]
            primary["all_drivers"] = results
            primary["undercut_window"] = [
                max(1, primary["optimal_pit_lap"] - 3),
                primary["optimal_pit_lap"] + 2,
            ]
            return primary
        else:
            return {"error": "Insufficient data for regression"}

    except Exception as e:
        logger.error(f"Degradation prediction failed: {e}", exc_info=True)
        return {"error": str(e)}
