/**
 * Race clock: one definition of "now" shared by every analytic view.
 *
 * Two clocks exist in the data:
 *  - SESSION seconds: FastF1 SessionTime. Every time field of the session
 *    payload uses it: lap_times[].Time (lap end), LapStartTime, PitInTime /
 *    PitInTimeSeconds (set on the in-lap), PitOutTime / PitOutTimeSeconds (set
 *    on the out-lap = next lap), track_status[].start_time / end_time and
 *    weather_data[].Time. Lap 1 starts well after 0 (cached races: from 246 s
 *    in 2024 R9 to 4315 s in 2024 R21).
 *  - REPLAY seconds: frame.t of /api/frames, 0 at the earliest telemetry sample.
 *
 * Why frame.t + sessionTimeOffset = session time:
 * backend/data/extractors/fastf1_extractor.py extract_race_frames() collects
 * every driver's telemetry SessionTime, takes global_t_min = the earliest
 * sample over all drivers, and builds the replay timeline as
 *     timeline = np.arange(global_t_min, global_t_max, dt) - global_t_min
 * so frame.t = SessionTime - global_t_min. The earliest sample belongs to lap 1,
 * which starts at the race's LapStartTime, so global_t_min equals the smallest
 * LapStartTime of the lap table up to the telemetry padding (sub-second).
 * Evidence (src/utils/__tests__/raceTime.test.js, cached frames): at the frame
 * where a driver's lap counter steps from n to n+1, frame.t + min(LapStartTime)
 * minus lap n's Time has median 0.19 s (2024 R16), 0.21 s (2024 R5), 0.19 s
 * (2024 R3) and 0.21 s (2025 R1), 95th percentile <= 0.39 s: within one 0.4 s
 * frame step.
 *
 * Causal rule: at a given "now" (session seconds) a view may only use what had
 * happened by then: a lap is known once it has ended (Time <= now), a pit entry
 * once PitInTime <= now. Nothing from later laps may leak into replay analytics.
 *
 * Laps of the race clock are the race LEADER's laps: the lap-mode "now" at lap
 * L is the moment the leader started lap L (resolveSessionNow), and a
 * track-status change at session time t belongs to the lap the leader is on at
 * t (mapTrackStatusToLaps, the same rule as the backend).
 *
 * Pure module: no React, no D3, no store access.
 */

/** Finite number from a number or numeric string, otherwise null. */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** undefined / null / NaN "now" means "no time limit" (whole race). */
function normaliseNow(sessionNow) {
  if (sessionNow == null || Number.isNaN(sessionNow)) return Infinity;
  return sessionNow;
}

/**
 * Session-time offset of the replay clock: the session time (seconds) at which
 * replay time 0 occurs, i.e. session time = frame.t + offset.
 *
 * = min LapStartTime over laps with LapStartTime > 0. Fallback when no lap has a
 * LapStartTime: min(Time - LapTimeSeconds) over laps with both > 0. Returns 0
 * when nothing usable exists (e.g. live laps carry neither field).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @returns {number} offset in session seconds (0 when unknown)
 */
export function computeSessionTimeOffset(lapTimes) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return 0;
  let min = Infinity;
  for (const lt of lapTimes) {
    const start = toNum(lt?.LapStartTime);
    if (start != null && start > 0 && start < min) min = start;
  }
  if (min < Infinity) return min;
  for (const lt of lapTimes) {
    const end = toNum(lt?.Time);
    const dur = toNum(lt?.LapTimeSeconds);
    if (end != null && dur != null && end > 0 && dur > 0 && end - dur < min) min = end - dur;
  }
  return min < Infinity ? min : 0;
}

/**
 * Session time (seconds) at which a lap row ended: Time, or, when Time is
 * missing, LapStartTime + LapTimeSeconds. null when neither is available.
 *
 * @param {Object} lap - one lap_times row
 * @returns {number|null} session seconds
 */
export function lapEndTime(lap) {
  const end = toNum(lap?.Time);
  if (end != null) return end;
  const start = toNum(lap?.LapStartTime);
  const dur = toNum(lap?.LapTimeSeconds);
  if (start != null && dur != null && dur > 0) return start + dur;
  return null;
}

/**
 * Session time (seconds) at which a lap row started: LapStartTime when > 0,
 * else Time - LapTimeSeconds. null when neither is available. Same rule as
 * lap_windows() in backend/data/processors/stints.py.
 *
 * @param {Object} lap - one lap_times row
 * @returns {number|null} session seconds
 */
