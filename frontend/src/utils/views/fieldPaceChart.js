/**
 * View model of the Race Pace view (components/visualizations/FieldPace.jsx):
 * its size floors, the rows of a page, the shared % axis and the marks. The
 * pace itself is utils/fieldPace.js.
 *
 * Pure module: no React, no D3, no store access.
 */
import { fitRows, pageOf } from './chartBox';
import { teammateIndex } from '../colors';

/** Height of a team row (px), the rows of a page at most, at least. */
export const FIELD_PACE_ROW_PX = 21;
export const FIELD_PACE_MAX_ROWS = 10;
export const FIELD_PACE_MIN_ROWS = 2;
/** The label size at its largest (px): the cap of --font-size-label in tokens.css. */
export const PACE_LABEL_MAX_PX = 11.5;

/**
 * Height of the axis line (px): one label line, rounded up (10.0005 px at
 * 1536 x 750 takes 11 px, 11.5 px takes 12).
 *
 * @param {number} labelPx - chartFontPx('label')
 * @returns {number}
 */
export function paceAxisH(labelPx) {
  return Math.ceil(labelPx);
}

/**
 * Size floors (CSS px of the view's box): the rows need 560 px of width
 * (narrower: the answer line only); the height holds the axis line at its
 * largest (paceAxisH of PACE_LABEL_MAX_PX: 12 px) and 10 rows of 21 px, a
 * season's ten teams on one page, at every viewport: 222 px. Lower, the rows
 * go on pages (the pager is in the panel header), down to
 * FIELD_PACE_MIN_ROWS rows a page.
 */
export const FIELD_PACE_MIN = Object.freeze({
  width: 560,
  height: paceAxisH(PACE_LABEL_MAX_PX) + FIELD_PACE_MAX_ROWS * FIELD_PACE_ROW_PX,
});

/**
 * Whether only the answer line fits: under FIELD_PACE_MIN.width, or too low
 * for the axis line and FIELD_PACE_MIN_ROWS rows. An unmeasured box draws.
 *
 * @param {{width: number, height: number}} box
 * @param {number} axisH - px of the axis line
 * @returns {boolean}
 */
export function paceAnswerOnly(box, axisH) {
  const w = Number(box?.width) || 0;
  const h = Number(box?.height) || 0;
  if (w <= 0 || h <= 0) return false;
  return w < FIELD_PACE_MIN.width || h < axisH + FIELD_PACE_MIN_ROWS * FIELD_PACE_ROW_PX;
}

/**
 * Rows per page in `height` px of rows: up to FIELD_PACE_MAX_ROWS rows of
 * FIELD_PACE_ROW_PX, the rest on further pages (the pager sits in the
 * panel header, it takes no row).
 *
 * @param {number} height - px left for the rows
 * @param {number} teams - rows to show
 * @returns {{perPage: number, paged: boolean}}
 */
export function paceRowsFit(height, teams) {
  const fit = fitRows(height, teams, { rowMin: FIELD_PACE_ROW_PX, rowMax: FIELD_PACE_ROW_PX });
  const perPage = Math.max(1, Math.min(FIELD_PACE_MAX_ROWS, fit.perPage));
  return { perPage, paged: teams > perPage };
}

/** One page of the team rows (chartBox.js pageOf). */
export function pacePage(teams, page, perPage) {
  return pageOf(teams, page, perPage);
}

/**
 * The shared % axis: every driver's median and interval, and 0, with 8 % of
 * the span on each side (at least 0.1 %).
 *
 * @param {Object} pace - fieldPace result
 * @returns {[number, number]}
 */
