import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

// Flag status → color mapping (from reference project)
const FLAG_COLORS = {
  '1': 'rgba(255,255,255,0.4)',   // Green flag - normal track border
  '2': '#FFCC00',                  // Yellow flag
  '4': '#FF8C00',                  // Safety Car (orange)
  '5': '#FF0000',                  // Red flag
  '6': '#FF8C00',                  // VSC
  '7': '#FF8C00',                  // VSC
};

const FLAG_LABELS = {
  '1': null,
  '2': 'YELLOW FLAG',
  '4': 'SAFETY CAR',
  '5': 'RED FLAG',
  '6': 'VIRTUAL SAFETY CAR',
  '7': 'VIRTUAL SAFETY CAR',
};

const FLAG_LABEL_COLORS = {
  '2': '#FFCC00',
  '4': '#FF8C00',
  '5': '#FF0000',
  '6': '#FF8C00',
  '7': '#FF8C00',
};

const SECTOR_COLORS = { 1: '#e10600', 2: '#ffd700', 3: '#0090ff' };
const COMPOUND_NAMES = { 0: 'UNK', 1: 'SOFT', 2: 'MED', 3: 'HARD', 4: 'INTER', 5: 'WET' };
const COMPOUND_COLORS = { 0: '#888', 1: '#e10600', 2: '#ffd700', 3: '#ffffff', 4: '#00e676', 5: '#2196f3' };

// Trail configuration for driver glow effect
const TRAIL_CONFIG = [
  { radius: 5, opacity: 0.4 },   // Most recent
  { radius: 4, opacity: 0.25 },
  { radius: 3, opacity: 0.12 },
  { radius: 2, opacity: 0.05 },  // Oldest
];
const TRAIL_LENGTH = TRAIL_CONFIG.length;

