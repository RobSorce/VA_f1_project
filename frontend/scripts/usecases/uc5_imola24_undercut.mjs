/**
 * Use case UC5, the race strategist's undercut fight at Imola 2024 (2024 R7,
 * Emilia Romagna Grand Prix): PIA (McLaren, P5) 0.90 s behind SAI (Ferrari,
 * P4), both on 22-lap-old MEDIUMs at the end of lap 22. Every number of the
 * use case is printed here, computed causally with the app's own modules and
 * the arguments the views pass them.
 *
 * What it computes, per section of the report:
 *  A. the race, the replay frames (backend 0.4 s, static demo every 2nd frame,
 *     0.8 s), the events of the two cars and the clocks a reader can reach:
 *     a lap seek (the arrow keys, a lap click on the expanded timeline, the
 *     command palette's "Jump to Lap") goes to the first frame of a leader lap
 *     (store/useF1Store.js setCurrentLap -> lapFrameMap, built at :3141-3170);
 *     playing (Space) and pausing, or dragging the timeline, reach any frame;
 *  B. D1, PIA's pit wall, "box at the end of this lap (L23)?": the Circle of
 *     Doom with PIA in focus (components/visualizations/CircleOfDoom.jsx:
 *     estimatePitLoss :1021, circleState :1025, pitWindow and
 *     rejoinDistribution :1044-1049, extractRaceParams :1058, pitInLaps :1071,
 *     the centre line :436-444, the focus tooltip :1494-1525, the "pit in k"
 *     tooltip :1468-1491, the gap tags of the other cars :1121-1137) and the
 *     focus card's Rivals rows (store updateRivalContext, displayed by
 *     components/ui/FocusDriverWidget.jsx:148-176), at the lap-seek clock and
 *     at the frame-precise clock, in backend and demo frames, and how long
 *     each readout holds over the decision window;
 *  C. D2, SAI's pit wall once PIA has entered the pit lane, "cover now or
 *     stay out?": the same with SAI in focus;
 *  D. what happened (hindsight, the lap rows after the clocks) and the same
 *     Circle of Doom read back at reachable clocks after both stops;
 *  E. the model inputs behind B and C (pit-loss samples, degradation and
 *     fresh-tyre sources, track status);
 *  F. causality: B and C again with every lap row, pit time and track-status
 *     event after the clock rewritten (src/utils/__tests__/futureRows.js
 *     perturbFuture), with dnfMap = {}, and a positive control (the past
 *     changed: the outputs must change);
 *  G. ANALYSIS ONLY, NOT DISPLAYED: the Undercut Calculator
 *     (components/visualizations/UndercutCalculator.jsx, utils/undercut.js
 *     undercutSweep). It is in App.jsx's view map but in no control of this
 *     build (not in utils/slotOptions.js, the docked layout's tab picker
 *     VIZ_TABS, the command palette or the window presets; the view tests
 *     assert it is gone), so no reader can open it. Its sweep, the RIVAL
 *     STOPS choice and its expiry (UndercutCalculator.jsx:170-174) and the
 *     gap after both stops are printed for the analysis only;
 *  H. a short second vignette at the same race: GAS (Alpine) vs SAR
 *     (Williams), laps 29-32, Circle of Doom and hindsight.
 *
 * Clocks: session seconds. In frame mode sessionNow = frame.t +
 * sessionTimeOffset (utils/raceTime.js resolveSessionNow), currentLap = the
 * frame's leader lap (store setCurrentFrameIndex). The static demo keeps
 * every 2nd backend frame (backend/scripts/export_demo_data.py slim_frames,
 * FRAME_STEP 2): when frontend/public/data/2024_7_R exists its files are read,
 * otherwise the demo frames are derived here with the same rule.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/usecases/uc5_imola24_undercut.mjs [--out FILE]
 * Prints the report and writes the same text to
 * docs/evidence/usecase_uc5_imola24_undercut.txt (or to FILE). Reads the
 * cached session and frames of 2024 R7 in backend/data/processed_cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as d3 from 'd3';
import { extractRaceParams } from '../../src/utils/raceSimulation.js';
import {
  circleState, phaseAt, pitWindow, rejoinDistribution, ringRelations, gapSeconds, lapOffset, circleMemoKey,
  TRAFFIC_GAP_S,
} from '../../src/utils/circleOfDoom.js';
import { estimatePitLoss, perStopLoss, FALLBACK_PIT_LOSS } from '../../src/utils/pitLoss.js';
import { pitInLaps, undercutSweep } from '../../src/utils/undercut.js';
import { causalKey, completedStints, pitLossDisplay } from '../../src/utils/strategyViews.js';
import { stintsRunning } from '../../src/utils/stints.js';
import {
  computeSessionTimeOffset, resolveSessionNow, lapEndTime, pitInSeconds, pitOutSeconds, hasPitIn,
  leaderLapEndTime,
} from '../../src/utils/raceTime.js';
import { perturbFuture } from '../../src/utils/__tests__/futureRows.js';

// The store keeps some settings in localStorage: an in-memory one stands in
// for the browser's (as frontend/scripts/mc_benchmark.mjs does)
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear(),
  };
}
const { useF1Store, flagAtClock } = await import('../../src/store/useF1Store.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CACHE = path.join(ROOT, 'backend/data/processed_cache');
const DEMO_DIR = path.join(ROOT, 'frontend/public/data');
const OUT_ARG = process.argv.indexOf('--out');
const OUT_FILE = OUT_ARG > 0
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.join(ROOT, 'docs/evidence/usecase_uc5_imola24_undercut.txt');

const YEAR = 2024;
const ROUND = 7;
const DEMO_FRAME_STEP = 2; // backend/scripts/export_demo_data.py FRAME_STEP

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const fmt1 = d3.format('.1f'); // CircleOfDoom.jsx fmt1
const MINUS = '−';
const sgn2 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : MINUS}${Math.abs(v).toFixed(2)}`);
const sgn3 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : MINUS}${Math.abs(v).toFixed(3)}`);
const pct1 = (x) => `${(100 * x).toFixed(1)}%`;
const letter = (c) => ({
  SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W',
}[String(c || '').toUpperCase()] || '?');
const parse = (txt) => JSON.parse(txt.replace(/\bNaN\b/g, 'null'));

// ─── data ────────────────────────────────────────────────────────────────

/** store/useF1Store.js:1344 dnfMapFromResults (module-private in the store). */
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

/** store/useF1Store.js:1407 frameLeaderLap (module-private in the store). */
function frameLeaderLap(frame) {
  let lap = 1;
  for (const d of Object.values(frame?.drivers || {})) if (d.lap > lap) lap = d.lap;
  return lap;
}

/** store/useF1Store.js:3141-3170: { leader lap: first frame index on it }. */
function lapFrameMapOf(frames) {
  const map = {};
  frames.forEach((f, i) => {
    const ds = Object.values(f.drivers || {});
    if (!ds.length) return;
    let m = 0;
    for (const d of ds) if (d.lap > m) m = d.lap;
    if (m > 0 && !(m in map)) map[m] = i;
  });
  return map;
}

function makeRace(session, frameData, label) {
  const lt = session.lap_times || [];
  const ts = session.track_status || [];
  let tableMax = 1;
  for (const r of lt) if (r.LapNumber > tableMax) tableMax = r.LapNumber;
  const maxLap = Math.max(tableMax, frameData?.total_laps || 0);
  const offset = computeSessionTimeOffset(lt);
  const grid = {};
  for (const r of session.race_results || []) {
    const g = Number(r?.GridPosition);
    if (r?.Abbreviation && r.GridPosition != null && Number.isFinite(g) && g >= 0) grid[r.Abbreviation] = g;
  }
  const byDrv = new Map();
  for (const r of lt) {
    if (!byDrv.has(r.Driver)) byDrv.set(r.Driver, new Map());
    byDrv.get(r.Driver).set(r.LapNumber, r);
  }
  const frames = frameData.frames;
  const frameDt = frames.length > 1 && frames[1].t - frames[0].t > 0 ? frames[1].t - frames[0].t : 0.4;
  const dnfMap = dnfMapFromResults(session.race_results, tableMax);
  return {
    label, session, frameData, frames, frameDt, lt, ts, tableMax, maxLap, offset, grid, byDrv, dnfMap,
    lapFrameMap: lapFrameMapOf(frames),
    running: stintsRunning({ isLiveMode: false, totalRaceLaps: null, lapTimes: lt, dnfMap }),
  };
}

