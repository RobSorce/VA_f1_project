import React from 'react';
import { useF1Store } from '../../store/useF1Store';

const TABS = [
  { id: 'charts', label: 'Charts', icon: 'M3 3v18h18M9 17V9m4 8V5m4 12v-4' },
  { id: 'laptimes', label: 'Lap Times', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0v10l6.93 4' },
  { id: 'sectors', label: 'Sectors', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { id: 'speed', label: 'Speed', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8' },
  { id: 'consistency', label: 'Consistency', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id: 'ai', label: 'AI Assistant', icon: 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.27A7 7 0 0 1 7 14H6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 4-1.46V5.73A2 2 0 0 1 10 4a2 2 0 0 1 4 0z' },
];

export default function BottomTabBar() {
  const activeTab = useF1Store((s) => s.activeTab);
  const setActiveTab = useF1Store((s) => s.setActiveTab);

  return (
    <nav className="bottom-tab-bar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`bottom-tab-bar__tab${activeTab === tab.id ? ' bottom-tab-bar__tab--active' : ''}`}
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
      ))}
    </nav>
  );
}
