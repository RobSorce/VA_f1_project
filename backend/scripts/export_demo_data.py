"""
Static demo data of the GitHub Pages build: frontend/public/data/.

GitHub Pages serves only the static build of the frontend, so every /api call
there would 404. The demo build (``vite build --mode demo``, see
frontend/src/utils/demoMode.js) answers the API from the files written here
(frontend/src/utils/demoData.js), and a dev build falls back to them when the
local backend does not answer. The files are the backend's own answers, built
by calling its route functions and processors, so a demo answer is the
backend's answer to the same request:

- manifest.json: the demo races (with what makes each one worth showing,
  counted from its rows), the seasons, the frame step, every file and its size.
- schedule_{year}.json.gz: GET /api/schedule/{year}, the events of the demo races.
- {year}_{round}_R/session.json.gz: GET /api/session (api/main.py load_session);
  /api/drivers, /circuit, /strategy, /results, /weather and /laptimes are
  read from it.
- {year}_{round}_R/frames.json.gz: GET /api/frames, every FRAME_STEP-th frame
  (frame dt 0.4 s -> 0.8 s; the last kept frame still triggers the end-of-race
  rule of raceTime.resolveSessionNow, currentTime + frameDt > max_time),
  positions rounded to whole FastF1 units (1/10 m), speed and throttle to 0.1.
- {year}_{round}_R/analytics.json.gz: GET /api/analytics/sectors,
  /consistency and /speed-rankings.
- championship_{year}.json.gz: GET /api/championship/{year} (cached sessions only).
- pca/embeddings.json.gz: GET /api/pca/embeddings (the post-race biplot).
- pca/matrix.json.gz: the post-race feature matrix analyze_selection compares
  (pca_compute._load_matrix, in its row order).
- pca/strategies.json.gz: the post-race stints of every race of the matrix
  (pca_compute._strategy_of_race), the strategies of analyze_selection.
- pca/fit_without_{year}_{round}.json.gz: the biplot during a replay of that
  race before any of its laps (pca_compute.pca_embeddings_at), and the basis
  it is projected on (fill medians, scaler, PCA), so that the frontend
  projects the race's rows at any replay clock
  (frontend/src/utils/pcaSelectionStats.js).

The model features (LSTM forecast, Gemini), telemetry, live timing and the
other sessions of a weekend are not exported: the demo says they need the
local backend. Gzip files are written with mtime 0, so an unchanged export is
byte-identical (no repository growth on a re-run). NaN / inf (Python's json
writes bare NaN, which JSON.parse rejects) are written as null; the count is
reported.

Run from backend/:
    python -m scripts.export_demo_data [--out DIR] [--report FILE]
"""
import argparse
import asyncio
import contextlib
import gzip
import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))

DEFAULT_OUT = BACKEND.parent / 'frontend' / 'public' / 'data'

# The demo races: (year, round, why it is in the demo). Monza 2024 is the race
# every methodology document uses; 2024 R5 (China) is a safety-car race and
# 2025 R1 (Australia) a wet race; 2025 R16 (Monza) and 2024 R7 (Emilia
# Romagna, Imola) carry the use cases of a pit-stop rejoin into traffic and of
# an undercut. Only races whose session and replay frames are cached can be
# exported (2024 R21, Sao Paulo, has no cached frames).
DEMO_RACES = (
    (2024, 16, 'reference race of the methodology documents'),
    (2024, 5, 'safety-car race'),
    (2025, 1, 'wet race'),
    (2025, 16, 'use case: box now or wait for a gap in traffic'),
    (2024, 7, 'use case: undercut or cover'),
)

# Every FRAME_STEP-th replay frame is kept (0.4 s -> 0.8 s between frames).
# ASSUMPTION: 2. Measured on the first three demo races (2024 R16, 2024 R5,
# 2025 R1; gzip size of the frames at each step, a one-off measurement):
# every frame with whole positions = 9.71 MB gzip in total, every 2nd =
# 5.02 MB, every 3rd = 3.40 MB;
# 2 keeps the corners of the track map (a chord of 0.8 s) and half the size.
FRAME_STEP = 2

# Track-status codes counted for the manifest (FIA / FastF1 TrackStatus)
SAFETY_CAR = '4'
VIRTUAL_SAFETY_CAR = '6'
WET_COMPOUNDS = ('INTERMEDIATE', 'WET')

