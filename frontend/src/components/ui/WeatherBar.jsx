import React, { useState, useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import SessionMenu from './SessionMenu';
import CommandBar from '../CommandPalette/CommandBar';

/* ── Minimal line-style weather condition icons ── */
function WeatherIcon({ rainfall, humidity, className }) {
  const size = 20;
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'rgba(255,255,255,0.7)', strokeWidth: '1.5',
    strokeLinecap: 'round', strokeLinejoin: 'round', className,
  };

  // Rainy
  if (rainfall === true || rainfall === 1 || rainfall === 'True') {
    return (
      <svg {...common}>
        <path d="M6 17a4 4 0 0 1-.98-7.88A5.5 5.5 0 0 1 16.9 8H17a4 4 0 0 1 0 8H6z" />
        <line x1="8" y1="19" x2="7" y2="22" />
        <line x1="12" y1="19" x2="11" y2="22" />
        <line x1="16" y1="19" x2="15" y2="22" />
      </svg>
    );
  }

  // Overcast (high humidity)
  if (humidity != null && humidity >= 70) {
    return (
      <svg {...common}>
        <path d="M6 19a4 4 0 0 1-.98-7.88A5.5 5.5 0 0 1 16.9 10H17a4 4 0 0 1 0 8H6z" />
        <path d="M17.5 13a3 3 0 0 0-2.83-4A4.5 4.5 0 0 0 7 7.5" strokeOpacity="0.4" />
      </svg>
    );
  }

  // Partly cloudy (moderate humidity)
  if (humidity != null && humidity >= 45) {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" />
        <line x1="8" y1="2" x2="8" y2="3" />
        <line x1="8" y1="13" x2="8" y2="14" />
        <line x1="2" y1="8" x2="3" y2="8" />
        <line x1="13" y1="8" x2="14" y2="8" />
        <line x1="3.76" y1="3.76" x2="4.47" y2="4.47" />
        <line x1="11.53" y1="3.76" x2="10.82" y2="4.47" />
        <path d="M10 21a3.5 3.5 0 0 1-.86-6.89A4.75 4.75 0 0 1 18.8 13H19a3.5 3.5 0 0 1 0 7H10z" />
      </svg>
    );
  }

  // Clear / sunny
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="3" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21" />
      <line x1="3" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21" y2="12" />
      <line x1="5.64" y1="5.64" x2="7.05" y2="7.05" />
      <line x1="16.95" y1="16.95" x2="18.36" y2="18.36" />
      <line x1="5.64" y1="18.36" x2="7.05" y2="16.95" />
      <line x1="16.95" y1="7.05" x2="18.36" y2="5.64" />
    </svg>
  );
}

const FLAG_LABELS = {
  '1': { label: 'Track Clear', cls: 'green' },
  '2': { label: 'Yellow Flag', cls: 'yellow' },
  '4': { label: 'Safety Car', cls: 'sc' },
  '5': { label: 'Red Flag', cls: 'red' },
  '6': { label: 'VSC', cls: 'vsc' },
  '7': { label: 'VSC Ending', cls: 'vsc' },
};

