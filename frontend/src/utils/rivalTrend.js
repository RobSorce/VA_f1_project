/**
 * Gap trend of a rival of the focus driver (the focus card's Rivals rows,
 * store updateRivalContext): measured on the size of the gap on the side of
 * the focus driver the rival is on now, so "closing" is always the gap
 * shrinking and "opening" the gap growing, for a rival ahead as for one
 * behind. The signed gap (the rival's GapToLeader minus the focus driver's)
 * is negative for a rival ahead: its own change reads the other way round
 * for him.
 *
 * Pure module: no React, no store.
 */

/** Change of the gap (s) under which the trend is "stable", either way. */
export const GAP_TREND_THRESHOLD_S = 0.3;

/**
 * Change of the gap's size on the rival's side over the window: its size
 * at the last gap minus its size at the first. A gap from the other side
 * (the rival has passed or been passed since) counts as negative.
 *
 * @param {number[]} signedGaps - rival GapToLeader minus focus GapToLeader
 *   (s), oldest first; < 0 = the rival ahead
 * @param {1|-1} side - 1: the rival is behind the focus driver now, -1: ahead
 * @returns {number|null} > 0 the gap grows, < 0 it shrinks; null with fewer than 2 gaps
 */
export function rivalGapChange(signedGaps, side) {
  if (!Array.isArray(signedGaps) || signedGaps.length < 2) return null;
  const s = side < 0 ? -1 : 1;
  return s * signedGaps[signedGaps.length - 1] - s * signedGaps[0];
}

/**
 * The trend word of the focus card: 'closing' when the gap shrinks by more
 * than GAP_TREND_THRESHOLD_S, 'opening' when it grows by more, else
 * 'stable' (also with fewer than 2 gaps).
 *
 * @param {number[]} signedGaps
 * @param {1|-1} side
 * @returns {'closing'|'opening'|'stable'}
 */
export function rivalGapTrend(signedGaps, side) {
  const change = rivalGapChange(signedGaps, side);
  if (change == null) return 'stable';
  if (change < -GAP_TREND_THRESHOLD_S) return 'closing';
  if (change > GAP_TREND_THRESHOLD_S) return 'opening';
  return 'stable';
}