export default function TrackMap({ compact = false }) {
  const svgRef = useRef(null);
  const gRef = useRef(null);
  const trailPositionsRef = useRef({}); // { driverAbbr: [{x, y}, ...] } — most recent first
  const isInitialRenderRef = useRef(true);
  const prevFrameIndexRef = useRef(-1); // Track previous frame to detect changes

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

  // Toggle states for sectors and DRS
  const [showSector1, setShowSector1] = useState(true);
  const [showSector2, setShowSector2] = useState(true);
  const [showSector3, setShowSector3] = useState(true);
  const [showDRS, setShowDRS] = useState(true);
  const [showCorners, setShowCorners] = useState(true);

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
        .attr('fill', '#00ff00');

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
    g.append('g').attr('class', 'trails-layer');
    g.append('g').attr('class', 'cars-layer');
    g.append('g').attr('class', 'flag-label-layer');

    const zoom = d3.zoom()
      .scaleExtent([0.5, 8])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    if (!d3.select('body').select('.track-tooltip').size()) {
      d3.select('body').append('div').attr('class', 'tooltip track-tooltip');
    }

    trailPositionsRef.current = {};
    isInitialRenderRef.current = true;
    prevFrameIndexRef.current = -1;
  }, [compact]);

  // Draw track when circuit info loads
  useEffect(() => {
    if (!circuitInfo?.track_coordinates?.length || !gRef.current) return;

    const svg = d3.select(svgRef.current);
    const rect = svgRef.current.parentElement.getBoundingClientRect();
    const width = compact ? (rect.width || 300) : (rect.width || 800);
    const height = compact ? (rect.height || 200) : (rect.height || 500);
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = gRef.current;
    const coords = circuitInfo.track_coordinates;

    const xExtent = d3.extent(coords, (d) => d.X);
    const yExtent = d3.extent(coords, (d) => d.Y);
    const padding = compact ? 30 : 70;
    const trackW = xExtent[1] - xExtent[0];
    const trackH = yExtent[1] - yExtent[0];
    const scale = Math.min((width - padding * 2) / trackW, (height - padding * 2) / trackH);
    // Pixel-to-coordinate conversion — overlays must be positioned in pixel space
    // because track visual width comes from stroke-width (px), not coordinate offsets
    const pxToCoord = 1 / scale;

    const xScale = d3.scaleLinear()
      .domain(xExtent)
      .range([(width - trackW * scale) / 2, (width + trackW * scale) / 2]);
    const yScale = d3.scaleLinear()
      .domain(yExtent)
      .range([(height + trackH * scale) / 2, (height - trackH * scale) / 2]);

    gRef.current.__scales = { xScale, yScale };
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
    const sectorLayer = g.select('.sector-layer');
    sectorLayer.selectAll('*').remove();

    if (coords[0]?.Sector !== undefined) {
      const sectors = d3.group(coords, (d) => d.Sector);
      sectors.forEach((pts, sector) => {
        sectorLayer.append('path')
          .attr('class', `sector-path sector-${sector}`)
          .attr('d', line(pts))
          .attr('fill', 'none')
          .attr('stroke', SECTOR_COLORS[sector] || '#4A5568')
          .attr('stroke-width', 16)
          .attr('stroke-linecap', 'round')
          .attr('stroke-linejoin', 'round')
          .attr('opacity', 0.7);
      });
    } else {
      sectorLayer.append('path')
        .attr('d', line(coords))
        .attr('fill', 'none')
        .attr('stroke', '#4A5568')
        .attr('stroke-width', 16)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round');
    }

    [leftEdge, rightEdge].forEach((edge) => {
      sectorLayer.append('path')
        .attr('class', 'track-edge')
        .attr('d', line(edge));
    });

    // ── DRS Zones — green dashed lines outside the track (broadcast TV style) ──
    const drsOuterLayer = g.select('.drs-outer-layer');
    drsOuterLayer.selectAll('*').remove();
    const drsDetectionLayer = g.select('.drs-detection-layer');
    drsDetectionLayer.selectAll('*').remove();

    const drsZones = circuitInfo.drs_zones || [];
    if (drsZones.length > 0 && !compact) {
      drsZones.forEach((zone, zoneIdx) => {
        const startIdx = zone.start_idx;
        const endIdx = Math.min(zone.end_idx, coords.length - 1);
        const detIdx = zone.detection_idx;

        // DRS activation zone — green dashed line running parallel outside the track
        const outerSegment = [];
        for (let i = startIdx; i <= endIdx; i++) {
          outerSegment.push(drsOuter[i]);
        }
        if (outerSegment.length > 1) {
          drsOuterLayer.append('path')
            .attr('class', 'drs-zone-outer')
            .attr('d', line(outerSegment))
            .attr('fill', 'none')
            .attr('stroke', '#00ff00')
            .attr('stroke-width', 4)
            .attr('stroke-linecap', 'round')
            .attr('stroke-dasharray', '10,5')
            .attr('opacity', 0.9);

          // "DRS" label positioned further outside the DRS line
          const midIdx = Math.floor(outerSegment.length / 2);
          const labelIdx = startIdx + midIdx;
          if (labelIdx < coords.length) {
            const labelOffset = 14 * pxToCoord;
            const lx = xScale(drsOuter[labelIdx].X - tangents[labelIdx].nx * labelOffset);
            const ly = yScale(drsOuter[labelIdx].Y - tangents[labelIdx].ny * labelOffset);
            drsOuterLayer.append('text')
              .attr('x', lx)
              .attr('y', ly)
              .attr('fill', '#00ff00')
              .attr('font-size', '9px')
              .attr('font-weight', '700')
              .attr('font-family', "'Titillium Web', sans-serif")
              .attr('text-anchor', 'middle')
              .attr('dominant-baseline', 'central')
              .text('DRS');
          }
        }

        // Detection line — dashed line crossing perpendicular to the track
        if (detIdx >= 0 && detIdx < coords.length) {
          const detC = coords[detIdx];
          const detT = tangents[detIdx];
          const detExtent = overlayOffset + 6 * pxToCoord;
          drsDetectionLayer.append('line')
            .attr('x1', xScale(detC.X + detT.nx * detExtent))
            .attr('y1', yScale(detC.Y + detT.ny * detExtent))
            .attr('x2', xScale(detC.X - detT.nx * detExtent))
            .attr('y2', yScale(detC.Y - detT.ny * detExtent))
            .attr('stroke', '#00bcd4')
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '4,3')
            .attr('opacity', 0.7);
        }
      });
    }

    // ── Start/Finish Line — thin checkered stripe crossing perpendicular to the track ──
    const sfLayer = g.select('.sf-layer');
    sfLayer.selectAll('*').remove();
    if (coords.length > 4 && tangents.length > 0) {
      const c0 = coords[0];
      const t0 = tangents[0];

      // Perpendicular extent: just beyond the track edges (not as wide as overlay offset)
      const sfExtent = overlayOffset * 0.8;

      // Thin stripe depth along track direction (~4px in screen space)
      const nextC = coords[Math.min(3, coords.length - 1)];
      const fdx = nextC.X - c0.X;
      const fdy = nextC.Y - c0.Y;
      const fLen = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
      const stripeDepth = 3 * pxToCoord;
      const fx = (fdx / fLen) * stripeDepth;
      const fy = (fdy / fLen) * stripeDepth;

      // 4 corners of the thin perpendicular stripe
      const sfPoly = [
        `${xScale(c0.X + t0.nx * sfExtent - fx)},${yScale(c0.Y + t0.ny * sfExtent - fy)}`,
        `${xScale(c0.X - t0.nx * sfExtent - fx)},${yScale(c0.Y - t0.ny * sfExtent - fy)}`,
        `${xScale(c0.X - t0.nx * sfExtent + fx)},${yScale(c0.Y - t0.ny * sfExtent + fy)}`,
        `${xScale(c0.X + t0.nx * sfExtent + fx)},${yScale(c0.Y + t0.ny * sfExtent + fy)}`,
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

      // S/F label outside on the DRS side
      if (!compact) {
        const labelDist = sfExtent + 14 * pxToCoord;
        sfLayer.append('text')
          .attr('x', xScale(c0.X - t0.nx * labelDist))
          .attr('y', yScale(c0.Y - t0.ny * labelDist))
          .attr('fill', '#fff')
          .attr('font-size', '9px')
          .attr('font-weight', '700')
          .attr('font-family', "'Formula1', 'Titillium Web', sans-serif")
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .text('S/F');
      }
    }

    // ── Direction arrowhead (filled triangle, no pole) near S/F ──
    const dirLayer = g.select('.direction-layer');
    dirLayer.selectAll('*').remove();

    if (!compact && coords.length > 20) {
      const chevIdx = Math.max(6, Math.floor(coords.length * 0.02));
      const pt = arrowOuter[Math.min(chevIdx, coords.length - 1)];
      // Track direction at this point (in screen space)
      const cPrev = coords[Math.max(0, chevIdx - 3)];
      const cNext = coords[Math.min(coords.length - 1, chevIdx + 3)];
      const adx = xScale(cNext.X) - xScale(cPrev.X);
      const ady = yScale(cNext.Y) - yScale(cPrev.Y);
      const angleDeg = (Math.atan2(ady, adx) * 180) / Math.PI;
      const cx = xScale(pt.X);
      const cy = yScale(pt.Y);

      // Filled triangle arrowhead pointing in track direction
      dirLayer.append('path')
        .attr('d', 'M -7 -5 L 7 0 L -7 5 Z')
        .attr('transform', `translate(${cx},${cy}) rotate(${angleDeg})`)
        .attr('fill', 'rgba(255,255,255,0.75)')
        .attr('stroke', 'none');
    }

    // ── Corners ──
    if (circuitInfo.corners?.length && !compact) {
      const cornersLayer = g.select('.corners-layer');
      cornersLayer.selectAll('*').remove();
      circuitInfo.corners.forEach((corner) => {
        if (corner.X == null || corner.Y == null) return;
        const cx = xScale(corner.X);
        const cy = yScale(corner.Y);
        const cg = cornersLayer.append('g').attr('transform', `translate(${cx}, ${cy})`);
        cg.append('circle').attr('r', 10).attr('class', 'corner-marker');
        cg.append('text')
          .attr('class', 'corner-label')
          .text(corner.Number || corner.CornerNumber || '');
      });
    }

    isInitialRenderRef.current = true;
  }, [circuitInfo, compact]);

  // Update sector visibility
  useEffect(() => {
    if (!gRef.current) return;
    const sectorLayer = gRef.current.select('.sector-layer');
    sectorLayer.select('.sector-1').attr('opacity', showSector1 ? 0.7 : 0.1);
    sectorLayer.select('.sector-2').attr('opacity', showSector2 ? 0.7 : 0.1);
    sectorLayer.select('.sector-3').attr('opacity', showSector3 ? 0.7 : 0.1);
  }, [showSector1, showSector2, showSector3]);

  useEffect(() => {
    if (!gRef.current) return;
    gRef.current.select('.drs-outer-layer').attr('opacity', showDRS ? 1 : 0);
    gRef.current.select('.drs-detection-layer').attr('opacity', showDRS ? 1 : 0);
  }, [showDRS]);

  useEffect(() => {
    if (!gRef.current) return;
    gRef.current.select('.corners-layer').attr('opacity', showCorners ? 1 : 0);
  }, [showCorners]);

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
        .attr('stroke', FLAG_LABEL_COLORS[currentFlagStatus] || '#fff')
        .attr('stroke-width', 1.5);
      labelLayer.append('text')
        .attr('x', vb[2] / 2)
        .attr('y', 22)
        .attr('text-anchor', 'middle')
        .attr('fill', FLAG_LABEL_COLORS[currentFlagStatus] || '#fff')
        .attr('font-size', '11px')
        .attr('font-weight', '700')
        .attr('font-family', "'Titillium Web', sans-serif")
        .text(label);
    }
  }, [currentFlagStatus]);

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
          color: getDriverColor(abbr),
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
    const { xScale, yScale } = gRef.current.__scales;
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
      else if (drs === 10 || drs === 12 || drs === 14) { drsText = 'ACTIVE'; drsClass = 'drs-on'; }

      return `
        <div class="tooltip-title" style="color:${getDriverColor(abbr)}">${abbr}</div>
        <div class="tooltip-team">${team}</div>
        <div class="tooltip-divider"></div>
        ${gridPos != null ? `<div class="tooltip-row"><span class="tooltip-label">Grid</span><span class="tooltip-value">P${gridPos}</span></div>` : ''}
        <div class="tooltip-row"><span class="tooltip-label">Speed</span><span class="tooltip-value">${typeof speed === 'number' ? speed.toFixed(0) : speed} km/h</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Throttle</span><span class="tooltip-value tooltip-throttle">${typeof throttle === 'number' ? throttle.toFixed(0) : throttle}%</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Brake</span><span class="tooltip-value tooltip-brake">${typeof brake === 'number' ? brake.toFixed(0) : brake}%</span></div>
        <div class="tooltip-row"><span class="tooltip-label">Gear</span><span class="tooltip-value">${typeof gear === 'number' ? Math.round(gear) : gear}</span></div>
        <div class="tooltip-row"><span class="tooltip-label">DRS</span><span class="tooltip-value ${drsClass}">${drsText}</span></div>
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

    const isDriverRetired = (abbr) => {
      const dnf = dnfMap[abbr];
      return dnf && dnf.lastLap <= currentLap;
    };

    const getDimmedOpacity = (abbr) => {
      if (isDriverRetired(abbr)) return 0.2;
      if (abbr === focusDriver) return 1;
      if (selectedDrivers.length > 0 && !selectedDrivers.includes(abbr)) return 0.7;
      if (focusDriver && abbr !== focusDriver && !selectedDrivers.includes(abbr)) return 0.55;
      return 1;
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

    // 2. If no frame data yet, use qualifying grid positions
    if (!driverEntries && gridPositions) {
      isGridMode = true;
      driverEntries = Object.entries(gridPositions);
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
        updateTrailPositions(abbr, xScale(pos.x), yScale(pos.y));
      }
    }

    // Render trails (only when playing and not in grid mode)
    renderTrails(trailsLayer, driverEntries, isPlaying && !isGridMode);

    // Compute transition duration:
    // At 2.5 FPS, frameDt=0.4s. At 1x speed, transition = 400ms (matches tick interval).
    // This makes cars move smoothly between consecutive frames.
    const playSpeedNow = useF1Store.getState().playSpeed || 1;
    const transitionDuration = isPlaying && useTransition
      ? Math.max(16, (frameDt * 1000) / playSpeedNow)
      : (useTransition ? 300 : 0);

    const cars = carsLayer.selectAll('.car-marker').data(driverEntries, (d) => d[0]);

    const enter = cars.enter().append('g').attr('class', 'car-marker');
    enter.append('circle').attr('class', 'car-glow').attr('r', glowRadius).attr('fill', 'currentColor').attr('opacity', 0);
    enter.append('circle').attr('class', 'car-dot').attr('r', dotRadius);
    if (!compact) {
      enter.append('text').attr('class', 'car-label').attr('dx', 12).attr('dy', 4);
    }

    // Grid mode: also show grid position number
    if (isGridMode && !compact) {
      enter.append('text')
        .attr('class', 'car-grid-pos')
        .attr('dx', -12).attr('dy', 4)
        .attr('text-anchor', 'end')
        .attr('fill', 'rgba(255,255,255,0.6)')
        .attr('font-size', '8px')
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
          const x = pos.x != null ? xScale(pos.x) : 0;
          const y = pos.y != null ? yScale(pos.y) : 0;
          return `translate(${x}, ${y})`;
        });
    } else {
      merged
        .attr('transform', (d) => {
          const pos = d[1];
          const x = pos.x != null ? xScale(pos.x) : 0;
          const y = pos.y != null ? yScale(pos.y) : 0;
          return `translate(${x}, ${y})`;
        });
    }

    merged
      .classed('selected', (d) => selectedDrivers.includes(d[0]))
      .classed('dimmed', (d) => selectedDrivers.length > 0 && !selectedDrivers.includes(d[0]))
      .classed('highlighted', (d) => d[0] === highlightedDriver)
      .classed('car-marker--focused', (d) => d[0] === focusDriver)
      .classed('car-marker--retired', (d) => isDriverRetired(d[0]))
      .style('color', (d) => getDriverColor(d[0]))
      .style('opacity', (d) => getDimmedOpacity(d[0]));

    merged.select('.car-dot')
      .attr('fill', (d) => getDriverColor(d[0]))
      .attr('r', (d) => getCarDotRadius(d[0]));

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
      merged.select('.car-label')
        .text((d) => d[0])
        .classed('car-label--focused', (d) => d[0] === focusDriver);

      // Update grid position labels
      if (isGridMode) {
        merged.select('.car-grid-pos')
          .text((d) => d[1].gridPos != null ? `P${d[1].gridPos}` : '');
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
      selectedDrivers, highlightedDriver, focusDriver, gridPositions, dnfMap, currentLap,
      toggleDriver, setHighlightedDriver, isPlaying, compact, dotRadius, glowRadius,
      updateTrailPositions, renderTrails]);

  // ── Telemetry HUD data for focused + selected drivers ──────────────
  const hudDrivers = useMemo(() => {
    const list = [];
    if (focusDriver) list.push(focusDriver);
    selectedDrivers.forEach((d) => { if (!list.includes(d)) list.push(d); });
    // Filter out retired drivers
    return list.filter((d) => !(dnfMap[d] && dnfMap[d].lastLap <= currentLap));
  }, [focusDriver, selectedDrivers, dnfMap, currentLap]);

  const hudDataList = useMemo(() => {
    if (hudDrivers.length === 0 || !frameData?.frames?.length || currentFrameIndex < 0) return [];
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const frame = frameData.frames[idx];
    if (!frame?.drivers) return [];

    return hudDrivers.map((drv) => {
      const d = frame.drivers[drv];
      if (!d) return null;
      const tyreInt = d.tyre ?? 0;
      const drsVal = d.drs;
      let drsText = 'OFF', drsClass = 'hud-drs--off';
      if (drsVal === 8) { drsText = 'AVAIL'; drsClass = 'hud-drs--avail'; }
      else if (drsVal === 10 || drsVal === 12 || drsVal === 14) { drsText = 'ACTIVE'; drsClass = 'hud-drs--on'; }
      return {
        driver: drv,
        isFocused: drv === focusDriver,
        color: getDriverColor(drv),
        speed: typeof d.speed === 'number' ? d.speed.toFixed(0) : '—',
        throttle: typeof d.throttle === 'number' ? d.throttle.toFixed(0) : '—',
        brake: typeof d.brake === 'number' ? d.brake.toFixed(0) : '—',
        gear: typeof d.gear === 'number' ? Math.round(d.gear) : '—',
        drsText, drsClass,
        compound: COMPOUND_NAMES[tyreInt] || 'UNK',
        compoundColor: COMPOUND_COLORS[tyreInt] || '#888',
        tyreLife: d.tyre_life != null ? Math.round(d.tyre_life) : '—',
        lap: d.lap != null ? d.lap : '—',
      };
    }).filter(Boolean);
  }, [hudDrivers, focusDriver, frameData, currentFrameIndex]);

  // Build driver legend
  const driverLegendItems = useMemo(() => {
    const driverList = sessionData?.driver_info || [];
    const displayDrivers = selectedDrivers.length > 0
      ? driverList.filter((d) => selectedDrivers.includes(d.Abbreviation))
      : driverList.slice(0, 10);
    return displayDrivers.map((d) => ({
      label: d.Abbreviation,
      color: getDriverColor(d.Abbreviation),
      shape: 'circle',
      active: selectedDrivers.length === 0 || selectedDrivers.includes(d.Abbreviation),
      onClick: () => toggleDriver(d.Abbreviation),
    }));
  }, [sessionData, selectedDrivers, toggleDriver]);

  const toggleBtnStyle = (active, color) => ({
    padding: '2px 8px',
    fontSize: '10px',
    fontWeight: 700,
    border: `1.5px solid ${active ? color : 'rgba(255,255,255,0.2)'}`,
    borderRadius: '4px',
    background: active ? `${color}22` : 'transparent',
    color: active ? color : 'rgba(255,255,255,0.4)',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    fontFamily: "'Titillium Web', sans-serif",
    letterSpacing: '0.04em',
    lineHeight: '18px',
  });

  const controls = (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      <button style={toggleBtnStyle(showSector1, SECTOR_COLORS[1])} onClick={() => setShowSector1(!showSector1)}>S1</button>
      <button style={toggleBtnStyle(showSector2, SECTOR_COLORS[2])} onClick={() => setShowSector2(!showSector2)}>S2</button>
      <button style={toggleBtnStyle(showSector3, SECTOR_COLORS[3])} onClick={() => setShowSector3(!showSector3)}>S3</button>
      <button style={toggleBtnStyle(showDRS, '#00ff00')} onClick={() => setShowDRS(!showDRS)}>DRS</button>
      <button style={toggleBtnStyle(showCorners, '#aaa')} onClick={() => setShowCorners(!showCorners)}>Corners</button>
      {driverLegendItems.length > 0 && (
        <div style={{ marginLeft: 8, borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 8 }}>
          <Legend items={driverLegendItems} shape="circle" />
        </div>
      )}
    </div>
  );

  if (compact) {
    return (
      <div
        className="viz-container track-map-compact"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(26,31,51,0.6) 0%, rgba(21,21,30,0.9) 100%)',
          borderRadius: '8px',
          width: '100%',
          height: '100%',
          maxWidth: '300px',
          maxHeight: '200px',
        }}
      >
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
    );
  }

  // Race finish + winner detection
  const raceFinished = currentLap >= maxLap && maxLap > 1;
  const winnerAbbr = useMemo(() => {
    if (!raceFinished || !sessionData?.race_results?.length) return null;
    const sorted = [...sessionData.race_results].sort(
      (a, b) => (a.Position || 99) - (b.Position || 99)
    );
    return sorted[0]?.Abbreviation || null;
  }, [raceFinished, sessionData]);
  const winnerColor = winnerAbbr ? getDriverColor(winnerAbbr) : null;

  const isHazardActive = currentFlagStatus && currentFlagStatus !== '1';
  const hazardColor = FLAG_COLORS[currentFlagStatus] || 'transparent';

  const panelStyle = raceFinished && winnerColor
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
        '--hazard-color': hazardColor,
        '--hazard-color-bright': hazardColor,
        '--hazard-color-dim': `${hazardColor}44`,
        border: isHazardActive
          ? `3px solid ${hazardColor}`
          : '2px solid rgba(255, 255, 255, 0.12)',
        boxShadow: isHazardActive
          ? `0 0 16px ${hazardColor}44`
          : '0 4px 30px rgba(0, 0, 0, 0.3)',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
        animation: isHazardActive ? 'hazard-border-pulse 1.2s ease-in-out infinite' : 'none',
      };

  return (
    <Panel title="Track Map" controls={controls} style={panelStyle}>
      <div className="viz-container" style={{
        background: 'radial-gradient(ellipse at center, rgba(26,31,51,0.6) 0%, rgba(21,21,30,0.9) 100%)',
        borderRadius: '8px',
        position: 'relative',
      }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />

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
            border: `2px solid ${winnerColor}88`,
            borderRadius: 8,
            boxShadow: `0 0 16px ${winnerColor}33`,
            animation: 'winner-banner-glow 2s ease-in-out infinite',
          }}>
            <span style={{
              width: 4,
              height: 20,
              borderRadius: 2,
              background: winnerColor,
            }} />
            <span style={{
              fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              fontWeight: 900,
              fontSize: '13px',
              letterSpacing: '0.15em',
              color: '#fff',
            }}>
              CHEQUERED FLAG
            </span>
            <span style={{
              fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              fontWeight: 900,
              fontSize: '14px',
              color: winnerColor,
              letterSpacing: '0.08em',
            }}>
              {(() => {
                const info = (drivers || []).find((d) => d.Abbreviation === winnerAbbr);
                return info?.FullName?.toUpperCase() || winnerAbbr;
              })()} WINS
            </span>
          </div>
        )}

        {/* Telemetry HUD overlays — one per selected/focused driver */}
        {hudDataList.length > 0 && (
          <div className="track-telemetry-hud-container">
            {hudDataList.map((hud) => (
              <div
                key={hud.driver}
                className={`track-telemetry-hud ${hud.isFocused ? 'track-telemetry-hud--focused' : ''}`}
                style={{ borderColor: `${hud.color}88`, boxShadow: `0 0 8px ${hud.color}22` }}
              >
                <div className="track-telemetry-hud__header">
                  <span className="track-telemetry-hud__driver" style={{ color: hud.color }}>
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
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">DRS</span>
                  <span className={`track-telemetry-hud__value ${hud.drsClass}`}>{hud.drsText}</span>
                </div>
                <div className="track-telemetry-hud__row">
                  <span className="track-telemetry-hud__label">TYRE</span>
                  <span className="track-telemetry-hud__value">
                    <span className="track-telemetry-hud__tyre-dot" style={{ background: hud.compoundColor }} />
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
