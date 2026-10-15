import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, markColor, tyreColor, contrastText, signedDelta, STATUS_COLORS,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  pitWallSectorData, pitWallTimingCue, pitWallDeltaColor, pitWallLegend,
} from '../../utils/views/pitWallSectorPanel';
import Legend from './Legend';

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

// Delta to the personal best, the sign always shown (true minus sign)
function fmtDelta(delta) {
  if (delta == null || !isFinite(delta)) return '';
  return signedDelta(delta);
}

// The running chrono: neutral and italic (not a timing colour)
const RUNNING = { color: STATUS_COLORS.running, fontStyle: 'italic' };

const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTER', 5: 'WET' };

export default function PitWallSectorPanel() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const sessionData = useF1Store((s) => s.sessionData);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const dnfMap = useF1Store((s) => s.dnfMap);
  // Causal "now" in session seconds (utils/raceTime.js): only completed laps
  // count as history, the lap in progress shows what has been run
  const sessionNow = useSessionNow();

  const data = useMemo(
    () => pitWallSectorData(sessionData?.lap_times, focusDriver, sessionNow, {
      replayActive: totalFrames > 0, dnfMap, isLiveMode,
    }),
    [focusDriver, sessionData, sessionNow, totalFrames, dnfMap, isLiveMode],
  );

  // Current tyre: race replay / lap mode = the set in force from the lap data
  // (new set from the pit exit); live and qualifying replay = frame data
  const frameCompound = useMemo(() => {
    if (!focusDriver || !frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const d = frameData.frames[idx]?.drivers?.[focusDriver];
    if (!d) return null;
    return COMPOUND_NAMES[d.tyre] || 'UNKNOWN';
  }, [focusDriver, frameData, currentFrameIndex]);
  const compound = isLiveMode || isQualifyingReplay ? frameCompound : (data?.compound || frameCompound);

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

  // FIA compound badge (its name is the text): black or white by contrast
  const compoundColor = tyreColor(compound);
  const compoundTextColor = contrastText(compoundColor);
  const lapCue = pitWallTimingCue(lapTime, data.bestLap, data.sessBestLap, 'lap');

  return (
    <div className="pitwall-sector-panel">
      <div className="pitwall-sector-panel__header">
        <div className="pitwall-sector-panel__team-bar" style={{ background: markColor(color) }} />
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
            ...(inProg ? RUNNING : { color: lapCue.color }),
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {!inProg && lapCue.glyph && <span className="timing-glyph">{lapCue.glyph} </span>}
          {inProg && data.liveLapChrono != null
            ? fmtLap(data.liveLapChrono)
            : fmtLap(lapTime)}
        </span>
      </div>

      <div className="pitwall-sector-panel__sectors">
        {sectors.map((sec) => {
          const isActive = inProg && data.activeSector === sec.sectorNum;
          const cue = pitWallTimingCue(sec.time, sec.best, sec.sessBest, 'sector');
          const delta = (sec.time && sec.time > 0 && sec.best) ? sec.time - sec.best : null;
          const deltaColor = pitWallDeltaColor(delta);
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
                style={{ ...(isActive ? RUNNING : { color: cue.color }), fontVariantNumeric: 'tabular-nums' }}
              >
                {!isActive && cue.glyph && <span className="timing-glyph">{cue.glyph} </span>}
                {displayVal}
              </span>
              <span className="pitwall-sector-panel__sector-delta" style={{ color: deltaColor }}>
                {isActive ? '' : fmtDelta(delta)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Timing colours with their glyph / sign (V4) */}
      <Legend items={pitWallLegend()} shape="glyph" />

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
