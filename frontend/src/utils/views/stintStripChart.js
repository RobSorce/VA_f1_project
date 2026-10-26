/**
 * Stint strips as a D3 chart: one row per plan (the Strategy Simulator's
 * custom plan and the actual strategy, the PCA strategy patterns) or per
 * group (the field's tyre mix in Strategy Analysis), each a sequence of segments on one linear axis (laps,
 * or cars for the tyre mix) drawn under the rows.
 *
 * Every segment is filled with its FIA compound colour and carries the
 * compound letter (and its length when there is room), the letter in black
 * or white by contrast (utils/colors.js contrastText): the compound never
 * rests on colour alone. An optional vertical marker (the lap in progress)
 * crosses every row.
 *
 * Pure D3 into the given <svg>; no React, no store.
 */
import * as d3 from 'd3';
import {
  tyreColor, tyreLetter, contrastText, TEXT_COLORS, GRID_COLORS, SURFACES,
} from '../colors';

/** Height of the axis under the rows, px. */
export const STRIP_AXIS_H = 20;

/**
 * Segments of a plan given as stints with lap starts (lapStart, length) or
 * only lengths (cumulative from lap 1).
 *
 * @param {Array<{compound: string, length: number, lapStart?: number}>} stints
 * @returns {Array<{key: string, start: number, length: number, compound: string}>}
 */
export function stintSegments(stints) {
  let at = 1;
  return (Array.isArray(stints) ? stints : []).map((s, i) => {
    const length = Math.max(0, Number(s?.length) || 0);
    const start = Number.isFinite(s?.lapStart) ? s.lapStart : at;
    at = start + length;
    return { key: `${i}`, start, length, compound: s?.compound || 'UNKNOWN' };
  });
}

/** Ticks of a lap axis from 1 to `laps`: 1, every 10th, the last. */
export function lapTicks(laps) {
  const n = Math.max(1, Math.round(laps) || 1);
  const out = new Set([1]);
  for (let k = 10; k < n; k += 10) out.add(k);
  out.add(n);
  return [...out].sort((a, b) => a - b);
}

/**
 * Draw (or redraw) the strips.
 *
 * @param {SVGSVGElement} svgNode
 * @param {Object} o
 * @param {Array<{key: string, label: string, segments: Array<{key: string, start: number, length: number, compound: string, title?: string}>}>} o.rows
 * @param {[number, number]} o.domain - axis start and end (laps: [1, last lap + 1])
 * @param {number} o.width - px
 * @param {number} o.rowH - px per row
 * @param {number} [o.labelW=0] - px of the row labels on the left (0: none)
 * @param {{ticks: number[], format: function(number): string, at?: function(number): number}|null} [o.axis]
 *   at: where a tick sits (laps: the middle of the lap, default)
 * @param {{value: number, title: string}|null} [o.marker] - x of a vertical marker
 * @param {string} o.font - CSS font size (colors.js CHART_FONT.data)
 * @param {number} o.fontPx - the px it resolves to (colors.js chartFontPx)
 * @returns {{height: number}}
 */
export function drawStintStrips(svgNode, {
  rows, domain, width, rowH, labelW = 0, axis = null, marker = null, font, fontPx,
}) {
  const axisH = axis ? STRIP_AXIS_H : 0;
  const height = rows.length * rowH + axisH;
  const left = labelW > 0 ? labelW + 6 : 1;
  const x = d3.scaleLinear().domain(domain).range([left, Math.max(left + 1, width - 2)]);
  const svg = d3.select(svgNode)
    .attr('width', width)
    .attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', rows.map((r) => `${r.label}: ${r.segments.map((s) => `${s.compound} ${s.length}`).join(', ')}`).join('; '));

  const rowG = svg.selectAll('g.strip-row').data(rows, (r) => r.key).join('g')
    .attr('class', 'strip-row')
    .attr('data-key', (r) => r.key)
    .attr('transform', (r, i) => `translate(0,${i * rowH})`);

  rowG.selectAll('text.strip-label').data((r) => (labelW > 0 ? [r] : [])).join('text')
    .attr('class', 'strip-label')
    .attr('x', 0)
    .attr('y', rowH / 2)
    .attr('dy', '0.35em')
    .style('font-size', font)
    .attr('fill', TEXT_COLORS.secondary)
    .text((r) => r.label);

  rowG.each(function drawRow(r) {
    const g = d3.select(this);
    const segs = g.selectAll('g.strip-seg').data(r.segments, (s) => s.key).join((enter) => {
      const e = enter.append('g').attr('class', 'strip-seg');
      e.append('rect');
      e.append('text');
      e.append('title');
      return e;
    });
    segs.attr('data-compound', (s) => s.compound).attr('data-start', (s) => s.start).attr('data-length', (s) => s.length);
    segs.select('rect')
      .attr('x', (s) => x(s.start))
      .attr('y', 2)
      .attr('width', (s) => Math.max(1, x(s.start + s.length) - x(s.start) - 1))
      .attr('height', Math.max(2, rowH - 4))
      .attr('rx', 2)
      .attr('fill', (s) => tyreColor(s.compound))
      .attr('stroke', SURFACES.page)
      .attr('stroke-width', 1);
    segs.select('text')
      .attr('x', (s) => (x(s.start) + x(s.start + s.length)) / 2)
      .attr('y', rowH / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', 'middle')
      .style('font-size', font)
      .attr('font-weight', 700)
      .attr('fill', (s) => contrastText(tyreColor(s.compound)))
      .text((s) => {
        const w = x(s.start + s.length) - x(s.start);
        const letter = tyreLetter(s.compound);
        const full = `${letter} ${s.length}`;
        if (w >= full.length * fontPx * 0.62 + 4) return full;
        if (w >= fontPx * 0.8 + 2) return letter;
        return '';
      });
    segs.select('title').text((s) => s.title || `${s.compound}: ${s.length} from ${s.start}`);
  });

  svg.selectAll('g.strip-axis').data(axis ? [axis] : []).join('g')
    .attr('class', 'strip-axis')
    .attr('transform', `translate(0,${rows.length * rowH})`)
    .each(function drawAxis(a) {
      // a tick sits at a.at(value) on the scale (laps: the middle of the lap)
      // and is labelled with the value itself
      const at = a.at || ((v) => v + 0.5);
      const values = a.ticks.map((v) => ({ v, x: at(v) }));
      const ax = d3.axisBottom(x)
        .tickValues(values.map((t) => t.x))
        .tickFormat((p) => a.format(values.find((t) => t.x === p)?.v ?? p))
        .tickSizeOuter(0)
        .tickSize(3);
      d3.select(this).call(ax)
        .call((g) => g.attr('font-size', null).attr('font-family', null).style('font-size', font))
        .call((g) => g.selectAll('.domain, .tick line').attr('stroke', GRID_COLORS.axis))
        .call((g) => g.selectAll('.tick text').attr('fill', TEXT_COLORS.primary));
    });

  svg.selectAll('line.strip-marker').data(marker ? [marker] : []).join('line')
    .attr('class', 'strip-marker')
    .attr('data-value', (m) => m.value)
    .attr('x1', (m) => x(m.value)).attr('x2', (m) => x(m.value))
    .attr('y1', 0).attr('y2', rows.length * rowH)
    .attr('stroke', TEXT_COLORS.primary)
    .attr('stroke-width', 2)
    .selectAll('title').data((m) => [m]).join('title')
    .text((m) => m.title);

  return { height };
}
