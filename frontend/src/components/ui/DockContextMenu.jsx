import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { SLOT_OPTIONS } from '../../utils/slotOptions';

const MENU_WIDTH = 220;
const MENU_MAX_HEIGHT = 320;
const EDGE_PAD = 8;

/**
 * macOS-style right-click context menu for a dock item.
 * Opened via `openAt(id, clientX, clientY)` from the parent (`BottomTabBar`).
 * Dismisses on outside click, Esc, scroll, and after any menu-item activation.
 */
export default function DockContextMenu({ target, position, onClose, onCustomize }) {
  const menuRef = useRef(null);
  const dockItems = useF1Store((s) => s.dockItems);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const moveDockItem = useF1Store((s) => s.moveDockItem);
  const removeDockItem = useF1Store((s) => s.removeDockItem);
  const resetDockItems = useF1Store((s) => s.resetDockItems);
  const [confirmReset, setConfirmReset] = useState(false);
  const [focused, setFocused] = useState(-1);
  const confirmTimerRef = useRef(null);

  // Compute clamped screen position
  const [pos, setPos] = useState(position);
  useEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(position.x, vw - MENU_WIDTH - EDGE_PAD);
    const top = Math.min(position.y, vh - MENU_MAX_HEIGHT - EDGE_PAD);
    setPos({ x: Math.max(EDGE_PAD, left), y: Math.max(EDGE_PAD, top) });
  }, [position]);

  // Dismiss on outside click / Esc / scroll
  useEffect(() => {
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((f) => Math.min(items.length - 1, f + 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setFocused((f) => Math.max(0, f - 1)); }
      if (e.key === 'Enter' && focused >= 0) { e.preventDefault(); items[focused]?.onActivate?.(); }
    };
    const onScroll = () => onClose();
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      clearTimeout(confirmTimerRef.current);
    };
  });

  const entry = SLOT_OPTIONS.find((o) => o.id === target);
  const idx = dockItems.indexOf(target);
  const isFirst = idx <= 0;
  const isLast = idx < 0 || idx >= dockItems.length - 1;
  const canRemove = dockItems.length > 1;

  const handleReset = useCallback(() => {
    if (!confirmReset) {
      setConfirmReset(true);
      confirmTimerRef.current = setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    clearTimeout(confirmTimerRef.current);
    resetDockItems();
    onClose();
  }, [confirmReset, resetDockItems, onClose]);

  const handleOpen = () => { setActiveTab(target); onClose(); };
  const handleMoveLeft  = () => { moveDockItem(target, 'left');  onClose(); };
  const handleMoveRight = () => { moveDockItem(target, 'right'); onClose(); };
  const handleRemove = () => { removeDockItem(target); onClose(); };
  const handleCustomize = () => { onCustomize?.(); onClose(); };

  const items = [
    { type: 'action', label: 'Open',         onActivate: handleOpen },
    { type: 'action', label: 'Move \u2190',   disabled: isFirst, onActivate: handleMoveLeft },
    { type: 'action', label: 'Move \u2192',   disabled: isLast,  onActivate: handleMoveRight },
    { type: 'sep' },
    { type: 'action', label: 'Remove from dock', disabled: !canRemove, danger: true, onActivate: handleRemove },
    { type: 'sep' },
    { type: 'action', label: 'Customize dock\u2026', onActivate: handleCustomize },
    { type: 'action', label: confirmReset ? 'Click again to confirm' : 'Reset dock to defaults', danger: confirmReset, onActivate: handleReset },
  ];

  const menu = (
    <div
      ref={menuRef}
      className="dock-ctx-menu"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: MENU_WIDTH,
        maxHeight: MENU_MAX_HEIGHT,
        zIndex: 10002,
      }}
      role="menu"
    >
      <div className="dock-ctx-menu__title">
        {entry?.label ?? target}
      </div>
      {items.map((it, i) => {
        if (it.type === 'sep') return <div key={`sep-${i}`} className="dock-ctx-menu__sep" />;
        const cls = [
          'dock-ctx-menu__item',
          it.disabled && 'dock-ctx-menu__item--disabled',
          it.danger && 'dock-ctx-menu__item--danger',
          focused === i && 'dock-ctx-menu__item--focused',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={it.label + i}
            type="button"
            className={cls}
            disabled={it.disabled}
            onClick={() => !it.disabled && it.onActivate?.()}
            onMouseEnter={() => setFocused(i)}
            role="menuitem"
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );

  return ReactDOM.createPortal(menu, document.body);
}
