"""GET /api/analytics/consistency (api/routers/analytics.py) on the shared
consistency sigma (data/processors/degradation.py consistency_sigma, the
same as consistencySigma of frontend/src/utils/degradation.js, run here with
vite-node). The response keeps every key of the previous version.

The route function is called directly (see test_api_strategy.py)."""
import asyncio
import json
import os
import shutil
import subprocess

import pytest

from conftest import BACKEND, CACHE_DIR, cached_session_path, load_cached_session
from data.processors.degradation import _is_lap_completed, consistency_sigma
from data.processors.stints import leader_lap_times

FRONTEND = BACKEND.parent / 'frontend'
VITE_NODE = FRONTEND / 'node_modules' / 'vite-node' / 'vite-node.mjs'
DEGRADATION_JS = FRONTEND / 'src' / 'utils' / 'degradation.js'
NODE = shutil.which('node')

# Keys of the previous response (frontend store consistencyData)
DRIVER_KEYS = {'driver', 'team', 'number', 'avg_lap', 'fastest', 'slowest', 'range', 'std_dev', 'cv_percent',
               'sample_size', 'lap_count', 'insufficient_data', 'outliers', 'compounds', 'is_consistent'}
COMPOUND_KEYS = {'avg', 'std', 'deg_rate', 'count', 'avg_tyre_life'}
TOP_KEYS = {'drivers', 'session_avg', 'race_length', 'min_laps_threshold'}


@pytest.fixture
def api_main(monkeypatch):
    if not cached_session_path(2024, 16).exists():
        pytest.skip('processed cache missing: session_2024_16_R.json')
    import api.main as main

    monkeypatch.setattr(main, 'session_cache', {})
    monkeypatch.setattr(main, 'raw_session_cache', {main.get_cache_key(2024, 16, 'R'): object()})
    return main


def cached_races():
    return sorted(CACHE_DIR.glob('session_*_R.json')) if CACHE_DIR.exists() else []


def read_laps(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh).get('lap_times') or []


def test_monza_endpoint_is_consistency_sigma(api_main):
    from api.routers.analytics import get_consistency

    out = asyncio.run(get_consistency(2024, 16))
    laps = load_cached_session(2024, 16)['lap_times']
    assert TOP_KEYS <= set(out)
    sigmas = {}
    for d in out['drivers']:
        assert DRIVER_KEYS <= set(d)
        for c in d['compounds'].values():
            assert COMPOUND_KEYS <= set(c)
        cs = consistency_sigma(laps, d['driver'])
        assert d['sigma'] == cs['sigma'] and d['std_dev'] == round(cs['sigma'], 3)
        assert d['sample_size'] == d['lap_count'] == cs['n']
        assert (d['outliers'], d['stints_fitted']) == (cs['outliers'], cs['stints'])
        assert sum(c['count'] for c in d['compounds'].values()) == cs['n']
        sigmas[d['driver']] = d['std_dev']
    print('Monza 2024 sigma:', sigmas, 'median', round(out['median_sigma'], 3))
    # docs/evidence/degradation_definition_monza.txt
    assert len(sigmas) == 19
    assert (sigmas['LEC'], sigmas['PIA'], sigmas['STR']) == (0.298, 0.404, 0.568)
    assert round(out['median_sigma'], 3) == 0.342
    assert [d['driver'] for d in out['drivers'] if d['is_consistent']] == \
        [d['driver'] for d in out['drivers'] if d['sigma'] <= out['median_sigma']]
    assert [d['avg_lap'] for d in out['drivers']] == sorted(d['avg_lap'] for d in out['drivers'])
    json.dumps(out)


def test_every_cached_race_and_the_low_data_flag():
    """Every driver of every cached race: sigma = consistency_sigma, drivers
    without a fitted stint left out. insufficient_data = completed laps below
    the threshold; the clean-lap count would flag far more full-distance
    drivers (counts printed)."""
    from api.routers.analytics import consistency_response

    files = cached_races()
    if not files:
        pytest.skip('processed cache missing')
    listed = left_out = flagged = flagged_by_clean_laps = 0
    for f in files:
        laps = read_laps(f)
        out = consistency_response(laps)
        drivers = sorted({r['Driver'] for r in laps if isinstance(r, dict) and r.get('Driver')})
        by = {d['driver']: d for d in out['drivers']}
        for drv in drivers:
            cs = consistency_sigma(laps, drv)
            if cs['sigma'] is None:
                assert drv not in by
                left_out += 1
                continue
            d = by[drv]
            assert d['sigma'] == cs['sigma'] and d['lap_count'] == cs['n']
            assert d['insufficient_data'] == (d['laps_completed'] < out['min_laps_threshold'])
            listed += 1
            flagged += d['insufficient_data']
            flagged_by_clean_laps += d['lap_count'] < out['min_laps_threshold']
    print(f'{len(files)} races: {listed} drivers listed, {left_out} without a fitted stint left out; '
          f'insufficient_data (completed laps) {flagged}, by the clean-lap count it would be {flagged_by_clean_laps}')
    assert flagged <= flagged_by_clean_laps


