"""
Tyre degradation: ONE definition of the laps a degradation fit may use, of
the fuel correction, of the per-stint fit and of the consistency sigma.

Pure functions over the JSON lap rows of a session payload
(``session_*.json['lap_times']``); no FastF1, pandas or numpy. Same
definition, same names (snake_case) and same results as
frontend/src/utils/degradation.js: the parity test
frontend/src/utils/__tests__/degradation.parity.test.js runs this module and
compares the laps and the fits (to 1e-9) on every cached race. Sums are plain
loops in lap order, never ``sum()`` (compensated since Python 3.12, so it
would not give the bits of the JavaScript loop). docs/DEGRADATION_METHODOLOGY.md
describes the definition.

Clean stint laps (clean_stint_laps), per stint of build_tyre_strategy:
 1. the stints are build_tyre_strategy of the laps completed at session_now
    (same set as deriveStints in stints.js);
 2. a lap of the stint is usable when it is completed at session_now,
    LapNumber > 1, not an in-lap, not an out-lap, green (TrackStatus exactly
    '1'), 0 < LapTimeSeconds < MAX_LAP_TIME_S and TyreLife is a number;
 3. slow outliers: when the stint has a fit (fit_stint on the laps of step 2),
    a lap whose residual is more than OUTLIER_K robust sigmas above the median
    residual is removed (robust sigma = MAD_TO_SIGMA x the median absolute
    deviation of the residuals, at least MIN_ROBUST_SCALE_S). One pass, slow
    side only; the removed laps are returned as ``outliers``.

Fuel-corrected time = LapTimeSeconds + FUEL_EFFECT_S_PER_LAP * (LapNumber - 1).
Fit: ordinary least squares of the fuel-corrected time on TyreLife.
Times in session seconds; session_now None / NaN means no limit (inf).
"""
import math

from data.processors.stints import _group_by_driver, _has_pit_out, _is_set, _number, build_tyre_strategy

# Lap time gained per lap of fuel burnt, seconds. ASSUMPTION, not measured:
# 0.030 s/lap is the value the dashboard already uses (TireDegradation chart,
# its help text, /api predictions). It cannot be fitted from a stint: on every
# cached race LapNumber - TyreLife is constant over the clean laps of each
# stint (frontend/scripts/degradation_definition.mjs), so fuel burn and tyre
# age are collinear and only their sum (raw_slope) is observed.
FUEL_EFFECT_S_PER_LAP = 0.03

# Laps this slow are not racing laps (same cut as pitLoss.js MAX_GREEN_LAP_S)
MAX_LAP_TIME_S = 200

# Fewest laps for a fit. ASSUMPTION chosen from the cached races
# (degradation_definition.mjs "fit length" table); see degradation.js.
MIN_FIT_LAPS = 8

# Outlier cut in robust sigmas above the median residual. ASSUMPTION: the slow
# residual tail is far heavier than the fast one and than a normal tail
# (degradation_definition.mjs "residual tails"); see degradation.js.
OUTLIER_K = 3.5

# MAD -> standard deviation of a normal distribution (1 / Phi^-1(0.75))
MAD_TO_SIGMA = 1.4826

# Floor of the robust sigma, seconds: lap times are given to the millisecond
MIN_ROBUST_SCALE_S = 0.001


def _normalise_now(session_now):
    if session_now is None:
        return math.inf
    try:
        if math.isnan(session_now):
            return math.inf
    except TypeError:
        return math.inf
    return session_now


def _lap_end_time(lap):
    """Session seconds at which the row ended: Time, else LapStartTime +
    LapTimeSeconds (duration > 0); None otherwise. Same rule as lapEndTime in
    frontend/src/utils/raceTime.js."""
    end = _number(lap.get('Time'))
    if end is not None:
        return end
    start = _number(lap.get('LapStartTime'))
    dur = _number(lap.get('LapTimeSeconds'))
    if start is not None and dur is not None and dur > 0:
        return start + dur
    return None


def _is_lap_completed(lap, now):
    """Completed once its end is <= now; every row at now = inf. Same rule as
    isLapCompleted in frontend/src/utils/raceTime.js."""
    if now == math.inf:
        return True
    end = _lap_end_time(lap)
    return end is not None and end <= now


def _has_pit_in(lap):
    """True when the row is an in-lap (PitInTimeSeconds or PitInTime set)."""
    return _is_set(lap.get('PitInTimeSeconds')) or _is_set(lap.get('PitInTime'))


def _median(values):
    a = sorted(values)
    n = len(a)
    if not n:
        return None
    mid = n // 2
    return a[mid] if n % 2 else (a[mid - 1] + a[mid]) / 2


