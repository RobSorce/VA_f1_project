import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';

const TABS = [
  { id: 'charts', label: 'Track Map', icon: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v20M16 6v16', hint: '1' },
  { id: 'pitwall', label: 'Pit Wall', icon: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5zM4 9h16M9 4v16', hint: null },
  { id: 'laptimes', label: 'Lap Times', icon: 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 6V2M10 2h4M12 12l2-2M22 12h-2M2 12h2M12 22v-2', hint: '2' },
  { id: 'sectors', label: 'Sectors', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5', hint: '3' },
  { id: 'tyres', label: 'Tyres', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', hint: '4' },
  { id: 'speed', label: 'Charts', icon: 'M3 3v18h18M9 17V9m4 8V5m4 12v-4', hint: '5' },
  { id: 'consistency', label: 'Consistency', icon: 'M22 12h-4l-3 9L9 3l-3 9H2', hint: '6' },
  { id: 'prediction', label: 'Prediction', icon: 'M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', hint: '7' },
  { id: 'ai', label: 'AI Assistant', icon: 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.27A7 7 0 0 1 7 14H6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 4-1.46V5.73A2 2 0 0 1 10 4a2 2 0 0 1 4 0z', hint: '8' },
  { id: 'compare', label: 'Compare', icon: 'M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5M21 3l-7 7M3 3l7 7M3 21l7-7M21 21l-7-7', hint: '9' },
  { id: 'analytics', label: 'Analytics', icon: 'M21 21H3V3m4 14l4-6 4 4 6-8', hint: 'A' },
  { id: 'championship', label: 'Championship', icon: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6m12 5h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22m10 0c0-1.76-.85-3.25-2.03-3.79A1.09 1.09 0 0 1 14 17v-2.34M18 2H6v7a6 6 0 0 0 12 0V2z', hint: 'C' },
  { id: 'settings', label: 'Settings', icon: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', hint: '0' },
];

const HOVER_ZONE_HEIGHT = 12; // px from bottom edge that triggers reveal

export default function BottomTabBar() {
  const activeTab = useF1Store((s) => s.activeTab);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const setActiveTab = useF1Store((s) => s.setActiveTab);
  const showDashboard = useF1Store((s) => s.showDashboard);
  const [hoverRevealed, setHoverRevealed] = useState(false);
  const navRef = useRef(null);
  const hideTimerRef = useRef(null);

  const isHidden = !showDashboard;

  // When auto-hidden, reveal on mouse near bottom edge
  useEffect(() => {
    if (!isHidden) {
      setHoverRevealed(false);
      return;
    }

    const onMouseMove = (e) => {
      const nearBottom = e.clientY >= window.innerHeight - HOVER_ZONE_HEIGHT;
      if (nearBottom && !hoverRevealed) {
        clearTimeout(hideTimerRef.current);
        setHoverRevealed(true);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      clearTimeout(hideTimerRef.current);
    };
  }, [isHidden, hoverRevealed]);

  // Hide again when mouse leaves the bar area
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
      {/* Invisible trigger zone at the very bottom when auto-hidden */}
      {isHidden && !hoverRevealed && (
        <div
          className="bottom-tab-bar__trigger"
          onMouseEnter={() => {
            clearTimeout(hideTimerRef.current);
            setHoverRevealed(true);
          }}
        />
      )}
      <nav
        ref={navRef}
        className={`bottom-tab-bar${hidden ? ' bottom-tab-bar--hidden' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {TABS.map((tab) => {
          const isOpen = tab.id === 'charts'
            ? (activeTab === 'charts' && openOverlays.length === 0)
            : tab.id === 'pitwall'
              ? activeTab === 'pitwall'
              : openOverlays.includes(tab.id);

          return (
            <button
              key={tab.id}
              className={`bottom-tab-bar__tab${isOpen ? ' bottom-tab-bar__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.hint ? `${tab.label} [${tab.hint}]` : tab.label}
            >
              <svg
                className="bottom-tab-bar__icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={tab.icon} />
              </svg>
              <span className="bottom-tab-bar__label">{tab.label}</span>
              {tab.hint && <kbd className="tab-kbd">{tab.hint}</kbd>}
            </button>
          );
        })}
      </nav>
    </>
  );
}
