/**
 * Circle of Doom: one lap drawn as a circle measured in SECONDS (not metres),
 * plus the "pit now" window of a focus car and its rejoin probabilities.
 *
 * Geometry. The top of the circle is the timing line. A car's phase is the
 * time since its anchor (normally its last line crossing) divided by the
 * reference lap, so the angular distance between two cars is their time gap.
 * The layout is cyclic because the lap is: a car just before the line sits
 * next to a car just past it, where a linear axis would break.
 *   phase = clamp((sessionNow - anchorTime) / refLap, 0, 0.999)
 *   angle = phase * 2 * PI, radians, clockwise from the top: in SVG
 *   coordinates x = cx + r * sin(angle), y = cy - r * cos(angle) (d3.arc uses
 *   the same convention).
 * A car whose current lap is longer than the reference lap (Safety Car, VSC,
 * a slow lap) stops at 0.999 with `saturated: true`: the reference lap is a
 * green-flag lap, so under SC the second part of the lap piles up at the line.
 * Analytics never use the clamped value: gaps and ranks come from crossing
 * times.
 *
 * Out-lap anchor. A stopping car crosses the line inside the pit lane: its
 * in-lap ends there and its out-lap starts there, well before the pit exit.
 * A car whose last completed lap is an in-lap and whose out-lap PitOutTime <=
 * sessionNow (the out-lap has started but is not complete) is anchored at its
 * pit exit: it leaves the pit lane at the line (phase 0) and then runs at the
 * reference lap; no estimator of where the exit is on the lap. A row without a
 * PitOutTime (live feed) keeps the line anchor. opts.outLapAnchor 'line'
 * anchors the out-lap at that crossing instead (anchorTime =
 * lastCrossingTime): the car then leaves the pit lane drawn a fraction of a
 * lap ahead of where it is, and waits at 0.999 for the line while its slow
 * out-lap ends. It is kept for the comparison of the two anchors in
 * frontend/scripts/cod_ring_check.mjs; the default is 'pitExit'. Only the
 * drawn ring moves with the anchor (the phases, and the pit window's band read
 * off it: focusPhase, bandSeconds, trafficOnly): the race order (the car keeps
 * its place until it crosses the line), gaps, ranks, the window's projections,
 * lists and rejoin point, and circleStateKey all use lastCrossingTime. Every
 * row also carries elapsed (seconds since the line), pitExitTime (that pit
 * exit, or null), sincePitExit (seconds since that pit exit) and linePhase =
 * wrap(elapsed / refLap), unclamped: where the car is on the ring by its line
 * time.
 *
 * Clock. Every time is SESSION seconds (raceTime.js header): lap Time (lap
 * end), LapStartTime, PitInTime / PitOutTime, and sessionNow = replay frame.t
 * (store.currentTime) + sessionTimeOffset (store getSessionNow,
 * hooks/useSessionNow). Causal rule: only laps completed at sessionNow (Time
 * <= sessionNow) and pit entries already passed (PitInTime <= sessionNow)
 * are read; nothing from a later lap leaks in (tested by perturbing every
 * future row). sessionNow = Infinity (race over, live mode) shows every car at
 * its final crossing (phase 0) and has no pit window.
 *
 * Reference lap (referenceLap). Median LapTimeSeconds of every driver's
 * completed green laps (TrackStatus '1', raceTime.isGreenLap) that are neither
 * in-laps nor out-laps, lap > 1, 0 < time < 200 s (the pitLoss.js filters),
 * among the last 5 laps completed by the leader; while fewer than 10 laps
 * qualify the window grows one lap back at a time (under SC it reaches back to
 * the last green laps). With no qualifying lap at all (lap 1 only, or no green
 * lap yet): source 'fallback', the median of every completed lap without a pit
 * entry or exit, any track status, lap 1 included; with no completed lap:
 * source 'none', seconds null (no ring yet).
 *
 * Race order and lap offsets (lap-aware). Car X is ahead of Y when X has
 * completed more laps, or the same number of laps earlier. X is k laps down on
 * Y when Y has passed it k times on track: with d = laps(Y) - laps(X) > 0,
 * k = d - (Y crossed the line after X ? 1 : 0). gapSeconds(a, b) is the time b
 * crossed the line after a on the latest lap both have completed, so a lapped
 * car's gap holds its whole laps (more than one lap time).
 * Before its first crossing a car has no line time of its own (its
 * lastCrossingTime is the shared lap-1 start), so the cars still on lap 1 are
 * ordered by the last lap-1 timing point they have passed at sessionNow (end
 * of sector 2, then of sector 1: SectorNSessionTime <= sessionNow, the earlier
 * first), then by grid slot (opts.gridPositions, race_results GridPosition;
 * 0 = pit-lane start, after every slot). Over the 30 cached races, 1, 5 and
 * 15 s after the first crossing, this order matches the order in which those
 * cars then cross the line for 82.8 % of the places (994), mean error 0.26
 * places (grid only: 38.1 %; a one-off check over the cached races).
 * A car on lap 1 whose place the data leave open (no timing point passed and
 * no grid slot, or tied with another car on every key) has position null.
 *
 * Pit window (pitWindow). "Pit now" = the focus car boxes at the end of the
 * lap it is running (the in-lap), so the stop is fully paid at the end of the
 * out-lap, lap m = lapsCompleted + 2. No window before the focus car's first
 * crossing (reason 'first-lap': the projection starts from its own line time).
 * A rival still on lap 1 has no line time either (its lastCrossingTime is the
 * shared race start): its lap-1 crossing is projected as the end of its lap-1
 * sector 2 (Sector2SessionTime <= sessionNow) plus the median lap-1 sector 3
 * (Time - Sector2SessionTime) of the cars already across; while a running car
 * on lap 1 has not reached the end of sector 2, no window ('field-on-lap-one'),
 * at the latest until the leader completes lap 2 (a car stuck on lap 1 then
 * keeps the start-based projection). None once the leader has taken the
 * chequered flag (every running car finishes at its next crossing), nor when
 * lap m is past the focus car's own last lap: a car k laps down on the leader
 * (lapOffsetToLeader) takes the flag at the end of lap raceLaps - k at most,
 * one lap earlier when the leader, projected at its recent pace, reaches the
 * flag before the car's projected crossing of that lap. As in
 * backend/scripts/validate_pit_loss_and_rejoin.py:
 *   predictedCrossing = lastCrossingTime + 2 * pace + pitLoss.median
 *   predictedPosition = 1 + #(other cars that complete lap m before it)
 * (the script: T_pred = Time(n - 1) + 2 * green median + loss, ranked against
 * the lap n + 1 crossings, 71 % exact / 88 % within one place on 709 green
 * stops). lastCrossingTime + elapsedSinceCrossing + pitLoss.median is the time
 * the car is back at the point of the lap where it is now (the rejoin point on
 * the ring); carried on to the line at the car's pace it is exactly
 * predictedCrossing, which does not move within a lap.
 * A car that has completed lap m is ranked by its actual crossing. A car that
 * has not is ranked by its projected crossing
 *   lastCrossingTime + (m - lapsCompleted) * its own recent pace + its pending pit loss
 * recent pace = median of its last 5 completed clean laps (green, no pit
 * entry or exit, lap > 1, 0 < time < 200 s); without one, the reference lap.
 * Pending pit loss: the median loss when its pit entry has passed and its
 * in-lap is still running; on its out-lap, the median loss minus what its
 * in-lap already lost over its pace (never below 0); else 0. A stop not
 * started at sessionNow is unknown: the window assumes the other cars do not
 * stop before the focus completes its out-lap.
 * Every rival has its own last lap, by the same rule as the focus car (its
 * lap offset to the leader, and the leader's projected flag against its own
 * projected crossings): a rival that takes the chequered flag before lap m
 * never completes it and is not counted ahead (crossing Infinity), as the
 * script counts only the cars with a lap n + 1 Time.
 * Backtest (frontend/scripts/cod_backtest.mjs, docs/evidence/cod_backtest.txt,
 * 709 green stops of 30 races, prediction at the end of lap n - 1): fed the
 * script's inputs, rankByCrossing gives the script's 71 % exact / 88 % within
 * one place; the causal window gives 46.7 % / 72.8 %. The gap is the rivals'
 * own stops on laps n and n + 1, which the script reads from the rivals' actual
 * lap n + 1 times: on the 406 stops where no such unseen stop (or later
 * retirement) puts a rival on the other side, 76.4 % / 92.4 % (script 78.3 % /
 * 93.8 %).
 * "Pit in k laps" (utils/undercut.js pitInLaps) builds on this window
 * (pitWindowContext): the window's constant paces up to its target lap, the
 * engine's lap model after it; k = 0 is this window exactly.
 *
 * Neutralised track (SC, VSC, red; opts.trackFlag): pit loss, paces and the
 * reference lap stay green-flag figures (a validated SC / VSC pit-loss
 * estimator does not exist yet), so the window reports neutralised: true and
 * the view must say the numbers are green-flag ones.
 *
 * Race order and the threshold lists. "Ahead in the race" is always the race
 * order above (aheadInRace: more laps completed, or as many and earlier across
 * the line), never the sign of a gap: the gap on the latest lap both cars have
 * completed is stale for a car in the middle of its own stop (it led at that
 * line, pitted, and is now behind on the road).
 *
 * Undercut threshold (from UndercutCalculator.jsx). The calculator's
 * threshold asks whether a gap can be covered by a pit stop, gap < pit loss
 * (pitLoss.median), with equal paces and "same lap" = lapOffset 0. The gap is
 * gapSeconds (the latest lap both completed) plus, for a rival in the middle
 * of its own stop, the part of that stop the lap does not hold yet
 * (stopNotInGap: the whole loss when its in-lap ends after that lap, the loss
 * still to pay when that lap is its in-lap):
 *   wouldPassFocus       = same-lap cars behind the focus in the race whose gap,
 *                          once their own stop in progress is paid, is less
 *                          than the pit loss: the places a stop now costs.
 *   wouldDropBehindFocus = same-lap cars ahead of the focus in the race by less
 *                          than the pit loss before any stop of theirs in
 *                          progress: the cars that would drop behind it if THEY
 *                          pitted (the undercut threshold).
 * A car on one side of the race order whose gap says the other side (it
 * changed place on track since that lap) counts 0 s. The rule assumes equal
 * paces, so it can disagree with predictedPosition, which projects each car
 * at its own recent pace. The fresh-tyre gain needs the degradation model, so
 * it belongs to the "pit in k laps" projection and the undercut sweep
 * (utils/undercut.js), not here.
 *
 * Traffic at the predicted rejoin. The rejoin point carried on to the line is
 * predictedCrossing, so the traffic flag is read there, on the same
 * projections as the rank: the latest line crossing (any lap, actual or
 * projected with its pending loss, up to each car's own last lap) of another
 * running car before predictedCrossing is the car ahead; flag when it is less
 * than 1.0 s ahead: the focus would rejoin in its dirty air / DRS range.
 * carAhead is reported flagged or not, with carAheadLaps = target lap - the
 * lap that car completes there (1: one lap down on the focus, -1: one lap up).
 * It depends on the memo key only (no clamped phase), so it never changes
 * between two events. On the backtest's 709 stops it flags 15.0 % of them
 * (in the data 17.8 % end their out-lap less than 1.0 s behind a car), 31 %
 * of the flags right, 26 % of those cases flagged; the drawn-ring reading it
 * replaces flagged 18.2 %, 24 % right, 25 % found (rival stops not yet
 * started are unknown to both).
 *
 * Rejoin point of a stop under way (ongoingStop). Its rejoin point is placed
 * from the car's line time, wrap((sessionNow - lastCrossingTime - pending) /
 * refLap): where the car will be on the ring once the loss still to pay is
 * paid, the point that, carried on to the line at its pace, is
 * predictedCrossing. Neither its anchor at the pit exit nor its hold at 0.999
 * moves it.
 *
 * Lapped traffic in the band (trafficOnly) is read off the ring as the view
 * draws it: phases clamped at 0.999, cars in the pit lane (drawn on the
 * pit-lane segment inside the ring) and finished cars left out. Ring seconds from car b forward to car a: the
 * difference of their anchors while both move, else of their drawn
 * positions (phase x refLap) when one sits at 0.999. ringRelations(win, state)
 * recomputes it (and the phases of the band) for the cars of any frame;
 * pitWindow uses the same code, so pitWindow(focus, frame) = { ...a window of
 * the same memo key, ...ringRelations(that window, frame) }.
 *   trafficOnly = cars inside the band (the ring arc from the focus as drawn
 *                 back to the rejoin point: bandSeconds = the pending loss,
 *                 less the time from the line to the pit exit for a car
 *                 anchored there, never below 0; a focus held at 0.999 keeps
 *                 that length from where it is drawn) that are not on the focus's
 *                 lap: laps = lapOffset(focus, car), label '1L' (one lap down on
 *                 the focus) or '-1L' (one lap up); a car not yet passed (lapOffset
 *                 0) but ahead of the focus in the race is about to lap it:
 *                 laps -1. They never change place with the focus. A same-lap
 *                 car behind in the race (e.g. on its out-lap) is a rival, not
 *                 traffic.
 *
 * Probabilities (rejoinProbabilities, rejoinDistribution). 1000 draws (seeded,
 * deterministic) of the pit loss: a bootstrap of the race's measured stops
 * (pitLoss.samples) or, with source 'fallback', normal(22, 2.5)
 * (FALLBACK_PIT_LOSS); each draw re-ranks the focus and re-reads the traffic
 * flag at its own predicted crossing. Other cars keep the median for their
 * own pending loss. The draws carry the pit-loss uncertainty
 * only, not unseen rival stops nor pace (backtest: the actual position gets a
 * mean probability of 0.452 over all stops, 0.825 when no rival stops).
 *
 * Memoisation. The rank, the threshold lists, the traffic flag and the
 * position and traffic probabilities depend only on what is known at
 * sessionNow, i.e. on circleMemoKey: the focus, circleStateKey (completed laps
 * and pit events = strategyViews.causalKey, track-status events when given,
 * and during lap 1 the timing points passed by the cars not yet across) and
 * the pit loss. It changes on those events only, never with the frame. A view
 * memoises circleState on circleStateKey and pitWindow / rejoinDistribution
 * on circleMemoKey, moves the cars every frame with phaseAt(car, sessionNow,
 * refLap), and reads the band and the lapped traffic in it off the ring of
 * each frame with ringRelations (no rank or draw is repeated). The drawn ring
 * moves rigidly (every phase grows at the same rate) except while some cars
 * sit at 0.999 and others do not; only then does the band's lapped traffic
 * change between two events.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  isLapCompleted, isGreenLap, hasPitIn, hasPitOut, pitInSeconds, pitOutSeconds, lapEndTime, lapStartTime,
  leaderLapEndTime,
} from './raceTime';
import { estimatePitLoss, FALLBACK_PIT_LOSS } from './pitLoss';
import { driverStateAt, nonFinisherMap } from './driverState';
import { stintsByDriver } from './stints';
import { causalKey } from './strategyViews';

/** Reference lap: last laps completed by the leader, and the samples wanted. */
export const REF_WINDOW_LAPS = 5;
export const REF_MIN_SAMPLES = 10;
/** Laps of a car's own recent pace. */
export const PACE_WINDOW_LAPS = 5;
/** Largest phase drawn (a phase of 1 would be the line again). */
export const PHASE_MAX = 0.999;
/** Traffic: rejoin less than this many seconds behind a car on track. */
export const TRAFFIC_GAP_S = 1.0;
/** Pit-loss draws of the rejoin probabilities. */
export const DEFAULT_PROBABILITY_SAMPLES = 1000;

