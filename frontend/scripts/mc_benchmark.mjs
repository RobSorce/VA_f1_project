/**
 * Monte Carlo race simulation (src/utils/raceSimulation.js): priors, the data
 * behind its assumptions, before / after against the committed version
 * (HEAD), a backtest of the predicted remaining stops, runtime and badge
 * stability.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/mc_benchmark.mjs
 * Writes notes/experiments/mc_benchmark.txt and prints the same text.
 * Pass --quick to skip the 10,000-run stability rows (development only).
 *
 * HEAD: `git show HEAD:frontend/src/utils/raceSimulation.js` (read-only) is
 * written to a temporary folder with its imports pointed at src/utils, and
 * one line is instrumented to also return the median of the remaining-stop
 * counts it already sorts (pitStopsRemaining.median); nothing else changes.
 * HEAD draws from Math.random: for reproducible numbers Math.random is
 * replaced by a seeded counter sequence (prng.js) while HEAD runs. HEAD runs
 * its fixed 100 simulations, the new engine its default 1,000.
 *
 * Sections:
 *  1. Priors: computePriors over every cached race (sessionNow = Infinity),
 *     and the PRIORS object to copy into raceSimulation.js.
 *  2. Data behind the assumptions: the fresh-tyre residual by tyre age
 *     (FRESH_TYRE_LAPS), the two-compound rule in dry races, the pace-trend
 *     slope against its standard error, the SC gap ratio lap by lap
 *     (SC_BUNCHED_AFTER_LAPS); the longest race and the optional-stop laps
 *     left are in section 1.
 *  3. Before / after on Monza 2024 (R16) and China 2024 (R5).
 *  4. Backtest over every cached race at 25 / 50 / 75 % of the distance:
 *     predicted mean remaining stops against the actual ones, and expected
 *     position against the classification; HEAD, the new default and its
 *     variants (optional-stop cap at the lower decile, payback rule, useTrend).
 *     In-sample: the priors include every race of the backtest.
 *  5. Runtime for 100 / 1,000 / 10,000 runs; badge stability as the views
 *     draw the badges (the store's rule: Wilson interval + hysteresis,
 *     chained over recomputes; battles listed by that rule) against the bare
 *     thresholds and the former top-6 list, the same state with new seeds;
 *     every other mark drawn from a projection (row label, insight cards,
 *     the assistant's quick query, risk rows), the same state with new seeds
 *     over every cached race; the lap-by-lap chain under 5 seed salts (data
 *     against noise); and lap by lap through the store's
 *     computeRaceProjection (Monza 2024).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  computePriors, roundPriors, extractRaceParams, simulateRaceFinish, compareStrategies, degradationFor,
  PRIORS, FRESH_TYRE_LAPS, DEFAULT_NUM_SIMULATIONS, STINT_LIFE_MAX, OPTIONAL_STOP_MIN_LAPS_LEFT,
  SC_BUNCHED_AFTER_LAPS, neutralEpisodes, evaluateRisks, RISK_LIST_SIZE,
} from '../src/utils/raceSimulation.js';
import { extractRaceSituationFeatures } from '../src/utils/raceSituationFeatures.js';
import { cleanStintLaps, fitStint, fuelCorrectedTime } from '../src/utils/degradation.js';
import { resolveSessionNow, computeSessionTimeOffset } from '../src/utils/raceTime.js';
import { deriveStints, pitStops } from '../src/utils/stints.js';
import { nonFinisherMap } from '../src/utils/driverState.js';
import { uniformAt, seedFrom } from '../src/utils/prng.js';
import {
  projectionBadges, listedBattles, battleKey, modePosition, PODIUM_BADGE_PCT, BATTLE_BADGE_PCT, BATTLE_LIST_SIZE,
} from '../src/utils/simulationClient.js';
import { generateInsights } from '../src/utils/insightsGenerator.js';

// The store (section 5, lap by lap through computeRaceProjection) persists
// some settings: an in-memory localStorage stands in for the browser's
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}
const { useF1Store } = await import('../src/store/useF1Store.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..');
const ROOT = path.resolve(FRONTEND, '..');
const CACHE_DIR = path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = path.resolve(ROOT, 'notes/experiments/mc_benchmark.txt');
const QUICK = process.argv.includes('--quick');

const report = [];
const r = (line = '') => { report.push(line); };
const f = (v, d = 3) => (v == null || Number.isNaN(v) ? '-' : (v === Infinity ? 'inf' : (v >= 0 ? '+' : '') + v.toFixed(d)));
const u = (v, d = 3) => (v == null || Number.isNaN(v) ? '-' : (v === Infinity ? 'inf' : v.toFixed(d)));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const parseJson = (text) => JSON.parse(text.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));
const load = (file) => parseJson(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
const races = fs.readdirSync(CACHE_DIR)
  .map((name) => /^session_(\d{4})_(\d+)_R\.json$/.exec(name))
  .filter(Boolean)
  .map((m) => ({ file: m[0], year: Number(m[1]), round: Number(m[2]) }))
  .sort((a, b) => a.year - b.year || a.round - b.round);
const sessions = new Map(races.map((rc) => [`${rc.year}_${rc.round}`, load(rc.file)]));
const sessionOf = (year, round) => sessions.get(`${year}_${round}`);
const maxLapOf = (lt) => Math.max(...lt.map((x) => Number(x.LapNumber)).filter(Number.isFinite));

// ─── HEAD module ───
const headSrc = execFileSync('git', ['show', 'HEAD:frontend/src/utils/raceSimulation.js'], { cwd: ROOT, encoding: 'utf8' });
const INSTRUMENT_FROM = 'pitStopsRemaining: { mean: Math.round(pitMean * 10) / 10, range: [pitMin, pitMax] },';
const INSTRUMENT_TO = 'pitStopsRemaining: { mean: Math.round(pitMean * 10) / 10, range: [pitMin, pitMax], median: (pitCounts[(pitCounts.length - 1) >> 1] + pitCounts[pitCounts.length >> 1]) / 2 },';
if (!headSrc.includes(INSTRUMENT_FROM)) throw new Error('HEAD source changed: instrumentation line not found');
const utilsDir = path.resolve(FRONTEND, 'src/utils').replace(/\\/g, '/');
const headPatched = headSrc
  .replace(INSTRUMENT_FROM, INSTRUMENT_TO)
  .replace(/from '\.\/(raceTime|stints|pitLoss)'/g, (_, m) => `from '${utilsDir}/${m}.js'`);
const headDir = path.join(os.tmpdir(), 'mc_benchmark_head');
fs.mkdirSync(headDir, { recursive: true });
const headFile = path.join(headDir, 'raceSimulation.head.js');
fs.writeFileSync(headFile, headPatched);
const HEAD = await import(headFile.replace(/\\/g, '/'));
const headCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

/** Run fn with Math.random replaced by a seeded counter sequence. */
function seededRandom(seed, fn) {
  const saved = Math.random;
  let i = 0;
  Math.random = () => uniformAt(seed, 0, 0, i++, 99);
  try { return fn(); } finally { Math.random = saved; }
}

