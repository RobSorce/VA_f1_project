import React, { useMemo, useState, useRef } from 'react';
import { useF1Store, formatReplayClock } from '../../store/useF1Store';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  driverStyle, tintedChip, textColor, markColor, withAlpha, CHART_FONT, chartFontPx,
  TEXT_COLORS, GRID_COLORS, SURFACES, UI_COLORS, FLAG_COLORS, SERIES_COLORS,
} from '../../utils/colors';
import { useBoxSize, fitRows, pageOf } from '../../utils/views/chartBox';
import { lapWindows, leaderLapAt, raceClockLimit } from '../../utils/raceTime';
import { causalKey } from '../../utils/strategyViews';
import { driverStateAt, nonFinisherMap } from '../../utils/driverState';

/* -- Race control category styling --------------------------------------- */
// Maps the F1 SignalR `Category` string + flag/colour to a user-readable
// label, an accent colour (utils/colors.js) and a glyph. Categories the
// official feed emits: "Flag", "Drs", "SafetyCar", "CarEvent", "Other" (and a
// few rarely-seen). The glyph (and the label) tells the categories apart,
// never the colour alone: every glyph is different.
const CATEGORY_META = {
  Flag:       { label: 'Flag',       color: FLAG_COLORS.yellow,    icon: 'F' },
  Drs:        { label: 'DRS',        color: FLAG_COLORS.blue,      icon: 'D' },
  SafetyCar:  { label: 'Safety Car', color: FLAG_COLORS.safetyCar, icon: 'S' },
  CarEvent:   { label: 'Car Event',  color: SERIES_COLORS[2],      icon: 'C' },
  Other:      { label: 'Other',      color: TEXT_COLORS.muted,     icon: '·' },
  Penalty:    { label: 'Penalty',    color: FLAG_COLORS.red,       icon: 'P' },
  Stewards:   { label: 'Stewards',   color: FLAG_COLORS.red,       icon: '⚖' },
};

// Flags: the FIA colours of utils/colors.js, always drawn with their label
const FLAG_META = {
  GREEN:    { color: FLAG_COLORS.green,     label: 'Green' },
  YELLOW:   { color: FLAG_COLORS.yellow,    label: 'Yellow' },
  DOUBLE_YELLOW: { color: FLAG_COLORS.yellow, label: 'Double Yellow' },
  RED:      { color: FLAG_COLORS.red,       label: 'Red' },
  BLUE:     { color: FLAG_COLORS.blue,      label: 'Blue' },
  CHEQUERED:{ color: FLAG_COLORS.chequered, label: 'Chequered' },
  CLEAR:    { color: FLAG_COLORS.green,     label: 'Clear' },
};

const TRACK_STATUS_META = {
  '1': { label: 'Track clear',          color: FLAG_COLORS.green },
  '2': { label: 'Yellow flag',          color: FLAG_COLORS.yellow },
  '3': { label: 'Yellow flag',          color: FLAG_COLORS.yellow },
  '4': { label: 'Safety Car',           color: FLAG_COLORS.safetyCar },
  '5': { label: 'Red flag',             color: FLAG_COLORS.red },
  '6': { label: 'Virtual Safety Car',   color: FLAG_COLORS.safetyCar },
  '7': { label: 'VSC ending',           color: FLAG_COLORS.safetyCar },
};

