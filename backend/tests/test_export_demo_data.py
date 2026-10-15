"""V12: the static demo data (scripts/export_demo_data.py -> frontend/public/data).

- The committed files are the export of the current backend: a fresh export
  is byte-identical (gzip mtime 0), so they are up to date and a re-run adds
  nothing to the repository.
- Each file is the backend's answer: session = load_session (tyre_strategy
  rebuilt included), analytics = the analytics routes, PCA files = the
  pca_compute functions, frames = every FRAME_STEP-th cached frame rounded.
- Within the repository budget (20 MB), no NaN / inf (JSON.parse rejects them).
- The helpers: slim_frames, sanitize, race_facts.
Skips without the (git-ignored) processed cache.
"""
import asyncio
import gzip
import json
import math
from pathlib import Path

import pytest

from conftest import BACKEND, cached_session_path
from scripts import export_demo_data as ed

DATA = BACKEND.parent / 'frontend' / 'public' / 'data'
HAS_CACHE = all(cached_session_path(y, r).exists() for y, r, _ in ed.DEMO_RACES) and all(
    (BACKEND / 'data' / 'processed_cache' / f'frames_{y}_{r}_R.json').exists() for y, r, _ in ed.DEMO_RACES)
needs_cache = pytest.mark.skipif(not HAS_CACHE, reason='processed cache of the demo races missing')


def _read(rel):
    raw = (DATA / rel).read_bytes()
    return json.loads(gzip.decompress(raw) if rel.endswith('.gz') else raw)


@pytest.fixture(scope='module')
def fresh_export(tmp_path_factory):
    out = tmp_path_factory.mktemp('demo_export')
    manifest = ed.export(out, log=lambda *a: None)
    return out, manifest


@needs_cache
def test_committed_files_are_a_fresh_export_byte_for_byte(fresh_export):
    out, manifest = fresh_export
    fresh = sorted(p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file())
    committed = sorted(p.relative_to(DATA).as_posix() for p in DATA.rglob('*') if p.is_file())
    assert fresh == committed
    for rel in fresh:
        assert (out / rel).read_bytes() == (DATA / rel).read_bytes(), rel
    # the backend functions were restored after the export (api.main is shared)
    import api.main as main
    assert main._save_to_disk.__name__ == '_save_to_disk'
    assert main.get_raw_session.__name__ == 'get_raw_session'


@needs_cache
def test_budget_and_manifest():
    m = _read('manifest.json')
    total = sum((DATA / rel).stat().st_size for rel in m['files']) + (DATA / 'manifest.json').stat().st_size
    assert total <= ed.BUDGET_BYTES == 20_000_000
    assert m['total_bytes'] == sum(f['bytes'] for f in m['files'].values())
    for rel, f in m['files'].items():
        assert (DATA / rel).stat().st_size == f['bytes'], rel
    assert m['nan_written_as_null'] == 0
    assert [(r['year'], r['round']) for r in m['races']] == [(y, r) for y, r, _ in ed.DEMO_RACES]
    assert m['seasons'] == sorted({y for y, _, _ in ed.DEMO_RACES}, reverse=True)
    # what each race is in the demo for, counted from its rows
    by = {(r['year'], r['round']): r for r in m['races']}
    assert by[(2024, 5)]['safety_car_periods'] > 0
    assert by[(2025, 1)]['wet_tyre_laps'] > 0 and by[(2025, 1)]['rain_samples'] > 0
    assert m['frame_step'] == ed.FRAME_STEP
    print(f"demo data: {total} bytes = {total / 1e6:.2f} MB of {ed.BUDGET_BYTES / 1e6:.0f} MB")


@needs_cache
def test_every_file_is_the_backend_answer():
    with ed._backend() as main:
        from api.routers import analytics
        from data.processors import pca_compute as pc
        for y, r, _ in ed.DEMO_RACES:
            key = f'{y}_{r}_R'
            assert _read(f'{key}/session.json.gz') == ed.sanitize(main.load_session(y, r, 'R')), key
            a = _read(f'{key}/analytics.json.gz')
            assert a['sectors'] == ed.sanitize(asyncio.run(analytics.get_sector_rankings(y, r, 'R')))
            assert a['consistency'] == ed.sanitize(asyncio.run(analytics.get_consistency(y, r, None, 'R')))
            assert a['speed_rankings'] == ed.sanitize(asyncio.run(analytics.get_speed_rankings(y, r, 'R')))
            fw = _read(f'pca/fit_without_{y}_{r}.json.gz')
            at0 = ed.sanitize(pc.pca_embeddings_at(y, r, 0.0))
            at0.pop('current_race')
            assert fw['payload'] == at0
        df = pc._load_matrix()
        assert _read('pca/embeddings.json.gz') == ed.sanitize(pc.load_pca_embeddings())
        mx = _read('pca/matrix.json.gz')
        assert len(mx['rows']) == len(df)
        assert mx['feature_cols'] == [c for c in pc.FEATURE_COLS if c in df.columns]
        st = _read('pca/strategies.json.gz')
        assert set(st) == {f'{int(y)}_{int(r)}' for y, r in zip(df['year'], df['round'])}