def test_causal_session_now(api_main):
    """With session_now only laps completed by then count: same answer as
    from the completed laps alone, race_length = laps completed so far."""
    from api.routers.analytics import consistency_response, get_consistency

    laps = load_cached_session(2024, 16)['lap_times']
    now = leader_lap_times(laps)[25][1]
    out = asyncio.run(get_consistency(2024, 16, session_now=now))
    done = [r for r in laps if _is_lap_completed(r, now)]
    assert out == consistency_response(done, load_cached_session(2024, 16)['driver_info'], now)
    assert out['race_length'] == 25
    for d in out['drivers']:
        assert d['sigma'] == consistency_sigma(laps, d['driver'], session_now=now)['sigma']
        assert d['laps_completed'] <= 25


JS_SIGMA = r"""
import fs from 'node:fs';
const { consistencySigma } = await import(process.env.DEG_MODULE);
const req = JSON.parse(fs.readFileSync(process.env.DEG_REQUEST, 'utf8'));
const out = {};
for (const file of req.files) {
  const raw = fs.readFileSync(file, 'utf8');
  const laps = JSON.parse(raw.replace(/([:\[,]\s*)-?NaN\b/g, '$1null')).lap_times || [];
  const drivers = [...new Set(laps.filter((r) => r && r.Driver).map((r) => r.Driver))].sort();
  out[file] = Object.fromEntries(drivers.map((d) => [d, consistencySigma(laps, d)]));
}
fs.writeFileSync(process.env.DEG_OUTPUT, JSON.stringify(out));
"""


@pytest.mark.skipif(not (NODE and VITE_NODE.exists()), reason='node / frontend node_modules not installed')
def test_endpoint_sigma_equals_frontend_consistency_sigma(tmp_path):
    from api.routers.analytics import consistency_response

    files = cached_races()
    if not files:
        pytest.skip('processed cache missing')
    (tmp_path / 'script.mjs').write_text(JS_SIGMA, encoding='utf-8')
    (tmp_path / 'request.json').write_text(json.dumps({'files': [str(f) for f in files]}), encoding='utf-8')
    env = dict(os.environ, DEG_MODULE=str(DEGRADATION_JS), DEG_REQUEST=str(tmp_path / 'request.json'),
               DEG_OUTPUT=str(tmp_path / 'output.json'))
    res = subprocess.run([NODE, str(VITE_NODE), str(tmp_path / 'script.mjs')], cwd=str(FRONTEND), env=env,
                         capture_output=True, text=True, timeout=300)
    assert res.returncode == 0, res.stderr
    js = json.loads((tmp_path / 'output.json').read_text(encoding='utf-8'))
    compared = 0
    max_diff = 0.0
    for f in files:
        out = consistency_response(read_laps(f))
        by = {d['driver']: d for d in out['drivers']}
        for drv, j in js[str(f)].items():
            if j['sigma'] is None:
                assert drv not in by
                continue
            d = by[drv]
            max_diff = max(max_diff, abs(d['sigma'] - j['sigma']))
            assert abs(d['sigma'] - j['sigma']) <= 1e-9
            assert (d['lap_count'], d['stints_fitted'], d['outliers']) == (j['n'], j['stints'], j['outliers'])
            compared += 1
    print(f'{len(files)} races, {compared} drivers: max |endpoint sigma - consistencySigma| = {max_diff:.3g}')
    assert compared > 0


def test_one_true_median():
    """D10: the median of the consistency flag is the true median (the mean
    of the two middle sigmas for an even count), degradation.median, the one
    definition. 2024 R10 has 20 sigmas: MAG (0.4180, the upper middle one)
    is above the median 0.4066, not consistent; the upper median the cards
    used flagged him consistent."""
    from api.routers import analytics
    from data.processors.degradation import median

    assert median([3, 1, 2]) == 2 and median([4, 1, 3, 2]) == 2.5 and median([]) is None
    assert not hasattr(analytics, '_median')  # no second median definition
    out = analytics.consistency_response(load_cached_session(2024, 10)['lap_times'])
    sigmas = sorted(d['sigma'] for d in out['drivers'])
    assert len(sigmas) == 20
    assert out['median_sigma'] == (sigmas[9] + sigmas[10]) / 2
    mag = next(d for d in out['drivers'] if d['driver'] == 'MAG')
    assert mag['sigma'] == sigmas[10] and mag['is_consistent'] is False
    assert round(mag['sigma'], 4) == 0.418 and round(out['median_sigma'], 4) == 0.4066


