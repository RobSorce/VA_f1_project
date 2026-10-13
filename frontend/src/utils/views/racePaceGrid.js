/**
 * View model of the race pace grid (components/visualizations/RacePaceGrid.jsx):
 * the causal grid data and one cell's label, style and tooltip at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no store access; D3 only for the pace threshold scale.
 */
import * as d3 from 'd3';
import { isLapCompleted, lapStartTime } from '../raceTime';
import { driverStateAt, nonFinisherMap } from '../driverState';
import { pitStops } from '../stints';
import { pitCountsByDriver } from '../strategyViews';

/* -- Format helpers -------------------------------------------------------- */
function formatLapTime(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

function formatSector(seconds) {
  if (!seconds || seconds <= 0) return '';
  return seconds.toFixed(1);
}

/* -- D3 threshold scale for pace classification (delta from driver median) -- */
const paceColorScale = d3.scaleThreshold()
  .domain([-0.3, 0.5, 2.0])
  .range(['good', 'default', 'slower', 'very-slow']);

/* -- Classify a cell ------------------------------------------------------- */
function classifyCell(lapEntry, lap, currentLap, sessionBest, driverBest, dnfInfo, driverMedian) {
  if (lap > currentLap) return { label: '', style: 'future' };

  if (dnfInfo) {
    if (lap > dnfInfo.lastLap + 1) return { label: '', style: 'future' };
    if (lap === dnfInfo.lastLap + 1) {
      const status = dnfInfo.status || 'RET';
      const short = status.length > 4 ? 'RET' : status;
      return { label: short, style: 'dnf' };
    }
  }

  if (!lapEntry) return { label: '-', style: 'empty' };

  const { LapTimeSeconds, PitInTime, PitOutTime } = lapEntry;

  if (PitInTime) {
    const time = LapTimeSeconds > 0 ? formatLapTime(LapTimeSeconds) : 'IN PIT';
    return { label: time, style: 'pit-in' };
  }

  if (PitOutTime) {
    const time = LapTimeSeconds > 0 ? formatLapTime(LapTimeSeconds) : 'OUT';
    return { label: time, style: 'pit-out' };
  }

  if (!LapTimeSeconds || LapTimeSeconds <= 0) return { label: '-', style: 'empty' };

  const time = LapTimeSeconds;
  const label = formatLapTime(time);

  // Session best: within 0.010s
  if (sessionBest && Math.abs(time - sessionBest) < 0.010)
    return { label, style: 'session-best' };
  // Personal best: within 0.010s
  if (driverBest && Math.abs(time - driverBest) < 0.010)
    return { label, style: 'personal-best' };

  // D3 threshold scale: delta from driver median → pace classification
  if (driverMedian) {
    const delta = time - driverMedian;
    return { label, style: paceColorScale(delta) };
  }

  return { label, style: 'default' };
}

/* -- Build tooltip string -------------------------------------------------- */
function buildTooltip(driver, lap, lapEntry) {
  if (!lapEntry) return `${driver} - Lap ${lap}: no data`;
  const parts = [`${driver} - Lap ${lap}`];
  if (lapEntry.LapTimeSeconds > 0) parts.push(`: ${formatLapTime(lapEntry.LapTimeSeconds)}`);
  const sectors = [];
  if (lapEntry.Sector1TimeSeconds > 0) sectors.push(`S1: ${formatSector(lapEntry.Sector1TimeSeconds)}`);
  if (lapEntry.Sector2TimeSeconds > 0) sectors.push(`S2: ${formatSector(lapEntry.Sector2TimeSeconds)}`);
  if (lapEntry.Sector3TimeSeconds > 0) sectors.push(`S3: ${formatSector(lapEntry.Sector3TimeSeconds)}`);
  if (sectors.length) parts.push(` (${sectors.join(', ')})`);
  if (lapEntry.Compound) {
    const life = lapEntry.TyreLife != null ? ` L${lapEntry.TyreLife}` : '';
    parts.push(` - ${lapEntry.Compound}${life}`);
  }
  return parts.join('');
}

/* -- Causal grid data (pure, tested in __tests__/views.timing*.test.js) ---- */
/**
 * Everything the pace grid shows at sessionNow (session seconds), causal
 * (decision R6, utils/driverState.js):
 *  - lapLookup: lap rows completed at now ("driver_lap" -> row); bests and
 *    medians come from these only;
 *  - state: per driver the lap in progress (chrono / IN PIT cell, never its
 *    time), laps completed, pit lane, and the retirement once it happened;
 *  - pitCounts: tyre changes visible at now (utils/stints.js pitStops, R2).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} sessionNow - session seconds, Infinity = whole race
 * @param {Object} [opts] - { dnfMap }
 */
export function paceGridData(lapTimes, sessionNow, { dnfMap = {} } = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];
  const lookup = {};
  const driverMins = {};
  const driverCleanLaps = {};   // driver -> [clean lap times]
  const byDriver = new Map();
  let globalMin = Infinity;

  for (const lt of rows) {
    if (!lt.Driver || !lt.LapNumber) continue;
    if (!byDriver.has(lt.Driver)) byDriver.set(lt.Driver, []);
    byDriver.get(lt.Driver).push(lt);
    if (!isLapCompleted(lt, now)) continue;
    lookup[`${lt.Driver}_${lt.LapNumber}`] = lt;

    const time = lt.LapTimeSeconds;
    if (time && time > 0 && !lt.PitInTime && !lt.PitOutTime) {
      if (time < globalMin) globalMin = time;
      if (!driverMins[lt.Driver] || time < driverMins[lt.Driver])
        driverMins[lt.Driver] = time;

      // Collect clean laps: exclude lap 1, pit in/out, times >= 300s or <= 0
      if (lt.LapNumber > 1 && time < 300) {
        if (!driverCleanLaps[lt.Driver]) driverCleanLaps[lt.Driver] = [];
        driverCleanLaps[lt.Driver].push(time);
      }
    }
  }

  // Compute median per driver from clean laps
  const medians = {};
  for (const [driver, times] of Object.entries(driverCleanLaps)) {
    if (times.length === 0) continue;
    const sorted = times.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medians[driver] = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(rows, dnfMap);
  const state = {};
  for (const [drv, driverRows] of byDriver) {
    const st = driverStateAt(driverRows, drv, now, { dnf: !!nonFinishers[drv] });
    state[drv] = {
      running: st.inProgress,
      lapsCompleted: st.lapsCompleted,
      inPitLane: st.inPitLane,
      // dnfMap status only once the retirement has happened; the RET cell is
      // on the lap of the retirement, from the rows (driverStateAt
      // retiredLap), never race_results Laps (a final result)
      dnf: st.retired
        ? { status: nonFinishers[drv]?.status || 'RET', lastLap: (st.retiredLap ?? st.lapsCompleted + 1) - 1 }
        : null,
    };
  }

  return {
    lapLookup: lookup,
    state,
    pitCounts: pitCountsByDriver(pitStops(rows, { sessionNow: now })),
    sessionBest: globalMin < Infinity ? globalMin : null,
    driverBests: driverMins,
    driverMedians: medians,
  };
}

/**
 * One pace-grid cell at sessionNow: { label, style, tooltip }. A completed lap
 * shows its time; the lap in progress a chrono (replay frames) or IN PIT while
 * the car is in the pit lane, never its time; laps not run yet are blank; RET
 * after the last lap once the retirement has happened.
 *
 * @param {Object} data - paceGridData output at the same sessionNow
 * @param {string} abbr
 * @param {number} lap
 * @param {Object} opts - { currentLap, replayActive, sessionNow }
 */
export function paceCell(data, abbr, lap, { currentLap, replayActive, sessionNow }) {
  const st = data.state[abbr] || { running: null, lapsCompleted: 0, inPitLane: false, dnf: null };
  const lapEntry = data.lapLookup[`${abbr}_${lap}`] || null;
  // (a retired driver has no lap running: his last lap is the RET cell)
  const runEntry = !lapEntry && !st.dnf && st.running && st.running.LapNumber === lap ? st.running : null;
  if (runEntry) {
    if (st.inPitLane) {
      // Pit lane: the lap time is not known yet
      return { label: 'IN PIT', style: 'pit-in', tooltip: `${abbr} - Lap ${lap}: in progress` };
    }
    const runStart = lapStartTime(runEntry);
    if (replayActive && runStart != null && runStart <= sessionNow) {
      // Live chrono: the driver's lap is still running in replay time
      return {
        label: formatLapTime(Math.max(0, sessionNow - runStart)),
        style: 'live-chrono',
        tooltip: `${abbr} - Lap ${lap}: in progress`,
      };
    }
    return { label: '', style: 'future', tooltip: `${abbr} - Lap ${lap}: in progress` };
  }
  if (!lapEntry && !st.dnf && lap > st.lapsCompleted) {
    // Not run yet by this driver
    return { label: '', style: 'future', tooltip: `${abbr} - Lap ${lap}: not run yet` };
  }
  const classified = classifyCell(
    lapEntry, lap, currentLap, data.sessionBest, data.driverBests[abbr] || null,
    st.dnf, data.driverMedians[abbr] || null,
  );
  return { label: classified.label, style: classified.style, tooltip: buildTooltip(abbr, lap, lapEntry) };
}
