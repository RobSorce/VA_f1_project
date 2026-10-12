/**
 * Per-driver causal state at a session time: the one helper every per-driver
 * view uses to pick rows, tyres, pit and retirement status.
 *
 * Rules (session seconds, see raceTime.js):
 *  - a lap row is known once it has ended (Time <= now): `lastCompleted`;
 *  - the next row is the lap in progress once it has started
 *    (LapStartTime <= now): `inProgress`. Its time, gap and position are NOT
 *    known yet; only its sectors already run are (`visibleSectors`);
 *  - the stint in force follows utils/stints.js (R3): a new set exists from
 *    the pit exit, so during the pit lane the old set is still the current one;
 *  - retirement is known only once the driver's final row has ended (or, for a
 *    retirement in the pits, once the car has entered the pit lane).
 * Views never pick a row with `LapNumber <= currentLap` / `=== currentLap`;
 * bests (fastest lap, best sectors, averages) come from completed laps only.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  isLapCompleted, lapStartTime, lapEndTime, leaderLapEndTime,
  hasPitIn, hasPitOut, pitInSeconds, pitOutSeconds,
} from './raceTime';
import { deriveStints } from './stints';

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

/** One driver's rows sorted by LapNumber, one row per lap (the last one wins). */
function driverRows(lapTimes, driver) {
  const byLap = new Map();
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (lt?.Driver !== driver) continue;
    const n = Number(lt.LapNumber);
    if (Number.isFinite(n)) byLap.set(n, lt);
  }
  return [...byLap.entries()].sort((a, b) => a[0] - b[0]).map(([, lt]) => lt);
}

/** The driver's visible stints from opts.stints (array of deriveStints rows or { driver: rows }). */
function driverStints(stints, driver, rows, now) {
  if (Array.isArray(stints)) return stints.filter((s) => s.Driver === driver);
  if (stints && typeof stints === 'object') return stints[driver] || [];
  return deriveStints(rows, { sessionNow: now });
}

/**
 * The race's chequered flag (session s): the leader's end of the last lap
 * (raceTime.js leaderLapEndTime). null outside a race: qualifying and practice
 * rows carry no Position at all (no running order, nobody "finishes"); and
 * when the last lap has no Time (live rows).
 */
function chequeredFlagTime(lapTimes) {
  let lastLap = -Infinity;
  let ranked = false;
  for (const lt of lapTimes) {
    const n = toNum(lt?.LapNumber);
    if (n != null && n > lastLap) lastLap = n;
    if (!ranked && toNum(lt?.Position) != null) ranked = true;
  }
  if (lastLap === -Infinity || !ranked) return null;
  return leaderLapEndTime(lapTimes, lastLap);
}

/**
 * Did the driver fail to take the chequered flag? From the data alone: the
 * driver's final row ended (or, without a lap end, entered the pits) before
 * the race leader finished the last lap of the race. A lapped finisher takes
 * the flag after the winner, so this is false for every driver who finished.
 * false when the times needed are missing (live rows) and outside a race
 * (chequeredFlagTime null).
 */
function inferDnf(lapTimes, finalRow, chequered = chequeredFlagTime(lapTimes)) {
  const end = lapEndTime(finalRow) ?? (hasPitIn(finalRow) ? pitInSeconds(finalRow) : null);
  return chequered != null && end != null && end < chequered;
}

// lapTimes -> drivers inferred not to have finished (the rows of a session never change)
const _inferredNonFinishers = new WeakMap();

function inferredNonFinishers(lapTimes) {
  if (!Array.isArray(lapTimes)) return [];
  if (_inferredNonFinishers.has(lapTimes)) return _inferredNonFinishers.get(lapTimes);
  const out = [];
  const chequered = chequeredFlagTime(lapTimes);
  if (chequered != null) {
    const finalRow = new Map();
    for (const lt of lapTimes) {
      const n = toNum(lt?.LapNumber);
      if (!lt?.Driver || n == null) continue;
      const cur = finalRow.get(lt.Driver);
      if (!cur || n >= toNum(cur.LapNumber)) finalRow.set(lt.Driver, lt);
    }
    for (const [drv, row] of finalRow) if (inferDnf(lapTimes, row, chequered)) out.push(drv);
  }
  _inferredNonFinishers.set(lapTimes, out);
  return out;
}

/**
 * Every driver who did not take the chequered flag, as { driver: info }: the
 * results' non-finishers (store.dnfMap: ClassifiedPosition R/D/E/W/N) plus
 * the drivers whose final lap row ended before the race leader finished the
 * last lap, who are classified on distance yet stopped before the flag (2024
 * R3 RUS: crash on lap 57, classified 17th; 2024 R17 PER and SAI). Those get
 * { status: 'Retired', inferred: true }. Rows without times (live) and
 * sessions without a race classification (qualifying, practice) add nothing.
 *
 * A final result: a view passes `dnf: !!map[driver]` to driverStateAt, whose
 * `retired` shows the retirement only once the final row has ended (R6).
 * Pass the FULL lap table (the race's chequered flag is read from it).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {Object} [dnfMap] - store.dnfMap
 * @returns {Object} { driver: { status, ... } }
 */
