/**
 * Undercut and "pit in k laps": ONE projection of the coming laps, shared by
 * the Undercut Calculator (undercutSweep) and the Circle of Doom (pitInLaps).
 *
 * Base: the Circle of Doom's "pit now" window (circleOfDoom.js
 * pitWindowContext): every running car's last line crossing, its recent pace
 * (median of its last 5 clean laps), its stop in progress (pending loss), its
 * last lap, the pit-loss median and the lap-aware rank (1 + the cars that
 * complete the same lap earlier). The window projects every car at that
 * constant pace up to its target lap A: the end of the focus car's out-lap
 * when it pits at the end of the lap it is running.
 *
 * After lap A every lap adds the change in lap time of the engine's lap model
 * (raceSimulation.js projectLapTimes, the formula of every simulation):
 *   lap time(l) = pace                              l <= A
 *   lap time(l) = pace + model(l)                   l > A
 *   model on the set in use, tyre age t:   deg x (t - tA)
 *   model on a set fitted later, age t:    deg' x t - deg x tA  (+ freshDelta on
 *                                          the first flying lap, ages 2..FRESH_TYRE_LAPS)
 * deg, deg' = degradationFor(raceParams, compound): this race's per-stint fits
 * by compound (fuel-corrected, s per lap of tyre age; negative fits kept) or
 * the labelled prior; freshDelta = raceParams.freshDelta (<= 0; the race's or
 * the prior, raceParams.estimates.freshDelta); tA = the age the set in use
 * would have on lap A. So every lap after A costs the degradation of the lap
 * of tyre age it adds, and a new set starts from the pace without the wear
 * the old set had by lap A (with a negative fit that wear is negative: the
 * model then makes a new set slower, as the Monte Carlo engine does).
 * Stops: the stop is charged the pit-loss median (as the window); the
 * out-lap's normal time is the in-lap's (the pit loss is measured as in-lap +
 * out-lap - 2 x ONE median lap of the driver, utils/pitLoss.js), so the
 * fresh-tyre gain starts on the first flying lap.
 * With nothing after lap A every number is the window's: k = 0 of pitInLaps is
 * pitWindow exactly (same crossings, same rank, same rejoin offset).
 *
 * Other cars: they keep their sets (no stop) unless `rivalsStop`: then each
 * car not already stopping changes its set on the lap it reaches the median
 * life of its compound given the age it has reached (stint-life survival,
 * raceSimulation.js stintLifeFor + conditionalMedianLife: this race's
 * Kaplan-Meier, past its data the prior's tail), charged the pit-loss median.
 * A car with a stop in progress at sessionNow (pit entry passed) is already
 * charged by the window (pending loss); its new set follows the same model.
 * A pit-lane visit with no tyre change (a drive-through,
 * a pass through the pits under SC) is not a stop: once its pit exit has
 * passed with no new stint (stints.js), the car keeps its set (no new set, no
 * fresh-tyre delta, TyreLife continues); its time in the pit lane is the
 * window's pending loss. Whether the pit exit has passed is read causally
 * (tyreStates: a PitOutTime at or before sessionNow, never a later row's).
 * The compound fitted at a stop: likelyNextCompound (this race's tyre changes
 * from that compound, else the cached races', the two-dry-compound rule).
 *
 * Undercut sweep (undercutSweep): every candidate in-lap of
 * the focus is compared over ONE fixed horizon, the race end (the last lap
 * both cars complete), with the rival's stop scheduled in every row. A plan
 * is feasible only when each of its stints is within the
 * STINT_FEASIBLE_QUANTILE stint length of its compound (stint-life survival);
 * a longer stint is charged an extra stop (the pit-loss median, and the lap
 * model's new set), for the focus and for the rival alike.
 *
 * Model assumptions (stated in the help text): no traffic (no time lost
 * behind another car, no DRS), the paces of the window, linear tyre wear by
 * compound, the fuel effect of utils/degradation.js (an assumption) inside
 * the fits, no safety car.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  projectLapTimes, degradationFor, stintLifeFor, conditionalMedianLife, PRIORS, FRESH_TYRE_LAPS,
} from './raceSimulation';
import { pitWindowContext, rankByCrossing, gapSeconds } from './circleOfDoom';
import {
  completedLaps, hasPitIn, hasPitOut, pitInSeconds, pitOutSeconds,
} from './raceTime';
import { stintsByDriver } from './stints';
import { driverStateAt } from './driverState';

/**
 * Largest k of the "pit in k laps" stepper (k = 0..PIT_IN_LAPS_MAX). A range
 * of the control (the Circle of Doom work plan, Task 4), not a model value.
 */
export const PIT_IN_LAPS_MAX = 10;

/**
 * Candidate in-laps of the Undercut Calculator: the lap in progress and the
 * next UNDERCUT_SWEEP_LAPS laps. A range of the table (how many rows are
 * displayed), not a model value: every row is read at the race end whatever
 * the table length.
 */
