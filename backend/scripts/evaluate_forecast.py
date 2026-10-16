"""
Held-out evaluation of the lap-time forecast and of the pit probability, and
the method selection the endpoint serves (model/saved/forecast_selection.json).

Samples: model/prepare_data.py samples_from_payload (one window per driver
and completed lap, built with model/features.py build_window, the serving
builder) of the races of the split in model/saved/model_config.json (the
split the LSTM was trained with; model/train.py split_races when absent).
Forecasts: model/predict.py lap_time_forecasts / pit_probabilities, the
functions the endpoint calls, with the baseline parameters fitted here on
the training races only:
  compound_mean      mean fuel-corrected slope per compound of the training
                     races' stint_fits (degradation.py compound_degradation)
  tyre_age_logistic  LogisticRegression(origin tyre life + compound one-hot)
  base_rate          the training races' pit-label rate

Lap times: MAE per lap ahead (+1..+5) and pooled, over the laps that are
targets (clean laps of the origin's stint, prepare_data.py), on the
validation and test races; a race-block bootstrap interval of each method's
difference to persistence on the test races; pooled MAE by origin compound.
Pit probability (label: a stop within the next 5 laps): precision and recall
at PIT_THRESHOLD, PR-AUC (average precision), Brier score and a calibration
table, on the test races.

Selection (the decision rule, select_by): the choice is made on the
VALIDATION races only, lap times = the method with the lowest pooled
validation MAE, pit probability = the lowest validation Brier score. The test
races play no part in it: their numbers are reported as the held-out score of
each method (the served `held_out`), with their own ranking (test_ranking),
so the number quoted for the served method is not the one it was picked on.
The file keeps both rankings, every method's numbers, and the sha1 of the
LSTM weights it measured (model/predict.py ignores an LSTM that changed
since). An LSTM whose model_config.json has no race split cannot be
evaluated on held-out races: the run is refused.

Run from backend/ (seeded, deterministic):
  python -m scripts.evaluate_forecast [--out ../docs/evidence/evaluate_forecast.txt]
"""
import datetime
import json
import sys
import time
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from data.processors.degradation import compound_degradation, stint_fits  # noqa: E402
from model import baselines, predict  # noqa: E402
from model.features import PREDICT_LEN  # noqa: E402
from model.prepare_data import discover_processed_cache_rounds, load_payload, race_id, samples_from_payload  # noqa: E402
from model.train import split_races  # noqa: E402

BOOTSTRAP_N = 2000
BOOTSTRAP_SEED = 7
CALIBRATION_BINS = 10
# Probability above which a pit stop is called (precision / recall)
PIT_THRESHOLD = 0.5

SELECTION_PATH = predict.MODEL_DIR / predict.SELECTION_FILE


def fit_baselines(payloads, samples):
    """Baseline parameters from the training races only."""
    from sklearn.linear_model import LogisticRegression

    fits = []
    for rid, payload in payloads.items():
        fits.extend(stint_fits(payload.get('lap_times') or []))
    deg = compound_degradation(fits)
    slopes = {c: v['mean'] for c, v in deg.items()}
    pooled = [f['slope'] for f in fits if f['slope'] is not None]
    slopes['ALL'] = float(np.mean(pooled)) if pooled else 0.0
    X = np.array([baselines.logistic_row(s['ctx']) for s in samples], dtype=float)
    y = np.array([s['pit'] for s in samples], dtype=float)
    lr = LogisticRegression(max_iter=5000).fit(X, y)
    return {
        'compound_slopes': slopes,
        'compound_slopes_n': {c: v['n'] for c, v in deg.items()},
        'logistic': {'intercept': float(lr.intercept_[0]), 'coef': [float(c) for c in lr.coef_[0]],
                     'inputs': ['origin_tyre_life'] + [f'compound_{c}' for c in baselines.LOGISTIC_COMPOUNDS]},
        'base_rate': float(y.mean()),
    }


def predictions(samples, selection):
    """Arrays per method: lap-time errors (N, PREDICT_LEN; NaN = no target),
    pit probabilities (N,), plus the stint-fit coverage."""
    lstm = None
    if samples and predict.lstm_available():
        lstm = predict.lstm_outputs(np.stack([s['x'] for s in samples]))
    errs, pits, fitted = {}, {}, []
    truth = np.array([s['y_time'] for s in samples], dtype=float)
    for i, s in enumerate(samples):
        one = (lstm[0][i], lstm[1][i]) if lstm is not None else None
        times = predict.lap_time_forecasts(s['ctx'], selection=selection, lstm=one)
        for m, t in times.items():
            errs.setdefault(m, np.full((len(samples), PREDICT_LEN), np.nan))[i] = np.asarray(t) - truth[i]
        for m, p in predict.pit_probabilities(s['ctx'], selection=selection, lstm=one).items():
            pits.setdefault(m, np.zeros(len(samples)))[i] = p
        fitted.append(baselines.stint_linear(s['ctx'])[1])
    return errs, pits, np.array(fitted)


