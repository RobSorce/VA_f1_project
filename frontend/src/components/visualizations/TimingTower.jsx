import React, { useMemo, useCallback } from 'react';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, TYRE_LABELS } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  hasPitOut, isLapCompleted, isPitVisible, lapStartTime, pitOutSeconds,
} from '../../utils/raceTime';
import { driverStateAt, lastRankedLap, nonFinisherMap } from '../../utils/driverState';

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

/* -- Format helpers ------------------------------------------------------ */
function formatLapTime(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

function formatRunningLap(seconds) {
  if (seconds == null || seconds < 0) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return mins > 0 ? `${mins}:${secs.padStart(4, '0')}` : secs;
}

function formatSectorTime(seconds) {
  if (!seconds || seconds <= 0) return '-';
  return seconds.toFixed(3);
}

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

/* -- Styles -------------------------------------------------------------- */
const containerStyle = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  background: 'rgba(10,10,20,0.95)',
  fontFamily: "'Titillium Web', 'Inter', 'Segoe UI', sans-serif",
  fontSize: 11,
  color: '#e0e0e0',
  userSelect: 'none',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 14px 7px 10px',
  background: 'linear-gradient(135deg, #e10600 0%, #b80500 50%, #1a1a2e 100%)',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  flexShrink: 0,
};

const headerTitleStyle = {
  fontFamily: "'Formula1', 'Titillium Web', sans-serif",
  fontSize: 12,
  fontWeight: 900,
  color: '#fff',
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

const colHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '4px 0',
  background: 'rgba(26,31,51,0.50)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#7a7f9a',
  flexShrink: 0,
};

const bodyStyle = {
  flex: 1,
  overflowY: 'auto',
  overflowX: 'auto',
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'auto',
};

/* -- Column widths (optimised for ~480px sidebar) ------------------------ */
const COL = {
  pos: 28,
  num: 34,
  driver: 90,
  gap: 64,
  int: 56,
  s1: 50,
  s2: 50,
  s3: 50,
  lapTime: 72,
  lap: 28,
  status: 22,
};

/* -- Memoized row component ---------------------------------------------- */
const TimingRow = React.memo(function TimingRow({
  entry,
  isSelected,
  isHighlighted,
  isFocused,
  onRowClick,
  onRowMouseEnter,
  onRowMouseLeave,
  onRowDoubleClick,
}) {
  const {
    pos, abbr, driverNumber, teamColor,
    gap, interval,
    s1, s2, s3, lapTime,
    s1Color, s2Color, s3Color, lapTimeColor,
    s1Chrono, s2Chrono, s3Chrono, lapChrono,
    compound, tyreLife, lapNumber,
    statusColor, statusLabel, isDnf, dnfStatus,
    isEvenRow,
  } = entry;

  let bg = isEvenRow ? 'rgba(255,255,255,0.015)' : 'transparent';
  if (isSelected) bg = 'rgba(255,255,255,0.08)';
  if (isHighlighted) bg = 'rgba(255,255,255,0.14)';

  const rowStyle = {
    display: 'table-row',
    height: 30,
    cursor: 'pointer',
    fontSize: 11,
    color: isDnf ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.9)',
    background: bg,
    transition: 'background 0.12s ease',
  };

  if (isFocused) {
    rowStyle.background = 'rgba(255,255,255,0.14)';
    rowStyle.animation = 'focus-row-pulse 2.5s ease-in-out infinite';
    rowStyle.position = 'relative';
    rowStyle.zIndex = 2;
  }

  const cellBase = {
    padding: '3px 4px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    verticalAlign: 'middle',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: "'Titillium Web', 'Inter', sans-serif",
    borderBottom: '1px solid rgba(255,255,255,0.03)',
  };

  const tyreColor = compound ? (TYRE_COLORS[compound] || TYRE_COLORS.UNKNOWN) : TYRE_COLORS.UNKNOWN;

  return (
    <tr
      style={rowStyle}
      onClick={() => onRowClick(abbr)}
      onMouseEnter={() => onRowMouseEnter(abbr)}
      onMouseLeave={onRowMouseLeave}
      onDoubleClick={() => onRowDoubleClick(abbr)}
    >
      {/* POS */}
      <td style={{ ...cellBase, width: COL.pos, position: 'relative', fontWeight: 800, color: '#fff', fontSize: 11 }}>
        <span style={{
          position: 'absolute', left: 0, top: 3, bottom: 3, width: 3,
          background: teamColor || '#888', borderRadius: 1.5,
        }} />
        {pos}
      </td>

      {/* Car Number */}
      <td style={{ ...cellBase, width: COL.num }}>
        <span style={{
          display: 'inline-block', padding: '1px 6px', borderRadius: 3,
          fontSize: 9, fontWeight: 700, color: '#fff',
          background: teamColor || '#555',
          minWidth: 24, textAlign: 'center',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        }}>
          {driverNumber}
        </span>
      </td>

      {/* Driver abbreviation + tyre indicator */}
      <td style={{ ...cellBase, width: COL.driver, textAlign: 'left', paddingLeft: 6 }}>
        <span style={{
          fontWeight: 700, fontSize: 11, color: '#fff',
          textTransform: 'uppercase', letterSpacing: '0.03em',
        }}>
          {abbr}
        </span>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: tyreColor, verticalAlign: 'middle', margin: '0 4px',
        }}
          title={`${compound || '?'} - Lap ${tyreLife || 0}`}
        />
        <span style={{ fontSize: 8, color: '#7a7f9a' }}>
          {tyreLife != null ? tyreLife : ''}
        </span>
      </td>

      {/* GAP */}
      <td style={{
        ...cellBase, width: COL.gap,
        color: gap === 'LEADER' ? '#fff' : '#aab',
        fontWeight: gap === 'LEADER' ? 600 : 400,
      }}>
        {isDnf ? (dnfStatus || 'DNF') : gap}
      </td>

      {/* INT */}
      <td style={{ ...cellBase, width: COL.int, color: '#aab' }}>
        {isDnf ? '-' : interval}
      </td>

      {/* S1 */}
      <td style={{
        ...cellBase, width: COL.s1,
        color: s1Chrono != null ? '#fbbf24' : s1Color,
        fontWeight: 500,
      }}>
        {s1Chrono != null ? s1Chrono.toFixed(1) : formatSectorTime(s1)}
      </td>

      {/* S2 */}
      <td style={{
        ...cellBase, width: COL.s2,
        color: s2Chrono != null ? '#fbbf24' : s2Color,
        fontWeight: 500,
      }}>
        {s2Chrono != null ? s2Chrono.toFixed(1) : formatSectorTime(s2)}
      </td>

      {/* S3 */}
      <td style={{
        ...cellBase, width: COL.s3,
        color: s3Chrono != null ? '#fbbf24' : s3Color,
        fontWeight: 500,
      }}>
        {s3Chrono != null ? s3Chrono.toFixed(1) : formatSectorTime(s3)}
      </td>

      {/* LAP TIME */}
      <td style={{
        ...cellBase, width: COL.lapTime,
        color: lapChrono != null ? '#fbbf24' : lapTimeColor,
        fontWeight: 500,
      }}>
        {lapChrono != null ? formatRunningLap(lapChrono) : formatLapTime(lapTime)}
      </td>

      {/* LAP */}
      <td style={{ ...cellBase, width: COL.lap, color: '#7a7f9a', fontSize: 10 }}>
        {lapNumber || '-'}
      </td>

      {/* STATUS */}
      <td style={{ ...cellBase, width: COL.status }}>
        <span
          title={statusLabel}
          style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%', background: statusColor,
          }}
        />
      </td>
    </tr>
  );
});

