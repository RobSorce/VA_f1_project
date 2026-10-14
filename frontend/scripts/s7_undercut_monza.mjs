/**
 * S7 done-when (lead decisions D2, D3, D4): the Undercut Calculator's sweep
 * (utils/undercut.js undercutSweep) on Monza 2024 (2024 R16), causal at every
 * clock (the end of the focus driver's lap L, session seconds).
 *  1. the real stops of NOR / LEC / PIA;
 *  2. D2: the six NOR / LEC / PIA pairs at the end of laps 8-13, every row
 *     read at the race end: the best in-lap, its gap, the rows' spread, the
 *     extra stops charged, and the inputs that decide it (degradation by
 *     compound with source and n, fresh-tyre delta, the stint-life median and
 *     P90 of MEDIUM and HARD) with the closed-form wear balance of the lap
 *     model (stopping one lap later costs dM x (age + 1) and saves dH x the
 *     laps from the stop to the flag) and the MEDIUM / HARD ratio a best lap
 *     of 15 would need;
 *  3. the same with the whole race's estimates (hindsight);
 *  4. the horizon does not depend on the table length or on the rival's
 *     stop (rows identical for every sweepLaps, the best row the same for
 *     every rival in-lap);
 *  5. D4: a chosen rival stop after a seek past it, and after a tyre change
 *     of the rival;
 *  6. D3: 2024 R22 t = 4518.3 s (OCO's pit-lane visit with no tyre change),
 *     and the pit-lane state between an in-lap's line crossing and the pit
 *     exit read causally on every cached race (tyreStates on the real rows
 *     against the rows with the future rewritten, futureRows.js perturbFuture).
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/s7_undercut_monza.mjs
 * Writes notes/experiments/phase45c/s7_undercut_monza.txt and prints the same text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRaceParams, degradationFor, stintLifeFor, conditionalMedianLife,
} from '../src/utils/raceSimulation.js';
import { circleState } from '../src/utils/circleOfDoom.js';
import { estimatePitLoss } from '../src/utils/pitLoss.js';
import {
  undercutSweep, tyreStates, feasibleStintLength, STINT_FEASIBLE_QUANTILE, UNDERCUT_SWEEP_LAPS,
} from '../src/utils/undercut.js';
import { deriveStints } from '../src/utils/stints.js';
import { hasPitIn, hasPitOut, pitOutSeconds } from '../src/utils/raceTime.js';
import { perturbFuture } from '../src/utils/__tests__/futureRows.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = path.resolve(ROOT, 'notes/experiments/phase45c/s7_undercut_monza.txt');
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8').replace(/\bNaN\b/g, 'null'));
const monza = load('session_2024_16_R.json');
const lt = monza.lap_times;
const ts = monza.track_status || [];
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const sgn = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`);
const endOf = (drv, lap) => lt.find((r) => r.Driver === drv && r.LapNumber === lap)?.Time;
const realStops = (drv) => lt.filter((r) => r.Driver === drv && hasPitIn(r)).map((r) => r.LapNumber).sort((a, b) => a - b);
const at = (now, whole = false) => ({
  st: circleState(lt, { sessionNow: now }),
  pitLoss: estimatePitLoss(lt, { sessionNow: whole ? Infinity : now, sessionType: 'R' }),
  rp: extractRaceParams(lt, [], ts, 1, { sessionNow: whole ? Infinity : now, sessionType: 'R' }),
});
const p50 = (rp, c) => {
  const life = stintLifeFor(rp, c);
  return conditionalMedianLife(life.survival, 0);
};

out('S7, Monza 2024 (2024 R16): the undercut sweep (utils/undercut.js undercutSweep)');
out(`rows: the lap in progress and the next ${UNDERCUT_SWEEP_LAPS} (UNDERCUT_SWEEP_LAPS, display only); every row read at the race end (D2);`
  + ` stint feasibility: P${Math.round(STINT_FEASIBLE_QUANTILE * 100)} stint length (STINT_FEASIBLE_QUANTILE, a modelling choice)`);
out('');
out('1. Real stops (in-laps)');
for (const d of ['NOR', 'LEC', 'PIA']) out(`  ${d}: ${realStops(d).map((l) => `L${l}`).join(', ')}`);

const PAIRS = [['LEC', 'PIA'], ['PIA', 'LEC'], ['NOR', 'PIA'], ['PIA', 'NOR'], ['NOR', 'LEC'], ['LEC', 'NOR']];
for (const [label, whole] of [['2. Estimates at the time (causal)', false], ['3. Whole race\'s estimates (hindsight)', true]]) {
  out('');
  out(`${label}: best in-lap at the end of laps 8-13 (H = the race end; real first stops NOR L14, LEC L15, PIA L16)`);
  let near = 0;
  let cases = 0;
  let distinct = 0;
  for (const [focus, rival] of PAIRS) {
    const cells = [];
    for (let lap = 8; lap <= 13; lap++) {
      const now = endOf(focus, lap) + 0.001;
      const s = at(now, whole);
      const sw = undercutSweep(focus, rival, s.st, s.pitLoss, s.rp);
      cases += 1;
      if (sw.best.inLap >= 14 && sw.best.inLap <= 16) near += 1;
      if (new Set(sw.rows.map((r) => r.gap.toFixed(6))).size === sw.rows.length) distinct += 1;
      cells.push(`L${lap}->L${sw.best.inLap}${sw.best.extraStops.length ? '+x' : ''}`);
    }
    out(`  ${focus} vs ${rival}: ${cells.join(' ')}`);
  }
  out(`  cases ${cases}; best in L14-16: ${near}; rows all distinct (rows differ by pit lap): ${distinct}/${cases}`);
}

out('');
out('4. Why: the inputs at each clock (LEC vs PIA) and the closed-form wear balance of the lap model');
out('   balance: the first in-lap p with dM x (a0 + p - n + 2) >= dH x (H - p), a0 = tyre age after lap n (stopping one lap');
out('   later adds one in-lap on the old set and an out-lap at its time, and takes one lap off the new set before the flag)');
for (let lap = 8; lap <= 13; lap++) {
  const now = endOf('LEC', lap) + 0.001;
  const s = at(now);
  const sw = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp);
  const dM = degradationFor(s.rp, 'MEDIUM');
  const dH = degradationFor(s.rp, 'HARD');
  const a0 = sw.focusTyre.tyreAge;
  const n = sw.focusTyre.lapsCompleted;
  const H = sw.horizonLap;
  let p = n + 1;
  while (p < H - 1 && dM.mean * (a0 + p - n + 2) < dH.mean * (H - p)) p += 1;
  // the MEDIUM / HARD ratio for which the balance falls on lap 15
  const need = (H - 15) / (a0 + 15 - n + 2);
  const fd = s.rp.estimates.freshDelta;
  out(`  end of L${lap}: H L${H} (${sw.horizon.source}); MEDIUM ${sgn(dM.mean, 4)} s/lap (${dM.source}, n ${dM.n}), HARD ${sgn(dH.mean, 4)} s/lap (${dH.source}, n ${dH.n}),`
    + ` ratio ${(dM.mean / dH.mean).toFixed(2)}; fresh-tyre delta ${sgn(fd.value, 3)} s (${fd.source}, n ${fd.n});`
    + ` stint life MEDIUM median ${p50(s.rp, 'MEDIUM')} / P90 ${feasibleStintLength(s.rp, 'MEDIUM').laps} (${feasibleStintLength(s.rp, 'MEDIUM').source}),`
    + ` HARD median ${p50(s.rp, 'HARD')} / P90 ${feasibleStintLength(s.rp, 'HARD').laps} (${feasibleStintLength(s.rp, 'HARD').source})`);
  out(`     LEC MEDIUM age ${a0} after lap ${n}: balance p = L${p}; sweep best L${sw.best.inLap} (${sgn(sw.best.gap)} s at the flag, change ${sgn(sw.best.change)} s);`
    + ` a best lap of L15 needs MEDIUM / HARD = ${need.toFixed(2)}`);
  out(`     rows: ${sw.rows.map((r) => `L${r.inLap} ${sgn(r.gap)}${r.extraStops.length ? `(+${r.extraStops.length} stop)` : ''}`).join(' | ')}`);
  out(`     rival PIA: in-lap ${sw.rivalStop.inLap != null ? `L${sw.rivalStop.inLap}` : 'none'} (${sw.rivalStop.source}), extra stops ${sw.rivalStop.extraStops.length}`);
}

out('');
out('5. The horizon is the race end: the table length and the rival\'s stop do not move it (LEC vs PIA, end of L10)');
{
  const now = endOf('LEC', 10) + 0.001;
  const s = at(now);
  const full = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { sweepLaps: 60 });
  for (const sweepLaps of [5, 10, 15, 20, 30, 60]) {
    const sw = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { sweepLaps });
    const same = sw.rows.every((r) => Math.abs(r.gap - full.rows.find((x) => x.inLap === r.inLap).gap) < 1e-9);
    out(`  sweepLaps ${String(sweepLaps).padStart(2)}: rows ${String(sw.rows.length).padStart(2)}, H L${sw.horizonLap}, best L${sw.best.inLap}`
      + ` (${sgn(sw.best.gap)} s); rows equal to the 60-lap table's: ${same}`);
  }
  for (const q of [12, 14, 16, 20, 25]) {
    const sw = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { rivalStopLap: q });
    out(`  rival in-lap L${q}: H L${sw.horizonLap}, best L${sw.best.inLap} (${sgn(sw.best.gap)} s at the flag); first rows minus row 1:`
      + ` ${sw.rows.slice(0, 6).map((r) => (r.gap - sw.rows[0].gap).toFixed(3)).join(' ')}`);
  }
}

out('');
out('6. D4: a chosen rival stop that is no longer one');
{
  // chosen at the end of LEC's lap 10: PIA's L16; then the replay moves to the end of LEC's L20
  const s10 = at(endOf('LEC', 10) + 0.001);
  const chosen = undercutSweep('LEC', 'PIA', s10.st, s10.pitLoss, s10.rp, { rivalStopLap: 16 });
  const stints = chosen.rivalTyre.stints;
  out(`  end of LEC L10: choose PIA L16 (PIA stints ${stints}): rival stop ${chosen.rivalStop.source} L${chosen.rivalStop.inLap}`);
  const s20 = at(endOf('LEC', 20) + 0.001);
  const later = undercutSweep('LEC', 'PIA', s20.st, s20.pitLoss, s20.rp, { rivalStopLap: 16, rivalStopStints: stints });
  out(`  end of LEC L20 (PIA stints ${later.rivalTyre.stints}): rival stop ${later.rivalStop.source}`
    + ` ${later.rivalStop.inLap != null ? `L${later.rivalStop.inLap}` : ''}; expired choice L${later.rivalStop.expiredChoice} (${later.rivalStop.expiredReason})`);
  // a choice still in the future after a tyre change of the rival: L40 chosen at L10, PIA stopped at L16
  const future = undercutSweep('LEC', 'PIA', s20.st, s20.pitLoss, s20.rp, { rivalStopLap: 40, rivalStopStints: stints });
  out(`  choose PIA L40 at the end of LEC L10, then the end of LEC L20 (PIA has changed tyres at L16): rival stop`
    + ` ${future.rivalStop.source} ${future.rivalStop.inLap != null ? `L${future.rivalStop.inLap}` : ''};`
    + ` expired choice L${future.rivalStop.expiredChoice} (${future.rivalStop.expiredReason})`);
}

out('');
out('7. D3: pit-lane visits with no tyre change, and the pit lane read causally');
{
  const s22 = load('session_2024_22_R.json');
  const now = 4518.3;
  const st = circleState(s22.lap_times, { sessionNow: now });
  const pl = estimatePitLoss(s22.lap_times, { sessionNow: now, sessionType: 'R' });
  const rp = extractRaceParams(s22.lap_times, [], s22.track_status || [], 1, { sessionNow: now, sessionType: 'R' });
  const oco = tyreStates(s22.lap_times, now).get('OCO');
  out(`  2024 R22 t = ${now} s: OCO tyre state: ${oco.compound} age ${oco.tyreAge} after lap ${oco.lapsCompleted}, fitted ${oco.fitted ? oco.fitted.compound : 'none'},`
    + ` in the pit lane ${oco.inPitLane}, stints ${oco.stints}`);
  for (const focus of ['HUL', 'LEC']) {
    const sw = undercutSweep(focus, 'OCO', st, pl, rp);
    out(`  focus ${focus} vs OCO: rival stop ${sw.rivalStop.source}; new set modelled for OCO: ${sw.rivalNextCompound ?? 'none (keeps its set)'}`);
  }
  // every in-lap whose next row is a tyre change, a clock between the line and the pit exit
  let clocks = 0;
  let differ = 0;
  let inLane = 0;
  for (const f of fs.readdirSync(CACHE).filter((x) => /^session_\d+_\d+_R\.json$/.test(x)).sort()) {
    const rows = load(f).lap_times;
    const byDrv = new Map();
    for (const r of rows) {
      if (!byDrv.has(r.Driver)) byDrv.set(r.Driver, []);
      byDrv.get(r.Driver).push(r);
    }
    for (const [drv, list] of byDrv) {
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
        const real = tyreStates(rows, t).get(drv);
        const fut = tyreStates(perturbFuture(rows, t), t).get(drv);
        if (real?.inPitLane) inLane += 1;
        const strip = (x) => JSON.stringify({ ...x, current: undefined });
        if (strip(real) !== strip(fut)) differ += 1;
      }
    }
  }
  out(`  every cached race, tyre changes with the pit exit after the in-lap's line: clocks ${clocks} (half way from the line to the exit);`
    + ` in the pit lane ${inLane}; tyre state differs with the future rows rewritten: ${differ}`);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
