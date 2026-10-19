/**
 * Use case UC4, China 2024 (2024 R5, a race of the static demo): the race
 * strategist's pit calls under the Virtual Safety Car (VSC) and the Safety
 * Car (SC). NOR stops under the VSC (in-lap 22), VER under the SC (in-lap
 * 23), SAI stays out.
 *
 * What it computes, causally, with the app's own modules called the way the
 * Circle of Doom calls them (components/visualizations/CircleOfDoom.jsx):
 *   pitLoss  = estimatePitLoss(lapTimes, { sessionNow, sessionType: 'R' })      jsx:1022-1025
 *   state    = circleState(lapTimes, { sessionNow, dnfMap, gridPositions,
 *              isLiveMode: false })                                             jsx:1026-1029
 *   cars     = state.cars + phaseAt(car, sessionNow, state.refLap)              jsx:1033-1036
 *   trackFlag= flagAtClock(trackStatus, lapTimes, sessionNow)                   jsx:1038
 *   memoKey  = circleMemoKey(focus, lapTimes, sessionNow, pitLoss, trackStatus) jsx:1039
 *   win      = pitWindow(focus, ring, pitLoss, { totalLaps, trackFlag })        jsx:1044-1050
 *   dist     = rejoinDistribution(focus, ring, pitLoss, same options)           jsx:1049
 * (replay: totalRaceLaps is null, so totalLaps is undefined; dnfMap as the
 * store's dnfMapFromResults; grid slots from race_results as jsx:1005-1013),
 * and prints what the view displays: the centre lines (track status, the
 * reference lap, "pit loss X s (n stops)", "<FOC> pits now: Pa → Pb", the
 * note "green-flag pit loss and pace"), the rejoin label next to the diamond
 * and the focus tooltip rows (Pit now, Rejoin positions, Draws, Pit loss,
 * Traffic, Gain the place, Within reach, Track), with copies of the
 * component's text helpers (jsx:167-169, 226-306, 364-375, 1495-1524).
 * Also: the Strategy Timeline's stop labels (utils/strategyViews.js
 * pitStopMarkers) and, for the outcome, the lap rows after each clock (never
 * fed to the analytics above).
 *
 * Clocks (session seconds; replay frame clock = frame.t + sessionTimeOffset,
 * utils/raceTime.js resolveSessionNow): every clock is a frame of the static
 * demo (frontend/public/data/2024_5_R/frames.json.gz, 0.8 s apart), reached
 * in the UI by
 *   - a lap seek (→ / ← keys, Ctrl+K "Jump to Lap", a click on the timeline's
 *     lap axis): store setCurrentLap / useReplayEngine seekToLap go to
 *     lapFrameMap[L], the first frame whose highest driver lap is L
 *     (store/useF1Store.js setCurrentLap and the race-frame load);
 *   - a click on a track-status marker of the timeline player ("V" = VSC,
 *     "SC" = Safety Car): seekToFrame(round(startTimeFraction x (frames - 1)))
 *     with the fraction of hooks/useReplayEngine.js buildTrackStatusEvents
 *     (TimelinePlayer.jsx); a marker is drawn only once its period has
 *     started at the clock shown;
 *   - Space (play) and pause, or a drag on the timeline, for any other frame:
 *     for those the report gives the frames during which each readout holds.
 * Section 7 repeats the readout timelines on the backend's own frames
 * (0.4 s apart) when the local cache backend/data/processed_cache holds
 * this race (it is git-ignored); without it that section says it was skipped.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/usecases/uc4_china24_sc.mjs [--out FILE]
 * Prints the report and writes the same text to
 * docs/evidence/usecase_uc4_china24_sc.txt (or to FILE, relative to the
 * current directory).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  circleState, circleMemoKey, phaseAt, pitWindow, rejoinDistribution,
} from '../../src/utils/circleOfDoom.js';
import { estimatePitLoss, FALLBACK_PIT_LOSS } from '../../src/utils/pitLoss.js';
import { pitLossDisplay, pitStopMarkers } from '../../src/utils/strategyViews.js';
import { computeSessionTimeOffset } from '../../src/utils/raceTime.js';
import { flagAtClock } from '../../src/store/useF1Store.js';
import { buildTrackStatusEvents } from '../../src/hooks/useReplayEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEMO_DIR = path.join(ROOT, 'frontend/public/data/2024_5_R');
const CACHE_DIR = path.join(ROOT, 'backend/data/processed_cache');
const OUT_ARG = process.argv.indexOf('--out');
const OUT_FILE = OUT_ARG > 0
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.join(ROOT, 'docs/evidence/usecase_uc4_china24_sc.txt');

const L = [];
const out = (s = '') => { L.push(s); };

// ── loading ────────────────────────────────────────────────────────────────
function readJson(file) {
  const raw = file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    : fs.readFileSync(file, 'utf8');
  try { return JSON.parse(raw); } catch { return JSON.parse(raw.replace(/\bNaN\b/g, 'null')); }
}

/** store/useF1Store.js dnfMapFromResults (not exported there). */
function dnfMapFromResults(results, maxLap) {
  const dnfMap = {};
  for (const r of results || []) {
    const abbr = r?.Abbreviation;
    if (!abbr) continue;
    const cp = String(r.ClassifiedPosition || '');
    if (['R', 'D', 'E', 'W', 'N'].includes(cp)) {
      dnfMap[abbr] = { status: r.Status || 'Retired', lastLap: r.Laps || maxLap, classifiedPosition: cp };
    }
  }
  return dnfMap;
}

/** store frameLeaderLap: the highest lap of any driver in the frame. */
function frameLeaderLap(frame) {
  let lap = 1;
  for (const d of Object.values(frame?.drivers || {})) if (d.lap > lap) lap = d.lap;
  return lap;
}

/**
 * The timeline player's "elapsed" text at a frame clock (TimelinePlayer.jsx
 * elapsedTime: floor(frame.t) as m:ss, frame.t = clock - sessionTimeOffset).
 */
