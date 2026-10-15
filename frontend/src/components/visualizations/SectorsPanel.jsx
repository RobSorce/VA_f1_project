import React, { useMemo, useState, useRef, useCallback, useLayoutEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, markColor, STATUS_COLORS, STATUS_GLYPHS, TEXT_COLORS, CHART_FONT, chartFontPx,
  contextColor, SURFACES,
} from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  SPEED_COLS, sectorsPanelData, sectorsLegend, sectorsRowFit, sectorsColumnsFit,
  SECTORS_PAGER_H, SECTORS_COL_EM, SECTORS_COL_GAP, SECTORS_ROW_MIN,
} from '../../utils/views/sectorsPanel';
import { BEST_AXIS_H } from '../../utils/views/sectorsBestChart';
import { useBoxSize, pageOf } from '../../utils/views/chartBox';
import Legend from '../ui/Legend';
import SectorsBestTab from './SectorsBestTab';


// Team bar of a row: a context row's (not selected, or another row hovered)
// mixed toward the panel (contextColor, >= 2:1, D7), never an opacity
const teamBar = (color, context) => (context ? contextColor(markColor(color), SURFACES.panel) : markColor(color));

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

const BEST_SECTORS = ['1', '2', '3'];

export default function SectorsPanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const [view, setView] = useState('live');
  const panelRef = useRef(null);
  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, `sectors_${view}.png`);
  }, [view]);

  /* ── Fit (Phase 9c D1): the rows' body and the columns' row are measured
     (callback refs: they exist only once there is data) ─────────────── */
  const [bodyEl, setBodyEl] = useState(null);
  // The pager line sits under the rows: the room it takes is given back to
  // the fit, so the fit does not change when it appears. Whether the pager
  // was on screen travels with each measure of the body (box.tag): a render
  // between the commit that shows the pager and the measure that sees it
  // still gives back nothing (round 1 added the pager line of the previous
  // render to a body measured without it, and could unpage for a frame)
  const pagerInDomRef = useRef(false);
  const bodyBox = useBoxSize(useMemo(() => ({ current: bodyEl }), [bodyEl]), undefined, { tagRef: pagerInDomRef });
  const [areaEl, setAreaEl] = useState(null);
  const areaBox = useBoxSize(useMemo(() => ({ current: areaEl }), [areaEl]));
  const [rowPage, setRowPage] = useState(0);
  const [colPage, setColPage] = useState(0);

  const toDisplaySpeed = (kmh) => speedUnit === 'mph' ? Math.round(kmh * 0.6214 * 10) / 10 : kmh;
  const speedLabel = speedUnit === 'mph' ? 'mph' : 'km/h';

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const replayActive = totalFrames > 0;

  // Causal "now" in session seconds (utils/raceTime.js): each driver's lap as
  // it was at that time, bests and rankings from completed laps only
  const sessionNow = useSessionNow();
  const { liveRows, bestRankings, bestSessionBests, speedRankings } = useMemo(
    () => sectorsPanelData(lapTimes, sessionNow, { dnfMap, replayActive, isLiveMode }),
    [lapTimes, sessionNow, dnfMap, replayActive, isLiveMode],
  );

  const hasData = (view === 'live' && liveRows.length > 0)
    || (view === 'best' && Object.keys(bestRankings).length > 0)
    || (view === 'speeds' && Object.keys(speedRankings).length > 0);

  // Columns of the tab (Best: the three sectors, Top Speeds: the four traps)
  // that fit side by side, the others on the next column page
  const columnKeys = view === 'best' ? BEST_SECTORS : view === 'speeds' ? SPEED_COLS.map((c) => c.key) : [];
  const colsPerPage = columnKeys.length
    ? sectorsColumnsFit(areaBox.width, columnKeys.length, Math.ceil(SECTORS_COL_EM * chartFontPx('data')), SECTORS_COL_GAP)
    : 1;
  const colPg = pageOf(columnKeys, colPage, colsPerPage);
  const rankLists = view === 'best' ? BEST_SECTORS.map((s) => bestRankings[s] || [])
    : view === 'speeds' ? SPEED_COLS.map(({ key }) => speedRankings[key] || []) : [liveRows];
  const rowCount = Math.max(0, ...rankLists.map((l) => l.length));
  const colPaged = colPg.pages > 1;
  // Rows: the measured body plus the pager line when it was on screen at
  // that measure (given back), less the pager line the column pages always need
  const rowsRoom = bodyBox.height > 0
    ? bodyBox.height + (bodyBox.tag ? SECTORS_PAGER_H : 0) - (colPaged ? SECTORS_PAGER_H : 0)
    : 0;
  // Best tab: the gap axis (BEST_AXIS_H) under the rows whenever its room
  // costs no page (secondary content, D1: the value next to each bar stays)
  const bestAxisRoom = view === 'best' && rowsRoom > 0 && rowCount * SECTORS_ROW_MIN <= rowsRoom - BEST_AXIS_H
    ? BEST_AXIS_H : 0;
  const rowFit = sectorsRowFit(rowsRoom - bestAxisRoom, rowCount);
  const rowPg = pageOf(Array.from({ length: rowCount }, (_, i) => i), rowFit.paged ? rowPage : 0, rowFit.perPage);
  const rowStart = rowPg.first > 0 ? rowPg.first - 1 : 0;
  const rowEnd = rowPg.last;
  const pagerShown = rowFit.paged || colPaged;
  // the pager on screen after this commit (read by the next measure)
  useLayoutEffect(() => { pagerInDomRef.current = hasData && pagerShown; });

  if (!hasData) {
    return (
      <div className="sectors-panel__empty">
        No sector data available. Load a session first.
      </div>
    );
  }

  const rowStyle = (isHl) => ({
    height: rowFit.rowH,
    background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
    cursor: 'pointer',
    transition: 'background 0.15s',
  });
  const colLabel = (key) => (view === 'best' ? `S${key}` : SPEED_COLS.find((c) => c.key === key)?.label || key);

  return (
    <div ref={panelRef} className="sectors-panel-wrapper">
      {/* ── Toggle, then the colour legend of the tab shown (sectorsLegend:
          glyph + colour), on one line that wraps on a narrow pane ── */}
      <div className="sectors-panel__toggle">
        <button
          className={`sectors-panel__toggle-btn${view === 'live' ? ' sectors-panel__toggle-btn--active' : ''}`}
          onClick={() => setView('live')}
        >
          Live
        </button>
        <button
          className={`sectors-panel__toggle-btn${view === 'best' ? ' sectors-panel__toggle-btn--active' : ''}`}
          onClick={() => setView('best')}
        >
          Best
        </button>
        <button
          className={`sectors-panel__toggle-btn${view === 'speeds' ? ' sectors-panel__toggle-btn--active' : ''}`}
          onClick={() => setView('speeds')}
        >
          Top Speeds
        </button>
        <div className="sectors-panel__legend">
          <Legend items={sectorsLegend(view)} shape="glyph" />
        </div>
        <button
          onClick={handleExport}
          title="Export as PNG"
          style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 4,
            border: 'none', background: 'transparent',
            color: TEXT_COLORS.muted, cursor: 'pointer',
            fontSize: '12px', padding: 0, flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      {/* ── Live Sector Times (current lap, chronometer) ── */}
      {view === 'live' && (
        <div className="sectors-panel__live">
          {/* Column header */}
          <div className="sectors-panel__live-header">
            <span className="sectors-panel__live-hdr-pos">P</span>
            <span className="sectors-panel__live-hdr-bar" />
            <span className="sectors-panel__live-hdr-drv">Driver</span>
            <span className="sectors-panel__live-hdr-sec">S1</span>
            <span className="sectors-panel__live-hdr-sec">S2</span>
            <span className="sectors-panel__live-hdr-sec">S3</span>
            <span className="sectors-panel__live-hdr-sec">LAP</span>
          </div>
          {/* Driver rows: the page of the fit */}
          <div ref={setBodyEl} className="sectors-panel__live-body">
            {liveRows.slice(rowStart, rowEnd).map((row) => {
              const color = getDriverColor(row.driver);
              const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(row.driver);
              const isHl = highlightedDriver === row.driver;
              const isDimmed = highlightedDriver && !isHl;
              return (
                <div key={row.driver} className={`sectors-panel__live-row${!isSelected || isDimmed ? ' sectors-panel__row--context' : ''}`}
                  onMouseEnter={() => setHighlightedDriver(row.driver)}
                  onMouseLeave={() => setHighlightedDriver(null)}
                  onClick={() => setFocusDriver(row.driver)}
                  style={rowStyle(isHl)}
                >
                  <span className="sectors-panel__live-pos">{row.pos}</span>
                  <span className="sectors-panel__team-bar" style={{ backgroundColor: teamBar(color, !isSelected || isDimmed) }} />
                  <span className="sectors-panel__live-drv">{row.driver}</span>
                  {row.sectors.map((s, i) => {
                    const sectorNum = i + 1;
                    const isChrono = !s.show && row.chrono?.sector === sectorNum;
                    return (
                      <span
                        key={i}
                        className={`sectors-panel__live-sec${!s.show ? ' sectors-panel__live-sec--pending' : ''}`}
                        style={
                          s.show && s.val
                            ? { color: s.color }
                            : isChrono
                              ? { color: STATUS_COLORS.running, fontStyle: 'italic', fontVariantNumeric: 'tabular-nums' }
                              : undefined
                        }
                      >
                        {s.show && s.glyph && s.val ? <span className="timing-glyph">{s.glyph} </span> : null}
                        {s.show ? formatTime(s.val) : isChrono ? row.chrono.elapsed.toFixed(1) : '—'}
                      </span>
                    );
                  })}
                  <span
                    className="sectors-panel__live-sec sectors-panel__live-sec--lap"
                    style={!row.lapTime && row.runningLap != null
                      ? { color: STATUS_COLORS.running, fontStyle: 'italic', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }
                      : undefined}
                  >
                    {row.lapTime
                      ? formatTime(row.lapTime)
                      : row.runningLap != null
                        ? row.runningLap.toFixed(1)
                        : '—'}
                  </span>
                </div>
              );
            })}
            {liveRows.length === 0 && (
              <div className="sectors-panel__empty">Press play to start</div>
            )}
          </div>
        </div>
      )}

      {/* ── Best Sector Times (accumulated rankings): SectorsBestTab draws
          the page of sectors and ranks the fit gives it ── */}
      {view === 'best' && (
        <div ref={setAreaEl} className="sectors-panel__columns">
          <SectorsBestTab
            sectors={colPg.rows}
            bestRankings={bestRankings}
            bestSessionBests={bestSessionBests}
            currentLap={currentLap}
            rowStart={rowStart}
            rowEnd={rowEnd}
            rowH={rowFit.rowH}
            selectedDrivers={selectedDrivers}
            highlightedDriver={highlightedDriver}
            onHover={setHighlightedDriver}
            onFocus={setFocusDriver}
            bodyRef={setBodyEl}
          />
        </div>
      )}

      {/* ── Top Speeds View (the unit is in each column's header) ── */}
      {view === 'speeds' && (
        <div ref={setAreaEl} className="sectors-panel__columns">
          {colPg.rows.map((key, colIdx) => {
            const label = colLabel(key);
            const items = speedRankings[key] || [];
            const fastest = items[0]?.speed || 0;
            return (
              <div key={key} className="sectors-panel__column sectors-panel__column--speed">
                <div className="sectors-panel__col-header">
                  <span className="sectors-panel__col-title" title={`${label}, lap ${currentLap}`}>{label} <span style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.label, fontWeight: 400 }}>Lap {currentLap}</span></span>
                  {fastest > 0 && (
                    <span className="sectors-panel__col-best sectors-panel__col-best--purple">
                      {toDisplaySpeed(fastest)} {speedLabel}
                    </span>
                  )}
                </div>
                <div ref={colIdx === 0 ? setBodyEl : undefined} className="sectors-panel__col-body">
                  {items.slice(rowStart, rowEnd).map((entry) => {
                    const color = getDriverColor(entry.driver);
                    const isFastest = entry.rank === 1;
                    const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(entry.driver);
                    const isHl = highlightedDriver === entry.driver;
                    const isDimmed = highlightedDriver && !isHl;
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isFastest ? ' sectors-panel__row--best' : ''}${!isSelected || isDimmed ? ' sectors-panel__row--context' : ''}`}
                        onMouseEnter={() => setHighlightedDriver(entry.driver)}
                        onMouseLeave={() => setHighlightedDriver(null)}
                        onClick={() => setFocusDriver(entry.driver)}
                        title={`${entry.driver}: ${toDisplaySpeed(entry.speed)} ${speedLabel} (lap ${entry.lap})`}
                        style={rowStyle(isHl)}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: teamBar(color, !isSelected || isDimmed) }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span
                          className="sectors-panel__speed-val"
                          style={{ color: isFastest ? STATUS_COLORS.overallBest : TEXT_COLORS.primary }}
                        >
                          {isFastest && <span className="timing-glyph">{STATUS_GLYPHS.overallBest} </span>}
                          {toDisplaySpeed(entry.speed)}
                        </span>
                        {entry.rank > 1 && fastest > 0 && (
                          <span className="sectors-panel__gap">
                            -{toDisplaySpeed(fastest - entry.speed).toFixed(1)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Pager of the ranks (and of the columns) that do not fit ── */}
      {pagerShown && (
        <div className="sectors-panel__pager" style={{ height: SECTORS_PAGER_H }}>
          {rowFit.paged && (
            <span className="sectors-panel__pager-group">
              <button
                type="button"
                className="sectors-panel__pager-btn"
                onClick={() => setRowPage(rowPg.page - 1)}
                disabled={rowPg.page === 0}
                aria-label="Previous positions"
              >{'▲'}</button>
              <span>P{rowPg.first}–P{rowPg.last} of {rowCount}</span>
              <button
                type="button"
                className="sectors-panel__pager-btn"
                onClick={() => setRowPage(rowPg.page + 1)}
                disabled={rowPg.page >= rowPg.pages - 1}
                aria-label="Next positions"
              >{'▼'}</button>
            </span>
          )}
          {colPaged && (
            <span className="sectors-panel__pager-group">
              <button
                type="button"
                className="sectors-panel__pager-btn"
                onClick={() => setColPage(colPg.page - 1)}
                disabled={colPg.page === 0}
                aria-label="Previous columns"
              >{'◀'}</button>
              <span>{colLabel(colPg.rows[0])}{colPg.rows.length > 1 ? `–${colLabel(colPg.rows[colPg.rows.length - 1])}` : ''} ({colPg.first}–{colPg.last} of {columnKeys.length})</span>
              <button
                type="button"
                className="sectors-panel__pager-btn"
                onClick={() => setColPage(colPg.page + 1)}
                disabled={colPg.page >= colPg.pages - 1}
                aria-label="Next columns"
              >{'▶'}</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
