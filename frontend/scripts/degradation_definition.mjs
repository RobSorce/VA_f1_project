/**
 * The shared degradation definition (src/utils/degradation.js, same as
 * backend/data/processors/degradation.py) on the cached races.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/degradation_definition.mjs
 * Writes notes/experiments/degradation_definition_monza.txt and prints the
 * same text.
 *
 * Part 1, Monza 2024 (round 16): what the clean-lap rule removes, every
 * stint's fit, MEDIUM / HARD compound degradation, PIA's per-stint slopes for
 * laps 10-25, and the consistency sigma of every classified finisher.
 * Part 2, every cached race: the data behind the three assumptions of the
 * module (fuel effect not identifiable, MIN_FIT_LAPS, the slow-outlier rule)
 * and what the outlier rule changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanStintLaps, stintFits, fitStint, compoundDegradation, consistencySigma, isCleanLap,
  fuelCorrectedTime, FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS, OUTLIER_K, MAD_TO_SIGMA,
  MIN_ROBUST_SCALE_S, MAX_LAP_TIME_S,
} from '../src/utils/degradation.js';
import { hasPitIn, hasPitOut, isGreenLap } from '../src/utils/raceTime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../../backend/data/processed_cache');
const OUT_FILE = path.resolve(HERE, '../../notes/experiments/degradation_definition_monza.txt');

const report = [];
const r = (line = '') => report.push(line);

const parseJson = (text) => JSON.parse(text.replace(/([:\[,]\s*)-?NaN\b/g, '$1null'));
const load = (file) => parseJson(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
const races = fs.readdirSync(CACHE_DIR)
  .map((f) => /^session_(\d{4})_(\d+)_R\.json$/.exec(f))
  .filter(Boolean)
  .map((m) => ({ file: m[0], year: Number(m[1]), round: Number(m[2]) }))
  .sort((a, b) => a.year - b.year || a.round - b.round);

const f3 = (v) => (v == null ? '   -  ' : v.toFixed(3));
const f4 = (v) => (v == null ? '    -   ' : (v >= 0 ? '+' : '') + v.toFixed(4));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(2)}%` : '-');

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function quantile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  const h = (a.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return a[lo] + (h - lo) * (a[hi] - a[lo]);
}
const byLap = (a, b) => Number(a.LapNumber) - Number(b.LapNumber);

/** Laps of step 2 (before the outlier step) of one cleanStintLaps entry. */
const baseLaps = (st) => [...st.laps, ...st.outliers].sort(byLap);

/** Plain OLS of the fuel-corrected time on TyreLife at any n >= 3 (diagnostics only). */
function olsAnyN(laps) {
  const n = laps.length;
  if (n < 3) return null;
  const xs = laps.map((lt) => Number(lt.TyreLife));
  const ys = laps.map(fuelCorrectedTime);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const a = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - a - slope * xs[i]) ** 2;
  const sigma = Math.sqrt(sse / (n - 2));
  return { slope, se: sigma / Math.sqrt(sxx), sigma };
}

/** Residuals of a fitStint fit, and the robust scale of the outlier step. */
function residualsOf(laps, fit) {
  const e = laps.map((lt) => fuelCorrectedTime(lt) - (fit.intercept + fit.slope * Number(lt.TyreLife)));
  const m = median(e);
  const mad = median(e.map((v) => Math.abs(v - m)));
  return { e, m, robust: MAD_TO_SIGMA * mad };
}

// ---------------------------------------------------------------------------
// Part 1: Monza 2024
// ---------------------------------------------------------------------------
const MONZA = 'session_2024_16_R.json';
const monza = load(MONZA);
const mLaps = monza.lap_times;

