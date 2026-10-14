/**
 * View models of the tyre-degradation and consistency views
 * (components/visualizations/TireDegradation.jsx, ConsistencyPanel.jsx,
 * DriverComparePanel.jsx), all on the shared degradation definition of
 * utils/degradation.js: clean stint laps (lap 1, in-laps, out-laps and
 * non-green laps left out, slow outliers removed), per-stint fits on TyreLife
 * with the fuel correction, compound degradation and the consistency sigma.
 * Nothing here fits a line or computes a sigma on its own.
 *
 * Every function is causal at sessionNow (session seconds, raceTime.js):
 * only laps completed by then are used.
 *
 * Kept out of the component modules on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  cleanStintLaps, stintFits, compoundDegradation, consistencySigma,
  FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS,
} from '../degradation';
import { driverCompletedLaps } from '../strategyViews';

/**
 * Fewest completed laps of the driver inside a brushed lap range for the
 * degradation chart to draw that range only; with fewer (the replay has not
 * reached the range yet) the whole race is drawn and the brush banner still
 * reports the range. The threshold the chart already used: a display rule,
 * not a model parameter.
 */
export const BRUSH_MIN_LAPS = 3;

/**
 * LOW DATA cut of the consistency cards: a driver whose sigma rests on fewer
 * laps than this fraction of the largest sample in the field is flagged.
 * ASSUMPTION kept from the previous rule (H1/V1.4: a driver who retires early
 * gets an artificially narrow sigma from a small sample, HUL at Sao Paulo
 * 2024). The reference is the field's largest sample, not the leader's lap
 * count, because clean laps leave out lap 1, the pit laps and every non-green
 * lap for every driver alike.
 */
export const LOW_DATA_FRACTION = 0.75;

/** The fuel-correction note shown with every fuel-corrected slope. */
export const FUEL_NOTE = `fuel-corr. = raw + ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap`
  + ' (assumed fuel effect, not measured)';

/** The clean-lap rule in one line, as the views state it. */
export const FIT_NOTE = `fit on stints with ≥ ${MIN_FIT_LAPS} clean laps; `
  + 'lap 1, pit in/out laps and non-green laps left out';

