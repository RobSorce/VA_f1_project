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

  const isLiveMode = useF1Store((s) => s.isLiveMode);

  const rafRef = useRef(null);

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

    // ── Find actual lap at a given time using frame data ──────────
    // Frame data is the ground truth: each frame has driver data with actual lap numbers.
    // This avoids time-domain mismatches between frame.t (0-based relative) and
    // lapTimes.Time (absolute session time from FastF1).
    const frames = frameData?.frames;
    const hasFrames = frames?.length > 1;

    const findLapAtTime = (time) => {
      if (hasFrames) {
        // Binary search for frame at or just before the given time
        let lo = 0, hi = frames.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (frames[mid].t <= time) lo = mid;
          else hi = mid - 1;
        }
        const frame = frames[lo];
        if (frame?.drivers) {
          let maxLapInFrame = 1;
          for (const d of Object.values(frame.drivers)) {
            if (d.lap > maxLapInFrame) maxLapInFrame = d.lap;
          }
          return Math.max(1, Math.min(maxLap, maxLapInFrame));
        }
      }
      // Fallback: linear estimate from total frame time
      if (hasFrames && maxLap > 1) {
        const totalTime = frames[frames.length - 1].t;
        if (totalTime > 0) {
          return Math.max(1, Math.min(maxLap, Math.round(1 + (time / totalTime) * (maxLap - 1))));
        }
      }
      return 1;
    };

    // Time fraction for band rendering (ensures long events like red flags
    // get a visible band width even if lap numbers don't change)
    const totalFrameTime = hasFrames ? frames[frames.length - 1].t : 0;
    const timeFraction = (t) =>
      totalFrameTime > 0 ? Math.max(0, Math.min(1, t / totalFrameTime)) : null;

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

    if (trackStatus?.length) {
      for (const period of trackStatus) {
        const statusCode = String(period.status);
        if (statusCode === '1') continue;
        const mapping = STATUS_MAP[statusCode];
        if (!mapping) continue;

        const startLap = findLapAtTime(period.start_time);
        const endLap = period.end_time != null
          ? Math.max(startLap, findLapAtTime(period.end_time))
          : startLap;

        events.push({
          type: mapping.type,
          lap: startLap,
          startLap,
          endLap,
          startTimeFraction: timeFraction(period.start_time),
          endTimeFraction: timeFraction(period.end_time ?? period.start_time),
          description: period.message || mapping.label,
          color: mapping.color,
        });
      }
    }

    // ── Layer 2: Pit windows (aggregated with count + driver list) ──
    // Also generates per-driver pit events (Layer 3, filtered in TimelinePlayer)
    if (sessionData?.strategies?.length) {
      const byDriver = {};
      for (const stint of sessionData.strategies) {
        const drv = stint.Driver || stint.driver;
        if (!drv) continue;
        if (!byDriver[drv]) byDriver[drv] = [];
        byDriver[drv].push(stint);
      }
      // Collect all pit stops: { lap → [{driver, compound}] }
      const pitsByLap = {};
      for (const [drv, stints] of Object.entries(byDriver)) {
        stints.sort((a, b) => (a.StartLap || a.LapStart || 0) - (b.StartLap || b.LapStart || 0));
        for (let i = 1; i < stints.length; i++) {
          const stint = stints[i];
          const pitLap = stint.StartLap || stint.LapStart || stint.lap_start;
          const compound = stint.Compound || stint.compound || 'UNKNOWN';
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

    // ── Layer 2: Fastest lap — only the FINAL session fastest ─────
    if (sessionData?.lap_times?.length) {
      const lapTimes = sessionData.lap_times;
      let sessionBest = Infinity;
      let fastestEntry = null;
      for (const lt of lapTimes) {
        const time = lt.LapTime || lt.lap_time;
        if (time && time > 0 && lt.LapNumber > 1) {
          if (time < sessionBest) {
            sessionBest = time;
            fastestEntry = lt;
          }
        }
      }
      if (fastestEntry) {
        const mins = Math.floor(sessionBest / 60);
        const secs = (sessionBest % 60).toFixed(3);
        const timeStr = mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : `${secs}s`;
        events.push({
          type: 'FASTEST_LAP',
          lap: fastestEntry.LapNumber,
          startLap: fastestEntry.LapNumber,
          endLap: fastestEntry.LapNumber,
          description: `Fastest lap: ${fastestEntry.Driver || 'Unknown'} (${timeStr})`,
          color: '#a855f7',
          driver: fastestEntry.Driver,
        });
      }
    }

    // ── Layer 3: Position changes (3+ positions, per driver) ─────
    // Shown only for selected drivers in TimelinePlayer
    if (sessionData?.lap_times?.length) {
      const lapTimes = sessionData.lap_times;
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
            const change = prev - curr;
            if (Math.abs(change) >= 3) {
              const lap = laps[i].LapNumber;
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

  // ── Playback loop: RAF + wall-clock driven ─────────────────────
  // setInterval at 400ms felt sticky: chronos only updated 2.5× per second.
  // Using requestAnimationFrame, we advance currentTime smoothly (~60Hz) and
  // bump currentFrameIndex only when the target session time crosses a frame
  // boundary. Wall-clock math self-corrects if the JS thread stalls.
  useEffect(() => {
    if (isLiveMode) return; // In live mode, frames arrive via WebSocket
    if (!isPlaying || totalFrames <= 1) return;

    const frames = useF1Store.getState().frameData?.frames;
    if (!frames?.length) return;

    let wallStart = performance.now();
    let lastIdx = useF1Store.getState().currentFrameIndex;
    let sessionStart = frames[lastIdx]?.t ?? 0;

    const loop = (now) => {
      const state = useF1Store.getState();

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
