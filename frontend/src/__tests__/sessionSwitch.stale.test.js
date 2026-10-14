// P3a: a request asked for one session and answered after the dashboard
// switched session (live -> replay, replay -> replay, reset) never lands on
// the new one. Every async store action captures the session generation it
// was asked in (store/useF1Store.js _sessionLoadGeneration) and drops an
// answer of an earlier generation. Synthetic sessions, mocked API.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__sessionSwitchFx;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn((y, r, t) => fx().getSession(y, r, t));
  mocked.getFrames = vi.fn(async () => ({}));
  mocked.getLiveStatus = vi.fn(async () => fx().liveStatus);
  mocked.getLiveSnapshot = vi.fn(() => fx().getSnapshot());
  mocked.loadLiveFullSession = vi.fn(async () => ({}));
  mocked.stopMockReplay = vi.fn(async () => ({ status: 'not_running' }));
  mocked.predictDegradation = vi.fn((p) => fx().predictDegradation(p));
  mocked.predictLSTM = vi.fn((p) => fx().predictLSTM(p));
  mocked.getTelemetry = vi.fn((y, r, d, l, t) => fx().getTelemetry(y, r, d, l, t));
  mocked.getPositions = vi.fn((y, r) => fx().getPositions(y, r));
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

const fx = {};
globalThis.__sessionSwitchFx = fx;
const { useF1Store } = await import('../store/useF1Store.js');

const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
};

/** A synthetic race: `laps` laps of 95 s from session time t0, three drivers. */
function race(laps, drivers = ['AAA', 'BBB', 'CCC'], t0 = 2000) {
  const lap_times = [];
  for (const [i, d] of drivers.entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = t0 + 95 * (n - 1) + i * 1.5;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.05 * n,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return { lap_times, track_status: [], driver_info: drivers.map((d) => ({ Abbreviation: d })), race_results: [], weather_data: [] };
}

beforeEach(() => {
  const SAME = race(30);
  Object.assign(fx, {
    getSession: async () => SAME,
    liveStatus: {
      active: true, current_lap: 30, total_laps: 57, session_status: 'Started',
      session_info: { session_type: 'Race', session_name: 'Race' },
    },
    getSnapshot: async () => ({ lap_times: SAME.lap_times, track_status: [], driver_info: [] }),
    predictDegradation: async () => ({ slope: 0.1 }),
    predictLSTM: async () => ({ predicted_times: [90] }),
    getTelemetry: async () => ({ telemetry: [] }),
    getPositions: async () => ({ positions: [] }),
  });
  store().resetSession();
  useF1Store.setState({
    isLiveMode: false, liveSessionInfo: null, liveConnected: false, year: 2024, round: 99, sessionType: 'R',
    telemetryLoading: false, positionData: null,
  });
});

async function enterLive() {
  await store().enterLiveMode();
  await settle();
  expect(store().isLiveMode).toBe(true);
}

describe('P3a: answers of an earlier session never land on the session on screen', () => {
  it('a brushed degradation fit asked live (laps 5-25) and answered after the replay of the same race landed is dropped', async () => {
    await enterLive();
    const deg = deferred();
    fx.predictDegradation = () => deg.promise;
    const req = store().fetchDegradationRegression({ year: 2024, round: 99, drivers: ['AAA'], lap_start: 5, lap_end: 25 });
    await settle();
    await store().loadSession();
    await settle();
    expect(store().isLiveMode).toBe(false);
    expect(store().getLastCompletedLap(['AAA'])).toBe(0);
    deg.resolve({ slope: 0.05, lap_start: 5, lap_end: 25 });
    await req;
    await settle();
    expect(store().degradationRegression).toBeNull();
    store().setCurrentLap(3);
    await settle();
    expect(store().degradationRegression).toBeNull();
  });

  it('a degradation fit of the session on screen still lands (same generation)', async () => {
    await store().loadSession();
    await settle();
    store().setCurrentLap(30);
    await settle();
    const deg = deferred();
    fx.predictDegradation = () => deg.promise;
    const req = store().fetchDegradationRegression({ year: 2024, round: 99, drivers: ['AAA'], lap_start: 5, lap_end: 25 });
    deg.resolve({ slope: 0.05, lap_start: 5, lap_end: 25 });
    await req;
    expect(store().degradationRegression?.fitted_lap_range).toEqual([5, 25]);
  });

  it('telemetry asked live (round 99) and answered after a replay of round 97 landed is not cached', async () => {
    await enterLive();
    const tel = deferred();
    let asked = null;
    fx.getTelemetry = (y, r, d, l, t) => { asked = `${y} R${r} ${d} lap ${l} ${t}`; return tel.promise; };
    const p = store().fetchDriverTelemetry('AAA', 3);
    await settle();
    useF1Store.setState({ round: 97 });
    await store().loadSession();
    await settle();
    tel.resolve({ telemetry: [{ Distance: 0, Speed: 111, SessionTime: 1 }] });
    expect(await p).toBeNull();
    await settle();
    expect(asked).toBe('2024 R99 AAA lap 3 R');
    expect(store().telemetryCache).toEqual({});
    expect(store().telemetryLoading).toBe(false);
  });

  it('telemetry of the session on screen is cached', async () => {
    await store().loadSession();
    await settle();
    fx.getTelemetry = async () => ({ telemetry: [{ Distance: 0, Speed: 222 }] });
    await store().fetchDriverTelemetry('AAA', 3);
    expect(store().telemetryCache['AAA-3-R']).toEqual([{ Distance: 0, Speed: 222 }]);
  });

  it('LSTM answers and positions asked before a replay -> replay switch are dropped', async () => {
    await store().loadSession();
    await settle();
    store().setCurrentLap(20);
    await settle();
    useF1Store.setState({ focusDriver: 'AAA', selectedDrivers: ['AAA'] });
    const l1 = deferred();
    const pos = deferred();
    fx.predictLSTM = () => l1.promise;
    fx.getPositions = () => pos.promise;
    const p1 = store().triggerLSTMPredictions();
    const p2 = store().triggerPrediction('AAA', 20);
    const p3 = store().fetchLSTMPrediction({});
    const p4 = store().loadPositions();
    await settle();
    // another race whose clock is LATER than the first one's: the clock test
    // alone ("asked at a later clock") would not drop these answers
    fx.getSession = async () => race(30, ['XXX', 'YYY'], 90000);
    useF1Store.setState({ round: 97 });
    await store().loadSession();
    await settle();
    expect(store().getSessionNow()).toBeGreaterThanOrEqual(90000);
    l1.resolve({ predicted_times: [91.1] });
    pos.resolve({ positions: ['stale'] });
    await Promise.all([p1, p2, p3, p4]);
    await settle();
    expect(store().lstmPredictions).toBeNull();
    expect(store().predictionLoading).toBe(false);
    expect(store().positionData).toBeNull();
  });
});
