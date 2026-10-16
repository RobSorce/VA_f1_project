"""
The family-wise threshold of the lasso analysis when the compared rows mix
row kinds (data/processors/pca_compute.py, feature_differences).

During a replay the analysis compares rows of the race on screen, computed
from the laps completed at the clock, with whole-race rows of the finished
races, and its random baseline draws the selection's mix of the two kinds
(stratified). In those random selections the progress-dependent features
(pit stops, stint lengths, tyre degradation) reach far larger |g| than the
others, by the mix alone. The one-threshold rule (round4 below) held every
feature to the 95th percentile of the largest |g| over all features: that
maximum was theirs, and pace, sectors, consistency and grid could almost never
pass it (section 1 below measures it). The shipped rule, with rows
of two kinds, holds each feature to its own threshold: the same quantile
level of its own random |g| for every feature, chosen so that 5% of the random
selections pass the threshold of some feature (pca_compute
.common_level_thresholds). Rows of one kind (post-race) keep the round4 rule.

Run from backend/:
    python -m scripts.pca_mixed_threshold [--out REPORT.txt]

Rules compared (flag = |g| above the threshold beyond rounding, pca_compute._above):
  former   unstratified baseline of the selection size, max over the 12 features
  round4   stratified baseline, max over the 12 features (one threshold)
  shipped  pca_compute.feature_differences (rows of two kinds: per feature)
  np8      stratified baseline, max over the 8 features that are not
           progress-dependent (an alternative rule; it can never flag
           a progress-dependent feature)

1. Power, synthetic: pace_delta_pct of 5
   random rows of the race on screen shifted by delta matrix SDs (copy of the
   matrix), 60 selections per clock and delta (seed 3).
2. Power, real lassos: the 5 rows of the
   race on screen lowest, and highest, in each feature that is not
   progress-dependent, at 6 clocks: is the selected feature flagged?
3. Calibration on random selections (true difference 0), at the
   clocks (2024 R3, 2024 R12, 2025 R6, 2025 R16 at about 20/45/75% of the
   leader's laps): L = 2-8 rows of the race on screen, M = 1-5 of it + 1-5 of
   finished races, F = 2-8 of finished races (the rest holds the live rows);
   150 selections per clock and type (seed 21). Post-race: 200 random
   selections per size (seed 7); shipped == round4 there.
4. Checks.
"""
import argparse
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402
from data.processors.stints import leader_lap_times  # noqa: E402

COLS = list(pc.FEATURE_COLS)
PROG = np.array([c in pc.PROGRESS_DEPENDENT_FEATURES for c in COLS])
NP8 = np.flatnonzero(~PROG)
RULES = ('former', 'round4', 'shipped', 'np8')

POWER_CLOCKS = [(2024, 16, 20), (2024, 12, 15), (2025, 16, 24), (2024, 3, 26)]
REAL_CLOCKS = [(2024, 16, 20), (2024, 12, 15), (2025, 16, 24), (2024, 3, 26), (2024, 7, 30), (2025, 1, 20)]
CALIB_RACES = [(2024, 3), (2024, 12), (2025, 6), (2025, 16)]
CALIB_SHARES = (0.2, 0.45, 0.75)
POST_SIZES = (2, 5, 10, 20)

# Accepted share of random selections with some feature flagged (nominal
# 5%; the same tolerance as scripts/pca_interval_coverage.py)
MAX_NULL_SHARE = 0.075


def clock_after(year, rnd, lap):
    return leader_lap_times(pc._load_payload(year, rnd)['lap_times'])[lap][1] + 1.0


def matrix(year=None, rnd=None, lap=None):
    if year is None:
        df, _ = pc._analysis_matrix()
    else:
        df, _ = pc._analysis_matrix(year, rnd, clock_after(year, rnd, lap))
    return df, df['as_of'].to_numpy()


def composition(mask, kinds):
    live = kinds == pc.ROW_LIVE
    n = {pc.ROW_FINISHED: int((mask & ~live).sum())}
    if live.any():
        n[pc.ROW_LIVE] = int((mask & live).sum())
    return n


