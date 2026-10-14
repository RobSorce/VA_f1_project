/**
 * Alignment reference of the Race Situation Map's live PCA during a replay
 * (store computeRaceSituation; utils/livePCA.js computePCA, LIVE_PCA_ALIGN).
 *
 * The map of lap L is turned onto the axes of lap L - 1 as a replay played
 * from the first lap draws them: every lap k from the first one with a fit is
 * fitted at its lap clock (the leader's end of lap k - 1, the lap-mode clock of
 * utils/raceTime.js resolveSessionNow) and turned onto lap k - 1's displayed
 * axes; the first fit keeps its own eigenvectors. The reference therefore
 * depends only on the session's rows, never on the path that led to the lap:
 * a lap reached by playing, by a seek forward or by a rewind is drawn on the
 * same axes, and a step back moves the dots no more than a step forward
 * (formerly a rewind refitted with no reference: the map could turn or
 * mirror). Causal: lap L - 1's axes use the laps completed at the start of
 * lap L - 1, before the clock of lap L.
 *
 * In live mode there is no going back: the store keeps aligning to the
 * previous computation (_prevPcaResult).
 *
 * Cached per lap-times array (a replay's rows never change); the chain grows
 * one lap at a time, so a forward replay fits each lap once more and a jump to
 * a late lap fits the laps before it once.
 *
 * Pure module: no React, no store access.
 */
import { computePCA, LIVE_PCA_ALIGN } from './livePCA';
import { extractRaceSituationFeatures, FEATURE_NAMES } from './raceSituationFeatures';
import { resolveSessionNow } from './raceTime';

/** First lap with a race-situation fit (extractRaceSituationFeatures needs lap 3). */
export const FIRST_SITUATION_LAP = 3;

// lap-times array -> { dnfMap, offset, upTo, last, laps: [{ result, now }] }
const chains = new WeakMap();
// The dnfMap of a call without one (one object, so the cache holds)
const NO_DNF = Object.freeze({});

function chainOf(lapTimes, dnfMap, sessionTimeOffset) {
  let c = chains.get(lapTimes);
  if (!c || c.dnfMap !== dnfMap || c.offset !== sessionTimeOffset) {
    c = { dnfMap, offset: sessionTimeOffset, upTo: FIRST_SITUATION_LAP - 1, last: null, laps: [] };
    chains.set(lapTimes, c);
  }
  return c;
}

/**
 * The displayed PCA of lap `lap` as a replay from the first lap draws it (its
 * computePCA result, carried over from the last lap with a fit when that lap
 * has none), or null before the first fit.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times of the replay
 * @param {number} lap
 * @param {{ dnfMap?: Object, sessionTimeOffset?: number }} [opts]
 * @returns {{ result: Object, now: number }|null} the result and the session
 *   seconds it was fitted at
 */
export function replayChainAt(lapTimes, lap, { dnfMap = NO_DNF, sessionTimeOffset } = {}) {
  if (!Array.isArray(lapTimes) || !lapTimes.length || !(lap >= FIRST_SITUATION_LAP)) return null;
  const c = chainOf(lapTimes, dnfMap, sessionTimeOffset);
  while (c.upTo < lap) {
    const k = c.upTo + 1;
    const now = resolveSessionNow({ currentLap: k, lapTimes, sessionTimeOffset });
    if (!Number.isFinite(now)) break; // past the last lap: no lap clock
    const f = extractRaceSituationFeatures({
      lapTimes, dnfMap, currentLap: k, frameDrivers: null, sessionNow: now, sessionTimeOffset,
    });
    const r = f ? computePCA(f.matrix, FEATURE_NAMES, c.last?.result ?? null, { align: LIVE_PCA_ALIGN }) : null;
    if (r) c.last = { result: r, now };
    c.laps[k] = c.last;
    c.upTo = k;
  }
  return c.laps[Math.min(lap, c.upTo)] || null;
}

/**
 * The alignment reference of the map at lap `lap` during a replay: the
 * displayed PCA of lap - 1 (replayChainAt), or of the latest earlier lap
 * fitted no later than `sessionNow`; null when there is none (the first fit
 * then keeps its own eigenvectors).
 *
 * @param {Array<Object>} lapTimes
 * @param {number} lap - the lap on screen
 * @param {{ dnfMap?: Object, sessionTimeOffset?: number, sessionNow?: number }} [opts]
 * @returns {Object|null} a computePCA result (its basis is the reference)
 */
export function replayReferenceAt(lapTimes, lap, { dnfMap = NO_DNF, sessionTimeOffset, sessionNow = Infinity } = {}) {
  for (let k = lap - 1; k >= FIRST_SITUATION_LAP; k--) {
    const at = replayChainAt(lapTimes, k, { dnfMap, sessionTimeOffset });
    if (!at) return null;
    if (!(at.now > sessionNow)) return at.result;
  }
  return null;
}