r('Monte Carlo race simulation benchmark (src/utils/raceSimulation.js)');
r(`Cached races: ${races.length} (${races.map((rc) => `${rc.year} R${rc.round}`).join(', ')})`);
r(`HEAD = ${headCommit} (committed raceSimulation.js, 100 sims, Math.random seeded here); new = working tree, ${DEFAULT_NUM_SIMULATIONS} sims`);
r('');

// ══════════════════════════════════════════════════════════
r('=== 1. Priors (computePriors over every cached race, sessionNow = Infinity) ===');
const priors = computePriors(races.map((rc) => {
  const s = sessionOf(rc.year, rc.round);
  return { lapTimes: s.lap_times, trackStatus: s.track_status };
}));
r(`races ${priors.races}, longest race ${priors.maxRaceLaps} laps (STINT_LIFE_MAX = ${STINT_LIFE_MAX})`);
r('');
r('Degradation per compound (pooled per-stint fits, fuel-corrected s per lap of tyre age); raceMean / withinSd / betweenSd');
r('over the races with two fits or more, minFitLaps from the partial-stint check (raceDegradation; details in');
r('notes/experiments/degradation_in_race.txt, scripts/degradation_in_race.mjs):');
r('  compound        n    mean     median   stdDev  negative   races  raceMean  withinSd  betweenSd  minFitLaps');
for (const [c, d] of Object.entries(priors.degradation)) {
  r(`  ${pad(c, 13)} ${lpad(d.n, 4)}  ${f(d.mean, 4)}  ${f(d.median, 4)}  ${u(d.stdDev, 4)}  ${lpad(d.negativeCount, 5)}   ${lpad(d.races, 5)}  ${lpad(f(d.raceMean, 4), 8)}  ${lpad(u(d.withinSd, 4), 8)}  ${lpad(u(d.betweenSd, 4), 9)}  ${lpad(d.minFitLaps, 10)}`);
}
r(`Lap noise (pooled residual sigma of ${priors.lapNoise.stints} fitted stints): ${u(priors.lapNoise.value, 3)} s; prior of a race (lapNoiseFromFits):`
  + ` dry ${u(priors.lapNoise.dry.value, 3)} s, nu0 ${u(priors.lapNoise.dry.nu0, 2)} (${priors.lapNoise.dry.races} races), wet ${u(priors.lapNoise.wet.value, 3)} s, nu0 ${u(priors.lapNoise.wet.nu0, 2)} (${priors.lapNoise.wet.races} races)`);
r(`Fresh-tyre delta (median of ${priors.freshDelta.stints} stint residuals, first flying lap on a new set): ${f(priors.freshDelta.value, 3)} s`);
r('Stint life per compound (Kaplan-Meier of the tyre age at a tyre change; ongoing / to-the-flag censored, DNF final stints dropped):');
r('  compound        n  events  q25  median  q75   sigma');
for (const [c, s] of Object.entries(priors.stintLife)) {
  r(`  ${pad(c, 13)} ${lpad(s.n, 4)}  ${lpad(s.events, 6)}  ${lpad(s.q25, 3)}  ${lpad(s.median, 6)}  ${lpad(s.q75 ?? '-', 3)}  ${u(s.sigma, 2)}`);
}
const scp = priors.safetyCar;
r(`Safety car: ${scp.episodes} episodes (${scp.scEpisodes} with an SC) over ${scp.laps} leader laps in ${priors.races} races`);
r(`  per race: ${u(scp.episodesPerRace, 3)} episodes, ${u(scp.scEpisodesPerRace, 3)} SC episodes, ${u(scp.lapsPerRace, 2)} laps; rate ${u(scp.episodes / scp.laps, 4)} per lap`);
r(`  completed episode length (laps): SC median ${scp.durationLaps.SC} [${scp.durations.SC.join(' ')}], VSC median ${scp.durationLaps.VSC} [${scp.durations.VSC.join(' ')}]`);
r(`  SC gap ratio (gap to leader after / before, per-episode median): median ${u(scp.scGapRatio, 3)} over ${scp.gapRatioEpisodes} SC episodes`);
r(`Tyre changes (from -> to: count): ${Object.entries(priors.transitions).map(([from, tos]) => `${from} -> ${Object.entries(tos).map(([to, n]) => `${to} ${n}`).join(', ')}`).join(' | ')}`);
const ops = priors.optionalStops;
r(`Optional stops (dry races, finishers, two dry compounds already used): ${ops.n}; laps left after them: lower decile ${ops.lapsLeftQ10}, lower quartile ${ops.lapsLeftQ25} (OPTIONAL_STOP_MIN_LAPS_LEFT = ${OPTIONAL_STOP_MIN_LAPS_LEFT}), median ${ops.lapsLeftMedian}`);
r(`  sorted: ${ops.lapsLeft.join(' ')}`);
r('');
const priorsConst = roundPriors(priors);
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
r('PRIORS (rounded, as in raceSimulation.js):');
r(JSON.stringify(priorsConst));
const inCode = JSON.stringify(canon(PRIORS)) === JSON.stringify(canon(priorsConst));
r(`raceSimulation.js PRIORS equal to this: ${inCode}`);
r('');

// ══════════════════════════════════════════════════════════
r('=== 2. Data behind the assumptions ===');
r('');
r(`a) Fresh-tyre residual by tyre age (FRESH_TYRE_LAPS = ${FRESH_TYRE_LAPS}): clean laps after lap 2, fuel-corrected,`);
r('   residual against fitStint of the same stint\'s laps with TyreLife > 6 (so ages 2-6 are out of sample):');
const byAge = new Map();
for (const s of sessions.values()) {
  for (const st of cleanStintLaps(s.lap_times)) {
    const laps = st.laps.filter((l) => l.LapNumber > 2);
    const fit = fitStint(laps.filter((l) => l.TyreLife > 6));
    if (!fit) continue;
    for (const l of laps) {
      if (l.TyreLife > 8) continue;
      const e = fuelCorrectedTime(l) - (fit.intercept + fit.slope * l.TyreLife);
      if (!byAge.has(l.TyreLife)) byAge.set(l.TyreLife, []);
      byAge.get(l.TyreLife).push(e);
    }
  }
}
r('   age     n    median     mean');
for (const age of [...byAge.keys()].sort((a, b) => a - b)) {
  const e = byAge.get(age);
  r(`   ${lpad(age, 3)}  ${lpad(e.length, 5)}  ${f(median(e), 3)}   ${f(mean(e), 3)}`);
}
r('');

