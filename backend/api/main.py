"""
FastAPI Main Application
F1 Analytics Platform API
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import asyncio
import logging
import os
import sys
import json
import numpy as np
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / '.env')

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from data.extractors.fastf1_extractor import FastF1Extractor, get_sample_session_data
from data.processors.feature_engineering import FeatureEngineer, create_race_features
from data.processors.tsne_compute import load_embeddings, load_pca_embeddings, analyze_selection
from data.processors.stints import build_tyre_strategy
from utils.json_helpers import clean_dataframe_for_json

# Import routers with graceful fallback so that a broken optional dependency
# (e.g. missing tensorflow) does not prevent the whole app from starting.
_routers_loaded = []

try:
    from api.routers.predictions import router as predictions_router
    _routers_loaded.append(predictions_router)
except Exception as _e:
    predictions_router = None
    logging.getLogger(__name__).warning(f"predictions router not loaded: {_e}")

try:
    from api.routers.gemini import router as gemini_router
    _routers_loaded.append(gemini_router)
except Exception as _e:
    gemini_router = None
    logging.getLogger(__name__).warning(f"gemini router not loaded: {_e}")

try:
    from api.routers.replay import router as replay_router
    _routers_loaded.append(replay_router)
except Exception as _e:
    replay_router = None
    logging.getLogger(__name__).warning(f"replay router not loaded: {_e}")

try:
    from api.routers.analytics import router as analytics_router
    _routers_loaded.append(analytics_router)
except Exception as _e:
    analytics_router = None
    logging.getLogger(__name__).warning(f"analytics router not loaded: {_e}")

try:
    from api.routers.live import router as live_router, set_session_manager, set_mock_replay
    _routers_loaded.append(live_router)
except Exception as _e:
    live_router = None
    set_session_manager = None
    set_mock_replay = None
    logging.getLogger(__name__).warning(f"live router not loaded: {_e}")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="F1 Analytics Platform API",
    description="Real-time F1 strategy analytics and race outcome prediction",
    version="1.0.0"
)

# Configure CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify frontend origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize data extractor
extractor = FastF1Extractor()
feature_engineer = FeatureEngineer()

# Expose shared resources on app.state so routers can access them
# (set after app is created below)

# Cache for loaded sessions (processed JSON data) — in-memory
session_cache: Dict[str, Any] = {}

# Cache for schedule data — avoids re-fetching from FastF1 on every page load
schedule_cache: Dict[int, Any] = {}

# Cache for championship standings — computed once per year
championship_cache: Dict[int, Any] = {}

# Cache for raw FastF1 session objects (avoids re-loading heavy telemetry)
raw_session_cache: Dict[str, Any] = {}

# Lock to serialize FastF1 access (FastF1 is NOT thread-safe)
import threading
_fastf1_lock = threading.Lock()

# Expose shared resources on app.state so routers (e.g. replay) can access them
app.state.extractor = extractor
app.state.fastf1_lock = _fastf1_lock
app.state.raw_session_cache = raw_session_cache

# Disk cache directory for processed JSON (instant loads after first computation)
DISK_CACHE_DIR = Path(__file__).parent.parent / "data" / "processed_cache"
DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _disk_cache_path(prefix: str, year: int, round_num: int, session_type: str) -> Path:
    return DISK_CACHE_DIR / f"{prefix}_{year}_{round_num}_{session_type}.json"


def _load_from_disk(path: Path):
    """Load JSON from disk cache, return None if not found."""
    if path.exists():
        try:
            import json as _json
            with open(path, 'r') as f:
                return _json.load(f)
        except Exception as e:
            logger.warning(f"Disk cache read failed for {path}: {e}")
    return None


def _save_to_disk(path: Path, data):
    """Save JSON data to disk cache."""
    try:
        import json as _json
        with open(path, 'w') as f:
            _json.dump(data, f, separators=(',', ':'))  # compact JSON
        logger.info(f"Saved disk cache: {path.name} ({path.stat().st_size / 1024:.0f} KB)")
    except Exception as e:
        logger.warning(f"Disk cache write failed for {path}: {e}")


def get_raw_session(year: int, round_num: int, session_type: str = "R", offline=False, **load_kwargs):
    """Get or load a raw FastF1 session object (cached in memory).

    NOTE: Callers must hold _fastf1_lock when calling this for uncached sessions.
    Extra kwargs are forwarded to extractor.get_session (laps, telemetry, weather, messages).
    When offline=True, FastF1 uses only its local cache (no network requests).
    """
    import fastf1
    cache_key = get_cache_key(year, round_num, session_type)
    if cache_key in raw_session_cache:
        return raw_session_cache[cache_key]
    if offline:
        fastf1.Cache.offline_mode(True)
    try:
        session = extractor.get_session(year, round_num, session_type, **load_kwargs)
    finally:
        if offline:
            fastf1.Cache.offline_mode(False)
    raw_session_cache[cache_key] = session
    return session

# Include routers (only those that loaded successfully)
for _r in _routers_loaded:
    app.include_router(_r)


# clean_dataframe_for_json imported from utils.json_helpers (see top-level imports)


# ============= Pydantic Models =============

class SessionRequest(BaseModel):
    year: int
    round_num: int
    session_type: str = "R"



# ============= Helper Functions =============

def get_cache_key(year: int, round_num: int, session_type: str) -> str:
    return f"{year}_{round_num}_{session_type}"


def _rebuild_tyre_strategy(data: Dict[str, Any]) -> Dict[str, Any]:
    """Replace data['tyre_strategy'] with stints rebuilt from data['lap_times'].

    Session payloads cached on disk by the old extractor split stints only on
    compound changes (Monza 2024: 40 stints instead of 50), and FastF1 cannot
    be relied on to re-extract them offline. The FastF1 Stint column is in the
    cached lap rows, so the stints are rebuilt from it on every load
    (build_tyre_strategy, ~1 ms for a race) without rewriting the cache. The previous
    payload's driver order is kept. Payloads without lap rows are untouched.
    """
    lap_times = data.get('lap_times') if isinstance(data, dict) else None
    if lap_times:
        previous = [s.get('Driver') for s in data.get('tyre_strategy') or [] if isinstance(s, dict)]
        data['tyre_strategy'] = build_tyre_strategy(lap_times, driver_order=previous)
    return data


def load_session(year: int, round_num: int, session_type: str = "R") -> Dict[str, Any]:
    """Load session data from memory cache, disk cache, or FastF1.

    Every payload goes through _rebuild_tyre_strategy before entering the
    memory cache, so all three paths return stints split by the Stint column.
    """
    cache_key = get_cache_key(year, round_num, session_type)

    # 1. In-memory cache (instant; tyre_strategy already rebuilt on insert)
    if cache_key in session_cache:
        return session_cache[cache_key]

    # 2. Disk cache (fast — just read JSON)
    disk_path = _disk_cache_path("session", year, round_num, session_type)
    disk_data = _load_from_disk(disk_path)
    if disk_data is not None:
        logger.info(f"Loaded session from disk cache: {disk_path.name}")
        disk_data = _rebuild_tyre_strategy(disk_data)
        session_cache[cache_key] = disk_data
        # Pre-load raw FastF1 session in background for telemetry readiness
        # Only load laps + telemetry (skip weather/messages for speed)
        if cache_key not in raw_session_cache:
            def _preload():
                try:
                    with _fastf1_lock:
                        if cache_key not in raw_session_cache:
                            logger.info(f"Background pre-loading raw session: {cache_key}")
                            get_raw_session(year, round_num, session_type, offline=True,
                                            laps=True, telemetry=True, weather=False, messages=False)
                            logger.info(f"Raw session ready: {cache_key}")
                except Exception as e:
                    logger.warning(f"Background raw session load failed: {e}")
            threading.Thread(target=_preload, daemon=True).start()
        return disk_data

    # 3. Full extraction from FastF1 (slow — first time only, thread-safe)
    try:
        logger.info(f"Loading session {year} round {round_num} type {session_type}")
        with _fastf1_lock:
            # Double-check caches after acquiring lock (another thread may have filled them)
            if cache_key in session_cache:
                return session_cache[cache_key]
            disk_data = _load_from_disk(disk_path)
            if disk_data is not None:
                disk_data = _rebuild_tyre_strategy(disk_data)
                session_cache[cache_key] = disk_data
                return disk_data

            session = get_raw_session(year, round_num, session_type)

            # Extract data with proper JSON serialization
            lap_times = extractor.extract_lap_times(session)
            circuit_info = extractor.extract_circuit_info(session)
            driver_info = extractor.extract_driver_info(session)
            race_results = extractor.extract_race_results(session)
            weather_data = extractor.extract_weather_data(session)
            tyre_strategy = extractor.extract_tyre_strategy(session)
        
        # Clean track coordinates in circuit_info
        if circuit_info.get('track_coordinates'):
            import numpy as np
            cleaned_coords = []
            for coord in circuit_info['track_coordinates']:
                cleaned_coord = {}
                for k, v in coord.items():
                    if isinstance(v, (np.integer, np.floating)):
                        cleaned_coord[k] = float(v)
                    else:
                        cleaned_coord[k] = v
                cleaned_coords.append(cleaned_coord)
            circuit_info['track_coordinates'] = cleaned_coords
        
        # Clean corners in circuit_info
        if circuit_info.get('corners'):
            import numpy as np
            cleaned_corners = []
            for corner in circuit_info['corners']:
                cleaned_corner = {}
                for k, v in corner.items():
                    if isinstance(v, (np.integer, np.floating)):
                        cleaned_corner[k] = float(v)
                    else:
                        cleaned_corner[k] = v
                cleaned_corners.append(cleaned_corner)
            circuit_info['corners'] = cleaned_corners
        
        track_status = extractor.extract_track_status(session)

        data = {
            'lap_times': clean_dataframe_for_json(lap_times),
            'circuit_info': circuit_info,
            'driver_info': clean_dataframe_for_json(driver_info),
            'race_results': clean_dataframe_for_json(race_results),
            'weather_data': clean_dataframe_for_json(weather_data),
            'tyre_strategy': clean_dataframe_for_json(tyre_strategy),
            'track_status': track_status,
        }
        data = _rebuild_tyre_strategy(data)
        session_cache[cache_key] = data
        _save_to_disk(disk_path, data)
        logger.info(f"Session loaded successfully with {len(data['lap_times'])} laps")
        return data
    except Exception as e:
        logger.error(f"Failed to load session: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============= API Routes =============

@app.get("/")
async def root():
    return {"message": "F1 Analytics Platform API", "version": "1.0.0"}


@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}


import datetime
import time

FIRST_SEASON = 2018

# year → (published, time.monotonic() of the check); a "not published" answer is re-checked
# after _SEASON_RECHECK_S, a published one is kept for the life of the process
_season_published_cache: Dict[int, Any] = {}
_SEASON_RECHECK_S = 3600
# How long a season check waits for _fastf1_lock. A first-time session load holds the lock
# for minutes; waiting on it (with a 30 s timeout per season) made /api/seasons take 60 s
# and then leave out the current season (verify_misc/v_b10_seasons.txt)
_SEASON_LOCK_WAIT_S = 2.0


def _current_year() -> int:
    """The clock's year (a function, so that tests can pin the clock)."""
    return datetime.date.today().year


