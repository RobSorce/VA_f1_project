/**
 * Backtest of the Circle of Doom rejoin prediction (src/utils/circleOfDoom.js)
 * on every cached race, against backend/scripts/validate_pit_loss_and_rejoin.py.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/cod_backtest.mjs
 * Writes notes/experiments/cod_backtest.txt and prints the same text.
 *
 * Stops: every green stop as defined by the validation script (green_stops):
 * in-lap n with a pit entry, out-lap n + 1 with a pit exit, laps n - 1, n,
 * n + 1 green, loss = lap n + lap n + 1 - 2 x the driver's green median in
 * (10, 60) s, Time set on laps n - 1 and n + 1. pitLoss.estimatePitLoss over
 * the whole race returns exactly these stops as its samples (pitLoss.test.js
 * checks the per-race medians against the script); the Time filter is added here.
 *
 * Truth (same as the script): actual position = 1 + the other cars whose
 * lap n + 1 Time is earlier than the driver's (cars with a lap n + 1 Time).
 *
 * Predictions:
 *  script : the script's causal_fixed prediction, recomputed with the module's
 *           rank rule (rankByCrossing): T_pred = Time(n - 1) + 2 x full-race
 *           green median + median loss of the stops with out-lap < n (22 s
 *           before the first), ranked against the other cars' ACTUAL lap n + 1
 *           Times. Must give the script's 709 stops / 71 % / 88 %.
 *  module : circleOfDoom.pitWindow at sessionNow = Time(n - 1) (the end of
 *           the lap before the in-lap: the script's information set), pit
 *           loss = estimatePitLoss at that sessionNow. Fully causal: the focus
 *           pace and the pit loss come from laps completed by then, and the
 *           other cars' lap n + 1 crossings are projected (their own recent
 *           pace) unless already completed.
 * Every stop where module != script is explained by swapping one ingredient
 * at a time:
 *   loss   : script, with the module's causal pit loss;
 *   pace   : + the module's causal focus pace (recent pace instead of the
 *            full-race green median);
 *   others : + projected crossings of the other cars (= module). For this step
 *            each car that changes side is named with the reason: its own stop
 *            on laps n..n + 1 (not known at sessionNow), a retirement before
 *            lap n + 1, a stop in progress at sessionNow (pending loss), or the
 *            pace projection error in seconds.
 * A stop taken right after another one (lap n - 1 is itself an in-lap) finds
 * the focus on an out-lap at sessionNow: the module projects that stop in
 * progress, and the stop-by-stop list says so.
 * Also: accuracy on the stops where no unseen rival stop (or later
 * retirement) puts a rival on the other side, pace-model sensitivity (recent /
 * race-median / reference) and the calibration of rejoinDistribution (1000
 * seeded draws per stop).
 * "Pit in k laps" (utils/undercut.js pitInLaps, race params = extractRaceParams
 * at the same clock): k = 0 against pitWindow at the end of lap n - 1 on every
 * stop; then the same stop predicted k laps ahead, at the end of the driver's
 * lap n - 1 - k (row k: in-lap n, rejoin at the end of lap n + 1), with the lap
 * model and with a flat one (no wear, no fresh-tyre delta: the window's
 * constant paces carried on), against the same actual position.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  circleState, pitWindow, rankByCrossing, rejoinDistribution,
} from '../src/utils/circleOfDoom.js';
import { estimatePitLoss, driverGreenMedians } from '../src/utils/pitLoss.js';
import { extractRaceParams } from '../src/utils/raceSimulation.js';
import { pitInLaps } from '../src/utils/undercut.js';
import { hasPitIn, hasPitOut } from '../src/utils/raceTime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../../backend/data/processed_cache');
const OUT_FILE = path.resolve(HERE, '../../notes/experiments/cod_backtest.txt');
const FALLBACK = 22.0; // the script's FALLBACK

const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : 'n/a');
const median = (v) => {
  const a = [...v].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function loadRace(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = JSON.parse(raw.replace(/\bNaN\b/g, 'null'));
  }
  return data.lap_times;
}

function index(lapTimes) {
  const by = new Map();
  for (const r of lapTimes) {
    if (!by.has(r.Driver)) by.set(r.Driver, new Map());
    by.get(r.Driver).set(Number(r.LapNumber), r);
  }
  return by;
}

const races = fs.readdirSync(CACHE_DIR)
  .map((f) => /^session_(\d{4})_(\d+)_R\.json$/.exec(f))
  .filter(Boolean)
  .map((m) => ({ name: `${m[1]}_${m[2]}`, file: path.join(CACHE_DIR, m[0]) }))
  .sort((a, b) => (a.name < b.name ? -1 : 1)); // the script's sorted(glob) order

const totals = {
  script: [], module: [], loss: [], pace: [], recent: [], 'race-median': [], reference: [],
  subsetScript: [], subsetModule: [], relevantScript: [], relevantModule: [],
};
const projErr = [];
const perRace = [];
const diffs = [];
const flipReasons = { stop: 0, retired: 0, pending: 0, pace: 0 };
const calib = {
  pActual: [], modal: 0, cover80: 0, n: 0, trafficFlag: 0, subN: 0, subPActual: [], subModal: 0, subCover80: 0,
};
let identityChecks = 0;
let ongoingStops = 0;
let identityFails = 0;
// Pit in k laps: k = 0 identity, and the stop predicted k laps ahead
const K_AHEAD = [1, 2, 3, 5];
const pitIn = { k0: 0, k0Same: 0, ahead: Object.fromEntries(K_AHEAD.map((k) => [k, { model: [], flat: [] }])) };
const FLAT_DEG = {
  mean: 0, median: 0, stdDev: 0, n: 1, negativeCount: 0, source: 'race',
};
/** Race params without wear or fresh-tyre delta: the window's constant paces carried on. */
const flatParams = (rp) => ({
  ...rp,
  freshDelta: 0,
  tyreDeg: Object.fromEntries(['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET', 'UNKNOWN'].map((c) => [c, FLAT_DEG])),
});

