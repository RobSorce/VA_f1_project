import React, { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import {
  getDriverColor, contrastText, contextColor, STATUS_COLORS, TEXT_COLORS, GRID_COLORS, SURFACES, CHART_FONT,
  chartFontPx,
} from '../../utils/colors';
import { useChartBox } from '../../utils/views/chartBox';
import {
  bestGapRows, bestValueLabel, bestChartMargins, bestRowHeight, gapTick, GAP_BAR_COLOR, BEST_RANK_W, BEST_BADGE_W,
  BEST_AXIS_H,
} from '../../utils/views/sectorsBestChart';

// Size drawn at before the column is measured (no layout: tests, server render)
const FALLBACK = { width: 240, height: 420 };
// Background of the hovered row, and the surface the context colours mix toward
const HOVER_FILL = 'rgba(255,255,255,0.06)';
const SURFACE = SURFACES.panel;
const NO_DRIVERS = [];
const noop = () => {};

/**
 * One sector of the Sectors panel's "Best" tab (D5): a D3 chart of every
 * driver's best sector time as the gap to the session best, in ranking
 * order. Band scale of the drivers (rank, team badge with the code in
 * contrastText), linear scale of the gap (bars from 0, one scale for every
 * page of the sector), the value next to each bar (the best's own time, with
 * ◆), the gap axis in s under the rows when the column has room for it.
 * The ranks on the page and the row height are the panel's fit
 * (SectorsPanel.jsx: 18 px at the least, the ranks paged below that, D1);
 * the chart lays out again when its column is resized (useChartBox, D4).
 * Hover highlights a driver, a click makes him the focus (the panel's store
 * links, passed in); a context row (not selected, or another hovered) is
 * mixed toward the panel (contextColor, D7), its text in the muted colour.
 *
 * @param {Object} props
 * @param {string} props.sector - '1' | '2' | '3'
 * @param {Array<Object>} props.items - sectorsPanelData bestRankings[sector], every rank
 * @param {number|null} props.sessionBest - bestSessionBests[sector]
 * @param {number} [props.rowStart=0] - first rank of the page (0-based)
 * @param {number} [props.rowEnd] - end of the page (exclusive; default every rank)
 * @param {number} [props.rowH] - row height (px) of the panel's fit
 * @param {string[]} [props.selectedDrivers]
 * @param {string|null} [props.highlightedDriver]
 * @param {function(string|null)} [props.onHighlight] - hover (null on leave)
 * @param {function(string)} [props.onFocus] - click
 */
export default function SectorsBestChart({
  sector, items, sessionBest, rowStart = 0, rowEnd, rowH,
  selectedDrivers = NO_DRIVERS, highlightedDriver = null, onHighlight = noop, onFocus = noop,
}) {
  const svgRef = useRef(null);
  // The box of the column body the chart fills, kept up to date (D4)
  const box = useChartBox(svgRef);

  const rows = useMemo(() => bestGapRows(items, sessionBest), [items, sessionBest]);
  const shown = useMemo(
    () => rows.slice(Math.max(0, rowStart), rowEnd == null ? rows.length : rowEnd),
    [rows, rowStart, rowEnd],
  );
  const size = box.width > 0 && box.height > 0 ? box : FALLBACK;

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    const { width, height } = size;
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    if (!shown.length) return;

    const m = bestChartMargins({ width, rows, fontPx: chartFontPx('data') });
    const rh = bestRowHeight(rowH, height, shown.length);
    const right = Math.max(m.left + 10, width - m.right);
    // one gap scale for every page of the sector (the bars compare across pages)
    const maxGap = d3.max(rows, (r) => r.gap) || 0.001;
    const x = d3.scaleLinear().domain([0, maxGap]).nice(4).range([m.left, right]);
    const y = d3.scaleBand().domain(shown.map((r) => r.driver)).range([m.top, m.top + shown.length * rh]);

    const isContext = (d) => (selectedDrivers.length > 0 && !selectedDrivers.includes(d))
      || (!!highlightedDriver && highlightedDriver !== d);

    const rowG = svg.append('g').attr('class', 'sectors-best-rows')
      .selectAll('g').data(shown, (r) => r.driver).enter()
      .append('g')
      .attr('class', 'sectors-best-row')
      .attr('data-driver', (r) => r.driver)
      .attr('transform', (r) => `translate(0,${y(r.driver)})`)
      .style('cursor', 'pointer')
      .on('mouseenter', (event, r) => onHighlight(r.driver))
      .on('mouseleave', () => onHighlight(null))
      .on('click', (event, r) => onFocus(r.driver));

    // hit area (and the hovered row's background); the full value in its title
    rowG.append('rect')
      .attr('class', 'sectors-best-hit')
      .attr('x', 0).attr('y', 0)
      .attr('width', width).attr('height', rh)
      .attr('fill', (r) => (r.driver === highlightedDriver ? HOVER_FILL : 'transparent'))
      .append('title')
      .text((r) => `P${r.rank} ${r.driver}  S${sector} ${r.time.toFixed(3)} s${r.isBest ? ' (session best)' : `  +${r.gap.toFixed(3)} s`}`);

    // rank
    rowG.append('text')
      .attr('class', 'sectors-best-rank')
      .attr('x', BEST_RANK_W - 4).attr('y', rh / 2)
      .attr('text-anchor', 'end').attr('dominant-baseline', 'central')
      .attr('fill', (r) => (isContext(r.driver) ? TEXT_COLORS.muted : TEXT_COLORS.secondary))
      .style('font-size', CHART_FONT.data)
      .attr('font-family', 'var(--font-mono)')
      .text((r) => r.rank);

    // team badge, the code in contrastText on it
    const badgeFill = (r) => {
      const c = getDriverColor(r.driver);
      return isContext(r.driver) ? contextColor(c, SURFACE) : c;
    };
    rowG.append('rect')
      .attr('class', 'sectors-best-badge')
      .attr('x', BEST_RANK_W).attr('y', 2)
      .attr('width', BEST_BADGE_W).attr('height', Math.max(0, rh - 4))
      .attr('rx', 3)
      .attr('fill', badgeFill);
    rowG.append('text')
      .attr('class', 'sectors-best-code')
      .attr('x', BEST_RANK_W + BEST_BADGE_W / 2).attr('y', rh / 2)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
      .attr('fill', (r) => contrastText(badgeFill(r)))
      .style('font-size', CHART_FONT.data)
      .attr('font-weight', 700)
      .text((r) => r.driver);

    // the gap: a bar from 0 (none for the best)
    rowG.filter((r) => !r.isBest).append('rect')
      .attr('class', 'sectors-best-bar')
      .attr('data-driver', (r) => r.driver)
      .attr('x', x(0)).attr('y', rh * 0.25)
      .attr('width', (r) => Math.max(0, x(r.gap) - x(0)))
      .attr('height', rh * 0.5)
      .attr('rx', 1.5)
      .attr('fill', (r) => (isContext(r.driver) ? contextColor(GAP_BAR_COLOR, SURFACE) : GAP_BAR_COLOR));

    // its value next to it: the best's time with ◆, "+0.123" for the others;
    // a context row's text in the muted colour (>= 4.5:1), never faded
    rowG.append('text')
      .attr('class', 'sectors-best-value')
      .attr('x', (r) => (r.isBest ? x(0) : x(r.gap)) + 4).attr('y', rh / 2)
      .attr('dominant-baseline', 'central')
      .attr('fill', (r) => {
        if (isContext(r.driver)) return TEXT_COLORS.muted;
        return r.isBest ? STATUS_COLORS.overallBest : TEXT_COLORS.primary;
      })
      .style('font-size', CHART_FONT.data)
      .attr('font-family', 'var(--font-mono)')
      .attr('font-weight', (r) => (r.isBest ? 700 : 400))
      .text((r) => bestValueLabel(r));

    // the gap axis in s under the rows, when the column has room for it (the
    // values are written next to the bars whatever the room)
    const axisY = m.top + shown.length * rh;
    if (height - axisY < BEST_AXIS_H) return;
    const tickCount = Math.max(2, Math.floor((right - m.left) / 56));
    const ticks = x.ticks(tickCount);
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 0.1;
    const axis = svg.append('g')
      .attr('class', 'sectors-best-axis')
      .attr('transform', `translate(0,${axisY + 2})`)
      .call(d3.axisBottom(x).tickValues(ticks).tickSizeOuter(0)
        .tickFormat((v, i) => gapTick(v, step, i === ticks.length - 1)));
    axis.selectAll('path, line').attr('stroke', GRID_COLORS.axis);
    axis.selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);
    // the last tick ends at the scale's end (its unit stays in the box)
    axis.selectAll('.tick').filter((d, i, nodes) => i === nodes.length - 1).select('text')
      .attr('text-anchor', 'end').attr('dx', '0.4em');
  }, [rows, shown, rowH, size.width, size.height, selectedDrivers, highlightedDriver, onHighlight, onFocus, sector]);

  return (
    <div className="sectors-best" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
      <svg
        ref={svgRef}
        className="sectors-best-chart"
        aria-label={`Sector ${sector}: gap of every driver's best to the session best`}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}
