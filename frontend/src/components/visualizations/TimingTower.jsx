import React, { useMemo, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, TYRE_LABELS } from '../../utils/colors';

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
function getTimingColor(value, sessionBest, personalBest, isPitIn, isPitOut) {
  if (!value || value <= 0) return TIMING_COLORS.DEFAULT;
  if (isPitIn) return TIMING_COLORS.PIT_IN;
  if (isPitOut) return TIMING_COLORS.PIT_OUT;
  if (sessionBest && Math.abs(value - sessionBest) < 0.0005) return TIMING_COLORS.OVERALL_BEST;
  if (personalBest && Math.abs(value - personalBest) < 0.0005) return TIMING_COLORS.PERSONAL_BEST;
  if (personalBest && value < personalBest + 0.5) return TIMING_COLORS.SLOWER;
  if (personalBest && value > personalBest + 1.5) return TIMING_COLORS.VERY_SLOW;
  return TIMING_COLORS.DEFAULT;
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
      <td style={{ ...cellBase, width: COL.s1, color: s1Color, fontWeight: 500 }}>
        {formatSectorTime(s1)}
      </td>

      {/* S2 */}
      <td style={{ ...cellBase, width: COL.s2, color: s2Color, fontWeight: 500 }}>
        {formatSectorTime(s2)}
      </td>

      {/* S3 */}
      <td style={{ ...cellBase, width: COL.s3, color: s3Color, fontWeight: 500 }}>
        {formatSectorTime(s3)}
      </td>

      {/* LAP TIME */}
      <td style={{ ...cellBase, width: COL.lapTime, color: lapTimeColor, fontWeight: 500 }}>
        {formatLapTime(lapTime)}
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
  const maxLap = useF1Store((s) => s.maxLap);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentFlagStatus = useF1Store((s) => s.currentFlagStatus);
  const dnfMap = useF1Store((s) => s.dnfMap);
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

  /* -- Compute session bests and personal bests, build row entries -------- */
  const entries = useMemo(() => {
    if (!sessionData?.lap_times?.length) return [];

    const lapTimes = sessionData.lap_times;

    let sessionBestS1 = Infinity, sessionBestS2 = Infinity;
    let sessionBestS3 = Infinity, sessionBestLap = Infinity;
    const personalBestS1 = {}, personalBestS2 = {};
    const personalBestS3 = {}, personalBestLap = {};
    const latestByDriver = {};
    const prevLapByDriver = {}; // track previous lap for lap time fallback

    for (const lt of lapTimes) {
      if (lt.LapNumber > currentLap) continue;
      const drv = lt.Driver;
      if (!drv) continue;

      if (lt.Sector1TimeSeconds > 0) {
        if (!personalBestS1[drv] || lt.Sector1TimeSeconds < personalBestS1[drv])
          personalBestS1[drv] = lt.Sector1TimeSeconds;
        if (lt.Sector1TimeSeconds < sessionBestS1) sessionBestS1 = lt.Sector1TimeSeconds;
      }
      if (lt.Sector2TimeSeconds > 0) {
        if (!personalBestS2[drv] || lt.Sector2TimeSeconds < personalBestS2[drv])
          personalBestS2[drv] = lt.Sector2TimeSeconds;
        if (lt.Sector2TimeSeconds < sessionBestS2) sessionBestS2 = lt.Sector2TimeSeconds;
      }
      if (lt.Sector3TimeSeconds > 0) {
        if (!personalBestS3[drv] || lt.Sector3TimeSeconds < personalBestS3[drv])
          personalBestS3[drv] = lt.Sector3TimeSeconds;
        if (lt.Sector3TimeSeconds < sessionBestS3) sessionBestS3 = lt.Sector3TimeSeconds;
      }
      if (lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300) {
        if (!personalBestLap[drv] || lt.LapTimeSeconds < personalBestLap[drv])
          personalBestLap[drv] = lt.LapTimeSeconds;
        if (lt.LapTimeSeconds < sessionBestLap) sessionBestLap = lt.LapTimeSeconds;
      }

      if (!latestByDriver[drv] || lt.LapNumber > latestByDriver[drv].LapNumber) {
        if (latestByDriver[drv]) prevLapByDriver[drv] = latestByDriver[drv];
        latestByDriver[drv] = lt;
      }
    }

    if (sessionBestS1 === Infinity) sessionBestS1 = null;
    if (sessionBestS2 === Infinity) sessionBestS2 = null;
    if (sessionBestS3 === Infinity) sessionBestS3 = null;
    if (sessionBestLap === Infinity) sessionBestLap = null;

    const rawEntries = Object.entries(latestByDriver).map(([drv, lt]) => {
      const info = driverInfoMap[drv] || {};
      const teamColor = getDriverColor(drv);
      const isDnf = !!(dnfMap && dnfMap[drv]);
      const dnfInfo = isDnf ? dnfMap[drv] : null;
      const isPitIn = !!lt.PitInTime;
      const isPitOut = !!lt.PitOutTime;

      let statusColor = STATUS_COLORS.ON_TRACK;
      let statusLabel = 'On Track';
      if (isDnf) {
        statusColor = STATUS_COLORS.OUT;
        statusLabel = dnfInfo?.status || 'DNF';
      } else if (isPitIn) {
        statusColor = STATUS_COLORS.PIT;
        statusLabel = 'Pit';
      }

      const s1Val = lt.Sector1TimeSeconds > 0 ? lt.Sector1TimeSeconds : null;
      const s2Val = lt.Sector2TimeSeconds > 0 ? lt.Sector2TimeSeconds : null;
      const s3Val = lt.Sector3TimeSeconds > 0 ? lt.Sector3TimeSeconds : null;
      const rawLapVal = lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300 ? lt.LapTimeSeconds : null;
      const prevLt = prevLapByDriver[drv];
      const lapVal = rawLapVal || (prevLt?.LapTimeSeconds > 0 && prevLt.LapTimeSeconds < 300 ? prevLt.LapTimeSeconds : null);

      return {
        pos: lt.Position || 99,
        abbr: drv,
        driverNumber: info.driverNumber || '',
        teamColor,
        gap: null,  // formatted after sorting
        gapRaw: lt.GapToLeader,
        s1: s1Val, s2: s2Val, s3: s3Val, lapTime: lapVal,
        s1Color: getTimingColor(s1Val, sessionBestS1, personalBestS1[drv], isPitIn, isPitOut),
        s2Color: getTimingColor(s2Val, sessionBestS2, personalBestS2[drv], isPitIn, isPitOut),
        s3Color: getTimingColor(s3Val, sessionBestS3, personalBestS3[drv], isPitIn, isPitOut),
        lapTimeColor: getTimingColor(lapVal, sessionBestLap, personalBestLap[drv], isPitIn, isPitOut),
        compound: lt.Compound || 'UNKNOWN',
        tyreLife: lt.TyreLife,
        lapNumber: lt.LapNumber,
        statusColor, statusLabel, isDnf,
        dnfStatus: dnfInfo?.status || null,
      };
    });

    // Separate active vs retired, sort active by position, append retired after
    const active = rawEntries.filter((e) => !e.isDnf);
    const retired = rawEntries.filter((e) => e.isDnf);
    active.sort((a, b) => a.pos - b.pos);
    // Re-number active drivers sequentially
    active.forEach((e, i) => { e.pos = i + 1; });
    // Retired drivers get positions after the last active driver
    retired.forEach((e, i) => { e.pos = active.length + i + 1; });
    const sorted = [...active, ...retired];

    return sorted.map((entry, idx) => {
      let interval = '---';
      if (idx > 0 && !entry.isDnf && !sorted[idx - 1].isDnf) {
        const aheadGap = sorted[idx - 1].gapRaw;
        interval = formatInterval(entry.gapRaw, aheadGap);
      }
      const gap = formatGap(entry.gapRaw, entry.pos === 1);
      return { ...entry, gap, interval, isEvenRow: idx % 2 === 0 };
    });
  }, [sessionData, currentLap, driverInfoMap, dnfMap]);

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