# Repository budget of the demo data, bytes (course rule: the repo grows by at
# most 20 MB in total)
BUDGET_BYTES = 20 * 1000 * 1000


def sanitize(obj, counter=None):
    """A JSON-safe copy of ``obj``: NaN / inf -> None (counted in counter[0])."""
    if counter is None:
        counter = [0]
    if isinstance(obj, float):
        if math.isfinite(obj):
            return obj
        counter[0] += 1
        return None
    if isinstance(obj, dict):
        return {k: sanitize(v, counter) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v, counter) for v in obj]
    if hasattr(obj, 'item') and not isinstance(obj, (str, bytes)):
        return sanitize(obj.item(), counter)  # numpy scalar
    return obj


def encode(obj):
    """Compact JSON bytes (NaN refused: sanitize first)."""
    return json.dumps(obj, separators=(',', ':'), allow_nan=False).encode('utf-8')


def write_file(out_dir, rel, obj, files, counter):
    """Write ``obj`` (sanitized) to out_dir/rel (gzip when rel ends in .gz, mtime 0)."""
    data = encode(sanitize(obj, counter))
    raw = len(data)
    if rel.endswith('.gz'):
        data = gzip.compress(data, compresslevel=9, mtime=0)
    path = Path(out_dir) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    files[rel] = {'bytes': len(data), 'json_bytes': raw}
    return path


def _round_number(v, digits):
    """Round a float; integral results become ints (shorter JSON)."""
    if not isinstance(v, float) or not math.isfinite(v):
        return v
    r = round(v, digits) if digits else float(round(v))
    return int(r) if r == int(r) else r


def slim_frames(data, step=FRAME_STEP):
    """The replay frames of GET /api/frames for the demo: every ``step``-th
    frame from the first, x / y to whole FastF1 units (1/10 m), speed and
    throttle to 0.1, integral floats as ints; every other key unchanged.
    Qualifying payloads (segments) are not handled (the demo has races only)."""
    frames = data.get('frames') or []
    out = []
    for f in frames[::step]:
        drivers = {}
        for code, v in (f.get('drivers') or {}).items():
            e = dict(v)
            for key in ('x', 'y'):
                e[key] = _round_number(e.get(key), 0)
            for key in ('speed', 'throttle'):
                e[key] = _round_number(e.get(key), 1)
            for key in ('brake', 'tyre_life', 'gear', 'drs', 'lap', 'tyre'):
                if isinstance(e.get(key), float):
                    e[key] = _round_number(e[key], 6)
            drivers[code] = e
        out.append({**{k: v for k, v in f.items() if k != 'drivers'}, 'drivers': drivers})
    return {**{k: v for k, v in data.items() if k != 'frames'}, 'frames': out, 'demo_frame_step': step}


def race_facts(payload):
    """What makes a demo race worth showing, counted from its rows: laps,
    safety-car / virtual-safety-car periods, laps on wet-weather tyres, weather
    samples with rainfall."""
    laps = payload.get('lap_times') or []
    max_lap = max((int(lt['LapNumber']) for lt in laps
                   if isinstance(lt.get('LapNumber'), (int, float)) and math.isfinite(lt['LapNumber'])), default=0)
    status = [str(t.get('status')) for t in payload.get('track_status') or []]
    weather = payload.get('weather_data') or []
    return {
        'laps': max_lap,
        'drivers': len(payload.get('driver_info') or []),
        'safety_car_periods': status.count(SAFETY_CAR),
        'virtual_safety_car_periods': status.count(VIRTUAL_SAFETY_CAR),
        'wet_tyre_laps': sum(1 for lt in laps if str(lt.get('Compound')).upper() in WET_COMPOUNDS),
        'lap_rows': len(laps),
        'rain_samples': sum(1 for w in weather if w.get('Rainfall') is True),
        'weather_samples': len(weather),
    }


@contextlib.contextmanager
def _backend():
    """api.main with its side effects off while the export runs: no disk-cache
    writes, no FastF1 loads (the export only reads the processed cache). The
    two functions are restored afterwards (the test suite shares api.main)."""
    import api.main as main
    saved = main._save_to_disk, main.get_raw_session
    main._save_to_disk = lambda *a, **k: None
    main.get_raw_session = lambda *a, **k: None
    try:
        yield main
    finally:
        main._save_to_disk, main.get_raw_session = saved


