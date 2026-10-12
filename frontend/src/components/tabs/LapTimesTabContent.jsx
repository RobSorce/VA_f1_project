import React, { useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import LapTimeChart from '../visualizations/LapTimeChart';
import LapDeltaChart from '../visualizations/LapDeltaChart';

const TABS = [
  { id: 'times', label: 'Lap Times' },
  { id: 'delta', label: 'Lap Delta' },
];

const tabPillStyle = (active) => ({
  padding: '3px 8px', fontSize: '9px', fontWeight: 600,
  borderRadius: 4, border: 'none', cursor: 'pointer',
  background: active ? 'rgba(229, 57, 53, 0.18)' : 'transparent',
  color: active ? '#ff5757' : 'rgba(255,255,255,0.45)',
  transition: 'background 0.12s, color 0.12s',
});

const splitBtnStyle = (active) => ({
  padding: '3px 6px', fontSize: '9px', fontWeight: 600,
  borderRadius: 4, border: 'none', cursor: 'pointer',
  marginLeft: 'auto',
  background: active ? 'rgba(229, 57, 53, 0.14)' : 'transparent',
  color: active ? '#ff5757' : 'rgba(255,255,255,0.3)',
  transition: 'background 0.12s, color 0.12s',
  display: 'inline-flex', alignItems: 'center', gap: 3,
});

/**
 * Lap Times tab — Lap Time Chart + Lap Delta Chart with a Tyres-style
 * tab toggle. Default view is "times". User can flip to "delta" or
 * use Split to show both. Auto-opening Lap Delta on focus-driver
 * change is now opt-in, not forced (H3 user control).
 */
export default function LapTimesTabContent() {
  const lapDeltaBaseDriver = useF1Store((s) => s.lapDeltaBaseDriver);
  const [activeTab, setActiveTab] = useState('times');
  const [splitView, setSplitView] = useState(false);

  return (
    <div className="laptimes-tab">
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setActiveTab(t.id); if (splitView) setSplitView(false); }}
            style={tabPillStyle(!splitView && activeTab === t.id)}
            disabled={t.id === 'delta' && !lapDeltaBaseDriver}
            title={t.id === 'delta' && !lapDeltaBaseDriver
              ? 'Lap Delta needs a focus driver — double-click a driver in the Leaderboard.'
              : undefined}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => setSplitView((v) => !v)}
          style={splitBtnStyle(splitView)}
          disabled={!lapDeltaBaseDriver}
          title={!lapDeltaBaseDriver
            ? 'Split needs both views — focus a driver to enable Lap Delta first.'
            : 'Show both charts stacked'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="9" height="4" rx="1" stroke="currentColor" strokeWidth="0.8" />
            <rect x="0.5" y="5.5" width="9" height="4" rx="1" stroke="currentColor" strokeWidth="0.8" />
          </svg>
          Split
        </button>
      </div>

      {/* Content */}
      {splitView && lapDeltaBaseDriver ? (
        <>
          <div className="laptimes-tab__chart">
            <LapTimeChart />
          </div>
          <div className="laptimes-tab__delta">
            <LapDeltaChart />
          </div>
        </>
      ) : (
        <div className="laptimes-tab__chart--full">
          {activeTab === 'delta' && lapDeltaBaseDriver
            ? <LapDeltaChart />
            : <LapTimeChart />}
        </div>
      )}
    </div>
  );
}
