/**
 * View models for the strategy and tyre panels (StrategyTimeline,
 * StrategySimulator, DriverComparePanel, TireSilhouette, TireDegradation,
 * TyreManagement, TyreHealth, UndercutCalculator, RacePredictionPanel).
 *
 * Built on stints.js (stints from the FastF1 Stint column, causal) and
 * pitLoss.js (pit loss measured from the race, causal). Every helper takes
 * sessionNow in SESSION seconds (hooks/useSessionNow.js, raceTime.js) and only
 * uses what had happened by then.
 *
 * One stop count everywhere: a pit stop is a tyre change (stints.pitStops), it
 * counts from the pit exit, when the new stint appears, so for every driver
 * and clock the stop count = visible stints - 1 (STOPS badge, Pit Stops rows,
 * raceSituationFeatures). Pit-lane passes without a tyre change are not stops.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  completedLaps, isLapCompleted, isPitVisible, hasPitIn, hasPitOut, pitInSeconds, pitOutSeconds,
} from './raceTime';
import { deriveStints, pitStops } from './stints';
import {
  estimatePitLoss, perStopLoss, isRaceSession, FALLBACK_PIT_LOSS,
} from './pitLoss';

function normaliseNow(sessionNow) {
  return sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
}

function finite(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Cheap fingerprint of what is known at sessionNow: the number of completed
 * laps, of visible pit entries and of passed pit exits (plus, when given, of
 * started and ended track-status events). Each of these sets only grows with
 * sessionNow, so equal keys mean equal sets: a view can memoise anything
 * derived from completed laps on [lapTimes, key] and re-derive only when a lap
 * or a pit event completes, not on every replay frame.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} [sessionNow=Infinity] - session seconds
 * @param {Array<Object>} [trackStatus] - [{status, start_time, end_time}] in session seconds
 * @returns {string}
 */
export function causalKey(lapTimes, sessionNow = Infinity, trackStatus = null) {
  const now = normaliseNow(sessionNow);
  let laps = 0;
  let pitIns = 0;
  let pitOuts = 0;
  if (Array.isArray(lapTimes)) {
    for (const lt of lapTimes) {
      if (isLapCompleted(lt, now)) laps++;
      if (isPitVisible(lt, now)) pitIns++;
      if (hasPitOut(lt)) {
        const exit = pitOutSeconds(lt);
        if (exit != null && exit <= now) pitOuts++;
      }
    }
  }
  let started = 0;
  let ended = 0;
  if (Array.isArray(trackStatus)) {
    for (const ev of trackStatus) {
      const start = finite(ev?.start_time);
      const end = finite(ev?.end_time);
      if (start != null && start <= now) started++;
      if (end != null && end <= now) ended++;
    }
  }
  return `${now === Infinity ? 'all' : 'now'}|${laps}|${pitIns}|${pitOuts}|${started}|${ended}`;
}

/**
 * Gantt bars from deriveStints rows: the stint row plus the field names the
 * strategy views draw with (LapStart, StintLength) and an upper-case Compound.
 * The ongoing stint ends at the driver's last completed lap.
 *
 * @param {Array<Object>} stints - deriveStints(lapTimes, { sessionNow })
 * @returns {Array<Object>} same order, { ...stint, Compound, LapStart, StintLength }
 */
export function stintBars(stints) {
  return (stints || []).map((s) => ({
    ...s,
    Compound: String(s.Compound || 'UNKNOWN').toUpperCase(),
    LapStart: s.StartLap,
    StintLength: s.TotalLaps,
  }));
}

/**
 * Stints completed at sessionNow (the driver has started a later stint, or
 * has finished / retired): the input extractRaceParams uses for its
 * stint-length statistics. Ongoing stints are left out because their final
 * length is not known yet.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times
 * @param {number} [sessionNow=Infinity] - session seconds
 * @param {Object} [opts]
 * @param {boolean|function(string): boolean} [opts.running] - deriveStints option (live mode:
 *   the stints still being run are not completed, see stints.js stintsRunning)
 * @returns {Array<Object>} deriveStints rows with ongoing === false
 */
export function completedStints(lapTimes, sessionNow = Infinity, { running = false } = {}) {
  return deriveStints(lapTimes || [], { sessionNow, running }).filter((s) => !s.ongoing);
}

