import React, { useMemo, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';

const PAGES = ['TYRE', 'PACE', 'POS', 'FEATURES'];

export default function DriverMFDCard() {
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const highlightedDriverPosition = useF1Store((s) => s.highlightedDriverPosition);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const drivers = useF1Store((s) => s.drivers);
  const pcaEmbeddings = useF1Store((s) => s.pcaEmbeddings);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);

  const [page, setPage] = useState(0);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);

  const driverInfo = useMemo(() => {
    if (!highlightedDriver || !drivers?.length) return null;
    return drivers.find((d) => d.Abbreviation === highlightedDriver);
  }, [highlightedDriver, drivers]);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);

  // Driver lap data — for qualifying, show all laps (not filtered by currentLap)
  const driverLaps = useMemo(() => {
    if (!highlightedDriver) return [];
    if (isQualifyingReplay) {
      return lapTimes
        .filter((d) => d.Driver === highlightedDriver && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
        .sort((a, b) => a.LapNumber - b.LapNumber);
    }
    return lapTimes
      .filter((d) => d.Driver === highlightedDriver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber);
  }, [highlightedDriver, lapTimes, currentLap, isQualifyingReplay]);

  // Current tyre info from frame data
  const tyreInfo = useMemo(() => {
    if (!highlightedDriver || !frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const frame = frameData.frames[idx];
    if (!frame?.drivers?.[highlightedDriver]) return null;
    const d = frame.drivers[highlightedDriver];
    const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
    return {
      compound: COMPOUND_NAMES[d.tyre] || 'UNKNOWN',
      tyreLife: d.tyre_life != null ? Math.round(d.tyre_life) : null,
    };
  }, [highlightedDriver, frameData, currentFrameIndex]);

  // Pace stats
  const paceStats = useMemo(() => {
    if (driverLaps.length === 0) return null;
    const times = driverLaps.map((d) => d.LapTimeSeconds).filter((t) => t > 0 && t < 300);
    if (times.length === 0) return null;
    const avg = d3.mean(times);
    const best = d3.min(times);
    const std = d3.deviation(times) || 0;
    return { avg, best, consistency: std };
  }, [driverLaps]);

  // Session-wide and driver-personal best sector times
  const sectorBests = useMemo(() => {
    const session = { s1: Infinity, s2: Infinity, s3: Infinity };
    const personal = { s1: Infinity, s2: Infinity, s3: Infinity };
    lapTimes.forEach((d) => {
      if (d.LapNumber > currentLap) return;
      for (const [key, prop] of [['s1', 'Sector1TimeSeconds'], ['s2', 'Sector2TimeSeconds'], ['s3', 'Sector3TimeSeconds']]) {
        const v = d[prop];
        if (v > 0 && v < 120) {
          if (v < session[key]) session[key] = v;
          if (d.Driver === highlightedDriver && v < personal[key]) personal[key] = v;
        }
      }
    });
    return { session, personal };
  }, [lapTimes, currentLap, highlightedDriver]);

  // Current lap sector times for the highlighted driver
  const currentSectors = useMemo(() => {
    if (!highlightedDriver || driverLaps.length === 0) return null;
    const lastLap = driverLaps[driverLaps.length - 1];
    const s1 = lastLap.Sector1TimeSeconds;
    const s2 = lastLap.Sector2TimeSeconds;
    const s3 = lastLap.Sector3TimeSeconds;
    if (!s1 && !s2 && !s3) return null;
    return { s1, s2, s3, lapNum: lastLap.LapNumber };
  }, [highlightedDriver, driverLaps]);

  // Position history for sparkline — qualifying shows all positions, race filters by currentLap
  const posHistory = useMemo(() => {
    if (!highlightedDriver) return [];
    if (isQualifyingReplay) {
      // For qualifying, show the final qualifying position as a single point
      const result = (sessionData?.race_results || []).find(
        (r) => (r.Abbreviation || r.Driver) === highlightedDriver
      );
      return result?.Position ? [{ lap: 1, pos: result.Position }] : [];
    }
    const posData = lapTimes
      .filter((d) => d.Driver === highlightedDriver && d.LapNumber <= currentLap && d.Position)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .map((d) => ({ lap: d.LapNumber, pos: d.Position }));
    return posData;
  }, [highlightedDriver, lapTimes, currentLap, isQualifyingReplay, sessionData]);

  const color = highlightedDriver ? getDriverColor(highlightedDriver) : '#888';

  // SVG sparkline for position — must be before early return to keep hooks order stable
  const sparklineSvg = useMemo(() => {
    if (posHistory.length < 2) return null;
    const w = 220, h = 40;
    const xScale = d3.scaleLinear().domain(d3.extent(posHistory, (d) => d.lap)).range([4, w - 4]);
    const yScale = d3.scaleLinear().domain([d3.max(posHistory, (d) => d.pos) + 1, 1]).range([h - 4, 4]);
    const lineGen = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.pos)).curve(d3.curveMonotoneX);
    return (
      <svg width={w} height={h} style={{ display: 'block' }}>
        <path d={lineGen(posHistory)} fill="none" stroke={color} strokeWidth={1.5} />
        {posHistory.length > 0 && (
          <circle cx={xScale(posHistory[posHistory.length - 1].lap)} cy={yScale(posHistory[posHistory.length - 1].pos)} r={3} fill={color} />
        )}
      </svg>
    );
  }, [posHistory, color]);

  const handleCardEnter = useCallback(() => {
    // Cancel the leaderboard's delayed clear so the card stays visible
    clearTimeout(window.__f1HighlightTimer);
  }, []);

  const handleCardLeave = useCallback(() => {
    setHighlightedDriver(null);
  }, [setHighlightedDriver]);

  if (!highlightedDriver || !highlightedDriverPosition) return null;

  const teamName = driverInfo?.TeamName || '';

  // Position the card: to the right of the cursor, biased strongly upward
  // so it doesn't cover the timeline player at the bottom
  const cardW = 260;
  const cardH = 180;
  let left = highlightedDriverPosition.x + 16;
  // Place card above the cursor position (top-aligned to cursor)
  let top = highlightedDriverPosition.y - cardH + 20;

  // Flip horizontally if going off-screen
  if (left + cardW > window.innerWidth) left = highlightedDriverPosition.x - cardW - 16;

  // Clamp: never go below 50% of the viewport, never above 8px
  const maxTop = Math.floor(window.innerHeight * 0.5) - cardH;
  if (top > maxTop) top = maxTop;
  if (top < 8) top = 8;

  const fmtTime = (s) => {
    if (!s) return '--';
    const min = Math.floor(s / 60);
    const sec = (s % 60).toFixed(3);
    return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
  };

  return (
    <div
      className="mfd-card"
      onMouseEnter={handleCardEnter}
      onMouseLeave={handleCardLeave}
      style={{
        position: 'fixed',
        left,
        top,
        width: cardW,
        zIndex: 600,
        pointerEvents: 'auto',
        background: 'rgba(10, 10, 25, 0.88)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: `1.5px solid ${color}44`,
        borderRadius: 10,
        boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 12px ${color}22`,
        overflow: 'hidden',
        fontFamily: 'var(--font-primary)',
        fontSize: '10px',
        color: 'rgba(255,255,255,0.85)',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: `1px solid ${color}33`,
        background: `linear-gradient(135deg, ${color}18, transparent)`,
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: '12px', color, letterSpacing: '0.06em' }}>
            {highlightedDriver}
          </div>
          <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>
            {teamName}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {PAGES.map((p, i) => (
            <span
              key={p}
              onClick={() => setPage(i)}
              style={{
                padding: '1px 5px',
                fontSize: '7px',
                fontWeight: 700,
                borderRadius: 3,
                cursor: 'pointer',
                background: i === page ? `${color}30` : 'rgba(255,255,255,0.06)',
                color: i === page ? color : 'rgba(255,255,255,0.4)',
                border: `1px solid ${i === page ? `${color}55` : 'transparent'}`,
                letterSpacing: '0.04em',
              }}
            >
              {p}
            </span>
          ))}
        </div>
      </div>

      {/* Page content */}
      <div style={{ padding: '8px 10px', minHeight: 100 }}>
        {page === 0 && (
          <div>
            {tyreInfo ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: TYRE_COLORS[tyreInfo.compound] || '#888',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', fontWeight: 900,
                    color: tyreInfo.compound === 'HARD' || tyreInfo.compound === 'MEDIUM' ? '#000' : '#fff',
                  }}>
                    {tyreInfo.compound[0]}
                  </span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{tyreInfo.compound}</div>
                    <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)' }}>
                      {tyreInfo.tyreLife != null ? `${tyreInfo.tyreLife} laps old` : 'Unknown age'}
                    </div>
                  </div>
                </div>
                {driverLaps.length > 0 && (
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)' }}>
                    Last lap: {fmtTime(driverLaps[driverLaps.length - 1]?.LapTimeSeconds)}
                  </div>
                )}
                {currentSectors && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    {[
                      { label: 'S1', val: currentSectors.s1, sb: sectorBests.session.s1, pb: sectorBests.personal.s1 },
                      { label: 'S2', val: currentSectors.s2, sb: sectorBests.session.s2, pb: sectorBests.personal.s2 },
                      { label: 'S3', val: currentSectors.s3, sb: sectorBests.session.s3, pb: sectorBests.personal.s3 },
                    ].map(({ label, val, sb, pb }) => {
                      const isSB = val > 0 && val <= sb + 0.001;
                      const isPB = val > 0 && val <= pb + 0.001;
                      return (
                        <div key={label} style={{
                          flex: 1, textAlign: 'center', padding: '3px 2px',
                          borderRadius: 4,
                          background: isSB ? 'rgba(160,32,240,0.2)' : isPB ? 'rgba(0,255,0,0.12)' : 'rgba(255,255,255,0.04)',
                        }}>
                          <div style={{ fontSize: '7px', color: 'rgba(255,255,255,0.35)', marginBottom: 1 }}>{label}</div>
                          <div style={{
                            fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-mono)',
                            color: isSB ? '#A855F7' : isPB ? '#22C55E' : 'rgba(255,255,255,0.8)',
                          }}>
                            {val > 0 ? val.toFixed(3) : '—'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: 'rgba(255,255,255,0.3)' }}>No tyre data</div>
            )}
          </div>
        )}

        {page === 1 && paceStats && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row label="Average" value={fmtTime(paceStats.avg)} />
            <Row label="Best" value={fmtTime(paceStats.best)} valueColor="#a855f7" />
            <Row label="Consistency" value={`\u00B1${paceStats.consistency.toFixed(3)}s`} />
            <Row label="Laps" value={String(driverLaps.length)} />
          </div>
        )}

        {page === 2 && (
          <div>
            {posHistory.length > 0 ? (
              <>
                <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                  Position by lap (P{posHistory[posHistory.length - 1]?.pos} current)
                </div>
                {sparklineSvg}
              </>
            ) : (
              <div style={{ color: 'rgba(255,255,255,0.3)' }}>No position data</div>
            )}
          </div>
        )}

        {page === 3 && (
          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)' }}>
            {pcaEmbeddings?.points ? (
              (() => {
                const point = pcaEmbeddings.points.find((p) => p.driver === highlightedDriver);
                if (!point) return <span>No feature data for this driver</span>;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>PCA Embedding</span>
                    <Row label="x" value={point.x.toFixed(2)} />
                    <Row label="y" value={point.y.toFixed(2)} />
                    <Row label="Team" value={point.team} />
                    <Row label="Season" value={`${point.year} R${point.round}`} />
                  </div>
                );
              })()
            ) : (
              <span>Load PCA embeddings to see features</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '9px' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '10px', color: valueColor || 'rgba(255,255,255,0.85)' }}>{value}</span>
    </div>
  );
}
