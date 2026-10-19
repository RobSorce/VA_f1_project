/**
 * Use case UC1 of the paper: Monza 2024 (R16), the Ferrari strategist at laps
 * 33-36. Hold LEC's one-stop (hards fitted on lap 16, to the flag) or make a
 * second stop after McLaren stopped NOR a second time (in-lap 32)? The
 * McLaren pit wall (PIA, NOR) is the counterpart: the same views asked about
 * their second stops, and what the fresh hards gained afterwards.
 *
 * Every number of the use case is printed here, computed with the dashboard's
 * own modules called the way the store and the views call them:
 *  - store simulationJob / computeRaceSituation / computeRaceProjection /
 *    runSimulation (src/store/useF1Store.js): features
 *    (extractRaceSituationFeatures with the frame's drivers), seed
 *    (seedFrom('race-simulation', 'year|round|R', currentLap, maxLap,
 *    causalKey)), runSimulationJob, withBadges chained on the projection held,
 *    whatIfMarks with the result held of the same what-if;
 *  - StrategySimulator.jsx: Copy Actual (simulatorStints), the plan label of
 *    Save for Compare, planFromStints, the cards, DeltaSummary (mean of the
 *    paired differences, its interval, podium / points change);
 *  - RacePredictionPanel.jsx: header (pitLossDisplay of the projection's
 *    raceParams, lap noise, SC rate), rows (modePosition, positionChange,
 *    podium share, P5-P95, expected position in the tooltip), the bar
 *    tooltips (positionShares);
 *  - TireDegradation.jsx: tyreDegradationView with the lap range, the brushed
 *    fit banner (the store clamps lap_end to the laps completed; the static
 *    demo answers with utils/demoData.js degradationResponse), NEXT PIT
 *    WINDOW (undercut_window; the forecast fallback needs the backend);
 *  - StrategyTimeline.jsx: stints (deriveStints, stintBars), stop markers
 *    (pitStopMarkers), the lap range a stint click sets;
 *  - CircleOfDoom.jsx: the "pit in k laps" tooltip rows "Lap model" and
 *    "Fresh-tyre delta" (pitInLaps with the component's extractRaceParams).
 *
 * Clock. Monza 2024 has replay frames; the static demo keeps every second one
 * (0.8 s). A lap seek (the right / left arrow keys, a lap click on the
 * expanded timeline, Ctrl+K "Jump to Lap") lands on lapFrameMap[L], the first
 * frame whose highest driver lap is L: the leader has just crossed the line to
 * start lap L (store setCurrentLap, hooks/useReplayEngine.js seekToLap). The
 * numbers are those of that frame of the DEMO frames (sessionNow = frame.t +
 * sessionTimeOffset, frameDrivers = the frame's drivers), the replay paused
 * there. Section A checks that the full app's frame and the lap-mode clock
 * (resolveSessionNow, currentLap = L) give the same knowledge state
 * (causalKey), features and seed, and measures how long the readout holds when
 * the replay plays on (until the next completed lap or pit event). Section I
 * gives what a Run gives instead at every later clock of laps 35 and 36 (each
 * demo frame at which the knowledge state changes).
 *
 * Ground truth (section J and the measured side of section H) comes from the
 * lap rows after the clocks and is never an input of the dashboard numbers.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/usecases/uc1_monza24_strategy.mjs [--out FILE]
 * Prints the report and writes the same text to
 * docs/evidence/usecase_uc1_monza24_strategy.txt (or FILE). Reads the static
 * demo's files (frontend/public/data/2024_16_R); when the local cache
 * (backend/data/processed_cache) has the race, section A also compares the
 * demo payload with it and reads the full app's frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractRaceSituationFeatures } from '../../src/utils/raceSituationFeatures.js';
import {
  resolveSessionNow, computeSessionTimeOffset, completedLaps, isPitVisible, isLapCompleted, pitOutSeconds,
} from '../../src/utils/raceTime.js';
import {
  causalKey, simulatorStints, pitLossDisplay, pitStopMarkers, stintBars,
} from '../../src/utils/strategyViews.js';
import { seedFrom } from '../../src/utils/prng.js';
import { stintsByDriver, deriveStints } from '../../src/utils/stints.js';
import {
  runSimulationJob, withBadges, whatIfMarks, whatIfKey, planFromStints, pairedInterval, familyZ,
  WHATIF_MARKS, modePosition, positionChange,
} from '../../src/utils/simulationClient.js';
import { extractRaceParams, degradationFor, PRIORS } from '../../src/utils/raceSimulation.js';
import { tyreDegradationView } from '../../src/utils/views/degradationViews.js';
import { positionShares } from '../../src/utils/views/positionRangeChart.js';
import { degradationResponse } from '../../src/utils/demoData.js';
import { stintFits, isCleanLap, FUEL_EFFECT_S_PER_LAP } from '../../src/utils/degradation.js';
import { estimatePitLoss } from '../../src/utils/pitLoss.js';
import { circleState, pitWindow, phaseAt, rejoinDistribution } from '../../src/utils/circleOfDoom.js';
import { pitInLaps } from '../../src/utils/undercut.js';
import { placesMark, verdictMark } from '../../src/utils/views/strategyMarks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEMO_DIR = path.join(ROOT, 'frontend/public/data/2024_16_R');
const CACHE_DIR = path.join(ROOT, 'backend/data/processed_cache');
const OUT_ARG = process.argv.indexOf('--out');
const OUT_FILE = OUT_ARG > 0
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.join(ROOT, 'docs/evidence/usecase_uc1_monza24_strategy.txt');

const YEAR = 2024;
const ROUND = 16;
const DEMO_URL = 'https://robsorce.github.io/VA_f1_project/';

// ── Output ────────────────────────────────────────────────────────────────
const lines = [];
const out = (s = '') => { lines.push(String(s)); console.log(String(s)); };
const sgn = (v, d = 3) => (v == null || !Number.isFinite(v) ? '-' : `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(d)}`);
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '-');
const pct1 = (s) => `${Math.round(s * 1000) / 10} %`; // positionRangeChart tooltip format

// ── Data: the static demo's payload (what the demo's store loads) ─────────
function readJson(file) {
  const buf = fs.readFileSync(file);
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
  try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/\bNaN\b/g, 'null')); }
}

/** store/useF1Store.js dnfMapFromResults (l.1344-1355), module-private there. */
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

const session = readJson(path.join(DEMO_DIR, 'session.json.gz'));
const demoFrames = readJson(path.join(DEMO_DIR, 'frames.json.gz')).frames;
const lapTimes = session.lap_times || [];
let maxLap = 1;
for (const lt of lapTimes) if (lt.LapNumber > maxLap) maxLap = lt.LapNumber;
const race = {
  lapTimes,
  trackStatus: session.track_status || [],
  strategies: session.tyre_strategy || session.strategies || [],
  results: session.race_results || [],
  maxLap,
  offset: computeSessionTimeOffset(lapTimes),
  dnfMap: dnfMapFromResults(session.race_results, maxLap),
};
const fullFramesFile = path.join(CACHE_DIR, `frames_${YEAR}_${ROUND}_R.json`);
const cacheSessionFile = path.join(CACHE_DIR, `session_${YEAR}_${ROUND}_R.json`);
const fullFrames = fs.existsSync(fullFramesFile) ? readJson(fullFramesFile).frames : null;

