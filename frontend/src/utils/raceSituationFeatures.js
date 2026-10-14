/**
 * Extract per-driver feature vectors for the Race Situation Map.
 * 7 PCA features per driver at the current replay lap (FEATURE_NAMES), plus
 * per-driver state the other views read (driverFeatures: compound, pit stops,
 * estimated laps to the stop, predicted pace).
 *
 * PCA inputs are measured quantities only (P12): the compound is categorical
 * (shown as the tyre dot, not ordinal-coded), and the predicted pace (recent
 * pace + 5 x pace trend) and the laps to the stop (a function of compound and
 * tyre age) are derived from other inputs, so they stay in driverFeatures and
 * out of the matrix. scripts/live_pca_compare.mjs checks that no two inputs
 * are perfectly correlated on any lap of the cached races.
 *
 * Pace: recent pace and pace trend use clean racing laps only (isPaceLap: not
 * lap 1, no pit entry / exit, green, 0 < time < MAX_LAP_TIME_S), as the race
 * engine's base pace (utils/raceSimulation.js PACE_REF_LAPS), once every
 * driver in the field has 2 of them. Until then (the first laps, a safety car
 * from the start) the whole field's pace uses its non-pit laps (isFieldLap),
 * so the drivers stay comparable and none drops out of driverFeatures, the
 * race engine's field (driverFeatures[drv].paceLaps says which); the pace is
 * then left out of the PCA (it would repeat the gap to the leader).
 *
 * Laps to the stop: the race engine's stint-life survival of the compound
 * (raceSimulation.js stintLifeEstimate, Kaplan-Meier of the race's stints at
 * `sessionNow`, the prior's tail past the longest one; stintLifeFor falls back
 * to the prior), the conditional median life given the tyre age reached
 * (conditionalMedianLife) minus that age.
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
import {
  completedLaps, resolveSessionNow, isGreenLap, hasPitIn, hasPitOut,
} from './raceTime';
import { stintsByDriver } from './stints';
import { driverStateAt, nonFinisherMap } from './driverState';
import { MAX_LAP_TIME_S } from './degradation';
import { focusForecast, FORECAST_LAPS } from './forecast';
import {
  stintLifeEstimate, stintLifeFor, conditionalMedianLife, STINT_LIFE_MAX,
} from './raceSimulation';

/** PCA inputs, the columns of `matrix` (measured quantities, P12). */
export const FEATURE_NAMES = [
  'position', 'gap_to_leader', 'recent_pace', 'pace_trend',
  'tyre_life', 'stint_number', 'position_trend',
];

export const FEATURE_LABELS = {
  position: 'Position',
  gap_to_leader: 'Gap to Leader',
  recent_pace: 'Recent Pace',
  pace_trend: 'Pace Trend',
  tyre_life: 'Tyre Age',
  stint_number: 'Stint #',
  position_trend: 'Pos. Change',
};

/**
 * Longest lap that still places a driver in the field (isFieldLap), seconds.
 * Assumption: the inclusion cut this module has always used, kept so the
 * drivers of driverFeatures (the race engine's field) are unchanged; the pace
 * itself uses MAX_LAP_TIME_S (isPaceLap).
 */
const FIELD_MAX_LAP_S = 300;

const COMPOUND_NUM = { SOFT: 1, MEDIUM: 2, HARD: 3, INTERMEDIATE: 4, WET: 5, UNKNOWN: 0 };
// Replay frames code the compound as a number (frameDrivers[drv].tyre)
const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };

/** Compound name from COMPOUND_NUM other than UNKNOWN, else null ('nan', null, ...). */
function knownCompound(c) {
  return c && c !== 'UNKNOWN' && COMPOUND_NUM[c] != null ? c : null;
}

/**
 * Clean racing lap for the pace features: not lap 1 (standing start), no pit
 * entry or exit, green for the whole lap, 0 < LapTimeSeconds < MAX_LAP_TIME_S.
 * The clean-lap rule of utils/degradation.js isCleanLap without its TyreLife
 * requirement (the pace does not use the tyre age).
 *
 * @param {Object} lt - one completed lap_times row
 * @returns {boolean}
 */
