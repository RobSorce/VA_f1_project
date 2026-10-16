"""POST /api/predict/degradation (api/routers/predictions.py) on the shared
degradation definition (data/processors/degradation.py).

G1: the endpoint returns, per driver, the per-stint fits of stint_fits
(clean laps only: no lap 1, no in-lap or out-lap, green, no slow outlier;
fuel-corrected time on TyreLife), the same rows as stintFits of
frontend/src/utils/degradation.js (run here with vite-node), and no
optimal pit lap when the fitted slope is <= 0.
G2: the lap rows come from the app session cache (api/main.py
load_session), in a worker thread; a warm-cache call is timed.

The route functions are called directly (see test_api_strategy.py): no
TestClient, no live-timing startup hook, and the background FastF1 pre-load
of load_session is disabled by marking the raw session as already cached.
"""
import asyncio
import json
import math
import os
import shutil
import statistics
import subprocess
import threading
import time

import pytest

from conftest import BACKEND, cached_session_path, load_cached_session
from data.processors.degradation import MIN_FIT_LAPS, stint_fits
from data.processors.stints import leader_lap_times

FRONTEND = BACKEND.parent / 'frontend'
VITE_NODE = FRONTEND / 'node_modules' / 'vite-node' / 'vite-node.mjs'
DEGRADATION_JS = FRONTEND / 'src' / 'utils' / 'degradation.js'
NODE = shutil.which('node')

ADDED_KEYS = ('optimal_pit_lap', 'optimal_pit_lap_reason')
# Brushed ranges compared with the frontend (Monza 2024 has 53 laps)
RANGES = [(1, 53), (10, 25), (5, 15), (17, 38), (20, 40), (30, 53), (39, 53), (2, 9)]
FIT_KEYS = {
    'stint_number': 'stintNumber', 'compound': 'compound', 'start_lap': 'startLap', 'end_lap': 'endLap',
    'slope': 'slope', 'raw_slope': 'rawSlope', 'intercept': 'intercept', 'n': 'n',
    'residual_sigma': 'residualSigma', 'slope_std_err': 'slopeStdErr',
    'tyre_life_min': 'tyreLifeMin', 'tyre_life_max': 'tyreLifeMax',
}


@pytest.fixture
def api_main(monkeypatch):
    if not cached_session_path(2024, 16).exists():
        pytest.skip('processed cache missing: session_2024_16_R.json')
    import api.main as main
    from data.extractors.fastf1_extractor import FastF1Extractor

    def no_fastf1(*args, **kwargs):
        raise AssertionError('FastF1 must not be called for a cached session')

    # fresh memory cache (first call reads the disk cache); no FastF1 at all
    monkeypatch.setattr(main, 'session_cache', {})
    monkeypatch.setattr(main, 'raw_session_cache', {main.get_cache_key(2024, 16, 'R'): object()})
    monkeypatch.setattr(main, 'get_raw_session', no_fastf1)
    monkeypatch.setattr(FastF1Extractor, 'get_session', no_fastf1)
    return main


def request(drivers, lap_start, lap_end, session_now=None, year=2024, rnd=16):
    from api.routers.predictions import DegradationRequest
    return DegradationRequest(year=year, round=rnd, drivers=drivers, lap_start=lap_start,
                              lap_end=lap_end, session_now=session_now)


def call(*args, **kwargs):
    from api.routers.predictions import predict_degradation
    return asyncio.run(predict_degradation(request(*args, **kwargs)))


def monza_clocks(laps):
    """Whole race (None) and the leader's end of laps 18 and 36."""
    lead = leader_lap_times(laps)
    return [None, lead[18][1], lead[36][1]]


def strip(row):
    return {k: v for k, v in row.items() if k not in ADDED_KEYS}


# ---------------------------------------------------------------- G1: Monza

def test_monza_pia_laps_10_25_per_stint(api_main):
    """The defect: one LapNumber regression across both stints, pit laps
    included, gave -0.1414 s/lap and optimal_pit_lap = the brush end."""
    out = call(['PIA'], 10, 25)
    rows = [(s['stint_number'], s['compound'], s['n'], s['slope'] if s['slope'] is None else round(s['slope'], 4))
            for s in out['stints']]
    print('PIA 10-25 stints:', rows)
    assert rows == [(1, 'MEDIUM', 6, None), (2, 'HARD', 8, -0.1278)]
    hard = out['stints'][1]
    assert round(hard['raw_slope'], 4) == -0.1578
    assert (hard['tyre_life_min'], hard['tyre_life_max']) == (2, 9)
    # top level = the latest fitted stint; legacy keys: slope = raw, slope_fuel_corrected = the fit's slope
    assert (out['driver'], out['stint_number'], out['compound']) == ('PIA', 2, 'HARD')
    assert out['slope'] == hard['raw_slope'] == out['raw_slope']
    assert out['slope_fuel_corrected'] == hard['slope'] == out['degradation_per_lap']
    # negative slope: no pit lap, no undercut window, a reason
    assert out['optimal_pit_lap'] is None and out['undercut_window'] is None
    assert 'not positive' in out['optimal_pit_lap_reason']
    assert out['stints'][0]['optimal_pit_lap'] is None
    assert str(MIN_FIT_LAPS) in out['stints'][0]['optimal_pit_lap_reason']
    assert out['reason'] is None
    assert out['lap_count_per_driver'] == {'PIA': 14}
    json.dumps(out)  # serialisable, no circular reference


