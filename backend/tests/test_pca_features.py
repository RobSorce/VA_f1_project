"""Cross-race PCA feature matrix (data/processors/pca_compute.py).

P1: PC1 was a circuit axis (race identity explained eta^2 = 0.946 of it:
absolute lap / sector times, per-race temperatures), degradation_rate
regressed lap time on the list index over the whole race, stint_count was
pit_count + 1 and the pit features came from the stale cached tyre_strategy.
P8: dead / broken paths (tsne_features.py, KeyError on 'Driver',
/api/tsne/project returning points[0]) are gone.

The checked-in artefacts (data/processed/) are read as they are; nothing here
rewrites them. Tests that need the git-ignored session cache skip without it.
"""
import importlib
import json
import math

import numpy as np
import pandas as pd
import pytest

from conftest import BACKEND, load_cached_session
from data.processors import pca_compute as pc
from data.processors.degradation import stint_fits
from data.processors.stints import build_tyre_strategy

PROCESSED = BACKEND / 'data' / 'processed'


@pytest.fixture(scope='module')
def matrix():
    return pd.read_csv(PROCESSED / pc.MATRIX_FILE)


@pytest.fixture(scope='module')
def embeddings():
    with open(PROCESSED / pc.PCA_FILE, encoding='utf-8') as fh:
        return json.load(fh)


def test_pc1_is_not_a_race_axis(matrix, embeddings):
    race = list(zip(matrix['year'], matrix['round']))
    fit = pc.fit_pca(matrix)
    scores = pc._project(matrix, fit)
    assert pc.eta_squared(scores[:, 0], race) < 0.3
    # the checked-in biplot (what the API serves) says the same, and is in step with the matrix
    pts = embeddings['points']
    eta_served = pc.eta_squared([p['x'] for p in pts], [(p['year'], p['round']) for p in pts])
    assert eta_served < 0.3
    assert embeddings['eta2_race'][0] == pytest.approx(eta_served, abs=1e-9)
    assert embeddings['feature_cols'] == pc.FEATURE_COLS
    assert len(pts) == len(matrix)
    assert np.allclose(sorted(p['x'] for p in pts), sorted(scores[:, 0]), atol=1e-9)


def test_feature_set(matrix):
    for gone in ('stint_count', 'track_temp', 'air_temp', 'avg_lap_time', 'best_lap_time',
                 'avg_sector1', 'rolling_pace_3', 'finish_position', 'position_change', 'gap_to_leader_mean'):
        assert gone not in pc.FEATURE_COLS
    # no duplicated feature (stint_count had r = 1.0 with pit_count)
    r = np.corrcoef(matrix[pc.FEATURE_COLS].fillna(matrix[pc.FEATURE_COLS].median()).to_numpy(), rowvar=False)
    off = np.abs(r[~np.eye(len(r), dtype=bool)])
    assert off.max() < 0.95


def test_pace_features_are_relative_to_the_race(matrix):
    for _, race in matrix.groupby(['year', 'round']):
        for col in ('pace_delta_pct', 'best_lap_delta_pct', 'recent_pace_delta_pct',
                    'sector1_delta_pct', 'sector2_delta_pct', 'sector3_delta_pct'):
            assert race[col].median() == pytest.approx(0.0, abs=1e-9)


def test_rows_follow_the_eligibility_rule(matrix):
    assert (matrix['laps_completed'] >= pc.MIN_LAP_SHARE * matrix['race_laps']).all()
    assert (matrix['n_clean_laps'] >= pc.MIN_CLEAN_LAPS).all()
    monza = matrix[(matrix['year'] == 2024) & (matrix['round'] == 16)]
    assert 'TSU' not in set(monza['driver'])  # retired on lap 7 of 53