/** The dashboard's clock at frame idx (store setCurrentFrameIndex + resolveSessionNow). */
function clockAt(R, idx) {
  const frame = R.frames[idx];
  const currentLap = frameLeaderLap(frame);
  const sessionNow = resolveSessionNow({
    currentTime: frame.t, sessionTimeOffset: R.offset, replayActive: true, currentLap, maxLap: R.maxLap,
    lapTimes: R.lt, isLiveMode: false, maxTime: R.frameData.max_time, frameDt: R.frameDt, raceOver: false,
  });
  return { idx, t: frame.t, sessionNow, currentLap };
}

/** Index of the first frame whose session time is >= t. */
function frameAtOrAfter(R, t) {
  let lo = 0; let hi = R.frames.length - 1; let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (R.frames[m].t + R.offset >= t) { ans = m; hi = m - 1; } else lo = m + 1;
  }
  return ans;
}

const row = (R, d, l) => R.byDrv.get(d)?.get(l) || null;
const crossing = (R, d, l) => { const r = row(R, d, l); return r ? lapEndTime(r) : null; };

// ─── the views ───────────────────────────────────────────────────────────

/** Circle of Doom with `focus` at a clock (CircleOfDoom.jsx:1015-1077). */
function codView(R, clock, focus, {
  rivalsStop = false, lt = R.lt, ts = R.ts, dnfMap = R.dnfMap,
} = {}) {
  const now = clock.sessionNow;
  const pitLoss = estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' });
  const state = circleState(lt, { sessionNow: now, dnfMap, gridPositions: R.grid, isLiveMode: false });
  const cars = state.cars.map((c) => ({ ...c, ...phaseAt(c, now, state.refLap) }));
  const ring = { ...state, sessionNow: now, cars };
  const trackFlag = flagAtClock(ts, lt, now);
  const opts = { totalLaps: undefined, trackFlag }; // totalRaceLaps is null in a replay
  const win0 = pitWindow(focus, ring, pitLoss, opts);
  const dist = win0.available ? rejoinDistribution(focus, ring, pitLoss, opts) : null;
  const rel = win0.available ? ringRelations(win0, ring) : null;
  const win = rel ? { ...win0, ...rel } : win0;
  const raceParams = extractRaceParams(lt, [], ts, clock.currentLap, {
    sessionNow: now, sessionTimeOffset: R.offset, sessionType: 'R', running: R.running, dnfMap,
  });
  const pk = win0.available ? pitInLaps(focus, ring, pitLoss, raceParams, { totalLaps: undefined, trackFlag, rivalsStop }) : null;
  const tags = {};
  for (const c of state.cars) {
    if (c.driver === focus) continue;
    const k = lapOffset(focus, c.driver, state);
    tags[c.driver] = k ? (k > 0 ? `${k}L` : `${MINUS}${-k}L`) : signedSeconds(gapSeconds(focus, c.driver, state));
  }
  return {
    now, pitLoss, disp: pitLossDisplay(pitLoss), state, trackFlag, win, dist, raceParams, pk, tags,
    memoKey: circleMemoKey(focus, lt, now, pitLoss, ts),
  };
}

/** CircleOfDoom.jsx signedSeconds: '+12.3' behind, '−4.0' ahead. */
function signedSeconds(s) {
  if (s == null || !Number.isFinite(s)) return '';
  if (Math.abs(s) < 0.05) return '0.0';
  return s > 0 ? `+${fmt1(s)}` : `${MINUS}${fmt1(-s)}`;
}
function trafficSeconds(s) {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < TRAFFIC_GAP_S) { const h = Math.floor(s * 100) / 100; return h > 0 ? `${h.toFixed(2)} s` : '< 0.01 s'; }
  return `${fmt1(s)} s`;
}
function trafficText(t) {
  if (!t?.carAhead) return 'no car ahead';
  const laps = t.carAheadLaps ? ` (${t.carAheadLaps > 0 ? `${t.carAheadLaps}L` : `${MINUS}${-t.carAheadLaps}L`})` : '';
  if (t.flag) return `${trafficSeconds(t.gapSeconds)} behind ${t.carAhead}${laps} (< ${fmt1(TRAFFIC_GAP_S)} s)`;
  return `no: ${t.carAhead}${laps} ${trafficSeconds(t.gapSeconds)} ahead`;
}
const placesVsNow = (n) => (!n ? '= now' : `${n > 0 ? '+' : MINUS}${Math.abs(n)} vs now`);
const names = (list) => (list?.length ? list.map((x) => x.driver).join(', ') : 'none');

/** The centre line and the focus tooltip of the Circle of Doom (CircleOfDoom.jsx:436-444, :1494-1525). */
function codText(v, focus) {
  const { win, dist, disp } = v;
  if (!win.available) return [`centre: "${focus}: ${win.reason}"`];
  const head = win.ongoingStop ? `${focus} stopping → P${win.predictedPosition}` : `${focus} pits now: P${win.currentPosition} → P${win.predictedPosition}`;
  const lossText = disp.isFallback
    ? `${fmt1(disp.value)} s fallback`
    : `${fmt1(disp.value)} s (p10–p90 ${fmt1(win.pitLoss.p10)}–${fmt1(win.pitLoss.p90)} s, ${disp.n} stops)`;
  const method = dist?.method === 'bootstrap' ? `bootstrap of ${disp.n} stops`
    : `normal(${FALLBACK_PIT_LOSS.median}, ${FALLBACK_PIT_LOSS.stdDev}) fallback`;
  return [
    `centre: "${head}"; centre pit-loss line "pit loss ${fmt1(disp.value)} s ${disp.isFallback ? '(fallback)' : `(${disp.n} stop${disp.n === 1 ? '' : 's'})`}"`,
    `tooltip Pit now: P${win.currentPosition} → P${win.predictedPosition} (target lap: end of L${win.targetLap})`,
    `tooltip Rejoin positions: ${(dist?.positions || []).map((p) => `P${p.position} ${pct1(p.probability)}`).join(' · ') || '—'}`,
    `tooltip Draws: ${dist?.samples ?? 0}, ${method}`,
    `tooltip Pit loss: ${lossText}`,
    `tooltip Traffic at the rejoin: ${trafficText(win.traffic)}`,
    `tooltip Traffic probability: ${dist?.trafficProbability != null ? `${Math.round(dist.trafficProbability * 100)}%` : '—'}`,
    `tooltip Gain the place: ${names(win.wouldPassFocus)}`
      + `${win.wouldPassFocus.length ? ` [${win.wouldPassFocus.map((x) => `${x.driver} gap ${sgn2(x.gapSeconds)} s, margin ${sgn2(x.marginSeconds)} s`).join('; ')}] (gaps and margins not displayed)` : ''}`,
    `tooltip Within reach: ${names(win.wouldDropBehindFocus)}`
      + `${win.wouldDropBehindFocus.length ? ` [${win.wouldDropBehindFocus.map((x) => `${x.driver} gap ${sgn2(x.gapSeconds)} s, margin ${sgn2(x.marginSeconds)} s`).join('; ')}] (gaps and margins not displayed)` : ''}`,
    `tooltip Lapped traffic: ${win.trafficOnly?.length ? win.trafficOnly.map((x) => `${x.driver} ${x.label}`).join(', ') : 'none'}`,
    `track flag at the clock: ${v.trackFlag}${win.neutralised ? ' (neutralised: green-flag figures)' : ' (green)'}`,
  ];
}

