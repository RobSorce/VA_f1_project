import React, { useEffect, useState, useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';

const YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];
const SESSION_TYPES = [
  { value: 'R', label: 'Race' },
  { value: 'Q', label: 'Qualifying' },
  { value: 'S', label: 'Sprint' },
  { value: 'FP1', label: 'FP1' },
  { value: 'FP2', label: 'FP2' },
  { value: 'FP3', label: 'FP3' },
];

const liveCardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 24px',
  minWidth: 260,
  maxWidth: 320,
};

const liveBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '10px 20px',
  border: 'none',
  borderRadius: 8,
  fontFamily: "'Formula1', 'Titillium Web', sans-serif",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

const mockSelectStyle = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  color: '#ccc',
  fontSize: 11,
  padding: '6px 10px',
  outline: 'none',
  fontFamily: "'JetBrains Mono', monospace",
  width: '100%',
};

export default function SessionSelectorScreen() {
  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);
  const sessionType = useF1Store((s) => s.sessionType);
  const schedule = useF1Store((s) => s.schedule);
  const isLoading = useF1Store((s) => s.isLoading);
  const error = useF1Store((s) => s.error);
  const drivers = useF1Store((s) => s.drivers);
  const previewDrivers = useF1Store((s) => s.previewDrivers);
  const previewDriversLoading = useF1Store((s) => s.previewDriversLoading);
  const preSelectedDrivers = useF1Store((s) => s.preSelectedDrivers);
  const enterLiveMode = useF1Store((s) => s.enterLiveMode);

  const setYear = useF1Store((s) => s.setYear);
  const setRound = useF1Store((s) => s.setRound);
  const setSessionType = useF1Store((s) => s.setSessionType);
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const loadSession = useF1Store((s) => s.loadSession);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const fetchDriversPreview = useF1Store((s) => s.fetchDriversPreview);
  const togglePreSelectedDriver = useF1Store((s) => s.togglePreSelectedDriver);
  const setPreSelectedDrivers = useF1Store((s) => s.setPreSelectedDrivers);

  const [focusPick, setFocusPick] = useState('');
  const [driverSearch, setDriverSearch] = useState('');
  const [liveConnecting, setLiveConnecting] = useState(false);
  const [mockConnecting, setMockConnecting] = useState(false);

  useEffect(() => {
    fetchSchedule(year);
  }, [year, fetchSchedule]);

  // Fetch driver preview when round changes
  useEffect(() => {
    if (year && round) {
      fetchDriversPreview(year, round);
    }
  }, [year, round, fetchDriversPreview]);

  const handleYearChange = (e) => {
    setYear(Number(e.target.value));
    setRound(null);
  };

  const handleLoad = () => {
    if (!round) return;
    loadSession();
    if (focusPick) {
      setFocusDriver(focusPick);
    }
  };

  const handleConnectLive = async () => {
    setLiveConnecting(true);
    try {
      await enterLiveMode();
    } catch (_) { /* store handles error */ }
    setLiveConnecting(false);
  };

  const handleStartMock = async () => {
    if (!round) return;
    setMockConnecting(true);
    try {
      await enterLiveMode(year, round, 10);
    } catch (_) { /* store handles error */ }
    setMockConnecting(false);
  };

  const selectedEvent = schedule.find((e) => e.RoundNumber === round);

  // Use preview drivers for focus driver dropdown + grid
  const availableDrivers = previewDrivers.length > 0 ? previewDrivers : drivers;

  // Filter drivers by search
  const filteredDrivers = useMemo(() => {
    if (!driverSearch.trim()) return availableDrivers;
    const q = driverSearch.toLowerCase();
    return availableDrivers.filter((d) =>
      (d.Abbreviation || '').toLowerCase().includes(q) ||
      (d.FullName || d.LastName || '').toLowerCase().includes(q) ||
      (d.TeamName || '').toLowerCase().includes(q)
    );
  }, [availableDrivers, driverSearch]);

  const handleSelectAll = () => {
    setPreSelectedDrivers(availableDrivers.map((d) => d.Abbreviation));
  };

  const handleClearAll = () => {
    setPreSelectedDrivers([]);
  };

  const showGrid = round && (previewDrivers.length > 0 || previewDriversLoading);

  return (
    <div className="session-screen">
      {/* Background glow */}
      <div className="session-screen__glow" />

      <div className="session-screen__content">
        {/* Logo */}
        <div className="session-screen__logo">
          <img src="/f1-logo.png" alt="F1" className="session-screen__logo-img" />
          <h1 className="session-screen__title">RACE CONTROL</h1>
          <p className="session-screen__subtitle">Visual Analytics Dashboard</p>
        </div>

        {/* Body: live card + selector card + driver grid */}
        <div className="session-screen__body">
          {/* Live Session Card */}
          <div className="session-screen__card glass-card" style={liveCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: '#e10600',
                boxShadow: '0 0 8px rgba(225,6,0,0.5)',
                animation: 'livePulse 1.5s ease-in-out infinite',
              }} />
              <span style={{
                fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: '#e0e0e0',
              }}>
                Live Session
              </span>
            </div>

            <p style={{ fontSize: 11, color: '#7a7f9a', lineHeight: 1.5, margin: 0 }}>
              Connect to the F1 live timing feed during an active session.
            </p>

            <button
              style={{
                ...liveBtnStyle,
                background: liveConnecting ? 'rgba(225,6,0,0.15)' : 'linear-gradient(135deg, #e10600 0%, #c00 100%)',
                color: '#fff',
                opacity: liveConnecting ? 0.6 : 1,
              }}
              onClick={handleConnectLive}
              disabled={liveConnecting || isLoading}
            >
              {liveConnecting ? (
                <span className="session-screen__spinner" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
              {liveConnecting ? 'CONNECTING...' : 'CONNECT LIVE'}
            </button>

            <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />

            <span style={{ fontSize: 10, color: '#555', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Mock Replay
            </span>
            <p style={{ fontSize: 10, color: '#666', lineHeight: 1.4, margin: 0 }}>
              Simulate live timing from a cached session (select year & GP above first).
            </p>

            <button
              style={{
                ...liveBtnStyle,
                background: mockConnecting ? 'rgba(66,133,244,0.1)' : 'rgba(66,133,244,0.15)',
                border: '1px solid rgba(66,133,244,0.3)',
                color: '#8ab4f8',
                opacity: (!round || mockConnecting || isLoading) ? 0.4 : 1,
              }}
              onClick={handleStartMock}
              disabled={!round || mockConnecting || isLoading}
            >
              {mockConnecting ? (
                <span className="session-screen__spinner" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
              {mockConnecting ? 'STARTING...' : 'START MOCK LIVE'}
            </button>

            {error && (
              <div style={{
                fontSize: 10, color: '#f87171', lineHeight: 1.3,
                padding: '6px 8px', borderRadius: 4,
                background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.15)',
              }}>
                {error}
              </div>
            )}
          </div>

          {/* Replay Selector card */}
          <div className="session-screen__card glass-card">
            {/* Year */}
            <div className="session-screen__field">
              <label className="session-screen__label">Season</label>
              <select
                className="session-screen__select"
                value={year}
                onChange={handleYearChange}
              >
                {YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            {/* Grand Prix */}
            <div className="session-screen__field">
              <label className="session-screen__label">Grand Prix</label>
              <select
                className="session-screen__select"
                value={round || ''}
                onChange={(e) => setRound(Number(e.target.value))}
              >
                <option value="">Select Race...</option>
                {schedule.map((evt) => (
                  <option key={evt.RoundNumber} value={evt.RoundNumber}>
                    R{evt.RoundNumber} — {evt.EventName}
                  </option>
                ))}
              </select>
            </div>

            {/* Session Type */}
            <div className="session-screen__field">
              <label className="session-screen__label">Session</label>
              <div className="session-screen__pills">
                {SESSION_TYPES.map((st) => (
                  <button
                    key={st.value}
                    className={`session-screen__pill${sessionType === st.value ? ' session-screen__pill--active' : ''}`}
                    onClick={() => setSessionType(st.value)}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Focus Driver */}
            <div className="session-screen__field">
              <label className="session-screen__label">Focus Driver (optional)</label>
              <select
                className="session-screen__select"
                value={focusPick}
                onChange={(e) => setFocusPick(e.target.value)}
              >
                <option value="">All Drivers</option>
                {availableDrivers.map((d) => (
                  <option key={d.Abbreviation} value={d.Abbreviation}>
                    {d.Abbreviation} — {d.FullName || d.LastName} ({d.TeamName})
                  </option>
                ))}
              </select>
            </div>

            {/* Load button */}
            <button
              className="session-screen__btn"
              onClick={handleLoad}
              disabled={!round || isLoading}
            >
              {isLoading ? (
                <span className="session-screen__spinner" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
              {isLoading ? 'Loading Session...' : 'ENTER SESSION'}
            </button>

            {selectedEvent && (
              <div className="session-screen__summary">
                {year} — {selectedEvent.EventName} — {sessionType}
              </div>
            )}
          </div>

          {/* Driver Selection Grid */}
          {showGrid && (
            <div className="session-screen__drivers glass-card">
              <div className="driver-grid__header">
                <span className="driver-grid__title">DRIVERS</span>
                <span className="driver-grid__counter">
                  {preSelectedDrivers.length}/{availableDrivers.length}
                </span>
              </div>

              <input
                className="driver-grid__search-input"
                type="text"
                placeholder="Search drivers..."
                value={driverSearch}
                onChange={(e) => setDriverSearch(e.target.value)}
              />

              <div className="driver-grid__list">
                {previewDriversLoading ? (
                  <div className="driver-grid__loading">Loading drivers...</div>
                ) : (
                  filteredDrivers.map((d) => {
                    const selected = preSelectedDrivers.includes(d.Abbreviation);
                    const teamColor = getDriverColor(d.Abbreviation);
                    return (
                      <div
                        key={d.Abbreviation}
                        className={`driver-grid__card${selected ? ' driver-grid__card--selected' : ''}`}
                        style={{ borderLeftColor: teamColor }}
                        onClick={() => togglePreSelectedDriver(d.Abbreviation)}
                      >
                        <span className="driver-grid__card-name">{d.Abbreviation}</span>
                        <span className="driver-grid__card-team">{d.FullName || d.LastName}</span>
                        <span className="driver-grid__card-number">#{d.DriverNumber}</span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="driver-grid__actions">
                <button className="driver-grid__action-btn" onClick={handleSelectAll}>
                  Select All
                </button>
                <button className="driver-grid__action-btn" onClick={handleClearAll}>
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
