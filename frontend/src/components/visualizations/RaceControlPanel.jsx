import React, { useMemo, useState } from 'react';
import { useF1Store, formatReplayClock } from '../../store/useF1Store';
import { useSessionNow } from '../../hooks/useSessionNow';
import { getDriverColor } from '../../utils/colors';
import { lapWindows, leaderLapAt, raceClockLimit } from '../../utils/raceTime';
import { causalKey } from '../../utils/strategyViews';
import { driverStateAt, nonFinisherMap } from '../../utils/driverState';

/* -- Race control category styling --------------------------------------- */
// Maps the F1 SignalR `Category` string + flag/colour to a user-readable
// label, an accent colour, and a glyph. Categories the official feed emits:
// "Flag", "Drs", "SafetyCar", "CarEvent", "Other" (and a few rarely-seen).
const CATEGORY_META = {
  Flag:       { label: 'Flag',       color: '#FFD500', icon: 'F' },
  Drs:        { label: 'DRS',        color: '#3b82f6', icon: 'D' },
  SafetyCar:  { label: 'Safety Car', color: '#FF8C00', icon: 'S' },
  CarEvent:   { label: 'Car Event',  color: '#22c55e', icon: 'C' },
  Other:      { label: 'Other',      color: '#9aa0b3', icon: '·' },
  Penalty:    { label: 'Penalty',    color: '#ef4444', icon: 'P' },
  Stewards:   { label: 'Stewards',   color: '#ef4444', icon: 'S' },
};

const FLAG_META = {
  GREEN:    { color: '#22c55e', label: 'Green' },
  YELLOW:   { color: '#eab308', label: 'Yellow' },
  DOUBLE_YELLOW: { color: '#eab308', label: 'Double Yellow' },
  RED:      { color: '#ef4444', label: 'Red' },
  BLUE:     { color: '#3b82f6', label: 'Blue' },
  CHEQUERED:{ color: '#fff',    label: 'Chequered' },
  CLEAR:    { color: '#22c55e', label: 'Clear' },
};

const TRACK_STATUS_META = {
  '1': { label: 'Track clear',          color: '#22c55e' },
  '2': { label: 'Yellow flag',          color: '#eab308' },
  '3': { label: 'Yellow flag',          color: '#eab308' },
  '4': { label: 'Safety Car',           color: '#FF8C00' },
  '5': { label: 'Red flag',             color: '#ef4444' },
  '6': { label: 'Virtual Safety Car',   color: '#f97316' },
  '7': { label: 'VSC ending',           color: '#f97316' },
};

function classifyCategory(msg) {
  // Best-effort categorisation when the live feed gives us something
  // unfamiliar. Penalty / investigation lines come through Category="Other"
  // with the keyword in the message body.
  if (msg.category && CATEGORY_META[msg.category]) return msg.category;
  const txt = (msg.message || '').toLowerCase();
  if (txt.includes('penalty') || txt.includes('drive through') || txt.includes('stop and go')) {
    return 'Penalty';
  }
  if (txt.includes('investigation') || txt.includes('noted')) return 'Stewards';
  if (txt.includes('drs')) return 'Drs';
  if (txt.includes('safety car') || txt.includes('vsc')) return 'SafetyCar';
  if (msg.flag) return 'Flag';
  return 'Other';
}

function formatTime(ts) {
  if (!ts) return '--:--:--';
  if (typeof ts === 'string') {
    // SignalR uses ISO strings — show HH:MM:SS
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toLocaleTimeString();
    return ts.split('T')[1]?.split('.')[0] || ts;
  }
  if (typeof ts === 'number') {
    // Unix epoch (sec or ms)
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString();
  }
  return '--:--:--';
}

/**
 * Sort key in ms: numbers under 1e12 are seconds (live epoch seconds, or
 * session seconds in a replay, where every item is on that clock), larger
 * ones ms; ISO strings are parsed.
 */
function toMs(ts) {
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  return Date.parse(ts) || 0;
}

/* -- Driver chip --------------------------------------------------------- */
function DriverChip({ abbr, color }) {
  if (!abbr) return null;
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: '0.04em',
      background: `${color}26`,
      borderLeft: `3px solid ${color}`,
      color: '#fff',
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {abbr}
    </span>
  );
}