JS_VIEW = r"""
import fs from 'node:fs';
const { consistencyView } = await import(process.env.VIEW_MODULE);
const { leaderLapEndTime } = await import(process.env.RACE_TIME_MODULE);
const req = JSON.parse(fs.readFileSync(process.env.DEG_REQUEST, 'utf8'));
const out = {};
for (const file of req.files) {
  const raw = fs.readFileSync(file, 'utf8');
  const laps = JSON.parse(raw.replace(/([:\[,]\s*)-?NaN\b/g, '$1null')).lap_times || [];
  const clocks = [null, leaderLapEndTime(laps, 20)];
  out[file] = clocks.map((now) => ({ now, view: consistencyView(laps, now == null ? Infinity : now) }));
}
fs.writeFileSync(process.env.DEG_OUTPUT, JSON.stringify(out));
"""


@pytest.mark.skipif(not (NODE and VITE_NODE.exists()), reason='node / frontend node_modules not installed')
def test_endpoint_equals_the_consistency_cards(tmp_path):
    """G5 done-when: the /consistency payload and the frontend Consistency
    cards (consistencyView) agree per driver on sigma and is_consistent, and
    on the derived fields (sample_size, avg_lap / fastest / slowest to the
    ms the backend rounds to, insufficient_data, laps_completed, the compound
    counts and average tyre life), every cached race, whole race and the end
    of leader lap 20. Every Monza 2024 finisher has sigma <= 0.8 s."""
    from api.routers.analytics import consistency_response

    files = cached_races()
    if not files:
        pytest.skip('processed cache missing')
    (tmp_path / 'script.mjs').write_text(JS_VIEW, encoding='utf-8')
    (tmp_path / 'request.json').write_text(json.dumps({'files': [str(f) for f in files]}), encoding='utf-8')
    env = dict(os.environ, VIEW_MODULE=str(FRONTEND / 'src' / 'utils' / 'views' / 'degradationViews.js'),
               RACE_TIME_MODULE=str(FRONTEND / 'src' / 'utils' / 'raceTime.js'),
               DEG_REQUEST=str(tmp_path / 'request.json'), DEG_OUTPUT=str(tmp_path / 'output.json'))
    res = subprocess.run([NODE, str(VITE_NODE), str(tmp_path / 'script.mjs')], cwd=str(FRONTEND), env=env,
                         capture_output=True, text=True, timeout=600)
    assert res.returncode == 0, res.stderr
    js = json.loads((tmp_path / 'output.json').read_text(encoding='utf-8'))
    rows = 0
    for f in files:
        laps = read_laps(f)
        for case in js[str(f)]:
            out = consistency_response(laps, [], case['now'])
            by = {d['driver']: d for d in out['drivers']}
            fe = {d['driver']: d for d in case['view']['drivers']}
            assert set(by) == set(fe), (f.name, case['now'])
            assert out['min_laps_threshold'] == case['view']['minLapsThreshold']
            for drv, v in fe.items():
                b = by[drv]
                assert abs(b['sigma'] - v['std_dev']) <= 1e-9, (f.name, drv)
                assert b['is_consistent'] == v['is_consistent'], (f.name, case['now'], drv)
                assert b['sample_size'] == v['sample_size'] and b['insufficient_data'] == v['insufficient_data']
                assert b['laps_completed'] == v['laps_completed']
                for k in ('avg_lap', 'fastest', 'slowest'):
                    assert abs(b[k] - v[k]) <= 5e-4 + 1e-9, (f.name, drv, k)
                assert {c: (x['count'], x['avg_tyre_life']) for c, x in b['compounds'].items()} == \
                    {c: (x['count'], x['avg_tyre_life']) for c, x in v['compounds'].items()}
                rows += 1
    print(f'{len(files)} races x 2 clocks: {rows} driver rows, endpoint == cards')
    assert rows > 1000

    payload = load_cached_session(2024, 16)
    out = consistency_response(payload['lap_times'])
    finishers = [r['Abbreviation'] for r in payload['race_results'] if str(r.get('ClassifiedPosition', '')).isdigit()]
    by = {d['driver']: d['sigma'] for d in out['drivers']}
    assert len(finishers) == 19 and all(by[a] <= 0.8 for a in finishers)