def is_clean_lap(lap):
    """Step 2 of the clean-lap rule for one completed lap row: LapNumber > 1,
    no pit entry, no pit exit, green, 0 < LapTimeSeconds < MAX_LAP_TIME_S,
    TyreLife a number."""
    n = _number(lap.get('LapNumber'))
    t = _number(lap.get('LapTimeSeconds'))
    return (n is not None and n > 1
            and not _has_pit_in(lap) and not _has_pit_out(lap)
            and str(lap.get('TrackStatus')) == '1'
            and t is not None and 0 < t < MAX_LAP_TIME_S
            and _number(lap.get('TyreLife')) is not None)


def fuel_corrected_time(lap):
    """LapTimeSeconds + FUEL_EFFECT_S_PER_LAP * (LapNumber - 1), seconds."""
    return _number(lap.get('LapTimeSeconds')) + FUEL_EFFECT_S_PER_LAP * (_number(lap.get('LapNumber')) - 1)


def _fit_core(laps):
    """(fit, residuals, sse), or None below MIN_FIT_LAPS or with a single
    TyreLife value. Same operations, in the same order, as fitCore in
    degradation.js."""
    n = len(laps)
    if n < MIN_FIT_LAPS:
        return None
    xs = [_number(lap.get('TyreLife')) for lap in laps]
    ys = [fuel_corrected_time(lap) for lap in laps]
    raw = [_number(lap.get('LapTimeSeconds')) for lap in laps]
    sx = sy = sr = 0.0
    for i in range(n):
        sx += xs[i]
        sy += ys[i]
        sr += raw[i]
    mx, my, mr = sx / n, sy / n, sr / n
    sxx = sxy = sxr = 0.0
    for i in range(n):
        dx = xs[i] - mx
        sxx += dx * dx
        sxy += dx * (ys[i] - my)
        sxr += dx * (raw[i] - mr)
    if not sxx > 0:
        return None
    slope = sxy / sxx
    intercept = my - slope * mx
    residuals = []
    sse = 0.0
    for i in range(n):
        e = ys[i] - (intercept + slope * xs[i])
        residuals.append(e)
        sse += e * e
    residual_sigma = math.sqrt(sse / (n - 2))
    fit = {
        'slope': slope,
        'raw_slope': sxr / sxx,
        'intercept': intercept,
        'n': n,
        'residual_sigma': residual_sigma,
        'slope_std_err': residual_sigma / math.sqrt(sxx),
        'tyre_life_min': min(xs),
        'tyre_life_max': max(xs),
    }
    return fit, residuals, sse


def fit_stint(laps):
    """Per-stint degradation fit: ordinary least squares of the fuel-corrected
    lap time on TyreLife.

    Returns {slope (fuel-corrected s per lap of tyre life), raw_slope (same fit
    on LapTimeSeconds), intercept (fuel-corrected s at TyreLife 0), n,
    residual_sigma (sqrt(SSE / (n - 2))), slope_std_err (residual_sigma /
    sqrt(sum (TyreLife - mean)^2)), tyre_life_min, tyre_life_max}, or None
    with fewer than MIN_FIT_LAPS laps or a single TyreLife value. Negative
    slopes are returned as they are. Same as fitStint in degradation.js.
    """
    if not isinstance(laps, list):
        return None
    core = _fit_core(laps)
    return core[0] if core else None


def _split_outliers(laps):
    """Step 3: (kept, outliers) of the laps of step 2."""
    core = _fit_core(laps)
    if not core:
        return laps, []
    e = core[1]
    m = _median(e)
    scale = max(MAD_TO_SIGMA * _median([abs(v - m) for v in e]), MIN_ROBUST_SCALE_S)
    limit = OUTLIER_K * scale
    kept, outliers = [], []
    for lap, v in zip(laps, e):
        (outliers if v - m > limit else kept).append(lap)
    return kept, outliers


def clean_stint_laps(lap_rows, session_now=math.inf, driver=None):
    """The laps of every stint usable for degradation at session_now (see the
    module docstring). One entry per stint with at least one completed lap,
    sorted by driver then stint_number:
      {driver, stint_number, compound, start_lap, end_lap, laps, outliers}
    start_lap / end_lap / compound from build_tyre_strategy of the completed
    laps (end_lap = last completed lap); laps = clean rows in lap order;
    outliers = rows removed by the slow-outlier step. Same as cleanStintLaps
    in degradation.js.
    """
    now = _normalise_now(session_now)
    rows = [lap for lap in lap_rows or [] if isinstance(lap, dict)
            and (driver is None or lap.get('Driver') == driver)]
    done = [lap for lap in rows if _is_lap_completed(lap, now)]
    grouped = _group_by_driver(done)
    stints = sorted(build_tyre_strategy(done), key=lambda st: (st['Driver'], st['StintNumber']))
    out = []
    for st in stints:
        laps = [lap for lap in grouped.get(st['Driver'], [])
                if st['StartLap'] <= _number(lap.get('LapNumber')) <= st['EndLap'] and is_clean_lap(lap)]
        kept, outliers = _split_outliers(laps)
        out.append({
            'driver': st['Driver'],
            'stint_number': st['StintNumber'],
            'compound': st['Compound'],
            'start_lap': st['StartLap'],
            'end_lap': st['EndLap'],
            'laps': kept,
            'outliers': outliers,
        })
    return out


