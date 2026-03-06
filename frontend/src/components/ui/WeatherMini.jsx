import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';

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

const panelStyle = {
  padding: '10px 12px',
  background: 'rgba(12,12,28,0.75)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

const titleStyle = {
  fontFamily: "'Formula1', 'Titillium Web', sans-serif",
  fontSize: 10, fontWeight: 700, color: '#7a7f9a',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 8,
};

export default function WeatherMini() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentTime = useF1Store((s) => s.currentTime);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const weatherData = sessionData?.weather_data;

  const latest = useMemo(() => {
    if (!weatherData?.length) return null;
    // In live mode, always show the most recent weather entry
    if (isLiveMode) return weatherData[weatherData.length - 1];
    if (!currentTime || currentTime <= 0) return weatherData[0];
    let best = weatherData[0];
    for (const w of weatherData) {
      if (w.Time != null && w.Time <= currentTime) {
        best = w;
      } else if (w.Time != null && w.Time > currentTime) {
        break;
      }
    }
    return best;
  }, [weatherData, currentTime, isLiveMode]);

  if (!latest) {
    return (
      <div style={panelStyle}>
        <div style={titleStyle}>Weather</div>
        <div style={{ color: '#555', fontSize: 11 }}>No weather data</div>
      </div>
    );
  }
  const isWet = latest.Rainfall === true || latest.Rainfall === 1 || latest.Rainfall === 'True';

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Weather</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#bbc' }}>
          <ThermometerIcon />
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            {latest.AirTemp != null ? `${Number(latest.AirTemp).toFixed(1)}\u00B0C` : '\u2014'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#bbc' }}>
          <RoadIcon />
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            {latest.TrackTemp != null ? `${Number(latest.TrackTemp).toFixed(1)}\u00B0C` : '\u2014'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#bbc' }}>
          <DropletIcon />
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            {latest.Humidity != null ? `${Number(latest.Humidity).toFixed(0)}%` : '\u2014'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#bbc' }}>
          <WindIcon />
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            {latest.WindSpeed != null ? `${Number(latest.WindSpeed).toFixed(1)} km/h` : '\u2014'}
          </span>
        </div>
        <div style={{ gridColumn: 'span 2', marginTop: 2 }}>
          <span style={{
            display: 'inline-block', padding: '2px 10px', borderRadius: 3,
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
            background: isWet ? 'rgba(33,150,243,0.15)' : 'rgba(34,197,94,0.12)',
            color: isWet ? '#2196F3' : '#22C55E',
          }}>
            {isWet ? 'WET' : 'DRY'}
          </span>
        </div>
      </div>
    </div>
  );
}