def test_no_fitted_stint_is_a_200_with_a_reason(api_main):
    out = call(['PIA'], 10, 20)
    print('PIA 10-20:', out['reason'], out['lap_count_per_driver'])
    assert out['slope'] is None and out['optimal_pit_lap'] is None and out['all_drivers'] == []
    assert f'at least {MIN_FIT_LAPS} clean laps in [10, 20]' in out['reason']
    assert out['lap_count_per_driver'] == {'PIA': sum(f['n'] for f in stint_fits(
        load_cached_session(2024, 16)['lap_times'], driver='PIA', lap_start=10, lap_end=20))}


def test_endpoint_rows_are_stint_fits(api_main):
    """Every driver, brushed range and clock on Monza: the endpoint's stint
    rows are stint_fits unchanged (plus the projected pit lap)."""
    laps = load_cached_session(2024, 16)['lap_times']
    drivers = sorted({r['Driver'] for r in laps if r.get('Driver')})
    checked = fitted = 0
    for now in monza_clocks(laps):
        for lo, hi in RANGES:
            out = call(drivers, lo, hi, session_now=now)
            by_driver = {d['driver']: d for d in out['all_drivers']}
            for d in drivers:
                expect = stint_fits(laps, session_now=now, driver=d, lap_start=lo, lap_end=hi)
                assert out['lap_count_per_driver'][d] == sum(f['n'] for f in expect)
                if any(f['slope'] is not None for f in expect):
                    got = by_driver[d]['stints']
                    assert [strip(r) for r in got] == expect
                    primary = [f for f in expect if f['slope'] is not None][-1]
                    assert by_driver[d]['stint_number'] == primary['stint_number']
                    fitted += 1
                else:
                    assert d not in by_driver
                checked += 1
    print(f'endpoint = stint_fits: {checked} driver x range x clock cases, {fitted} with a fit')
    assert fitted > 0


def test_causal_session_now(api_main):
    """With session_now, laps completed later change nothing: the response
    equals the one computed from the completed laps only."""
    import api.routers.predictions as pred
    from data.processors.degradation import _is_lap_completed

    laps = load_cached_session(2024, 16)['lap_times']
    now = leader_lap_times(laps)[30][1]
    done = [r for r in laps if _is_lap_completed(r, now)]
    # The race distance (highest LapNumber, the bound of the projected pit
    # lap) is known before the race: the one input kept from the future,
    # as a row of no requested driver that is not completed.
    done.append({'Driver': '___', 'LapNumber': pred._race_last_lap(laps)})
    drivers = sorted({r['Driver'] for r in laps if r.get('Driver')})
    for lo, hi in [(1, 53), (17, 53)]:
        full = pred.degradation_response(laps, drivers, lo, hi, session_now=now)
        assert full == pred.degradation_response(done, drivers, lo, hi, session_now=now)
        assert full['all_drivers']
        for d in full['all_drivers']:
            assert all(s['end_lap'] <= 30 for s in d['stints'])


# ---------------------------------------------------------------- G1: the projected pit lap

def test_projected_pit_lap_rule():
    from api.routers.predictions import PIT_DEG_THRESHOLD_S, projected_pit_lap

    assert projected_pit_lap({'slope': None, 'start_lap': 10})[0] is None
    assert projected_pit_lap({'slope': 0.0, 'start_lap': 10})[0] is None
    assert projected_pit_lap({'slope': -0.05, 'start_lap': 10})[0] is None
    # ceil(start + threshold / slope)
    assert projected_pit_lap({'slope': 0.1, 'start_lap': 10})[0] == math.ceil(10 + PIT_DEG_THRESHOLD_S / 0.1)
    assert projected_pit_lap({'slope': 0.07, 'start_lap': 10}) == (math.ceil(10 + PIT_DEG_THRESHOLD_S / 0.07), None)
    # past the race distance: none, with a reason
    lap, why = projected_pit_lap({'slope': 0.01, 'start_lap': 10}, race_last_lap=53)
    assert lap is None and 'after the last lap (53)' in why


