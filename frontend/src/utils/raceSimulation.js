/**
 * Monte Carlo race simulation.
 *
 * Forward-projects finish positions from distributions measured on the race
 * itself, causally: every estimate uses only what is known at `sessionNow`
 * (session seconds, utils/raceTime.js). Where the race has no data yet the
 * estimate is a labelled prior (source 'prior') measured over the cached
 * races by scripts/mc_benchmark.mjs (computePriors; output in
 * notes/experiments/mc_benchmark.txt), never an unlabelled constant.
 *
 * Estimates (extractRaceParams, each with its sample size and source):
 *  - pit loss: utils/pitLoss.js estimatePitLoss (median = point estimate);
 *  - tyre degradation per compound: utils/degradation.js (per-stint fit of the
 *    fuel-corrected lap time on TyreLife, lap 1 / in-laps / out-laps / non-green
 *    laps excluded); negative fits are kept and counted, never clamped;
 *  - lap noise: the pooled residual sigma of those per-stint fits;
 *  - fresh-tyre delta: how much faster the first flying lap on a new set is
 *    than that stint's own tyre-age line (paired within driver + stint,
 *    fuel-corrected), constrained <= 0;
 *  - stint life per compound: Kaplan-Meier survival of the tyre age at which
 *    sets are changed; ongoing stints and stints that ran to the flag are
 *    right-censored, a non-finisher's final stint is dropped; past the last
 *    observation the prior's conditional tail;
 *  - safety car: episodes (a run of SC / VSC / red periods) that started by
 *    sessionNow, per leader lap, shrunk toward the prior (one race's weight).
 *
 * Lap model (projectedLapTime, the same formula in every simulation):
 *   lap time = basePace + deg x tyreAge - refDeg x refAge
 *              [+ freshDelta on the first flying lap of a new set]
 *              [+ trend x laps, current stint only, off by default]
 *              + noise
 * basePace = mean of the driver's last PACE_REF_LAPS clean laps, each moved
 * to the fuel load of the current lap; refAge = their mean TyreLife. So with
 * deg = 0 and trend = 0 the projected pace is flat, and the current wear is
 * counted once (it is in basePace) whatever the tyre age. Fuel burn after now
 * is left out: it is the same for every car (FUEL_EFFECT_S_PER_LAP per lap)
 * and does not change the order.
 *
 * Stops: a set is due at a tyre age drawn from its compound's stint-life
 * survival, conditional on the age it has reached. A dry race forces one stop
 * on a driver who has not yet used two dry compounds (then drawn before the
 * last lap): the sporting rule for a dry race, checked on the data
 * (scripts/mc_benchmark.mjs: in the 26 cached dry races 461 of 466 finishers
 * used two dry compounds, the 5 others have rows without a compound or one
 * compound recorded twice); it is applied only when the driver's stints are
 * known and no INTERMEDIATE / WET lap has been completed. Any other (optional) stop is taken only when at least
 * OPTIONAL_STOP_MIN_LAPS_LEFT laps would be left after it; otherwise the set
 * runs to the flag. This caps the stops by the laps remaining. A plan
 * ({ [driver]: [{ lap, compound }] }) replaces the model for that driver: it
 * stops exactly at the planned in-laps, each charged a sampled pit loss.
 *
 * Random numbers: utils/prng.js, counter-based. Every draw is indexed by
 * (seed, sim, driver, lap or stint ordinal, stream), so the same seed gives
 * the same result and a what-if plan shares every draw with the baseline
 * (common random numbers, compareStrategies).
 *
 * Pure module: no React, no D3, no store access; usable from a Web Worker
 * (inputs and outputs are plain data; pass `running` as a boolean, a list of
 * driver codes or a { driver: boolean } map there, not a function).
 */
import {
  completedLaps, resolveSessionNow, mapTrackStatusToLaps,
} from './raceTime';
import { deriveStints, stintsByDriver, pitStops } from './stints';
import { estimatePitLoss } from './pitLoss';
import {
  cleanStintLaps, stintFits, compoundDegradation, fitStint, fuelCorrectedTime, isCleanLap,
  FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS,
} from './degradation';
import { nonFinisherMap } from './driverState';
import { STREAMS, uniformAt, normalAt, seedFrom } from './prng';

// ─── Constants ───

// Pit-loss sampling guards (seconds). Not data: the sampler draws around
// pitLoss.median with pitLoss.stdDev, floored at PIT_LOSS_SAMPLING_MIN_SD so a
// race with one sample (stdDev 0) still varies between runs, and every draw is
// kept above PIT_LOSS_NUMERIC_FLOOR only to stop a far-tail normal draw from
// going negative. Neither value shifts the estimate itself.
const PIT_LOSS_SAMPLING_MIN_SD = 0.5;
const PIT_LOSS_NUMERIC_FLOOR = 5;

/**
 * Simulations per projection. scripts/mc_benchmark.mjs measures runtime and
 * how often a podium (>= 50 %) or battle (>= 30 % / >= 60 %) badge flips
 * between two recomputes with different seeds at 100, 1,000 and 10,000 runs
 * (notes/experiments/mc_benchmark.txt, section 5).
 */
export const DEFAULT_NUM_SIMULATIONS = 1000;

/**
 * Fresh-tyre laps: the delta applies to tyre ages 2..FRESH_TYRE_LAPS of a new
 * set, i.e. the first flying lap (age 1 is the out-lap, whose time is part of
 * the measured pit loss). ASSUMPTION read off the cached races
 * (scripts/mc_benchmark.mjs, "fresh-tyre residual by tyre age"): against the
 * stint's own tyre-age line the age-2 lap is faster, while ages 3-5 are
 * slower than the line, so only age 2 carries a gain.
 */
export const FRESH_TYRE_LAPS = 2;

/** Laps <= this are never fresh-tyre samples: standing start and full fuel (S1). */
export const FRESH_EXCLUDED_LAPS = 2;

/**
 * Laps in the base pace: the same count as raceSituationFeatures recentPace
 * (mean of the last 3 valid laps), here clean laps only (degradation.js
 * isCleanLap: green, no pit, not lap 1).
 */
export const PACE_REF_LAPS = 3;

/**
 * Length of a survival table (tyre ages 0..STINT_LIFE_MAX laps). Not a model
 * value: longer than any race (the longest cached race has 78 laps,
 * scripts/mc_benchmark.mjs).
 */
export const STINT_LIFE_MAX = 100;

/**
 * Weight of the safety-car prior, in races. ASSUMPTION: the prior counts as
 * one average cached race (its episodes and laps) added to the laps seen so
 * far, so one early episode does not become a rate of one per few laps, and a
 * race without episodes drifts below the prior as green laps accumulate.
 */
export const SC_PRIOR_WEIGHT_RACES = 1;

/**
 * Laps of a safety car after which the gaps of the latest completed lap
 * already show the bunching. ASSUMPTION read off the cached races
 * (scripts/mc_benchmark.mjs, "SC gap ratio lap by lap"): on the first two
 * laps of an SC the gaps to the leader are still as wide as before (ratios
 * near or above 1), from the third lap on most episodes are bunched. A
 * projection made during an SC compresses the gaps (scGapRatio) only before
 * that.
 */
export const SC_BUNCHED_AFTER_LAPS = 3;

/** Track-status codes of a neutralised track: SC, VSC deployed, VSC ending, red flag. */
const NEUTRAL_STATUSES = new Set(['4', '5', '6', '7']);
/** An episode counts when it has one of these (a red flag alone is not an SC / VSC episode). */
const EPISODE_STATUSES = new Set(['4', '6', '7']);

const DRY_COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD'];
const DRY = new Set(DRY_COMPOUNDS);
const WET = new Set(['INTERMEDIATE', 'WET']);

// Measurement filters of the SC gap-ratio prior (computePriors), not model
// values: gaps under 2 s give a ratio dominated by timing noise, gaps over
// 60 s are lapped or delayed cars, and a car that pitted around the episode
// carries its pit loss in the gap.
const GAP_RATIO_MIN_GAP_S = 2;
const GAP_RATIO_MAX_GAP_S = 60;

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/**
 * Priors measured over every cached race (sessionNow = Infinity) by
 * computePriors, printed by scripts/mc_benchmark.mjs (section "Priors",
 * notes/experiments/mc_benchmark.txt) and copied here rounded;
 * src/utils/__tests__/raceSimulation.priors.test.js recomputes them from the
 * cache and checks these values. They include the race being projected when
 * that race is in the cache. Used only where the race itself has no data yet,
 * always with source 'prior'.
 */
export const PRIORS = deepFreeze({
  races: 30,
  // s per lap of tyre age, fuel-corrected (degradation.js); mean / median /
  // stdDev over the stints pooled; raceMean / withinSd / betweenSd / races /
  // minFitLaps: the spread within and between races and the shortest fit the
  // race's estimate uses (computePriors degradationHierarchy, raceDegradation)
  degradation: {
    SOFT: {
      mean: 0.0565, median: 0.0788, stdDev: 0.2525, n: 107, negativeCount: 14,
      raceMean: 0.0138, withinSd: 0.2402, betweenSd: 0.1244, races: 12, minFitLaps: 8,
    },
    HARD: {
      mean: 0.0284, median: 0.0306, stdDev: 0.0653, n: 542, negativeCount: 150,
      raceMean: 0.0174, withinSd: 0.0531, betweenSd: 0.061, races: 28, minFitLaps: 15,
    },
    MEDIUM: {
      mean: 0.0384, median: 0.0474, stdDev: 0.1031, n: 470, negativeCount: 116,
      raceMean: 0.0282, withinSd: 0.0757, betweenSd: 0.0798, races: 27, minFitLaps: 13,
    },
    INTERMEDIATE: {
      mean: -0.2216, median: -0.169, stdDev: 0.2313, n: 102, negativeCount: 94,
      raceMean: -0.184, withinSd: 0.1161, betweenSd: 0.2178, races: 4, minFitLaps: 18,
    },
    WET: {
      mean: -0.3272, median: -0.3272, stdDev: 0, n: 1, negativeCount: 1,
      raceMean: null, withinSd: null, betweenSd: null, races: 0, minFitLaps: 8,
    },
    ALL: {
      mean: 0.0136, median: 0.0338, stdDev: 0.1454, n: 1222, negativeCount: 375,
      raceMean: 0.007, withinSd: 0.1041, betweenSd: 0.0976, races: 30, minFitLaps: 12,
    },
  },
  // s: pooled over every stint (value); dry / wet: the cached races' lap noise
  // of that kind (lapNoisePrior); lapNoiseFromFits uses dry / wet.value only
  // before a race's first fit (D1: no prior mixed into a race's own value);
  // nu0 is kept as a measurement of the spread between races
  lapNoise: {
    value: 0.636,
    stints: 1222,
    dry: { value: 0.408, nu0: 5.32, races: 26 },
    wet: { value: 1.031, nu0: 8.24, races: 4 },
  },
  freshDelta: { value: -0.14, stints: 501 }, // s
  // tyre age at a tyre change (laps): Kaplan-Meier median and spread
  stintLife: {
    ALL: { median: 25, sigma: 17.05, n: 1482, events: 954 },
    SOFT: { median: 17, sigma: 9.64, n: 176, events: 101 },
    HARD: { median: 34, sigma: 22.98, n: 581, events: 281 },
    MEDIUM: { median: 21, sigma: 13.34, n: 576, events: 452 },
    INTERMEDIATE: { median: 25, sigma: 16.31, n: 138, events: 109 },
    WET: { median: 10, sigma: 5.93, n: 7, events: 7 },
  },
  safetyCar: {
    episodesPerRace: 1,
    scEpisodesPerRace: 0.6,
    lapsPerRace: 60.6,
    durationLaps: { SC: 5, VSC: 2 },
    scGapRatio: 0.284,
    gapRatioEpisodes: 10,
  },
  transitions: {
    SOFT: { HARD: 50, MEDIUM: 43, SOFT: 7, INTERMEDIATE: 1 },
    HARD: { HARD: 108, SOFT: 38, MEDIUM: 125, INTERMEDIATE: 10 },
    MEDIUM: { HARD: 342, SOFT: 39, MEDIUM: 46, INTERMEDIATE: 25 },
    INTERMEDIATE: { INTERMEDIATE: 50, MEDIUM: 29, HARD: 15, SOFT: 10, WET: 5 },
    WET: { INTERMEDIATE: 7 },
    UNKNOWN: { HARD: 4 },
  },
  // laps left to the flag after an optional stop
  optionalStops: { n: 258, lapsLeftQ10: 12, lapsLeftQ25: 18, lapsLeftMedian: 23 },
});

/**
 * Fewest laps an optional stop (one the two-compound rule does not force)
 * may leave to the flag; a set due later runs to the flag. ASSUMPTION read
 * off the data: the lower quartile of the laps left after the optional stops
 * of the cached races (PRIORS.optionalStops, computePriors;
 * scripts/mc_benchmark.mjs prints the distribution). Chosen over the lower
 * decile on the in-sample backtest (mc_benchmark section 4): lower remaining-
 * stops error at 75 % distance, while the decile has the smaller bias early;
 * the decile also lets a one-stopper due a few laps later stop again late in
 * the race. A payback rule (stopRule 'payback': stop only when the old set
 * would lose more than the pit loss against a new one over the laps left)
 * under-predicts stops more (same table).
 */
export const OPTIONAL_STOP_MIN_LAPS_LEFT = PRIORS.optionalStops.lapsLeftQ25;

// ─── Small helpers ───

/** Finite number from a number or numeric string, otherwise null (as raceTime.js). */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function normaliseNow(sessionNow) {
  return sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
}

