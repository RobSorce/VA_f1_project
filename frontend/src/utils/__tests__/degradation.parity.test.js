// Parity of the shared degradation definition on every cached race:
// src/utils/degradation.js vs backend/data/processors/degradation.py.
// Same clean laps and slow outliers (lap numbers), same per-stint fits, same
// compound degradation and the same consistency sigma of every driver, every
// number equal to 1e-9; at the whole race, at two clocks inside the race and
// with a lap range. The Python side is executed here (backend venv), nothing
// is hard-coded. Skips when the venv or the git-ignored cache is absent.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cleanStintLaps, stintFits, compoundDegradation, consistencySigma,
} from '../degradation.js';
import { leaderLapEndTime } from '../raceTime.js';
import { CACHE_DIR } from '../../__tests__/helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../../backend');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const RACES = fs.existsSync(CACHE_DIR)
  ? fs.readdirSync(CACHE_DIR).filter((f) => /^session_\d{4}_\d+_R\.json$/.test(f)).sort()
  : [];
const TOL = 1e-9;
const LAP_RANGE = { lapStart: 10, lapEnd: 25 };

// Python's json writes bare NaN; JSON.parse rejects it, so it is read as null on both sides
const parseJson = (text) => JSON.parse(text.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));
const loadRace = (file) => parseJson(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));

/** Clocks of each race: the whole race (null = Infinity) and the leader's end of 1/3 and 2/3 of the laps. */
function clocksOf(laps) {
  let maxLap = 0;
  for (const lt of laps) maxLap = Math.max(maxLap, Number(lt.LapNumber) || 0);
  return [null, leaderLapEndTime(laps, Math.round(maxLap / 3)), leaderLapEndTime(laps, Math.round((2 * maxLap) / 3))];
}

const PY = `
import json, math, os, sys
from data.processors.degradation import (
    clean_stint_laps, stint_fits, compound_degradation, consistency_sigma)
cache = sys.argv[1]
req = json.load(sys.stdin)
out = {}
for f, clocks in req['races'].items():
    with open(os.path.join(cache, f), encoding='utf-8') as fh:
        laps = json.load(fh).get('lap_times') or []
    drivers = sorted({r['Driver'] for r in laps if isinstance(r, dict) and r.get('Driver')})
    res = []
    for now in clocks:
        now = math.inf if now is None else now
        clean = [{k: v for k, v in st.items() if k not in ('laps', 'outliers')}
                 | {'laps': [r['LapNumber'] for r in st['laps']],
                    'outliers': [r['LapNumber'] for r in st['outliers']]}
                 for st in clean_stint_laps(laps, session_now=now)]
        fits = stint_fits(laps, session_now=now)
        res.append({
            'clean': clean,
            'fits': fits,
            'compound': compound_degradation(fits),
            'range_fits': stint_fits(laps, session_now=now, lap_start=req['lap_start'], lap_end=req['lap_end']),
            'sigma': {d: consistency_sigma(laps, d, session_now=now) for d in drivers},
            'range_sigma': {d: consistency_sigma(laps, d, session_now=now, lap_start=req['lap_start'],
                                                 lap_end=req['lap_end']) for d in drivers},
        })
    out[f] = res
print(json.dumps(out))
`;

function runPython(clocks) {
  const input = JSON.stringify({ races: clocks, lap_start: LAP_RANGE.lapStart, lap_end: LAP_RANGE.lapEnd });
  const res = spawnSync(PYTHON, ['-c', PY, CACHE_DIR], {
    cwd: BACKEND, input, encoding: 'utf8', timeout: 300000, maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
  return parseJson(res.stdout);
}

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** JS output with snake_case keys (the Python names). */
function toSnake(v) {
  if (Array.isArray(v)) return v.map(toSnake);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), toSnake(x)]));
  return v;
}

/**
 * Differences between two JSON values: numbers within TOL, everything else
 * equal, same keys and lengths. Returns [paths that differ, max |number diff|].
 */
function compare(a, b, where = '', acc = { diffs: [], max: 0 }) {
  if (typeof a === 'number' && typeof b === 'number') {
    const d = Math.abs(a - b);
    acc.max = Math.max(acc.max, d);
    if (!(d <= TOL)) acc.diffs.push(`${where}: ${a} vs ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) acc.diffs.push(`${where}: length ${a.length} vs ${b.length}`);
    else a.forEach((x, i) => compare(x, b[i], `${where}[${i}]`, acc));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) acc.diffs.push(`${where}: keys ${ka} vs ${kb}`);
    else ka.forEach((k) => compare(a[k], b[k], `${where}.${k}`, acc));
  } else if (a !== b) {
    acc.diffs.push(`${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  return acc;
}

describe.skipIf(!PYTHON || RACES.length === 0)('degradation.js = degradation.py on every cached race', () => {
  const sessions = Object.fromEntries(RACES.map((f) => [f, loadRace(f).lap_times || []]));
  const clocks = Object.fromEntries(RACES.map((f) => [f, clocksOf(sessions[f])]));
  const py = PYTHON && RACES.length ? runPython(clocks) : {};
  const totals = { fits: 0, fitted: 0, laps: 0, outliers: 0, max: 0 };

  it('covers every cached race', () => {
    expect(Object.keys(py).sort()).toEqual(RACES);
  });

  it.each(RACES)('%s: clean laps, outliers, fits, compound degradation, consistency sigma', (file) => {
    const laps = sessions[file];
    const drivers = [...new Set(laps.map((r) => r.Driver).filter(Boolean))].sort();
    clocks[file].forEach((c, i) => {
      const sessionNow = c == null ? Infinity : c;
      const clean = cleanStintLaps(laps, { sessionNow }).map((st) => ({
        ...st, laps: st.laps.map((r) => r.LapNumber), outliers: st.outliers.map((r) => r.LapNumber),
      }));
      const fits = stintFits(laps, { sessionNow });
      // compound and driver keys are data (e.g. 'MEDIUM', 'LEC'), not field names: kept unchanged
      const byKey = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toSnake(v)]));
      const js = {
        clean: toSnake(clean),
        fits: toSnake(fits),
        compound: byKey(compoundDegradation(fits)),
        range_fits: toSnake(stintFits(laps, { sessionNow, ...LAP_RANGE })),
        sigma: byKey(Object.fromEntries(drivers.map((d) => [d, consistencySigma(laps, d, { sessionNow })]))),
        range_sigma: byKey(Object.fromEntries(drivers.map((d) => [d, consistencySigma(laps, d, { sessionNow, ...LAP_RANGE })]))),
      };
      const { diffs, max } = compare(js, py[file][i], `${file}@${i}`);
      expect(diffs).toEqual([]);
      totals.max = Math.max(totals.max, max);
      if (i === 0) {
        totals.fits += fits.length;
        totals.fitted += fits.filter((f) => f.slope != null).length;
        totals.laps += clean.reduce((s, st) => s + st.laps.length, 0);
        totals.outliers += clean.reduce((s, st) => s + st.outliers.length, 0);
      }
      expect(fits.length).toBeGreaterThan(0);
    });
  });

  it('summary', () => {
    console.log(`parity: ${RACES.length} races x 3 clocks; whole race: ${totals.fits} stints, ${totals.fitted} fitted, `
      + `${totals.laps} clean laps, ${totals.outliers} slow outliers; max |JS - Python| over every number ${totals.max}`);
    expect(totals.max).toBeLessThanOrEqual(TOL);
    expect(totals.fitted).toBeGreaterThan(0);
  });
});
