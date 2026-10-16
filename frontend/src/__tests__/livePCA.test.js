// Live PCA of the Race Situation Map (utils/livePCA.js): P9 (alignment
// against the feature-ordered basis), P10 (Procrustes rotation, arrows and
// points in one basis, the rotation on the live path: LIVE_PCA_ALIGN) and P11
// (refit per lap: the label is the variance the axes capture, the crosshair is
// the current field mean). Data-dependent blocks skip when the cached race is
// absent.
import { describe, it, expect, vi } from 'vitest';
import {
  computePCA, procrustesAlign2D, orthogonalProcrustes, standardize, covarianceMatrix, LIVE_PCA_ALIGN,
} from '../utils/livePCA.js';
import { extractRaceSituationFeatures, FEATURE_NAMES } from '../utils/raceSituationFeatures.js';
import { resolveSessionNow, computeSessionTimeOffset } from '../utils/raceTime.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

// The store module imports these; the store test below never calls them
vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const HAS_MONZA = hasCachedSession(2024, 16);
const monza = HAS_MONZA ? loadCachedSession(2024, 16) : null;

/** Every lap of a race as the store computes it (computePCA chained on the previous lap). */
function chain(lapTimes, opts) {
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  const out = [];
  let prev = null;
  for (let lap = 3; lap <= maxLap; lap++) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
    if (!res) continue;
    const p = computePCA(res.matrix, FEATURE_NAMES, prev, opts);
    out.push({ lap, res, p, prev });
    prev = p;
  }
  return out;
}

