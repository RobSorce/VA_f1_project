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
    """Build a structured prompt for Gemini with full race intelligence."""
    parts = [
        "You are a senior F1 race strategy engineer. You have access to real-time data "
        "including Monte Carlo simulations, LSTM lap time predictions, tyre degradation models, "
        "and driver performance features. Your job is to give clear, actionable strategy calls "
        "that a team principal or race engineer could radio to the driver.",
        "",
        "Be concise and decisive. Prioritize: when to pit, which compound, and how to handle "
        "specific battles. Reference the data to justify your recommendations.",
        "",
    ]

    if request.year:
        parts.append(f"Race: {request.year} Round {request.round}")
    if request.current_lap:
        parts.append(f"Current Lap: {request.current_lap}")
    if request.drivers:
        parts.append(f"Focus Drivers: {', '.join(request.drivers)}")

    if request.lstm_predictions:
        parts.append(f"\n## LSTM Lap Time Predictions (next 5-10 laps)")
        parts.append(json.dumps(request.lstm_predictions, default=str, indent=2))

    if request.race_context:
        ctx = request.race_context
        if ctx.get('monteCarloProjections'):
            parts.append("\n## Monte Carlo Race Predictions (100 simulations, real session data)")
            for p in ctx['monteCarloProjections']:
                exp = p.get('expectedPos', '?')
                exp_str = f"{exp:.1f}" if isinstance(exp, (int, float)) else str(exp)
                r = p.get('posRange', ['?', '?'])
                parts.append(
                    f"  {p['driver']}: Current P{p.get('currentPos','?')} -> "
                    f"Expected P{exp_str} (range P{r[0]}-P{r[1]}), "
                    f"Podium: {p.get('podiumProb', 0)}%, Points: {p.get('pointsProb', 0)}%"
                )
        if ctx.get('battles'):
            parts.append("\n## Key Battles (overtake probabilities)")
            for b in ctx['battles']:
                parts.append(
                    f"  {b.get('driver2','?')} vs {b.get('driver1','?')}: "
                    f"{b.get('overtakeProb', 0)}% chance of position swap "
                    f"({b.get('type', 'unknown')})"
                )
        if ctx.get('risks'):
            parts.append("\n## Risk Alerts")
            for r in ctx['risks']:
                parts.append(
                    f"  [{r.get('severity','?').upper()}] {r.get('driver','?')}: "
                    f"{r.get('description', r.get('message', ''))}"
                )
        if ctx.get('raceParams'):
            rp = ctx['raceParams']
            parts.append("\n## Race Parameters (computed from session data)")
            pl = rp.get('pitLoss', {})
            parts.append(f"  Pit stop time loss: {pl.get('mean', '?')}s +/-{pl.get('stdDev', '?')}s")
            sc = rp.get('scRate', 0)
            parts.append(f"  Safety car probability: {sc*100:.1f}% per lap")
            ln = rp.get('lapNoise', 0)
            parts.append(f"  Lap time variance: +/-{ln:.2f}s")
        if ctx.get('driverFeatures'):
            parts.append("\n## Selected Driver Features (current state)")
            for drv, feats in ctx['driverFeatures'].items():
                compound = feats.get('compoundName', '?')
                parts.append(
                    f"  {drv}: P{feats.get('position','?')}, "
                    f"pace {feats.get('recentPace', 0):.1f}s, "
                    f"tyre {compound} (age {feats.get('tyreLife', '?')} laps), "
                    f"trend {feats.get('paceTrend', 0):+.2f}s/lap, "
                    f"est. {feats.get('estLapsToPit', '?')} laps to pit"
                )
        if ctx.get('degradationRegression'):
            deg = ctx['degradationRegression']
            parts.append(f"\n## Tyre Degradation Regression: {json.dumps(deg, default=str)}")

    parts.extend([
        "",
        f"User Question: {request.query}",
        "",
        "Respond with:",
        "1. A clear, actionable strategy recommendation (what to radio to the driver)",
        "2. In a separate JSON block marked ```json, provide strategy scenarios:",
        '[{"id": "scenario_1", "label": "Strategy Name", "driver": "DRIVER_ABBR", '
        '"stints": [{"compound": "MEDIUM", "lap_start": 1, "length": 25}]}]',
        "",
        "Provide 2-3 realistic scenarios grounded in the data above.",
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
    """Generate a context-aware mock Gemini response for development."""
    driver = request.drivers[0] if request.drivers else 'VER'
    current_lap = request.current_lap or 20
    query = request.query.lower()
    ctx = request.race_context or {}

    # Extract useful context for richer mock responses
    projections = ctx.get('monteCarloProjections', [])
    battles = ctx.get('battles', [])
    risks = ctx.get('risks', [])
    features = ctx.get('driverFeatures', {})
    race_params = ctx.get('raceParams', {})

    # Find focused driver's projection
    drv_proj = next((p for p in projections if p['driver'] == driver), None) if projections else None
    pit_loss = race_params.get('pitLoss', {}).get('mean', 22)

    if 'undercut' in query or 'overcut' in query:
        drv_feats = features.get(driver, {})
        tyre_age = drv_feats.get('tyreLife', 15)
        compound = drv_feats.get('compoundName', 'MEDIUM')
        pace_trend = drv_feats.get('paceTrend', 0.05)

        text = (
            f"STRATEGY CALL — Lap {current_lap}\n\n"
            f"{driver} is on {compound} tyres (age: {tyre_age} laps), "
            f"pace trend: {pace_trend:+.2f}s/lap.\n\n"
        )
        if pace_trend > 0.05:
            text += (
                f"Degradation is significant — UNDERCUT recommended.\n"
                f"Pit window: laps {current_lap + 1}-{current_lap + 3}. "
                f"Pit loss is ~{pit_loss:.0f}s.\n"
                f"Switch to HARD compound to extend to the end."
            )
        else:
            text += (
                f"Tyres are still performing well — OVERCUT has potential.\n"
                f"Stay out until lap {current_lap + 5}-{current_lap + 8}, "
                f"gain track position while others pit.\n"
                f"Pit loss is ~{pit_loss:.0f}s."
            )
        if drv_proj:
            exp = drv_proj.get('expectedPos', '?')
            exp_str = f"{exp:.1f}" if isinstance(exp, (int, float)) else str(exp)
            text += f"\n\nMonte Carlo projection: Expected P{exp_str}, podium {drv_proj.get('podiumProb', 0)}%."

        scenarios = [
            {
                'id': 'undercut',
                'label': f'Undercut (Lap {current_lap + 2})',
                'driver': driver,
                'stints': [{'compound': 'HARD', 'lap_start': current_lap + 2, 'length': 30}],
            },
            {
                'id': 'overcut',
                'label': f'Overcut (Lap {current_lap + 7})',
                'driver': driver,
                'stints': [{'compound': 'HARD', 'lap_start': current_lap + 7, 'length': 25}],
            },
        ]

    elif '1-stop' in query or '2-stop' in query or 'compare' in query:
        text = f"STRATEGY COMPARISON — {driver} at lap {current_lap}\n\n"
        text += f"Pit stop time loss: ~{pit_loss:.0f}s per stop.\n\n"
        text += (
            f"1-STOP: Stay on current tyres until lap {current_lap + 12}, "
            f"then HARD to finish. Lower risk, preserves track position.\n\n"
            f"2-STOP: Pit now for MEDIUM (laps {current_lap + 1}-{current_lap + 18}), "
            f"then SOFT for a fast final stint. Higher pace but {pit_loss * 2:.0f}s total pit time."
        )
        if drv_proj:
            text += f"\n\nCurrent MC projection: P{drv_proj.get('modePos', '?')}, range P{drv_proj.get('posRange', ['?','?'])[0]}-P{drv_proj.get('posRange', ['?','?'])[1]}."

        scenarios = [
            {
                'id': 'one_stop',
                'label': '1-Stop (Conservative)',
                'driver': driver,
                'stints': [
                    {'compound': 'HARD', 'lap_start': current_lap + 12, 'length': 25},
                ],
            },
            {
                'id': 'two_stop',
                'label': '2-Stop (Aggressive)',
                'driver': driver,
                'stints': [
                    {'compound': 'MEDIUM', 'lap_start': current_lap + 1, 'length': 18},
                    {'compound': 'SOFT', 'lap_start': current_lap + 19, 'length': 15},
                ],
            },
        ]

    elif 'overtake' in query or 'battle' in query:
        text = f"BATTLE ANALYSIS — Lap {current_lap}\n\n"
        if battles:
            for b in battles[:3]:
                text += (
                    f"{b.get('driver2', '?')} vs {b.get('driver1', '?')}: "
                    f"{b.get('overtakeProb', 0)}% overtake probability "
                    f"({b.get('type', '')})\n"
                )
            text += f"\nRecommendation: "
            top_battle = battles[0]
            if top_battle.get('overtakeProb', 0) >= 50:
                text += f"Attack is likely to succeed. Push now and use tyre advantage."
            else:
                text += f"Hold position and manage tyres. Wait for pit window to gain track position."
        else:
            text += "No significant battles detected at the moment."
        scenarios = []

    elif 'risk' in query or 'danger' in query or 'mitigate' in query:
        text = f"RISK ASSESSMENT — Lap {current_lap}\n\n"
        if risks:
            for r in risks[:3]:
                sev = r.get('severity', 'low').upper()
                text += f"[{sev}] {r.get('driver', '?')}: {r.get('description', r.get('message', ''))}\n"
            text += "\nMitigation: "
            high_risks = [r for r in risks if r.get('severity') == 'high']
            if high_risks:
                text += "Immediate action needed — consider early pit stop to avoid tyre failure or position loss."
            else:
                text += "Monitor situation. No immediate action required."
        else:
            text += "No significant risks identified."
        scenarios = []

    else:
        # General strategy — use all available context
        text = f"STRATEGY BRIEFING — Lap {current_lap}\n\n"

        if drv_proj:
            text += (
                f"{driver}: Currently P{drv_proj.get('currentPos', '?')}, "
                f"projected P{drv_proj.get('modePos', '?')} "
                f"(range P{drv_proj.get('posRange', ['?','?'])[0]}-P{drv_proj.get('posRange', ['?','?'])[1]}). "
                f"Podium probability: {drv_proj.get('podiumProb', 0)}%.\n\n"
            )

        drv_feats = features.get(driver, {})
        if drv_feats:
            text += (
                f"Current state: {drv_feats.get('compoundName', '?')} tyres "
                f"(age {drv_feats.get('tyreLife', '?')} laps), "
                f"pace {drv_feats.get('recentPace', 0):.1f}s, "
                f"trend {drv_feats.get('paceTrend', 0):+.2f}s/lap.\n"
                f"Estimated laps to pit: {drv_feats.get('estLapsToPit', '?')}.\n\n"
            )

        if battles:
            text += "Key battles:\n"
            for b in battles[:2]:
                text += f"  {b.get('driver2', '?')} -> {b.get('driver1', '?')}: {b.get('overtakeProb', 0)}% swap probability\n"
            text += "\n"

        if risks:
            high = [r for r in risks if r.get('severity') == 'high']
            if high:
                text += f"WARNING: {high[0].get('description', high[0].get('message', ''))}\n\n"

        text += (
            f"Recommendation: Pit for HARD tyres in the next 3-5 laps to extend the final stint. "
            f"Pit loss is ~{pit_loss:.0f}s."
        )

        scenarios = [
            {
                'id': 'recommended',
                'label': f'Pit Lap {current_lap + 3}',
                'driver': driver,
                'stints': [{'compound': 'HARD', 'lap_start': current_lap + 3, 'length': 30}],
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
