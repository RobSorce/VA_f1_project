/**
 * Pit lane of the Circle of Doom: where a stopping car is at sessionNow (in
 * the pit lane, or back on track on its out-lap) and how long the race's pit
 * lane takes, for the pit-lane section of the ring.
 *
 * Clock and causal rule: session seconds (raceTime.js header). FastF1 splits
 * a stop over two rows: PitInTime on the in-lap n (the car enters the pit
 * lane), PitOutTime on the out-lap n + 1 (it leaves it). The in-lap ends at
 * the line inside the pit lane, so the out-lap starts before the pit exit.
 * Only a pit entry or a pit exit already passed is read (PitInTime <= now,
 * PitOutTime <= now), and a row only once it has ended; a PitOutTime still to
 * come is never read, so a car whose exit is not known yet is still in the
 * lane. driverState.js (inPitLane) reads the out-lap's PitOutTime before it
 * has passed; pitStatus does not, and agrees with it whenever that time is in
 * the data.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  isLapCompleted, isGreenLap, hasPitIn, hasPitOut, pitInSeconds, pitOutSeconds,
} from './raceTime';

/**
 * Pit-lane times kept by laneStats, seconds (exclusive bounds): a display
 * choice that leaves out the stops whose lane time is not a normal stop
 * (a drive-through is shorter, a red-flag wait or a repair far longer).
 */
export const LANE_TIME_BOUNDS_S = Object.freeze([10, 60]);
/** Stops laneStats needs before it gives a median. */
export const LANE_MIN_STOPS = 3;

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

// lapTimes -> Map driver -> Map lapNumber -> row (the last row of a lap wins).
// The rows of a session never change.
const _index = new WeakMap();

function byDriverLap(lapTimes) {
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
  _index.set(lapTimes, by);
  return by;
}

const NO_STOP = Object.freeze({
  status: null, pitInTime: null, pitOutTime: null, inLane: false,
});

/**
 * Stop under way of one driver at sessionNow.
 *   'lane': the latest pit entry has passed (PitInTime <= now; a row without a
 *           numeric PitInTime counts from its end) and the next row's pit exit
 *           has not (PitOutTime unknown or > now) while that row is still
 *           running; with no next row the car stayed in the pit lane;
 *   'out':  from the pit exit (PitOutTime <= now) until the out-lap ends;
 *   null:   otherwise (no stop under way, or the out-lap ended without a known
 *           pit exit).
 * pitOutTime is set only once the exit has passed.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver - driver code
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {{status: 'lane'|'out'|null, pitInTime: number|null, pitOutTime: number|null,
 *   inLane: boolean}} times in session seconds; pitInTime null for an entry without a
 *   numeric PitInTime
 */
export function pitStatus(lapTimes, driver, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const byLap = byDriverLap(lapTimes).get(driver);
  if (!byLap) return { ...NO_STOP };
  const laps = [...byLap.keys()].sort((a, b) => a - b);
  let entry = null;
  for (const n of laps) {
    const lt = byLap.get(n);
    if (!hasPitIn(lt)) continue;
    const pin = pitInSeconds(lt);
    if (pin != null ? pin <= now : isLapCompleted(lt, now)) entry = n;
  }
  if (entry == null) return { ...NO_STOP };
  const pitInTime = pitInSeconds(byLap.get(entry));
  const next = laps.find((n) => n > entry);
  if (next == null) return { status: 'lane', pitInTime, pitOutTime: null, inLane: true };
  const after = byLap.get(next);
  const exit = hasPitOut(after) ? pitOutSeconds(after) : null;
  if (isLapCompleted(after, now)) return { ...NO_STOP };
  if (exit != null && exit <= now) return { status: 'out', pitInTime, pitOutTime: exit, inLane: false };
  return { status: 'lane', pitInTime, pitOutTime: null, inLane: true };
}

/**
 * Pit-lane time of the race so far: median of PitOutTime - PitInTime over the
 * stops whose pit exit has passed (PitOutTime <= now). The stops are those of
 * pitLoss.js: in-lap n with a pit entry, the next lap n + 1 with a pit exit,
 * laps n - 1 and n completed and green, the in-lap with a lap time. The
 * out-lap's own status and lap time, which pitLoss.js also needs for the loss,
 * are not known at the pit exit and are not read. Lane times outside
 * LANE_TIME_BOUNDS_S are left out.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {{median: number|null, n: number}} median in seconds, null with fewer than
 *   LANE_MIN_STOPS stops
 */
export function laneStats(lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const [lo, hi] = LANE_TIME_BOUNDS_S;
  const lanes = [];
  for (const byLap of byDriverLap(lapTimes).values()) {
    for (const [n, r] of byLap) {
      if (!hasPitIn(r)) continue;
      const p = byLap.get(n - 1);
      const o = byLap.get(n + 1);
      if (!p || !o || !hasPitOut(o)) continue;
      const pin = pitInSeconds(r);
      const pout = pitOutSeconds(o);
      if (pin == null || pout == null || pout > now) continue;
      if (!isLapCompleted(p, now) || !isLapCompleted(r, now)) continue;
      if (!isGreenLap(p) || !isGreenLap(r) || !(toNum(r.LapTimeSeconds) > 0)) continue;
      const lane = pout - pin;
      if (lane > lo && lane < hi) lanes.push(lane);
    }
  }
  return { median: lanes.length >= LANE_MIN_STOPS ? median(lanes) : null, n: lanes.length };
}
