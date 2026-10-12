import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useF1Store } from '../store/useF1Store';
import { pitStops } from '../utils/stints';
import {
  isLapCompleted, lapWindows, leaderLapAt, mapTrackStatusToLaps,
} from '../utils/raceTime';
import { causalKey } from '../utils/strategyViews';

// ── Status code mapping ──────────────────────────────────────────
const STATUS_MAP = {
  '1': { type: 'GREEN_FLAG', color: '#00ff00', label: 'Green Flag' },
  '2': { type: 'YELLOW_FLAG', color: '#ffcc00', label: 'Yellow Flag' },
  '4': { type: 'SAFETY_CAR', color: '#ffcc00', label: 'Safety Car' },
  '5': { type: 'RED_FLAG', color: '#ff0000', label: 'Red Flag' },
  '6': { type: 'VSC', color: '#ff8c00', label: 'Virtual Safety Car' },
  '7': { type: 'VSC', color: '#ff8c00', label: 'Virtual Safety Car' },
};

function finite(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function normaliseNow(sessionNow) {
  return sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
}

/** m:ss.sss (or ss.sss s under a minute) of a lap time in seconds. */
function formatLapTime(sec) {
  const mins = Math.floor(sec / 60);
  const secs = (sec % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : `${secs}s`;
}

/**
 * Timeline events (lap span + time fractions) for the non-green track status
 * periods, on the race LEADER's lap: the lap mapping is
 * utils/raceTime.js mapTrackStatusToLaps, the same rule as the backend's
 * map_track_status_to_laps (an event at session time t belongs to the lap the
 * leader is on at t; periods that ended by the race start or began after the
 * last lap are dropped). It needs only the lap table, so it works without
 * replay frames (lap mode, frames loading or unavailable).
 *
 * Causal: only periods that have started at sessionNow (start_time <=
 * sessionNow, session seconds) are listed; a period still running at
 * sessionNow ends, for now, on the leader's lap at sessionNow (ongoing: true).
 *
 * Live mode: live lap rows carry no lap windows and live times are
 * wall-clock, so periods are placed with the start_lap / end_lap the store
 * stamps on each live change (store/useF1Store.js 'track_status'); a running
 * period ends on maxLap. Unstamped periods (snapshot history) are skipped.
 *
 * startTimeFraction / endTimeFraction are positions on the REPLAY clock: with
 * frames (t - sessionTimeOffset) / last frame.t (a marker click seeks to that
 * frame), otherwise the fraction of the race span [first lap start, last lap
 * end]; null in live mode. They are not lap positions: the timeline draws the
 * bands on its lap axis from startLap / endLap (trackStatusBandLaps).
 *
 * @param {Object} p
 * @param {Array} p.trackStatus - [{status, start_time, end_time, message}] (session seconds)
 * @param {Array} [p.lapTimes] - sessionData.lap_times (lap windows for the mapping)
 * @param {Array} [p.frames] - frameData.frames ({t}), only for the time fractions
 * @param {number} p.maxLap
 * @param {number} [p.sessionTimeOffset=0] - session seconds at replay time 0
 * @param {number} [p.sessionNow=Infinity] - session seconds (store getSessionNow)
 * @returns {Array<Object>} events: {type, lap, startLap, endLap, startTime, endTime,
 *   startTimeFraction, endTimeFraction, ongoing, description, color}
 */
export function buildTrackStatusEvents({
  trackStatus, lapTimes, frames, maxLap, sessionTimeOffset = 0, sessionNow = Infinity,
}) {
  const events = [];
  if (!trackStatus?.length) return events;
  const now = normaliseNow(sessionNow);
  const windows = lapWindows(lapTimes);
  const lastLap = Number.isFinite(maxLap) && maxLap >= 1 ? maxLap : Infinity;
  const clampLap = (lap) => Math.max(1, Math.min(lastLap, lap));

  let periods;
  if (windows.length) {
    periods = mapTrackStatusToLaps(trackStatus, lapTimes);
  } else {
    periods = [];
    for (const p of trackStatus) {
      const startLap = finite(p?.start_lap);
      if (startLap == null) continue;
      const endLap = finite(p.end_lap) ?? (Number.isFinite(lastLap) ? lastLap : startLap);
      periods.push({ ...p, start_lap: startLap, end_lap: Math.max(startLap, endLap) });
    }
  }

  // Replay-clock fractions (marker click -> frame seek)
  let fraction = () => null;
  const offset = Number.isFinite(sessionTimeOffset) ? sessionTimeOffset : 0;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  if (frames?.length > 1 && frames[frames.length - 1].t > 0) {
    const total = frames[frames.length - 1].t;
    fraction = (t) => (t != null && Number.isFinite(t) ? clamp01((t - offset) / total) : null);
  } else if (windows.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, start, end] of windows) {
      if (start < lo) lo = start;
      if (end > hi) hi = end;
    }
    if (hi > lo) fraction = (t) => (t != null && Number.isFinite(t) ? clamp01((t - lo) / (hi - lo)) : null);
  }

  // The leader's lap at now: the provisional end lap of a running period
  const nowLap = windows.length && now !== Infinity ? leaderLapAt(windows, now) : null;

  for (const period of periods) {
    const statusCode = String(period.status);
    if (statusCode === '1') continue;
    const mapping = STATUS_MAP[statusCode];
    if (!mapping) continue;

    const start = finite(period.start_time);
    const end = finite(period.end_time);
    if (windows.length && start != null && start > now) continue; // not happened yet
    const ongoing = windows.length > 0 && now !== Infinity && (end == null || end > now);

    const startLap = clampLap(period.start_lap);
    let endLap = Math.max(startLap, clampLap(period.end_lap));
    if (ongoing && nowLap != null) endLap = Math.max(startLap, Math.min(endLap, clampLap(nowLap)));
    const shownEnd = ongoing ? now : end;

    events.push({
      type: mapping.type,
      lap: startLap,
      startLap,
      endLap,
      startTime: start,
      endTime: shownEnd,
      startTimeFraction: fraction(start),
      endTimeFraction: fraction(shownEnd ?? start),
      ongoing,
      description: period.message || mapping.label,
      color: mapping.color,
    });
  }
  return events;
}

