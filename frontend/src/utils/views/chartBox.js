/**
 * Sizing of the panels of the strategy views (Race Prediction, Undercut
 * Calculator, Sector Delta, Strategy Simulator, Strategy Analysis, PCA
 * analysis, Race Control): the box a chart or a table measures, and the rule
 * that fits table rows to it, paging instead of scrolling when they do not
 * fit (V5: no scroll inside these panels).
 *
 * A hook and pure functions; no component lives here (React Fast Refresh
 * hot-swaps a component module only when every export is a component).
 */
import { useEffect, useState } from 'react';

/**
 * Box of `ref.current` (CSS px): measured once on mount, then on every
 * resize (ResizeObserver, when there is one). In a server render it stays
 * `fallback`; a size of 0 means "not measured" to the callers.
 *
 * @param {{current: Element|null}} ref
 * @param {{width: number, height: number}} [fallback]
 * @returns {{width: number, height: number}}
 */
export function useBoxSize(ref, fallback = { width: 0, height: 0 }) {
  const [box, setBox] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // First measure now (also where there is no ResizeObserver)
    const r0 = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (r0 && (r0.width > 0 || r0.height > 0)) {
      const width = Math.floor(r0.width);
      const height = Math.floor(r0.height);
      setBox((b) => (b.width === width && b.height === height ? b : { width, height }));
    }
    if (typeof ResizeObserver === 'undefined') return undefined;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const width = Math.floor(r.width);
      const height = Math.floor(r.height);
      setBox((b) => (b.width === width && b.height === height ? b : { width, height }));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);
  return box;
}

/**
 * Rows of a table fitted to a height: every row when they fit at `rowMin`
 * (rows then grow up to `rowMax` to fill the height), else as many as fit at
 * `rowMin` per page with `pagerH` px kept for the pager. An unknown height
 * (0, null: not measured) shows every row at `rowDefault`.
 *
 * @param {number|null} available - px for the rows (and the pager)
 * @param {number} n - rows
 * @param {{rowMin: number, rowMax: number, rowDefault?: number, pagerH?: number}} opts
 * @returns {{rowH: number, perPage: number, paged: boolean}}
 */
export function fitRows(available, n, { rowMin, rowMax, rowDefault = rowMin, pagerH = 0 }) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const h = Number(available);
  if (!Number.isFinite(h) || h <= 0 || count === 0) {
    return { rowH: rowDefault, perPage: Math.max(1, count), paged: false };
  }
  if (count * rowMin <= h) {
    return { rowH: Math.max(rowMin, Math.min(rowMax, Math.floor(h / count))), perPage: count, paged: false };
  }
  const perPage = Math.max(1, Math.floor((h - pagerH) / rowMin));
  return { rowH: rowMin, perPage, paged: perPage < count };
}

/**
 * One page of `items`: the page index clamped to the pages there are.
 *
 * @param {Array} items
 * @param {number} page - 0-based
 * @param {number} perPage
 * @returns {{rows: Array, page: number, pages: number, first: number, last: number}}
 *   first / last are 1-based item numbers of the page (0 when empty)
 */
export function pageOf(items, page, perPage) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(perPage) || 1));
  const pages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(pages - 1, Math.max(0, Math.floor(Number(page) || 0)));
  const rows = list.slice(p * size, p * size + size);
  return {
    rows, page: p, pages, first: rows.length ? p * size + 1 : 0, last: rows.length ? p * size + rows.length : 0,
  };
}
