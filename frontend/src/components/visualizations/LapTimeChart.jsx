import React, { useMemo, useCallback, useState, useRef } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, countryFlag } from '../../utils/colors';
import Panel from '../ui/Panel';

/* ── Color codes for sector/lap timing (F1 TV convention) ───────── */
const TIME_COLORS = {
  overall_best: '#a855f7', // Purple — overall best in the session
  personal_best: '#22c55e', // Green — personal best
  normal: 'rgba(255,255,255,0.75)', // White/grey — normal
  slow: '#fbbf24', // Yellow — significantly slower
  pit: '#e040fb', // Magenta — pit lap
};

/* ── Team name → logo file mapping (handles FastF1 name variations) */
const TEAM_LOGO_MAP = {
  'McLaren': '/team-logos/mclaren.png',
  'Ferrari': '/team-logos/ferrari.png',
  'Red Bull Racing': '/team-logos/red-bull.png',
  'Red Bull': '/team-logos/red-bull.png',
  'Mercedes': '/team-logos/mercedes.png',
  'Aston Martin': '/team-logos/aston-martin.jpg',
  'Alpine': '/team-logos/alpine.png',
  'Alpine F1 Team': '/team-logos/alpine.png',
  'Williams': '/team-logos/williams.png',
  'Haas F1 Team': '/team-logos/haas.png',
  'Haas': '/team-logos/haas.png',
  'RB': '/team-logos/rb.png',
  'Racing Bulls': '/team-logos/rb.png',
  'AlphaTauri': '/team-logos/rb.png',
  'Kick Sauber': '/team-logos/kick-sauber.png',
  'Stake F1 Team Kick Sauber': '/team-logos/kick-sauber.png',
  'Alfa Romeo': '/team-logos/kick-sauber.png',
  'Sauber': '/team-logos/kick-sauber.png',
};

/* ── Column definitions for resizable grid ──────────────────────── */
const COLUMN_DEFS = [
  { key: 'pos',     label: 'P',              defaultW: 30,  minW: 24,  resizable: false, align: 'center' },
  { key: 'bar',     label: '',               defaultW: 3,   minW: 3,   resizable: false, align: 'center' },
  { key: 'team',    label: 'Team',           defaultW: 38,  minW: 22,  resizable: true,  align: 'center' },
  { key: 'driver',  label: 'Driver',         defaultW: 170, minW: 70,  resizable: true,  align: 'flex-start' },
  { key: 's1',      label: 'S1',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 's2',      label: 'S2',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 's3',      label: 'S3',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 'lapTime', label: 'Lap Time',       defaultW: 96,  minW: 56,  resizable: true,  align: 'flex-end' },
  { key: 'gap',     label: 'Gap to fastest', defaultW: 96,  minW: 56,  resizable: true,  align: 'flex-end' },
  { key: 'tyre',    label: 'Tyre',           defaultW: 54,  minW: 36,  resizable: true,  align: 'center' },
  { key: 'laps',    label: 'Laps',           defaultW: 38,  minW: 28,  resizable: true,  align: 'center' },
];

