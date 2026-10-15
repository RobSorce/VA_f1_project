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
import {
  STATUS_COLORS, STATUS_GLYPHS, TEXT_COLORS, withAlpha, tintedChip, TIMING_BANDS,
} from '../colors';

/* -- Cell styles: the one STATUS_COLORS map of utils/colors.js ------------- */
// Pace against the driver's median: fast (blue) / normal / slower (yellow) /
// much slower (orange), an ordered scale that stays apart under every vision
// type (cvd_check.txt); session and personal bests in the timing purple /
// green with their glyph, pit laps with P / O, a retirement with its text.
const tint = (c, a) => ({ background: withAlpha(c, a), color: tintedChip(c, a).color });
export const PACE_CELL_STYLES = {
  'session-best': { ...tint(STATUS_COLORS.overallBest, 0.22), fontWeight: 700 },
  'personal-best': { ...tint(STATUS_COLORS.personalBest, 0.16), fontWeight: 600 },
  'good': { color: STATUS_COLORS.fast },
  'slower': { color: STATUS_COLORS.slower },
  'very-slow': { color: STATUS_COLORS.muchSlower, fontWeight: 600 },
  'pit-in': { ...tint(STATUS_COLORS.pit, 0.2), fontWeight: 700 },
  'pit-out': { ...tint(STATUS_COLORS.pit, 0.1) },
  'default': { color: STATUS_COLORS.normal },
  'empty': { color: TEXT_COLORS.muted },
  'future': { background: 'rgba(255,255,255,0.008)', color: 'transparent' },
  'dnf': { color: STATUS_COLORS.retired, fontWeight: 700 },
  'live-chrono': { color: STATUS_COLORS.running, fontStyle: 'italic', fontWeight: 700 },
};

// Glyph drawn before the cell text (the redundant cue of each colour)
export const PACE_CELL_GLYPHS = {
  'session-best': STATUS_GLYPHS.overallBest,
  'personal-best': STATUS_GLYPHS.personalBest,
  'pit-in': STATUS_GLYPHS.pit,
  'pit-out': STATUS_GLYPHS.pitOut,
};

/**
 * Legend rows of the pace grid (V4): every cell colour with the glyph or the
 * sample text it is drawn with; the pace scale is ordered fast -> much slower.
 */
export function paceLegend() {
  return [
    { label: 'Session best', color: STATUS_COLORS.overallBest, glyph: STATUS_GLYPHS.overallBest, shape: 'glyph' },
    { label: 'Personal best', color: STATUS_COLORS.personalBest, glyph: STATUS_GLYPHS.personalBest, shape: 'glyph' },
    { label: `Fast (> ${TIMING_BANDS.lap.fast} s under median)`, color: STATUS_COLORS.fast, glyph: '1:21', shape: 'glyph' },
    { label: 'Normal', color: STATUS_COLORS.normal, glyph: '1:22', shape: 'glyph' },
    { label: `Slow (+${TIMING_BANDS.lap.slower} s)`, color: STATUS_COLORS.slower, glyph: '1:23', shape: 'glyph' },
    { label: `Very slow (+${TIMING_BANDS.lap.muchSlower} s)`, color: STATUS_COLORS.muchSlower, glyph: '1:25', shape: 'glyph' },
    { label: 'Pit in', color: STATUS_COLORS.pit, glyph: STATUS_GLYPHS.pit, shape: 'glyph' },
    { label: 'Pit out', color: STATUS_COLORS.pit, glyph: STATUS_GLYPHS.pitOut, shape: 'glyph' },
    { label: 'Lap running', color: STATUS_COLORS.running, glyph: '12.3', shape: 'glyph' },
  ];
}

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
// (the lap bands of TIMING_BANDS, utils/colors.js: the same yellow / orange
// thresholds as the Timing Tower and the Pit Wall panel, against the median)
const paceColorScale = d3.scaleThreshold()
  .domain([-TIMING_BANDS.lap.fast, TIMING_BANDS.lap.slower, TIMING_BANDS.lap.muchSlower])
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
 * @param {Object} [opts] - { dnfMap, isLiveMode (live feed rows: driverState.js nonFinisherMap) }
 */
