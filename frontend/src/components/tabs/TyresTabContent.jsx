import React, { useState } from 'react';
import TyreHealth from '../visualizations/TyreHealth';
import TyreManagement from '../visualizations/TyreManagement';
import { CHART_FONT, TEXT_COLORS, tintedChip, TYRE_COLORS, SURFACES } from '../../utils/colors';

const TABS = [
  { id: 'health', label: 'Tyre Health' },
  { id: 'pace', label: 'Pace Retention' },
];

// Active pill: a tint of the medium-compound yellow, its text lifted to
// 4.5:1 on that tint (tintedChip)
const ACTIVE = tintedChip(TYRE_COLORS.MEDIUM, 0.15, SURFACES.panel);
const tabPillStyle = (active) => ({
  padding: '3px 8px', fontSize: CHART_FONT.label, fontWeight: 600,
  borderRadius: 4, border: 'none', cursor: 'pointer',
  background: active ? ACTIVE.background : 'transparent',
  color: active ? ACTIVE.color : TEXT_COLORS.muted,
  transition: 'background 0.12s, color 0.12s',
});

const splitBtnStyle = (active) => ({
  padding: '3px 6px', fontSize: CHART_FONT.label, fontWeight: 600,
  borderRadius: 4, border: 'none', cursor: 'pointer',
  marginLeft: 'auto',
  background: active ? ACTIVE.background : 'transparent',
  color: active ? ACTIVE.color : TEXT_COLORS.muted,
  transition: 'background 0.12s, color 0.12s',
  display: 'inline-flex', alignItems: 'center', gap: 3,
});

export default function TyresTabContent() {
  const [activeTab, setActiveTab] = useState('health');
  const [splitView, setSplitView] = useState(false);

  return (
    <div className="tyres-tab">
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => { setActiveTab(t.id); if (splitView) setSplitView(false); }}
            style={tabPillStyle(!splitView && activeTab === t.id)}
          >
            {t.label}
          </button>
        ))}
        <button onClick={() => setSplitView(v => !v)} style={splitBtnStyle(splitView)}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="9" height="4" rx="1" stroke="currentColor" strokeWidth="0.8" />
            <rect x="0.5" y="5.5" width="9" height="4" rx="1" stroke="currentColor" strokeWidth="0.8" />
          </svg>
          Split
        </button>
      </div>

      {/* Content */}
      {splitView ? (
        <>
          <div className="tyres-tab__health">
            <TyreHealth />
          </div>
          <div className="tyres-tab__management">
            <TyreManagement />
          </div>
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {activeTab === 'health' ? <TyreHealth /> : <TyreManagement />}
        </div>
      )}
    </div>
  );
}
