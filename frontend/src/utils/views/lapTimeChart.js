/**
 * View model of the lap timing sheet (components/visualizations/LapTimeChart.jsx):
 * the causal timing-sheet rows, their colour codes and the qualifying
 * segment badges at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { hasPitOut, isLapCompleted, isPitVisible, lapStartTime, pitOutSeconds } from '../raceTime';
import { driverStateAt, nonFinisherMap } from '../driverState';
import { STATUS_COLORS, STATUS_GLYPHS, DIVERGING, TEXT_COLORS } from '../colors';

/* ── Color codes for sector/lap timing: the STATUS_COLORS map of utils/colors.js ── */
// (F1 TV convention; each drawn with its glyph, see timingSheetLegend)
export const TIME_COLORS = {
  overall_best: STATUS_COLORS.overallBest, // purple + ◆ — overall best in the session
  personal_best: STATUS_COLORS.personalBest, // green + ● — personal best
  normal: STATUS_COLORS.normal, // white/grey — normal
  slow: STATUS_COLORS.slower, // yellow — significantly slower
  pit: STATUS_COLORS.pit, // pit colour + the text PIT — pit lap
};

/**
 * Legend rows of the timing sheet (V4): every colour the sheet draws, with the
 * glyph / text drawn next to it, so the swatch is the mark itself.
 *
 * @param {{forecast?: boolean}} [opts] - forecast rows on screen (focus driver)
 * @returns {Array<{label:string, color:string, glyph:string, shape:string}>}
 */
export function timingSheetLegend({ forecast = false } = {}) {
  const items = [
    { label: 'Overall best', color: STATUS_COLORS.overallBest, glyph: STATUS_GLYPHS.overallBest, shape: 'glyph' },
    { label: 'Personal best', color: STATUS_COLORS.personalBest, glyph: STATUS_GLYPHS.personalBest, shape: 'glyph' },
    { label: 'Pit lap', color: STATUS_COLORS.pit, glyph: 'PIT', shape: 'glyph' },
    { label: 'Lap running', color: STATUS_COLORS.running, glyph: '12.3', shape: 'glyph' },
  ];
  if (forecast) {
    items.push(
      { label: 'Forecast', color: STATUS_COLORS.predicted, glyph: 'L', shape: 'glyph' },
      { label: 'Faster', color: DIVERGING.better, glyph: '−', shape: 'glyph' },
      { label: 'Slower', color: DIVERGING.worse, glyph: '+', shape: 'glyph' },
    );
  }
  return items;
}

/**
 * Legend rows of the forecast mini-chart (V4): solid line = laps run, dashed
 * line = forecast, shaded band = ± the method's held-out MAE.
 *
 * @param {string} color - the focus driver's colour
 * @param {boolean} hasBand - a held-out MAE exists (the band is drawn)
 */
export function forecastChartLegend(color, hasBand) {
  const items = [
    { label: 'Laps run', color, shape: 'line' },
    { label: 'Forecast', color, shape: 'line', dash: '6,4' },
  ];
  if (hasBand) items.push({ label: '± held-out MAE', color, shape: 'band' });
  items.push({ label: 'Forecast origin', color: TEXT_COLORS.muted, shape: 'line', dash: '2,2', strokeWidth: 1.5 });
  return items;
}

/**
 * Store update of the timing sheet's lap-range brush (V7): the shared brushed
 * range (brushLapRange: Position by Lap draws and sets the same range, the
 * sheet's bests and Tyre Degradation read it) and selectedLapRange (Strategy
 * Timeline, Telemetry); a click (null) clears both.
 *
 * @param {[number, number]|null} range
 * @returns {{brushLapRange: ([number, number]|null), selectedLapRange: ([number, number]|null)}}
 */
export function lapBrushUpdate(range) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) {
    return { brushLapRange: null, selectedLapRange: null };
  }
  const r = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
  return { brushLapRange: r, selectedLapRange: r };
}

/* ── Causal timing sheet (pure, tested in __tests__/views.timing*.test.js) ── */
function positiveTime(v, max) {
  return typeof v === 'number' && v > 0 && v < max ? v : null;
}

/** The out-lap's pit exit has happened at now (session seconds). */
function pitExitPassed(lt, now) {
  if (!hasPitOut(lt)) return false;
  const exit = pitOutSeconds(lt);
  return exit != null ? exit <= now : isLapCompleted(lt, now);
}

/** Purple / green / white; bests come from completed laps, so a value at or below one is that best. */
function timeColor(value, sessionBest, personalBest, isPit) {
  if (!value || value <= 0 || value > 300) return TIME_COLORS.normal;
  if (isPit) return TIME_COLORS.pit;
  const tolerance = 0.001;
  if (value <= sessionBest + tolerance) return TIME_COLORS.overall_best;
  if (value <= personalBest + tolerance) return TIME_COLORS.personal_best;
  return TIME_COLORS.normal;
}