def pooled_mae(err, rows=None):
    e = np.abs(err if rows is None else err[rows])
    return float(np.nanmean(e)) if np.isfinite(e).any() else float('nan')


def race_bootstrap(errs, races, base='persistence'):
    """95% interval of (method MAE - base MAE) over races resampled with replacement."""
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    ids = sorted(set(races))
    sums = {m: {r: (np.nansum(np.abs(e[races == r])), np.isfinite(e[races == r]).sum()) for r in ids}
            for m, e in errs.items()}
    draws = {m: [] for m in errs}
    for _ in range(BOOTSTRAP_N):
        pick = rng.choice(ids, size=len(ids), replace=True)
        b_s = sum(sums[base][r][0] for r in pick)
        b_n = sum(sums[base][r][1] for r in pick)
        for m in errs:
            s_ = sum(sums[m][r][0] for r in pick)
            n_ = sum(sums[m][r][1] for r in pick)
            draws[m].append(s_ / n_ - b_s / b_n)
    return {m: (float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))) for m, d in draws.items()}


def pit_metrics(p, y):
    from sklearn.metrics import average_precision_score

    called = p >= PIT_THRESHOLD
    tp = float(np.sum(called & (y == 1)))
    precision = tp / called.sum() if called.sum() else float('nan')
    recall = tp / (y == 1).sum() if (y == 1).sum() else float('nan')
    edges = np.linspace(0, 1, CALIBRATION_BINS + 1)
    table = []
    for k in range(CALIBRATION_BINS):
        hi = edges[k + 1]
        rows = (p >= edges[k]) & ((p < hi) if k < CALIBRATION_BINS - 1 else (p <= hi))
        table.append({'bin': [float(edges[k]), float(hi)], 'n': int(rows.sum()),
                      'mean_predicted': float(p[rows].mean()) if rows.any() else None,
                      'observed_rate': float(y[rows].mean()) if rows.any() else None})
    return {
        'brier': float(np.mean((p - y) ** 2)),
        'pr_auc': float(average_precision_score(y, p)) if len(set(y)) > 1 else float('nan'),
        'precision': precision, 'recall': recall,
        'called': int(called.sum()), 'mean_predicted': float(p.mean()), 'calibration': table,
    }


def select_by(numbers, key='val'):
    """Methods ordered by numbers[m][key], lowest first (MAE, Brier: lower is
    better); ties keep the given order. key='val' is the selection ranking,
    key='test' the held-out ranking that is only reported."""
    return sorted(numbers, key=lambda m: numbers[m][key])


def fmt(v, w=8, d=3):
    return f'{v:>{w}.{d}f}' if v is not None and np.isfinite(v) else f"{'n/a':>{w}}"


