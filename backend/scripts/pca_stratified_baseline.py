"""
The random baseline of the lasso analysis during a replay, stratified by row
kind, and the content key of its cache (data/processors/pca_compute.py).

During a replay the analysis compares rows of the race on screen, computed
from the laps completed at the clock (kind 'session_now'), with whole-race
rows of the finished races (kind 'post-race'). The baseline used to draw its
random selections from all rows: a selection of rows of the race in progress
then differed from random selections in the progress-dependent features
(pit stops, stint lengths) by the mix alone. Now each random selection
reproduces the selection's composition (k rows of the race on screen, m rows
of finished races, each drawn from the rows of its kind).

Run from backend/:
    python -m scripts.pca_stratified_baseline [--trials 200] [--out REPORT.txt]

1. For each replay clock (RACES x SHARES of the leader's laps):
   a. every row of the race on screen selected: the features flagged above
      random with the former baseline (all rows) and with the stratified one;
   b. ``trials`` random selections of 2 to 8 rows of the race on screen only:
      share flagging a progress-dependent feature, and any feature;
   c. ``trials`` random mixed selections (1 to 5 rows of the race on screen,
      1 to 5 of finished races): share flagging any feature (family-wise:
      about 5% expected for a stratified random selection).
   The former rule is rebuilt here: random_selection_baseline without strata,
   flag = |g| > its family-wise threshold. The stratified column is the
   shipped pca_compute.feature_differences: with rows of two kinds each
   feature is held to its own threshold (THRESHOLD_PER_FEATURE; why and how
   it compares with one threshold for all: scripts/pca_mixed_threshold.py).
   The one-threshold rule (one threshold for all features) is the column round4
   of scripts/pca_mixed_threshold.py.
2. Post-race (one kind): the stratified baseline is the former one.
3. Cache key: two clocks inside one leader lap (CACHE_LAPS below), and
   one value of the post-race matrix changed. The former key (file, length;
   year, round, lap, number of rows of the race) against the content key
   (pca_compute.baseline_cache_key), and the served answer at the later clock
   after a request at the earlier one against a fresh one.
"""
import argparse
import json
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402
from data.processors.stints import leader_lap_times  # noqa: E402

RACES = [(2024, 16), (2025, 1), (2024, 8), (2024, 21), (2025, 8)]
SHARES = (0.25, 0.5, 0.75)

# Seed of the random selections (independent of pca_compute.SELECTION_SEED)
TRIAL_SEED = 7

# Laps of the cache-key probe (section 3): two clocks inside each of them
CACHE_LAPS = [(2024, 21, 50), (2024, 16, 20), (2025, 8, 20)]


def clock_after(payload, lap):
    return leader_lap_times(payload['lap_times'])[lap][1] + 1.0


def former_flags(V, mask, cache):
    """Features flagged by the former rule: unstratified baseline of the
    selection size, |g| > its family-wise threshold."""
    n = int(mask.sum())
    if n not in cache:
        cache[n] = pc.random_selection_baseline(V, n)
    thr = cache[n]['max_p95']
    out = []
    for j, col in enumerate(pc.FEATURE_COLS):
        x, y = V[mask, j], V[~mask, j]
        x, y = x[~np.isnan(x)], y[~np.isnan(y)]
        if not len(x) or not len(y):
            continue
        g = pc.hedges_g(x, y)
        if not np.isnan(g) and thr is not None and abs(g) > thr:
            out.append(col)
    return out


def new_flags(df, mask):
    return [f['feature'] for f in pc.feature_differences(df, mask)['feature_importance'] if f['exceeds_random']]


