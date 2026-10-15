/**
 * D3 drawing of "What makes this cluster different" in Strategy Analysis
 * (components/visualizations/StrategyAnalysis.jsx, Insights tab of the
 * selected drivers): one horizontal bar per race-situation feature, the
 * signed Cohen's d of the selected drivers against the rest of the field
 * (+ = higher in the selection), on a symmetric x axis with dashed rules at
 * the conventional cut-offs |d| = 0.2 / 0.5 / 0.8 (small / medium / large).
 *
 * The bar's colour says whether the difference is better or worse for the
 * selected drivers (diverging pair of utils/colors.js) or has no better
 * direction (neutral); the text beside the bar repeats it in words with the
 * direction arrow, so colour is never the only cue.
 *
 * Pure D3 into the given <svg>; no React, no store.
 */
import * as d3 from 'd3';
import { drawLegend } from './d3Legend';

/** Conventional Cohen's d cut-offs (small, medium, large). */
export const EFFECT_CUTOFFS = [0.2, 0.5, 0.8];

/**
 * A chart row of a feature bar (StrategyAnalysis featureBars entry).
 *
 * @param {{key: string, label: string, effectSize: number, direction: 'higher'|'lower', lowerBetter: boolean|null, magnitude: string}} fb
 * @returns {{key, label, d: number, judgement: 'better'|'worse'|'neutral', words: string}}
 */
export function effectRow(fb) {
  const d = fb.direction === 'higher' ? fb.effectSize : -fb.effectSize;
  let judgement = 'neutral';
  if (fb.lowerBetter === true) judgement = fb.direction === 'lower' ? 'better' : 'worse';
  else if (fb.lowerBetter === false) judgement = fb.direction === 'higher' ? 'better' : 'worse';
  const arrow = fb.direction === 'higher' ? '↑' : '↓';
  const words = `${arrow} ${fb.magnitude}${judgement === 'neutral' ? '' : `, ${judgement}`}`;
  return { key: fb.key, label: fb.label, d, judgement, words };
}

/** Half range of the x axis: the largest |d| rounded up to 0.5, at least 1. */
export function effectHalfRange(rows) {
  const m = d3.max(rows, (r) => Math.abs(r.d)) || 0;
  return Math.max(1, Math.ceil(m * 2) / 2);
}

/**
 * Draw (or redraw) the bars.
 *
 * @param {SVGSVGElement} svgNode
 * @param {Object} o
 * @param {Array<Object>} o.rows - effectRow rows, largest |d| first
 * @param {number} o.width - px
 * @param {number} o.height - px
 * @param {{better: string, worse: string, neutral: string, text: string, muted: string, grid: string, axis: string, rule: string}} o.colors
 * @param {string} o.font - CSS font size (colors.js CHART_FONT.data, >= 11 px)
 * @param {number} o.fontPx
 * @param {string} o.legendFont - (colors.js CHART_FONT.data: D3 text >= 11 px)
 * @param {number} o.legendFontPx
 * @returns {{rowH: number, legendHeight: number}}
 */