function compoundKey(c) {
  const s = c == null ? '' : String(c).trim().toUpperCase();
  return s || 'UNKNOWN';
}

/**
 * The deriveStints `running` option from a worker-safe value: a boolean, a
 * per-driver function, a list of driver codes still running, or a
 * { driver: boolean } map.
 */
function runningOption(running) {
  if (typeof running === 'function' || typeof running === 'boolean') return running;
  if (Array.isArray(running)) {
    const set = new Set(running);
    return (d) => set.has(d);
  }
  if (running && typeof running === 'object') return (d) => !!running[d];
  return false;
}

/** Standard normal upper tail Q(z) = 1 - Phi(z) (erfc, Abramowitz-Stegun 7.1.26 form). */
function normalSurvival(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741
    + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

// ══════════════════════════════════════════════════════════════
// STEP 1: estimates from the race, causal at sessionNow
// ══════════════════════════════════════════════════════════════

/**
 * The session-time "now" for the simulation: opts.sessionNow when it is a
 * number, otherwise the lap-indexed clock of currentLap (raceTime.js
 * resolveSessionNow: the race leader's start of currentLap, the last lap
 * included; pass sessionNow: Infinity for the race over). Older callers passed the unused frameData ({ frames, ... }) as
 * the 5th argument: such objects carry no clock and are ignored.
 */
function simulationNow(lapTimes, currentLap, opts) {
  const o = opts && typeof opts === 'object' && !('frames' in opts) ? opts : {};
  if (typeof o.sessionNow === 'number' && !Number.isNaN(o.sessionNow)) return o.sessionNow;
  return resolveSessionNow({ currentLap, lapTimes, sessionTimeOffset: o.sessionTimeOffset });
}

/**
 * Pooled residual sums of per-stint degradation fits (degradation.js
 * stintFits rows): sum of squared residuals and sum (n - 2) over the fitted
 * stints. sqrt(sse / dof) is the lap-to-lap scatter around each stint's
 * tyre-age line, so tyre wear and fuel burn are not counted as noise.
 */
function residualSums(fits) {
  let sse = 0;
  let dof = 0;
  let laps = 0;
  let stints = 0;
  for (const f of Array.isArray(fits) ? fits : []) {
    if (f?.slope == null || !(f.n > 2) || f.residualSigma == null) continue;
    sse += f.residualSigma * f.residualSigma * (f.n - 2);
    dof += f.n - 2;
    laps += f.n;
    stints += 1;
  }
  return { sse, dof, laps, stints };
}

/**
 * Lap noise of a race at its clock (S2, lead decision D1): the race's pooled
 * residual sigma of the per-stint fits at the clock, sqrt(sse / dof)
 * (residualSums: the consistencySigma definition of utils/degradation.js,
 * pooled over every driver), with no floor and no prior mixed in, so early in
 * a race it is the value of the few stints fitted so far, shown with its n
 * (laps, stints). Before the race's first fit (MIN_FIT_LAPS clean laps in a
 * stint) there is no race value: the cached races' value of the same kind
 * (PRIORS.lapNoise.dry, or .wet once an intermediate / wet lap is completed;
 * computePriors), source 'prior', n = 0.
 *
 * @param {Array<Object>} fits - stintFits rows
 * @param {Object} [opts]
 * @param {boolean} [opts.wet=false] - an intermediate / wet lap completed so far
 * @returns {{value: number, raceValue: number|null, laps: number, stints: number, dof: number,
 *   prior: {value: number, kind: 'dry'|'wet'}, source: 'race'|'prior'}} seconds;
 *   raceValue = the race's pooled sigma (= value; null before its first fit)
 */
export function lapNoiseFromFits(fits, { wet = false } = {}) {
  const { sse, dof, laps, stints } = residualSums(fits);
  const kind = wet ? 'wet' : 'dry';
  const prior = { value: PRIORS.lapNoise[kind]?.value ?? PRIORS.lapNoise.value, kind };
  if (dof > 0) {
    const value = Math.sqrt(sse / dof);
    return {
      value, raceValue: value, laps, stints, dof, prior, source: 'race',
    };
  }
  return { value: prior.value, raceValue: null, laps: 0, stints: 0, dof: 0, prior, source: 'prior' };
}

/**
 * The degradation of each compound the lap model uses, from the race's stint
 * fits at the clock (S2). Per compound, with its prior from the cached races
 * (PRIORS.degradation[c], computePriors):
 *  1. only fits with at least minFitLaps clean laps are used. Shorter fits
 *     (a stint still young, or a short stint) are counted as `short` and kept
 *     in allFits: below that length a fit's slope strays further from the
 *     slope of its whole stint than the race's stints differ from one another
 *     (computePriors, partial-stint check), so it tells less about the wear
 *     ahead than the other stints do;
 *  2. the race's wear rate is the normal-normal (empirical Bayes) combination
 *     of the prior's race mean (precision 1 / betweenSd^2: how much a race's
 *     mean differs from the next race's) and the fits used, each weighted by
 *     1 / (withinSd^2 + its slopeStdErr^2) (stints of one race differ by
 *     withinSd; each fit adds its own sampling error). Negative fits enter
 *     the estimate as they are (never clamped) and are counted.
 * Compounds whose prior has no between / within spread (fewer than two races
 * with two fits: wet compounds) use the plain mean of the fits used.
 *
 * @param {Array<Object>} fits - stintFits rows at the clock
 * @returns {Object<string, {mean: number|null, median: number|null, stdDev: number, n: number,
 *   negativeCount: number, posteriorSd: number|null, minFitLaps: number, short: number,
 *   allFits: Object, source: 'race'|'prior'}>} s/lap of tyre age, fuel-corrected;
 *   n = fits used; source 'prior' (mean null) when no fit is long enough yet
 */
export function raceDegradation(fits) {
  const all = compoundDegradation(fits);
  const out = {};
  for (const [c, allFits] of Object.entries(all)) {
    const prior = PRIORS.degradation[compoundKey(c)] || null;
    const minFitLaps = prior?.minFitLaps ?? MIN_FIT_LAPS;
    const used = (fits || []).filter((f) => f?.slope != null && (f.compound ?? 'UNKNOWN') === c && f.n >= minFitLaps);
    const plain = compoundDegradation(used)[c] || null;
    let mean = plain ? plain.mean : null;
    let posteriorSd = null;
    if (plain && prior?.betweenSd != null && prior?.withinSd != null && prior?.raceMean != null) {
      const tb2 = prior.betweenSd * prior.betweenSd;
      const tw2 = prior.withinSd * prior.withinSd;
      if (tb2 > 0) {
        let num = prior.raceMean / tb2;
        let den = 1 / tb2;
        for (const f of used) {
          const se = Number.isFinite(f.slopeStdErr) ? f.slopeStdErr : 0;
          const w = 1 / (tw2 + se * se);
          num += w * f.slope;
          den += w;
        }
        mean = num / den;
        posteriorSd = 1 / Math.sqrt(den);
      } else {
        // the cached races do not differ beyond sampling: the prior's mean
        mean = prior.raceMean;
        posteriorSd = 0;
      }
    }
    out[c] = {
      mean,
      median: plain ? plain.median : null,
      stdDev: plain ? plain.stdDev : 0,
      n: used.length,
      negativeCount: plain ? plain.negativeCount : 0,
      posteriorSd,
      minFitLaps,
      short: allFits.n - used.length,
      allFits,
      source: used.length ? 'race' : 'prior',
    };
  }
  return out;
}

/**
 * Fresh-tyre residuals, one per stint (internal; also used by computePriors):
 * for the clean laps of the stint (degradation.js cleanStintLaps) after lap
 * FRESH_EXCLUDED_LAPS, the mean residual of the fresh laps (TyreLife <=
 * FRESH_TYRE_LAPS) against fitStint of the stint's other laps (TyreLife >
 * FRESH_TYRE_LAPS), in fuel-corrected seconds. Negative = the fresh lap is
 * faster than the stint's tyre-age line predicts.
 */
function freshStintResiduals(clean) {
  const out = [];
  for (const st of clean) {
    const laps = st.laps.filter((lt) => toNum(lt.LapNumber) > FRESH_EXCLUDED_LAPS);
    const fresh = laps.filter((lt) => toNum(lt.TyreLife) <= FRESH_TYRE_LAPS);
    if (!fresh.length) continue;
    const fit = fitStint(laps.filter((lt) => toNum(lt.TyreLife) > FRESH_TYRE_LAPS));
    if (!fit) continue;
    let sum = 0;
    for (const lt of fresh) sum += fuelCorrectedTime(lt) - (fit.intercept + fit.slope * toNum(lt.TyreLife));
    out.push({
      driver: st.driver, stintNumber: st.stintNumber, compound: st.compound,
      residual: sum / fresh.length, laps: fresh.length,
    });
  }
  return out;
}

/**
 * Fresh-tyre delta at sessionNow: the median over stints of
 * freshStintResiduals (paired within driver + stint, fuel-corrected, laps <=
 * FRESH_EXCLUDED_LAPS and non-green laps excluded), constrained <= 0: a
 * positive median (the fresh lap slower than the line) is reported as `raw`
 * with value 0 and clamped true. With no stint measurable yet: the prior,
 * source 'prior'.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @returns {{value: number, raw: number, n: number, laps: number, clamped: boolean,
 *   source: 'race'|'prior', freshTyreLaps: number}} seconds per lap (negative = faster)
 */
export function freshDeltaEstimate(lapTimes, { sessionNow = Infinity, clean } = {}) {
  const rows = freshStintResiduals(clean || cleanStintLaps(lapTimes, { sessionNow }));
  if (!rows.length) {
    const raw = PRIORS.freshDelta.value;
    return {
      value: Math.min(0, raw), raw, n: 0, laps: 0, clamped: raw > 0,
      source: 'prior', freshTyreLaps: FRESH_TYRE_LAPS,
    };
  }
  const raw = median(rows.map((r) => r.residual));
  let laps = 0;
  for (const r of rows) laps += r.laps;
  return {
    value: Math.min(0, raw), raw, n: rows.length, laps, clamped: raw > 0,
    source: 'race', freshTyreLaps: FRESH_TYRE_LAPS,
  };
}

/**
 * Stint-life observations at sessionNow, one per visible stint with at least
 * one completed lap (deriveStints): life = TyreLife of its last completed lap
 * (TotalLaps when the row has none), the age at which the set was changed or
 * has got to.
 *  - 'event'    the stint ended in a tyre change (a later stint exists);
 *  - 'censored' the driver's ongoing stint, or a finisher's final stint (it
 *               ran to the flag): the set lasted at least `life`;
 *  - 'dropped'  a non-finisher's final stint (driverState.js nonFinisherMap):
 *               it ended by retirement, not by a tyre change.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {*} [opts.running] - live mode: drivers still on their set (see runningOption)
 * @param {Object} [opts.dnfMap] - store.dnfMap (results non-finishers)
 * @returns {Array<{driver: string, stintNumber: number, compound: string, life: number,
 *   kind: 'event'|'censored'|'dropped'}>}
 */
export function stintLifeObservations(lapTimes, { sessionNow = Infinity, running = false, dnfMap } = {}) {
  if (!Array.isArray(lapTimes) || !lapTimes.length) return [];
  const now = normaliseNow(sessionNow);
  const stints = deriveStints(lapTimes, { sessionNow: now, running: runningOption(running) });
  const tyreLife = new Map();
  for (const lt of completedLaps(lapTimes, now)) {
    const n = toNum(lt?.LapNumber);
    if (lt?.Driver && n != null) tyreLife.set(`${lt.Driver}\u0000${n}`, toNum(lt.TyreLife));
  }
  const lastStint = new Map();
  for (const st of stints) {
    if (!lastStint.has(st.Driver) || st.StintNumber > lastStint.get(st.Driver)) {
      lastStint.set(st.Driver, st.StintNumber);
    }
  }
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap || {});
  const out = [];
  for (const st of stints) {
    if (!(st.TotalLaps > 0)) continue;
    const tl = tyreLife.get(`${st.Driver}\u0000${st.EndLap}`);
    const life = tl != null && tl >= 1 ? Math.round(tl) : st.TotalLaps;
    let kind;
    if (st.StintNumber < lastStint.get(st.Driver)) kind = 'event';
    else if (st.ongoing) kind = 'censored';
    else if (nonFinishers[st.Driver]) kind = 'dropped';
    else kind = 'censored';
    out.push({ driver: st.Driver, stintNumber: st.StintNumber, compound: st.Compound, life, kind });
  }
  return out;
}

/**
 * Kaplan-Meier survival on integer tyre ages: S[t] = P(the set is changed at
 * an age > t) for t = 0..tMax (the largest observed life), from 'event' and
 * 'censored' observations ('dropped' ones are ignored). A set censored at t
 * is at risk at t.
 *
 * @param {Array<{life: number, kind: string}>} observations
 * @returns {{survival: number[], events: number, censored: number, tMax: number}}
 */
export function kaplanMeier(observations) {
  const obs = (Array.isArray(observations) ? observations : [])
    .filter((o) => (o.kind === 'event' || o.kind === 'censored') && o.life >= 1)
    .map((o) => ({ t: Math.min(STINT_LIFE_MAX, Math.round(o.life)), event: o.kind === 'event' }));
  let tMax = 0;
  for (const o of obs) if (o.t > tMax) tMax = o.t;
  const d = new Array(tMax + 1).fill(0);
  const c = new Array(tMax + 1).fill(0);
  let events = 0;
  for (const o of obs) {
    if (o.event) { d[o.t] += 1; events += 1; } else c[o.t] += 1;
  }
  const survival = [1];
  let atRisk = obs.length;
  let s = 1;
  for (let t = 1; t <= tMax; t++) {
    if (atRisk > 0) s *= 1 - d[t] / atRisk;
    survival.push(s);
    atRisk -= d[t] + c[t];
  }
  return { survival, events, censored: obs.length - events, tMax };
}

