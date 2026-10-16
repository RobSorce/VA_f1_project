/**
 * The Race Situation Map on backward navigation: writes
 * docs/evidence/live_pca_rewind.txt and prints the same text.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/live_pca_rewind.mjs
 *
 * The real store (useF1Store.computeRaceSituation after the clock change of
 * setCurrentLap: laterClockReset), a lap-mode replay of each cached race; the
 * Monte Carlo projection each new situation triggers is stubbed (not under
 * test). Drawn = the store's raceSituationData scores and displayed basis.
 *  1. one step back from every lap of every race (Footer stepBack, ArrowLeft):
 *     the picture of lap L - 1 after the step against the forward pass's
 *     picture of that lap (in-plane turn, reflection, mean dot distance), and
 *     the mean dot move of the step against the forward lap-to-lap move;
 *  2. rewinds: forward to lap 40, back to lap 20 (Monza 2024, 2024 R22) or 30
 *     (Monza), then forward 5 laps: the same laps' two pictures;
 *  3. a seek straight to a lap (from a fresh session) against playing to it;
 *  4. the loading arrows drawn (biplotArrows default, ARROW_COUNT): inputs
 *     with a non-zero loading but no arrow, and each dot against crosshair +
 *     sum of z x arrow over the arrows drawn, on every lap of every race.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear(),
  };
}
const { useF1Store, laterClockReset } = await import('../src/store/useF1Store.js');
const { resolveSessionNow, computeSessionTimeOffset } = await import('../src/utils/raceTime.js');
const { standardize } = await import('../src/utils/livePCA.js');
const { extractRaceSituationFeatures, FEATURE_NAMES } = await import('../src/utils/raceSituationFeatures.js');
const { biplotArrows, fieldMean, ARROW_COUNT } = await import('../src/utils/views/raceSituationMap.js');
const { loadCachedSession, listCachedRaces } = await import('../src/__tests__/helpers/cachedSession.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(HERE, '../../docs/evidence/live_pca_rewind.txt');
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))] : NaN;
};
const races = listCachedRaces().sort((a, b) => a.year - b.year || a.round - b.round);

/** In-plane relation of two orthonormal bases of the same plane: turn (deg) and reflection. */
function planeAngle(A, B) {
  let k00 = 0; let k01 = 0; let k10 = 0; let k11 = 0;
  for (let j = 0; j < A.length; j++) {
    k00 += A[j][0] * B[j][0]; k01 += A[j][0] * B[j][1]; k10 += A[j][1] * B[j][0]; k11 += A[j][1] * B[j][1];
  }
  return { deg: Math.atan2(k10, k00) * 180 / Math.PI, reflected: k00 * k11 - k01 * k10 < 0 };
}
/** Mean distance between the dots of two pictures, matched by driver. */
function meanMove(a, b) {
  const m = new Map(a.driverAbbrs.map((d, i) => [d, a.scores[i]]));
  let t = 0; let n = 0;
  b.driverAbbrs.forEach((d, i) => {
    const p = m.get(d);
    if (p) { t += Math.hypot(b.scores[i].x - p.x, b.scores[i].y - p.y); n++; }
  });
  return n ? t / n : NaN;
}

/** A fresh lap-mode replay of a cached race on the store; seek(lap) = setCurrentLap's clock change + the map. */
function replay(year, round) {
  const lapTimes = loadCachedSession(year, round).lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  useF1Store.setState({
    sessionData: { lap_times: lapTimes }, loadedYear: year, loadedRound: round, loadedSessionType: 'R',
    isQualifyingReplay: false, maxLap, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    isLiveMode: false, totalFrames: 0, frameData: null, dnfMap: {}, lapModeRaceOver: false,
    raceSituationData: null, raceSituationLap: null, _prevPcaResult: null, currentLap: 1,
    computeRaceProjection: () => {},
  });
  const seek = (lap) => {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    useF1Store.setState({ currentLap: lap, ...laterClockReset(useF1Store.getState(), now) });
    useF1Store.getState().computeRaceSituation();
    const st = useF1Store.getState();
    if (!st.raceSituationData || st.raceSituationData.computedAtLap !== lap) return null;
    return { ...st.raceSituationData, basis: st._prevPcaResult.basis };
  };
  return { lapTimes, maxLap, seek };
}

