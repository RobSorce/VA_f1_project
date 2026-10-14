"""
Coverage of the 95% interval of Hedges' g in the lasso-selection analysis
(data/processors/pca_compute.py), on RANDOM selections of the biplot rows:
the selected rows and the other rows come from the same rows, so the true
difference is 0 and a calibrated 95% interval excludes 0 about 5% of the time.

Run from backend/:
    python -m scripts.pca_interval_coverage [--trials 200] [--out REPORT.txt]

For each selection size n (``trials`` seeded random selections, every feature
of FEATURE_COLS) two intervals are computed:
- percentile bootstrap: each group resampled with replacement within itself,
  BOOTSTRAP_RESAMPLES times (the method analyze_selection used before this
  check, kept here as the comparison);
- shipped: pca_compute.g_interval, what analyze_selection returns now (g +/-
  z SE(g), the large-sample SE of a standardized mean difference; none below
  MIN_GROUP_FOR_INTERVAL rows).
Printed per n: intervals excluding 0 / intervals computed, and the median
width. Checked at the end: the shipped interval is withheld below
MIN_GROUP_FOR_INTERVAL and excludes 0 at most MAX_NULL_EXCLUSION of the time
at every tested size from MIN_GROUP_FOR_INTERVAL on; the single-row case of
the percentile bootstrap is shown for one selected row (LEC_2024_16).
"""
import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402

SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50]

# Seed of the random selections (independent of pca_compute.SELECTION_SEED)
TRIAL_SEED = 7

# Resamples of the percentile bootstrap (the former BOOTSTRAP_RESAMPLES)
BOOTSTRAP_RESAMPLES = 1000

# Largest share of random-selection intervals excluding 0 accepted for a
# nominal 95% interval. ASSUMPTION: 1.5 x the nominal 5%, room for the
# Monte Carlo error of the check itself.
MAX_NULL_EXCLUSION = 0.075


