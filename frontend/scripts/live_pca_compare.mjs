/**
 * Live PCA of the Race Situation Map (utils/livePCA.js, utils/raceSituationFeatures.js),
 * the evidence of P9-P12. Writes docs/evidence/live_pca_compare.txt and
 * prints the same text.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/live_pca_compare.mjs
 *
 * Every lap is computed as the store does (computeRaceSituation): the features at
 * the lap-mode clock of that lap (resolveSessionNow), computePCA chained on the
 * previous lap's result (its basis is the alignment reference). Section 2 uses
 * the sign-only alignment, the store's until the repair round; the store now
 * uses LIVE_PCA_ALIGN ('rotation', section 3's first mode; the drawn map is
 * checked in scripts/pca_repair_check.mjs).
 *
 * Sections:
 *  1. procrustesAlign2D and orthogonalProcrustes on known rotations (residual
 *     angle after alignment, degrees);
 *  2. Monza 2024 lap by lap: the variance each displayed axis captures (the
 *     label) against the eigenvalue shares, the alignment dots, the in-plane
 *     rotation, the Procrustes residual ||W R - B||_F, the field mean of the
 *     scores (the crosshair), the largest |z|, the mean lap-to-lap move of the
 *     points, the eigen-residual;
 *  3. alignment modes ('rotation' / 'sign' / 'none') on every cached race:
 *     lap-to-lap moves, smallest alignment dot, angle between displayed axis 1
 *     and PC1;
 *  4. the frozen basis of the old code (means, SDs and axes of lap 11 held
 *     fixed) on Monza 2024: its label against the variance it captures, |z|,
 *     field mean;
 *  5. PCA inputs: largest |r| between two non-constant inputs and smallest
 *     eigenvalue of their correlation matrix, per cached race;
 *  6. estimated laps to the stop (stint-life survival) on Monza 2024 against the
 *     stint lives run; fallbacks past the survival table on every cached race;
 *  7. pace windows holding lap 1 or a non-green lap (old rule vs now), the laps
 *     whose pace still uses the field's non-pit laps; recentPace re-derived.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePCA, procrustesAlign2D, orthogonalProcrustes, standardize, covarianceMatrix, jacobiEigen,
} from '../src/utils/livePCA.js';
import {
  extractRaceSituationFeatures, FEATURE_NAMES, isPaceLap,
} from '../src/utils/raceSituationFeatures.js';
import { resolveSessionNow, completedLaps, isGreenLap } from '../src/utils/raceTime.js';
import { stintLifeObservations } from '../src/utils/raceSimulation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../../backend/data/processed_cache');
const OUT_DIR = path.resolve(HERE, '../../docs/evidence');
const OUT_FILE = path.join(OUT_DIR, 'live_pca_compare.txt');

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const f2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
const pct = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function loadRace(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/\bNaN\b/g, 'null'));
}
function dnfMapOf(session, maxLap) {
  const m = {};
  for (const r of session.race_results || []) {
    const cp = String(r.ClassifiedPosition || '');
    if (r.Abbreviation && ['R', 'D', 'E', 'W', 'N'].includes(cp)) {
      m[r.Abbreviation] = { status: r.Status || 'Retired', lastLap: r.Laps || maxLap, classifiedPosition: cp };
    }
  }
  return m;
}
const races = fs.readdirSync(CACHE_DIR)
  .map((f) => /^session_(\d{4})_(\d+)_R\.json$/.exec(f))
  .filter(Boolean)
  .map((m) => ({ year: Number(m[1]), round: Number(m[2]), file: path.join(CACHE_DIR, m[0]) }))
  .sort((a, b) => a.year - b.year || a.round - b.round);

/** Angle (deg) of the rotation that best maps cloud a onto cloud b (centred). */
function cloudAngle(a, b) {
  const ca = mean2(a);
  const cb = mean2(b);
  let c = 0;
  let s = 0;
  a.forEach((p, i) => {
    const ax = p.x - ca.x; const ay = p.y - ca.y;
    const bx = b[i].x - cb.x; const by = b[i].y - cb.y;
    c += ax * bx + ay * by;
    s += ax * by - ay * bx;
  });
  return Math.atan2(s, c) * 180 / Math.PI;
}
function mean2(pts) {
  let x = 0; let y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
const quantile = (arr, q) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
};