function elapsedAt(race, clock) {
  const i = race.frameClocks.indexOf(clock);
  const t = i >= 0 ? race.frames[i].t : clock - race.offset;
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function makeRace(session, framesFile, label) {
  const lapTimes = session.lap_times || [];
  let maxLap = 1;
  for (const r of lapTimes) if (r.LapNumber > maxLap) maxLap = r.LapNumber;
  const gridPositions = {};
  for (const r of session.race_results || []) {
    const g = Number(r?.GridPosition);
    if (r?.Abbreviation && r.GridPosition != null && Number.isFinite(g) && g >= 0) gridPositions[r.Abbreviation] = g;
  }
  const by = new Map();
  for (const r of lapTimes) {
    if (!by.has(r.Driver)) by.set(r.Driver, new Map());
    by.get(r.Driver).set(Number(r.LapNumber), r);
  }
  const offset = computeSessionTimeOffset(lapTimes);
  const frames = framesFile.frames;
  // lapFrameMap as the store builds it when race frames load
  const lapFrameMap = {};
  frames.forEach((fr, i) => {
    if (!fr.drivers) return;
    let mx = 0;
    for (const d of Object.values(fr.drivers)) if (d.lap > mx) mx = d.lap;
    if (mx > 0 && !(mx in lapFrameMap)) lapFrameMap[mx] = i;
  });
  return {
    label, session, lapTimes, maxLap, by, offset, frames, lapFrameMap,
    frameDt: frames.length > 1 ? frames[1].t - frames[0].t : null,
    frameClocks: frames.map((f) => f.t + offset),
    trackStatus: session.track_status || [],
    results: session.race_results || [],
    dnfMap: dnfMapFromResults(session.race_results, maxLap),
    gridPositions,
  };
}

// ── the component's analytics at a clock ───────────────────────────────────
function view(race, focus, now) {
  const pitLoss = estimatePitLoss(race.lapTimes, { sessionNow: now, sessionType: 'R' });
  const state = circleState(race.lapTimes, {
    sessionNow: now, dnfMap: race.dnfMap, gridPositions: race.gridPositions, isLiveMode: false,
  });
  const cars = state.cars.map((c) => ({ ...c, ...phaseAt(c, now, state.refLap) }));
  const trackFlag = flagAtClock(race.trackStatus, race.lapTimes, now);
  const ring = { ...state, sessionNow: now, cars };
  const opts = { totalLaps: undefined, trackFlag };
  const win = pitWindow(focus, ring, pitLoss, opts);
  const dist = win.available ? rejoinDistribution(focus, ring, pitLoss, opts) : null;
  return { pitLoss, state, cars, trackFlag, win, dist };
}
const memoKeyAt = (race, focus, t) => circleMemoKey(
  focus, race.lapTimes, t, estimatePitLoss(race.lapTimes, { sessionNow: t, sessionType: 'R' }), race.trackStatus,
);

// ── copies of the component's text helpers (CircleOfDoom.jsx) ─────────────
const MINUS = '−';
const FLAG_LABELS = { 1: 'Track Clear', 2: 'Yellow Flag', 4: 'Safety Car', 5: 'Red Flag', 6: 'VSC', 7: 'VSC Ending' }; // jsx:167-169
const TRAFFIC_GAP_S = 1.0;
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1); // d3.format('.1f')
function trafficSeconds(s) { // jsx:240-247
  if (s == null || !Number.isFinite(s)) return '';
  if (s < TRAFFIC_GAP_S) { const h = Math.floor(s * 100) / 100; return h > 0 ? `${h.toFixed(2)} s` : '< 0.01 s'; }
  return `${f1(s)} s`;
}
function lapTag(k) { return k > 0 ? `${k}L` : `${MINUS}${-k}L`; } // jsx:259-261
function trafficText(t) { // jsx:226-233
  if (!t?.carAhead) return 'no car ahead';
  const laps = t.carAheadLaps ? ` (${lapTag(t.carAheadLaps)})` : '';
  if (t.flag) return `${trafficSeconds(t.gapSeconds)} behind ${t.carAhead}${laps} (< ${f1(TRAFFIC_GAP_S)} s)`;
  return `no: ${t.carAhead}${laps} ${trafficSeconds(t.gapSeconds)} ahead`;
}
function lapClock(seconds) { // jsx:264-269
  const cs = Math.round(seconds * 100);
  const m = Math.floor(cs / 6000);
  const rest = (cs - m * 6000) / 100;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}
function apportionPercent(values) { // jsx:276-284
  const exact = values.map((v) => Math.round(v * 1e6) / 1e6);
  const o = exact.map((v) => Math.floor(v));
  let left = Math.round(100 - o.reduce((a, b) => a + b, 0));
  const order = exact.map((_, i) => i)
    .sort((a, b) => ((exact[b] - o[b]) - (exact[a] - o[a])) || (exact[b] - exact[a]) || (a - b));
  for (let i = 0; left > 0 && i < order.length; i += 1, left -= 1) o[order[i]] += 1;
  return o;
}
function probabilityEntries(positions) { // jsx:293-306 (>= 5 %, at most 4)
  if (!positions?.length) return [];
  const byProb = [...positions].sort((a, b) => (b.probability - a.probability) || (a.position - b.position));
  let shown = byProb.filter((p) => p.probability >= 0.05).slice(0, 4);
  if (!shown.length) shown = byProb.slice(0, 2);
  shown.sort((a, b) => a.position - b.position);
  const rest = Math.max(0, 1 - shown.reduce((s, p) => s + p.probability, 0));
  const pcts = apportionPercent([...shown.map((p) => p.probability * 100), rest * 100]);
  const e = shown.map((p, i) => `P${p.position} ${pcts[i]}%`);
  if (pcts[shown.length] > 0) e.push(`other ${pcts[shown.length]}%`);
  return e;
}
function referenceNote(ref) { // jsx:364-375
  if (ref?.source === 'fallback') return 'median of completed laps (fallback)';
  if (ref?.source !== 'race' || !ref.laps) return '';
  const [from, to] = ref.laps;
  if (to - from + 1 === 5) return 'median of last 5 green laps';
  return from === to ? `median of green lap ${from}` : `median of green laps ${from}–${to}`;
}
const names = (list) => (list.length ? list.map((x) => x.driver).join(', ') : 'none');