def pca_reference(pc, df):
    """The component signs of the post-race biplot (pca_embeddings_at's reference)."""
    base = pc.load_pca_embeddings()
    by_feat = {l['feature']: l for l in base.get('loadings') or []}
    return [[by_feat.get(c, {}).get(f'pc{k + 1}', 0.0) for c in pc.FEATURE_COLS if c in df.columns]
            for k in range(2)]


def fit_without_payload(pc, df, year, round_num):
    """pca/fit_without_{year}_{round}: the biplot during a replay of the race
    before any of its laps (pca_embeddings_at at session_now 0: the basis is
    fitted without the race, no row of it yet) and the basis itself."""
    rest, fit = pc._fit_without(df, year, round_num, pca_reference(pc, df))
    payload = pc.pca_embeddings_at(year, round_num, 0.0)
    payload.pop('current_race', None)
    if any(p['year'] == year and p['round'] == round_num for p in payload['points']):
        raise RuntimeError(f'{year} R{round_num}: rows of the race at session_now 0')
    if len(payload['points']) != len(rest):
        raise RuntimeError(f'{year} R{round_num}: {len(payload["points"])} points, {len(rest)} rows without the race')
    cols = fit['cols']
    med = fit['medians']
    return {
        'payload': payload,
        'fit': {
            'cols': cols,
            'medians': [float(med[c]) if c in med.index and not math.isnan(med[c]) else None for c in cols],
            'scaler_mean': [float(v) for v in fit['scaler'].mean_],
            'scaler_scale': [float(v) for v in fit['scaler'].scale_],
            'pca_mean': [float(v) for v in fit['pca'].mean_],
            'components': [[float(v) for v in row] for row in fit['pca'].components_],
        },
    }


def matrix_payload(pc, df):
    """The post-race matrix analyze_selection compares, columnar, in row order."""
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    columns = ['driver', 'team', 'year', 'round', 'race_name'] + cols
    rows = []
    for rec in df[columns].to_dict('records'):
        rows.append([rec['driver'], rec['team'], int(rec['year']), int(rec['round']), rec['race_name']]
                    + [None if v is None or (isinstance(v, float) and not math.isfinite(v)) else float(v)
                       for v in (rec[c] for c in cols)])
    return {'columns': columns, 'feature_cols': cols, 'rows': rows}


def strategies_payload(pc, df):
    """{'{year}_{round}': {driver: visible stints at the end}} of every race of the matrix."""
    out = {}
    for y, r in sorted({(int(y), int(r)) for y, r in zip(df['year'], df['round'])}):
        out[f'{y}_{r}'] = pc._strategy_of_race(y, r, math.inf)
    return out


def export(out_dir=DEFAULT_OUT, races=DEMO_RACES, frame_step=FRAME_STEP, log=print):
    """Write every demo file under out_dir; returns the manifest."""
    with _backend() as main:
        return _export(main, out_dir, races, frame_step, log)


