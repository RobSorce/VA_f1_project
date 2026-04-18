import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import RacePaceGrid from '../visualizations/RacePaceGrid';
import TrackMap from '../visualizations/TrackMap';
import SessionInfoBar from '../ui/SessionInfoBar';
import WeatherMini from '../ui/WeatherMini';
import RaceControlFeed from '../ui/RaceControlFeed';
import GeminiQuickQuery from '../ui/GeminiQuickQuery';

export default function PitWallHome() {
  const sessionData = useF1Store((s) => s.sessionData);

  if (!sessionData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <span style={{ color: '#666', fontFamily: 'var(--font-mono)' }}>No session data loaded</span>
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateRows: '44px 1fr 35vh',
      height: '100%',
      width: '100%',
      overflow: 'hidden',
      gap: 1,
    }}>
      {/* Session info bar */}
      <SessionInfoBar />

      {/* Race Pace Grid — main centerpiece */}
      <div style={{ overflow: 'hidden', minHeight: 0 }}>
        <RacePaceGrid />
      </div>

      {/* Bottom row: TrackMap + Info sidebar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 280px',
        gap: 1,
        overflow: 'hidden',
        minHeight: 0,
      }}>
        <div style={{ overflow: 'hidden', display: 'flex', alignItems: 'stretch' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <TrackMap compact />
          </div>
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
  );
}