export function drawEffectBars(svgNode, {
  rows, width, height, colors, font, fontPx, legendFont, legendFontPx,
}) {
  const svg = d3.select(svgNode)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', "Cohen's d of the selected drivers against the rest of the field, per feature; + = higher in the selection");

  const legend = svg.selectAll('g.eff-legend').data([0]).join('g').attr('class', 'eff-legend chart-legend');
  const legendHeight = drawLegend(legend, [
    { key: 'better', label: 'better for selected', shape: 'rect', color: colors.better },
    { key: 'worse', label: 'worse for selected', shape: 'rect', color: colors.worse },
    { key: 'neutral', label: 'no better direction', shape: 'rect', color: colors.neutral },
    { key: 'cut', label: '|d| 0.2 / 0.5 / 0.8', shape: 'dash', color: colors.rule },
  ], {
    font: legendFont, fontPx: legendFontPx, maxWidth: Math.max(60, width - 8), textColor: colors.text,
  });
  legend.attr('transform', 'translate(2,0)');

  const labelW = Math.min(Math.max(70, width * 0.3), 130);
  const wordsW = Math.min(110, Math.max(70, width * 0.22));
  const top = legendHeight + 4;
  const axisH = fontPx + 10;
  const iw = Math.max(10, width - labelW - wordsW - 8);
  const ih = Math.max(0, height - top - axisH);
  const rowH = rows.length ? ih / rows.length : 0;
  const half = effectHalfRange(rows);
  const x = d3.scaleLinear().domain([-half, half]).range([0, iw]);
  const y = d3.scaleBand().domain(rows.map((r) => r.key)).range([0, ih]).paddingInner(0.25).paddingOuter(0.1);

  const root = svg.selectAll('g.eff-plot').data([0]).join('g')
    .attr('class', 'eff-plot')
    .attr('transform', `translate(${labelW},${top})`);

  // cut-off rules on both sides, and zero
  const rules = EFFECT_CUTOFFS.flatMap((c) => [-c, c]).filter((c) => Math.abs(c) <= half);
  root.selectAll('line.eff-cut').data(rules).join('line')
    .attr('class', 'eff-cut')
    .attr('x1', (c) => x(c)).attr('x2', (c) => x(c))
    .attr('y1', 0).attr('y2', ih)
    .attr('stroke', colors.rule)
    .attr('stroke-dasharray', '2,3');
  root.selectAll('line.eff-zero').data([0]).join('line')
    .attr('class', 'eff-zero')
    .attr('x1', x(0)).attr('x2', x(0))
    .attr('y1', 0).attr('y2', ih)
    .attr('stroke', colors.text);

  root.selectAll('g.eff-x').data([0]).join('g')
    .attr('class', 'eff-x eff-axis')
    .attr('transform', `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.min(5, Math.floor(iw / (fontPx * 3.5)))))
      .tickFormat((v) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`)).tickSizeOuter(0).tickSize(3))
    .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
    .call((g) => g.selectAll('.domain, .tick line').attr('stroke', colors.axis))
    .call((g) => g.selectAll('.tick text').attr('fill', colors.text));

  const rowG = root.selectAll('g.eff-row').data(rows, (r) => r.key).join((enter) => {
    const g = enter.append('g').attr('class', 'eff-row');
    g.append('text').attr('class', 'eff-label');
    g.append('rect').attr('class', 'eff-bar');
    g.append('text').attr('class', 'eff-words');
    g.append('title');
    return g;
  })
    .attr('data-key', (r) => r.key)
    .attr('data-d', (r) => r.d)
    .attr('transform', (r) => `translate(0,${y(r.key)})`);
  const bw = y.bandwidth();
  rowG.select('text.eff-label')
    .attr('x', -6).attr('y', bw / 2).attr('dy', '0.35em')
    .attr('text-anchor', 'end')
    .style('font-size', font)
    .attr('fill', colors.text)
    .text((r) => r.label);
  rowG.select('rect.eff-bar')
    .attr('class', (r) => `eff-bar eff-bar--${r.judgement}`)
    .attr('x', (r) => Math.min(x(0), x(r.d)))
    .attr('width', (r) => Math.max(1, Math.abs(x(r.d) - x(0))))
    .attr('y', 0)
    .attr('height', bw)
    .attr('fill', (r) => colors[r.judgement]);
  rowG.select('text.eff-words')
    .attr('x', iw + 6).attr('y', bw / 2).attr('dy', '0.35em')
    .style('font-size', font)
    .attr('fill', colors.text)
    .text((r) => r.words);
  rowG.select('title').text((r) => `${r.label}: d ${r.d > 0 ? '+' : r.d < 0 ? '−' : ''}${Math.abs(r.d).toFixed(2)} (${r.words})`);

  return { rowH, legendHeight };
}
