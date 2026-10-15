/**
 * Dock capacity (V13): how many reorderable items the bottom dock shows on
 * its one row. The dock never scrolls; the items that do not fit go to the
 * overflow (⋯) popover. BottomTabBar measures the rendered buttons (labels
 * scale with the type tokens, so a fixed per-item width was wrong) and asks
 * this function how many fit.
 *
 * Pure function, no DOM: unit-tested in __tests__/layout.dock.test.js.
 */

/**
 * Number of leading items that fit.
 *
 * @param {number[]} widths - measured width (px) of each item, in dock order
 * @param {{available: number, fixedWidth: number, overflowWidth: number, gap?: number}} room
 *   available: the dock's maximum width; fixedWidth: everything that is not an
 *   item (paddings, divider, the fixed Layouts / ⌘K / Settings buttons and the
 *   gaps around them); overflowWidth: the ⋯ button, needed only when some
 *   items do not fit; gap: flex gap between two buttons
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
