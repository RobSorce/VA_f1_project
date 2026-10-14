/**
 * S4 / lead decision D5, the assistant's strategy cards (backend
 * api/routers/gemini.py heuristic fallback, rendered as "Finish P{n}" by
 * GeminiAssistant.jsx): the Monte Carlo part of the context the store sends
 * (useF1Store.js sendGeminiQuery: monteCarloProjections = the first 10 rows
 * in the store's order with expectedPos and medianPos = modePosition, the
 * first 5 listed battles, the risk rows, the race parameters, the drivers'
 * features), for every cached race x 25 / 50 / 75 % of the distance
 * (lap-mode clock) x SEEDS seeds of the same state, chained withBadges as
 * the store chains its projections. The seeds are those of the verifier's
 * measurement (notes/experiments/phase45c/verify_strategy_r2/
 * s4_assistant_heuristic.mjs: salt 'verify-r2-assist'), so the two can be
 * compared. Writes one JSON file of contexts; backend/scripts/
 * s4_assistant_cards.py feeds each to the route's heuristic and counts how
 * often a card's P changes between two seeds of the same state.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/s4_assistant_contexts.mjs -- --out <file.json> [--seeds 10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateRaceFinish, extractRaceParams } from '../src/utils/raceSimulation.js';
import { withBadges, listedBattles, modePosition } from '../src/utils/simulationClient.js';
import { resolveSessionNow, computeSessionTimeOffset } from '../src/utils/raceTime.js';
import { extractRaceSituationFeatures } from '../src/utils/raceSituationFeatures.js';
import { seedFrom } from '../src/utils/prng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.resolve(ROOT, 'backend/data/processed_cache');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const OUT = arg('--out', null);
const SEEDS = Number(arg('--seeds', 10));
if (!OUT) throw new Error('--out <file.json> is required');

const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8').replace(/\bNaN\b/g, 'null'));
const maxLapOf = (lt) => Math.max(...lt.map((x) => Number(x.LapNumber) || 0));
const FEATURES = ['compoundName', 'tyreLife', 'paceTrend', 'estLapsToPit', 'position', 'recentPace'];

const files = fs.readdirSync(CACHE).filter((f) => /^session_\d+_\d+_R\.json$/.test(f)).sort();
const states = [];
const t0 = Date.now();
for (const f of files) {
  const s = load(f);
  const lt = s.lap_times;
  const ts = s.track_status || [];
  const ml = maxLapOf(lt);
  const offset = computeSessionTimeOffset(lt);
  for (const frac of [0.25, 0.5, 0.75]) {
    const lap = Math.max(5, Math.round(ml * frac));
    const now = resolveSessionNow({ currentLap: lap, lapTimes: lt });
    const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow: now, sessionTimeOffset: offset });
    const raceParams = extractRaceParams(lt, [], ts, lap, { sessionNow: now, sessionType: 'R' });
    const ctx = { driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml };
    const seeds = [];
    let prev = null;
    for (let k = 0; k < SEEDS; k++) {
      const res = simulateRaceFinish({
        driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml, lapTimes: lt, trackStatus: ts,
        sessionNow: now, sessionTimeOffset: offset, sessionType: 'R', raceParams, seed: seedFrom('verify-r2-assist', f, lap, k),
      });
      const proj = withBadges(res, prev?.badges, ctx);
      const rows = proj.projections.slice(0, 10);
      seeds.push({
        maxLap: ml,
        monteCarloProjections: rows.map((p) => ({
          driver: p.driver, currentPos: p.currentPos, expectedPos: p.expectedPos,
          medianPos: modePosition(proj, p), posRange: p.posRange, podiumProb: p.podiumProb, pointsProb: p.pointsProb,
        })),
        monteCarloSimulations: proj.numSimulations,
        battles: listedBattles(proj).slice(0, 5).map((b) => ({
          driver1: b.ahead, driver2: b.behind, overtakeProb: b.prob, type: `${b.behindCompound} vs ${b.aheadCompound}`,
        })),
        risks: (proj.risks || []).slice(0, 5),
        raceParams: { pitLoss: proj.raceParams.pitLoss, scRate: proj.raceParams.scRate, lapNoise: proj.raceParams.lapNoise },
        driverFeatures: Object.fromEntries(rows.map((p) => [p.driver,
          Object.fromEntries(FEATURES.map((k2) => [k2, feats.driverFeatures[p.driver]?.[k2] ?? null]))])),
      });
      prev = proj;
    }
    states.push({ file: f, lap, seeds });
  }
}
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(path.resolve(OUT), JSON.stringify({ salt: 'verify-r2-assist', seeds: SEEDS, states }));
console.log(`${states.length} states x ${SEEDS} seeds written to ${OUT} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