/** Every lap of a race as the store computes it, with one alignment mode. */
function runRace(session, { align = 'sign' } = {}) {
  const lapTimes = session.lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  const dnfMap = dnfMapOf(session, maxLap);
  let prev = null;
  const rows = [];
  for (let lap = 3; lap <= maxLap; lap++) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap, sessionNow: now });
    if (!res) continue;
    const p = computePCA(res.matrix, FEATURE_NAMES, prev, { align });
    if (!p) continue;
    rows.push({ lap, now, res, p, prevRow: rows[rows.length - 1] || null });
    prev = p;
  }
  return rows;
}
/** Mean move of the drivers present at both laps (PC units). */
function meanMove(a, b) {
  const m = new Map(a.res.driverAbbrs.map((d, i) => [d, a.p.scores[i]]));
  let t = 0; let n = 0;
  b.res.driverAbbrs.forEach((d, i) => {
    const q = m.get(d);
    if (q) { t += Math.hypot(b.p.scores[i].x - q.x, b.p.scores[i].y - q.y); n += 1; }
  });
  return n ? t / n : NaN;
}
/** Moves of the drivers present at both laps (PC units). */
function driverMoves(a, b) {
  const m = new Map(a.res.driverAbbrs.map((d, i) => [d, a.p.scores[i]]));
  const moves = [];
  b.res.driverAbbrs.forEach((d, i) => {
    const q = m.get(d);
    if (q) moves.push(Math.hypot(b.p.scores[i].x - q.x, b.p.scores[i].y - q.y));
  });
  return moves;
}
/** Angle (deg, 0-90) between displayed axis k and the k-th principal axis. */
function axisVsPc(p, k) {
  const { standardized } = standardize(p.res ? p.res.matrix : p.matrix);
  const { eigenvectors } = jacobiEigen(covarianceMatrix(standardized));
  let d = 0;
  for (let j = 0; j < p.basis.length; j++) d += p.basis[j][k] * eigenvectors[k][j];
  return Math.acos(Math.min(1, Math.abs(d))) * 180 / Math.PI;
}

// ── 1. Procrustes on known rotations ──
out('== 1. Procrustes on known rotations ==');
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const cloud = Array.from({ length: 20 }, () => ({ x: 4 * rnd(), y: 2 * rnd() }));
out('procrustesAlign2D (20 points; new = rotate(ref, theta) x scale + shift):');
for (const [deg, scale, shift] of [[10, 1, 0], [45, 1, 0], [90, 1, 0], [135, 1, 0], [170, 1, 0], [-60, 1, 0], [30, 1.4, 3]]) {
  const t = deg * Math.PI / 180;
  const moved = cloud.map((p) => ({
    x: scale * (Math.cos(t) * p.x - Math.sin(t) * p.y) + shift,
    y: scale * (Math.sin(t) * p.x + Math.cos(t) * p.y) - shift,
  }));
  const aligned = procrustesAlign2D(cloud, moved, moved);
  let rms = 0;
  aligned.forEach((p, i) => { rms += (p.x - cloud[i].x) ** 2 + (p.y - cloud[i].y) ** 2; });
  out(`  theta ${String(deg).padStart(4)} deg, scale ${scale}, shift ${shift}: residual angle ${f2(Math.abs(cloudAngle(cloud, aligned)), 6)} deg, RMS ${f2(Math.sqrt(rms / cloud.length), 6)}`);
}
out('orthogonalProcrustes (7 x 2 orthonormal basis B; A = B x rotation(-theta)): angle of B vs A x R');
const B0 = [[0.5, 0.1], [0.4, -0.3], [-0.2, 0.6], [0.3, 0.3], [-0.5, 0.2], [0.1, -0.5], [0.4, 0.4]];
// Gram-Schmidt so B is orthonormal
const nrm = (v) => Math.hypot(...v);
const c0 = B0.map((r) => r[0]); const n0 = nrm(c0);
const u0 = c0.map((v) => v / n0);
const c1 = B0.map((r) => r[1]); const pr = c1.reduce((s, v, i) => s + v * u0[i], 0);
const w1 = c1.map((v, i) => v - pr * u0[i]); const n1 = nrm(w1);
const B = u0.map((v, i) => [v, w1[i] / n1]);
for (const deg of [10, 45, 90, 170]) {
  const t = -deg * Math.PI / 180;
  const A = B.map(([a, b]) => [a * Math.cos(t) - b * Math.sin(t), a * Math.sin(t) + b * Math.cos(t)]);
  const R = orthogonalProcrustes(A, B);
  const AR = A.map(([a, b]) => [a * R[0][0] + b * R[1][0], a * R[0][1] + b * R[1][1]]);
  let res = 0;
  AR.forEach((r, j) => { res += (r[0] - B[j][0]) ** 2 + (r[1] - B[j][1]) ** 2; });
  out(`  theta ${String(deg).padStart(4)} deg: ||A R - B||_F = ${f2(Math.sqrt(res), 8)}`);
}

