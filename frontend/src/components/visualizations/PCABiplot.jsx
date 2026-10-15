import React, { useRef, useEffect, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store, sessionScopeOf, pcaRequestOf } from '../../store/useF1Store';
import { attachLasso } from '../../utils/lasso';
import {
  markPath, isLoadedRace, filterPoints, filterOptions, loadedRaceOf, causalPoints,
  pointFill, teamLegendItems, outcomeLegendItems, shapeLegendItems, tooltipHtml, COLOR_BY,
} from '../../utils/views/pcaBiplot';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';
import {
  CHART_FONT, TEXT_COLORS, GRID_COLORS, UI_COLORS, withAlpha, contextColor, SURFACES,
} from '../../utils/colors';

// Toggle button: active = the brush / selection blue with its border; a
// disabled toggle is muted (inactive component, WCAG 1.4.3 exempt)
const toggleStyle = (active, disabled = false) => ({
  padding: '2px 8px', fontSize: CHART_FONT.label, fontWeight: 700, letterSpacing: '0.05em',
  border: '1px solid', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
  background: active ? withAlpha(UI_COLORS.brush, 0.14) : 'transparent',
  borderColor: active ? UI_COLORS.brush : 'rgba(255,255,255,0.30)',
  color: disabled ? 'rgba(255,255,255,0.35)' : active ? UI_COLORS.brush : TEXT_COLORS.secondary,
  transition: 'all 0.12s',
});

