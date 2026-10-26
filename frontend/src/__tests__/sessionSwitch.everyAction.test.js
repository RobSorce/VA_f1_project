// A late answer of ANY async store action never overwrites the
// session on screen. Session A (2024 R91) is on screen; an action is started
// with its answer held back; then a fast double switch: B (R92) is asked and,
// before it lands, C (R93); C lands, then B's late answers and the action's
// late answer arrive. Only C may show. The test enumerates the store's async
// actions (every AsyncFunction of the store, plus the Monte Carlo actions
// whose results come back from the simulation worker) and fails when one has
// no scenario here.
// Synthetic sessions, mocked API, a worker that holds its results.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  const fx = () => globalThis.__everyActionFx;
  for (const [k, v] of Object.entries(orig)) {
    mocked[k] = typeof v === 'function' ? vi.fn((...a) => (fx()[k] ? fx()[k](...a) : Promise.resolve({}))) : v;
  }
  mocked.setHealthReporter = vi.fn();
  return mocked;
});
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

// The simulation worker: the real worker module, its replies held until released
const { handleJobMessage } = await import('../workers/raceSimulation.worker.js');
const heldJobs = [];
globalThis.Worker = class HeldWorker {
  postMessage(data) {
    const msg = structuredClone(data);
    heldJobs.push(() => handleJobMessage(msg, (reply) => this.onmessage?.({ data: structuredClone(reply) })));
  }

  terminate() {}
};
const releaseWorker = () => { while (heldJobs.length) heldJobs.shift()(); };

const fx = {};
globalThis.__everyActionFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');

const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
};
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A synthetic race tagged with its round: `laps` laps of 95 s from session time t0. */
function race(round, drivers, t0, laps = 30) {
  const lap_times = [];
  for (const [i, d] of drivers.entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = t0 + 95 * (n - 1) + i * 1.5;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.05 * n + 0.2 * i,
        Position: i + 1, Compound: n <= 15 ? 'MEDIUM' : 'HARD', TyreLife: n <= 15 ? n : n - 15,
        Stint: n <= 15 ? 1 : 2, TrackStatus: '1',
        ...(n === 15 ? { PitInTime: start + 90 } : {}), ...(n === 16 ? { PitOutTime: start + 20 } : {}),
      });
    }
  }
  return {
    tag: `R${round}`, lap_times, track_status: [], race_results: [], weather_data: [],
    driver_info: drivers.map((d) => ({ Abbreviation: d })),
  };
}
const SESSIONS = {
  91: race(91, ['AAA', 'BBB', 'CCC'], 200),
  92: race(92, ['XXX', 'YYY', 'ZZZ'], 3000),
  93: race(93, ['PPP', 'QQQ', 'RRR'], 6000),
};
const tagOf = (r) => `R${r}`;

/** Every per-session request answers with its round's tag (C's at once). */
function sessionFixtures() {
  Object.assign(fx, {
    getSession: async (y, r) => SESSIONS[r],
    getCircuit: async (y, r) => ({ tag: tagOf(r), track_coordinates: [] }),
    getStrategy: async (y, r) => ({ strategies: [{ tag: tagOf(r) }] }),
    getFrames: async (y, r) => ({ tag: tagOf(r), frames: [] }),
    getSectors: async (y, r) => ({ tag: tagOf(r) }),
    getConsistency: async (y, r) => ({ tag: tagOf(r) }),
    getSpeedRankings: async (y, r) => ({ tag: tagOf(r) }),
    stopMockReplay: async () => ({ status: 'not_running' }),
    startMockReplay: async () => ({}),
    getLiveStatus: async () => ({
      active: true, current_lap: 10, total_laps: 30, session_status: 'Started',
      session_info: { session_type: 'Race', session_name: 'Race' },
    }),
    getLiveSnapshot: async () => ({ tag: 'LIVE', lap_times: SESSIONS[91].lap_times.filter((r) => r.LapNumber <= 10), driver_info: SESSIONS[91].driver_info, track_status: [] }),
  });
}

/** Session A on screen at lap 20, AAA focused and selected. */
async function onA() {
  store().resetSession();
  useF1Store.setState({ isLiveMode: false, liveSessionInfo: null, year: 2024, round: 91, sessionType: 'R' });
  await store().loadSession();
  await settle();
  store().setCurrentLap(20);
  useF1Store.setState({ focusDriver: 'AAA', selectedDrivers: ['AAA'] });
  await settle();
  expect(store().sessionData.tag).toBe('R91');
}

