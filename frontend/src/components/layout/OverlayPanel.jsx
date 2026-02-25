import React, { useState, useRef, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';

export default function OverlayPanel({ title, tabId, children }) {
  const closeOverlay = useF1Store((s) => s.closeOverlay);
  const focusOverlay = useF1Store((s) => s.focusOverlay);
  const isActive = useF1Store((s) => s.activeTab === tabId);
  const tileState = useF1Store((s) => s.overlayTiles[tabId] || null);
  const tileOverlay = useF1Store((s) => s.tileOverlay);
  const clearTile = useF1Store((s) => s.clearTile);
  const [floating, setFloating] = useState(false);

  const panelRef = useRef(null);
  const stateRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const [, forceRender] = useState(0);

  const getContainer = () => panelRef.current?.parentElement;

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

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = stateRef.current.x;
    const startY = stateRef.current.y;
    const cw = snap.cw;
    const ch = snap.ch;

    const onMove = (ev) => {
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;
      stateRef.current.x = Math.max(0, Math.min(cw - 100, startX + dx));
      stateRef.current.y = Math.max(0, Math.min(ch - 40, startY + dy));
      forceRender((n) => n + 1);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
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

      if (resizeE) newW = Math.max(240, Math.min(snap.cw - startX, startW + dx));
      if (resizeW) {
        const moved = Math.min(dx, startW - 240);            // don't shrink below min
        newX = Math.max(0, startX + moved);
        newW = startW - (newX - startX);
      }
      if (resizeS) newH = Math.max(150, Math.min(snap.ch - startY, startH + dy));
      if (resizeN) {
        const moved = Math.min(dy, startH - 150);
        newY = Math.max(0, startY + moved);
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
  const cls = [
    'overlay-panel',
    isActive && 'overlay-panel--active',
    isMaximized && 'overlay-panel--maximized',
    isTiled && `overlay-panel--tile-${tileState}`,
    isArranged && 'overlay-panel--arranged',
    floating && !isPositioned && 'overlay-panel--floating',
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
          {/* Edge handles */}
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