// Track-status codes of a neutralised track: '4' SC, '5' red, '6' VSC deployed,
// '7' VSC ending (raceTime.isGreenLap)
const NEUTRALISED_FLAGS = new Set(['4', '5', '6', '7']);
// Lap-time filter, same value as pitLoss.js and the validation script
const MAX_LAP_S = 200;
// Numeric guard on a drawn loss (normal fallback tail), as the Monte Carlo sampler
const MIN_LOSS_GUARD_S = 5;
const DEFAULT_SEED = 1;
const TWO_PI = 2 * Math.PI;

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normaliseNow(sessionNow) {
  return sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Phase folded into [0, 1). */
export function wrapPhase(p) {
  return p - Math.floor(p);
}

/**
 * A completed lap usable as a pace sample: green, no pit entry or exit, lap > 1, 0 < time < 200 s.
 * The reference lap, the recent paces and the sector fractions (circleSectors.js) use it.
 *
 * @param {Object} lt - one lap_times row
 * @returns {boolean}
 */
export function isCleanLap(lt) {
  const t = toNum(lt?.LapTimeSeconds);
  return toNum(lt?.LapNumber) > 1 && t != null && t > 0 && t < MAX_LAP_S
    && isGreenLap(lt) && !hasPitIn(lt) && !hasPitOut(lt);
}

// lapTimes -> Map driver -> { rows (sorted by LapNumber, one per lap, the last
// row wins), byLap }. The rows of a session never change.
const _index = new WeakMap();

function driverIndex(lapTimes) {
  if (!Array.isArray(lapTimes)) return new Map();
  if (_index.has(lapTimes)) return _index.get(lapTimes);
  const by = new Map();
  for (const lt of lapTimes) {
    if (!lt?.Driver) continue;
    const n = toNum(lt.LapNumber);
    if (n == null) continue;
    if (!by.has(lt.Driver)) by.set(lt.Driver, new Map());
    by.get(lt.Driver).set(n, lt);
  }
  const out = new Map();
  for (const drv of [...by.keys()].sort()) {
    const byLap = by.get(drv);
    const rows = [...byLap.entries()].sort((a, b) => a[0] - b[0]).map(([, lt]) => lt);
    out.set(drv, { rows, byLap });
  }
  _index.set(lapTimes, out);
  return out;
}

/** Highest LapNumber of the table: the race distance (known before the start). */
function lastLapOf(lapTimes) {
  let last = 0;
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    const n = toNum(lt?.LapNumber);
    if (n != null && n > last) last = n;
  }
  return last;
}