export const UNDERCUT_SWEEP_LAPS = 15;

/**
 * Stint-length feasibility of the undercut sweep. MODELLING
 * CHOICE, not a value read off data: a set may run up to the tyre age by
 * which STINT_FEASIBLE_QUANTILE of the sets of its compound have been changed
 * (the 90th percentile of the stint-life survival, raceSimulation.js
 * stintLifeFor: this race's Kaplan-Meier, past its data the prior's tail); a
 * plan with a longer stint is charged an extra stop.
 */
export const STINT_FEASIBLE_QUANTILE = 0.9;

const DRY_COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD'];
const DRY = new Set(DRY_COMPOUNDS);
const WET = new Set(['INTERMEDIATE', 'WET']);

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compoundKey(c) {
  const s = c == null ? '' : String(c).trim().toUpperCase();
  return s || 'UNKNOWN';
}

/**
 * Tyre state of every driver with a completed lap at sessionNow.
 *  - compound / tyreAge: the set of the latest completed lap and its age at
 *    the end of that lap (TyreLife; without one, the laps of the current
 *    stint): where the lap model starts (lapIncrements, from the next lap);
 *  - current: the set the car has on at sessionNow and its TyreLife
 *    (driverState.js driverStateAt, R3 / R6: the new set from the pit exit,
 *    the in-lap's in the pit lane): what a view shows;
 *  - fitted: the set fitted at a stop in progress once the pit exit has
 *    passed (the stint in force started after the latest completed lap),
 *    else null: the compound and age the model uses for that car's new set;
 *  - inPitLane: the latest pit event passed at sessionNow is an entry (the
 *    in-lap's PitInTime, or one on the lap in progress) with no pit exit
 *    passed after it; read causally from the pit times at or before
 *    sessionNow only (a later row's PitOutTime is never read: pitLaneNow);
 *  - lapsCompleted, used, stints: the lap number, the compounds of the
 *    stints so far and their number (stints.js; a tyre change adds one).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {Map<string, {driver: string, compound: string, tyreAge: number,
 *   current: {compound: string, tyreLife: number|null},
 *   fitted: {compound: string, tyreLife: number|null}|null, inPitLane: boolean,
 *   lapsCompleted: number, used: string[], stints: number}>}
 */
export function tyreStates(lapTimes, sessionNow = Infinity) {
  const last = new Map();
  for (const lt of completedLaps(lapTimes, sessionNow)) {
    const n = toNum(lt?.LapNumber);
    if (!lt?.Driver || n == null) continue;
    const prev = last.get(lt.Driver);
    if (!prev || n > toNum(prev.LapNumber)) last.set(lt.Driver, lt);
  }
  // the row of each driver's lap in progress (its pit times are read only up to sessionNow)
  const running = new Map();
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    const l = last.get(lt?.Driver);
    if (l && toNum(lt.LapNumber) === toNum(l.LapNumber) + 1) running.set(lt.Driver, lt);
  }
  const stints = last.size ? stintsByDriver(lapTimes, { sessionNow }) : {};
  const out = new Map();
  for (const [driver, lt] of last) {
    const list = stints[driver] || [];
    const cur = list[list.length - 1];
    const n = toNum(lt.LapNumber);
    const age = toNum(lt.TyreLife) ?? (cur ? n - cur.StartLap + 1 : n);
    const ds = driverStateAt(lapTimes, driver, sessionNow, { stints });
    const current = {
      compound: compoundKey(ds.compound ?? lt.Compound),
      tyreLife: ds.compound != null ? ds.tyreLife : age,
    };
    const fitted = ds.stint && Number(ds.stint.StartLap) > n
      ? { compound: compoundKey(ds.compound), tyreLife: ds.tyreLife }
      : null;
    out.set(driver, {
      driver,
      compound: compoundKey(lt.Compound),
      tyreAge: age,
      current,
      fitted,
      // in the pit lane at sessionNow, causally (pitLaneNow)
      inPitLane: pitLaneNow(lt, running.get(driver), sessionNow),
      lapsCompleted: n,
      used: [...new Set(list.map((s) => compoundKey(s.Compound)))],
      stints: list.length,
    });
  }
  return out;
}

/**
 * In the pit lane at sessionNow, from the pit times passed by then only: the
 * latest of the last completed lap's pit entry (an in-lap), the pit exit and
 * the pit entry of the lap in progress (each counted once it is at or before
 * sessionNow) is an entry. A pit exit not yet passed is never read, so a
 * later row cannot change the answer (R3: the visit lasts until its exit).
 *
 * @param {Object} lastRow - the driver's last completed lap
 * @param {Object} [nextRow] - the driver's lap in progress
 * @param {number} now - session seconds
 * @returns {boolean}
 */
