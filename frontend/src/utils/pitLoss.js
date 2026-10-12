/**
 * Pit-stop time loss measured from the race itself, causally.
 *
 * FastF1 splits one stop over two lap rows: PitInTime on the in-lap n and
 * PitOutTime on the out-lap n + 1. Both laps are slower than a normal lap, so
 *     loss = lapTime(n) + lapTime(n + 1) - 2 * driver green median
 * Using the in-lap alone misses most of the loss (Monza 2024: in-lap share of
 * the loss 0.20, see backend/scripts/validate_pit_loss_and_rejoin.py output).
 *
 * The definitions mirror green_medians() and green_stops() of
 * backend/scripts/validate_pit_loss_and_rejoin.py, so at sessionNow = Infinity
 * the race median equals that script's per-race `true_loss` (checked for every
 * cached race in src/utils/__tests__/pitLoss.test.js). Differences: only laps
 * completed at sessionNow are used (causal rule, raceTime.js), and the script's
 * extra requirement of a `Time` on laps n - 1 and n + 1 (needed by its rejoin
 * backtest, not by the loss) is not repeated; every cached row has a Time.
 *
 * Race sessions only: pit loss is a race quantity. In qualifying and practice
 * the in-lap / out-lap pairs are garage runs, so with { sessionType } outside
 * 'R' / 'S' the estimator returns source 'not-applicable' with no numbers.
 *
 * All times are seconds; sessionNow is in SESSION seconds (raceTime.js).
 * Pure module: no React, no D3, no store access.
 */
import { completedLaps, isLapCompleted, isGreenLap, hasPitIn, hasPitOut } from './raceTime';

/**
 * Fallback used only when the race has no qualifying stop yet (n = 0): an
 * assumption, not data. 22 s is the fallback already used by raceSimulation.js
 * and by the validation script (FALLBACK = 22.0); the 2.5 s spread is the
 * prescribed fallback uncertainty. Results built from it carry
 * source: 'fallback' and the UI must say so.
 */
export const FALLBACK_PIT_LOSS = Object.freeze({ median: 22, stdDev: 2.5 });

// z(0.90) of the standard normal (1.28155 rounded): p10/p90 of the fallback
const Z_90 = 1.2816;

