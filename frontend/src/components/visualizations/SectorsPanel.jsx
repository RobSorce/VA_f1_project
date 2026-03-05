import React, { useMemo, useState, useRef, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

const TIME_COLORS = {
  overall_best: '#a855f7',
  personal_best: '#22c55e',
  normal: 'var(--color-text-primary)',
};

const SPEED_COLS = [
  { key: 'SpeedI1', label: 'Sector 1' },
  { key: 'SpeedI2', label: 'Sector 2' },
  { key: 'SpeedFL', label: 'Finish Line' },
  { key: 'SpeedST', label: 'Speed Trap' },
];

export default function SectorsPanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const currentTime = useF1Store((s) => s.currentTime);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const [view, setView] = useState('live');
  const panelRef = useRef(null);
  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, `sectors_${view}.png`);
  }, [view]);

  const toDisplaySpeed = (kmh) => speedUnit === 'mph' ? Math.round(kmh * 0.6214 * 10) / 10 : kmh;
  const speedLabel = speedUnit === 'mph' ? 'mph' : 'km/h';

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const replayActive = totalFrames > 0;

  // Session time offset: session times (~3500s) vs frame times (0-based)
  const sessionTimeOffset = useMemo(() => {
    for (const d of lapTimes) {
      if (d.LapStartTime > 0 && (d.Time > 0 || d.LapTimeSeconds > 0) && d.LapNumber >= 1) {
        return d.LapStartTime;
      }
    }
    return 0;
  }, [lapTimes]);
  const hasTimeOffset = sessionTimeOffset > 0;

  // Session-wide and personal bests (accumulated up to currentLap) for color coding
  const { sessionBests, personalBests } = useMemo(() => {
    const sb = { 1: Infinity, 2: Infinity, 3: Infinity };
    const pb = {};
    if (lapTimes.length === 0) return { sessionBests: sb, personalBests: pb };

    for (const lt of lapTimes) {
      if (replayActive && lt.LapNumber > currentLap) continue;
      if (replayActive && hasTimeOffset && lt.LapStartTime > 0 && currentTime < lt.LapStartTime - sessionTimeOffset) continue;
      const drv = lt.Driver;
      if (!drv) continue;
      if (!pb[drv]) pb[drv] = { 1: Infinity, 2: Infinity, 3: Infinity };
      for (const s of [1, 2, 3]) {
        // Only include sectors that have actually been completed in the timeline
        const sSessionT = lt[`Sector${s}SessionTime`];
        if (replayActive && sSessionT > 0 && currentTime < sSessionT - sessionTimeOffset) continue;
        const val = lt[`Sector${s}TimeSeconds`];
        if (val > 0 && val < 300) {
          if (val < sb[s]) sb[s] = val;
          if (val < pb[drv][s]) pb[drv][s] = val;
        }
      }
    }
    return { sessionBests: sb, personalBests: pb };
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, replayActive]);

  // Live view: current-lap sector times per driver with progressive reveal
  const liveRows = useMemo(() => {
    if (lapTimes.length === 0) return [];

    const driverLatest = {};
    for (const lt of lapTimes) {
      if (replayActive && lt.LapNumber > currentLap) continue;
      if (replayActive && hasTimeOffset && lt.LapStartTime > 0 && currentTime < lt.LapStartTime - sessionTimeOffset) continue;
      const drv = lt.Driver;
      if (!drv) continue;
      if (!driverLatest[drv] || lt.LapNumber > driverLatest[drv].LapNumber) {
        driverLatest[drv] = lt;
      }
    }

    return Object.values(driverLatest)
      .filter((d) => !(dnfMap[d.Driver] && dnfMap[d.Driver].lastLap <= currentLap))
      .sort((a, b) => (a.Position || 99) - (b.Position || 99))
      .map((d) => {
        const isCurrentLap = replayActive && d.LapNumber === currentLap;
        const pb = personalBests[d.Driver] || { 1: Infinity, 2: Infinity, 3: Infinity };

        const s1SessionT = d.Sector1SessionTime > 0 ? d.Sector1SessionTime - sessionTimeOffset : null;
        const s2SessionT = d.Sector2SessionTime > 0 ? d.Sector2SessionTime - sessionTimeOffset : null;
        const s3SessionT = d.Sector3SessionTime > 0 ? d.Sector3SessionTime - sessionTimeOffset : null;

        const showS1 = !isCurrentLap || (s1SessionT != null ? currentTime >= s1SessionT : d.Sector1TimeSeconds > 0);
        const showS2 = !isCurrentLap || (s2SessionT != null ? currentTime >= s2SessionT : d.Sector2TimeSeconds > 0);
        const showS3 = !isCurrentLap || (s3SessionT != null ? currentTime >= s3SessionT : d.Sector3TimeSeconds > 0);
        const showLapTime = !isCurrentLap || showS3;

        const sectors = [1, 2, 3].map((s) => {
          const show = s === 1 ? showS1 : s === 2 ? showS2 : showS3;
          const val = show ? d[`Sector${s}TimeSeconds`] : null;
          let color = TIME_COLORS.normal;
          if (val && val > 0) {
            const tolerance = 0.001;
            if (Math.abs(val - sessionBests[s]) < tolerance) color = TIME_COLORS.overall_best;
            else if (Math.abs(val - pb[s]) < tolerance) color = TIME_COLORS.personal_best;
          }
          return { val, show, color };
        });

        // Live chronometer for current sector
        let chrono = null;
        if (isCurrentLap && hasTimeOffset) {
          const lapStart = d.LapStartTime > 0 ? d.LapStartTime - sessionTimeOffset : null;
          if (!showS1 && lapStart != null) {
            chrono = { sector: 1, elapsed: Math.max(0, currentTime - lapStart) };
          } else if (showS1 && !showS2 && s1SessionT != null) {
            chrono = { sector: 2, elapsed: Math.max(0, currentTime - s1SessionT) };
          } else if (showS2 && !showS3 && s2SessionT != null) {
            chrono = { sector: 3, elapsed: Math.max(0, currentTime - s2SessionT) };
          }
        }

        return {
          driver: d.Driver,
          pos: d.Position || 99,
          lap: d.LapNumber,
          sectors,
          chrono,
          lapTime: showLapTime ? d.LapTimeSeconds : null,
        };
      });
  }, [lapTimes, currentLap, currentTime, replayActive, sessionTimeOffset, sessionBests, personalBests, dnfMap]);

  // Best-of-session rankings (accumulated)
  const { bestRankings, bestSessionBests } = useMemo(() => {
    if (lapTimes.length === 0) return { bestRankings: {}, bestSessionBests: {} };

    const driverSectors = {};
    for (const lt of lapTimes) {
      if (replayActive && lt.LapNumber > currentLap) continue;
      if (replayActive && hasTimeOffset && lt.LapStartTime > 0 && currentTime < lt.LapStartTime - sessionTimeOffset) continue;
      const drv = lt.Driver;
      if (!drv) continue;
      // Skip retired drivers' laps past their retirement
      const dnf = dnfMap[drv];
      if (dnf && lt.LapNumber > dnf.lastLap) continue;
      if (!driverSectors[drv]) driverSectors[drv] = { 1: [], 2: [], 3: [] };
      for (const s of [1, 2, 3]) {
        // Only include sectors actually completed in the timeline
        const sSessionT = lt[`Sector${s}SessionTime`];
        if (replayActive && sSessionT > 0 && currentTime < sSessionT - sessionTimeOffset) continue;
        const val = lt[`Sector${s}TimeSeconds`];
        if (val && typeof val === 'number' && val > 0 && val < 300) {
          driverSectors[drv][s].push(val);
        }
      }
    }

    const sBests = {};
    const sResult = {};
    for (const s of [1, 2, 3]) {
      const allTimes = [];
      for (const [drv, secs] of Object.entries(driverSectors)) {
        if (secs[s].length > 0) {
          const best = Math.min(...secs[s]);
          allTimes.push({ driver: drv, best: Math.round(best * 1000) / 1000 });
        }
      }
      allTimes.sort((a, b) => a.best - b.best);
      const sessionBest = allTimes.length > 0 ? allTimes[0].best : null;
      sBests[String(s)] = sessionBest;
      allTimes.forEach((entry, i) => {
        entry.rank = i + 1;
        entry.is_session_best = entry.best === sessionBest;
      });
      sResult[String(s)] = allTimes;
    }
    return { bestRankings: sResult, bestSessionBests: sBests };
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, replayActive, dnfMap]);

  // Speed rankings
  const speedRankings = useMemo(() => {
    if (lapTimes.length === 0) return {};
    const result = {};
    for (const { key } of SPEED_COLS) {
      const driverSpeeds = {};
      for (const lt of lapTimes) {
        if (replayActive && lt.LapNumber > currentLap) continue;
        // Skip laps the driver hasn't actually started yet
        if (replayActive && hasTimeOffset && lt.LapStartTime > 0 && currentTime < lt.LapStartTime - sessionTimeOffset) continue;
        // Speed traps are recorded at sector boundaries — only include if lap is complete
        const lapEndT = (replayActive && hasTimeOffset && lt.Time > 0) ? lt.Time - sessionTimeOffset : null;
        if (lapEndT != null && currentTime < lapEndT) continue;
        const drv = lt.Driver;
        const val = lt[key];
        if (!drv || val == null || typeof val !== 'number' || isNaN(val) || val <= 0) continue;
        // Skip retired drivers' laps past their retirement
        const dnf = dnfMap[drv];
        if (dnf && lt.LapNumber > dnf.lastLap) continue;
        if (!driverSpeeds[drv] || val > driverSpeeds[drv].speed) {
          driverSpeeds[drv] = { speed: val, lap: lt.LapNumber };
        }
      }
      const ranked = Object.entries(driverSpeeds)
        .sort(([, a], [, b]) => b.speed - a.speed)
        .map(([driver, { speed, lap }], i) => ({
          driver, speed: Math.round(speed * 10) / 10, lap, rank: i + 1,
        }));
      result[key] = ranked;
    }
    return result;
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, replayActive, dnfMap]);

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
          <span className="sectors-panel__legend-dot" style={{ background: '#a855f7' }} />
          Overall Best
        </span>
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: '#22c55e' }} />
          Personal Best
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
          <div className="sectors-panel__live-body">
            {liveRows.map((row) => {
              const color = getDriverColor(row.driver);
              return (
                <div key={row.driver} className="sectors-panel__live-row">
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
                  <span className="sectors-panel__live-sec sectors-panel__live-sec--lap">
                    {row.lapTime ? formatTime(row.lapTime) : '—'}
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
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isBest ? ' sectors-panel__row--best' : ''}`}
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
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isFastest ? ' sectors-panel__row--best' : ''}`}
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