def _export(main, out_dir, races, frame_step, log):
    from api.routers import analytics
    from data.processors import pca_compute as pc

    out_dir = Path(out_dir)
    files, nan_count = {}, [0]
    names = pc._schedule_names()
    manifest_races = []
    for year, round_num, why in races:
        key = f'{year}_{round_num}_R'
        payload = main.load_session(year, round_num, 'R')
        write_file(out_dir, f'{key}/session.json.gz', payload, files, nan_count)
        frames = asyncio.run(main.get_race_frames(year, round_num, 'R'))
        write_file(out_dir, f'{key}/frames.json.gz', slim_frames(frames, frame_step), files, nan_count)
        write_file(out_dir, f'{key}/analytics.json.gz', {
            'sectors': asyncio.run(analytics.get_sector_rankings(year, round_num, 'R')),
            'consistency': asyncio.run(analytics.get_consistency(year, round_num, None, 'R')),
            'speed_rankings': asyncio.run(analytics.get_speed_rankings(year, round_num, 'R')),
        }, files, nan_count)
        write_file(out_dir, f'pca/fit_without_{year}_{round_num}.json.gz',
                   fit_without_payload(pc, pc._load_matrix(), year, round_num), files, nan_count)
        facts = race_facts(payload)
        manifest_races.append({
            'year': year, 'round': round_num, 'session_type': 'R',
            'race_name': names.get((year, round_num), f'Round {round_num}'),
            'why': why, 'frames_in_backend': len(frames.get('frames') or []),
            'frames_in_demo': len((frames.get('frames') or [])[::frame_step]),
            **facts,
        })
        log(f'{year} R{round_num}: {facts}')

    years = sorted({y for y, _, _ in races}, reverse=True)
    for year in years:
        sched = asyncio.run(main.get_schedule(year))
        rounds = {r for y, r, _ in races if y == year}
        events = [e for e in sched.get('events') or [] if e.get('RoundNumber') in rounds]
        write_file(out_dir, f'schedule_{year}.json.gz', {**sched, 'events': events}, files, nan_count)
        try:
            champ = asyncio.run(main.get_championship(year))
            write_file(out_dir, f'championship_{year}.json.gz', champ, files, nan_count)
        except Exception as e:  # noqa: BLE001 - a season without cached results has no standings
            log(f'championship {year}: not exported ({e})')

    df = pc._load_matrix()
    write_file(out_dir, 'pca/embeddings.json.gz', pc.load_pca_embeddings(), files, nan_count)
    write_file(out_dir, 'pca/matrix.json.gz', matrix_payload(pc, df), files, nan_count)
    write_file(out_dir, 'pca/strategies.json.gz', strategies_payload(pc, df), files, nan_count)

    total = sum(f['bytes'] for f in files.values())
    manifest = {
        'description': 'Static demo data of the GitHub Pages build (backend/scripts/export_demo_data.py)',
        'seasons': years,
        'races': manifest_races,
        'frame_step': frame_step,
        'frame_dt_s': None,
        'backend_only': ['forecast', 'gemini', 'telemetry', 'live', 'other_sessions'],
        'nan_written_as_null': nan_count[0],
        'files': dict(sorted(files.items())),
        'total_bytes': total,
        'budget_bytes': BUDGET_BYTES,
    }
    first = slim_frames({'frames': (frames.get('frames') or [])[:frame_step + 1]}, frame_step)['frames']
    if len(first) > 1:
        manifest['frame_dt_s'] = round(first[1]['t'] - first[0]['t'], 6)
    data = json.dumps(manifest, indent=1, allow_nan=False).encode('utf-8')
    (out_dir / 'manifest.json').write_bytes(data)
    manifest['total_bytes_with_manifest'] = total + len(data)
    return manifest


def report_lines(manifest):
    lines = ['Demo data export (backend/scripts/export_demo_data.py)', '']
    for r in manifest['races']:
        lines.append(f"{r['year']} R{r['round']} {r['race_name']} ({r['why']}): {r['laps']} laps, "
                     f"{r['drivers']} drivers, safety car periods {r['safety_car_periods']}, "
                     f"VSC periods {r['virtual_safety_car_periods']}, laps on wet-weather tyres "
                     f"{r['wet_tyre_laps']} of {r['lap_rows']}, rain samples {r['rain_samples']} of "
                     f"{r['weather_samples']}; frames {r['frames_in_backend']} -> {r['frames_in_demo']}")
    lines.append('')
    lines.append(f"frame step {manifest['frame_step']}, frame dt {manifest['frame_dt_s']} s")
    lines.append(f"NaN / inf written as null: {manifest['nan_written_as_null']}")
    lines.append('')
    lines.append(f"{'file':52s} {'bytes':>10s} {'json bytes':>12s}")
    for rel, f in manifest['files'].items():
        lines.append(f"{rel:52s} {f['bytes']:>10d} {f['json_bytes']:>12d}")
    total = manifest.get('total_bytes_with_manifest', manifest['total_bytes'])
    lines.append('')
    lines.append(f"total {total} bytes = {total / 1e6:.2f} MB (budget {manifest['budget_bytes'] / 1e6:.0f} MB)")
    return lines


def main_cli(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', default=str(DEFAULT_OUT), help='output directory (default frontend/public/data)')
    ap.add_argument('--report', default=None, help='also write the size report to this file')
    args = ap.parse_args(argv)
    manifest = export(args.out)
    lines = report_lines(manifest)
    text = '\n'.join(lines) + '\n'
    print(text)
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    if manifest.get('total_bytes_with_manifest', 0) > BUDGET_BYTES:
        print('over the repository budget', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main_cli())
