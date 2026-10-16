/**
 * Lap noise of the race projection between two lap-mode clocks (S2): the
 * value the store's projection uses at every replay clock where something new
 * is known (causalKey), Monza 2024, from the leader's start of lap 10 to 30 s
 * later, and which stint fit each new clock adds (its driver, the place the
 * driver crossed the line in, its residual sigma). The data for the decision
 * on the 0.3-0.6 s band: does it hold at sub-lap replay clocks or only at the
 * lap-mode clocks and at race level? (The band is checked at the leader's
 * laps 20, 30, 40 and at the race end by scripts/s2_lap_noise.mjs.)
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/lap_noise_subclock.mjs
 * Writes docs/evidence/lap_noise_subclock.txt and prints the same text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRaceParams, lapNoiseFromFits, PRIORS } from '../src/utils/raceSimulation.js';
import { stintFits } from '../src/utils/degradation.js';
import { resolveSessionNow } from '../src/utils/raceTime.js';
import { causalKey } from '../src/utils/strategyViews.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT_FILE = path.resolve(ROOT, 'docs/evidence/lap_noise_subclock.txt');
const s = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'backend/data/processed_cache/session_2024_16_R.json'), 'utf8')
  .replace(/\bNaN\b/g, 'null'));
const lt = s.lap_times;
const lines = [];
const out = (x = '') => { lines.push(x); console.log(x); };

out('Lap noise between lap-mode clocks, Monza 2024 (utils/raceSimulation.js lapNoiseFromFits)');
out(`lap noise = the race's pooled residual sigma (lead decision D1, no prior mixed in); before the first fit the cached dry races' ${PRIORS.lapNoise.dry.value} s`);
const t10 = resolveSessionNow({ currentLap: 10, lapTimes: lt });
out(`leader starts lap 10 at t = ${t10.toFixed(3)} s (the lap-mode clock of lap 10)`);
out('  t (s)      noise  race   dof  stints  fit added (driver, place on its lap 9, residual sigma s, clean laps)');
let prevKey = null;
let prevFits = new Set();
const pos9 = Object.fromEntries(lt.filter((r) => r.LapNumber === 9).map((r) => [r.Driver, r.Position]));
let below = 0;
let clocks = 0;
for (let t = Math.floor(t10); t <= t10 + 30; t += 1) {
  const key = causalKey(lt, t, s.track_status);
  if (key === prevKey) continue;
  prevKey = key;
  const p = extractRaceParams(lt, [], s.track_status, 10, { sessionNow: t, sessionType: 'R' });
  const e = p.estimates.lapNoise;
  const fits = stintFits(lt, { sessionNow: t }).filter((f) => f.slope != null && f.n > 2 && f.residualSigma != null);
  const ids = new Set(fits.map((f) => `${f.driver}/${f.stintNumber}`));
  const added = fits.filter((f) => !prevFits.has(`${f.driver}/${f.stintNumber}`))
    .map((f) => `${f.driver} P${pos9[f.driver] ?? '?'} ${f.residualSigma.toFixed(3)} n${f.n}`);
  prevFits = ids;
  clocks += 1;
  if (p.lapNoise < 0.3) below += 1;
  out(`  ${t.toFixed(0).padStart(6)}   ${p.lapNoise.toFixed(3)}  ${e.raceValue == null ? '  -  ' : e.raceValue.toFixed(3)}  ${String(e.dof).padStart(4)}  ${String(e.stints).padStart(6)}  ${added.join('; ')}`);
}
out(`clocks with something new: ${clocks}; lap noise below 0.3 s at ${below}`);
const all = lapNoiseFromFits(stintFits(lt, { sessionNow: Infinity }));
out(`race end: ${all.value.toFixed(3)} s (race ${all.raceValue.toFixed(3)} s, dof ${all.dof}, ${all.stints} stints)`);
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