export function nonFinisherMap(lapTimes, dnfMap = {}) {
  const base = dnfMap || {};
  const inferred = inferredNonFinishers(lapTimes).filter((d) => !base[d]);
  if (!inferred.length) return base;
  const out = { ...base };
  for (const d of inferred) out[d] = { status: 'Retired', inferred: true };
  return out;
}

/**
 * The driver's last lap row completed at sessionNow that counts for the
 * running order: one with a Position or a lap time. A completed row with
 * neither is the truncated lap of a car that stopped on track (2024 R17 lap
 * 50: PER and SAI, rows ending at 8718 / 8722 s with no Position and no lap
 * time); ranking on it would put the car ahead of the cars still racing.
 *
 * @param {Array<Object>} lapTimes - lap rows (any drivers; only `driver`'s are read)
 * @param {string} driver
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {Object|null} the lap row, or null before any such lap
 */
export function lastRankedLap(lapTimes, driver, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  let out = null;
  for (const lt of driverRows(lapTimes, driver)) {
    if (!isLapCompleted(lt, now)) continue;
    if (toNum(lt.Position) == null && !(toNum(lt.LapTimeSeconds) > 0)) continue;
    out = lt;
  }
  return out;
}

/**
 * Causal state of one driver at sessionNow.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver - driver code
 * @param {number} [sessionNow=Infinity] - session seconds (useSessionNow / getSessionNow);
 *   Infinity (live mode, race over) = every row known
 * @param {Object} [opts]
 * @param {Array<Object>|Object} [opts.stints] - deriveStints(lapTimes, { sessionNow }) at the
 *   SAME sessionNow (array, or stintsByDriver map); computed for this driver when omitted
 * @param {boolean|Object} [opts.dnf] - the driver did not finish (a view passes
 *   !!nonFinisherMap(lapTimes, dnfMap)[driver]); when omitted it is inferred from
 *   the lap rows (final row ended before the chequered flag), which needs the
 *   full lap table
 * @returns {{
 *   lastCompleted: Object|null,
 *   inProgress: Object|null,
 *   visibleSectors: {s1: number|null, s2: number|null, s3: number|null},
 *   stint: Object|null,
 *   compound: string|null,
 *   tyreLife: number|null,
 *   inPitLane: boolean,
 *   retired: boolean,
 *   retiredLap: number|null,
 *   lapsCompleted: number,
 * }}
 *   lastCompleted: the driver's last lap row completed at now;
 *   inProgress: the next row, only once it has started (LapStartTime <= now), never at Infinity;
 *   visibleSectors: sector times (s) of the lap in progress whose SectorNSessionTime <= now;
 *   stint: the deriveStints row in force (R3); compound: its Compound;
 *   tyreLife: TyreLife of the latest known row of that stint (at the pit exit: the
 *     out-lap's TyreLife; in the pit lane: the in-lap's, the old set);
 *   inPitLane: PitInTime <= now < PitOutTime (no later row: the car stayed in the pits);
 *   retired: did not finish AND the final row has ended (Time <= now), or, for a
 *     retirement in the pits, its PitInTime <= now;
 *   retiredLap: once retired, the lap the driver retired on (LapNumber of the final
 *     row, known since that lap began), else null. Never race_results Laps / dnfMap
 *     lastLap: those are final results, known only once the final row has ended;
 *   lapsCompleted: LapNumber of lastCompleted (0 before the first lap ends).
 */
