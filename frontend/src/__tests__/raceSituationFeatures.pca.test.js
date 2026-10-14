// PCA inputs of the Race Situation Map (utils/raceSituationFeatures.js, P12):
// measured quantities only (no ordinal compound, no feature derived from the
// others), the laps to the stop from the race's stint-life survival, and the
// pace from clean racing laps (not lap 1, green). Data-dependent blocks skip
// when their cached race is absent.
import { describe, it, expect } from 'vitest';
import {
  extractRaceSituationFeatures, FEATURE_NAMES, isPaceLap, estimatedLapsToPit,
} from '../utils/raceSituationFeatures.js';
import { standardize, covarianceMatrix } from '../utils/livePCA.js';
import { stintLifeEstimate, conditionalMedianLife } from '../utils/raceSimulation.js';
import { resolveSessionNow, completedLaps } from '../utils/raceTime.js';
import { hasCachedSession, loadCachedSession, listCachedRaces } from './helpers/cachedSession.js';

/** Largest |r| between two non-constant columns of X, with the pair. */
function maxAbsCorrelation(X) {
  const live = X[0].map((_, j) => X.some((row) => row[j] !== X[0][j]));
  const idx = live.map((v, j) => (v ? j : -1)).filter((j) => j >= 0);
  const { standardized } = standardize(X.map((row) => idx.map((j) => row[j])));
  const C = covarianceMatrix(standardized);
  let worst = { r: 0, pair: null };
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      if (Math.abs(C[a][b]) > worst.r) worst = { r: Math.abs(C[a][b]), pair: [FEATURE_NAMES[idx[a]], FEATURE_NAMES[idx[b]]] };
    }
  }
  return worst;
}

function everyLap(lapTimes, fn) {
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  for (let lap = 3; lap <= maxLap; lap++) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
    if (res) fn(res, lap, now);
  }
}

// Synthetic race on the SESSION clock, every lap green unless set
const T0 = 1000;
function syntheticRace({ drivers = ['AAA', 'BBB', 'CCC', 'DDD'], n = 10, status = () => '1' } = {}) {
  const rows = [];
  drivers.forEach((drv, i) => {
    for (let k = 1; k <= n; k++) {
      const start = T0 + (k - 1) * 100 + i;
      const t = (k === 1 ? 99 : 90) + i * 0.3 + (k % 4) * 0.2 + (status(k) === '1' ? 0 : 25);
      rows.push({
        Driver: drv, LapNumber: k, LapStartTime: start, Time: start + t, LapTimeSeconds: t,
        TrackStatus: status(k), Position: i + 1, GapToLeader: i * 1.5 + k * 0.05,
        Stint: 1, Compound: i % 2 ? 'HARD' : 'MEDIUM', TyreLife: k + i,
        PitInTimeSeconds: null, PitOutTimeSeconds: null,
      });
    }
  });
  return rows;
}