function pitLaneNow(lastRow, nextRow, now) {
  const events = [];
  if (hasPitIn(lastRow)) events.push({ t: pitInSeconds(lastRow) ?? -Infinity, entry: true });
  if (nextRow && hasPitOut(nextRow)) {
    const t = pitOutSeconds(nextRow);
    if (t != null && t <= now) events.push({ t, entry: false });
  }
  if (nextRow && hasPitIn(nextRow)) {
    const t = pitInSeconds(nextRow);
    if (t != null && t <= now) events.push({ t, entry: true });
  }
  if (!events.length) return false;
  events.sort((a, b) => a.t - b.t);
  return events[events.length - 1].entry;
}

/**
 * Compound fitted at a stop from `compound`: among the dry compounds (only
 * those not used yet when the driver has used fewer than two dry compounds in
 * a dry race with a mandatory stop: the sporting rule, not in a sprint), the
 * one this race has fitted most often
 * after `compound` (raceParams.transitions), else the cached races'
 * (PRIORS.transitions); with no count at all, the hardest. Wet compounds stay
 * (the weather is not forecast). The same rule as the Monte Carlo engine's
 * stops (raceSimulation.js).
 *
 * @param {Object} raceParams - extractRaceParams result (transitions, dryRace, mandatoryStop)
 * @param {string} compound
 * @param {string[]} [used] - compounds used so far
 * @returns {string}
 */
export function likelyNextCompound(raceParams, compound, used = []) {
  const c = compoundKey(compound);
  if (WET.has(c)) return c;
  const usedDry = new Set([...used, c].map(compoundKey).filter((x) => DRY.has(x)));
  const mustChange = raceParams?.dryRace !== false && raceParams?.mandatoryStop !== false && usedDry.size < 2;
  const candidates = DRY_COMPOUNDS.filter((x) => !mustChange || !usedDry.has(x));
  if (!candidates.length) return c;
  const order = [...candidates].reverse();
  for (const table of [raceParams?.transitions?.[c], PRIORS.transitions?.[c]]) {
    if (!table) continue;
    let best = null;
    let bestCount = 0;
    for (const x of order) {
      const n = table[x] || 0;
      if (n > bestCount) { best = x; bestCount = n; }
    }
    if (best) return best;
  }
  return order[0];
}

/**
 * Likely stop of a car that keeps its set: the in-lap on which the set
 * reaches the median life of its compound given the age it has reached
 * (conditionalMedianLife of stintLifeFor). inLap null when the table never
 * gets that low (the set runs to the flag) or the set is older than every life
 * it allows.
 *
 * @param {Object} raceParams
 * @param {{compound: string, tyreAge: number, lapsCompleted: number}} tyre - tyreStates row
 * @returns {{inLap: number|null, dueAge: number|null, source: string, n: number}}
 */
export function likelyStop(raceParams, tyre) {
  const life = stintLifeFor(raceParams, tyre.compound);
  const due = conditionalMedianLife(life.survival, tyre.tyreAge);
  const inLap = due != null && Number.isFinite(due) ? tyre.lapsCompleted + (due - tyre.tyreAge) : null;
  return {
    inLap, dueAge: due, source: life.source, n: life.n,
  };
}

/**
 * The longest feasible stint of a compound: the tyre age by
 * which STINT_FEASIBLE_QUANTILE of its sets are changed, read off its
 * stint-life survival (stintLifeFor; the smallest age t with S[t] <= 1 -
 * STINT_FEASIBLE_QUANTILE). Infinity when the table never gets that low.
 *
 * @param {Object} raceParams
 * @param {string} compound
 * @returns {{laps: number, source: string, n: number}}
 */
export function feasibleStintLength(raceParams, compound) {
  const life = stintLifeFor(raceParams, compound);
  const S = life.survival || [];
  const level = 1 - STINT_FEASIBLE_QUANTILE;
  for (let t = 0; t < S.length; t++) {
    if (S[t] <= level + 1e-12) return { laps: t, source: life.source, n: life.n };
  }
  return { laps: Infinity, source: life.source, n: life.n };
}

/**
 * Extra stops a plan needs to keep every stint feasible up to lap H
 * (feasibleStintLength): the set in use from lap fromLap (age `age` at the
 * end of the lap before), then a new set after each planned stop. A set in
 * use with an age beyond its feasible length is changed at the end of the lap
 * it reaches it (the lap in progress at the earliest); a new set whose stint
 * to the next stop (or to H) is too long is split into equal stints. Each
 * extra stop fits likelyNextCompound.
 *
 * @returns {Array<{lap: number, compound: string, extra: true}>} in-laps
 */
