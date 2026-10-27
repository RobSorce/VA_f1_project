import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as api from '../utils/apiClient';
import { setHealthReporter } from '../utils/apiClient';
import { useDemoMode, DEMO_NOTE } from '../utils/demoMode';
import { setSessionDriverColors } from '../utils/colors';
import { computePCA, LIVE_PCA_ALIGN } from '../utils/livePCA';
import { extractRaceSituationFeatures, FEATURE_NAMES, estimatedLapsToPit } from '../utils/raceSituationFeatures';
import { stintLifeEstimate } from '../utils/raceSimulation';
import { replayReferenceAt } from '../utils/raceSituationReference';
import {
  createSimulationClient, planFromStints, withBadges, whatIfKey, whatIfMarks,
} from '../utils/simulationClient';
import { seedFrom } from '../utils/prng';
import {
  computeSessionTimeOffset, resolveSessionNow, completedLaps, lapStartTime, lapEndTime,
  raceClockLimit, activeSegmentWindow,
} from '../utils/raceTime';
import { pitStops, stintsRunning } from '../utils/stints';
import { driverStateAt, nonFinisherMap } from '../utils/driverState';
import {
  viewSessionType, isRaceSession, causalKey, sessionScopeOf,
} from '../utils/strategyViews';
import { SLOT_IDS } from '../utils/slotOptions';
import { brushFitKey } from '../utils/views/degradationViews';
import { loadedRaceClock } from '../utils/views/pcaBiplot';
import { FALLBACK_SEASONS, seasonsFromResponse } from '../utils/seasons';
import {
  forecastRequestOf, forecastEntry,
} from '../utils/forecast';
import { TRACE_REFERENCES, TRACE_WINDOWS } from '../utils/raceTrace';

/* ── Race clock helpers (SESSION seconds, see utils/raceTime.js) ── */

/**
 * Track status in force at a SESSION time: the change with the latest
 * start_time <= sessionTime ('1' = green when there is none).
 * track_status times are FastF1 SessionTime; a replay frame is converted with
 * frame.t + sessionTimeOffset before calling this.
 *
 * @param {Array<{status, start_time}>} trackStatus
 * @param {number} sessionTime - session seconds (Infinity = after the last change)
 * @returns {string} status code
 */
export function flagAtSessionTime(trackStatus, sessionTime) {
  let flag = '1';
  let flagStart = -Infinity;
  if (!Array.isArray(trackStatus)) return flag;
  for (const s of trackStatus) {
    if (s?.start_time == null || s.start_time > sessionTime) continue;
    if (s.start_time >= flagStart) {
      flagStart = s.start_time;
      flag = String(s.status);
    }
  }
  return flag;
}

/**
 * The flag at the dashboard's clock (getSessionNow, session seconds).
 * A finite clock: the status in force then (flagAtSessionTime). Infinity
 * outside live mode means the race is over (lap mode's race-over state,
 * the replay's last frame): the status in force when the leader took the
 * chequered flag (end of the last lap, utils/raceTime.js raceClockLimit),
 * never a period that began after the race (a post-race yellow; R5 drops
 * those periods from the race too). Without lap rows: after the last change.
 *
 * @param {Array<{status, start_time}>} trackStatus
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} now - session seconds, or Infinity
 * @returns {string} status code
 */
export function flagAtClock(trackStatus, lapTimes, now) {
  return flagAtSessionTime(trackStatus, raceClockLimit(lapTimes, now));
}

/**
 * Weather row in force at a SESSION time: the latest row with Time <=
 * sessionTime (a reading is known once it has been taken). Before the first
 * row: the first row. sessionTime Infinity / missing (live mode, race over):
 * the last row.
 *
 * @param {Array<{Time}>} weather - sessionData.weather_data
 * @param {number} sessionTime - session seconds
 * @returns {Object|null}
 */
export function weatherAtSessionTime(weather, sessionTime) {
  if (!Array.isArray(weather) || weather.length === 0) return null;
  if (sessionTime == null || Number.isNaN(sessionTime) || sessionTime === Infinity) {
    return weather[weather.length - 1];
  }
  let best = null;
  for (const w of weather) {
    if (w?.Time == null) continue;
    const t = Number(w.Time);
    if (!Number.isFinite(t) || t > sessionTime) continue;
    if (!best || t >= Number(best.Time)) best = w;
  }
  return best || weather[0];
}

/**
 * Last lap number completed at sessionNow. With drivers: the smallest of the
 * drivers' last completed laps (so no requested driver contributes an
 * unfinished lap); without: the race leader's last completed lap. 0 when
 * nothing is completed.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} sessionNow - session seconds (Infinity = whole race)
 * @param {string[]} [drivers]
 * @returns {number}
 */
export function lastCompletedLap(lapTimes, sessionNow, drivers = null) {
  const want = Array.isArray(drivers) && drivers.length > 0 ? new Set(drivers) : null;
  const lastBy = {};
  let overall = 0;
  for (const lt of completedLaps(lapTimes, sessionNow)) {
    const n = Number(lt.LapNumber);
    if (!Number.isFinite(n)) continue;
    if (n > overall) overall = n;
    if (want && want.has(lt.Driver) && n > (lastBy[lt.Driver] || 0)) lastBy[lt.Driver] = n;
  }
  if (!want) return overall;
  let min = Infinity;
  for (const d of want) min = Math.min(min, lastBy[d] || 0);
  return min;
}

/**
 * A brushed lap range [start, end] clamped so that end never exceeds
 * lastLap. null when there is no range or no lap of it is completed yet.
 *
 * @param {[number, number]|null} range
 * @param {number} lastLap - from lastCompletedLap
 * @returns {[number, number]|null}
 */
export function clampLapRange(range, lastLap) {
  if (!Array.isArray(range) || range.length < 2) return null;
  const [lo, hi] = range;
  const end = Math.min(hi, lastLap);
  return end >= lo ? [lo, end] : null;
}

/**
 * Seconds on the replay clock as text: m:ss, h:mm:ss from one hour, with a
 * leading '-' before replay time 0 (e.g. a pre-race track-status change).
 * '--:--' when the value is not a finite number.
 *
 * @param {number} seconds - replay seconds (session seconds - sessionTimeOffset)
 * @returns {string}
 */
export function formatReplayClock(seconds) {
  const v = Number(seconds);
  if (seconds == null || !Number.isFinite(v)) return '--:--';
  const sign = v < 0 ? '-' : '';
  const total = Math.floor(Math.abs(v));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${s}` : `${sign}${m}:${s}`;
}

/**
 * Type of the session on screen ('R', 'S', 'Q', 'FP2', ...): the type
 * loadSession recorded, else the session-type pill (nothing loaded yet). The
 * pill alone is the type of the NEXT load: the session menus change it without
 * loading, so a view that gates on it would follow a session not on screen.
 *
 * @param {Object} s - store state
 * @returns {string}
 */
export function loadedSessionTypeOf(s) {
  return s?.loadedSessionType || s?.sessionType;
}

// Identity of the session on screen (utils/strategyViews.js sessionScopeOf,
// shared with the request bodies built outside the store), re-exported for
// the views that read it from here
export { sessionScopeOf };

/**
 * Suffix of the telemetry cache keys of a session scope (sessionScopeOf):
 * '-<year>-<round>-<type>', '' without a scope. A key is
 * `${driver}-${lap}${suffix}` (telemetryCacheKey), so a trace of another
 * session can never be read under the same key (D7).
 *
 * @param {{year: number, round: number, sessionType: string}|null} scope
 * @returns {string}
 */
export function telemetryKeySuffix(scope) {
  return scope ? `-${scope.year}-${scope.round}-${scope.sessionType}` : '';
}

/**
 * Key of one lap's telemetry in store.telemetryCache.
 *
 * @param {string} driver
 * @param {number} lap
 * @param {{year: number, round: number, sessionType: string}|null} scope - sessionScopeOf
 * @returns {string}
 */
export function telemetryCacheKey(driver, lap, scope) {
  return `${driver}-${lap}${telemetryKeySuffix(scope)}`;
}

/**
 * What the dashboard shows, as a key: replay or live mode and the session on
 * screen (sessionScopeOf). It changes when loadSession, enterLiveMode,
 * exitLiveMode or resetSession put another session on screen (their commit),
 * not when they start, with one exception: loadSession called in live mode
 * leaves live mode at its start (the live rows stay on screen until the load
 * lands), and a mock live race and its replay have the same key. Two screens
 * can therefore share a key (that one, and a reload of the race on screen):
 * sessionRequestGuard also holds the screen generation (_screenGeneration).
 *
 * @param {Object} s - store state
 * @returns {string}
 */
export function screenKeyOf(s) {
  const scope = sessionScopeOf(s);
  return `${s?.isLiveMode ? 'live' : 'replay'}:${scope ? `${scope.year}-${scope.round}-${scope.sessionType}` : '-'}`;
}

/**
 * The store's causal "now" in SESSION seconds for a state object (see
 * utils/raceTime.js resolveSessionNow; hooks/useSessionNow.js is the React
 * twin). A qualifying segment's last frame is not the end of the session (the
 * next segments follow): it stands for the segment's end (the end of its last
 * lap, qualiSegmentWindows), never Infinity.
 *
 * @param {Object} s - store state (or a prospective one)
 * @returns {number} session seconds, or Infinity
 */
function sessionNowOf(s) {
  return resolveSessionNow({
    currentTime: s.currentTime,
    sessionTimeOffset: s.sessionTimeOffset,
    replayActive: s.totalFrames > 0,
    currentLap: s.currentLap,
    maxLap: s.maxLap,
    lapTimes: s.sessionData?.lap_times,
    isLiveMode: s.isLiveMode,
    maxTime: s.maxTime,
    frameDt: s.frameDt,
    raceOver: s.lapModeRaceOver,
    qualifying: s.isQualifyingReplay,
    segmentEnd: activeSegmentWindow(s)?.end,
  });
}

/**
 * The cross-race PCA requests (GET /api/pca/embeddings, POST
 * /api/pca/analyze-selection) for a state: the rows, stints and stops of the
 * race of the weekend on screen are taken at `params.session_now`, never
 * after it (decision R6; utils/views/pcaBiplot.js loadedRaceClock).
 *  - params null: no session on screen, or the race on screen at its end:
 *    the post-race artefact, every row a whole race;
 *  - the race on screen while its clock runs: {year, round, session_now} =
 *    the dashboard's clock (a replay), or in live mode the end of the latest
 *    lap row received (the clock of the feed's data: a mock replay of a
 *    cached race, the only live session the backend holds rows of);
 *  - another session of the weekend on screen (practice, qualifying, sprint):
 *    session_now 0, a race clock before any lap: the race has not started, so
 *    none of its rows is used.
 * `at` is the clock laterClockReset compares the answers with (Infinity =
 * post-race rows of the race on screen, null = nothing to guard), `key`
 * changes when the answer would change (the race on screen, the state of its
 * clock, the lap): PCABiplot reloads the embeddings on it.
 *
 * @param {Object} s - store state
 * @returns {{params: {year: number, round: number, session_now: number}|null,
 *   at: number|null, key: string, raceClock: string|null}}
 */
export function pcaRequestOf(s) {
  const scope = sessionScopeOf(s);
  if (!scope) return { params: null, at: null, key: 'post-race', raceClock: null };
  const year = Number(scope.year);
  const round = Number(scope.round);
  const now = sessionNowOf(s);
  const raceClock = loadedRaceClock({ sessionType: scope.sessionType, sessionNow: now, isLiveMode: s.isLiveMode });
  if (raceClock === 'ended') return { params: null, at: Infinity, key: `${year}-${round}-ended`, raceClock };
  if (raceClock === 'not-started') {
    return {
      params: { year, round, session_now: 0 }, at: null, key: `${year}-${round}-${scope.sessionType}-before`, raceClock,
    };
  }
  let clock = now;
  if (s.isLiveMode) {
    clock = 0;
    for (const row of s.sessionData?.lap_times || []) {
      const end = lapEndTime(row);
      if (Number.isFinite(end) && end > clock) clock = end;
    }
  }
  return { params: { year, round, session_now: clock }, at: clock, key: `${year}-${round}-lap${s.currentLap}`, raceClock };
}

/**
 * The cross-race PCA answers to drop when another session replaces the one on
 * screen (loadSession, enterLiveMode, exitLiveMode, resetSession). Their rows
 * of the race on screen were taken for the previous screen: a post-race answer
 * lies in the future of a practice session of the same weekend, of the same
 * race reloaded at its start and of any other race's replay, and clocks of two
 * sessions cannot be compared, so none of them stays (R6). The selection stays;
 * refetchDroppedPCA asks for its analysis (and the embeddings) at the new
 * screen's clock. The sequences move on, so an answer still on its way for
 * the previous screen is discarded.
 *
 * @param {Object} s - store state before the change
 * @returns {Object} partial state
 */
export function pcaScreenReset(s) {
  return {
    pcaEmbeddings: null, _pcaEmbeddingsAt: null, _pcaEmbeddingsSeq: (s._pcaEmbeddingsSeq || 0) + 1,
    pcaStrategyAnalysis: null, pcaAnalysisIds: null, pcaAnalysisError: null, _pcaAnalysisAt: null,
    _pcaAnalysisSeq: (s._pcaAnalysisSeq || 0) + 1,
  };
}

/**
 * After a clock or session change has dropped cross-race PCA answers
 * (`dropped`: the partial state applied, from laterClockReset or
 * pcaScreenReset), asks for them again at the clock now on screen
 * (pcaRequestOf), as a seek does (_scheduleClockRecompute), so no view is left
 * waiting for an answer nobody asked for: the embeddings when they were
 * loaded before the change (`before`), the analysis when a selection is on
 * screen without one.
 *
 * @param {Function} get - store getter
 * @param {Object} dropped - partial state the change applied
 * @param {Object} before - store state before the change
 */
function refetchDroppedPCA(get, dropped, before) {
  const s = get();
  if ('pcaEmbeddings' in dropped && before.pcaEmbeddings) s.loadPCAEmbeddings();
  if ('pcaStrategyAnalysis' in dropped && s.selectedPCAPoints?.length && !s.pcaStrategyAnalysis) {
    s.fetchPCAAnalysis(s.selectedPCAPoints);
  }
}

/** Embeddings without the rows of (year, round) (a race clock later than now). */
function pcaWithoutRace(emb, year, round) {
  const points = (emb?.points || []).filter((p) => !(Number(p.year) === year && Number(p.round) === round));
  return { ...emb, points, n_points: points.length, current_race: { ...emb.current_race, n_points: 0 } };
}


/**
 * The deriveStints `running` option for a state object (utils/stints.js
 * stintsRunning; hooks/useSessionNow.js useStintsRunning is the React twin):
 * in live mode before the chequered flag, the last stint of every driver still
 * racing is ongoing; false otherwise.
 *
 * @param {Object} s - store state
 * @returns {false|function(string): boolean}
 */
function stintsRunningOf(s) {
  return stintsRunning({
    isLiveMode: s.isLiveMode,
    totalRaceLaps: s.totalRaceLaps,
    lapTimes: s.sessionData?.lap_times,
    dnfMap: s.dnfMap,
  });
}

/* ── Monte Carlo simulation (utils/raceSimulation.js) ─────────────── */

// The jobs run in a module Web Worker (Vite bundles the worker file on its
// own); where Worker does not exist (vitest, server rendering) the client runs
// each job synchronously, so its result is set before the action returns.
const simulation = createSimulationClient({
  createWorker: typeof Worker === 'undefined'
    ? null
    : () => new Worker(new URL('../workers/raceSimulation.worker.js', import.meta.url), { type: 'module' }),
});
// Dev server: a hot update of this module starts a new client; end the old worker
if (import.meta.hot) import.meta.hot.dispose(() => simulation.dispose());

// The projection request behind store.raceProjection, or in flight:
// { key, inputs, pending, result, ... } (simulationJob)
let _projectionRequest = null;

/**
 * Race length the projection runs to: the race's lap count when the feed
 * gives it (live: totalRaceLaps; maxLap there is the furthest lap seen so
 * far), else maxLap (replay: the session's last lap).
 */
function projectionMaxLap(s) {
  return s.totalRaceLaps || s.maxLap;
}

/** Which session is on screen, for the Monte Carlo seed. */
function sessionIdentity(s) {
  if (s.isLiveMode) {
    const info = s.liveSessionInfo || {};
    return `live|${info.event_name || ''}|${info.session_name || info.session_type || ''}`;
  }
  return `${s.year}|${s.round}|${viewSessionType(s)}`;
}

/** The stintsRunningOf option as plain data for the worker: a list of driver codes, or false. */
function runningDrivers(running, lapTimes) {
  if (typeof running !== 'function') return !!running;
  const out = new Set();
  for (const lt of lapTimes || []) if (lt?.Driver && running(lt.Driver)) out.add(lt.Driver);
  return [...out].sort();
}

/**
 * Inputs of a Monte Carlo run at the store's clock, shared by the race
 * projection and the what-if (so the what-if baseline, the stop model, is the
 * projection's row of that driver). null when no race projection can run:
 * not a race session (R7: no race pit-loss logic outside 'R' / 'S'), a
 * qualifying replay, before lap 5, no lap left, no race situation or lap rows.
 *
 * Seed: from the session on screen and the clock, i.e. the lap in progress,
 * the race length and causalKey (what is known at sessionNow: completed laps,
 * pit entries and exits, track-status changes). The same state always gives
 * the same result, and replay frames that add nothing new never change it.
 *
 * @param {Object} s - store state
 * @returns {{params: Object, rsd: Object, now: number, currentLap: number, seed: number,
 *   key: string, inputs: Array}|null} params: plain data for simulateRaceFinish
 */
export function simulationJob(s) {
  const sessionType = viewSessionType(s);
  if (s.isQualifyingReplay || !isRaceSession(sessionType)) return null;
  const rsd = s.raceSituationData;
  const lapTimes = s.sessionData?.lap_times;
  const { currentLap } = s;
  const maxLap = projectionMaxLap(s);
  if (!rsd?.driverFeatures || !lapTimes?.length || !(currentLap >= 5) || !(maxLap > currentLap)) return null;
  const now = sessionNowOf(s);
  // Live mode updates trackStatus from the feed; a replay sets both alike
  const trackStatus = s.trackStatus?.length ? s.trackStatus : (s.sessionData?.track_status || []);
  const running = runningDrivers(stintsRunningOf(s), lapTimes);
  const known = causalKey(lapTimes, now, trackStatus);
  const seed = seedFrom('race-simulation', sessionIdentity(s), currentLap, maxLap, known);
  return {
    rsd,
    now,
    currentLap,
    seed,
    key: `${seed}|${known}|${Array.isArray(running) ? running.join(',') : running}`,
    inputs: [rsd, lapTimes, trackStatus, s.dnfMap, s.sessionTimeOffset],
    params: {
      driverFeatures: rsd.driverFeatures,
      currentLap,
      maxLap,
      lapTimes,
      trackStatus,
      sessionNow: now,
      sessionTimeOffset: s.sessionTimeOffset,
      sessionType,
      running,
      dnfMap: s.dnfMap,
      seed,
    },
  };
}

function sameSimulationJob(a, b) {
  return !!a && !!b && a.key === b.key && a.inputs.every((v, i) => v === b.inputs[i]);
}

/* ── Clock-derived analytics ───────────────────────────────────── */

/**
 * State to drop at a clock change: every clock-derived analytic computed at
 * a LATER session time than `now` (each one carries the session time it was
 * computed at). Used in the same set() as the clock change, so no view ever
 * reads values from a later clock; the analytics are then recomputed at the
 * new clock.
 *
 * @param {Object} s - store state before the change
 * @param {number} now - session seconds after the change (Infinity = no limit)
 * @returns {Object} partial state (empty when nothing is ahead of now)
 */
export function laterClockReset(s, now) {
  const later = (at) => typeof at === 'number' && !Number.isNaN(at) && at > now;
  const out = {};
  if (later(s.raceSituationData?.computedAtNow)) {
    // The PCA basis of later laps goes too (it was fitted on them)
    Object.assign(out, { raceSituationData: null, raceSituationLap: null, _prevPcaResult: null });
  }
  if (later(s.raceProjection?.computedAtNow)) out.raceProjection = null;
  if (later(s.simulatorResult?.computedAtNow)) out.simulatorResult = null;
  if (later(s._rivalContextAt)) Object.assign(out, { rivalContext: [], _rivalContextAt: null });
  if (later(s._lstmAt)) Object.assign(out, { lstmPredictions: null, _lstmAt: null, lastPredictionTrigger: null });
  if (later(s._pcaEmbeddingsAt)) {
    // Rows of the race on screen at a later clock: embeddings at a race clock
    // (axes fitted without that race) keep the other races' rows; the
    // post-race artefact (axes fitted on its final rows too) goes whole
    const cr = s.pcaEmbeddings?.current_race;
    out.pcaEmbeddings = s._pcaEmbeddingsAt !== Infinity && cr?.year != null
      ? pcaWithoutRace(s.pcaEmbeddings, Number(cr.year), Number(cr.round))
      : null;
    out._pcaEmbeddingsAt = null;
    out._pcaEmbeddingsSeq = (s._pcaEmbeddingsSeq || 0) + 1;
  }
  if (later(s._pcaAnalysisAt)) {
    // the selection stays; its analysis is asked again at the new clock
    Object.assign(out, {
      pcaStrategyAnalysis: null, pcaAnalysisIds: null, _pcaAnalysisAt: null,
      _pcaAnalysisSeq: (s._pcaAnalysisSeq || 0) + 1,
    });
  }
  const deg = s.degradationRegression;
  if (later(deg?.computedAtNow)) {
    // A brushed fit stays (re-stamped) only while every lap it used is still
    // completed at now AND its inputs are the same at now (brushFitKey: the
    // clean laps of the range, whose outlier status a later lap of a growing
    // stint can change); anything else is re-derived by
    // refreshDegradationRegression at the new clock
    const req = s._degradationRequest;
    const sameRequest = !!req && deg.lap_start === req.lap_start && deg.lap_end === req.lap_end;
    const keep = sameRequest && deg.slope != null && Number.isFinite(deg.lap_end_used)
      && deg.lap_end_used <= lastCompletedLap(s.sessionData?.lap_times, now, req.drivers)
      && deg.fit_key != null && deg.fit_key === brushFitKey(s.sessionData?.lap_times, req.drivers, {
        sessionNow: now, lapStart: req.lap_start, lapEnd: req.lap_end,
      });
    out.degradationRegression = keep ? { ...deg, computedAtNow: now } : null;
    // A dropped result of the active request is re-requested at the new clock
    if (!keep && req) out._degradationRequest = { ...req, lap_end_used: null, fit_key: null, done_key: null };
  }
  return out;
}

/**
 * The laps completed at now by each driver (lastCompletedLap per driver),
 * as text: a brushed fit's inputs (brushFitKey) can change only when it
 * changes, so it gates the costlier check.
 *
 * @param {Array<Object>} lapTimes
 * @param {string[]} drivers
 * @param {number} now - session seconds
 * @returns {string}
 */
function completedLapsKey(lapTimes, drivers, now) {
  return (drivers || []).map((d) => lastCompletedLap(lapTimes, now, [d])).join(',');
}

// The last (request, completedLapsKey) degradationRefreshParams found with
// unchanged inputs: the same pair needs no new check on the next frame
let _degradationChecked = { request: null, doneKey: null };

/**
 * Parameters of the re-request of the active brushed degradation fit at the
 * state's clock (refreshDegradationRegression), or null when none is due: no
 * request, live mode, another brush active, or the same inputs as the last
 * request (the same clamped lap end and the same brushFitKey). laterClockReset
 * clears lap_end_used / fit_key of a result it drops, so that one is re-asked.
 *
 * @param {Object} s - store state
 * @returns {Object|null} fetchDegradationRegression params
 */
function degradationRefreshParams(s) {
  const req = s._degradationRequest;
  if (!req || s.isLiveMode) return null;
  const active = s.brushLapRange || s.selectedLapRange;
  if (!active || active[0] !== req.lap_start || active[1] !== req.lap_end) return null;
  const lapTimes = s.sessionData?.lap_times;
  const now = sessionNowOf(s);
  const doneKey = completedLapsKey(lapTimes, req.drivers, now);
  if (req.lap_end_used != null && req.fit_key != null) {
    // Nothing completed since the request, or since the last check found the same inputs
    if (doneKey === req.done_key) return null;
    if (_degradationChecked.request === req && _degradationChecked.doneKey === doneKey) return null;
    const lapEndUsed = Math.min(req.lap_end, lastCompletedLap(lapTimes, now, req.drivers));
    const fitKey = brushFitKey(lapTimes, req.drivers, {
      sessionNow: now, lapStart: req.lap_start, lapEnd: req.lap_end,
    });
    if (lapEndUsed === req.lap_end_used && fitKey === req.fit_key) {
      _degradationChecked = { request: req, doneKey };
      return null;
    }
  }
  const params = { ...req };
  delete params.lap_end_used;
  delete params.fit_key;
  delete params.done_key;
  return params;
}

// Full-race pit stops (tyre changes, utils/stints.js pitStops) per lap table:
// the focus-driver pit trigger reads only stops whose pit exit has passed
const _fullRaceStops = new WeakMap();
function fullRaceStops(lapTimes) {
  if (!Array.isArray(lapTimes)) return [];
  if (!_fullRaceStops.has(lapTimes)) _fullRaceStops.set(lapTimes, pitStops(lapTimes));
  return _fullRaceStops.get(lapTimes);
}

/**
 * Why a brushed degradation fit has no lap yet (lap_end_used < lap_start).
 * For each requested driver whose data ends before the brushed range and
 * whose end is already visible at now: retired (utils/driverState.js
 * driverStateAt) -> "XXX retired on lap N", otherwise "XXX's last lap is N".
 * A driver with no lap rows: "No lap data for XXX". Otherwise the laps are
 * still to come at the current replay time.
 *
 * @param {Array<Object>} lapTimes
 * @param {string[]} drivers
 * @param {number} now - session seconds
 * @param {number} lapStart - first brushed lap
 * @param {Object} [dnfMap] - store.dnfMap
 * @param {Object} [opts]
 * @param {boolean} [opts.isLiveMode] - live feed rows: retirements from the feed's
 *   dnfMap only (utils/driverState.js nonFinisherMap)
 * @returns {string}
 */
export function degradationGapReason(lapTimes, drivers, now, lapStart, dnfMap = {}, { isLiveMode = false } = {}) {
  const notes = [];
  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(lapTimes, dnfMap, { live: isLiveMode });
  for (const drv of Array.isArray(drivers) ? drivers : []) {
    const rows = (lapTimes || []).filter((r) => r?.Driver === drv && Number.isFinite(Number(r.LapNumber)));
    if (!rows.length) {
      notes.push(`No lap data for ${drv}`);
      continue;
    }
    const lastLap = Math.max(...rows.map((r) => Number(r.LapNumber)));
    if (lastLap >= lapStart) continue;
    const state = driverStateAt(lapTimes, drv, now, { dnf: !!nonFinishers[drv] });
    if (state.retired) notes.push(`${drv} retired on lap ${lastLap}`);
    else if (state.lapsCompleted === lastLap) notes.push(`${drv}'s last lap is ${lastLap}`);
  }
  if (notes.length) return `${notes.join('; ')}: no lap from lap ${lapStart} to fit.`;
  return 'No lap of the brushed range is completed yet at the current replay time.';
}