/** "Pit in k laps" rows (CircleOfDoom.jsx:1468-1491 tooltip, :441-444 centre). */
function pitInText(v, focus) {
  const pk = v.pk;
  if (!pk?.available) return [`pit in k: unavailable (${pk?.reason ?? 'no window'})`];
  const d = pk.degradation;
  const degText = (x) => (x ? `${x.compound} ${x.mean >= 0 ? '+' : MINUS}${Math.abs(x.mean).toFixed(3)} s/lap (${x.source === 'race' ? `${x.n} stints` : 'prior'})` : '—');
  const fresh = pk.freshDeltaInfo;
  const o = [];
  o.push(`stepper k = 0..${pk.kMax}; rivals stop ${pk.rivalsStop ? 'ON' : 'off'}; tooltip Lap model: ${degText(d?.current)} → ${degText(d?.next)};`
    + ` Fresh-tyre delta: ${fresh ? `${fresh.value >= 0 ? '+' : MINUS}${Math.abs(fresh.value).toFixed(3)} s on the first flying lap (${fresh.source === 'race' ? `${fresh.n} stints` : 'prior'})` : '—'}`);
  o.push('   k  centre line                         tooltip: in-lap, rejoin             pitting now instead (same lap)         other cars');
  for (const r of pk.rows) {
    const centre = r.k === 0 ? `${focus} pits now: P${pk.currentPosition} → P${r.predictedPosition}` : `${focus} pits in ${r.k}: P${pk.currentPosition} → P${r.predictedPosition} (${placesVsNow(r.positionsVsNow)})`;
    const tip = `in-lap L${r.inLap}, rejoin P${r.predictedPosition} at the end of L${r.targetLap}`;
    const now = r.k === 0 ? '—' : `P${r.positionIfPitNow} (${placesVsNow(r.positionsVsNow)}; waiting ${r.secondsVsNow >= 0 ? 'costs' : 'gains'} ${fmt1(Math.abs(r.secondsVsNow))} s)`;
    const others = pk.rivalsStop ? (r.rivalStops.length ? `stop when due: ${r.rivalStops.join(', ')}` : 'stop when due (none by then)') : 'no stops';
    o.push(`  ${String(r.k).padStart(2)}  ${centre.padEnd(36)} ${tip.padEnd(36)} ${now.padEnd(38)} ${others}`);
  }
  return o;
}

/** A compact signature of what the Circle of Doom shows for the focus (causality comparison). */
function codSignature(v, ks = []) {
  return Object.entries(codFields(v, ks)).map(([k, x]) => `${k}: ${x}`).join(' | ');
}

/**
 * The Circle of Doom readouts of the focus as named fields, in the words the
 * view prints (centre line, focus tooltip, "pit in k" tooltip rows).
 */
function codFields(v, ks = [], { rivals = false } = {}) {
  const { win, dist, disp } = v;
  if (!win.available) return { 'Pit now': `unavailable (${win.reason})` };
  const f = {
    'Pit now': `P${win.currentPosition} → P${win.predictedPosition}`,
    'Rejoin positions': (dist?.positions || []).map((p) => `P${p.position} ${pct1(p.probability)}`).join(' · '),
    'Pit loss': disp.isFallback ? `${fmt1(disp.value)} s fallback`
      : `${fmt1(disp.value)} s (p10–p90 ${fmt1(win.pitLoss.p10)}–${fmt1(win.pitLoss.p90)} s, ${disp.n} stops)`,
    'Traffic at the rejoin': trafficText(win.traffic),
    'Traffic probability': dist?.trafficProbability != null ? `${Math.round(dist.trafficProbability * 100)}%` : '—',
    'Gain the place': names(win.wouldPassFocus),
    'Within reach': names(win.wouldDropBehindFocus),
  };
  for (const k of ks) {
    const r = v.pk?.rows?.[k];
    f[`pit in ${k}${rivals ? ' (rivals on)' : ''}`] = r
      ? `rejoin P${r.predictedPosition} at the end of L${r.targetLap}; pitting now instead P${r.positionIfPitNow} (${placesVsNow(r.positionsVsNow)}; waiting ${r.secondsVsNow >= 0 ? 'costs' : 'gains'} ${fmt1(Math.abs(r.secondsVsNow))} s)`
        + `${rivals ? `; stopping by then: ${r.rivalStops.join(', ') || 'none'}` : ''}`
      : '—';
  }
  return f;
}

/** The focus card's Rivals rows: the store's own updateRivalContext at this clock. */
function rivalCard(R, clock, focus) {
  useF1Store.setState({
    sessionData: R.session, frameData: R.frameData, totalFrames: R.frames.length, frameDt: R.frameDt,
    maxTime: R.frameData.max_time, sessionTimeOffset: R.offset, maxLap: R.maxLap, lapFrameMap: R.lapFrameMap,
    currentFrameIndex: clock.idx, currentTime: clock.t, currentLap: clock.currentLap, isLiveMode: false,
    lapModeRaceOver: false, isQualifyingReplay: false, totalRaceLaps: null, dnfMap: R.dnfMap,
    trackStatus: R.ts, focusDriver: focus,
  });
  const s = useF1Store.getState();
  const nowStore = s.getSessionNow();
  s.updateRivalContext();
  const rc = useF1Store.getState().rivalContext || [];
  const arrow = { closing: '↑', opening: '↓', stable: '↔' };
  return {
    nowStore,
    text: rc.map((r) => `P${r.position} ${r.driver} ${r.gap != null ? `${r.gap > 0 ? '+' : ''}${r.gap.toFixed(1)}s` : '—'} ${arrow[r.gapTrend]} (${r.gapTrend}) ${letter(r.compound)} ${r.tyreAge}L`),
  };
}

/**
 * How long each readout holds over [t0, t1): every frame of the window is a
 * clock the reader can pause on; the view recomputes only on a causal event
 * (circleMemoKey / causalKey), so the fields are computed once per key. For
 * each field, its distinct values in time order with the frames they hold.
 */
function holdsByField(R, t0, t1, focus, fieldsFn) {
  const i0 = frameAtOrAfter(R, t0);
  const byKey = new Map();
  const runs = new Map();
  let total = 0;
  let first = null;
  let lastNow = null;
  for (let i = i0; i >= 0 && i < R.frames.length; i++) {
    const c = clockAt(R, i);
    if (c.sessionNow >= t1) break;
    total += 1;
    if (first == null) first = c.sessionNow;
    lastNow = c.sessionNow;
    const pitLoss = estimatePitLoss(R.lt, { sessionNow: c.sessionNow, sessionType: 'R' });
    const key = `${circleMemoKey(focus, R.lt, c.sessionNow, pitLoss, R.ts)}|${causalKey(R.lt, c.sessionNow, R.ts)}`;
    if (!byKey.has(key)) byKey.set(key, fieldsFn(c));
    for (const [name, value] of Object.entries(byKey.get(key))) {
      if (!runs.has(name)) runs.set(name, []);
      const list = runs.get(name);
      const last = list[list.length - 1];
      if (last && last.value === value) { last.frames += 1; last.to = c.sessionNow; } else list.push({ value, from: c.sessionNow, to: c.sessionNow, frames: 1 });
    }
  }
  return { runs, total, dt: R.frameDt, first, last: lastNow, states: byKey.size };
}
function printFieldHolds(title, h, t0, t1) {
  out(`  ${title}: window ${t0.toFixed(2)}..${t1.toFixed(2)} s (${(t1 - t0).toFixed(1)} s); frames ${h.first?.toFixed(2)}..${h.last?.toFixed(2)} s, ${h.total} frames of ${h.dt.toFixed(1)} s, ${h.states} causal states`);
  for (const [name, list] of h.runs) {
    const share = new Map();
    for (const r of list) share.set(r.value, (share.get(r.value) || 0) + r.frames);
    const spans = (v) => list.filter((r) => r.value === v).map((r) => `${r.from.toFixed(2)}–${(r.to + h.dt).toFixed(2)} s, ${(r.to + h.dt - r.from).toFixed(1)} s`).join('; ');
    out(`    ${name}: ${[...share.entries()].map(([v, n]) => `"${v}" ${pct1(n / h.total)} (${spans(v)})`).join('; ')}`);
  }
}

