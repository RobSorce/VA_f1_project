import { describe, it, expect } from 'vitest';
import {
  extractRaceParams, simulateRaceFinish, compareStrategies, runSimulations, identifyRisks,
  freshDeltaEstimate, safetyCarEstimate, neutralEpisodes, stintLifeObservations, kaplanMeier,
  sampleStintEnd, stintLifeFor, degradationFor, projectedLapTime, projectLapTimes,
  PRIORS, FRESH_TYRE_LAPS, OPTIONAL_STOP_MIN_LAPS_LEFT, SC_PRIOR_WEIGHT_RACES, DEFAULT_NUM_SIMULATIONS,
  STINT_LIFE_MAX,
} from '../raceSimulation.js';
import { stintFits, compoundDegradation, consistencySigma, FUEL_EFFECT_S_PER_LAP } from '../degradation.js';
import { extractRaceSituationFeatures } from '../raceSituationFeatures.js';
import { resolveSessionNow } from '../raceTime.js';
import { pitStops } from '../stints.js';
import { hasCachedSession, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';
import { perturbFuture } from './futureRows.js';

// ─── Synthetic race on the SESSION clock ───
// Lap n of driver i starts at T0 + (n - 1) * 100 + i. One stop per driver:
// MEDIUM laps 1-6 (in-lap 6 +5 s), HARD from lap 7 (out-lap +15 s).
// Lap time = 90 + 0.2 i + 0.05 TyreLife - fuel burn, +/-0.05 s alternating,
// lap 1 +5 s, and `fresh` added to the first flying lap of the HARD set (lap 8).
const T0 = 1000;
const DRIVERS = ['AAA', 'BBB', 'CCC'];

function race({ n = 30, fresh = -0.3, lastLap = {}, edit } = {}) {
  const rows = [];
  DRIVERS.forEach((drv, i) => {
    const last = lastLap[drv] ?? n;
    for (let k = 1; k <= last; k++) {
      const tyreLife = k <= 6 ? k : k - 6;
      let t = 90 + i * 0.2 + 0.05 * tyreLife - FUEL_EFFECT_S_PER_LAP * (k - 1) + (k % 2 ? 0.05 : -0.05);
      if (k === 1) t += 5;
      if (k === 8) t += fresh;
      const start = T0 + (k - 1) * 100 + i;
      const row = {
        Driver: drv, LapNumber: k, LapStartTime: start, TrackStatus: '1', Position: i + 1,
        Stint: k <= 6 ? 1 : 2, Compound: k <= 6 ? 'MEDIUM' : 'HARD', TyreLife: tyreLife,
        PitInTimeSeconds: null, PitOutTimeSeconds: null, GapToLeader: i * 2,
      };
      if (k === 6) { t += 5; row.PitInTimeSeconds = start + t - 8; }
      if (k === 7) { t += 15; row.PitOutTimeSeconds = start + 22; }
      row.LapTimeSeconds = t;
      row.Time = start + t;
      if (edit) edit(row);
      rows.push(row);
    }
  });
  return rows;
}

// Injected parameters: no degradation, no noise, no safety car, sets never due
function flatParams(over = {}) {
  const zero = { mean: 0, median: 0, stdDev: 0, n: 5, negativeCount: 0, source: 'race' };
  const never = { survival: new Array(STINT_LIFE_MAX + 1).fill(1), median: Infinity, mean: STINT_LIFE_MAX, n: 5, source: 'race' };
  return {
    pitLoss: { median: 22, stdDev: 2, source: 'race', n: 5 },
    tyreDeg: { MEDIUM: zero, HARD: zero },
    stintLength: { MEDIUM: never, HARD: never },
    freshDelta: 0,
    lapNoise: 0,
    scRate: 0,
    estimates: { safetyCar: { rate: 0, scShare: 0, durations: { SC: [], VSC: [] }, scGapRatio: 1, ongoing: null } },
    transitions: {},
    dryRace: true,
    ...over,
  };
}

const FEATURES = {
  A: { position: 1, gapToLeader: 0, recentPace: 90, paceTrend: 0.05, tyreLife: 5, compoundName: 'MEDIUM' },
  B: { position: 2, gapToLeader: 3, recentPace: 90.5, paceTrend: 0, tyreLife: 5, compoundName: 'MEDIUM' },
};

const maxLapOf = (lt) => Math.max(...lt.map((x) => x.LapNumber));

// ══════════════════════════════════════════════════════════
describe('S1 fresh-tyre delta: paired within driver + stint, fuel-corrected, laps <= 2 and non-green out', () => {
  it('measures the first flying lap on a new set against its stint line (-0.3 s built in)', () => {
    const est = freshDeltaEstimate(race());
    expect(est.source).toBe('race');
    expect(est.n).toBe(3); // one HARD stint per driver
    // -0.3 s plus lap 8's share of the +/-0.05 s alternation (-0.05)
    expect(est.value).toBeCloseTo(-0.35, 1);
    expect(est.clamped).toBe(false);
    expect(est.freshTyreLaps).toBe(FRESH_TYRE_LAPS);
  });

  it('laps 1-2 (standing start, full fuel) never count: changing them changes nothing', () => {
    const base = freshDeltaEstimate(race());
    const slowStart = freshDeltaEstimate(race({
      edit: (r) => { if (r.LapNumber <= 2) r.LapTimeSeconds += 4; },
    }));
    expect(slowStart).toEqual(base);
  });

  it('a non-green fresh lap is no sample (prior, labelled); a slower fresh lap is clamped to 0', () => {
    const sc = freshDeltaEstimate(race({ edit: (r) => { if (r.LapNumber === 8) r.TrackStatus = '4'; } }));
    expect(sc.n).toBe(0);
    expect(sc.source).toBe('prior');
    expect(sc.value).toBe(Math.min(0, PRIORS.freshDelta.value));
    // +0.2 s (a slower fresh lap far beyond the stint's scatter would be a slow outlier)
    const slow = freshDeltaEstimate(race({ fresh: +0.2 }));
    expect(slow.source).toBe('race');
    expect(slow.raw).toBeGreaterThan(0.1);
    expect(slow.value).toBe(0);
    expect(slow.clamped).toBe(true);
  });
});

describe('S2 degradation and lap noise: the shared definition (utils/degradation.js)', () => {
  it('tyreDeg: every fit kept and counted (allFits = compoundDegradation(stintFits)); the estimate combines the fits long enough with the prior', () => {
    const rows = race({ edit: (r) => { if (r.Driver === 'CCC' && r.Stint === 2) r.LapTimeSeconds -= 0.1 * r.TyreLife; } });
    const p = extractRaceParams(rows, [], [], 30, { sessionNow: Infinity });
    const fits = stintFits(rows);
    const ref = compoundDegradation(fits);
    for (const [c, d] of Object.entries(ref)) expect(p.tyreDeg[c].allFits).toEqual(d);
    // CCC's HARD stint gets faster with tyre age: kept in the estimate, not clamped to 0
    expect(p.tyreDeg.HARD.negativeCount).toBe(1);
    expect(p.estimates.degradation.negativeFits).toBe(1);
    // the normal-normal combination, by hand: the prior's race mean with precision
    // 1 / betweenSd^2, each fit with 1 / (withinSd^2 + its slopeStdErr^2)
    const pr = PRIORS.degradation.HARD;
    const used = fits.filter((f) => f.compound === 'HARD' && f.slope != null && f.n >= pr.minFitLaps);
    expect(used).toHaveLength(3);
    let num = pr.raceMean / pr.betweenSd ** 2;
    let den = 1 / pr.betweenSd ** 2;
    for (const f of used) {
      const w = 1 / (pr.withinSd ** 2 + f.slopeStdErr ** 2);
      num += w * f.slope;
      den += w;
    }
    expect(p.tyreDeg.HARD).toMatchObject({ n: 3, short: 0, source: 'race' });
    expect(p.tyreDeg.HARD.mean).toBeCloseTo(num / den, 12);
    expect(p.tyreDeg.HARD.posteriorSd).toBeCloseTo(1 / Math.sqrt(den), 12);
    expect(degradationFor(p, 'HARD').samplingSd).toBeCloseTo(Math.sqrt(pr.withinSd ** 2 + 1 / den), 12);
  });

  it('a fit shorter than the compound\'s minFitLaps is counted (short) but not used: the prior until then', () => {
    const rows = race();
    // end of lap 19: the HARD stints have 12 clean laps (8-19), fewer than PRIORS.degradation.HARD.minFitLaps
    const now = T0 + 19 * 100;
    expect(PRIORS.degradation.HARD.minFitLaps).toBeGreaterThan(12);
    const p = extractRaceParams(rows, [], [], 20, { sessionNow: now });
    expect(p.tyreDeg.HARD).toMatchObject({ n: 0, short: 3, source: 'prior', mean: null });
    expect(p.tyreDeg.HARD.allFits.n).toBe(3);
    expect(p.estimates.degradation).toMatchObject({ fitted: 3, used: 0, short: 3, source: 'prior' });
    const d = degradationFor(p, 'HARD');
    expect(d.source).toBe('prior');
    expect(d.mean).toBe(PRIORS.degradation.HARD.raceMean);
  });

  it('lap noise (D1): the race\'s pooled residual sigma of the stint fits, no prior mixed in, no floor; the cached races\' value only before the first fit', () => {
    const rows = race();
    const now = T0 + 19 * 100;
    const p = extractRaceParams(rows, [], [], 20, { sessionNow: now });
    let sse = 0;
    let dof = 0;
    let laps = 0;
    for (const f of stintFits(rows, { sessionNow: now })) {
      if (f.slope == null) continue;
      sse += f.residualSigma ** 2 * (f.n - 2);
      dof += f.n - 2;
      laps += f.n;
    }
    // the synthetic laps scatter by +/-0.05 s (and the fresh-tyre lap): far below the prior, kept as it is
    expect(p.lapNoise).toBeCloseTo(Math.sqrt(sse / dof), 12);
    expect(p.lapNoise).toBeLessThan(PRIORS.lapNoise.dry.value / 2);
    expect(p.estimates.lapNoise).toMatchObject({ source: 'race', dof, laps, prior: { kind: 'dry', value: PRIORS.lapNoise.dry.value } });
    expect(p.estimates.lapNoise.raceValue).toBe(p.lapNoise);
    // the same pooled sums as the drivers' consistency sigmas (consistencySigma definition)
    let csse = 0;
    let cdof = 0;
    for (const d of DRIVERS) {
      const c = consistencySigma(rows, d, { sessionNow: now });
      if (c.sigma == null) continue;
      csse += c.sigma * c.sigma * (c.n - 2 * c.stints);
      cdof += c.n - 2 * c.stints;
    }
    expect(p.lapNoise).toBeCloseTo(Math.sqrt(csse / cdof), 12);
    // no fit yet: the cached dry races' value, n = 0
    const early = extractRaceParams(rows, [], [], 4, { sessionNow: T0 + 3 * 100 });
    expect(early.lapNoise).toBe(PRIORS.lapNoise.dry.value);
    expect(early.estimates.lapNoise).toMatchObject({ source: 'prior', laps: 0, stints: 0, raceValue: null });
    // a wet race: the race's own value, the wet value only as the pre-fit fallback
    const wet = race({ edit: (r) => { if (r.Stint === 2) r.Compound = 'INTERMEDIATE'; } });
    const w = extractRaceParams(wet, [], [], 20, { sessionNow: now });
    expect(w.dryRace).toBe(false);
    expect(w.estimates.lapNoise.prior).toMatchObject({ kind: 'wet', value: PRIORS.lapNoise.wet.value });
    expect(w.estimates.lapNoise.source).toBe('race');
    expect(w.lapNoise).toBe(w.estimates.lapNoise.raceValue);
  });

  it('lap 1 and SC laps do not enter the fit, whatever their time', () => {
    const marked = race({ edit: (r) => { if (r.LapNumber === 15 || r.LapNumber === 16) r.TrackStatus = '4'; } });
    const slowed = race({
      edit: (r) => {
        if (r.LapNumber === 15 || r.LapNumber === 16) { r.TrackStatus = '4'; r.LapTimeSeconds += 30; }
        if (r.LapNumber === 1) r.LapTimeSeconds += 10;
      },
    });
    const a = extractRaceParams(marked, [], [], 30, { sessionNow: Infinity });
    const b = extractRaceParams(slowed, [], [], 30, { sessionNow: Infinity });
    expect(b.tyreDeg).toEqual(a.tyreDeg);
    expect(b.lapNoise).toBe(a.lapNoise);
  });

  it('degradationFor: the race estimate, else the labelled prior', () => {
    const p = extractRaceParams(race(), [], [], 30, { sessionNow: Infinity });
    expect(degradationFor(p, 'HARD').source).toBe('race');
    const soft = degradationFor(p, 'SOFT');
    expect(soft.source).toBe('prior');
    // the prior of a race: the mean of the cached races' means
    expect(soft.mean).toBe(PRIORS.degradation.SOFT.raceMean);
  });
});

describe('S3 stint life: survival with censoring, DNF final stints dropped, stops capped by laps left', () => {
  it('Kaplan-Meier on a textbook case (events 2, 3; censored 3, 5)', () => {
    const km = kaplanMeier([
      { life: 2, kind: 'event' }, { life: 3, kind: 'event' }, { life: 3, kind: 'censored' },
      { life: 5, kind: 'censored' }, { life: 9, kind: 'dropped' },
    ]);
    // S(2) = 3/4, S(3) = 3/4 x 2/3 = 1/2 (the set censored at 3 is at risk at 3)
    expect(km.survival).toEqual([1, 1, 0.75, 0.5, 0.5, 0.5]);
    expect(km.events).toBe(2);
    expect(km.censored).toBe(2);
  });

  it('a non-finisher\'s final stint is dropped, an ongoing stint censored', () => {
    const rows = race({ lastLap: { CCC: 10 } });
    const end = stintLifeObservations(rows);
    expect(end.filter((o) => o.kind === 'dropped')).toEqual([
      { driver: 'CCC', stintNumber: 2, compound: 'HARD', life: 4, kind: 'dropped' },
    ]);
    expect(end.filter((o) => o.kind === 'censored').map((o) => o.driver)).toEqual(['AAA', 'BBB']);
    // at lap 9 (leader at the end of lap 8; CCC, 2 s behind, has completed lap 7) CCC is
    // still running: censored at the TyreLife of its out-lap, not dropped
    const now = resolveSessionNow({ currentLap: 9, lapTimes: rows });
    const mid = stintLifeObservations(rows, { sessionNow: now });
    expect(mid.find((o) => o.driver === 'CCC' && o.stintNumber === 2)).toMatchObject({ kind: 'censored', life: 1 });
  });

  it('sampleStintEnd: conditional on the age reached; truncated when a stop must happen', () => {
    const S = [1, 1, 0.75, 0.5, 0.5, 0.25, 0];
    expect(sampleStintEnd(S, 0, 0.9)).toBe(2);
    expect(sampleStintEnd(S, 0, 0.6)).toBe(3);
    expect(sampleStintEnd(S, 3, 0.9)).toBe(5); // S(5)/S(3) = 0.5 <= 0.9
    expect(sampleStintEnd(S, 6, 0.5)).toBe(null); // older than every life in the table
    expect(sampleStintEnd([1, 1, 1], 0, 0.5)).toBe(Infinity);
    for (const u of [0.01, 0.5, 0.99]) {
      const t = sampleStintEnd(S, 2, u, 4);
      expect(t).toBeGreaterThan(2);
      expect(t).toBeLessThanOrEqual(4);
    }
    expect(stintLifeFor({}, 'SOFT').source).toBe('prior');
  });

  it('an optional stop leaving fewer than OPTIONAL_STOP_MIN_LAPS_LEFT laps is never taken', () => {
    // sets due every 5 laps; no lap rows, so the two-compound rule is not known: every stop optional
    const due5 = { survival: [1, 1, 1, 1, 1, 0, ...new Array(STINT_LIFE_MAX - 5).fill(0)], n: 5, source: 'race' };
    const params = flatParams({ stintLength: { SOFT: due5, MEDIUM: due5, HARD: due5 } });
    const features = { A: { ...FEATURES.A, tyreLife: 3 }, B: { ...FEATURES.B, tyreLife: 3 } };
    const { sims } = runSimulations({
      driverFeatures: features, currentLap: 10, maxLap: 50, raceParams: params, seed: 3, numSimulations: 50,
    });
    // tyre age 3 now, every set due at age 5: stops at the end of laps 11, 16, 21, 26, 31
    // (laps left 39 ... 19); the set due on lap 36 would leave 14 < 18 laps: it runs to the flag
    expect(OPTIONAL_STOP_MIN_LAPS_LEFT).toBe(PRIORS.optionalStops.lapsLeftQ25);
    expect(OPTIONAL_STOP_MIN_LAPS_LEFT).toBe(18);
    for (const sim of sims) expect(sim.A.stops).toBe(5);
    const late = runSimulations({
      driverFeatures: features, currentLap: 40, maxLap: 50, raceParams: params, seed: 3, numSimulations: 50,
    });
    for (const sim of late.sims) expect(sim.A.stops).toBe(0);
  });
});

describe('S8 safety car: episodes started by sessionNow, labelled prior', () => {
  const rows = race({ n: 14 });
  const ts = [
    { status: '1', start_time: 900, end_time: 1350, message: 'AllClear' },
    { status: '6', start_time: 1350, end_time: 1420, message: 'VSCDeployed' },
    { status: '7', start_time: 1420, end_time: 1440, message: 'VSCEnding' },
    { status: '1', start_time: 1440, end_time: 1600, message: 'AllClear' },
    { status: '4', start_time: 1600, end_time: 1800, message: 'SCDeployed' },
    { status: '1', start_time: 1800, end_time: null, message: 'AllClear' },
  ];
  const prior = PRIORS.safetyCar;
  const w = SC_PRIOR_WEIGHT_RACES;

  it('a VSC deploy + ending is one episode; a green flag between two neutralisations makes two', () => {
    const eps = neutralEpisodes(ts, rows, Infinity);
    expect(eps.map((e) => e.type)).toEqual(['VSC', 'SC']);
    const sc = safetyCarEstimate(ts, rows, { sessionNow: Infinity });
    expect(sc.episodes).toBe(2);
    expect(sc.scEpisodes).toBe(1);
    expect(sc.source).toBe('race');
    expect(sc.rate).toBeCloseTo((prior.episodesPerRace * w + 2) / (prior.lapsPerRace * w + 14), 12);
  });

  it('a future SC leaves the rate unchanged; before any episode the rate is the labelled prior', () => {
    const now = 1500; // after the VSC, before the SC
    const known = safetyCarEstimate(ts.slice(0, 4), rows, { sessionNow: now });
    const withFuture = safetyCarEstimate(ts, rows, { sessionNow: now });
    expect(withFuture).toEqual(known);
    expect(withFuture.episodes).toBe(1);
    const early = safetyCarEstimate(ts, rows, { sessionNow: 1300 });
    expect(early.source).toBe('prior');
    expect(early.episodes).toBe(0);
    expect(early.rate).toBeCloseTo((prior.episodesPerRace * w) / (prior.lapsPerRace * w + early.laps), 12);
    // the same through extractRaceParams (scRate)
    const p = extractRaceParams(rows, [], ts, 14, { sessionNow: now });
    const q = extractRaceParams(rows, [], ts.slice(0, 4), 14, { sessionNow: now });
    expect(p.scRate).toBe(q.scRate);
    expect(p.estimates.safetyCar).toEqual(q.estimates.safetyCar);
  });
});

describe('S9 lap model: wear counted once, trend resets at a stop', () => {
  it('projectedLapTime: deg 0 and trend 0 give a flat pace', () => {
    const laps = [];
    for (let age = 3; age <= 40; age++) {
      laps.push(projectedLapTime({ basePace: 91.2, refAge: 7, refDeg: 0, deg: 0, tyreAge: age }));
    }
    expect(new Set(laps).size).toBe(1);
    expect(laps[0]).toBe(91.2);
    const proj = projectLapTimes({
      raceParams: flatParams(), compound: 'MEDIUM', tyreAge: 5, basePace: 90, fromLap: 10, toLap: 30,
    });
    expect(proj.every((l) => l.lapTime === 90)).toBe(true);
  });

  it('Monte Carlo with deg 0, trend 0, no noise and no stop: every projected lap is the base pace', () => {
    const { sims } = runSimulations({
      driverFeatures: FEATURES, currentLap: 10, maxLap: 30, raceParams: flatParams(), seed: 1, numSimulations: 20,
    });
    for (const sim of sims) {
      expect(sim.A.time).toBe(21 * 90);
      expect(sim.B.time).toBe(3 + 21 * 90.5);
    }
  });

  it('the current wear is in the base pace once: lap = basePace + deg x (tyreAge - refAge)', () => {
    const deg = { mean: 0.1, median: 0.1, stdDev: 0, n: 5, negativeCount: 0, source: 'race' };
    const { sims } = runSimulations({
      driverFeatures: FEATURES, currentLap: 10, maxLap: 30,
      raceParams: flatParams({ tyreDeg: { MEDIUM: deg } }), seed: 1, numSimulations: 5,
    });
    // tyre age 5 now; laps 10..30 run at ages 6..26: 0.1 x (1 + ... + 21) = 23.1 s of added wear
    for (const sim of sims) expect(sim.A.time).toBeCloseTo(21 * 90 + 0.1 * 231, 9);
  });

  it('the trend (useTrend) applies to the current stint only and resets at a stop', () => {
    const plan = { A: [{ lap: 15, compound: 'HARD' }] };
    const common = {
      driverFeatures: FEATURES, currentLap: 10, maxLap: 30, raceParams: flatParams(), seed: 9, numSimulations: 20,
    };
    const trend = FEATURES.A.paceTrend - (0 - FUEL_EFFECT_S_PER_LAP); // in excess of deg - fuel burn
    const withT = runSimulations({ ...common, plans: plan, useTrend: true }).sims;
    const without = runSimulations({ ...common, plans: plan }).sims;
    // laps 10..15 carry 1..6 laps of trend, none after the stop at the end of lap 15
    withT.forEach((sim, i) => expect(sim.A.time - without[i].A.time).toBeCloseTo(trend * 21, 9));
    const noStopT = runSimulations({ ...common, plans: { A: [] }, useTrend: true }).sims;
    const noStop = runSimulations({ ...common, plans: { A: [] } }).sims;
    noStopT.forEach((sim, i) => expect(sim.A.time - noStop[i].A.time).toBeCloseTo(trend * 231, 9));
  });

  it('the fresh-tyre delta applies to the first flying lap of a new set only', () => {
    const plan = { A: [{ lap: 20, compound: 'HARD' }] };
    const common = { driverFeatures: FEATURES, currentLap: 10, maxLap: 30, seed: 4, numSimulations: 20, plans: plan };
    const a = runSimulations({ ...common, raceParams: flatParams({ freshDelta: -0.5 }) }).sims;
    const b = runSimulations({ ...common, raceParams: flatParams() }).sims;
    a.forEach((sim, i) => expect(sim.A.time - b[i].A.time).toBeCloseTo(-0.5, 12));
  });
});

describe('S8 in the simulation: an SC in progress at now', () => {
  const ongoing = (startLap) => flatParams({
    estimates: {
      safetyCar: {
        rate: 0, scShare: 0, durations: { SC: [2], VSC: [] }, scGapRatio: PRIORS.safetyCar.scGapRatio,
        ongoing: { type: 'SC', startLap },
      },
    },
  });
  const run = (startLap) => runSimulations({
    driverFeatures: FEATURES, currentLap: 10, maxLap: 30, raceParams: ongoing(startLap), seed: 2, numSimulations: 5,
  }).sims;

  it('compresses the gaps while the latest lap is one of its first SC_BUNCHED_AFTER_LAPS - 1 laps', () => {
    // deployed on lap 9: lap 10 is neutralised (2 - 1 laps left), the 3 s gap shrinks to 3 x ratio,
    // then 20 green laps at 90 / 90.5 s
    for (const sim of run(9)) {
      expect(sim.B.time - sim.A.time).toBeCloseTo(3 * PRIORS.safetyCar.scGapRatio + 0.5 * 20, 9);
    }
    // deployed on lap 5: the gaps of lap 9 already show the bunching, no second compression
    for (const sim of run(5)) expect(sim.B.time - sim.A.time).toBeCloseTo(3 + 0.5 * 20, 9);
  });
});

describe('S10 identifyRisks: high risks first', () => {
  it('a high risk listed after five medium ones is kept and comes first', () => {
    const projections = [];
    const features = {};
    for (let i = 0; i < 6; i++) {
      const d = `D${i}`;
      projections.push({ driver: d, posRange: [1, 6], pitStopsRemaining: { mean: 0.6 } }); // spread 5: medium
      features[d] = { paceTrend: 0, tyreLife: 1, compoundName: 'MEDIUM' };
    }
    projections.push({ driver: 'HI', posRange: [3, 4], pitStopsRemaining: { mean: 2 } }); // EXTRA STOP: high
    features.HI = { paceTrend: 0, tyreLife: 1, compoundName: 'MEDIUM' };
    const params = { pitLoss: { median: 22, source: 'race' }, tyreDeg: {}, stintLength: {} };
    const risks = identifyRisks(projections, features, params, 20, 50);
    expect(risks.length).toBe(5);
    expect(risks[0]).toMatchObject({ driver: 'HI', type: 'EXTRA STOP', severity: 'high' });
    expect(risks.slice(1).every((r) => r.severity === 'medium')).toBe(true);
  });
});

describe('S4 engine: seeded, deterministic, worker-safe', () => {
  const rows = race();
  const features = extractRaceSituationFeatures({ lapTimes: rows, currentLap: 12, dnfMap: {} }).driverFeatures;
  const args = { driverFeatures: features, currentLap: 12, maxLap: 30, lapTimes: rows, trackStatus: [] };

  it('same seed, same result; another seed, other draws; default 1,000 runs', () => {
    const a = simulateRaceFinish({ ...args, seed: 123 });
    const b = simulateRaceFinish({ ...args, seed: 123 });
    expect(b).toEqual(a);
    expect(a.numSimulations).toBe(DEFAULT_NUM_SIMULATIONS);
    expect(DEFAULT_NUM_SIMULATIONS).toBe(1000);
    const sa = runSimulations({ ...args, raceParams: a.raceParams, seed: 1, numSimulations: 50 }).sims;
    const sb = runSimulations({ ...args, raceParams: a.raceParams, seed: 2, numSimulations: 50 }).sims;
    expect(sa.map((s) => s.AAA.time)).not.toEqual(sb.map((s) => s.AAA.time));
    // without a seed: derived from the state, so still the same result twice
    expect(simulateRaceFinish(args)).toEqual(simulateRaceFinish(args));
  });

  it('plain-data inputs and outputs (structured clone); running as a list = as a function', () => {
    const res = simulateRaceFinish({ ...args, seed: 5, numSimulations: 200 });
    expect(structuredClone(res)).toEqual(res);
    const asList = simulateRaceFinish({ ...args, seed: 5, numSimulations: 200, running: ['AAA', 'BBB', 'CCC'] });
    const asFn = simulateRaceFinish({ ...args, seed: 5, numSimulations: 200, running: () => true });
    expect(asList).toEqual(asFn);
  });
});

describe('S6 engine: plans, sampled pit loss, common random numbers', () => {
  it('every planned stop is made in every sim and charged a sampled pit loss', () => {
    const common = { driverFeatures: FEATURES, currentLap: 10, maxLap: 30, raceParams: flatParams(), seed: 8, numSimulations: 1000 };
    const one = runSimulations({ ...common, plans: { A: [{ lap: 20, compound: 'HARD' }] } }).sims;
    const none = runSimulations({ ...common, plans: { A: [] } }).sims;
    const d = one.map((sim, i) => sim.A.time - none[i].A.time);
    expect(one.every((sim) => sim.A.stops === 1)).toBe(true);
    const m = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1));
    expect(Math.abs(m - 22)).toBeLessThan(0.2); // pitLoss median 22, sd 2
    expect(Math.abs(sd - 2)).toBeLessThan(0.2);
    // the other driver's draws are untouched by A's plan (no safety car here)
    one.forEach((sim, i) => expect(sim.B.time).toBe(none[i].B.time));
  });

  it('plans at laps already run or on the last lap are ignored', () => {
    const common = { driverFeatures: FEATURES, currentLap: 10, maxLap: 30, raceParams: flatParams(), seed: 8, numSimulations: 10 };
    const sims = runSimulations({ ...common, plans: { A: [{ lap: 5, compound: 'HARD' }, { lap: 30, compound: 'SOFT' }] } }).sims;
    expect(sims.every((sim) => sim.A.stops === 0)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16, cached): done-when checks', () => {
  const s = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16) : null;
  const lapTimes = s?.lap_times || [];
  const maxLap = s ? maxLapOf(lapTimes) : 0;
  const project = (lap, seed = 77) => {
    const f = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {} });
    return {
      features: f.driverFeatures,
      res: simulateRaceFinish({
        driverFeatures: f.driverFeatures, currentLap: lap, maxLap, lapTimes, trackStatus: s.track_status, seed,
      }),
    };
  };

  it('S1: freshDelta <= 0 and |freshDelta| < 1 s (race over), from the race', () => {
    const p = extractRaceParams(lapTimes, [], s.track_status, maxLap, { sessionNow: Infinity });
    expect(p.freshDelta).toBeLessThanOrEqual(0);
    expect(Math.abs(p.freshDelta)).toBeLessThan(1);
    expect(p.estimates.freshDelta).toMatchObject({ source: 'race', n: 22, clamped: false });
    expect(p.freshDelta).toBeCloseTo(-0.029, 3);
  });

  it('S2: at every lap-mode projection clock (the leader starts lap 5 .. the last but one) MEDIUM and HARD degradation > 0 after fuel correction; lap noise 0.3-0.6 s at the leader\'s laps 20, 30, 40 and the race end (D1)', () => {
    let clocks = 0;
    let raceClocks = 0;
    const noise = {};
    for (let lap = 5; lap < maxLap; lap++) {
      const now = resolveSessionNow({ currentLap: lap, lapTimes });
      const q = extractRaceParams(lapTimes, [], s.track_status, lap, { sessionNow: now, sessionType: 'R' });
      const m = degradationFor(q, 'MEDIUM');
      expect(m.mean).toBeGreaterThan(0);
      expect(degradationFor(q, 'HARD').mean).toBeGreaterThan(0);
      noise[lap] = q.estimates.lapNoise;
      clocks += 1;
      if (m.source === 'race') raceClocks += 1;
    }
    expect(clocks).toBe(48);
    expect(raceClocks).toBe(38); // the race's own MEDIUM fits from lap 15 on
    const atEnd = extractRaceParams(lapTimes, [], s.track_status, maxLap, { sessionNow: Infinity }).estimates.lapNoise;
    for (const e of [noise[20], noise[30], noise[40], atEnd]) {
      expect(e.source).toBe('race');
      expect(e.value).toBeGreaterThanOrEqual(0.3);
      expect(e.value).toBeLessThanOrEqual(0.6);
    }
    // values of docs/evidence/s2_lap_noise_monza.txt (scripts/s2_lap_noise.mjs)
    expect([noise[20], noise[30], noise[40], atEnd].map((e) => +e.value.toFixed(3))).toEqual([0.436, 0.402, 0.381, 0.401]);
    expect([noise[20], noise[30], noise[40], atEnd].map((e) => e.laps)).toEqual([255, 463, 598, 889]);
    // earlier clocks: the causal value with its n, no floor (lap 10: one stint of 8 laps)
    expect(noise[10]).toMatchObject({ source: 'race', laps: 8, stints: 1 });
    expect(+noise[10].value.toFixed(3)).toBe(0.163);
    expect(noise[9]).toMatchObject({ source: 'prior', laps: 0, value: PRIORS.lapNoise.dry.value });
    // lap 12 (the clock of the S3 / S7 checks): a set does not get faster with age on the lap model
    const now12 = resolveSessionNow({ currentLap: 12, lapTimes });
    const p12 = extractRaceParams(lapTimes, [], s.track_status, 12, { sessionNow: now12, sessionType: 'R' });
    for (const c of ['MEDIUM', 'HARD']) {
      const laps = projectLapTimes({ raceParams: p12, compound: c, tyreAge: 9, basePace: 85, refAge: 10, fromLap: 12, toLap: 40 });
      expect(laps.at(-1).lapTime).toBeGreaterThan(laps[0].lapTime);
    }
    // race over: every fit kept as a diagnostic (18 MEDIUM fits, 9 negative); MEDIUM > 0
    const p = extractRaceParams(lapTimes, [], s.track_status, maxLap, { sessionNow: Infinity });
    expect(p.tyreDeg.MEDIUM.allFits).toMatchObject({ n: 18, negativeCount: 9 });
    expect(p.tyreDeg.MEDIUM.mean).toBeGreaterThan(0);
    expect(p.tyreDeg.HARD.allFits).toMatchObject({ n: 29, negativeCount: 11 });
    // lap noise = the drivers' consistency sums pooled (same per-stint residuals), nothing else
    for (const now of [Infinity, resolveSessionNow({ currentLap: 30, lapTimes })]) {
      const q = extractRaceParams(lapTimes, [], s.track_status, 30, { sessionNow: now });
      let sse = 0;
      let dof = 0;
      for (const d of new Set(lapTimes.map((x) => x.Driver))) {
        const c = consistencySigma(lapTimes, d, { sessionNow: now });
        if (c.sigma == null) continue;
        sse += c.sigma * c.sigma * (c.n - 2 * c.stints);
        dof += c.n - 2 * c.stints;
      }
      expect(q.lapNoise).toBeCloseTo(Math.sqrt(sse / dof), 9);
      expect(q.estimates.lapNoise.raceValue).toBe(q.lapNoise);
    }
  });

  it('S3: lap 12, every driver\'s median remaining stops <= 2; the dry-race stop is always made', () => {
    const { res } = project(12);
    for (const p of res.projections) expect(p.pitStopsRemaining.median).toBeLessThanOrEqual(2);
    const now = resolveSessionNow({ currentLap: 12, lapTimes });
    const stopped = new Set(pitStops(lapTimes, { sessionNow: now }).map((x) => x.Driver));
    const f = extractRaceSituationFeatures({ lapTimes, currentLap: 12, dnfMap: {} });
    const { sims } = runSimulations({
      driverFeatures: f.driverFeatures, currentLap: 12, maxLap, lapTimes, raceParams: res.raceParams, seed: 77, numSimulations: 300,
    });
    for (const d of Object.keys(f.driverFeatures)) {
      if (stopped.has(d)) continue; // one compound so far: must stop once before the flag
      expect(sims.every((sim) => sim[d].stops >= 1)).toBe(true);
    }
  });

  it('S3: lap 39, one-stoppers who have made their only stop project ~0 remaining stops', () => {
    const { res } = project(39);
    const now = resolveSessionNow({ currentLap: 39, lapTimes });
    const total = {};
    const made = {};
    for (const p of pitStops(lapTimes)) total[p.Driver] = (total[p.Driver] || 0) + 1;
    for (const p of pitStops(lapTimes, { sessionNow: now })) made[p.Driver] = (made[p.Driver] || 0) + 1;
    const one = res.projections.filter((p) => total[p.driver] === 1 && made[p.driver] === 1);
    expect(one.map((p) => p.driver).sort()).toEqual(['ALB', 'BOT', 'COL', 'LEC', 'MAG', 'OCO', 'RIC', 'SAI', 'ZHO']);
    for (const p of one) {
      expect(p.pitStopsRemaining.median).toBe(0);
      expect(p.pitStopsRemaining.mean).toBeLessThanOrEqual(0.15);
    }
  });

  it('S6: identical plan -> every difference exactly 0; different plans differ', () => {
    const f = extractRaceSituationFeatures({ lapTimes, currentLap: 12, dnfMap: {} });
    const base = {
      driverFeatures: f.driverFeatures, currentLap: 12, maxLap, lapTimes, trackStatus: s.track_status,
      focusDriver: 'LEC', seed: 7,
    };
    const same = compareStrategies({ ...base, plan: [{ lap: 15, compound: 'HARD' }], basePlan: [{ lap: 15, compound: 'HARD' }] });
    expect(same.delta).toEqual({ position: 0, podium: 0, points: 0 });
    expect(same.paired).toEqual({ meanPositionChange: 0, probGain: 0, probLoss: 0, probSame: 1, meanTimeDelta: 0 });
    expect(same.planResult).toEqual(same.baselineResult);
    const noPlan = compareStrategies(base);
    expect(noPlan.paired.meanTimeDelta).toBe(0);
    const late = compareStrategies({ ...base, plan: [{ lap: 25, compound: 'HARD' }], basePlan: [{ lap: 15, compound: 'HARD' }] });
    expect(late.paired.meanTimeDelta).not.toBe(0);
    expect(late.plan.expectedPos).not.toBe(late.baseline.expectedPos);
  });

  it('every estimate is causal at lap 30 (rows not known yet perturbed, future track status added)', () => {
    const now = resolveSessionNow({ currentLap: 30, lapTimes });
    const a = extractRaceParams(lapTimes, [], s.track_status, 30);
    const future = [...s.track_status, { status: '4', start_time: now + 300, end_time: now + 700, message: 'SCDeployed' }];
    const b = extractRaceParams(perturbFuture(lapTimes, now), [], future, 30);
    expect(b).toEqual(a);
  });
});

describe.skipIf(!hasCachedSession(2024, 5))('China 2024 (R5, cached): S8 at lap 30', () => {
  it('two episodes started by lap 30 (VSC + SC on lap 22, SC on lap 27); a future SC changes nothing', () => {
    const s = loadCachedSession(2024, 5);
    const lapTimes = s.lap_times;
    const p = extractRaceParams(lapTimes, [], s.track_status, 30);
    const sc = p.estimates.safetyCar;
    expect(sc).toMatchObject({ episodes: 2, scEpisodes: 2, laps: 29, source: 'race' });
    expect(sc.ongoing).toMatchObject({ type: 'SC', startLap: 27 });
    expect(p.scRate).toBeCloseTo((PRIORS.safetyCar.episodesPerRace + 2) / (PRIORS.safetyCar.lapsPerRace + 29), 12);
    const now = resolveSessionNow({ currentLap: 30, lapTimes });
    const future = [...s.track_status, { status: '4', start_time: now + 600, end_time: now + 900, message: 'SCDeployed' }];
    const q = extractRaceParams(lapTimes, [], future, 30);
    expect(q.scRate).toBe(p.scRate);
    expect(q.estimates.safetyCar).toEqual(sc);
  });
});