/**
 * Lap span [from, to] of a track-status band on the timeline's LAP axis
 * (domain [1, maxLap], lap n at the moment the leader starts it): from the
 * period's start lap to its end lap, both on the leader's lap
 * (buildTrackStatusEvents, as FIA race control: 2024 R5 VSC lap 22). A
 * finished period is at least half a lap wide so a one-lap period stays
 * visible; a running one ends on the leader's lap at now, where the progress
 * fill ends. `to` never passes maxLap. Never a replay-time fraction: that is
 * a different axis (a red flag lasting a fifth of the replay but mapped to
 * one lap is drawn on that lap).
 *
 * @param {Object} evt - buildTrackStatusEvents event ({startLap, endLap, ongoing})
 * @param {number} [maxLap=Infinity]
 * @returns {[number, number]} lap positions, from <= to
 */
export function trackStatusBandLaps(evt, maxLap = Infinity) {
  const from = Number(evt?.startLap) || 1;
  const end = Number(evt?.endLap) || from;
  const to = evt?.ongoing ? Math.max(from, end) : Math.max(end, from + 0.5);
  const last = Number.isFinite(maxLap) ? maxLap : Infinity;
  return [Math.min(from, last), Math.min(to, last)];
}

/**
 * The fastest lap COMPLETED at sessionNow (lap 1 excluded, as before), as a
 * FASTEST_LAP timeline event; null when no lap qualifies. At sessionNow =
 * Infinity it is the race's fastest lap; earlier it is the fastest so far and
 * says so, never a lap that has not been run yet.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {Object|null}
 */
