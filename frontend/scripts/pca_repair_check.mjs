/**
 * Evidence of the PCA repair round (P2, P6, P10, P11): writes
 * notes/experiments/phase67/pca_repair_check.txt and prints the same text.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/pca_repair_check.mjs
 *
 * Sections:
 *  1. the loaded weekend's race at the clock on screen (utils/views/pcaBiplot.js):
 *     a sprint / FP2 / qualifying replay of 2024 R16 at its last frame (session
 *     clock Infinity), the race replay half way and at its end: race clock
 *     state, result withheld, LEC_2024_16's finish and fill, the race's rows
 *     that may be drawn;
 *  2. the Race Situation Map as drawn (store chain: computePCA with
 *     LIVE_PCA_ALIGN, chained on the previous lap; advanceDisplay): drawn dots
 *     against crosshair + sum of z x arrow, the drawn field's mean against the
 *     crosshair, on every lap of every cached race;
 *  3. lap-to-lap mean move of the points, the live alignment against the
 *     sign-only one (the previous store default): Monza 2024 lap by lap around
 *     lap 42, 2024 R22 lap 19, every cached race;
 *  4. the live alignment's axes: angle between displayed axis 1 and PC1, the
 *     two axes' captured variance against PC1 + PC2;
 *  5. help texts of the PCA panels (utils/chartHelp.js): terms of the removed
 *     methods (Cohen's d, the frozen basis, the old feature / row counts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePCA, standardize, covarianceMatrix, jacobiEigen, LIVE_PCA_ALIGN } from '../src/utils/livePCA.js';
import { extractRaceSituationFeatures, FEATURE_NAMES } from '../src/utils/raceSituationFeatures.js';
import { resolveSessionNow } from '../src/utils/raceTime.js';
import { advanceDisplay, fieldMean, biplotArrows, axisTitles } from '../src/utils/views/raceSituationMap.js';
import {
  loadedRaceOf, loadedRaceClock, loadedResultHidden, shownFinish, pointFill, causalPoints, shapeLegendItems,
} from '../src/utils/views/pcaBiplot.js';
import { CHART_HELP } from '../src/utils/chartHelp.js';
import { loadCachedSession, listCachedRaces } from '../src/__tests__/helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(HERE, '../../notes/experiments/phase67/pca_repair_check.txt');
const EMB_FILE = path.resolve(HERE, '../../backend/data/processed/pca_embeddings.json');

const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const f2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
const quantile = (arr, q) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))] : NaN;
};
const races = listCachedRaces().sort((a, b) => a.year - b.year || a.round - b.round);

// ── 1. the loaded race at the clock on screen ──
out('== 1. The loaded weekend\'s race at the clock on screen (2024 R16, LEC_2024_16) ==');
const emb = JSON.parse(fs.readFileSync(EMB_FILE, 'utf8'));
const lec = emb.points.find((p) => p.id === 'LEC_2024_16');
const raceRows = (pts) => pts.filter((p) => p.year === 2024 && p.round === 16).length;
out(`artefact: LEC_2024_16 finish_position ${lec.finish_position}; rows of 2024 R16: ${raceRows(emb.points)}`);
// a frame replay at its last frame (not qualifying): the session clock is Infinity
const endClock = resolveSessionNow({
  currentTime: 3600, sessionTimeOffset: 0, replayActive: true, currentLap: 1, maxLap: 1,
  lapTimes: [], isLiveMode: false, maxTime: 3600, frameDt: 0.4, raceOver: false, qualifying: false,
});
const midClock = resolveSessionNow({
  currentTime: 1800, sessionTimeOffset: 0, replayActive: true, currentLap: 1, maxLap: 1,
  lapTimes: [], isLiveMode: false, maxTime: 3600, frameDt: 0.4, raceOver: false, qualifying: false,
});
out(`session clock at the last frame: ${endClock}; half way: ${midClock}`);
out('session on screen      clock     | race clock   result hidden | LEC finish  fill      | 2024 R16 rows drawable (artefact)');
for (const [type, now, label] of [
  ['S', endClock, 'Sprint, last frame'], ['FP2', endClock, 'FP2, last frame'], ['Q', endClock, 'Q, last frame'],
  ['R', midClock, 'Race, half way'], ['R', endClock, 'Race, last frame'],
]) {
  const loaded = loadedRaceOf({ year: 2024, round: 16, sessionType: type });
  const hidden = loadedResultHidden({ sessionType: type, sessionNow: now, isLiveMode: false });
  const ctx = { loaded, resultHidden: hidden };
  out(`${label.padEnd(22)} ${String(now).padEnd(9)} | ${loadedRaceClock({ sessionType: type, sessionNow: now }).padEnd(12)} ${String(hidden).padEnd(13)} | `
    + `${String(shownFinish(lec, ctx)).padEnd(11)} ${pointFill(lec, 'finish', ctx).padEnd(9)} | ${raceRows(causalPoints(emb.points, ctx))}`);
}
// the probe's call: no session type in resultHidden, the loaded race carries it
const probeLoaded = loadedRaceOf({ year: 2024, round: 16, sessionType: 'FP2' });
const probeHidden = loadedResultHidden({ sessionNow: endClock, isLiveMode: false });
out(`verifier probe call (loadedResultHidden without a session type: ${probeHidden}; loaded race of an FP2): `
  + `LEC finish ${shownFinish(lec, { loaded: probeLoaded, resultHidden: probeHidden })}, `
  + `fill ${pointFill(lec, 'finish', { loaded: probeLoaded, resultHidden: probeHidden })}`);
// shape legend of rows at the replay clock vs post-race rows
const atClock = emb.points.filter((p) => p.year === 2024 && p.round === 16)
  .map((p) => ({ ...p, as_of: 'session_now', as_of_lap: 10, finish_position: null }));
const raceLoaded = loadedRaceOf({ year: 2024, round: 16, sessionType: 'R' });
out(`shape legend, rows at the replay clock (lap 10): "${shapeLegendItems(atClock, raceLoaded)[1].label}"`);
out(`shape legend, post-race rows (race ended): "${shapeLegendItems(emb.points, raceLoaded)[1].label}"`);

// ── 2. the Race Situation Map as drawn ──
function angle(a, b) {
  const m = (p) => p.reduce((s, q) => ({ x: s.x + q.x / p.length, y: s.y + q.y / p.length }), { x: 0, y: 0 });
  const ca = m(a); const cb = m(b);
  let c = 0; let s = 0;
  a.forEach((p, i) => {
    const ax = p.x - ca.x; const ay = p.y - ca.y; const bx = b[i].x - cb.x; const by = b[i].y - cb.y;
    c += ax * bx + ay * by; s += ax * by - ay * bx;
  });
  return Math.atan2(s, c) * 180 / Math.PI;
}
/** Every lap of a race as the store computes it, with one alignment mode. */
function runRace(lapTimes, align) {
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  const rows = [];
  let prev = null;
  for (let lap = 3; lap <= maxLap; lap++) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
    if (!res) continue;
    const p = computePCA(res.matrix, FEATURE_NAMES, prev, { align });
    if (!p) continue;
    rows.push({ lap, now, res, p });
    prev = p;
  }
  return rows;
}
function meanMove(a, b) {
  const at = new Map(a.res.driverAbbrs.map((d, i) => [d, a.p.scores[i]]));
  let t = 0; let n = 0;
  b.res.driverAbbrs.forEach((d, i) => {
    const q = at.get(d);
    if (q) { t += Math.hypot(b.p.scores[i].x - q.x, b.p.scores[i].y - q.y); n += 1; }
  });
  return n ? t / n : NaN;
}

