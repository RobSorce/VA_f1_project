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
  const currentTime = useF1Store((s) => s.currentTime);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);

  const data = useMemo(() => {
    if (!focusDriver || !sessionData?.lap_times?.length) return null;

    const lapTimes = sessionData.lap_times;
    const replayActive = totalFrames > 0;
    // Session time offset: frame.t is 0-based, LapStartTime is session-absolute
    let offset = 0;
    for (const d of lapTimes) {
      if (d.LapStartTime > 0 && (d.Time > 0 || d.LapTimeSeconds > 0) && d.LapNumber >= 1) {
        offset = d.LapStartTime;
        break;
      }
    }
    const hasOffset = offset > 0;

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

    // In-progress lap: the driver's latest historic lap whose Time hasn't been reached yet
    let inProgressLt = null;
    if (replayActive && hasOffset) {
      // Look at the driver's latest lap_time row where LapStartTime <= currentTime + offset < Time
      for (let i = driverLaps.length - 1; i >= 0; i--) {
        const lt = driverLaps[i];
        if (lt.LapStartTime > 0) {
          const startFT = lt.LapStartTime - offset;
          const endFT = lt.Time > 0 ? lt.Time - offset : null;
          if (currentTime >= startFT && (endFT == null || currentTime < endFT)) {
            inProgressLt = lt;
            break;
          }
        }
      }
    }

    // Compute live chrono fields from the in-progress lap
    let liveLapChrono = null;
    let liveS1 = null, liveS2 = null, liveS3 = null;
    let activeSector = null; // 1|2|3
    if (inProgressLt && hasOffset) {
      const lapStartFT = inProgressLt.LapStartTime - offset;
      liveLapChrono = Math.max(0, currentTime - lapStartFT);

      const s1EndFT = inProgressLt.Sector1SessionTime > 0 ? inProgressLt.Sector1SessionTime - offset : null;
      const s2EndFT = inProgressLt.Sector2SessionTime > 0 ? inProgressLt.Sector2SessionTime - offset : null;
      const s3EndFT = inProgressLt.Sector3SessionTime > 0 ? inProgressLt.Sector3SessionTime - offset : null;

      const s1Done = s1EndFT != null ? currentTime >= s1EndFT : inProgressLt.Sector1TimeSeconds > 0;
      const s2Done = s2EndFT != null ? currentTime >= s2EndFT : inProgressLt.Sector2TimeSeconds > 0;
      const s3Done = s3EndFT != null ? currentTime >= s3EndFT : inProgressLt.Sector3TimeSeconds > 0;

      liveS1 = s1Done ? inProgressLt.Sector1TimeSeconds : null;
      liveS2 = s2Done ? inProgressLt.Sector2TimeSeconds : null;
      liveS3 = s3Done ? inProgressLt.Sector3TimeSeconds : null;

      if (!s1Done) activeSector = 1;
      else if (!s2Done) activeSector = 2;
      else if (!s3Done) activeSector = 3;
    }

    return {
      latest,
      prevLaps,
      bestS1, bestS2, bestS3, bestLap,
      sessBestS1, sessBestS2, sessBestS3, sessBestLap,
      lapNumber: inProgressLt?.LapNumber || latest?.LapNumber || currentLap,
      inProgress: inProgressLt != null,
      liveLapChrono,
      liveS1, liveS2, liveS3,
      activeSector,
    };
  }, [focusDriver, sessionData, currentLap, currentTime, totalFrames]);

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
  // While a lap is in progress, show the live (partial) values; otherwise show the last completed lap.
  const inProg = data.inProgress;
  const lt = data.latest;
  const s1 = inProg ? data.liveS1 : lt?.Sector1TimeSeconds;
  const s2 = inProg ? data.liveS2 : lt?.Sector2TimeSeconds;
  const s3 = inProg ? data.liveS3 : lt?.Sector3TimeSeconds;
  const lapTime = inProg ? null : lt?.LapTimeSeconds;

  const sectors = [
    { label: 'S1', time: s1, best: data.bestS1, sessBest: data.sessBestS1, sectorNum: 1 },
    { label: 'S2', time: s2, best: data.bestS2, sessBest: data.sessBestS2, sectorNum: 2 },
    { label: 'S3', time: s3, best: data.bestS3, sessBest: data.sessBestS3, sectorNum: 3 },
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
          style={{
            color: inProg
              ? '#fbbf24'
              : getLapColor(lapTime, data.bestLap, data.sessBestLap),
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {inProg && data.liveLapChrono != null
            ? fmtLap(data.liveLapChrono)
            : fmtLap(lapTime)}
        </span>
      </div>

      <div className="pitwall-sector-panel__sectors">
        {sectors.map((sec) => {
          const isActive = inProg && data.activeSector === sec.sectorNum;
          const sColor = isActive
            ? '#fbbf24'
            : getSectorColor(sec.time, sec.best, sec.sessBest);
          const delta = (sec.time && sec.time > 0 && sec.best) ? sec.time - sec.best : null;
          const deltaColor = delta != null
            ? (delta <= 0 ? '#22c55e' : delta > 0.3 ? '#ef4444' : 'rgba(255,255,255,0.4)')
            : 'rgba(255,255,255,0.3)';
          // For the active (in-progress) sector, show a running counter
          const displayVal = isActive && data.liveLapChrono != null
            ? (() => {
                // elapsed within the active sector
                if (sec.sectorNum === 1) return data.liveLapChrono.toFixed(1);
                if (sec.sectorNum === 2 && data.liveS1 != null) return (data.liveLapChrono - data.liveS1).toFixed(1);
                if (sec.sectorNum === 3 && data.liveS1 != null && data.liveS2 != null) {
                  return (data.liveLapChrono - data.liveS1 - data.liveS2).toFixed(1);
                }
                return data.liveLapChrono.toFixed(1);
              })()
            : fmtSector(sec.time);
          return (
            <div key={sec.label} className="pitwall-sector-panel__sector">
              <span className="pitwall-sector-panel__sector-label">{sec.label}</span>
              <span
                className="pitwall-sector-panel__sector-value"
                style={{ color: sColor, fontVariantNumeric: 'tabular-nums' }}
              >
                {displayVal}
              </span>
              <span className="pitwall-sector-panel__sector-delta" style={{ color: deltaColor }}>
                {isActive ? '' : fmtDelta(delta)}
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
