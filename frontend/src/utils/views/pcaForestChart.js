/**
 * D3 drawing of the forest plot of the Cross-Race Analysis panel
 * (components/visualizations/PCAAnalysisPanel.jsx, Differences tab): one
 * strip per feature row on a shared axis of Hedges' g, [-half, +half], and
 * the axis itself above the rows.
 *
 * In a strip (user units: width W, height H, stretched to the cell):
 *  - shaded band (.pca-forest-baseline): the |g| a random selection of the
 *    same size and mix reaches on average, ±baseline around 0;
 *  - dashed lines (.pca-forest-threshold): the threshold the feature must
 *    pass to be marked "above random" (the marker is the text label, not
 *    the colour);
 *  - solid line: g = 0;
 *  - horizontal bar (.pca-forest-interval): the interval of g (none for a
 *    group too small to have one);
 *  - tick (.pca-forest-g): g itself.
 * Positions come from utils/views/pcaSelection.js forestX, so the strip and
 * the axis share one scale.
 *
 * Pure D3 into the given <svg>; no React, no store.
 */
import * as d3 from 'd3';
import { forestX } from './pcaSelection';

/** Strip drawing size in user units (viewBox) and px height. */
export const FOREST_W = 200;
export const FOREST_H = 16;
/** Height of the axis above the rows, px. */
export const FOREST_AXIS_H = 20;

/** Ticks of the g axis: the ends, the halves and 0. */
export function forestTicks(half) {
  return [-half, -half / 2, 0, half / 2, half];
}

/** Signed tick label: '+1.5', '−3', '0'. */
export function forestTickLabel(v) {
  if (v === 0) return '0';
  const s = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(Math.abs(v) < 1 ? 2 : 1);
  return `${v > 0 ? '+' : '−'}${s}`;
}

/**
 * Draw (or redraw) one feature's strip.
 *
 * @param {SVGSVGElement} svgNode - an <svg> with viewBox `0 0 FOREST_W FOREST_H`
 * @param {Object} o
 * @param {{g: number, ciLow: number|null, ciHigh: number|null, baseline: number|null}} o.row
 * @param {number} o.half - axis half range (forestHalfWidth)
 * @param {number|null} o.threshold - the |g| this row must pass
 * @param {boolean} o.hasInterval - whether the row has an interval
 * @param {{mark: string, band: string, threshold: string, zero: string}} o.colors
 *   mark: g and its interval (the highlight of a row above random, else neutral)
 */
export function drawForestStrip(svgNode, {
  row, half, threshold, hasInterval, colors,
}) {
  const W = FOREST_W;
  const H = FOREST_H;
  const x = (v) => forestX(v, half, W);
  const svg = d3.select(svgNode)
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('preserveAspectRatio', 'none');

  svg.selectAll('rect.pca-forest-baseline').data(row.baseline != null ? [row.baseline] : []).join('rect')
    .attr('class', 'pca-forest-baseline')
    .attr('x', (b) => x(-b))
    .attr('y', 1)
    .attr('width', (b) => x(b) - x(-b))
    .attr('height', H - 2)
    .attr('fill', colors.band);

  svg.selectAll('line.pca-forest-threshold').data(threshold != null ? [-threshold, threshold] : []).join('line')
    .attr('class', 'pca-forest-threshold')
    .attr('x1', (t) => x(t)).attr('x2', (t) => x(t))
    .attr('y1', 0).attr('y2', H)
    .attr('vector-effect', 'non-scaling-stroke')
    .attr('stroke-dasharray', '2,2')
    .attr('stroke', colors.threshold)
    .attr('stroke-width', 1);

  svg.selectAll('line.pca-forest-zero').data([0]).join('line')
    .attr('class', 'pca-forest-zero')
    .attr('x1', x(0)).attr('x2', x(0))
    .attr('y1', 0).attr('y2', H)
    .attr('vector-effect', 'non-scaling-stroke')
    .attr('stroke', colors.zero)
    .attr('stroke-width', 1);

  svg.selectAll('line.pca-forest-interval').data(hasInterval ? [row] : []).join('line')
    .attr('class', 'pca-forest-interval')
    .attr('x1', (r) => x(r.ciLow)).attr('x2', (r) => x(r.ciHigh))
    .attr('y1', H / 2).attr('y2', H / 2)
    .attr('vector-effect', 'non-scaling-stroke')
    .attr('stroke', colors.mark)
    .attr('stroke-width', 2);

  svg.selectAll('line.pca-forest-g').data([row]).join('line')
    .attr('class', 'pca-forest-g')
    .attr('x1', (r) => x(r.g)).attr('x2', (r) => x(r.g))
    .attr('y1', 2).attr('y2', H - 2)
    .attr('vector-effect', 'non-scaling-stroke')
    .attr('stroke', colors.mark)
    .attr('stroke-width', 3);
}

/**
 * Draw the g axis above the strips (the strips' scale stretched to `width`).
 *
 * @param {SVGSVGElement} svgNode
 * @param {{half: number, width: number, font: string, colors: {text: string, axis: string}}} o
 *   font: CSS font size of the ticks (colors.js CHART_FONT.data)
 */
export function drawForestAxis(svgNode, {
  half, width, font, colors,
}) {
  const w = Math.max(1, width);
  const scale = d3.scaleLinear().domain([-half, half]).range([0, w]);
  const svg = d3.select(svgNode)
    .attr('width', w)
    .attr('height', FOREST_AXIS_H)
    .style('overflow', 'visible')
    .attr('role', 'img')
    .attr('aria-label', `Hedges' g axis from ${forestTickLabel(-half)} to ${forestTickLabel(half)}: left = lower in the selection, right = higher`);
  svg.selectAll('g.pca-forest-axis').data([0]).join('g')
    .attr('class', 'pca-forest-axis')
    .attr('transform', `translate(0,${FOREST_AXIS_H - 1})`)
    .call(d3.axisTop(scale).tickValues(forestTicks(half)).tickFormat(forestTickLabel).tickSize(3).tickSizeOuter(0))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.selectAll('.domain, .tick line').attr('stroke', colors.axis))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text))
    // the end labels stay inside the column
    .call((g) => g.selectAll('.tick text').attr('text-anchor', (d) => (d === -half ? 'start' : d === half ? 'end' : 'middle')));
}
