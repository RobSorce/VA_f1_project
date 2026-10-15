/**
 * D3 drawing of the Undercut Calculator's pit-lap sweep
 * (components/visualizations/UndercutCalculator.jsx).
 *
 * One column per candidate in-lap of the focus driver, left to right in race
 * order (the lap in progress, "NOW", first). The bar is the projected gap to
 * the rival at the horizon (utils/undercut.js undercutSweep: the same lap for
 * every column), on a signed y axis: up (+) = focus ahead, down (−) = focus
 * behind. The colour repeats the direction (diverging pair of
 * utils/colors.js, blue / orange) and the legend names it with ▲ / ▼, so the
 * sign never rests on colour alone. The best column (the largest gap) carries
 * a diamond at the bar's end and its value; a column charged extra stops
 * carries "+n" at the zero line, on the side away from its bar.
 *
 * Every column fits the width (no scroll): narrow columns thin the x labels
 * and drop the per-column values, never a column.
 *
 * Pure D3 into the given <svg>; no React, no store.
 */
import * as d3 from 'd3';
import { drawLegend } from './d3Legend';

/** Margins of the plot inside the <svg> (the legend sits in the top one). */
export const SWEEP_MARGIN = Object.freeze({ top: 4, right: 8, bottom: 22, left: 52 });

/** Smallest half-range of the y axis, seconds (a flat sweep is not stretched). */
export const SWEEP_MIN_HALF_S = 1;

/** Signed seconds: '+1.24' / '−2.71' / '0.00'. */
export function signedSeconds(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v).toFixed(digits);
  if (Number(abs) === 0) return abs;
  return `${v > 0 ? '+' : '−'}${abs}`;
}

/**
 * Value domain of the sweep: 0 and every gap, at least ±SWEEP_MIN_HALF_S.
 *
 * @param {Array<{gap: number}>} rows
 * @returns {[number, number]}
 */
export function sweepDomain(rows) {
  let lo = -SWEEP_MIN_HALF_S;
  let hi = SWEEP_MIN_HALF_S;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (Number.isFinite(r?.gap)) { lo = Math.min(lo, r.gap); hi = Math.max(hi, r.gap); }
  }
  return [lo, hi];
}

const kindOf = (gap) => (gap > 0 ? 'ahead' : gap < 0 ? 'behind' : 'even');

/**
 * Draw (or redraw) the sweep.
 *
 * @param {SVGSVGElement} svgNode
 * @param {Object} o
 * @param {Array<{key: string, label: string, gap: number, extra: number, title: string}>} o.rows
 *   in race order; label = the x tick ("NOW", "L23"), extra = extra stops charged
 * @param {string} o.bestKey - key of the best row
 * @param {number} o.width - px
 * @param {number} o.height - px
 * @param {string} o.focus
 * @param {{ahead: string, behind: string, even: string, text: string, muted: string, grid: string, axis: string}} o.colors
 * @param {string} o.font - CSS font size of ticks and labels (colors.js CHART_FONT.data, >= 11 px)
 * @param {number} o.fontPx - the px it resolves to (colors.js chartFontPx('data'))
 * @param {string} o.legendFont - CSS font size of the legend (colors.js CHART_FONT.data: D3 text >= 11 px)
 * @param {number} o.legendFontPx
 * @returns {{plotWidth: number, plotHeight: number, legendHeight: number, labelEvery: number, values: boolean}}
 */
