// R7 for the Monte Carlo jobs: the store passes the type of the session on
// screen, and outside race sessions ('R', 'S') it never starts a projection or
// a what-if, so no race pit-loss logic runs on practice or qualifying laps.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/raceSimulation', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, simulateRaceFinish: vi.fn((...args) => orig.simulateRaceFinish(...args)) };
});

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { simulateRaceFinish } = await import('../utils/raceSimulation');
const { useF1Store, simulationJob } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const store = () => useF1Store.getState();
const INITIAL = store();
const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;

function at(lap, extra) {
  const lapTimes = monza.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const sessionNow = resolveSessionNow({ currentLap: lap, lapTimes });
  useF1Store.setState({
    ...INITIAL, year: 2024, round: 16, sessionData: monza, trackStatus: monza.track_status,
    sessionTimeOffset: offset, maxLap: 53, currentLap: lap, totalFrames: 0,
    raceSituationData: extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow, sessionTimeOffset: offset }),
    simulatorStrategy: { driver: 'LEC', stints: [{ compound: 'MEDIUM', lapStart: 1, length: 30 }, { compound: 'HARD', lapStart: 31, length: 23 }] },
    ...extra,
  });
  store().computeRaceProjection();
  store().runSimulation();
}

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
  simulateRaceFinish.mockClear();
});

describe.skipIf(!haveMonza)('sessionType reaches the simulation; non-race sessions run nothing', () => {
  const cases = [
    ['loaded FP2', { sessionType: 'R', loadedSessionType: 'FP2' }],
    ['loaded Q', { sessionType: 'R', loadedSessionType: 'Q' }],
    ['loaded SQ', { sessionType: 'R', loadedSessionType: 'SQ' }],
    ['qualifying replay', { sessionType: 'R', loadedSessionType: 'R', isQualifyingReplay: true }],
    ['live practice', { isLiveMode: true, loadedSessionType: null, liveSessionInfo: { session_type: 'Practice', session_name: 'Practice 2' } }],
  ];
  for (const [name, extra] of cases) {
    it(`${name}: no projection, no what-if, no simulation call`, () => {
      at(30, extra);
      expect(simulationJob(store())).toBeNull();
      expect(simulateRaceFinish).not.toHaveBeenCalled();
      expect(store().raceProjection).toBeNull();
      expect(store().simulatorResult).toBeNull();
    });
  }

  it('race and sprint: the session type is passed to every run', () => {
    for (const type of ['R', 'S']) {
      simulateRaceFinish.mockClear();
      at(30, { sessionType: 'R', loadedSessionType: type });
      // the projection (subscription) + the what-if baseline and plan runs
      expect(simulateRaceFinish).toHaveBeenCalledTimes(3);
      for (const [args] of simulateRaceFinish.mock.calls) {
        expect(args.sessionType).toBe(type);
        expect(args.sessionNow).toBe(store().getSessionNow());
      }
      expect(store().raceProjection.raceParams.pitLoss.source).toBe('race');
      expect(store().simulatorResult).not.toBeNull();
    }
  });
});