function extraStops(raceParams, start, fromLap, planned, H, used) {
  const usedSet = new Set([...(used || []), start.compound].map(compoundKey));
  const out = [];
  let cur = { compound: start.compound, age: start.age, from: fromLap };
  const bounds = [...planned.filter((st) => st.lap >= fromLap && st.lap < H).sort((a, b) => a.lap - b.lap),
    { lap: H, end: true }];
  for (const b of bounds) {
    let { compound: c, age, from } = cur;
    const last = b.lap;
    for (let guard = 0; guard < 100 && from <= last; guard++) {
      const limit = feasibleStintLength(raceParams, c).laps;
      if (!Number.isFinite(limit) || age + (last - from + 1) <= limit) break;
      let stopLap;
      if (age === 0) {
        const len = last - from + 1;
        stopLap = from - 1 + Math.ceil(len / Math.ceil(len / Math.max(1, limit)));
      } else {
        stopLap = Math.max(from, from - 1 + (limit - age));
      }
      if (stopLap >= last || stopLap + 1 > H) break;
      const nc = likelyNextCompound(raceParams, c, [...usedSet]);
      out.push({ lap: stopLap, compound: nc, extra: true });
      usedSet.add(nc);
      from = stopLap + 1;
      age = 0;
      c = nc;
    }
    if (b.end) break;
    usedSet.add(compoundKey(b.compound));
    cur = { compound: b.compound, age: 0, from: b.lap + 1 };
  }
  return out;
}

/**
 * Lap-time changes of one car after the anchor lap, under the engine's lap
 * model (module header): one row per lap from fromLap to toLap, delta = 0 up
 * to anchorLap, then model(l); an out-lap repeats its in-lap's delta.
 *
 * @param {Object} p
 * @param {Object} p.raceParams - extractRaceParams result
 * @param {string} p.compound - set in use on fromLap
 * @param {number} p.tyreAge - its age at the end of the lap before fromLap
 * @param {boolean} [p.newSet=false] - the set in use was fitted after the pace was measured
 * @param {string} [p.refCompound=compound] - the set the pace was measured on
 * @param {number} p.refAge - its age on the anchor lap (tA)
 * @param {number} p.fromLap
 * @param {number} p.toLap
 * @param {number} p.anchorLap - the window's target lap (A)
 * @param {Array<{lap: number, compound: string}>} [p.stops] - in-laps (an in-lap before
 *   fromLap makes fromLap an out-lap)
 * @returns {{total: number, laps: Array<{lap: number, delta: number, tyreAge: number,
 *   compound: string, inLap: boolean, outLap: boolean}>}} seconds
 */
export function lapIncrements({
  raceParams, compound, tyreAge, newSet = false, refCompound, refAge, fromLap, toLap, anchorLap, stops = [],
}) {
  if (!(toLap >= fromLap)) return { total: 0, laps: [] };
  const rows = projectLapTimes({
    raceParams, compound, tyreAge, basePace: 0, refAge, refCompound: refCompound ?? compound, newSet,
    fromLap, toLap, stops,
  });
  const inLaps = new Set(stops.map((s) => Math.round(Number(s.lap))));
  let total = 0;
  let prev = 0;
  const laps = rows.map((r) => {
    const outLap = inLaps.has(r.lap - 1);
    let delta;
    if (r.lap <= anchorLap) delta = 0;
    else if (outLap) delta = prev;
    else delta = r.lapTime;
    prev = delta;
    total += delta;
    return {
      lap: r.lap, delta, tyreAge: r.tyreAge, compound: r.compound, inLap: inLaps.has(r.lap), outLap,
    };
  });
  return { total, laps };
}

/** Prefix sums of lapIncrements rows: lap -> total of the deltas up to that lap. */
function cumulative(laps) {
  const out = new Map();
  let s = 0;
  for (const r of laps) {
    s += r.delta;
    out.set(r.lap, s);
  }
  return out;
}

/**
 * The model's plan of one car from the window: its tyre state, the stop in
 * progress (stage) or the stop it is given, and the increments to toLap.
 * With opts.feasibleTo = H, the extra stops that keep every stint feasible up
 * to lap H (extraStops, D2) are added to the plan.
 * Returns { at(lap) (sum of the deltas from its lap in progress to `lap`),
 * lossAt(lap, loss) (the pit losses of the stops the window does not charge,
 * completed by `lap`: the stop given when it is new, every extra stop),
 * extraLossAt(lap, loss) (the extra stops only: a focus car's stop is in the
 * window's pending loss already),
 * stopInLap, newStop (a stop the window does not charge), nextCompound,
 * extraStops, stops (every in-lap from the lap in progress), laps }.
 */
