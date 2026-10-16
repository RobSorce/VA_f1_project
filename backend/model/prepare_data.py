"""
LSTM Training Data Preparation
Builds the forecast windows of every cached race with the ONE window builder
of model/features.py (build_window), the function the endpoint serves with.

Source: the processed session payloads data/processed_cache/session_{year}_{round}_R.json
(the rows api/main.py load_session serves), never the raw FastF1 cache, so a
training row and a served row come from the same payload shape.

One sample per driver and completed lap (the origin): build_window at the
end of that lap (the serving call at any clock until the driver's next lap
ends gives the same window). Labels, built from the whole race (the future
is read for labels only):
  y[:, :PREDICT_LEN]  lap time of origin + k minus the window's reference
                      time (last clean lap), k = 1..PREDICT_LEN; NaN when
                      lap origin + k is not a clean lap (degradation.py
                      is_clean_lap: green, no pit in-lap / out-lap) of the
                      origin's stint (a stop or the race end comes first).
  y[:, PREDICT_LEN]   1 when the origin's stint ends with a stop (a tyre
                      change, build_tyre_strategy; decision R2) on one
                      of the next PREDICT_LEN laps, else 0.
Outputs (model/saved): lstm_X.npy (unscaled windows, features.FEATURES
order), lstm_y.npy, lstm_meta.json (race, driver, origin lap of each row,
and x_sha1 of the windows; model/train.py refuses to train without it).
The scaler and the label statistics are fitted on the training races only,
in model/train.py.
"""
import datetime
import json
import logging
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))

from data.processors.degradation import _lap_end_time, is_clean_lap  # noqa: E402
from data.processors.stints import _group_by_driver, _number, build_tyre_strategy  # noqa: E402
from model import features  # noqa: E402

logger = logging.getLogger(__name__)

SEQUENCE_LEN = features.SEQUENCE_LEN
# Laps of the lap-time targets and of the pit label (literal: read from this
# source by tests/test_predictions_pit_timing.py; equal to features.PREDICT_LEN)
PREDICT_LEN = 5
if PREDICT_LEN != features.PREDICT_LEN:
    raise ImportError('prepare_data.PREDICT_LEN must equal model/features.py PREDICT_LEN')

# 2018 up to the next season (clock year + 1): a season is used only when its races
# are cached, which needs a published schedule (see discover_processed_cache_rounds)
YEARS = list(range(2018, datetime.date.today().year + 2))

CACHE_DIR = Path(__file__).parent.parent / 'data' / 'processed_cache'
MODEL_DIR = Path(__file__).parent / 'saved'


def discover_processed_cache_rounds(cache_dir: Path = CACHE_DIR) -> list:
    """
    Discover race sessions from processed JSON cache files.
    Scans for files matching session_{year}_{round}_R.json.
    Returns list of (year, round_number, 'json') tuples, sorted.
    """
    discovered = []
    if not cache_dir.exists():
        return discovered

    pattern = re.compile(r'^session_(\d{4})_(\d+)_R\.json$')
    for f in sorted(cache_dir.iterdir()):
        m = pattern.match(f.name)
        if m:
            year, round_num = int(m.group(1)), int(m.group(2))
            if year in YEARS:
                discovered.append((year, round_num, 'json'))
                logger.info(f"Discovered JSON cache: {year} R{round_num}")

    return sorted(discovered)


def race_id(year: int, round_num: int) -> str:
    """'2024-16': the race key of lstm_meta.json and of the split."""
    return f'{int(year)}-{int(round_num)}'


def load_payload(year: int, round_num: int, cache_dir: Path = CACHE_DIR) -> dict:
    with open(cache_dir / f'session_{year}_{round_num}_R.json', encoding='utf-8') as fh:
        return json.load(fh)


def _labels(by_lap, stint, origin_lap, ref_time, last_stint):
    """(deltas, times, pit) of one sample (see the module docstring)."""
    times = []
    for k in range(1, PREDICT_LEN + 1):
        n = origin_lap + k
        r = by_lap.get(n)
        ok = (r is not None and stint is not None and stint['StartLap'] <= n <= stint['EndLap']
              and is_clean_lap(r))
        times.append(_number(r.get('LapTimeSeconds')) if ok else np.nan)
    pit = 0.0
    if stint is not None and not last_stint and origin_lap + 1 <= stint['EndLap'] <= origin_lap + PREDICT_LEN:
        pit = 1.0
    deltas = [t - ref_time if not np.isnan(t) else np.nan for t in times]
    return deltas, times, pit