def test_pit_lap_only_for_positive_slopes_on_every_cached_race():
    """Every stint of every cached race (whole race): a pit lap only for a
    slope > 0, inside (start_lap, race end]; otherwise None with a reason."""
    import api.routers.predictions as pred
    from conftest import CACHE_DIR

    files = sorted(CACHE_DIR.glob('session_*_R.json')) if CACHE_DIR.exists() else []
    if not files:
        pytest.skip('processed cache missing')
    counts = {'rows': 0, 'fitted': 0, 'not_positive': 0, 'projected': 0, 'past_end': 0}
    for f in files:
        with open(f, encoding='utf-8') as fh:
            laps = json.load(fh).get('lap_times') or []
        drivers = sorted({r['Driver'] for r in laps if isinstance(r, dict) and r.get('Driver')})
        out = pred.degradation_response(laps, drivers, 1, 1000)
        last = pred._race_last_lap(laps)
        for d in out['all_drivers']:
            for s in d['stints']:
                counts['rows'] += 1
                if s['slope'] is None:
                    assert s['optimal_pit_lap'] is None and s['optimal_pit_lap_reason']
                    continue
                counts['fitted'] += 1
                if s['slope'] <= 0:
                    counts['not_positive'] += 1
                    assert s['optimal_pit_lap'] is None and 'not positive' in s['optimal_pit_lap_reason']
                elif s['optimal_pit_lap'] is None:
                    counts['past_end'] += 1
                    assert 'after the last lap' in s['optimal_pit_lap_reason']
                else:
                    counts['projected'] += 1
                    assert s['start_lap'] < s['optimal_pit_lap'] <= last
                    assert s['optimal_pit_lap_reason'] is None
            assert (d['optimal_pit_lap'] is None) == (d['optimal_pit_lap_reason'] is not None)
        assert (out['undercut_window'] is None) == (out['optimal_pit_lap'] is None)
    print(f'{len(files)} races, whole race:', counts)
    assert counts['not_positive'] > 0 and counts['projected'] > 0


# ---------------------------------------------------------------- G1: endpoint = frontend

JS_STINT_FITS = r"""
import fs from 'node:fs';
const { stintFits } = await import(process.env.DEG_MODULE);
const req = JSON.parse(fs.readFileSync(process.env.DEG_REQUEST, 'utf8'));
const raw = fs.readFileSync(req.file, 'utf8');
const laps = JSON.parse(raw.replace(/([:\[,]\s*)-?NaN\b/g, '$1null')).lap_times || [];
const out = req.cases.map(([driver, lapStart, lapEnd, now]) =>
  stintFits(laps, { sessionNow: now == null ? Infinity : now, driver, lapStart, lapEnd }));
fs.writeFileSync(process.env.DEG_OUTPUT, JSON.stringify(out));
"""


def run_js(script, req, tmp_path):
    """Run a script with vite-node from frontend/ (it resolves the
    extensionless imports of src/), the request and the answer as files."""
    (tmp_path / 'script.mjs').write_text(script, encoding='utf-8')
    (tmp_path / 'request.json').write_text(json.dumps(req), encoding='utf-8')
    env = dict(os.environ, DEG_MODULE=str(DEGRADATION_JS), DEG_REQUEST=str(tmp_path / 'request.json'),
               DEG_OUTPUT=str(tmp_path / 'output.json'))
    res = subprocess.run([NODE, str(VITE_NODE), str(tmp_path / 'script.mjs')], cwd=str(FRONTEND), env=env,
                         capture_output=True, text=True, timeout=300)
    assert res.returncode == 0, res.stderr
    return json.loads((tmp_path / 'output.json').read_text(encoding='utf-8'))


