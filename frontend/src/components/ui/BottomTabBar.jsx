import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { SLOT_OPTIONS, SLOT_IDS } from '../../utils/slotOptions';
import { DOCK_STORAGE_KEY } from '../../store/useF1Store';
import DockContextMenu from './DockContextMenu';
import DockOverflowPopover from './DockOverflowPopover';
import LayoutDockPopover from './LayoutDockPopover';

const HOVER_ZONE_HEIGHT = 12;
const DOCK_ITEM_WIDTH = 72;
const FIXED_OVERHEAD = 160; // Pit Wall (implicit in items) + separators + ⋯ + command palette + settings

/* ── SLOT lookup (memoized once) ───────────────────────────────── */
const SLOT_BY_ID = new Map(SLOT_OPTIONS.map((o) => [o.id, o]));

/* ─── DockButton ─────────────────────────────────────────────── */
const DockButton = React.forwardRef(function DockButton(
  {
    option, isOpen, onActivate, onContextMenu,
    isDragging, isDropTarget,
    onDragStart, onDragOver, onDragEnter, onDragLeave, onDrop, onDragEnd,
  },
  ref
) {
  const cls = [
    'bottom-tab-bar__tab',
    isOpen && 'bottom-tab-bar__tab--active',
    isDragging && 'bottom-tab-bar__tab--dragging',
    isDropTarget && 'bottom-tab-bar__tab--drop-target',
  ].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      draggable
      onClick={onActivate}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={`${option.label}${option.hint ? ` [${option.hint}]` : ''} — drag to reorder, right-click to configure`}
    >
      <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={option.icon} />
      </svg>
      <span className="bottom-tab-bar__label">{option.label}</span>
      {option.hint && <kbd className="tab-kbd">{option.hint}</kbd>}
    </button>
  );
});

