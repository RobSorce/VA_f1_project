"""
Analytics Router — Sectors, Consistency, Speed Rankings
Provides computed analytics data from session lap times.
"""
from fastapi import APIRouter, HTTPException
import asyncio
import logging
import math

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _get_load_session():
    """Lazy import to avoid circular dependency."""
    from api.main import load_session
    return load_session


@router.get("/sectors/{year}/{round_num}")
async def get_sector_rankings(year: int, round_num: int):
    """Rank drivers by best sector time for each sector."""
    load_session = _get_load_session()
    data = await asyncio.to_thread(load_session, year, round_num, "R")
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
async def get_consistency(year: int, round_num: int):
    """Compute consistency metrics for each driver."""
    load_session = _get_load_session()
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    lap_times = data.get("lap_times", [])
    driver_info_list = data.get("driver_info", [])

    # Build driver→team map
    driver_team = {}
    driver_number = {}
    for d in driver_info_list:
        abbr = d.get("Abbreviation")
        if abbr:
            driver_team[abbr] = d.get("TeamName", "")
            driver_number[abbr] = d.get("DriverNumber", "")

    if not lap_times:
        return {"drivers": [], "session_avg": None}

    # Group laps by driver
    driver_laps = {}
    for lt in lap_times:
        drv = lt.get("Driver")
        t = lt.get("LapTimeSeconds")
        compound = lt.get("Compound", "UNKNOWN")
        tyre_life = lt.get("TyreLife", 0)
        pit_out = lt.get("PitOutTimeSeconds")
        pit_in = lt.get("PitInTimeSeconds")

        if not drv or not t or not isinstance(t, (int, float)) or math.isnan(t) or t <= 0:
            continue
        # Skip pit in/out laps
        if pit_out or pit_in:
            continue

        if drv not in driver_laps:
            driver_laps[drv] = []
        driver_laps[drv].append({"time": t, "compound": compound, "tyre_life": tyre_life})

    results = []
    all_valid_times = []

    for drv, laps in driver_laps.items():
        times = [l["time"] for l in laps]
        if len(times) < 3:
            continue

        # Remove outliers (> 1.5x median)
        median = sorted(times)[len(times) // 2]
        threshold = median * 1.5
        valid = [l for l in laps if l["time"] <= threshold]
        outliers = len(laps) - len(valid)
        valid_times = [l["time"] for l in valid]

        if len(valid_times) < 2:
            continue

        avg = sum(valid_times) / len(valid_times)
        fastest = min(valid_times)
        slowest = max(valid_times)
        lap_range = slowest - fastest
        variance = sum((t - avg) ** 2 for t in valid_times) / len(valid_times)
        std_dev = variance ** 0.5
        cv_percent = (std_dev / avg) * 100 if avg > 0 else 0

        all_valid_times.extend(valid_times)

        # Per-compound breakdown
        compound_map = {}
        for l in valid:
            c = l["compound"]
            if c not in compound_map:
                compound_map[c] = {"times": [], "tyre_lives": []}
            compound_map[c]["times"].append(l["time"])
            compound_map[c]["tyre_lives"].append(l["tyre_life"] or 0)

        compounds = {}
        for c, cdata in compound_map.items():
            ctimes = cdata["times"]
            c_avg = sum(ctimes) / len(ctimes)
            c_std = (sum((t - c_avg) ** 2 for t in ctimes) / len(ctimes)) ** 0.5
            avg_tyre_life = sum(cdata["tyre_lives"]) / len(cdata["tyre_lives"])
            # Degradation: slope of lap time vs tyre life (simple linear regression)
            deg_rate = 0
            if len(ctimes) > 2:
                tl = cdata["tyre_lives"]
                n = len(ctimes)
                mean_tl = sum(tl) / n
                mean_t = c_avg
                num = sum((tl[i] - mean_tl) * (ctimes[i] - mean_t) for i in range(n))
                den = sum((tl[i] - mean_tl) ** 2 for i in range(n))
                if den > 0:
                    deg_rate = round((num / den) * 100 / c_avg, 2)  # % per lap

            compounds[c] = {
                "avg": round(c_avg, 3),
                "std": round(c_std, 3),
                "deg_rate": deg_rate,
                "count": len(ctimes),
                "avg_tyre_life": round(avg_tyre_life, 1),
            }

        results.append({
            "driver": drv,
            "team": driver_team.get(drv, ""),
            "number": driver_number.get(drv, ""),
            "avg_lap": round(avg, 3),
            "fastest": round(fastest, 3),
            "slowest": round(slowest, 3),
            "range": round(lap_range, 3),
            "std_dev": round(std_dev, 3),
            "cv_percent": round(cv_percent, 2),
            "sample_size": len(valid_times),
            "outliers": outliers,
            "compounds": compounds,
        })

    # Use median CV as the consistency threshold (relative to the field)
    all_cvs = sorted([r["cv_percent"] for r in results])
    median_cv = all_cvs[len(all_cvs) // 2] if all_cvs else 1
    for r in results:
        r["is_consistent"] = r["cv_percent"] <= median_cv

    results.sort(key=lambda x: x["avg_lap"])

    session_avg = round(sum(all_valid_times) / len(all_valid_times), 3) if all_valid_times else None

    return {"drivers": results, "session_avg": session_avg}


@router.get("/speed-rankings/{year}/{round_num}")
async def get_speed_rankings(year: int, round_num: int):
    """Rank drivers by speed trap, finish line, and sector speeds."""
    load_session = _get_load_session()
    data = await asyncio.to_thread(load_session, year, round_num, "R")
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
