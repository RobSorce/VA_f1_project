/**
 * Race Trace: who gained time on whom over the race so far, and what changed
 * it (stops, SC / VSC / red flag, passes). The view is
 * components/visualizations/RaceTrace.jsx; the Lap Delta chart reads the same
 * trace on the focus reference (utils/views/lapDeltaChart.js).
 *
 * Race clock. A car's time at the end of its lap k is read from the lap row's
 * `Time` (session seconds), never from summed lap times (a row can lack its
 * LapTimeSeconds: 69 rows of the 2025 R1 demo race, 25 of 2024 R5):
 *     cum_d(k) = Time_d(k) - T0 - S(Time_d(k))
 *  - T0 = the lap-1 LapStartTime the cars share (one value in each demo race);
 *  - S(t) = the red-flag suspension before session time t: each red period
 *    (TrackStatus '5') runs from its start to the earliest LapStartTime at or
 *    after the end of the status period (the first lap started after the
 *    race resumed); S(t) is the part of those windows before t. The clock is
 *    frozen inside a window, so the gaps across a red flag stay the gaps the
 *    cars restarted with.
 *
 * References ref(k), all on that clock:
 *  - 'field' (default): sum over j <= k of m_j, m_j = the median race-clock
 *    lap time of lap j (cum_d(j) - cum_d(j - 1)) over the cars that completed
 *    it with no pit-in and no pit-out on it; when fewer than half of those
 *    cars have such a lap (the field pitting together), every car's lap
 *    counts. The race-clock lap time equals LapTimeSeconds on every lap after
 *    the first in the five demo races (0.000 s apart); on lap 1 LapTimeSeconds
 *    is 0.24-0.27 s shorter than Time - T0, so the median of LapTimeSeconds
 *    would put every car behind a car that started with them.
 *  - 'leader': the cum of the first car across lap k.
 *  - 'focus': the cum of the focus car on lap k (undefined where it has not
 *    completed the lap).
 * Plotted value y_d(k) = ref(k) - cum_d(k): up (+) = ahead of the reference.
 * On the leader reference y_d(k) = -(Time_d(k) - Time_first(k)), the timing's
 * gap to the leader, whenever no red window falls between the two crossings.
 *
 * Provisional lap (field reference): lap k is provisional until at least half
 * of the running cars have completed it, the running cars being those that had
 * completed lap k - 1 at that moment (on lap 1, the cars on the grid). Once a
 * lap has been final at some moment up to now it stays final. Until then
 * m_k := m_(k-1) (lap 1: the median of the laps completed so far) and its
 * points are flagged provisional (drawn hollow). A final m_k keeps following
 * the cars that complete lap k later (the median of every car that did);
 * scripts/race_trace_check.mjs measures that movement on the cached races.
 *
 * A retiring car's truncated last row (no Position and no lap time: TSU and
 * BOT in 2024 R5, six cars in 2025 R1) is not a crossing of the line: its
 * Time is when the row was closed, often before the leader's crossing.
 *
 * Causal: only laps completed at sessionNow (raceTime.js isLapCompleted), red
 * periods and track-status periods started by then, lap starts by then.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  isLapCompleted, hasPitIn, hasPitOut, mapTrackStatusToLaps,
} from './raceTime';
import { pitStops, pitLaneVisits } from './stints';

export const TRACE_REFERENCES = Object.freeze(['field', 'leader', 'focus']);
export const TRACE_WINDOWS = Object.freeze(['top', 'focus', 'all']);

/** A lap is final once this share of the running cars has completed it. */
export const PROVISIONAL_SHARE = 0.5;
/** Fewer non-pit laps than this share of the cars on a lap: every car's lap counts. */
export const NON_PIT_SHARE = 0.5;
/** A wet race: more than this share of the completed rows on INTERMEDIATE / WET. */
export const WET_ROW_SHARE = 0.1;
/** The 'top' window: the first cars of the lead lap. */
export const TOP_WINDOW_CARS = 10;
/** The 'focus' window: the focus car's gap +- max(minS, pit loss + pitMarginS). */
export const FOCUS_WINDOW = Object.freeze({ minS: 20, pitMarginS: 5 });

