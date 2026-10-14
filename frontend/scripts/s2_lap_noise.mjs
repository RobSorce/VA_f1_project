/**
 * S2 done-when (lead decision D1), Monza 2024 (2024 R16): the degradation and
 * the lap noise the Monte Carlo engine uses (utils/raceSimulation.js
 * extractRaceParams, the same object the store's projection and the Race
 * Prediction panel read), at every lap-mode clock (the leader starts lap L,
 * raceTime.resolveSessionNow) and at the race end:
 *  - MEDIUM / HARD degradation (degradationFor: fuel-corrected s per lap of
 *    tyre age, the race's fits long enough combined with the prior, else the
 *    prior), with the fits kept as diagnostics (all fits, negative ones);
 *  - lap noise = the pooled residual sigma of the per-stint fits at the clock
 *    (lapNoiseFromFits, D1: no floor, no prior mixed in) with its n (clean
 *    laps, stints, degrees of freedom), as the panel shows it.
 * D1: the 0.3-0.6 s band is checked at the leader's laps 20, 30, 40 and at
 * the race end; the earlier clocks are listed with their n.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/s2_lap_noise.mjs
 * Writes notes/experiments/phase45c/s2_lap_noise_monza.txt and prints the same text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRaceParams, degradationFor, lapNoiseFromFits, PRIORS,
} from '../src/utils/raceSimulation.js';
import { stintFits, FUEL_EFFECT_S_PER_LAP } from '../src/utils/degradation.js';
import { resolveSessionNow } from '../src/utils/raceTime.js';
import { causalKey } from '../src/utils/strategyViews.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT_FILE = path.resolve(ROOT, 'notes/experiments/phase45c/s2_lap_noise_monza.txt');
const s = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'backend/data/processed_cache/session_2024_16_R.json'), 'utf8')
  .replace(/\bNaN\b/g, 'null'));
const lt = s.lap_times;
const ts = s.track_status || [];
const maxLap = Math.max(...lt.map((r) => Number(r.LapNumber) || 0));
const lines = [];
const out = (x = '') => { lines.push(x); console.log(x); };
const f3 = (v) => (v == null ? '   -  ' : (v >= 0 ? ' ' : '') + v.toFixed(4));

out('S2, Monza 2024 (2024 R16): degradation and lap noise of the Monte Carlo engine (extractRaceParams)');
out(`fuel correction: ${FUEL_EFFECT_S_PER_LAP} s per lap of fuel (degradation.js FUEL_EFFECT_S_PER_LAP, an assumption)`);
out(`lap noise before a race's first fit: the cached dry races' value ${PRIORS.lapNoise.dry.value} s (source prior, n = 0)`);
out('');
out('clock            MEDIUM deg  src    used/all fits (neg)   HARD deg  src    lap noise  src    n laps  stints  dof');
const row = (label, now, lap) => {
  const p = extractRaceParams(lt, [], ts, lap, { sessionNow: now, sessionType: 'R' });
  const m = degradationFor(p, 'MEDIUM');
  const h = degradationFor(p, 'HARD');
  const mAll = p.tyreDeg.MEDIUM?.allFits;
  const e = p.estimates.lapNoise;
  out(`${label.padEnd(16)} ${f3(m.mean)}     ${m.source.padEnd(5)}  ${String(p.tyreDeg.MEDIUM?.n ?? 0).padStart(4)}/${String(mAll?.n ?? 0).padEnd(3)} (${mAll?.negativeCount ?? 0})`
    + `           ${f3(h.mean)}   ${h.source.padEnd(5)}  ${p.lapNoise.toFixed(3)}      ${e.source.padEnd(5)}  ${String(e.laps).padStart(6)}  ${String(e.stints).padStart(6)}  ${String(e.dof).padStart(4)}`);
  return { p, m, h, e };
};
const lapRows = {};
for (let lap = 5; lap < maxLap; lap++) {
  const now = resolveSessionNow({ currentLap: lap, lapTimes: lt });
  lapRows[lap] = row(`lap ${lap} (t=${now.toFixed(0)})`, now, lap);
}
const end = row('race end', Infinity, maxLap);
out('');
out('D1 check: lap noise 0.3-0.6 s at the leader\'s laps 20, 30, 40 (lap-mode clock: the leader starts that lap) and at the race end');
let pass = 0;
const checks = [[20, lapRows[20]], [30, lapRows[30]], [40, lapRows[40]], ['end', end]];
for (const [lap, r] of checks) {
  const v = r.p.lapNoise;
  const ok = v >= 0.3 && v <= 0.6;
  if (ok) pass += 1;
  out(`  ${lap === 'end' ? 'race end' : `lap ${lap}`}: ${v.toFixed(3)} s (n = ${r.e.laps} clean laps, ${r.e.stints} stints, dof ${r.e.dof}, source ${r.e.source}) -> ${ok ? 'in band' : 'OUT OF BAND'}`);
}
out(`  in band: ${pass} / ${checks.length}`);
out('');
out('S2 check: MEDIUM degradation > 0 after fuel correction');
const lapsM = Object.entries(lapRows).filter(([, r]) => !(r.m.mean > 0)).map(([l]) => l);
out(`  lap-mode clocks with MEDIUM <= 0: ${lapsM.length ? lapsM.join(', ') : 'none'} (of ${Object.keys(lapRows).length})`);
out(`  race end: MEDIUM ${end.m.mean.toFixed(4)} s/lap (${end.m.source}; fits used ${end.p.tyreDeg.MEDIUM.n}, all ${end.p.tyreDeg.MEDIUM.allFits.n} of which negative ${end.p.tyreDeg.MEDIUM.allFits.negativeCount}, kept as diagnostics)`);
out('');
// Sub-lap replay clocks right after the lap-mode clock of lap 10 (each new causal key)
out('Sub-lap replay clocks after the leader starts lap 10 (each clock where something new is known, causalKey)');
out('  t (s)    lap noise  n laps  stints');
const t10 = resolveSessionNow({ currentLap: 10, lapTimes: lt });
let prevKey = null;
for (let t = Math.floor(t10); t <= t10 + 30; t += 1) {
  const key = causalKey(lt, t, ts);
  if (key === prevKey) continue;
  prevKey = key;
  const e = lapNoiseFromFits(stintFits(lt, { sessionNow: t }));
  out(`  ${String(t).padStart(6)}   ${e.value.toFixed(3)}  ${e.source.padEnd(5)}  ${String(e.laps).padStart(6)}  ${String(e.stints).padStart(6)}`);
}
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
