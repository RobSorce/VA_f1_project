import React, { useMemo } from 'react';
import { useF1Store, formatReplayClock } from '../../store/useF1Store';
import { useSessionNow } from '../../hooks/useSessionNow';
import { raceClockLimit } from '../../utils/raceTime';

const STATUS_MAP = {
  '1': { label: 'Green Flag', color: '#22c55e' },
  '2': { label: 'Yellow Flag', color: '#eab308' },
  '4': { label: 'Safety Car', color: '#f59e0b' },
  '5': { label: 'Red Flag', color: '#ef4444' },
  '6': { label: 'Virtual Safety Car', color: '#f97316' },
  '7': { label: 'Virtual Safety Car', color: '#f97316' },
};

/** Live feed times (epoch seconds or milliseconds, or an ISO string) as ms. */
function liveMs(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t < 1e12 ? t * 1000 : t;
  if (typeof t === 'string') return Date.parse(t) || 0;
  return 0;
}

function formatWallClock(ms) {
  if (!ms) return '--:--';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString();
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
  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);
  const lapTimes = useF1Store((s) => s.sessionData?.lap_times);
  // Replay: the changes up to the dashboard's clock; with the race over, up
  // to the leader's chequered flag (raceClockLimit), the flag pill's reading
  const sessionNow = useSessionNow();
  const limit = useMemo(() => raceClockLimit(lapTimes, sessionNow), [lapTimes, sessionNow]);
  // Changes only when a status change is reached, not on every replay tick
  const reached = useMemo(() => {
    if (isLiveMode) return (trackStatus || []).length;
    let n = 0;
    for (const e of trackStatus || []) if (Number(e?.start_time) <= limit) n++;
    return n;
  }, [trackStatus, limit, isLiveMode]);

  const messages = useMemo(() => {
    // Track status messages (flags, SC, VSC). Replay: only the changes that
    // have happened at the replay's now (start_time <= sessionNow, session
    // seconds; race over: by the chequered flag), timed on the replay clock
    // (start_time - sessionTimeOffset, the clock of the elapsed-time
    // capsule). Live: start_time is on the session clock too; the time shown
    // and the order among the race-control messages (whose timestamps are
    // wall clock) come from received_at, the wall clock of the change (epoch
    // s, D13). Without it (an older backend) no wall-clock time is known.
    const statusMsgs = [];
    for (const entry of trackStatus || []) {
      const info = STATUS_MAP[entry.status] || STATUS_MAP['1'];
      const start = Number(entry.start_time);
      if (isLiveMode) {
        const wall = entry.received_at != null ? liveMs(entry.received_at) : 0;
        statusMsgs.push({
          time: formatWallClock(wall),
          message: entry.message || info.label,
          color: info.color,
          sortKey: wall,
        });
        continue;
      }
      if (!Number.isFinite(start) || start > limit) continue;
      statusMsgs.push({
        time: formatReplayClock(start - sessionTimeOffset),
        message: entry.message || info.label,
        color: info.color,
        sortKey: start,
      });
    }

    // Live race control messages (penalties, directives, etc.)
    const rcMsgs = (isLiveMode && raceControlMessages?.length > 0)
      ? raceControlMessages.map((msg) => ({
          time: formatWallClock(liveMs(msg.timestamp)),
          message: msg.Message || msg.message || JSON.stringify(msg),
          color: msg.Flag === 'YELLOW' ? '#eab308'
            : msg.Flag === 'RED' ? '#ef4444'
            : msg.Flag === 'BLUE' ? '#3b82f6'
            : '#8b8fa3',
          sortKey: liveMs(msg.timestamp),
        }))
      : [];

    return [...statusMsgs, ...rcMsgs]
      .sort((a, b) => b.sortKey - a.sortKey);
    // `reached` stands for the clock limit: the list changes only when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackStatus, raceControlMessages, isLiveMode, sessionTimeOffset, reached]);

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
                {msg.time} &mdash; {msg.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
