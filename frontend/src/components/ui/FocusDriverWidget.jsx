import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { activeSegmentWindow } from '../../utils/raceTime';
import {
  getDriverColor, tyreColor, tyreLetter, contrastText, markColor, textColor, withAlpha, DIVERGING, TEXT_COLORS,
  UNKNOWN_TEAM_COLOR,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { focusDriverStatus, qualifyingPositionAt } from '../../utils/views/focusDriverWidget';
import { focusForecast, forecastPoints, forecastPit, forecastMethodText } from '../../utils/forecast';

function fmtTime(s) {
  if (!s || s <= 0) return '—';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

// Gap trend (utils/rivalTrend.js: closing = the gap shrinks, opening = it
// grows): the arrow is the cue, the colour the diverging pair (V1: blue /
// orange, never red / green) by what it means for the focus driver: a rival
// behind closing in is worse, a rival ahead being caught is better
const TREND_ARROWS = { closing: '\u2191', opening: '\u2193', stable: '\u2194' };
const trendColor = (trend, side) => {
  if (trend === 'stable' || !TREND_ARROWS[trend]) return TEXT_COLORS.muted;
  return (trend === 'closing') === (side === 'ahead') ? DIVERGING.better : DIVERGING.worse;
};

// FIA compound badge: colour + letter, text black or white by contrast
const tyreBadge = (compound) => ({ backgroundColor: tyreColor(compound), color: contrastText(tyreColor(compound)) });

export default function FocusDriverWidget() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const drivers = useF1Store((s) => s.drivers);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const rivalContext = useF1Store((s) => s.rivalContext);
  const currentLap = useF1Store((s) => s.currentLap);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const sessionData = useF1Store((s) => s.sessionData);
  // Causal "now" in session seconds (utils/raceTime.js)
  const sessionNow = useSessionNow();

  const driverInfo = useMemo(() => {
    if (!focusDriver || !drivers?.length) return null;
    return drivers.find((d) => d.Abbreviation === focusDriver);
  }, [focusDriver, drivers]);

  const color = focusDriver ? getDriverColor(focusDriver) : UNKNOWN_TEAM_COLOR;

  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  // The active qualifying segment's laps only (its window's start)
  const segmentStart = useF1Store((s) => activeSegmentWindow(s)?.start);
  const isLiveMode = useF1Store((s) => s.isLiveMode);

  // Position and tyre from the lap data at sessionNow (focusDriverStatus, utils/views)
  const lapStatus = useMemo(
    () => (isQualifyingReplay ? null : focusDriverStatus(sessionData?.lap_times, focusDriver, sessionNow)),
    [sessionData, focusDriver, sessionNow, isQualifyingReplay],
  );

  // Current tyre: race replay / lap mode = the set in force from the lap data
  // (new set from the pit exit; the frames switch at the out-lap start, in the
  // pit lane); live and qualifying replay = frame data
  const frameTyreInfo = useMemo(() => {
    if (!focusDriver || !frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const d = frameData.frames[idx]?.drivers?.[focusDriver];
    if (!d) return null;
    const NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
    return { compound: NAMES[d.tyre] || 'UNKNOWN', age: d.tyre_life != null ? Math.round(d.tyre_life) : null };
  }, [focusDriver, frameData, currentFrameIndex]);
  const tyreInfo = !isLiveMode && lapStatus?.compound
    ? { compound: lapStatus.compound, age: lapStatus.tyreLife }
    : frameTyreInfo;

  // Current position — qualifying: the rank by best lap completed so far
  const currentPos = useMemo(() => {
    if (!focusDriver) return null;
    if (isQualifyingReplay) {
      return qualifyingPositionAt(sessionData?.lap_times, focusDriver, sessionNow, { after: segmentStart });
    }
    // Position at the end of the last lap completed at sessionNow (a lap row's
    // Position is only known once that lap is over)
    return lapStatus?.position ?? null;
  }, [focusDriver, sessionData, isQualifyingReplay, lapStatus, sessionNow, segmentStart]);

  if (!focusDriver) {
    return (
      <div className="focus-widget" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div style={{ padding: '12px 10px', textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          Double-click a driver to focus
        </div>
      </div>
    );
  }

  // The focus driver's forecast only (double-click a driver), utils/forecast.js
  const pred = focusForecast(lstmPredictions, focusDriver);
  const first = forecastPoints(pred)[0] || null;
  const pitProb = forecastPit(pred).probability;
  const optPit = pred?.optimal_pit_lap;
  const hasPredictions = pred != null;

  return (
    <div className="focus-widget" style={{ borderColor: withAlpha(color, 0.27) }}>
      {/* Driver identity */}
      <div className="focus-widget__header" style={{ background: `linear-gradient(135deg, ${withAlpha(color, 0.09)}, transparent)` }}>
        <span className="focus-widget__team-bar" style={{ backgroundColor: markColor(color) }} />
        <div className="focus-widget__identity">
          <span className="focus-widget__abbr" style={{ color: textColor(color) }}>{focusDriver}</span>
          <span className="focus-widget__team">{driverInfo?.TeamName || ''}</span>
        </div>
        <div className="focus-widget__status">
          {currentPos && <span className="focus-widget__pos">P{currentPos}</span>}
          {tyreInfo && (
            <span className="focus-widget__tyre" style={tyreBadge(tyreInfo.compound)}>
              {tyreLetter(tyreInfo.compound)}{tyreInfo.age != null ? ` ${tyreInfo.age}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Lap-time forecast (the served method, named) */}
      <div className="focus-widget__section">
        <div className="focus-widget__section-title" title={hasPredictions ? forecastMethodText(pred) : undefined}>
          Predictions
          {hasPredictions && <span className="focus-widget__pulse" />}
        </div>
        {hasPredictions ? (
          <div className="focus-widget__stats">
            <div className="focus-widget__stat" title={hasPredictions ? (pred.lstm_note || pred.reason || '') : undefined}>
              <span className="focus-widget__stat-label">{first ? `Lap ${first.lap}` : 'Next Lap'}</span>
              <span className="focus-widget__stat-value">{fmtTime(first?.time)}</span>
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
          <div className="focus-widget__empty">Double-click the driver for a lap-time forecast</div>
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
                  <span className="focus-widget__rival-bar" style={{ backgroundColor: markColor(rColor) }} />
                  <span className="focus-widget__rival-name">{r.driver}</span>
                  {/* + = the rival is behind (better for the focus driver): blue; − ahead: orange; the sign is shown */}
                  <span className="focus-widget__rival-gap" style={{ color: r.gap == null ? TEXT_COLORS.muted : r.gap > 0 ? DIVERGING.better : DIVERGING.worse }}>
                    {r.gap != null ? `${r.gap > 0 ? '+' : ''}${r.gap.toFixed(1)}s` : '—'}
                  </span>
                  <span className="focus-widget__rival-trend" style={{ color: trendColor(r.gapTrend, r.side) }}>
                    {TREND_ARROWS[r.gapTrend]}
                  </span>
                  <span className="focus-widget__rival-tyre" style={tyreBadge(r.compound)}>
                    {tyreLetter(r.compound)}
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
