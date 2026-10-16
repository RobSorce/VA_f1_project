"""Lap-time forecast: the training guard, the selection on the validation
races, the live race distance.

1. model/train.py refuses to train (TrainingDataError, nothing written) when
   lstm_meta.json is missing or stale, instead of training on every window
   with the test races in it; scripts/evaluate_forecast.py refuses an LSTM
   whose config has no race split.
2. The served method is chosen on the VALIDATION races; the test races give
   only the held-out numbers (forecast_selection.json ranking / test_ranking,
   the response's held_out, and lstm_note when the choice loses on test).
3. POST /api/predict/lstm with live lap_rows takes the race distance from the
   max_lap the client sends, never from the laps run so far.
"""
import asyncio
import copy
import json

import numpy as np
import pytest

from api.routers import predictions
from conftest import load_cached_session
from model import predict, train
from model.features import FEATURES


@pytest.fixture(scope='module')
def monza():
    return load_cached_session(2024, 16)


@pytest.fixture
def model_dir(tmp_path, monkeypatch):
    """train.py writing to an empty directory with 40 random windows."""
    rng = np.random.default_rng(0)
    X = rng.normal(size=(40, 10, len(FEATURES))).astype(np.float32)
    y = rng.normal(size=(40, 6)).astype(np.float32)
    y[:, 5] = (y[:, 5] > 1).astype(np.float32)
    np.save(tmp_path / 'lstm_X.npy', X)
    np.save(tmp_path / 'lstm_y.npy', y)
    monkeypatch.setattr(train, 'MODEL_DIR', tmp_path)
    monkeypatch.setattr(train, 'MAX_EPOCHS', 1)
    return tmp_path, X


RACES = ['2024-1', '2024-2', '2024-3', '2024-4', '2024-5', '2024-6', '2024-7', '2025-1']


def write_meta(path, X, **over):
    doc = {'features': FEATURES, 'predict_len': 5, 'x_sha1': train.windows_fingerprint(X),
           'rows': [{'race': RACES[i % len(RACES)], 'driver': 'AAA', 'origin_lap': i} for i in range(len(X))]}
    doc.update(over)
    (path / 'lstm_meta.json').write_text(json.dumps(doc), encoding='utf-8')


def written(path):
    return sorted(p.name for p in path.iterdir() if p.name not in ('lstm_X.npy', 'lstm_y.npy', 'lstm_meta.json'))


# -- 1. no training without the race of every window ----------------------

def test_training_is_refused_without_the_meta_file(model_dir):
    path, _ = model_dir
    with pytest.raises(train.TrainingDataError, match='lstm_meta.json is missing'):
        train.train_model()
    assert written(path) == []  # no scaler, label statistics, fallback, model or config


@pytest.mark.parametrize('stale, why', [
    ({'rows': [{'race': '2024-1'}] * 39}, '39 meta rows for 40 windows'),
    ({'features': FEATURES[:-1]}, 'features differ'),
    ({'x_sha1': '0' * 40}, 'x_sha1 is not the sha1'),
    ({'predict_len': 3}, 'horizon 3'),
])
def test_training_is_refused_with_a_stale_meta_file(model_dir, stale, why):
    path, X = model_dir
    write_meta(path, X, **stale)
    with pytest.raises(train.TrainingDataError, match='stale') as e:
        train.train_model()
    assert why in str(e.value)
    assert written(path) == []


def test_training_runs_on_the_race_split_with_a_matching_meta_file(model_dir):
    pytest.importorskip('torch')
    path, X = model_dir
    write_meta(path, X)
    train.train_model()
    cfg = json.loads((path / 'model_config.json').read_text())
    assert cfg['split'] == train.split_races(RACES) and cfg['split']['test'] == ['2025-1']
    assert cfg['windows']['test'] == 5 and cfg['windows']['train'] + cfg['windows']['val'] == 35


def test_the_saved_meta_file_matches_the_saved_windows():
    meta = predict.MODEL_DIR / 'lstm_meta.json'
    if not meta.exists():
        pytest.skip('lstm_meta.json missing: run model/prepare_data.py')
    X = np.load(predict.MODEL_DIR / 'lstm_X.npy')
    y = np.load(predict.MODEL_DIR / 'lstm_y.npy')
    races = train.race_rows(X, y, json.loads(meta.read_text(encoding='utf-8')))
    assert len(races) == len(X) == 30498


def test_the_evaluation_refuses_an_lstm_without_a_race_split(monkeypatch):
    from scripts import evaluate_forecast

    def fake_load(check_fingerprint=True):
        predict._loaded = True
        predict._config = {'split': None}
        predict._model = object()
    monkeypatch.setattr(predict, '_load_model', fake_load)
    try:
        with pytest.raises(SystemExit, match='no race split'):
            evaluate_forecast.main()
    finally:
        predict._loaded = False  # the real artefacts on the next call


# -- 2. the choice on the validation races --------------------------------

def test_select_by_ranks_on_the_named_set():
    from scripts.evaluate_forecast import select_by
    numbers = {'a': {'val': 0.5, 'test': 0.7}, 'b': {'val': 0.6, 'test': 0.4}, 'c': {'val': 0.55, 'test': 0.5}}
    assert select_by(numbers) == select_by(numbers, 'val') == ['a', 'c', 'b']
    assert select_by(numbers, 'test') == ['b', 'c', 'a']


