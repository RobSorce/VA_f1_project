import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, countryFlag, F1_POINTS } from '../../utils/colors';
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

export default function Leaderboard({ collapsed }) {
  const toggleLeaderboard = useF1Store((s) => s.toggleLeaderboard);
  const focusedView = useF1Store((s) => s.focusedView);
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
  const compareMode = useF1Store((s) => s.compareMode);
  const addCompareDriver = useF1Store((s) => s.addCompareDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const driversInfo = useF1Store((s) => s.drivers);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const currentTime = useF1Store((s) => s.currentTime);
  const columnMode = useF1Store((s) => s.leaderboardColumnMode);
  const cycleLeaderboardColumn = useF1Store((s) => s.cycleLeaderboardColumn);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const frameData = useF1Store((s) => s.frameData);

  /* ── Local state ──────────────────────────────────────────────────── */
  const [greenFlash, setGreenFlash] = useState(false);

  /* ── Refs ────────────────────────────────────────────────────────── */
  const containerRef = useRef(null);
  const previousPositionsRef = useRef({});
  const previousLapRef = useRef(null);
  const rowRefsMap = useRef({});
  const animatingRowsRef = useRef(new Set());
  const clearChangesTimerRef = useRef(null);

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

  /* ── Country code + points maps from race_results ────────────── */
  const { countryCodeMap, pointsMap } = useMemo(() => {
    const cc = {}, pts = {};
    (sessionData?.race_results || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      if (!abbr) return;
      if (r.CountryCode) cc[abbr] = r.CountryCode;
      if (r.Points != null) pts[abbr] = r.Points;
    });
    return { countryCodeMap: cc, pointsMap: pts };
  }, [sessionData]);

  /* ── Fastest lap driver ──────────────────────────────────────────── */
  const fastestLapDriver = useMemo(() => {
    if (!sessionData?.lap_times) return null;
    let best = Infinity, driver = null;
    for (const d of sessionData.lap_times) {
      if (d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300 && d.LapTimeSeconds < best) {
        best = d.LapTimeSeconds;
        driver = d.Driver;
      }
    }
    return driver;
  }, [sessionData]);

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
    if (!sessionData) return [];

    // ── Qualifying mode: use race_results for positions, frame data for telemetry ──
    if (isQualifyingReplay) {
      const results = sessionData.race_results || [];
      // Get current frame for live telemetry
      const frame = frameData?.frames?.[currentFrameIndex];
      const frameDrivers = frame?.drivers || {};

      // Build best lap time map from lap_times
      const bestLapMap = {};
      (sessionData.lap_times || []).forEach((lt) => {
        if (lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300) {
          if (!bestLapMap[lt.Driver] || lt.LapTimeSeconds < bestLapMap[lt.Driver].time) {
            bestLapMap[lt.Driver] = {
              time: lt.LapTimeSeconds,
              compound: lt.Compound || 'UNKNOWN',
            };
          }
        }
      });

      // Only show drivers that are in the current segment's frame data
      const segDrivers = frameData?.driver_colors ? Object.keys(frameData.driver_colors) : [];

      const filtered = results
        .filter((r) => {
          const abbr = r.Abbreviation || r.Driver;
          return abbr && (segDrivers.length === 0 || segDrivers.includes(abbr));
        })
        .sort((a, b) => (a.Position || 99) - (b.Position || 99));

      // Leader is the first driver in the filtered, sorted list
      const leaderAbbr = filtered.length > 0 ? (filtered[0].Abbreviation || filtered[0].Driver) : null;
      const leaderTime = leaderAbbr ? bestLapMap[leaderAbbr]?.time : null;

      return filtered.map((r, i) => {
          const abbr = r.Abbreviation || r.Driver;
          const fd = frameDrivers[abbr];
          const best = bestLapMap[abbr];
          const COMPOUND_NAMES = { 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };

          return {
            pos: i + 1,
            abbr,
            color: getDriverColor(abbr),
            compound: fd ? (COMPOUND_NAMES[fd.tyre] || 'UNKNOWN') : (best?.compound || 'UNKNOWN'),
            tyreLife: fd ? fd.tyre_life : 0,
            lapTime: best?.time || null,
            bestLap: best?.time || null,
            interval: i === 0 ? null : (best?.time && leaderTime
              ? +(best.time - leaderTime).toFixed(3)
              : null),
            gapToLeader: i === 0 ? null : (best?.time && leaderTime
              ? +(best.time - leaderTime).toFixed(3)
              : null),
            isPitting: false,
            isRetired: false,
            retiredStatus: null,
            retiredLap: null,
            isGrid: false,
            speed: fd?.speed || null,
          };
        });
    }

    // ── Race/Sprint mode: need lap_times ──
    if (!sessionData.lap_times?.length) return [];

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

    // ── Race mode: use lap_times for progressive positions ──
    const lapTimes = sessionData.lap_times;

    // Compute time offset: session times are absolute, frame times are 0-based
    let timeOffset = 0;
    for (const d of lapTimes) {
      if (d.LapStartTime > 0 && d.Time > 0 && d.LapNumber >= 1) {
        timeOffset = d.LapStartTime;
        break;
      }
    }

    const drivers = new Map();
    const prevLapByDriver = new Map(); // track previous lap for lap time fallback

    lapTimes
      .filter((d) => d.LapNumber <= currentLap)
      .forEach((d) => {
        // Only include laps the driver has actually started in the replay timeline
        if (d.LapStartTime > 0 && currentTime < d.LapStartTime - timeOffset) return;
        const existing = drivers.get(d.Driver);
        if (!existing || d.LapNumber > existing.LapNumber) {
          if (existing) prevLapByDriver.set(d.Driver, existing);
          drivers.set(d.Driver, d);
        }
      });

    const rows = Array.from(drivers.values())
      .sort((a, b) => (a.Position || 99) - (b.Position || 99))
      .map((d, i) => {
        const dnf = dnfMap[d.Driver];
        const isRetired = dnf && dnf.lastLap <= currentLap;

        // Pit status: verify the pit entry has actually happened in the timeline
        const pitInAdjusted = d.PitInTime > 0 ? d.PitInTime - timeOffset : null;
        const pitOutAdjusted = d.PitOutTime > 0 ? d.PitOutTime - timeOffset : null;
        const isPitting = pitInAdjusted != null && currentTime >= pitInAdjusted &&
                          (pitOutAdjusted == null || currentTime < pitOutAdjusted);

        return {
          pos: i + 1,
          abbr: d.Driver,
          color: getDriverColor(d.Driver),
          compound: d.Compound || 'UNKNOWN',
          tyreLife: d.TyreLife || 0,
          lapTime: d.LapTimeSeconds || (prevLapByDriver.get(d.Driver)?.LapTimeSeconds) || null,
          bestLap: null,
          interval: d.IntervalToAhead || null,
          gapToLeader: d.GapToLeader || null,
          isPitting,
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
  }, [sessionData, currentLap, currentTime, dnfMap, replayStarted, isQualifyingReplay, frameData, currentFrameIndex]);

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
        // Clear any pending timer from a previous lap change, then start a new one
        if (clearChangesTimerRef.current) clearTimeout(clearChangesTimerRef.current);
        setDisplayedChanges(positionChanges);
        clearChangesTimerRef.current = setTimeout(() => {
          setDisplayedChanges({});
          clearChangesTimerRef.current = null;
        }, 1500);
      }

      // Snapshot current positions for next comparison
      const newPositions = {};
      for (const d of standings) {
        newPositions[d.abbr] = d.pos;
      }
      previousPositionsRef.current = newPositions;
      previousLapRef.current = currentLap;
    }
  }, [currentLap, standings, positionChanges]);

  // Cleanup timer on unmount
  useEffect(() => () => {
    if (clearChangesTimerRef.current) clearTimeout(clearChangesTimerRef.current);
  }, []);

  /* ── Position-change highlight flash (CSS transition handles the slide) */
  useEffect(() => {
    if (!standings.length) return;

    // First: clean ALL stale animation classes from every row.
    // This prevents classes from persisting when fast playback skips cleanup.
    for (const abbr of Object.keys(rowRefsMap.current)) {
      const el = rowRefsMap.current[abbr];
      if (el) {
        el.classList.remove('tower-row--animating', 'tower-row--gained', 'tower-row--lost');
      }
    }
    animatingRowsRef.current.clear();

    const activeListeners = [];

    standings.forEach((d) => {
      const rowEl = rowRefsMap.current[d.abbr];
      if (!rowEl) return;

      const change = displayedChanges[d.abbr];
      if (change) {
        const cls = change === 'gained' ? 'tower-row--gained' : 'tower-row--lost';
        animatingRowsRef.current.add(d.abbr);
        rowEl.classList.add('tower-row--animating', cls);

        // Use animationend for reliable cleanup instead of setTimeout
        const handler = () => {
          animatingRowsRef.current.delete(d.abbr);
          rowEl.classList.remove('tower-row--animating', cls);
          rowEl.removeEventListener('animationend', handler);
        };
        rowEl.addEventListener('animationend', handler);
        activeListeners.push({ el: rowEl, handler, abbr: d.abbr, cls });
      }
    });

    return () => {
      activeListeners.forEach(({ el, handler, abbr, cls }) => {
        el.removeEventListener('animationend', handler);
        el.classList.remove('tower-row--animating', cls);
        animatingRowsRef.current.delete(abbr);
      });
    };
  }, [standings, displayedChanges]);

  /* ── Column mode toggle ───────────────────────────────────────────── */
  const cycleColumnMode = cycleLeaderboardColumn;

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
    if (!isFinite(gap)) return '';
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
          {d.retiredLap && <span style={{ fontSize: '7px', marginLeft: 3, opacity: 0.7 }}>L{d.retiredLap}</span>}
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

  const bezelActive = isHazard || (raceFinished && winnerColor);
  const activeColor = raceFinished && winnerColor ? winnerColor : flagBorderColor;

  const panelBorderStyle = {
    '--bezel-color': bezelActive ? activeColor : 'transparent',
    '--bezel-color-dim': bezelActive ? `${activeColor}44` : 'transparent',
    '--bezel-color-glow': bezelActive ? `${activeColor}33` : 'transparent',
    border: 'none',
    boxShadow: bezelActive
      ? `0 0 20px ${activeColor}33, 0 0 40px ${activeColor}18, 0 8px 32px rgba(0,0,0,0.40)`
      : '0 8px 32px rgba(0,0,0,0.40)',
    transition: 'box-shadow 0.4s ease',
  };

  /* ── Header (broadcast style) ─────────────────────────────────────── */
  const qualiSegment = useF1Store((s) => s.qualiSegment);
  const prevColumnMode = () => {
    // Cycle backwards through COLUMN_MODES
    const prevIdx = (columnMode - 1 + COLUMN_MODES.length) % COLUMN_MODES.length;
    // Use the store setter directly
    useF1Store.setState({ leaderboardColumnMode: prevIdx });
  };

  const header = (
    <div className="tower-broadcast-header">
      <div className="tower-broadcast-header__left">
        <div className="tower-broadcast-header__accent" />
        <span className="tower-broadcast-header__title">{isQualifyingReplay ? qualiSegment || 'QUALIFYING' : 'RACE'}</span>
        <kbd className="panel-shortcut-hint" title="Press 2 to focus" style={{ opacity: focusedView === 'leaderboard' ? 1 : undefined }}>2</kbd>
      </div>
      <div className="tower-broadcast-header__right">
        <button
          className="leaderboard-toggle leaderboard-toggle--collapse"
          onClick={toggleLeaderboard}
          title="Collapse leaderboard (L)"
        >
          {'\u276E'}
        </button>
        {isQualifyingReplay ? (
          <div className="tower-broadcast-header__lap">
            <span className="tower-broadcast-header__lap-label">QUALIFYING</span>
          </div>
        ) : (
          <div className="tower-broadcast-header__lap">
            <span className="tower-broadcast-header__lap-label">LAP</span>
            <span className="tower-broadcast-header__lap-current">{currentLap}</span>
            <span className="tower-broadcast-header__lap-total">/{maxLap}</span>
          </div>
        )}
      </div>
    </div>
  );

  const modeBar = (
    <div className="tower-mode-bar">
      <button className="tower-mode-bar__arrow" onClick={prevColumnMode} title="Previous mode">
        {'\u2039'}
      </button>
      <span className="tower-mode-bar__label">{COLUMN_MODES[columnMode]}</span>
      <button className="tower-mode-bar__arrow" onClick={cycleColumnMode} title="Next mode">
        {'\u203A'}
      </button>
    </div>
  );

  /* ── Collapsed render ─────────────────────────────────────────────── */
  if (collapsed) {
    return (
      <div className="leaderboard-collapsed">
        <button className="leaderboard-toggle leaderboard-toggle--expand" onClick={toggleLeaderboard} title="Expand leaderboard (L)">
          {'\u276F'}
        </button>
        <div className="leaderboard-collapsed__label">STANDINGS</div>
        <div className="leaderboard-collapsed__positions">
          {standings.slice(0, 20).map((d) => (
            <div
              key={d.abbr}
              className={`leaderboard-collapsed__pos${selectedDrivers.includes(d.abbr) ? ' leaderboard-collapsed__pos--selected' : ''}`}
              style={{ borderLeftColor: d.color }}
              onClick={() => toggleDriver(d.abbr)}
              title={d.abbr}
            >
              <span className="leaderboard-collapsed__num">{d.isRetired ? '—' : d.pos}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── Main render ──────────────────────────────────────────────────── */
  return (
    <Panel className={`panel--leaderboard${bezelActive ? ' panel--bezel-active' : ''}`} style={{ padding: 0, ...panelBorderStyle }} focused={focusedView === 'leaderboard'}>
      {header}
      {modeBar}

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
              onClick={() => compareMode ? addCompareDriver(d.abbr) : toggleDriver(d.abbr)}
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
                {displayedChanges[d.abbr] === 'gained' && (
                  <span className="tower-row__arrow tower-row__arrow--up tower-row__arrow--active">{'\u25B2'}</span>
                )}
                {displayedChanges[d.abbr] === 'lost' && (
                  <span className="tower-row__arrow tower-row__arrow--down tower-row__arrow--active">{'\u25BC'}</span>
                )}
              </span>

              <span className="tower-row__driver-cell">
                <span
                  className="tower-row__team-bar"
                  style={{ backgroundColor: d.color }}
                />
                {raceFinished && countryCodeMap[d.abbr] && (
                  <span style={{ fontSize: '11px', marginRight: 2, lineHeight: 1 }}>
                    {countryFlag(countryCodeMap[d.abbr])}
                  </span>
                )}
                <span className="tower-row__driver-name" style={d.isRetired ? { textDecoration: 'line-through', textDecorationColor: 'rgba(225,6,0,0.5)' } : undefined}>{d.abbr}</span>
                {d.isRetired && <span className="tower-row__out-badge">OUT</span>}
                {lstmPredictions?.driver_predictions?.[d.abbr] != null && (() => {
                  const pred = lstmPredictions.driver_predictions[d.abbr];
                  if (!pred) return null;
                  const delta = pred.predicted_position_change || 0;
                  if (delta === 0) return null;
                  return (
                    <span style={{ fontSize: '9px', marginLeft: 3, color: delta < 0 ? '#22c55e' : '#ef4444', fontWeight: 800 }}>
                      {delta < 0 ? '\u25B2' : '\u25BC'}
                    </span>
                  );
                })()}
                {raceFinished && fastestLapDriver === d.abbr && (
                  <span style={{
                    fontSize: '7px', marginLeft: 4, padding: '1px 3px',
                    borderRadius: 3, background: 'rgba(168,85,247,0.25)',
                    color: '#a855f7', fontWeight: 800, letterSpacing: '0.04em',
                  }}>FL</span>
                )}
              </span>

              <span className="tower-row__value">
                {raceFinished && !d.isRetired && d.pos <= 10 ? (
                  <span className="tower-row__points-badge" style={{
                    color: '#ffd700',
                    fontWeight: 700,
                    fontSize: '10px',
                    letterSpacing: '0.02em',
                  }}>
                    +{pointsMap[d.abbr] != null ? pointsMap[d.abbr] : (F1_POINTS[d.pos] || 0)}
                  </span>
                ) : (
                  renderColumnValue(d)
                )}
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