/** Prior survival of a compound: normal tail around the prior median life. */
function priorLife(compound) {
  const p = PRIORS.stintLife;
  return p[compound] || p.ALL;
}

function priorSurvivalAt(prior, t) {
  return normalSurvival((t - prior.median) / prior.sigma);
}

/**
 * Survival table S[0..STINT_LIFE_MAX] (S[t] = P(life > t)): Kaplan-Meier of
 * the race's observations up to its largest observed life tMax; past tMax the
 * prior's conditional tail, S[tMax] x Q(t) / Q(tMax) with Q the prior's normal
 * survival; with no observation the prior alone (normalised to S[0] = 1).
 */
function survivalTable(observations, prior) {
  const S = new Array(STINT_LIFE_MAX + 1);
  const km = kaplanMeier(observations);
  if (km.events + km.censored === 0) {
    const q0 = priorSurvivalAt(prior, 0);
    for (let t = 0; t <= STINT_LIFE_MAX; t++) S[t] = priorSurvivalAt(prior, t) / q0;
    return { S, km };
  }
  for (let t = 0; t <= km.tMax; t++) S[t] = km.survival[t];
  const qMax = priorSurvivalAt(prior, km.tMax);
  for (let t = km.tMax + 1; t <= STINT_LIFE_MAX; t++) {
    S[t] = qMax > 1e-12 ? S[km.tMax] * (priorSurvivalAt(prior, t) / qMax) : 0;
  }
  return { S, km };
}

/** Median and restricted mean (ages 0..STINT_LIFE_MAX) of a survival table. */
function survivalSummary(S) {
  let med = Infinity;
  let mean = 0;
  for (let t = 0; t < S.length; t++) {
    if (med === Infinity && S[t] <= 0.5) med = t;
    if (t < S.length - 1) mean += S[t];
  }
  return { median: med, mean };
}

/**
 * Stint life per compound at sessionNow: survivalTable of the race's
 * stintLifeObservations of that compound (source 'race'), for every compound
 * with at least one event or censored observation.
 *
 * @param {Array<Object>} lapTimes
 * @param {Object} [opts] - { sessionNow, running, dnfMap } as stintLifeObservations
 * @returns {Object<string, {survival: number[], median: number, mean: number, n: number,
 *   events: number, censored: number, dropped: number, source: 'race'}>}
 *   median / mean in laps of tyre age (mean restricted to STINT_LIFE_MAX)
 */
export function stintLifeEstimate(lapTimes, opts = {}) {
  const obs = stintLifeObservations(lapTimes, opts);
  const groups = new Map();
  for (const o of obs) {
    const c = compoundKey(o.compound);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(o);
  }
  const out = {};
  for (const [c, list] of groups) {
    const { S, km } = survivalTable(list, priorLife(c));
    if (km.events + km.censored === 0) continue;
    out[c] = {
      survival: S,
      ...survivalSummary(S),
      n: km.events + km.censored,
      events: km.events,
      censored: km.censored,
      dropped: list.length - km.events - km.censored,
      source: 'race',
    };
  }
  return out;
}

const priorTableCache = new Map();

/**
 * The stint-life estimate of a compound: the race's (raceParams.stintLength)
 * when it has one, else the prior's survival (source 'prior').
 *
 * @param {Object} raceParams - extractRaceParams result
 * @param {string} compound
 * @returns {{survival: number[], median: number, mean: number, n: number, source: string}}
 */
export function stintLifeFor(raceParams, compound) {
  const c = compoundKey(compound);
  const own = raceParams?.stintLength?.[c];
  if (own?.survival) return own;
  if (!priorTableCache.has(c)) {
    const prior = priorLife(c);
    const { S } = survivalTable([], prior);
    priorTableCache.set(c, {
      survival: S, ...survivalSummary(S), n: prior.n || 0, events: prior.events || 0,
      censored: 0, dropped: 0, source: 'prior',
    });
  }
  return priorTableCache.get(c);
}

/**
 * Draw the tyre age at which a set of age `age` is due, by inversion of the
 * survival table conditional on life > age: the smallest t > age with
 * S[t] <= u x S[age]. Infinity when the table never gets that low (the set
 * outlasts the table). null when S[age] is 0 (the set is older than every
 * life the table allows).
 *
 * @param {number[]} survival - S[0..STINT_LIFE_MAX]
 * @param {number} age - current tyre age (laps)
 * @param {number} u - uniform draw in (0, 1)
 * @param {number} [maxAge] - draw conditional on age < life <= maxAge (a stop that must
 *   happen by then); when that range has no mass, a uniform age in it
 * @returns {number|null}
 */
export function sampleStintEnd(survival, age, u, maxAge) {
  const a = Math.max(0, Math.floor(age));
  if (a >= survival.length) return null;
  const sa = survival[a];
  if (!(sa > 1e-12)) return null;
  if (maxAge != null) {
    const b = Math.min(survival.length - 1, Math.floor(maxAge));
    if (b <= a) return null;
    const sb = survival[b];
    const mass = sa - sb;
    if (!(mass > 1e-12)) return a + 1 + Math.min(b - a - 1, Math.floor(u * (b - a)));
    const target = sa - u * mass;
    for (let t = a + 1; t <= b; t++) if (survival[t] <= target) return t;
    return b;
  }
  const target = u * sa;
  for (let t = a + 1; t < survival.length; t++) if (survival[t] <= target) return t;
  return Infinity;
}

/**
 * Conditional median life: the tyre age by which half of the sets that have
 * reached `age` are changed (the smallest t > age with S[t] <= S[age] / 2);
 * Infinity when the table never gets that low, null when S[age] is 0.
 *
 * @param {number[]} survival
 * @param {number} age
 * @returns {number|null}
 */
export function conditionalMedianLife(survival, age) {
  return sampleStintEnd(survival, age, 0.5);
}

/**
 * Degradation of a compound: the race's (raceParams.tyreDeg, raceDegradation:
 * fits long enough combined with the prior, source 'race') or, before the
 * race has such a fit, the prior (source 'prior': the mean of the cached
 * races' means, raceMean), with the spread the simulation draws one stint's
 * rate from (samplingSd: a stint of this race, sqrt(withinSd^2 +
 * posteriorSd^2); for a hand-made raceParams without posteriorSd, its stdDev
 * when it has two fits or more).
 *
 * @param {Object} raceParams
 * @param {string} compound
 * @returns {{mean: number, stdDev: number, n: number, negativeCount: number,
 *   samplingSd: number, source: 'race'|'prior'}} s/lap of tyre age, fuel-corrected
 */
export function degradationFor(raceParams, compound) {
  const c = compoundKey(compound);
  const prior = PRIORS.degradation[c] || PRIORS.degradation.ALL;
  const own = raceParams?.tyreDeg?.[c];
  if (own && own.n > 0 && Number.isFinite(own.mean)) {
    let samplingSd = own.n >= 2 ? own.stdDev : prior.stdDev;
    if (Number.isFinite(own.posteriorSd) && prior.withinSd != null) {
      samplingSd = Math.sqrt(prior.withinSd * prior.withinSd + own.posteriorSd * own.posteriorSd);
    }
    return { ...own, samplingSd, source: own.source || 'race' };
  }
  const hier = prior.raceMean != null && prior.withinSd != null && prior.betweenSd != null;
  return {
    mean: hier ? prior.raceMean : prior.mean,
    median: prior.median ?? prior.mean,
    stdDev: prior.stdDev,
    n: prior.n || 0,
    negativeCount: prior.negativeCount || 0,
    samplingSd: hier ? Math.sqrt(prior.withinSd ** 2 + prior.betweenSd ** 2) : prior.stdDev,
    source: 'prior',
  };
}

/** Laps of the race completed by the leader at now (the highest completed LapNumber). */
function leaderLapsCompleted(lapTimes, now) {
  let best = 0;
  for (const lt of completedLaps(lapTimes, now)) {
    const n = toNum(lt?.LapNumber);
    if (n != null && n > best) best = n;
  }
  return best;
}

/**
 * Neutralisation episodes that started by sessionNow: maximal runs of
 * consecutive track-status periods (time order, race periods only:
 * raceTime.js mapTrackStatusToLaps) whose status is SC '4', VSC '6' / '7' or
 * red '5', counted when the run has an SC or VSC period. type 'SC' when an SC
 * period is in it, else 'VSC'. durationLaps (end lap - start lap + 1, leader
 * laps) only for episodes that ended by sessionNow.
 *
 * @param {Array<Object>} trackStatus - sessionData.track_status
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity]
 * @returns {Array<{type: 'SC'|'VSC', startLap: number, endLap: number|null,
 *   startTime: number, endTime: number|null, durationLaps: number|null, ongoing: boolean}>}
 */
export function neutralEpisodes(trackStatus, lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const periods = mapTrackStatusToLaps(trackStatus, lapTimes)
    .filter((p) => toNum(p.start_time) != null && toNum(p.start_time) <= now)
    .sort((a, b) => toNum(a.start_time) - toNum(b.start_time));
  const runs = [];
  let cur = null;
  for (const p of periods) {
    const st = String(p.status);
    if (!NEUTRAL_STATUSES.has(st)) { cur = null; continue; }
    if (!cur) {
      cur = { statuses: new Set(), startLap: p.start_lap, endLap: p.end_lap,
        startTime: toNum(p.start_time), endTime: toNum(p.end_time) };
      runs.push(cur);
    }
    cur.statuses.add(st);
    cur.endLap = Math.max(cur.endLap, p.end_lap);
    cur.endTime = toNum(p.end_time);
  }
  return runs
    .filter((r) => [...r.statuses].some((s) => EPISODE_STATUSES.has(s)))
    .map((r) => {
      const ended = r.endTime != null && r.endTime <= now;
      return {
        type: r.statuses.has('4') ? 'SC' : 'VSC',
        startLap: r.startLap,
        endLap: ended ? r.endLap : null,
        startTime: r.startTime,
        endTime: ended ? r.endTime : null,
        durationLaps: ended ? r.endLap - r.startLap + 1 : null,
        ongoing: !ended,
      };
    });
}

/**
 * Safety-car estimate at sessionNow (S8). Only episodes that started by then
 * count (neutralEpisodes); a VSC deploy + ending is one episode. Rate per
 * leader lap, shrunk toward the prior with SC_PRIOR_WEIGHT_RACES:
 *   rate = (prior episodes per race x w + episodes) / (prior laps per race x w + laps)
 * source 'race' with at least one episode, else 'prior'. scShare (the share
 * of episodes that are full SCs) is shrunk the same way. Durations: the
 * race's completed episodes of each type, else the prior's median.
 *
 * @param {Array<Object>} trackStatus
 * @param {Array<Object>} lapTimes
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity]
 * @returns {Object} { rate, episodes, scEpisodes, laps, observedRate, source, scShare,
 *   durations: { SC: number[], VSC: number[] }, durationSource: { SC, VSC },
 *   scGapRatio, ongoing: episode|null, prior }
 */
export function safetyCarEstimate(trackStatus, lapTimes, { sessionNow = Infinity } = {}) {
  const now = normaliseNow(sessionNow);
  const prior = PRIORS.safetyCar;
  const w = SC_PRIOR_WEIGHT_RACES;
  const laps = Array.isArray(lapTimes) && lapTimes.length ? leaderLapsCompleted(lapTimes, now) : 0;
  const episodes = Array.isArray(trackStatus) && trackStatus.length && laps > 0
    ? neutralEpisodes(trackStatus, lapTimes, now) : [];
  const k = episodes.length;
  const kSC = episodes.filter((e) => e.type === 'SC').length;
  const durations = { SC: [], VSC: [] };
  for (const e of episodes) if (e.durationLaps != null) durations[e.type].push(e.durationLaps);
  const ongoing = episodes.find((e) => e.ongoing) || null;
  return {
    rate: (prior.episodesPerRace * w + k) / (prior.lapsPerRace * w + laps),
    episodes: k,
    scEpisodes: kSC,
    laps,
    observedRate: laps > 0 ? k / laps : null,
    source: k > 0 ? 'race' : 'prior',
    scShare: (prior.scEpisodesPerRace * w + kSC) / (prior.episodesPerRace * w + k),
    durations,
    durationSource: {
      SC: durations.SC.length ? 'race' : 'prior',
      VSC: durations.VSC.length ? 'race' : 'prior',
    },
    scGapRatio: prior.scGapRatio,
    ongoing,
    prior: { ...prior, weightRaces: w },
  };
}

/** Tyre changes seen so far as { from: { to: count } } (stints.js pitStops). */
function compoundTransitions(lapTimes, sessionNow) {
  const out = {};
  for (const s of pitStops(lapTimes, { sessionNow })) {
    const from = compoundKey(s.fromCompound);
    const to = compoundKey(s.toCompound);
    if (!out[from]) out[from] = {};
    out[from][to] = (out[from][to] || 0) + 1;
  }
  return out;
}

