/**
 * Layout of the Consistency panel's cards (components/visualizations/
 * ConsistencyPanel.jsx, Phase 9c D1): every driver's card is on screen, on
 * one page when they fit, else on pages with a visible pager; the panel never
 * scrolls (the browser pass found 2-6 of 20 cards at 1536 x 750 in a grid
 * that scrolled even with every card collapsed).
 *
 *  - a collapsed card is one line, its height fitted to the room: up to
 *    CONSISTENCY_ROW_MAX px, down to CONSISTENCY_ROW_MIN (the 18 px floor of
 *    a data row plus the card's 2 px border);
 *  - the cards are laid in as many columns of at least `minCardW` px as the
 *    width holds, row by row (the order of consistencyView);
 *  - an expanded card spans the whole row and keeps its own height (measured
 *    in the browser, an estimate until then).
 *
 * Pure functions, no DOM: tested in __tests__/consistency.fit.test.jsx.
 */

export const CONSISTENCY_ROW_MIN = 20;
export const CONSISTENCY_ROW_MAX = 30;
export const CONSISTENCY_GAP = 4;
/** Estimate of an expanded card (px) until the browser has measured it. */
export const CONSISTENCY_EXPANDED_EST = 160;
/**
 * Minimum width of a collapsed card, in data-type ems (32 x 11 px = 352 px):
 * team bar, code, σ, the badge (or LOW DATA), CV and the chevron on one line
 * at the real font widths (__tests__/consistency.fit.test.jsx).
 */
export const CONSISTENCY_CARD_EM = 32;
/** Expanded card: its three sections side by side from this width (px). */
export const CONSISTENCY_WIDE_CARD = 520;

/**
 * Columns of collapsed cards that the width holds.
 *
 * @param {number} width - px of the cards' box
 * @param {number} n - cards
 * @param {number} minCardW - px a collapsed card needs
 * @param {number} [gap]
 * @returns {number} at least 1, at most n
 */
export function consistencyColumns(width, n, minCardW, gap = CONSISTENCY_GAP) {
  const count = Math.max(1, Math.floor(Number(n) || 0));
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return Math.max(1, Math.min(count, Math.floor((w + gap) / (minCardW + gap))));
}

/**
 * Grid rows of a run of cards, row by row: up to `cols` collapsed cards
 * share a row; an expanded card closes the row before it and takes a row of
 * its own (it spans every column).
 *
 * @param {Array<{expanded: boolean, height?: number}>} cards
 * @param {number} cols
 * @returns {Array<{start: number, end: number, expanded: boolean, height?: number}>} end exclusive
 */
export function consistencyRows(cards, cols) {
  const rows = [];
  let open = null;
  (cards || []).forEach((c, i) => {
    if (c.expanded) {
      if (open) { rows.push(open); open = null; }
      rows.push({ start: i, end: i + 1, expanded: true, height: c.height });
      return;
    }
    if (!open) open = { start: i, end: i, expanded: false };
    open.end = i + 1;
    if (open.end - open.start >= cols) { rows.push(open); open = null; }
  });
  if (open) rows.push(open);
  return rows;
}

/**
 * Pages of cards in a box `room` px high: the collapsed rows at the tallest
 * height up to CONSISTENCY_ROW_MAX that puts every card on one page, else at
 * CONSISTENCY_ROW_MIN with as many rows per page as fit (`pagerH` px kept
 * for a pager under the cards; the panel's pager sits in its header line,
 * 0). A page always holds at least one row. An unknown room (0, null: not
 * measured, a server render) puts every card on one page.
 *
 * @param {Array<{expanded: boolean, height?: number}>} cards - height of an expanded card (px)
 * @param {{cols: number, room: number, gap?: number, rowMin?: number, rowMax?: number, pagerH?: number, expandedEst?: number}} opts
 * @returns {{rowH: number, pages: Array<{start: number, end: number}>}}
 */
export function consistencyPages(cards, {
  cols, room, gap = CONSISTENCY_GAP, rowMin = CONSISTENCY_ROW_MIN, rowMax = CONSISTENCY_ROW_MAX,
  pagerH = 0, expandedEst = CONSISTENCY_EXPANDED_EST,
}) {
  const list = Array.isArray(cards) ? cards : [];
  if (list.length === 0) return { rowH: rowMax, pages: [] };
  const rows = consistencyRows(list, Math.max(1, cols || 1));
  const heightOf = (r, rowH) => (r.expanded ? (r.height > 0 ? r.height : expandedEst) : rowH);
  const h = Number(room);
  if (!Number.isFinite(h) || h <= 0) return { rowH: rowMax, pages: [{ start: 0, end: list.length }] };
  // Every card on one page: the collapsed rows share what the expanded ones leave
  const collapsedRows = rows.filter((r) => !r.expanded).length;
  const fixed = rows.reduce((a, r) => a + (r.expanded ? heightOf(r, 0) : 0), 0) + (rows.length - 1) * gap;
  const share = collapsedRows > 0 ? Math.floor((h - fixed) / collapsedRows) : rowMax;
  if (fixed + collapsedRows * rowMin <= h) {
    return { rowH: Math.max(rowMin, Math.min(rowMax, share)), pages: [{ start: 0, end: list.length }] };
  }
  // Pages of rows at the minimum height (and the room of a pager line, if any)
  const usable = h - pagerH;
  const pages = [];
  let page = null;
  let used = 0;
  for (const r of rows) {
    const rh = heightOf(r, rowMin);
    if (page && used + gap + rh > usable) { pages.push(page); page = null; }
    if (!page) { page = { start: r.start, end: r.end }; used = rh; continue; }
    page.end = r.end;
    used += gap + rh;
  }
  if (page) pages.push(page);
  return { rowH: rowMin, pages };
}

/**
 * The page that holds card `index` (0 when there is none).
 *
 * @param {Array<{start: number, end: number}>} pages
 * @param {number} index
 * @returns {number}
 */
export function consistencyPageOf(pages, index) {
  const k = (pages || []).findIndex((p) => index >= p.start && index < p.end);
  return k < 0 ? 0 : k;
}
