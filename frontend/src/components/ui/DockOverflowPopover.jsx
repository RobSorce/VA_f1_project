import React, { useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';

const POPOVER_WIDTH = 260;
const EDGE_PAD = 12;

/**
 * Dock overflow popover — lists dock items that didn't fit in the visible row.
 * Clicking an item activates it exactly like a visible dock button.
 */
export default function DockOverflowPopover({ items, anchorRect, onClose, onItemContext }) {
  const popoverRef = useRef(null);
  const setActiveTab = useF1Store((s) => s.setActiveTab);

  const pos = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxH = Math.min(420, vh * 0.55);
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    let left = anchorCenter - POPOVER_WIDTH / 2;
    left = Math.max(EDGE_PAD, Math.min(vw - POPOVER_WIDTH - EDGE_PAD, left));
    const top = Math.max(EDGE_PAD, anchorRect.top - maxH - 8);
    return { left, top, maxH };
  }, [anchorRect]);

  // Escape closes the topmost transient element only (utils/escapeStack.js)
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

  const handleClick = (id) => { setActiveTab(id); onClose(); };

  const popover = (
    <div
      ref={popoverRef}
      className="dock-overflow-popover"
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
      <div className="dock-overflow-popover__title">More from dock</div>
      <div className="dock-overflow-popover__body">
        {items.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className="dock-overflow-popover__item"
            onClick={() => handleClick(opt.id)}
            onContextMenu={(e) => { e.preventDefault(); onItemContext?.(opt.id, e.clientX, e.clientY); onClose(); }}
          >
            <svg className="dock-overflow-popover__icon" width="16" height="16" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={opt.icon} />
            </svg>
            <span className="dock-overflow-popover__label">{opt.label}</span>
            {opt.hint && <kbd className="dock-overflow-popover__kbd">{opt.hint}</kbd>}
          </button>
        ))}
      </div>
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}
