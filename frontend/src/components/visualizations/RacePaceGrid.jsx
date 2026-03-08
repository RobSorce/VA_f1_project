import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';

/* -- Format helpers -------------------------------------------------------- */
function formatLapTime(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

function formatSector(seconds) {
  if (!seconds || seconds <= 0) return '';
  return seconds.toFixed(1);
}

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
};

/* -- Classify a cell ------------------------------------------------------- */
function classifyCell(lapEntry, lap, currentLap, sessionBest, driverBest, dnfInfo) {
  if (lap > currentLap) return { label: '', style: 'future' };

  if (dnfInfo) {
    if (lap > dnfInfo.lastLap + 1) return { label: '', style: 'future' };
    if (lap === dnfInfo.lastLap + 1) {
      const status = dnfInfo.status || 'RET';
      const short = status.length > 4 ? 'RET' : status;
      return { label: short, style: 'dnf' };
    }
  }

  if (!lapEntry) return { label: '-', style: 'empty' };

  const { LapTimeSeconds, PitInTime, PitOutTime } = lapEntry;

  if (PitInTime) {
    const time = LapTimeSeconds > 0 ? formatLapTime(LapTimeSeconds) : 'IN PIT';
    return { label: time, style: 'pit-in' };
  }

  if (PitOutTime) {
    const time = LapTimeSeconds > 0 ? formatLapTime(LapTimeSeconds) : 'OUT';
    return { label: time, style: 'pit-out' };
  }

  if (!LapTimeSeconds || LapTimeSeconds <= 0) return { label: '-', style: 'empty' };

  const time = LapTimeSeconds;
  if (sessionBest && Math.abs(time - sessionBest) < 0.0005)
    return { label: formatLapTime(time), style: 'session-best' };
  if (driverBest && Math.abs(time - driverBest) < 0.0005)
    return { label: formatLapTime(time), style: 'personal-best' };
  if (driverBest && time < driverBest + 0.3)
    return { label: formatLapTime(time), style: 'good' };
  if (driverBest && time < driverBest + 0.5)
    return { label: formatLapTime(time), style: 'slower' };
  if (driverBest && time > driverBest + 1.5)
    return { label: formatLapTime(time), style: 'very-slow' };
  return { label: formatLapTime(time), style: 'default' };
}

/* -- Build tooltip string -------------------------------------------------- */
function buildTooltip(driver, lap, lapEntry) {
  if (!lapEntry) return `${driver} - Lap ${lap}: no data`;
  const parts = [`${driver} - Lap ${lap}`];
  if (lapEntry.LapTimeSeconds > 0) parts.push(`: ${formatLapTime(lapEntry.LapTimeSeconds)}`);
  const sectors = [];
  if (lapEntry.Sector1TimeSeconds > 0) sectors.push(`S1: ${formatSector(lapEntry.Sector1TimeSeconds)}`);
  if (lapEntry.Sector2TimeSeconds > 0) sectors.push(`S2: ${formatSector(lapEntry.Sector2TimeSeconds)}`);
  if (lapEntry.Sector3TimeSeconds > 0) sectors.push(`S3: ${formatSector(lapEntry.Sector3TimeSeconds)}`);
  if (sectors.length) parts.push(` (${sectors.join(', ')})`);
  if (lapEntry.Compound) {
    const life = lapEntry.TyreLife != null ? ` L${lapEntry.TyreLife}` : '';
    parts.push(` - ${lapEntry.Compound}${life}`);
  }
  return parts.join('');
}

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
  onClick, onMouseEnter, onMouseLeave,
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
  const maxLap = useF1Store((s) => s.maxLap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const triggerLSTMPredictions = useF1Store((s) => s.triggerLSTMPredictions);

  const lapTimes = sessionData?.lap_times || [];
  const raceResults = sessionData?.race_results || [];

  const currentLapRef = useRef(null);
  const scrollContainerRef = useRef(null);

  // -- Sort drivers by final position --
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
        const pos = parseInt(r.ClassifiedPosition || r.Position, 10);
        if (!isNaN(pos)) driverSet.get(abbr).position = pos;
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
  }, [lapTimes, raceResults, drivers]);

  // -- Pre-compute lap lookup, session best, and personal bests --
  const { lapLookup, sessionBest, driverBests } = useMemo(() => {
    const lookup = {};
    const driverMins = {};
    let globalMin = Infinity;

    for (const lt of lapTimes) {
      if (!lt.Driver || !lt.LapNumber) continue;
      if (lt.LapNumber > currentLap) continue;
      const key = `${lt.Driver}_${lt.LapNumber}`;
      lookup[key] = lt;

      const time = lt.LapTimeSeconds;
      if (time && time > 0 && !lt.PitInTime && !lt.PitOutTime) {
        if (time < globalMin) globalMin = time;
        if (!driverMins[lt.Driver] || time < driverMins[lt.Driver])
          driverMins[lt.Driver] = time;
      }
    }

    for (const lt of lapTimes) {
      if (!lt.Driver || !lt.LapNumber) continue;
      const key = `${lt.Driver}_${lt.LapNumber}`;
      if (!lookup[key]) lookup[key] = lt;
    }

    return {
      lapLookup: lookup,
      sessionBest: globalMin < Infinity ? globalMin : null,
      driverBests: driverMins,
    };
  }, [lapTimes, currentLap]);

  // -- Get driver team color --
  const driverTeamColors = useMemo(() => {
    const colors = {};
    for (const d of sortedDrivers) colors[d.abbr] = getDriverColor(d.abbr);
    return colors;
  }, [sortedDrivers]);

  // -- Handlers --
  const handleCellClick = useCallback((abbr) => {
    toggleDriver(abbr);
    triggerLSTMPredictions();
  }, [toggleDriver, triggerLSTMPredictions]);

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

  // -- Render --
  if (!lapTimes.length || !sortedDrivers.length) {
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
                  {d.abbr}
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
                  const lapEntry = lapLookup[lapKey] || null;
                  const dnfInfo = dnfMap?.[abbr] || null;
                  const driverBest = driverBests[abbr] || null;

                  const { label, style: styleKey } = classifyCell(
                    lapEntry, lap, currentLap, sessionBest, driverBest, dnfInfo
                  );

                  const tooltip = buildTooltip(abbr, lap, lapEntry);
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
    </div>
  );
}

export default React.memo(RacePaceGrid);
