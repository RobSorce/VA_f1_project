/**
 * S4 done-when (lead decision D5): every categorical mark the views derive
 * from a Monte Carlo projection must be stable on a same-state recompute with
 * a different seed. Every cached race x 3 clocks (25 / 50 / 75 % of the
 * distance, lap-mode clock) x SEEDS seeds, DEFAULT_NUM_SIMULATIONS runs each,
 * chained as the store chains them (utils/simulationClient.js withBadges: the
 * previous recompute's badges are the previous state). For every mark: the
 * share of recomputes where it differs from the previous recompute of the
 * same state. A mark drawn once per row (P label, arrow, ...) counts as
 * changed when ANY row of the table changes. Target: <= 5 % for every mark.
 * The Strategy Simulator's marks (a what-if: two runs) are measured the same
 * way by scripts/whatif_stability.mjs.
 *
 * Marks, as the views draw them:
 *  - Race Prediction panel: the P label (finishing position shown,
 *    modePosition), its gold (P1-P3), the podium badge, the gain / loss arrow
 *    (positionChange: colour, and with its number), the row order
 *    (orderedProjections), the battle colours of the listed battles, the list
 *    itself, the "Battles (N)" tab label, the risk rows and "Risks (N)";
 *  - Strategy Analysis: the drivers tab mark ("->P{n}" shown / colour), the
 *    insight battle cards and variance cards (insightsGenerator), its battle
 *    rows (the listed battles);
 *  - Leaderboard: the overtake badge colour of the adjacent pairs (battleLevel);
 *  - assistant: the quick-query battle (first listed), the battle query of
 *    each driver (first listed battle with that driver), the context the
 *    store sends (first 10 rows with their position shown, first 5 battles,
 *    first 5 risk rows).
 * For comparison, the same recomputes under the rules of the checkpoint
 * (2193a6b): the most frequent position with hysteresis on the shares, the
 * arrow from the expected position (|delta| >= 0.5), rows by expected
 * position, the podium badge on its own 95 % interval.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/mc_stability.mjs [--seeds 10]
 * Writes notes/experiments/phase45c/mc_stability.txt and prints the same text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  simulateRaceFinish, extractRaceParams, DEFAULT_NUM_SIMULATIONS,
} from '../src/utils/raceSimulation.js';
import {
  withBadges, listedBattles, battleKey, battleLevel, modePosition, positionChange, orderedProjections,
  projectionRisks, wilsonInterval, badgeOn, familyZ, PODIUM_BADGE_PCT,
} from '../src/utils/simulationClient.js';
import { generateInsights } from '../src/utils/insightsGenerator.js';
import { resolveSessionNow, computeSessionTimeOffset } from '../src/utils/raceTime.js';
import { extractRaceSituationFeatures } from '../src/utils/raceSituationFeatures.js';
import { seedFrom } from '../src/utils/prng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = path.resolve(ROOT, 'notes/experiments/phase45c/mc_stability.txt');
const argSeeds = process.argv.indexOf('--seeds');
const SEEDS = argSeeds > 0 ? Number(process.argv[argSeeds + 1]) : 10;
const CLOCKS = [0.25, 0.5, 0.75];
const TARGET_PCT = 5;

const lines = [];
const out = (x = '') => { lines.push(x); console.log(x); };
const pc = (a, b) => `${String(a).padStart(4)} / ${b} (${b ? ((100 * a) / b).toFixed(2) : '-'}%)`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8').replace(/\bNaN\b/g, 'null'));
const maxLapOf = (lt) => Math.max(...lt.map((x) => Number(x.LapNumber) || 0));
const RACES = fs.readdirSync(CACHE).map((f) => /^session_(\d+)_(\d+)_R\.json$/.exec(f)).filter(Boolean)
  .map((m) => [Number(m[1]), Number(m[2]), m[0]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

// ── The checkpoint's rules (2193a6b), for the before / after columns ──
function oldMode(result, prevMode) {
  const n = result.numSimulations;
  const outMode = {};
  for (const p of result.projections) {
    const point = p.modePos;
    const was = prevMode?.[p.driver];
    if (was == null || was === point) { outMode[p.driver] = point; continue; }
    const dist = p.posDistribution || {};
    const [, wasHi] = wilsonInterval((dist[was] || 0) / 100, n);
    const [pointLo] = wilsonInterval((dist[point] || 0) / 100, n);
    outMode[p.driver] = wasHi >= pointLo ? was : point;
  }
  return outMode;
}
const oldArrow = (p) => (Math.abs(p.delta) >= 0.5 ? `${p.delta > 0 ? 'up' : 'down'}${Math.abs(Math.round(p.delta))}` : 'none');
const oldArrowColour = (p) => (p.delta > 0.5 ? 'green' : p.delta < -0.5 ? 'red' : 'none');

const MARKS = [
  'P label (any row)',
  'gold P label (any row)',
  'podium badge (any row)',
  'gain / loss arrow colour (any row)',
  'gain / loss arrow with its number (any row)',
  'Strategy Analysis driver mark (any row)',
  'projection row order',
  'battle colour, listed in both',
  'listed battles (set)',
  'Battles (N) tab label',
  'insight battle cards (as shown)',
  'insight variance cards',
  'Leaderboard overtake badge colour (adjacent pairs)',
  'risk rows (as shown)',
  'Risks (N) tab label',
  'assistant quick-query battle',
  'assistant battle query (any driver)',
  'assistant context: first 10 rows + position shown',
  'assistant context: first 5 battles',
];
const OLD_MARKS = [
  'P label (any row)',
  'gold P label (any row)',
  'podium badge (any row)',
  'gain / loss arrow colour (any row)',
  'gain / loss arrow with its number (any row)',
  'Strategy Analysis driver mark (any row)',
  'projection row order',
];

function view(proj, oldState) {
  const listed = listedBattles(proj);
  const ins = generateInsights({ raceProjection: proj, raceSituationData: null, currentLap: proj._lap, maxLap: proj._maxLap });
  const risks = projectionRisks(proj);
  const rows = orderedProjections(proj);
  const drivers = rows.map((p) => p.driver).sort();
  const shown = Object.fromEntries(rows.map((p) => [p.driver, modePosition(proj, p)]));
  const change = Object.fromEntries(rows.map((p) => [p.driver, positionChange(proj, p) ?? 0]));
  const adjacent = (proj.battles || []).filter((b) => Math.abs(b.aheadCurrentPos - b.behindCurrentPos) === 1);
  return {
    'P label (any row)': drivers.map((d) => `${d}:${shown[d]}`).join(','),
    'gold P label (any row)': drivers.map((d) => `${d}:${shown[d] <= 3}`).join(','),
    'podium badge (any row)': drivers.map((d) => `${d}:${!!proj.badges.podium[d]}`).join(','),
    'gain / loss arrow colour (any row)': drivers.map((d) => `${d}:${Math.sign(change[d])}`).join(','),
    'gain / loss arrow with its number (any row)': drivers.map((d) => `${d}:${change[d]}`).join(','),
    'Strategy Analysis driver mark (any row)': drivers.map((d) => `${d}:${change[d] ? `${Math.sign(change[d])}P${shown[d]}` : '-'}`).join(','),
    'projection row order': rows.map((p) => p.driver).join(','),
    listedLevels: new Map(listed.map((b) => [battleKey(b), b.level])),
    'listed battles (set)': listed.map(battleKey).sort().join('|'),
    'Battles (N) tab label': String(listed.length),
    'insight battle cards (as shown)': ins.filter((i) => i.category === 'battle').map((i) => `${i.id}:${i.severity}`).join('|'),
    'insight variance cards': ins.filter((i) => i.id.startsWith('uncertain-')).map((i) => i.id).join('|'),
    'Leaderboard overtake badge colour (adjacent pairs)': adjacent.map((b) => `${battleKey(b)}:${battleLevel(proj, b)}`).sort().join('|'),
    'risk rows (as shown)': risks.map((x) => `${x.driver}:${x.type}:${x.severity}`).join('|'),
    'Risks (N) tab label': String(risks.length),
    'assistant quick-query battle': listed[0] ? battleKey(listed[0]) : '',
    'assistant battle query (any driver)': drivers.map((d) => {
      const b = listed.find((x) => x.behind === d || x.ahead === d);
      return `${d}:${b ? battleKey(b) : ''}`;
    }).join('|'),
    'assistant context: first 10 rows + position shown': proj.projections.slice(0, 10).map((p) => `${p.driver}:${modePosition(proj, p)}`).join(','),
    'assistant context: first 5 battles': listed.slice(0, 5).map(battleKey).join('|'),
    old: {
      'P label (any row)': drivers.map((d) => `${d}:${oldState.mode[d]}`).join(','),
      'gold P label (any row)': drivers.map((d) => `${d}:${oldState.mode[d] <= 3}`).join(','),
      'podium badge (any row)': drivers.map((d) => `${d}:${oldState.podium[d]}`).join(','),
      'gain / loss arrow colour (any row)': proj.projections.map((p) => p).sort((a, b) => (a.driver < b.driver ? -1 : 1)).map((p) => `${p.driver}:${oldArrowColour(p)}`).join(','),
      'gain / loss arrow with its number (any row)': proj.projections.map((p) => p).sort((a, b) => (a.driver < b.driver ? -1 : 1)).map((p) => `${p.driver}:${oldArrow(p)}`).join(','),
      'Strategy Analysis driver mark (any row)': proj.projections.map((p) => p).sort((a, b) => (a.driver < b.driver ? -1 : 1))
        .map((p) => `${p.driver}:${Math.abs(p.delta) >= 0.5 ? `${p.delta > 0 ? 'g' : 'r'}P${oldState.mode[p.driver]}` : '-'}`).join(','),
      'projection row order': [...proj.projections].sort((a, b) => a.expectedPos - b.expectedPos).map((p) => p.driver).join(','),
    },
  };
}

const acc = Object.fromEntries(MARKS.map((m) => [m, 0]));
const accOld = Object.fromEntries(OLD_MARKS.map((m) => [m, 0]));
const byClock = Object.fromEntries(CLOCKS.map((c) => [c, { n: 0, ...Object.fromEntries(MARKS.map((m) => [m, 0])) }]));
const perRow = { pairs: 0, label: 0, labelOld: 0 };
const examples = [];
let recomputes = 0;
const t0 = Date.now();
for (const [y, r, file] of RACES) {
  const s = load(file);
  const lt = s.lap_times;
  const ts = s.track_status || [];
  const ml = maxLapOf(lt);
  const offset = computeSessionTimeOffset(lt);
  for (const frac of CLOCKS) {
    const lap = Math.max(5, Math.round(ml * frac));
    const now = resolveSessionNow({ currentLap: lap, lapTimes: lt });
    const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow: now, sessionTimeOffset: offset });
    if (!feats?.driverFeatures) continue;
    const raceParams = extractRaceParams(lt, [], ts, lap, { sessionNow: now, sessionType: 'R' });
    const ctx = { driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml };
    let prev = null;
    let prevView = null;
    let oldState = null;
    for (let k = 0; k < SEEDS; k++) {
      const res = simulateRaceFinish({
        driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml, lapTimes: lt, trackStatus: ts,
        sessionNow: now, sessionTimeOffset: offset, sessionType: 'R', raceParams, seed: seedFrom('mc-stability', y, r, lap, k),
      });
      if (!res) break;
      const proj = { ...withBadges(res, prev?.badges, ctx), _lap: lap, _maxLap: ml };
      const n = res.numSimulations;
      oldState = {
        mode: oldMode(res, oldState?.mode),
        podium: Object.fromEntries(res.projections.map((p) => [p.driver,
          badgeOn(p.podiumProb, n, PODIUM_BADGE_PCT, oldState?.podium?.[p.driver])])),
      };
      const v = view(proj, oldState);
      if (prevView) {
        recomputes += 1;
        const bc = byClock[frac];
        bc.n += 1;
        const hit = (m) => { acc[m] += 1; bc[m] += 1; };
        for (const m of MARKS) {
          if (m === 'battle colour, listed in both') {
            let changed = false;
            for (const [key, lv] of v.listedLevels) if (prevView.listedLevels.has(key) && prevView.listedLevels.get(key) !== lv) changed = true;
            if (changed) hit(m);
          } else if (v[m] !== prevView[m]) {
            hit(m);
            if (examples.length < 12 && ['P label (any row)', 'gold P label (any row)', 'gain / loss arrow colour (any row)'].includes(m)) {
              const a = prevView[m].split(',');
              const b = v[m].split(',');
              const diff = b.filter((x, i) => x !== a[i]).map((x, i) => `${a[b.indexOf(x)]} -> ${x}`).slice(0, 3);
              examples.push(`${y} R${r} L${lap} seed ${k}: ${m}: ${diff.join('; ')}`);
            }
          }
        }
        for (const m of OLD_MARKS) if (v.old[m] !== prevView.old[m]) accOld[m] += 1;
        const cur = v['P label (any row)'].split(',');
        const was = prevView['P label (any row)'].split(',');
        const curOld = v.old['P label (any row)'].split(',');
        const wasOld = prevView.old['P label (any row)'].split(',');
        cur.forEach((x, i) => { perRow.pairs += 1; if (x !== was[i]) perRow.label += 1; if (curOld[i] !== wasOld[i]) perRow.labelOld += 1; });
      }
      prev = proj;
      prevView = v;
    }
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);

out('S4 / D5: same state, a new seed per recompute, chained as the store chains them (utils/simulationClient.js withBadges)');
out(`${RACES.length} cached races x ${CLOCKS.length} clocks (${CLOCKS.map((c) => `${c * 100} %`).join(', ')} of the distance, lap-mode clock) x ${SEEDS} seeds, `
  + `${DEFAULT_NUM_SIMULATIONS} runs each: ${recomputes} recomputes compared with the previous one (${secs} s)`);
out(`intervals: per-driver marks and battle colours simultaneous over the rows / pairs (familyZ: 20 rows ${familyZ(20).toFixed(3)}, 70 pairs ${familyZ(70).toFixed(3)}); battle list and risk rows 1.96 per mark`);
out('');
out(`mark (changed in how many recomputes; target <= ${TARGET_PCT} %)                     now                         checkpoint 2193a6b rules`);
let fails = 0;
for (const m of MARKS) {
  const pct = recomputes ? (100 * acc[m]) / recomputes : 0;
  const ok = pct <= TARGET_PCT;
  if (!ok) fails += 1;
  const old = OLD_MARKS.includes(m) ? pc(accOld[m], recomputes) : '';
  out(`  ${m.padEnd(52)} ${pc(acc[m], recomputes).padEnd(24)} ${ok ? 'ok  ' : 'OVER'}  ${old}`);
}
out(`marks over ${TARGET_PCT} %: ${fails} of ${MARKS.length}`);
out(`per row: P label changes ${pc(perRow.label, perRow.pairs)} (checkpoint rule ${pc(perRow.labelOld, perRow.pairs)})`);
out('');
out('by clock (recomputes with the mark changed):');
for (const c of CLOCKS) {
  const bc = byClock[c];
  const worst = MARKS.map((m) => [m, bc[m]]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  out(`  ${c * 100} % (${bc.n}): ${worst.map(([m, x]) => `${m} ${x}`).join('; ')}`);
}
if (examples.length) {
  out('');
  out('examples of a change (previous -> this recompute):');
  for (const e of examples) out(`  ${e}`);
}

// ── Lap by lap, as a replay plays it: one-lap blinks that only some seed salts show ──
out('');
out('lap by lap (laps 10-50, the store\'s chain from lap to lap), 5 seed salts: a mark that turns on for one lap and off again (or');
out('the reverse) under some salts only is a blink on noise; under every salt it is in the data');
for (const [y, r] of [[2024, 16], [2024, 5]]) {
  const s = load(`session_${y}_${r}_R.json`);
  const lt = s.lap_times;
  const ts = s.track_status || [];
  const ml = maxLapOf(lt);
  const offset = computeSessionTimeOffset(lt);
  const states = [];
  for (let lap = 10; lap <= Math.min(50, ml - 1); lap++) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes: lt });
    const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow: now, sessionTimeOffset: offset });
    states.push({
      lap, now, feats, raceParams: extractRaceParams(lt, [], ts, lap, { sessionNow: now, sessionType: 'R' }),
    });
  }
  const runs = [];
  for (let salt = 0; salt < 5; salt++) {
    let prev = null;
    const seq = [];
    for (const st of states) {
      const res = simulateRaceFinish({
        driverFeatures: st.feats.driverFeatures, currentLap: st.lap, maxLap: ml, lapTimes: lt, trackStatus: ts,
        sessionNow: st.now, sessionType: 'R', raceParams: st.raceParams, seed: seedFrom('mc-stability-laps', salt, y, r, st.lap),
      });
      const proj = withBadges(res, prev?.badges, { driverFeatures: st.feats.driverFeatures, currentLap: st.lap, maxLap: ml });
      prev = proj;
      const on = new Set();
      for (const p of proj.projections) {
        if (proj.badges.podium[p.driver]) on.add(`pod:${p.driver}`);
        const ch = positionChange(proj, p) ?? 0;
        if (ch) on.add(`arrow${ch > 0 ? '+' : '-'}:${p.driver}`);
      }
      for (const b of listedBattles(proj)) on.add(`battle:${battleKey(b)}:${b.level}`);
      for (const x of projectionRisks(proj)) on.add(`risk:${x.driver}:${x.type}:${x.severity}`);
      seq.push({ lap: st.lap, on });
    }
    runs.push(seq);
  }
  const blinkSets = runs.map((seq) => {
    const set = new Set();
    for (let i = 2; i < seq.length; i++) {
      for (const key of new Set([...seq[i - 2].on, ...seq[i - 1].on, ...seq[i].on])) {
        const [a, b, c] = [seq[i - 2], seq[i - 1], seq[i]].map((v) => v.on.has(key));
        if ((a && !b && c) || (!a && b && !c)) set.add(`${seq[i - 1].lap}|${key}`);
      }
    }
    return set;
  });
  const all = new Set(blinkSets.flatMap((x) => [...x]));
  for (const kind of ['pod', 'arrow', 'battle', 'risk']) {
    const keys = [...all].filter((k) => k.split('|')[1].startsWith(kind));
    const every = keys.filter((k) => blinkSets.every((x) => x.has(k)));
    out(`  ${y} R${r} ${kind.padEnd(6)}: distinct one-lap blinks ${String(keys.length).padStart(3)}; under every salt ${String(every.length).padStart(3)};`
      + ` under some salts only (noise) ${keys.length - every.length}`);
  }
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
