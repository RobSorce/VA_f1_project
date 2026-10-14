/**
 * View model of the track map (components/visualizations/TrackMap.jsx):
 * per-driver status and the map's clock at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { resolveSessionNow } from '../raceTime';
import { driverStateAt, nonFinisherMap } from '../driverState';

// lap_times Compound -> the frame tyre code (TrackMap.jsx COMPOUND_NAMES)
const COMPOUND_CODES = { SOFT: 1, MEDIUM: 2, HARD: 3, INTERMEDIATE: 4, WET: 5 };

/**
 * Per-driver status for the map at sessionNow (session seconds), causal
 * (decision R6, utils/driverState.js): retired only once the retirement has
 * happened (final lap over, or pit entry of a retirement in the pits); the
 * tyre set in force, as a frame tyre code (the new set from the pit exit; the
 * replay frames switch to it at the out-lap start, inside the pit lane);
 * laps completed.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} sessionNow - session seconds, Infinity = whole race
 * @param {Object} [dnfMap] - store.dnfMap (did not finish; gated by time here)
 * @param {Object} [opts]
 * @param {boolean} [opts.isLiveMode] - live feed rows (driverState.js nonFinisherMap)
 * @returns {Object<string, {retired: boolean, tyre: number|null, tyreLife: number|null, lapsCompleted: number}>}
 */
export function trackMapDriverStatus(lapTimes, sessionNow, dnfMap = {}, { isLiveMode = false } = {}) {
  const byDriver = new Map();
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt?.Driver) continue;
    if (!byDriver.has(lt.Driver)) byDriver.set(lt.Driver, []);
    byDriver.get(lt.Driver).push(lt);
  }
  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap, { live: isLiveMode });
  const out = {};
  for (const [drv, rows] of byDriver) {
    const st = driverStateAt(rows, drv, sessionNow, { dnf: !!nonFinishers[drv] });
    out[drv] = {
      retired: st.retired,
      tyre: COMPOUND_CODES[st.compound] ?? null,
      tyreLife: st.tyreLife,
      lapsCompleted: st.lapsCompleted,
    };
  }
  return out;
}

/**
 * The map's clock in session seconds: the session time of the frame on screen
 * (frame.t + sessionTimeOffset; utils/raceTime.js resolveSessionNow), the
 * lap-mode / live clock otherwise. Same rule as the store's getSessionNow: a
 * qualifying segment's last frame is not the end of the session (the next
 * segments follow): it stands for the segment's end (qualiSegmentWindows),
 * never Infinity.
 *
 * @param {Object} s - store fields (qualiSegmentWindows, qualiSegment included) plus
 *   frameTime (t of the frame on screen)
 * @returns {number} session seconds, or Infinity
 */
export function trackMapSessionNow({
  frameTime, sessionTimeOffset, totalFrames, currentLap, maxLap, lapTimes, isLiveMode,
  isQualifyingReplay, maxTime, frameDt, lapModeRaceOver, qualiSegmentWindows, qualiSegment,
}) {
  const segment = isQualifyingReplay ? qualiSegmentWindows?.[qualiSegment] : null;
  return resolveSessionNow({
    currentTime: frameTime, sessionTimeOffset, replayActive: totalFrames > 0, currentLap, maxLap,
    lapTimes, isLiveMode, maxTime, frameDt, raceOver: lapModeRaceOver,
    qualifying: !!isQualifyingReplay, segmentEnd: segment?.end,
  });
}