def main():
    started = time.perf_counter()
    predict._load_model(check_fingerprint=False)
    config = predict._config or {}
    rounds = discover_processed_cache_rounds()
    races_all = [race_id(y, r) for y, r, _ in rounds]
    if predict.lstm_available() and not config.get('split'):
        # The LSTM's training races are unknown: its "held-out" numbers could
        # come from races it was trained on
        raise SystemExit('model_config.json has no race split for the saved LSTM: it cannot be evaluated on '
                         'held-out races. Retrain it (python -m model.train) on windows with lstm_meta.json.')
    split = config.get('split') or split_races(races_all)
    print('=' * 100)
    print('FORECAST EVALUATION (scripts/evaluate_forecast.py)')
    print('=' * 100)
    print(f"LSTM available: {predict.lstm_available()} ({predict._lstm_issue or 'loaded'}); "
          f"weights sha1 {predict.model_fingerprint()}")
    if config:
        print(f"LSTM training: {config.get('epochs_trained')} epochs (best {config.get('best_epoch')}), "
              f"{config.get('train_seconds')} s on CPU, split seed {config.get('split_seed')}, "
              f"train seed {config.get('train_seed')}")
    for k in ('train', 'val', 'test'):
        print(f'{k:<5} races ({len(split[k])}): {", ".join(split[k])}')

    by_round = {race_id(y, r): (y, r) for y, r, _ in rounds}
    payloads, samples = {}, {}
    for k in ('train', 'val', 'test'):
        samples[k] = []
        for rid in split[k]:
            payloads[rid] = load_payload(*by_round[rid])
            samples[k].extend(samples_from_payload(payloads[rid], rid, keep_context=True))
    print('windows: ' + ', '.join(f'{k} {len(v)}' for k, v in samples.items()))

    params = fit_baselines({rid: payloads[rid] for rid in split['train']}, samples['train'])
    selection_params = {'baselines': params}
    print('\nBaselines fitted on the training races:')
    print('  compound mean fuel-corrected slope, s/lap: ' + ', '.join(
        f"{c} {v:+.4f} (n={params['compound_slopes_n'].get(c, '-')})" for c, v in params['compound_slopes'].items()))
    print(f"  tyre-age logistic: intercept {params['logistic']['intercept']:+.3f}, coef " + ', '.join(
        f'{n} {c:+.3f}' for n, c in zip(params['logistic']['inputs'], params['logistic']['coef'])))
    print(f"  pit base rate: {params['base_rate']:.4f}")

    results = {}
    for k in ('val', 'test'):
        results[k] = predictions(samples[k], selection_params)

    # ------------------------------------------------------------- lap times
    methods = [m for m in baselines.LAP_TIME_METHODS if m in results['test'][0]]
    lap = {}
    for m in methods:
        lap[m] = {
            'test': pooled_mae(results['test'][0][m]),
            'val': pooled_mae(results['val'][0][m]),
            'test_by_horizon': [pooled_mae(results['test'][0][m][:, h]) for h in range(PREDICT_LEN)],
            'val_by_horizon': [pooled_mae(results['val'][0][m][:, h]) for h in range(PREDICT_LEN)],
            'n_test_laps': int(np.isfinite(results['test'][0][m]).sum()),
            'n_val_laps': int(np.isfinite(results['val'][0][m]).sum()),
        }
    # The choice on the validation races; the test ranking is only reported
    ranking = select_by(lap, 'val')
    test_ranking = select_by(lap, 'test')
    test_races = np.array([s['race'] for s in samples['test']])
    ci = race_bootstrap(results['test'][0], test_races)

    print('\n' + '-' * 100)
    print('LAP TIMES: mean absolute error, s (target laps = clean laps of the origin stint)')
    print('-' * 100)
    head = ''.join(f'{"+" + str(h + 1):>8}' for h in range(PREDICT_LEN))
    print(f"{'method':<16}{'set':<6}{head}{'pooled':>9}{'laps':>8}   diff to persistence, test, race bootstrap 95%")
    for m in methods:
        for k in ('val', 'test'):
            row = ''.join(fmt(v) for v in lap[m][f'{k}_by_horizon'])
            extra = ''
            if k == 'test':
                lo, hi = ci[m]
                extra = f'   [{lo:+.3f}, {hi:+.3f}]' if m != 'persistence' else '   (reference)'
            print(f"{m:<16}{k:<6}{row}{fmt(lap[m][k], 9)}{lap[m]['n_' + k + '_laps']:>8}{extra}")
    fitted = results['test'][2]
    print(f'stint_linear: the origin stint had a fit in {fitted.mean():.1%} of the test windows '
          '(persistence otherwise)')
    print('\nTest pooled MAE by origin compound, s:')
    comps = np.array([s['ctx']['origin_compound'] for s in samples['test']])
    print(f"{'compound':<14}{'windows':>8}" + ''.join(f'{m:>15}' for m in methods))
    for c in sorted(set(comps)):
        rows = comps == c
        print(f'{c:<14}{rows.sum():>8}' + ''.join(fmt(pooled_mae(results["test"][0][m], rows), 15) for m in methods))
    print('\nTest pooled MAE per race, s:')
    print(f"{'race':<10}" + ''.join(f'{m:>15}' for m in methods))
    for r in split['test']:
        rows = test_races == r
        print(f'{r:<10}' + ''.join(fmt(pooled_mae(results["test"][0][m], rows), 15) for m in methods))
    order = ' < '.join('{} ({:.3f})'.format(m, lap[m]['val']) for m in ranking)
    print(f'\nRanking by pooled validation MAE (the selection): {order}')
    order = ' < '.join('{} ({:.3f})'.format(m, lap[m]['test']) for m in test_ranking)
    print(f'Ranking by pooled test MAE (held-out, reported only): {order}')
    print(f"SELECTED lap-time method (on the validation races): {ranking[0]}; "
          f"held-out test MAE {lap[ranking[0]]['test']:.3f} s")
    if test_ranking != ranking:
        print(f'The test ranking differs from the validation ranking: {" < ".join(test_ranking)}.')
    if 'lstm' in lap and ranking[0] != 'lstm':
        print(f"The LSTM loses on the validation races: MAE {lap['lstm']['val']:.3f} s vs {ranking[0]} "
              f"{lap[ranking[0]]['val']:.3f} s (test {lap['lstm']['test']:.3f} s vs {lap[ranking[0]]['test']:.3f} s).")
    elif 'lstm' in lap and test_ranking[0] != 'lstm':
        print(f"The LSTM, chosen on validation, loses on the test races: MAE {lap['lstm']['test']:.3f} s vs "
              f"{test_ranking[0]} {lap[test_ranking[0]]['test']:.3f} s.")

    # ------------------------------------------------------- pit probability
    y_test = np.array([s['pit'] for s in samples['test']], dtype=float)
    y_val = np.array([s['pit'] for s in samples['val']], dtype=float)
    pit_methods = [m for m in baselines.PIT_METHODS if m in results['test'][1]]
    pit = {}
    print('\n' + '-' * 100)
    print(f'PIT PROBABILITY: stop within the next {PREDICT_LEN} laps; test base rate {y_test.mean():.4f} '
          f'({int(y_test.sum())} / {len(y_test)} windows)')
    print('-' * 100)
    print(f"{'method':<20}{'Brier':>9}{'PR-AUC':>9}{'precision':>11}{'recall':>9}{'called':>8}{'mean p':>9}{'val Brier':>11}")
    for m in pit_methods:
        t = pit_metrics(results['test'][1][m], y_test)
        v = pit_metrics(results['val'][1][m], y_val)
        pit[m] = {'test': t['brier'], 'val': v['brier'], 'pr_auc_test': t['pr_auc'], 'precision_test': t['precision'],
                  'recall_test': t['recall'], 'calibration_test': t['calibration']}
        print(f"{m:<20}{fmt(t['brier'], 9, 4)}{fmt(t['pr_auc'], 9)}{fmt(t['precision'], 11)}{fmt(t['recall'], 9)}"
              f"{t['called']:>8}{fmt(t['mean_predicted'], 9)}{fmt(v['brier'], 11, 4)}")
    for m in pit_methods:
        print(f'\nCalibration, test, {m}:')
        print(f"{'bin':<14}{'n':>7}{'mean p':>9}{'observed':>10}")
        for b in pit[m]['calibration_test']:
            print(f"[{b['bin'][0]:.1f}, {b['bin'][1]:.1f}]{'':<4}{b['n']:>7}{fmt(b['mean_predicted'], 9)}{fmt(b['observed_rate'], 10)}")
    pit_ranking = select_by(pit, 'val')
    pit_test_ranking = select_by(pit, 'test')
    order = ' < '.join('{} ({:.4f})'.format(m, pit[m]['val']) for m in pit_ranking)
    print(f'\nRanking by validation Brier (the selection): {order}')
    order = ' < '.join('{} ({:.4f})'.format(m, pit[m]['test']) for m in pit_test_ranking)
    print(f'Ranking by test Brier (held-out, reported only): {order}')
    print(f"SELECTED pit method (on the validation races): {pit_ranking[0]}; "
          f"held-out test Brier {pit[pit_ranking[0]]['test']:.4f}")
    if pit_test_ranking != pit_ranking:
        print(f'The test ranking differs from the validation ranking: {" < ".join(pit_test_ranking)}.')

    selection = {
        'generated_by': 'scripts/evaluate_forecast.py',
        'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'model_fingerprint': predict.model_fingerprint(),
        'split': split,
        'windows': {k: len(v) for k, v in samples.items()},
        'lap_time': {
            'metric': f'MAE over laps +1..+{PREDICT_LEN}, s, pooled over the target laps of the test races',
            'methods': lap,
            'bootstrap_diff_to_persistence_95': {m: list(v) for m, v in ci.items()},
            # ranking / selected: the choice, on the validation races;
            # test_ranking: the held-out order, reported only
            'selection_set': 'val',
            'ranking': ranking,
            'test_ranking': test_ranking,
            'selected': ranking[0],
        },
        'pit': {
            'metric': f'Brier score of a stop within {PREDICT_LEN} laps on the test races',
            'test_base_rate': float(y_test.mean()),
            'methods': pit,
            'selection_set': 'val',
            'ranking': pit_ranking,
            'test_ranking': pit_test_ranking,
            'selected': pit_ranking[0],
        },
        'baselines': {k: v for k, v in params.items() if k != 'compound_slopes_n'},
    }
    with open(SELECTION_PATH, 'w', encoding='utf-8') as f:
        json.dump(selection, f, indent=2)
    print(f'\nSelection written to {SELECTION_PATH.relative_to(BACKEND)} ({time.perf_counter() - started:.1f} s)')


if __name__ == '__main__':
    from scripts.evidence_out import pop_out, tee_stdout
    with tee_stdout(pop_out(sys.argv[1:])[0]):
        main()