/* ── Format seconds to M:SS.sss ─────────────────────────────────── */
function fmtTime(s) {
  if (!s || s <= 0 || s > 600) return '—';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

function fmtSector(s) {
  if (!s || s <= 0 || s > 120) return '—';
  return s.toFixed(3);
}

function fmtGap(gap) {
  if (gap == null || gap === 0) return '';
  if (typeof gap === 'string') return gap;
  return gap > 0 ? `+${gap.toFixed(3)}` : gap.toFixed(3);
}

export default function LapTimeChart() {
  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const currentTime = useF1Store((s) => s.currentTime);
  const drivers = useF1Store((s) => s.drivers);
  const maxLap = useF1Store((s) => s.maxLap);

  const sessionType = useF1Store((s) => s.sessionType);
  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const raceFinished = currentLap >= maxLap && maxLap > 1;
  const isQualifying = sessionType === 'Q';

  // Qualifying segment filter
  const [qualiFilter, setQualiFilter] = useState('ALL');

  // Compute qualifying segments from race_results positions
  const qualiSegmentMap = useMemo(() => {
    if (!isQualifying) return {};
    const map = {};
    (sessionData?.race_results || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      const pos = r.Position || r.ClassifiedPosition || 99;
      if (!abbr) return;
      if (pos > 15) map[abbr] = 'Q1';
      else if (pos > 10) map[abbr] = 'Q2';
      else map[abbr] = 'Q3';
    });
    return map;
  }, [isQualifying, sessionData]);

  /* ── Country code map from race_results ──────────────────────── */
  const countryCodeMap = useMemo(() => {
    const map = {};
    (sessionData?.race_results || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      if (abbr && r.CountryCode) map[abbr] = r.CountryCode;
    });
    return map;
  }, [sessionData]);

  /* ── Driver info lookup: abbreviation → { fullName, firstName, surname, teamName, teamLogo } */
  const driverInfoMap = useMemo(() => {
    const map = {};
    (drivers || []).forEach((d) => {
      const full = d.FullName || d.Abbreviation;
      const parts = full.trim().split(/\s+/);
      const surname = parts.length > 1 ? parts.slice(-1)[0] : full;
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
      map[d.Abbreviation] = {
        fullName: full,
        firstName,
        surname,
        teamName: d.TeamName || '',
        teamLogo: TEAM_LOGO_MAP[d.TeamName] || null,
      };
    });
    return map;
  }, [drivers]);

  // Replay is in progress when frames have advanced — otherwise show full race review
  const replayActive = currentFrameIndex > 0 || currentLap > 1;

  // Compute time offset: session times (e.g. Sector1SessionTime ~3500s) vs frame times (0-based)
  const sessionTimeOffset = useMemo(() => {
    if (lapTimes.length === 0) return 0;
    for (const d of lapTimes) {
      if (d.LapStartTime > 0 && (d.Time > 0 || d.LapTimeSeconds > 0) && d.LapNumber >= 1) {
        return d.LapStartTime;
      }
    }
    return 0;
  }, [lapTimes]);
  const hasTimeOffset = sessionTimeOffset > 0;

  /* ── Compute session-wide bests for color coding (incremental) ── */
  const sessionBests = useMemo(() => {
    let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity, bestLap = Infinity;
    let fastestLapDriver = null;
    const personalBests = {}; // { driver: { s1, s2, s3, lap } }

    // When replay is active, filter progressively; otherwise show all data (review mode)
    const effectiveLap = replayActive ? currentLap : Infinity;
    lapTimes.filter((d) => d.LapNumber <= effectiveLap).forEach((d) => {
      // During replay: skip laps the driver hasn't started yet
      if (replayActive && hasTimeOffset && d.LapStartTime > 0 && currentTime < d.LapStartTime - sessionTimeOffset) return;
      const drv = d.Driver;
      if (!personalBests[drv]) personalBests[drv] = { s1: Infinity, s2: Infinity, s3: Infinity, lap: Infinity };

      // Only include sector times that have actually been completed (during replay)
      const s1ok = !replayActive || !d.Sector1SessionTime || currentTime >= d.Sector1SessionTime - sessionTimeOffset;
      const s2ok = !replayActive || !d.Sector2SessionTime || currentTime >= d.Sector2SessionTime - sessionTimeOffset;
      const s3ok = !replayActive || !d.Sector3SessionTime || currentTime >= d.Sector3SessionTime - sessionTimeOffset;

      const s1 = s1ok ? d.Sector1TimeSeconds : 0;
      const s2 = s2ok ? d.Sector2TimeSeconds : 0;
      const s3 = s3ok ? d.Sector3TimeSeconds : 0;
      const lap = s3ok ? d.LapTimeSeconds : 0;

      if (s1 > 0 && s1 < 120) {
        if (s1 < bestS1) bestS1 = s1;
        if (s1 < personalBests[drv].s1) personalBests[drv].s1 = s1;
      }
      if (s2 > 0 && s2 < 120) {
        if (s2 < bestS2) bestS2 = s2;
        if (s2 < personalBests[drv].s2) personalBests[drv].s2 = s2;
      }
      if (s3 > 0 && s3 < 120) {
        if (s3 < bestS3) bestS3 = s3;
        if (s3 < personalBests[drv].s3) personalBests[drv].s3 = s3;
      }
      if (lap > 0 && lap < 300) {
        if (lap < bestLap) { bestLap = lap; fastestLapDriver = drv; }
        if (lap < personalBests[drv].lap) personalBests[drv].lap = lap;
      }
    });

    return { bestS1, bestS2, bestS3, bestLap, fastestLapDriver, personalBests };
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, replayActive, hasTimeOffset]);

  /* ── Get time color (purple / green / yellow / white) ───────── */
  const getTimeColor = useCallback((value, sessionBest, personalBest, isPit) => {
    if (isPit) return TIME_COLORS.pit;
    if (!value || value <= 0 || value > 300) return TIME_COLORS.normal;
    const tolerance = 0.001;
    if (Math.abs(value - sessionBest) < tolerance) return TIME_COLORS.overall_best;
    if (Math.abs(value - personalBest) < tolerance) return TIME_COLORS.personal_best;
    return TIME_COLORS.normal;
  }, []);

  /* ── Build timing rows for current lap ──────────────────────── */
  const timingRows = useMemo(() => {
    if (lapTimes.length === 0) return [];

    const effectiveLap = replayActive ? currentLap : Infinity;
    const drivers = new Map();
    lapTimes
      .filter((d) => d.LapNumber <= effectiveLap)
      .forEach((d) => {
        // During replay: skip laps the driver hasn't started yet
        if (replayActive && hasTimeOffset && d.LapStartTime > 0 && currentTime < d.LapStartTime - sessionTimeOffset) return;
        const existing = drivers.get(d.Driver);
        if (!existing || d.LapNumber > existing.LapNumber) {
          drivers.set(d.Driver, d);
        }
      });

    return Array.from(drivers.values())
      .map((d) => {
        const pb = sessionBests.personalBests[d.Driver] || {};
        // Pit status: verify pit entry/exit have actually happened in the timeline
        const pitInAdj = d.PitInTime > 0 ? d.PitInTime - sessionTimeOffset : null;
        const pitOutAdj = d.PitOutTime > 0 ? d.PitOutTime - sessionTimeOffset : null;
        const isPit = (pitInAdj != null && currentTime >= pitInAdj) ||
                      (pitOutAdj != null && currentTime >= pitOutAdj);
        const dnf = dnfMap[d.Driver];
        const isRetired = !!(dnf && dnf.lastLap <= currentLap);
        const info = driverInfoMap[d.Driver] || {};

        // Sector-by-sector progressive reveal for the current lap (only during replay)
        // In review mode (replay not active), show everything
        const isCurrentLap = replayActive && d.LapNumber === currentLap;
        // Convert session times to frame-relative times by subtracting offset
        const s1Time = d.Sector1SessionTime > 0 ? d.Sector1SessionTime - sessionTimeOffset : null;
        const s2Time = d.Sector2SessionTime > 0 ? d.Sector2SessionTime - sessionTimeOffset : null;
        const s3Time = d.Sector3SessionTime > 0 ? d.Sector3SessionTime - sessionTimeOffset : null;

        // For current lap: use session time comparison if available, otherwise
        // fall back to showing sector if its data exists (> 0) — prevents blank sectors
        // when Sector*SessionTime is null in the data
        const showS1 = !isCurrentLap || (s1Time != null ? currentTime >= s1Time : d.Sector1TimeSeconds > 0);
        const showS2 = !isCurrentLap || (s2Time != null ? currentTime >= s2Time : d.Sector2TimeSeconds > 0);
        const showS3 = !isCurrentLap || (s3Time != null ? currentTime >= s3Time : d.Sector3TimeSeconds > 0);
        const showLapTime = !isCurrentLap || showS3; // lap time available when S3 completes

        const s1 = showS1 ? d.Sector1TimeSeconds : null;
        const s2 = showS2 ? d.Sector2TimeSeconds : null;
        const s3 = showS3 ? d.Sector3TimeSeconds : null;
        const lapTime = showLapTime ? d.LapTimeSeconds : null;

        // Live chronometer: compute running sector time for the current lap
        let chrono = null; // { sector: 1|2|3, elapsed: seconds }
        if (isCurrentLap && hasTimeOffset) {
          const lapStart = d.LapStartTime > 0 ? d.LapStartTime - sessionTimeOffset : null;
          if (!showS1 && lapStart != null) {
            // In S1 — counting from lap start
            chrono = { sector: 1, elapsed: Math.max(0, currentTime - lapStart) };
          } else if (showS1 && !showS2 && s1Time != null) {
            // S1 done, in S2 — counting from S1 completion
            chrono = { sector: 2, elapsed: Math.max(0, currentTime - s1Time) };
          } else if (showS2 && !showS3 && s2Time != null) {
            // S2 done, in S3 — counting from S2 completion
            chrono = { sector: 3, elapsed: Math.max(0, currentTime - s2Time) };
          }
        }

        return {
          pos: d.Position || 99,
          driver: d.Driver,
          firstName: info.firstName || '',
          surname: info.surname || d.Driver,
          teamLogo: info.teamLogo || null,
          color: getDriverColor(d.Driver),
          lap: d.LapNumber,
          s1,
          s2,
          s3,
          lapTime,
          chrono,
          gap: showLapTime ? (d.GapToLeader || null) : null,
          interval: showLapTime ? (d.IntervalToAhead || null) : null,
          compound: d.Compound || '',
          tyreLife: d.TyreLife || 0,
          isPit,
          isRetired,
          isCurrentLap,
          retiredStatus: dnf?.status || '',
          s1Color: isRetired ? TIME_COLORS.normal : (showS1 ? getTimeColor(d.Sector1TimeSeconds, sessionBests.bestS1, pb.s1, isPit) : TIME_COLORS.normal),
          s2Color: isRetired ? TIME_COLORS.normal : (showS2 ? getTimeColor(d.Sector2TimeSeconds, sessionBests.bestS2, pb.s2, isPit) : TIME_COLORS.normal),
          s3Color: isRetired ? TIME_COLORS.normal : (showS3 ? getTimeColor(d.Sector3TimeSeconds, sessionBests.bestS3, pb.s3, isPit) : TIME_COLORS.normal),
          lapColor: isRetired ? TIME_COLORS.normal : (showLapTime ? getTimeColor(d.LapTimeSeconds, sessionBests.bestLap, pb.lap, isPit) : TIME_COLORS.normal),
          qualiSegment: qualiSegmentMap[d.Driver] || null,
        };
      })
      .sort((a, b) => {
        // Active drivers first (by position), retired drivers at bottom
        if (a.isRetired && !b.isRetired) return 1;
        if (!a.isRetired && b.isRetired) return -1;
        return (a.pos || 99) - (b.pos || 99);
      });
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, sessionBests, getTimeColor, dnfMap, replayActive, hasTimeOffset, driverInfoMap, qualiSegmentMap]);

  /* ── All drivers shown; qualifying filter applied if active ── */
  const displayRows = useMemo(() => {
    if (!isQualifying || qualiFilter === 'ALL') return timingRows;
    return timingRows.filter((r) => r.qualiSegment === qualiFilter);
  }, [timingRows, isQualifying, qualiFilter]);

  /* ── Resizable column widths ────────────────────────────────── */
  const [colWidths, setColWidths] = useState(() => COLUMN_DEFS.map((c) => c.defaultW));
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;

  const gridColumns = colWidths.map((w) => `${w}px`).join(' ');

  const onResizeStart = useCallback((colIdx, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidthsRef.current[colIdx];

    const onMouseMove = (ev) => {
      const delta = ev.clientX - startX;
      const newW = Math.max(COLUMN_DEFS[colIdx].minW, startW + delta);
      setColWidths((prev) => {
        const next = [...prev];
        next[colIdx] = newW;
        return next;
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /* ── Render ─────────────────────────────────────────────────── */
  const headerStyle = {
    display: 'grid',
    gridTemplateColumns: gridColumns,
    gap: '2px',
    padding: '4px 6px',
    background: 'rgba(26, 31, 51, 0.6)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    fontSize: '9px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    userSelect: 'none',
    flexShrink: 0,
  };

  const cellStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '10px',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };

  const controls = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '9px' }}>
      {isQualifying && (
        <>
          {['ALL', 'Q1', 'Q2', 'Q3'].map((seg) => (
            <button
              key={seg}
              onClick={() => setQualiFilter(seg)}
              style={{
                padding: '2px 6px', borderRadius: 4, border: 'none',
                fontSize: '9px', fontWeight: 700, cursor: 'pointer',
                background: qualiFilter === seg ? 'rgba(255,255,255,0.15)' : 'transparent',
                color: qualiFilter === seg ? '#fff' : 'rgba(255,255,255,0.4)',
              }}
            >{seg}</button>
          ))}
          <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.1)' }} />
        </>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.overall_best }} />
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>Best</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.personal_best }} />
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>PB</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.pit }} />
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>Pit</span>
      </span>
    </div>
  );

  return (
    <Panel title="Timing Sheet" controls={controls} focused={focusedView === 'laptimes'} shortcutKey="2">
      {/* Column headers with drag-to-resize handles */}
      <div style={headerStyle}>
        {COLUMN_DEFS.map((col, i) => (
          <div
            key={col.key}
            style={{
              position: 'relative',
              display: 'flex',
              justifyContent: col.align,
              alignItems: 'center',
              ...(col.key === 'gap' ? { fontSize: '8px' } : {}),
              ...(col.key === 'driver' ? { paddingLeft: 2 } : {}),
            }}
          >
            {col.label}
            {col.resizable && (
              <div
                onMouseDown={(e) => onResizeStart(i, e)}
                style={{
                  position: 'absolute',
                  right: -2,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'col-resize',
                  zIndex: 2,
                  background: 'transparent',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Timing rows */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        minHeight: 0,
      }}>
        {displayRows.length === 0 && (
          <div className="loading-placeholder">
            <span>Load a session to see timing data</span>
          </div>
        )}

        {displayRows.map((row) => {
          const isHighlighted = row.driver === highlightedDriver;
          const isFocused = row.driver === focusDriver;
          const isSelected = selectedDrivers.includes(row.driver);
          const isOdd = row.pos % 2 === 1;
          const retiredOpacity = row.isRetired ? 0.4 : 1;

          return (
            <div
              key={row.driver}
              style={{
                display: 'grid',
                gridTemplateColumns: gridColumns,
                gap: '2px',
                padding: '3px 6px',
                cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                opacity: retiredOpacity,
                background: row.isRetired
                  ? 'rgba(255,255,255,0.02)'
                  : isFocused
                    ? 'rgba(255,255,255,0.12)'
                    : isHighlighted
                      ? 'rgba(255,255,255,0.08)'
                      : isSelected
                        ? 'rgba(255,255,255,0.06)'
                        : isOdd
                          ? 'rgba(255,255,255,0.015)'
                          : 'transparent',
                transition: 'background 0.1s ease, opacity 0.3s ease',
                ...(isFocused && !row.isRetired ? {
                  borderLeft: `3px solid ${row.color}`,
                  boxShadow: `inset 4px 0 10px -2px ${row.color}44`,
                } : {}),
              }}
              onClick={() => toggleDriver(row.driver)}
              onDoubleClick={() => setFocusDriver(row.driver)}
              onMouseEnter={(e) => setHighlightedDriver(row.driver, { x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHighlightedDriver(null)}
            >
              {/* Position */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: row.isRetired ? '8px' : '11px',
                color: row.isRetired ? '#e10600' : '#fff',
                letterSpacing: row.isRetired ? '0.02em' : undefined,
              }}>
                {row.isRetired ? 'RET' : row.pos}
              </span>

              {/* Team color bar */}
              <span style={{
                width: 3,
                alignSelf: 'stretch',
                borderRadius: 1.5,
                background: row.color,
              }} />

              {/* Team logo */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
              }}>
                {row.teamLogo && (
                  <img
                    src={row.teamLogo}
                    alt=""
                    style={{
                      width: 20,
                      height: 20,
                      objectFit: 'contain',
                      filter: 'brightness(1.1)',
                    }}
                  />
                )}
              </span>

              {/* Driver name: flag (race end) + firstName (light) + SURNAME (bold) */}
              <span style={{
                ...cellStyle,
                justifyContent: 'flex-start',
                fontSize: '10px',
                color: '#fff',
                fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                gap: 3,
              }}>
                {raceFinished && countryCodeMap[row.driver] && (
                  <span style={{ fontSize: '11px', lineHeight: 1 }}>
                    {countryFlag(countryCodeMap[row.driver])}
                  </span>
                )}
                {row.firstName && (
                  <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.55)', fontSize: '9px' }}>
                    {row.firstName}
                  </span>
                )}
                <span style={{ fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
                  {row.surname}
                </span>
                {sessionBests.fastestLapDriver === row.driver && (
                  <span style={{
                    fontSize: '7px', marginLeft: 3, padding: '1px 3px',
                    borderRadius: 3, background: 'rgba(168,85,247,0.25)',
                    color: '#a855f7', fontWeight: 800, letterSpacing: '0.04em',
                  }}>FL</span>
                )}
                {isQualifying && row.qualiSegment && (
                  <span style={{
                    fontSize: '7px', marginLeft: 3, padding: '1px 3px',
                    borderRadius: 3, fontWeight: 700, letterSpacing: '0.04em',
                    background: row.qualiSegment === 'Q3' ? 'rgba(168,85,247,0.2)' : row.qualiSegment === 'Q2' ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)',
                    color: row.qualiSegment === 'Q3' ? '#a855f7' : row.qualiSegment === 'Q2' ? '#22c55e' : 'rgba(255,255,255,0.4)',
                  }}>{row.qualiSegment}</span>
                )}
              </span>

              {/* Sector 1 */}
              <span style={{ ...cellStyle, color: row.s1Color, fontWeight: row.s1Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s1 ? fmtSector(row.s1) : row.chrono?.sector === 1 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Sector 2 */}
              <span style={{ ...cellStyle, color: row.s2Color, fontWeight: row.s2Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s2 ? fmtSector(row.s2) : row.chrono?.sector === 2 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Sector 3 */}
              <span style={{ ...cellStyle, color: row.s3Color, fontWeight: row.s3Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s3 ? fmtSector(row.s3) : row.chrono?.sector === 3 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Lap Time */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? 'rgba(255,255,255,0.35)' : row.isPit ? TIME_COLORS.pit : row.lapColor,
                fontWeight: 700,
                fontSize: row.isRetired ? '9px' : '11px',
              }}>
                {row.isRetired ? row.retiredStatus : row.isPit ? 'PIT' : fmtTime(row.lapTime)}
              </span>

              {/* Gap to fastest */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? '#e10600' : row.pos === 1 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.55)',
                fontSize: '9px',
                fontWeight: row.isRetired ? 800 : undefined,
              }}>
                {row.isRetired ? 'DNF' : row.pos === 1 ? 'LEADER' : fmtGap(row.gap)}
              </span>

              {/* Tyre compound */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                gap: 3,
              }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: TYRE_COLORS[row.compound] || '#888',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: '8px',
                  fontWeight: 600,
                  color: TYRE_COLORS[row.compound] || '#888',
                }}>
                  {row.compound ? row.compound[0] : '?'}
                </span>
              </span>

              {/* Tyre life */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.35)',
                fontSize: '9px',
              }}>
                {row.tyreLife}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