export function driverStateAt(lapTimes, driver, sessionNow = Infinity, { stints, dnf } = {}) {
  const now = normaliseNow(sessionNow);
  const rows = driverRows(lapTimes, driver);
  const state = {
    lastCompleted: null,
    inProgress: null,
    visibleSectors: { s1: null, s2: null, s3: null },
    stint: null,
    compound: null,
    tyreLife: null,
    inPitLane: false,
    retired: false,
    retiredLap: null,
    lapsCompleted: 0,
  };
  if (!rows.length) return state;

  // Last completed row, and the next row once it has started
  let lastIdx = -1;
  rows.forEach((lt, i) => { if (isLapCompleted(lt, now)) lastIdx = i; });
  state.lastCompleted = lastIdx >= 0 ? rows[lastIdx] : null;
  state.lapsCompleted = state.lastCompleted ? Number(state.lastCompleted.LapNumber) : 0;
  const next = rows[lastIdx + 1];
  if (next && now !== Infinity) {
    const start = lapStartTime(next) ?? (lastIdx >= 0 ? lapEndTime(rows[lastIdx]) : null);
    if (start != null && start <= now) state.inProgress = next;
  }
  if (state.inProgress) {
    for (const k of [1, 2, 3]) {
      const at = toNum(state.inProgress[`Sector${k}SessionTime`]);
      if (at == null || at > now) continue;
      state.visibleSectors[`s${k}`] = toNum(state.inProgress[`Sector${k}TimeSeconds`])
        ?? toNum(state.inProgress[`Sector${k}Time`]);
    }
  }

  // Pit lane: the latest pit entry reached at now, and whether its exit has passed
  let entryIdx = -1;
  rows.forEach((lt, i) => {
    if (!hasPitIn(lt)) return;
    const pin = pitInSeconds(lt);
    if (pin != null ? pin <= now : isLapCompleted(lt, now)) entryIdx = i;
  });
  if (entryIdx >= 0) {
    const after = rows[entryIdx + 1];
    const exit = after && hasPitOut(after) ? pitOutSeconds(after) : null;
    if (!after) state.inPitLane = true;
    else if (exit != null) state.inPitLane = now < exit;
    else state.inPitLane = !isLapCompleted(rows[entryIdx], now);
  }

  // Stint in force (R3) and its tyre age
  const visible = driverStints(stints, driver, rows, now);
  const stint = visible.length
    ? visible.reduce((a, b) => (b.StintNumber > a.StintNumber ? b : a))
    : null;
  state.stint = stint;
  if (stint) {
    state.compound = stint.Compound ?? null;
    // Rows of this stint known at now: its first row (the set fitted at the
    // pit exit / on the grid), its completed laps and the lap in progress,
    // never a row of a later stint that is not visible yet
    const starts = deriveStints(rows).map((s) => s.StartLap);
    const nextStart = Math.min(Infinity, ...starts.filter((n) => n > stint.StartLap));
    const inStint = (lt) => {
      const n = Number(lt.LapNumber);
      return n >= stint.StartLap && n < nextStart;
    };
    let tyreRow = null;
    if (state.inPitLane && entryIdx >= 0 && inStint(rows[entryIdx])) {
      tyreRow = rows[entryIdx];
    } else {
      for (const lt of rows) {
        if (!inStint(lt)) continue;
        const known = Number(lt.LapNumber) === stint.StartLap
          || isLapCompleted(lt, now) || lt === state.inProgress;
        if (known) tyreRow = lt;
      }
    }
    state.tyreLife = tyreRow ? toNum(tyreRow.TyreLife) : null;
  }

  // Retirement: only once the final row has ended (or the car entered the pits for good)
  const finalRow = rows[rows.length - 1];
  const didNotFinish = dnf !== undefined ? !!dnf : inferDnf(lapTimes, finalRow);
  if (didNotFinish) {
    const pin = hasPitIn(finalRow) ? pitInSeconds(finalRow) : null;
    state.retired = pin != null ? pin <= now : isLapCompleted(finalRow, now);
    if (state.retired) state.retiredLap = toNum(finalRow.LapNumber);
  }
  return state;
}

/**
 * Qualifying order at sessionNow (session seconds), causal: each driver's
 * best COMPLETED lap (a valid lap time under 300 s on a row with Time <= now),
 * fastest first; drivers without one after them, by code. Never the final
 * classification (race_results Position) nor a lap still to come: at the
 * start of Q1 nobody has a time yet.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @param {Object} [opts]
 * @param {string[]} [opts.drivers] - only these drivers (e.g. the segment's), each listed
 *   even without a lap; default: every driver with a lap row
 * @returns {Array<{driver: string, best: Object|null, position: number|null}>}
 *   best = the row of the best completed lap; position = rank among the drivers
 *   with a time (null without one)
 */
export function qualifyingOrder(lapTimes, sessionNow = Infinity, { drivers = null } = {}) {
  const now = normaliseNow(sessionNow);
  const want = Array.isArray(drivers) && drivers.length ? new Set(drivers) : null;
  const best = new Map();
  for (const d of want || []) best.set(d, null);
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    const drv = lt?.Driver;
    if (!drv || (want && !want.has(drv))) continue;
    if (!best.has(drv)) best.set(drv, null);
    const t = toNum(lt.LapTimeSeconds);
    if (t == null || t <= 0 || t >= 300 || !isLapCompleted(lt, now)) continue;
    const cur = best.get(drv);
    if (!cur || t < toNum(cur.LapTimeSeconds)) best.set(drv, lt);
  }
  const rows = [...best.entries()].map(([driver, row]) => ({ driver, best: row }));
  rows.sort((a, b) => {
    const ta = a.best ? toNum(a.best.LapTimeSeconds) : Infinity;
    const tb = b.best ? toNum(b.best.LapTimeSeconds) : Infinity;
    return (ta - tb) || (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0);
  });
  let rank = 0;
  return rows.map((r) => ({ ...r, position: r.best ? ++rank : null }));
}
