import React, { useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';

/**
 * DockedLayout — JetBrains-style split pane layout with draggable splitters
 * and tab bars per slot.
 *
 * Layout tree nodes:
 *   Split: { direction: 'horizontal'|'vertical', ratio: 0.5, children: [A, B] }
 *   Pane:  { tabs: ['laptimes', ...], activeTab: 'laptimes' }
 */

const VIZ_TABS = [
  { id: 'laptimes', label: 'Lap Times' },
  { id: 'sectors', label: 'Sectors' },
  { id: 'tyres', label: 'Tyres' },
  { id: 'consistency', label: 'Consistency' },
  { id: 'prediction', label: 'Prediction' },
  { id: 'ai', label: 'AI Assistant' },
  { id: 'compare', label: 'Compare' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'championship', label: 'Championship' },
  { id: 'settings', label: 'Settings' },
];

const SPLITTER_SIZE = 5;

/* ────────────────────── Splitter ────────────────────── */
/**
 * Splitter captures the initial ratio on mousedown, then computes the new
 * ratio from cumulative mouse delta. This avoids compounding issues.
 */
function Splitter({ direction, containerRef, ratio, onRatioChange }) {
  const isH = direction === 'horizontal';

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    const startPos = isH ? e.clientX : e.clientY;
    const startRatio = ratio; // capture at drag start

    const onMove = (ev) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = isH ? rect.width : rect.height;
      if (total <= 0) return;

      const delta = (isH ? ev.clientX : ev.clientY) - startPos;
      const newRatio = Math.max(0.15, Math.min(0.85, startRatio + delta / total));
      onRatioChange(newRatio);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [isH, ratio, containerRef, onRatioChange]);

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        flexShrink: 0,
        [isH ? 'width' : 'height']: SPLITTER_SIZE,
        [isH ? 'height' : 'width']: '100%',
        cursor: isH ? 'col-resize' : 'row-resize',
        background: 'rgba(255,255,255,0.04)',
        transition: 'background 0.15s',
        zIndex: 5,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(100,180,255,0.25)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
    />
  );
}

