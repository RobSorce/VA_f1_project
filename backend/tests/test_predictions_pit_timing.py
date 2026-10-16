"""Pit probability -> projected pit lap (model/pit_timing.py), the one
mapping used by model/predict.py and by the built-in heuristic of
api/routers/predictions.py.

The defect it replaces: laps-to-pit rose with the pit probability above 0.5
and jumped at 0.5 (p 0.50 -> 15 laps, 0.51 -> 4, 0.99 -> 24 at tyre life 10).
"""
import ast
import math

import pytest

from conftest import BACKEND
from model.pit_timing import (
    PIT_LABEL_HORIZON_LAPS, PIT_WAIT_QUANTILE, laps_until_pit, optimal_pit_lap,
)

# Dense grid on [0, 1] with the points around the old jump
GRID = sorted(set([i / 2000 for i in range(2001)] + [0.49, 0.499999, 0.5, 0.500001, 0.51, 0.99, 0.999999]))


def non_increasing(values):
    return all(b <= a for a, b in zip(values, values[1:]))


def test_laps_until_pit_non_increasing_in_p():
    laps = [laps_until_pit(p) for p in GRID]
    assert non_increasing(laps)
    table = {p: laps_until_pit(p) for p in (0.01, 0.05, 0.1, 0.25, 0.49, 0.5, 0.51, 0.75, 0.9, 0.99, 1.0)}
    print('laps until pit:', table)


def test_no_jump_at_one_half():
    # k(0.5) is the label horizon exactly; neighbours differ by the rounding only
    assert laps_until_pit(0.5) == PIT_LABEL_HORIZON_LAPS
    assert laps_until_pit(0.49) - laps_until_pit(0.51) <= 1
    assert laps_until_pit(0.499999) - laps_until_pit(0.500001) <= 1
    # the old values: 0.51 -> 4 and 0.99 -> 24 laps
    assert (laps_until_pit(0.51), laps_until_pit(0.99)) == (5, 1)


def test_step_size_is_bounded_by_the_rounding():
    """Continuity of the underlying k(p): on the grid, away from p -> 0
    (where k grows without bound), consecutive lap counts differ by <= 1."""
    finite = [laps_until_pit(p) for p in GRID if p >= 0.05]
    assert max(a - b for a, b in zip(finite, finite[1:])) <= 1


@pytest.mark.parametrize('current_lap,max_lap', [(1, 57), (20, 60), (30, 53), (50, 53), (52, 53), (10, 78)])
def test_optimal_pit_lap_non_increasing_and_in_range(current_lap, max_lap):
    laps = [optimal_pit_lap(p, current_lap, max_lap) for p in GRID]
    assert non_increasing(laps)
    assert all(current_lap + 1 <= lap <= max(current_lap + 1, max_lap - 2) for lap in laps)


def test_meaning_of_the_mapping():
    """With the per-lap hazard h that gives p over the label horizon, the
    stop has happened by laps_until_pit(p) with probability >= the quantile,
    and not one lap earlier."""
    for p in GRID:
        if not 0 < p < 1:
            continue
        k = laps_until_pit(p)
        h = 1 - (1 - p) ** (1 / PIT_LABEL_HORIZON_LAPS)
        assert 1 - (1 - h) ** k >= PIT_WAIT_QUANTILE - 1e-12
        if k > 1:
            assert 1 - (1 - h) ** (k - 1) < PIT_WAIT_QUANTILE + 1e-12


def test_edges():
    assert laps_until_pit(0) == math.inf and laps_until_pit(-0.1) == math.inf
    assert laps_until_pit(None) == math.inf and laps_until_pit(float('nan')) == math.inf
    assert laps_until_pit(1) == 1 and laps_until_pit(1.5) == 1
    assert optimal_pit_lap(0, 20, 60) == 58       # no stop projected: the last allowed lap
    assert optimal_pit_lap(1, 20, 60) == 21
    assert optimal_pit_lap(0.3, 59, 60) == 60     # race end: the next lap


