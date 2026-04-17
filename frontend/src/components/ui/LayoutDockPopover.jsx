import React, { useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { SLOT_OPTIONS, CATEGORY_ORDER, CATEGORY_LABELS } from '../../utils/slotOptions';
import { WINDOW_PRESETS } from '../../utils/windowPresets';

const POPOVER_WIDTH = 320;
const EDGE_PAD = 12;

/**
 * Restored "Layouts" popover — opens from a dock button and shows:
 *  1. Layout presets (apply a pre-built dockedLayout)
 *  2. "Add view" — categorized list of every panel (click = open as active tab / overlay)
 *  3. "Close all views"
 *
 * Items already in the current dockedLayout / open overlays are marked with a green ✓.
 */
export default function LayoutDockPopover({ anchorRect, onClose }) {
  const popoverRef = useRef(null);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const applyWindowPreset = useF1Store((s) => s.applyWindowPreset);
  const closeAllOverlays = useF1Store((s) => s.closeAllOverlays);
  const dockedLayout = useF1Store((s) => s.dockedLayout);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const activeTab = useF1Store((s) => s.activeTab);

  // All panel ids currently shown somewhere in the UI
  const activeIds = useMemo(() => {
    const out = new Set();
    if (activeTab) out.add(activeTab);
    for (const id of openOverlays) out.add(id);
    const walk = (node) => {
      if (!node) return;
      if (!node.children) { (node.tabs || []).forEach((t) => out.add(t)); return; }
      walk(node.children[0]); walk(node.children[1]);
    };
    walk(dockedLayout);
    return out;
  }, [dockedLayout, openOverlays, activeTab]);

  const activePresetKey = useMemo(() => {
    if (!dockedLayout) return null;
    const current = JSON.stringify(dockedLayout);
    for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
      if (JSON.stringify(preset.dockedLayout) === current) return key;
    }
    return null;
  }, [dockedLayout]);

  const pos = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxH = Math.min(540, vh * 0.72);
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    let left = anchorCenter - POPOVER_WIDTH / 2;
    left = Math.max(EDGE_PAD, Math.min(vw - POPOVER_WIDTH - EDGE_PAD, left));
    const top = Math.max(EDGE_PAD, anchorRect.top - maxH - 8);
    return { left, top, maxH };
  }, [anchorRect]);

  useEffect(() => {
    const onClick = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const handleView = (id) => { setActiveTab(id); onClose(); };
  const handlePreset = (preset) => { applyWindowPreset(preset); onClose(); };
  const handleCloseAll = () => { closeAllOverlays(); onClose(); };

  const popover = (
    <div
      ref={popoverRef}
      className="layout-dock-popover"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: POPOVER_WIDTH,
        maxHeight: pos.maxH,
        zIndex: 10001,
      }}
      role="menu"
    >
      {/* Layout presets */}
      <div className="layout-dock-popover__title">Layout presets</div>
      <div className="layout-dock-popover__presets">
        {Object.entries(WINDOW_PRESETS).map(([key, preset]) => (
          <button
            key={key}
            type="button"
            className={`layout-dock-popover__preset${activePresetKey === key ? ' layout-dock-popover__preset--active' : ''}`}
            onClick={() => handlePreset(preset)}
            title={preset.description}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="layout-dock-popover__divider" />

      {/* Add view */}
      <div className="layout-dock-popover__title">Add view</div>
      <div className="layout-dock-popover__body">
        {CATEGORY_ORDER.map((cat) => {
          const entries = SLOT_OPTIONS.filter(
            (o) => !o.isMode && o.category === cat && o.id !== 'settings'
          );
          if (entries.length === 0) return null;
          return (
            <div key={cat} className="layout-dock-popover__group">
              <div className="layout-dock-popover__group-label">{CATEGORY_LABELS[cat]}</div>
              {entries.map((opt) => {
                const shown = activeIds.has(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className="layout-dock-popover__item"
                    onClick={() => handleView(opt.id)}
                    title={shown ? 'Already showing — click to focus' : `Open ${opt.label}`}
                  >
                    <svg className="layout-dock-popover__icon" width="14" height="14" viewBox="0 0 24 24"
                         fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d={opt.icon} />
                    </svg>
                    <span className="layout-dock-popover__label">{opt.label}</span>
                    {opt.hint && <kbd className="layout-dock-popover__kbd">{opt.hint}</kbd>}
                    {shown && <span className="layout-dock-popover__check" aria-label="Currently shown">{'\u2713'}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="layout-dock-popover__footer">
        <span className="layout-dock-popover__hint">Number keys for quick access</span>
        <button type="button" className="layout-dock-popover__close-all" onClick={handleCloseAll}>
          Close all views
        </button>
      </div>
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}