def test_matrix_is_rebuilt_from_the_current_code():
    payload = load_cached_session(2024, 16)
    rows = pd.DataFrame(pc.race_feature_rows(payload, 2024, 16, 'Italian Grand Prix'))
    on_disk = pd.read_csv(PROCESSED / pc.MATRIX_FILE)
    on_disk = on_disk[(on_disk['year'] == 2024) & (on_disk['round'] == 16)].set_index('driver')
    rows = rows.set_index('driver').loc[on_disk.index]
    for col in pc.FEATURE_COLS:
        assert np.allclose(rows[col].to_numpy(float), on_disk[col].to_numpy(float), atol=1e-9, equal_nan=True), col


def test_pit_count_is_r2_tyre_changes():
    payload = load_cached_session(2024, 16)
    rows = {r['driver']: r for r in pc.race_feature_rows(payload, 2024, 16)}
    stints = build_tyre_strategy(payload['lap_times'])
    for drv, row in rows.items():
        assert row['pit_count'] == sum(1 for s in stints if s['Driver'] == drv) - 1
    # PIA: MEDIUM 1-16, HARD 17-38, HARD 39-53 (the cached tyre_strategy merged the HARD stints: 1 stop)
    assert rows['PIA']['pit_count'] == 2
    assert rows['PIA']['max_stint_length'] == 22
    assert sum(1 for s in payload['tyre_strategy'] if s['Driver'] == 'PIA') - 1 == 1


def test_degradation_is_the_shared_per_stint_tyre_life_slope():
    payload = load_cached_session(2024, 16)
    rows = {r['driver']: r for r in pc.race_feature_rows(payload, 2024, 16)}
    fits = [f for f in stint_fits(payload['lap_times']) if f['slope'] is not None]
    for drv in ('LEC', 'PIA', 'NOR', 'HAM'):
        mine = [f for f in fits if f['driver'] == drv]
        expected = sum(f['slope'] * f['n'] for f in mine) / sum(f['n'] for f in mine)
        assert rows[drv]['degradation_slope'] == pytest.approx(expected, abs=1e-12)


def test_degradation_sign_is_no_longer_fuel_dominated(matrix):
    # the old whole-race regression on the list index was negative in 85% of the rows
    assert (matrix['degradation_slope'] < 0).mean() < 0.5


def test_dead_paths_are_gone():
    with pytest.raises(ImportError):
        importlib.import_module('data.processors.tsne_features')
    with pytest.raises(ImportError):
        importlib.import_module('data.processors.tsne_compute')
    from data.processors.feature_engineering import FeatureEngineer
    for gone in ('calculate_tyre_degradation', 'calculate_position_changes', 'get_team_color'):
        assert not hasattr(FeatureEngineer, gone)
    assert not (PROCESSED / 'tsne_feature_matrix.csv').exists()
    assert not (PROCESSED / 'tsne_scaler.pkl').exists()


def test_prepare_ml_features_accepts_fastf1_results():
    """feature_engineering.py merged race_results[['Driver', 'Position']]: a
    KeyError on FastF1 results, which name the driver code 'Abbreviation'."""
    from data.processors.feature_engineering import FeatureEngineer
    payload = load_cached_session(2024, 16)
    laps = pd.DataFrame(payload['lap_times'])
    results = pd.DataFrame(payload['race_results'])
    assert 'Driver' not in results.columns
    out = FeatureEngineer().prepare_ml_features(laps, results, 53)
    lec = out[out['Driver'] == 'LEC']['FinishPosition'].unique()
    assert list(lec) == [1.0]
    # the renamed shape (model/prepare_data.py) gives the same column
    renamed = FeatureEngineer().prepare_ml_features(laps, results.rename(columns={'Abbreviation': 'Driver'}), 53)
    assert renamed['FinishPosition'].equals(out['FinishPosition'])


def test_no_temperature_or_absolute_time_reaches_the_biplot(embeddings):
    feats = {l['feature'] for l in embeddings['loadings']}
    assert feats == set(pc.FEATURE_COLS)
    assert all(not math.isnan(v) for v in embeddings['explained_variance'])
