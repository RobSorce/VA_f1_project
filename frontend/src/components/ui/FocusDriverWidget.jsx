import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';

function fmtTime(s) {
  if (!s || s <= 0) return '—';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

const TREND_ARROWS = { closing: '\u2191', opening: '\u2193', stable: '\u2194' };
const TREND_COLORS = { closing: '#ef4444', opening: '#22c55e', stable: 'rgba(255,255,255,0.4)' };

export default function FocusDriverWidget() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const drivers = useF1Store((s) => s.drivers);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const rivalContext = useF1Store((s) => s.rivalContext);
  const currentLap = useF1Store((s) => s.currentLap);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const sessionData = useF1Store((s) => s.sessionData);

  const driverInfo = useMemo(() => {
    if (!focusDriver || !drivers?.length) return null;
    return drivers.find((d) => d.Abbreviation === focusDriver);
  }, [focusDriver, drivers]);

  const color = focusDriver ? getDriverColor(focusDriver) : '#888';

  // Current tyre from frame data
  const tyreInfo = useMemo(() => {
    if (!focusDriver || !frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const d = frameData.frames[idx]?.drivers?.[focusDriver];
    if (!d) return null;
    const NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
    return { compound: NAMES[d.tyre] || 'UNKNOWN', age: d.tyre_life != null ? Math.round(d.tyre_life) : null };
  }, [focusDriver, frameData, currentFrameIndex]);

  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);

  // Current position — for qualifying, use race_results position directly
  const currentPos = useMemo(() => {
    if (!focusDriver) return null;
    if (isQualifyingReplay) {
      const result = (sessionData?.race_results || []).find(
        (r) => (r.Abbreviation || r.Driver) === focusDriver
      );
      return result?.Position || null;
    }
    if (!sessionData?.lap_times?.length) return null;
    const laps = sessionData.lap_times.filter((l) => l.Driver === focusDriver && l.LapNumber <= currentLap && l.Position);
    if (laps.length === 0) return null;
    return laps[laps.length - 1].Position;
  }, [focusDriver, sessionData, currentLap, isQualifyingReplay]);

  if (!focusDriver) {
    return (
      <div className="focus-widget" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div style={{ padding: '12px 10px', textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          Double-click a driver to focus
        </div>
      </div>
    );
  }

  const pred = lstmPredictions;
  const nextLap = pred?.predicted_times?.[0];
  const pitProb = pred?.pit_probability;
  const optPit = pred?.optimal_pit_lap;
  const hasPredictions = pred != null;

  return (
    <div className="focus-widget" style={{ borderColor: `${color}44` }}>
      {/* Driver identity */}
      <div className="focus-widget__header" style={{ background: `linear-gradient(135deg, ${color}18, transparent)` }}>
        <span className="focus-widget__team-bar" style={{ backgroundColor: color }} />
        <div className="focus-widget__identity">
          <span className="focus-widget__abbr" style={{ color }}>{focusDriver}</span>
          <span className="focus-widget__team">{driverInfo?.TeamName || ''}</span>
        </div>
        <div className="focus-widget__status">
          {currentPos && <span className="focus-widget__pos">P{currentPos}</span>}
          {tyreInfo && (
            <span className="focus-widget__tyre" style={{ backgroundColor: TYRE_COLORS[tyreInfo.compound] || '#888', color: tyreInfo.compound === 'HARD' || tyreInfo.compound === 'MEDIUM' ? '#000' : '#fff' }}>
              {tyreInfo.compound[0]}{tyreInfo.age != null ? ` ${tyreInfo.age}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* LSTM Predictions */}
      <div className="focus-widget__section">
        <div className="focus-widget__section-title">
          Predictions
          {hasPredictions && <span className="focus-widget__pulse" />}
        </div>
        {hasPredictions ? (
          <div className="focus-widget__stats">
            <div className="focus-widget__stat">
              <span className="focus-widget__stat-label">Next Lap</span>
              <span className="focus-widget__stat-value">{fmtTime(nextLap)}</span>
            </div>
            <div className="focus-widget__stat">
              <span className="focus-widget__stat-label">Pit Prob</span>
              <span className="focus-widget__stat-value">{pitProb != null ? `${(pitProb * 100).toFixed(0)}%` : '—'}</span>
            </div>
            {optPit && optPit > currentLap && (
              <div className="focus-widget__stat">
                <span className="focus-widget__stat-label">Pit Window</span>
                <span className="focus-widget__stat-value">Lap {optPit}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="focus-widget__empty">Waiting for data...</div>
        )}
      </div>

      {/* Rivals */}
      {rivalContext.length > 0 && (
        <div className="focus-widget__section">
          <div className="focus-widget__section-title">Rivals</div>
          <div className="focus-widget__rivals">
            {rivalContext.map((r) => {
              const rColor = getDriverColor(r.driver);
              return (
                <div key={r.driver} className="focus-widget__rival-row">
                  <span className="focus-widget__rival-pos">P{r.position}</span>
                  <span className="focus-widget__rival-bar" style={{ backgroundColor: rColor }} />
                  <span className="focus-widget__rival-name">{r.driver}</span>
                  <span className="focus-widget__rival-gap" style={{ color: r.gap != null && r.gap > 0 ? '#22c55e' : '#ef4444' }}>
                    {r.gap != null ? `${r.gap > 0 ? '+' : ''}${r.gap.toFixed(1)}s` : '—'}
                  </span>
                  <span className="focus-widget__rival-trend" style={{ color: TREND_COLORS[r.gapTrend] }}>
                    {TREND_ARROWS[r.gapTrend]}
                  </span>
                  <span className="focus-widget__rival-tyre" style={{ backgroundColor: TYRE_COLORS[r.compound] || '#888', color: r.compound === 'HARD' || r.compound === 'MEDIUM' ? '#000' : '#fff' }}>
                    {r.compound[0]}
                  </span>
                  <span className="focus-widget__rival-age">{r.tyreAge}L</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