function carPlan(raceParams, proj, tyre, anchorLap, toLap, stopInLap, { feasibleTo = null } = {}) {
  const n = proj.car.lapsCompleted;
  if (!tyre) {
    return {
      at: () => 0, lossAt: () => 0, extraLossAt: () => 0, stopInLap: null, newStop: false, nextCompound: null,
      extraStops: [], stops: [], laps: [],
    };
  }
  // A stop in progress whose pit exit has passed: the set already fitted (R3),
  // never a guess; otherwise the likely compound of the next set. A pit-lane
  // visit whose exit has passed with no new set (no new stint: a drive-through,
  // a repair) is no tyre change (R2: stops are tyre changes): the car keeps
  // its set; its time in the pit lane is the window's pending loss
  const fitted = proj.stage === 'out-lap' && tyre.fitted ? tyre.fitted : null;
  const keptSet = proj.stage === 'out-lap' && !tyre.fitted && !tyre.inPitLane;
  const next = fitted ? fitted.compound : likelyNextCompound(raceParams, tyre.compound, tyre.used);
  const refAge = tyre.tyreAge + (anchorLap - n);
  let stops = [];
  let newStop = false;
  let inLap = null;
  if (proj.stage === 'in-lap') {
    inLap = n + 1;
  } else if (keptSet) {
    inLap = null;
  } else if (proj.stage === 'out-lap') {
    inLap = n;
  } else if (stopInLap != null) {
    inLap = Math.max(n + 1, Math.round(stopInLap));
    newStop = true;
  }
  if (inLap != null) stops = [{ lap: inLap, compound: next }];
  // On its out-lap the car is on the new set from its lap in progress (a used
  // set fitted: its age at the start of the out-lap, TyreLife of the out-lap - 1)
  const fittedAge = fitted && toNum(fitted.tyreLife) != null ? Math.max(0, toNum(fitted.tyreLife) - 1) : 0;
  const onNewSet = proj.stage === 'out-lap' && !keptSet;
  const start = onNewSet ? { compound: next, age: fittedAge } : { compound: tyre.compound, age: tyre.tyreAge };
  const extra = feasibleTo != null
    ? extraStops(raceParams, start, n + 1, stops, feasibleTo, onNewSet ? [...tyre.used, next] : tyre.used)
    : [];
  const all = [...stops, ...extra].sort((a, b) => a.lap - b.lap);
  const base = {
    raceParams, refCompound: tyre.compound, refAge, fromLap: n + 1, toLap, anchorLap, stops: all,
  };
  const inc = lapIncrements({ ...base, compound: start.compound, tyreAge: start.age, newSet: onNewSet });
  const sums = cumulative(inc.laps);
  // stops the window does not charge: the stop given (newStop) and every extra stop
  const charged = [...(newStop ? [inLap] : []), ...extra.map((x) => x.lap)];
  return {
    at: (lap) => (lap <= n ? 0 : (sums.get(Math.min(lap, toLap)) ?? 0)),
    lossAt: (lap, loss) => loss * charged.filter((l) => l + 1 <= lap).length,
    extraLossAt: (lap, loss) => loss * extra.filter((x) => x.lap + 1 <= lap).length,
    stopInLap: inLap,
    newStop,
    nextCompound: inLap != null ? next : null,
    extraStops: extra,
    stops: all.filter((x) => x.lap >= n + 1),
    laps: inc.laps,
  };
}

function unavailableResult(reason, extra = {}) {
  return {
    available: false, reason, rows: [], kMax: 0, ...extra,
  };
}

/**
 * "Pit in k laps" of the focus car (Circle of Doom, Task 4), k = 0..kMax:
 * the focus stays out k more laps on its set, boxes at the end of lap
 * (lap in progress + k) and rejoins at the end of the next one, target lap
 * m_k = A + k. Every car's crossing of m_k is the window's projection plus the
 * lap model after lap A (module header); the rank is the window's
 * (rankByCrossing). k = 0 is pitWindow exactly. kMax = PIT_IN_LAPS_MAX at
 * most, and m_k never past the focus car's last lap; 0 while the focus is
 * already stopping.
 *
 * positionIfPitNow = the focus's place at the end of lap m_k when it pits now
 * instead (k laps on the new set, freshDelta on the first flying one);
 * positionsVsNow = positionIfPitNow - predictedPosition (+n: waiting k laps
 * ends n places better at lap m_k than pitting now; -n: n places worse);
 * secondsVsNow = the focus's crossing of m_k pitting in k laps minus pitting
 * now (positive: waiting costs time).
 * Ghost marker: rejoinSeconds = the window's rejoin seconds plus the time the
 * k laps take the focus beyond k reference laps (the ring turns once per
 * reference lap), ghostOffset = rejoinSeconds / reference lap (a phase, back
 * from the focus car, as pitWindow's rejoinOffset).
 *
 * @param {string} focus - driver code
 * @param {Object} state - circleState result
 * @param {Object} [pitLoss] - estimatePitLoss result at the same sessionNow
 * @param {Object} raceParams - extractRaceParams at the same sessionNow
 * @param {Object} [opts] - pitWindow options plus
 * @param {boolean} [opts.rivalsStop=false] - the other cars stop when their sets are due
 * @param {number} [opts.maxK=PIT_IN_LAPS_MAX]
 * @returns {{available: boolean, reason?: string, kMax: number, rivalsStop: boolean,
 *   nextCompound: string|null, anchorLap: number, rows: Array<{k: number, inLap: number,
 *   targetLap: number, predictedCrossing: number, predictedPosition: number,
 *   positionIfPitNow: number, positionsVsNow: number, secondsVsNow: number,
 *   rejoinSeconds: number, ghostOffset: number, rivalStops: string[]}>}}
 */
