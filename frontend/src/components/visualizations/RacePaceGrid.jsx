import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey } from '../../utils/strategyViews';
import { paceGridData, paceCell } from '../../utils/views/racePaceGrid';

/* -- Cell style palette ---------------------------------------------------- */
const CELL_STYLES = {
  'session-best':  { background: 'rgba(168,85,247,0.30)', color: '#A855F7', fontWeight: 600 },
  'personal-best': { background: 'rgba(34,197,94,0.22)',  color: '#22C55E' },
  'good':          { background: 'rgba(34,197,94,0.08)',   color: '#88FFAA' },
  'slower':        { background: 'rgba(251,191,36,0.12)',  color: '#FBBF24' },
  'very-slow':     { background: 'rgba(255,60,60,0.20)',   color: '#FF4444' },
  'pit-in':        { background: 'rgba(255,136,0,0.35)',   color: '#FFA500', fontWeight: 700 },
  'pit-out':       { background: 'rgba(68,170,255,0.18)',  color: '#44AAFF' },
  'default':       { color: '#aab' },
  'empty':         { color: 'rgba(255,255,255,0.15)' },
  'future':        { background: 'rgba(255,255,255,0.008)', color: 'transparent' },
  'dnf':           { background: 'rgba(255,60,60,0.12)', color: '#FF4444', fontWeight: 700 },
  'live-chrono':   { background: 'rgba(251,191,36,0.14)', color: '#fbbf24', fontWeight: 700 },
};

/* -- Styles ---------------------------------------------------------------- */
const CELL_W = 70;
const LAP_COL_W = 42;
const HEADER_H = 30;
const ROW_H = 26;

const containerStyle = {
  width: '100%',
  height: '100%',
  overflow: 'auto',
  background: 'rgba(10,10,20,0.95)',
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 10,
  color: '#aab',
  userSelect: 'none',
  position: 'relative',
};

const tableStyle = {
  borderCollapse: 'separate',
  borderSpacing: 0,
  tableLayout: 'fixed',
};

/* -- Memoized Cell component ----------------------------------------------- */
const PaceCell = React.memo(function PaceCell({
  label, cellStyle, tooltip, dimmed, isHighlighted,
  onClick, onDoubleClick, onMouseEnter, onMouseLeave,
}) {
  const style = {
    width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W,
    height: ROW_H,
    padding: '0 3px',
    textAlign: 'center',
    lineHeight: `${ROW_H}px`,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    borderRight: '1px solid rgba(255,255,255,0.04)',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    transition: 'opacity 0.12s ease',
    ...cellStyle,
    opacity: dimmed ? 0.35 : 1,
  };

  if (isHighlighted) {
    style.background = 'rgba(255,255,255,0.06)';
  }

  return (
    <td
      style={style}
      title={tooltip}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {label}
    </td>
  );
});

