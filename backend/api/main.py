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
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from data.extractors.fastf1_extractor import FastF1Extractor, get_sample_session_data
from data.processors.feature_engineering import FeatureEngineer, create_race_features

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

# Cache for loaded sessions
session_cache: Dict[str, Any] = {}


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


class PredictionRequest(BaseModel):
    current_lap: int
    current_position: int
    tyre_compound: str
    tyre_age: int
    gap_ahead: float
    gap_behind: float
    planned_pit_lap: Optional[int] = None
    next_compound: Optional[str] = None
    weather: str = "DRY"
    track_temp: float = 35.0


class PredictionResponse(BaseModel):
    predicted_position: int
    confidence: float
    position_probabilities: Dict[str, float]
    recommendation: str
    alternative_strategies: List[Dict[str, Any]]


# ============= Helper Functions =============

def get_cache_key(year: int, round_num: int, session_type: str) -> str:
    return f"{year}_{round_num}_{session_type}"


def load_session(year: int, round_num: int, session_type: str = "R") -> Dict[str, Any]:
    """Load session data from cache or FastF1."""
    cache_key = get_cache_key(year, round_num, session_type)
    
    if cache_key in session_cache:
        return session_cache[cache_key]
    
    try:
        logger.info(f"Loading session {year} round {round_num} type {session_type}")
        session = extractor.get_session(year, round_num, session_type)
        
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
        
        data = {
            'lap_times': clean_dataframe_for_json(lap_times),
            'circuit_info': circuit_info,
            'driver_info': clean_dataframe_for_json(driver_info),
            'race_results': clean_dataframe_for_json(race_results),
            'weather_data': clean_dataframe_for_json(weather_data),
            'tyre_strategy': clean_dataframe_for_json(tyre_strategy),
        }
        session_cache[cache_key] = data
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
    return {"seasons": list(range(2018, 2025))}


@app.get("/api/schedule/{year}")
async def get_schedule(year: int):
    """Get event schedule for a season."""
    try:
        schedule = extractor.get_event_schedule(year)
        return {
            "year": year,
            "events": schedule[['RoundNumber', 'EventName', 'Country', 'Location', 'EventDate']].to_dict('records')
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
        session = extractor.get_session(year, round_num, "R")
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
        session = extractor.get_session(year, round_num, "R")
        position_data = extractor.extract_position_data(session)
        return position_data
    except Exception as e:
        logger.error(f"Error fetching positions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/weather/{year}/{round_num}")
async def get_weather(year: int, round_num: int):
    """Get weather data for a session."""
    data = load_session(year, round_num, "R")
    return {"weather": data['weather_data']}


@app.post("/api/predict/race_outcome")
async def predict_race_outcome(request: PredictionRequest):
    """
    Predict race outcome based on current race state.
    
    Note: This is a placeholder that returns mock predictions.
    Full ML model integration comes in Phase 2.
    """
    # Mock prediction logic (to be replaced with actual ML model)
    current_pos = request.current_position
    
    # Simple heuristic-based prediction
    predicted_pos = current_pos
    confidence = 0.7
    
    # Adjust based on tyre age
    if request.tyre_age > 25:
        predicted_pos = min(20, current_pos + 1)
        confidence = 0.6
    
    # Generate position probabilities
    probabilities = {}
    for pos in range(1, 21):
        if pos == predicted_pos:
            probabilities[str(pos)] = round(confidence, 2)
        elif abs(pos - predicted_pos) == 1:
            probabilities[str(pos)] = round((1 - confidence) / 2, 2)
        else:
            probabilities[str(pos)] = round((1 - confidence) / 18, 3)
    
    return PredictionResponse(
        predicted_position=predicted_pos,
        confidence=confidence,
        position_probabilities=probabilities,
        recommendation="Continue current strategy" if request.tyre_age < 20 else "Consider pit stop",
        alternative_strategies=[
            {"strategy": "Pit now for HARD", "predicted_position": max(1, current_pos - 1), "confidence": 0.65},
            {"strategy": "Extend stint 5 laps", "predicted_position": current_pos, "confidence": 0.55}
        ]
    )


@app.post("/api/predict/tyre_degradation")
async def predict_tyre_degradation(compound: str, tyre_age: int, track_temp: float):
    """Predict tyre degradation for given conditions."""
    # Mock degradation prediction
    base_deg = {"SOFT": 0.08, "MEDIUM": 0.05, "HARD": 0.03}.get(compound, 0.05)
    temp_factor = 1 + (track_temp - 35) * 0.01
    
    degradation_per_lap = base_deg * temp_factor
    estimated_life = int(1.5 / degradation_per_lap)  # Target ~1.5s slower
    
    return {
        "compound": compound,
        "degradation_per_lap": round(degradation_per_lap, 3),
        "current_age": tyre_age,
        "estimated_remaining_life": max(0, estimated_life - tyre_age),
        "current_degradation": round(degradation_per_lap * tyre_age, 2)
    }


@app.post("/api/predict/pit_window")
async def predict_pit_window(
    current_lap: int,
    current_position: int,
    tyre_age: int,
    gap_ahead: float,
    gap_behind: float
):
    """Predict optimal pit stop window."""
    # Simple rule-based pit window calculation
    undercut_window = current_lap + max(1, int(gap_ahead / 1.5))
    overcut_window = current_lap + max(3, int(25 - tyre_age))
    
    optimal_lap = current_lap + max(0, min(10, 22 - tyre_age))
    
    return {
        "current_lap": current_lap,
        "optimal_pit_lap": optimal_lap,
        "pit_window_start": current_lap + 1,
        "pit_window_end": current_lap + max(5, 25 - tyre_age),
        "undercut_risk_lap": undercut_window,
        "overcut_opportunity_lap": overcut_window,
        "recommendation": f"Pit on lap {optimal_lap} for best position",
        "confidence": 0.72
    }


# ============= Run Server =============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
