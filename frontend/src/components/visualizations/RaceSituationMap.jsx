import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { FEATURE_LABELS } from '../../utils/raceSituationFeatures';
import { attachLasso } from '../../utils/lasso';
import Panel from '../ui/Panel';

const COMPOUND_COLORS = {
  SOFT: TYRE_COLORS?.SOFT || '#e10600',
  MEDIUM: TYRE_COLORS?.MEDIUM || '#ffd700',
  HARD: TYRE_COLORS?.HARD || '#FFFFFF',
  INTERMEDIATE: TYRE_COLORS?.INTERMEDIATE || '#00e676',
  WET: TYRE_COLORS?.WET || '#2196f3',
  UNKNOWN: '#888',
};

const MAX_TRAIL_LENGTH = 20; // number of past positions to store per driver
const SMOOTHING_ALPHA = 0.35; // exponential smoothing factor (0 = fully smooth, 1 = no smoothing)
const JUMP_THRESHOLD = 2.5; // PCA-space distance beyond which smoothing kicks in

export default function RaceSituationMap() {
  const svgRef = useRef(null);
  const cleanupRef = useRef(null);
  const trajectoryRef = useRef({}); // { driverAbbr: [{x, y, lap}, ...] }
  const lastTrailLapRef = useRef(null); // track the lap we last added to trails
  const smoothedPositionsRef = useRef({}); // { driverAbbr: {x, y} } for exponential smoothing

  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const computeRaceSituation = useF1Store((s) => s.computeRaceSituation);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const driversInfo = useF1Store((s) => s.drivers);

  // Trigger computation on mount + lap changes
  useEffect(() => {
    computeRaceSituation();
  }, [currentLap, computeRaceSituation]);

  // Build driver info map
  const driverInfoMap = useMemo(() => {
    const map = {};
    for (const d of driversInfo || []) {
      map[d.Abbreviation] = d;
    }
    return map;
  }, [driversInfo]);

  // Update trajectory history when PCA data changes
  useEffect(() => {
    if (!raceSituationData) return;
    const { driverAbbrs, scores, computedAtLap } = raceSituationData;

    // Only add to trail if this is a new lap computation
    if (lastTrailLapRef.current === computedAtLap) return;

    const history = trajectoryRef.current;

    // If user rewound, trim future trail points to avoid confusing paths
    if (lastTrailLapRef.current != null && computedAtLap < lastTrailLapRef.current) {
      for (const abbr of Object.keys(history)) {
        history[abbr] = (history[abbr] || []).filter((pt) => pt.lap <= computedAtLap);
      }
    }

    lastTrailLapRef.current = computedAtLap;

    driverAbbrs.forEach((abbr, i) => {
      if (!history[abbr]) history[abbr] = [];
      // Avoid duplicate entries for the same lap
      const last = history[abbr][history[abbr].length - 1];
      if (last && last.lap === computedAtLap) {
        last.x = scores[i].x;
        last.y = scores[i].y;
      } else {
        history[abbr].push({ x: scores[i].x, y: scores[i].y, lap: computedAtLap });
      }
      // Trim to max length
      if (history[abbr].length > MAX_TRAIL_LENGTH) {
        history[abbr] = history[abbr].slice(-MAX_TRAIL_LENGTH);
      }
    });
  }, [raceSituationData]);

  // Main D3 render — uses update pattern for animated transitions
  useEffect(() => {
    if (!svgRef.current || !raceSituationData) return;

    const data = raceSituationData;
    const { driverAbbrs, scores, loadings, explainedVariance, driverFeatures, computedAtLap } = data;

    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 500;
    const height = rect.height || 400;
    const margin = { top: 20, right: 20, bottom: 42, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    // Check if this is an update (main group already exists)
    const isUpdate = svg.select('.situation-main').size() > 0;

    let g;
    if (!isUpdate) {
      // ── First render: create static elements ──
      svg.selectAll('*').remove();

      // Defs for arrow markers
      const defs = svg.append('defs');
      defs.append('marker')
        .attr('id', 'sit-arrow')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 8).attr('refY', 5)
        .attr('markerWidth', 5).attr('markerHeight', 5)
        .attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M 0 2 L 8 5 L 0 8 Z')
        .attr('fill', 'rgba(100,200,255,0.55)');

      g = svg.append('g')
        .attr('class', 'situation-main')
        .attr('transform', `translate(${margin.left},${margin.top})`);

      // Create layer groups in render order
      g.append('g').attr('class', 'grid-layer');
      g.append('g').attr('class', 'crosshair-layer');
      g.append('g').attr('class', 'arrows-layer');
      g.append('g').attr('class', 'trails-layer');
      g.append('g').attr('class', 'tyre-layer');
      g.append('g').attr('class', 'points-layer');
      g.append('g').attr('class', 'labels-layer');
      g.append('g').attr('class', 'rings-layer');
      g.append('g').attr('class', 'info-layer');
    } else {
      g = svg.select('.situation-main');
    }

    // ── Scales (include trail history for stable framing) ──
    const history = trajectoryRef.current;
    let allX = scores.map((d) => d.x);
    let allY = scores.map((d) => d.y);
    for (const abbr of driverAbbrs) {
      const trail = history[abbr];
      if (trail) {
        for (const pt of trail) {
          allX.push(pt.x);
          allY.push(pt.y);
        }
      }
    }
    const fullXExtent = d3.extent(allX);
    const fullYExtent = d3.extent(allY);
    const xPad = Math.max(0.5, (fullXExtent[1] - fullXExtent[0]) * 0.15);
    const yPad = Math.max(0.5, (fullYExtent[1] - fullYExtent[0]) * 0.15);

    const x = d3.scaleLinear().domain([fullXExtent[0] - xPad, fullXExtent[1] + xPad]).range([0, innerW]);
    const y = d3.scaleLinear().domain([fullYExtent[0] - yPad, fullYExtent[1] + yPad]).range([innerH, 0]);

    const t = d3.transition().duration(600).ease(d3.easeCubicInOut);

    // ── Grid (rebuild on scale changes) ──
    const gridLayer = g.select('.grid-layer');
    gridLayer.selectAll('*').remove();

    gridLayer.append('g').attr('class', 'x-grid')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat(''))
      .call((el) => el.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
      .call((el) => el.select('.domain').remove());

    gridLayer.append('g').attr('class', 'y-grid')
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''))
      .call((el) => el.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
      .call((el) => el.select('.domain').remove());

    // ── Crosshair at origin (field average) ──
    const crosshairLayer = g.select('.crosshair-layer');
    crosshairLayer.selectAll('*').remove();
    const ox = x(0), oy = y(0);
    if (ox > 0 && ox < innerW && oy > 0 && oy < innerH) {
      crosshairLayer.append('line').attr('x1', ox).attr('y1', 0).attr('x2', ox).attr('y2', innerH)
        .attr('stroke', 'rgba(255,255,255,0.08)').attr('stroke-dasharray', '3,5');
      crosshairLayer.append('line').attr('x1', 0).attr('y1', oy).attr('x2', innerW).attr('y2', oy)
        .attr('stroke', 'rgba(255,255,255,0.08)').attr('stroke-dasharray', '3,5');
      crosshairLayer.append('text').attr('x', ox + 4).attr('y', oy - 6)
        .attr('fill', 'rgba(255,255,255,0.2)').attr('font-size', '8px')
        .attr('font-style', 'italic').text('field avg');
    }

    // ── Loading arrows (biplot vectors — top 6 features) ──
    const arrowsLayer = g.select('.arrows-layer');
    arrowsLayer.selectAll('*').remove();
    const topLoadings = loadings.slice(0, 6);
    const maxMag = Math.max(...topLoadings.map((l) => Math.sqrt(l.pc1 ** 2 + l.pc2 ** 2)));
    const arrowScale = Math.min(innerW, innerH) * 0.32 / (maxMag || 1);

    topLoadings.forEach((l) => {
      const dx = l.pc1 * arrowScale;
      const dy = -l.pc2 * arrowScale;
      const endX = ox + dx, endY = oy + dy;
      if (endX < -10 || endX > innerW + 10 || endY < -10 || endY > innerH + 10) return;

      arrowsLayer.append('line')
        .attr('x1', ox).attr('y1', oy).attr('x2', endX).attr('y2', endY)
        .attr('stroke', 'rgba(100,200,255,0.35)').attr('stroke-width', 1.2)
        .attr('marker-end', 'url(#sit-arrow)');

      const labelX = endX + (dx > 0 ? 5 : -5);
      const labelY = endY + (dy > 0 ? 12 : -5);
      const labelText = FEATURE_LABELS[l.feature] || l.feature;
      const labelAnchor = dx > 0 ? 'start' : 'end';

      arrowsLayer.append('text')
        .attr('x', labelX).attr('y', labelY)
        .attr('text-anchor', labelAnchor)
        .attr('fill', 'rgba(100,200,255,0.7)')
        .attr('font-size', '8.5px').attr('font-weight', 600)
        .attr('paint-order', 'stroke')
        .attr('stroke', 'rgba(0,0,0,0.6)').attr('stroke-width', 3)
        .attr('stroke-linejoin', 'round')
        .text(labelText);
    });

    // ── Build point data with exponential smoothing for large jumps ──
    const smoothed = smoothedPositionsRef.current;
    const pointData = driverAbbrs.map((abbr, i) => {
      const raw = scores[i];
      let sx = raw.x, sy = raw.y;

      if (smoothed[abbr]) {
        const dx = raw.x - smoothed[abbr].x;
        const dy = raw.y - smoothed[abbr].y;
        const jumpDist = Math.sqrt(dx * dx + dy * dy);
        if (jumpDist > JUMP_THRESHOLD) {
          // Large jump: blend toward new position with exponential smoothing
          sx = smoothed[abbr].x + SMOOTHING_ALPHA * dx;
          sy = smoothed[abbr].y + SMOOTHING_ALPHA * dy;
        }
      }
      smoothed[abbr] = { x: sx, y: sy };

      return {
        abbr,
        x: sx,
        y: sy,
        ...driverFeatures[abbr],
        teamName: driverInfoMap[abbr]?.TeamName || 'Unknown',
      };
    });

    const isSelected = (d) => selectedDrivers.includes(d.abbr);
    const isDimmed = (d) => selectedDrivers.length > 0 && !isSelected(d);

    // ── Trajectory trails (rebuild from ref — no transition needed) ──
    const trailsLayer = g.select('.trails-layer');
    trailsLayer.selectAll('*').remove();

    for (const d of pointData) {
      const trail = history[d.abbr];
      if (!trail || trail.length < 2) continue;

      const selected = isSelected(d);
      const dimmed = isDimmed(d);
      const highlighted = d.abbr === highlightedDriver || d.abbr === focusDriver;
      const driverColor = getDriverColor(d.abbr);
      const showFull = selected || highlighted;
      const showMinimal = dimmed;

      // Trail line segments
      for (let i = 1; i < trail.length; i++) {
        const fromPt = trail[i - 1];
        const toPt = trail[i];
        const progress = i / trail.length;
        let opacity, strokeW;

        if (showFull) {
          opacity = 0.2 + progress * 0.55;
          strokeW = 1.5 + progress * 2;
        } else if (showMinimal) {
          opacity = 0.03 + progress * 0.05;
          strokeW = 0.5;
        } else {
          opacity = 0.06 + progress * 0.22;
          strokeW = 0.8 + progress * 0.9;
        }

        trailsLayer.append('line')
          .attr('x1', x(fromPt.x)).attr('y1', y(fromPt.y))
          .attr('x2', x(toPt.x)).attr('y2', y(toPt.y))
          .attr('stroke', driverColor)
          .attr('stroke-width', strokeW)
          .attr('stroke-opacity', opacity)
          .attr('stroke-linecap', 'round')
          .attr('pointer-events', 'none');
      }

      // Trail dots with lap labels for focused/selected drivers
      if (!showMinimal) {
        for (let i = 0; i < trail.length - 1; i++) {
          const pt = trail[i];
          const progress = (i + 1) / trail.length;
          const dotOpacity = showFull ? 0.2 + progress * 0.5 : 0.06 + progress * 0.15;
          const dotR = showFull ? 2 + progress * 2 : 1 + progress * 0.8;

          trailsLayer.append('circle')
            .attr('cx', x(pt.x)).attr('cy', y(pt.y))
            .attr('r', dotR)
            .attr('fill', driverColor)
            .attr('opacity', dotOpacity)
            .attr('pointer-events', 'none');

          // Lap number labels on trail dots (every 3rd dot for readability, or all if short trail)
          if (showFull && pt.lap != null && (trail.length <= 8 || i % 3 === 0)) {
            trailsLayer.append('text')
              .attr('x', x(pt.x)).attr('y', y(pt.y) - dotR - 3)
              .attr('text-anchor', 'middle')
              .attr('font-size', '6px').attr('font-weight', 600)
              .attr('fill', driverColor)
              .attr('opacity', 0.3 + progress * 0.5)
              .attr('pointer-events', 'none')
              .attr('paint-order', 'stroke')
              .attr('stroke', 'rgba(0,0,0,0.6)').attr('stroke-width', 2)
              .attr('stroke-linejoin', 'round')
              .text(`L${pt.lap}`);
          }
        }
      }

      // Direction arrow on most recent trail segment
      if (trail.length >= 2 && !showMinimal) {
        const prev = trail[trail.length - 2];
        const curr = trail[trail.length - 1];
        const adx = x(curr.x) - x(prev.x);
        const ady = y(curr.y) - y(prev.y);
        const dist = Math.sqrt(adx * adx + ady * ady);
        if (dist > 5) {
          const midX = x(prev.x) + adx * 0.65;
          const midY = y(prev.y) + ady * 0.65;
          const angle = Math.atan2(ady, adx) * 180 / Math.PI;
          trailsLayer.append('polygon')
            .attr('points', '0,-3.5 8,0 0,3.5')
            .attr('transform', `translate(${midX},${midY}) rotate(${angle})`)
            .attr('fill', driverColor)
            .attr('opacity', showFull ? 0.6 : 0.25)
            .attr('pointer-events', 'none');
        }
      }
    }

    // ── Tyre indicators — animated with D3 join ──
    const tyreLayer = g.select('.tyre-layer');
    tyreLayer.selectAll('.tyre-dot').data(pointData, (d) => d.abbr)
      .join(
        (enter) => enter.append('circle')
          .attr('class', 'tyre-dot')
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y) + 14)
          .attr('r', 0)
          .attr('fill', (d) => COMPOUND_COLORS[d.compoundName] || '#888')
          .attr('stroke', 'rgba(0,0,0,0.4)').attr('stroke-width', 0.5)
          .attr('opacity', (d) => isDimmed(d) ? 0.25 : 1)
          .attr('pointer-events', 'none')
          .call((e) => e.transition(t).attr('r', 3.5)),
        (update) => update
          .call((u) => u.transition(t)
            .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y) + 14)
            .attr('fill', (d) => COMPOUND_COLORS[d.compoundName] || '#888')
            .attr('opacity', (d) => isDimmed(d) ? 0.25 : 1)),
        (exit) => exit.transition(t).attr('r', 0).remove()
      );

    // ── Main driver circles — animated with D3 join ──
    const pointsLayer = g.select('.points-layer');
    pointsLayer.selectAll('.driver-point').data(pointData, (d) => d.abbr)
      .join(
        (enter) => enter.append('circle')
          .attr('class', 'driver-point')
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y))
          .attr('r', 0)
          .attr('fill', (d) => getDriverColor(d.abbr))
          .attr('stroke', (d) => isSelected(d) ? '#fff' : 'rgba(0,0,0,0.3)')
          .attr('stroke-width', (d) => isSelected(d) ? 2 : 1)
          .attr('opacity', (d) => isDimmed(d) ? 0.3 : 1)
          .attr('cursor', 'pointer')
          .call((e) => e.transition(t).attr('r', 10)),
        (update) => update
          .call((u) => u.transition(t)
            .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y))
            .attr('stroke', (d) => isSelected(d) ? '#fff' : 'rgba(0,0,0,0.3)')
            .attr('stroke-width', (d) => isSelected(d) ? 2 : 1)
            .attr('opacity', (d) => isDimmed(d) ? 0.3 : 1)),
        (exit) => exit.transition(t).attr('r', 0).remove()
      )
      .on('mouseenter', function (event, d) {
        setHighlightedDriver(d.abbr);
        d3.select(this).transition().duration(150).attr('r', 13);

        const tooltip = d3.select('body').selectAll('.situation-tooltip').data([0]).join('div')
          .attr('class', 'tooltip situation-tooltip');

        const trend = d.paceTrend > 0.05 ? `+${d.paceTrend.toFixed(2)}s/lap (slower)` :
          d.paceTrend < -0.05 ? `${d.paceTrend.toFixed(2)}s/lap (faster)` : 'stable';

        const trailLen = history[d.abbr]?.length || 0;

        tooltip.html(
          `<div class="tooltip-title" style="color:${getDriverColor(d.abbr)}">` +
          `${d.abbr} — P${d.position}</div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Team</span><span class="tooltip-value">${d.teamName}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pace</span><span class="tooltip-value">${d.recentPace?.toFixed(1)}s</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Trend</span><span class="tooltip-value">${trend}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Tyre</span><span class="tooltip-value">${d.compoundName} (${d.tyreLife} laps)</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Stint</span><span class="tooltip-value">#${d.stintNumber}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Est. pit in</span><span class="tooltip-value">~${d.estLapsToPit} laps</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pred. pace +5</span><span class="tooltip-value">${d.predictedPace5?.toFixed(1)}s</span></div>` +
          (trailLen > 1 ? `<div class="tooltip-row"><span class="tooltip-label">Trail</span><span class="tooltip-value">${trailLen} snapshots</span></div>` : '')
        ).style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', function () {
        setHighlightedDriver(null);
        d3.select(this).transition().duration(150).attr('r', 10);
        d3.select('.situation-tooltip').classed('visible', false).style('opacity', 0);
      })
      .on('click', (event, d) => {
        event.stopPropagation();
        toggleDriver(d.abbr);
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation();
        setFocusDriver(d.abbr);
      });

    // ── Driver labels with collision avoidance — animated ──
    const labelPositions = pointData.map((d) => ({
      abbr: d.abbr,
      cx: x(d.x),
      cy: y(d.y),
      lx: x(d.x),
      ly: y(d.y),
      anchor: 'middle',
    }));

    for (let i = 0; i < labelPositions.length; i++) {
      for (let j = i + 1; j < labelPositions.length; j++) {
        const a = labelPositions[i];
        const b = labelPositions[j];
        const ddx = a.cx - b.cx;
        const ddy = a.cy - b.cy;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist < 18) {
          if (a.cy <= b.cy) {
            b.ly = b.cy + 6;
            a.ly = a.cy - 5;
          } else {
            a.ly = a.cy + 6;
            b.ly = b.cy - 5;
          }
        }
      }
    }

    const labelsLayer = g.select('.labels-layer');
    labelsLayer.selectAll('.situation-label').data(labelPositions, (d) => d.abbr)
      .join(
        (enter) => enter.append('text')
          .attr('class', 'situation-label')
          .attr('x', (d) => d.lx).attr('y', (d) => d.ly)
          .text((d) => d.abbr)
          .attr('font-size', '7.5px').attr('font-weight', 700)
          .attr('fill', '#fff').attr('text-anchor', (d) => d.anchor)
          .attr('dominant-baseline', 'central')
          .attr('pointer-events', 'none')
          .attr('paint-order', 'stroke')
          .attr('stroke', 'rgba(0,0,0,0.7)').attr('stroke-width', 2.5)
          .attr('stroke-linejoin', 'round')
          .attr('opacity', 0)
          .call((e) => e.transition(t).attr('opacity', (d) => {
            const pd = pointData.find((p) => p.abbr === d.abbr);
            return pd && isDimmed(pd) ? 0.3 : 1;
          })),
        (update) => update
          .call((u) => u.transition(t)
            .attr('x', (d) => d.lx).attr('y', (d) => d.ly)
            .attr('opacity', (d) => {
              const pd = pointData.find((p) => p.abbr === d.abbr);
              return pd && isDimmed(pd) ? 0.3 : 1;
            })),
        (exit) => exit.transition(t).attr('opacity', 0).remove()
      );

    // ── Rings layer (focus + highlight — rebuild each frame) ──
    const ringsLayer = g.select('.rings-layer');
    ringsLayer.selectAll('*').remove();

    if (focusDriver) {
      const fd = pointData.find((d) => d.abbr === focusDriver);
      if (fd) {
        ringsLayer.append('circle').attr('class', 'situation-focus-ring')
          .attr('cx', x(fd.x)).attr('cy', y(fd.y))
          .attr('r', 14);
      }
    }

    if (highlightedDriver && highlightedDriver !== focusDriver) {
      const hd = pointData.find((d) => d.abbr === highlightedDriver);
      if (hd) {
        ringsLayer.append('circle').attr('class', 'situation-highlight-ring')
          .attr('cx', x(hd.x)).attr('cy', y(hd.y))
          .attr('r', 14).attr('fill', 'none')
          .attr('stroke', '#fff').attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '3,2').attr('opacity', 0.7)
          .attr('pointer-events', 'none');
      }
    }

    // ── Info layer (lap indicator, axis labels, selection count, help text) ──
    const infoLayer = g.select('.info-layer');
    infoLayer.selectAll('*').remove();

    const pc1Pct = explainedVariance[0] ? `${(explainedVariance[0] * 100).toFixed(0)}%` : '';
    const pc2Pct = explainedVariance[1] ? `${(explainedVariance[1] * 100).toFixed(0)}%` : '';

    const topPC1 = [...loadings].sort((a, b) => Math.abs(b.pc1) - Math.abs(a.pc1)).slice(0, 2);
    const topPC2 = [...loadings].sort((a, b) => Math.abs(b.pc2) - Math.abs(a.pc2)).slice(0, 2);
    const pc1Desc = topPC1.map((l) => FEATURE_LABELS[l.feature] || l.feature).join(' / ');
    const pc2Desc = topPC2.map((l) => FEATURE_LABELS[l.feature] || l.feature).join(' / ');

    infoLayer.append('text').attr('class', 'axis-label-x')
      .attr('x', innerW / 2).attr('y', innerH + 34)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.5)')
      .attr('font-size', '10px').attr('font-weight', 600)
      .text(`PC1: ${pc1Desc} (${pc1Pct})`);

    infoLayer.append('text').attr('class', 'axis-label-y')
      .attr('transform', `translate(-38, ${innerH / 2}) rotate(-90)`)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.5)')
      .attr('font-size', '10px').attr('font-weight', 600)
      .text(`PC2: ${pc2Desc} (${pc2Pct})`);

    infoLayer.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 20)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--color-text-muted)').attr('font-size', 8)
      .text('Click driver to select | Shift+drag to lasso | Dbl-click to focus');

    infoLayer.append('text').attr('class', 'lap-indicator')
      .attr('x', innerW - 4).attr('y', 12)
      .attr('text-anchor', 'end')
      .attr('fill', '#00e676').attr('font-size', '10px').attr('font-weight', 700)
      .text(`Lap ${computedAtLap}`);

    if (selectedDrivers.length > 0) {
      infoLayer.append('text').attr('class', 'sel-count')
        .attr('x', innerW - 4).attr('y', 26)
        .attr('text-anchor', 'end')
        .attr('fill', 'var(--color-f1-red)').attr('font-size', '9px').attr('font-weight', 700)
        .text(`${selectedDrivers.length} selected`);
    }

    // ── Lasso ──
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = attachLasso(g, {
      getPoints: () =>
        pointData.map((d) => ({ x: x(d.x), y: y(d.y), id: d.abbr })),
      onSelect: (ids) => {
        setSelectedDrivers(ids);
      },
    });

  }, [raceSituationData, selectedDrivers, highlightedDriver, focusDriver, driverInfoMap, setSelectedDrivers, toggleDriver, setHighlightedDriver, setFocusDriver]);

  // Cleanup on unmount
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  // Reset trajectory when session changes
  const sessionKey = useF1Store((s) => s.sessionData?.session_info?.year + '-' + s.sessionData?.session_info?.round);
  useEffect(() => {
    trajectoryRef.current = {};
    lastTrailLapRef.current = null;
    smoothedPositionsRef.current = {};
  }, [sessionKey]);

  return (
    <Panel title={`Race Situation ${raceSituationData?.computedAtLap ? `— Lap ${raceSituationData.computedAtLap}` : ''}`}>
      <div className="viz-container">
        {raceSituationData ? (
          <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        ) : currentLap < 3 ? (
          <div className="loading-placeholder">
            <span style={{ color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
              Waiting for lap 3 to build race situation map...
            </span>
          </div>
        ) : (
          <div className="loading-placeholder">
            <div className="spinner" />
            <span>Computing race situation...</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
