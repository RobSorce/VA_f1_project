/**
 * View model of the Race Pace view (components/visualizations/FieldPace.jsx):
 * its size floors, the rows of a page, the shared % axis and the marks. The
 * pace itself is utils/fieldPace.js.
 *
 * Pure module: no React, no D3, no store access.
 */
import { fitRows, pageOf } from './chartBox';
import { teammateIndex } from '../colors';

/**
 * Size floors (CSS px of the view's box): the rows need 560 px of width
 * (narrower: the answer line only); 220 px of height hold the axis line (one
 * label line, 10 px at 1536 x 750) and 10 rows of 21 px, a season's ten
 * teams on one page; lower, the rows go on pages (the pager is in the panel
 * header), down to FIELD_PACE_MIN_ROWS rows a page.
 */
export const FIELD_PACE_MIN = Object.freeze({ width: 560, height: 220 });
/** Height of a team row (px), the rows of a page at most, at least. */
export const FIELD_PACE_ROW_PX = 21;
export const FIELD_PACE_MAX_ROWS = 10;
export const FIELD_PACE_MIN_ROWS = 2;

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

/**
 * Where the labels of a row's marks go, inside [x0, x1] when they can:
 * the left mark's label on its left and the right one's on its right; when
 * the left side has no room, both labels after the right mark (the left
 * mark's first), when the right side has none, both before the left mark, if
 * the two fit there. A single mark: on its right, else on its left.
 *
 * @param {Array<{key: string, left: number, right: number, w: number}>} marks - sorted by x;
 *   left / right: the px extent of the mark and its interval, w: the label's width
 * @param {{x0: number, x1: number, pad?: number}} opts
 * @returns {Map<string, {x: number, anchor: 'start'|'end'}>}
 */
export function markLabelLayout(marks, { x0, x1, pad = 6 }) {
  const out = new Map();
  if (!marks.length) return out;
  if (marks.length === 1) {
    const m = marks[0];
    if (m.right + pad + m.w <= x1) out.set(m.key, { x: m.right + pad, anchor: 'start' });
    else out.set(m.key, { x: m.left - pad, anchor: 'end' });
    return out;
  }
  const [a, b] = marks;
  const leftFits = a.left - pad - a.w >= x0;
  const rightFits = b.right + pad + b.w <= x1;
  if (!leftFits && b.right + 2 * pad + a.w + b.w <= x1) {
    out.set(a.key, { x: b.right + pad, anchor: 'start' });
    out.set(b.key, { x: b.right + 2 * pad + a.w, anchor: 'start' });
  } else if (!rightFits && a.left - 2 * pad - a.w - b.w >= x0) {
    out.set(b.key, { x: a.left - pad, anchor: 'end' });
    out.set(a.key, { x: a.left - 2 * pad - b.w, anchor: 'end' });
  } else {
    // both outer sides (also when neither side holds both labels)
    out.set(a.key, { x: a.left - pad, anchor: 'end' });
    out.set(b.key, { x: b.right + pad, anchor: 'start' });
  }
  return out;
}