/** The Circle of Doom and focus-card readouts at one clock, as report lines. */
function viewLines(R, c, focus, extra = () => []) {
  const v = codView(R, c, focus);
  const vOn = codView(R, c, focus, { rivalsStop: true });
  const o = [];
  o.push(`   Circle of Doom, ${focus} in focus:`);
  for (const l of codText(v, focus)) o.push(`     ${l}`);
  for (const l of extra(v)) o.push(`     ${l}`);
  o.push('   pit in k laps, "rivals" off ([ / ] or the header stepper):');
  for (const l of pitInText(v, focus)) o.push(`     ${l}`);
  o.push('   pit in k laps, "rivals" ON (the toggle in the header):');
  for (const l of pitInText(vOn, focus)) o.push(`     ${l}`);
  const rc = rivalCard(R, c, focus);
  o.push(`   focus card, Rivals rows (store updateRivalContext at this clock, store clock ${rc.nowStore.toFixed(2)} s): ${rc.text.join(' | ')}`);
  return o;
}

/** Print the readouts at a clock for the backend and the demo frames (the demo's only when they differ). */
function printAtClock(label, clockFn, focus, headFn, extra) {
  const res = [BE, DE].map((R) => { const c = clockFn(R); return { R, c, head: headFn(R, c), body: viewLines(R, c, focus, extra ? (v) => extra(R, c, v) : undefined) }; });
  for (const { R, c, head, body } of res) {
    out(`  [${R.label}] ${label}: frame #${c.idx}, sessionNow ${c.sessionNow.toFixed(2)} s, replay lap ${c.currentLap}; ${head}`);
    if (R === DE && JSON.stringify(body.map((l) => l.replace(/store clock [0-9.]+ s/, ''))) === JSON.stringify(res[0].body.map((l) => l.replace(/store clock [0-9.]+ s/, '')))) {
      out('   every readout below identical to the backend clock above');
    } else body.forEach((l) => out(l));
  }
}

// ─── Undercut Calculator (analysis only: no control of the build opens it) ─

/** The panel's inputs and sweep (UndercutCalculator.jsx:108-169). */
function sweepAt(R, clock, focus, rival, choice = null, { lt = R.lt, totalLaps = R.maxLap } = {}) {
  const now = clock.sessionNow;
  const state = circleState(lt, { sessionNow: now, dnfMap: R.dnfMap, isLiveMode: false });
  const pitLoss = estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' });
  const raceParams = extractRaceParams(lt, completedStints(lt, now, { running: R.running }), R.ts, clock.currentLap, {
    sessionNow: now, sessionTimeOffset: R.offset, sessionType: 'R', running: R.running,
  });
  const sw = undercutSweep(focus, rival, state, pitLoss, raceParams, {
    totalLaps, rivalStopLap: choice?.lap ?? undefined, rivalStopStints: choice?.stints ?? undefined,
  });
  const nr = state.cars.find((c) => c.driver === rival)?.lapsCompleted ?? clock.currentLap;
  const options = [];
  for (let l = nr + 1; l < totalLaps; l++) options.push(l);
  return { sw, options, lapsLeft: Math.max(0, R.maxLap - clock.currentLap) };
}
const STOP_SOURCE = {
  race: 'stint-life survival of this race', prior: 'stint-life survival of the cached races (prior)', chosen: 'chosen here',
  'in progress': 'stop in progress', none: 'its set is not due before the flag',
};
function sweepText({ sw, options, lapsLeft }, focus, rival, choice) {
  if (!sw.available) return [`unavailable: ${sw.reason}`];
  const b = sw.best;
  const rs = sw.rivalStop;
  const tag = (t) => `${letter(t.current.compound)}·L${t.current.tyreLife ?? '?'}`;
  const disp = pitLossDisplay(sw.pitLoss);
  return [
    `FOCUS ${focus} ${tag(sw.focusTyre)} vs RIVAL ${rival} ${tag(sw.rivalTyre)}; GAP NOW ${sgn2(sw.currentGap)}s; PIT LOSS ${disp.value.toFixed(1)}s (n ${disp.n}); NEW-TYRE GAIN ${sgn3(sw.freshGain)}s; LAPS LEFT ${lapsLeft}`,
    `${b.gap > 0 ? '✓ AHEAD AFTER BOTH STOPS' : '✗ BEHIND AFTER BOTH STOPS'}: Best pit lap L${b.inLap} → ${focus} ${b.gap > 0 ? 'ahead' : 'behind'} by ${Math.abs(b.gap).toFixed(2)}s at the flag (end of L${b.horizonLap}) (${b.change >= 0 ? 'gains' : 'loses'} ${Math.abs(b.change ?? 0).toFixed(2)}s on now)`,
    `RIVAL STOPS [${choice ? `L${choice.lap}` : 'likely'}] -> "${rs.inLap != null && rs.inRace ? `L${rs.inLap}` : 'no stop before the flag'} · ${STOP_SOURCE[rs.source] || rs.source}"${rs.expiredChoice ? ` (choice L${rs.expiredChoice} expired: ${rs.expiredReason})` : ''}; select offers L${options[0]}..L${options[options.length - 1]}`,
    `PIT-LAP SWEEP: ${sw.rows.map((r) => `${r.k === 0 ? 'NOW' : `L${r.inLap}`}${r.extraStops.length ? ` +${r.extraStops.length}` : ''} ${sgn2(r.gap)}`).join(' | ')}`,
    `lap model: ${sw.focusTyre.compound} ${sgn3(sw.degradation.focus.mean)} s/lap (${sw.degradation.focus.source}${sw.degradation.focus.n != null ? `, n ${sw.degradation.focus.n}` : ''}), new set ${sw.nextCompound}, fresh-tyre delta ${sw.freshDeltaInfo ? `${sgn3(sw.freshDeltaInfo.value)} s (${sw.freshDeltaInfo.source})` : sgn3(sw.freshDelta)}`,
  ];
}

// ─── load ────────────────────────────────────────────────────────────────

const beSession = parse(fs.readFileSync(path.join(CACHE, `session_${YEAR}_${ROUND}_R.json`), 'utf8'));
const beFrames = parse(fs.readFileSync(path.join(CACHE, `frames_${YEAR}_${ROUND}_R.json`), 'utf8'));
const BE = makeRace(beSession, beFrames, 'backend');
const demoDir = path.join(DEMO_DIR, `${YEAR}_${ROUND}_R`);
let demoSource;
let DE;
if (fs.existsSync(path.join(demoDir, 'frames.json.gz')) && fs.existsSync(path.join(demoDir, 'session.json.gz'))) {
  const s = parse(zlib.gunzipSync(fs.readFileSync(path.join(demoDir, 'session.json.gz'))).toString('utf8'));
  const f = parse(zlib.gunzipSync(fs.readFileSync(path.join(demoDir, 'frames.json.gz'))).toString('utf8'));
  DE = makeRace(s, f, 'demo');
  demoSource = `frontend/public/data/${YEAR}_${ROUND}_R (the demo's own files); lap_times identical to the backend cache: ${JSON.stringify(s.lap_times) === JSON.stringify(beSession.lap_times)}; track_status identical: ${JSON.stringify(s.track_status) === JSON.stringify(beSession.track_status)}`;
} else {
  DE = makeRace(beSession, { ...beFrames, frames: beFrames.frames.filter((_, i) => i % DEMO_FRAME_STEP === 0) }, 'demo');
  demoSource = `derived here: frontend/public/data/${YEAR}_${ROUND}_R not present at this run; backend frames[::${DEMO_FRAME_STEP}] (export_demo_data.py slim_frames), the backend's session rows`;
}

// ─── A. race, frames, events, clocks ────────────────────────────────────

