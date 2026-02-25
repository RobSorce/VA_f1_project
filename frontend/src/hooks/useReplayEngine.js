import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useF1Store } from '../store/useF1Store';

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
  const lapFrameMap = useF1Store((s) => s.lapFrameMap);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const frameDt = useF1Store((s) => s.frameDt);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);

  const intervalRef = useRef(null);

  // ── Status code mapping ──────────────────────────────────────────
  const STATUS_MAP = {
    '1': { type: 'GREEN_FLAG', color: '#00ff00', label: 'Green Flag' },
    '2': { type: 'YELLOW_FLAG', color: '#ffcc00', label: 'Yellow Flag' },
    '4': { type: 'SAFETY_CAR', color: '#ffcc00', label: 'Safety Car' },
    '5': { type: 'RED_FLAG', color: '#ff0000', label: 'Red Flag' },
    '6': { type: 'VSC', color: '#ff8c00', label: 'Virtual Safety Car' },
    '7': { type: 'VSC', color: '#ff8c00', label: 'Virtual Safety Car' },
  };

  // ── Compute race events from trackStatus + strategy data ─────────
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);

  const raceEvents = useMemo(() => {
    const events = [];

    // No race events for qualifying replay
    if (isQualifyingReplay) return events;

    if (!trackStatus?.length && !sessionData) return events;

    let avgLapTimeSec = 90;
    if (frameData?.frames?.length && lapFrameMap && maxLap > 1) {
      const firstFrame = frameData.frames[0];
      const lastFrame = frameData.frames[frameData.frames.length - 1];
      if (firstFrame?.t != null && lastFrame?.t != null && lastFrame.t > firstFrame.t) {
        avgLapTimeSec = (lastFrame.t - firstFrame.t) / maxLap;
      }
    }

    events.push({
      type: 'GREEN_FLAG',
      lap: 1,
      startLap: 1,
      endLap: 1,
      description: 'Race start',
      color: '#00ff00',
    });

    if (trackStatus?.length) {
      for (const period of trackStatus) {
        const statusCode = String(period.status);
        if (statusCode === '1') continue;
        const mapping = STATUS_MAP[statusCode];
        if (!mapping) continue;

        const startLap = avgLapTimeSec > 0
          ? Math.max(1, Math.min(maxLap, Math.round(period.start_time / avgLapTimeSec)))
          : 1;
        const endLap = period.end_time != null && avgLapTimeSec > 0
          ? Math.max(startLap, Math.min(maxLap, Math.round(period.end_time / avgLapTimeSec)))
          : startLap;

        events.push({
          type: mapping.type,
          lap: startLap,
          startLap,
          endLap,
          description: period.message || mapping.label,
          color: mapping.color,
        });
      }
    }

    if (sessionData?.strategies?.length) {
      for (const driverStrategy of sessionData.strategies) {
        const stints = driverStrategy.stints || driverStrategy.Stints || [];
        if (!Array.isArray(stints)) continue;
        for (let i = 1; i < stints.length; i++) {
          const stint = stints[i];
          const pitLap = stint.LapStart || stint.lap_start || stint.StartLap;
          if (pitLap && pitLap > 0 && pitLap <= maxLap) {
            const existing = events.find(
              (e) => e.type === 'PIT_WINDOW' && e.lap === pitLap
            );
            if (!existing) {
              events.push({
                type: 'PIT_WINDOW',
                lap: pitLap,
                startLap: pitLap,
                endLap: pitLap,
                description: `Pit stops on lap ${pitLap}`,
                color: '#00bfff',
              });
            }
          }
        }
      }
    }

    // ── Fastest lap events ────────────────────────────────────────
    if (sessionData?.lap_times?.length) {
      const lapTimes = sessionData.lap_times;
      let sessionBest = Infinity;
      for (const lt of lapTimes) {
        const time = lt.LapTime || lt.lap_time;
        if (time && time > 0 && lt.LapNumber > 1) {
          if (time < sessionBest) {
            sessionBest = time;
            events.push({
              type: 'FASTEST_LAP',
              lap: lt.LapNumber,
              startLap: lt.LapNumber,
              endLap: lt.LapNumber,
              description: `Fastest lap: ${lt.Driver || 'Unknown'} (${time.toFixed(3)}s)`,
              color: '#a855f7',
              driver: lt.Driver,
            });
          }
        }
      }
    }

    // ── Position change events (3+ positions in one lap) ────────
    if (sessionData?.lap_times?.length) {
      const lapTimes = sessionData.lap_times;
      // Group by driver, sort by lap
      const byDriver = {};
      for (const lt of lapTimes) {
        const d = lt.Driver;
        if (!d) continue;
        if (!byDriver[d]) byDriver[d] = [];
        byDriver[d].push(lt);
      }
      for (const driver of Object.keys(byDriver)) {
        const laps = byDriver[driver].sort((a, b) => a.LapNumber - b.LapNumber);
        for (let i = 1; i < laps.length; i++) {
          const prev = laps[i - 1].Position;
          const curr = laps[i].Position;
          if (prev != null && curr != null) {
            const change = prev - curr; // positive = gained positions
            if (Math.abs(change) >= 3) {
              const lap = laps[i].LapNumber;
              // Avoid duplicate events on the same lap
              const exists = events.find(
                (e) => e.type === 'POSITION_CHANGE' && e.lap === lap && e.driver === driver
              );
              if (!exists) {
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
          }
        }
      }
    }

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
  }, [trackStatus, sessionData, frameData, lapFrameMap, maxLap, isQualifyingReplay]);

  // ── Tick function: advance one frame ───────────────────────────
  const tick = useCallback(() => {
    const state = useF1Store.getState();
    const { currentFrameIndex: idx, totalFrames: total } = state;
    if (idx >= total - 1) {
      state.setIsPlaying(false);
      return;
    }
    state.setCurrentFrameIndex(idx + 1);
  }, []);

  // ── Playback interval management (frame-based only) ──────────
  useEffect(() => {
    if (isPlaying && totalFrames > 1) {
      const interval = Math.max(16, (frameDt * 1000) / playSpeed);
      intervalRef.current = setInterval(tick, interval);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isPlaying, playSpeed, totalFrames, frameDt, tick]);

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
    useF1Store.getState().setCurrentFrameIndex(0);
  }, [setIsPlaying]);

  const skipToEnd = useCallback(() => {
    setIsPlaying(false);
    const state = useF1Store.getState();
    if (state.totalFrames > 0) {
      state.setCurrentFrameIndex(state.totalFrames - 1);
    }
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
