import React from 'react';
import TelemetryStrip from './TelemetryStrip';

export default function SpeedPanel() {
  return (
    <div className="speed-panel">
      <TelemetryStrip embedded />
    </div>
  );
}
