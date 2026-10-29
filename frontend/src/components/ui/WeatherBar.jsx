import React, { useState, useMemo } from 'react';
import { useF1Store, weatherAtSessionTime } from '../../store/useF1Store';
import { useSessionNow } from '../../hooks/useSessionNow';
import SessionMenu from './SessionMenu';
import CommandBar from '../CommandPalette/CommandBar';
import LayoutPresetBar from './LayoutPresetBar';
import { TEXT_COLORS, withAlpha, UI_COLORS } from '../../utils/colors';
import Wordmark from './Wordmark';
import { useDemoMode, DEMO_NOTE } from '../../utils/demoMode';

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
  // Static demo (a demo build, or the backend did not answer): always shown
  const demo = useDemoMode();

  const weather = sessionData?.weather_data;
  const sessionNow = useSessionNow();

  // Weather row in force at the replay's now (evolves with replay). Weather
  // Time is session seconds, so it is compared with sessionNow
  // (= replay time + sessionTimeOffset), not with the 0-based replay time.
  // The store resets the replay clock on every session load / reset / quali
  // segment change, and in a qualifying replay sessionTimeOffset is the
  // active segment's origin, so the row is never another session's or
  // segment's.
  const latest = useMemo(
    () => weatherAtSessionTime(weather, sessionNow),
    [weather, sessionNow],
  );
  const eventName = sessionData?.circuit_info?.event_name
    || liveSessionInfo?.event_name
    || '';
  const flag = FLAG_LABELS[currentFlagStatus] || FLAG_LABELS['1'];

  return (
    <>
      <header className="weather-bar">
        {/* Left: wordmark + event */}
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
          <Wordmark className="weather-bar__wordmark" />
          {/* The full name, or "GP" for "Grand Prix" up to 1440 px wide (CSS),
              where the 8vw box cut "Italian Grand Prix" by 15-22 px; a name
              still too long ends in an ellipsis, the full name in the title */}
          <span className="weather-bar__event" title={eventName}>
            <span className="weather-bar__event-long">{eventName}</span>
            <span className="weather-bar__event-short">{eventName.replace(/\bGrand Prix\b/, 'GP')}</span>
          </span>
          {demo.active && (
            <span
              className="weather-bar__demo"
              title={demo.source === 'fallback' && demo.reason ? `${DEMO_NOTE} (${demo.reason})` : DEMO_NOTE}
            >Demo</span>
          )}
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
                <span className="weather-bar__pill-label"><span className="weather-bar__pill-label--long">Track</span><span className="weather-bar__pill-label--short">Trk</span></span>
                <span className="weather-bar__pill-value">
                  {latest.TrackTemp != null
                    ? tempUnit === 'F'
                      ? `${(latest.TrackTemp * 9 / 5 + 32).toFixed(1)}°F`
                      : `${latest.TrackTemp.toFixed(1)}°C`
                    : '—'}
                </span>
              </div>
              <div className="weather-bar__pill">
                <span className="weather-bar__pill-label"><span className="weather-bar__pill-label--long">Humidity</span><span className="weather-bar__pill-label--short">Hum</span></span>
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

        {/* Layout presets — Lightroom Classic style */}
        <LayoutPresetBar />

        {/* Right: Session info + Flag status */}
        <div className="weather-bar__right">
          {isLiveMode && (
            <span className="weather-bar__live-badge" style={{
              background: withAlpha(UI_COLORS.accent, liveConnected ? 0.8 : 0.3),
              animation: liveConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none',
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: liveConnected ? TEXT_COLORS.primary : TEXT_COLORS.muted,
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