/** The headline the centre and the rejoin label show (one line). */
function headline(v, focus) {
  const w = v.win;
  if (!w.available) return `${focus}: unavailable (${w.reason})`;
  const head = w.ongoingStop ? `${focus} stopping → P${w.predictedPosition}` : `${focus} pits now: P${w.currentPosition} → P${w.predictedPosition}`;
  return `${head} | label ${probabilityEntries(v.dist?.positions).join(' · ')}`
    + `${w.traffic.flag ? ` | traffic ${trafficSeconds(w.traffic.gapSeconds)} behind ${w.traffic.carAhead}` : ''}`
    + ` | ${FLAG_LABELS[v.trackFlag] || FLAG_LABELS[1]}${w.neutralised ? ', note "green-flag pit loss and pace"' : ''}`;
}

/** Everything the view shows for `focus` at the frame `idx` of `race`. */
function panel(race, focus, idx, title) {
  const now = race.frameClocks[idx];
  const v = view(race, focus, now);
  const w = v.win;
  const loss = pitLossDisplay(v.pitLoss);
  out(`  -- ${title}`);
  out(`     clock ${now.toFixed(3)} s (demo frame ${idx}, timeline "${elapsedAt(race, now)} elapsed"); centre: LAP ${frameLeaderLap(race.frames[idx])}/${race.maxLap} | ${FLAG_LABELS[v.trackFlag] || FLAG_LABELS[1]}`
    + ` | ref lap ${lapClock(v.state.refLap.seconds)} (${referenceNote(v.state.refLap)})`
    + ` | pit loss ${f1(loss.value)} s ${loss.isFallback ? '(fallback)' : `(${loss.n} stop${loss.n === 1 ? '' : 's'})`}`);
  const atLine = v.cars.filter((c) => c.saturated && !c.inPitLane && !c.finished && !c.retired).map((c) => c.driver);
  out(`     ring: ${atLine.length} cars drawn just before the timing line (current lap longer than the reference lap): ${atLine.join(', ') || 'none'};`
    + ` ${focus} ${v.cars.find((c) => c.driver === focus)?.saturated ? 'is' : 'is not'} one of them`);
  if (!w.available) { out(`     ${focus}: unavailable (${w.reason})`); return v; }
  const head = w.ongoingStop ? `${focus} stopping → P${w.predictedPosition}` : `${focus} pits now: P${w.currentPosition} → P${w.predictedPosition}`;
  out(`     centre: ${head}${w.neutralised ? ' | note: green-flag pit loss and pace' : ''}`);
  out(`     rejoin label: ${probabilityEntries(v.dist?.positions).join(' · ')}${w.traffic.flag ? ` | traffic ${trafficSeconds(w.traffic.gapSeconds)} behind ${w.traffic.carAhead}` : ''}`);
  const probs = (v.dist?.positions || []).map((p) => `P${p.position} ${(p.probability * 100).toFixed(1)}%`).join(' · ');
  const method = v.dist?.method === 'bootstrap' ? `bootstrap of ${loss.n} stops` : `normal(${FALLBACK_PIT_LOSS.median}, ${FALLBACK_PIT_LOSS.stdDev}) fallback`;
  const lossText = loss.isFallback ? `${f1(loss.value)} s fallback` : `${f1(loss.value)} s (p10–p90 ${f1(w.pitLoss.p10)}–${f1(w.pitLoss.p90)} s, ${loss.n} stops)`;
  out('     focus tooltip:');
  out(`       Pit now: P${w.currentPosition} → P${w.predictedPosition}`);
  out(`       Rejoin positions: ${probs || '—'}`);
  out(`       Draws: ${v.dist?.samples ?? 0}, ${method}`);
  out(`       Pit loss: ${lossText}`);
  out(`       Traffic at the rejoin: ${trafficText(w.traffic)}`);
  out(`       Traffic probability: ${v.dist?.trafficProbability != null ? `${Math.round(v.dist.trafficProbability * 100)}%` : '—'}`);
  out(`       Gain the place: ${names(w.wouldPassFocus)}`);
  out(`       Within reach: ${names(w.wouldDropBehindFocus)}`);
  out(`       Lapped traffic: ${w.trafficOnly.length ? w.trafficOnly.map((x) => `${x.driver} ${x.label}`).join(', ') : 'none'}`);
  if (w.neutralised) out('       Track: neutralised: green-flag figures');
  return v;
}

/**
 * The projection behind the rank (not displayed by the view: it shows the
 * resulting place and probabilities only): the focus's predicted crossing of
 * the target lap and the neighbours' crossings (actual or projected), each
 * with the last lap it has completed at the clock (its lap time and track
 * status: a projection runs from that line at the car's green-flag pace).
 * Truth, from the rows after the clock: the actual crossings, and each
 * neighbour's gap to the focus projected against actual (+ = behind the focus).
 */