/* ────────────────────── Pane: tab bar + content ────────────────────── */
function TabPickerDropdown({ availableTabs, onAddTab, onClose, anchorRef }) {
  const [pos, setPos] = useState(null);
  const dropdownRef = useRef(null);

  // Position the dropdown using the anchor button's bounding rect
  React.useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 2, left: r.left });
    }
  }, [anchorRef]);

  // Close on outside click — but NOT if clicking inside the dropdown itself
  React.useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && dropdownRef.current.contains(e.target)) return;
      if (anchorRef.current && anchorRef.current.contains(e.target)) return;
      onClose();
    };
    // Use setTimeout so the handler doesn't fire on the same click that opened it
    const id = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose, anchorRef]);

  if (!pos || availableTabs.length === 0) return null;

  // Render via portal to <body> so no parent overflow clips it
  return ReactDOM.createPortal(
    <div ref={dropdownRef} style={{
      position: 'fixed', top: pos.top, left: pos.left, zIndex: 10000,
      background: 'rgba(25,25,50,0.98)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 4, padding: 4, minWidth: 140,
      boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
      maxHeight: 260, overflowY: 'auto',
    }}>
      {availableTabs.map((t) => (
        <div
          key={t.id}
          onClick={() => { onAddTab(t.id); onClose(); }}
          style={{
            padding: '5px 10px', cursor: 'pointer', fontSize: 11,
            color: 'rgba(255,255,255,0.75)', borderRadius: 3,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(100,180,255,0.15)'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
        >
          {t.label}
        </div>
      ))}
    </div>,
    document.body
  );
}

function DockedPane({ pane, onTabChange, onAddTab, onCloseTab, onClosePane, vizComponents }) {
  const { tabs, activeTab } = pane;
  const config = vizComponents[activeTab];
  const Component = config?.Component;
  const [showTabPicker, setShowTabPicker] = useState(false);
  const addBtnRef = useRef(null);

  const availableTabs = VIZ_TABS.filter((t) => !tabs.includes(t.id));

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100%', height: '100%',
      background: 'rgba(10,10,20,0.95)',
      borderRadius: 4,
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center',
        height: 28, minHeight: 28, flexShrink: 0,
        background: 'rgba(20,20,40,0.98)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        overflowX: 'auto', overflowY: 'visible',
      }}>
        {tabs.map((tabId) => {
          const isActive = tabId === activeTab;
          const tabInfo = VIZ_TABS.find((t) => t.id === tabId) || { label: tabId };
          return (
            <div
              key={tabId}
              onClick={() => onTabChange(tabId)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '0 10px', height: '100%',
                cursor: 'pointer', fontSize: 10,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? '#fff' : 'rgba(255,255,255,0.45)',
                background: isActive ? 'rgba(255,255,255,0.06)' : 'transparent',
                borderRight: '1px solid rgba(255,255,255,0.04)',
                whiteSpace: 'nowrap', transition: 'all 0.12s',
                borderBottom: isActive ? '2px solid rgba(100,180,255,0.7)' : '2px solid transparent',
              }}
            >
              <span>{tabInfo.label}</span>
              <span
                onClick={(e) => { e.stopPropagation(); onCloseTab(tabId); }}
                style={{
                  marginLeft: 4, fontSize: 12, lineHeight: 1,
                  color: 'rgba(255,255,255,0.25)', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#ff5555'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.25)'; }}
              >
                ×
              </span>
            </div>
          );
        })}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Add tab to this pane */}
        <button
          ref={addBtnRef}
          onClick={() => setShowTabPicker((v) => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '0 6px', height: 28, display: 'flex', alignItems: 'center', flexShrink: 0,
            color: 'rgba(255,255,255,0.3)', fontSize: 14,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; }}
          title="Add tab to this pane"
        >
          +
        </button>
        {showTabPicker && (
          <TabPickerDropdown
            availableTabs={availableTabs}
            anchorRef={addBtnRef}
            onAddTab={onAddTab}
            onClose={() => setShowTabPicker(false)}
          />
        )}

        {/* Close entire pane */}
        <button
          onClick={onClosePane}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '0 6px', height: 28, display: 'flex', alignItems: 'center', flexShrink: 0,
            color: 'rgba(255,255,255,0.2)', fontSize: 12,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#ff5555'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; }}
          title="Close this pane"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </div>
      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {Component ? <Component /> : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'rgba(255,255,255,0.2)', fontSize: 12,
          }}>
            Select a visualization
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────── Split: two children with a splitter ────────────────────── */
function SplitPane({ node, onUpdate, vizComponents }) {
  const containerRef = useRef(null);
  const isH = node.direction === 'horizontal';
  const ratio = node.ratio || 0.5;

  const handleRatioChange = useCallback((newRatio) => {
    onUpdate({ ...node, ratio: newRatio });
  }, [node, onUpdate]);

  const first = `calc(${(ratio * 100).toFixed(2)}% - ${SPLITTER_SIZE / 2}px)`;
  const second = `calc(${((1 - ratio) * 100).toFixed(2)}% - ${SPLITTER_SIZE / 2}px)`;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isH ? 'row' : 'column',
        width: '100%', height: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{ [isH ? 'width' : 'height']: first, overflow: 'hidden', display: 'flex' }}>
        <LayoutNode
          node={node.children[0]}
          vizComponents={vizComponents}
          onUpdate={(updated) => onUpdate({ ...node, children: [updated, node.children[1]] })}
        />
      </div>
      <Splitter
        direction={node.direction}
        containerRef={containerRef}
        ratio={ratio}
        onRatioChange={handleRatioChange}
      />
      <div style={{ [isH ? 'width' : 'height']: second, overflow: 'hidden', display: 'flex' }}>
        <LayoutNode
          node={node.children[1]}
          vizComponents={vizComponents}
          onUpdate={(updated) => onUpdate({ ...node, children: [node.children[0], updated] })}
        />
      </div>
    </div>
  );
}

