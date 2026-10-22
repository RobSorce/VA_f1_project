import React, { useEffect } from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';

// Layout
import OverlayPanel from './components/layout/OverlayPanel';

// Visualizations
import Leaderboard from './components/visualizations/Leaderboard';
import SectorsPanel from './components/visualizations/SectorsPanel';
import SpeedPanel from './components/visualizations/SpeedPanel';
import ConsistencyPanel from './components/visualizations/ConsistencyPanel';

// Tab content
import ChartsTabContent from './components/tabs/ChartsTabContent';
import LapTimesTabContent from './components/tabs/LapTimesTabContent';

const OVERLAY_TABS = {
  laptimes: { title: 'Lap Times', Component: LapTimesTabContent },
  sectors: { title: 'Sectors & Speeds', Component: SectorsPanel },
  speed: { title: 'Speed / Telemetry', Component: SpeedPanel },
  consistency: { title: 'Consistency', Component: ConsistencyPanel },
};

export default function App() {
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const year = useF1Store((s) => s.year);
  const sessionData = useF1Store((s) => s.sessionData);
  const activeTab = useF1Store((s) => s.activeTab);

  useEffect(() => {
    fetchSchedule(year);
  }, [year, fetchSchedule]);

  // Show startup screen if no session loaded
  if (!sessionData) {
    return <SessionSelectorScreen />;
  }

  const overlay = OVERLAY_TABS[activeTab];

  return (
    <div className="app-container">
      <WeatherBar />
      <div className="app-body">
        <aside className="app-sidebar">
          <Leaderboard />
        </aside>
        <div className="app-center">
          {/* Charts tab always renders underneath */}
          <ChartsTabContent />
          {/* Full-screen overlay panel */}
          {overlay && (
            <OverlayPanel title={overlay.title}>
              <overlay.Component />
            </OverlayPanel>
          )}
        </div>
      </div>
      <TimelinePlayer />
      <BottomTabBar />
      <DriverMFDCard />
    </div>
  );
}
