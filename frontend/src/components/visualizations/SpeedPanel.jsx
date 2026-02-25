import React, { useRef, useCallback } from 'react';
import TelemetryStrip from './TelemetryStrip';
import { exportAsPng } from '../../utils/exportChart';

export default function SpeedPanel() {
  const panelRef = useRef(null);
  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, 'charts_telemetry.png');
  }, []);

  return (
    <div ref={panelRef} className="speed-panel">
      <div style={{
        display: 'flex', justifyContent: 'flex-end',
        padding: '4px 8px 0',
      }}>
        <button
          onClick={handleExport}
          title="Export as PNG"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 4,
            border: 'none', background: 'transparent',
            color: 'rgba(255,255,255,0.3)', cursor: 'pointer',
            fontSize: '12px', padding: 0, flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
      <TelemetryStrip embedded />
    </div>
  );
}