r('b) Two-compound rule: classified finishers who used fewer than two dry compounds');
const DRYC = new Set(['SOFT', 'MEDIUM', 'HARD']);
let dryRaces = 0;
let dryFinishers = 0;
const exceptions = [];
for (const rc of races) {
  const s = sessionOf(rc.year, rc.round);
  const st = deriveStints(s.lap_times);
  if (st.some((x) => x.Compound === 'INTERMEDIATE' || x.Compound === 'WET')) continue;
  dryRaces += 1;
  const nf = nonFinisherMap(s.lap_times, {});
  const by = {};
  for (const x of st) (by[x.Driver] ||= []).push(x);
  for (const [d, arr] of Object.entries(by)) {
    if (nf[d]) continue;
    dryFinishers += 1;
    const comps = new Set(arr.map((x) => x.Compound).filter((c) => DRYC.has(c)));
    if (comps.size < 2) exceptions.push(`${rc.year} R${rc.round} ${d}: ${arr.map((x) => `${x.Compound} ${x.StartLap}-${x.EndLap}`).join(', ')}`);
  }
}
r(`   dry races (no INTERMEDIATE / WET stint) ${dryRaces}, finishers ${dryFinishers}, fewer than two dry compounds ${exceptions.length}:`);
for (const e of exceptions) r(`     ${e}`);
r('');

r('c) Pace trend (raceSituationFeatures paceTrend: raw slope of the last 5 valid laps) against its sampling error,');
r('   every race at half distance: sd of paceTrend over drivers vs lap noise / sqrt(10) (s.e. of a 5-lap slope):');
const trendRows = [];
for (const rc of races) {
  const s = sessionOf(rc.year, rc.round);
  const lt = s.lap_times;
  const lap = Math.round(maxLapOf(lt) / 2);
  const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {} });
  if (!feats) continue;
  const p = extractRaceParams(lt, [], s.track_status, lap);
  const trends = Object.values(feats.driverFeatures).map((x) => x.paceTrend);
  const sd = Math.sqrt(trends.reduce((a, v) => a + (v - mean(trends)) ** 2, 0) / (trends.length - 1));
  trendRows.push({ rc, lap, sd, se: p.lapNoise / Math.sqrt(10), deg: p.tyreDeg });
}
r('   race        lap   sd(paceTrend)  s.e.(5-lap slope)');
for (const t of trendRows) r(`   ${pad(`${t.rc.year} R${t.rc.round}`, 10)} ${lpad(t.lap, 4)}   ${u(t.sd, 3)}          ${u(t.se, 3)}`);
r(`   median sd ${u(median(trendRows.map((t) => t.sd)), 3)} s/lap, median s.e. ${u(median(trendRows.map((t) => t.se)), 3)} s/lap; pooled compound degradation (prior ALL) ${f(priors.degradation.ALL.mean, 4)} s/lap`);
r('');

r(`d) SC gap ratio lap by lap (SC_BUNCHED_AFTER_LAPS = ${SC_BUNCHED_AFTER_LAPS}): per SC episode, median over cars of GapToLeader at the`);
r('   end of lap start + k over the end of the lap before the episode (gap 2-60 s before, no pit entry / exit so far):');
for (const rc of races) {
  const s = sessionOf(rc.year, rc.round);
  const rows = new Map(s.lap_times.map((x) => [`${x.Driver}_${x.LapNumber}`, x]));
  const drivers = [...new Set(s.lap_times.map((x) => x.Driver))];
  for (const e of neutralEpisodes(s.track_status, s.lap_times, Infinity)) {
    if (e.type !== 'SC' || e.endLap == null) continue;
    const cells = [];
    for (let k = 0; k <= e.endLap - e.startLap + 1; k++) {
      const ratios = [];
      for (const d of drivers) {
        const b = rows.get(`${d}_${e.startLap - 1}`);
        const a = rows.get(`${d}_${e.startLap + k}`);
        if (!b || !a || !(b.GapToLeader >= 2 && b.GapToLeader <= 60) || !(a.GapToLeader >= 0)) continue;
        let pit = false;
        for (let L = e.startLap - 1; L <= e.startLap + k; L++) {
          const x = rows.get(`${d}_${L}`);
          if (x && (x.PitInTimeSeconds || x.PitOutTimeSeconds)) pit = true;
        }
        if (!pit) ratios.push(a.GapToLeader / b.GapToLeader);
      }
      cells.push(ratios.length ? u(median(ratios), 2) : '-');
    }
    if (cells.some((c) => c !== '-')) r(`   ${pad(`${rc.year} R${rc.round}`, 10)} SC laps ${pad(`${e.startLap}-${e.endLap}`, 6)} k = 0.. : ${cells.join(' ')}`);
  }
}
r('');

// ══════════════════════════════════════════════════════════
r('=== 3. Before / after (HEAD vs new) ===');
const monza = sessionOf(2024, 16);
const MZ = monza.lap_times;
const mzMax = maxLapOf(MZ);

function paramsBoth(s, lap, sessionNow) {
  const opts = sessionNow === undefined ? {} : { sessionNow };
  const head = HEAD.extractRaceParams(s.lap_times, s.tyre_strategy, s.track_status, lap, opts);
  const now = extractRaceParams(s.lap_times, s.tyre_strategy, s.track_status, lap, opts);
  return { head, now };
}
r('');
r('Monza 2024 (R16): estimates');
for (const [label, lap, sn] of [['race over (sessionNow = Infinity)', mzMax, Infinity], ['lap 30 (lap-mode clock)', 30, undefined], ['lap 12 (lap-mode clock)', 12, undefined]]) {
  const { head, now } = paramsBoth(monza, lap, sn);
  r(`  ${label}:`);
  r(`    freshDelta     HEAD ${f(head.freshDelta, 3)} s   new ${f(now.freshDelta, 3)} s (raw ${f(now.estimates.freshDelta.raw, 3)}, n ${now.estimates.freshDelta.n} stints, ${now.estimates.freshDelta.source}${now.estimates.freshDelta.clamped ? ', clamped' : ''})`);
  for (const c of ['MEDIUM', 'HARD']) {
    const h = head.tyreDeg[c];
    // new: what the lap model uses (degradationFor: the race's fits long
    // enough combined with the prior, else the prior); every fit in allFits
    const d = degradationFor(now, c);
    const n = now.tyreDeg[c];
    const all = n?.allFits;
    r(`    ${pad(c, 6)} deg    HEAD ${h ? `${f(h.mean, 4)} (sd ${u(h.stdDev, 4)})` : '-'}   new ${f(d.mean, 4)} (${d.source}; fits used ${d.source === 'race' ? d.n : 0}`
      + `, ${n ? n.negativeCount : 0} negative, too short ${n ? n.short : 0}; every fit: ${all ? `mean ${f(all.mean, 4)}, n ${all.n}, ${all.negativeCount} negative` : 'none'})`);
  }
  r(`    lap noise      HEAD ${u(head.lapNoise, 3)} s   new ${u(now.lapNoise, 3)} s (${now.estimates.lapNoise.stints} stints, ${now.estimates.lapNoise.laps} laps, ${now.estimates.lapNoise.source})`);
  r(`    stint length   HEAD ${Object.entries(head.stintLength).map(([c, s]) => `${c} ${u(s.mean, 1)}`).join(', ') || '-'}   new ${Object.entries(now.estimates.stintLife).map(([c, s]) => `${c} median ${s.median} mean ${u(s.mean, 1)} (${s.events} ev / ${s.censored} cens / ${s.dropped} drop)`).join(', ')}`);
}
r('');

