import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import LapTimeChart from '../visualizations/LapTimeChart';
import LapDeltaChart from '../visualizations/LapDeltaChart';

export default function LapTimesTabContent() {
  const lapDeltaBaseDriver = useF1Store((s) => s.lapDeltaBaseDriver);
  const showDelta = !!lapDeltaBaseDriver;

  return (
    <div className="laptimes-tab">
      <div className={showDelta ? 'laptimes-tab__chart' : 'laptimes-tab__chart--full'}>
        <LapTimeChart />
      </div>
      {showDelta && (
        <div className="laptimes-tab__delta">
          <LapDeltaChart />
        </div>
      )}
    </div>
  );
}