/**
 * Reference lap at sessionNow: median of every driver's completed green
 * non-pit laps (lap > 1) among the last 5 laps completed by the leader; the
 * window grows back one lap at a time until it holds at least 10 laps (or
 * reaches lap 2). Fallbacks: see the module header.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @returns {{seconds: number|null, nSamples: number, laps: [number, number]|null,
 *   source: 'race'|'fallback'|'none'}} seconds; laps = [from, to] lap numbers used
 */
export function referenceLap(lapTimes, { sessionNow = Infinity } = {}) {
  const now = normaliseNow(sessionNow);
  const done = [];
  let leaderLaps = 0;
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt || !isLapCompleted(lt, now)) continue;
    const n = toNum(lt.LapNumber);
    if (n == null) continue;
    done.push(lt);
    if (n > leaderLaps) leaderLaps = n;
  }
  if (!leaderLaps) return { seconds: null, nSamples: 0, laps: null, source: 'none' };

  const cleanByLap = new Map();
  for (const lt of done) {
    if (!isCleanLap(lt)) continue;
    const n = toNum(lt.LapNumber);
    if (!cleanByLap.has(n)) cleanByLap.set(n, []);
    cleanByLap.get(n).push(toNum(lt.LapTimeSeconds));
  }
  let from = Math.max(2, leaderLaps - REF_WINDOW_LAPS + 1);
  const samples = [];
  for (let n = from; n <= leaderLaps; n++) samples.push(...(cleanByLap.get(n) || []));
  while (samples.length < REF_MIN_SAMPLES && from > 2) {
    from -= 1;
    samples.push(...(cleanByLap.get(from) || []));
  }
  if (samples.length) {
    return { seconds: median(samples), nSamples: samples.length, laps: [from, leaderLaps], source: 'race' };
  }

  const any = done
    .filter((lt) => !hasPitIn(lt) && !hasPitOut(lt))
    .map((lt) => toNum(lt.LapTimeSeconds))
    .filter((t) => t != null && t > 0 && t < MAX_LAP_S);
  if (any.length) {
    return { seconds: median(any), nSamples: any.length, laps: [1, leaderLaps], source: 'fallback' };
  }
  return { seconds: null, nSamples: 0, laps: null, source: 'none' };
}

/** Seconds of a refLap argument: a number, or a referenceLap result. */
function refSecondsOf(refLap) {
  const s = typeof refLap === 'number' ? refLap : toNum(refLap?.seconds);
  return s != null && s > 0 ? s : null;
}

/** Out-lap anchors of phases(): the line crossing or the pit exit (the default; module header). */
export const OUT_LAP_ANCHORS = Object.freeze(['line', 'pitExit']);

/**
 * Phase and angle of one car at sessionNow (cheap: for per-frame updates of a
 * memoised circleState). Finished cars and sessionNow = Infinity sit at 0.
 * The phase counts from car.anchorTime (lastCrossingTime when absent). On a
 * row that carries linePhase (every phases() row) it also refreshes linePhase
 * and sincePitExit.
 *
 * @param {{lastCrossingTime: number, anchorTime?: number, pitExitTime?: number|null,
 *   finished?: boolean}} car - a phases() row
 * @param {number} sessionNow - session seconds
 * @param {number|Object} refLap - seconds, or a referenceLap result
 * @returns {{elapsed: number, phase: number|null, angle: number|null, saturated: boolean,
 *   linePhase?: number|null, sincePitExit?: number|null}}
 *   elapsed = seconds since the line; phase null without a reference lap;
 *   linePhase = wrap(elapsed / refLap) (null without a reference lap);
 *   sincePitExit = seconds since car.pitExitTime (null without one)
 */
export function phaseAt(car, sessionNow, refLap) {
  const now = normaliseNow(sessionNow);
  const ref = refSecondsOf(refLap);
  const still = car?.finished || now === Infinity;
  const elapsed = still ? 0 : Math.max(0, now - car.lastCrossingTime);
  const anchor = toNum(car?.anchorTime) ?? car?.lastCrossingTime;
  const sinceAnchor = still ? 0 : Math.max(0, now - anchor);
  let out;
  if (ref == null) {
    out = { elapsed, phase: null, angle: null, saturated: false };
  } else {
    const raw = sinceAnchor / ref;
    const phase = Math.min(PHASE_MAX, Math.max(0, raw));
    out = { elapsed, phase, angle: phase * TWO_PI, saturated: raw > PHASE_MAX };
  }
  if (car && 'linePhase' in car) {
    const exit = toNum(car.pitExitTime);
    out.linePhase = ref == null ? null : wrapPhase(elapsed / ref);
    out.sincePitExit = still || exit == null ? null : Math.max(0, now - exit);
  }
  return out;
}

/**
 * Phase of a car by its line time, wrap((sessionNow - lastCrossingTime) /
 * refLap): its linePhase when the row carries one, else from sessionNow.
 */
function linePhaseOf(car, sessionNow, ref) {
  if (typeof car.linePhase === 'number') return car.linePhase;
  const now = normaliseNow(sessionNow);
  if (car.finished || now === Infinity) return 0;
  return wrapPhase(Math.max(0, now - car.lastCrossingTime) / ref);
}

/**
 * Pit exit of the out-lap a car is running at now: its last completed row is
 * an in-lap and the next row's PitOutTime has passed (not before that line
 * crossing); else null (no row, no PitOutTime yet, finished).
 */
function pitExitOf(last, byLap, lastCrossingTime, finished, now) {
  if (finished || !last || !hasPitIn(last)) return null;
  const next = byLap.get(toNum(last.LapNumber) + 1);
  const exit = next && hasPitOut(next) ? pitOutSeconds(next) : null;
  return exit != null && exit <= now && exit >= lastCrossingTime ? exit : null;
}

/**
 * Laps `b` is down on `a` (negative: `b` is that many laps up), from the lap
 * counts and the last crossings (module header).
 */
function lapsBehind(a, b) {
  const d = a.lapsCompleted - b.lapsCompleted;
  if (d > 0) return d - (a.lastCrossingTime > b.lastCrossingTime ? 1 : 0);
  if (d < 0) return d + (b.lastCrossingTime > a.lastCrossingTime ? 1 : 0);
  return 0;
}

/**
 * `a` is ahead of `b` in the race order of phases(): more laps completed, or
 * as many and across the line earlier. Two cars still on lap 1 are not
 * compared here (no line time of their own): false.
 */
function aheadInRace(a, b) {
  if (a.lapsCompleted !== b.lapsCompleted) return a.lapsCompleted > b.lapsCompleted;
  return a.lapsCompleted > 0 && a.lastCrossingTime < b.lastCrossingTime;
}

// Grid key of a pit-lane start: after every grid slot
const PIT_LANE_START = 1000;

