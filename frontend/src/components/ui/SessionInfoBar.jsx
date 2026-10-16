import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import { SURFACES, TRACK_STATUS_STYLES, tintedChip } from '../../utils/colors';

// Track status chip: FIA colour on its tint, always with its label (the
// colour is never the only cue), the text lifted to 4.5:1 on the tint
// (tintedChip, utils/colors.js). Code '1' reads "Track clear".
function flagChip(status) {
  const st = TRACK_STATUS_STYLES[status] || TRACK_STATUS_STYLES['1'];
  const label = status === '1' || !TRACK_STATUS_STYLES[status] ? 'Track clear' : st.short;
  return { label, ...tintedChip(st.color, 0.15, SURFACES.panel) };
}

export default function SessionInfoBar() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const currentFlagStatus = useF1Store((s) => s.currentFlagStatus);
  const liveSessionInfo = useF1Store((s) => s.liveSessionInfo);

  const eventName = sessionData?.event_name
    || sessionData?.circuit_info?.event_name
    || liveSessionInfo?.event_name
    || 'Unknown Event';
  const sessionType = sessionData?.session_type
    || liveSessionInfo?.session_name
    || liveSessionInfo?.session_type
    || '';
  const flag = flagChip(currentFlagStatus);
  const title = `${eventName}${sessionType ? ` — ${sessionType}` : ''}`;

  return (
    <div className="session-info-bar">
      <div className="session-info-bar__event" title={title}>{title}</div>

      <span className="session-info-bar__lap">
        Lap <strong>{currentLap}</strong> / {totalRaceLaps || maxLap}
      </span>

      {/* static: it pulsed down to opacity 0.8 (flag-pulse), its RED FLAG label read 4.15:1 */}
      <span
        className="session-info-bar__flag"
        style={{
          background: flag.background,
          color: flag.color,
          borderColor: flag.borderColor,
        }}
      >
        {flag.label}
      </span>
    </div>
  );
}
