import React from 'react';
import { useF1Store } from '../../store/useF1Store';

const PANELS = [
  { id: 'timing',      label: 'Timing',    icon: 'M3 3h18v2H3V3zm0 4h12v2H3V7zm0 4h18v2H3v-2zm0 4h12v2H3v-2zm0 4h18v2H3v-2z' },
  { id: 'strategy',    label: 'Strategy',   icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2V7zm0 8h2v2h-2v-2z' },
  { id: 'analytics',   label: 'Analytics',  icon: 'M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z' },
  { id: 'degradation', label: 'Tyres',      icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z' },
];

export default function PanelToggleBar() {
  const activePanel = useF1Store((s) => s.activePanel);
  const setActivePanel = useF1Store((s) => s.setActivePanel);

  return (
    <div className="panel-toggle-bar">
      {PANELS.map((p) => {
        const isActive = activePanel === p.id;
        return (
          <button
            key={p.id}
            className={`panel-toggle-btn ${isActive ? 'panel-toggle-btn--active' : ''}`}
            onClick={() => setActivePanel(p.id)}
            title={p.label}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d={p.icon} />
            </svg>
            <span className="panel-toggle-btn__label">{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}
