/**
 * Tyre degradation: ONE definition of the laps a degradation fit may use, of
 * the fuel correction, of the per-stint fit and of the consistency sigma.
 * backend/data/processors/degradation.py is the same definition in Python
 * (same names in snake_case); src/utils/__tests__/degradation.parity.test.js
 * checks that both give the same laps and the same fits (to 1e-9) on every
 * cached race. docs/DEGRADATION_METHODOLOGY.md describes it; its numbers come
 * from scripts/degradation_definition.mjs
 * (docs/evidence/degradation_definition_monza.txt).
 *
 * Clean stint laps (cleanStintLaps), per stint of stints.js:
 *  1. the stints are deriveStints of the laps completed at sessionNow (the
 *     split is causal, so these are the stints of deriveStints at sessionNow
 *     that have at least one completed lap);
 *  2. a lap of the stint is usable when it is completed at sessionNow,
 *     LapNumber > 1 (standing start), not an in-lap (pit entry), not an
 *     out-lap (pit exit), green (TrackStatus exactly '1': no yellow, SC, VSC
 *     or red at any point of the lap), 0 < LapTimeSeconds < MAX_LAP_TIME_S
 *     and TyreLife is a number;
 *  3. slow outliers: when the stint has a fit (fitStint on the laps of step
 *     2), a lap whose residual is more than OUTLIER_K robust sigmas above the
 *     median residual is removed (robust sigma = MAD_TO_SIGMA x the median
 *     absolute deviation of the residuals, at least MIN_ROBUST_SCALE_S). One
 *     pass, slow side only; the removed laps are returned as `outliers`.
 *
 * Fuel correction: fuel-corrected time = LapTimeSeconds
 * + FUEL_EFFECT_S_PER_LAP x (LapNumber - 1), i.e. the time the lap would have
 * taken with the lap-1 fuel load.
 *
 * Fit (fitStint): ordinary least squares of the fuel-corrected time on
 * TyreLife; slope = degradation in seconds per lap of tyre life.
 *
 * Every function is causal at sessionNow (session seconds, raceTime.js):
 * nothing from a lap not completed by then is used. A lap's outlier status can
 * change while its stint grows (the stint's fit changes).
 *
 * Pure module: no React, no D3, no store access.
 */
import { completedLaps, isGreenLap, hasPitIn, hasPitOut } from './raceTime';
import { deriveStints } from './stints';

/**
 * Lap time gained per lap of fuel burnt, seconds. ASSUMPTION, not measured:
 * 0.030 s/lap is the value the dashboard already uses (TireDegradation chart,
 * its help text, backend /api predictions). It cannot be fitted from a stint:
 * on every cached race LapNumber - TyreLife is constant over the clean laps
 * of each stint (scripts/degradation_definition.mjs), so fuel burn and tyre
 * age are collinear and only their sum (rawSlope) is observed. Consequence:
 * slope = rawSlope + FUEL_EFFECT_S_PER_LAP for every such stint.
 */
export const FUEL_EFFECT_S_PER_LAP = 0.03;

/** Laps this slow are not racing laps (same cut as pitLoss.js MAX_GREEN_LAP_S). */
export const MAX_LAP_TIME_S = 200;

/**
 * Fewest laps for a fit. ASSUMPTION, a trade-off read off the cached races
 * (scripts/degradation_definition.mjs, table B1, whole stints): below 8 laps
 * 22 % or more of the fits are steeper than 0.3 s/lap either way and their
 * median slope standard error is 0.079 s/lap or more; at 8 laps 13 % and
 * 0.066 s/lap. Longer minimums keep improving (10-11 laps: 8.5 %, 0.039) but
 * leave a stint without a fit for longer in replay. Below it fitStint returns
 * null.
 */
export const MIN_FIT_LAPS = 8;

/**
 * Outlier cut, in robust sigmas above the median residual. ASSUMPTION: the
 * slow tail of the residuals is far heavier than the fast one and than a
 * normal tail (scripts/degradation_definition.mjs, table C: beyond 3.5 robust
 * sigmas 3.08 % of the laps are slow, 0.32 % fast; a normal distribution puts
 * 0.047 % beyond it on both sides together). Slow laps that far out are not
 * tyre wear: e.g. 2024 R4 GAS stint 2, a green lap 3 of 138.362 s against a
 * stint median of 101.117 s, turns the slope from -1.0446 into +0.2316 s/lap
 * when removed (table D).
 */
