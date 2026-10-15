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
import {
  getDriverColor, STATUS_COLORS, STATUS_GLYPHS, TEXT_COLORS, TIMING_BANDS, timingBandColor,
} from '../colors';
import { hasPitOut, isLapCompleted, isPitVisible, lapStartTime, pitOutSeconds } from '../raceTime';
import { driverStateAt, lastRankedLap, nonFinisherMap } from '../driverState';

/* -- Timing colours: the one STATUS_COLORS map of utils/colors.js -------- */
// (F1 broadcast convention; pit in / out share the pit colour and differ by
// their letter, P / O, drawn with the time)
const TIMING_COLORS = {
  OVERALL_BEST: STATUS_COLORS.overallBest,   // purple + ◆ - session best
  PERSONAL_BEST: STATUS_COLORS.personalBest, // green + ● - personal best
  SLOWER: STATUS_COLORS.slower,              // yellow - beyond TIMING_BANDS.slower over the PB
  VERY_SLOW: STATUS_COLORS.muchSlower,       // orange - beyond TIMING_BANDS.muchSlower over the PB
  PIT_IN: STATUS_COLORS.pit,                 // pit + P - lap into the pits
  PIT_OUT: STATUS_COLORS.pit,                // pit + O - out-lap
  DEFAULT: STATUS_COLORS.normal,
};

/**
 * Legend rows of the timing tower (V4): every timing colour with the glyph
 * drawn next to the time, the running chrono and the status letters.
 *
 * @returns {Array<{label:string, color:string, glyph:string, shape:string}>}
 */
export function timingTowerLegend() {
  return [
    { label: 'Session best', color: TIMING_COLORS.OVERALL_BEST, glyph: STATUS_GLYPHS.overallBest, shape: 'glyph' },
    { label: 'PB', color: TIMING_COLORS.PERSONAL_BEST, glyph: STATUS_GLYPHS.personalBest, shape: 'glyph' },
    {
      label: `+${TIMING_BANDS.sector.slower}/${TIMING_BANDS.lap.slower} s off PB`, color: TIMING_COLORS.SLOWER, glyph: '31.2', shape: 'glyph',
      title: `More than ${TIMING_BANDS.sector.slower} s (sector) or ${TIMING_BANDS.lap.slower} s (lap) over the driver's personal best`,
    },
    {
      label: `+${TIMING_BANDS.sector.muchSlower}/${TIMING_BANDS.lap.muchSlower} s off`, color: TIMING_COLORS.VERY_SLOW, glyph: '31.2', shape: 'glyph',
      title: `More than ${TIMING_BANDS.sector.muchSlower} s (sector) or ${TIMING_BANDS.lap.muchSlower} s (lap) over the driver's personal best`,
    },
    { label: 'pit in / out', color: TIMING_COLORS.PIT_IN, glyph: `${STATUS_GLYPHS.pit} ${STATUS_GLYPHS.pitOut}`, shape: 'glyph' },
    { label: 'running', color: STATUS_COLORS.running, glyph: '12.3', shape: 'glyph' },
    { label: 'retired', color: STATUS_COLORS.retired, glyph: '✕', shape: 'glyph' },
  ];
}

/* -- Status column: a letter, never a coloured dot alone ----------------- */
const TRACK_STATE = {
  ON_TRACK: { color: TEXT_COLORS.muted, glyph: '' },
  PIT: { color: STATUS_COLORS.pit, glyph: STATUS_GLYPHS.pit },
  OUT: { color: STATUS_COLORS.retired, glyph: '✕' }, // ✕
};

// '+12.345'; from 100 s on '+102.3', so a gap never needs more than the
// seven characters its column holds (TimingTower.jsx COL)
function plusSeconds(v) {
  return `+${v >= 100 ? v.toFixed(1) : v.toFixed(3)}`;
}

function formatGap(gap, isLeader) {
  if (isLeader) return 'LEADER';
  if (gap == null || gap === 0) return '-';
  if (typeof gap === 'string') return gap;
  return plusSeconds(gap);
}

function formatInterval(currentGap, aheadGap) {
  if (currentGap == null || currentGap === 0) return '---';
  if (aheadGap == null) return '---';
  const diff = currentGap - aheadGap;
  if (diff <= 0) return '---';
  return plusSeconds(diff);
}

