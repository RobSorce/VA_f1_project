import React, { useEffect } from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';
import FocusDriverWidget from './components/ui/FocusDriverWidget';
import WelcomeToast from './components/ui/WelcomeToast';

// Layout
import OverlayPanel from './components/layout/OverlayPanel';

// Visualizations
import Leaderboard from './components/visualizations/Leaderboard';
import SectorsPanel from './components/visualizations/SectorsPanel';
import SpeedPanel from './components/visualizations/SpeedPanel';
import ConsistencyPanel from './components/visualizations/ConsistencyPanel';
import DriverComparePanel from './components/visualizations/DriverComparePanel';
import TrackMap from './components/visualizations/TrackMap';

// Tab content
import ChartsTabContent from './components/tabs/ChartsTabContent';
import LapTimesTabContent from './components/tabs/LapTimesTabContent';
import AITabContent from './components/tabs/AITabContent';
import TyresTabContent from './components/tabs/TyresTabContent';
import SettingsTabContent from './components/tabs/SettingsTabContent';

// Command Palette & Keyboard
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutHints from './components/ShortcutHints/ShortcutHints';
import ShortcutCheatsheet from './components/ShortcutCheatsheet/ShortcutCheatsheet';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

const OVERLAY_TABS = {
  laptimes: { title: 'Lap Times', Component: LapTimesTabContent },
  sectors: { title: 'Sectors & Speeds', Component: SectorsPanel },
  tyres: { title: 'Tyres', Component: TyresTabContent },
  speed: { title: 'Speed / Telemetry', Component: SpeedPanel },
  consistency: { title: 'Consistency', Component: ConsistencyPanel },
  ai: { title: 'AI Assistant', Component: AITabContent },
  settings: { title: 'Settings', Component: SettingsTabContent },
  compare: { title: 'Driver Comparison', Component: DriverComparePanel },
};

export default function App() {
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const year = useF1Store((s) => s.year);
  const sessionData = useF1Store((s) => s.sessionData);
  const openOverlays = useF1Store((s) => s.openOverlays);

  // Activate global keyboard shortcuts
  useKeyboardShortcuts();

  useEffect(() => {
    fetchSchedule(year);
  }, [year, fetchSchedule]);

  // Show startup screen if no session loaded
  if (!sessionData) {
    return <SessionSelectorScreen />;
  }

  return (
    <div className="app-container">
      <WeatherBar />
      <div className="app-body">
        <aside className="app-sidebar">
          <Leaderboard />
          {openOverlays.length > 0 && (
            <div className="track-minimap">
              <TrackMap compact />
            </div>
          )}
        </aside>
        <div className="app-center">
          {/* Charts tab always renders underneath */}
          <ChartsTabContent />
          {/* Floating overlay windows */}
          {openOverlays.length > 0 && (
            <div className={`overlay-container overlay-container--count-${openOverlays.length}`}>
              {openOverlays.map((tabId) => {
                const config = OVERLAY_TABS[tabId];
                if (!config) return null;
                return (
                  <OverlayPanel key={tabId} title={config.title} tabId={tabId}>
                    <config.Component />
                  </OverlayPanel>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <TimelinePlayer />
      <BottomTabBar />
      <DriverMFDCard />
      <FocusDriverWidget />
      {/* Command Palette & Keyboard Overlays */}
      <CommandPalette />
      <ShortcutCheatsheet />
      <ShortcutHints />
      <WelcomeToast />
    </div>
  );
}
