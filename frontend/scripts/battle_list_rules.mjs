/**
 * Which battle-list rule keeps the Race Prediction "Battles" list off the
 * Monte Carlo noise (utils/simulationClient.js battleList)?
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/battle_list_rules.mjs
 * Writes docs/evidence/battle_list_rules.txt and prints the same text.
 *
 * Three rules, each chained recompute after recompute as the store does:
 *  - cut+fill (round 4): a listed pair stays unless its Wilson interval is
 *    entirely below the 6th's, an unlisted one enters when entirely above;
 *    then filled up to 6 with the most likely unlisted pairs (point estimate)
 *    or cut back keeping the most likely;
 *  - cut+race-order fill (tried in round 5): the same, the fill / cut-back
 *    choice among the pairs within the error of the cut made in race order;
 *  - rank evidence: a pair enters when fewer than 6 other pairs could be as
 *    likely (their interval reaches its interval), and stays while fewer than
 *    6 other pairs are surely more likely (their whole interval above its
 *    interval); no fill, so the list holds fewer than 6 while the pairs are
 *    too close to call; a cut back (rare) keeps the pairs surely in, then race
 *    order. The shipped rule (projectionBadges). Giving the free slots to the
 *    pairs surely among the best candidates for them adds nothing: such a pair
 *    is surely among the 6 most likely already.
 * Measured: (1) the same race state with new seeds (every cached race at 25 /
 * 50 / 75 % of the distance, 10 seeds), recomputes where the listed set
 * changes; (2) lap by lap (laps 10-50) with 5 seed salts on the same data:
 * one-lap blinks of a gold / green row found under every salt (data) or under
 * some only (noise), and the laps where the lists of the salts differ; (3) the
 * list length.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateRaceFinish, extractRaceParams, DEFAULT_NUM_SIMULATIONS } from '../src/utils/raceSimulation.js';
import { extractRaceSituationFeatures } from '../src/utils/raceSituationFeatures.js';
import { resolveSessionNow, computeSessionTimeOffset } from '../src/utils/raceTime.js';
import { seedFrom } from '../src/utils/prng.js';
import {
  wilsonInterval, badgeOn, battleKey, projectionBadges, BATTLE_BADGE_PCT, BATTLE_LIST_SIZE,
} from '../src/utils/simulationClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE_DIR = path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = path.resolve(ROOT, 'docs/evidence/battle_list_rules.txt');
const report = [];
const r = (line = '') => { report.push(line); console.log(line); };
const parseJson = (text) => JSON.parse(text.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));
const races = fs.readdirSync(CACHE_DIR)
  .map((name) => /^session_(\d{4})_(\d+)_R\.json$/.exec(name)).filter(Boolean)
  .map((m) => ({ year: Number(m[1]), round: Number(m[2]), file: m[0] }))
  .sort((a, b) => a.year - b.year || a.round - b.round);
const sessions = new Map(races.map((rc) => [`${rc.year}_${rc.round}`, parseJson(fs.readFileSync(path.join(CACHE_DIR, rc.file), 'utf8'))]));
const maxLapOf = (lt) => Math.max(...lt.map((x) => Number(x.LapNumber)).filter(Number.isFinite));
const pc = (a, b) => `${a} / ${b} (${b ? ((100 * a) / b).toFixed(2) : '-'}%)`;

function stateOf(y, rd, lap) {
  const s = sessions.get(`${y}_${rd}`);
  const lt = s.lap_times;
  const sessionNow = resolveSessionNow({ currentLap: lap, lapTimes: lt });
  const sessionTimeOffset = computeSessionTimeOffset(lt);
  const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow, sessionTimeOffset });
  if (!feats?.driverFeatures) return null;
  return {
    driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: maxLapOf(lt), lapTimes: lt, trackStatus: s.track_status,
    sessionNow, sessionTimeOffset, sessionType: 'R',
    raceParams: extractRaceParams(lt, [], s.track_status, lap, { sessionNow, sessionType: 'R' }),
  };
}

const byProb = (a, b) => b.prob - a.prob || (battleKey(a) < battleKey(b) ? -1 : battleKey(a) > battleKey(b) ? 1 : 0);
const raceOrder = (a, b) => ((a.aheadCurrentPos ?? Infinity) - (b.aheadCurrentPos ?? Infinity))
  || ((a.behindCurrentPos ?? Infinity) - (b.behindCurrentPos ?? Infinity))
  || (battleKey(a) < battleKey(b) ? -1 : battleKey(a) > battleKey(b) ? 1 : 0);

const RULES = {
  'cut+fill': (battles, n, prev) => {
    const sorted = [...battles].sort(byProb);
    if (!prev) return sorted.slice(0, BATTLE_LIST_SIZE).map(battleKey);
    const [cutLo, cutHi] = sorted.length >= BATTLE_LIST_SIZE ? wilsonInterval(sorted[BATTLE_LIST_SIZE - 1].prob / 100, n) : [0, 0];
    const was = new Set(prev);
    const keep = [];
    for (const b of sorted) {
      const [lo, hi] = wilsonInterval(b.prob / 100, n);
      if (was.has(battleKey(b)) ? hi >= cutLo : lo > cutHi) keep.push(b);
    }
    const listed = new Set(keep.map(battleKey));
    for (const b of sorted) {
      if (keep.length >= BATTLE_LIST_SIZE) break;
      if (!listed.has(battleKey(b))) { keep.push(b); listed.add(battleKey(b)); }
    }
    return sorted.filter((b) => listed.has(battleKey(b))).slice(0, BATTLE_LIST_SIZE).map(battleKey);
  },
  'cut+race-order fill': (battles, n, prev) => {
    const sorted = [...battles].sort(byProb);
    if (!prev) return sorted.slice(0, BATTLE_LIST_SIZE).map(battleKey);
    const [cutLo, cutHi] = sorted.length >= BATTLE_LIST_SIZE ? wilsonInterval(sorted[BATTLE_LIST_SIZE - 1].prob / 100, n) : [0, 0];
    const was = new Set(prev);
    const iv = (b) => wilsonInterval(b.prob / 100, n);
    const keep = sorted.filter((b) => (was.has(battleKey(b)) ? iv(b)[1] >= cutLo : iv(b)[0] > cutHi));
    const clear = (b) => iv(b)[0] > cutHi;
    const prefer = (a, b) => (Number(clear(b)) - Number(clear(a)))
      || (Number(was.has(battleKey(b))) - Number(was.has(battleKey(a)))) || raceOrder(a, b);
    let chosen = keep;
    if (chosen.length > BATTLE_LIST_SIZE) chosen = [...chosen].sort(prefer).slice(0, BATTLE_LIST_SIZE);
    if (chosen.length < BATTLE_LIST_SIZE) {
      const listed = new Set(chosen.map(battleKey));
      const tied = sorted.filter((b) => !listed.has(battleKey(b)) && iv(b)[1] >= cutLo).sort(raceOrder);
      const below = sorted.filter((b) => !listed.has(battleKey(b)) && iv(b)[1] < cutLo);
      chosen = [...chosen, ...tied, ...below].slice(0, BATTLE_LIST_SIZE);
    }
    return chosen.map(battleKey);
  },
  // the shipped rule (utils/simulationClient.js battleList, through projectionBadges)
  'rank evidence': (battles, n, prev) => projectionBadges(
    { battles, numSimulations: n, projections: [] }, prev ? { listed: prev } : null,
  ).listed,
};

/** Badge levels chained as projectionBadges does. */
function levelsOf(battles, n, prevLevels) {
  const out = {};
  for (const b of battles) {
    const key = battleKey(b);
    const was = prevLevels?.[key];
    const on = BATTLE_BADGE_PCT.map((t, i) => badgeOn(b.prob, n, t, was != null ? was > i : undefined));
    out[key] = on[1] ? 2 : on[0] ? 1 : 0;
  }
  return out;
}