const WET_COMPOUNDS = new Set(['INTERMEDIATE', 'WET']);
// TrackStatus code -> band of the trace (4 SC, 5 red, 6 / 7 VSC deployed / ending)
const BAND_KIND = Object.freeze({ 4: 'SC', 5: 'RED', 6: 'VSC', 7: 'VSC' });
// Two periods of one kind this close (s) are one episode (VSC deployed, then ending)
const MERGE_GAP_S = 1;

/** Finite number from a number or numeric string, otherwise null. */
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

/** Number of values of a sorted array <= v (binary search). */
function countAtMost(sorted, v) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * T0: the lap-1 LapStartTime the cars share, i.e. the value most lap-1 rows
 * hold (ties: the earliest); null without any. Session seconds.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @returns {number|null}
 */
export function raceStartTime(lapTimes) {
  const counts = new Map();
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (toNum(lt?.LapNumber) !== 1) continue;
    const s = toNum(lt.LapStartTime);
    if (s == null || s <= 0) continue;
    const key = Math.round(s * 1000);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount || (n === bestCount && key < best)) { best = key; bestCount = n; }
  }
  return best == null ? null : best / 1000;
}

/**
 * Red-flag suspension windows known at sessionNow: one per red period
 * (TrackStatus '5') started by then, from its start to the earliest
 * LapStartTime at or after the end of the status period; `restart` null while
 * that is not known (the period still running, or no lap started since).
 * Overlapping windows are merged. Session seconds.
 *
 * @param {Array<Object>} trackStatus - sessionData.track_status
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity]
 * @returns {Array<{start: number, restart: number|null}>} sorted by start
 */
export function redFlagSuspensions(trackStatus, lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const starts = [];
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    const s = toNum(lt?.LapStartTime);
    if (s != null && s > 0 && s <= now) starts.push(s);
  }
  starts.sort((a, b) => a - b);
  const windows = [];
  for (const p of Array.isArray(trackStatus) ? trackStatus : []) {
    if (String(p?.status) !== '5') continue;
    const start = toNum(p.start_time);
    if (start == null || start > now) continue;
    const end = toNum(p.end_time);
    let restart = null;
    if (end != null && end <= now) {
      const i = starts.findIndex((s) => s >= end);
      if (i >= 0) restart = starts[i];
    }
    windows.push({ start, restart });
  }
  windows.sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of windows) {
    const prev = out[out.length - 1];
    if (prev && (prev.restart == null || w.start <= prev.restart)) {
      if (prev.restart != null) prev.restart = w.restart == null ? null : Math.max(prev.restart, w.restart);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * S(t): the time of the suspension windows before session time t (s).
 *
 * @param {number} t - session seconds
 * @param {Array<{start: number, restart: number|null}>} windows
 * @returns {number}
 */
export function suspensionBefore(t, windows) {
  let s = 0;
  for (const w of windows || []) {
    if (t <= w.start) continue;
    s += Math.min(t, w.restart == null ? Infinity : w.restart) - w.start;
  }
  return s;
}

/**
 * A retiring car's truncated row: no Position and no lap time. Its Time is
 * not a crossing of the timing line.
 *
 * @param {Object} row
 * @returns {boolean}
 */
export function isTruncatedRow(row) {
  const t = toNum(row?.LapTimeSeconds);
  return toNum(row?.Position) == null && !(t != null && t > 0);
}

/** { driver: Map lap -> row }, one row per (driver, lap): the last one wins. */
function rowsByDriver(lapTimes) {
  const by = new Map();
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt?.Driver) continue;
    const n = toNum(lt.LapNumber);
    if (n == null) continue;
    if (!by.has(lt.Driver)) by.set(lt.Driver, new Map());
    by.get(lt.Driver).set(Math.trunc(n), lt);
  }
  return by;
}

