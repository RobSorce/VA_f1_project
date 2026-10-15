/**
 * Sizing of the panels of the strategy views (Race Prediction, Undercut
 * Calculator, Sector Delta, Strategy Simulator, Strategy Analysis, PCA
 * analysis, Race Control): the box a chart or a table measures, and the rule
 * that fits table rows to it, paging instead of scrolling when they do not
 * fit (V5: no scroll inside these panels).
 *
 * Every D3 view sizes itself with useChartBox (Phase 9c, D4): one
 * ResizeObserver per chart, throttled to one measure per animation frame,
 * so a chart lays out again (scales, viewBox) whenever its box changes: the
 * browser moved between screens, a dock split dragged, a panel opened. Its
 * user space then maps 1:1 to CSS px and CHART_FONT sizes are the sizes on
 * screen; a view that zooms divides its label sizes by svgScreenScale x k.
 *
 * Hooks and pure functions; no component lives here (React Fast Refresh
 * hot-swaps a component module only when every export is a component).
 * No import but React: notes/experiments/v13_audit/layout_fit.mjs loads this
 * module in plain node.
 */
import { useEffect, useRef, useState } from 'react';

/**
 * Box of `ref.current` (CSS px): measured once on mount, then on every
 * resize (ResizeObserver, when there is one). In a server render it stays
 * `fallback`; a size of 0 means "not measured" to the callers.
 *
 * `tagRef`: a ref whose value is read at each measure and returned with it
 * as `box.tag`, so the caller knows the layout the size was measured in
 * (the Sectors panel: whether its pager line was on screen then). A measure
 * taken before the pager arrived and one taken after it are told apart,
 * whatever renders come in between. Keep its value current in a layout
 * effect: a measure is always taken after the layout effects of the commit
 * it measures.
 *
 * @param {{current: Element|null}} ref
 * @param {{width: number, height: number}} [fallback]
 * @param {{tagRef?: {current: *}}} [opts]
 * @returns {{width: number, height: number, tag?: *}}
 */
export function useBoxSize(ref, fallback = { width: 0, height: 0 }, { tagRef = null } = {}) {
  const [box, setBox] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const put = (width, height) => {
      if (!tagRef) {
        setBox((b) => (b.width === width && b.height === height ? b : { width, height }));
        return;
      }
      const tag = tagRef.current;
      setBox((b) => (b.width === width && b.height === height && b.tag === tag ? b : { width, height, tag }));
    };
    // First measure now (also where there is no ResizeObserver)
    const r0 = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (r0 && (r0.width > 0 || r0.height > 0)) put(Math.floor(r0.width), Math.floor(r0.height));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      put(Math.floor(r.width), Math.floor(r.height));
    });
    obs.observe(el);
    return () => obs.disconnect();
    // tagRef is a ref object, read at each measure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return box;
}

const NO_BOX = Object.freeze({ width: 0, height: 0 });

/**
 * Content box of an element (CSS px, floored): its size less padding and
 * border, the box a 100 % x 100 % child svg fills. Never larger than the
 * layout box (clientWidth / clientHeight are rounded to whole px, the client
 * rect is not: the smaller of the two, so a viewBox made from it is never
 * wider than the svg drawn and its labels never read under their size).
 * 0 x 0 when there is no element or no layout.
 *
 * @param {Element|null} el
 * @returns {{width: number, height: number}}
 */
export function contentBox(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return NO_BOX;
  const r = el.getBoundingClientRect();
  let padX = 0;
  let padY = 0;
  let borderX = 0;
  let borderY = 0;
  try {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (cs) {
      const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
      padX = n('padding-left') + n('padding-right');
      padY = n('padding-top') + n('padding-bottom');
      borderX = n('border-left-width') + n('border-right-width');
      borderY = n('border-top-width') + n('border-bottom-width');
    }
  } catch {
    // no computed style (server render): the layout size
  }
  // the client rect includes the border; clientWidth / clientHeight do not
  let width = (r.width || 0) - borderX - padX;
  let height = (r.height || 0) - borderY - padY;
  const cw = Number(el.clientWidth) || 0;
  const ch = Number(el.clientHeight) || 0;
  if (cw > 0) width = Math.min(width > 0 ? width : Infinity, cw - padX);
  if (ch > 0) height = Math.min(height > 0 ? height : Infinity, ch - padY);
  return { width: Math.max(0, Math.floor(width)), height: Math.max(0, Math.floor(height)) };
}