function finite(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Signed slope text, e.g. '+0.050' / '-0.128' (s/lap); '—' when null.
 *
 * @param {number|null} v
 * @param {number} [digits=3]
 * @returns {string}
 */
export function formatSlope(v, digits = 3) {
  const n = finite(v);
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

/**
 * The lap time a stint fit predicts for one lap, in raw (not fuel-corrected)
 * seconds: fit.intercept + fit.slope x TyreLife - FUEL_EFFECT_S_PER_LAP x
 * (LapNumber - 1), i.e. the fitted fuel-corrected time with the fuel
 * correction of degradation.js fuelCorrectedTime taken back out. Inside a
 * stint LapNumber - TyreLife is constant (docs/DEGRADATION_METHODOLOGY.md),
 * so these points lie on a line of slope fit.rawSlope over TyreLife.
 *
 * @param {{intercept: number, slope: number}} fit - a fitStint / stintFits row with a slope
 * @param {{LapNumber: number, TyreLife: number}} lap - lap_times row (or { lapNumber, tyreLife })
 * @returns {number|null}
 */
export function fitLapTime(fit, lap) {
  const slope = finite(fit?.slope);
  const intercept = finite(fit?.intercept);
  const tl = finite(lap?.TyreLife ?? lap?.tyreLife);
  const n = finite(lap?.LapNumber ?? lap?.lapNumber);
  if (slope == null || intercept == null || tl == null || n == null) return null;
  return intercept + slope * tl - FUEL_EFFECT_S_PER_LAP * (n - 1);
}

/**
 * Tyre-degradation chart of one driver at sessionNow: per stint (deriveStints
 * via cleanStintLaps, so a same-compound stop opens a new stint) its completed
 * laps, which of them are clean, and its stintFits row.
 *
 * Brush: with a lapRange [lo, hi] (either end null = open) the chart shows and
 * fits only the laps in the range (stintFits lapStart / lapEnd), unless the
 * driver has fewer than BRUSH_MIN_LAPS completed laps in it (rangeApplied
 * false: whole race).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {Array<number|null>|null} [opts.lapRange] - brushed [lo, hi] lap range
 * @returns {{stints: Array<{stintNumber: number, stintIndex: number, compound: string,
 *   startLap: number, endLap: number, laps: Array<Object>, cleanLaps: Array<Object>,
 *   excludedLaps: Array<Object>, cleanCount: number, fit: Object|null,
 *   line: {tyreMin: number, tyreMax: number, y1: number, y2: number}|null}>,
 *   yExtent: number[], rangeApplied: boolean}}
 *   laps: { lapNumber, lapTime, tyreLife, compound, clean, slowOutlier } of the
 *   completed laps (0 < time < 300 s) of the stint in the range; cleanLaps = the
 *   clean ones (the fit's laps, cleanCount of them); excludedLaps = the others
 *   with a TyreLife; fit = the stintFits row when it has a slope, else null;
 *   line = the fit drawn in raw lap time (fitLapTime at the clean laps with the
 *   lowest and highest TyreLife); yExtent = [min, max] clean lap time
 */
export function tyreDegradationView(lapTimes, driver, { sessionNow = Infinity, lapRange = null } = {}) {
  const empty = { stints: [], yExtent: [80, 100], rangeApplied: false };
  if (!driver || !Array.isArray(lapTimes) || lapTimes.length === 0) return empty;
  const done = driverCompletedLaps(lapTimes, driver, sessionNow);
  if (done.length === 0) return empty;

  const [lo, hi] = Array.isArray(lapRange) ? lapRange : [null, null];
  const inRange = (n) => (lo == null || n >= lo) && (hi == null || n <= hi);
  const rangeApplied = Array.isArray(lapRange)
    && done.filter((lt) => inRange(lt.LapNumber)).length >= BRUSH_MIN_LAPS;
  const use = rangeApplied ? inRange : () => true;
  const bounds = rangeApplied ? { lapStart: lo, lapEnd: hi } : {};

  // Rows of stintFits: stints with no lap in the range are left out there
  const fits = new Map(
    stintFits(lapTimes, { sessionNow, driver, ...bounds }).map((f) => [f.stintNumber, f]),
  );
  const stints = [];
  const allClean = [];
  for (const st of cleanStintLaps(lapTimes, { sessionNow, driver })) {
    const fitRow = fits.get(st.stintNumber);
    if (!fitRow) continue;
    const clean = new Set(st.laps.map((lt) => Number(lt.LapNumber)));
    const slow = new Set(st.outliers.map((lt) => Number(lt.LapNumber)));
    const laps = done
      .filter((lt) => lt.LapNumber >= st.startLap && lt.LapNumber <= st.endLap && use(lt.LapNumber))
      .map((lt) => ({
        lapNumber: lt.LapNumber,
        lapTime: lt.LapTimeSeconds,
        tyreLife: finite(lt.TyreLife),
        compound: st.compound,
        clean: clean.has(Number(lt.LapNumber)),
        slowOutlier: slow.has(Number(lt.LapNumber)),
      }));
    if (laps.length === 0) continue;
    const cleanLaps = laps.filter((l) => l.clean);
    cleanLaps.forEach((l) => allClean.push(l.lapTime));
    const fit = finite(fitRow.slope) != null ? fitRow : null;
    let line = null;
    if (fit && cleanLaps.length) {
      let first = cleanLaps[0];
      let last = cleanLaps[0];
      for (const l of cleanLaps) {
        if (l.tyreLife < first.tyreLife) first = l;
        if (l.tyreLife > last.tyreLife) last = l;
      }
      line = {
        tyreMin: first.tyreLife,
        tyreMax: last.tyreLife,
        y1: fitLapTime(fit, first),
        y2: fitLapTime(fit, last),
      };
    }
    stints.push({
      stintNumber: st.stintNumber,
      stintIndex: st.stintNumber - 1,
      compound: st.compound,
      startLap: st.startLap,
      endLap: st.endLap,
      laps,
      cleanLaps,
      excludedLaps: laps.filter((l) => !l.clean && l.tyreLife != null),
      cleanCount: fitRow.n,
      fit,
      line,
    });
  }
  const yExtent = allClean.length > 0
    ? [Math.min(...allClean), Math.max(...allClean)]
    : [80, 100];
  return { stints, yExtent, rangeApplied };
}

/**
 * Consistency cards (ConsistencyPanel) at sessionNow, same fields as before:
 * per driver with a consistency sigma (at least one stint fitted)
 *  std_dev       consistencySigma: pooled residual sigma of the per-stint
 *                fits, seconds (tyre wear, fuel burn and stops do not count)
 *  sample_size / lap_count  its n (laps of the fitted stints)
 *  outliers      slow outliers left out of the fitted stints
 *  avg_lap, fastest, slowest, range  over the driver's clean laps (every stint)
 *  cv_percent    std_dev / avg_lap x 100
 *  compounds     per compound: avg (clean laps), count, avg_tyre_life,
 *                deg_slope = compoundDegradation mean of the driver's fitted
 *                stints on it (fuel-corrected s/lap, null when none) and
 *                deg_fits = their number
 *  is_consistent std_dev <= the field's median std_dev (upper median)
 *  insufficient_data  sample_size < minLapsThreshold
 * sorted by avg_lap. minLapsThreshold = floor(LOW_DATA_FRACTION x the largest
 * sample_size); sessionAvg = mean of the listed drivers' clean laps.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {{drivers: Array<Object>, sessionAvg: number|null, minLapsThreshold: number}}
 */
export function consistencyView(lapTimes, sessionNow = Infinity) {
  const none = { drivers: [], sessionAvg: null, minLapsThreshold: 0 };
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return none;
  const stints = cleanStintLaps(lapTimes, { sessionNow });
  const fits = stintFits(lapTimes, { sessionNow });
  const drivers = [...new Set(stints.map((s) => s.driver))];

  const results = [];
  const allClean = [];
  for (const drv of drivers) {
    const c = consistencySigma(lapTimes, drv, { sessionNow });
    if (c.sigma == null) continue;
    const laps = [];
    for (const st of stints) {
      if (st.driver !== drv) continue;
      for (const lt of st.laps) {
        laps.push({ time: Number(lt.LapTimeSeconds), compound: st.compound, tyreLife: Number(lt.TyreLife) });
      }
    }
    const times = laps.map((l) => l.time);
    let sum = 0;
    for (const t of times) sum += t;
    const avg = sum / times.length;
    const fastest = Math.min(...times);
    const slowest = Math.max(...times);
    allClean.push(...times);

    const deg = compoundDegradation(fits.filter((f) => f.driver === drv));
    const byCompound = new Map();
    for (const l of laps) {
      if (!byCompound.has(l.compound)) byCompound.set(l.compound, []);
      byCompound.get(l.compound).push(l);
    }
    const compounds = {};
    for (const [compound, cl] of byCompound) {
      let t = 0;
      let age = 0;
      for (const l of cl) { t += l.time; age += l.tyreLife; }
      compounds[compound] = {
        avg: t / cl.length,
        count: cl.length,
        avg_tyre_life: Math.round((age / cl.length) * 10) / 10,
        deg_slope: deg[compound] ? deg[compound].mean : null,
        deg_fits: deg[compound] ? deg[compound].n : 0,
      };
    }

    results.push({
      driver: drv,
      team: '',
      number: '',
      avg_lap: avg,
      fastest,
      slowest,
      range: slowest - fastest,
      std_dev: c.sigma,
      cv_percent: avg > 0 ? (c.sigma / avg) * 100 : 0,
      sample_size: c.n,
      lap_count: c.n,
      fitted_stints: c.stints,
      outliers: c.outliers,
      compounds,
    });
  }

  let largest = 0;
  for (const r of results) largest = Math.max(largest, r.sample_size);
  const minLapsThreshold = Math.floor(largest * LOW_DATA_FRACTION);
  const sigmas = results.map((r) => r.std_dev).sort((a, b) => a - b);
  const medianSigma = sigmas.length ? sigmas[Math.floor(sigmas.length / 2)] : null;
  for (const r of results) {
    r.insufficient_data = r.sample_size < minLapsThreshold;
    r.is_consistent = r.std_dev <= medianSigma;
  }
  results.sort((a, b) => a.avg_lap - b.avg_lap);

  let total = 0;
  for (const t of allClean) total += t;
  return {
    drivers: results,
    sessionAvg: allClean.length ? total / allClean.length : null,
    minLapsThreshold,
  };
}
