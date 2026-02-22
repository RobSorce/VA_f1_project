import React, { useState } from 'react';
import { useF1Store } from '../../store/useF1Store';

export default function OverlayPanel({ title, tabId, children }) {
  const closeOverlay = useF1Store((s) => s.closeOverlay);
  const [maximized, setMaximized] = useState(false);

  return (
    <div className={`overlay-panel${maximized ? ' overlay-panel--maximized' : ''}`}>
      <div className="overlay-panel__header">
        <span className="overlay-panel__title">{title}</span>
        <div className="overlay-panel__controls">
          {/* Maximize / Restore */}
          <button
            className="overlay-panel__btn"
            onClick={() => setMaximized((m) => !m)}
            aria-label={maximized ? 'Restore panel' : 'Maximize panel'}
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="7" width="14" height="14" rx="2" />
                <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            )}
          </button>
          {/* Close */}
          <button
            className="overlay-panel__btn overlay-panel__btn--close"
            onClick={() => closeOverlay(tabId)}
            aria-label="Close panel"
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="overlay-panel__content">
        {children}
      </div>
    </div>
  );
}
