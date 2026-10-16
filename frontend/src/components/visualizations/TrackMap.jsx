import React, {
  useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo,
} from 'react';
import ReactDOM from 'react-dom';
import * as d3 from 'd3';
import { useF1Store, sessionScopeOf, telemetryKeySuffix } from '../../store/useF1Store';
import { seasonHasDrs, sessionSeasonOf } from '../../utils/seasons';
import {
  getDriverColor, markColor, textColor, withAlpha, tyreColor, tyreLetter, contrastText,
  TRACK_STATUS_STYLES, FLAG_COLORS as FLAG_PALETTE, SECTOR_COLORS, CHANNEL_COLORS, TRACK_COLORS,
  CHANNEL_RAMP_LOW, SPEED_RAMP_START,
  TEXT_COLORS, GRID_COLORS, SURFACES, CHART_FONT, contextColor,
} from '../../utils/colors';
import { estimateFromFramePositions } from '../../utils/trackPositionEstimator';
import { leaderLapEndTime } from '../../utils/raceTime';
import { causalKey, viewSessionType, isRaceSession } from '../../utils/strategyViews';
import { trackMapDriverStatus, trackMapSessionNow } from '../../utils/views/trackMap';
import {
  useChartBox, chartSize, svgScreenScale, layoutReady,
} from '../../utils/views/chartBox';
import {
  trackMapControls, mapDrawPadding, MAP_LAYOUT_MIN_PX, TOOL_PX, TOOL_GAP_PX, TOOL_SEPARATOR_PX,
  mapPlan, fitTrack, rotateOutline, hudSlot, hudTable, hudTableWidth, boxOffsets, COMPASS, HUD_TABLE, CAR_LABEL,
  carLabelOnLeft, hudHiddenColumns, hudColumnsHint,
} from '../../utils/views/trackMapLayout';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

// Flag status → track border colour: the FIA flag colours of utils/colors.js
// (always with their label, FLAG_LABELS); green = the normal grey border
const FLAG_COLORS = {
  '1': 'rgba(255,255,255,0.4)',
  ...Object.fromEntries(Object.entries(TRACK_STATUS_STYLES).filter(([k]) => k !== '1').map(([k, s]) => [k, s.color])),
};

const FLAG_LABELS = {
  '1': null,
  '2': 'YELLOW FLAG',
  '4': 'SAFETY CAR',
  '5': 'RED FLAG',
  '6': 'VIRTUAL SAFETY CAR',
  '7': 'VIRTUAL SAFETY CAR',
};

const FLAG_LABEL_COLORS = Object.fromEntries(
  Object.entries(TRACK_STATUS_STYLES).filter(([k]) => k !== '1').map(([k, s]) => [k, s.color]),
);

// Sectors: the Okabe-Ito sector colours of utils/colors.js (labelled S1-S3)
// Sector paths: drawn (on) at full opacity in SECTOR_COLORS, as the legend
// swatches; a sector the user switches off stays as a faint trace
const SECTOR_OPACITY = { on: 1, off: 0.1 };

const COMPOUND_NAMES = { 0: 'UNK', 1: 'SOFT', 2: 'MED', 3: 'HARD', 4: 'INTER', 5: 'WET' };
const COMPOUND_KEYS = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
const COMPOUND_COLORS = Object.fromEntries(Object.entries(COMPOUND_KEYS).map(([k, c]) => [k, tyreColor(c)]));
// Car dots and labels on the map: driver colour (teammate tint) as a mark / text
const carMark = (abbr) => markColor(getDriverColor(abbr), SURFACES.panel);
const carText = (abbr) => textColor(getDriverColor(abbr), SURFACES.panel);
// A layout effect in the browser, a plain effect in a server render (no layout there)
const useLayoutEffectInBrowser = typeof document !== 'undefined' && typeof document.createElement === 'function'
  ? useLayoutEffect : useEffect;
// Font sizes of text inside the zoomed group: divided by --map-zoom, the
// d3.zoom factor times the svg's scale on screen (setMapZoom), so they read
// at their CHART_FONT size whatever the zoom and the size of the panel (D4)
const ZOOMED_FONT = {
  data: `calc(${CHART_FONT.data} / var(--map-zoom, 1))`,
  label: `calc(${CHART_FONT.label} / var(--map-zoom, 1))`,
};

// Channel overlay ramps: throttle / brake from the track grey (lifted to 3:1,
// CHANNEL_RAMP_LOW) to their Okabe-Ito channel colour (sky blue / orange,
// never green / red); speed on cividis from SPEED_RAMP_START (sequential,
// readable under every colour-vision deficiency, its low end at 3:1)
function channelRamp(kind) {
  if (kind === 'speed') return (t) => d3.interpolateCividis(SPEED_RAMP_START + (1 - SPEED_RAMP_START) * t);
  return (t) => d3.interpolateRgb(CHANNEL_RAMP_LOW, CHANNEL_COLORS[kind])(t);
}
// Legend rows of the overlay: its low (the true low end), middle and high colour
function channelLegend(mode) {
  const ramp = channelRamp(mode);
  const name = { speed: 'Speed', throttle: 'Throttle', brake: 'Brake' }[mode] || mode;
  const ends = mode === 'speed' ? ['slow', 'fast'] : ['0 %', '100 %'];
  return [
    { label: `${name} ${ends[0]}`, color: d3.color(ramp(0)).formatHex(), shape: 'square' },
    { label: '', color: d3.color(ramp(0.6)).formatHex(), shape: 'square' },
    { label: ends[1], color: d3.color(ramp(1)).formatHex(), shape: 'square' },
  ];
}

// Race control overlay for live mode (when car positions are unavailable)
function LiveRaceControlOverlay() {
  const raceControlMessages = useF1Store((s) => s.raceControlMessages);
  const trackStatus = useF1Store((s) => s.trackStatus);
  const currentLap = useF1Store((s) => s.currentLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);

  const messages = useMemo(() => {
    const items = [];
    // Add track status events
    for (const ts of (trackStatus || [])) {
      const info = FLAG_COLORS_MAP[ts.status];
      if (info) {
        items.push({ type: 'status', text: info.label, color: info.color, time: ts.start_time });
      }
    }
    // Add race control messages
    for (const msg of (raceControlMessages || [])) {
      items.push({
        type: msg.category || 'RC',
        text: msg.message || '',
        color: msg.flag === 'YELLOW' ? FLAG_PALETTE.yellow : msg.flag === 'RED' ? FLAG_PALETTE.red : TEXT_COLORS.muted,
        time: msg.timestamp,
        lap: msg.lap,
      });
    }
    return items.slice(-12).reverse(); // Last 12, newest first
  }, [raceControlMessages, trackStatus]);

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, bottom: 40, width: 260,
      zIndex: 10, display: 'flex', flexDirection: 'column',
      background: 'rgba(12,12,28,0.85)', borderRadius: 6,
      border: '1px solid rgba(255,255,255,0.08)',
      backdropFilter: 'blur(12px)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: CHART_FONT.label, fontWeight: 700, color: TEXT_COLORS.primary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Race Control
        </span>
        <span style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.muted, fontFamily: 'var(--font-mono)' }}>
          Lap {currentLap}/{totalRaceLaps || '?'}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', padding: '4px 0' }}>
        {messages.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: CHART_FONT.data, color: TEXT_COLORS.muted, textAlign: 'center' }}>
            No race control messages yet
          </div>
        ) : messages.map((msg, i) => (
          <div key={i} style={{
            padding: '4px 10px', fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary,
            borderLeft: `2px solid ${msg.color}`,
            marginLeft: 4, marginBottom: 2,
          }}>
            {msg.lap && <span style={{ color: TEXT_COLORS.muted, marginRight: 4, fontFamily: 'var(--font-mono)' }}>L{msg.lap}</span>}
            <span style={{ color: textColor(msg.color, SURFACES.page), fontWeight: 600 }}>{msg.text}</span>
          </div>
        ))}
      </div>
      <div style={{
        padding: '4px 10px', borderTop: '1px solid rgba(255,255,255,0.06)',
        fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, textAlign: 'center',
      }}>
        Positions via OpenF1 (when available)
      </div>
    </div>
  );
}

const FLAG_COLORS_MAP = TRACK_STATUS_STYLES;

// Trail configuration for driver glow effect
const TRAIL_CONFIG = [
  { radius: 5, opacity: 0.4 },   // Most recent
  { radius: 4, opacity: 0.25 },
  { radius: 3, opacity: 0.12 },
  { radius: 2, opacity: 0.05 },  // Oldest
];
const TRAIL_LENGTH = TRAIL_CONFIG.length;

// --map-zoom of the svg: the zoom factor k times the svg's on-screen scale
// (chartBox.js svgScreenScale; 1 once the viewBox is the panel's box), the
// divisor of every label size in the map (ZOOMED_FONT, visualizations.css
// .car-label / .corner-label), so a label keeps its size on screen (D4)
function setMapZoom(svgEl, k, screenScale) {
  if (!svgEl) return;
  const f = (Number(k) || 1) * (Number(screenScale) || 1);
  svgEl.style.setProperty('--map-zoom', String(f));
}