def _has_rounds(events) -> bool:
    return any((e.get('RoundNumber') or 0) > 0 for e in events or [])


def _season_published(year: int, lock_wait: float = _SEASON_LOCK_WAIT_S) -> Optional[bool]:
    """True when `year` has a published schedule with at least one numbered round.

    A schedule already cached by /api/schedule (memory, then disk) answers yes;
    otherwise the FastF1 event schedule is asked (for a season not published yet,
    e.g. 2027 on 2026-10-13, FastF1 returns an empty schedule). None when that
    cannot be asked now: _fastf1_lock stayed busy for `lock_wait` seconds.
    """
    hit = _season_published_cache.get(year)
    if hit is not None and (hit[0] or time.monotonic() - hit[1] < _SEASON_RECHECK_S):
        return hit[0]
    cached = schedule_cache.get(year) or _load_from_disk(DISK_CACHE_DIR / f"schedule_{year}.json")
    if cached is not None and _has_rounds(cached.get('events')):
        published = True
    else:
        if not _fastf1_lock.acquire(timeout=lock_wait):
            return None
        try:
            schedule = extractor.get_event_schedule(year)
            published = len(schedule) > 0 and bool((schedule['RoundNumber'] > 0).any())
        except Exception as e:
            logger.warning(f"Schedule check for {year} failed: {e}")
            return False  # not cached: checked again on the next call
        finally:
            _fastf1_lock.release()
    _season_published_cache[year] = (published, time.monotonic())
    return published


