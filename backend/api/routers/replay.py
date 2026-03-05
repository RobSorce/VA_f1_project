"""
Replay endpoints:
  - REST GET  /api/session/{year}/{round_num}/{session_type}/replay
  - WebSocket /ws/replay/{year}/{round_num}

The replay endpoint returns structured lap-by-lap data for every driver,
including position, lap time, sectors, tyre compound/life, pit status,
gap to leader, and interval to car ahead.  It also returns race events
(safety car, VSC, red flags, etc.).
"""
import asyncio
import json
import math
import logging
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logger = logging.getLogger(__name__)
router = APIRouter()

# -- Status code -> event type mapping ------------------------------------
STATUS_TYPE_MAP = {
    "1": "GREEN_FLAG",
    "2": "YELLOW_FLAG",
    "4": "SAFETY_CAR",
    "5": "RED_FLAG",
    "6": "VSC",
    "7": "VSC",
}


def _get_shared_state(app):
    """Retrieve shared FastF1 resources from main app state."""
    return app.state.extractor, app.state.fastf1_lock, app.state.raw_session_cache


def _get_raw_session(extractor, lock, cache, year, round_num, session_type):
    """Get or load a raw FastF1 session, using the shared lock and cache."""
    cache_key = f"{year}_{round_num}_{session_type}"
    if cache_key in cache:
        return cache[cache_key]
    with lock:
        # Double-check after acquiring lock
        if cache_key in cache:
            return cache[cache_key]
        session = extractor.get_session(year, round_num, session_type)
        cache[cache_key] = session
        return session


def _safe_float(value, default=None):
    """Return a JSON-safe float or *default* for NaN / None / timedelta."""
    if value is None:
        return default
    if hasattr(value, "total_seconds"):
        value = value.total_seconds()
    try:
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return default
        return round(f, 3)
    except (TypeError, ValueError):
        return default


def _safe_int(value, default=None):
    """Return a JSON-safe int or *default*."""
    if value is None:
        return default
    try:
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return default
        return int(f)
    except (TypeError, ValueError):
        return default