export function pitInLaps(focus, state, pitLoss, raceParams, opts = {}) {
  const ctx = pitWindowContext(focus, state, pitLoss, opts);
  if (ctx.error) return unavailableResult(ctx.error.reason);
  const rivalsStop = !!opts.rivalsStop;
  const {
    st, f, car, ref, lossMedian, others, targetLap: A, finalLap, ongoingStop,
  } = ctx;
  const tyres = tyreStates(st.lapTimes, st.sessionNow);
  const fTyre = tyres.get(focus) || null;
  const cap = Math.max(0, Math.trunc(toNum(opts.maxK) ?? PIT_IN_LAPS_MAX));
  const kMax = ongoingStop || !fTyre ? 0 : Math.max(0, Math.min(cap, (finalLap ?? Infinity) - A));
  const horizon = A + kMax;
  const n = car.lapsCompleted;

  // Other cars, planned once up to the horizon
  const plans = others.map((o) => {
    const tyre = tyres.get(o.driver) || null;
    const due = rivalsStop && !o.p.stage && tyre ? likelyStop(raceParams, tyre).inLap : null;
    const plan = carPlan(raceParams, o.p, tyre, A, horizon, due);
    return { o, plan };
  });
  const otherAt = ({ o, plan }, m) => {
    if (o.lastLap != null && m > o.lastLap) return Infinity;
    return o.p.crossing(m, o.pending + plan.lossAt(m, lossMedian)) + plan.at(m);
  };

  // The focus pitting now, followed to the horizon (positionIfPitNow)
  const nowPlan = carPlan(raceParams, f, fTyre, A, horizon, ongoingStop ? null : n + 1);
  const focusPending = ctx.focusPending(lossMedian);
  const predicted0 = ctx.predictedAt(lossMedian) + nowPlan.at(A);
  const rows = [];
  for (let k = 0; k <= kMax; k++) {
    const m = A + k;
    const times = plans.map((p) => otherAt(p, m));
    const plan = k === 0 ? nowPlan : carPlan(raceParams, f, fTyre, A, m, n + 1 + k);
    const crossing = f.crossing(m, focusPending) + plan.at(m);
    const pitNowCrossing = f.crossing(m, focusPending) + nowPlan.at(m);
    const predictedPosition = rankByCrossing(crossing, times);
    const positionIfPitNow = rankByCrossing(pitNowCrossing, times);
    const rejoinSeconds = focusPending + ((crossing - predicted0) - k * ref);
    rows.push({
      k,
      inLap: ongoingStop ? (f.stage === 'out-lap' ? n : n + 1) : n + 1 + k,
      targetLap: m,
      predictedCrossing: crossing,
      predictedPosition,
      positionIfPitNow,
      positionsVsNow: positionIfPitNow - predictedPosition,
      secondsVsNow: crossing - pitNowCrossing,
      rejoinSeconds,
      ghostOffset: rejoinSeconds / ref,
      rivalStops: plans.filter((p) => p.plan.newStop && p.plan.stopInLap + 1 <= m).map((p) => p.o.driver),
    });
  }
  return {
    available: true,
    focus,
    kMax,
    rivalsStop,
    ongoingStop,
    anchorLap: A,
    currentPosition: car.position,
    nextCompound: nowPlan.nextCompound,
    tyre: fTyre,
    freshDelta: toNum(raceParams?.freshDelta) ?? 0,
    freshDeltaInfo: raceParams?.estimates?.freshDelta || null,
    degradation: fTyre ? {
      current: { compound: fTyre.compound, ...degradationFor(raceParams, fTyre.compound) },
      next: nowPlan.nextCompound ? { compound: nowPlan.nextCompound, ...degradationFor(raceParams, nowPlan.nextCompound) } : null,
    } : null,
    rows,
  };
}