/**
 * One driver's laps grouped by stint: each lap goes to the stint whose
 * StartLap..EndLap contains its LapNumber. Stints without any of the given
 * laps are dropped (e.g. outside a brushed lap range).
 *
 * @param {Array<Object>} laps - lap_times rows of ONE driver
 * @param {Array<Object>} stints - that driver's deriveStints rows
 * @returns {Array<{stint: Object, laps: Array<Object>}>} by StartLap, laps by LapNumber
 */
export function groupLapsByStint(laps, stints) {
  const groups = [...(stints || [])]
    .sort((a, b) => a.StartLap - b.StartLap)
    .map((stint) => ({ stint, laps: [] }));
  for (const lt of laps || []) {
    const n = Number(lt.LapNumber);
    const group = groups.find((g) => n >= g.stint.StartLap && n <= g.stint.EndLap);
    if (group) group.laps.push(lt);
  }
  for (const g of groups) g.laps.sort((a, b) => a.LapNumber - b.LapNumber);
  return groups.filter((g) => g.laps.length > 0);
}

/**
 * A driver's actual stints as a Strategy Simulator plan
 * ([{ compound, lapStart, length }]). The plan has to reach the flag, so an
 * ongoing last stint is extended to raceLaps ("no further stop" baseline that
 * the user then edits); completed stints keep their real length.
 *
 * @param {Array<Object>} driverStints - deriveStints rows (or stintBars) of one driver
 * @param {number} [raceLaps] - race length in laps
 * @returns {Array<{compound: string, lapStart: number, length: number}>}
 */
export function simulatorStints(driverStints, raceLaps) {
  const sorted = [...(driverStints || [])].sort((a, b) => a.StartLap - b.StartLap);
  return sorted.map((s, i) => {
    let length = s.TotalLaps;
    if (i === sorted.length - 1 && s.ongoing && Number.isFinite(raceLaps) && raceLaps > s.EndLap) {
      length = raceLaps - s.StartLap + 1;
    }
    return { compound: String(s.Compound || 'UNKNOWN').toUpperCase(), lapStart: s.StartLap, length };
  });
}

/**
 * Text of one stop's pit-loss label (decision R7):
 *  - measured (a sample of the estimator): "26.8s";
 *  - estimate (the stop can never be measured, e.g. a lap around it not
 *    green): the race median at sessionNow, "≈24.7s";
 *  - fallback (no measured green stop in the race yet, n = 0): "22.0s*";
 *  - pending (green stop whose out-lap is still running) and not-applicable
 *    (not a race session): '' (marker without a number).
 *
 * @param {{loss: number|null, source: string, estimateSource?: string}} r - a perStopLoss result
 * @returns {string}
 */
export function formatStopLoss(r) {
  const loss = finite(r?.loss);
  if (loss == null || r.source === 'pending' || r.source === 'not-applicable') return '';
  const value = `${loss.toFixed(1)}s`;
  if (r.source === 'measured') return value;
  if (r.source === 'fallback' || r.estimateSource === 'fallback') return `${value}*`;
  return `≈${value}`;
}

/**
 * The one-line legend under the Strategy Timeline in race sessions: what the
 * label marks mean ("≈" estimate, "*" fallback, no number while measuring).
 */
export const PIT_LOSS_LEGEND = 'Pit-loss labels: number = measured · ≈ estimate (race median) '
  + '· * fallback (assumption) · no number = measuring…';

/**
 * Tooltip text explaining where one stop's pit-loss label comes from.
 *
 * @param {{loss: number|null, source: string, estimateSource?: string, n: number}} m - a pitStopMarkers row
 * @returns {string}
 */
export function describeStopLoss(m) {
  const loss = finite(m?.loss);
  if (m.source === 'not-applicable') {
    return 'Tyre change: pit loss applies to race sessions only';
  }
  if (m.source === 'pending' || loss == null) {
    return 'measuring… the pit loss of this green-flag stop is known once its out-lap is completed '
      + '(and the driver has enough green-flag laps)';
  }
  if (m.source === 'measured') {
    return `Pit loss ${loss.toFixed(1)} s, measured: in-lap + out-lap - 2 x the driver's green-flag median lap`;
  }
  if (m.source === 'fallback' || m.estimateSource === 'fallback') {
    return `${loss.toFixed(1)} s* fallback: no measured green-flag stop in this race yet (an assumption, not data)`;
  }
  return `≈${loss.toFixed(1)} s: race median of ${m.n} measured green stops `
    + '(this stop cannot be measured: a lap around it is not green, or it has no usable out-lap)';
}

