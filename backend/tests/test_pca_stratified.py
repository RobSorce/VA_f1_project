"""Lasso analysis during a replay: the random baseline is
stratified by row kind and its cache is keyed by the rows' content
(data/processors/pca_compute.py).

1. During a replay the analysis compares rows of the race on screen at the
   clock with whole-race rows of the finished races. The baseline drew its
   random selections from all rows, so a selection of rows of the race in
   progress was flagged "above random" in pit stops and stint lengths by the
   mix alone (the 19 stars of 2024 R16 at lap 20 were flagged in
   avg_stint_length, max_stint_length, pit_count). Now each random
   selection draws as many rows of each kind as the selection holds; the
   statistics block states the composition and the lap; a feature whose
   distribution depends on race progress is marked progress_dependent while
   the compared rows mix the kinds.
2. The baseline cache key was (matrix file, length; year, round, lap, number
   of rows of the race): rows change inside one leader lap, so a baseline of
   another matrix could be served (2024 R21 inside leader lap 50). Now the
   key holds a
   content hash of the rows, the selection size and its composition.
3. With rows of two kinds the family-wise threshold (95th
   percentile of the largest |g| over all features) was set by the
   progress-dependent features, whose |g| is large in every same-mix draw:
   pace, sectors, consistency and grid could almost never be above random
   during a replay (docs/evidence/pca_mixed_threshold.txt, section 1). Now
   each feature has its own threshold, the same quantile level of its own
   random |g| for every feature (common_level_thresholds); post-race the rule
   is unchanged (scripts/pca_mixed_threshold.py).
4. A selection of finished rows only, during a replay, states
   the lap and that the other rows hold the race on screen; a finite clock
   at or after the race end gives the post-race answer.
"""
import json
import random

import numpy as np
import pytest

from conftest import CACHE_DIR, load_cached_session
from data.processors import pca_compute as pc
from data.processors.stints import leader_lap_times

PROGRESS = set(pc.PROGRESS_DEPENDENT_FEATURES)
CACHED_RACES = sorted(CACHE_DIR.glob('session_*_R.json')) if CACHE_DIR.exists() else []


def clock_after_lap(payload, lap):
    return leader_lap_times(payload['lap_times'])[lap][1] + 1.0


def replay(year, rnd, lap):
    """(clock, analysis matrix, its ids, ids of the race on screen, ids of
    finished races) at the end of leader lap ``lap``."""
    now = clock_after_lap(load_cached_session(year, rnd), lap)
    df, _ = pc._analysis_matrix(year, rnd, now)
    ids = [f'{d}_{int(y)}_{int(r)}' for d, y, r in zip(df['driver'], df['year'], df['round'])]
    live = df['as_of'].to_numpy() == pc.ROW_LIVE
    return now, df, ids, [i for i, k in zip(ids, live) if k], [i for i, k in zip(ids, live) if not k]


def former_flags(df, ids, sel):
    """Features the former rule flagged: unstratified baseline of the
    selection size, |g| > its family-wise threshold."""
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    V = df[cols].astype(float).to_numpy()
    mask = np.isin(np.array(ids), sel)
    thr = pc.random_selection_baseline(V, int(mask.sum()))['max_p95']
    out = set()
    for j, c in enumerate(cols):
        x, y = V[mask, j], V[~mask, j]
        g = pc.hedges_g(x[~np.isnan(x)], y[~np.isnan(y)])
        if abs(g) > thr:
            out.add(c)
    return out


# ── 1. the stratified baseline ──

@pytest.mark.skipif(not CACHED_RACES, reason='processed cache missing')
def test_progress_dependent_features_are_those_that_move_with_the_race():
    """The declared list is what scripts/pca_progress_features.py measures:
    rows at a quarter, half, three quarters of each cached race against the
    same race's post-race rows."""
    from scripts.pca_progress_features import moving_features
    assert set(pc.PROGRESS_DEPENDENT_FEATURES) <= set(pc.FEATURE_COLS)
    assert set(moving_features()) == PROGRESS
    assert {'pit_count', 'avg_stint_length', 'max_stint_length'} <= PROGRESS
    assert 'grid_position' not in PROGRESS and 'pace_delta_pct' not in PROGRESS