/**
 * Undercut sweep of the Undercut Calculator: for every
 * candidate in-lap p of the focus car (the lap in progress and the next
 * UNDERCUT_SWEEP_LAPS: how many rows are displayed), both cars projected
 * (module header) over ONE fixed horizon H, the race end: the last lap both
 * cars complete (min of their last laps, circleOfDoom.js lastLapOfCar); H
 * never depends on the table length or on the rival's stop. Without a race
 * distance (a live feed with no lap count) H falls back to the end of the
 * latest out-lap of the table (horizon.source 'table').
 * The rival's stop q is scheduled in every row: its stop in progress, else
 * opts.rivalStopLap (a choice of the view), else its likely stop (likelyStop:
 * stint-life survival). A choice is no longer one once its
 * lap is not in the future of the rival (q < its lap in progress) or the
 * rival has changed tyres since it was made (opts.rivalStopStints, the
 * rival's stint count then, differs from now): rivalStop.expiredChoice
 * records it, and the likely stop is used.
 * Feasibility (D2): every stint of either car's plan up to H must be within
 * its compound's feasible length (feasibleStintLength,
 * STINT_FEASIBLE_QUANTILE of the stint-life survival); a longer stint is
 * charged an extra stop (extraStops: the pit-loss median plus the lap model's
 * new set), listed per row (extraStops) and for the rival (rivalStop.extraStops).
 * With no traffic in the model the rival's crossing of H does not depend on
 * p, so the rows differ only by the focus's plan: the best row is the
 * focus's fastest way to the flag, the in-lap that balances the wear of the
 * sets over the whole remaining race (linear wear: deg_old x age at the stop
 * = deg_new x laps from the stop to H, plus the fresh-tyre delta and any
 * extra stop).
 *
 * gap = rival's crossing of H - focus's (seconds; positive: the focus ahead,
 * the same sign as currentGap = gapSeconds(focus, rival), the latest lap both
 * have completed); change = gap - currentGap (signed gain over now). best =
 * the row with the largest gap (the earliest on a tie). freshGain = the
 * focus's first flying lap on a new set (pitting now) against the same lap on
 * the old set: old - new, positive = the new set is faster (the per-lap
 * undercut of the model).
 *
 * @param {string} focus
 * @param {string} rival
 * @param {Object} state - circleState result
 * @param {Object} [pitLoss] - estimatePitLoss result at the same sessionNow
 * @param {Object} raceParams - extractRaceParams at the same sessionNow
 * @param {Object} [opts] - pitWindow options plus { rivalStopLap, rivalStopStints, sweepLaps }
 * @returns {Object} { available, reason?, rows: [{ inLap, k, outLap, horizonLap,
 *   focusCrossing, rivalCrossing, gap, change, extraStops: [{ lap, compound }] }], best,
 *   currentGap, anchorLap, horizonLap, horizon: { lap, source ('race-end' | 'table') },
 *   rivalStop: { inLap, source ('in progress' | 'chosen' | 'race' | 'prior' | 'none'),
 *   dueAge, inRace, extraStops, expiredChoice?, expiredReason? ('past' | 'tyre-change') },
 *   feasibility: { quantile, focus: { current, next }, rival: { current, next } } (laps),
 *   pitLoss, focusTyre, rivalTyre, nextCompound, rivalNextCompound, freshGain, freshDelta,
 *   freshDeltaInfo, freshTyreLaps, degradation }
 */
