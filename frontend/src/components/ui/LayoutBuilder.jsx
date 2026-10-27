import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { SLOT_OPTIONS, CATEGORY_ORDER, CATEGORY_LABELS } from '../../utils/slotOptions';

const POPOVER_WIDTH = 460;
const EDGE_PAD = 12;

/**
 * Classic layout selector — the user picks a pane shape and individual charts per slot.
 * Coexists with the Lightroom-style LayoutPresetBar (which applies complete presets).
 */

const SHAPES = [
  { id: 'single',    label: 'Single',     slots: 1, build: (s) => ({ tabs: [s[0]], activeTab: s[0] }) },
  { id: 'hsplit',    label: 'Two \u2194', slots: 2, build: (s) => ({
      direction: 'horizontal', ratio: 0.5,
      children: [{ tabs: [s[0]], activeTab: s[0] }, { tabs: [s[1]], activeTab: s[1] }],
  }) },
  { id: 'vsplit',    label: 'Two \u2195', slots: 2, build: (s) => ({
      direction: 'vertical', ratio: 0.5,
      children: [{ tabs: [s[0]], activeTab: s[0] }, { tabs: [s[1]], activeTab: s[1] }],
  }) },
  { id: 'mainside',  label: 'Main + 2',   slots: 3, build: (s) => ({
      direction: 'horizontal', ratio: 0.6,
      children: [
        { tabs: [s[0]], activeTab: s[0] },
        {
          direction: 'vertical', ratio: 0.5,
          children: [{ tabs: [s[1]], activeTab: s[1] }, { tabs: [s[2]], activeTab: s[2] }],
        },
      ],
  }) },
  { id: 'stack3',    label: 'Stack 3',    slots: 3, build: (s) => ({
      direction: 'vertical', ratio: 0.55,
      children: [
        {
          direction: 'horizontal', ratio: 0.5,
          children: [{ tabs: [s[0]], activeTab: s[0] }, { tabs: [s[1]], activeTab: s[1] }],
        },
        { tabs: [s[2]], activeTab: s[2] },
      ],
  }) },
  { id: 'grid2x2',   label: '2 \u00D7 2',  slots: 4, build: (s) => ({
      direction: 'vertical', ratio: 0.5,
      children: [
        {
          direction: 'horizontal', ratio: 0.5,
          children: [{ tabs: [s[0]], activeTab: s[0] }, { tabs: [s[1]], activeTab: s[1] }],
        },
        {
          direction: 'horizontal', ratio: 0.5,
          children: [{ tabs: [s[2]], activeTab: s[2] }, { tabs: [s[3]], activeTab: s[3] }],
        },
      ],
  }) },
];

const DEFAULT_SLOTS = ['laptimes', 'tyres', 'strategy', 'prediction'];

export default function LayoutBuilder({ anchorRect, onClose }) {
  const popoverRef = useRef(null);
  const applyWindowPreset = useF1Store((s) => s.applyWindowPreset);

  const [shapeId, setShapeId] = useState('hsplit');
  const [slots, setSlots] = useState(DEFAULT_SLOTS);

  const shape = SHAPES.find((s) => s.id === shapeId) || SHAPES[0];

  // Position above the anchor
  const pos = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxH = Math.min(520, vh * 0.7);
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    let left = anchorCenter - POPOVER_WIDTH / 2;
    left = Math.max(EDGE_PAD, Math.min(vw - POPOVER_WIDTH - EDGE_PAD, left));
    const top = Math.min(vh - maxH - EDGE_PAD, anchorRect.bottom + 8);
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

  const selectableOptions = useMemo(
    () => SLOT_OPTIONS.filter((o) => !o.isMode && o.component),
    []
  );
  const groupedOptions = useMemo(() => {
    const by = {};
    for (const opt of selectableOptions) (by[opt.category] ||= []).push(opt);
    return by;
  }, [selectableOptions]);

  const setSlot = (idx, id) => {
    const next = [...slots];
    next[idx] = id;
    setSlots(next);
  };

  const apply = () => {
    const tree = shape.build(slots.slice(0, shape.slots));
    applyWindowPreset({ dockedLayout: tree });
    onClose();
  };

  const popover = (
    <div
      ref={popoverRef}
      className="layout-builder"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: POPOVER_WIDTH,
        maxHeight: pos.maxH,
        zIndex: 10001,
      }}
      role="dialog"
      aria-label="Build custom layout"
    >
      <div className="layout-builder__header">
        <span className="layout-builder__title">Custom Layout</span>
        <button type="button" className="layout-builder__close" onClick={onClose} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="layout-builder__section-label">Shape</div>
      <div className="layout-builder__shapes">
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`layout-builder__shape${shapeId === s.id ? ' layout-builder__shape--active' : ''}`}
            onClick={() => setShapeId(s.id)}
          >
            <ShapePreview id={s.id} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      <div className="layout-builder__section-label">Content</div>
      <div className="layout-builder__slots">
        {Array.from({ length: shape.slots }).map((_, i) => (
          <div key={i} className="layout-builder__slot-row">
            <span className="layout-builder__slot-label">Slot {i + 1}</span>
            <select
              className="layout-builder__select"
              value={slots[i] || ''}
              onChange={(e) => setSlot(i, e.target.value)}
            >
              {CATEGORY_ORDER.map((cat) => {
                const entries = groupedOptions[cat];
                if (!entries || entries.length === 0) return null;
                return (
                  <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
                    {entries.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
        ))}
      </div>

      <div className="layout-builder__footer">
        <button type="button" className="layout-builder__btn" onClick={onClose}>Cancel</button>
        <button type="button" className="layout-builder__btn layout-builder__btn--primary" onClick={apply}>
          Apply Layout
        </button>
      </div>
    </div>
  );

  return ReactDOM.createPortal(popover, document.body);
}

function ShapePreview({ id }) {
  const S = 22;
  const rect = (x, y, w, h) => (
    <rect x={x} y={y} width={w} height={h}
          fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.45)" strokeWidth="0.8" />
  );
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ flexShrink: 0 }}>
      {id === 'single'   && rect(2, 2, S-4, S-4)}
      {id === 'hsplit'   && (<>{rect(2, 2, (S-5)/2, S-4)}{rect(S/2+0.5, 2, (S-5)/2, S-4)}</>)}
      {id === 'vsplit'   && (<>{rect(2, 2, S-4, (S-5)/2)}{rect(2, S/2+0.5, S-4, (S-5)/2)}</>)}
      {id === 'mainside' && (<>{rect(2, 2, (S-5)*0.6, S-4)}{rect(2 + (S-5)*0.6 + 1, 2, (S-5)*0.4, (S-5)/2)}{rect(2 + (S-5)*0.6 + 1, S/2+0.5, (S-5)*0.4, (S-5)/2)}</>)}
      {id === 'stack3'   && (<>{rect(2, 2, (S-5)/2, (S-5)*0.55)}{rect(S/2+0.5, 2, (S-5)/2, (S-5)*0.55)}{rect(2, 2 + (S-5)*0.55 + 1, S-4, (S-5)*0.45)}</>)}
      {id === 'grid2x2'  && (<>{rect(2, 2, (S-5)/2, (S-5)/2)}{rect(S/2+0.5, 2, (S-5)/2, (S-5)/2)}{rect(2, S/2+0.5, (S-5)/2, (S-5)/2)}{rect(S/2+0.5, S/2+0.5, (S-5)/2, (S-5)/2)}</>)}
    </svg>
  );
}
