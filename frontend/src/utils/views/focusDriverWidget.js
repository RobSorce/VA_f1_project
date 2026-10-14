/**
 * View model of the focus driver widget (components/ui/FocusDriverWidget.jsx):
 * the focus driver's position and tyre at sessionNow, race and qualifying.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { driverStateAt, qualifyingOrder } from '../driverState';

/**
 * Focus driver's position and tyre at sessionNow (session seconds), causal
 * (decision R6, utils/driverState.js): the position at the end of the last
 * completed lap (a lap's position is known once it is over), the tyre set in
 * force (the old set until the pit exit).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver
 * @param {number} sessionNow - session seconds, Infinity = whole race
 * @returns {{position: number|null, compound: string|null, tyreLife: number|null}}
 */
export function focusDriverStatus(lapTimes, driver, sessionNow) {
  if (!driver || !Array.isArray(lapTimes)) return { position: null, compound: null, tyreLife: null };
  const st = driverStateAt(lapTimes, driver, sessionNow, { dnf: false });
  return {
    position: st.lastCompleted?.Position || null,
    compound: st.stint ? (st.compound || 'UNKNOWN') : null,
    tyreLife: st.tyreLife != null ? Math.round(st.tyreLife) : null,
  };
}

/**
 * Qualifying position of a driver at sessionNow, causal: the rank by best lap
 * completed so far (utils/driverState.js qualifyingOrder), null before the
 * driver's first timed lap. Never the final classification. In a segment
 * replay only the segment's laps rank (opts.after, as the Leaderboard).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {string} driver
 * @param {number} sessionNow - session seconds
 * @param {Object} [opts]
 * @param {number} [opts.after] - the active segment's laps start after it
 *   (store qualiSegmentWindows[segment].start)
 * @returns {number|null}
 */
export function qualifyingPositionAt(lapTimes, driver, sessionNow, { after } = {}) {
  if (!driver) return null;
  return qualifyingOrder(lapTimes, sessionNow, { after }).find((r) => r.driver === driver)?.position ?? null;
}