def percentile_bootstrap(x, y, resamples=BOOTSTRAP_RESAMPLES, seed=pc.SELECTION_SEED, level=pc.CI_LEVEL):
    """The former interval: percentile bootstrap of Hedges' g, each group
    resampled within itself (seeded). (low, high), or (None, None) when g is
    undefined in most resamples."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(x) < 1 or len(y) < 1:
        return None, None
    c = np.concatenate([x, y]).mean()
    x, y = x - c, y - c
    rng = np.random.default_rng(seed)
    bx = x[rng.integers(0, len(x), (resamples, len(x)))]
    by = y[rng.integers(0, len(y), (resamples, len(y)))]
    g = pc._g_from_sums(len(x), bx.sum(1), (bx * bx).sum(1), len(y), by.sum(1), (by * by).sum(1))
    g = g[~np.isnan(g)]
    if len(g) < resamples / 2:
        return None, None
    a = (1 - level) / 2
    return float(np.quantile(g, a)), float(np.quantile(g, 1 - a))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trials', type=int, default=200)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    lines = []

    def say(s=''):
        print(s, flush=True)
        lines.append(s)

    df = pc._load_matrix()
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    V = df[cols].astype(float).replace([np.inf, -np.inf], np.nan).to_numpy()
    ids = [f'{d}_{int(y)}_{int(r)}' for d, y, r in zip(df['driver'], df['year'], df['round'])]
    n_rows = len(df)
    say(f'rows {n_rows}, features {len(cols)}, random selections per size {args.trials} (seed {TRIAL_SEED}), '
        f'level {pc.CI_LEVEL}')
    say(f'accepted share of intervals excluding 0: <= {MAX_NULL_EXCLUSION:.3f} (nominal {1 - pc.CI_LEVEL:.3f}); '
        f'pca_compute.MIN_GROUP_FOR_INTERVAL = {pc.MIN_GROUP_FOR_INTERVAL}')

    # 1. One selected row: what each method gives
    pid = 'LEC_2024_16'
    say()
    say(f'== 1. one selected row ({pid}): intervals excluding 0 out of the features')
    m = np.array([i == pid for i in ids])
    counts = {'percentile bootstrap': [0, 0], 'shipped': [0, 0]}
    for j in range(len(cols)):
        x = V[m, j]
        y = V[~m, j]
        x, y = x[~np.isnan(x)], y[~np.isnan(y)]
        for name, fn in (('percentile bootstrap', percentile_bootstrap), ('shipped', pc.g_interval)):
            lo, hi = fn(x, y)
            if lo is None:
                continue
            counts[name][1] += 1
            counts[name][0] += int(lo > 0 or hi < 0)
    for name, (ex, tot) in counts.items():
        say(f'  {name}: {ex}/{tot} intervals exclude 0' if tot else f'  {name}: no interval (withheld)')
    shipped_answer = pc.analyze_selection([pid])
    say(f'  analyze_selection([{pid}]): rows with an interval '
        f'{sum(f["ci_low"] is not None for f in shipped_answer["feature_importance"])} '
        f'of {len(shipped_answer["feature_importance"])}; statistics.interval = '
        f'"{shipped_answer["statistics"]["interval"]}"')

    # 2. Random selections
    say()
    say('== 2. random selections (true difference 0): intervals excluding 0 / intervals, median width')
    say(f'{"n":>4} | {"percentile bootstrap":>30} | {"shipped (g_interval)":>30}')
    rng = np.random.default_rng(TRIAL_SEED)
    shipped = {}
    for n in SIZES:
        stats = {name: [0, 0, []] for name in ('percentile', 'shipped')}
        for _ in range(args.trials):
            sel = rng.choice(n_rows, n, replace=False)
            mask = np.zeros(n_rows, bool)
            mask[sel] = True
            for j in range(len(cols)):
                x = V[mask, j]
                y = V[~mask, j]
                x, y = x[~np.isnan(x)], y[~np.isnan(y)]
                if not len(x) or not len(y) or np.isnan(pc.hedges_g(x, y)):
                    continue
                for name, fn in (('percentile', percentile_bootstrap), ('shipped', pc.g_interval)):
                    lo, hi = fn(x, y)
                    if lo is None:
                        continue
                    s = stats[name]
                    s[1] += 1
                    s[2].append(hi - lo)
                    s[0] += int(lo > 0 or hi < 0)

        def cell(name):
            ex, tot, widths = stats[name]
            if not tot:
                return 'withheld'.rjust(30)
            return f'{ex:>4}/{tot:<5} = {ex / tot:6.1%}  w {np.median(widths):5.2f}'.rjust(30)
        say(f'{n:>4} | {cell("percentile")} | {cell("shipped")}')
        ex, tot, widths = stats['shipped']
        shipped[n] = (ex, tot, float(np.median(widths)) if widths else None)

    # 3. Checks
    say()
    say('== 3. checks')
    below = [n for n in SIZES if n < pc.MIN_GROUP_FOR_INTERVAL]
    withheld_ok = all(shipped[n][1] == 0 for n in below)
    say(f'  withheld below MIN_GROUP_FOR_INTERVAL (n in {below}): {withheld_ok}')
    from_min = [n for n in SIZES if n >= pc.MIN_GROUP_FOR_INTERVAL]
    worst = max(shipped[n][0] / shipped[n][1] for n in from_min)
    say(f'  largest share excluding 0 from n = {pc.MIN_GROUP_FOR_INTERVAL} on: {worst:.1%} '
        f'(accepted <= {MAX_NULL_EXCLUSION:.1%}): {worst <= MAX_NULL_EXCLUSION}')
    widths = [shipped[n][2] for n in from_min]
    narrowing = all(a >= b for a, b in zip(widths, widths[1:]))
    say(f'  median width falls as n grows (n = {from_min[0]}: {widths[0]:.2f} ... n = {from_min[-1]}: '
        f'{widths[-1]:.2f}): {narrowing}')
    say(f'  all checks pass: {withheld_ok and worst <= MAX_NULL_EXCLUSION and narrowing}')

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
