import React, { useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
import { CHART_HELP } from '../../utils/chartHelp';

/**
 * DockedLayout — JetBrains-style split pane layout with draggable splitters
 * and tab bars per slot.
 *
 * Layout tree nodes:
 *   Split: { direction: 'horizontal'|'vertical', ratio: 0.5, children: [A, B] }
 *   Pane:  { tabs: ['laptimes', ...], activeTab: 'laptimes' }
 */

const VIZ_TABS = [
  { id: 'trackmap', label: 'Track Map' },
  { id: 'laptimes', label: 'Lap Times' },
  { id: 'lapdelta', label: 'Lap Delta' },
  { id: 'sectors', label: 'Sectors' },
  { id: 'tyres', label: 'Tyres' },
  { id: 'tiredeg', label: 'Tyre Degradation' },
  { id: 'tyrehealth', label: 'Tyre Health' },
  { id: 'tyremgmt', label: 'Pace Retention' },
  { id: 'speed', label: 'Speed' },
  { id: 'consistency', label: 'Consistency' },
  { id: 'prediction', label: 'Prediction' },
  { id: 'simulator', label: 'Strategy Simulator' },
  { id: 'strategy', label: 'Strategy Timeline' },
  { id: 'circle', label: 'Circle of Doom' },
  { id: 'analysis', label: 'Strategy Analysis' },
  { id: 'racesituation', label: 'Race Situation' },
  { id: 'racepace', label: 'Race Pace Grid' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'compare', label: 'Compare' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'championship', label: 'Championship' },
  { id: 'positionlaps', label: 'Position Tracker' },
  { id: 'settings', label: 'Settings' },
];

const SPLITTER_SIZE = 5;
// Tab picker menu: a grid of items, at most PICKER_ROWS rows per column and
// PICKER_COLUMNS columns, so every view is listed without a scrollbar
const PICKER_ROWS = 9;
const PICKER_COLUMNS = 3;
const PICKER_ITEM_W = 150;
const PICKER_ITEM_H = 28;

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
      className={`docked-splitter docked-splitter--${isH ? 'col' : 'row'}`}
      style={{ [isH ? 'width' : 'height']: SPLITTER_SIZE }}
      role="separator"
      aria-orientation={isH ? 'vertical' : 'horizontal'}
    />
  );
}