export function isPaceLap(lt) {
  return lt.LapNumber > 1 && !hasPitIn(lt) && !hasPitOut(lt) && isGreenLap(lt)
    && lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < MAX_LAP_TIME_S;
}

/**
 * Lap that places a driver in the field (the inclusion rule): no pit entry or
 * exit, 0 < LapTimeSeconds < FIELD_MAX_LAP_S; lap 1 and neutralised laps count.
 *
 * @param {Object} lt - one completed lap_times row
 * @returns {boolean}
 */
export function isFieldLap(lt) {
  return lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < FIELD_MAX_LAP_S && !hasPitIn(lt) && !hasPitOut(lt);
}

/**
 * Laps until the set is due: the conditional median life of the compound's
 * stint-life survival at the tyre age reached, minus that age (0 when the set
 * is older than every life the table allows; past the table, its end).
 *
 * @param {Object} stintLength - stintLifeEstimate result
 * @param {string} compound
 * @param {number} tyreLife
 * @returns {{ laps: number, source: string }} source: 'race' | 'prior'
 */
export function estimatedLapsToPit(stintLength, compound, tyreLife) {
  const life = stintLifeFor({ stintLength }, compound);
  const due = conditionalMedianLife(life.survival, tyreLife);
  let laps;
  if (due == null) laps = 0;
  else if (Number.isFinite(due)) laps = Math.max(0, due - tyreLife);
  else laps = Math.max(0, STINT_LIFE_MAX - tyreLife);
  return { laps, source: life.source };
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
 * @param {Object|null} params.lstmPredictions - store.lstmPredictions ({ [driver]: entry },
 *   utils/forecast.js); the focus driver's entry is used only when its origin lap is the
 *   driver's last completed lap at `now` (a forecast asked earlier is about earlier laps)
 * @param {string|null} params.focusDriver
 * @param {number} [params.sessionNow] - session seconds (raceTime.resolveSessionNow);
 *   when omitted, derived in lap mode from currentLap
 * @param {number} [params.sessionTimeOffset] - session seconds of replay time 0
 * @param {boolean} [params.isLiveMode] - live feed rows: retirements from the feed's
 *   dnfMap only (driverState.js nonFinisherMap)
 * @param {*} [params.running] - deriveStints `running` option for the stint-life
 *   estimate (live mode: the stints still being run are censored, stints.js stintsRunning)
 * @returns {{ driverAbbrs: string[], matrix: number[][], driverFeatures: Object, featureNames: string[],
 *   paceInPca: boolean } | null}
 *   matrix: one row per driver, columns FEATURE_NAMES; the two pace columns are 0 (constant,
 *   out of the fit) while the pace comes from the field's non-pit laps (paceInPca false)
 */
export function extractRaceSituationFeatures({
  lapTimes, dnfMap, currentLap,
  frameDrivers, lstmPredictions, focusDriver,
  sessionNow, sessionTimeOffset, isLiveMode = false, running = false,
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
  // Stint life per compound at `now` (the race engine's survival estimate)
  const stintLength = stintLifeEstimate(lapTimes, { sessionNow: now, running, dnfMap });

  const driverAbbrs = [];
  const matrix = [];
  const driverFeatures = {};

  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap, { live: isLiveMode });
  const field = [];
  for (const [driver, laps] of Object.entries(driverLaps)) {
    // Skip DNF drivers once they have retired at `now` (their final lap row has
    // ended, or they entered the pits for good), not from the leader's lap number
    const state = driverStateAt(lapTimes, driver, now, {
      stints: driverStints, dnf: !!nonFinishers[driver],
    });
    if (state.retired) continue;

    // Sort by lap number
    laps.sort((a, b) => a.LapNumber - b.LapNumber);
    if (!laps.length) continue;

    // In the field with 2 non-pit laps; clean racing laps for the pace
    const fieldLaps = laps.filter(isFieldLap);
    if (fieldLaps.length < 2) continue;
    field.push({ driver, laps, state, fieldLaps, cleanLaps: laps.filter(isPaceLap) });
  }
  // Clean laps once every driver has 2 of them, else the field's non-pit laps
  const paceFrom = field.every((d) => d.cleanLaps.length >= 2) ? 'clean' : 'field';

  for (const { driver, laps, state, fieldLaps, cleanLaps } of field) {
    // Latest completed lap
    const latest = laps[laps.length - 1];
    const paceLaps = paceFrom === 'clean' ? cleanLaps : fieldLaps;

    // 1. Position
    const position = latest.Position || 20;

    // 2. Gap to leader
    const gapToLeader = latest.GapToLeader || 0;

    // 3. Recent pace (avg last 3 pace laps)
    const last3 = paceLaps.slice(-3);
    const recentPace = last3.reduce((s, lt) => s + lt.LapTimeSeconds, 0) / last3.length;

    // 4. Pace trend (slope of last 5 pace laps)
    const last5 = paceLaps.slice(-5);
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

    // Compound of the latest completed lap (of the new set after a pit
    // exit), else of its stint, else the frame's (not a PCA input)
    let compoundName = onNewSet
      ? knownCompound(currentStint.Compound)
      : knownCompound(latest.Compound) || knownCompound(currentStint?.Compound);
    if (!compoundName && frameDrv?.tyre != null) compoundName = knownCompound(COMPOUND_NAMES[frameDrv.tyre]);
    if (!compoundName) compoundName = 'UNKNOWN';

    // 6. Stint number (FastF1 Stint column, so a same-compound stop counts)
    const stintNumber = driverStintList.length || 1;

    // Predicted pace +5 laps (not a PCA input: recent pace + 5 x pace trend):
    // the focus driver's served forecast (utils/forecast.js) when it was made
    // at this driver's last completed lap and has its 5 laps, otherwise
    // linear extrapolation: recentPace + paceTrend * 5
    const forecast = focusDriver === driver ? focusForecast(lstmPredictions, driver) : null;
    const forecastNow = forecast && forecast.lap === laps[laps.length - 1].LapNumber
      && Array.isArray(forecast.predicted_times) && forecast.predicted_times.length >= FORECAST_LAPS
      && Number.isFinite(forecast.predicted_times[FORECAST_LAPS - 1]);
    let predictedPace5;
    if (forecastNow) {
      predictedPace5 = forecast.predicted_times[FORECAST_LAPS - 1];
    } else {
      predictedPace5 = recentPace + paceTrend * 5;
    }
    // Clamp to reasonable range
    predictedPace5 = Math.max(60, Math.min(200, predictedPace5));

    // Estimated laps to the stop (not a PCA input: compound + tyre age), from
    // the race's stint-life survival
    const pitEstimate = estimatedLapsToPit(stintLength, compoundName, tyreLife);
    const estLapsToPit = pitEstimate.laps;

    // 7. Position trend (positions gained over the driver's last 5 completed
    //     laps, positive = gaining)
    let positionTrend = 0;
    const fiveLapsAgo = laps.find((lt) => lt.LapNumber === Math.max(1, latest.LapNumber - 5));
    if (fiveLapsAgo?.Position && latest.Position) {
      positionTrend = fiveLapsAgo.Position - latest.Position; // positive = gained positions
    }

    // Columns of FEATURE_NAMES. On the field's non-pit laps the pace is the
    // mean of every lap so far, i.e. the gap to the leader again: the pace
    // columns are then held constant (left out of the fit, loadings 0)
    const paceInPca = paceFrom === 'clean';
    const featureVector = [
      position, gapToLeader, paceInPca ? recentPace : 0, paceInPca ? paceTrend : 0,
      tyreLife, stintNumber, positionTrend,
    ];

    // Guard against NaN/Infinity
    const clean = featureVector.map((v) =>
      (Number.isFinite(v) ? v : 0)
    );

    driverAbbrs.push(driver);
    matrix.push(clean);
    driverFeatures[driver] = {
      position, gapToLeader, recentPace, paceTrend,
      tyreLife, compoundName, stintNumber,
      pitStops: Math.max(0, stintNumber - 1), // tyre changes so far = stints.pitStops count
      predictedPace5, estLapsToPit, estLapsToPitSource: pitEstimate.source, positionTrend,
      paceLaps: paceFrom, // 'clean' (isPaceLap) or 'field' (isFieldLap, the first laps)
    };
  }

  if (driverAbbrs.length < 3) return null;

  return {
    driverAbbrs, matrix, driverFeatures, featureNames: FEATURE_NAMES, paceInPca: paceFrom === 'clean',
  };
}
