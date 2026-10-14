"""
Prediction API Routes
LSTM inference and degradation regression endpoints.

Endpoints:
  POST /api/predict/lstm         - Predict next 5 lap times using LSTM or heuristic fallback
  POST /api/predict/degradation  - Per-stint degradation fits on a brushed lap range
                                   (data/processors/degradation.py), projected pit lap
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import asyncio
import math
import numpy as np
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# Pure modules (no torch): always importable
from model.pit_timing import optimal_pit_lap as _pit_lap_from_probability
from data.processors.degradation import FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS, stint_fits

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

    # Optimal pit lap: the one mapping of model/pit_timing.py (shared with model/predict.py)
    optimal_pit_lap = _pit_lap_from_probability(pit_prob, c_lap, m_lap)

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
        "model_used": "heuristic",
        "is_heuristic": True,
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
    # Session seconds (frontend getSessionNow): only laps completed by then
    # are used, as stintFits at that clock. None = the whole race.
    session_now: Optional[float] = None


# -- Degradation constants ---------------------------------------------------

# Fitted tyre-only loss, seconds, since the stint's first lap at which the
# projected pit lap is placed. ASSUMPTION kept from the previous version of
# this endpoint (its "1.5 s slower than stint start"), not measured.
PIT_DEG_THRESHOLD_S = 1.5

# Undercut window around the projected pit lap, laps before / after.
# ASSUMPTION kept from the previous version of this endpoint, not measured.
UNDERCUT_WINDOW_LAPS_BEFORE = 3
UNDERCUT_WINDOW_LAPS_AFTER = 2


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
    Tyre degradation on a brushed lap range, per stint, with the shared
    definition of data/processors/degradation.py (the same as
    frontend/src/utils/degradation.js; docs/DEGRADATION_METHODOLOGY.md).

    For each requested driver: stint_fits over the clean laps of each stint
    inside [lap_start, lap_end] (green, not lap 1, no in-lap or out-lap, no
    slow outlier), ordinary least squares of the fuel-corrected lap time on
    TyreLife, completed laps at session_now only. The lap rows come from the
    app session cache (api/main.py load_session: memory, then disk, then
    FastF1 under its lock), off the event loop.

    Response (degradation_response): the primary fit (the latest fitted stint
    of the first requested driver that has one) at the top level, every
    driver in all_drivers, every stint row in stints. A slope <= 0 gives no
    optimal_pit_lap (None + optimal_pit_lap_reason). No fitted stint at all
    gives a 200 with the fit fields None and a reason.
    """
    try:
        return await asyncio.to_thread(_degradation_for_request, request)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Degradation prediction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _get_load_session():
    """Lazy import of the app session loader (api.main imports this router)."""
    from api.main import load_session
    return load_session


def _degradation_for_request(request: DegradationRequest) -> Dict[str, Any]:
    """Blocking part of /degradation (runs in a worker thread): cached lap rows
    of the race, then degradation_response."""
    data = _get_load_session()(request.year, request.round, "R")
    return degradation_response(
        data.get("lap_times") or [], request.drivers, request.lap_start, request.lap_end,
        session_now=request.session_now,
    )


def _race_last_lap(lap_rows) -> Optional[int]:
    """Highest LapNumber of the session payload (the race distance)."""
    last = None
    for lap in lap_rows:
        n = lap.get("LapNumber") if isinstance(lap, dict) else None
        if isinstance(n, (int, float)) and math.isfinite(n):
            last = int(n) if last is None else max(last, int(n))
    return last


def projected_pit_lap(fit: Dict[str, Any], race_last_lap: Optional[int] = None):
    """(optimal_pit_lap, reason) of one stint_fits row.

    The lap at which the fitted tyre-only loss since the stint's first lap
    reaches PIT_DEG_THRESHOLD_S: ceil(start_lap + PIT_DEG_THRESHOLD_S / slope).
    One lap of TyreLife is one race lap inside a stint (LapNumber - TyreLife
    is constant over the clean laps of every cached stint, see
    docs/DEGRADATION_METHODOLOGY.md), so the fitted slope per lap of tyre life
    is also per race lap. None with a reason when the stint has no fit, when
    the slope is <= 0 (the fit shows no loss to pit for) or when the lap falls
    after the race's last lap.
    """
    slope = fit.get("slope")
    if slope is None:
        return None, (
            f"Fewer than {MIN_FIT_LAPS} clean laps of this stint in the range: no fit, no pit lap projected."
        )
    if not slope > 0:
        return None, (
            f"Fitted degradation {slope:+.4f} s/lap (fuel-corrected) is not positive: "
            "no tyre loss to pit for, no pit lap projected."
        )
    lap = math.ceil(fit["start_lap"] + PIT_DEG_THRESHOLD_S / slope)
    if race_last_lap is not None and lap > race_last_lap:
        return None, (
            f"At {slope:+.4f} s/lap the fitted loss reaches {PIT_DEG_THRESHOLD_S} s only on lap {lap}, "
            f"after the last lap ({race_last_lap}): no pit lap projected."
        )
    return lap, None


