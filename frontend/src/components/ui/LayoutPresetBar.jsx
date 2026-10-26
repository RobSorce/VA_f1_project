import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { WINDOW_PRESETS } from '../../utils/windowPresets';
import { useF1Store } from '../../store/useF1Store';
import LayoutBuilder from './LayoutBuilder';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';

/**
 * Layout preset picker of the weather bar. A single compact button names the
 * active preset and opens a menu of the presets plus "Custom layout…" (the
 * LayoutBuilder). The seven preset buttons in a row took half of the bar and
 * pushed the lap counter and the flag out of a 1536 px window (V13); the same
 * presets are also in the dock's Layouts popover.
 */
export default function LayoutPresetBar() {
  const applyWindowPreset = useF1Store((s) => s.applyWindowPreset);
  const dockedLayout = useF1Store((s) => s.dockedLayout);

  const activePresetKey = useMemo(() => {
    if (!dockedLayout) return null;
    const current = JSON.stringify(dockedLayout);
    for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
      if (JSON.stringify(preset.dockedLayout) === current) return key;
    }
    return null;
  }, [dockedLayout]);

  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuRect, setMenuRect] = useState(null);
  const [builderRect, setBuilderRect] = useState(null);

  const activeLabel = activePresetKey
    ? WINDOW_PRESETS[activePresetKey].label
    : (dockedLayout ? 'Custom' : 'None');

  const toggleMenu = () => {
    if (menuRect) { setMenuRect(null); return; }
    if (triggerRef.current) setMenuRect(triggerRef.current.getBoundingClientRect());
  };

  // Close the menu on an outside click or Escape (the topmost transient
  // element only, utils/escapeStack.js)
  useEscapeLayer(!!menuRect, () => setMenuRect(null));
  useEffect(() => {
    if (!menuRect) return undefined;
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      setMenuRect(null);
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menuRect]);

  const pickPreset = (preset) => {
    applyWindowPreset(preset);
    setMenuRect(null);
  };
  const openBuilder = () => {
    setBuilderRect(menuRect || triggerRef.current?.getBoundingClientRect() || null);
    setMenuRect(null);
  };

  return (
    <div className="layout-preset-bar">
      <span className="layout-preset-bar__label">Layout</span>
      <button
        ref={triggerRef}
        type="button"
        className={`layout-preset-bar__btn layout-preset-bar__trigger${activePresetKey ? ' layout-preset-bar__btn--active' : ''}`}
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={!!menuRect}
        title="Layout presets and the custom layout builder"
      >
        <span className="layout-preset-bar__current">{activeLabel}</span>
        <svg className="layout-preset-bar__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menuRect && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="layout-preset-menu"
          role="menu"
          style={{
            position: 'fixed',
            top: menuRect.bottom + 6,
            left: Math.max(8, Math.min(window.innerWidth - 248, menuRect.left)),
          }}
        >
          {Object.entries(WINDOW_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className={`layout-preset-menu__item${activePresetKey === key ? ' layout-preset-menu__item--active' : ''}`}
              onClick={() => pickPreset(preset)}
            >
              <span className="layout-preset-menu__name">{preset.label}</span>
              <span className="layout-preset-menu__desc">{preset.description}</span>
            </button>
          ))}
          <div className="layout-preset-menu__divider" />
          <button
            type="button"
            role="menuitem"
            className="layout-preset-menu__item"
            onClick={openBuilder}
            title="Build a custom layout and pick charts per slot"
          >
            <span className="layout-preset-menu__name">Custom layout…</span>
            <span className="layout-preset-menu__desc">Pick a pane shape and a chart per slot</span>
          </button>
        </div>,
        document.body,
      )}

      {builderRect && (
        <LayoutBuilder anchorRect={builderRect} onClose={() => setBuilderRect(null)} />
      )}
    </div>
  );
}