export function drawUndercutSweep(svgNode, {
  rows, bestKey, width, height, focus, colors, font, fontPx, legendFont, legendFontPx,
}) {
  const m = SWEEP_MARGIN;
  const svg = d3.select(svgNode)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', `Pit-lap sweep: projected gap of ${focus} to the rival at the horizon for each candidate in-lap, seconds, + = ${focus} ahead`);

  const legend = svg.selectAll('g.ucs-legend').data([0]).join('g').attr('class', 'ucs-legend chart-legend');
  const legendHeight = drawLegend(legend, [
    { key: 'ahead', label: `▲ ${focus} ahead (+)`, shape: 'rect', color: colors.ahead },
    { key: 'behind', label: `▼ ${focus} behind (−)`, shape: 'rect', color: colors.behind },
    { key: 'best', label: 'best pit lap', shape: 'diamond', color: colors.text },
    { key: 'extra', label: '+n: extra stops charged', shape: 'none', color: colors.text },
  ], {
    font: legendFont, fontPx: legendFontPx, maxWidth: Math.max(60, width - 8), textColor: colors.text,
  });
  legend.attr('transform', `translate(4,${m.top})`);

  const top = m.top + legendHeight + 4;
  const iw = Math.max(0, width - m.left - m.right);
  const ih = Math.max(0, height - top - m.bottom);
  const x = d3.scaleBand().domain(rows.map((r) => r.key)).range([0, iw]).paddingInner(0.25).paddingOuter(0.1);
  const y = d3.scaleLinear().domain(sweepDomain(rows)).nice(4).range([ih, 0]);
  // per-column values when a column holds "+12.34" at the data size
  const values = x.bandwidth() >= fontPx * 3.2;
  const labelEvery = Math.max(1, Math.ceil((fontPx * 3) / Math.max(1, x.step())));

  const root = svg.selectAll('g.ucs-plot').data([0]).join('g')
    .attr('class', 'ucs-plot')
    .attr('transform', `translate(${m.left},${top})`);

  const yTicks = Math.max(2, Math.min(6, Math.floor(ih / (fontPx * 2.6))));
  root.selectAll('g.ucs-y').data([0]).join('g')
    .attr('class', 'ucs-y ucs-axis')
    .call(d3.axisLeft(y).ticks(yTicks).tickFormat((d) => signedSeconds(d, Math.abs(d) < 1 && d !== 0 ? 1 : 0)).tickSize(-iw).tickPadding(6))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.select('.domain').remove())
    .call((g) => g.selectAll('.tick line').attr('stroke', colors.grid))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text));
  root.selectAll('text.ucs-y-title').data([0]).join('text')
    .attr('class', 'ucs-y-title')
    .attr('transform', `translate(${-m.left + fontPx},${ih / 2}) rotate(-90)`)
    .attr('text-anchor', 'middle')
    .style('font-size', font)
    .attr('fill', colors.text)
    .text('gap at horizon (s)');

  const tickKeys = rows.map((r) => r.key).filter((_, i) => i % labelEvery === 0);
  root.selectAll('g.ucs-x').data([0]).join('g')
    .attr('class', 'ucs-x ucs-axis')
    .attr('transform', `translate(0,${ih})`)
    .call(d3.axisBottom(x).tickValues(tickKeys).tickFormat((k) => rows.find((r) => r.key === k)?.label ?? k).tickSizeOuter(0))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.selectAll('.domain, .tick line').attr('stroke', colors.axis))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text));

  root.selectAll('line.ucs-zero').data([0]).join('line')
    .attr('class', 'ucs-zero')
    .attr('x1', 0).attr('x2', iw)
    .attr('y1', y(0)).attr('y2', y(0))
    .attr('stroke', colors.text)
    .attr('stroke-width', 1);

  const cols = root.selectAll('g.ucs-col').data(rows, (r) => r.key).join((enter) => {
    const g = enter.append('g').attr('class', 'ucs-col');
    g.append('rect').attr('class', 'ucs-bar');
    g.append('title');
    return g;
  })
    .attr('data-key', (r) => r.key)
    .attr('data-gap', (r) => r.gap)
    .attr('transform', (r) => `translate(${x(r.key)},0)`);

  cols.select('rect.ucs-bar')
    .attr('class', (r) => `ucs-bar ucs-bar--${kindOf(r.gap)}${r.key === bestKey ? ' ucs-bar--best' : ''}`)
    .attr('x', 0)
    .attr('width', x.bandwidth())
    .attr('y', (r) => y(Math.max(0, r.gap)))
    .attr('height', (r) => Math.max(1, Math.abs(y(r.gap) - y(0))))
    .attr('fill', (r) => colors[kindOf(r.gap)])
    .attr('stroke', (r) => (r.key === bestKey ? colors.text : 'none'))
    .attr('stroke-width', (r) => (r.key === bestKey ? 2 : 0));
  cols.select('title').text((r) => r.title);

  // value at the end of each bar (every column when they are wide enough, else the best only)
  const valueRows = rows.filter((r) => values || r.key === bestKey);
  root.selectAll('text.ucs-value').data(valueRows, (r) => r.key).join('text')
    .attr('class', 'ucs-value')
    .attr('data-key', (r) => r.key)
    .attr('x', (r) => x(r.key) + x.bandwidth() / 2)
    .attr('y', (r) => (r.gap >= 0 ? y(r.gap) - 4 - (r.key === bestKey ? 9 : 0) : y(r.gap) + fontPx + 2 + (r.key === bestKey ? 9 : 0)))
    .attr('text-anchor', 'middle')
    .style('font-size', font)
    .attr('font-weight', (r) => (r.key === bestKey ? 800 : 600))
    .attr('fill', colors.text)
    .text((r) => signedSeconds(r.gap, 1));

  // diamond at the end of the best bar
  const best = rows.find((r) => r.key === bestKey);
  root.selectAll('path.ucs-best').data(best ? [best] : []).join('path')
    .attr('class', 'ucs-best')
    .attr('d', (r) => {
      const cx = x(r.key) + x.bandwidth() / 2;
      const cy = r.gap >= 0 ? y(r.gap) - 5 : y(r.gap) + 5;
      return `M${cx},${cy - 5}L${cx + 5},${cy}L${cx},${cy + 5}L${cx - 5},${cy}Z`;
    })
    .attr('fill', colors.text)
    .attr('stroke', colors.grid);

  // "+n" extra stops, at the zero line on the side away from the bar
  root.selectAll('text.ucs-extra').data(rows.filter((r) => r.extra > 0), (r) => r.key).join('text')
    .attr('class', 'ucs-extra')
    .attr('data-key', (r) => r.key)
    .attr('x', (r) => x(r.key) + x.bandwidth() / 2)
    .attr('y', (r) => (r.gap >= 0 ? y(0) + fontPx + 1 : y(0) - 3))
    .attr('text-anchor', 'middle')
    .style('font-size', font)
    .attr('font-weight', 700)
    .attr('fill', colors.text)
    .text((r) => `+${r.extra}`);

  return { plotWidth: iw, plotHeight: ih, legendHeight, labelEvery, values };
}