r('Shared degradation definition (src/utils/degradation.js = backend/data/processors/degradation.py)');
r(`Constants: FUEL_EFFECT_S_PER_LAP ${FUEL_EFFECT_S_PER_LAP} s/lap (assumption), MIN_FIT_LAPS ${MIN_FIT_LAPS}, `
  + `OUTLIER_K ${OUTLIER_K}, MAD_TO_SIGMA ${MAD_TO_SIGMA}, MIN_ROBUST_SCALE_S ${MIN_ROBUST_SCALE_S}, MAX_LAP_TIME_S ${MAX_LAP_TIME_S}`);
r('All at sessionNow = Infinity (the whole race). Slopes in s per lap of tyre life; slope = fuel-corrected, raw = LapTimeSeconds.');
r('');
r('=== Part 1: Monza 2024 (round 16) ===');
r('');

// Clean-lap rule, step by step (first failing condition counts)
{
  const rows = mLaps.filter((lt) => lt?.Driver);
  const reasons = { 'lap 1': 0, 'in-lap (pit entry)': 0, 'out-lap (pit exit)': 0, 'not green (TrackStatus != 1)': 0,
    [`LapTimeSeconds missing or >= ${MAX_LAP_TIME_S}`]: 0, 'TyreLife missing': 0 };
  const keys = Object.keys(reasons);
  for (const lt of rows) {
    const t = Number(lt.LapTimeSeconds);
    if (Number(lt.LapNumber) <= 1) reasons[keys[0]] += 1;
    else if (hasPitIn(lt)) reasons[keys[1]] += 1;
    else if (hasPitOut(lt)) reasons[keys[2]] += 1;
    else if (!isGreenLap(lt)) reasons[keys[3]] += 1;
    else if (lt.LapTimeSeconds == null || !(t > 0 && t < MAX_LAP_TIME_S)) reasons[keys[4]] += 1;
    else if (lt.TyreLife == null || !Number.isFinite(Number(lt.TyreLife))) reasons[keys[5]] += 1;
  }
  const clean = cleanStintLaps(mLaps);
  const kept = clean.reduce((s, st) => s + st.laps.length, 0);
  const outl = clean.reduce((s, st) => s + st.outliers.length, 0);
  const base = rows.filter(isCleanLap).length;
  r(`Clean-lap rule (completed lap rows: ${rows.length})`);
  for (const k of keys) r(`  removed, ${pad(k, 34)} ${lpad(reasons[k], 4)}`);
  r(`  usable after step 2                         ${lpad(base, 4)}`);
  r(`  removed, slow outlier (step 3)              ${lpad(outl, 4)}  (${pct(outl, base)} of the step-2 laps)`);
  r(`  clean laps                                  ${lpad(kept, 4)}`);
  r('  slow outliers (driver stint: lap residual-minus-median / robust sigma):');
  for (const st of clean) {
    if (!st.outliers.length) continue;
    const laps = baseLaps(st);
    const fit = fitStint(laps);
    const { e, m, robust } = residualsOf(laps, fit);
    const scale = Math.max(robust, MIN_ROBUST_SCALE_S);
    const parts = st.outliers.map((lt) => {
      const i = laps.indexOf(lt);
      return `L${lt.LapNumber} +${(e[i] - m).toFixed(2)} s / ${scale.toFixed(3)} s = ${((e[i] - m) / scale).toFixed(1)}`;
    });
    r(`    ${st.driver} ${st.stintNumber} ${pad(st.compound, 6)}: ${parts.join('; ')}`);
  }
  r('');
}

