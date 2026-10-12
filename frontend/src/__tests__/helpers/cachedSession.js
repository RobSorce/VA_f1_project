// Test helper: load a cached race from backend/data/processed_cache.
// The cache is git-ignored, so data-dependent tests must skip when it is absent
// (fresh clone, CI): use `describe.skipIf(!hasCachedSession(2024, 16))`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.resolve(HERE, '../../../../backend/data/processed_cache');

function cachePath(prefix, year, round, sessionType = 'R') {
  return path.join(CACHE_DIR, `${prefix}_${year}_${round}_${sessionType}.json`);
}

export function hasCachedSession(year, round, sessionType = 'R') {
  return fs.existsSync(cachePath('session', year, round, sessionType));
}

export function hasCachedFrames(year, round, sessionType = 'R') {
  return fs.existsSync(cachePath('frames', year, round, sessionType));
}

const memo = new Map();
/** Parsed JSON file. Some payloads (e.g. session_2026_1_FP2.json) hold bare
 * NaN, which Python writes and JSON.parse rejects: those parse as null, the
 * value the API serves for them. */
function readJson(file) {
  if (!memo.has(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = JSON.parse(raw.replace(/\bNaN\b/g, 'null'));
    }
    memo.set(file, data);
  }
  return memo.get(file);
}

/** Full session payload as served by GET /api/session/{year}/{round}. */
export function loadCachedSession(year, round, sessionType = 'R') {
  return readJson(cachePath('session', year, round, sessionType));
}

/** Replay frames payload as served by GET /api/frames/{year}/{round}. */
export function loadCachedFrames(year, round, sessionType = 'R') {
  return readJson(cachePath('frames', year, round, sessionType));
}

/** Every cached race session as [{ year, round, file }]. */
export function listCachedRaces() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR)
    .map((f) => /^session_(\d{4})_(\d+)_R\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ year: Number(m[1]), round: Number(m[2]), file: path.join(CACHE_DIR, m[0]) }));
}
