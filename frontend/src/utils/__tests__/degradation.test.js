import { describe, it, expect } from 'vitest';
import {
  cleanStintLaps, fitStint, stintFits, compoundDegradation, consistencySigma, isCleanLap,
  fuelCorrectedTime, FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS, MAX_LAP_TIME_S,
} from '../degradation.js';
import { deriveStints } from '../stints.js';
import { completedLaps, leaderLapEndTime } from '../raceTime.js';
import {
  hasCachedSession, loadCachedSession, listCachedRaces,
} from '../../__tests__/helpers/cachedSession.js';

// Synthetic laps on the SESSION clock: lap n runs from T0 + (n - 1) * 90 to
// T0 + n * 90. LapTimeSeconds follows a known line: BASE + DEG x TyreLife
// - FUEL x (LapNumber - 1), so the fuel-corrected time is BASE + DEG x TyreLife.
const T0 = 1000;
const DUR = 90;
const BASE = 80;
const DEG = 0.05;

function lap(driver, n, extra = {}) {
  const start = T0 + (n - 1) * DUR;
  return {
    Driver: driver, LapNumber: n, LapStartTime: start, Time: start + DUR,
    TrackStatus: '1', Stint: 1, Compound: 'MEDIUM', TyreLife: n,
    PitInTimeSeconds: null, PitOutTimeSeconds: null,
    LapTimeSeconds: BASE + DEG * n - FUEL_EFFECT_S_PER_LAP * (n - 1),
    ...extra,
  };
}

/** One stint of laps from..to: TyreLife = first + (n - from), lap time on the line plus noise(n). */
function stint(driver, from, to, { first = 1, deg = DEG, noise = () => 0, ...extra } = {}) {
  const out = [];
  for (let n = from; n <= to; n++) {
    const tl = first + (n - from);
    out.push(lap(driver, n, {
      TyreLife: tl, LapTimeSeconds: BASE + deg * tl - FUEL_EFFECT_S_PER_LAP * (n - 1) + noise(n), ...extra,
    }));
  }
  return out;
}

/** Mark lap n as in-lap and n + 1 as out-lap. */
function withStop(rows, driver, inLap) {
  return rows.map((r) => {
    if (r.Driver !== driver) return r;
    if (r.LapNumber === inLap) return { ...r, PitInTimeSeconds: r.Time - 5 };
    if (r.LapNumber === inLap + 1) return { ...r, PitOutTimeSeconds: r.LapStartTime + 20 };
    return r;
  });
}

// Deterministic small noise (+-0.1 s) so the robust sigma is not zero
const wiggle = (n) => [0.1, -0.05, 0.02, -0.1, 0.06, -0.03, 0.08, -0.07][n % 8];
const lapNumbers = (laps) => laps.map((lt) => lt.LapNumber);

describe('fitStint', () => {
  it('recovers the fuel-corrected slope, the raw slope and the intercept of a known line', () => {
    const laps = stint('AAA', 2, 15, { first: 2 });
    const fit = fitStint(laps);
    expect(fit.slope).toBeCloseTo(DEG, 12);
    expect(fit.rawSlope).toBeCloseTo(DEG - FUEL_EFFECT_S_PER_LAP, 12);
    expect(fit.intercept).toBeCloseTo(BASE, 9);
    expect(fit.n).toBe(14);
    expect(fit.residualSigma).toBeLessThan(1e-9);
    expect(fit.slopeStdErr).toBeLessThan(1e-9);
    expect([fit.tyreLifeMin, fit.tyreLifeMax]).toEqual([2, 15]);
  });

  it('fuel-corrected time = LapTimeSeconds + FUEL_EFFECT_S_PER_LAP x (LapNumber - 1)', () => {
    expect(fuelCorrectedTime({ LapTimeSeconds: 90, LapNumber: 11 })).toBeCloseTo(90 + 10 * FUEL_EFFECT_S_PER_LAP, 12);
    expect(fuelCorrectedTime({ LapTimeSeconds: 90, LapNumber: 1 })).toBe(90);
  });

  it(`returns null below MIN_FIT_LAPS (${MIN_FIT_LAPS}) laps and with a single TyreLife value`, () => {
    expect(fitStint(stint('AAA', 2, 1 + MIN_FIT_LAPS - 1, { first: 2 }))).toBeNull();
    expect(fitStint(stint('AAA', 2, 1 + MIN_FIT_LAPS, { first: 2 }))).not.toBeNull();
    const flat = stint('AAA', 2, 12, { first: 2 }).map((r) => ({ ...r, TyreLife: 5 }));
    expect(fitStint(flat)).toBeNull();
    expect(fitStint(null)).toBeNull();
  });

  it('keeps negative slopes as they are (never clamped)', () => {
    const fit = fitStint(stint('AAA', 2, 15, { first: 2, deg: -0.04 }));
    expect(fit.slope).toBeCloseTo(-0.04, 12);
    expect(fit.rawSlope).toBeCloseTo(-0.04 - FUEL_EFFECT_S_PER_LAP, 12);
  });

  it('residualSigma = sqrt(SSE / (n - 2)) and slopeStdErr = residualSigma / sqrt(Sxx)', () => {
    const laps = stint('AAA', 2, 13, { first: 2, noise: wiggle });
    const fit = fitStint(laps);
    const xs = laps.map((r) => r.TyreLife);
    const ys = laps.map(fuelCorrectedTime);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sse = xs.reduce((s, x, i) => s + (ys[i] - fit.intercept - fit.slope * x) ** 2, 0);
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    expect(fit.residualSigma).toBeCloseTo(Math.sqrt(sse / (xs.length - 2)), 12);
    expect(fit.slopeStdErr).toBeCloseTo(fit.residualSigma / Math.sqrt(sxx), 12);
  });
});

