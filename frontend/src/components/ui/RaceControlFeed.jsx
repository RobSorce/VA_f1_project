import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';

const STATUS_MAP = {
  '1': { label: 'Green Flag', color: '#22c55e' },
  '2': { label: 'Yellow Flag', color: '#eab308' },
  '4': { label: 'Safety Car', color: '#f59e0b' },
  '5': { label: 'Red Flag', color: '#ef4444' },
  '6': { label: 'Virtual Safety Car', color: '#f97316' },
  '7': { label: 'Virtual Safety Car', color: '#f97316' },
};

function formatTime(timeVal) {
  if (timeVal == null) return '--:--';
  if (typeof timeVal === 'string') {
    const parts = timeVal.split(':');
    if (parts.length >= 2) {
      return parts.slice(-2).map((p) => p.padStart(2, '0')).join(':');
    }
    return timeVal;
  }
  const totalSec = Math.floor(Number(timeVal));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const panelStyle = {
  padding: '10px 12px',
  background: 'rgba(12,12,28,0.75)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

const titleStyle = {
  fontFamily: "'Formula1', 'Titillium Web', sans-serif",
  fontSize: 10, fontWeight: 700, color: '#7a7f9a',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 8,
};

export default function RaceControlFeed() {
  const trackStatus = useF1Store((s) => s.trackStatus);
  const raceControlMessages = useF1Store((s) => s.raceControlMessages);
  const isLiveMode = useF1Store((s) => s.isLiveMode);

  const messages = useMemo(() => {
    // Track status messages (flags, SC, VSC)
    const statusMsgs = (trackStatus || []).map((entry) => {
      const info = STATUS_MAP[entry.status] || STATUS_MAP['1'];
      return {
        time: entry.start_time,
        message: entry.message || info.label,
        color: info.color,
        sortKey: typeof entry.start_time === 'number' ? entry.start_time : 0,
      };
    });

    // Live race control messages (penalties, directives, etc.)
    const rcMsgs = (isLiveMode && raceControlMessages?.length > 0)
      ? raceControlMessages.map((msg) => ({
          time: msg.timestamp,
          message: msg.Message || msg.message || JSON.stringify(msg),
          color: msg.Flag === 'YELLOW' ? '#eab308'
            : msg.Flag === 'RED' ? '#ef4444'
            : msg.Flag === 'BLUE' ? '#3b82f6'
            : '#8b8fa3',
          sortKey: msg.timestamp || 0,
        }))
      : [];

    return [...statusMsgs, ...rcMsgs]
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [trackStatus, raceControlMessages, isLiveMode]);

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Race Control</div>
      {messages.length === 0 ? (
        <div style={{ color: '#555', fontSize: 11 }}>No race control messages</div>
      ) : (
        <div style={{ maxHeight: 120, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '3px 0', fontSize: 10,
              borderBottom: '1px solid rgba(255,255,255,0.03)',
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              <span style={{
                display: 'inline-block', width: 6, height: 6,
                borderRadius: '50%', background: msg.color, flexShrink: 0,
              }} />
              <span style={{ color: '#bbc' }}>
                {formatTime(msg.time)} &mdash; {msg.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
