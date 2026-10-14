"""L2: the split is grouped by race and seeded, the test races (the latest
season and Monza 2024) are never seen in training, the served forecast is
the method model/saved/forecast_selection.json chose on the validation races
(read from the file, never hard-coded; the test races give only its held-out
number), an LSTM that loses is named as such, and an LSTM the selection did
not measure is not served."""
import copy
import json
import shutil

import numpy as np
import pytest

from conftest import load_cached_session
from model import baselines, predict, train

SAVED = predict.MODEL_DIR


@pytest.fixture(scope='module')
def monza():
    return load_cached_session(2024, 16)


@pytest.fixture
def reload_after():
    """Reload the real artefacts lazily after a test that swapped them."""
    yield
    predict._loaded = False


def saved_json(name):
    path = SAVED / name
    if not path.exists():
        pytest.skip(f'{name} missing: run model/prepare_data.py, model/train.py, scripts/evaluate_forecast.py')
    return json.loads(path.read_text(encoding='utf-8'))


def forecast(monza, driver='SAI', lap=25):
    now = next(l['Time'] for l in monza['lap_times'] if l['Driver'] == driver and l['LapNumber'] == lap) + 1.0
    return predict.predict_from_rows(monza['lap_times'], driver, session_now=now,
                                     weather_rows=monza['weather_data'], max_lap=53)


def test_split_is_grouped_by_race_and_deterministic():
    races = [f'2024-{i}' for i in range(1, 25)] + [f'2025-{i}' for i in (1, 6, 8, 16, 21, 24)]
    a = train.split_races(races)
    assert a == train.split_races(list(reversed(races))) == train.split_races(np.array(races))
    sets = [set(a[k]) for k in ('train', 'val', 'test')]
    assert not (sets[0] & sets[1] or sets[0] & sets[2] or sets[1] & sets[2])
    assert set().union(*sets) == set(races)
    assert set(a['test']) == {r for r in races if r.startswith('2025-')} | {'2024-16'}
    assert len(a['val']) == train.VAL_RACES_N
    assert all(isinstance(r, str) for k in a for r in a[k])


def test_saved_model_never_saw_the_test_races():
    cfg = saved_json('model_config.json')
    meta = saved_json('lstm_meta.json')
    split = cfg['split']
    assert split == train.split_races({m['race'] for m in meta['rows']})
    assert '2024-16' in split['test'] and not set(split['train']) & set(split['test'])
    assert cfg['features'] == predict.FEATURES and cfg['split_seed'] == train.SPLIT_SEED
    assert cfg['windows']['train'] == sum(m['race'] in split['train'] for m in meta['rows'])


def test_selection_file_matches_the_model():
    sel = saved_json(predict.SELECTION_FILE)
    cfg = saved_json('model_config.json')
    assert sel['split'] == cfg['split']
    assert sel['model_fingerprint'] == predict.model_fingerprint()
    for kind in ('lap_time', 'pit'):
        block = sel[kind]
        # chosen on the validation races (L2b); the test order is reported only
        assert block['selection_set'] == 'val'
        assert block['ranking'][0] == block['selected']
        values = [block['methods'][m]['val'] for m in block['ranking']]
        assert values == sorted(values)
        held = [block['methods'][m]['test'] for m in block['test_ranking']]
        assert held == sorted(held) and set(block['test_ranking']) == set(block['ranking'])


def test_served_method_is_the_held_out_best(monza):
    sel = saved_json(predict.SELECTION_FILE)
    predict.reload()
    out = forecast(monza)
    best = sel['lap_time']['selected']
    if best == 'lstm' and not predict.lstm_available():
        pytest.skip('the selected LSTM cannot run here')
    assert out['method'] == best and out['model_used'] == best
    assert out['predicted_times'] == out['method_forecasts'][best]
    assert out['held_out']['values'] == {m: v['test'] for m, v in sel['lap_time']['methods'].items()}
    assert out['held_out']['races'] == sel['split']['test']
    assert out['pit_method'] == sel['pit']['selected']
    assert out['lstm_selected'] == (best == 'lstm')


