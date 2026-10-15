import React, { useState } from 'react';
import ChampionshipChart from '../visualizations/ChampionshipChart';
import ChampionshipStandings from '../visualizations/ChampionshipStandings';
import GeminiAssistant from '../visualizations/GeminiAssistant';
import { TEXT_COLORS, CHART_FONT } from '../../utils/colors';

const SUBTABS = [
  { id: 'standings', label: 'Standings' },
  { id: 'prediction', label: 'Prediction & AI' },
];

export default function ChampionshipTabContent() {
  const [subtab, setSubtab] = useState('standings');

  return (
    <div className="championship-tab">
      {/* Segmented control */}
      <div style={{
        display: 'flex', gap: 2, padding: '6px 12px 4px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSubtab(t.id)}
            style={{
              padding: '5px 14px',
              fontSize: CHART_FONT.label,
              fontWeight: subtab === t.id ? 700 : 500,
              fontFamily: "'Titillium Web', sans-serif",
              // the inactive sub-tab in the muted text colour (>= 4.5:1, it read 4.52:1 at white 0.45)
              color: subtab === t.id ? TEXT_COLORS.primary : TEXT_COLORS.muted,
              background: subtab === t.id ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: '1px solid',
              borderColor: subtab === t.id ? 'rgba(255,255,255,0.12)' : 'transparent',
              borderRadius: 6,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              letterSpacing: '0.03em',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {subtab === 'standings' ? (
        <>
          <div className="championship-tab__chart">
            <ChampionshipChart />
          </div>
          <div className="championship-tab__standings">
            <ChampionshipStandings />
          </div>
        </>
      ) : (
        <>
          <div className="championship-tab__chart">
            <ChampionshipChart showPredictions />
          </div>
          <div className="championship-tab__standings" style={{ minHeight: 0 }}>
            <GeminiAssistant />
          </div>
        </>
      )}
    </div>
  );
}