/**
 * The race clock at sessionNow: every lap row completed by then that has a
 * Time, with its cum (race-clock seconds since T0) and its race-clock lap time;
 * truncated rows (isTruncatedRow) left out and counted.
 *
 * @param {Array<Object>} lapTimes
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.trackStatus]
 * @param {number} [opts.sessionNow=Infinity]
 * @returns {{t0: number|null, suspensions: Array<Object>, rowsWithoutTime: number,
 *   truncatedRows: number, grid: number, byDriver: Map<string, Map<number, {lap: number, time: number, cum: number,
 *   lapTime: number|null, row: Object}>>}}
 */
export function raceClock(lapTimes, { trackStatus = [], sessionNow = Infinity } = {}) {
  const now = normaliseNow(sessionNow);
  const t0 = raceStartTime(lapTimes);
  const suspensions = redFlagSuspensions(trackStatus, lapTimes, now);
  const byDriver = new Map();
  let rowsWithoutTime = 0;
  let truncatedRows = 0;
  let grid = 0;
  for (const [driver, laps] of rowsByDriver(lapTimes)) {
    if (laps.has(1)) grid += 1;
    const out = new Map();
    for (const lap of [...laps.keys()].sort((a, b) => a - b)) {
      const row = laps.get(lap);
      if (!isLapCompleted(row, now)) continue;
      const time = toNum(row.Time);
      if (time == null) { rowsWithoutTime += 1; continue; }
      if (isTruncatedRow(row)) { truncatedRows += 1; continue; }
      if (t0 == null || lap < 1) continue;
      const cum = time - t0 - suspensionBefore(time, suspensions);
      const before = lap === 1 ? { cum: 0 } : out.get(lap - 1);
      out.set(lap, {
        lap, time, cum, lapTime: before ? cum - before.cum : null, row,
      });
    }
    if (out.size) byDriver.set(driver, out);
  }
  return {
    t0, suspensions, rowsWithoutTime, truncatedRows, grid, byDriver,
  };
}

/**
 * The field reference lap by lap (see the module comment): for laps 1..K,
 * { lap, median, final, cars, nonPit, crossed }, where `median` is m_k (the
 * carried m_(k-1) while the lap is provisional), `cars` the laps the median
 * was taken over, `nonPit` whether those are the non-pit laps only, and
 * `crossed` the cars that completed the lap.
 *
 * @param {ReturnType<typeof raceClock>} clock
 * @returns {Array<{lap: number, median: number|null, final: boolean, cars: number,
 *   nonPit: boolean, crossed: number, carried: boolean}>}
 */
export function fieldReferenceLaps(clock) {
  const crossings = new Map(); // lap -> sorted crossing times
  const entries = new Map(); // lap -> [{lapTime, pit}]
  let last = 0;
  for (const laps of clock.byDriver.values()) {
    for (const p of laps.values()) {
      if (!crossings.has(p.lap)) { crossings.set(p.lap, []); entries.set(p.lap, []); }
      crossings.get(p.lap).push(p.time);
      if (p.lapTime != null) entries.get(p.lap).push({ lapTime: p.lapTime, pit: hasPitIn(p.row) || hasPitOut(p.row) });
      if (p.lap > last) last = p.lap;
    }
  }
  for (const list of crossings.values()) list.sort((a, b) => a - b);
  const out = [];
  let prev = null;
  for (let k = 1; k <= last; k++) {
    const times = crossings.get(k) || [];
    const before = crossings.get(k - 1) || [];
    // Final once, at some crossing of lap k, half the cars then running
    // (across lap k - 1, or on the grid for lap 1) had completed it
    let final = false;
    for (let i = 0; i < times.length && !final; i++) {
      const running = k === 1 ? clock.grid : countAtMost(before, times[i]);
      final = running > 0 && i + 1 >= PROVISIONAL_SHARE * running;
    }
    const all = entries.get(k) || [];
    const clean = all.filter((e) => !e.pit);
    const nonPit = clean.length >= NON_PIT_SHARE * all.length;
    const pool = (nonPit ? clean : all).map((e) => e.lapTime);
    let m = null;
    let carried = false;
    if (final || prev == null) m = median(pool);
    if (m == null) { m = prev; carried = prev != null; }
    if (!final && prev != null) { m = prev; carried = true; }
    out.push({
      lap: k, median: m, final, cars: final || prev == null ? pool.length : 0, nonPit, crossed: times.length, carried,
    });
    if (m != null) prev = m;
  }
  return out;
}

