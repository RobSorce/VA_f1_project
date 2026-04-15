import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useF1Store } from '../../store/useF1Store';
const HOVER_ZONE_HEIGHT = 12;

// The 4 core VA pipeline tabs that stay visible in the dock
const CORE_TABS = [
  { id: 'laptimes',   label: 'Lap Times',   icon: 'M12 6v6l4 2M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0z',   hint: '2' },
  { id: 'analytics',  label: 'Analytics',   icon: 'M21 21H3V3m4 14l4-6 4 4 6-8',                             hint: '0' },
  { id: 'strategy',   label: 'Strategy',    icon: 'M3 3h18v6H3zM3 15h18v6H3zM8 9v6M16 9v6',                 hint: 'S' },
  { id: 'prediction', label: 'Prediction',  icon: 'M22 12h-4l-3 9L9 3l-3 9H2',                               hint: '7' },
];

// Views available inside the Layouts popover (everything NOT in CORE_TABS)
const POPOVER_VIEW_CATEGORIES = [
  {
    label: 'Track & Timing',
    views: [
      { id: 'trackmap', label: 'Track Map' },
      { id: 'lapdelta', label: 'Lap Delta' },
      { id: 'telemetry', label: 'Telemetry' },
      { id: 'racepace', label: 'Race Pace Grid' },
      { id: 'positionlaps', label: 'Position Tracker' },
    ],
  },
  {
    label: 'Tyres & Pace',
    views: [
      { id: 'tyres', label: 'Tyres' },
      { id: 'tiredeg', label: 'Tyre Degradation' },
      { id: 'tyrehealth', label: 'Tyre Health' },
      { id: 'tyremgmt', label: 'Pace Retention' },
      { id: 'sectors', label: 'Sectors & Speeds' },
      { id: 'speed', label: 'Speed Rankings' },
      { id: 'consistency', label: 'Consistency' },
    ],
  },
  {
    label: 'Strategy & Analysis',
    views: [
      { id: 'analysis', label: 'Strategy Analysis' },
      { id: 'racesituation', label: 'Race Situation' },
      { id: 'simulator', label: 'Strategy Simulator' },
      { id: 'compare', label: 'Driver Compare' },
    ],
  },
  {
    label: 'Simulation & AI',
    views: [
      { id: 'ai', label: 'AI Strategist' },
      { id: 'championship', label: 'Championship' },
    ],
  },
];

