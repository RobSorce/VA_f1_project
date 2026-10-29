/**
 * Ring geometry of the Circle of Doom view (components/visualizations/
 * CircleOfDoom.jsx) that the model does not give: the pit-lane segment, the
 * angles the cars in the lane are drawn at, the rejoin point the band runs
 * to, and the PIT / OUT tags of a stop under way.
 *
 * Angles are radians clockwise from the top, as in utils/circleOfDoom.js:
 * point (cx + r sin a, cy - r cos a).
 *
 * Pit-lane segment. The arc at the radius rPit from -θ to the timing line
 * (angle 0), θ = PIT_SPAN_SLOTS car slots (2 carR + 1 px each) at rPit, within
 * [PIT_SPAN_MIN, PIT_SPAN_MAX]: not to scale. A car in the lane is drawn at
 * -θ + u θ, u = min(LANE_PROGRESS_MAX, seconds since its pit entry / the
 * race's median lane time, circlePitLane.laneStats); without a median, or
 * without a pit entry time, at the entry end (-θ). Then, in entry order (the
 * first in furthest along), each car at least one slot behind the one before,
 * moved back inside the segment from the entry end; more cars than the
 * segment holds share it evenly, in entry order. These angles are the
 * drawing's only: the analytics read the model's phases.
 *
 * Pure module: no React, no D3, no store access.
 */
import { polar, wrapAngle } from '../circleLabelLayout';
import { laneSecondsAt } from '../circleGapList';

const TWO_PI = 2 * Math.PI;
/** Car slots the pit-lane segment spans at its radius, at least. */
export const PIT_SPAN_SLOTS = 3;
/** Span of the pit-lane segment, radians: 20° to 60°. */
export const PIT_SPAN_MIN = Math.PI / 9;
export const PIT_SPAN_MAX = Math.PI / 3;
/** Progress through the lane a car is drawn at, at most (short of the exit end). */
export const LANE_PROGRESS_MAX = 0.95;
/** A lane car's label box: its seconds measured at two digits at least. */
export const LANE_LABEL_SECONDS = '88';

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Span θ of the pit-lane segment, radians (module header).
 *
 * @param {number} carR - car radius, px
 * @param {number} rPit - radius of the segment, px
 * @returns {number}
 */
export function pitSpan(carR, rPit) {
  return clamp((PIT_SPAN_SLOTS * (2 * carR + 1)) / Math.max(1, rPit), PIT_SPAN_MIN, PIT_SPAN_MAX);
}

/**
 * Draw angles of the cars in the pit lane (module header).
 *
 * @param {Array<{driver: string, pitInTime: number|null}>} lane - cars in the lane
 * @param {Object} p
 * @param {number} p.theta - span of the segment, radians
 * @param {number} p.gap - one slot along the segment, radians
 * @param {number|null} p.median - median lane time of the race, seconds (laneStats)
 * @param {number} p.now - session seconds
 * @returns {Map<string, number>} driver -> angle in [-θ, 0], radians
 */
export function laneAngles(lane, {
  theta, gap, median, now,
}) {
  const order = [...lane].sort((a, b) => ((a.pitInTime ?? Infinity) - (b.pitInTime ?? Infinity))
    || a.driver.localeCompare(b.driver));
  const a = order.map((c) => (median > 0 && c.pitInTime != null && Number.isFinite(now)
    ? -theta + theta * clamp((now - c.pitInTime) / median, 0, LANE_PROGRESS_MAX)
    : -theta));
  for (let i = 1; i < a.length; i += 1) a[i] = Math.min(a[i], a[i - 1] - gap);
  if (a.length && a[a.length - 1] < -theta) {
    a[a.length - 1] = -theta;
    for (let i = a.length - 2; i >= 0; i -= 1) a[i] = Math.max(a[i], a[i + 1] + gap);
  }
  if (a.length > 1 && a[0] > 0) {
    for (let i = 0; i < a.length; i += 1) a[i] = -theta + (theta * (a.length - 1 - i)) / (a.length - 1);
  }
  return new Map(order.map((c, i) => [c.driver, a[i]]));
}

/** SVG path of the pit-lane segment: the arc at rPit from -θ clockwise to the timing line. */
export function pitLanePath(cx, cy, rPit, theta) {
  const [x0, y0] = polar(cx, cy, rPit, -theta);
  const [x1, y1] = polar(cx, cy, rPit, 0);
  return `M${x0},${y0}A${rPit},${rPit} 0 0 1 ${x1},${y1}`;
}

/**
 * Angle of the rejoin point of a pit window (circleOfDoom.pitWindow) for a
 * focus drawn at af: the pending loss back from where it is drawn; for a stop
 * under way the model's rejoinPhase (placed from its line time), taken within
 * half a turn of af, so the band from it to the car never wraps round the
 * ring (when it is ahead of the car the band is empty).
 *
 * @param {number} af - angle the focus is drawn at, radians
 * @param {{ongoingStop: boolean, rejoinOffset: number, rejoinPhase: number}} win
 * @returns {number} radians, not wrapped
 */
export function rejoinAngle(af, win) {
  if (!win.ongoingStop) return af - TWO_PI * win.rejoinOffset;
  return af - (wrapAngle(af - TWO_PI * win.rejoinPhase + Math.PI) - Math.PI);
}

/**
 * Tag of a car in the middle of its stop (circlePitLane.pitStatus): 'PIT 14'
 * in the lane (whole seconds since its pit entry; 'PIT' without a pit entry
 * time), 'OUT' on its out-lap; '' otherwise.
 *
 * @param {{status: 'lane'|'out'|null, pitInTime: number|null}|null} stop
 * @param {number} now - session seconds
 * @returns {string}
 */
export function stopTag(stop, now) {
  if (!stop?.status) return '';
  if (stop.status === 'out') return 'OUT';
  const secs = laneSecondsAt(stop.pitInTime, now);
  return secs == null ? 'PIT' : `PIT ${secs}`;
}

/** The text a stop tag's label box is measured at: its seconds at two digits at least. */
export function stopTagBox(stop, now) {
  return stopTag(stop, now).replace(/\d+/, (d) => (d.length > LANE_LABEL_SECONDS.length ? '8'.repeat(d.length) : LANE_LABEL_SECONDS));
}