// Every stint's fit
const mFits = stintFits(mLaps);
{
  const outByStint = new Map(cleanStintLaps(mLaps).map((st) => [`${st.driver}|${st.stintNumber}`, st.outliers.length]));
  r('Per-stint fits (all laps of each stint):');
  r('  drv st compound laps    n  out      slope        raw       s.e.   sigma');
  for (const f of mFits) {
    r(`  ${f.driver} ${lpad(f.stintNumber, 2)} ${pad(f.compound, 8)} ${lpad(`${f.startLap}-${f.endLap}`, 5)} ${lpad(f.n, 4)} `
      + `${lpad(outByStint.get(`${f.driver}|${f.stintNumber}`), 4)}  ${f4(f.slope)}  ${f4(f.rawSlope)}  `
      + `${f.slopeStdErr == null ? '   -  ' : f.slopeStdErr.toFixed(4)}  ${f3(f.residualSigma)}`
      + `${f.slope == null ? `   (n < ${MIN_FIT_LAPS}: no fit)` : ''}`);
  }
  const fitted = mFits.filter((f) => f.slope != null);
  r(`  stints ${mFits.length}, fitted ${fitted.length}; slope - raw = ${FUEL_EFFECT_S_PER_LAP} on every fitted stint: `
    + `${fitted.every((f) => Math.abs(f.slope - f.rawSlope - FUEL_EFFECT_S_PER_LAP) < 1e-9)}`);
  r('');
}

// Compound degradation
{
  const deg = compoundDegradation(mFits);
  r('Compound degradation (compoundDegradation of the per-stint fits, fuel-corrected slope, s/lap):');
  r('  compound    n    mean     median   stdDev  negative');
  for (const c of ['MEDIUM', 'HARD', ...Object.keys(deg).filter((k) => k !== 'MEDIUM' && k !== 'HARD')]) {
    const d = deg[c];
    if (!d) continue;
    r(`  ${pad(c, 8)} ${lpad(d.n, 4)}  ${f4(d.mean)}  ${f4(d.median)}  ${d.stdDev.toFixed(4)}  ${lpad(d.negativeCount, 4)}`);
  }
  r(`  raw slopes (fuel burn included) = the values above - ${FUEL_EFFECT_S_PER_LAP}`);
  r('');
}

// PIA laps 10-25
{
  r('PIA, laps 10-25 (stintFits { driver: PIA, lapStart: 10, lapEnd: 25 }):');
  for (const f of stintFits(mLaps, { driver: 'PIA', lapStart: 10, lapEnd: 25 })) {
    const usedLaps = cleanStintLaps(mLaps, { driver: 'PIA' })
      .find((st) => st.stintNumber === f.stintNumber).laps
      .filter((lt) => Number(lt.LapNumber) >= 10 && Number(lt.LapNumber) <= 25);
    const used = usedLaps.map((lt) => Number(lt.LapNumber));
    r(`  stint ${f.stintNumber} ${pad(f.compound, 6)} (laps ${f.startLap}-${f.endLap}): clean laps in range `
      + `${used.length ? `${used[0]}-${used[used.length - 1]}` : 'none'} n=${f.n}, `
      + (f.slope == null
        ? `no fit (n < ${MIN_FIT_LAPS})`
        : `slope ${f4(f.slope)}, raw ${f4(f.rawSlope)}, s.e. ${f.slopeStdErr.toFixed(4)}, sigma ${f3(f.residualSigma)}, `
          + `TyreLife ${f.tyreLifeMin}-${f.tyreLifeMax}`));
    const diag = f.slope == null ? olsAnyN(usedLaps) : null;
    if (diag) {
      r(`    diagnostic OLS of these ${usedLaps.length} laps (not returned, below MIN_FIT_LAPS): slope ${f4(diag.slope)}, `
        + `raw ${f4(diag.slope - FUEL_EFFECT_S_PER_LAP)}, s.e. ${diag.se.toFixed(4)}`);
    }
  }
  r('  whole stints for comparison:');
  for (const f of mFits.filter((x) => x.driver === 'PIA')) {
    r(`  stint ${f.stintNumber} ${pad(f.compound, 6)} (laps ${f.startLap}-${f.endLap}): n=${f.n}, slope ${f4(f.slope)}, `
      + `s.e. ${f.slopeStdErr == null ? '-' : f.slopeStdErr.toFixed(4)}`);
  }
  r('');
}

