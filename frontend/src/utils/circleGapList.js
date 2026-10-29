/**
 * Gap list of the Circle of Doom: the distances between the cars the user is
 * following, shown without hovering, next to the ring.
 *
 * Reference (gapReference). The focus car when it is on the circle, else the
 * first selected car in race order (state.cars order), else none.
 *
 * Cars listed (gapRows), in race order:
 *  - a selection: the focus (if any) plus the selected cars;
 *  - a focus only: the cars one place ahead and behind it (two with a
 *    capacity of 5 rows or more);
 *  - neither: none.
 * Beyond `capacity` rows the rest go to `overflow`; the reference row is
 * always listed.
 *
 * Gaps. toRef = gapSeconds(reference, car) and toPrev = gapSeconds(previous
 * listed car, car), with toRefLaps / toPrevLaps = lapOffset (circleOfDoom.js:
 * the gap on the latest lap both cars completed, holding the whole laps of a
 * lapped car; positive = behind) and toRefAtLap / toPrevAtLap = that lap. A
 * car in the middle of its stop (pitStatus
 * 'lane' or 'out', circlePitLane.js) gets its status and laneSeconds (whole
 * seconds since its pit entry) and no gap at all, nor does a gap to it: the
 * gap on the latest lap both completed does not hold its stop yet
 * (circleOfDoom.js header, "Race order and the threshold lists").
 *
 * Trend. |gap to the reference| on the latest lap both completed, L, against
 * lap L - 3: trendDelta = |gap(L)| - |gap(L - 3)|, closing at <= -0.3 s,
 * opening at >= +0.3 s, else stable (the 0.3 s of the Rivals list in
 * store/useF1Store.js). null when either car has an in-lap, an out-lap or a
 * lap that is not green (raceTime.isGreenLap) among laps L - 3 to L, or the
 * two cars have fewer than 4 laps in common.
 *
 * Clock: every gap and trend reads completed laps only, and the status reads
 * pit times already passed, so the rows change only when circleStateKey does
 * (and with the focus, the selection and the capacity), except laneSeconds,
 * which runs with sessionNow: a view that memoises the rows on that key
 * refreshes it per frame from the row's pitInTime (laneSecondsAt).
 *
 * Pure module: no React, no D3, no store access.
 */
import { gapSeconds, lapOffset } from './circleOfDoom';
import { pitStatus } from './circlePitLane';
import {
  isGreenLap, hasPitIn, hasPitOut, lapEndTime,
} from './raceTime';

/** |gap| change over TREND_LAPS laps that reads as closing / opening, seconds. */
export const TREND_THRESHOLD_S = 0.3;
/** Laps between the two gaps of the trend. */
export const TREND_LAPS = 3;
/** Rows from which a focus alone lists two cars on each side instead of one. */
export const WIDE_NEIGHBOUR_CAPACITY = 5;

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

function selectionSet(selected) {
  if (selected instanceof Set) return selected;
  return new Set(Array.isArray(selected) ? selected : []);
}

/**
 * Reference car of the gap list (module header).
 *
 * @param {Object} state - circleState result
 * @param {string|null} focus - driver code
 * @param {Array<string>|Set<string>} [selected] - selected driver codes
 * @returns {string|null}
 */
export function gapReference(state, focus, selected) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  if (focus && cars.some((c) => c.driver === focus)) return focus;
  const sel = selectionSet(selected);
  return cars.find((c) => sel.has(c.driver))?.driver ?? null;
}

/** Whole seconds since a pit entry, or null. */
export function laneSecondsAt(pitInTime, sessionNow) {
  const now = normaliseNow(sessionNow);
  const pin = toNum(pitInTime);
  if (pin == null || now === Infinity) return null;
  return Math.max(0, Math.floor(now - pin));
}

// lapTimes -> Map driver -> Map lapNumber -> row (the last row of a lap wins)
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

/** The latest lap both cars have completed (the lap of gapSeconds), or null. */
function commonLap(state, a, b) {
  const by = byDriverLap(state.lapTimes);
  const A = state.cars.find((c) => c.driver === a);
  const B = state.cars.find((c) => c.driver === b);
  if (!A || !B) return null;
  for (let n = Math.min(A.lapsCompleted, B.lapsCompleted); n >= 1; n--) {
    if (lapEndTime(by.get(a)?.get(n)) != null && lapEndTime(by.get(b)?.get(n)) != null) return n;
  }
  return null;
}

/** A lap that can carry a trend: green, neither an in-lap nor an out-lap. */
function trendLap(row) {
  return !!row && isGreenLap(row) && !hasPitIn(row) && !hasPitOut(row) && lapEndTime(row) != null;
}

/**
 * Trend of the gap from `ref` to `d` (module header), or null.
 * Both cars' laps 1..L are completed (L <= both lap counts).
 */
