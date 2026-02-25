import React from 'react';
import ChampionshipChart from '../visualizations/ChampionshipChart';
import ChampionshipStandings from '../visualizations/ChampionshipStandings';

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