/**
 * Race order at sessionNow from the lap rows: most laps completed first, then
 * the earlier crossing of that lap. Each car with its last lap, the time of
 * that crossing and the laps it was down on the leader then (leader laps
 * completed by that crossing minus its own).
 *
 * @param {ReturnType<typeof raceClock>} clock
 * @returns {Array<{driver: string, position: number, lastLap: number, time: number, lapsDown: number}>}
 */
export function raceOrder(clock) {
  const firstCross = new Map(); // lap -> earliest crossing time
  const cars = [];
  for (const [driver, laps] of clock.byDriver) {
    let lastP = null;
    for (const p of laps.values()) {
      const t = firstCross.get(p.lap);
      if (t == null || p.time < t) firstCross.set(p.lap, p.time);
      if (!lastP || p.lap > lastP.lap) lastP = p;
    }
    if (lastP) cars.push({ driver, lastLap: lastP.lap, time: lastP.time });
  }
  const leaderLaps = [...firstCross.entries()].sort((a, b) => a[0] - b[0]);
  cars.sort((a, b) => b.lastLap - a.lastLap || a.time - b.time || (a.driver < b.driver ? -1 : 1));
  return cars.map((c, i) => {
    let ledLaps = c.lastLap;
    for (const [lap, t] of leaderLaps) if (lap > ledLaps && t <= c.time) ledLaps = lap;
    return { ...c, position: i + 1, lapsDown: Math.max(0, ledLaps - c.lastLap) };
  });
}

/**
 * The race trace at sessionNow.
 *
 * Every driver with a completed lap gets one point per completed lap with a
 * Time, plus the start (lap 0, y 0): { lap, y, cum, time, provisional }.
 * `reference` 'focus' without a focus car that has a completed lap falls back
 * to 'field' (effective reference in `reference`, the asked one in `asked`).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.trackStatus] - sessionData.track_status
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {'field'|'leader'|'focus'} [opts.reference='field']
 * @param {string|null} [opts.focusDriver]
 * @returns {{reference: string, asked: string, focusDriver: string|null, t0: number|null,
 *   suspensions: Array<Object>, rowsWithoutTime: number, truncatedRows: number, lastLap: number,
 *   laps: Array<Object>, order: Array<Object>, cars: number,
 *   drivers: Array<{driver: string, position: number, lapsDown: number, lastLap: number,
 *   points: Array<{lap: number, y: number, cum: number, time: number|null, provisional: boolean, start?: boolean}>}>}}
 */
