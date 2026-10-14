"""session_type end to end on the analytics and prediction endpoints
(decision D16, B9): each accepts the type of the session on screen (query
parameter for GET, body field for POST, default 'R'), loads that session,
and a non-race session never gets race-only logic (no projected pit lap, no
pit probability, no predicted stints)."""
import asyncio
import json

import pytest

import api.main as main
from api.routers import analytics, predictions
from conftest import cached_session_path

QUALI = (2024, 8, 'Q')    # cached: session_2024_8_Q.json
RACE = (2024, 8, 'R')


@pytest.fixture
def loads(monkeypatch):
    """Record every load_session call of the routers (they import it from
    api.main at call time) and serve the cached payload of that session."""
    calls = []

    def fake_load(year, rnd, session_type='R'):
        calls.append((year, rnd, session_type))
        p = cached_session_path(year, rnd, session_type)
        if not p.exists():
            pytest.skip(f'processed cache missing: {p.name}')
        with open(p, encoding='utf-8') as fh:
            return json.load(fh)
    monkeypatch.setattr(main, 'load_session', fake_load)
    return calls


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize('session_type,expected', [('Q', 'Q'), ('q', 'Q'), ('R', 'R'), ('', 'R')])
def test_analytics_get_endpoints_load_the_session_type(loads, session_type, expected):
    run(analytics.get_sector_rankings(2024, 8, session_type=session_type))
    run(analytics.get_consistency(2024, 8, session_type=session_type))
    run(analytics.get_speed_rankings(2024, 8, session_type=session_type))
    assert loads == [(2024, 8, expected)] * 3


def test_analytics_default_is_the_race(loads):
    run(analytics.get_sector_rankings(2024, 8))
    run(analytics.get_consistency(2024, 8))
    run(analytics.get_speed_rankings(2024, 8))
    assert loads == [RACE] * 3


def test_quali_sectors_come_from_the_quali_laps(loads):
    """The sector ranking of a qualifying is computed on its own laps (the
    session best of Q is below the race one at Monaco 2024)."""
    q = run(analytics.get_sector_rankings(2024, 8, session_type='Q'))
    r = run(analytics.get_sector_rankings(2024, 8))
    assert q['session_bests'] != r['session_bests']
    assert all(q['session_bests'][s] < r['session_bests'][s] for s in '123')


def deg_request(session_type=None, **kw):
    body = dict(year=2024, round=8, drivers=['LEC', 'PIA'], lap_start=1, lap_end=80, **kw)
    if session_type is not None:
        body['session_type'] = session_type
    return predictions.DegradationRequest(**body)


def test_degradation_loads_the_session_type_and_has_no_pit_lap_outside_a_race(loads):
    out = run(predictions.predict_degradation(deg_request('Q')))
    assert loads == [QUALI]
    assert out['session_type'] == 'Q'
    assert out['optimal_pit_lap'] is None and out['undercut_window'] is None
    for d in out['all_drivers']:
        assert d['optimal_pit_lap'] is None
        assert all(s['optimal_pit_lap'] is None and 'Not a race session' in s['optimal_pit_lap_reason']
                   for s in d['stints'])


def test_practice_long_runs_are_fitted_without_a_pit_lap(loads):
    """2026 R1 FP2 has fitted stints (long runs); run as a race they used to
    get projected pit laps (12, 14, 23, ...), as practice they get none."""
    drivers = ['ALB', 'ANT', 'BEA', 'HAM', 'LEC', 'NOR', 'PIA', 'RUS', 'VER']
    body = dict(year=2026, round=1, drivers=drivers, lap_start=1, lap_end=200, session_type='FP2')
    out = run(predictions.predict_degradation(predictions.DegradationRequest(**body)))
    assert loads == [(2026, 1, 'FP2')]
    fitted = [s for d in out['all_drivers'] for s in d['stints'] if s['slope'] is not None]
    assert len(fitted) >= 3
    assert all(s['optimal_pit_lap'] is None for s in fitted)
    as_race = predictions.degradation_response(main.load_session(2026, 1, 'FP2')['lap_times'], drivers, 1, 200)
    assert any(s['optimal_pit_lap'] is not None for d in as_race['all_drivers'] for s in d['stints'])


def test_degradation_default_is_the_race(loads):
    out = run(predictions.predict_degradation(deg_request()))
    assert loads == [RACE] and out['session_type'] == 'R'


@pytest.mark.parametrize('session_type,race', [(None, True), ('R', True), ('S', True), ('s', True),
                                               ('Q', False), ('SQ', False), ('FP2', False)])
def test_lstm_pit_projection_only_in_races(session_type, race):
    laps = [{'lap_time': 80.0 + i * 0.05, 'tyre_life': 20 + i, 'compound': 'MEDIUM', 'lap_number': 30 + i}
            for i in range(10)]
    body = dict(last_10_laps=laps, driver='LEC', current_lap=40, max_lap=78)
    if session_type is not None:
        body['session_type'] = session_type
    out = run(predictions.predict_lstm(predictions.LSTMRequest(**body)))
    assert len(out['predicted_times']) == 5
    if race:
        assert isinstance(out['optimal_pit_lap'], int) and out['predicted_stints']
        assert out['pit_probability'] is not None
    else:
        assert out['optimal_pit_lap'] is None and out['predicted_stints'] == []
        assert out['pit_probability'] is None
        assert 'not a race session' in out['pit_projection_reason']


def test_every_analytics_and_prediction_route_takes_session_type():
    """No route of the two routers is left without the parameter (a new one
    would silently load the race)."""
    import inspect
    for router, models in ((analytics.router, {}),
                           (predictions.router, {'/api/predict/lstm': predictions.LSTMRequest,
                                                 '/api/predict/degradation': predictions.DegradationRequest})):
        for route in router.routes:
            if route.path in models:
                assert 'session_type' in models[route.path].model_fields, route.path
                assert models[route.path].model_fields['session_type'].default == 'R'
            else:
                params = inspect.signature(route.endpoint).parameters
                assert 'session_type' in params and params['session_type'].default == 'R', route.path


def test_session_data_endpoints_load_the_session_type(loads):
    """The frontend sends the session on screen to /strategy (and the other
    session data routes take it too): a qualifying's stints, not the race's."""
    run(main.get_lap_times(2024, 8, session_type='Q'))
    run(main.get_circuit_info(2024, 8, session_type='Q'))
    q = run(main.get_tyre_strategy(2024, 8, session_type='Q'))
    run(main.get_drivers(2024, 8, session_type='Q'))
    run(main.get_results(2024, 8, session_type='Q'))
    run(main.get_weather(2024, 8, session_type='Q'))
    assert loads == [QUALI] * 6
    r = run(main.get_tyre_strategy(2024, 8))
    assert loads[-1] == RACE and q['strategies'] != r['strategies']