out('');
out(`== 2. Race Situation Map as drawn: store chain (computePCA align '${LIVE_PCA_ALIGN}') + advanceDisplay, every cached race ==`);
let laps = 0; let lapsOver5 = 0; let worstAng = 0; let worstAngAt = ''; let dl = 0; let dlOver = 0; let worstGap = 0;
let worstGapAt = ''; let worstMean = 0; let worstMeanAt = '';
const runs = new Map();
for (const race of races) {
  const lt = loadCachedSession(race.year, race.round).lap_times;
  const rows = runRace(lt, LIVE_PCA_ALIGN);
  runs.set(`${race.year} R${race.round}`, { lt, rows });
  let display = null;
  for (const r of rows) {
    display = advanceDisplay(display, { driverAbbrs: r.res.driverAbbrs, scores: r.p.scores, computedAtLap: r.lap, computedAtNow: r.now });
    // the arrows the map draws (biplotArrows default: ARROW_COUNT, every input)
    const arrows = new Map(biplotArrows(r.p.loadings).map((a) => [a.feature, a]));
    const mean = fieldMean(r.p.scores);
    const { standardized } = standardize(r.res.matrix);
    const zArrow = standardized.map((z) => {
      let x = mean.x; let y = mean.y;
      FEATURE_NAMES.forEach((nm, j) => { const a = arrows.get(nm); if (a) { x += z[j] * a.pc1; y += z[j] * a.pc2; } });
      return { x, y };
    });
    const drawn = r.res.driverAbbrs.map((d) => display.positions[d]);
    const ang = angle(zArrow, drawn);
    laps += 1;
    if (Math.abs(ang) > 5) lapsOver5 += 1;
    if (Math.abs(ang) > Math.abs(worstAng)) { worstAng = ang; worstAngAt = `${race.year} R${race.round} lap ${r.lap}`; }
    drawn.forEach((d, i) => {
      const g = Math.hypot(d.x - zArrow[i].x, d.y - zArrow[i].y);
      dl += 1;
      if (g > 0.5) dlOver += 1;
      if (g > worstGap) { worstGap = g; worstGapAt = `${race.year} R${race.round} lap ${r.lap}`; }
    });
    const dm = fieldMean(drawn);
    const off = Math.hypot(dm.x - mean.x, dm.y - mean.y);
    if (off > worstMean) { worstMean = off; worstMeanAt = `${race.year} R${race.round} lap ${r.lap}`; }
  }
}
out(`${laps} laps of ${races.length} cached races`);
out(`best-fit angle between the drawn dots and crosshair + Z x arrows: largest ${f2(Math.abs(worstAng), 6)} deg (${worstAngAt || 'n/a'}); laps with |angle| > 5 deg: ${lapsOver5}`);
out(`driver-laps drawn > 0.5 PC units from crosshair + Z x arrows: ${dlOver} of ${dl}; largest gap ${worstGap.toExponential(2)} PC units (${worstGapAt || 'n/a'})`);
out(`largest distance of the drawn field's mean from the 'field avg' crosshair: ${worstMean.toExponential(2)} PC units (${worstMeanAt || 'n/a'})`);