/**
 * Compute race parameters from real data observed up to sessionNow.
 *
 * @param {Array} lapTimes - sessionData.lap_times (full race; filtered causally here)
 * @param {Array} strategies - unused: stints are derived from lapTimes (utils/stints.js),
 *   kept so existing call sites keep working
 * @param {Array} trackStatus - [{status, start_time, end_time, message}]
 * @param {number} currentLap
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow] - session seconds (raceTime.resolveSessionNow);
 *   when omitted, derived in lap mode from currentLap
 * @param {number} [opts.sessionTimeOffset] - session seconds of replay time 0
 * @param {string} [opts.sessionType] - 'R', 'S', 'Q', 'FP2', ...; omitted = race. Outside
 *   'R' / 'S' the pit loss is { source: 'not-applicable' } with no numbers (pitLoss.js)
 * @param {*} [opts.running] - deriveStints option: in live mode the stints still being run
 *   are censored, not completed (stints.js stintsRunning); boolean, function, list or map
 * @param {Object} [opts.dnfMap] - store.dnfMap: results non-finishers (their final stint is
 *   dropped from the stint-life estimate)
 * @returns {Object} raceParams:
 *   pitLoss      utils/pitLoss.js estimatePitLoss object (median = point estimate)
 *   tyreDeg      { compound: raceDegradation row }: fuel-corrected s per lap of tyre age,
 *                the fits long enough combined with the prior (degradationFor reads it)
 *   stintLength  { compound: { survival, median, mean, n, events, censored, dropped, source } }
 *   freshDelta   seconds (<= 0), estimates.freshDelta.value
 *   lapNoise     seconds, estimates.lapNoise.value (the race's pooled residual sigma of
 *                the stint fits at the clock; the cached races' before its first fit;
 *                lapNoiseFromFits)
 *   scRate       episodes per leader lap, estimates.safetyCar.rate
 *   scDuration   median laps of an SC episode (race, else prior)
 *   estimates    { degradation, freshDelta, lapNoise, stintLife, safetyCar, fuelEffect },
 *                each with its sample size and source ('race' / 'prior' / 'assumption')
 *   transitions  { from: { to: count } } tyre changes so far
 *   dryRace      no lap on INTERMEDIATE / WET completed so far
 *   sessionNow   the clock used (session seconds)
 */
export function extractRaceParams(lapTimes, strategies, trackStatus, currentLap, opts = {}) {
  const sessionNow = simulationNow(lapTimes, currentLap, opts);
  const o = opts && typeof opts === 'object' && !('frames' in opts) ? opts : {};
  const rows = Array.isArray(lapTimes) ? lapTimes : [];

  const fits = rows.length ? stintFits(rows, { sessionNow }) : [];
  const done = completedLaps(rows, sessionNow);
  const dryRace = !done.some((lt) => WET.has(compoundKey(lt?.Compound)));
  const tyreDeg = raceDegradation(fits);
  const lapNoise = lapNoiseFromFits(fits, { wet: !dryRace });
  const freshDelta = freshDeltaEstimate(rows, { sessionNow });
  const stintLength = rows.length
    ? stintLifeEstimate(rows, { sessionNow, running: o.running || false, dnfMap: o.dnfMap })
    : {};
  const safetyCar = safetyCarEstimate(trackStatus, rows, { sessionNow });
  const scDuration = median(safetyCar.durations.SC) ?? PRIORS.safetyCar.durationLaps.SC;

  let negativeFits = 0;
  let fitted = 0;
  for (const f of fits) {
    if (f.slope == null) continue;
    fitted += 1;
    if (f.slope < 0) negativeFits += 1;
  }
  let used = 0;
  let short = 0;
  for (const d of Object.values(tyreDeg)) {
    used += d.n;
    short += d.short;
  }

  return {
    // ── 1. Pit stop time loss ──
    // FastF1 splits one stop over two rows (PitInTime on the in-lap n,
    // PitOutTime on the out-lap n + 1), so the loss is in-lap + out-lap - 2 x
    // the driver's green median, over green stops completed at sessionNow.
    // source 'fallback' (n = 0) when no stop qualifies yet; 'not-applicable'
    // outside race sessions.
    pitLoss: estimatePitLoss(rows, { sessionNow, sessionType: o.sessionType }),
    tyreDeg,
    stintLength,
    freshDelta: freshDelta.value,
    lapNoise: lapNoise.value,
    scRate: safetyCar.rate,
    scDuration,
    estimates: {
      // fitted / negativeFits: every fit (diagnostics); used: long enough for
      // the estimate (raceDegradation), short: not yet
      degradation: {
        stints: fits.length, fitted, negativeFits, used, short, source: used > 0 ? 'race' : 'prior',
      },
      freshDelta,
      lapNoise,
      stintLife: Object.fromEntries(Object.entries(stintLength).map(([c, s]) => [c, {
        median: s.median, mean: s.mean, n: s.n, events: s.events, censored: s.censored,
        dropped: s.dropped, source: s.source,
      }])),
      safetyCar,
      fuelEffect: { value: FUEL_EFFECT_S_PER_LAP, source: 'assumption' },
    },
    transitions: rows.length ? compoundTransitions(rows, sessionNow) : {},
    dryRace,
    sessionNow,
  };
}

// ══════════════════════════════════════════════════════════
// STEP 2: lap model and Monte Carlo engine
// ══════════════════════════════════════════════════════════

/**
 * One projected lap time (S9): basePace + deg x tyreAge - refDeg x refAge,
 * plus freshDelta on tyre ages 2..FRESH_TYRE_LAPS of a new set, plus trend x
 * trendLaps (the trend of the current stint; trendLaps = 0 after a stop).
 * basePace was measured at tyre age refAge on a set wearing refDeg per lap,
 * so the current wear is in basePace once and only the wear added after it
 * counts. deg = 0 and trend = 0 give a flat pace.
 *
 * @param {Object} p
 * @param {number} p.basePace - seconds, at tyre age refAge
 * @param {number} p.refAge - tyre age of basePace
 * @param {number} p.refDeg - degradation of the set basePace was measured on (s/lap)
 * @param {number} p.deg - degradation of the set in use (s/lap)
 * @param {number} p.tyreAge - tyre age on this lap
 * @param {boolean} [p.newSet] - the set was fitted after the reference (fresh delta applies)
 * @param {number} [p.freshDelta=0] - seconds (<= 0)
 * @param {number} [p.trend=0] - s/lap
 * @param {number} [p.trendLaps=0]
 * @returns {number} seconds
 */
export function projectedLapTime({
  basePace, refAge, refDeg, deg, tyreAge, newSet = false, freshDelta = 0, trend = 0, trendLaps = 0,
}) {
  const fresh = newSet && tyreAge >= 2 && tyreAge <= FRESH_TYRE_LAPS ? freshDelta : 0;
  return basePace + deg * tyreAge - refDeg * refAge + fresh + trend * trendLaps;
}

/**
 * Each driver's pace reference at sessionNow: the mean of the last
 * PACE_REF_LAPS clean laps (degradation.js isCleanLap) of the stint of the
 * driver's latest clean lap, each moved to the fuel load of `currentLap`
 * (LapTimeSeconds - FUEL_EFFECT_S_PER_LAP x (currentLap - LapNumber)), with
 * their mean TyreLife and the stint's compound and number.
 */
function paceReferences(lapTimes, sessionNow, currentLap, stintsBy) {
  const byDriver = new Map();
  for (const lt of completedLaps(lapTimes, sessionNow)) {
    if (!lt?.Driver || !isCleanLap(lt)) continue;
    if (!byDriver.has(lt.Driver)) byDriver.set(lt.Driver, []);
    byDriver.get(lt.Driver).push(lt);
  }
  const out = {};
  for (const [drv, laps] of byDriver) {
    laps.sort((a, b) => toNum(a.LapNumber) - toNum(b.LapNumber));
    const last = laps[laps.length - 1];
    const lastN = toNum(last.LapNumber);
    const stints = stintsBy[drv] || [];
    const stint = stints.find((s) => lastN >= s.StartLap && lastN <= s.EndLap) || null;
    const same = stint
      ? laps.filter((lt) => toNum(lt.LapNumber) >= stint.StartLap && toNum(lt.LapNumber) <= stint.EndLap)
      : [last];
    const ref = same.slice(-PACE_REF_LAPS);
    let pace = 0;
    let age = 0;
    for (const lt of ref) {
      pace += toNum(lt.LapTimeSeconds) - FUEL_EFFECT_S_PER_LAP * (currentLap - toNum(lt.LapNumber));
      age += toNum(lt.TyreLife);
    }
    out[drv] = {
      basePace: pace / ref.length,
      refAge: age / ref.length,
      stintNumber: stint ? stint.StintNumber : null,
      compound: compoundKey(stint ? stint.Compound : last.Compound),
      laps: ref.length,
    };
  }
  return out;
}

/** Normalised plans: { driver: [{ lap, compound }] } sorted by lap, laps in [fromLap, maxLap). */
function normalisePlans(plans, fromLap, maxLap) {
  const out = {};
  if (!plans || typeof plans !== 'object') return out;
  for (const [drv, stops] of Object.entries(plans)) {
    if (!Array.isArray(stops)) continue;
    out[drv] = stops
      .map((s) => ({ lap: Math.round(toNum(s?.lap)), compound: compoundKey(s?.compound) }))
      .filter((s) => Number.isFinite(s.lap) && s.lap >= fromLap && s.lap < maxLap)
      .sort((a, b) => a.lap - b.lap);
  }
  return out;
}

/**
 * Compound fitted at a model stop: among the candidates (dry compounds not
 * used yet when the stop is the mandatory one, else any dry compound), the
 * one this race has fitted most often after `current` so far, else the
 * prior's (PRIORS.transitions); ties and no counts at all go by
 * DRY_COMPOUNDS order from the hardest. Wet compounds stay as they are (the
 * weather is not forecast).
 */
function nextCompound(current, used, mustChange, transitions) {
  if (WET.has(current)) return current;
  const candidates = DRY_COMPOUNDS.filter((c) => !mustChange || (!used.has(c) && c !== current));
  if (!candidates.length) return current;
  const order = [...candidates].reverse();
  for (const table of [transitions?.[current], PRIORS.transitions?.[current]]) {
    if (!table) continue;
    let best = null;
    let bestCount = 0;
    for (const c of order) {
      const n = table[c] || 0;
      if (n > bestCount) { best = c; bestCount = n; }
    }
    if (best) return best;
  }
  return order[0];
}

/**
 * Static per-driver inputs of the simulation (shared by every sim and by
 * baseline and plan runs).
 */
function buildContext({
  driverFeatures, currentLap, maxLap, lapTimes, raceParams, sessionNow, running, plans, seed,
  useTrend = false, stopRule, optionalStopMinLapsLeft,
}) {
  const drivers = Object.keys(driverFeatures);
  const rows = Array.isArray(lapTimes) ? lapTimes : [];
  const now = normaliseNow(sessionNow ?? raceParams?.sessionNow);
  const stintsBy = rows.length ? stintsByDriver(rows, { sessionNow: now, running: runningOption(running) }) : {};
  const refs = rows.length ? paceReferences(rows, now, currentLap, stintsBy) : {};
  const paces = drivers.map((d) => refs[d]?.basePace ?? toNum(driverFeatures[d]?.recentPace))
    .filter((v) => v != null);
  const fieldPace = median(paces) ?? 0;
  const dryRace = raceParams?.dryRace !== false;
  const statics = drivers.map((drv) => {
    const feat = driverFeatures[drv] || {};
    const compound = compoundKey(feat.compoundName);
    const ageNow = toNum(feat.tyreLife) ?? 0;
    const stints = stintsBy[drv] || [];
    const current = stints[stints.length - 1] || null;
    const ref = refs[drv];
    const sameStint = !ref || ref.stintNumber == null || !current || ref.stintNumber === current.StintNumber;
    const used = new Set(stints.map((s) => compoundKey(s.Compound)));
    used.add(compound);
    const ruleKnown = stints.length > 0 && !used.has('UNKNOWN');
    const dryUsed = [...used].filter((c) => DRY.has(c)).length;
    const deg = degradationFor(raceParams, compound);
    const trend = useTrend && toNum(feat.paceTrend) != null
      ? toNum(feat.paceTrend) - (deg.mean - FUEL_EFFECT_S_PER_LAP) : 0;
    return {
      drv,
      compound,
      ageNow,
      gap: toNum(feat.gapToLeader) ?? 0,
      basePace: ref ? ref.basePace : (toNum(feat.recentPace) ?? fieldPace),
      refAge: ref ? ref.refAge : ageNow,
      refCompound: ref ? ref.compound : compound,
      sameStint,
      used,
      mustStop: dryRace && ruleKnown && DRY.has(compound) && dryUsed < 2,
      trend,
      plan: null,
    };
  });
  const planned = normalisePlans(plans, currentLap, maxLap);
  for (const s of statics) if (planned[s.drv]) s.plan = planned[s.drv];
  return {
    drivers, statics, raceParams, currentLap, maxLap, fieldPace, seed: seed >>> 0,
    transitions: raceParams?.transitions || {},
    stopRule: stopRule === 'payback' ? 'payback' : 'laps-left',
    optionalStopMinLapsLeft: toNum(optionalStopMinLapsLeft) ?? OPTIONAL_STOP_MIN_LAPS_LEFT,
  };
}

/** Pit-loss draw for a stop on in-lap `lap` (normal around the median, see PIT_LOSS_*). */
function pitLossDraw(ctx, sim, drv, lap) {
  const { raceParams } = ctx;
  const med = toNum(raceParams.pitLoss.median) ?? 0;
  const sd = Math.max(PIT_LOSS_SAMPLING_MIN_SD, toNum(raceParams.pitLoss.stdDev) || 0);
  return Math.max(PIT_LOSS_NUMERIC_FLOOR, med + sd * normalAt(ctx.seed, sim, drv, lap, STREAMS.PIT_LOSS));
}

