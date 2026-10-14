"""The heuristic assistant's strategy cards (api/routers/gemini.py
_mock_response, rendered as 'Finish P{n}' by GeminiAssistant.jsx) read the
finishing position the Race Prediction panel labels: medianPos, which the
store moves only beyond the Monte Carlo error (decision D5). The raw mean
(expectedPos) moves on Monte Carlo noise alone, so two seeds of the same
state gave different cards (2024 R10 lap 17, BOT: expectedPos 8.5 -> 8.8,
cards P8/P7/P6 -> P9/P8/P7 while the panel stayed P8). The rounded mean is
only the fallback of a client that sends no medianPos. Measured over every
cached race in notes/experiments/phase45c/repair_r2/s4_assistant_cards.txt
(backend/scripts/s4_assistant_cards.py)."""
import pytest

from api.routers.gemini import GeminiRequest, _build_prompt, _mock_response, _projected_position

QUERIES = ['compare strategy options', 'undercut?', 'pit now or extend?', 'attack or defend?', 'risk?',
           'how is it going?']


def ctx(expected, median=None):
    row = {'driver': 'BOT', 'currentPos': 9, 'expectedPos': expected, 'posRange': [5, 13],
           'podiumProb': 1, 'pointsProb': 64}
    if median is not None:
        row['medianPos'] = median
    return {'maxLap': 71,
            'monteCarloProjections': [row],
            'driverFeatures': {'BOT': {'position': 9, 'recentPace': 77.4, 'compoundName': 'MEDIUM',
                                       'tyreLife': 16, 'paceTrend': 0.02, 'estLapsToPit': 9}}}


def cards(query, context):
    req = GeminiRequest(query=query, drivers=['BOT'], current_lap=17, session_type='R', race_context=context)
    return [s['projected_position'] for s in _mock_response(req)['scenarios']]


def test_projected_position_is_the_panel_label():
    assert _projected_position({'medianPos': 8, 'expectedPos': 8.8}) == 8
    # an older client: the rounded mean
    assert _projected_position({'expectedPos': 8.8}) == 9
    assert _projected_position({'medianPos': None, 'expectedPos': 8.4}) == 8
    assert _projected_position({}) is None
    assert _projected_position(None) is None


@pytest.mark.parametrize('query', QUERIES)
def test_cards_hold_on_a_reseed_of_the_same_state(query):
    """Same state, two seeds: the mean moved (8.5 -> 8.8), the panel's P8 did
    not, and neither does any card."""
    assert cards(query, ctx(8.5, 8)) == cards(query, ctx(8.8, 8))


def test_hold_position_card_is_the_panel_label():
    standard, undercut, two_stop = cards('compare strategy options', ctx(8.8, 8))
    assert standard == 8
    assert undercut == 7
    assert two_stop == 6
    # without medianPos the cards fall back on the rounded mean
    assert cards('compare strategy options', ctx(8.8))[0] == 9


def test_prompt_and_briefing_name_the_panel_label():
    request = GeminiRequest(query='how is it going?', drivers=['BOT'], current_lap=17, session_type='R',
                            race_context=ctx(8.8, 8))
    assert 'BOT: P9 → Projected P8, Expected P8.8 (range P5-P13)' in _build_prompt(request)
    assert 'MC projection: P8 (mean P8.8), podium 1%.' in _mock_response(request)['response']
    # an older client sends no medianPos: no 'Projected' figure is invented
    old = GeminiRequest(query='q', drivers=['BOT'], session_type='R', race_context=ctx(8.8))
    assert 'Projected' not in _build_prompt(old)
