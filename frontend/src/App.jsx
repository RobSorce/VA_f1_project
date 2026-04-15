import React from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';
import FocusDriverWidget from './components/ui/FocusDriverWidget';
import PitWallSectorPanel from './components/ui/PitWallSectorPanel';
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
import LapDeltaChart from './components/visualizations/LapDeltaChart';
import TireDegradation from './components/visualizations/TireDegradation';
import TyreHealth from './components/visualizations/TyreHealth';
import TyreManagement from './components/visualizations/TyreManagement';
import RaceSituationMap from './components/visualizations/RaceSituationMap';
import TelemetryStrip from './components/visualizations/TelemetryStrip';
import StrategyAnalysis from './components/visualizations/StrategyAnalysis';
import RacePaceGrid from './components/visualizations/RacePaceGrid';
import PositionByLap from './components/visualizations/PositionByLap';

// Command Palette & Keyboard
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutHints from './components/ShortcutHints/ShortcutHints';
import ShortcutCheatsheet from './components/ShortcutCheatsheet/ShortcutCheatsheet';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

const OVERLAY_TABS = {
  trackmap: { title: 'Track Map', Component: TrackMap },
  laptimes: { title: 'Lap Times', Component: LapTimesTabContent },
  lapdelta: { title: 'Lap Delta', Component: LapDeltaChart },
  sectors: { title: 'Sectors & Speeds', Component: SectorsPanel },
  tyres: { title: 'Tyres', Component: TyresTabContent },
  tiredeg: { title: 'Tyre Degradation', Component: TireDegradation },
  tyrehealth: { title: 'Tyre Health', Component: TyreHealth },
  tyremgmt: { title: 'Pace Retention', Component: TyreManagement },
  speed: { title: 'Speed Rankings', Component: SpeedPanel },
  consistency: { title: 'Consistency', Component: ConsistencyPanel },
  ai: { title: 'AI Assistant', Component: AITabContent },
  analytics: { title: 'Analytics', Component: AnalyticsTabContent },
  prediction: { title: 'Race Prediction', Component: RacePredictionPanel },
  simulator: { title: 'Strategy Simulator', Component: StrategySimulator },
  strategy: { title: 'Strategy Timeline', Component: StrategyTimeline },
  analysis: { title: 'Strategy Analysis', Component: StrategyAnalysis },
  racesituation: { title: 'Race Situation', Component: RaceSituationMap },
  racepace: { title: 'Race Pace Grid', Component: RacePaceGrid },
  telemetry: { title: 'Telemetry', Component: TelemetryStrip },
  championship: { title: 'Championship', Component: ChampionshipTabContent },
  settings: { title: 'Settings', Component: SettingsTabContent },
  compare: { title: 'Driver Comparison', Component: DriverComparePanel },
  positionlaps: { title: 'Position Tracker', Component: PositionByLap },
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

  const isPitWall = activeTab === 'pitwall';
  const isDocked = !!dockedLayout && !isPitWall;

  return (
    <div className="app-container">
      <WeatherBar />
      <div className="app-body">
        {isPitWall ? (
          /* Monitor mode: Pit Wall full-screen layout */
          <PitWallLayout />
        ) : isDocked ? (
          /* Analyze mode: docked split-pane workspace */
          <>
            <aside className={`app-sidebar${leaderboardCollapsed ? ' app-sidebar--collapsed' : ''}`}>
              <Leaderboard collapsed={leaderboardCollapsed} />
              {!leaderboardCollapsed && <PitWallSectorPanel />}
              {!leaderboardCollapsed && <FocusDriverWidget />}
            </aside>
            <div className="app-center">
              <DockedLayout vizComponents={OVERLAY_TABS} />
            </div>
          </>
        ) : (
          /* Base state: no analysis workspace open */
          <>
            <aside className={`app-sidebar${leaderboardCollapsed ? ' app-sidebar--collapsed' : ''}`}>
              <Leaderboard collapsed={leaderboardCollapsed} />
              {!leaderboardCollapsed && <FocusDriverWidget />}
            </aside>
            <div className="app-center">
              <ChartsTabContent />
            </div>
          </>
        )}
      </div>

      {/* ── Utility floating overlays — render on top of ANY mode ── */}
      {openOverlays.length > 0 && (
        <div className="utility-overlay-container">
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
