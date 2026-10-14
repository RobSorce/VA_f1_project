/**
 * View model of the Race Situation Map (components/visualizations/RaceSituationMap.jsx):
 * the drawn positions and trails, the field-mean crosshair, the loading
 * arrows and the axis titles, from store.raceSituationData (utils/livePCA.js
 * computePCA, refitted at every lap and turned onto the previous lap's axes,
 * LIVE_PCA_ALIGN).
 *
 * A dot is drawn at its driver's score: the crosshair (the mean of the
 * scores) is the mean of the dots and a dot sits at crosshair + sum of z x
 * arrow, so the arrows read the dots exactly. Continuity between laps comes
 * from the alignment of the axes and from the component's animated
 * transition, never from drawing a dot away from its score.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component.
 *
 * Pure module: no React, no D3, no store access.
 */
import { FEATURE_LABELS, FEATURE_NAMES } from '../raceSituationFeatures';

/** Past positions kept per driver (trail length). Assumption: a display choice. */
export const MAX_TRAIL_LENGTH = 20;
/**
 * Loading arrows drawn: one per PCA input (FEATURE_NAMES), so every dot sits
 * at the crosshair plus the sum of z x arrow over the arrows drawn (with
 * fewer, the inputs left without an arrow would move the dots unseen).
 */
export const ARROW_COUNT = FEATURE_NAMES.length;

/**
 * Key of one race-situation computation: a new key is new lap data.
 *
 * @param {Object} rsd - store.raceSituationData
 * @returns {string}
 */
export function situationKey(rsd) {
  return `${rsd?.computedAtLap}|${rsd?.computedAtNow}`;
}

/**
 * Drawn positions and trails after a race-situation computation: each dot at
 * its driver's score (rsd.scores). Advanced only on new lap data (a new
 * situationKey): for the data already drawn (a hover, a selection, any other
 * re-render) the same state comes back. A jump back in time (a rewind) trims
 * the trails to the laps up to it. Trails hold the drawn positions, so a
 * trail ends at its dot; a past point stays where it was drawn at its lap.
 *
 * @param {Object|null} state - the previous advanceDisplay result
 * @param {Object} rsd - store.raceSituationData ({ driverAbbrs, scores, computedAtLap, computedAtNow })
 * @returns {{ key: string, lap: number, positions: Object<string, {x: number, y: number}>,
 *   trails: Object<string, Array<{x: number, y: number, lap: number}>> }}
 */
export function advanceDisplay(state, rsd) {
  const key = situationKey(rsd);
  if (state && state.key === key) return state;
  const lap = rsd.computedAtLap;
  const rewound = !!state && state.lap != null && lap < state.lap;

  const trails = {};
  for (const [abbr, trail] of Object.entries(state?.trails || {})) {
    trails[abbr] = rewound ? trail.filter((pt) => pt.lap <= lap) : trail;
  }

  const positions = {};
  rsd.driverAbbrs.forEach((abbr, i) => {
    const { x, y } = rsd.scores[i];
    positions[abbr] = { x, y };

    // One trail point per lap: a recompute of the same lap replaces it
    const trail = [...(trails[abbr] || [])];
    if (trail.length && trail[trail.length - 1].lap === lap) trail.pop();
    trail.push({ x, y, lap });
    trails[abbr] = trail.slice(-MAX_TRAIL_LENGTH);
  });

  return { key, lap, positions, trails };
}

/**
 * Field average of the scores: the crosshair, and the mean of the dots drawn
 * (advanceDisplay draws each dot at its score). The PCA is refitted on the
 * current means, so it is the origin up to rounding.
 *
 * @param {Array<{x: number, y: number}>} scores
 * @returns {{x: number, y: number}}
 */
export function fieldMean(scores) {
  if (!scores?.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const s of scores) { x += s.x; y += s.y; }
  return { x: x / scores.length, y: y / scores.length };
}

/**
 * Loading arrows (biplot): the ARROW_COUNT largest loadings of the displayed
 * basis (every input by default), drawn from the field mean. A driver's score is the sum over features
 * of z x (pc1, pc2), z his standardized value: an arrow is where a driver
 * moves when that feature rises by one SD, in the same basis as the points.
 * Features left out of the fit (loading 0) get no arrow.
 *
 * @param {Array<{feature: string, pc1: number, pc2: number}>} loadings - sorted by magnitude
 * @param {number} [n=ARROW_COUNT]
 * @returns {Array<{feature: string, label: string, pc1: number, pc2: number, magnitude: number}>}
 */
export function biplotArrows(loadings, n = ARROW_COUNT) {
  return (loadings || [])
    .map((l) => ({ ...l, label: FEATURE_LABELS[l.feature] || l.feature, magnitude: Math.hypot(l.pc1, l.pc2) }))
    .filter((l) => l.magnitude > 1e-9)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, n);
}

/**
 * Axis titles: the two features loading most on each axis and the share of
 * the variance the axis captures at this lap (explainedVariance), plus the
 * plane: the two axes span the PC1-PC2 plane, turned to follow the previous
 * lap (LIVE_PCA_ALIGN), so an axis is "Axis 1 / 2", not PC1 / PC2, and
 * together they capture the variance of PC1 + PC2 (the sum of the two
 * shares).
 *
 * @param {Array<{feature: string, pc1: number, pc2: number}>} loadings
 * @param {[number, number]} explainedVariance
 * @returns {{ x: string, y: string, plane: string }}
 */
export function axisTitles(loadings, explainedVariance) {
  const title = (k) => {
    const key = k === 0 ? 'pc1' : 'pc2';
    const top = [...(loadings || [])]
      .filter((l) => Math.abs(l[key]) > 1e-9)
      .sort((a, b) => Math.abs(b[key]) - Math.abs(a[key]))
      .slice(0, 2)
      .map((l) => FEATURE_LABELS[l.feature] || l.feature)
      .join(' / ');
    const share = explainedVariance?.[k];
    const pct = Number.isFinite(share) ? ` (${(share * 100).toFixed(0)}%)` : '';
    return `Axis ${k + 1}: ${top}${pct}`;
  };
  const both = (explainedVariance?.[0] ?? NaN) + (explainedVariance?.[1] ?? NaN);
  const plane = Number.isFinite(both) ? `PC1–PC2 plane: ${(both * 100).toFixed(0)}% of the variance` : 'PC1–PC2 plane';
  return { x: title(0), y: title(1), plane };
}