export default function WeatherBar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionData = useF1Store((s) => s.sessionData);
  const sessionType = useF1Store((s) => s.sessionType);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const liveConnected = useF1Store((s) => s.liveConnected);
  const currentFlagStatus = useF1Store((s) => s.currentFlagStatus);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const currentTime = useF1Store((s) => s.currentTime);
  const resetSession = useF1Store((s) => s.resetSession);
  const tempUnit = useF1Store((s) => s.tempUnit);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const liveSessionInfo = useF1Store((s) => s.liveSessionInfo);

  const weather = sessionData?.weather_data;

  // Find the weather entry closest to currentTime (evolves with replay)
  const latest = useMemo(() => {
    if (!weather?.length) return null;
    if (!currentTime || currentTime <= 0) return weather[0];
    // Weather entries have a Time field in seconds — find last entry <= currentTime
    let best = weather[0];
    for (const w of weather) {
      if (w.Time != null && w.Time <= currentTime) {
        best = w;
      } else if (w.Time != null && w.Time > currentTime) {
        break;
      }
    }
    return best;
  }, [weather, currentTime]);
  const eventName = sessionData?.circuit_info?.event_name
    || liveSessionInfo?.event_name
    || '';
  const flag = FLAG_LABELS[currentFlagStatus] || FLAG_LABELS['1'];

  return (
    <>
      <header className="weather-bar">
        {/* Left: Logo + Event */}
        <div className="weather-bar__left">
          <button
            className="weather-bar__menu-btn"
            onClick={() => setMenuOpen(true)}
            aria-label="Open session menu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <img src="/f1-logo.png" alt="F1" className="weather-bar__logo" />
          <span className="weather-bar__event">{eventName}</span>
          <button className="weather-bar__change-btn" onClick={resetSession}>Change</button>
        </div>

        {/* Command Bar — persistent search */}
        <CommandBar />

        {/* Center: Weather pills */}
        <div className="weather-bar__center">
          {latest && (
            <>
              <WeatherIcon
                rainfall={latest.Rainfall}
                humidity={latest.Humidity}
                className="weather-bar__condition-icon"
              />
              <div className="weather-bar__pill">
                <span className="weather-bar__pill-label">Air</span>
                <span className="weather-bar__pill-value">
                  {latest.AirTemp != null
                    ? tempUnit === 'F'
                      ? `${(latest.AirTemp * 9 / 5 + 32).toFixed(1)}°F`
                      : `${latest.AirTemp.toFixed(1)}°C`
                    : '—'}
                </span>
              </div>
              <div className="weather-bar__pill">
                <span className="weather-bar__pill-label">Track</span>
                <span className="weather-bar__pill-value">
                  {latest.TrackTemp != null
                    ? tempUnit === 'F'
                      ? `${(latest.TrackTemp * 9 / 5 + 32).toFixed(1)}°F`
                      : `${latest.TrackTemp.toFixed(1)}°C`
                    : '—'}
                </span>
              </div>
              <div className="weather-bar__pill">
                <span className="weather-bar__pill-label">Humidity</span>
                <span className="weather-bar__pill-value">{latest.Humidity?.toFixed(0) ?? '—'}%</span>
              </div>
              <div className="weather-bar__pill">
                <span className="weather-bar__pill-label">Wind</span>
                <span className="weather-bar__pill-value">
                  {latest.WindSpeed != null
                    ? speedUnit === 'mph'
                      ? `${(latest.WindSpeed * 2.237).toFixed(1)} mph`
                      : `${latest.WindSpeed.toFixed(1)} m/s`
                    : '—'}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Elapsed time capsule */}
        {currentTime > 0 && (
          <div className="weather-bar__elapsed-capsule">
            <svg className="weather-bar__elapsed-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="13" r="8" />
              <path d="M12 9v4l2.5 2.5" />
              <path d="M5 3l4 2" />
              <path d="M19 3l-4 2" />
              <line x1="12" y1="5" x2="12" y2="3" />
            </svg>
            <span className="weather-bar__elapsed-value">
              {Math.floor(currentTime / 3600) > 0
                ? `${Math.floor(currentTime / 3600)}:${String(Math.floor((currentTime % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(currentTime % 60)).padStart(2, '0')}`
                : `${Math.floor(currentTime / 60)}:${String(Math.floor(currentTime % 60)).padStart(2, '0')}`}
            </span>
          </div>
        )}

        {/* Right: Session info + Flag status */}
        <div className="weather-bar__right">
          {isLiveMode && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 800,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              color: '#fff',
              background: liveConnected ? 'rgba(225,6,0,0.8)' : 'rgba(225,6,0,0.3)',
              animation: liveConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none',
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: liveConnected ? '#fff' : '#888',
              }} />
              LIVE
            </span>
          )}
          <span className="weather-bar__session-badge">{sessionType}</span>
          <span className="weather-bar__lap">
            Lap {currentLap}/{totalRaceLaps || maxLap}
          </span>
          <span className={`weather-bar__flag weather-bar__flag--${flag.cls}`}>
            {flag.label}
          </span>
        </div>
      </header>

      <SessionMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
