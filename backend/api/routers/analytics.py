"""
Analytics Router — Sectors, Consistency, Speed Rankings
Provides computed analytics data from session lap times. Consistency uses the
shared degradation definition (data/processors/degradation.py).
"""
from fastapi import APIRouter, HTTPException
from typing import Optional
import asyncio
import logging
import math

from api.params import RoundNumber, Season, SessionType, session_type_code
from data.processors.degradation import clean_stint_laps, compound_degradation, consistency_sigma, fit_stint, median

logger = logging.getLogger(__name__)

# Drivers who completed fewer race laps than this share of the race laps so
# far are flagged insufficient_data (a DNF's sigma comes from a small
# sample). ASSUMPTION kept from the previous version of /consistency, not
# measured. It counts completed laps, not the clean laps of the sigma: SC,
# VSC and wet races leave full-distance drivers with few clean laps, and the
# flag is for DNFs (backend/tests/test_analytics_consistency.py prints both
# counts over the cached races).
MIN_RACE_SHARE = 0.75

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

# Session type of a request that names none (D16): the race, as every
# client sent before the parameter existed
DEFAULT_SESSION_TYPE = "R"


def _session_type(session_type) -> str:
    """The session-type code to load ('R', 'S', 'Q', 'SQ', 'SS', 'FP1'-'FP3'):
    upper-cased, DEFAULT_SESSION_TYPE when empty (api/params.py; ValueError
    for any other value)."""
    return session_type_code(session_type)


def _get_load_session():
    """Lazy import to avoid circular dependency."""
    from api.main import load_session
    return load_session


@router.get("/sectors/{year}/{round_num}")
async def get_sector_rankings(year: Season, round_num: RoundNumber, session_type: SessionType = DEFAULT_SESSION_TYPE):
    """Rank drivers by best sector time for each sector, in the session of
    session_type (D16: the type of the session on screen; default the race)."""
    load_session = _get_load_session()
    data = await asyncio.to_thread(load_session, year, round_num, _session_type(session_type))
    lap_times = data.get("lap_times", [])

    if not lap_times:
        return {"sectors": {"1": [], "2": [], "3": []}, "session_bests": {}}

    # Build per-driver best sector times
    driver_sectors = {}  # {driver: {1: [times], 2: [...], 3: [...]}}
    for lt in lap_times:
        drv = lt.get("Driver")
        if not drv:
            continue
        if drv not in driver_sectors:
            driver_sectors[drv] = {1: [], 2: [], 3: []}

        for s in [1, 2, 3]:
            key = f"Sector{s}TimeSeconds"
            val = lt.get(key)
            if val and isinstance(val, (int, float)) and not math.isnan(val) and val > 0 and val < 300:
                driver_sectors[drv][s].append(val)

    # Find session bests and build rankings
    session_bests = {}
    sectors_result = {}

    for s in [1, 2, 3]:
        all_times = []
        for drv, secs in driver_sectors.items():
            if secs[s]:
                best = min(secs[s])
                all_times.append({"driver": drv, "best": round(best, 3)})

        all_times.sort(key=lambda x: x["best"])
        session_best = all_times[0]["best"] if all_times else None
        session_bests[str(s)] = session_best

        for i, entry in enumerate(all_times):
            entry["rank"] = i + 1
            entry["is_session_best"] = entry["best"] == session_best

        sectors_result[str(s)] = all_times

    return {"sectors": sectors_result, "session_bests": session_bests}


@router.get("/consistency/{year}/{round_num}")
async def get_consistency(year: Season, round_num: RoundNumber, session_now: Optional[float] = None,
                          session_type: SessionType = DEFAULT_SESSION_TYPE):
    """Consistency of each driver: the consistency sigma of
    data/processors/degradation.py (consistencySigma in
    frontend/src/utils/degradation.js), laps completed at session_now
    (session seconds; omitted = the whole session), in the session of
    session_type (D16; default the race)."""
    load_session = _get_load_session()
    data = await asyncio.to_thread(load_session, year, round_num, _session_type(session_type))
    return await asyncio.to_thread(
        consistency_response, data.get("lap_times", []), data.get("driver_info", []), session_now,
    )


def _pooled_sigma(fits):
    """sqrt(sum SSE / sum (n - 2)) over fit_stint results (SSE =
    residual_sigma^2 x (n - 2)): the consistency sigma restricted to these
    stints."""
    sse = 0.0
    dof = 0
    for f in fits:
        sse += f["residual_sigma"] * f["residual_sigma"] * (f["n"] - 2)
        dof += f["n"] - 2
    return math.sqrt(sse / dof) if dof > 0 else None


