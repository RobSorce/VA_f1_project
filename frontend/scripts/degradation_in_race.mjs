/**
 * In-race degradation and lap noise for the Monte Carlo (S2): the data behind
 * the rules of src/utils/raceSimulation.js that turn the stint fits of a race
 * so far into the values the lap model uses (raceDegradation,
 * lapNoiseFromFits, computePriors), and what the projection clocks of Monza
 * 2024 see with them.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/degradation_in_race.mjs
 * Writes docs/evidence/degradation_in_race.txt and prints the same text.
 *
 * Every number here is recomputed from the cached races with the same
 * definitions as computePriors and printed next to the value in PRIORS.
 *
 * Sections:
 *  B. Between / within race spread of the degradation per compound
 *     (raceMean, withinSd, betweenSd of PRIORS).
 *  A. Partial stints, per compound: every stint with at least
 *     PARTIAL_CHECK_LAPS clean laps; the fit on its first k clean laps (what a
 *     projection clock sees while the stint runs) against the fit on all of
 *     them, by k; the shortest k whose spread is below the compound's
 *     within-race spread (minFitLaps).
 *  C. Lap noise per race, dry races and races with intermediate / wet laps;
 *     the prior of each kind (s0, nu0 of computePriors), which
 *     lapNoiseFromFits uses only before the race's first fit; from the first
 *     fit the lap noise is the race's own pooled sigma (no prior mixed in).
 *  D. Monza 2024 (R16), every projection clock (lap 5 to the last but one):
 *     MEDIUM / HARD degradation the lap model uses (degradationFor) against
 *     the former rule (the plain mean of every fit so far), and the lap noise
 *     it uses (raceParams.lapNoise).
 *  E. Monza 2024: same-set lap-time change from the clock to lap 40 on the
 *     lap model (projectLapTimes, no stop), MEDIUM and HARD, at laps 12 and 30.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanStintLaps, fitStint, stintFits, MIN_FIT_LAPS } from '../src/utils/degradation.js';
import {
  extractRaceParams, degradationFor, projectLapTimes, PRIORS, PARTIAL_CHECK_LAPS,
} from '../src/utils/raceSimulation.js';
import { resolveSessionNow } from '../src/utils/raceTime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE_DIR = path.resolve(ROOT, 'backend/data/processed_cache');
const OUT_FILE = path.resolve(ROOT, 'docs/evidence/degradation_in_race.txt');

const report = [];
const r = (line = '') => { report.push(line); };
const f = (v, d = 4) => (v == null || Number.isNaN(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(d));
const u = (v, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const variance = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const sd = (a) => (a.length < 2 ? null : Math.sqrt(variance(a)));

const parseJson = (text) => JSON.parse(text.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));
const races = fs.readdirSync(CACHE_DIR)
  .map((name) => /^session_(\d{4})_(\d+)_R\.json$/.exec(name))
  .filter(Boolean)
  .map((m) => ({ file: m[0], year: Number(m[1]), round: Number(m[2]) }))
  .sort((a, b) => a.year - b.year || a.round - b.round)
  .map((rc) => ({ ...rc, session: parseJson(fs.readFileSync(path.join(CACHE_DIR, rc.file), 'utf8')) }));
const WET = new Set(['INTERMEDIATE', 'WET']);
const key = (c) => String(c || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
const isWetRace = (lt) => lt.some((x) => WET.has(key(x.Compound)));
const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD', 'ALL'];
const raceFits = races.map((rc) => stintFits(rc.session.lap_times));

r('In-race degradation and lap noise (Monte Carlo lap model, src/utils/raceSimulation.js)');
r(`Cached races: ${races.length}. Fits: utils/degradation.js (clean laps, fuel-corrected, OLS on TyreLife, MIN_FIT_LAPS = ${MIN_FIT_LAPS}).`);
r('');

// ══════════════════════════════════════════════════════════
r('=== B. Between / within race spread of the degradation (whole-race fits, races with >= 2 fits of the compound) ===');
r('withinSd = pooled sd of the fits inside a race; betweenSd = sd of the race means beyond what withinSd explains');
r('(variance of race means - withinSd^2 x mean of 1 / fits per race, at least 0); raceMean = mean of the race means.');
const hier = {};
{
  r('  compound  races  raceMean   withinSd  betweenSd    PRIORS raceMean / withinSd / betweenSd / races');
  for (const c of COMPOUNDS) {
    const groups = [];
    for (const fits of raceFits) {
      const sl = fits.filter((x) => x.slope != null && (c === 'ALL' || key(x.compound) === c)).map((x) => x.slope);
      if (sl.length >= 2) groups.push(sl);
    }
    let ssw = 0;
    let dfw = 0;
    for (const g of groups) { ssw += variance(g) * (g.length - 1); dfw += g.length - 1; }
    const tw2 = ssw / dfw;
    const means = groups.map(mean);
    const tb2 = Math.max(0, variance(means) - tw2 * mean(groups.map((g) => 1 / g.length)));
    hier[c] = { raceMean: mean(means), withinSd: Math.sqrt(tw2), betweenSd: Math.sqrt(tb2), races: groups.length };
    const p = PRIORS.degradation[c];
    r(`  ${pad(c, 8)}  ${lpad(groups.length, 5)}  ${lpad(f(hier[c].raceMean), 8)}   ${u(hier[c].withinSd, 4)}    ${u(hier[c].betweenSd, 4)}      ${f(p.raceMean)} / ${u(p.withinSd, 4)} / ${u(p.betweenSd, 4)} / ${p.races}`);
  }
}
r('');

// ══════════════════════════════════════════════════════════
r(`=== A. Partial stints: fit on the first k clean laps vs the whole stint (stints with >= ${PARTIAL_CHECK_LAPS} clean laps) ===`);
r('sd = standard deviation of (partial slope - whole slope), s/lap of tyre age; mean = its mean. minFitLaps = the');
r('shortest k whose sd is below the compound\'s withinSd (section B): a shorter fit strays further from its own');
r('whole-stint slope than the stints of one race differ from one another, so the other stints say more about the');
r('wear ahead than it does. raceDegradation uses only fits with at least minFitLaps clean laps.');
{
  const diffs = new Map(COMPOUNDS.map((c) => [c, new Map()]));
  const counts = new Map(COMPOUNDS.map((c) => [c, 0]));
  for (const rc of races) {
    for (const st of cleanStintLaps(rc.session.lap_times)) {
      if (st.laps.length < PARTIAL_CHECK_LAPS) continue;
      const whole = fitStint(st.laps);
      if (!whole) continue;
      for (const c of [key(st.compound), 'ALL']) {
        if (!diffs.has(c)) continue;
        counts.set(c, counts.get(c) + 1);
        for (let k = MIN_FIT_LAPS; k <= PARTIAL_CHECK_LAPS; k++) {
          const part = fitStint(st.laps.slice(0, k));
          if (!part) continue;
          if (!diffs.get(c).has(k)) diffs.get(c).set(k, []);
          diffs.get(c).get(k).push(part.slope - whole.slope);
        }
      }
    }
  }
  const ks = [];
  for (let k = MIN_FIT_LAPS; k <= PARTIAL_CHECK_LAPS; k++) ks.push(k);
  r(`  compound  stints  withinSd  ${ks.map((k) => lpad(`k=${k}`, 7)).join(' ')}   minFitLaps (PRIORS)`);
  for (const c of COMPOUNDS) {
    const tw = hier[c].withinSd;
    const sds = ks.map((k) => sd(diffs.get(c).get(k) || []));
    const first = sds.findIndex((s) => s != null && s < tw);
    const chosen = first >= 0 ? ks[first] : PARTIAL_CHECK_LAPS;
    r(`  ${pad(c, 8)}  ${lpad(counts.get(c), 6)}  ${u(tw, 4)}    ${sds.map((s) => lpad(u(s, 4), 7)).join(' ')}   ${chosen} (${PRIORS.degradation[c].minFitLaps})`);
    r(`  ${pad('  mean', 8)}  ${lpad('', 6)}  ${pad('', 6)}    ${ks.map((k) => lpad(f(mean(diffs.get(c).get(k) || [])), 7)).join(' ')}`);
  }
}
r('');

// ══════════════════════════════════════════════════════════
r('=== C. Lap noise: pooled residual sigma of the whole-race stint fits, per race ===');
r('Prior of a kind of race (computePriors, lapNoisePrior): the per-race variances as a scaled-inverse-chi-square, moments');
r('matched: nu0 = 4 + 2 / cv^2 (cv: coefficient of variation of the variances), s0 = sqrt(mean x (nu0 - 2) / nu0).');
r("lapNoiseFromFits uses s0 only before the race's first fit; from the first fit a race at its clock uses its own pooled");
r('sigma, sqrt(sse / dof) over its fits so far (no prior mixed in).');
{
  const rows = races.map((rc, i) => {
    let sse = 0;
    let dof = 0;
    for (const ft of raceFits[i]) {
      if (ft.slope == null || !(ft.n > 2)) continue;
      sse += ft.residualSigma ** 2 * (ft.n - 2);
      dof += ft.n - 2;
    }
    return { rc, wet: isWetRace(rc.session.lap_times), v: dof ? sse / dof : null, sse, dof };
  });
  for (const [label, kind, sel] of [['dry races', 'dry', rows.filter((x) => !x.wet)], ['wet races', 'wet', rows.filter((x) => x.wet)]]) {
    const vars = sel.map((x) => x.v).filter((x) => x != null);
    const m = mean(vars);
    const cv2 = variance(vars) / (m * m);
    const nu0 = 4 + 2 / cv2;
    const s0 = Math.sqrt((m * (nu0 - 2)) / nu0);
    const p = PRIORS.lapNoise[kind];
    r(`  ${pad(label, 10)} races ${lpad(sel.length, 2)}: per-race sigma median ${u(Math.sqrt(median(vars)))}, min ${u(Math.sqrt(Math.min(...vars)))}, max ${u(Math.sqrt(Math.max(...vars)))};`
      + ` s0 ${u(s0)} s, nu0 ${u(nu0, 2)} (PRIORS ${p.value} s, ${p.nu0}); residual dof per race median ${median(sel.map((x) => x.dof))}`);
  }
  r(`  all races pooled (PRIORS.lapNoise.value, the former prior): ${u(Math.sqrt(rows.reduce((a, x) => a + x.sse, 0) / rows.reduce((a, x) => a + x.dof, 0)))} s`);
  r(`  per race: ${rows.map((x) => `${x.rc.year} R${x.rc.round}${x.wet ? ' (wet)' : ''} ${u(Math.sqrt(x.v))}`).join(', ')}`);
}
r('');

// ══════════════════════════════════════════════════════════
const monza = races.find((x) => x.year === 2024 && x.round === 16);
const MZ = monza.session.lap_times;
const mzMax = Math.max(...MZ.map((x) => Number(x.LapNumber) || 0));
const paramsAt = (lap) => {
  const sessionNow = resolveSessionNow({ currentLap: lap, lapTimes: MZ });
  return extractRaceParams(MZ, [], monza.session.track_status, lap, { sessionNow, sessionType: 'R' });
};
r('=== D. Monza 2024 (R16): what the lap model uses at every projection clock (lap-mode clock) ===');
r('used = degradationFor (fits used / fits too short, source); former = plain mean of every fit so far (the rule');
r("before: compoundDegradation of all fits, replacing the prior from the first fit). Lap noise: used (the race's own");
r('pooled sigma in brackets: the same from the first fit; before it the value used is the prior).');
{
  r("  lap   MEDIUM used (n / short, source)   former      HARD used (n / short, source)   former      lap noise used (race's own)");
  const c = { m: 0, h: 0, noise: 0, n: 0, mPrior: 0, hPrior: 0, minM: Infinity, minH: Infinity, minNoise: Infinity, maxNoise: -Infinity };
  for (let lap = 5; lap < mzMax; lap++) {
    const rp = paramsAt(lap);
    const m = degradationFor(rp, 'MEDIUM');
    const h = degradationFor(rp, 'HARD');
    const tm = rp.tyreDeg.MEDIUM;
    const th = rp.tyreDeg.HARD;
    const cell = (d, t) => `${lpad(f(d.mean), 8)} (${lpad(d.source === 'race' ? d.n : 0, 2)} / ${lpad(t ? t.short : 0, 2)}, ${pad(d.source, 5)})`;
    r(`  ${lpad(lap, 3)}   ${cell(m, tm)}        ${lpad(f(tm?.allFits?.mean), 8)}    ${cell(h, th)}      ${lpad(f(th?.allFits?.mean), 8)}    ${u(rp.lapNoise)} (${u(rp.estimates.lapNoise.raceValue)})`);
    c.n += 1;
    if (m.mean > 0) c.m += 1;
    if (h.mean > 0) c.h += 1;
    if (m.source === 'prior') c.mPrior += 1;
    if (h.source === 'prior') c.hPrior += 1;
    if (rp.lapNoise >= 0.3 && rp.lapNoise <= 0.6) c.noise += 1;
    c.minM = Math.min(c.minM, m.mean);
    c.minH = Math.min(c.minH, h.mean);
    c.minNoise = Math.min(c.minNoise, rp.lapNoise);
    c.maxNoise = Math.max(c.maxNoise, rp.lapNoise);
  }
  r(`  clocks ${c.n}: MEDIUM > 0 at ${c.m} (min ${f(c.minM)}; the prior at ${c.mPrior}), HARD > 0 at ${c.h} (min ${f(c.minH)}; the prior at ${c.hPrior}),`
    + ` lap noise in [0.3, 0.6] s at ${c.noise} (${u(c.minNoise)} - ${u(c.maxNoise)} s)`);
  const end = extractRaceParams(MZ, [], monza.session.track_status, mzMax, { sessionNow: Infinity, sessionType: 'R' });
  r(`  race over: MEDIUM ${f(degradationFor(end, 'MEDIUM').mean)} (fits used ${end.tyreDeg.MEDIUM.n}, short ${end.tyreDeg.MEDIUM.short}; every fit: mean ${f(end.tyreDeg.MEDIUM.allFits.mean)},`
    + ` n ${end.tyreDeg.MEDIUM.allFits.n}, negative ${end.tyreDeg.MEDIUM.allFits.negativeCount}), HARD ${f(degradationFor(end, 'HARD').mean)}, lap noise ${u(end.lapNoise)} s`);
}
r('');

// ══════════════════════════════════════════════════════════
r('=== E. Monza 2024: same-set lap-time change from the clock to lap 40 (projectLapTimes, no stop) ===');
{
  for (const lap of [12, 30]) {
    const rp = paramsAt(lap);
    const parts = [];
    for (const c of ['MEDIUM', 'HARD']) {
      // a set at tyre age 10 at the clock, measured there (refAge 10): lap 40 against the lap at the clock
      const laps = projectLapTimes({ raceParams: rp, compound: c, tyreAge: 9, basePace: 85, refAge: 10, fromLap: lap, toLap: 40 });
      parts.push(`${c} ${f(laps[laps.length - 1].lapTime - laps[0].lapTime, 2)} s`);
    }
    r(`  from lap ${lap}: ${parts.join(', ')} (degradation x ${40 - lap} laps of tyre age)`);
  }
}
r('');

const text = report.join('\n');
fs.writeFileSync(OUT_FILE, `${text}\n`);
console.log(text);
console.log(`\nwritten ${path.relative(ROOT, OUT_FILE)}`);