/** store loadFrames (l.3141-3169): lap -> index of the first frame whose highest driver lap is it. */
function lapFrameMapOf(frames) {
  const m = {};
  frames.forEach((f, i) => {
    let lap = 0;
    for (const d of Object.values(f.drivers || {})) if (d.lap > lap) lap = d.lap;
    if (lap > 0 && !(lap in m)) m[lap] = i;
  });
  return m;
}
const demoMap = lapFrameMapOf(demoFrames);
const fullMap = fullFrames ? lapFrameMapOf(fullFrames) : null;

/**
 * The races the priors (raceSimulation.js PRIORS) are fitted on: the
 * "Cached races:" line of docs/evidence/mc_benchmark.txt, which prints the
 * priors PRIORS copies, and whether this race is among them.
 */
const CACHED_RACES = (() => {
  const file = path.join(ROOT, 'docs/evidence/mc_benchmark.txt');
  const line = fs.existsSync(file)
    ? (fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('Cached races:')) || '')
    : '';
  const listed = line.match(/\(([^)]*)\)/)?.[1]?.split(',').map((s) => s.trim()) || [];
  const tag = `${YEAR} R${ROUND}`;
  return {
    line,
    thisRace: listed.includes(tag) ? `this race (${tag}) included` : `this race (${tag}) not in the list`,
  };
})();

// ── Clocks, features, jobs (the store's path) ─────────────────────────────
function lapModeNow(lap) {
  return resolveSessionNow({
    currentTime: undefined, sessionTimeOffset: race.offset, replayActive: false,
    currentLap: lap, maxLap: race.maxLap, lapTimes: race.lapTimes, isLiveMode: false, raceOver: false,
  });
}

/** The demo lap-seek clock of lap L (or the full app's with frames = fullFrames). */
function seekClock(lap, frames = demoFrames, map = demoMap) {
  const idx = map[lap];
  const frame = frames[idx];
  return { lap, idx, now: frame.t + race.offset, drivers: frame.drivers || {} };
}

/** store computeRaceSituation (l.3357-3431): the race-state features at a clock. */
function featuresAt(lap, now, frameDrivers = {}) {
  return extractRaceSituationFeatures({
    lapTimes: race.lapTimes, strategies: race.strategies, dnfMap: race.dnfMap, currentLap: lap,
    frameDrivers, lstmPredictions: null, focusDriver: null,
    sessionNow: now, sessionTimeOffset: race.offset, isLiveMode: false, running: false,
  });
}

/**
 * store simulationJob (l.425-460): params and seed at currentLap = lap and
 * sessionNow = now, with the driver features of the race situation held
 * (computed at featNow, the lap's first frame, unless given).
 */
function jobAt(lap, now, feats) {
  if (!feats?.driverFeatures || !(lap >= 5) || !(race.maxLap > lap)) return null;
  const known = causalKey(race.lapTimes, now, race.trackStatus);
  const seed = seedFrom('race-simulation', `${YEAR}|${ROUND}|R`, lap, race.maxLap, known);
  return {
    lap, now, known, seed, feats,
    params: {
      driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: race.maxLap, lapTimes: race.lapTimes,
      trackStatus: race.trackStatus, sessionNow: now, sessionTimeOffset: race.offset, sessionType: 'R',
      running: false, dnfMap: race.dnfMap, seed,
    },
  };
}

function jobAtClock(c) {
  return jobAt(c.lap, c.now, featuresAt(c.lap, c.now, c.drivers));
}

/** store computeRaceProjection (l.4100-4151): the projection, its badges chained on the one held. */
function project(job, prevBadges = null) {
  const res = runSimulationJob('project', job.params);
  if (!res) return null;
  return withBadges(res, prevBadges, {
    driverFeatures: job.params.driverFeatures, currentLap: job.lap, maxLap: race.maxLap,
  });
}

// ── Strategy Simulator ────────────────────────────────────────────────────
function normalizeStints(stints) {
  let lapStart = 1;
  return stints.map((s) => {
    const n = { ...s, lapStart };
    lapStart += s.length;
    return n;
  });
}
const stintsOf = (list) => normalizeStints(list.map(([compound, length]) => ({ compound, length })));
const planLabel = (stints) => stints.map((s) => `${s.compound[0]}${s.length}`).join('-');

/** Copy Actual (StrategySimulator l.152-159) at a clock. */
function copyActual(now, driver) {
  const st = stintsByDriver(race.lapTimes, { sessionNow: now, running: false })[driver] || [];
  return simulatorStints(st, race.maxLap);
}

/** store runSimulation (l.4199-4247): the what-if and its marks. */
function whatIf(job, driver, planStints, baseStints, { held = null, panelMode = null } = {}) {
  const plan = planFromStints(planStints);
  const basePlan = baseStints ? planFromStints(baseStints) : null;
  const res = runSimulationJob('compare', { ...job.params, focusDriver: driver, plan, basePlan });
  if (!res) return null;
  const marks = whatIfMarks(res, held, { stopModel: !basePlan, panelMode });
  return { res, marks, key: whatIfKey(driver, plan, basePlan), plan, basePlan };
}

const shareAtMost = (row, k) => positionShares(row).filter(([p]) => p <= k).reduce((s, [, v]) => s + v, 0);

/** The Result tab as the Simulator draws it (cards, DeltaSummary), plus the shares of the bars. */
function describeWhatIf(w, planName, baseName) {
  const { res, marks } = w;
  const sp = res.simProjection;
  const bp = res.baselineProjection;
  const iv = pairedInterval(res.paired?.position);
  const half = iv ? (iv[1] - iv[0]) / 2 : null;
  const m = res.paired?.position?.mean;
  const verdict = marks.verdict > 0 ? 'PLACES GAINED' : marks.verdict < 0 ? 'PLACES LOST' : 'NO CLEAR CHANGE';
  const pctChange = (k) => {
    const v = res.paired?.[k]?.mean;
    const r = Math.round(100 * v);
    return Number.isFinite(v) ? `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r)}%` : '-';
  };
  const signedPlaces = (v) => (!v ? '0.0' : `${v > 0 ? '+' : '-'}${Math.abs(v).toFixed(Math.abs(v) < 0.095 ? 2 : 1)}`);
  return [
    `    card "Custom Strategy" ${planName.padEnd(12)} P${marks.shown.custom}  avg P${f1(sp.expectedPos)}  range P${sp.posRange[0]}-P${sp.posRange[1]}  ${sp.podiumProb}% podium  ${sp.pointsProb}% points`,
    `    card "Baseline: ${baseName}"`.padEnd(46) + `P${marks.shown.baseline}  avg P${f1(bp.expectedPos)}  range P${bp.posRange[0]}-P${bp.posRange[1]}  ${bp.podiumProb}% podium  ${bp.pointsProb}% points`,
    `    verdict ${verdictMark(marks.verdict).glyph} ${signedPlaces(m)} ±${half?.toFixed(2)} ${verdict}  Podium: ${pctChange('podium')}  Points: ${pctChange('points')}  (${res.numSimulations} runs each, interval z=${familyZ(WHATIF_MARKS).toFixed(2)})`,
    `    bars (share of runs): plan P1 ${pct1(shareAtMost(sp, 1))}, P1-P2 ${pct1(shareAtMost(sp, 2))}, P1-P3 ${pct1(shareAtMost(sp, 3))} | baseline P1 ${pct1(shareAtMost(bp, 1))}, P1-P2 ${pct1(shareAtMost(bp, 2))}, P1-P3 ${pct1(shareAtMost(bp, 3))}`,
  ];
}