export function buildRaceTrace(lapTimes, {
  trackStatus = [], sessionNow = Infinity, reference = 'field', focusDriver = null,
} = {}) {
  const asked = TRACE_REFERENCES.includes(reference) ? reference : 'field';
  const clock = raceClock(lapTimes, { trackStatus, sessionNow });
  const laps = fieldReferenceLaps(clock);
  const order = raceOrder(clock);
  const lastLap = laps.length;

  const focusLaps = focusDriver ? clock.byDriver.get(focusDriver) : null;
  const ref = asked === 'focus' && !focusLaps ? 'field' : asked;

  // ref(k) for k = 0..K
  const refAt = new Map([[0, 0]]);
  if (ref === 'field') {
    let sum = 0;
    for (const l of laps) {
      if (l.median == null) break;
      sum += l.median;
      refAt.set(l.lap, sum);
    }
  } else if (ref === 'leader') {
    for (const lapsOf of clock.byDriver.values()) {
      for (const p of lapsOf.values()) {
        const r = refAt.get(p.lap);
        if (r == null || p.cum < r) refAt.set(p.lap, p.cum);
      }
    }
  } else {
    for (const p of focusLaps.values()) refAt.set(p.lap, p.cum);
  }
  const finalLap = new Map(laps.map((l) => [l.lap, l.final]));

  const byOrder = new Map(order.map((o) => [o.driver, o]));
  const drivers = [];
  for (const [driver, lapsOf] of clock.byDriver) {
    const points = [{ lap: 0, y: 0, cum: 0, time: clock.t0, provisional: false, start: true }];
    for (const p of [...lapsOf.values()].sort((a, b) => a.lap - b.lap)) {
      const r = refAt.get(p.lap);
      if (r == null) continue;
      points.push({
        lap: p.lap,
        y: r - p.cum,
        cum: p.cum,
        time: p.time,
        provisional: ref === 'field' && !finalLap.get(p.lap),
      });
    }
    const o = byOrder.get(driver);
    drivers.push({
      driver, position: o.position, lapsDown: o.lapsDown, lastLap: o.lastLap, points,
    });
  }
  drivers.sort((a, b) => a.position - b.position);

  return {
    reference: ref,
    asked,
    focusDriver: focusLaps ? focusDriver : null,
    t0: clock.t0,
    suspensions: clock.suspensions,
    rowsWithoutTime: clock.rowsWithoutTime,
    truncatedRows: clock.truncatedRows,
    lastLap,
    laps,
    order,
    cars: drivers.length,
    drivers,
  };
}

/**
 * The newest point of a driver's trace (null without one past the start).
 *
 * @param {{points: Array<Object>}} d - a buildRaceTrace driver
 * @returns {Object|null}
 */
export function latestPoint(d) {
  const p = d?.points?.[d.points.length - 1];
  return p && !p.start ? p : null;
}

/**
 * SC, VSC and red-flag episodes on the leader's laps, for the periods started
 * at sessionNow (raceTime.js mapTrackStatusToLaps). A period still running at
 * sessionNow ends at the leader's lap then (`ongoing`). Back-to-back periods
 * of one kind (VSC deployed, then VSC ending) are one episode.
 *
 * @param {Array<Object>} trackStatus
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity]
 * @returns {Array<{kind: 'SC'|'VSC'|'RED', startLap: number, endLap: number,
 *   startTime: number, endTime: number|null, ongoing: boolean}>}
 */
export function traceBands(trackStatus, lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const periods = [];
  for (const p of Array.isArray(trackStatus) ? trackStatus : []) {
    const kind = BAND_KIND[String(p?.status)];
    if (!kind) continue;
    const start = toNum(p.start_time);
    if (start == null || start > now) continue;
    const end = toNum(p.end_time);
    const ongoing = now !== Infinity && (end == null || end > now);
    periods.push({ ...p, kind, ongoing, end_time: ongoing ? now : p.end_time });
  }
  const mapped = mapTrackStatusToLaps(periods, lapTimes)
    .sort((a, b) => toNum(a.start_time) - toNum(b.start_time));
  const out = [];
  for (const p of mapped) {
    const start = toNum(p.start_time);
    const end = toNum(p.end_time);
    const prev = out[out.length - 1];
    if (prev && prev.kind === p.kind && prev.endTime != null && start - prev.endTime <= MERGE_GAP_S) {
      prev.endLap = Math.max(prev.endLap, p.end_lap);
      prev.endTime = end;
      prev.ongoing = p.ongoing;
      continue;
    }
    out.push({
      kind: p.kind, startLap: p.start_lap, endLap: p.end_lap, startTime: start, endTime: end, ongoing: p.ongoing,
    });
  }
  return out;
}

