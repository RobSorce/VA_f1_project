import React, { useMemo, useRef } from 'react';
import { useF1Store, formatReplayClock } from '../../store/useF1Store';
import { useSessionNow } from '../../hooks/useSessionNow';
import { raceClockLimit } from '../../utils/raceTime';
import {
  TRACK_STATUS_STYLES, FLAG_COLORS, TEXT_COLORS, CHART_FONT, chartFontPx,
} from '../../utils/colors';
import { useBoxSize, fitRows } from '../../utils/views/chartBox';

// FIA flag colours of utils/colors.js; the message text names the flag (the
// colour of the dot is never the only cue)
const STATUS_MAP = TRACK_STATUS_STYLES;
const FLAG_MESSAGE_COLORS = { YELLOW: FLAG_COLORS.yellow, RED: FLAG_COLORS.red, BLUE: FLAG_COLORS.blue };

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

// The feed takes the room the Weather box leaves in the Pit Wall side
// column (flex 1, min-height 0): it shows the newest messages that fit,
// one line each (the full text in the tooltip), and counts the older ones
const panelStyle = {
  flex: '1 1 0',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  padding: '8px 12px',
  background: 'rgba(12,12,28,0.75)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

const titleStyle = {
  fontFamily: 'var(--font-primary)',
  fontSize: CHART_FONT.label, fontWeight: 700, color: TEXT_COLORS.muted,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 6,
  flex: 'none',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 6,
};

const ROW_GAP = 2;

export default function RaceControlFeed() {
  const listRef = useRef(null);
  const listBox = useBoxSize(listRef);
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
          color: FLAG_MESSAGE_COLORS[msg.Flag] || TEXT_COLORS.muted,
          sortKey: liveMs(msg.timestamp),
        }))
      : [];

    return [...statusMsgs, ...rcMsgs]
      .sort((a, b) => b.sortKey - a.sortKey);
    // `reached` stands for the clock limit: the list changes only when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackStatus, raceControlMessages, isLiveMode, sessionTimeOffset, reached]);

  // One line per message: data font x 1.3 + 4 px padding + 1 px rule
  const rowH = Math.ceil(chartFontPx('data') * 1.3) + 5;
  // unmeasured (0: server render, first paint): every message
  const fit = fitRows(listBox.height > 0 ? listBox.height + ROW_GAP : 0, messages.length, {
    rowMin: rowH + ROW_GAP, rowMax: rowH + ROW_GAP,
  });
  const shown = fit.paged ? messages.slice(0, fit.perPage) : messages;
  const older = messages.length - shown.length;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>
        <span>Race Control</span>
        {older > 0 && (
          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }} title="Older messages are in the Race Control panel">
            +{older} older
          </span>
        )}
      </div>
      {messages.length === 0 ? (
        <div style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.data }}>No race control messages</div>
      ) : (
        <div ref={listRef} style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
          {shown.map((msg, i) => (
            <div key={i} title={`${msg.time} — ${msg.message}`} style={{
              display: 'flex', alignItems: 'center', gap: 6, flex: 'none',
              height: rowH, boxSizing: 'border-box',
              padding: '2px 0', fontSize: CHART_FONT.data, lineHeight: 1.3,
              borderBottom: '1px solid rgba(255,255,255,0.03)',
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8,
                borderRadius: '50%', background: msg.color, flexShrink: 0,
              }} />
              <span style={{
                color: TEXT_COLORS.secondary, minWidth: 0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {msg.time} &mdash; {msg.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