/**
 * Pit-stop markers for the strategy Gantt: one row per pit stop (tyre change)
 * visible at sessionNow (stints.pitStops: from the pit exit, the instant the
 * new stint appears), with that stop's loss from pitLoss.perStopLoss and its
 * label (formatStopLoss). Outside race sessions every marker is
 * 'not-applicable' with no number.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {string} [opts.sessionType] - 'R', 'S', 'Q', 'FP2', ...; omitted = race
 * @param {Object} [opts.estimate] - estimatePitLoss result at the same sessionNow and sessionType
 * @returns {Array<{Driver: string, inLap: number, outLap: number, pitInTime: number|null,
 *   pitOutTime: number|null, fromCompound: string, toCompound: string, loss: number|null,
 *   source: 'measured'|'pending'|'estimate'|'fallback'|'not-applicable',
 *   estimateSource: 'race'|'fallback'|'not-applicable', n: number, label: string}>}
 *   sorted by Driver, then inLap; loss in seconds
 */
export function pitStopMarkers(lapTimes, { sessionNow = Infinity, sessionType, estimate } = {}) {
  const est = estimate || estimatePitLoss(lapTimes || [], { sessionNow, sessionType });
  return pitStops(lapTimes || [], { sessionNow }).map((stop) => {
    const r = perStopLoss(lapTimes, stop.Driver, stop.inLap, { sessionNow, sessionType, estimate: est });
    return {
      ...stop,
      loss: r.loss,
      source: r.source,
      estimateSource: r.estimateSource,
      n: est.n,
      label: formatStopLoss(r),
    };
  });
}

/**
 * Where to draw each marker's label pill on the Gantt, and whether to draw it:
 * a label that would overlap a pill already drawn is left out (its value
 * stays in the marker tooltip). Without opts.yOf only the pills of the same
 * driver row are compared; with it the pills of every row are (when the rows
 * are tighter than a pill, pills of adjacent rows overlap too). Markers
 * without a label get showLabel false.
 *
 * @param {Array<{Driver: string, inLap: number, label: string}>} markers - pitStopMarkers rows
 * @param {function(number): number} xOf - lap -> x pixel (the marker sits at inLap + 0.5)
 * @param {Object} [opts]
 * @param {number} [opts.charWidth=5] - px per label character (8 px mono font)
 * @param {number} [opts.pad=6] - px of padding inside the pill
 * @param {number} [opts.minWidth=24] - px
 * @param {number} [opts.gap=2] - px kept free between two pills
 * @param {function(string): number} [opts.yOf] - driver -> y pixel of the row (band top)
 * @param {number} [opts.pillTop=14] - px from the row's y up to the pill's top
 * @param {number} [opts.pillH=11] - px, pill height
 * @returns {Array<Object>} same order, {...marker, x, pillW, showLabel}
 */
export function layoutStopLabels(markers, xOf, {
  charWidth = 5, pad = 6, minWidth = 24, gap = 2, yOf = null, pillTop = 14, pillH = 11,
} = {}) {
  const lastRight = new Map();
  const drawn = []; // pill rectangles already shown (with yOf)
  const order = (markers || []).map((m, i) => i)
    .sort((a, b) => {
      const ma = markers[a];
      const mb = markers[b];
      if (ma.Driver !== mb.Driver) return ma.Driver < mb.Driver ? -1 : 1;
      return ma.inLap - mb.inLap;
    });
  const out = new Array((markers || []).length);
  for (const i of order) {
    const m = markers[i];
    const x = xOf(m.inLap + 0.5);
    const pillW = m.label ? Math.max(minWidth, m.label.length * charWidth + pad) : 0;
    let showLabel = false;
    if (m.label && yOf) {
      const rect = { left: x - pillW / 2, right: x + pillW / 2, top: yOf(m.Driver) - pillTop };
      rect.bottom = rect.top + pillH;
      showLabel = drawn.every((r) => rect.left >= r.right + gap || rect.right + gap <= r.left
        || rect.top >= r.bottom || rect.bottom <= r.top);
      if (showLabel) drawn.push(rect);
    } else if (m.label) {
      const left = x - pillW / 2;
      const prev = lastRight.get(m.Driver);
      showLabel = prev == null || left >= prev + gap;
      if (showLabel) lastRight.set(m.Driver, x + pillW / 2);
    }
    out[i] = { ...m, x, pillW, showLabel };
  }
  return out;
}

