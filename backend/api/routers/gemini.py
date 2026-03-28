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
    """Generate a context-aware mock strategy response from race data."""
    driver = request.drivers[0] if request.drivers else 'VER'
    current_lap = request.current_lap or 20
    query = request.query.lower()
    ctx = request.race_context or {}

    # Extract race context
    projections = ctx.get('monteCarloProjections', [])
    battles = ctx.get('battles', [])
    risks = ctx.get('risks', [])
    features = ctx.get('driverFeatures', {})
    race_params = ctx.get('raceParams', {})

    drv_feats = features.get(driver, {})
    drv_proj = next((p for p in projections if p['driver'] == driver), None) if projections else None
    pit_loss = race_params.get('pitLoss', {}).get('mean', 22)
    max_lap = 57  # reasonable default
    if drv_proj and drv_proj.get('posRange'):
        pass  # we have projections

    # Current driver state
    compound = drv_feats.get('compoundName', 'MEDIUM')
    tyre_age = drv_feats.get('tyreLife', 15)
    pace_trend = drv_feats.get('paceTrend', 0.05)
    est_pit = drv_feats.get('estLapsToPit', 10)
    position = drv_feats.get('position', 5)
    recent_pace = drv_feats.get('recentPace', 92.0)
    laps_remaining = max(max_lap - current_lap, 10)

    # Current projected position
    cur_proj_pos = position
    if drv_proj:
        cur_proj_pos = drv_proj.get('expectedPos', position)
        if isinstance(cur_proj_pos, float):
            cur_proj_pos = round(cur_proj_pos)

    # ── Strategy comparison (primary use case) ──
    if 'compare' in query or 'strategy' in query or 'option' in query or 'optimal' in query or 'best' in query:
        # Build 3 data-driven strategies based on current state
        pit_lap_early = current_lap + max(2, min(est_pit - 3, 5))
        pit_lap_std = current_lap + max(5, min(est_pit, 12))
        pit_lap_late = current_lap + max(10, min(est_pit + 5, laps_remaining - 8))

        # Choose next compound intelligently
        next_compound = 'HARD' if compound in ('SOFT', 'MEDIUM') else 'MEDIUM'
        aggr_compound = 'SOFT' if compound == 'HARD' else 'MEDIUM'

        # Strategy A: Conservative 1-stop
        strat_a_proj = cur_proj_pos  # hold position
        strat_a_risk = 'low'
        strat_a_stints = [
            {'compound': compound, 'lap_start': 1, 'length': pit_lap_std - 1},
            {'compound': 'HARD', 'lap_start': pit_lap_std, 'length': max_lap - pit_lap_std + 1},
        ]

        # Strategy B: Aggressive undercut
        strat_b_proj = max(1, cur_proj_pos - 1)  # gain 1 position
        strat_b_risk = 'medium'
        strat_b_stints = [
            {'compound': compound, 'lap_start': 1, 'length': pit_lap_early - 1},
            {'compound': next_compound, 'lap_start': pit_lap_early, 'length': max_lap - pit_lap_early + 1},
        ]

        # Strategy C: 2-stop aggressive
        second_stop = pit_lap_early + int(laps_remaining * 0.55)
        strat_c_proj = max(1, cur_proj_pos - 2) if pace_trend < 0.1 else cur_proj_pos + 1
        strat_c_risk = 'high'
        strat_c_stints = [
            {'compound': compound, 'lap_start': 1, 'length': pit_lap_early - 1},
            {'compound': 'MEDIUM', 'lap_start': pit_lap_early, 'length': second_stop - pit_lap_early},
            {'compound': 'SOFT', 'lap_start': second_stop, 'length': max_lap - second_stop + 1},
        ]

        text = (
            f"STRATEGY ANALYSIS — {driver} at Lap {current_lap}\n\n"
            f"Current: P{position}, {compound} tyres ({tyre_age} laps), "
            f"pace {recent_pace:.1f}s, trend {pace_trend:+.2f}s/lap.\n"
            f"Pit loss: ~{pit_loss:.0f}s. Estimated tyre life remaining: ~{est_pit} laps.\n\n"
        )

        if pace_trend > 0.08:
            text += (
                f"RECOMMENDATION: Tyres are degrading significantly ({pace_trend:+.2f}s/lap). "
                f"Early pit (Strategy B) recommended to undercut rivals. "
                f"Pit window: laps {pit_lap_early}-{pit_lap_early + 2}.\n"
            )
        elif pace_trend < -0.02:
            text += (
                f"RECOMMENDATION: Pace is improving — tyres still in good shape. "
                f"Extend the stint (Strategy A) and overcut. "
                f"Target pit: lap {pit_lap_std}.\n"
            )
        else:
            text += (
                f"RECOMMENDATION: Pace is stable. Standard pit window (lap {pit_lap_std}) "
                f"is optimal. Consider 2-stop only if safety car opportunity arises.\n"
            )

        if battles:
            b = battles[0]
            text += (
                f"\nBattle factor: {b.get('driver2', '?')} vs {b.get('driver1', '?')} — "
                f"{b.get('overtakeProb', 0)}% position swap probability."
            )

        scenarios = [
            {
                'id': 'conservative',
                'label': f'1-Stop Standard (L{pit_lap_std})',
                'driver': driver,
                'risk': strat_a_risk,
                'projected_position': strat_a_proj,
                'total_stops': 1,
                'time_delta': 'baseline',
                'stints': strat_a_stints,
            },
            {
                'id': 'undercut',
                'label': f'1-Stop Undercut (L{pit_lap_early})',
                'driver': driver,
                'risk': strat_b_risk,
                'projected_position': strat_b_proj,
                'total_stops': 1,
                'time_delta': f'-{pit_loss * 0.3:.0f}s',
                'stints': strat_b_stints,
            },
            {
                'id': 'aggressive',
                'label': f'2-Stop Aggressive',
                'driver': driver,
                'risk': strat_c_risk,
                'projected_position': strat_c_proj,
                'total_stops': 2,
                'time_delta': f'+{pit_loss * 0.7:.0f}s' if pace_trend > 0.05 else f'-{pit_loss * 0.2:.0f}s',
                'stints': strat_c_stints,
            },
        ]

    # ── Undercut / overcut analysis ──
    elif 'undercut' in query or 'overcut' in query:
        pit_now = current_lap + 2
        pit_late = current_lap + max(5, est_pit)
        next_compound = 'HARD' if compound in ('SOFT', 'MEDIUM') else 'MEDIUM'

        if pace_trend > 0.05:
            recommendation = "UNDERCUT"
            text = (
                f"UNDERCUT RECOMMENDED — {driver}, Lap {current_lap}\n\n"
                f"Degradation: {pace_trend:+.2f}s/lap on {compound} (age {tyre_age}).\n"
                f"Pit lap {pit_now} for {next_compound}. Pit loss ~{pit_loss:.0f}s.\n"
                f"Expected to gain track position during rivals' stops."
            )
        else:
            recommendation = "OVERCUT"
            text = (
                f"OVERCUT VIABLE — {driver}, Lap {current_lap}\n\n"
                f"Tyres performing well ({pace_trend:+.2f}s/lap). Stay out.\n"
                f"Extend to lap {pit_late}, gain time while others pit.\n"
                f"Pit loss ~{pit_loss:.0f}s."
            )

        scenarios = [
            {
                'id': 'undercut',
                'label': f'Undercut (Lap {pit_now})',
                'driver': driver,
                'risk': 'medium',
                'projected_position': max(1, cur_proj_pos - 1),
                'total_stops': 1,
                'stints': [
                    {'compound': compound, 'lap_start': 1, 'length': pit_now - 1},
                    {'compound': next_compound, 'lap_start': pit_now, 'length': max_lap - pit_now + 1},
                ],
            },
            {
                'id': 'overcut',
                'label': f'Overcut (Lap {pit_late})',
                'driver': driver,
                'risk': 'low' if pace_trend < 0.05 else 'high',
                'projected_position': cur_proj_pos,
                'total_stops': 1,
                'stints': [
                    {'compound': compound, 'lap_start': 1, 'length': pit_late - 1},
                    {'compound': next_compound, 'lap_start': pit_late, 'length': max_lap - pit_late + 1},
                ],
            },
        ]

    # ── Pit now or extend ──
    elif 'pit' in query and ('now' in query or 'extend' in query):
        text = (
            f"PIT DECISION — {driver}, Lap {current_lap}\n\n"
            f"Current: {compound} (age {tyre_age}), pace trend {pace_trend:+.2f}s/lap.\n"
            f"Est. remaining tyre life: {est_pit} laps. Pit loss: ~{pit_loss:.0f}s.\n\n"
        )
        if est_pit <= 3 or pace_trend > 0.1:
            text += "BOX BOX BOX. Tyres are done. Pit this lap or next."
        elif est_pit <= 6:
            text += f"Pit window is open. Target lap {current_lap + 2}-{current_lap + 4}."
        else:
            text += f"Stay out. Tyres have {est_pit} laps remaining. Monitor pace."

        pit_lap = current_lap + 1
        extend_lap = current_lap + est_pit
        next_compound = 'HARD' if compound in ('SOFT', 'MEDIUM') else 'MEDIUM'
        scenarios = [
            {
                'id': 'pit_now',
                'label': f'Pit Now (Lap {pit_lap})',
                'driver': driver,
                'risk': 'low',
                'projected_position': cur_proj_pos,
                'total_stops': 1,
                'stints': [
                    {'compound': compound, 'lap_start': 1, 'length': pit_lap - 1},
                    {'compound': next_compound, 'lap_start': pit_lap, 'length': max_lap - pit_lap + 1},
                ],
            },
            {
                'id': 'extend',
                'label': f'Extend to Lap {extend_lap}',
                'driver': driver,
                'risk': 'high' if pace_trend > 0.08 else 'medium',
                'projected_position': cur_proj_pos + (1 if pace_trend > 0.08 else 0),
                'total_stops': 1,
                'stints': [
                    {'compound': compound, 'lap_start': 1, 'length': extend_lap - 1},
                    {'compound': next_compound, 'lap_start': extend_lap, 'length': max_lap - extend_lap + 1},
                ],
            },
        ]

    # ── Battle / overtake / defend ──
    elif 'attack' in query or 'defend' in query or 'overtake' in query or 'battle' in query or ' vs ' in query:
        text = f"BATTLE ANALYSIS — {driver}, Lap {current_lap}\n\n"
        if battles:
            for b in battles[:3]:
                text += (
                    f"{b.get('driver2', '?')} vs {b.get('driver1', '?')}: "
                    f"{b.get('overtakeProb', 0)}% swap probability "
                    f"({b.get('type', '')})\n"
                )
            top = battles[0]
            if top.get('overtakeProb', 0) >= 50:
                text += f"\nPUSH NOW — high probability of success. Use tyre advantage."
            else:
                text += f"\nHOLD POSITION — manage tyres, use pit strategy to gain."
        else:
            text += "No significant battles around your driver."
        scenarios = []

    # ── Risk / mitigate ──
    elif 'risk' in query or 'mitigate' in query:
        text = f"RISK ASSESSMENT — {driver}, Lap {current_lap}\n\n"
        if risks:
            for r in risks[:3]:
                sev = r.get('severity', 'low').upper()
                text += f"[{sev}] {r.get('driver', '?')}: {r.get('description', r.get('message', ''))}\n"
            high = [r for r in risks if r.get('severity') == 'high']
            text += f"\nMitigation: {'Early pit recommended.' if high else 'Monitor — no immediate action needed.'}"
        else:
            text += "No significant risks identified."
        scenarios = []

    # ── General / fallback ──
    else:
        text = f"STRATEGY BRIEFING — {driver}, Lap {current_lap}\n\n"
        text += f"P{position}, {compound} tyres (age {tyre_age}), pace {recent_pace:.1f}s, trend {pace_trend:+.2f}s/lap.\n"
        if drv_proj:
            exp = drv_proj.get('expectedPos', '?')
            exp_str = f"{exp:.1f}" if isinstance(exp, (int, float)) else str(exp)
            text += f"MC projection: P{exp_str}, podium {drv_proj.get('podiumProb', 0)}%.\n"
        text += f"Est. laps to pit: {est_pit}. Pit loss: ~{pit_loss:.0f}s.\n\n"

        if battles:
            b = battles[0]
            text += f"Battle: {b.get('driver2','?')} vs {b.get('driver1','?')} ({b.get('overtakeProb',0)}% swap)\n"

        pit_target = current_lap + max(3, min(est_pit, 10))
        next_compound = 'HARD' if compound in ('SOFT', 'MEDIUM') else 'MEDIUM'
        text += f"\nRecommendation: Pit for {next_compound} around lap {pit_target}."

        scenarios = [
            {
                'id': 'recommended',
                'label': f'Pit Lap {pit_target} ({next_compound})',
                'driver': driver,
                'risk': 'low',
                'projected_position': cur_proj_pos,
                'total_stops': 1,
                'stints': [
                    {'compound': compound, 'lap_start': 1, 'length': pit_target - 1},
                    {'compound': next_compound, 'lap_start': pit_target, 'length': max_lap - pit_target + 1},
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