/** Degradation draw of a driver's k-th stint from now (k = 0: the current set). */
function degDraw(ctx, sim, drv, k, compound) {
  const d = degradationFor(ctx.raceParams, compound);
  return d.mean + d.samplingSd * normalAt(ctx.seed, sim, drv, k, STREAMS.DEGRADATION);
}

/**
 * Due tyre age of a set: a draw from the compound's stint-life survival
 * conditional on the age reached (k = stint ordinal from now, the draw index).
 * mustStop: conditional on a stop by maxAge (the age at the last lap a stop
 * is possible). null = no stop possible / needed.
 */
function dueAge(ctx, sim, drv, k, compound, age, mustStop, maxAge) {
  const u = uniformAt(ctx.seed, sim, drv, k, STREAMS.STINT_LIFE);
  const table = stintLifeFor(ctx.raceParams, compound).survival;
  if (mustStop) {
    if (!(maxAge > age)) return null;
    const t = sampleStintEnd(table, age, u, maxAge);
    if (t != null) return t;
    const prior = stintLifeFor({}, compound).survival;
    return sampleStintEnd(prior, age, u, maxAge) ?? age + 1;
  }
  const t = sampleStintEnd(table, age, u);
  if (t != null) return t;
  const prior = stintLifeFor({}, compound).survival;
  return sampleStintEnd(prior, age, u) ?? age + 1;
}

/**
 * Time a stop on in-lap `lap` gains over the laps left, under the lap model:
 * old set (deg0, age `age`) against a new set (deg1) on every lap to the
 * flag, plus the fresh-tyre delta. Pit loss not included.
 */
function stopGain(deg0, deg1, age, lapsLeft, freshDelta) {
  if (lapsLeft <= 0) return 0;
  const freshLaps = Math.max(0, Math.min(lapsLeft, FRESH_TYRE_LAPS) - 1);
  return deg0 * age * lapsLeft + (deg0 - deg1) * lapsLeft * (lapsLeft + 1) / 2 - freshLaps * freshDelta;
}

/**
 * One simulation: every driver from the lap in progress (currentLap) to the
 * flag (maxLap). Returns { driver: { time, stops } }, time in seconds from
 * the leader's position now (gapToLeader + projected laps + pit losses).
 */
function runOneSim(ctx, sim) {
  const { raceParams, currentLap, maxLap, seed } = ctx;
  const freshDelta = toNum(raceParams.freshDelta) ?? 0;
  const lapNoise = toNum(raceParams.lapNoise) ?? 0;
  const sc = raceParams.estimates?.safetyCar || {
    rate: toNum(raceParams.scRate) ?? 0, scShare: 0, durations: { SC: [], VSC: [] }, scGapRatio: 1,
  };
  const scRate = toNum(raceParams.scRate) ?? sc.rate ?? 0;

  const states = ctx.statics.map((st) => {
    const deg0 = degDraw(ctx, sim, st.drv, 0, st.compound);
    const refDeg = st.sameStint ? deg0 : degradationFor(raceParams, st.refCompound).mean;
    const maxAge = st.ageNow + (maxLap - currentLap);
    return {
      st,
      time: st.gap,
      compound: st.compound,
      age: st.ageNow,
      deg: deg0,
      refDeg,
      newSet: !st.sameStint,
      stintK: 0,
      stops: 0,
      used: new Set(st.used),
      mustStop: st.mustStop,
      due: st.plan ? null : dueAge(ctx, sim, st.drv, 0, st.compound, st.ageNow, st.mustStop, maxAge),
      planIdx: 0,
    };
  });

  // Neutralisation in progress at now: the rest of its drawn duration
  let neutralLeft = 0;
  let neutralType = null;
  if (sc.ongoing) {
    neutralType = sc.ongoing.type;
    const d = drawDuration(sc, neutralType, seed, sim, currentLap - 1);
    const elapsed = Math.max(0, currentLap - sc.ongoing.startLap);
    neutralLeft = Math.max(1, d - elapsed);
    if (neutralType === 'SC' && elapsed < SC_BUNCHED_AFTER_LAPS) compressGaps(states, sc.scGapRatio);
  }

  for (let lap = currentLap; lap <= maxLap; lap++) {
    if (neutralLeft <= 0 && uniformAt(seed, sim, 0, lap, STREAMS.SC_START) < scRate) {
      neutralType = uniformAt(seed, sim, 0, lap, STREAMS.SC_TYPE) < (sc.scShare ?? 0) ? 'SC' : 'VSC';
      neutralLeft = drawDuration(sc, neutralType, seed, sim, lap);
      if (neutralType === 'SC') compressGaps(states, sc.scGapRatio);
    }
    const neutral = neutralLeft > 0;
    if (neutral) neutralLeft -= 1;

    for (const s of states) {
      const st = s.st;
      s.age += 1;
      if (neutral) {
        // Neutralised lap: every car laps at the same pace (gaps frozen)
        s.time += ctx.fieldPace;
      } else {
        s.time += projectedLapTime({
          basePace: st.basePace, refAge: st.refAge, refDeg: s.refDeg, deg: s.deg, tyreAge: s.age,
          newSet: s.newSet, freshDelta, trend: s.stintK === 0 ? st.trend : 0,
          trendLaps: s.stintK === 0 ? lap - currentLap + 1 : 0,
        }) + lapNoise * normalAt(seed, sim, st.drv, lap, STREAMS.LAP_NOISE);
      }
      if (lap >= maxLap) continue;

      // ── Stop decision at the end of this lap (in-lap) ──
      let stopTo = null;
      if (st.plan) {
        while (s.planIdx < st.plan.length && st.plan[s.planIdx].lap < lap) s.planIdx += 1;
        if (s.planIdx < st.plan.length && st.plan[s.planIdx].lap === lap) {
          stopTo = st.plan[s.planIdx].compound;
          s.planIdx += 1;
        }
      } else if (s.due != null && s.age >= s.due) {
        const next = nextCompound(s.compound, s.used, s.mustStop, ctx.transitions);
        if (s.mustStop) {
          stopTo = next;
        } else {
          const gain = ctx.stopRule === 'payback'
            ? stopGain(s.deg, degDraw(ctx, sim, st.drv, s.stintK + 1, next), s.age, maxLap - lap, freshDelta)
            : 0;
          const take = ctx.stopRule === 'payback'
            ? gain > pitLossDraw(ctx, sim, st.drv, lap)
            : maxLap - lap >= ctx.optionalStopMinLapsLeft;
          if (take) stopTo = next;
          else s.due = null; // no optional stop this late: the set runs to the flag
        }
      }
      if (stopTo != null) {
        s.time += pitLossDraw(ctx, sim, st.drv, lap);
        s.stops += 1;
        s.stintK += 1;
        s.compound = stopTo;
        s.used.add(stopTo);
        s.age = 0;
        s.newSet = true;
        s.deg = degDraw(ctx, sim, st.drv, s.stintK, stopTo);
        const dryUsed = [...s.used].filter((c) => DRY.has(c)).length;
        s.mustStop = s.mustStop && DRY.has(stopTo) && dryUsed < 2;
        s.due = st.plan ? null : dueAge(ctx, sim, st.drv, s.stintK, stopTo, 0, s.mustStop, maxLap - 1 - lap);
      }
    }
  }

  const out = {};
  for (const s of states) out[s.st.drv] = { time: s.time, stops: s.stops };
  return out;
}

/** Neutralisation length in laps: a race episode of that type (bootstrap), else the prior median. */
function drawDuration(sc, type, seed, sim, lap) {
  const list = sc.durations?.[type] || [];
  if (list.length) {
    const u = uniformAt(seed, sim, 0, lap, STREAMS.SC_DURATION);
    return list[Math.min(list.length - 1, Math.floor(u * list.length))];
  }
  return PRIORS.safetyCar.durationLaps[type] ?? 1;
}

/** Safety car deployed: every gap to the leader times the measured SC gap ratio. */
function compressGaps(states, ratio) {
  let lead = Infinity;
  for (const s of states) if (s.time < lead) lead = s.time;
  for (const s of states) s.time = lead + (s.time - lead) * ratio;
}

/**
 * Run the Monte Carlo core: numSimulations sims of runOneSim with the given
 * parameters. Positions are by projected time (1 = fastest).
 *
 * @param {Object} p - { driverFeatures, currentLap, maxLap, lapTimes, raceParams, sessionNow,
 *   running, plans, seed, numSimulations, useTrend, stopRule, optionalStopMinLapsLeft }
 *   (as simulateRaceFinish; raceParams required)
 * @returns {{drivers: string[], sims: Array<Object<string, {time: number, stops: number,
 *   pos: number}>>}}
 */
export function runSimulations(p) {
  const ctx = buildContext(p);
  const n = Math.max(1, Math.round(p.numSimulations ?? DEFAULT_NUM_SIMULATIONS));
  const sims = [];
  for (let i = 0; i < n; i++) {
    const res = runOneSim(ctx, i);
    const order = ctx.drivers.slice().sort((a, b) => res[a].time - res[b].time || (a < b ? -1 : 1));
    order.forEach((d, idx) => { res[d].pos = idx + 1; });
    sims.push(res);
  }
  return { drivers: ctx.drivers, sims };
}

/**
 * Deterministic projection of one driver's coming laps under the lap model
 * (no noise, no safety car, mean degradation): the expected lap time, tyre
 * age and compound of every lap from fromLap to toLap, with the planned stops
 * (each adds the pit-loss median on its in-lap). For views that project a
 * car lap by lap (undercut, "pit in k laps") with the engine's model.
 *
 * @param {Object} p
 * @param {Object} p.raceParams - extractRaceParams result
 * @param {string} p.compound - set in use now
 * @param {number} p.tyreAge - its age now (TyreLife of the latest completed lap)
 * @param {number} p.basePace - seconds, measured at tyre age refAge
 * @param {number} [p.refAge=tyreAge] - tyre age of basePace
 * @param {string} [p.refCompound=compound] - compound basePace was measured on
 * @param {boolean} [p.newSet=false] - the set in use was fitted after the basePace laps
 *   (the fresh-tyre delta applies to its first flying lap)
 * @param {number} p.fromLap
 * @param {number} p.toLap
 * @param {Array<{lap: number, compound: string}>} [p.stops] - in-laps and the compound fitted
 * @returns {Array<{lap: number, lapTime: number, tyreAge: number, compound: string,
 *   pitLoss: number}>} lapTime excludes pitLoss (added on the in-lap row)
 */