// Consistency sigma per finisher
{
  const finishers = (monza.race_results || [])
    .filter((x) => /^\d+$/.test(String(x.ClassifiedPosition)))
    .sort((a, b) => Number(a.Position) - Number(b.Position));
  r('Consistency sigma per classified finisher (consistencySigma: pooled residual sigma of the per-stint fits):');
  r('  pos drv   sigma (s)   laps  stints  slow outliers left out');
  for (const x of finishers) {
    const c = consistencySigma(mLaps, x.Abbreviation);
    r(`  ${lpad(x.ClassifiedPosition, 3)} ${x.Abbreviation}   ${f3(c.sigma)}     ${lpad(c.n, 4)}  ${lpad(c.stints, 5)}  ${lpad(c.outliers, 5)}`);
  }
  const sig = finishers.map((x) => consistencySigma(mLaps, x.Abbreviation).sigma).filter((v) => v != null);
  r(`  finishers ${finishers.length}; sigma median ${f3(median(sig))}, min ${f3(Math.min(...sig))}, max ${f3(Math.max(...sig))}`);
  r('');
}

// ---------------------------------------------------------------------------
// Part 2: every cached race
// ---------------------------------------------------------------------------
r(`=== Part 2: the assumptions on every cached race (${races.length} races: `
  + `${races.map((x) => `${x.year} R${x.round}`).join(', ')}) ===`);
r('');

const all = races.map((race) => {
  const s = load(race.file);
  const laps = s.lap_times || [];
  return { ...race, laps, clean: cleanStintLaps(laps), fits: stintFits(laps) };
});

// A. Fuel effect not identifiable
{
  let stints = 0;
  let varying = 0;
  let fitted = 0;
  let maxDiff = 0;
  for (const race of all) {
    for (const st of race.clean) {
      const laps = baseLaps(st);
      if (!laps.length) continue;
      stints += 1;
      const offs = new Set(laps.map((lt) => Number(lt.LapNumber) - Number(lt.TyreLife)));
      if (offs.size > 1) varying += 1;
    }
    for (const f of race.fits) {
      if (f.slope == null) continue;
      fitted += 1;
      maxDiff = Math.max(maxDiff, Math.abs(f.slope - f.rawSlope - FUEL_EFFECT_S_PER_LAP));
    }
  }
  r('A. Fuel effect (FUEL_EFFECT_S_PER_LAP):');
  r(`  stints with step-2 laps ${stints}; stints where LapNumber - TyreLife is not constant over those laps: ${varying}`);
  r(`  fitted stints ${fitted}; max |slope - rawSlope - ${FUEL_EFFECT_S_PER_LAP}| = ${maxDiff.toExponential(2)} s/lap`);
  r('  => within a stint fuel burn and tyre age move together; the fuel effect cannot be fitted, it is an assumption.');
  r('');
}

