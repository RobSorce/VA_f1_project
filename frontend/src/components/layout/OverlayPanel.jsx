import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';


// Default sizes for overlay panels (width, height).
// These are "desktop-ideal" values — they are clamped against the real
// container on mount, and additionally reduced by `pickDefaultSize()` on
// sub-1440 viewports so the panel never opens flush against every edge.
const PANEL_SIZES = {
  settings: [820, 580],
  championship: [880, 600],
};
const DEFAULT_SIZE = [700, 520];
const MIN_W = 420;
const MIN_H = 320;
const EDGE_PAD = 8;

/**
 * Derive the effective default size for a tabId given the live container.
 * On small viewports we return a percentage of the container so panels open
 * at ~82 % × 82 %, leaving room for the user to see what's behind them.
 * Desktop (>=1440×900) keeps the designer-chosen hard-coded sizes.
 */
function pickDefaultSize(tabId, containerW, containerH) {
  const designed = PANEL_SIZES[tabId] || DEFAULT_SIZE;
  const isSmall = window.innerWidth < 1440 || window.innerHeight < 900;
  if (!isSmall) return designed;
  const w = Math.max(MIN_W, Math.min(designed[0], Math.floor(containerW * 0.82)));
  const h = Math.max(MIN_H, Math.min(designed[1], Math.floor(containerH * 0.82)));
  return [w, h];
}

