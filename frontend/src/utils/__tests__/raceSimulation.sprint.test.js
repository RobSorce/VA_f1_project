// The strategy simulation forced a pit stop in a sprint. The engine's
// mandatory stop (a dry race: two dry compounds, so at least one stop)
// ignored the session type, while a sprint has no mandatory stop and no
// compound obligation. Now extractRaceParams carries mandatoryStop
// (pitLoss.js hasMandatoryStop: a race, not a sprint) and the engine forces
// the stop only when it is true. Same rows, same seed: the race keeps the
// forced stop, the sprint has none.
import { describe, it, expect } from 'vitest';
import { extractRaceParams, runSimulations, simulateRaceFinish, STINT_LIFE_MAX } from '../raceSimulation.js';
import { hasMandatoryStop, isRaceSession } from '../pitLoss.js';
import { likelyNextCompound } from '../undercut.js';

const DRIVERS = ['AAA', 'BBB', 'CCC'];
const LAPS_DONE = 12;
const CURRENT_LAP = 13;
const MAX_LAP = 19;

// Twelve dry laps on one compound (MEDIUM, no stop yet): in a race each
// driver still owes a second dry compound
function rows() {
  const out = [];
  DRIVERS.forEach((drv, i) => {
    for (let k = 1; k <= LAPS_DONE; k++) {
      const start = 1000 + (k - 1) * 100 + i;
      const t = 90 + i * 0.2 + 0.05 * k + (k === 1 ? 5 : 0);
      out.push({
        Driver: drv, LapNumber: k, LapStartTime: start, TrackStatus: '1', Position: i + 1, Stint: 1,
        Compound: 'MEDIUM', TyreLife: k, PitInTimeSeconds: null, PitOutTimeSeconds: null, GapToLeader: i * 2,
        LapTimeSeconds: t, Time: start + t,
      });
    }
  });
  return out;
}

const FEATURES = Object.fromEntries(DRIVERS.map((d, i) => [d, {
  position: i + 1, gapToLeader: i * 2, recentPace: 90, tyreLife: LAPS_DONE, compoundName: 'MEDIUM',
}]));

// Sets never due on their own: the only stop left is the mandatory one
const NEVER = { survival: new Array(STINT_LIFE_MAX + 1).fill(1), median: Infinity, mean: STINT_LIFE_MAX, n: 5, source: 'race' };

function stopsIn(sessionType) {
  const lapTimes = rows();
  const p = extractRaceParams(lapTimes, [], [], CURRENT_LAP, { sessionNow: Infinity, sessionType });
  const raceParams = { ...p, stintLength: { SOFT: NEVER, MEDIUM: NEVER, HARD: NEVER } };
  const { sims } = runSimulations({
    driverFeatures: FEATURES, currentLap: CURRENT_LAP, maxLap: MAX_LAP, lapTimes, raceParams, seed: 5, numSimulations: 200,
  });
  return { p, stops: DRIVERS.map((d) => sims.filter((s) => s[d].stops >= 1).length), runs: sims.length };
}

describe('No mandatory stop in a sprint', () => {
  it('hasMandatoryStop: a race (or no session type), not a sprint; pit loss still applies to both', () => {
    for (const t of ['R', 'r', ' R ', undefined, null, '']) expect(hasMandatoryStop(t), String(t)).toBe(true);
    for (const t of ['S', 's', 'Q', 'FP2']) expect(hasMandatoryStop(t), String(t)).toBe(false);
    expect(isRaceSession('S')).toBe(true);
  });

  it('extractRaceParams carries it: mandatoryStop true for a race, false for a sprint', () => {
    expect(stopsIn('R').p.mandatoryStop).toBe(true);
    expect(stopsIn(undefined).p.mandatoryStop).toBe(true);
    expect(stopsIn('S').p.mandatoryStop).toBe(false);
  });

  it('a race keeps the forced stop: every run of every driver stops once', () => {
    for (const t of ['R', undefined]) {
      const { stops, runs } = stopsIn(t);
      expect(stops, String(t)).toEqual(DRIVERS.map(() => runs));
    }
  });

  it('a sprint with the same rows and seed: no forced stop in any run', () => {
    const { stops, p } = stopsIn('S');
    expect(stops).toEqual(DRIVERS.map(() => 0));
    // the pit loss of a sprint is still a race pit loss (a stop made is charged)
    expect(p.pitLoss.source).not.toBe('not-applicable');
  });

  it('the projection of a sprint (simulateRaceFinish with sessionType S) projects no remaining stop', () => {
    const lapTimes = rows();
    const given = { ...extractRaceParams(lapTimes, [], [], CURRENT_LAP, { sessionNow: Infinity, sessionType: 'S' }),
      stintLength: { SOFT: NEVER, MEDIUM: NEVER, HARD: NEVER } };
    const res = simulateRaceFinish({
      driverFeatures: FEATURES, currentLap: CURRENT_LAP, maxLap: MAX_LAP, lapTimes, raceParams: given, seed: 5, numSimulations: 200,
    });
    for (const p of res.projections) expect(p.pitStopsRemaining.mean, p.driver).toBe(0);
  });
  it('the undercut tools follow the same rule: no compound obligation in a sprint', () => {
    const race = { dryRace: true, mandatoryStop: true, transitions: { MEDIUM: { MEDIUM: 9 } } };
    const sprint = { ...race, mandatoryStop: false };
    // in a race the second dry compound is owed, so the most fitted MEDIUM -> MEDIUM is not allowed
    expect(likelyNextCompound(race, 'MEDIUM', ['MEDIUM'])).not.toBe('MEDIUM');
    expect(likelyNextCompound(sprint, 'MEDIUM', ['MEDIUM'])).toBe('MEDIUM');
  });
});
