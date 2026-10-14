import { useMemo } from 'react';
import { useF1Store } from '../store/useF1Store';
import { resolveSessionNow, activeSegmentWindow } from '../utils/raceTime';
import { stintsRunning } from '../utils/stints';

/**
 * The dashboard's "now" in SESSION seconds (Infinity = no time limit), from
 * the store: replay time + sessionTimeOffset while replay frames are loaded,
 * the race leader's lap start in lap-indexed mode (Infinity in its race-over
 * state, store.lapModeRaceOver), Infinity in live mode.
 * See utils/raceTime.js resolveSessionNow for the rules. Feed the result to
 * completedLaps / deriveStints / estimatePitLoss so views stay causal.
 *
 * Same inputs as the store's getSessionNow (sessionNowOf in
 * store/useF1Store.js): during a qualifying replay sessionTimeOffset is the
 * active segment's origin, and the segment's last frame is not the end of the
 * session: it stands for the segment's end (qualiSegmentWindows), not Infinity.
 *
 * @returns {number} session seconds, or Infinity
 */
export function useSessionNow() {
  const currentTime = useF1Store((s) => s.currentTime);
  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);
  const replayActive = useF1Store((s) => s.totalFrames > 0);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const lapTimes = useF1Store((s) => s.sessionData?.lap_times);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const maxTime = useF1Store((s) => s.maxTime);
  const frameDt = useF1Store((s) => s.frameDt);
  const raceOver = useF1Store((s) => !!s.lapModeRaceOver);
  const qualifying = useF1Store((s) => !!s.isQualifyingReplay);
  const segmentEnd = useF1Store((s) => activeSegmentWindow(s)?.end);

  return useMemo(
    () => resolveSessionNow({
      currentTime, sessionTimeOffset, replayActive, currentLap, maxLap, lapTimes, isLiveMode,
      maxTime, frameDt, raceOver, qualifying, segmentEnd,
    }),
    [currentTime, sessionTimeOffset, replayActive, currentLap, maxLap, lapTimes, isLiveMode,
      maxTime, frameDt, raceOver, qualifying, segmentEnd],
  );
}

/**
 * The `running` option of deriveStints / stintsByDriver / completedStints /
 * extractRaceParams for the store state (utils/stints.js stintsRunning): in
 * live mode, before the chequered flag, a per-driver test that keeps the last
 * stint of every driver still racing ongoing (the live "now" is Infinity, yet
 * the race goes on after the rows); false otherwise. Memoised, so it can sit
 * in a useMemo dependency list.
 *
 * @returns {false|function(string): boolean}
 */
export function useStintsRunning() {
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const lapTimes = useF1Store((s) => s.sessionData?.lap_times);
  const dnfMap = useF1Store((s) => s.dnfMap);
  return useMemo(
    () => stintsRunning({ isLiveMode, totalRaceLaps, lapTimes, dnfMap }),
    [isLiveMode, totalRaceLaps, lapTimes, dnfMap],
  );
}

export default useSessionNow;
