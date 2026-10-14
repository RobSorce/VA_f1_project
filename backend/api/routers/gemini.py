"""
Gemini AI Strategy Integration
Compiles race state into Gemini prompts and parses strategy responses.
"""
import asyncio
import os
import json
import logging
import math
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
    # Type of the session on screen: 'R', 'S', 'Q', 'SQ', 'FP1'-'FP3' or 'FP'
    # (frontend utils/strategyViews.js viewSessionType)
    session_type: Optional[str] = None
    current_lap: Optional[int] = None
    drivers: Optional[List[str]] = None
    lstm_predictions: Optional[Dict[str, Any]] = None
    race_context: Optional[Dict[str, Any]] = None


# Pit loss used by the mock when the client sends none: the same assumption as
# FALLBACK_PIT_LOSS.median in frontend/src/utils/pitLoss.js. Not data; every
# text that uses it labels it as a fallback.
FALLBACK_PIT_LOSS_S = 22.0

# Values the heuristic fallback (_mock_response) places its scenario laps
# with when the client sent none. ASSUMPTION kept from the previous mock, not
# data: the response text shows '?' for every value the client did not send.
HEURISTIC_DEFAULTS = {
    'current_lap': 20, 'max_lap': 57, 'compound': 'MEDIUM', 'pace_trend': 0.05,
    'est_laps_to_pit': 10, 'position': 5,
}

# Session types with a race pit loss: race and sprint. Same rule as
# isRaceSession in frontend/src/utils/pitLoss.js: a request without a type
# counts as a race (clients that predate the field sent race context only).
RACE_SESSION_TYPES = {'R', 'S'}

SESSION_TYPE_NAMES = {
    'R': 'Race', 'S': 'Sprint', 'Q': 'Qualifying', 'SQ': 'Sprint Qualifying',
    'FP': 'Practice', 'FP1': 'Practice 1', 'FP2': 'Practice 2', 'FP3': 'Practice 3',
}


def _is_race_session(session_type) -> bool:
    """True for a race-type session ('R', 'S') or when no type was sent."""
    if session_type is None or str(session_type).strip() == '':
        return True
    return str(session_type).strip().upper() in RACE_SESSION_TYPES


def _session_type_name(session_type) -> str:
    code = str(session_type).strip().upper()
    return SESSION_TYPE_NAMES.get(code, code)


