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
  for (const k of ['getSchedule', 'getDrivers', 'getChampionship', 'getSeasons', 'queryGemini', 'startMockReplay']) {
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
globalThis.__sessionSwitchFx = fx;
const { useF1Store, telemetryCacheKey, sessionScopeOf } = await import('../store/useF1Store.js');

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
    getSchedule: undefined, getDrivers: undefined, getChampionship: undefined,
    getSeasons: undefined, queryGemini: undefined,
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

  it('telemetry: none asked for a live feed; a mock live race answered after a replay of round 97 landed is not cached', async () => {
    const asked = [];
    const tel = deferred();
    fx.getTelemetry = (y, r, d, l, t) => { asked.push(`${y} R${r} ${d} lap ${l} ${t}`); return tel.promise; };
    // a real live feed: its session has no cached telemetry, and the pills
    // (2024 R99) are not that session
    await enterLive();
    expect(await store().fetchDriverTelemetry('AAA', 3)).toBeNull();
    expect(asked).toEqual([]);
    // a mock live replay of 2024 R98: that race's telemetry
    await store().enterLiveMode(2024, 98, 10);
    await settle();
    const p = store().fetchDriverTelemetry('AAA', 3);
    await settle();
    useF1Store.setState({ round: 97 });
    await store().loadSession();
    await settle();
    tel.resolve({ telemetry: [{ Distance: 0, Speed: 111, SessionTime: 1 }] });
    expect(await p).toBeNull();
    await settle();
    expect(asked).toEqual(['2024 R98 AAA lap 3 R']);
    expect(store().telemetryCache).toEqual({});
    expect(store().telemetryLoading).toBe(false);
  });

  it('telemetry of the session on screen is cached under its year, round and type (D7)', async () => {
    await store().loadSession();
    await settle();
    fx.getTelemetry = async () => ({ telemetry: [{ Distance: 0, Speed: 222 }] });
    await store().fetchDriverTelemetry('AAA', 3);
    expect(Object.keys(store().telemetryCache)).toEqual(['AAA-3-2024-99-R']);
    expect(store().telemetryCache[telemetryCacheKey('AAA', 3, sessionScopeOf(store()))]).toEqual([{ Distance: 0, Speed: 222 }]);
  });

  it('the pills changed without a load: requests stay on the session on screen', async () => {
    await store().loadSession();
    await settle();
    store().setCurrentLap(30);
    const calls = [];
    fx.getTelemetry = async (y, r, d, l, t) => { calls.push([y, r, d, l, t]); return { telemetry: [{ Distance: 0 }] }; };
    fx.predictDegradation = async (body) => { calls.push(['deg', body.year, body.round, body.session_type]); return { slope: 0.01 }; };
    // the session menus change the pills before anything is loaded
    useF1Store.setState({ year: 2023, round: 5, sessionType: 'Q' });
    await store().fetchDriverTelemetry('AAA', 4);
    await store().fetchDegradationRegression({ year: 2023, round: 5, drivers: ['AAA'], lap_start: 5, lap_end: 25 });
    expect(calls).toEqual([[2024, 99, 'AAA', 4, 'R'], ['deg', 2024, 99, 'R']]);
    expect(Object.keys(store().telemetryCache)).toEqual(['AAA-4-2024-99-R']);
  });

  it('a degradation fit asked on one replay and answered after another replay landed is dropped', async () => {
    await store().loadSession();
    await settle();
    store().setCurrentLap(30);
    const deg = deferred();
    fx.predictDegradation = () => deg.promise;
    const req = store().fetchDegradationRegression({ drivers: ['AAA'], lap_start: 5, lap_end: 25 });
    fx.getSession = async () => race(30, ['XXX', 'YYY'], 2000);
    useF1Store.setState({ round: 97 });
    await store().loadSession();
    await settle();
    store().setCurrentLap(30);
    deg.resolve({ slope: 0.05, lap_start: 5, lap_end: 25 });
    await req;
    await settle();
    expect(store().degradationRegression).toBeNull();
  });

  it('live mode sends no degradation request (no session clock; a mock race would hand it future laps)', async () => {
    await store().enterLiveMode(2024, 98, 10);
    await settle();
    let asked = 0;
    fx.predictDegradation = async () => { asked++; return { slope: 0.1 }; };
    await store().fetchDegradationRegression({ drivers: ['AAA'], lap_start: 5, lap_end: 25 });
    expect(asked).toBe(0);
    expect(store().degradationRegression.slope).toBeNull();
    expect(store().degradationRegression.reason).toMatch(/^Live feed: no backend fit/);
  });

  it('selector fetches: an answer for an earlier pick never replaces a later one (schedule, preview, championship, seasons)', async () => {
    // schedule: 2023 asked, then 2025 answered, then the 2023 answer
    const s23 = deferred();
    fx.getSchedule = (y) => (y === 2023 ? s23.promise : Promise.resolve({ events: [{ RoundNumber: 1, EventName: `E${y}` }] }));
    useF1Store.setState({ schedule: [], scheduleYear: null, year: 2023 });
    const ps = store().fetchSchedule(2023);
    useF1Store.setState({ year: 2025 });
    await store().fetchSchedule(2025);
    s23.resolve({ events: [{ RoundNumber: 1, EventName: 'E2023' }] });
    await ps;
    await settle();
    expect([store().year, store().scheduleYear, store().schedule.map((e) => e.EventName)]).toEqual([2025, 2025, ['E2025']]);
    // the year pill moved before the schedule was asked: it is fetched (the
    // old check compared the pill, so the 2025 calendar stayed under 2024)
    useF1Store.setState({ year: 2024 });
    await store().fetchSchedule(2024);
    expect([store().scheduleYear, store().schedule.map((e) => e.EventName)]).toEqual([2024, ['E2024']]);

    // driver preview
    const d1 = deferred();
    fx.getDrivers = (y, r) => (r === 1 ? d1.promise : Promise.resolve({ drivers: [{ Abbreviation: `R${r}` }] }));
    const pp = store().fetchDriversPreview(2024, 1);
    await store().fetchDriversPreview(2024, 2);
    d1.resolve({ drivers: [{ Abbreviation: 'R1' }] });
    await pp;
    expect(store().previewDrivers.map((d) => d.Abbreviation)).toEqual(['R2']);

    // championship
    const c23 = deferred();
    fx.getChampionship = (y) => (y === 2023 ? c23.promise : Promise.resolve({ year: y }));
    const pc = store().fetchChampionship(2023);
    await store().fetchChampionship(2024);
    c23.resolve({ year: 2023 });
    await pc;
    expect(store().championshipData.year).toBe(2024);

    // seasons: newest first; offline keeps the list
    fx.getSeasons = async () => ({ seasons: [2018, 2026, 2025, 2024] });
    await store().fetchSeasons();
    expect(store().seasons).toEqual([2026, 2025, 2024, 2018]);
    fx.getSeasons = async () => { throw new Error('offline'); };
    await store().fetchSeasons();
    expect(store().seasons).toEqual([2026, 2025, 2024, 2018]);
  });

  it('a Gemini answer asked on one session and answered after another landed is dropped', async () => {
    await store().loadSession();
    await settle();
    const g = deferred();
    let body = null;
    fx.queryGemini = (b) => { body = b; return g.promise; };
    useF1Store.setState({ round: 50 }); // the pill only
    const pg = store().sendGeminiQuery('pit now?');
    expect([body.year, body.round, body.session_type]).toEqual([2024, 99, 'R']);
    useF1Store.setState({ round: 98 });
    await store().loadSession();
    await settle();
    g.resolve({ response: 'answer about R99' });
    await pg;
    // R98's commit cleared R99's chat (the question too: no assistant is left
    // waiting), and R99's answer never lands
    expect(store().geminiMessages).toEqual([]);
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
    const p2 = store().triggerPrediction('AAA', 20);
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
    await Promise.all([p2, p4]);
    await settle();
    expect(store().lstmPredictions).toBeNull();
    expect(store().predictionLoading).toBe(false);
    expect(store().positionData).toBeNull();
  });
});