/** Actual stops after the lap-mode clock of `lap` per driver (non-finishers excluded). */
function actualRemaining(s, lap) {
  const now = resolveSessionNow({ currentLap: lap, lapTimes: s.lap_times });
  const nf = nonFinisherMap(s.lap_times, {});
  const total = {};
  const seen = {};
  for (const p of pitStops(s.lap_times)) total[p.Driver] = (total[p.Driver] || 0) + 1;
  for (const p of pitStops(s.lap_times, { sessionNow: now })) seen[p.Driver] = (seen[p.Driver] || 0) + 1;
  const out = {};
  for (const d of new Set(s.lap_times.map((x) => x.Driver))) {
    if (nf[d]) continue;
    out[d] = { remaining: (total[d] || 0) - (seen[d] || 0), total: total[d] || 0, made: seen[d] || 0 };
  }
  return out;
}

const VARIANTS = [
  ['new: laps-left cap = lower quartile (default)', {}],
  ['new: laps-left cap = lower decile', { optionalStopMinLapsLeft: priors.optionalStops.lapsLeftQ10 }],
  ['new: payback rule', { stopRule: 'payback' }],
  ['new: default + useTrend', { useTrend: true }],
];

function projectionsBoth(s, lap, seed, variants = false) {
  const lt = s.lap_times;
  const maxLap = maxLapOf(lt);
  const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {} });
  if (!feats) return null;
  const args = {
    driverFeatures: feats.driverFeatures, currentLap: lap, maxLap, lapTimes: lt,
    strategies: s.tyre_strategy, trackStatus: s.track_status,
  };
  const head = seededRandom(seed, () => HEAD.simulateRaceFinish(args));
  const now = simulateRaceFinish({ ...args, seed });
  const alt = variants
    ? VARIANTS.slice(1).map(([, o]) => simulateRaceFinish({ ...args, seed, raceParams: now.raceParams, ...o }))
    : [];
  return { head, now, alt, feats };
}

for (const lap of [12, 39]) {
  const res = projectionsBoth(monza, lap, seedFrom('mc_benchmark', 2024, 16, lap));
  const act = actualRemaining(monza, lap);
  const rows = res.now.projections.map((p) => {
    const h = res.head.projections.find((x) => x.driver === p.driver);
    return { d: p.driver, h: h.pitStopsRemaining, n: p.pitStopsRemaining, a: act[p.driver] };
  }).sort((a, b) => a.d.localeCompare(b.d));
  r(`Monza 2024, lap ${lap} (lap-mode clock): remaining stops per driver (HEAD mean / median, new mean / median, actual)`);
  r('  drv   HEAD mean med   new mean med   actual (made so far, race total)');
  for (const x of rows) {
    r(`  ${x.d}   ${lpad(u(x.h.mean, 1), 9)} ${lpad(x.h.median, 3)}   ${lpad(u(x.n.mean, 2), 8)} ${lpad(x.n.median, 3)}   ${x.a ? `${x.a.remaining} (${x.a.made}, ${x.a.total})` : 'DNF'}`);
  }
  const hMed = median(rows.map((x) => x.h.median));
  const nMed = median(rows.map((x) => x.n.median));
  r(`  median over drivers of the per-driver median: HEAD ${hMed}, new ${nMed}; mean of the means: HEAD ${u(mean(rows.map((x) => x.h.mean)), 2)}, new ${u(mean(rows.map((x) => x.n.mean)), 2)}, actual ${u(mean(rows.filter((x) => x.a).map((x) => x.a.remaining)), 2)}`);
  if (lap === 39) {
    const one = rows.filter((x) => x.a && x.a.total === 1 && x.a.made === 1);
    r(`  one-stoppers who have made their only stop by lap 39 (${one.length}): ${one.map((x) => x.d).join(' ')}`);
    r(`    new: mean of means ${u(mean(one.map((x) => x.n.mean)), 3)}, max mean ${u(Math.max(...one.map((x) => x.n.mean)), 2)}, medians ${one.map((x) => x.n.median).join(' ')}`);
    r(`    HEAD: mean of means ${u(mean(one.map((x) => x.h.mean)), 3)}, medians ${one.map((x) => x.h.median).join(' ')}`);
  }
  r('');
}

const china = sessionOf(2024, 5);
{
  const { head, now } = paramsBoth(china, 30);
  const sc = now.estimates.safetyCar;
  const lapNow = resolveSessionNow({ currentLap: 30, lapTimes: china.lap_times });
  r('China 2024 (R5), lap 30 (lap-mode clock, session time ' + u(lapNow, 3) + ' s): safety-car rate');
  r(`  HEAD scRate ${u(head.scRate, 4)} per lap (track-status rows with status 4/6/7, any time, / currentLap, capped at 0.1)`);
  r(`  new  scRate ${u(now.scRate, 4)} per lap (source ${sc.source}): ${sc.episodes} episodes (${sc.scEpisodes} SC) started by now over ${sc.laps} leader laps, observed ${u(sc.observedRate, 4)}; prior ${u(sc.prior.episodesPerRace, 3)} episodes / ${u(sc.prior.lapsPerRace, 2)} laps x ${sc.prior.weightRaces} race`);
  r(`  completed episode lengths (laps): SC [${sc.durations.SC.join(' ')}], VSC [${sc.durations.VSC.join(' ')}]; ongoing: ${sc.ongoing ? `${sc.ongoing.type} since lap ${sc.ongoing.startLap}` : 'none'}`);
  const future = [...china.track_status, { status: '4', start_time: lapNow + 600, end_time: lapNow + 900, message: 'SCDeployed' }];
  const headF = HEAD.extractRaceParams(china.lap_times, china.tyre_strategy, future, 30);
  const nowF = extractRaceParams(china.lap_times, china.tyre_strategy, future, 30);
  r(`  with an extra SC period 600 s after now: HEAD ${u(headF.scRate, 4)}, new ${u(nowF.scRate, 4)} (unchanged: ${nowF.scRate === now.scRate})`);
  const end = extractRaceParams(china.lap_times, china.tyre_strategy, china.track_status, maxLapOf(china.lap_times), { sessionNow: Infinity });
  r(`  race over: new scRate ${u(end.scRate, 4)} (${end.estimates.safetyCar.episodes} episodes / ${end.estimates.safetyCar.laps} laps)`);
  const mz = extractRaceParams(MZ, monza.tyre_strategy, monza.track_status, 30);
  const hz = HEAD.extractRaceParams(MZ, monza.tyre_strategy, monza.track_status, 30);
  r(`  Monza 2024 lap 30 (no episode): HEAD ${u(hz.scRate, 4)}, new ${u(mz.scRate, 4)} (source ${mz.estimates.safetyCar.source})`);
}
r('');

