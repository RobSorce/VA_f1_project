import React, { useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import SessionSelector from './SessionSelector';
import SessionMenu from './SessionMenu';
import PanelToggleBar from '../layout/PanelToggleBar';

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const isLoading = useF1Store((s) => s.isLoading);
  const sessionData = useF1Store((s) => s.sessionData);
  const sessionType = useF1Store((s) => s.sessionType);

  const eventName = sessionData?.circuit_info?.event_name || '';

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
          {sessionType && <span className="status-pill">{sessionType}</span>}
          <div className="status-indicator" style={{ fontSize: 'var(--font-size-xs)', gap: '4px', display: 'flex', alignItems: 'center' }}>
            <span
              className="status-dot"
              style={isLoading ? { backgroundColor: 'var(--color-accent-warning)', animation: 'none' } : {}}
            />
            <span style={{ color: 'var(--color-text-muted)' }}>
              {isLoading ? 'Loading...' : 'Ready'}
            </span>
          </div>
        </div>
      </header>

      <SessionMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
