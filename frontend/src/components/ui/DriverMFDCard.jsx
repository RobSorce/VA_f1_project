import React, { useMemo, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, getDriverDash, markColor, textColor, withAlpha, tyreColor, tyreLetter, contrastText,
  STATUS_COLORS, STATUS_GLYPHS, TEXT_COLORS, CHART_FONT, UNKNOWN_TEAM_COLOR,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { completedLaps, isLapCompleted, activeSegmentWindow } from '../../utils/raceTime';
import { qualifyingOrder } from '../../utils/driverState';
import { mfdTyreInfo } from '../../utils/views/driverMFDCard';

const PAGES = ['TYRE', 'PACE', 'POS', 'FEATURES'];

export default function DriverMFDCard() {
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const highlightedDriverPosition = useF1Store((s) => s.highlightedDriverPosition);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const sessionData = useF1Store((s) => s.sessionData);
  const drivers = useF1Store((s) => s.drivers);
  const pcaEmbeddings = useF1Store((s) => s.pcaEmbeddings);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const isLiveMode = useF1Store((s) => s.isLiveMode);

  const [page, setPage] = useState(0);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  // The active qualifying segment's laps only (its window's start)
  const segmentStart = useF1Store((s) => activeSegmentWindow(s)?.start);

  const driverInfo = useMemo(() => {
    if (!highlightedDriver || !drivers?.length) return null;
    return drivers.find((d) => d.Abbreviation === highlightedDriver);
  }, [highlightedDriver, drivers]);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);

  // Causal "now" in session seconds (utils/raceTime.js). Race history uses the
  // laps completed at that time; the count changes once per finished lap, so
  // the memos below are not rebuilt on every replay tick.
  const sessionNow = useSessionNow();
  const completedCount = useMemo(() => {
    let n = 0;
    for (const d of lapTimes) if (isLapCompleted(d, sessionNow)) n++;
    return n;
  }, [lapTimes, sessionNow]);
  const doneLaps = useMemo(
    () => completedLaps(lapTimes, sessionNow),
    // sessionNow enters through completedCount, which changes whenever the result does
    [lapTimes, completedCount],
  );

  // Driver lap data: laps completed at sessionNow (qualifying replay too: its
  // clock is the active segment's session time, never a lap still to come)
  const driverLaps = useMemo(() => {
    if (!highlightedDriver) return [];
    return doneLaps
      .filter((d) => d.Driver === highlightedDriver && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber);
  }, [highlightedDriver, doneLaps]);

  // Current tyre: race replay / lap mode = the set in force from the lap data
  // (new set from the pit exit; the frames switch at the out-lap start, in the
  // pit lane); live and qualifying replay = frame data
  const lapTyreInfo = useMemo(
    () => (isLiveMode || isQualifyingReplay ? null : mfdTyreInfo(lapTimes, highlightedDriver, sessionNow)),
    [lapTimes, highlightedDriver, sessionNow, isLiveMode, isQualifyingReplay],
  );
  const frameTyreInfo = useMemo(() => {
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
  const tyreInfo = lapTyreInfo || frameTyreInfo;

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
    doneLaps.forEach((d) => {
      for (const [key, prop] of [['s1', 'Sector1TimeSeconds'], ['s2', 'Sector2TimeSeconds'], ['s3', 'Sector3TimeSeconds']]) {
        const v = d[prop];
        if (v > 0 && v < 120) {
          if (v < session[key]) session[key] = v;
          if (d.Driver === highlightedDriver && v < personal[key]) personal[key] = v;
        }
      }
    });
    return { session, personal };
  }, [doneLaps, highlightedDriver]);

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

  // Position history for sparkline — qualifying: the rank by best lap
  // completed so far (never the final result), race: the completed laps
  const posHistory = useMemo(() => {
    if (!highlightedDriver) return [];
    if (isQualifyingReplay) {
      const me = qualifyingOrder(doneLaps, Infinity, { after: segmentStart }).find((r) => r.driver === highlightedDriver);
      return me?.position ? [{ lap: 1, pos: me.position }] : [];
    }
    // Position at the end of each completed lap
    const posData = doneLaps
      .filter((d) => d.Driver === highlightedDriver && d.Position)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .map((d) => ({ lap: d.LapNumber, pos: d.Position }));
    return posData;
  }, [highlightedDriver, doneLaps, isQualifyingReplay, segmentStart]);

  const color = highlightedDriver ? getDriverColor(highlightedDriver) : UNKNOWN_TEAM_COLOR;
  // line / dot >= 3:1, teammate dashed (V3); name text >= 4.5:1
  const mark = markColor(color);
  const dash = highlightedDriver ? getDriverDash(highlightedDriver) : null;

  // SVG sparkline for position — must be before early return to keep hooks order stable
  const sparklineSvg = useMemo(() => {
    if (posHistory.length < 2) return null;
    const w = 220, h = 40;
    const xScale = d3.scaleLinear().domain(d3.extent(posHistory, (d) => d.lap)).range([4, w - 4]);
    const yScale = d3.scaleLinear().domain([d3.max(posHistory, (d) => d.pos) + 1, 1]).range([h - 4, 4]);
    const lineGen = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.pos)).curve(d3.curveMonotoneX);
    return (
      <svg width={w} height={h} style={{ display: 'block' }}>
        <path d={lineGen(posHistory)} fill="none" stroke={mark} strokeWidth={1.5} strokeDasharray={dash || undefined} />
        {posHistory.length > 0 && (
          <circle cx={xScale(posHistory[posHistory.length - 1].lap)} cy={yScale(posHistory[posHistory.length - 1].pos)} r={3} fill={mark} />
        )}
      </svg>
    );
  }, [posHistory, mark, dash]);

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
        border: `1.5px solid ${withAlpha(color, 0.27)}`,
        borderRadius: 10,
        boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 12px ${withAlpha(color, 0.13)}`,
        overflow: 'hidden',
        fontFamily: 'var(--font-primary)',
        fontSize: CHART_FONT.data,
        color: TEXT_COLORS.primary,
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: `1px solid ${withAlpha(color, 0.2)}`,
        background: `linear-gradient(135deg, ${withAlpha(color, 0.09)}, transparent)`,
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: '12px', color: textColor(color), letterSpacing: '0.06em' }}>
            {highlightedDriver}
          </div>
          <div style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, textTransform: 'uppercase' }}>
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
                fontSize: CHART_FONT.label,
                fontWeight: 700,
                borderRadius: 3,
                cursor: 'pointer',
                background: i === page ? withAlpha(color, 0.19) : 'rgba(255,255,255,0.06)',
                color: i === page ? TEXT_COLORS.primary : TEXT_COLORS.muted,
                border: `1px solid ${i === page ? mark : 'transparent'}`,
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
                    background: tyreColor(tyreInfo.compound),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: CHART_FONT.data, fontWeight: 900,
                    color: contrastText(tyreColor(tyreInfo.compound)),
                  }}>
                    {tyreLetter(tyreInfo.compound)}
                  </span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{tyreInfo.compound}</div>
                    <div style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.muted }}>
                      {tyreInfo.tyreLife != null ? `${tyreInfo.tyreLife} laps old` : 'Unknown age'}
                    </div>
                  </div>
                </div>
                {driverLaps.length > 0 && (
                  <div style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary }}>
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
                      // timing colour + glyph (◆ session best, ● personal best)
                      const status = isSB ? 'overallBest' : isPB ? 'personalBest' : null;
                      return (
                        <div key={label} style={{
                          flex: 1, textAlign: 'center', padding: '3px 2px',
                          borderRadius: 4,
                          background: status ? withAlpha(STATUS_COLORS[status], 0.14) : 'rgba(255,255,255,0.04)',
                        }}>
                          <div style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, marginBottom: 1 }}>{label}</div>
                          <div style={{
                            fontSize: CHART_FONT.data, fontWeight: 600, fontFamily: 'var(--font-mono)',
                            color: status ? STATUS_COLORS[status] : TEXT_COLORS.primary,
                          }}>
                            {status && val > 0 ? `${STATUS_GLYPHS[status]} ` : ''}
                            {val > 0 ? val.toFixed(3) : '—'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: TEXT_COLORS.muted }}>No tyre data</div>
            )}
          </div>
        )}

        {page === 1 && paceStats && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row label="Average" value={fmtTime(paceStats.avg)} />
            <Row label="Best" value={fmtTime(paceStats.best)} />
            <Row label="Consistency" value={`\u00B1${paceStats.consistency.toFixed(3)}s`} />
            <Row label="Laps" value={String(driverLaps.length)} />
          </div>
        )}

        {page === 2 && (
          <div>
            {posHistory.length > 0 ? (
              <>
                <div style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, marginBottom: 4 }}>
                  Position by lap (P{posHistory[posHistory.length - 1]?.pos} current)
                </div>
                {sparklineSvg}
              </>
            ) : (
              <div style={{ color: TEXT_COLORS.muted }}>No position data</div>
            )}
          </div>
        )}

        {page === 3 && (
          <div style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted }}>
            {pcaEmbeddings?.points ? (
              (() => {
                const point = pcaEmbeddings.points.find((p) => p.driver === highlightedDriver);
                if (!point) return <span>No feature data for this driver</span>;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ color: TEXT_COLORS.secondary }}>PCA Embedding</span>
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
      <span style={{ color: TEXT_COLORS.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: CHART_FONT.label }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: CHART_FONT.data, color: valueColor || TEXT_COLORS.primary }}>{value}</span>
    </div>
  );
}
