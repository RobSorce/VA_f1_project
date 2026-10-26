import React, { useMemo } from 'react';
import { useF1Store, weatherAtSessionTime } from '../../store/useF1Store';
import { useSessionNow } from '../../hooks/useSessionNow';
import { CHART_FONT, FLAG_COLORS, SURFACES, TEXT_COLORS, tintedChip } from '../../utils/colors';

function ThermometerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
    </svg>
  );
}

function RoadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19L8 5" /><path d="M16 5l4 14" />
      <line x1="12" y1="6" x2="12" y2="8" /><line x1="12" y1="11" x2="12" y2="13" /><line x1="12" y1="16" x2="12" y2="18" />
    </svg>
  );
}

function DropletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
    </svg>
  );
}

function WindIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.59 4.59A2 2 0 1 1 11 8H2" /><path d="M12.59 19.41A2 2 0 1 0 14 16H2" /><path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2" />
    </svg>
  );
}

// Compact (Pit Wall side column, V13): the DRY / WET chip sits on the title
// line, the four readings on two lines
const panelStyle = {
  flex: 'none',
  padding: '8px 12px',
  background: 'rgba(12,12,28,0.75)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

const titleStyle = {
  fontFamily: 'var(--font-primary)',
  fontSize: CHART_FONT.label, fontWeight: 700, color: TEXT_COLORS.muted,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 6,
};

export default function WeatherMini() {
  const sessionData = useF1Store((s) => s.sessionData);
  const weatherData = sessionData?.weather_data;
  // Session seconds; Infinity in live mode, so the most recent entry is shown.
  // In a qualifying replay it is the active segment's clock (the store's
  // sessionTimeOffset is that segment's origin), so each segment shows its
  // own weather.
  const sessionNow = useSessionNow();

  // Weather row in force at sessionNow (Time is session seconds)
  const latest = useMemo(
    () => weatherAtSessionTime(weatherData, sessionNow),
    [weatherData, sessionNow],
  );

  if (!latest) {
    return (
      <div style={panelStyle}>
        <div style={titleStyle}>Weather</div>
        <div style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.data }}>No weather data</div>
      </div>
    );
  }
  const isWet = latest.Rainfall === true || latest.Rainfall === 1 || latest.Rainfall === 'True';
  // Track condition chip: the word is the cue, the tint follows it
  const chip = tintedChip(isWet ? FLAG_COLORS.blue : FLAG_COLORS.green, 0.15, SURFACES.panel);
  const valueStyle = { fontSize: CHART_FONT.data, fontFamily: "'JetBrains Mono', monospace" };
  const cellStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, color: TEXT_COLORS.secondary };

  return (
    <div style={panelStyle}>
      <div style={{ ...titleStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Weather</span>
        <span style={{
          display: 'inline-block', padding: '1px 8px', borderRadius: 3,
          fontSize: CHART_FONT.label, fontWeight: 800, letterSpacing: '0.08em',
          background: chip.background, color: chip.color,
          border: `1px solid ${chip.borderColor}`,
        }}>
          {isWet ? 'WET' : 'DRY'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <div style={cellStyle}>
          <ThermometerIcon />
          <span style={valueStyle}>
            {latest.AirTemp != null ? `${Number(latest.AirTemp).toFixed(1)}°C` : '—'}
          </span>
        </div>
        <div style={cellStyle}>
          <RoadIcon />
          <span style={valueStyle}>
            {latest.TrackTemp != null ? `${Number(latest.TrackTemp).toFixed(1)}°C` : '—'}
          </span>
        </div>
        <div style={cellStyle}>
          <DropletIcon />
          <span style={valueStyle}>
            {latest.Humidity != null ? `${Number(latest.Humidity).toFixed(0)}%` : '—'}
          </span>
        </div>
        <div style={cellStyle}>
          <WindIcon />
          <span style={valueStyle}>
            {/* FastF1 WindSpeed is in m/s (WeatherBar shows the same unit) */}
            {latest.WindSpeed != null ? `${Number(latest.WindSpeed).toFixed(1)} m/s` : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}
