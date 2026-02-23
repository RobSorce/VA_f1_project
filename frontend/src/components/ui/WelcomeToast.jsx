import React, { useState, useEffect, useCallback } from 'react';
import { modKey } from '../CommandPalette/commandRegistry';

const STORAGE_KEY = 'f1-onboarded';

export default function WelcomeToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    // Small delay so the app loads first
    const show = setTimeout(() => setVisible(true), 1200);
    // Auto-dismiss after 10 seconds
    const hide = setTimeout(() => dismiss(), 11200);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, '1');
  }, []);

  if (!visible) return null;

  return (
    <div className="welcome-toast" onClick={dismiss}>
      <div className="welcome-toast__content">
        <span className="welcome-toast__text">
          Press <kbd className="welcome-toast__kbd">/</kbd> to search,{' '}
          <kbd className="welcome-toast__kbd">{modKey}K</kbd> for commands,{' '}
          <kbd className="welcome-toast__kbd">?</kbd> for all shortcuts
        </span>
        <button className="welcome-toast__close" onClick={dismiss} aria-label="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