export const OUTLIER_K = 3.5;

/** MAD -> standard deviation of a normal distribution (1 / Phi^-1(0.75)). */
export const MAD_TO_SIGMA = 1.4826;

/**
 * Floor of the robust sigma, seconds: lap times are given to the millisecond,
 * so a smaller spread is rounding (a perfectly linear stint would otherwise
 * flag rounding noise). On the cached races the floor never binds
 * (scripts/degradation_definition.mjs prints the smallest robust sigma).
 */
export const MIN_ROBUST_SCALE_S = 0.001;

/** Finite number from a number or numeric string, otherwise null (as raceTime.js). */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** undefined / null / NaN mean "no bound". */
function bound(v, dflt) {
  const n = toNum(v);
  return n == null ? dflt : n;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Step 2 of the clean-lap rule for one completed lap row: LapNumber > 1, no
 * pit entry, no pit exit, green, 0 < LapTimeSeconds < MAX_LAP_TIME_S, TyreLife
 * a number.
 *
 * @param {Object} lap - one lap_times row
 * @returns {boolean}
 */
export function isCleanLap(lap) {
  const n = toNum(lap?.LapNumber);
  const t = toNum(lap?.LapTimeSeconds);
  return n != null && n > 1
    && !hasPitIn(lap) && !hasPitOut(lap) && isGreenLap(lap)
    && t != null && t > 0 && t < MAX_LAP_TIME_S
    && toNum(lap?.TyreLife) != null;
}

/**
 * LapTimeSeconds + FUEL_EFFECT_S_PER_LAP x (LapNumber - 1), seconds.
 *
 * @param {Object} lap - one lap_times row with numeric LapTimeSeconds and LapNumber
 * @returns {number}
 */
export function fuelCorrectedTime(lap) {
  return toNum(lap.LapTimeSeconds) + FUEL_EFFECT_S_PER_LAP * (toNum(lap.LapNumber) - 1);
}

/**
 * The fit with its residuals and residual sum of squares (internal), or null
 * below MIN_FIT_LAPS or when every lap has the same TyreLife. Sums are plain
 * loops in lap order (the Python port does the same, so both give the same
 * bits).
 */
function fitCore(laps) {
  const n = laps.length;
  if (n < MIN_FIT_LAPS) return null;
  const xs = laps.map((lt) => toNum(lt.TyreLife));
  const ys = laps.map(fuelCorrectedTime);
  const raw = laps.map((lt) => toNum(lt.LapTimeSeconds));
  let sx = 0;
  let sy = 0;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sr += raw[i];
  }
  const mx = sx / n;
  const my = sy / n;
  const mr = sr / n;
  let sxx = 0;
  let sxy = 0;
  let sxr = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
    sxr += dx * (raw[i] - mr);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = [];
  let sse = 0;
  let tyreLifeMin = Infinity;
  let tyreLifeMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (intercept + slope * xs[i]);
    residuals.push(e);
    sse += e * e;
    if (xs[i] < tyreLifeMin) tyreLifeMin = xs[i];
    if (xs[i] > tyreLifeMax) tyreLifeMax = xs[i];
  }
  const residualSigma = Math.sqrt(sse / (n - 2));
  return {
    fit: {
      slope,
      rawSlope: sxr / sxx,
      intercept,
      n,
      residualSigma,
      slopeStdErr: residualSigma / Math.sqrt(sxx),
      tyreLifeMin,
      tyreLifeMax,
    },
    residuals,
    sse,
  };
}

/**
 * Per-stint degradation fit: ordinary least squares of the fuel-corrected
 * lap time (fuelCorrectedTime) on TyreLife.
 *
 *  slope         fuel-corrected seconds per lap of tyre life (the degradation)
 *  rawSlope      the same fit on LapTimeSeconds (fuel burn included)
 *  intercept     fuel-corrected seconds at TyreLife 0
 *  n             laps used
 *  residualSigma sqrt(sum of squared residuals / (n - 2)), seconds
 *  slopeStdErr   residualSigma / sqrt(sum (TyreLife - mean)^2), s/lap
 *  tyreLifeMin / tyreLifeMax  TyreLife range of the laps
 * Negative slopes are returned as they are (never clamped).
 *
 * @param {Array<Object>} laps - clean lap rows of one stint (cleanStintLaps), in lap order
 * @returns {{slope: number, rawSlope: number, intercept: number, n: number,
 *   residualSigma: number, slopeStdErr: number, tyreLifeMin: number, tyreLifeMax: number}|null}
 *   null with fewer than MIN_FIT_LAPS laps or a single TyreLife value
 */