// ── 2. Monza 2024 lap by lap ──
const monzaFile = path.join(CACHE_DIR, 'session_2024_16_R.json');
const monza = loadRace(monzaFile);
const mRows = runRace(monza);
out('');
out('== 2. Monza 2024 (R16), lap by lap, alignment "sign" (the store default before the repair round; now LIVE_PCA_ALIGN = "rotation") ==');
out(`PCA inputs (${FEATURE_NAMES.length}): ${FEATURE_NAMES.join(', ')}`);
out('lap  n | label Ax1  Ax2  (sum) | eigen PC1  PC2  (sum) | dot1  dot2 | rot deg refl | ||WR-B|| | field mean      | max|z|       | move | eig.res');
for (const r of mRows) {
  const { p, res } = r;
  const fm = mean2(p.scores);
  const { standardized } = standardize(res.matrix);
  let zmax = 0; let zf = '';
  standardized.forEach((row) => row.forEach((z, j) => { if (Math.abs(z) > Math.abs(zmax)) { zmax = z; zf = FEATURE_NAMES[j]; } }));
  const a = p.alignment;
  const move = r.prevRow ? meanMove(r.prevRow, r) : NaN;
  out(`${String(r.lap).padStart(3)} ${String(res.driverAbbrs.length).padStart(2)} | ${pct(p.explainedVariance[0]).padStart(5)} ${pct(p.explainedVariance[1]).padStart(5)} (${pct(p.explainedVariance[0] + p.explainedVariance[1])}) | ${pct(p.eigenShare[0]).padStart(5)} ${pct(p.eigenShare[1]).padStart(5)} (${pct(p.eigenShare[0] + p.eigenShare[1])}) | ${a ? `${f2(a.dots[0]).padStart(5)} ${f2(a.dots[1]).padStart(5)}` : '  n/a   n/a'} | ${a ? `${f2(a.rotationDeg, 1).padStart(6)} ${a.reflected ? 'yes' : 'no '}` : '   n/a n/a'} | ${a ? f2(a.residual, 3) : 'n/a'} | (${f2(fm.x, 6)}, ${f2(fm.y, 6)}) | ${f2(zmax)} ${zf.padEnd(14)} | ${f2(move)} | ${p.eigenResidual.toExponential(1)}`);
}
const allDots = mRows.filter((r) => r.p.alignment).flatMap((r) => r.p.alignment.dots);
const labelGap = Math.max(...mRows.map((r) => {
  const { standardized } = standardize(r.res.matrix);
  const C = covarianceMatrix(standardized);
  let tr = 0; for (let j = 0; j < C.length; j++) tr += C[j][j];
  return Math.max(...[0, 1].map((k) => {
    const xs = r.p.scores.map((s) => (k ? s.y : s.x));
    const m = xs.reduce((t, v) => t + v, 0) / xs.length;
    const v = xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1);
    return Math.abs(v / tr - r.p.explainedVariance[k]);
  }));
}));
const fmMax = Math.max(...mRows.map((r) => { const m = mean2(r.p.scores); return Math.hypot(m.x, m.y); }));
out(`summary: ${mRows.length} laps; smallest alignment dot ${f2(Math.min(...allDots), 4)}; largest |label - variance of the plotted scores / total| ${labelGap.toExponential(2)}; largest |field mean| ${fmMax.toExponential(2)} PC units; largest eigen-residual ${Math.max(...mRows.map((r) => r.p.eigenResidual)).toExponential(2)}`);

