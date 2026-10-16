"""One window builder (model/features.py build_window) for training
(model/prepare_data.py) and serving (POST /api/predict/lstm builds the window
from the cached laps given identifiers). Clean laps only (degradation.py
rule: no pit in-lap or out-lap, no non-green lap, no lap 1), nothing read
after the clock, and the served window of a driver at a clock is the training
window of the same origin lap.

The route function is called directly with load_session replaced by the
cached payload (no TestClient, no FastF1)."""
import asyncio
import copy
import json

import numpy as np
import pytest
from fastapi import HTTPException

from api.routers import predictions
from conftest import load_cached_session
from data.processors.degradation import is_clean_lap
from model import features, pit_timing, prepare_data
from model.features import FEATURES, SEQUENCE_LEN, build_window, rows_from_legacy_laps
from model.prepare_data import samples_from_payload


@pytest.fixture(scope='module')
def monza():
    return load_cached_session(2024, 16)


@pytest.fixture
def cached_route(monkeypatch, monza):
    """The /lstm route reading the Monza 2024 payload for any identifiers."""
    calls = []

    def fake_load(year, rnd, session_type='R'):
        calls.append((year, rnd, session_type))
        return monza
    monkeypatch.setattr(predictions, '_get_load_session', lambda: fake_load)
    return calls


def row(payload, driver, lap):
    return next(l for l in payload['lap_times'] if l['Driver'] == driver and l['LapNumber'] == lap)


def lstm(**body):
    return asyncio.run(predictions.predict_lstm(predictions.LSTMRequest(**body)))


def test_horizon_is_one_constant():
    assert prepare_data.PREDICT_LEN == features.PREDICT_LEN == pit_timing.PIT_LABEL_HORIZON_LAPS
    assert prepare_data.SEQUENCE_LEN == features.SEQUENCE_LEN


def test_sai_monza_window_leaves_out_the_pit_laps(monza):
    """The audit's SAI window (laps 16-25 sent by the frontend) held in-lap 19
    (90.4 s) and out-lap 20 (104.8 s); the built window has neither."""
    now = row(monza, 'SAI', 25)['Time'] + 1.0
    ctx = build_window(monza['lap_times'], 'SAI', session_now=now, weather_rows=monza['weather_data'])
    assert ctx['origin_lap'] == 25
    assert ctx['window_laps'] == [14, 15, 16, 17, 18, 21, 22, 23, 24, 25]
    assert ctx['ref_lap'] == 25 and ctx['ref_time'] == pytest.approx(83.687)
    assert ctx['features'].shape == (SEQUENCE_LEN, len(FEATURES))
    f = dict(zip(FEATURES, ctx['features'][-1]))
    assert f['lap_time_delta'] == 0 and f['origin_compound'] == features.COMPOUND_CODES['HARD']
    # Gap to the car ahead is the row's IntervalToAhead (LEC, 11.1 s), not 0
    assert f['gap_ahead'] == pytest.approx(row(monza, 'SAI', 25)['IntervalToAhead'])


def test_every_window_lap_is_a_clean_lap_before_the_origin(monza):
    by_lap = {(l['Driver'], l['LapNumber']): l for l in monza['lap_times']}
    samples = samples_from_payload(monza, '2024-16', keep_context=True)
    assert len(samples) > 800
    for s in samples:
        laps = s['ctx']['window_laps']
        assert len(laps) >= features.MIN_WINDOW_LAPS
        assert all(n <= s['origin_lap'] for n in laps)
        assert all(is_clean_lap(by_lap[(s['driver'], n)]) for n in laps)


def test_window_reads_nothing_after_the_clock(monza):
    now = row(monza, 'LEC', 30)['Time'] + 2.0
    base = build_window(monza['lap_times'], 'LEC', session_now=now, weather_rows=monza['weather_data'])
    rows = copy.deepcopy(monza['lap_times'])
    for l in rows:
        if l.get('Time') is not None and l['Time'] > now:
            l.update(LapTimeSeconds=150.0, TrackStatus='4', Position=20.0, IntervalToAhead=0.1, TyreLife=1.0)
    weather = copy.deepcopy(monza['weather_data'])
    for w in weather:
        if w['Time'] > now:
            w['TrackTemp'] = 99.0
    after = build_window(rows, 'LEC', session_now=now, weather_rows=weather)
    assert after['origin_lap'] == base['origin_lap'] == 30
    assert np.array_equal(after['features'], base['features'])


