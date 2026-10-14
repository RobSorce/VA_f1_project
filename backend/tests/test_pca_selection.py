"""Lasso-selection analysis of the PCA biplot (P3) and its routes.

P3: the explanation was plain Cohen's d with no small-sample correction, no
interval, no multiple-comparison control, on a selection drawn in the same
feature space: a random 5-point selection showed >= 1 "large" effect 55% of
the time. Now: Hedges' g, its 95% interval (normal approximation; none for a
group of one row, scripts/pca_interval_coverage.py), N per group, the
random-selection baseline next to each value, a family-wise flag
(exceeds_random) and the label "Descriptive differences, not a test".
New route /api/pca/analyze-selection; /api/tsne/analyze-selection is an alias.
"""
import asyncio
import json
import random

import numpy as np
import pandas as pd
import pytest

from conftest import BACKEND
from data.processors import pca_compute as pc

MATRIX = BACKEND / 'data' / 'processed' / pc.MATRIX_FILE


@pytest.fixture(scope='module')
def ids():
    df = pd.read_csv(MATRIX)
    return [f'{d}_{y}_{r}' for d, y, r in zip(df['driver'], df['year'], df['round'])]


def test_hedges_g_formula():
    x = np.array([1.0, 2.0, 3.0])
    y = np.array([2.0, 3.0, 4.0, 5.0])
    sp = np.sqrt((2 * np.var(x, ddof=1) + 3 * np.var(y, ddof=1)) / 5)
    d = (x.mean() - y.mean()) / sp
    assert pc.hedges_g(x, y) == pytest.approx(d * (1 - 3 / (4 * 5 - 1)), rel=1e-12)
    assert pc.hedges_g(y, x) == pytest.approx(-pc.hedges_g(x, y), rel=1e-12)
    # undefined: one group empty, or no spread at all
    assert np.isnan(pc.hedges_g([], y))
    assert np.isnan(pc.hedges_g([1.0, 1.0], [1.0, 1.0, 1.0]))


def test_g_interval_formula():
    rng = np.random.default_rng(1)
    x, y = rng.normal(1, 1, 8), rng.normal(0, 1, 200)
    lo, hi = pc.g_interval(x, y)
    g = pc.hedges_g(x, y)
    se = np.sqrt((8 + 200) / (8 * 200) + g * g / (2 * 208))
    assert lo == pytest.approx(g - 1.959963984540054 * se, rel=1e-12)
    assert hi == pytest.approx(g + 1.959963984540054 * se, rel=1e-12)
    # deterministic, and wider for a smaller group
    assert pc.g_interval(x, y) == (lo, hi)
    lo3, hi3 = pc.g_interval(x[:3], y)
    assert hi3 - lo3 > hi - lo


def test_g_interval_withheld_for_one_row():
    """A group of one row has no spread of its own: no interval (P3)."""
    assert pc.MIN_GROUP_FOR_INTERVAL == 2
    y = np.arange(50.0)
    assert pc.g_interval([3.0], y) == (None, None)
    assert pc.g_interval(y, [3.0]) == (None, None)
    assert pc.g_interval([3.0, np.nan], y) == (None, None)  # NaN dropped first
    assert pc.g_interval([3.0, 7.0], y)[0] is not None


def test_single_point_selection_has_no_interval(ids):
    res = pc.analyze_selection(['LEC_2024_16'])
    assert res['n_selected'] == 1
    assert res['statistics']['min_group_for_interval'] == pc.MIN_GROUP_FOR_INTERVAL
    fi = res['feature_importance']
    assert fi and all(f['ci_low'] is None and f['ci_high'] is None for f in fi)
    assert all(f['g'] is not None and f['baseline_abs_g'] is not None for f in fi)
    json.dumps(res, allow_nan=False)


def test_selection_fields(ids):
    sel = ids[:5]
    res = pc.analyze_selection(sel)
    assert res['n_selected'] == 5
    assert res['n_rest'] == len(ids) - 5 and res['n_total'] == len(ids)
    assert res['statistics']['label'] == 'Descriptive differences, not a test'
    assert res['statistics']['baseline_max_abs_g_p95'] > 0
    assert 'Descriptive differences, not a test'.lower() in res['summary']
    fi = res['feature_importance']
    assert {f['feature'] for f in fi} == set(pc.FEATURE_COLS)
    assert [f['abs_g'] for f in fi] == sorted((f['abs_g'] for f in fi), reverse=True)
    for f in fi:
        assert f['effect_size'] == f['abs_g'] == pytest.approx(abs(f['g']), abs=1e-9)
        assert f['ci_low'] <= f['ci_high']
        assert f['n_selected'] == 5 and f['n_rest'] == len(ids) - 5
        assert 0 < f['baseline_abs_g'] <= f['baseline_abs_g_p95']
        assert f['exceeds_random'] == (f['abs_g'] > res['statistics']['baseline_max_abs_g_p95'])
        assert f['direction'] == ('higher' if f['g'] > 0 else 'lower')
    # deterministic, and valid JSON (no NaN) for the route
    assert pc.analyze_selection(sel) == res
    json.dumps(res, allow_nan=False)


def test_g_matches_the_matrix(ids):
    df = pd.read_csv(MATRIX)
    sel = ids[10:17]
    res = {f['feature']: f for f in pc.analyze_selection(sel)['feature_importance']}
    mask = np.isin(np.array(ids), sel)
    for col in ('pace_delta_pct', 'pit_count'):
        v = df[col].to_numpy(float)
        assert res[col]['g'] == pytest.approx(pc.hedges_g(v[mask], v[~mask]), abs=5e-4)


def test_random_selections_are_rarely_flagged(ids):
    """A random selection is what the baseline describes: exceeds_random fires
    for about 5% of them, while "large" (|g| >= 0.8) still fires often at N = 5."""
    rng = random.Random(11)
    trials, flagged, large = 60, 0, 0
    for _ in range(trials):
        fi = pc.analyze_selection(rng.sample(ids, 5))['feature_importance']
        flagged += any(f['exceeds_random'] for f in fi)
        large += any(f['magnitude'] == 'large' for f in fi)
    assert flagged / trials <= 0.10
    assert large / trials >= 0.2


def test_a_real_cluster_is_flagged(ids):
    """The 15 rows with the fastest race pace relative to the field differ in
    pace by far more than random selections do."""
    df = pd.read_csv(MATRIX)
    fast = df.nsmallest(15, 'pace_delta_pct')
    sel = [f'{d}_{y}_{r}' for d, y, r in zip(fast['driver'], fast['year'], fast['round'])]
    res = pc.analyze_selection(sel)
    top = {f['feature']: f for f in res['feature_importance']}
    assert top['pace_delta_pct']['exceeds_random'] and top['pace_delta_pct']['direction'] == 'lower'
    assert res['cluster_label'].startswith('Fast')


def test_routes():
    import api.main as main
    paths = {getattr(r, 'path', None) for r in main.app.routes}
    assert '/api/pca/analyze-selection' in paths
    assert '/api/tsne/analyze-selection' in paths
    assert '/api/tsne/project' not in paths
    req = main.PCAAnalyzeRequest(point_ids=['LEC_2024_16', 'PIA_2024_16', 'NOR_2024_16'])
    new = asyncio.run(main.analyze_pca_selection(req))
    old = asyncio.run(main.analyze_tsne_selection(req))
    assert new == old and new['n_selected'] == 3
    feats = asyncio.run(main.get_point_features('LEC_2024_16'))
    assert set(feats['features']) == set(pc.FEATURE_COLS)