// ── 3. alignment modes on every cached race ──
out('');
out('== 3. Alignment modes on every cached race (lap-to-lap mean move of the points, PC units) ==');
out('race      laps | rotation: median  p95   max  min dot  axis1-vs-PC1 median/max | sign: median  p95   max  min dot | none: median  p95   max');
const agg = { rotation: [], sign: [], none: [] };
const jumps = { rotation: [0, 0], sign: [0, 0], none: [0, 0] };
const axisDev = [];
let minDotAll = { rotation: Infinity, sign: Infinity };
for (const race of races) {
  const s = loadRace(race.file);
  const cells = {};
  for (const mode of ['rotation', 'sign', 'none']) {
    const rr = runRace(s, { align: mode });
    const moves = rr.filter((r) => r.prevRow).map((r) => meanMove(r.prevRow, r)).filter(Number.isFinite);
    agg[mode].push(...moves);
    for (const r of rr.filter((x) => x.prevRow)) {
      const dm = driverMoves(r.prevRow, r);
      jumps[mode][0] += dm.filter((v) => v > 2.5).length;
      jumps[mode][1] += dm.length;
    }
    const dots = rr.filter((r) => r.p.alignment).flatMap((r) => r.p.alignment.dots);
    const minDot = dots.length ? Math.min(...dots) : NaN;
    if (mode !== 'none') minDotAll[mode] = Math.min(minDotAll[mode], minDot);
    let dev = null;
    if (mode === 'rotation') {
      const devs = rr.map((r) => axisVsPc({ res: r.res, basis: r.p.basis }, 0));
      axisDev.push(...devs);
      dev = `${f2(quantile(devs, 0.5), 1)}/${f2(Math.max(...devs), 1)}`;
    }
    cells[mode] = { moves, minDot, dev, laps: rr.length };
  }
  const c = (m) => `${f2(quantile(cells[m].moves, 0.5)).padStart(5)} ${f2(quantile(cells[m].moves, 0.95)).padStart(5)} ${f2(Math.max(...cells[m].moves)).padStart(5)}`;
  out(`${race.year} R${String(race.round).padEnd(3)} ${String(cells.rotation.laps).padStart(4)} | ${c('rotation')} ${f2(cells.rotation.minDot).padStart(6)}  ${cells.rotation.dev.padStart(11)} | ${c('sign')} ${f2(cells.sign.minDot).padStart(6)} | ${c('none')}`);
}
for (const mode of ['rotation', 'sign', 'none']) {
  const m = agg[mode];
  out(`all races, ${mode.padEnd(8)}: ${m.length} lap pairs, mean move median ${f2(quantile(m, 0.5))}, p95 ${f2(quantile(m, 0.95))}, max ${f2(Math.max(...m))}, pairs with a mean move > 2.5 (the former display-smoothing threshold): ${m.filter((v) => v > 2.5).length}; driver moves > 2.5: ${jumps[mode][0]} of ${jumps[mode][1]}`);
}
out(`smallest alignment dot: rotation ${f2(minDotAll.rotation, 4)}, sign ${f2(minDotAll.sign, 4)}`);
out(`rotation mode, angle between displayed axis 1 and PC1: median ${f2(quantile(axisDev, 0.5), 1)} deg, p95 ${f2(quantile(axisDev, 0.95), 1)} deg, max ${f2(Math.max(...axisDev), 1)} deg`);