def _driver_entry(driver, primary, stints, lap_start, lap_end, race_last_lap):
    """Response fields of one driver: its primary stint fit at the top level,
    every stint row in stints. Key names kept from the previous endpoint:
    slope = raw slope (LapTimeSeconds per lap, fuel burn included; the
    TireDegradation banner labels it raw), slope_fuel_corrected =
    degradation_per_lap = the fit's slope (tyre only)."""
    opt, why = projected_pit_lap(primary, race_last_lap)
    return {
        "driver": driver,
        "stint_number": primary["stint_number"],
        "compound": primary["compound"],
        "stint_start_lap": primary["start_lap"],
        "stint_end_lap": primary["end_lap"],
        "slope": primary["raw_slope"],
        "raw_slope": primary["raw_slope"],
        "slope_fuel_corrected": primary["slope"],
        "degradation_per_lap": primary["slope"],
        "fuel_correction_per_lap": FUEL_EFFECT_S_PER_LAP,
        "intercept": primary["intercept"],
        "n": primary["n"],
        "residual_sigma": primary["residual_sigma"],
        "slope_std_err": primary["slope_std_err"],
        "lap_start": lap_start,
        "lap_end": lap_end,
        "optimal_pit_lap": opt,
        "optimal_pit_lap_reason": why,
        "pit_threshold_s": PIT_DEG_THRESHOLD_S,
        "stints": stints,
    }


def degradation_response(lap_rows, drivers, lap_start, lap_end, session_now=None) -> Dict[str, Any]:
    """/degradation payload from the lap rows of a race (pure).

    stints rows = stint_fits(lap_rows, session_now, driver, lap_start,
    lap_end) unchanged (slope fuel-corrected, raw_slope, intercept, n,
    residual_sigma, slope_std_err, tyre_life_min / max, stint_number,
    compound, start_lap, end_lap), plus optimal_pit_lap and
    optimal_pit_lap_reason (projected_pit_lap). A driver's primary stint is
    its latest stint with a fit in the range; drivers without one are only in
    lap_count_per_driver (clean laps in the range).
    """
    last_lap = _race_last_lap(lap_rows)
    results = []
    clean_laps = {}
    for driver in drivers:
        fits = stint_fits(lap_rows, session_now=session_now, driver=driver,
                          lap_start=lap_start, lap_end=lap_end)
        clean_laps[driver] = sum(f["n"] for f in fits)
        stints = []
        for f in fits:
            opt, why = projected_pit_lap(f, last_lap)
            stints.append({**f, "optimal_pit_lap": opt, "optimal_pit_lap_reason": why})
        fitted = [s for s in stints if s["slope"] is not None]
        if fitted:
            results.append(_driver_entry(driver, fitted[-1], stints, lap_start, lap_end, last_lap))

    if results:
        # No circular reference: all_drivers holds copies, never the top-level dict itself
        primary = results[0]
        optimal = primary["optimal_pit_lap"]
        return {
            **primary,
            "undercut_window": (
                [max(1, optimal - UNDERCUT_WINDOW_LAPS_BEFORE), optimal + UNDERCUT_WINDOW_LAPS_AFTER]
                if optimal is not None else None
            ),
            "all_drivers": [dict(r) for r in results],
            "lap_count_per_driver": clean_laps,
            "session_now": session_now,
            "reason": None,
        }

    # No driver has a fitted stint in the brushed window. A clean 200 with an
    # empty payload and a reason, not a 4xx: clients call this on every brush
    # change and "no fit here" is a normal answer.
    logger.info(
        "Degradation: no fit possible - drivers=%s lap_start=%s lap_end=%s clean_laps=%s",
        drivers, lap_start, lap_end, clean_laps,
    )
    return {
        "driver": None,
        "stint_number": None,
        "compound": None,
        "stint_start_lap": None,
        "stint_end_lap": None,
        "slope": None,
        "raw_slope": None,
        "slope_fuel_corrected": None,
        "degradation_per_lap": None,
        "fuel_correction_per_lap": FUEL_EFFECT_S_PER_LAP,
        "intercept": None,
        "n": None,
        "residual_sigma": None,
        "slope_std_err": None,
        "lap_start": lap_start,
        "lap_end": lap_end,
        "optimal_pit_lap": None,
        "optimal_pit_lap_reason": None,
        "pit_threshold_s": PIT_DEG_THRESHOLD_S,
        "stints": [],
        "undercut_window": None,
        "all_drivers": [],
        "lap_count_per_driver": clean_laps,
        "session_now": session_now,
        "reason": (
            "No driver has a stint with at least {} clean laps in [{}, {}] (clean = green, not lap 1, "
            "no pit in-lap or out-lap, no slow outlier). Brush a wider window or pick a driver with "
            "race laps in it.".format(MIN_FIT_LAPS, lap_start, lap_end)
        ),
    }
