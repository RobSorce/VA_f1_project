// Session switch, the load window: loadSession and enterLiveMode bump
// the session generation when they START, while the session on screen stays
// mounted and interactive (brush, playback, focus) until they commit. A
// request its views send in that window carries the NEW generation with the
// OLD session. Every async store action takes a guard when it sends
// (store/useF1Store.js sessionRequestGuard: the generation and what is on
// screen, screenKeyOf) and drops an answer once another session is on screen.
// Synthetic races with the second one's clock LATER than the first's, so the
// clock checks alone ("asked at a later clock") would keep the stale answers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__loadWindowFx;
  mocked.setHealthReporter = vi.fn();
  for (const k of ['getSession', 'getFrames', 'predictDegradation', 'predictLSTM', 'getTelemetry', 'getPositions',
    'startMockReplay', 'getLiveStatus', 'getLiveSnapshot', 'loadLiveFullSession', 'stopMockReplay']) {
    mocked[k] = vi.fn((...a) => (fx()[k] ? fx()[k](...a) : Promise.resolve({})));
  }
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
globalThis.__loadWindowFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store, screenKeyOf } = await import('../store/useF1Store.js');

const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
};

/** A synthetic race: `laps` laps of 95 s from session time t0. */
function race(laps, drivers, t0) {
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

// A: 2024 R91, race start at session time 200 s; B: 2024 R92, start 3000 s
const A = race(30, ['AAA', 'BBB', 'CCC'], 200);
const B = race(30, ['XXX', 'YYY', 'ZZZ'], 3000);

beforeEach(async () => {
  for (const k of Object.keys(fx)) delete fx[k];
  store().resetSession();
  useF1Store.setState({
    isLiveMode: false, liveSessionInfo: null, liveConnected: false, year: 2024, round: 91, sessionType: 'R',
    telemetryLoading: false, positionData: null, predictionLoading: false,
  });
  fx.getSession = async () => A;
  await store().loadSession();
  await settle();
  store().setCurrentLap(20);
  useF1Store.setState({ focusDriver: 'AAA', selectedDrivers: ['AAA'] });
  await settle();
  for (const f of Object.values(api)) if (f?.mockClear) f.mockClear();
});

/** Start the load of B with its session answer held back; land() lets it commit. */
function startLoadB() {
  const b = deferred();
  fx.getSession = () => b.promise;
  useF1Store.setState({ round: 92 });
  const loading = store().loadSession();
  return {
    land: async () => {
      b.resolve(B);
      await loading;
      await settle();
    },
  };
}

describe('a request sent for the session on screen while the next one loads', () => {
  it('a brushed degradation fit of A asked while B loads is dropped when it lands on B, also later on B', async () => {
    const nowA = store().getSessionNow();
    const loadB = startLoadB();
    expect(screenKeyOf(store())).toBe('replay:2024-91-R'); // A still on screen
    const deg = deferred();
    fx.predictDegradation = () => deg.promise;
    const req = store().fetchDegradationRegression({ drivers: ['AAA'], lap_start: 5, lap_end: 15 });
    const body = api.predictDegradation.mock.calls.at(-1)[0];
    expect([body.year, body.round, body.session_now]).toEqual([2024, 91, nowA]);
    await loadB.land();
    expect(screenKeyOf(store())).toBe('replay:2024-92-R');
    // B's clock is later than the one the fit was asked at: no clock check drops it
    expect(store().getSessionNow()).toBeGreaterThan(nowA);
    deg.resolve({ slope: 0.123, lap_start: 5, lap_end: 15, undercut_window: [17, 22] });
    await req;
    await settle();
    expect(store().degradationRegression).toBeNull();
    store().setCurrentLap(3);
    await settle();
    expect(store().degradationRegression).toBeNull();
  }, 20000);

  it('the lap-time forecast (its one trigger), telemetry and positions of A never land on B', async () => {
    const loadB = startLoadB();
    const lstm = deferred();
    const tel = deferred();
    const pos = deferred();
    fx.predictLSTM = () => lstm.promise;
    fx.getTelemetry = () => tel.promise;
    fx.getPositions = () => pos.promise;
    const pending = [
      store().triggerPrediction('AAA', 20),
      store().fetchDriverTelemetry('AAA', 12),
      store().loadPositions(),
    ];
    expect(api.predictLSTM.mock.calls.map((c) => [c[0].year ?? null, c[0].round ?? null]))
      .toEqual([[2024, 91]]);
    expect(api.getTelemetry.mock.calls[0].slice(0, 2)).toEqual([2024, 91]);
    await loadB.land();
    lstm.resolve({ driver: 'AAA', optimal_pit_lap: 31, pit_probability: 0.7, predicted_times: [96] });
    tel.resolve({ telemetry: [{ Distance: 0, Speed: 100 }] });
    pos.resolve({ positions: ['A'] });
    await Promise.all(pending);
    await settle();
    expect(store().lstmPredictions).toBeNull();
    expect(store()._lstmAt).toBeNull();
    expect(store().predictionLoading).toBe(false);
    expect(store().telemetryCache).toEqual({});
    expect(store().telemetryLoading).toBe(false);
    expect(store().positionData).toBeNull();
  }, 20000);

  it('an answer that arrives while A is still on screen lands on A, and B\'s commit clears it', async () => {
    const loadB = startLoadB();
    fx.predictLSTM = async () => ({ driver: 'AAA', optimal_pit_lap: 31, predicted_times: [96] });
    await store().triggerPrediction('AAA', 20);
    expect(screenKeyOf(store())).toBe('replay:2024-91-R');
    expect(store().lstmPredictions?.AAA?.optimal_pit_lap).toBe(31);
    await loadB.land();
    expect(store().lstmPredictions).toBeNull();
  }, 20000);

  it('replay -> live: an LSTM of the replay asked while a mock live entry connects is dropped', async () => {
    const snap = deferred();
    fx.startMockReplay = async () => ({});
    fx.getLiveStatus = async () => ({ active: true, session_status: 'Started', current_lap: 5, total_laps: 30 });
    fx.getLiveSnapshot = () => snap.promise;
    const lstm = deferred();
    fx.predictLSTM = () => lstm.promise;
    const entering = store().enterLiveMode(2024, 92, 10);
    const req = store().triggerPrediction('AAA', 20);
    expect(api.predictLSTM.mock.calls.at(-1)[0].round).toBe(91);
    snap.resolve({ lap_times: B.lap_times.filter((r) => r.LapNumber <= 4), driver_info: B.driver_info, track_status: [] });
    await entering;
    await settle();
    expect(screenKeyOf(store())).toBe('live:2024-92-R');
    lstm.resolve({ driver: 'AAA', optimal_pit_lap: 31, predicted_times: [96] });
    await req;
    await settle();
    expect(store().lstmPredictions).toBeNull();
  }, 20000);

  it('replay -> mock live of the SAME race: same session, another mode, the answer is dropped', async () => {
    const snap = deferred();
    fx.startMockReplay = async () => ({});
    fx.getLiveStatus = async () => ({ active: true, session_status: 'Started', current_lap: 5, total_laps: 30 });
    fx.getLiveSnapshot = () => snap.promise;
    const lstm = deferred();
    fx.predictLSTM = () => lstm.promise;
    const entering = store().enterLiveMode(2024, 91, 10);
    const req = store().triggerPrediction('AAA', 20);
    snap.resolve({ lap_times: A.lap_times.filter((r) => r.LapNumber <= 4), driver_info: A.driver_info, track_status: [] });
    await entering;
    await settle();
    expect(screenKeyOf(store())).toBe('live:2024-91-R');
    lstm.resolve({ driver: 'AAA', optimal_pit_lap: 31, predicted_times: [96] });
    await req;
    await settle();
    // the replay's prediction read laps up to lap 20; live is at lap 5
    expect(store().lstmPredictions).toBeNull();
  }, 20000);
});