export function fitStint(laps) {
  if (!Array.isArray(laps)) return null;
  const core = fitCore(laps);
  return core ? core.fit : null;
}

/** Step 3: split the laps of step 2 into kept laps and slow outliers. */
function splitOutliers(laps) {
  const core = fitCore(laps);
  if (!core) return { kept: laps, outliers: [] };
  const e = core.residuals;
  const m = median(e);
  const scale = Math.max(MAD_TO_SIGMA * median(e.map((v) => Math.abs(v - m))), MIN_ROBUST_SCALE_S);
  const limit = OUTLIER_K * scale;
  const kept = [];
  const outliers = [];
  laps.forEach((lt, i) => (e[i] - m > limit ? outliers : kept).push(lt));
  return { kept, outliers };
}

/** { driver: Map lapNumber -> row }, one row per (driver, lap): the last one wins (as stints.js). */
function rowsByDriver(lapTimes) {
  const by = new Map();
  for (const lt of lapTimes) {
    if (!lt?.Driver) continue;
    const n = Number(lt.LapNumber);
    if (!Number.isFinite(n)) continue;
    if (!by.has(lt.Driver)) by.set(lt.Driver, new Map());
    by.get(lt.Driver).set(n, lt);
  }
  return by;
}

/**
 * The laps of every stint usable for degradation, at sessionNow (see the
 * module comment for the rule).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds (raceTime.resolveSessionNow)
 * @param {string} [opts.driver] - only this driver
 * @returns {Array<{driver: string, stintNumber: number, compound: string, startLap: number,
 *   endLap: number, laps: Array<Object>, outliers: Array<Object>}>}
 *   one entry per stint with at least one completed lap, sorted by driver, then
 *   stintNumber; startLap / endLap / compound as deriveStints at sessionNow
 *   (endLap = last completed lap); laps = clean rows in lap order; outliers =
 *   rows removed by the slow-outlier step
 */
export function cleanStintLaps(lapTimes, { sessionNow = Infinity, driver } = {}) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return [];
  const rows = driver == null ? lapTimes : lapTimes.filter((lt) => lt?.Driver === driver);
  const done = completedLaps(rows, sessionNow);
  const byDriver = rowsByDriver(done);
  const out = [];
  for (const st of deriveStints(done)) {
    const laps = [...(byDriver.get(st.Driver) || new Map()).entries()]
      .filter(([n, lt]) => n >= st.StartLap && n <= st.EndLap && isCleanLap(lt))
      .sort((a, b) => a[0] - b[0])
      .map(([, lt]) => lt);
    const { kept, outliers } = splitOutliers(laps);
    out.push({
      driver: st.Driver,
      stintNumber: st.StintNumber,
      compound: st.Compound,
      startLap: st.StartLap,
      endLap: st.EndLap,
      laps: kept,
      outliers,
    });
  }
  return out;
}

/** The stints of cleanStintLaps restricted to the lap range, with their fit cores (internal). */
function stintCores(lapTimes, { sessionNow = Infinity, driver, lapStart, lapEnd } = {}) {
  const lo = bound(lapStart, -Infinity);
  const hi = bound(lapEnd, Infinity);
  const out = [];
  for (const st of cleanStintLaps(lapTimes, { sessionNow, driver })) {
    if (st.endLap < lo || st.startLap > hi) continue;
    const inRange = (lt) => {
      const n = toNum(lt.LapNumber);
      return n >= lo && n <= hi;
    };
    const laps = st.laps.filter(inRange);
    out.push({ stint: st, laps, outliers: st.outliers.filter(inRange).length, core: fitCore(laps) });
  }
  return out;
}