def _finite(value):
    """float(value) for a finite int/float, else None (None, NaN, bool, strings)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return f if math.isfinite(f) else None


def _fmt(value, spec='', missing='?'):
    """value formatted with spec when it is a finite number, else `missing`.
    The client sends null for a value it does not know, and formatting None
    with a spec raised (a 500 for the whole request)."""
    f = _finite(value)
    if f is None:
        return missing
    if spec == '' and f.is_integer():
        return str(int(f))
    return format(f, spec)


def _txt(value, missing='?'):
    """str(value), or `missing` for None / ''."""
    return missing if value is None or value == '' else str(value)


def _dict(value) -> dict:
    """value when it is a dict, else {} (a null or malformed context field)."""
    return value if isinstance(value, dict) else {}


def _list(value) -> list:
    """value when it is a list, else []."""
    return value if isinstance(value, list) else []


def _projected_position(proj) -> int | None:
    """The finishing position of one Monte Carlo row as the Race Prediction
    panel labels it: medianPos (the median simulated position, moved only
    beyond the Monte Carlo error, so a same-state recompute with another seed
    keeps it; decision D5). The rounded mean (expectedPos) only for a client
    that sends no medianPos: the mean moves on Monte Carlo noise alone, so a
    card derived from it changed between two seeds of the same state."""
    proj = _dict(proj)
    median = _finite(proj.get('medianPos'))
    if median is not None:
        return int(round(median))
    expected = _finite(proj.get('expectedPos'))
    return int(round(expected)) if expected is not None else None


def _pit_loss_info(race_params) -> dict:
    """Pit-loss point estimate and provenance from the frontend raceParams.

    raceParams.pitLoss is the estimatePitLoss object of
    frontend/src/utils/pitLoss.js: {median, mean, stdDev, p10, p90, n,
    source: 'race' | 'fallback'}. median is the point estimate; mean is read
    only when median is missing (older clients). Any field may be absent/None.

    Returns {value, stat, source, n, p10, p90, std}: value None when no usable
    number was sent; stat 'median' or 'mean' (which field gave value); source
    'race' (measured from this race's green-flag stops), 'fallback' (the
    client's assumption, no qualifying stop yet) or None (not stated).
    """
    pl = race_params.get('pitLoss') if isinstance(race_params, dict) else None
    if not isinstance(pl, dict):
        pl = {}
    value, stat = _finite(pl.get('median')), 'median'
    if value is None:
        value, stat = _finite(pl.get('mean')), 'mean'
    n = _finite(pl.get('n'))
    return {
        'value': value,
        'stat': stat if value is not None else None,
        'source': pl.get('source') if pl.get('source') in ('race', 'fallback') else None,
        'n': int(n) if n is not None else None,
        'p10': _finite(pl.get('p10')),
        'p90': _finite(pl.get('p90')),
        'std': _finite(pl.get('stdDev')),
    }


def _pit_loss_line(info: dict) -> str:
    """Prompt line for the pit loss, with where the number comes from."""
    if info['value'] is None:
        return "Pit loss: no data"
    line = f"Pit loss: {info['value']:.1f}s"
    if info['source'] == 'race':
        stops = f"{info['n']} " if info['n'] is not None else ""
        details = [f"{info['stat']} of {stops}green-flag pit stops measured in this race"]
        if info['p10'] is not None and info['p90'] is not None:
            details.append(f"p10-p90 {info['p10']:.1f}-{info['p90']:.1f}s")
        if info['std'] is not None:
            details.append(f"sd {info['std']:.1f}s")
        line += f" ({', '.join(details)})"
    elif info['source'] == 'fallback':
        line += " (FALLBACK assumption, not race data: no green-flag pit stop measured in this race yet)"
    else:
        line += f" ({info['stat']}, source not stated)"
    return line


def _build_prompt(request: GeminiRequest) -> str:
    """Build a structured prompt for Gemini with full race intelligence.

    Outside race sessions (request.session_type not 'R' / 'S') there is no
    race pit loss: the prompt carries none and tells the model not to use one.
    """
    is_race = _is_race_session(request.session_type)
    numbers_rule = (
        "2. Always reference specific numbers to justify recommendations (e.g. 'pace trend +0.08s/lap', "
        "the pit loss given under Race Parameters, saying whether it is measured or a fallback)."
        if is_race else
        "2. Always reference specific numbers to justify recommendations (e.g. 'pace trend +0.08s/lap')."
    )
    parts = [
        "You are a senior F1 race strategy engineer with access to live analytical data. "
        "Your job is to give clear, actionable strategy calls that a race engineer could "
        "radio to the driver.",
        "",
        "CRITICAL RULES:",
        "1. ONLY use the data provided below. NEVER invent lap times, positions, or probabilities.",
        numbers_rule,
        "3. If the data for a topic is missing, say 'I don't have data for this' — do NOT guess.",
        "4. Structure your response around actionable decisions: when to pit, which compound, how to handle battles.",
        "5. Be concise and decisive. No filler or hedging.",
    ]
    if not is_race:
        parts.append(
            f"6. This is a {_session_type_name(request.session_type)} session, not a race: "
            "there is no race pit loss. Do not quote or estimate a pit loss or the race time a stop costs."
        )
    parts.append("")

    # Every context field may be null or missing (the client sends null for
    # what it does not know): read through _dict / _list / _fmt / _txt
    ctx = _dict(request.race_context)

    # Race header
    if request.year:
        parts.append(f"Race: {request.year} Round {_txt(request.round)}")
    if request.session_type:
        parts.append(f"Session type: {_session_type_name(request.session_type)}")
    lap = _finite(request.current_lap) or _finite(ctx.get('currentLap'))
    max_lap = _finite(ctx.get('maxLap'))
    if lap:
        remaining = f", {_fmt(max_lap - lap)} laps remaining" if max_lap and max_lap > lap else ""
        parts.append(f"Current Lap: {_fmt(lap)}/{_fmt(max_lap)}{remaining}")
    focus = ctx.get('focusDriver')
    selected = _list(ctx.get('selectedDrivers')) or _list(request.drivers)
    if focus:
        parts.append(f"Focus Driver: {focus}")
    if selected:
        parts.append(f"Selected Drivers: {', '.join(_txt(d) for d in selected)}")

    # Session & weather
    if _dict(ctx.get('session')):
        s = ctx['session']
        parts.append(f"\n## Session: {_txt(s.get('EventName'))} — {_txt(s.get('SessionName'))}")
    if _dict(ctx.get('weather')):
        w = ctx['weather']
        parts.append(f"Weather: {_fmt(w.get('AirTemp'))}°C air, {_fmt(w.get('TrackTemp'))}°C track, "
                      f"rain {_txt(w.get('Rainfall'), 'no')}, humidity {_fmt(w.get('Humidity'))}%")

    # Driver features (live PCA-derived)
    if _dict(ctx.get('driverFeatures')):
        parts.append("\n## Driver State (live features)")
        for drv, feats in ctx['driverFeatures'].items():
            feats = _dict(feats)
            parts.append(
                f"  {drv}: P{_fmt(feats.get('position'))}, "
                f"pace {_fmt(feats.get('recentPace'), '.1f')}s, "
                f"tyre {_txt(feats.get('compoundName'))} (age {_fmt(feats.get('tyreLife'))} laps), "
                f"trend {_fmt(feats.get('paceTrend'), '+.2f')}s/lap, "
                f"est. {_fmt(feats.get('estLapsToPit'))} laps to pit"
            )

    # Recent lap times
    if _list(ctx.get('recentLaps')):
        parts.append(f"\n## Recent Laps ({focus or '?'})")
        for lt in map(_dict, ctx['recentLaps']):
            sectors = ""
            if all(_finite(lt.get(k)) is not None for k in ('s1', 's2', 's3')):
                sectors = f" [S1:{lt['s1']:.1f} S2:{lt['s2']:.1f} S3:{lt['s3']:.1f}]"
            parts.append(
                f"  L{_fmt(lt.get('lap'))}: {_fmt(lt.get('time'), '.3f')}s on {_txt(lt.get('compound'))} "
                f"(tyre age {_fmt(lt.get('tyreLife'))}){sectors}"
            )

    # Tyre strategy history
    if _dict(ctx.get('tyreStrategy')):
        parts.append("\n## Tyre Strategy (stints completed)")
        for drv, stints in ctx['tyreStrategy'].items():
            stint_str = " → ".join(
                f"{_txt(s.get('compound'))}(L{_fmt(s.get('startLap'))}, {_fmt(s.get('length'))}laps)"
                for s in map(_dict, _list(stints))
            )
            parts.append(f"  {drv}: {stint_str}")

    # Lap-time forecast of the focus driver (context key 'lstm'): named by the
    # method that made it (the method chosen on the validation races, not
    # always the LSTM), each time at its target lap, with its held-out MAE
    if _dict(ctx.get('lstm')):
        lstm = ctx['lstm']
        method = _txt(lstm.get('methodLabel') or lstm.get('method'), 'LSTM')
        origin = _finite(lstm.get('originLap'))
        since = f", from lap {int(origin)}" if origin is not None else ""
        parts.append(f"\n## Lap-time forecast ({_txt(lstm.get('driver'))}, method: {method}{since})")
        targets = _list(lstm.get('targetLaps'))
        for i, t in enumerate(_list(lstm.get('predictedTimes'))):
            lap = _finite(targets[i]) if i < len(targets) else None
            parts.append(f"  Lap {int(lap)}: {_fmt(t, '.3f')}s" if lap is not None else f"  Lap +{i+1}: {_fmt(t, '.3f')}s")
        mae = _finite(lstm.get('heldOutMae'))
        if mae is not None:
            parts.append(f"  Held-out MAE of this method: {mae:.3f}s per lap")
        pit_prob = _finite(lstm.get('pitProbability'))
        if pit_prob is not None:
            parts.append(f"  Pit probability: {pit_prob*100:.0f}%")
    elif request.lstm_predictions:
        parts.append("\n## LSTM Lap Time Predictions")
        parts.append(json.dumps(request.lstm_predictions, default=str, indent=2))

    # Monte Carlo projections
    if _list(ctx.get('monteCarloProjections')):
        # the run count the frontend used (raceProjection.numSimulations); no
        # count is printed when an older client sends none
        n_sims = _finite(ctx.get('monteCarloSimulations'))
        runs = f" ({int(n_sims):,} simulations)" if n_sims and n_sims > 0 else ""
        parts.append(f"\n## Monte Carlo Race Predictions{runs}")
        for p in map(_dict, ctx['monteCarloProjections']):
            r = _list(p.get('posRange')) + [None, None]
            # the panel's finishing position (medianPos), then the mean
            projected = (f"Projected P{_fmt(p.get('medianPos'))}, "
                         if _finite(p.get('medianPos')) is not None else "")
            parts.append(
                f"  {_txt(p.get('driver'))}: P{_fmt(p.get('currentPos'))} → {projected}"
                f"Expected P{_fmt(p.get('expectedPos'), '.1f')} (range P{_fmt(r[0])}-P{_fmt(r[1])}), "
                f"Podium: {_fmt(p.get('podiumProb'))}%, Points: {_fmt(p.get('pointsProb'))}%"
            )
    if _list(ctx.get('battles')):
        parts.append("\n## Battles (overtake probabilities)")
        for b in map(_dict, ctx['battles']):
            parts.append(
                f"  {_txt(b.get('driver2'))} vs {_txt(b.get('driver1'))}: "
                f"{_fmt(b.get('overtakeProb'))}% swap ({_txt(b.get('type'), '')})"
            )
    if _list(ctx.get('risks')):
        parts.append("\n## Risk Alerts")
        for r in map(_dict, ctx['risks']):
            parts.append(
                f"  [{_txt(r.get('severity')).upper()}] {_txt(r.get('driver'))}: "
                f"{_txt(r.get('description') or r.get('message'), '')}"
            )

    # Race parameters (pit loss in race sessions only)
    if ctx.get('raceParams'):
        rp = ctx['raceParams']
        rp_lines = [f"  {_pit_loss_line(_pit_loss_info(rp))}"] if is_race else []
        sc = _finite(rp.get('scRate')) if isinstance(rp, dict) else None
        if sc is not None:
            rp_lines.append(f"  Safety car prob: {sc*100:.1f}%/lap")
        if rp_lines:
            parts.append(f"\n## Race Parameters")
            parts.extend(rp_lines)

    # Degradation regression
    if ctx.get('degradationRegression'):
        deg = ctx['degradationRegression']
        parts.append(f"\n## Tyre Degradation: {json.dumps(deg, default=str)}")

    # Simulator what-if
    if _dict(ctx.get('simulator')):
        sim = ctx['simulator']
        parts.append(f"\n## Strategy Simulator Result")
        parts.append(f"  Custom strategy → P{_txt(sim.get('customPos'))}")
        parts.append(f"  Baseline → P{_txt(sim.get('baselinePos'))}")
        parts.append(f"  Delta: {_txt(sim.get('delta'))}")

    # PCA strategy patterns
    if _list(ctx.get('pcaPatterns')):
        parts.append(f"\n## Historical Strategy Patterns (PCA cluster analysis)")
        for i, pat in enumerate(ctx['pcaPatterns']):
            parts.append(f"  Pattern {i+1}: {json.dumps(pat, default=str)}")

    # Rival context
    if _list(ctx.get('rivals')):
        parts.append(f"\n## Rival Context")
        for r in ctx['rivals']:
            parts.append(f"  {json.dumps(r, default=str)}")

    parts.extend([
        "",
        f"User Question: {request.query}",
        "",
        "Respond with:",
        "1. A clear, actionable strategy recommendation referencing specific data points above.",
        "2. In a separate JSON block marked ```json, provide 2-3 strategy scenarios:",
        '[{"id": "scenario_1", "label": "Strategy Name", "driver": "DRIVER_ABBR", '
        '"stints": [{"compound": "MEDIUM", "lap_start": 1, "length": 25}]}]',
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
    """Heuristic strategy response from the race context the client sent
    (the fallback when Gemini cannot be called: rules on the pace trend and
    the estimated laps to the stop, not a model and not Gemini).

    Every context value may be null or missing: the text shows '?' for a
    value the client did not send, and the scenario laps are placed with
    HEURISTIC_DEFAULTS instead."""
    D = HEURISTIC_DEFAULTS
    driver = request.drivers[0] if request.drivers else 'VER'
    query = request.query.lower()
    ctx = _dict(request.race_context)

    # Extract race context
    projections = [_dict(p) for p in _list(ctx.get('monteCarloProjections'))]
    battles = [_dict(b) for b in _list(ctx.get('battles'))]
    risks = [_dict(r) for r in _list(ctx.get('risks'))]
    features = _dict(ctx.get('driverFeatures'))
    race_params = _dict(ctx.get('raceParams'))

    drv_feats = _dict(features.get(driver))
    drv_proj = next((p for p in projections if p.get('driver') == driver), None)
    # Pit loss: the race median when the client measured one, else a labelled fallback
    pit_info = _pit_loss_info(race_params)
    pit_loss = pit_info['value'] if pit_info['value'] is not None else FALLBACK_PIT_LOSS_S
    if pit_info['value'] is not None and pit_info['source'] == 'race':
        pit_loss_str = f"~{pit_loss:.0f}s (race {pit_info['stat']})"
    elif pit_info['value'] is not None and pit_info['source'] is None:
        pit_loss_str = f"~{pit_loss:.0f}s"
    else:
        pit_loss_str = f"~{pit_loss:.0f}s (fallback assumption)"
    # The pit loss appears in race sessions only (none in qualifying / practice)
    is_race = _is_race_session(request.session_type)
    pit_loss_note = f" Pit loss: {pit_loss_str}." if is_race else ""

    def value(raw, default):
        f = _finite(raw)
        return f if f is not None else default

    current_lap = int(value(request.current_lap, D['current_lap']))
    max_lap = int(value(ctx.get('maxLap'), D['max_lap']))

    # Current driver state: the values computed with, and as shown
    compound_sent = drv_feats.get('compoundName') if isinstance(drv_feats.get('compoundName'), str) else None
    compound = compound_sent or D['compound']
    pace_trend = value(drv_feats.get('paceTrend'), D['pace_trend'])
    est_pit = int(round(value(drv_feats.get('estLapsToPit'), D['est_laps_to_pit'])))
    position = int(value(drv_feats.get('position'), D['position']))
    show_compound = _txt(compound_sent)
    show_age = _fmt(drv_feats.get('tyreLife'))
    show_trend = _fmt(drv_feats.get('paceTrend'), '+.2f')
    show_est = _fmt(drv_feats.get('estLapsToPit'))
    show_pos = _fmt(drv_feats.get('position'))
    show_pace = _fmt(drv_feats.get('recentPace'), '.1f')
    show_lap = _fmt(request.current_lap)
    laps_remaining = max(max_lap - current_lap, 10)

    # Current projected position: the panel's P label (_projected_position),
    # so every card below agrees with the panel and holds on a reseed
    cur_proj_pos = position
    if drv_proj:
        projected = _projected_position(drv_proj)
        if projected is not None:
            cur_proj_pos = projected

    # ── Strategy comparison (primary use case) ──
    if 'compare' in query or 'strategy' in query or 'option' in query or 'optimal' in query or 'best' in query:
        # Three heuristic strategies from the current state
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
            f"STRATEGY ANALYSIS — {driver} at Lap {show_lap}\n\n"
            f"Current: P{show_pos}, {show_compound} tyres ({show_age} laps), "
            f"pace {show_pace}s, trend {show_trend}s/lap.\n"
            f"Estimated tyre life remaining: ~{show_est} laps.{pit_loss_note}\n\n"
        )

        if pace_trend > 0.08:
            text += (
                f"RECOMMENDATION: Tyres are degrading significantly ({show_trend}s/lap). "
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
                f"\nBattle factor: {_txt(b.get('driver2'))} vs {_txt(b.get('driver1'))} — "
                f"{_fmt(b.get('overtakeProb'))}% position swap probability."
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
                'time_delta': f'-{pit_loss * 0.3:.0f}s' if is_race else None,
                'stints': strat_b_stints,
            },
            {
                'id': 'aggressive',
                'label': f'2-Stop Aggressive',
                'driver': driver,
                'risk': strat_c_risk,
                'projected_position': strat_c_proj,
                'total_stops': 2,
                'time_delta': (
                    (f'+{pit_loss * 0.7:.0f}s' if pace_trend > 0.05 else f'-{pit_loss * 0.2:.0f}s')
                    if is_race else None
                ),
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
                f"UNDERCUT RECOMMENDED — {driver}, Lap {show_lap}\n\n"
                f"Degradation: {show_trend}s/lap on {show_compound} (age {show_age}).\n"
                f"Pit lap {pit_now} for {next_compound}.{pit_loss_note}\n"
                f"Expected to gain track position during rivals' stops."
            )
        else:
            recommendation = "OVERCUT"
            text = (
                f"OVERCUT VIABLE — {driver}, Lap {show_lap}\n\n"
                f"Tyres performing well ({show_trend}s/lap). Stay out.\n"
                f"Extend to lap {pit_late}, gain time while others pit.\n"
                f"{pit_loss_note.strip()}"
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
            f"PIT DECISION — {driver}, Lap {show_lap}\n\n"
            f"Current: {show_compound} (age {show_age}), pace trend {show_trend}s/lap.\n"
            f"Est. remaining tyre life: {show_est} laps.{pit_loss_note}\n\n"
        )
        if est_pit <= 3 or pace_trend > 0.1:
            text += "BOX BOX BOX. Tyres are done. Pit this lap or next."
        elif est_pit <= 6:
            text += f"Pit window is open. Target lap {current_lap + 2}-{current_lap + 4}."
        else:
            text += f"Stay out. Tyres have {show_est} laps remaining (estimate). Monitor pace."

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
        text = f"BATTLE ANALYSIS — {driver}, Lap {show_lap}\n\n"
        if battles:
            for b in battles[:3]:
                text += (
                    f"{_txt(b.get('driver2'))} vs {_txt(b.get('driver1'))}: "
                    f"{_fmt(b.get('overtakeProb'))}% swap probability "
                    f"({_txt(b.get('type'), '')})\n"
                )
            top = battles[0]
            if (_finite(top.get('overtakeProb')) or 0) >= 50:
                text += f"\nPUSH NOW — high probability of success. Use tyre advantage."
            else:
                text += f"\nHOLD POSITION — manage tyres, use pit strategy to gain."
        else:
            text += "No significant battles around your driver."
        scenarios = []

    # ── Risk / mitigate ──
    elif 'risk' in query or 'mitigate' in query:
        text = f"RISK ASSESSMENT — {driver}, Lap {show_lap}\n\n"
        if risks:
            for r in risks[:3]:
                sev = _txt(r.get('severity'), 'low').upper()
                text += f"[{sev}] {_txt(r.get('driver'))}: {_txt(r.get('description') or r.get('message'), '')}\n"
            high = [r for r in risks if r.get('severity') == 'high']
            text += f"\nMitigation: {'Early pit recommended.' if high else 'Monitor — no immediate action needed.'}"
        else:
            text += "No significant risks identified."
        scenarios = []

    # ── General / fallback ──
    else:
        text = f"STRATEGY BRIEFING — {driver}, Lap {show_lap}\n\n"
        text += f"P{show_pos}, {show_compound} tyres (age {show_age}), pace {show_pace}s, trend {show_trend}s/lap.\n"
        if drv_proj:
            exp_str = _fmt(drv_proj.get('expectedPos'), '.1f')
            text += (f"MC projection: P{_fmt(_projected_position(drv_proj))} (mean P{exp_str}), "
                     f"podium {_fmt(drv_proj.get('podiumProb'))}%.\n")
        text += f"Est. laps to pit: {show_est}.{pit_loss_note}\n\n"

        if battles:
            b = battles[0]
            text += f"Battle: {_txt(b.get('driver2'))} vs {_txt(b.get('driver1'))} ({_fmt(b.get('overtakeProb'))}% swap)\n"

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

    result = {'response': text, 'scenarios': scenarios, 'is_mock': True}
    return result


# Gemini model of the strategy endpoint
GEMINI_MODEL = 'gemini-2.0-flash'


def _gemini_text(api_key: str, prompt: str):
    """The blocking Gemini call (SDK client + generate_content): run in a
    worker thread by the endpoint, never on the event loop (it held every
    other request and the live WebSocket for the length of the call)."""
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
    return getattr(response, 'text', None)


def _heuristic_fallback(request: GeminiRequest, reason: str) -> dict:
    """The heuristic response (_mock_response) labelled as such: the text
    starts with '[Heuristic fallback, not Gemini: <reason>]' and the fields
    say it (is_mock, is_heuristic, fallback = 'heuristic', fallback_reason)."""
    mock = _mock_response(request)
    mock['response'] = f"[Heuristic fallback, not Gemini: {reason}]\n\n{mock['response']}"
    mock['is_mock'] = True
    mock['is_heuristic'] = True
    mock['fallback'] = 'heuristic'
    mock['fallback_reason'] = reason
    return mock


@router.post("/strategy")
async def gemini_strategy(request: GeminiRequest):
    """Query Gemini for strategy analysis with visual overlay data; the
    labelled heuristic fallback when Gemini cannot answer."""
    api_key = os.environ.get('GEMINI_API_KEY', '')

    if not api_key:
        return _heuristic_fallback(request, 'Gemini AI not configured, set GEMINI_API_KEY in backend/.env')
    if not GEMINI_AVAILABLE:
        return _heuristic_fallback(request, 'google-genai not installed')
    try:
        prompt = _build_prompt(request)
        text = await asyncio.to_thread(_gemini_text, api_key, prompt)
        if not text:
            raise ValueError('Gemini returned no text')
        result = _parse_gemini_response(text)
        result['is_mock'] = False
        result['is_heuristic'] = False
        result['fallback'] = None
        return result
    except Exception as e:
        logger.error(f"Gemini API error: {e}")
        return _heuristic_fallback(request, 'Gemini API unavailable')
