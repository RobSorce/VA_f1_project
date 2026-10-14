/**
 * Undercut and "pit in k laps" on Monza 2024 (utils/undercut.js), the
 * evidence of S7 and C4. Writes notes/experiments/undercut_monza.txt and
 * prints the same text.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/undercut_monza.mjs
 *
 * Every projection is causal: the clock is just after the focus driver
 * completes lap n - 1 (session seconds), the race params are extractRaceParams
 * at that clock (degradation by compound, fresh-tyre delta, stint-life
 * survival), the pit loss estimatePitLoss at that clock. The "hindsight" rows
 * keep the cars where they are at that clock but take the estimates of the
 * whole race (sessionNow = Infinity), to show what the same maths says when
 * the degradation fits are those measured over the race.
 *
 * Sections:
 *  1. the real stops of the front runners (in-laps);
 *  2. the undercut sweep (Undercut Calculator): focus vs rival at several laps;
 *  3. "pit in k laps" (Circle of Doom), focus LEC and PIA, k = 0..10, rivals
 *     stop off and on;
 *  4. k = 0 against the pit window: every focus every 60 s of the race;
 *  5. where the sweep puts the best in-lap: the six NOR / LEC / PIA pairs at
 *     the end of laps 8-13, with the estimates at the time, with the rival
 *     pinned to its real stop and with the whole race's estimates; the same
 *     sweeps with no tyre model (zero degradation and fresh-tyre delta: the
 *     pit lap cannot matter, every row must have the same gap); the best lap
 *     read at the flag instead of the end of the table;
 *  6. the tyre chips (tyreStates current) against driverStateAt (R6), and the
 *     compound modelled on a car's out-lap against the set already fitted,
 *     at every out-lap after a tyre change of every cached race (pit exit + 1 s);
 *     after a pit-lane visit with no tyre change (R2), no new set modelled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRaceParams, degradationFor } from '../src/utils/raceSimulation.js';
import { circleState, pitWindow } from '../src/utils/circleOfDoom.js';
import { estimatePitLoss } from '../src/utils/pitLoss.js';
import { undercutSweep, pitInLaps, tyreStates } from '../src/utils/undercut.js';
import { driverStateAt } from '../src/utils/driverState.js';
import { stintsByDriver } from '../src/utils/stints.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../../backend/data/processed_cache');
const FILE = path.resolve(CACHE_DIR, 'session_2024_16_R.json');
const OUT_FILE = path.resolve(HERE, '../../notes/experiments/undercut_monza.txt');

const raw = fs.readFileSync(FILE, 'utf8');
const session = JSON.parse(raw.replace(/\bNaN\b/g, 'null'));
const lapTimes = session.lap_times;
const trackStatus = session.track_status || [];
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const sgn = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`);

const endOf = (drv, lap) => lapTimes.find((r) => r.Driver === drv && r.LapNumber === lap)?.Time;
const at = (now) => ({
  st: circleState(lapTimes, { sessionNow: now }),
  pitLoss: estimatePitLoss(lapTimes, { sessionNow: now, sessionType: 'R' }),
  rp: extractRaceParams(lapTimes, [], trackStatus, 1, { sessionNow: now, sessionType: 'R' }),
});
const whole = {
  pitLoss: estimatePitLoss(lapTimes, { sessionNow: Infinity, sessionType: 'R' }),
  rp: extractRaceParams(lapTimes, [], trackStatus, 1, { sessionNow: Infinity, sessionType: 'R' }),
};
const degText = (rp, c) => {
  const d = degradationFor(rp, c);
  return `${c} ${sgn(d.mean, 4)} s/lap (${d.source}, n ${d.n})`;
};
const freshText = (rp) => {
  const f = rp.estimates.freshDelta;
  return `${sgn(f.value, 3)} s (${f.source}, n ${f.n}${f.clamped ? ', clamped' : ''})`;
};

out('Undercut and "pit in k laps" on Monza 2024 (2024 R16), utils/undercut.js');
out('script: frontend/scripts/undercut_monza.mjs');
out('');

// ── 1. Real stops ──
out('1. Real stops (in-laps, tyre change) of the front runners');
for (const d of ['PIA', 'LEC', 'NOR', 'SAI', 'HAM', 'VER', 'RUS']) {
  const stops = lapTimes.filter((r) => r.Driver === d && r.PitInTimeSeconds != null)
    .sort((a, b) => a.LapNumber - b.LapNumber)
    .map((r) => `L${r.LapNumber} (${r.Compound} age ${r.TyreLife})`);
  out(`  ${d}: ${stops.join(', ') || 'none'}`);
}
out('');

// ── 2. Undercut sweep ──
out('2. Undercut sweep: gap at ONE lap for every row (the end of the latest out-lap of the table: both cars have stopped in every row), + = focus ahead');
const sweepCases = [['LEC', 'PIA', 11], ['LEC', 'PIA', 12], ['LEC', 'PIA', 13], ['LEC', 'PIA', 14],
  ['NOR', 'LEC', 12], ['NOR', 'LEC', 13], ['PIA', 'LEC', 15]];
for (const [focus, rival, lap] of sweepCases) {
  const now = endOf(focus, lap - 1) + 0.001;
  const s = at(now);
  for (const [label, rp, pitLoss] of [['causal', s.rp, s.pitLoss], ['hindsight', whole.rp, whole.pitLoss]]) {
    const sw = undercutSweep(focus, rival, s.st, pitLoss, rp, {});
    if (!sw.available) {
      out(`  ${focus} vs ${rival}, end of lap ${lap - 1} [${label}]: unavailable (${sw.reason})`);
      continue;
    }
    out(`  ${focus} vs ${rival}, end of lap ${lap - 1} [${label}]: gap now ${sgn(sw.currentGap)} s; `
      + `pit loss ${sw.pitLoss.median.toFixed(1)} s (${sw.pitLoss.source}, n ${sw.pitLoss.n}); `
      + `${degText(rp, sw.focusTyre.compound)}; new set ${degText(rp, sw.nextCompound)}; fresh-tyre delta ${freshText(rp)}`);
    out(`    rival ${rival} stops: ${sw.rivalStop.inRace ? `in-lap L${sw.rivalStop.inLap}` : 'no stop'} `
      + `(${sw.rivalStop.source}${sw.rivalStop.dueAge != null ? `, due at tyre age ${sw.rivalStop.dueAge}` : ''}); `
      + `new-tyre gain on the first flying lap ${sgn(sw.freshGain, 3)} s`);
    out(`    ${sw.rows.map((r) => `L${r.inLap} ${sgn(r.gap)}`).join(' | ')}`);
    const distinct = new Set(sw.rows.map((r) => r.gap.toFixed(6))).size;
    out(`    rows ${sw.rows.length}, distinct gaps ${distinct}; best in-lap L${sw.best.inLap} (${sgn(sw.best.gap)} s at the end of L${sw.best.horizonLap})`);
  }
}
out('');

// ── 3. Pit in k laps ──
out('3. Pit in k laps (Circle of Doom): focus stays out k laps, in-lap = lap in progress + k, rejoin at the end of the next lap');
out('   P = projected place at the end of the out-lap; P(pit now) = the place at that same lap when pitting now;');
out('   vs now = P(pit now) - P (+ = waiting ends better); s vs now = focus crossing waiting - pitting now (+ = waiting costs)');
for (const [focus, lap] of [['LEC', 13], ['PIA', 13], ['LEC', 25]]) {
  const now = endOf(focus, lap - 1) + 0.001;
  const s = at(now);
  const win = pitWindow(focus, s.st, s.pitLoss);
  for (const rivalsStop of [false, true]) {
    const pk = pitInLaps(focus, s.st, s.pitLoss, s.rp, { rivalsStop });
    out(`  ${focus}, end of lap ${lap - 1} (P${pk.currentPosition}), rivals stop ${rivalsStop ? 'ON' : 'off'}: `
      + `pit loss ${s.pitLoss.median.toFixed(1)} s (${s.pitLoss.source}, n ${s.pitLoss.n}); `
      + `${degText(s.rp, pk.tyre.compound)} age ${pk.tyre.tyreAge}; new set ${degText(s.rp, pk.nextCompound)}; fresh ${freshText(s.rp)}`);
    out('    k  in-lap  target   P  P(pit now)  vs now  s vs now  ghost offset  rivals stopped');
    for (const r of pk.rows) {
      out(`   ${String(r.k).padStart(2)}  L${String(r.inLap).padEnd(5)} L${String(r.targetLap).padEnd(5)} `
        + `${`P${r.predictedPosition}`.padStart(4)}  ${`P${r.positionIfPitNow}`.padStart(10)}  ${sgn(r.positionsVsNow, 0).padStart(6)}  `
        + `${sgn(r.secondsVsNow).padStart(8)}  ${r.ghostOffset.toFixed(4).padStart(12)}  ${r.rivalStops.join(',') || '-'}`);
    }
    out(`    window: P${win.predictedPosition} at L${win.targetLap}, rejoin offset ${win.rejoinOffset.toFixed(4)}; `
      + `k = 0 row identical: ${pk.rows[0].predictedPosition === win.predictedPosition
        && pk.rows[0].predictedCrossing === win.predictedCrossing && pk.rows[0].ghostOffset === win.rejoinOffset}`);
  }
}
out('');

// ── 4. k = 0 against the pit window ──
out('4. k = 0 against the pit window: every running car as focus, every 60 s of the race');
const first = Math.min(...lapTimes.filter((r) => r.LapNumber === 2).map((r) => r.LapStartTime));
const last = Math.max(...lapTimes.map((r) => r.Time ?? 0));
let windows = 0;
let same = 0;
let kRows = 0;
for (let now = first; now < last; now += 60) {
  const s = at(now);
  for (const c of s.st.cars) {
    const win = pitWindow(c.driver, s.st, s.pitLoss);
    const pk = pitInLaps(c.driver, s.st, s.pitLoss, s.rp);
    if (!win.available) continue;
    windows += 1;
    kRows += pk.rows.length;
    const r0 = pk.rows[0];
    if (r0.predictedPosition === win.predictedPosition && r0.predictedCrossing === win.predictedCrossing
      && r0.ghostOffset === win.rejoinOffset && r0.targetLap === win.targetLap) same += 1;
  }
}
out(`  pit windows ${windows}, k = 0 identical (crossing, place, target lap, rejoin offset) ${same}; k rows projected ${kRows}`);

out('');

// ── 5. Best in-lap ──
out('5. Where the sweep puts the best in-lap (real first stops: NOR L14, LEC L15, PIA L16)');
const realStop = (d) => lapTimes.filter((r) => r.Driver === d && r.PitInTimeSeconds != null)
  .map((r) => r.LapNumber).sort((a, b) => a - b)[0];
{
  const pairs = [['LEC', 'PIA'], ['PIA', 'LEC'], ['NOR', 'PIA'], ['PIA', 'NOR'], ['NOR', 'LEC'], ['LEC', 'NOR']];
  const tally = {};
  const add = (key, sw) => {
    if (!tally[key]) tally[key] = { cases: 0, near: 0, first: 0, last: 0, best: [] };
    const t = tally[key];
    t.cases += 1;
    if (sw.best.inLap >= 14 && sw.best.inLap <= 16) t.near += 1;
    if (sw.best.inLap === sw.rows[0].inLap) t.first += 1;
    if (sw.best.inLap === sw.rows.at(-1).inLap) t.last += 1;
    t.best.push(sw.best.inLap);
  };
  let maxSpread = 0;
  let maxRivalSpread = 0;
  for (const [focus, rival] of pairs) {
    for (let lap = 8; lap <= 13; lap++) {
      const s = at(endOf(focus, lap) + 0.001);
      const sweeps = {
        'at the time (the view)': undercutSweep(focus, rival, s.st, s.pitLoss, s.rp),
        'rival pinned to its real stop': undercutSweep(focus, rival, s.st, s.pitLoss, s.rp, { rivalStopLap: realStop(rival) }),
        'whole race estimates': undercutSweep(focus, rival, s.st, whole.pitLoss, whole.rp),
        'at the time, read at the flag': undercutSweep(focus, rival, s.st, s.pitLoss, s.rp, { sweepLaps: 60 }),
        'whole race, read at the flag': undercutSweep(focus, rival, s.st, whole.pitLoss, whole.rp, { sweepLaps: 60 }),
      };
      for (const [k, sw] of Object.entries(sweeps)) {
        add(k, sw);
        const rc = sw.rows.map((r) => r.rivalCrossing);
        maxRivalSpread = Math.max(maxRivalSpread, Math.max(...rc) - Math.min(...rc));
      }
      const zero = { mean: 0, median: 0, stdDev: 0, n: 1, negativeCount: 0, source: 'race' };
      const flat = { ...s.rp, tyreDeg: { SOFT: zero, MEDIUM: zero, HARD: zero }, freshDelta: 0 };
      const z = undercutSweep(focus, rival, s.st, s.pitLoss, flat, { rivalStopLap: realStop(rival) });
      const g = z.rows.map((r) => r.gap);
      maxSpread = Math.max(maxSpread, Math.max(...g) - Math.min(...g));
    }
  }
  out('   case                            cases  best in L14-16  best = first row  best = last row  best in-laps');
  for (const [k, t] of Object.entries(tally)) {
    out(`   ${k.padEnd(32)} ${String(t.cases).padStart(5)}  ${String(t.near).padStart(14)}  ${String(t.first).padStart(16)}  ${String(t.last).padStart(15)}  `
      + `L${Math.min(...t.best)}-L${Math.max(...t.best)}`);
  }
  out(`   no tyre model (zero degradation, zero fresh-tyre delta), rival at its real stop: largest spread of the gaps over the rows ${maxSpread.toExponential(2)} s (36 sweeps)`);
  out(`   the rival's crossing of the horizon, largest spread over the rows of one sweep: ${maxRivalSpread} s`);
  const s12 = at(endOf('LEC', 12) + 0.001);
  const dM = degradationFor(s12.rp, 'MEDIUM');
  const dH = degradationFor(s12.rp, 'HARD');
  const dMw = degradationFor(whole.rp, 'MEDIUM');
  const dHw = degradationFor(whole.rp, 'HARD');
  out(`   why: with no traffic the rival's crossing does not depend on the focus's in-lap, so the best row is the focus's fastest`);
  out('   way to the horizon H: the stop that balances the wear of the old set (deg_old x its age at the stop) against the');
  out('   new one (deg_new x laps from the stop to H), p ~ (deg_old x stint start + deg_new x H) / (deg_old + deg_new).');
  out(`   End of L12, LEC: at the time MEDIUM ${sgn(dM.mean, 4)} (${dM.source}) and HARD ${sgn(dH.mean, 4)} (${dH.source}) s/lap; set from lap 1;`);
  out(`     H = 29 (end of the table): p ~ ${(dH.mean * 29 / (dM.mean + dH.mean)).toFixed(1)}, before the lap in progress (13): the first row;`);
  out(`     H = 53 (the flag): p ~ ${(dH.mean * 53 / (dM.mean + dH.mean)).toFixed(1)}.`);
  out(`   Whole race MEDIUM ${sgn(dMw.mean, 4)}, HARD ${sgn(dHw.mean, 4)} s/lap: p ~ ${(dHw.mean * 29 / (dMw.mean + dHw.mean)).toFixed(1)} for H = 29, ${(dHw.mean * 53 / (dMw.mean + dHw.mean)).toFixed(1)} for H = 53.`);
}
out('');

// ── 6. Tyre chips and out-lap compounds ──
out('6. Out-laps after a tyre change, every cached race, pit exit + 1 s: tyre chip (tyreStates current) vs driverStateAt (R6);');
out('   the compound the model fits on that out-lap (tyreStates fitted, used by carPlan) vs the stint in force');
{
  let cases = 0;
  let chipDiffer = 0;
  let fittedWrong = 0;
  let fittedMissing = 0;
  const parse = (f) => JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8').replace(/\bNaN\b/g, 'null'));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  for (const f of fs.readdirSync(CACHE_DIR).filter((x) => /^session_\d+_\d+_R\.json$/.test(x)).sort()) {
    const lt = parse(f).lap_times;
    if (!lt?.length) continue;
    const byKey = new Map(lt.map((r) => [`${r.Driver}|${r.LapNumber}`, r]));
    for (const r of lt) {
      if (num(r.PitInTimeSeconds) == null) continue;
      const outLap = byKey.get(`${r.Driver}|${num(r.LapNumber) + 1}`);
      const pout = num(outLap?.PitOutTimeSeconds);
      if (pout == null || !(num(outLap.Time) > pout + 1)) continue;
      const now = pout + 1;
      const stints = stintsByDriver(lt, { sessionNow: now });
      const mine = stints[r.Driver];
      if (!mine?.length || mine.at(-1).StartLap !== num(r.LapNumber) + 1) continue; // tyre change only
      const t = tyreStates(lt, now).get(r.Driver);
      const ds = driverStateAt(lt, r.Driver, now, { stints });
      if (!t || ds.compound == null) continue;
      cases += 1;
      if (t.current.compound !== String(ds.compound).toUpperCase() || t.current.tyreLife !== ds.tyreLife) chipDiffer += 1;
      if (!t.fitted) fittedMissing += 1;
      else if (t.fitted.compound !== String(ds.compound).toUpperCase()) fittedWrong += 1;
    }
  }
  out(`   out-lap clocks ${cases}: chip != driverStateAt ${chipDiffer}; modelled new set missing ${fittedMissing}, a compound other than the one fitted ${fittedWrong}`);
}
out('   Out-laps after a pit-lane visit with NO tyre change (R2: not a stop), every cached race, pit exit + 1 s: that car as');
out('   the rival of the car ahead / behind (undercutSweep): a new set modelled for it (rivalNextCompound) should be none');
{
  let cases = 0;
  let newSet = 0;
  let unavailable = 0;
  const parse = (f) => JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8').replace(/\bNaN\b/g, 'null'));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  for (const f of fs.readdirSync(CACHE_DIR).filter((x) => /^session_\d+_\d+_R\.json$/.test(x)).sort()) {
    const lt = parse(f).lap_times;
    if (!lt?.length) continue;
    const byKey = new Map(lt.map((r) => [`${r.Driver}|${r.LapNumber}`, r]));
    for (const r of lt) {
      if (num(r.PitInTimeSeconds) == null) continue;
      const outLap = byKey.get(`${r.Driver}|${num(r.LapNumber) + 1}`);
      const pout = num(outLap?.PitOutTimeSeconds);
      if (pout == null || !(num(outLap.Time) > pout + 1)) continue;
      const now = pout + 1;
      const mine = stintsByDriver(lt, { sessionNow: now })[r.Driver];
      if (!mine?.length || mine.at(-1).StartLap === num(r.LapNumber) + 1) continue; // no tyre change only
      const st = circleState(lt, { sessionNow: now });
      const order = st.cars.filter((c) => c.position != null).map((c) => c.driver);
      const i = order.indexOf(r.Driver);
      const focus = i > 0 ? order[i - 1] : order[i + 1];
      if (i < 0 || !focus) continue;
      const rp = extractRaceParams(lt, [], [], 1, { sessionNow: now, sessionType: 'R' });
      const sw = undercutSweep(focus, r.Driver, st, estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' }), rp);
      cases += 1;
      if (!sw.available) { unavailable += 1; continue; }
      if (sw.rivalNextCompound != null) newSet += 1;
    }
  }
  out(`   clocks ${cases} (sweep unavailable ${unavailable}): a new set modelled ${newSet}`);
}

fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
