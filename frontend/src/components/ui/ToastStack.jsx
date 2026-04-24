import React from 'react';
import { useF1Store } from '../../store/useF1Store';

/**
 * Global toast / notification stack.
 *
 * Reads `state.toasts` from the Zustand store. Each toast:
 *   { id, kind: 'info'|'warn'|'error'|'undo', message, action?, actionLabel? }
 *
 * Pushed via `pushToast`, dismissed via `dismissToast` or auto-timeout.
 * Used by: backend-down banner (H1/V1.1), dock-remove undo (H3/V3.1, V5.1),
 * dock-reset undo (H3/V3.2), reconnect toast, etc.
 */
export default function ToastStack() {
  const toasts = useF1Store((s) => s.toasts);
  const dismissToast = useF1Store((s) => s.dismissToast);

  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind || 'info'}`}>
          <span className="toast__message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                try { t.action(); } catch { /* no-op */ }
                dismissToast(t.id);
              }}
            >
              {t.actionLabel || 'Undo'}
            </button>
          )}
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(t.id)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