// B. Fit length (MIN_FIT_LAPS)
{
  r('B. Fit length (MIN_FIT_LAPS). OLS of the step-2 laps at any n >= 3 (diagnostic fit, no outlier step).');
  r('  B1. whole stints, by their number of step-2 laps:');
  r('    n       stints  |slope|>0.3  median s.e.  slope p10   p50     p90');
  const pts = [];
  for (const race of all) {
    for (const st of race.clean) {
      const ft = olsAnyN(baseLaps(st));
      if (ft) pts.push({ n: baseLaps(st).length, ...ft });
    }
  }
  const buckets = [[3, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 11], [12, 14], [15, 19], [20, 29], [30, 99]];
  for (const [lo, hi] of buckets) {
    const b = pts.filter((p) => p.n >= lo && p.n <= hi);
    if (!b.length) continue;
    const sl = b.map((p) => p.slope);
    const steep = b.filter((p) => Math.abs(p.slope) > 0.3).length;
    r(`    ${pad(lo === hi ? `${lo}` : `${lo}-${hi}`, 7)} ${lpad(b.length, 5)}   ${lpad(pct(steep, b.length), 8)}     `
      + `${median(b.map((p) => p.se)).toFixed(3)}     ${f4(quantile(sl, 0.1))} ${f4(quantile(sl, 0.5))} ${f4(quantile(sl, 0.9))}`);
  }
  r('  B2. the first k step-2 laps of the stints with at least 20, against the whole stint (what a replay shows k laps in):');
  r('    k    stints  |slope|>0.3  median s.e.  median |slope_k - slope_all|');
  const long = [];
  for (const race of all) for (const st of race.clean) if (baseLaps(st).length >= 20) long.push(baseLaps(st));
  for (const k of [4, 5, 6, 7, 8, 9, 10, 12, 15]) {
    const rows = [];
    for (const laps of long) {
      const part = olsAnyN(laps.slice(0, k));
      const whole = olsAnyN(laps);
      if (part && whole) rows.push({ ...part, diff: Math.abs(part.slope - whole.slope) });
    }
    const steep = rows.filter((p) => Math.abs(p.slope) > 0.3).length;
    r(`    ${lpad(k, 2)}   ${lpad(rows.length, 6)}   ${lpad(pct(steep, rows.length), 8)}     ${median(rows.map((p) => p.se)).toFixed(3)}        `
      + `${median(rows.map((p) => p.diff)).toFixed(3)}`);
  }
  r(`  => MIN_FIT_LAPS = ${MIN_FIT_LAPS} (assumption read off these tables).`);
  r('');
}

// C. Residual tails (outlier rule)
{
  const z = [];
  let minRobust = Infinity;
  for (const race of all) {
    for (const st of race.clean) {
      const laps = baseLaps(st);
      const fit = fitStint(laps);
      if (!fit) continue;
      const { e, m, robust } = residualsOf(laps, fit);
      minRobust = Math.min(minRobust, robust);
      const scale = Math.max(robust, MIN_ROBUST_SCALE_S);
      for (const v of e) z.push((v - m) / scale);
    }
  }
  const normalTail = (k) => {
    // two-sided standard normal tail 2 * P(Z > k): Simpson's rule on the density over [k, k + 12]
    const steps = 12000;
    const h = 12 / steps;
    const pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    let s = pdf(k) + pdf(k + 12);
    for (let i = 1; i < steps; i++) s += (i % 2 ? 4 : 2) * pdf(k + i * h);
    return 2 * (s * h) / 3;
  };
  r(`C. Residual tails (slow-outlier rule). Step-2 laps of the stints with a fit (n >= ${MIN_FIT_LAPS}): ${z.length} laps.`);
  r('   modified z = (residual - median residual) / robust sigma of the stint');
  r('    K     slow (z > K)        fast (z < -K)       normal, both sides');
  for (const k of [3, 3.5, 4, 5]) {
    const slow = z.filter((v) => v > k).length;
    const fast = z.filter((v) => v < -k).length;
    r(`    ${pad(k, 4)}  ${lpad(slow, 5)} (${lpad(pct(slow, z.length), 6)})   ${lpad(fast, 5)} (${lpad(pct(fast, z.length), 6)})   `
      + `${(100 * normalTail(k)).toFixed(3)}%`);
  }
  r(`  smallest robust sigma of a fitted stint: ${minRobust.toFixed(4)} s (floor MIN_ROBUST_SCALE_S ${MIN_ROBUST_SCALE_S} s `
    + `${minRobust > MIN_ROBUST_SCALE_S ? 'never binds' : 'BINDS'})`);
  r('');
}