/**
 * Qualifying segment badge of each driver at sessionNow: the furthest
 * segment (Q1, Q2, Q3) the driver has reached so far. A segment counts once
 * its replay origin (store qualiSegmentOffsets, session seconds) is reached;
 * its drivers are those of its replay frames (driver_colors), the cars still
 * in the session then: at Q1 everybody is 'Q1', nobody is told who reaches
 * Q3. With the whole session known (Infinity) the final classification gives
 * the badges (P16-20: Q1, P11-15: Q2, P1-10: Q3). {} when neither is known
 * (lap mode before the end).
 *
 * @param {Object} p
 * @param {Array<Object>} [p.raceResults] - sessionData.race_results
 * @param {Object} [p.segments] - store qualiSegments ({Q1, Q2, Q3} frames)
 * @param {Object} [p.offsets] - store qualiSegmentOffsets ({Q1, Q2, Q3} session seconds)
 * @param {number} p.sessionNow - session seconds
 * @returns {Object<string, string>} { driver: 'Q1'|'Q2'|'Q3' }
 */
export function qualiSegmentBadges({ raceResults, segments, offsets, sessionNow }) {
  const map = {};
  if (sessionNow === Infinity) {
    (raceResults || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      const pos = r.Position || r.ClassifiedPosition || 99;
      if (!abbr) return;
      if (pos > 15) map[abbr] = 'Q1';
      else if (pos > 10) map[abbr] = 'Q2';
      else map[abbr] = 'Q3';
    });
    return map;
  }
  if (!segments || !offsets || !Number.isFinite(sessionNow)) return map;
  for (const seg of ['Q1', 'Q2', 'Q3']) {
    const origin = offsets[seg];
    if (origin == null || !(origin <= sessionNow)) continue;
    for (const drv of Object.keys(segments[seg]?.driver_colors || {})) map[drv] = seg;
  }
  return map;
}

/**
 * Timing-sheet rows at sessionNow (session seconds), causal (decision R6,
 * utils/driverState.js). Each driver's row is the lap in progress with replay
 * frames (sectors as they are run, a chrono, no lap time or gap of its own),
 * otherwise the last completed lap in full; with a brushed lap range, the
 * driver's latest known lap inside it. Tyre = the set in force (new set from
 * the pit exit); retired only once it happened; bests and the fastest-lap
 * driver from completed laps only; order as the timing tower (laps completed,
 * then line crossing; qualifying: best completed lap).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @param {Object} [opts] - { dnfMap, replayActive, brushLapRange: [min, max], qualifying,
 *   isLiveMode (live feed rows: driverState.js nonFinisherMap) }
 * @returns {{ bests: Object, rows: Array<Object> }}
 */