for (const race of races) {
  const lapTimes = loadRace(race.file);
  const by = index(lapTimes);
  const med = driverGreenMedians(lapTimes);
  const all = estimatePitLoss(lapTimes).samples;
  const stops = all.filter((s) => {
    const laps = by.get(s.driver);
    return laps.get(s.inLap - 1)?.Time && laps.get(s.inLap + 1)?.Time;
  });
  if (!stops.length) continue;
  const raceRes = { name: race.name, n: stops.length, script: [], module: [] };

  for (const s of stops) {
    const n = s.inLap;
    const drv = s.driver;
    const laps = by.get(drv);
    const tPrev = laps.get(n - 1).Time;
    const tAct = laps.get(n + 1).Time;
    const others = [];
    for (const [x, xl] of by) {
      if (x === drv) continue;
      const r = xl.get(n + 1);
      if (r && r.Time) others.push({ driver: x, t: r.Time });
    }
    const otherTimes = others.map((o) => o.t);
    const pAct = rankByCrossing(tAct, otherTimes);

    // script: causal_fixed
    const prev = all.filter((x) => x.inLap + 1 < n).map((x) => x.loss);
    const lossScript = prev.length ? median(prev) : FALLBACK;
    const tScript = tPrev + 2 * med[drv] + lossScript;
    const pScript = rankByCrossing(tScript, otherTimes);

    // module at the end of lap n - 1
    const now = tPrev;
    const state = circleState(lapTimes, { sessionNow: now });
    const est = estimatePitLoss(lapTimes, { sessionNow: now });
    const w = pitWindow(drv, state, est);
    if (!w.available) throw new Error(`${race.name} ${drv} L${n}: window unavailable (${w.reason})`);
    // A stop right after another one (lap n - 1 is itself an in-lap): at the
    // end of lap n - 1 the car is on the out-lap of the first stop, so the
    // module projects that stop in progress (target lap n), not a new one
    const ongoing = w.ongoingStop ? `focus on the out-lap of a stop on L${n - 1} at sessionNow: `
      + `the module projects that stop (target L${w.targetLap}), the second stop on L${n} is not known yet` : null;
    const pModule = w.predictedPosition;

    // ingredient swaps
    const pLoss = rankByCrossing(tPrev + 2 * med[drv] + est.median, otherTimes);
    const tPace = tPrev + 2 * w.pace + est.median;
    if (!ongoing) {
      identityChecks += 1;
      if (Math.abs(tPace - w.predictedCrossing) > 1e-6) identityFails += 1;
    }
    const pPace = rankByCrossing(tPace, otherTimes);

    // Pit in k laps: k = 0 is this window
    if (!ongoing) {
      const pk = pitInLaps(drv, state, est, extractRaceParams(lapTimes, [], [], 1, { sessionNow: now, sessionType: 'R' }), { maxK: 0 });
      pitIn.k0 += 1;
      const r0 = pk.rows[0];
      if (r0 && r0.predictedPosition === w.predictedPosition && r0.predictedCrossing === w.predictedCrossing
        && r0.ghostOffset === w.rejoinOffset) pitIn.k0Same += 1;
      // the same stop predicted k laps ahead (end of the driver's lap n - 1 - k)
      for (const k of K_AHEAD) {
        const tK = laps.get(n - 1 - k)?.Time;
        if (!tK) continue;
        const stK = circleState(lapTimes, { sessionNow: tK });
        const estK = estimatePitLoss(lapTimes, { sessionNow: tK });
        const rpK = extractRaceParams(lapTimes, [], [], 1, { sessionNow: tK, sessionType: 'R' });
        const a = pitInLaps(drv, stK, estK, rpK, { maxK: k });
        if (!a.available || a.ongoingStop || a.kMax < k || a.rows[k].inLap !== n) continue;
        const b = pitInLaps(drv, stK, estK, flatParams(rpK), { maxK: k });
        pitIn.ahead[k].model.push(a.rows[k].predictedPosition - pAct);
        pitIn.ahead[k].flat.push(b.rows[k].predictedPosition - pAct);
      }
    }

    for (const model of ['recent', 'race-median', 'reference']) {
      const wm = model === 'recent' ? w : pitWindow(drv, state, est, { paceModel: model });
      totals[model].push(wm.predictedPosition - pAct);
    }

    // Rivals with a stop not visible at sessionNow on laps up to n + 1, and the
    // projection error of the other rivals (projected, no stop, still running)
    let unseen = 0;
    for (const rc of w.rivalCrossings) {
      const c = state.cars.find((x) => x.driver === rc.driver);
      const xl = by.get(rc.driver);
      const actual = others.find((o) => o.driver === rc.driver);
      if (stopBetween(xl, c.lapsCompleted + 1, n + 1, now)) unseen += 1;
      else if (rc.projected && !rc.stage && actual) projErr.push(rc.time - actual.t);
    }
    const subset = unseen === 0 && !ongoing;
    if (subset) {
      totals.subsetScript.push(pScript - pAct);
      totals.subsetModule.push(pModule - pAct);
    }
    const flips = ongoing ? [] : rivalFlips(w, state, others, by, n, now);
    const unseenFlip = flips.some((f) => f.reason === 'stop' || f.reason === 'retired');
    if (!ongoing && !unseenFlip) {
      totals.relevantScript.push(pScript - pAct);
      totals.relevantModule.push(pModule - pAct);
    }

    totals.script.push(pScript - pAct);
    totals.module.push(pModule - pAct);
    totals.loss.push(pLoss - pAct);
    totals.pace.push(pPace - pAct);
    raceRes.script.push(pScript - pAct);
    raceRes.module.push(pModule - pAct);

    // calibration of the probabilities
    const dist = rejoinDistribution(drv, state, est, { seed: 1 });
    const probs = new Map(dist.positions.map((p) => [p.position, p.probability]));
    calib.n += 1;
    calib.pActual.push(probs.get(pAct) || 0);
    const modal = dist.positions.reduce((a, b) => (b.probability > a.probability ? b : a));
    if (modal.position === pAct) calib.modal += 1;
    const ranked = [...dist.positions].sort((a, b) => b.probability - a.probability);
    let acc = 0;
    const set = new Set();
    for (const p of ranked) {
      if (acc >= 0.8) break;
      set.add(p.position);
      acc += p.probability;
    }
    if (set.has(pAct)) calib.cover80 += 1;
    if (subset) {
      calib.subN += 1;
      calib.subPActual.push(probs.get(pAct) || 0);
      if (modal.position === pAct) calib.subModal += 1;
      if (set.has(pAct)) calib.subCover80 += 1;
    }
    if (w.traffic.flag) calib.trafficFlag += 1;

    if (ongoing) ongoingStops += 1;
    if (pModule === pScript) continue;
    // Explain: which step moved the prediction, and the cars that changed side
    const steps = [];
    if (pLoss !== pScript) steps.push(`loss ${lossScript.toFixed(1)}->${est.median.toFixed(1)}s (${est.source}, n=${est.n}): P${pScript}->P${pLoss}`);
    if (pPace !== pLoss) steps.push(`pace ${med[drv].toFixed(2)}->${w.pace.toFixed(2)}s/lap: P${pLoss}->P${pPace}`);
    if (ongoing) {
      steps.push(ongoing);
    } else if (pModule !== pPace) {
      for (const f of flips) flipReasons[f.reason] += 1;
      steps.push(`others: P${pPace}->P${pModule}: ${flips.map((f) => f.text).join('; ')}`);
    }
    diffs.push(`${race.name.padEnd(8)} ${drv} L${String(n).padEnd(3)} actual P${pAct}  script P${pScript}  module P${pModule}  | ${steps.join(' | ')}`);
  }
  perRace.push(raceRes);
}