function classifyCategory(msg) {
  // Best-effort categorisation when the live feed gives us something
  // unfamiliar. Penalty / investigation lines come through Category="Other"
  // with the keyword in the message body, so "Other" is kept only after the
  // keyword rules below.
  if (msg.category && msg.category !== 'Other' && CATEGORY_META[msg.category]) return msg.category;
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
// The driver's code (the cue) on a tint of his colour, the team bar at >= 3:1
function DriverChip({ abbr }) {
  if (!abbr) return null;
  const st = driverStyle(abbr, SURFACES.panel);
  return (
    <span style={{
      display: 'inline-block',
      padding: '0 6px',
      borderRadius: 3,
      fontSize: CHART_FONT.label,
      fontWeight: 800,
      letterSpacing: '0.04em',
      background: withAlpha(st.color, 0.15),
      borderLeft: `3px solid ${st.mark}`,
      color: TEXT_COLORS.primary,
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
    // Live: start_time is on the session clock too (the changes are ordered
    // by it); the time shown is the wall clock of the change, received_at
    // (epoch s, D13), on the clock of the race-control messages' timestamps;
    // the lap is the leader's lap the backend / store stamped on it.
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
        // live without received_at (an older backend): no wall-clock time known
        timestamp: isLiveMode ? (t.received_at ?? null) : start,
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
        mark: driverStyle(abbr, SURFACES.page).mark,
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
  const statusMeta = TRACK_STATUS_META[String(currentFlagStatus || '1')] || TRACK_STATUS_META['1'];
  const statusChip = tintedChip(statusMeta.color, 0.14, SURFACES.panel);
  const showRail = (showRetirements && retirements.length > 0) || (showTeamRadio && teamRadios.length > 0);
  return (
    <div className="race-control-panel" style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: SURFACES.panel,
      color: TEXT_COLORS.primary,
      fontFamily: "'Titillium Web', 'Inter', sans-serif",
      overflow: 'hidden',
    }}>
      {/* Header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 14px',
        borderBottom: `1px solid ${GRID_COLORS.grid}`,
        background: `linear-gradient(90deg, ${withAlpha(UI_COLORS.accent, 0.18)} 0%, transparent 60%)`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            title={isLiveMode && liveConnected ? 'Live: connected' : 'Not live'}
            style={{
              width: 10, height: 10, borderRadius: '50%',
              background: isLiveMode && liveConnected ? UI_COLORS.accent : TEXT_COLORS.muted,
              boxShadow: isLiveMode && liveConnected ? `0 0 10px ${withAlpha(UI_COLORS.accent, 0.6)}` : 'none',
              animation: isLiveMode && liveConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none',
            }}
          />
          <span style={{
            fontFamily: "'Formula1', 'Titillium Web', sans-serif",
            fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
            fontSize: CHART_FONT.data, color: TEXT_COLORS.primary,
          }}>Race Control</span>
          <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, letterSpacing: '0.06em' }}>
            LAP <strong style={{ color: TEXT_COLORS.primary }}>{currentLap}</strong>{totalRaceLaps ? ` / ${totalRaceLaps}` : ''}
          </span>
        </div>

        {/* Track status pill (mirrors what TrackMap shows): the label is the cue, the colour repeats it */}
        <span style={{
          padding: '2px 10px', borderRadius: 4,
          fontSize: CHART_FONT.label, fontWeight: 800, letterSpacing: '0.08em',
          textTransform: 'uppercase',
          background: statusChip.background, color: statusChip.color,
          border: `1px solid ${statusChip.borderColor}`,
        }}>{statusMeta.label}</span>
      </div>

      {/* Filter chips */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6,
        padding: '6px 14px',
        borderBottom: `1px solid ${GRID_COLORS.grid}`,
        flexShrink: 0,
      }}>
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat] || { color: TEXT_COLORS.muted, icon: '' };
          const active = filter === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setFilter(cat)}
              aria-pressed={active}
              style={chipButton(active, meta.color)}
            >
              {cat !== 'All' && (
                <span aria-hidden="true" style={{ color: textColor(meta.color, SURFACES.panel), fontWeight: 800 }}>{meta.icon}</span>
              )}
              {cat === 'All' ? 'All' : (CATEGORY_META[cat]?.label || cat)}
              <span style={{ color: TEXT_COLORS.secondary }}>{counts[cat] ?? 0}</span>
            </button>
          );
        })}

        <span style={{ flex: 1 }} />

        <button
          type="button"
          onClick={toggleAutoplay}
          aria-pressed={!!autoplay}
          title={`Auto-play new team radios as they arrive — scoped to selected/focus drivers, queued chronologically. ${autoplayHint}.`}
          style={toggleButton(autoplay)}
        >
          {autoplay ? '●' : '○'} Auto-play
        </button>

        <button
          type="button"
          onClick={() => setShowTeamRadio((v) => !v)}
          aria-pressed={showTeamRadio}
          title="Team radio audio (F1 doesn't ship transcripts — audio only)"
          style={toggleButton(showTeamRadio)}
        >
          {showTeamRadio ? '●' : '○'} Radio <span style={{ color: TEXT_COLORS.secondary }}>{teamRadios.length}</span>
        </button>

        <button
          type="button"
          onClick={() => setShowRetirements((v) => !v)}
          aria-pressed={showRetirements}
          style={toggleButton(showRetirements)}
        >
          {showRetirements ? '●' : '○'} DNFs <span style={{ color: TEXT_COLORS.secondary }}>{retirements.length}</span>
        </button>
      </div>

      {/* Audio playback is owned by the global RadioPipToast — see
           src/components/ui/RadioPipToast.jsx. This panel is now purely
           a list / transcript browser. */}

      {/* Body: feed + side rail (DNFs + Team Radio stacked). Every list shows
          the rows that fit and pages through the rest (newest first): no scroll */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: showRail ? 'minmax(0, 1fr) minmax(0, 260px)' : 'minmax(0, 1fr)',
        gap: 0, flex: 1, minHeight: 0, overflow: 'hidden',
      }}>
        {/* Feed */}
        <div style={{ padding: '6px 14px', fontSize: CHART_FONT.data, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {visible.length === 0 ? (
            <div style={{
              color: TEXT_COLORS.secondary, fontSize: CHART_FONT.data, padding: '24px 0', textAlign: 'center',
            }}>
              {isLiveMode
                ? 'No race control messages yet. They appear as stewards announce them live.'
                : 'No race control messages for this session.'}
            </div>
          ) : (
            <PagedRows
              items={visible}
              rowH={FEED_ROW_H()}
              what="messages"
              gap={4}
              keyOf={(item, i) => `${item.kind}-${toMs(item.timestamp)}-${i}`}
              renderItem={(item, i) => {
                const meta = CATEGORY_META[item.category] || CATEGORY_META.Other;
                const flagMeta = item.flag ? FLAG_META[item.flag] : null;
                const abbr = item.driverNum ? numberToAbbr[item.driverNum] : null;
                const accent = flagMeta?.color || meta.color;
                const flagChip = flagMeta ? tintedChip(flagMeta.color, 0.14, SURFACES.panel) : null;
                const time = item.replayClock != null ? formatReplayClock(item.replayClock) : formatTime(item.timestamp);
                return (
                  <div
                    className="rc-row"
                    // a message long enough to pass two lines also sits whole in the tooltip
                    title={(item.message || '').length > LONG_MESSAGE ? item.message : undefined}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '64px 44px 20px minmax(0, 1fr)',
                      gap: 8, alignItems: 'flex-start', height: '100%', boxSizing: 'border-box',
                      padding: '3px 8px',
                      borderRadius: 4,
                      background: i % 2 === 0 ? withAlpha(TEXT_COLORS.primary, 0.02) : 'transparent',
                      borderLeft: `2px solid ${markColor(accent, SURFACES.panel)}`,
                      overflow: 'hidden',
                    }}
                  >
                    <span style={{
                      color: TEXT_COLORS.secondary, fontSize: CHART_FONT.data,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontVariantNumeric: 'tabular-nums',
                    }}>{time}</span>
                    <span style={{ color: TEXT_COLORS.secondary, fontSize: CHART_FONT.data, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700 }}>
                      {item.lap != null ? `L${item.lap}` : '—'}
                    </span>
                    <span style={{
                      width: 20, height: 18, borderRadius: 3,
                      background: withAlpha(accent, 0.2), color: textColor(accent, SURFACES.panel),
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: CHART_FONT.label, fontWeight: 800,
                    }} title={meta.label}>
                      {meta.icon}
                    </span>
                    <span style={{
                      color: TEXT_COLORS.primary, lineHeight: 1.35, minWidth: 0,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      {abbr && <DriverChip abbr={abbr} />}{abbr ? ' ' : ''}
                      {flagChip && (
                        <span style={{
                          fontSize: CHART_FONT.label, fontWeight: 800, letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          padding: '0 5px', borderRadius: 3, marginRight: 6,
                          background: flagChip.background, color: flagChip.color,
                          border: `1px solid ${flagChip.borderColor}`,
                        }}>{flagMeta.label}</span>
                      )}
                      <span>{item.message || meta.label}</span>
                    </span>
                  </div>
                );
              }}
            />
          )}
        </div>

        {/* Right rail — DNFs on top, Team Radio below */}
        {showRail && (
          <aside style={{
            borderLeft: `1px solid ${GRID_COLORS.grid}`,
            background: SURFACES.page,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden', minHeight: 0,
          }}>
            {/* DNFs section */}
            {showRetirements && retirements.length > 0 && (
              <div style={{
                padding: '6px 12px', flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
                maxHeight: showTeamRadio && teamRadios.length > 0 ? '40%' : '100%', overflow: 'hidden',
              }}>
                <div style={{
                  fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, letterSpacing: '0.08em',
                  textTransform: 'uppercase', fontWeight: 800, marginBottom: 6, flexShrink: 0,
                }}>Out of session</div>
                <PagedRows
                  items={retirements}
                  rowH={DNF_ROW_H()}
                  what="drivers"
                  gap={4}
                  keyOf={(r) => r.abbr}
                  renderItem={(r) => (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '38px minmax(0, 1fr) auto',
                      gap: 8, alignItems: 'center', height: '100%', boxSizing: 'border-box',
                      padding: '2px 6px', borderRadius: 3,
                      background: withAlpha(TEXT_COLORS.primary, 0.04),
                      borderLeft: `3px solid ${r.mark}`,
                    }}>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 800, fontSize: CHART_FONT.data, color: TEXT_COLORS.primary,
                      }}>{r.abbr}</span>
                      <span style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.status}>
                        {r.status}
                      </span>
                      <span style={{
                        fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>L{r.lap}</span>
                    </div>
                  )}
                />
              </div>
            )}

            {/* Team Radio section — audio only (F1's TeamRadio topic carries no transcripts) */}
            {showTeamRadio && (
              <div style={{
                padding: '6px 12px',
                flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
                borderTop: showRetirements && retirements.length > 0
                  ? `1px solid ${GRID_COLORS.grid}` : 'none',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 6, flexShrink: 0,
                }}>
                  <span style={{
                    fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, letterSpacing: '0.08em',
                    textTransform: 'uppercase', fontWeight: 800,
                  }}>Team Radio</span>
                  <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary }} title="Audio is from F1's SignalR feed; transcripts are produced locally by faster-whisper (tiny.en).">
                    audio + auto-transcript
                  </span>
                </div>
                {teamRadios.length === 0 ? (
                  <div style={{ color: TEXT_COLORS.secondary, fontSize: CHART_FONT.data, padding: '12px 0', textAlign: 'center' }}>
                    {isLiveMode
                      ? 'No team radio yet — they appear when teams go on-air during the session.'
                      : 'No team radio captures for this session.'}
                  </div>
                ) : (
                  <PagedRows
                    items={[...teamRadios].reverse()}
                    rowH={RADIO_ROW_H()}
                    what="radios"
                    gap={6}
                    keyOf={(r, i) => `${r.audio_url}-${i}`}
                    renderItem={(r) => {
                      const abbr = r.driver || numberToAbbr[r.driver_number] || '???';
                      const status = r.transcript_status;
                      const transcript = r.transcript;
                      return (
                        <div style={{
                          padding: '4px 6px', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
                          borderRadius: 3,
                          background: withAlpha(TEXT_COLORS.primary, 0.04),
                          borderLeft: `3px solid ${driverStyle(abbr).mark}`,
                          display: 'flex', flexDirection: 'column', gap: 3,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                            <DriverChip abbr={abbr} />
                            <span style={{
                              fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary,
                              fontFamily: "'JetBrains Mono', monospace",
                              fontVariantNumeric: 'tabular-nums',
                            }}>{formatTime(r.timestamp)}</span>
                          </div>
                          <audio
                            controls
                            preload="none"
                            style={{ width: '100%', height: 24, flexShrink: 0 }}
                            src={r.audio_url}
                          >
                            Your browser does not support the audio element.
                          </audio>
                          {/* Auto-transcript (faster-whisper, best effort): two lines, the rest in the tooltip */}
                          {status === 'queued' && (
                            <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, fontStyle: 'italic' }}>
                              transcribing…
                            </span>
                          )}
                          {status === 'ok' && transcript && (
                            <span style={{
                              fontSize: CHART_FONT.data, color: TEXT_COLORS.primary, lineHeight: 1.35,
                              fontStyle: 'italic',
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                            }} title={`“${transcript}” — auto-transcribed by faster-whisper (tiny.en): radio audio is noisy, expect occasional errors.`}>
                              “{transcript}”
                            </span>
                          )}
                          {(status === 'empty' || (status === 'ok' && !transcript)) && (
                            <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary }}>
                              (no speech detected)
                            </span>
                          )}
                          {status === 'download_failed' && (
                            <span style={{ fontSize: CHART_FONT.label, color: textColor(FLAG_COLORS.red, SURFACES.page) }}>
                              (transcript unavailable — download failed)
                            </span>
                          )}
                        </div>
                      );
                    }}
                  />
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Rows of the lists (px at the data font token) and the pager ──────
const LINE = () => Math.ceil(chartFontPx('data') * 1.4);
// a message: two lines (a longer one whole in the row's tooltip)
const FEED_ROW_H = () => 2 * LINE() + 8;
const LONG_MESSAGE = 80;
const DNF_ROW_H = () => LINE() + 8;
// a radio: chip line, the audio control, two lines of transcript
const RADIO_ROW_H = () => LINE() + 24 + 2 * LINE() + 16;
const PAGER_H = 22;

/** A filter / toggle chip: its icon or ●/○ carries the state, the tint repeats it. */
function chipButton(active, color) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '2px 10px', borderRadius: 4,
    background: active ? withAlpha(color, 0.2) : withAlpha(TEXT_COLORS.primary, 0.04),
    border: `1px solid ${active ? markColor(color, SURFACES.panel) : GRID_COLORS.grid}`,
    color: TEXT_COLORS.primary,
    fontSize: CHART_FONT.label, fontWeight: 700, letterSpacing: '0.04em',
    textTransform: 'uppercase', cursor: 'pointer',
    fontFamily: "'JetBrains Mono', monospace",
  };
}
function toggleButton(on) {
  return {
    ...chipButton(on, UI_COLORS.brush),
    color: on ? TEXT_COLORS.primary : TEXT_COLORS.secondary,
  };
}