function trendOf(state, ref, d) {
  const by = byDriverLap(state.lapTimes);
  const A = state.cars.find((c) => c.driver === ref);
  const B = state.cars.find((c) => c.driver === d);
  if (!A || !B) return null;
  const ra = by.get(ref);
  const rb = by.get(d);
  let L = null;
  for (let n = Math.min(A.lapsCompleted, B.lapsCompleted); n >= 1; n--) {
    if (lapEndTime(ra?.get(n)) != null && lapEndTime(rb?.get(n)) != null) {
      L = n;
      break;
    }
  }
  if (L == null || L - TREND_LAPS < 1) return null;
  for (let n = L - TREND_LAPS; n <= L; n++) {
    if (!trendLap(ra.get(n)) || !trendLap(rb.get(n))) return null;
  }
  const gapAt = (n) => lapEndTime(rb.get(n)) - lapEndTime(ra.get(n));
  const delta = Math.abs(gapAt(L)) - Math.abs(gapAt(L - TREND_LAPS));
  let trend = 'stable';
  if (delta <= -TREND_THRESHOLD_S) trend = 'closing';
  else if (delta >= TREND_THRESHOLD_S) trend = 'opening';
  return { trend, trendDelta: delta };
}

/** Drivers listed, in race order (module header). */
function listedDrivers(cars, focus, sel, capacity) {
  if (sel.size) return cars.filter((c) => c.driver === focus || sel.has(c.driver)).map((c) => c.driver);
  const i = focus ? cars.findIndex((c) => c.driver === focus) : -1;
  if (i < 0) return [];
  const span = capacity >= WIDE_NEIGHBOUR_CAPACITY ? 2 : 1;
  return cars.slice(Math.max(0, i - span), i + span + 1).map((c) => c.driver);
}

/**
 * Rows of the gap list at sessionNow (module header).
 *
 * @param {Object} state - circleState result (its cars give the race order)
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race), for the pit status
 * @param {number} sessionNow - session seconds (the frame's: laneSeconds)
 * @param {Object} [opts]
 * @param {string|null} [opts.focus] - focus driver
 * @param {Array<string>|Set<string>} [opts.selected] - selected drivers
 * @param {number} [opts.capacity=Infinity] - rows that fit
 * @returns {{reference: string|null, rows: Array<{driver: string, position: number|null,
 *   toRef: number|null, toRefLaps: number|null, toRefAtLap: number|null, toPrev: number|null,
 *   toPrevLaps: number|null, toPrevAtLap: number|null,
 *   status: 'lane'|'out'|null, laneSeconds: number|null, pitInTime: number|null,
 *   trend: 'closing'|'opening'|'stable'|null, trendDelta: number|null}>,
 *   overflow: Array<{driver: string, position: number|null}>}}
 *   gaps in seconds (positive: behind), laps = lapOffset, atLap = the lap the gap is read on;
 *   the reference row has toRef 0 (toRefAtLap null), the first row toPrev null
 */
export function gapRows(state, lapTimes, sessionNow, { focus = null, selected = [], capacity = Infinity } = {}) {
  const cars = Array.isArray(state?.cars) ? state.cars : [];
  const sel = selectionSet(selected);
  const reference = gapReference(state, focus, sel);
  const cap = toNum(capacity) ?? Infinity;
  const listed = listedDrivers(cars, focus, sel, cap);
  let shown = listed;
  if (listed.length > cap) {
    const keep = new Set(cap >= 1 && reference && listed.includes(reference) ? [reference] : []);
    for (const d of listed) if (keep.size < cap && !keep.has(d)) keep.add(d);
    shown = listed.filter((d) => keep.has(d));
  }
  const overflow = listed.filter((d) => !shown.includes(d))
    .map((d) => ({ driver: d, position: cars.find((c) => c.driver === d)?.position ?? null }));

  const stops = new Map(listed.map((d) => [d, pitStatus(lapTimes, d, sessionNow)]));
  const stopping = (d) => stops.get(d)?.status != null;
  const refStopping = reference != null && stopping(reference);
  const rows = shown.map((d, i) => {
    const car = cars.find((c) => c.driver === d);
    const stop = stops.get(d);
    const prev = i > 0 ? shown[i - 1] : null;
    const row = {
      driver: d,
      position: car?.position ?? null,
      toRef: null,
      toRefLaps: null,
      toRefAtLap: null,
      toPrev: null,
      toPrevLaps: null,
      toPrevAtLap: null,
      status: stop.status,
      laneSeconds: stop.status ? laneSecondsAt(stop.pitInTime, sessionNow) : null,
      pitInTime: stop.status ? stop.pitInTime : null,
      trend: null,
      trendDelta: null,
    };
    if (stopping(d)) return row;
    if (d === reference) {
      row.toRef = 0;
      row.toRefLaps = 0;
    } else if (reference != null && !refStopping) {
      row.toRef = gapSeconds(reference, d, state);
      row.toRefLaps = row.toRef == null ? null : lapOffset(reference, d, state);
      row.toRefAtLap = row.toRef == null ? null : commonLap(state, reference, d);
      Object.assign(row, trendOf(state, reference, d) || {});
    }
    if (prev != null && !stopping(prev)) {
      row.toPrev = gapSeconds(prev, d, state);
      row.toPrevLaps = row.toPrev == null ? null : lapOffset(prev, d, state);
      row.toPrevAtLap = row.toPrev == null ? null : commonLap(state, prev, d);
    }
    return row;
  });
  return { reference, rows, overflow };
}