// ── 4. the frozen basis of the old code ──
out('');
out('== 4. Old frozen basis on Monza 2024: means, SDs and axes of lap 11 held fixed ==');
const frozenAt = mRows.find((r) => r.lap === 11);
if (frozenAt) {
  const { means, stds, basis, eigenShare } = frozenAt.p;
  out(`frozen at lap 11: label PC1 ${pct(eigenShare[0])} / PC2 ${pct(eigenShare[1])}`);
  for (const r of mRows.filter((x) => [15, 20, 30, 40, 50].includes(x.lap))) {
    const { standardized } = standardize(r.res.matrix);
    const C = covarianceMatrix(standardized);
    let tr = 0; for (let j = 0; j < C.length; j++) tr += C[j][j];
    const q = (k) => {
      let s = 0;
      for (let i = 0; i < C.length; i++) for (let j = 0; j < C.length; j++) s += basis[i][k] * C[i][j] * basis[j][k];
      return s / tr;
    };
    let zmax = 0; let zf = '';
    const proj = r.res.matrix.map((row) => {
      let x = 0; let y = 0;
      row.forEach((v, j) => {
        const z = (v - means[j]) / stds[j];
        if (Math.abs(z) > Math.abs(zmax)) { zmax = z; zf = FEATURE_NAMES[j]; }
        x += z * basis[j][0]; y += z * basis[j][1];
      });
      return { x, y };
    });
    const fm = mean2(proj);
    out(`  lap ${r.lap}: frozen axes capture ${pct(q(0))} / ${pct(q(1))} (label still ${pct(eigenShare[0])} / ${pct(eigenShare[1])}); refit: ${pct(r.p.explainedVariance[0])} / ${pct(r.p.explainedVariance[1])}; max |z| frozen ${f2(zmax)} (${zf}); field mean frozen (${f2(fm.x)}, ${f2(fm.y)}) vs crosshair (0, 0)`);
  }
}

// ── 5. PCA inputs: perfect correlations ──
out('');
out('== 5. PCA inputs: largest |r| between two non-constant inputs, per cached race (every lap) ==');
let worstAll = { r: 0 };
let lapsAll = 0;
let lapsAtOne = 0;
let minEigAll = Infinity;
for (const race of races) {
  const s = loadRace(race.file);
  const lapTimes = s.lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  const dnfMap = dnfMapOf(s, maxLap);
  let worst = { r: 0 };
  let minEig = Infinity;
  let laps = 0;
  for (let lap = 3; lap <= maxLap; lap++) {
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap });
    if (!res) continue;
    laps += 1;
    const X = res.matrix;
    const live = FEATURE_NAMES.map((_, j) => X.some((row) => row[j] !== X[0][j]));
    const idx = live.map((v, j) => (v ? j : -1)).filter((j) => j >= 0);
    const { standardized } = standardize(X.map((row) => idx.map((j) => row[j])));
    const C = covarianceMatrix(standardized);
    let atOne = false;
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        const r = Math.abs(C[a][b]);
        if (r > worst.r) worst = { r, lap, pair: `${FEATURE_NAMES[idx[a]]}~${FEATURE_NAMES[idx[b]]}` };
        if (r >= 0.999) atOne = true;
      }
    }
    if (atOne) lapsAtOne += 1;
    const ev = jacobiEigen(C).eigenvalues;
    const lo = Math.min(...ev);
    if (lo < minEig) minEig = lo;
  }
  lapsAll += laps;
  minEigAll = Math.min(minEigAll, minEig);
  if (worst.r > worstAll.r) worstAll = { ...worst, race: `${race.year} R${race.round}` };
  out(`${race.year} R${String(race.round).padEnd(3)} ${String(laps).padStart(3)} laps: max |r| ${f2(worst.r, 4)} (${worst.pair || '-'}, lap ${worst.lap ?? '-'}); smallest eigenvalue of the correlation matrix ${minEig.toExponential(1)}`);
}
out(`all races: ${lapsAll} laps, laps with a pair at |r| >= 0.999: ${lapsAtOne}; largest |r| ${f2(worstAll.r, 4)} (${worstAll.pair}, ${worstAll.race} lap ${worstAll.lap}); smallest eigenvalue ${minEigAll.toExponential(1)}`);