@app.get("/api/seasons")
async def get_seasons():
    """Get available seasons: from 2018 up to the next season (clock year + 1).

    The seasons before the current one are always listed; the current and the
    next one only once their schedule is published. When the check cannot run
    now (FastF1 busy with another request, or slower than 30 s), the last answer
    for that season stands; with none yet, the clock's season is listed (a
    season's calendar is out before the season starts) and the next one is not.
    Neither guess is cached, so the next call checks again.
    """
    current = _current_year()
    seasons = list(range(FIRST_SEASON, current))
    lock_wait = _SEASON_LOCK_WAIT_S
    for year in (current, current + 1):
        try:
            published = await asyncio.wait_for(
                asyncio.to_thread(_season_published, year, lock_wait), timeout=30)
        except asyncio.TimeoutError:
            logger.warning(f"Schedule check for {year} timed out")
            published = None
        if published is None:
            lock_wait = 0  # FastF1 is busy: do not wait for it again in this request
            last = _season_published_cache.get(year)
            published = last[0] if last is not None else year == current
        if published:
            seasons.append(year)
    return {"seasons": seasons}


@app.get("/api/schedule/{year}")
async def get_schedule(year: int):
    """Get event schedule for a season (disk + memory cached)."""
    # 1. Memory cache
    if year in schedule_cache:
        return schedule_cache[year]

    # 2. Disk cache
    disk_path = DISK_CACHE_DIR / f"schedule_{year}.json"
    disk_data = _load_from_disk(disk_path)
    if disk_data is not None:
        logger.info(f"Loaded schedule from disk cache: {disk_path.name}")
        schedule_cache[year] = disk_data
        return disk_data

    # 3. Fetch from FastF1 with a timeout
    try:
        def _fetch_schedule():
            with _fastf1_lock:
                return extractor.get_event_schedule(year)

        schedule = await asyncio.wait_for(
            asyncio.to_thread(_fetch_schedule),
            timeout=30,
        )
        result = {
            "year": year,
            "events": clean_dataframe_for_json(
                schedule[['RoundNumber', 'EventName', 'Country', 'Location', 'EventDate', 'EventFormat']]
            )
        }
        schedule_cache[year] = result
        _save_to_disk(disk_path, result)
        return result
    except asyncio.TimeoutError:
        logger.error(f"FastF1 schedule fetch timed out for {year}")
        raise HTTPException(status_code=504, detail=f"Schedule fetch timed out for {year}. Try again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/session/{year}/{round_num}")
async def get_session_data(year: int, round_num: int, session_type: str = "R"):
    """Get comprehensive session data."""
    return await asyncio.to_thread(load_session, year, round_num, session_type)


@app.get("/api/laptimes/{year}/{round_num}")
async def get_lap_times(year: int, round_num: int, driver: Optional[str] = None):
    """Get lap times for a session, optionally filtered by driver."""
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    lap_times = data['lap_times']

    if driver:
        lap_times = [lt for lt in lap_times if lt.get('Driver') == driver]

    return {"lap_times": lap_times}