/* ── Qualifying replay clock ───────────────────────────────────── */

// Compound codes of the replay frames (fastf1_extractor.py compound_map)
const FRAME_COMPOUND_CODES = { SOFT: 1, MEDIUM: 2, HARD: 3, INTERMEDIATE: 4, WET: 5 };

/**
 * Session time (seconds) of replay time 0 of ONE qualifying segment.
 *
 * backend/data/extractors/fastf1_extractor.py extract_qualifying_frames()
 * builds each segment (Q1/Q2/Q3 of laps.split_qualifying_sessions()) from
 * every driver's pick_fastest() lap of that segment, with
 * frame.t = SessionTime - global_t_min and global_t_min = the earliest
 * telemetry sample = the smallest LapStartTime of those laps
 * (Lap.get_telemetry slices to [LapStartTime, Time] with interpolated edges).
 * The cached lap table has no segment column, so the lap choice is mirrored:
 *  - pick_fastest() keeps only personal-best laps (IsPersonalBest, never set on
 *    a deleted lap). IsPersonalBest is rolling over the whole session, so each
 *    personal best is faster than the previous one: the lap picked in a
 *    segment is the driver's LAST personal best of that segment;
 *  - the segment's drivers are those of its frames, and their laps must carry
 *    the compound and tyre age the frames show for them;
 *  - for each candidate segment end T (the end of a candidate lap), each
 *    driver's lap is their last candidate lap ending by T and starting after
 *    `after`; the T kept is the one whose laps span the segment's max_time
 *    (= global_t_max - global_t_min) most closely.
 * origin = the smallest LapStartTime of the laps kept.
 *
 * Measured error (2024 R8 Q, the cached qualifying replay): Q1 1511.792 s,
 * Q2 2471.405 s, Q3 3846.252 s, identical (0.000 s) to the origins FastF1
 * gives when the extractor's code is run on the raw session; in the frames
 * every driver starts moving within one frame step (0.4 s) after
 * LapStartTime - origin (src/__tests__/replayClockReset.test.js).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times of the qualifying session
 * @param {Object} segment - one /api/frames segment ({frames, max_time})
 * @param {Object} [opts]
 * @param {number} [opts.after=-Infinity] - the segment's laps start after this
 *   session time (the previous segment's last lap end)
 * @returns {{origin: number, end: number, error: number}|null} origin and
 *   end (last lap end) in session seconds, error = |end - origin - max_time|
 *   in seconds; null when no lap set covers every driver of the segment
 */
export function qualiSegmentOrigin(lapTimes, segment, { after = -Infinity } = {}) {
  const frames = segment?.frames;
  if (!Array.isArray(lapTimes) || !Array.isArray(frames) || !frames.length) return null;
  const firstDrivers = frames[0]?.drivers || {};
  const drivers = Object.keys(firstDrivers);
  if (!drivers.length) return null;
  const span = Number.isFinite(Number(segment.max_time))
    ? Number(segment.max_time) : Number(frames[frames.length - 1].t) - Number(frames[0].t);

  const candidates = {};
  for (const drv of drivers) {
    const laps = [];
    for (const r of lapTimes) {
      if (r?.Driver !== drv || r.IsPersonalBest !== true || r.Deleted === true) continue;
      const lapTime = Number(r.LapTimeSeconds ?? r.LapTime);
      const start = lapStartTime(r);
      const end = lapEndTime(r);
      if (!(lapTime > 0) || start == null || end == null || end <= start || start <= after) continue;
      const tyreLife = Number(r.TyreLife);
      laps.push({
        start, end,
        compound: FRAME_COMPOUND_CODES[String(r.Compound || '').toUpperCase()] || 0,
        tyreLife: Number.isFinite(tyreLife) ? tyreLife : null,
      });
    }
    const fd = firstDrivers[drv] || {};
    const code = Number(fd.tyre) || 0;
    const life = Number(fd.tyre_life);
    const sameTyre = laps.filter((c) => (code === 0 || c.compound === code)
      && (!Number.isFinite(life) || c.tyreLife == null || Math.abs(c.tyreLife - life) < 0.05));
    candidates[drv] = sameTyre.length ? sameTyre : laps;
    if (!candidates[drv].length) return null;
  }

  const ends = [...new Set(Object.values(candidates).flat().map((c) => c.end))].sort((a, b) => a - b);
  let best = null;
  for (const T of ends) {
    let origin = Infinity;
    let last = -Infinity;
    let ok = true;
    for (const drv of drivers) {
      let pick = null;
      for (const c of candidates[drv]) {
        if (c.end <= T && (!pick || c.end > pick.end)) pick = c;
      }
      if (!pick) { ok = false; break; }
      if (pick.start < origin) origin = pick.start;
      if (pick.end > last) last = pick.end;
    }
    if (!ok) continue;
    const error = Math.abs(last - origin - span);
    if (!best || error < best.error) best = { origin, end: last, error };
  }
  return best;
}

// A segment origin is kept only when its laps span max_time within this many
// seconds (telemetry edges are interpolated to the lap times, max_time is
// rounded to 0.01 s, so a correct lap set is within a few hundredths)
const QUALI_ORIGIN_TOLERANCE_S = 1;

/**
 * Session-time window of every qualifying segment, in segment order (Q1, Q2,
 * Q3), see qualiSegmentOrigin:
 *  - start:  the segment's laps start after it (the previous segment's last
 *            lap end; -Infinity for the first segment): a lap belongs to the
 *            segment it started in, so a segment's standings rank only them;
 *  - origin: replay time 0 of the segment's frames;
 *  - end:    the end of the segment's last lap, the moment its last frame
 *            stands for (resolveSessionNow `segmentEnd`): the frames are
 *            sampled every frameDt, so a lap may end in the tail after the
 *            last frame (2024 R8 Q3: NOR's 70.542 ends 0.013 s after it).
 * null for a segment whose laps cannot be matched within
 * QUALI_ORIGIN_TOLERANCE_S.
 *
 * @param {Array<Object>} lapTimes
 * @param {Object} segments - /api/frames `segments` ({Q1: {...}, Q2: {...}, Q3: {...}})
 * @returns {Object<string, {start: number, origin: number, end: number}|null>}
 */
export function qualiSegmentWindows(lapTimes, segments) {
  const out = {};
  let after = -Infinity;
  for (const seg of ['Q1', 'Q2', 'Q3']) {
    if (!segments?.[seg]) continue;
    const found = qualiSegmentOrigin(lapTimes, segments[seg], { after });
    out[seg] = found && found.error <= QUALI_ORIGIN_TOLERANCE_S
      ? { start: after, origin: found.origin, end: found.end } : null;
    if (out[seg]) after = found.end;
  }
  return out;
}

/**
 * Replay-time origin (session seconds) of every qualifying segment, in
 * segment order (Q1, Q2, Q3): qualiSegmentWindows' origins. null for a
 * segment whose laps cannot be matched within QUALI_ORIGIN_TOLERANCE_S.
 *
 * @param {Array<Object>} lapTimes
 * @param {Object} segments - /api/frames `segments` ({Q1: {...}, Q2: {...}, Q3: {...}})
 * @returns {Object<string, number|null>}
 */
export function qualiSegmentOffsets(lapTimes, segments) {
  return offsetsOf(qualiSegmentWindows(lapTimes, segments));
}

/** { seg: origin | null } of a qualiSegmentWindows result. */
function offsetsOf(windows) {
  const out = {};
  for (const [seg, w] of Object.entries(windows || {})) out[seg] = w ? w.origin : null;
  return out;
}

/**
 * Replay clock of a qualifying segment at its first frame: the segment's
 * origin as sessionTimeOffset, currentTime of frame 0, lap 1, and the flag in
 * force then. When the origin could not be matched (qualiSegmentOffsets gave
 * null) the session's first lap start is used (computeSessionTimeOffset, the
 * single-offset rule) and a warning is logged.
 *
 * @param {Object} state - store state (sessionData, trackStatus)
 * @param {string} seg - 'Q1' | 'Q2' | 'Q3'
 * @param {Object} segmentData - the segment's frames payload
 * @param {Object|null} offsets - qualiSegmentOffsets output
 * @returns {Object} partial state
 */
function qualiSegmentClock(state, seg, segmentData, offsets) {
  let offset = offsets?.[seg];
  if (offset == null) {
    offset = computeSessionTimeOffset(state.sessionData?.lap_times);
    console.warn(`Qualifying ${seg}: replay origin not matched to the lap table; using the first lap start`);
  }
  const t = Number(segmentData?.frames?.[0]?.t) || 0;
  return {
    sessionTimeOffset: offset,
    currentFrameIndex: 0,
    currentTime: t,
    currentLap: 1,
    currentFlagStatus: flagAtSessionTime(state.trackStatus, t + offset),
  };
}

/* ── Customizable dock ─────────────────────────────────────────── */

export const DOCK_DEFAULTS = [
  'pitwall',
  'laptimes',
  'tyres',
  'strategy',
  'circle',
  'analytics',
  'prediction',
  'racecontrol',
  'championship',
];

export const DOCK_STORAGE_KEY = 'va-dock-items-v1';
// Defaults a stored dock has already been offered. A default added later is
// inserted once into a dock saved before it existed; removing it afterwards
// sticks. Saved together with the dock, so a dock is never marked as offered
// a default it does not hold.
export const DOCK_OFFERED_KEY = 'va-dock-offered-v1';
// Defaults added after docks could be saved (a dock saved with no offered-list predates them)
const DOCK_LATER_DEFAULTS = ['circle'];

function saveDock(items) {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(items));
    localStorage.setItem(DOCK_OFFERED_KEY, JSON.stringify(DOCK_DEFAULTS));
  } catch { /* ignore */ }
}