@pytest.mark.skipif(not (NODE and VITE_NODE.exists()), reason='node / frontend node_modules not installed')
def test_endpoint_matches_frontend_stint_fits_on_monza(api_main, tmp_path):
    """For every driver, every stint of the brushed range
    and three clocks, the endpoint's fit = stintFits of degradation.js
    (slopes to 1e-6; every other number too, the names compared through
    FIT_KEYS)."""
    laps = load_cached_session(2024, 16)['lap_times']
    drivers = sorted({r['Driver'] for r in laps if r.get('Driver')})
    cases = [(d, lo, hi, now) for now in monza_clocks(laps) for lo, hi in RANGES for d in drivers]
    js = run_js(JS_STINT_FITS, {'file': str(cached_session_path(2024, 16)), 'cases': cases}, tmp_path)

    async def endpoint_all():
        from api.routers.predictions import predict_degradation
        return [await predict_degradation(request([d], lo, hi, session_now=now)) for d, lo, hi, now in cases]

    api = asyncio.run(endpoint_all())
    rows = fitted = no_fit_cases = 0
    max_diff = 0.0
    examples = []
    for (d, lo, hi, now), out, js_rows in zip(cases, api, js):
        assert out['lap_count_per_driver'][d] == sum(r['n'] for r in js_rows)
        if not out['all_drivers']:
            assert all(r['slope'] is None for r in js_rows)
            no_fit_cases += 1
            continue
        got = out['all_drivers'][0]['stints']
        assert len(got) == len(js_rows)
        for g, j in zip(got, js_rows):
            rows += 1
            for py_key, js_key in FIT_KEYS.items():
                a, b = g[py_key], j[js_key]
                if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                    max_diff = max(max_diff, abs(a - b))
                    assert abs(a - b) <= 1e-6, (d, lo, hi, now, py_key, a, b)
                else:
                    assert a == b, (d, lo, hi, now, py_key, a, b)
            if g['slope'] is not None:
                fitted += 1
                if d == 'PIA' and (lo, hi) == (10, 25) and now is None:
                    examples.append((g['stint_number'], g['compound'], g['slope'], j['slope'],
                                     g['raw_slope'], j['rawSlope']))
    print(f'Monza 2024: {len(cases)} cases ({len(drivers)} drivers x {len(RANGES)} ranges x 3 clocks), '
          f'{rows} stint rows, {fitted} fitted, {no_fit_cases} cases without a fit; '
          f'max |endpoint - stintFits| = {max_diff:.3g}')
    for ex in examples:
        print('PIA 10-25 stint %d %s: endpoint slope %.10f, JS slope %.10f; raw %.10f / %.10f' % ex)
    assert fitted > 0


JS_CHART = r"""
import fs from 'node:fs';
const { tyreDegradationView } = await import(process.env.VIEW_MODULE);
const { stintFits } = await import(process.env.DEG_MODULE);
const req = JSON.parse(fs.readFileSync(process.env.DEG_REQUEST, 'utf8'));
const raw = fs.readFileSync(req.file, 'utf8');
const laps = JSON.parse(raw.replace(/([:\[,]\s*)-?NaN\b/g, '$1null')).lap_times || [];
const out = req.cases.map(([driver, lapStart, lapEnd, now]) => {
  const sessionNow = now == null ? Infinity : now;
  const v = tyreDegradationView(laps, driver, { sessionNow, lapRange: [lapStart, lapEnd] });
  // the chart's fitted stints; where it draws the whole race (fewer than
  // BRUSH_MIN_LAPS laps of the range complete, a display rule) the range fit
  const rows = v.rangeApplied
    ? v.stints.map((s) => ({ stintNumber: s.stintNumber, compound: s.compound, n: s.cleanCount, fit: s.fit }))
    : stintFits(laps, { sessionNow, driver, lapStart, lapEnd })
      .map((f) => ({ stintNumber: f.stintNumber, compound: f.compound, n: f.n, fit: f.slope != null ? f : null }));
  return { rangeApplied: v.rangeApplied, rows };
});
fs.writeFileSync(process.env.DEG_OUTPUT, JSON.stringify(out));
"""