/**
 * Tyre changes and pit-lane visits without one, visible at sessionNow
 * (stints.js pitStops / pitLaneVisits), as chips of the trace: a stop at its
 * out-lap with the new compound; a visit at its out-lap (its in-lap when the
 * car stayed in).
 *
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity]
 * @returns {Array<{driver: string, kind: 'stop'|'visit', inLap: number, lap: number,
 *   compound: string|null, fromCompound: string|null}>} sorted by driver, then lap
 */
export function traceStops(lapTimes, sessionNow = Infinity) {
  const out = [];
  for (const s of pitStops(lapTimes, { sessionNow })) {
    out.push({
      driver: s.Driver, kind: 'stop', inLap: s.inLap, lap: s.outLap, compound: s.toCompound, fromCompound: s.fromCompound,
    });
  }
  for (const v of pitLaneVisits(lapTimes, { sessionNow })) {
    out.push({
      driver: v.Driver, kind: 'visit', inLap: v.inLap, lap: v.outLap ?? v.inLap, compound: null, fromCompound: null,
    });
  }
  return out.sort((a, b) => (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : a.lap - b.lap));
}

/**
 * Wet race at sessionNow: more than WET_ROW_SHARE of the completed rows on
 * INTERMEDIATE or WET tyres.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity]
 * @returns {{wet: boolean, share: number, rows: number}}
 */
export function wetRace(lapTimes, sessionNow = Infinity) {
  let rows = 0;
  let wet = 0;
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!isLapCompleted(lt, sessionNow)) continue;
    rows += 1;
    if (WET_COMPOUNDS.has(String(lt.Compound || '').toUpperCase())) wet += 1;
  }
  const share = rows ? wet / rows : 0;
  return { wet: share > WET_ROW_SHARE, share, rows };
}

/**
 * The y window of the view (seconds, `lo` < `hi`):
 *  - 'top': the extent of the first TOP_WINDOW_CARS cars of the lead lap;
 *  - 'focus': the focus car's latest gap +- max(FOCUS_WINDOW.minS, pitLoss + FOCUS_WINDOW.pitMarginS);
 *  - 'all': every point.
 * 'focus' without a focus car falls back to 'top'. `above` / `below`: the
 * drivers whose latest point is outside, in race order.
 *
 * @param {ReturnType<typeof buildRaceTrace>} trace
 * @param {Object} [opts]
 * @param {'top'|'focus'|'all'} [opts.window='top']
 * @param {string|null} [opts.focusDriver]
 * @param {number|null} [opts.pitLoss] - s (estimatePitLoss median)
 * @param {[number, number]|null} [opts.lapRange] - only the points of these laps count
 * @returns {{mode: string, lo: number, hi: number, above: string[], below: string[]}}
 */
export function traceWindow(trace, {
  window = 'top', focusDriver = null, pitLoss = null, lapRange = null,
} = {}) {
  const drivers = trace?.drivers || [];
  const focus = focusDriver ? drivers.find((d) => d.driver === focusDriver) : null;
  const focusPoint = latestPoint(focus);
  const mode = window === 'focus' && !focusPoint ? 'top' : (TRACE_WINDOWS.includes(window) ? window : 'top');
  const inRange = (p) => !lapRange || (p.lap >= lapRange[0] && p.lap <= lapRange[1]);
  const extent = (list) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of list) {
      for (const p of d.points) {
        if (!inRange(p)) continue;
        if (p.y < lo) lo = p.y;
        if (p.y > hi) hi = p.y;
      }
    }
    return lo <= hi ? [lo, hi] : [-1, 1];
  };
  let lo;
  let hi;
  if (mode === 'focus') {
    const loss = Number.isFinite(pitLoss) ? pitLoss : 0;
    const h = Math.max(FOCUS_WINDOW.minS, loss + FOCUS_WINDOW.pitMarginS);
    lo = focusPoint.y - h;
    hi = focusPoint.y + h;
  } else if (mode === 'all') {
    [lo, hi] = extent(drivers);
  } else {
    const top = drivers.filter((d) => d.lapsDown === 0).slice(0, TOP_WINDOW_CARS);
    [lo, hi] = extent(top.length ? top : drivers);
  }
  if (mode !== 'focus') {
    const pad = Math.max(0.5, (hi - lo) * 0.06);
    lo -= pad;
    hi += pad;
  }
  const above = [];
  const below = [];
  for (const d of drivers) {
    const p = latestPoint(d);
    if (!p) continue;
    if (p.y > hi) above.push(d.driver);
    else if (p.y < lo) below.push(d.driver);
  }
  return { mode, lo, hi, above, below };
}