def samples_from_payload(payload: dict, race: str = None, keep_context: bool = False) -> list:
    """Every sample of one race: one per driver and origin lap (see the module
    docstring). Each sample: {race, driver, origin_lap, x (SEQUENCE_LEN x
    N_FEATURES), y_delta (PREDICT_LEN, NaN = no target), y_time, pit}, plus
    ctx (the build_window dict) with keep_context."""
    rows = [r for r in payload.get('lap_times') or [] if isinstance(r, dict)]
    weather = payload.get('weather_data') or []
    stints_by_driver = {}
    for st in build_tyre_strategy(rows):
        stints_by_driver.setdefault(st['Driver'], []).append(st)
    out = []
    for driver, drows in _group_by_driver(rows).items():
        by_lap = {int(_number(r.get('LapNumber'))): r for r in drows}
        d_stints = stints_by_driver.get(driver, [])
        seen = set()
        for r in drows:
            end = _lap_end_time(r)
            if end is None:
                continue
            ctx = features.build_window(drows, driver, session_now=end, weather_rows=weather)
            if ctx['features'] is None or ctx['origin_lap'] in seen:
                continue
            seen.add(ctx['origin_lap'])
            lap = ctx['origin_lap']
            idx = next((i for i, s in enumerate(d_stints) if s['StartLap'] <= lap <= s['EndLap']), None)
            stint = d_stints[idx] if idx is not None else None
            last_stint = idx is None or idx == len(d_stints) - 1
            deltas, times, pit = _labels(by_lap, stint, lap, ctx['ref_time'], last_stint)
            s = {'race': race, 'driver': driver, 'origin_lap': lap, 'x': ctx['features'],
                 'y_delta': deltas, 'y_time': times, 'pit': pit}
            if keep_context:
                s['ctx'] = ctx
            out.append(s)
    return out


def prepare_sequences(cache_dir: Path = CACHE_DIR):
    """
    Build (X, y, meta) for the LSTM across every cached race payload.

    X:    (n_samples, SEQUENCE_LEN, N_FEATURES) unscaled windows
    y:    (n_samples, PREDICT_LEN + 1) lap-time deltas to the reference lap
          (NaN = no target) + the pit label
    meta: [{race, driver, origin_lap}] per row
    """
    rounds = discover_processed_cache_rounds(cache_dir)
    logger.info(f"Discovered {len(rounds)} race(s) total")
    all_X, all_y, meta = [], [], []
    for year, round_num, _ in rounds:
        rid = race_id(year, round_num)
        samples = samples_from_payload(load_payload(year, round_num, cache_dir), rid)
        logger.info(f"{rid}: {len(samples)} windows")
        for s in samples:
            all_X.append(s['x'])
            all_y.append(list(s['y_delta']) + [s['pit']])
            meta.append({'race': rid, 'driver': s['driver'], 'origin_lap': s['origin_lap']})

    if not all_X:
        logger.error("No training sequences generated!")
        return np.zeros((0, SEQUENCE_LEN, features.N_FEATURES), np.float32), np.zeros((0, PREDICT_LEN + 1), np.float32), []

    X = np.asarray(all_X, dtype=np.float32)
    y = np.asarray(all_y, dtype=np.float32)
    logger.info(f"Prepared LSTM data: X={X.shape}, y={y.shape}")
    return X, y, meta


def save_sequences(X, y, meta, output_dir: Path = MODEL_DIR):
    output_dir.mkdir(parents=True, exist_ok=True)
    np.save(output_dir / 'lstm_X.npy', X)
    np.save(output_dir / 'lstm_y.npy', y)
    # x_sha1 ties the meta rows to these windows (model/train.py race_rows
    # refuses a meta file saved with other windows)
    from model.train import windows_fingerprint
    with open(output_dir / 'lstm_meta.json', 'w', encoding='utf-8') as f:
        json.dump({'features': features.FEATURES, 'predict_len': PREDICT_LEN,
                   'x_sha1': windows_fingerprint(X), 'rows': meta}, f)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    X, y, meta = prepare_sequences()
    if X.size == 0:
        print("No training sequences generated!")
        sys.exit(1)
    save_sequences(X, y, meta)
    races = sorted({m['race'] for m in meta})
    print(f"Saved: X={X.shape}, y={y.shape}, {len(races)} races, to {MODEL_DIR}")
    print(f"Targets present: {np.mean(~np.isnan(y[:, :PREDICT_LEN])):.1%} of lap slots; "
          f"pit label rate {y[:, PREDICT_LEN].mean():.3f}")