/**
 * One row per stint: its fitStint result on its clean laps (cleanStintLaps),
 * optionally only the laps in [lapStart, lapEnd].
 *
 * Stints with no lap in the range are left out. A stint with too few clean
 * laps keeps its row with slope, rawSlope, intercept, residualSigma and
 * slopeStdErr null (n = its clean laps in the range; tyreLifeMin / Max null
 * when it has none).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {string} [opts.driver] - only this driver
 * @param {number} [opts.lapStart] - first lap used (inclusive); omitted = no bound
 * @param {number} [opts.lapEnd] - last lap used (inclusive); omitted = no bound
 * @returns {Array<{driver: string, stintNumber: number, compound: string, startLap: number,
 *   endLap: number, slope: number|null, rawSlope: number|null, intercept: number|null, n: number,
 *   residualSigma: number|null, slopeStdErr: number|null, tyreLifeMin: number|null,
 *   tyreLifeMax: number|null}>} sorted by driver, then stintNumber
 */
export function stintFits(lapTimes, opts = {}) {
  return stintCores(lapTimes, opts).map(({ stint, laps, core }) => {
    let fit = core?.fit;
    if (!fit) {
      const tl = laps.map((lt) => toNum(lt.TyreLife));
      fit = {
        slope: null,
        rawSlope: null,
        intercept: null,
        n: laps.length,
        residualSigma: null,
        slopeStdErr: null,
        tyreLifeMin: tl.length ? Math.min(...tl) : null,
        tyreLifeMax: tl.length ? Math.max(...tl) : null,
      };
    }
    return {
      driver: stint.driver,
      stintNumber: stint.stintNumber,
      compound: stint.compound,
      startLap: stint.startLap,
      endLap: stint.endLap,
      ...fit,
    };
  });
}

/**
 * Degradation per compound over per-stint fits (stintFits rows; rows with a
 * null slope are skipped). Negative slopes are kept and counted, never clamped.
 *
 * @param {Array<{compound: string, slope: number|null}>} fits
 * @returns {Object<string, {mean: number, median: number, stdDev: number, n: number,
 *   negativeCount: number}>} per compound, s/lap; stdDev = sample standard
 *   deviation (0 with one fit); compounds in order of first appearance
 */
export function compoundDegradation(fits) {
  const groups = new Map();
  for (const f of Array.isArray(fits) ? fits : []) {
    const s = toNum(f?.slope);
    if (s == null) continue;
    const c = f.compound ?? 'UNKNOWN';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(s);
  }
  const out = {};
  for (const [c, slopes] of groups) {
    const n = slopes.length;
    let sum = 0;
    let negativeCount = 0;
    for (const s of slopes) {
      sum += s;
      if (s < 0) negativeCount += 1;
    }
    const mean = sum / n;
    let ss = 0;
    for (const s of slopes) ss += (s - mean) * (s - mean);
    out[c] = {
      mean,
      median: median(slopes),
      stdDev: n > 1 ? Math.sqrt(ss / (n - 1)) : 0,
      n,
      negativeCount,
    };
  }
  return out;
}

/**
 * A driver's lap-time consistency: the pooled residual sigma of the driver's
 * per-stint fits (stintFits), sqrt(sum of squared residuals / sum (n - 2))
 * over the fitted stints, seconds. Lap-to-lap scatter around each stint's
 * degradation line, so tyre wear and fuel burn do not count as inconsistency.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver
 * @param {Object} [opts] - { sessionNow, lapStart, lapEnd } as stintFits
 * @returns {{sigma: number|null, n: number, stints: number, outliers: number}}
 *   n = laps of the fitted stints, stints = fitted stints, outliers = slow
 *   outlier laps of the fitted stints left out (cleanStintLaps step 3); sigma
 *   null when no stint is fitted
 */
export function consistencySigma(lapTimes, driver, { sessionNow = Infinity, lapStart, lapEnd } = {}) {
  let sse = 0;
  let dof = 0;
  let n = 0;
  let stints = 0;
  let outliers = 0;
  for (const { core, outliers: k } of stintCores(lapTimes, { sessionNow, driver, lapStart, lapEnd })) {
    if (!core) continue;
    sse += core.sse;
    dof += core.fit.n - 2;
    n += core.fit.n;
    stints += 1;
    outliers += k;
  }
  return { sigma: dof > 0 ? Math.sqrt(sse / dof) : null, n, stints, outliers };
}