function projection(race, focus, v, nAhead = 3, nBehind = 2) {
  const w = v.win;
  if (!w.available) return;
  const carOf = (d) => v.state.cars.find((c) => c.driver === d);
  const lastLapText = (d) => {
    const c = carOf(d);
    const n = c?.lapsCompleted;
    const row = n ? race.by.get(d)?.get(n) : null;
    return row ? `last line L${n} ${row.Time.toFixed(1)}, lap ${row.LapTimeSeconds != null ? row.LapTimeSeconds.toFixed(3) : 'n/a'}, status ${row.TrackStatus}` : 'no line yet';
  };
  const actual = (d) => race.by.get(d)?.get(w.targetLap)?.Time;
  const sgn = (x) => `${x >= 0 ? '+' : MINUS}${Math.abs(x).toFixed(1)}`;
  const fa = actual(focus);
  out(`     projection of the end of lap ${w.targetLap} (not displayed; focus pace ${w.pace.toFixed(3)} s/lap, ${w.paceSource}; reference lap ${w.refLap.toFixed(3)} s; pit loss median ${w.pitLoss.median.toFixed(2)} s):`);
  out(`       ${focus.padEnd(6)} predicted ${w.predictedCrossing.toFixed(1)} (${lastLapText(focus)}); actual ${fa != null ? fa.toFixed(1) : 'n/a'}${fa != null ? ` (actual - predicted ${sgn(fa - w.predictedCrossing)} s)` : ''}`);
  const ahead = w.rivalCrossings.filter((r) => r.time < w.predictedCrossing).slice(-nAhead);
  const behind = w.rivalCrossings.filter((r) => r.time >= w.predictedCrossing).slice(0, nBehind);
  for (const [side, list] of [['ahead', ahead], ['behind', behind]]) {
    for (const r of list) {
      const a = actual(r.driver);
      out(`       ${side.padEnd(6)} ${r.driver} ${r.time.toFixed(1)} ${r.projected ? 'projected' : 'actual'}${r.pendingLoss ? ` (+${r.pendingLoss.toFixed(1)} s stop in progress)` : ''}`
        + ` (${lastLapText(r.driver)}); actual ${a != null ? a.toFixed(1) : 'n/a'};`
        + ` gap to ${focus} projected ${sgn(r.time - w.predictedCrossing)} s, actual ${a != null && fa != null ? `${sgn(a - fa)} s` : 'n/a'}`);
    }
  }
}

/**
 * Distinct readouts over the frames of [from, to): the headline at every
 * frame (recomputed when the memo key changes, as the component), merged
 * when equal; with lists, the tooltip's "Gain the place" and "Within reach"
 * too. Returns the segments.
 */
function frameTimeline(race, focus, from, to, { lists = false } = {}) {
  const segs = [];
  let lastKey = null;
  let lastText = null;
  race.frameClocks.forEach((t) => {
    if (t < from || t >= to) return;
    const key = memoKeyAt(race, focus, t);
    let text = lastText;
    if (key !== lastKey) {
      const v = view(race, focus, t);
      text = headline(v, focus)
        + (lists && v.win.available ? ` | Gain the place: ${names(v.win.wouldPassFocus)} | Within reach: ${names(v.win.wouldDropBehindFocus)}` : '');
      lastKey = key;
      lastText = text;
    }
    const s = segs[segs.length - 1];
    if (s && s.text === text) { s.last = t; s.n += 1; } else segs.push({ first: t, last: t, n: 1, text });
  });
  return segs;
}
/** The memo-key events (line crossings, pit entries / exits, track-status starts) in (a, b]. */
function eventsBetween(race, a, b) {
  const ev = [];
  for (const r of race.lapTimes) {
    if (r.Time > a && r.Time <= b) ev.push([r.Time, `${r.Driver} ends L${r.LapNumber} (lap ${r.LapTimeSeconds != null ? r.LapTimeSeconds.toFixed(1) : 'n/a'} s)`]);
    if (r.PitInTimeSeconds > a && r.PitInTimeSeconds <= b) ev.push([r.PitInTimeSeconds, `${r.Driver} pit entry`]);
    if (r.PitOutTimeSeconds > a && r.PitOutTimeSeconds <= b) ev.push([r.PitOutTimeSeconds, `${r.Driver} pit exit`]);
  }
  for (const st of race.trackStatus) if (st.start_time > a && st.start_time <= b) ev.push([st.start_time, `status ${st.status} ${st.message}`]);
  return ev.sort((x, y) => x[0] - y[0]).map(([t, d]) => `${d} at ${t.toFixed(1)}`);
}
function printTimeline(race, segs, title, windows = []) {
  const total = segs.reduce((a, s) => a + s.n, 0);
  out(`  -- ${title}: ${total} frames of ${race.frameDt.toFixed(1)} s (${race.label})`);
  segs.forEach((s, i) => {
    if (i > 0) out(`        changed by: ${eventsBetween(race, segs[i - 1].last, s.first).join('; ')}`);
    out(`     ${s.first.toFixed(1)}-${s.last.toFixed(1)} (${elapsedAt(race, s.first)}-${elapsedAt(race, s.last)} elapsed)  ${String(s.n).padStart(3)} frames (${(s.n * race.frameDt).toFixed(1)} s, ${((100 * s.n) / total).toFixed(0)}%)  ${s.text}`);
  });
  for (const [label, a, b] of windows) {
    const n = race.frameClocks.filter((t) => t >= a && t < b).length;
    out(`     (${label}, ${a.toFixed(3)}-${b.toFixed(3)} s: ${n} frames, ${(n * race.frameDt).toFixed(1)} s)`);
  }
}
/** Group a timeline by the rank part only ("Pa → Pb" and the modal label entry). */
function groupByRank(segs, total) {
  const groups = [];
  for (const s of segs) {
    const m = /pits now: (P\d+ → P\d+) \| label ([^|]*)/.exec(s.text);
    const entries = m ? m[2].trim().split(' · ') : [];
    const modal = entries.reduce((best, e) => {
      const p = Number(/(\d+)%/.exec(e)?.[1] ?? -1);
      return p > best.p ? { e, p } : best;
    }, { e: '', p: -1 }).e;
    const key = m ? `${m[1]}, ${modal}` : s.text;
    const g = groups[groups.length - 1];
    if (g && g.key === key) { g.last = s.last; g.n += s.n; } else groups.push({ key, first: s.first, last: s.last, n: s.n });
  }
  return groups.map((g) => ({ ...g, share: (100 * g.n) / total }));
}
function printGroups(race, segs, title) {
  const total = segs.reduce((a, s) => a + s.n, 0);
  out(`     ${title} (the same place and modal entry merged):`);
  for (const g of groupByRank(segs, total)) {
    out(`       ${g.first.toFixed(1)}-${g.last.toFixed(1)} (${elapsedAt(race, g.first)}-${elapsedAt(race, g.last)} elapsed)  ${String(g.n).padStart(3)} frames (${(g.n * race.frameDt).toFixed(1)} s, ${g.share.toFixed(0)}%)  ${g.key}`);
  }
}