function compareNumbers(x, y) {
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * Lap-1 progress of a car not yet across the line, for its race order:
 * the last lap-1 timing point passed at now (2 = end of sector 2, 1 = end of
 * sector 1, 0 = none) and when; its grid slot (Infinity when unknown).
 */
function lapOneKey(lapOne, gridSlot, now) {
  let point = 0;
  let at = null;
  for (const k of [2, 1]) {
    const t = toNum(lapOne?.[`Sector${k}SessionTime`]);
    if (t != null && t <= now) {
      point = k;
      at = t;
      break;
    }
  }
  const g = toNum(gridSlot);
  let grid = Infinity;
  if (g != null && g >= 1) grid = g;
  else if (g === 0) grid = PIT_LANE_START;
  return { point, at, grid };
}

function compareLapOne(a, b) {
  return (b.point - a.point)
    || (a.point ? compareNumbers(a.at, b.at) : 0)
    || compareNumbers(a.grid, b.grid);
}

/**
 * Every running car on the circle at sessionNow, in race order.
 *
 * lastCrossingTime = the largest lap Time <= sessionNow; before a car's first
 * crossing, its lap-1 LapStartTime (the race start). Cars not yet across are
 * ordered by their lap-1 progress, then grid slot (module header); position
 * null when the data leave the place open. Retired cars
 * (driverStateAt.retired: known once the final row has ended or the car has
 * entered the pits for good) are dropped. inPitLane (driverStateAt: pit entry
 * passed, pit exit not yet) marks a car in the pit lane (the view draws the
 * cars in the lane on its pit-lane segment). finished = took
 * the chequered flag (crossed the line after the leader completed the race's
 * last lap): phase 0. anchorTime = where the phase counts from (module header:
 * the pit exit of an out-lap under way, unless outLapAnchor is 'line', else
 * lastCrossingTime); pitExitTime = that pit exit whatever the anchor, or null.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {number|Object} [opts.refLap] - seconds or a referenceLap result; computed when omitted
 * @param {Object} [opts.dnfMap] - store.dnfMap (results' non-finishers); inferred from the rows otherwise
 * @param {Object} [opts.gridPositions] - { driver: grid slot } (race_results GridPosition,
 *   0 = pit-lane start): orders the cars not yet across the line once their lap-1 timing points tie
 * @param {boolean} [opts.includeRetired=false] - keep retired cars (after the running ones, position null)
 * @param {boolean} [opts.isLiveMode=false] - live feed rows: retirements from the feed's dnfMap
 *   only (driverState.js nonFinisherMap), and no chequered flag (the rows' latest lap is
 *   not the race's last one), so no car is `finished`
 * @param {'line'|'pitExit'} [opts.outLapAnchor='pitExit'] - where an out-lap's phase counts
 *   from (module header); 'line' only for the ring check's comparison
 * @returns {Array<{driver: string, position: number|null, lapsCompleted: number,
 *   lastCrossingTime: number, anchorTime: number, pitExitTime: number|null, elapsed: number,
 *   phase: number|null, angle: number|null, saturated: boolean, inPitLane: boolean,
 *   retired: boolean, finished: boolean, lapOffsetToLeader: number,
 *   linePhase: number|null, sincePitExit: number|null}>} times in session seconds,
 *   elapsed / sincePitExit in seconds, angle in radians
 */
export function phases(lapTimes, {
  sessionNow = Infinity, refLap, dnfMap, gridPositions, includeRetired = false, isLiveMode = false,
  outLapAnchor = 'pitExit',
} = {}) {
  if (!OUT_LAP_ANCHORS.includes(outLapAnchor)) {
    throw new Error(`phases: outLapAnchor must be one of ${OUT_LAP_ANCHORS.join(', ')}`);
  }
  const atPitExit = outLapAnchor === 'pitExit';
  const now = normaliseNow(sessionNow);
  const idx = driverIndex(lapTimes);
  if (!idx.size) return [];
  const ref = refLap != null ? refSecondsOf(refLap) : referenceLap(lapTimes, { sessionNow: now }).seconds;
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap, { live: isLiveMode });
  const stints = stintsByDriver(lapTimes, { sessionNow: now });
  const lastLap = isLiveMode ? 0 : lastLapOf(lapTimes);
  const flagAt = lastLap > 0 ? leaderLapEndTime(lapTimes, lastLap) : null;
  const flag = flagAt != null && flagAt <= now ? flagAt : null;

  const running = [];
  const retired = [];
  // Lap-1 progress of the cars not yet across the line (race order only)
  const lapOne = new Map();
  for (const [driver, { rows, byLap }] of idx) {
    const st = driverStateAt(lapTimes, driver, now, { stints, dnf: !!nonFinishers[driver] });
    if (st.retired && !includeRetired) continue;
    const last = st.lastCompleted;
    const lastCrossingTime = last ? lapEndTime(last) : lapStartTime(rows[0]);
    if (lastCrossingTime == null) continue;
    const finished = flag != null && last != null && lastCrossingTime >= flag;
    const pitExitTime = pitExitOf(last, byLap, lastCrossingTime, finished, now);
    const car = {
      driver,
      position: null,
      lapsCompleted: st.lapsCompleted,
      lastCrossingTime,
      anchorTime: atPitExit && pitExitTime != null ? pitExitTime : lastCrossingTime,
      pitExitTime,
      inPitLane: st.inPitLane,
      retired: st.retired,
      finished,
      lapOffsetToLeader: 0,
      linePhase: null,
    };
    Object.assign(car, phaseAt(car, now, ref));
    if (!car.lapsCompleted) lapOne.set(driver, lapOneKey(byLap.get(1), gridPositions?.[driver], now));
    (st.retired ? retired : running).push(car);
  }
  const order = (a, b) => (b.lapsCompleted - a.lapsCompleted)
    || (a.lapsCompleted
      ? a.lastCrossingTime - b.lastCrossingTime
      : compareLapOne(lapOne.get(a.driver), lapOne.get(b.driver)))
    || (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0);
  running.sort(order);
  retired.sort(order);
  const leader = running[0];
  running.forEach((car, i) => {
    car.position = i + 1;
    car.lapOffsetToLeader = lapsBehind(leader, car);
  });
  // A car still on lap 1 whose place the data leave open (no timing point
  // passed and no grid slot, or the same keys as another car): no position
  running.forEach((car, i) => {
    if (car.lapsCompleted) return;
    const key = lapOne.get(car.driver);
    const tied = [running[i - 1], running[i + 1]].some((o) => o && !o.lapsCompleted
      && compareLapOne(key, lapOne.get(o.driver)) === 0);
    if ((!key.point && key.grid === Infinity) || tied) car.position = null;
  });
  for (const car of retired) car.lapOffsetToLeader = leader ? lapsBehind(leader, car) : 0;
  return [...running, ...retired];
}

/**
 * Everything the circle needs at sessionNow: the reference lap and the running
 * cars (phases). The input of gapSeconds, lapOffset, pitWindow and
 * rejoinProbabilities; memoise it on circleMemoKey.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {Object} [opts.dnfMap] - store.dnfMap
 * @param {Object} [opts.gridPositions] - { driver: grid slot } (phases)
 * @param {number|Object} [opts.refLap] - seconds or a referenceLap result; computed when omitted
 * @param {boolean} [opts.isLiveMode=false] - live feed rows (phases)
 * @param {'line'|'pitExit'} [opts.outLapAnchor='pitExit'] - out-lap anchor of the drawn phases (phases)
 * @returns {{sessionNow: number, refLap: Object, cars: Array<Object>, lapTimes: Array<Object>}}
 */
export function circleState(lapTimes, {
  sessionNow = Infinity, dnfMap, gridPositions, refLap, isLiveMode = false, outLapAnchor,
} = {}) {
  const now = normaliseNow(sessionNow);
  let ref;
  if (refLap != null && typeof refLap === 'object') ref = refLap;
  else if (refSecondsOf(refLap) != null) ref = { seconds: refLap, nSamples: 0, laps: null, source: 'given' };
  else ref = referenceLap(lapTimes, { sessionNow: now });
  const cars = phases(lapTimes, {
    sessionNow: now, refLap: ref, dnfMap, gridPositions, isLiveMode, outLapAnchor,
  });
  return { sessionNow: now, refLap: ref, cars, lapTimes: Array.isArray(lapTimes) ? lapTimes : [] };
}

/** A circleState, or one built from opts.lapTimes / opts.sessionNow. */
function ensureState(state, opts = {}) {
  if (state && Array.isArray(state.cars) && Array.isArray(state.lapTimes)) return state;
  return circleState(opts.lapTimes, {
    sessionNow: opts.sessionNow, dnfMap: opts.dnfMap, outLapAnchor: opts.outLapAnchor,
  });
}

function carOf(state, driver) {
  return state.cars.find((c) => c.driver === driver) || null;
}

/** Session time a car completed lap n (n <= its lapsCompleted), or null. */
function crossingOf(state, driver, n) {
  const entry = driverIndex(state.lapTimes).get(driver);
  const row = entry?.byLap.get(n);
  return row ? lapEndTime(row) : null;
}

/**
 * Signed time gap between two cars, seconds: how long after `a` car `b`
 * crossed the line on the latest lap both have completed (positive: b is
 * behind a). Across laps the gap holds the whole laps (a lapped car is more
 * than a lap time behind). null when a car is not on the circle or before both
 * have completed a lap.
 *
 * @param {string} a - driver code
 * @param {string} b - driver code
 * @param {Object} state - circleState result
 * @returns {number|null} seconds
 */