/**
 * Rivals on the other side of the focus's predicted crossing in the module
 * (projected crossings) than in the script (actual lap n + 1 crossings), with
 * the reason (module header). The predicted crossing is the same in both
 * (identity check).
 */
function rivalFlips(w, state, others, by, n, now) {
  const out = [];
  for (const rc of w.rivalCrossings) {
    const c = state.cars.find((x) => x.driver === rc.driver);
    const actual = others.find((o) => o.driver === rc.driver);
    const aheadActual = actual ? actual.t < w.predictedCrossing : false;
    const aheadProj = rc.time < w.predictedCrossing;
    if (aheadActual === aheadProj) continue;
    const futureStop = stopBetween(by.get(rc.driver), c.lapsCompleted + 1, n + 1, now);
    let reason;
    if (!actual) reason = 'retired';
    else if (futureStop) reason = 'stop';
    else if (rc.stage) reason = 'pending';
    else reason = 'pace';
    const err = actual ? rc.time - actual.t : null;
    const what = {
      stop: `own stop on L${futureStop} not known yet`,
      retired: `retired before L${n + 1}`,
      pending: `stop in progress (${rc.stage}), pending loss off by ${err?.toFixed(1)}s`,
      pace: `projection off by ${err?.toFixed(1)}s`,
    }[reason];
    out.push({ driver: rc.driver, reason, text: `${rc.driver} ${aheadProj ? 'counted ahead' : 'counted behind'} (${what})` });
  }
  return out;
}

