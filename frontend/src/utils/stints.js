/**
 * Stints and pit stops derived from lap_times, causally.
 *
 * A stint is one set of tyres. The backend's old tyre_strategy split stints
 * only on compound changes, so two back-to-back stints on the same compound
 * were merged (Monza 2024: 40 stints instead of 50). Here stints come from the
 * FastF1 `Stint` column of each lap row. That column also increments on every
 * pit-lane passage without a tyre change (field led through the pit lane under
 * SC / red flag, drive-through), so a Stint change opens a new stint only when
 * it is a tyre change (isTyreChange). The rule is identical to
 * build_tyre_strategy in backend/data/processors/stints.py (parity test over
 * every cached session).
 *
 * Causal visibility at `sessionNow` (session seconds, see raceTime.js):
 *  - stint 1 of every driver exists from the start of the driver's first lap
 *    (the race start), ongoing with possibly 0 completed laps;
 *  - a later stint exists from its pit exit (PitOutTime of its first row
 *    <= sessionNow); without a PitOutTime (live rows) once its first lap row is
 *    completed. At that instant it has 0 completed laps
 *    (EndLap = StartLap - 1, TotalLaps = 0, ongoing = true);
 *  - a stint's laps are its rows completed at sessionNow.
 * During the pit lane (PitInTime <= now < PitOutTime) the old stint is still
 * the current one. A pit stop is a tyre change, i.e. a stint boundary, and
 * counts from the same pit exit, so "stints - 1" and the stop count agree at
 * every instant.
 *
 * Live mode: sessionNow is Infinity (every received row is over), but the race
 * goes on after the rows, so a driver's final row is not the end of the
 * driver's race. The `running` option (stintsRunning) keeps the last stint of
 * every driver still racing ongoing until the chequered flag.
 *
 * Output rows keep the tyre_strategy shape so consumers can swap sources:
 *   { Driver, StintNumber, Compound, StartLap, EndLap, TotalLaps, ongoing }
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  isLapCompleted, isPitVisible, hasPitIn, hasPitOut, lapStartTime, pitInSeconds, pitOutSeconds,
} from './raceTime';

// FastF1 placeholders for a missing compound (the cache also holds the string 'nan')
const UNKNOWN_COMPOUNDS = new Set(['', 'UNKNOWN', 'TEST_UNKNOWN', 'NAN', 'NONE', 'NULL']);

function knownCompound(c) {
  if (c == null) return null;
  const s = String(c).trim().toUpperCase();
  return UNKNOWN_COMPOUNDS.has(s) ? null : s;
}

function finiteNumber(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function normaliseNow(sessionNow) {
  return sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
}

/** Most common known compound; ties go to the one seen first. 'UNKNOWN' when none. */
function dominantCompound(compounds) {
  const counts = new Map();
  for (const c of compounds) {
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [c, n] of counts) {
    if (n > bestCount) { best = c; bestCount = n; }
  }
  return best || 'UNKNOWN';
}

/** { driver: rows sorted by LapNumber }, one row per (driver, lap): the last one wins. */
function groupByDriver(lapTimes) {
  const byDriver = new Map();
  for (const lt of lapTimes) {
    if (!lt?.Driver) continue;
    const n = Number(lt.LapNumber);
    if (!Number.isFinite(n)) continue;
    if (!byDriver.has(lt.Driver)) byDriver.set(lt.Driver, new Map());
    byDriver.get(lt.Driver).set(n, lt);
  }
  const out = new Map();
  for (const [drv, laps] of byDriver) {
    out.set(drv, [...laps.entries()].sort((a, b) => a[0] - b[0]).map(([, lt]) => lt));
  }
  return out;
}

/**
 * Tyre-change test between two consecutive lap rows of one driver: true when
 * the compound differs from the previous lap's compound, or TyreLife does not
 * continue (continues = same compound AND 1 <= TyreLife(row) - TyreLife(prev) <= 2),
 * or TyreLife is missing on either side. Unknown compounds ('nan', 'UNKNOWN',
 * null) compare as equal to each other and different from a known one.
 *
 * @param {Object} prev - the previous lap row of the driver
 * @param {Object} row - the lap row after it
 * @returns {boolean}
 */
