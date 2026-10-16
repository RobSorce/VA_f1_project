import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, TYRE_COLORS, TYRE_LABELS, tyreColor, tyreLetter, contrastText, markColor, textColor, withAlpha,
  TEXT_COLORS, GRID_COLORS, UI_COLORS, SURFACES, CHART_FONT, chartFontPx, contextColor, contextText,
} from '../../utils/colors';
import { teamPairLegend } from '../../utils/views/teamLegend';
import { attachLasso } from '../../utils/lasso';
import {
  advanceDisplay, fieldMean, biplotArrows, axisTitles,
} from '../../utils/views/raceSituationMap';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

// Driver dot radius and the compound badge under it (letter in contrastText)
const POINT_R = 11;
const POINT_R_HOVER = 14;
const tyreBadgeR = () => Math.max(6, Math.ceil(chartFontPx('label') * 0.65));
// Driver colour of a point / trail on the panel (teammate tint, >= 3:1)
const driverMark = (abbr) => markColor(getDriverColor(abbr), SURFACES.panel);
// Focus + context (D7): a driver outside the selection is drawn in colours
// mixed toward the panel, never at an opacity: his dot and tyre badge >= 2:1,
// his code >= 3:1 (opacity 0.3 / 0.25 read 1.16-2.81:1)
const contextDot = (abbr) => contextColor(driverMark(abbr), SURFACES.panel);
const contextBadge = (compound) => contextColor(tyreColor(compound), SURFACES.panel);
const CONTEXT_LABEL = contextText(TEXT_COLORS.primary, SURFACES.panel);