// ── ground truth (lap rows after the clock) ─────────────────────────────────
const T = (race, d, n) => race.by.get(d)?.get(n)?.Time;
const PIN = (race, d, n) => race.by.get(d)?.get(n)?.PitInTimeSeconds;
function placeAt(race, d, lap) {
  const t = T(race, d, lap);
  if (t == null) return null;
  let a = 0;
  for (const [x, m] of race.by) { if (x !== d) { const r = m.get(lap); if (r && r.Time != null && r.Time < t) a += 1; } }
  return 1 + a;
}
function carAheadOnRoad(race, d, t) {
  let best = null;
  for (const r of race.lapTimes) {
    if (r.Driver === d || r.Time == null || !(r.Time < t)) continue;
    if (!best || r.Time > best.Time) best = r;
  }
  return best ? { driver: best.Driver, lap: best.LapNumber, gap: t - best.Time } : null;
}
function lapRow(race, d, n) {
  const r = race.by.get(d)?.get(n);
  if (!r) return `${d} L${n}: -`;
  const a = r.Time != null ? carAheadOnRoad(race, d, r.Time) : null;
  return `${d} L${String(n).padEnd(2)} line ${r.Time?.toFixed(3)}  lap ${r.LapTimeSeconds != null ? r.LapTimeSeconds.toFixed(3) : 'n/a    '}  ${r.Compound}/${r.TyreLife}  status ${String(r.TrackStatus).padEnd(3)}`
    + `${r.PitInTimeSeconds != null ? `  PIT IN ${r.PitInTimeSeconds.toFixed(3)}` : ''}${r.PitOutTimeSeconds != null ? `  PIT OUT ${r.PitOutTimeSeconds.toFixed(3)}` : ''}`
    + `  place P${placeAt(race, d, n)}  car ahead at the line ${a ? `${a.driver} (its L${a.lap}) ${a.gap.toFixed(3)} s` : '-'}`;
}
const classified = (race, d) => race.results.find((x) => x.Abbreviation === d)?.ClassifiedPosition;
const orderAt = (race, lap) => [...race.by.keys()].filter((x) => T(race, x, lap) != null).sort((a, b) => T(race, a, lap) - T(race, b, lap));
const firstFrameAtOrAfter = (race, t) => race.frameClocks.findIndex((x) => x >= t);
const probOf = (v, pos) => {
  const p = v.dist?.positions?.find((x) => x.position === pos);
  return p ? p.probability : 0;
};

// ════════════════════════════════════════════════════════════════════════════
const framesMeta = readJson(path.join(DEMO_DIR, 'frames.json.gz'));
const demo = makeRace(readJson(path.join(DEMO_DIR, 'session.json.gz')), framesMeta, 'static demo frames');
const vsc = demo.trackStatus.find((s) => String(s.status) === '6');
const sc = demo.trackStatus.find((s) => String(s.status) === '4');

out('UC4, China 2024 (2024 R5 Chinese Grand Prix, static demo): pit calls under the VSC and the Safety Car');
out('Circle of Doom analytics as the view calls them, at clocks reachable in the UI; truth from the lap rows after each clock.');

// ── 1. Data and clocks ────────────────────────────────────────────────────
out('');
out('1. Data and clocks');
out('  1a. Inputs (static demo files, frontend/public/data/2024_5_R/)');
out(`     session.json.gz: ${demo.lapTimes.length} lap rows, ${demo.by.size} drivers, ${demo.maxLap} laps; sessionTimeOffset ${demo.offset.toFixed(3)} s`);
out(`     frames.json.gz: ${demo.frames.length} frames, frame.t ${demo.frames[0].t} to ${demo.frames[demo.frames.length - 1].t} s, step ${demo.frameDt.toFixed(1)} s (demo_frame_step ${framesMeta.demo_frame_step ?? 'n/a'}: every 2nd backend frame)`);
const teamOf = (d) => (demo.session.driver_info || []).find((x) => x.Abbreviation === d)?.TeamName ?? 'n/a';
out(`     teams: ${['VER', 'NOR', 'PER', 'LEC', 'SAI', 'ALO', 'RUS', 'PIA'].map((d) => `${d} ${teamOf(d)}`).join(', ')}`);
{
  const before = (d) => demo.lapTimes.filter((x) => x.Driver === d && x.PitInTimeSeconds != null && x.PitInTimeSeconds < vsc.start_time).map((x) => `in-lap ${x.LapNumber}`);
  out(`     tyre changes before the VSC: ${['VER', 'NOR', 'PER', 'LEC', 'SAI'].map((d) => `${d} ${before(d).join(', ') || 'none'}`).join('; ')}`);
}
out('  1b. Track-status periods (session seconds; leader lap at the start = the timeline band\'s start lap)');
const eventsAll = buildTrackStatusEvents({
  trackStatus: demo.trackStatus, lapTimes: demo.lapTimes, frames: demo.frames, maxLap: demo.maxLap,
  sessionTimeOffset: demo.offset, sessionNow: Infinity,
});
for (const s of demo.trackStatus) {
  const ev = eventsAll.find((e) => e.startTime === s.start_time);
  out(`     status ${s.status} ${String(s.message).padEnd(12)} ${Number(s.start_time).toFixed(3)} - ${s.end_time != null ? Number(s.end_time).toFixed(3) : 'end'}`
    + `${ev ? `  timeline ${ev.type} laps ${ev.startLap}-${ev.endLap}` : '  (not drawn: green, or ended by the race start)'}`);
}
out(`     VSC ${vsc.start_time.toFixed(3)}-${vsc.end_time.toFixed(3)} s (${(vsc.end_time - vsc.start_time).toFixed(1)} s); SC ${sc.start_time.toFixed(3)}-${sc.end_time.toFixed(3)} s (${(sc.end_time - sc.start_time).toFixed(1)} s)`);

