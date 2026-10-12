import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, countryFlag } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  completedLaps, hasPitOut, isLapCompleted, isPitVisible, lapStartTime, leaderLapEndTime, pitOutSeconds,
} from '../../utils/raceTime';
import { driverStateAt, nonFinisherMap } from '../../utils/driverState';
import Panel from '../ui/Panel';


/* ── Color codes for sector/lap timing (F1 TV convention) ───────── */
const TIME_COLORS = {
  overall_best: '#A020F0', // Purple — overall best in the session
  personal_best: '#00FF00', // Green — personal best
  normal: 'rgba(255,255,255,0.88)', // White/grey — normal
  slow: '#FFD700', // Yellow — significantly slower
  pit: '#e040fb', // Magenta — pit lap
};

/* ── Team name → logo file mapping (handles FastF1 name variations) */
const TEAM_LOGO_MAP = {
  'McLaren': '/team-logos/mclaren.png',
  'Ferrari': '/team-logos/ferrari.png',
  'Red Bull Racing': '/team-logos/red-bull.png',
  'Red Bull': '/team-logos/red-bull.png',
  'Mercedes': '/team-logos/mercedes.png',
  'Aston Martin': '/team-logos/aston-martin.jpg',
  'Alpine': '/team-logos/alpine.png',
  'Alpine F1 Team': '/team-logos/alpine.png',
  'Williams': '/team-logos/williams.png',
  'Haas F1 Team': '/team-logos/haas.png',
  'Haas': '/team-logos/haas.png',
  'RB': '/team-logos/rb.png',
  'Racing Bulls': '/team-logos/rb.png',
  'AlphaTauri': '/team-logos/rb.png',
  'Kick Sauber': '/team-logos/kick-sauber.png',
  'Stake F1 Team Kick Sauber': '/team-logos/kick-sauber.png',
  'Alfa Romeo': '/team-logos/kick-sauber.png',
  'Sauber': '/team-logos/kick-sauber.png',
};

/* ── Column definitions for resizable grid ──────────────────────── */
const COLUMN_DEFS = [
  { key: 'pos',     label: 'P',              defaultW: 30,  minW: 24,  resizable: false, align: 'center' },
  { key: 'bar',     label: '',               defaultW: 3,   minW: 3,   resizable: false, align: 'center' },
  { key: 'team',    label: 'Team',           defaultW: 38,  minW: 22,  resizable: true,  align: 'center' },
  { key: 'driver',  label: 'Driver',         defaultW: 170, minW: 70,  resizable: true,  align: 'flex-start' },
  { key: 's1',      label: 'S1',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 's2',      label: 'S2',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 's3',      label: 'S3',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 'lapTime', label: 'Lap Time',       defaultW: 96,  minW: 56,  resizable: true,  align: 'flex-end' },
  { key: 'gap',     label: 'Gap to fastest', defaultW: 96,  minW: 56,  resizable: true,  align: 'flex-end' },
  { key: 'tyre',    label: 'Tyre',           defaultW: 54,  minW: 36,  resizable: true,  align: 'center' },
  { key: 'laps',    label: 'Laps',           defaultW: 38,  minW: 28,  resizable: true,  align: 'center' },
];