// ── 3. lap-to-lap moves, live alignment vs sign ──
out('');
out(`== 3. Lap-to-lap mean move of the points (PC units): live alignment '${LIVE_PCA_ALIGN}' vs 'sign' (the previous store default) ==`);
const monza = runs.get('2024 R16');
const monzaSign = runRace(monza.lt, 'sign');
out('Monza 2024 (R16)   lap | live: move  dot1  dot2 | sign: move  dot1  dot2');
for (const lap of [40, 41, 42, 43, 44]) {
  const i = monza.rows.findIndex((r) => r.lap === lap);
  const j = monzaSign.findIndex((r) => r.lap === lap);
  const a = monza.rows[i]; const b = monzaSign[j];
  out(`                   ${String(lap).padStart(3)} | ${f2(meanMove(monza.rows[i - 1], a)).padStart(10)} ${f2(a.p.alignment.dots[0]).padStart(5)} ${f2(a.p.alignment.dots[1]).padStart(5)} | ${f2(meanMove(monzaSign[j - 1], b)).padStart(10)} ${f2(b.p.alignment.dots[0]).padStart(5)} ${f2(b.p.alignment.dots[1]).padStart(5)}`);
}
const movesOf = (rows) => rows.slice(1).map((r, k) => meanMove(rows[k], r)).filter(Number.isFinite);
const mLive = movesOf(monza.rows); const mSign = movesOf(monzaSign);
out(`Monza 2024 whole race: live median ${f2(quantile(mLive, 0.5))} max ${f2(Math.max(...mLive))}; sign median ${f2(quantile(mSign, 0.5))} max ${f2(Math.max(...mSign))}`);
const r22 = runs.get('2024 R22');
if (r22) {
  const r22Sign = runRace(r22.lt, 'sign');
  const at = (rows, lap) => rows.find((r) => r.lap === lap);
  const iL = r22.rows.findIndex((r) => r.lap === 19); const iS = r22Sign.findIndex((r) => r.lap === 19);
  out(`2024 R22 lap 19: live dots ${f2(at(r22.rows, 19).p.alignment.dots[0])}/${f2(at(r22.rows, 19).p.alignment.dots[1])}, move ${f2(meanMove(r22.rows[iL - 1], r22.rows[iL]))}; `
    + `sign dots ${f2(at(r22Sign, 19).p.alignment.dots[0])}/${f2(at(r22Sign, 19).p.alignment.dots[1])}, move ${f2(meanMove(r22Sign[iS - 1], r22Sign[iS]))}`);
}
const allLive = []; const allSign = [];
for (const [, { lt, rows }] of runs) { allLive.push(...movesOf(rows)); allSign.push(...movesOf(runRace(lt, 'sign'))); }
out(`every cached race: live ${allLive.length} lap pairs, median ${f2(quantile(allLive, 0.5))}, p95 ${f2(quantile(allLive, 0.95))}, max ${f2(Math.max(...allLive))}; `
  + `sign median ${f2(quantile(allSign, 0.5))}, p95 ${f2(quantile(allSign, 0.95))}, max ${f2(Math.max(...allSign))}`);

