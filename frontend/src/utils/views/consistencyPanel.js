/**
 * View model of the consistency panel (components/visualizations/ConsistencyPanel.jsx):
 * lap-time consistency per driver from the laps completed at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { completedLaps, hasPitOut, isPitVisible } from '../raceTime';

/**
 * Lap-time consistency per driver from the laps completed at sessionNow
 * (session seconds): pit laps (in-lap, out-lap) left out, outliers above
 * 1.5x the driver's median removed, population σ and CV, per-compound
 * averages and degradation slope. Nothing from a lap still running is used
 * (decision R6), so a coming pit stop cannot change the numbers before it.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @returns {{ drivers: Array<Object>, sessionAvg: number|null, minLapsThreshold: number }}
 */
export function consistencyStats(lapTimes, sessionNow) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return { drivers: [], sessionAvg: null, minLapsThreshold: 0 };
  const done = completedLaps(lapTimes, sessionNow);

  // Use 75% of the leader's completed laps as the minimum — DNFs produce
  // artificially narrow σ from tiny samples (H1/V1.4, demonstrated by HUL
  // at São Paulo 2024).
  let leaderLaps = 0;
  for (const lt of done) if (lt.LapNumber > leaderLaps) leaderLaps = lt.LapNumber;
  const threshold75 = Math.max(3, Math.floor(leaderLaps * 0.75));

  const driverLaps = {};
  for (const lt of done) { // laps completed at sessionNow only
    const drv = lt.Driver;
    const t = lt.LapTimeSeconds;
    const compound = lt.Compound || 'UNKNOWN';
    const tyreLife = lt.TyreLife || 0;
    if (!drv || !t || typeof t !== 'number' || isNaN(t) || t <= 0) continue;
    // Skip pit laps: the in-lap once its pit entry happened, the out-lap
    // (its pit exit lies inside the lap, so it is over once the lap is)
    if (isPitVisible(lt, sessionNow) || hasPitOut(lt)) continue;

    if (!driverLaps[drv]) driverLaps[drv] = [];
    driverLaps[drv].push({ time: t, compound, tyre_life: tyreLife });
  }

  const results = [];
  const allValidTimes = [];

  for (const [drv, laps] of Object.entries(driverLaps)) {
    const times = laps.map((l) => l.time);
    if (times.length < 3) continue;

    // Remove outliers (> 1.5x median)
    const sorted = [...times].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const threshold = median * 1.5;
    const valid = laps.filter((l) => l.time <= threshold);
    const outliers = laps.length - valid.length;
    const validTimes = valid.map((l) => l.time);
    if (validTimes.length < 2) continue;

    const avg = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    const fastest = Math.min(...validTimes);
    const slowest = Math.max(...validTimes);
    const range = slowest - fastest;
    // Population stdDev (÷ n): we describe the full observed distribution, not inferring a population
    const variance = validTimes.reduce((a, t) => a + (t - avg) ** 2, 0) / validTimes.length;
    const stdDev = Math.sqrt(variance);
    const cvPercent = avg > 0 ? (stdDev / avg) * 100 : 0;

    allValidTimes.push(...validTimes);

    // Per-compound breakdown
    const compoundMap = {};
    for (const l of valid) {
      if (!compoundMap[l.compound]) compoundMap[l.compound] = { times: [], tyre_lives: [] };
      compoundMap[l.compound].times.push(l.time);
      compoundMap[l.compound].tyre_lives.push(l.tyre_life);
    }

    const compounds = {};
    for (const [c, cdata] of Object.entries(compoundMap)) {
      const n = cdata.times.length;
      const cAvg = cdata.times.reduce((a, b) => a + b, 0) / n;
      const avgTyreLife = cdata.tyre_lives.reduce((a, b) => a + b, 0) / n;

      // Linear regression: lap time vs tyre life → degradation slope
      let degRate = 0;
      if (n > 2) {
        const meanTL = avgTyreLife;
        const meanT = cAvg;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (cdata.tyre_lives[i] - meanTL) * (cdata.times[i] - meanT);
          den += (cdata.tyre_lives[i] - meanTL) ** 2;
        }
        if (den > 0) {
          // slope (seconds per tyre-life unit) → normalise to % of avg lap time
          degRate = Math.round(((num / den) / cAvg) * 100 * 100) / 100; // % per lap
        }
      }

      compounds[c] = {
        avg: Math.round(cAvg * 1000) / 1000,
        count: n,
        avg_tyre_life: Math.round(avgTyreLife * 10) / 10,
        deg_rate: degRate,
      };
    }

    results.push({
      driver: drv,
      team: '',
      number: '',
      avg_lap: Math.round(avg * 1000) / 1000,
      fastest: Math.round(fastest * 1000) / 1000,
      slowest: Math.round(slowest * 1000) / 1000,
      range: Math.round(range * 1000) / 1000,
      std_dev: Math.round(stdDev * 1000) / 1000,
      cv_percent: Math.round(cvPercent * 100) / 100,
      sample_size: validTimes.length,
      lap_count: validTimes.length,
      insufficient_data: validTimes.length < threshold75,
      outliers,
      compounds,
    });
  }

  // Use median CV as the consistency threshold (relative to the field)
  const allCVs = results.map((r) => r.cv_percent).sort((a, b) => a - b);
  const medianCV = allCVs.length > 0 ? allCVs[Math.floor(allCVs.length / 2)] : 1;
  results.forEach((r) => {
    r.is_consistent = r.cv_percent <= medianCV;
  });

  results.sort((a, b) => a.avg_lap - b.avg_lap);
  const sAvg = allValidTimes.length > 0
    ? Math.round((allValidTimes.reduce((a, b) => a + b, 0) / allValidTimes.length) * 1000) / 1000
    : null;

  return { drivers: results, sessionAvg: sAvg, minLapsThreshold: threshold75 };
}