/** A live feed on screen (from A): a real feed, or a mock replay of R98. */
async function onLive(mock = false) {
  await (mock ? store().enterLiveMode(2024, 98, 10) : store().enterLiveMode());
  await settle();
  expect(store().isLiveMode).toBe(true);
}

/**
 * The fast double switch: B is asked, then C before B lands. B's answers
 * are held back and arrive once C is on screen. bCommits: B's session
 * answer lands first (B is committed), then C is asked while B's circuit,
 * strategy, frames and analytics are still on their way.
 */
async function fastDoubleSwitch({ bCommits = false } = {}) {
  const held = [];
  const hold = (k) => {
    const real = fx[k];
    fx[k] = (y, r, ...rest) => {
      if (r !== 92) return real(y, r, ...rest);
      const d = deferred();
      held.push(() => d.resolve(real(y, r, ...rest)));
      return d.promise;
    };
  };
  if (bCommits) ['getCircuit', 'getStrategy', 'getFrames', 'getSectors', 'getConsistency', 'getSpeedRankings'].forEach(hold);
  else hold('getSession');
  useF1Store.setState({ round: 92 });
  const loadB = store().loadSession();
  if (bCommits) await until(() => store().loadedRound === 92);
  useF1Store.setState({ round: 93 });
  await store().loadSession();
  await settle();
  expect(store().loadedRound).toBe(93);
  // B's late answers
  for (const release of held) release();
  await loadB;
  await settle();
  return held.length;
}

/** Only C is on screen: its rows, its circuit, strategy, frames and analytics; nothing live. */
function assertOnlyC(step) {
  const s = store();
  expect([s.isLiveMode, s.loadedYear, s.loadedRound, s.loadedSessionType], step).toEqual([false, 2024, 93, 'R']);
  expect(s.sessionData.tag, step).toBe('R93');
  expect(s.sessionData.strategies?.[0]?.tag, step).toBe('R93');
  expect(s.circuitInfo?.tag, step).toBe('R93');
  expect(s.frameData?.tag, step).toBe('R93');
  expect([s.sectorRankings?.tag, s.consistencyData?.tag, s.speedRankings?.tag], step).toEqual(['R93', 'R93', 'R93']);
  expect(s.drivers.map((d) => d.Abbreviation), step).toEqual(['PPP', 'QQQ', 'RRR']);
}

/** Hold the next answer of api[k]; returns the release (answer = the given value). */
function holdNext(k, value) {
  const d = deferred();
  const real = fx[k];
  let first = true;
  fx[k] = (...a) => {
    if (!first) return real ? real(...a) : Promise.resolve({});
    first = false;
    return d.promise;
  };
  return () => d.resolve(typeof value === 'function' ? value() : value);
}

