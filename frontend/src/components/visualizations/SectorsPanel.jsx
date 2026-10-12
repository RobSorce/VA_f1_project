import React, { useMemo, useState, useRef, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';
import { useSessionNow } from '../../hooks/useSessionNow';
import { isLapCompleted, lapStartTime } from '../../utils/raceTime';
import { driverStateAt, nonFinisherMap } from '../../utils/driverState';


function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

const TIME_COLORS = {
  overall_best: '#A020F0',
  personal_best: '#00FF00',
  normal: 'var(--color-text-primary)',
};

const SPEED_COLS = [
  { key: 'SpeedI1', label: 'Sector 1' },
  { key: 'SpeedI2', label: 'Sector 2' },
  { key: 'SpeedFL', label: 'Finish Line' },
  { key: 'SpeedST', label: 'Speed Trap' },
];

function positiveTime(v) {
  return typeof v === 'number' && v > 0 && v < 300 ? v : null;
}

/**
 * Sector views at sessionNow (session seconds), causal (decision R6,
 * utils/driverState.js):
 *  - live rows: with replay frames each driver's lap in progress (only the
 *    sectors already run, chronometers), otherwise the last completed lap;
 *    retired drivers drop out once the retirement has happened; order as the
 *    timing tower (laps completed, then line crossing);
 *  - colours, best-sector rankings and top speeds from completed laps only.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @param {Object} [opts] - { dnfMap, replayActive }
 * @returns {{ liveRows: Array<Object>, bestRankings: Object, bestSessionBests: Object,
 *   speedRankings: Object }}
 */
export function sectorsPanelData(lapTimes, sessionNow, { dnfMap = {}, replayActive = false } = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];

  const sessionBests = { 1: Infinity, 2: Infinity, 3: Infinity };
  const personalBests = {};
  const driverSectors = {};
  const driverSpeeds = Object.fromEntries(SPEED_COLS.map(({ key }) => [key, {}]));
  const byDriver = new Map();
  for (const lt of rows) {
    const drv = lt?.Driver;
    if (!drv) continue;
    if (!byDriver.has(drv)) byDriver.set(drv, []);
    byDriver.get(drv).push(lt);
    if (!isLapCompleted(lt, now)) continue;
    if (!personalBests[drv]) personalBests[drv] = { 1: Infinity, 2: Infinity, 3: Infinity };
    if (!driverSectors[drv]) driverSectors[drv] = { 1: [], 2: [], 3: [] };
    for (const s of [1, 2, 3]) {
      const val = positiveTime(lt[`Sector${s}TimeSeconds`]);
      if (val == null) continue;
      if (val < sessionBests[s]) sessionBests[s] = val;
      if (val < personalBests[drv][s]) personalBests[drv][s] = val;
      driverSectors[drv][s].push(val);
    }
    for (const { key } of SPEED_COLS) {
      const val = lt[key];
      if (val == null || typeof val !== 'number' || isNaN(val) || val <= 0) continue;
      const cur = driverSpeeds[key][drv];
      if (!cur || val > cur.speed) driverSpeeds[key][drv] = { speed: val, lap: lt.LapNumber };
    }
  }

  // Live view: one row per running driver (results DNFs and classified
  // drivers who stopped before the flag leave it once retired)
  const nonFinishers = nonFinisherMap(rows, dnfMap);
  const live = [];
  for (const [drv, driverRows] of byDriver) {
    const st = driverStateAt(driverRows, drv, now, { dnf: !!nonFinishers[drv] });
    if (st.retired) continue;
    const d = replayActive ? (st.inProgress || st.lastCompleted) : (st.lastCompleted || st.inProgress);
    if (!d) continue;
    const isLive = d === st.inProgress;
    const pb = personalBests[drv] || { 1: Infinity, 2: Infinity, 3: Infinity };
    const sectors = [1, 2, 3].map((s) => {
      const val = isLive ? st.visibleSectors[`s${s}`] : positiveTime(d[`Sector${s}TimeSeconds`]);
      const show = val != null;
      let color = TIME_COLORS.normal;
      if (show) {
        const tolerance = 0.001;
        if (val <= sessionBests[s] + tolerance) color = TIME_COLORS.overall_best;
        else if (val <= pb[s] + tolerance) color = TIME_COLORS.personal_best;
      }
      return { val, show: isLive ? show : true, color };
    });

    // Live chronometer for the sector being run (replay only)
    let chrono = null;
    let runningLap = null;
    const start = isLive ? lapStartTime(d) : null;
    if (replayActive && isLive && start != null) {
      runningLap = Math.max(0, now - start);
      if (!sectors[0].show) chrono = { sector: 1, elapsed: runningLap };
      else if (!sectors[1].show && d.Sector1SessionTime > 0) chrono = { sector: 2, elapsed: Math.max(0, now - d.Sector1SessionTime) };
      else if (!sectors[2].show && d.Sector2SessionTime > 0) chrono = { sector: 3, elapsed: Math.max(0, now - d.Sector2SessionTime) };
    }

    const done = st.lastCompleted;
    live.push({
      driver: drv,
      pos: 99,
      lap: d.LapNumber,
      sectors,
      chrono,
      runningLap,
      lapTime: isLive ? null : d.LapTimeSeconds,
      _laps: st.lapsCompleted,
      _crossed: done && Number.isFinite(done.Time) ? done.Time : Infinity,
      _position: done && Number.isFinite(done.Position) ? done.Position : Infinity,
    });
  }
  live.sort((a, b) => (b._laps - a._laps) || (a._crossed - b._crossed)
    || (a._position - b._position) || a.driver.localeCompare(b.driver));
  const liveRows = live.map(({ _laps, _crossed, _position, ...r }, i) => ({ ...r, pos: i + 1 }));

  // Best-of-session rankings (completed laps)
  const bestSessionBests = {};
  const bestRankings = {};
  if (Object.keys(driverSectors).length > 0) {
    for (const s of [1, 2, 3]) {
      const allTimes = [];
      for (const [drv, secs] of Object.entries(driverSectors)) {
        if (secs[s].length > 0) {
          const bestTime = Math.min(...secs[s]);
          allTimes.push({ driver: drv, best: Math.round(bestTime * 1000) / 1000 });
        }
      }
      allTimes.sort((a, b) => a.best - b.best);
      const sessionBest = allTimes.length > 0 ? allTimes[0].best : null;
      bestSessionBests[String(s)] = sessionBest;
      allTimes.forEach((entry, i) => {
        entry.rank = i + 1;
        entry.is_session_best = entry.best === sessionBest;
      });
      bestRankings[String(s)] = allTimes;
    }
  }

  // Speed rankings (speed traps of completed laps)
  const speedRankings = {};
  if (rows.length > 0) {
    for (const { key } of SPEED_COLS) {
      speedRankings[key] = Object.entries(driverSpeeds[key])
        .sort(([, a], [, b]) => b.speed - a.speed)
        .map(([driver, { speed, lap }], i) => ({
          driver, speed: Math.round(speed * 10) / 10, lap, rank: i + 1,
        }));
    }
  }

  return { liveRows, bestRankings, bestSessionBests, speedRankings };
}

