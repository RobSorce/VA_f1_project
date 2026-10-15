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
import { DIVERGING, TEXT_COLORS, getDriverColor, getDriverDash, markColor } from '../colors';
import { deltaHatchCss } from './deltaHatch';

// The base driver's zero line (D6): a reference, not a driver's line, so a
// style no other line of the chart has: a double line, two 1.5 px rails
// `offset` px above and below zero, in a neutral colour (>= 3:1 on the chart
// surface). The driver lines are single 2 px strokes in team colours, a
// teammate's dashed (colors.js TEAMMATE_DASHES, 6,3 / 8,3,2,3: the zero
// line used 6,3 until Phase 9c); the grid is dotted and faint, the hover
// rule dashed. A single solid 2 px grey line (Phase 9c, first round) matched
// a Haas line (#B6BABD, solid, 2 px: CIEDE2000 8.1, 1.23:1 between the two
// strokes); no driver line is double, whatever its colour. The chart names
// it at its end ("base: NOR", BASE_LABEL_COLOR) and the legend draws it as drawn.
export const BASE_LINE = Object.freeze({ stroke: TEXT_COLORS.muted, width: 1.5, dash: null, offset: 2 });
export const BASE_LABEL_COLOR = TEXT_COLORS.secondary;

/** Text naming the base line on the chart and in the legend. */
export function baseLineLabel(base) {
  return `base: ${base}`;
}

/**
 * Legend rows of the lap delta chart (V4): the base driver's zero line
 * (BASE_LINE, D6), one line per compared driver (team colour, teammate tint and dash:
 * V3), and the two shaded areas of the diverging pair, each with its sign.
 *
 * @param {string} base - base driver code
 * @param {string[]} drivers - compared drivers, in drawing order
 * @returns {Array<Object>} Legend items
 */
export function lapDeltaLegend(base, drivers) {
  if (!base) return [];
  return [
    {
      label: `${baseLineLabel(base)} (zero line)`, color: BASE_LINE.stroke, shape: 'line',
      dash: BASE_LINE.dash, strokeWidth: BASE_LINE.width, double: BASE_LINE.offset,
    },
    ...drivers.map((d) => ({
      label: d, color: markColor(getDriverColor(d)), shape: 'line', dash: getDriverDash(d),
    })),
    { label: `+ behind ${base}`, color: DIVERGING.worse, shape: 'band', fill: deltaHatchCss('worse') },
    { label: `− ahead of ${base}`, color: DIVERGING.better, shape: 'band', fill: deltaHatchCss('better') },
  ];
}

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
