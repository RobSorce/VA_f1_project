import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { PRESETS } from '../../utils/slotOptions';

/* ── Tab-to-slot mapping (bottom bar tab → analysis slot viz id) ── */
const TAB_TO_VIZ = {
  trackmap: 'trackmap',
  laptimes: 'laptimes',
  sectors: 'sectors',
  tyres: 'tiredeg',
  consistency: 'consistency',
  prediction: 'prediction',
  ai: 'gemini',
  compare: 'compare',
  analytics: 'analytics',
  championship: null, // no slot equivalent
  settings: 'settings',
};

const VIZ_TABS = [
  { id: 'trackmap',     label: 'Track Map',     icon: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v20M16 6v16', hint: '2' },
  { id: 'laptimes',     label: 'Lap Times',     icon: 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 6V2M10 2h4M12 12l2-2M22 12h-2M2 12h2M12 22v-2', hint: '3' },
  { id: 'sectors',      label: 'Sectors',       icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5', hint: '4' },
  { id: 'tyres',        label: 'Tyres',         icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', hint: '5' },
  { id: 'consistency',  label: 'Consistency',   icon: 'M22 12h-4l-3 9L9 3l-3 9H2', hint: '6' },
  { id: 'prediction',   label: 'Prediction',    icon: 'M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', hint: '7' },
  { id: 'ai',           label: 'AI',            icon: 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.27A7 7 0 0 1 7 14H6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 4-1.46V5.73A2 2 0 0 1 10 4a2 2 0 0 1 4 0z', hint: '8' },
  { id: 'compare',      label: 'Compare',       icon: 'M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5M21 3l-7 7M3 3l7 7M3 21l7-7M21 21l-7-7', hint: '9' },
  { id: 'analytics',    label: 'Analytics',     icon: 'M21 21H3V3m4 14l4-6 4 4 6-8', hint: '0' },
  { id: 'settings',     label: 'Settings',      icon: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
];

const HOVER_ZONE_HEIGHT = 12;

export default function BottomTabBar() {
  const layoutMode = useF1Store((s) => s.layoutMode);
  const setLayoutMode = useF1Store((s) => s.setLayoutMode);
  const setSlotContent = useF1Store((s) => s.setSlotContent);
  const applyPreset = useF1Store((s) => s.applyPreset);
  const showDashboard = useF1Store((s) => s.showDashboard);
  const [hoverRevealed, setHoverRevealed] = useState(false);
  const navRef = useRef(null);
  const hideTimerRef = useRef(null);

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

  const handleMouseEnter = useCallback(() => clearTimeout(hideTimerRef.current), []);

  const hidden = isHidden && !hoverRevealed;

  const handleTabClick = (tabId) => {
    if (layoutMode === 'pitwall') {
      // Switch to analysis mode with this viz in slot A
      const vizId = TAB_TO_VIZ[tabId];
      if (vizId) {
        setLayoutMode('analysis');
        setSlotContent('slotA', vizId);
      }
    } else {
      // In analysis mode, put viz in slot A
      const vizId = TAB_TO_VIZ[tabId];
      if (vizId) setSlotContent('slotA', vizId);
    }
  };

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
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 2, marginRight: 8, flexShrink: 0 }}>
          <button
            className={`bottom-tab-bar__tab${layoutMode === 'pitwall' ? ' bottom-tab-bar__tab--active' : ''}`}
            onClick={() => setLayoutMode('pitwall')}
            title="Pit Wall [P]"
            style={{ fontWeight: 700, fontSize: 9, letterSpacing: '0.06em' }}
          >
            <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3h18v4H3V3zm0 6h8v12H3V9zm10 0h8v5h-8V9zm0 7h8v5h-8v-5z" />
            </svg>
            <span className="bottom-tab-bar__label">Pit Wall</span>
            <kbd className="tab-kbd">P</kbd>
          </button>
          <button
            className={`bottom-tab-bar__tab${layoutMode === 'analysis' ? ' bottom-tab-bar__tab--active' : ''}`}
            onClick={() => setLayoutMode('analysis')}
            title="Analysis Mode"
            style={{ fontWeight: 700, fontSize: 9, letterSpacing: '0.06em' }}
          >
            <svg className="bottom-tab-bar__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 21H3V3m4 14l4-6 4 4 6-8" />
            </svg>
            <span className="bottom-tab-bar__label">Analysis</span>
          </button>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', flexShrink: 0, margin: '0 4px' }} />

        {/* Presets (visible in analysis mode) */}
        {layoutMode === 'analysis' && (
          <>
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button
                key={key}
                className="bottom-tab-bar__tab"
                onClick={() => applyPreset(preset)}
                title={`${preset.label} preset`}
                style={{ fontSize: 9, padding: '4px 8px', minWidth: 0 }}
              >
                <span className="bottom-tab-bar__label" style={{ fontSize: 9 }}>{preset.label}</span>
              </button>
            ))}
            <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', flexShrink: 0, margin: '0 4px' }} />
          </>
        )}

        {/* Visualization tabs */}
        {VIZ_TABS.map((tab) => (
          <button
            key={tab.id}
            className="bottom-tab-bar__tab"
            onClick={() => handleTabClick(tab.id)}
            title={tab.hint ? `${tab.label} [${tab.hint}]` : tab.label}
          >
            <svg
              className="bottom-tab-bar__icon"
              width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round"
            >
              <path d={tab.icon} />
            </svg>
            <span className="bottom-tab-bar__label">{tab.label}</span>
            {tab.hint && <kbd className="tab-kbd">{tab.hint}</kbd>}
          </button>
        ))}
      </nav>
    </>
  );
}