out(`UC5, Imola 2024 (${YEAR} R${ROUND}), the strategist's undercut fight PIA vs SAI. Report of frontend/scripts/usecases/uc5_imola24_undercut.mjs`);
out('');
out('A. Race, replay frames, events, reachable clocks');
out(`  race: ${beSession.circuit_info?.event_name}, ${BE.maxLap} laps (lap table ${BE.tableMax}, frames total_laps ${beFrames.total_laps}); retired per the results: ${Object.keys(BE.dnfMap).join(', ') || 'none'}`);
out(`  backend frames: ${BE.frames.length}, frame dt ${BE.frameDt.toFixed(1)} s; demo frames: ${DE.frames.length}, frame dt ${DE.frameDt.toFixed(1)} s (${demoSource})`);
out(`  session-time offset (first LapStartTime): ${BE.offset.toFixed(3)} s; sessionNow = frame.t + offset`);
const statusList = BE.ts.map((e) => `${e.status}@${Number(e.start_time).toFixed(0)}`).join(', ');
out(`  track-status events (status@session s): ${statusList || 'none'}`);
const neutral = [...new Set(BE.lt.filter((r) => /[4567]/.test(String(r.TrackStatus))).map((r) => r.LapNumber))].sort((a, b) => a - b);
out(`  lap rows with SC / VSC / red status (any driver): ${neutral.length ? neutral.join(', ') : 'none'}`);
const ev = (d, l) => {
  const r = row(BE, d, l);
  return `${d} L${l}: ends ${lapEndTime(r)?.toFixed(3)} s${hasPitIn(r) ? `, pit entry ${pitInSeconds(r)?.toFixed(3)} s` : ''}${pitOutSeconds(r) != null ? `, pit exit ${pitOutSeconds(r).toFixed(3)} s` : ''}, ${r.Compound} age ${r.TyreLife}, P${r.Position}`;
};
for (const [d, l] of [['PIA', 22], ['PIA', 23], ['PIA', 24], ['SAI', 22], ['SAI', 23], ['SAI', 24], ['SAI', 27], ['SAI', 28], ['PIA', 28]]) out(`  ${ev(d, l)}`);
for (const L of [23, 24, 25, 29, 30]) {
  out(`  leader's crossing of L${L - 1} (lap table): ${leaderLapEndTime(BE.lt, L - 1)?.toFixed(3)} s; lap seek "lap ${L}" -> backend frame #${BE.lapFrameMap[L]} at ${clockAt(BE, BE.lapFrameMap[L]).sessionNow.toFixed(2)} s,`
    + ` demo frame #${DE.lapFrameMap[L]} at ${clockAt(DE, DE.lapFrameMap[L]).sessionNow.toFixed(2)} s`);
}
const lastBE = clockAt(BE, BE.frames.length - 1);
const lastDE = clockAt(DE, DE.frames.length - 1);
out(`  timeline "Skip to end" button (store showRaceOver: the last frame): backend #${lastBE.idx} sessionNow ${lastBE.sessionNow}, demo #${lastDE.idx} sessionNow ${lastDE.sessionNow} (Infinity = the race-over clock)`);
out(`  End key (hooks/useKeyboardShortcuts.js: setCurrentLap(maxLap), a lap seek): backend frame #${BE.lapFrameMap[BE.maxLap]} at ${clockAt(BE, BE.lapFrameMap[BE.maxLap]).sessionNow.toFixed(2)} s, demo frame #${DE.lapFrameMap[DE.maxLap]} at ${clockAt(DE, DE.lapFrameMap[DE.maxLap]).sessionNow.toFixed(2)} s (the leader starts lap ${BE.maxLap}; not the race-over clock)`);

// ─── B. D1: PIA's pit wall ───────────────────────────────────────────────

const xPIA22 = crossing(BE, 'PIA', 22);
const pinPIA = pitInSeconds(row(BE, 'PIA', 23));
const headOf = (focus, rival) => (R, c) => {
  const st = circleState(R.lt, { sessionNow: c.sessionNow, dnfMap: R.dnfMap, gridPositions: R.grid, isLiveMode: false });
  const a = st.cars.find((x) => x.driver === focus);
  const b = st.cars.find((x) => x.driver === rival);
  return `${focus} laps completed ${a.lapsCompleted} (P${a.position}${a.inPitLane ? ', in the pit lane' : ''}), ${rival} laps completed ${b.lapsCompleted} (P${b.position}${b.inPitLane ? ', in the pit lane' : ''});`
    + ` ${rival}'s gap tag on the ring ${signedSeconds(gapSeconds(focus, rival, st))} s (exact ${sgn2(gapSeconds(focus, rival, st))} s; − = ahead of ${focus})`;
};
const tagsLine = (list) => (R, c, v) => [`gap tags of the other cars on the ring (to the focus; − = ahead): ${list.map((d) => `${d} ${v.tags[d]}`).join(', ')}`];
out('');
out(`B. D1, PIA's pit wall: "box at the end of L23 (the lap in progress)?". Decision window: PIA's crossing of L22 ${xPIA22.toFixed(3)} s to its pit entry ${pinPIA.toFixed(3)} s (${(pinPIA - xPIA22).toFixed(1)} s)`);
out('');
out('B.1 Lap seek "lap 24" (→ until the lap counter reads 24, a click on lap 24 of the expanded timeline, or Ctrl+K "Jump to Lap" > "Lap 24")');
printAtClock('lap seek "lap 24"', (R) => clockAt(R, R.lapFrameMap[24]), 'PIA', headOf('PIA', 'SAI'), tagsLine(['VER', 'NOR', 'LEC', 'SAI', 'HAM', 'PER', 'STR']));
out(`  the lap seek "lap 24" lands ${(pinPIA - clockAt(BE, BE.lapFrameMap[24]).sessionNow).toFixed(1)} s (backend) / ${(pinPIA - clockAt(DE, DE.lapFrameMap[24]).sessionNow).toFixed(1)} s (demo) before PIA's pit entry, `
  + `${(clockAt(BE, BE.lapFrameMap[24]).sessionNow - xPIA22).toFixed(1)} s after PIA's L22 crossing`);
out('');
out('B.2 Pause at the first frame after PIA crosses the line at the end of L22 (frame-precise: play and pause, or drag the timeline)');
printAtClock('first frame after PIA\'s L22 crossing', (R) => clockAt(R, frameAtOrAfter(R, xPIA22)), 'PIA', headOf('PIA', 'SAI'), tagsLine(['VER', 'NOR', 'LEC', 'SAI', 'HAM', 'PER', 'STR']));
out('');
out('B.3 How long each readout holds over the D1 window (share of the frames a reader can pause on)');
for (const R of [BE, DE]) {
  const h = holdsByField(R, xPIA22, pinPIA, 'PIA', (c) => ({
    ...codFields(codView(R, c, 'PIA'), [1, 2, 3, 4]),
    ...Object.fromEntries(Object.entries(codFields(codView(R, c, 'PIA', { rivalsStop: true }), [8, 9], { rivals: true })).filter(([k]) => k.startsWith('pit in'))),
  }));
  printFieldHolds(`[${R.label}] Circle of Doom, PIA in focus`, h, xPIA22, pinPIA);
}

// ─── C. D2: SAI's pit wall ───────────────────────────────────────────────