// ── Helpers on the lap rows ───────────────────────────────────────────────
const rowOf = (drv, lap) => race.lapTimes.find((lt) => lt.Driver === drv && lt.LapNumber === lap) || null;
function lastCompleted(now, drv) {
  let best = 0;
  for (const lt of completedLaps(race.lapTimes, now)) if (lt.Driver === drv && lt.LapNumber > best) best = lt.LapNumber;
  return best;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const TOP = ['PIA', 'LEC', 'SAI', 'HAM', 'NOR'];

// ══════════════════════════════════════════════════════════════════════════
out(`UC1 Monza ${YEAR} R${ROUND}: hold LEC's one-stop or make a second stop (laps 33-36), McLaren's second stops as the counterpart`);
out(`Static demo: ${DEMO_URL} (race "Italian Grand Prix" 2024). Script: frontend/scripts/usecases/uc1_monza24_strategy.mjs`);
out('Clock of every dashboard number: the demo frame a lap seek lands on (lapFrameMap[L]), replay paused there (section A).');
out('');

// ── A. Data and clocks ────────────────────────────────────────────────────
out('A. DATA AND CLOCKS');
out(`A1. Demo payload: ${race.lapTimes.length} lap rows, ${race.maxLap} laps, ${Object.keys(race.dnfMap).length} non-finishers in the results (${Object.keys(race.dnfMap).join(', ') || 'none'}), `
  + `track-status events ${race.trackStatus.length} (${race.trackStatus.map((e) => `status ${e.status} "${e.message}" from ${f1(e.start_time)} s`).join('; ')}): no SC, VSC or red flag.`);
out(`    Replay frames: demo ${demoFrames.length} (dt ${(demoFrames[1].t - demoFrames[0].t).toFixed(3)} s)`
  + `${fullFrames ? `, full app ${fullFrames.length} (dt ${(fullFrames[1].t - fullFrames[0].t).toFixed(3)} s)` : ', full app frames not in the local cache'}; sessionTimeOffset ${f3(race.offset)} s.`);
if (fs.existsSync(cacheSessionFile)) {
  const cache = readJson(cacheSessionFile);
  const same = (k) => JSON.stringify(cache[k] ?? null) === JSON.stringify(session[k] ?? null);
  out(`    Demo payload vs local cache: lap_times ${same('lap_times') ? 'identical' : 'DIFFER'}, track_status ${same('track_status') ? 'identical' : 'DIFFER'}, `
    + `race_results ${same('race_results') ? 'identical' : 'DIFFER'}, tyre_strategy ${same('tyre_strategy') ? 'identical' : 'differs'}`
    + ` (${(session.tyre_strategy || []).length} vs ${(cache.tyre_strategy || []).length} rows: the backend rebuilds it from the lap rows when it serves`
    + ' the session, backend/api/main.py _rebuild_tyre_strategy, and the demo holds that answer; no number below reads it,'
    + ' the stints come from the lap rows, utils/stints.js).');
} else {
  out('    Local cache not present: no comparison of the demo payload with it.');
}

const CLOCK_LAPS = [31, 32, 33, 34, 35, 36, 37, 38];
const clocks = new Map(CLOCK_LAPS.map((L) => [L, seekClock(L)]));
out('');
out('A2. Lap-seek clocks (the right-arrow key, a lap click on the expanded timeline or Ctrl+K "Jump to Lap" all land here):');
out('    L   demo frame  session t   lap-mode t  demo-lap(s)  full frame  full-lap(s)  causalKey(demo) = lap mode / full; features = lap mode / full; seed');
for (const L of CLOCK_LAPS) {
  const c = clocks.get(L);
  const lapNow = lapModeNow(L);
  const kDemo = causalKey(race.lapTimes, c.now, race.trackStatus);
  const kLap = causalKey(race.lapTimes, lapNow, race.trackStatus);
  const fDemo = JSON.stringify(featuresAt(L, c.now, c.drivers).driverFeatures);
  const fLap = JSON.stringify(featuresAt(L, lapNow, {}).driverFeatures);
  let fullText = '         -            -';
  let kFull = null;
  let fFull = null;
  if (fullFrames) {
    const cf = seekClock(L, fullFrames, fullMap);
    kFull = causalKey(race.lapTimes, cf.now, race.trackStatus);
    fFull = JSON.stringify(featuresAt(L, cf.now, cf.drivers).driverFeatures);
    fullText = `${String(cf.idx).padStart(10)}  ${(cf.now - lapNow).toFixed(3).padStart(11)}`;
  }
  const seed = jobAtClock(c)?.seed;
  out(`    ${L}  ${String(c.idx).padStart(10)}  ${c.now.toFixed(3)}  ${lapNow.toFixed(3)}  ${(c.now - lapNow).toFixed(3).padStart(11)}  ${fullText}  `
    + `${kDemo} ${kDemo === kLap ? '=' : '!='} lap ${kFull ? (kDemo === kFull ? '= full' : '!= full') : ''}; features ${fDemo === fLap ? '=' : '!='} lap${fFull ? (fDemo === fFull ? ' = full' : ' != full') : ''}; seed ${seed}`);
}
out('    Equal causalKey and features give the same seed and the same Monte Carlo runs: the numbers below hold in the full app and the demo alike.');

out('');
out('A3. How long the lap-seek readout holds when the replay plays on (demo frames): the first frame with another causalKey');
out('    (a lap completed or a pit entry / exit by any car: Race Prediction re-asks its projection while open; the Tyre Degradation');
out('    chart, the Strategy Timeline and the stop labels change with it). LEC\'s next lap completion is listed for the LEC readouts.');
for (const L of [33, 34, 35, 36, 37, 38]) {
  const c = clocks.get(L);
  const k0 = causalKey(race.lapTimes, c.now, race.trackStatus);
  let j = c.idx;
  while (j + 1 < demoFrames.length && causalKey(race.lapTimes, demoFrames[j + 1].t + race.offset, race.trackStatus) === k0) j++;
  const tChange = demoFrames[j + 1].t + race.offset;
  const next = clocks.get(L + 1) || seekClock(L + 1);
  const lapDur = next.now - c.now;
  const lec = lastCompleted(c.now, 'LEC');
  const lecNext = rowOf('LEC', lec + 1);
  const holdFrames = j - c.idx + 1;
  out(`    L${L}: readout holds ${(tChange - c.now).toFixed(1)} s (${holdFrames} demo frames) of the ${lapDur.toFixed(1)} s leader lap `
    + `(${(100 * (tChange - c.now) / lapDur).toFixed(1)} %); LEC has completed ${lec} laps, his lap ${lec + 1} ends ${(lecNext.Time - c.now).toFixed(1)} s after the clock.`);
}

// ── B. Race state at the clocks ───────────────────────────────────────────
out('');
out('B. RACE STATE AT THE CLOCKS (what the dashboard knows: features of the Race Prediction "now" column, stints and stops of the Strategy Timeline)');
for (const L of [33, 34, 35, 36]) {
  const c = clocks.get(L);
  const df = featuresAt(L, c.now, c.drivers).driverFeatures;
  out(`B1. currentLap ${L}: ${TOP.map((d) => {
    const f = df[d];
    return `${d} P${f.position} gap ${f1(f.gapToLeader)} s ${f.compoundName} age ${f.tyreLife} stint ${f.stintNumber} (laps done ${lastCompleted(c.now, d)})`;
  }).join(' | ')}`);
}
const nor32 = rowOf('NOR', 32);
out(`B2. NOR in-lap 32: pit entry at session ${f3(nor32.PitInTime)} s, i.e. ${(nor32.PitInTime - clocks.get(33).now).toFixed(1)} s after the currentLap 33 clock`
  + ` and ${(clocks.get(34).now - nor32.PitInTime).toFixed(1)} s before the currentLap 34 clock; pit exit (out-lap 33 PitOutTime) ${f3(rowOf('NOR', 33).PitOutTime)} s.`);
out('B3. Stops in progress at the clock (pit entry visible, out-lap not completed): features from the in-lap row against the out-lap\'s end');
for (const L of [33, 34, 35, 36, 37, 38]) {
  const c = clocks.get(L);
  const df = featuresAt(L, c.now, c.drivers).driverFeatures;
  const rows = [];
  for (const lt of race.lapTimes) {
    if (!isPitVisible(lt, c.now)) continue;
    const outLap = rowOf(lt.Driver, lt.LapNumber + 1);
    if (!outLap || isLapCompleted(outLap, c.now)) continue;
    const f = df[lt.Driver];
    if (!f) continue;
    const exit = pitOutSeconds(outLap);
    rows.push(`${lt.Driver} in-lap ${lt.LapNumber} (pit exit ${exit != null && exit <= c.now ? 'passed' : 'not yet'}): features P${f.position} gap ${f1(f.gapToLeader)} s; after the out-lap P${outLap.Position} gap ${f1(outLap.GapToLeader)} s`);
  }
  out(`    currentLap ${L}: ${rows.length ? rows.join(' | ') : 'none'}`);
}
out('B4. Strategy Timeline (stints = bars, stops = diamonds with their pit-loss label) for LEC, PIA, NOR, SAI:');
for (const L of [35, 36]) {
  const c = clocks.get(L);
  const bars = stintBars(deriveStints(race.lapTimes, { sessionNow: c.now, running: false }));
  const markers = pitStopMarkers(race.lapTimes, { sessionNow: c.now, sessionType: 'R' });
  out(`    currentLap ${L}: ${['LEC', 'PIA', 'NOR', 'SAI'].map((d) => {
    const st = bars.filter((b) => b.Driver === d).map((b) => `${b.Compound[0]} L${b.LapStart}-L${b.LapStart + b.StintLength - 1}${b.ongoing ? '(ongoing)' : ''}`).join(' ');
    const mk = markers.filter((m) => m.Driver === d).map((m) => `in-lap ${m.inLap} "${m.label}" (${m.source})`).join(', ');
    return `${d}: ${st}; stops ${mk || 'none'}`;
  }).join(' | ')}`);
}

// ── C. Tyre Degradation ───────────────────────────────────────────────────
out('');
out('C. TYRE DEGRADATION (driver = the focus; lap range = the click on the driver\'s ongoing hard bar of the Strategy Timeline,');
out('   [LapStart, LapStart + StintLength - 1]; banner = the brushed fit, NEXT PIT WINDOW = its undercut_window)');
function degBlock(L, drv, stintNumber = null) {
  const c = clocks.get(L);
  const bars = stintBars(deriveStints(race.lapTimes, { sessionNow: c.now, running: false }));
  const own = bars.filter((b) => b.Driver === drv);
  // the bar clicked: the stint given, else the driver's latest
  const hard = stintNumber != null ? own.find((b) => b.StintNumber === stintNumber) : own[own.length - 1];
  const range = [hard.LapStart, hard.LapStart + hard.StintLength - 1];
  const v = tyreDegradationView(race.lapTimes, drv, { sessionNow: c.now, lapRange: range });
  const se = Object.fromEntries(stintFits(race.lapTimes, { sessionNow: c.now, driver: drv, lapStart: range[0], lapEnd: range[1] })
    .map((f) => [f.stintNumber, f.slopeStdErr]));
  const chart = v.stints.map((s) => (s.fit
    ? `S${s.stintNumber} ${s.compound[0]}: ${sgn(s.fit.slope)} s/lap fuel-corr., raw ${sgn(s.fit.rawSlope)}, ${s.fit.n} laps (slope s.e. ${f3(se[s.stintNumber])}, not drawn)`
    : `S${s.stintNumber} ${s.compound[0]} no fit (${s.cleanCount} < 8 clean laps)`)).join('; ');
  const lapEndUsed = Math.min(range[1], lastCompleted(c.now, drv));
  const r = degradationResponse(race.lapTimes, [drv], range[0], lapEndUsed, c.now, 'R');
  const banner = r.slope != null
    ? `BRUSHED LAPS L${range[0]} - L${range[1]} · fitted L${range[0]} - L${lapEndUsed} · raw ${Math.round(r.slope * 1000)} ms/lap · fuel-corr.* ${Math.round(r.slope_fuel_corrected * 1000)} ms/lap`
    : `BRUSHED LAPS L${range[0]} - L${range[1]} · ${r.reason}`;
  const win = r.undercut_window ? `NEXT PIT WINDOW LAP ${r.undercut_window[0]} - ${r.undercut_window[1]}` : `no NEXT PIT WINDOW (reason, not displayed: ${r.optimal_pit_lap_reason})`;
  return { range, chart, banner, win, rangeApplied: v.rangeApplied, n: r.n };
}
for (const L of [33, 34, 35, 36]) {
  const b = degBlock(L, 'LEC');
  out(`C1. currentLap ${L} LEC, range L${b.range[0]}-L${b.range[1]} (chart restricted to it: ${b.rangeApplied ? 'yes, only the hard stint drawn' : 'no'}): chart ${b.chart}`);
  out(`    banner: ${b.banner}; ${b.win}`);
}
for (const L of [35, 36]) {
  // PIA: his ongoing hard stint; NOR: his completed hard stint (stint 2, L15-L32; his third set has 1-2 laps)
  for (const [d, sn] of [['PIA', null], ['NOR', 2]]) {
    const b = degBlock(L, d, sn);
    out(`C2. currentLap ${L} ${d} (focus ${d}), click on stint ${sn ?? 'latest'}, range L${b.range[0]}-L${b.range[1]}: chart ${b.chart}; banner: ${b.banner}; ${b.win}`);
  }
}
out(`    Fuel correction: a constant ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap added to every raw slope (an assumption, the chart's footnote).`);

// ── D. Lap model inputs ───────────────────────────────────────────────────
out('');
out('D. LAP MODEL INPUTS (Race Prediction header; the Circle of Doom "pit in k laps" tooltip; the degradation is not shown elsewhere)');
const projAtEntry = new Map(); // filled in E; header read from the projection's raceParams
for (const L of [33, 34, 35, 36]) {
  const c = clocks.get(L);
  const job = jobAtClock(c);
  const proj = runSimulationJob('project', job.params);
  projAtEntry.set(L, proj);
  const rp = proj.raceParams;
  const pl = pitLossDisplay(rp.pitLoss);
  const ln = rp.estimates?.lapNoise;
  const sc = rp.estimates?.safetyCar;
  out(`D1. currentLap ${L} header: "Pit loss: ${pl.value.toFixed(1)}s ${pl.isFallback ? 'fallback' : `median, race (P10-P90 ${pl.p10?.toFixed(1)}-${pl.p90?.toFixed(1)}s, n=${pl.n})`}"`
    + ` "Lap noise: ±${rp.lapNoise.toFixed(2)}s ${ln?.source} (n=${ln?.laps ?? 0} laps)" "SC rate: ${(rp.scRate * 100).toFixed(1)}%/lap ${sc?.source}${sc?.source === 'race' ? ` (${sc.episodes} ep.)` : ''}" seed ${job.seed}`);
  for (const comp of ['HARD', 'MEDIUM']) {
    const d = degradationFor(rp, comp);
    const prior = PRIORS.degradation[comp];
    out(`    lap model ${comp}: ${sgn(d.mean)} s/lap (${d.source}${d.source === 'race' ? `: ${d.n} fits of >= ${d.minFitLaps} clean laps, ${d.negativeCount} negative, plain median ${sgn(d.median)}` : ''}),`
      + ` combined with the cached races' mean ${sgn(prior.raceMean, 4)} (prior over ${PRIORS.races} races, ${prior.races} with ${comp} fits, ${CACHED_RACES.thisRace}); sampling sd ${f3(d.samplingSd)}`);
  }
  const fd = rp.estimates?.freshDelta;
  out(`    fresh-tyre delta ${sgn(rp.freshDelta)} s (${fd?.source}${fd?.source === 'race' ? `, ${fd.n} stints, raw median ${sgn(fd.raw)}${fd.clamped ? ', clamped to 0' : ''}` : ''}), on the first flying laps of a new set only`);
  // raceSimulation.js safetyCarEstimate: (prior episodes x w + race episodes) / (prior laps x w + race leader laps)
  const scPrior = sc?.prior || PRIORS.safetyCar;
  out(`    SC rate ${(rp.scRate * 100).toFixed(2)} %/lap = (${scPrior.episodesPerRace} x ${scPrior.weightRaces} + ${sc?.episodes}) / (${scPrior.lapsPerRace} x ${scPrior.weightRaces} + ${sc?.laps}):`
    + ` the prior (PRIORS.safetyCar: ${scPrior.episodesPerRace} SC/VSC episode per ${scPrior.lapsPerRace} leader laps over the PRIORS.races = ${PRIORS.races} cached races, ${CACHED_RACES.thisRace})`
    + ` with weight ${scPrior.weightRaces} race, and this race's ${sc?.episodes} episodes over its ${sc?.laps} leader laps completed; labelled "${sc?.source}" while the race has no episode`);
}
out(`    The cached races of the priors: docs/evidence/mc_benchmark.txt "${CACHED_RACES.line}"`);
// Circle of Doom tooltip, focus LEC, k = 1
for (const L of [35, 36]) {
  const c = clocks.get(L);
  // CircleOfDoom.jsx l.1015-1078: pit loss, circleState, the cars at the clock
  // (phaseAt), pitWindow / rejoinDistribution / pitInLaps with the component's
  // extractRaceParams; totalRaceLaps is null in a replay; the flag is green
  // (the race's only track-status event is AllClear, section A1)
  const est = estimatePitLoss(race.lapTimes, { sessionNow: c.now, sessionType: 'R' });
  const st = circleState(race.lapTimes, { sessionNow: c.now, dnfMap: race.dnfMap, isLiveMode: false });
  const ring = { ...st, sessionNow: c.now, cars: st.cars.map((car) => ({ ...car, ...phaseAt(car, c.now, st.refLap) })) };
  const opts = { totalLaps: undefined, trackFlag: '1' };
  const rp = extractRaceParams(race.lapTimes, [], race.trackStatus, L, {
    sessionNow: c.now, sessionTimeOffset: race.offset, sessionType: 'R', running: false, dnfMap: race.dnfMap,
  });
  const win = pitWindow('LEC', ring, est, opts);
  const dist = win.available ? rejoinDistribution('LEC', ring, est, opts) : null;
  const tbl = win.available ? pitInLaps('LEC', ring, est, rp, { ...opts, rivalsStop: false }) : null;
  const deg = tbl?.degradation;
  const dt = (d) => (d ? `${d.compound} ${sgn(d.mean)} s/lap (${d.source === 'race' ? `${d.n} stints` : 'prior'})` : '-');
  const fr = tbl?.freshDeltaInfo;
  const names = (list) => (list?.length ? list.map((x) => x.driver).join(', ') : 'none');
  // The pit-window rows are part of the hover tooltip of the focus car
  // (CircleOfDoom.jsx carTooltip); a click on the focus car would remove the focus
  out(`D2. currentLap ${L} Circle of Doom, LEC the focus, hover his car: "Pit now P${win.currentPosition} -> P${win.predictedPosition}"`
    + ` "Rejoin positions ${(dist?.positions || []).map((p) => `P${p.position} ${(p.probability * 100).toFixed(1)}%`).join(' · ')}"`
    + ` "Gain the place ${names(win.wouldPassFocus)}" "Within reach ${names(win.wouldDropBehindFocus)}"`);
  out(`    k = 1 (key ]): "Pit in 1: in-lap L${tbl?.rows?.[1]?.inLap}, rejoin P${tbl?.rows?.[1]?.predictedPosition} at the end of L${tbl?.rows?.[1]?.targetLap}" "Lap model ${dt(deg?.current)} → ${dt(deg?.next)}"`
    + ` "Fresh-tyre delta ${fr ? `${sgn(fr.value)} s on the first flying lap (${fr.source === 'race' ? `${fr.n} stints` : 'prior'})` : '-'}"`);
}

// ── E. Race Prediction rows ───────────────────────────────────────────────
out('');
out('E. RACE PREDICTION, Projections tab (P label = median position, held within the Monte Carlo error: it depends on the path)');
// A row as ProjectionTable draws it: P label (gold when P1-P3), the +/- cell
// (placesMark), now P, the podium share (gold when its badge is on), and from
// the chart: the P5-P95 range, the P1 bar's tooltip share; expected = the P
// label's tooltip
const rowText = (proj, d) => {
  const p = proj.projections.find((x) => x.driver === d);
  const shown = modePosition(proj, p);
  const ch = positionChange(proj, p) ?? 0;
  const mark = placesMark(ch);
  const podGold = proj.badges?.podium?.[d] ? ' (gold)' : '';
  return `${d} P${shown}${shown <= 3 ? ' (gold)' : ''} ${ch !== 0 ? `${mark.glyph}${Math.abs(ch)}` : mark.glyph} now P${p.currentPos} ${p.podiumProb}% pod${podGold},`
    + ` P5-P95 P${p.posRange[0]}-P${p.posRange[1]}, expected ${p.expectedPos}, P1 bar ${pct1(shareAtMost(p, 1))}`;
};
// (d) no previous state: a jump to L from a clock with no projection (Home, then Jump to Lap)
const noPrev = new Map();
for (const L of [33, 34, 35, 36, 37, 38]) {
  const job = jobAtClock(clocks.get(L));
  noPrev.set(L, { job, proj: project(job, null) });
}
// (a) / (b): entry by a jump at E, then the right-arrow key lap by lap, each projection settled
function arrowPath(entry, last, { stale = false } = {}) {
  const res = new Map();
  let prev = null;
  let prevFeats = null;
  for (let L = entry; L <= last; L++) {
    const c = clocks.get(L);
    const feats = featuresAt(L, c.now, c.drivers);
    if (stale && prevFeats) {
      // The panel asks for a projection on the lap change, before the race
      // situation of the new lap is computed (CLOCK_JUMP_SETTLE_MS = 120 ms
      // later): previous lap's features, the new lap's clock and seed
      const sj = jobAt(L, c.now, prevFeats);
      const sp = project(sj, prev);
      prev = sp.badges;
    }
    const job = jobAt(L, c.now, feats);
    const proj = project(job, prev);
    res.set(L, proj);
    prev = proj.badges;
    prevFeats = feats;
  }
  return res;
}
// (c): a replay played from lap 5, the store's once-per-lap recompute at each lap's first frame
function playedPath(last) {
  const res = new Map();
  let prev = null;
  for (let L = 5; L <= last; L++) {
    const c = seekClock(L);
    const job = jobAtClock(c);
    if (!job) continue;
    const proj = project(job, prev);
    res.set(L, proj);
    prev = proj.badges;
  }
  return res;
}
const pathA = arrowPath(33, 38);
const pathB = arrowPath(33, 38, { stale: true });
const pathE = arrowPath(35, 38);
const pathC = playedPath(38);
out('E1. Rows with no previous state (Home, then Ctrl+K "Jump to Lap" L). The shares, ranges and expected positions are the same');
out('    on every path (the seed depends on the clock only); the P label, its +/- cell and the gold marks are held within the');
out('    Monte Carlo error and can differ by path (E2).');
for (const L of [33, 34, 35, 36, 37, 38]) {
  out(`    currentLap ${L} (${noPrev.get(L).proj.numSimulations} runs, seed ${noPrev.get(L).job.seed}): ${['LEC', 'PIA', 'SAI', 'HAM', 'NOR'].map((d) => rowText(noPrev.get(L).proj, d)).join(' | ')}`);
}
out('E2. P labels by path, LEC / PIA / SAI / HAM / NOR (* = podium share in gold):');
const labels = (proj) => ['LEC', 'PIA', 'SAI', 'HAM', 'NOR'].map((d) => `P${modePosition(proj, proj.projections.find((x) => x.driver === d))}${proj.badges?.podium?.[d] ? '*' : ''}`).join('/');
for (const L of [33, 34, 35, 36, 37, 38]) {
  out(`    L${L}: no previous state ${labels(noPrev.get(L).proj)}; jump to 33 then arrows ${labels(pathA.get(L))}; same with the stale run shown ${labels(pathB.get(L))}`
    + `${pathE.get(L) ? `; jump to 35 then arrows ${labels(pathE.get(L))}` : ''}; played from lap 5 ${labels(pathC.get(L))}`);
}
out('    (arrows: each right-arrow press waited for, so every lap\'s projection is computed and held; stale run: right after the');
out('    arrow key the open panel asks for the new lap with the previous lap\'s features, and when that run returns within the');
out('    120 ms before the race situation is recomputed it is shown and its labels are the ones held next; played from lap 5:');
out('    the store\'s once-per-lap recompute at each lap\'s first frame, panel closed.)');

// ── F. Strategy Simulator, LEC ────────────────────────────────────────────
out('');
out('F. STRATEGY SIMULATOR, LEC (focus LEC; Copy Actual -> Run -> Save for Compare; Compare tab "vs" on it; Plan tab: + Pit Stop,');
out('   S2 length, S3 compound and length -> Run). Plan stops from the lap in progress on; the saved plan is the baseline.');
const SAVED_LEC = stintsOf([['MEDIUM', 15], ['HARD', 38]]);
const mainWhatIf = new Map();
{
  // StrategySimulator addStint (l.117-122) after Copy Actual, and the Plan tab's lines (l.273, l.291-308)
  const copied = copyActual(clocks.get(35).now, 'LEC');
  const used = copied.reduce((s, st) => s + st.length, 0);
  const added = normalizeStints([...copied, { compound: 'MEDIUM', length: Math.max(5, race.maxLap - used) }]);
  const total = added.reduce((s, st) => s + st.length, 0);
  out(`F0. Plan tab after Copy Actual (${planLabel(copied)}) and "+ Pit Stop": ${planLabel(added)}, "Custom Strategy (${added.length - 1} stops)",`
    + ` "Strategy covers ${total} laps (+${total - race.maxLap} vs race length ${race.maxLap})" until S2 is shortened; S3 starts at L${added[2].lapStart}.`);
  for (const L of [35, 36]) {
    const plan = stintsOf([['MEDIUM', 15], ['HARD', L - 15], ['HARD', 53 - L]]);
    const stops = planFromStints(plan);
    const future = stops.filter((s) => s.lap >= L && s.lap < race.maxLap);
    out(`    at currentLap ${L}, S2 ${L - 15}L and S3 HARD ${53 - L}L (S3 from L${plan[2].lapStart}): "From L${L}: ${future.map((s) => `in-lap ${s.lap} → ${s.compound}`).join(', ')}`
      + ` · ${stops.length - future.length} earlier stop = race history"`);
  }
}
for (const L of [33, 34, 35, 36]) {
  const c = clocks.get(L);
  const job = jobAtClock(c);
  const actual = copyActual(c.now, 'LEC');
  const panelMode = noPrev.get(L).proj.badges.mode;
  out(`F1. currentLap ${L}: Copy Actual = ${planLabel(actual)} (seed ${job.seed})`);
  const same = whatIf(job, 'LEC', actual, null, { panelMode });
  out(`  Copy Actual vs model stops (first Run): ${describeWhatIf(same, planLabel(actual), 'model stops')[2].trim()}`);
  const variants = [
    [`second stop in-lap ${L}, HARD`, [['MEDIUM', 15], ['HARD', L - 15], ['HARD', 53 - L]]],
    [`second stop in-lap ${L + 2}, HARD`, [['MEDIUM', 15], ['HARD', L + 2 - 15], ['HARD', 53 - L - 2]]],
    [`second stop in-lap ${L}, MEDIUM`, [['MEDIUM', 15], ['HARD', L - 15], ['MEDIUM', 53 - L]]],
  ];
  for (const [title, list] of variants) {
    const plan = stintsOf(list);
    const w = whatIf(job, 'LEC', plan, SAVED_LEC);
    if (title.startsWith(`second stop in-lap ${L}, HARD`)) mainWhatIf.set(L, { w, plan, job });
    out(`  ${title}: plan ${planLabel(plan)} (stops ${w.plan.map((s) => `in-lap ${s.lap} ${s.compound}`).join(', ')}) vs saved ${planLabel(SAVED_LEC)}`);
    for (const l of describeWhatIf(w, planLabel(plan), planLabel(SAVED_LEC))) out(l);
  }
}
// The plan of lap L re-run by the store after the right-arrow key (simulator active): its stop is now behind the clock
for (const L of [35]) {
  const prevRun = mainWhatIf.get(L);
  const c = clocks.get(L + 1);
  const job = jobAtClock(c);
  const w = whatIf(job, 'LEC', prevRun.plan, SAVED_LEC, { held: prevRun.w.marks });
  out(`F2. Right-arrow from ${L} to ${L + 1} with the in-lap ${L} plan still set: the store re-runs it at the new clock (stop at in-lap ${L} < currentLap ${L + 1} is dropped by the engine):`);
  for (const l of describeWhatIf(w, planLabel(prevRun.plan), planLabel(SAVED_LEC))) out(l);
}
// The full app's lap-seek frame gives the same what-if (same causalKey, features, seed)
if (fullFrames) {
  for (const L of [35, 36]) {
    const cf = seekClock(L, fullFrames, fullMap);
    const jf = jobAtClock(cf);
    const wf = whatIf(jf, 'LEC', mainWhatIf.get(L).plan, SAVED_LEC);
    const a = describeWhatIf(wf, '', '').join('|');
    const b = describeWhatIf(mainWhatIf.get(L).w, '', '').join('|');
    out(`F3. currentLap ${L} at the full app's lap-seek frame (session ${cf.now.toFixed(3)} s): seed ${jf.seed === mainWhatIf.get(L).job.seed ? 'same' : 'DIFFERENT'}, result ${a === b ? 'identical' : 'DIFFERENT'} to the demo frame's.`);
  }
}

// ── G. Counterpart: McLaren's second stops ────────────────────────────────
out('');
out('G. COUNTERPART: THE SAME SIMULATOR ON McLAREN\'S SECOND STOPS (focus PIA / NOR; Copy Actual saved, the actual two-stop as the plan)');
for (const L of [36, 37, 38]) {
  const c = clocks.get(L);
  const job = jobAtClock(c);
  const actual = copyActual(c.now, 'PIA');
  const plan = stintsOf([['MEDIUM', 16], ['HARD', 22], ['HARD', 15]]);
  const w = whatIf(job, 'PIA', plan, actual);
  out(`G1. currentLap ${L} PIA: plan ${planLabel(plan)} (stop in-lap 38 HARD, the actual) vs saved Copy Actual ${planLabel(actual)}`);
  for (const l of describeWhatIf(w, planLabel(plan), planLabel(actual))) out(l);
}
for (const L of [31, 32]) {
  const c = clocks.get(L);
  const job = jobAtClock(c);
  const actual = copyActual(c.now, 'NOR');
  const plan = stintsOf([['MEDIUM', 14], ['HARD', 18], ['HARD', 21]]);
  const w = whatIf(job, 'NOR', plan, actual);
  out(`G2. currentLap ${L} NOR: plan ${planLabel(plan)} (stop in-lap 32 HARD, the actual) vs saved Copy Actual ${planLabel(actual)}`);
  for (const l of describeWhatIf(w, planLabel(plan), planLabel(actual))) out(l);
}

// ── H. Fresh-tyre gain: lap model vs measured ─────────────────────────────
out('');
out('H. FRESH-HARD GAIN: THE LAP MODEL AGAINST WHAT WAS MEASURED AFTERWARDS (not displayed by any view; hindsight)');
out('   Lap model (raceSimulation.js projectedLapTime): against a car that keeps an older set of the same compound, a new set gains');
out('   deg x (age gap) per lap, deg = the lap model\'s rate at the decision clock (section D), plus the fresh-tyre delta once.');
out('   Measured: (target - chaser) on laps both ran clean (degradation.js isCleanLap) after the stop (from the chaser\'s in-lap + 2)');
out('   minus the same difference over the last 5 such laps before it (difference in differences: the base pace gap cancels).');
const gains = [];
function freshPair(chaser, target, inLap) {
  const c = clocks.get(inLap);
  const rp = extractRaceParams(race.lapTimes, [], race.trackStatus, inLap, { sessionNow: c.now, sessionType: 'R', running: false, dnfMap: race.dnfMap });
  const deg = degradationFor(rp, 'HARD');
  const first = inLap + 2;
  const gap = Number(rowOf(target, first).TyreLife) - Number(rowOf(chaser, first).TyreLife);
  const model = deg.mean * gap;
  const diffs = (from, to) => {
    const d = [];
    for (let l = from; l <= to; l++) {
      const a = rowOf(chaser, l);
      const b = rowOf(target, l);
      if (a && b && isCleanLap(a) && isCleanLap(b)) d.push(b.LapTimeSeconds - a.LapTimeSeconds);
    }
    return d;
  };
  const before = diffs(1, inLap - 1).slice(-5);
  const after = diffs(first, race.maxLap);
  const measured = mean(after) - mean(before);
  gains.push({ chaser, target, inLap, gap, model, measured, deg });
  out(`H1. ${chaser} (new HARD at the end of lap ${inLap}) vs ${target} (older HARD), clock currentLap ${inLap}: lap model HARD ${sgn(deg.mean)} s/lap (${deg.n} fits), `
    + `fresh-tyre delta ${sgn(rp.freshDelta)} s; ages on lap ${first}: ${chaser} ${rowOf(chaser, first).TyreLife}, ${target} ${rowOf(target, first).TyreLife} (gap ${gap} laps)`);
  out(`    modelled gain ${sgn(model)} s/lap; measured: before (last ${before.length} clean pairs) ${sgn(mean(before))} s/lap, after (${after.length} clean pairs from L${first}) ${sgn(mean(after))} s/lap`
    + ` -> gain ${sgn(measured)} s/lap; modelled / measured ${(model / measured).toFixed(2)}`);
}
freshPair('NOR', 'LEC', 32);
freshPair('PIA', 'LEC', 38);
out('H2. Rough time balance of a second LEC stop (hindsight arithmetic, not a dashboard readout): new hards from the in-lap + 2 to the flag,');
out('    the gain per lap against LEC\'s own set (lap model: deg x age gap; measured: the range of H1, whose age gaps bracket LEC\'s),');
out('    against the header pit loss at the clock (in-lap + out-lap minus twice the green median, so the stop\'s whole cost).');
const gMin = Math.min(...gains.map((g) => g.measured));
const gMax = Math.max(...gains.map((g) => g.measured));
for (const L of [35, 36]) {
  const first = L + 2;
  const laps = race.maxLap - first + 1;
  const oldAge = Number(rowOf('LEC', first).TyreLife);
  const gap = oldAge - 2;
  const rp = projAtEntry.get(L).raceParams;
  const deg = degradationFor(rp, 'HARD');
  const loss = pitLossDisplay(rp.pitLoss).value;
  const modelled = deg.mean * gap * laps + rp.freshDelta;
  out(`    in-lap ${L} (clock ${L}): ${laps} laps on new hards from L${first}, LEC's set would be ${oldAge} laps old on L${first} (gap ${gap});`
    + ` modelled gain ${sgn(deg.mean)} x ${gap} x ${laps} = ${f1(modelled)} s; at the measured ${gMin.toFixed(2)}-${gMax.toFixed(2)} s/lap: ${f1(gMin * laps)}-${f1(gMax * laps)} s;`
    + ` pit loss ${loss.toFixed(1)} s; balance ${sgn(modelled - loss, 1)} s (model), ${sgn(gMin * laps - loss, 1)} to ${sgn(gMax * laps - loss, 1)} s (measured gain)`);
}

// ── I. Within-lap drift ───────────────────────────────────────────────────
out('');
out('I. A RUN LATER IN THE LAP (paused mid-lap, or Run while playing): the race situation stays the lap\'s first frame\'s, the job takes');
out('   the frame\'s clock and seed (store simulationJob). The second-stop what-if (in-lap L, HARD, vs saved M15-H38):');
out('   Every demo frame of the lap at which the knowledge state (causalKey) changes, from the lap-seek frame (+0.0 s) on: the');
out('   job\'s clock and seed change only there, so a Run at any other frame repeats the result of the last clock listed before it.');
for (const L of [35, 36]) {
  const c = clocks.get(L);
  const feats = featuresAt(L, c.now, c.drivers);
  const parts = [];
  const res = [];
  let key = null;
  for (let i = c.idx; i < demoMap[L + 1]; i++) {
    const now = demoFrames[i].t + race.offset;
    const k = causalKey(race.lapTimes, now, race.trackStatus);
    if (k === key) continue;
    key = k;
    const job = jobAt(L, now, feats);
    const w = whatIf(job, 'LEC', mainWhatIf.get(L).plan, SAVED_LEC);
    const iv = pairedInterval(w.res.paired.position);
    const r = {
      dt: now - c.now, m: w.res.paired.position.mean, half: (iv[1] - iv[0]) / 2,
      pod: 100 * w.res.paired.podium.mean, custom: w.marks.shown.custom, base: w.marks.shown.baseline,
    };
    res.push(r);
    parts.push(`+${r.dt.toFixed(1)} s ${sgn(r.m, 1)} ±${r.half.toFixed(2)} pod ${sgn(r.pod, 0)}% P${r.custom}/P${r.base}`);
  }
  const shown = res.map((r) => Number(r.m.toFixed(1)));
  const pods = res.map((r) => Math.round(r.pod));
  const lapDur = clocks.get(L + 1).now - c.now;
  const atMin = res.filter((r) => Number(r.m.toFixed(1)) === Math.min(...shown)).map((r) => `+${r.dt.toFixed(1)} s`).join(', ');
  out(`I1. currentLap ${L} (leader lap ${lapDur.toFixed(1)} s): ${res.length} clocks; places ${sgn(Math.max(...shown), 1)} to ${sgn(Math.min(...shown), 1)}`
    + ` (${sgn(Math.min(...shown), 1)} at ${atMin}); podium ${sgn(Math.max(...pods), 0)}% to ${sgn(Math.min(...pods), 0)}%;`
    + ` cards P${Math.min(...res.map((r) => r.custom))}-P${Math.max(...res.map((r) => r.custom))} vs P${Math.min(...res.map((r) => r.base))}-P${Math.max(...res.map((r) => r.base))}`);
  out(`    ${parts.join(' | ')}`);
}

// ── J. Outcome ────────────────────────────────────────────────────────────
out('');
out('J. OUTCOME (lap rows and results after the clocks; never an input above)');
const res = [...race.results].sort((a, b) => (a.Position ?? 99) - (b.Position ?? 99));
const stratText = (d) => (stintsByDriver(race.lapTimes, { sessionNow: Infinity })[d] || []).map((s) => `${s.Compound[0]} L${s.StartLap}-${s.EndLap}`).join(' > ');
for (const r of res.slice(0, 6)) {
  out(`J1. P${r.Position} ${r.Abbreviation} ${stratText(r.Abbreviation)}  ${r.Position === 1 ? `race time ${f3(r.Time)} s` : `+${f3(r.Time)} s to the winner`}`);
}
out('J2. Order and gap to the leader (s) at the end of each lap; P = in-lap, O = out-lap:');
for (let lap = 32; lap <= 53; lap++) {
  out(`    L${lap} ${['LEC', 'PIA', 'NOR', 'SAI', 'HAM'].map((d) => {
    const lt = rowOf(d, lap);
    const tag = lt.PitInTime != null ? 'P' : lt.PitOutTime != null ? 'O' : ' ';
    return `${d} P${lt.Position} ${f1(Number(lt.GapToLeader ?? 0)).padStart(5)}${tag} ${f3(lt.LapTimeSeconds)}`;
  }).join(' | ')}`);
}
const lead = [];
for (let lap = 33; lap <= 53; lap++) if (rowOf('LEC', lap).Position === 1) lead.push(lap);
out(`J3. LEC P1 at the end of laps ${lead[0]}-${lead[lead.length - 1]} (${lead.length} laps); PIA's in-lap 38 pit entry ${f3(rowOf('PIA', 38).PitInTime)} s.`);
const after = [];
for (let l = 40; l <= 53; l++) {
  const a = rowOf('PIA', l);
  const b = rowOf('LEC', l);
  if (isCleanLap(a) && isCleanLap(b)) after.push(b.LapTimeSeconds - a.LapTimeSeconds);
}
out(`J4. PIA's gap to LEC: ${f1(rowOf('PIA', 39).GapToLeader)} s at the end of lap 39, ${f3(Number(res[1].Time))} s at the flag; PIA faster than LEC by ${f3(mean(after))} s/lap on average over the ${after.length} laps 40-53 both ran clean.`);
out(`J5. Stop counts of the top six (tyre changes): ${res.slice(0, 6).map((r) => `${r.Abbreviation} ${(stintsByDriver(race.lapTimes, { sessionNow: Infinity })[r.Abbreviation] || []).length - 1}`).join(', ')}.`);

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
console.error(`\nwrote ${path.relative(process.cwd(), OUT_FILE)}`);
