/**
 * Monte Carlo finishing positions as a D3 chart: one row per driver (Race
 * Prediction, components/visualizations/RacePredictionPanel.jsx) or per plan
 * (custom strategy vs baseline, StrategySimulator.jsx), on one position axis
 * P1..Pn drawn on top.
 *
 * In each row:
 *  - bars: the share of the runs finishing at each position (every position
 *    with at least one run; one height scale for every row of the chart, so
 *    rows compare);
 *  - a line under the bars: the P5-P95 range of the runs;
 *  - a filled diamond: the position the row's P label shows (the median, the
 *    store's rule: utils/simulationClient.js shownPositions);
 *  - a hollow triangle: the current race position (absent for a plan).
 * Dashed rules after P3 and P10 mark the podium and the points places.
 * Shapes, not hues, tell the marks apart (no colour-only encoding).
 *
 * Pure D3 into the given <svg>; the rows come from positionRangeRows.
 */
import * as d3 from 'd3';

/** Height of the position axis drawn above the rows, px. */
export const POSITION_AXIS_H = 20;

/**
 * Shares of the runs per finishing position of a projection row, ascending:
 * from posCount (runs, unrounded) when present, else posDistribution (%).
 *
 * @param {Object} p - projection row
 * @returns {Array<[number, number]>} [position, share 0..1]
 */
export function positionShares(p) {
  const counts = p?.posCount && Object.keys(p.posCount).length ? p.posCount : null;
  const src = counts || p?.posDistribution || {};
  const pairs = Object.entries(src)
    .map(([pos, v]) => [Number(pos), Number(v)])
    .filter(([pos, v]) => Number.isFinite(pos) && Number.isFinite(v) && v > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, [, v]) => s + v, 0);
  if (!total) return [];
  return pairs.map(([pos, v]) => [pos, v / total]);
}

/**
 * A chart row of a projection row.
 *
 * @param {Object} p - projection row (posCount / posDistribution, posRange, currentPos)
 * @param {{key: string, label: string, shown: number|null, current?: number|null}} o
 * @returns {{key, label, shares, range, shown, current}}
 */
export function positionRangeRow(p, { key, label, shown, current = null }) {
  const range = Array.isArray(p?.posRange) && p.posRange.every(Number.isFinite) ? [p.posRange[0], p.posRange[1]] : null;
  return { key, label, shares: positionShares(p), range, shown: Number.isFinite(shown) ? shown : null, current: Number.isFinite(current) ? current : null };
}

/** Ticks of the position axis: P1, P3, P10, every 5th, the last. */
export function positionTicks(n) {
  const out = new Set([1]);
  if (n >= 3) out.add(3);
  if (n >= 10) out.add(10);
  for (let k = 5; k <= n; k += 5) out.add(k);
  out.add(n);
  return [...out].sort((a, b) => a - b);
}

const pct = (s) => `${Math.round(s * 1000) / 10} %`;

/**
 * Draw (or redraw) the rows.
 *
 * @param {SVGSVGElement} svgNode
 * @param {Object} o
 * @param {Array<Object>} o.rows - positionRangeRow rows, top to bottom
 * @param {number} o.positions - finishing positions on the axis (cars in the race)
 * @param {number} o.width - px
 * @param {number} o.rowH - px per row (the table rows beside the chart have it too)
 * @param {number} [o.axisH=POSITION_AXIS_H] - px above the first row
 * @param {{bars: string, range: string, shown: string, shownStroke: string, now: string, text: string, rule: string, axis: string}} o.colors
 * @param {string} o.font - CSS font size of the ticks (colors.js CHART_FONT.data)
 * @returns {{height: number}}
 */
