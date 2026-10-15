/**
 * View model of the sector delta waterfall (components/visualizations/SectorDeltaWaterfall.jsx):
 * the running order, the per-sector deltas at sessionNow and the waterfall
 * geometry (steps, laps that fit, value domain) the D3 drawing
 * (sectorDeltaWaterfallChart.js) reads.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { isLapCompleted } from '../raceTime';

/**
 * Running order at sessionNow (session seconds) from the laps completed by
 * then: more laps completed first, then the earlier line crossing (Time of
 * that lap). Drivers with no completed lap are left out.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} sessionNow
 * @returns {string[]} driver codes, leader first
 */
export function runningOrderAt(lapTimes, sessionNow) {
  const last = {};
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt?.Driver || !isLapCompleted(lt, sessionNow)) continue;
    const cur = last[lt.Driver];
    if (!cur || lt.LapNumber > cur.LapNumber) last[lt.Driver] = lt;
  }
  const crossed = (lt) => (Number.isFinite(lt.Time) ? lt.Time : Infinity);
  const position = (lt) => (Number.isFinite(lt.Position) ? lt.Position : Infinity);
  return Object.values(last)
    .sort((a, b) => (b.LapNumber - a.LapNumber) || (crossed(a) - crossed(b))
      || (position(a) - position(b)) || a.Driver.localeCompare(b.Driver))
    .map((lt) => lt.Driver);
}

/**
 * Per-sector deltas focus - reference over the laps BOTH drivers completed at
 * sessionNow (session seconds), most recent first, at most `limit` laps. A lap
 * still running for either driver is left out, so no unfinished sector (e.g. an
 * in-lap's S3 through the pit lane) is shown before it is over.
 *
 * @param {Array<Object>} lapTimes
 * @param {string} focus
 * @param {string} ref
 * @param {number} sessionNow
 * @param {number} [limit=12]
 * @returns {Array<{lap: number, sectors: Array<number|null>, cumulative: number|null, lapDelta: number|null}>}
 */
export function sectorDeltaRows(lapTimes, focus, ref, sessionNow, limit = 12) {
  if (!focus || !ref || focus === ref) return [];
  const focusLaps = {};
  const refLaps = {};
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!isLapCompleted(lt, sessionNow)) continue;
    if (lt.Driver === focus) focusLaps[lt.LapNumber] = lt;
    if (lt.Driver === ref) refLaps[lt.LapNumber] = lt;
  }
  const laps = Object.keys(focusLaps)
    .map(Number)
    .filter((n) => refLaps[n])
    .sort((a, b) => b - a) // most recent first
    .slice(0, limit);

  return laps.map((lap) => {
    const f = focusLaps[lap];
    const r = refLaps[lap];
    const s = [1, 2, 3].map((si) => {
      const fv = f[`Sector${si}TimeSeconds`];
      const rv = r[`Sector${si}TimeSeconds`];
      if (!fv || !rv || fv <= 0 || rv <= 0 || fv > 300 || rv > 300) return null;
      return +(fv - rv).toFixed(3);
    });
    const deltas = s.map((v) => v || 0);
    const cumulative = [deltas[0], deltas[0] + deltas[1], deltas[0] + deltas[1] + deltas[2]];
    return {
      lap,
      sectors: s, // null if missing
      cumulative: s.every((v) => v != null) ? +cumulative[2].toFixed(3) : null,
      lapDelta: f.LapTimeSeconds && r.LapTimeSeconds
        ? +(f.LapTimeSeconds - r.LapTimeSeconds).toFixed(3)
        : null,
    };
  });
}

/**
 * Mean delta per sector over the rows (null for a sector no row has), three
 * decimals: the AVG line above the chart.
 *
 * @param {Array<{sectors: Array<number|null>}>} rows
 * @returns {Array<number|null>} [S1, S2, S3]
 */
export function sectorMeans(rows) {
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  for (const r of Array.isArray(rows) ? rows : []) {
    (r.sectors || []).forEach((v, i) => {
      if (v != null && i < 3) { sums[i] += v; counts[i] += 1; }
    });
  }
  return sums.map((s, i) => (counts[i] ? +(s / counts[i]).toFixed(3) : null));
}

/**
 * The waterfall of one lap: S1 starts at 0 and each next sector starts where
 * the previous one ended, so the last step ends at the lap's delta (the sum
 * of the three). A missing sector (null) is a gap of zero length flagged
 * `missing`, and the lap then has no total (the sum would be wrong).
 *
 * @param {{sectors: Array<number|null>, cumulative: number|null}} row
 * @returns {{steps: Array<{sector: number, from: number, to: number, value: number|null, missing: boolean}>, total: number|null}}
 */
export function waterfallSteps(row) {
  let at = 0;
  const steps = [0, 1, 2].map((i) => {
    const v = row?.sectors?.[i];
    const missing = v == null || !Number.isFinite(v);
    const from = at;
    if (!missing) at = +(at + v).toFixed(3);
    return { sector: i + 1, from, to: at, value: missing ? null : v, missing };
  });
  const total = steps.every((s) => !s.missing) ? at : null;
  return { steps, total };
}

/**
 * Laps the waterfall draws, oldest first (time left to right): the most
 * recent `maxLaps` of the rows (sectorDeltaRows gives them most recent first).
 *
 * @param {Array<{lap: number}>} rows
 * @param {number} maxLaps
 * @returns {Array<Object>}
 */
export function waterfallLaps(rows, maxLaps) {
  const k = Math.max(0, Math.floor(Number(maxLaps) || 0));
  return (Array.isArray(rows) ? rows : []).slice(0, k).slice().reverse();
}

/** Narrowest lap column of the waterfall (three bars and their gaps), CSS px. */
export const WATERFALL_MIN_LAP_PX = 30;

/**
 * How many laps fit a plot `width` px wide, at WATERFALL_MIN_LAP_PX each,
 * between 1 and `cap` (the rows sectorDeltaRows returns).
 *
 * @param {number} width
 * @param {number} cap
 * @returns {number}
 */
export function waterfallLapsThatFit(width, cap) {
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return cap;
  return Math.max(1, Math.min(cap, Math.floor(w / WATERFALL_MIN_LAP_PX)));
}

/**
 * Value domain of the waterfall: 0 and every partial sum of the laps drawn,
 * at least +/- `minHalf` seconds around 0 (a flat chart of noise is not
 * stretched to the full height).
 *
 * @param {Array<Object>} rows
 * @param {number} [minHalf=0.1]
 * @returns {[number, number]}
 */
export function waterfallDomain(rows, minHalf = 0.1) {
  let lo = -minHalf;
  let hi = minHalf;
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const s of waterfallSteps(r).steps) {
      lo = Math.min(lo, s.from, s.to);
      hi = Math.max(hi, s.from, s.to);
    }
  }
  return [lo, hi];
}

/** Signed seconds with three decimals: '+0.123', '−0.045', '0.000'. */
export function fmtDelta(s, digits = 3) {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s === 0) return (0).toFixed(digits);
  return `${s > 0 ? '+' : '−'}${Math.abs(s).toFixed(digits)}`;
}