@app.get("/api/telemetry/{year}/{round_num}/{driver}")
async def get_telemetry(year: int, round_num: int, driver: str, lap: Optional[int] = None, session_type: str = "R"):
    """Get telemetry data for a specific driver."""
    try:
        # Disk cache for telemetry (keyed by driver + lap)
        lap_key = lap if lap else "fastest"
        cache_path = DISK_CACHE_DIR / f"telemetry_{year}_{round_num}_{session_type}_{driver}_{lap_key}.json"
        cached = _load_from_disk(cache_path)
        if cached is not None:
            logger.info(f"Telemetry from disk cache: {driver} lap {lap_key}")
            return cached

        def _fetch():
            with _fastf1_lock:
                session = get_raw_session(year, round_num, session_type, offline=True,
                                          laps=True, telemetry=True, weather=False, messages=False)
                return extractor.extract_telemetry(session, driver, lap)

        telemetry = await asyncio.to_thread(_fetch)

        if telemetry is None or (hasattr(telemetry, 'empty') and telemetry.empty):
            result = {
                "driver": driver,
                "lap": lap_key,
                "telemetry": []
            }
        else:
            result = {
                "driver": driver,
                "lap": lap_key,
                "telemetry": clean_dataframe_for_json(telemetry)
            }

        _save_to_disk(cache_path, result)
        return result
    except Exception as e:
        logger.error(f"Error fetching telemetry: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/circuit/{year}/{round_num}")
async def get_circuit_info(year: int, round_num: int):
    """Get circuit information including track coordinates."""
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    return data['circuit_info']


@app.get("/api/strategy/{year}/{round_num}")
async def get_tyre_strategy(year: int, round_num: int):
    """Get tyre strategy data for all drivers (one stint per tyre set)."""
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    # load_session rebuilt tyre_strategy from the lap rows' Stint column
    return {"strategies": data['tyre_strategy']}


@app.get("/api/drivers/{year}/{round_num}")
async def get_drivers(year: int, round_num: int):
    """Get driver information for a session."""
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    return {"drivers": data['driver_info']}


@app.get("/api/results/{year}/{round_num}")
async def get_results(year: int, round_num: int):
    """Get race results."""
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    return {"results": data['race_results']}


@app.get("/api/positions/{year}/{round_num}")
async def get_positions(year: int, round_num: int):
    """Get position telemetry data for all drivers throughout the race."""
    try:
        def _fetch():
            with _fastf1_lock:
                session = get_raw_session(year, round_num, "R")
                return extractor.extract_position_data(session)

        return await asyncio.to_thread(_fetch)
    except Exception as e:
        logger.error(f"Error fetching positions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/frames/{year}/{round_num}")
async def get_race_frames(year: int, round_num: int, session_type: str = "R"):
    """Get race replay frames."""
    try:
        # Check disk cache first (instant)
        disk_path = _disk_cache_path("frames", year, round_num, session_type)
        disk_data = _load_from_disk(disk_path)
        if disk_data is not None:
            logger.info(f"Loaded frames from disk cache: {disk_path.name}")
            return disk_data

        # Extract from FastF1 in a thread (slow — first time only)
        def _extract_frames():
            with _fastf1_lock:
                session = get_raw_session(year, round_num, session_type)
                if session_type == 'Q':
                    frames_data = extractor.extract_qualifying_frames(session)
                else:
                    frames_data = extractor.extract_race_frames(session)
            _save_to_disk(disk_path, frames_data)
            return frames_data

        return await asyncio.to_thread(_extract_frames)
    except Exception as e:
        logger.error(f"Error fetching race frames: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/weather/{year}/{round_num}")
async def get_weather(year: int, round_num: int):
    """Get weather data for a session."""
    data = await asyncio.to_thread(load_session, year, round_num, "R")
    return {"weather": data['weather_data']}


# ============= Championship Endpoints =============

# Bumped when the points model of _compute_championship changes: a championship_{year}.json
# written with another version is recomputed instead of served (v2: sprint points included).
CHAMPIONSHIP_CACHE_VERSION = 2

# EventFormat values of the weekends with a sprint (FastF1 schedule): 'sprint' 2021-2022,
# 'sprint_shootout' 2023, 'sprint_qualifying' since 2024.
SPRINT_FORMATS = ('sprint', 'sprint_shootout', 'sprint_qualifying')


def _max_points(year: int, team: bool = False) -> Dict[str, int]:
    """Most points one driver (team=False) or one team of two cars can score in the
    race and in the sprint of a weekend, under the rules of `year`.

    Race 25-18-...; the fastest-lap point (top ten only) was awarded 2019-2024 only.
    Sprint points: 2021 3-2-1, since 2022 8-7-6-5-4-3-2-1; no sprints before 2021.
    """
    race = 25 + (18 if team else 0) + (1 if 2019 <= year <= 2024 else 0)
    if year >= 2022:
        sprint = 8 + (7 if team else 0)
    elif year == 2021:
        sprint = 3 + (2 if team else 0)
    else:
        sprint = 0
    return {'race': race, 'sprint': sprint}


def _points(row: Dict[str, Any]) -> float:
    raw_pts = row.get('Points', 0)
    return float(raw_pts) if raw_pts is not None and raw_pts == raw_pts else 0.0  # handles NaN