/**
 * Rows of one height fitted to the box (chartBox.fitRows), paged when they
 * do not fit: page 1 holds the newest. An unmeasured box (server render)
 * shows every row.
 */
function PagedRows({ items, rowH, what, gap = 0, keyOf, renderItem }) {
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
  const [page, setPage] = useState(0);
  const step = rowH + gap;
  const fit = fitRows(box.height, items.length, { rowMin: step, rowMax: step, rowDefault: step, pagerH: PAGER_H });
  const pg = pageOf(items, page, fit.perPage);
  const btn = {
    fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, background: 'transparent',
    border: `1px solid ${GRID_COLORS.rule}`, borderRadius: 3, padding: '0 6px', cursor: 'pointer',
  };
  return (
    <div ref={boxRef} className="rc-list" style={{ flex: 1, minHeight: Math.min(step, 40), display: 'flex', flexDirection: 'column', gap, overflow: 'hidden' }}>
      {pg.rows.map((item, i) => (
        <div key={keyOf(item, pg.first - 1 + i)} style={{ height: rowH, flexShrink: 0 }}>
          {renderItem(item, pg.first - 1 + i)}
        </div>
      ))}
      {fit.paged && (
        <div className="rc-pager" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: PAGER_H, flexShrink: 0,
          fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, marginTop: 'auto',
        }}
        >
          <button type="button" aria-label={`Newer ${what}`} disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} style={btn}>{'◀'}</button>
          <span>{what} {pg.first}{'–'}{pg.last} of {items.length}</span>
          <button type="button" aria-label={`Older ${what}`} disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)} style={btn}>{'▶'}</button>
        </div>
      )}
    </div>
  );
}