export function projectLapTimes({
  raceParams, compound, tyreAge, basePace, refAge, refCompound, newSet: freshSet = false,
  fromLap, toLap, stops = [],
}) {
  const c0 = compoundKey(compound);
  const deg0 = degradationFor(raceParams, c0).mean;
  const refDeg = degradationFor(raceParams, refCompound ?? c0).mean;
  const ra = refAge ?? tyreAge;
  const freshDelta = toNum(raceParams?.freshDelta) ?? 0;
  const pitMedian = toNum(raceParams?.pitLoss?.median) ?? 0;
  const plan = normalisePlans({ x: stops }, fromLap, toLap + 1).x || [];
  let c = c0;
  let deg = deg0;
  let age = toNum(tyreAge) ?? 0;
  let newSet = !!freshSet;
  let k = 0;
  const out = [];
  for (let lap = fromLap; lap <= toLap; lap++) {
    age += 1;
    const lapTime = projectedLapTime({ basePace, refAge: ra, refDeg, deg, tyreAge: age, newSet, freshDelta });
    const stop = plan[k] && plan[k].lap === lap ? plan[k] : null;
    out.push({ lap, lapTime, tyreAge: age, compound: c, pitLoss: stop ? pitMedian : 0 });
    if (stop) {
      k += 1;
      c = stop.compound;
      deg = degradationFor(raceParams, c).mean;
      age = 0;
      newSet = true;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// STEP 3: Aggregate results across simulations
// ══════════════════════════════════════════════════════════

/** p-quantile of a sorted array (lower value, as the old 5 % / 95 % indices). */
function quantileSorted(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}

/**
 * Normal quantile of the intervals put around Monte Carlo statistics (two-sided
 * 95 %): the risk triggers here and the badges of utils/simulationClient.js
 * (BADGE_Z). A convention for "beyond the sampling error", not a value read
 * off data.
 */
export const MC_INTERVAL_Z = 1.96;

/**
 * Distribution-free interval of the p-quantile quantileSorted reads (index
 * floor(n p)): the order statistics floor(n p) -/+ z sqrt(n p (1 - p)), the
 * normal approximation of the binomial count of draws below the quantile.
 *
 * @param {number[]} sorted - ascending
 * @param {number} p
 * @returns {[number, number]|null}
 */
function quantileInterval(sorted, p, z = MC_INTERVAL_Z) {
  const n = sorted.length;
  if (!n) return null;
  const centre = Math.floor(n * p);
  const half = z * Math.sqrt(n * p * (1 - p));
  const lo = Math.min(n - 1, Math.max(0, Math.floor(centre - half)));
  const hi = Math.min(n - 1, Math.max(0, Math.ceil(centre + half)));
  return [sorted[lo], sorted[hi]];
}

function aggregateResults(allSims, driverFeatures) {
  const drivers = Object.keys(driverFeatures);

  // ── Per-driver position distributions ──
  const projections = drivers.map((drv) => {
    const feat = driverFeatures[drv];
    const positions = [];
    const pitCounts = [];
    const posCount = {}; // position → count

    for (const sim of allSims) {
      if (!sim || !sim[drv]) continue;
      const p = sim[drv].pos;
      positions.push(p);
      pitCounts.push(sim[drv].stops);
      posCount[p] = (posCount[p] || 0) + 1;
    }

    if (positions.length === 0) {
      return {
        driver: drv,
        currentPos: feat.position,
        expectedPos: feat.position,
        modePos: feat.position,
        posRange: [feat.position, feat.position],
        posDistribution: { [feat.position]: 100 },
        podiumProb: feat.position <= 3 ? 100 : 0,
        pointsProb: feat.position <= 10 ? 100 : 0,
        pitStopsRemaining: { mean: 0, median: 0, range: [0, 0] },
        delta: 0,
      };
    }

    positions.sort((a, b) => a - b);

    // Expected position (weighted average)
    const expectedPos = positions.reduce((a, b) => a + b, 0) / positions.length;

    // Mode position (most common; ties to the better position)
    let modePos = feat.position;
    let maxCount = 0;
    for (const [pos, count] of Object.entries(posCount)) {
      if (count > maxCount) { maxCount = count; modePos = parseInt(pos, 10); }
    }

    // Position range: 5th to 95th percentile
    const posRange = [quantileSorted(positions, 0.05), quantileSorted(positions, 0.95)];

    // Position distribution as percentages
    const posDistribution = {};
    for (const [pos, count] of Object.entries(posCount)) {
      const pct = Math.round((count / positions.length) * 100);
      if (pct > 0) posDistribution[parseInt(pos, 10)] = pct;
    }

    // Podium and points probabilities
    const podiumCount = positions.filter((p) => p <= 3).length;
    const pointsCount = positions.filter((p) => p <= 10).length;

    // Pit stops still to come
    pitCounts.sort((a, b) => a - b);
    const pitMean = pitCounts.reduce((a, b) => a + b, 0) / pitCounts.length;
    const pitSd = pitCounts.length > 1
      ? Math.sqrt(pitCounts.reduce((a, b) => a + (b - pitMean) ** 2, 0) / (pitCounts.length - 1))
      : 0;

    return {
      driver: drv,
      currentPos: feat.position,
      expectedPos: Math.round(expectedPos * 10) / 10,
      modePos,
      posRange,
      // Sampling intervals of the two ends of posRange (quantileInterval): the
      // Risks tab judges the range against its threshold beyond them
      posRangeCI: [quantileInterval(positions, 0.05), quantileInterval(positions, 0.95)],
      posDistribution,
      // simulations per finishing position (unrounded): the finishing position
      // the views show is read off their cumulative share
      // (utils/simulationClient.js shownPositions)
      posCount: { ...posCount },
      podiumProb: Math.round((podiumCount / positions.length) * 100),
      pointsProb: Math.round((pointsCount / positions.length) * 100),
      pitStopsRemaining: {
        mean: Math.round(pitMean * 10) / 10,
        // sample standard deviation over the simulations (the mean's sampling
        // error is sd / sqrt(n), the Risks tab's interval)
        sd: Math.round(pitSd * 1000) / 1000,
        median: median(pitCounts),
        range: [quantileSorted(pitCounts, 0.05), quantileSorted(pitCounts, 0.95)],
      },
      delta: Math.round((feat.position - expectedPos) * 10) / 10,
    };
  });

  // Sort by expected position
  projections.sort((a, b) => a.expectedPos - b.expectedPos);

  // ── Battles: pairwise overtake probabilities ──
  // Every pair within 4 positions, with no cut on the probability: which
  // battles a view lists is decided by the badge rule (Wilson interval +
  // hysteresis, utils/simulationClient.js listedBattles), never by a bare
  // threshold or a top-N cut on a Monte Carlo estimate.
  const battles = [];
  for (let i = 0; i < drivers.length; i++) {
    for (let j = i + 1; j < drivers.length; j++) {
      const d1 = drivers[i];
      const d2 = drivers[j];
      const feat1 = driverFeatures[d1];
      const feat2 = driverFeatures[d2];

      // Only check drivers within 4 positions of each other
      if (Math.abs(feat1.position - feat2.position) > 4) continue;

      // Determine who's currently ahead
      const [ahead, behind] = feat1.position < feat2.position ? [d1, d2] : [d2, d1];

      // Count how often the behind driver finishes ahead
      let overtakeCount = 0;
      for (const sim of allSims) {
        if (!sim || !sim[ahead] || !sim[behind]) continue;
        if (sim[behind].pos < sim[ahead].pos) overtakeCount++;
      }

      const prob = Math.round((overtakeCount / allSims.length) * 100);

      battles.push({
        ahead,
        behind,
        aheadCurrentPos: driverFeatures[ahead].position,
        behindCurrentPos: driverFeatures[behind].position,
        prob,
        aheadCompound: driverFeatures[ahead].compoundName,
        behindCompound: driverFeatures[behind].compoundName,
      });
    }
  }

  // Most likely first; ties in a fixed order (chasing driver, then the one ahead)
  battles.sort((a, b) => b.prob - a.prob
    || (a.behind < b.behind ? -1 : a.behind > b.behind ? 1 : 0)
    || (a.ahead < b.ahead ? -1 : a.ahead > b.ahead ? 1 : 0));

  return { projections, battles };
}

// ══════════════════════════════════════════════════════════
// STEP 4: Risk identification from real data
// ══════════════════════════════════════════════════════════

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Risk rules of the Risks tab. Display choices of the panel (the values it has
// always used), not values read off data:
//  - HIGH VARIANCE: the P5-P95 finishing range spans at least 5 places (8: high);
//  - EXTRA STOP: at least 1.8 stops still to come on average;
//  - DEGRADATION: the driver's pace trend above 0.15 s/lap (0.25: high);
//  - TYRE CLIFF: the set past 85 % (95 %: high) of its compound's mean stint
//    life, under 0.5 stops to come on average, more than 5 laps left.
const RISK_SPREAD_PLACES = Object.freeze([5, 8]);
const RISK_EXTRA_STOPS = 1.8;
const RISK_PACE_TREND = Object.freeze([0.15, 0.25]);
const RISK_TYRE_RATIO = Object.freeze([0.85, 0.95]);
const RISK_NO_STOP = 0.5;
const RISK_MIN_LAPS_LEFT = 5;
/** Rows of the Risks tab: a display choice, the length the panel has always shown. */
export const RISK_LIST_SIZE = 5;
// Fixed order of the risk types within a severity and a driver
const RISK_TYPE_ORDER = { 'EXTRA STOP': 0, 'TYRE CLIFF': 1, 'HIGH VARIANCE': 2, DEGRADATION: 3 };

/**
 * A risk trigger "value >= threshold" judged as the badges are
 * (utils/simulationClient.js badgeOn): on when the whole sampling interval
 * [lo, hi] is at or above the threshold, off when it is entirely below; with
 * the threshold inside the interval (within the Monte Carlo error) the
 * previous state is kept, and with no previous state the point estimate
 * decides. A trigger on data alone has lo = hi = the value.
 */
function triggerAtLeast(point, lo, hi, threshold, prevOn) {
  if (lo >= threshold) return true;
  if (hi < threshold) return false;
  return typeof prevOn === 'boolean' ? prevOn : point >= threshold;
}

/** Interval of a mean over n simulations: mean -/+ z sd / sqrt(n); the point without n or sd. */
function meanInterval(mean, sd, n) {
  if (!(n > 0) || !Number.isFinite(sd)) return [mean, mean];
  const half = (MC_INTERVAL_Z * sd) / Math.sqrt(n);
  return [mean - half, mean + half];
}

/** Key of a risk trigger: driver and type. */
function riskKey(driver, type) {
  return `${driver}|${type}`;
}

/**
 * Every risk trigger of a projection with its level (0 = off, 1 = medium,
 * 2 = high), judged beyond the Monte Carlo error (triggerAtLeast) against the
 * previous projection's levels: a risk row turns on, off or changes severity
 * only on evidence beyond the sampling error of the statistics behind it
 * (the P5 / P95 ends of the finishing range: posRangeCI; the mean stops to
 * come: sd / sqrt(n)), as the badges do. Triggers on data alone (pace trend,
 * tyre age) have no sampling error.
 *
 * @param {Array<Object>} projections - simulateRaceFinish projections
 * @param {Object} driverFeatures
 * @param {Object} raceParams
 * @param {number} currentLap
 * @param {number} maxLap
 * @param {Object} [opts]
 * @param {number} [opts.n] - simulations behind the projections; without it the
 *   statistics are taken as exact (point estimates)
 * @param {Object} [opts.prev] - the previous projection's levels ({ 'DRV|TYPE': level })
 * @returns {{rows: Array<{driver: string, type: string, severity: string, description: string}>,
 *   levels: Object<string, number>}} rows: every risk on, most severe first, then in the
 *   current race order (data, never a Monte Carlo statistic), then by type
 */
export function evaluateRisks(projections, driverFeatures, raceParams, currentLap, maxLap, { n, prev } = {}) {
  const rows = [];
  const levels = {};
  const lapsRemaining = maxLap - currentLap;
  const level = (point, lo, hi, thresholds, key) => {
    const was = prev?.[key];
    const on = thresholds.map((t, i) => triggerAtLeast(point, lo, hi, t, typeof was === 'number' ? was > i : undefined));
    const lv = on.lastIndexOf(true) + 1;
    levels[key] = lv;
    return lv;
  };

  for (const proj of projections || []) {
    const drv = proj.driver;
    const feat = driverFeatures?.[drv];
    if (!feat) continue;
    const order = { position: Number.isFinite(feat.position) ? feat.position : Infinity };
    const pit = proj.pitStopsRemaining || {};
    const [pitLo, pitHi] = meanInterval(pit.mean, pit.sd, n);

    // Wide position range = high uncertainty
    const spread = proj.posRange[1] - proj.posRange[0];
    const ci = proj.posRangeCI;
    const spreadLo = n > 0 && ci?.[0] && ci?.[1] ? Math.max(0, ci[1][0] - ci[0][1]) : spread;
    const spreadHi = n > 0 && ci?.[0] && ci?.[1] ? ci[1][1] - ci[0][0] : spread;
    const variance = level(spread, spreadLo, spreadHi, RISK_SPREAD_PLACES, riskKey(drv, 'HIGH VARIANCE'));
    if (variance > 0) {
      rows.push({
        ...order,
        driver: drv,
        type: 'HIGH VARIANCE',
        severity: variance >= 2 ? 'high' : 'medium',
        description: `${drv} could finish anywhere from P${proj.posRange[0]} to P${proj.posRange[1]} — highly unpredictable outcome`,
      });
    }

    // Extra pit stop risk (most sims show 2+ stops)
    if (level(pit.mean, pitLo, pitHi, [RISK_EXTRA_STOPS], riskKey(drv, 'EXTRA STOP')) > 0) {
      const pitLoss = raceParams.pitLoss.median;
      const pitLossNote = raceParams.pitLoss.source === 'fallback' ? ' (fallback pit loss, no measured stop yet)' : '';
      rows.push({
        ...order,
        driver: drv,
        type: 'EXTRA STOP',
        severity: 'high',
        description: `${drv} likely needs ${Math.round(pit.mean)} more stops — ~${Math.round(pit.mean * pitLoss)}s time loss${pitLossNote}`,
      });
    }

    // Heavy degradation from real data (no sampling error: the driver's laps)
    const trend = Number.isFinite(feat.paceTrend) ? feat.paceTrend : 0;
    const deg = RISK_PACE_TREND.filter((t) => trend > t).length;
    levels[riskKey(drv, 'DEGRADATION')] = deg;
    if (deg > 0) {
      // the race's estimate (degradationFor), once the race has a fit long enough
      const compoundDeg = degradationFor(raceParams, feat.compoundName);
      const degStr = compoundDeg.source === 'race'
        ? `(observed ${feat.compoundName} deg: ${compoundDeg.mean.toFixed(3)}s/lap)`
        : '';
      rows.push({
        ...order,
        driver: drv,
        type: 'DEGRADATION',
        severity: deg >= 2 ? 'high' : 'medium',
        description: `${drv} losing ${trend.toFixed(2)}s/lap on ${feat.compoundName} ${degStr}`,
      });
    }

    // Tyre cliff: nearing the compound's typical life (stint-life survival
    // mean, data) with no stop to come (a Monte Carlo mean: "< 0.5" is on when
    // the whole interval is below it, off when it is entirely at or above it)
    const life = stintLifeFor(raceParams, feat.compoundName);
    const tyreRatio = life.mean > 0 ? feat.tyreLife / life.mean : 0;
    const cliffKey = riskKey(drv, 'TYRE CLIFF');
    const wasCliff = prev?.[cliffKey];
    const noStop = !triggerAtLeast(pit.mean, pitLo, pitHi, RISK_NO_STOP,
      typeof wasCliff === 'number' ? !(wasCliff > 0) : undefined);
    const ratioLevel = RISK_TYRE_RATIO.filter((t) => tyreRatio > t).length;
    const cliff = noStop && lapsRemaining > RISK_MIN_LAPS_LEFT ? ratioLevel : 0;
    levels[cliffKey] = cliff;
    if (cliff > 0) {
      rows.push({
        ...order,
        driver: drv,
        type: 'TYRE CLIFF',
        severity: cliff >= 2 ? 'high' : 'medium',
        description: `${drv} pushing ${feat.compoundName} to limit (${feat.tyreLife}/${Math.round(life.mean)} avg stint) with no pit planned`,
      });
    }
  }

  rows.sort((a, b) => ((SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2))
    || (a.position - b.position)
    || ((RISK_TYPE_ORDER[a.type] ?? 9) - (RISK_TYPE_ORDER[b.type] ?? 9))
    || (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0));
  return { rows: rows.map(({ position, ...r }) => r), levels };
}

/**
 * Risks per driver from the projections (evaluateRisks with no previous
 * state), most severe first, then in the current race order, at most
 * RISK_LIST_SIZE.
 *
 * @param {Object} [opts] - { n: simulations behind the projections }
 * @returns {Array<{driver: string, type: string, severity: string, description: string}>}
 */
export function identifyRisks(projections, driverFeatures, raceParams, currentLap, maxLap, opts = {}) {
  return evaluateRisks(projections, driverFeatures, raceParams, currentLap, maxLap, opts).rows.slice(0, RISK_LIST_SIZE);
}

// ══════════════════════════════════════════════════════════
// MAIN EXPORTS
// ══════════════════════════════════════════════════════════

/** Default seed: a function of the projection's state, so the same state gives the same result. */
function defaultSeed(currentLap, maxLap, sessionNow) {
  return seedFrom('race-simulation', currentLap, maxLap, sessionNow == null ? 'lap-mode' : sessionNow);
}

/**
 * Monte Carlo race finish simulation.
 *
 * @param {Object} params
 * @param {Object} params.driverFeatures - from raceSituationData.driverFeatures
 * @param {number} params.currentLap - the lap in progress (simulated from it to maxLap)
 * @param {number} params.maxLap
 * @param {Array}  params.lapTimes - sessionData.lap_times (real data)
 * @param {Array}  params.strategies - sessionData.tyre_strategy (unused, see extractRaceParams)
 * @param {Array}  params.trackStatus - real safety car/VSC events
 * @param {number} [params.sessionNow] - session seconds; lap mode from currentLap when omitted
 * @param {number} [params.sessionTimeOffset] - session seconds of replay time 0
 * @param {string} [params.sessionType] - 'R', 'S', 'Q', ...; omitted = race. A race
 *   projection needs a race pit loss: null outside 'R' / 'S'
 * @param {*} [params.running] - live mode: drivers still on their current set (stints.js
 *   stintsRunning); boolean, function, list of driver codes or { driver: boolean }
 * @param {Object} [params.dnfMap] - store.dnfMap
 * @param {number} [params.numSimulations=DEFAULT_NUM_SIMULATIONS]
 * @param {number} [params.seed] - uint32 (prng.js seedFrom); default: from currentLap,
 *   maxLap and sessionNow, so the same state always gives the same result
 * @param {Object} [params.plans] - { driver: [{ lap, compound }] }: in-laps of planned stops
 *   (laps before currentLap or >= maxLap ignored); replaces the stop model for that driver
 * @param {Object} [params.raceParams] - precomputed extractRaceParams result (same clock)
 * @param {boolean} [params.useTrend=false] - add each driver's pace trend in excess of the
 *   model (current stint only); off by default: it makes the backtest's expected positions
 *   worse (scripts/mc_benchmark.mjs section 4)
 * @param {string} [params.stopRule='laps-left'] - optional stops: 'laps-left' (taken when at
 *   least optionalStopMinLapsLeft laps are left) or 'payback' (taken when the old set would
 *   lose more than the pit loss against a new one); compared in the benchmark
 * @param {number} [params.optionalStopMinLapsLeft=OPTIONAL_STOP_MIN_LAPS_LEFT]
 * @param {string} [params.tracePositionsOf] - a driver whose finishing position in every run
 *   is returned as positionsOf (by run index): the what-if pairs its two runs run by run
 *   (common random numbers, utils/simulationClient.js compareJob)
 * @returns {{ projections, battles, risks, raceParams, numSimulations, seed, positionsOf? } | null}
 */
export function simulateRaceFinish({
  driverFeatures, currentLap, maxLap, lapTimes, strategies, trackStatus,
  sessionNow, sessionTimeOffset, sessionType, running, dnfMap,
  numSimulations = DEFAULT_NUM_SIMULATIONS, seed, plans, raceParams: given, useTrend = false,
  stopRule, optionalStopMinLapsLeft, tracePositionsOf,
}) {
  if (!driverFeatures || currentLap < 5 || maxLap <= currentLap) return null;

  const drivers = Object.keys(driverFeatures);
  if (drivers.length < 2) return null;

  // ── Step 1: Extract real parameters ──
  const raceParams = given || extractRaceParams(lapTimes, strategies, trackStatus, currentLap,
    { sessionNow, sessionTimeOffset, sessionType, running, dnfMap });
  // No race pit loss outside race sessions ('not-applicable'): no projection
  if (raceParams.pitLoss?.source === 'not-applicable') return null;

  // ── Step 2: Run Monte Carlo simulations ──
  const usedSeed = (seed ?? defaultSeed(currentLap, maxLap, sessionNow)) >>> 0;
  const { sims } = runSimulations({
    driverFeatures, currentLap, maxLap, lapTimes, raceParams,
    sessionNow: raceParams.sessionNow ?? sessionNow, running, plans, seed: usedSeed,
    numSimulations, useTrend, stopRule, optionalStopMinLapsLeft,
  });

  // ── Step 3: Aggregate ──
  const { projections, battles } = aggregateResults(sims, driverFeatures);

  // ── Step 4: Risks ──
  const risks = identifyRisks(projections, driverFeatures, raceParams, currentLap, maxLap, { n: sims.length });

  const out = { projections, battles, risks, raceParams, numSimulations: sims.length, seed: usedSeed };
  if (tracePositionsOf) out.positionsOf = sims.map((sim) => sim?.[tracePositionsOf]?.pos ?? null);
  return out;
}

/**
 * What-if comparison for one driver (S6): the baseline (basePlan, default:
 * the stop model) against `plan`, from the SAME seed and parameters, so both
 * runs share every random draw (common random numbers): with plan equal to
 * basePlan every number of the two runs is identical and every difference
 * exactly 0. Other drivers keep the stop model in both runs.
 *
 * @param {Object} params - simulateRaceFinish params plus:
 * @param {string} params.focusDriver
 * @param {Array<{lap: number, compound: string}>} [params.plan] - the focus driver's planned
 *   in-laps; omitted = the stop model
 * @param {Array<{lap: number, compound: string}>} [params.basePlan] - the baseline's plan;
 *   omitted = the stop model
 * @returns {{focusDriver: string, seed: number, numSimulations: number,
 *   baseline: Object, plan: Object, delta: {position: number, podium: number, points: number},
 *   paired: {meanPositionChange: number, probGain: number, probLoss: number, probSame: number,
 *     meanTimeDelta: number}, baselineResult: Object, planResult: Object, raceParams: Object}|null}
 *   baseline / plan: the focus driver's projection rows (as simulateRaceFinish);
 *   delta.position = baseline.expectedPos - plan.expectedPos (positive = the plan gains places);
 *   paired: per-sim plan - baseline (position change < 0 = gain), probabilities in [0, 1],
 *   meanTimeDelta in seconds (negative = the plan is faster)
 */
export function compareStrategies(params) {
  const {
    driverFeatures, currentLap, maxLap, lapTimes, strategies, trackStatus,
    sessionNow, sessionTimeOffset, sessionType, running, dnfMap,
    numSimulations = DEFAULT_NUM_SIMULATIONS, seed, focusDriver, plan, basePlan,
    raceParams: given, useTrend = false, stopRule, optionalStopMinLapsLeft,
  } = params || {};
  if (!driverFeatures || !focusDriver || !driverFeatures[focusDriver]) return null;
  if (currentLap < 5 || maxLap <= currentLap || Object.keys(driverFeatures).length < 2) return null;
  const raceParams = given || extractRaceParams(lapTimes, strategies, trackStatus, currentLap,
    { sessionNow, sessionTimeOffset, sessionType, running, dnfMap });
  if (raceParams.pitLoss?.source === 'not-applicable') return null;
  const usedSeed = (seed ?? defaultSeed(currentLap, maxLap, sessionNow)) >>> 0;
  const common = {
    driverFeatures, currentLap, maxLap, lapTimes, raceParams,
    sessionNow: raceParams.sessionNow ?? sessionNow, running, seed: usedSeed, numSimulations, useTrend,
    stopRule, optionalStopMinLapsLeft,
  };
  const base = runSimulations({ ...common, plans: basePlan ? { [focusDriver]: basePlan } : undefined });
  const alt = runSimulations({ ...common, plans: plan ? { [focusDriver]: plan } : undefined });

  const baseAgg = aggregateResults(base.sims, driverFeatures);
  const altAgg = aggregateResults(alt.sims, driverFeatures);
  const baseProj = baseAgg.projections.find((p) => p.driver === focusDriver);
  const altProj = altAgg.projections.find((p) => p.driver === focusDriver);

  let posSum = 0;
  let timeSum = 0;
  let gain = 0;
  let loss = 0;
  const n = base.sims.length;
  for (let i = 0; i < n; i++) {
    const b = base.sims[i][focusDriver];
    const a = alt.sims[i][focusDriver];
    const dp = a.pos - b.pos;
    posSum += dp;
    timeSum += a.time - b.time;
    if (dp < 0) gain += 1;
    else if (dp > 0) loss += 1;
  }
  return {
    focusDriver,
    seed: usedSeed,
    numSimulations: n,
    baseline: baseProj,
    plan: altProj,
    delta: {
      position: Math.round((baseProj.expectedPos - altProj.expectedPos) * 10) / 10,
      podium: altProj.podiumProb - baseProj.podiumProb,
      points: altProj.pointsProb - baseProj.pointsProb,
    },
    paired: {
      meanPositionChange: posSum / n,
      probGain: gain / n,
      probLoss: loss / n,
      probSame: (n - gain - loss) / n,
      meanTimeDelta: timeSum / n,
    },
    baselineResult: { ...baseAgg, risks: identifyRisks(baseAgg.projections, driverFeatures, raceParams, currentLap, maxLap, { n }) },
    planResult: { ...altAgg, risks: identifyRisks(altAgg.projections, driverFeatures, raceParams, currentLap, maxLap, { n }) },
    raceParams,
  };
}

// ══════════════════════════════════════════════════════════
// Priors over many races (scripts/mc_benchmark.mjs, tests)
// ══════════════════════════════════════════════════════════

/** Tyre age by which a survival curve (no tail) drops to `level`, or null. */
function kmQuantile(S, level) {
  for (let t = 0; t < S.length; t++) if (S[t] <= level) return t;
  return null;
}

/**
 * SC gap ratios of one race (computePriors): for every SC episode, the
 * median over cars of GapToLeader at the end of the lap after the episode
 * over GapToLeader at the end of the lap before it (cars with a gap in
 * [GAP_RATIO_MIN_GAP_S, GAP_RATIO_MAX_GAP_S] before, no pit entry or exit on
 * those laps).
 */
function scGapRatios(trackStatus, lapTimes) {
  const rows = new Map();
  const drivers = new Set();
  for (const lt of lapTimes) {
    if (!lt?.Driver) continue;
    drivers.add(lt.Driver);
    rows.set(`${lt.Driver}\u0000${toNum(lt.LapNumber)}`, lt);
  }
  const out = [];
  for (const e of neutralEpisodes(trackStatus, lapTimes, Infinity)) {
    if (e.type !== 'SC' || e.endLap == null) continue;
    const ratios = [];
    for (const d of drivers) {
      const before = rows.get(`${d}\u0000${e.startLap - 1}`);
      const after = rows.get(`${d}\u0000${e.endLap + 1}`);
      const g0 = toNum(before?.GapToLeader);
      const g1 = toNum(after?.GapToLeader);
      if (g0 == null || g1 == null || g0 < GAP_RATIO_MIN_GAP_S || g0 > GAP_RATIO_MAX_GAP_S || g1 < 0) continue;
      let pitted = false;
      for (let L = e.startLap - 1; L <= e.endLap + 1; L++) {
        const r = rows.get(`${d}\u0000${L}`);
        if (r && (r.PitInTimeSeconds || r.PitInTime || r.PitOutTimeSeconds || r.PitOutTime)) pitted = true;
      }
      if (!pitted) ratios.push(g1 / g0);
    }
    if (ratios.length) out.push(median(ratios));
  }
  return out;
}

/** Lower empirical p-quantile: the value at index floor(p x n) of the sorted values. */
function lowerQuantile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

/**
 * Laps left to the flag after each optional stop of one race (computePriors):
 * dry races only (no INTERMEDIATE / WET stint), finishers only; a stop is
 * optional when the driver had already used two dry compounds before it.
 * Laps left = race laps - the in-lap.
 */
function optionalStopLapsLeft(lapTimes, raceLaps) {
  const stints = deriveStints(lapTimes);
  if (stints.some((st) => WET.has(compoundKey(st.Compound)))) return [];
  const nonFinishers = nonFinisherMap(lapTimes, {});
  const byDriver = new Map();
  for (const st of stints) {
    if (!byDriver.has(st.Driver)) byDriver.set(st.Driver, []);
    byDriver.get(st.Driver).push(st);
  }
  const out = [];
  for (const [drv, list] of byDriver) {
    if (nonFinishers[drv]) continue;
    const used = new Set();
    for (let i = 0; i < list.length - 1; i++) {
      used.add(compoundKey(list[i].Compound));
      if ([...used].filter((c) => DRY.has(c)).length >= 2) out.push(raceLaps - list[i].EndLap);
    }
  }
  return out;
}

/**
 * Partial-stint check of computePriors: stints with at least this many clean
 * laps are compared with the fits on their first k clean laps, k =
 * MIN_FIT_LAPS..PARTIAL_CHECK_LAPS. ASSUMPTION, an analysis choice: long
 * enough to see where a partial fit settles (scripts/degradation_in_race.mjs
 * section A: from 8 to 20 laps the spread of partial - whole falls from about
 * 0.12 to 0.03 s/lap), short enough to keep most stints (the stint-life
 * median is 25 laps, PRIORS.stintLife.ALL). A compound whose partial fits
 * never get closer than its stints differ gets this many laps.
 */
export const PARTIAL_CHECK_LAPS = 20;

/** Sample variance (n - 1), null with fewer than two values. */
function sampleVariance(values) {
  const n = values.length;
  if (n < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((a, v) => a + (v - m) * (v - m), 0) / (n - 1);
}

/**
 * Degradation spread between and within races, per compound (and ALL), for
 * raceDegradation: over the races with two fits or more of the compound,
 * raceMean = the mean of the race means; withinSd = the pooled within-race
 * standard deviation of the fits; betweenSd = the spread of the race means
 * beyond what withinSd explains (moment estimate: variance of the race means
 * - withinSd^2 x the mean of 1 / fits per race, at least 0). minFitLaps: the
 * fewest clean laps (MIN_FIT_LAPS..PARTIAL_CHECK_LAPS) at which the fits on
 * the first k laps of the stints with PARTIAL_CHECK_LAPS clean laps or more
 * differ from their whole-stint fits by a standard deviation below withinSd.
 * null fields when fewer than two races qualify.
 */
function degradationHierarchy(perRaceFits, partialDiffs) {
  const groups = new Map(); // compound -> [slopes of one race]
  for (const raceFits of perRaceFits) {
    const byC = new Map();
    for (const f of raceFits) {
      if (f?.slope == null) continue;
      for (const c of [compoundKey(f.compound), 'ALL']) {
        if (!byC.has(c)) byC.set(c, []);
        byC.get(c).push(f.slope);
      }
    }
    for (const [c, slopes] of byC) {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(slopes);
    }
  }
  const out = {};
  for (const [c, races] of groups) {
    const qualified = races.filter((sl) => sl.length >= 2);
    const empty = { raceMean: null, withinSd: null, betweenSd: null, races: qualified.length, minFitLaps: MIN_FIT_LAPS };
    if (qualified.length < 2) { out[c] = empty; continue; }
    let ssw = 0;
    let dfw = 0;
    let invN = 0;
    const means = [];
    for (const sl of qualified) {
      const m = sl.reduce((a, b) => a + b, 0) / sl.length;
      means.push(m);
      ssw += sampleVariance(sl) * (sl.length - 1);
      dfw += sl.length - 1;
      invN += 1 / sl.length;
    }
    const tw2 = ssw / dfw;
    const tb2 = Math.max(0, sampleVariance(means) - tw2 * (invN / qualified.length));
    const withinSd = Math.sqrt(tw2);
    let minFitLaps = MIN_FIT_LAPS;
    const diffs = partialDiffs.get(c);
    if (diffs && diffs.size) {
      minFitLaps = PARTIAL_CHECK_LAPS;
      for (let k = MIN_FIT_LAPS; k <= PARTIAL_CHECK_LAPS; k++) {
        const v = sampleVariance(diffs.get(k) || []);
        if (v != null && Math.sqrt(v) < withinSd) { minFitLaps = k; break; }
      }
    }
    out[c] = {
      raceMean: means.reduce((a, b) => a + b, 0) / means.length,
      withinSd,
      betweenSd: Math.sqrt(tb2),
      races: qualified.length,
      minFitLaps,
    };
  }
  return out;
}

/**
 * Lap-noise prior of a kind of race: the race lap-noise variances (pooled
 * residual variance per race) as a scaled-inverse-chi-square distribution,
 * moments matched: nu0 = 4 + 2 / cv^2 (cv = coefficient of variation of the
 * variances), s0^2 = mean x (nu0 - 2) / nu0. lapNoiseFromFits uses s0 only
 * before a race's first fit; nu0 is a measurement (how much races differ),
 * no longer a weight (lead decision D1).
 */
function lapNoisePrior(raceVariances) {
  const n = raceVariances.length;
  if (n < 2) return { value: n ? Math.sqrt(raceVariances[0]) : null, nu0: 0, races: n };
  const m = raceVariances.reduce((a, b) => a + b, 0) / n;
  const cv2 = sampleVariance(raceVariances) / (m * m);
  const nu0 = cv2 > 0 ? 4 + 2 / cv2 : 0;
  return { value: Math.sqrt(nu0 > 0 ? (m * (nu0 - 2)) / nu0 : m), nu0, races: n };
}

/**
 * The priors of this module measured over many races, each taken whole
 * (sessionNow = Infinity) with the same estimators as a single race:
 *  - degradation: compoundDegradation of every race's stint fits pooled, per
 *    compound and over all compounds (ALL), with the between / within race
 *    spread and minFitLaps of degradationHierarchy (raceDegradation);
 *  - lapNoise: the pooled residual sigma of those fits, and the dry / wet
 *    priors of lapNoiseFromFits (lapNoisePrior over the dry races, those with
 *    no intermediate / wet lap, and over the others);
 *  - freshDelta: the median of every race's fresh-tyre stint residuals;
 *  - stintLife: per compound (and ALL; sets with no compound on their rows
 *    count in ALL only), the Kaplan-Meier of every race's stint-life
 *    observations pooled; median = age where S <= 0.5, sigma =
 *    interquartile range / 1.349 (median - lower quartile over 0.6745 when
 *    the upper quartile is never reached): the normal tail used past a race's data;
 *  - safetyCar: episodes and leader laps per race, the SC share, median
 *    episode length per type, median SC gap ratio (scGapRatios);
 *  - transitions: tyre changes { from: { to: count } };
 *  - optionalStops: laps left after the optional stops (optionalStopLapsLeft),
 *    lower decile, lower quartile and median.
 *
 * @param {Array<{lapTimes: Array<Object>, trackStatus: Array<Object>}>} sessions
 * @returns {Object} same shape as PRIORS (unrounded) plus maxRaceLaps
 */
export function computePriors(sessions) {
  const fits = [];
  const fresh = [];
  const lifeObs = [];
  const transitions = {};
  const durations = { SC: [], VSC: [] };
  const gapRatios = [];
  let episodes = 0;
  let scEpisodes = 0;
  let laps = 0;
  let races = 0;
  let maxRaceLaps = 0;
  const optionalLeft = [];
  const perRaceFits = [];
  const partialDiffs = new Map(); // compound -> Map(k -> [partial slope - whole slope])
  const noiseVar = { dry: [], wet: [] };
  for (const s of sessions) {
    const lt = s.lapTimes || [];
    if (!lt.length) continue;
    races += 1;
    const raceFits = stintFits(lt);
    fits.push(...raceFits);
    perRaceFits.push(raceFits);
    const sums = residualSums(raceFits);
    const wetRace = lt.some((x) => WET.has(compoundKey(x?.Compound)));
    if (sums.dof > 0) noiseVar[wetRace ? 'wet' : 'dry'].push(sums.sse / sums.dof);
    for (const st of cleanStintLaps(lt)) {
      if (st.laps.length < PARTIAL_CHECK_LAPS) continue;
      const whole = fitStint(st.laps);
      if (!whole) continue;
      for (const c of [compoundKey(st.compound), 'ALL']) {
        if (!partialDiffs.has(c)) partialDiffs.set(c, new Map());
        const byK = partialDiffs.get(c);
        for (let k = MIN_FIT_LAPS; k <= PARTIAL_CHECK_LAPS; k++) {
          const part = fitStint(st.laps.slice(0, k));
          if (!part) continue;
          if (!byK.has(k)) byK.set(k, []);
          byK.get(k).push(part.slope - whole.slope);
        }
      }
    }
    fresh.push(...freshStintResiduals(cleanStintLaps(lt)));
    lifeObs.push(...stintLifeObservations(lt));
    const tr = compoundTransitions(lt, Infinity);
    for (const [from, tos] of Object.entries(tr)) {
      if (!transitions[from]) transitions[from] = {};
      for (const [to, n] of Object.entries(tos)) transitions[from][to] = (transitions[from][to] || 0) + n;
    }
    const raceLaps = leaderLapsCompleted(lt, Infinity);
    laps += raceLaps;
    if (raceLaps > maxRaceLaps) maxRaceLaps = raceLaps;
    const eps = neutralEpisodes(s.trackStatus, lt, Infinity);
    episodes += eps.length;
    for (const e of eps) {
      if (e.type === 'SC') scEpisodes += 1;
      if (e.durationLaps != null) durations[e.type].push(e.durationLaps);
    }
    gapRatios.push(...scGapRatios(s.trackStatus, lt));
    optionalLeft.push(...optionalStopLapsLeft(lt, raceLaps));
  }

  const degradation = compoundDegradation(fits);
  const all = compoundDegradation(fits.map((f) => ({ ...f, compound: 'ALL' }))).ALL;
  if (all) degradation.ALL = all;
  const hierarchy = degradationHierarchy(perRaceFits, partialDiffs);
  for (const [c, d] of Object.entries(degradation)) Object.assign(d, hierarchy[compoundKey(c)] || {});

  const stintLife = {};
  const groups = new Map([['ALL', lifeObs]]);
  for (const o of lifeObs) {
    const c = compoundKey(o.compound);
    if (c === 'UNKNOWN') continue; // no compound on the rows: such a set uses ALL
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(o);
  }
  for (const [c, list] of groups) {
    const km = kaplanMeier(list);
    const med = kmQuantile(km.survival, 0.5);
    const q25 = kmQuantile(km.survival, 0.75);
    const q75 = kmQuantile(km.survival, 0.25);
    if (med == null || q25 == null) continue;
    const sigma = q75 != null ? (q75 - q25) / 1.349 : (med - q25) / 0.6745;
    stintLife[c] = { median: med, sigma, q25, q75, n: km.events + km.censored, events: km.events };
  }

  return {
    races,
    degradation,
    lapNoise: {
      value: Math.sqrt(residualSums(fits).sse / residualSums(fits).dof),
      stints: residualSums(fits).stints,
      dry: lapNoisePrior(noiseVar.dry),
      wet: lapNoisePrior(noiseVar.wet),
    },
    freshDelta: { value: median(fresh.map((r) => r.residual)), stints: fresh.length },
    stintLife,
    safetyCar: {
      episodesPerRace: races ? episodes / races : 0,
      scEpisodesPerRace: races ? scEpisodes / races : 0,
      lapsPerRace: races ? laps / races : 0,
      episodes,
      scEpisodes,
      laps,
      durationLaps: { SC: median(durations.SC), VSC: median(durations.VSC) },
      durations,
      scGapRatio: median(gapRatios),
      gapRatioEpisodes: gapRatios.length,
    },
    transitions,
    optionalStops: {
      n: optionalLeft.length,
      lapsLeftQ10: lowerQuantile(optionalLeft, 0.1),
      lapsLeftQ25: lowerQuantile(optionalLeft, 0.25),
      lapsLeftMedian: lowerQuantile(optionalLeft, 0.5),
      lapsLeft: [...optionalLeft].sort((a, b) => a - b),
    },
    maxRaceLaps,
  };
}

/**
 * computePriors output in the shape and rounding of PRIORS (4 decimals for
 * degradation, 3 for lap noise / fresh delta / SC gap ratio, 2 for stint-life
 * sigma, laps per race and the lap-noise prior weight nu0): what
 * scripts/mc_benchmark.mjs prints and the
 * priors test compares with PRIORS.
 *
 * @param {Object} priors - computePriors result
 * @returns {Object}
 */
export function roundPriors(priors) {
  const r = (v, d) => (v == null ? v : Number(v.toFixed(d)));
  const sc = priors.safetyCar;
  const op = priors.optionalStops;
  return {
    races: priors.races,
    degradation: Object.fromEntries(Object.entries(priors.degradation).map(([c, d]) => [c, {
      mean: r(d.mean, 4), median: r(d.median, 4), stdDev: r(d.stdDev, 4), n: d.n, negativeCount: d.negativeCount,
      raceMean: r(d.raceMean, 4), withinSd: r(d.withinSd, 4), betweenSd: r(d.betweenSd, 4),
      races: d.races, minFitLaps: d.minFitLaps,
    }])),
    lapNoise: {
      value: r(priors.lapNoise.value, 3),
      stints: priors.lapNoise.stints,
      dry: { value: r(priors.lapNoise.dry.value, 3), nu0: r(priors.lapNoise.dry.nu0, 2), races: priors.lapNoise.dry.races },
      wet: { value: r(priors.lapNoise.wet.value, 3), nu0: r(priors.lapNoise.wet.nu0, 2), races: priors.lapNoise.wet.races },
    },
    freshDelta: { value: r(priors.freshDelta.value, 3), stints: priors.freshDelta.stints },
    stintLife: Object.fromEntries(Object.entries(priors.stintLife).map(([c, x]) => [c, {
      median: x.median, sigma: r(x.sigma, 2), n: x.n, events: x.events,
    }])),
    safetyCar: {
      episodesPerRace: r(sc.episodesPerRace, 4),
      scEpisodesPerRace: r(sc.scEpisodesPerRace, 4),
      lapsPerRace: r(sc.lapsPerRace, 2),
      durationLaps: sc.durationLaps,
      scGapRatio: r(sc.scGapRatio, 3),
      gapRatioEpisodes: sc.gapRatioEpisodes,
    },
    transitions: priors.transitions,
    optionalStops: {
      n: op.n, lapsLeftQ10: op.lapsLeftQ10, lapsLeftQ25: op.lapsLeftQ25, lapsLeftMedian: op.lapsLeftMedian,
    },
  };
}
