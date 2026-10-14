"""Gemini router fallback (decision D17, B11): the response that is not
Gemini's is labelled heuristic (never 'data-driven'), a null value in the
race context never raises (the client sends null for what it does not
know), and the blocking SDK call runs in a worker thread, not on the event
loop (api/routers/gemini.py). No network: the Gemini client is a fake."""
import asyncio
import threading

import pytest

import api.routers.gemini as G
from api.routers.gemini import GeminiRequest, _build_prompt, _mock_response

QUERIES = ['compare strategy options', 'undercut?', 'pit now or extend?', 'attack or defend?',
           'risk?', 'how is it going?']

# Every field the prompt or the heuristic formats, null
NULL_CTX = {
    'currentLap': None, 'maxLap': None, 'focusDriver': 'PIA', 'selectedDrivers': None,
    'session': {'EventName': None, 'SessionName': None},
    'weather': {'AirTemp': None, 'TrackTemp': None, 'Rainfall': None, 'Humidity': None},
    'driverFeatures': {'PIA': {'position': None, 'recentPace': None, 'compoundName': None, 'tyreLife': None,
                               'paceTrend': None, 'estLapsToPit': None}},
    'recentLaps': [{'lap': None, 'time': None, 'compound': None, 'tyreLife': None,
                    's1': None, 's2': None, 's3': None}],
    'tyreStrategy': {'PIA': [{'compound': None, 'startLap': None, 'length': None}]},
    'lstm': {'driver': None, 'predictedTimes': [None, 90.1], 'pitProbability': None},
    'monteCarloProjections': [{'driver': 'PIA', 'currentPos': None, 'expectedPos': None, 'posRange': None,
                               'podiumProb': None, 'pointsProb': None}],
    'monteCarloSimulations': None,
    'battles': [{'driver1': None, 'driver2': None, 'overtakeProb': None, 'type': None}],
    'risks': [{'severity': None, 'driver': None, 'description': None}],
    'raceParams': {'pitLoss': None, 'scRate': None},
    'simulator': {'customPos': None, 'baselinePos': None, 'delta': None},
}
CONTEXTS = [NULL_CTX, {k: None for k in NULL_CTX},
            {'driverFeatures': None, 'monteCarloProjections': None, 'raceParams': None}, None]


def req(query, ctx, session_type='R', current_lap=None):
    return GeminiRequest(query=query, drivers=['PIA'], current_lap=current_lap, session_type=session_type,
                         race_context=ctx)


@pytest.mark.parametrize('session_type', [None, 'R', 'Q'])
@pytest.mark.parametrize('query', QUERIES)
@pytest.mark.parametrize('ctx_index', range(len(CONTEXTS)))
def test_null_context_values_never_raise(session_type, query, ctx_index):
    request = req(query, CONTEXTS[ctx_index], session_type)
    prompt = _build_prompt(request)
    mock = _mock_response(request)
    assert 'None' not in mock['response']          # an unknown value shows '?', not None
    assert isinstance(mock['scenarios'], list)
    if ctx_index == 0:
        assert 'PIA: P?, pace ?s, tyre ? (age ? laps), trend ?s/lap, est. ? laps to pit' in prompt


def test_unknown_values_are_not_printed_as_data():
    """The heuristic computes its laps with HEURISTIC_DEFAULTS but never
    prints them as the driver's values (it used to print 'P5, MEDIUM tyres
    (15 laps), pace 92.0s' for a driver it knew nothing about)."""
    text = _mock_response(req('how is it going?', NULL_CTX, current_lap=20))['response']
    assert 'P?, ? tyres (age ?), pace ?s, trend ?s/lap.' in text
    assert '92.0' not in text and '(15 laps)' not in text


class FakeModels:
    def __init__(self, behaviour):
        self.behaviour, self.threads = behaviour, []

    def generate_content(self, model, contents):
        self.threads.append(threading.current_thread())
        if self.behaviour == 'raise':
            raise RuntimeError('quota exceeded')
        return type('Response', (), {'text': None if self.behaviour == 'no_text' else 'Box now.'})()


@pytest.fixture
def fake_gemini(monkeypatch):
    def install(behaviour, available=True, key='test-key-not-real'):
        models = FakeModels(behaviour)
        client = type('Client', (), {'models': models})
        monkeypatch.setattr(G, 'genai', type('genai', (), {'Client': staticmethod(lambda api_key: client())}),
                            raising=False)
        monkeypatch.setattr(G, 'GEMINI_AVAILABLE', available)
        if key:
            monkeypatch.setenv('GEMINI_API_KEY', key)
        else:
            monkeypatch.delenv('GEMINI_API_KEY', raising=False)
        return models
    return install


def call(request):
    return asyncio.run(G.gemini_strategy(request))


@pytest.mark.parametrize('behaviour,available,key,reason', [
    ('raise', True, 'k', 'Gemini API unavailable'),
    ('no_text', True, 'k', 'Gemini API unavailable'),
    ('ok', False, 'k', 'google-genai not installed'),
    ('ok', True, None, 'Gemini AI not configured'),
])
def test_fallback_is_labelled_heuristic(fake_gemini, behaviour, available, key, reason):
    fake_gemini(behaviour, available, key)
    out = call(req('compare strategy options', NULL_CTX))
    assert out['response'].startswith(f'[Heuristic fallback, not Gemini: {reason}')
    assert 'data-driven' not in out['response']
    assert out['is_mock'] is True and out['is_heuristic'] is True and out['fallback'] == 'heuristic'
    assert out['fallback_reason'].startswith(reason)


def test_gemini_answer_is_not_labelled(fake_gemini):
    fake_gemini('ok')
    out = call(req('compare strategy options', NULL_CTX))
    assert out['response'] == 'Box now.'
    assert out['is_mock'] is False and out['is_heuristic'] is False and out['fallback'] is None


@pytest.mark.parametrize('behaviour', ['ok', 'raise'])
def test_blocking_call_runs_off_the_event_loop(fake_gemini, behaviour):
    models = fake_gemini(behaviour)

    async def scenario():
        loop_thread = threading.current_thread()
        out = await G.gemini_strategy(req('risk?', NULL_CTX))
        return loop_thread, out

    loop_thread, _ = asyncio.run(scenario())
    assert len(models.threads) == 1 and models.threads[0] is not loop_thread


def test_no_data_driven_label_left():
    assert 'data-driven' not in open(G.__file__, encoding='utf-8').read()