describe('PCA inputs: measured quantities only (P12)', () => {
  it('no ordinal compound, no predicted pace (recent pace + 5 x trend), no laps-to-pit (compound + age)', () => {
    expect(FEATURE_NAMES).toEqual([
      'position', 'gap_to_leader', 'recent_pace', 'pace_trend', 'tyre_life', 'stint_number', 'position_trend',
    ]);
    const res = extractRaceSituationFeatures({ lapTimes: syntheticRace(), currentLap: 9, dnfMap: {} });
    expect(res.matrix[0].length).toBe(FEATURE_NAMES.length);
    for (const d of res.driverAbbrs) {
      const f = res.driverFeatures[d];
      // still served to the other views, out of the matrix
      expect(f.compoundName).toMatch(/MEDIUM|HARD/);
      expect(Number.isFinite(f.predictedPace5)).toBe(true);
      expect(Number.isFinite(f.estLapsToPit)).toBe(true);
      expect(f).not.toHaveProperty('compoundNum');
      expect(res.matrix[res.driverAbbrs.indexOf(d)]).toEqual([
        f.position, f.gapToLeader, f.recentPace, f.paceTrend, f.tyreLife, f.stintNumber, f.positionTrend,
      ]);
    }
  });

  it('pace from clean laps: lap 1 and a non-green lap are not in recent pace / pace trend', () => {
    const rows = syntheticRace({ status: (k) => (k === 7 ? '4' : '1') });
    const res = extractRaceSituationFeatures({ lapTimes: rows, currentLap: 10, dnfMap: {} });
    const now = resolveSessionNow({ currentLap: 10, lapTimes: rows });
    for (const d of res.driverAbbrs) {
      const laps = completedLaps(rows, now).filter((r) => r.Driver === d).sort((a, b) => a.LapNumber - b.LapNumber);
      const clean = laps.filter(isPaceLap);
      expect(clean.map((r) => r.LapNumber)).not.toContain(1);
      expect(clean.map((r) => r.LapNumber)).not.toContain(7);
      const last3 = clean.slice(-3);
      expect(res.driverFeatures[d].paceLaps).toBe('clean');
      expect(res.driverFeatures[d].recentPace).toBeCloseTo(last3.reduce((s, r) => s + r.LapTimeSeconds, 0) / 3, 12);
    }
    expect(res.paceInPca).toBe(true);
  });

  it('until every driver has 2 clean laps: the field\'s non-pit laps, every driver kept, pace out of the fit', () => {
    // Safety car on laps 1-4: nobody has a clean lap at currentLap 5
    const rows = syntheticRace({ status: (k) => (k <= 4 ? '4' : '1') });
    const res = extractRaceSituationFeatures({ lapTimes: rows, currentLap: 5, dnfMap: {} });
    expect(res.driverAbbrs.length).toBe(4);
    expect(res.paceInPca).toBe(false);
    for (const d of res.driverAbbrs) {
      expect(res.driverFeatures[d].paceLaps).toBe('field');
      expect(Number.isFinite(res.driverFeatures[d].recentPace)).toBe(true);
    }
    const j = FEATURE_NAMES.indexOf('recent_pace');
    const k = FEATURE_NAMES.indexOf('pace_trend');
    expect(res.matrix.every((row) => row[j] === 0 && row[k] === 0)).toBe(true);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16, cached)', () => {
  const lapTimes = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];

  it('no duplicated loadings: no two inputs with |r| >= 0.999 on any lap', () => {
    let laps = 0;
    everyLap(lapTimes, (res, lap) => {
      laps += 1;
      const w = maxAbsCorrelation(res.matrix);
      expect(w.r, `lap ${lap} ${w.pair}`).toBeLessThan(0.999);
    });
    expect(laps).toBeGreaterThan(45);
  });

  it('laps to the stop = conditional median life of the race\'s survival - tyre age (MEDIUM sets ran 5-19 laps, not 28)', () => {
    const now = resolveSessionNow({ currentLap: 10, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: 10, dnfMap: {}, sessionNow: now });
    const life = stintLifeEstimate(lapTimes, { sessionNow: now, dnfMap: {} });
    for (const d of res.driverAbbrs) {
      const f = res.driverFeatures[d];
      const due = conditionalMedianLife(life[f.compoundName].survival, f.tyreLife);
      expect(f.estLapsToPit).toBe(due - f.tyreLife);
      expect(f.estLapsToPitSource).toBe('race');
      expect(estimatedLapsToPit(life, f.compoundName, f.tyreLife)).toEqual({ laps: f.estLapsToPit, source: 'race' });
    }
    // LEC: MEDIUM, 8 laps old -> 17 more laps (the removed table said 28 - 8 = 20)
    expect(res.driverFeatures.LEC).toMatchObject({ compoundName: 'MEDIUM', tyreLife: 8, estLapsToPit: 17 });
  });

  it('every lap in the field uses clean laps for the pace from lap 5', () => {
    everyLap(lapTimes, (res, lap) => {
      if (lap >= 5) expect(res.paceInPca, `lap ${lap}`).toBe(true);
    });
  });
});

const races = listCachedRaces();
describe.skipIf(races.length === 0)('every cached race', () => {
  it('no exact linear relation between two inputs on any lap (|r| < 0.9999)', () => {
    for (const race of races) {
      const { lap_times: lapTimes } = loadCachedSession(race.year, race.round);
      everyLap(lapTimes, (res, lap) => {
        const w = maxAbsCorrelation(res.matrix);
        expect(w.r, `${race.year} R${race.round} lap ${lap} ${w.pair}`).toBeLessThan(0.9999);
      });
    }
  });
});