export function isTyreChange(prev, row) {
  const before = finiteNumber(prev?.TyreLife);
  const after = finiteNumber(row?.TyreLife);
  if (before == null || after == null) return true;
  if (knownCompound(prev?.Compound) !== knownCompound(row?.Compound)) return true;
  const d = after - before;
  return d < 1 || d > 2;
}

/**
 * Split one driver's lap rows (sorted by LapNumber, full race) into stints.
 *
 *  - A change of the FastF1 Stint value (both values present) opens a new
 *    stint only for a tyre change (isTyreChange); otherwise the same set is
 *    kept and the rows stay in the current stint (SC pit-lane pass,
 *    drive-through).
 *  - Rows with Stint null (on the row or on the stint so far) open a new stint
 *    on a pit-out with a tyre change, or on a compound change against the
 *    stint's last known compound; otherwise they extend the current stint,
 *    which adopts the first Stint value that follows (seen in 2025 R6, where
 *    the first ~23 laps of every driver have Stint and Compound missing).
 *
 * Every decision uses only the row and the rows before it, so the split of
 * the first k rows never changes when later rows arrive.
 *
 * @returns {Array<{laps: Array<Object>}>}
 */
function splitDriverStints(laps) {
  const stints = [];
  let cur = null;
  let prev = null;
  for (const lt of laps) {
    const s = finiteNumber(lt.Stint);
    const comp = knownCompound(lt.Compound);
    const compoundChanged = comp != null && cur?.lastCompound != null && comp !== cur.lastCompound;
    let opens;
    if (!cur) {
      opens = true;
    } else if (s != null && cur.stintValue === s) {
      opens = false;
    } else if (s != null && cur.stintValue != null) {
      opens = isTyreChange(prev, lt);
    } else {
      opens = (hasPitOut(lt) && isTyreChange(prev, lt)) || compoundChanged;
    }
    if (opens) {
      cur = { stintValue: s, laps: [lt], lastCompound: comp };
      stints.push(cur);
    } else {
      if (s != null) cur.stintValue = s;
      cur.laps.push(lt);
    }
    if (comp != null) cur.lastCompound = comp;
    prev = lt;
  }
  return stints;
}

/**
 * True when the stint (index i of the driver's split) exists at `now`:
 * stint 1 from the start of its first lap, a later stint from the PitOutTime
 * of its first row, or, without one, once that row is completed.
 */
function isStintVisible(stint, i, now) {
  if (now === Infinity) return true;
  const first = stint.laps[0];
  if (i === 0) {
    const start = lapStartTime(first);
    return start != null ? start <= now : isLapCompleted(first, now);
  }
  const exit = hasPitOut(first) ? pitOutSeconds(first) : null;
  return exit != null ? exit <= now : isLapCompleted(first, now);
}

/** The deriveStints `running` option for one driver (boolean, or a per-driver test). */
function isRunning(running, driver) {
  return typeof running === 'function' ? !!running(driver) : !!running;
}

/**
 * One driver's stints visible at `now`, as output rows plus the split stint
 * they come from (internal: `split.laps` holds future rows, never expose it).
 * `running`: the deriveStints option (the driver races on after the rows).
 */
function visibleDriverStints(driver, rows, now, running = false) {
  const split = splitDriverStints(rows);
  const visible = [];
  for (let i = 0; i < split.length; i++) {
    if (!isStintVisible(split[i], i, now)) break;
    visible.push(split[i]);
  }
  const finished = !isRunning(running, driver) && isLapCompleted(rows[rows.length - 1], now);
  return visible.map((st, i) => {
    const first = st.laps[0];
    const done = st.laps.filter((lt) => isLapCompleted(lt, now));
    const startLap = Number(first.LapNumber);
    const endLap = done.length ? Number(done[done.length - 1].LapNumber) : startLap - 1;
    // Compound of what is known: the completed laps, plus the first row (the
    // set fitted at the pit exit / on the grid)
    const known = done.length && done[0] === first ? done : [first, ...done];
    return {
      split: st,
      row: {
        Driver: driver,
        StintNumber: i + 1,
        Compound: dominantCompound(known.map((lt) => knownCompound(lt.Compound))),
        StartLap: startLap,
        EndLap: endLap,
        TotalLaps: endLap - startLap + 1,
        ongoing: i === visible.length - 1 && !finished,
      },
    };
  });
}