def test_stratified_draws_keep_the_composition():
    rng = np.random.default_rng(3)
    kinds = np.array([pc.ROW_LIVE] * 6 + [pc.ROW_FINISHED] * 40)
    # column 0 = the kind itself: every draw of 2 + 3 rows has the same g on it
    V = np.column_stack([(kinds == pc.ROW_LIVE).astype(float) + rng.normal(0, 1e-9, len(kinds)),
                         rng.normal(0, 1, len(kinds))])
    b = pc.random_selection_baseline(V, {pc.ROW_LIVE: 2, pc.ROW_FINISHED: 3}, strata=kinds)
    assert b['p95'][0] == pytest.approx(b['mean'][0], rel=1e-6)  # same composition in every draw
    unstrat = pc.random_selection_baseline(V, 5)
    assert unstrat['p95'][0] > 2 * unstrat['mean'][0]  # the mix varies without strata
    # all the rows of a kind: every draw is the same selection
    whole = pc.random_selection_baseline(V, {pc.ROW_LIVE: 6, pc.ROW_FINISHED: 0}, strata=kinds)
    sel = kinds == pc.ROW_LIVE
    assert whole['p95'][1] == pytest.approx(abs(pc.hedges_g(V[sel, 1], V[~sel, 1])), rel=1e-9)
    # one kind for every row: the former draws exactly
    one = np.full(len(kinds), pc.ROW_FINISHED)
    assert pc.random_selection_baseline(V, {pc.ROW_FINISHED: 5}, strata=one) == unstrat
    with pytest.raises(ValueError):
        pc.random_selection_baseline(V, {pc.ROW_LIVE: 7}, strata=kinds)


def test_all_stars_at_lap_20_are_no_longer_above_random():
    """Item 1 above: the 19 stars of 2024 R16 at lap 20."""
    now, df, ids, live, _ = replay(2024, 16, 20)
    assert len(live) == 19
    # what the former baseline flagged
    assert former_flags(df, ids, live) >= {'avg_stint_length', 'max_stint_length', 'pit_count'}
    res = pc.analyze_selection(live, None, 2024, 16, now)
    fi = {f['feature']: f for f in res['feature_importance']}
    assert not any(f['exceeds_random'] for f in fi.values())
    assert {f for f, v in fi.items() if v['progress_dependent']} == PROGRESS
    st = res['statistics']
    assert st['composition'] == {'selected_live': 19, 'selected_finished': 0, 'rest_live': 0,
                                 'rest_finished': len(df) - 19, 'as_of_lap': 20, 'mixed': True,
                                 'no_random_alternative': True}
    assert st['composition_text'].startswith(
        'selection: 19 rows of the race on screen at lap 20; baseline drawn with the same mix; '
        'every random selection with this mix is the selection itself')
    assert res['cluster_label'] == 'Mixed cluster'
    json.dumps(res, allow_nan=False)


@pytest.mark.parametrize('year,rnd,lap', [(2024, 16, 20), (2025, 1, 30)])
def test_live_only_selections_do_not_flag_progress_features(year, rnd, lap):
    """Random selections of rows of the race on screen only (2 to 8 rows):
    the former baseline flagged a progress-dependent feature for most of
    them, the stratified one about as often as chance allows."""
    now, df, ids, live, _ = replay(year, rnd, lap)
    rng = random.Random(5)
    trials, old, new = 40, 0, 0
    for _ in range(trials):
        sel = rng.sample(live, rng.randint(2, 8))
        old += bool(PROGRESS & former_flags(df, ids, sel))
        res = pc.analyze_selection(sel, None, year, rnd, now)
        new += any(f['exceeds_random'] for f in res['feature_importance'] if f['feature'] in PROGRESS)
        assert {f['feature'] for f in res['feature_importance'] if f['progress_dependent']} == PROGRESS
    assert old / trials >= 0.3
    assert new / trials <= 0.10


@pytest.mark.parametrize('year,rnd,lap', [(2024, 16, 20), (2025, 1, 30)])
def test_random_stratified_selections_are_rarely_flagged(year, rnd, lap):
    """A random selection with any mix (1 to 5 rows of the race on screen, 1
    to 5 of finished races) is what the stratified baseline describes: some
    feature is flagged for about 5% of them (family-wise), as for random
    post-race selections (test_pca_selection)."""
    now, df, _, live, finished = replay(year, rnd, lap)
    rng = random.Random(11)
    trials, flagged = 60, 0
    for _ in range(trials):
        sel = rng.sample(live, rng.randint(1, 5)) + rng.sample(finished, rng.randint(1, 5))
        flagged += any(f['exceeds_random'] for f in pc.analyze_selection(sel, None, year, rnd, now)['feature_importance'])
    assert flagged / trials <= 0.10