export function lapTimingSheet(lapTimes, sessionNow, {
  dnfMap = {}, replayActive = false, brushLapRange = null, qualifying = false, isLiveMode = false,
} = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];

  // Session and personal bests over the laps completed at now
  let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity, bestLap = Infinity;
  let fastestLapDriver = null;
  const personalBests = {}; // { driver: { s1, s2, s3, lap } }
  const byDriver = new Map();
  for (const d of rows) {
    if (!d?.Driver) continue;
    if (!byDriver.has(d.Driver)) byDriver.set(d.Driver, []);
    byDriver.get(d.Driver).push(d);
    if (!isLapCompleted(d, now)) continue;
    const pb = personalBests[d.Driver] || (personalBests[d.Driver] = { s1: Infinity, s2: Infinity, s3: Infinity, lap: Infinity });
    const s1 = positiveTime(d.Sector1TimeSeconds, 120);
    const s2 = positiveTime(d.Sector2TimeSeconds, 120);
    const s3 = positiveTime(d.Sector3TimeSeconds, 120);
    const lap = positiveTime(d.LapTimeSeconds, 300);
    if (s1 != null) { bestS1 = Math.min(bestS1, s1); pb.s1 = Math.min(pb.s1, s1); }
    if (s2 != null) { bestS2 = Math.min(bestS2, s2); pb.s2 = Math.min(pb.s2, s2); }
    if (s3 != null) { bestS3 = Math.min(bestS3, s3); pb.s3 = Math.min(pb.s3, s3); }
    if (lap != null) {
      if (lap < bestLap) { bestLap = lap; fastestLapDriver = d.Driver; }
      if (lap < pb.lap) pb.lap = lap;
    }
  }
  const bests = { bestS1, bestS2, bestS3, bestLap, fastestLapDriver, personalBests };
  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(rows, dnfMap, { live: isLiveMode });

  const brushMin = brushLapRange ? brushLapRange[0] : -Infinity;
  const brushMax = brushLapRange ? brushLapRange[1] : Infinity;
  const inBrush = (lt) => lt.LapNumber >= brushMin && lt.LapNumber <= brushMax;

  const out = [];
  for (const [drv, driverRows] of byDriver) {
    const st = driverStateAt(driverRows, drv, now, { dnf: !!nonFinishers[drv] });
    const inProgress = st.retired ? null : st.inProgress;
    let d = replayActive ? (inProgress || st.lastCompleted) : (st.lastCompleted || inProgress);
    if (d && !inBrush(d)) {
      // Brushed window: the driver's latest lap inside it that is completed at now
      d = null;
      for (const lt of driverRows) {
        if (inBrush(lt) && isLapCompleted(lt, now) && (!d || lt.LapNumber > d.LapNumber)) d = lt;
      }
    }
    if (!d) continue;
    const live = d === inProgress;
    const isCurrent = live || d === st.lastCompleted;
    const pb = personalBests[drv] || { s1: Infinity, s2: Infinity, s3: Infinity, lap: Infinity };
    // Pit status: the pit entry / exit of this lap has happened at now
    const isPit = isPitVisible(d, now) || pitExitPassed(d, now);
    const isRetired = st.retired;

    const s1 = live ? st.visibleSectors.s1 : d.Sector1TimeSeconds;
    const s2 = live ? st.visibleSectors.s2 : d.Sector2TimeSeconds;
    const s3 = live ? st.visibleSectors.s3 : d.Sector3TimeSeconds;
    const lapTime = live ? null : d.LapTimeSeconds;

    // Live chronometer: running time in the sector being run (replay only)
    let chrono = null; // { sector: 1|2|3, elapsed: seconds }
    const start = live ? lapStartTime(d) : null;
    if (replayActive && live && start != null) {
      if (s1 == null) chrono = { sector: 1, elapsed: Math.max(0, now - start) };
      else if (s2 == null && d.Sector1SessionTime > 0) chrono = { sector: 2, elapsed: Math.max(0, now - d.Sector1SessionTime) };
      else if (s3 == null && d.Sector2SessionTime > 0) chrono = { sector: 3, elapsed: Math.max(0, now - d.Sector2SessionTime) };
    }

    // Gap / interval: known at a lap's end, so the last completed lap's
    const gapRow = live ? st.lastCompleted : d;
    const done = st.lastCompleted;
    out.push({
      driver: drv,
      lap: d.LapNumber,
      s1, s2, s3, lapTime,
      lastLapTime: done ? positiveTime(done.LapTimeSeconds, 300) : null,
      chrono,
      gap: gapRow?.GapToLeader || null,
      interval: gapRow?.IntervalToAhead || null,
      // The set in force for the current lap; a brushed past lap keeps its own
      compound: (isCurrent ? st.compound : d.Compound) || '',
      tyreLife: (isCurrent ? st.tyreLife : d.TyreLife) || 0,
      isPit,
      isRetired,
      isCurrentLap: live,
      retiredStatus: isRetired ? (nonFinishers[drv]?.status || 'DNF') : '',
      s1Color: isRetired ? TIME_COLORS.normal : timeColor(s1, bestS1, pb.s1, isPit),
      s2Color: isRetired ? TIME_COLORS.normal : timeColor(s2, bestS2, pb.s2, isPit),
      s3Color: isRetired ? TIME_COLORS.normal : timeColor(s3, bestS3, pb.s3, isPit),
      lapColor: isRetired ? TIME_COLORS.normal : timeColor(lapTime, bestLap, pb.lap, isPit),
      _laps: st.lapsCompleted,
      _crossed: done && Number.isFinite(done.Time) ? done.Time : Infinity,
      _position: done && Number.isFinite(done.Position) ? done.Position : Infinity,
      _best: pb.lap,
    });
  }

  // Active drivers in running order (position = rank), retired drivers at the bottom
  const order = qualifying
    ? (a, b) => (a._best - b._best) || a.driver.localeCompare(b.driver)
    : (a, b) => (b._laps - a._laps) || (a._crossed - b._crossed)
      || (a._position - b._position) || a.driver.localeCompare(b.driver);
  const active = out.filter((r) => !r.isRetired).sort(order);
  const retired = out.filter((r) => r.isRetired).sort(order);
  const sorted = [...active, ...retired].map(({ _laps, _crossed, _position, _best, ...r }, i) => ({ ...r, pos: i + 1 }));
  return { bests, rows: sorted };
}