/**
 * Drivers in the pit lane at sessionNow (decision R3: pit entry reached, pit
 * exit not yet): the old set is still the current one, no stop is counted
 * yet. One row per driver: the in-lap whose PitInTime <= sessionNow and whose
 * next row's PitOutTime > sessionNow (without a PitOutTime: until the in-lap
 * is completed). A car with no later row stayed in the pits (a retirement)
 * and is left out. [] at sessionNow = Infinity (race over, live). The pit
 * exit is in the future while the car is in the lane, so it is not returned.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {Array<{Driver: string, inLap: number, pitInTime: number}>} sorted by Driver
 */
export function pitLaneNow(lapTimes, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  if (now === Infinity || !Array.isArray(lapTimes)) return [];
  const byDriver = new Map();
  for (const lt of lapTimes) {
    if (!lt?.Driver) continue;
    const n = Number(lt.LapNumber);
    if (!Number.isFinite(n)) continue;
    if (!byDriver.has(lt.Driver)) byDriver.set(lt.Driver, new Map());
    byDriver.get(lt.Driver).set(n, lt);
  }
  const out = [];
  for (const drv of [...byDriver.keys()].sort()) {
    const rows = [...byDriver.get(drv).entries()].sort((a, b) => a[0] - b[0]).map(([, lt]) => lt);
    for (let k = rows.length - 2; k >= 0; k--) {
      const row = rows[k];
      if (!hasPitIn(row)) continue;
      const pitIn = pitInSeconds(row);
      if (pitIn == null || pitIn > now) continue;
      const next = rows[k + 1];
      const exit = hasPitOut(next) ? pitOutSeconds(next) : null;
      const inLane = exit != null ? now < exit : !isLapCompleted(row, now);
      if (inLane) out.push({ Driver: drv, inLap: Number(row.LapNumber), pitInTime: pitIn });
      break; // only the latest pit entry already reached matters
    }
  }
  return out;
}

/**
 * Number of pit stops (tyre changes) per driver.
 *
 * @param {Array<{Driver: string}>} stops - pitStops / pitStopMarkers rows
 * @returns {Object<string, number>}
 */
export function pitCountsByDriver(stops) {
  const out = {};
  for (const s of stops || []) out[s.Driver] = (out[s.Driver] || 0) + 1;
  return out;
}

/**
 * Number of stops of a strategy pattern given as its stints (backend PCA
 * patterns, simulator plans): stints - 1, never negative.
 *
 * @param {Array<Object>} stints
 * @returns {number}
 */
export function patternStopCount(stints) {
  return Math.max(0, (Array.isArray(stints) ? stints.length : 0) - 1);
}

/**
 * Laps text of one stint for tooltips: "17–38 (22 laps)", "39–45 (7 laps,
 * ongoing)", or "from lap 39 (no lap completed yet)" for a stint that has
 * just begun (R3: it exists from the pit exit with 0 completed laps).
 *
 * @param {{StartLap: number, EndLap: number, TotalLaps: number, ongoing?: boolean}} stint
 * @returns {string}
 */
export function stintLapsText(stint) {
  const n = finite(stint?.TotalLaps) ?? 0;
  if (n <= 0) return `from lap ${stint.StartLap} (no lap completed yet)`;
  return `${stint.StartLap}–${stint.EndLap} (${n} lap${n === 1 ? '' : 's'}${stint.ongoing ? ', ongoing' : ''})`;
}

/**
 * Session type the views apply rules for ('R', 'S', 'Q', 'FP', ...), from
 * store fields: live feed -> its SessionInfo type ('Race', 'Qualifying',
 * 'Practice', with 'Sprint' in the name for sprints); quali replay -> 'Q';
 * otherwise the type of the loaded session (loadedSessionType, recorded by
 * loadSession; the sessionType pill only when nothing is loaded, since the
 * session menus change the pill without loading); 'R' when nothing is known.
 *
 * @param {Object} s - store state (or any object with these fields)
 * @returns {string}
 */