export function fastestLapEvent(lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  let best = Infinity;
  let entry = null;
  for (const lt of lapTimes || []) {
    if (!(Number(lt?.LapNumber) > 1)) continue;
    const time = Number(lt.LapTime || lt.lap_time || lt.LapTimeSeconds);
    if (!(time > 0) || time >= best) continue;
    if (!isLapCompleted(lt, now)) continue;
    best = time;
    entry = lt;
  }
  if (!entry) return null;
  const label = now === Infinity ? 'Fastest lap' : 'Fastest lap so far';
  return {
    type: 'FASTEST_LAP',
    lap: entry.LapNumber,
    startLap: entry.LapNumber,
    endLap: entry.LapNumber,
    description: `${label}: ${entry.Driver || 'Unknown'} (${formatLapTime(best)})`,
    color: '#a855f7',
    driver: entry.Driver,
  };
}

/**
 * POSITION_CHANGE events (3+ places between consecutive laps, per driver),
 * only between laps both completed at sessionNow: a row's Position is
 * measured at the end of that lap.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {Array<Object>}
 */
export function positionChangeEvents(lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const byDriver = {};
  for (const lt of lapTimes || []) {
    const d = lt?.Driver;
    if (!d) continue;
    if (!byDriver[d]) byDriver[d] = [];
    byDriver[d].push(lt);
  }
  const events = [];
  const seen = new Set();
  for (const driver of Object.keys(byDriver)) {
    const laps = [...byDriver[driver]].sort((a, b) => a.LapNumber - b.LapNumber);
    for (let i = 1; i < laps.length; i++) {
      if (!isLapCompleted(laps[i], now)) break;
      const prev = laps[i - 1].Position;
      const curr = laps[i].Position;
      if (prev == null || curr == null) continue;
      const change = prev - curr;
      if (Math.abs(change) < 3) continue;
      const lap = laps[i].LapNumber;
      const key = `${driver}_${lap}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        type: 'POSITION_CHANGE',
        lap,
        startLap: lap,
        endLap: lap,
        description: `${driver} ${change > 0 ? 'gained' : 'lost'} ${Math.abs(change)} positions on lap ${lap}`,
        color: change > 0 ? '#22c55e' : '#ef4444',
        driver,
      });
    }
  }
  return events;
}

/**
 * Custom hook that manages frame-based race replay playback.
 * Advances frame-by-frame through the loaded telemetry data,
 * giving smooth real-time driver movement on the track map.
 *
 * The store's currentLap is derived from frame data automatically.
 */
export function useReplayEngine() {
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const isPlaying = useF1Store((s) => s.isPlaying);
  const playSpeed = useF1Store((s) => s.playSpeed);
  const setIsPlaying = useF1Store((s) => s.setIsPlaying);
  const setPlaySpeed = useF1Store((s) => s.setPlaySpeed);
  const trackStatus = useF1Store((s) => s.trackStatus);
  const sessionData = useF1Store((s) => s.sessionData);
  const frameData = useF1Store((s) => s.frameData);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const frameDt = useF1Store((s) => s.frameDt);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);

  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);

  const rafRef = useRef(null);

  // ── Compute race events from trackStatus + lap data ──────────────
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);

  // Every timeline event is causal at the store's sessionNow: pit stops from
  // their pit exit, track-status periods from their start, fastest lap and
  // position changes from completed laps. The key changes only when a lap
  // completes, a pit entry / exit or a status change is reached, or the
  // leader's lap changes (a running period grows), not on every replay tick.
  const eventsKey = useF1Store((s) => `${causalKey(s.sessionData?.lap_times, s.getSessionNow(), s.trackStatus)}|${s.currentLap}`);

  const raceEvents = useMemo(() => {
    const events = [];

    // No race events for qualifying replay
    if (isQualifyingReplay) return events;

    if (!trackStatus?.length && !sessionData) return events;
    const sessionNow = useF1Store.getState().getSessionNow();
    const lapTimes = sessionData?.lap_times || [];

    events.push({
      type: 'GREEN_FLAG',
      lap: 1,
      startLap: 1,
      endLap: 1,
      startTimeFraction: 0,
      endTimeFraction: 0,
      description: 'Race start',
      color: '#00ff00',
    });

    // Track status periods on the leader's lap (live mode: no offset, the
    // feed's track status is not on the session clock)
    events.push(...buildTrackStatusEvents({
      trackStatus,
      lapTimes,
      frames: frameData?.frames,
      maxLap,
      sessionTimeOffset: isLiveMode ? 0 : sessionTimeOffset,
      sessionNow,
    }));

    // ── Layer 2: Pit windows (aggregated with count + driver list) ──
    // Also generates per-driver pit events (Layer 3, filtered in TimelinePlayer).
    // Stops = tyre changes (utils/stints.js pitStops, R2), listed from their
    // pit exit, with the new compound fitted there.
    const visibleStops = pitStops(lapTimes, { sessionNow });
    if (visibleStops.length) {
      // Collect all pit stops: { lap → [{driver, compound}] }
      const pitsByLap = {};
      for (const stop of visibleStops) {
        const drv = stop.Driver;
        // The lap the new stint starts (the out-lap)
        const pitLap = stop.outLap ?? stop.inLap + 1;
        const compound = stop.toCompound || 'UNKNOWN';
        if (pitLap && pitLap > 0 && pitLap <= maxLap) {
          if (!pitsByLap[pitLap]) pitsByLap[pitLap] = [];
          pitsByLap[pitLap].push({ driver: drv, compound });
          // Layer 3: per-driver pit event (shown only when driver is selected)
          events.push({
            type: 'DRIVER_PIT',
            lap: pitLap,
            startLap: pitLap,
            endLap: pitLap,
            driver: drv,
            compound,
            description: `${drv} pit stop → ${compound} (lap ${pitLap})`,
            color: '#00bfff',
          });
        }
      }
      // Layer 2: aggregated pit window per lap
      for (const [lap, pits] of Object.entries(pitsByLap)) {
        const lapNum = Number(lap);
        const driverNames = pits.map((p) => p.driver).join(', ');
        events.push({
          type: 'PIT_WINDOW',
          lap: lapNum,
          startLap: lapNum,
          endLap: lapNum,
          count: pits.length,
          drivers: pits.map((p) => p.driver),
          description: `Lap ${lapNum}: ${pits.length} pit stop${pits.length > 1 ? 's' : ''} (${driverNames})`,
          color: '#00bfff',
        });
      }
    }

    // ── Layer 2: Fastest lap among the laps completed so far ─────
    const fastest = fastestLapEvent(lapTimes, sessionNow);
    if (fastest) events.push(fastest);

    // ── Layer 3: Position changes (3+ positions, per driver) ─────
    // Shown only for selected drivers in TimelinePlayer
    events.push(...positionChangeEvents(lapTimes, sessionNow));

    if (maxLap > 1) {
      events.push({
        type: 'CHEQUERED_FLAG',
        lap: maxLap,
        startLap: maxLap,
        endLap: maxLap,
        description: 'Race finish',
        color: '#ffffff',
      });
    }

    events.sort((a, b) => a.startLap - b.startLap);
    return events;
    // eventsKey stands for sessionNow (read from the store above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackStatus, sessionData, frameData, maxLap, isQualifyingReplay,
      isLiveMode, sessionTimeOffset, eventsKey]);

  // ── Playback loop: RAF + wall-clock driven ─────────────────────
  // setInterval at 400ms felt sticky: chronos only updated 2.5× per second.
  // Using requestAnimationFrame, we advance currentTime smoothly (~60Hz) and
  // bump currentFrameIndex only when the target session time crosses a frame
  // boundary. Wall-clock math self-corrects if the JS thread stalls.
  useEffect(() => {
    if (isLiveMode) return; // In live mode, frames arrive via WebSocket
    if (!isPlaying || totalFrames <= 1) return;

    const initialFrames = useF1Store.getState().frameData?.frames;
    if (!initialFrames?.length) return;

    let wallStart = performance.now();
    const startState = useF1Store.getState();
    let lastIdx = startState.currentFrameIndex;
    // Resume where the clock is: after a pause currentTime may sit between
    // this frame and the next (smooth interpolation), and the replay clock
    // must not step back to the frame's t when playback restarts
    const frameT = initialFrames[lastIdx]?.t ?? 0;
    const nextT = initialFrames[lastIdx + 1]?.t ?? Infinity;
    let sessionStart = Number.isFinite(startState.currentTime)
      && startState.currentTime > frameT && startState.currentTime < nextT
      ? startState.currentTime : frameT;

    const loop = (now) => {
      const state = useF1Store.getState();
      // Paused or a new session loaded since the last tick (loadSession,
      // resetSession and setQualiSegment stop playback): never write the old
      // replay time into the new clock
      if (!state.isPlaying) return;
      // Re-read frames each tick so a session swap mid-playback doesn't
      // leave us indexing into a stale array.
      const frames = state.frameData?.frames;
      if (!frames?.length) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // Detect external seek — rebase the wall-clock baseline.
      if (state.currentFrameIndex !== lastIdx) {
        wallStart = now;
        lastIdx = state.currentFrameIndex;
        sessionStart = frames[lastIdx]?.t ?? 0;
      }

      const elapsedWall = (now - wallStart) / 1000;
      const targetT = sessionStart + elapsedWall * playSpeed;

      // Advance frame index to the last frame whose t ≤ targetT.
      let idx = lastIdx;
      while (idx < frames.length - 1 && frames[idx + 1].t <= targetT) idx++;

      if (idx >= frames.length - 1) {
        state.setCurrentFrameIndex(frames.length - 1);
        state.setIsPlaying(false);
        return;
      }

      if (idx !== lastIdx) {
        state.setCurrentFrameIndex(idx);
        lastIdx = idx;
      }

      // Smoothly interpolate currentTime for chronos between frame boundaries.
      state.setCurrentTime(targetT);

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isLiveMode, isPlaying, playSpeed, totalFrames]);

  // ── Transport controls ──────────────────────────────────────────
  const play = useCallback(() => {
    const state = useF1Store.getState();
    if (state.currentFrameIndex >= state.totalFrames - 1) {
      state.setCurrentFrameIndex(0);
    }
    state.setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, [setIsPlaying]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, pause, play]);

  // Seek to a specific lap — maps through lapFrameMap or sets lap directly
  const seekToLap = useCallback(
    (lap) => {
      const clampedLap = Math.max(1, Math.min(maxLap, Math.round(lap)));
      const state = useF1Store.getState();
      const { lapFrameMap: lfm } = state;

      if (lfm && lfm[clampedLap] != null) {
        state.setCurrentFrameIndex(lfm[clampedLap]);
      } else if (lfm && Object.keys(lfm).length > 0) {
        const available = Object.keys(lfm).map(Number).sort((a, b) => a - b);
        const closest = available.reduce((prev, curr) =>
          Math.abs(curr - clampedLap) < Math.abs(prev - clampedLap) ? curr : prev,
          available[0]
        );
        state.setCurrentFrameIndex(lfm[closest]);
      } else {
        // No frames — set lap directly
        state.setCurrentLap(clampedLap);
      }
    },
    [maxLap]
  );

  // Seek to a specific frame index
  const seekToFrame = useCallback(
    (frameIdx) => {
      const state = useF1Store.getState();
      const clamped = Math.max(0, Math.min(state.totalFrames - 1, Math.round(frameIdx)));
      state.setCurrentFrameIndex(clamped);
    },
    []
  );

  const skipToStart = useCallback(() => {
    setIsPlaying(false);
    const state = useF1Store.getState();
    if (state.totalFrames > 0) state.setCurrentFrameIndex(0);
    else state.setCurrentLap(1); // lap mode: the race start
  }, [setIsPlaying]);

  // The end of the race: the replay's last frame, or in lap mode the
  // race-over state (store showRaceOver), after the leader's last lap
  const skipToEnd = useCallback(() => {
    setIsPlaying(false);
    useF1Store.getState().showRaceOver();
  }, [setIsPlaying]);

  return {
    // State
    currentLap,
    maxLap,
    isPlaying,
    playSpeed,
    raceEvents,
    currentFrameIndex,
    totalFrames,
    frameDt,
    isLiveMode,
    // Controls
    play,
    pause,
    togglePlayPause,
    seekToLap,
    seekToFrame,
    skipToStart,
    skipToEnd,
    setPlaySpeed,
  };
}
