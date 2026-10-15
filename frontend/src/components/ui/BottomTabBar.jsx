import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { SLOT_OPTIONS, SLOT_IDS } from '../../utils/slotOptions';
import { DOCK_STORAGE_KEY } from '../../store/useF1Store';
import DockContextMenu from './DockContextMenu';
import DockOverflowPopover from './DockOverflowPopover';
import LayoutDockPopover from './LayoutDockPopover';
import DockCustomizePopover from './DockCustomizePopover';
import { dockCapacity, dockRow } from '../../utils/dockCapacity';

const HOVER_ZONE_HEIGHT = 12;
// Width of the ⋯ overflow button (6 + 10 px padding each side, 18 px icon),
// reserved only when some dock items do not fit
const OVERFLOW_BUTTON_W = 44;

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
  const [customizeAnchor, setCustomizeAnchor] = useState(null);
  // Items shown on the dock's one row; Infinity = render all and measure.
  // setMeasureGen: a new render, so a new measure, even when the capacity
  // is already Infinity (all the items fitted, then the fonts loaded)
  const [capacity, setCapacity] = useState(Infinity);
  const [, setMeasureGen] = useState(0);
  const [dragId, setDragId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  const navRef = useRef(null);
  const overflowBtnRef = useRef(null);
  const layoutsBtnRef = useRef(null);
  const hideTimerRef = useRef(null);
  const itemEls = useRef(new Map());

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
  // The dock never scrolls (V13): with every item rendered, the real button
  // widths (labels follow the type tokens) and everything else on the bar
  // (padding, border, gaps, the divider with its margins, the fixed group)
  // are measured, and dockCapacity says how many items fit next to the ⋯
  // button. A resize, a change of the items or the web fonts finishing to
  // load (the Formula1 labels are wider than the fallback's) renders them all
  // again and re-measures; after every render the row is checked once more
  // and one more item goes to the ⋯ popover while it overflows (D2).
  useLayoutEffect(() => { setCapacity(Infinity); }, [displayTabs]);
  useEffect(() => {
    const reset = () => { setCapacity(Infinity); setMeasureGen((g) => g + 1); };
    window.addEventListener('resize', reset);
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    let live = true;
    fonts?.addEventListener?.('loadingdone', reset);
    fonts?.ready?.then?.(() => { if (live) reset(); });
    return () => {
      live = false;
      window.removeEventListener('resize', reset);
      fonts?.removeEventListener?.('loadingdone', reset);
    };
  }, []);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof window === 'undefined') return;
    const cs = window.getComputedStyle(nav);
    const px = (v) => parseFloat(v) || 0;
    const gap = px(cs.columnGap);
    const box = {
      gap,
      paddingLeft: px(cs.paddingLeft),
      paddingRight: px(cs.paddingRight),
      borderLeft: px(cs.borderLeftWidth),
      borderRight: px(cs.borderRightWidth),
    };
    const part = (el) => {
      const s = window.getComputedStyle(el);
      return { width: el.getBoundingClientRect().width, marginLeft: px(s.marginLeft), marginRight: px(s.marginRight) };
    };
    const available = px(cs.maxWidth) || window.innerWidth - 40;
    const children = [...nav.children];
    if (capacity === Infinity) {
      const items = new Set(itemEls.current.values());
      const fixedWidth = dockRow(children.filter((el) => !items.has(el)).map(part), box);
      const widths = displayTabs.map((o) => {
        const el = itemEls.current.get(o.id);
        return el ? dockRow([part(el)]) : 0;
      });
      const cap = dockCapacity(widths, { available, fixedWidth, overflowWidth: OVERFLOW_BUTTON_W, gap });
      if (cap < displayTabs.length) setCapacity(cap);
      return;
    }
    // The row as rendered (items shown, ⋯, divider, fixed group): one more
    // item to the popover while it is wider than the bar
    if (capacity > 1 && dockRow(children.map(part), box) > available + 0.5) setCapacity(Math.min(capacity, displayTabs.length) - 1);
  });

  const overflowing = displayTabs.length > capacity;
  const visibleTabs = overflowing ? displayTabs.slice(0, Math.max(1, capacity)) : displayTabs;
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
    // Open the inline DockCustomizePopover anchored to the dock — no
    // detour through the Settings overlay (H7 efficiency of use).
    const rect = navRef.current?.getBoundingClientRect();
    if (rect) setCustomizeAnchor(rect);
  }, []);

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
            ref={(el) => { if (el) itemEls.current.set(opt.id, el); else itemEls.current.delete(opt.id); }}
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

        {/* Separator — marks transition from reorderable dock items to
            fixed system buttons (H4/V4.1). */}
        <div className="bottom-tab-bar__divider" aria-hidden="true" />

        {/* Layouts popover — classic layout + view picker */}
        <button
          ref={layoutsBtnRef}
          type="button"
          className={`bottom-tab-bar__tab bottom-tab-bar__tab--fixed${layoutsOpen ? ' bottom-tab-bar__tab--active' : ''}`}
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
          className="bottom-tab-bar__tab bottom-tab-bar__tab--fixed"
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
          className={`bottom-tab-bar__tab bottom-tab-bar__tab--fixed${activeTab === 'settings' ? ' bottom-tab-bar__tab--active' : ''}`}
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

      {customizeAnchor && (
        <DockCustomizePopover
          anchorRect={customizeAnchor}
          onClose={() => setCustomizeAnchor(null)}
        />
      )}
    </>
  );
}