export function paceDomain(pace) {
  let lo = 0;
  let hi = 0;
  for (const d of Object.values(pace?.drivers || {})) {
    for (const v of [d.median, d.lo, d.hi]) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const pad = Math.max(0.1, (hi - lo) * 0.08);
  return [lo - pad, hi + pad];
}

/**
 * Shape of a driver's mark: a circle for the first driver of the team, a
 * diamond for the second (the shape, not the colour, tells team-mates apart).
 *
 * @param {string} driver
 * @returns {'circle'|'diamond'}
 */
export function markShape(driver) {
  return teammateIndex(driver) > 0 ? 'diamond' : 'circle';
}

/** SVG path of a diamond of half-diagonal r centred on 0, 0. */
export function diamondPath(r) {
  return `M0,${-r}L${r},0L0,${r}L${-r},0Z`;
}

/**
 * The view's answer line when only it fits: the fastest team and its
 * drivers' medians, e.g. "Fastest race pace: McLaren (NOR −1.48 %, PIA −1.51 %)".
 *
 * @param {Object} pace - fieldPace result
 * @param {function(number): string} pct - pctText
 * @returns {string}
 */
export function paceAnswer(pace, pct) {
  const top = (pace?.teams || []).find((t) => t.median != null);
  if (!top) return 'No comparable lap yet';
  const ds = top.drivers.filter((d) => pace.drivers[d]?.n > 0).map((d) => `${d} ${pct(pace.drivers[d].median)}`);
  return `Fastest race pace: ${top.team} (${ds.join(', ')})`;
}

// Label combinations tried in full (the product of the marks' variants) up
// to this many; beyond it every label steps down together
const MAX_LABEL_COMBOS = 27;

/**
 * Where the labels of a row's marks go: always inside the axis column
 * [x0, x1], so never over the team name or the gap text.
 *
 * The marks are taken together, by the union extent of their marks and
 * intervals [lo, hi]. Each label has variants, longest first (e.g.
 * 'TSU n4 LOW DATA', 'TSU n4', 'TSU'); for each choice of variants, the most
 * text first, the labels go in the order of their marks: the outer sides
 * (the left half of the marks' labels before lo, the others after hi, as a
 * single mark's label after it), else every label after hi, else every label
 * before lo, else any other split, where they fit. As a last resort the
 * shortest labels are pushed into the column on the outer sides, where a
 * label may cover the marks; a label that cannot fit in the column at all is
 * left out (no entry).
 *
 * @param {Array<{key: string, left: number, right: number, labels: Array<{text: string, w: number}>}>} marks -
 *   sorted by x; left / right: the px extent of the mark and its interval; labels: the variants, longest first
 * @param {{x0: number, x1: number, pad?: number}} opts
 * @returns {Map<string, {x: number, anchor: 'start'|'end', text: string}>}
 */
export function markLabelLayout(marks, { x0, x1, pad = 6 }) {
  const out = new Map();
  const n = marks.length;
  if (!n) return out;
  const lo = Math.min(...marks.map((m) => m.left));
  const hi = Math.max(...marks.map((m) => m.right));
  const lens = marks.map((m) => Math.max(1, m.labels.length));
  const variant = (m, i) => m.labels[Math.min(i, m.labels.length - 1)];

  // Choices of one variant per label, the most text first
  let combos = [[]];
  if (lens.reduce((p, l) => p * l, 1) <= MAX_LABEL_COMBOS) {
    for (const l of lens) combos = combos.flatMap((c) => Array.from({ length: l }, (_, i) => [...c, i]));
  } else {
    combos = Array.from({ length: Math.max(...lens) }, (_, i) => marks.map(() => i));
  }
  const textW = (c) => c.reduce((s, i, j) => s + variant(marks[j], i).w, 0);
  combos.sort((a, b) => textW(b) - textW(a));

  // Splits: k labels before lo, the others after hi; the outer sides first
  const outer = Math.floor(n / 2);
  const splits = [outer, 0, n, ...Array.from({ length: n + 1 }, (_, k) => k)]
    .filter((k, i, all) => all.indexOf(k) === i);
  const place = (c, k) => {
    const ws = c.map((i, j) => variant(marks[j], i).w);
    const before = ws.slice(0, k).reduce((s, w) => s + w + pad, 0);
    const after = ws.slice(k).reduce((s, w) => s + w + pad, 0);
    return { ws, before, after };
  };
  const set = (c, k, beforeEnd, afterStart) => {
    const { ws } = place(c, k);
    // before lo: right to left from beforeEnd, the label of the mark nearest lo last
    let xe = beforeEnd;
    for (let j = k - 1; j >= 0; j--) {
      if (xe - ws[j] >= x0 - 0.5) out.set(marks[j].key, { x: xe, anchor: 'end', text: variant(marks[j], c[j]).text });
      xe -= ws[j] + pad;
    }
    let xs = afterStart;
    for (let j = k; j < n; j++) {
      if (xs + ws[j] <= x1 + 0.5) out.set(marks[j].key, { x: xs, anchor: 'start', text: variant(marks[j], c[j]).text });
      xs += ws[j] + pad;
    }
  };
  for (const c of combos) {
    for (const k of splits) {
      const { before, after } = place(c, k);
      if (lo - before >= x0 && hi + after <= x1) {
        set(c, k, lo - pad, hi + pad);
        return out;
      }
    }
  }
  // Last resort: the shortest labels on the outer sides, pushed into the column
  const shortest = marks.map((m) => m.labels.length - 1);
  const { before, after } = place(shortest, outer);
  const beforeEnd = Math.min(x1, Math.max(x0 + before - pad, lo - pad));
  const afterStart = Math.max(x0, Math.min(x1 - after + pad, hi + pad));
  set(shortest, outer, beforeEnd, afterStart);
  return out;
}
