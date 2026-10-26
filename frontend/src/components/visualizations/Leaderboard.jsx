import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, countryFlag, F1_POINTS, TRACK_STATUS_STYLES, FLAG_COLORS, MEDAL_COLORS, STATUS_COLORS,
  STATUS_GLYPHS, DIVERGING, TEXT_COLORS, TYRE_COLORS, TYRE_LABELS, CHART_FONT, tyreColor, tyreLetter,
  contrastText, markColor, textColor, tintedChip, withAlpha,
} from '../../utils/colors';
import Legend from '../ui/Legend';
import { useSessionNow } from '../../hooks/useSessionNow';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { isLapCompleted, leaderLapEndTime, activeSegmentWindow } from '../../utils/raceTime';
import { pitStops } from '../../utils/stints';
import { pitCountsByDriver, viewSessionType, isRaceSession } from '../../utils/strategyViews';
import { raceStandings, qualifyingStandings } from '../../utils/views/leaderboard';
import { battleLevel, BATTLE_BADGE_PCT, BADGE_INTERVAL_PCT } from '../../utils/simulationClient';
import { focusForecast, forecastPit, forecastMethodLabel, FORECAST_LAPS } from '../../utils/forecast';
import Panel from '../ui/Panel';
import { useBoxSize, fitRows, pageOf } from '../../utils/views/chartBox';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { towerRowStyle, towerBodyStyle } from '../../utils/views/leaderboard';

/* ── Flag constants: FIA colours of utils/colors.js, always with their label ── */
const FLAG_BORDER_COLORS = Object.fromEntries(
  Object.entries(TRACK_STATUS_STYLES).map(([k, s]) => [k, k === '1' ? 'transparent' : s.color]),
);

const FLAG_BANNER = Object.fromEntries(
  Object.entries(TRACK_STATUS_STYLES).filter(([k]) => k !== '1').map(([k, s]) => {
    const chip = tintedChip(s.color, 0.15);
    return [k, { label: s.short, bg: chip.background, color: chip.color, border: s.color }];
  }),
);

/* ── Battle badge: overtake probability level, an ordered scale (grey <
   yellow < orange), the percentage is the text ───────────────────────── */
const BATTLE_LEVEL_COLORS = [TEXT_COLORS.secondary, STATUS_COLORS.slower, DIVERGING.worse];
const BATTLE_LEVEL_NAMES = ['grey', 'yellow', 'orange'];

/* ── Position-change flash: the row's CSS animations (visualizations.css
   .tower-row--gained / --lost); its end drops the flash ─────────────── */
const FLASH_ANIMATIONS = new Set(['position-gained-flash', 'position-lost-flash']);

/* ── Legend of the tower (V4): every mark it draws ─────────────────── */
const TOWER_LEGEND = [
  { label: 'vs grid', color: DIVERGING.better, glyph: '▲', shape: 'glyph', title: 'Places gained since the start' },
  { label: 'lost', color: DIVERGING.worse, glyph: '▼', shape: 'glyph', title: 'Places lost since the start' },
  ...['SOFT', 'MEDIUM', 'HARD'].map((c) => ({ label: '', color: TYRE_COLORS[c], glyph: TYRE_LABELS[c], shape: 'badge', title: `${c} tyre` })),
  { label: 'pit', color: STATUS_COLORS.pit, glyph: STATUS_GLYPHS.pit, shape: 'glyph', title: 'In the pit lane' },
  // the overtake badge's three levels, each with its threshold (the
  // levels were explained only in the badge's tooltip)
  ...BATTLE_LEVEL_COLORS.map((color, i) => ({
    label: i === 0 ? `<${BATTLE_BADGE_PCT[0]}%` : `≥${BATTLE_BADGE_PCT[i - 1]}%`,
    color, glyph: '⇅', shape: 'glyph',
    title: `Monte Carlo overtake probability of a battle, ${BATTLE_LEVEL_NAMES[i]} level`,
  })),
  { label: 'battle', color: TEXT_COLORS.secondary, glyph: '⚔', shape: 'glyph', title: 'Within 1 s of a rival, no overtake projection yet (row highlighted)' },
];