def _load_sprint_results(year: int, round_num: int, fast_only: bool = True) -> Optional[List[Dict[str, Any]]]:
    """Sprint classification rows (Abbreviation, TeamName, Points, ...) of a sprint
    weekend, or None when they are not available.

    Cached on disk as results_{year}_{round}_S.json: only the classification, the
    sprint's laps and telemetry are not needed for the standings. With fast_only only
    that file is read; otherwise the sprint is loaded from FastF1 (results only, a few
    seconds) and cached. Rows without any points (the sprint not run yet, or FastF1 left
    without the Ergast classification) count as not available and are not cached.
    """
    disk_path = _disk_cache_path("results", year, round_num, "S")
    cached = _load_from_disk(disk_path)
    if cached is not None:
        return cached
    if fast_only:
        return None
    try:
        with _fastf1_lock:
            results = clean_dataframe_for_json(extractor.get_session_results(year, round_num, "S"))
    except Exception as e:
        logger.warning(f"Could not load sprint results {year} R{round_num}: {e}")
        return None
    if not any(_points(r) > 0 for r in results):
        logger.warning(f"Sprint results {year} R{round_num} carry no points; not cached")
        return None
    _save_to_disk(disk_path, results)
    return results


def _compute_championship(year: int, fast_only: bool = True) -> Dict[str, Any]:
    """Compute cumulative championship standings for a full season.

    The points of a round are those of its race plus, on sprint weekends, those of
    its sprint (results_{year}_{round}_S.json, see _load_sprint_results). A round
    whose race or sprint classification is not available is listed in missing_rounds
    (the sprint ones also in missing_sprint_rounds).

    Args:
        fast_only: If True, only use disk-cached sessions (instant).
                   If False, load all sessions from FastF1 (slow first time).
    """
    # Get schedule (lock needed for FastF1 access)
    with _fastf1_lock:
        schedule = extractor.get_event_schedule(year)
    weekends = schedule[schedule['EventFormat'].isin(['conventional', *SPRINT_FORMATS])]
    race_rounds = sorted(int(r) for r in weekends['RoundNumber'].unique())  # ensure native Python ints
    sprint_rounds = {int(r) for r in weekends.loc[weekends['EventFormat'].isin(SPRINT_FORMATS), 'RoundNumber']}

    driver_data = {}   # abbr → { name, team, teamColor, countryCode, rounds: [{round, points, sprint_points}] }
    team_data = {}     # teamName → { teamColor, rounds: [{round, points}] }
    missing_rounds = []
    missing_sprint_rounds = []
    races_done = set()
    sprints_done = set()

    completed_rounds = 0
    for rnd in race_rounds:
        weekend = []  # (classification row, is_sprint) of the race and of the sprint
        try:
            # In fast mode, only use disk-cached sessions
            data = None
            if fast_only:
                disk_path = _disk_cache_path("session", year, rnd, "R")
                data = _load_from_disk(disk_path)
                if data is None:
                    # Also check in-memory cache
                    data = session_cache.get(get_cache_key(year, rnd, "R"))
                    if data is None:
                        missing_rounds.append(rnd)
            else:
                data = load_session(year, rnd, "R")

            results = (data or {}).get('race_results') or []
            if results:
                completed_rounds += 1
                races_done.add(rnd)
            weekend.extend((r, False) for r in results)
        except Exception as e:
            logger.warning(f"Could not load round {rnd} for championship: {e}")
            missing_rounds.append(rnd)

        if rnd in sprint_rounds:
            sprint = _load_sprint_results(year, rnd, fast_only)
            if sprint is None:
                missing_sprint_rounds.append(rnd)
                if rnd not in missing_rounds:
                    missing_rounds.append(rnd)
            else:
                sprints_done.add(rnd)
                weekend.extend((r, True) for r in sprint)

        round_driver_pts = {}  # abbr → [points, sprint points]
        round_team_pts = {}
        for r, is_sprint in weekend:
            abbr = r.get('Abbreviation') or r.get('Driver')
            if not abbr:
                continue
            pts = _points(r)
            team = r.get('TeamName', '')
            teamColor = r.get('TeamColor', '')
            if teamColor and not teamColor.startswith('#'):
                teamColor = f'#{teamColor}'
            name = r.get('FullName', abbr)
            cc = r.get('CountryCode', '')

            if abbr not in driver_data:
                driver_data[abbr] = {
                    'name': name, 'team': team, 'teamColor': teamColor,
                    'countryCode': cc, 'rounds': [],
                }
            acc = round_driver_pts.setdefault(abbr, [0.0, 0.0])
            acc[0] += pts
            if is_sprint:
                acc[1] += pts
            # Update team info in case of mid-season change
            driver_data[abbr]['team'] = team
            driver_data[abbr]['teamColor'] = teamColor

            # Accumulate team points
            if team:
                if team not in team_data:
                    team_data[team] = {'teamColor': teamColor, 'rounds': []}
                round_team_pts.setdefault(team, 0)
                round_team_pts[team] += pts

        for abbr, (pts, sprint_pts) in round_driver_pts.items():
            driver_data[abbr]['rounds'].append({'round': rnd, 'points': pts, 'sprint_points': sprint_pts})
        for team, pts in round_team_pts.items():
            team_data[team]['rounds'].append({'round': rnd, 'points': pts})

    # Build progression arrays with cumulative totals and positions
    total_rounds = len(race_rounds)
    remaining_rounds = total_rounds - completed_rounds
    missing_rounds.sort()

    # Best case: the most the rules of the season still allow, race by race and sprint
    # by sprint (a sprint already run on a weekend whose race is not counts no more)
    def _still_available(team: bool) -> int:
        cap = _max_points(year, team=team)
        return sum((cap['race'] if rnd not in races_done else 0)
                   + (cap['sprint'] if rnd in sprint_rounds and rnd not in sprints_done else 0)
                   for rnd in race_rounds)

    driver_best_gain = _still_available(team=False)
    team_best_gain = _still_available(team=True)

    drivers_out = []
    for abbr, d in driver_data.items():
        cumulative = 0
        progression = []
        for r in sorted(d['rounds'], key=lambda x: x['round']):
            cumulative += r['points']
            progression.append({
                'round': r['round'],
                'points': r['points'],
                'sprint_points': r['sprint_points'],
                'cumulative': cumulative,
            })

        # Prediction: weighted moving average of recent points-per-weekend
        prediction = None
        if len(progression) >= 3 and remaining_rounds > 0:
            recent = [p['points'] for p in progression[-5:]]
            weights = list(range(1, len(recent) + 1))
            avg_ppg = float(np.average(recent, weights=weights))
            prediction = {
                'predicted_total': round(cumulative + avg_ppg * remaining_rounds),
                'avg_points_per_race': round(avg_ppg, 1),
                'best_case': cumulative + driver_best_gain,
                'worst_case': cumulative,
            }

        drivers_out.append({
            'abbr': abbr,
            'name': d['name'],
            'team': d['team'],
            'teamColor': d['teamColor'],
            'countryCode': d['countryCode'],
            'totalPoints': cumulative,
            'progression': progression,
            'prediction': prediction,
        })

    # Sort by total points descending and assign positions per round
    drivers_out.sort(key=lambda x: -x['totalPoints'])
    # Assign final position
    for i, d in enumerate(drivers_out):
        d['position'] = i + 1

    # Per-round positions for drivers
    all_rounds_sorted = sorted(set(r['round'] for d in drivers_out for r in d['progression']))
    for rnd in all_rounds_sorted:
        # Get cumulative at this round for each driver
        round_cum = []
        for d in drivers_out:
            cum = 0
            for p in d['progression']:
                if p['round'] <= rnd:
                    cum = p['cumulative']
            round_cum.append((d['abbr'], cum))
        round_cum.sort(key=lambda x: -x[1])
        pos_map = {abbr: i + 1 for i, (abbr, _) in enumerate(round_cum)}
        for d in drivers_out:
            for p in d['progression']:
                if p['round'] == rnd:
                    p['position'] = pos_map.get(d['abbr'], 99)

    constructors_out = []
    for team, t in team_data.items():
        cumulative = 0
        progression = []
        for r in sorted(t['rounds'], key=lambda x: x['round']):
            cumulative += r['points']
            progression.append({
                'round': r['round'],
                'points': r['points'],
                'cumulative': cumulative,
            })

        prediction = None
        if len(progression) >= 3 and remaining_rounds > 0:
            recent = [p['points'] for p in progression[-5:]]
            weights = list(range(1, len(recent) + 1))
            avg_ppg = float(np.average(recent, weights=weights))
            prediction = {
                'predicted_total': round(cumulative + avg_ppg * remaining_rounds),
                'avg_points_per_race': round(avg_ppg, 1),
                'best_case': cumulative + team_best_gain,  # 1-2 in every race and sprint left
                'worst_case': cumulative,
            }

        constructors_out.append({
            'team': team,
            'teamColor': t['teamColor'],
            'totalPoints': cumulative,
            'progression': progression,
            'prediction': prediction,
        })

    constructors_out.sort(key=lambda x: -x['totalPoints'])
    for i, c in enumerate(constructors_out):
        c['position'] = i + 1

    # Per-round positions for constructors
    for rnd in all_rounds_sorted:
        round_cum = []
        for c in constructors_out:
            cum = 0
            for p in c['progression']:
                if p['round'] <= rnd:
                    cum = p['cumulative']
            round_cum.append((c['team'], cum))
        round_cum.sort(key=lambda x: -x[1])
        pos_map = {team: i + 1 for i, (team, _) in enumerate(round_cum)}
        for c in constructors_out:
            for p in c['progression']:
                if p['round'] == rnd:
                    p['position'] = pos_map.get(c['team'], 99)

    result = {
        'year': year,
        'cache_version': CHAMPIONSHIP_CACHE_VERSION,
        'total_rounds': total_rounds,
        'completed_rounds': completed_rounds,
        'missing_rounds': missing_rounds,
        'missing_sprint_rounds': missing_sprint_rounds,
        'drivers': drivers_out,
        'constructors': constructors_out,
    }
    return result