export function lapStartTime(lap) {
  const start = toNum(lap?.LapStartTime);
  if (start != null && start > 0) return start;
  const end = toNum(lap?.Time);
  const dur = toNum(lap?.LapTimeSeconds);
  if (end != null && dur != null && dur > 0) return end - dur;
  return null;
}

/**
 * Session time (seconds) at which the race LEADER finished lap `lap` (= the
 * moment the leader started lap + 1): Time of the row with Position 1 on that
 * lap; fallback the earliest Time over the rows of that lap with a Position
 * (a retiring car's truncated row has none); last resort the earliest Time of
 * the lap. null when no row of the lap has a Time.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} lap - lap number
 * @returns {number|null} session seconds
 */
export function leaderLapEndTime(lapTimes, lap) {
  if (!Array.isArray(lapTimes)) return null;
  let leader = null;
  let classified = Infinity;
  let any = Infinity;
  for (const lt of lapTimes) {
    if (toNum(lt?.LapNumber) !== lap) continue;
    const end = toNum(lt?.Time);
    if (end == null) continue;
    const pos = toNum(lt?.Position);
    if (pos === 1 && (leader == null || end < leader)) leader = end;
    if (pos != null && end < classified) classified = end;
    if (end < any) any = end;
  }
  if (leader != null) return leader;
  if (classified < Infinity) return classified;
  return any < Infinity ? any : null;
}

/**
 * The latest session time a track-status reading may come from at the
 * dashboard's clock: `now` when it is finite; at Infinity (the race over:
 * the replay's last frame, lap mode's race-over state) the moment the leader
 * took the chequered flag (leaderLapEndTime of the last lap), so a period that
 * began after the race (a post-race yellow, which mapTrackStatusToLaps drops
 * from the race too) is neither the flag shown nor the newest race-control
 * entry. Infinity when no lap row has a Time.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} now - session seconds, or Infinity
 * @returns {number} session seconds, or Infinity
 */
export function raceClockLimit(lapTimes, now) {
  if (now !== Infinity) return now;
  let lastLap = 0;
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    const n = toNum(lt?.LapNumber);
    if (n != null && n > lastLap) lastLap = n;
  }
  const chequered = lastLap > 0 ? leaderLapEndTime(lapTimes, lastLap) : null;
  return chequered ?? Infinity;
}

/**
 * Pit-entry time of an in-lap in session seconds (PitInTimeSeconds, else a
 * numeric PitInTime), or null.
 * @param {Object} lap
 * @returns {number|null}
 */
export function pitInSeconds(lap) {
  return toNum(lap?.PitInTimeSeconds) ?? toNum(lap?.PitInTime);
}

/**
 * Pit-exit time of an out-lap in session seconds (PitOutTimeSeconds, else a
 * numeric PitOutTime), or null.
 * @param {Object} lap
 * @returns {number|null}
 */
export function pitOutSeconds(lap) {
  return toNum(lap?.PitOutTimeSeconds) ?? toNum(lap?.PitOutTime);
}

/** True when the row is an in-lap (PitInTimeSeconds or PitInTime set). */
export function hasPitIn(lap) {
  return !!(lap?.PitInTimeSeconds || lap?.PitInTime);
}

/** True when the row is an out-lap (PitOutTimeSeconds or PitOutTime set). */
export function hasPitOut(lap) {
  return !!(lap?.PitOutTimeSeconds || lap?.PitOutTime);
}

