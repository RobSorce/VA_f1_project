import React, { useMemo, useState, useRef, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, markColor, STATUS_COLORS, STATUS_GLYPHS, TEXT_COLORS, CHART_FONT,
} from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  SPEED_COLS, sectorsPanelData, sectorsLegend, SECTOR_BAR_COLOR,
} from '../../utils/views/sectorsPanel';
import Legend from '../ui/Legend';


function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

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
  const liveBodyRef = useRef(null);
  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, `sectors_${view}.png`);
  }, [view]);

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

  if (!hasData) {
    return (
      <div className="sectors-panel__empty">
        No sector data available. Load a session first.
      </div>
    );
  }

  return (
    <div ref={panelRef} className="sectors-panel-wrapper">
      {/* ── Toggle ── */}
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

      {/* ── Colour legend of the tab shown (sectorsLegend): glyph + colour ── */}
      <div className="sectors-panel__legend">
        <Legend items={sectorsLegend(view)} shape="glyph" />
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
          {/* Driver rows */}
          <div ref={liveBodyRef} className="sectors-panel__live-body">
            {liveRows.map((row) => {
              const color = getDriverColor(row.driver);
              const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(row.driver);
              const isHl = highlightedDriver === row.driver;
              const isDimmed = highlightedDriver && !isHl;
              return (
                <div key={row.driver} className={`sectors-panel__live-row${!isSelected || isDimmed ? ' sectors-panel__row--context' : ''}`}
                  onMouseEnter={() => setHighlightedDriver(row.driver)}
                  onMouseLeave={() => setHighlightedDriver(null)}
                  onClick={() => setFocusDriver(row.driver)}
                  style={{
                    background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  <span className="sectors-panel__live-pos">{row.pos}</span>
                  <span className="sectors-panel__team-bar" style={{ backgroundColor: markColor(color) }} />
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

      {/* ── Best Sector Times (accumulated rankings) ── */}
      {view === 'best' && (
        <div className="sectors-panel__columns">
          {['1', '2', '3'].map((s) => {
            const items = bestRankings[s] || [];
            const best = bestSessionBests[s];
            const worst = items.length > 0 ? items[items.length - 1].best : best;
            const range = worst - (best || 0);
            return (
              <div key={s} className="sectors-panel__column">
                <div className="sectors-panel__col-header">
                  <span className="sectors-panel__col-title">SECTOR {s} <span style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.label, fontWeight: 400 }}>Lap {currentLap}</span></span>
                  {best && (
                    <span className="sectors-panel__col-best">{formatTime(best)}</span>
                  )}
                </div>
                <div className="sectors-panel__col-body">
                  {items.map((entry) => {
                    const color = getDriverColor(entry.driver);
                    const isBest = entry.is_session_best;
                    const gap = entry.best - (best || 0);
                    const barPct = range > 0 ? Math.max(0, 1 - gap / range) * 100 : 100;
                    const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(entry.driver);
                    const isHl = highlightedDriver === entry.driver;
                    const isDimmed = highlightedDriver && !isHl;
                    // Focus + context: a context row (not selected, or another
                    // row hovered) fades its marks only; its text turns to the
                    // muted colour, never faded (>= 4.5:1; r2: row opacity 0.3
                    // put the text at 1.77-2.69:1)
                    const isContext = !isSelected || !!isDimmed;
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isBest ? ' sectors-panel__row--best' : ''}${isContext ? ' sectors-panel__row--context' : ''}`}
                        onMouseEnter={() => setHighlightedDriver(entry.driver)}
                        onMouseLeave={() => setHighlightedDriver(null)}
                        onClick={() => setFocusDriver(entry.driver)}
                        style={{
                          background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
                          cursor: 'pointer',
                          transition: 'background 0.15s',
                        }}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: markColor(color) }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span className="sectors-panel__bar-cell">
                          <span
                            className="sectors-panel__bar-fill"
                            style={{
                              width: `${barPct}%`,
                              // the best in the overall-best colour, every other bar neutral
                              background: isBest ? STATUS_COLORS.overallBest : SECTOR_BAR_COLOR,
                            }}
                          />
                        </span>
                        <span
                          className="sectors-panel__time"
                          style={{ color: isContext ? TEXT_COLORS.muted : isBest ? STATUS_COLORS.overallBest : TEXT_COLORS.primary }}
                        >
                          {isBest && <span className="timing-glyph">{STATUS_GLYPHS.overallBest} </span>}
                          {formatTime(entry.best)}
                        </span>
                        {entry.rank > 1 && items[0] && (
                          <span className="sectors-panel__gap">
                            +{(entry.best - items[0].best).toFixed(3)}
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

      {/* ── Top Speeds View ── */}
      {view === 'speeds' && (
        <div className="sectors-panel__columns">
          {SPEED_COLS.map(({ key, label }) => {
            const items = speedRankings[key] || [];
            const fastest = items[0]?.speed || 0;
            return (
              <div key={key} className="sectors-panel__column sectors-panel__column--speed">
                <div className="sectors-panel__col-header">
                  <span className="sectors-panel__col-title">{label} <span style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.label, fontWeight: 400 }}>Lap {currentLap}</span></span>
                  {fastest > 0 && (
                    <span className="sectors-panel__col-best sectors-panel__col-best--purple">
                      {toDisplaySpeed(fastest)} {speedLabel}
                    </span>
                  )}
                </div>
                <div className="sectors-panel__col-body">
                  {items.map((entry) => {
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
                        style={{
                          background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
                          cursor: 'pointer',
                          transition: 'background 0.15s',
                        }}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: markColor(color) }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span
                          className="sectors-panel__speed-val"
                          style={{ color: isFastest ? STATUS_COLORS.overallBest : TEXT_COLORS.primary }}
                        >
                          {isFastest && <span className="timing-glyph">{STATUS_GLYPHS.overallBest} </span>}
                          {toDisplaySpeed(entry.speed)}
                        </span>
                        <span className="sectors-panel__speed-unit">{speedLabel}</span>
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
    </div>
  );
}