r(`Battle list rules, ${DEFAULT_NUM_SIMULATIONS} runs per projection (utils/simulationClient.js battleList)`);
r('');
r('1. Same race state, a new seed per recompute, chained (every cached race at 25 / 50 / 75 % of the distance, 10 seeds):');
{
  const acc = Object.fromEntries(Object.keys(RULES).map((k) => [k, { changed: 0, sizes: [] }]));
  let recomputes = 0;
  for (const rc of races) {
    const ml = maxLapOf(sessions.get(`${rc.year}_${rc.round}`).lap_times);
    for (const frac of [0.25, 0.5, 0.75]) {
      const lap = Math.max(5, Math.round(ml * frac));
      const st = stateOf(rc.year, rc.round, lap);
      if (!st) continue;
      const prev = {};
      for (let k = 0; k < 10; k++) {
        const res = simulateRaceFinish({ ...st, seed: seedFrom('list-rules', rc.year, rc.round, lap, k) });
        if (!res) break;
        if (k > 0) recomputes += 1;
        for (const [name, rule] of Object.entries(RULES)) {
          const list = rule(res.battles, res.numSimulations, prev[name]);
          if (k > 0 && [...list].sort().join() !== [...prev[name]].sort().join()) acc[name].changed += 1;
          acc[name].sizes.push(list.length);
          prev[name] = list;
        }
      }
    }
  }
  for (const [name, a] of Object.entries(acc)) {
    const mean = a.sizes.reduce((x, y) => x + y, 0) / a.sizes.length;
    r(`  ${name.padEnd(22)} recomputes where the listed set changes: ${pc(a.changed, recomputes)}; rows listed: mean ${mean.toFixed(2)}, min ${Math.min(...a.sizes)}`);
  }
}
r('');
r('2. Lap by lap (laps 10-50, lap-mode clock), 5 seed salts on the same data, levels chained as the store does:');
r('   a blink = a gold / green row listed, gone, listed again on three consecutive laps, or the reverse');
for (const [y, rd] of [[2024, 16], [2024, 5], [2024, 1], [2025, 1]]) {
  if (!sessions.has(`${y}_${rd}`)) continue;
  const ml = maxLapOf(sessions.get(`${y}_${rd}`).lap_times);
  const results = [];
  for (let salt = 0; salt < 5; salt++) {
    const seq = [];
    for (let lap = 10; lap <= Math.min(50, ml - 1); lap++) {
      const st = stateOf(y, rd, lap);
      seq.push(simulateRaceFinish({ ...st, seed: seedFrom('list-rules-lap', salt, y, rd, lap) }));
    }
    results.push(seq);
  }
  for (const [name, rule] of Object.entries(RULES)) {
    const runs = results.map((seq) => {
      let prevList = null;
      let prevLevels = null;
      return seq.map((res, i) => {
        const levels = levelsOf(res.battles, res.numSimulations, prevLevels);
        const list = rule(res.battles, res.numSimulations, prevList);
        prevList = list;
        prevLevels = levels;
        return { lap: 10 + i, listed: new Map(list.map((k) => [k, levels[k]])) };
      });
    });
    const blinkSets = runs.map((seq) => {
      const set = new Set();
      for (let i = 2; i < seq.length; i++) {
        for (const key of new Set([...seq[i - 2].listed.keys(), ...seq[i - 1].listed.keys(), ...seq[i].listed.keys()])) {
          const [a, b, c] = [seq[i - 2], seq[i - 1], seq[i]].map((v) => v.listed.get(key));
          if ((a >= 1 && b === undefined && c >= 1) || (a === undefined && b >= 1 && c === undefined)) set.add(`${seq[i - 1].lap}:${key}`);
        }
      }
      return set;
    });
    const all = new Set(blinkSets.flatMap((s) => [...s]));
    const every = [...all].filter((k) => blinkSets.every((s) => s.has(k))).length;
    let diff = 0;
    for (let i = 0; i < runs[0].length; i++) {
      if (new Set(runs.map((seq) => [...seq[i].listed.keys()].sort().join())).size > 1) diff += 1;
    }
    const sizes = runs.flatMap((seq) => seq.map((v) => v.listed.size));
    r(`  ${y} R${rd} ${name.padEnd(22)} blinks per salt ${blinkSets.map((s) => s.size).join(', ')}; distinct ${all.size}: every salt ${every}, some only ${all.size - every}; laps with different lists between salts ${diff} / ${runs[0].length}; rows mean ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2)}, min ${Math.min(...sizes)}`);
  }
}
fs.writeFileSync(OUT_FILE, `${report.join('\n')}\n`);
console.log(`\nwritten ${path.relative(ROOT, OUT_FILE)}`);
