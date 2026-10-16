// The consistency cards (utils/views/degradationViews.js consistencyView)
// and the backend's /consistency payload (backend/api/routers/analytics.py
// consistency_response) are one definition: per driver the same sigma (the
// pooled residual sigma of the per-stint fits, to 1e-9), the same
// is_consistent (sigma <= the TRUE median of the listed drivers, D10), the
// same laps behind the sigma (sample_size, outliers), the same avg_lap (the
// backend rounds it to the ms) and the same insufficient_data (laps completed
// below 75 % of the most laps completed). Every cached race, at the whole
// race and at the leader's end of 1/3 and 2/3 of the laps. The Python side is
// executed here (backend venv), nothing is hard-coded. Skips without the venv
// or the git-ignored cache. With WRITE_EVIDENCE=1 the summary is also written
// to docs/evidence/g5_consistency_parity.txt.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consistencyView } from '../utils/views/degradationViews.js';
import { leaderLapEndTime } from '../utils/raceTime.js';
import { CACHE_DIR, listCachedRaces } from './helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../backend');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const RACES = listCachedRaces().sort((a, b) => (a.year - b.year) || (a.round - b.round));
// Python's json writes bare NaN; JSON.parse rejects it, so it is read as null on both sides
const parseJson = (t) => JSON.parse(t.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));

const PY = `
import json, math, os, sys
from api.routers.analytics import consistency_response
req = json.load(sys.stdin)
out = {}
for f, clocks in req.items():
    with open(f, encoding='utf-8') as fh:
        d = json.load(fh)
    res = []
    for now in clocks:
        p = consistency_response(d.get('lap_times') or [], d.get('driver_info') or [], session_now=now)
        res.append({r['driver']: {k: r.get(k) for k in (
            'sigma', 'is_consistent', 'avg_lap', 'insufficient_data', 'sample_size', 'outliers',
            'laps_completed')} for r in p['drivers']})
    out[f] = res
print(json.dumps(out))
`;

const OUT = [];
afterAll(() => {
  const file = path.resolve(HERE, '../../../docs/evidence/g5_consistency_parity.txt');
  if (OUT.length && process.env.WRITE_EVIDENCE) fs.writeFileSync(file, `${OUT.join('\n')}\n`);
});

function clocksOf(laps) {
  let maxLap = 0;
  for (const lt of laps) maxLap = Math.max(maxLap, Number(lt.LapNumber) || 0);
  return [null, leaderLapEndTime(laps, Math.round(maxLap / 3)), leaderLapEndTime(laps, Math.round((2 * maxLap) / 3))];
}

describe.skipIf(!PYTHON || RACES.length === 0)('consistency cards == backend /consistency, every cached race', () => {
  it('sigma, is_consistent (true median), sample, avg_lap and LOW DATA per driver; Monza finishers sigma <= 0.8 s', () => {
    const sessions = Object.fromEntries(RACES.map((r) => [r.file, parseJson(fs.readFileSync(r.file, 'utf8'))]));
    const req = Object.fromEntries(RACES.map((r) => [r.file, clocksOf(sessions[r.file].lap_times || [])]));
    const res = spawnSync(PYTHON, ['-c', PY], {
      cwd: BACKEND, input: JSON.stringify(req), encoding: 'utf8', maxBuffer: 1 << 28,
    });
    if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
    const back = parseJson(res.stdout.trim().split('\n').pop());

    let rows = 0;
    let consistentRows = 0;
    let maxSigmaDiff = 0;
    let maxAvgDiff = 0;
    let evenFields = 0;
    for (const race of RACES) {
      const laps = sessions[race.file].lap_times || [];
      req[race.file].forEach((now, k) => {
        const view = consistencyView(laps, now == null ? Infinity : now);
        const py = back[race.file][k];
        const tag = `${race.year} R${race.round} clock ${k}`;
        expect(view.drivers.map((d) => d.driver).sort(), tag).toEqual(Object.keys(py).sort());
        if (view.drivers.length % 2 === 0 && view.drivers.length) evenFields++;
        for (const d of view.drivers) {
          const b = py[d.driver];
          const sd = Math.abs(d.std_dev - b.sigma);
          maxSigmaDiff = Math.max(maxSigmaDiff, sd);
          expect(sd, `${tag} ${d.driver} sigma`).toBeLessThan(1e-9);
          expect(d.is_consistent, `${tag} ${d.driver} is_consistent`).toBe(b.is_consistent);
          expect(d.sample_size, `${tag} ${d.driver} n`).toBe(b.sample_size);
          expect(d.outliers, `${tag} ${d.driver} outliers`).toBe(b.outliers);
          expect(d.laps_completed, `${tag} ${d.driver} laps`).toBe(b.laps_completed);
          expect(d.insufficient_data, `${tag} ${d.driver} LOW DATA`).toBe(b.insufficient_data);
          const ad = Math.abs(d.avg_lap - b.avg_lap);
          maxAvgDiff = Math.max(maxAvgDiff, ad);
          expect(ad, `${tag} ${d.driver} avg_lap`).toBeLessThanOrEqual(0.0005 + 1e-9);
          rows++;
          if (d.is_consistent) consistentRows++;
        }
      });
    }
    // Monza 2024: every classified finisher's sigma at the race end
    const monza = RACES.find((r) => r.year === 2024 && r.round === 16);
    let monzaLine = 'Monza 2024 not cached';
    if (monza) {
      const s = sessions[monza.file];
      const finishers = (s.race_results || []).filter((r) => /^\d+$/.test(String(r.ClassifiedPosition))).map((r) => r.Abbreviation);
      const by = Object.fromEntries(consistencyView(s.lap_times, Infinity).drivers.map((d) => [d.driver, d]));
      const sig = finishers.map((drv) => by[drv].std_dev);
      for (const drv of finishers) expect(by[drv].std_dev, drv).toBeLessThanOrEqual(0.8);
      monzaLine = `Monza 2024: ${finishers.length} finishers, sigma ${Math.min(...sig).toFixed(4)}-${Math.max(...sig).toFixed(4)} s (max <= 0.8)`;
    }
    OUT.push(`G5 parity: ${RACES.length} races x 3 clocks, ${rows} driver rows equal `
      + `(max |sigma diff| ${maxSigmaDiff.toExponential(2)}, max |avg_lap diff| ${maxAvgDiff.toFixed(6)} s), `
      + `${consistentRows} consistent, ${evenFields} race-clocks with an even field; ${monzaLine}`);
    console.log(OUT.join('\n'));
    expect(rows).toBeGreaterThan(1000);
    expect(evenFields).toBeGreaterThan(0);
  }, 300000);
});
