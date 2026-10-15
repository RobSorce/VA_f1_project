/**
 * D3 drawing of the sector delta waterfall (components/visualizations/SectorDeltaWaterfall.jsx).
 *
 * One column per lap both drivers completed (oldest left, most recent right).
 * In each column three bars, S1, S2 and S3 from left to right: S1 starts at
 * 0 and each next sector starts where the previous one ended, so the column
 * climbs or falls sector by sector to the lap's delta, marked by a bar across
 * the column (the lap total). Delta = focus minus reference, in seconds: up
 * (+) the focus was slower, down (-) faster. The colour repeats the direction
 * (diverging pair of utils/colors.js), so the sign never rests on colour
 * alone; the y axis is signed and the legend names both.
 *
 * Pure D3 into the given <svg>: the geometry comes from
 * utils/views/sectorDeltaWaterfall.js; no React, no store.
 */
import * as d3 from 'd3';
import { waterfallSteps, fmtDelta } from './sectorDeltaWaterfall';
import { drawLegend } from './d3Legend';

/** Margins of the plot inside the <svg> (the legend sits in the top one). */
export const WATERFALL_MARGIN = Object.freeze({ top: 8, right: 10, bottom: 24, left: 54 });

const stepKind = (v) => (v < 0 ? 'faster' : v > 0 ? 'slower' : 'even');

/**
 * Draw (or redraw) the waterfall.
 *
 * @param {SVGSVGElement} svgNode
 * @param {Object} o
 * @param {Array<Object>} o.laps - sectorDeltaRows rows to draw, oldest first (waterfallLaps)
 * @param {[number, number]} o.domain - seconds (waterfallDomain)
 * @param {number} o.width - px
 * @param {number} o.height - px
 * @param {string} o.focus
 * @param {string} o.reference
 * @param {{faster: string, slower: string, even: string, text: string, muted: string, grid: string}} o.colors
 * @param {string} o.font - CSS font size of ticks and labels (colors.js CHART_FONT.data, >= 11 px)
 * @param {number} o.fontPx - the px it resolves to (colors.js chartFontPx('data')), for the layout
 * @returns {{plotWidth: number, plotHeight: number, legendHeight: number}}
 */