/** '+4.2' / '−4.2' (true minus), one decimal. */
function signed1(v) {
  const abs = Math.abs(v).toFixed(1);
  if (Number(abs) === 0) return '0.0';
  return v > 0 ? `+${abs}` : `−${abs}`;
}

/**
 * The view's one-line answer for a subject car: e.g. "LEC +4.2 s ahead of the
 * field-median car at L36, P1". On the leader reference the gap to the
 * leader; on the focus reference the cars just ahead of and behind the
 * subject, each gap measured from the subject (which need not be the
 * reference car). '' without a point.
 *
 * @param {ReturnType<typeof buildRaceTrace>} trace
 * @param {string|null} subject - driver code (default: the focus car, else P1)
 * @returns {string}
 */
export function traceAnswer(trace, subject = null) {
  const drivers = trace?.drivers || [];
  if (!drivers.length) return '';
  const d = drivers.find((x) => x.driver === (subject || trace.focusDriver)) || drivers[0];
  const p = latestPoint(d);
  if (!p) return '';
  const where = `at L${p.lap}, P${d.position}`;
  const lapped = d.lapsDown > 0 ? ` (−${d.lapsDown}L)` : '';
  if (trace.reference === 'field') {
    const word = p.y >= 0 ? 'ahead of' : 'behind';
    return `${d.driver} ${signed1(p.y)} s ${word} the field-median car ${where}${lapped}`;
  }
  if (trace.reference === 'leader') {
    if (d.position === 1) return `${d.driver} leads ${where}`;
    return `${d.driver} ${signed1(p.y)} s behind the leader ${where}${lapped}`;
  }
  // focus reference: the nearest car on either side of the subject on its
  // newest lap. The y values are relative to the reference car, which need
  // not be the subject (a hovered car, a Lap Delta base car), so each gap is
  // measured from the subject's own point: g = q.y - p.y, + = ahead of it
  const near = drivers
    .filter((x) => x.driver !== d.driver)
    .map((x) => ({ x, q: x.points.find((q) => q.lap === p.lap && !q.start) }))
    .filter((e) => e.q)
    .map((e) => ({ x: e.x, g: e.q.y - p.y }));
  const ahead = near.filter((e) => e.g > 0).sort((a, b) => a.g - b.g)[0];
  const behind = near.filter((e) => e.g <= 0).sort((a, b) => b.g - a.g)[0];
  const parts = [];
  if (ahead) parts.push(`${ahead.x.driver} ${signed1(ahead.g)} s ahead`);
  if (behind) parts.push(`${behind.x.driver} ${signed1(behind.g)} s behind`);
  return `${d.driver} ${where}${lapped}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * Text of the reference on the provenance line, with its car count.
 *
 * @param {ReturnType<typeof buildRaceTrace>} trace
 * @returns {string}
 */
export function referenceText(trace) {
  if (!trace) return '';
  if (trace.reference === 'leader') return `reference: first car across each lap · ${trace.cars} cars`;
  if (trace.reference === 'focus') return `reference: ${trace.focusDriver}'s lap ends · ${trace.cars} cars`;
  const final = [...(trace.laps || [])].reverse().find((l) => l.final && l.cars > 0);
  if (!final) return `reference: field-median lap · ${trace.cars} cars`;
  const which = final.nonPit ? 'laps without a pit stop' : 'every lap (most cars pitted)';
  return `reference: field-median lap, ${final.cars} of ${trace.cars} cars on L${final.lap} (${which})`;
}
