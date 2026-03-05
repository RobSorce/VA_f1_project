import React, { useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getTeamColor } from '../../utils/colors';
import { attachLasso } from '../../utils/lasso';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

export default function TSNEScatterplot() {
  const svgRef = useRef(null);
  const cleanupRef = useRef(null);

  const tsneEmbeddings = useF1Store((s) => s.tsneEmbeddings);
  const loadTSNEEmbeddings = useF1Store((s) => s.loadTSNEEmbeddings);
  const selectedTSNEPoints = useF1Store((s) => s.selectedTSNEPoints);
  const setSelectedTSNEPoints = useF1Store((s) => s.setSelectedTSNEPoints);
  const fetchTSNEAnalysis = useF1Store((s) => s.fetchTSNEAnalysis);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);

  // Load embeddings on mount
  useEffect(() => {
    loadTSNEEmbeddings();
  }, [loadTSNEEmbeddings]);

  useEffect(() => {
    if (!svgRef.current || !tsneEmbeddings?.points?.length) return;

    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 500;
    const height = rect.height || 400;
    const margin = { top: 15, right: 15, bottom: 24, left: 15 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const points = tsneEmbeddings.points.filter((d) => isFinite(d.x) && isFinite(d.y));
    if (points.length === 0) return;

    // Scales
    const xExtent = d3.extent(points, (d) => d.x);
    const yExtent = d3.extent(points, (d) => d.y);
    const xPad = (xExtent[1] - xExtent[0]) * 0.1;
    const yPad = (yExtent[1] - yExtent[0]) * 0.1;

    const x = d3.scaleLinear()
      .domain([xExtent[0] - xPad, xExtent[1] + xPad])
      .range([0, innerW]);
    const y = d3.scaleLinear()
      .domain([yExtent[0] - yPad, yExtent[1] + yPad])
      .range([innerH, 0]);

    // t-SNE axes have no inherent meaning — show proximity annotation instead
    // Subtle border to frame the plot area
    g.append('rect')
      .attr('width', innerW).attr('height', innerH)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.06)')
      .attr('rx', 4);

    // Proximity annotation (small icon + text in corner)
    const annG = g.append('g').attr('transform', `translate(6, ${innerH - 6})`);
    // Two small dots close together
    annG.append('circle').attr('cx', 0).attr('cy', 0).attr('r', 2.5).attr('fill', 'rgba(255,255,255,0.25)');
    annG.append('circle').attr('cx', 7).attr('cy', -2).attr('r', 2.5).attr('fill', 'rgba(255,255,255,0.25)');
    annG.append('text')
      .attr('x', 13).attr('y', 1)
      .attr('fill', 'rgba(255,255,255,0.25)')
      .attr('font-size', '8px')
      .text('= similar races (closer = more similar)');

    // Draw points
    const isCurrentRace = (d) => d.year === year && d.round === round;

    g.selectAll('.tsne-point')
      .data(points)
      .join('path')
      .attr('class', (d) => {
        let cls = 'tsne-point';
        if (isCurrentRace(d)) cls += ' tsne-point--current';
        if (selectedTSNEPoints.includes(d.id)) cls += ' selected';
        else if (selectedTSNEPoints.length > 0) cls += ' dimmed';
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
        const tooltip = d3.select('body').selectAll('.tsne-tooltip').data([0]).join('div')
          .attr('class', 'tooltip tsne-tooltip');
        tooltip.html(
          `<div class="tooltip-title" style="color:${getTeamColor(d.team)}">${d.driver} — ${d.race_name || 'R' + d.round}</div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Team</span><span class="tooltip-value">${d.team}</span></div>` +
          `<div class="tooltip-row"><span class="tooltip-label">Season</span><span class="tooltip-value">${d.year} R${d.round}</span></div>` +
          (d.finish_pos ? `<div class="tooltip-row"><span class="tooltip-label">Finish</span><span class="tooltip-value">P${d.finish_pos}</span></div>` : '') +
          (d.strategy ? `<div class="tooltip-row"><span class="tooltip-label">Strategy</span><span class="tooltip-value">${d.strategy}</span></div>` : '') +
          `<div style="margin-top:4px;font-size:8px;color:rgba(255,255,255,0.3)">Click to select | Shift+drag to lasso</div>`
        ).style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', function (event, d) {
        d3.select(this).attr('d', d3.symbol().type(isCurrentRace(d) ? d3.symbolStar : d3.symbolCircle).size(isCurrentRace(d) ? 120 : 50)());
        d3.select('body').select('.tsne-tooltip').classed('visible', false).style('opacity', 0);
      })
      .on('click', (event, d) => {
        const ids = selectedTSNEPoints.includes(d.id)
          ? selectedTSNEPoints.filter((id) => id !== d.id)
          : [...selectedTSNEPoints, d.id];
        setSelectedTSNEPoints(ids);
        if (ids.length > 0) {
          fetchTSNEAnalysis(ids);
          // Propagate unique drivers to Leaderboard
          const uniqueDrivers = [...new Set(ids.map((id) => points.find((p) => p.id === id)?.driver).filter(Boolean))];
          setSelectedDrivers(uniqueDrivers);
        } else {
          setSelectedDrivers([]);
        }
      });

    // Driver highlight rings (Leaderboard → t-SNE coordination)
    if (selectedDrivers.length > 0) {
      g.selectAll('.tsne-driver-ring')
        .data(points.filter((d) => selectedDrivers.includes(d.driver)))
        .join('circle')
        .attr('class', 'tsne-driver-ring')
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
        setSelectedTSNEPoints(ids);
        if (ids.length > 0) {
          fetchTSNEAnalysis(ids);
          // Propagate unique drivers to Leaderboard
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
      .attr('font-size', 9)
      .text('Shift+drag to select a cluster of similar races | Click to toggle individual points');

    // Selected count indicator
    if (selectedTSNEPoints.length > 0) {
      g.append('text')
        .attr('x', innerW - 4).attr('y', 12)
        .attr('text-anchor', 'end')
        .attr('fill', 'var(--color-f1-red)')
        .attr('font-size', 10)
        .attr('font-weight', 700)
        .text(`${selectedTSNEPoints.length} selected`);
    }

    return () => {
      d3.select('body').select('.tsne-tooltip').remove();
    };
  }, [tsneEmbeddings, selectedTSNEPoints, selectedDrivers, year, round, setSelectedTSNEPoints, setSelectedDrivers, fetchTSNEAnalysis]);

  // Cleanup lasso on unmount
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  // Build legend from unique teams + current race star
  const teamLegend = React.useMemo(() => {
    if (!tsneEmbeddings?.points) return [];
    const teams = [...new Set(tsneEmbeddings.points.map((p) => p.team))];
    const items = teams.slice(0, 10).map((t) => ({
      label: t,
      color: getTeamColor(t),
      shape: 'circle',
    }));
    items.push({ label: 'Current Race', color: '#ffd700', shape: 'star' });
    return items;
  }, [tsneEmbeddings]);

  return (
    <Panel title="t-SNE Strategy Space" controls={<Legend items={teamLegend} shape="circle" />}>
      <div className="viz-container">
        {tsneEmbeddings?.points?.length ? (
          <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        ) : tsneEmbeddings?.message ? (
          <div className="loading-placeholder">
            <span style={{ color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
              {tsneEmbeddings.message}
            </span>
          </div>
        ) : (
          <div className="loading-placeholder">
            <div className="spinner" />
            <span>Computing t-SNE embeddings from race data...</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