/**
 * The single "now" of the dashboard, in SESSION seconds.
 *
 *  - isLiveMode: Infinity (every lap received from the feed is already over).
 *  - replayActive (replay frames loaded): currentTime (replay s) + offset.
 *    At the last frame (currentTime + frameDt > maxTime, both optional) the
 *    whole telemetry has been shown: Infinity, so laps ending in the sub-frame
 *    tail after the last frame still count as completed.
 *  - otherwise, lap-indexed mode (no frames):
 *      raceOver             -> Infinity (the race-over state, after the
 *                              chequered flag: the timeline's skip-to-end);
 *      currentLap > maxLap  -> Infinity (beyond the last lap);
 *      no lap rows          -> Infinity (no session: nothing has a clock);
 *      currentLap <= 1      -> sessionTimeOffset (race start, nothing completed);
 *      else, on every lap up to and including the last one, the session time
 *      at which the race LEADER started lap currentLap
 *      = leaderLapEndTime(lapTimes, currentLap - 1): Time of the Position-1 row
 *      of lap currentLap - 1 (fallback: min Time over the rows of that lap with
 *      a Position, then min Time), never a retiring car's truncated row. When
 *      that lap has no Time at all: min LapStartTime of lap currentLap.
 *      Infinity when neither exists (nothing can be ordered in time). The
 *      last lap is the moment the leader started it, as the replay's seek to
 *      that lap: its results are shown only in the race-over state.
 *  - currentLap missing in lap mode: Infinity (no limit, old behaviour).
 *
 * @param {Object} p
 * @param {number} [p.currentTime] - replay seconds (store.currentTime = frame.t)
 * @param {number} [p.sessionTimeOffset] - from computeSessionTimeOffset; computed from lapTimes when omitted
 * @param {boolean} [p.replayActive] - true when replay frames are loaded
 * @param {number} [p.currentLap]
 * @param {number} [p.maxLap] - computed from lapTimes when omitted
 * @param {Array<Object>} [p.lapTimes] - sessionData.lap_times
 * @param {boolean} [p.isLiveMode]
 * @param {number} [p.maxTime] - replay seconds of the last telemetry sample (frames max_time)
 * @param {number} [p.frameDt] - replay seconds between frames
 * @param {boolean} [p.raceOver] - lap-indexed mode only: the race-over state
 *   (store.lapModeRaceOver), Infinity
 * @returns {number} session seconds, or Infinity
 */
export function resolveSessionNow({
  currentTime, sessionTimeOffset, replayActive, currentLap, maxLap, lapTimes, isLiveMode,
  maxTime, frameDt, raceOver,
} = {}) {
  if (isLiveMode) return Infinity;
  const offset = Number.isFinite(sessionTimeOffset)
    ? sessionTimeOffset
    : computeSessionTimeOffset(lapTimes);

  if (replayActive && Number.isFinite(currentTime)) {
    if (Number.isFinite(maxTime) && maxTime > 0 && Number.isFinite(frameDt) && frameDt > 0
        && currentTime + frameDt > maxTime) {
      return Infinity;
    }
    return currentTime + offset;
  }

  // Lap-indexed mode
  if (raceOver) return Infinity;
  const lap = toNum(currentLap);
  if (lap == null) return Infinity;
  let last = toNum(maxLap);
  const rows = Array.isArray(lapTimes) ? lapTimes : [];
  if (!rows.length) return Infinity;
  if (last == null) {
    last = 0;
    for (const lt of rows) {
      const n = toNum(lt?.LapNumber);
      if (n != null && n > last) last = n;
    }
  }
  if (lap > last) return Infinity;
  if (lap <= 1) return offset;

  const leaderEnd = leaderLapEndTime(rows, lap - 1);
  if (leaderEnd != null) return leaderEnd;
  let leaderStart = Infinity;
  for (const lt of rows) {
    if (toNum(lt?.LapNumber) !== lap) continue;
    const start = toNum(lt?.LapStartTime);
    if (start != null && start > 0 && start < leaderStart) leaderStart = start;
  }
  return leaderStart;
}

/**
 * Causal test for one lap row: completed once its end (lapEndTime, session s)
 * is <= sessionNow. Rows with no end time are completed only when
 * sessionNow === Infinity. sessionNow undefined/null means Infinity.
 *
 * @param {Object} lap - one lap_times row
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {boolean}
 */
export function isLapCompleted(lap, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  if (now === Infinity) return true;
  const end = lapEndTime(lap);
  return end != null && end <= now;
}

/**
 * Lap rows completed at sessionNow (session seconds), input order kept.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} [sessionNow=Infinity]
 * @returns {Array<Object>}
 */
export function completedLaps(lapTimes, sessionNow = Infinity) {
  if (!Array.isArray(lapTimes)) return [];
  const now = normaliseNow(sessionNow);
  return lapTimes.filter((lt) => isLapCompleted(lt, now));
}

/**
 * Green-flag lap: TrackStatus string is exactly '1' (no yellow, SC, VSC or red
 * at any point of the lap; '4' = SC, '6'/'7' = VSC, '5' = red).
 *
 * @param {Object} lap
 * @returns {boolean}
 */
export function isGreenLap(lap) {
  return String(lap?.TrackStatus) === '1';
}

/**
 * Causal test for a pit entry: true when the row is an in-lap and its pit-in
 * time (session s) is <= sessionNow. Without a numeric pit-in time the in-lap
 * must be completed. Non in-laps return false.
 *
 * @param {Object} lap - one lap_times row
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {boolean}
 */
