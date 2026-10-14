"""
Forecast methods other than the LSTM, on a model/features.py build_window
context. ONE implementation used by the evaluation
(scripts/evaluate_forecast.py) and by serving (model/predict.py), so the
held-out numbers of model/saved/forecast_selection.json are the numbers of
the forecast the endpoint returns.

Lap times (next PREDICT_LEN laps after the origin lap):
  persistence    every lap = the last clean lap (ref_time).
  stint_linear   the per-stint degradation fit of degradation.py (fit_stint
                 on the clean laps of the origin's stint at the clock),
                 extrapolated: intercept + slope * TyreLife - fuel burn
                 (FUEL_EFFECT_S_PER_LAP * (LapNumber - 1)). Persistence when
                 the stint has no fit yet (fewer than MIN_FIT_LAPS clean laps).
  compound_mean  the last clean lap plus, per lap after it, the mean
                 fuel-corrected degradation of the origin compound over the
                 training races (compound_degradation of their stint_fits)
                 minus the fuel effect.
Pit probability (a stop, i.e. a tyre change, within PREDICT_LEN laps):
  tyre_age_logistic  logistic regression on the origin tyre life and the
                     origin compound, fitted on the training races.
  base_rate          the training races' rate of the label.

The fitted parameters (compound slopes, logistic coefficients, base rate) are
read from the selection file, never written here.
"""
import math

from data.processors.degradation import FUEL_EFFECT_S_PER_LAP

from model.features import PREDICT_LEN

LAP_TIME_METHODS = ('persistence', 'stint_linear', 'compound_mean', 'lstm')
PIT_METHODS = ('lstm', 'tyre_age_logistic', 'base_rate')

METHOD_LABELS = {
    'persistence': 'Persistence (next laps = last clean lap)',
    'stint_linear': 'Per-stint linear extrapolation',
    'compound_mean': 'Last clean lap + compound mean degradation',
    'lstm': 'LSTM',
    'tyre_age_logistic': 'Tyre-age logistic regression',
    'base_rate': 'Base rate',
}

# Compounds of the logistic regression's one-hot columns (others: all zero)
LOGISTIC_COMPOUNDS = ('SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET')


def persistence(ctx):
    """[ref_time] * PREDICT_LEN."""
    return [ctx['ref_time']] * PREDICT_LEN


def stint_linear(ctx):
    """(times, fitted): the origin stint's fit extrapolated to laps
    origin_lap + 1 .. + PREDICT_LEN (TyreLife origin_tyre_life + k), or
    persistence and fitted False when the stint has no fit."""
    fit = ctx.get('stint_fit')
    if not fit or fit.get('slope') is None:
        return persistence(ctx), False
    lap, tl = ctx['origin_lap'], ctx['origin_tyre_life']
    return [fit['intercept'] + fit['slope'] * (tl + k) - FUEL_EFFECT_S_PER_LAP * (lap + k - 1)
            for k in range(1, PREDICT_LEN + 1)], True


def compound_mean(ctx, compound_slopes):
    """ref_time + (slope of the origin compound - fuel effect) per lap after
    the reference lap. compound_slopes: {compound: mean fuel-corrected slope,
    'ALL': pooled mean} from the selection file; a compound without a
    training mean uses 'ALL'."""
    slopes = compound_slopes or {}
    s = slopes.get(ctx.get('origin_compound'), slopes.get('ALL', 0.0))
    step = s - FUEL_EFFECT_S_PER_LAP
    return [ctx['ref_time'] + step * (ctx['origin_lap'] + k - ctx['ref_lap']) for k in range(1, PREDICT_LEN + 1)]


def logistic_row(ctx):
    """Inputs of the tyre-age logistic regression: [origin tyre life] +
    one-hot of the origin compound over LOGISTIC_COMPOUNDS."""
    comp = ctx.get('origin_compound')
    return [float(ctx['origin_tyre_life'])] + [1.0 if comp == c else 0.0 for c in LOGISTIC_COMPOUNDS]


def tyre_age_logistic(ctx, params):
    """sigmoid(intercept + coef . logistic_row(ctx))."""
    z = params['intercept'] + sum(c * x for c, x in zip(params['coef'], logistic_row(ctx)))
    return 1.0 / (1.0 + math.exp(-z)) if z > -700 else 0.0


def base_rate(ctx, rate):
    return float(rate)
