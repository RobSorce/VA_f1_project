// Parity with the backend on every cached session (races, qualifying,
// practice): the JS ports must give the SAME output as the Python processors.
//  - R1: deriveStints (stints.js) at sessionNow = Infinity
//        vs build_tyre_strategy (backend/data/processors/stints.py)
//  - R5: mapTrackStatusToLaps (raceTime.js)
//        vs map_track_status_to_laps (backend/data/processors/stints.py)
// The Python side is executed here (backend venv), nothing is hard-coded.
// Skips when the venv or the git-ignored cache is absent.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveStints } from '../stints.js';
import { mapTrackStatusToLaps } from '../raceTime.js';
import { CACHE_DIR } from '../../__tests__/helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../../backend');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const SESSIONS = fs.existsSync(CACHE_DIR)
  ? fs.readdirSync(CACHE_DIR).filter((f) => /^session_\d{4}_\d+_[A-Z0-9]+\.json$/.test(f)).sort()
  : [];

const PY = `
import json, os, sys
from data.processors.stints import build_tyre_strategy, map_track_status_to_laps
cache = sys.argv[1]
out = {}
for f in sys.argv[2:]:
    with open(os.path.join(cache, f), encoding='utf-8') as fh:
        s = json.load(fh)
    laps = s.get('lap_times') or []
    out[f] = {
        'stints': build_tyre_strategy(laps),
        'periods': map_track_status_to_laps(s.get('track_status') or [], laps),
    }
print(json.dumps(out))
`;

// Python's json writes bare NaN (2026 payloads: circuit_info corner Distance);
// JSON.parse rejects it, so it is read as null on both sides
const parseJson = (text) => JSON.parse(text.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));

function runPython() {
  const res = spawnSync(PYTHON, ['-c', PY, CACHE_DIR, ...SESSIONS], {
    cwd: BACKEND, encoding: 'utf8', timeout: 180000, maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
  return parseJson(res.stdout);
}

const byDriverStint = (a, b) => (a.Driver < b.Driver ? -1 : a.Driver > b.Driver ? 1 : a.StintNumber - b.StintNumber);
const shape = (s) => ({
  Driver: s.Driver, StintNumber: s.StintNumber, Compound: s.Compound,
  StartLap: s.StartLap, EndLap: s.EndLap, TotalLaps: s.TotalLaps,
});

describe.skipIf(!PYTHON || SESSIONS.length === 0)('JS ports = Python processors on every cached session', () => {
  const py = PYTHON && SESSIONS.length ? runPython() : {};

  it('covers every cached session, races and non-races', () => {
    expect(Object.keys(py).sort()).toEqual(SESSIONS);
    expect(SESSIONS.some((f) => f.endsWith('_R.json'))).toBe(true);
  });

  it.each(SESSIONS)('%s: deriveStints at Infinity = build_tyre_strategy (R1)', (file) => {
    const s = parseJson(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
    const js = deriveStints(s.lap_times || []).map(shape).sort(byDriverStint);
    const pyStints = py[file].stints.map(shape).sort(byDriverStint);
    expect(js.length).toBeGreaterThan(0);
    expect(js).toEqual(pyStints);
  });

  it.each(SESSIONS)('%s: mapTrackStatusToLaps = map_track_status_to_laps (R5)', (file) => {
    const s = parseJson(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
    const js = mapTrackStatusToLaps(s.track_status || [], s.lap_times || []);
    expect(js).toEqual(py[file].periods);
  });
});
