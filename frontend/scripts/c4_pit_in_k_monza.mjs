/**
 * C4 done-when: the Circle of Doom's "pit in k laps" (utils/undercut.js
 * pitInLaps, k = 0..PIT_IN_LAPS_MAX) on Monza 2024 (2024 R16), causal at
 * every clock (session seconds).
 *  1. the table of LEC and PIA at the end of their lap 12, rivals stop off
 *     and on: in-lap, rejoin lap, projected place, place pitting now, "+/-
 *     positions vs pitting now", seconds vs pitting now, ghost offset;
 *  2. k = 0 is the pit window (circleOfDoom.js pitWindow: place, crossing,
 *     rejoin offset, target lap) for every focus every 60 s, Monza and China
 *     2024;
 *  3. k > 0 moves consistently: with no tyre model (zero degradation, zero
 *     fresh-tyre delta) the crossing grows by exactly the focus's pace per
 *     lap of waiting, nothing changes against pitting now, and the ghost
 *     moves by the same step per lap (pace minus reference lap);
 *  4. lead decision D3 (R2 / R3): 2024 R22 t = 4518.3 s, OCO on its out-lap
 *     after a pit-lane visit with no tyre change keeps its set; and the
 *     tables at every clock between an in-lap's line crossing and its pit
 *     exit (a tyre change), every cached race, on the real rows against the
 *     rows with the future rewritten (futureRows.js perturbFuture).
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/c4_pit_in_k_monza.mjs
 * Writes docs/evidence/c4_pit_in_k_monza.txt and prints the same text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRaceParams } from '../src/utils/raceSimulation.js';
import { circleState, pitWindow } from '../src/utils/circleOfDoom.js';
import { estimatePitLoss } from '../src/utils/pitLoss.js';
import { pitInLaps, PIT_IN_LAPS_MAX } from '../src/utils/undercut.js';
import { deriveStints } from '../src/utils/stints.js';
import { hasPitIn, hasPitOut, pitOutSeconds } from '../src/utils/raceTime.js';
import { perturbFuture } from '../src/utils/__tests__/futureRows.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = path.resolve(ROOT, 'docs/evidence/c4_pit_in_k_monza.txt');
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8').replace(/\bNaN\b/g, 'null'));
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const sgn = (v, d = 2) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`;
const inputs = (lt, ts, now) => ({
  st: circleState(lt, { sessionNow: now }),
  pitLoss: estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' }),
  rp: extractRaceParams(lt, [], ts, 1, { sessionNow: now, sessionType: 'R' }),
});
const rowKey = (r) => [r.k, r.inLap, r.targetLap, r.predictedPosition, r.positionIfPitNow, r.positionsVsNow,
  r.secondsVsNow.toFixed(6), r.ghostOffset.toFixed(6), r.rivalStops.join(',')].join('|');

const monza = load('session_2024_16_R.json');
const mlt = monza.lap_times;
const mts = monza.track_status || [];
out(`C4, "pit in k laps" (utils/undercut.js pitInLaps, k = 0..${PIT_IN_LAPS_MAX}), Monza 2024 (2024 R16)`);

out('');
out('1. The table at the end of lap 12');
for (const focus of ['LEC', 'PIA']) {
  const now = mlt.find((r) => r.Driver === focus && r.LapNumber === 12).Time + 0.001;
  const s = inputs(mlt, mts, now);
  const win = pitWindow(focus, s.st, s.pitLoss);
  for (const rivalsStop of [false, true]) {
    const pk = pitInLaps(focus, s.st, s.pitLoss, s.rp, { rivalsStop });
    out(`  ${focus} (P${pk.currentPosition}, ${pk.tyre.compound} age ${pk.tyre.tyreAge}, next ${pk.nextCompound}), t = ${now.toFixed(1)} s, rivals stop ${rivalsStop ? 'on' : 'off'};`
      + ` pit window: P${win.predictedPosition} at L${win.targetLap}, rejoin offset ${win.rejoinOffset.toFixed(4)}`);
    out('    k  in-lap  rejoin  place  pit now  +/- vs now  s vs now   ghost   rivals stopping by then');
    for (const r of pk.rows) {
      out(`   ${String(r.k).padStart(2)}  L${String(r.inLap).padEnd(5)} L${String(r.targetLap).padEnd(5)} P${String(r.predictedPosition).padEnd(5)}`
        + ` P${String(r.positionIfPitNow).padEnd(6)}  ${(r.positionsVsNow >= 0 ? '+' : '') + r.positionsVsNow}`.padEnd(13)
        + `${sgn(r.secondsVsNow).padStart(8)}  ${r.ghostOffset.toFixed(4)}  ${r.rivalStops.join(',') || '-'}`);
    }
  }
}

out('');
out('2. k = 0 is the pit window: every focus, every 60 s');
for (const [name, file] of [['Monza 2024', 'session_2024_16_R.json'], ['China 2024', 'session_2024_5_R.json']]) {
  const ses = load(file);
  const lt = ses.lap_times;
  const ts = ses.track_status || [];
  const first = Math.min(...lt.filter((r) => r.LapNumber === 2).map((r) => r.LapStartTime));
  const last = Math.max(...lt.map((r) => r.Time ?? 0));
  let windows = 0;
  let same = 0;
  for (let now = first; now < last; now += 60) {
    const s = inputs(lt, ts, now);
    for (const c of s.st.cars) {
      const win = pitWindow(c.driver, s.st, s.pitLoss);
      if (!win.available) continue;
      windows += 1;
      const r0 = pitInLaps(c.driver, s.st, s.pitLoss, s.rp).rows[0];
      if (r0 && r0.predictedPosition === win.predictedPosition && r0.predictedCrossing === win.predictedCrossing
        && r0.ghostOffset === win.rejoinOffset && r0.targetLap === win.targetLap) same += 1;
    }
  }
  out(`  ${name}: pit windows ${windows}; k = 0 row equal to the window (place, crossing, ghost offset, target lap) ${same}`);
}

out('');
out('3. k > 0 moves consistently: no tyre model (zero degradation and fresh-tyre delta), every focus, end of lap 12 / 30 of the leader');
{
  let tables = 0;
  let exact = 0;
  for (const lap of [12, 30]) {
    const now = mlt.find((r) => r.Position === 1 && r.LapNumber === lap)?.Time + 0.001;
    const s = inputs(mlt, mts, now);
    const zero = { mean: 0, median: 0, stdDev: 0, n: 1, negativeCount: 0, source: 'race' };
    const flat = { ...s.rp, tyreDeg: { SOFT: zero, MEDIUM: zero, HARD: zero }, freshDelta: 0 };
    for (const c of s.st.cars) {
      const pk = pitInLaps(c.driver, s.st, s.pitLoss, flat);
      if (!pk.available || pk.kMax < 1) continue;
      tables += 1;
      const pace = pk.rows[1].predictedCrossing - pk.rows[0].predictedCrossing;
      const ghostStep = pk.rows[1].ghostOffset - pk.rows[0].ghostOffset;
      const ok = pk.rows.every((r, k) => Math.abs(r.predictedCrossing - (pk.rows[0].predictedCrossing + k * pace)) < 1e-6
        && Math.abs(r.secondsVsNow) < 1e-6 && r.positionsVsNow === 0
        && Math.abs(r.ghostOffset - (pk.rows[0].ghostOffset + k * ghostStep)) < 1e-9);
      if (ok) exact += 1;
    }
  }
  out(`  tables ${tables}; crossing = k = 0 crossing + k x the focus's pace, 0 s and 0 places vs pitting now, ghost moved back by`
    + ` the same step per lap of waiting (the focus's pace minus the reference lap): ${exact}`);
}

out('');
out('4. D3 (R2 / R3): a pit-lane visit with no tyre change, and the pit lane read causally');
{
  const s22 = load('session_2024_22_R.json');
  const now = 4518.3;
  const s = inputs(s22.lap_times, s22.track_status || [], now);
  for (const [focus, k] of [['HUL', 1], ['HUL', 2], ['LEC', 5]]) {
    const pk = pitInLaps(focus, s.st, s.pitLoss, s.rp);
    const r = pk.rows[k];
    out(`  2024 R22 t = ${now} s, OCO on its out-lap with its own MEDIUM (TyreLife goes on): focus ${focus} "pit in ${k}": P${r.predictedPosition}`
      + ` (${r.positionsVsNow >= 0 ? '+' : ''}${r.positionsVsNow} vs now, ${sgn(r.secondsVsNow)} s)`);
  }
  let clocks = 0;
  let tables = 0;
  let differ = 0;
  for (const f of fs.readdirSync(CACHE).filter((x) => /^session_\d+_\d+_R\.json$/.test(x)).sort()) {
    const ses = load(f);
    const rows = ses.lap_times;
    const byDrv = new Map();
    for (const r of rows) {
      if (!byDrv.has(r.Driver)) byDrv.set(r.Driver, []);
      byDrv.get(r.Driver).push(r);
    }
    for (const list of byDrv.values()) {
      const sorted = [...list].sort((a, b) => a.LapNumber - b.LapNumber);
      const starts = new Set(deriveStints(sorted).map((x) => x.StartLap));
      for (let i = 0; i + 1 < sorted.length; i++) {
        const inLap = sorted[i];
        const next = sorted[i + 1];
        if (!hasPitIn(inLap) || !hasPitOut(next) || !starts.has(next.LapNumber)) continue;
        const exit = pitOutSeconds(next);
        const line = Number(inLap.Time);
        if (!(exit - line > 2)) continue;
        const t = line + (exit - line) / 2;
        clocks += 1;
        const real = inputs(rows, [], t);
        const pert = perturbFuture(rows, t);
        const fut = { ...real, st: circleState(pert, { sessionNow: t }) };
        for (const c of real.st.cars) {
          const a = pitInLaps(c.driver, real.st, real.pitLoss, real.rp, { rivalsStop: true });
          const b = pitInLaps(c.driver, fut.st, fut.pitLoss, fut.rp, { rivalsStop: true });
          if (!a.available && !b.available) continue;
          tables += 1;
          if (a.rows.map(rowKey).join(';') !== b.rows.map(rowKey).join(';')) differ += 1;
        }
      }
    }
  }
  out(`  every cached race, a clock half way from an in-lap's line crossing to its pit exit (tyre change): clocks ${clocks},`
    + ` tables (every focus, rivals stop on) ${tables}, differing with the future rows rewritten ${differ}`);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
