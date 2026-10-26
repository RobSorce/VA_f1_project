import React from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { getChartHelp, CHART_HELP } from '../../utils/chartHelp';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';

/**
 * Modal help overlay — single source of in-app help, driven by
 * `state.helpTabId` (the tabId whose docs to show, or null).
 *
 * Triggered from:
 *   - The `(i)` button in each `<OverlayPanel>` header.
 *   - Settings → Help & Reference entries.
 *
 * Shows the structured entry from `utils/chartHelp.js`:
 *   summary · how-to-read · limitations · see-also · docs link.
 */
export default function HelpOverlay() {
  const helpTabId = useF1Store((s) => s.helpTabId);
  const storedTitle = useF1Store((s) => s.helpTitle);
  const closeHelp = useF1Store((s) => s.closeHelp);
  const openHelp = useF1Store((s) => s.openHelp);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const focusOverlay = useF1Store((s) => s.focusOverlay);
  const openOverlays = useF1Store((s) => s.openOverlays);

  // Escape closes the help when it is the topmost transient element
  // (utils/escapeStack.js)
  useEscapeLayer(!!helpTabId, closeHelp);

  if (!helpTabId) return null;
  const help = getChartHelp(helpTabId);
  if (!help) return null;

  // Resolution order: the registry's `title` (authoritative) → whatever
  // the caller passed through the store → capitalised tabId fallback.
  const title = help.title || storedTitle || (helpTabId.charAt(0).toUpperCase() + helpTabId.slice(1));

  const openRelated = (id) => {
    // Swap the help view to the related chart's entry (staying inside
    // the help overlay); the user can close when done.
    if (CHART_HELP[id]) openHelp(id);
  };

  const openAndClose = (helpId) => {
    // Open the target chart and dismiss help. A help entry of a panel with
    // no tab of its own (e.g. 'crossrace', inside Analytics) names the tab
    // that holds it (openTabId).
    const id = CHART_HELP[helpId]?.openTabId || helpId;
    closeHelp();
    if (openOverlays.includes(id)) focusOverlay(id);
    else setActiveTab(id);
  };

  const overlay = (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label={`Help for ${title}`}>
      <div className="help-overlay__backdrop" onClick={closeHelp} />
      <div className="help-overlay__panel">
        <div className="help-overlay__header">
          <div className="help-overlay__title">
            <span className="help-overlay__eyebrow">Help</span>
            <span className="help-overlay__chart-name">{title}</span>
          </div>
          <button
            type="button"
            className="help-overlay__close"
            aria-label="Close help"
            onClick={closeHelp}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="help-overlay__body">
          {/* Summary — the one-line "what question does this answer" */}
          <p className="help-overlay__summary">{help.summary}</p>

          {/* How to read */}
          {help.howToRead?.length > 0 && (
            <section className="help-overlay__section">
              <h3 className="help-overlay__section-title">How to read</h3>
              <ul className="help-overlay__list">
                {help.howToRead.map((item, i) => (
                  <li key={i} dangerouslySetInnerHTML={{ __html: formatInline(item) }} />
                ))}
              </ul>
            </section>
          )}

          {/* Limitations */}
          {help.limitations?.length > 0 && (
            <section className="help-overlay__section">
              <h3 className="help-overlay__section-title help-overlay__section-title--warn">Limitations</h3>
              <ul className="help-overlay__list">
                {help.limitations.map((item, i) => (
                  <li key={i} dangerouslySetInnerHTML={{ __html: formatInline(item) }} />
                ))}
              </ul>
            </section>
          )}

          {/* See also */}
          {help.seeAlso?.length > 0 && (
            <section className="help-overlay__section">
              <h3 className="help-overlay__section-title">See also</h3>
              <div className="help-overlay__see-also">
                {help.seeAlso.map(({ tabId, label }) => (
                  <div key={tabId} className="help-overlay__see-also-row">
                    <button
                      type="button"
                      className="help-overlay__see-also-open"
                      onClick={() => openAndClose(tabId)}
                    >
                      Open →
                    </button>
                    <button
                      type="button"
                      className="help-overlay__see-also-help"
                      onClick={() => openRelated(tabId)}
                    >
                      {label}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Docs link */}
          {help.docsHref && (
            <section className="help-overlay__section">
              <a
                className="help-overlay__docs-link"
                href={help.docsHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Full methodology (opens external) ↗
              </a>
            </section>
          )}
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(overlay, document.body);
}

/** Very small Markdown-ish: `**bold**` → <strong>, `` `code` `` → <code>. */
function formatInline(text) {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
