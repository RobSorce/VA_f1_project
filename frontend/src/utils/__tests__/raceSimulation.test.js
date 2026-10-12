import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRaceParams, simulateRaceFinish } from '../raceSimulation.js';
import { extractRaceSituationFeatures } from '../raceSituationFeatures.js';
import { estimatePitLoss, FALLBACK_PIT_LOSS } from '../pitLoss.js';
import { deriveStints } from '../stints.js';
import { resolveSessionNow } from '../raceTime.js';
import { hasCachedSession, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';
import { perturbFuture } from './futureRows.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.resolve(HERE, '../raceSimulation.js'), 'utf8');

// Synthetic race on the SESSION clock: lap n of driver i starts at
// T0 + (n - 1) * 100 + i. One stop per driver: in-lap 6 (+5 s), out-lap 7 (+15 s).
const T0 = 1000;
const DRIVERS = ['AAA', 'BBB', 'CCC'];

function syntheticRace({ n = 14, pace = 90 } = {}) {
  const rows = [];
  DRIVERS.forEach((drv, i) => {
    for (let k = 1; k <= n; k++) {
      let t = pace + i * 0.1 + (k % 2) * 0.2;
      const start = T0 + (k - 1) * 100 + i;
      const row = {
        Driver: drv, LapNumber: k, LapStartTime: start, TrackStatus: '1', Position: i + 1,
        Stint: k <= 6 ? 1 : 2, Compound: k <= 6 ? 'MEDIUM' : 'HARD', TyreLife: k <= 6 ? k : k - 6,
        PitInTimeSeconds: null, PitOutTimeSeconds: null,
      };
      if (k === 6) { t += 5; row.PitInTimeSeconds = start + t - 8; }
      if (k === 7) { t += 15; row.PitOutTimeSeconds = start + 22; }
      row.LapTimeSeconds = t;
      row.Time = start + t;
      rows.push(row);
    }
  });
  return rows;
}

function maxLapOf(lapTimes) {
  return Math.max(...lapTimes.map((lt) => lt.LapNumber));
}

// The deterministic parts of extractRaceParams (no SC section: S8 owns it)
function lapDerived(params) {
  const { pitLoss, tyreDeg, stintLength, freshDelta, lapNoise } = params;
  return { pitLoss, tyreDeg, stintLength, freshDelta, lapNoise };
}

describe('extractRaceParams: pit loss (D5)', () => {
  it('delegates to estimatePitLoss with the same clock (in-lap + out-lap, not in-lap only)', () => {
    const rows = syntheticRace();
    // race over (Infinity): the lap clock of the last lap is its start (R4)
    const p = extractRaceParams(rows, [], [], maxLapOf(rows), { sessionNow: Infinity });
    expect(p.pitLoss).toEqual(estimatePitLoss(rows, { sessionNow: Infinity }));
    expect(p.pitLoss.source).toBe('race');
    expect(p.pitLoss.n).toBe(3);
    // in-lap +5 s and out-lap +15 s: the loss is about 20 s, never the in-lap 5 s alone
    expect(p.pitLoss.median).toBeGreaterThan(19);
    expect(p.pitLoss.median).toBeLessThan(21);
  });

  it('returns the fallback object (source fallback, median 22) with no data or no stop yet', () => {
    const empty = extractRaceParams([], [], [], 10);
    expect(empty.pitLoss.source).toBe('fallback');
    expect(empty.pitLoss.median).toBe(FALLBACK_PIT_LOSS.median);
    expect(empty.pitLoss.stdDev).toBe(FALLBACK_PIT_LOSS.stdDev);

    const rows = syntheticRace();
    const beforeStop = extractRaceParams(rows, [], [], 6); // lap mode: leader at end of lap 5
    expect(beforeStop.pitLoss.source).toBe('fallback');
    expect(beforeStop.pitLoss.median).toBe(22);
    expect(beforeStop.pitLoss.n).toBe(0);
  });

  it('accepts opts { sessionNow, sessionTimeOffset } and ignores a legacy frameData 5th argument', () => {
    const rows = syntheticRace();
    const lapModeNow = resolveSessionNow({ currentLap: 12, lapTimes: rows });
    const legacy = extractRaceParams(rows, [], [], 12);
    const explicit = extractRaceParams(rows, [], [], 12, { sessionNow: lapModeNow });
    const frameData = { frames: [{ t: 0, drivers: {} }], total_laps: 14, max_time: 5000 };
    const withFrames = extractRaceParams(rows, [], [], 12, frameData);
    expect(lapDerived(explicit)).toEqual(lapDerived(legacy));
    expect(lapDerived(withFrames)).toEqual(lapDerived(legacy));
    // leader at the end of lap 11: every out-lap (7) is over and each driver has > 5 green laps
    expect(explicit.pitLoss.n).toBe(3);
    // An explicit replay clock wins over currentLap: 1 s before the first pit entry
    const firstPitIn = Math.min(...rows.filter((r) => r.PitInTimeSeconds).map((r) => r.PitInTimeSeconds));
    const early = extractRaceParams(rows, [], [], 12, { sessionNow: firstPitIn - 1 });
    expect(early.pitLoss.source).toBe('fallback');
  });

  it('the Monte Carlo sampler draws around the median; the 15 s clamp is gone', () => {
    expect(SOURCE).not.toMatch(/Math\.max\(\s*15\s*,/);
    expect(SOURCE).toMatch(/Math\.max\(PIT_LOSS_NUMERIC_FLOOR,/);
    expect(SOURCE).toMatch(/const PIT_LOSS_NUMERIC_FLOOR = 5;/);
    expect(SOURCE).toMatch(/const PIT_LOSS_SAMPLING_MIN_SD = 0\.5;/);
    // sampler and identifyRisks both use the median; nothing reads pitLoss.mean
    expect(SOURCE.match(/raceParams\.pitLoss\.median/g).length).toBeGreaterThanOrEqual(2);
    expect(SOURCE).not.toMatch(/pitLoss\.mean/);
    // the estimator is reused, not re-implemented here
    expect(SOURCE).toMatch(/import \{ estimatePitLoss \} from '\.\/pitLoss';/);
  });
});

describe('extractRaceParams: causal laps (D4) and stints from lap_times (D1)', () => {
  it('never reads what is not known at sessionNow (rows not completed, future pit / tyre data)', () => {
    const rows = syntheticRace();
    for (const currentLap of [4, 7, 8, 12]) {
      const now = resolveSessionNow({ currentLap, lapTimes: rows });
      const a = extractRaceParams(rows, [], [], currentLap);
      const b = extractRaceParams(perturbFuture(rows, now), [], [], currentLap);
      expect(lapDerived(b)).toEqual(lapDerived(a));
    }
  });

  it('stint lengths come from deriveStints (completed stints only), not from tyre_strategy', () => {
    const rows = syntheticRace();
    const merged = [{ Driver: 'AAA', StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: 14, TotalLaps: 14 }];
    const final = extractRaceParams(rows, merged, [], 14, { sessionNow: Infinity });
    // 3 x MEDIUM 1-6 and 3 x HARD 7-14 from the Stint column; the merged row is ignored
    expect(final.stintLength.MEDIUM.mean).toBe(6);
    expect(final.stintLength.HARD.mean).toBe(8);
    // mid-race: the running HARD stints are ongoing and excluded
    const mid = extractRaceParams(rows, merged, [], 10);
    expect(mid.stintLength.MEDIUM.mean).toBe(6);
    expect(mid.stintLength.HARD).toBeUndefined();
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16, cached)', () => {
  const s = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16) : null;
  const lapTimes = s?.lap_times || [];
  const maxLap = s ? maxLapOf(lapTimes) : 0;

  it('with the race over the pit loss median is 26.8 +/- 1.5 s, source race', () => {
    const p = extractRaceParams(lapTimes, s.tyre_strategy, s.track_status, maxLap, { sessionNow: Infinity });
    expect(p.pitLoss.source).toBe('race');
    expect(Math.abs(p.pitLoss.median - 26.8)).toBeLessThanOrEqual(1.5);
    expect(p.pitLoss).toEqual(estimatePitLoss(lapTimes, { sessionNow: Infinity }));
    // the old in-lap-only code gave mean 6.4 s here; the new spread is the race's
    expect(p.pitLoss.p10).toBeLessThan(p.pitLoss.median);
    expect(p.pitLoss.p90).toBeGreaterThan(p.pitLoss.median);
  });

  it('before the first pit entry the estimate is the labelled fallback (22 s)', () => {
    const firstPitIn = Math.min(...lapTimes.filter((r) => r.PitInTimeSeconds).map((r) => r.PitInTimeSeconds));
    const p = extractRaceParams(lapTimes, s.tyre_strategy, s.track_status, 30, { sessionNow: firstPitIn - 1 });
    expect(p.pitLoss.source).toBe('fallback');
    expect(p.pitLoss.median).toBe(22);
    // lap mode at lap 5: the leader has finished lap 4, HUL's lap-5 stop is not visible yet
    const lapMode = extractRaceParams(lapTimes, s.tyre_strategy, s.track_status, 5);
    expect(lapMode.pitLoss.source).toBe('fallback');
  });

  it('stint lengths use the 50 Stint-column stints (tyre_strategy has 40)', () => {
    const p = extractRaceParams(lapTimes, s.tyre_strategy, s.track_status, maxLap, { sessionNow: Infinity });
    const stints = deriveStints(lapTimes);
    expect(stints.length).toBe(50);
    expect(s.tyre_strategy.length).toBe(40);
    const hard = stints.filter((st) => st.Compound === 'HARD').map((st) => st.TotalLaps);
    const mean = hard.reduce((a, b) => a + b, 0) / hard.length;
    expect(p.stintLength.HARD.mean).toBeCloseTo(mean, 9);
  });

  it('lap 30 is causal: changing anything not known yet leaves the parameters unchanged', () => {
    const now = resolveSessionNow({ currentLap: 30, lapTimes });
    const a = extractRaceParams(lapTimes, s.tyre_strategy, s.track_status, 30);
    const b = extractRaceParams(perturbFuture(lapTimes, now), s.tyre_strategy, s.track_status, 30);
    expect(lapDerived(b)).toEqual(lapDerived(a));
    expect(a.pitLoss.source).toBe('race');
    for (const smp of a.pitLoss.samples) {
      const out = lapTimes.find((r) => r.Driver === smp.driver && r.LapNumber === smp.inLap + 1);
      expect(out.Time).toBeLessThanOrEqual(now);
    }
  });

  it('simulateRaceFinish still returns projections at lap 30, with the clock forwarded', () => {
    const features = extractRaceSituationFeatures({ lapTimes, currentLap: 30, dnfMap: {} });
    expect(features).not.toBeNull();
    const now = resolveSessionNow({ currentLap: 30, lapTimes });
    const res = simulateRaceFinish({
      driverFeatures: features.driverFeatures, currentLap: 30, maxLap,
      lapTimes, strategies: s.tyre_strategy, trackStatus: s.track_status,
      sessionNow: now,
    });
    expect(res).not.toBeNull();
    expect(res.projections.length).toBe(Object.keys(features.driverFeatures).length);
    for (const pr of res.projections) {
      expect(pr.expectedPos).toBeGreaterThanOrEqual(1);
      expect(pr.expectedPos).toBeLessThanOrEqual(res.projections.length);
    }
    expect(res.raceParams.pitLoss).toEqual(estimatePitLoss(lapTimes, { sessionNow: now }));
    // without sessionNow the lap-mode clock of currentLap gives the same parameters
    const legacy = simulateRaceFinish({
      driverFeatures: features.driverFeatures, currentLap: 30, maxLap,
      lapTimes, strategies: s.tyre_strategy, trackStatus: s.track_status,
    });
    expect(lapDerived(legacy.raceParams)).toEqual(lapDerived(res.raceParams));
  });
});

describe.skipIf(!hasCachedSession(2024, 5))('China 2024 (R5, Safety Car, cached)', () => {
  it('SC/VSC laps no longer leak into the pit loss: median = validation true_loss 24.7', () => {
    const s = loadCachedSession(2024, 5);
    const p = extractRaceParams(s.lap_times, s.tyre_strategy, s.track_status, maxLapOf(s.lap_times),
      { sessionNow: Infinity });
    expect(p.pitLoss.source).toBe('race');
    // notes/experiments/validate_pit_loss_baseline_2026-10-12.txt: 2024_5 true_loss 24.7
    expect(Math.abs(p.pitLoss.median - 24.7)).toBeLessThanOrEqual(0.05);
  });
});