@app.get("/api/championship/{year}")
async def get_championship(year: int, load_all: bool = False):
    """Get championship standings progression for a season.

    By default, only uses disk-cached sessions (instant).
    Set load_all=true to fetch ALL rounds from FastF1 (slow first time).
    """
    # If load_all requested, bypass caches and recompute
    if load_all:
        try:
            result = await asyncio.to_thread(_compute_championship, year, fast_only=False)
            championship_cache[year] = result
            disk_path = DISK_CACHE_DIR / f"championship_{year}.json"
            _save_to_disk(disk_path, result)
            return result
        except Exception as e:
            logger.error(f"Failed to compute full championship for {year}: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))

    if year in championship_cache:
        return championship_cache[year]

    # Check disk cache for championship (one written by an older points model,
    # e.g. without the sprint points, is recomputed)
    disk_path = DISK_CACHE_DIR / f"championship_{year}.json"
    disk_data = _load_from_disk(disk_path)
    if disk_data is not None and disk_data.get('cache_version') == CHAMPIONSHIP_CACHE_VERSION:
        championship_cache[year] = disk_data
        return disk_data

    try:
        # Fast mode: only use already-cached sessions
        result = _compute_championship(year, fast_only=True)
        championship_cache[year] = result
        # Only save to disk if we have all rounds
        if not result.get('missing_rounds'):
            _save_to_disk(disk_path, result)
        return result
    except Exception as e:
        logger.error(f"Failed to compute championship for {year}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============= t-SNE Endpoints =============

@app.get("/api/tsne/embeddings")
async def get_tsne_embeddings():
    """Return pre-computed t-SNE embeddings, auto-building from cached sessions if needed."""
    import asyncio
    embeddings = await asyncio.to_thread(load_embeddings)
    if embeddings is None:
        return {
            'points': [],
            'feature_cols': [],
            'n_points': 0,
            'message': 'No t-SNE data available. Load at least one race session first.',
        }
    return embeddings


@app.get("/api/pca/embeddings")
async def get_pca_embeddings():
    """Return pre-computed PCA embeddings with loadings, auto-building if needed."""
    embeddings = await asyncio.to_thread(load_pca_embeddings)
    if embeddings is None:
        return {
            'points': [],
            'loadings': [],
            'explained_variance': [],
            'pc1_label': '',
            'pc2_label': '',
            'feature_cols': [],
            'n_points': 0,
            'message': 'No PCA data available. Load at least one race session first.',
        }
    return embeddings


class TSNEProjectRequest(BaseModel):
    features: Dict[str, float]

@app.post("/api/tsne/project")
async def project_tsne(request: TSNEProjectRequest):
    """Project current qualifying data into t-SNE space."""
    # Simplified: return nearest existing point
    embeddings = load_embeddings()
    if not embeddings:
        raise HTTPException(status_code=404, detail="No embeddings available")
    return {"projected": embeddings['points'][0] if embeddings['points'] else {}}


class TSNEAnalyzeRequest(BaseModel):
    point_ids: List[str]

@app.post("/api/tsne/analyze-selection")
async def analyze_tsne_selection(request: TSNEAnalyzeRequest):
    """Analyze strategy patterns for selected t-SNE points."""
    import asyncio
    result = await asyncio.to_thread(analyze_selection, request.point_ids)
    return result


@app.get("/api/tsne/point-features/{point_id}")
async def get_point_features(point_id: str):
    """Get raw feature values for a specific t-SNE point."""
    import pandas as pd
    csv_path = Path(__file__).parent.parent / 'data' / 'processed' / 'tsne_feature_matrix.csv'
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="Feature matrix not found")

    parts = point_id.rsplit('_', 2)
    if len(parts) != 3:
        raise HTTPException(status_code=400, detail="Invalid point_id format")

    driver, year_str, round_str = parts[0], parts[1], parts[2]
    df = pd.read_csv(csv_path)
    match = df[(df['driver'] == driver) & (df['year'] == int(year_str)) & (df['round'] == int(round_str))]
    if match.empty:
        raise HTTPException(status_code=404, detail="Point not found")

    from data.processors.tsne_compute import FEATURE_COLS
    row = match.iloc[0]
    features = {}
    for col in FEATURE_COLS:
        if col in row.index:
            val = row[col]
            features[col] = round(float(val), 3) if pd.notna(val) else None
    return {'point_id': point_id, 'driver': driver, 'features': features}


# ============= Live Timing Lifecycle =============

_live_session_manager = None
_live_signalr_task = None
_live_mock_replay = None


@app.on_event("startup")
async def _startup_live_timing():
    """Initialize live timing components on app startup."""
    global _live_session_manager, _live_mock_replay
    try:
        from live.session_manager import LiveSessionManager
        from live.mock_replay import MockReplay

        _live_session_manager = LiveSessionManager()
        _live_mock_replay = MockReplay(_live_session_manager)

        # Wire them into the live router
        if set_session_manager:
            set_session_manager(_live_session_manager)
        if set_mock_replay:
            set_mock_replay(_live_mock_replay)

        logger.info("Live timing system initialized (mock replay ready)")
    except Exception as e:
        logger.warning(f"Live timing init failed (non-fatal): {e}")


@app.on_event("shutdown")
async def _shutdown_live_timing():
    """Clean shutdown of live timing components."""
    global _live_signalr_task, _live_mock_replay
    if _live_mock_replay and _live_mock_replay.is_running:
        await _live_mock_replay.stop()
    if _live_session_manager:
        await _live_session_manager.stop_openf1()
    if _live_signalr_task:
        _live_signalr_task.cancel()
        try:
            await _live_signalr_task
        except asyncio.CancelledError:
            pass
    logger.info("Live timing system shut down")


@app.get("/api/live/connect-signalr")
async def connect_live_signalr(reset: bool = False):
    """Manually start the SignalR connection to F1 live timing.

    Call this when an F1 session is about to start. The connection will
    auto-reconnect if dropped.

    Pass ``?reset=true`` to wipe accumulated session state before reconnecting
    (e.g. when starting a fresh session). Default is to PRESERVE accumulated
    data so a viewer who exits and re-enters mid-race keeps their timing
    grid, lap history, and race-control feed.
    """
    global _live_signalr_task, _live_session_manager
    if _live_session_manager is None:
        return {"error": "Live timing not initialized"}
    if _live_signalr_task and not _live_signalr_task.done():
        return {"status": "already_connected"}

    try:
        from live.signalr_client import F1SignalRClient

        if reset:
            _live_session_manager.reset()
        else:
            logger.info(
                "Reconnecting SignalR — preserving %d laps, %d drivers, "
                "%d retirements (pass ?reset=true to clear)",
                len(_live_session_manager.lap_times),
                len(_live_session_manager.driver_info),
                len(_live_session_manager.driver_statuses),
            )

        async def _on_msg(topic, data):
            await _live_session_manager.on_message(topic, data)

        client = F1SignalRClient(on_message=lambda t, d: asyncio.create_task(_on_msg(t, d)))
        _live_signalr_task = asyncio.create_task(client.start())

        # Also start OpenF1 telemetry polling for car data + positions
        # (SignalR's CarData.z and Position.z are paywalled since 2025)
        try:
            await _live_session_manager.start_openf1()
            logger.info("OpenF1 telemetry polling started alongside SignalR")
        except Exception as oe:
            logger.warning(f"OpenF1 telemetry not available: {oe}")

        return {"status": "connecting", "message": "SignalR client started (with OpenF1 telemetry)"}
    except Exception as e:
        logger.error(f"SignalR connect failed: {e}")
        return {"error": str(e)}


@app.get("/api/live/load-full-session")
async def load_live_full_session():
    """Load full session data via FastF1 for the current/recent live session.

    When connecting to a finished session, SignalR only gives a state snapshot
    (no lap history). This endpoint resolves the event from session_info and
    loads the complete data through FastF1.
    """
    if _live_session_manager is None:
        return {"error": "Live timing not initialized"}

    info = _live_session_manager.session_info
    if not info:
        return {"error": "No session info available"}

    # Extract year from start_date or fallback to current year
    import datetime
    year = None
    start_date = info.get("start_date", "")
    if start_date:
        try:
            year = int(start_date[:4])
        except (ValueError, IndexError):
            pass
    if not year:
        year = datetime.datetime.now().year

    event_name = info.get("event_name", "") or info.get("circuit_name", "")
    session_type_raw = info.get("session_name", "") or info.get("session_type", "")

    # Map session type names to FastF1 identifiers
    session_type_map = {
        "Race": "R", "Sprint": "S", "Qualifying": "Q",
        "Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3",
        "Sprint Qualifying": "SQ", "Sprint Shootout": "SS",
    }
    session_type = session_type_map.get(session_type_raw, session_type_raw)
    if not session_type:
        session_type = "R"

    logger.info(f"Loading full session via FastF1: {year} '{event_name}' {session_type}")

    try:
        import fastf1
        # Use event name to find the round
        schedule = fastf1.get_event_schedule(year, include_testing=False)
        round_num = None
        for _, row in schedule.iterrows():
            if event_name and (
                event_name.lower() in str(row.get("EventName", "")).lower()
                or event_name.lower() in str(row.get("OfficialEventName", "")).lower()
                or event_name.lower() in str(row.get("Location", "")).lower()
            ):
                round_num = int(row["RoundNumber"])
                break

        if round_num is None:
            return {"error": f"Could not find round for '{event_name}' in {year} schedule"}

        data = await asyncio.to_thread(load_session, year, round_num, session_type)
        logger.info(f"Full session loaded: {len(data.get('lap_times', []))} lap entries")
        # Sanitize any remaining NaN/Inf before JSON serialization
        import math as _math
        def _sanitize(obj):
            if isinstance(obj, float) and (_math.isnan(obj) or _math.isinf(obj)):
                return None
            if isinstance(obj, dict):
                return {k: _sanitize(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_sanitize(v) for v in obj]
            return obj
        return _sanitize(data)
    except Exception as e:
        logger.error(f"Failed to load full session: {e}", exc_info=True)
        return {"error": str(e)}


@app.post("/api/live/load-team-radios")
async def load_team_radios():
    """Pull TeamRadio.json from F1's static CDN and ingest every capture.

    Use this after a session ends (or for any past race in replay mode) to
    backfill the team-radio feed. F1 paywalls this endpoint during live
    sessions, so during a running race this returns ``status: paywalled``.
    """
    if _live_session_manager is None:
        return {"error": "Live timing not initialized"}
    return await _live_session_manager.fetch_static_team_radios()


@app.post("/api/live/reset")
async def reset_live_session():
    """Explicitly wipe accumulated live-session state.

    Use this when starting a brand-new session and you want a clean slate.
    Normal exit/re-entry should NOT call this — the in-memory accumulation
    is what makes data persist across viewer reconnects.
    """
    if _live_session_manager is None:
        return {"error": "Live timing not initialized"}
    _live_session_manager.reset()
    return {"status": "reset"}


@app.get("/api/live/disconnect-signalr")
async def disconnect_live_signalr():
    """Stop the SignalR connection and OpenF1 telemetry."""
    global _live_signalr_task
    if _live_session_manager:
        await _live_session_manager.stop_openf1()
    if _live_signalr_task:
        _live_signalr_task.cancel()
        try:
            await _live_signalr_task
        except asyncio.CancelledError:
            pass
        _live_signalr_task = None
        return {"status": "disconnected"}
    return {"status": "not_connected"}


# ============= Run Server =============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
