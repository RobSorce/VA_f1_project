import React from 'react';
import TimingTower from '../visualizations/TimingTower';
import FocusDriverWidget from '../ui/FocusDriverWidget';
import PitWallSectorPanel from '../ui/PitWallSectorPanel';
import RacePaceGrid from '../visualizations/RacePaceGrid';
import TrackMap from '../visualizations/TrackMap';
import SessionInfoBar from '../ui/SessionInfoBar';
import WeatherMini from '../ui/WeatherMini';
import RaceControlFeed from '../ui/RaceControlFeed';
import GeminiQuickQuery from '../ui/GeminiQuickQuery';

const layoutStyle = {
  display: 'grid',
  gridTemplateColumns: '480px 1fr',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  gap: 1,
};

const sidebarStyle = {
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'rgba(12, 12, 28, 0.95)',
  borderRight: '1px solid rgba(255, 255, 255, 0.06)',
};

const mainStyle = {
  display: 'grid',
  gridTemplateRows: '44px 1fr 35vh',
  overflow: 'hidden',
  minHeight: 0,
};

const bottomRowStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 280px',
  gap: 1,
  overflow: 'hidden',
  minHeight: 0,
};

export default function PitWallLayout() {
  return (
    <div style={layoutStyle} className="pitwall-layout">
      {/* Left sidebar: Timing Tower */}
      <aside style={sidebarStyle}>
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <TimingTower />
        </div>
        <PitWallSectorPanel />
        <FocusDriverWidget />
      </aside>

      {/* Right: main content */}
      <div style={mainStyle}>
        <SessionInfoBar />
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <RacePaceGrid />
        </div>
        <div style={bottomRowStyle}>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>
            <TrackMap />
          </div>
          <div style={{
            overflowY: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(12,12,28,0.75)',
            borderLeft: '1px solid rgba(255,255,255,0.04)',
          }}>
            <WeatherMini />
            <RaceControlFeed />
            <GeminiQuickQuery />
          </div>
        </div>
      </div>
    </div>
  );
}