/** Stored dock plus the defaults it has never been offered, each after the default before it. */
function withNewDockDefaults(items) {
  let offered = null;
  try { offered = JSON.parse(localStorage.getItem(DOCK_OFFERED_KEY) || 'null'); }
  catch { offered = null; }
  if (!Array.isArray(offered)) offered = DOCK_DEFAULTS.filter((id) => !DOCK_LATER_DEFAULTS.includes(id));
  const out = [...items];
  DOCK_DEFAULTS.forEach((id, i) => {
    if (offered.includes(id) || out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(DOCK_DEFAULTS[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, id);
  });
  saveDock(out);
  return out;
}

function loadDockItems() {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    if (!raw) {
      saveDock(DOCK_DEFAULTS);
      return [...DOCK_DEFAULTS];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [...DOCK_DEFAULTS];
    // Silently drop ids that no longer exist in the registry.
    const cleaned = parsed.filter((id) => typeof id === 'string' && SLOT_IDS.has(id));
    return cleaned.length > 0 ? withNewDockDefaults(cleaned) : [...DOCK_DEFAULTS];
  } catch {
    return [...DOCK_DEFAULTS];
  }
}

/* ── Docked layout tree helpers ────────────────────────────────── */

const MAX_PANES = 4;

/** Count leaf panes in the tree */
function _countPanes(node) {
  if (!node) return 0;
  if (!node.children) return 1;
  return _countPanes(node.children[0]) + _countPanes(node.children[1]);
}

/** Collect all tab IDs from every leaf pane in the layout tree */
function _collectDockedTabs(node) {
  if (!node) return [];
  if (!node.children) return node.tabs || [];
  return [..._collectDockedTabs(node.children[0]), ..._collectDockedTabs(node.children[1])];
}

/** Activate a tab in the pane that contains it (set activeTab) */
function _activateTabInTree(node, tabId) {
  if (!node) return node;
  if (!node.children) {
    if (node.tabs && node.tabs.includes(tabId)) {
      return { ...node, activeTab: tabId };
    }
    return node;
  }
  return {
    ...node,
    children: [
      _activateTabInTree(node.children[0], tabId),
      _activateTabInTree(node.children[1], tabId),
    ],
  };
}

/** Append a new single-tab pane to the tree without rebuilding existing panes */
function _appendPane(node, tabId) {
  const newLeaf = { tabs: [tabId], activeTab: tabId };
  // Alternate split direction from the root
  const dir = (node.children && node.direction === 'horizontal') ? 'vertical' : 'horizontal';
  const panes = _countPanes(node);
  // Give existing content proportional space, new pane gets 1/(n+1)
  const ratio = panes / (panes + 1);
  return { direction: dir, ratio, children: [node, newLeaf] };
}

/** Add a tab to the first leaf pane found (depth-first) and activate it */
function _addTabToFirstLeaf(node, tabId) {
  if (!node) return node;
  if (!node.children) {
    // This is a leaf — add the tab here
    return { ...node, tabs: [...(node.tabs || []), tabId], activeTab: tabId };
  }
  // Recurse into first child only (so tab goes to top-left pane)
  return {
    ...node,
    children: [
      _addTabToFirstLeaf(node.children[0], tabId),
      node.children[1],
    ],
  };
}

/** Remove a tab from the entire tree. If a pane becomes empty, collapse the split. */
function _removeTabFromTree(node, tabId) {
  if (!node) return node;
  if (!node.children) {
    // Leaf node
    const newTabs = (node.tabs || []).filter((t) => t !== tabId);
    if (newTabs.length === 0) return null; // pane is empty — signal removal
    return { ...node, tabs: newTabs, activeTab: node.activeTab === tabId ? newTabs[0] : node.activeTab };
  }
  // Split node — recurse
  let left = _removeTabFromTree(node.children[0], tabId);
  let right = _removeTabFromTree(node.children[1], tabId);
  // If one child was emptied, collapse to the other
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

/**
 * Group an array of tab IDs into at most MAX_PANES pane groups.
 * Each group becomes a single pane with multiple tabs.
 */
function _groupTabs(tabIds) {
  if (tabIds.length <= MAX_PANES) {
    return tabIds.map((id) => [id]);
  }
  // Distribute tabs into MAX_PANES groups as evenly as possible
  const groups = Array.from({ length: MAX_PANES }, () => []);
  tabIds.forEach((id, i) => groups[i % MAX_PANES].push(id));
  return groups;
}

/**
 * Build a docked layout tree from an array of tab IDs.
 * Caps at MAX_PANES panes — excess tabs are grouped into shared panes.
 * Generates different arrangements based on `variant` index:
 *   0 = balanced grid (2-col rows)
 *   1 = all horizontal (side by side columns)
 *   2 = all vertical (stacked rows)
 *   3 = main + sidebar (first pane big, rest stacked on right)
 */
function _buildDockedTree(tabIds, variant = 0) {
  if (tabIds.length === 0) return null;
  if (tabIds.length === 1) {
    return { tabs: [tabIds[0]], activeTab: tabIds[0] };
  }

  // Group tabs into at most MAX_PANES panes
  const groups = _groupTabs(tabIds);
  const pane = (g) => ({ tabs: g, activeTab: g[0] });
  const n = groups.length;
  // n is guaranteed <= MAX_PANES (4)

  const effectiveVariant = variant % 4;

  if (n === 1) return pane(groups[0]);

  if (n === 2) {
    const dir = effectiveVariant === 2 ? 'vertical' : 'horizontal';
    return { direction: dir, ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] };
  }

  if (n === 3) {
    if (effectiveVariant === 1) {
      // 3 columns
      return {
        direction: 'horizontal', ratio: 0.33,
        children: [
          pane(groups[0]),
          { direction: 'horizontal', ratio: 0.5, children: [pane(groups[1]), pane(groups[2])] },
        ],
      };
    }
    if (effectiveVariant === 2) {
      // 3 rows
      return {
        direction: 'vertical', ratio: 0.33,
        children: [
          pane(groups[0]),
          { direction: 'vertical', ratio: 0.5, children: [pane(groups[1]), pane(groups[2])] },
        ],
      };
    }
    if (effectiveVariant === 3) {
      // Main + sidebar (2 stacked)
      return {
        direction: 'horizontal', ratio: 0.6,
        children: [
          pane(groups[0]),
          { direction: 'vertical', ratio: 0.5, children: [pane(groups[1]), pane(groups[2])] },
        ],
      };
    }
    // Variant 0: top row of 2 + bottom
    return {
      direction: 'vertical', ratio: 0.5,
      children: [
        { direction: 'horizontal', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
        pane(groups[2]),
      ],
    };
  }

  // n === 4
  if (effectiveVariant === 1) {
    // 4 columns
    return {
      direction: 'horizontal', ratio: 0.5,
      children: [
        { direction: 'horizontal', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
        { direction: 'horizontal', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
      ],
    };
  }
  if (effectiveVariant === 2) {
    // 4 rows
    return {
      direction: 'vertical', ratio: 0.5,
      children: [
        { direction: 'vertical', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
        { direction: 'vertical', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
      ],
    };
  }
  if (effectiveVariant === 3) {
    // Main + 3 stacked on right
    return {
      direction: 'horizontal', ratio: 0.5,
      children: [
        pane(groups[0]),
        { direction: 'vertical', ratio: 0.33,
          children: [
            pane(groups[1]),
            { direction: 'vertical', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
          ],
        },
      ],
    };
  }
  // Variant 0: 2x2 grid
  return {
    direction: 'vertical', ratio: 0.5,
    children: [
      { direction: 'horizontal', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
      { direction: 'horizontal', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
    ],
  };
}

const ARRANGE_LAYOUTS = {
  1: [
    (ids) => ({ [ids[0]]: { left: '0%', top: '0%', width: '100%', height: '100%' } }),
  ],
  2: [
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '100%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '100%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '100%', height: '50%' },
      [ids[1]]: { left: '0%', top: '50%', width: '100%', height: '50%' },
    }),
  ],
  3: [
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '100%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '50%' },
      [ids[2]]: { left: '50%', top: '50%', width: '50%', height: '50%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '33.33%', height: '100%' },
      [ids[1]]: { left: '33.33%', top: '0%', width: '33.34%', height: '100%' },
      [ids[2]]: { left: '66.67%', top: '0%', width: '33.33%', height: '100%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '50%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '50%' },
      [ids[2]]: { left: '0%', top: '50%', width: '100%', height: '50%' },
    }),
  ],
  4: [
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '50%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '50%' },
      [ids[2]]: { left: '0%', top: '50%', width: '50%', height: '50%' },
      [ids[3]]: { left: '50%', top: '50%', width: '50%', height: '50%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '100%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '33.33%' },
      [ids[2]]: { left: '50%', top: '33.33%', width: '50%', height: '33.34%' },
      [ids[3]]: { left: '50%', top: '66.67%', width: '50%', height: '33.33%' },
    }),
  ],
};

function autoGridLayout(ids) {
  const n = ids.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const tiles = {};
  ids.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    tiles[id] = {
      left: `${(col / cols) * 100}%`,
      top: `${(row / rows) * 100}%`,
      width: `${100 / cols}%`,
      height: `${100 / rows}%`,
    };
  });
  return tiles;
}

// Module-level dedup for schedule fetch (immune to store/middleware timing)
let _schedulePromise = null;
let _scheduleYear = null;

// Latest request of each selector fetch that is not scoped to a loaded
// session (schedule, driver preview, championship, seasons): an answer that
// arrives after a newer request of the same kind was made is dropped, so a
// slow answer for an earlier pick never replaces the current one (D7)
const _latestRequest = { schedule: 0, preview: 0, championship: 0, seasons: 0 };

// Module-level generation counter for loadSession to prevent stale async
// responses. Every switch of what the dashboard shows (a session load, entering
// or leaving live mode, the reset to the selector) starts a new generation, so
// a historical load still in flight (its frames, circuit, strategy, analytics)
// can never land on the session that replaced it.
let _sessionLoadGeneration = 0;

// What the dashboard SHOWS, as a counter: it moves on in the same set() as
// every commit that puts another screen on (loadSession, enterLiveMode,
// exitLiveMode, resetSession: screenSwitchState) and when loadSession leaves
// live mode at its start. _sessionLoadGeneration moves when a switch STARTS
// and screenKeyOf is the same for a reload of the race on screen and for a
// mock live race and its replay; this counter tells a request sent while a
// load was in flight (the previous screen still on) from one sent after it
// landed.
let _screenGeneration = 0;

/**
 * Partial state of a commit that puts another screen on: moves the screen
 * generation on (so every answer to a request of the previous screen is
 * dropped, sessionRequestGuard) and clears what belonged to the previous
 * screen: the telemetry spinner of requests that can no longer land, and the
 * lap range (D8): laps of one race never filter the next (the Timing Sheet
 * rows and title, the Position Tracker brush, the Strategy Timeline band, the
 * Tyre Degradation fit).
 *
 * @returns {Object} partial state
 */
function screenSwitchState() {
  _screenGeneration += 1;
  return {
    telemetryLoading: false, selectedLapRange: null, brushLapRange: null,
  };
}

/**
 * Guard of one async request scoped to the session on screen (D7): taken when
 * the request is sent, the function it returns is true while the answer still
 * belongs to what the dashboard shows. The session-load generation alone is
 * not enough: loadSession and enterLiveMode bump it when they START, and the
 * previous session stays on screen and interactive (brush, playback, focus)
 * until they commit, so a request sent in between carries the new generation
 * with the old session. The guard also holds what was on screen (the screen
 * generation, and screenKeyOf: replay or live, and the session) and drops the
 * answer once any of them changed.
 *
 * @param {function(): Object} get - the store's get
 * @returns {function(): boolean}
 */
function sessionRequestGuard(get) {
  const generation = _sessionLoadGeneration;
  const screenGeneration = _screenGeneration;
  const screen = screenKeyOf(get());
  return () => generation === _sessionLoadGeneration && screenGeneration === _screenGeneration
    && screenKeyOf(get()) === screen;
}

// Telemetry requests in flight, as their guards (sessionRequestGuard):
// telemetryLoading is true while one of them still belongs to the screen on
// screen, so the answer of a previous session's request never turns off the
// spinner of the new session's own request
const _telemetryInFlight = new Set();

function telemetryLoadingNow() {
  for (const current of _telemetryInFlight) if (current()) return true;
  return false;
}

// Generation counter for degradation requests: a replay re-request must not be
// overwritten by an older response that arrives late.
let _degradationGeneration = 0;

// Lap-time forecast requests (triggerPrediction, utils/forecast.js): only the
// latest one may land, and a focus change or a session switch moves the
// counter on, so an answer for the previous focus driver or session is dropped
let _forecastSeq = 0;

/**
 * Partial state that clears the lap-time forecast (store.lstmPredictions,
 * its clock, the trigger shown and the spinner) and drops every forecast
 * request still in flight: on a focus change and on every session switch.
 *
 * @returns {Object} partial state
 */
function forecastReset() {
  _forecastSeq += 1;
  return { lstmPredictions: null, _lstmAt: null, lastPredictionTrigger: null, predictionLoading: false };
}

// Pending re-request of the brushed degradation fit (refreshDegradationRegression):
// once its inputs (brushFitKey) change, the replay re-asks within
// DEGRADATION_REFRESH_MS, with the clock of that moment, so playback and a
// drag on the timeline send at most one request per interval, not one per
// frame (D6). A UI rate limit, not a model parameter.
let _degradationRefreshTimer = null;
const DEGRADATION_REFRESH_MS = 150;

function cancelDegradationRefresh() {
  if (_degradationRefreshTimer != null) clearTimeout(_degradationRefreshTimer);
  _degradationRefreshTimer = null;
}

// Live rebuilds from a snapshot (D14): a session_init of a reconnect, or the
// snapshot asked after a 'resync'. Each applied rebuild bumps the counter, so
// a snapshot asked earlier and answered after a newer rebuild is dropped.
let _liveRebuildSeq = 0;

// Pending recompute of the clock-derived analytics after a clock jump (seek):
// a drag on the timeline jumps many times, the analytics follow once it settles
let _clockJumpTimer = null;
const CLOCK_JUMP_SETTLE_MS = 120;

// The replay clock of a session that is not playing yet (no frames): every
// session load / reset / live switch starts from here, so getSessionNow never
// adds the previous session's replay time to the new offset.
const REPLAY_CLOCK_RESET = Object.freeze({
  currentTime: 0,
  maxTime: 0,
  frameDt: 0.4,
  currentFrameIndex: 0,
  totalFrames: 0,
  frameData: null,
  lapFrameMap: null,
  qualiSegmentOffsets: null,
  qualiSegmentWindows: null,
  lapModeRaceOver: false,
});

function cancelClockJump() {
  if (_clockJumpTimer != null) clearTimeout(_clockJumpTimer);
  _clockJumpTimer = null;
}

/**
 * store.dnfMap of a results table: the drivers whose ClassifiedPosition is
 * R (retired), D (disqualified), E (excluded), W (withdrawn) or N (not
 * classified), as { abbr: { status, lastLap, classifiedPosition } }.
 *
 * @param {Array<Object>} results - race_results
 * @param {number} maxLap - lastLap when the results give no Laps
 * @returns {Object}
 */
function dnfMapFromResults(results, maxLap) {
  const dnfMap = {};
  for (const r of results || []) {
    const abbr = r?.Abbreviation;
    if (!abbr) continue;
    const cp = String(r.ClassifiedPosition || '');
    if (cp === 'R' || cp === 'D' || cp === 'E' || cp === 'W' || cp === 'N') {
      dnfMap[abbr] = { status: r.Status || 'Retired', lastLap: r.Laps || maxLap, classifiedPosition: cp };
    }
  }
  return dnfMap;
}

/**
 * Store fields of a live snapshot (GET /api/live/snapshot, or the `session`
 * of a session_init message, the same payload) with the live status (GET
 * /api/live/status, or the session_init `status`): rows, clock offset,
 * drivers, track status and the flag in force, race-control messages,
 * radios, lap counters and the retirements the feed reports
 * (driver_statuses Retired / Stopped / KnockedOut; D8: while the race runs
 * no retirement is inferred from the rows). Shared by enterLiveMode and the
 * rebuild after a resync or a reconnect (D14).
 *
 * @param {Object} snapshot
 * @param {Object} [status]
 * @returns {Object} partial state
 */
function liveSnapshotState(snapshot, status = {}) {
  const lapTimes = snapshot?.lap_times || [];
  let computedMaxLap = 1;
  for (const lt of lapTimes) {
    if (lt.LapNumber && lt.LapNumber > computedMaxLap) computedMaxLap = lt.LapNumber;
  }
  // Already-retired drivers show as DNF the moment a viewer connects mid-race
  const dnfMap = {};
  for (const ds of snapshot?.driver_statuses || []) {
    if (!ds?.Driver) continue;
    if (ds.Retired || ds.Stopped || ds.KnockedOut) {
      dnfMap[ds.Driver] = {
        status: ds.Status || (ds.Retired ? 'Retired' : ds.Stopped ? 'Stopped' : 'Out'),
        lastLap: ds.LastLap ?? status?.current_lap ?? computedMaxLap,
        classifiedPosition: 'R',
      };
    }
  }
  const trackStatus = snapshot?.track_status || [];
  return {
    sessionData: snapshot,
    sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    drivers: snapshot?.driver_info || [],
    trackStatus,
    // The feed's latest track status (the flag in force when the snapshot was taken)
    currentFlagStatus: String(trackStatus[trackStatus.length - 1]?.status || '1'),
    raceControlMessages: snapshot?.race_control_messages || [],
    teamRadios: snapshot?.team_radios || [],
    maxLap: computedMaxLap,
    currentLap: status?.current_lap || computedMaxLap,
    totalRaceLaps: status?.total_laps || null,
    dnfMap,
  };
}

/** Leader lap of a replay frame: the highest lap among its drivers (at least 1). */
function frameLeaderLap(frame) {
  let lap = 1;
  for (const d of Object.values(frame?.drivers || {})) {
    if (d.lap > lap) lap = d.lap;
  }
  return lap;
}

export const useF1Store = create(persist((set, get) => ({
  // ── Session ─────────────────────────────────────────────────────
  year: 2024,
  round: null,
  sessionType: 'R',      // the session-type pill: what the NEXT load fetches
  // Type of the session in sessionData (set by loadSession). Views gate on
  // this, never on the pill, which changes without loading anything.
  loadedSessionType: null,
  // Year and round of the session in sessionData (set by loadSession with
  // loadedSessionType): every request scoped to the session on screen uses
  // them (sessionScopeOf), never the year / round pills (D7)
  loadedYear: null,
  loadedRound: null,
  // Live mock replay on screen: { year, round } of the replayed race, else null
  liveMockSession: null,
  schedule: [],
  scheduleYear: null,    // the season `schedule` lists
  // Selectable seasons, newest first: GET /api/seasons (fetchSeasons), the
  // previous hard-coded list until it answers or when it cannot (D15)
  seasons: [...FALLBACK_SEASONS],
  sessionData: null,
  // Session seconds at replay time 0 (session time = frame.t + offset), see
  // utils/raceTime.js. Recomputed whenever sessionData.lap_times changes.
  sessionTimeOffset: 0,
  drivers: [],
  circuitInfo: null,
  isLoading: false,
  isLoadingFrames: false,
  error: null,
  trackStatus: [],       // [{status, start_time, end_time, message}]
  currentFlagStatus: '1', // '1'=green, '2'=yellow, '4'=SC, '5'=red, '6'/'7'=VSC
  dnfMap: {},            // { driverAbbr: { status: 'Crash', lastLap: 45 } }

  // ── Live Mode ──────────────────────────────────────────────────
  isLiveMode: false,
  liveConnected: false,          // WebSocket connected
  liveSessionInfo: null,         // {event_name, session_type, ...}
  liveConnectionStatus: 'disconnected', // 'connected'|'disconnected'|'reconnecting'
  liveStandings: null,           // driver standings from live position updates
  raceControlMessages: [],       // live race control messages
  teamRadios: [],                // live team-radio captures (audio URLs)

  // ── Team-radio PiP / autoplay ────────────────────────────────────
  // Master toggle for the floating radio popup that appears anywhere in
  // the app. When ON, new radios for the *selected* drivers (fall back
  // to focusDriver) auto-play through a single shared <audio> element
  // owned by RadioPipToast.
  radioAutoplay: (() => {
    try { return localStorage.getItem('va-radio-autoplay-v2') === '1'; }
    catch { return false; }
  })(),
  setRadioAutoplay: (on) => {
    try { localStorage.setItem('va-radio-autoplay-v2', on ? '1' : '0'); }
    catch { /* ignore */ }
    set({ radioAutoplay: !!on });
  },
  toggleRadioAutoplay: () => set((s) => {
    const next = !s.radioAutoplay;
    try { localStorage.setItem('va-radio-autoplay-v2', next ? '1' : '0'); }
    catch { /* ignore */ }
    return { radioAutoplay: next };
  }),
  totalRaceLaps: null,           // total laps in the race (from lap_count)
  liveTelemetry: {},             // {DRIVER: {speed, throttle, brake, gear, rpm, drs, updated}}

  // ── Qualifying replay ──────────────────────────────────────────
  qualiSegments: null,     // {Q1: {frames, driver_colors, ...}, Q2: {...}, Q3: {...}}
  qualiSegment: 'Q3',     // Active segment
  isQualifyingReplay: false,

  // ── Pre-session driver preview (selector screen) ──────────────
  previewDrivers: [],          // drivers fetched before full session load
  previewDriversLoading: false,
  preSelectedDrivers: [],      // drivers toggled on selector screen

  // ── Help overlay (per-chart docs) ─────────────────────────────
  helpTabId: null,
  helpTitle: null,
  openHelp: (tabId, title = null) => set({ helpTabId: tabId || null, helpTitle: title || null }),
  closeHelp: () => set({ helpTabId: null, helpTitle: null }),

  // ── Toast / notification stack ────────────────────────────────
  // { id, kind: 'info'|'warn'|'error'|'undo', message, action?, actionLabel?, timeout? }
  toasts: [],
  pushToast: (toast) => {
    const id = toast.id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry = { id, kind: 'info', timeout: 5000, ...toast };
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== id), entry] }));
    if (entry.timeout > 0) {
      setTimeout(() => {
        const cur = get().toasts;
        if (cur.some((t) => t.id === id)) {
          set({ toasts: cur.filter((t) => t.id !== id) });
        }
      }, entry.timeout);
    }
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  /** Ctrl/Cmd+Z: run the newest Undo toast still on screen (a closed layout,
   *  a dock change) and dismiss it. False when none is shown. */
  undoLastChange: () => {
    const toast = [...get().toasts].reverse().find((t) => t.kind === 'undo' && typeof t.action === 'function');
    if (!toast) return false;
    get().dismissToast(toast.id);
    try { toast.action(); } catch { /* no-op, as the toast's button */ }
    return true;
  },
  clearToasts: () => set({ toasts: [] }),

  // ── Backend reachability (for the global status banner) ───────
  backendHealthy: true,
  lastBackendError: null,
  reportBackendError: (message) => {
    set({ backendHealthy: false, lastBackendError: message });
    get().pushToast({
      id: 'backend-down',
      kind: 'error',
      message: `Backend unreachable (${message || 'network error'}). Panels may show stale data.`,
      actionLabel: 'Retry',
      timeout: 0,
      action: () => {
        // Cheap health probe — any successful fetch flips backendHealthy back
        // via the axios response interceptor.
        const y = get().year;
        if (y) api.getSchedule(y).catch(() => {});
      },
    });
  },
  reportBackendOk: () => {
    const s = get();
    if (!s.backendHealthy) {
      set({ backendHealthy: true, lastBackendError: null });
      s.dismissToast('backend-down');
      s.pushToast({ kind: 'info', message: 'Backend reconnected', timeout: 3000 });
    }
  },

  setYear: (year) => set({ year }),
  setRound: (round) => set({ round }),
  setSessionType: (sessionType) => set({ sessionType }),

  fetchSchedule: async (year) => {
    // Return existing promise if already fetching this year
    if (_scheduleYear === year && _schedulePromise) return _schedulePromise;
    // The latest pick of the season: an answer for an earlier pick still in
    // flight is dropped from here on, also when this one needs no request
    const request = ++_latestRequest.schedule;
    // Skip if the schedule of this year is already loaded (scheduleYear: the
    // year pill changes before the schedule of the new year is asked)
    const s = get();
    if (s.schedule.length > 0 && s.scheduleYear === year) return;
    _scheduleYear = year;
    const promise = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.getSchedule(year);
          if (request !== _latestRequest.schedule) return;
          set({ schedule: data.events || [], scheduleYear: year, year });
          return;
        } catch (e) {
          if (request !== _latestRequest.schedule) return;
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            continue;
          }
          console.error('Failed to fetch schedule', e);
        }
      }
    })();
    _schedulePromise = promise;
    promise.finally(() => {
      if (_schedulePromise === promise) { _schedulePromise = null; _scheduleYear = null; }
    });
    return promise;
  },

  // Selectable seasons from GET /api/seasons, newest first; on failure the
  // list stays as it is (FALLBACK_SEASONS until the backend answers once)
  fetchSeasons: async () => {
    const request = ++_latestRequest.seasons;
    try {
      const data = await api.getSeasons();
      if (request !== _latestRequest.seasons) return;
      set({ seasons: seasonsFromResponse(data) });
    } catch (e) {
      console.warn('Failed to fetch seasons; using the built-in list', e);
    }
  },

  fetchDriversPreview: async (year, round) => {
    if (!year || !round) return;
    // An answer for an earlier pick (another race) is dropped
    const request = ++_latestRequest.preview;
    set({ previewDriversLoading: true, previewDrivers: [], preSelectedDrivers: [] });
    try {
      const data = await api.getDrivers(year, round);
      if (request !== _latestRequest.preview) return;
      set({ previewDrivers: data.drivers || [], previewDriversLoading: false });
    } catch (e) {
      if (request !== _latestRequest.preview) return;
      console.warn('Failed to fetch driver preview', e);
      set({ previewDriversLoading: false });
    }
  },

  togglePreSelectedDriver: (abbr) =>
    set((s) => {
      const sel = s.preSelectedDrivers.includes(abbr)
        ? s.preSelectedDrivers.filter((d) => d !== abbr)
        : [...s.preSelectedDrivers, abbr];
      return { preSelectedDrivers: sel };
    }),

  setPreSelectedDrivers: (list) => set({ preSelectedDrivers: list }),

  loadSession: async () => {
    const { year, round, sessionType } = get();
    if (!year || !round) return;

    // Increment generation counter to invalidate any in-flight loads, before
    // anything is awaited: a live entry still in flight (its snapshot, full
    // session, feed connection) or a live message is discarded from here on,
    // so none of them can land on this load or undo its clock reset
    const generation = ++_sessionLoadGeneration;
    cancelClockJump();
    cancelDegradationRefresh();

    // If switching from live mode, disconnect first
    if (get().isLiveMode) {
      // Out of live mode at once, with the replay clock reset (the feed's
      // frames are not this session's). The live rows stay on screen until the
      // new session lands, so the type of the session on screen is the live
      // one (R7 gates on it), never the pill being loaded; likewise its
      // identity (a mock replay's race, else none: sessionScopeOf). The
      // screen is no longer the live one: an answer to a live request is
      // dropped from here on (the screen generation; the replay of the same
      // race has the same screenKeyOf)
      const mock = get().liveMockSession;
      _screenGeneration += 1;
      set({
        isLiveMode: false,
        loadedSessionType: viewSessionType(get()),
        loadedYear: mock?.year ?? null,
        loadedRound: mock?.round ?? null,
        liveMockSession: null,
        liveConnected: false,
        liveSessionInfo: null,
        liveConnectionStatus: 'disconnected',
        liveStandings: null,
        raceControlMessages: [],
        teamRadios: [],
        totalRaceLaps: null,
        liveTelemetry: {},
        isPlaying: false,
        ...REPLAY_CLOCK_RESET,
      });
      try {
        const { liveWS } = await import('../utils/liveWebSocket');
        liveWS.disconnect();
        await api.stopMockReplay().catch(() => {});
      } catch (_) { /* ignore */ }
      if (generation !== _sessionLoadGeneration) return;
    }

    set({ isLoading: true, error: null });
    try {
      const data = await api.getSession(year, round, sessionType);

      // If another loadSession was triggered while we waited, discard this result
      if (generation !== _sessionLoadGeneration) return;

      // Compute maxLap from lap_times data
      const lapTimes = data.lap_times || [];
      let computedMaxLap = 1;
      for (const lt of lapTimes) {
        if (lt.LapNumber && lt.LapNumber > computedMaxLap) {
          computedMaxLap = lt.LapNumber;
        }
      }

      // Build DNF map from race_results
      const dnfMap = dnfMapFromResults(data.race_results, computedMaxLap);

      // Apply pre-selected drivers if any
      const preSelected = get().preSelectedDrivers;

      // Refresh the live driver→team-colour map from this session's
      // driver_info so per-driver colours track the actual lineup
      // (e.g. HAM = Ferrari red in 2025, not the static Mercedes teal).
      setSessionDriverColors(data.driver_info || []);

      const sessionTimeOffset = computeSessionTimeOffset(lapTimes);
      // The previous screen's cross-race PCA answers go (pcaScreenReset) and
      // are asked again for this one right after
      const before = get();
      const pcaReset = pcaScreenReset(before);
      set({
        // Another screen: requests of the previous one are dropped, what was
        // said about it goes (screenSwitchState)
        ...screenSwitchState(),
        sessionData: data,
        loadedSessionType: sessionType,
        loadedYear: year,
        loadedRound: round,
        liveMockSession: null,
        sessionTimeOffset,
        drivers: data.driver_info || [],
        trackStatus: data.track_status || [],
        // Flag at the race start (replay time 0 = sessionTimeOffset)
        currentFlagStatus: flagAtSessionTime(data.track_status || [], sessionTimeOffset),
        _degradationRequest: null,
        dnfMap,
        maxLap: computedMaxLap,
        currentLap: 1,
        isPlaying: false,
        // Replay clock of the previous session: never carried over (the new
        // session starts at its race start until its frames load)
        ...REPLAY_CLOCK_RESET,
        telemetryCache: {},
        telemetryCompareLaps: [],
        sectorRankings: null,
        consistencyData: null,
        speedRankings: null,
        // The previous session's track and positions: this session's own
        // arrive below (getCircuit, loadPositions)
        circuitInfo: null,
        positionData: null,
        // Reset race situation state from previous session
        raceSituationLap: null,
        raceSituationData: null,
        raceProjection: null,
        simulatorStrategy: null, simulatorResult: null, simulatorComparisons: [], simulatorBaseline: null,
        isSimulatorActive: false,
        _prevPcaResult: null,
        // The forecast and its requests in flight go (forecastReset)
        ...forecastReset(),
        rivalContext: [],
        _rivalContextAt: null,
        degradationRegression: null,
        // Clear qualifying state from previous session
        qualiSegments: null,
        qualiSegment: 'Q3',
        isQualifyingReplay: false,
        ...pcaReset,
        ...(preSelected.length > 0 ? { selectedDrivers: preSelected } : {}),
      });
      refetchDroppedPCA(get, pcaReset, before);

      // Load circuit, strategy, frames, and analytics in parallel
      // For qualifying: skip strategy (irrelevant), load frames eagerly
      const current = () => generation === _sessionLoadGeneration;
      const parallelTasks = [
        api.getCircuit(year, round).then((circuit) => { if (current()) set({ circuitInfo: circuit }); }),
      ];

      if (sessionType !== 'Q') {
        parallelTasks.push(
          api.getStrategy(year, round, sessionType)
            .then((strategy) => {
              if (!current()) return;
              set((s) => ({
                sessionData: { ...s.sessionData, strategies: strategy.strategies || [] },
              }));
            })
            .catch((e) => console.warn('Strategy data not available', e))
        );
      }

      if (sessionType === 'R' || sessionType === 'S' || sessionType === 'Q') {
        console.log(`Session loaded (${sessionType}): ${computedMaxLap} laps. Loading frames in background...`);
        parallelTasks.push(get().loadFrames());
      } else {
        console.log(`Session loaded (${sessionType}): ${computedMaxLap} laps. Skipping frame loading.`);
      }

      parallelTasks.push(get().fetchAnalytics());

      await Promise.allSettled(parallelTasks);
      // Only clear loading if this is still the active session load
      if (generation === _sessionLoadGeneration) {
        set({ isLoading: false });
      }

    } catch (e) {
      // A failure of a load that has since been replaced is not this session's
      if (generation !== _sessionLoadGeneration) return;
      set({ isLoading: false, error: e.message });
      console.error('Failed to load session', e);
    }
  },

  // ── Live Mode Actions ──────────────────────────────────────────

  enterLiveMode: async (mockYear, mockRound, mockSpeed) => {
    // A new generation: a historical load still in flight is discarded, and a
    // later load / reset / live switch discards this one
    const generation = ++_sessionLoadGeneration;
    const superseded = () => generation !== _sessionLoadGeneration;
    const { liveWS: _liveWSRef } = await import('../utils/liveWebSocket');
    const liveWS = _liveWSRef ?? (await import('../utils/liveWebSocket')).liveWS;
    if (superseded()) return;

    set({ isLoading: true, error: null });
    try {
      // If mock parameters provided, start mock replay first
      if (mockYear && mockRound) {
        await api.startMockReplay(mockYear, mockRound, mockSpeed || 10);
        // Give the mock replay a moment to initialize
        await new Promise((r) => setTimeout(r, 500));
        if (superseded()) return;
      }

      // Get live status — if not active, try connecting SignalR first
      let status = await api.getLiveStatus();
      if (superseded()) return;
      if (!status.active && !mockYear) {
        // Attempt to connect to F1 live timing
        try {
          await api.connectSignalR();
          // Wait for connection and initial data
          await new Promise((r) => setTimeout(r, 3000));
          status = await api.getLiveStatus();
        } catch (_) { /* ignore */ }
        if (superseded()) return;
        if (!status.active) {
          set({ isLoading: false, error: 'No active F1 session. SignalR connection failed or no session running.' });
          return;
        }
      }

      // Get full snapshot
      const snapshot = await api.getLiveSnapshot();
      if (superseded()) return;

      // Load circuit info if available
      let circuitInfo = snapshot.circuit_info || null;
      // If circuit_info exists but has no track_coordinates, it's metadata only
      if (circuitInfo && !circuitInfo.track_coordinates) {
        circuitInfo = null;
      }

      // Live mode: same dynamic colour-map refresh.
      setSessionDriverColors(snapshot.driver_info || []);

      cancelClockJump();
      cancelDegradationRefresh();
      // The previous screen's cross-race PCA answers (pcaScreenReset)
      const pcaBefore = get();
      const pcaReset = pcaScreenReset(pcaBefore);
      set({
        ...screenSwitchState(),
        ...pcaReset,
        isLiveMode: true,
        liveSessionInfo: status.session_info || null,
        // Rows, clock offset, flag, lap counters and the feed's retirements
        ...liveSnapshotState(snapshot, status),
        loadedSessionType: null, // live: the feed's SessionInfo gives the type
        loadedYear: null,
        loadedRound: null,
        liveMockSession: mockYear && mockRound ? { year: Number(mockYear), round: Number(mockRound) } : null,
        _liveFullSession: false,
        _degradationRequest: null,
        isPlaying: false,
        ...REPLAY_CLOCK_RESET,
        isLoadingFrames: false,
        circuitInfo,
        telemetryCache: {},
        positionData: null,
        ...forecastReset(),
        rivalContext: [],
        _rivalContextAt: null,
        degradationRegression: null,
        raceSituationLap: null,
        raceSituationData: null,
        raceProjection: null,
        simulatorResult: null,
        _prevPcaResult: null,
        qualiSegments: null,
        isQualifyingReplay: false,
      });
      refetchDroppedPCA(get, pcaReset, pcaBefore);

      // If no track coordinates in snapshot, try loading from cached session
      if (!circuitInfo && mockYear && mockRound) {
        try {
          const cached = await api.getCircuit(mockYear, mockRound);
          if (!superseded() && cached?.track_coordinates?.length) {
            set({ circuitInfo: cached });
          }
        } catch (_) { /* ignore — track map just won't show */ }
      }

      // If session has already ended, load full data from FastF1
      // (SignalR snapshot only has current state, not full lap history)
      const sessionStatus = status.session_status || '';
      const isFinished = ['Ends', 'Finished', 'Finalised'].includes(sessionStatus);
      if (isFinished) {
        try {
          console.log('Session finished — loading full data from FastF1...');
          const fullData = await api.loadLiveFullSession();
          if (superseded()) return;
          if (fullData && fullData.lap_times?.length > 0 && !fullData.error) {
            const fullLapTimes = fullData.lap_times;
            let fullMaxLap = 1;
            for (const lt of fullLapTimes) {
              if (lt.LapNumber && lt.LapNumber > fullMaxLap) fullMaxLap = lt.LapNumber;
            }
            const fullCircuitInfo = fullData.circuit_info?.track_coordinates
              ? fullData.circuit_info : get().circuitInfo;
            if (fullData.driver_info) setSessionDriverColors(fullData.driver_info);
            set({
              sessionData: fullData,
              sessionTimeOffset: computeSessionTimeOffset(fullLapTimes),
              drivers: fullData.driver_info || get().drivers,
              trackStatus: fullData.track_status || get().trackStatus,
              maxLap: fullMaxLap,
              currentLap: fullMaxLap,
              circuitInfo: fullCircuitInfo,
              // The session is over: its classification is explicit
              // retirement data (D8), added to the feed's retirements
              dnfMap: { ...get().dnfMap, ...dnfMapFromResults(fullData.race_results, fullMaxLap) },
              // the feed's snapshot (a session_init) must not replace these rows
              _liveFullSession: true,
            });
            console.log(`Full session loaded: ${fullLapTimes.length} lap entries, ${fullMaxLap} laps`);
          }
        } catch (e) {
          console.warn('Could not load full session data:', e.message);
        }
      }

      // Connect WebSocket for incremental updates. Its messages belong to this
      // live entry only: once a load / reset / live switch has replaced it
      // (new generation), a message still delivered is dropped, never applied
      // to the session on screen (its frames, lap count, flag)
      if (superseded()) return;
      liveWS.connect(
        (msg) => { if (!superseded()) get()._handleLiveMessage(msg); },
        (statusVal) => {
          if (superseded()) return;
          set({
            liveConnected: statusVal === 'connected',
            liveConnectionStatus: statusVal,
          });
        },
      );

      set({ isLoading: false });
    } catch (e) {
      if (superseded()) return;
      // The backend's message when it sent one (a status code with a generic
      // text, e.g. no cached session for the mock replay), else axios's
      const detail = e.response?.data?.detail;
      set({ isLoading: false, error: typeof detail === 'string' ? detail : e.message });
      console.error('Failed to enter live mode', e);
    }
  },

  exitLiveMode: async () => {
    // Nothing still in flight (a live entry, an older historical load) may
    // land after the exit
    const generation = ++_sessionLoadGeneration;
    const { liveWS } = await import('../utils/liveWebSocket');
    // a newer load / live entry handles the feed itself from here on
    if (generation !== _sessionLoadGeneration) return;
    liveWS.disconnect();

    // Stop mock replay if running
    try { await api.stopMockReplay(); } catch (_) { /* ignore */ }

    // A load / live entry started while the stop request was pending owns the
    // session now: this exit's reset must not wipe what it put on screen
    if (generation !== _sessionLoadGeneration) return;

    cancelClockJump();
    cancelDegradationRefresh();
    // The live screen's cross-race PCA answers (pcaScreenReset)
    const pcaBefore = get();
    const pcaReset = pcaScreenReset(pcaBefore);
    set({
      ...screenSwitchState(),
      ...pcaReset,
      isLiveMode: false,
      liveConnected: false,
      liveSessionInfo: null,
      liveConnectionStatus: 'disconnected',
      liveStandings: null,
      raceControlMessages: [],
      teamRadios: [],
      liveTelemetry: {},
      sessionData: null,
      loadedSessionType: null,
      loadedYear: null,
      loadedRound: null,
      liveMockSession: null,
      _liveFullSession: false,
      _degradationRequest: null,
      degradationRegression: null,
      telemetryCache: {},
      sessionTimeOffset: 0,
      drivers: [],
      ...REPLAY_CLOCK_RESET,
      // whatever was still loading was abandoned with the new generation
      isLoading: false,
      isLoadingFrames: false,
      circuitInfo: null,
      trackStatus: [],
      currentFlagStatus: '1',
      currentLap: 1,
      maxLap: 1,
      raceSituationData: null,
      raceSituationLap: null,
      raceProjection: null,
      simulatorResult: null,
      _prevPcaResult: null,
      positionData: null,
      ...forecastReset(),
      rivalContext: [],
      _rivalContextAt: null,
    });
    refetchDroppedPCA(get, pcaReset, pcaBefore);
  },

  // Rebuild the live session from a snapshot (a session_init, or the
  // snapshot asked on a resync): the feed's rows, flag, lap counters and
  // retirements replace what the store accumulated (D14). The track map
  // and its frames, the clock and the computed analytics stay; they follow
  // the next feed messages.
  _applyLiveSnapshot: (snapshot, status) => {
    if (!snapshot || typeof snapshot !== 'object' || !get().isLiveMode) return;
    _liveRebuildSeq++;
    const s = get();
    const st = status || {};
    setSessionDriverColors(snapshot.driver_info || []);
    const next = liveSnapshotState(snapshot, st);
    set({
      ...next,
      totalRaceLaps: next.totalRaceLaps ?? s.totalRaceLaps,
      ...(st.session_info ? { liveSessionInfo: st.session_info } : {}),
      circuitInfo: snapshot.circuit_info?.track_coordinates ? snapshot.circuit_info : s.circuitInfo,
    });
  },

  // After a 'resync' message: ask the snapshot and rebuild from it, unless a
  // newer rebuild (the reconnect's session_init) or a session switch came first
  _resyncLive: async () => {
    const generation = _sessionLoadGeneration;
    const seq = _liveRebuildSeq;
    try {
      const [snapshot, status] = await Promise.all([
        api.getLiveSnapshot(),
        api.getLiveStatus().catch(() => null),
      ]);
      if (generation !== _sessionLoadGeneration || seq !== _liveRebuildSeq) return;
      if (get()._liveFullSession) return;
      get()._applyLiveSnapshot(snapshot, status);
    } catch (e) {
      console.warn('Live resync: snapshot not available', e);
    }
  },

  _handleLiveMessage: (msg) => {
    const { type, data } = msg;
    const state = get();

    switch (type) {
      case 'session_init': {
        // The backend sends its full snapshot on every (re)connect: the first
        // one follows enterLiveMode's own (and holds what changed in between),
        // a later one follows a reconnect (a 'resync' close, a dropped
        // socket), after which every message sent while the socket was down
        // is lost. Rebuild from it (D14). A finished session whose full
        // FastF1 rows replaced the feed's keeps those rows.
        if (!data?.session || state._liveFullSession) break;
        state._applyLiveSnapshot(data.session, data.status);
        break;
      }

      case 'resync': {
        // The backend dropped this client's backlog (its queue was full) and
        // closes the socket (code 1013); liveWS reconnects, and that
        // connect's session_init rebuilds. The snapshot is asked at once as
        // well, so the dashboard is whole again before the reconnect (D14)
        state._resyncLive();
        break;
      }

      case 'lap_update': {
        // Append new lap time entry
        const lapTimes = [...(state.sessionData?.lap_times || []), data];
        const lapNum = data.LapNumber || 0;
        const updatedMaxLap = Math.max(state.maxLap, lapNum);
        set({
          sessionData: { ...state.sessionData, lap_times: lapTimes },
          sessionTimeOffset: computeSessionTimeOffset(lapTimes),
          currentLap: Math.max(state.currentLap, lapNum),
          // maxLap tracks the furthest lap seen (not totalRaceLaps)
          maxLap: updatedMaxLap,
        });

        // The lap-time forecast is asked by a double-click only
        // (triggerPrediction): a forecast on screen stays the one asked, with
        // its origin lap

        // Compute race situation (PCA + Monte Carlo) every lap
        if (updatedMaxLap >= 3) {
          setTimeout(() => get().computeRaceSituation(), 0);
        }
        break;
      }

      case 'position_update': {
        // Update driver standings — data is array of standings
        if (Array.isArray(data)) {
          set({ liveStandings: data });
        }
        break;
      }

      case 'strategy_update': {
        const strategies = [...(state.sessionData?.tyre_strategy || []), data];
        set({
          sessionData: {
            ...state.sessionData,
            tyre_strategy: strategies,
            strategies, // Also update the strategies key used by some components
          },
        });
        break;
      }

      case 'strategy_correction': {
        // A driver's whole corrected stint list (backend session_manager
        // _replace_stints: a compound corrected after the stint was sent, a
        // pit-lane pass that turned out to be a tyre change or the reverse).
        // It replaces every entry of that driver, at the place of the
        // driver's first entry; 'strategy_update' stays append-only (D14, B4)
        const drv = data?.Driver;
        if (!drv || !Array.isArray(data.stints)) break;
        const current = state.sessionData?.tyre_strategy || [];
        const first = current.findIndex((x) => x?.Driver === drv);
        const others = current.filter((x) => x?.Driver !== drv);
        const at = first < 0 ? others.length : first;
        const strategies = [...others.slice(0, at), ...data.stints, ...others.slice(at)];
        set({
          sessionData: { ...state.sessionData, tyre_strategy: strategies, strategies },
        });
        break;
      }

      case 'weather_update': {
        const weather = [...(state.sessionData?.weather_data || []), data];
        set({ sessionData: { ...state.sessionData, weather_data: weather } });
        break;
      }

      case 'track_status': {
        // Live track_status: start_time is in SESSION seconds (the replay's
        // time base, backend data_normalizer.py process_track_status) and
        // received_at is the wall clock of its arrival (epoch s, what the
        // race-control lists show, D13); start_lap is the leader's lap at the
        // change (the feed's LapCount), else the lap count in force here. The
        // change closes the previous period at its start (end_time on the
        // session clock, end_lap on that lap): hooks/useReplayEngine.js
        // buildTrackStatusEvents places live periods with these fields
        const stamped = Number(data?.start_lap);
        const lap = data?.start_lap != null && Number.isFinite(stamped) ? stamped : (Number(state.currentLap) || 1);
        const startTime = Number(data?.start_time);
        const prev = state.trackStatus;
        const last = prev[prev.length - 1];
        const closed = prev.length && last.end_lap == null
          ? [...prev.slice(0, -1), {
            ...last,
            end_lap: lap,
            ...(last.end_time == null && data?.start_time != null && Number.isFinite(startTime)
              ? { end_time: startTime } : {}),
          }]
          : prev;
        const newStatus = [...closed, { ...data, start_lap: lap }];
        set({
          trackStatus: newStatus,
          currentFlagStatus: data.status || '1',
          sessionData: { ...state.sessionData, track_status: newStatus },
        });
        break;
      }

      case 'lap_count': {
        const { current_lap, total_laps } = data;
        set({
          currentLap: current_lap,
          maxLap: Math.max(state.maxLap, current_lap),
          totalRaceLaps: total_laps || state.totalRaceLaps,
        });
        break;
      }

      case 'driver_list': {
        // Live SignalR driver list — refresh colour map alongside.
        setSessionDriverColors(Array.isArray(data) ? data : []);
        set({ drivers: data });
        break;
      }

      case 'session_info': {
        set({ liveSessionInfo: data });
        // Also update sessionData so UI components (WeatherBar, SessionInfoBar) see the name
        if (data && state.sessionData) {
          const updatedCircuit = { ...(state.sessionData.circuit_info || {}), ...data };
          set({
            sessionData: { ...state.sessionData, circuit_info: updatedCircuit },
          });
          // If circuit_info gained track coordinates, update circuitInfo too
          if (data.circuit_info?.track_coordinates) {
            set({ circuitInfo: data.circuit_info });
          }
        }
        break;
      }

      case 'frame': {
        // Append position frame — used by TrackMap
        const frames = state.frameData?.frames || [];
        frames.push(data);
        // Keep bounded
        if (frames.length > 500) frames.splice(0, frames.length - 300);
        set({
          frameData: { ...state.frameData, frames },
          currentFrameIndex: frames.length - 1,
          totalFrames: frames.length,
        });
        break;
      }

      case 'session_end': {
        set({ liveSessionInfo: { ...state.liveSessionInfo, ended: true } });
        break;
      }

      case 'race_control': {
        set((s) => ({
          raceControlMessages: [
            ...s.raceControlMessages,
            { ...data, timestamp: Date.now() },
          ],
        }));
        break;
      }

      case 'team_radio': {
        // F1's TeamRadio topic ships .mp3 URLs only; the transcript field
        // is filled in later by `team_radio_transcript` (faster-whisper).
        if (!data?.audio_url) break;
        set((s) => ({
          teamRadios: [...s.teamRadios, data],
        }));
        break;
      }

      case 'team_radio_transcript': {
        // Async transcript update — match by audio_url and merge in place.
        if (!data?.audio_url) break;
        set((s) => ({
          teamRadios: s.teamRadios.map((r) =>
            r.audio_url === data.audio_url
              ? { ...r, transcript: data.transcript, transcript_status: data.transcript_status }
              : r
          ),
        }));
        break;
      }

      case 'driver_status': {
        // Live retirement signal from F1's TimingData (Retired/Stopped/KnockedOut).
        // race_results only arrives at session end, so this is the only way to
        // dim a driver mid-race on the timing tower / track map.
        const drv = data?.Driver;
        if (!drv) break;
        set((s) => {
          const next = { ...s.dnfMap };
          const isOut = !!(data.Retired || data.Stopped || data.KnockedOut);
          if (isOut) {
            next[drv] = {
              status: data.Status || (data.Retired ? 'Retired' : data.Stopped ? 'Stopped' : 'Out'),
              lastLap: data.LastLap ?? s.currentLap,
              classifiedPosition: 'R',
            };
          } else if (next[drv]) {
            // Driver re-joined (rare) — clear retirement
            const copy = { ...next };
            delete copy[drv];
            return { dnfMap: copy };
          }
          return { dnfMap: next };
        });
        break;
      }

      case 'telemetry_update': {
        // Live telemetry from OpenF1: {driver, driver_number, samples}
        const driver = data.driver;
        const samples = data.samples || [];
        if (driver && samples.length > 0) {
          set((s) => ({
            liveTelemetry: {
              ...s.liveTelemetry,
              [driver]: {
                ...samples[samples.length - 1],
                updated: Date.now(),
              },
            },
          }));
        }
        break;
      }

      case 'heartbeat':
        break;

      default:
        break;
    }
  },

  // ── Command Palette & Keyboard ────────────────────────────────
  commandPaletteOpen: false,
  focusedView: null,         // 'trackmap' | 'leaderboard' | 'laptimes' | 'strategy' | 'tires' | null
  compareMode: false,
  compareDrivers: [],        // max 2 driver abbreviations
  comparisonDriver: null,    // shared focus-vs-comparison target for Sector Delta / Undercut Calculator
  leaderboardColumnMode: 0,  // index into ['INT','GAP','TYRE','PIT']
  shortcutHintsVisible: true,
  cheatsheetOpen: false,

  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  setFocusedView: (view) => set(s => ({ focusedView: s.focusedView === view ? null : view })),
  clearFocusedView: () => set({ focusedView: null }),
  toggleCompareMode: () => set(s => ({
    compareMode: !s.compareMode,
    compareDrivers: s.compareMode ? [] : s.compareDrivers,
  })),
  cycleLeaderboardColumn: () => set(s => ({ leaderboardColumnMode: (s.leaderboardColumnMode + 1) % 4 })),
  addCompareDriver: (driver) => set(s => {
    if (s.compareDrivers.includes(driver)) {
      return { compareDrivers: s.compareDrivers.filter(d => d !== driver) };
    }
    return {
      compareDrivers: s.compareDrivers.length < 2
        ? [...s.compareDrivers, driver]
        : [s.compareDrivers[1], driver],
    };
  }),
  removeCompareDriver: (driver) => set(s => ({
    compareDrivers: s.compareDrivers.filter(d => d !== driver),
  })),
  setComparisonDriver: (driver) => set({ comparisonDriver: driver }),
  clearComparisonDriver: () => set({ comparisonDriver: null }),
  toggleShortcutHints: () => set(s => ({ shortcutHintsVisible: !s.shortcutHintsVisible })),
  toggleCheatsheet: () => set(s => ({ cheatsheetOpen: !s.cheatsheetOpen })),
  openCheatsheet: () => set({ cheatsheetOpen: true }),
  closeCheatsheet: () => set({ cheatsheetOpen: false }),

  // ── Track Map Overlays ────────────────────────────────────────
  showTrackSectors: true,   // all 3 sectors
  showTrackDRS: true,
  toggleTrackSectors: () => set(s => ({ showTrackSectors: !s.showTrackSectors })),
  toggleTrackDRS: () => set(s => ({ showTrackDRS: !s.showTrackDRS })),

  // Track rotation (90° steps, 4 clicks = full cycle)
  trackRotationOffset: 0,
  rotateTrackCW: () => set(s => ({ trackRotationOffset: (s.trackRotationOffset - 90 + 360) % 360 })),
  rotateTrackCCW: () => set(s => ({ trackRotationOffset: (s.trackRotationOffset + 90) % 360 })),
  resetTrackRotation: () => set({ trackRotationOffset: 0 }),
  setTrackRotationAbsolute: (deg) => set({ trackRotationOffset: ((deg % 360) + 360) % 360 }),

  // ── Tab / Panel system (multi-window) ──────────────────────────
  activeTab: 'pitwall',
  openOverlays: [],

  // ── Customizable dock ──────────────────────────────────────────
  dockItems: loadDockItems(),

  setDockItems: (items) => set({ dockItems: items }),

  addDockItem: (id, position = -1) => set((s) => {
    if (s.dockItems.includes(id)) return s;
    if (!SLOT_IDS.has(id)) return s;
    const next = [...s.dockItems];
    if (position < 0 || position > next.length) next.push(id);
    else next.splice(position, 0, id);
    return { dockItems: next };
  }),

  removeDockItem: (id) => {
    const s = get();
    if (s.dockItems.length <= 1) return; // never allow empty dock
    const idx = s.dockItems.indexOf(id);
    if (idx < 0) return;
    const prev = [...s.dockItems];
    const label = (SLOT_IDS.has(id) && id) || 'item';
    set({ dockItems: prev.filter((t) => t !== id) });
    // Offer undo — restores the item at its original index.
    s.pushToast({
      kind: 'undo',
      message: `Removed "${label}" from dock`,
      actionLabel: 'Undo',
      timeout: 6000,
      action: () => set({ dockItems: prev }),
    });
  },

  moveDockItem: (id, direction) => set((s) => {
    const idx = s.dockItems.indexOf(id);
    if (idx < 0) return s;
    const newIdx = direction === 'left' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= s.dockItems.length) return s;
    const next = [...s.dockItems];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    return { dockItems: next };
  }),

  resetDockItems: () => {
    const prev = [...get().dockItems];
    set({ dockItems: [...DOCK_DEFAULTS] });
    get().pushToast({
      kind: 'undo',
      message: 'Dock reset to defaults',
      actionLabel: 'Undo',
      timeout: 6000,
      action: () => set({ dockItems: prev }),
    });
  },

  setActiveTab: (tab) => {
    const UTILITY_TABS = new Set(['settings']);

    // ── Mode switches ──
    if (tab === 'pitwall') {
      set((s) => ({
        activeTab: 'pitwall',
        dockedLayout: null,
        _arrangeIdx: 0,
        // Keep utility overlays open
      }));
      return;
    }

    if (tab === 'charts') {
      set((s) => ({
        activeTab: 'charts',
        dockedLayout: null,
        _arrangeIdx: 0,
      }));
      return;
    }

    // ── Utility tabs → floating overlay (works over ANY mode) ──
    if (UTILITY_TABS.has(tab)) {
      set((s) => {
        const already = s.openOverlays.includes(tab);
        if (already) {
          // Toggle off
          const next = s.openOverlays.filter((t) => t !== tab);
          return { openOverlays: next };
        }
        // Toggle on — add to overlays without changing active mode
        return { openOverlays: [...s.openOverlays, tab] };
      });
      return;
    }

    // ── Analysis tabs → docked layout ──
    // Tabbed-MDI behaviour: a new chart from the dock or from any
    // chart picker always opens as a *tab* in the existing pane.
    // Splits stay available via the layout toolbar (the arrange-buttons
    // cycle) and the per-pane `+` dropdown — but never happen silently
    // as a side effect of opening a chart. This matches the VS Code /
    // JetBrains mental model users already have and removes the
    // inconsistency between dock-click and `+`-click paths.
    set((s) => {
      if (s.dockedLayout) {
        const allTabs = _collectDockedTabs(s.dockedLayout);
        if (allTabs.includes(tab)) {
          // Tab exists in layout — remove it (toggle off)
          const newLayout = _removeTabFromTree(s.dockedLayout, tab);
          if (!newLayout) return { dockedLayout: null, activeTab: s.activeTab === 'pitwall' ? 'pitwall' : 'charts', _arrangeIdx: 0 };
          return { dockedLayout: newLayout };
        }
        // Tab not in layout — add to the first leaf as a new tab.
        // If the user wants it in a different pane of a split layout,
        // they can drag it there or use the target pane's `+` menu.
        return { dockedLayout: _addTabToFirstLeaf(s.dockedLayout, tab), activeTab: 'charts' };
      }

      // No docked layout exists yet — create one with this tab
      return {
        dockedLayout: { tabs: [tab], activeTab: tab },
        activeTab: 'charts',
        openOverlays: s.openOverlays.filter((t) => UTILITY_TABS.has(t)),
        _arrangeIdx: 0,
      };
    });
  },

  focusOverlay: (tab) => set((s) => {
    if (!s.openOverlays.includes(tab)) return s;
    return { activeTab: tab };
  }),

  closeOverlay: (tab) => set((s) => {
    // Utility overlays live in openOverlays — always check there first
    if (s.openOverlays.includes(tab)) {
      const next = s.openOverlays.filter((t) => t !== tab);
      const tiles = { ...s.overlayTiles };
      delete tiles[tab];
      const vizMap = { ...s.overlayVizMapping };
      delete vizMap[tab];
      return { openOverlays: next, overlayTiles: tiles, overlayVizMapping: vizMap };
    }
    // In docked mode: remove tab from the layout tree
    if (s.dockedLayout) {
      const newLayout = _removeTabFromTree(s.dockedLayout, tab);
      if (!newLayout) return { dockedLayout: null, activeTab: 'charts', _arrangeIdx: 0 };
      return { dockedLayout: newLayout };
    }
    return {};
  }),

  /** Close the most recently added tab (last leaf, last tab). Works in both modes. */
  closeLastTab: () => set((s) => {
    if (s.dockedLayout) {
      const allTabs = _collectDockedTabs(s.dockedLayout);
      if (allTabs.length === 0) return { dockedLayout: null, activeTab: 'charts' };
      const lastTab = allTabs[allTabs.length - 1];
      const newLayout = _removeTabFromTree(s.dockedLayout, lastTab);
      if (!newLayout) return { dockedLayout: null, activeTab: 'charts', _arrangeIdx: 0 };
      return { dockedLayout: newLayout };
    }
    if (s.openOverlays.length === 0) return s;
    const last = s.openOverlays[s.openOverlays.length - 1];
    const next = s.openOverlays.slice(0, -1);
    const tiles = { ...s.overlayTiles };
    delete tiles[last];
    const vizMap = { ...s.overlayVizMapping };
    delete vizMap[last];
    return { openOverlays: next, activeTab: next.length > 0 ? next[next.length - 1] : 'charts', overlayTiles: tiles, overlayVizMapping: vizMap };
  }),

  // Every window and the docked layout closed (X, Escape with nothing
  // transient open, "Close all"): undoable from its toast or Ctrl/Cmd+Z
  // (undoLastChange), which restore the layout as it was
  closeAllOverlays: () => {
    const s = get();
    const hadLayout = !!s.dockedLayout || s.openOverlays.length > 0;
    const before = {
      openOverlays: s.openOverlays,
      activeTab: s.activeTab,
      overlayTiles: s.overlayTiles,
      overlayVizMapping: s.overlayVizMapping,
      dockedLayout: s.dockedLayout,
      _arrangeIdx: s._arrangeIdx,
    };
    set({
      openOverlays: [],
      activeTab: 'pitwall',
      overlayTiles: {},
      overlayVizMapping: {},
      dockedLayout: null,
      _arrangeIdx: 0,
    });
    if (!hadLayout) return;
    s.pushToast({
      kind: 'undo',
      message: 'Closed every window and the docked layout',
      actionLabel: 'Undo',
      timeout: 8000,
      action: () => set(before),
    });
  },

  cycleOverlay: (direction = 1) => set((s) => {
    if (s.openOverlays.length === 0) return s;
    const idx = s.openOverlays.indexOf(s.activeTab);
    const len = s.openOverlays.length;
    const next = s.openOverlays[((idx === -1 ? 0 : idx) + direction + len) % len];
    return { activeTab: next };
  }),

  // ── Settings (persist across sessions) ──────────────────────────
  theme: 'dark',
  tempUnit: 'C',
  speedUnit: 'kmh',
  overlayTiles: {},
  overlayVizMapping: {},
  _arrangeIdx: 0,
  dockedLayout: null, // JetBrains-style split-pane layout tree (null = use floating overlays)
  showDashboard: true,
  leaderboardCollapsed: false,
  telemetryChannels: { speed: true, delta: true, throttle: true, brake: true, gear: true, rpm: true },
  // Race Trace (utils/raceTrace.js): the reference ('field' | 'leader' |
  // 'focus') and the y window ('top' | 'focus' | 'all'); 'focus' shows the
  // top window while there is no focus driver
  raceTraceReference: 'field',
  raceTraceWindow: 'focus',
  setRaceTraceReference: (ref) => set({ raceTraceReference: TRACE_REFERENCES.includes(ref) ? ref : 'field' }),
  setRaceTraceWindow: (w) => set({ raceTraceWindow: TRACE_WINDOWS.includes(w) ? w : 'focus' }),

  setTheme: () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    set({ theme: 'dark' });
  },
  setTempUnit: (tempUnit) => set({ tempUnit }),
  toggleLeaderboard: () => set((s) => ({ leaderboardCollapsed: !s.leaderboardCollapsed })),
  setSpeedUnit: (speedUnit) => set({ speedUnit }),
  tileOverlay: (tabId, tile) => set((s) => ({
    overlayTiles: { ...s.overlayTiles, [tabId]: tile },
  })),
  clearTile: (tabId) => set((s) => {
    const next = { ...s.overlayTiles };
    delete next[tabId];
    return { overlayTiles: next };
  }),
  tileActiveOverlay: (tile) => set((s) => {
    if (s.openOverlays.length === 0) return s;
    const tabId = s.activeTab;
    if (!s.openOverlays.includes(tabId)) return s;
    if (s.overlayTiles[tabId] === tile) {
      const next = { ...s.overlayTiles };
      delete next[tabId];
      return { overlayTiles: next };
    }
    return { overlayTiles: { ...s.overlayTiles, [tabId]: tile } };
  }),
  arrangeOverlays: () => set((s) => {
    // ── Docked mode: cycle through layout variants for the same tabs ──
    if (s.dockedLayout) {
      const currentTabs = _collectDockedTabs(s.dockedLayout);
      if (currentTabs.length === 0) return s;
      const nextIdx = (s._arrangeIdx + 1) % 4; // 4 variants: grid, horizontal, vertical, main+sidebar
      return {
        dockedLayout: _buildDockedTree(currentTabs, nextIdx),
        _arrangeIdx: nextIdx,
      };
    }

    // ── Floating overlay mode: Ctrl+G docks them into a layout ──
    const ids = s.openOverlays;
    if (ids.length === 0) return s;
    // Convert floating overlays → docked layout
    return {
      activeTab: 'charts',
      openOverlays: [],
      overlayTiles: {},
      overlayVizMapping: {},
      dockedLayout: _buildDockedTree(ids, 0),
      _arrangeIdx: 0,
    };
  }),
  applyWindowPreset: (preset) => {
    const UTILITY_TABS = new Set(['settings']);
    // If preset has a docked layout tree, use the JetBrains-style docked mode
    if (preset.dockedLayout) {
      set((s) => ({
        activeTab: 'charts',
        // Keep utility overlays open, clear analysis overlays
        openOverlays: s.openOverlays.filter((t) => UTILITY_TABS.has(t)),
        overlayTiles: {},
        overlayVizMapping: {},
        dockedLayout: JSON.parse(JSON.stringify(preset.dockedLayout)),
        _arrangeIdx: 0,
      }));
      return;
    }
    // Fallback: floating overlays with percentage positions
    const windowIds = preset.windows.map(w => w.id);
    const tiles = {};
    preset.windows.forEach(w => {
      tiles[w.id] = w.position;
    });
    set({
      activeTab: windowIds[0] || 'charts',
      openOverlays: windowIds,
      overlayTiles: tiles,
      dockedLayout: null,
      _arrangeIdx: 0,
    });
  },
  setDockedLayout: (layout) => set({ dockedLayout: layout }),
  exitDockedLayout: () => set({ dockedLayout: null }),
  setOverlayVisualization: (overlayId, vizTabId) => set((s) => ({
    overlayVizMapping: { ...s.overlayVizMapping, [overlayId]: vizTabId }
  })),
  setShowDashboard: (show) => set({ showDashboard: show }),
  setTelemetryChannel: (channel, enabled) => set((s) => ({
    telemetryChannels: { ...s.telemetryChannels, [channel]: enabled },
  })),

  // Legacy panel system (kept for backward compat)
  activePanel: null,
  setActivePanel: (panel) => set((s) => ({ activePanel: s.activePanel === panel ? null : panel })),
  openPanel: (panel) => set({ activePanel: panel }),
  closePanel: () => set({ activePanel: null }),

  // Reset session to return to startup selector
  resetSession: () => {
    // A load still in flight (frames, circuit, analytics) is discarded
    ++_sessionLoadGeneration;
    cancelClockJump();
    cancelDegradationRefresh();
    set({
      ...screenSwitchState(),
      sessionData: null,
      loadedSessionType: null,
      loadedYear: null,
      loadedRound: null,
      liveMockSession: null,
      _liveFullSession: false,
      sessionTimeOffset: 0,
      currentFlagStatus: '1',
      _degradationRequest: null,
      circuitInfo: null,
      drivers: [],
      ...REPLAY_CLOCK_RESET,
      // whatever was still loading was abandoned with the new generation
      isLoading: false,
      isLoadingFrames: false,
      currentLap: 1,
      maxLap: 1,
      isPlaying: false,
      activeTab: 'pitwall',
      openOverlays: [],
      overlayTiles: {},
      overlayVizMapping: {},
      dockedLayout: null,
      _arrangeIdx: 0,
      activePanel: null,
      sectorRankings: null,
      consistencyData: null,
      speedRankings: null,
      telemetryCache: {},
      telemetryCompareLaps: [],
      positionData: null,
      ...forecastReset(),
      degradationRegression: null,
      ...pcaScreenReset(get()),
      raceSituationData: null,
      raceSituationLap: null,
      raceProjection: null,
      simulatorResult: null,
      _prevPcaResult: null,
      rivalContext: [],
      _rivalContextAt: null,
      selectedDrivers: [],
      highlightedDriver: null,
      focusDriver: null,
      focusTeam: null,
      watchedRivals: [],
      lapDeltaBaseDriver: null,
      error: null,
      previewDrivers: [],
      previewDriversLoading: false,
      preSelectedDrivers: [],
      commandPaletteOpen: false,
      focusedView: null,
      compareMode: false,
      compareDrivers: [],
      comparisonDriver: null,
      cheatsheetOpen: false,
      qualiSegments: null,
      qualiSegment: 'Q3',
      isQualifyingReplay: false,
    });
  },

  // ── Selection (bidirectional coordination) ─────────────────────
  selectedDrivers: [],
  highlightedDriver: null,
  highlightedDriverPosition: null, // {x, y} | null — for MFD card positioning
  // ONE lap range for every view. Both names hold the same value:
  // every lap-range action (the Position by Lap brush and its clear, the
  // Timing Sheet's lap-range bar, a stint click in the Strategy Timeline, a
  // pit window of the PCA analysis, a race event of the timeline) sets both,
  // and clearSelection clears both, so the sheet's rows and title, the
  // Position by Lap brush, the Strategy Timeline band and the Tyre
  // Degradation fit always show the same laps: the newest action wins. (r2:
  // a stint click set selectedLapRange only, so the sheet's title named the
  // stint while its rows and the brush showed another range or none.)
  selectedLapRange: null, // [startLap, endLap]
  brushLapRange: null, // [startLap, endLap], always equal to selectedLapRange
  setBrushLapRange: (range) => set({ brushLapRange: range, selectedLapRange: range }),
  // Last lap completed at the replay's "now" (see lastCompletedLap): for the
  // given drivers, or the race leader's when drivers is omitted.
  getLastCompletedLap: (drivers = null) => {
    const s = get();
    return lastCompletedLap(s.sessionData?.lap_times, s.getSessionNow(), drivers);
  },
  // The brushed lap range analytics may use: brushLapRange (else
  // selectedLapRange) with its end clamped to the last completed lap, so a
  // brush over laps the replay has not reached yet never reads future laps.
  // The brush itself keeps the user's selection; null when nothing usable.
  getAnalysisLapRange: (drivers = null) => {
    const s = get();
    const range = s.brushLapRange || s.selectedLapRange;
    if (!range) return null;
    return clampLapRange(range, s.getLastCompletedLap(drivers));
  },
  selectedPCAPoints: [],

  // ── Focus driver system ───────────────────────────────────────
  focusDriver: null,      // driver abbreviation string or null
  focusTeam: null,        // team name or null — auto-set when focusDriver changes
  watchedRivals: [],      // array of driver abbreviations considered rivals
  lapDeltaBaseDriver: null, // driver abbreviation for delta chart base

  // ── Track progress (Speed Trace ↔ TrackMap coordination) ──────
  trackProgress: null,       // 0.0–1.0 fraction along track for playhead sync
  setTrackProgress: (frac) => set({ trackProgress: frac }),

  // ── Stint selection (for TireSilhouette ↔ StrategyTimeline) ──
  selectedStint: null,       // {driver, stintNumber, compound, lapStart, stintLength}
  highlightedCompound: null, // 'SOFT'|'MEDIUM'|'HARD'|null
  setSelectedStint: (stint) => set({ selectedStint: stint }),
  setHighlightedCompound: (c) => set({ highlightedCompound: c }),

  setFocusDriver: (abbreviation) => {
    // The focus changes either way (another driver, or the same one toggled
    // off): the forecast belongs to the previous focus driver, so it goes,
    // with any forecast request still in flight (forecastReset)
    const cleared = forecastReset();
    set((s) => {
      // Toggle: if same driver, clear focus
      if (s.focusDriver === abbreviation) {
        return { focusDriver: null, focusTeam: null, watchedRivals: [], lapDeltaBaseDriver: null, ...cleared };
      }
      // Look up the driver's team from the loaded driver_info
      const driverInfo = s.drivers.find((d) => d.Abbreviation === abbreviation);
      const team = driverInfo?.TeamName || null;
      return {
        focusDriver: abbreviation,
        focusTeam: team,
        watchedRivals: [],
        lapDeltaBaseDriver: abbreviation,
        ...cleared,
      };
    });
    // Rival context for the newly focused driver (race only). The lap-time
    // forecast is asked by the double-click that focused it (triggerPrediction)
    if (get().focusDriver && !get().isQualifyingReplay) {
      get().updateRivalContext();
    } else if (!get().focusDriver) {
      set({ rivalContext: [] });
    }
  },
  setLapDeltaBaseDriver: (abbr) => set({ lapDeltaBaseDriver: abbr }),

  setWatchedRivals: (rivals) => set({ watchedRivals: rivals }),

  toggleDriver: (abbr) =>
    set((s) => {
      const sel = s.selectedDrivers.includes(abbr)
        ? s.selectedDrivers.filter((d) => d !== abbr)
        : [...s.selectedDrivers, abbr];
      return { selectedDrivers: sel };
    }),

  setSelectedDrivers: (drivers) => set({ selectedDrivers: drivers }),
  setHighlightedDriver: (abbr, pos = null) => set({
    highlightedDriver: abbr,
    highlightedDriverPosition: abbr ? pos : null,
  }),
  setSelectedLapRange: (range) => set({ selectedLapRange: range, brushLapRange: range }),
  // An empty selection drops its analysis, and an answer still on its way
  // (fetchPCAAnalysis keeps only the newest request's answer)
  setSelectedPCAPoints: (ids) => set((s) => (ids?.length
    ? { selectedPCAPoints: ids }
    : {
      selectedPCAPoints: [], pcaStrategyAnalysis: null, pcaAnalysisIds: null, pcaAnalysisError: null,
      _pcaAnalysisSeq: (s._pcaAnalysisSeq || 0) + 1,
    })),

  // The focus goes, so its forecast and any forecast request in flight go
  // with it (forecastReset, as setFocusDriver does; backlog L3)
  clearSelection: () => {
    const cleared = forecastReset();
    set({
      selectedDrivers: [],
      highlightedDriver: null,
      highlightedDriverPosition: null,
      selectedLapRange: null,
      brushLapRange: null, // the one lap range
      selectedPCAPoints: [],
      focusDriver: null,
      focusTeam: null,
      watchedRivals: [],
      lapDeltaBaseDriver: null,
      selectedStint: null,
      highlightedCompound: null,
      ...cleared,
    });
  },

  // ── Simulation ────────────────────────────────────────────────
  isPlaying: false,
  playSpeed: 1,
  currentLap: 1,
  maxLap: 1,
  currentTime: 0,
  maxTime: 0,
  frameData: null,
  positionData: null,
  lapFrameMap: null, // { lapNumber: frameIndex } — for quick frame lookup

  // Lap-indexed mode (no frames): the race-over state, after the chequered
  // flag (resolveSessionNow raceOver: Infinity). Every lap of the lap clock,
  // the last one included, is the moment the leader started it (R4); the
  // final results are reached with the timeline's skip-to-end (showRaceOver)
  // and left with any lap seek.
  lapModeRaceOver: false,

  // Frame-based replay state
  currentFrameIndex: 0,
  totalFrames: 0,
  frameDt: 0.4, // seconds between frames (computed from data)
  // Qualifying replay: session seconds at replay time 0 of each segment
  // ({Q1, Q2, Q3}, see qualiSegmentOffsets); sessionTimeOffset is the active
  // segment's origin while a qualifying replay is loaded
  qualiSegmentOffsets: null,
  // ({Q1, Q2, Q3}: { start, origin, end } session seconds, see
  // qualiSegmentWindows): the active segment's end is the clock of its last
  // frame, its start bounds the laps its standings rank
  qualiSegmentWindows: null,

  setCurrentFlagStatus: (status) => set({ currentFlagStatus: status }),

  // Compute flag from track status at a REPLAY time (seconds on the frame.t
  // clock). track_status times are session seconds: session = replay + offset.
  updateFlagForTime: (time) => {
    const { trackStatus, sessionTimeOffset, isLiveMode } = get();
    if (!trackStatus?.length) {
      set({ currentFlagStatus: '1' });
      return;
    }
    const sessionTime = isLiveMode ? time : time + sessionTimeOffset;
    set({ currentFlagStatus: flagAtSessionTime(trackStatus, sessionTime) });
  },

  // Flag after a lap seek, at the dashboard's clock (getSessionNow) once
  // setCurrentLap has moved it: the frame where the lap starts when replay
  // frames exist, the race leader's lap start in lap mode (R4, the last lap
  // included), the race-over flag in lap mode's race-over state (flagAtClock). In an active replay a lap with no
  // frame (qualifying: lapFrameMap = {1: 0}) leaves the replay clock, and so
  // the flag, where they are: the flag never leaves the dashboard's clock.
  updateFlagForLap: () => {
    const { trackStatus, isLiveMode, sessionData } = get();
    // Live mode: the flag follows the feed's track_status messages
    if (isLiveMode) return;
    if (!trackStatus?.length) {
      set({ currentFlagStatus: '1' });
      return;
    }
    set({ currentFlagStatus: flagAtClock(trackStatus, sessionData?.lap_times, sessionNowOf(get())) });
  },

  // Set frame index and derive currentLap + flag from it
  setCurrentFrameIndex: (idx) => {
    const state = get();
    const {
      frameData, trackStatus, currentLap: prevLap, sessionData, sessionTimeOffset, isLiveMode,
    } = state;
    const updates = { currentFrameIndex: idx };
    const frame = frameData?.frames?.[idx];
    let jumped = false;
    let nextNow = null;

    if (frame) {
      // Derive currentLap from highest lap among drivers
      const maxLapInFrame = frameLeaderLap(frame);
      updates.currentLap = maxLapInFrame;
      updates.currentTime = frame.t;

      // Update flag from frame time. track_status is on the session clock:
      // session time = frame.t + sessionTimeOffset (utils/raceTime.js).
      // Live mode: the flag follows the feed's track_status messages.
      const frameSessionTime = frame.t + sessionTimeOffset;
      if (trackStatus?.length && !isLiveMode) {
        updates.currentFlagStatus = flagAtSessionTime(trackStatus, frameSessionTime);
      }

      // A clock jump (seek): the clock moved backward, or by more than one
      // leader lap at once. Playback only moves forward, one lap at a time.
      const prevNow = sessionNowOf(state);
      nextNow = sessionNowOf({ ...state, ...updates });
      jumped = !isLiveMode && (nextNow < prevNow || Math.abs(maxLapInFrame - prevLap) > 1);

      // Rival context and race situation follow the replay (skip for
      // qualifying); the lap-time forecast is asked by a double-click only
      if (!state.isQualifyingReplay && !jumped && maxLapInFrame >= 3) {
        const lapChanged = maxLapInFrame !== prevLap;

        // Also recompute after the focus driver's pit stop: a tyre change
        // (utils/stints.js pitStops, R2) whose pit exit (session seconds)
        // happened between the previously shown frame and this one. Causal:
        // a stop counts only once its PitOutTime has been reached; pit-lane
        // visits without a tyre change (drive-through, SC pass) do not count.
        const focusDrv = state.focusDriver;
        const prevFrameT = frameData.frames[state.currentFrameIndex]?.t;
        const prevSessionTime = prevFrameT != null ? prevFrameT + sessionTimeOffset : -Infinity;
        const pitTrigger = !isLiveMode && !!focusDrv && frameSessionTime > prevSessionTime
          && fullRaceStops(sessionData?.lap_times).some((stop) => stop.Driver === focusDrv
            && stop.pitOutTime != null && stop.pitOutTime > prevSessionTime
            && stop.pitOutTime <= frameSessionTime);

        // Also when the flag goes from SC/VSC back to green (checked on
        // every frame: the change rarely falls on a lap change)
        const prevFlag = state.currentFlagStatus;
        const newFlag = updates.currentFlagStatus ?? prevFlag;
        const flagTrigger = newFlag === '1' && (prevFlag === '4' || prevFlag === '6' || prevFlag === '7');

        if (lapChanged || pitTrigger || flagTrigger) {
          setTimeout(() => {
            get().updateRivalContext();
            get().computeRaceSituation();
          }, 0);
        }
      }
    }
    // Analytics computed at a later clock than the new one go in the same update
    Object.assign(updates, laterClockReset(state, nextNow ?? sessionNowOf({ ...state, ...updates })));
    set(updates);
    if (jumped) get()._scheduleClockRecompute();
    // A brushed degradation fit follows the laps completed so far
    get().refreshDegradationRegression();
  },

  setCurrentLap: (lap) => {
    // When setting lap directly (e.g., seeking), also update frame index and currentTime
    const state = get();
    const { lapFrameMap, frameData } = state;
    // A lap seek leaves the lap-mode race-over state
    const updates = { currentLap: lap, lapModeRaceOver: false };
    if (lapFrameMap && lapFrameMap[lap] != null) {
      updates.currentFrameIndex = lapFrameMap[lap];
      // Sync currentTime from the frame so sector timing comparisons work
      const frame = frameData?.frames?.[lapFrameMap[lap]];
      if (frame?.t != null) updates.currentTime = frame.t;
    }
    // Analytics computed at a later clock than the new one go in the same update
    Object.assign(updates, laterClockReset(state, sessionNowOf({ ...state, ...updates })));
    set(updates);
    get().updateFlagForLap();
    get().refreshDegradationRegression();
    // A manual seek: predictions, rival context, race situation and projection
    // are recomputed at the new clock
    get()._scheduleClockRecompute();
  },

  // Lap-indexed mode (no frames, not live): the race-over state on the last
  // lap, the clock after the chequered flag (Infinity: every lap completed,
  // the final classification). With frames the replay's last frame is that
  // state, so this seeks there instead.
  showRaceOver: () => {
    const state = get();
    if (state.isLiveMode) return;
    if (state.totalFrames > 0) {
      state.setCurrentFrameIndex(state.totalFrames - 1);
      return;
    }
    const updates = { currentLap: Math.max(1, state.maxLap || 1), lapModeRaceOver: true };
    Object.assign(updates, laterClockReset(state, sessionNowOf({ ...state, ...updates })));
    set(updates);
    get().updateFlagForLap();
    get().refreshDegradationRegression();
    get()._scheduleClockRecompute();
  },

  // After a clock jump (seek backward or forward, setCurrentLap): recompute
  // every clock-derived analytic at the new clock once the seek settles
  // (CLOCK_JUMP_SETTLE_MS). Anything computed at a later clock was already
  // dropped by laterClockReset in the same update as the jump.
  _scheduleClockRecompute: () => {
    cancelClockJump();
    _clockJumpTimer = setTimeout(() => {
      _clockJumpTimer = null;
      const s = get();
      s.updateRivalContext();
      s.computeRaceSituation({ projection: true });
      // The lap-time forecast is not re-asked: one asked at a later clock was
      // dropped with the jump (laterClockReset), an earlier one stays
      if (s.isSimulatorActive && s.simulatorStrategy) s.runSimulation();
      // The cross-race PCA at the new clock: the embeddings once loaded, and
      // the analysis of a selection whose answer the jump dropped
      if (s.pcaEmbeddings || s._pcaEmbeddingsAt != null) s.loadPCAEmbeddings();
      if (s.selectedPCAPoints?.length && !s.pcaStrategyAnalysis) s.fetchPCAAnalysis(s.selectedPCAPoints);
    }, CLOCK_JUMP_SETTLE_MS);
  },

  setMaxLap: (max) => set({ maxLap: max }),
  setCurrentTime: (t) => set({ currentTime: t }),
  // The causal "now" in SESSION seconds (Infinity = no limit), see
  // utils/raceTime.js resolveSessionNow and sessionNowOf above;
  // hooks/useSessionNow.js is the React twin.
  getSessionNow: () => sessionNowOf(get()),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setPlaySpeed: (s) => set({ playSpeed: s }),

  loadFrames: async () => {
    // The frames of the session loadSession put on screen (never the pills)
    const scope = sessionScopeOf(get());
    if (!scope || get().isLiveMode) return;
    const { year, round, sessionType } = scope;
    // A newer loadSession discards these frames (they belong to another session)
    const current = sessionRequestGuard(get);
    set({ isLoadingFrames: true });
    try {
      const data = await api.getFrames(year, round, sessionType);
      if (!current()) return;

      // ── Qualifying: response has { segments: { Q1: {...}, Q2: {...}, Q3: {...} } }
      if (data.segments) {
        const segments = data.segments;
        const defaultSeg = segments.Q3 ? 'Q3' : segments.Q2 ? 'Q2' : 'Q1';
        const activeData = segments[defaultSeg];
        // Each segment's frames have their own replay origin (session seconds)
        const windows = qualiSegmentWindows(get().sessionData?.lap_times, segments);
        const offsets = offsetsOf(windows);

        if (!activeData?.frames?.length) {
          set({
            isLoadingFrames: false, qualiSegments: segments, isQualifyingReplay: true,
            qualiSegmentOffsets: offsets, qualiSegmentWindows: windows, lapModeRaceOver: false,
          });
          console.warn('Qualifying frames: no frames in default segment');
          return;
        }

        let frameDt = 0.4;
        if (activeData.frames.length > 1) {
          frameDt = activeData.frames[1].t - activeData.frames[0].t;
          if (frameDt <= 0) frameDt = 0.4;
        }

        set({
          qualiSegments: segments,
          qualiSegment: defaultSeg,
          isQualifyingReplay: true,
          qualiSegmentOffsets: offsets,
          qualiSegmentWindows: windows,
          lapModeRaceOver: false,
          frameData: activeData,
          maxTime: activeData.max_time || 0,
          lapFrameMap: { 1: 0 },
          totalFrames: activeData.frames.length,
          frameDt,
          isLoadingFrames: false,
          ...qualiSegmentClock(get(), defaultSeg, activeData, offsets),
        });
        console.log(`Qualifying frames loaded: ${defaultSeg} has ${activeData.frames.length} frames, segments: ${Object.keys(segments).join(', ')}`);
        return;
      }

      // ── Race/Sprint: response has { frames: [...], driver_colors, total_laps, max_time }
      const lapFrameMap = {};
      let totalFrames = 0;
      let frameDt = 0.4;

      if (data.frames?.length) {
        totalFrames = data.frames.length;

        // Compute frameDt from actual timestamps
        if (totalFrames > 1) {
          frameDt = data.frames[1].t - data.frames[0].t;
          if (frameDt <= 0) frameDt = 0.4; // safety fallback
        }

        for (let i = 0; i < data.frames.length; i++) {
          const frame = data.frames[i];
          if (!frame.drivers) continue;

          const driverEntries = Object.values(frame.drivers);
          if (driverEntries.length === 0) continue;

          let maxLapInFrame = 0;
          for (const d of driverEntries) {
            if (d.lap > maxLapInFrame) maxLapInFrame = d.lap;
          }

          if (maxLapInFrame > 0 && !(maxLapInFrame in lapFrameMap)) {
            lapFrameMap[maxLapInFrame] = i;
          }
        }

        // Update maxLap if frames provide more accurate count
        const frameMaxLap = data.total_laps || Math.max(...Object.keys(lapFrameMap).map(Number));
        const { maxLap } = get();
        if (frameMaxLap > maxLap) {
          set({ maxLap: frameMaxLap });
        }
      }

      // The replay starts where the lap-mode clock is (lap 1: the first
      // frame), with the currentTime, lap and flag of that frame
      const state = get();
      // (the lap-mode race-over state continues on the last frame, which is it)
      const startIdx = !totalFrames ? 0
        : state.lapModeRaceOver ? totalFrames - 1
          : state.currentLap > 1 && lapFrameMap[state.currentLap] != null
            ? lapFrameMap[state.currentLap] : 0;
      const startFrame = data.frames?.[startIdx];
      const updates = {
        frameData: data,
        maxTime: data.max_time || 0,
        lapFrameMap,
        totalFrames,
        frameDt,
        currentFrameIndex: startIdx,
        currentTime: startFrame?.t ?? 0,
        isLoadingFrames: false,
        qualiSegments: null,
        isQualifyingReplay: false,
        qualiSegmentOffsets: null,
        qualiSegmentWindows: null,
        lapModeRaceOver: false,
      };
      if (startFrame) {
        updates.currentLap = frameLeaderLap(startFrame);
        if (state.trackStatus?.length && !state.isLiveMode) {
          updates.currentFlagStatus = flagAtSessionTime(
            state.trackStatus, startFrame.t + state.sessionTimeOffset,
          );
        }
      }
      const dropped = laterClockReset(state, sessionNowOf({ ...state, ...updates }));
      Object.assign(updates, dropped);
      set(updates);
      // What the drop removed is asked again at the replay's clock (as a seek
      // does): a selection would otherwise wait for an analysis nobody asked for
      refetchDroppedPCA(get, dropped, state);
      console.log(`Frames loaded: ${totalFrames} frames (${frameDt.toFixed(2)}s/frame), lap map has ${Object.keys(lapFrameMap).length} entries`);
    } catch (e) {
      set({ isLoadingFrames: false });
      console.error('Failed to load frames', e);
    }
  },

  setQualiSegment: (seg) => {
    const { qualiSegments, qualiSegmentOffsets: offsets } = get();
    if (!qualiSegments?.[seg]) return;
    const activeData = qualiSegments[seg];
    if (!activeData?.frames?.length) return;

    let frameDt = 0.4;
    if (activeData.frames.length > 1) {
      frameDt = activeData.frames[1].t - activeData.frames[0].t;
      if (frameDt <= 0) frameDt = 0.4;
    }

    set({
      qualiSegment: seg,
      frameData: activeData,
      maxTime: activeData.max_time || 0,
      totalFrames: activeData.frames.length,
      frameDt,
      isPlaying: false,
      lapFrameMap: { 1: 0 },
      // Replay clock, offset and flag of the new segment's first frame
      ...qualiSegmentClock(get(), seg, activeData, offsets),
    });
    console.log(`Switched to ${seg}: ${activeData.frames.length} frames`);
  },

  // Get the frame data for the current frame index (used by TrackMap)
  getCurrentFrame: () => {
    const { frameData, currentFrameIndex } = get();
    if (!frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    return frameData.frames[idx] || null;
  },

  loadPositions: async () => {
    // The positions of the session on screen (never the pills)
    const scope = sessionScopeOf(get());
    if (!scope) return;
    const { year, round } = scope;
    const current = sessionRequestGuard(get);
    try {
      const data = await api.getPositions(year, round);
      // Positions of a session the dashboard has since left are discarded
      if (!current()) return;
      set({ positionData: data });
    } catch (e) {
      console.error('Failed to load positions', e);
    }
  },

  // ── Analytics (Sectors, Consistency, Speed Rankings) ──────────────
  sectorRankings: null,
  consistencyData: null,
  speedRankings: null,

  fetchAnalytics: async () => {
    // The analytics of the session on screen, of its type (D16: session_type)
    const scope = sessionScopeOf(get());
    if (!scope) return;
    const { year, round, sessionType } = scope;
    // Results of a session the dashboard has since left are discarded
    const current = sessionRequestGuard(get);
    const [sectors, consistency, speed] = await Promise.allSettled([
      api.getSectors(year, round, sessionType),
      api.getConsistency(year, round, sessionType),
      api.getSpeedRankings(year, round, sessionType),
    ]);
    if (!current()) return;
    set({
      sectorRankings: sectors.status === 'fulfilled' ? sectors.value : null,
      consistencyData: consistency.status === 'fulfilled' ? consistency.value : null,
      speedRankings: speed.status === 'fulfilled' ? speed.value : null,
    });
  },

  // ── Telemetry Strip ──────────────────────────────────────────────
  // { "VER-12-2024-16-R": [{Distance, Speed, Throttle, Brake, nGear, ...}] } (telemetryCacheKey)
  telemetryCache: {},
  telemetryCompareMode: 'drivers', // 'drivers' | 'laps'
  telemetryCompareLaps: [],        // [12, 23, 36] for laps mode
  telemetryLoading: false,

  fetchDriverTelemetry: async (driver, lap) => {
    // The lap's trace in the session on screen (sessionScopeOf: the loaded
    // year, round and type, never the pills; live: the mock replay's race,
    // none for a real feed). The key carries the same identity (D7), and an
    // answer that arrives once another session is on screen is dropped below
    // (sessionRequestGuard)
    const scope = sessionScopeOf(get());
    if (!scope) return null;
    const key = telemetryCacheKey(driver, lap, scope);
    if (get().telemetryCache[key]) return get().telemetryCache[key];
    const { year, round, sessionType } = scope;

    const current = sessionRequestGuard(get);
    _telemetryInFlight.add(current);
    set({ telemetryLoading: true });
    try {
      const data = await api.getTelemetry(year, round, driver, lap, sessionType);
      _telemetryInFlight.delete(current);
      // The dashboard has since switched session: this trace is not its own,
      // and the spinner is the new session's requests' (telemetryLoadingNow)
      if (!current()) {
        set({ telemetryLoading: telemetryLoadingNow() });
        return null;
      }
      const telemetry = data.telemetry || [];
      set((s) => ({
        telemetryCache: { ...s.telemetryCache, [key]: telemetry },
        telemetryLoading: telemetryLoadingNow(),
      }));
      return telemetry;
    } catch (e) {
      _telemetryInFlight.delete(current);
      if (current()) console.error(`Telemetry fetch failed for ${key}:`, e);
      set({ telemetryLoading: telemetryLoadingNow() });
      return null;
    }
  },

  setTelemetryCompareMode: (mode) => set({ telemetryCompareMode: mode }),
  setTelemetryCompareLaps: (laps) => set({ telemetryCompareLaps: laps }),

  // ── Race Situation Map ──────────────────────────────────────────
  raceSituationData: null,
  raceSituationLap: null,
  // the previous computation's PCA: its basis is the alignment reference in live
  // mode (a replay uses raceSituationReference.js replayReferenceAt)
  _prevPcaResult: null,

  // Race situation (live PCA) at the current clock. Debounced per lap; on a
  // clock jump (opts.projection) the Monte Carlo projection is recomputed at
  // the new clock too, or dropped when it cannot be computed there.
  computeRaceSituation: ({ projection = false } = {}) => {
    const {
      sessionData, currentLap, dnfMap, frameData, currentFrameIndex,
      lstmPredictions, focusDriver, isQualifyingReplay, raceSituationLap,
      _prevPcaResult,
    } = get();

    if (isQualifyingReplay) return;
    const followProjection = () => {
      if (projection) get().computeRaceProjection({ replace: true });
    };
    if (currentLap < 3) { followProjection(); return; }
    // Debounce: skip if already computed for this lap
    if (raceSituationLap != null && currentLap === raceSituationLap) { followProjection(); return; }

    const lapTimes = sessionData?.lap_times;
    const strategies = sessionData?.tyre_strategy || sessionData?.strategies || [];
    if (!lapTimes?.length) return;

    const frame = frameData?.frames?.[Math.min(currentFrameIndex, (frameData?.frames?.length || 1) - 1)];
    const frameDrivers = frame?.drivers || {};

    // Causal: the features use only the laps completed at sessionNow
    const now = get().getSessionNow();
    const result = extractRaceSituationFeatures({
      lapTimes, strategies, dnfMap, currentLap,
      frameDrivers, lstmPredictions, focusDriver,
      sessionNow: now, sessionTimeOffset: get().sessionTimeOffset,
      isLiveMode: get().isLiveMode, running: stintsRunningOf(get()),
    });

    if (!result) {
      set({ raceSituationData: null, raceSituationLap: currentLap });
      followProjection();
      return;
    }

    // Refitted at this lap (current means / SDs / eigenvectors), its basis
    // turned in the PC1-PC2 plane to the previous lap's (livePCA.js
    // LIVE_PCA_ALIGN, orthogonal Procrustes): the points and the loading
    // arrows share that basis, so no score-level alignment follows. The
    // previous lap's axes: in a replay, as a replay from the first lap draws
    // them (raceSituationReference.js), so a lap reached by a rewind or a
    // seek is drawn as playing draws it; live (no going back), the previous
    // computation's
    const reference = get().isLiveMode
      ? _prevPcaResult
      : replayReferenceAt(lapTimes, currentLap, {
        dnfMap, sessionTimeOffset: get().sessionTimeOffset, sessionNow: now,
      });
    const pcaResult = computePCA(result.matrix, FEATURE_NAMES, reference, { align: LIVE_PCA_ALIGN });
    if (!pcaResult) {
      set({ raceSituationData: null, raceSituationLap: currentLap });
      followProjection();
      return;
    }

    set({
      raceSituationData: {
        driverAbbrs: result.driverAbbrs,
        scores: pcaResult.scores,
        loadings: pcaResult.loadings,
        // share of the variance each displayed axis captures at this lap
        explainedVariance: pcaResult.explainedVariance,
        // false while the pace is left out of the fit (raceSituationFeatures.js)
        paceInPca: result.paceInPca,
        driverFeatures: result.driverFeatures,
        computedAtLap: currentLap,
        // Session seconds of the clock the features were computed at
        computedAtNow: now,
      },
      raceSituationLap: currentLap,
      _prevPcaResult: pcaResult,
    });

    // Monte Carlo projection: the new race situation has already requested it
    // (the store subscription at the end of this file, every lap); after a
    // clock jump a projection that cannot be computed here is dropped too
    if (projection) get().computeRaceProjection({ replace: true });
  },

  // ── Predictions ────────────────────────────────────────────────
  // Lap-time forecast (utils/forecast.js): null | { [driver]: entry }, the
  // focus driver's only, tagged {driver, lap (origin), method, computedAtNow}.
  // One writer: triggerPrediction (a double-click). Cleared on a focus change,
  // a session switch (forecastReset) and a later-clock reset (laterClockReset)
  lstmPredictions: null,
  degradationRegression: null,
  // Last degradation request as asked by the caller (lap_end = brushed end)
  // plus lap_end_used = the end actually sent (clamped to completed laps)
  _degradationRequest: null,
  pcaStrategyAnalysis: null,
  rivalContext: [],

  fetchDegradationRegression: async (params) => {
    // Causal brush: the fit never reads a lap the replay has not completed.
    // The request carries the clock (session_now, session seconds; null =
    // the whole race, D6) and the endpoint uses only the laps completed by
    // then, as the chart (stintFits at sessionNow); lap_end is clamped to the
    // requested drivers' last completed lap as well. The response keeps
    // echoing the requested range (lap_start / lap_end, as the backend echoes
    // its request) and adds the laps actually fitted: lap_end_used = the last
    // lap fitted, fitted_lap_range = [lap_start, lap_end_used] (null when no
    // lap of the range is fitted). A view labels the fit with
    // fitted_lap_range, not with the brushed lap_end. year / round /
    // session_type are those of the session on screen (sessionScopeOf).
    cancelDegradationRefresh(); // this request supersedes a pending re-request
    let data = null;
    const s0 = get();
    // computedAtNow = the clock the fit belongs to (laterClockReset)
    const reqNow = s0.getSessionNow();
    const ranged = params && Number.isFinite(params.lap_start) && Number.isFinite(params.lap_end);
    const scope = sessionScopeOf(s0);
    if (s0.isLiveMode || !scope) {
      // The endpoint fits the rows of a cached session at a session clock;
      // a live feed (clock Infinity, rows still coming) has neither, and a
      // mock replay's cached race would hand it the laps still to come. The
      // chart's per-stint fits (stintFits of the live rows) stay.
      set({
        _degradationRequest: null,
        degradationRegression: {
          slope: null,
          lap_start: params?.lap_start ?? null,
          lap_end: params?.lap_end ?? null,
          lap_end_used: null,
          fitted_lap_range: null,
          reason: s0.isLiveMode
            ? 'Live feed: no backend fit (it reads cached sessions at a replay clock); the chart shows the live per-stint fits.'
            : 'No session loaded.',
          computedAtNow: reqNow,
        },
      });
      return;
    }
    const lapTimes = s0.sessionData?.lap_times;
    const drivers = Array.isArray(params?.drivers) ? params.drivers : [];
    let sent = {
      ...params,
      year: scope.year,
      round: scope.round,
      session_type: scope.sessionType,
      session_now: Number.isFinite(reqNow) ? reqNow : null,
    };
    // What the fit depends on at reqNow (brushFitKey): laterClockReset keeps
    // the result only while the same, refreshDegradationRegression re-asks
    // when it changes
    let fitKey = null;
    if (ranged) {
      const lapEndUsed = Math.min(params.lap_end, s0.getLastCompletedLap(drivers));
      fitKey = brushFitKey(lapTimes, drivers, {
        sessionNow: reqNow, lapStart: params.lap_start, lapEnd: params.lap_end,
      });
      sent = { ...sent, lap_end: lapEndUsed };
      set({
        _degradationRequest: {
          ...params, lap_end_used: lapEndUsed, fit_key: fitKey, done_key: completedLapsKey(lapTimes, drivers, reqNow),
        },
      });
      if (lapEndUsed < params.lap_start) {
        // Nothing of the brushed range is completed (or ever will be: a
        // driver who retired before it): no request, and the reason says which
        const s = get();
        data = {
          slope: null,
          lap_start: params.lap_start,
          lap_end: params.lap_end,
          lap_end_used: lapEndUsed,
          fitted_lap_range: null,
          reason: degradationGapReason(
            s.sessionData?.lap_times, params.drivers, reqNow, params.lap_start, s.dnfMap,
            { isLiveMode: s.isLiveMode },
          ),
          computedAtNow: reqNow,
        };
      }
    }
    const generation = ++_degradationGeneration;
    // The session on screen when asked (sessionRequestGuard): a fit asked for
    // a session that another one has since replaced on screen (also one asked
    // while that load was still in flight) belongs to another session and
    // clock, never to the one on screen
    const sameSession = sessionRequestGuard(get);
    try {
      if (!data) {
        data = await api.predictDegradation(sent);
        // A newer request (new brush or replay re-request) superseded this
        // one, or the dashboard has since switched session
        if (generation !== _degradationGeneration || !sameSession()) return;
        const nowLanded = get().getSessionNow();
        // The clock moved back while the request ran and the fit's inputs at
        // the new clock differ: it holds later laps (the re-request follows)
        if (ranged && reqNow > nowLanded && fitKey !== brushFitKey(get().sessionData?.lap_times, drivers, {
          sessionNow: nowLanded, lapStart: params.lap_start, lapEnd: params.lap_end,
        })) return;
        if (data && typeof data === 'object') {
          // Fitted on laps completed at reqNow, the same inputs as at the
          // earlier of the two clocks, so it belongs to that one
          data = { ...data, computedAtNow: Math.min(reqNow, nowLanded), fit_key: fitKey };
        }
        if (ranged && data && typeof data === 'object') {
          data = {
            ...data,
            lap_start: params.lap_start,
            lap_end: params.lap_end,
            lap_end_used: sent.lap_end,
            fitted_lap_range: [params.lap_start, sent.lap_end],
          };
        }
      }
      // Backend now returns 200 with `reason: "..."` when no fit was
      // possible — keep the previous regression visible (don't clear it
      // mid-drag) but stash the diagnostic so the panel can show it.
      if (data && data.slope == null && data.reason) {
        set((s) => {
          const prev = s.degradationRegression;
          // A previous fit of the same brushed range may hold laps beyond the
          // current replay time (after a backward seek): replace it.
          const sameRange = ranged && prev
            && prev.lap_start === data.lap_start && prev.lap_end === data.lap_end;
          return {
            degradationRegression: prev && !sameRange
              ? { ...prev, lastReason: data.reason }
              : data,
          };
        });
      } else {
        set({ degradationRegression: data });
      }
    } catch (e) {
      // Network / 5xx errors only — 422-style "no data" cases are now
      // 200 responses (see backend), so anything that lands here is a
      // genuine failure worth reporting.
      console.error('Degradation regression failed', e);
    }
  },

  // Replay moved: re-issue the last brushed degradation fit when its inputs
  // changed (degradationRefreshParams: the clamped lap end, or the clean laps
  // of the range, brushFitKey), while the same brush is still active (D6).
  // At most one re-request per DEGRADATION_REFRESH_MS: the first change
  // schedules it and it is sent with the clock of the moment it fires (a
  // frame-by-frame playback or a drag on the timeline would otherwise send
  // one per frame; a plain debounce would never fire while playing). A stint
  // still growing after the brushed end can still change which laps of the
  // range are slow outliers, so the fit is re-asked then too; it is final
  // once its inputs stop changing.
  refreshDegradationRegression: () => {
    if (_degradationRefreshTimer != null) return; // the pending one reads the clock when it fires
    if (!degradationRefreshParams(get())) return;
    _degradationRefreshTimer = setTimeout(() => {
      _degradationRefreshTimer = null;
      const params = degradationRefreshParams(get());
      if (params) get().fetchDegradationRegression(params);
    }, DEGRADATION_REFRESH_MS);
  },

  // The selection pcaStrategyAnalysis answers (the panel shows an analysis
  // only for the selection on screen), the error of the last request, and the
  // request sequence: only the newest request's answer is kept
  pcaAnalysisIds: null,
  pcaAnalysisError: null,
  _pcaAnalysisSeq: 0,

  // Session seconds of the clock the analysis's rows of the race on screen
  // are taken at (pcaRequestOf: Infinity = post-race, null = no race on
  // screen); laterClockReset drops an analysis from a later clock
  _pcaAnalysisAt: null,

  // Descriptive analysis of a lasso selection on the PCA biplot (POST
  // /api/pca/analyze-selection), at the biplot's clock (pcaRequestOf): the
  // rows, stints and stops of the race on screen stop at the replay clock
  // (none before the race), so the panel, the Strategy Timeline's pattern
  // rows and the insights never show its future.
  fetchPCAAnalysis: async (pointIds) => {
    const seq = (get()._pcaAnalysisSeq || 0) + 1;
    const req = pcaRequestOf(get());
    // the rows of the race on screen when asked (D7: sessionRequestGuard);
    // the post-race artefact (params null) is the same for every session
    const current = sessionRequestGuard(get);
    set({ _pcaAnalysisSeq: seq, pcaStrategyAnalysis: null, pcaAnalysisIds: null, pcaAnalysisError: null });
    try {
      const data = await api.analyzePCASelection(pointIds, req.params || {});
      if (get()._pcaAnalysisSeq !== seq || (req.params && !current())) return;
      // The clock moved back while the request ran: its rows are now future,
      // so the selection is asked again at the clock on screen
      if (req.at != null && req.at > sessionNowOf(get())) {
        get().fetchPCAAnalysis(pointIds);
        return;
      }
      set({ pcaStrategyAnalysis: data, pcaAnalysisIds: [...pointIds], _pcaAnalysisAt: req.at });
    } catch (e) {
      if (get()._pcaAnalysisSeq !== seq) return;
      console.error('PCA analysis failed', e);
      set({ pcaAnalysisError: e?.message || 'Analysis failed' });
    }
  },

  // The lap-time forecast of the focus driver (POST /api/predict/lstm), the
  // only writer of lstmPredictions, asked by a double-click on a driver (the
  // views focus the driver first). The request carries identifiers only
  // (utils/forecast.js forecastRequestOf: year, round, session type, driver,
  // the clock and the lap; a live feed with no cached race sends that
  // driver's lap rows): the backend builds the model window itself.
  // A clicked lap may be earlier than the replay, never later. The answer
  // lands only while it is still the latest request for the focus driver of
  // the session on screen (_forecastSeq, sessionRequestGuard) and the clock
  // has not moved back before the clock it was asked at.
  triggerPrediction: async (driver, lap) => {
    const s0 = get();
    if (!driver || !s0.sessionData || s0.isQualifyingReplay) return;
    // The forecast belongs to the focus driver: a double-click that toggled
    // the focus off asks nothing
    if (driver !== s0.focusDriver) return;
    const askedLap = Math.min(lap || s0.currentLap, s0.currentLap);
    const now = s0.getSessionNow();
    const body = forecastRequestOf(s0, { driver, lap: askedLap, sessionNow: now });
    if (!body) return;

    const seq = ++_forecastSeq;
    const current = sessionRequestGuard(get);
    // Still the request on screen: the latest one, for the focus driver of the
    // session it was asked in (a focus change or a switch moved _forecastSeq on)
    const latest = () => seq === _forecastSeq && current() && get().focusDriver === driver;
    set({ predictionLoading: true, lastPredictionTrigger: { driver, lap: askedLap } });
    try {
      const result = await api.predictLSTM(body);
      if (!latest()) return;
      // The clock moved back while the request ran: its inputs are now future
      const entry = now > get().getSessionNow() ? null : forecastEntry(result, { driver, askedLap, at: now });
      set(entry
        ? { lstmPredictions: { [driver]: entry }, _lstmAt: now, predictionLoading: false }
        : { predictionLoading: false });
    } catch (e) {
      if (!latest()) return;
      console.error('Prediction failed:', e);
      set({ predictionLoading: false });
    }
  },

  updateRivalContext: () => {
    const { focusDriver, sessionData, currentLap, frameData, currentFrameIndex, isQualifyingReplay } = get();
    if (isQualifyingReplay) { set({ rivalContext: [], _rivalContextAt: null }); return; } // Not applicable for qualifying
    if (!focusDriver || !sessionData?.lap_times?.length || currentLap < 1) {
      set({ rivalContext: [], _rivalContextAt: null });
      return;
    }
    // Causal: positions and gaps of laps completed at sessionNow only (a lap
    // row's Position / GapToLeader are measured at the END of that lap).
    // _rivalContextAt = the clock it was computed at (see laterClockReset)
    const now = get().getSessionNow();
    const lapTimes = completedLaps(sessionData.lap_times, now);

    // Find each driver's latest position and data at currentLap
    const driverLatest = {};
    for (const lt of lapTimes) {
      if (lt.LapNumber > currentLap) continue;
      const drv = lt.Driver;
      if (!drv) continue;
      if (!driverLatest[drv] || lt.LapNumber > driverLatest[drv].LapNumber) {
        driverLatest[drv] = lt;
      }
    }

    const focusLt = driverLatest[focusDriver];
    if (!focusLt || !focusLt.Position) { set({ rivalContext: [], _rivalContextAt: now }); return; }
    const focusPos = focusLt.Position;

    // Get tyre info from frame data
    const frameDrivers = frameData?.frames?.[Math.min(currentFrameIndex, (frameData?.frames?.length || 1) - 1)]?.drivers || {};
    const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
    // Stint life per compound at now: the race's stint-life survival, the
    // estimate the Race Situation map and the race engine use (backlog P12)
    const stintLength = stintLifeEstimate(sessionData.lap_times, {
      sessionNow: now, running: stintsRunningOf(get()), dnfMap: get().dnfMap,
    });

    // Collect nearby rivals (2 ahead, 2 behind)
    const rivals = [];
    for (const [drv, lt] of Object.entries(driverLatest)) {
      if (drv === focusDriver || !lt.Position) continue;
      const posDiff = lt.Position - focusPos;
      if (Math.abs(posDiff) <= 2) {
        // Gap trend: compare gap over last 3 laps
        const recentGaps = [];
        for (let lap = Math.max(1, currentLap - 2); lap <= currentLap; lap++) {
          const fLap = lapTimes.find((l) => l.Driver === focusDriver && l.LapNumber === lap);
          const rLap = lapTimes.find((l) => l.Driver === drv && l.LapNumber === lap);
          if (fLap?.GapToLeader != null && rLap?.GapToLeader != null) {
            recentGaps.push(rLap.GapToLeader - fLap.GapToLeader);
          }
        }
        let gapTrend = 'stable';
        if (recentGaps.length >= 2) {
          const delta = recentGaps[recentGaps.length - 1] - recentGaps[0];
          if (delta < -0.3) gapTrend = 'closing';
          else if (delta > 0.3) gapTrend = 'opening';
        }

        // Tyre in force at now (R3, utils/driverState.js): the new set only
        // from the pit exit. The replay frames switch to it at the out-lap
        // start, inside the pit lane, so they are only the fallback.
        const st = driverStateAt(sessionData.lap_times, drv, now, { dnf: false });
        const fd = frameDrivers[drv];
        let compound;
        let tyreAge;
        if (st.stint) {
          compound = st.compound || 'UNKNOWN';
          tyreAge = st.tyreLife != null ? Math.round(st.tyreLife) : 0;
        } else {
          compound = fd ? (COMPOUND_NAMES[fd.tyre] || 'UNKNOWN') : (lt.Compound || 'UNKNOWN');
          tyreAge = fd?.tyre_life != null ? Math.round(fd.tyre_life) : (lt.TyreLife || 0);
        }

        // Laps until the set is due: the conditional median life of the
        // compound's stint-life survival at the age reached, minus that age
        // (raceSituationFeatures.js estimatedLapsToPit, the map's "Est. pit in")
        const pitEstimate = estimatedLapsToPit(stintLength, compound, tyreAge);
        const estPitIn = pitEstimate.laps;

        // Gap from focus driver
        const gap = (lt.GapToLeader != null && focusLt.GapToLeader != null)
          ? lt.GapToLeader - focusLt.GapToLeader
          : null;

        rivals.push({
          driver: drv,
          position: lt.Position,
          gap,
          gapTrend,
          compound,
          tyreAge,
          estPitIn,
          estPitInSource: pitEstimate.source,
        });
      }
    }

    rivals.sort((a, b) => a.position - b.position);
    set({ rivalContext: rivals, _rivalContextAt: now });
  },

  // ── Championship ────────────────────────────────────────────────
  championshipData: null,
  championshipLoading: false,
  championshipError: null,
  championshipView: 'drivers', // 'drivers' | 'constructors'
  showChampionshipPredictions: true,

  fetchChampionship: async (year, loadAll = false) => {
    if (!year) year = get().year;
    // An answer for an earlier pick (another season) is dropped (D7)
    const request = ++_latestRequest.championship;
    set({ championshipLoading: true, championshipError: null });
    try {
      const data = await api.getChampionship(year, loadAll);
      if (request !== _latestRequest.championship) return;
      set({ championshipData: data, championshipLoading: false });
    } catch (e) {
      if (request !== _latestRequest.championship) return;
      console.error('Failed to fetch championship', e);
      set({ championshipLoading: false, championshipError: e.message || 'Failed to load' });
    }
  },

  setChampionshipView: (view) => set({ championshipView: view }),
  toggleChampionshipPredictions: () => set((s) => ({ showChampionshipPredictions: !s.showChampionshipPredictions })),

  // ── PCA Embeddings ───────────────────────────────────────────
  pcaEmbeddings: null,
  // Session seconds of the clock the embeddings' rows of the race on screen
  // are taken at (pcaRequestOf), and the request sequence (the newest wins)
  _pcaEmbeddingsAt: null,
  _pcaEmbeddingsSeq: 0,

  // The biplot at the clock on screen (pcaRequestOf): during a replay of a
  // cached race its rows are those at the replay clock, projected on axes
  // fitted without it (backend pca_embeddings_at); post-race otherwise
  loadPCAEmbeddings: async () => {
    const seq = (get()._pcaEmbeddingsSeq || 0) + 1;
    const req = pcaRequestOf(get());
    // the race on screen when asked (D7: sessionRequestGuard); the post-race
    // artefact (params null) is the same for every session
    const current = sessionRequestGuard(get);
    set({ _pcaEmbeddingsSeq: seq });
    try {
      const data = await api.getPCAEmbeddings(req.params);
      if (get()._pcaEmbeddingsSeq !== seq || (req.params && !current())) return;
      // The clock moved back while the request ran: its rows are now future,
      // so they are asked again at the clock on screen
      if (req.at != null && req.at > sessionNowOf(get())) {
        get().loadPCAEmbeddings();
        return;
      }
      set({ pcaEmbeddings: data, _pcaEmbeddingsAt: req.at });
    } catch (e) {
      console.error('Failed to load PCA embeddings', e);
    }
  },

  // ── Monte Carlo Race Projection ──────────────────────────────────
  // The only writer of a computed raceProjection (S5): every view reads it
  // from here. It runs when the race situation changes (store subscription
  // below), after a clock jump, and when a view asks (RacePredictionPanel, on
  // something new known at the clock). The job (simulationJob) runs in the
  // simulation worker; requests with the same inputs and seed as the
  // projection held (or in flight) are not run again.
  // opts.replace (clock jump): when no projection can be computed at the new
  // clock, the held one is dropped instead of kept from another clock.
  raceProjection: null, // simulateRaceFinish result + { badges, computedAtNow, computedAtLap }
  computeRaceProjection: ({ replace = false } = {}) => {
    const job = simulationJob(get());
    const dropHeld = () => {
      if (replace && get().raceProjection) set({ raceProjection: null });
    };
    if (!job) {
      // Nothing to project at this clock: a result still on its way is dropped
      _projectionRequest = null;
      simulation.cancel('projection');
      dropHeld();
      return;
    }
    const last = _projectionRequest;
    if (sameSimulationJob(last, job)) {
      if (last.pending) return;
      if (last.result === null) { dropHeld(); return; }
      if (get().raceProjection === last.result) return;
    }
    const request = { ...job, pending: true, result: undefined };
    _projectionRequest = request;
    simulation.request('projection', 'project', job.params, (result, error) => {
      request.pending = false;
      if (_projectionRequest !== request) return;
      const s = get();
      // The state it was computed for is gone (another session, a seek back):
      // a newer request follows, or nothing is projected there
      if (s.raceSituationData !== job.rsd || sessionNowOf(s) < job.now) {
        _projectionRequest = null;
        return;
      }
      if (error) console.error('Monte Carlo projection failed', error);
      if (!result) {
        request.result = null;
        dropHeld();
        return;
      }
      // Badge states (utils/simulationClient.js withBadges / projectionBadges):
      // a badge, the finishing position shown, the row order, the battle list
      // and the risk rows change only on evidence beyond the Monte Carlo
      // error; inside it, the state of the projection held now (an earlier
      // clock) is kept
      request.result = {
        ...withBadges(result, s.raceProjection?.badges, {
          driverFeatures: job.params.driverFeatures, currentLap: job.currentLap, maxLap: job.params.maxLap,
        }),
        // Session seconds of the clock it was computed at (laterClockReset)
        computedAtNow: job.now,
        computedAtLap: job.currentLap,
      };
      set({ raceProjection: request.result });
    });
  },

  // ── Strategy Simulator ───────────────────────────────────────────
  simulatorStrategy: null,   // { driver, stints: [{compound, lapStart, length}] }
  simulatorResult: null,     // { simProjection, baselineProjection, delta, ... } (runSimulation)
  simulatorComparisons: [],  // [{ label, stints, result }]
  // What the plan is compared with: null = the stop model (the race
  // projection's own stops), or a saved plan { label, stints }
  simulatorBaseline: null,
  isSimulatorActive: false,

  setSimulatorStrategy: (strategy) => set({ simulatorStrategy: strategy }),
  setSimulatorBaseline: (baseline) => {
    set({ simulatorBaseline: baseline?.stints?.length ? { label: baseline.label || null, stints: baseline.stints } : null });
    if (get().simulatorStrategy) get().runSimulation();
  },
  toggleSimulator: () => set((s) => ({ isSimulatorActive: !s.isSimulatorActive })),
  clearSimulator: () => set({
    simulatorStrategy: null, simulatorResult: null,
    simulatorComparisons: [], simulatorBaseline: null, isSimulatorActive: false,
  }),

  addSimulatorComparison: (label, stints, result) => set((s) => ({
    simulatorComparisons: [...s.simulatorComparisons, { label, stints, result }],
  })),

  applyPCAPattern: (strategy) => set({
    simulatorStrategy: strategy,
    isSimulatorActive: true,
  }),

  // What-if (S6): the plan's stops from the lap in progress on (in-lap +
  // compound, planFromStints), each charged a sampled pit loss, against the
  // baseline (simulatorBaseline: a saved plan, or the stop model), both runs
  // from the same seed and race parameters as the race projection (common
  // random numbers): an identical plan gives every difference exactly 0. The
  // past is the race's: the driver's laps, tyres and stops so far are real,
  // planned stops on laps already run are ignored. Other drivers keep the
  // stop model. No run outside race sessions (simulationJob, R7).
  runSimulation: () => {
    const { simulatorStrategy, simulatorBaseline } = get();
    if (!simulatorStrategy?.stints?.length) return;
    const job = simulationJob(get());
    if (!job) return;
    const driver = simulatorStrategy.driver;
    if (!driver || !job.params.driverFeatures[driver]) return;

    const plan = planFromStints(simulatorStrategy.stints);
    const basePlan = simulatorBaseline?.stints?.length ? planFromStints(simulatorBaseline.stints) : null;
    simulation.request('whatif', 'compare', { ...job.params, focusDriver: driver, plan, basePlan }, (result, error) => {
      const s = get();
      // Another session, or the clock moved back while it ran: its inputs are gone
      if (s.raceSituationData !== job.rsd || sessionNowOf(s) < job.now) return;
      if (error) console.error('What-if simulation failed', error);
      if (!result) return;
      // The Simulator's marks (verdict, the cards' P labels: whatIfMarks)
      // change only beyond the Monte Carlo error: inside it, the marks of the
      // result held now (an earlier clock) of the same what-if are kept. The
      // stop-model baseline is the race projection's row of the driver: its
      // card shows the panel's P label (the panel's chained labels, same rule)
      const key = whatIfKey(driver, plan, basePlan);
      const held = s.simulatorResult?.whatIfKey === key ? s.simulatorResult.marks : null;
      const markOpts = { stopModel: !basePlan, panelMode: s.raceProjection?.badges?.mode ?? null };
      set({
        simulatorResult: {
          driver,
          plan,
          basePlan,
          whatIfKey: key,
          baselineLabel: basePlan ? (simulatorBaseline.label || 'saved plan') : null,
          simProjection: result.simProjection,
          baselineProjection: result.baselineProjection,
          // position: baseline expected position - plan's (positive = the plan gains places)
          delta: result.delta,
          // the run-by-run position / podium / points differences ({mean, sd,
          // n} each) the marks are judged on (pairedDifferences)
          paired: result.paired,
          marks: whatIfMarks(result, held, markOpts),
          fullProjection: result.custom,
          seed: result.seed,
          numSimulations: result.numSimulations,
          // Session seconds of the clock it was computed at (laterClockReset)
          computedAtNow: job.now,
          computedAtLap: job.currentLap,
        },
      });
    });
  },
}), {
  name: 'f1-settings',
  partialize: (state) => ({
    theme: state.theme,
    tempUnit: state.tempUnit,
    speedUnit: state.speedUnit,
    playSpeed: state.playSpeed,
    showDashboard: state.showDashboard,
    openOverlays: state.openOverlays,
    telemetryChannels: state.telemetryChannels,
    year: state.year,
    sessionType: state.sessionType,
    raceTraceReference: state.raceTraceReference,
    raceTraceWindow: state.raceTraceWindow,
  }),
  onRehydrateStorage: () => (state) => {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (state) state.theme = 'dark';
  },
}));