def test_an_lstm_that_loses_is_not_served_and_is_named(monkeypatch, monza, reload_after):
    predict.reload()
    sel = copy.deepcopy(saved_json(predict.SELECTION_FILE))
    for key, lstm_v, pers_v in (('test', 9.0, 0.5), ('val', 8.0, 0.4)):
        sel['lap_time']['methods']['lstm'][key] = lstm_v
        sel['lap_time']['methods']['persistence'][key] = pers_v
    for key in ('ranking', 'test_ranking'):
        order = ['persistence'] + [m for m in sel['lap_time'][key] if m not in ('persistence', 'lstm')] + ['lstm']
        sel['lap_time'][key] = order
    sel['lap_time']['selected'] = 'persistence'
    monkeypatch.setattr(predict, '_selection', sel)
    out = forecast(monza)
    assert out['method'] == 'persistence' and out['is_heuristic']
    assert out['predicted_times'] == out['method_forecasts']['persistence']
    assert out['lstm_selected'] is False
    assert 'does not beat' in out['lstm_note'] and '9.000' in out['lstm_note'] and '0.500' in out['lstm_note']
    assert 'validation' in out['lstm_note'] and '8.000' in out['lstm_note'] and '0.400' in out['lstm_note']
    assert out['held_out']['values']['lstm'] == 9.0


def test_a_retrained_lstm_is_not_served_with_old_numbers(monkeypatch, tmp_path, monza, reload_after):
    sel = saved_json(predict.SELECTION_FILE)
    for f in SAVED.iterdir():
        if f.is_file() and f.suffix in ('.json', '.pt', '.pkl', '.npy') and not f.name.startswith('lstm_X'):
            shutil.copy(f, tmp_path / f.name)
    stale = dict(sel, model_fingerprint='0' * 40)
    (tmp_path / predict.SELECTION_FILE).write_text(json.dumps(stale), encoding='utf-8')
    monkeypatch.setattr(predict, 'MODEL_DIR', tmp_path)
    predict.reload()
    assert not predict.lstm_available()
    out = forecast(monza)
    assert out['method'] != 'lstm' and 'lstm' not in out['method_forecasts']
    expected = next(m for m in sel['lap_time']['ranking'] if m != 'lstm')
    assert out['method'] == expected
    if sel['lap_time']['selected'] == 'lstm':
        assert 'changed after the evaluation' in out['method_note']


def test_without_a_selection_file_persistence_is_shown(monkeypatch, tmp_path, monza, reload_after):
    monkeypatch.setattr(predict, 'MODEL_DIR', tmp_path)
    predict.reload()
    out = forecast(monza)
    assert out['method'] == 'persistence' and out['held_out'] is None
    assert predict.SELECTION_FILE in out['method_note']
    assert out['predicted_times'] == [round(out['window']['ref_time'], 3)] * 5


def test_baselines_on_a_window(monza):
    now = next(l['Time'] for l in monza['lap_times'] if l['Driver'] == 'LEC' and l['LapNumber'] == 40) + 1.0
    from model.features import build_window
    ctx = build_window(monza['lap_times'], 'LEC', session_now=now, weather_rows=monza['weather_data'])
    assert baselines.persistence(ctx) == [ctx['ref_time']] * 5
    times, fitted = baselines.stint_linear(ctx)
    fit = ctx['stint_fit']
    assert fitted and times[0] == pytest.approx(
        fit['intercept'] + fit['slope'] * (ctx['origin_tyre_life'] + 1) - 0.03 * ctx['origin_lap'])
    cm = baselines.compound_mean(ctx, {'HARD': 0.05, 'ALL': 0.0})
    assert cm[1] - cm[0] == pytest.approx(0.05 - 0.03)
    p = baselines.tyre_age_logistic(ctx, {'intercept': 0.0, 'coef': [0.0] * 6})
    assert p == pytest.approx(0.5)


def test_pit_metrics_of_the_evaluation():
    from scripts.evaluate_forecast import pit_metrics
    p = np.array([0.9, 0.8, 0.2, 0.1, 0.6])
    y = np.array([1.0, 0.0, 1.0, 0.0, 1.0])
    m = pit_metrics(p, y)
    assert m['precision'] == pytest.approx(2 / 3) and m['recall'] == pytest.approx(2 / 3)
    assert m['brier'] == pytest.approx(np.mean((p - y) ** 2))
    assert sum(b['n'] for b in m['calibration']) == 5


def test_masked_loss_ignores_missing_targets():
    torch = pytest.importorskip('torch')
    pred = torch.zeros(2, 6)
    target = torch.tensor([[1.0, 1.0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1.0]])
    mask = torch.tensor([[1.0, 0, 0, 0, 0], [0, 0, 0, 0, 0]])
    loss = train.combined_loss(pred, target, mask, pit_weight=0.0)
    assert float(loss) == pytest.approx(1.0)  # only the one unmasked target counts