/* ── Format seconds to M:SS.sss ─────────────────────────────────── */
function fmtTime(s) {
  if (!s || s <= 0 || s > 600) return '—';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

function fmtSector(s) {
  if (!s || s <= 0 || s > 120) return '—';
  return s.toFixed(3);
}

function fmtGap(gap) {
  if (gap == null || gap === 0) return '';
  if (typeof gap === 'string') return gap;
  if (!isFinite(gap)) return '—';
  return gap > 0 ? `+${gap.toFixed(3)}` : gap.toFixed(3);
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
 * @param {Object} [opts] - { dnfMap, replayActive, brushLapRange: [min, max], qualifying }
 * @returns {{ bests: Object, rows: Array<Object> }}
 */
export function lapTimingSheet(lapTimes, sessionNow, {
  dnfMap = {}, replayActive = false, brushLapRange = null, qualifying = false,
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
  const nonFinishers = nonFinisherMap(rows, dnfMap);

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

export default function LapTimeChart() {
  const timingContainerRef = useRef(null);

  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const triggerPrediction = useF1Store((s) => s.triggerPrediction);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const drivers = useF1Store((s) => s.drivers);
  const maxLap = useF1Store((s) => s.maxLap);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const brushLapRange = useF1Store((s) => s.brushLapRange);

  const sessionType = useF1Store(loadedSessionTypeOf); // the loaded session, not the pill
  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const raceTarget = totalRaceLaps || maxLap;
  const isQualifying = sessionType === 'Q';

  // Qualifying segment filter
  const [qualiFilter, setQualiFilter] = useState('ALL');

  /* ── Country code map from race_results ──────────────────────── */
  const countryCodeMap = useMemo(() => {
    const map = {};
    (sessionData?.race_results || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      if (abbr && r.CountryCode) map[abbr] = r.CountryCode;
    });
    return map;
  }, [sessionData]);

  /* ── Driver info lookup: abbreviation → { fullName, firstName, surname, teamName, teamLogo } */
  const driverInfoMap = useMemo(() => {
    const map = {};
    (drivers || []).forEach((d) => {
      const full = d.FullName || d.Abbreviation;
      const parts = full.trim().split(/\s+/);
      const surname = parts.length > 1 ? parts.slice(-1)[0] : full;
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
      map[d.Abbreviation] = {
        fullName: full,
        firstName,
        surname,
        teamName: d.TeamName || '',
        teamLogo: TEAM_LOGO_MAP[d.TeamName] || null,
      };
    });
    return map;
  }, [drivers]);

  // Replay frames loaded: the lap in progress is shown as it is run (sectors,
  // chrono); without frames (lap mode, live) each driver's last completed lap.
  const replayActive = totalFrames > 0;

  // Causal "now" in session seconds (utils/raceTime.js): rows, tyres, pit
  // flags and retirements as they were at that time (utils/driverState.js)
  const sessionNow = useSessionNow();
  // Replay: finished once the leader has taken the chequered flag (end of the
  // last lap), not when he starts it
  const chequered = useMemo(() => leaderLapEndTime(lapTimes, maxLap), [lapTimes, maxLap]);
  const replayFinished = sessionNow === Infinity || (chequered != null && sessionNow >= chequered);
  const raceFinished = isLiveMode
    ? (currentLap >= raceTarget && raceTarget > 1 && currentLap > 2)
    : (replayFinished && maxLap > 1);

  // Qualifying segment badges at sessionNow (qualiSegmentBadges above): the
  // furthest segment each driver has reached so far, never the final result
  const qualiSegments = useF1Store((s) => s.qualiSegments);
  const qualiOffsets = useF1Store((s) => s.qualiSegmentOffsets);
  const qualiSegmentMap = useMemo(
    () => (isQualifying ? qualiSegmentBadges({
      raceResults: sessionData?.race_results, segments: qualiSegments, offsets: qualiOffsets, sessionNow,
    }) : {}),
    [isQualifying, sessionData, qualiSegments, qualiOffsets, sessionNow],
  );

  /* ── Bests (completed laps) and one row per driver at sessionNow ── */
  const sheet = useMemo(
    () => lapTimingSheet(lapTimes, sessionNow, {
      dnfMap, replayActive, brushLapRange, qualifying: isQualifying,
    }),
    [lapTimes, sessionNow, dnfMap, replayActive, brushLapRange, isQualifying],
  );
  const sessionBests = sheet.bests;

  /* ── Timing rows with driver identity ───────────────────────── */
  const timingRows = useMemo(() => sheet.rows.map((row) => {
    const info = driverInfoMap[row.driver] || {};
    return {
      ...row,
      firstName: info.firstName || '',
      surname: info.surname || row.driver,
      teamLogo: info.teamLogo || null,
      color: getDriverColor(row.driver),
      qualiSegment: qualiSegmentMap[row.driver] || null,
    };
  }), [sheet, driverInfoMap, qualiSegmentMap]);

  /* ── All drivers shown; qualifying filter applied if active ── */
  const displayRows = useMemo(() => {
    if (!isQualifying || qualiFilter === 'ALL') return timingRows;
    return timingRows.filter((r) => r.qualiSegment === qualiFilter);
  }, [timingRows, isQualifying, qualiFilter]);

  /* ── Resizable column widths ────────────────────────────────── */
  const [colWidths, setColWidths] = useState(() => COLUMN_DEFS.map((c) => c.defaultW));
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;

  const gridColumns = colWidths.map((w) => `${w}px`).join(' ');

  const onResizeStart = useCallback((colIdx, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidthsRef.current[colIdx];

    const onMouseMove = (ev) => {
      const delta = ev.clientX - startX;
      const newW = Math.max(COLUMN_DEFS[colIdx].minW, startW + delta);
      setColWidths((prev) => {
        const next = [...prev];
        next[colIdx] = newW;
        return next;
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /* ── Dynamic row sizing based on available height ──────────── */
  const [timingHeight, setTimingHeight] = useState(500);
  useEffect(() => {
    if (!timingContainerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const h = entries[0].contentRect.height;
      if (h > 0) setTimingHeight(h);
    });
    obs.observe(timingContainerRef.current);
    return () => obs.disconnect();
  }, []);

  const rowCount = displayRows.length || 20;
  const rowBudget = rowCount > 0 ? timingHeight / rowCount : 28;
  // Row padding: shrink from 2px to 0px as space gets tight
  const rowPadV = Math.max(0, Math.min(2, Math.floor((rowBudget - 18) / 2)));
  // Font sizes: shrink when rows are very tight
  const compactTiming = rowBudget < 22;
  const rowFontSize = compactTiming ? '9px' : '10px';
  const rowLapFontSize = compactTiming ? '9px' : '11px';

  /* ── Render ─────────────────────────────────────────────────── */
  const headerStyle = {
    display: 'grid',
    gridTemplateColumns: gridColumns,
    gap: '2px',
    padding: '4px 6px',
    background: 'rgba(26, 31, 51, 0.75)',
    borderBottom: '1px solid rgba(255,255,255,0.10)',
    fontSize: '9px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.6)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    userSelect: 'none',
    flexShrink: 0,
  };

  const cellStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: rowFontSize,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };

  const controls = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '9px' }}>
      {isQualifying && (
        <>
          {['ALL', 'Q1', 'Q2', 'Q3'].map((seg) => (
            <button
              key={seg}
              onClick={() => setQualiFilter(seg)}
              style={{
                padding: '2px 6px', borderRadius: 4, border: 'none',
                fontSize: '9px', fontWeight: 700, cursor: 'pointer',
                background: qualiFilter === seg ? 'rgba(255,255,255,0.15)' : 'transparent',
                color: qualiFilter === seg ? '#fff' : 'rgba(255,255,255,0.4)',
              }}
            >{seg}</button>
          ))}
          <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.1)' }} />
        </>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.overall_best }} />
        <span style={{ color: 'rgba(255,255,255,0.65)' }}>Best</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.personal_best }} />
        <span style={{ color: 'rgba(255,255,255,0.65)' }}>PB</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.pit }} />
        <span style={{ color: 'rgba(255,255,255,0.65)' }}>Pit</span>
      </span>
    </div>
  );

  // Title and accent reflect *either* brush source: brushLapRange comes
  // from the Position-by-Lap chart (cross-panel filter), selectedLapRange
  // from the bottom-bar brush (regression target). Both end up driving
  // the Tyre Degradation panel; both deserve visible feedback here.
  const titleRange = brushLapRange || selectedLapRange;
  const brushTitle = titleRange
    ? `Timing Sheet  (LAP ${titleRange[0]}–${titleRange[1]})`
    : 'Timing Sheet';

  return (
    <Panel title={brushTitle} controls={controls} focused={focusedView === 'laptimes'} shortcutKey="2" style={titleRange ? { borderColor: 'rgba(225,6,0,0.35)' } : undefined}>
      {/* Column headers with drag-to-resize handles */}
      <div style={headerStyle}>
        {COLUMN_DEFS.map((col, i) => (
          <div
            key={col.key}
            style={{
              position: 'relative',
              display: 'flex',
              justifyContent: col.align,
              alignItems: 'center',
              ...(col.key === 'gap' ? { fontSize: '8px' } : {}),
              ...(col.key === 'driver' ? { paddingLeft: 2 } : {}),
            }}
          >
            {col.label}
            {col.resizable && (
              <div
                onMouseDown={(e) => onResizeStart(i, e)}
                style={{
                  position: 'absolute',
                  right: -2,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'col-resize',
                  zIndex: 2,
                  background: 'transparent',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Timing rows */}
      <div ref={timingContainerRef} className="timing-sheet__body" style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        minHeight: 0,
      }}>
        {displayRows.length === 0 && (
          <div className="loading-placeholder">
            <span>Load a session to see timing data</span>
          </div>
        )}

        {displayRows.map((row) => {
          const isHighlighted = row.driver === highlightedDriver;
          const isFocused = row.driver === focusDriver;
          const isSelected = selectedDrivers.includes(row.driver);
          const isOdd = row.pos % 2 === 1;
          const retiredOpacity = row.isRetired ? 0.4 : 1;

          return (
            <div
              key={row.driver}
              style={{
                display: 'grid',
                gridTemplateColumns: gridColumns,
                gap: '2px',
                padding: `${rowPadV}px 6px`,
                cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                opacity: retiredOpacity,
                background: row.isRetired
                  ? 'rgba(255,255,255,0.02)'
                  : isFocused
                    ? 'rgba(255,255,255,0.12)'
                    : isHighlighted
                      ? 'rgba(255,255,255,0.08)'
                      : isSelected
                        ? 'rgba(255,255,255,0.06)'
                        : isOdd
                          ? 'rgba(255,255,255,0.015)'
                          : 'transparent',
                transition: 'background 0.1s ease, opacity 0.3s ease',
                ...(isFocused && !row.isRetired ? {
                  borderLeft: `3px solid ${row.color}`,
                  boxShadow: `inset 4px 0 10px -2px ${row.color}44`,
                } : {}),
              }}
              onClick={() => toggleDriver(row.driver)}
              onDoubleClick={() => { setFocusDriver(row.driver); triggerPrediction(row.driver, currentLap); }}
              onMouseEnter={(e) => setHighlightedDriver(row.driver, { x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHighlightedDriver(null)}
            >
              {/* Position */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: row.isRetired ? '8px' : rowLapFontSize,
                color: row.isRetired ? '#e10600' : '#fff',
                letterSpacing: row.isRetired ? '0.02em' : undefined,
              }}>
                {row.isRetired ? 'RET' : row.pos}
              </span>

              {/* Team color bar */}
              <span style={{
                width: 3,
                alignSelf: 'stretch',
                borderRadius: 1.5,
                background: row.color,
              }} />

              {/* Team logo */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
              }}>
                {row.teamLogo && (
                  <img
                    src={row.teamLogo}
                    alt=""
                    style={{
                      width: compactTiming ? 16 : 20,
                      height: compactTiming ? 16 : 20,
                      objectFit: 'contain',
                      filter: 'brightness(1.1)',
                    }}
                  />
                )}
              </span>

              {/* Driver name: flag (race end) + firstName (light) + SURNAME (bold) */}
              <span style={{
                ...cellStyle,
                justifyContent: 'flex-start',
                fontSize: compactTiming ? '9px' : '10px',
                color: '#fff',
                fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                gap: 3,
              }}>
                {raceFinished && countryCodeMap[row.driver] && (
                  <span style={{ fontSize: '11px', lineHeight: 1 }}>
                    {countryFlag(countryCodeMap[row.driver])}
                  </span>
                )}
                {row.firstName && (
                  <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.65)', fontSize: '9px' }}>
                    {row.firstName}
                  </span>
                )}
                <span style={{ fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
                  {row.surname}
                </span>
                {sessionBests.fastestLapDriver === row.driver && (
                  <span style={{
                    fontSize: '7px', marginLeft: 3, padding: '1px 3px',
                    borderRadius: 3, background: 'rgba(160,32,240,0.25)',
                    color: '#A020F0', fontWeight: 800, letterSpacing: '0.04em',
                  }}>FL</span>
                )}
                {isQualifying && row.qualiSegment && (
                  <span style={{
                    fontSize: '7px', marginLeft: 3, padding: '1px 3px',
                    borderRadius: 3, fontWeight: 700, letterSpacing: '0.04em',
                    background: row.qualiSegment === 'Q3' ? 'rgba(160,32,240,0.2)' : row.qualiSegment === 'Q2' ? 'rgba(0,255,0,0.2)' : 'rgba(255,255,255,0.08)',
                    color: row.qualiSegment === 'Q3' ? '#A020F0' : row.qualiSegment === 'Q2' ? '#00FF00' : 'rgba(255,255,255,0.4)',
                  }}>{row.qualiSegment}</span>
                )}
              </span>

              {/* Sector 1 */}
              <span style={{ ...cellStyle, color: row.s1Color, fontWeight: row.s1Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s1 ? fmtSector(row.s1) : row.chrono?.sector === 1 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Sector 2 */}
              <span style={{ ...cellStyle, color: row.s2Color, fontWeight: row.s2Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s2 ? fmtSector(row.s2) : row.chrono?.sector === 2 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Sector 3 */}
              <span style={{ ...cellStyle, color: row.s3Color, fontWeight: row.s3Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s3 ? fmtSector(row.s3) : row.chrono?.sector === 3 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Lap Time */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? 'rgba(255,255,255,0.35)' : row.isPit ? TIME_COLORS.pit : row.lapColor,
                fontWeight: 700,
                fontSize: row.isRetired ? '9px' : rowLapFontSize,
              }}>
                {row.isRetired ? row.retiredStatus : row.isPit ? 'PIT' : fmtTime(row.lapTime)}
              </span>

              {/* Gap to fastest */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? '#e10600' : row.pos === 1 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.7)',
                fontSize: '9px',
                fontWeight: row.isRetired ? 800 : undefined,
              }}>
                {row.isRetired ? 'DNF' : row.pos === 1 ? 'LEADER' : fmtGap(row.gap)}
              </span>

              {/* Tyre compound */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                gap: 3,
              }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: TYRE_COLORS[row.compound] || '#888',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: '8px',
                  fontWeight: 600,
                  color: TYRE_COLORS[row.compound] || '#888',
                }}>
                  {row.compound ? row.compound[0] : '?'}
                </span>
              </span>

              {/* Tyre life */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.55)',
                fontSize: '9px',
              }}>
                {row.tyreLife}
              </span>
            </div>
          );
        })}

        {/* LSTM predicted rows — show predicted times as table rows */}
        {focusDriver && lstmPredictions && (() => {
          const pred = lstmPredictions[focusDriver] || lstmPredictions?.driver_predictions?.[focusDriver];
          const predTimes = pred?.predicted_times?.filter((t) => t > 0 && t < 300) || [];
          if (predTimes.length === 0) return null;

          const focusRow = displayRows.find((r) => r.driver === focusDriver);
          if (!focusRow) return null;

          const pitProb = pred?.pit_probability;

          return (
            <>
              {/* Prediction header separator */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 8px',
                background: 'rgba(245, 166, 35, 0.06)',
                borderTop: '1px solid rgba(245, 166, 35, 0.15)',
                borderBottom: '1px solid rgba(245, 166, 35, 0.08)',
              }}>
                <span style={{
                  fontSize: '8px', fontWeight: 800, color: '#f5a623',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>LSTM Forecast</span>
                <span style={{
                  fontSize: '8px', color: 'rgba(255,255,255,0.35)',
                }}>{focusDriver} — next {predTimes.length} laps</span>
                {pitProb != null && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '8px', fontWeight: 700,
                    padding: '1px 5px', borderRadius: 3,
                    background: pitProb > 0.6 ? 'rgba(225,6,0,0.15)' : pitProb > 0.3 ? 'rgba(245,166,35,0.15)' : 'rgba(34,197,94,0.1)',
                    color: pitProb > 0.6 ? '#e10600' : pitProb > 0.3 ? '#f5a623' : '#22c55e',
                  }}>
                    PIT {(pitProb * 100).toFixed(0)}%
                  </span>
                )}
              </div>

              {/* Predicted lap rows */}
              {predTimes.map((time, i) => {
                const predLap = currentLap + i + 1;
                // Compute delta vs the last completed lap
                const lastActualTime = focusRow.lastLapTime;
                const delta = lastActualTime && lastActualTime > 0 ? time - lastActualTime : null;

                return (
                  <div
                    key={`pred-${predLap}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: gridColumns,
                      gap: '2px',
                      padding: '3px 6px',
                      borderBottom: '1px solid rgba(245, 166, 35, 0.06)',
                      background: i % 2 === 0 ? 'rgba(245, 166, 35, 0.03)' : 'rgba(245, 166, 35, 0.015)',
                    }}
                  >
                    {/* Position — show predicted lap number */}
                    <span style={{
                      ...cellStyle, justifyContent: 'center',
                      fontWeight: 700, fontSize: '9px',
                      color: '#f5a623', fontStyle: 'italic',
                    }}>
                      L{predLap}
                    </span>

                    {/* Team color bar */}
                    <span style={{
                      width: 3, alignSelf: 'stretch', borderRadius: 1.5,
                      background: focusRow.color, opacity: 0.5,
                    }} />

                    {/* Team logo */}
                    <span style={{ ...cellStyle, justifyContent: 'center' }}>
                      {focusRow.teamLogo && (
                        <img src={focusRow.teamLogo} alt="" style={{ width: 16, height: 16, objectFit: 'contain', opacity: 0.5 }} />
                      )}
                    </span>

                    {/* Driver name */}
                    <span style={{
                      ...cellStyle, justifyContent: 'flex-start',
                      fontSize: '9px', fontStyle: 'italic',
                      color: 'rgba(245, 166, 35, 0.6)',
                      fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                    }}>
                      <span style={{ fontWeight: 700 }}>{focusRow.surname}</span>
                      <span style={{ fontSize: '7px', marginLeft: 4, color: 'rgba(245,166,35,0.35)' }}>predicted</span>
                    </span>

                    {/* S1 — empty for predicted */}
                    <span style={{ ...cellStyle, color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>—</span>
                    {/* S2 */}
                    <span style={{ ...cellStyle, color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>—</span>
                    {/* S3 */}
                    <span style={{ ...cellStyle, color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>—</span>

                    {/* Predicted Lap Time */}
                    <span style={{
                      ...cellStyle, fontWeight: 700, fontSize: '11px',
                      color: '#f5a623', fontStyle: 'italic',
                    }}>
                      {fmtTime(time)}
                    </span>

                    {/* Delta vs last actual */}
                    <span style={{
                      ...cellStyle, fontSize: '9px',
                      color: delta != null ? (delta > 0 ? '#e10600' : '#22c55e') : 'rgba(255,255,255,0.2)',
                    }}>
                      {delta != null ? (delta > 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3)) : ''}
                    </span>

                    {/* Tyre — inherit from current */}
                    <span style={{ ...cellStyle, justifyContent: 'center', gap: 3, opacity: 0.5 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: TYRE_COLORS[focusRow.compound] || '#888',
                      }} />
                    </span>

                    {/* Tyre life — estimate */}
                    <span style={{
                      ...cellStyle, justifyContent: 'center',
                      color: 'rgba(255,255,255,0.25)', fontSize: '9px', fontStyle: 'italic',
                    }}>
                      {focusRow.tyreLife + i + 1}
                    </span>
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* LSTM forecast mini-chart for focused driver */}
        {focusDriver && (
          <LSTMForecastChart
            focusDriver={focusDriver}
            lstmPredictions={lstmPredictions}
            lapTimes={lapTimes}
            currentLap={currentLap}
            sessionNow={sessionNow}
          />
        )}
      </div>

      {/* Lap range brush bar */}
      {!isQualifying && maxLap > 1 && (
        <LapRangeBrush
          maxLap={maxLap}
          currentLap={currentLap}
          selectedRange={selectedLapRange}
          onRangeChange={setSelectedLapRange}
        />
      )}
    </Panel>
  );
}

/* ── Lap Range Brush: compact bar for selecting a lap window ──── */
function LapRangeBrush({ maxLap, currentLap, selectedRange, onRangeChange }) {
  const barRef = useRef(null);

  const lapToX = useCallback((lap) => {
    const el = barRef.current;
    if (!el) return 0;
    return ((lap - 1) / Math.max(1, maxLap - 1)) * el.clientWidth;
  }, [maxLap]);

  const xToLap = useCallback((x) => {
    const el = barRef.current;
    if (!el) return 1;
    const ratio = Math.max(0, Math.min(1, x / el.clientWidth));
    return Math.max(1, Math.min(maxLap, Math.round(ratio * (maxLap - 1) + 1)));
  }, [maxLap]);

  const handleMouseDown = useCallback((e) => {
    const el = barRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startLap = xToLap(e.clientX - rect.left);

    const onMove = (ev) => {
      const endLap = xToLap(ev.clientX - rect.left);
      const lo = Math.min(startLap, endLap);
      const hi = Math.max(startLap, endLap);
      if (hi - lo >= 1) onRangeChange([lo, hi]);
    };

    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const endLap = xToLap(ev.clientX - rect.left);
      const lo = Math.min(startLap, endLap);
      const hi = Math.max(startLap, endLap);
      if (hi - lo < 1) onRangeChange(null); // click = clear
    };

    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [xToLap, onRangeChange]);

  // Lap tick marks
  const ticks = [];
  const step = maxLap <= 30 ? 5 : maxLap <= 50 ? 10 : 15;
  for (let l = step; l <= maxLap; l += step) ticks.push(l);

  const selLeft = selectedRange ? lapToX(selectedRange[0]) : 0;
  const selWidth = selectedRange ? lapToX(selectedRange[1]) - selLeft : 0;
  const currentX = lapToX(currentLap);

  return (
    <div style={{
      flexShrink: 0, padding: '4px 6px 6px',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(15,15,35,0.6)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
          Lap Range
        </span>
        {selectedRange && (
          <button
            onClick={() => onRangeChange(null)}
            style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 3, padding: '1px 6px', fontSize: '8px', color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
            }}
          >
            L{selectedRange[0]}–L{selectedRange[1]} ✕
          </button>
        )}
      </div>
      <div
        ref={barRef}
        onMouseDown={handleMouseDown}
        style={{
          position: 'relative', height: 16, borderRadius: 3,
          background: 'rgba(255,255,255,0.04)', cursor: 'crosshair',
          overflow: 'hidden',
        }}
      >
        {/* Selected range highlight */}
        {selectedRange && (
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: selLeft, width: selWidth,
            background: 'rgba(100,180,255,0.2)',
            borderLeft: '2px solid rgba(100,180,255,0.6)',
            borderRight: '2px solid rgba(100,180,255,0.6)',
          }} />
        )}
        {/* Current lap marker */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, width: 2,
          left: currentX - 1,
          background: 'rgba(255,255,255,0.4)',
        }} />
        {/* Tick labels */}
        {ticks.map((l) => (
          <span key={l} style={{
            position: 'absolute', top: 2, fontSize: '7px',
            color: 'rgba(255,255,255,0.2)', fontWeight: 600,
            left: lapToX(l), transform: 'translateX(-50%)',
          }}>{l}</span>
        ))}
      </div>
    </div>
  );
}

/* ── LSTM Forecast Mini-Chart: D3 pace trend + prediction overlay ── */
function LSTMForecastChart({ focusDriver, lstmPredictions, lapTimes, currentLap, sessionNow }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);

  const pred = lstmPredictions?.[focusDriver] || lstmPredictions?.driver_predictions?.[focusDriver];
  const predTimes = useMemo(() => {
    if (!pred?.predicted_times?.length) return [];
    return pred.predicted_times.slice(0, 5).filter((t) => t > 0 && t < 300);
  }, [pred]);

  // Laps of the focused driver completed at sessionNow: the count changes
  // once per lap, so the chart is not redrawn on every replay tick
  const doneCount = useMemo(() => {
    let n = 0;
    for (const d of lapTimes) if (d.Driver === focusDriver && isLapCompleted(d, sessionNow)) n++;
    return n;
  }, [lapTimes, focusDriver, sessionNow]);

  // Recent racing laps for the focused driver (last 15 laps, no pit laps),
  // only laps completed at sessionNow (the unfinished lap is not known yet)
  const recentLaps = useMemo(() => {
    return completedLaps(lapTimes, sessionNow)
      .filter((d) => d.Driver === focusDriver && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300 && !d.PitInTime && !d.PitOutTime)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .slice(-15);
    // sessionNow enters through doneCount, which changes whenever the result does
  }, [lapTimes, focusDriver, doneCount]);

  useEffect(() => {
    if (!svgRef.current || recentLaps.length < 2) return;
    const container = svgRef.current.parentElement;
    const { width: W } = container.getBoundingClientRect();
    const H = 90;
    const margin = { top: 14, right: 12, bottom: 18, left: 42 };
    const w = W - margin.left - margin.right;
    const h = H - margin.top - margin.bottom;
    if (w < 40 || h < 20) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const driverColor = getDriverColor(focusDriver);

    // Build data points
    const actualPoints = recentLaps.map((d) => ({ lap: d.LapNumber, time: d.LapTimeSeconds, type: 'actual' }));
    const lastActual = actualPoints[actualPoints.length - 1];

    const predPoints = predTimes.map((t, i) => ({ lap: lastActual.lap + i + 1, time: t, type: 'predicted' }));
    // Connection point for seamless join
    const connectionPoint = { lap: lastActual.lap, time: lastActual.time, type: 'predicted' };
    const fullPredLine = [connectionPoint, ...predPoints];

    const allPoints = [...actualPoints, ...predPoints];
    const allTimes = allPoints.map((d) => d.time);
    const yMin = d3.min(allTimes);
    const yMax = d3.max(allTimes);
    const yPad = (yMax - yMin) * 0.15 || 0.5;

    const xScale = d3.scaleLinear()
      .domain([actualPoints[0].lap, predPoints.length > 0 ? predPoints[predPoints.length - 1].lap : lastActual.lap])
      .range([0, w]);
    const yScale = d3.scaleLinear()
      .domain([yMin - yPad, yMax + yPad])
      .range([h, 0]);

    // Grid lines
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(xScale).ticks(Math.min(allPoints.length, 8)).tickSize(-h).tickFormat('')
    ).selectAll('line').attr('stroke', 'rgba(255,255,255,0.04)');
    g.selectAll('.domain').remove();

    // Uncertainty band (±0.3s) around predictions
    if (predPoints.length > 0) {
      const uncertainty = d3.area()
        .x((d) => xScale(d.lap))
        .y0((d) => yScale(d.time + 0.3))
        .y1((d) => yScale(d.time - 0.3))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(predPoints)
        .attr('d', uncertainty)
        .attr('fill', driverColor)
        .attr('opacity', 0.06);
    }

    // Vertical separator at forecast boundary
    if (predPoints.length > 0) {
      g.append('line')
        .attr('x1', xScale(lastActual.lap)).attr('x2', xScale(lastActual.lap))
        .attr('y1', 0).attr('y2', h)
        .attr('stroke', 'rgba(255,255,255,0.12)').attr('stroke-dasharray', '2,2');
    }

    // Actual pace line (solid)
    const line = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.time)).curve(d3.curveMonotoneX);
    g.append('path').datum(actualPoints).attr('d', line)
      .attr('fill', 'none').attr('stroke', driverColor).attr('stroke-width', 1.8).attr('opacity', 0.9);

    // Predicted pace line (dashed)
    if (fullPredLine.length > 1) {
      const predLine = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.time)).curve(d3.curveMonotoneX);
      g.append('path').datum(fullPredLine).attr('d', predLine)
        .attr('fill', 'none').attr('stroke', driverColor).attr('stroke-width', 1.8)
        .attr('stroke-dasharray', '6,4').attr('opacity', 0.7);
    }

    // Actual lap dots
    g.selectAll('.actual-dot')
      .data(actualPoints)
      .join('circle')
      .attr('cx', (d) => xScale(d.lap)).attr('cy', (d) => yScale(d.time))
      .attr('r', 2).attr('fill', driverColor).attr('opacity', 0.6);

    // Predicted lap dots (larger, with white stroke)
    g.selectAll('.pred-dot')
      .data(predPoints)
      .join('circle')
      .attr('cx', (d) => xScale(d.lap)).attr('cy', (d) => yScale(d.time))
      .attr('r', 3.5).attr('fill', driverColor).attr('stroke', '#fff').attr('stroke-width', 1)
      .attr('opacity', 0.8).style('cursor', 'pointer');

    // Tooltip interaction on predicted dots
    const tooltip = tooltipRef.current;
    g.selectAll('.pred-dot')
      .on('mouseenter', function (event, d) {
        if (!tooltip) return;
        const mins = Math.floor(d.time / 60);
        const secs = (d.time % 60).toFixed(3);
        const timeStr = mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
        tooltip.textContent = `L${d.lap}: ${timeStr}`;
        tooltip.style.opacity = '1';
        tooltip.style.left = `${event.offsetX + 8}px`;
        tooltip.style.top = `${event.offsetY - 18}px`;
      })
      .on('mouseleave', function () {
        if (tooltip) tooltip.style.opacity = '0';
      });

    // "LSTM Forecast" label
    if (predPoints.length > 0) {
      g.append('text')
        .attr('x', xScale(predPoints[0].lap))
        .attr('y', -4)
        .attr('fill', driverColor)
        .attr('font-size', '7px')
        .attr('font-weight', 700)
        .attr('opacity', 0.6)
        .text('LSTM Forecast');
    }

    // Driver label + pit probability
    g.append('text')
      .attr('x', 0).attr('y', -4)
      .attr('fill', driverColor)
      .attr('font-size', '8px')
      .attr('font-weight', 800)
      .text(focusDriver);

    if (pred?.pit_probability != null) {
      const pitProb = pred.pit_probability;
      g.append('text')
        .attr('x', w).attr('y', -4)
        .attr('text-anchor', 'end')
        .attr('fill', pitProb > 0.5 ? '#f5a623' : 'rgba(255,255,255,0.35)')
        .attr('font-size', '7px')
        .attr('font-weight', 700)
        .text(`PIT ${(pitProb * 100).toFixed(0)}%`);
    }

    // X-axis
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(xScale).ticks(Math.min(allPoints.length, 8)).tickFormat(d3.format('d'))
    ).selectAll('text').attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px');
    g.selectAll('.domain').attr('stroke', 'rgba(255,255,255,0.06)');
    g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)');

    // Y-axis (time)
    g.append('g').call(
      d3.axisLeft(yScale).ticks(3).tickFormat((d) => {
        const m = Math.floor(d / 60);
        const s = (d % 60).toFixed(1);
        return m > 0 ? `${m}:${s.padStart(4, '0')}` : s;
      })
    ).selectAll('text').attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px');
  }, [recentLaps, predTimes, focusDriver, pred, currentLap]);

  if (recentLaps.length < 2 && predTimes.length === 0) return null;

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid rgba(255,255,255,0.08)',
      background: 'rgba(15,15,35,0.5)',
      position: 'relative',
      height: 90,
      overflow: 'hidden',
    }}>
      <div ref={tooltipRef} style={{
        position: 'absolute', pointerEvents: 'none', opacity: 0,
        background: 'rgba(10,10,25,0.9)', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4, padding: '2px 6px', fontSize: '9px', color: '#f5a623',
        fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
        zIndex: 5, transition: 'opacity 0.1s',
      }} />
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