// D. What the outlier step changes
{
  r(`D. Effect of the slow-outlier step (K = ${OUTLIER_K}), per race: laps removed, and per fitted stint |slope change|:`);
  r('    race       step-2 laps  removed   stints fitted (with / without)  median |dslope|  max |dslope|');
  const dAll = [];
  let removedAll = 0;
  let baseAll = 0;
  for (const race of all) {
    let base = 0;
    let removed = 0;
    let fittedWith = 0;
    let fittedWithout = 0;
    const d = [];
    for (const st of race.clean) {
      const laps = baseLaps(st);
      base += laps.length;
      removed += st.outliers.length;
      const without = fitStint(laps);
      const withRule = fitStint(st.laps);
      if (without) fittedWithout += 1;
      if (withRule) fittedWith += 1;
      if (without && withRule) d.push(Math.abs(withRule.slope - without.slope));
    }
    dAll.push(...d);
    removedAll += removed;
    baseAll += base;
    r(`    ${pad(`${race.year} R${race.round}`, 10)} ${lpad(base, 8)}   ${lpad(removed, 4)} (${lpad(pct(removed, base), 6)})   `
      + `${lpad(fittedWith, 3)} / ${lpad(fittedWithout, 3)}                    ${median(d).toFixed(4)}         ${Math.max(...d).toFixed(4)}`);
  }
  r(`    all        ${lpad(baseAll, 8)}   ${lpad(removedAll, 4)} (${lpad(pct(removedAll, baseAll), 6)})   `
    + `stints with both fits ${dAll.length}: median |dslope| ${median(dAll).toFixed(4)}, p90 ${quantile(dAll, 0.9).toFixed(4)}, `
    + `max ${Math.max(...dAll).toFixed(4)} s/lap`);
  r('  stints whose slope moves by more than 0.1 s/lap (removed laps: lap number and LapTimeSeconds):');
  for (const race of all) {
    for (const st of race.clean) {
      const without = fitStint(baseLaps(st));
      const withRule = fitStint(st.laps);
      if (!without || !withRule || Math.abs(withRule.slope - without.slope) <= 0.1) continue;
      r(`    ${pad(`${race.year} R${race.round}`, 9)} ${st.driver} ${st.stintNumber} ${pad(st.compound, 12)} slope `
        + `${f4(without.slope)} -> ${f4(withRule.slope)}, sigma ${f3(without.residualSigma)} -> ${f3(withRule.residualSigma)}; `
        + `removed ${st.outliers.map((lt) => `L${lt.LapNumber} ${Number(lt.LapTimeSeconds).toFixed(3)} s`).join(', ')}; `
        + `stint median ${median(baseLaps(st).map((lt) => Number(lt.LapTimeSeconds))).toFixed(3)} s`);
    }
  }
  // Monza: compound medians and finisher sigmas with and without
  const noRule = (laps) => cleanStintLaps(laps).map((st) => {
    const f = fitStint(baseLaps(st));
    return f ? { compound: st.compound, ...f } : { compound: st.compound, slope: null };
  });
  const withDeg = compoundDegradation(mFits);
  const withoutDeg = compoundDegradation(noRule(mLaps));
  r('  Monza 2024, compound median slope with / without the outlier step:');
  for (const c of ['MEDIUM', 'HARD']) {
    r(`    ${pad(c, 6)} ${f4(withDeg[c]?.median)} / ${f4(withoutDeg[c]?.median)}  (n ${withDeg[c]?.n} / ${withoutDeg[c]?.n})`);
  }
  r('');
}

// E. Fitted stints per race
{
  r('E. Per race: stints, fitted stints, clean laps, MEDIUM / HARD / SOFT median slope (s/lap, n):');
  for (const race of all) {
    const deg = compoundDegradation(race.fits);
    const fitted = race.fits.filter((f) => f.slope != null).length;
    const laps = race.clean.reduce((s, st) => s + st.laps.length, 0);
    const c = (k) => (deg[k] ? `${f4(deg[k].median)} (${deg[k].n})` : '      -     ');
    r(`    ${pad(`${race.year} R${race.round}`, 10)} stints ${lpad(race.fits.length, 3)}  fitted ${lpad(fitted, 3)}  laps ${lpad(laps, 5)}  `
      + `M ${c('MEDIUM')}  H ${c('HARD')}  S ${c('SOFT')}`);
  }
}

const text = report.join('\n');
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${text}\n`);
console.log(text);