const xSAI23 = crossing(BE, 'SAI', 23);
const xSAI24 = crossing(BE, 'SAI', 24);
const tD2 = Math.max(pinPIA, xSAI23);
const piaInRank = (R, c, v) => {
  const rcp = v.win.rivalCrossings?.find((x) => x.driver === 'PIA');
  return [
    `(not displayed) PIA in the rank of SAI's rejoin: crossing of L${v.win.targetLap} ${rcp?.time?.toFixed(2)} s (projected: ${rcp?.projected}, stage ${rcp?.stage ?? '-'}, pending loss ${rcp?.pendingLoss?.toFixed(1) ?? '-'} s, pace ${rcp?.pace?.toFixed(3)} s/lap from ${rcp?.paceSource})`
      + ` against SAI's predicted ${v.win.predictedCrossing.toFixed(2)} s: SAI ${v.win.predictedCrossing < rcp?.time ? 'ahead' : 'behind'} by ${Math.abs(rcp.time - v.win.predictedCrossing).toFixed(2)} s at the end of L${v.win.targetLap}`,
    `gap tags of the other cars on the ring (to SAI; − = ahead): ${['VER', 'NOR', 'LEC', 'PIA', 'HAM', 'PER', 'STR'].map((d) => `${d} ${v.tags[d]}`).join(', ')}`,
  ];
};
out('');
out(`C. D2, SAI's pit wall: "PIA has boxed: cover at the end of L24 or stay out?". Window: PIA's pit entry ${pinPIA.toFixed(3)} s (SAI crossed L23 at ${xSAI23.toFixed(3)} s) to SAI's crossing of L24 ${xSAI24.toFixed(3)} s (${(xSAI24 - tD2).toFixed(1)} s); SAI's pit entries in this race come ${(crossing(BE, 'SAI', 27) - pitInSeconds(row(BE, 'SAI', 27))).toFixed(1)} s before its line crossing (L27)`);
out('');
out('C.1 Pause at the first frame after PIA enters the pit lane (play on from the lap seek "lap 24", pause when PIA is on the pit-lane arc)');
printAtClock('first frame after PIA\'s pit entry', (R) => clockAt(R, frameAtOrAfter(R, tD2)), 'SAI', headOf('SAI', 'PIA'), piaInRank);
out('');
out('C.2 Lap seek "lap 25" (the leader starts L25; SAI is then a few seconds from its own pit entry)');
printAtClock('lap seek "lap 25"', (R) => clockAt(R, R.lapFrameMap[25]), 'SAI', headOf('SAI', 'PIA'), piaInRank);
{
  const entryLead = crossing(BE, 'SAI', 27) - pitInSeconds(row(BE, 'SAI', 27));
  for (const R of [BE, DE]) {
    const c = clockAt(R, R.lapFrameMap[25]);
    out(`  [${R.label}] the lap seek "lap 25" lands ${(xSAI24 - c.sessionNow).toFixed(1)} s before SAI's L24 crossing, about ${(xSAI24 - entryLead - c.sessionNow).toFixed(1)} s before a pit entry ${entryLead.toFixed(1)} s ahead of the line (SAI's L27 entry)`);
  }
}
out('');
out('C.3 How long each readout holds over the D2 window');
for (const R of [BE, DE]) {
  const h = holdsByField(R, tD2, xSAI24, 'SAI', (c) => codFields(codView(R, c, 'SAI'), [1, 2, 3]));
  printFieldHolds(`[${R.label}] Circle of Doom, SAI in focus`, h, tD2, xSAI24);
}
out(`  PIA's first flying lap on the new set (L25) ${row(BE, 'PIA', 25).LapTimeSeconds.toFixed(3)} s against its last full lap on the old set (L22) ${row(BE, 'PIA', 22).LapTimeSeconds.toFixed(3)} s`
  + ` (hindsight; the window projects PIA at its pace on the old set)`);

// ─── D. what happened ────────────────────────────────────────────────────

out('');
out('D. What happened (hindsight: the lap rows after the decision clocks)');
out('D.1 Stops and lap rows');
const stopsOf = (d) => [...BE.byDrv.get(d).values()].filter((r) => hasPitIn(r)).map((r) => `L${r.LapNumber} (${r.Compound} -> ${row(BE, d, r.LapNumber + 1)?.Compound})`);
out(`  pit entries: PIA ${stopsOf('PIA').join(', ')}; SAI ${stopsOf('SAI').join(', ')}`);
out('  lap | PIA lap time, set, age, pos | SAI lap time, set, age, pos | gap at the line (SAI crossing − PIA crossing; + = PIA ahead)');
for (let l = 20; l <= 30; l++) {
  const a = row(BE, 'PIA', l); const b = row(BE, 'SAI', l);
  const f = (r) => `${r.LapTimeSeconds?.toFixed(3)} ${letter(r.Compound)} ${String(r.TyreLife).padStart(2)} P${r.Position}${hasPitIn(r) ? ' IN ' : pitOutSeconds(r) != null ? ' OUT' : '    '}`;
  out(`  L${l} | ${f(a)} | ${f(b)} | ${sgn2(crossing(BE, 'SAI', l) - crossing(BE, 'PIA', l))} s`);
}
const lossPIA = perStopLoss(BE.lt, 'PIA', 23, { sessionType: 'R' });
const lossSAI = perStopLoss(BE.lt, 'SAI', 27, { sessionType: 'R' });
const whole = estimatePitLoss(BE.lt, { sessionType: 'R' });
out(`  measured stop loss (utils/pitLoss.js perStopLoss, whole race): PIA L23 ${lossPIA.loss?.toFixed(1)} s (${lossPIA.source}), SAI L27 ${lossSAI.loss?.toFixed(1)} s (${lossSAI.source}); race median over ${whole.n} green-flag stops ${whole.median.toFixed(1)} s`);
const res = Object.fromEntries((beSession.race_results || []).map((r) => [r.Abbreviation, r]));
const lastCommon = Math.min(Math.max(...BE.byDrv.get('PIA').keys()), Math.max(...BE.byDrv.get('SAI').keys()));
out(`  classified: PIA ${res.PIA?.ClassifiedPosition} (${res.PIA?.Status}), SAI ${res.SAI?.ClassifiedPosition} (${res.SAI?.Status}); gap at the end of L${lastCommon}: ${sgn2(crossing(BE, 'SAI', lastCommon) - crossing(BE, 'PIA', lastCommon))} s`);
out('D.2 The Circle of Doom projections against the lap rows');
out(`  D1 check: PIA pitted at the end of L23 as "pit now" assumed; PIA's place at the end of L24 (its out-lap, the target lap) P${row(BE, 'PIA', 24).Position}`);
out(`  D1 check, one lap on: PIA's place at the end of L25 (the "pitting now instead" place of pit in 1) P${row(BE, 'PIA', 25).Position}`);
out(`  D2 check: SAI pitted at the end of L27 (k = 3 from the D2 clock); SAI's place at the end of L28 (the target lap of k = 3) P${row(BE, 'SAI', 28).Position}`);
out('D.3 The Circle of Doom read back after both stops (PIA in focus; SAI\'s gap tag on the ring, also in its tooltip as "Gap to PIA"):');
for (const [name, fn] of [
  ['lap seek "lap 30"', (R) => clockAt(R, R.lapFrameMap[30])],
  ['first frame after SAI\'s crossing of L28', (R) => clockAt(R, frameAtOrAfter(R, crossing(R, 'SAI', 28)))],
  ['End key (lap seek to the last lap)', (R) => clockAt(R, R.lapFrameMap[R.maxLap])],
  ['timeline Skip to end button (last frame, race over)', (R) => clockAt(R, R.frames.length - 1)],
]) {
  for (const R of [BE, DE]) {
    const c = fn(R);
    const st = circleState(R.lt, { sessionNow: c.sessionNow, dnfMap: R.dnfMap, gridPositions: R.grid, isLiveMode: false });
    const A = st.cars.find((x) => x.driver === 'PIA'); const B = st.cars.find((x) => x.driver === 'SAI');
    out(`    [${R.label}] ${name}: frame #${c.idx}, sessionNow ${Number.isFinite(c.sessionNow) ? `${c.sessionNow.toFixed(2)} s` : c.sessionNow}; PIA P${A?.position} (${A?.lapsCompleted} laps), SAI P${B?.position} (${B?.lapsCompleted} laps);`
      + ` SAI's gap tag to PIA ${signedSeconds(gapSeconds('PIA', 'SAI', st))} s (exact ${sgn2(gapSeconds('PIA', 'SAI', st))} s)`);
  }
}
{
  const t0 = crossing(BE, 'SAI', 28); const t1 = crossing(BE, 'SAI', 29);
  out(`  hold of the +${(crossing(BE, 'SAI', 28) - crossing(BE, 'PIA', 28)).toFixed(2)} s tag: from SAI's L28 crossing ${t0.toFixed(2)} s until SAI's L29 crossing ${t1.toFixed(2)} s (${(t1 - t0).toFixed(1)} s; the tag reads the latest lap both cars have completed)`);
}

// ─── E. model inputs ─────────────────────────────────────────────────────

