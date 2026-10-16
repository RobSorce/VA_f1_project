/**
 * Replay speeds: the one list every speed control offers (the timeline's
 * speed pills, the Settings pills, the footer select) and steps through (the
 * < and > keys, the command palette's speed commands).
 *
 * Pure module: no React, no store access.
 */

/** The replay speeds, slowest first (multiples of real time). */
export const PLAYBACK_SPEEDS = Object.freeze([0.5, 1, 2, 5, 10, 20, 50]);

/**
 * The next listed speed faster (dir > 0) or slower (dir < 0) than `speed`,
 * from any speed: one not in the list (a speed stored by an older version,
 * e.g. 4x) steps to the nearest listed one on that side. null at either end
 * of the list (no wrap); a missing, non-numeric or non-positive speed counts
 * as 1x.
 *
 * @param {number} speed - the current speed (store playSpeed)
 * @param {number} dir - +1 faster, -1 slower
 * @returns {number|null}
 */
export function stepPlaybackSpeed(speed, dir) {
  const n = speed == null ? NaN : Number(speed);
  const s = Number.isFinite(n) && n > 0 ? n : 1;
  if (dir > 0) return PLAYBACK_SPEEDS.find((v) => v > s) ?? null;
  if (dir < 0) {
    for (let i = PLAYBACK_SPEEDS.length - 1; i >= 0; i--) if (PLAYBACK_SPEEDS[i] < s) return PLAYBACK_SPEEDS[i];
  }
  return null;
}