/* ─── BottomTabBar ───────────────────────────────────────────── */
export default function BottomTabBar() {
  const activeTab = useF1Store((s) => s.activeTab);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const dockedLayout = useF1Store((s) => s.dockedLayout);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const focusOverlay = useF1Store((s) => s.focusOverlay);
  const showDashboard = useF1Store((s) => s.showDashboard);
  const toggleCommandPalette = useF1Store((s) => s.toggleCommandPalette);
  const dockItems = useF1Store((s) => s.dockItems);
  const setDockItems = useF1Store((s) => s.setDockItems);

  const [hoverRevealed, setHoverRevealed] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowAnchorRect, setOverflowAnchorRect] = useState(null);
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const [layoutsAnchorRect, setLayoutsAnchorRect] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [capacity, setCapacity] = useState(dockItems.length);
  const [dragId, setDragId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  const navRef = useRef(null);
  const overflowBtnRef = useRef(null);
  const layoutsBtnRef = useRef(null);
  const hideTimerRef = useRef(null);

  /* ── Persist dock items ─────────────────────────────────────── */
  useEffect(() => {
    try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(dockItems)); }
    catch { /* ignore */ }
  }, [dockItems]);

  /* ── Map ids → SLOT entries, drop stale ids defensively ─────── */
  // `settings` and `charts` have dedicated fixed buttons outside the dock,
  // so filter them out even if an older localStorage entry still has them.
  const EXCLUDED_FROM_DOCK = new Set(['settings', 'charts']);
  const displayTabs = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const id of dockItems) {
      if (seen.has(id) || !SLOT_IDS.has(id) || EXCLUDED_FROM_DOCK.has(id)) continue;
      const opt = SLOT_BY_ID.get(id);
      if (opt) { out.push(opt); seen.add(id); }
    }
    return out;
  }, [dockItems]);

  /* ── Capacity measurement (overflow handling) ───────────────── */
  useLayoutEffect(() => {
    const measure = () => {
      const vw = window.innerWidth;
      const usable = Math.min(vw - 40, 1800) - FIXED_OVERHEAD;
      const cap = Math.max(1, Math.floor(usable / DOCK_ITEM_WIDTH));
      setCapacity(cap);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const overflowing = displayTabs.length > capacity;
  const visibleTabs = overflowing ? displayTabs.slice(0, Math.max(1, capacity - 1)) : displayTabs;
  const overflowTabs = overflowing ? displayTabs.slice(visibleTabs.length) : [];

  /* ── Active / open state ────────────────────────────────────── */
  const dockedTabs = useMemo(() => {
    if (!dockedLayout) return [];
    const collect = (node) => {
      if (!node) return [];
      if (!node.children) return node.tabs || [];
      return [...collect(node.children[0]), ...collect(node.children[1])];
    };
    return collect(dockedLayout);
  }, [dockedLayout]);

  const isTabOpen = useCallback((tabId) => {
    if (tabId === 'pitwall') return activeTab === 'pitwall';
    if (tabId === 'settings') return activeTab === 'settings';
    if (dockedLayout) return dockedTabs.includes(tabId);
    return openOverlays.includes(tabId) || activeTab === tabId;
  }, [activeTab, dockedLayout, dockedTabs, openOverlays]);

  /* ── Auto-hide reveal ───────────────────────────────────────── */
  const isHidden = !showDashboard;
  useEffect(() => {
    if (!isHidden) { setHoverRevealed(false); return; }
    const onMouseMove = (e) => {
      if (e.clientY >= window.innerHeight - HOVER_ZONE_HEIGHT && !hoverRevealed) {
        clearTimeout(hideTimerRef.current);
        setHoverRevealed(true);
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    return () => { window.removeEventListener('mousemove', onMouseMove); clearTimeout(hideTimerRef.current); };
  }, [isHidden, hoverRevealed]);

  const handleMouseLeave = useCallback(() => {
    if (!isHidden) return;
    hideTimerRef.current = setTimeout(() => setHoverRevealed(false), 400);
  }, [isHidden]);
  const handleMouseEnter = useCallback(() => { clearTimeout(hideTimerRef.current); }, []);

  /* ── Handlers ───────────────────────────────────────────────── */
  const openContextMenuFor = useCallback((id, x, y) => {
    setCtxMenu({ target: id, x, y });
  }, []);

  const handleItemContextMenu = useCallback((id, e) => {
    e.preventDefault();
    openContextMenuFor(id, e.clientX, e.clientY);
  }, [openContextMenuFor]);

  const handleCustomizeDock = useCallback(() => {
    // Ensure the Settings overlay is open — never toggle it off here.
    if (openOverlays.includes('settings')) {
      focusOverlay('settings');
    } else {
      setActiveTab('settings');
    }
  }, [openOverlays, focusOverlay, setActiveTab]);

  const toggleOverflow = useCallback(() => {
    if (overflowOpen) { setOverflowOpen(false); return; }
    if (overflowBtnRef.current) {
      setOverflowAnchorRect(overflowBtnRef.current.getBoundingClientRect());
      setOverflowOpen(true);
    }
  }, [overflowOpen]);

  const toggleLayouts = useCallback(() => {
    if (layoutsOpen) { setLayoutsOpen(false); return; }
    if (layoutsBtnRef.current) {
      setLayoutsAnchorRect(layoutsBtnRef.current.getBoundingClientRect());
      setLayoutsOpen(true);
    }
  }, [layoutsOpen]);

  /* ── Drag-and-drop reorder ──────────────────────────────────── */
  const handleDragStart = useCallback((id, e) => {
    setDragId(id);
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/dock-item', id);
    } catch { /* some browsers throw in edge cases */ }
  }, []);

  const handleDragOver = useCallback((id, e) => {
    if (dragId == null || id === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTargetId !== id) setDropTargetId(id);
  }, [dragId, dropTargetId]);

  const handleDragLeave = useCallback((id) => {
    if (dropTargetId === id) setDropTargetId(null);
  }, [dropTargetId]);

  const handleDrop = useCallback((id, e) => {
    e.preventDefault();
    if (dragId == null || dragId === id) { setDragId(null); setDropTargetId(null); return; }
    const next = [...dockItems];
    const from = next.indexOf(dragId);
    const to = next.indexOf(id);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    const insertAt = to > from ? to : to;
    next.splice(insertAt, 0, dragId);
    setDockItems(next);
    setDragId(null);
    setDropTargetId(null);
  }, [dragId, dockItems, setDockItems]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDropTargetId(null);
  }, []);

  const hidden = isHidden && !hoverRevealed;

  return (
    <>
      {isHidden && !hoverRevealed && (
        <div className="bottom-tab-bar__trigger"
             onMouseEnter={() => { clearTimeout(hideTimerRef.current); setHoverRevealed(true); }}
        />
      )}
      <nav
        ref={navRef}
        className={`bottom-tab-bar${hidden ? ' bottom-tab-bar--hidden' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Dock items (data-driven) */}
        {visibleTabs.map((opt) => (
          <DockButton
            key={opt.id}
            option={opt}
            isOpen={isTabOpen(opt.id)}
            isDragging={dragId === opt.id}
            isDropTarget={dropTargetId === opt.id}
            onActivate={() => setActiveTab(opt.id)}
            onContextMenu={(e) => handleItemContextMenu(opt.id, e)}
            onDragStart={(e) => handleDragStart(opt.id, e)}
            onDragOver={(e) => handleDragOver(opt.id, e)}
            onDragEnter={(e) => handleDragOver(opt.id, e)}
            onDragLeave={() => handleDragLeave(opt.id)}
            onDrop={(e) => handleDrop(opt.id, e)}
            onDragEnd={handleDragEnd}
          />
        ))}

        {/* Overflow ⋯ */}
        {overflowing && (
          <button
            ref={overflowBtnRef}
            type="button"
            className={`bottom-tab-bar__tab bottom-tab-bar__tab--overflow${overflowOpen ? ' bottom-tab-bar__tab--active' : ''}`}
            onClick={toggleOverflow}
            title={`${overflowTabs.length} more dock item${overflowTabs.length === 1 ? '' : 's'}`}
          >
            <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5"  cy="12" r="1.3" />
              <circle cx="12" cy="12" r="1.3" />
              <circle cx="19" cy="12" r="1.3" />
            </svg>
          </button>
        )}

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', margin: '0 4px', flexShrink: 0 }} />

        {/* Layouts popover — classic layout + view picker */}
        <button
          ref={layoutsBtnRef}
          type="button"
          className={`bottom-tab-bar__tab${layoutsOpen ? ' bottom-tab-bar__tab--active' : ''}`}
          onClick={toggleLayouts}
          title="Layout presets & all views"
        >
          <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1" />
            <rect x="14" y="3" width="7" height="5" rx="1" />
            <rect x="14" y="12" width="7" height="9" rx="1" />
            <rect x="3" y="16" width="7" height="5" rx="1" />
          </svg>
          <span className="bottom-tab-bar__label">Layouts</span>
        </button>

        {/* Command Palette */}
        <button
          type="button"
          className="bottom-tab-bar__tab"
          onClick={() => toggleCommandPalette?.()}
          title="Command Palette [Ctrl+K]"
        >
          <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.35-4.35" />
          </svg>
          <span className="bottom-tab-bar__label">{'\u2318'}K</span>
        </button>

        {/* Settings — fixed, alongside the search icon */}
        <button
          type="button"
          className={`bottom-tab-bar__tab${activeTab === 'settings' ? ' bottom-tab-bar__tab--active' : ''}`}
          onClick={() => setActiveTab('settings')}
          title="Settings"
        >
          <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.15.67.4.89.72.22.33.34.72.34 1.12v.32c0 .4-.12.79-.34 1.12-.22.32-.53.57-.89.72z" />
          </svg>
          <span className="bottom-tab-bar__label">Settings</span>
        </button>
      </nav>

      {ctxMenu && (
        <DockContextMenu
          target={ctxMenu.target}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
          onCustomize={handleCustomizeDock}
        />
      )}

      {overflowOpen && overflowAnchorRect && (
        <DockOverflowPopover
          items={overflowTabs}
          anchorRect={overflowAnchorRect}
          onClose={() => setOverflowOpen(false)}
          onItemContext={openContextMenuFor}
        />
      )}

      {layoutsOpen && layoutsAnchorRect && (
        <LayoutDockPopover
          anchorRect={layoutsAnchorRect}
          onClose={() => setLayoutsOpen(false)}
        />
      )}
    </>
  );
}
