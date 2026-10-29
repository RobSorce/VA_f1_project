import React, { useEffect, useState, useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { CHART_FONT, FLAG_COLORS, TEXT_COLORS, UI_COLORS, getDriverColor, withAlpha } from '../../utils/colors';
import { yearOptions } from '../../utils/seasons';
import { TRADEMARK_NOTICE } from '../../utils/brand';
import { useBackendOnlyText } from '../../utils/demoMode';
import Wordmark from './Wordmark';
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
  fontFamily: 'var(--font-primary)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

// The demo's "Requires the local backend" line under a disabled button
const backendNoteStyle = {
  fontSize: CHART_FONT.label,
  color: TEXT_COLORS.secondary,
  lineHeight: 1.4,
  margin: '-4px 0 0',
};

const mockSelectStyle = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  color: TEXT_COLORS.secondary,
  fontSize: CHART_FONT.data,
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

  // Seasons from GET /api/seasons (store.fetchSeasons, D15); the built-in
  // list until it answers or when the backend is offline
  const seasons = useF1Store((s) => s.seasons);
  const fetchSeasons = useF1Store((s) => s.fetchSeasons);
  useEffect(() => { fetchSeasons(); }, [fetchSeasons]);

  const [focusPick, setFocusPick] = useState('');
  const [driverSearch, setDriverSearch] = useState('');
  const [liveConnecting, setLiveConnecting] = useState(false);
  const [mockConnecting, setMockConnecting] = useState(false);
  // Static demo (utils/demoMode.js, the flag the model-only views read): live
  // timing and the mock replay need the local backend, so both buttons are
  // disabled and say so (Phase 9d G5)
  const backendOnly = useBackendOnlyText();

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
    if (backendOnly) return;
    setLiveConnecting(true);
    try {
      await enterLiveMode();
    } catch (_) { /* store handles error */ }
    setLiveConnecting(false);
  };

  const handleStartMock = async () => {
    if (!round || backendOnly) return;
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
        {/* Wordmark */}
        <div className="session-screen__brand">
          <h1 className="session-screen__title"><Wordmark size="hero" tagline /></h1>
          {/* Trade-mark notice (utils/brand.js): in sight without a scroll */}
          <p className="session-screen__notice">{TRADEMARK_NOTICE}</p>
        </div>

        {/* Body: live card + selector card + driver grid */}
        <div className="session-screen__body">
          {/* Live Session Card */}
          <div className="session-screen__card glass-card" style={liveCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: UI_COLORS.accent,
                boxShadow: `0 0 8px ${withAlpha(UI_COLORS.accent, 0.5)}`,
                animation: 'livePulse 1.5s ease-in-out infinite',
              }} />
              <span style={{
                fontFamily: 'var(--font-primary)',
                fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: TEXT_COLORS.primary,
              }}>
                Live Session
              </span>
            </div>

            <p style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.muted, lineHeight: 1.5, margin: 0 }}>
              Connect to the F1 live timing feed during an active session.
            </p>

            <button
              style={{
                ...liveBtnStyle,
                background: liveConnecting ? withAlpha(UI_COLORS.accent, 0.15) : `linear-gradient(135deg, ${UI_COLORS.accent} 0%, ${UI_COLORS.accentDark} 100%)`,
                color: TEXT_COLORS.primary,
                opacity: backendOnly ? 0.4 : liveConnecting ? 0.6 : 1,
                cursor: backendOnly ? 'not-allowed' : 'pointer',
              }}
              onClick={handleConnectLive}
              disabled={!!backendOnly || liveConnecting || isLoading}
              title={backendOnly ? `${backendOnly}: live timing` : undefined}
              aria-describedby={backendOnly ? 'session-live-backend-note' : undefined}
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
            {backendOnly && (
              <p id="session-live-backend-note" className="session-screen__backend-only" style={backendNoteStyle}>
                {backendOnly}: live timing.
              </p>
            )}

            <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />

            <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Mock Replay
            </span>
            <p style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, lineHeight: 1.4, margin: 0 }}>
              Simulate live timing from a cached session (select year & GP above first).
            </p>

            <button
              style={{
                ...liveBtnStyle,
                background: mockConnecting ? withAlpha(UI_COLORS.brush, 0.1) : withAlpha(UI_COLORS.brush, 0.15),
                border: `1px solid ${withAlpha(UI_COLORS.brush, 0.3)}`,
                color: UI_COLORS.brush,
                opacity: (backendOnly || !round || mockConnecting || isLoading) ? 0.4 : 1,
                cursor: backendOnly ? 'not-allowed' : 'pointer',
              }}
              onClick={handleStartMock}
              disabled={!!backendOnly || !round || mockConnecting || isLoading}
              title={backendOnly ? `${backendOnly}: the mock replay` : undefined}
              aria-describedby={backendOnly ? 'session-mock-backend-note' : undefined}
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
            {backendOnly && (
              <p id="session-mock-backend-note" className="session-screen__backend-only" style={backendNoteStyle}>
                {backendOnly}: the mock replay streams a cached race through it.
              </p>
            )}

            {error && (
              <div style={{
                fontSize: CHART_FONT.label, color: FLAG_COLORS.red, lineHeight: 1.3,
                padding: '6px 8px', borderRadius: 4,
                background: withAlpha(FLAG_COLORS.red, 0.08),
                border: `1px solid ${withAlpha(FLAG_COLORS.red, 0.15)}`,
              }}>
                {error}
              </div>
            )}
          </div>

          {/* Replay Selector card */}
          <div className="session-screen__card glass-card">
            {/* Header — mirrors the Live Session card's header so the two
                modes are visually sibling (H4 Consistency). */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, borderRadius: 4,
                  color: UI_COLORS.brush,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {/* Rewind / skip-back glyph — visual counterpart to the live pulse */}
                  <polygon points="19 20 9 12 19 4 19 20" />
                  <line x1="5" y1="19" x2="5" y2="5" />
                </svg>
              </span>
              <span style={{
                fontFamily: 'var(--font-primary)',
                fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: TEXT_COLORS.primary,
              }}>
                Session Playback
              </span>
            </div>
            <p style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.muted, lineHeight: 1.5, margin: '0 0 6px' }}>
              Load any past race, qualifying, or practice for full analysis — lap times, strategy, telemetry, predictions.
            </p>

            {/* Year */}
            <div className="session-screen__field">
              <label className="session-screen__label">Season</label>
              <span className="session-screen__field-hint">Year of the F1 Championship</span>
              <select
                className="session-screen__select"
                value={year}
                onChange={handleYearChange}
              >
                {yearOptions(seasons, year).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            {/* Grand Prix */}
            <div className="session-screen__field">
              <label className="session-screen__label">Grand Prix</label>
              <span className="session-screen__field-hint">Pick from the calendar — cached races load instantly</span>
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
              <span className="session-screen__field-hint">Race, Qualifying, Sprint, or free practice (FP1-3)</span>
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
              <span className="session-screen__field-hint">Auto-highlights this driver across every panel once loaded</span>
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

        {/* ── Getting started — always visible 3-step card ─────── */}
        <div className="session-screen__getting-started">
          <ol className="session-screen__getting-started-steps">
            <li>
              <span className="session-screen__step-num">1</span>
              <span>Pick a <strong>Season</strong> and <strong>Grand Prix</strong> from the selector above.</span>
            </li>
            <li>
              <span className="session-screen__step-num">2</span>
              <span><em>Optional</em> — pick a <strong>Focus Driver</strong> to auto-highlight across every panel.</span>
            </li>
            <li>
              <span className="session-screen__step-num">3</span>
              <span>Hit <strong>ENTER SESSION</strong>.</span>
            </li>
          </ol>
          <div className="session-screen__shortcut-hints">
            <span>Inside the dashboard</span>
            <kbd>?</kbd><span>shortcuts</span>
            <kbd>Ctrl+K</kbd><span>command palette</span>
            <span className="session-screen__hint-icon" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <circle cx="12" cy="16" r="0.6" fill="currentColor" />
              </svg>
            </span>
            <span>on any chart for help</span>
          </div>
        </div>
      </div>
    </div>
  );
}