r('What-if (compareStrategies, Monza 2024 lap 12, focus LEC, same seed):');
{
  const feats = extractRaceSituationFeatures({ lapTimes: MZ, currentLap: 12, dnfMap: {} });
  const base = {
    driverFeatures: feats.driverFeatures, currentLap: 12, maxLap: mzMax, lapTimes: MZ,
    trackStatus: monza.track_status, focusDriver: 'LEC', seed: 7,
  };
  const cases = [
    ['plan = basePlan (stop lap 15 HARD)', [{ lap: 15, compound: 'HARD' }], [{ lap: 15, compound: 'HARD' }]],
    ['stop lap 15 HARD vs stop model', [{ lap: 15, compound: 'HARD' }], undefined],
    ['stop lap 25 HARD vs stop lap 15 HARD', [{ lap: 25, compound: 'HARD' }], [{ lap: 15, compound: 'HARD' }]],
    ['two stops 15 HARD + 35 MEDIUM vs stop lap 15 HARD', [{ lap: 15, compound: 'HARD' }, { lap: 35, compound: 'MEDIUM' }], [{ lap: 15, compound: 'HARD' }]],
  ];
  r('  case                                              E[pos] base -> plan   delta.position  paired: mean pos change  P(gain)  P(loss)  mean time delta (s)');
  for (const [label, plan, basePlan] of cases) {
    const c = compareStrategies({ ...base, plan, basePlan });
    r(`  ${pad(label, 50)} ${lpad(c.baseline.expectedPos, 5)} -> ${lpad(c.plan.expectedPos, 5)}   ${lpad(f(c.delta.position, 1), 6)}          ${lpad(f(c.paired.meanPositionChange, 3), 7)}             ${u(c.paired.probGain, 3)}    ${u(c.paired.probLoss, 3)}    ${f(c.paired.meanTimeDelta, 2)}`);
  }
}
r('');

// ══════════════════════════════════════════════════════════
r('=== 4. Backtest: every cached race at 25 / 50 / 75 % of the distance (lap-mode clock) ===');
r('Remaining stops: per driver (non-finishers excluded) predicted mean vs actual stops after the clock.');
r('Expected position: predicted expectedPos vs the classification (race_results Position), same drivers.');
const back = { 0.25: [], 0.5: [], 0.75: [] };
const backAlt = VARIANTS.slice(1).map(() => ({ 0.25: [], 0.5: [], 0.75: [] }));
const perRace = [];
for (const rc of races) {
  const s = sessionOf(rc.year, rc.round);
  const lt = s.lap_times;
  const maxLap = maxLapOf(lt);
  const finalPos = {};
  for (const x of s.race_results || []) if (x.Abbreviation && x.Position != null) finalPos[x.Abbreviation] = x.Position;
  const line = [];
  for (const frac of [0.25, 0.5, 0.75]) {
    const lap = Math.max(5, Math.round(maxLap * frac));
    const res = projectionsBoth(s, lap, seedFrom('mc_backtest', rc.year, rc.round, lap), true);
    if (!res?.now || !res?.head) continue;
    const act = actualRemaining(s, lap);
    res.alt.forEach((alt, k) => {
      for (const p of alt.projections) {
        const a = act[p.driver];
        if (!a) continue;
        backAlt[k][frac].push({ act: a.remaining, n: p.pitStopsRemaining.mean, np: p.expectedPos, fp: finalPos[p.driver] });
      }
    });
    const rows = [];
    for (const p of res.now.projections) {
      const a = act[p.driver];
      const h = res.head.projections.find((x) => x.driver === p.driver);
      if (!a || !h) continue;
      rows.push({ act: a.remaining, n: p.pitStopsRemaining.mean, h: h.pitStopsRemaining.mean, np: p.expectedPos, hp: h.expectedPos, fp: finalPos[p.driver] });
    }
    back[frac].push(...rows);
    const mae = (k) => mean(rows.map((x) => Math.abs(x[k] - x.act)));
    line.push(`${Math.round(frac * 100)}% L${lap}: stops MAE HEAD ${u(mae('h'), 2)} new ${u(mae('n'), 2)}`);
  }
  perRace.push(`  ${pad(`${rc.year} R${rc.round}`, 10)} ${line.join(' | ')}`);
}
for (const l of perRace) r(l);
r('');
r('  clock   drivers   stops MAE HEAD   new    bias HEAD   new    | position MAE HEAD   new');
for (const frac of [0.25, 0.5, 0.75]) {
  const rows = back[frac];
  const pr = rows.filter((x) => x.fp != null);
  r(`  ${lpad(Math.round(frac * 100) + '%', 4)}   ${lpad(rows.length, 6)}    ${u(mean(rows.map((x) => Math.abs(x.h - x.act))), 3)}         ${u(mean(rows.map((x) => Math.abs(x.n - x.act))), 3)}  ${f(mean(rows.map((x) => x.h - x.act)), 3)}      ${f(mean(rows.map((x) => x.n - x.act)), 3)}  |   ${u(mean(pr.map((x) => Math.abs(x.hp - x.fp))), 3)}          ${u(mean(pr.map((x) => Math.abs(x.np - x.fp))), 3)}`);
}
r('');
r('Variants of the new engine (same seeds and parameters; only the named option changes):');
r('  variant                                          clock  stops MAE   bias    position MAE');
VARIANTS.forEach(([label], k) => {
  for (const frac of [0.25, 0.5, 0.75]) {
    const rows = k === 0 ? back[frac] : backAlt[k - 1][frac];
    const pr = rows.filter((x) => x.fp != null);
    r(`  ${pad(label, 48)} ${lpad(Math.round(frac * 100) + '%', 4)}   ${u(mean(rows.map((x) => Math.abs(x.n - x.act))), 3)}   ${f(mean(rows.map((x) => x.n - x.act)), 3)}   ${u(mean(pr.map((x) => Math.abs(x.np - x.fp))), 3)}`);
  }
});
r('');