describe('cleanStintLaps', () => {
  it('keeps completed green laps > 1 that are neither in- nor out-laps, with a lap time < 200 s and a TyreLife', () => {
    let rows = [
      ...stint('AAA', 1, 12, { first: 1 }),
      ...stint('AAA', 13, 30, { first: 1, Stint: 2, Compound: 'HARD' }),
    ];
    rows = withStop(rows, 'AAA', 12);
    rows = rows.map((r) => {
      if (r.LapNumber === 5) return { ...r, TrackStatus: '4' };      // SC
      if (r.LapNumber === 6) return { ...r, TrackStatus: '12' };     // yellow during the lap
      if (r.LapNumber === 20) return { ...r, LapTimeSeconds: MAX_LAP_TIME_S };
      if (r.LapNumber === 21) return { ...r, LapTimeSeconds: null };
      if (r.LapNumber === 22) return { ...r, TyreLife: null };
      return r;
    });
    const out = cleanStintLaps(rows);
    expect(out.map((s) => [s.driver, s.stintNumber, s.compound, s.startLap, s.endLap])).toEqual([
      ['AAA', 1, 'MEDIUM', 1, 12], ['AAA', 2, 'HARD', 13, 30],
    ]);
    // lap 1 (start), 5 (SC), 6 (yellow), 12 (in-lap) out of stint 1
    expect(lapNumbers(out[0].laps)).toEqual([2, 3, 4, 7, 8, 9, 10, 11]);
    // lap 13 (out-lap), 20 (>= 200 s), 21 (no time), 22 (no TyreLife) out of stint 2
    expect(lapNumbers(out[1].laps)).toEqual([14, 15, 16, 17, 18, 19, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(out.every((s) => s.outliers.length === 0)).toBe(true);
    expect(rows.filter(isCleanLap).length).toBe(8 + 14);
  });

  it('is causal: only laps completed at sessionNow, stints as deriveStints at sessionNow', () => {
    const rows = withStop([
      ...stint('AAA', 1, 12, { first: 1 }),
      ...stint('AAA', 13, 30, { first: 1, Stint: 2, Compound: 'HARD' }),
    ], 'AAA', 12);
    const now = T0 + 10 * DUR + 30; // lap 11 in progress
    const out = cleanStintLaps(rows, { sessionNow: now });
    expect(out).toHaveLength(1);
    expect(out[0].endLap).toBe(10);
    expect(lapNumbers(out[0].laps)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // just after the pit exit: stint 2 exists in deriveStints with 0 laps, not here
    const exit = T0 + 12 * DUR + 25;
    expect(deriveStints(rows, { sessionNow: exit }).map((s) => s.TotalLaps)).toEqual([12, 0]);
    expect(cleanStintLaps(rows, { sessionNow: exit }).map((s) => s.stintNumber)).toEqual([1]);
  });

  it('removes slow outliers only (one pass, residual - median > 3.5 robust sigmas)', () => {
    const rows = stint('AAA', 2, 25, { first: 2, noise: (n) => wiggle(n) + (n === 14 ? 3 : 0) + (n === 13 ? -3 : 0) });
    const [st] = cleanStintLaps(rows);
    expect(lapNumbers(st.outliers)).toEqual([14]);
    expect(lapNumbers(st.laps)).toContain(13); // a fast lap is kept
    expect(st.laps).toHaveLength(23);
  });

  it('removes nothing from a perfectly linear stint (robust sigma floor)', () => {
    const [st] = cleanStintLaps(stint('AAA', 2, 25, { first: 2 }));
    expect(st.outliers).toEqual([]);
    expect(st.laps).toHaveLength(24);
  });

  it('runs no outlier test on a stint too short to fit', () => {
    const rows = stint('AAA', 2, MIN_FIT_LAPS, { first: 2, noise: (n) => (n === 4 ? 5 : 0) });
    const [st] = cleanStintLaps(rows);
    expect(st.outliers).toEqual([]);
    expect(st.laps).toHaveLength(MIN_FIT_LAPS - 1);
  });

  it('filters by driver', () => {
    const rows = [...stint('AAA', 1, 12), ...stint('BBB', 1, 12)];
    expect(cleanStintLaps(rows, { driver: 'BBB' }).map((s) => s.driver)).toEqual(['BBB']);
    expect(cleanStintLaps(rows).map((s) => s.driver)).toEqual(['AAA', 'BBB']);
    expect(cleanStintLaps([])).toEqual([]);
    expect(cleanStintLaps(null)).toEqual([]);
  });
});

describe('stintFits', () => {
  const rows = withStop([
    ...stint('AAA', 1, 20, { first: 1, noise: wiggle }),
    ...stint('AAA', 21, 40, { first: 1, Stint: 2, Compound: 'HARD', deg: 0.02, noise: wiggle }),
  ], 'AAA', 20);

  it('one row per stint with the fit of its clean laps', () => {
    const fits = stintFits(rows);
    expect(fits.map((f) => [f.driver, f.stintNumber, f.compound, f.startLap, f.endLap, f.n])).toEqual([
      ['AAA', 1, 'MEDIUM', 1, 20, 18], ['AAA', 2, 'HARD', 21, 40, 19],
    ]);
    const s1 = cleanStintLaps(rows)[0];
    expect(fits[0]).toMatchObject(fitStint(s1.laps));
  });

  it('{ lapStart, lapEnd } restricts the laps used, per stint; stints outside the range are left out', () => {
    const fits = stintFits(rows, { lapStart: 10, lapEnd: 30 });
    expect(fits.map((f) => [f.stintNumber, f.n, f.tyreLifeMin, f.tyreLifeMax])).toEqual([[1, 10, 10, 19], [2, 9, 2, 10]]);
    const st = cleanStintLaps(rows);
    expect(fits[0]).toMatchObject(fitStint(st[0].laps.filter((r) => r.LapNumber >= 10 && r.LapNumber <= 30)));
    expect(stintFits(rows, { lapStart: 25 }).map((f) => f.stintNumber)).toEqual([2]);
    expect(stintFits(rows, { lapEnd: 15 }).map((f) => f.stintNumber)).toEqual([1]);
  });

  it('a stint with too few clean laps in the range keeps its row with a null fit', () => {
    const [f] = stintFits(rows, { lapStart: 2, lapEnd: 6 });
    expect(f).toMatchObject({
      stintNumber: 1, slope: null, rawSlope: null, intercept: null, residualSigma: null, slopeStdErr: null,
      n: 5, tyreLifeMin: 2, tyreLifeMax: 6,
    });
  });
});

describe('compoundDegradation', () => {
  it('mean, median, sample stdDev, n and negativeCount per compound; null slopes skipped; negatives kept', () => {
    const deg = compoundDegradation([
      { compound: 'HARD', slope: 0.02 }, { compound: 'HARD', slope: -0.01 }, { compound: 'HARD', slope: 0.05 },
      { compound: 'HARD', slope: null }, { compound: 'SOFT', slope: 0.1 },
    ]);
    expect(Object.keys(deg)).toEqual(['HARD', 'SOFT']);
    expect(deg.HARD.n).toBe(3);
    expect(deg.HARD.negativeCount).toBe(1);
    expect(deg.HARD.mean).toBeCloseTo(0.02, 12);
    expect(deg.HARD.median).toBeCloseTo(0.02, 12);
    expect(deg.HARD.stdDev).toBeCloseTo(Math.sqrt((0 + 0.03 ** 2 + 0.03 ** 2) / 2), 12);
    expect(deg.SOFT).toEqual({ mean: 0.1, median: 0.1, stdDev: 0, n: 1, negativeCount: 0 });
    expect(compoundDegradation([])).toEqual({});
  });
});

describe('consistencySigma', () => {
  it('pools the residuals of the per-stint fits: sqrt(sum SSE / sum (n - 2))', () => {
    const rows = withStop([
      ...stint('AAA', 1, 20, { first: 1, noise: wiggle }),
      ...stint('AAA', 21, 40, { first: 1, Stint: 2, Compound: 'HARD', noise: (n) => 2 * wiggle(n) }),
    ], 'AAA', 20);
    const fits = stintFits(rows, { driver: 'AAA' });
    const sse = fits.reduce((s, f) => s + f.residualSigma ** 2 * (f.n - 2), 0);
    const dof = fits.reduce((s, f) => s + f.n - 2, 0);
    const c = consistencySigma(rows, 'AAA');
    expect(c.sigma).toBeCloseTo(Math.sqrt(sse / dof), 12);
    expect(c).toMatchObject({ n: 37, stints: 2, outliers: 0 });
  });

  it('sigma null when no stint has a fit', () => {
    expect(consistencySigma(stint('AAA', 1, 6), 'AAA')).toEqual({ sigma: null, n: 0, stints: 0, outliers: 0 });
    expect(consistencySigma(stint('AAA', 1, 20), 'ZZZ')).toEqual({ sigma: null, n: 0, stints: 0, outliers: 0 });
  });
});

describe.skipIf(listCachedRaces().length === 0)('cached races', () => {
  const races = listCachedRaces();

  it.each(races.map((r) => [r.year, r.round]))('%i R%i: stints = deriveStints at sessionNow with a completed lap; causal fits', (year, round) => {
    const laps = loadCachedSession(year, round).lap_times;
    let maxLap = 0;
    for (const lt of laps) maxLap = Math.max(maxLap, Number(lt.LapNumber) || 0);
    for (const frac of [0.33, 0.66, 1]) {
      const now = frac === 1 ? Infinity : leaderLapEndTime(laps, Math.round(maxLap * frac));
      const clean = cleanStintLaps(laps, { sessionNow: now });
      const expected = deriveStints(laps, { sessionNow: now })
        .filter((s) => s.TotalLaps > 0)
        .map((s) => [s.Driver, s.StintNumber, s.Compound, s.StartLap, s.EndLap]);
      expect(clean.map((s) => [s.driver, s.stintNumber, s.compound, s.startLap, s.endLap])).toEqual(expected);
      // nothing after sessionNow, and the same fits as on the rows completed by then
      for (const s of clean) for (const lt of [...s.laps, ...s.outliers]) expect(lt.Time <= now).toBe(true);
      expect(stintFits(laps, { sessionNow: now })).toEqual(stintFits(completedLaps(laps, now)));
    }
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (numbers of notes/experiments/degradation_definition_monza.txt)', () => {
  const laps = loadCachedSession(2024, 16).lap_times;

  it('PIA laps 10-25: MEDIUM stint has 6 clean laps (no fit), HARD stint laps 18-25', () => {
    const fits = stintFits(laps, { driver: 'PIA', lapStart: 10, lapEnd: 25 });
    const rows = fits.map((f) => ({ st: f.stintNumber, c: f.compound, n: f.n, slope: f.slope && +f.slope.toFixed(4) }));
    console.log('PIA laps 10-25', rows);
    expect(rows).toEqual([{ st: 1, c: 'MEDIUM', n: 6, slope: null }, { st: 2, c: 'HARD', n: 8, slope: -0.1278 }]);
  });

  it('MEDIUM / HARD compound degradation, slow outliers and finisher sigmas', () => {
    const deg = compoundDegradation(stintFits(laps));
    const round4 = (d) => ({ n: d.n, mean: +d.mean.toFixed(4), median: +d.median.toFixed(4), negativeCount: d.negativeCount });
    console.log('Monza compound degradation', { MEDIUM: round4(deg.MEDIUM), HARD: round4(deg.HARD) });
    expect(round4(deg.MEDIUM)).toEqual({ n: 18, mean: 0.0065, median: 0.0096, negativeCount: 9 });
    expect(round4(deg.HARD)).toEqual({ n: 29, mean: 0.0135, median: 0.0182, negativeCount: 11 });
    const clean = cleanStintLaps(laps);
    expect(clean.reduce((s, st) => s + st.outliers.length, 0)).toBe(29);
    expect(clean.reduce((s, st) => s + st.laps.length, 0)).toBe(898);
    expect(+consistencySigma(laps, 'LEC').sigma.toFixed(3)).toBe(0.298);
    expect(+consistencySigma(laps, 'STR').sigma.toFixed(3)).toBe(0.568);
  });
});
