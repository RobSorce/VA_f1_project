/**
 * Dock capacity (V13): how many reorderable items the bottom dock shows on
 * its one row. The dock never scrolls; the items that do not fit go to the
 * overflow (⋯) popover. BottomTabBar measures the rendered buttons (labels
 * scale with the type tokens, so a fixed per-item width was wrong) and asks
 * this function how many fit.
 *
 * Phase 9c (D2): the measure counts everything that occupies the bar: the
 * buttons, the gaps between every two children, the bar's padding and
 * border, the divider with its margins and the fixed group (Layouts, ⌘K,
 * Settings) — dockRow. The browser pass found 1439 px of buttons in the
 * 1400 px bar at 1536 x 750. The buttons were measured once, when the dock
 * mounted, with the fallback font's labels, narrower than those of the web
 * font of the time (loaded later), and the divider's 12 px of margin and the
 * bar's border were not counted.
 * BottomTabBar now measures again when the fonts finish loading and checks
 * the row after every render.
 *
 * Pure functions, no DOM: unit-tested in __tests__/layout.dock.test.js and
 * __tests__/dock.fit.test.jsx.
 */

/**
 * Number of leading items that fit.
 *
 * @param {number[]} widths - measured width (px) of each item, in dock order
 * @param {{available: number, fixedWidth: number, overflowWidth: number, gap?: number}} room
 *   available: the dock's maximum width (border box); fixedWidth: everything
 *   that is not an item (dockRow of the other children: paddings, border,
 *   divider with its margins, the fixed Layouts / ⌘K / Settings buttons and
 *   the gaps between them); overflowWidth: the ⋯ button, needed only when
 *   some items do not fit; gap: flex gap between two children (each item
 *   adds one, next to its neighbour)
 * @returns {number} items shown: all of them when they fit, else the most that
 *   fit next to the ⋯ button, never fewer than 1
 */
export function dockCapacity(widths, { available, fixedWidth, overflowWidth, gap = 0 }) {
  const list = (Array.isArray(widths) ? widths : []).map((w) => Math.max(0, Number(w) || 0));
  const n = list.length;
  if (n === 0) return 0;
  const room = Number(available) - Math.max(0, Number(fixedWidth) || 0);
  if (!Number.isFinite(room)) return n;
  const width = (k) => list.slice(0, k).reduce((a, w) => a + w, 0) + k * gap;
  if (width(n) <= room + 0.5) return n;
  const withOverflow = room - Math.max(0, Number(overflowWidth) || 0) - gap;
  let k = n - 1;
  while (k > 1 && width(k) > withOverflow + 0.5) k -= 1;
  return Math.max(1, k);
}

/**
 * Width (px) of a row of flex children: each child's border box plus its
 * horizontal margins, a gap between every two, the container's horizontal
 * padding and border.
 *
 * @param {Array<{width: number, marginLeft?: number, marginRight?: number}>} children
 * @param {{gap?: number, paddingLeft?: number, paddingRight?: number, borderLeft?: number, borderRight?: number}} box
 * @returns {number}
 */
export function dockRow(children, {
  gap = 0, paddingLeft = 0, paddingRight = 0, borderLeft = 0, borderRight = 0,
} = {}) {
  const list = Array.isArray(children) ? children : [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sum = list.reduce((a, c) => a + num(c.width) + num(c.marginLeft) + num(c.marginRight), 0);
  return sum + Math.max(0, list.length - 1) * num(gap)
    + num(paddingLeft) + num(paddingRight) + num(borderLeft) + num(borderRight);
}
