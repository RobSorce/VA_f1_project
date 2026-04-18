import React, { useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getTeamColor } from '../../utils/colors';
import { attachLasso } from '../../utils/lasso';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

export default function PCABiplot() {
  const svgRef = useRef(null);
  const cleanupRef = useRef(null);

  const pcaEmbeddings = useF1Store((s) => s.pcaEmbeddings);
  const loadPCAEmbeddings = useF1Store((s) => s.loadPCAEmbeddings);
  const selectedPCAPoints = useF1Store((s) => s.selectedPCAPoints);
  const setSelectedPCAPoints = useF1Store((s) => s.setSelectedPCAPoints);
  const fetchPCAAnalysis = useF1Store((s) => s.fetchPCAAnalysis);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);

  // Load PCA embeddings on mount
  useEffect(() => {
    loadPCAEmbeddings();
  }, [loadPCAEmbeddings]);

  useEffect(() => {
    if (!svgRef.current || !pcaEmbeddings?.points?.length) return;

    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 500;
    const height = rect.height || 400;
    const margin = { top: 15, right: 15, bottom: 36, left: 46 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const points = pcaEmbeddings.points;
    const loadings = pcaEmbeddings.loadings || [];
    const explained = pcaEmbeddings.explained_variance || [];
    const pc1Label = pcaEmbeddings.pc1_label || 'PC1';
    const pc2Label = pcaEmbeddings.pc2_label || 'PC2';

    // Scales
    const xExtent = d3.extent(points, (d) => d.x);
    const yExtent = d3.extent(points, (d) => d.y);
    const xPad = (xExtent[1] - xExtent[0]) * 0.12;
    const yPad = (yExtent[1] - yExtent[0]) * 0.12;

    const x = d3.scaleLinear()
      .domain([xExtent[0] - xPad, xExtent[1] + xPad])
      .range([0, innerW]);
    const y = d3.scaleLinear()
      .domain([yExtent[0] - yPad, yExtent[1] + yPad])
      .range([innerH, 0]);

    // Axes — meaningful for PCA
    const xAxis = d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat('');
    const yAxis = d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat('');

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .call((g) => g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
      .call((g) => g.select('.domain').remove());

    g.append('g')
      .call(yAxis)
      .call((g) => g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)'))
      .call((g) => g.select('.domain').remove());

    // Axis labels with explained variance
    const pc1Pct = explained[0] ? `${(explained[0] * 100).toFixed(0)}%` : '';
    const pc2Pct = explained[1] ? `${(explained[1] * 100).toFixed(0)}%` : '';

    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 28)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.5)')
      .attr('font-size', '9px')
      .attr('font-weight', 600)
      .text(`PC1: ${pc1Label} (${pc1Pct})`);

    g.append('text')
      .attr('transform', `translate(-34, ${innerH / 2}) rotate(-90)`)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.5)')
      .attr('font-size', '9px')
      .attr('font-weight', 600)
      .text(`PC2: ${pc2Label} (${pc2Pct})`);

    // Crosshair at origin (average performance)
    const originX = x(0);
    const originY = y(0);
    if (originX > 0 && originX < innerW && originY > 0 && originY < innerH) {
      g.append('line')
        .attr('x1', originX).attr('y1', 0)
        .attr('x2', originX).attr('y2', innerH)
        .attr('stroke', 'rgba(255,255,255,0.12)')
        .attr('stroke-dasharray', '4,4');
      g.append('line')
        .attr('x1', 0).attr('y1', originY)
        .attr('x2', innerW).attr('y2', originY)
        .attr('stroke', 'rgba(255,255,255,0.12)')
        .attr('stroke-dasharray', '4,4');
      g.append('text')
        .attr('x', originX + 4).attr('y', 10)
        .attr('fill', 'rgba(255,255,255,0.2)')
        .attr('font-size', '7px')
        .text('avg');
    }

    // Feature loading arrows (top 8 by magnitude)
    const topLoadings = loadings.slice(0, 8);
    if (topLoadings.length > 0) {
      // Scale loadings to fit within the plot
      const maxLoading = Math.max(...topLoadings.map((l) => Math.sqrt(l.pc1 ** 2 + l.pc2 ** 2)));
      const arrowScale = Math.min(innerW, innerH) * 0.35 / (maxLoading || 1);

      const arrowG = g.append('g').attr('class', 'pca-arrows');

      // Arrow marker
      svg.append('defs').append('marker')
        .attr('id', 'pca-arrow')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 8).attr('refY', 5)
        .attr('markerWidth', 5).attr('markerHeight', 5)
        .attr('orient', 'auto-start-reverse')
        .append('path')
        .attr('d', 'M 0 2 L 8 5 L 0 8 Z')
        .attr('fill', 'rgba(255,255,255,0.45)');

      topLoadings.forEach((l) => {
        const dx = l.pc1 * arrowScale;
        const dy = -l.pc2 * arrowScale; // flip y
        const startX = originX;
        const startY = originY;
        const endX = startX + dx;
        const endY = startY + dy;

        // Only draw if arrow stays within plot area
        if (endX < -10 || endX > innerW + 10 || endY < -10 || endY > innerH + 10) return;

        arrowG.append('line')
          .attr('x1', startX).attr('y1', startY)
          .attr('x2', endX).attr('y2', endY)
          .attr('stroke', 'rgba(255,255,255,0.35)')
          .attr('stroke-width', 1.2)
          .attr('marker-end', 'url(#pca-arrow)');

        // Label at tip
        const labelOffsetX = dx > 0 ? 4 : -4;
        const labelOffsetY = dy > 0 ? 10 : -4;
        arrowG.append('text')
          .attr('x', endX + labelOffsetX).attr('y', endY + labelOffsetY)
          .attr('text-anchor', dx > 0 ? 'start' : 'end')
          .attr('fill', 'rgba(255,255,255,0.45)')
          .attr('font-size', '7px')
          .attr('font-weight', 600)
          .text(l.label);
      });
    }

    // Draw points
    const isCurrentRace = (d) => d.year === year && d.round === round;

    g.selectAll('.pca-point')
      .data(points)
      .join('path')
      .attr('class', (d) => {
        let cls = 'pca-point'; // reuse same CSS class
        if (isCurrentRace(d)) cls += ' pca-point--current';
        if (selectedPCAPoints.includes(d.id)) cls += ' selected';
        else if (selectedPCAPoints.length > 0) cls += ' dimmed';
        return cls;
      })
      .attr('transform', (d) => `translate(${x(d.x)},${y(d.y)})`)
      .attr('d', (d) =>
        isCurrentRace(d)
          ? d3.symbol().type(d3.symbolStar).size(120)()
          : d3.symbol().type(d3.symbolCircle).size(50)()
      )
      .attr('fill', (d) => getTeamColor(d.team))
      .on('mouseenter', function (event, d) {
        d3.select(this).attr('d', d3.symbol().type(isCurrentRace(d) ? d3.symbolStar : d3.symbolCircle).size(150)());
        const tooltip = d3.select('body').selectAll('.pca-tooltip').data([0]).join('div')
          .attr('class', 'tooltip pca-tooltip');
        tooltip.html(
          `<div class="tooltip-title" style="color:${getTeamColor(d.team)}">${d.driver} — ${d.race_name || 'R' + d.round}</div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Team</span><span class="tooltip-value">${d.team}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Season</span><span class="tooltip-value">${d.year} R${d.round}</span></div>` +
          `<div style="margin-top:4px;font-size:8px;color:rgba(255,255,255,0.3)">Click to select | Shift+drag to lasso</div>`
        ).style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', function (event, d) {
        d3.select(this).attr('d', d3.symbol().type(isCurrentRace(d) ? d3.symbolStar : d3.symbolCircle).size(isCurrentRace(d) ? 120 : 50)());
        d3.select('.pca-tooltip').classed('visible', false).style('opacity', 0);
      })
      .on('click', (event, d) => {
        const ids = selectedPCAPoints.includes(d.id)
          ? selectedPCAPoints.filter((id) => id !== d.id)
          : [...selectedPCAPoints, d.id];
        setSelectedPCAPoints(ids);
        if (ids.length > 0) {
          fetchPCAAnalysis(ids);
          const uniqueDrivers = [...new Set(ids.map((id) => points.find((p) => p.id === id)?.driver).filter(Boolean))];
          setSelectedDrivers(uniqueDrivers);
        } else {
          setSelectedDrivers([]);
        }
      });

    // Driver highlight rings (Leaderboard coordination)
    if (selectedDrivers.length > 0) {
      g.selectAll('.pca-driver-ring')
        .data(points.filter((d) => selectedDrivers.includes(d.driver)))
        .join('circle')
        .attr('class', 'pca-driver-ring')
        .attr('cx', (d) => x(d.x))
        .attr('cy', (d) => y(d.y))
        .attr('r', 8)
        .attr('fill', 'none')
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3,2')
        .attr('opacity', 0.85)
        .attr('pointer-events', 'none');
    }

    // Lasso selection (shift+drag)
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = attachLasso(g, {
      getPoints: () =>
        points.map((d) => ({ x: x(d.x), y: y(d.y), id: d.id })),
      onSelect: (ids) => {
        setSelectedPCAPoints(ids);
        if (ids.length > 0) {
          fetchPCAAnalysis(ids);
          const uniqueDrivers = [...new Set(ids.map((id) => points.find((p) => p.id === id)?.driver).filter(Boolean))];
          setSelectedDrivers(uniqueDrivers);
        } else {
          setSelectedDrivers([]);
        }
      },
    });

    // Info text
    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 16)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--color-text-muted)')
      .attr('font-size', 8)
      .text('Arrows show which features drive each axis | Shift+drag to lasso');

    // Selected count
    if (selectedPCAPoints.length > 0) {
      g.append('text')
        .attr('x', innerW - 4).attr('y', 12)
        .attr('text-anchor', 'end')
        .attr('fill', 'var(--color-f1-red)')
        .attr('font-size', 10)
        .attr('font-weight', 700)
        .text(`${selectedPCAPoints.length} selected`);
    }

  }, [pcaEmbeddings, selectedPCAPoints, selectedDrivers, year, round, setSelectedPCAPoints, setSelectedDrivers, fetchPCAAnalysis]);

  // Cleanup lasso on unmount
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  // Build legend
  const teamLegend = React.useMemo(() => {
    if (!pcaEmbeddings?.points) return [];
    const teams = [...new Set(pcaEmbeddings.points.map((p) => p.team))];
    const items = teams.slice(0, 10).map((t) => ({
      label: t,
      color: getTeamColor(t),
      shape: 'circle',
    }));
    items.push({ label: 'Current Race', color: '#ffd700', shape: 'star' });
    return items;
  }, [pcaEmbeddings]);

  const clearSelection = () => {
    setSelectedPCAPoints([]);
    setSelectedDrivers([]);
  };

  return (
    <Panel title="PCA Biplot" controls={<Legend items={teamLegend} shape="circle" />}>
      <div className="viz-container" style={{ position: 'relative' }}>
        {pcaEmbeddings?.points?.length ? (
          <>
            <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
            {selectedPCAPoints.length > 0 && (
              <button
                onClick={clearSelection}
                style={{
                  position: 'absolute', top: 6, left: 6,
                  background: 'rgba(225, 6, 0, 0.15)', border: '1px solid rgba(225, 6, 0, 0.4)',
                  borderRadius: 4, padding: '2px 8px', fontSize: '9px', fontWeight: 600,
                  color: 'rgba(255,255,255,0.8)', cursor: 'pointer', zIndex: 2,
                  backdropFilter: 'blur(8px)',
                }}
              >
                Clear {selectedPCAPoints.length} selected
              </button>
            )}
          </>
        ) : pcaEmbeddings?.message ? (
          <div className="loading-placeholder">
            <span style={{ color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
              {pcaEmbeddings.message}
            </span>
          </div>
        ) : (
          <div className="loading-placeholder">
            <div className="spinner" />
            <span>Computing PCA from race data...</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