// ══════════════════════════════════════════════════════════
r('=== 5. Runtime and badge stability ===');
const timeIt = (fn, reps) => {
  const ts = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
};
{
  const lap = 30;
  const feats = extractRaceSituationFeatures({ lapTimes: MZ, currentLap: lap, dnfMap: {} });
  const args = {
    driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: mzMax, lapTimes: MZ,
    strategies: monza.tyre_strategy, trackStatus: monza.track_status,
  };
  const tParams = timeIt(() => extractRaceParams(MZ, [], monza.track_status, lap), 5);
  const params = extractRaceParams(MZ, [], monza.track_status, lap);
  r(`Runtime, Monza 2024 lap ${lap}, ${Object.keys(feats.driverFeatures).length} drivers, ${mzMax - lap + 1} laps simulated (median of repeats, Node ${process.version}, this machine):`);
  r(`  extractRaceParams: ${u(tParams, 1)} ms`);
  r(`  HEAD simulateRaceFinish (100 sims, params included): ${u(timeIt(() => seededRandom(1, () => HEAD.simulateRaceFinish(args)), 5), 1)} ms`);
  for (const n of [100, 1000, 10000]) {
    const reps = n >= 10000 ? 3 : 5;
    const tFull = timeIt(() => simulateRaceFinish({ ...args, numSimulations: n, seed: 1 }), reps);
    const tCore = timeIt(() => simulateRaceFinish({ ...args, numSimulations: n, seed: 1, raceParams: params }), reps);
    r(`  new simulateRaceFinish ${lpad(n, 6)} sims: ${lpad(u(tFull, 1), 8)} ms (with extractRaceParams), ${lpad(u(tCore, 1), 8)} ms (params given)`);
  }
}
r('');
r('Badge stability: the same race state recomputed with a new seed each time, the badges as the views draw them.');
r('  rule (now): podium >= 50 %, battle >= 30 % (gold) / >= 60 % (green), each state kept unless the 95 % Wilson');
r('       interval of the share lies entirely on the other side of the threshold (simulationClient.js badgeOn),');
r('       chained recompute after recompute with projectionBadges as the store does (computeRaceProjection);');
r(`       battles listed (listedBattles: RacePredictionPanel, StrategyAnalysis, insights, Gemini) = the pairs that are, beyond`);
r(`       the Monte Carlo error, among the ${BATTLE_LIST_SIZE} most likely: one not listed enters when fewer than ${BATTLE_LIST_SIZE} other pairs`);
r(`       reach its Wilson interval, a listed one stays until ${BATTLE_LIST_SIZE} others are surely more likely; no fill`);
r('       (scripts/battle_list_rules.mjs compares it with the cut + fill rule).');
r('       The Leaderboard colours its adjacent pairs with the same badge levels.');
r('  bare (before): the same thresholds on the point estimate, battles listed = the engine\'s former top-6 cut');
r('       (prob >= 5 %, six most likely), emulated on the same results.');
r('  A flip = two consecutive recomputes with a different state; "listed on both" = colour flips of rows listed');
r('  both times; "rows in / out" = listed rows appearing or disappearing, over the rows listed; last column =');
r('  recomputes where at least one listed (gold / green) battle row appears or disappears.');
const STABILITY_STATES = [[2024, 16, 30], [2024, 5, 30], [2024, 1, 30], [2024, 3, 25], [2024, 7, 30], [2024, 11, 40],
  [2024, 15, 35], [2024, 20, 30], [2024, 22, 25], [2025, 1, 30], [2025, 16, 30], [2025, 21, 40]]
  .filter(([y, rd]) => sessionOf(y, rd));
/** Inputs of the store's projection at a lap-mode clock (sessionNow from the lap, as simulationJob). */
function projectionState(y, rd, lap) {
  const s = sessionOf(y, rd);
  const lt = s.lap_times;
  const sessionNow = resolveSessionNow({ currentLap: lap, lapTimes: lt });
  const sessionTimeOffset = computeSessionTimeOffset(lt);
  const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow, sessionTimeOffset });
  const args = {
    driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: maxLapOf(lt), lapTimes: lt, trackStatus: s.track_status,
    sessionNow, sessionTimeOffset, sessionType: 'R',
  };
  return { ...args, raceParams: extractRaceParams(lt, [], s.track_status, lap, { sessionNow, sessionType: 'R' }) };
}
/** The views' state of one result: podium states, listed battles -> level. */
const ruleView = (res, badges) => ({
  podium: badges.podium,
  listed: new Map(listedBattles({ ...res, badges }).map((b) => [battleKey(b), b.level])),
});
const bareView = (res) => {
  const podium = {};
  for (const p of res.projections) podium[p.driver] = p.podiumProb >= PODIUM_BADGE_PCT;
  const listed = new Map(res.battles.filter((b) => b.prob >= 5).slice(0, 6)
    .map((b) => [battleKey(b), BATTLE_BADGE_PCT.filter((t) => b.prob >= t).length]));
  return { podium, listed };
};
function compareViews(a, b, acc) {
  for (const d of Object.keys(b.podium)) { acc.podPairs += 1; if (!!a.podium[d] !== !!b.podium[d]) acc.podFlips += 1; }
  let changed = false;
  for (const key of new Set([...a.listed.keys(), ...b.listed.keys()])) {
    if (a.listed.has(key) && b.listed.has(key)) {
      acc.bothPairs += 1;
      if (a.listed.get(key) !== b.listed.get(key)) acc.colourFlips += 1;
    } else {
      acc.rowChanges += 1;
      if ((a.listed.get(key) ?? b.listed.get(key)) >= 1) changed = true;
    }
  }
  acc.rowSlots += Math.max(a.listed.size, b.listed.size);
  acc.recomputes += 1;
  if (changed) acc.recomputesWithRowChange += 1;
}
const newAcc = () => ({
  podPairs: 0, podFlips: 0, bothPairs: 0, colourFlips: 0, rowChanges: 0, rowSlots: 0, recomputes: 0, recomputesWithRowChange: 0,
});
const ratio = (a, b) => `${a} / ${b} (${b ? u((100 * a) / b, 2) : '-'}%)`;
r(`  runs   states x seeds  kind  ${pad('podium flips', 22)}${pad('colour flips, listed on both', 31)}${pad('rows in / out', 20)}recomputes with a row in / out`);
for (const n of [100, 1000, 10000]) {
  if (QUICK && n === 10000) continue;
  const states = n >= 10000 ? STABILITY_STATES.slice(0, 3) : STABILITY_STATES;
  const seeds = n >= 10000 ? 10 : 20;
  const acc = { rule: newAcc(), bare: newAcc() };
  const sds = [];
  for (const [y, rd, lap] of states) {
    const st = projectionState(y, rd, lap);
    let prevBadges = null;
    let prev = null;
    const series = new Map(); // item -> probabilities over the seeds (pp)
    const add = (key, v) => { if (!series.has(key)) series.set(key, []); series.get(key).push(v); };
    for (let k = 0; k < seeds; k++) {
      const res = simulateRaceFinish({ ...st, numSimulations: n, seed: seedFrom('badge-stability', y, rd, lap, k) });
      for (const p of res.projections) add(`P:${p.driver}`, p.podiumProb);
      for (const b of res.battles) add(`B:${battleKey(b)}`, b.prob);
      const badges = projectionBadges(res, prevBadges);
      const view = { rule: ruleView(res, badges), bare: bareView(res) };
      if (prev) for (const kind of ['rule', 'bare']) compareViews(prev[kind], view[kind], acc[kind]);
      prev = view;
      prevBadges = badges;
    }
    for (const v of series.values()) {
      if (v.length < 2) continue;
      const m = mean(v);
      sds.push(Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)));
    }
  }
  r(`  ${lpad(n, 5)}  ${lpad(`${states.length} x ${seeds}`, 14)}  sd of a probability over the seeds (every podium and battle item): median ${u(median(sds), 2)} pp, max ${u(Math.max(...sds), 2)} pp`);
  for (const kind of ['rule', 'bare']) {
    const a = acc[kind];
    r(`  ${lpad(n, 5)}  ${lpad(`${states.length} x ${seeds}`, 14)}  ${pad(kind, 4)}  ${pad(ratio(a.podFlips, a.podPairs), 22)}${pad(ratio(a.colourFlips, a.bothPairs), 31)}`
      + `${pad(ratio(a.rowChanges, a.rowSlots), 20)}${ratio(a.recomputesWithRowChange, a.recomputes)}`);
  }
}
r(`  (states: ${STABILITY_STATES.map(([y, rd, lap]) => `${y} R${rd} L${lap}`).join(', ')}; 10,000 runs: the first 3 states, 10 seeds)`);
r('');