export function isPitVisible(lap, sessionNow = Infinity) {
  if (!hasPitIn(lap)) return false;
  const now = normaliseNow(sessionNow);
  if (now === Infinity) return true;
  const pitIn = pitInSeconds(lap);
  if (pitIn != null) return pitIn <= now;
  return isLapCompleted(lap, now);
}

// ---------------------------------------------------------------------------
// Track-status periods -> laps (port of backend/data/processors/stints.py
// lap_windows / lap_at_session_time / map_track_status_to_laps; same output)
// ---------------------------------------------------------------------------

/**
 * [lapNumber, start, end] for every lap row with a usable window, input order
 * kept: start = lapStartTime (LapStartTime when > 0, else Time -
 * LapTimeSeconds), end = Time; rows without a lap number, start or Time, or
 * ending before they start, are skipped. Lap numbers are truncated to integers.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @returns {Array<[number, number, number]>} session seconds
 */
export function lapWindows(lapTimes) {
  const out = [];
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt || typeof lt !== 'object' || Array.isArray(lt)) continue;
    const n = toNum(lt.LapNumber);
    const end = toNum(lt.Time);
    let start = toNum(lt.LapStartTime);
    if (start == null || start <= 0) {
      const dur = toNum(lt.LapTimeSeconds);
      start = end != null && dur != null && dur > 0 ? end - dur : null;
    }
    if (n == null || start == null || end == null || end < start) continue;
    out.push([Math.trunc(n), start, end]);
  }
  return out;
}

/**
 * The lap the race LEADER is on at session time t: the highest lap number
 * among the windows [start, end] that contain t (= the highest lap of any car
 * in the replay frame at t). When no window contains t (a gap in the rows):
 * the highest lap whose start is <= t. null before the first lap.
 *
 * @param {Array<[number, number, number]>} windows - lapWindows output
 * @param {number} t - session seconds
 * @returns {number|null}
 */
export function leaderLapAt(windows, t) {
  let containing = null;
  let started = null;
  for (const [n, start, end] of windows) {
    if (start <= t && t <= end && (containing == null || n > containing)) containing = n;
    if (start <= t && (started == null || n > started)) started = n;
  }
  return containing ?? started;
}

/**
 * Lap range of each track-status period, on the race LEADER's lap: an event
 * at session time t belongs to leaderLapAt(t), for the start and for the end
 * alike (2024 R5: VSC deployed on lap 22, SC on laps 23 and 27, as in FIA race
 * control). Each period {status, start_time, end_time, message} (session
 * seconds; end_time null = lasts to the end) comes back as a copy with
 *   start_lap: 1 when the period began by the race start, else leaderLapAt(start_time);
 *   end_lap:   the last lap when end_time is null or after the last lap ended,
 *              else leaderLapAt(end_time); never below start_lap.
 * Periods outside the race are dropped: those that ended by the race start
 * (grid, formation lap) and those that began after the last lap ended.
 * Periods keep their input order. [] when no lap row has a usable window.
 * Identical output to map_track_status_to_laps in
 * backend/data/processors/stints.py (parity test over every cached session).
 *
 * @param {Array<Object>} trackStatus - sessionData.track_status
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @returns {Array<Object>} {...period, start_lap, end_lap}
 */
export function mapTrackStatusToLaps(trackStatus, lapTimes) {
  const windows = lapWindows(lapTimes);
  if (!windows.length) return [];
  let raceStart = Infinity;
  let raceEnd = -Infinity;
  let lastLap = -Infinity;
  for (const [n, start, end] of windows) {
    if (start < raceStart) raceStart = start;
    if (end > raceEnd) raceEnd = end;
    if (n > lastLap) lastLap = n;
  }
  const out = [];
  for (const period of Array.isArray(trackStatus) ? trackStatus : []) {
    if (!period || typeof period !== 'object' || Array.isArray(period)) continue;
    const start = toNum(period.start_time);
    const end = toNum(period.end_time);
    if (start == null) continue;
    if (end != null && end <= raceStart) continue;
    if (start > raceEnd) continue;
    const startLap = start <= raceStart ? 1 : leaderLapAt(windows, start);
    const endLap = end == null || end >= raceEnd ? lastLap : leaderLapAt(windows, end);
    out.push({ ...period, start_lap: startLap, end_lap: Math.max(startLap, endLap) });
  }
  return out;
}
