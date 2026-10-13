import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as api from '../utils/apiClient';
import { setHealthReporter } from '../utils/apiClient';
import { setSessionDriverColors } from '../utils/colors';
import { computePCA, procrustesAlign2D } from '../utils/livePCA';
import { extractRaceSituationFeatures, FEATURE_NAMES } from '../utils/raceSituationFeatures';
import { simulateRaceFinish } from '../utils/raceSimulation';
import {
  computeSessionTimeOffset, resolveSessionNow, completedLaps, lapStartTime, lapEndTime,
  raceClockLimit,
} from '../utils/raceTime';
import { deriveStints, pitStops, stintsRunning } from '../utils/stints';
import { driverStateAt } from '../utils/driverState';
import { viewSessionType } from '../utils/strategyViews';
import { WINDOW_PRESETS } from '../utils/windowPresets';
import { SLOT_IDS } from '../utils/slotOptions';

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

/**
 * The store's causal "now" in SESSION seconds for a state object (see
 * utils/raceTime.js resolveSessionNow; hooks/useSessionNow.js is the React
 * twin). A qualifying segment's last frame is not the end of the session (the
 * next segments follow), so the "last frame = Infinity" rule is not applied
 * during a qualifying replay.
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
    maxTime: s.isQualifyingReplay ? undefined : s.maxTime,
    frameDt: s.frameDt,
    raceOver: s.lapModeRaceOver,
  });
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

/* ── Clock-derived analytics ───────────────────────────────────── */

/**
 * State to drop at a clock change: every clock-derived analytic computed at
 * a LATER session time than `now` (each one carries the session time it was
 * computed at). Used in the same set() as the clock change, so no view and no
 * Gemini context ever reads values from a later clock; the analytics are then
 * recomputed at the new clock.
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
  const deg = s.degradationRegression;
  if (later(deg?.computedAtNow)) {
    // A brushed fit stays (re-stamped) only while every lap it used is still
    // completed at now; anything else is re-derived by
    // refreshDegradationRegression at the new clock
    const req = s._degradationRequest;
    const sameRequest = !!req && deg.lap_start === req.lap_start && deg.lap_end === req.lap_end;
    const keep = sameRequest && deg.slope != null && Number.isFinite(deg.lap_end_used)
      && deg.lap_end_used <= lastCompletedLap(s.sessionData?.lap_times, now, req.drivers);
    out.degradationRegression = keep ? { ...deg, computedAtNow: now } : null;
    // A dropped result of the active request is re-requested at the new clock
    if (!keep && req) out._degradationRequest = { ...req, lap_end_used: null };
  }
  return out;
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
 * @returns {string}
 */