def all_flags(df, kinds, mask, cache=None):
    """{rule: set of flagged column indices}, the |g| per column, and
    {rule: threshold per column} for one selection of the matrix ``df``."""
    V = df[COLS].astype(float).replace([np.inf, -np.inf], np.nan).to_numpy()
    cache = {} if cache is None else cache
    n = int(mask.sum())
    comp = composition(mask, kinds)
    ck = ('former', n)
    if ck not in cache:
        cache[ck] = pc.random_selection_baseline(V, n)['max_p95']
    ck_np = ('np8', tuple(sorted(comp.items())))
    if ck_np not in cache:
        cache[ck_np] = pc.random_selection_baseline(V[:, NP8], comp, strata=kinds)['max_p95']
    fd = pc.feature_differences(df, mask)
    by = {f['feature']: f for f in fd['feature_importance']}
    absg = np.array([abs(pc.hedges_g(V[mask, j], V[~mask, j])) for j in range(len(COLS))])
    thr = {
        'former': np.full(len(COLS), cache[ck]),
        'round4': np.full(len(COLS), fd['baseline']['max_p95']),
        'np8': np.where(PROG, np.inf, cache[ck_np]),
    }
    out = {r: {j for j in range(len(COLS)) if np.isfinite(absg[j]) and pc._above(absg[j], thr[r][j])}
           for r in ('former', 'round4', 'np8')}
    if fd['no_random_alternative']:
        out['round4'] = set()
        out['np8'] = set()
    out['shipped'] = {COLS.index(f) for f, v in by.items() if v['exceeds_random']}
    thr['shipped'] = np.array([by[c]['threshold_abs_g'] if c in by and by[c]['threshold_abs_g'] is not None
                               else np.nan for c in COLS])
    return out, absg, thr, fd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    lines = []

    def say(s=''):
        print(s, flush=True)
        lines.append(s)

    checks = {}
    say(f'PROGRESS_DEPENDENT_FEATURES = {list(pc.PROGRESS_DEPENDENT_FEATURES)}; baseline {pc.BASELINE_DRAWS} draws, '
        f'seed {pc.SELECTION_SEED}, quantile {pc.BASELINE_QUANTILE}')
    say('rules: former = unstratified, max over 12 features; round4 = stratified, max over 12; shipped = '
        'pca_compute.feature_differences (rows of two kinds: per-feature thresholds at a common level); '
        'np8 = stratified, max over the 8 features that are not progress-dependent')

    # 1. synthetic power
    say()
    say('== 1. power, synthetic: pace_delta_pct of 5 random rows of the race on screen shifted by delta matrix SDs; '
        '60 selections per clock and delta (seed 3)')
    say(f'{"clock":<18}{"delta":>6} | pace flagged: {" / ".join(RULES)} | median pace threshold: '
        f'{" / ".join(RULES)} | shipped level')
    PJ = COLS.index('pace_delta_pct')
    power_ok = True
    for clk in POWER_CLOCKS + [(None, None, None)]:
        df0, kinds = matrix(*clk)
        name = 'post-race' if clk[0] is None else f'{clk[0]} R{clk[1]} lap {clk[2]}'
        live = np.flatnonzero(kinds == pc.ROW_LIVE)
        pool = live if len(live) else np.arange(len(df0))
        sd = float(df0['pace_delta_pct'].astype(float).std())
        for delta in (1.5, 2.0, 2.5):
            rng = random.Random(3)
            hit = {r: 0 for r in RULES}
            thr = {r: [] for r in RULES}
            levels = []
            trials = 60
            for _ in range(trials):
                sel = rng.sample(list(pool), 5)
                mask = np.zeros(len(df0), dtype=bool)
                mask[sel] = True
                df = df0.copy()
                df.loc[mask, 'pace_delta_pct'] = df.loc[mask, 'pace_delta_pct'].astype(float) - delta * sd
                fl, _, th, fd = all_flags(df, kinds, mask)
                for r in RULES:
                    hit[r] += PJ in fl[r]
                    thr[r].append(th[r][PJ])
                if fd['threshold_level'] is not None:
                    levels.append(fd['threshold_level'])
            lvl = f'{np.median(levels):.3f}' if levels else '-'
            say(f'{name:<18}{delta:>6} | ' + ' / '.join(f'{hit[r] / trials:6.1%}' for r in RULES) + ' | '
                + ' / '.join(f'{np.median(thr[r]):.3f}' for r in RULES) + f' | {lvl}')
            power_ok = power_ok and hit['shipped'] >= hit['round4']
    checks['synthetic: shipped flags pace at least as often as round4 at every clock and delta'] = power_ok

    # 2. real lassos
    say()
    say('== 2. power, real lassos: the 5 rows of the race on screen lowest / highest in a feature that is not '
        'progress-dependent; is that feature flagged?')
    tot = {r: 0 for r in RULES}
    n_sel = 0
    example = None
    for clk in REAL_CLOCKS:
        df, kinds = matrix(*clk)
        live = np.flatnonzero(kinds == pc.ROW_LIVE)
        V = df[COLS].astype(float).to_numpy()
        cache = {}
        per = {r: 0 for r in RULES}
        n_clock = 0
        for j in NP8:
            ok = live[~np.isnan(V[live, j])]
            order = ok[np.argsort(V[ok, j], kind='stable')]
            for side, sel in (('low', order[:5]), ('high', order[-5:])):
                mask = np.zeros(len(V), dtype=bool)
                mask[sel] = True
                fl, absg, th, _ = all_flags(df, kinds, mask, cache)
                n_sel += 1
                n_clock += 1
                for r in RULES:
                    per[r] += j in fl[r]
                    tot[r] += j in fl[r]
                if clk == (2025, 1, 20) and COLS[j] == 'sector1_delta_pct' and side == 'low':
                    example = (f'  2025 R1 lap 20, the 5 lowest in sector1_delta_pct: |g| {absg[j]:.3f}; thresholds '
                               + ', '.join(f'{r} {th[r][j]:.3f}' for r in RULES)
                               + '; flagged ' + ', '.join(f'{r} {j in fl[r]}' for r in RULES))
        say(f'  {clk[0]} R{clk[1]} lap {clk[2]}: {n_clock} selections; flagged ' + ', '.join(
            f'{r} {per[r]}' for r in RULES))
    say(f'  all: {n_sel} selections; the selected feature flagged: ' + ', '.join(f'{r} {tot[r]}' for r in RULES))
    if example:
        say(example)
    checks['real lassos: shipped flags more than round4'] = tot['shipped'] > tot['round4']

    # 3. calibration
    say()
    say('== 3. calibration on random selections (true difference 0): share with some feature flagged '
        '(a progress-dependent one); 150 per clock and type, seed 21')
    say(f'{"race":<10}{"lap":>4}{"live":>5} | ' + ' | '.join(
        f'{t}: round4 / shipped / np8' for t in 'LMF'))
    rng = random.Random(21)
    pooled = {t: {r: [0, 0] for r in ('round4', 'shipped', 'np8')} for t in 'LMF'}
    n_type = {t: 0 for t in 'LMF'}
    for year, rnd in CALIB_RACES:
        total = max(leader_lap_times(pc._load_payload(year, rnd)['lap_times']))
        for share in CALIB_SHARES:
            lap = max(1, int(round(share * total)))
            df, kinds = matrix(year, rnd, lap)
            live = np.flatnonzero(kinds == pc.ROW_LIVE)
            fin = np.flatnonzero(kinds != pc.ROW_LIVE)
            cache = {}
            cells = []
            for t in 'LMF':
                if t in 'LM' and len(live) < 9:
                    cells.append(f'{t}: (too few rows of the race on screen)')
                    continue
                cnt = {r: [0, 0] for r in ('round4', 'shipped', 'np8')}
                trials = 150
                for _ in range(trials):
                    mask = np.zeros(len(df), dtype=bool)
                    if t == 'L':
                        mask[rng.sample(list(live), rng.randint(2, 8))] = True
                    elif t == 'M':
                        mask[rng.sample(list(live), rng.randint(1, 5))] = True
                        mask[rng.sample(list(fin), rng.randint(1, 5))] = True
                    else:
                        mask[rng.sample(list(fin), rng.randint(2, 8))] = True
                    fl, _, _, _ = all_flags(df, kinds, mask, cache)
                    for r in cnt:
                        cnt[r][0] += bool(fl[r])
                        cnt[r][1] += bool({j for j in fl[r] if PROG[j]})
                for r in cnt:
                    pooled[t][r][0] += cnt[r][0]
                    pooled[t][r][1] += cnt[r][1]
                n_type[t] += trials
                cells.append(f'{t}: ' + ' / '.join(
                    f'{cnt[r][0] / trials:5.1%} ({cnt[r][1] / trials:4.1%})' for r in ('round4', 'shipped', 'np8')))
            say(f'{year} R{rnd:<4}{lap:>4}{len(live):>5} | ' + ' | '.join(cells))
    for t in 'LMF':
        n = n_type[t]
        say(f'  all clocks, type {t}: {n} selections; some feature flagged (a progress-dependent one): ' + ', '.join(
            f'{r} {pooled[t][r][0] / n:.1%} ({pooled[t][r][1] / n:.1%})' for r in ('round4', 'shipped', 'np8')))
        checks[f'type {t}: shipped share <= {MAX_NULL_SHARE:.1%}'] = pooled[t]['shipped'][0] / n <= MAX_NULL_SHARE

    say()
    say('   post-race (one kind): random selections, 200 per size (seed 7); shipped vs round4 (the same rule)')
    df, kinds = matrix()
    rng = random.Random(7)
    cache = {}
    same = True
    for size in POST_SIZES:
        cnt = {'round4': 0, 'shipped': 0}
        for _ in range(200):
            mask = np.zeros(len(df), dtype=bool)
            mask[rng.sample(range(len(df)), size)] = True
            fl, _, th, fd = all_flags(df, kinds, mask, cache)
            same = same and fl['shipped'] == fl['round4'] and fd['threshold_rule'] == pc.THRESHOLD_MAX
            same = same and bool(np.allclose(th['shipped'], np.round(th['round4'], 3), equal_nan=True))
            for r in cnt:
                cnt[r] += bool(fl[r])
        say(f'  size {size:>2}: some feature flagged: round4 {cnt["round4"] / 200:.1%}, shipped '
            f'{cnt["shipped"] / 200:.1%}')
    say(f'  post-race flags and thresholds identical to round4: {same}')
    checks['post-race: the rule is unchanged'] = same

    say()
    say('== 4. checks')
    for k, v in checks.items():
        say(f'  {k}: {v}')
    say(f'  all checks pass: {all(checks.values())}')

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