export function gapSeconds(a, b, state) {
  const st = ensureState(state);
  if (!carOf(st, a) || !carOf(st, b)) return null;
  if (a === b) return 0;
  return commonLapGap(st, a, b)?.gap ?? null;
}

/**
 * The latest lap both cars have completed and the gap on it: { lap, gap }
 * (gap = b's crossing - a's, seconds), or null.
 */
function commonLapGap(st, a, b) {
  const A = carOf(st, a);
  const B = carOf(st, b);
  if (!A || !B) return null;
  for (let n = Math.min(A.lapsCompleted, B.lapsCompleted); n >= 1; n--) {
    const ta = crossingOf(st, a, n);
    const tb = crossingOf(st, b, n);
    if (ta != null && tb != null) return { lap: n, gap: tb - ta };
  }
  return null;
}

/**
 * Whole laps `b` is down on `a` (negative: `b` is laps up), as a lap label:
 * 1 = lapped once by a. null when a car is not on the circle.
 *
 * @param {string} a - driver code
 * @param {string} b - driver code
 * @param {Object} state - circleState result
 * @returns {number|null}
 */
export function lapOffset(a, b, state) {
  const st = ensureState(state);
  const A = carOf(st, a);
  const B = carOf(st, b);
  return A && B ? lapsBehind(A, B) : null;
}

/** Lap label of a lap offset: 1 -> '1L', -1 -> '-1L'. */
function lapLabel(k) {
  return `${k}L`;
}

/**
 * A car's pace for projections (seconds per lap):
 *  'recent' (default): median of its last 5 completed clean laps;
 *  'race-median': median of all its completed clean laps;
 *  'reference': the reference lap for everyone.
 * Without a clean lap: the reference lap.
 */
function paceOf(rows, now, refSeconds, model) {
  if (model !== 'reference') {
    const clean = rows.filter((lt) => isLapCompleted(lt, now) && isCleanLap(lt));
    const used = model === 'race-median' ? clean : clean.slice(-PACE_WINDOW_LAPS);
    if (used.length) {
      return { seconds: median(used.map((lt) => toNum(lt.LapTimeSeconds))), source: model || 'recent' };
    }
  }
  return { seconds: refSeconds, source: 'reference' };
}

/**
 * Stop in progress at sessionNow: 'in-lap' (pit entry passed, in-lap still
 * running), 'out-lap' (the last completed lap is an in-lap), or null.
 */
function stopStage(car, byLap, now) {
  if (car.finished) return { stage: null, inLapTime: null };
  const running = byLap.get(car.lapsCompleted + 1);
  const pin = running ? pitInSeconds(running) : null;
  if (pin != null && pin <= now && !isLapCompleted(running, now)) return { stage: 'in-lap', inLapTime: null };
  const last = byLap.get(car.lapsCompleted);
  if (last && hasPitIn(last)) return { stage: 'out-lap', inLapTime: toNum(last.LapTimeSeconds) };
  return { stage: null, inLapTime: null };
}

/** Loss still to pay for a stop at `stage` when a whole stop costs `loss`. */
function pendingLoss(stage, inLapTime, pace, loss) {
  if (stage === 'in-lap') return loss;
  if (stage === 'out-lap') {
    const paid = inLapTime != null ? Math.max(0, inLapTime - pace) : 0;
    return Math.max(0, loss - paid);
  }
  return 0;
}

/**
 * Part of a car's stop in progress that its gap on lap `lap` (a lap it has
 * completed) does not hold yet, equal paces: the whole loss when its in-lap
 * ends after that lap, the loss still to pay (pendingLoss) when that lap is
 * its in-lap; 0 without a stop in progress. p = a projector() result.
 */
function stopNotInGap(p, lap, loss) {
  if (p.stage === 'out-lap' && lap >= p.car.lapsCompleted) return pendingLoss(p.stage, p.inLapTime, p.pace, loss);
  return p.stage ? loss : 0;
}

/**
 * Lap-1 crossings of the running cars still on lap 1 (module header): the end
 * of their lap-1 sector 2 (Sector2SessionTime <= now) plus the median lap-1
 * sector 3 (Time - Sector2SessionTime) of the cars already across.
 * unknown: some car on lap 1 has no such projection (sector 2 not reached, or
 * no car across with both times).
 */
function lapOneProjection(st) {
  const now = st.sessionNow;
  const idx = driverIndex(st.lapTimes);
  const sector3 = [];
  for (const { byLap } of idx.values()) {
    const lapOne = byLap.get(1);
    if (!lapOne || !isLapCompleted(lapOne, now)) continue;
    const s2 = toNum(lapOne.Sector2SessionTime);
    const end = lapEndTime(lapOne);
    if (s2 != null && end != null && end > s2) sector3.push(end - s2);
  }
  const lastSector = median(sector3);
  const eta = new Map();
  let unknown = false;
  for (const c of st.cars) {
    if (c.lapsCompleted || c.finished) continue;
    const s2 = toNum(idx.get(c.driver)?.byLap.get(1)?.Sector2SessionTime);
    if (s2 != null && s2 <= now && lastSector != null) eta.set(c.driver, s2 + lastSector);
    else unknown = true;
  }
  return { eta, unknown };
}

/**
 * Projection of one car: crossing(k, pending) = session time it completes lap k.
 * Completed laps: the actual Time. Later laps: lastCrossingTime + (k - laps) x
 * pace + pending; a car still on lap 1 with a projected lap-1 crossing
 * (lapOneProjection): that crossing + (k - 1) x pace + pending. A finished car
 * never completes a later lap (Infinity).
 */
function projector(car, entry, now, refSeconds, paceModel, lapOneEta = null) {
  const pace = paceOf(entry.rows, now, refSeconds, paceModel);
  const { stage, inLapTime } = stopStage(car, entry.byLap, now);
  const fromLapOne = !car.lapsCompleted && lapOneEta != null;
  const crossing = (k, pending = 0) => {
    if (k <= car.lapsCompleted) {
      const row = entry.byLap.get(k);
      const t = row ? lapEndTime(row) : null;
      return t != null ? t : car.lastCrossingTime - (car.lapsCompleted - k) * pace.seconds;
    }
    if (car.finished) return Infinity;
    if (fromLapOne) return lapOneEta + (k - 1) * pace.seconds + pending;
    return car.lastCrossingTime + (k - car.lapsCompleted) * pace.seconds + pending;
  };
  return { car, pace: pace.seconds, paceSource: pace.source, stage, inLapTime, crossing };
}