export function degradationGapReason(lapTimes, drivers, now, lapStart, dnfMap = {}) {
  const notes = [];
  for (const drv of Array.isArray(drivers) ? drivers : []) {
    const rows = (lapTimes || []).filter((r) => r?.Driver === drv && Number.isFinite(Number(r.LapNumber)));
    if (!rows.length) {
      notes.push(`No lap data for ${drv}`);
      continue;
    }
    const lastLap = Math.max(...rows.map((r) => Number(r.LapNumber)));
    if (lastLap >= lapStart) continue;
    const state = driverStateAt(lapTimes, drv, now, dnfMap[drv] ? { dnf: dnfMap[drv] } : {});
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
 * Replay-time origin (session seconds) of every qualifying segment, in
 * segment order (Q1, Q2, Q3), see qualiSegmentOrigin. null for a segment
 * whose laps cannot be matched within QUALI_ORIGIN_TOLERANCE_S.
 *
 * @param {Array<Object>} lapTimes
 * @param {Object} segments - /api/frames `segments` ({Q1: {...}, Q2: {...}, Q3: {...}})
 * @returns {Object<string, number|null>}
 */
export function qualiSegmentOffsets(lapTimes, segments) {
  const out = {};
  let after = -Infinity;
  for (const seg of ['Q1', 'Q2', 'Q3']) {
    if (!segments?.[seg]) continue;
    const found = qualiSegmentOrigin(lapTimes, segments[seg], { after });
    out[seg] = found && found.error <= QUALI_ORIGIN_TOLERANCE_S ? found.origin : null;
    if (found && out[seg] != null) after = found.end;
  }
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
  'ai',
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

// Module-level generation counter for loadSession to prevent stale async
// responses. Every switch of what the dashboard shows (a session load, entering
// or leaving live mode, the reset to the selector) starts a new generation, so
// a historical load still in flight (its frames, circuit, strategy, analytics)
// can never land on the session that replaced it.
let _sessionLoadGeneration = 0;

// Generation counter for degradation requests: a replay re-request must not be
// overwritten by an older response that arrives late.
let _degradationGeneration = 0;

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
  lapModeRaceOver: false,
});

function cancelClockJump() {
  if (_clockJumpTimer != null) clearTimeout(_clockJumpTimer);
  _clockJumpTimer = null;
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
  schedule: [],
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
    // Skip if schedule already loaded for this year
    const s = get();
    if (s.schedule.length > 0 && s.year === year) return;
    _scheduleYear = year;
    _schedulePromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.getSchedule(year);
          set({ schedule: data.events || [], year });
          return;
        } catch (e) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            continue;
          }
          console.error('Failed to fetch schedule', e);
        }
      }
    })();
    _schedulePromise.finally(() => { _schedulePromise = null; _scheduleYear = null; });
    return _schedulePromise;
  },

  fetchDriversPreview: async (year, round) => {
    if (!year || !round) return;
    set({ previewDriversLoading: true, previewDrivers: [], preSelectedDrivers: [] });
    try {
      const data = await api.getDrivers(year, round);
      set({ previewDrivers: data.drivers || [], previewDriversLoading: false });
    } catch (e) {
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

    // If switching from live mode, disconnect first
    if (get().isLiveMode) {
      try {
        const { liveWS } = await import('../utils/liveWebSocket');
        liveWS.disconnect();
        await api.stopMockReplay().catch(() => {});
      } catch (_) { /* ignore */ }
      set({
        isLiveMode: false,
        liveConnected: false,
        liveSessionInfo: null,
        liveConnectionStatus: 'disconnected',
        liveStandings: null,
        raceControlMessages: [],
        teamRadios: [],
        totalRaceLaps: null,
        liveTelemetry: {},
      });
    }

    // Increment generation counter to invalidate any in-flight loads
    const generation = ++_sessionLoadGeneration;
    cancelClockJump();

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
      const dnfMap = {};
      (data.race_results || []).forEach((r) => {
        const abbr = r.Abbreviation;
        if (!abbr) return;
        const cp = String(r.ClassifiedPosition || '');
        // "R" = retired, "D" = disqualified, "E" = excluded, "W" = withdrawn, "N" = not classified
        if (cp === 'R' || cp === 'D' || cp === 'E' || cp === 'W' || cp === 'N') {
          dnfMap[abbr] = {
            status: r.Status || 'Retired',
            lastLap: r.Laps || computedMaxLap,
            classifiedPosition: cp,
          };
        }
      });

      // Apply pre-selected drivers if any
      const preSelected = get().preSelectedDrivers;

      // Refresh the live driver→team-colour map from this session's
      // driver_info so per-driver colours track the actual lineup
      // (e.g. HAM = Ferrari red in 2025, not the static Mercedes teal).
      setSessionDriverColors(data.driver_info || []);

      const sessionTimeOffset = computeSessionTimeOffset(lapTimes);
      set({
        sessionData: data,
        loadedSessionType: sessionType,
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
        // Reset race situation state from previous session
        raceSituationLap: null,
        raceSituationData: null,
        raceProjection: null,
        simulatorStrategy: null, simulatorResult: null, simulatorComparisons: [], isSimulatorActive: false,
        _prevPcaResult: null,
        lstmPredictions: null,
        _lstmAt: null,
        lastPredictionTrigger: null,
        rivalContext: [],
        _rivalContextAt: null,
        degradationRegression: null,
        // Clear qualifying state from previous session
        qualiSegments: null,
        qualiSegment: 'Q3',
        isQualifyingReplay: false,
        ...(preSelected.length > 0 ? { selectedDrivers: preSelected } : {}),
      });

      // Load circuit, strategy, frames, and analytics in parallel
      // For qualifying: skip strategy (irrelevant), load frames eagerly
      const current = () => generation === _sessionLoadGeneration;
      const parallelTasks = [
        api.getCircuit(year, round).then((circuit) => { if (current()) set({ circuitInfo: circuit }); }),
      ];

      if (sessionType !== 'Q') {
        parallelTasks.push(
          api.getStrategy(year, round)
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

      // Compute maxLap
      const lapTimes = snapshot.lap_times || [];
      let computedMaxLap = 1;
      for (const lt of lapTimes) {
        if (lt.LapNumber && lt.LapNumber > computedMaxLap) computedMaxLap = lt.LapNumber;
      }

      // Load circuit info if available
      let circuitInfo = snapshot.circuit_info || null;
      // If circuit_info exists but has no track_coordinates, it's metadata only
      if (circuitInfo && !circuitInfo.track_coordinates) {
        circuitInfo = null;
      }

      // Live mode: same dynamic colour-map refresh.
      setSessionDriverColors(snapshot.driver_info || []);

      // Pre-fill dnfMap from snapshot.driver_statuses so already-retired
      // drivers show as DNF the moment a viewer connects mid-race.
      const initialDnfMap = {};
      for (const ds of snapshot.driver_statuses || []) {
        if (!ds?.Driver) continue;
        if (ds.Retired || ds.Stopped || ds.KnockedOut) {
          initialDnfMap[ds.Driver] = {
            status: ds.Status || (ds.Retired ? 'Retired' : ds.Stopped ? 'Stopped' : 'Out'),
            lastLap: ds.LastLap ?? status.current_lap ?? computedMaxLap,
            classifiedPosition: 'R',
          };
        }
      }

      cancelClockJump();
      const snapshotStatus = snapshot.track_status || [];
      set({
        isLiveMode: true,
        liveSessionInfo: status.session_info || null,
        sessionData: snapshot,
        loadedSessionType: null, // live: the feed's SessionInfo gives the type
        sessionTimeOffset: computeSessionTimeOffset(lapTimes),
        drivers: snapshot.driver_info || [],
        trackStatus: snapshotStatus,
        // The feed's latest track status (live times are not on the session clock)
        currentFlagStatus: String(snapshotStatus[snapshotStatus.length - 1]?.status || '1'),
        raceControlMessages: snapshot.race_control_messages || [],
        teamRadios: snapshot.team_radios || [],
        maxLap: computedMaxLap,
        currentLap: status.current_lap || computedMaxLap,
        totalRaceLaps: status.total_laps || null,
        isPlaying: false,
        ...REPLAY_CLOCK_RESET,
        isLoadingFrames: false,
        circuitInfo,
        dnfMap: initialDnfMap,
        telemetryCache: {},
        lstmPredictions: null,
        _lstmAt: null,
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
            });
            console.log(`Full session loaded: ${fullLapTimes.length} lap entries, ${fullMaxLap} laps`);
          }
        } catch (e) {
          console.warn('Could not load full session data:', e.message);
        }
      }

      // Connect WebSocket for incremental updates
      if (superseded()) return;
      liveWS.connect(
        (msg) => get()._handleLiveMessage(msg),
        (statusVal) => set({
          liveConnected: statusVal === 'connected',
          liveConnectionStatus: statusVal,
        }),
      );

      set({ isLoading: false });
    } catch (e) {
      if (superseded()) return;
      set({ isLoading: false, error: e.message });
      console.error('Failed to enter live mode', e);
    }
  },

  exitLiveMode: async () => {
    // Nothing still in flight (a live entry, an older historical load) may
    // land after the exit
    ++_sessionLoadGeneration;
    const { liveWS } = await import('../utils/liveWebSocket');
    liveWS.disconnect();

    // Stop mock replay if running
    try { await api.stopMockReplay(); } catch (_) { /* ignore */ }

    cancelClockJump();
    set({
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
      lstmPredictions: null,
      _lstmAt: null,
      rivalContext: [],
      _rivalContextAt: null,
    });
  },

  _handleLiveMessage: (msg) => {
    const { type, data } = msg;
    const state = get();

    switch (type) {
      case 'session_init': {
        // Full snapshot on connect — already handled by enterLiveMode
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

        // Trigger LSTM predictions every 2 laps
        if (updatedMaxLap > 2 && updatedMaxLap % 2 === 0 && state.triggerLSTMPredictions) {
          state.triggerLSTMPredictions();
        }

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

      case 'weather_update': {
        const weather = [...(state.sessionData?.weather_data || []), data];
        set({ sessionData: { ...state.sessionData, weather_data: weather } });
        break;
      }

      case 'track_status': {
        // Live times are wall-clock, not session seconds, and live lap rows
        // carry no lap windows: the change is stamped with the lap count in
        // force when it arrives (the feed's LapCount = the leader's lap), and
        // closes the previous period on that lap (hooks/useReplayEngine.js
        // buildTrackStatusEvents places live periods with these stamps)
        const lap = Number(state.currentLap) || 1;
        const prev = state.trackStatus;
        const closed = prev.length && prev[prev.length - 1].end_lap == null
          ? [...prev.slice(0, -1), { ...prev[prev.length - 1], end_lap: lap }]
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

  closeAllOverlays: () => set({
    openOverlays: [],
    activeTab: 'pitwall',
    overlayTiles: {},
    overlayVizMapping: {},
    dockedLayout: null,
    _arrangeIdx: 0,
  }),

  cycleOverlay: (direction = 1) => set((s) => {
    if (s.openOverlays.length === 0) return s;
    const idx = s.openOverlays.indexOf(s.activeTab);
    const len = s.openOverlays.length;
    const next = s.openOverlays[((idx === -1 ? 0 : idx) + direction + len) % len];
    return { activeTab: next };
  }),

  // ── Gemini floating panel ─────────────────────────────────────
  geminiPanelOpen: false,
  toggleGeminiPanel: () => set((s) => ({ geminiPanelOpen: !s.geminiPanelOpen })),

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
    set({
      sessionData: null,
      loadedSessionType: null,
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
      lstmPredictions: null,
      _lstmAt: null,
      predictionLoading: false,
      lastPredictionTrigger: null,
      degradationRegression: null,
      pcaStrategyAnalysis: null,
      raceSituationData: null,
      raceSituationLap: null,
      raceProjection: null,
      simulatorResult: null,
      _prevPcaResult: null,
      rivalContext: [],
      _rivalContextAt: null,
      geminiMessages: [],
      geminiOverlays: [],
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
  selectedLapRange: null, // [startLap, endLap]
  brushLapRange: null, // [startLap, endLap] — set by PositionByLap brush, consumed by LapTimeChart
  setBrushLapRange: (range) => set({ brushLapRange: range }),
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
    set((s) => {
      // Toggle: if same driver, clear focus
      if (s.focusDriver === abbreviation) {
        return { focusDriver: null, focusTeam: null, watchedRivals: [], lapDeltaBaseDriver: null, lstmPredictions: null };
      }
      // Look up the driver's team from the loaded driver_info
      const driverInfo = s.drivers.find((d) => d.Abbreviation === abbreviation);
      const team = driverInfo?.TeamName || null;
      return {
        focusDriver: abbreviation,
        focusTeam: team,
        watchedRivals: [],
        lapDeltaBaseDriver: abbreviation,
      };
    });
    // Trigger LSTM predictions and rival context for the newly focused driver (race only)
    if (get().focusDriver && !get().isQualifyingReplay) {
      get().triggerLSTMPredictions();
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
  setSelectedLapRange: (range) => set({ selectedLapRange: range }),
  setSelectedPCAPoints: (ids) => set({ selectedPCAPoints: ids }),

  clearSelection: () =>
    set({
      selectedDrivers: [],
      highlightedDriver: null,
      highlightedDriverPosition: null,
      selectedLapRange: null,
      selectedPCAPoints: [],
      focusDriver: null,
      focusTeam: null,
      watchedRivals: [],
      lapDeltaBaseDriver: null,
      selectedStint: null,
      highlightedCompound: null,
    }),

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

      // Re-trigger LSTM predictions every 2 laps during replay (skip for qualifying)
      if (!state.isQualifyingReplay && !jumped && maxLapInFrame >= 3) {
        const lapChanged = maxLapInFrame !== prevLap;
        const shouldPredict = lapChanged && maxLapInFrame % 2 === 0;

        // Also trigger after the focus driver's pit stop: a tyre change
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

        // Also trigger when flag transitions from SC/VSC back to green
        // (checked on every frame: the change rarely falls on a lap change)
        const prevFlag = state.currentFlagStatus;
        const newFlag = updates.currentFlagStatus ?? prevFlag;
        const flagTrigger = newFlag === '1' && (prevFlag === '4' || prevFlag === '6' || prevFlag === '7');

        if (shouldPredict || pitTrigger || flagTrigger) {
          setTimeout(() => {
            get().triggerLSTMPredictions();
            get().updateRivalContext();
            get().computeRaceSituation();
          }, 0);
        } else if (lapChanged) {
          // Always update rival context and race situation on lap change
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
      s.triggerLSTMPredictions();
      if (s.isSimulatorActive && s.simulatorStrategy) s.runSimulation();
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
    const { year, round, sessionType } = get();
    if (!year || !round) return;
    // A newer loadSession discards these frames (they belong to another session)
    const generation = _sessionLoadGeneration;
    set({ isLoadingFrames: true });
    try {
      const data = await api.getFrames(year, round, sessionType);
      if (generation !== _sessionLoadGeneration) return;

      // ── Qualifying: response has { segments: { Q1: {...}, Q2: {...}, Q3: {...} } }
      if (data.segments) {
        const segments = data.segments;
        const defaultSeg = segments.Q3 ? 'Q3' : segments.Q2 ? 'Q2' : 'Q1';
        const activeData = segments[defaultSeg];
        // Each segment's frames have their own replay origin (session seconds)
        const offsets = qualiSegmentOffsets(get().sessionData?.lap_times, segments);

        if (!activeData?.frames?.length) {
          set({
            isLoadingFrames: false, qualiSegments: segments, isQualifyingReplay: true,
            qualiSegmentOffsets: offsets, lapModeRaceOver: false,
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
      Object.assign(updates, laterClockReset(state, sessionNowOf({ ...state, ...updates })));
      set(updates);
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
    const { year, round } = get();
    if (!year || !round) return;
    try {
      const data = await api.getPositions(year, round);
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
    const { year, round } = get();
    if (!year || !round) return;
    // Results of a session the dashboard has since left are discarded
    const generation = _sessionLoadGeneration;
    const [sectors, consistency, speed] = await Promise.allSettled([
      api.getSectors(year, round),
      api.getConsistency(year, round),
      api.getSpeedRankings(year, round),
    ]);
    if (generation !== _sessionLoadGeneration) return;
    set({
      sectorRankings: sectors.status === 'fulfilled' ? sectors.value : null,
      consistencyData: consistency.status === 'fulfilled' ? consistency.value : null,
      speedRankings: speed.status === 'fulfilled' ? speed.value : null,
    });
  },

  // ── Telemetry Strip ──────────────────────────────────────────────
  telemetryCache: {},              // { "VER-12": [{Distance, Speed, Throttle, Brake, nGear, ...}] }
  telemetryCompareMode: 'drivers', // 'drivers' | 'laps'
  telemetryCompareLaps: [],        // [12, 23, 36] for laps mode
  telemetryLoading: false,

  fetchDriverTelemetry: async (driver, lap) => {
    const sessionType = get().isQualifyingReplay ? 'Q' : 'R';
    const key = `${driver}-${lap}-${sessionType}`;
    if (get().telemetryCache[key]) return get().telemetryCache[key];

    const { year, round } = get();
    if (!year || !round) return null;

    set({ telemetryLoading: true });
    try {
      const data = await api.getTelemetry(year, round, driver, lap, sessionType);
      const telemetry = data.telemetry || [];
      set((s) => ({
        telemetryCache: { ...s.telemetryCache, [key]: telemetry },
        telemetryLoading: false,
      }));
      return telemetry;
    } catch (e) {
      console.error(`Telemetry fetch failed for ${key}:`, e);
      set({ telemetryLoading: false });
      return null;
    }
  },

  setTelemetryCompareMode: (mode) => set({ telemetryCompareMode: mode }),
  setTelemetryCompareLaps: (laps) => set({ telemetryCompareLaps: laps }),

  // ── Race Situation Map ──────────────────────────────────────────
  raceSituationData: null,
  raceSituationLap: null,
  _prevPcaResult: null, // for sign consistency across recomputes

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
    });

    if (!result) {
      set({ raceSituationData: null, raceSituationLap: currentLap });
      followProjection();
      return;
    }

    const pcaResult = computePCA(result.matrix, FEATURE_NAMES, _prevPcaResult);
    if (!pcaResult) {
      set({ raceSituationData: null, raceSituationLap: currentLap });
      followProjection();
      return;
    }

    // Procrustes alignment: only needed during warmup (before basis is frozen).
    // Once frozen, axes are stable — Procrustes would just add noise.
    const isFrozen = pcaResult._frozen?.callCount > 8;
    const prevData = get().raceSituationData;
    let alignedScores = pcaResult.scores;
    if (!isFrozen && prevData?.scores?.length && prevData?.driverAbbrs?.length) {
      // Build matched point pairs (drivers present in both frames)
      const prevMap = {};
      prevData.driverAbbrs.forEach((abbr, i) => { prevMap[abbr] = prevData.scores[i]; });
      const refPts = [];
      const newPts = [];
      result.driverAbbrs.forEach((abbr, i) => {
        if (prevMap[abbr]) {
          refPts.push(prevMap[abbr]);
          newPts.push(pcaResult.scores[i]);
        }
      });
      alignedScores = procrustesAlign2D(refPts, newPts, pcaResult.scores);
    }

    set({
      raceSituationData: {
        driverAbbrs: result.driverAbbrs,
        scores: alignedScores,
        loadings: pcaResult.loadings,
        explainedVariance: pcaResult.explainedVariance,
        driverFeatures: result.driverFeatures,
        computedAtLap: currentLap,
        // Session seconds of the clock the features were computed at
        computedAtNow: now,
      },
      raceSituationLap: currentLap,
      _prevPcaResult: pcaResult,
    });

    // Monte Carlo projection: at once after a clock jump, otherwise every 3
    // laps (after lap 5)
    if (projection) {
      get().computeRaceProjection({ replace: true });
    } else if (currentLap >= 5 && currentLap % 3 === 0) {
      setTimeout(() => get().computeRaceProjection(), 0);
    }
  },

  // ── Predictions ────────────────────────────────────────────────
  lstmPredictions: null,
  degradationRegression: null,
  // Last degradation request as asked by the caller (lap_end = brushed end)
  // plus lap_end_used = the end actually sent (clamped to completed laps)
  _degradationRequest: null,
  pcaStrategyAnalysis: null,
  rivalContext: [],

  fetchLSTMPrediction: async (params) => {
    const reqNow = get().getSessionNow();
    try {
      const data = await api.predictLSTM(params);
      // The clock moved back while the request ran: its inputs are now future
      if (reqNow > get().getSessionNow()) return;
      set({ lstmPredictions: data, _lstmAt: reqNow });
    } catch (e) {
      console.error('LSTM prediction failed', e);
      set({ lstmPredictions: null, _lstmAt: null });
    }
  },

  fetchDegradationRegression: async (params) => {
    // Causal brush: the fit never reads a lap the replay has not completed.
    // lap_end is clamped to the requested drivers' last completed lap; the
    // response keeps echoing the requested range (lap_start / lap_end, as the
    // backend echoes its request) and adds the laps actually fitted:
    // lap_end_used = the last lap fitted, fitted_lap_range = [lap_start,
    // lap_end_used] (null when no lap of the range is fitted). A view labels
    // the fit with fitted_lap_range, not with the brushed lap_end.
    let sent = params;
    let data = null;
    // computedAtNow = the clock the fit belongs to (laterClockReset)
    const reqNow = get().getSessionNow();
    const ranged = params && Number.isFinite(params.lap_start) && Number.isFinite(params.lap_end);
    if (ranged) {
      const lapEndUsed = Math.min(params.lap_end, get().getLastCompletedLap(params.drivers));
      sent = { ...params, lap_end: lapEndUsed };
      set({ _degradationRequest: { ...params, lap_end_used: lapEndUsed } });
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
          ),
          computedAtNow: reqNow,
        };
      }
    }
    const generation = ++_degradationGeneration;
    try {
      if (!data) {
        data = await api.predictDegradation(sent);
        // A newer request (new brush or replay re-request) superseded this one
        if (generation !== _degradationGeneration) return;
        if (data && typeof data === 'object') {
          // Fitted on laps completed at reqNow; still all completed now when
          // no newer request was needed, so it belongs to the earlier clock
          data = { ...data, computedAtNow: Math.min(reqNow, get().getSessionNow()) };
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

  // Replay moved: re-issue the last brushed degradation fit when the laps it
  // may use changed (more laps completed, or a backward seek), while the same
  // brush is still active. Once the replay has passed the brushed end the
  // clamped end equals it and nothing is re-requested: the fit is final.
  refreshDegradationRegression: () => {
    const s = get();
    const req = s._degradationRequest;
    if (!req) return;
    const active = s.brushLapRange || s.selectedLapRange;
    if (!active || active[0] !== req.lap_start || active[1] !== req.lap_end) return;
    const lapEndUsed = Math.min(req.lap_end, s.getLastCompletedLap(req.drivers));
    // Same laps as the last request: nothing to do (laterClockReset clears
    // lap_end_used when it drops the result, so that one is re-derived)
    if (lapEndUsed === req.lap_end_used) return;
    const params = { ...req };
    delete params.lap_end_used;
    s.fetchDegradationRegression(params);
  },

  fetchPCAAnalysis: async (pointIds) => {
    try {
      const data = await api.analyzeTSNESelection(pointIds); // Backend endpoint still named tsne — kept for compatibility
      set({ pcaStrategyAnalysis: data });
    } catch (e) {
      console.error('PCA analysis failed', e);
    }
  },

  triggerLSTMPredictions: async () => {
    const { year, round, currentLap, maxLap, focusDriver, selectedDrivers, sessionData, isQualifyingReplay } = get();
    if (isQualifyingReplay) return; // LSTM predictions not applicable for qualifying
    if (!sessionData?.lap_times?.length || currentLap < 2) return;

    const driver = focusDriver || selectedDrivers[0];
    if (!driver) return;

    // Causal: only laps completed at sessionNow (not the unfinished current lap)
    const now = get().getSessionNow();
    const driverLaps = completedLaps(sessionData.lap_times, now)
      .filter(d => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .slice(-10);

    if (driverLaps.length < 3) return;

    // Track temperature at sessionNow (30 = fallback when no weather row)
    const trackTemp = weatherAtSessionTime(sessionData.weather_data, now)?.TrackTemp ?? 30;

    const last_10_laps = driverLaps.map(d => ({
      lap_time: d.LapTimeSeconds,
      tyre_life: d.TyreLife || 0,
      compound: d.Compound || 'UNKNOWN',
      sector1: d.Sector1TimeSeconds || 0,
      sector2: d.Sector2TimeSeconds || 0,
      sector3: d.Sector3TimeSeconds || 0,
      position: d.Position || 10,
      gap_to_leader: d.GapToLeader || 0,
      gap_ahead: 0,
      fuel_estimate: maxLap > 0 ? (maxLap - d.LapNumber + 1) / maxLap : 0.5,
      track_temp: trackTemp,
      drs: 0,
      lap_number: d.LapNumber,
    }));

    try {
      const data = await api.predictLSTM({
        last_10_laps,
        driver,
        year,
        round,
        current_lap: currentLap,
        max_lap: maxLap,
      });
      // The clock moved back while the request ran: its inputs are now future
      if (now > get().getSessionNow()) return;
      set({ lstmPredictions: data, _lstmAt: now });
    } catch (e) {
      console.error('LSTM prediction failed', e);
      set({ lstmPredictions: null, _lstmAt: null });
    }
  },

  triggerPrediction: async (driver, lap) => {
    const { year, round, maxLap, sessionData, isQualifyingReplay } = get();
    if (!year || !round || !driver) return;
    if (isQualifyingReplay) return;

    // A clicked lap may be earlier than the replay, never later; and only
    // laps completed at sessionNow are sent (no future lap times).
    const currentLap = Math.min(lap || get().currentLap, get().currentLap);
    const now = get().getSessionNow();
    const lapTimes = sessionData?.lap_times || [];
    const driverLaps = completedLaps(lapTimes, now)
      .filter(d => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .slice(-10);

    if (driverLaps.length < 3) return;

    // Track temperature at sessionNow (30 = fallback when no weather row)
    const trackTemp = weatherAtSessionTime(sessionData?.weather_data, now)?.TrackTemp ?? 30;

    const last_10_laps = driverLaps.map(d => ({
      lap_time: d.LapTimeSeconds,
      tyre_life: d.TyreLife || 0,
      compound: d.Compound || 'UNKNOWN',
      sector1: d.Sector1TimeSeconds || 0,
      sector2: d.Sector2TimeSeconds || 0,
      sector3: d.Sector3TimeSeconds || 0,
      position: d.Position || 10,
      gap_to_leader: d.GapToLeader || 0,
      gap_ahead: 0,
      fuel_estimate: maxLap > 0 ? (maxLap - d.LapNumber + 1) / maxLap : 0.5,
      track_temp: trackTemp,
      drs: 0,
      lap_number: d.LapNumber,
    }));

    set({ predictionLoading: true, lastPredictionTrigger: { driver, lap: currentLap } });
    try {
      const result = await api.predictLSTM({
        last_10_laps,
        driver,
        year,
        round,
        current_lap: currentLap,
        max_lap: maxLap,
      });
      // The clock moved back while the request ran: its inputs are now future
      if (now > get().getSessionNow()) {
        set({ predictionLoading: false });
        return;
      }
      set((s) => ({
        lstmPredictions: { ...s.lstmPredictions, [driver]: result },
        _lstmAt: Math.max(now, s._lstmAt ?? -Infinity),
        predictionLoading: false
      }));
    } catch (e) {
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

        // Estimated laps until pit (rough: avg stint for compound - current age)
        const AVG_STINT = { SOFT: 18, MEDIUM: 28, HARD: 40, INTERMEDIATE: 25, WET: 20, UNKNOWN: 25 };
        const estPitIn = Math.max(0, (AVG_STINT[compound] || 25) - tyreAge);

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
    set({ championshipLoading: true, championshipError: null });
    try {
      const data = await api.getChampionship(year, loadAll);
      set({ championshipData: data, championshipLoading: false });
    } catch (e) {
      console.error('Failed to fetch championship', e);
      set({ championshipLoading: false, championshipError: e.message || 'Failed to load' });
    }
  },

  setChampionshipView: (view) => set({ championshipView: view }),
  toggleChampionshipPredictions: () => set((s) => ({ showChampionshipPredictions: !s.showChampionshipPredictions })),

  // ── PCA Embeddings ───────────────────────────────────────────
  pcaEmbeddings: null,

  loadPCAEmbeddings: async () => {
    try {
      const data = await api.getPCAEmbeddings();
      set({ pcaEmbeddings: data });
    } catch (e) {
      console.error('Failed to load PCA embeddings', e);
    }
  },

  // ── Gemini ────────────────────────────────────────────────────
  geminiMessages: [],
  geminiOverlays: [],

  sendGeminiQuery: async (query) => {
    // Causal context: weather, stints, laps and every analytic as of
    // sessionNow. Nothing computed at a later clock may reach the prompt
    // (clock changes already drop it; this is the guard at the boundary).
    const now = get().getSessionNow();
    const stale = laterClockReset(get(), now);
    if (Object.keys(stale).length) set(stale);
    const { year, round, currentLap, maxLap, selectedDrivers, focusDriver,
            lstmPredictions, raceProjection, raceSituationData,
            degradationRegression, simulatorResult, pcaStrategyAnalysis,
            rivalContext, sessionData } = get();
    set((s) => ({
      geminiMessages: [
        ...s.geminiMessages,
        { role: 'user', content: query },
      ],
    }));

    // Build rich race context from ALL analytical sources
    const raceContext = {};

    // Session info
    if (sessionData?.session_info) raceContext.session = sessionData.session_info;
    const weatherNow = weatherAtSessionTime(sessionData?.weather_data, now);
    if (weatherNow) raceContext.weather = weatherNow;

    // Monte Carlo projections
    if (raceProjection) {
      raceContext.monteCarloProjections = (raceProjection.projections || []).slice(0, 10).map((p) => ({
        driver: p.driver, currentPos: p.currentPos, expectedPos: p.expectedPos,
        modePos: p.modePos, posRange: p.posRange,
        podiumProb: p.podiumProb, pointsProb: p.pointsProb,
      }));
      raceContext.battles = (raceProjection.battles || []).slice(0, 5).map((b) => ({
        driver1: b.ahead, driver2: b.behind,
        overtakeProb: b.prob, type: b.behindCompound + ' vs ' + b.aheadCompound,
      }));
      raceContext.risks = (raceProjection.risks || []).slice(0, 5);
      if (raceProjection.raceParams) {
        raceContext.raceParams = {
          pitLoss: raceProjection.raceParams.pitLoss,
          scRate: raceProjection.raceParams.scRate,
          lapNoise: raceProjection.raceParams.lapNoise,
        };
      }
    }

    // Driver features from live PCA
    if (raceSituationData?.driverFeatures && selectedDrivers.length > 0) {
      const feats = {};
      for (const d of selectedDrivers) {
        if (raceSituationData.driverFeatures[d]) feats[d] = raceSituationData.driverFeatures[d];
      }
      if (Object.keys(feats).length > 0) raceContext.driverFeatures = feats;
    }

    // Degradation regression
    if (degradationRegression) {
      raceContext.degradationRegression = degradationRegression;
    }

    // Simulator what-if result
    if (simulatorResult) {
      raceContext.simulator = {
        customPos: simulatorResult.simProjection?.expectedPos,
        baselinePos: simulatorResult.baselineProjection?.expectedPos,
        delta: simulatorResult.delta,
      };
    }

    // PCA cluster strategy patterns
    if (pcaStrategyAnalysis?.strategies?.length) {
      raceContext.pcaPatterns = pcaStrategyAnalysis.strategies.slice(0, 3);
    }

    // Rival context for focus driver
    if (rivalContext?.length) {
      raceContext.rivals = rivalContext.slice(0, 4);
    }

    // LSTM predictions for focus driver
    const target = focusDriver || (selectedDrivers.length === 1 ? selectedDrivers[0] : null);
    if (target && lstmPredictions?.[target]) {
      const pred = lstmPredictions[target];
      raceContext.lstm = {
        driver: target,
        predictedTimes: pred.predicted_times,
        predictedLapTime: pred.predicted_lap_time,
        pitProbability: pred.pit_probability,
      };
    }

    // Tyre strategy summary for selected drivers: stints of the laps completed
    // at sessionNow (utils/stints.js, same shape as tyre_strategy), so an
    // ongoing stint reports its laps so far, never its final length
    const tyreStrats = sessionData?.lap_times?.length
      ? deriveStints(sessionData.lap_times, { sessionNow: now, running: stintsRunningOf(get()) })
      : (sessionData?.tyre_strategy || sessionData?.strategies || []);
    if (tyreStrats.length > 0) {
      const targetDrivers = selectedDrivers.length > 0 ? selectedDrivers : (target ? [target] : []);
      if (targetDrivers.length > 0) {
        raceContext.tyreStrategy = {};
        for (const drv of targetDrivers) {
          // length = laps completed on the set (0 right after a pit exit),
          // never a made-up default
          const stints = tyreStrats
            .filter((s) => s.Driver === drv && (s.LapStart || s.StartLap || 1) <= currentLap)
            .map((s) => ({
              compound: s.Compound, startLap: s.LapStart || s.StartLap || 1,
              length: s.TotalLaps ?? s.StintLength ?? null, stintNumber: s.StintNumber,
            }));
          if (stints.length > 0) raceContext.tyreStrategy[drv] = stints;
        }
      }
    }

    // Recent lap times for focus driver
    if (target && sessionData?.lap_times) {
      raceContext.recentLaps = completedLaps(sessionData.lap_times, now)
        .filter((lt) => lt.Driver === target && lt.LapNumber <= currentLap && lt.LapTimeSeconds > 0)
        .sort((a, b) => b.LapNumber - a.LapNumber)
        .slice(0, 5)
        .map((lt) => ({
          lap: lt.LapNumber, time: lt.LapTimeSeconds,
          compound: lt.Compound, tyreLife: lt.TyreLife,
          s1: lt.Sector1TimeSeconds, s2: lt.Sector2TimeSeconds, s3: lt.Sector3TimeSeconds,
        }));
      raceContext.focusDriver = target;
    }
    raceContext.selectedDrivers = selectedDrivers;
    raceContext.currentLap = currentLap;
    raceContext.maxLap = maxLap;

    try {
      const resp = await api.queryGemini({
        query,
        year,
        round,
        current_lap: currentLap,
        drivers: selectedDrivers,
        lstm_predictions: lstmPredictions,
        race_context: Object.keys(raceContext).length > 0 ? raceContext : undefined,
      });
      set((s) => ({
        geminiMessages: [
          ...s.geminiMessages,
          { role: 'ai', content: resp.response, scenarios: resp.scenarios, is_mock: !!resp.is_mock },
        ],
        geminiOverlays: resp.scenarios || [],
      }));
    } catch (e) {
      set((s) => ({
        geminiMessages: [
          ...s.geminiMessages,
          { role: 'ai', content: 'Failed to get response from Gemini.' },
        ],
      }));
    }
  },

  setGeminiOverlays: (overlays) => set({ geminiOverlays: overlays }),
  // A projection computed by a view (RacePredictionPanel) at the current clock:
  // stamped like computeRaceProjection's, so laterClockReset can drop it
  setRaceProjection: (data) => set({
    raceProjection: data
      ? {
        ...data,
        computedAtNow: data.computedAtNow ?? get().getSessionNow(),
        computedAtLap: data.computedAtLap ?? get().currentLap,
      }
      : data,
  }),

  // ── Monte Carlo Race Projection ──────────────────────────────────
  // opts.replace (clock jump): when no projection can be computed at the new
  // clock, the held one is dropped instead of kept from another clock.
  computeRaceProjection: ({ replace = false } = {}) => {
    const {
      sessionData, currentLap, maxLap, raceSituationData, isQualifyingReplay,
    } = get();

    if (isQualifyingReplay) return;
    const drop = () => {
      if (replace && get().raceProjection) set({ raceProjection: null });
    };
    if (!raceSituationData?.driverFeatures || currentLap < 5 || maxLap <= currentLap) { drop(); return; }

    const lapTimes = sessionData?.lap_times;
    const strategies = sessionData?.tyre_strategy || sessionData?.strategies || [];
    const trackStatus = sessionData?.track_status || [];
    if (!lapTimes?.length) { drop(); return; }

    // Causal: race parameters from what happened up to sessionNow
    const now = get().getSessionNow();
    const result = simulateRaceFinish({
      driverFeatures: raceSituationData.driverFeatures,
      currentLap,
      maxLap,
      lapTimes,
      strategies,
      trackStatus,
      sessionNow: now,
      sessionTimeOffset: get().sessionTimeOffset,
      // R7: the race pit loss exists for race sessions only (null projection
      // in qualifying / practice, so neither the panels nor Gemini get one)
      sessionType: viewSessionType(get()),
      running: stintsRunningOf(get()),
    });

    if (result) set({ raceProjection: { ...result, computedAtNow: now, computedAtLap: currentLap } });
    else drop();
  },

  // ── Strategy Simulator ───────────────────────────────────────────
  simulatorStrategy: null,   // { driver, stints: [{compound, lapStart, length}] }
  simulatorResult: null,     // { simProjection, baselineProjection, delta }
  simulatorComparisons: [],  // [{ label, stints, result }]
  isSimulatorActive: false,

  setSimulatorStrategy: (strategy) => set({ simulatorStrategy: strategy }),
  toggleSimulator: () => set((s) => ({ isSimulatorActive: !s.isSimulatorActive })),
  clearSimulator: () => set({
    simulatorStrategy: null, simulatorResult: null,
    simulatorComparisons: [], isSimulatorActive: false,
  }),

  addSimulatorComparison: (label, stints, result) => set((s) => ({
    simulatorComparisons: [...s.simulatorComparisons, { label, stints, result }],
  })),

  applyPCAPattern: (strategy) => set({
    simulatorStrategy: strategy,
    isSimulatorActive: true,
  }),

  applyGeminiScenario: (scenario) => {
    if (!scenario?.stints) return;
    const { focusDriver } = get();
    set({
      simulatorStrategy: { driver: focusDriver || scenario.driver, stints: scenario.stints },
      isSimulatorActive: true,
    });
  },

  runSimulation: () => {
    const {
      simulatorStrategy, sessionData, currentLap, maxLap,
      raceSituationData, isQualifyingReplay,
    } = get();

    if (isQualifyingReplay || !simulatorStrategy?.stints?.length) return;
    if (!raceSituationData?.driverFeatures || currentLap < 5 || maxLap <= currentLap) return;

    const lapTimes = sessionData?.lap_times;
    const strategies = sessionData?.tyre_strategy || sessionData?.strategies || [];
    const trackStatus = sessionData?.track_status || [];
    if (!lapTimes?.length) return;

    // Both runs see only what happened up to sessionNow
    const sessionNow = get().getSessionNow();
    const { sessionTimeOffset } = get();

    // Baseline: standard projection (no override)
    const running = stintsRunningOf(get());
    const sessionType = viewSessionType(get()); // R7: no race maths outside R / S
    const baseline = simulateRaceFinish({
      driverFeatures: raceSituationData.driverFeatures,
      currentLap, maxLap, lapTimes, strategies, trackStatus,
      sessionNow, sessionTimeOffset, sessionType, running,
    });

    // Custom: override the focused driver's strategy
    const driver = simulatorStrategy.driver;
    if (!driver || !raceSituationData.driverFeatures[driver]) return;

    // Modify driver features to reflect custom strategy
    const modifiedFeatures = { ...raceSituationData.driverFeatures };
    const customStints = simulatorStrategy.stints;
    // Find which stint the driver would be on at currentLap
    let activeStint = customStints[0];
    for (const stint of customStints) {
      if (stint.lapStart <= currentLap) activeStint = stint;
    }
    if (activeStint) {
      modifiedFeatures[driver] = {
        ...modifiedFeatures[driver],
        compoundName: activeStint.compound,
        tyreLife: Math.max(0, currentLap - activeStint.lapStart),
        stintNumber: customStints.indexOf(activeStint) + 1,
      };
    }

    const simResult = simulateRaceFinish({
      driverFeatures: modifiedFeatures,
      currentLap, maxLap, lapTimes, strategies, trackStatus,
      sessionNow, sessionTimeOffset, sessionType, running,
    });

    if (!baseline || !simResult) return;

    const baseProj = baseline.projections.find((p) => p.driver === driver);
    const simProj = simResult.projections.find((p) => p.driver === driver);
    if (!baseProj || !simProj) return;

    set({
      simulatorResult: {
        simProjection: simProj,
        baselineProjection: baseProj,
        delta: {
          position: baseProj.expectedPos - simProj.expectedPos,
          podium: simProj.podiumProb - baseProj.podiumProb,
          points: simProj.pointsProb - baseProj.pointsProb,
        },
        fullProjection: simResult,
        // Session seconds of the clock it was computed at (laterClockReset)
        computedAtNow: sessionNow,
      },
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
