import React, { useState } from 'react';
import { useF1Store } from '../../store/useF1Store';

const SESSION_TYPES = [
  { value: 'R', label: 'Race' },
  { value: 'Q', label: 'Qualifying' },
  { value: 'S', label: 'Sprint' },
  { value: 'FP1', label: 'FP1' },
  { value: 'FP2', label: 'FP2' },
  { value: 'FP3', label: 'FP3' },
];

const YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

const TELEM_CHANNELS = [
  { key: 'speed', label: 'Speed' },
  { key: 'delta', label: 'Gap Delta' },
  { key: 'throttle', label: 'Throttle' },
  { key: 'brake', label: 'Brake' },
  { key: 'gear', label: 'Gear' },
  { key: 'rpm', label: 'RPM' },
];

const TECH_STACK = [
  'React 18', 'D3.js', 'Zustand', 'Vite', 'FastAPI', 'FastF1',
  'TensorFlow / LSTM', 'Google Gemini AI', 't-SNE',
];

export default function SettingsTabContent() {
  // Settings state
  const theme = useF1Store((s) => s.theme);
  const setTheme = useF1Store((s) => s.setTheme);
  const tempUnit = useF1Store((s) => s.tempUnit);
  const setTempUnit = useF1Store((s) => s.setTempUnit);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const setSpeedUnit = useF1Store((s) => s.setSpeedUnit);
  const playSpeed = useF1Store((s) => s.playSpeed);
  const setPlaySpeed = useF1Store((s) => s.setPlaySpeed);
  const maxOverlays = useF1Store((s) => s.maxOverlays);
  const setMaxOverlays = useF1Store((s) => s.setMaxOverlays);
  const telemetryChannels = useF1Store((s) => s.telemetryChannels);
  const setTelemetryChannel = useF1Store((s) => s.setTelemetryChannel);

  // Session state (for dataset selector)
  const year = useF1Store((s) => s.year);
  const setYear = useF1Store((s) => s.setYear);
  const round = useF1Store((s) => s.round);
  const setRound = useF1Store((s) => s.setRound);
  const sessionType = useF1Store((s) => s.sessionType);
  const setSessionType = useF1Store((s) => s.setSessionType);
  const schedule = useF1Store((s) => s.schedule);
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const loadSession = useF1Store((s) => s.loadSession);
  const isLoading = useF1Store((s) => s.isLoading);

  const [loadingDataset, setLoadingDataset] = useState(false);

  const handleYearChange = (newYear) => {
    setYear(newYear);
    setRound(null);
    fetchSchedule(newYear);
  };

  const handleLoadDataset = async () => {
    if (!round) return;
    setLoadingDataset(true);
    try {
      await loadSession();
    } finally {
      setLoadingDataset(false);
    }
  };

  return (
    <div className="settings-tab">
      {/* ── Appearance ── */}
      <section className="settings-tab__section">
        <h3 className="settings-tab__section-title">Appearance</h3>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Theme</span>
          <div className="settings-tab__pills">
            {['dark', 'light'].map((t) => (
              <button
                key={t}
                className={`settings-tab__pill${theme === t ? ' settings-tab__pill--active' : ''}`}
                onClick={() => setTheme(t)}
              >
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Units ── */}
      <section className="settings-tab__section">
        <h3 className="settings-tab__section-title">Units</h3>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Temperature</span>
          <div className="settings-tab__pills">
            {['C', 'F'].map((u) => (
              <button
                key={u}
                className={`settings-tab__pill${tempUnit === u ? ' settings-tab__pill--active' : ''}`}
                onClick={() => setTempUnit(u)}
              >
                {u === 'C' ? '°C' : '°F'}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Speed</span>
          <div className="settings-tab__pills">
            {[['kmh', 'km/h'], ['mph', 'mph']].map(([val, label]) => (
              <button
                key={val}
                className={`settings-tab__pill${speedUnit === val ? ' settings-tab__pill--active' : ''}`}
                onClick={() => setSpeedUnit(val)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Playback ── */}
      <section className="settings-tab__section">
        <h3 className="settings-tab__section-title">Playback</h3>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Replay Speed</span>
          <div className="settings-tab__pills">
            {[0.5, 1, 2, 4].map((spd) => (
              <button
                key={spd}
                className={`settings-tab__pill${playSpeed === spd ? ' settings-tab__pill--active' : ''}`}
                onClick={() => setPlaySpeed(spd)}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Telemetry Channels ── */}
      <section className="settings-tab__section">
        <h3 className="settings-tab__section-title">Telemetry Channels</h3>
        <div className="settings-tab__toggles">
          {TELEM_CHANNELS.map(({ key, label }) => (
            <label key={key} className="settings-tab__toggle">
              <input
                type="checkbox"
                checked={telemetryChannels[key]}
                onChange={(e) => setTelemetryChannel(key, e.target.checked)}
              />
              <span className="settings-tab__toggle-slider" />
              <span className="settings-tab__toggle-label">{label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Windows ── */}
      <section className="settings-tab__section">
        <h3 className="settings-tab__section-title">Windows</h3>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Max Overlays</span>
          <div className="settings-tab__pills">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={`settings-tab__pill${maxOverlays === n ? ' settings-tab__pill--active' : ''}`}
                onClick={() => setMaxOverlays(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Dataset / Session ── */}
      <section className="settings-tab__section">
        <h3 className="settings-tab__section-title">Dataset</h3>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Year</span>
          <select
            className="settings-tab__select"
            value={year}
            onChange={(e) => handleYearChange(Number(e.target.value))}
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Grand Prix</span>
          <select
            className="settings-tab__select"
            value={round || ''}
            onChange={(e) => setRound(Number(e.target.value))}
          >
            <option value="">Select GP</option>
            {schedule.map((evt) => (
              <option key={evt.RoundNumber} value={evt.RoundNumber}>
                {evt.EventName}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-tab__row">
          <span className="settings-tab__label">Session</span>
          <div className="settings-tab__pills settings-tab__pills--wrap">
            {SESSION_TYPES.map(({ value, label }) => (
              <button
                key={value}
                className={`settings-tab__pill${sessionType === value ? ' settings-tab__pill--active' : ''}`}
                onClick={() => setSessionType(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          className="settings-tab__load-btn"
          disabled={!round || isLoading || loadingDataset}
          onClick={handleLoadDataset}
        >
          {loadingDataset ? 'Loading...' : 'Load Session'}
        </button>
      </section>

      {/* ── About ── */}
      <section className="settings-tab__section settings-tab__section--about">
        <div className="settings-tab__about-header">
          <img src="/f1-logo.png" alt="F1" className="settings-tab__about-logo" />
          <div>
            <h2 className="settings-tab__about-title">F1GA</h2>
            <p className="settings-tab__about-subtitle">F1 Grand-Prix Analysis</p>
          </div>
        </div>

        <div className="settings-tab__about-grid">
          <div className="settings-tab__about-item">
            <span className="settings-tab__about-key">Developer</span>
            <span className="settings-tab__about-val">Roberto Sorce</span>
          </div>
          <div className="settings-tab__about-item">
            <span className="settings-tab__about-key">University</span>
            <span className="settings-tab__about-val">Sapienza Universita di Roma</span>
          </div>
          <div className="settings-tab__about-item">
            <span className="settings-tab__about-key">Course</span>
            <span className="settings-tab__about-val">Visual Analytics</span>
          </div>
          <div className="settings-tab__about-item">
            <span className="settings-tab__about-key">Academic Year</span>
            <span className="settings-tab__about-val">2024 / 2025</span>
          </div>
          <div className="settings-tab__about-item">
            <span className="settings-tab__about-key">Version</span>
            <span className="settings-tab__about-val">1.0.0</span>
          </div>
        </div>

        <div className="settings-tab__about-section">
          <span className="settings-tab__about-key">Tech Stack</span>
          <div className="settings-tab__tech-tags">
            {TECH_STACK.map((t) => (
              <span key={t} className="settings-tab__tech-tag">{t}</span>
            ))}
          </div>
        </div>

        <div className="settings-tab__about-section">
          <span className="settings-tab__about-key">Data Sources</span>
          <p className="settings-tab__about-text">
            Telemetry data provided by <strong>FastF1</strong> (open-source F1 data library).
            AI-powered strategy analysis by <strong>Google Gemini</strong>.
          </p>
        </div>

        <p className="settings-tab__disclaimer">
          This project is for academic purposes only.
          Not affiliated with Formula 1, FIA, or any F1 team.
          All trademarks belong to their respective owners.
        </p>
      </section>
    </div>
  );
}