@needs_cache
def test_frames_are_every_step_th_cached_frame():
    y, r, _ = ed.DEMO_RACES[0]
    full = json.loads((BACKEND / 'data' / 'processed_cache' / f'frames_{y}_{r}_R.json').read_text(encoding='utf-8'))
    demo = _read(f'{y}_{r}_R/frames.json.gz')
    assert demo['demo_frame_step'] == ed.FRAME_STEP
    assert len(demo['frames']) == len(full['frames'][::ed.FRAME_STEP])
    for k in (0, 1, len(demo['frames']) // 2, len(demo['frames']) - 1):
        src = full['frames'][k * ed.FRAME_STEP]
        assert demo['frames'][k]['t'] == src['t']
        for code, d in src['drivers'].items():
            e = demo['frames'][k]['drivers'][code]
            for key in ('x', 'y'):
                assert e[key] == (None if d.get(key) is None else round(d[key])), (k, code, key)
            assert e['tyre'] == d['tyre'] and e['lap'] == d['lap'] and e['drs'] == d['drs']


def test_slim_frames_rounds_and_keeps_every_step_th_frame():
    data = {'meta': 1, 'frames': [
        {'t': i * 0.4, 'drivers': {'AAA': {'x': 10.6, 'y': -3.5, 'speed': 301.04, 'throttle': 99.96,
                                           'brake': 1.0, 'gear': 7.0, 'tyre': 2.0, 'lap': 3, 'drs': 0}}}
        for i in range(5)]}
    out = ed.slim_frames(data, step=2)
    assert out['meta'] == 1 and out['demo_frame_step'] == 2
    assert [f['t'] for f in out['frames']] == [0.0, 0.8, 1.6]
    e = out['frames'][1]['drivers']['AAA']
    assert e == {'x': 11, 'y': -4, 'speed': 301, 'throttle': 100, 'brake': 1, 'gear': 7, 'tyre': 2, 'lap': 3, 'drs': 0}
    assert all(isinstance(e[k], int) for k in ('x', 'y', 'brake', 'gear', 'tyre'))


def test_sanitize_and_encode_refuse_nan():
    counter = [0]
    out = ed.sanitize({'a': [1.0, float('nan'), {'b': float('inf')}], 'c': 'x'}, counter)
    assert out == {'a': [1.0, None, {'b': None}], 'c': 'x'} and counter == [2]
    with pytest.raises(ValueError):
        ed.encode({'a': math.nan})


def test_race_facts_counts_safety_cars_and_wet_laps():
    payload = {
        'lap_times': [{'LapNumber': 1, 'Compound': 'INTERMEDIATE'}, {'LapNumber': 2, 'Compound': 'SOFT'},
                      {'LapNumber': 3.0, 'Compound': 'WET'}],
        'track_status': [{'status': '4'}, {'status': '1'}, {'status': '6'}, {'status': '4'}],
        'weather_data': [{'Rainfall': True}, {'Rainfall': False}],
        'driver_info': [{}, {}],
    }
    f = ed.race_facts(payload)
    assert f == {'laps': 3, 'drivers': 2, 'safety_car_periods': 2, 'virtual_safety_car_periods': 1,
                 'wet_tyre_laps': 2, 'lap_rows': 3, 'rain_samples': 1, 'weather_samples': 2}


def test_gzip_files_are_deterministic(tmp_path):
    files = {}
    ed.write_file(tmp_path, 'a.json.gz', {'k': [1, 2]}, files, [0])
    first = (tmp_path / 'a.json.gz').read_bytes()
    ed.write_file(tmp_path, 'a.json.gz', {'k': [1, 2]}, files, [0])
    assert (tmp_path / 'a.json.gz').read_bytes() == first          # gzip mtime 0
    assert json.loads(gzip.decompress(first)) == {'k': [1, 2]}
    assert files['a.json.gz'] == {'bytes': len(first), 'json_bytes': len(b'{"k":[1,2]}')}