/* ─── Layout Selector Popover ─── */
function LayoutPopover({ anchorRef, onClose }) {
  const popoverRef = useRef(null);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      bottom: window.innerHeight - rect.top + 8,
      left: rect.left + rect.width / 2,
    });
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target) &&
          anchorRef.current && !anchorRef.current.contains(e.target)) {
        onClose();
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [onClose, anchorRef]);

  if (!pos) return null;

  return ReactDOM.createPortal(
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        bottom: pos.bottom,
        left: pos.left,
        transform: 'translateX(-50%)',
        zIndex: 10001,
        background: 'rgba(18, 18, 36, 0.96)',
        backdropFilter: 'blur(40px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 12,
        padding: 8,
        minWidth: 280,
        maxWidth: 340,
        boxShadow: '0 12px 48px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.3)',
        animation: 'overlayScaleIn 150ms ease-out',
      }}
    >
      {/* Views Section */}
      <div style={{ padding: '6px 8px 4px' }}>
        <span style={{
          fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          Add view
        </span>
      </div>
      {POPOVER_VIEW_CATEGORIES.map((cat) => (
        <div key={cat.label} style={{ padding: '0 4px', marginBottom: 4 }}>
          <span style={{
            fontSize: 8, color: 'rgba(255,255,255,0.25)', fontWeight: 600,
            padding: '0 6px', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            {cat.label}
          </span>
          {cat.views.map((v) => (
            <div
              key={v.id}
              onClick={() => { setActiveTab(v.id); onClose(); }}
              style={{
                padding: '5px 8px', cursor: 'pointer', fontSize: 11,
                color: 'rgba(255,255,255,0.7)', borderRadius: 6,
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                e.currentTarget.style.color = '#fff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'rgba(255,255,255,0.7)';
              }}
            >
              {v.label}
            </div>
          ))}
        </div>
      ))}

      {/* Close all / Home shortcut */}
      <div style={{
        padding: '6px 8px', marginTop: 4,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>
          Number keys for quick access
        </span>
        <button
          onClick={() => {
            useF1Store.getState().closeAllOverlays();
            onClose();
          }}
          style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, padding: '3px 10px', fontSize: 9, color: 'rgba(255,255,255,0.5)',
            cursor: 'pointer',
          }}
        >
          Close all views
        </button>
      </div>
    </div>,
    document.body
  );
}

/* ─── Main Hybrid BottomTabBar ─── */
export default function BottomTabBar() {
  const activeTab = useF1Store((s) => s.activeTab);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const dockedLayout = useF1Store((s) => s.dockedLayout);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const showDashboard = useF1Store((s) => s.showDashboard);
  const toggleCommandPalette = useF1Store((s) => s.toggleCommandPalette);

  const [hoverRevealed, setHoverRevealed] = useState(false);
  const [layoutPopoverOpen, setLayoutPopoverOpen] = useState(false);
  const navRef = useRef(null);
  const layoutBtnRef = useRef(null);
  const hideTimerRef = useRef(null);

  const isHidden = !showDashboard;
  const isPitWall = activeTab === 'pitwall';

  // Collect docked tabs for active state detection
  const dockedTabs = React.useMemo(() => {
    if (!dockedLayout) return [];
    const collect = (node) => {
      if (!node) return [];
      if (!node.children) return node.tabs || [];
      return [...collect(node.children[0]), ...collect(node.children[1])];
    };
    return collect(dockedLayout);
  }, [dockedLayout]);

  const isTabOpen = (tabId) =>
    dockedLayout ? dockedTabs.includes(tabId) : openOverlays.includes(tabId);

  // Auto-hide reveal logic
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

  const handleMouseEnter = useCallback(() => {
    clearTimeout(hideTimerRef.current);
  }, []);

  const hidden = isHidden && !hoverRevealed;

  return (
    <>
      {isHidden && !hoverRevealed && (
        <div
          className="bottom-tab-bar__trigger"
          onMouseEnter={() => { clearTimeout(hideTimerRef.current); setHoverRevealed(true); }}
        />
      )}
      <nav
        ref={navRef}
        className={`bottom-tab-bar${hidden ? ' bottom-tab-bar--hidden' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* 1. Pit Wall */}
        <button
          className={`bottom-tab-bar__tab${isPitWall ? ' bottom-tab-bar__tab--active' : ''}`}
          onClick={() => setActiveTab('pitwall')}
          title="Pit Wall Mode [P]"
        >
          <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3h18v18H3zM3 9h18M9 9v12M15 9v12" />
          </svg>
          <span className="bottom-tab-bar__label">Pit Wall</span>
          <kbd className="tab-kbd">P</kbd>
        </button>

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', margin: '0 2px', flexShrink: 0 }} />

        {/* 2-5. Core VA Pipeline Tabs */}
        {CORE_TABS.map((tab) => {
          const isOpen = isTabOpen(tab.id);
          return (
            <button
              key={tab.id}
              className={`bottom-tab-bar__tab${isOpen ? ' bottom-tab-bar__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              title={`${tab.label} [${tab.hint}]`}
            >
              <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={tab.icon} />
              </svg>
              <span className="bottom-tab-bar__label">{tab.label}</span>
              <kbd className="tab-kbd">{tab.hint}</kbd>
            </button>
          );
        })}

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', margin: '0 2px', flexShrink: 0 }} />

        {/* 6. Layout Selector (popover for presets + secondary views) */}
        <button
          ref={layoutBtnRef}
          className={`bottom-tab-bar__tab${layoutPopoverOpen ? ' bottom-tab-bar__tab--active' : ''}`}
          onClick={() => setLayoutPopoverOpen((v) => !v)}
          title="Layout presets & additional views"
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

        {/* 7. Command Palette */}
        <button
          className="bottom-tab-bar__tab"
          onClick={() => toggleCommandPalette?.()}
          title="Command Palette [Ctrl+K]"
        >
          <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.35-4.35" />
          </svg>
          <span className="bottom-tab-bar__label">&#8984;K</span>
        </button>

        {/* 8. Settings */}
        <button
          className="bottom-tab-bar__tab"
          onClick={() => setActiveTab('settings')}
          title="Settings"
        >
          <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          </svg>
          <span className="bottom-tab-bar__label">Settings</span>
        </button>
      </nav>

      {/* Layout Popover */}
      {layoutPopoverOpen && (
        <LayoutPopover
          anchorRef={layoutBtnRef}
          onClose={() => setLayoutPopoverOpen(false)}
        />
      )}
    </>
  );
}
