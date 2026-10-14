import { describe, it, expect } from 'vitest';
import { computePriors, roundPriors, PRIORS } from '../raceSimulation.js';
import { listCachedRaces, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';

// PRIORS in raceSimulation.js were measured over the cached races by
// scripts/mc_benchmark.mjs. With the same cache, recomputing them gives the
// same numbers. A cache with other races (or none: fresh clone) skips.
const races = listCachedRaces();

describe.skipIf(races.length !== PRIORS.races)('PRIORS = computePriors over the cached races', () => {
  it('every prior in the code is the measured value (rounded as printed by the script)', () => {
    const sessions = races.map(({ year, round }) => {
      const s = loadCachedSession(year, round);
      return { lapTimes: s.lap_times, trackStatus: s.track_status };
    });
    const measured = roundPriors(computePriors(sessions));
    expect(measured).toEqual(JSON.parse(JSON.stringify(PRIORS)));
  }, 60000);
});
