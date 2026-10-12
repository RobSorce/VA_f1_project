import React, { useState } from 'react';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import SessionSelector from './SessionSelector';
import SessionMenu from './SessionMenu';
import PanelToggleBar from '../layout/PanelToggleBar';

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const isLoading = useF1Store((s) => s.isLoading);
  const sessionData = useF1Store((s) => s.sessionData);
  const sessionType = useF1Store(loadedSessionTypeOf); // the loaded session, not the pill
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const qualiSegment = useF1Store((s) => s.qualiSegment);
  const qualiSegments = useF1Store((s) => s.qualiSegments);
  const setQualiSegment = useF1Store((s) => s.setQualiSegment);
  const isLoadingFrames = useF1Store((s) => s.isLoadingFrames);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const liveConnected = useF1Store((s) => s.liveConnected);
  const liveSessionInfo = useF1Store((s) => s.liveSessionInfo);

  const eventName = isLiveMode
    ? liveSessionInfo?.event_name || 'Live Session'
    : sessionData?.circuit_info?.event_name || '';

  return (
    <>
      <header className="app-header">
        <div className="header-left">
          <button
            className="session-menu__hamburger"
            onClick={() => setMenuOpen(true)}
            aria-label="Open session menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="logo">
            <img
              src="/f1-logo.png"
              alt="F1"
              className="logo-f1-img"
            />
            <span className="logo-text">Race Control</span>
          </div>
        </div>

        <div className="header-center">
          <SessionSelector />
          {eventName && (
            <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
              {eventName}
            </span>
          )}
        </div>

        <div className="header-right">
          <PanelToggleBar />
          {sessionType === 'Q' && sessionData ? (
            <div className="header-quali-pills">
              {['Q1', 'Q2', 'Q3'].map((seg) => {
                const segReady = qualiSegments?.[seg];
                const isActive = isQualifyingReplay && qualiSegment === seg;
                return (
                  <button
                    key={seg}
                    className={`header-quali-pill ${isActive ? 'active' : ''} ${isLoadingFrames ? 'loading' : ''}`}
                    disabled={!segReady}
                    onClick={() => setQualiSegment(seg)}
                    title={segReady ? `Switch to ${seg}` : isLoadingFrames ? 'Loading replay...' : `${seg} not available`}
                  >
                    {seg}
                  </button>
                );
              })}
              {isLoadingFrames && (
                <span style={{ fontSize: '10px', color: 'var(--color-accent-warning)', marginLeft: '4px' }}>
                  Loading...
                </span>
              )}
            </div>
          ) : sessionType ? (
            <span className="status-pill">{sessionType}</span>
          ) : null}
          <div className="status-indicator" style={{ fontSize: 'var(--font-size-xs)', gap: '4px', display: 'flex', alignItems: 'center' }}>
            {isLiveMode && liveConnected ? (
              <>
                <span className="live-pulse active" />
                <span className="live-badge">LIVE</span>
              </>
            ) : (
              <>
                <span
                  className="status-dot"
                  style={isLoading ? { backgroundColor: 'var(--color-accent-warning)', animation: 'none' } : {}}
                />
                <span style={{ color: 'var(--color-text-muted)' }}>
                  {isLoading ? 'Loading...' : 'Ready'}
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      <SessionMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
