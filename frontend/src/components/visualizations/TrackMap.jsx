import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import { estimateFromFramePositions } from '../../utils/trackPositionEstimator';
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
const COMPOUND_COLORS = { 0: '#888', 1: '#FF3333', 2: '#FFC300', 3: '#FFFFFF', 4: '#39B54A', 5: '#0067FF' };

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
  const zoomRef = useRef(null);
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

  // Track overlay toggles — synced with store for keyboard shortcuts
  const showTrackSectors = useF1Store((s) => s.showTrackSectors);
  const showTrackDRS = useF1Store((s) => s.showTrackDRS);

  // Track rotation
  const trackRotationOffset = useF1Store((s) => s.trackRotationOffset);
  const rotateTrackCW = useF1Store((s) => s.rotateTrackCW);
  const rotateTrackCCW = useF1Store((s) => s.rotateTrackCCW);
  const resetTrackRotation = useF1Store((s) => s.resetTrackRotation);

  // Individual sector toggles (local refinement)
  const [showSector1, setShowSector1] = useState(true);
  const [showSector2, setShowSector2] = useState(true);
  const [showSector3, setShowSector3] = useState(true);
  const [showDRS, setShowDRS] = useState(true);
  const [showCorners, setShowCorners] = useState(true);

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
    const rect = svgRef.current.parentElement.getBoundingClientRect();
    const width = compact ? (rect.width || 300) : (rect.width || 800);
    const height = compact ? (rect.height || 200) : (rect.height || 500);
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = gRef.current;
    const rawCoords = circuitInfo.track_coordinates;

    // Apply FastF1 rotation to match official track map orientation
    const rotationDeg = (circuitInfo.rotation || 0) + trackRotationOffset;
    const rotationRad = (rotationDeg * Math.PI) / 180;
    const cosR = Math.cos(rotationRad);
    const sinR = Math.sin(rotationRad);

    // Compute centroid for rotation pivot
    const cx = rawCoords.reduce((s, d) => s + d.X, 0) / rawCoords.length;
    const cy = rawCoords.reduce((s, d) => s + d.Y, 0) / rawCoords.length;

    const coords = rawCoords.map((d) => {
      const dx = d.X - cx;
      const dy = d.Y - cy;
      return { ...d, X: cx + dx * cosR - dy * sinR, Y: cy + dx * sinR + dy * cosR };
    });

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
            .attr('fill', 'rgba(0, 200, 0, 0.18)')
            .attr('stroke', 'none');

          // Thin edge lines on both sides
          drsOuterLayer.append('path')
            .attr('d', line(leftPts))
            .attr('fill', 'none')
            .attr('stroke', '#00cc00')
            .attr('stroke-width', 1.5)
            .attr('opacity', 0.6);
          drsOuterLayer.append('path')
            .attr('d', line(rightPts))
            .attr('fill', 'none')
            .attr('stroke', '#00cc00')
            .attr('stroke-width', 1.5)
            .attr('opacity', 0.6);

          // Tick marks at start and end boundaries
          [startIdx, endIdx].forEach(idx => {
            if (idx < coords.length) {
              drsOuterLayer.append('line')
                .attr('x1', xScale(leftEdge[idx].X))
                .attr('y1', yScale(leftEdge[idx].Y))
                .attr('x2', xScale(rightEdge[idx].X))
                .attr('y2', yScale(rightEdge[idx].Y))
                .attr('stroke', '#00cc00')
                .attr('stroke-width', 2)
                .attr('opacity', 0.8);
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
              .attr('fill', '#00cc00')
              .attr('font-size', '8px')
              .attr('font-weight', '700')
              .attr('font-family', "'Space Grotesk', sans-serif")
              .attr('text-anchor', 'middle')
              .attr('dominant-baseline', 'central')
              .attr('opacity', 0.8)
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
            .attr('stroke', '#00bcd4')
            .attr('stroke-width', 1.5)
            .attr('stroke-dasharray', '3,2')
            .attr('opacity', 0.6);
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
  }, [circuitInfo, compact, trackRotationOffset]);

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

    // 1b. Live mode: estimate positions when x,y are null
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
          if (pos.x == null || pos.y == null) return 'translate(-9999,-9999)';
          const rp = rotatePos(pos.x, pos.y);
          return `translate(${xScale(rp.x)}, ${yScale(rp.y)})`;
        });
    } else {
      merged
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
      updateTrailPositions, renderTrails, trackRotationOffset]);

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

  const zoomBtnStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    border: '1.5px solid rgba(255,255,255,0.2)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'rgba(255,255,255,0.5)',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  };

  const rotateBtnStyle = {
    ...zoomBtnStyle,
    fontSize: '11px',
    fontWeight: 600,
    fontFamily: "'Space Grotesk', sans-serif",
  };

  const controls = (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      <button style={zoomBtnStyle} onClick={rotateTrackCW} title="Rotate clockwise (R)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
      </button>
      <button style={zoomBtnStyle} onClick={rotateTrackCCW} title="Rotate counter-clockwise (Shift+R)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <button style={{ ...rotateBtnStyle, width: 'auto', padding: '0 6px' }} onClick={resetTrackRotation} title="Reset to default orientation">
        Auto
      </button>
      <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
      <button style={zoomBtnStyle} onClick={handleZoomIn} title="Zoom in">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button style={zoomBtnStyle} onClick={handleZoomOut} title="Zoom out">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/></svg>
      </button>
      <button style={zoomBtnStyle} onClick={handleZoomReset} title="Reset zoom">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
      <button style={toggleBtnStyle(showSector1, SECTOR_COLORS[1])} onClick={() => setShowSector1(!showSector1)}>S1</button>
      <button style={toggleBtnStyle(showSector2, SECTOR_COLORS[2])} onClick={() => setShowSector2(!showSector2)}>S2</button>
      <button style={toggleBtnStyle(showSector3, SECTOR_COLORS[3])} onClick={() => setShowSector3(!showSector3)}>S3</button>
      <button style={toggleBtnStyle(showDRS, '#00cc00')} onClick={() => setShowDRS(!showDRS)}>DRS</button>
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
          position: 'relative',
        }}
      >
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {isLiveMode && (!frameData?.frames?.length) && (
          <div style={{
            position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, padding: '2px 8px', borderRadius: 3,
            background: 'rgba(0,0,0,0.6)', fontSize: 8, color: '#777', whiteSpace: 'nowrap',
          }}>
            No live positions
          </div>
        )}
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
    <Panel title="Track Map" controls={controls} style={panelStyle} focused={focusedView === 'trackmap'} shortcutKey="1">
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

        {/* Live mode: no position data available */}
        {isLiveMode && (!frameData?.frames?.length) && (
          <div style={{
            position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, padding: '3px 10px', borderRadius: 4,
            background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.08)',
            fontSize: 9, color: '#888', letterSpacing: '0.04em', whiteSpace: 'nowrap',
          }}>
            Live car positions unavailable — timing data active
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