export function viewSessionType(s) {
  if (s?.isLiveMode) {
    const type = String(s.liveSessionInfo?.session_type || '').toLowerCase();
    const name = String(s.liveSessionInfo?.session_name || '').toLowerCase();
    if (type.includes('qualif') || name.includes('qualif') || name.includes('shootout')) return 'Q';
    if (type.includes('practice') || name.includes('practice')) return 'FP';
    if (name.includes('sprint')) return 'S';
    return 'R';
  }
  if (s?.isQualifyingReplay) return 'Q';
  return s?.loadedSessionType || s?.sessionType || 'R';
}

/**
 * Identity of the session on screen, for every request and cache key scoped
 * to one session (D7): { year, round, sessionType } of the replay loadSession
 * put on screen (store.loadedYear / loadedRound / loadedSessionType, never the
 * pills, which the session menus change without loading); in live mode the
 * mock replay's race (store.liveMockSession), the only live session the
 * backend's /api routes hold cached rows of. null when nothing is loaded and
 * for a live feed that is not a mock replay (its session has no cached rows).
 * The store re-exports it (store/useF1Store.js).
 *
 * @param {Object} s - store state
 * @returns {{year: number, round: number, sessionType: string}|null}
 */
export function sessionScopeOf(s) {
  if (s?.isLiveMode) {
    const mock = s.liveMockSession;
    return mock?.year && mock?.round ? { year: mock.year, round: mock.round, sessionType: 'R' } : null;
  }
  if (!s?.loadedYear || !s?.loadedRound) return null;
  return { year: s.loadedYear, round: s.loadedRound, sessionType: s.loadedSessionType || 'R' };
}

/**
 * Request body of a free-text / quick Gemini query (the Pit Wall "AI
 * Strategist" box), for the same /gemini/strategy endpoint as the store's
 * sendGeminiQuery: the same year / round fields (GeminiRequest in
 * backend/api/routers/gemini.py) for the session on screen (sessionScopeOf,
 * never the pills; the pills only when nothing with cached rows is on
 * screen, as sendGeminiQuery), the type of the session on screen
 * (viewSessionType, R7) so the backend quotes no pit loss outside race
 * sessions, and the focus driver as `drivers` (the request has no `driver`
 * field).
 *
 * @param {Object} s - store state
 * @param {string} text - the query
 * @returns {{query: string, year: *, round: *, session_type: string,
 *   drivers: string[], current_lap: *}}
 */
export function geminiQuickQueryBody(s, text) {
  const driver = s?.focusDriver || s?.selectedDrivers?.[0] || null;
  const scope = sessionScopeOf(s);
  return {
    query: String(text ?? '').trim(),
    year: scope?.year ?? s?.year ?? null,
    round: scope?.round ?? s?.round ?? null,
    session_type: viewSessionType(s),
    drivers: driver ? [driver] : [],
    current_lap: s?.currentLap ?? null,
  };
}

/**
 * The pit loss a panel shows and uses: the estimator's median (never the
 * mean). When the estimate is missing, has no median, or is the fallback, the
 * value is FALLBACK_PIT_LOSS.median with isFallback = true, and the UI must
 * print "fallback" next to it. Outside race sessions (source
 * 'not-applicable') there is no value: value null, notApplicable = true.
 *
 * @param {Object} [pitLoss] - extractRaceParams(...).pitLoss (an estimatePitLoss result)
 * @returns {{value: number|null, stdDev: number|null, p10: number|null, p90: number|null,
 *   n: number, isFallback: boolean, notApplicable: boolean}} seconds
 */
export function pitLossDisplay(pitLoss) {
  if (pitLoss?.source === 'not-applicable') {
    return {
      value: null, stdDev: null, p10: null, p90: null, n: 0, isFallback: false, notApplicable: true,
    };
  }
  const median = finite(pitLoss?.median);
  if (median == null || pitLoss.source === 'fallback') {
    return {
      value: FALLBACK_PIT_LOSS.median,
      stdDev: FALLBACK_PIT_LOSS.stdDev,
      p10: null,
      p90: null,
      n: 0,
      isFallback: true,
      notApplicable: false,
    };
  }
  return {
    value: median,
    stdDev: finite(pitLoss.stdDev),
    p10: finite(pitLoss.p10),
    p90: finite(pitLoss.p90),
    n: finite(pitLoss.n) ?? 0,
    isFallback: false,
    notApplicable: false,
  };
}