out('');
out('E. Model inputs at the clocks of B and C (the pit loss is this race\'s; the other estimates as labelled)');
for (const [name, c, focus] of [
  ['D1 lap seek "lap 24"', clockAt(BE, BE.lapFrameMap[24]), 'PIA'],
  ['D1 pause (PIA crossed L22)', clockAt(BE, frameAtOrAfter(BE, xPIA22)), 'PIA'],
  ['D2 pause (PIA pit entry)', clockAt(BE, frameAtOrAfter(BE, tD2)), 'SAI'],
]) {
  const pl = estimatePitLoss(BE.lt, { sessionNow: c.sessionNow, sessionType: 'R' });
  const smp = (pl.samples || []).map((s) => `${s.driver} L${s.inLap} ${s.loss.toFixed(1)}`).join(', ');
  out(`  ${name}, ${c.sessionNow.toFixed(2)} s: pit loss ${pl.source}, median ${pl.median.toFixed(2)} s, p10 ${pl.p10?.toFixed(2)} s, p90 ${pl.p90?.toFixed(2)} s, n ${pl.n}; samples: ${smp}`);
  const v = codView(BE, c, focus);
  const d = v.pk?.degradation;
  const est = v.raceParams?.estimates || {};
  out(`    lap model (pit in k): ${d?.current?.compound} ${sgn3(d?.current?.mean)} s/lap (${d?.current?.source}${d?.current?.n != null ? `, ${d.current.n} stints` : ''}) -> ${d?.next?.compound} ${sgn3(d?.next?.mean)} s/lap (${d?.next?.source}${d?.next?.n != null ? `, ${d.next.n} stints` : ''});`
    + ` fresh-tyre delta ${est.freshDelta ? `${sgn3(est.freshDelta.value)} s (${est.freshDelta.source}${est.freshDelta.n != null ? `, n ${est.freshDelta.n}` : ''})` : 'n/a'}`);
  out(`    focus pace of the window ${v.win.pace?.toFixed(3)} s/lap (${v.win.paceSource}); reference lap ${v.win.refLap?.toFixed(3)} s; next compound modelled ${v.pk?.nextCompound}`);
}
out('  the cross-race priors (PRIORS, utils/raceSimulation.js) are fitted on all 30 cached races, Imola 2024 included; this race\'s per-compound degradation is combined with them (raceDegradation), its stint-life survival takes the prior\'s tail past its longest stint');

// ─── F. causality ────────────────────────────────────────────────────────

out('');
out('F. Causality: the readouts of B and C (Circle of Doom; pit in k with rivals off and on) with the future rewritten must not change');
const futureTs = (ts, now) => ts.map((e) => (e.start_time != null && e.start_time > now ? { ...e, start_time: e.start_time + 7, status: '4' } : e))
  .concat([{ status: '6', start_time: now + 30, end_time: now + 200, message: 'VSCDeployed' }]);
for (const [name, c, focus] of [
  ['D1 lap seek', clockAt(BE, BE.lapFrameMap[24]), 'PIA'],
  ['D1 pause', clockAt(BE, frameAtOrAfter(BE, xPIA22)), 'PIA'],
  ['D2 pause', clockAt(BE, frameAtOrAfter(BE, tD2)), 'SAI'],
]) {
  const sig = (opts) => codSignature(codView(BE, c, focus, opts), [1, 2, 3, 4]) + pitInText(codView(BE, c, focus, { ...opts, rivalsStop: true }), focus).join('\n');
  const ref = sig({});
  const fut = sig({ lt: perturbFuture(BE.lt, c.sessionNow), ts: futureTs(BE.ts, c.sessionNow) });
  const noDnf = sig({ dnfMap: {} });
  const past = BE.lt.map((r) => (r.Driver === focus && lapEndTime(r) != null && lapEndTime(r) <= c.sessionNow - 1 && r.LapNumber >= 17
    ? { ...r, LapTimeSeconds: r.LapTimeSeconds + 0.5, LapTime: r.LapTime + 0.5 } : r));
  const ctl = sig({ lt: past });
  out(`  ${name} (${focus}, ${c.sessionNow.toFixed(2)} s): future rows + track status rewritten ${fut === ref ? 'identical' : 'DIFFERENT'}; dnfMap = {} ${noDnf === ref ? 'identical' : 'DIFFERENT'};`
    + ` positive control (the focus's completed laps from L17 +0.5 s) ${ctl === ref ? 'UNCHANGED (the test would be blind)' : 'changed'}`);
}

// ─── G. Undercut Calculator: analysis only ───────────────────────────────

