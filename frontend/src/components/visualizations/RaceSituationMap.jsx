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
  HARD: TYRE_COLORS?.HARD || '#ffffff',
  INTERMEDIATE: TYRE_COLORS?.INTERMEDIATE || '#00e676',
  WET: TYRE_COLORS?.WET || '#2196f3',
  UNKNOWN: '#888',
};

export default function RaceSituationMap() {
  const svgRef = useRef(null);
  const cleanupRef = useRef(null);
  const prevScoresRef = useRef(null); // for animated transitions

  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const computeRaceSituation = useF1Store((s) => s.computeRaceSituation);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
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

  // Main D3 render
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

    // Check if this is an update (for transitions) or first render
    const isUpdate = svg.select('.situation-main').size() > 0;
    if (!isUpdate) svg.selectAll('*').remove();

    let g;
    if (isUpdate) {
      g = svg.select('.situation-main');
    } else {
      g = svg.append('g').attr('class', 'situation-main').attr('transform', `translate(${margin.left},${margin.top})`);
    }

    // Scales
    const xExtent = d3.extent(scores, (d) => d.x);
    const yExtent = d3.extent(scores, (d) => d.y);
    const xPad = Math.max(0.5, (xExtent[1] - xExtent[0]) * 0.15);
    const yPad = Math.max(0.5, (yExtent[1] - yExtent[0]) * 0.15);

    const x = d3.scaleLinear().domain([xExtent[0] - xPad, xExtent[1] + xPad]).range([0, innerW]);
    const y = d3.scaleLinear().domain([yExtent[0] - yPad, yExtent[1] + yPad]).range([innerH, 0]);

    if (!isUpdate) {
      // Grid
      const xAxis = d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat('');
      const yAxis = d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat('');

      g.append('g').attr('class', 'x-grid')
        .attr('transform', `translate(0,${innerH})`)
        .call(xAxis)
        .call((el) => el.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
        .call((el) => el.select('.domain').remove());

      g.append('g').attr('class', 'y-grid')
        .call(yAxis)
        .call((el) => el.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
        .call((el) => el.select('.domain').remove());

      // Axis labels
      const pc1Pct = explainedVariance[0] ? `${(explainedVariance[0] * 100).toFixed(0)}%` : '';
      const pc2Pct = explainedVariance[1] ? `${(explainedVariance[1] * 100).toFixed(0)}%` : '';

      // Build axis description from top loadings
      const topPC1 = [...loadings].sort((a, b) => Math.abs(b.pc1) - Math.abs(a.pc1)).slice(0, 2);
      const topPC2 = [...loadings].sort((a, b) => Math.abs(b.pc2) - Math.abs(a.pc2)).slice(0, 2);
      const pc1Desc = topPC1.map((l) => FEATURE_LABELS[l.feature] || l.feature).join(' / ');
      const pc2Desc = topPC2.map((l) => FEATURE_LABELS[l.feature] || l.feature).join(' / ');

      g.append('text').attr('class', 'axis-label-x')
        .attr('x', innerW / 2).attr('y', innerH + 32)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.45)')
        .attr('font-size', '9px').attr('font-weight', 600)
        .text(`PC1: ${pc1Desc} (${pc1Pct})`);

      g.append('text').attr('class', 'axis-label-y')
        .attr('transform', `translate(-38, ${innerH / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.45)')
        .attr('font-size', '9px').attr('font-weight', 600)
        .text(`PC2: ${pc2Desc} (${pc2Pct})`);

      // Crosshair at origin
      const ox = x(0), oy = y(0);
      if (ox > 0 && ox < innerW && oy > 0 && oy < innerH) {
        g.append('line').attr('x1', ox).attr('y1', 0).attr('x2', ox).attr('y2', innerH)
          .attr('stroke', 'rgba(255,255,255,0.1)').attr('stroke-dasharray', '4,4');
        g.append('line').attr('x1', 0).attr('y1', oy).attr('x2', innerW).attr('y2', oy)
          .attr('stroke', 'rgba(255,255,255,0.1)').attr('stroke-dasharray', '4,4');
        g.append('text').attr('x', ox + 3).attr('y', 10)
          .attr('fill', 'rgba(255,255,255,0.15)').attr('font-size', '7px').text('avg');
      }

      // Loading arrows (top 6)
      const topLoadings = loadings.slice(0, 6);
      const maxMag = Math.max(...topLoadings.map((l) => Math.sqrt(l.pc1 ** 2 + l.pc2 ** 2)));
      const arrowScale = Math.min(innerW, innerH) * 0.3 / (maxMag || 1);

      svg.selectAll('#sit-arrow').remove();
      svg.append('defs').append('marker')
        .attr('id', 'sit-arrow')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 8).attr('refY', 5)
        .attr('markerWidth', 5).attr('markerHeight', 5)
        .attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M 0 2 L 8 5 L 0 8 Z')
        .attr('fill', 'rgba(100,200,255,0.45)');

      const arrowG = g.append('g').attr('class', 'arrows');
      topLoadings.forEach((l) => {
        const dx = l.pc1 * arrowScale;
        const dy = -l.pc2 * arrowScale;
        const endX = ox + dx, endY = oy + dy;
        if (endX < -10 || endX > innerW + 10 || endY < -10 || endY > innerH + 10) return;

        arrowG.append('line')
          .attr('x1', ox).attr('y1', oy).attr('x2', endX).attr('y2', endY)
          .attr('stroke', 'rgba(100,200,255,0.3)').attr('stroke-width', 1)
          .attr('marker-end', 'url(#sit-arrow)');

        arrowG.append('text')
          .attr('x', endX + (dx > 0 ? 4 : -4))
          .attr('y', endY + (dy > 0 ? 10 : -4))
          .attr('text-anchor', dx > 0 ? 'start' : 'end')
          .attr('fill', 'rgba(100,200,255,0.5)')
          .attr('font-size', '7px').attr('font-weight', 600)
          .text(FEATURE_LABELS[l.feature] || l.feature);
      });

      // Info text
      g.append('text')
        .attr('x', innerW / 2).attr('y', innerH + 18)
        .attr('text-anchor', 'middle')
        .attr('fill', 'var(--color-text-muted)').attr('font-size', 8)
        .text('Click driver to select | Shift+drag to lasso | Dbl-click to focus');
    }

    // Update or remove stale grids on updates
    if (isUpdate) {
      g.select('.x-grid').call(d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat(''))
        .call((el) => el.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
        .call((el) => el.select('.domain').remove());
      g.select('.y-grid').call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''))
        .call((el) => el.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
        .call((el) => el.select('.domain').remove());
    }

    // --- Points (data join with transitions) ---
    const pointData = driverAbbrs.map((abbr, i) => ({
      abbr,
      ...scores[i],
      ...driverFeatures[abbr],
      teamName: driverInfoMap[abbr]?.TeamName || 'Unknown',
    }));

    // Previous positions for ghost trails
    const prevMap = {};
    if (prevScoresRef.current) {
      prevScoresRef.current.forEach((p) => { prevMap[p.abbr] = p; });
    }

    // Ghost trails (previous → current)
    g.selectAll('.situation-trail').data(pointData, (d) => d.abbr)
      .join('line')
      .attr('class', 'situation-trail')
      .attr('x1', (d) => x(prevMap[d.abbr]?.x ?? d.x))
      .attr('y1', (d) => y(prevMap[d.abbr]?.y ?? d.y))
      .attr('x2', (d) => x(d.x))
      .attr('y2', (d) => y(d.y))
      .attr('stroke', 'rgba(255,255,255,0.12)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,3')
      .attr('pointer-events', 'none');

    // Tyre indicators (small circle below main point)
    g.selectAll('.tyre-dot').data(pointData, (d) => d.abbr)
      .join(
        (enter) => enter.append('circle').attr('class', 'tyre-dot')
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y) + 14)
          .attr('r', 3.5),
        (update) => update.transition().duration(800).ease(d3.easeCubicInOut)
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y) + 14),
      )
      .attr('fill', (d) => COMPOUND_COLORS[d.compoundName] || '#888')
      .attr('stroke', 'rgba(0,0,0,0.4)').attr('stroke-width', 0.5)
      .attr('pointer-events', 'none');

    // Main driver circles
    const isSelected = (d) => selectedDrivers.includes(d.abbr);
    const isDimmed = (d) => selectedDrivers.length > 0 && !isSelected(d);

    g.selectAll('.driver-point').data(pointData, (d) => d.abbr)
      .join(
        (enter) => enter.append('circle').attr('class', 'driver-point')
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y)).attr('r', 10),
        (update) => update.transition().duration(800).ease(d3.easeCubicInOut)
          .attr('cx', (d) => x(d.x)).attr('cy', (d) => y(d.y)),
        (exit) => exit.transition().duration(400).attr('r', 0).remove(),
      )
      .attr('r', 10)
      .attr('fill', (d) => getDriverColor(d.abbr))
      .attr('stroke', (d) => isSelected(d) ? '#fff' : 'rgba(0,0,0,0.3)')
      .attr('stroke-width', (d) => isSelected(d) ? 2 : 1)
      .attr('opacity', (d) => isDimmed(d) ? 0.3 : 1)
      .attr('cursor', 'pointer')
      .on('mouseenter', function (event, d) {
        setHighlightedDriver(d.abbr);
        d3.select(this).transition().duration(150).attr('r', 13);

        const tooltip = d3.select('body').selectAll('.situation-tooltip').data([0]).join('div')
          .attr('class', 'tooltip situation-tooltip');

        const trend = d.paceTrend > 0.05 ? `+${d.paceTrend.toFixed(2)}s/lap (slower)` :
          d.paceTrend < -0.05 ? `${d.paceTrend.toFixed(2)}s/lap (faster)` : 'stable';

        tooltip.html(
          `<div class="tooltip-title" style="color:${getDriverColor(d.abbr)}">` +
          `${d.abbr} — P${d.position}</div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Team</span><span class="tooltip-value">${d.teamName}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pace</span><span class="tooltip-value">${d.recentPace?.toFixed(1)}s</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Trend</span><span class="tooltip-value">${trend}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Tyre</span><span class="tooltip-value">${d.compoundName} (${d.tyreLife} laps)</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Stint</span><span class="tooltip-value">#${d.stintNumber}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Est. pit in</span><span class="tooltip-value">~${d.estLapsToPit} laps</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Pred. pace +5</span><span class="tooltip-value">${d.predictedPace5?.toFixed(1)}s</span></div>`
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
        const sel = selectedDrivers.includes(d.abbr)
          ? selectedDrivers.filter((a) => a !== d.abbr)
          : [...selectedDrivers, d.abbr];
        setSelectedDrivers(sel);
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation();
        setFocusDriver(d.abbr);
      });

    // Driver labels (abbreviation inside circle)
    g.selectAll('.situation-label').data(pointData, (d) => d.abbr)
      .join(
        (enter) => enter.append('text').attr('class', 'situation-label')
          .attr('x', (d) => x(d.x)).attr('y', (d) => y(d.y)),
        (update) => update.transition().duration(800).ease(d3.easeCubicInOut)
          .attr('x', (d) => x(d.x)).attr('y', (d) => y(d.y)),
      )
      .text((d) => d.abbr)
      .attr('font-size', '7px').attr('font-weight', 700)
      .attr('fill', '#fff').attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('pointer-events', 'none')
      .attr('opacity', (d) => isDimmed(d) ? 0.3 : 1)
      .style('text-shadow', '0 0 3px rgba(0,0,0,0.8)');

    // Focus driver ring (pulsing)
    g.selectAll('.situation-focus-ring').remove();
    if (focusDriver) {
      const fd = pointData.find((d) => d.abbr === focusDriver);
      if (fd) {
        g.append('circle').attr('class', 'situation-focus-ring')
          .attr('cx', x(fd.x)).attr('cy', y(fd.y))
          .attr('r', 14);
      }
    }

    // Highlighted driver ring (from Leaderboard hover)
    g.selectAll('.situation-highlight-ring').remove();
    if (highlightedDriver && highlightedDriver !== focusDriver) {
      const hd = pointData.find((d) => d.abbr === highlightedDriver);
      if (hd) {
        g.append('circle').attr('class', 'situation-highlight-ring')
          .attr('cx', x(hd.x)).attr('cy', y(hd.y))
          .attr('r', 14).attr('fill', 'none')
          .attr('stroke', '#fff').attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '3,2').attr('opacity', 0.7)
          .attr('pointer-events', 'none');
      }
    }

    // Lap indicator
    g.selectAll('.lap-indicator').remove();
    g.append('text').attr('class', 'lap-indicator')
      .attr('x', innerW - 4).attr('y', 12)
      .attr('text-anchor', 'end')
      .attr('fill', '#00e676').attr('font-size', '10px').attr('font-weight', 700)
      .text(`Lap ${computedAtLap}`);

    // Selection count
    if (selectedDrivers.length > 0) {
      g.selectAll('.sel-count').remove();
      g.append('text').attr('class', 'sel-count')
        .attr('x', innerW - 4).attr('y', 26)
        .attr('text-anchor', 'end')
        .attr('fill', 'var(--color-f1-red)').attr('font-size', '9px').attr('font-weight', 700)
        .text(`${selectedDrivers.length} selected`);
    }

    // Lasso
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = attachLasso(g, {
      getPoints: () =>
        pointData.map((d) => ({ x: x(d.x), y: y(d.y), id: d.abbr })),
      onSelect: (ids) => {
        setSelectedDrivers(ids);
      },
    });

    // Store current scores for next frame's ghost trail
    prevScoresRef.current = pointData.map((d) => ({ abbr: d.abbr, x: d.x, y: d.y }));

  }, [raceSituationData, selectedDrivers, highlightedDriver, focusDriver, driverInfoMap, setSelectedDrivers, setHighlightedDriver, setFocusDriver]);

  // Cleanup on unmount
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

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