/* ────────────────────── Layout node dispatcher ────────────────────── */
/**
 * Dispatches to DockedPane (leaf) or SplitPane (split).
 * This is a pure dispatcher — no hooks — so it can safely branch.
 */
function LayoutNode({ node, onUpdate, vizComponents }) {
  if (!node) return null;

  // Leaf node: has tabs
  if (!node.children) {
    return (
      <DockedPane
        pane={node}
        vizComponents={vizComponents}
        onTabChange={(tabId) => onUpdate({ ...node, activeTab: tabId })}
        onAddTab={(tabId) => onUpdate({ ...node, tabs: [...node.tabs, tabId], activeTab: tabId })}
        onCloseTab={(tabId) => {
          const newTabs = node.tabs.filter((t) => t !== tabId);
          // Signal removal when last tab is closed (cleanupTree handles collapse)
          if (newTabs.length === 0) { onUpdate(null); return; }
          onUpdate({ ...node, tabs: newTabs, activeTab: node.activeTab === tabId ? newTabs[0] : node.activeTab });
        }}
        onClosePane={() => onUpdate(null)}
      />
    );
  }

  // Split node: has children
  return (
    <SplitPane
      node={node}
      onUpdate={onUpdate}
      vizComponents={vizComponents}
    />
  );
}

/* ────────────────────── Tree cleanup ────────────────────── */
/** Collapse empty panes and single-child splits after tab removal */
function cleanupTree(node) {
  if (!node) return null;
  if (!node.children) {
    // Leaf: remove if no tabs
    return (node.tabs && node.tabs.length > 0) ? node : null;
  }
  // Split: clean children
  let left = cleanupTree(node.children[0]);
  let right = cleanupTree(node.children[1]);
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

/* ────────────────────── Pane counter ────────────────────── */
function countPanes(node) {
  if (!node) return 0;
  if (!node.children) return 1;
  return countPanes(node.children[0]) + countPanes(node.children[1]);
}

const MAX_PANES = 4;

/* ────────────────────── Main DockedLayout ────────────────────── */
export default function DockedLayout({ vizComponents }) {
  const dockedLayout = useF1Store((s) => s.dockedLayout);
  const setDockedLayout = useF1Store((s) => s.setDockedLayout);
  const closeAllOverlays = useF1Store((s) => s.closeAllOverlays);
  const arrangeOverlays = useF1Store((s) => s.arrangeOverlays);

  const paneCount = dockedLayout ? countPanes(dockedLayout) : 0;

  // Wrap onUpdate to clean up empty panes
  const handleUpdate = useCallback((newLayout) => {
    const cleaned = cleanupTree(newLayout);
    setDockedLayout(cleaned);
  }, [setDockedLayout]);

  if (!dockedLayout) return null;

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Layout toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        height: 24, minHeight: 24, flexShrink: 0,
        padding: '0 8px',
        background: 'rgba(15,15,35,0.95)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
          Layout
        </span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>
          {paneCount} / {MAX_PANES} panes
        </span>

        <div style={{ flex: 1 }} />

        {/* Cycle arrangement */}
        <button
          onClick={arrangeOverlays}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.35)', fontSize: 10, padding: '2px 6px',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; }}
          title="Cycle layout arrangement (Ctrl+G)"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1" y="1" width="4" height="4" rx="0.5" />
            <rect x="7" y="1" width="4" height="4" rx="0.5" />
            <rect x="1" y="7" width="4" height="4" rx="0.5" />
            <rect x="7" y="7" width="4" height="4" rx="0.5" />
          </svg>
          Arrange
        </button>

        {/* Exit docked layout */}
        <button
          onClick={closeAllOverlays}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.35)', fontSize: 10, padding: '2px 6px',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#ff6b6b'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; }}
          title="Exit layout mode (X)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
          Exit Layout
        </button>
      </div>

      {/* Layout tree */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <LayoutNode
          node={dockedLayout}
          vizComponents={vizComponents}
          onUpdate={handleUpdate}
        />
      </div>
    </div>
  );
}