// ── 4. the live alignment's axes ──
out('');
out(`== 4. Axes of the live alignment ('${LIVE_PCA_ALIGN}'): inside the PC1-PC2 plane ==`);
const devs = []; let sumGap = 0; let shareGap = 0;
for (const [, { rows }] of runs) {
  for (const r of rows) {
    const { standardized } = standardize(r.res.matrix);
    const { eigenvectors } = jacobiEigen(covarianceMatrix(standardized));
    let d = 0;
    for (let j = 0; j < r.p.basis.length; j++) d += r.p.basis[j][0] * eigenvectors[0][j];
    devs.push(Math.acos(Math.min(1, Math.abs(d))) * 180 / Math.PI);
    sumGap = Math.max(sumGap, Math.abs(r.p.explainedVariance[0] + r.p.explainedVariance[1] - r.p.eigenShare[0] - r.p.eigenShare[1]));
    const t = axisTitles(r.p.loadings, r.p.explainedVariance);
    if (!t.x.startsWith('Axis 1:') || !t.y.startsWith('Axis 2:')) shareGap += 1;
  }
}
out(`angle between displayed axis 1 and PC1: median ${f2(quantile(devs, 0.5), 1)} deg, p95 ${f2(quantile(devs, 0.95), 1)} deg, max ${f2(Math.max(...devs), 1)} deg (${devs.length} laps)`);
out(`largest |axis 1 + axis 2 captured variance - (PC1 + PC2) share|: ${sumGap.toExponential(2)}; axis titles not "Axis 1/2": ${shareGap}`);
const t42 = axisTitles(monza.rows.find((r) => r.lap === 42).p.loadings, monza.rows.find((r) => r.lap === 42).p.explainedVariance);
out(`Monza lap 42 titles: "${t42.x}" | "${t42.y}" | "${t42.plane}"`);

// ── 5. help texts ──
out('');
out('== 5. Help texts of the PCA panels (utils/chartHelp.js) ==');
const STALE = [/Cohen/i, /\b17\b/, /\b499\b/, /\b24 cached\b/, /frozen/i, /warm-?up/i, /exponential/i, /half-life/i, /fuel_corrected_pace/];
for (const key of ['analytics', 'analysis', 'racesituation']) {
  const e = CHART_HELP[key];
  const all = [e.summary, ...(e.howToRead || []), ...(e.limitations || [])].join(' ');
  const hits = STALE.filter((re) => re.test(all)).map(String);
  const nums = [...new Set(all.match(/\d+(\.\d+)?/g) || [])];
  out(`${key.padEnd(14)} stale terms: ${hits.length ? hits.join(', ') : 'none'}; numbers in the text: ${nums.length ? nums.join(', ') : 'none'}`);
}

fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
process.exit(0);