@pytest.mark.skipif(not (NODE and VITE_NODE.exists()), reason='node / frontend node_modules not installed')
def test_endpoint_matches_the_chart_at_replay_clocks(api_main, tmp_path, monkeypatch):
    """On the replay clock: the Tyre Degradation chart
    (tyreDegradationView at the replay clock) and POST /degradation with
    session_now = that clock agree on every Monza stint to 1e-6 (slope,
    intercept, raw slope, residual sigma; n exactly) at the end of leader
    laps 10, 15, 20, 30, 40, 50 and at the race end (session_now null), and
    no stint with a slope <= 0 gets a pit lap."""
    laps = load_cached_session(2024, 16)['lap_times']
    lead = leader_lap_times(laps)
    drivers = sorted({r['Driver'] for r in laps if r.get('Driver')})
    clocks = [lead[k][1] for k in (10, 15, 20, 30, 40, 50)] + [None]
    ranges = [(1, 53), (2, 12), (5, 15), (10, 30), (20, 45), (30, 53)]
    cases = [(d, lo, hi, now) for now in clocks for lo, hi in ranges for d in drivers]
    monkeypatch.setenv('VIEW_MODULE', str(FRONTEND / 'src' / 'utils' / 'views' / 'degradationViews.js'))
    js = run_js(JS_CHART, {'file': str(cached_session_path(2024, 16)), 'cases': cases}, tmp_path)

    async def endpoint_all():
        from api.routers.predictions import predict_degradation
        return [await predict_degradation(request([d], lo, hi, session_now=now)) for d, lo, hi, now in cases]

    api = asyncio.run(endpoint_all())
    fitted = 0
    for (d, lo, hi, now), out, chart in zip(cases, api, js):
        rows = {s['stint_number']: s for a in out['all_drivers'] for s in a['stints']}
        if not any(r['fit'] for r in chart['rows']):
            assert not rows, (d, lo, hi, now)
            continue
        assert sorted(rows) == sorted(r['stintNumber'] for r in chart['rows']), (d, lo, hi, now)
        for r in chart['rows']:
            g = rows[r['stintNumber']]
            assert (g['compound'], g['n']) == (r['compound'], r['n']), (d, lo, hi, now)
            if r['fit'] is None:
                assert g['slope'] is None
                continue
            fitted += 1
            for py_key, js_key in (('slope', 'slope'), ('intercept', 'intercept'), ('raw_slope', 'rawSlope'),
                                   ('residual_sigma', 'residualSigma')):
                assert abs(g[py_key] - r['fit'][js_key]) <= 1e-6, (d, lo, hi, now, py_key)
        for g in rows.values():
            assert g['optimal_pit_lap'] is None or g['slope'] > 0
    print(f'Monza 2024: {len(cases)} requests at 7 clocks, {fitted} fitted stints, endpoint == chart')
    assert fitted > 500


# ---------------------------------------------------------------- G2: session cache, worker thread, latency

def test_routers_load_in_the_app():
    """api/main.py skips a router whose import fails, with a warning only."""
    import api.main as main

    paths = {r.path for router in main._routers_loaded for r in router.routes}
    assert {'/api/predict/degradation', '/api/predict/lstm', '/api/analytics/consistency/{year}/{round_num}'} <= paths


def test_lap_rows_come_from_the_session_cache_off_the_event_loop(api_main, monkeypatch):
    calls = []
    original = api_main.load_session

    def spy(year, rnd, session_type='R'):
        calls.append((year, rnd, session_type, threading.current_thread() is threading.main_thread()))
        return original(year, rnd, session_type)

    monkeypatch.setattr(api_main, 'load_session', spy)
    call(['PIA'], 10, 25)
    call(['PIA'], 10, 25)
    assert calls == [(2024, 16, 'R', False)] * 2  # app loader, never on the main (event-loop) thread
    assert api_main.get_cache_key(2024, 16, 'R') in api_main.session_cache


def test_slow_load_does_not_block_the_event_loop(api_main, monkeypatch):
    """A 300 ms load runs in a worker thread: the loop keeps ticking."""
    original = api_main.load_session

    def slow(year, rnd, session_type='R'):
        time.sleep(0.3)
        return original(year, rnd, session_type)

    monkeypatch.setattr(api_main, 'load_session', slow)

    async def scenario():
        from api.routers.predictions import predict_degradation
        ticks = 0
        task = asyncio.create_task(predict_degradation(request(['PIA'], 10, 25)))
        while not task.done():
            await asyncio.sleep(0.01)
            ticks += 1
        return ticks, task.result()

    ticks, out = asyncio.run(scenario())
    print('event-loop ticks during a 300 ms load:', ticks)
    assert ticks >= 10 and out['driver'] == 'PIA'


def test_warm_cache_brush_latency(api_main):
    """A brush with a warm cache answers in < 200 ms."""
    from api.routers.predictions import predict_degradation

    laps = load_cached_session(2024, 16)['lap_times']
    all_drivers = sorted({r['Driver'] for r in laps if r.get('Driver')})
    call(['PIA'], 10, 25)  # warm: disk -> memory cache

    async def timed(drivers, n):
        out = []
        for i in range(n):
            lo = 1 + (i % 30)
            t0 = time.perf_counter()
            await predict_degradation(request(drivers, lo, lo + 15))
            out.append((time.perf_counter() - t0) * 1000)
        return out

    for label, drivers in (('1 driver', ['PIA']), ('2 drivers', ['PIA', 'NOR']),
                           (f'{len(all_drivers)} drivers', all_drivers)):
        ms = asyncio.run(timed(drivers, 100))
        q = statistics.quantiles(ms, n=20)
        print(f'warm cache, {label}: 100 calls, median {statistics.median(ms):.2f} ms, '
              f'p95 {q[18]:.2f} ms, max {max(ms):.2f} ms')
        assert max(ms) < 200