/* -- Main panel ---------------------------------------------------------- */
export default function RaceControlPanel() {
  const raceControlMessages = useF1Store((s) => s.raceControlMessages || []);
  const trackStatus         = useF1Store((s) => s.trackStatus || []);
  const dnfMap              = useF1Store((s) => s.dnfMap || {});
  const drivers             = useF1Store((s) => s.drivers || []);
  const isLiveMode          = useF1Store((s) => s.isLiveMode);
  const liveConnected       = useF1Store((s) => s.liveConnected);
  const currentLap          = useF1Store((s) => s.currentLap);
  const totalRaceLaps       = useF1Store((s) => s.totalRaceLaps);
  const currentFlagStatus   = useF1Store((s) => s.currentFlagStatus);
  const teamRadios          = useF1Store((s) => s.teamRadios || []);
  // Autoplay state lives in the store so the floating RadioPipToast
  // (which owns the actual <audio> element) can react to it from
  // anywhere in the app.
  const autoplay            = useF1Store((s) => s.radioAutoplay);
  const toggleAutoplay      = useF1Store((s) => s.toggleRadioAutoplay);
  const selectedDrivers     = useF1Store((s) => s.selectedDrivers || []);
  const focusDriver         = useF1Store((s) => s.focusDriver);
  const lapTimes            = useF1Store((s) => s.sessionData?.lap_times);
  const sessionTimeOffset   = useF1Store((s) => s.sessionTimeOffset);
  // Replay: the list shows only what has happened at the replay's now
  // (session seconds); live: Infinity, everything received so far
  const sessionNow = useSessionNow();
  // Changes only when a lap, a pit event or a status change is reached, not
  // on every replay tick
  const nowKey = useMemo(
    () => (isLiveMode ? 'live' : causalKey(lapTimes, sessionNow, trackStatus)),
    [isLiveMode, lapTimes, sessionNow, trackStatus],
  );
  const windows = useMemo(() => lapWindows(lapTimes), [lapTimes]);

  const [filter, setFilter] = useState('All');
  const [showRetirements, setShowRetirements] = useState(true);
  const [showTeamRadio, setShowTeamRadio] = useState(true);

  // Hint text for the toggle: tells the user *which* drivers' radios will
  // actually play given the current selection. Implicit control beats
  // adding another dropdown.
  const autoplayHint = (() => {
    if (selectedDrivers.length === 1) return `auto-plays ${selectedDrivers[0]}`;
    if (selectedDrivers.length > 1)   return `auto-plays ${selectedDrivers.length} selected`;
    if (focusDriver)                  return `auto-plays ${focusDriver} (focus)`;
    return 'select a driver to auto-play';
  })();

  // Index driver_number → abbreviation so penalty lines like "Car 16 (LEC)"
  // can show a coloured chip.
  const numberToAbbr = useMemo(() => {
    const m = {};
    for (const d of drivers) {
      const num = String(d.DriverNumber ?? d.driver_number ?? d.RacingNumber ?? '');
      if (num) m[num] = d.Abbreviation || d.abbreviation;
    }
    return m;
  }, [drivers]);

  /* -- Build unified timeline: race control msgs + track-status changes --- */
  const timeline = useMemo(() => {
    const items = [];

    // Race control messages
    for (const m of raceControlMessages) {
      const cat = classifyCategory(m);
      items.push({
        kind: 'rc',
        category: cat,
        flag: (m.flag || '').toUpperCase().replace(' ', '_'),
        message: m.message || m.Message || '',
        driverNum: String(m.driver_number || m.RacingNumber || ''),
        lap: m.lap ?? m.Lap ?? null,
        timestamp: m.timestamp || m.Utc || Date.now(),
      });
    }

    // Track-status transitions — keep only changes (state -> state) so we
    // don't duplicate every "Track clear" tick. Replay: only changes that
    // have happened at the replay's now (start_time <= sessionNow), timed on
    // the replay clock (start_time - sessionTimeOffset, the elapsed-time
    // capsule's clock) and placed on the leader's lap at that time
    // (utils/raceTime.js leaderLapAt, the rule of the timeline and backend).
    // Live: wall-clock times, the lap the store stamped on arrival.
    let prev = null;
    // With the race over (Infinity) the list stops at the leader's chequered
    // flag (raceClockLimit), the reading of the flag pill.
    const limit = raceClockLimit(lapTimes, sessionNow);
    const sortedTS = [...trackStatus].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
    for (const t of sortedTS) {
      const start = Number(t.start_time);
      if (!isLiveMode && (!Number.isFinite(start) || start > limit)) continue;
      const code = String(t.status ?? '1');
      if (code === prev) continue;
      prev = code;
      const meta = TRACK_STATUS_META[code] || TRACK_STATUS_META['1'];
      items.push({
        kind: 'track',
        category: code === '1' ? 'Flag' : (code === '4' || code === '6' || code === '7') ? 'SafetyCar' : 'Flag',
        flag: code === '5' ? 'RED' : code === '1' ? 'GREEN' : 'YELLOW',
        message: t.message || meta.label,
        lap: isLiveMode
          ? (t.start_lap ?? null)
          : (windows.length ? leaderLapAt(windows, start) : null),
        timestamp: isLiveMode ? (t.start_time || Date.now()) : start,
        replayClock: isLiveMode ? null : start - sessionTimeOffset,
      });
    }

    items.sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));

    return items;
    // nowKey stands for sessionNow: the list changes only when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceControlMessages, trackStatus, isLiveMode, sessionTimeOffset, windows, lapTimes, nowKey]);

  /* -- Counts per category for the filter chips -------------------------- */
  const counts = useMemo(() => {
    const c = { All: timeline.length };
    for (const item of timeline) c[item.category] = (c[item.category] || 0) + 1;
    return c;
  }, [timeline]);

  const visible = useMemo(() => {
    if (filter === 'All') return timeline;
    return timeline.filter((x) => x.category === filter);
  }, [filter, timeline]);

  /* -- Retirements (driver_status from live feed OR race_results) -------- */
  // Replay: a retirement is listed only once it has happened at the replay's
  // now (utils/driverState.js driverStateAt `retired`: the driver's final lap
  // row has ended, or for a retirement in the pits the car entered the pit
  // lane); a driver with no lap at all (did not start) is known from the start.
  // The results' DNFs and the classified drivers who stopped before the flag
  // (nonFinisherMap). Live: the feed reports retirements as they happen.
  const retirements = useMemo(() => {
    const out = [];
    const nonFinishers = isLiveMode ? dnfMap : nonFinisherMap(lapTimes, dnfMap);
    for (const [abbr, info] of Object.entries(nonFinishers)) {
      // Replay: the lap of the retirement from the rows (info.lastLap is
      // race_results Laps, a final result known only once the final row ended)
      const st = !isLiveMode && lapTimes?.some((r) => r?.Driver === abbr)
        ? driverStateAt(lapTimes, abbr, sessionNow, { dnf: info })
        : null;
      if (st && !st.retired) continue;
      out.push({
        abbr,
        status: info?.status || 'Out',
        lap: st?.retiredLap ?? info?.lastLap ?? '?',
        color: getDriverColor(abbr),
      });
    }
    return out.sort((a, b) => (Number(a.lap) || 0) - (Number(b.lap) || 0));
    // nowKey stands for sessionNow (a retirement is reached at a lap end or a pit entry)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnfMap, isLiveMode, lapTimes, nowKey]);

  /* -- Categories present (sorted by count, but keep "All" first) -------- */
  const categories = useMemo(() => {
    const cats = Object.keys(counts).filter((k) => k !== 'All');
    cats.sort((a, b) => counts[b] - counts[a]);
    return ['All', ...cats];
  }, [counts]);

  /* -- Render ------------------------------------------------------------- */
  return (
    <div className="race-control-panel" style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'rgba(10,10,20,0.96)',
      color: '#e0e0e0',
      fontFamily: "'Titillium Web', 'Inter', sans-serif",
      overflow: 'hidden',
    }}>
      {/* Header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'linear-gradient(90deg, rgba(225,6,0,0.18) 0%, rgba(0,0,0,0) 60%)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: isLiveMode && liveConnected ? '#e10600' : '#666',
            boxShadow: isLiveMode && liveConnected ? '0 0 10px rgba(225,6,0,0.6)' : 'none',
            animation: isLiveMode && liveConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none',
          }} />
          <span style={{
            fontFamily: "'Formula1', 'Titillium Web', sans-serif",
            fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
            fontSize: 12, color: '#fff',
          }}>Race Control</span>
          <span style={{ fontSize: 10, color: '#7a7f9a', letterSpacing: '0.06em' }}>
            LAP <strong style={{ color: '#fff' }}>{currentLap}</strong>{totalRaceLaps ? ` / ${totalRaceLaps}` : ''}
          </span>
        </div>

        {/* Track status pill (mirrors what TrackMap shows) */}
        {(() => {
          const meta = TRACK_STATUS_META[String(currentFlagStatus || '1')] || TRACK_STATUS_META['1'];
          return (
            <span style={{
              padding: '3px 10px', borderRadius: 4,
              fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: `${meta.color}20`, color: meta.color,
              border: `1px solid ${meta.color}55`,
            }}>{meta.label}</span>
          );
        })()}
      </div>

      {/* Filter chips */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6,
        padding: '8px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        flexShrink: 0,
      }}>
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat] || { color: '#888' };
          const active = filter === cat;
          return (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 4,
                background: active ? `${meta.color}30` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${active ? meta.color + '88' : 'rgba(255,255,255,0.06)'}`,
                color: active ? '#fff' : '#bbc',
                fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                textTransform: 'uppercase', cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: meta.color || '#888',
              }} />
              {cat === 'All' ? 'All' : (CATEGORY_META[cat]?.label || cat)}
              <span style={{ color: '#888', fontSize: 9 }}>{counts[cat] ?? 0}</span>
            </button>
          );
        })}

        <span style={{ flex: 1 }} />

        <button
          onClick={toggleAutoplay}
          title={`Auto-play new team radios as they arrive — scoped to selected/focus drivers, queued chronologically. ${autoplayHint}.`}
          style={{
            padding: '4px 10px', borderRadius: 4,
            background: autoplay ? 'rgba(34,197,94,0.16)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${autoplay ? '#22c55e88' : 'rgba(255,255,255,0.06)'}`,
            color: autoplay ? '#86efac' : '#bbc',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <span style={{
            display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
            background: autoplay ? '#22c55e' : '#555',
          }} />
          Auto-play
        </button>

        <button
          onClick={() => setShowTeamRadio((v) => !v)}
          title="Team radio audio (F1 doesn't ship transcripts — audio only)"
          style={{
            padding: '4px 10px', borderRadius: 4,
            background: showTeamRadio ? 'rgba(245,166,35,0.16)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${showTeamRadio ? '#f5a62388' : 'rgba(255,255,255,0.06)'}`,
            color: showTeamRadio ? '#f5a623' : '#bbc',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Radio <span style={{ color: '#888', fontSize: 9 }}>{teamRadios.length}</span>
        </button>

        <button
          onClick={() => setShowRetirements((v) => !v)}
          style={{
            padding: '4px 10px', borderRadius: 4,
            background: showRetirements ? 'rgba(239,68,68,0.16)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${showRetirements ? '#ef444488' : 'rgba(255,255,255,0.06)'}`,
            color: showRetirements ? '#fca5a5' : '#bbc',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          DNFs <span style={{ color: '#888', fontSize: 9 }}>{retirements.length}</span>
        </button>
      </div>

      {/* Audio playback is owned by the global RadioPipToast — see
           src/components/ui/RadioPipToast.jsx. This panel is now purely
           a list / transcript browser. */}

      {/* Body: feed + side rail (DNFs + Team Radio stacked) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns:
          (showRetirements && retirements.length > 0) || (showTeamRadio && teamRadios.length > 0)
            ? '1fr 260px'
            : '1fr',
        gap: 0, flex: 1, minHeight: 0, overflow: 'hidden',
      }}>
        {/* Feed */}
        <div style={{
          overflowY: 'auto', padding: '8px 14px',
          fontSize: 12,
        }}>
          {visible.length === 0 ? (
            <div style={{
              color: '#666', fontSize: 11, padding: '24px 0', textAlign: 'center',
            }}>
              {isLiveMode
                ? 'No race control messages yet. They appear as stewards announce them live.'
                : 'No race control messages for this session.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {visible.map((item, i) => {
                const meta = CATEGORY_META[item.category] || CATEGORY_META.Other;
                const flagMeta = item.flag ? FLAG_META[item.flag] : null;
                const abbr = item.driverNum ? numberToAbbr[item.driverNum] : null;
                const accent = flagMeta?.color || meta.color;
                return (
                  <div key={i} style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 56px 18px 1fr',
                    gap: 8, alignItems: 'flex-start',
                    padding: '6px 8px',
                    borderRadius: 4,
                    background: i % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent',
                    borderLeft: `2px solid ${accent}`,
                  }}>
                    <span style={{
                      color: '#777', fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontVariantNumeric: 'tabular-nums',
                    }}>{item.replayClock != null ? formatReplayClock(item.replayClock) : formatTime(item.timestamp)}</span>
                    <span style={{ color: '#888', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700 }}>
                      {item.lap != null ? `L${item.lap}` : '—'}
                    </span>
                    <span style={{
                      width: 18, height: 18, borderRadius: 3,
                      background: `${accent}33`, color: accent,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 9, fontWeight: 800,
                    }} title={meta.label}>
                      {meta.icon}
                    </span>
                    <span style={{ color: '#dde', lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {abbr && <DriverChip abbr={abbr} color={getDriverColor(abbr)} />}
                      {flagMeta && (
                        <span style={{
                          fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          padding: '1px 5px', borderRadius: 3,
                          background: `${flagMeta.color}20`, color: flagMeta.color,
                          border: `1px solid ${flagMeta.color}55`,
                        }}>{flagMeta.label}</span>
                      )}
                      <span>{item.message || meta.label}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right rail — DNFs on top, Team Radio below */}
        {((showRetirements && retirements.length > 0) || (showTeamRadio && teamRadios.length > 0)) && (
          <aside style={{
            borderLeft: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(0,0,0,0.25)',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {/* DNFs section */}
            {showRetirements && retirements.length > 0 && (
              <div style={{ padding: '8px 12px', overflowY: 'auto', flexShrink: 0, maxHeight: '40%' }}>
                <div style={{
                  fontSize: 10, color: '#fca5a5', letterSpacing: '0.08em',
                  textTransform: 'uppercase', fontWeight: 800, marginBottom: 8,
                }}>Out of session</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {retirements.map((r) => (
                    <div key={r.abbr} style={{
                      display: 'grid',
                      gridTemplateColumns: '38px 1fr auto',
                      gap: 8, alignItems: 'center',
                      padding: '4px 6px', borderRadius: 3,
                      background: 'rgba(239,68,68,0.06)',
                      borderLeft: `3px solid ${r.color}`,
                    }}>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 800, fontSize: 11, color: '#fff',
                      }}>{r.abbr}</span>
                      <span style={{ fontSize: 10, color: '#dde', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.status}
                      </span>
                      <span style={{
                        fontSize: 10, color: '#888',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>L{r.lap}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Team Radio section — audio only (F1's TeamRadio topic carries no transcripts) */}
            {showTeamRadio && (
              <div style={{
                padding: '8px 12px',
                overflowY: 'auto',
                flex: 1, minHeight: 0,
                borderTop: showRetirements && retirements.length > 0
                  ? '1px solid rgba(255,255,255,0.06)' : 'none',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 8,
                }}>
                  <span style={{
                    fontSize: 10, color: '#f5a623', letterSpacing: '0.08em',
                    textTransform: 'uppercase', fontWeight: 800,
                  }}>Team Radio</span>
                  <span style={{ fontSize: 9, color: '#666' }} title="Audio is from F1's SignalR feed; transcripts are produced locally by faster-whisper (tiny.en).">
                    audio + auto-transcript
                  </span>
                </div>
                {teamRadios.length === 0 ? (
                  <div style={{ color: '#666', fontSize: 10, padding: '12px 0', textAlign: 'center' }}>
                    {isLiveMode
                      ? 'No team radio yet — they appear when teams go on-air during the session.'
                      : 'No team radio captures for this session.'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* newest first */}
                    {[...teamRadios].reverse().map((r, i) => {
                      const abbr = r.driver || numberToAbbr[r.driver_number] || '???';
                      const color = getDriverColor(abbr);
                      const status = r.transcript_status;
                      const transcript = r.transcript;
                      return (
                        <div key={`${r.audio_url}-${i}`} style={{
                          padding: '5px 6px',
                          borderRadius: 3,
                          background: 'rgba(245,166,35,0.05)',
                          borderLeft: `3px solid ${color}`,
                          display: 'flex', flexDirection: 'column', gap: 4,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                            <DriverChip abbr={abbr} color={color} />
                            <span style={{
                              fontSize: 9, color: '#888',
                              fontFamily: "'JetBrains Mono', monospace",
                              fontVariantNumeric: 'tabular-nums',
                            }}>{formatTime(r.timestamp)}</span>
                          </div>
                          <audio
                            controls
                            preload="none"
                            style={{ width: '100%', height: 24 }}
                            src={r.audio_url}
                          >
                            Your browser does not support the audio element.
                          </audio>
                          {/* Auto-transcript (faster-whisper, best effort) */}
                          {status === 'queued' && (
                            <span style={{ fontSize: 9, color: '#777', fontStyle: 'italic' }}>
                              transcribing…
                            </span>
                          )}
                          {status === 'ok' && transcript && (
                            <span style={{
                              fontSize: 11, color: '#dde', lineHeight: 1.35,
                              fontStyle: 'italic',
                              background: 'rgba(255,255,255,0.03)',
                              padding: '4px 6px', borderRadius: 3,
                            }} title="Auto-transcribed by faster-whisper (tiny.en) — radio audio is noisy, expect occasional errors.">
                              “{transcript}”
                            </span>
                          )}
                          {(status === 'empty' || (status === 'ok' && !transcript)) && (
                            <span style={{ fontSize: 9, color: '#777' }}>
                              (no speech detected)
                            </span>
                          )}
                          {status === 'download_failed' && (
                            <span style={{ fontSize: 9, color: '#f87171' }}>
                              (transcript unavailable — download failed)
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