// One entry per async store action: start it on A (or on the live screen)
// with its answer held back, and check its state after the late answer.
// Each returns { release, check }.
const SCENARIOS = {
  loadSession: [
    {
      title: 'B\'s session answer arrives after C landed',
      start: async () => ({ release: () => {}, check: () => {}, double: {} }),
    },
    {
      title: 'B committed, its circuit, strategy, frames and analytics arrive after C landed',
      start: async () => ({ release: () => {}, check: () => {}, double: { bCommits: true } }),
    },
  ],
  loadFrames: async () => {
    const release = holdNext('getFrames', { tag: 'R91', frames: [{ t: 0, drivers: { AAA: { lap: 1 } } }, { t: 0.4, drivers: { AAA: { lap: 1 } } }] });
    const p = store().loadFrames();
    return { release, wait: p, check: () => expect(store().totalFrames).toBe(0) };
  },
  loadPositions: async () => {
    const release = holdNext('getPositions', { tag: 'R91' });
    const p = store().loadPositions();
    return { release, wait: p, check: () => expect(store().positionData).toBeNull() };
  },
  fetchAnalytics: async () => {
    const releases = ['getSectors', 'getConsistency', 'getSpeedRankings'].map((k) => holdNext(k, { tag: 'R91' }));
    const p = store().fetchAnalytics();
    return { release: () => releases.forEach((r) => r()), wait: p, check: () => {} };
  },
  fetchDriverTelemetry: async () => {
    const release = holdNext('getTelemetry', { telemetry: [{ Distance: 0, Speed: 91 }] });
    const p = store().fetchDriverTelemetry('AAA', 12);
    return {
      release,
      wait: p,
      check: async () => {
        expect(await p).toBeNull();
        expect(store().telemetryCache).toEqual({});
        expect(store().telemetryLoading).toBe(false);
      },
    };
  },
  fetchDegradationRegression: async () => {
    const release = holdNext('predictDegradation', { slope: 0.091, lap_start: 5, lap_end: 15 });
    const p = store().fetchDegradationRegression({ drivers: ['AAA'], lap_start: 5, lap_end: 15 });
    return { release, wait: p, check: () => expect(store().degradationRegression).toBeNull() };
  },
  fetchPCAAnalysis: async () => {
    const release = holdNext('analyzePCASelection', { tag: 'R91', strategies: [] });
    const p = store().fetchPCAAnalysis(['AAA_2024_91']);
    return { release, wait: p, check: () => expect(store().pcaStrategyAnalysis?.tag).not.toBe('R91') };
  },
  loadPCAEmbeddings: async () => {
    const release = holdNext('getPCAEmbeddings', { tag: 'R91', points: [] });
    const p = store().loadPCAEmbeddings();
    return { release, wait: p, check: () => expect(store().pcaEmbeddings?.tag).not.toBe('R91') };
  },
  triggerPrediction: async () => {
    const release = holdNext('predictLSTM', { driver: 'AAA', origin_lap: 19, predicted_times: [96, 96, 96, 96, 96], target_laps: [20, 21, 22, 23, 24], method: 'lstm' });
    const p = store().triggerPrediction('AAA', 20);
    expect(api.predictLSTM).toHaveBeenCalled();
    return {
      release,
      wait: p,
      check: () => {
        expect(store().lstmPredictions).toBeNull();
        expect(store().predictionLoading).toBe(false);
        expect(store().lastPredictionTrigger).toBeNull();
      },
    };
  },
  sendGeminiQuery: async () => {
    const release = holdNext('queryGemini', { response: 'answer about R91' });
    const p = store().sendGeminiQuery('pit now?');
    return { release, wait: p, check: () => expect(JSON.stringify(store().geminiMessages)).not.toContain('R91') };
  },
  askGeminiQuick: async () => {
    const release = holdNext('queryGemini', { response: 'quick answer about R91' });
    const p = store().askGeminiQuick('pit now?');
    return { release, wait: p, check: () => expect(store().geminiQuick).toEqual({ loading: false, response: '', error: '' }) };
  },
  enterLiveMode: async () => {
    // a mock live entry still connecting: its snapshot arrives after C landed
    const release = holdNext('getLiveSnapshot', { tag: 'LIVE', lap_times: SESSIONS[91].lap_times.filter((r) => r.LapNumber <= 10), driver_info: [] });
    const p = store().enterLiveMode(2024, 98, 10);
    await until(() => api.getLiveSnapshot.mock.calls.length > 0);
    return { release, wait: p, check: () => {} };
  },
  exitLiveMode: async () => {
    await onLive();
    const release = holdNext('stopMockReplay', { status: 'stopped' });
    const p = store().exitLiveMode();
    await settle();
    return { release, wait: p, check: () => {} };
  },
  _resyncLive: async () => {
    await onLive();
    const release = holdNext('getLiveSnapshot', { tag: 'LIVE', lap_times: SESSIONS[91].lap_times, driver_info: [] });
    const p = store()._resyncLive();
    return { release, wait: p, check: () => {} };
  },
  // Selector fetches: not session-scoped (the latest pick wins, sessionSwitch.stale.test.js);
  // a late answer must leave the session on screen as it is
  fetchSchedule: async () => {
    const release = holdNext('getSchedule', { events: [{ RoundNumber: 1, EventName: 'late' }] });
    const p = store().fetchSchedule(2023);
    return { release, wait: p, check: () => {} };
  },
  fetchSeasons: async () => {
    const release = holdNext('getSeasons', { seasons: [2025, 2024] });
    const p = store().fetchSeasons();
    return { release, wait: p, check: () => {} };
  },
  fetchDriversPreview: async () => {
    const release = holdNext('getDrivers', { drivers: [{ Abbreviation: 'LATE' }] });
    const p = store().fetchDriversPreview(2024, 5);
    return { release, wait: p, check: () => {} };
  },
  fetchChampionship: async () => {
    const release = holdNext('getChampionship', { year: 2023 });
    const p = store().fetchChampionship(2023);
    return { release, wait: p, check: () => {} };
  },
  // Monte Carlo runs: their results come back from the worker
  computeRaceProjection: async () => {
    const s = store();
    const rsd = extractRaceSituationFeatures({
      lapTimes: s.sessionData.lap_times, dnfMap: {}, currentLap: 20, sessionNow: s.getSessionNow(),
    });
    useF1Store.setState({ raceSituationData: rsd });
    store().computeRaceProjection();
    expect(heldJobs.length).toBeGreaterThan(0);
    return { release: releaseWorker, check: () => expect(store().raceProjection).toBeNull() };
  },
  runSimulation: async () => {
    const s = store();
    const rsd = extractRaceSituationFeatures({
      lapTimes: s.sessionData.lap_times, dnfMap: {}, currentLap: 20, sessionNow: s.getSessionNow(),
    });
    useF1Store.setState({
      raceSituationData: rsd,
      simulatorStrategy: { driver: 'AAA', stints: [{ compound: 'MEDIUM', lapStart: 1, length: 15 }, { compound: 'HARD', lapStart: 16, length: 15 }] },
    });
    store().runSimulation();
    expect(heldJobs.length).toBeGreaterThan(0);
    return { release: releaseWorker, check: () => expect(store().simulatorResult).toBeNull() };
  },
};

