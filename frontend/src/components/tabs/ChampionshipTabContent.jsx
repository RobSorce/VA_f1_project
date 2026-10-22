import React from 'react';
import ChampionshipChart from '../visualizations/ChampionshipChart';
import ChampionshipStandings from '../visualizations/ChampionshipStandings';

// The points chart (its Predictions button draws the projection to the
// season end) above the standings bars
export default function ChampionshipTabContent() {
  return (
    <div className="championship-tab">
      <div className="championship-tab__chart">
        <ChampionshipChart />
      </div>
      <div className="championship-tab__standings">
        <ChampionshipStandings />
      </div>
    </div>
  );
}
