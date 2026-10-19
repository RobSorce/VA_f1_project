/**
 * Use case UC3: Monza 2025 (2025 R16, Italian Grand Prix). The race engineer
 * of LEC (Ferrari, P4 on a MEDIUM set) watches the Circle of Doom while the
 * gap to the midfield behind grows, before LEC's stop on in-lap 33.
 *
 * What it computes, with the module calls and the arguments of
 * src/components/visualizations/CircleOfDoom.jsx (focus LEC; replay mode:
 * totalRaceLaps null so totalLaps undefined, running false, sessionType 'R',
 * isLiveMode false, dnfMap as the store's dnfMapFromResults, gridPositions
 * from race_results as the component):
 *   pitLoss    = estimatePitLoss(lapTimes, { sessionNow, sessionType })         jsx:1022-1025
 *   state      = circleState(lapTimes, { sessionNow, dnfMap, gridPositions,
 *                isLiveMode })                                                  jsx:1026-1029
 *   cars       = state.cars with phaseAt(car, sessionNow, state.refLap)         jsx:1033-1036
 *   trackFlag  = flagAtClock(trackStatus, lapTimes, sessionNow)                 jsx:1038
 *   win, dist  = pitWindow / rejoinDistribution(focus, ring, pitLoss,
 *                { totalLaps, trackFlag })                                      jsx:1046-1049
 *   raceParams = extractRaceParams(lapTimes, [], trackStatus, currentLap,
 *                { sessionNow, sessionTimeOffset, sessionType, running, dnfMap }) jsx:1058-1064
 *                (with sessionNow given, currentLap is not used)
 *   pitIn      = pitInLaps(focus, ring, pitLoss, raceParams,
 *                { totalLaps, trackFlag, rivalsStop })                          jsx:1070-1077
 *   ring tags and the hover row "Gap to LEC" = lapOffset / gapSeconds(LEC, car,
 *                state)                                                         jsx:1113-1127, 1532-1534
 * The text is printed with copies of the component's helpers (FLAG_LABELS,
 * signedSeconds, trafficText, trafficSeconds, placesVsNow, lapTag, lapClock,
 * apportionPercent, probabilityEntries, referenceNote: jsx:167-375; the centre
 * line jsx:436-444; the tooltip rows jsx:1472-1524).
 *
 * Clocks (session seconds; in a replay sessionNow = currentTime +
 * sessionTimeOffset, hooks/useSessionNow.js -> utils/raceTime.js
 * resolveSessionNow):
 *  - lap-seek clocks: ArrowRight / ArrowLeft (hooks/useKeyboardShortcuts.js
 *    stepLap -> store setCurrentLap), Ctrl+K "Jump to Lap"
 *    (CommandPalette/commandRegistry.js -> setCurrentLap) and a lap click on
 *    the expanded timeline (TimelinePlayer.jsx -> useReplayEngine seekToLap)
 *    all land on lapFrameMap[L]: the first replay frame in which the leader
 *    is on lap L (store loadFrames). The centre then reads "LAP L/53".
 *  - any other clock: play (Space; the clock then runs continuously,
 *    useReplayEngine) and pause, or drag the progress bar (seekToFrame: a
 *    frame clock). Each readout is given with the interval it holds: seconds
 *    of race time (what playback shows) and the number of replay frames
 *    (what scrubbing can land on) at the backend step (0.4 s) and at the
 *    static demo's step (every 2nd frame, 0.8 s:
 *    backend/scripts/export_demo_data.py slim_frames).
 *  The demo session and frames are read from frontend/public/data/2025_16_R
 *  when that folder exists, else derived from the cache as the export does
 *  (the session as served, every 2nd frame); section 1 says which.
 *
 * The analytics depend only on circleMemoKey (focus, completed laps, pit
 * entries and exits, track-status periods, pit loss), never on the frame
 * alone (utils/circleOfDoom.js header), so a readout holds from one such
 * event to the next; section 3 checks this at every frame.
 *
 * Sections of the report:
 *   1 data and clocks (the lap-seek clocks, backend and demo frame);
 *   2 the full readout at each lap-seek clock LAP 27..34: centre, rejoin
 *     label, LEC's tooltip, the ring tags of the cars behind, the "pit in k"
 *     table (k = 1..10, "rivals" off and on) and its lap-model tooltip rows;
 *   3 every readout from LAP 28 to the end of LEC's out-lap, event by event,
 *     with the race time and the frames (backend / demo) it holds;
 *   4 shares of the decision window W (LEC's line at the end of L27 to his
 *     pit entry on L33): by readout, predicted place, traffic flag, lap;
 *   5 the "pit in k" row of in-lap 33 over W, and the same row with a flat
 *     lap model (not displayed: what the lap model adds);
 *   6 the gap tags of the cars behind over W;
 *   7 model-based counterfactual (ex post, not displayed): the predicted
 *     rejoin crossing among the other cars' ACTUAL crossings;
 *   8 what happened (lap rows after the clock; never fed to the dashboard
 *     calls);
 *   9 context lines quoted from docs/evidence/cod_backtest.txt;
 *  10 secondary vignette: the pit loss on one measured stop (BEA, L18).
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/usecases/uc3_monza25_cod.mjs [--out FILE]
 * Prints the report and writes the same text to
 * docs/evidence/usecase_uc3_monza25_cod.txt (or FILE, relative to frontend/).
 * Needs session_2025_16_R.json and frames_2025_16_R.json in
 * backend/data/processed_cache (git-ignored; backend/scripts/bulk_download.py).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  circleState, phaseAt, pitWindow, rejoinDistribution, gapSeconds, lapOffset, circleMemoKey,
} from '../../src/utils/circleOfDoom.js';
import { estimatePitLoss, FALLBACK_PIT_LOSS } from '../../src/utils/pitLoss.js';
import { extractRaceParams } from '../../src/utils/raceSimulation.js';
import { pitInLaps } from '../../src/utils/undercut.js';
import { flagAtClock } from '../../src/store/useF1Store.js';
import {
  computeSessionTimeOffset, lapEndTime, pitInSeconds, pitOutSeconds,
} from '../../src/utils/raceTime.js';
import { pitLossDisplay } from '../../src/utils/strategyViews.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CACHE = path.join(ROOT, 'backend/data/processed_cache');
const DEMO_DIR = path.join(ROOT, 'frontend/public/data/2025_16_R');
const OUT_ARG = process.argv.indexOf('--out');
const OUT_FILE = OUT_ARG > 0
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.join(ROOT, 'docs/evidence/usecase_uc3_monza25_cod.txt');

const YEAR = 2025;
const ROUND = 16;
const FOCUS = 'LEC';
const IN_LAP = 33; // LEC's stop
const DEMO_FRAME_STEP = 2; // export_demo_data.py FRAME_STEP
const SEEK_LAPS = [27, 28, 29, 30, 31, 32, 33, 34];
const BEHIND = ['RUS', 'HAM', 'ALB', 'ANT', 'SAI', 'OCO', 'STR', 'HAD'];

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };

// ── loading ────────────────────────────────────────────────────────────────
function readJson(file) {
  const raw = file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
  try { return JSON.parse(raw); } catch { return JSON.parse(raw.replace(/\bNaN\b/g, 'null')); }
}

/** store.dnfMapFromResults (store/useF1Store.js:1344) */
function dnfMapFromResults(results, maxLap) {
  const m = {};
  for (const r of results || []) {
    const a = r?.Abbreviation;
    if (!a) continue;
    const cp = String(r.ClassifiedPosition || '');
    if (['R', 'D', 'E', 'W', 'N'].includes(cp)) m[a] = { status: r.Status || 'Retired', lastLap: r.Laps || maxLap, classifiedPosition: cp };
  }
  return m;
}