// ── 6. estimated laps to the stop ──
out('');
out('== 6. Estimated laps to the stop on Monza 2024 (stint-life survival) ==');
const obsAll = stintLifeObservations(monza.lap_times, { dnfMap: dnfMapOf(monza, 53) });
for (const c of ['MEDIUM', 'HARD']) {
  const ev = obsAll.filter((o) => o.compound === c && o.kind === 'event').map((o) => o.life).sort((a, b) => a - b);
  out(`${c} sets changed during the race (events): n ${ev.length}, life ${ev[0]}-${ev[ev.length - 1]} laps, median ${quantile(ev, 0.5)}`);
}
out('old fixed table (removed): SOFT 18, MEDIUM 28, HARD 40 laps of stint');
for (const lap of [5, 10, 15, 20, 30, 40]) {
  const r = mRows.find((x) => x.lap === lap);
  if (!r) continue;
  const fs2 = r.res.driverFeatures;
  const pick = ['LEC', 'PIA', 'NOR', 'VER', 'HAM'].filter((d) => fs2[d]);
  out(`  lap ${String(lap).padStart(2)}: ${pick.map((d) => `${d} ${fs2[d].compoundName[0]}${fs2[d].tyreLife} -> ${fs2[d].estLapsToPit} (${fs2[d].estLapsToPitSource})`).join(', ')}`);
}
let fallbackEnd = 0; let zeroDue = 0; let estTotal = 0;
for (const race of races) {
  const s = loadRace(race.file);
  const lapTimes = s.lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  const dnfMap = dnfMapOf(s, maxLap);
  for (let lap = 3; lap <= maxLap; lap += 1) {
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap });
    if (!res) continue;
    for (const f of Object.values(res.driverFeatures)) {
      estTotal += 1;
      if (f.estLapsToPit === 0) zeroDue += 1;
      if (f.estLapsToPit + f.tyreLife >= 100) fallbackEnd += 1;
    }
  }
}
out(`every cached race, every lap: ${estTotal} driver estimates, ${zeroDue} at 0 (set older than every life in the table), ${fallbackEnd} at the table end (100 laps of tyre age)`);

// ── 7. pace windows ──
out('');
out('== 7. Recent-pace windows (last 3 pace laps) holding lap 1 or a non-green lap ==');
const oldRule = (lt) => lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300 && !lt.PitOutTimeSeconds && !lt.PitInTimeSeconds;
const bad = (w) => w.some((lt) => lt.LapNumber === 1 || !isGreenLap(lt));
let oldBad = 0; let newBad = 0; let windows = 0; let fieldLapsTotal = 0; let lapsTotal = 0;
const fieldWhere = [];
for (const race of races) {
  const s = loadRace(race.file);
  const lapTimes = s.lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  const dnfMap = dnfMapOf(s, maxLap);
  const fieldLapsHere = [];
  for (let lap = 3; lap <= maxLap; lap += 1) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap, sessionNow: now });
    if (!res) continue;
    lapsTotal += 1;
    const done = completedLaps(lapTimes, now);
    for (const d of res.driverAbbrs) {
      const laps = done.filter((lt) => lt.Driver === d).sort((x, y) => x.LapNumber - y.LapNumber);
      windows += 1;
      if (bad(laps.filter(oldRule).slice(-3))) oldBad += 1;
      const used = res.driverFeatures[d].paceLaps === 'clean' ? laps.filter(isPaceLap) : laps.filter(oldRule);
      const w = used.slice(-3);
      const mean = w.reduce((t, lt) => t + lt.LapTimeSeconds, 0) / w.length;
      if (Math.abs(mean - res.driverFeatures[d].recentPace) > 1e-9) throw new Error(`recentPace mismatch ${race.year} R${race.round} lap ${lap} ${d}`);
      if (res.driverFeatures[d].paceLaps === 'clean' && bad(w)) newBad += 1;
    }
    if (res.driverFeatures[res.driverAbbrs[0]].paceLaps === 'field') { fieldLapsTotal += 1; fieldLapsHere.push(lap); }
  }
  fieldWhere.push(`${race.year} R${race.round}: ${fieldLapsHere.join(',') || '-'}`);
}
out(`every cached race, every lap, every driver in the field: ${windows} windows; old rule (non-pit laps) ${oldBad} with lap 1 or a non-green lap; now ${newBad} on clean laps`);
out(`laps whose pace still uses the field's non-pit laps (not every driver has 2 clean laps yet): ${fieldLapsTotal} of ${lapsTotal}`);
out(`  by race (laps): ${fieldWhere.join('; ')}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
console.log(`\nwritten ${path.relative(path.resolve(HERE, '../..'), OUT_FILE)}`);