export function drawPositionRanges(svgNode, {
  rows, positions, width, rowH, axisH = POSITION_AXIS_H, colors, font,
}) {
  const n = Math.max(1, Math.round(positions) || 1);
  const height = axisH + rows.length * rowH;
  const pad = 8;
  const x = d3.scaleLinear().domain([0.5, n + 0.5]).range([pad, Math.max(pad + 1, width - pad)]);
  const cell = Math.abs(x(2) - x(1));
  const maxShare = d3.max(rows, (r) => d3.max(r.shares, (s) => s[1])) || 1;
  const barMax = Math.max(2, rowH - 6);
  const h = d3.scaleLinear().domain([0, maxShare]).range([0, barMax]);

  const svg = d3.select(svgNode)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', 'Monte Carlo finishing positions: share of runs per position, P5 to P95 range, the position shown and the current position');

  svg.selectAll('g.mcr-axis').data([0]).join('g')
    .attr('class', 'mcr-axis')
    .attr('transform', `translate(0,${axisH - 2})`)
    .call(d3.axisTop(x).tickValues(positionTicks(n)).tickFormat((d) => `P${d}`).tickSizeOuter(0).tickSize(3))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.selectAll('.domain, .tick line').attr('stroke', colors.axis))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text));

  // podium (after P3) and points (after P10) limits through every row
  const limits = [3, 10].filter((k) => k < n);
  svg.selectAll('line.mcr-limit').data(limits).join('line')
    .attr('class', 'mcr-limit')
    .attr('data-after', (k) => k)
    .attr('x1', (k) => x(k + 0.5)).attr('x2', (k) => x(k + 0.5))
    .attr('y1', axisH - 2).attr('y2', height)
    .attr('stroke', colors.rule)
    .attr('stroke-dasharray', '3,3');

  const rowG = svg.selectAll('g.mcr-row').data(rows, (r) => r.key).join('g')
    .attr('class', 'mcr-row')
    .attr('data-key', (r) => r.key)
    .attr('transform', (r, i) => `translate(0,${axisH + i * rowH})`);

  rowG.selectAll('title.mcr-row-title').data((r) => [r]).join('title')
    .attr('class', 'mcr-row-title')
    .text((r) => [
      r.label,
      r.shown != null ? `P label P${r.shown} (median)` : null,
      r.current != null ? `now P${r.current}` : null,
      r.range ? `P5–P95 range P${r.range[0]}–P${r.range[1]}` : null,
    ].filter(Boolean).join(' · '));

  rowG.each(function drawRow(r) {
    const g = d3.select(this);
    const base = rowH - 3;
    g.selectAll('rect.mcr-bar').data(r.shares, (s) => s[0]).join('rect')
      .attr('class', 'mcr-bar')
      .attr('data-pos', (s) => s[0])
      .attr('data-share', (s) => s[1])
      .attr('x', (s) => x(s[0]) - cell * 0.4)
      .attr('width', Math.max(1, cell * 0.8))
      .attr('y', (s) => base - Math.max(1, h(s[1])))
      .attr('height', (s) => Math.max(1, h(s[1])))
      .attr('fill', colors.bars)
      .selectAll('title').data((s) => [s]).join('title')
      .text((s) => `${r.label}: P${s[0]} in ${pct(s[1])} of the runs`);
    g.selectAll('line.mcr-range').data(r.range ? [r.range] : []).join('line')
      .attr('class', 'mcr-range')
      .attr('x1', (rg) => x(rg[0])).attr('x2', (rg) => x(rg[1]))
      .attr('y1', base + 1.5).attr('y2', base + 1.5)
      .attr('stroke', colors.range)
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');
    const mid = Math.max(4, (rowH - 4) / 2);
    const s = Math.max(4, Math.min(6, rowH / 3.2));
    g.selectAll('path.mcr-now').data(r.current != null ? [r.current] : []).join('path')
      .attr('class', 'mcr-now')
      .attr('data-pos', (c) => c)
      .attr('d', (c) => `M${x(c) - s},${1}H${x(c) + s}L${x(c)},${1 + s * 1.5}Z`)
      .attr('fill', 'none')
      .attr('stroke', colors.now)
      .attr('stroke-width', 1.5);
    g.selectAll('path.mcr-shown').data(r.shown != null ? [r.shown] : []).join('path')
      .attr('class', 'mcr-shown')
      .attr('data-pos', (c) => c)
      .attr('d', (c) => `M${x(c)},${mid - s}L${x(c) + s},${mid}L${x(c)},${mid + s}L${x(c) - s},${mid}Z`)
      .attr('fill', colors.shown)
      .attr('stroke', colors.shownStroke)
      .attr('stroke-width', 1.5);
  });

  return { height };
}
