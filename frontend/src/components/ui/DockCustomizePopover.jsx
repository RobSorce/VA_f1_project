import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { viewKeyHint } from '../../hooks/useKeyboardShortcuts';
import { SLOT_OPTIONS, CATEGORY_ORDER, CATEGORY_LABELS } from '../../utils/slotOptions';

const POPOVER_WIDTH = 360;
const EDGE_PAD = 12;

/**
 * Inline "Customize dock" popover — opened from the dock context menu.
 * Lets the user toggle any panel into / out of the bottom dock without
 * leaving the dashboard for the Settings overlay (H7 efficiency).
 *
 * Same logic as Settings → Dock section, but in a tighter popover that
 * appears near the dock itself.
 */
export default function DockCustomizePopover({ anchorRect, onClose }) {
  const popoverRef = useRef(null);
  const dockItems = useF1Store((s) => s.dockItems);
  const addDockItem = useF1Store((s) => s.addDockItem);
  const removeDockItem = useF1Store((s) => s.removeDockItem);
  const resetDockItems = useF1Store((s) => s.resetDockItems);
  const showDashboard = useF1Store((s) => s.showDashboard);
  const setShowDashboard = useF1Store((s) => s.setShowDashboard);

  const [query, setQuery] = useState('');

  // Hide-dock toggle. When the dock is visible the button hides it; when
  // already hidden (the popover is reachable via the 3 px peek + right-click
  // on a revealed dock item) the same button restores it.
  const handleToggleDock = () => {
    setShowDashboard(!showDashboard);
    onClose();
  };

  // Position so the popover's bottom edge sits 8 px above the dock,
  // regardless of how tall the actual content turns out.
  const pos = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(POPOVER_WIDTH, vw - EDGE_PAD * 2);
    const maxH = Math.min(540, vh - 80);
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    let left = anchorCenter - width / 2;
    left = Math.max(EDGE_PAD, Math.min(vw - width - EDGE_PAD, left));
    const bottom = Math.max(EDGE_PAD, vh - anchorRect.top + 8);
    return { left, bottom, maxH, width };
  }, [anchorRect]);

  // Outside-click + Escape dismiss (Escape: the topmost transient element
  // only, utils/escapeStack.js)
  useEscapeLayer(true, onClose);
  useEffect(() => {
    const onClick = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  // Build category groups, filtered by search
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CATEGORY_ORDER.map((cat) => {
      const entries = SLOT_OPTIONS.filter((o) =>
        !o.isMode &&
        o.category === cat &&
        o.id !== 'settings' &&
        (q === '' || (o.label || '').toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
      );
      return { cat, entries };
    }).filter((g) => g.entries.length > 0);
  }, [query]);

  const canRemove = dockItems.length > 1;

  const popover = (
    <div
      ref={popoverRef}
      className="dock-customize-popover"
      style={{
        position: 'fixed',
        left: pos.left,
        bottom: pos.bottom,
        width: pos.width,
        maxHeight: pos.maxH,
        zIndex: 10002,
      }}
      role="menu"
      aria-label="Customize dock"
    >
      <div className="dock-customize-popover__header">
        <span className="dock-customize-popover__title">Customize dock</span>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            className="dock-customize-popover__hide"
            onClick={handleToggleDock}
            title={showDashboard
              ? 'Hide the dock (Shift + H to toggle anywhere)'
              : 'Restore the dock (Shift + H to toggle anywhere)'}
            aria-pressed={!showDashboard}
          >
            {showDashboard ? 'Hide dock' : 'Show dock'}
          </button>
          <button
            type="button"
            className="dock-customize-popover__reset"
            onClick={resetDockItems}
            title="Reset dock to defaults (Ctrl/Cmd + Alt + D)"
          >
            Reset
          </button>
        </div>
      </div>
      <input
        type="text"
        className="dock-customize-popover__search"
        placeholder="Search panels…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="dock-customize-popover__body">
        {groups.length === 0 && (
          <div className="dock-customize-popover__empty">No panels match "{query}"</div>
        )}
        {groups.map(({ cat, entries }) => (
          <div key={cat} className="dock-customize-popover__group">
            <div className="dock-customize-popover__group-label">{CATEGORY_LABELS[cat] || cat}</div>
            {entries.map((opt) => {
              const inDock = dockItems.includes(opt.id);
              const disableUntoggle = inDock && !canRemove;
              const hint = viewKeyHint(opt.id);
              return (
                <label
                  key={opt.id}
                  className={`dock-customize-popover__row${inDock ? ' dock-customize-popover__row--on' : ''}`}
                  title={disableUntoggle ? 'Cannot remove the last dock item' : undefined}
                >
                  <svg className="dock-customize-popover__icon" width="14" height="14" viewBox="0 0 24 24"
                       fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={opt.icon} />
                  </svg>
                  <span className="dock-customize-popover__label">{opt.label}</span>
                  {hint && <kbd className="dock-customize-popover__kbd">{hint}</kbd>}
                  <input
                    type="checkbox"
                    className="dock-customize-popover__checkbox"
                    checked={inDock}
                    disabled={disableUntoggle}
                    onChange={(e) => {
                      if (e.target.checked) addDockItem(opt.id);
                      else if (canRemove) removeDockItem(opt.id);
                    }}
                  />
                </label>
              );
            })}
          </div>
        ))}
      </div>
      <div className="dock-customize-popover__footer">
        Drag any dock item to reorder · right-click for more
      </div>
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}
