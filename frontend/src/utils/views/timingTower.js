/**
 * View model of the timing tower (components/visualizations/TimingTower.jsx):
 * the causal timing rows at sessionNow, with their colour codes, gaps and
 * intervals.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { getDriverColor } from '../colors';
import { hasPitOut, isLapCompleted, isPitVisible, lapStartTime, pitOutSeconds } from '../raceTime';
import { driverStateAt, lastRankedLap, nonFinisherMap } from '../driverState';

/* -- Timing color constants (F1 broadcast standard) ---------------------- */
const TIMING_COLORS = {
  OVERALL_BEST: '#A020F0',   // Purple - session best
  PERSONAL_BEST: '#00FF00',  // Green - personal best
  SLOWER: '#FFD700',         // Yellow - slower than PB
  VERY_SLOW: '#FF4444',      // Red - >1.5s slower than PB
  PIT_IN: '#FF8800',         // Orange - pit
  PIT_OUT: '#44AAFF',        // Blue - out-lap
  DEFAULT: '#CCCCCC',        // Light gray
};

/* -- Status dot colors --------------------------------------------------- */
const STATUS_COLORS = {
  ON_TRACK: '#00FF00',
  PIT: '#FF8800',
  OUT: '#FF4444',
};

function formatGap(gap, isLeader) {
  if (isLeader) return 'LEADER';
  if (gap == null || gap === 0) return '-';
  if (typeof gap === 'string') return gap;
  return `+${gap.toFixed(3)}`;
}

function formatInterval(currentGap, aheadGap) {
  if (currentGap == null || currentGap === 0) return '---';
  if (aheadGap == null) return '---';
  const diff = currentGap - aheadGap;
  if (diff <= 0) return '---';
  return `+${diff.toFixed(3)}`;
}

/* -- Determine timing color for a sector or lap value -------------------- */
// Bests come from completed laps only, so a sector of the lap in progress can
// beat them: at or below the best counts as that best
function getTimingColor(value, sessionBest, personalBest, isPitIn, isPitOut) {
  if (!value || value <= 0) return TIMING_COLORS.DEFAULT;
  if (isPitIn) return TIMING_COLORS.PIT_IN;
  if (isPitOut) return TIMING_COLORS.PIT_OUT;
  if (sessionBest && value <= sessionBest + 0.0005) return TIMING_COLORS.OVERALL_BEST;
  if (personalBest && value <= personalBest + 0.0005) return TIMING_COLORS.PERSONAL_BEST;
  if (personalBest && value < personalBest + 0.5) return TIMING_COLORS.SLOWER;
  if (personalBest && value > personalBest + 1.5) return TIMING_COLORS.VERY_SLOW;
  return TIMING_COLORS.DEFAULT;
}

/* -- Causal timing rows (pure, tested in __tests__/views.timing*.test.js) -- */
const SECTORS = [1, 2, 3];

function positiveTime(v, max) {
  return typeof v === 'number' && v > 0 && v < max ? v : null;
}

/** Each driver's lap rows, grouped once so driverStateAt scans only that driver's rows. */
function rowsByDriver(lapTimes) {
  const out = new Map();
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt?.Driver) continue;
    if (!out.has(lt.Driver)) out.set(lt.Driver, []);
    out.get(lt.Driver).push(lt);
  }
  return out;
}

/** The out-lap's pit exit has happened at now (session seconds). */
function pitExitPassed(lt, now) {
  if (!hasPitOut(lt)) return false;
  const exit = pitOutSeconds(lt);
  return exit != null ? exit <= now : isLapCompleted(lt, now);
}

/**
 * Timing-tower rows at sessionNow (session seconds), causal (decision R6,
 * utils/driverState.js):
 *  - with replay frames a driver's row is the lap in progress: only the sectors
 *    already run, a running chrono, the last completed lap's time; without
 *    frames (lap mode, live) the last completed lap, shown in full;
 *  - order, gap and interval come from each driver's last completed lap (a
 *    lap's position and gap are known at its end): more laps completed first,
 *    then the earlier line crossing; drivers with no completed lap by grid
 *    slot. Qualifying: by best completed lap;
 *  - tyre = the set in force (the new set from the pit exit), status Pit in
 *    the pit lane, retired only once the retirement has happened;
 *  - session and personal bests come from completed laps only.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds (useSessionNow), Infinity = whole session
 * @param {Object} [opts]
 * @param {Object} [opts.dnfMap] - store.dnfMap (driver did not finish; gated by time here)
 * @param {boolean} [opts.replayActive] - replay frames loaded (lap in progress + chrono)
 * @param {Object} [opts.gridPositions] - { driver: grid slot } (race_results GridPosition)
 * @param {Object} [opts.driverInfoMap] - { driver: { driverNumber } }
 * @param {boolean} [opts.qualifying] - order by best completed lap
 * @returns {Array<Object>} TimingRow entries, active drivers first
 */