// Wire the api client's health interceptor now that the store exists.
setHealthReporter(
  () => useF1Store.getState().reportBackendOk(),
  (msg) => useF1Store.getState().reportBackendError(msg),
);

// A run-time demo (the backend did not answer, utils/apiClient.js) is never
// silent: a toast says the static demo answers and what needs the backend,
// until the backend answers again (the weather bar also shows a DEMO chip)
export const DEMO_FALLBACK_TOAST_ID = 'demo-fallback';
useDemoMode.subscribe((d, prev) => {
  const on = d.active && d.source === 'fallback';
  const wasOn = prev.active && prev.source === 'fallback';
  if (on && !wasOn) {
    useF1Store.getState().pushToast({
      id: DEMO_FALLBACK_TOAST_ID,
      kind: 'warn',
      message: `Backend unreachable: switched to the static demo. ${DEMO_NOTE.replace(/^Static demo: /, '')}`,
      timeout: 0,
    });
  } else if (!on && wasOn) {
    useF1Store.getState().dismissToast(DEMO_FALLBACK_TOAST_ID);
  }
});

// The Monte Carlo projection follows the race situation it is computed from:
// whenever raceSituationData changes (a new lap's features, a clock jump, a
// reset, a new session), computeRaceProjection runs. When nothing can be
// projected for the new state, a projection held from an earlier clock stays
// (laterClockReset has already dropped any from a later one).
useF1Store.subscribe((state, prev) => {
  if (state.raceSituationData !== prev.raceSituationData) state.computeRaceProjection();
});
