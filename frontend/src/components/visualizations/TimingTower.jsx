import React, { useMemo, useCallback, useState } from 'react';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import { activeSegmentWindow } from '../../utils/raceTime';
import {
  CHART_FONT, TEXT_COLORS, STATUS_COLORS, TRACK_STATUS_STYLES, UI_COLORS,
  contrastText, tintedChip, tyreColor as compoundColor, tyreLetter, withAlpha,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { timingTowerEntries, timingTowerLegend } from '../../utils/views/timingTower';
import { useBoxSize, fitRows } from '../../utils/views/chartBox';
import Legend from '../ui/Legend';

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
// Table text at the fixed-width data size (CHART_FONT.fixed, 11 px at every
// viewport): the 480 px column does not grow with the window, so neither does
// its type; every cell and header fits its column at this size
// (docs/evidence/tower_columns.txt)
const TOWER_FONT = CHART_FONT.fixed;

const containerStyle = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  background: 'rgba(10,10,20,0.95)',
  fontFamily: 'var(--font-primary)',
  fontSize: 11,
  color: TEXT_COLORS.secondary,
  userSelect: 'none',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 14px 7px 10px',
  background: `linear-gradient(135deg, ${UI_COLORS.accent} 0%, ${UI_COLORS.accentDark} 50%, ${UI_COLORS.accentEnd} 100%)`,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  flexShrink: 0,
};

const headerTitleStyle = {
  fontFamily: 'var(--font-primary)',
  fontSize: 12,
  fontWeight: 900,
  color: TEXT_COLORS.primary,
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
  fontSize: TOWER_FONT,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: TEXT_COLORS.muted,
  flexShrink: 0,
};

// The rows fit the body (fitRows): 24 px each while the 20 rows fit, down to
// 18 px; the body scrolls vertically only when even 18 px rows do not fit
// (docs/SCROLL_JUSTIFICATIONS.md). No horizontal scroll: the columns share
// the width of the panel.
const bodyStyle = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
};

const ROW_MIN = 18;
const ROW_MAX = 24;

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
};

/* -- Column widths: shares of the 480 px Pit Wall timing column ---------- */
// Design widths in px summing to 476 (the 480 px column minus its borders),
// drawn as percentages of the table so the columns always fit the panel
// (table-layout fixed; a cell too narrow would end in an ellipsis). Each one
// holds its widest value and its header at TOWER_FONT in Inter, the status
// marks in JetBrains Mono: the widest driver code with its tyre, sector
// '◆28.123', lap '◆1:21.456', gap '+12.345' / 'LEADER', 'LAP'; the position
// header is "P", its full name in the title (docs/evidence/tower_columns.txt).
const COL = {
  pos: 22,
  num: 28,
  driver: 68,
  gap: 51,
  int: 51,
  s1: 52,
  s2: 52,
  s3: 52,
  lapTime: 62,
  lap: 26,
  status: 12,
};
const COL_TOTAL = Object.values(COL).reduce((a, w) => a + w, 0);
const colPct = (w) => `${((100 * w) / COL_TOTAL).toFixed(3)}%`;