EXTREME_P = [0.0, 5e-324, 1e-300, 1e-17, 1e-16, 1.1e-16, 2e-16, 1e-12,
             0.49, 0.5, 0.51, 1 - 1e-12, 1 - 1e-16, 1 - 1e-17, 1.0]


def test_extreme_probabilities_never_raise():
    """p tiny (log(1 - p) == 0.0 for p < ~1.1e-16 divided by zero),
    p a denormal (k overflows a float), p 1 - 1e-17 (rounds to 1) and the
    exact edges 0 and 1: a lap count or inf, never an exception, and the
    mapping stays non-increasing on a grid that mixes them with the dense one."""
    for p in EXTREME_P:
        k = laps_until_pit(p)
        assert k == math.inf or (isinstance(k, int) and k >= 1), (p, k)
        lap = optimal_pit_lap(p, 20, 60)
        assert isinstance(lap, int) and 21 <= lap <= 58, (p, lap)
    grid = sorted(set(GRID) | set(EXTREME_P))
    assert non_increasing([laps_until_pit(p) for p in grid])
    assert non_increasing([optimal_pit_lap(p, 20, 60) for p in grid])
    # a tiny but positive p projects a finite stop far away (no stop in the race)
    assert laps_until_pit(1e-17) > 10 ** 16 and optimal_pit_lap(1e-17, 20, 60) == 58
    assert laps_until_pit(5e-324) == math.inf
    assert laps_until_pit(1 - 1e-17) == 1 and laps_until_pit(1 - 1e-12) == 1
    print('extreme p:', {p: laps_until_pit(p) for p in EXTREME_P})


def test_router_and_model_never_raise_on_extreme_probabilities():
    """The two callers of the one mapping (the router's heuristic path and
    model/predict.py) on the extreme probabilities."""
    import model.predict as predict

    for p in EXTREME_P:
        assert predict._compute_optimal_pit_lap(p, 20, 60, 10) == optimal_pit_lap(p, 20, 60)


def test_label_horizon_is_the_training_label():
    """PIT_LABEL_HORIZON_LAPS is model/prepare_data.py PREDICT_LEN (read from
    the source: importing prepare_data pulls in FastF1)."""
    tree = ast.parse((BACKEND / 'model' / 'prepare_data.py').read_text(encoding='utf-8'))
    values = [node.value.value for node in tree.body if isinstance(node, ast.Assign)
              and any(getattr(t, 'id', None) == 'PREDICT_LEN' for t in node.targets)]
    assert values == [PIT_LABEL_HORIZON_LAPS]


def test_one_implementation_for_model_and_router():
    import api.routers.predictions as pred
    import model.pit_timing as pit_timing
    import model.predict as predict

    assert pred._pit_lap_from_probability is pit_timing.optimal_pit_lap
    assert predict._pit_lap_from_probability is pit_timing.optimal_pit_lap
    for p in GRID:
        assert predict._compute_optimal_pit_lap(p, 20, 60, 10) == optimal_pit_lap(p, 20, 60)


def test_heuristics_pit_later_never_with_older_tyres():
    """Both heuristics raise the pit probability with tyre life, so the
    projected pit lap never moves later as the tyres age; the router's
    built-in heuristic and model/predict.py give the same lap."""
    import api.routers.predictions as pred
    import model.predict as predict

    for current_lap, max_lap in [(20, 60), (40, 53)]:
        router_laps, model_laps = [], []
        for tyre_life in range(0, 45):
            laps = [{'lap_time': 90.0, 'tyre_life': tyre_life, 'compound': 'MEDIUM'}] * 10
            r = pred._builtin_heuristic(laps, current_lap=current_lap, max_lap=max_lap, driver='AAA')
            m = predict._heuristic_prediction(laps, current_lap=current_lap, max_lap=max_lap, driver='AAA')
            assert r['pit_probability'] == m['pit_probability']
            router_laps.append(r['optimal_pit_lap'])
            model_laps.append(m['optimal_pit_lap'])
        assert router_laps == model_laps
        assert non_increasing(router_laps)
        print(f'heuristic pit lap at lap {current_lap}/{max_lap}, tyre life 0..44:', router_laps)