def _build_laps_array(session) -> list:
    """
    Build the ``laps`` array for the replay response.

    Each entry corresponds to a single lap number and contains a ``drivers``
    list with one record per driver who completed that lap:

        {
            "lap": 5,
            "drivers": [
                {
                    "abbreviation": "VER",
                    "position": 1,
                    "lapTime": 93.456,
                    "sector1": 28.1,
                    "sector2": 34.5,
                    "sector3": 30.856,
                    "compound": "SOFT",
                    "tyreLife": 5,
                    "pitStatus": "ON_TRACK",
                    "gap": 0,
                    "interval": 0
                },
                ...
            ]
        }
    """
    all_laps = session.laps
    if all_laps is None or all_laps.empty:
        return []

    # Ensure LapTimeSeconds is available
    df = all_laps.copy()
    time_cols = ["LapTime", "Sector1Time", "Sector2Time", "Sector3Time"]
    for col in time_cols:
        sec_col = f"{col}Seconds"
        if col in df.columns and sec_col not in df.columns:
            df[sec_col] = df[col].apply(
                lambda v: v.total_seconds() if hasattr(v, "total_seconds") else None
            )

    total_laps = int(df["LapNumber"].max())

    # Cumulative race time per driver for gap / interval computation
    df = df.sort_values(["Driver", "LapNumber"])
    df["CumTime"] = df.groupby("Driver")["LapTimeSeconds"].cumsum()

    # Build a lookup: {(driver, lap_number): row_dict}
    lap_lookup = {}
    for _, row in df.iterrows():
        driver = row.get("Driver")
        lap_num = _safe_int(row.get("LapNumber"))
        if driver is not None and lap_num is not None:
            lap_lookup[(driver, lap_num)] = row

    # Build per-lap output
    result = []
    for lap_num in range(1, total_laps + 1):
        # Collect all drivers who have data for this lap
        lap_drivers_raw = df[df["LapNumber"] == lap_num].copy()
        if lap_drivers_raw.empty:
            continue

        # Determine position from the 'Position' column if available, else
        # from cumulative time ranking
        if "Position" in lap_drivers_raw.columns:
            lap_drivers_raw["_pos"] = lap_drivers_raw["Position"].apply(
                lambda v: _safe_int(v, 99)
            )
        else:
            # Rank by cumulative time (lower = better)
            lap_drivers_raw["_pos"] = (
                lap_drivers_raw["CumTime"]
                .rank(method="min", na_option="bottom")
                .astype(int)
            )

        lap_drivers_raw = lap_drivers_raw.sort_values("_pos")

        # Leader cumulative time for gap calculation
        leader_cum = lap_drivers_raw["CumTime"].min()

        # Previous driver cumulative time for interval calculation
        prev_cum = None

        drivers_list = []
        for _, row in lap_drivers_raw.iterrows():
            driver_abbr = str(row.get("Driver", "???"))
            position = _safe_int(row.get("_pos"), 0)
            lap_time = _safe_float(row.get("LapTimeSeconds"))
            sector1 = _safe_float(row.get("Sector1TimeSeconds"))
            sector2 = _safe_float(row.get("Sector2TimeSeconds"))
            sector3 = _safe_float(row.get("Sector3TimeSeconds"))
            compound = str(row.get("Compound", "UNKNOWN"))
            if compound == "nan" or compound == "None":
                compound = "UNKNOWN"
            tyre_life = _safe_int(row.get("TyreLife"), 0)

            # Pit status
            pit_in = row.get("PitInTime")
            pit_out = row.get("PitOutTime")
            has_pit_in = pit_in is not None and not (
                hasattr(pit_in, "total_seconds") and pd.isna(pit_in)
            ) and pd.notna(pit_in)
            has_pit_out = pit_out is not None and not (
                hasattr(pit_out, "total_seconds") and pd.isna(pit_out)
            ) and pd.notna(pit_out)

            if has_pit_in and has_pit_out:
                pit_status = "PIT_STOP"
            elif has_pit_in:
                pit_status = "PIT_IN"
            elif has_pit_out:
                pit_status = "PIT_OUT"
            else:
                pit_status = "ON_TRACK"

            # Gap to leader
            cum_time = _safe_float(row.get("CumTime"))
            if cum_time is not None and leader_cum is not None and not pd.isna(leader_cum):
                gap = round(cum_time - float(leader_cum), 3)
            else:
                gap = 0

            # Interval to car ahead
            if prev_cum is not None and cum_time is not None:
                interval = round(cum_time - prev_cum, 3)
            else:
                interval = 0

            prev_cum = cum_time if cum_time is not None else prev_cum

            drivers_list.append({
                "abbreviation": driver_abbr,
                "position": position,
                "lapTime": lap_time,
                "sector1": sector1,
                "sector2": sector2,
                "sector3": sector3,
                "compound": compound,
                "tyreLife": tyre_life,
                "pitStatus": pit_status,
                "gap": gap,
                "interval": interval,
            })

        result.append({
            "lap": lap_num,
            "drivers": drivers_list,
        })

    return result


def _build_events(extractor, session, total_laps: int, avg_lap_time: float) -> list:
    """Build the events list from track status data."""
    track_status = extractor.extract_track_status(session)
    events = []

    # Race start
    events.append({
        "type": "GREEN_FLAG",
        "lap": 1,
        "description": "Race start",
    })

    for period in track_status:
        status_code = str(period.get("status", "1"))
        if status_code == "1":
            continue

        event_type = STATUS_TYPE_MAP.get(status_code)
        if not event_type:
            continue

        start_time = period.get("start_time", 0)
        end_time = period.get("end_time")

        start_lap = (
            max(1, min(total_laps, round(start_time / avg_lap_time)))
            if avg_lap_time > 0
            else 1
        )
        end_lap = start_lap
        if end_time is not None and avg_lap_time > 0:
            end_lap = max(start_lap, min(total_laps, round(end_time / avg_lap_time)))

        message = period.get("message", event_type.replace("_", " ").title())
        event = {"type": event_type, "description": message}

        if start_lap == end_lap:
            event["lap"] = start_lap
        else:
            event["startLap"] = start_lap
            event["endLap"] = end_lap

        events.append(event)

    # Chequered flag
    if total_laps > 0:
        events.append({
            "type": "CHEQUERED_FLAG",
            "lap": total_laps,
            "description": "Race finish",
        })

    return events


# =========================================================================
# REST endpoint
# =========================================================================

