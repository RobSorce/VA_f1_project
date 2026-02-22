import React from 'react';
import { useF1Store } from '../../store/useF1Store';

const TABS = [
  { id: 'charts', label: 'Charts', icon: 'M3 3v18h18M9 17V9m4 8V5m4 12v-4' },
  { id: 'laptimes', label: 'Lap Times', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0v10l6.93 4' },
  { id: 'sectors', label: 'Sectors', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { id: 'tyres', label: 'Tyres', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
  { id: 'speed', label: 'Speed', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8' },
  { id: 'consistency', label: 'Consistency', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id: 'ai', label: 'AI Assistant', icon: 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.27A7 7 0 0 1 7 14H6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 4-1.46V5.73A2 2 0 0 1 10 4a2 2 0 0 1 4 0z' },
  { id: 'settings', label: 'Settings', icon: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
];

export default function BottomTabBar() {
  const openOverlays = useF1Store((s) => s.openOverlays);
  const setActiveTab = useF1Store((s) => s.setActiveTab);

  return (
    <nav className="bottom-tab-bar">
      {TABS.map((tab) => {
        // 'charts' is always the background — highlight when no overlays open
        const isOpen = tab.id === 'charts'
          ? openOverlays.length === 0
          : openOverlays.includes(tab.id);

        return (
          <button
            key={tab.id}
            className={`bottom-tab-bar__tab${isOpen ? ' bottom-tab-bar__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
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
          </button>
        );
      })}
    </nav>
  );
}
