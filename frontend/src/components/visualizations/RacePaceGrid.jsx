import React, { useMemo, useCallback, useState, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, contrastText, TEXT_COLORS, UI_COLORS, CHART_FONT, SURFACES, GRID_COLORS, withAlpha,
  UNKNOWN_TEAM_COLOR, chartFontPx, compositeOver,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey } from '../../utils/strategyViews';
import {
  paceGridData, paceCell, PACE_CELL_STYLES as CELL_STYLES, PACE_CELL_GLYPHS, paceLegend,
  paceColumns, paceLabel, paceLapWindow,
  PACE_LAP_COL_W as LAP_COL_W, PACE_HEADER_H as HEADER_H, PACE_ROW_MIN, PACE_ROW_MAX,
} from '../../utils/views/racePaceGrid';
import { useBoxSize, fitRows, pageOf } from '../../utils/views/chartBox';
import Legend from '../ui/Legend';

/* -- Styles ---------------------------------------------------------------- */
// The grid fits its panel and never scrolls: the cells take the panel width
// (paceColumns: 78 px down to 36 px, then the drivers are paged) and the
// rows its height (fitRows: 26 px down to 18 px, then the most recent laps
// that fit are shown, older ones a page back with the lap pager).
const containerStyle = {
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(10,10,20,0.95)',
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: CHART_FONT.data,
  color: TEXT_COLORS.secondary,
  userSelect: 'none',
  position: 'relative',
};

const tableStyle = {
  borderCollapse: 'separate',
  borderSpacing: 0,
  tableLayout: 'fixed',
};

/* -- Memoized Cell component ----------------------------------------------- */
// Header of a context driver (not selected): the team colour at 25 % over the
// panel (repair_contrast.txt: secondary text >= 4.5:1 on every team tint)
const dimmedHeaderBg = (teamColor) => compositeOver(withAlpha(teamColor, 0.25), SURFACES.panel);

const PaceCell = React.memo(function PaceCell({
  label, glyph, cellStyle, tooltip, dimmed, isHighlighted, cellW, rowH, compact,
  onClick, onDoubleClick, onMouseEnter, onMouseLeave,
}) {
  const style = {
    width: cellW, minWidth: cellW, maxWidth: cellW,
    height: rowH,
    padding: '0 2px', // racePaceGrid.js CELL_PAD_PX
    textAlign: 'center',
    lineHeight: `${rowH - 1}px`,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    borderRight: '1px solid rgba(255,255,255,0.04)',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    ...cellStyle,
    // Focus + context: the cell of a context driver (not selected) is never
    // faded (at opacity 0.35 its text read 1.9-2.6:1): it drops its pace
    // colour and tint for the muted text colour (>= 4.5:1), keeping its glyph
    // (docs/COLOR_ENCODING.md, focus + context)
    ...(dimmed && cellStyle?.color !== 'transparent' ? { color: TEXT_COLORS.muted, background: 'transparent' } : {}),
  };

  if (isHighlighted) {
    style.background = 'rgba(255,255,255,0.06)';
  }

  return (
    <td
      style={style}
      title={tooltip}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {glyph && label ? <span className="timing-glyph">{compact ? glyph : `${glyph} `}</span> : null}
      {label}
    </td>
  );
});

