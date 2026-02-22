"""
Gemini AI Strategy Integration
Compiles race state into Gemini prompts and parses strategy responses.
"""
import os
import json
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/gemini", tags=["gemini"])

# Try to import the new Google GenAI SDK
try:
    from google import genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False
    logger.warning("google-genai not installed. Gemini features will use mock responses.")


class GeminiRequest(BaseModel):
    query: str
    year: Optional[int] = None
    round: Optional[int] = None
    current_lap: Optional[int] = None
    drivers: Optional[List[str]] = None
    lstm_predictions: Optional[Dict[str, Any]] = None
    race_context: Optional[Dict[str, Any]] = None


def _build_prompt(request: GeminiRequest) -> str:
    """Build a structured prompt for Gemini with race context."""
    parts = [
        "You are an expert F1 race strategist AI assistant. Analyze the following race situation and provide strategy recommendations.",
        "",
        f"Race: {request.year} Round {request.round}" if request.year else "",
        f"Current Lap: {request.current_lap}" if request.current_lap else "",
        f"Focus Drivers: {', '.join(request.drivers)}" if request.drivers else "",
    ]

    if request.lstm_predictions:
        parts.append(f"\nLSTM Predictions: {json.dumps(request.lstm_predictions, default=str)}")

    if request.race_context:
        parts.append(f"\nRace Context: {json.dumps(request.race_context, default=str)}")

    parts.extend([
        "",
        f"User Question: {request.query}",
        "",
        "Respond with:",
        "1. A clear text analysis",
        "2. In a separate JSON block marked ```json, provide strategy scenarios with this structure:",
        '[{"id": "scenario_1", "label": "Strategy Name", "driver": "DRIVER_ABBR", "stints": [{"compound": "MEDIUM", "lap_start": 1, "length": 25}]}]',
        "",
        "Provide 2-3 realistic scenarios based on the race situation.",
    ])

    return '\n'.join(parts)


def _parse_gemini_response(text: str) -> dict:
    """Parse Gemini response to extract text and JSON scenarios."""
    scenarios = []

    # Try to extract JSON block
    if '```json' in text:
        try:
            json_start = text.index('```json') + 7
            json_end = text.index('```', json_start)
            json_str = text[json_start:json_end].strip()
            scenarios = json.loads(json_str)
            text = text[:text.index('```json')].strip()
        except (ValueError, json.JSONDecodeError) as e:
            logger.warning(f"Failed to parse Gemini JSON: {e}")

    return {
        'response': text,
        'scenarios': scenarios,
    }


def _mock_response(request: GeminiRequest) -> dict:
    """Generate a mock Gemini response for development."""
    driver = request.drivers[0] if request.drivers else 'VER'
    current_lap = request.current_lap or 20
    query = request.query.lower()

    if 'undercut' in query or 'overcut' in query:
        text = (
            f"Based on the current race situation at lap {current_lap}, "
            f"an undercut strategy for {driver} could gain 1-2 positions. "
            f"The optimal pit window is laps {current_lap + 2}-{current_lap + 5}. "
            f"However, an overcut could also work if tyre degradation is lower than expected."
        )
        scenarios = [
            {
                'id': 'undercut',
                'label': f'Undercut (Lap {current_lap + 3})',
                'driver': driver,
                'stints': [
                    {'compound': 'HARD', 'lap_start': current_lap + 3, 'length': 30},
                ],
            },
            {
                'id': 'overcut',
                'label': f'Overcut (Lap {current_lap + 8})',
                'driver': driver,
                'stints': [
                    {'compound': 'HARD', 'lap_start': current_lap + 8, 'length': 25},
                ],
            },
        ]
    elif '1-stop' in query or '2-stop' in query or 'compare' in query:
        text = (
            f"Comparing strategies for {driver}:\n\n"
            f"1-stop: MEDIUM(L1-L{current_lap + 15}) → HARD(L{current_lap + 16}-end). "
            f"Lower risk but depends on managing tyre deg.\n\n"
            f"2-stop: SOFT(L1-L15) → MEDIUM(L16-L35) → SOFT(L36-end). "
            f"Faster peak pace but more time lost in pit stops."
        )
        scenarios = [
            {
                'id': 'one_stop',
                'label': '1-Stop Strategy',
                'driver': driver,
                'stints': [
                    {'compound': 'MEDIUM', 'lap_start': 1, 'length': current_lap + 15},
                    {'compound': 'HARD', 'lap_start': current_lap + 16, 'length': 25},
                ],
            },
            {
                'id': 'two_stop',
                'label': '2-Stop Strategy',
                'driver': driver,
                'stints': [
                    {'compound': 'SOFT', 'lap_start': 1, 'length': 15},
                    {'compound': 'MEDIUM', 'lap_start': 16, 'length': 20},
                    {'compound': 'SOFT', 'lap_start': 36, 'length': 20},
                ],
            },
        ]
    else:
        text = (
            f"At lap {current_lap}, the key strategic considerations are:\n\n"
            f"1. Tyre management: Monitor degradation rates closely\n"
            f"2. Track position: Undercut opportunities in the next 5 laps\n"
            f"3. Weather: Current conditions favor a standard dry strategy\n\n"
            f"Recommendation: Pit for HARD tyres in the next 3-5 laps to extend "
            f"the final stint."
        )
        scenarios = [
            {
                'id': 'recommended',
                'label': f'Pit Lap {current_lap + 3}',
                'driver': driver,
                'stints': [
                    {'compound': 'HARD', 'lap_start': current_lap + 3, 'length': 30},
                ],
            },
        ]

    return {'response': text, 'scenarios': scenarios}


@router.post("/strategy")
async def gemini_strategy(request: GeminiRequest):
    """Query Gemini for strategy analysis with visual overlay data."""
    api_key = os.environ.get('GEMINI_API_KEY', '')

    if GEMINI_AVAILABLE and api_key:
        try:
            client = genai.Client(api_key=api_key)
            prompt = _build_prompt(request)
            response = client.models.generate_content(
                model='gemini-2.0-flash',
                contents=prompt,
            )
            return _parse_gemini_response(response.text)
        except Exception as e:
            logger.error(f"Gemini API error: {e}")
            return _mock_response(request)
    else:
        return _mock_response(request)