/* -- Main component -------------------------------------------------------- */
function RacePaceGrid() {
  const sessionData = useF1Store((s) => s.sessionData);
  const drivers = useF1Store((s) => s.sessionData?.drivers || s.drivers || []);
  const currentLap = useF1Store((s) => s.currentLap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  // Causal "now" in session seconds (utils/raceTime.js): a cell shows a lap
  // time once that lap is completed, a pit once its entry has happened
  const sessionNow = useSessionNow();
  const maxLap = useF1Store((s) => s.maxLap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const triggerPrediction = useF1Store((s) => s.triggerPrediction);

  // Defensive filter: when we have a real driver_info list, only consider
  // lap_times whose Driver matches a known abbreviation. Without this,
  // rows can leak in for pre-DriverList SignalR entries that used the raw
  // racing number ("1", "11", ...) as the Driver field.
  const validAbbrSet = useMemo(() => {
    const s = new Set();
    for (const d of drivers) {
      const a = d.Abbreviation || d.abbr;
      if (a) s.add(a);
    }
    return s;
  }, [drivers]);

  const lapTimes = useMemo(() => {
    const all = sessionData?.lap_times || [];
    return validAbbrSet.size > 0 ? all.filter((lt) => validAbbrSet.has(lt.Driver)) : all;
  }, [sessionData, validAbbrSet]);
  const raceResults = sessionData?.race_results || [];

  const currentLapRef = useRef(null);
  const scrollContainerRef = useRef(null);

  // -- Column order: grid slot while the race runs (the final classification
  // is not known yet), final position once it is over (sessionNow Infinity) --
  const raceOver = sessionNow === Infinity;
  const sortedDrivers = useMemo(() => {
    const driverSet = new Map();
    for (const lt of lapTimes) {
      if (lt.Driver && !driverSet.has(lt.Driver))
        driverSet.set(lt.Driver, { abbr: lt.Driver, position: 999 });
    }
    for (const d of drivers) {
      const abbr = d.Abbreviation || d.abbr;
      if (abbr && !driverSet.has(abbr))
        driverSet.set(abbr, { abbr, position: 999 });
    }
    for (const r of raceResults) {
      const abbr = r.Abbreviation || r.abbr;
      if (abbr && driverSet.has(abbr)) {
        const pos = raceOver
          ? parseInt(r.ClassifiedPosition || r.Position, 10)
          : parseInt(r.GridPosition, 10);
        if (!isNaN(pos) && pos > 0) driverSet.get(abbr).position = pos;
      }
    }
    if (!raceResults.length) {
      for (const lt of lapTimes) {
        if (lt.Driver && lt.Position && driverSet.has(lt.Driver)) {
          const entry = driverSet.get(lt.Driver);
          const pos = parseInt(lt.Position, 10);
          if (!isNaN(pos) && (entry.position === 999 || lt.LapNumber >= (entry._latestLap || 0))) {
            entry.position = pos;
            entry._latestLap = lt.LapNumber;
          }
        }
      }
    }
    return Array.from(driverSet.values()).sort((a, b) => a.position - b.position);
  }, [lapTimes, raceResults, drivers, raceOver]);

  // -- Completed laps, laps in progress, retirements and pit stops at sessionNow
  // (paceGridData, utils/views). Rebuilt when a lap completes or a pit event happens
  // (causalKey), not on every replay tick; the chrono reads sessionNow directly.
  const gridKey = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  const gridData = useMemo(
    () => paceGridData(lapTimes, sessionNow, { dnfMap, isLiveMode }),
    // sessionNow enters through gridKey, which changes whenever the result does
    [lapTimes, gridKey, dnfMap, isLiveMode],
  );
  const pitCountByDriver = gridData.pitCounts;

  // -- Get driver team color --
  const driverTeamColors = useMemo(() => {
    const colors = {};
    for (const d of sortedDrivers) colors[d.abbr] = getDriverColor(d.abbr);
    return colors;
  }, [sortedDrivers]);

  // -- Handlers --
  const handleCellClick = useCallback((abbr) => toggleDriver(abbr), [toggleDriver]);
  // Double-click a cell: that driver becomes the focus and gets the lap-time
  // forecast from that lap (the store's one trigger; a lap later than the
  // replay's is clamped to it)
  const handleCellDoubleClick = useCallback((abbr, lap) => {
    if (useF1Store.getState().focusDriver !== abbr) setFocusDriver(abbr);
    triggerPrediction(abbr, lap);
  }, [setFocusDriver, triggerPrediction]);

  const handleHeaderClick = useCallback((abbr) => toggleDriver(abbr), [toggleDriver]);
  const handleHeaderDoubleClick = useCallback((abbr) => setFocusDriver(abbr), [setFocusDriver]);
  const handleMouseEnter = useCallback((abbr) => setHighlightedDriver(abbr), [setHighlightedDriver]);
  const handleMouseLeave = useCallback(() => setHighlightedDriver(null), [setHighlightedDriver]);

  // -- Auto-scroll current lap into view --
  useEffect(() => {
    if (currentLapRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const row = currentLapRef.current;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top < containerRect.top + 36 || rowRect.bottom > containerRect.bottom - 10) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [currentLap]);

  // Replay frames loaded: running laps show a live chronometer
  const replayActive = totalFrames > 0;

  // -- Render --
  if (!lapTimes.length || !sortedDrivers.length) {
    if (isLiveMode) {
      return (
        <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbc', fontSize: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', padding: 24 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#e10600',
              boxShadow: '0 0 10px rgba(225,6,0,0.6)',
              animation: 'livePulse 1.5s ease-in-out infinite',
            }} />
            <span style={{ fontWeight: 600 }}>Waiting for live laps…</span>
            <span style={{ color: '#777', fontSize: 10, maxWidth: 280 }}>
              Pace cells will appear as drivers complete each lap.
            </span>
          </div>
        </div>
      );
    }
    return (
      <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 13 }}>
        No lap time data available
      </div>
    );
  }

  const lapNumbers = [];
  const gridMaxLap = isLiveMode ? currentLap : maxLap;
  for (let i = 1; i <= gridMaxLap; i++) lapNumbers.push(i);
  const hasSelection = selectedDrivers.length > 0;

  return (
    <div ref={scrollContainerRef} style={containerStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {/* Corner cell */}
            <th style={{
              position: 'sticky', top: 0, left: 0, zIndex: 3,
              width: LAP_COL_W, minWidth: LAP_COL_W, maxWidth: LAP_COL_W,
              height: HEADER_H,
              background: '#151528', color: '#7a7f9a',
              fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.06em', textAlign: 'center', verticalAlign: 'middle',
              borderRight: '1px solid rgba(255,255,255,0.08)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
              Lap
            </th>
            {/* Driver headers */}
            {sortedDrivers.map((d) => {
              const teamColor = driverTeamColors[d.abbr] || '#888';
              const isSelected = selectedDrivers.includes(d.abbr);
              const isHighlighted = highlightedDriver === d.abbr;
              const dimmed = hasSelection && !isSelected;
              return (
                <th
                  key={d.abbr}
                  style={{
                    position: 'sticky', top: 0, zIndex: 2,
                    width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W,
                    height: HEADER_H,
                    fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                    fontSize: 10, fontWeight: 700, textAlign: 'center',
                    cursor: 'pointer',
                    borderRight: '1px solid rgba(255,255,255,0.08)',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                    background: teamColor,
                    color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.6)',
                    opacity: dimmed ? 0.35 : 1,
                    transition: 'opacity 0.15s ease, box-shadow 0.15s ease',
                    boxShadow: isHighlighted ? 'inset 0 0 0 1px rgba(255,255,255,0.5)' : 'none',
                  }}
                  onClick={() => handleHeaderClick(d.abbr)}
                  onDoubleClick={() => handleHeaderDoubleClick(d.abbr)}
                  onMouseEnter={() => handleMouseEnter(d.abbr)}
                  onMouseLeave={handleMouseLeave}
                >
                  <div style={{ lineHeight: 1.1 }}>
                    {d.abbr}
                    {(pitCountByDriver[d.abbr] || 0) > 0 && (
                      <div style={{
                        fontSize: 7, fontWeight: 400, opacity: 0.75,
                        letterSpacing: '0.03em', marginTop: 1,
                      }}>
                        {pitCountByDriver[d.abbr]}P
                      </div>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {lapNumbers.map((lap) => {
            const isCurrent = lap === currentLap;
            return (
              <tr
                key={lap}
                ref={isCurrent ? currentLapRef : undefined}
                style={isCurrent ? { borderTop: '1px solid rgba(255,255,255,0.25)' } : undefined}
              >
                {/* Lap number */}
                <td style={{
                  position: 'sticky', left: 0, zIndex: 1,
                  width: LAP_COL_W, minWidth: LAP_COL_W, maxWidth: LAP_COL_W,
                  height: ROW_H,
                  background: '#151528',
                  fontSize: 10, textAlign: 'center', verticalAlign: 'middle',
                  borderRight: '1px solid rgba(255,255,255,0.08)',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  color: isCurrent ? '#fff' : '#7a7f9a',
                  fontWeight: isCurrent ? 700 : 400,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {lap}
                </td>
                {/* Driver cells */}
                {sortedDrivers.map((d) => {
                  const abbr = d.abbr;
                  const lapKey = `${abbr}_${lap}`;
                  const { label, style: styleKey, tooltip } = paceCell(
                    gridData, abbr, lap, { currentLap, replayActive, sessionNow },
                  );
                  const isHighlighted = highlightedDriver === abbr;
                  const dimmed = hasSelection && !selectedDrivers.includes(abbr);

                  return (
                    <PaceCell
                      key={lapKey}
                      label={label}
                      cellStyle={CELL_STYLES[styleKey] || CELL_STYLES.default}
                      tooltip={tooltip}
                      isHighlighted={isHighlighted}
                      dimmed={dimmed}
                      onClick={() => handleCellClick(abbr)}
                      onDoubleClick={() => handleCellDoubleClick(abbr, lap)}
                      onMouseEnter={() => handleMouseEnter(abbr)}
                      onMouseLeave={handleMouseLeave}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Pace legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '8px 14px',
        padding: '6px 10px', fontSize: 9,
        color: '#99a', fontFamily: "'JetBrains Mono', monospace",
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(10,10,20,0.98)',
        position: 'sticky', bottom: 0, left: 0, zIndex: 4,
      }}>
        {[
          { color: '#A855F7', label: 'Session Best' },
          { color: '#22C55E', label: 'Personal Best' },
          { color: '#88FFAA', label: 'Fast' },
          { color: '#aab',    label: 'Normal' },
          { color: '#FBBF24', label: 'Slow' },
          { color: '#FF4444', label: 'Very Slow' },
          { color: '#FFA500', label: 'Pit In' },
          { color: '#44AAFF', label: 'Pit Out' },
        ].map(({ color, label }) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: color, display: 'inline-block', flexShrink: 0,
            }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default React.memo(RacePaceGrid);