export default function SectorsPanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const dnfMap = useF1Store((s) => s.dnfMap);
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
    () => sectorsPanelData(lapTimes, sessionNow, { dnfMap, replayActive }),
    [lapTimes, sessionNow, dnfMap, replayActive],
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
            color: 'rgba(255,255,255,0.3)', cursor: 'pointer',
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

      {/* ── Color Legend ── */}
      <div className="sectors-panel__legend">
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: '#A020F0' }} />
          Session Best
        </span>
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: '#00FF00' }} />
          Personal Best
        </span>
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: '#FFD700' }} />
          Improving
        </span>
        <span className="sectors-panel__legend-item" style={{ opacity: 0.5 }}>
          <span className="sectors-panel__legend-dot" style={{ background: 'rgba(255,255,255,0.6)' }} />
          Standard
        </span>
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
                <div key={row.driver} className="sectors-panel__live-row"
                  onMouseEnter={() => setHighlightedDriver(row.driver)}
                  onMouseLeave={() => setHighlightedDriver(null)}
                  onClick={() => setFocusDriver(row.driver)}
                  style={{
                    opacity: !isSelected ? 0.3 : isDimmed ? 0.5 : 1,
                    background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
                    cursor: 'pointer',
                    transition: 'opacity 0.15s, background 0.15s',
                  }}
                >
                  <span className="sectors-panel__live-pos">{row.pos}</span>
                  <span className="sectors-panel__team-bar" style={{ backgroundColor: color }} />
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
                              ? { color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }
                              : undefined
                        }
                      >
                        {s.show ? formatTime(s.val) : isChrono ? row.chrono.elapsed.toFixed(1) : '—'}
                      </span>
                    );
                  })}
                  <span
                    className="sectors-panel__live-sec sectors-panel__live-sec--lap"
                    style={!row.lapTime && row.runningLap != null
                      ? { color: '#fbbf24', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }
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
                  <span className="sectors-panel__col-title">SECTOR {s} <span style={{ opacity: 0.5, fontSize: '0.8em', fontWeight: 400 }}>Lap {currentLap}</span></span>
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
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isBest ? ' sectors-panel__row--best' : ''}`}
                        onMouseEnter={() => setHighlightedDriver(entry.driver)}
                        onMouseLeave={() => setHighlightedDriver(null)}
                        onClick={() => setFocusDriver(entry.driver)}
                        style={{
                          opacity: !isSelected ? 0.3 : isDimmed ? 0.5 : 1,
                          background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
                          cursor: 'pointer',
                          transition: 'opacity 0.15s, background 0.15s',
                        }}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: color }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span className="sectors-panel__bar-cell">
                          <span
                            className="sectors-panel__bar-fill"
                            style={{
                              width: `${barPct}%`,
                              background: isBest
                                ? 'var(--sector-purple)'
                                : entry.rank <= 3
                                  ? 'var(--sector-green)'
                                  : 'rgba(255, 210, 0, 0.5)',
                            }}
                          />
                        </span>
                        <span
                          className="sectors-panel__time"
                          style={{ color: isBest ? 'var(--sector-purple)' : 'var(--color-text-primary)' }}
                        >
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
                  <span className="sectors-panel__col-title">{label} <span style={{ opacity: 0.5, fontSize: '0.8em', fontWeight: 400 }}>Lap {currentLap}</span></span>
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
                        className={`sectors-panel__row${isFastest ? ' sectors-panel__row--best' : ''}`}
                        onMouseEnter={() => setHighlightedDriver(entry.driver)}
                        onMouseLeave={() => setHighlightedDriver(null)}
                        onClick={() => setFocusDriver(entry.driver)}
                        style={{
                          opacity: !isSelected ? 0.3 : isDimmed ? 0.5 : 1,
                          background: isHl ? 'rgba(255,255,255,0.06)' : undefined,
                          cursor: 'pointer',
                          transition: 'opacity 0.15s, background 0.15s',
                        }}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: color }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span
                          className="sectors-panel__speed-val"
                          style={{ color: isFastest ? 'var(--sector-purple)' : 'var(--color-text-primary)' }}
                        >
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
