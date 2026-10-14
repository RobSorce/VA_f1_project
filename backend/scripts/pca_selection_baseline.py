"""
How often does a RANDOM lasso selection look "distinctive"? Random selections
of the biplot rows, analysed by data/processors/pca_compute.py
analyze_selection, for several selection sizes.

Run from backend/:
    python -m scripts.pca_selection_baseline [--trials 200] [--out REPORT.txt]

For each size n and each of ``trials`` random selections (seeded):
- large: at least one feature with |g| >= 0.8 (Cohen's conventional "large",
  the label the panel showed before; plain Cohen's d gives the same rate up
  to the Hedges factor, printed for comparison);
- exceeds_random: at least one feature flagged exceeds_random (|g| above the
  95th percentile of the largest |g| over all features in random selections
  of the same size): a random selection should be flagged ~5% of the time;
- the family-wise threshold (baseline_max_abs_g_p95) and the median width of
  the 95% interval of g (pca_compute.g_interval; its coverage on random
  selections: scripts/pca_interval_coverage.py).
"""
import argparse
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402

SIZES = [2, 5, 10, 20, 50]

# Seed of the random selections (independent of pca_compute.SELECTION_SEED)
TRIAL_SEED = 7


def cohen_d(x, y):
    """Plain Cohen's d with the pooled (Bessel) SD: the statistic the panel used before."""
    n1, n2 = len(x), len(y)
    sp = np.sqrt(((n1 - 1) * np.var(x, ddof=1) + (n2 - 1) * np.var(y, ddof=1)) / (n1 + n2 - 2)) if n1 > 1 else \
        np.sqrt(np.var(y, ddof=1))
    return abs(x.mean() - y.mean()) / sp if sp > 0 else 0.0


def run(trials, out=None):
    lines = []

    def emit(s=''):
        lines.append(s)
        print(s)

    df = pc._load_matrix()
    ids = [f'{d}_{y}_{r}' for d, y, r in zip(df['driver'], df['year'], df['round'])]
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    rng = random.Random(TRIAL_SEED)
    emit(f'matrix: {len(df)} rows, {len(cols)} features; {trials} random selections per size (seed {TRIAL_SEED})')
    emit('size  large(|d|>=0.8)  large(|g|>=0.8)  exceeds_random  threshold(max|g| p95)  median CI width')
    for n in SIZES:
        large_d = large_g = flagged = 0
        widths = []
        threshold = None
        for _ in range(trials):
            sel = rng.sample(ids, n)
            res = pc.analyze_selection(sel)
            fi = res['feature_importance']
            mask = np.isin(np.array(ids), sel)
            if any(cohen_d(df[c].to_numpy()[mask], df[c].to_numpy()[~mask]) >= 0.8 for c in cols):
                large_d += 1
            large_g += any(f['abs_g'] >= 0.8 for f in fi)
            flagged += any(f['exceeds_random'] for f in fi)
            widths.extend(f['ci_high'] - f['ci_low'] for f in fi if f['ci_low'] is not None)
            threshold = res['statistics']['baseline_max_abs_g_p95']
        emit(f'{n:4d}  {large_d / trials:15.1%}  {large_g / trials:15.1%}  {flagged / trials:14.1%}  '
             f'{threshold:21.3f}  {float(np.median(widths)):15.3f}')
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--trials', type=int, default=200)
    ap.add_argument('--out', default=None, help='also write the report to this file')
    a = ap.parse_args()
    run(a.trials, a.out)


if __name__ == '__main__':
    main()
