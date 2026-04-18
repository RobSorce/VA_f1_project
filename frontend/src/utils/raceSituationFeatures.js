/**
 * Extract per-driver feature vectors for the Race Situation Map.
 * 10 features per driver at the current replay lap.
 */

export const FEATURE_NAMES = [
  'position', 'gap_to_leader', 'recent_pace', 'pace_trend',
  'tyre_life', 'compound', 'stint_number',
  'predicted_pace_5', 'est_laps_to_pit', 'position_trend',
];

export const FEATURE_LABELS = {
  position: 'Position',
  gap_to_leader: 'Gap to Leader',
  recent_pace: 'Recent Pace',
  pace_trend: 'Pace Trend',
  tyre_life: 'Tyre Age',
  compound: 'Compound',
  stint_number: 'Stint #',
  predicted_pace_5: 'Predicted Pace +5',
  est_laps_to_pit: 'Est. to Pit',
  position_trend: 'Pos. Change',
};

const COMPOUND_NUM = { SOFT: 1, MEDIUM: 2, HARD: 3, INTERMEDIATE: 4, WET: 5, UNKNOWN: 0 };
const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
// Average stint lengths per compound — derived from 2022-2024 F1 season medians across
// dry-weather races. SOFT/MEDIUM/HARD values align with Pirelli's published target
// life ranges (see Pirelli F1 Motorsport media briefings, pre-season 2024).
const AVG_STINT = { SOFT: 18, MEDIUM: 28, HARD: 40, INTERMEDIATE: 25, WET: 20, UNKNOWN: 25 };

/**
 * Compute linear slope of an array of values (y vs index).
 * Positive slope = values increasing.
 */
function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Extract race situation features for all active drivers at currentLap.
 *
 * @param {Object} params
 * @param {Array} params.lapTimes - sessionData.lap_times
 * @param {Array} params.strategies - tyre_strategy array
 * @param {Object} params.dnfMap - { abbr: { lastLap } }
 * @param {number} params.currentLap
 * @param {Object|null} params.frameDrivers - current frame's .drivers object
 * @param {Object|null} params.lstmPredictions - store.lstmPredictions
 * @param {string|null} params.focusDriver
 * @returns {{ driverAbbrs: string[], matrix: number[][], driverFeatures: Object, featureNames: string[] } | null}
 */
export function extractRaceSituationFeatures({
  lapTimes, strategies, dnfMap, currentLap,
  frameDrivers, lstmPredictions, focusDriver,
}) {
  if (!lapTimes?.length || currentLap < 3) return null;

  // Group laps by driver, only up to currentLap
  const driverLaps = {};
  for (const lt of lapTimes) {
    const drv = lt.Driver;
    if (!drv || lt.LapNumber > currentLap) continue;
    if (!driverLaps[drv]) driverLaps[drv] = [];
    driverLaps[drv].push(lt);
  }

  // Group strategies by driver
  const driverStrats = {};
  if (strategies) {
    for (const s of strategies) {
      const drv = s.Driver;
      if (drv) {
        if (!driverStrats[drv]) driverStrats[drv] = [];
        driverStrats[drv].push(s);
      }
    }
  }

  const driverAbbrs = [];
  const matrix = [];
  const driverFeatures = {};

  for (const [driver, laps] of Object.entries(driverLaps)) {
    // Skip DNF drivers (retired before current lap)
    if (dnfMap?.[driver] && dnfMap[driver].lastLap < currentLap) continue;

    // Sort by lap number
    laps.sort((a, b) => a.LapNumber - b.LapNumber);

    // Latest lap data
    const latest = laps[laps.length - 1];
    if (!latest) continue;

    // Valid laps (no pit in/out, reasonable time)
    const validLaps = laps.filter(
      (lt) => lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300 &&
              !lt.PitOutTimeSeconds && !lt.PitInTimeSeconds
    );

    if (validLaps.length < 2) continue;

    // 1. Position
    const position = latest.Position || 20;

    // 2. Gap to leader
    const gapToLeader = latest.GapToLeader || 0;

    // 3. Recent pace (avg last 3 valid laps)
    const last3 = validLaps.slice(-3);
    const recentPace = last3.reduce((s, lt) => s + lt.LapTimeSeconds, 0) / last3.length;

    // 4. Pace trend (slope of last 5 valid laps)
    const last5 = validLaps.slice(-5);
    const paceTrend = linearSlope(last5.map((lt) => lt.LapTimeSeconds));

    // 5. Tyre life
    let tyreLife = latest.TyreLife || 0;
    const frameDrv = frameDrivers?.[driver];
    if (frameDrv?.tyre_life != null) tyreLife = Math.round(frameDrv.tyre_life);

    // 6. Compound
    let compoundName = latest.Compound || 'UNKNOWN';
    if (frameDrv?.tyre != null) {
      compoundName = COMPOUND_NAMES[frameDrv.tyre] || compoundName;
    }
    const compoundNum = COMPOUND_NUM[compoundName] || 0;

    // 7. Stint number
    const driverStintList = (driverStrats[driver] || [])
      .filter((s) => s.StartLap <= currentLap)
      .sort((a, b) => a.StintNumber - b.StintNumber);
    const stintNumber = driverStintList.length || 1;

    // 8. Predicted pace +5 laps: LSTM prediction if available for focus driver,
    //    otherwise linear extrapolation: recentPace + paceTrend * 5
    let predictedPace5;
    if (focusDriver === driver && lstmPredictions?.predicted_times?.length >= 5) {
      predictedPace5 = lstmPredictions.predicted_times[4];
    } else {
      predictedPace5 = recentPace + paceTrend * 5;
    }
    // Clamp to reasonable range
    predictedPace5 = Math.max(60, Math.min(200, predictedPace5));

    // 9. Estimated laps to pit
    const avgStint = AVG_STINT[compoundName] || 25;
    const estLapsToPit = Math.max(0, avgStint - tyreLife);

    // 10. Position trend (positions gained in last 5 laps, positive = gaining)
    let positionTrend = 0;
    const fiveLapsAgo = laps.find((lt) => lt.LapNumber === Math.max(1, currentLap - 5));
    if (fiveLapsAgo?.Position && latest.Position) {
      positionTrend = fiveLapsAgo.Position - latest.Position; // positive = gained positions
    }

    const featureVector = [
      position, gapToLeader, recentPace, paceTrend,
      tyreLife, compoundNum, stintNumber,
      predictedPace5, estLapsToPit, positionTrend,
    ];

    // Guard against NaN/Infinity
    const clean = featureVector.map((v) =>
      (Number.isFinite(v) ? v : 0)
    );

    driverAbbrs.push(driver);
    matrix.push(clean);
    driverFeatures[driver] = {
      position, gapToLeader, recentPace, paceTrend,
      tyreLife, compoundName, compoundNum, stintNumber,
      pitStops: Math.max(0, stintNumber - 1),
      predictedPace5, estLapsToPit, positionTrend,
    };
  }

  if (driverAbbrs.length < 3) return null;

  return { driverAbbrs, matrix, driverFeatures, featureNames: FEATURE_NAMES };
}