export function drawSectorDeltaWaterfall(svgNode, {
  laps, domain, width, height, focus, reference, colors, font, fontPx,
}) {
  const svg = d3.select(svgNode)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', `Sector delta waterfall: ${focus} minus ${reference}, seconds, by lap and sector`);
  const m = WATERFALL_MARGIN;

  // Legend first: its height decides the plot's top
  const legend = svg.selectAll('g.sdw-legend').data([0]).join('g').attr('class', 'sdw-legend chart-legend');
  const legendHeight = drawLegend(legend, [
    { key: 'faster', label: `▼ ${focus} faster (−)`, shape: 'rect', color: colors.faster },
    { key: 'slower', label: `▲ ${focus} slower (+)`, shape: 'rect', color: colors.slower },
    { key: 'total', label: 'lap total', shape: 'line', color: colors.text },
    { key: 'order', label: 'bars S1 → S2 → S3', shape: 'dash', color: colors.muted },
  ], {
    font, fontPx, maxWidth: Math.max(60, width - 8), textColor: colors.text,
  });
  legend.attr('transform', `translate(4,${m.top})`);

  const top = m.top + legendHeight + 6;
  const iw = Math.max(0, width - m.left - m.right);
  const ih = Math.max(0, height - top - m.bottom);
  const x0 = d3.scaleBand().domain(laps.map((r) => r.lap)).range([0, iw]).paddingInner(0.3).paddingOuter(0.15);
  const x1 = d3.scaleBand().domain([1, 2, 3]).range([0, x0.bandwidth()]).padding(0.12);
  const y = d3.scaleLinear().domain(domain).nice(4).range([ih, 0]);

  const root = svg.selectAll('g.sdw-plot').data([0]).join('g')
    .attr('class', 'sdw-plot')
    .attr('transform', `translate(${m.left},${top})`);

  // y axis: signed seconds, grid lines across the plot
  const yTicks = Math.max(2, Math.min(6, Math.floor(ih / (fontPx * 2.6))));
  root.selectAll('g.sdw-y').data([0]).join('g')
    .attr('class', 'sdw-y sdw-axis')
    .call(d3.axisLeft(y).ticks(yTicks).tickFormat((d) => fmtDelta(d, 2)).tickSize(-iw).tickPadding(6))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.select('.domain').remove())
    .call((g) => g.selectAll('.tick line').attr('stroke', colors.grid))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text));
  root.selectAll('text.sdw-y-title').data([0]).join('text')
    .attr('class', 'sdw-y-title')
    .attr('transform', `translate(${-m.left + fontPx},${ih / 2}) rotate(-90)`)
    .attr('text-anchor', 'middle')
    .style('font-size', font)
    .attr('fill', colors.text)
    .text(`${focus} − ${reference} (s)`);

  // x axis: the laps (every k-th label when the columns are narrow)
  const every = Math.max(1, Math.ceil((fontPx * 2.4) / Math.max(1, x0.step())));
  root.selectAll('g.sdw-x').data([0]).join('g')
    .attr('class', 'sdw-x sdw-axis')
    .attr('transform', `translate(0,${ih})`)
    .call(d3.axisBottom(x0).tickValues(laps.map((r) => r.lap).filter((_, i, a) => (a.length - 1 - i) % every === 0))
      .tickFormat((d) => `L${d}`).tickSizeOuter(0))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.selectAll('.domain, .tick line').attr('stroke', colors.muted))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text));

  // zero line: the reference driver
  root.selectAll('line.sdw-zero').data([0]).join('line')
    .attr('class', 'sdw-zero')
    .attr('x1', 0).attr('x2', iw)
    .attr('y1', y(0)).attr('y2', y(0))
    .attr('stroke', colors.text)
    .attr('stroke-width', 1);

  const cols = root.selectAll('g.sdw-lap').data(laps, (r) => r.lap).join('g')
    .attr('class', 'sdw-lap')
    .attr('data-lap', (r) => r.lap)
    .attr('transform', (r) => `translate(${x0(r.lap)},0)`);

  cols.each(function drawLap(row) {
    const { steps, total } = waterfallSteps(row);
    const g = d3.select(this);
    const drawn = steps.filter((s) => !s.missing);
    g.selectAll('rect.sdw-step').data(drawn, (s) => s.sector).join('rect')
      .attr('class', (s) => `sdw-step sdw-step--${stepKind(s.value)}`)
      .attr('data-sector', (s) => s.sector)
      .attr('data-value', (s) => s.value)
      .attr('x', (s) => x1(s.sector))
      .attr('width', x1.bandwidth())
      .attr('y', (s) => y(Math.max(s.from, s.to)))
      .attr('height', (s) => Math.max(1, Math.abs(y(s.from) - y(s.to))))
      .attr('fill', (s) => colors[stepKind(s.value)])
      .selectAll('title').data((s) => [s]).join('title')
      .text((s) => `Lap ${row.lap}, sector ${s.sector}: ${focus} ${fmtDelta(s.value)} s against ${reference}`
        + ` (${stepKind(s.value) === 'even' ? 'level' : stepKind(s.value)}); running total ${fmtDelta(s.to)} s`);
    // dashed links: the end of one sector is the start of the next
    const links = [0, 1].map((i) => ({ a: steps[i], b: steps[i + 1] })).filter(({ a, b }) => !a.missing && !b.missing);
    g.selectAll('line.sdw-link').data(links, (l) => l.a.sector).join('line')
      .attr('class', 'sdw-link')
      .attr('x1', (l) => x1(l.a.sector) + x1.bandwidth())
      .attr('x2', (l) => x1(l.b.sector))
      .attr('y1', (l) => y(l.a.to))
      .attr('y2', (l) => y(l.a.to))
      .attr('stroke', colors.muted)
      .attr('stroke-dasharray', '2,2');
    // a sector without a time on either car: '?' where its bar would start
    g.selectAll('text.sdw-missing').data(steps.filter((s) => s.missing), (s) => s.sector).join('text')
      .attr('class', 'sdw-missing')
      .attr('x', (s) => x1(s.sector) + x1.bandwidth() / 2)
      .attr('y', (s) => y(s.from) - 3)
      .attr('text-anchor', 'middle')
      .style('font-size', font)
      .attr('fill', colors.text)
      .text('?')
      .selectAll('title').data((s) => [s]).join('title')
      .text((s) => `Lap ${row.lap}, sector ${s.sector}: no time for one of the two drivers (no lap total)`);
    g.selectAll('line.sdw-total').data(total == null ? [] : [total]).join('line')
      .attr('class', 'sdw-total')
      .attr('data-value', (t) => t)
      .attr('x1', -2)
      .attr('x2', x0.bandwidth() + 2)
      .attr('y1', (t) => y(t))
      .attr('y2', (t) => y(t))
      .attr('stroke', colors.text)
      .attr('stroke-width', 2)
      .selectAll('title').data((t) => [t]).join('title')
      .text((t) => `Lap ${row.lap}: ${focus} ${fmtDelta(t)} s against ${reference} over the lap`);
  });

  return { plotWidth: iw, plotHeight: ih, legendHeight };
}