out('');
out('G. ANALYSIS ONLY, NOT DISPLAYED. The Undercut Calculator is in App.jsx\'s view map but no control opens it (utils/slotOptions.js,');
out('   DockedLayout VIZ_TABS, the command palette and the window presets do not list it); its numbers below are what utils/undercut.js');
out('   undercutSweep returns with the panel\'s arguments (UndercutCalculator.jsx:108-169), never what a reader sees.');
{
  // Where a view id can come from: the dock registry, the docked layout's tab picker, the command
  // palette, the window presets, the store's dock defaults and keys; App.jsx's view map holds the id
  const SRC = path.join(ROOT, 'frontend/src');
  const count = (rel, re) => (fs.readFileSync(path.join(SRC, rel), 'utf8').match(re) || []).length;
  const idRe = /['"]undercut['"]/g;
  const where = [
    'utils/slotOptions.js', 'components/layout/DockedLayout.jsx', 'components/CommandPalette/commandRegistry.js',
    'utils/windowPresets.js', 'hooks/useKeyboardShortcuts.js', 'store/useF1Store.js', 'components/layout/PitWallLayout.jsx',
  ].map((rel) => `${rel} ${count(rel, idRe)}`).join(', ');
  out(`   occurrences of the id 'undercut' as a string: ${where}; App.jsx view-map key "undercut:" ${count('App.jsx', /^\s*undercut:\s*\{/gm)}`);
}
{
  const R = BE;
  const c1 = clockAt(R, frameAtOrAfter(R, xPIA22));
  const likely = sweepAt(R, c1, 'PIA', 'SAI');
  const choice = { lap: 24, stints: likely.sw.rivalTyre?.stints ?? null };
  out(`G.1 D1 at ${c1.sessionNow.toFixed(2)} s (frame #${c1.idx}), focus PIA, rival SAI, RIVAL STOPS = likely:`);
  for (const l of sweepText(likely, 'PIA', 'SAI', null)) out(`    ${l}`);
  const cov = sweepAt(R, c1, 'PIA', 'SAI', choice);
  out('G.2 same clock, RIVAL STOPS = L24 (the strategist\'s cover hypothesis: SAI boxes one lap after PIA):');
  for (const l of sweepText(cov, 'PIA', 'SAI', choice)) out(`    ${l}`);
  const cs = sweepAt(R, clockAt(R, R.lapFrameMap[24]), 'PIA', 'SAI', choice);
  out(`  at the lap seek "lap 24" (${clockAt(R, R.lapFrameMap[24]).sessionNow.toFixed(2)} s), RIVAL STOPS = L24: ${sweepText(cs, 'PIA', 'SAI', choice).slice(1, 2).join('')}`);
  // expiry of the choice (UndercutCalculator.jsx:170-174): the choice L24 kept from the D1 clock on
  out('G.3 expiry of the RIVAL STOPS choice L24 made at D1 (UndercutCalculator.jsx:170-174: a choice the rival has passed, or made before');
  out('  it changed tyres, is dropped and the select returns to "likely"); every distinct state from D1 to 5340 s:');
  let prev = null;
  for (let i = c1.idx; i < R.frames.length; i++) {
    const c = clockAt(R, i);
    if (c.sessionNow > 5340) break;
    const k = causalKey(R.lt, c.sessionNow, R.ts);
    if (k === prev?.key) continue;
    const s = sweepAt(R, c, 'PIA', 'SAI', choice).sw;
    const desc = s.available
      ? `${s.rivalStop.source === 'chosen' ? 'choice kept' : `choice DROPPED (source ${s.rivalStop.source}${s.rivalStop.expiredChoice ? `, expired L${s.rivalStop.expiredChoice}: ${s.rivalStop.expiredReason}` : ''}) -> the select resets to likely`}; ${s.best.gap > 0 ? 'AHEAD' : 'BEHIND'} best L${s.best.inLap} ${sgn2(s.best.gap)}`
      : `panel unavailable (${s.reason}); the choice is kept while unavailable`;
    if (!prev || prev.desc !== desc) out(`    from ${c.sessionNow.toFixed(2)} s (frame #${i}): ${desc}`);
    prev = { key: k, desc };
  }
  // the scrub of the laps before (a chosen lap expires: it is set again at each lap)
  out('G.4 scrub, first frame after PIA\'s crossing of L17..L22: RIVAL STOPS likely | RIVAL STOPS = that lap + 2 (to be set again at every lap):');
  for (let l = 17; l <= 22; l++) {
    const c = clockAt(R, frameAtOrAfter(R, crossing(R, 'PIA', l)));
    const a = sweepAt(R, c, 'PIA', 'SAI');
    const b = sweepAt(R, c, 'PIA', 'SAI', { lap: l + 2, stints: a.sw.rivalTyre?.stints ?? null });
    const t = (x) => (x.sw.available ? `${x.sw.best.gap > 0 ? 'AHEAD' : 'BEHIND'} best L${x.sw.best.inLap} ${sgn2(x.sw.best.gap)} (rival L${x.sw.rivalStop.inLap}, ${x.sw.rivalStop.source})` : x.sw.reason);
    out(`    end of L${l} (${c.sessionNow.toFixed(1)} s): GAP NOW ${sgn2(a.sw.currentGap)} | ${t(a)} | ${t(b)}`);
  }
  // D2 with SAI in focus
  const c2 = clockAt(R, frameAtOrAfter(R, tD2));
  out(`G.5 D2 at ${c2.sessionNow.toFixed(2)} s, focus SAI, rival PIA (stop in progress, the select is disabled):`);
  for (const l of sweepText(sweepAt(R, c2, 'SAI', 'PIA'), 'SAI', 'PIA', null)) out(`    ${l}`);
  // gap after both stops, horizon cut at the end of SAI's out-lap (never displayed)
  const st = circleState(R.lt, { sessionNow: c1.sessionNow, dnfMap: R.dnfMap, isLiveMode: false });
  const off = st.cars.find((x) => x.driver === 'PIA')?.lapOffsetToLeader || 0;
  const cut = sweepAt(R, c1, 'PIA', 'SAI', { lap: 27, stints: choice.stints }, { totalLaps: 28 + off });
  const r23 = cut.sw.rows?.find((x) => x.inLap === 23);
  out(`G.6 the same maths with SAI in at its real in-lap L27 and the horizon at the end of L${r23?.horizonLap} (after both stops, NOT a horizon the panel uses):`
    + ` column L23 ${sgn2(r23?.gap)} s against the real ${sgn2(crossing(R, 'SAI', 28) - crossing(R, 'PIA', 28))} s`);
  out('G.7 the demo frames (verdict lines only):');
  for (const [name, cc] of [['lap seek "lap 24"', clockAt(DE, DE.lapFrameMap[24])], ['pause after PIA\'s L22 crossing', clockAt(DE, frameAtOrAfter(DE, xPIA22))]]) {
    const a = sweepAt(DE, cc, 'PIA', 'SAI');
    const b = sweepAt(DE, cc, 'PIA', 'SAI', { lap: 24, stints: a.sw.rivalTyre?.stints ?? null });
    out(`  [demo] ${name} ${cc.sessionNow.toFixed(2)} s: likely ${sweepText(a, 'PIA', 'SAI', null)[1]} | L24 ${sweepText(b, 'PIA', 'SAI', { lap: 24 })[1]}`);
  }
}

// ─── H. second vignette: GAS vs SAR ──────────────────────────────────────

out('');
out('H. Second vignette, the same race: GAS (P16) vs SAR, GAS boxes at the end of L30, SAR covers at L31');
{
  const xG29 = crossing(BE, 'GAS', 29);
  const pinG = pitInSeconds(row(BE, 'GAS', 30));
  out(`  GAS crosses L29 at ${xG29.toFixed(3)} s, pit entry ${pinG.toFixed(3)} s; SAR crosses L29 at ${crossing(BE, 'SAR', 29).toFixed(3)} s`);
  for (const [name, fn] of [
    ['lap seek "lap 31"', (R) => clockAt(R, R.lapFrameMap[31])],
    ['pause after GAS crosses L29', (R) => clockAt(R, frameAtOrAfter(R, xG29))],
  ]) {
    for (const R of [BE, DE]) {
      const c = fn(R);
      const g = c.sessionNow >= xG29 && c.sessionNow < pinG;
      const v = codView(R, c, 'GAS');
      const vOn = codView(R, c, 'GAS', { rivalsStop: true });
      out(`  [${R.label}] ${name}: frame #${c.idx}, ${c.sessionNow.toFixed(2)} s (inside GAS's decision window: ${g}); SAR's gap tag to GAS ${v.tags.SAR}`);
      for (const l of codText(v, 'GAS').slice(0, 3)) out(`     ${l}`);
      const r1 = vOn.pk?.rows?.[1];
      out(`     rivals ON, k = 1: ${r1 ? `in-lap L${r1.inLap}, rejoin P${r1.predictedPosition} at the end of L${r1.targetLap}; pitting now instead P${r1.positionIfPitNow} (${placesVsNow(r1.positionsVsNow)}; waiting ${r1.secondsVsNow >= 0 ? 'costs' : 'gains'} ${fmt1(Math.abs(r1.secondsVsNow))} s); stopping by then: ${r1.rivalStops.join(', ') || 'none'}` : 'n/a'}`);
    }
  }
  for (const R of [BE, DE]) {
    const h = holdsByField(R, xG29, pinG, 'GAS', (c) => codFields(codView(R, c, 'GAS', { rivalsStop: true }), [1, 10], { rivals: true }));
    printFieldHolds(`[${R.label}] H hold, Circle of Doom GAS (rivals ON)`, h, xG29, pinG);
  }
  const c = clockAt(BE, frameAtOrAfter(BE, xG29));
  const lk = sweepAt(BE, c, 'GAS', 'SAR');
  const cv = sweepAt(BE, c, 'GAS', 'SAR', { lap: 31, stints: lk.sw.rivalTyre?.stints ?? null });
  out(`  (analysis only, not displayed) Undercut Calculator GAS vs SAR at ${c.sessionNow.toFixed(2)} s: likely ${sweepText(lk, 'GAS', 'SAR', null)[1]} / ${sweepText(lk, 'GAS', 'SAR', null)[2]}`);
  out(`    RIVAL STOPS = L31: ${sweepText(cv, 'GAS', 'SAR', { lap: 31 })[1]}`);
  out(`  truth: GAS ${stopsOf('GAS').join(', ')}; SAR ${stopsOf('SAR').join(', ')}; gap at the line end of L32 (SAR − GAS) ${sgn2(crossing(BE, 'SAR', 32) - crossing(BE, 'GAS', 32))} s;`
    + ` classified GAS ${res.GAS?.ClassifiedPosition} (${res.GAS?.Status}), SAR ${res.SAR?.ClassifiedPosition} (${res.SAR?.Status});`
    + ` stop losses GAS L30 ${perStopLoss(BE.lt, 'GAS', 30, { sessionType: 'R' }).loss?.toFixed(1)} s, SAR L31 ${perStopLoss(BE.lt, 'SAR', 31, { sessionType: 'R' }).loss?.toFixed(1)} s;`
    + ` GAS place at the end of L31 (its out-lap) P${row(BE, 'GAS', 31).Position}`);
  const lastG = Math.min(Math.max(...BE.byDrv.get('GAS').keys()), Math.max(...BE.byDrv.get('SAR').keys()));
  out(`  gap at the end of L${lastG} (last lap both completed; both lapped): ${sgn2(crossing(BE, 'SAR', lastG) - crossing(BE, 'GAS', lastG))} s`);
}

const text = lines.join('\n');
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${text}\n`);