export function undercutSweep(focus, rival, state, pitLoss, raceParams, opts = {}) {
  const ctx = pitWindowContext(focus, state, pitLoss, opts);
  if (ctx.error) return unavailableResult(ctx.error.reason);
  if (!rival || rival === focus) return unavailableResult('no-rival');
  const o = ctx.others.find((x) => x.driver === rival);
  if (!o) return unavailableResult('rival-not-running');
  if (ctx.ongoingStop) return unavailableResult('focus-stopping');
  const {
    st, f, car, lossMedian, targetLap: A, finalLap,
  } = ctx;
  const tyres = tyreStates(st.lapTimes, st.sessionNow);
  const fTyre = tyres.get(focus) || null;
  const rTyre = tyres.get(rival) || null;
  if (!fTyre || !rTyre) return unavailableResult('no-tyre-data');
  const n = car.lapsCompleted;
  const nr = o.p.car.lapsCompleted;
  const lastF = finalLap ?? Infinity;
  const lastR = o.lastLap ?? Infinity;
  const sweep = Math.max(0, Math.trunc(toNum(opts.sweepLaps) ?? UNDERCUT_SWEEP_LAPS));

  // The rival's stop, in both branches (D4: a choice in the rival's past, or
  // made before a tyre change of the rival, is no longer a choice)
  const chosenLap = toNum(opts.rivalStopLap) != null ? Math.round(toNum(opts.rivalStopLap)) : null;
  const chosenStints = toNum(opts.rivalStopStints);
  let expiredReason = null;
  if (chosenLap != null) {
    if (o.p.stage || chosenLap < nr + 1) expiredReason = 'past';
    else if (chosenStints != null && chosenStints !== rTyre.stints) expiredReason = 'tyre-change';
  }
  let rivalStop;
  if (o.p.stage) {
    rivalStop = { inLap: o.p.stage === 'in-lap' ? nr + 1 : nr, source: 'in progress', dueAge: null };
  } else if (chosenLap != null && !expiredReason) {
    rivalStop = { inLap: chosenLap, source: 'chosen', dueAge: null };
  } else {
    const s = likelyStop(raceParams, rTyre);
    rivalStop = s.inLap != null
      ? { inLap: s.inLap, source: s.source, dueAge: s.dueAge }
      : { inLap: null, source: 'none', dueAge: s.dueAge };
  }
  if (chosenLap != null && rivalStop.source !== 'chosen') {
    rivalStop.expiredChoice = chosenLap;
    rivalStop.expiredReason = expiredReason || 'past';
  }
  // Both cars' last lap: no row and no rival stop past it
  const cap = Math.min(lastF, lastR);
  rivalStop.inRace = rivalStop.inLap != null && rivalStop.inLap + 1 <= cap;
  const q = rivalStop.inRace ? rivalStop.inLap : null;
  // ONE horizon for every row (D2): the race end; the table's end only without a race distance
  const raceEnd = Number.isFinite(cap);
  const H = raceEnd ? cap : Math.max(n + 1 + sweep, q ?? -Infinity) + 1;
  const pMax = Math.min(n + 1 + sweep, H - 1);
  if (pMax < n + 1) return unavailableResult('last-lap');

  const rPlan = carPlan(raceParams, o.p, rTyre, A, H, q != null && !o.p.stage ? q : null, { feasibleTo: H });
  rivalStop.extraStops = rPlan.extraStops.map(({ lap, compound }) => ({ lap, compound }));
  const rivalCrossing = o.p.crossing(H, o.pending + rPlan.lossAt(H, lossMedian)) + rPlan.at(H);
  const focusPending = ctx.focusPending(lossMedian);
  const currentGap = gapSeconds(focus, rival, st);

  const rows = [];
  for (let p = n + 1; p <= pMax; p++) {
    const plan = carPlan(raceParams, f, fTyre, A, H, p, { feasibleTo: H });
    // the stop at p is the window's pending loss; the extra stops are charged here
    const focusCrossing = f.crossing(H, focusPending + plan.extraLossAt(H, lossMedian)) + plan.at(H);
    const gap = rivalCrossing - focusCrossing;
    rows.push({
      inLap: p,
      k: p - (n + 1),
      outLap: p + 1,
      horizonLap: H,
      focusCrossing,
      rivalCrossing,
      gap,
      change: currentGap != null ? gap - currentGap : null,
      nextCompound: plan.nextCompound,
      extraStops: plan.extraStops.map(({ lap, compound }) => ({ lap, compound })),
    });
  }
  const best = rows.reduce((b, r) => (b == null || r.gap > b.gap ? r : b), null);

  // Per-lap undercut of the model: first flying lap on the new set (pit now) vs the old set
  const flying = A + 1;
  const nowPlan = carPlan(raceParams, f, fTyre, A, flying, n + 1);
  const stayPlan = carPlan(raceParams, f, fTyre, A, flying, null);
  const freshGain = stayPlan.at(flying) - stayPlan.at(A) - (nowPlan.at(flying) - nowPlan.at(A));
  const nextCompound = likelyNextCompound(raceParams, fTyre.compound, fTyre.used);
  const rivalNext = rPlan.nextCompound ?? likelyNextCompound(raceParams, rTyre.compound, rTyre.used);

  return {
    available: rows.length > 0,
    reason: rows.length ? undefined : 'last-lap',
    focus,
    rival,
    rows,
    best,
    currentGap,
    anchorLap: A,
    horizonLap: rows.length ? H : null,
    horizon: { lap: H, source: raceEnd ? 'race-end' : 'table' },
    rivalStop,
    feasibility: {
      quantile: STINT_FEASIBLE_QUANTILE,
      focus: {
        current: feasibleStintLength(raceParams, fTyre.compound).laps,
        next: feasibleStintLength(raceParams, nextCompound).laps,
      },
      rival: {
        current: feasibleStintLength(raceParams, rTyre.compound).laps,
        next: feasibleStintLength(raceParams, rivalNext).laps,
      },
    },
    pitLoss: { median: lossMedian, n: ctx.est.n, source: ctx.est.source },
    focusTyre: fTyre,
    rivalTyre: rTyre,
    nextCompound,
    rivalNextCompound: rPlan.nextCompound,
    freshGain,
    freshDelta: toNum(raceParams?.freshDelta) ?? 0,
    freshDeltaInfo: raceParams?.estimates?.freshDelta || null,
    freshTyreLaps: FRESH_TYRE_LAPS,
    degradation: {
      focus: degradationFor(raceParams, fTyre.compound),
      rival: degradationFor(raceParams, rTyre.compound),
    },
  };
}