/** Angle (deg) of the rotation that best maps cloud a onto cloud b (centred). */
function cloudAngle(a, b) {
  const m = (pts) => pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
  const ca = m(a);
  const cb = m(b);
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

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const cloud = Array.from({ length: 20 }, () => ({ x: 4 * rnd(), y: 2 * rnd() }));
const rotate = (pts, deg, scale = 1, shift = 0) => {
  const t = deg * Math.PI / 180;
  return pts.map((p) => ({
    x: scale * (Math.cos(t) * p.x - Math.sin(t) * p.y) + shift,
    y: scale * (Math.sin(t) * p.x + Math.cos(t) * p.y) - shift,
  }));
};

describe('procrustesAlign2D on known rotations (P10)', () => {
  it('a cloud rotated by theta is rotated back: residual ~ 0 (was 2 x theta)', () => {
    for (const deg of [10, 45, 90, 135, 170, -60]) {
      const aligned = procrustesAlign2D(cloud, rotate(cloud, deg), rotate(cloud, deg));
      expect(Math.abs(cloudAngle(cloud, aligned))).toBeLessThan(1e-9);
      aligned.forEach((p, i) => {
        expect(p.x).toBeCloseTo(cloud[i].x, 9);
        expect(p.y).toBeCloseTo(cloud[i].y, 9);
      });
    }
  });

  it('undoes a rotation with scale and shift too, and a collinear cloud (rank-1 cross-covariance)', () => {
    const moved = rotate(cloud, 30, 1.4, 3);
    const aligned = procrustesAlign2D(cloud, moved, moved);
    aligned.forEach((p, i) => {
      expect(p.x).toBeCloseTo(cloud[i].x, 9);
      expect(p.y).toBeCloseTo(cloud[i].y, 9);
    });
    const line = Array.from({ length: 8 }, (_, i) => ({ x: i - 3.5, y: 0.5 * (i - 3.5) }));
    const back = procrustesAlign2D(line, rotate(line, 30), rotate(line, 30));
    back.forEach((p, i) => {
      expect(p.x).toBeCloseTo(line[i].x, 9);
      expect(p.y).toBeCloseTo(line[i].y, 9);
    });
  });

  it('orthogonalProcrustes recovers a known in-plane rotation of an M x 2 basis', () => {
    const B = [[0.5, 0.1], [0.4, -0.3], [-0.2, 0.6], [0.3, 0.3], [-0.5, 0.2]];
    for (const deg of [10, 45, 90, 170]) {
      const t = -deg * Math.PI / 180;
      const A = B.map(([a, b]) => [a * Math.cos(t) - b * Math.sin(t), a * Math.sin(t) + b * Math.cos(t)]);
      const R = orthogonalProcrustes(A, B);
      A.forEach(([a, b], j) => {
        expect(a * R[0][0] + b * R[1][0]).toBeCloseTo(B[j][0], 12);
        expect(a * R[0][1] + b * R[1][1]).toBeCloseTo(B[j][1], 12);
      });
    }
  });
});

describe('computePCA: alignment to the previous lap (P9)', () => {
  it('the same data twice gives the same axes and scores (no flip from the sorted loadings)', () => {
    const X = Array.from({ length: 12 }, (_, i) => [i, (i * 7) % 5, Math.sin(i), i % 3, (i * i) % 7]);
    const names = ['a', 'b', 'c', 'd', 'e'];
    const first = computePCA(X, names, null);
    // loadings are sorted by magnitude, so their order is not the feature order
    expect(first.loadings.map((l) => l.feature)).not.toEqual(names);
    const again = computePCA(X, names, first);
    expect(again.alignment.dots[0]).toBeCloseTo(1, 12);
    expect(again.alignment.dots[1]).toBeCloseTo(1, 12);
    again.scores.forEach((s, i) => {
      expect(s.x).toBeCloseTo(first.scores[i].x, 12);
      expect(s.y).toBeCloseTo(first.scores[i].y, 12);
    });
  });

  it('a basis on other features is not used as the reference', () => {
    const X = Array.from({ length: 6 }, (_, i) => [i, i * i, (i * 3) % 4]);
    const prev = computePCA(X, ['a', 'b', 'c'], null);
    expect(computePCA(X, ['a', 'b', 'x'], prev).alignment).toBeNull();
  });
});

describe.skipIf(!HAS_MONZA)('Monza 2024 (R16, cached): every lap as the store computes it', () => {
  const rows = HAS_MONZA ? chain(monza.lap_times) : [];

  it('the live path (the store, computePCA\'s default) is the Procrustes rotation', () => {
    expect(LIVE_PCA_ALIGN).toBe('rotation');
    for (const r of rows.filter((x) => x.prev)) expect(r.p.alignment.mode).toBe(LIVE_PCA_ALIGN);
  });

  it('the rotation undoes the in-plane turn the sign alignment drew as a jump (lap 42)', () => {
    const move = (list, lap) => {
      const r = list.find((x) => x.lap === lap);
      const before = list.find((x) => x.lap === lap - 1);
      const at = new Map(before.res.driverAbbrs.map((d, i) => [d, before.p.scores[i]]));
      let t = 0; let n = 0;
      r.res.driverAbbrs.forEach((d, i) => {
        const q = at.get(d);
        if (q) { t += Math.hypot(r.p.scores[i].x - q.x, r.p.scores[i].y - q.y); n += 1; }
      });
      return t / n;
    };
    const sign = chain(monza.lap_times, { align: 'sign' });
    // sign: both dots fall to about 0.2 at lap 42 (an in-plane turn it cannot undo)
    expect(Math.max(...sign.find((x) => x.lap === 42).p.alignment.dots)).toBeLessThan(0.3);
    // scripts/pca_repair_check.mjs section 3: mean move at lap 42, 2.67 (sign) vs 0.47 (rotation)
    expect(move(sign, 42)).toBeGreaterThan(2.5);
    expect(move(rows, 42)).toBeLessThan(0.5);
    // and the largest lap-to-lap mean move of the race is smaller
    const largest = (list) => Math.max(...list.filter((x) => x.lap > list[0].lap).map((x) => move(list, x.lap)));
    expect(largest(rows)).toBeLessThan(largest(sign));
  });

  it('each displayed axis . the previous lap\'s >= 0 on every call, sign mode', () => {
    const sign = chain(monza.lap_times, { align: 'sign' });
    expect(sign.length).toBeGreaterThan(45);
    const aligned = sign.filter((r) => r.prev);
    expect(aligned.length).toBe(sign.length - 1);
    for (const r of aligned) {
      expect(r.p.alignment.mode).toBe('sign');
      // the dots are taken on the feature-ordered bases, never on the sorted loadings
      let d1 = 0; let d2 = 0;
      r.p.basis.forEach((b, j) => { d1 += b[0] * r.prev.basis[j][0]; d2 += b[1] * r.prev.basis[j][1]; });
      expect(d1).toBeCloseTo(r.p.alignment.dots[0], 12);
      expect(d2).toBeCloseTo(r.p.alignment.dots[1], 12);
      expect(d1).toBeGreaterThanOrEqual(0);
      expect(d2).toBeGreaterThanOrEqual(0);
    }
  });

  it('the rotation mode keeps every dot >= 0 too (diag(V S V^T) >= 0)', () => {
    for (const r of chain(monza.lap_times, { align: 'rotation' }).filter((x) => x.prev)) {
      expect(Math.min(...r.p.alignment.dots)).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('points and loading arrows share one basis (score = sum_j z_j x arrow_j)', () => {
    for (const r of rows) {
      const { standardized } = standardize(r.res.matrix);
      const byFeature = new Map(r.p.loadings.map((l) => [l.feature, l]));
      standardized.forEach((z, i) => {
        let x = 0; let y = 0;
        FEATURE_NAMES.forEach((name, j) => {
          x += z[j] * byFeature.get(name).pc1;
          y += z[j] * byFeature.get(name).pc2;
        });
        expect(r.p.scores[i].x).toBeCloseTo(x, 9);
        expect(r.p.scores[i].y).toBeCloseTo(y, 9);
      });
    }
  });

  it('the label is the variance each axis captures at that lap, the field mean is the origin', () => {
    for (const r of rows) {
      const { standardized } = standardize(r.res.matrix);
      const C = covarianceMatrix(standardized);
      let total = 0;
      for (let j = 0; j < C.length; j++) total += C[j][j];
      const n = r.p.scores.length;
      for (const [k, key] of [[0, 'x'], [1, 'y']]) {
        const v = r.p.scores.map((s) => s[key]);
        const m = v.reduce((a, b) => a + b, 0) / n;
        const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
        expect(r.p.explainedVariance[k]).toBeCloseTo(variance / total, 12);
        expect(Math.abs(m)).toBeLessThan(1e-9);
      }
      // the rotation keeps the axes in the PC1-PC2 plane: together they capture PC1 + PC2
      expect(r.p.explainedVariance[0] + r.p.explainedVariance[1]).toBeCloseTo(r.p.eigenShare[0] + r.p.eigenShare[1], 12);
      // standardized with the current means / SDs: |z| <= (n - 1) / sqrt(n)
      for (const z of standardized.flat()) expect(Math.abs(z)).toBeLessThanOrEqual((n - 1) / Math.sqrt(n) + 1e-9);
      expect(r.p.eigenResidual).toBeLessThan(1e-8);
    }
    // no frozen label: lap 20 and lap 50 differ from lap 11
    const at = (lap) => rows.find((x) => x.lap === lap).p.explainedVariance[0];
    expect(at(20)).not.toBeCloseTo(at(11), 3);
    expect(at(50)).not.toBeCloseTo(at(11), 3);
    // sign mode: the axes are the principal axes, each label the eigenvalue share
    for (const r of chain(monza.lap_times, { align: 'sign' })) {
      expect(r.p.explainedVariance[0]).toBeCloseTo(r.p.eigenShare[0], 12);
      expect(r.p.explainedVariance[1]).toBeCloseTo(r.p.eigenShare[1], 12);
    }
  });

  it('store.computeRaceSituation: unaligned scores of the refit, label and arrows from it', async () => {
    const { useF1Store } = await import('../store/useF1Store.js');
    const { replayReferenceAt } = await import('../utils/raceSituationReference.js');
    const lapTimes = monza.lap_times;
    // 'FP2' keeps the Monte Carlo projection (a race-only view) out of this test
    const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
    const dnfMap = {};
    const sessionTimeOffset = computeSessionTimeOffset(lapTimes);
    useF1Store.setState({
      sessionData: { lap_times: lapTimes }, loadedSessionType: 'FP2', isQualifyingReplay: false,
      maxLap, sessionTimeOffset,
      isLiveMode: false, totalFrames: 0, frameData: null, dnfMap, lapModeRaceOver: false,
      raceSituationData: null, raceSituationLap: null, _prevPcaResult: null,
    });
    // A replay's reference is the previous lap's axes as a replay from the
    // first lap draws them (utils/raceSituationReference.js), not the
    // previous computation: lap 10 opened directly is turned onto lap 9's
    // axes, and lap 20 onto lap 19's, not onto lap 12's
    for (const lap of [10, 11, 12, 20]) {
      useF1Store.setState({ currentLap: lap });
      useF1Store.getState().computeRaceSituation();
      const rsd = useF1Store.getState().raceSituationData;
      const now = resolveSessionNow({ currentLap: lap, lapTimes });
      expect(rsd.computedAtNow).toBe(now);
      const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap, sessionNow: now });
      const reference = replayReferenceAt(lapTimes, lap, { dnfMap, sessionTimeOffset, sessionNow: now });
      expect(reference).not.toBeNull();
      const p = computePCA(res.matrix, FEATURE_NAMES, reference, { align: LIVE_PCA_ALIGN });
      expect(rsd.driverAbbrs).toEqual(res.driverAbbrs);
      expect(rsd.scores).toEqual(p.scores);
      expect(rsd.loadings).toEqual(p.loadings);
      expect(rsd.explainedVariance).toEqual(p.explainedVariance);
      expect(rsd.paceInPca).toBe(true);
    }
  });
});