// One measure per animation frame (setTimeout where there is no frame clock)
function nextFrame(fn) {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); };
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

function unwatch(w) {
  if (w.cancel) w.cancel();
  if (w.obs) w.obs.disconnect();
  w.cancel = null;
  w.obs = null;
  w.el = null;
  w.rect = null;
}

/**
 * The box a D3 chart draws into, kept up to date (D4): by default the
 * content box of the parent of `ref.current` (the element a 100 % x 100 %
 * svg fills); `{ parent: false }` measures `ref.current` itself. Measured
 * when the element appears, then on every resize: a ResizeObserver whose
 * notifications are coalesced to one state update per animation frame (a
 * dock split dragged notifies on every mouse move). The element is looked
 * up after every commit, so a chart whose svg mounts later (after a loading
 * state) or moves to another container is followed. { width: 0, height: 0 }
 * until measured (server render, no layout): callers fall back to their
 * default size (chartSize).
 *
 * Put `box.width, box.height` in the dependencies of the effect that draws:
 * the chart then lays out again at each new size.
 *
 * @param {{current: Element|null}} ref
 * @param {{parent?: boolean}} [opts]
 * @returns {{width: number, height: number}}
 */
export function useChartBox(ref, { parent = true } = {}) {
  const [box, setBox] = useState(NO_BOX);
  // el: the element observed; size: the box last set (kept when the svg moves)
  const watch = useRef({ el: null, obs: null, cancel: null, rect: null, size: null });

  // After every commit: (re)attach to the element the chart fills
  useEffect(() => {
    const w = watch.current;
    const node = ref.current;
    const el = node ? (parent ? node.parentElement : node) : null;
    if (el === w.el) return;
    unwatch(w);
    if (!el) return;
    w.el = el;
    const apply = (width, height) => {
      const wd = Math.max(0, Math.floor(width));
      const ht = Math.max(0, Math.floor(height));
      // the same box again (a sub-pixel change): no render at all
      if (w.size && w.size.width === wd && w.size.height === ht) return;
      w.size = { width: wd, height: ht };
      setBox((b) => (b.width === wd && b.height === ht ? b : { width: wd, height: ht }));
    };
    const first = contentBox(el);
    if (first.width > 0 || first.height > 0) apply(first.width, first.height);
    if (typeof ResizeObserver === 'undefined') return;
    w.obs = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r) return;
      w.rect = r;
      if (w.cancel) return;
      w.cancel = nextFrame(() => {
        w.cancel = null;
        if (w.rect) apply(w.rect.width, w.rect.height);
      });
    });
    w.obs.observe(el);
  });
  // Unmount: stop observing (and forget the element, so a remount re-attaches)
  useEffect(() => () => unwatch(watch.current), []);

  return box;
}

/**
 * Width and height a chart lays out at: the box of useChartBox when it is
 * measured, else the svg's container measured now (first draw, before the
 * observer reported), else `fallback` per dimension (no layout: tests,
 * server render).
 *
 * @param {Element|null} svgEl - the chart's svg (its parent is the box)
 * @param {{width: number, height: number}} box - useChartBox's box
 * @param {{width: number, height: number}} [fallback]
 * @returns {{width: number, height: number}}
 */
export function chartSize(svgEl, box, fallback = NO_BOX) {
  if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  const m = contentBox(svgEl?.parentElement || null);
  return { width: m.width || fallback.width, height: m.height || fallback.height };
}

/**
 * On-screen CSS px per user unit of an svg drawn with a viewBox
 * (preserveAspectRatio meet): its layout size over its viewBox, the smaller
 * ratio. 1 when either is unknown. A label drawn at CHART_FONT / (scale x k)
 * reads at its CHART_FONT size on screen under a d3.zoom of k.
 *
 * @param {Element|null} svgEl
 * @returns {number}
 */
export function svgScreenScale(svgEl) {
  if (!svgEl || typeof svgEl.getAttribute !== 'function') return 1;
  const vb = String(svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return 1;
  let w = Number(svgEl.clientWidth) || 0;
  let h = Number(svgEl.clientHeight) || 0;
  if (!(w > 0) || !(h > 0)) {
    const r = typeof svgEl.getBoundingClientRect === 'function' ? svgEl.getBoundingClientRect() : null;
    w = r?.width || 0;
    h = r?.height || 0;
  }
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(w / vb[2], h / vb[3]);
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