export default function OverlayPanel({ title, tabId, children, autoFit = false, helpText, helpHref, hasHelp = false }) {
  // On sub-1440 viewports autoFit fights a too-small container and can
  // end up suppressing the content's own overflow scroll. Disable it so
  // the panel opens at its (capped) max height and the inner component's
  // native overflow:auto engages. See SCROLL_HEURISTIC_EVALUATION.md S4.
  if (autoFit && (window.innerWidth < 1440 || window.innerHeight < 900)) {
    autoFit = false;
  }
  const openHelp = useF1Store((s) => s.openHelp);
  const closeOverlay = useF1Store((s) => s.closeOverlay);
  const focusOverlay = useF1Store((s) => s.focusOverlay);
  const isActive = useF1Store((s) => s.activeTab === tabId);
  const tileState = useF1Store((s) => s.overlayTiles[tabId] || null);
  const tileOverlay = useF1Store((s) => s.tileOverlay);
  const clearTile = useF1Store((s) => s.clearTile);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const [floating, setFloating] = useState(!tileState);

  const panelRef = useRef(null);
  // Initialize with centered default based on panel type
  const initRef = useRef(false);
  const [w, h] = PANEL_SIZES[tabId] || DEFAULT_SIZE;
  const cascadeIdx = openOverlays.indexOf(tabId);
  const offset = Math.max(0, cascadeIdx) * 24;
  // Provisional — will be re-centered against the real container after mount.
  const stateRef = useRef({
    x: Math.max(0, (window.innerWidth - w) / 2 + offset),
    y: Math.max(0, (window.innerHeight - h) / 2 + offset),
    w, h,
  });
  const [, forceRender] = useState(0);

  // Auto-fit: height follows content (expand/collapse). Disabled once the
  // user manually resizes so we respect their chosen size.
  const userResizedRef = useRef(false);
  const [isInteracting, setIsInteracting] = useState(false);

  const getContainer = () => panelRef.current?.parentElement;

  // After mount, measure the real container and center/clamp the panel so it's
  // fully visible regardless of viewport size or reserved bottom space
  // (timeline player + bottom tab bar).
  useEffect(() => {
    if (initRef.current) return;
    const container = getContainer();
    if (!container) return;
    const cr = container.getBoundingClientRect();
    if (cr.width <= 0 || cr.height <= 0) return;

    const [pw, ph] = pickDefaultSize(tabId, cr.width, cr.height);
    const safeW = Math.max(MIN_W, Math.min(pw, cr.width - EDGE_PAD * 2));
    const safeH = Math.max(MIN_H, Math.min(ph, cr.height - EDGE_PAD * 2));
    const x = Math.max(EDGE_PAD, Math.min(cr.width - safeW - EDGE_PAD, (cr.width - safeW) / 2 + offset));
    const y = Math.max(EDGE_PAD, Math.min(cr.height - safeH - EDGE_PAD, (cr.height - safeH) / 2 + offset));

    stateRef.current = { x, y, w: safeW, h: safeH };
    initRef.current = true;
    forceRender((n) => n + 1);
  }, [tabId, offset]);

  // ── Auto-fit height to content ────────────────────────────────
  // Observes the inner content and shrinks/grows the panel to match.
  // Stops once the user manually resizes (userResizedRef).
  useEffect(() => {
    if (!autoFit) return;
    if (!floating) return;
    const content = panelRef.current?.querySelector('.overlay-panel__content');
    const inner = content?.firstElementChild;
    if (!inner) return;

    const measure = () => {
      if (userResizedRef.current) return;
      if (tileState) return; // skip when tiled/maximized/arranged
      const container = getContainer();
      if (!container) return;
      const cr = container.getBoundingClientRect();
      if (cr.height <= 0) return;
      const header = panelRef.current?.querySelector('.overlay-panel__header');
      const headerH = header?.offsetHeight || 36;
      // inner uses max-height:100% so scrollHeight reflects the natural
      // content height even when the viewport clamps it.
      const natural = inner.scrollHeight;
      const target = natural + headerH + 2; // +border
      const maxH = Math.max(MIN_H, cr.height - EDGE_PAD * 2);
      const clamped = Math.min(Math.max(MIN_H, target), maxH);
      const st = stateRef.current;
      if (Math.abs(st.h - clamped) > 1) {
        const newY = Math.max(EDGE_PAD, Math.min(cr.height - clamped - EDGE_PAD, st.y));
        stateRef.current = { ...st, h: clamped, y: newY };
        forceRender((n) => n + 1);
      }
    };

    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    // Catch layout changes triggered by conditional rendering (e.g. accordion
    // section bodies appearing/disappearing). ResizeObserver alone may miss
    // these when max-height caps the element box.
    const mo = new MutationObserver(() => requestAnimationFrame(measure));
    mo.observe(inner, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [autoFit, floating, tileState]);

  // If the viewport shrinks or the reserved bottom grows (timeline expanded),
  // keep the panel inside the container.
  useEffect(() => {
    const onResize = () => {
      const container = getContainer();
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const st = stateRef.current;
      const maxW = Math.max(MIN_W, cr.width - EDGE_PAD * 2);
      const maxH = Math.max(MIN_H, cr.height - EDGE_PAD * 2);
      const newW = Math.min(st.w, maxW);
      const newH = Math.min(st.h, maxH);
      const newX = Math.max(EDGE_PAD, Math.min(cr.width - newW - EDGE_PAD, st.x));
      const newY = Math.max(EDGE_PAD, Math.min(cr.height - newH - EDGE_PAD, st.y));
      if (newW !== st.w || newH !== st.h || newX !== st.x || newY !== st.y) {
        stateRef.current = { x: newX, y: newY, w: newW, h: newH };
        forceRender((n) => n + 1);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const snapshotRect = () => {
    const panel = panelRef.current;
    const container = getContainer();
    if (!panel || !container) return null;
    const pr = panel.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    return {
      x: pr.left - cr.left,
      y: pr.top - cr.top,
      w: pr.width,
      h: pr.height,
      cw: cr.width,
      ch: cr.height,
    };
  };

  // Tile state can be a string ('left','right','maximize') or object ({ left, top, width, height })
  const isArranged = typeof tileState === 'object' && tileState !== null;
  const isTiled = tileState === 'left' || tileState === 'right';
  const isMaximized = tileState === 'maximize';
  const isPositioned = isTiled || isMaximized || isArranged;

  // ── Drag via header ────────────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    if (e.target.closest('button')) return;
    if (isMaximized) return;
    e.preventDefault();

    const snap = snapshotRect();
    if (!snap) return;

    // Clear tile/arrange state when user starts dragging
    if (tileState) {
      clearTile(tabId);
    }

    // Snapshot current visual position as starting point for floating
    stateRef.current = { x: snap.x, y: snap.y, w: snap.w, h: snap.h };
    if (!floating) setFloating(true);
    setIsInteracting(true);

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = stateRef.current.x;
    const startY = stateRef.current.y;
    const cw = snap.cw;
    const ch = snap.ch;
    const pw = snap.w;
    const ph = snap.h;

    const onMove = (ev) => {
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;
      stateRef.current.x = Math.max(EDGE_PAD, Math.min(cw - pw - EDGE_PAD, startX + dx));
      stateRef.current.y = Math.max(EDGE_PAD, Math.min(ch - ph - EDGE_PAD, startY + dy));
      forceRender((n) => n + 1);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsInteracting(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [isMaximized, floating, tileState, tabId, clearTile]);

  // ── Resize from any edge/corner ────────────────────────────────
  // direction: combination of 'n','s','e','w' e.g. 'se', 'n', 'nw'
  const handleResizeStart = useCallback((direction, e) => {
    if (isPositioned) return;
    e.preventDefault();
    e.stopPropagation();

    const snap = snapshotRect();
    if (!snap) return;

    if (!floating) {
      stateRef.current = { x: snap.x, y: snap.y, w: snap.w, h: snap.h };
      setFloating(true);
    }
    // User took size into their own hands — stop auto-fitting.
    userResizedRef.current = true;
    setIsInteracting(true);

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = stateRef.current.x;
    const startY = stateRef.current.y;
    const startW = stateRef.current.w;
    const startH = stateRef.current.h;

    const resizeN = direction.includes('n');
    const resizeS = direction.includes('s');
    const resizeW = direction.includes('w');
    const resizeE = direction.includes('e');

    const onMove = (ev) => {
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;

      let newX = startX, newY = startY, newW = startW, newH = startH;

      if (resizeE) newW = Math.max(MIN_W, Math.min(snap.cw - startX - EDGE_PAD, startW + dx));
      if (resizeW) {
        const moved = Math.min(dx, startW - MIN_W);            // don't shrink below min
        newX = Math.max(EDGE_PAD, startX + moved);
        newW = startW - (newX - startX);
      }
      if (resizeS) newH = Math.max(MIN_H, Math.min(snap.ch - startY - EDGE_PAD, startH + dy));
      if (resizeN) {
        const moved = Math.min(dy, startH - MIN_H);
        newY = Math.max(EDGE_PAD, startY + moved);
        newH = startH - (newY - startY);
      }

      stateRef.current.x = newX;
      stateRef.current.y = newY;
      stateRef.current.w = newW;
      stateRef.current.h = newH;
      forceRender((n) => n + 1);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsInteracting(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [isPositioned, floating]);

  // ── Maximize / Restore ─────────────────────────────────────────
  const handleToggleMaximize = useCallback(() => {
    if (isMaximized || isArranged) {
      clearTile(tabId);
    } else {
      tileOverlay(tabId, 'maximize');
    }
  }, [isMaximized, isArranged, tabId, clearTile, tileOverlay]);

  // Double-click header to toggle maximize
  const handleHeaderDblClick = useCallback((e) => {
    if (e.target.closest('button')) return;
    handleToggleMaximize();
  }, [handleToggleMaximize]);

  // Bring to front on any click/interaction
  const handlePanelMouseDown = useCallback(() => {
    if (!isActive) focusOverlay(tabId);
  }, [isActive, focusOverlay, tabId]);

  // Build class and style
  const smoothResize = autoFit && floating && !isPositioned && !isInteracting && !userResizedRef.current;
  const cls = [
    'overlay-panel',
    isActive && 'overlay-panel--active',
    isMaximized && 'overlay-panel--maximized',
    isTiled && `overlay-panel--tile-${tileState}`,
    isArranged && 'overlay-panel--arranged',
    floating && !isPositioned && 'overlay-panel--floating',
    autoFit && 'overlay-panel--autofit',
    smoothResize && 'overlay-panel--smooth',
  ].filter(Boolean).join(' ');

  let panelStyle;
  if (isArranged) {
    // Arranged panels use percentage-based inline styles from the layout
    panelStyle = {
      left: tileState.left,
      top: tileState.top,
      width: tileState.width,
      height: tileState.height,
    };
  } else if (!isMaximized && !isTiled && floating) {
    const st = stateRef.current;
    panelStyle = { left: st.x, top: st.y, width: st.w, height: st.h };
  }

  const showRestore = isMaximized || isArranged;

  return (
    <div ref={panelRef} className={cls} style={panelStyle} onMouseDown={handlePanelMouseDown}>
      <div
        className="overlay-panel__header"
        onMouseDown={handleDragStart}
        onDoubleClick={handleHeaderDblClick}
      >
        <span className="overlay-panel__title">{title}</span>
        <div className="overlay-panel__controls">
          {(hasHelp || helpText) && (
            <button
              className="overlay-panel__btn overlay-panel__btn--help"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // New behaviour: open the in-app help overlay with the full
                // structured entry (summary + how-to-read + limitations +
                // see-also + docs link). Falls back to opening helpHref in a
                // new tab if a panel was wired the old way and no registry
                // entry exists.
                if (hasHelp) openHelp(tabId, title);
                else if (helpHref) window.open(helpHref, '_blank', 'noopener');
              }}
              aria-label={`About ${title}`}
              title={helpText || `About ${title}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <circle cx="12" cy="16" r="0.6" fill="currentColor" />
              </svg>
            </button>
          )}
          <button
            className="overlay-panel__btn"
            onClick={handleToggleMaximize}
            aria-label={showRestore ? 'Restore panel' : 'Maximize panel'}
            title={showRestore ? 'Restore' : 'Maximize'}
          >
            {showRestore ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="7" width="14" height="14" rx="2" />
                <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            )}
          </button>
          <button
            className="overlay-panel__btn overlay-panel__btn--close"
            onClick={() => closeOverlay(tabId)}
            aria-label="Close panel"
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="overlay-panel__content">
        {children}
      </div>
      {!isPositioned && (
        <>
          {/* Edge handles — inside panel boundary for overflow:hidden compat */}
          <div className="overlay-panel__edge overlay-panel__edge--n" onMouseDown={(e) => handleResizeStart('n', e)} />
          <div className="overlay-panel__edge overlay-panel__edge--s" onMouseDown={(e) => handleResizeStart('s', e)} />
          <div className="overlay-panel__edge overlay-panel__edge--w" onMouseDown={(e) => handleResizeStart('w', e)} />
          <div className="overlay-panel__edge overlay-panel__edge--e" onMouseDown={(e) => handleResizeStart('e', e)} />
          {/* Corner handles */}
          <div className="overlay-panel__corner overlay-panel__corner--nw" onMouseDown={(e) => handleResizeStart('nw', e)} />
          <div className="overlay-panel__corner overlay-panel__corner--ne" onMouseDown={(e) => handleResizeStart('ne', e)} />
          <div className="overlay-panel__corner overlay-panel__corner--sw" onMouseDown={(e) => handleResizeStart('sw', e)} />
          <div className="overlay-panel__corner overlay-panel__corner--se" onMouseDown={(e) => handleResizeStart('se', e)} />
        </>
      )}
    </div>
  );
}
