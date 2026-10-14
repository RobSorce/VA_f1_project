/**
 * Extract per-driver feature vectors for the Race Situation Map.
 * 10 features per driver at the current replay lap.
 *
 * Causal: every feature comes from the laps each driver has completed at
 * `sessionNow` (session seconds, utils/raceTime.js), and stints from the FastF1
 * Stint column (utils/stints.js), never from the unfinished current lap or
 * from the compound-merged tyre_strategy. Stints follow the shared visibility
 * rule (decision R3): from the pit exit the new set is the current one (its
 * compound and TyreLife), and the stop counts, while the out-lap is still
 * running; `pitStops` = stints - 1 = stints.pitStops count at the same clock
 * (decision R2). A retired driver drops out only once the retirement has
 * happened (utils/driverState.js, decision R6).
 */
import { completedLaps, resolveSessionNow } from './raceTime';
import { stintsByDriver } from './stints';
import { driverStateAt, nonFinisherMap } from './driverState';

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

/** Compound name from COMPOUND_NUM other than UNKNOWN, else null ('nan', null, ...). */
function knownCompound(c) {
  return c && c !== 'UNKNOWN' && COMPOUND_NUM[c] != null ? c : null;
}

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
 * @param {Array} params.lapTimes - sessionData.lap_times (full race; filtered causally here)
 * @param {Array} [params.strategies] - unused: stints are derived from lapTimes
 *   (utils/stints.js); kept so existing call sites keep working
 * @param {Object} params.dnfMap - { abbr: {...} } drivers who did not finish; a driver in it
 *   is left out from the moment the retirement happened (driverStateAt.retired)
 * @param {number} params.currentLap
 * @param {Object|null} params.frameDrivers - current frame's .drivers object; only fills
 *   tyre age / compound when the latest completed lap row lacks them
 * @param {Object|null} params.lstmPredictions - store.lstmPredictions
 * @param {string|null} params.focusDriver
 * @param {number} [params.sessionNow] - session seconds (raceTime.resolveSessionNow);
 *   when omitted, derived in lap mode from currentLap
 * @param {number} [params.sessionTimeOffset] - session seconds of replay time 0
 * @param {boolean} [params.isLiveMode] - live feed rows: retirements from the feed's
 *   dnfMap only (driverState.js nonFinisherMap)
 * @returns {{ driverAbbrs: string[], matrix: number[][], driverFeatures: Object, featureNames: string[] } | null}
 */
export function extractRaceSituationFeatures({
  lapTimes, dnfMap, currentLap,
  frameDrivers, lstmPredictions, focusDriver,
  sessionNow, sessionTimeOffset, isLiveMode = false,
}) {
  if (!lapTimes?.length || currentLap < 3) return null;

  const now = typeof sessionNow === 'number' && !Number.isNaN(sessionNow)
    ? sessionNow
    : resolveSessionNow({ currentLap, lapTimes, sessionTimeOffset });

  // Group the laps completed at `now` by driver
  const driverLaps = {};
  for (const lt of completedLaps(lapTimes, now)) {
    const drv = lt.Driver;
    if (!drv) continue;
    if (!driverLaps[drv]) driverLaps[drv] = [];
    driverLaps[drv].push(lt);
  }

  // Stints visible at `now`, per driver (FastF1 Stint column, utils/stints.js)
  const driverStints = stintsByDriver(lapTimes, { sessionNow: now });

  const driverAbbrs = [];
  const matrix = [];
  const driverFeatures = {};

  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap, { live: isLiveMode });
  for (const [driver, laps] of Object.entries(driverLaps)) {
    // Skip DNF drivers once they have retired at `now` (their final lap row has
    // ended, or they entered the pits for good), not from the leader's lap number
    const state = driverStateAt(lapTimes, driver, now, {
      stints: driverStints, dnf: !!nonFinishers[driver],
    });
    if (state.retired) continue;

    // Sort by lap number
    laps.sort((a, b) => a.LapNumber - b.LapNumber);

    // Latest completed lap
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

    // Stints so far; the last one is the set in force. Between the pit exit
    // and the end of the out-lap it starts after the latest completed lap:
    // the new set is already the current one (R3)
    const driverStintList = driverStints[driver] || [];
    const currentStint = driverStintList[driverStintList.length - 1];
    const onNewSet = !!currentStint && currentStint.StartLap > latest.LapNumber;

    // 5. Tyre life at the end of the latest completed lap; on a set fitted at
    //    a pit exit whose out-lap is still running, the out-lap's TyreLife
    //    (driverStateAt). The current frame (same instant as `now`) fills it
    //    only when the lap row has none.
    const frameDrv = frameDrivers?.[driver];
    const rowLife = onNewSet ? state.tyreLife : latest.TyreLife;
    let tyreLife = Number.isFinite(rowLife) ? rowLife : null;
    if (tyreLife == null && frameDrv?.tyre_life != null) tyreLife = Math.round(frameDrv.tyre_life);
    if (tyreLife == null) tyreLife = 0;

    // 6. Compound of the latest completed lap (of the new set after a pit
    //    exit), else of its stint, else the frame's
    let compoundName = onNewSet
      ? knownCompound(currentStint.Compound)
      : knownCompound(latest.Compound) || knownCompound(currentStint?.Compound);
    if (!compoundName && frameDrv?.tyre != null) compoundName = knownCompound(COMPOUND_NAMES[frameDrv.tyre]);
    if (!compoundName) compoundName = 'UNKNOWN';
    const compoundNum = COMPOUND_NUM[compoundName] || 0;

    // 7. Stint number (FastF1 Stint column, so a same-compound stop counts)
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

    // 10. Position trend (positions gained over the driver's last 5 completed
    //     laps, positive = gaining)
    let positionTrend = 0;
    const fiveLapsAgo = laps.find((lt) => lt.LapNumber === Math.max(1, latest.LapNumber - 5));
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
      pitStops: Math.max(0, stintNumber - 1), // tyre changes so far = stints.pitStops count
      predictedPace5, estLapsToPit, positionTrend,
    };
  }

  if (driverAbbrs.length < 3) return null;

  return { driverAbbrs, matrix, driverFeatures, featureNames: FEATURE_NAMES };
}
