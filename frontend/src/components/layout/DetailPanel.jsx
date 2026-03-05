import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import LapTimeChart from '../visualizations/LapTimeChart';
import LapDeltaChart from '../visualizations/LapDeltaChart';
import StrategyTimeline from '../visualizations/StrategyTimeline';
import TireSilhouette from '../visualizations/TireSilhouette';
import RaceSituationMap from '../visualizations/RaceSituationMap';
import StrategyAnalysis from '../visualizations/StrategyAnalysis';
import GeminiAssistant from '../visualizations/GeminiAssistant';
import TireDegradation from '../visualizations/TireDegradation';

export default function DetailPanel() {
  const activePanel = useF1Store((s) => s.activePanel);
  const closePanel = useF1Store((s) => s.closePanel);
  if (!activePanel) return null;

  return (
    <div className="detail-panel">
      <div className="detail-panel__header">
        <span className="detail-panel__title">
          {activePanel === 'timing' && 'Timing & Delta'}
          {activePanel === 'strategy' && 'Strategy'}
          {activePanel === 'analytics' && 'Analytics'}
          {activePanel === 'ai' && 'AI Assistant'}
          {activePanel === 'degradation' && 'Tyre Degradation'}
        </span>
        <button className="detail-panel__close" onClick={closePanel} title="Close panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="detail-panel__content">
        {activePanel === 'timing' && (
          <>
            <div style={{ flex: '1 1 50%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <LapTimeChart />
            </div>
            <div style={{ flex: '1 1 50%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <LapDeltaChart />
            </div>
          </>
        )}
        {activePanel === 'strategy' && (
          <>
            <div style={{ flex: '1 1 65%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <StrategyTimeline />
            </div>
            <div style={{ flex: '0 0 35%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <TireSilhouette />
            </div>
          </>
        )}
        {activePanel === 'analytics' && (
          <>
            <div style={{ flex: '1 1 55%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <RaceSituationMap />
            </div>
            <div style={{ flex: '1 1 45%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <StrategyAnalysis />
            </div>
          </>
        )}
        {activePanel === 'ai' && (
          <>
            <div style={{ flex: '1 1 50%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <StrategyTimeline showOverlays />
            </div>
            <div style={{ flex: '1 1 50%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <GeminiAssistant />
            </div>
          </>
        )}
        {activePanel === 'degradation' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <TireDegradation />
          </div>
        )}
      </div>
    </div>
  );
}
