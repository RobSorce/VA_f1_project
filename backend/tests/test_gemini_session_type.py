"""Gemini request session type: the
frontend sends the type of the session on screen; outside race sessions
('R', 'S') neither the prompt nor the mock response carries a pit loss
(api/routers/gemini.py). A request without a type keeps the race behaviour."""
import re

import pytest

from api.routers.gemini import (
    GeminiRequest, _build_prompt, _is_race_session, _mock_response,
)

FALLBACK = {'median': 22, 'mean': 22, 'stdDev': 2.5, 'n': 0, 'source': 'fallback'}
RACE = {'median': 26.806, 'mean': 27.632, 'stdDev': 4.347, 'p10': 23.46, 'p90': 34.266,
        'n': 30, 'source': 'race'}
QUERIES = [
    'compare strategy options',   # strategy comparison branch
    'undercut on the car ahead?',  # undercut / overcut branch
    'overcut?',
    'pit now or extend?',          # pit decision branch
    'how is it going?',            # general branch
]
PIT_LOSS = re.compile(r'pit loss', re.IGNORECASE)


def request(session_type, query='q', pit_loss=FALLBACK, pace_trend=0.0):
    ctx = {
        'raceParams': {'pitLoss': pit_loss, 'scRate': 0.02},
        'driverFeatures': {'PIA': {'compoundName': 'MEDIUM', 'paceTrend': pace_trend, 'estLapsToPit': 8}},
        'maxLap': 53,
    }
    return GeminiRequest(query=query, drivers=['PIA'], current_lap=20, session_type=session_type,
                         race_context=ctx)


@pytest.mark.parametrize('session_type,race', [
    (None, True), ('', True), ('R', True), ('S', True), ('r', True),
    ('Q', False), ('SQ', False), ('FP', False), ('FP1', False), ('FP2', False), ('FP3', False),
])
def test_race_session_rule(session_type, race):
    assert _is_race_session(session_type) is race


@pytest.mark.parametrize('session_type', ['Q', 'SQ', 'FP', 'FP2'])
def test_prompt_outside_races_carries_no_pit_loss(session_type):
    text = _build_prompt(request(session_type, pit_loss=RACE))
    lines = [line.strip() for line in text.splitlines() if PIT_LOSS.search(line)]
    # the only pit-loss line is the instruction not to use one
    assert len(lines) == 1 and lines[0].startswith('6. This is a ') and 'not a race' in lines[0]
    assert '26.8' not in text and '22.0s' not in text
    assert 'Session type: ' in text
    assert 'Safety car prob: 2.0%/lap' in text  # the rest of the race parameters stays


@pytest.mark.parametrize('session_type', [None, 'R', 'S'])
def test_prompt_in_races_keeps_the_pit_loss(session_type):
    text = _build_prompt(request(session_type, pit_loss=RACE))
    assert 'Pit loss: 26.8s (median of 30 green-flag pit stops measured in this race' in text
    assert 'not a race' not in text


@pytest.mark.parametrize('session_type', ['Q', 'FP2'])
@pytest.mark.parametrize('query', QUERIES)
@pytest.mark.parametrize('pace_trend', [-0.05, 0.0, 0.1])
def test_mock_outside_races_mentions_no_pit_loss(session_type, query, pace_trend):
    mock = _mock_response(request(session_type, query=query, pace_trend=pace_trend))
    assert not PIT_LOSS.search(mock['response'])
    # no time delta derived from a pit loss
    for scenario in mock['scenarios']:
        assert scenario.get('time_delta') in (None, 'baseline')


@pytest.mark.parametrize('session_type', [None, 'R', 'S'])
@pytest.mark.parametrize('query', QUERIES)
def test_mock_in_races_keeps_the_pit_loss(session_type, query):
    text = _mock_response(request(session_type, query=query))['response']
    assert 'Pit loss: ~22s (fallback assumption)' in text


# The Pit Wall "AI Strategist" box (frontend components/ui/GeminiQuickQuery.jsx)
# sends strategyViews.geminiQuickQueryBody: no race context, the focus driver in
# `drivers`, the session type on screen
QUICK_QUERIES = ['Pit window?', 'Strategy?', 'Tyre deg?']


def quick_body(session_type, query):
    return GeminiRequest(**{'query': query, 'year': 2024, 'round': 8, 'session_type': session_type,
                            'drivers': ['NOR'], 'current_lap': 5})


@pytest.mark.parametrize('session_type', ['Q', 'SQ', 'FP', 'FP2'])
@pytest.mark.parametrize('query', QUICK_QUERIES)
def test_quick_query_outside_races_mentions_no_pit_loss(session_type, query):
    req = quick_body(session_type, query)
    mock = _mock_response(req)
    assert not PIT_LOSS.search(mock['response'])
    for scenario in mock['scenarios']:
        assert scenario.get('time_delta') in (None, 'baseline')
    assert 'not a race' in _build_prompt(req)


@pytest.mark.parametrize('session_type', ['R', 'S'])
@pytest.mark.parametrize('query', QUICK_QUERIES)
def test_quick_query_in_races_keeps_the_pit_loss(session_type, query):
    req = quick_body(session_type, query)
    assert req.drivers == ['NOR']
    assert 'Pit loss: ~22s (fallback assumption)' in _mock_response(req)['response']


# The Monte Carlo header carries the run count the frontend used
# (raceContext.monteCarloSimulations = raceProjection.numSimulations), never a
# fixed number
@pytest.mark.parametrize('sent,header', [
    (1000, '## Monte Carlo Race Predictions (1,000 simulations)'),
    (10000, '## Monte Carlo Race Predictions (10,000 simulations)'),
    (None, '## Monte Carlo Race Predictions'),
])
def test_prompt_monte_carlo_run_count(sent, header):
    ctx = {'monteCarloProjections': [{'driver': 'PIA', 'currentPos': 2, 'expectedPos': 2.4,
                                      'posRange': [1, 4], 'podiumProb': 81, 'pointsProb': 100}]}
    if sent is not None:
        ctx['monteCarloSimulations'] = sent
    text = _build_prompt(GeminiRequest(query='q', session_type='R', race_context=ctx))
    lines = [line for line in text.splitlines() if line.startswith('## Monte Carlo')]
    assert lines == [header]
    assert '100 simulations' not in text
