/**
 * View model of the pit wall sector panel (components/ui/PitWallSectorPanel.jsx):
 * the focus driver's sectors, bests and lap in progress at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { isLapCompleted, lapStartTime } from '../raceTime';
import { driverStateAt, nonFinisherMap } from '../driverState';

/**
 * The focus driver's sector panel at sessionNow (session seconds), causal
 * (decision R6, utils/driverState.js): personal and session bests and the
 * previous laps from completed laps only; with replay frames the lap in
 * progress shows only the sectors already run and a chrono, never its lap
 * time; the tyre is the set in force (the new set from the pit exit).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {string} driver
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @param {Object} [opts] - { replayActive, dnfMap }
 * @returns {Object|null}
 */
export function pitWallSectorData(lapTimes, driver, sessionNow, { replayActive = false, dnfMap = {} } = {}) {
  if (!driver || !Array.isArray(lapTimes) || !lapTimes.length) return null;
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const driverLaps = lapTimes
    .filter((lt) => lt.Driver === driver)
    .sort((a, b) => a.LapNumber - b.LapNumber);
  if (driverLaps.length === 0) return null;
  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap);
  const st = driverStateAt(driverLaps, driver, now, { dnf: !!nonFinishers[driver] });

  // Laps completed at sessionNow: the unfinished current lap is not history yet
  const doneLaps = driverLaps.filter((lt) => isLapCompleted(lt, now));

  // Compute personal bests
  let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity, bestLap = Infinity;
  for (const lt of doneLaps) {
    const s1 = lt.Sector1TimeSeconds;
    const s2 = lt.Sector2TimeSeconds;
    const s3 = lt.Sector3TimeSeconds;
    const lap = lt.LapTimeSeconds;
    if (s1 > 0 && isFinite(s1) && s1 < bestS1) bestS1 = s1;
    if (s2 > 0 && isFinite(s2) && s2 < bestS2) bestS2 = s2;
    if (s3 > 0 && isFinite(s3) && s3 < bestS3) bestS3 = s3;
    if (lap > 0 && isFinite(lap) && lap < 300 && lap < bestLap) bestLap = lap;
  }
  if (!isFinite(bestS1)) bestS1 = null;
  if (!isFinite(bestS2)) bestS2 = null;
  if (!isFinite(bestS3)) bestS3 = null;
  if (!isFinite(bestLap)) bestLap = null;

  // Compute session bests (all drivers, completed laps)
  let sessBestS1 = Infinity, sessBestS2 = Infinity, sessBestS3 = Infinity, sessBestLap = Infinity;
  for (const lt of lapTimes) {
    if (!isLapCompleted(lt, now)) continue;
    const s1 = lt.Sector1TimeSeconds;
    const s2 = lt.Sector2TimeSeconds;
    const s3 = lt.Sector3TimeSeconds;
    const lap = lt.LapTimeSeconds;
    if (s1 > 0 && isFinite(s1) && s1 < sessBestS1) sessBestS1 = s1;
    if (s2 > 0 && isFinite(s2) && s2 < sessBestS2) sessBestS2 = s2;
    if (s3 > 0 && isFinite(s3) && s3 < sessBestS3) sessBestS3 = s3;
    if (lap > 0 && isFinite(lap) && lap < 300 && lap < sessBestLap) sessBestLap = lap;
  }
  if (!isFinite(sessBestS1)) sessBestS1 = null;
  if (!isFinite(sessBestS2)) sessBestS2 = null;
  if (!isFinite(sessBestS3)) sessBestS3 = null;
  if (!isFinite(sessBestLap)) sessBestLap = null;

  // Latest completed lap
  const completedLaps = doneLaps.filter((lt) => lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300);
  const latest = completedLaps.length > 0 ? completedLaps[completedLaps.length - 1] : null;

  // Previous 3 laps
  const prevLaps = completedLaps.slice(-4, -1).reverse();

  // In-progress lap (replay only): its sectors as they are run, a chrono
  const inProgressLt = replayActive && !st.retired ? st.inProgress : null;
  let liveLapChrono = null;
  let liveS1 = null, liveS2 = null, liveS3 = null;
  let activeSector = null; // 1|2|3
  const start = inProgressLt ? lapStartTime(inProgressLt) : null;
  if (inProgressLt && start != null) {
    liveLapChrono = Math.max(0, now - start);
    liveS1 = st.visibleSectors.s1;
    liveS2 = st.visibleSectors.s2;
    liveS3 = st.visibleSectors.s3;
    if (liveS1 == null) activeSector = 1;
    else if (liveS2 == null) activeSector = 2;
    else if (liveS3 == null) activeSector = 3;
  }

  return {
    latest,
    prevLaps,
    bestS1, bestS2, bestS3, bestLap,
    sessBestS1, sessBestS2, sessBestS3, sessBestLap,
    lapNumber: inProgressLt?.LapNumber || latest?.LapNumber || st.inProgress?.LapNumber || 1,
    inProgress: inProgressLt != null && start != null,
    liveLapChrono,
    liveS1, liveS2, liveS3,
    activeSector,
    compound: st.compound,
  };
}