export function paceGridData(lapTimes, sessionNow, { dnfMap = {}, isLiveMode = false } = {}) {
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
  const nonFinishers = nonFinisherMap(rows, dnfMap, { live: isLiveMode });
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

/* -- Fit to the panel (V5 / V13: the grid never scrolls) ------------------- */
// Cell widths in CSS px: the widest cell holds the glyph and a full lap time
// (◆ 1:21.123) at the data font; cells shrink to the panel width down to
// PACE_CELL_MIN_W, then the driver columns are paged. Rows: PACE_ROW_MAX px
// while every lap fits, down to PACE_ROW_MIN, then the laps are paged.
export const PACE_CELL_MAX_W = 78;
export const PACE_CELL_MIN_W = 36;
export const PACE_LAP_COL_W = 34;
export const PACE_HEADER_H = 30;
export const PACE_ROW_MIN = 18;
export const PACE_ROW_MAX = 26;
// Advance of one JetBrains Mono character (em) and the cell's side padding (px)
const MONO_EM = 0.6;
const CELL_PAD_PX = 4;

/**
 * Columns of the grid in a box `width` px wide: the cell width, how many
 * driver columns one page holds, and the label format the cell holds at the
 * data font: 'full' (◆ 1:21.123), 'seconds' (◆21.123) or 'short' (◆21.1);
 * the full time is always in the cell's tooltip. An unmeasured box (0, a
 * server render) gives the widest cells, every driver and the full format.
 *
 * @param {number} width - px of the grid area
 * @param {number} nDrivers
 * @param {number} [fontPx=11] - the data font size (colors.js chartFontPx)
 * @returns {{cellW: number, perPage: number, paged: boolean, format: 'full'|'seconds'|'short'}}
 */
export function paceColumns(width, nDrivers, fontPx = 11) {
  const n = Math.max(1, Math.floor(Number(nDrivers) || 0));
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return { cellW: PACE_CELL_MAX_W, perPage: n, paged: false, format: 'full' };
  const room = Math.max(0, w - PACE_LAP_COL_W);
  let cellW = Math.min(PACE_CELL_MAX_W, Math.floor(room / n));
  let perPage = n;
  if (cellW < PACE_CELL_MIN_W) {
    cellW = PACE_CELL_MIN_W;
    perPage = Math.max(1, Math.floor(room / PACE_CELL_MIN_W));
  }
  const chars = Math.floor((cellW - CELL_PAD_PX) / (MONO_EM * fontPx));
  // glyph + space + 1:21.123 = 10 characters, glyph + 21.123 = 7, glyph + 21.1 = 5
  const format = chars >= 10 ? 'full' : chars >= 7 ? 'seconds' : 'short';
  return { cellW, perPage, paged: perPage < n, format };
}

/**
 * A time label in a column format: '1:21.123' -> '21.123' (seconds) or
 * '21.1' (short); any other label (RET, IN PIT, -) unchanged.
 *
 * @param {string} label
 * @param {'full'|'seconds'|'short'} format
 * @returns {string}
 */
export function paceLabel(label, format) {
  if (format === 'full' || typeof label !== 'string') return label;
  const m = label.match(/^(?:\d+:)?(\d{1,2}\.\d{3})$/);
  if (!m) return label;
  return format === 'seconds' ? m[1] : Number(m[1]).toFixed(1);
}

/**
 * The laps a fitted grid shows: every lap when they fit, else `perPage`
 * laps ending at the lap in progress (the most recent ones, the replay
 * followed), or ending at `pinnedLast` when the user paged back to older
 * laps (◀ older / ▶ newer); a pinned window at or past the lap in progress
 * follows the replay again.
 *
 * @param {number} nLaps - laps of the grid
 * @param {number} currentLap
 * @param {number} perPage - laps that fit
 * @param {number|null} [pinnedLast] - last lap of a window the user paged to
 * @returns {{first: number, last: number, size: number, following: boolean, canOlder: boolean, canNewer: boolean}}
 */
export function paceLapWindow(nLaps, currentLap, perPage, pinnedLast = null) {
  const n = Math.max(0, Math.floor(Number(nLaps) || 0));
  const size = Math.max(1, Math.floor(Number(perPage) || 1));
  if (n === 0) return { first: 1, last: 0, size: 0, following: true, canOlder: false, canNewer: false };
  if (size >= n) return { first: 1, last: n, size: n, following: true, canOlder: false, canNewer: false };
  const anchor = Math.min(n, Math.max(size, Math.floor(Number(currentLap) || 0)));
  const pinned = pinnedLast != null && Number.isFinite(pinnedLast) && pinnedLast < anchor
    ? Math.max(size, Math.floor(pinnedLast))
    : null;
  const last = pinned ?? anchor;
  return { first: last - size + 1, last, size, following: pinned == null, canOlder: last > size, canNewer: pinned != null };
}
