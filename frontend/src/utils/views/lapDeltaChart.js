/**
 * View model of the lap delta chart (components/visualizations/LapDeltaChart.jsx):
 * each driver's time against the base driver over the laps completed at
 * sessionNow, read from the race trace on the focus reference
 * (utils/raceTrace.js), so the chart equals the Race Trace with that
 * reference, its sign turned to this chart's axis (+ = behind the base).
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { buildRaceTrace } from '../raceTrace';
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
 * Each driver's delta to the base driver on every lap both completed at
 * sessionNow (session seconds, utils/raceTime.js; decision R6): the race
 * trace on the focus reference (raceTrace.js buildRaceTrace) with the sign
 * of this chart, delta = cum_driver(k) - cum_base(k) = -y(k), + = behind.
 * The race clock is the lap rows' Time less the red-flag suspension, never a
 * sum of lap times: the old sum skipped every lap without a LapTimeSeconds
 * (a retirement, a red-flag lap), and every lap after it read short.
 * Drivers in race order at sessionNow, the base included (delta 0).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} opts
 * @param {string} opts.base - the base driver
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {Array<Object>} [opts.trackStatus] - sessionData.track_status (red flags)
 * @returns {Object<string, Array<{lap: number, delta: number}>>} by lap; {} without the base
 */
export function lapDeltaSeries(lapTimes, { base, sessionNow = Infinity, trackStatus = [] } = {}) {
  if (!base) return {};
  const trace = buildRaceTrace(lapTimes || [], {
    trackStatus, sessionNow, reference: 'focus', focusDriver: base,
  });
  if (trace.reference !== 'focus') return {};
  const out = {};
  for (const d of trace.drivers) {
    const points = d.points.filter((p) => !p.start).map((p) => ({ lap: p.lap, delta: -p.y }));
    if (points.length) out[d.driver] = points;
  }
  return out;
}