/** Number of values of a sorted array strictly below x. */
function countBelow(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Lap-aware rank of a crossing: 1 + the number of other cars that complete
 * the same lap strictly earlier (the validation script's rule). Exported for
 * the backtest, which feeds it the script's own inputs.
 *
 * @param {number} time - session seconds the car completes the lap
 * @param {Array<number>} others - session seconds the other cars complete it
 * @returns {number}
 */
export function rankByCrossing(time, others) {
  let ahead = 0;
  for (const t of others) if (t < time) ahead += 1;
  return 1 + ahead;
}

/**
 * Last lap a running car will complete: its first crossing after the leader's
 * flag. A car k laps down on the leader (lapOffsetToLeader) completes at most
 * raceLaps - k laps, one fewer when the leader, projected at its recent pace,
 * takes the flag before the car's own projected crossing of that lap (it is
 * lapped once more on the way). Stops in progress count at their pending loss.
 */
function lastLapOfCar(car, f, projections, st, raceLaps, lossMedian) {
  let last = raceLaps - Math.max(0, car.lapOffsetToLeader || 0);
  const leader = st.cars.find((c) => c.position === 1);
  if (!leader || leader.driver === car.driver || !(f.pace > 0)) return last;
  const lp = projections.get(leader.driver);
  const flagEta = lp.crossing(raceLaps, pendingLoss(lp.stage, lp.inLapTime, lp.pace, lossMedian));
  if (!Number.isFinite(flagEta)) return last;
  const own = pendingLoss(f.stage, f.inLapTime, f.pace, lossMedian);
  const laps = Math.ceil((flagEta - car.lastCrossingTime - own) / f.pace);
  last = Math.min(last, car.lapsCompleted + Math.max(1, laps));
  return last;
}

function unavailable(focus, reason, extra = {}) {
  return { focus: focus ?? null, available: false, reason, ...extra };
}

/** Pit-loss estimate in use: the given one, else estimatePitLoss at sessionNow. */
function pitLossOf(pitLoss, state) {
  return pitLoss || estimatePitLoss(state.lapTimes, { sessionNow: state.sessionNow });
}

/**
 * Everything pitWindow and the probabilities share: the focus projection, the
 * target lap, the other cars' crossings of it (pending stops at the median).
 */
function windowContext(focus, state, pitLoss, opts = {}) {
  const st = ensureState(state, opts);
  const est = pitLossOf(pitLoss, st);
  const now = st.sessionNow;
  if (!focus) return { error: unavailable(focus, 'no-focus') };
  if (est?.source === 'not-applicable' || toNum(est?.median) == null) {
    return { error: unavailable(focus, 'not-applicable') };
  }
  if (now === Infinity) return { error: unavailable(focus, 'race-over') };
  const ref = refSecondsOf(st.refLap);
  if (ref == null) return { error: unavailable(focus, 'no-reference-lap') };
  const car = carOf(st, focus);
  if (!car) return { error: unavailable(focus, 'not-running') };
  if (car.finished) return { error: unavailable(focus, 'finished') };
  // No line time of its own yet: nothing to project from, no line place
  if (!car.lapsCompleted) return { error: unavailable(focus, 'first-lap') };
  // Rivals still on lap 1: projected from the end of their lap-1 sector 2; none
  // while one has not got there, at most until the leader completes lap 2 (a
  // car stuck on lap 1 then keeps the start-based projection)
  const lapOne = lapOneProjection(st);
  if (lapOne.unknown && (st.cars[0]?.lapsCompleted ?? 0) < 2) {
    return { error: unavailable(focus, 'field-on-lap-one') };
  }
  const raceLaps = toNum(opts.totalLaps) || lastLapOf(st.lapTimes);
  // After the leader's flag every running car finishes at its next crossing
  const flagAt = raceLaps ? leaderLapEndTime(st.lapTimes, raceLaps) : null;
  if (flagAt != null && flagAt <= now) return { error: unavailable(focus, 'chequered-flag') };

  const idx = driverIndex(st.lapTimes);
  const projections = new Map();
  for (const c of st.cars) {
    projections.set(c.driver, projector(c, idx.get(c.driver), now, ref, opts.paceModel, lapOne.eta.get(c.driver)));
  }
  const f = projections.get(focus);
  const ongoingStop = f.stage != null;
  // Pit now: box at the end of the lap in progress; on the out-lap, the stop in progress
  const targetLap = f.stage === 'out-lap' ? car.lapsCompleted + 1 : car.lapsCompleted + 2;
  const lossMedian = toNum(est.median);
  const finalLap = raceLaps ? lastLapOfCar(car, f, projections, st, raceLaps, lossMedian) : null;
  if (finalLap != null && targetLap > finalLap) return { error: unavailable(focus, 'last-lap') };

  const focusPending = (loss) => pendingLoss(f.stage || 'in-lap', f.inLapTime, f.pace, loss);
  const predictedAt = (loss) => f.crossing(targetLap, focusPending(loss));
  const others = [];
  for (const [driver, p] of projections) {
    if (driver === focus) continue;
    const pending = pendingLoss(p.stage, p.inLapTime, p.pace, lossMedian);
    // Its own last lap: a rival that takes the flag before the target lap never completes it
    const lastLap = raceLaps ? lastLapOfCar(p.car, p, projections, st, raceLaps, lossMedian) : null;
    const t = lastLap != null && targetLap > lastLap ? Infinity : p.crossing(targetLap, pending);
    others.push({
      driver, p, pending, lastLap, t,
    });
  }
  const sortedTimes = others.map((o) => o.t).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    st, est, now, ref, car, f, ongoingStop, targetLap, raceLaps, finalLap, lossMedian,
    focusPending, predictedAt, others, sortedTimes,
  };
}

/**
 * The projections pitWindow ranks with, for the projections built on it
 * (utils/undercut.js: "pit in k laps", the undercut sweep): the same object
 * pitWindow and rejoinDistribution use, so a projection that adds nothing to
 * it reproduces the window exactly.
 *
 * @param {string} focus - driver code
 * @param {Object} state - circleState result
 * @param {Object} [pitLoss] - estimatePitLoss result at the same sessionNow
 * @param {Object} [opts] - pitWindow options
 * @returns {Object} { error } (a pitWindow "unavailable" result) or { st, est, now, ref, car, f,
 *   ongoingStop, targetLap, raceLaps, finalLap, lossMedian, focusPending(loss), predictedAt(loss),
 *   others: [{ driver, p, pending, lastLap, t }], sortedTimes }: f and others[].p are
 *   projections { car, pace, paceSource, stage, inLapTime, crossing(lap, pending) }, t the
 *   crossing of targetLap the rank compares (Infinity past the car's last lap), finalLap the
 *   focus car's last lap (null when the race distance is unknown)
 */
export function pitWindowContext(focus, state, pitLoss, opts = {}) {
  return windowContext(focus, state, pitLoss, opts);
}

// Laps of a car's crossings listed for the traffic reading, at most (its next
// laps up to the latest predicted crossing; a safety bound, never reached)
const MAX_TRAFFIC_LAPS = 10;

/**
 * Line crossings of the other running cars from `lo` to `hi` (session
 * seconds), earliest first: the actual Time of a completed lap, the projection
 * (pending loss included) of a later one, each car up to its own last lap.
 */
function crossingsBetween(ctx, lo, hi) {
  const out = [];
  for (const o of ctx.others) {
    const c = o.p.car;
    if (c.finished) continue;
    const last = o.lastLap ?? Infinity;
    const until = Math.min(last, c.lapsCompleted + MAX_TRAFFIC_LAPS);
    for (let k = Math.max(1, c.lapsCompleted - 1); k <= until; k++) {
      const t = o.p.crossing(k, o.pending);
      if (t == null || !Number.isFinite(t) || t >= hi) break;
      if (t >= lo) out.push({ t, driver: o.driver, lap: k });
    }
  }
  return out.sort((a, b) => a.t - b.t || a.driver.localeCompare(b.driver));
}

/**
 * Traffic reader of a window for predicted crossings in [lo, hi]: crossing ->
 * the latest crossing of another car before it, { driver, gapSeconds, lap },
 * or null (module header).
 */
function trafficReader(ctx, lo, hi) {
  const list = crossingsBetween(ctx, lo - 2 * ctx.ref, hi);
  return (crossing) => {
    let a = 0;
    let b = list.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (list[mid].t < crossing) a = mid + 1;
      else b = mid;
    }
    const prev = a > 0 ? list[a - 1] : null;
    return prev ? { driver: prev.driver, gapSeconds: crossing - prev.t, lap: prev.lap } : null;
  };
}

/**
 * Cars on the drawn ring (not the focus, not in the pit lane, not finished)
 * with their ring seconds ahead of the focus car (before wrapping).
 */
function ringAround(st, focusCar, ref) {
  return st.cars
    .filter((c) => c.driver !== focusCar.driver && !c.inPitLane && !c.finished && c.phase != null)
    .map((c) => ({ car: c, ahead: ringSeconds(c, focusCar, ref) }));
}

/** x folded into [0, period). */
function wrapSeconds(x, period) {
  return x - period * Math.floor(x / period);
}

/** Session time a row's phase counts from: anchorTime, else lastCrossingTime. */
function anchorOf(car) {
  return toNum(car.anchorTime) ?? car.lastCrossingTime;
}

/**
 * Ring seconds from car b forward to car a as drawn, before wrapping: the
 * difference of their anchors while both move (exact, the same at every
 * frame), else of their drawn positions (phase x refLap).
 */
function ringSeconds(a, b, ref) {
  if (!a.saturated && !b.saturated) return anchorOf(b) - anchorOf(a);
  return (a.phase - b.phase) * ref;
}

/**
 * Ring seconds of the band from the focus as drawn back to its rejoin point:
 * the pending loss, less the time from the line to the pit exit for a focus
 * anchored there (that part of the stop is already behind the drawn car);
 * never below 0. Constant between two events.
 */
function bandSecondsOf(car, pending) {
  return Math.max(0, pending - (anchorOf(car) - car.lastCrossingTime));
}

/**
 * Lapped / lapping cars inside the band, read off the ring as drawn (module
 * header): the cars at most `band` seconds of ring (bandSecondsOf) behind the
 * focus car that are not on its lap. A same-lap car (lapOffset 0) is about to lap the
 * focus only when it is ahead of it in the race order; behind in the race it
 * is a rival on the focus's lap (e.g. on its own out-lap), not traffic.
 */