/* -- Main TimingTower component ------------------------------------------ */
export default function TimingTower() {
  /* -- Store selectors --------------------------------------------------- */
  const sessionData = useF1Store((s) => s.sessionData);
  const drivers = useF1Store((s) => s.drivers);
  const currentLap = useF1Store((s) => s.currentLap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const sessionType = useF1Store(loadedSessionTypeOf); // the loaded session, not the pill
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  // Causal "now" in session seconds (utils/raceTime.js): rows, tyres, pit
  // status and retirements as they were at that time (utils/driverState.js)
  const sessionNow = useSessionNow();
  const maxLap = useF1Store((s) => s.maxLap);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentFlagStatus = useF1Store((s) => s.currentFlagStatus);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const liveConnected = useF1Store((s) => s.liveConnected);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);

  /* -- Interaction callbacks --------------------------------------------- */
  const handleRowClick = useCallback((abbr) => toggleDriver(abbr), [toggleDriver]);
  const handleRowMouseEnter = useCallback((abbr) => setHighlightedDriver(abbr, null), [setHighlightedDriver]);
  const handleRowMouseLeave = useCallback(() => setHighlightedDriver(null), [setHighlightedDriver]);
  const handleRowDoubleClick = useCallback((abbr) => setFocusDriver(abbr), [setFocusDriver]);

  /* -- Build driver info lookup ------------------------------------------ */
  const driverInfoMap = useMemo(() => {
    const map = {};
    const driverList = sessionData?.drivers || drivers || [];
    driverList.forEach((d) => {
      map[d.Abbreviation] = {
        fullName: d.FullName || d.Abbreviation,
        teamName: d.TeamName || '',
        driverNumber: d.DriverNumber || '',
      };
    });
    return map;
  }, [sessionData, drivers]);

  /* -- Causal row entries (timingTowerEntries above) --------------------- */
  const entries = useMemo(() => {
    if (!sessionData?.lap_times?.length) return [];

    // Defence in depth against pre-DriverList lap entries: if we have a
    // populated driver_info, only render rows whose abbreviation is in it.
    // Otherwise raw racing numbers ("1", "11", "12") leak through as
    // phantom extra drivers when SignalR's TimingData arrives before
    // DriverList.
    const validAbbrs = Object.keys(driverInfoMap);
    const validSet = new Set(validAbbrs);
    const lapTimes = validAbbrs.length > 0
      ? sessionData.lap_times.filter((lt) => validSet.has(lt.Driver))
      : sessionData.lap_times;

    // Grid slots (known before the start) order drivers with no completed lap
    const gridPositions = {};
    for (const r of sessionData.race_results || []) {
      if (r.Abbreviation && r.GridPosition > 0) gridPositions[r.Abbreviation] = r.GridPosition;
    }

    return timingTowerEntries(lapTimes, sessionNow, {
      dnfMap,
      replayActive: totalFrames > 0,
      gridPositions,
      driverInfoMap,
      qualifying: sessionType === 'Q' || isQualifyingReplay,
    });
  }, [sessionData, totalFrames, driverInfoMap, dnfMap, sessionNow, sessionType, isQualifyingReplay]);

  /* -- Flag status banner ------------------------------------------------ */
  const flagBanner = useMemo(() => {
    const banners = {
      '2': { label: 'YELLOW FLAG', bg: 'rgba(255,204,0,0.12)', color: '#FFCC00' },
      '4': { label: 'SAFETY CAR', bg: 'rgba(255,140,0,0.12)', color: '#FF8C00' },
      '5': { label: 'RED FLAG', bg: 'rgba(255,0,0,0.12)', color: '#FF0000' },
      '6': { label: 'VSC', bg: 'rgba(255,140,0,0.12)', color: '#FF8C00' },
      '7': { label: 'VSC', bg: 'rgba(255,140,0,0.12)', color: '#FF8C00' },
    };
    return banners[currentFlagStatus] || null;
  }, [currentFlagStatus]);

  /* -- Empty state ------------------------------------------------------- */
  if (!entries.length) {
    // In live mode, the timing tower will populate as SignalR pushes the
    // first laps. Show a connection-aware "waiting" state instead of the
    // generic "no data" so the user knows the feed is alive.
    if (isLiveMode) {
      return (
        <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', padding: 24 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: liveConnected ? '#e10600' : '#666',
              boxShadow: liveConnected ? '0 0 10px rgba(225,6,0,0.6)' : 'none',
              animation: liveConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none',
            }} />
            <span style={{ color: '#bbc', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>
              {liveConnected ? 'Waiting for first laps' : 'Connecting to live feed…'}
            </span>
            <span style={{ color: '#666', fontSize: 10, lineHeight: 1.4, maxWidth: 240 }}>
              {liveConnected
                ? 'Drivers haven’t crossed the line yet. Timing will populate row-by-row from lap 1.'
                : 'Establishing SignalR connection.'}
            </span>
          </div>
        </div>
      );
    }
    return (
      <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#666', fontSize: 12 }}>No timing data available</span>
      </div>
    );
  }

  /* -- Render ------------------------------------------------------------ */
  return (
    <div style={containerStyle}>
      {/* Red gradient header */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 3, height: 16, background: '#fff', borderRadius: 1 }} />
          <span style={headerTitleStyle}>Timing Tower</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>LAP</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{currentLap}</span>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' }}>/{maxLap}</span>
        </div>
      </div>

      {/* Flag status banner */}
      {flagBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 6, padding: '3px 8px',
          fontSize: 10, fontWeight: 900, letterSpacing: '0.10em',
          textTransform: 'uppercase',
          background: flagBanner.bg, color: flagBanner.color,
          flexShrink: 0,
          animation: 'flag-pulse 1.5s ease-in-out infinite',
        }}>
          {flagBanner.label}
        </div>
      )}

      {/* Column sub-header */}
      <div style={colHeaderStyle}>
        <table style={tableStyle}>
          <colgroup>
            {Object.entries(COL).map(([key, w]) => (
              <col key={key} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>POS</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>#</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'left', paddingLeft: 6 }}>Driver</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>GAP</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>INT</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>S1</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>S2</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>S3</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>LAP TIME</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}>LAP</th>
              <th style={{ fontWeight: 700, padding: '0 3px', textAlign: 'center' }}></th>
            </tr>
          </thead>
        </table>
      </div>

      {/* Scrollable body */}
      <div style={bodyStyle}>
        <table style={tableStyle}>
          <colgroup>
            {Object.entries(COL).map(([key, w]) => (
              <col key={key} style={{ width: w }} />
            ))}
          </colgroup>
          <tbody>
            {entries.map((entry) => (
              <TimingRow
                key={entry.abbr}
                entry={entry}
                isSelected={selectedDrivers.includes(entry.abbr)}
                isHighlighted={highlightedDriver === entry.abbr}
                isFocused={focusDriver === entry.abbr}
                onRowClick={handleRowClick}
                onRowMouseEnter={handleRowMouseEnter}
                onRowMouseLeave={handleRowMouseLeave}
                onRowDoubleClick={handleRowDoubleClick}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
