/**
 * S4 done-when (lead decision D5) for the Strategy Simulator: the categorical
 * marks its result draws from the what-if's Monte Carlo output must be stable
 * on a same-state recompute with a different seed. The what-if is the store's
 * (runSimulationJob 'compare', the job runSimulation sends), its marks the
 * Simulator's (utils/simulationClient.js whatIfMarks), chained over the
 * recomputes of the same what-if as the store chains them (runSimulation:
 * the previous simulatorResult.marks of the same driver, plan and baseline,
 * whatIfKey). For every mark: the share of recomputes where it differs from
 * the previous recompute of the same state. Target: <= 5 % for every mark.
 *
 * Marks, as StrategySimulator.jsx draws them:
 *  - verdict: PLACES GAINED / PLACES LOST / NO CLEAR CHANGE, its arrow and
 *    colour (whatIfVerdict), also the colour of a saved comparison row;
 *  - the P label of the plan's card and of the baseline's card (and both
 *    together); the saved comparison row's P label is the plan's;
 *  - the colour of the podium and of the points difference (green / red /
 *    muted: whatIfMarks podium / points; the checkpoint hid a 0 and coloured
 *    the sign of the rest);
 *  - for information (not a mark of D5, which is judged mark by mark as in
 *    scripts/mc_stability.mjs): whether any of these marks changed at all.
 * The stop-model baseline card shows the Race Prediction panel's P label of
 * the driver (whatIfMarks opts.stopModel / panelMode, as runSimulation passes
 * them): the panel's labels are chained here as the store chains its
 * projections (projectionBadges on the stop-model run, which is the race
 * projection's run, against the previous seed's). Two consistency counts per
 * result (not flips): the verdict contradicting the two cards' P labels
 * (whatIfContradiction: PLACES GAINED while the plan's card is worse, or LOST
 * while it is better), and the baseline card differing from the panel's P
 * label of the same driver.
 * Columns: chained (the store's rule), the same rule with no previous state
 * (a what-if's first run), and the checkpoint's marks (2193a6b: the sign of
 * delta.position, the point median).
 *
 * Sets (--set):
 *  - d5 (default): every cached race x 3 clocks (25 / 50 / 75 % of the
 *    distance, lap-mode clock) x SEEDS seeds; at each clock the cars running
 *    3rd and 10th, each with a stop at the end of lap L+2 and of lap L+6 for
 *    the other dry compound (HARD <-> MEDIUM / SOFT -> HARD).
 *    Writes docs/evidence/whatif_stability.txt.
 *  - verifier: the what-ifs of an earlier independent measurement
 *    (first 10 cached races x 30 / 50 % x every 6th driver in code order x
 *    stops at L+2 and L+6), its seeds ('verify-whatif'), chained.
 *    Writes docs/evidence/whatif_stability_verifier_set.txt.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/whatif_stability.mjs [--set d5|verifier] [--seeds 10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRaceParams, DEFAULT_NUM_SIMULATIONS } from '../src/utils/raceSimulation.js';
import {
  runSimulationJob, whatIfMarks, whatIfKey, modePosition, pairedInterval, familyZ, WHATIF_MARKS,
  projectionBadges, whatIfContradiction,
} from '../src/utils/simulationClient.js';
import { resolveSessionNow, computeSessionTimeOffset } from '../src/utils/raceTime.js';
import { extractRaceSituationFeatures } from '../src/utils/raceSituationFeatures.js';
import { seedFrom } from '../src/utils/prng.js';
import { tyreStates } from '../src/utils/undercut.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.resolve(ROOT, 'backend/data/processed_cache');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const SET = arg('--set', 'd5');
const SEEDS = Number(arg('--seeds', 10));
const TARGET_PCT = 5;
const OUT_FILE = path.resolve(ROOT, 'docs/evidence',
  SET === 'verifier' ? 'whatif_stability_verifier_set.txt' : 'whatif_stability.txt');

const lines = [];
const out = (x = '') => { lines.push(x); console.log(x); };
const pc = (a, b) => `${String(a).padStart(4)} / ${b} (${b ? ((100 * a) / b).toFixed(2) : '-'}%)`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8').replace(/\bNaN\b/g, 'null'));
const maxLapOf = (lt) => Math.max(...lt.map((x) => Number(x.LapNumber) || 0));
const otherCompound = (c) => (c === 'HARD' ? 'MEDIUM' : 'HARD');

/** The what-ifs of one state: [{ driver, plan }]. */
function whatIfsOf(set, feats, ty) {
  const codes = Object.keys(feats.driverFeatures).sort();
  let drivers;
  if (set === 'verifier') {
    drivers = codes.filter((_, i) => i % 6 === 0);
  } else {
    const byPos = codes.filter((d) => Number.isFinite(feats.driverFeatures[d]?.position))
      .sort((a, b) => feats.driverFeatures[a].position - feats.driverFeatures[b].position);
    drivers = [byPos[2], byPos[9]].filter(Boolean);
  }
  const out2 = [];
  for (const d of drivers) {
    const t = ty.get(d);
    if (!t) continue;
    for (const offs of [2, 6]) out2.push({ driver: d, offs, compound: otherCompound(t.compound) });
  }
  return out2;
}