function bandTraffic(focusCar, ring, ref, band) {
  const trafficOnly = [];
  for (const { car: c, ahead } of ring) {
    const behind = wrapSeconds(-ahead, ref);
    if (!(behind > 0 && behind <= band)) continue;
    let laps = lapsBehind(focusCar, c);
    if (laps === 0) {
      if (!aheadInRace(c, focusCar)) continue;
      laps = -1;
    }
    trafficOnly.push({ driver: c.driver, laps, label: lapLabel(laps) });
  }
  return trafficOnly.sort((a, b) => a.driver.localeCompare(b.driver));
}

/** Traffic flag of a reading of trafficReader (module header). */
function trafficOf(ahead, targetLap) {
  return {
    flag: !!ahead && ahead.gapSeconds < TRAFFIC_GAP_S,
    carAhead: ahead?.driver ?? null,
    gapSeconds: ahead?.gapSeconds ?? null,
    carAheadLaps: ahead ? targetLap - ahead.lap : null,
    thresholdSeconds: TRAFFIC_GAP_S,
  };
}

/**
 * "Pit now" window of the focus car at the state's sessionNow.
 *
 * @param {string} focus - driver code
 * @param {Object} state - circleState result (or opts.lapTimes / opts.sessionNow to build one)
 * @param {Object} [pitLoss] - estimatePitLoss result at the same sessionNow; computed when omitted
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.lapTimes] - used when state is not a circleState
 * @param {number} [opts.sessionNow] - used when state is not a circleState
 * @param {number} [opts.totalLaps] - race distance; default the highest LapNumber of the table
 * @param {'recent'|'race-median'|'reference'} [opts.paceModel='recent'] - projection pace
 * @param {string} [opts.trackFlag] - track-status code in force at sessionNow (store
 *   flagAtClock); '4' / '5' / '6' / '7' set neutralised
 * @returns {Object} when the window cannot be computed: { focus, available: false, reason }
 *   with reason 'no-focus' | 'not-applicable' (not a race session) | 'race-over' |
 *   'no-reference-lap' | 'not-running' (retired or unknown) | 'finished' |
 *   'first-lap' (the focus has not crossed the line yet) |
 *   'field-on-lap-one' (a running car on lap 1 has not reached the end of sector 2;
 *   at most until the leader completes lap 2) |
 *   'chequered-flag' (the leader has finished) | 'last-lap' (the out-lap would end
 *   past the focus car's last lap).
 *   Otherwise { focus, available: true,
 *   ongoingStop: boolean (the focus is already stopping: its stop is projected instead),
 *   stage: null | 'in-lap' | 'out-lap',
 *   trackFlag (opts.trackFlag or null), neutralised (SC / VSC / red: the green-flag
 *   pit loss and paces are used anyway; the view must say so),
 *   pitLoss: { median, p10, p90, n, source }, refLap: seconds,
 *   focusPhase, rejoinSeconds (the loss still to pay at the median: ring seconds from
 *   the focus's line position back to the rejoin point), rejoinOffset (the same as a phase),
 *   bandSeconds (ring seconds of the band from the focus as drawn back to the rejoin
 *   point, the trafficOnly reading: rejoinSeconds, less the line-to-pit-exit time of a
 *   focus anchored at its pit exit, never below 0),
 *   rejoinArcOffset: [p10, p90] offsets, rejoinPhase, rejoinArc: [p10Phase, p90Phase]
 *   (from focusPhase; for a stop under way from the focus's line time, module header),
 *   targetLap, pace (focus, s/lap), predictedCrossing (session s the focus completes targetLap),
 *   predictedPosition, currentPosition, positionsLost (predicted - current),
 *   wouldPassFocus: [{ driver, gapSeconds, marginSeconds }],
 *   wouldDropBehindFocus: [{ driver, gapSeconds, marginSeconds }],
 *   trafficOnly: [{ driver, laps, label }],
 *   traffic: { flag, carAhead, gapSeconds, carAheadLaps, thresholdSeconds },
 *   rivalCrossings: [{ driver, time, projected, pace, paceSource, stage, pendingLoss, lastLap }] }
 *   gapSeconds = the threshold gap of the module header (positive: behind the
 *   focus; gapSeconds(focus, driver) plus the rival's stop in progress not yet in it);
 *   marginSeconds = pit loss - |gapSeconds|, how far the car is from leaving the list;
 *   traffic.gapSeconds = seconds from carAhead's line crossing to predictedCrossing;
 *   rivalCrossings = the other cars' completions of targetLap the rank used
 *   (actual, or projected; Infinity for a car whose last lap, lastLap, comes
 *   before it), earliest first.
 */
export function pitWindow(focus, state, pitLoss, opts = {}) {
  const ctx = windowContext(focus, state, pitLoss, opts);
  if (ctx.error) return ctx.error;
  const {
    st, est, ref, car, f, ongoingStop, targetLap, lossMedian, focusPending, predictedAt, others,
  } = ctx;
  const p10 = toNum(est.p10) ?? lossMedian;
  const p90 = toNum(est.p90) ?? lossMedian;

  // Geometry: the band runs from the focus back to the rejoin point; a stop
  // under way places that point from the car's line time (module header)
  const pending = focusPending(lossMedian);
  const rejoinOffset = pending / ref;
  const rejoinArcOffset = [focusPending(p10) / ref, focusPending(p90) / ref];
  const focusPhase = car.phase;
  const rejoinFrom = ongoingStop ? linePhaseOf(car, st.sessionNow, ref) : focusPhase;
  const rejoinPhase = wrapPhase(rejoinFrom - rejoinOffset);
  const rejoinArc = rejoinArcOffset.map((o) => wrapPhase(rejoinFrom - o));
  const bandSeconds = bandSecondsOf(car, pending);

  // Rank
  const predictedCrossing = predictedAt(lossMedian);
  const predictedPosition = 1 + countBelow(ctx.sortedTimes, predictedCrossing);
  const currentPosition = car.position;

  // Undercut threshold (equal paces): same-lap cars within the pit loss behind
  // in the race (they gain the place) or ahead (they drop behind if THEY pit);
  // the side is the race order, the gap holds a rival's stop in progress
  const wouldPassFocus = [];
  const wouldDropBehindFocus = [];
  for (const o of others) {
    if (lapsBehind(car, o.p.car) !== 0) continue;
    const common = commonLapGap(st, focus, o.driver);
    if (!common) continue;
    const notInGap = stopNotInGap(o.p, common.lap, lossMedian);
    if (aheadInRace(o.p.car, car)) {
      // before its stop in progress, if any (that stop is the one that drops it behind)
      const gap = Math.min(0, common.gap - (o.p.stage ? lossMedian - notInGap : 0)) || 0;
      if (-gap < lossMedian) {
        wouldDropBehindFocus.push({ driver: o.driver, gapSeconds: gap, marginSeconds: lossMedian + gap });
      }
    } else {
      // once its stop in progress is paid
      const gap = Math.max(0, common.gap + notInGap) || 0;
      if (gap < lossMedian) {
        wouldPassFocus.push({ driver: o.driver, gapSeconds: gap, marginSeconds: lossMedian - gap });
      }
    }
  }
  // Nearest to the focus first
  const byGap = (a, b) => Math.abs(a.gapSeconds) - Math.abs(b.gapSeconds) || a.driver.localeCompare(b.driver);
  wouldPassFocus.sort(byGap);
  wouldDropBehindFocus.sort(byGap);

  // Track neutralised now (SC, VSC, red): the pit loss and the paces above are
  // green-flag figures; SC/VSC pit-loss markers wait for a validated estimator
  const trackFlag = opts.trackFlag != null ? String(opts.trackFlag) : null;
  const neutralised = trackFlag != null && NEUTRALISED_FLAGS.has(trackFlag);

  // Lapped / lapping cars drawn inside the band (traffic only): read off the
  // ring as drawn (ringRelations, every frame)
  const trafficOnly = bandTraffic(car, ringAround(st, car, ref), ref, bandSeconds);
  // Traffic at the predicted rejoin: the car crossing the line last before it
  const traffic = trafficOf(trafficReader(ctx, predictedCrossing, predictedCrossing)(predictedCrossing), targetLap);

  // What the rank compared the focus with (tooltips, backtest)
  const rivalCrossings = others
    .map((o) => ({
      driver: o.driver,
      time: o.t,
      projected: targetLap > o.p.car.lapsCompleted,
      pace: o.p.pace,
      paceSource: o.p.paceSource,
      stage: o.p.stage,
      pendingLoss: o.pending,
      lastLap: o.lastLap,
    }))
    .sort((a, b) => (a.time - b.time) || a.driver.localeCompare(b.driver));

  return {
    focus,
    available: true,
    ongoingStop,
    stage: f.stage,
    trackFlag,
    neutralised,
    pitLoss: { median: lossMedian, p10, p90, n: est.n, source: est.source },
    refLap: ref,
    focusPhase,
    rejoinSeconds: pending,
    bandSeconds,
    rejoinOffset,
    rejoinArcOffset,
    rejoinPhase,
    rejoinArc,
    targetLap,
    pace: f.pace,
    paceSource: f.paceSource,
    predictedCrossing,
    predictedPosition,
    currentPosition,
    positionsLost: predictedPosition - currentPosition,
    wouldPassFocus,
    wouldDropBehindFocus,
    trafficOnly,
    traffic,
    rivalCrossings,
  };
}

