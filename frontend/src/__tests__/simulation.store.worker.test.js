// With a worker: the store's Monte Carlo jobs leave the calling thread and
// come back later; a result for a state no longer on screen (a newer lap, a
// session reset, a seek back) never lands. Worker is defined here before the
// store loads, so the store's client runs every job through it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { handleJobMessage } = await import('../workers/raceSimulation.worker.js');

// Worker stand-in: the real worker module on a later macrotask, messages cloned
const created = [];
globalThis.Worker = class FakeWorker {
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.posted = [];
    created.push(this);
  }

  postMessage(data) {
    const msg = structuredClone(data);
    this.posted.push(msg);
    setTimeout(() => handleJobMessage(msg, (reply) => {
      const back = structuredClone(reply);
      setTimeout(() => this.onmessage?.({ data: back }), 0);
    }), 0);
  }

  terminate() {}
};

const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const store = () => useF1Store.getState();
const INITIAL = store();
const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;

function monzaAt(currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  useF1Store.setState({
    ...INITIAL, year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R', sessionData: monza,
    trackStatus: monza.track_status, sessionTimeOffset: offset, maxLap: MAX_LAP, currentLap, totalFrames: 0,
    raceSituationData: extractRaceSituationFeatures({ lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: offset }),
    ...extra,
  });
}

// every computed projection set in the store, in order (lap it was computed at)
let landed = [];
let unsubscribe = null;
beforeEach(() => {
  vi.useFakeTimers();
  useF1Store.setState({ ...INITIAL });
  landed = [];
  unsubscribe = useF1Store.subscribe((s, prev) => {
    if (s.raceProjection && s.raceProjection !== prev.raceProjection) landed.push(s.raceProjection.computedAtLap);
  });
});
afterEach(() => {
  unsubscribe?.();
  vi.useRealTimers();
});

describe.skipIf(!haveMonza)('store + worker (Monza 2024)', () => {
  it('the projection runs in the module worker and lands later', async () => {
    monzaAt(30);
    expect(store().raceProjection).toBeNull(); // not computed on this thread
    expect(created).toHaveLength(1);
    expect(created[0].url).toMatch(/workers\/raceSimulation\.worker\.js$/);
    expect(created[0].opts).toEqual({ type: 'module' });
    await vi.runAllTimersAsync();
    expect(store().raceProjection.computedAtLap).toBe(30);
    expect(store().raceProjection.numSimulations).toBe(1000);
    expect(landed).toEqual([30]);
  });

  it('a newer lap while a job runs: the older result never lands', async () => {
    monzaAt(30);
    monzaAt(31);
    monzaAt(32);
    await vi.runAllTimersAsync();
    expect(landed).toEqual([32]);
    expect(store().raceProjection.computedAtLap).toBe(32);
  });

  it('a session reset or a seek back while a job runs: its result is dropped', async () => {
    monzaAt(30);
    useF1Store.setState({ raceSituationData: null, raceProjection: null, sessionData: null });
    await vi.runAllTimersAsync();
    expect(landed).toEqual([]);
    expect(store().raceProjection).toBeNull();

    monzaAt(40);
    // the clock moves back in the same race situation object: the result is from a later clock
    useF1Store.setState({ currentLap: 35 });
    await vi.runAllTimersAsync();
    expect(landed).toEqual([]);
  });

  it('the what-if runs in the worker too; identical plan -> exactly 0', async () => {
    monzaAt(12);
    await vi.runAllTimersAsync();
    const plan = [{ compound: 'MEDIUM', lapStart: 1, length: 15 }, { compound: 'HARD', lapStart: 16, length: MAX_LAP - 15 }];
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: { label: 'A', stints: plan } });
    store().runSimulation();
    expect(store().simulatorResult).toBeNull();
    await vi.runAllTimersAsync();
    expect(store().simulatorResult.delta).toEqual({ position: 0, podium: 0, points: 0 });
    expect(created).toHaveLength(1); // one worker for every job
  });
});