/* -- Main component -------------------------------------------------------- */
function RacePaceGrid() {
  const sessionData = useF1Store((s) => s.sessionData);
  const drivers = useF1Store((s) => s.sessionData?.drivers || s.drivers || []);
  const currentLap = useF1Store((s) => s.currentLap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  // Causal "now" in session seconds (utils/raceTime.js): a cell shows a lap
  // time once that lap is completed, a pit once its entry has happened
  const sessionNow = useSessionNow();
  const maxLap = useF1Store((s) => s.maxLap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const triggerPrediction = useF1Store((s) => s.triggerPrediction);

  // Defensive filter: when we have a real driver_info list, only consider
  // lap_times whose Driver matches a known abbreviation. Without this,
  // rows can leak in for pre-DriverList SignalR entries that used the raw
  // racing number ("1", "11", ...) as the Driver field.
  const validAbbrSet = useMemo(() => {
    const s = new Set();
    for (const d of drivers) {
      const a = d.Abbreviation || d.abbr;
      if (a) s.add(a);
    }
    return s;
  }, [drivers]);

  const lapTimes = useMemo(() => {
    const all = sessionData?.lap_times || [];
    return validAbbrSet.size > 0 ? all.filter((lt) => validAbbrSet.has(lt.Driver)) : all;
  }, [sessionData, validAbbrSet]);
  const raceResults = sessionData?.race_results || [];

  // Grid area measured for the fit (a callback ref: it exists only once
  // there are laps), the lap window paged back by the user (null = follow the
  // replay) and the page of driver columns
  const [gridEl, setGridEl] = useState(null);
  const gridRef = useMemo(() => ({ current: gridEl }), [gridEl]);
  const gridBox = useBoxSize(gridRef);
  const [pinnedLast, setPinnedLast] = useState(null);
  const [driverPage, setDriverPage] = useState(0);
  // a new session starts from its most recent laps and its first drivers
  const sessionKey = useF1Store((s) => `${s.sessionData?.session_info?.year}-${s.sessionData?.session_info?.round}-${s.isLiveMode}`);
  useEffect(() => { setPinnedLast(null); setDriverPage(0); }, [sessionKey]);

  // -- Column order: grid slot while the race runs (the final classification
  // is not known yet), final position once it is over (sessionNow Infinity) --
  const raceOver = sessionNow === Infinity;
  const sortedDrivers = useMemo(() => {
    const driverSet = new Map();
    for (const lt of lapTimes) {
      if (lt.Driver && !driverSet.has(lt.Driver))
        driverSet.set(lt.Driver, { abbr: lt.Driver, position: 999 });
    }
    for (const d of drivers) {
      const abbr = d.Abbreviation || d.abbr;
      if (abbr && !driverSet.has(abbr))
        driverSet.set(abbr, { abbr, position: 999 });
    }
    for (const r of raceResults) {
      const abbr = r.Abbreviation || r.abbr;
      if (abbr && driverSet.has(abbr)) {
        const pos = raceOver
          ? parseInt(r.ClassifiedPosition || r.Position, 10)
          : parseInt(r.GridPosition, 10);
        if (!isNaN(pos) && pos > 0) driverSet.get(abbr).position = pos;
      }
    }
    if (!raceResults.length) {
      for (const lt of lapTimes) {
        if (lt.Driver && lt.Position && driverSet.has(lt.Driver)) {
          const entry = driverSet.get(lt.Driver);
          const pos = parseInt(lt.Position, 10);
          if (!isNaN(pos) && (entry.position === 999 || lt.LapNumber >= (entry._latestLap || 0))) {
            entry.position = pos;
            entry._latestLap = lt.LapNumber;
          }
        }
      }
    }
    return Array.from(driverSet.values()).sort((a, b) => a.position - b.position);
  }, [lapTimes, raceResults, drivers, raceOver]);

  // -- Completed laps, laps in progress, retirements and pit stops at sessionNow
  // (paceGridData, utils/views). Rebuilt when a lap completes or a pit event happens
  // (causalKey), not on every replay tick; the chrono reads sessionNow directly.
  const gridKey = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  const gridData = useMemo(
    () => paceGridData(lapTimes, sessionNow, { dnfMap, isLiveMode }),
    // sessionNow enters through gridKey, which changes whenever the result does
    [lapTimes, gridKey, dnfMap, isLiveMode],
  );
  const pitCountByDriver = gridData.pitCounts;

  // -- Get driver team color --
  const driverTeamColors = useMemo(() => {
    const colors = {};
    for (const d of sortedDrivers) colors[d.abbr] = getDriverColor(d.abbr);
    return colors;
  }, [sortedDrivers]);

  // -- Handlers --
  const handleCellClick = useCallback((abbr) => toggleDriver(abbr), [toggleDriver]);
  // Double-click a cell: that driver becomes the focus and gets the lap-time
  // forecast from that lap (the store's one trigger; a lap later than the
  // replay's is clamped to it)
  const handleCellDoubleClick = useCallback((abbr, lap) => {
    if (useF1Store.getState().focusDriver !== abbr) setFocusDriver(abbr);
    triggerPrediction(abbr, lap);
  }, [setFocusDriver, triggerPrediction]);

  const handleHeaderClick = useCallback((abbr) => toggleDriver(abbr), [toggleDriver]);
  const handleHeaderDoubleClick = useCallback((abbr) => setFocusDriver(abbr), [setFocusDriver]);
  const handleMouseEnter = useCallback((abbr) => setHighlightedDriver(abbr), [setHighlightedDriver]);
  const handleMouseLeave = useCallback(() => setHighlightedDriver(null), [setHighlightedDriver]);

  // Replay frames loaded: running laps show a live chronometer
  const replayActive = totalFrames > 0;

  // -- Render --
  if (!lapTimes.length || !sortedDrivers.length) {
    if (isLiveMode) {
      return (
        <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: TEXT_COLORS.secondary, fontSize: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', padding: 24 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: UI_COLORS.accent,
              boxShadow: `0 0 10px ${withAlpha(UI_COLORS.accent, 0.6)}`,
              animation: 'livePulse 1.5s ease-in-out infinite',
            }} />
            <span style={{ fontWeight: 600 }}>Waiting for live laps…</span>
            <span style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.data, maxWidth: 280 }}>
              Pace cells will appear as drivers complete each lap.
            </span>
          </div>
        </div>
      );
    }
    return (
      <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: TEXT_COLORS.muted, fontSize: 13 }}>
        No lap time data available
      </div>
    );
  }

  const gridMaxLap = isLiveMode ? currentLap : maxLap;
  const hasSelection = selectedDrivers.length > 0;

  // -- Fit: columns to the width, rows to the height (no scroll) --
  const cols = paceColumns(gridBox.width, sortedDrivers.length, chartFontPx('data'));
  const cellW = cols.cellW;
  const compact = cols.format !== 'full';
  const driverPg = pageOf(sortedDrivers, driverPage, cols.perPage);
  const shownDrivers = driverPg.rows;
  const rowFit = fitRows(gridBox.height - HEADER_H, gridMaxLap, {
    rowMin: PACE_ROW_MIN, rowMax: PACE_ROW_MAX, rowDefault: PACE_ROW_MAX,
  });
  const rowH = rowFit.rowH;
  const win = paceLapWindow(gridMaxLap, currentLap, rowFit.perPage, pinnedLast);
  const lapNumbers = [];
  for (let i = win.first; i <= win.last; i++) lapNumbers.push(i);
  const pagerBtn = (enabled) => ({
    fontSize: CHART_FONT.label, color: enabled ? TEXT_COLORS.primary : TEXT_COLORS.muted, background: 'transparent',
    border: `1px solid ${GRID_COLORS.rule}`, borderRadius: 3, padding: '0 6px',
    cursor: enabled ? 'pointer' : 'default',
  });

  return (
    <div style={containerStyle}>
      <div ref={setGridEl} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <table style={{ ...tableStyle, width: LAP_COL_W + cellW * shownDrivers.length }}>
        <thead>
          <tr>
            {/* Corner cell */}
            <th style={{
              width: LAP_COL_W, minWidth: LAP_COL_W, maxWidth: LAP_COL_W,
              height: HEADER_H,
              background: SURFACES.panel, color: TEXT_COLORS.muted,
              fontSize: CHART_FONT.label, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.06em', textAlign: 'center', verticalAlign: 'middle',
              borderRight: '1px solid rgba(255,255,255,0.08)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
              Lap
            </th>
            {/* Driver headers */}
            {shownDrivers.map((d) => {
              const teamColor = driverTeamColors[d.abbr] || UNKNOWN_TEAM_COLOR;
              const isSelected = selectedDrivers.includes(d.abbr);
              const isHighlighted = highlightedDriver === d.abbr;
              const dimmed = hasSelection && !isSelected;
              return (
                <th
                  key={d.abbr}
                  style={{
                    width: cellW, minWidth: cellW, maxWidth: cellW,
                    height: HEADER_H,
                    fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                    fontSize: CHART_FONT.data, fontWeight: 700, textAlign: 'center',
                    cursor: 'pointer',
                    borderRight: '1px solid rgba(255,255,255,0.08)',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                    // team-colour header (teammate tint, V3): black or white text by
                    // contrast; a context driver (not selected) gets a dark team tint
                    // with the secondary text colour instead of a lower opacity, so
                    // its code keeps >= 4.5:1 (COLOR_ENCODING.md, focus + context)
                    background: dimmed ? dimmedHeaderBg(teamColor) : teamColor,
                    color: dimmed ? TEXT_COLORS.secondary : contrastText(teamColor),
                    transition: 'background 0.15s ease, box-shadow 0.15s ease',
                    boxShadow: isHighlighted ? 'inset 0 0 0 1px rgba(255,255,255,0.5)' : 'none',
                  }}
                  onClick={() => handleHeaderClick(d.abbr)}
                  onDoubleClick={() => handleHeaderDoubleClick(d.abbr)}
                  onMouseEnter={() => handleMouseEnter(d.abbr)}
                  onMouseLeave={handleMouseLeave}
                >
                  <div style={{ lineHeight: 1.1 }}>
                    {d.abbr}
                    {(pitCountByDriver[d.abbr] || 0) > 0 && (
                      <div style={{
                        fontSize: CHART_FONT.label, fontWeight: 600,
                        letterSpacing: '0.03em', marginTop: 1,
                      }}>
                        {pitCountByDriver[d.abbr]}P
                      </div>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {lapNumbers.map((lap) => {
            const isCurrent = lap === currentLap;
            return (
              <tr
                key={lap}
                style={isCurrent ? { borderTop: '1px solid rgba(255,255,255,0.25)' } : undefined}
              >
                {/* Lap number */}
                <td style={{
                  width: LAP_COL_W, minWidth: LAP_COL_W, maxWidth: LAP_COL_W,
                  height: rowH,
                  background: SURFACES.panel,
                  fontSize: CHART_FONT.data, textAlign: 'center', verticalAlign: 'middle',
                  borderRight: '1px solid rgba(255,255,255,0.08)',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  color: isCurrent ? TEXT_COLORS.primary : TEXT_COLORS.muted,
                  fontWeight: isCurrent ? 700 : 400,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {lap}
                </td>
                {/* Driver cells */}
                {shownDrivers.map((d) => {
                  const abbr = d.abbr;
                  const lapKey = `${abbr}_${lap}`;
                  const { label, style: styleKey, tooltip } = paceCell(
                    gridData, abbr, lap, { currentLap, replayActive, sessionNow },
                  );
                  const isHighlighted = highlightedDriver === abbr;
                  const dimmed = hasSelection && !selectedDrivers.includes(abbr);

                  return (
                    <PaceCell
                      key={lapKey}
                      label={paceLabel(label, cols.format)}
                      cellW={cellW}
                      rowH={rowH}
                      compact={compact}
                      glyph={PACE_CELL_GLYPHS[styleKey]}
                      cellStyle={CELL_STYLES[styleKey] || CELL_STYLES.default}
                      tooltip={tooltip}
                      isHighlighted={isHighlighted}
                      dimmed={dimmed}
                      onClick={() => handleCellClick(abbr)}
                      onDoubleClick={() => handleCellDoubleClick(abbr, lap)}
                      onMouseEnter={() => handleMouseEnter(abbr)}
                      onMouseLeave={handleMouseLeave}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* Pace legend: every cell colour with its glyph / sample text
          (paceLegend), and the pagers of the laps and drivers that do not fit.
          The lap pager's slot is always there, hidden while every lap fits:
          its arrival no longer wraps the bar onto one more line after the
          rows were fitted to the grid's height (browser pass 2026-10-16 at
          1536 x 750: 12 rows, 246 px, fitted to a 254 px grid that the pager
          then cut to 237 px), so the measured grid is the final one */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '2px 8px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(10,10,20,0.98)',
      }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <Legend items={paceLegend()} shape="glyph" title="Lap vs driver median" />
        </div>
        <div className="pace-grid__pager" style={{
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary,
        }}
        >
          <span className="pace-grid__lap-pager" aria-hidden={rowFit.paged ? undefined : 'true'} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            visibility: rowFit.paged ? 'visible' : 'hidden',
          }}
          >
            <button type="button" aria-label="Older laps" disabled={!rowFit.paged || !win.canOlder}
              tabIndex={rowFit.paged ? undefined : -1}
              onClick={() => setPinnedLast(Math.max(win.size, win.last - win.size))} style={pagerBtn(win.canOlder)}
            >{'◀'}</button>
            <span title={win.following ? 'The most recent laps, following the replay' : 'Older laps: the right arrow returns to the most recent'}>
              L{win.first}{'–'}{win.last} of {gridMaxLap}
            </span>
            <button type="button" aria-label="Newer laps" disabled={!rowFit.paged || !win.canNewer}
              tabIndex={rowFit.paged ? undefined : -1}
              onClick={() => setPinnedLast(win.last + win.size)} style={pagerBtn(win.canNewer)}
            >{'▶'}</button>
          </span>
          {driverPg.pages > 1 && (
            <>
              <button type="button" aria-label="Previous drivers" disabled={driverPg.page === 0}
                onClick={() => setDriverPage(driverPg.page - 1)} style={pagerBtn(driverPg.page > 0)}
              >{'◀'}</button>
              <span>drivers {driverPg.first}{'–'}{driverPg.last} of {sortedDrivers.length}</span>
              <button type="button" aria-label="Next drivers" disabled={driverPg.page >= driverPg.pages - 1}
                onClick={() => setDriverPage(driverPg.page + 1)} style={pagerBtn(driverPg.page < driverPg.pages - 1)}
              >{'▶'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default React.memo(RacePaceGrid);