def _bound(value, default):
    n = _number(value)
    return default if n is None else n


def _stint_cores(lap_rows, session_now=math.inf, driver=None, lap_start=None, lap_end=None):
    lo = _bound(lap_start, -math.inf)
    hi = _bound(lap_end, math.inf)
    out = []
    for st in clean_stint_laps(lap_rows, session_now=session_now, driver=driver):
        if st['end_lap'] < lo or st['start_lap'] > hi:
            continue
        laps = [lap for lap in st['laps'] if lo <= _number(lap.get('LapNumber')) <= hi]
        outliers = [lap for lap in st['outliers'] if lo <= _number(lap.get('LapNumber')) <= hi]
        out.append((st, laps, len(outliers), _fit_core(laps)))
    return out


def stint_fits(lap_rows, session_now=math.inf, driver=None, lap_start=None, lap_end=None):
    """One row per stint: fit_stint on its clean laps, optionally only the laps
    in [lap_start, lap_end] (inclusive; None = no bound). Stints with no lap
    in the range are left out. A stint with too few clean laps keeps its row
    with slope, raw_slope, intercept, residual_sigma and slope_std_err None
    (n = its clean laps in the range). Rows:
      {driver, stint_number, compound, start_lap, end_lap, slope, raw_slope,
       intercept, n, residual_sigma, slope_std_err, tyre_life_min, tyre_life_max}
    sorted by driver then stint_number. Same as stintFits in degradation.js.
    """
    out = []
    for st, laps, _, core in _stint_cores(lap_rows, session_now, driver, lap_start, lap_end):
        if core:
            fit = core[0]
        else:
            tl = [_number(lap.get('TyreLife')) for lap in laps]
            fit = {
                'slope': None, 'raw_slope': None, 'intercept': None, 'n': len(laps),
                'residual_sigma': None, 'slope_std_err': None,
                'tyre_life_min': min(tl) if tl else None,
                'tyre_life_max': max(tl) if tl else None,
            }
        out.append({
            'driver': st['driver'],
            'stint_number': st['stint_number'],
            'compound': st['compound'],
            'start_lap': st['start_lap'],
            'end_lap': st['end_lap'],
            **fit,
        })
    return out


def compound_degradation(fits):
    """{compound: {mean, median, std_dev, n, negative_count}} over per-stint
    fits (stint_fits rows; rows with slope None are skipped), s/lap. Negative
    slopes are kept and counted, never clamped. std_dev = sample standard
    deviation (0 with one fit). Same as compoundDegradation in degradation.js.
    """
    groups = {}
    for f in fits or []:
        if not isinstance(f, dict):
            continue
        s = _number(f.get('slope'))
        if s is None:
            continue
        c = f.get('compound')
        if c is None:
            c = 'UNKNOWN'
        groups.setdefault(c, []).append(s)
    out = {}
    for c, slopes in groups.items():
        n = len(slopes)
        total = 0.0
        negative = 0
        for s in slopes:
            total += s
            if s < 0:
                negative += 1
        mean = total / n
        ss = 0.0
        for s in slopes:
            ss += (s - mean) * (s - mean)
        out[c] = {
            'mean': mean,
            'median': _median(slopes),
            'std_dev': math.sqrt(ss / (n - 1)) if n > 1 else 0,
            'n': n,
            'negative_count': negative,
        }
    return out


def consistency_sigma(lap_rows, driver, session_now=math.inf, lap_start=None, lap_end=None):
    """A driver's lap-time consistency: the pooled residual sigma of the
    driver's per-stint fits, sqrt(sum SSE / sum (n - 2)) over the fitted
    stints, seconds. Returns {sigma (None when no stint is fitted), n (laps of
    the fitted stints), stints (fitted stints), outliers (slow outlier laps of
    the fitted stints left out)}. Same as consistencySigma in degradation.js.
    """
    sse = 0.0
    dof = 0
    n = 0
    stints = 0
    outliers = 0
    for _, _, k, core in _stint_cores(lap_rows, session_now, driver, lap_start, lap_end):
        if not core:
            continue
        sse += core[2]
        dof += core[0]['n'] - 2
        n += core[0]['n']
        stints += 1
        outliers += k
    return {'sigma': math.sqrt(sse / dof) if dof > 0 else None, 'n': n, 'stints': stints, 'outliers': outliers}
