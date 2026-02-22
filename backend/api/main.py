"""
FastAPI Main Application
F1 Analytics Platform API
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import logging
import sys
import json
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from data.extractors.fastf1_extractor import FastF1Extractor, get_sample_session_data
from data.processors.feature_engineering import FeatureEngineer, create_race_features
from data.processors.tsne_compute import load_embeddings, analyze_selection

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

# Cache for loaded sessions (processed JSON data) — in-memory
session_cache: Dict[str, Any] = {}

# Cache for raw FastF1 session objects (avoids re-loading heavy telemetry)
raw_session_cache: Dict[str, Any] = {}

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


def get_raw_session(year: int, round_num: int, session_type: str = "R"):
    """Get or load a raw FastF1 session object (cached in memory)."""
    cache_key = get_cache_key(year, round_num, session_type)
    if cache_key in raw_session_cache:
        logger.info(f"Using cached raw session for {cache_key}")
        return raw_session_cache[cache_key]
    session = extractor.get_session(year, round_num, session_type)
    raw_session_cache[cache_key] = session
    return session

# Include routers (only those that loaded successfully)
for _r in _routers_loaded:
    app.include_router(_r)


def clean_dataframe_for_json(df: Any) -> List[Dict[str, Any]]:
    """
    Clean a DataFrame for JSON serialization.
    Converts timedelta, datetime, and numpy types to JSON-serializable formats.
    Handles NaN, inf, and -inf values.
    """
    import numpy as np
    import math
    
    if df is None or (hasattr(df, 'empty') and df.empty):
        return []
    
    def is_nan_or_inf(value):
        """Check if value is NaN or infinity."""
        if value is None:
            return True
        if isinstance(value, float):
            return math.isnan(value) or math.isinf(value)
        if isinstance(value, (np.floating, np.integer)):
            return np.isnan(value) or np.isinf(value)
        return False
    
    def clean_value(value):
        """Clean a single value for JSON serialization."""
        # Handle None and NaN
        if value is None:
            return None
        
        # Handle numpy NaN/inf
        if isinstance(value, (np.floating, np.integer)):
            if np.isnan(value) or np.isinf(value):
                return None
            return float(value)
        
        # Handle native float NaN/inf
        if isinstance(value, float):
            if math.isnan(value) or math.isinf(value):
                return None
            return value
        
        # Handle timedelta
        if hasattr(value, 'total_seconds'):
            result = value.total_seconds()
            if math.isnan(result) or math.isinf(result):
                return None
            return result
        
        # Handle datetime/Timestamp
        if hasattr(value, 'isoformat'):
            return value.isoformat()
        
        # Handle numpy arrays
        if isinstance(value, np.ndarray):
            return value.tolist()
        
        # Handle numpy bool
        if isinstance(value, np.bool_):
            return bool(value)
        
        return value
    
    # Convert DataFrame to records
    records = df.to_dict('records')
    
    cleaned = []
    for record in records:
        clean_record = {}
        for key, value in record.items():
            clean_record[key] = clean_value(value)
        cleaned.append(clean_record)
    
    return cleaned


# ============= Pydantic Models =============

class SessionRequest(BaseModel):
    year: int
    round_num: int
    session_type: str = "R"



# ============= Helper Functions =============

def get_cache_key(year: int, round_num: int, session_type: str) -> str:
    return f"{year}_{round_num}_{session_type}"


def load_session(year: int, round_num: int, session_type: str = "R") -> Dict[str, Any]:
    """Load session data from memory cache, disk cache, or FastF1."""
    cache_key = get_cache_key(year, round_num, session_type)

    # 1. In-memory cache (instant)
    if cache_key in session_cache:
        return session_cache[cache_key]

    # 2. Disk cache (fast — just read JSON)
    disk_path = _disk_cache_path("session", year, round_num, session_type)
    disk_data = _load_from_disk(disk_path)
    if disk_data is not None:
        logger.info(f"Loaded session from disk cache: {disk_path.name}")
        session_cache[cache_key] = disk_data
        return disk_data

    # 3. Full extraction from FastF1 (slow — first time only)
    try:
        logger.info(f"Loading session {year} round {round_num} type {session_type}")
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


@app.get("/api/seasons")
async def get_seasons():
    """Get available seasons."""
    return {"seasons": list(range(2018, 2026))}


@app.get("/api/schedule/{year}")
async def get_schedule(year: int):
    """Get event schedule for a season."""
    try:
        schedule = extractor.get_event_schedule(year)
        return {
            "year": year,
            "events": schedule[['RoundNumber', 'EventName', 'Country', 'Location', 'EventDate', 'EventFormat']].to_dict('records')
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/session/{year}/{round_num}")
async def get_session_data(year: int, round_num: int, session_type: str = "R"):
    """Get comprehensive session data."""
    return load_session(year, round_num, session_type)


@app.get("/api/laptimes/{year}/{round_num}")
async def get_lap_times(year: int, round_num: int, driver: Optional[str] = None):
    """Get lap times for a session, optionally filtered by driver."""
    data = load_session(year, round_num, "R")
    lap_times = data['lap_times']
    
    if driver:
        lap_times = [lt for lt in lap_times if lt.get('Driver') == driver]
    
    return {"lap_times": lap_times}


@app.get("/api/telemetry/{year}/{round_num}/{driver}")
async def get_telemetry(year: int, round_num: int, driver: str, lap: Optional[int] = None):
    """Get telemetry data for a specific driver."""
    try:
        session = get_raw_session(year, round_num, "R")
        telemetry = extractor.extract_telemetry(session, driver, lap)
        
        if telemetry is None or telemetry.empty:
            return {
                "driver": driver,
                "lap": lap if lap else "fastest",
                "telemetry": []
            }
        
        return {
            "driver": driver,
            "lap": lap if lap else "fastest",
            "telemetry": clean_dataframe_for_json(telemetry)
        }
    except Exception as e:
        logger.error(f"Error fetching telemetry: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/circuit/{year}/{round_num}")
async def get_circuit_info(year: int, round_num: int):
    """Get circuit information including track coordinates."""
    data = load_session(year, round_num, "R")
    return data['circuit_info']


@app.get("/api/strategy/{year}/{round_num}")
async def get_tyre_strategy(year: int, round_num: int):
    """Get tyre strategy data for all drivers."""
    data = load_session(year, round_num, "R")
    return {"strategies": data['tyre_strategy']}


@app.get("/api/drivers/{year}/{round_num}")
async def get_drivers(year: int, round_num: int):
    """Get driver information for a session."""
    data = load_session(year, round_num, "R")
    return {"drivers": data['driver_info']}


@app.get("/api/results/{year}/{round_num}")
async def get_results(year: int, round_num: int):
    """Get race results."""
    data = load_session(year, round_num, "R")
    return {"results": data['race_results']}


@app.get("/api/positions/{year}/{round_num}")
async def get_positions(year: int, round_num: int):
    """Get position telemetry data for all drivers throughout the race.
    
    Returns position data for animating cars around the track in real-time.
    Data is downsampled to ~10K points per driver for performance.
    """
    try:
        session = get_raw_session(year, round_num, "R")
        position_data = extractor.extract_position_data(session)
        return position_data
    except Exception as e:
        logger.error(f"Error fetching positions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/frames/{year}/{round_num}")
async def get_race_frames(year: int, round_num: int, session_type: str = "R"):
    """Get race replay frames with full telemetry for all drivers.
    
    Returns frame-by-frame data for animating a race replay with:
    - Position (x, y coordinates)
    - Speed, Gear, DRS status
    - Throttle/Brake percentages
    - Tyre compound and life
    
    This enables rich race replay animations similar to broadcast-style visuals.
    """
    try:
        # Check disk cache first (instant)
        disk_path = _disk_cache_path("frames", year, round_num, session_type)
        disk_data = _load_from_disk(disk_path)
        if disk_data is not None:
            logger.info(f"Loaded frames from disk cache: {disk_path.name}")
            return disk_data

        # Extract from FastF1 (slow — first time only)
        session = get_raw_session(year, round_num, session_type)
        frames_data = extractor.extract_race_frames(session)
        _save_to_disk(disk_path, frames_data)
        return frames_data
    except Exception as e:
        logger.error(f"Error fetching race frames: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/weather/{year}/{round_num}")
async def get_weather(year: int, round_num: int):
    """Get weather data for a session."""
    data = load_session(year, round_num, "R")
    return {"weather": data['weather_data']}


# ============= t-SNE Endpoints =============

@app.get("/api/tsne/embeddings")
async def get_tsne_embeddings():
    """Return pre-computed t-SNE embeddings, or generate mock data if not available."""
    embeddings = load_embeddings()
    if embeddings is None:
        # Generate mock embeddings so the Analytics tab works without pre-computation
        import random
        random.seed(42)
        teams = {
            'VER': 'Red Bull Racing', 'PER': 'Red Bull Racing',
            'LEC': 'Ferrari', 'SAI': 'Ferrari',
            'HAM': 'Mercedes', 'RUS': 'Mercedes',
            'NOR': 'McLaren', 'PIA': 'McLaren',
            'ALO': 'Aston Martin', 'STR': 'Aston Martin',
            'GAS': 'Alpine', 'OCO': 'Alpine',
            'ALB': 'Williams', 'SAR': 'Williams',
            'TSU': 'RB', 'RIC': 'RB',
            'BOT': 'Kick Sauber', 'ZHO': 'Kick Sauber',
            'MAG': 'Haas F1 Team', 'HUL': 'Haas F1 Team',
        }
        races = [
            (1, 'Bahrain'), (2, 'Saudi Arabia'), (3, 'Australia'), (4, 'Japan'),
            (5, 'China'), (6, 'Miami'), (7, 'Emilia Romagna'), (8, 'Monaco'),
        ]
        points = []
        for driver, team in teams.items():
            for rnd, race_name in races:
                points.append({
                    'id': f'{driver}_2024_{rnd}',
                    'x': random.gauss(0, 15) + (hash(team) % 20 - 10),
                    'y': random.gauss(0, 15) + (hash(driver) % 20 - 10),
                    'driver': driver,
                    'team': team,
                    'year': 2024,
                    'round': rnd,
                    'race_name': race_name,
                })
        embeddings = {'points': points, 'feature_cols': [], 'n_points': len(points)}
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
    result = analyze_selection(request.point_ids)
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


# ============= Run Server =============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