/** First lap in [from, to] that is an in-lap or out-lap not visible at now, else 0. */
function stopBetween(xl, from, to, now) {
  for (let k = from; k <= to; k++) {
    const r = xl.get(k);
    if (!r) continue;
    const pin = r.PitInTimeSeconds;
    if (pin && pin > now) return k;
    if (hasPitOut(r) && !(r.PitOutTimeSeconds <= now)) return k;
  }
  return 0;
}

function summary(v) {
  const n = v.length;
  return `stops=${n} exact=${pct(v.filter((x) => x === 0).length, n)} within_1=${pct(v.filter((x) => Math.abs(x) <= 1).length, n)}`;
}

const report = [];
const r = (s = '') => report.push(s);
r('Circle of Doom rejoin backtest (frontend/scripts/cod_backtest.mjs)');
r(`cache: backend/data/processed_cache, ${races.length} race sessions`);
r('');
r(`${'race'.padEnd(10)}${'n_green'.padStart(8)}${'script_exact'.padStart(14)}${'module_exact'.padStart(14)}${'script_w1'.padStart(11)}${'module_w1'.padStart(11)}`);
for (const pr of perRace) {
  const ex = (v) => pct(v.filter((x) => x === 0).length, v.length);
  const w1 = (v) => pct(v.filter((x) => Math.abs(x) <= 1).length, v.length);
  r(`${pr.name.padEnd(10)}${String(pr.n).padStart(8)}${ex(pr.script).padStart(14)}${ex(pr.module).padStart(14)}${w1(pr.script).padStart(11)}${w1(pr.module).padStart(11)}`);
}
r('');
r('Rank rule check (the script\'s inputs through circleOfDoom.rankByCrossing):');
r(`  script (causal_fixed)        ${summary(totals.script)}`);
r('  validate_pit_loss_and_rejoin.py baseline: causal_fixed stops=709 exact=71% within_1=88%');
r('');
r('Module (pitWindow at the end of lap n - 1, causal pit loss, projected rivals):');
r(`  module                       ${summary(totals.module)}`);
r('');
r('Ingredient swaps, script -> module (one at a time, cumulative):');
r(`  script                       ${summary(totals.script)}`);
r(`  + causal pit loss            ${summary(totals.loss)}`);
r(`  + causal focus pace          ${summary(totals.pace)}`);
r(`  + projected rival crossings  ${summary(totals.module)}   (= module)`);
r(`  identity: predictedCrossing = Time(n-1) + 2 x pace + loss on ${identityChecks - identityFails}/${identityChecks} stops`);
r('');
r('Where the gap comes from: the script ranks against the rivals\' ACTUAL lap n + 1 crossings, so it');
r('knows the stops rivals make on laps n and n + 1 (pit windows cluster); at the end of lap n - 1 these');
r('stops have not started and no causal predictor can see them.');
r('  stops where no rival stops at all before lap n + 1:');
r(`    script                     ${summary(totals.subsetScript)}`);
r(`    module                     ${summary(totals.subsetModule)}`);
r("  stops where no rival's unseen stop or later retirement puts it on the other side of the focus:");
r(`    script                     ${summary(totals.relevantScript)}`);
r(`    module                     ${summary(totals.relevantModule)}`);
const absErr = projErr.map(Math.abs).sort((a, b) => a - b);
const q = (p) => absErr[Math.min(absErr.length - 1, Math.floor(p * absErr.length))];
r(`  projection error of rival crossings (no stop, still running): n=${absErr.length} `
  + `median |err| ${q(0.5).toFixed(2)}s, p90 ${q(0.9).toFixed(2)}s, mean signed ${(projErr.reduce((a, b) => a + b, 0) / projErr.length).toFixed(2)}s`);