def consistency_response(lap_times, driver_info_list=None, session_now=None):
    """/consistency payload (pure).

    Per driver with at least one fitted stint (drivers without one are left
    out, as before):
      std_dev     consistency_sigma (pooled residual sigma of the per-stint
                  fits), rounded to the ms; sigma = the same unrounded
      sample_size / lap_count  laps in it (clean laps of the fitted stints)
      outliers    slow outlier laps of the fitted stints left out
      avg_lap / fastest / slowest / range  over those laps
      cv_percent  sigma / avg_lap x 100
      is_consistent  sigma <= median_sigma, the TRUE median of the listed
                  drivers' sigmas (D10: degradation.median, the one median
                  definition; the consistency cards use the same rule)
      insufficient_data  the driver completed fewer race laps than
                  min_laps_threshold (MIN_RACE_SHARE of the race laps so far)
      compounds   per compound of the fitted stints: avg, count,
                  avg_tyre_life, std (pooled residual sigma of those stints),
                  deg_s_per_lap (compound_degradation mean of their fitted
                  slopes, fuel-corrected) and deg_rate (the same in % of the
                  compound's average lap per lap, the previous unit)
    """
    driver_team = {}
    driver_number = {}
    for d in driver_info_list or []:
        abbr = d.get("Abbreviation")
        if abbr:
            driver_team[abbr] = d.get("TeamName", "")
            driver_number[abbr] = d.get("DriverNumber", "")

    if not lap_times:
        return {"drivers": [], "session_avg": None, "race_length": 0}

    # Stints of the laps completed at session_now (end_lap = last completed lap)
    by_driver = {}
    for st in clean_stint_laps(lap_times, session_now=session_now):
        by_driver.setdefault(st["driver"], []).append(st)
    laps_completed = {drv: max(st["end_lap"] for st in sts) for drv, sts in by_driver.items()}
    race_length = int(max(laps_completed.values())) if laps_completed else 0
    min_laps_threshold = max(3, int(race_length * MIN_RACE_SHARE)) if race_length else 3

    results = []
    all_valid_times = []
    for drv, stints in by_driver.items():
        cs = consistency_sigma(lap_times, drv, session_now=session_now)
        sigma = cs["sigma"]
        if sigma is None:
            continue
        fitted = []
        for st in stints:
            fit = fit_stint(st["laps"])
            if fit is not None:
                fitted.append((st, fit))
        valid = [lap for st, _ in fitted for lap in st["laps"]]
        valid_times = [lap["LapTimeSeconds"] for lap in valid]
        avg = sum(valid_times) / len(valid_times)
        fastest = min(valid_times)
        slowest = max(valid_times)
        all_valid_times.extend(valid_times)

        slopes = compound_degradation([{"compound": st["compound"], "slope": fit["slope"]} for st, fit in fitted])
        compounds = {}
        for c in dict.fromkeys(st["compound"] for st, _ in fitted):
            c_fits = [(st, fit) for st, fit in fitted if st["compound"] == c]
            c_laps = [lap for st, _ in c_fits for lap in st["laps"]]
            ctimes = [lap["LapTimeSeconds"] for lap in c_laps]
            c_avg = sum(ctimes) / len(ctimes)
            c_std = _pooled_sigma([fit for _, fit in c_fits])
            deg = slopes[c]["mean"]
            compounds[c] = {
                "avg": round(c_avg, 3),
                "std": round(c_std, 3) if c_std is not None else None,
                "deg_rate": round(deg * 100 / c_avg, 2),
                "deg_s_per_lap": round(deg, 4),
                "count": len(ctimes),
                "fits": len(c_fits),
                # to 0.1 lap, half up as the cards' Math.round(x * 10) / 10 (round()
                # is half-even on the binary value: 12.95 gave 12.9 here, 13 there)
                "avg_tyre_life": math.floor(sum(lap["TyreLife"] for lap in c_laps) / len(c_laps) * 10 + 0.5) / 10,
            }

        results.append({
            "driver": drv,
            "team": driver_team.get(drv, ""),
            "number": driver_number.get(drv, ""),
            "avg_lap": round(avg, 3),
            "fastest": round(fastest, 3),
            "slowest": round(slowest, 3),
            "range": round(slowest - fastest, 3),
            "std_dev": round(sigma, 3),
            "sigma": sigma,
            "cv_percent": round(sigma / avg * 100, 2),
            "sample_size": cs["n"],
            "lap_count": cs["n"],
            "laps_completed": int(laps_completed[drv]),
            "stints_fitted": cs["stints"],
            "insufficient_data": laps_completed[drv] < min_laps_threshold,
            "outliers": cs["outliers"],
            "compounds": compounds,
        })

    median_sigma = median([r["sigma"] for r in results])
    for r in results:
        r["is_consistent"] = r["sigma"] <= median_sigma

    results.sort(key=lambda x: x["avg_lap"])

    session_avg = round(sum(all_valid_times) / len(all_valid_times), 3) if all_valid_times else None

    return {
        "drivers": results,
        "session_avg": session_avg,
        "race_length": race_length,
        "min_laps_threshold": min_laps_threshold,
        "median_sigma": median_sigma,
        "session_now": session_now,
    }


@router.get("/speed-rankings/{year}/{round_num}")
async def get_speed_rankings(year: Season, round_num: RoundNumber, session_type: SessionType = DEFAULT_SESSION_TYPE):
    """Rank drivers by speed trap, finish line, and sector speeds, in the
    session of session_type (D16; default the race)."""
    load_session = _get_load_session()
    data = await asyncio.to_thread(load_session, year, round_num, _session_type(session_type))
    lap_times = data.get("lap_times", [])

    speed_cols = {
        "speed_trap": "SpeedST",
        "finish_line": "SpeedFL",
        "sector1": "SpeedI1",
        "sector2": "SpeedI2",
    }

    rankings = {}
    for label, col in speed_cols.items():
        driver_speeds = {}
        for lt in lap_times:
            drv = lt.get("Driver")
            val = lt.get(col)
            if not drv or not val or not isinstance(val, (int, float)):
                continue
            if math.isnan(val) or val <= 0:
                continue
            if drv not in driver_speeds or val > driver_speeds[drv]:
                driver_speeds[drv] = val

        ranked = sorted(driver_speeds.items(), key=lambda x: -x[1])
        rankings[label] = [
            {"driver": drv, "speed": round(spd, 1), "rank": i + 1}
            for i, (drv, spd) in enumerate(ranked)
        ]

    return {"speed_rankings": rankings}