export default function RaceSituationMap() {
  const svgRef = useRef(null);
  // The box the chart fills: it lays out again at each new size (D4)
  const box = useChartBox(svgRef);
  const cleanupRef = useRef(null);
  // Drawn positions + trails (utils/views/raceSituationMap.js advanceDisplay):
  // each dot at its score, advanced only on new lap data (re-renders never
  // move the points); the D3 transition below animates the move
  const displayRef = useRef(null);

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

  // Toggle for axis chrome (gridlines + crosshair + loading arrows).
  const [showAxes, setShowAxes] = useState(true);

  // Reset the trajectory when the session changes. Declared before the effect
  // that advances the display: effects run in declaration order, so on mount
  // (the tab opened mid-race) the reset comes first and the first advance
  // keeps its trail (minor backlog P13)
  const sessionKey = useF1Store((s) => s.sessionData?.session_info?.year + '-' + s.sessionData?.session_info?.round);
  useEffect(() => {
    displayRef.current = null;
  }, [sessionKey]);

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

  // Advance the drawn positions and trails once per new race situation;
  // the same data returns the same state
  useEffect(() => {
    if (!raceSituationData) return;
    displayRef.current = advanceDisplay(displayRef.current, raceSituationData);
  }, [raceSituationData]);

  // Main D3 render — uses update pattern for animated transitions
  useEffect(() => {
    if (!svgRef.current || !raceSituationData) return;

    const data = raceSituationData;
    const { driverAbbrs, scores, loadings, explainedVariance, driverFeatures, computedAtLap } = data;
    // Idempotent: on a re-render (hover, selection) the state drawn already
    const display = advanceDisplay(displayRef.current, data);
    displayRef.current = display;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, { width: 500, height: 400 });
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
        .attr('fill', TEXT_COLORS.muted);

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
    const history = display.trails;
    const allX = scores.map((d) => d.x);
    const allY = scores.map((d) => d.y);
    for (const abbr of driverAbbrs) {
      allX.push(display.positions[abbr].x);
      allY.push(display.positions[abbr].y);
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
    if (showAxes) {
      gridLayer.append('g').attr('class', 'x-grid')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat(''))
        .call((el) => el.selectAll('.tick line').attr('stroke', GRID_COLORS.grid))
        .call((el) => el.select('.domain').remove());

      gridLayer.append('g').attr('class', 'y-grid')
        .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''))
        .call((el) => el.selectAll('.tick line').attr('stroke', GRID_COLORS.grid))
        .call((el) => el.select('.domain').remove());
    }

    // ── Crosshair at the field average (the current mean: the PCA is refitted per lap) ──
    const crosshairLayer = g.select('.crosshair-layer');
    crosshairLayer.selectAll('*').remove();
    const mean = fieldMean(scores);
    const ox = x(mean.x), oy = y(mean.y);
    if (showAxes && ox > 0 && ox < innerW && oy > 0 && oy < innerH) {
      crosshairLayer.append('line').attr('x1', ox).attr('y1', 0).attr('x2', ox).attr('y2', innerH)
        .attr('stroke', GRID_COLORS.axis).attr('stroke-dasharray', '3,5');
      crosshairLayer.append('line').attr('x1', 0).attr('y1', oy).attr('x2', innerW).attr('y2', oy)
        .attr('stroke', GRID_COLORS.axis).attr('stroke-dasharray', '3,5');
      crosshairLayer.append('text').attr('x', ox + 4).attr('y', oy - 6)
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
        .attr('font-style', 'italic').text('field avg');
    }

    // ── Loading arrows (biplot vectors from the field average, the same basis
    //    as the points: a driver moves along an arrow as that feature rises) ──
    const arrowsLayer = g.select('.arrows-layer');
    arrowsLayer.selectAll('*').remove();
    const topLoadings = showAxes ? biplotArrows(loadings) : [];
    const maxMag = Math.max(0, ...topLoadings.map((l) => l.magnitude));
    // Arrow length in PC units (the longest = 32 % of the shorter axis span),
    // drawn through the points' own x / y scales so the directions match
    const xSpan = x.domain()[1] - x.domain()[0];
    const ySpan = y.domain()[1] - y.domain()[0];
    const arrowScale = Math.min(xSpan, ySpan) * 0.32 / (maxMag || 1);

    topLoadings.forEach((l) => {
      const endX = x(mean.x + l.pc1 * arrowScale);
      const endY = y(mean.y + l.pc2 * arrowScale);
      const dx = endX - ox;
      const dy = endY - oy;
      if (endX < -10 || endX > innerW + 10 || endY < -10 || endY > innerH + 10) return;

      arrowsLayer.append('line')
        .attr('x1', ox).attr('y1', oy).attr('x2', endX).attr('y2', endY)
        .attr('stroke', TEXT_COLORS.muted).attr('stroke-width', 1.2)
        .attr('marker-end', 'url(#sit-arrow)');

      const labelX = endX + (dx > 0 ? 5 : -5);
      const labelY = endY + (dy > 0 ? 12 : -5);
      const labelText = l.label;
      const labelAnchor = dx > 0 ? 'start' : 'end';

      arrowsLayer.append('text')
        .attr('x', labelX).attr('y', labelY)
        .attr('text-anchor', labelAnchor)
        .attr('fill', TEXT_COLORS.secondary)
        .style('font-size', CHART_FONT.data).attr('font-weight', 600)
        .attr('paint-order', 'stroke')
        .attr('stroke', 'rgba(0,0,0,0.6)').attr('stroke-width', 3)
        .attr('stroke-linejoin', 'round')
        .text(labelText);
    });

    // ── Point data: the drawn positions (each dot at its score, so it sits at
    //    the crosshair + sum of z x arrow) ──
    const pointData = driverAbbrs.map((abbr) => {
      const drawn = display.positions[abbr];
      return {
        abbr,
        x: drawn.x,
        y: drawn.y,
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
      // a context driver's trail is not drawn (D7): at 3-8 % opacity it read
      // about 1.05:1, under the 2:1 of a context mark; his dot, badge and code stay
      if (isDimmed(d)) continue;

      const selected = isSelected(d);
      const highlighted = d.abbr === highlightedDriver || d.abbr === focusDriver;
      const driverColor = driverMark(d.abbr);
      const showFull = selected || highlighted;

      // Trail line segments
      for (let i = 1; i < trail.length; i++) {
        const fromPt = trail[i - 1];
        const toPt = trail[i];
        const progress = i / trail.length;
        let opacity, strokeW;

        if (showFull) {
          opacity = 0.2 + progress * 0.55;
          strokeW = 1.5 + progress * 2;
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
      {
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
              .style('font-size', CHART_FONT.label).attr('font-weight', 600)
              .attr('fill', textColor(driverColor, SURFACES.panel))
              .attr('pointer-events', 'none')
              .attr('paint-order', 'stroke')
              .attr('stroke', 'rgba(0,0,0,0.6)').attr('stroke-width', 2)
              .attr('stroke-linejoin', 'round')
              .text(`L${pt.lap}`);
          }
        }
      }

      // Direction arrow on most recent trail segment
      if (trail.length >= 2) {
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
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y) + POINT_R + tyreBadgeR())
          .attr('r', 0)
          .attr('fill', (d) => (isDimmed(d) ? contextBadge(d.compoundName) : tyreColor(d.compoundName)))
          .attr('stroke', SURFACES.page).attr('stroke-width', 1)
          .attr('pointer-events', 'none')
          .call((e) => e.transition(t).attr('r', tyreBadgeR())),
        (update) => update
          .call((u) => u.transition(t)
            .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y) + POINT_R + tyreBadgeR())
            .attr('fill', (d) => (isDimmed(d) ? contextBadge(d.compoundName) : tyreColor(d.compoundName)))
            .attr('opacity', 1)),
        (exit) => exit.transition(t).attr('r', 0).remove()
      );
    // the compound letter on its badge (the FIA colour is never alone)
    tyreLayer.selectAll('.tyre-letter').data(pointData, (d) => d.abbr)
      .join('text')
      .attr('class', 'tyre-letter')
      .attr('x', (d) => x(d.x)).attr('y', (d) => y(d.y) + POINT_R + tyreBadgeR())
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
      // black or white on the badge drawn (the context badge included): >= 4.5:1
      .attr('fill', (d) => contrastText(isDimmed(d) ? contextBadge(d.compoundName) : tyreColor(d.compoundName)))
      .style('font-size', CHART_FONT.label).attr('font-weight', 800)
      .attr('opacity', 1)
      .attr('pointer-events', 'none')
      .text((d) => tyreLetter(d.compoundName));

    // ── Main driver circles — animated with D3 join ──
    const pointsLayer = g.select('.points-layer');
    pointsLayer.selectAll('.driver-point').data(pointData, (d) => d.abbr)
      .join(
        (enter) => enter.append('circle')
          .attr('class', 'driver-point')
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y))
          .attr('r', 0)
          .attr('fill', (d) => (isDimmed(d) ? contextDot(d.abbr) : driverMark(d.abbr)))
          .attr('stroke', (d) => isSelected(d) ? TEXT_COLORS.primary : 'rgba(0,0,0,0.3)')
          .attr('stroke-width', (d) => isSelected(d) ? 2 : 1)
          .attr('cursor', 'pointer')
          .call((e) => e.transition(t).attr('r', POINT_R)),
        (update) => update
          .call((u) => u.transition(t)
            .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y))
            .attr('fill', (d) => (isDimmed(d) ? contextDot(d.abbr) : driverMark(d.abbr)))
            .attr('stroke', (d) => isSelected(d) ? TEXT_COLORS.primary : 'rgba(0,0,0,0.3)')
            .attr('stroke-width', (d) => isSelected(d) ? 2 : 1)
            .attr('opacity', 1)),
        (exit) => exit.transition(t).attr('r', 0).remove()
      )
      .on('mouseenter', function (event, d) {
        setHighlightedDriver(d.abbr);
        d3.select(this).transition().duration(150).attr('r', POINT_R_HOVER);

        const tooltip = d3.select('body').selectAll('.situation-tooltip').data([0]).join('div')
          .attr('class', 'tooltip situation-tooltip');

        const trend = d.paceTrend > 0.05 ? `+${d.paceTrend.toFixed(2)}s/lap (slower)` :
          d.paceTrend < -0.05 ? `${d.paceTrend.toFixed(2)}s/lap (faster)` : 'stable';

        const trailLen = history[d.abbr]?.length || 0;

        tooltip.html(
          `<div class="tooltip-title" style="color:${textColor(getDriverColor(d.abbr), SURFACES.elevated)}">` +
          `${d.abbr} — P${d.position}</div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Team</span><span class="tooltip-value">${d.teamName}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pace</span><span class="tooltip-value">${d.recentPace?.toFixed(1)}s</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Trend</span><span class="tooltip-value">${trend}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Tyre</span><span class="tooltip-value">${d.compoundName} (${d.tyreLife} laps)</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Stint</span><span class="tooltip-value">#${d.stintNumber}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pit Stops</span><span class="tooltip-value">${d.pitStops ?? (d.stintNumber - 1)}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Est. pit in</span><span class="tooltip-value">~${d.estLapsToPit} laps${d.estLapsToPitSource === 'prior' ? ' (prior)' : ''}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pred. pace +5</span><span class="tooltip-value">${d.predictedPace5?.toFixed(1)}s</span></div>` +
          (trailLen > 1 ? `<div class="tooltip-row"><span class="tooltip-label">Trail</span><span class="tooltip-value">${trailLen} snapshots</span></div>` : '')
        ).style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', function () {
        setHighlightedDriver(null);
        d3.select(this).transition().duration(150).attr('r', POINT_R);
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

    const dimmedAbbr = (abbr) => {
      const pd = pointData.find((p) => p.abbr === abbr);
      return !!pd && isDimmed(pd);
    };
    const labelsLayer = g.select('.labels-layer');
    labelsLayer.selectAll('.situation-label').data(labelPositions, (d) => d.abbr)
      .join(
        (enter) => enter.append('text')
          .attr('class', 'situation-label')
          .attr('x', (d) => d.lx).attr('y', (d) => d.ly)
          .text((d) => d.abbr)
          // white with a dark halo: readable on any team colour and the panel;
          // a context driver's code mixed toward the panel (>= 3:1 on the panel
          // and on its halo), never at an opacity. A style, not an attribute:
          // the stylesheet's .situation-label rule would win over an attribute
          .style('font-size', CHART_FONT.data).attr('font-weight', 700)
          .style('fill', (d) => (dimmedAbbr(d.abbr) ? CONTEXT_LABEL : TEXT_COLORS.primary))
          .attr('text-anchor', (d) => d.anchor)
          .attr('dominant-baseline', 'central')
          .attr('pointer-events', 'none')
          .attr('paint-order', 'stroke')
          .attr('stroke', 'rgba(0,0,0,0.85)').attr('stroke-width', 3)
          .attr('stroke-linejoin', 'round')
          .attr('opacity', 0)
          .call((e) => e.transition(t).attr('opacity', 1)),
        (update) => update
          .style('fill', (d) => (dimmedAbbr(d.abbr) ? CONTEXT_LABEL : TEXT_COLORS.primary))
          .call((u) => u.transition(t)
            .attr('x', (d) => d.lx).attr('y', (d) => d.ly)
            .attr('opacity', 1)),
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
          .attr('stroke', TEXT_COLORS.primary).attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '3,2')
          .attr('pointer-events', 'none');
      }
    }

    // ── Info layer (lap indicator, axis labels, selection count, help text) ──
    const infoLayer = g.select('.info-layer');
    infoLayer.selectAll('*').remove();

    // Variance each axis captures at this lap (computePCA explainedVariance),
    // and the PC1-PC2 plane both axes span (turned to follow the previous lap)
    const titles = axisTitles(loadings, explainedVariance);

    infoLayer.append('text').attr('class', 'axis-label-x')
      .attr('x', innerW / 2).attr('y', innerH + 34)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label).attr('font-weight', 600)
      .text(titles.x);

    infoLayer.append('text').attr('class', 'axis-label-y')
      .attr('transform', `translate(-38, ${innerH / 2}) rotate(-90)`)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label).attr('font-weight', 600)
      .text(titles.y);

    infoLayer.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 20)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .text('Click driver to select | Shift+drag to lasso | Dbl-click to focus');

    // info lines on the right, one data-font line apart
    const lineH = Math.ceil(chartFontPx('data') * 1.25);
    if (data.paceInPca === false) {
      infoLayer.append('text').attr('class', 'pace-note')
        .attr('x', 4).attr('y', 12)
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
        .text('Pace left out until every driver has 2 green laps');
    }

    infoLayer.append('text').attr('class', 'lap-indicator')
      .attr('x', innerW - 4).attr('y', 12)
      .attr('text-anchor', 'end')
      .attr('fill', TEXT_COLORS.primary).style('font-size', CHART_FONT.data).attr('font-weight', 700)
      .text(`Lap ${computedAtLap}`);

    infoLayer.append('text').attr('class', 'plane-label')
      .attr('x', innerW - 4).attr('y', 12 + lineH)
      .attr('text-anchor', 'end')
      .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.label)
      .text(titles.plane);

    if (selectedDrivers.length > 0) {
      infoLayer.append('text').attr('class', 'sel-count')
        .attr('x', innerW - 4).attr('y', 12 + 2 * lineH)
        .attr('text-anchor', 'end')
        .attr('fill', TEXT_COLORS.primary).style('font-size', CHART_FONT.label).attr('font-weight', 700)
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

  }, [raceSituationData, selectedDrivers, highlightedDriver, focusDriver, driverInfoMap, setSelectedDrivers, toggleDriver, setHighlightedDriver, setFocusDriver, showAxes, box.width, box.height]);

  // Cleanup on unmount
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);


  // Legend (V3 / V4): one row per team with its two driver colours (team
  // colour, teammate tint: the dots' encoding), then the compound badges
  const teamLegend = useMemo(() => [
    ...teamPairLegend(driversInfo, SURFACES.panel),
    ...['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) => ({
      label: '', title: `${c} tyre (badge under the dot)`, color: TYRE_COLORS[c], glyph: TYRE_LABELS[c], shape: 'badge',
    })),
  ], [driversInfo]);

  const axesToggleStyle = {
    padding: '2px 8px', fontSize: CHART_FONT.label, fontWeight: 700, letterSpacing: '0.05em',
    border: '1px solid', borderRadius: 4, cursor: 'pointer',
    background: showAxes ? withAlpha(UI_COLORS.brush, 0.14) : 'transparent',
    borderColor: showAxes ? UI_COLORS.brush : 'rgba(255,255,255,0.30)',
    color: showAxes ? UI_COLORS.brush : TEXT_COLORS.secondary,
    transition: 'all 0.12s',
  };

  return (
    <Panel
      title={`Race Situation ${raceSituationData?.computedAtLap ? `— Lap ${raceSituationData.computedAtLap}` : ''}`}
      controls={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            style={axesToggleStyle}
            onClick={() => setShowAxes((v) => !v)}
            title={showAxes ? 'Hide PCA axes + feature arrows' : 'Show PCA axes + feature arrows'}
          >
            {showAxes ? 'AXES ON' : 'AXES OFF'}
          </button>
          <Legend items={teamLegend} />
        </span>
      )}
    >
      <div className="viz-container" style={{ position: 'relative' }}>
        {raceSituationData ? (
          <>
            <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
            {selectedDrivers.length > 0 && (
              <button
                onClick={() => setSelectedDrivers([])}
                style={{
                  position: 'absolute', top: 6, left: 6,
                  background: withAlpha(UI_COLORS.brush, 0.15), border: `1px solid ${UI_COLORS.brush}`,
                  borderRadius: 4, padding: '2px 8px', fontSize: CHART_FONT.label, fontWeight: 600,
                  color: TEXT_COLORS.primary, cursor: 'pointer', zIndex: 2,
                  backdropFilter: 'blur(8px)',
                }}
              >
                Clear {selectedDrivers.length} selected
              </button>
            )}
          </>
        ) : currentLap < 3 ? (
          <div className="loading-placeholder">
            <span style={{ color: TEXT_COLORS.muted, textAlign: 'center', lineHeight: 1.6 }}>
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
