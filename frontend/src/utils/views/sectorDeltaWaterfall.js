/**
 * View model of the sector delta waterfall (components/visualizations/SectorDeltaWaterfall.jsx):
 * the running order and the per-sector deltas at sessionNow.
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
