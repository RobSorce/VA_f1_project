import React from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';
import FocusDriverWidget from './components/ui/FocusDriverWidget';
import WelcomeToast from './components/ui/WelcomeToast';
import GeminiFloatingButton from './components/ui/GeminiFloatingButton';

// Layout
import OverlayPanel from './components/layout/OverlayPanel';
import PitWallLayout from './components/layout/PitWallLayout';
import DockedLayout from './components/layout/DockedLayout';

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
import ChampionshipTabContent from './components/tabs/ChampionshipTabContent';
import AnalyticsTabContent from './components/tabs/AnalyticsTabContent';
import RacePredictionPanel from './components/visualizations/RacePredictionPanel';
import StrategySimulator from './components/visualizations/StrategySimulator';
import StrategyTimeline from './components/visualizations/StrategyTimeline';

// Command Palette & Keyboard
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutHints from './components/ShortcutHints/ShortcutHints';
import ShortcutCheatsheet from './components/ShortcutCheatsheet/ShortcutCheatsheet';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

const OVERLAY_TABS = {
  laptimes: { title: 'Lap Times', Component: LapTimesTabContent },
  sectors: { title: 'Sectors & Speeds', Component: SectorsPanel },
  tyres: { title: 'Tyres', Component: TyresTabContent },
  speed: { title: 'Charts', Component: SpeedPanel },
  consistency: { title: 'Consistency', Component: ConsistencyPanel },
  ai: { title: 'AI Assistant', Component: AITabContent },
  analytics: { title: 'Analytics', Component: AnalyticsTabContent },
  prediction: { title: 'Race Prediction', Component: RacePredictionPanel },
  simulator: { title: 'Strategy Simulator', Component: StrategySimulator },
  strategy: { title: 'Strategy Timeline', Component: StrategyTimeline },
  championship: { title: 'Championship', Component: ChampionshipTabContent },
  settings: { title: 'Settings', Component: SettingsTabContent },
  compare: { title: 'Driver Comparison', Component: DriverComparePanel },
};

export default function App() {
  const sessionData = useF1Store((s) => s.sessionData);
  const activeTab = useF1Store((s) => s.activeTab);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const overlayVizMapping = useF1Store((s) => s.overlayVizMapping);
  const leaderboardCollapsed = useF1Store((s) => s.leaderboardCollapsed);
  const dockedLayout = useF1Store((s) => s.dockedLayout);

  // Activate global keyboard shortcuts
  useKeyboardShortcuts();

  // Show startup screen if no session loaded
  if (!sessionData) {
    return <SessionSelectorScreen />;
  }

  // Pit Wall is a standalone full-screen mode (no sidebar, no overlays)
  const isPitWall = activeTab === 'pitwall';
  // Docked layout mode (JetBrains-style split panes with tabs)
  const isDocked = !!dockedLayout && !isPitWall;

  return (
    <div className="app-container">
      <WeatherBar />
      <div className="app-body">
        {isPitWall ? (
          /* Pit Wall: full-width layout with its own sidebar */
          <PitWallLayout />
        ) : isDocked ? (
          /* Docked layout: JetBrains-style split panes */
          <>
            <aside className={`app-sidebar${leaderboardCollapsed ? ' app-sidebar--collapsed' : ''}`}>
              <Leaderboard collapsed={leaderboardCollapsed} />
              {!leaderboardCollapsed && <FocusDriverWidget />}
            </aside>
            <div className="app-center">
              <DockedLayout vizComponents={OVERLAY_TABS} />
            </div>
          </>
        ) : (
          /* Analysis mode: floating overlay windows */
          <>
            <aside className={`app-sidebar${leaderboardCollapsed ? ' app-sidebar--collapsed' : ''}`}>
              <Leaderboard collapsed={leaderboardCollapsed} />
              {!leaderboardCollapsed && <FocusDriverWidget />}
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
                    const effectiveTabId = overlayVizMapping[tabId] || tabId;
                    const config = OVERLAY_TABS[effectiveTabId];
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
          </>
        )}
      </div>
      <TimelinePlayer />
      <BottomTabBar />
      <DriverMFDCard />
      <GeminiFloatingButton />
      {/* Command Palette & Keyboard Overlays */}
      <CommandPalette />
      <ShortcutCheatsheet />
      <ShortcutHints />
      <WelcomeToast />
    </div>
  );
}