/** store loadFrames: lapFrameMap[L] = first frame whose highest driver lap is L. */
function lapFrameMapOf(frames) {
  const m = {};
  frames.forEach((f, i) => {
    let L = 0;
    for (const d of Object.values(f.drivers || {})) if (d.lap > L) L = d.lap;
    if (L > 0 && !(L in m)) m[L] = i;
  });
  return m;
}

function makeRace(data, frames, label) {
  const lapTimes = data.lap_times || [];
  let maxLap = 1;
  for (const lt of lapTimes) if (lt.LapNumber && lt.LapNumber > maxLap) maxLap = lt.LapNumber;
  const gridPositions = {};
  for (const r of data.race_results || []) {
    const g = Number(r?.GridPosition);
    if (r?.Abbreviation && r.GridPosition != null && Number.isFinite(g) && g >= 0) gridPositions[r.Abbreviation] = g;
  }
  const by = new Map();
  for (const r of lapTimes) {
    if (!by.has(r.Driver)) by.set(r.Driver, new Map());
    by.get(r.Driver).set(Number(r.LapNumber), r);
  }
  const offset = computeSessionTimeOffset(lapTimes);
  return {
    label, data, lapTimes, maxLap, by, offset, gridPositions,
    trackStatus: data.track_status || [],
    results: data.race_results || [],
    dnfMap: dnfMapFromResults(data.race_results, maxLap),
    frames,
    frameClocks: frames.map((f) => f.t + offset),
    lapFrameMap: lapFrameMapOf(frames),
  };
}

const beSession = readJson(path.join(CACHE, `session_${YEAR}_${ROUND}_R.json`));
const beFrames = readJson(path.join(CACHE, `frames_${YEAR}_${ROUND}_R.json`)).frames;
const BE = makeRace(beSession, beFrames, 'backend');
const demoOnDisk = fs.existsSync(path.join(DEMO_DIR, 'session.json.gz')) && fs.existsSync(path.join(DEMO_DIR, 'frames.json.gz'));
const DE = demoOnDisk
  ? makeRace(readJson(path.join(DEMO_DIR, 'session.json.gz')), readJson(path.join(DEMO_DIR, 'frames.json.gz')).frames, 'demo')
  : makeRace(beSession, beFrames.filter((_, i) => i % DEMO_FRAME_STEP === 0), 'demo');

// ── the component's analytics at a clock ───────────────────────────────────
function view(race, focus, now, { k = false } = {}) {
  const pitLoss = estimatePitLoss(race.lapTimes, { sessionNow: now, sessionType: 'R' });
  const state = circleState(race.lapTimes, {
    sessionNow: now, dnfMap: race.dnfMap, gridPositions: race.gridPositions, isLiveMode: false,
  });
  const cars = state.cars.map((c) => ({ ...c, ...phaseAt(c, now, state.refLap) }));
  const ring = { ...state, sessionNow: now, cars };
  const trackFlag = flagAtClock(race.trackStatus, race.lapTimes, now);
  const opts = { totalLaps: undefined, trackFlag };
  const win = pitWindow(focus, ring, pitLoss, opts);
  const dist = win.available ? rejoinDistribution(focus, ring, pitLoss, opts) : null;
  const memoKey = circleMemoKey(focus, race.lapTimes, now, pitLoss, race.trackStatus);
  const pitIn = {};
  if (k && win.available) {
    const rp = extractRaceParams(race.lapTimes, [], race.trackStatus, null, {
      sessionNow: now, sessionTimeOffset: race.offset, sessionType: 'R', running: false, dnfMap: race.dnfMap,
    });
    for (const rs of [false, true]) {
      pitIn[rs ? 'on' : 'off'] = pitInLaps(focus, ring, pitLoss, rp, { totalLaps: undefined, trackFlag, rivalsStop: rs });
    }
  }
  return { now, pitLoss, state, cars, trackFlag, win, dist, memoKey, pitIn };
}

