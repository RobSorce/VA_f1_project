import React from 'react';
import { useF1Store } from '../../store/useF1Store';

export default function OverlayPanel({ title, children }) {
  const setActiveTab = useF1Store((s) => s.setActiveTab);

  return (
    <div className="overlay-panel">
      <div className="overlay-panel__header">
        <span className="overlay-panel__title">{title}</span>
        <button
          className="overlay-panel__close"
          onClick={() => setActiveTab('charts')}
          aria-label="Close panel"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="overlay-panel__content">
        {children}
      </div>
    </div>
  );
}
