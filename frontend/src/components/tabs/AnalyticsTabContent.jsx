import React, { useState } from 'react';
import RaceSituationMap from '../visualizations/RaceSituationMap';
import PCABiplot from '../visualizations/PCABiplot';
import StrategyAnalysis from '../visualizations/StrategyAnalysis';
import PCAAnalysisPanel from '../visualizations/PCAAnalysisPanel';

export default function AnalyticsTabContent() {
  const [view, setView] = useState('situation'); // 'situation' | 'biplot'

  return (
    <div className="analytics-tab">
      <div className="analytics-tab__scatterplot">
        <div className="analytics-tab__toggle">
          <button
            className={`analytics-tab__toggle-btn analytics-tab__toggle-btn--live${view === 'situation' ? ' active' : ''}`}
            onClick={() => setView('situation')}
          >
            Race Situation
          </button>
          <button
            className={`analytics-tab__toggle-btn${view === 'biplot' ? ' active' : ''}`}
            onClick={() => setView('biplot')}
          >
            PCA Biplot
          </button>
        </div>
        {view === 'situation' ? <RaceSituationMap /> : <PCABiplot />}
      </div>
      <div className="analytics-tab__analysis">
        {view === 'situation' ? <StrategyAnalysis /> : <PCAAnalysisPanel />}
      </div>
    </div>
  );
}