// ── copies of the component's text helpers (CircleOfDoom.jsx) ─────────────
const MINUS = '−';
const TRAFFIC_GAP_S = 1.0; // circleOfDoom.js TRAFFIC_GAP_S
const FLAG_LABELS = { 1: 'Track Clear', 2: 'Yellow Flag', 4: 'Safety Car', 5: 'Red Flag', 6: 'VSC', 7: 'VSC Ending' };
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1); // d3.format('.1f')
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
function lapTag(k) { return k > 0 ? `${k}L` : `${MINUS}${-k}L`; }
function trafficText(t) {
  if (!t?.carAhead) return 'no car ahead';
  const laps = t.carAheadLaps ? ` (${lapTag(t.carAheadLaps)})` : '';
  if (t.flag) return `${trafficSeconds(t.gapSeconds)} behind ${t.carAhead}${laps} (< ${fmt1(TRAFFIC_GAP_S)} s)`;
  return `no: ${t.carAhead}${laps} ${trafficSeconds(t.gapSeconds)} ahead`;
}
function placesVsNow(n) { if (!n) return '= now'; return `${n > 0 ? '+' : MINUS}${Math.abs(n)} vs now`; }
function lapClock(seconds) {
  const cs = Math.round(seconds * 100);
  const m = Math.floor(cs / 6000);
  return `${m}:${((cs - m * 6000) / 100).toFixed(2).padStart(5, '0')}`;
}
function apportionPercent(values) {
  const exact = values.map((v) => Math.round(v * 1e6) / 1e6);
  const o = exact.map((v) => Math.floor(v));
  let left = Math.round(100 - o.reduce((a, b) => a + b, 0));
  const order = exact.map((_, i) => i).sort((a, b) => ((exact[b] - o[b]) - (exact[a] - o[a])) || (exact[b] - exact[a]) || (a - b));
  for (let i = 0; left > 0 && i < order.length; i += 1, left -= 1) o[order[i]] += 1;
  return o;
}
function probabilityEntries(positions) {
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
function referenceNote(ref) {
  if (ref?.source === 'fallback') return 'median of completed laps (fallback)';
  if (ref?.source !== 'race' || !ref.laps) return '';
  const [from, to] = ref.laps;
  if (to - from + 1 === 5) return 'median of last 5 green laps';
  return from === to ? `median of green lap ${from}` : `median of green laps ${from}–${to}`;
}
const names = (l) => (l.length ? l.map((x) => x.driver).join(', ') : 'none');
const pPos = (dist, pos) => dist?.positions?.find((x) => x.position === pos)?.probability ?? 0;

/** Centre line of the focus (jsx:436-444), k = 0 or the pit-in-k row. */
function focusLine(v, focus, row = null, k = 0) {
  const w = v.win;
  if (!w.available) return `${focus}: unavailable (${w.reason})`;
  if (row && k > 0) return `${focus} pits in ${k}: P${w.currentPosition} → P${row.predictedPosition} (${placesVsNow(row.positionsVsNow)})`;
  return w.ongoingStop ? `${focus} stopping → P${w.predictedPosition}` : `${focus} pits now: P${w.currentPosition} → P${w.predictedPosition}`;
}
/** Rejoin label next to the marker (jsx:293-346): entries and the traffic note. */
function rejoinLabel(v) {
  const w = v.win;
  if (!w.available) return '';
  return `${probabilityEntries(v.dist?.positions).join(' · ')}${w.traffic.flag ? ` | traffic ${trafficSeconds(w.traffic.gapSeconds)} behind ${w.traffic.carAhead}` : ''}`;
}
function lossCentre(v) {
  const loss = pitLossDisplay(v.pitLoss);
  return `pit loss ${fmt1(loss.value)} s ${loss.isFallback ? '(fallback)' : `(${loss.n} stop${loss.n === 1 ? '' : 's'})`}`;
}
/** Ring tag of a car / hover row "Gap to <focus>" (jsx:1113-1127, 1532-1534). */
function focusTag(v, focus, d) {
  if (!v.state.cars.some((c) => c.driver === focus) || !v.state.cars.some((c) => c.driver === d)) return 'not on the ring';
  const k = lapOffset(focus, d, v.state);
  if (k) return lapTag(k);
  const g = gapSeconds(focus, d, v.state);
  return g == null ? '-' : `${signedSeconds(g)} s`;
}

// ── events and ground truth ────────────────────────────────────────────────
function eventsIn(race, from, to) {
  const ev = [];
  for (const r of race.lapTimes) {
    const t = lapEndTime(r);
    if (t != null && t > from && t < to) ev.push({ t, what: `${r.Driver} completes L${r.LapNumber}` });
    const pin = pitInSeconds(r);
    if (pin != null && pin > from && pin < to) ev.push({ t: pin, what: `${r.Driver} pit entry (in-lap ${r.LapNumber})` });
    const pout = pitOutSeconds(r);
    if (pout != null && pout > from && pout < to) ev.push({ t: pout, what: `${r.Driver} pit exit (out-lap ${r.LapNumber})` });
  }
  for (const s of race.trackStatus) {
    for (const [t, w] of [[s.start_time, `track status ${s.status} starts`], [s.end_time, `track status ${s.status} ends`]]) {
      if (t != null && t > from && t < to) ev.push({ t, what: w });
    }
  }
  return ev.sort((a, b) => a.t - b.t);
}
const T = (race, d, n) => race.by.get(d)?.get(n)?.Time ?? null;
const PIN = (race, d, n) => pitInSeconds(race.by.get(d)?.get(n));
function placeAt(race, d, lap) {
  const t = T(race, d, lap);
  if (t == null) return null;
  let a = 0;
  for (const [x, m] of race.by) { if (x !== d) { const r = m.get(lap); if (r && r.Time != null && r.Time < t) a++; } }
  return 1 + a;
}
/** The latest crossing (any lap) of another car strictly before t, and the first after. */
function roadNeighbours(race, d, t) {
  let ahead = null; let behind = null;
  for (const r of race.lapTimes) {
    if (r.Driver === d || r.Time == null) continue;
    if (r.Time < t && (!ahead || r.Time > ahead.Time)) ahead = r;
    if (r.Time >= t && (!behind || r.Time < behind.Time)) behind = r;
  }
  return {
    ahead: ahead ? { driver: ahead.Driver, lap: ahead.LapNumber, gap: t - ahead.Time } : null,
    behind: behind ? { driver: behind.Driver, lap: behind.LapNumber, gap: behind.Time - t } : null,
  };
}
const inLapsOf = (race, d) => [...(race.by.get(d) || [])].filter(([, x]) => pitInSeconds(x) != null).map(([n]) => n);
const firstFrameAtOrAfter = (race, t) => race.frameClocks.find((x) => x >= t);
const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`;
/** The timeline's "m:ss elapsed" (TimelinePlayer.jsx elapsedTime: floor of the frame's t) on the first frame at or after session time t. */
function elapsed(race, t) {
  const i = race.frameClocks.findIndex((x) => x >= t - 1e-9);
  const ft = race.frames[i]?.t;
  if (ft == null) return 'n/a';
  return `${Math.floor(ft / 60)}:${String(Math.floor(ft % 60)).padStart(2, '0')}`;
}

// ── one full readout (centre, label, tooltip, tags, pit in k) ──────────────
function panel(race, now, title, { k = true, tags = true } = {}) {
  const v = view(race, FOCUS, now, { k });
  const w = v.win;
  out(`  -- ${title}: sessionNow ${now.toFixed(3)} s (${race.label} frame)`);
  out(`     centre: LAP ${frameLeaderLapAt(race, now)}/${race.maxLap} | ${FLAG_LABELS[v.trackFlag] || FLAG_LABELS[1]} | ref lap ${lapClock(v.state.refLap.seconds)} (${referenceNote(v.state.refLap)}) | ${lossCentre(v)}`);
  const car = v.state.cars.find((c) => c.driver === FOCUS);
  out(`     LEC: lap in progress L${car.lapsCompleted + 1} (last line crossing ${car.lastCrossingTime?.toFixed(3)} s), position P${car.position}`);
  out(`     centre focus line: ${focusLine(v, FOCUS)}`);
  if (!w.available) return v;
  out(`     rejoin label: ${rejoinLabel(v)}`);
  const loss = pitLossDisplay(v.pitLoss);
  const probs = (v.dist?.positions || []).map((p) => `P${p.position} ${(p.probability * 100).toFixed(1)}%`).join(' · ');
  const method = v.dist?.method === 'bootstrap' ? `bootstrap of ${loss.n} stops` : `normal(${FALLBACK_PIT_LOSS.median}, ${FALLBACK_PIT_LOSS.stdDev}) fallback`;
  const lossText = loss.isFallback ? `${fmt1(loss.value)} s fallback` : `${fmt1(loss.value)} s (p10–p90 ${fmt1(w.pitLoss.p10)}–${fmt1(w.pitLoss.p90)} s, ${loss.n} stops)`;
  out(`     tooltip: Pit now P${w.currentPosition} → P${w.predictedPosition} | Rejoin positions ${probs} | Draws ${v.dist?.samples ?? 0}, ${method}`);
  out(`              Pit loss ${lossText} | Traffic at the rejoin: ${trafficText(w.traffic)} | Traffic probability ${v.dist?.trafficProbability != null ? `${Math.round(v.dist.trafficProbability * 100)}%` : '—'}`);
  out(`              Gain the place: ${names(w.wouldPassFocus)} | Within reach: ${names(w.wouldDropBehindFocus)} | Lapped traffic: ${w.trafficOnly.length ? w.trafficOnly.map((x) => `${x.driver} ${x.label}`).join(', ') : 'none'}`);
  out(`     (not displayed: target lap ${w.targetLap}, predicted crossing ${w.predictedCrossing.toFixed(2)} s, LEC pace ${w.pace.toFixed(3)} s/lap (${w.paceSource}))`);
  if (tags) out(`     ring tags / hover "Gap to LEC": ${BEHIND.map((d) => `${d} ${focusTag(v, FOCUS, d)}`).join(' | ')}`);
  if (k) {
    const off = v.pitIn.off;
    const on = v.pitIn.on;
    if (!off?.available) { out(`     pit in k: unavailable ${off?.reason ?? ''}`); return v; }
    const r33 = off.rows.find((r) => r.inLap === IN_LAP);
    out(`     pit in k (stepper / keys [ ], k = 1..${off.kMax}; "rivals" not pressed, the default):${r33 ? ` in-lap L${IN_LAP} is k = ${r33.k}, centre "${focusLine(v, FOCUS, r33, r33.k)}"` : ''}`);
    for (const r of off.rows.filter((x) => x.k >= 1)) out(`        ${pitInRowText(r)}`);
    out(`        tooltip rows: ${lapModelText(off)}`);
    const diff = on?.available ? on.rows.filter((r, i) => r.k >= 1 && pitInRowText(r) !== pitInRowText(off.rows[i])) : [];
    out(`     "rivals" pressed: ${diff.length ? `rows that differ: ${diff.map((r) => `${pitInRowText(r)} [other cars stopping by then: ${r.rivalStops.join(', ')}]`).join(' ; ')}` : 'every row k = 1..kMax as above'}`);
  }
  return v;
}

/** One "pit in k" row as the tooltip says it (jsx:1478-1480), compact. */
function pitInRowText(r) {
  return `k${r.k} in-lap L${r.inLap}: P${r.predictedPosition} at the end of L${r.targetLap}; pitting now instead P${r.positionIfPitNow}`
    + ` (${placesVsNow(r.positionsVsNow)}; waiting ${r.secondsVsNow >= 0 ? 'costs' : 'gains'} ${fmt1(Math.abs(r.secondsVsNow))} s)`;
}
/** Tooltip rows "Lap model" and "Fresh-tyre delta" of a pitInLaps table (jsx:1476-1486). */
function lapModelText(t) {
  const degText = (d) => (d ? `${d.compound} ${d.mean >= 0 ? '+' : MINUS}${Math.abs(d.mean).toFixed(3)} s/lap (${d.source === 'race' ? `${d.n} stints` : 'prior'})` : '—');
  const fr = t.freshDeltaInfo;
  return `Lap model ${degText(t.degradation?.current)} → ${degText(t.degradation?.next)} | Fresh-tyre delta ${fr ? `${fr.value >= 0 ? '+' : MINUS}${Math.abs(fr.value).toFixed(3)} s on the first flying lap (${fr.source === 'race' ? `${fr.n} stints` : 'prior'})` : '—'}`;
}
/** pitInLaps at `now` with a flat lap model (no wear, no fresh-tyre delta): NOT displayed, a check of what the lap model adds. */
function pitInFlat(race, now) {
  const v = view(race, FOCUS, now);
  if (!v.win.available) return null;
  const rp = extractRaceParams(race.lapTimes, [], race.trackStatus, null, {
    sessionNow: now, sessionTimeOffset: race.offset, sessionType: 'R', running: false, dnfMap: race.dnfMap,
  });
  const zero = { mean: 0, median: 0, stdDev: 0, n: 1, negativeCount: 0, source: 'race' };
  const flat = { ...rp, tyreDeg: { SOFT: zero, MEDIUM: zero, HARD: zero }, freshDelta: 0 };
  return pitInLaps(FOCUS, { ...v.state, sessionNow: now, cars: v.cars }, v.pitLoss, flat, { totalLaps: undefined, trackFlag: v.trackFlag, rivalsStop: false });
}

/** store frameLeaderLap of the frame on screen at `now` (the centre's LAP n). */
function frameLeaderLapAt(race, now) {
  let idx = 0;
  for (let i = 0; i < race.frameClocks.length; i++) { if (race.frameClocks[i] <= now + 1e-9) idx = i; else break; }
  let lap = 1;
  for (const d of Object.values(race.frames[idx]?.drivers || {})) if (d.lap > lap) lap = d.lap;
  return lap;
}

// ════════════════════════════════════════════════════════════════════════════
out(`UC3 Monza 2025 (${YEAR} R${ROUND}), focus ${FOCUS}: the Circle of Doom before the stop on in-lap ${IN_LAP}`);
out('(frontend/scripts/usecases/uc3_monza25_cod.mjs; every readout causal at its clock, module calls as CircleOfDoom.jsx)');

// ── 1 ──
out('');
out('1. Data and clocks');
out(`  session: backend/data/processed_cache/session_${YEAR}_${ROUND}_R.json, ${BE.lapTimes.length} lap rows, ${BE.maxLap} laps; sessionTimeOffset ${BE.offset.toFixed(3)} s`);
out(`  backend frames: ${BE.frames.length}, step ${(BE.frames[1].t - BE.frames[0].t).toFixed(1)} s`);
if (demoOnDisk) {
  let diff = 0;
  const keys = ['Driver', 'LapNumber', 'Time', 'LapTimeSeconds', 'PitInTimeSeconds', 'PitOutTimeSeconds', 'TrackStatus', 'Compound', 'TyreLife', 'Position', 'LapStartTime', 'Stint'];
  const norm = (x) => (x == null || (typeof x === 'number' && !Number.isFinite(x)) ? null : x);
  for (let i = 0; i < Math.max(BE.lapTimes.length, DE.lapTimes.length); i++) {
    const a = BE.lapTimes[i]; const b = DE.lapTimes[i];
    if (!a || !b) { diff++; continue; }
    if (keys.some((k) => { const x = norm(a[k]); const y = norm(b[k]); return typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) > 1e-6 : x !== y; })) diff++;
  }
  const sameFrames = DE.frames.length === Math.ceil(BE.frames.length / DEMO_FRAME_STEP)
    && DE.frames.every((f, i) => Math.abs(f.t - BE.frames[i * DEMO_FRAME_STEP].t) < 1e-6);
  out(`  demo: read from frontend/public/data/${YEAR}_${ROUND}_R; ${DE.frames.length} frames, step ${(DE.frames[1].t - DE.frames[0].t).toFixed(1)} s;`
    + ` frame clocks = every ${DEMO_FRAME_STEP}nd backend frame: ${sameFrames}; lap rows differing from the backend session on the fields used: ${diff};`
    + ` track_status identical: ${JSON.stringify(BE.trackStatus) === JSON.stringify(DE.trackStatus)}; sessionTimeOffset ${DE.offset.toFixed(3)} s`);
} else {
  out(`  demo: frontend/public/data/${YEAR}_${ROUND}_R not on disk; derived as the export does: the same session, every ${DEMO_FRAME_STEP}nd frame (${DE.frames.length} frames, step ${(DE.frames[1].t - DE.frames[0].t).toFixed(1)} s)`);
}
const lec = BE.results.find((r) => r.Abbreviation === FOCUS);
out(`  ${FOCUS}: grid ${lec.GridPosition}, classified ${lec.ClassifiedPosition} (${lec.Status}); winner ${BE.results.find((r) => String(r.ClassifiedPosition) === '1')?.Abbreviation}`);
const ns = BE.trackStatus.filter((s) => String(s.status) !== '1');
out(`  track status periods other than green in the whole race: ${ns.length ? ns.map((s) => `${s.status} ${s.start_time}-${s.end_time}`).join('; ') : 'none'}`);
const W0 = T(BE, FOCUS, 27);
const W1 = PIN(BE, FOCUS, IN_LAP);
const WOUT = T(BE, FOCUS, IN_LAP + 1);
out(`  decision window W: from LEC's line at the end of L27 (${W0.toFixed(3)} s) to his pit entry on L${IN_LAP} (${W1.toFixed(3)} s): ${(W1 - W0).toFixed(1)} s of race time`);
out(`  then "stopping": pit entry to the end of his out-lap L${IN_LAP + 1} (${WOUT.toFixed(3)} s): ${(WOUT - W1).toFixed(1)} s`);
out('  lap-seek clocks (→ / ←, Ctrl+K "Jump to Lap", lap click on the expanded timeline = lapFrameMap[L], the first frame with the leader on lap L):');
for (const L of SEEK_LAPS) {
  const b = BE.frameClocks[BE.lapFrameMap[L]];
  const d = DE.frameClocks[DE.lapFrameMap[L]];
  const leader = BE.lapTimes.filter((r) => r.LapNumber === L - 1 && r.Time != null).sort((x, y) => x.Time - y.Time)[0];
  const st = circleState(BE.lapTimes, { sessionNow: b, dnfMap: BE.dnfMap, gridPositions: BE.gridPositions });
  const c = st.cars.find((x) => x.driver === FOCUS);
  const lecLine = T(BE, FOCUS, c.lapsCompleted + 1);
  out(`    LAP ${L}: backend ${b.toFixed(3)} s (${elapsed(BE, b)} elapsed), demo ${d.toFixed(3)} s (${elapsed(DE, d)} elapsed) (leader ${leader.Driver} ended L${L - 1} at ${leader.Time.toFixed(3)} s);`
    + ` LEC on L${c.lapsCompleted + 1}, crosses its line ${lecLine != null ? `${(lecLine - b).toFixed(1)} s later (${lecLine.toFixed(3)} s; first frame after it ${elapsed(BE, lecLine)} elapsed, demo ${elapsed(DE, lecLine)})` : 'n/a'}`);
}

// ── 2 ──
out('');
out('2. What the Circle of Doom shows at the lap-seek clocks (focus LEC; backend frame; the demo frame is checked for the same memo key)');
for (const L of SEEK_LAPS) {
  const b = BE.frameClocks[BE.lapFrameMap[L]];
  const d = DE.frameClocks[DE.lapFrameMap[L]];
  const v = panel(BE, b, `LAP ${L} (→ / Jump to Lap ${L}; ${elapsed(BE, b)} elapsed, demo ${elapsed(DE, d)})`, { k: L <= 33 });
  const pl = estimatePitLoss(DE.lapTimes, { sessionNow: d, sessionType: 'R' });
  const kd = circleMemoKey(FOCUS, DE.lapTimes, d, pl, DE.trackStatus);
  const vd = view(DE, FOCUS, d);
  const sameText = focusLine(vd, FOCUS) === focusLine(v, FOCUS) && rejoinLabel(vd) === rejoinLabel(v);
  out(`     demo frame ${d.toFixed(3)} s: memo key ${kd === v.memoKey ? 'equal' : 'DIFFERENT'}; centre and label ${sameText ? 'identical' : `differ: ${focusLine(vd, FOCUS)} | ${rejoinLabel(vd)}`}`);
}

// ── 3 ──
const TL0 = BE.frameClocks[BE.lapFrameMap[28]];
out('');
out(`3. Every readout from LAP 28 (${TL0.toFixed(3)} s) to the end of LEC's out-lap (${WOUT.toFixed(3)} s), event by event`);
out('   Columns: interval of race time it holds (playback), share of W, frames there (backend 0.4 s / demo 0.8 s), the event that starts it,');
out('   centre focus line | rejoin label | traffic probability | p(P6) (exact draw share, tooltip "Rejoin positions") | pit loss | Gain the place | Within reach');
const evs = eventsIn(BE, TL0, WOUT);
const starts = [{ t: TL0, what: 'LAP 28 seek clock' }];
for (const e of evs) {
  const last = starts[starts.length - 1];
  if (Math.abs(e.t - last.t) < 1e-9) last.what += `; ${e.what}`;
  else starts.push({ ...e });
}
const segs = [];
for (let i = 0; i < starts.length; i++) {
  const a = starts[i].t;
  const b = i + 1 < starts.length ? starts[i + 1].t : WOUT;
  const v = view(BE, FOCUS, a);
  const w = v.win;
  const car = v.state.cars.find((c) => c.driver === FOCUS);
  segs.push({
    a, b, what: starts[i].what, v, key: v.memoKey,
    lapInProgress: car.lapsCompleted + 1,
    head: focusLine(v, FOCUS),
    label: rejoinLabel(v),
    flag: !!w.traffic?.flag,
    flagCar: w.traffic?.flag ? w.traffic.carAhead : null,
    tp: v.dist?.trafficProbability ?? null,
    p6: pPos(v.dist, 6),
    predicted: w.predictedPosition,
    loss: lossCentre(v),
    gain: w.available ? names(w.wouldPassFocus) : '',
    reach: w.available ? names(w.wouldDropBehindFocus) : '',
    nB: BE.frameClocks.filter((t) => t >= a && t < b).length,
    nD: DE.frameClocks.filter((t) => t >= a && t < b).length,
  });
}
// check: at every frame clock the memo key is its segment's key (no change between events)
let keyMismatch = 0; let framesChecked = 0;
for (const [race, label] of [[BE, 'backend'], [DE, 'demo']]) {
  for (const t of race.frameClocks) {
    if (t < TL0 || t >= WOUT) continue;
    const s = segs.find((x) => t >= x.a && t < x.b);
    const pl = estimatePitLoss(race.lapTimes, { sessionNow: t, sessionType: 'R' });
    framesChecked++;
    if (circleMemoKey(FOCUS, race.lapTimes, t, pl, race.trackStatus) !== s.key) { keyMismatch++; out(`   memo key change inside a segment at ${label} frame ${t.toFixed(3)}`); }
  }
}
const Wlen = W1 - W0;
const inW = (s) => Math.max(0, Math.min(s.b, W1) - Math.max(s.a, W0));
{
  // consecutive events that leave everything listed unchanged are merged
  const shown = (s) => `${s.head} | ${s.label} | tp ${s.tp == null ? '—' : `${Math.round(s.tp * 100)}%`} | p(P6) ${(s.p6 * 100).toFixed(1)}% | ${s.loss} | gain: ${s.gain} | reach: ${s.reach}`;
  const merged = [];
  for (const s of segs) {
    const t = shown(s);
    const last = merged[merged.length - 1];
    if (last && last.t === t) { last.b = s.b; last.n += 1; last.nB += s.nB; last.nD += s.nD; last.laps.add(s.lapInProgress); last.wsec += inW(s); } else {
      merged.push({ t, a: s.a, b: s.b, n: 1, what: s.what, nB: s.nB, nD: s.nD, laps: new Set([s.lapInProgress]), wsec: inW(s) });
    }
  }
  for (const m of merged) {
    out(`   ${m.a.toFixed(1)}-${m.b.toFixed(1)} (${(m.b - m.a).toFixed(1)} s, W ${pct(m.wsec, Wlen)}, frames ${m.nB}/${m.nD}) starts at: ${m.what}${m.n > 1 ? ` (+${m.n - 1} later events, nothing listed changes)` : ''}; LEC on L${[...m.laps].join('/')}`);
    out(`        ${m.t}`);
  }
}
out(`   check: ${framesChecked} frame clocks (backend and demo) in the range, memo key different from its segment's: ${keyMismatch}`);

// ── 4 ──
out('');
out(`4. Shares of W (${W0.toFixed(1)}-${W1.toFixed(1)} s, ${Wlen.toFixed(1)} s; backend frames ${BE.frameClocks.filter((t) => t >= W0 && t < W1).length}, demo frames ${DE.frameClocks.filter((t) => t >= W0 && t < W1).length})`);
const nWB = BE.frameClocks.filter((t) => t >= W0 && t < W1).length;
const nWD = DE.frameClocks.filter((t) => t >= W0 && t < W1).length;
function share(pred) {
  const sel = segs.filter(pred);
  const sec = sel.reduce((x, s) => x + inW(s), 0);
  const fb = BE.frameClocks.filter((t) => t >= W0 && t < W1 && sel.some((s) => t >= s.a && t < s.b)).length;
  const fd = DE.frameClocks.filter((t) => t >= W0 && t < W1 && sel.some((s) => t >= s.a && t < s.b)).length;
  return `${sec.toFixed(1)} s (${pct(sec, Wlen)}); frames backend ${fb}/${nWB} (${pct(fb, nWB)}), demo ${fd}/${nWD} (${pct(fd, nWD)})`;
}
const headlines = [];
for (const s of segs) {
  if (inW(s) <= 0) continue;
  const h = `${s.head} | ${s.label}`;
  const last = headlines[headlines.length - 1];
  if (last && last.h === h) last.b = s.b; else headlines.push({ h, a: Math.max(s.a, W0), b: s.b });
}
out('  4a. consecutive readouts of the centre line and the rejoin label (what a reader sees change), with their duration:');
for (const x of headlines) {
  const b = Math.min(x.b, W1);
  const fb = BE.frameClocks.filter((t) => t >= x.a && t < b).length;
  const fd = DE.frameClocks.filter((t) => t >= x.a && t < b).length;
  out(`     ${x.a.toFixed(1)}-${b.toFixed(1)} (from ${elapsed(BE, x.a)} elapsed, demo ${elapsed(DE, x.a)}; ${(b - x.a).toFixed(1)} s, ${pct(b - x.a, Wlen)} of W; frames ${fb}/${fd}): ${x.h}`);
}
out('  4b. by predicted place (centre "P4 → Pn"):');
for (const p of [...new Set(segs.filter((s) => inW(s) > 0).map((s) => s.predicted))].sort((a, b) => a - b)) out(`     P${p}: ${share((s) => s.predicted === p)}`);
out('  4c. traffic flag at the rejoin (label "traffic x s behind CAR"):');
out(`     flag up: ${share((s) => s.flag)}`);
for (const c of [...new Set(segs.filter((s) => s.flag && inW(s) > 0).map((s) => s.flagCar))]) out(`       behind ${c}: ${share((s) => s.flag && s.flagCar === c)}`);
out(`     no flag: ${share((s) => !s.flag)}`);
out('  4d. traffic probability (tooltip) and p(P6):');
out(`     traffic probability >= 50%: ${share((s) => s.tp >= 0.5)}`);
out(`     traffic probability 0%: ${share((s) => s.tp === 0)}`);
out(`     p(P6) >= 50%: ${share((s) => s.p6 >= 0.5)}`);
out('  4e. by LEC\'s lap in progress (from his line at the end of the previous lap):');
for (const L of [28, 29, 30, 31, 32, 33]) {
  const sel = segs.filter((s) => s.lapInProgress === L && inW(s) > 0);
  if (!sel.length) continue;
  const a = Math.max(sel[0].a, W0); const b = Math.min(sel[sel.length - 1].b, W1);
  const parts = [];
  for (const s of sel) {
    const t = `${s.head.replace(`${FOCUS} pits now: `, '')} | ${s.label}`;
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.sec += inW(s); else parts.push({ t, sec: inW(s) });
  }
  out(`     L${L} (${a.toFixed(1)}-${b.toFixed(1)} s, ${(b - a).toFixed(1)} s): ${parts.map((p) => `${p.t} [${p.sec.toFixed(1)} s, ${pct(p.sec, b - a)}]`).join(' ; ')}`);
}

// ── 5 ──
out('');
out(`5. Pit in k laps: the row of in-lap L${IN_LAP} (the stop LEC made) over W, k = ${IN_LAP} - LEC's lap in progress.`);
out('   "off" = the default (other cars do not stop), "on" = the "rivals" button pressed; "flat" = the same row with a flat lap model');
out('   (no tyre wear, no fresh-tyre delta): NOT displayed, it separates what the lap model adds from the window\'s constant paces.');
const kRows = [];
for (const s of segs) {
  if (inW(s) <= 0) continue;
  const k = IN_LAP - s.lapInProgress;
  if (k < 0 || k > 10) continue;
  if (k === 0) {
    // on LEC's in-lap the row of in-lap 33 is k = 0: the stepper at 0 shows the pit-now window itself, no pit-in row
    const t = 'k0: in-lap L33 is the lap in progress; the stepper at 0 shows the pit-now window (section 3), no "pit in" row is displayed';
    const last = kRows[kRows.length - 1];
    if (last && last.t === t) last.b = s.b; else kRows.push({ t, a: Math.max(s.a, W0), b: s.b, models: [] });
    continue;
  }
  const v = view(BE, FOCUS, s.a, { k: true });
  const fl = pitInFlat(BE, s.a);
  const r0 = v.pitIn.off?.rows?.find((r) => r.inLap === IN_LAP);
  const r1 = v.pitIn.on?.rows?.find((r) => r.inLap === IN_LAP);
  const rf = fl?.rows?.find((r) => r.inLap === IN_LAP);
  const txt = (r, on) => (r ? `P${r.predictedPosition} at L${r.targetLap} (${placesVsNow(r.positionsVsNow)}; waiting ${r.secondsVsNow >= 0 ? 'costs' : 'gains'} ${fmt1(Math.abs(r.secondsVsNow))} s)${on && r.rivalStops.length ? ` other cars stopping by then: ${r.rivalStops.join(',')}` : ''}` : 'n/a');
  const onText = txt(r1, true);
  const t = `k${k}: off ${txt(r0, false)} | on ${onText === txt(r0, false) ? 'the same' : onText} | flat ${txt(rf, false)}`;
  const model = lapModelText(v.pitIn.off);
  const last = kRows[kRows.length - 1];
  if (last && last.t === t) { last.b = s.b; if (!last.models.includes(model)) last.models.push(model); } else kRows.push({ t, a: Math.max(s.a, W0), b: s.b, models: [model] });
}
for (const x of kRows) {
  const b = Math.min(x.b, W1);
  out(`   ${x.a.toFixed(1)}-${b.toFixed(1)} (${(b - x.a).toFixed(1)} s, ${pct(b - x.a, Wlen)} of W; frames ${BE.frameClocks.filter((t) => t >= x.a && t < b).length}/${DE.frameClocks.filter((t) => t >= x.a && t < b).length}): ${x.t}`);
  if (x.models.length) out(`        tooltip ${x.models[0]}${x.models.length > 1 ? ` ... ${x.models[x.models.length - 1]} (${x.models.length} values over the interval)` : ''}`);
}
{
  // summary: share of W by the place the displayed row (k >= 1, rivals off) projects for in-lap 33
  const by = new Map();
  for (const s of segs) {
    const sec = inW(s);
    if (sec <= 0) continue;
    const k = IN_LAP - s.lapInProgress;
    let key;
    if (k === 0) key = 'k0 (no pit-in row; pit-now window)';
    else if (k > 10) key = 'in-lap 33 beyond k = 10';
    else {
      const r = view(BE, FOCUS, s.a, { k: true }).pitIn.off?.rows?.find((x) => x.inLap === IN_LAP);
      key = r ? `P${r.predictedPosition} (${placesVsNow(r.positionsVsNow)})` : 'n/a';
    }
    by.set(key, (by.get(key) || 0) + sec);
  }
  out(`   summary over W (rivals off): ${[...by].map(([k2, sec]) => `${k2} ${sec.toFixed(1)} s (${pct(sec, Wlen)})`).join('; ')}`);
}
{
  // the same at the lap-seek clocks (k = 33 - LEC's lap in progress there)
  out('   at the lap-seek clocks:');
  for (const L of SEEK_LAPS) {
    const b = BE.frameClocks[BE.lapFrameMap[L]];
    const v = view(BE, FOCUS, b, { k: true });
    const fl = pitInFlat(BE, b);
    const r0 = v.pitIn.off?.rows?.find((r) => r.inLap === IN_LAP);
    const rf = fl?.rows?.find((r) => r.inLap === IN_LAP);
    if (!r0) continue;
    out(`     LAP ${L}: ${pitInRowText(r0)} | flat: ${rf ? pitInRowText(rf) : 'n/a'}`);
  }
}

// ── 6 ──
out('');
out('6. Gap tags of the cars behind (ring label "CAR +x.x" and hover row "Gap to LEC"; gapSeconds = crossing difference on the latest lap both cars have completed)');
for (const d of ['OCO', 'STR', 'SAI', 'HAD', 'ALB', 'HAM']) {
  const parts = [];
  for (const s of segs) {
    if (inW(s) <= 0) continue;
    const tag = focusTag(s.v, FOCUS, d);
    const last = parts[parts.length - 1];
    if (last && last.tag === tag) last.b = s.b; else parts.push({ tag, a: Math.max(s.a, W0), b: s.b });
  }
  out(`   ${d}: ${parts.map((p) => `${p.tag} [${p.a.toFixed(1)}-${Math.min(p.b, W1).toFixed(1)}]`).join(' → ')}`);
}

// ── 7 ──
out('');
out('7. Model-based counterfactual (ex post; NOT displayed by any view): the pit-now window at the end of LEC\'s laps 27-32');
out('   (first backend frame at or after his line) placed among the OTHER cars\' ACTUAL line crossings. The predicted crossing is the dashboard\'s');
out('   model (last crossing + 2 x recent pace + pit loss median); the actual crossings include stops the dashboard could not know yet.');
for (let n = 27; n <= 32; n++) {
  const t = firstFrameAtOrAfter(BE, T(BE, FOCUS, n));
  const v = view(BE, FOCUS, t);
  const w = v.win;
  const m = w.targetLap;
  let ahead = 0;
  for (const [d2, l2] of BE.by) { if (d2 !== FOCUS && l2.get(m)?.Time != null && l2.get(m).Time < w.predictedCrossing) ahead++; }
  const nb = roadNeighbours(BE, FOCUS, w.predictedCrossing);
  out(`   end of L${n} (frame ${t.toFixed(3)} s; in-lap L${n + 1}): shown P${w.predictedPosition}${w.traffic.flag ? ` with traffic ${trafficSeconds(w.traffic.gapSeconds)} behind ${w.traffic.carAhead}` : ', no traffic flag'};`
    + ` predicted crossing of L${m} ${w.predictedCrossing.toFixed(2)} s -> rank among the actual L${m} crossings P${1 + ahead};`
    + ` car ahead on the road ${nb.ahead ? `${nb.ahead.driver} (its L${nb.ahead.lap}) ${nb.ahead.gap.toFixed(2)} s` : '-'}, behind ${nb.behind ? `${nb.behind.driver} (its L${nb.behind.lap}) ${nb.behind.gap.toFixed(2)} s` : '-'}`);
}
{
  const t = firstFrameAtOrAfter(BE, T(BE, FOCUS, IN_LAP - 1));
  const w = view(BE, FOCUS, t).win;
  out(`   the stop made: window at the end of L${IN_LAP - 1} predicted the L${IN_LAP + 1} crossing at ${w.predictedCrossing.toFixed(3)} s; actual ${T(BE, FOCUS, IN_LAP + 1).toFixed(3)} s (difference ${(T(BE, FOCUS, IN_LAP + 1) - w.predictedCrossing).toFixed(3)} s)`);
}

// ── 8 ──
out('');
out('8. What happened (lap rows, known only after the clock)');
for (let n = 26; n <= 40; n++) {
  const r = BE.by.get(FOCUS).get(n);
  const nb = r?.Time != null ? roadNeighbours(BE, FOCUS, r.Time) : null;
  out(`   LEC L${n}: end ${r.Time?.toFixed(3)} s, lap ${r.LapTimeSeconds?.toFixed(3)} s, ${r.Compound}/${r.TyreLife}, track status ${r.TrackStatus}`
    + `${pitInSeconds(r) != null ? `, pit entry ${pitInSeconds(r).toFixed(3)}` : ''}${pitOutSeconds(r) != null ? `, pit exit ${pitOutSeconds(r).toFixed(3)}` : ''}`
    + `, place P${placeAt(BE, FOCUS, n)}, car ahead on the road ${nb?.ahead ? `${nb.ahead.driver} (its L${nb.ahead.lap}) ${nb.ahead.gap.toFixed(3)} s` : '-'}`);
}
{
  const ch = [];
  let prev = null;
  for (let n = 1; n <= BE.maxLap; n++) {
    const p = placeAt(BE, FOCUS, n);
    if (p != null && p !== prev) { ch.push(`L${n} P${p}`); prev = p; }
  }
  out(`   LEC place at the line, changes over the race: ${ch.join(', ')}; classified ${lec.ClassifiedPosition}`);
  const lapT = (n) => BE.by.get(FOCUS).get(n).LapTimeSeconds;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const med = [30, 31, 32].map(lapT);
  const hard = [35, 36, 37].map(lapT);
  out(`   LEC's last three full laps on MEDIUM (L30-L32) mean ${mean(med).toFixed(3)} s; first three flying laps on HARD (L35-L37) mean ${mean(hard).toFixed(3)} s; difference HARD - MEDIUM ${(mean(hard) - mean(med)).toFixed(3)} s per lap`);
}
out('   stops of the cars named in the windows (in-lap: pit entry, session seconds), and their line gap behind LEC (row Time - LEC Time; + = behind):');
for (const d of ['RUS', 'HAM', 'ALB', 'ANT', 'SAI', 'OCO', 'STR', 'HAD', 'GAS']) {
  const ins = inLapsOf(BE, d).map((n) => `L${n} (${PIN(BE, d, n).toFixed(1)})`).join(', ');
  const gaps = [26, 27, 28, 29, 30, 31, 32, 33].map((n) => { const a = T(BE, d, n); const b = T(BE, FOCUS, n); return a != null && b != null ? `L${n} ${(a - b).toFixed(2)}` : `L${n} -`; });
  const cl = BE.results.find((r) => r.Abbreviation === d)?.ClassifiedPosition;
  out(`     ${d}: in-laps ${ins || '-'}; classified ${cl}; gap ${gaps.join(' | ')}`);
}
{
  const before = BE.lapTimes.filter((r) => pitInSeconds(r) != null && pitInSeconds(r) >= W0 && pitInSeconds(r) < W1)
    .sort((a, b) => pitInSeconds(a) - pitInSeconds(b))
    .map((r) => `${r.Driver} in-lap ${r.LapNumber} at ${pitInSeconds(r).toFixed(1)}`);
  out(`   pit entries inside W (before LEC's): ${before.join('; ')}`);
}

{
  // the outcome as the Circle of Doom shows it after the stop (focus LEC), at the lap-seek clocks
  out('   after the stop, at the lap-seek clocks (focus LEC): LEC\'s place (tooltip title "LEC — Pn") and the ring tags / "Gap to LEC" of the cars around:');
  for (const L of [35, 36, 37, 38, 39, 40, 41, 42]) {
    const b = BE.frameClocks[BE.lapFrameMap[L]];
    const d = DE.frameClocks[DE.lapFrameMap[L]];
    const v = view(BE, FOCUS, b);
    const car = v.state.cars.find((c) => c.driver === FOCUS);
    const pl = estimatePitLoss(DE.lapTimes, { sessionNow: d, sessionType: 'R' });
    const same = circleMemoKey(FOCUS, DE.lapTimes, d, pl, DE.trackStatus) === v.memoKey;
    out(`     LAP ${L} (${b.toFixed(3)} s, ${elapsed(BE, b)} elapsed; demo ${d.toFixed(3)} s, ${elapsed(DE, d)} elapsed, memo key ${same ? 'equal' : 'DIFFERENT'}): LEC P${car.position}, on L${car.lapsCompleted + 1};`
      + ` ${['PIA', 'HAM', 'ALB', 'OCO', 'STR'].map((x) => `${x} ${focusTag(v, FOCUS, x)}`).join(' | ')}`);
  }
}

// ── 9 ──
out('');
out('9. Context: lines of docs/evidence/cod_backtest.txt (frontend/scripts/cod_backtest.mjs), quoted, not recomputed here');
{
  const bt = fs.readFileSync(path.join(ROOT, 'docs/evidence/cod_backtest.txt'), 'utf8').split(/\r?\n/);
  const want = [/^race\s+n_green/, /^2025_16\s/, /^\s+module\s+stops=709/, /stops where no rival stops at all/, /^\s+module\s+stops=110/];
  for (const re of want) { const l = bt.find((x) => re.test(x)); if (l) out(`   | ${l.trimEnd()}`); }
}

// ── 10 ──
out('');
out('10. Secondary vignette, same race: a pit loss measured on ONE stop (BEA, Haas, before his stop on in-lap 18)');
{
  // pit-loss estimate in the Circle of Doom centre over the race up to LEC's stop: the number of stops behind it
  const ts = [...new Set(BE.lapTimes.flatMap((r) => [lapEndTime(r), pitOutSeconds(r)]).filter((x) => x != null && x < WOUT))].sort((a, b) => a - b);
  const runs = [];
  for (const t of [BE.offset, ...ts]) {
    const p = estimatePitLoss(BE.lapTimes, { sessionNow: t, sessionType: 'R' });
    const key = `${p.source}|${p.n}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) { last.b = t; continue; }
    if (last) last.b = t;
    runs.push({ key, a: t, b: t, p });
  }
  out('   pit-loss estimate (centre "pit loss x s (n stops)") by number of stops, from the race start to the end of LEC\'s out-lap:');
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const end = i + 1 < runs.length ? runs[i + 1].a : WOUT;
    const d = pitLossDisplay(r.p);
    out(`     ${r.a.toFixed(1)}-${end.toFixed(1)} (${(end - r.a).toFixed(1)} s): ${d.isFallback ? `fallback ${fmt1(d.value)} s` : `${r.p.n} stop${r.p.n === 1 ? '' : 's'}, first value ${fmt1(d.value)} s, p10–p90 ${fmt1(d.p10)}–${fmt1(d.p90)} s`}${r.p.samples?.length ? ` [${r.p.samples.map((x) => `${x.driver} L${x.inLap}`).join(', ')}]` : ''}`);
  }
  const bea = 'BEA';
  const b17 = BE.frameClocks[BE.lapFrameMap[18]];
  const v = view(BE, bea, b17);
  const w = v.win;
  const loss = pitLossDisplay(v.pitLoss);
  out(`   LAP 18 seek clock ${b17.toFixed(3)} s (${elapsed(BE, b17)} elapsed; demo ${DE.frameClocks[DE.lapFrameMap[18]].toFixed(3)} s, ${elapsed(DE, DE.frameClocks[DE.lapFrameMap[18]])} elapsed), focus BEA: centre "${lossCentre(v)}" | "${focusLine(v, bea)}" | label "${rejoinLabel(v)}"`);
  out(`     tooltip: Rejoin positions ${(v.dist?.positions || []).map((p) => `P${p.position} ${(p.probability * 100).toFixed(1)}%`).join(' · ')} | Draws ${v.dist?.samples}, ${v.dist?.method === 'bootstrap' ? `bootstrap of ${loss.n} stops` : 'fallback'} | Pit loss ${fmt1(loss.value)} s (p10–p90 ${fmt1(w.pitLoss.p10)}–${fmt1(w.pitLoss.p90)} s, ${loss.n} stops) | Traffic at the rejoin: ${trafficText(w.traffic)} | Traffic probability ${Math.round((v.dist?.trafficProbability ?? 0) * 100)}%`);
  // BEA from the LAP 18 seek clock to his pit entry: distinct headlines
  const from = b17; const to = PIN(BE, bea, 18);
  const ev = [from, ...eventsIn(BE, from, to).map((e) => e.t)];
  const parts = [];
  for (let i = 0; i < ev.length; i++) {
    const a = ev[i]; const b = i + 1 < ev.length ? ev[i + 1] : to;
    const vv = view(BE, bea, a);
    const t = `${focusLine(vv, bea)} | ${rejoinLabel(vv)} | ${lossCentre(vv)} | p10–p90 ${vv.win.available ? `${fmt1(vv.win.pitLoss.p10)}–${fmt1(vv.win.pitLoss.p90)}` : '-'}`;
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.b = b; else parts.push({ t, a, b });
  }
  out(`   BEA from the LAP 18 seek clock to his pit entry (${to.toFixed(3)} s):`);
  for (const p of parts) out(`     ${p.a.toFixed(1)}-${p.b.toFixed(1)} (${(p.b - p.a).toFixed(1)} s; frames ${BE.frameClocks.filter((t) => t >= p.a && t < p.b).length}/${DE.frameClocks.filter((t) => t >= p.a && t < p.b).length}): ${p.t}`);
  const outLap = 19;
  const nb = roadNeighbours(BE, bea, T(BE, bea, outLap));
  out(`   what happened: BEA pit entry L18 ${PIN(BE, bea, 18).toFixed(1)} s; end of out-lap L${outLap} place P${placeAt(BE, bea, outLap)}, car ahead on the road ${nb.ahead ? `${nb.ahead.driver} (its L${nb.ahead.lap}) ${nb.ahead.gap.toFixed(2)} s` : '-'}; classified ${BE.results.find((r) => r.Abbreviation === bea)?.ClassifiedPosition}`);
}

const text = `${lines.join('\n')}\n`;
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, text);
console.error(`written ${OUT_FILE}`);
