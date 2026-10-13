/**
 * View model of the sectors panel (components/visualizations/SectorsPanel.jsx):
 * live sector rows, best-sector and speed rankings at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { isLapCompleted, lapStartTime } from '../raceTime';
import { driverStateAt, nonFinisherMap } from '../driverState';

const TIME_COLORS = {
  overall_best: '#A020F0',
  personal_best: '#00FF00',
  normal: 'var(--color-text-primary)',
};

export const SPEED_COLS = [
  { key: 'SpeedI1', label: 'Sector 1' },
  { key: 'SpeedI2', label: 'Sector 2' },
  { key: 'SpeedFL', label: 'Finish Line' },
  { key: 'SpeedST', label: 'Speed Trap' },
];

function positiveTime(v) {
  return typeof v === 'number' && v > 0 && v < 300 ? v : null;
}

/**
 * Sector views at sessionNow (session seconds), causal (decision R6,
 * utils/driverState.js):
 *  - live rows: with replay frames each driver's lap in progress (only the
 *    sectors already run, chronometers), otherwise the last completed lap;
 *    retired drivers drop out once the retirement has happened; order as the
 *    timing tower (laps completed, then line crossing);
 *  - colours, best-sector rankings and top speeds from completed laps only.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @param {Object} [opts] - { dnfMap, replayActive }
 * @returns {{ liveRows: Array<Object>, bestRankings: Object, bestSessionBests: Object,
 *   speedRankings: Object }}
 */
export function sectorsPanelData(lapTimes, sessionNow, { dnfMap = {}, replayActive = false } = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];

  const sessionBests = { 1: Infinity, 2: Infinity, 3: Infinity };
  const personalBests = {};
  const driverSectors = {};
  const driverSpeeds = Object.fromEntries(SPEED_COLS.map(({ key }) => [key, {}]));
  const byDriver = new Map();
  for (const lt of rows) {
    const drv = lt?.Driver;
    if (!drv) continue;
    if (!byDriver.has(drv)) byDriver.set(drv, []);
    byDriver.get(drv).push(lt);
    if (!isLapCompleted(lt, now)) continue;
    if (!personalBests[drv]) personalBests[drv] = { 1: Infinity, 2: Infinity, 3: Infinity };
    if (!driverSectors[drv]) driverSectors[drv] = { 1: [], 2: [], 3: [] };
    for (const s of [1, 2, 3]) {
      const val = positiveTime(lt[`Sector${s}TimeSeconds`]);
      if (val == null) continue;
      if (val < sessionBests[s]) sessionBests[s] = val;
      if (val < personalBests[drv][s]) personalBests[drv][s] = val;
      driverSectors[drv][s].push(val);
    }
    for (const { key } of SPEED_COLS) {
      const val = lt[key];
      if (val == null || typeof val !== 'number' || isNaN(val) || val <= 0) continue;
      const cur = driverSpeeds[key][drv];
      if (!cur || val > cur.speed) driverSpeeds[key][drv] = { speed: val, lap: lt.LapNumber };
    }
  }

  // Live view: one row per running driver (results DNFs and classified
  // drivers who stopped before the flag leave it once retired)
  const nonFinishers = nonFinisherMap(rows, dnfMap);
  const live = [];
  for (const [drv, driverRows] of byDriver) {
    const st = driverStateAt(driverRows, drv, now, { dnf: !!nonFinishers[drv] });
    if (st.retired) continue;
    const d = replayActive ? (st.inProgress || st.lastCompleted) : (st.lastCompleted || st.inProgress);
    if (!d) continue;
    const isLive = d === st.inProgress;
    const pb = personalBests[drv] || { 1: Infinity, 2: Infinity, 3: Infinity };
    const sectors = [1, 2, 3].map((s) => {
      const val = isLive ? st.visibleSectors[`s${s}`] : positiveTime(d[`Sector${s}TimeSeconds`]);
      const show = val != null;
      let color = TIME_COLORS.normal;
      if (show) {
        const tolerance = 0.001;
        if (val <= sessionBests[s] + tolerance) color = TIME_COLORS.overall_best;
        else if (val <= pb[s] + tolerance) color = TIME_COLORS.personal_best;
      }
      return { val, show: isLive ? show : true, color };
    });

    // Live chronometer for the sector being run (replay only)
    let chrono = null;
    let runningLap = null;
    const start = isLive ? lapStartTime(d) : null;
    if (replayActive && isLive && start != null) {
      runningLap = Math.max(0, now - start);
      if (!sectors[0].show) chrono = { sector: 1, elapsed: runningLap };
      else if (!sectors[1].show && d.Sector1SessionTime > 0) chrono = { sector: 2, elapsed: Math.max(0, now - d.Sector1SessionTime) };
      else if (!sectors[2].show && d.Sector2SessionTime > 0) chrono = { sector: 3, elapsed: Math.max(0, now - d.Sector2SessionTime) };
    }

    const done = st.lastCompleted;
    live.push({
      driver: drv,
      pos: 99,
      lap: d.LapNumber,
      sectors,
      chrono,
      runningLap,
      lapTime: isLive ? null : d.LapTimeSeconds,
      _laps: st.lapsCompleted,
      _crossed: done && Number.isFinite(done.Time) ? done.Time : Infinity,
      _position: done && Number.isFinite(done.Position) ? done.Position : Infinity,
    });
  }
  live.sort((a, b) => (b._laps - a._laps) || (a._crossed - b._crossed)
    || (a._position - b._position) || a.driver.localeCompare(b.driver));
  const liveRows = live.map(({ _laps, _crossed, _position, ...r }, i) => ({ ...r, pos: i + 1 }));

  // Best-of-session rankings (completed laps)
  const bestSessionBests = {};
  const bestRankings = {};
  if (Object.keys(driverSectors).length > 0) {
    for (const s of [1, 2, 3]) {
      const allTimes = [];
      for (const [drv, secs] of Object.entries(driverSectors)) {
        if (secs[s].length > 0) {
          const bestTime = Math.min(...secs[s]);
          allTimes.push({ driver: drv, best: Math.round(bestTime * 1000) / 1000 });
        }
      }
      allTimes.sort((a, b) => a.best - b.best);
      const sessionBest = allTimes.length > 0 ? allTimes[0].best : null;
      bestSessionBests[String(s)] = sessionBest;
      allTimes.forEach((entry, i) => {
        entry.rank = i + 1;
        entry.is_session_best = entry.best === sessionBest;
      });
      bestRankings[String(s)] = allTimes;
    }
  }

  // Speed rankings (speed traps of completed laps)
  const speedRankings = {};
  if (rows.length > 0) {
    for (const { key } of SPEED_COLS) {
      speedRankings[key] = Object.entries(driverSpeeds[key])
        .sort(([, a], [, b]) => b.speed - a.speed)
        .map(([driver, { speed, lap }], i) => ({
          driver, speed: Math.round(speed * 10) / 10, lap, rank: i + 1,
        }));
    }
  }

  return { liveRows, bestRankings, bestSessionBests, speedRankings };
}
