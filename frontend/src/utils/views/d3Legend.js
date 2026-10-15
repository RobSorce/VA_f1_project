/**
 * Legend of the D3 strategy charts (sector delta waterfall, Monte Carlo
 * position ranges, undercut sweep, stint strips): one row of swatch + label
 * items that wraps onto a new line when the next item would pass `maxWidth`.
 * Every item carries a glyph or a shape besides its colour, so the legend
 * reads without colour (V1: no colour-only encoding).
 *
 * Pure D3 drawing into a given <g>; no React, no store.
 */
import * as d3 from 'd3';

/** Width of a label (browser: measured; elsewhere estimated from its length). */
function labelWidth(node, text, fontSize) {
  const measured = typeof node?.getComputedTextLength === 'function' ? node.getComputedTextLength() : 0;
  // The tests' mini DOM measures 5 px per character whatever the size:
  // never trust a measure below the estimate
  return Math.max(measured, text.length * fontSize * 0.56);
}

/**
 * Draw `items` in `g` (cleared first).
 *
 * @param {d3.Selection} g - the legend group
 * @param {Array<{key: string, label: string, shape: 'rect'|'line'|'dash'|'triangle-down'|'triangle-up'|'diamond'|'circle'|'tick'|'none', color: string, stroke?: string, hollow?: boolean}>} items
 *   hollow: outline only (stroke = color); 'none': no swatch, the label
 *   starts with the glyph it explains (e.g. '+n extra stop')
 * @param {{font: string, fontPx: number, maxWidth: number, textColor: string, gap?: number}} opts
 *   font: CSS font size of the labels (colors.js CHART_FONT.label or .data);
 *   fontPx: the px it resolves to (colors.js chartFontPx), for the layout
 * @returns {number} height used, px
 */
export function drawLegend(g, items, {
  font, fontPx, maxWidth, textColor, gap = 12,
}) {
  const sw = Math.round(fontPx * 0.9);
  const lineH = Math.round(fontPx * 1.45);
  const sel = g.selectAll('g.chart-legend__item').data(items, (d) => d.key).join((enter) => {
    const e = enter.append('g').attr('class', 'chart-legend__item');
    e.append('path').attr('class', 'chart-legend__swatch');
    e.append('text').attr('class', 'chart-legend__label');
    return e;
  });
  sel.attr('data-key', (d) => d.key);
  sel.select('text.chart-legend__label')
    .attr('x', sw + 4)
    .attr('y', 0)
    .attr('dy', '0.35em')
    .style('font-size', font)
    .attr('fill', textColor)
    .text((d) => d.label);
  sel.select('path.chart-legend__swatch')
    .attr('d', (d) => swatchPath(d.shape, sw))
    .attr('fill', (d) => (d.shape === 'line' || d.shape === 'dash' || d.hollow ? 'none' : d.color))
    .attr('stroke', (d) => (d.shape === 'line' || d.shape === 'dash' || d.hollow ? d.color : (d.stroke || 'none')))
    .attr('stroke-width', (d) => (d.shape === 'line' || d.shape === 'dash' ? 2 : d.hollow ? 1.5 : 1))
    .attr('stroke-dasharray', (d) => (d.shape === 'dash' ? '3,2' : null));
  sel.select('text.chart-legend__label').attr('x', (d) => (d.shape === 'none' ? 0 : sw + 4));
  let x = 0;
  let row = 0;
  sel.each(function place(d) {
    const w = (d.shape === 'none' ? 0 : sw + 4) + labelWidth(d3.select(this).select('text').node(), d.label, fontPx);
    if (x > 0 && x + w > maxWidth) { x = 0; row += 1; }
    d3.select(this).attr('transform', `translate(${x},${row * lineH + lineH / 2})`);
    x += w + gap;
  });
  return items.length ? (row + 1) * lineH : 0;
}

/** Swatch outline centred on y = 0, starting at x = 0, `s` px wide. */
function swatchPath(shape, s) {
  const h = s / 2;
  switch (shape) {
    case 'none':
      return '';
    case 'tick':
      return `M${h - 1},${-h}H${h + 1}V${h}H${h - 1}Z`;
    case 'line':
    case 'dash':
      return `M0,0H${s}`;
    case 'triangle-down':
      return `M0,${-h}H${s}L${h},${h}Z`;
    case 'triangle-up':
      return `M0,${h}H${s}L${h},${-h}Z`;
    case 'diamond':
      return `M${h},${-h}L${s},0L${h},${h}L0,0Z`;
    case 'circle':
      return `M0,0a${h},${h} 0 1,0 ${s},0a${h},${h} 0 1,0 ${-s},0`;
    default:
      return `M0,${-h}H${s}V${h}H0Z`;
  }
}