// Sample filters, same values as validate_pit_loss_and_rejoin.py
const MAX_GREEN_LAP_S = 200;   // drop laps slower than this from the green median
const MIN_GREEN_LAPS = 5;      // a driver needs MORE than this many green laps
const MIN_LOSS_S = 10;         // keep 10 < loss < 60
const MAX_LOSS_S = 60;

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Empirical percentile with linear interpolation (numpy's default). */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Map driver -> Map lapNumber -> row; the last row wins, as in the script. */
function indexByDriverLap(laps) {
  const by = new Map();
  for (const lt of laps) {
    if (!lt?.Driver) continue;
    const n = Number(lt.LapNumber);
    if (!Number.isFinite(n)) continue;
    if (!by.has(lt.Driver)) by.set(lt.Driver, new Map());
    by.get(lt.Driver).set(n, lt);
  }
  return by;
}

function validLapTime(t) {
  return typeof t === 'number' && Number.isFinite(t) && t > 0;
}

function greenMediansOf(byDriver) {
  const out = {};
  for (const [drv, laps] of byDriver) {
    const c = [];
    for (const [n, r] of laps) {
      const t = r.LapTimeSeconds;
      if (n > 1 && validLapTime(t) && t < MAX_GREEN_LAP_S
          && !hasPitIn(r) && !hasPitOut(r) && isGreenLap(r)) {
        c.push(t);
      }
    }
    if (c.length > MIN_GREEN_LAPS) out[drv] = median(c);
  }
  return out;
}

/**
 * Each driver's reference pace: median LapTimeSeconds over the laps completed
 * at sessionNow with LapNumber > 1, LapTimeSeconds < 200, no pit-in, no
 * pit-out and green TrackStatus ('1'). Only drivers with more than 5 such laps.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @returns {Object<string, number>} { driver: median lap time in seconds }
 */
export function driverGreenMedians(lapTimes, { sessionNow = Infinity } = {}) {
  return greenMediansOf(indexByDriverLap(completedLaps(lapTimes, sessionNow)));
}

// Session types with a race pit loss: race and sprint
const RACE_SESSION_TYPES = new Set(['R', 'S']);

/**
 * True for a race-type session ('R' race, 'S' sprint), where pit loss and its
 * labels apply. A missing sessionType counts as a race (callers that predate
 * the option are race views).
 *
 * @param {string} [sessionType]
 * @returns {boolean}
 */
export function isRaceSession(sessionType) {
  if (sessionType == null || sessionType === '') return true;
  return RACE_SESSION_TYPES.has(String(sessionType).trim().toUpperCase());
}

/** The estimate outside race sessions: no numbers, source 'not-applicable'. */
function notApplicableEstimate() {
  return {
    median: null,
    mean: null,
    stdDev: null,
    p10: null,
    p90: null,
    n: 0,
    source: 'not-applicable',
    samples: [],
  };
}

/** The fallback estimate object (n = 0, source 'fallback'). */
function fallbackEstimate() {
  const { median: m, stdDev } = FALLBACK_PIT_LOSS;
  return {
    median: m,
    mean: m,
    stdDev,
    p10: m - Z_90 * stdDev,
    p90: m + Z_90 * stdDev,
    n: 0,
    source: 'fallback',
    samples: [],
  };
}

/**
 * Race pit-loss estimator. One sample per stop with in-lap n (pit-in) and
 * out-lap n + 1 (pit-out) both completed at sessionNow, laps n - 1, n, n + 1
 * all green, and the driver's green median defined (driverGreenMedians):
 *     loss = lapTime(n) + lapTime(n + 1) - 2 * greenMedian, kept if 10 < loss < 60.
 * `median` is THE point estimate (robust to wet-tyre races). p10 / p90 are
 * empirical percentiles (linear interpolation); stdDev is the sample standard
 * deviation (0 with one sample). With no sample: FALLBACK_PIT_LOSS, n = 0,
 * source 'fallback'. Outside race sessions (sessionType not 'R' / 'S'): every
 * number null, n = 0, source 'not-applicable'.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {string} [opts.sessionType] - 'R', 'S', 'Q', 'FP1', ...; omitted = race
 * @returns {{median: number|null, mean: number|null, stdDev: number|null, p10: number|null,
 *   p90: number|null, n: number, source: 'race'|'fallback'|'not-applicable',
 *   samples: Array<{driver: string, inLap: number, loss: number}>}}
 *   seconds; samples sorted by inLap, then driver
 */
export function estimatePitLoss(lapTimes, { sessionNow = Infinity, sessionType } = {}) {
  if (!isRaceSession(sessionType)) return notApplicableEstimate();
  const byDriver = indexByDriverLap(completedLaps(lapTimes, sessionNow));
  const med = greenMediansOf(byDriver);
  const samples = [];
  for (const [drv, laps] of byDriver) {
    if (!(drv in med)) continue;
    for (const [n, r] of laps) {
      if (!hasPitIn(r)) continue;
      const o = laps.get(n + 1);
      const p = laps.get(n - 1);
      if (!o || !p || !hasPitOut(o)) continue;
      if (!validLapTime(r.LapTimeSeconds) || !validLapTime(o.LapTimeSeconds)) continue;
      if (!isGreenLap(p) || !isGreenLap(r) || !isGreenLap(o)) continue;
      const loss = r.LapTimeSeconds + o.LapTimeSeconds - 2 * med[drv];
      if (loss > MIN_LOSS_S && loss < MAX_LOSS_S) samples.push({ driver: drv, inLap: n, loss });
    }
  }
  if (!samples.length) return fallbackEstimate();

  samples.sort((a, b) => a.inLap - b.inLap || (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0));
  const losses = samples.map((s) => s.loss);
  const sorted = [...losses].sort((x, y) => x - y);
  const n = losses.length;
  const mean = losses.reduce((a, b) => a + b, 0) / n;
  const stdDev = n > 1
    ? Math.sqrt(losses.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
    : 0;
  return {
    median: median(losses),
    mean,
    stdDev,
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    n,
    source: 'race',
    samples,
  };
}

/**
 * Can this stop still become a sample of the estimator, judging only from what
 * is known at `now`? True while one of the laps n - 1, n (in-lap), n + 1
 * (out-lap) is still running and the completed ones are green with a valid lap
 * time; also when all three are completed and green but the driver has no
 * green median yet (too few green laps) and still has laps to run. The
 * out-lap's own TrackStatus and time are not known before it ends, so a stop
 * pending now may end up not measurable (e.g. SC on the out-lap).
 */
function stopIsPending(lapTimes, driver, n, now) {
  if (now === Infinity) return false;
  const byLap = new Map();
  let finalRow = null;
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (lt?.Driver !== driver) continue;
    const k = Number(lt.LapNumber);
    if (!Number.isFinite(k)) continue;
    byLap.set(k, lt);
    if (!finalRow || k >= Number(finalRow.LapNumber)) finalRow = lt;
  }
  const p = byLap.get(n - 1);
  const r = byLap.get(n);
  const o = byLap.get(n + 1);
  if (!p || !r || !o || !hasPitIn(r) || !hasPitOut(o)) return false;
  let running = false;
  for (const [row, needsTime] of [[p, false], [r, true], [o, true]]) {
    if (!isLapCompleted(row, now)) { running = true; continue; }
    if (!isGreenLap(row) || (needsTime && !validLapTime(row.LapTimeSeconds))) return false;
  }
  if (running) return true;
  // All three laps green and completed but not a sample: either the loss is
  // outside (10, 60) s with the driver's median known, or the median is not
  // defined yet (the driver can still add green laps)
  if (driverGreenMedians(lapTimes, { sessionNow: now })[driver] != null) return false;
  return !isLapCompleted(finalRow, now);
}

/**
 * Loss of one stop at sessionNow, with where it comes from:
 *  - 'measured': the stop is one of the estimator's samples (its own loss);
 *  - 'pending': a green stop not measurable yet (its out-lap is still running,
 *    or the driver has no green median yet); loss null, the UI shows a marker
 *    without a number ("measuring...");
 *  - 'estimate': a stop that cannot be measured (a lap around it is not green,
 *    no out-lap, loss outside the kept range): the race median at sessionNow;
 *  - 'fallback': same, but the race has no measured stop yet (n = 0): the
 *    FALLBACK_PIT_LOSS median, an assumption;
 *  - 'not-applicable': not a race session (sessionType not 'R' / 'S'); loss null.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver
 * @param {number} inLap - lap carrying the pit-in
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {string} [opts.sessionType] - 'R', 'S', 'Q', ...; omitted = race
 * @param {Object} [opts.estimate] - estimatePitLoss result at the same sessionNow (avoids recomputing)
 * @returns {{loss: number|null, source: 'measured'|'pending'|'estimate'|'fallback'|'not-applicable',
 *   estimateSource: 'race'|'fallback'|'not-applicable'}}
 *   loss in seconds; estimateSource = the race estimate's source at sessionNow
 */
export function perStopLoss(lapTimes, driver, inLap, opts = {}) {
  if (!isRaceSession(opts.sessionType)) {
    return { loss: null, source: 'not-applicable', estimateSource: 'not-applicable' };
  }
  const now = opts.sessionNow == null || Number.isNaN(opts.sessionNow) ? Infinity : opts.sessionNow;
  const est = opts.estimate || estimatePitLoss(lapTimes, { sessionNow: now });
  if (est.source === 'not-applicable') {
    return { loss: null, source: 'not-applicable', estimateSource: 'not-applicable' };
  }
  const lap = Number(inLap);
  const hit = est.samples.find((s) => s.driver === driver && s.inLap === lap);
  if (hit) return { loss: hit.loss, source: 'measured', estimateSource: est.source };
  if (stopIsPending(lapTimes, driver, lap, now)) {
    return { loss: null, source: 'pending', estimateSource: est.source };
  }
  if (est.source === 'fallback') return { loss: est.median, source: 'fallback', estimateSource: 'fallback' };
  return { loss: est.median, source: 'estimate', estimateSource: est.source };
}