def former_key(year, rnd, now):
    """The cache key analyze_selection used before (file mtime and length of
    the matrix; year, round, leader lap and rows of the race at the clock)."""
    df = pc._load_matrix()
    path = pc.PROCESSED_DIR / pc.MATRIX_FILE
    key = ('post-race', path.stat().st_mtime if path.exists() else 0, len(df))
    cur = pc.current_race_rows(year, rnd, now)
    lap = int(cur['as_of_lap'].iloc[0]) if cur is not None and not cur.empty else 0
    return key + (int(year), int(rnd), lap, 0 if cur is None else len(cur))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trials', type=int, default=200)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    lines = []

    def say(s=''):
        print(s, flush=True)
        lines.append(s)

    rng = random.Random(TRIAL_SEED)
    progress = set(pc.PROGRESS_DEPENDENT_FEATURES)
    say(f'PROGRESS_DEPENDENT_FEATURES = {list(pc.PROGRESS_DEPENDENT_FEATURES)}; {args.trials} random selections '
        f'per clock and type (seed {TRIAL_SEED}); baseline {pc.BASELINE_DRAWS} draws, seed {pc.SELECTION_SEED}')

    # 1. Replay clocks
    say()
    say('== 1. replay clocks: former baseline (all rows) vs stratified (same mix); b = random selections of 2 to 8 '
        'rows of the race on screen, c = 1 to 5 rows of it + 1 to 5 rows of finished races')
    say(f'{"race":<10}{"lap":>4}{"live":>5} | {"a. all live rows flagged: former -> stratified":<62}| '
        f'{"b. live-only: progress / any":>30} | {"c. mixed: any":>16}')
    tot = {'b_prog': [0, 0], 'b_any': [0, 0], 'c_any': [0, 0], 'n_b': 0, 'n_c': 0, 'clocks': 0, 'races': set()}
    for year, rnd in RACES:
        payload = pc._load_payload(year, rnd)
        if payload is None:
            continue
        total = max(leader_lap_times(payload['lap_times']))
        for share in SHARES:
            lap = max(1, int(round(share * total)))
            now = clock_after(payload, lap)
            df, _ = pc._analysis_matrix(year, rnd, now)
            cols = [c for c in pc.FEATURE_COLS if c in df.columns]
            V = df[cols].astype(float).replace([np.inf, -np.inf], np.nan).to_numpy()
            live_idx = np.flatnonzero(df['as_of'].to_numpy() == pc.ROW_LIVE)
            fin_idx = np.flatnonzero(df['as_of'].to_numpy() == pc.ROW_FINISHED)
            if len(live_idx) < 3:
                continue
            cache = {}
            mask = np.zeros(len(df), bool)
            mask[live_idx] = True
            a_old, a_new = former_flags(V, mask, cache), new_flags(df, mask)
            b = {'old_prog': 0, 'new_prog': 0, 'old_any': 0, 'new_any': 0}
            for _ in range(args.trials):
                k = rng.randint(2, min(8, len(live_idx) - 1))
                mask = np.zeros(len(df), bool)
                mask[rng.sample(list(live_idx), k)] = True
                fo, fn = former_flags(V, mask, cache), new_flags(df, mask)
                b['old_prog'] += bool(progress & set(fo))
                b['new_prog'] += bool(progress & set(fn))
                b['old_any'] += bool(fo)
                b['new_any'] += bool(fn)
            c = {'old': 0, 'new': 0}
            for _ in range(args.trials):
                k, m = rng.randint(1, min(5, len(live_idx))), rng.randint(1, 5)
                mask = np.zeros(len(df), bool)
                mask[rng.sample(list(live_idx), k)] = True
                mask[rng.sample(list(fin_idx), m)] = True
                c['old'] += bool(former_flags(V, mask, cache))
                c['new'] += bool(new_flags(df, mask))
            t = args.trials
            tot['b_prog'][0] += b['old_prog']
            tot['b_prog'][1] += b['new_prog']
            tot['b_any'][0] += b['old_any']
            tot['b_any'][1] += b['new_any']
            tot['c_any'][0] += c['old']
            tot['c_any'][1] += c['new']
            tot['n_b'] += t
            tot['n_c'] += t
            tot['clocks'] += 1
            tot['races'].add((year, rnd))
            a_txt = f'{",".join(a_old) or "-"} -> {",".join(a_new) or "-"}'
            say(f'{year} R{rnd:<4}{lap:>4}{len(live_idx):>5} | {a_txt:<62}| '
                f'{b["old_prog"] / t:5.1%} -> {b["new_prog"] / t:5.1%} / {b["old_any"] / t:5.1%} -> '
                f'{b["new_any"] / t:5.1%} | {c["old"] / t:5.1%} -> {c["new"] / t:5.1%}')
    nb, nc = tot['n_b'], tot['n_c']
    say(f'all {tot["clocks"]} clocks of {len(tot["races"])} races: b. live-only selections flagging a '
        f'progress-dependent feature {tot["b_prog"][0] / nb:.1%} '
        f'(former) -> {tot["b_prog"][1] / nb:.1%} (stratified); any feature {tot["b_any"][0] / nb:.1%} -> '
        f'{tot["b_any"][1] / nb:.1%}; c. mixed selections flagging any feature {tot["c_any"][0] / nc:.1%} -> '
        f'{tot["c_any"][1] / nc:.1%} ({nb} and {nc} selections)')

    # 2. Post-race: one kind, same baseline as before
    say()
    say('== 2. post-race (one kind): stratified baseline == former baseline')
    df, _ = pc._analysis_matrix()
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    V = df[cols].astype(float).replace([np.inf, -np.inf], np.nan).to_numpy()
    same = True
    for n in (1, 2, 5, 10, 20, 50):
        old = pc.random_selection_baseline(V, n)
        new = pc.random_selection_baseline(V, {pc.ROW_FINISHED: n}, strata=df['as_of'].to_numpy())
        same = same and old == new
    say(f'  sizes 1, 2, 5, 10, 20, 50: identical {same}')

    # 3. Cache key
    say()
    say('== 3. cache key: two clocks inside one leader lap, and one changed value')
    for year, rnd, lap in CACHE_LAPS:
        payload = pc._load_payload(year, rnd)
        ll = leader_lap_times(payload['lap_times'])
        t1, t2 = ll[lap][1] + 0.5, ll[lap + 1][1] - 0.5
        m1, k1 = pc._analysis_matrix(year, rnd, t1)
        m2, k2 = pc._analysis_matrix(year, rnd, t2)
        cols = [c for c in pc.FEATURE_COLS if c in m1.columns]
        differ = not np.array_equal(np.nan_to_num(m1[cols].to_numpy(float), nan=-9e9),
                                    np.nan_to_num(m2[cols].to_numpy(float), nan=-9e9))
        ids = [f'{d}_{year}_{rnd}' for d in ['VER', 'NOR', 'LEC', 'PIA', 'SAI']]
        pc._baseline_cache.clear()
        fresh = pc.analyze_selection(ids, None, year, rnd, t2)
        pc._baseline_cache.clear()
        pc.analyze_selection(ids, None, year, rnd, t1)
        after = pc.analyze_selection(ids, None, year, rnd, t2)
        say(f'  {year} R{rnd} lap {lap}: clocks {t1:.1f} / {t2:.1f}; matrices differ {differ}; former key equal '
            f'{former_key(year, rnd, t1) == former_key(year, rnd, t2)}; content key equal {k1 == k2}; answer at '
            f'{t2:.1f} after a request at {t1:.1f} == fresh answer '
            f'{json.dumps(fresh, sort_keys=True) == json.dumps(after, sort_keys=True)}')
    df, k0 = pc._analysis_matrix()
    real = pc._load_matrix
    changed = df.drop(columns=['as_of']).copy()
    changed.loc[0, 'pace_delta_pct'] = changed.loc[0, 'pace_delta_pct'] + 50.0
    pc._load_matrix = lambda: changed
    try:
        _, k1 = pc._analysis_matrix()
        ids = [f'{d}_{y}_{r}' for d, y, r in zip(df['driver'][1:6], df['year'][1:6], df['round'][1:6])]
        pc._baseline_cache.clear()
        fresh = pc.analyze_selection(ids)
        pc._load_matrix = real
        pc.analyze_selection(ids)
        pc._load_matrix = lambda: changed
        after = pc.analyze_selection(ids)
    finally:
        pc._load_matrix = real
    say(f'  one value of the post-race matrix changed (row 0 pace_delta_pct + 50, same length): content key '
        f'equal {k0 == k1}; answer after a request on the unchanged matrix == fresh answer '
        f'{json.dumps(fresh, sort_keys=True) == json.dumps(after, sort_keys=True)}')

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