/* -- Determine timing color for a sector or lap value -------------------- */
// Bests come from completed laps only, so a sector of the lap in progress can
// beat them: at or below the best counts as that best
// Returns { color, glyph }: the glyph (◆ ● P O) is drawn with the time, so the
// colour is never the only cue. Slower times on the one ordered scale of
// TIMING_BANDS (utils/colors.js): normal, yellow, orange
function getTimingStatus(value, sessionBest, personalBest, isPitIn, isPitOut, kind = 'sector') {
  const cue = (color, glyph = '') => ({ color, glyph });
  if (!value || value <= 0) return cue(TIMING_COLORS.DEFAULT);
  if (isPitIn) return cue(TIMING_COLORS.PIT_IN, STATUS_GLYPHS.pit);
  if (isPitOut) return cue(TIMING_COLORS.PIT_OUT, STATUS_GLYPHS.pitOut);
  if (sessionBest && value <= sessionBest + 0.0005) return cue(TIMING_COLORS.OVERALL_BEST, STATUS_GLYPHS.overallBest);
  if (personalBest && value <= personalBest + 0.0005) return cue(TIMING_COLORS.PERSONAL_BEST, STATUS_GLYPHS.personalBest);
  if (personalBest && Number.isFinite(personalBest)) return cue(timingBandColor(value - personalBest, kind));
  return cue(TIMING_COLORS.DEFAULT);
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
 * @param {boolean} [opts.isLiveMode] - live feed rows (driverState.js nonFinisherMap)
 * @param {number} [opts.segmentStart] - qualifying segment replay: the order ranks only the
 *   segment's laps (LapStartTime after it; store qualiSegmentWindows[segment].start)
 * @returns {Array<Object>} TimingRow entries, active drivers first
 */
export function timingTowerEntries(lapTimes, sessionNow, {
  dnfMap = {}, replayActive = false, gridPositions = {}, driverInfoMap = {}, qualifying = false,
  isLiveMode = false, segmentStart = -Infinity,
} = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];

  // Session and personal bests over the laps completed at now
  const sessionBest = { 1: Infinity, 2: Infinity, 3: Infinity, lap: Infinity };
  const personalBest = {};
  // Qualifying order: each driver's best lap of the active segment (all laps
  // outside a segment replay)
  const segmentBest = {};
  const from = Number.isFinite(segmentStart) ? segmentStart : -Infinity;
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
      if (from === -Infinity || lapStartTime(lt) > from) {
        if (!(segmentBest[lt.Driver] <= lap)) segmentBest[lt.Driver] = lap;
      }
    }
  }
  const best = (v) => (v === Infinity ? null : v);

  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(rows, dnfMap, { live: isLiveMode });
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
    let trackState = TRACK_STATE.ON_TRACK;
    let statusLabel = 'On Track';
    if (st.retired) {
      trackState = TRACK_STATE.OUT;
      statusLabel = dnfInfo?.status || 'DNF';
    } else if (st.inPitLane) {
      trackState = TRACK_STATE.PIT;
      statusLabel = 'Pit';
    }
    const statusColor = trackState.color;
    const statusGlyph = trackState.glyph;
    const cues = {
      s1: getTimingStatus(sec[1], best(sessionBest[1]), best(pb[1] ?? Infinity), isPitIn, isPitOut),
      s2: getTimingStatus(sec[2], best(sessionBest[2]), best(pb[2] ?? Infinity), isPitIn, isPitOut),
      s3: getTimingStatus(sec[3], best(sessionBest[3]), best(pb[3] ?? Infinity), isPitIn, isPitOut),
      lap: getTimingStatus(
        lapVal, best(sessionBest.lap), best(pb.lap ?? Infinity),
        lapRow ? isPitVisible(lapRow, now) : false, lapRow ? pitExitPassed(lapRow, now) : false, 'lap',
      ),
    };

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
      s1Color: cues.s1.color, s2Color: cues.s2.color, s3Color: cues.s3.color, lapTimeColor: cues.lap.color,
      s1Glyph: cues.s1.glyph, s2Glyph: cues.s2.glyph, s3Glyph: cues.s3.glyph, lapTimeGlyph: cues.lap.glyph,
      compound: st.compound || 'UNKNOWN',
      tyreLife: st.tyreLife,
      lapNumber: shown.LapNumber,
      statusColor, statusLabel, statusGlyph,
      isDnf: st.retired,
      dnfStatus: dnfInfo?.status || null,
      // Sort keys (known at now), on the last lap that counts (lastRankedLap:
      // never the truncated row of a car that stopped on track)
      _laps: ranked ? Number(ranked.LapNumber) : 0,
      _crossed: ranked && Number.isFinite(ranked.Time) ? ranked.Time : Infinity,
      _position: ranked && Number.isFinite(ranked.Position) ? ranked.Position : Infinity,
      _grid: gridPositions[drv] ?? Infinity,
      _best: segmentBest[drv] ?? Infinity,
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