export { isRaceSession };

/**
 * Tyre status of one stint for the tyre silhouette.
 *
 * Completed stint: its real length. Ongoing stint: the driver is on lap
 * TotalLaps + 1 of the set and the final length is not known yet. The
 * reference length is then the mean length of the stints on the same compound
 * that, at the same sessionNow, already ended in a pit stop (the driver has a
 * later stint; a stint ended by a retirement or by the flag says nothing about
 * tyre life) after at least lapsOnTyre laps (the current set has lasted that
 * long already). lengthSource 'race-average', lengthSamples = how many. With
 * no such stint the length and the life fraction are null (shown as unknown).
 *
 * @param {Object} stint - a deriveStints row (or a stintBars row)
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.allStints] - deriveStints rows of every driver at the same sessionNow
 * @returns {{compound: string, lapStart: number, lapsOnTyre: number, stintLength: number|null,
 *   lengthSource: 'actual'|'race-average'|null, lengthSamples: number, tyreLife: number|null}}
 *   tyreLife = used fraction in [0, 1]
 */
export function tyreStintStatus(stint, { allStints = [] } = {}) {
  const compound = String(stint.Compound || 'UNKNOWN').toUpperCase();
  const lapStart = stint.StartLap;
  if (!stint.ongoing) {
    const len = Math.max(1, stint.TotalLaps);
    return {
      compound, lapStart, lapsOnTyre: len, stintLength: len,
      lengthSource: 'actual', lengthSamples: 1, tyreLife: 1,
    };
  }
  const lapsOnTyre = stint.TotalLaps + 1;
  const followed = new Set(allStints.map((s) => `${s.Driver}|${s.StintNumber - 1}`));
  const lengths = allStints
    .filter((s) => !s.ongoing && followed.has(`${s.Driver}|${s.StintNumber}`)
      && String(s.Compound || 'UNKNOWN').toUpperCase() === compound
      && s.TotalLaps >= lapsOnTyre)
    .map((s) => s.TotalLaps);
  if (lengths.length === 0) {
    return {
      compound, lapStart, lapsOnTyre, stintLength: null,
      lengthSource: null, lengthSamples: 0, tyreLife: null,
    };
  }
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  return {
    compound,
    lapStart,
    lapsOnTyre,
    stintLength: avg,
    lengthSource: 'race-average',
    lengthSamples: lengths.length,
    tyreLife: Math.min(1, lapsOnTyre / avg),
  };
}

/**
 * Lap range a backend degradation fit actually used (TireDegradation banner):
 * lap_start to lap_end_used, where the store clamps the brushed end
 * (lap_end) to the drivers' last completed lap. partial = the fit stops
 * before the brushed end. null when there is no lap_end_used or the range is
 * empty.
 *
 * @param {{lap_start: number, lap_end: number, lap_end_used?: number}} reg - store.degradationRegression
 * @returns {{start: number, end: number, partial: boolean}|null} lap numbers
 */
export function fittedLapRange(reg) {
  const start = finite(reg?.lap_start);
  const used = finite(reg?.lap_end_used);
  const end = finite(reg?.lap_end);
  if (start == null || used == null || used < start) return null;
  return { start, end: used, partial: end != null && used < end };
}

/**
 * Laps of one driver completed at sessionNow with a usable lap time
 * (0 < LapTimeSeconds < maxLapTime), sorted by LapNumber.
 *
 * @param {Array<Object>} lapTimes
 * @param {string} driver
 * @param {number} [sessionNow=Infinity] - session seconds
 * @param {number} [maxLapTime=300] - seconds; the views' existing outlier cut
 * @returns {Array<Object>}
 */
export function driverCompletedLaps(lapTimes, driver, sessionNow = Infinity, maxLapTime = 300) {
  return completedLaps(lapTimes, sessionNow)
    .filter((lt) => lt.Driver === driver && lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < maxLapTime)
    .sort((a, b) => a.LapNumber - b.LapNumber);
}
