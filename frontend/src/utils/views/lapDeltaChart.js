/**
 * View model of the lap delta chart (components/visualizations/LapDeltaChart.jsx):
 * cumulative race time per driver over the laps completed at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { completedLaps } from '../raceTime';

/**
 * Cumulative race time per driver over the laps COMPLETED at sessionNow
 * (session seconds, utils/raceTime.js): a lap time is known at the lap's
 * end, so the chart never draws a lap still running (decision R6). Laps
 * without a usable time (0 < LapTimeSeconds < 300) are skipped.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {Object<string, Array<{lap: number, cumTime: number, lapTime: number}>>} by lap
 */
export function cumulativeLapTimes(lapTimes, sessionNow = Infinity) {
  const map = {};
  for (const d of completedLaps(lapTimes || [], sessionNow)) {
    if (!map[d.Driver]) map[d.Driver] = {};
    if (d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300) {
      map[d.Driver][d.LapNumber] = d.LapTimeSeconds;
    }
  }
  const cumMap = {};
  for (const [driver, laps] of Object.entries(map)) {
    const sortedLaps = Object.keys(laps).map(Number).sort((a, b) => a - b);
    const cumArr = [];
    let sum = 0;
    for (const lap of sortedLaps) {
      sum += laps[lap];
      cumArr.push({ lap, cumTime: sum, lapTime: laps[lap] });
    }
    cumMap[driver] = cumArr;
  }
  return cumMap;
}