// One timing cell: the glyph of its status (◆ overall best, ● personal best,
// P / O pit in / out) before the time, in the same colour
function TimingValue({ glyph, children }) {
  return (
    <>
      {glyph && <span className="timing-glyph" style={{ marginRight: 2, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{glyph}</span>}
      {children}
    </>
  );
}

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
  rowH,
}) {
  const {
    pos, abbr, driverNumber, teamColor,
    gap, interval,
    s1, s2, s3, lapTime,
    s1Color, s2Color, s3Color, lapTimeColor,
    s1Glyph, s2Glyph, s3Glyph, lapTimeGlyph,
    s1Chrono, s2Chrono, s3Chrono, lapChrono,
    compound, tyreLife, lapNumber,
    statusColor, statusLabel, statusGlyph, isDnf, dnfStatus,
    isEvenRow,
  } = entry;

  let bg = isEvenRow ? 'rgba(255,255,255,0.015)' : 'transparent';
  if (isSelected) bg = 'rgba(255,255,255,0.08)';
  if (isHighlighted) bg = 'rgba(255,255,255,0.14)';

  const rowStyle = {
    display: 'table-row',
    height: rowH,
    lineHeight: 1.2,
    cursor: 'pointer',
    fontSize: TOWER_FONT,
    // A retired row is muted (still >= 4.5:1), and its gap reads DNF / RET
    color: isDnf ? STATUS_COLORS.retired : TEXT_COLORS.primary,
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
    padding: '0 2px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    verticalAlign: 'middle',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-primary)',
    borderBottom: '1px solid rgba(255,255,255,0.03)',
  };

  const tyreColor = compoundColor(compound);

  return (
    <tr
      style={rowStyle}
      onClick={() => onRowClick(abbr)}
      onMouseEnter={() => onRowMouseEnter(abbr)}
      onMouseLeave={onRowMouseLeave}
      onDoubleClick={() => onRowDoubleClick(abbr)}
    >
      {/* POS */}
      <td style={{ ...cellBase, width: COL.pos, position: 'relative', fontWeight: 800, color: TEXT_COLORS.primary, fontSize: TOWER_FONT }}>
        <span style={{
          position: 'absolute', left: 0, top: 3, bottom: 3, width: 3,
          background: teamColor, borderRadius: 1.5,
        }} />
        {pos}
      </td>

      {/* Car Number */}
      <td style={{ ...cellBase, width: COL.num }}>
        <span style={{
          display: 'inline-block', padding: '0 4px', borderRadius: 3,
          fontSize: TOWER_FONT, fontWeight: 700,
          // Team-colour badge: black or white text by contrast (contrastText)
          background: teamColor, color: contrastText(teamColor),
          minWidth: 24, textAlign: 'center',
        }}>
          {driverNumber}
        </span>
      </td>

      {/* Driver abbreviation + tyre indicator */}
      <td style={{ ...cellBase, width: COL.driver, textAlign: 'left', paddingLeft: 6 }}>
        <span style={{
          fontWeight: 700, fontSize: TOWER_FONT, color: TEXT_COLORS.primary,
          textTransform: 'uppercase', letterSpacing: '0.03em',
        }}>
          {abbr}
        </span>
        {/* Compound: FIA colour with its letter (never the colour alone) */}
        <span style={{
          display: 'inline-block', minWidth: 13, height: 13, lineHeight: '13px', borderRadius: '50%',
          background: tyreColor, color: contrastText(tyreColor), verticalAlign: 'middle', margin: '0 2px',
          fontSize: CHART_FONT.label, fontWeight: 800, textAlign: 'center',
        }}
          title={`${compound || '?'} - Lap ${tyreLife || 0}`}
        >{tyreLetter(compound)}</span>
        <span style={{ fontSize: TOWER_FONT, color: TEXT_COLORS.muted }}>
          {tyreLife != null ? tyreLife : ''}
        </span>
      </td>

      {/* GAP */}
      <td style={{
        ...cellBase, width: COL.gap,
        color: gap === 'LEADER' ? TEXT_COLORS.primary : TEXT_COLORS.secondary,
        fontWeight: gap === 'LEADER' ? 600 : 400,
      }}>
        {isDnf ? (dnfStatus || 'DNF') : gap}
      </td>

      {/* INT */}
      <td style={{ ...cellBase, width: COL.int, color: TEXT_COLORS.secondary }}>
        {isDnf ? '-' : interval}
      </td>

      {/* S1 */}
      <td style={{
        ...cellBase, width: COL.s1,
        color: s1Chrono != null ? STATUS_COLORS.running : s1Color,
        fontStyle: s1Chrono != null ? 'italic' : undefined,
        fontWeight: 500,
      }}>
        {s1Chrono != null ? s1Chrono.toFixed(1) : <TimingValue glyph={s1Glyph}>{formatSectorTime(s1)}</TimingValue>}
      </td>

      {/* S2 */}
      <td style={{
        ...cellBase, width: COL.s2,
        color: s2Chrono != null ? STATUS_COLORS.running : s2Color,
        fontStyle: s2Chrono != null ? 'italic' : undefined,
        fontWeight: 500,
      }}>
        {s2Chrono != null ? s2Chrono.toFixed(1) : <TimingValue glyph={s2Glyph}>{formatSectorTime(s2)}</TimingValue>}
      </td>

      {/* S3 */}
      <td style={{
        ...cellBase, width: COL.s3,
        color: s3Chrono != null ? STATUS_COLORS.running : s3Color,
        fontStyle: s3Chrono != null ? 'italic' : undefined,
        fontWeight: 500,
      }}>
        {s3Chrono != null ? s3Chrono.toFixed(1) : <TimingValue glyph={s3Glyph}>{formatSectorTime(s3)}</TimingValue>}
      </td>

      {/* LAP TIME */}
      <td style={{
        ...cellBase, width: COL.lapTime,
        color: lapChrono != null ? STATUS_COLORS.running : lapTimeColor,
        fontStyle: lapChrono != null ? 'italic' : undefined,
        fontWeight: 500,
      }}>
        {lapChrono != null ? formatRunningLap(lapChrono) : <TimingValue glyph={lapTimeGlyph}>{formatLapTime(lapTime)}</TimingValue>}
      </td>

      {/* LAP */}
      <td style={{ ...cellBase, width: COL.lap, color: TEXT_COLORS.muted, fontSize: TOWER_FONT }}>
        {lapNumber || '-'}
      </td>

      {/* STATUS */}
      <td style={{ ...cellBase, width: COL.status }}>
        <span
          title={statusLabel}
          style={{ color: statusColor, fontWeight: 800, fontSize: TOWER_FONT, fontFamily: 'var(--font-mono)' }}
        >{statusGlyph}</span>
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
  // The active qualifying segment's laps only (its window's start)
  const segmentStart = useF1Store((s) => activeSegmentWindow(s)?.start);
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

  /* -- Row height fitted to the body (utils/views/chartBox.js) ----------- */
  // The body exists only once there are rows (not in the empty states): a
  // callback ref, so the box is measured when it appears
  const [bodyEl, setBodyEl] = useState(null);
  const bodyRef = useMemo(() => ({ current: bodyEl }), [bodyEl]);
  const bodyBox = useBoxSize(bodyRef);

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
      isLiveMode,
      segmentStart,
    });
  }, [sessionData, totalFrames, driverInfoMap, dnfMap, sessionNow, sessionType, isQualifyingReplay, isLiveMode,
    segmentStart]);

  // 24 px rows while every row fits, down to 18 px (the focus cards under
  // the tower take room); not measured yet (server render): 24 px
  const rowFit = fitRows(bodyBox.height, entries.length, { rowMin: ROW_MIN, rowMax: ROW_MAX, rowDefault: ROW_MAX });

  /* -- Flag status banner ------------------------------------------------ */
  const flagBanner = useMemo(() => {
    // FIA flag colour with its label; the text is lifted to 4.5:1 on its tint
    const st = currentFlagStatus !== '1' ? TRACK_STATUS_STYLES[currentFlagStatus] : null;
    if (!st) return null;
    const chip = tintedChip(st.color, 0.12);
    return { label: st.short, bg: chip.background, color: chip.color };
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
              background: liveConnected ? UI_COLORS.accent : TEXT_COLORS.muted,
              boxShadow: liveConnected ? `0 0 10px ${withAlpha(UI_COLORS.accent, 0.6)}` : 'none',
              animation: liveConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none',
            }} />
            <span style={{ color: TEXT_COLORS.secondary, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>
              {liveConnected ? 'Waiting for first laps' : 'Connecting to live feed…'}
            </span>
            <span style={{ color: TEXT_COLORS.muted, fontSize: TOWER_FONT, lineHeight: 1.4, maxWidth: 240 }}>
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
        <span style={{ color: TEXT_COLORS.muted, fontSize: 12 }}>No timing data available</span>
      </div>
    );
  }

  /* -- Render ------------------------------------------------------------ */
  return (
    <div style={containerStyle}>
      {/* Red gradient header */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 3, height: 16, background: TEXT_COLORS.primary, borderRadius: 1 }} />
          <span style={headerTitleStyle}>Timing Tower</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{ fontSize: TOWER_FONT, color: TEXT_COLORS.secondary, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>LAP</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: TEXT_COLORS.primary, fontVariantNumeric: 'tabular-nums' }}>{currentLap}</span>
          <span style={{ fontSize: 12, color: TEXT_COLORS.secondary, fontVariantNumeric: 'tabular-nums' }}>/{maxLap}</span>
        </div>
      </div>

      {/* Flag status banner: static. It pulsed down to opacity 0.8
          (flag-pulse), its RED FLAG label read 4.37:1 */}
      {flagBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 6, padding: '3px 8px',
          fontSize: TOWER_FONT, fontWeight: 900, letterSpacing: '0.10em',
          textTransform: 'uppercase',
          background: flagBanner.bg, color: flagBanner.color,
          flexShrink: 0,
        }}>
          {flagBanner.label}
        </div>
      )}

      {/* Column sub-header */}
      <div style={colHeaderStyle}>
        <table style={tableStyle}>
          <colgroup>
            {Object.entries(COL).map(([key, w]) => (
              <col key={key} style={{ width: colPct(w) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }} title="Position">P</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>#</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'left', paddingLeft: 6 }}>Driver</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>GAP</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>INT</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>S1</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>S2</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>S3</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }} title="Lap time">TIME</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}>LAP</th>
              <th style={{ fontWeight: 700, padding: '0 1px', textAlign: 'center' }}></th>
            </tr>
          </thead>
        </table>
      </div>

      {/* Body: the rows fit its height (fitRows) */}
      <div ref={setBodyEl} style={bodyStyle}>
        <table style={tableStyle}>
          <colgroup>
            {Object.entries(COL).map(([key, w]) => (
              <col key={key} style={{ width: colPct(w) }} />
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
                rowH={rowFit.rowH}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Timing colours with their glyphs (timingTowerLegend) */}
      <div style={{ flexShrink: 0, padding: '0 6px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Legend items={timingTowerLegend()} shape="glyph" />
      </div>
    </div>
  );
}
