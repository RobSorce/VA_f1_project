/**
 * The words that say how the one lap range of every view is set (store
 * setBrushLapRange): the hint of the views it is dragged on (the Race Trace
 * plot, the Lap Times bar) and the note of Race Pace, which reads it.
 *
 * Pure module: no React, no D3, no store access.
 */

/** The hint of a view the range is dragged on, while no range is set. */
export const LAP_RANGE_DRAG_HINT = 'Drag across laps to select a range';

/** The note of Race Pace while no range is set (every lap counts). */
export const LAP_RANGE_ALL_LAPS = 'All laps · drag on Race Trace or Lap Times to pick a range';

/**
 * The hint of a view the range is dragged on: how to set one, or the range
 * set and how to clear it.
 *
 * @param {[number, number]|null} range - [first lap, last lap]
 * @returns {string}
 */
export function lapRangeHint(range) {
  if (!Array.isArray(range) || range.length !== 2) return LAP_RANGE_DRAG_HINT;
  return `laps ${range[0]}–${range[1]} selected · click the plot to clear`;
}
