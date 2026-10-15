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
import { STATUS_COLORS, STATUS_GLYPHS } from '../colors';
import { sectorsBestLegend } from './sectorsBestChart';

// Timing colours: the one STATUS_COLORS map of utils/colors.js, each with its
// glyph (◆ overall best, ● personal best) so colour is never the only cue
const TIME_COLORS = {
  overall_best: STATUS_COLORS.overallBest,
  personal_best: STATUS_COLORS.personalBest,
  normal: STATUS_COLORS.normal,
};
const TIME_GLYPHS = {
  overall_best: STATUS_GLYPHS.overallBest,
  personal_best: STATUS_GLYPHS.personalBest,
  normal: '',
};

/**
 * Legend rows of the sectors panel (V4), per tab: every colour the tab draws
 * with the glyph or shape drawn next to it.
 *
 * @param {'live'|'best'|'speeds'} view
 * @returns {Array<{label:string, color:string, glyph?:string, shape:string}>}
 */
export function sectorsLegend(view) {
  // Best: the D3 chart of the gap to the session best (sectorsBestChart.js, D5)
  if (view === 'best') return sectorsBestLegend();
  if (view === 'live') {
    return [
      { label: 'Session best', color: STATUS_COLORS.overallBest, glyph: STATUS_GLYPHS.overallBest, shape: 'glyph' },
      { label: 'Personal best', color: STATUS_COLORS.personalBest, glyph: STATUS_GLYPHS.personalBest, shape: 'glyph' },
      { label: 'Other sector', color: STATUS_COLORS.normal, glyph: '31.2', shape: 'glyph' },
      { label: 'Sector running', color: STATUS_COLORS.running, glyph: '12.3', shape: 'glyph' },
    ];
  }
  return [
    { label: 'Fastest', color: STATUS_COLORS.overallBest, glyph: STATUS_GLYPHS.overallBest, shape: 'glyph' },
  ];
}

// Bar of a driver who does not hold the best sector (neutral: rank is the text)
export const SECTOR_BAR_COLOR = STATUS_COLORS.running;

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
 * @param {Object} [opts] - { dnfMap, replayActive, isLiveMode (live feed rows:
 *   driverState.js nonFinisherMap) }
 * @returns {{ liveRows: Array<Object>, bestRankings: Object, bestSessionBests: Object,
 *   speedRankings: Object }}
 */
export function sectorsPanelData(lapTimes, sessionNow, { dnfMap = {}, replayActive = false, isLiveMode = false } = {}) {
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
  const nonFinishers = nonFinisherMap(rows, dnfMap, { live: isLiveMode });
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
      let status = 'normal';
      if (show) {
        const tolerance = 0.001;
        if (val <= sessionBests[s] + tolerance) status = 'overall_best';
        else if (val <= pb[s] + tolerance) status = 'personal_best';
      }
      return {
        val, show: isLive ? show : true, color: TIME_COLORS[status], glyph: TIME_GLYPHS[status],
      };
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

/* ── Fit of the rows and the ranked columns to the panel (Phase 9c D1) ──
   The panel never scrolls and never cuts a row: the rows take the height
   (SECTORS_ROW_MAX px down to SECTORS_ROW_MIN, the 18 px floor of a data
   row), else they are paged, the same page of ranks in every column; the
   ranked columns (Best, Top Speeds) take the width, at least
   SECTORS_COL_EM data-type ems each, else they are paged too. The browser
   pass found 20 rows drawn into overflow-hidden bodies, cut with no pager. */
export const SECTORS_ROW_MIN = 18;
export const SECTORS_ROW_MAX = 26;
/** Height of the pager line under the rows (px, its border included). */
export const SECTORS_PAGER_H = 22;
export const SECTORS_COL_GAP = 8;
/**
 * Minimum width of a ranked column, in data-type ems: rank, team bar, code,
 * the time or speed with its glyph and the gap to the best on one line
 * (16 x 11 px = 176 px; real font widths in __tests__/sectors.fit.test.jsx).
 */
export const SECTORS_COL_EM = 16;

/**
 * Rows of a table fitted to a height (the rule of utils/views/chartBox.js
 * fitRows, kept here so this module stays free of React): every row when
 * they fit at the minimum (then as tall as the room allows, up to the
 * maximum), else as many per page as fit next to the pager. An unknown
 * height (0, null: not measured, a server render) shows every row.
 *
 * @param {number|null} height - px for the rows and the pager line
 * @param {number} n - rows
 * @returns {{rowH: number, perPage: number, paged: boolean}}
 */
export function sectorsRowFit(height, n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0 || count === 0) {
    return { rowH: SECTORS_ROW_MAX, perPage: Math.max(1, count), paged: false };
  }
  if (count * SECTORS_ROW_MIN <= h) {
    return {
      rowH: Math.max(SECTORS_ROW_MIN, Math.min(SECTORS_ROW_MAX, Math.floor(h / count))), perPage: count, paged: false,
    };
  }
  const perPage = Math.max(1, Math.floor((h - SECTORS_PAGER_H) / SECTORS_ROW_MIN));
  return { rowH: SECTORS_ROW_MIN, perPage, paged: perPage < count };
}

/**
 * Ranked columns that fit a width side by side (at least 1, at most n).
 *
 * @param {number} width - px of the columns' row
 * @param {number} n - columns
 * @param {number} minColW - px a column needs
 * @param {number} [gap]
 * @returns {number}
 */
export function sectorsColumnsFit(width, n, minColW, gap = SECTORS_COL_GAP) {
  const count = Math.max(1, Math.floor(Number(n) || 0));
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return count;
  return Math.max(1, Math.min(count, Math.floor((w + gap) / (minColW + gap))));
}
