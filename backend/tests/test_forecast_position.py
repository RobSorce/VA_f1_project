"""No response of POST /api/predict/lstm carries a predicted position
change. The old field compared a driver's predicted pace with his own recent
laps (a faster forecast from fuel burn alone gave +1) and was summed over the
field to a non-zero total at Monza lap 25 (+6), so it was removed from every
path: the window path of model/predict.py, the legacy lap dicts, the
built-in heuristic of api/routers/predictions.py and its twin in
model/predict.py."""
import asyncio
import json

import pytest

from api.routers import predictions
from conftest import load_cached_session
from model import predict


@pytest.fixture(scope='module')
def monza():
    return load_cached_session(2024, 16)


def lstm(**body):
    return asyncio.run(predictions.predict_lstm(predictions.LSTMRequest(**body)))


def assert_no_position_change(out, driver):
    text = json.dumps(out)
    assert 'predicted_position_change' not in text
    assert 'positions' not in out
    assert out['driver_predictions'] in ({driver: {}}, {})


@pytest.mark.parametrize('session_type', ['R', 'Q'])
def test_identifier_request(monkeypatch, monza, session_type):
    monkeypatch.setattr(predictions, '_get_load_session', lambda: (lambda y, r, t='R': monza))
    out = lstm(year=2024, round=16, driver='VER', lap=30, session_type=session_type)
    assert len(out['predicted_times']) == 5
    assert_no_position_change(out, 'VER')


def test_legacy_lap_dicts():
    laps = [{'lap_time': 85.0, 'tyre_life': 10 + i, 'compound': 'HARD', 'lap_number': 20 + i, 'position': 5}
            for i in range(10)]
    out = lstm(last_10_laps=laps, driver='XXX', current_lap=29, max_lap=53)
    assert len(out['predicted_times']) == 5
    assert_no_position_change(out, 'XXX')


def test_builtin_heuristic_and_its_model_twin():
    laps = [{'lap_time': 85.0, 'tyre_life': 20}] * 5
    assert_no_position_change(predictions._builtin_heuristic(laps, driver='XXX'), 'XXX')
    assert_no_position_change(predict._heuristic_prediction(laps, driver='XXX'), 'XXX')


def test_the_self_comparison_is_gone():
    assert not hasattr(predict, '_compute_position_change')