out('  1c. Lap seeks (→ / ← keys, Ctrl+K "Jump to Lap", a click on the timeline\'s lap axis): the frame lapFrameMap[L]');
for (const lap of [21, 22, 23, 24, 25, 26]) {
  const idx = demo.lapFrameMap[lap];
  const t = demo.frameClocks[idx];
  const leaderLine = T(demo, 'VER', lap - 1);
  out(`     lap ${lap}: demo frame ${idx}, clock ${t.toFixed(3)} s, "${elapsedAt(demo, t)} elapsed" (${(t - leaderLine).toFixed(3)} s after the leader VER crossed the end of lap ${lap - 1} at ${leaderLine.toFixed(3)});`
    + ` track status there: ${FLAG_LABELS[flagAtClock(demo.trackStatus, demo.lapTimes, t)]}`);
}

const lap24Clock = demo.frameClocks[demo.lapFrameMap[24]];
const eventsAt24 = buildTrackStatusEvents({
  trackStatus: demo.trackStatus, lapTimes: demo.lapTimes, frames: demo.frames, maxLap: demo.maxLap,
  sessionTimeOffset: demo.offset, sessionNow: lap24Clock,
});
out(`  1d. Timeline markers drawn at the lap-24 clock (${lap24Clock.toFixed(3)} s; only the periods started by then) and the frame a click on each seeks to`);
const markerFrame = (ev) => Math.round(ev.startTimeFraction * (demo.frames.length - 1));
for (const ev of eventsAt24) {
  const idx = markerFrame(ev);
  const t = demo.frameClocks[idx];
  out(`     ${ev.type.padEnd(11)} laps ${ev.startLap}-${ev.endLap}${ev.ongoing ? ' (running)' : ''}, start ${ev.startTime.toFixed(3)} s -> demo frame ${idx}, clock ${t.toFixed(3)} s, "${elapsedAt(demo, t)} elapsed"`
    + ` (${(t - ev.startTime).toFixed(3)} s after the start); status there ${FLAG_LABELS[flagAtClock(demo.trackStatus, demo.lapTimes, t)]}`);
}
const vscIdx = markerFrame(eventsAt24.find((e) => e.type === 'VSC'));
const scIdx = markerFrame(eventsAt24.find((e) => e.type === 'SAFETY_CAR'));
const vscClock = demo.frameClocks[vscIdx];
const scClock = demo.frameClocks[scIdx];
const lap22Idx = demo.lapFrameMap[22];
const lap23Idx = demo.lapFrameMap[23];
out(`     the click on "V" lands on the first demo frame of the VSC: ${vscIdx === firstFrameAtOrAfter(demo, vsc.start_time)}; on "SC", the first frame of the SC: ${scIdx === firstFrameAtOrAfter(demo, sc.start_time)}`);

// ── 2. NOR under the VSC ─────────────────────────────────────────────────
out('');
out('2. NOR (P2, MEDIUM tyres) under the VSC');
const norVsc = panel(demo, 'NOR', vscIdx, 'a. click on the "V" marker (first frame of the VSC), focus NOR');
projection(demo, 'NOR', norVsc);
out(`     NOR is ${(T(demo, 'NOR', 21) - vscClock).toFixed(3)} s from his own line (end of lap 21 at ${T(demo, 'NOR', 21).toFixed(3)} s): this window is a stop at the end of lap 21.`);
panel(demo, 'NOR', lap22Idx, 'b. → to lap 22 (the frame before the VSC), focus NOR');

const norSegs = frameTimeline(demo, 'NOR', vscClock, PIN(demo, 'NOR', 22));
printTimeline(demo, norSegs, `c. NOR readouts frame by frame, from the first VSC frame to his pit entry (${PIN(demo, 'NOR', 22).toFixed(3)} s)`, [
  ['frames before NOR\'s lap-21 line', vscClock, T(demo, 'NOR', 21)],
  ['frames of NOR\'s lap 22 before his pit entry', T(demo, 'NOR', 21), PIN(demo, 'NOR', 22)],
]);
const norLap22 = frameTimeline(demo, 'NOR', T(demo, 'NOR', 21), PIN(demo, 'NOR', 22));
printGroups(demo, norLap22, `NOR's lap 22, from his lap-21 line (${T(demo, 'NOR', 21).toFixed(3)} s) to his pit entry`);
const norL23 = panel(demo, 'NOR', lap23Idx, 'd. → to lap 23, focus NOR (the last readout before his pit entry)');
projection(demo, 'NOR', norL23);
// the P3 94% readout: the first frame showing it
const p3Seg = norLap22.find((s) => /P2 → P3 \| label P3 94%/.test(s.text));
if (p3Seg) {
  const v = panel(demo, 'NOR', demo.frameClocks.indexOf(p3Seg.first), 'e. first frame of the "P3 94%" readout (reached by play / pause or a drag), focus NOR');
  projection(demo, 'NOR', v);
}

// ── 3. VER under the VSC and at the SC ───────────────────────────────────
out('');
out('3. VER (P1, HARD tyres) under the VSC and at the SC');
const verL23 = panel(demo, 'VER', lap23Idx, 'a. → to lap 23, focus VER (VER has just completed his lap 22 under the VSC)');
projection(demo, 'VER', verL23, 3, 2);
const verSegs = frameTimeline(demo, 'VER', vscClock, PIN(demo, 'VER', 23));
printTimeline(demo, verSegs, `b. VER readouts frame by frame, from the first VSC frame to his pit entry (${PIN(demo, 'VER', 23).toFixed(3)} s)`, [
  ['frames from VER\'s lap-22 line to the SC', T(demo, 'VER', 22), sc.start_time],
  ['frames under the SC before his pit entry', sc.start_time, PIN(demo, 'VER', 23)],
]);
printGroups(demo, frameTimeline(demo, 'VER', T(demo, 'VER', 22), PIN(demo, 'VER', 23)),
  `VER from his lap-22 line (${T(demo, 'VER', 22).toFixed(3)} s) to his pit entry`);
const verSc = panel(demo, 'VER', scIdx, 'c. click on the "SC" marker (first frame of the SC), focus VER');
projection(demo, 'VER', verSc);