@pytest.mark.parametrize('driver,lap', [('SAI', 25), ('VER', 40), ('PIA', 12), ('HAM', 50), ('LEC', 52)])
def test_served_window_is_the_training_window(cached_route, monza, driver, lap):
    """Identifier request at a clock inside the driver's next lap: the window
    of the response is the training window of the same origin lap."""
    training = {(s['driver'], s['origin_lap']): s['x'] for s in samples_from_payload(monza, '2024-16')}
    now = (row(monza, driver, lap)['Time'] + row(monza, driver, lap + 1)['Time']) / 2
    out = lstm(year=2024, round=16, driver=driver, session_now=now)
    assert cached_route == [(2024, 16, 'R')]
    assert out['feature_source'] == 'cache' and out['origin_lap'] == lap
    assert out['target_laps'] == list(range(lap + 1, lap + 6))
    np.testing.assert_array_equal(np.asarray(out['window']['values']), np.round(training[(driver, lap)], 4))
    json.dumps(out, allow_nan=False)


def test_legacy_payload_with_identifiers_reads_the_cache(cached_route, monza):
    """The current frontend payload (last_10_laps + year/round/driver, gap_ahead
    0, drs 0, no session_now) gets the cached window up to its last lap."""
    legacy = [{'lap_time': row(monza, 'SAI', n)['LapTimeSeconds'], 'lap_number': n, 'gap_ahead': 0, 'drs': 0,
               'sector1': 0, 'tyre_life': row(monza, 'SAI', n)['TyreLife'], 'compound': 'HARD'}
              for n in range(16, 26)]
    old = lstm(year=2024, round=16, driver='SAI', last_10_laps=legacy, current_lap=26, max_lap=53)
    new = lstm(year=2024, round=16, driver='SAI', lap=25)
    assert old['feature_source'] == new['feature_source'] == 'cache'
    assert old['window'] == new['window'] and old['predicted_times'] == new['predicted_times']


def test_live_rows_use_the_same_builder(monza):
    now = row(monza, 'NOR', 33)['Time'] + 0.5
    rows = lstm(driver='NOR', lap_rows=monza['lap_times'], weather_rows=monza['weather_data'], session_now=now)
    ctx = build_window(monza['lap_times'], 'NOR', session_now=now, weather_rows=monza['weather_data'])
    assert rows['feature_source'] == 'request_rows' and rows['origin_lap'] == 33
    np.testing.assert_array_equal(np.asarray(rows['window']['values']), np.round(ctx['features'], 4))


def test_legacy_dicts_infer_the_stop_from_the_tyres(monza):
    """Without identifiers the dicts are read as rows; the tyre change between
    laps 19 (MEDIUM, 19 laps old) and 20 (HARD, new) marks the in-lap and the
    out-lap, which the clean-lap rule then leaves out."""
    legacy = [{'lap_time': row(monza, 'SAI', n)['LapTimeSeconds'], 'lap_number': n,
               'tyre_life': row(monza, 'SAI', n)['TyreLife'], 'compound': row(monza, 'SAI', n)['Compound']}
              for n in range(16, 26)]
    rows = rows_from_legacy_laps(legacy, 'SAI')
    assert [r['LapNumber'] for r in rows if r.get('PitInTime')] == [19]
    assert [r['LapNumber'] for r in rows if r.get('PitOutTime')] == [20]
    out = lstm(driver='SAI', last_10_laps=legacy, current_lap=25, max_lap=53)
    assert out['feature_source'] == 'legacy_laps'
    assert out['window']['laps'] == [16, 17, 18, 21, 22, 23, 24, 25]
    assert len(out['predicted_times']) == 5


def test_too_few_clean_laps_is_a_reason_not_an_error(cached_route):
    out = lstm(year=2024, round=16, driver='SAI', lap=3)
    assert out['predicted_times'] == [] and out['method'] is None
    assert out['pit_probability'] is None and out['optimal_pit_lap'] is None
    assert 'at least 3' in out['reason']


def test_a_request_without_a_source_is_rejected():
    with pytest.raises(HTTPException) as e:
        lstm(driver='SAI')
    assert e.value.status_code == 422