export default function TrackMap({ compact = false }) {
  const svgRef = useRef(null);
  const gRef = useRef(null);
  const zoomRef = useRef(null);
  // The box the map fills: the track is laid out again at each new size (D4)
  const box = useChartBox(svgRef);
  // The panel's room under its header (.panel-content, the parent of the
  // map's container): where the controls go (G1, utils/views/trackMapLayout.js)
  const vizRef = useRef(null);
  const area = useChartBox(vizRef);
  const { layers: layersPlace, rotateTools } = trackMapControls(area);
  const layersInline = layersPlace === 'inline';
  const [layersOpen, setLayersOpen] = useState(false);
  const layersBtnRef = useRef(null);
  const closeLayers = useCallback(() => setLayersOpen(false), []);
  useEffect(() => { if (layersInline) setLayersOpen(false); }, [layersInline]);
  // d3.zoom's factor and the svg's scale on screen: --map-zoom = k x scale
  const zoomKRef = useRef(1);
  const screenScaleRef = useRef(1);
  const trailPositionsRef = useRef({}); // { driverAbbr: [{x, y}, ...] } — most recent first
  const isInitialRenderRef = useRef(true);
  const prevFrameIndexRef = useRef(-1); // Track previous frame to detect changes

  const focusedView = useF1Store((s) => s.focusedView);
  const circuitInfo = useF1Store((s) => s.circuitInfo);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const frameDt = useF1Store((s) => s.frameDt);
  const currentFlagStatus = useF1Store((s) => s.currentFlagStatus);
  const isLoadingFrames = useF1Store((s) => s.isLoadingFrames);
  const isPlaying = useF1Store((s) => s.isPlaying);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const drivers = useF1Store((s) => s.drivers);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const telemetryCache = useF1Store((s) => s.telemetryCache);
  // Telemetry cache keys of the session on screen end with this (store telemetryCacheKey)
  const telemetrySuffix = useF1Store((s) => telemetryKeySuffix(sessionScopeOf(s)));
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const fetchDriverTelemetry = useF1Store((s) => s.fetchDriverTelemetry);
  // DRS exists in the season on screen (utils/seasons.js: none from 2026): the
  // DRS zones, their toggle, the tooltip row and the HUD readout follow it
  const seasonDrs = useF1Store((s) => seasonHasDrs(sessionSeasonOf(s)));
  const seasonDrsRef = useRef(seasonDrs);
  seasonDrsRef.current = seasonDrs;
  // Only a race or a sprint ends with a winner under the chequered flag
  const isRace = isRaceSession(useF1Store(viewSessionType));

  // Causal per-driver status (trackMapDriverStatus, utils/views) at the time of the
  // frame on screen: the map draws cars at frame positions, so its clock is the
  // frame's session time (never after the dashboard's now; utils/raceTime.js).
  // It changes only when a lap completes or a pit event happens (causalKey),
  // so the car layer is not redrawn on every replay tick.
  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);
  const maxTime = useF1Store((s) => s.maxTime);
  const lapModeRaceOver = useF1Store((s) => s.lapModeRaceOver);
  const qualiSegmentWindows = useF1Store((s) => s.qualiSegmentWindows);
  const qualiSegment = useF1Store((s) => s.qualiSegment);
  const statusLapTimes = sessionData?.lap_times;
  const frameTime = frameData?.frames?.[currentFrameIndex]?.t;
  const sessionNow = useMemo(() => trackMapSessionNow({
    frameTime, sessionTimeOffset, totalFrames, currentLap, maxLap, lapTimes: statusLapTimes,
    isLiveMode, isQualifyingReplay, maxTime, frameDt, lapModeRaceOver, qualiSegmentWindows, qualiSegment,
  }), [frameTime, sessionTimeOffset, totalFrames, currentLap, maxLap, statusLapTimes, isLiveMode,
    isQualifyingReplay, maxTime, frameDt, lapModeRaceOver, qualiSegmentWindows, qualiSegment]);
  const statusKey = useMemo(() => causalKey(statusLapTimes, sessionNow), [statusLapTimes, sessionNow]);
  const driverStatus = useMemo(
    () => trackMapDriverStatus(statusLapTimes, sessionNow, dnfMap, { isLiveMode }),
    // sessionNow enters through statusKey, which changes whenever the result does
    [statusLapTimes, statusKey, dnfMap, isLiveMode],
  );
  // The leader has taken the chequered flag (end of the last lap) at the map's clock
  const chequered = useMemo(() => leaderLapEndTime(statusLapTimes, maxLap), [statusLapTimes, maxLap]);
  const replayFinished = sessionNow === Infinity || (chequered != null && sessionNow >= chequered);

  // Track overlay toggles — synced with store for keyboard shortcuts
  const showTrackSectors = useF1Store((s) => s.showTrackSectors);
  const showTrackDRS = useF1Store((s) => s.showTrackDRS);

  // Track rotation
  const trackRotationOffset = useF1Store((s) => s.trackRotationOffset);
  const rotateTrackCW = useF1Store((s) => s.rotateTrackCW);
  const rotateTrackCCW = useF1Store((s) => s.rotateTrackCCW);
  const resetTrackRotation = useF1Store((s) => s.resetTrackRotation);
  const setTrackRotationAbsolute = useF1Store((s) => s.setTrackRotationAbsolute);

  // The map's furniture and the track fitted clear of it
  // (utils/views/trackMapLayout.js mapPlan): the key row, the telemetry HUD's
  // slot, the compass rose. It follows the box, the outline as drawn (the
  // circuit and its rotation), the season and where the layers are; never
  // the selection, the focus driver, the channel overlay or the layer
  // toggles, so a click on a car or a Leaderboard row does not move the
  // track. fitSig names the inputs the layers drawn on the track redraw on.
  const keyRow = !compact && !layersInline;
  const fitSig = compact ? '' : `${seasonDrs ? 1 : 0}|${keyRow ? 1 : 0}`;
  const outline = useMemo(() => (circuitInfo?.track_coordinates?.length
    ? rotateOutline(circuitInfo.track_coordinates, (circuitInfo.rotation || 0) + trackRotationOffset)
    : null), [circuitInfo, trackRotationOffset]);
  const planFor = useCallback((width, height) => {
    if (compact || !outline || !layoutReady({ width, height }, MAP_LAYOUT_MIN_PX)) return null;
    const p = mapPlan(outline.points, { width, height }, {
      padding: mapDrawPadding(width, height), drs: seasonDrs, key: keyRow,
    });
    return p && { ...p, width, height };
  }, [compact, outline, seasonDrs, keyRow]);
  // The plan for the box the map fills (before its first measure: the size
  // the map is first laid out at)
  const measured = box.width > 0 && box.height > 0;
  const plan = useMemo(
    () => planFor(measured ? box.width : 800, measured ? box.height : 500),
    [planFor, measured, box.width, box.height],
  );

  // Individual sector toggles (local refinement)
  const [showSector1, setShowSector1] = useState(true);
  const [showSector2, setShowSector2] = useState(true);
  const [showSector3, setShowSector3] = useState(true);
  const [showDRS, setShowDRS] = useState(true);
  const [showCorners, setShowCorners] = useState(true);
  const [channelMode, setChannelMode] = useState(null); // null | 'speed' | 'throttle' | 'brake'

  // Sync store toggles → local state
  useEffect(() => {
    setShowSector1(showTrackSectors);
    setShowSector2(showTrackSectors);
    setShowSector3(showTrackSectors);
  }, [showTrackSectors]);

  useEffect(() => {
    setShowDRS(showTrackDRS);
  }, [showTrackDRS]);

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(300)
      .call(zoomRef.current.scaleBy, 1.5);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(300)
      .call(zoomRef.current.scaleBy, 1 / 1.5);
  }, []);

  const handleZoomReset = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(300)
      .call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);

  // Radii for compact vs normal mode
  const dotRadius = compact ? 4 : 7;
  const glowRadius = compact ? 8 : 14;

  // ── Compute qualifying grid positions from race_results ──────────
  const gridPositions = useMemo(() => {
    if (!sessionData?.race_results || !circuitInfo?.track_coordinates) return null;
    const results = sessionData.race_results;
    const coords = circuitInfo.track_coordinates;
    if (!results.length || !coords.length) return null;

    // Filter drivers that have a grid position
    const sorted = results
      .filter((r) => r.GridPosition != null && r.GridPosition > 0)
      .sort((a, b) => a.GridPosition - b.GridPosition);

    if (sorted.length === 0) return null;

    // Grid spacing: spread drivers along the last part of the track (approaching S/F)
    // Track coords are ordered around the circuit, index 0 = S/F line
    const gridSpacing = Math.max(3, Math.floor(coords.length / 60));
    const positions = {};

    sorted.forEach((result, i) => {
      // Walk backwards from end of coords (just before S/F line)
      const coordIdx = (coords.length - 1 - (i + 1) * gridSpacing + coords.length * 10) % coords.length;
      const pt = coords[coordIdx];
      const abbr = result.Abbreviation;

      // Compute tangent normal for staggered left/right placement
      const prev = coords[(coordIdx - 1 + coords.length) % coords.length];
      const next = coords[(coordIdx + 1) % coords.length];
      const dx = next.X - prev.X;
      const dy = next.Y - prev.Y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      // Stagger: P1 on racing line (right), P2 offset left, etc.
      const offset = (i % 2 === 0 ? 1 : -1) * 5;

      positions[abbr] = {
        x: pt.X + nx * offset,
        y: pt.Y + ny * offset,
        gridPos: result.GridPosition,
      };
    });

    return positions;
  }, [sessionData, circuitInfo]);

  // Initialize SVG
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Defs for patterns
    const defs = svg.append('defs');

    // Checkered flag pattern
    const checker = defs.append('pattern')
      .attr('id', compact ? 'checkerboard-compact' : 'checkerboard')
      .attr('width', 8).attr('height', 8)
      .attr('patternUnits', 'userSpaceOnUse');
    checker.append('rect').attr('width', 4).attr('height', 4).attr('fill', '#fff');
    checker.append('rect').attr('x', 4).attr('y', 4).attr('width', 4).attr('height', 4).attr('fill', '#fff');
    checker.append('rect').attr('x', 4).attr('width', 4).attr('height', 4).attr('fill', '#000');
    checker.append('rect').attr('y', 4).attr('width', 4).attr('height', 4).attr('fill', '#000');

    if (!compact) {
      defs.append('marker')
        .attr('id', 'drs-arrow')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 5).attr('refY', 5)
        .attr('markerWidth', 4).attr('markerHeight', 4)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M 0 0 L 10 5 L 0 10 z')
        .attr('fill', TRACK_COLORS.drs);

      defs.append('marker')
        .attr('id', 'direction-arrow')
        .attr('viewBox', '0 0 12 12')
        .attr('refX', 6).attr('refY', 6)
        .attr('markerWidth', 8).attr('markerHeight', 8)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M 0 2 L 10 6 L 0 10 z')
        .attr('fill', 'rgba(255,255,255,0.7)');
    }

    const g = svg.append('g').attr('class', 'track-group');
    gRef.current = g;

    g.append('g').attr('class', 'flag-border-layer');
    g.append('g').attr('class', 'outline-layer');
    g.append('g').attr('class', 'sector-layer');
    g.append('g').attr('class', 'drs-outer-layer');
    g.append('g').attr('class', 'drs-detection-layer');
    g.append('g').attr('class', 'sf-layer');
    g.append('g').attr('class', 'direction-layer');
    g.append('g').attr('class', 'corners-layer');
    g.append('g').attr('class', 'channel-overlay-layer');
    g.append('g').attr('class', 'trails-layer');
    g.append('g').attr('class', 'cars-layer');
    g.append('g').attr('class', 'flag-label-layer');

    // The map's text keeps its size on screen at any zoom (semantic zoom):
    // --map-zoom divides the font size of every label drawn in the group
    // (visualizations.css .car-label, .corner-label; the inline sizes below),
    // so an 11 px label never renders at 5.5 px when zoomed out (V13), nor
    // at 6.6 px in a panel smaller than the one it was drawn for (D4)
    zoomKRef.current = 1;
    setMapZoom(svg.node(), 1, screenScaleRef.current);
    const zoom = d3.zoom()
      .scaleExtent([0.5, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
        zoomKRef.current = event.transform.k;
        // the svg's scale now (a resize may not have been laid out yet)
        screenScaleRef.current = svgScreenScale(svg.node());
        setMapZoom(svg.node(), event.transform.k, screenScaleRef.current);
      });
    svg.call(zoom);
    zoomRef.current = zoom;

    // Remove any stale tooltip before creating a new one
    d3.select('body').select('.track-tooltip').remove();
    const trackTooltip = d3.select('body').append('div').attr('class', 'tooltip track-tooltip');

    trailPositionsRef.current = {};
    isInitialRenderRef.current = true;
    prevFrameIndexRef.current = -1;

    return () => {
      trackTooltip.remove();
    };
  }, [compact]);

  // Draw track when circuit info loads
  useEffect(() => {
    if (!circuitInfo?.track_coordinates?.length || !gRef.current) return;

    const svg = d3.select(svgRef.current);
    // the box the map fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, compact
      ? { width: 300, height: 200 }
      : { width: 800, height: 500 });
    // G2: never laid out at a degenerate size (a 354 x 34 box gave a negative
    // scale and a track drawn outside the svg): the drawing waits, hidden,
    // for the next measure of the box, which lays it out
    if (!layoutReady({ width, height }, MAP_LAYOUT_MIN_PX)) {
      svg.attr('data-layout', 'waiting');
      gRef.current.attr('display', 'none');
      return;
    }
    svg.attr('data-layout', 'drawn');
    gRef.current.attr('display', null);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    // its scale on screen (1 when the viewBox is the box), into --map-zoom
    screenScaleRef.current = svgScreenScale(svgRef.current);
    setMapZoom(svgRef.current, zoomKRef.current, screenScaleRef.current);

    const g = gRef.current;

    // The outline in the official orientation (FastF1 rotation + the user's), about its centroid
    const {
      points: coords, cx, cy, cosR, sinR,
    } = outline || rotateOutline(circuitInfo.track_coordinates, (circuitInfo.rotation || 0) + trackRotationOffset);

    const xExtent = d3.extent(coords, (d) => d.X);
    const yExtent = d3.extent(coords, (d) => d.Y);
    // The margin follows the box (G1): a fixed 70 px left 50 px of track in a
    // 190 px tall Pit Wall map; never more than a quarter of the smaller side
    const padding = compact
      ? Math.min(30, Math.floor(Math.min(width, height) / 4))
      : mapDrawPadding(width, height);
    // The largest track that no overlay hides: fitted clear of
    // the map's furniture (mapPlan: the key row, the HUD's slot, the compass
    // rose), which the selection does not change; the plain fit, centred, in
    // a compact map
    const placed = plan && plan.width === width && plan.height === height ? plan : planFor(width, height);
    const fit = placed ? placed.fit : fitTrack(coords, { width, height }, { padding });
    const scale = Math.max(1e-6, fit.scale);
    svg.attr('data-track-fit', fit.clear ? 'clear' : 'overlapped');
    // Pixel-to-coordinate conversion — overlays must be positioned in pixel space
    // because track visual width comes from stroke-width (px), not coordinate offsets
    const pxToCoord = 1 / scale;

    const xScale = d3.scaleLinear()
      .domain(xExtent)
      .range([fit.left, fit.left + fit.width]);
    const yScale = d3.scaleLinear()
      .domain(yExtent)
      .range([fit.top + fit.height, fit.top]);

    gRef.current.__scales = { xScale, yScale };
    // the map's width: the car code labels near its right edge go left of the dot
    gRef.current.__mapWidth = width;
    gRef.current.__rotation = { cosR, sinR, cx, cy };
    gRef.current.__coords = coords;

    const line = d3.line()
      .x((d) => xScale(d.X))
      .y((d) => yScale(d.Y))
      .curve(d3.curveCatmullRom.alpha(0.5));

    // Compute tangent normals for edge offset
    const tangents = coords.map((_, i) => {
      const prev = coords[(i - 1 + coords.length) % coords.length];
      const next = coords[(i + 1) % coords.length];
      const dx = next.X - prev.X;
      const dy = next.Y - prev.Y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { nx: -dy / len, ny: dx / len };
    });
    gRef.current.__tangents = tangents;

    const halfW = 12;
    const outerHalfW = halfW + 6;

    const leftEdge = coords.map((c, i) => ({
      X: c.X + tangents[i].nx * halfW,
      Y: c.Y + tangents[i].ny * halfW,
    }));
    const rightEdge = coords.map((c, i) => ({
      X: c.X - tangents[i].nx * halfW,
      Y: c.Y - tangents[i].ny * halfW,
    }));
    const outerRight = coords.map((c, i) => ({
      X: c.X - tangents[i].nx * outerHalfW,
      Y: c.Y - tangents[i].ny * outerHalfW,
    }));
    const outerLeft = coords.map((c, i) => ({
      X: c.X + tangents[i].nx * outerHalfW,
      Y: c.Y + tangents[i].ny * outerHalfW,
    }));

    // Scale-aware overlay offset: track outline is 24px stroke → 12px visual radius.
    // Ensure overlays are always ≥8px outside that visual edge in screen space.
    const overlayOffset = Math.max(halfW + 16, (14 + 8) * pxToCoord);

    // DRS indicator edge — clearly outside the track boundary
    const drsOuter = coords.map((c, i) => ({
      X: c.X - tangents[i].nx * overlayOffset,
      Y: c.Y - tangents[i].ny * overlayOffset,
    }));

    // Direction arrow edge — opposite side, also clearly outside
    const arrowOuter = coords.map((c, i) => ({
      X: c.X + tangents[i].nx * overlayOffset,
      Y: c.Y + tangents[i].ny * overlayOffset,
    }));

    gRef.current.__edges = { leftEdge, rightEdge, outerLeft, outerRight, drsOuter, arrowOuter };

    // ── Flag border layer ──
    const flagLayer = g.select('.flag-border-layer');
    flagLayer.selectAll('*').remove();
    flagLayer.append('path')
      .attr('class', 'flag-border-left')
      .attr('d', line(leftEdge))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.4)')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');
    flagLayer.append('path')
      .attr('class', 'flag-border-right')
      .attr('d', line(rightEdge))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.4)')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');

    // ── Outline ──
    const outlineLayer = g.select('.outline-layer');
    outlineLayer.selectAll('*').remove();
    outlineLayer.append('path')
      .attr('class', 'track-outline')
      .attr('d', line(coords));

    // ── Sectors ──
    // Drawn in SECTOR_COLORS at full opacity, the exact colours of the S1-S3
    // legend and toggles (a CSS rule .sector-N { stroke } used to beat
    // this presentation attribute, so the track was drawn in other colours,
    // 1.44-2.48:1 on the panel); every sector colour >= 3:1 on the panel
    const sectorLayer = g.select('.sector-layer');
    sectorLayer.selectAll('*').remove();

    if (coords[0]?.Sector !== undefined) {
      const sectors = d3.group(coords, (d) => d.Sector);
      sectors.forEach((pts, sector) => {
        sectorLayer.append('path')
          .attr('class', `sector-path sector-${sector}`)
          .attr('d', line(pts))
          .attr('fill', 'none')
          .attr('stroke', SECTOR_COLORS[sector] || TRACK_COLORS.surface)
          .attr('stroke-width', 16)
          .attr('stroke-linecap', 'round')
          .attr('stroke-linejoin', 'round')
          .attr('opacity', SECTOR_OPACITY.on);
      });
    } else {
      sectorLayer.append('path')
        .attr('d', line(coords))
        .attr('fill', 'none')
        .attr('stroke', TRACK_COLORS.surface)
        .attr('stroke-width', 16)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round');
    }

    [leftEdge, rightEdge].forEach((edge) => {
      sectorLayer.append('path')
        .attr('class', 'track-edge')
        .attr('d', line(edge));
    });

    // ── DRS Zones — filled overlay on track surface ──
    const drsOuterLayer = g.select('.drs-outer-layer');
    drsOuterLayer.selectAll('*').remove();
    const drsDetectionLayer = g.select('.drs-detection-layer');
    drsDetectionLayer.selectAll('*').remove();

    const drsZones = circuitInfo.drs_zones || [];
    if (drsZones.length > 0 && !compact) {
      drsZones.forEach((zone) => {
        const startIdx = zone.start_idx;
        const endIdx = Math.min(zone.end_idx, coords.length - 1);
        const detIdx = zone.detection_idx;

        // Build polygon between left and right track edges
        const leftPts = [];
        const rightPts = [];
        for (let i = startIdx; i <= endIdx; i++) {
          leftPts.push(leftEdge[i]);
          rightPts.push(rightEdge[i]);
        }

        if (leftPts.length > 1) {
          // Filled DRS zone on track surface
          const rightReversed = [...rightPts].reverse();
          const polygonPts = [...leftPts, ...rightReversed];
          drsOuterLayer.append('path')
            .attr('class', 'drs-zone-fill')
            .attr('d', line(polygonPts) + 'Z')
            .attr('fill', TRACK_COLORS.drsFill)
            .attr('stroke', 'none');

          // Thin edge lines on both sides
          drsOuterLayer.append('path')
            .attr('d', line(leftPts))
            .attr('fill', 'none')
            .attr('stroke', TRACK_COLORS.drs)
            .attr('stroke-width', 1.5);
          drsOuterLayer.append('path')
            .attr('d', line(rightPts))
            .attr('fill', 'none')
            .attr('stroke', TRACK_COLORS.drs)
            .attr('stroke-width', 1.5);

          // Tick marks at start and end boundaries
          [startIdx, endIdx].forEach(idx => {
            if (idx < coords.length) {
              drsOuterLayer.append('line')
                .attr('x1', xScale(leftEdge[idx].X))
                .attr('y1', yScale(leftEdge[idx].Y))
                .attr('x2', xScale(rightEdge[idx].X))
                .attr('y2', yScale(rightEdge[idx].Y))
                .attr('stroke', TRACK_COLORS.drs)
                .attr('stroke-width', 2);
            }
          });

          // Small "DRS" label on the outer side of the track at midpoint
          const midIdx = Math.floor((startIdx + endIdx) / 2);
          if (midIdx < arrowOuter.length) {
            const labelPt = arrowOuter[midIdx];
            const labelOffset = 10 * pxToCoord;
            drsOuterLayer.append('text')
              .attr('x', xScale(labelPt.X + tangents[midIdx].nx * labelOffset))
              .attr('y', yScale(labelPt.Y + tangents[midIdx].ny * labelOffset))
              .attr('fill', TRACK_COLORS.drs)
              .style('font-size', ZOOMED_FONT.label)
              .attr('font-weight', '700')
              .attr('font-family', "'Space Grotesk', sans-serif")
              .attr('text-anchor', 'middle')
              .attr('dominant-baseline', 'central')
              .text('DRS');
          }
        }

        // Detection line — thin dashed crossing the track
        if (detIdx >= 0 && detIdx < coords.length) {
          drsDetectionLayer.append('line')
            .attr('x1', xScale(leftEdge[detIdx].X))
            .attr('y1', yScale(leftEdge[detIdx].Y))
            .attr('x2', xScale(rightEdge[detIdx].X))
            .attr('y2', yScale(rightEdge[detIdx].Y))
            .attr('stroke', TRACK_COLORS.drsDetection)
            .attr('stroke-width', 1.5)
            .attr('stroke-dasharray', '3,2');
        }
      });
    }

    // ── Start/Finish Line — thin checkered stripe crossing perpendicular to the track ──
    const sfLayer = g.select('.sf-layer');
    sfLayer.selectAll('*').remove();
    if (coords.length > 4 && tangents.length > 0) {
      const c0 = coords[0];
      const t0 = tangents[0];

      // Symmetric extent across the track, asymmetric depth along track direction
      const sfExtent = overlayOffset * 1.1;

      // Asymmetric stripe depth: longer on one side, shorter on the other
      const nextC = coords[Math.min(3, coords.length - 1)];
      const fdx = nextC.X - c0.X;
      const fdy = nextC.Y - c0.Y;
      const fLen = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
      const depthLong = 10 * pxToCoord;
      const depthShort = 4 * pxToCoord;
      const fxLong = (fdx / fLen) * depthLong;
      const fyLong = (fdy / fLen) * depthLong;
      const fxShort = (fdx / fLen) * depthShort;
      const fyShort = (fdy / fLen) * depthShort;

      // 4 corners: centered across track, longer forward side, shorter backward side
      const sfPoly = [
        `${xScale(c0.X + t0.nx * sfExtent - fxShort)},${yScale(c0.Y + t0.ny * sfExtent - fyShort)}`,
        `${xScale(c0.X - t0.nx * sfExtent - fxShort)},${yScale(c0.Y - t0.ny * sfExtent - fyShort)}`,
        `${xScale(c0.X - t0.nx * sfExtent + fxLong)},${yScale(c0.Y - t0.ny * sfExtent + fyLong)}`,
        `${xScale(c0.X + t0.nx * sfExtent + fxLong)},${yScale(c0.Y + t0.ny * sfExtent + fyLong)}`,
      ].join(' ');

      // White base
      sfLayer.append('polygon')
        .attr('points', sfPoly)
        .attr('fill', '#ffffff');

      // Checkered pattern overlay
      sfLayer.append('polygon')
        .attr('points', sfPoly)
        .attr('fill', `url(#${compact ? 'checkerboard-compact' : 'checkerboard'})`)
        .attr('stroke', 'rgba(255,255,255,0.6)')
        .attr('stroke-width', 0.5);

      // S/F label removed — direction arrowhead near S/F serves as the indicator
    }

    // ── Direction arrowhead alongside S/F line ──
    const dirLayer = g.select('.direction-layer');
    dirLayer.selectAll('*').remove();

    if (!compact && coords.length > 20 && tangents.length > 0) {
      // Position at S/F line (coords[0]), on the outer side of the track
      const pt = drsOuter[0];
      // Track direction at start (in screen space)
      const cNext = coords[Math.min(5, coords.length - 1)];
      const adx = xScale(cNext.X) - xScale(coords[0].X);
      const ady = yScale(cNext.Y) - yScale(coords[0].Y);
      const angleDeg = (Math.atan2(ady, adx) * 180) / Math.PI;
      // Offset well beyond the S/F line tip so the arrow isn't covered
      const extraOffset = 16 * pxToCoord;
      const cx = xScale(pt.X - tangents[0].nx * extraOffset);
      const cy = yScale(pt.Y - tangents[0].ny * extraOffset);

      // Filled triangle arrowhead pointing in track direction
      dirLayer.append('path')
        .attr('d', 'M -7 -5 L 7 0 L -7 5 Z')
        .attr('transform', `translate(${cx},${cy}) rotate(${angleDeg})`)
        .attr('fill', 'rgba(255,255,255,0.85)')
        .attr('stroke', 'none');
    }

    // ── Corners ──
    if (circuitInfo.corners?.length && !compact) {
      const cornersLayer = g.select('.corners-layer');
      cornersLayer.selectAll('*').remove();
      const rot = gRef.current.__rotation;
      circuitInfo.corners.forEach((corner) => {
        if (corner.X == null || corner.Y == null) return;
        // Rotate corner position to match track orientation
        const dx = corner.X - rot.cx;
        const dy = corner.Y - rot.cy;
        const rx = rot.cx + dx * rot.cosR - dy * rot.sinR;
        const ry = rot.cy + dx * rot.sinR + dy * rot.cosR;
        const cx = xScale(rx);
        const cy = yScale(ry);
        const cg = cornersLayer.append('g').attr('transform', `translate(${cx}, ${cy})`);
        cg.append('circle').attr('r', 10).attr('class', 'corner-marker');
        cg.append('text')
          .attr('class', 'corner-label')
          .text(corner.Number || corner.CornerNumber || '');
      });
    }

    isInitialRenderRef.current = true;
    trailPositionsRef.current = {}; // Clear stale screen-space trails on redraw
    // box: the track is laid out again in the panel's new box (D4); plan /
    // fitSig: with its furniture (never on a selection change)
  }, [circuitInfo, compact, trackRotationOffset, box.width, box.height, fitSig, outline, plan, planFor]);

  // Update sector visibility
  useEffect(() => {
    if (!gRef.current) return;
    const sectorLayer = gRef.current.select('.sector-layer');
    sectorLayer.select('.sector-1').attr('opacity', showSector1 ? SECTOR_OPACITY.on : SECTOR_OPACITY.off);
    sectorLayer.select('.sector-2').attr('opacity', showSector2 ? SECTOR_OPACITY.on : SECTOR_OPACITY.off);
    sectorLayer.select('.sector-3').attr('opacity', showSector3 ? SECTOR_OPACITY.on : SECTOR_OPACITY.off);
  }, [showSector1, showSector2, showSector3]);

  useEffect(() => {
    if (!gRef.current) return;
    const visible = showDRS && seasonDrs;
    gRef.current.select('.drs-outer-layer').attr('opacity', visible ? 1 : 0);
    gRef.current.select('.drs-detection-layer').attr('opacity', visible ? 1 : 0);
  }, [showDRS, seasonDrs]);

  useEffect(() => {
    if (!gRef.current) return;
    gRef.current.select('.corners-layer').attr('opacity', showCorners ? 1 : 0);
  }, [showCorners]);

  // Auto-fetch telemetry for focus driver when channel mode is activated
  useEffect(() => {
    if (!channelMode || !focusDriver || !fetchDriverTelemetry || !telemetrySuffix) return;
    const prefix = `${focusDriver}-`;
    const hasAny = Object.keys(telemetryCache || {}).some(
      (k) => k.startsWith(prefix) && k.endsWith(telemetrySuffix)
    );
    if (hasAny) return;
    // The focus driver's last completed lap (a lap still running is not drawn)
    const targetLap = driverStatus[focusDriver]?.lapsCompleted || 0;
    if (targetLap < 1) return;
    fetchDriverTelemetry(focusDriver, targetLap);
  }, [channelMode, focusDriver, telemetryCache, telemetrySuffix, driverStatus, fetchDriverTelemetry]);

  // ── Channel-colored track overlay (speed / throttle / brake) ──
  // Pick the most recent cached telemetry lap the focus driver has completed
  const channelTelemetry = useMemo(() => {
    if (!channelMode || !focusDriver || !telemetryCache || !telemetrySuffix) return null;
    const prefix = `${focusDriver}-`;
    const lastDone = driverStatus[focusDriver]?.lapsCompleted ?? 0;
    let best = null;
    let bestLap = -1;
    for (const key of Object.keys(telemetryCache)) {
      if (!key.startsWith(prefix) || !key.endsWith(telemetrySuffix)) continue;
      const m = key.match(/^[A-Z0-9]{3}-(\d+)-/);
      if (!m) continue;
      const lap = parseInt(m[1], 10);
      if (lap > lastDone) continue;
      if (lap > bestLap) {
        bestLap = lap;
        best = telemetryCache[key];
      }
    }
    return best && best.length > 1 ? { samples: best, lap: bestLap } : null;
  }, [channelMode, focusDriver, telemetryCache, telemetrySuffix, driverStatus]);

  // Render channel overlay as thin colored segments; dim sectors to keep colors readable
  const sectorDimmedRef = useRef(false);
  useEffect(() => {
    if (!gRef.current) return;
    const layer = gRef.current.select('.channel-overlay-layer');
    if (layer.empty()) return;
    layer.selectAll('*').remove();
    const sectorLayer = gRef.current.select('.sector-layer');

    if (!channelMode || !channelTelemetry) {
      if (sectorDimmedRef.current && !sectorLayer.empty()) {
        sectorLayer.attr('opacity', null);
        sectorDimmedRef.current = false;
      }
      return;
    }
    if (!sectorLayer.empty()) {
      sectorLayer.attr('opacity', 0.2);
      sectorDimmedRef.current = true;
    }

    if (!gRef.current.__scales || !gRef.current.__rotation) return;

    const { xScale, yScale } = gRef.current.__scales;
    const rot = gRef.current.__rotation;
    const samples = channelTelemetry.samples;

    const field = channelMode === 'speed' ? 'Speed'
      : channelMode === 'throttle' ? 'Throttle'
      : channelMode === 'brake' ? 'Brake'
      : null;
    if (!field) return;

    const values = [];
    for (const d of samples) {
      const v = d[field];
      if (v != null && isFinite(v)) values.push(v);
    }
    if (values.length === 0) return;

    let colorScale;
    if (channelMode === 'speed') {
      const vMin = Math.min(...values);
      const vMax = Math.max(...values);
      // cividis: sequential, readable under every colour-vision deficiency
      colorScale = d3.scaleSequential(channelRamp('speed')).domain([vMin, vMax]);
    } else if (channelMode === 'throttle') {
      colorScale = d3.scaleSequential(channelRamp('throttle')).domain([0, 100]);
    } else {
      // Brake — binary or 0..100
      colorScale = d3.scaleSequential(channelRamp('brake')).domain([0, 100]);
    }

    const rotatePt = (x, y) => ({
      x: rot.cx + (x - rot.cx) * rot.cosR - (y - rot.cy) * rot.sinR,
      y: rot.cy + (x - rot.cx) * rot.sinR + (y - rot.cy) * rot.cosR,
    });

    // Build a single path per color-bucket would be faster, but a few hundred
    // line segments perform fine and give smooth per-sample colors.
    for (let i = 1; i < samples.length; i++) {
      const p0 = samples[i - 1];
      const p1 = samples[i];
      if (p0.X == null || p0.Y == null || p1.X == null || p1.Y == null) continue;
      const v = p1[field];
      if (v == null || !isFinite(v)) continue;
      const vNorm = channelMode === 'brake' ? (v > 1 ? v : v * 100) : v;
      const r0 = rotatePt(p0.X, p0.Y);
      const r1 = rotatePt(p1.X, p1.Y);
      layer.append('line')
        .attr('x1', xScale(r0.x))
        .attr('y1', yScale(r0.y))
        .attr('x2', xScale(r1.x))
        .attr('y2', yScale(r1.y))
        .attr('stroke', colorScale(vNorm))
        .attr('stroke-width', 12)
        .attr('stroke-linecap', 'round')
        .attr('opacity', 0.95);
    }
  }, [channelMode, channelTelemetry, circuitInfo, trackRotationOffset, compact, box.width, box.height, fitSig]);

  // Update track border color based on flag status
  useEffect(() => {
    if (!gRef.current) return;
    const flagColor = FLAG_COLORS[currentFlagStatus] || FLAG_COLORS['1'];
    const isNeutral = currentFlagStatus === '1';

    gRef.current.select('.flag-border-left')
      .attr('stroke', flagColor)
      .attr('stroke-width', isNeutral ? 2 : 4)
      .attr('opacity', isNeutral ? 0.6 : 1);
    gRef.current.select('.flag-border-right')
      .attr('stroke', flagColor)
      .attr('stroke-width', isNeutral ? 2 : 4)
      .attr('opacity', isNeutral ? 0.6 : 1);

    const labelLayer = gRef.current.select('.flag-label-layer');
    labelLayer.selectAll('*').remove();

    const label = FLAG_LABELS[currentFlagStatus];
    if (label) {
      const svg = d3.select(svgRef.current);
      const vb = svg.attr('viewBox')?.split(' ').map(Number) || [0, 0, 800, 500];
      labelLayer.append('rect')
        .attr('x', vb[2] / 2 - 80)
        .attr('y', 8)
        .attr('width', 160)
        .attr('height', 24)
        .attr('rx', 4)
        .attr('fill', 'rgba(0,0,0,0.85)')
        .attr('stroke', FLAG_LABEL_COLORS[currentFlagStatus] || TEXT_COLORS.primary)
        .attr('stroke-width', 1.5);
      labelLayer.append('text')
        .attr('x', vb[2] / 2)
        .attr('y', 22)
        .attr('text-anchor', 'middle')
        .attr('fill', textColor(FLAG_LABEL_COLORS[currentFlagStatus] || TEXT_COLORS.primary, SURFACES.page))
        .style('font-size', ZOOMED_FONT.data)
        .attr('font-weight', '700')
        .attr('font-family', "'Titillium Web', sans-serif")
        .text(label);
    }
    // box: the label is centred in the new viewBox (D4)
  }, [currentFlagStatus, box.width, box.height]);

  // Helper: update trail positions for a driver
  const updateTrailPositions = useCallback((driverAbbr, x, y) => {
    const trails = trailPositionsRef.current;
    if (!trails[driverAbbr]) {
      trails[driverAbbr] = [];
    }
    trails[driverAbbr].unshift({ x, y });
    if (trails[driverAbbr].length > TRAIL_LENGTH) {
      trails[driverAbbr].length = TRAIL_LENGTH;
    }
  }, []);

  // Helper: render trail circles for all drivers
  const renderTrails = useCallback((trailsLayer, driverEntries, showTrails) => {
    if (!showTrails) {
      trailsLayer.selectAll('.trail-dot').remove();
      return;
    }

    const trails = trailPositionsRef.current;
    const trailData = [];
    for (const [abbr] of driverEntries) {
      const positions = trails[abbr];
      if (!positions || positions.length < 2) continue;
      for (let i = 1; i < positions.length; i++) {
        trailData.push({
          key: `${abbr}-${i}`,
          driver: abbr,
          idx: i,
          x: positions[i].x,
          y: positions[i].y,
          radius: TRAIL_CONFIG[i].radius,
          opacity: TRAIL_CONFIG[i].opacity,
          color: carMark(abbr),
        });
      }
    }

    const trailCircles = trailsLayer.selectAll('.trail-dot').data(trailData, (d) => d.key);

    trailCircles.enter()
      .append('circle')
      .attr('class', 'trail-dot')
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', (d) => d.radius)
      .attr('fill', (d) => d.color)
      .attr('opacity', (d) => d.opacity)
      .attr('pointer-events', 'none');

    trailCircles
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', (d) => d.radius)
      .attr('fill', (d) => d.color)
      .attr('opacity', (d) => d.opacity);

    trailCircles.exit().remove();
  }, []);

  // ── MAIN EFFECT: Update car positions frame by frame ──────────────
  useEffect(() => {
    if (!gRef.current?.__scales || !sessionData) return;
    // the map waits for a real size (G2): the cars move again once it is laid out
    if (svgRef.current?.getAttribute('data-layout') === 'waiting') return;
    const { xScale, yScale } = gRef.current.__scales;
    const rot = gRef.current.__rotation;

    // Rotate a car position to match track orientation
    const rotatePos = (x, y) => {
      if (!rot) return { x, y };
      const dx = x - rot.cx;
      const dy = y - rot.cy;
      return { x: rot.cx + dx * rot.cosR - dy * rot.sinR, y: rot.cy + dx * rot.sinR + dy * rot.cosR };
    };

    const carsLayer = gRef.current.select('.cars-layer');
    const trailsLayer = gRef.current.select('.trails-layer');
    const tooltip = d3.select('.track-tooltip');

    const drivers = sessionData.driver_info || [];

    // Determine whether to use transitions
    const useTransition = !isInitialRenderRef.current;

    // Build tooltip HTML
    const buildTooltip = (abbr, telemetryData) => {
      const driverInfo = drivers.find((d) => d.Abbreviation === abbr);
      const team = driverInfo?.TeamName || '';
      const speed = telemetryData?.speed ?? '\u2014';
      const throttle = telemetryData?.throttle ?? '\u2014';
      const brake = telemetryData?.brake ?? '\u2014';
      const gear = telemetryData?.gear ?? '\u2014';
      const drs = telemetryData?.drs;
      const tyre = telemetryData?.tyre;
      const tyreLife = telemetryData?.tyre_life;
      const compound = tyre != null ? (COMPOUND_NAMES[tyre] || '\u2014') : '\u2014';
      const gridPos = telemetryData?.gridPos;

      let drsText = 'OFF';
      let drsClass = 'drs-off';
      if (drs === 8) { drsText = 'AVAILABLE'; drsClass = 'drs-avail'; }
      else if (drs === 10 || drs === 12 || drs === 14) { drsText = 'OPEN'; drsClass = 'drs-on'; }

      return `
        <div class="tooltip-title" style="color:${textColor(getDriverColor(abbr), SURFACES.elevated)}">${abbr}</div>
        <div class="tooltip-team">${team}</div>
        <div class="tooltip-divider"></div>
        ${gridPos != null ? `<div class="tooltip-row"><span class="tooltip-label">Grid</span><span class="tooltip-value">P${gridPos}</span></div>` : ''}
        <div class="tooltip-row"><span class="tooltip-label">Speed</span><span class="tooltip-value">${typeof speed === 'number' ? speed.toFixed(0) : speed} km/h</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Throttle</span><span class="tooltip-value tooltip-throttle">${typeof throttle === 'number' ? throttle.toFixed(0) : throttle}%</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Brake</span><span class="tooltip-value tooltip-brake">${typeof brake === 'number' ? brake.toFixed(0) : brake}%</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Gear</span><span class="tooltip-value">${typeof gear === 'number' ? Math.round(gear) : gear}</span></div>
        ${seasonDrsRef.current ? `<div class="tooltip-row"><span class="tooltip-label">DRS</span><span class="tooltip-value ${drsClass}">${drsText}</span></div>` : ''}
        <div class="tooltip-row"><span class="tooltip-label">Tyre</span><span class="tooltip-value">${compound} ${tyreLife != null ? `(${Math.round(tyreLife)} laps)` : ''}</span></div>
      `;
    };

    // Helper: compute sizes based on selection/focus
    const getCarDotRadius = (abbr) => {
      if (abbr === focusDriver) return dotRadius * 1.5;
      if (abbr === highlightedDriver) return dotRadius * 1.5;
      if (selectedDrivers.includes(abbr)) return dotRadius * 1.3;
      if (selectedDrivers.length > 0 && !selectedDrivers.includes(abbr)) return dotRadius * 0.85;
      if (focusDriver && abbr !== focusDriver) return dotRadius * 0.9;
      return dotRadius;
    };

    const getGlowRadius = (abbr) => {
      if (abbr === focusDriver) return glowRadius * 1.4;
      if (abbr === highlightedDriver) return glowRadius * 1.3;
      if (selectedDrivers.includes(abbr)) return glowRadius;
      return glowRadius;
    };

    // Retired only once the retirement has happened (driverStatus)
    const isDriverRetired = (abbr) => !!driverStatus[abbr]?.retired;

    // Context cars (D7): not selected while others are, or not the focus (and
    // not selected) while there is one. Their dot is mixed toward the panel
    // (contextColor, >= 2:1) at full opacity: opacity 0.55 read 1.80:1
    // (Alfa Romeo). A car away from the focus is mixed further than a car
    // not selected, as it was faded further (0.55 / 0.7 before)
    const contextMix = (abbr) => {
      if (abbr === focusDriver) return 0;
      if (selectedDrivers.length > 0 && !selectedDrivers.includes(abbr)) return 0.3;
      if (focusDriver && abbr !== focusDriver && !selectedDrivers.includes(abbr)) return 0.45;
      return 0;
    };
    const carDotFill = (abbr) => {
      const mix = contextMix(abbr);
      return mix > 0 ? contextColor(carMark(abbr), SURFACES.panel, { mix }) : carMark(abbr);
    };

    // ── Resolve which data source to use for car positions ──
    let driverEntries = null;
    let isGridMode = false;

    // 1. Frame data: use frame at currentFrameIndex
    if (frameData?.frames?.length && totalFrames > 0) {
      const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
      const targetFrame = frameData.frames[idx];
      if (targetFrame?.drivers) {
        driverEntries = Object.entries(targetFrame.drivers);
      }
    }

    // 1b. Live mode with frames but missing x,y: estimate. We deliberately
    // do NOT synthesise positions from lap_times alone — without F1's real
    // CarData/Position feed, gap-only inference is too noisy and showed
    // ghost cars. Track-only render until OpenF1 unlocks (post-session) is
    // the user-preferred behaviour.
    if (driverEntries && circuitInfo?.track_coordinates) {
      const needsEstimation = driverEntries.some(([, d]) => d.x == null || d.y == null);
      if (needsEstimation) {
        const frameDrivers = {};
        for (const [abbr, d] of driverEntries) frameDrivers[abbr] = d;
        const estimated = estimateFromFramePositions(circuitInfo.track_coordinates, frameDrivers);
        driverEntries = driverEntries.map(([abbr, d]) => {
          if ((d.x == null || d.y == null) && estimated[abbr]) {
            return [abbr, { ...d, ...estimated[abbr] }];
          }
          return [abbr, d];
        });
      }
    }

    // 2. If no frame data yet, use qualifying grid positions
    if (!driverEntries && gridPositions) {
      isGridMode = true;
      driverEntries = Object.entries(gridPositions);
    }

    // Remove retired drivers from the track entirely
    if (driverEntries && !isGridMode) {
      driverEntries = driverEntries.filter(([abbr]) => !isDriverRetired(abbr));
      // Race replay: the tyre set in force from the lap data (the new set from
      // the pit exit; the frames carry it from the out-lap start, in the pit lane)
      if (!isLiveMode && !isQualifyingReplay) {
        driverEntries = driverEntries.map(([abbr, d]) => {
          const st = driverStatus[abbr];
          return st?.tyre != null ? [abbr, { ...d, tyre: st.tyre, tyre_life: st.tyreLife }] : [abbr, d];
        });
      }
    }

    if (!driverEntries || driverEntries.length === 0) {
      // No data at all — show placeholder
      carsLayer.selectAll('.car-marker').remove();
      trailsLayer.selectAll('.trail-dot').remove();
      return;
    }

    // Update trail positions
    for (const [abbr, pos] of driverEntries) {
      if (pos.x != null && pos.y != null) {
        const rp = rotatePos(pos.x, pos.y);
        updateTrailPositions(abbr, xScale(rp.x), yScale(rp.y));
      }
    }

    // Render trails (only when playing and not in grid mode)
    renderTrails(trailsLayer, driverEntries, isPlaying && !isGridMode);

    // Compute transition duration:
    // At 2.5 FPS, frameDt=0.4s. At 1x speed, transition = 400ms (matches tick interval).
    // This makes cars move smoothly between consecutive frames. Only there
    // (B3): the glide is a straight line, and across a seek (paused, or a jump
    // of more than one frame) it flew the cars along the chord through the
    // infield, so there they are set at the new frame at once. A live feed
    // (no playback) glides 300 ms from one frame to the next
    const playSpeedNow = useF1Store.getState().playSpeed || 1;
    const nextFrame = prevFrameIndexRef.current >= 0
      && Math.abs(currentFrameIndex - prevFrameIndexRef.current) <= 1;
    let transitionDuration = 0;
    if (useTransition && nextFrame && isPlaying) transitionDuration = Math.max(16, (frameDt * 1000) / playSpeedNow);
    else if (useTransition && nextFrame && isLiveMode) transitionDuration = 300;

    const cars = carsLayer.selectAll('.car-marker').data(driverEntries, (d) => d[0]);

    const enter = cars.enter().append('g').attr('class', 'car-marker');
    enter.append('circle').attr('class', 'car-glow').attr('r', glowRadius).attr('fill', 'currentColor').attr('opacity', 0);
    enter.append('circle').attr('class', 'car-dot').attr('r', dotRadius);
    if (!compact) {
      // right of the dot: a compass rose on the right is kept clear of it (CAR_LABEL, mapPlan)
      enter.append('text').attr('class', 'car-label').attr('dx', CAR_LABEL.dx).attr('dy', 4);
    }

    // Grid mode: also show grid position number
    if (isGridMode && !compact) {
      enter.append('text')
        .attr('class', 'car-grid-pos')
        .attr('dx', -12).attr('dy', 4)
        .attr('text-anchor', 'end')
        .attr('fill', TEXT_COLORS.secondary)
        .style('font-size', ZOOMED_FONT.label)
        .attr('font-weight', '700')
        .attr('font-family', "'JetBrains Mono', monospace");
    }

    const merged = enter.merge(cars);

    // Position with smooth D3 transition
    if (transitionDuration > 0) {
      merged
        .transition()
        .duration(transitionDuration)
        .ease(d3.easeLinear)
        .attr('transform', (d) => {
          const pos = d[1];
          if (pos.x == null || pos.y == null) return 'translate(-9999,-9999)';
          const rp = rotatePos(pos.x, pos.y);
          return `translate(${xScale(rp.x)}, ${yScale(rp.y)})`;
        });
    } else {
      // a glide still running would end at the frame it was going to
      merged
        .interrupt()
        .attr('transform', (d) => {
          const pos = d[1];
          if (pos.x == null || pos.y == null) return 'translate(-9999,-9999)';
          const rp = rotatePos(pos.x, pos.y);
          return `translate(${xScale(rp.x)}, ${yScale(rp.y)})`;
        });
    }

    merged
      .classed('selected', (d) => selectedDrivers.includes(d[0]))
      .classed('dimmed', (d) => selectedDrivers.length > 0 && !selectedDrivers.includes(d[0]))
      .classed('highlighted', (d) => d[0] === highlightedDriver)
      .classed('car-marker--focused', (d) => d[0] === focusDriver)
      .classed('car-marker--retired', (d) => isDriverRetired(d[0]))
      // dot >= 3:1, glow in the driver colour (currentColor); a context car
      // (not selected / not the focus) mixes its dot toward the panel only
      // (carDotFill), its label turns to the muted text colour
      // (.car-marker--context, still >= 4.5:1)
      .classed('car-marker--context', (d) => contextMix(d[0]) > 0)
      .style('color', (d) => carText(d[0]));

    merged.select('.car-dot')
      .attr('fill', (d) => carDotFill(d[0]))
      .attr('r', (d) => getCarDotRadius(d[0]))
      .attr('opacity', null);

    merged.select('.car-glow')
      .attr('r', (d) => getGlowRadius(d[0]))
      .attr('opacity', (d) => {
        if (d[0] === focusDriver) return 0.6;
        if (d[0] === highlightedDriver) return 0.5;
        if (selectedDrivers.includes(d[0])) return 0.3;
        return 0;
      })
      .classed('car-glow--selected', (d) => selectedDrivers.includes(d[0]))
      .classed('car-glow--highlighted', (d) => d[0] === highlightedDriver)
      .classed('car-glow--focused', (d) => d[0] === focusDriver);

    if (!compact) {
      // A car whose code label would cross the map's right edge, where the
      // svg clips it, has it on the left of its dot (carLabelOnLeft)
      const mapW = gRef.current.__mapWidth || 0;
      const labelLeft = (d) => {
        const pos = d[1];
        if (pos.x == null || pos.y == null) return false;
        return carLabelOnLeft(xScale(rotatePos(pos.x, pos.y).x), mapW);
      };
      merged.select('.car-label')
        .text((d) => d[0])
        .attr('dx', (d) => (labelLeft(d) ? -CAR_LABEL.dx : CAR_LABEL.dx))
        .classed('car-label--left', labelLeft)
        .classed('car-label--focused', (d) => d[0] === focusDriver);

      // Update grid position labels (on the side the code label is not)
      if (isGridMode) {
        merged.select('.car-grid-pos')
          .text((d) => d[1].gridPos != null ? `P${d[1].gridPos}` : '')
          .attr('dx', (d) => (labelLeft(d) ? CAR_LABEL.dx : -CAR_LABEL.dx))
          .attr('text-anchor', (d) => (labelLeft(d) ? 'start' : 'end'));
      }
    }

    merged
      .on('click', (event, d) => toggleDriver(d[0]))
      .on('mouseenter', (event, d) => {
        setHighlightedDriver(d[0]);
        tooltip
          .html(buildTooltip(d[0], d[1]))
          .style('left', event.pageX + 12 + 'px')
          .style('top', event.pageY - 12 + 'px')
          .classed('visible', true)
          .style('opacity', 1);
      })
      .on('mousemove', (event) => {
        tooltip
          .style('left', event.pageX + 12 + 'px')
          .style('top', event.pageY - 12 + 'px');
      })
      .on('mouseleave', () => {
        setHighlightedDriver(null);
        tooltip.classed('visible', false).style('opacity', 0);
      });

    cars.exit().remove();

    // Remove grid position labels when switching away from grid mode
    if (!isGridMode) {
      carsLayer.selectAll('.car-grid-pos').remove();
    }

    isInitialRenderRef.current = false;
    prevFrameIndexRef.current = currentFrameIndex;
  }, [circuitInfo, sessionData, currentFrameIndex, frameData, totalFrames, frameDt,
      selectedDrivers, highlightedDriver, focusDriver, gridPositions, driverStatus, isLiveMode, isQualifyingReplay,
      toggleDriver, setHighlightedDriver, isPlaying, compact, dotRadius, glowRadius,
      updateTrailPositions, renderTrails, trackRotationOffset, box.width, box.height, fitSig]);

  // ── Telemetry HUD data for focused + selected drivers ──────────────
  const hudDrivers = useMemo(() => {
    const list = [];
    if (focusDriver) list.push(focusDriver);
    selectedDrivers.forEach((d) => { if (!list.includes(d)) list.push(d); });
    // Filter out drivers whose retirement has happened
    return list.filter((d) => !driverStatus[d]?.retired);
  }, [focusDriver, selectedDrivers, driverStatus]);

  const liveTelemetry = useF1Store((s) => s.liveTelemetry);

  const hudDataList = useMemo(() => {
    if (hudDrivers.length === 0) return [];

    // Try frame data first (replay mode or live mode with OpenF1 positions)
    if (frameData?.frames?.length && currentFrameIndex >= 0) {
      const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
      const frame = frameData.frames[idx];
      if (frame?.drivers) {
        return hudDrivers.map((drv) => {
          const d = frame.drivers[drv];
          if (!d) return null;
          // Race replay: the set in force from the lap data (new set from the pit exit)
          const st = isLiveMode || isQualifyingReplay ? null : driverStatus[drv];
          const tyreInt = st?.tyre ?? d.tyre ?? 0;
          const tyreLife = st?.tyre != null ? st.tyreLife : d.tyre_life;
          const drsVal = d.drs;
          let drsText = 'OFF', drsClass = 'hud-drs--off';
          if (drsVal === 8) { drsText = 'AVAIL'; drsClass = 'hud-drs--avail'; }
          else if (drsVal === 10 || drsVal === 12 || drsVal === 14) { drsText = 'OPEN'; drsClass = 'hud-drs--on'; }
          return {
            driver: drv,
            isFocused: drv === focusDriver,
            color: carMark(drv),
            speed: typeof d.speed === 'number' ? d.speed.toFixed(0) : '—',
            throttle: typeof d.throttle === 'number' ? d.throttle.toFixed(0) : '—',
            brake: typeof d.brake === 'number' ? d.brake.toFixed(0) : '—',
            gear: typeof d.gear === 'number' ? Math.round(d.gear) : '—',
            drsText, drsClass,
            compound: COMPOUND_NAMES[tyreInt] || 'UNK',
            compoundColor: COMPOUND_COLORS[tyreInt] || COMPOUND_COLORS[0],
            compoundKey: COMPOUND_KEYS[tyreInt] || 'UNKNOWN',
            tyreLife: tyreLife != null ? Math.round(tyreLife) : '—',
            lap: d.lap != null ? d.lap : '—',
          };
        }).filter(Boolean);
      }
    }

    // Fallback: use live telemetry from OpenF1 (when no frame positions available)
    if (isLiveMode && liveTelemetry && Object.keys(liveTelemetry).length > 0) {
      return hudDrivers.map((drv) => {
        const t = liveTelemetry[drv];
        if (!t) return null;
        const drsVal = t.drs;
        let drsText = 'OFF', drsClass = 'hud-drs--off';
        if (drsVal === 8) { drsText = 'AVAIL'; drsClass = 'hud-drs--avail'; }
        else if (drsVal === 10 || drsVal === 12 || drsVal === 14) { drsText = 'OPEN'; drsClass = 'hud-drs--on'; }
        return {
          driver: drv,
          isFocused: drv === focusDriver,
          color: carMark(drv),
          speed: typeof t.speed === 'number' ? t.speed.toFixed(0) : '—',
          throttle: typeof t.throttle === 'number' ? t.throttle.toFixed(0) : '—',
          brake: typeof t.brake === 'number' ? t.brake.toFixed(0) : '—',
          gear: typeof t.gear === 'number' ? Math.round(t.gear) : '—',
          drsText, drsClass,
          compound: '—', compoundColor: COMPOUND_COLORS[0], compoundKey: 'UNKNOWN',
          tyreLife: '—',
          lap: currentLap || '—',
        };
      }).filter(Boolean);
    }

    return [];
  }, [hudDrivers, focusDriver, frameData, currentFrameIndex, isLiveMode, liveTelemetry, currentLap, driverStatus, isQualifyingReplay]);

  // Build driver legend
  const driverLegendItems = useMemo(() => {
    const driverList = sessionData?.driver_info || [];
    const displayDrivers = selectedDrivers.length > 0
      ? driverList.filter((d) => selectedDrivers.includes(d.Abbreviation))
      : driverList.slice(0, 10);
    return displayDrivers.map((d) => ({
      label: d.Abbreviation,
      color: carMark(d.Abbreviation),
      shape: 'circle',
      active: selectedDrivers.length === 0 || selectedDrivers.includes(d.Abbreviation),
      onClick: () => toggleDriver(d.Abbreviation),
    }));
  }, [sessionData, selectedDrivers, toggleDriver]);

  // Toggle: active = its colour as border and text (>= 4.5:1) on a tint;
  // inactive = muted text, a >= 3:1 grey border
  const toggleBtnStyle = (active, color) => ({
    padding: '2px 8px',
    fontSize: CHART_FONT.label,
    fontWeight: 700,
    border: `1.5px solid ${active ? color : GRID_COLORS.rule}`,
    borderRadius: '4px',
    background: active ? withAlpha(color, 0.13) : 'transparent',
    color: active ? textColor(color, SURFACES.panel) : TEXT_COLORS.muted,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    fontFamily: "'Titillium Web', sans-serif",
    letterSpacing: '0.04em',
    lineHeight: '18px',
  });

  // Map key: what is drawn (sectors, DRS zones, the channel overlay's ramp
  // once the overlay is on the track: the focus driver's lap telemetry loaded)
  const overlayDrawn = !!(channelMode && channelTelemetry);
  const sectorKeyItems = [1, 2, 3].filter((s) => [showSector1, showSector2, showSector3][s - 1])
    .map((s) => ({ label: `S${s}`, color: SECTOR_COLORS[s], shape: 'line', strokeWidth: 5 }));
  const drsKeyItems = seasonDrs && showDRS
    ? [{ label: 'DRS zone', color: TRACK_COLORS.drs, shape: 'band', fill: TRACK_COLORS.drsFill }]
    : [];
  const rampKeyItems = overlayDrawn ? channelLegend(channelMode) : [];
  const mapKeyItems = [...sectorKeyItems, ...drsKeyItems, ...rampKeyItems];

  // The one-line key on the map's corner (popover layout): under a
  // drawn overlay the ramp takes the place of S1-S3 (dimmed under it; the
  // full key stays in the Layers popover), so the line holds at 1366 x 768
  // (the speed / throttle / brake ramp and S1-S3 together needed 375-378 px
  // of 262-346). Should it still not fit (a narrower map), the last items
  // give way to a "+k" chip: measured after layout, one item at a time
  const cornerKeyShown = !layersInline && mapKeyItems.length > 0;
  const cornerKeyAll = overlayDrawn ? [...rampKeyItems, ...drsKeyItems] : [...sectorKeyItems, ...drsKeyItems];
  const keyRef = useRef(null);
  const cornerKeySig = `${cornerKeyAll.map((i) => i.label || '·').join('|')}|${box.width}`;
  const [keyFit, setKeyFit] = useState({ sig: '', drop: 0 });
  const keyDrop = keyFit.sig === cornerKeySig ? keyFit.drop : 0;
  const cornerKeyItems = keyDrop > 0 ? cornerKeyAll.slice(0, cornerKeyAll.length - keyDrop) : cornerKeyAll;
  useLayoutEffectInBrowser(() => {
    const el = keyRef.current;
    if (!el) return;
    const over = Number(el.scrollWidth) > Number(el.clientWidth) + 1;
    if (over && keyDrop < cornerKeyAll.length - 1) setKeyFit({ sig: cornerKeySig, drop: keyDrop + 1 });
  }, [cornerKeySig, keyDrop, cornerKeyAll.length]);

  // The HUD and the compass rose in the map's furniture (mapPlan): the
  // focus and selected drivers fill the HUD's slot from its bottom
  // (hudTable), the compass sits at the plan's place; neither moves the track.
  // No plan yet (the circuit's outline not loaded, or a server render): the
  // HUD still reads, in the slot of the box (or of the first layout's size)
  const hudSlotNow = plan
    ? plan.hud
    : hudSlot(measured ? box : { width: 800, height: 500 }, { drs: seasonDrs });
  const hudPlan = hudTable(hudSlotNow, hudDataList.length);
  // What the HUD table leaves out for room (B7): the columns (counted in its
  // header, "+k cols") and the drivers past its rows (counted on its last
  // row, "+k more"); the Layers popover names both
  const hudHidden = hudPlan?.mode === 'table' ? hudHiddenColumns(hudPlan.columns, { drs: seasonDrs }) : [];
  const hudMore = hudPlan?.mode === 'table' ? hudDataList.slice(hudPlan.shown).map((h) => h.driver) : [];
  const compassOffsets = plan && measured
    ? boxOffsets(plan, plan.compass.box)
    : { right: COMPASS.edge, bottom: COMPASS.edge };

  /* ── Track Progress Highlight (from Speed Trace playhead) ──── */
  const trackProgress = useF1Store((s) => s.trackProgress);
  const focusDriverForTrack = useF1Store((s) => s.focusDriver);

  useEffect(() => {
    if (!gRef.current) return;
    const g = gRef.current; // already a D3 selection

    // Remove previous marker
    g.selectAll('.track-progress-marker').remove();

    if (trackProgress == null || !focusDriverForTrack) return;

    // Find the track outline path
    const pathEl = g.select('.outline-layer .track-outline').node();
    if (!pathEl) return;

    try {
      const totalLen = pathEl.getTotalLength();
      const pt = pathEl.getPointAtLength(trackProgress * totalLen);
      const color = carMark(focusDriverForTrack);

      const markerG = g.append('g').attr('class', 'track-progress-marker');

      // Outer glow
      markerG.append('circle')
        .attr('cx', pt.x).attr('cy', pt.y)
        .attr('r', 12)
        .attr('fill', color)
        .attr('opacity', 0.15);

      // Inner dot
      markerG.append('circle')
        .attr('cx', pt.x).attr('cy', pt.y)
        .attr('r', 5)
        .attr('fill', color)
        .attr('stroke', TEXT_COLORS.primary)
        .attr('stroke-width', 1.5);
    } catch {
      // Path not ready yet
    }
  }, [trackProgress, focusDriverForTrack, box.width, box.height, fitSig]);

  // ── Controls (G1, utils/views/trackMapLayout.js): one row of icon buttons
  // in the header (never wrapped); the layers, the channel overlay and the
  // legends above the map in a tall panel, else in the Layers popover, with
  // a one-line key of what is drawn on the map's top-left corner
  const icon = (children) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
  const separator = (key) => (
    <span key={key} aria-hidden="true" className="track-map-toolbar__sep" style={{ width: TOOL_SEPARATOR_PX, height: 16, flexShrink: 0 }} />
  );
  const rotationTools = [
    <MapTool key="cw" title="Rotate clockwise (R)" onClick={rotateTrackCW}>
      {icon(<><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>)}
    </MapTool>,
    <MapTool key="ccw" title="Rotate counter-clockwise (Shift+R)" onClick={rotateTrackCCW}>
      {icon(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>)}
    </MapTool>,
    <MapTool key="auto" title="Reset to default orientation" onClick={resetTrackRotation}>
      {icon(<polygon points="12 2 19 21 12 17 5 21 12 2" />)}
    </MapTool>,
  ];

  const toolbar = (
    <div
      className="track-map-toolbar"
      role="toolbar"
      aria-label="Track Map tools"
      style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: TOOL_GAP_PX, flexShrink: 0 }}
    >
      {rotateTools && [...rotationTools, separator('sep-rotate')]}
      <MapTool title="Zoom in" onClick={handleZoomIn}>{icon(<path d="M12 5v14M5 12h14" />)}</MapTool>
      <MapTool title="Zoom out" onClick={handleZoomOut}>{icon(<path d="M5 12h14" />)}</MapTool>
      <MapTool title="Reset zoom (whole track)" onClick={handleZoomReset}>
        {icon(<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />)}
      </MapTool>
      {!layersInline && separator('sep-layers')}
      {!layersInline && (
        <MapTool
          ref={layersBtnRef}
          className="track-map-tool--layers"
          title={layersOpen ? 'Close the layers' : 'Layers, telemetry overlay and key'}
          onClick={() => setLayersOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={layersOpen}
          aria-controls={layersOpen ? 'track-map-layers' : undefined}
          active={layersOpen}
        >
          {icon(<><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>)}
        </MapTool>
      )}
    </div>
  );

  // The groups of the layers strip / popover
  const layerGroups = [
    !rotateTools && (
      <LayerGroup key="orientation" label="Orientation">{rotationTools}</LayerGroup>
    ),
    <LayerGroup key="layers" label="Layers">
      <button type="button" aria-pressed={showSector1} style={toggleBtnStyle(showSector1, SECTOR_COLORS[1])} onClick={() => setShowSector1(!showSector1)}>S1</button>
      <button type="button" aria-pressed={showSector2} style={toggleBtnStyle(showSector2, SECTOR_COLORS[2])} onClick={() => setShowSector2(!showSector2)}>S2</button>
      <button type="button" aria-pressed={showSector3} style={toggleBtnStyle(showSector3, SECTOR_COLORS[3])} onClick={() => setShowSector3(!showSector3)}>S3</button>
      {seasonDrs && (
        <button type="button" aria-pressed={showDRS} style={toggleBtnStyle(showDRS, TRACK_COLORS.drs)} onClick={() => setShowDRS(!showDRS)}>DRS</button>
      )}
      <button type="button" aria-pressed={showCorners} style={toggleBtnStyle(showCorners, TEXT_COLORS.secondary)} onClick={() => setShowCorners(!showCorners)}>Corners</button>
    </LayerGroup>,
    <LayerGroup key="overlay" label="Overlay">
      <button
        type="button"
        aria-pressed={channelMode === 'speed'}
        style={toggleBtnStyle(channelMode === 'speed', CHANNEL_COLORS.speed)}
        onClick={() => setChannelMode(channelMode === 'speed' ? null : 'speed')}
        title={focusDriver ? `Speed overlay (${focusDriver})` : 'Select a focus driver first'}
      >SPD</button>
      <button
        type="button"
        aria-pressed={channelMode === 'throttle'}
        style={toggleBtnStyle(channelMode === 'throttle', CHANNEL_COLORS.throttle)}
        onClick={() => setChannelMode(channelMode === 'throttle' ? null : 'throttle')}
        title={focusDriver ? `Throttle overlay (${focusDriver})` : 'Select a focus driver first'}
      >THR</button>
      <button
        type="button"
        aria-pressed={channelMode === 'brake'}
        style={toggleBtnStyle(channelMode === 'brake', CHANNEL_COLORS.brake)}
        onClick={() => setChannelMode(channelMode === 'brake' ? null : 'brake')}
        title={focusDriver ? `Brake overlay (${focusDriver})` : 'Select a focus driver first'}
      >BRK</button>
      {/* an overlay chosen but not drawn yet: say why (the key shows its ramp once drawn) */}
      {channelMode && !overlayDrawn && (
        <span className="track-map-layers__hint">
          {focusDriver ? `Loading ${focusDriver}'s last lap` : 'Select a focus driver'}
        </span>
      )}
    </LayerGroup>,
    // Legend (V4): sectors, DRS, the channel overlay's ramp, the cars
    mapKeyItems.length > 0 && (
      <LayerGroup key="key" label="Key"><Legend items={mapKeyItems} /></LayerGroup>
    ),
    driverLegendItems.length > 0 && (
      <LayerGroup key="drivers" label="Drivers"><Legend items={driverLegendItems} shape="circle" /></LayerGroup>
    ),
    // The telemetry HUD's columns and drivers left out for room (B7): the
    // table counts them, these name them
    (hudHidden.length > 0 || hudMore.length > 0) && (
      <LayerGroup key="hud" label="HUD">
        {hudHidden.length > 0 && (
          <span className="track-map-layers__note">
            {`${hudColumnsHint(hudHidden.length)} hidden: ${hudHidden.map((c) => c.label).join(', ')}`}
          </span>
        )}
        {hudMore.length > 0 && (
          <span className="track-map-layers__note">{`+${hudMore.length} more drivers: ${hudMore.join(', ')}`}</span>
        )}
      </LayerGroup>
    ),
  ].filter(Boolean);

  if (compact) {
    return (
      <div
        className="viz-container track-map-compact"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(26,31,51,0.6) 0%, rgba(21,21,30,0.9) 100%)',
          borderRadius: '8px',
          width: '100%',
          height: '100%',
          position: 'relative',
        }}
      >
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {isLiveMode && (!frameData?.frames?.length) && (
          <div style={{
            position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, padding: '2px 8px', borderRadius: 3,
            background: 'rgba(0,0,0,0.6)', fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, whiteSpace: 'nowrap',
          }}>
            No live positions
          </div>
        )}
      </div>
    );
  }

  // Race finish + winner detection
  const raceTarget = totalRaceLaps || maxLap;
  const raceFinished = isRace && (isLiveMode
    ? (currentLap >= raceTarget && raceTarget > 1 && currentLap > 2)
    : (replayFinished && maxLap > 1));
  // The winner is the car that took the chequered flag first: the Position-1
  // row of the last lap (the same row that times the flag, leaderLapEndTime),
  // as the Leaderboard's first row. Never race_results: the final
  // classification is not known while the other cars are still finishing.
  const winnerAbbr = useMemo(() => {
    if (!raceFinished) return null;
    const lastRows = (sessionData?.lap_times || []).filter(
      (r) => Number(r.LapNumber) === maxLap && r.Driver,
    );
    const p1 = lastRows.find((r) => Number(r.Position) === 1)
      || lastRows.filter((r) => Number.isFinite(r.Time)).sort((a, b) => a.Time - b.Time)[0];
    return p1?.Driver || null;
  }, [raceFinished, sessionData, maxLap]);
  const winnerColor = winnerAbbr ? getDriverColor(winnerAbbr) : null;

  const isHazardActive = currentFlagStatus && currentFlagStatus !== '1';
  const hazardColor = FLAG_COLORS[currentFlagStatus] || 'transparent';

  const panelStyle = raceFinished && winnerColor
    ? {
        '--hazard-color': winnerColor,
        '--hazard-color-bright': winnerColor,
        '--hazard-color-dim': withAlpha(winnerColor, 0.27),
        border: `3px solid ${winnerColor}`,
        boxShadow: `0 0 20px ${withAlpha(winnerColor, 0.33)}`,
        animation: 'hazard-border-pulse 2s ease-in-out infinite',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
      }
    : {
        '--hazard-color': hazardColor,
        '--hazard-color-bright': hazardColor,
        '--hazard-color-dim': withAlpha(hazardColor, 0.27),
        border: isHazardActive
          ? `3px solid ${hazardColor}`
          : '2px solid rgba(255, 255, 255, 0.12)',
        boxShadow: isHazardActive
          ? `0 0 16px ${withAlpha(hazardColor, 0.27)}`
          : '0 4px 30px rgba(0, 0, 0, 0.3)',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        animation: isHazardActive ? 'hazard-border-pulse 1.2s ease-in-out infinite' : 'none',
      };

  return (
    <Panel
      title="Track Map"
      className="panel--dense track-map-panel"
      controls={toolbar}
      style={panelStyle}
      focused={focusedView === 'trackmap'}
      shortcutKey="1"
    >
      {/* A tall panel: the layers, the overlay and the legends above the map */}
      {layersInline && (
        <div className="track-map-layers track-map-layers--inline" aria-label="Track Map layers, overlay and key">
          {layerGroups}
        </div>
      )}
      <div ref={vizRef} className="viz-container" style={{
        background: 'radial-gradient(ellipse at center, rgba(26,31,51,0.6) 0%, rgba(21,21,30,0.9) 100%)',
        borderRadius: '8px',
        position: 'relative',
      }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />

        {/* Below LAYERS_INLINE_MIN_H: a one-line key of what is drawn on the
            map's corner (the full key and the toggles: the Layers popover);
            the track is fitted clear of it, of the HUD and of the compass */}
        {cornerKeyShown && (
          <div ref={keyRef} className="track-map-key" aria-label="Key of the map">
            <Legend items={cornerKeyItems} />
            {keyDrop > 0 && (
              <span className="track-map-key__more">{`+${keyDrop}`}</span>
            )}
          </div>
        )}
        {!layersInline && layersOpen && (
          <TrackLayersPopover anchorRef={layersBtnRef} onClose={closeLayers}>
            {layerGroups}
          </TrackLayersPopover>
        )}

        {/* Compass Rose: at the place the map's plan gives it (mapPlan compassAt) */}
        <CompassRose
          trackRotationOffset={trackRotationOffset}
          circuitRotation={circuitInfo?.rotation || 0}
          onClickCardinal={(angle) => setTrackRotationAbsolute(-angle)}
          offsets={compassOffsets}
          place={plan?.compass.place || 'br'}
        />

        {/* Winner overlay at race end */}
        {raceFinished && winnerAbbr && (
          <div style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 15,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 16px',
            background: 'rgba(10, 10, 20, 0.85)',
            backdropFilter: 'blur(8px)',
            border: `2px solid ${withAlpha(winnerColor, 0.53)}`,
            borderRadius: 8,
            boxShadow: `0 0 16px ${withAlpha(winnerColor, 0.2)}`,
            // static: pulsed down to opacity 0.9 (winner-banner-glow), the
            // winner's name in his colour read 4.08:1 (LEC)
          }}>
            <span style={{
              width: 4,
              height: 20,
              borderRadius: 2,
              background: markColor(winnerColor, SURFACES.page),
            }} />
            <span style={{
              fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              fontWeight: 900,
              fontSize: '13px',
              letterSpacing: '0.15em',
              color: TEXT_COLORS.primary,
            }}>
              CHEQUERED FLAG
            </span>
            <span style={{
              fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              fontWeight: 900,
              fontSize: '14px',
              color: textColor(winnerColor, SURFACES.page),
              letterSpacing: '0.08em',
            }}>
              {(() => {
                const info = (drivers || []).find((d) => d.Abbreviation === winnerAbbr);
                return info?.FullName?.toUpperCase() || winnerAbbr;
              })()} WINS
            </span>
          </div>
        )}

        {/* Live mode: race control feed overlay when no position data */}
        {isLiveMode && (!frameData?.frames?.length) && (
          <LiveRaceControlOverlay />
        )}

        {/* Telemetry HUD of the focus and selected drivers
            (trackMapLayout.js hudLayout): a table in a map under
            HUD_CARDS_MIN_H, one row per driver; a card per driver in a big one */}
        {hudPlan?.mode === 'table' && (
          <TrackHudTable rows={hudDataList} plan={hudPlan} hidden={hudHidden} />
        )}
        {hudPlan?.mode === 'cards' && (
          <div className="track-telemetry-hud-container">
            {hudDataList.map((hud) => (
              <div
                key={hud.driver}
                className={`track-telemetry-hud ${hud.isFocused ? 'track-telemetry-hud--focused' : ''}`}
                style={{ borderColor: withAlpha(hud.color, 0.53), boxShadow: `0 0 8px ${withAlpha(hud.color, 0.13)}` }}
              >
                <div className="track-telemetry-hud__header">
                  <span className="track-telemetry-hud__driver" style={{ color: textColor(hud.color, SURFACES.page) }}>
                    {hud.driver}
                  </span>
                  <span className="track-telemetry-hud__lap">L{hud.lap}</span>
                </div>
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">SPD</span>
                  <span className="track-telemetry-hud__value">{hud.speed}<span className="track-telemetry-hud__unit">km/h</span></span>
                </div>
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">THR</span>
                  <span className="track-telemetry-hud__value">
                    <span className="track-telemetry-hud__bar-track">
                      <span className="track-telemetry-hud__bar-fill track-telemetry-hud__bar-fill--throttle" style={{ width: `${hud.throttle}%` }} />
                    </span>
                    {hud.throttle}%
                  </span>
                </div>
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">BRK</span>
                  <span className="track-telemetry-hud__value">
                    <span className="track-telemetry-hud__bar-track">
                      <span className="track-telemetry-hud__bar-fill track-telemetry-hud__bar-fill--brake" style={{ width: `${hud.brake}%` }} />
                    </span>
                    {hud.brake}%
                  </span>
                </div>
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">GEAR</span>
                  <span className="track-telemetry-hud__value track-telemetry-hud__gear">{hud.gear}</span>
                </div>
                {seasonDrs && (
                  <div className="track-telemetry-hud__row">
                    <span className="track-telemetry-hud__label">DRS</span>
                    <span className={`track-telemetry-hud__value ${hud.drsClass}`}>{hud.drsText}</span>
                  </div>
                )}
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">TYRE</span>
                  <span className="track-telemetry-hud__value">
                    {/* compound badge: FIA colour + letter in contrastText */}
                    <span
                      className="track-telemetry-hud__tyre-dot"
                      style={{
                        background: hud.compoundColor, color: contrastText(hud.compoundColor),
                        width: 'auto', height: 'auto', minWidth: 13, lineHeight: '13px', textAlign: 'center',
                        fontSize: CHART_FONT.label, fontWeight: 800,
                      }}
                    >{tyreLetter(hud.compoundKey)}</span>
                    {hud.compound}
                    <span className="track-telemetry-hud__tyre-life">L{hud.tyreLife}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/*
 * The telemetry HUD as a table: one HUD_TABLE.rowPx row per driver
 * (the focus driver first), the columns of plan.columns at their fixed
 * widths, so the box is the one hudLayout gave the track fit; drivers past
 * the row cap are counted on a last row ("+k more"), the columns left out
 * (hidden) in the driver column's header ("+k cols"); the Layers popover
 * names both (B7: the names cut the last row to an ellipsis, and nothing
 * said that columns were left out). Drawn like the map (dark in both
 * themes), no pointer events: the map pans and zooms under it.
 */
function TrackHudTable({ rows, plan, hidden = [] }) {
  const cols = plan.columns || [];
  const shown = rows.slice(0, plan.shown);
  const more = rows.length - shown.length;
  const hint = hudColumnsHint(hidden.length);
  const label = hidden.length
    ? `Telemetry of the focus and selected drivers; left out for room: ${hidden.map((c) => c.title).join(', ')} (named in the map's layers)`
    : 'Telemetry of the focus and selected drivers';
  const cell = (id, hud) => {
    switch (id) {
      case 'drv':
        return <span className="track-hud__drv" style={{ color: textColor(hud.color, SURFACES.page) }}>{hud.driver}</span>;
      case 'speed': return hud.speed;
      case 'gear': return hud.gear;
      case 'thr': return hud.throttle;
      case 'brk': return hud.brake;
      case 'drs': return <span className={`track-hud__drs track-hud__drs--${hud.drsClass.replace('hud-drs--', '')}`}>{hud.drsText}</span>;
      case 'tyre':
        return (
          <>
            {/* compound badge: FIA colour + letter in contrastText */}
            <span className="track-hud__tyre" style={{ background: hud.compoundColor, color: contrastText(hud.compoundColor) }}>
              {tyreLetter(hud.compoundKey)}
            </span>
            {hud.tyreLife}
          </>
        );
      default: return null;
    }
  };
  return (
    <div
      className="track-hud"
      style={{ width: hudTableWidth(cols), height: plan.box.y1 - plan.box.y0 }}
      data-rows={plan.rows}
    >
      <table className="track-hud__table" aria-label={label}>
        <colgroup>
          {cols.map((c, i) => <col key={c.id} style={{ width: c.px + (i > 0 ? HUD_TABLE.gapPx : 0) }} />)}
        </colgroup>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id} scope="col" title={c.title} className={`track-hud__h track-hud__h--${c.id}`}>
                {c.id === 'drv' && hint && <span className="track-hud__cols" aria-hidden="true">{hint}</span>}
                {c.label || <span className="sr-only">{c.title}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((hud) => (
            <tr key={hud.driver} className={hud.isFocused ? 'track-hud__row track-hud__row--focus' : 'track-hud__row'}>
              {cols.map((c) => <td key={c.id} className={`track-hud__c track-hud__c--${c.id}`}>{cell(c.id, hud)}</td>)}
            </tr>
          ))}
          {more > 0 && (
            <tr className="track-hud__row">
              <td colSpan={cols.length} className="track-hud__more">{`+${more} more`}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── Toolbar button: a TOOL_PX square icon button, its title as its name ── */
const MapTool = React.forwardRef(function MapTool({
  title, onClick, children, className = '', active = false, ...rest
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`track-map-tool ${className}`.trim()}
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: TOOL_PX,
        height: TOOL_PX,
        padding: 0,
        flexShrink: 0,
        // the colours: visualizations.css .track-map-tool, per theme (the
        // header is light in the light theme: >= 3:1 glyph and border in both)
      }}
      data-active={active ? 'true' : undefined}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ── A labelled group of the layers strip / popover ── */
function LayerGroup({ label, children }) {
  return (
    <div className="track-map-layers__group" role="group" aria-label={label}>
      <span className="track-map-layers__label">{label}</span>
      <div className="track-map-layers__items">{children}</div>
    </div>
  );
}

// Width of the Layers popover and its distance to the window's edges (CSS px)
const LAYERS_POPOVER_W = 320;
const LAYERS_POPOVER_EDGE = 8;

/*
 * The Layers popover (G1): under the Layers button, right-aligned to it,
 * kept inside the window; laid over the dashboard (fixed, on document.body)
 * so it never takes room from the map. Closed by Escape, the × button, the
 * Layers button or a click outside.
 */
function TrackLayersPopover({ anchorRef, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: LAYERS_POPOVER_EDGE, top: LAYERS_POPOVER_EDGE });

  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect?.();
      if (!a) return;
      const vw = Number(window.innerWidth) || 0;
      const vh = Number(window.innerHeight) || 0;
      const h = ref.current?.offsetHeight || 0;
      const left = Math.max(LAYERS_POPOVER_EDGE, Math.min(vw - LAYERS_POPOVER_W - LAYERS_POPOVER_EDGE, a.right - LAYERS_POPOVER_W));
      const top = Math.max(LAYERS_POPOVER_EDGE, Math.min(a.bottom + 6, vh - h - LAYERS_POPOVER_EDGE));
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e) => {
      const inside = ref.current?.contains(e.target) || anchorRef.current?.contains(e.target);
      if (!inside) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  return ReactDOM.createPortal(
    <div
      ref={ref}
      id="track-map-layers"
      className="track-map-layers track-map-layers--popover"
      role="dialog"
      aria-label="Track Map layers, overlay and key"
      style={{ left: pos.left, top: pos.top, width: LAYERS_POPOVER_W }}
    >
      <div className="track-map-layers__head">
        <span>Track Map</span>
        <button type="button" className="track-map-layers__close" onClick={onClose} aria-label="Close the layers">×</button>
      </div>
      {children}
    </div>,
    document.body,
  );
}

/* ── Compass Rose: shows geographic north, click cardinal to orient ── */
function CompassRose({
  trackRotationOffset, circuitRotation, onClickCardinal,
  offsets = { right: COMPASS.edge, bottom: COMPASS.edge }, place = 'br',
}) {
  // Total geographic rotation = FastF1 base + user offset
  // Compass needle must point to TRUE north → rotate inversely
  const totalRotation = (circuitRotation || 0) + (trackRotationOffset || 0);
  const compassAngle = -totalRotation;

  const cardinals = [
    { label: 'N', angle: 0, color: TRACK_COLORS.north },
    { label: 'E', angle: 90, color: TEXT_COLORS.secondary },
    { label: 'S', angle: 180, color: TEXT_COLORS.secondary },
    { label: 'W', angle: 270, color: TEXT_COLORS.secondary },
  ];

  return (
    <svg
      className="track-map-compass"
      data-place={place}
      viewBox="-32 -32 64 64"
      style={{
        position: 'absolute', ...offsets, zIndex: 10,
        width: COMPASS.size, height: COMPASS.size, maxWidth: COMPASS.size, maxHeight: COMPASS.size,
        pointerEvents: 'auto', cursor: 'default',
        filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
      }}
    >
      {/* Background */}
      <circle r="20" fill="rgba(10,10,25,0.7)" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />

      {/* Needle group: rotates to always point north */}
      <g transform={`rotate(${compassAngle})`}>
        {/* North arrow (red) */}
        <path d="M0,-15 L-3.5,0 L3.5,0 Z" fill={TRACK_COLORS.north} />
        {/* South arrow (dim) */}
        <path d="M0,15 L-3.5,0 L3.5,0 Z" fill="rgba(255,255,255,0.2)" />
      </g>

      {/* Cardinal labels: positioned at compass-rotated angles */}
      {cardinals.map(({ label, angle, color }) => {
        const rad = ((angle + compassAngle) * Math.PI) / 180;
        const r = 24;
        const cx = Math.sin(rad) * r;
        const cy = -Math.cos(rad) * r;
        return (
          <text
            key={label}
            x={cx} y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fill={color}
            fontWeight="700"
            style={{ cursor: 'pointer', userSelect: 'none', fontSize: CHART_FONT.label }}
            onClick={() => onClickCardinal(angle)}
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}
