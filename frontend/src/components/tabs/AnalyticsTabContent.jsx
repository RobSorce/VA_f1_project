import React from 'react';
import RaceSituationMap from '../visualizations/RaceSituationMap';
import StrategyAnalysis from '../visualizations/StrategyAnalysis';

export default function AnalyticsTabContent() {
  return (
    <div className="analytics-tab">
      <div className="analytics-tab__scatterplot">
        <RaceSituationMap />
      </div>
      <div className="analytics-tab__analysis">
        <StrategyAnalysis />
      </div>
    </div>
  );
}
