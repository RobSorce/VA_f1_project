import React, { useState } from 'react';

/**
 * Inline "Couldn't fetch — Retry" pane (H9/V9.2). Shown inside panels whose
 * fetch has failed. `onRetry` is awaited; while running, the button shows
 * a spinner so users don't click twice.
 */
export default function RetryPanel({ title = 'Couldn\'t load data', message, onRetry }) {
  const [busy, setBusy] = useState(false);
  const handleClick = async () => {
    if (busy || !onRetry) return;
    setBusy(true);
    try { await onRetry(); } finally { setBusy(false); }
  };
  return (
    <div className="retry-panel" role="alert">
      <svg className="retry-panel__icon" width="24" height="24" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <circle cx="12" cy="16" r="0.6" fill="currentColor" />
      </svg>
      <div className="retry-panel__text">
        <div className="retry-panel__title">{title}</div>
        {message && <div className="retry-panel__message">{message}</div>}
      </div>
      {onRetry && (
        <button
          type="button"
          className="retry-panel__btn"
          onClick={handleClick}
          disabled={busy}
        >
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