def test_the_saved_choice_is_the_validation_best_and_the_test_numbers_are_reported():
    path = predict.MODEL_DIR / predict.SELECTION_FILE
    if not path.exists():
        pytest.skip('forecast_selection.json missing: run scripts/evaluate_forecast.py')
    sel = json.loads(path.read_text(encoding='utf-8'))
    for kind in ('lap_time', 'pit'):
        block = sel[kind]
        m = block['methods']
        assert block['selection_set'] == 'val'
        assert block['ranking'] == sorted(m, key=lambda k: m[k]['val'])
        assert block['test_ranking'] == sorted(m, key=lambda k: m[k]['test'])
        assert block['selected'] == block['ranking'][0]
    # the lap-time rankings differ on the saved run: persistence 2nd on
    # validation, compound_mean 2nd on test (docs/evidence/evaluate_forecast.txt)
    assert sel['lap_time']['ranking'][:2] == ['lstm', 'persistence']
    assert sel['lap_time']['test_ranking'][:2] == ['lstm', 'compound_mean']


def forecast(monza, driver='SAI', lap=25, max_lap=53):
    now = next(l['Time'] for l in monza['lap_times'] if l['Driver'] == driver and l['LapNumber'] == lap) + 1.0
    return predict.predict_from_rows(monza['lap_times'], driver, session_now=now,
                                     weather_rows=monza['weather_data'], max_lap=max_lap)


def test_held_out_block_names_the_validation_choice(monza):
    predict.reload()
    sel = predict._selection
    if sel is None:
        pytest.skip('forecast_selection.json missing')
    out = forecast(monza)
    held = out['held_out']
    lap = sel['lap_time']
    assert held['selected_on'] == 'validation' and held['selection_races'] == sel['split']['val']
    assert held['values'] == {k: v['test'] for k, v in lap['methods'].items()}
    assert held['selection_values'] == {k: v['val'] for k, v in lap['methods'].items()}
    assert held['selected'] == lap['selected'] and held['selection_ranking'] == lap['ranking']
    assert held['ranking'] == lap['test_ranking'] and held['best'] == lap['test_ranking'][0]


def test_lstm_note_says_when_the_validation_choice_loses_on_test(monkeypatch, monza):
    predict.reload()
    if predict._selection is None or not predict.lstm_available():
        pytest.skip('selection file or LSTM unavailable')
    sel = copy.deepcopy(predict._selection)
    lap = sel['lap_time']
    lap['methods']['lstm'].update(val=0.40, test=0.70)
    lap['methods']['compound_mean'].update(val=0.45, test=0.60)
    lap['ranking'] = ['lstm', 'compound_mean'] + [m for m in lap['ranking'] if m not in ('lstm', 'compound_mean')]
    lap['test_ranking'] = ['compound_mean'] + [m for m in lap['test_ranking'] if m != 'compound_mean']
    lap['selected'] = 'lstm'
    monkeypatch.setattr(predict, '_selection', sel)
    out = forecast(monza)
    assert out['method'] == 'lstm'  # served: chosen on validation
    note = out['lstm_note']
    assert 'does not beat Last clean lap + compound mean degradation on the held-out test races' in note
    assert '0.700' in note and '0.600' in note and 'validation MAE (0.400 s)' in note


# -- 3. live rows: the race distance is the max_lap sent ------------------

def live(monza, driver='SAI', lap=25, **extra):
    now = next(l['Time'] for l in monza['lap_times'] if l['Driver'] == driver and l['LapNumber'] == lap) + 1.0
    rows = [l for l in monza['lap_times'] if l.get('Time') is not None and l['Time'] <= now]
    body = dict(driver=driver, lap_rows=rows, weather_rows=monza['weather_data'], session_now=now, **extra)
    return asyncio.run(predictions.predict_lstm(predictions.LSTMRequest(**body)))


def test_live_rows_take_the_race_distance_from_max_lap(monza):
    out = live(monza, max_lap=53)
    assert out['feature_source'] == 'request_rows' and out['origin_lap'] == 25
    assert out['optimal_pit_lap'] is not None and out['optimal_pit_lap'] > 26
    stints = out['predicted_stints']
    assert stints and stints[-1]['lap_start'] + stints[-1]['length'] == 53
    assert out['pit_projection_reason'] is None


def test_live_rows_without_max_lap_project_no_pit_lap(monza):
    """The rows reach lap 25 only: the old fallback took 25 as the race
    distance and projected a stop on lap 26."""
    out = live(monza)
    assert len(out['predicted_times']) == 5  # the forecast itself stays
    assert out['optimal_pit_lap'] is None and out['predicted_stints'] == []
    assert 'Race distance unknown' in out['pit_projection_reason']
    assert out['pit_probability'] is not None


def test_cached_identifiers_still_use_the_cached_race_distance(monkeypatch, monza):
    monkeypatch.setattr(predictions, '_get_load_session', lambda: (lambda y, r, t='R': monza))
    out = asyncio.run(predictions.predict_lstm(predictions.LSTMRequest(year=2024, round=16, driver='SAI', lap=25)))
    stints = out['predicted_stints']
    assert stints and stints[-1]['lap_start'] + stints[-1]['length'] == 53


# -- the assistant prompt names the served method --------------------------

def test_assistant_prompt_names_the_forecast_method_and_target_laps():
    from api.routers import gemini
    req = gemini.GeminiRequest(query='pace?', session_type='R', race_context={'lstm': {
        'driver': 'SAI', 'method': 'persistence', 'methodLabel': 'Persistence (next laps = last clean lap)',
        'originLap': 25, 'targetLaps': [26, 27], 'predictedTimes': [85.1, 85.2], 'heldOutMae': 0.637,
        'pitProbability': 0.2,
    }})
    prompt = gemini._build_prompt(req)
    assert '## Lap-time forecast (SAI, method: Persistence (next laps = last clean lap), from lap 25)' in prompt
    assert '  Lap 26: 85.100s' in prompt and '  Lap 27: 85.200s' in prompt
    assert 'Held-out MAE of this method: 0.637s per lap' in prompt
    assert 'LSTM Predictions' not in prompt