const files = fs.readdirSync(CACHE).filter((f) => /^session_\d+_\d+_R\.json$/.test(f))
  .map((f) => [f, ...(/^session_(\d+)_(\d+)_R\.json$/.exec(f).slice(1).map(Number))])
  .sort((a, b) => (SET === 'verifier' ? (a[0] < b[0] ? -1 : 1) : (a[1] - b[1] || a[2] - b[2])));
const races = SET === 'verifier' ? files.slice(0, 10) : files;
const clocks = SET === 'verifier' ? [0.3, 0.5] : [0.25, 0.5, 0.75];

const MARKS = ['verdict (label, arrow, colour)', 'plan card P label', 'baseline card P label', 'both card P labels',
  'podium difference colour', 'points difference colour', 'any mark of the result'];
const acc = { chained: {}, alone: {}, checkpoint: {} };
for (const k of Object.keys(acc)) for (const m of MARKS) acc[k][m] = 0;
const verdictCount = { chained: { '-1': 0, 0: 0, 1: 0 } };
// consistency per result (chained / alone / checkpoint): verdict vs cards, baseline card vs panel label
const contradictions = { chained: 0, alone: 0, checkpoint: 0 };
const panelDiff = { chained: 0, alone: 0 };
const contradictionExamples = [];
let results = 0;
const examples = [];
let pairs = 0;
let cases = 0;
let sdSum = 0;
let sdN = 0;
const t0 = Date.now();

for (const [file, y, r] of races) {
  const s = load(file);
  const lt = s.lap_times;
  const ts = s.track_status || [];
  const ml = maxLapOf(lt);
  const offset = computeSessionTimeOffset(lt);
  for (const frac of clocks) {
    const lap = SET === 'verifier' ? Math.round(ml * frac) : Math.max(5, Math.round(ml * frac));
    const now = resolveSessionNow({ currentLap: lap, lapTimes: lt });
    const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow: now, sessionTimeOffset: offset });
    if (!feats?.driverFeatures) continue;
    const raceParams = extractRaceParams(lt, [], ts, lap, { sessionNow: now, sessionType: 'R' });
    const ty = tyreStates(lt, now);
    for (const w of whatIfsOf(SET, feats, ty)) {
      const plan = [{ lap: lap + w.offs, compound: w.compound }];
      const key = whatIfKey(w.driver, plan, null);
      cases += 1;
      let prev = null;
      // the Race Prediction panel's badges of the same state, chained over the seeds as the store chains them
      let panel = null;
      for (let k = 0; k < SEEDS; k++) {
        const seed = SET === 'verifier' ? seedFrom('verify-whatif', file, lap, k) : seedFrom('whatif-stability', y, r, lap, k);
        const res = runSimulationJob('compare', {
          driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml, lapTimes: lt, trackStatus: ts,
          sessionNow: now, sessionTimeOffset: offset, sessionType: 'R', raceParams, seed,
          focusDriver: w.driver, plan, basePlan: null,
        });
        if (!res) break;
        if (res.paired?.position) { sdSum += res.paired.position.sd; sdN += 1; }
        // the store's chain: the previous marks of the same what-if (whatIfKey);
        // the stop-model baseline card = the panel's label (runSimulation's opts)
        const chained = whatIfMarks(res, prev?.key === key ? prev.marks.chained : null,
          { stopModel: true, panelMode: panel?.mode ?? null });
        const alone = whatIfMarks(res, null, { stopModel: true, panelMode: null });
        const panelBadges = projectionBadges(res.baseline, panel);
        const panelShown = panelBadges.mode[w.driver];
        const alonePanel = projectionBadges(res.baseline, null).mode[w.driver];
        panel = panelBadges;
        const d = res.delta.position;
        const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
        const checkpoint = {
          verdict: sgn(d),
          shown: { custom: modePosition(res, res.simProjection), baseline: modePosition(res, res.baselineProjection) },
          podium: sgn(res.delta.podium),
          points: sgn(res.delta.points),
        };
        const cur = { key, marks: { chained, alone, checkpoint }, d, iv: pairedInterval(res.paired?.position) };
        results += 1;
        for (const kind of Object.keys(contradictions)) {
          const m = cur.marks[kind];
          if (whatIfContradiction(m.verdict, m.shown.custom, m.shown.baseline)) {
            contradictions[kind] += 1;
            if (kind === 'chained' && contradictionExamples.length < 6) {
              contradictionExamples.push(`${y} R${r} L${lap} ${w.driver} stop L${lap + w.offs} ${w.compound} seed ${k}: verdict ${m.verdict}`
                + ` (interval [${cur.iv?.map((x) => x.toFixed(2)).join(', ')}]), cards plan P${m.shown.custom} / baseline P${m.shown.baseline}`);
            }
          }
        }
        if (chained.shown.baseline !== panelShown) panelDiff.chained += 1;
        if (alone.shown.baseline !== alonePanel) panelDiff.alone += 1;
        verdictCount.chained[chained.verdict] += 1;
        if (prev) {
          pairs += 1;
          for (const kind of Object.keys(acc)) {
            const a = prev.marks[kind];
            const b = cur.marks[kind];
            const changed = {
              'verdict (label, arrow, colour)': a.verdict !== b.verdict,
              'plan card P label': a.shown.custom !== b.shown.custom,
              'baseline card P label': a.shown.baseline !== b.shown.baseline,
              'both card P labels': a.shown.custom !== b.shown.custom || a.shown.baseline !== b.shown.baseline,
              'podium difference colour': a.podium !== b.podium,
              'points difference colour': a.points !== b.points,
            };
            changed['any mark of the result'] = Object.values(changed).some(Boolean);
            for (const m of MARKS) if (changed[m]) acc[kind][m] += 1;
            if (kind === 'chained' && changed['any mark of the result'] && examples.length < 12) {
              examples.push(`${y} R${r} L${lap} ${w.driver} stop L${lap + w.offs} ${w.compound} seed ${k - 1} -> ${k}: verdict ${a.verdict} -> ${b.verdict}`
                + ` (delta ${prev.d} -> ${d}, interval [${cur.iv?.map((x) => x.toFixed(2)).join(', ')}]), P ${a.shown.custom}/${a.shown.baseline} -> ${b.shown.custom}/${b.shown.baseline},`
                + ` podium ${a.podium} -> ${b.podium}, points ${a.points} -> ${b.points}`);
            }
          }
        }
        prev = cur;
      }
    }
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);