/**
 * Seeded PRNG (mulberry32): deterministic uniform numbers in [0, 1).
 *
 * @param {number} seed - any number (converted to a 32-bit integer)
 * @returns {function(): number}
 */
export function seededRandom(seed = DEFAULT_SEED) {
  let a = (Math.trunc(Number(seed) || 0) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pit-loss draws: a bootstrap of the measured stops (est.samples); with source
 * 'fallback', normal(FALLBACK_PIT_LOSS); an estimate passed without its
 * samples: normal(median, stdDev). Drawn losses keep a 5 s numeric floor.
 */
function drawLosses(est, samples, rand) {
  const measured = Array.isArray(est.samples)
    ? est.samples.map((s) => toNum(s?.loss)).filter((x) => x != null)
    : [];
  const out = new Array(samples);
  if (est.source !== 'fallback' && measured.length) {
    for (let i = 0; i < samples; i++) out[i] = measured[Math.floor(rand() * measured.length)];
    return { losses: out, method: 'bootstrap' };
  }
  const mu = est.source === 'fallback' ? FALLBACK_PIT_LOSS.median : toNum(est.median);
  const sd = est.source === 'fallback' ? FALLBACK_PIT_LOSS.stdDev : (toNum(est.stdDev) ?? 0);
  for (let i = 0; i < samples; i++) {
    // Box-Muller; 1 - rand() keeps the logarithm finite
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(TWO_PI * rand());
    out[i] = Math.max(MIN_LOSS_GUARD_S, mu + sd * z);
  }
  return { losses: out, method: 'normal' };
}

/**
 * Rejoin-position distribution of the focus car when it pits now: the
 * pitWindow rank recomputed for each pit-loss draw (module header).
 *
 * @param {string} focus - driver code
 * @param {Object} state - circleState result
 * @param {Object} [pitLoss] - estimatePitLoss result at the same sessionNow
 * @param {Object} [opts] - pitWindow options, plus
 * @param {number} [opts.samples=1000] - number of draws
 * @param {number} [opts.seed=1] - PRNG seed (same seed, same result)
 * @returns {{available: boolean, reason?: string, positions: Array<{position: number,
 *   probability: number}>, trafficProbability: number|null, samples: number,
 *   method: 'bootstrap'|'normal'|null}} positions sorted by position, probabilities
 *   sum to 1; trafficProbability = share of the draws whose predicted crossing is
 *   flagged as traffic (pitWindow's traffic rule)
 */
export function rejoinDistribution(focus, state, pitLoss, opts = {}) {
  const ctx = windowContext(focus, state, pitLoss, opts);
  if (ctx.error) {
    return {
      available: false, reason: ctx.error.reason, positions: [], trafficProbability: null, samples: 0, method: null,
    };
  }
  const samples = Math.max(1, Math.trunc(toNum(opts.samples) ?? DEFAULT_PROBABILITY_SAMPLES));
  const rand = seededRandom(opts.seed ?? DEFAULT_SEED);
  const { losses, method } = drawLosses(ctx.est, samples, rand);
  const counts = new Map();
  const crossings = losses.map((loss) => ctx.predictedAt(loss));
  for (const t of crossings) {
    const pos = 1 + countBelow(ctx.sortedTimes, t);
    counts.set(pos, (counts.get(pos) || 0) + 1);
  }
  const positions = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, k]) => ({ position, probability: k / samples }));
  // Traffic flag at each draw's predicted crossing, on the same crossings as pitWindow
  const readTraffic = trafficReader(ctx, Math.min(...crossings), Math.max(...crossings));
  let flagged = 0;
  for (const t of crossings) if (trafficOf(readTraffic(t), ctx.targetLap).flag) flagged += 1;
  return {
    available: true, positions, trafficProbability: flagged / samples, samples, method,
  };
}

/**
 * The band of a pit window at another frame of the same memo key
 * (circleMemoKey): its phases and the lapped / lapping cars inside it, read
 * off the cars of `state` as drawn (module header). Everything else (the
 * rank, the threshold lists, the traffic flag, the probabilities) does not
 * change between two events, so { ...win, ...ringRelations(win, frame) } =
 * pitWindow(focus, frame).
 *
 * @param {Object} win - pitWindow result (available)
 * @param {Object} state - circleState whose cars carry the frame's phases (phaseAt)
 * @returns {{focusPhase: number, rejoinPhase: number, rejoinArc: [number, number],
 *   trafficOnly: Array<Object>}|null} null when the window is not available or the
 *   focus is not drawn
 */
export function ringRelations(win, state) {
  if (!win?.available) return null;
  const st = ensureState(state);
  const car = carOf(st, win.focus);
  const ref = win.refLap;
  if (!car || car.phase == null || !(ref > 0)) return null;
  const from = win.ongoingStop ? linePhaseOf(car, st.sessionNow, ref) : car.phase;
  return {
    focusPhase: car.phase,
    rejoinPhase: wrapPhase(from - win.rejoinOffset),
    rejoinArc: win.rejoinArcOffset.map((o) => wrapPhase(from - o)),
    trafficOnly: bandTraffic(car, ringAround(st, car, ref), ref, bandSecondsOf(car, win.rejoinSeconds)),
  };
}

/**
 * Probability of each rejoin position when the focus pits now:
 * [{ position, probability }] sorted by position, summing to 1; [] when no
 * window can be computed. See rejoinDistribution.
 *
 * @param {string} focus
 * @param {Object} state - circleState result
 * @param {Object} [pitLoss] - estimatePitLoss result
 * @param {Object} [opts] - { samples = 1000, seed = 1, ...pitWindow options }
 * @returns {Array<{position: number, probability: number}>}
 */
export function rejoinProbabilities(focus, state, pitLoss, opts = {}) {
  return rejoinDistribution(focus, state, pitLoss, opts).positions;
}

/**
 * Key of what circleState knows at sessionNow: strategyViews.causalKey
 * (completed laps, pit events, track-status events when given) plus, while
 * cars are still on lap 1, the lap-1 timing points they have passed (their
 * race order). Constant between two such events; a view memoises circleState
 * on it and moves the cars every frame with phaseAt.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} sessionNow - session seconds
 * @param {Array<Object>} [trackStatus] - sessionData.track_status
 * @returns {string}
 */
export function circleStateKey(lapTimes, sessionNow, trackStatus = null) {
  const now = normaliseNow(sessionNow);
  let lapOnePoints = 0;
  for (const { byLap } of driverIndex(lapTimes).values()) {
    const lapOne = byLap.get(1);
    if (!lapOne || isLapCompleted(lapOne, now)) continue;
    for (const k of [1, 2]) {
      const t = toNum(lapOne[`Sector${k}SessionTime`]);
      if (t != null && t <= now) lapOnePoints += 1;
    }
  }
  return `${causalKey(lapTimes, now, trackStatus)}|${lapOnePoints}`;
}

/**
 * Memo key of the circle's analytics: changes only when the focus changes,
 * circleStateKey changes (a lap or a pit event completes, a track-status
 * period starts or ends, a car on lap 1 passes a timing point) or the
 * pit-loss estimate changes; never with the frame alone. Equal keys give
 * equal pitWindow / rejoinDistribution results apart from the band
 * (focusPhase, rejoinPhase, rejoinArc, trafficOnly), which ringRelations
 * reads off each frame's ring; the traffic flag and its probability are part
 * of the memoised results.
 *
 * @param {string} focus - driver code
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} sessionNow - session seconds
 * @param {Object} [pitLoss] - estimatePitLoss result
 * @param {Array<Object>} [trackStatus] - sessionData.track_status (its events then count too,
 *   for pitWindow's trackFlag)
 * @returns {string}
 */
export function circleMemoKey(focus, lapTimes, sessionNow, pitLoss, trackStatus = null) {
  return [
    focus ?? '',
    circleStateKey(lapTimes, sessionNow, trackStatus),
    pitLoss?.source ?? '',
    pitLoss?.n ?? '',
    pitLoss?.median ?? '',
  ].join('|');
}
