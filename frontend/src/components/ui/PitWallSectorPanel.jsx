import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';

function fmtLap(s) {
  if (!s || s <= 0 || !isFinite(s)) return '\u2014';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

function fmtSector(s) {
  if (!s || s <= 0 || !isFinite(s)) return '\u2014';
  return s.toFixed(3);
}

function fmtDelta(delta) {
  if (delta == null || !isFinite(delta)) return '';
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(3)}`;
}

function getSectorColor(time, personalBest, sessionBest) {
  if (!time || time <= 0 || !isFinite(time)) return 'rgba(255,255,255,0.85)';
  if (sessionBest && Math.abs(time - sessionBest) <= 0.010) return '#b146f5';
  if (personalBest && Math.abs(time - personalBest) <= 0.010) return '#22c55e';
  if (personalBest && time - personalBest <= 0.3) return '#facc15';
  if (personalBest && time - personalBest > 1.0) return '#ef4444';
  return 'rgba(255,255,255,0.85)';
}

function getLapColor(time, personalBest, sessionBest) {
  if (!time || time <= 0 || !isFinite(time)) return 'rgba(255,255,255,0.92)';
  if (sessionBest && Math.abs(time - sessionBest) <= 0.010) return '#b146f5';
  if (personalBest && Math.abs(time - personalBest) <= 0.010) return '#22c55e';
  if (personalBest && time - personalBest <= 0.5) return '#facc15';
  if (personalBest && time - personalBest > 2.0) return '#ef4444';
  return 'rgba(255,255,255,0.92)';
}

const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTER', 5: 'WET' };

export default function PitWallSectorPanel() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);

  const data = useMemo(() => {
    if (!focusDriver || !sessionData?.lap_times?.length) return null;

    const lapTimes = sessionData.lap_times;
    const driverLaps = lapTimes
      .filter((lt) => lt.Driver === focusDriver && lt.LapNumber <= currentLap)
      .sort((a, b) => a.LapNumber - b.LapNumber);

    if (driverLaps.length === 0) return null;

    // Compute personal bests
    let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity, bestLap = Infinity;
    for (const lt of driverLaps) {
      const s1 = lt.Sector1TimeSeconds;
      const s2 = lt.Sector2TimeSeconds;
      const s3 = lt.Sector3TimeSeconds;
      const lap = lt.LapTimeSeconds;
      if (s1 > 0 && isFinite(s1) && s1 < bestS1) bestS1 = s1;
      if (s2 > 0 && isFinite(s2) && s2 < bestS2) bestS2 = s2;
      if (s3 > 0 && isFinite(s3) && s3 < bestS3) bestS3 = s3;
      if (lap > 0 && isFinite(lap) && lap < 300 && lap < bestLap) bestLap = lap;
    }
    if (!isFinite(bestS1)) bestS1 = null;
    if (!isFinite(bestS2)) bestS2 = null;
    if (!isFinite(bestS3)) bestS3 = null;
    if (!isFinite(bestLap)) bestLap = null;

    // Compute session bests (all drivers)
    let sessBestS1 = Infinity, sessBestS2 = Infinity, sessBestS3 = Infinity, sessBestLap = Infinity;
    for (const lt of lapTimes) {
      if (lt.LapNumber > currentLap) continue;
      const s1 = lt.Sector1TimeSeconds;
      const s2 = lt.Sector2TimeSeconds;
      const s3 = lt.Sector3TimeSeconds;
      const lap = lt.LapTimeSeconds;
      if (s1 > 0 && isFinite(s1) && s1 < sessBestS1) sessBestS1 = s1;
      if (s2 > 0 && isFinite(s2) && s2 < sessBestS2) sessBestS2 = s2;
      if (s3 > 0 && isFinite(s3) && s3 < sessBestS3) sessBestS3 = s3;
      if (lap > 0 && isFinite(lap) && lap < 300 && lap < sessBestLap) sessBestLap = lap;
    }
    if (!isFinite(sessBestS1)) sessBestS1 = null;
    if (!isFinite(sessBestS2)) sessBestS2 = null;
    if (!isFinite(sessBestS3)) sessBestS3 = null;
    if (!isFinite(sessBestLap)) sessBestLap = null;

    // Latest completed lap
    const completedLaps = driverLaps.filter((lt) => lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300);
    const latest = completedLaps.length > 0 ? completedLaps[completedLaps.length - 1] : null;

    // Previous 3 laps
    const prevLaps = completedLaps.slice(-4, -1).reverse();

    return {
      latest,
      prevLaps,
      bestS1, bestS2, bestS3, bestLap,
      sessBestS1, sessBestS2, sessBestS3, sessBestLap,
      lapNumber: latest?.LapNumber || currentLap,
    };
  }, [focusDriver, sessionData, currentLap]);

  // Current tyre compound from frame data
  const compound = useMemo(() => {
    if (!focusDriver || !frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const d = frameData.frames[idx]?.drivers?.[focusDriver];
    if (!d) return null;
    return COMPOUND_NAMES[d.tyre] || 'UNKNOWN';
  }, [focusDriver, frameData, currentFrameIndex]);

  if (!focusDriver || !data) return null;

  const color = getDriverColor(focusDriver);
  const lt = data.latest;
  const s1 = lt?.Sector1TimeSeconds;
  const s2 = lt?.Sector2TimeSeconds;
  const s3 = lt?.Sector3TimeSeconds;
  const lapTime = lt?.LapTimeSeconds;

  const sectors = [
    { label: 'S1', time: s1, best: data.bestS1, sessBest: data.sessBestS1 },
    { label: 'S2', time: s2, best: data.bestS2, sessBest: data.sessBestS2 },
    { label: 'S3', time: s3, best: data.bestS3, sessBest: data.sessBestS3 },
  ];

  const compoundColor = compound ? (TYRE_COLORS[compound] || '#888') : '#888';
  const compoundTextColor = (compound === 'MEDIUM' || compound === 'HARD') ? '#000' : '#fff';

  return (
    <div className="pitwall-sector-panel">
      <div className="pitwall-sector-panel__header">
        <div className="pitwall-sector-panel__team-bar" style={{ background: color }} />
        <span className="pitwall-sector-panel__abbr">{focusDriver}</span>
        <span className="pitwall-sector-panel__lap-badge">LAP {data.lapNumber}</span>
        {compound && compound !== 'UNKNOWN' && (
          <span
            className="pitwall-sector-panel__compound"
            style={{ backgroundColor: compoundColor, color: compoundTextColor }}
          >
            {compound}
          </span>
        )}
      </div>

      <div className="pitwall-sector-panel__total">
        <span className="pitwall-sector-panel__total-label">LAP TIME</span>
        <span
          className="pitwall-sector-panel__total-value"
          style={{ color: getLapColor(lapTime, data.bestLap, data.sessBestLap) }}
        >
          {fmtLap(lapTime)}
        </span>
      </div>

      <div className="pitwall-sector-panel__sectors">
        {sectors.map((sec) => {
          const sColor = getSectorColor(sec.time, sec.best, sec.sessBest);
          const delta = (sec.time && sec.time > 0 && sec.best) ? sec.time - sec.best : null;
          const deltaColor = delta != null
            ? (delta <= 0 ? '#22c55e' : delta > 0.3 ? '#ef4444' : 'rgba(255,255,255,0.4)')
            : 'rgba(255,255,255,0.3)';
          return (
            <div key={sec.label} className="pitwall-sector-panel__sector">
              <span className="pitwall-sector-panel__sector-label">{sec.label}</span>
              <span className="pitwall-sector-panel__sector-value" style={{ color: sColor }}>
                {fmtSector(sec.time)}
              </span>
              <span className="pitwall-sector-panel__sector-delta" style={{ color: deltaColor }}>
                {fmtDelta(delta)}
              </span>
            </div>
          );
        })}
      </div>

      {data.prevLaps.length > 0 && (
        <div className="pitwall-sector-panel__prev">
          {data.prevLaps.map((pl) => {
            const isBest = data.bestLap && Math.abs(pl.LapTimeSeconds - data.bestLap) <= 0.010;
            return (
              <span
                key={pl.LapNumber}
                className={`pitwall-sector-panel__prev-chip${isBest ? ' pitwall-sector-panel__prev-chip--best' : ''}`}
              >
                L{pl.LapNumber}: {fmtLap(pl.LapTimeSeconds)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