r('');
r('Pace model of the projections (opts.paceModel), module otherwise unchanged:');
for (const m of ['recent', 'race-median', 'reference']) r(`  ${m.padEnd(28)} ${summary(totals[m])}`);
r('');
r('Rejoin probabilities (rejoinDistribution, 1000 seeded draws per stop):');
r(`  mean probability given to the actual position   ${(calib.pActual.reduce((a, b) => a + b, 0) / calib.n).toFixed(3)}`);
r(`  actual position = most likely position          ${pct(calib.modal, calib.n)}`);
r(`  actual position inside the 80% most-likely set  ${pct(calib.cover80, calib.n)}`);
r(`  traffic flag (< 1.0 s behind a car) raised      ${pct(calib.trafficFlag, calib.n)} of stops`);
r(`  same, stops with no unseen rival stop (n=${calib.subN}):`);
r(`    mean probability given to the actual position ${(calib.subPActual.reduce((a, b) => a + b, 0) / calib.subN).toFixed(3)}`);
r(`    actual position = most likely position        ${pct(calib.subModal, calib.subN)}`);
r(`    actual position inside the 80% most-likely set ${pct(calib.subCover80, calib.subN)}`);
r('  The draws cover the pit-loss uncertainty only (not rival stops, not pace), hence the low coverage overall.');
r('');
r('Pit in k laps (utils/undercut.js pitInLaps, race params at the same clock):');
r(`  k = 0 = pitWindow (place, crossing, rejoin offset) on ${pitIn.k0Same}/${pitIn.k0} stops (the stops not taken right after another one)`);
r('  the same stop predicted k laps ahead, at the end of the driver\'s lap n - 1 - k (row k: in-lap n, rejoin at the end of lap n + 1):');
for (const k of K_AHEAD) {
  r(`    k = ${k}  lap model      ${summary(pitIn.ahead[k].model)}`);
  r(`    k = ${k}  flat (no wear) ${summary(pitIn.ahead[k].flat)}`);
}
r('');
r(`Stops where module != script: ${diffs.length} of ${totals.script.length}`);
r(`  stops taken right after another stop (module projects the first one): ${ongoingStops}`);
r(`  rival side changes where the "others" step moved the prediction: own stop not known yet ${flipReasons.stop}, retired later ${flipReasons.retired}, `
  + `stop in progress ${flipReasons.pending}, pace projection ${flipReasons.pace}`);
r('');
r('Stop-by-stop (race, driver, in-lap; positions; the step(s) that changed the prediction):');
for (const d of diffs) r(d);

const text = report.join('\n');
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${text}\n`);
console.log(text);