// The store's async actions, found in the store itself
const WORKER_ACTIONS = ['computeRaceProjection', 'runSimulation'];
const ASYNC_ACTIONS = Object.entries(useF1Store.getState())
  .filter(([, v]) => typeof v === 'function' && v.constructor?.name === 'AsyncFunction')
  .map(([k]) => k);

beforeEach(async () => {
  for (const k of Object.keys(fx)) delete fx[k];
  // A job the previous test left held is answered, not dropped: dropped, its
  // channel stays busy in the simulation client and the next job on it waits
  // forever (computeRaceProjection then never reached the worker)
  releaseWorker();
  sessionFixtures();
  await onA();
  for (const f of Object.values(api)) if (f?.mockClear) f.mockClear();
  releaseWorker();
});

describe('every async store action is covered', () => {
  it('the scenarios name exactly the store\'s async actions (plus the worker-backed Monte Carlo actions)', () => {
    console.log(`L6 async actions (${ASYNC_ACTIONS.length}) + worker (${WORKER_ACTIONS.length}): ${[...ASYNC_ACTIONS, ...WORKER_ACTIONS].sort().join(', ')}`);
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ASYNC_ACTIONS, ...WORKER_ACTIONS].sort());
    for (const k of WORKER_ACTIONS) expect(typeof store()[k]).toBe('function');
  });
});

describe('nothing of the previous session is carried onto the next', () => {
  it('A\'s circuit and positions are gone at C\'s commit, while C\'s own circuit is still on its way', async () => {
    useF1Store.setState({ positionData: { tag: 'R91' } });
    expect(store().circuitInfo?.tag).toBe('R91');
    const circuitC = deferred();
    const real = fx.getCircuit;
    fx.getCircuit = (y, r) => (r === 93 ? circuitC.promise : real(y, r));
    useF1Store.setState({ round: 93 });
    const loading = store().loadSession();
    await until(() => store().loadedRound === 93);
    expect(store().sessionData.tag).toBe('R93');
    expect(store().circuitInfo).toBeNull();
    expect(store().positionData).toBeNull();
    circuitC.resolve({ tag: 'R93', track_coordinates: [] });
    await loading;
    await settle();
    assertOnlyC('C landed');
  }, 20000);
});

describe('A -> B -> C fast, every late answer arrives once C is on screen: only C shows', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const variants = Array.isArray(scenario) ? scenario : [{ title: 'its late answer', start: scenario }];
    for (const v of variants) {
      it(`${name}: ${v.title}`, async () => {
        const started = await v.start();
        const heldB = await fastDoubleSwitch(started.double || {});
        assertOnlyC('after the switch');
        started.release();
        if (started.wait) await started.wait;
        await settle();
        assertOnlyC('after the late answers');
        await started.check();
        if (name === 'loadSession') expect(heldB).toBeGreaterThan(0);
      }, 20000);
    }
  }
});