@router.get("/api/session/{year}/{round_num}/{session_type}/replay")
async def get_replay_data(request: Request, year: int, round_num: int, session_type: str = "R"):
    """
    Return structured replay data for a session.

    Response shape::

        {
            "totalLaps": 57,
            "laps": [
                {
                    "lap": 1,
                    "drivers": [
                        {
                            "abbreviation": "VER",
                            "position": 1,
                            "lapTime": 93.456,
                            "sector1": 28.1,
                            "sector2": 34.5,
                            "sector3": 30.856,
                            "compound": "SOFT",
                            "tyreLife": 1,
                            "pitStatus": "ON_TRACK",
                            "gap": 0,
                            "interval": 0
                        }
                    ]
                }
            ],
            "events": [
                {"type": "SAFETY_CAR", "startLap": 15, "endLap": 18, "description": "Safety Car"}
            ]
        }
    """
    ext, lock, cache = _get_shared_state(request.app)

    def _blocking_replay():
        session = _get_raw_session(ext, lock, cache, year, round_num, session_type)

        all_laps = session.laps
        total_laps = (
            int(all_laps["LapNumber"].max())
            if all_laps is not None and not all_laps.empty
            else 0
        )

        # Average lap time for timestamp -> lap estimation in events
        avg_lap_time = 90.0
        if total_laps > 0:
            lt = all_laps["LapTime"].dropna()
            if not lt.empty:
                avg_seconds = lt.apply(
                    lambda td: td.total_seconds() if hasattr(td, "total_seconds") else 0
                )
                valid = avg_seconds[avg_seconds > 0]
                if not valid.empty:
                    avg_lap_time = float(valid.mean())

        # Build structured data
        laps_array = _build_laps_array(session)
        events = _build_events(ext, session, total_laps, avg_lap_time)

        return {
            "totalLaps": total_laps,
            "laps": laps_array,
            "events": events,
        }

    try:
        return await asyncio.to_thread(_blocking_replay)
    except Exception as e:
        logger.error(f"Failed to load session for replay: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =========================================================================
# WebSocket endpoint
# =========================================================================

@router.websocket("/ws/replay/{year}/{round_num}")
async def replay_session(websocket: WebSocket, year: int, round_num: int):
    """
    Stream race frames lap-by-lap over WebSocket.

    Client can send JSON control messages:
      { "action": "play" }
      { "action": "pause" }
      { "action": "set_speed", "speed": 2.0 }
      { "action": "seek", "lap": 15 }
    """
    await websocket.accept()

    ext, lock, cache = _get_shared_state(websocket.app)

    # Load session + frames in a thread to avoid blocking the event loop
    try:
        def _load_frames():
            session = _get_raw_session(ext, lock, cache, year, round_num, "R")
            return ext.extract_race_frames(session)

        frames_data = await asyncio.to_thread(_load_frames)
    except Exception as e:
        await websocket.send_json({"error": f"Failed to load session: {e}"})
        await websocket.close()
        return

    frames = frames_data.get("frames", [])
    total_laps = frames_data.get("total_laps", 0)

    if not frames:
        await websocket.send_json({"error": "No frame data available"})
        await websocket.close()
        return

    # Group frames by lap number
    laps = {}
    for frame in frames:
        lap = frame.get("lap", 1)
        laps.setdefault(lap, []).append(frame)

    max_lap = max(laps.keys()) if laps else 1

    # Send initial metadata
    await websocket.send_json({
        "type": "metadata",
        "total_laps": total_laps or max_lap,
        "max_lap": max_lap,
        "frame_count": len(frames),
    })

    # Playback state
    playing = False
    speed = 1.0
    current_lap = 1

    async def send_lap(lap_num):
        """Send all frames for a given lap."""
        lap_frames = laps.get(lap_num, [])
        await websocket.send_json({
            "type": "lap_data",
            "lap": lap_num,
            "frames": lap_frames,
        })

    try:
        while True:
            # Non-blocking check for control messages
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.05)
                try:
                    ctrl = json.loads(msg)
                    action = ctrl.get("action")
                    if action == "play":
                        playing = True
                    elif action == "pause":
                        playing = False
                    elif action == "set_speed":
                        speed = max(0.25, min(16.0, float(ctrl.get("speed", 1.0))))
                    elif action == "seek":
                        current_lap = max(1, min(max_lap, int(ctrl.get("lap", 1))))
                        await send_lap(current_lap)
                except (json.JSONDecodeError, ValueError):
                    pass
            except asyncio.TimeoutError:
                pass

            # Advance playback
            if playing and current_lap <= max_lap:
                await send_lap(current_lap)
                current_lap += 1
                # Base interval ~1s per lap, divided by speed
                await asyncio.sleep(max(0.05, 1.0 / speed))

                if current_lap > max_lap:
                    playing = False
                    await websocket.send_json({"type": "replay_complete"})

    except WebSocketDisconnect:
        logger.info(f"Replay WS disconnected: {year} R{round_num}")
    except Exception as e:
        logger.error(f"Replay WS error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass
