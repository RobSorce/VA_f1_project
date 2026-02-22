import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import Panel from '../ui/Panel';

/* ── Flag constants ─────────────────────────────────────────────────── */
const FLAG_BORDER_COLORS = {
  '1': 'transparent',
  '2': '#FFCC00',
  '4': '#FF8C00',
  '5': '#FF0000',
  '6': '#FF8C00',
  '7': '#FF8C00',
};

const FLAG_BANNER = {
  '2': { label: 'YELLOW FLAG', bg: 'rgba(255,204,0,0.15)', color: '#FFCC00' },
  '4': { label: 'SAFETY CAR', bg: 'rgba(255,140,0,0.15)', color: '#FF8C00' },
  '5': { label: 'RED FLAG', bg: 'rgba(255,0,0,0.15)', color: '#FF0000' },
  '6': { label: 'VSC', bg: 'rgba(255,140,0,0.15)', color: '#FF8C00' },
  '7': { label: 'VSC', bg: 'rgba(255,140,0,0.15)', color: '#FF8C00' },
};

/* ── Medal colors for P1/P2/P3 ─────────────────────────────────────── */
const MEDAL_BG = {
  1: 'linear-gradient(135deg, #FFD700 0%, #DAA520 100%)',
  2: 'linear-gradient(135deg, #C0C0C0 0%, #A0A0A0 100%)',
  3: 'linear-gradient(135deg, #CD7F32 0%, #A0652F 100%)',
};

/* ── Layout constants ───────────────────────────────────────────────── */
const ROW_HEIGHT = 28;

/* ── Column display modes ───────────────────────────────────────────── */
const COLUMN_MODES = ['INT', 'GAP', 'TYRE'];

const TYRE_DISPLAY_NAMES = {
  SOFT: 'SOFT',
  MEDIUM: 'MED',
  HARD: 'HARD',
  INTERMEDIATE: 'INTER',
  WET: 'WET',
  UNKNOWN: '—',
};

