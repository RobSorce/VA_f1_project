"""
Diagnostic of the cross-race PCA feature matrix: how much of each principal
component is race identity.

Run from backend/:
    python -m scripts.pca_diagnostic
    python -m scripts.pca_diagnostic --matrix OLD.csv --features a,b,c --out OUT.txt

Without arguments it reads data/processed/pca_feature_matrix.csv with the
FEATURE_COLS of data/processors/pca_compute.py and applies the same
preprocessing as compute_pca (median fill, StandardScaler).

Definitions
-----------
- eta^2(race) of a variable v: between-race sum of squares / total sum of
  squares, sum_r n_r (mean_r - mean)^2 / sum_i (v_i - mean)^2, races keyed by
  (year, round). 1 = the variable is constant within every race (pure race
  identity), 0 = every race has the same mean.
- Explained variance: PCA explained_variance_ratio_ of every component.
- Correlated pairs: |Pearson r| >= 0.9 between two standardised features.
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

DEFAULT_MATRIX = os.path.join(HERE, '..', 'data', 'processed', 'pca_feature_matrix.csv')

# Pairs at or above this |r| are listed as near-duplicates (reporting threshold only)
CORR_REPORT = 0.9


def eta_squared(values, groups):
    """Between-group / total sum of squares of ``values`` grouped by ``groups``."""
    v = np.asarray(values, dtype=float)
    g = pd.Series(list(groups))
    total = float(((v - v.mean()) ** 2).sum())
    if total == 0:
        return 0.0
    s = pd.Series(v)
    means = s.groupby(g.values).transform('mean').to_numpy()
    between = float(((means - v.mean()) ** 2).sum())
    return between / total


def run(matrix_path, features, out=None):
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import StandardScaler

    lines = []

    def emit(s=''):
        lines.append(s)
        print(s)

    df = pd.read_csv(matrix_path)
    cols = [c for c in features if c in df.columns]
    missing = [c for c in features if c not in df.columns]
    X = df[cols].copy()
    X = X.fillna(X.median()).replace([np.inf, -np.inf], np.nan).fillna(0)
    Z = StandardScaler().fit_transform(X)
    pca = PCA(random_state=42).fit(Z)
    scores = pca.transform(Z)
    race = list(zip(df['year'], df['round']))
    per_race = pd.Series(race).value_counts()

    emit(f'matrix: {os.path.normpath(matrix_path)}')
    emit(f'rows: {len(df)}  races: {len(per_race)}  rows per race: min {per_race.min()} / median {int(per_race.median())} / max {per_race.max()}')
    emit(f'features ({len(cols)}): {", ".join(cols)}')
    if missing:
        emit(f'features missing from the matrix: {", ".join(missing)}')
    emit('')
    emit('PC   explained   cumulative   eta2(race)')
    cum = 0.0
    for k, ev in enumerate(pca.explained_variance_ratio_):
        cum += ev
        emit(f'PC{k + 1:<3d} {ev:9.3f}   {cum:10.3f}   {eta_squared(scores[:, k], race):10.3f}')
    emit('')
    emit('feature                 eta2(race)   PC1 loading   PC2 loading')
    for j, c in enumerate(cols):
        emit(f'{c:<23s} {eta_squared(X[c], race):10.3f}   {pca.components_[0, j]:11.3f}   {pca.components_[1, j]:11.3f}')
    emit('')
    r = np.corrcoef(Z, rowvar=False)
    pairs = [(cols[i], cols[j], r[i, j]) for i in range(len(cols)) for j in range(i + 1, len(cols))
             if abs(r[i, j]) >= CORR_REPORT]
    emit(f'feature pairs with |r| >= {CORR_REPORT}: {len(pairs)}')
    for a, b, v in sorted(pairs, key=lambda p: -abs(p[2])):
        emit(f'  {a} ~ {b}: r = {v:.3f}')
    for c in ('degradation_rate', 'degradation_slope'):
        if c in df.columns:
            v = df[c].dropna()
            emit(f'{c}: n = {len(v)}, negative {int((v < 0).sum())} ({(v < 0).mean():.1%}), median {v.median():.4f}')
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')
    return {
        'explained': [float(v) for v in pca.explained_variance_ratio_],
        'eta2_pc': [eta_squared(scores[:, k], race) for k in range(scores.shape[1])],
        'pairs': pairs,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--matrix', default=DEFAULT_MATRIX)
    ap.add_argument('--features', default=None, help='comma-separated feature columns (default: pca_compute.FEATURE_COLS)')
    ap.add_argument('--out', default=None, help='also write the report to this file')
    a = ap.parse_args()
    if a.features:
        features = [c.strip() for c in a.features.split(',') if c.strip()]
    else:
        from data.processors.pca_compute import FEATURE_COLS
        features = FEATURE_COLS
    run(a.matrix, features, a.out)


if __name__ == '__main__':
    main()