r('Every mark the views draw from a projection, the same race state recomputed with a new seed each time (every');
r('cached race at 25 / 50 / 75 % of the distance, lap-mode clock), chained recompute after recompute as the store');
r('does (projectionBadges with the projection\'s inputs, so the risk rows too):');
r('  rule (now): the Race Prediction row label P{n} = modePosition (the most likely position; the previous one');
r('       stays while its share is within the Wilson interval of the most frequent one), gold when n <= 3;');
r('       battles in listedBattles order (badge level, then race order), so the StrategyAnalysis insight cards');
r('       (first 3 gold / green listed) and the assistant\'s quick query (first listed) follow levels and the list;');
r('       risk rows = evaluateRisks against the previous levels (P5 / P95 ends of the range and the mean stops to');
r('       come judged beyond their sampling interval), most severe first, then race order, at most RISK_LIST_SIZE;');
r('       the insight \'high outcome variance\' cards = the first 2 HIGH VARIANCE risk rows.');
r('  bare (point estimates): label modePos; battles = top 6 by probability, ordered by probability, levels from');
r('       the point estimate; risk rows = the same rules on the point estimates, ordered by severity then by');
r('       projection order; variance cards = range >= 6 places, first 2 in projection order.');
r('  Counted: recomputes where the mark differs from the previous recompute (any row of the race).');
{
  const SEEDS_MARKS = QUICK ? 4 : 10;
  const marks = ['gold P label', 'P label', 'insight battle cards (set)', 'assistant quick-query battle', 'risk rows (driver, type, severity; set)', 'variance insight cards (set)', 'listed battles (set)'];
  const acc = { rule: Object.fromEntries(marks.map((m) => [m, 0])), bare: Object.fromEntries(marks.map((m) => [m, 0])) };
  const byFrac = {};
  let recomputes = 0;
  const bareLevel = (b) => BATTLE_BADGE_PCT.filter((t) => b.prob >= t).length;
  const marksOf = (res, badges, st, kind) => {
    if (kind === 'rule') {
      const proj = { ...res, badges, risks: badges.risks };
      const listed = listedBattles(proj);
      const ins = generateInsights({ raceProjection: proj, currentLap: st.currentLap, maxLap: st.maxLap });
      const label = Object.fromEntries(res.projections.map((p) => [p.driver, modePosition(proj, p)]));
      return {
        'gold P label': Object.entries(label).filter(([, v]) => v <= 3).map(([d]) => d).sort().join(','),
        'P label': JSON.stringify(Object.entries(label).sort()),
        'insight battle cards (set)': ins.filter((i) => i.category === 'battle').map((i) => `${i.id}:${i.severity}`).sort().join('|'),
        'assistant quick-query battle': listed[0] ? battleKey(listed[0]) : '',
        'risk rows (driver, type, severity; set)': badges.risks.map((x) => `${x.driver}:${x.type}:${x.severity}`).sort().join('|'),
        'variance insight cards (set)': ins.filter((i) => i.id.startsWith('uncertain-')).map((i) => i.id).sort().join('|'),
        'listed battles (set)': listed.map(battleKey).sort().join('|'),
      };
    }
    const listed = [...res.battles].sort((a, b) => b.prob - a.prob).slice(0, BATTLE_LIST_SIZE).map((b) => ({ ...b, level: bareLevel(b) }));
    const cards = listed.filter((b) => b.level >= 1).slice(0, 3).map((b) => `battle-${b.behind}-${b.ahead}:${b.level >= 2 ? 'high' : 'notable'}`);
    const order = new Map(res.projections.map((p, i) => [p.driver, i]));
    const SEV = { high: 0, medium: 1, low: 2 };
    const pointRisks = evaluateRisks(res.projections, st.driverFeatures, res.raceParams, st.currentLap, st.maxLap).rows
      .sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || (order.get(a.driver) - order.get(b.driver)))
      .slice(0, RISK_LIST_SIZE);
    const label = Object.fromEntries(res.projections.map((p) => [p.driver, p.modePos]));
    return {
      'gold P label': Object.entries(label).filter(([, v]) => v <= 3).map(([d]) => d).sort().join(','),
      'P label': JSON.stringify(Object.entries(label).sort()),
      'insight battle cards (set)': cards.sort().join('|'),
      'assistant quick-query battle': listed[0] ? battleKey(listed[0]) : '',
      'risk rows (driver, type, severity; set)': pointRisks.map((x) => `${x.driver}:${x.type}:${x.severity}`).sort().join('|'),
      'variance insight cards (set)': res.projections.filter((p) => p.posRange[1] - p.posRange[0] >= 6).slice(0, 2).map((p) => `uncertain-${p.driver}`).sort().join('|'),
      'listed battles (set)': listed.map(battleKey).sort().join('|'),
    };
  };
  for (const rc of races) {
    const ml = maxLapOf(sessionOf(rc.year, rc.round).lap_times);
    for (const frac of [0.25, 0.5, 0.75]) {
      const lap = Math.max(5, Math.round(ml * frac));
      const st = projectionState(rc.year, rc.round, lap);
      if (!st.driverFeatures) continue;
      let prevBadges = null;
      let prev = null;
      for (let k = 0; k < SEEDS_MARKS; k++) {
        const res = simulateRaceFinish({ ...st, seed: seedFrom('view-marks', rc.year, rc.round, lap, k) });
        if (!res) break;
        const badges = projectionBadges(res, prevBadges, { driverFeatures: st.driverFeatures, currentLap: lap, maxLap: st.maxLap });
        const now = { rule: marksOf(res, badges, st, 'rule'), bare: marksOf(res, badges, st, 'bare') };
        if (prev) {
          recomputes += 1;
          const fr = (byFrac[frac] = byFrac[frac] || { n: 0, rule: Object.fromEntries(marks.map((m) => [m, 0])), bare: Object.fromEntries(marks.map((m) => [m, 0])) });
          fr.n += 1;
          for (const kind of ['rule', 'bare']) {
            for (const m of marks) {
              if (now[kind][m] !== prev[kind][m]) { acc[kind][m] += 1; fr[kind][m] += 1; }
            }
          }
        }
        prev = now;
        prevBadges = badges;
      }
    }
  }
  r(`  ${races.length} races x 3 clocks x ${SEEDS_MARKS} seeds, ${DEFAULT_NUM_SIMULATIONS} runs: ${recomputes} recomputes`);
  r(`  ${pad('mark', 44)}${pad('rule', 22)}bare`);
  for (const m of marks) r(`  ${pad(m, 44)}${pad(ratio(acc.rule[m], recomputes), 22)}${ratio(acc.bare[m], recomputes)}`);
  r('  by clock (rule / bare), recomputes with a change:');
  for (const frac of Object.keys(byFrac).sort()) {
    const fr = byFrac[frac];
    r(`    ${lpad(Math.round(frac * 100) + '%', 4)} (${fr.n}): ${marks.filter((m) => m !== 'P label' && m !== 'listed battles (set)')
      .map((m) => `${m.split(' (')[0]} ${fr.rule[m]} / ${fr.bare[m]}`).join('; ')}`);
  }
}
r('');
r('Lap by lap (laps 10-50, lap-mode clock), the store\'s chain re-run with 5 seed salts on the same data: a blink');
r('(a gold / green battle row listed, gone, listed again on three consecutive laps, or the reverse) found under');
r('every salt comes from the data; one found under some salts only comes from the Monte Carlo noise.');
for (const [y, rd] of [[2024, 16], [2024, 5]]) {
  if (!sessionOf(y, rd)) continue;
  const SALTS = QUICK ? 2 : 5;
  const ml = maxLapOf(sessionOf(y, rd).lap_times);
  const runs = [];
  for (let salt = 0; salt < SALTS; salt++) {
    let prevBadges = null;
    const seq = [];
    for (let lap = 10; lap <= Math.min(50, ml - 1); lap++) {
      const st = projectionState(y, rd, lap);
      const res = simulateRaceFinish({ ...st, seed: seedFrom('lap-salt', salt, y, rd, lap) });
      const badges = projectionBadges(res, prevBadges, { driverFeatures: st.driverFeatures, currentLap: lap, maxLap: st.maxLap });
      prevBadges = badges;
      seq.push({ lap, listed: new Map(listedBattles({ ...res, badges }).map((b) => [battleKey(b), b.level])) });
    }
    runs.push(seq);
  }
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
  const inEvery = [...all].filter((k) => blinkSets.every((s) => s.has(k))).length;
  let diffLaps = 0;
  for (let i = 0; i < runs[0].length; i++) {
    if (new Set(runs.map((seq) => [...seq[i].listed.keys()].sort().join(','))).size > 1) diffLaps += 1;
  }
  r(`  ${y} R${rd}: blinks per salt ${blinkSets.map((s) => s.size).join(', ')}; distinct ${all.size}: under every salt ${inEvery}, under some only ${all.size - inEvery}; laps where the listed battles differ between salts: ${diffLaps} / ${runs[0].length}`);
}
r('');
r('Lap by lap through the store (the app\'s path: computeRaceProjection, its seed from the session and the clock, badges');
r('chained from the previous lap), Monza 2024 laps 10-50, lap-mode clock. Each lap also brings new data, so a change');
r('here is not all Monte Carlo noise. A blink = a gold / green battle row listed, gone, listed again on three');
r('consecutive laps, or the reverse.');
{
  const viewsByKind = { rule: [], bare: [] };
  const s = sessionOf(2024, 16);
  const lt = s.lap_times;
  const offset = computeSessionTimeOffset(lt);
  const INITIAL = useF1Store.getState();
  for (let lap = 10; lap <= 50; lap++) {
    const sessionNow = resolveSessionNow({ currentLap: lap, lapTimes: lt });
    const raceSituationData = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow, sessionTimeOffset: offset });
    useF1Store.setState({
      year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R', sessionData: s, trackStatus: s.track_status || [],
      sessionTimeOffset: offset, maxLap: maxLapOf(lt), totalRaceLaps: null, currentLap: lap, totalFrames: 0, currentTime: 0,
      raceSituationData,
    });
    useF1Store.getState().computeRaceProjection();
    const p = useF1Store.getState().raceProjection;
    const probs = new Map(p.battles.map((b) => [battleKey(b), b.prob]));
    viewsByKind.rule.push({ ...ruleView(p, p.badges), probs });
    viewsByKind.bare.push({ ...bareView(p), probs });
  }
  for (const kind of ['rule', 'bare']) {
    const seq = viewsByKind[kind];
    let blinks = 0;
    let rowChanges = 0;
    let outOfWindow = 0;
    const jumps = [];
    for (let i = 1; i < seq.length; i++) {
      for (const key of new Set([...seq[i - 1].listed.keys(), ...seq[i].listed.keys()])) {
        if (seq[i - 1].listed.has(key) !== seq[i].listed.has(key)) rowChanges += 1;
      }
    }
    for (let i = 2; i < seq.length; i++) {
      for (const key of new Set([...seq[i - 2].listed.keys(), ...seq[i - 1].listed.keys(), ...seq[i].listed.keys()])) {
        const [a, b, c] = [seq[i - 2], seq[i - 1], seq[i]].map((v) => v.listed.get(key));
        if (!((a >= 1 && b === undefined && c >= 1) || (a === undefined && b >= 1 && c === undefined))) continue;
        blinks += 1;
        // why: the pair is not within 4 positions on one of the laps (the
        // engine has no probability for it), or its probability moved
        const pr = [seq[i - 2], seq[i - 1], seq[i]].map((v) => v.probs.get(key));
        if (pr.some((x) => x === undefined)) outOfWindow += 1;
        else jumps.push(Math.max(Math.abs(pr[1] - pr[0]), Math.abs(pr[2] - pr[1])));
      }
    }
    r(`  ${pad(kind, 4)}  listed rows appearing / disappearing between laps: ${lpad(rowChanges, 4)}; one-lap blinks of a gold / green row: ${blinks}`
      + ` (pair not within 4 positions on one of the 3 laps: ${outOfWindow}; otherwise the largest one-lap probability change`
      + ` of the pair, min / median: ${jumps.length ? `${Math.min(...jumps)} / ${median(jumps)} pp` : '-'})`);
  }
  useF1Store.setState({ ...INITIAL });
}
r('');

const text = report.join('\n');
fs.writeFileSync(OUT_FILE, `${text}\n`);
console.log(text);
console.log(`\nwritten ${path.relative(ROOT, OUT_FILE)}`);