/* ── Layout constants ───────────────────────────────────────────────── */
// The rows fit the room the sidebar leaves them (chartBox.fitRows): 28 px
// while the field fits, down to 18 px (the Timing Tower's minimum, same data
// type); when even 18 px rows do not fit (the focus cards opened in full on a
// short window) they are paged, with a pager line, never clipped
//
// Phase 9c (D1): the browser pass found P16-P20 below a 440 px body, the rows
// still standing at the 28 px spacing of the first render (19 x 28 + 22 =
// 554 px): their translateY was in px, so a new row height was animated by
// the row's 500 ms transform transition and depended on a ResizeObserver
// callback. The body now takes its height from the flex layout (at most 28 px
// a row) and each row is a share of it, translateY(k x 100 %) of its own
// height: the rows tile the body at every size with no JS measure and no
// transition on a resize; the measure only decides when to page.
const ROW_MIN = 18;
const ROW_MAX = 28;
const PAGER_H = 22;
// Below this window height the legend (three lines in the 240-300 px
// sidebar) opens from a "?" key in the header, so the 20 rows keep the room
// (frontend/scripts/audit/layout_fit.mjs, Leaderboard sidebar)
const LEGEND_POPOVER_VIEWPORT = '(max-height: 899px)';

/* ── Column display modes ───────────────────────────────────────────── */
const COLUMN_MODES = ['INT', 'GAP', 'TYRE', 'PIT'];

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
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const triggerPrediction = useF1Store((s) => s.triggerPrediction);
  const driversInfo = useF1Store((s) => s.drivers);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  // The focus driver's forecast only (utils/forecast.js)
  const forecast = focusForecast(lstmPredictions, focusDriver);
  const pit = forecastPit(forecast);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  // Causal "now" in session seconds (replay time + sessionTimeOffset; Infinity
  // in live mode), see utils/raceTime.js
  const sessionNow = useSessionNow();
  const columnMode = useF1Store((s) => s.leaderboardColumnMode);
  const cycleLeaderboardColumn = useF1Store((s) => s.cycleLeaderboardColumn);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const segmentWindow = useF1Store(activeSegmentWindow);
  const frameData = useF1Store((s) => s.frameData);
  const raceProjection = useF1Store((s) => s.raceProjection);

  /* ── Local state ──────────────────────────────────────────────────── */
  const [greenFlash, setGreenFlash] = useState(false);

  /* ── Refs ────────────────────────────────────────────────────────── */
  const containerRef = useRef(null);
  const towerWrapRef = useRef(null);
  const previousPositionsRef = useRef({});
  const previousLapRef = useRef(null);
  const clearChangesTimerRef = useRef(null);
  const towerBox = useBoxSize(towerWrapRef);
  const [rowPage, setRowPage] = useState(0);

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

  /* ── Fastest lap driver (among laps completed at sessionNow) ─────── */
  const fastestLapDriver = useMemo(() => {
    if (!sessionData?.lap_times) return null;
    let best = Infinity, driver = null;
    for (const d of sessionData.lap_times) {
      if (!isLapCompleted(d, sessionNow)) continue;
      if (d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300 && d.LapTimeSeconds < best) {
        best = d.LapTimeSeconds;
        driver = d.Driver;
      }
    }
    return driver;
  }, [sessionData, sessionNow]);

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

    // ── Qualifying mode: best laps completed by now (qualifyingStandings, utils/views),
    // frame data for the tyre and speed on track
    if (isQualifyingReplay) {
      const frame = frameData?.frames?.[currentFrameIndex];
      // Only the drivers in the current segment's frame data
      const segDrivers = frameData?.driver_colors ? Object.keys(frameData.driver_colors) : [];
      // PIT column: tyre changes (runs) visible at sessionNow, the count the
      // Strategy Timeline STOPS badge and DriverComparePanel show (R2)
      const stops = pitCountsByDriver(pitStops(sessionData.lap_times || [], { sessionNow }));
      // Only the active segment's laps are ranked (its window's start)
      return qualifyingStandings(sessionData.lap_times || [], sessionNow, {
        drivers: segDrivers, frameDrivers: frame?.drivers || {}, stops,
        segmentStart: segmentWindow?.start,
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
    // Filter out lap entries whose Driver field is a raw racing number
    // (TimingData arrived before DriverList — see backend guard).
    const validAbbrs = new Set(
      (driversInfo || [])
        .map((d) => d.Abbreviation || d.abbr)
        .filter(Boolean)
    );
    const lapTimes = validAbbrs.size > 0
      ? sessionData.lap_times.filter((lt) => validAbbrs.has(lt.Driver))
      : sessionData.lap_times;

    // Causal standings at sessionNow (raceStandings, utils/views); grid slots order
    // drivers who have not completed a lap yet
    const gridPositions = {};
    for (const r of sessionData.race_results || []) {
      const abbr = r.Abbreviation || r.Driver;
      if (abbr && r.GridPosition > 0) gridPositions[abbr] = r.GridPosition;
    }
    // Live: retirements from the feed only (driverState.js nonFinisherMap)
    return raceStandings(lapTimes, sessionNow, { dnfMap, gridPositions, isLiveMode });
  }, [sessionData, sessionNow, dnfMap, replayStarted, isQualifyingReplay, frameData, currentFrameIndex, driversInfo,
    isLiveMode, segmentWindow]);

  /* ── Battle detection (consecutive drivers within 1.0s) ───────────── */
  const battles = useMemo(() => {
    const map = {}; // driver → { rival, gap, side: 'ahead'|'behind' }
    const active = standings.filter((d) => !d.isRetired && !d.isGrid);
    for (let i = 0; i < active.length - 1; i++) {
      const ahead = active[i];
      const behind = active[i + 1];
      const gap = behind.interval;
      if (gap != null && typeof gap === 'number' && Math.abs(gap) <= 1.0 && Math.abs(gap) > 0) {
        map[ahead.abbr] = { rival: behind.abbr, gap: Math.abs(gap), side: 'behind' };
        map[behind.abbr] = { rival: ahead.abbr, gap: Math.abs(gap), side: 'ahead' };
      }
    }
    return map;
  }, [standings]);

  /* ── Monte Carlo overtake probabilities (AWS F1 Insights style) ───── */
  const overtakeProbMap = useMemo(() => {
    const map = {}; // aheadAbbr → { prob, level, rival, behindCompound }
    if (!raceProjection?.battles?.length) return map;
    for (const b of raceProjection.battles) {
      // Only battles where the pair is currently adjacent on track
      if (Math.abs(b.aheadCurrentPos - b.behindCurrentPos) !== 1) continue;
      // Keep highest-probability battle per "ahead" driver
      if (!map[b.ahead] || b.prob > map[b.ahead].prob) {
        // level: the store's badge rule (Wilson interval + hysteresis), the
        // same colour state as the Race Prediction battles
        map[b.ahead] = {
          prob: b.prob, level: battleLevel(raceProjection, b), rival: b.behind, behindCompound: b.behindCompound,
        };
      }
    }
    return map;
  }, [raceProjection]);

  /* ── Position change computation ──────────────────────────────────── */
  const [displayedChanges, setDisplayedChanges] = useState({});
  // Rows flashing for a change ({ abbr: 'gained' | 'lost' }): set with the
  // change, dropped when the row's flash animation ends (endFlash) or when
  // the change is no longer displayed
  const [flashing, setFlashing] = useState({});

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
        setFlashing(positionChanges);
        clearChangesTimerRef.current = setTimeout(() => {
          setDisplayedChanges({});
          setFlashing({});
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

  /* ── Rows fitted to the room left, paged when 18 px rows do not fit ── */
  // The measure (towerBox) decides only whether to page; the rows' height is
  // a share of the body (towerRowStyle), so they fit without it
  const rowFit = fitRows(towerBox.height, standings.length, { rowMin: ROW_MIN, rowMax: ROW_MAX, rowDefault: ROW_MAX, pagerH: PAGER_H });
  const rowPg = pageOf(standings, rowFit.paged ? rowPage : 0, rowFit.perPage);
  const pageRows = rowPg.rows;
  const pageFirst = rowPg.first - 1; // index of the page's first row
  const bodyStyle = towerBodyStyle({
    rows: standings.length, perPage: rowFit.perPage, paged: rowFit.paged, rowMin: ROW_MIN, rowMax: ROW_MAX,
  });

  /* ── Legend: in the panel on a tall window, behind a "?" key below 900 px ── */
  const legendAsPopover = useMediaQuery(LEGEND_POPOVER_VIEWPORT);
  const [legendOpen, setLegendOpen] = useState(false);
  useEffect(() => { if (!legendAsPopover) setLegendOpen(false); }, [legendAsPopover]);
  // Escape closes the legend when it is the topmost transient element
  // (utils/escapeStack.js)
  useEscapeLayer(legendOpen, () => setLegendOpen(false));

  /* ── Position-change highlight flash (CSS transition handles the slide) */
  // One flash per change: the flash classes are in the row's className while
  // the driver is in `flashing` (set with the change), and the row's own
  // flash animation ending drops him. An effect that put the classes on the
  // element with every new standings array (every replay frame) added them
  // again after the 1.2 s animation had ended, restarting the flash until
  // the change was cleared at 1.5 s.
  const endFlash = useCallback((abbr, e) => {
    if (e.target !== e.currentTarget || !FLASH_ANIMATIONS.has(e.animationName)) return;
    setFlashing((f) => {
      if (!f[abbr]) return f;
      const next = { ...f };
      delete next[abbr];
      return next;
    });
  }, []);

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
          {d.retiredLap && <span style={{ fontSize: CHART_FONT.label, marginLeft: 3 }}>L{d.retiredLap}</span>}
        </span>
      );
    }

    if (d.isPitting) {
      return (
        <span className="tower-col-value tower-col-value--pit">{STATUS_GLYPHS.pit} IN PIT</span>
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
          <span style={{ color: textColor(tyreColor(d.compound)) }}>
            {TYRE_DISPLAY_NAMES[d.compound] || '?'}
          </span>
          <span className="tower-tyre-age">L{d.tyreLife}</span>
        </span>
      );
    }

    if (mode === 'PIT') {
      const gridPos = gridPositionMap[d.abbr];
      const gridDelta = (!d.isGrid && gridPos != null) ? gridPos - d.pos : null;
      return (
        <span className="tower-col-value tower-col-value--pit-info">
          <span className="tower-pit-count" title="Pit stops">
            {d.pitStops || 0}<span className="tower-pit-label">P</span>
          </span>
          {gridDelta != null && gridDelta !== 0 && (
            <span className={`tower-grid-delta ${gridDelta > 0 ? 'tower-grid-delta--up' : 'tower-grid-delta--down'}`} title={`${gridDelta > 0 ? '+' : ''}${gridDelta} from grid`}>
              {gridDelta > 0 ? '\u25B2' : '\u25BC'}{Math.abs(gridDelta)}
            </span>
          )}
          {gridDelta === 0 && (
            <span className="tower-grid-delta tower-grid-delta--same">=</span>
          )}
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
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  // Only a race or a sprint ends with a winner (qualifying / practice: never)
  const isRace = isRaceSession(useF1Store(viewSessionType));
  const raceTarget = totalRaceLaps || maxLap;
  // Replay: finished once the leader has taken the chequered flag (end of the
  // last lap), not when he starts it
  const chequered = useMemo(() => leaderLapEndTime(sessionData?.lap_times, maxLap), [sessionData, maxLap]);
  const replayFinished = sessionNow === Infinity || (chequered != null && sessionNow >= chequered);
  const raceFinished = isRace && (isLiveMode
    ? (currentLap >= raceTarget && raceTarget > 1 && currentLap > 2)
    : (replayFinished && maxLap > 1));
  const winner = standings.length > 0 && !standings[0].isRetired ? standings[0] : null;
  // Points badges: the official classification (race_results) once the race
  // is over at the dashboard's clock (sessionNow Infinity, the final order of
  // RacePaceGrid too); after the winner's flag the other cars are still
  // finishing, so their points are not known yet.
  const showPoints = raceFinished && sessionNow === Infinity;

  /* ── Flag border styling ──────────────────────────────────────────── */
  const flagBorderColor = greenFlash
    ? FLAG_COLORS.green
    : (FLAG_BORDER_COLORS[currentFlagStatus] || 'transparent');
  const flagBanner = FLAG_BANNER[currentFlagStatus];
  const isHazard = flagBorderColor !== 'transparent';

  const winnerColor = raceFinished && winner ? winner.color : null;

  const bezelActive = isHazard || (raceFinished && winnerColor);
  const activeColor = raceFinished && winnerColor ? winnerColor : flagBorderColor;

  const panelBorderStyle = {
    '--bezel-color': bezelActive ? activeColor : 'transparent',
    '--bezel-color-dim': bezelActive ? withAlpha(activeColor, 0.27) : 'transparent',
    '--bezel-color-glow': bezelActive ? withAlpha(activeColor, 0.2) : 'transparent',
    border: 'none',
    boxShadow: bezelActive
      ? `0 0 20px ${withAlpha(activeColor, 0.2)}, 0 0 40px ${withAlpha(activeColor, 0.09)}, 0 8px 32px rgba(0,0,0,0.40)`
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
        {legendAsPopover && (
          <button
            type="button"
            className={`leaderboard-toggle tower-legend-toggle${legendOpen ? ' tower-legend-toggle--open' : ''}`}
            onClick={() => setLegendOpen((v) => !v)}
            aria-expanded={legendOpen}
            aria-controls="tower-legend-popover"
            title={legendOpen ? 'Close the key of the marks' : 'Key of the marks (arrows, tyres, pit, battles)'}
          >?</button>
        )}
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
          <div className="tower-broadcast-header__lap" title={`Lap ${currentLap} of ${totalRaceLaps || maxLap}`}>
            <span className="tower-broadcast-header__lap-label tower-broadcast-header__lap-label--lap">LAP</span>
            <span className="tower-broadcast-header__lap-current">{currentLap}</span>
            <span className="tower-broadcast-header__lap-total">/{totalRaceLaps || maxLap}</span>
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
              style={{ borderLeftColor: markColor(d.color) }}
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

      {/* Winner banner: static, the name lifted to 4.5:1 on the tinted ends
          of the gradient (tintedChip). It pulsed down to opacity 0.9
          (winner-banner-glow), the name lifted on the chart surface only:
          3.73:1 at the tinted end (Aston Martin), 4.28:1 there without the pulse */}
      {raceFinished && winner && (() => {
        const winnerInfo = driverInfoMap[winner.abbr] || {};
        const chip = tintedChip(winner.color, 0.15);
        return (
          <div className="tower-flag-banner" style={{
            background: `linear-gradient(90deg, ${chip.background}, transparent, ${chip.background})`,
            borderBottom: `1px solid ${withAlpha(winner.color, 0.33)}`,
          }}>
            <span className="tower-flag-banner__label" style={{ color: TEXT_COLORS.primary, letterSpacing: '0.2em' }}>
              CHEQUERED FLAG
            </span>
            <span style={{
              fontWeight: 900,
              fontSize: '12px',
              color: chip.color,
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
          borderBottom: `1px solid ${flagBanner.border}`,
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

      {/* Legend of the marks the tower draws (arrows, tyre letters, pit,
          battle): in the panel on a tall window, else a card laid over the
          rows from the "?" key (closed with ×, the key or Escape) */}
      {!legendAsPopover && (
        <div className="tower-legend">
          <Legend items={TOWER_LEGEND} shape="glyph" />
        </div>
      )}

      {/* Driver rows */}
      <div ref={towerWrapRef} className="tower-rows" style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {legendAsPopover && legendOpen && (
        <div id="tower-legend-popover" className="tower-legend tower-legend--popover" role="dialog" aria-label="Key of the tower marks">
          <div className="tower-legend__head">
            <span>Key</span>
            <button type="button" className="tower-legend__close" onClick={() => setLegendOpen(false)} aria-label="Close the key">×</button>
          </div>
          <Legend items={TOWER_LEGEND} shape="glyph" />
        </div>
      )}
      <div
        className="tower-body"
        ref={containerRef}
        style={bodyStyle}
      >
        {pageRows.map((d) => {
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
          const inBattle = !!battles[d.abbr];
          const rowClasses = [
            'tower-row',
            isSelected && 'tower-row--selected',
            isHighlighted && 'tower-row--highlighted',
            isFocused && 'tower-row--focused',
            isP1 && !d.isRetired && 'tower-row--leader',
            isWinner && 'tower-row--winner',
            isOdd && 'tower-row--odd',
            d.isRetired && 'tower-row--retired',
            d.isPitting && 'tower-row--pitting',
            inBattle && 'tower-row--battle',
            flashing[d.abbr] && 'tower-row--animating',
            flashing[d.abbr] && `tower-row--${flashing[d.abbr]}`,
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <div
              key={d.abbr}
              className={rowClasses}
              onAnimationEnd={(e) => endFlash(d.abbr, e)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                // a share of the body, moved by multiples of its own height
                ...towerRowStyle(d.pos - 1 - pageFirst, rowFit.perPage),
                ...(isFocused ? {
                  borderLeft: `4px solid ${markColor(d.color)}`,
                  boxShadow: `inset 6px 0 12px -2px ${withAlpha(d.color, 0.33)}, 0 0 8px ${withAlpha(d.color, 0.13)}`,
                } : isSelected ? {
                  borderLeft: `3px solid ${markColor(d.color)}`,
                  boxShadow: `inset 4px 0 8px -2px ${withAlpha(d.color, 0.27)}`,
                } : {}),
              }}
              onClick={() => compareMode ? addCompareDriver(d.abbr) : toggleDriver(d.abbr)}
              onDoubleClick={() => {
                // keep the focus on a second double-click (setFocusDriver toggles it
                // off): the forecast of the focus driver is asked again (backlog L3)
                if (useF1Store.getState().focusDriver !== d.abbr) setFocusDriver(d.abbr);
                triggerPrediction(d.abbr, currentLap);
              }}
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
                    background: MEDAL_COLORS[d.pos],
                    color: contrastText(MEDAL_COLORS[d.pos]),
                    borderRadius: 3,
                    width: 20,
                    // inside the 18 px minimum row (17 px under its rule)
                    height: 16,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: CHART_FONT.data,
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
                  style={{ backgroundColor: markColor(d.color) }}
                />
                {raceFinished && countryCodeMap[d.abbr] && (
                  <span style={{ fontSize: '11px', marginRight: 2, lineHeight: 1 }}>
                    {countryFlag(countryCodeMap[d.abbr])}
                  </span>
                )}
                <span className="tower-row__driver-name" style={d.isRetired ? { textDecoration: 'line-through', textDecorationColor: STATUS_COLORS.retired } : undefined}>{d.abbr}</span>
                {d.isRetired && <span className="tower-row__out-badge">OUT</span>}
                {raceFinished && fastestLapDriver === d.abbr && (
                  <span title="Fastest lap of the race" style={{
                    fontSize: CHART_FONT.label, marginLeft: 4, padding: '0 3px',
                    borderRadius: 3, background: tintedChip(STATUS_COLORS.overallBest, 0.25).background,
                    color: tintedChip(STATUS_COLORS.overallBest, 0.25).color, fontWeight: 800, letterSpacing: '0.04em',
                  }}>{STATUS_GLYPHS.overallBest} FL</span>
                )}
                {!raceFinished && battles[d.abbr] && (() => {
                  const mc = overtakeProbMap[d.abbr];
                  const rival = battles[d.abbr].rival;
                  const gap = battles[d.abbr].gap;
                  if (mc && mc.rival === rival) {
                    // Colour by the battle badge level (store badge rule)
                    const color = BATTLE_LEVEL_COLORS[Math.max(0, Math.min(2, mc.level))];
                    const runs = raceProjection?.numSimulations;
                    return (
                      <span
                        className="tower-row__battle-badge tower-row__battle-badge--mc"
                        style={{ color, borderColor: withAlpha(color, 0.45), background: withAlpha(color, 0.1) }}
                        title={`Overtake probability: ${mc.prob}% — chance ${rival} passes ${d.abbr} before the flag.\nCurrent gap: ${gap.toFixed(2)}s.\nBasis: Monte Carlo race simulation (${runs != null ? runs.toLocaleString('en-US') : '?'} runs) using pace delta, tyre degradation, and pit-loss.\nColour: ${BATTLE_LEVEL_NAMES[0]} below ${BATTLE_BADGE_PCT[0]}% · ${BATTLE_LEVEL_NAMES[1]} at least ${BATTLE_BADGE_PCT[0]}% · ${BATTLE_LEVEL_NAMES[2]} at least ${BATTLE_BADGE_PCT[1]}%; a colour changes only when the ${BADGE_INTERVAL_PCT}% Wilson interval of the share clears the threshold.`}
                      >
                        {'\u21C5'}{mc.prob}%
                      </span>
                    );
                  }
                  return (
                    <span className="tower-row__battle-badge" title={`Battle with ${rival} — current gap ${gap.toFixed(3)}s (no Monte Carlo projection yet; needs at least 5 laps).`}>
                      {'\u2694'}
                    </span>
                  );
                })()}
              </span>

              <span className="tower-row__value">
                {showPoints && !d.isRetired && d.pos <= 10 ? (
                  <span className="tower-row__points-badge" style={{
                    color: MEDAL_COLORS[1],
                    fontWeight: 700,
                    fontSize: CHART_FONT.data,
                    letterSpacing: '0.02em',
                  }}>
                    +{pointsMap[d.abbr] != null ? pointsMap[d.abbr] : (F1_POINTS[d.pos] || 0)}
                  </span>
                ) : (
                  renderColumnValue(d)
                )}
              </span>

              <span className="tower-row__tyre-dot">
                {/* FIA compound colour with its letter (contrastText) */}
                <span
                  className="tower-tyre-circle"
                  style={{
                    backgroundColor: tyreColor(d.compound), color: contrastText(tyreColor(d.compound)),
                    width: 14, height: 14, lineHeight: '14px', textAlign: 'center',
                    fontSize: CHART_FONT.label, fontWeight: 800,
                  }}
                  title={`${d.compound} - ${d.tyreLife} laps`}
                >{tyreLetter(d.compound)}</span>
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
      {/* Pager of the rows that do not fit (fitRows / pageOf) */}
      {rowFit.paged && (
        <div className="tower-pager" style={{ height: PAGER_H }}>
          <button
            type="button"
            className="tower-pager__btn"
            onClick={() => setRowPage(rowPg.page - 1)}
            disabled={rowPg.page === 0}
            aria-label="Previous positions"
          >{'▲'}</button>
          <span className="tower-pager__text">P{rowPg.first}–P{rowPg.last} of {standings.length}</span>
          <button
            type="button"
            className="tower-pager__btn"
            onClick={() => setRowPage(rowPg.page + 1)}
            disabled={rowPg.page >= rowPg.pages - 1}
            aria-label="Next positions"
          >{'▼'}</button>
        </div>
      )}
      </div>

      {/* The focus driver's forecast (double-click a row): pit probability
          and projected pit lap, named by the methods that made them; nothing
          when the response has none (outside a race, too few clean laps) */}
      {forecast && (pit.probability != null || forecast.optimal_pit_lap != null) && (
        <div style={{
          padding: '4px 8px',
          background: 'rgba(255,255,255,0.04)',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          fontSize: CHART_FONT.data,
          color: TEXT_COLORS.secondary,
          lineHeight: 1.4,
        }}>
          {pit.probability != null && (
            <div
              title={`${forecast.driver}: probability of a pit stop within ${FORECAST_LAPS} laps of lap ${forecast.lap}`
                + `${pit.label ? `, by the ${pit.label}` : ''}`}
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}
            >
              <span>{forecast.driver} PIT PROB{pit.label ? ` (${pit.label})` : ''}</span>
              <span style={{ color: pit.probability > 0.5 ? STATUS_COLORS.predicted : TEXT_COLORS.muted, fontWeight: 700 }}>
                {(pit.probability * 100).toFixed(0)}%
              </span>
            </div>
          )}
          {forecast.optimal_pit_lap != null && (
            <div
              title={`Projected from the pit probability over the race distance; lap times by ${forecastMethodLabel(forecast)}`}
              style={{ display: 'flex', justifyContent: 'space-between' }}
            >
              <span>OPT PIT LAP</span>
              <span style={{ color: STATUS_COLORS.predicted, fontWeight: 700 }}>L{forecast.optimal_pit_lap}</span>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