export function timingTowerEntries(lapTimes, sessionNow, {
  dnfMap = {}, replayActive = false, gridPositions = {}, driverInfoMap = {}, qualifying = false,
} = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];

  // Session and personal bests over the laps completed at now
  const sessionBest = { 1: Infinity, 2: Infinity, 3: Infinity, lap: Infinity };
  const personalBest = {};
  for (const lt of rows) {
    if (!lt?.Driver || !isLapCompleted(lt, now)) continue;
    const pb = personalBest[lt.Driver] || (personalBest[lt.Driver] = { 1: Infinity, 2: Infinity, 3: Infinity, lap: Infinity });
    for (const k of SECTORS) {
      const v = positiveTime(lt[`Sector${k}TimeSeconds`], 300);
      if (v == null) continue;
      if (v < pb[k]) pb[k] = v;
      if (v < sessionBest[k]) sessionBest[k] = v;
    }
    const lap = positiveTime(lt.LapTimeSeconds, 300);
    if (lap != null) {
      if (lap < pb.lap) pb.lap = lap;
      if (lap < sessionBest.lap) sessionBest.lap = lap;
    }
  }
  const best = (v) => (v === Infinity ? null : v);

  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(rows, dnfMap);
  const rawEntries = [];
  for (const [drv, driverRows] of rowsByDriver(rows)) {
    const st = driverStateAt(driverRows, drv, now, { dnf: !!nonFinishers[drv] });
    const inProgress = st.retired ? null : st.inProgress;
    const shown = replayActive ? (inProgress || st.lastCompleted) : (st.lastCompleted || inProgress);
    if (!shown) continue; // no lap started yet
    const live = shown === inProgress;
    const pb = personalBest[drv] || {};
    const isPitIn = isPitVisible(shown, now);
    const isPitOut = pitExitPassed(shown, now);

    // Sectors: the lap in progress shows only those already run
    const sec = {};
    for (const k of SECTORS) {
      sec[k] = live ? st.visibleSectors[`s${k}`] : positiveTime(shown[`Sector${k}TimeSeconds`], 300);
      if (!(sec[k] > 0)) sec[k] = null;
    }
    // Lap time: the last completed lap's (the lap in progress has none yet)
    const lapRow = live ? st.lastCompleted : shown;
    const lapVal = lapRow ? positiveTime(lapRow.LapTimeSeconds, 300) : null;

    // Live chronometer in the sector being run (replay only, not in the pit lane)
    let s1Chrono = null, s2Chrono = null, s3Chrono = null, lapChrono = null;
    const start = live ? lapStartTime(shown) : null;
    if (replayActive && live && !st.inPitLane && start != null) {
      lapChrono = Math.max(0, now - start);
      if (sec[1] == null) s1Chrono = lapChrono;
      else if (sec[2] == null && shown.Sector1SessionTime > 0) s2Chrono = Math.max(0, now - shown.Sector1SessionTime);
      else if (sec[3] == null && shown.Sector2SessionTime > 0) s3Chrono = Math.max(0, now - shown.Sector2SessionTime);
    }

    const dnfInfo = st.retired ? (nonFinishers[drv] || null) : null;
    let statusColor = STATUS_COLORS.ON_TRACK;
    let statusLabel = 'On Track';
    if (st.retired) {
      statusColor = STATUS_COLORS.OUT;
      statusLabel = dnfInfo?.status || 'DNF';
    } else if (st.inPitLane) {
      statusColor = STATUS_COLORS.PIT;
      statusLabel = 'Pit';
    }

    const done = st.lastCompleted;
    const ranked = lastRankedLap(driverRows, drv, now);
    rawEntries.push({
      pos: 99,
      abbr: drv,
      driverNumber: driverInfoMap[drv]?.driverNumber || '',
      teamColor: getDriverColor(drv),
      gap: null,  // formatted after sorting
      gapRaw: done ? done.GapToLeader : null,
      s1: sec[1], s2: sec[2], s3: sec[3], lapTime: lapVal,
      s1Chrono, s2Chrono, s3Chrono, lapChrono,
      s1Color: getTimingColor(sec[1], best(sessionBest[1]), best(pb[1] ?? Infinity), isPitIn, isPitOut),
      s2Color: getTimingColor(sec[2], best(sessionBest[2]), best(pb[2] ?? Infinity), isPitIn, isPitOut),
      s3Color: getTimingColor(sec[3], best(sessionBest[3]), best(pb[3] ?? Infinity), isPitIn, isPitOut),
      lapTimeColor: getTimingColor(
        lapVal, best(sessionBest.lap), best(pb.lap ?? Infinity),
        lapRow ? isPitVisible(lapRow, now) : false, lapRow ? pitExitPassed(lapRow, now) : false,
      ),
      compound: st.compound || 'UNKNOWN',
      tyreLife: st.tyreLife,
      lapNumber: shown.LapNumber,
      statusColor, statusLabel,
      isDnf: st.retired,
      dnfStatus: dnfInfo?.status || null,
      // Sort keys (known at now), on the last lap that counts (lastRankedLap:
      // never the truncated row of a car that stopped on track)
      _laps: ranked ? Number(ranked.LapNumber) : 0,
      _crossed: ranked && Number.isFinite(ranked.Time) ? ranked.Time : Infinity,
      _position: ranked && Number.isFinite(ranked.Position) ? ranked.Position : Infinity,
      _grid: gridPositions[drv] ?? Infinity,
      _best: best(pb.lap ?? Infinity) ?? Infinity,
    });
  }

  // Active drivers in running order, retired drivers after them
  const order = qualifying
    ? (a, b) => (a._best - b._best) || (a._grid - b._grid)
    : (a, b) => (b._laps - a._laps) || (a._crossed - b._crossed)
      || (a._position - b._position) || (a._grid - b._grid);
  const active = rawEntries.filter((e) => !e.isDnf).sort(order);
  const retired = rawEntries.filter((e) => e.isDnf).sort(order);
  active.forEach((e, i) => { e.pos = i + 1; });
  retired.forEach((e, i) => { e.pos = active.length + i + 1; });
  const sorted = [...active, ...retired];

  return sorted.map(({ _laps, _crossed, _position, _grid, _best, ...entry }, idx) => {
    let interval = '---';
    if (idx > 0 && !entry.isDnf && !sorted[idx - 1].isDnf) {
      interval = formatInterval(entry.gapRaw, sorted[idx - 1].gapRaw);
    }
    const gap = formatGap(entry.gapRaw, entry.pos === 1);
    return { ...entry, gap, interval, isEvenRow: idx % 2 === 0 };
  });
}