// ── 4. SAI at the SC ─────────────────────────────────────────────────────
out('');
out('4. SAI (P8, HARD tyres fitted at the stop on his in-lap 17) at the SC');
const saiSc = panel(demo, 'SAI', scIdx, 'a. click on the "SC" marker (first frame of the SC), focus SAI');
{
  const v24 = view(demo, 'SAI', demo.frameClocks[demo.lapFrameMap[24]]);
  out(`     the same at the → lap-24 clock (${demo.frameClocks[demo.lapFrameMap[24]].toFixed(3)} s): ${headline(v24, 'SAI')} | Gain the place: ${names(v24.win.wouldPassFocus)} | Within reach: ${names(v24.win.wouldDropBehindFocus)}`);
}
projection(demo, 'SAI', saiSc);
const saiSegs = frameTimeline(demo, 'SAI', scClock, T(demo, 'SAI', 23), { lists: true });
printTimeline(demo, saiSegs, `b. SAI readouts frame by frame, from the first SC frame to his lap-23 line (${T(demo, 'SAI', 23).toFixed(3)} s)`);
out('  -- c. SAI\'s tooltip lists at the first SC frame against what happened (lap rows after the clock); gap and margin are not displayed: gap = the list\'s threshold gap (- = ahead of SAI), margin = pit loss - |gap|');
const scEnd = sc.end_time;
const stoppedUnder = (d, a, b) => {
  const hit = [...(demo.by.get(d) || [])].find(([, r]) => r.PitInTimeSeconds != null && r.PitInTimeSeconds >= a && r.PitInTimeSeconds < b);
  return hit ? { inLap: hit[0], pin: hit[1].PitInTimeSeconds } : null;
};
for (const [listName, list] of [['Within reach', saiSc.win.wouldDropBehindFocus], ['Gain the place', saiSc.win.wouldPassFocus]]) {
  for (const x of list) {
    const s = stoppedUnder(x.driver, sc.start_time, scEnd);
    const v = stoppedUnder(x.driver, vsc.start_time, sc.start_time);
    const rel25 = T(demo, x.driver, 25) != null ? (T(demo, x.driver, 25) < T(demo, 'SAI', 25) ? 'ahead of' : 'behind') : 'no lap-25 line';
    out(`     ${listName.padEnd(14)} ${x.driver}: gap ${x.gapSeconds.toFixed(1)} s, margin ${x.marginSeconds.toFixed(1)} s;`
      + ` stopped under this SC: ${s ? `yes, in-lap ${s.inLap} (pit entry ${s.pin.toFixed(1)} s)` : 'no'}`
      + `${v ? `; stopped under the VSC, in-lap ${v.inLap} (pit entry ${v.pin.toFixed(1)} s)` : ''}; at the lap-25 line ${rel25} SAI; classified ${classified(demo, x.driver)}`);
  }
}
{
  const s = stoppedUnder('PER', sc.start_time, scEnd);
  const gapPer = T(demo, 'SAI', 22) - T(demo, 'PER', 22);
  out(`     not listed     PER: ${gapPer.toFixed(1)} s ahead of SAI at the lap-22 line (more than the pit loss); stopped under this SC: ${s ? `yes, in-lap ${s.inLap}` : 'no'};`
    + ` at the lap-25 line ${T(demo, 'PER', 25) < T(demo, 'SAI', 25) ? 'ahead of' : 'behind'} SAI; classified ${classified(demo, 'PER')}`);
  const dropped = saiSc.win.wouldDropBehindFocus.filter((x) => stoppedUnder(x.driver, sc.start_time, scEnd));
  const droppedBehind = dropped.filter((x) => T(demo, x.driver, 25) > T(demo, 'SAI', 25));
  out(`     Within reach: ${saiSc.win.wouldDropBehindFocus.length} cars; ${dropped.length} stopped under this SC, ${droppedBehind.length} of those were behind SAI at the lap-25 line`);
  out(`     SAI place: P${placeAt(demo, 'SAI', 23)} at the lap-23 line, P${placeAt(demo, 'SAI', 24)} at lap 24, P${placeAt(demo, 'SAI', 25)} at lap 25; classified ${classified(demo, 'SAI')}; SAI made no stop between the VSC and the end of this SC: ${!stoppedUnder('SAI', vsc.start_time, scEnd)}`);
}

// ── 5. What happened ─────────────────────────────────────────────────────
out('');
out('5. What happened (lap rows; place = rank of the line crossing among the cars that completed that lap)');
out('  5a. Lap rows');
for (const [d, a, b] of [['NOR', 21, 25], ['VER', 21, 25], ['PER', 21, 25], ['LEC', 21, 25], ['SAI', 21, 26], ['ALO', 22, 25], ['RUS', 22, 25], ['PIA', 22, 25]]) {
  for (let n = a; n <= b; n += 1) out(`     ${lapRow(demo, d, n)}`);
}
out('  5b. Pit entries under the VSC and under the first SC');
for (const [label, a, b] of [['VSC', vsc.start_time, sc.start_time], ['SC', sc.start_time, scEnd]]) {
  const rows = demo.lapTimes.filter((x) => x.PitInTimeSeconds != null && x.PitInTimeSeconds >= a && x.PitInTimeSeconds < b)
    .sort((x, y) => x.PitInTimeSeconds - y.PitInTimeSeconds)
    .map((x) => `${x.Driver} in-lap ${x.LapNumber} ${x.PitInTimeSeconds.toFixed(1)}`);
  out(`     under the ${label} (${rows.length}): ${rows.join('; ')}`);
}
out('  5c. Order at the line');
for (const lap of [21, 22, 23, 24, 25]) out(`     lap ${lap}: ${orderAt(demo, lap).slice(0, 8).join(' ')}`);
out(`     classified: ${['VER', 'NOR', 'PER', 'LEC', 'SAI', 'ALO', 'RUS', 'PIA'].map((d) => `${d} ${classified(demo, d)}`).join(', ')}`);
out('  5d. Readouts against the place at the end of the projected lap');
{
  const rows = [
    ['NOR, first VSC frame ("V" marker)', norVsc, 'NOR', 'a stop at the end of lap 21', false],
    ['NOR, → lap 23 (last readout before his stop)', norL23, 'NOR', 'a stop at the end of lap 22: his stop', true],
    ['VER, → lap 23', verL23, 'VER', 'a stop at the end of lap 23: his stop', true],
    ['VER, first SC frame ("SC" marker)', verSc, 'VER', 'a stop at the end of lap 23: his stop', true],
    ['SAI, first SC frame ("SC" marker)', saiSc, 'SAI', 'a stop at the end of lap 23', false],
  ];
  if (p3Seg) rows.splice(2, 0, ['NOR, the "P3 94%" readout', view(demo, 'NOR', p3Seg.first), 'NOR', 'a stop at the end of lap 22: his stop', true]);
  for (const [label, v, d, what, made] of rows) {
    const w = v.win;
    const actual = placeAt(demo, d, w.targetLap);
    out(`     ${label}: shown P${w.predictedPosition} at the end of lap ${w.targetLap} (${what})`
      + (made ? `; actual P${actual} at that line, probability the view gave it ${(100 * probOf(v, actual)).toFixed(1)}%` : '; no comparison: that stop was not made'));
  }
}