def test_the_statistics_state_the_composition_and_the_lap():
    now, df, _, live, finished = replay(2024, 16, 20)
    sel = live[:3] + ['VER_2024_1', 'HAM_2024_2']
    res = pc.analyze_selection(sel, None, 2024, 16, now)
    st = res['statistics']
    assert st['composition_text'] == ('selection: 3 rows of the race on screen at lap 20, 2 rows of finished '
                                      'races; baseline drawn with the same mix')
    assert st['composition'] == {'selected_live': 3, 'selected_finished': 2, 'rest_live': len(live) - 3,
                                 'rest_finished': len(finished) - 2, 'as_of_lap': 20, 'mixed': True,
                                 'no_random_alternative': False}
    assert "with the selection's mix (3 of the race on screen at lap 20, 2 of finished races" in st['baseline']
    assert sorted(st['progress_dependent_features']) == sorted(PROGRESS)
    assert 'lap 20' in st['progress_note'] and 'pit stops' in st['progress_note']
    for f in res['feature_importance']:
        assert f['progress_dependent'] == (f['feature'] in PROGRESS)
    assert res['summary'].endswith('The random selections of the baseline keep the same mix of rows.')
    # post-race: one kind, no progress note, the former baseline
    post = pc.analyze_selection(['VER_2024_1', 'HAM_2024_2', 'LEC_2024_16', 'NOR_2024_16', 'PIA_2024_16'])
    assert post['statistics']['composition_text'] == ('selection: 5 rows of finished races; '
                                                      'baseline drawn from the same rows')
    assert post['statistics']['composition']['mixed'] is False
    assert post['statistics']['progress_note'] is None
    assert not any(f['progress_dependent'] for f in post['feature_importance'])


# ── 2. the cache key ──

def test_cache_key_changes_when_one_row_value_changes():
    df, _ = pc._analysis_matrix()
    V = df[pc.FEATURE_COLS].astype(float).to_numpy()
    kinds = df['as_of'].tolist()
    n = {pc.ROW_FINISHED: 5}
    key = pc.baseline_cache_key(V, kinds, n)
    assert pc.baseline_cache_key(V.copy(), list(kinds), dict(n)) == key
    W = V.copy()
    W[17, 3] += 1e-6
    assert pc.baseline_cache_key(W, kinds, n) != key
    # NaN in any bit pattern is one value
    nan_a, nan_b = V.copy(), V.copy()
    nan_a[0, 0] = np.nan
    nan_b[0, 0] = np.frombuffer(np.array([0x7FF8000000000001], dtype=np.uint64).tobytes(), dtype=np.float64)[0]
    assert pc.baseline_cache_key(nan_a, kinds, n) == pc.baseline_cache_key(nan_b, kinds, n)
    # the kinds, the selection size and its composition are part of the key
    assert pc.baseline_cache_key(V, [pc.ROW_LIVE] + kinds[1:], n) != key
    assert pc.baseline_cache_key(V, kinds, {pc.ROW_FINISHED: 6}) != key
    assert (pc.baseline_cache_key(V, kinds, {pc.ROW_FINISHED: 3, pc.ROW_LIVE: 2})
            != pc.baseline_cache_key(V, kinds, {pc.ROW_FINISHED: 4, pc.ROW_LIVE: 1}))


def test_no_stale_baseline_after_one_matrix_value_changes(monkeypatch):
    """Same file, same length, one value changed: the former key matched, the
    content key does not, and the answer is the fresh one."""
    base, _ = pc._analysis_matrix()
    ids = [f'{d}_{y}_{r}' for d, y, r in zip(base['driver'][1:6], base['year'][1:6], base['round'][1:6])]
    changed = base.drop(columns=['as_of']).copy()
    changed.loc[0, 'pace_delta_pct'] += 50.0
    pc._baseline_cache.clear()
    monkeypatch.setattr(pc, '_load_matrix', lambda: changed)
    fresh = pc.analyze_selection(ids)
    monkeypatch.undo()
    original = pc.analyze_selection(ids)
    monkeypatch.setattr(pc, '_load_matrix', lambda: changed)
    after = pc.analyze_selection(ids)
    assert after == fresh
    pace = lambda r: next(f for f in r['feature_importance'] if f['feature'] == 'pace_delta_pct')['baseline_abs_g']
    assert pace(original) != pace(fresh)  # the change does move the baseline


