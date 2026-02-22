import React from 'react';
import TrackMap from '../visualizations/TrackMap';

export default function ChartsTabContent() {
  return (
    <div className="charts-tab">
      <div className="charts-tab__map">
        <TrackMap />
      </div>
    </div>
  );
}