export default function PCABiplot() {
  const svgRef = useRef(null);
  // The box the chart fills: it lays out again at each new size (D4)
  const box = useChartBox(svgRef);
  const cleanupRef = useRef(null);

  const pcaEmbeddings = useF1Store((s) => s.pcaEmbeddings);
  const loadPCAEmbeddings = useF1Store((s) => s.loadPCAEmbeddings);
  const selectedPCAPoints = useF1Store((s) => s.selectedPCAPoints);
  const setSelectedPCAPoints = useF1Store((s) => s.setSelectedPCAPoints);
  const fetchPCAAnalysis = useF1Store((s) => s.fetchPCAAnalysis);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  // The session on screen (never the pills, D7)
  const loadedYear = useF1Store((s) => sessionScopeOf(s)?.year ?? null);
  const loadedRound = useF1Store((s) => sessionScopeOf(s)?.round ?? null);
  const loadedType = useF1Store((s) => sessionScopeOf(s)?.sessionType ?? null);
  // Where the weekend's race stands at the clock on screen ('not-started',
  // 'running', 'ended'; store pcaRequestOf) and the key of the embeddings at
  // that clock (race, clock state, lap): strings, so the clock ticking within
  // a lap does not re-render the biplot
  const raceClock = useF1Store((s) => pcaRequestOf(s).raceClock);
  const requestKey = useF1Store((s) => pcaRequestOf(s).key);

  // Toggle for axis chrome (gridlines + labels + crosshair + loading arrows).
  // Some users want a clean point-cloud; others want the full biplot.
  const [showAxes, setShowAxes] = useState(true);
  // Which races are drawn ('all' | 'season' | 'race') and what the colour encodes
  const [filter, setFilter] = useState('all');
  const [colorBy, setColorBy] = useState('team');

  const loaded = useMemo(
    () => loadedRaceOf({ year: loadedYear, round: loadedRound, sessionType: loadedType }),
    [loadedYear, loadedRound, loadedType],
  );
  // Until the race has been run at the clock on screen its result is hidden
  // and its post-race rows are never drawn (its rows at the clock are)
  const resultHidden = loaded != null && raceClock !== 'ended';
  const allPoints = useMemo(() => pcaEmbeddings?.points || [], [pcaEmbeddings]);
  const points = useMemo(
    () => causalPoints(allPoints, { loaded, resultHidden }),
    [allPoints, loaded, resultHidden],
  );
  const options = useMemo(() => {
    // why the race on screen has no row yet at the clock (the answer for that race only)
    const cr = pcaEmbeddings?.current_race;
    const reason = cr && loaded && Number(cr.year) === loaded.year && Number(cr.round) === loaded.round
      ? cr.reason || null
      : null;
    return filterOptions(points, loaded, { raceClock: raceClock || 'ended', reason });
  }, [points, loaded, raceClock, pcaEmbeddings]);
  // A filter that keeps nothing (no loaded race, or one outside the set) falls back to all
  const activeFilter = options.find((o) => o.key === filter && !o.disabled) ? filter : 'all';
  const visible = useMemo(() => filterPoints(points, activeFilter, loaded), [points, activeFilter, loaded]);

  // Load the embeddings on mount and at each new clock key (the race on
  // screen, the state of its clock, a new lap): during a replay the race's
  // stars follow the laps completed so far
  useEffect(() => {
    loadPCAEmbeddings();
  }, [loadPCAEmbeddings, requestKey]);

  useEffect(() => {
    if (!svgRef.current || !points.length) return;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, { width: 500, height: 400 });
    const margin = { top: 15, right: 15, bottom: 36, left: 46 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const loadings = pcaEmbeddings.loadings || [];
    const explained = pcaEmbeddings.explained_variance || [];
    const pc1Label = pcaEmbeddings.pc1_label || 'PC1';
    const pc2Label = pcaEmbeddings.pc2_label || 'PC2';
    const ctx = { loaded, resultHidden };

    // Scales over every point, so a filter never moves the points it keeps
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

    // Axes — meaningful for PCA. Hidden when `showAxes` is false to give
    // a clean point-cloud view (handy for screenshots / exploration).
    if (showAxes) {
      const xAxis = d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat('');
      const yAxis = d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat('');

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(xAxis)
        .call((g) => g.selectAll('.tick line').attr('stroke', GRID_COLORS.grid))
        .call((g) => g.select('.domain').remove());

      g.append('g')
        .call(yAxis)
        .call((g) => g.selectAll('.tick line').attr('stroke', GRID_COLORS.grid))
        .call((g) => g.select('.domain').remove());

      // Axis labels with explained variance
      const pc1Pct = explained[0] ? `${(explained[0] * 100).toFixed(0)}%` : '';
      const pc2Pct = explained[1] ? `${(explained[1] * 100).toFixed(0)}%` : '';

      g.append('text')
        .attr('x', innerW / 2).attr('y', innerH + 28)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.label)
        .attr('font-weight', 600)
        .text(`PC1: ${pc1Label} (${pc1Pct})`);

      g.append('text')
        .attr('transform', `translate(-34, ${innerH / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.label)
        .attr('font-weight', 600)
        .text(`PC2: ${pc2Label} (${pc2Pct})`);

      // Crosshair at origin (average performance)
      const originX = x(0);
      const originY = y(0);
      if (originX > 0 && originX < innerW && originY > 0 && originY < innerH) {
        g.append('line')
          .attr('x1', originX).attr('y1', 0)
          .attr('x2', originX).attr('y2', innerH)
          .attr('stroke', GRID_COLORS.axis)
          .attr('stroke-dasharray', '4,4');
        g.append('line')
          .attr('x1', 0).attr('y1', originY)
          .attr('x2', innerW).attr('y2', originY)
          .attr('stroke', GRID_COLORS.axis)
          .attr('stroke-dasharray', '4,4');
        g.append('text')
          .attr('x', originX + 4).attr('y', 12)
          .attr('fill', TEXT_COLORS.muted)
          .style('font-size', CHART_FONT.label)
          .text('avg');
      }
    }

    // Feature loading arrows (top 8 by magnitude). Hidden when axes
    // are toggled off — without axes the arrows have no semantic
    // anchor (origin disappears) so it would just look noisy.
    const topLoadings = showAxes ? loadings.slice(0, 8) : [];
    // Recompute origin in case axes are off (we need it for arrow start).
    const originX = x(0);
    const originY = y(0);
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
        .attr('fill', TEXT_COLORS.muted);

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
          .attr('stroke', TEXT_COLORS.muted)
          .attr('stroke-width', 1.2)
          .attr('marker-end', 'url(#pca-arrow)');

        // Label at tip
        const labelOffsetX = dx > 0 ? 4 : -4;
        const labelOffsetY = dy > 0 ? 10 : -4;
        arrowG.append('text')
          .attr('x', endX + labelOffsetX).attr('y', endY + labelOffsetY)
          .attr('text-anchor', dx > 0 ? 'start' : 'end')
          .attr('fill', TEXT_COLORS.secondary)
          .style('font-size', CHART_FONT.data)
          .attr('font-weight', 600)
          .text(l.label);
      });
    }

    const selectPoints = (ids) => {
      setSelectedPCAPoints(ids);
      if (ids.length > 0) {
        fetchPCAAnalysis(ids);
        const uniqueDrivers = [...new Set(ids.map((id) => points.find((p) => p.id === id)?.driver).filter(Boolean))];
        setSelectedDrivers(uniqueDrivers);
      } else {
        setSelectedDrivers([]);
      }
    };

    // Draw the points the filter keeps: star = a row of the race on screen,
    // fill = team or outcome class ('none' = result not shown: outline only)
    const isLoaded = (d) => isLoadedRace(d, loaded);
    const isContextPoint = (d) => selectedPCAPoints.length > 0 && !selectedPCAPoints.includes(d.id);

    g.selectAll('.pca-point')
      .data(visible, (d) => d.id)
      .join('path')
      .attr('class', (d) => {
        let cls = 'pca-point'; // reuse same CSS class
        if (isLoaded(d)) cls += ' pca-point--current';
        if (selectedPCAPoints.includes(d.id)) cls += ' selected';
        else if (selectedPCAPoints.length > 0) cls += ' dimmed';
        return cls;
      })
      .attr('transform', (d) => `translate(${x(d.x)},${y(d.y)})`)
      .attr('d', (d) => markPath(isLoaded(d)))
      // a point outside the selection is context (D7): its colour mixed
      // toward the panel (contextColor, >= 2:1), never an opacity (the CSS
      // opacity 0.15 of .pca-point.dimmed read under 2:1)
      .attr('fill', (d) => {
        const f = pointFill(d, colorBy, ctx);
        return f !== 'none' && isContextPoint(d) ? contextColor(f, SURFACES.panel) : f;
      })
      // hit on the whole mark, outline-only marks included
      .attr('pointer-events', 'visible')
      .each(function outline(d) {
        // an outline-only circle gets a visible stroke (stars have the CSS one)
        if (pointFill(d, colorBy, ctx) === 'none' && !isLoaded(d)) {
          d3.select(this)
            .style('stroke', isContextPoint(d) ? contextColor(TEXT_COLORS.secondary, SURFACES.panel) : 'var(--color-text-secondary)')
            .style('stroke-width', 1.5);
        }
      })
      .on('mouseenter', function (event, d) {
        d3.select(this).attr('d', markPath(isLoaded(d), true));
        const tooltip = d3.select('body').selectAll('.pca-tooltip').data([0]).join('div')
          .attr('class', 'tooltip pca-tooltip');
        tooltip.html(tooltipHtml(d, ctx))
          .style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', function (event, d) {
        d3.select(this).attr('d', markPath(isLoaded(d)));
        d3.select('.pca-tooltip').classed('visible', false).style('opacity', 0);
      })
      .on('click', (event, d) => {
        const ids = selectedPCAPoints.includes(d.id)
          ? selectedPCAPoints.filter((id) => id !== d.id)
          : [...selectedPCAPoints, d.id];
        selectPoints(ids);
      });

    // Driver highlight rings (Leaderboard coordination)
    if (selectedDrivers.length > 0) {
      g.selectAll('.pca-driver-ring')
        .data(visible.filter((d) => selectedDrivers.includes(d.driver)))
        .join('circle')
        .attr('class', 'pca-driver-ring')
        .attr('cx', (d) => x(d.x))
        .attr('cy', (d) => y(d.y))
        .attr('r', 8)
        .attr('fill', 'none')
        .attr('stroke', TEXT_COLORS.primary)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3,2')
        .attr('pointer-events', 'none');
    }

    // Lasso selection (shift+drag) over the points drawn
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = attachLasso(g, {
      getPoints: () =>
        visible.map((d) => ({ x: x(d.x), y: y(d.y), id: d.id })),
      onSelect: selectPoints,
    });

    // Info text
    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 16)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label)
      .text('Arrows show which features drive each axis | Shift+drag to lasso');

    // Selected count
    if (selectedPCAPoints.length > 0) {
      g.append('text')
        .attr('x', innerW - 4).attr('y', 12)
        .attr('text-anchor', 'end')
        .attr('fill', TEXT_COLORS.primary)
        .style('font-size', CHART_FONT.label)
        .attr('font-weight', 700)
        .text(`${selectedPCAPoints.length} selected`);
    }

  }, [pcaEmbeddings, points, visible, loaded, resultHidden, colorBy, selectedPCAPoints, selectedDrivers,
    setSelectedPCAPoints, setSelectedDrivers, fetchPCAAnalysis, showAxes, box.width, box.height]);

  // Cleanup lasso on unmount
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  // Legends of the two encodings: colour (team or outcome) and shape
  const colorLegend = useMemo(
    () => (colorBy === 'finish'
      ? outcomeLegendItems(visible, { loaded, resultHidden })
      : teamLegendItems(visible)),
    [colorBy, visible, loaded, resultHidden],
  );
  const shapeLegend = useMemo(() => shapeLegendItems(visible, loaded), [visible, loaded]);

  const clearSelection = () => {
    setSelectedPCAPoints([]);
    setSelectedDrivers([]);
  };

  return (
    <Panel
      title="PCA Biplot"
      controls={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span role="radiogroup" aria-label="Races drawn" style={{ display: 'inline-flex', gap: 2 }}>
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={activeFilter === o.key}
                disabled={o.disabled}
                style={toggleStyle(activeFilter === o.key, o.disabled)}
                onClick={() => setFilter(o.key)}
                title={o.title}
              >
                {o.label}
              </button>
            ))}
          </span>
          <span role="radiogroup" aria-label="Colour encodes" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, marginRight: 2 }}>Colour</span>
            {COLOR_BY.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={colorBy === c.key}
                style={toggleStyle(colorBy === c.key)}
                onClick={() => setColorBy(c.key)}
                title={c.key === 'finish'
                  ? 'Colour = finishing position (podium, points, no points)'
                  : 'Colour = team'}
              >
                {c.label}
              </button>
            ))}
          </span>
          <button
            type="button"
            style={toggleStyle(showAxes)}
            onClick={() => setShowAxes((v) => !v)}
            title={showAxes
              ? 'Hide PCA axes, gridlines, and feature-loading arrows'
              : 'Show PCA axes, gridlines, and feature-loading arrows'}
          >
            {showAxes ? 'AXES ON' : 'AXES OFF'}
          </button>
        </span>
      )}
    >
      {points.length > 0 && (
        <div className="pca-legends" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, flexShrink: 0 }}>
          <Legend
            title={colorBy === 'finish' ? 'Colour: finish' : 'Colour: team'}
            items={colorLegend}
            shape="symbol"
          />
          {shapeLegend.length > 0 && <Legend title="Shape" items={shapeLegend} shape="symbol" />}
        </div>
      )}
      <div className="viz-container" style={{ position: 'relative' }}>
        {points.length ? (
          <>
            <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
            {selectedPCAPoints.length > 0 && (
              <button
                onClick={clearSelection}
                style={{
                  position: 'absolute', top: 6, left: 6,
                  background: withAlpha(UI_COLORS.brush, 0.15), border: `1px solid ${UI_COLORS.brush}`,
                  borderRadius: 4, padding: '2px 8px', fontSize: CHART_FONT.label, fontWeight: 600,
                  color: TEXT_COLORS.primary, cursor: 'pointer', zIndex: 2,
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
