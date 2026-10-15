import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import * as api from '../../utils/apiClient';
import { yearOptions } from '../../utils/seasons';
import { sessionSwitchMessage } from '../../utils/sessionSwitchWarning';

const SESSION_TYPES = [
  { value: 'FP1', label: 'FP1' },
  { value: 'FP2', label: 'FP2' },
  { value: 'FP3', label: 'FP3' },
  { value: 'Q', label: 'Qualifying' },
  { value: 'S', label: 'Sprint' },
  { value: 'R', label: 'Race' },
];


function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function isSprintWeekend(event) {
  if (!event) return false;
  const fmt = (event.EventFormat || '').toLowerCase();
  return fmt.includes('sprint') || fmt === 'sprint_shootout' || fmt === 'sprint_qualifying';
}

export default function SessionMenu({ isOpen, onClose }) {
  const menuRef = useRef(null);

  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);
  const sessionType = useF1Store((s) => s.sessionType);
  const schedule = useF1Store((s) => s.schedule);
  const isLoading = useF1Store((s) => s.isLoading);
  const error = useF1Store((s) => s.error);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const liveConnected = useF1Store((s) => s.liveConnected);
  const liveSessionInfo = useF1Store((s) => s.liveSessionInfo);
  const enterLiveMode = useF1Store((s) => s.enterLiveMode);
  const exitLiveMode = useF1Store((s) => s.exitLiveMode);

  const setYear = useF1Store((s) => s.setYear);
  const setRound = useF1Store((s) => s.setRound);
  const setSessionType = useF1Store((s) => s.setSessionType);
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const loadSession = useF1Store((s) => s.loadSession);
  // Seasons from GET /api/seasons (store.fetchSeasons, D15); the built-in
  // list until it answers or when the backend is offline
  const seasons = useF1Store((s) => s.seasons);
  const fetchSeasons = useF1Store((s) => s.fetchSeasons);
  useEffect(() => { fetchSeasons(); }, [fetchSeasons]);

  // Live timing state
  const [liveStatus, setLiveStatus] = useState(null);
  const [mockSessions, setMockSessions] = useState([]);
  const [showMock, setShowMock] = useState(false);
  const [mockSpeed, setMockSpeed] = useState(10);

  // Poll live status when menu is open — auto-connect SignalR on first check
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const check = async () => {
      try {
        let status = await api.getLiveStatus();
        // If not active, try connecting SignalR (it may just not be connected yet)
        if (!status.active) {
          try {
            await api.connectSignalR();
            await new Promise((r) => setTimeout(r, 3000));
            status = await api.getLiveStatus();
          } catch (_) { /* ignore */ }
        }
        if (!cancelled) setLiveStatus(status);
      } catch (_) { /* ignore */ }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isOpen]);

  // Load mock sessions list
  useEffect(() => {
    if (!showMock) return;
    api.getMockSessions().then((r) => setMockSessions(r.sessions || [])).catch(() => {});
  }, [showMock]);

  const handleConnectLive = async () => {
    await enterLiveMode();
    onClose();
  };

  const handleDisconnectLive = async () => {
    await exitLiveMode();
  };

  const handleStartMock = async (mockYear, mockRound) => {
    await enterLiveMode(mockYear, mockRound, mockSpeed);
    onClose();
  };

  // Close on Escape key
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    },
    [isOpen, onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Scroll selected race into view when menu opens
  useEffect(() => {
    if (isOpen && round && menuRef.current) {
      const selected = menuRef.current.querySelector('.session-menu__race-item--selected');
      if (selected) {
        selected.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [isOpen, round]);

  const handleYearChange = (e) => {
    const newYear = Number(e.target.value);
    setYear(newYear);
    setRound(null);
    fetchSchedule(newYear);
  };

  const handleRaceSelect = (roundNumber) => {
    setRound(roundNumber);
  };

  const handleSessionTypeSelect = (type) => {
    setSessionType(type);
  };

  const handleLoad = () => {
    if (!round) return;
    // Tell the user what the switch keeps (panels, lap ranges, the PCA
    // lasso, the focus) and what it clears (chat, simulator plan, forecast)
    // before loading (H5/V5.2; utils/sessionSwitchWarning.js)
    const msg = sessionSwitchMessage(useF1Store.getState());
    if (msg) {
      // Use native confirm to keep the gate impossible to miss. The store
      // toast is non-blocking; session switching clears analytical state.
      // eslint-disable-next-line no-alert
      if (!window.confirm(msg)) return;
    }
    loadSession();
    onClose();
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const selectedEvent = schedule.find((evt) => evt.RoundNumber === round);
  const hasSprint = selectedEvent ? isSprintWeekend(selectedEvent) : false;
  const availableSessionTypes = hasSprint
    ? SESSION_TYPES
    : SESSION_TYPES.filter((st) => st.value !== 'S');

  return (
    <>
      {/* Overlay backdrop */}
      <div
        className={`session-menu-overlay${isOpen ? ' open' : ''}`}
        onClick={handleOverlayClick}
        aria-hidden={!isOpen}
      />

      {/* Slide-out menu */}
      <nav
        ref={menuRef}
        className={`session-menu${isOpen ? ' open' : ''}`}
        role="dialog"
        aria-label="Session selector menu"
        aria-hidden={!isOpen}
      >
        {/* Title area */}
        <div className="session-menu__header">
          <div className="session-menu__title">
            <span className="session-menu__title-accent" />
            <span className="session-menu__title-text">Race Control</span>
          </div>
          <button
            className="session-menu__close-btn"
            onClick={onClose}
            aria-label="Close menu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="session-menu__error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* ── Live Timing Section ─────────────────────────────── */}
        <div className="session-menu__section session-menu__live-section">
          <label className="session-menu__label">
            <span className={`live-pulse${isLiveMode && liveConnected ? ' active' : ''}`} />
            Live Timing
          </label>

          {isLiveMode ? (
            <div className="session-menu__live-status">
              <div className="session-menu__live-info">
                <span className="live-badge">LIVE</span>
                <span>{liveSessionInfo?.event_name || 'Connected'}</span>
                <span className="session-menu__live-detail">
                  {liveSessionInfo?.session_type || ''}
                </span>
              </div>
              <button
                className="session-menu__pill session-menu__pill--danger"
                onClick={handleDisconnectLive}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="session-menu__live-actions">
              {liveStatus?.active ? (
                <button
                  className="session-menu__load-btn session-menu__load-btn--live"
                  onClick={handleConnectLive}
                  disabled={isLoading}
                >
                  <span className="live-pulse active" />
                  Connect to Live Session
                </button>
              ) : (
                <div className="session-menu__live-inactive">
                  No active F1 session
                </div>
              )}
              <button
                className="session-menu__mock-toggle"
                onClick={() => setShowMock(!showMock)}
              >
                {showMock ? 'Hide' : 'Show'} Mock Replay
              </button>
              {showMock && (
                <div className="session-menu__mock-section">
                  <div className="session-menu__mock-speed">
                    <label>Speed: {mockSpeed}x</label>
                    <input
                      type="range"
                      min="1"
                      max="50"
                      value={mockSpeed}
                      onChange={(e) => setMockSpeed(Number(e.target.value))}
                    />
                  </div>
                  <div className="session-menu__mock-list">
                    {mockSessions.length === 0 && (
                      <span className="session-menu__empty">No cached sessions</span>
                    )}
                    {mockSessions.map((s) => (
                      <button
                        key={`${s.year}-${s.round}`}
                        className="session-menu__race-item"
                        onClick={() => handleStartMock(s.year, s.round)}
                      >
                        <span className="session-menu__race-round">{s.round}</span>
                        <span>{s.year} Round {s.round}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="session-menu__divider" />

        {/* Season selector */}
        <div className="session-menu__section">
          <label className="session-menu__label">Season</label>
          <select
            className="session-menu__select"
            value={year}
            onChange={handleYearChange}
          >
            {yearOptions(seasons, year).map((y) => (
              <option key={y} value={y}>
                {y} Season
              </option>
            ))}
          </select>
        </div>

        {/* Race calendar */}
        <div className="session-menu__section session-menu__section--flex">
          <label className="session-menu__label">Race Calendar</label>
          <div className="session-menu__race-list">
            {schedule.length === 0 && (
              <div className="session-menu__empty">
                No races available for {year}
              </div>
            )}
            {schedule.map((evt) => {
              const isSprint = isSprintWeekend(evt);
              const isSelected = evt.RoundNumber === round;
              return (
                <button
                  key={evt.RoundNumber}
                  className={`session-menu__race-item${isSelected ? ' session-menu__race-item--selected' : ''}`}
                  onClick={() => handleRaceSelect(evt.RoundNumber)}
                >
                  <span className="session-menu__race-round">
                    {evt.RoundNumber}
                  </span>
                  <div className="session-menu__race-info">
                    <span className="session-menu__race-name">
                      {evt.EventName}
                      {isSprint && (
                        <span className="session-menu__sprint-badge">SPRINT</span>
                      )}
                    </span>
                    <span className="session-menu__race-detail">
                      {evt.Country}{evt.EventDate ? ` \u2022 ${formatDate(evt.EventDate)}` : ''}
                    </span>
                  </div>
                  {isSelected && (
                    <svg className="session-menu__check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Session type selector */}
        {round && (
          <div className="session-menu__section">
            <label className="session-menu__label">Session Type</label>
            <div className="session-menu__pills">
              {availableSessionTypes.map((st) => (
                <button
                  key={st.value}
                  className={`session-menu__pill${sessionType === st.value ? ' session-menu__pill--active' : ''}`}
                  onClick={() => handleSessionTypeSelect(st.value)}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Load session button */}
        <div className="session-menu__section session-menu__section--footer">
          <button
            className="session-menu__load-btn"
            onClick={handleLoad}
            disabled={!round || isLoading}
          >
            {isLoading ? (
              <>
                <span className="session-menu__spinner" />
                Loading Session...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                Load Session
              </>
            )}
          </button>
          {round && selectedEvent && (
            <div className="session-menu__selection-summary">
              {year} R{round} &mdash; {selectedEvent.EventName} &mdash; {sessionType}
            </div>
          )}
        </div>
      </nav>
    </>
  );
}
