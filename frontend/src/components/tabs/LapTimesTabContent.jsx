import React from 'react';
import LapTimeChart from '../visualizations/LapTimeChart';
import LapDeltaChart from '../visualizations/LapDeltaChart';

export default function LapTimesTabContent() {
  return (
    <div className="laptimes-tab">
      <div className="laptimes-tab__chart">
        <LapTimeChart />
      </div>
      <div className="laptimes-tab__delta">
        <LapDeltaChart />
      </div>
    </div>
  );
}