export default function Leaderboard() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const currentFlagStatus = useF1Store((s) => s.currentFlagStatus);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const driversInfo = useF1Store((s) => s.drivers);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);

  /* ── Local state ──────────────────────────────────────────────────── */
  const [columnMode, setColumnMode] = useState(0); // index into COLUMN_MODES
  const [greenFlash, setGreenFlash] = useState(false);

  /* ── Refs ────────────────────────────────────────────────────────── */
  const containerRef = useRef(null);
  const previousPositionsRef = useRef({});
  const previousLapRef = useRef(null);
  const rowRefsMap = useRef({});
  const animatingRowsRef = useRef(new Set());

  /* ── Replay started gate ───────────────────────────────────────── */
  const replayStarted = currentFrameIndex > 0 || currentLap > 1;

  /* ── Green flag flash logic ──────────────────────────────────────── */
  const prevFlagRef = useRef(currentFlagStatus);
  useEffect(() => {
    if (currentFlagStatus === '1' && prevFlagRef.current !== '1') {
      setGreenFlash(true);
      const timer = setTimeout(() => setGreenFlash(false), 4000);
      prevFlagRef.current = currentFlagStatus;
      return () => clearTimeout(timer);
    }
    prevFlagRef.current = currentFlagStatus;
  }, [currentFlagStatus]);

  /* ── Driver info lookup ──────────────────────────────────────────── */
  const driverInfoMap = useMemo(() => {
    const map = {};
    (driversInfo || []).forEach((d) => {
      const full = d.FullName || d.Abbreviation;
      const parts = full.trim().split(/\s+/);
      const surname = parts.length > 1 ? parts.slice(-1)[0] : full;
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
      map[d.Abbreviation] = {
        fullName: full,
        firstName,
        surname,
        driverNumber: d.DriverNumber || '',
      };
    });
    return map;
  }, [driversInfo]);

  /* ── Grid position map (for persistent gained/lost arrows) ─────── */
  const gridPositionMap = useMemo(() => {
    const map = {};
    (sessionData?.race_results || [])
      .filter((r) => r.GridPosition != null && r.GridPosition > 0)
      .sort((a, b) => a.GridPosition - b.GridPosition)
      .forEach((r, i) => {
        const abbr = r.Abbreviation || r.Driver;
        if (abbr) map[abbr] = i + 1;
      });
    return map;
  }, [sessionData]);

  /* ── Compute standings from lap data ──────────────────────────────── */
  const standings = useMemo(() => {
    if (!sessionData?.lap_times) return [];

    // Before replay starts, show grid positions if available
    if (!replayStarted) {
      const results = sessionData.race_results || [];
      if (results.length > 0) {
        return results
          .filter((r) => r.GridPosition != null && r.GridPosition > 0)
          .sort((a, b) => a.GridPosition - b.GridPosition)
          .map((r, i) => ({
            pos: i + 1,
            abbr: r.Abbreviation || r.Driver || `P${i + 1}`,
            color: getDriverColor(r.Abbreviation || r.Driver || ''),
            compound: 'UNKNOWN',
            tyreLife: 0,
            lapTime: null,
            bestLap: null,
            interval: null,
            gapToLeader: null,
            isPitting: false,
            isRetired: false,
            retiredStatus: null,
            retiredLap: null,
            isGrid: true,
          }));
      }
      return [];
    }

    const lapTimes = sessionData.lap_times;
    const drivers = new Map();

    lapTimes
      .filter((d) => d.LapNumber <= currentLap)
      .forEach((d) => {
        const existing = drivers.get(d.Driver);
        if (!existing || d.LapNumber > existing.LapNumber) {
          drivers.set(d.Driver, d);
        }
      });

    const rows = Array.from(drivers.values())
      .sort((a, b) => (a.Position || 99) - (b.Position || 99))
      .map((d, i) => {
        const dnf = dnfMap[d.Driver];
        const isRetired = dnf && dnf.lastLap <= currentLap;

        return {
          pos: i + 1,
          abbr: d.Driver,
          color: getDriverColor(d.Driver),
          compound: d.Compound || 'UNKNOWN',
          tyreLife: d.TyreLife || 0,
          lapTime: d.LapTimeSeconds,
          bestLap: null,
          interval: d.IntervalToAhead || null,
          gapToLeader: d.GapToLeader || null,
          isPitting: d.PitOutTime != null && d.PitInTime != null &&
                     d.LapNumber === currentLap,
          isRetired,
          retiredStatus: isRetired ? dnf.status : null,
          retiredLap: isRetired ? dnf.lastLap : null,
          isGrid: false,
        };
      });

    const active = rows.filter((r) => !r.isRetired);
    const retired = rows.filter((r) => r.isRetired);
    active.forEach((r, i) => { r.pos = i + 1; });
    retired.forEach((r, i) => { r.pos = active.length + i + 1; });
    return [...active, ...retired];
  }, [sessionData, currentLap, dnfMap, replayStarted]);

  /* ── Position change computation ──────────────────────────────────── */
  const [displayedChanges, setDisplayedChanges] = useState({});

  const positionChanges = useMemo(() => {
    const changes = {};
    const prev = previousPositionsRef.current;

    // Only detect changes if we have a previous snapshot
    if (Object.keys(prev).length > 0) {
      for (const d of standings) {
        const prevPos = prev[d.abbr];
        if (prevPos != null && prevPos !== d.pos) {
          changes[d.abbr] = prevPos > d.pos ? 'gained' : 'lost';
        }
      }
    }

    return changes;
  }, [standings]);

  /* ── Update previous positions immediately on lap change ──────────── */
  useEffect(() => {
    if (currentLap !== previousLapRef.current && standings.length > 0) {
      // Show arrows for drivers involved in position changes
      const hasChanges = Object.keys(positionChanges).length > 0;
      if (hasChanges) {
        setDisplayedChanges(positionChanges);
      }

      // Snapshot current positions for next comparison
      const newPositions = {};
      for (const d of standings) {
        newPositions[d.abbr] = d.pos;
      }
      previousPositionsRef.current = newPositions;
      previousLapRef.current = currentLap;

      // Auto-clear arrows after animation completes
      if (hasChanges) {
        const timer = setTimeout(() => setDisplayedChanges({}), 1500);
        return () => clearTimeout(timer);
      }
    }
  }, [currentLap, standings, positionChanges]);

  /* ── Position-change highlight flash (CSS transition handles the slide) */
  useEffect(() => {
    if (!standings.length) return;

    const cleanupTimers = [];

    standings.forEach((d) => {
      const rowEl = rowRefsMap.current[d.abbr];
      if (!rowEl) return;

      const change = displayedChanges[d.abbr];
      if (change) {
        const cls = change === 'gained' ? 'tower-row--gained' : 'tower-row--lost';
        animatingRowsRef.current.add(d.abbr);
        rowEl.classList.add('tower-row--animating', cls);

        const timer = setTimeout(() => {
          animatingRowsRef.current.delete(d.abbr);
          rowEl.classList.remove('tower-row--animating', cls);
        }, 1200);
        cleanupTimers.push(timer);
      }
    });

    return () => cleanupTimers.forEach(clearTimeout);
  }, [standings, displayedChanges]);

  /* ── Column mode toggle ───────────────────────────────────────────── */
  const cycleColumnMode = useCallback(() => {
    setColumnMode((prev) => (prev + 1) % COLUMN_MODES.length);
  }, []);

  /* ── Formatters ───────────────────────────────────────────────────── */
  const formatTime = (s) => {
    if (!s || s <= 0) return '--:--.---';
    const min = Math.floor(s / 60);
    const sec = (s % 60).toFixed(3);
    return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
  };

  const formatGap = (gap) => {
    if (gap == null || gap === 0) return '';
    if (typeof gap === 'string') return gap;
    return gap > 0 ? `+${gap.toFixed(3)}` : gap.toFixed(3);
  };

  /* ── Render column value based on mode ──────────────────────────── */
  const renderColumnValue = (d) => {
    if (d.isGrid) {
      return <span className="tower-col-value tower-col-value--grid">GRID</span>;
    }

    const mode = COLUMN_MODES[columnMode];

    if (d.isRetired) {
      return (
        <span className="tower-col-value tower-col-value--retired">
          {d.retiredStatus || 'RET'}
        </span>
      );
    }

    if (d.isPitting) {
      return (
        <span className="tower-col-value tower-col-value--pit">IN PIT</span>
      );
    }

    if (mode === 'INT') {
      if (d.pos === 1) {
        return <span className="tower-col-value tower-col-value--leader">LEADER</span>;
      }
      return <span className="tower-col-value">{formatGap(d.interval)}</span>;
    }

    if (mode === 'GAP') {
      if (d.pos === 1) {
        return <span className="tower-col-value tower-col-value--leader">LEADER</span>;
      }
      return <span className="tower-col-value">{formatGap(d.gapToLeader)}</span>;
    }

    if (mode === 'TYRE') {
      return (
        <span className="tower-col-value tower-col-value--tyre">
          <span style={{ color: TYRE_COLORS[d.compound] || '#888' }}>
            {TYRE_DISPLAY_NAMES[d.compound] || '?'}
          </span>
          <span className="tower-tyre-age">L{d.tyreLife}</span>
        </span>
      );
    }

    return null;
  };

  /* ── Debounced highlight (so MFD card stays when mouse moves to it) ─ */
  const handleMouseEnter = useCallback((abbr, e) => {
    clearTimeout(window.__f1HighlightTimer);
    setHighlightedDriver(abbr, { x: e.clientX, y: e.clientY });
  }, [setHighlightedDriver]);

  const handleMouseLeave = useCallback(() => {
    window.__f1HighlightTimer = setTimeout(() => {
      setHighlightedDriver(null);
    }, 300);
  }, [setHighlightedDriver]);

  /* ── Race finished detection ─────────────────────────────────────── */
  const raceFinished = currentLap >= maxLap && maxLap > 1;
  const winner = standings.length > 0 && !standings[0].isRetired ? standings[0] : null;

  /* ── Flag border styling ──────────────────────────────────────────── */
  const flagBorderColor = greenFlash
    ? '#00e676'
    : (FLAG_BORDER_COLORS[currentFlagStatus] || 'transparent');
  const flagBanner = FLAG_BANNER[currentFlagStatus];
  const isHazard = flagBorderColor !== 'transparent';

  const winnerColor = raceFinished && winner ? winner.color : null;

  const panelBorderStyle = raceFinished && winnerColor
    ? {
        '--hazard-color': winnerColor,
        '--hazard-color-bright': winnerColor,
        '--hazard-color-dim': `${winnerColor}44`,
        border: `3px solid ${winnerColor}`,
        boxShadow: `0 0 20px ${winnerColor}55`,
        animation: 'hazard-border-pulse 2s ease-in-out infinite',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
      }
    : {
        '--hazard-color': flagBorderColor,
        '--hazard-color-bright': flagBorderColor,
        '--hazard-color-dim': `${flagBorderColor}44`,
        border: isHazard
          ? `3px solid ${flagBorderColor}`
          : '2px solid rgba(255, 255, 255, 0.12)',
        boxShadow: isHazard
          ? `0 0 16px ${flagBorderColor}44`
          : '0 4px 30px rgba(0, 0, 0, 0.3)',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        animation: isHazard ? 'hazard-border-pulse 1.2s ease-in-out infinite' : 'none',
      };

  /* ── Header (broadcast style) ─────────────────────────────────────── */
  const header = (
    <div className="tower-broadcast-header">
      <div className="tower-broadcast-header__left">
        <div className="tower-broadcast-header__accent" />
        <span className="tower-broadcast-header__title">RACE</span>
      </div>
      <div className="tower-broadcast-header__right">
        <button
          className="tower-mode-toggle"
          onClick={cycleColumnMode}
          title={`Display: ${COLUMN_MODES[columnMode]}`}
        >
          {COLUMN_MODES[columnMode]}
        </button>
        <div className="tower-broadcast-header__lap">
          <span className="tower-broadcast-header__lap-label">LAP</span>
          <span className="tower-broadcast-header__lap-current">{currentLap}</span>
          <span className="tower-broadcast-header__lap-total">/{maxLap}</span>
        </div>
      </div>
    </div>
  );

  /* ── Main render ──────────────────────────────────────────────────── */
  return (
    <Panel className="panel--leaderboard" style={{ padding: 0, ...panelBorderStyle }}>
      {header}

      {/* Winner banner */}
      {raceFinished && winner && (() => {
        const winnerInfo = driverInfoMap[winner.abbr] || {};
        return (
          <div className="tower-flag-banner" style={{
            background: `linear-gradient(90deg, ${winner.color}25, transparent, ${winner.color}25)`,
            borderBottom: `1px solid ${winner.color}55`,
            animation: 'winner-banner-glow 2s ease-in-out infinite',
          }}>
            <span className="tower-flag-banner__label" style={{ color: '#fff', letterSpacing: '0.2em' }}>
              CHEQUERED FLAG
            </span>
            <span style={{
              fontWeight: 900,
              fontSize: '12px',
              color: winner.color,
              fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              {winnerInfo.fullName || winner.abbr} WINS
            </span>
          </div>
        );
      })()}

      {/* Flag banner */}
      {!raceFinished && flagBanner && (
        <div className="tower-flag-banner" style={{
          background: flagBanner.bg,
          borderBottom: `1px solid ${flagBanner.color}33`,
        }}>
          <span className="tower-flag-banner__label" style={{ color: flagBanner.color }}>
            {flagBanner.label}
          </span>
        </div>
      )}

      {/* Column sub-header */}
      <div className="tower-col-header">
        <span className="tower-col-header__pos">P</span>
        <span className="tower-col-header__change"></span>
        <span className="tower-col-header__driver">Driver</span>
        <span className="tower-col-header__value">{COLUMN_MODES[columnMode]}</span>
        <span className="tower-col-header__tyre-dot"></span>
      </div>

      {/* Driver rows */}
      <div
        className="tower-body"
        ref={containerRef}
        style={{
          position: 'relative',
          height: standings.length > 0 ? standings.length * ROW_HEIGHT : 'auto',
          minHeight: standings.length === 0 ? 120 : undefined,
        }}
      >
        {standings.map((d) => {
          const isSelected = selectedDrivers.includes(d.abbr);
          const isHighlighted = d.abbr === highlightedDriver;
          const isFocused = d.abbr === focusDriver;
          const isP1 = d.pos === 1;
          const isOdd = d.pos % 2 === 1;

          // Persistent grid-vs-current position change
          const gridPos = gridPositionMap[d.abbr];
          const gridDelta = (!d.isGrid && !d.isRetired && gridPos != null)
            ? gridPos - d.pos
            : 0;

          const isWinner = raceFinished && isP1 && !d.isRetired;
          const rowClasses = [
            'tower-row',
            isSelected && 'tower-row--selected',
            isHighlighted && 'tower-row--highlighted',
            isFocused && 'tower-row--focused',
            isP1 && !d.isRetired && 'tower-row--leader',
            isWinner && 'tower-row--winner',
            isOdd && 'tower-row--odd',
            d.isRetired && 'tower-row--retired',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <div
              key={d.abbr}
              ref={(el) => { rowRefsMap.current[d.abbr] = el; }}
              className={rowClasses}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${(d.pos - 1) * ROW_HEIGHT}px)`,
                ...(isFocused ? {
                  borderLeft: `4px solid ${d.color}`,
                  boxShadow: `inset 6px 0 12px -2px ${d.color}55, 0 0 8px ${d.color}22`,
                } : isSelected ? {
                  borderLeft: `3px solid ${d.color}`,
                  boxShadow: `inset 4px 0 8px -2px ${d.color}44`,
                } : {}),
              }}
              onClick={() => toggleDriver(d.abbr)}
              onDoubleClick={() => setFocusDriver(d.abbr)}
              onMouseEnter={(e) => handleMouseEnter(d.abbr, e)}
              onMouseLeave={handleMouseLeave}
            >
              {/* Position number + grid arrows */}
              <span className="tower-row__pos-group">
                {gridDelta > 0 && (
                  <span className="tower-row__grid-arrows tower-row__grid-arrows--up">
                    {'\u25B2'}
                  </span>
                )}
                {gridDelta < 0 && (
                  <span className="tower-row__grid-arrows tower-row__grid-arrows--down">
                    {'\u25BC'}
                  </span>
                )}
                <span
                  className={`tower-row__pos ${d.isRetired ? 'tower-row__pos--retired' : ''}`}
                  style={raceFinished && !d.isRetired && d.pos <= 3 ? {
                    background: MEDAL_BG[d.pos],
                    color: d.pos === 1 ? '#000' : d.pos === 2 ? '#000' : '#fff',
                    borderRadius: 3,
                    width: 20,
                    height: 18,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                  } : undefined}
                >
                  {d.isRetired ? 'RET' : d.pos}
                </span>
              </span>

              <span className="tower-row__change">
                {/* Empty spacer — kept for layout consistency */}
              </span>

              <span className="tower-row__driver-cell">
                <span
                  className="tower-row__team-bar"
                  style={{ backgroundColor: d.color }}
                />
                <span className="tower-row__driver-name">{d.abbr}</span>
                {lstmPredictions?.driver_predictions?.[d.abbr] != null && (() => {
                  const pred = lstmPredictions.driver_predictions[d.abbr];
                  const delta = pred.predicted_position_change || 0;
                  if (delta === 0) return null;
                  return (
                    <span style={{ fontSize: '9px', marginLeft: 3, color: delta < 0 ? '#22c55e' : '#ef4444', fontWeight: 800 }}>
                      {delta < 0 ? '\u25B2' : '\u25BC'}
                    </span>
                  );
                })()}
              </span>

              <span className="tower-row__value">
                {renderColumnValue(d)}
              </span>

              <span className="tower-row__tyre-dot">
                <span
                  className="tower-tyre-circle"
                  style={{ backgroundColor: TYRE_COLORS[d.compound] || '#888' }}
                  title={`${d.compound} - ${d.tyreLife} laps`}
                />
              </span>
            </div>
          );
        })}

        {standings.length === 0 && (
          <div className="loading-placeholder">
            <span>{sessionData ? 'Press play to start' : 'Load a session to see standings'}</span>
          </div>
        )}
      </div>

      {lstmPredictions && (
        <div style={{
          padding: '4px 8px',
          background: 'rgba(255,255,255,0.04)',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          fontSize: '9px',
          color: 'rgba(255,255,255,0.6)',
          lineHeight: 1.4,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <span>PIT PROB</span>
            <span style={{ color: lstmPredictions.pit_probability > 0.5 ? '#f5a623' : '#888', fontWeight: 700 }}>
              {(lstmPredictions.pit_probability * 100).toFixed(0)}%
            </span>
          </div>
          {lstmPredictions.optimal_pit_lap && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>OPT PIT LAP</span>
              <span style={{ color: '#f5a623', fontWeight: 700 }}>L{lstmPredictions.optimal_pit_lap}</span>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
