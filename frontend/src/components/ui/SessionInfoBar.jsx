import React from 'react';
import { useF1Store } from '../../store/useF1Store';

const FLAG_CLS = {
  '1': { bg: 'rgba(34,197,94,0.15)', color: '#22c55e', label: 'TRACK CLEAR' },
  '2': { bg: 'rgba(255,204,0,0.15)', color: '#FFCC00', label: 'YELLOW FLAG' },
  '4': { bg: 'rgba(255,140,0,0.15)', color: '#FF8C00', label: 'SAFETY CAR' },
  '5': { bg: 'rgba(255,0,0,0.15)',   color: '#FF0000', label: 'RED FLAG' },
  '6': { bg: 'rgba(255,140,0,0.15)', color: '#FF8C00', label: 'VSC' },
  '7': { bg: 'rgba(255,140,0,0.15)', color: '#FF8C00', label: 'VSC' },
};

export default function SessionInfoBar() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
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
  const flag = FLAG_CLS[currentFlagStatus] || FLAG_CLS['1'];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      height: '100%', padding: '0 16px',
      background: 'rgba(12,12,28,0.85)',
      backdropFilter: 'blur(20px) saturate(1.6)',
      WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      fontFamily: "'Formula1', 'Titillium Web', sans-serif",
      color: '#e0e0e0',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#fff' }}>
        {eventName}{sessionType ? ` \u2014 ${sessionType}` : ''}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#7a7f9a', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          LAP <strong style={{ color: '#fff', fontSize: 14 }}>{currentLap}</strong> / {maxLap}
        </span>
      </div>

      <span style={{
        padding: '4px 12px', borderRadius: 4,
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase',
        background: flag.bg, color: flag.color,
        animation: currentFlagStatus !== '1' ? 'flag-pulse 1.5s ease-in-out infinite' : 'none',
      }}>
        {flag.label}
      </span>
    </div>
  );
}