// ── 1. one step back from every lap ──
out('== 1. One step back from every lap (real store, lap-mode replay of every cached race) ==');
let steps = 0; let turned = 0; let reflected = 0;
const sameLap = []; const backMoves = []; const fwdMoves = []; const angles = [];
let worst = { d: -1, at: '' };
for (const { year, round } of races) {
  const { maxLap, seek } = replay(year, round);
  const fwd = new Map();
  for (let lap = 3; lap <= maxLap; lap++) { const p = seek(lap); if (p) fwd.set(lap, p); }
  for (let lap = 4; lap <= maxLap; lap++) {
    const a = fwd.get(lap - 1); const b = fwd.get(lap);
    if (a && b) fwdMoves.push(meanMove(a, b));
  }
  for (let lap = maxLap; lap > 3; lap--) {
    const at = seek(lap);
    const back = seek(lap - 1);
    const ref = fwd.get(lap - 1);
    if (!at || !back || !ref) continue;
    steps++;
    const ang = planeAngle(ref.basis, back.basis);
    angles.push(Math.abs(ang.deg));
    if (ang.reflected) reflected++;
    if (Math.abs(ang.deg) > 45 || ang.reflected) turned++;
    const d = meanMove(ref, back);
    sameLap.push(d);
    if (d > worst.d) worst = { d, at: `${year} R${round} lap ${lap - 1}` };
    backMoves.push(meanMove(at, back));
  }
}
out(`${steps} one-lap steps back over ${races.length} races`);
out(`lap L-1 after the step back vs the forward pass's lap L-1: in-plane turn |deg| max ${Math.max(...angles).toExponential(2)}; reflected ${reflected}; turned > 45 deg or reflected ${turned} of ${steps}`);
out(`same lap, two pictures: mean dot distance max ${worst.d.toExponential(2)} PC units (${worst.at})`);
out(`mean dot move on the step back: median ${q(backMoves, 0.5).toFixed(2)}, p95 ${q(backMoves, 0.95).toFixed(2)}, max ${Math.max(...backMoves).toFixed(2)} PC units; forward lap-to-lap move: median ${q(fwdMoves, 0.5).toFixed(2)}, p95 ${q(fwdMoves, 0.95).toFixed(2)}, max ${Math.max(...fwdMoves).toFixed(2)}`);

// ── 2. rewinds ──
out('');
out('== 2. Rewinds: forward to lap 40, back, forward 5 laps (real store) ==');
for (const [year, round, back] of [[2024, 16, 20], [2024, 22, 20], [2024, 16, 30]]) {
  const { seek } = replay(year, round);
  const fwd = new Map();
  for (let lap = 3; lap <= 40; lap++) { const p = seek(lap); if (p) fwd.set(lap, p); }
  const r = seek(back);
  const a = planeAngle(fwd.get(back).basis, r.basis);
  let worstLap = meanMove(fwd.get(back), r);
  for (let lap = back + 1; lap <= back + 5; lap++) worstLap = Math.max(worstLap, meanMove(fwd.get(lap), seek(lap)));
  const last = planeAngle(fwd.get(back + 5).basis, useF1Store.getState()._prevPcaResult.basis);
  out(`${year} R${round}: rewind 40 -> ${back}: basis at lap ${back} vs the first pass turned ${a.deg.toFixed(1)} deg${a.reflected ? ' + reflected' : ''}; lap ${back + 5} reached again: turned ${last.deg.toFixed(1)} deg${last.reflected ? ' + reflected' : ''}; largest mean dot distance between the two pictures of laps ${back}-${back + 5}: ${worstLap.toExponential(2)} PC units`);
}

// ── 3. a seek straight to a lap ──
out('');
out('== 3. A seek straight to a lap from a fresh session vs playing to it (real store) ==');
let seeks = 0; let seekWorst = 0;
for (const { year, round } of races) {
  const { maxLap, seek } = replay(year, round);
  const played = new Map();
  for (let lap = 3; lap <= maxLap; lap++) { const p = seek(lap); if (p) played.set(lap, p); }
  for (const lap of [10, 25, 40]) {
    if (lap > maxLap || !played.has(lap)) continue;
    const fresh = replay(year, round).seek(lap);
    if (!fresh) continue;
    seeks++;
    seekWorst = Math.max(seekWorst, meanMove(played.get(lap), fresh));
  }
}
out(`${seeks} seeks (laps 10, 25, 40 of every race): largest mean dot distance to the played picture ${seekWorst.toExponential(2)} PC units`);

// ── 4. the arrows drawn ──
out('');
out(`== 4. Loading arrows drawn (biplotArrows default: ARROW_COUNT = ${ARROW_COUNT}, PCA inputs ${FEATURE_NAMES.length}) ==`);
let laps = 0; let lapsMissing = 0; let driverLaps = 0; let gapWorst = 0; let gapOver05 = 0;
for (const { year, round } of races) {
  const { lapTimes, maxLap, seek } = replay(year, round);
  for (let lap = 3; lap <= maxLap; lap++) {
    const p = seek(lap);
    if (!p) continue;
    laps++;
    const drawn = biplotArrows(p.loadings);
    const nonZero = p.loadings.filter((l) => Math.hypot(l.pc1, l.pc2) > 1e-9).length;
    if (drawn.length < nonZero) lapsMissing++;
    const arrows = new Map(drawn.map((a) => [a.feature, a]));
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
    const { standardized } = standardize(res.matrix);
    const mean = fieldMean(p.scores);
    standardized.forEach((z, i) => {
      let x = mean.x; let y = mean.y;
      FEATURE_NAMES.forEach((name, j) => { const a = arrows.get(name); if (a) { x += z[j] * a.pc1; y += z[j] * a.pc2; } });
      const gap = Math.hypot(p.scores[i].x - x, p.scores[i].y - y);
      driverLaps++;
      gapWorst = Math.max(gapWorst, gap);
      if (gap > 0.5) gapOver05++;
    });
  }
}
out(`${laps} laps, ${driverLaps} driver-laps: laps with a non-zero loading but no arrow ${lapsMissing}; dot vs crosshair + sum of z x arrow (arrows drawn): largest gap ${gapWorst.toExponential(2)} PC units, gaps > 0.5 PC units ${gapOver05}`);

fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
process.exit(0);
