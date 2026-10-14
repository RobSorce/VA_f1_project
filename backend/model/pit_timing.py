"""
Pit timing from a pit probability: ONE mapping from the LSTM's pit
probability to the laps until the projected stop, used by model/predict.py
(model and heuristic paths) and by the built-in heuristic of
api/routers/predictions.py.

The pit probability is the model's answer to its training label
(model/prepare_data.py): 1 when any of the next PIT_LABEL_HORIZON_LAPS laps
is an in-lap. With a constant per-lap pit hazard h that matches it,
p = 1 - (1 - h) ** H (H = PIT_LABEL_HORIZON_LAPS), and the stop has happened
by lap k with probability 1 - (1 - h) ** k. The laps until the stop are the
k at which that probability reaches PIT_WAIT_QUANTILE:

    k(p) = H * ln(1 - PIT_WAIT_QUANTILE) / ln(1 - p)

k is continuous and strictly decreasing in p on (0, 1): a higher pit
probability never moves the stop later, and nothing jumps at p = 0.5
(k(0.5) = H exactly). p <= 0 gives no stop (k = inf); p >= 1 gives the next
lap. The lap count is ceil(k), at least 1, so it stays non-increasing.
ln(1 - p) is computed as log1p(-p): math.log(1 - p) is 0.0 for 0 < p below
about 1.1e-16 (1 - p rounds to 1), which divided by zero (p = 1e-17, a
sigmoid logit of -38 or lower). A k too large for a float (p a denormal)
is no stop projected, as p <= 0.

Pure module (math only): no numpy, no torch, so the router can import it
when PyTorch is missing.
"""
import math

# Laps of the pit label: the model is trained on "pit within the next 5 laps"
# (model/prepare_data.py PREDICT_LEN = 5; backend/tests/test_predictions_pit_timing.py
# checks the two stay equal).
PIT_LABEL_HORIZON_LAPS = 5

# Quantile of the waiting time reported as "laps until the stop". ASSUMPTION:
# the median, i.e. the first lap by which the stop is more likely than not;
# chosen so that p = 0.5 over the label horizon maps to that horizon exactly.
PIT_WAIT_QUANTILE = 0.5

# ASSUMPTION (documented, not fitted): the per-lap pit hazard is constant over
# the label horizon and after it. It is the simplest hazard that reproduces p
# over the horizon; a real stop is more likely as the tyres age, so for low p
# the projected stop is late rather than early.


def laps_until_pit(pit_prob):
    """Laps until the projected stop for a pit probability (see the module
    docstring): ceil(k(p)), at least 1; math.inf when p <= 0 or p is not a
    finite number (no stop projected). Non-increasing in p."""
    try:
        p = float(pit_prob)
    except (TypeError, ValueError):
        return math.inf
    if not math.isfinite(p) or p <= 0:
        return math.inf
    if p >= 1:
        return 1
    log_survival = math.log1p(-p)
    if not log_survival < 0:
        return math.inf
    k = PIT_LABEL_HORIZON_LAPS * math.log1p(-PIT_WAIT_QUANTILE) / log_survival
    if not math.isfinite(k):
        return math.inf
    return max(1, math.ceil(k))


def optimal_pit_lap(pit_prob, current_lap, max_lap):
    """Projected pit lap: current_lap + laps_until_pit(pit_prob), clamped to
    [current_lap + 1, max_lap - 2] (the last two laps are never a stop; the
    lower bound wins when the race is that close to the end). Non-increasing
    in pit_prob for a fixed current_lap and max_lap."""
    k = laps_until_pit(pit_prob)
    last = max_lap - 2
    target = last if k == math.inf else min(current_lap + k, last)
    return int(max(current_lap + 1, target))
