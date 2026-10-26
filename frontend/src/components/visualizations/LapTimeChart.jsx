import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import {
  getDriverColor, countryFlag, CHART_FONT, TEXT_COLORS, STATUS_COLORS, STATUS_GLYPHS, UI_COLORS,
  contrastText, tyreColor, tyreLetter, timingGlyph, signedDelta, deltaColor, tintedChip, markColor, textColor,
  GRID_COLORS, withAlpha, chartFontPx,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { completedLaps, isLapCompleted, leaderLapEndTime } from '../../utils/raceTime';
import {
  TIME_COLORS, qualiSegmentBadges, lapTimingSheet, timingSheetLegend, forecastChartLegend, lapBrushUpdate,
  forecastRowMarks, TIMING_COLUMNS as COLUMN_DEFS, fitTimingColumns, timingColumnFloors, TIMING_HIDDEN_EM,
  TIMING_GAP, TIMING_PAD_X,
} from '../../utils/views/lapTimeChart';
import {
  focusForecast, forecastPoints, forecastMethodLabel, forecastMethodText, forecastPit, forecastHeldOutMae,
  forecastOriginFeature, FORECAST_LAPS,
} from '../../utils/forecast';
import Panel from '../ui/Panel';
import { useChartBox, chartSize, useBoxSize } from '../../utils/views/chartBox';
import Legend from '../ui/Legend';

/* ── Column definitions for the resizable grid: TIMING_COLUMNS
   (utils/views/lapTimeChart.js), each header label fitted to its width ── */

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

// A time in a timing colour with its glyph (◆ overall best, ● personal best)
function TimeCue({ color, children }) {
  const glyph = timingGlyph(color);
  return (
    <>
      {glyph && <span className="timing-glyph" style={{ marginRight: 2 }}>{glyph}</span>}
      {children}
    </>
  );
}

// The chrono of the lap being run: neutral, italic (not a timing colour)
const RUNNING_STYLE = { color: STATUS_COLORS.running, fontStyle: 'italic', fontVariantNumeric: 'tabular-nums' };

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
  const setBrushLapRange = useF1Store((s) => s.setBrushLapRange);

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

  /* ── Driver info lookup: abbreviation → { fullName, firstName, surname, teamName } */
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

  // Qualifying segment badges at sessionNow (qualiSegmentBadges, utils/views): the
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
      dnfMap, replayActive, brushLapRange, qualifying: isQualifying, isLiveMode,
    }),
    [lapTimes, sessionNow, dnfMap, replayActive, brushLapRange, isQualifying, isLiveMode],
  );
  const sessionBests = sheet.bests;

  /* ── Timing rows with driver identity ───────────────────────── */
  const timingRows = useMemo(() => sheet.rows.map((row) => {
    const info = driverInfoMap[row.driver] || {};
    return {
      ...row,
      firstName: info.firstName || '',
      surname: info.surname || row.driver,
      teamName: info.teamName || '',
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
  // The width each column's values need at the data size (timingColumnFloors):
  // a column is never dragged, nor fitted, narrower than that
  const dataPx = chartFontPx('data');
  const floors = useMemo(() => timingColumnFloors(dataPx), [dataPx]);
  const floorsRef = useRef(floors);
  floorsRef.current = floors;
  // the widths on screen (fitted to the pane, below), read when a drag starts
  const fitRef = useRef(null);

  const onResizeStart = useCallback((colIdx, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    // a drag starts from the widths on screen (the fitted ones), so the
    // column follows the pointer; the other columns make room down to their floors
    const onScreen = fitRef.current
      ? fitRef.current.widths.map((w, i) => (fitRef.current.shown[i] ? w : colWidthsRef.current[i]))
      : colWidthsRef.current;
    setColWidths(onScreen);
    const startW = Math.max(onScreen[colIdx], floorsRef.current[colIdx]);

    const onMouseMove = (ev) => {
      const delta = ev.clientX - startX;
      const newW = Math.max(floorsRef.current[colIdx], startW + delta);
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

  /* ── Dynamic row sizing based on available height (the shared
     measure of utils/views/chartBox.js, D4: no observer of its own) ── */
  const timingBox = useBoxSize(timingContainerRef);
  const timingHeight = timingBox.height > 0 ? timingBox.height : 500;

  /* ── The columns fitted to the rows' box (fitTimingColumns, D3): shrunk
     down to their floors, never cut by the pane; a pane too narrow for the
     floors gives up whole columns, named in the header's "+N" cell ── */
  const fit = useMemo(
    () => fitTimingColumns(colWidths, timingBox.width, floors, { hiddenW: Math.ceil(TIMING_HIDDEN_EM * dataPx) }),
    [colWidths, timingBox.width, floors, dataPx],
  );
  fitRef.current = fit;
  const show = useMemo(
    () => Object.fromEntries(COLUMN_DEFS.map((c, i) => [c.key, fit.shown[i]])),
    [fit],
  );
  const gridColumns = fit.widths.filter((w, i) => fit.shown[i]).map((w) => `${w}px`).join(' ');
  const hiddenNames = fit.hidden.map((k) => {
    const c = COLUMN_DEFS.find((x) => x.key === k);
    return c.title || c.label;
  });

  const rowCount = displayRows.length || 20;
  const rowBudget = rowCount > 0 ? timingHeight / rowCount : 28;
  // Row padding: shrink from 2px to 0px as space gets tight
  const rowPadV = Math.max(0, Math.min(2, Math.floor((rowBudget - 18) / 2)));
  // Rows tighten their padding when space is short; the text keeps the data
  // floor (CHART_FONT.data, >= 11 px) at every size
  const rowFontSize = CHART_FONT.data;
  const rowLapFontSize = CHART_FONT.data;

  /* ── Render ─────────────────────────────────────────────────── */
  const headerStyle = {
    display: 'grid',
    gridTemplateColumns: fit.hiddenW ? `${gridColumns} ${fit.hiddenW}px` : gridColumns,
    gap: `${TIMING_GAP}px`,
    padding: `4px ${TIMING_PAD_X}px`,
    background: 'rgba(26, 31, 51, 0.75)',
    borderBottom: '1px solid rgba(255,255,255,0.10)',
    fontSize: CHART_FONT.data,
    fontWeight: 700,
    color: TEXT_COLORS.secondary,
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
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: CHART_FONT.label }}>
      {isQualifying && (
        <>
          {['ALL', 'Q1', 'Q2', 'Q3'].map((seg) => (
            <button
              key={seg}
              onClick={() => setQualiFilter(seg)}
              style={{
                padding: '2px 6px', borderRadius: 4, border: 'none',
                fontSize: CHART_FONT.label, fontWeight: 700, cursor: 'pointer',
                background: qualiFilter === seg ? 'rgba(255,255,255,0.15)' : 'transparent',
                color: qualiFilter === seg ? TEXT_COLORS.primary : TEXT_COLORS.muted,
              }}
            >{seg}</button>
          ))}
          <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.1)' }} />
        </>
      )}
      {/* Every colour of the sheet with its glyph (timingSheetLegend) */}
      <Legend items={timingSheetLegend({ forecast: !!focusDriver })} shape="glyph" />
    </div>
  );

  // Title and accent: the brushed range (brushLapRange: this sheet's bar, via lapBrushUpdate, and the Position by Lap brush) else selectedLapRange (stint, pit window, race event).
  const titleRange = brushLapRange || selectedLapRange;
  const brushTitle = titleRange
    ? `Timing Sheet  (LAP ${titleRange[0]}–${titleRange[1]})`
    : 'Timing Sheet';

  return (
    <Panel title={brushTitle} controls={controls} focused={focusedView === 'laptimes'} shortcutKey="2" style={titleRange ? { borderColor: UI_COLORS.brush } : undefined}>
      {/* Column headers with drag-to-resize handles */}
      <div style={headerStyle}>
        {COLUMN_DEFS.map((col, i) => (fit.shown[i] ? (
          <div
            key={col.key}
            title={col.label ? (col.title || col.label) : undefined}
            style={{
              position: 'relative',
              display: 'flex',
              justifyContent: col.align,
              alignItems: 'center',
              minWidth: 0,
              ...(col.key === 'driver' ? { paddingLeft: 2 } : {}),
            }}
          >
            {/* never cut silently (D3): a label wider than its column (one
                fitted to a narrow pane, or dragged narrow) ends in an
                ellipsis, the full name in the title */}
            <span className="timing-sheet__col-label" style={{
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            >{col.label}</span>
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
        ) : null))}
        {/* Columns given up for the pane's width (a floating window near its
            minimum): named here, never cut silently (D3) */}
        {fit.hidden.length > 0 && (
          <span
            className="timing-sheet__hidden-cols"
            title={`Hidden for the pane's width: ${hiddenNames.join(', ')}. Widen the pane to show them.`}
            aria-label={`${fit.hidden.length} columns hidden: ${hiddenNames.join(', ')}`}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 3, background: 'rgba(255,255,255,0.10)', color: TEXT_COLORS.primary,
              cursor: 'help', letterSpacing: 0,
            }}
          >+{fit.hidden.length}</span>
        )}
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

          return (
            <div
              key={row.driver}
              data-driver={row.driver}
              style={{
                display: 'grid',
                gridTemplateColumns: gridColumns,
                gap: `${TIMING_GAP}px`,
                padding: `${rowPadV}px ${TIMING_PAD_X}px`,
                cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                // a retired row is never faded (V2: its text would read 2.24:1):
                // 'RET' and the retired grey (>= 4.5:1) on the position and the
                // name, and the retired bar on its left edge, as in the tower
                ...(row.isRetired ? { boxShadow: `inset 2px 0 0 ${STATUS_COLORS.retired}` } : {}),
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
                transition: 'background 0.1s ease',
                ...(isFocused && !row.isRetired ? {
                  borderLeft: `3px solid ${markColor(row.color)}`,
                  boxShadow: `inset 4px 0 10px -2px ${withAlpha(row.color, 0.27)}`,
                } : {}),
              }}
              onClick={() => toggleDriver(row.driver)}
              onDoubleClick={() => {
                // keep the focus on a second double-click (setFocusDriver toggles it
                // off): the forecast of the focus driver is asked again (backlog L3)
                if (useF1Store.getState().focusDriver !== row.driver) setFocusDriver(row.driver);
                triggerPrediction(row.driver, currentLap);
              }}
              onMouseEnter={(e) => setHighlightedDriver(row.driver, { x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHighlightedDriver(null)}
            >
              {/* Position */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: rowLapFontSize,
                color: row.isRetired ? STATUS_COLORS.retired : TEXT_COLORS.primary,
                letterSpacing: row.isRetired ? '0.02em' : undefined,
              }}>
                {row.isRetired ? 'RET' : row.pos}
              </span>

              {/* Team color bar (teammate tint, V3; >= 3:1 as a mark) */}
              <span style={{
                width: 3,
                alignSelf: 'stretch',
                borderRadius: 1.5,
                background: markColor(row.color),
              }} />

              {/* Driver name: flag (race end) + firstName (light) + SURNAME (bold,
                  700). A narrow column ends the first name, then the surname,
                  in an ellipsis (the first name gives way first); the full name
                  and the team are the cell's title (the team's colour is the bar) */}
              <span
                title={[[row.firstName, row.surname].filter(Boolean).join(' '), row.teamName].filter(Boolean).join(', ')}
                style={{
                  ...cellStyle,
                  justifyContent: 'flex-start',
                  fontSize: CHART_FONT.data,
                  color: TEXT_COLORS.primary,
                  fontFamily: 'var(--font-primary)',
                  overflow: 'hidden',
                  minWidth: 0,
                  gap: 3,
                }}
              >
                {raceFinished && countryCodeMap[row.driver] && (
                  <span style={{ fontSize: CHART_FONT.data, lineHeight: 1, flexShrink: 0 }}>
                    {countryFlag(countryCodeMap[row.driver])}
                  </span>
                )}
                {row.firstName && (
                  <span style={{
                    fontWeight: 400, color: TEXT_COLORS.secondary, fontSize: CHART_FONT.data,
                    minWidth: 0, flexShrink: 1000, overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {row.firstName}
                  </span>
                )}
                <span style={{
                  fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
                  minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row.surname}
                </span>
                {sessionBests.fastestLapDriver === row.driver && (
                  <span title="Fastest lap of the session" style={{
                    fontSize: CHART_FONT.label, marginLeft: 3, padding: '0 3px', flexShrink: 0,
                    borderRadius: 3, background: tintedChip(STATUS_COLORS.overallBest, 0.25).background,
                    color: tintedChip(STATUS_COLORS.overallBest, 0.25).color, fontWeight: 800, letterSpacing: '0.04em',
                  }}>{STATUS_GLYPHS.overallBest} FL</span>
                )}
                {isQualifying && row.qualiSegment && (
                  <span style={{
                    // The segment reads in its text (Q1 / Q2 / Q3): a neutral chip
                    fontSize: CHART_FONT.label, marginLeft: 3, padding: '0 3px', flexShrink: 0,
                    borderRadius: 3, fontWeight: 700, letterSpacing: '0.04em',
                    background: 'rgba(255,255,255,0.10)', color: TEXT_COLORS.secondary,
                  }}>{row.qualiSegment}</span>
                )}
              </span>

              {/* Sector 1 */}
              {show.s1 && <span style={{ ...cellStyle, color: row.s1Color, fontWeight: row.s1Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s1 ? <TimeCue color={row.s1Color}>{fmtSector(row.s1)}</TimeCue> : row.chrono?.sector === 1 ? (
                  <span style={RUNNING_STYLE}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>}

              {/* Sector 2 */}
              {show.s2 && <span style={{ ...cellStyle, color: row.s2Color, fontWeight: row.s2Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s2 ? <TimeCue color={row.s2Color}>{fmtSector(row.s2)}</TimeCue> : row.chrono?.sector === 2 ? (
                  <span style={RUNNING_STYLE}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>}

              {/* Sector 3 */}
              {show.s3 && <span style={{ ...cellStyle, color: row.s3Color, fontWeight: row.s3Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s3 ? <TimeCue color={row.s3Color}>{fmtSector(row.s3)}</TimeCue> : row.chrono?.sector === 3 ? (
                  <span style={RUNNING_STYLE}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>}

              {/* Lap Time */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? STATUS_COLORS.retired : row.isPit ? TIME_COLORS.pit : row.lapColor,
                fontWeight: 700,
                fontSize: rowLapFontSize,
              }}>
                {row.isRetired ? (
                  // a long status ("Disqualified") ends in an ellipsis, in full in its title
                  <span title={row.retiredStatus} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.retiredStatus}
                  </span>
                ) : row.isPit ? 'PIT' : <TimeCue color={row.lapColor}>{fmtTime(row.lapTime)}</TimeCue>}
              </span>

              {/* Gap to fastest */}
              {show.gap && <span style={{
                ...cellStyle,
                color: row.isRetired ? STATUS_COLORS.retired : row.pos === 1 ? TEXT_COLORS.muted : TEXT_COLORS.secondary,
                fontSize: CHART_FONT.data,
                fontWeight: row.isRetired ? 800 : undefined,
              }}>
                {row.isRetired ? 'DNF' : row.pos === 1 ? 'LEADER' : fmtGap(row.gap)}
              </span>}

              {/* Tyre compound */}
              {show.tyre && <span style={{
                ...cellStyle,
                justifyContent: 'center',
                gap: 3,
              }}>
                {/* FIA compound colour as a badge with its letter (contrastText) */}
                <span style={{
                  minWidth: 14,
                  height: 14,
                  lineHeight: '14px',
                  borderRadius: '50%',
                  background: tyreColor(row.compound),
                  color: contrastText(tyreColor(row.compound)),
                  fontSize: CHART_FONT.label,
                  fontWeight: 800,
                  textAlign: 'center',
                  flexShrink: 0,
                }}>
                  {tyreLetter(row.compound)}
                </span>
              </span>}

              {/* Tyre life */}
              {show.laps && <span style={{
                ...cellStyle,
                justifyContent: 'center',
                color: TEXT_COLORS.muted,
                fontSize: CHART_FONT.data,
              }}>
                {row.tyreLife}
              </span>}
            </div>
          );
        })}

        {/* Lap-time forecast rows of the focus driver (double-click a row):
            each time at its target lap, named by the method that made it */}
        {focusDriver && (() => {
          const pred = focusForecast(lstmPredictions, focusDriver);
          const points = forecastPoints(pred);
          if (points.length === 0) return null;

          const focusRow = displayRows.find((r) => r.driver === focusDriver);
          if (!focusRow) return null;

          const { probability: pitProb, label: pitLabel } = forecastPit(pred);
          // Deltas to the forecast's reference (the window's last clean lap)
          const refTime = Number.isFinite(pred.window?.ref_time) ? pred.window.ref_time : focusRow.lastLapTime;
          const originTyreLife = forecastOriginFeature(pred, 'origin_tyre_life');
          const note = [forecastMethodText(pred), pred.lstm_note, pred.method_note].filter(Boolean).join(' ');

          return (
            <>
              {/* Prediction header separator */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 8px',
                background: withAlpha(STATUS_COLORS.predicted, 0.06),
                borderTop: `1px solid ${withAlpha(STATUS_COLORS.predicted, 0.15)}`,
                borderBottom: `1px solid ${withAlpha(STATUS_COLORS.predicted, 0.08)}`,
              }}>
                <span title={note} style={{
                  fontSize: CHART_FONT.data, fontWeight: 800, color: STATUS_COLORS.predicted,
                  letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'help',
                }}>Forecast · {forecastMethodLabel(pred)}</span>
                <span style={{
                  fontSize: CHART_FONT.data, color: TEXT_COLORS.muted,
                }}>
                  {focusDriver} — laps {points[0].lap}-{points[points.length - 1].lap} from lap {pred.lap}
                  {forecastHeldOutMae(pred) != null && ` · held-out MAE ${forecastHeldOutMae(pred).toFixed(3)} s`}
                </span>
                {pitProb != null && (
                  <span title={pitLabel ? `Pit stop within ${FORECAST_LAPS} laps, by the ${pitLabel}` : undefined} style={{
                    marginLeft: 'auto',
                    fontSize: CHART_FONT.data, fontWeight: 700,
                    padding: '1px 5px', borderRadius: 3,
                    // The probability is the text; one forecast colour, stronger tint above 50 %
                    background: tintedChip(STATUS_COLORS.predicted, pitProb > 0.5 ? 0.3 : 0.12).background,
                    color: tintedChip(STATUS_COLORS.predicted, pitProb > 0.5 ? 0.3 : 0.12).color,
                  }}>
                    PIT {(pitProb * 100).toFixed(0)}%
                  </span>
                )}
              </div>

              {/* Predicted lap rows, at their target laps */}
              {points.map(({ lap: predLap, time }, i) => {
                // Delta vs the forecast's reference lap (last clean lap)
                const delta = refTime && refTime > 0 ? time - refTime : null;
                // team bar and tyre badge as context (mixed toward the row, D7)
                const marks = forecastRowMarks(focusRow.color, focusRow.compound);

                return (
                  <div
                    key={`pred-${predLap}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: gridColumns,
                      gap: `${TIMING_GAP}px`,
                      padding: `3px ${TIMING_PAD_X}px`,
                      borderBottom: `1px solid ${withAlpha(STATUS_COLORS.predicted, 0.06)}`,
                      background: i % 2 === 0 ? withAlpha(STATUS_COLORS.predicted, 0.03) : withAlpha(STATUS_COLORS.predicted, 0.015),
                    }}
                  >
                    {/* Position — show predicted lap number */}
                    <span style={{
                      ...cellStyle, justifyContent: 'center',
                      fontWeight: 700, fontSize: CHART_FONT.data,
                      color: STATUS_COLORS.predicted, fontStyle: 'italic',
                    }}>
                      L{predLap}
                    </span>

                    {/* Team color bar */}
                    <span style={{
                      width: 3, alignSelf: 'stretch', borderRadius: 1.5,
                      background: marks.bar,
                    }} />

                    {/* Driver name ("predicted" gives way first, in an ellipsis) */}
                    <span
                      title={`${focusRow.surname} predicted`}
                      style={{
                        ...cellStyle, justifyContent: 'flex-start',
                        fontSize: CHART_FONT.data, fontStyle: 'italic',
                        color: STATUS_COLORS.predicted,
                        fontFamily: 'var(--font-primary)',
                        overflow: 'hidden', minWidth: 0,
                      }}
                    >
                      <span style={{ fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{focusRow.surname}</span>
                      <span style={{
                        fontSize: CHART_FONT.label, marginLeft: 4, color: TEXT_COLORS.muted,
                        minWidth: 0, flexShrink: 1000, overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>predicted</span>
                    </span>

                    {/* S1 — empty for predicted */}
                    {show.s1 && <span style={{ ...cellStyle, color: TEXT_COLORS.muted, fontSize: CHART_FONT.data }}>—</span>}
                    {/* S2 */}
                    {show.s2 && <span style={{ ...cellStyle, color: TEXT_COLORS.muted, fontSize: CHART_FONT.data }}>—</span>}
                    {/* S3 */}
                    {show.s3 && <span style={{ ...cellStyle, color: TEXT_COLORS.muted, fontSize: CHART_FONT.data }}>—</span>}

                    {/* Predicted Lap Time */}
                    <span style={{
                      ...cellStyle, fontWeight: 700, fontSize: CHART_FONT.data,
                      color: STATUS_COLORS.predicted, fontStyle: 'italic',
                    }}>
                      {fmtTime(time)}
                    </span>

                    {/* Delta vs last actual */}
                    {show.gap && <span style={{
                      ...cellStyle, fontSize: CHART_FONT.data,
                      // Diverging pair with the sign: blue faster, orange slower
                      color: deltaColor(delta),
                    }}>
                      {delta != null ? signedDelta(delta) : ''}
                    </span>}

                    {/* Tyre — inherit from current */}
                    {show.tyre && <span style={{ ...cellStyle, justifyContent: 'center', gap: 3 }}>
                      <span style={{
                        minWidth: 14, height: 14, lineHeight: '14px', borderRadius: '50%', textAlign: 'center',
                        background: marks.badge, color: marks.badgeText,
                        fontSize: CHART_FONT.label, fontWeight: 800,
                      }}>{tyreLetter(focusRow.compound)}</span>
                    </span>}

                    {/* Tyre life — estimate */}
                    {show.laps && <span style={{
                      ...cellStyle, justifyContent: 'center',
                      color: TEXT_COLORS.muted, fontSize: CHART_FONT.data, fontStyle: 'italic',
                    }}>
                      {originTyreLife != null ? originTyreLife + (predLap - pred.lap) : '—'}
                    </span>}
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* Forecast mini-chart of the focus driver (the served method) */}
        {focusDriver && (
          <ForecastChart
            focusDriver={focusDriver}
            lstmPredictions={lstmPredictions}
            lapTimes={lapTimes}
            currentLap={currentLap}
            sessionNow={sessionNow}
          />
        )}
      </div>

      {/* Lap range brush bar: writes the shared brushed range (brushLapRange,
          which Position by Lap draws and brushes too) and the selected range
          of its other readers; shows whichever is set (V7, lapBrushUpdate) */}
      {!isQualifying && maxLap > 1 && (
        <LapRangeBrush
          maxLap={maxLap}
          currentLap={currentLap}
          selectedRange={brushLapRange || selectedLapRange}
          onRangeChange={(range) => {
            const next = lapBrushUpdate(range);
            setBrushLapRange(next.brushLapRange);
            setSelectedLapRange(next.selectedLapRange);
          }}
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
    <div className="lap-range-brush" style={{
      flexShrink: 0, padding: '4px 6px 6px',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(15,15,35,0.6)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
          Lap Range
        </span>
        {selectedRange && (
          <button
            onClick={() => onRangeChange(null)}
            style={{
              background: 'rgba(255,255,255,0.06)', border: `1px solid ${UI_COLORS.brush}`,
              borderRadius: 3, padding: '1px 6px', fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary,
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
        className="lap-range-brush__bar"
        style={{
          position: 'relative', height: 16, borderRadius: 3,
          background: 'rgba(255,255,255,0.04)', cursor: 'crosshair',
          overflow: 'hidden',
        }}
      >
        {/* Selected range highlight */}
        {selectedRange && (
          <div className="lap-range-brush__selection" data-range={`${selectedRange[0]}-${selectedRange[1]}`} style={{
            position: 'absolute', top: 0, bottom: 0,
            left: selLeft, width: selWidth,
            background: UI_COLORS.brushFill,
            borderLeft: `2px solid ${UI_COLORS.brush}`,
            borderRight: `2px solid ${UI_COLORS.brush}`,
          }} />
        )}
        {/* Current lap marker */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, width: 2,
          left: currentX - 1,
          background: GRID_COLORS.rule,
        }} />
        {/* Tick labels */}
        {ticks.map((l) => (
          <span key={l} style={{
            position: 'absolute', top: 0, fontSize: CHART_FONT.data, lineHeight: '16px',
            color: TEXT_COLORS.muted, fontWeight: 600,
            left: lapToX(l), transform: 'translateX(-50%)',
          }}>{l}</span>
        ))}
      </div>
    </div>
  );
}

/* ── Forecast Mini-Chart: D3 pace trend + the focus driver's forecast ── */
function ForecastChart({ focusDriver, lstmPredictions, lapTimes, currentLap, sessionNow }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  // The width of the box the chart fills, kept up to date (D4): the chart
  // lays out again when the pane is resized, so its labels stay at their
  // CHART_FONT size on screen (a viewBox kept from the first draw read 6.6 px)
  const box = useChartBox(svgRef);

  // The focus driver's forecast only (utils/forecast.js), at its target laps
  const pred = focusForecast(lstmPredictions, focusDriver);
  const predPointsAll = useMemo(() => forecastPoints(pred), [pred]);
  const predTimes = useMemo(() => predPointsAll.map((p) => p.time), [predPointsAll]);

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
    const { width: W } = chartSize(svgRef.current, box, { width: 400, height: 90 });
    const H = 90;
    const margin = { top: 14, right: 12, bottom: 18, left: 42 };
    const w = W - margin.left - margin.right;
    const h = H - margin.top - margin.bottom;
    if (w < 40 || h < 20) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    // Marks >= 3:1 and labels >= 4.5:1 on the panel (markColor / textColor)
    const driverColor = markColor(getDriverColor(focusDriver));
    const driverText = textColor(getDriverColor(focusDriver));

    // Build data points
    const actualPoints = recentLaps.map((d) => ({ lap: d.LapNumber, time: d.LapTimeSeconds, type: 'actual' }));
    const lastActual = actualPoints[actualPoints.length - 1];

    // Each forecast at its target lap (origin + 1 ..), joined to the
    // forecast's reference lap (the window's last clean lap) when it is drawn
    const predPoints = predPointsAll.map((p) => ({ lap: p.lap, time: p.time, type: 'predicted' }));
    const refLap = pred?.window?.ref_lap;
    const anchor = actualPoints.find((d) => d.lap === refLap) || actualPoints.find((d) => d.lap === pred?.lap);
    const fullPredLine = anchor ? [{ ...anchor, type: 'predicted' }, ...predPoints] : predPoints;

    const allPoints = [...actualPoints, ...predPoints];
    // Band = ± the served method's held-out MAE (response held_out; test
    // races of docs/evidence/evaluate_forecast.txt); none without it
    const mae = forecastHeldOutMae(pred);
    const band = predPoints.flatMap((d) => (mae != null ? [d.time - mae, d.time + mae] : []));
    const allTimes = [...allPoints.map((d) => d.time), ...band];
    const yMin = d3.min(allTimes);
    const yMax = d3.max(allTimes);
    const yPad = (yMax - yMin) * 0.15 || 0.5;

    const xScale = d3.scaleLinear()
      .domain([
        Math.min(actualPoints[0].lap, predPoints.length > 0 ? predPoints[0].lap : Infinity),
        Math.max(lastActual.lap, predPoints.length > 0 ? predPoints[predPoints.length - 1].lap : -Infinity),
      ])
      .range([0, w]);
    const yScale = d3.scaleLinear()
      .domain([yMin - yPad, yMax + yPad])
      .range([h, 0]);

    // Grid lines
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(xScale).ticks(Math.min(allPoints.length, 8)).tickSize(-h).tickFormat('')
    ).selectAll('line').attr('stroke', GRID_COLORS.grid);
    g.selectAll('.domain').remove();

    if (predPoints.length > 0 && mae != null) {
      const uncertainty = d3.area()
        .x((d) => xScale(d.lap))
        .y0((d) => yScale(d.time + mae))
        .y1((d) => yScale(d.time - mae))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(predPoints)
        .attr('d', uncertainty)
        .attr('class', 'forecast-band')
        .attr('fill', driverColor)
        .attr('opacity', 0.18);
    }

    // Vertical separator at the forecast's origin lap
    if (predPoints.length > 0 && Number.isFinite(pred?.lap)) {
      g.append('line')
        .attr('x1', xScale(pred.lap)).attr('x2', xScale(pred.lap))
        .attr('y1', 0).attr('y2', h)
        .attr('stroke', GRID_COLORS.axis).attr('stroke-dasharray', '2,2');
    }

    // Actual pace line (solid)
    const line = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.time)).curve(d3.curveMonotoneX);
    g.append('path').datum(actualPoints).attr('d', line)
      .attr('fill', 'none').attr('stroke', driverColor).attr('stroke-width', 1.8);

    // Predicted pace line (dashed)
    if (fullPredLine.length > 1) {
      const predLine = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.time)).curve(d3.curveMonotoneX);
      g.append('path').datum(fullPredLine).attr('d', predLine)
        .attr('fill', 'none').attr('stroke', driverColor).attr('stroke-width', 1.8)
        .attr('stroke-dasharray', '6,4');
    }

    // Actual lap dots
    g.selectAll('.actual-dot')
      .data(actualPoints)
      .join('circle')
      .attr('cx', (d) => xScale(d.lap)).attr('cy', (d) => yScale(d.time))
      .attr('r', 2.5).attr('fill', driverColor);

    // Predicted lap dots (larger, with white stroke)
    g.selectAll('.pred-dot')
      .data(predPoints)
      .join('circle')
      .attr('cx', (d) => xScale(d.lap)).attr('cy', (d) => yScale(d.time))
      .attr('r', 3.5).attr('fill', driverColor).attr('stroke', TEXT_COLORS.primary).attr('stroke-width', 1)
      .style('cursor', 'pointer');

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

    // The method that made the forecast (method_label of the response)
    if (predPoints.length > 0) {
      g.append('text')
        .attr('x', xScale(predPoints[0].lap))
        .attr('y', -4)
        .attr('fill', driverText)
        .style('font-size', CHART_FONT.data)
        .attr('font-weight', 700)
        .text(`Forecast: ${forecastMethodLabel(pred)}`);
    }

    // Driver label + pit probability
    g.append('text')
      .attr('x', 0).attr('y', -4)
      .attr('fill', driverText)
      .style('font-size', CHART_FONT.data)
      .attr('font-weight', 800)
      .text(focusDriver);

    const pitProb = forecastPit(pred).probability;
    if (pitProb != null) {
      g.append('text')
        .attr('x', w).attr('y', -4)
        .attr('text-anchor', 'end')
        .attr('fill', pitProb > 0.5 ? STATUS_COLORS.predicted : TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.data)
        .attr('font-weight', 700)
        .text(`PIT ${(pitProb * 100).toFixed(0)}%`);
    }

    // X-axis
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(xScale).ticks(Math.min(allPoints.length, 8)).tickFormat(d3.format('d'))
    ).selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);
    g.selectAll('.domain').attr('stroke', GRID_COLORS.axis);
    g.selectAll('.tick line').attr('stroke', GRID_COLORS.axis);

    // Y-axis (time)
    g.append('g').call(
      d3.axisLeft(yScale).ticks(3).tickFormat((d) => {
        const m = Math.floor(d / 60);
        const s = (d % 60).toFixed(1);
        return m > 0 ? `${m}:${s.padStart(4, '0')}` : s;
      })
    ).selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);
  }, [recentLaps, predPointsAll, predTimes, focusDriver, pred, currentLap, box.width, box.height]);

  if (recentLaps.length < 2 && predTimes.length === 0) return null;

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid rgba(255,255,255,0.08)',
      background: 'rgba(15,15,35,0.5)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* The marks of the chart: solid laps, dashed forecast, ± MAE band */}
      <Legend items={forecastChartLegend(getDriverColor(focusDriver), forecastHeldOutMae(pred) != null)} />
      <div ref={tooltipRef} style={{
        position: 'absolute', pointerEvents: 'none', opacity: 0,
        background: 'rgba(10,10,25,0.9)', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4, padding: '2px 6px', fontSize: CHART_FONT.data, color: STATUS_COLORS.predicted,
        fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
        zIndex: 5, transition: 'opacity 0.1s',
      }} />
      <svg ref={svgRef} style={{ width: '100%', height: 90, display: 'block' }} />
    </div>
  );
}