out('S4 / D5, Strategy Simulator: same state, a new seed per recompute, the what-if\'s marks chained as the store chains them');
out(`(utils/simulationClient.js whatIfMarks over the recomputes of the same what-if, whatIfKey; job runSimulationJob 'compare')`);
out(`set ${SET}: ${races.length} cached races x ${clocks.length} clocks (${clocks.map((c) => `${c * 100} %`).join(', ')} of the distance, lap-mode clock) x ${SEEDS} seeds, `
  + `${DEFAULT_NUM_SIMULATIONS} runs per side: ${cases} what-ifs, ${pairs} recomputes compared with the previous one (${secs} s)`);
out(`intervals: simultaneous over the ${WHATIF_MARKS} marks of a result (familyZ(${WHATIF_MARKS}) = ${familyZ(WHATIF_MARKS).toFixed(3)});`
  + ` verdict and colours on the paired differences (mean -/+ z sd / sqrt(n)); mean sd of the position difference ${sdN ? (sdSum / sdN).toFixed(2) : '-'} places`);
out(`chained verdicts shown: gain ${verdictCount.chained[1]}, no clear change ${verdictCount.chained[0]}, loss ${verdictCount.chained[-1]}`);
out('');
out(`mark (changed in how many recomputes; target <= ${TARGET_PCT} %)   chained (store)              first run alone               checkpoint 2193a6b`);
const UNION = 'any mark of the result';
let fails = 0;
for (const m of MARKS) {
  const pct = pairs ? (100 * acc.chained[m]) / pairs : 0;
  const ok = pct <= TARGET_PCT;
  if (m === UNION) {
    out(`  ${'(information) any of the marks above'.padEnd(34)} ${pc(acc.chained[m], pairs).padEnd(22)}       ${pc(acc.alone[m], pairs).padEnd(28)} ${pc(acc.checkpoint[m], pairs)}`);
    continue;
  }
  if (!ok) fails += 1;
  out(`  ${m.padEnd(34)} ${pc(acc.chained[m], pairs).padEnd(22)} ${ok ? 'ok  ' : 'OVER'}  ${pc(acc.alone[m], pairs).padEnd(28)} ${pc(acc.checkpoint[m], pairs)}`);
}
out(`marks over ${TARGET_PCT} % (chained): ${fails} of ${MARKS.length - 1}`);
out('');
out(`consistency of each result (${results} results)                chained (store)              first run alone               checkpoint 2193a6b`);
out(`  ${'verdict contradicts the card P labels'.padEnd(34)} ${pc(contradictions.chained, results).padEnd(28)} ${pc(contradictions.alone, results).padEnd(28)} ${pc(contradictions.checkpoint, results)}`);
out(`  ${'baseline card != panel P label'.padEnd(34)} ${pc(panelDiff.chained, results).padEnd(28)} ${pc(panelDiff.alone, results).padEnd(28)} -`);
for (const e of contradictionExamples) out(`    ${e}`);
if (examples.length) {
  out('');
  out('examples of a change, chained (previous -> this recompute):');
  for (const e of examples) out(`  ${e}`);
}
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