// ── 6. Pit-loss estimate and the Strategy Timeline labels ────────────────
out('');
out('6. The pit-loss estimate and the stop labels');
{
  const est = norVsc.pitLoss;
  const inLaps = est.samples.map((s) => s.inLap);
  out(`  6a. At the first VSC frame: median ${est.median.toFixed(2)} s, p10 ${est.p10.toFixed(2)}, p90 ${est.p90.toFixed(2)}, n ${est.n} (${est.source}); in-laps ${Math.min(...inLaps)}-${Math.max(...inLaps)}, all green-flag stops:`);
  out(`     ${est.samples.map((s) => `${s.driver}@L${s.inLap} ${s.loss.toFixed(1)}`).join(', ')}`);
  const big = est.samples.filter((x) => x.loss > 30);
  out(`     samples above 30 s: ${big.length} of ${est.n} (${((100 * big.length) / est.n).toFixed(1)}%): ${big.map((x) => `${x.driver}@L${x.inLap} ${x.loss.toFixed(1)} s`).join(', ')}`);
  const atSc = verSc.pitLoss;
  out(`     at the first SC frame: median ${atSc.median.toFixed(2)} s, n ${atSc.n}; at the → lap-26 clock: n ${estimatePitLoss(demo.lapTimes, { sessionNow: demo.frameClocks[demo.lapFrameMap[26]], sessionType: 'R' }).n}`);
}
{
  const t26 = demo.frameClocks[demo.lapFrameMap[26]];
  const marks = pitStopMarkers(demo.lapTimes, { sessionNow: t26, sessionType: 'R' })
    .filter((m) => m.inLap >= 21 && m.inLap <= 24);
  out(`  6b. Strategy Timeline stop labels at the → lap-26 clock (${t26.toFixed(3)} s), stops with in-lap 21-24 (≈ = the race median, the stop is not measured):`);
  out(`     ${marks.map((m) => `${m.Driver}@L${m.inLap} "${m.label}" (${m.source})`).join(', ')}`);
}

// ── 7. The same timelines on the backend frames (0.4 s) ──────────────────
out('');
out('7. Check on the backend frames (0.4 s apart), local cache only');
const beSession = path.join(CACHE_DIR, 'session_2024_5_R.json');
const beFrames = path.join(CACHE_DIR, 'frames_2024_5_R.json');
if (fs.existsSync(beSession) && fs.existsSync(beFrames)) {
  const be = makeRace(readJson(beSession), readJson(beFrames), 'backend frames');
  const keys = ['Driver', 'LapNumber', 'Time', 'LapTimeSeconds', 'PitInTimeSeconds', 'PitOutTimeSeconds', 'TrackStatus', 'Compound', 'TyreLife', 'Position', 'LapStartTime', 'Sector2SessionTime', 'Stint'];
  const norm = (v) => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? null : v);
  let diff = 0;
  for (let i = 0; i < Math.max(be.lapTimes.length, demo.lapTimes.length); i += 1) {
    const a = be.lapTimes[i];
    const b = demo.lapTimes[i];
    if (!a || !b) { diff += 1; continue; }
    if (keys.some((k) => { const x = norm(a[k]); const y = norm(b[k]); return typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) > 1e-6 : x !== y; })) diff += 1;
  }
  out(`  demo vs backend session: ${demo.lapTimes.length} / ${be.lapTimes.length} lap rows, ${diff} differ on the fields the analytics read;`
    + ` track status identical: ${JSON.stringify(be.trackStatus) === JSON.stringify(demo.trackStatus)}; backend frames ${be.frames.length}, step ${be.frameDt.toFixed(1)} s`);
  const bVsc = be.frameClocks[firstFrameAtOrAfter(be, vsc.start_time)];
  const bSc = be.frameClocks[firstFrameAtOrAfter(be, sc.start_time)];
  printGroups(be, frameTimeline(be, 'NOR', T(be, 'NOR', 21), PIN(be, 'NOR', 22)), 'NOR\'s lap 22 to his pit entry, backend frames');
  printGroups(be, frameTimeline(be, 'VER', T(be, 'VER', 22), PIN(be, 'VER', 23)), 'VER from his lap-22 line to his pit entry, backend frames');
  printGroups(be, frameTimeline(be, 'SAI', bSc, T(be, 'SAI', 23)), 'SAI from the first SC frame to his lap-23 line, backend frames');
  out(`     first backend frame of the VSC ${bVsc.toFixed(3)} s: ${headline(view(be, 'NOR', bVsc), 'NOR')}`);
  out(`     first backend frame of the SC ${bSc.toFixed(3)} s: ${headline(view(be, 'VER', bSc), 'VER')}`);
} else {
  out('  skipped: backend/data/processed_cache has no session_2024_5_R.json / frames_2024_5_R.json');
}

const text = L.join('\n');
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${text}\n`);
console.log(text);