def test_no_stale_baseline_inside_one_leader_lap():
    """Item 2 above: 2024 R21, two clocks inside leader lap 50."""
    payload = load_cached_session(2024, 21)
    ll = leader_lap_times(payload['lap_times'])
    t1, t2 = ll[50][1] + 0.5, ll[51][1] - 0.5
    m1, k1 = pc._analysis_matrix(2024, 21, t1)
    m2, k2 = pc._analysis_matrix(2024, 21, t2)
    assert len(m1) == len(m2) and k1 != k2
    ids = [f'{d}_2024_21' for d in ['VER', 'NOR', 'LEC', 'PIA', 'SAI']]
    pc._baseline_cache.clear()
    fresh = pc.analyze_selection(ids, None, 2024, 21, t2)
    pc._baseline_cache.clear()
    pc.analyze_selection(ids, None, 2024, 21, t1)
    assert pc.analyze_selection(ids, None, 2024, 21, t2) == fresh


# ── 3. the family-wise threshold with rows of two kinds ──

def test_common_level_thresholds_one_feature_is_its_quantile():
    rng = np.random.default_rng(4)
    A = np.abs(rng.normal(0, 1, (1000, 1)))
    level, (t,) = pc.common_level_thresholds(A, 0.05)
    assert level == pytest.approx(0.95)
    assert (A[:, 0] > t).mean() == pytest.approx(0.05)
    assert t == np.sort(A[:, 0])[949]


def test_common_level_thresholds_are_per_feature_and_scale_free():
    """A feature whose random |g| is ten times larger does not raise the
    other features' thresholds (it set the one threshold of the max rule),
    and the share of draws passing some threshold stays at the rate."""
    rng = np.random.default_rng(5)
    A = np.abs(rng.normal(0, 1, (1000, 3)))
    level, t = pc.common_level_thresholds(A, 0.05)
    B = A.copy()
    B[:, 2] *= 10
    level_b, tb = pc.common_level_thresholds(B, 0.05)
    assert level_b == level and 0.95 < level < 1
    assert tb[0] == t[0] and tb[1] == t[1] and tb[2] == pytest.approx(10 * t[2])
    assert pc._above(B, np.array(tb)).any(axis=1).mean() <= 0.05
    assert np.quantile(B.max(axis=1), 0.95) > 5 * max(tb[0], tb[1])  # the max rule: set by column 2
    # a feature without |g| in any draw has no threshold
    C = np.column_stack([A[:, 0], np.full(1000, np.nan)])
    assert pc.common_level_thresholds(C, 0.05)[1][1] is None


def test_replay_rows_get_per_feature_thresholds():
    now, df, ids, live, finished = replay(2024, 16, 20)
    res = pc.analyze_selection(live[:3] + ['VER_2024_1', 'HAM_2024_2'], None, 2024, 16, now)
    st = res['statistics']
    assert st['threshold_rule'] == pc.THRESHOLD_PER_FEATURE
    assert 0.95 <= st['threshold_level'] < 1
    assert f"{st['threshold_level']:.1%} quantile of its random |g|" in st['threshold']
    thr = {f['feature']: f['threshold_abs_g'] for f in res['feature_importance']}
    assert len(set(thr.values())) > 1
    # the progress-dependent features have the largest random |g| (the mix):
    # the former single threshold was theirs
    assert max(thr[f] for f in PROGRESS) > max(t for f, t in thr.items() if f not in PROGRESS)
    assert st['baseline_max_abs_g_p95'] > max(t for f, t in thr.items() if f not in PROGRESS)
    for f in res['feature_importance']:
        if f['exceeds_random']:
            assert f['abs_g'] >= f['threshold_abs_g'] - 1e-3
        else:
            assert f['abs_g'] <= f['threshold_abs_g'] + 1e-3
    json.dumps(res, allow_nan=False)


def test_post_race_threshold_rule_is_unchanged():
    res = pc.analyze_selection(['VER_2024_1', 'HAM_2024_2', 'LEC_2024_16', 'NOR_2024_16', 'PIA_2024_16'])
    st = res['statistics']
    assert st['threshold_rule'] == pc.THRESHOLD_MAX and st['threshold_level'] is None
    assert st['threshold'].startswith(f"above random: |g| above {st['baseline_max_abs_g_p95']:.3f} for every feature")
    for f in res['feature_importance']:
        assert f['threshold_abs_g'] == st['baseline_max_abs_g_p95']
        assert f['exceeds_random'] == (f['abs_g'] > st['baseline_max_abs_g_p95'])