/**
 * Stints from the FastF1 Stint column, visible at sessionNow (see the module
 * comment for the visibility rule).
 *
 * StintNumber is the stint's 1-based index for the driver (FastF1 numbering
 * can restart when early rows lack the column). Compound = most common known
 * compound among the stint's completed laps and its first row ('UNKNOWN' when
 * none). StartLap = the stint's first lap; EndLap = its last completed lap, or
 * StartLap - 1 while none is completed; TotalLaps = EndLap - StartLap + 1
 * (same definition as tyre_strategy, 0 for a stint just started). ongoing =
 * the driver's last visible stint while the driver's final lap row of the
 * full data is not yet completed at sessionNow, or while the driver races on
 * after the rows (opts.running, live mode).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race, or the rows received so far)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds (raceTime.resolveSessionNow)
 * @param {boolean|function(string): boolean} [opts.running=false] - the race goes on after
 *   the rows (live feed before the chequered flag, see stintsRunning): the driver's last
 *   visible stint stays ongoing although every row is completed. A function decides per
 *   driver (false for a driver known to be out). Default: the rows are the whole race.
 * @returns {Array<{Driver: string, StintNumber: number, Compound: string, StartLap: number,
 *   EndLap: number, TotalLaps: number, ongoing: boolean}>} sorted by Driver, then StintNumber
 */
export function deriveStints(lapTimes, { sessionNow = Infinity, running = false } = {}) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return [];
  const now = normaliseNow(sessionNow);
  const full = groupByDriver(lapTimes);
  const out = [];
  for (const drv of [...full.keys()].sort()) {
    for (const { row } of visibleDriverStints(drv, full.get(drv), now, running)) out.push(row);
  }
  return out;
}

/**
 * The deriveStints `running` option for a store state. In live mode the rows
 * are the laps received so far and the race goes on until the leader has
 * completed the race distance (LapCount TotalLaps = totalRaceLaps; unknown
 * total: still running). Until then every driver not known to be out
 * (dnfMap) is still on the current set, so the last stint is ongoing.
 * Outside live mode (replay, lap mode, finished live race): false, the rows
 * are the whole race.
 *
 * @param {Object} s
 * @param {boolean} [s.isLiveMode]
 * @param {number} [s.totalRaceLaps] - race distance in laps (live LapCount)
 * @param {Array<Object>} [s.lapTimes] - the lap rows received so far
 * @param {Object} [s.dnfMap] - { driver: info } of the drivers out of the race
 * @returns {false|function(string): boolean} false, or a per-driver test
 */
export function stintsRunning({ isLiveMode, totalRaceLaps, lapTimes, dnfMap } = {}) {
  if (!isLiveMode) return false;
  const total = finiteNumber(totalRaceLaps);
  if (total != null && total > 0) {
    let lastLap = 0;
    for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
      const n = finiteNumber(lt?.LapNumber);
      if (n != null && n > lastLap) lastLap = n;
    }
    if (lastLap >= total) return false; // chequered flag: the leader completed the distance
  }
  const out = dnfMap || {};
  return (driver) => !out[driver];
}

/**
 * deriveStints grouped by driver.
 *
 * @param {Array<Object>} lapTimes
 * @param {Object} [opts] - same as deriveStints ({ sessionNow } in session seconds, { running })
 * @returns {Object<string, Array<Object>>} { driver: stints sorted by StintNumber }
 */
export function stintsByDriver(lapTimes, opts) {
  const out = {};
  for (const st of deriveStints(lapTimes, opts)) {
    if (!out[st.Driver]) out[st.Driver] = [];
    out[st.Driver].push(st);
  }
  return out;
}

