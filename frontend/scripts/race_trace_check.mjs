#!/usr/bin/env node
/**
 * Race Trace check on every cached race (utils/raceTrace.js), for
 * docs/evidence/race_trace_check.txt. Per race:
 *  1. the largest |y - (-GapToLeader)| on the leader reference over the rows
 *     with a Position and a GapToLeader: the trace against the timing's own
 *     gap to the leader (they differ only where a red-flag window lies between
 *     the two crossings of a lap, or where the first car across a lap is not
 *     the Position-1 car);
 *  2. the rows without a Time (no trace point) and the retiring cars'
 *     truncated rows (no Position, no lap time: not a crossing);
 *  3. the red-flag windows (start, restart) of the race clock;
 *  4. the provisional-lap movement on the field reference: at every lap start
 *     of the leader and halfway through each lap, every point drawn then
 *     against the same point at the flag; separately the points flagged
 *     provisional (drawn hollow) and the final ones of the newest two laps.
 *
 * Needs the race cache backend/data/processed_cache (git-ignored). Run from
 * frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/race_trace_check.mjs
 * Writes docs/evidence/race_trace_check.txt and prints the same text.
 * RACE_TRACE_CACHE and RACE_TRACE_OUT set another cache folder and output file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRaceTrace } from '../src/utils/raceTrace.js';
import { resolveSessionNow } from '../src/utils/raceTime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = process.env.RACE_TRACE_CACHE || path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = process.env.RACE_TRACE_OUT || path.resolve(ROOT, 'docs/evidence/race_trace_check.txt');
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8').replace(/\bNaN\b/g, 'null'));

if (!fs.existsSync(CACHE)) {
  console.error(`No race cache at ${CACHE}: nothing checked, nothing written.`);
  process.exit(1);
}
const races = fs.readdirSync(CACHE)
  .map((f) => /^session_(\d{4})_(\d+)_R\.json$/.exec(f))
  .filter(Boolean)
  .map((m) => ({ year: Number(m[1]), round: Number(m[2]), file: m[0] }))
  .sort((a, b) => a.year - b.year || a.round - b.round);

const pointAt = (trace) => {
  const m = new Map();
  for (const d of trace.drivers) for (const p of d.points) if (!p.start) m.set(`${d.driver}|${p.lap}`, p);
  return m;
};
function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * (s[Math.ceil(h)] - s[lo]);
}
const f3 = (v) => (v == null ? '-' : v.toFixed(3));

const lines = [];
const out = (s = '') => lines.push(s);
out('Race Trace check (frontend/scripts/race_trace_check.mjs) on the cached races');
out(`cache: ${path.relative(ROOT, CACHE).split(path.sep).join('/') || CACHE}, ${races.length} races`);
out('gap: max |leader-reference y + GapToLeader| (s) over the rows with a Position; rows: without Time / truncated;');
out('provisional / final(2): field-reference movement of a point from when it was drawn to the flag (s), max and p95');
out('');
out('race       laps  gap_max  at          no_Time  truncated  red_windows  prov_n  prov_max  prov_p95  final2_n  final2_max  final2_p95');

const totals = { gap: 0, prov: [], final: [] };
for (const r of races) {
  const s = load(r.file);
  const lt = s.lap_times || [];
  const ts = s.track_status || [];
  const leader = buildRaceTrace(lt, { trackStatus: ts, reference: 'leader' });
  const pts = pointAt(leader);
  let gapMax = 0;
  let gapAt = '-';
  for (const row of lt) {
    if (row.Position == null || !Number.isFinite(row.GapToLeader)) continue;
    const p = pts.get(`${row.Driver}|${row.LapNumber}`);
    if (!p) continue;
    const e = Math.abs(p.y + row.GapToLeader);
    if (e > gapMax) { gapMax = e; gapAt = `${row.Driver} L${row.LapNumber}`; }
  }
  totals.gap = Math.max(totals.gap, gapMax);

  const final = pointAt(buildRaceTrace(lt, { trackStatus: ts }));
  const maxLap = leader.lastLap;
  const prov = [];
  const fin2 = [];
  for (let lap = 2; lap <= maxLap; lap++) {
    const start = resolveSessionNow({ currentLap: lap, lapTimes: lt });
    const next = lap < maxLap ? resolveSessionNow({ currentLap: lap + 1, lapTimes: lt }) : start + 90;
    for (const now of [start, (start + next) / 2]) {
      if (!Number.isFinite(now)) continue;
      const tr = buildRaceTrace(lt, { trackStatus: ts, sessionNow: now });
      for (const d of tr.drivers) {
        for (const p of d.points) {
          if (p.start) continue;
          const f = final.get(`${d.driver}|${p.lap}`);
          if (!f) continue;
          const move = Math.abs(p.y - f.y);
          if (p.provisional) prov.push(move);
          else if (p.lap >= tr.lastLap - 1) fin2.push(move);
        }
      }
    }
  }
  totals.prov.push(...prov);
  totals.final.push(...fin2);
  const red = leader.suspensions.map((w) => `${w.start.toFixed(0)}-${w.restart == null ? 'open' : w.restart.toFixed(0)}`).join(',') || '-';
  out(`${`${r.year} R${r.round}`.padEnd(10)} ${String(maxLap).padStart(4)}  ${f3(gapMax).padStart(7)}  ${gapAt.padEnd(10)}  ${String(leader.rowsWithoutTime).padStart(7)}  ${String(leader.truncatedRows).padStart(9)}  ${red.padStart(11)}  ${String(prov.length).padStart(6)}  ${f3(Math.max(0, ...prov)).padStart(8)}  ${f3(quantile(prov, 0.95)).padStart(8)}  ${String(fin2.length).padStart(8)}  ${f3(Math.max(0, ...fin2)).padStart(10)}  ${f3(quantile(fin2, 0.95)).padStart(10)}`);
}
out('');
out(`all races: gap_max ${f3(totals.gap)} s; provisional points ${totals.prov.length}, max ${f3(Math.max(0, ...totals.prov))} s, `
  + `p95 ${f3(quantile(totals.prov, 0.95))} s; final points of the newest two laps ${totals.final.length}, `
  + `max ${f3(Math.max(0, ...totals.final))} s, p95 ${f3(quantile(totals.final, 0.95))} s`);

const text = `${lines.join('\n')}\n`;
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, text);
process.stdout.write(text);
