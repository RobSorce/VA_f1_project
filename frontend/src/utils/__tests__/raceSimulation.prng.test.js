import { describe, it, expect } from 'vitest';
import {
  uniformAt, normalAt, keyOf, seedFrom, STREAMS,
} from '../prng.js';
import { hasCachedSession, listCachedRaces, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';

const N = 100000;

function pearson(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

describe('prng.js: counter-based draws', () => {
  it('a draw is a pure function of its index, in (0, 1)', () => {
    const a = uniformAt(42, 3, 'VER', 17, STREAMS.LAP_NOISE);
    // other draws in between change nothing
    for (let i = 0; i < 1000; i++) uniformAt(42, i, 'LEC', i, STREAMS.PIT_LOSS);
    expect(uniformAt(42, 3, 'VER', 17, STREAMS.LAP_NOISE)).toBe(a);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    // each field matters
    const variants = [
      uniformAt(43, 3, 'VER', 17, STREAMS.LAP_NOISE),
      uniformAt(42, 4, 'VER', 17, STREAMS.LAP_NOISE),
      uniformAt(42, 3, 'LEC', 17, STREAMS.LAP_NOISE),
      uniformAt(42, 3, 'VER', 18, STREAMS.LAP_NOISE),
      uniformAt(42, 3, 'VER', 17, STREAMS.PIT_LOSS),
      uniformAt(42, 3, 'VER', 17, STREAMS.LAP_NOISE, 1),
    ];
    for (const v of variants) expect(v).not.toBe(a);
  });

  it('uniform: chi-square over 20 bins below the 0.1 % critical value (43.82, 19 dof)', () => {
    const bins = new Array(20).fill(0);
    let min = 1;
    let max = 0;
    for (let i = 0; i < N; i++) {
      const v = uniformAt(7, i % 1000, 'HAM', Math.floor(i / 1000), STREAMS.LAP_NOISE);
      bins[Math.floor(v * 20)] += 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const e = N / 20;
    const chi2 = bins.reduce((s, o) => s + (o - e) ** 2 / e, 0);
    expect(chi2).toBeLessThan(43.82);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(1);
  });

  it('neighbouring indices are uncorrelated (|r| < 0.015 over 100,000 pairs)', () => {
    const base = [];
    const nextLap = [];
    const nextSim = [];
    const nextStream = [];
    const nextDriver = [];
    for (let i = 0; i < N; i++) {
      const sim = i % 500;
      const lap = Math.floor(i / 500);
      base.push(uniformAt(11, sim, 'NOR', lap, STREAMS.LAP_NOISE));
      nextLap.push(uniformAt(11, sim, 'NOR', lap + 1, STREAMS.LAP_NOISE));
      nextSim.push(uniformAt(11, sim + 1, 'NOR', lap, STREAMS.LAP_NOISE));
      nextStream.push(uniformAt(11, sim, 'NOR', lap, STREAMS.PIT_LOSS));
      nextDriver.push(uniformAt(11, sim, 'PIA', lap, STREAMS.LAP_NOISE));
    }
    for (const other of [nextLap, nextSim, nextStream, nextDriver]) {
      expect(Math.abs(pearson(base, other))).toBeLessThan(0.015);
    }
  });

  it('normal: mean 0, sd 1, 5 % beyond +/-1.96 (100,000 draws)', () => {
    let sum = 0;
    let sq = 0;
    let tails = 0;
    for (let i = 0; i < N; i++) {
      const z = normalAt(5, i, 'SAI', 3, STREAMS.DEGRADATION);
      sum += z;
      sq += z * z;
      if (Math.abs(z) > 1.96) tails += 1;
    }
    const m = sum / N;
    const sd = Math.sqrt(sq / N - m * m);
    expect(Math.abs(m)).toBeLessThan(0.015);
    expect(Math.abs(sd - 1)).toBeLessThan(0.015);
    expect(Math.abs(tails / N - 0.05)).toBeLessThan(0.004);
  });

  it('seedFrom: deterministic, sensitive to every part, accepts Infinity', () => {
    expect(seedFrom('2024_16', Infinity)).toBe(seedFrom('2024_16', Infinity));
    expect(seedFrom('2024_16', Infinity)).not.toBe(seedFrom('2024_16', 5000));
    expect(seedFrom('2024_16', 5000.001)).not.toBe(seedFrom('2024_16', 5000));
    expect(seedFrom('a', 1)).not.toBe(seedFrom('b', 1));
    expect(Number.isInteger(seedFrom(1, 2, 'x'))).toBe(true);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('prng.js: driver keys on the cached races', () => {
  it('keyOf gives a distinct key to every driver code of the cached races', () => {
    const codes = new Set();
    for (const { year, round } of listCachedRaces()) {
      for (const lt of loadCachedSession(year, round).lap_times) if (lt.Driver) codes.add(lt.Driver);
    }
    const keys = new Set([...codes].map(keyOf));
    expect(codes.size).toBeGreaterThan(20);
    expect(keys.size).toBe(codes.size);
  });
});
