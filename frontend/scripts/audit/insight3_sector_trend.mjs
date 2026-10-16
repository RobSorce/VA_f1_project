// Repair 3 (V7 r2, docs/INSIGHTS.md Insight 3): what a long Hard stint shows
// sector by sector, in the demo data of Monza 2024 (frontend/public/data/
// 2024_16_R/session.json.gz, the backend's cached session). For every stint
// on HARD of more than 15 laps: the laps without a pit in / out, then the
// mean of each sector time over the last third of the stint minus the mean
// over the first third (fuel burn makes the car lighter through the stint,
// so a positive difference is tyre loss net of the fuel effect).
// Run: node frontend/scripts/audit/insight3_sector_trend.mjs
// Writes docs/evidence/insight3_sector_trend.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('insight3_sector_trend.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = path.join(ROOT, 'frontend/public/data/2024_16_R/session.json.gz');
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
const laps = raw.lap_times || raw.data?.lap_times || raw.session?.lap_times;
const byStint = new Map();
for (const l of laps) {
  if (l.Compound !== 'HARD' || l.PitInTime || l.PitOutTime) continue;
  if (!(l.Sector1TimeSeconds > 0 && l.Sector2TimeSeconds > 0 && l.Sector3TimeSeconds > 0)) continue;
  const key = `${l.Driver}|${l.Stint}`;
  if (!byStint.has(key)) byStint.set(key, []);
  byStint.get(key).push(l);
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const rows = [];
for (const [key, list] of byStint) {
  list.sort((a, b) => a.LapNumber - b.LapNumber);
  if (list.length <= 15) continue;
  const n = Math.floor(list.length / 3);
  const first = list.slice(0, n);
  const last = list.slice(-n);
  const d = [1, 2, 3].map((k) => mean(last.map((l) => l[`Sector${k}TimeSeconds`])) - mean(first.map((l) => l[`Sector${k}TimeSeconds`])));
  const lap = mean(last.map((l) => l.LapTimeSeconds)) - mean(first.map((l) => l.LapTimeSeconds));
  rows.push({ key, laps: list.length, d, lap });
}
rows.sort((a, b) => a.key.localeCompare(b.key));
console.log(`Monza 2024 (R16): HARD stints of more than 15 clean laps: ${rows.length}`);
for (const r of rows) {
  console.log(`  ${r.key.padEnd(8)} ${String(r.laps).padStart(2)} laps: last third - first third  S1 ${r.d[0].toFixed(3)}  S2 ${r.d[1].toFixed(3)}  S3 ${r.d[2].toFixed(3)}  lap ${r.lap.toFixed(3)} s`);
}
const largest = rows.map((r) => r.d.indexOf(Math.max(...r.d)) + 1);
const counts = [1, 2, 3].map((k) => largest.filter((x) => x === k).length);
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
console.log(`sector with the largest change: S1 in ${counts[0]}, S2 in ${counts[1]}, S3 in ${counts[2]} of ${rows.length} stints`);
for (const k of [0, 1, 2]) {
  const v = rows.map((r) => r.d[k]);
  console.log(`  S${k + 1}: median ${med(v).toFixed(3)} s, range ${Math.min(...v).toFixed(3)} to ${Math.max(...v).toFixed(3)} s`);
}
console.log(`  lap: median ${med(rows.map((r) => r.lap)).toFixed(3)} s`);