def test_a_pace_difference_is_flagged_during_a_replay():
    """Synthetic power: 2024 R16 lap 20, pace of 5 random rows of
    the race on screen shifted by 2 matrix SDs. With one threshold for all
    features (set by the stint lengths) it was flagged in 23.3% of 60 such
    selections, now in 96.7% (docs/evidence/pca_mixed_threshold.txt);
    here the first 20 of them."""
    now, df0, ids, live, _ = replay(2024, 16, 20)
    live_set = set(live)
    rows = [i for i, x in enumerate(ids) if x in live_set]
    sd = float(df0['pace_delta_pct'].astype(float).std())
    rng = random.Random(3)
    trials, one_threshold, shipped = 20, 0, 0
    for _ in range(trials):
        mask = np.zeros(len(df0), dtype=bool)
        mask[rng.sample(rows, 5)] = True
        df = df0.copy()
        df.loc[mask, 'pace_delta_pct'] = df.loc[mask, 'pace_delta_pct'].astype(float) - 2.0 * sd
        fd = pc.feature_differences(df, mask)
        pace = next(f for f in fd['feature_importance'] if f['feature'] == 'pace_delta_pct')
        one_threshold += pace['abs_g'] > fd['baseline']['max_p95']
        shipped += pace['exceeds_random']
    assert one_threshold / trials <= 0.4
    assert shipped / trials >= 0.8


def test_a_real_lasso_is_flagged_during_a_replay():
    """A real lasso: 2025 R1 lap 20, the 5 rows of the race on
    screen lowest in sector 1 (g -2.17): the former single threshold 3.878
    was set by the progress-dependent features."""
    now, df, ids, live, _ = replay(2025, 1, 20)
    sub = df[df['as_of'] == pc.ROW_LIVE].sort_values('sector1_delta_pct', kind='stable')
    sel = [f'{d}_2025_1' for d in sub['driver'][:5]]
    res = pc.analyze_selection(sel, None, 2025, 1, now)
    s1 = next(f for f in res['feature_importance'] if f['feature'] == 'sector1_delta_pct')
    assert s1['g'] == pytest.approx(-2.166, abs=1e-3)
    assert s1['abs_g'] < res['statistics']['baseline_max_abs_g_p95']  # not above the single threshold
    assert s1['exceeds_random'] and s1['threshold_abs_g'] < s1['abs_g']
    assert not s1['progress_dependent']


# ── 4. the composition text and the race end ──

def test_finished_only_selection_states_the_lap_and_the_rest():
    """A selection of 5 rows of finished races during the replay of
    2024 R12 at lap 15."""
    now, df, _, live, finished = replay(2024, 12, 15)
    res = pc.analyze_selection(finished[10:15], None, 2024, 12, now)
    st = res['statistics']
    assert st['composition_text'] == (f'selection: 5 rows of finished races; the other rows include {len(live)} '
                                      f'rows of the race on screen at lap 15; baseline drawn with the same mix')
    assert st['composition']['as_of_lap'] == 15 and st['composition']['rest_live'] == len(live)


def test_a_clock_after_the_race_end_is_post_race():
    """2024 R12, a finite clock 600 s after the
    leader's last lap (an API caller; the store sends no clock once the race
    has ended) gave rows of kind 'session_now' at lap 52 and another answer
    than post-race. Now the same answer as post-race."""
    payload = load_cached_session(2024, 12)
    ll = leader_lap_times(payload['lap_times'])
    end_clock = ll[max(ll)][1] + 600.0
    m_end, k_end = pc._analysis_matrix(2024, 12, end_clock)
    m_post, k_post = pc._analysis_matrix(2024, 12, None)
    assert k_end == k_post and (m_end['as_of'] == pc.ROW_FINISHED).all()
    ids = [f'{d}_2024_12' for d in ['VER', 'NOR', 'LEC']]
    at_end = pc.analyze_selection(ids, None, 2024, 12, end_clock)
    post = pc.analyze_selection(ids, None, 2024, 12, None)
    assert at_end['current_race']['as_of'] == 'post-race'
    assert at_end['current_race']['session_now'] == pytest.approx(end_clock)
    assert at_end['current_race']['as_of_lap'] == post['current_race']['as_of_lap'] == max(ll)
    strip = lambda r: {k: v for k, v in r.items() if k != 'current_race'}
    assert strip(at_end) == strip(post)
    assert at_end['statistics']['composition']['mixed'] is False
    assert not any(f['progress_dependent'] for f in at_end['feature_importance'])
    # one second before the last timed row ends, the race is still running
    ends = [pc._lap_end_time(lap) for lap in payload['lap_times']]
    before = pc.analyze_selection(ids, None, 2024, 12, max(e for e in ends if e is not None) - 1.0)
    assert before['current_race']['as_of'] == 'session_now'
    assert before['statistics']['threshold_rule'] == pc.THRESHOLD_PER_FEATURE
