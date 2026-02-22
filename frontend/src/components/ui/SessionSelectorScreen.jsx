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

export default function SessionSelectorScreen() {
  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);
  const sessionType = useF1Store((s) => s.sessionType);
  const schedule = useF1Store((s) => s.schedule);
  const isLoading = useF1Store((s) => s.isLoading);
  const drivers = useF1Store((s) => s.drivers);
  const previewDrivers = useF1Store((s) => s.previewDrivers);
  const previewDriversLoading = useF1Store((s) => s.previewDriversLoading);
  const preSelectedDrivers = useF1Store((s) => s.preSelectedDrivers);

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

        {/* Body: selector card + driver grid side by side */}
        <div className="session-screen__body">
          {/* Selector card */}
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