/* ────────────────────── Pane: tab bar + content ────────────────────── */
function TabPickerDropdown({ availableTabs, onAddTab, onClose, anchorRef }) {
  const [pos, setPos] = useState(null);
  const dropdownRef = useRef(null);

  // Position the dropdown using the anchor button's bounding rect, clamped to viewport
  React.useEffect(() => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    // Every view fits without a scrollbar: the menu is a grid of up to
    // PICKER_COLUMNS columns (CSS .docked-tab-picker)
    const cols = Math.min(PICKER_COLUMNS, Math.max(1, Math.ceil(availableTabs.length / PICKER_ROWS)));
    const dropH = Math.ceil(availableTabs.length / cols) * PICKER_ITEM_H + 8;
    const dropW = cols * PICKER_ITEM_W + 8;
    let top = r.bottom + 2;
    let left = r.left;
    // If dropdown would go below viewport, open upward
    if (top + dropH > window.innerHeight) {
      top = Math.max(4, r.top - dropH - 2);
    }
    // Clamp left so it doesn't go off the right edge
    if (left + dropW > window.innerWidth) {
      left = Math.max(4, window.innerWidth - dropW - 4);
    }
    setPos({ top, left, cols });
  }, [anchorRef, availableTabs.length]);

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
    <div
      ref={dropdownRef}
      className="docked-tab-picker"
      role="menu"
      style={{ top: pos.top, left: pos.left, gridTemplateColumns: `repeat(${pos.cols}, ${PICKER_ITEM_W}px)` }}
    >
      {availableTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitem"
          className="docked-tab-picker__item"
          onClick={() => { onAddTab(t.id); onClose(); }}
        >
          {t.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

function DockedPane({ pane, onTabChange, onAddTab, onCloseTab, onClosePane, vizComponents, allDockedTabs }) {
  const { tabs, activeTab } = pane;
  const config = vizComponents[activeTab];
  const Component = config?.Component;
  const [showTabPicker, setShowTabPicker] = useState(false);
  const addBtnRef = useRef(null);
  const openHelp = useF1Store((s) => s.openHelp);
  const activeHelp = CHART_HELP[activeTab];

  // Filter out tabs already docked anywhere (not just this pane)
  const availableTabs = VIZ_TABS.filter((t) => !allDockedTabs.includes(t.id));

  return (
    <div className="docked-pane">
      {/* Tab bar: tabs shrink (ellipsis, full name in the title) instead of
          scrolling sideways */}
      <div className="docked-pane__tabs">
        {tabs.map((tabId) => {
          const isActive = tabId === activeTab;
          const tabInfo = VIZ_TABS.find((t) => t.id === tabId) || { label: tabId };
          return (
            <div
              key={tabId}
              onClick={() => onTabChange(tabId)}
              className={`docked-pane__tab${isActive ? ' docked-pane__tab--active' : ''}`}
              title={tabInfo.label}
            >
              <span className="docked-pane__tab-label">{tabInfo.label}</span>
              <span
                onClick={(e) => { e.stopPropagation(); onCloseTab(tabId); }}
                className="docked-pane__tab-close"
                title={`Close ${tabInfo.label}`}
              >
                ×
              </span>
            </div>
          );
        })}

        {/* Spacer */}
        <div className="docked-pane__spacer" />

        {/* Help button — opens the per-chart help overlay for the
            currently-active tab (H10/V10.1). Hidden if the active tab
            has no registry entry. */}
        {activeHelp && (
          <button
            type="button"
            onClick={() => openHelp(activeTab, activeHelp.title)}
            className="docked-pane__icon-btn docked-pane__icon-btn--help"
            title={activeHelp.summary || `About ${activeHelp.title || activeTab}`}
            aria-label={`About ${activeHelp.title || activeTab}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <circle cx="12" cy="16" r="0.6" fill="currentColor" />
            </svg>
          </button>
        )}

        {/* Add tab to this pane */}
        <button
          ref={addBtnRef}
          type="button"
          onClick={() => setShowTabPicker((v) => !v)}
          className="docked-pane__icon-btn docked-pane__icon-btn--add"
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
          type="button"
          onClick={onClosePane}
          className="docked-pane__icon-btn docked-pane__icon-btn--close"
          title="Close this pane"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </div>
      {/* Content */}
      <div className="docked-pane__content">
        {Component ? <Component /> : (
          <div className="docked-pane__empty">
            Select a visualization
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────── Split: two children with a splitter ────────────────────── */
function SplitPane({ node, onUpdate, vizComponents, allDockedTabs }) {
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
      className={`docked-split docked-split--${isH ? 'row' : 'column'}`}
    >
      <div className="docked-split__child" style={{ [isH ? 'width' : 'height']: first }}>
        <LayoutNode
          node={node.children[0]}
          vizComponents={vizComponents}
          allDockedTabs={allDockedTabs}
          onUpdate={(updated) => onUpdate({ ...node, children: [updated, node.children[1]] })}
        />
      </div>
      <Splitter
        direction={node.direction}
        containerRef={containerRef}
        ratio={ratio}
        onRatioChange={handleRatioChange}
      />
      <div className="docked-split__child" style={{ [isH ? 'width' : 'height']: second }}>
        <LayoutNode
          node={node.children[1]}
          vizComponents={vizComponents}
          allDockedTabs={allDockedTabs}
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
function LayoutNode({ node, onUpdate, vizComponents, allDockedTabs }) {
  if (!node) return null;

  // Leaf node: has tabs
  if (!node.children) {
    return (
      <DockedPane
        pane={node}
        vizComponents={vizComponents}
        allDockedTabs={allDockedTabs}
        onTabChange={(tabId) => onUpdate({ ...node, activeTab: tabId })}
        onAddTab={(tabId) => {
          // Already in this pane — just activate
          if (node.tabs.includes(tabId)) {
            onUpdate({ ...node, activeTab: tabId });
            return;
          }
          onUpdate({ ...node, tabs: [...node.tabs, tabId], activeTab: tabId });
        }}
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
      allDockedTabs={allDockedTabs}
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

/** Collect all tab IDs from every leaf pane */
function collectAllTabs(node) {
  if (!node) return [];
  if (!node.children) return node.tabs || [];
  return [...collectAllTabs(node.children[0]), ...collectAllTabs(node.children[1])];
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
    <div className="docked-layout">
      {/* Layout toolbar */}
      <div className="docked-layout__toolbar">
        <span className="docked-layout__label">Layout</span>
        <span className="docked-layout__count">
          {paneCount} / {MAX_PANES} panes
        </span>

        <div className="docked-pane__spacer" />

        {/* Cycle arrangement */}
        <button
          type="button"
          onClick={arrangeOverlays}
          className="docked-layout__btn"
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
          type="button"
          onClick={closeAllOverlays}
          className="docked-layout__btn docked-layout__btn--exit"
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
      <div className="docked-layout__tree">
        <LayoutNode
          node={dockedLayout}
          vizComponents={vizComponents}
          allDockedTabs={collectAllTabs(dockedLayout)}
          onUpdate={handleUpdate}
        />
      </div>
    </div>
  );
}