/**
 * Pit stops = tyre changes = stint boundaries, visible at sessionNow from the
 * pit exit, exactly when the new stint appears in deriveStints: per driver,
 * pitStops count = visible stints - 1 at every sessionNow. Pit-lane visits
 * without a tyre change are not stops (see pitLaneVisits). Works without
 * PitInTime / PitOutTime (live rows): the stop is the stint boundary.
 *
 * inLap = last lap of the previous stint (the in-lap), outLap = first lap of
 * the new stint; pitInTime / pitOutTime = session seconds of the pit entry on
 * the in-lap and of the pit exit on the out-lap, null when the rows carry
 * none; fromCompound / toCompound = Compound of the two stints (deriveStints).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @returns {Array<{Driver: string, inLap: number, outLap: number, pitInTime: number|null,
 *   pitOutTime: number|null, fromCompound: string, toCompound: string}>}
 *   sorted by Driver, then inLap
 */
export function pitStops(lapTimes, { sessionNow = Infinity } = {}) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return [];
  const now = normaliseNow(sessionNow);
  const full = groupByDriver(lapTimes);
  const out = [];
  for (const drv of [...full.keys()].sort()) {
    const visible = visibleDriverStints(drv, full.get(drv), now);
    for (let i = 1; i < visible.length; i++) {
      const before = visible[i - 1];
      const after = visible[i];
      const inRow = before.split.laps[before.split.laps.length - 1];
      const outRow = after.split.laps[0];
      out.push({
        Driver: drv,
        inLap: Number(inRow.LapNumber),
        outLap: Number(outRow.LapNumber),
        pitInTime: hasPitIn(inRow) ? pitInSeconds(inRow) : null,
        pitOutTime: hasPitOut(outRow) ? pitOutSeconds(outRow) : null,
        fromCompound: before.row.Compound,
        toCompound: after.row.Compound,
      });
    }
  }
  return out;
}

/**
 * Pit-lane visits WITHOUT a tyre change (drive-through, field led through the
 * pit lane under SC / red flag, retirement in the pits). These are not pit
 * stops; no view counts them as stops. One row per in-lap (pit entry) whose
 * next lap row does not start a new stint.
 *
 * Visible at sessionNow from the pit exit (PitOutTime of the next row), or,
 * without one, once the next row is completed; a visit with no later row (the
 * car stayed in the pits: retirement) from its pit entry (raceTime.isPitVisible).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @returns {Array<{Driver: string, inLap: number, outLap: number|null, pitInTime: number|null,
 *   pitOutTime: number|null, retired: boolean}>} sorted by Driver, then inLap;
 *   outLap / pitOutTime null when the next row has no pit-out; retired = no later row
 */
export function pitLaneVisits(lapTimes, { sessionNow = Infinity } = {}) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return [];
  const now = normaliseNow(sessionNow);
  const full = groupByDriver(lapTimes);
  const out = [];
  for (const drv of [...full.keys()].sort()) {
    const rows = full.get(drv);
    const stintStarts = new Set(splitDriverStints(rows).slice(1).map((st) => st.laps[0]));
    rows.forEach((lt, k) => {
      if (!hasPitIn(lt)) return;
      const next = rows[k + 1] || null;
      if (next && stintStarts.has(next)) return; // a tyre change: a pit stop
      const exitRow = next && hasPitOut(next) ? next : null;
      const exit = exitRow ? pitOutSeconds(exitRow) : null;
      let visible;
      if (!next) visible = isPitVisible(lt, now);
      else if (exit != null) visible = exit <= now;
      else visible = isLapCompleted(next, now);
      if (!visible) return;
      out.push({
        Driver: drv,
        inLap: Number(lt.LapNumber),
        outLap: exitRow ? Number(exitRow.LapNumber) : null,
        pitInTime: pitInSeconds(lt),
        pitOutTime: exit,
        retired: !next,
      });
    });
  }
  return out;
}
