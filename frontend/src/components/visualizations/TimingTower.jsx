import React, { useMemo, useCallback } from 'react';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import { TYRE_COLORS, TYRE_LABELS } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { timingTowerEntries } from '../../utils/views/timingTower';

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

  /* -- Causal row entries (timingTowerEntries, utils/views) ------------- */
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
