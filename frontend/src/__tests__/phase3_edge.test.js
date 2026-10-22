// Edge cases, store side (decisions R4, R7, R8):
//  - a live -> replay switch starts a new load generation before anything
//    is awaited, so a live entry still in flight never lands nor reconnects
//    the feed, and a live message delivered after the switch is dropped;
//  - the lap-mode clock on the last lap is the leader's end of lap L-1
//    (R4); Infinity only in live mode and the race-over state;
//  - after a live -> replay switch the R7 gate follows the type of the
//    session on screen (the live one until the replay lands), never the pill.
// Synthetic fixtures run everywhere; blocks on cached sessions skip when the
// cache is absent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__phase3EdgeFixtures;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn((y, r, t) => fx().getSession(y, r, t));
  mocked.getFrames = vi.fn(async (y, r, t) => fx().getFrames(y, r, t));
  mocked.getLiveStatus = vi.fn(async () => fx().liveStatus);
  mocked.getLiveSnapshot = vi.fn(async () => fx().snapshot);
  mocked.loadLiveFullSession = vi.fn(() => fx().loadLiveFullSession());
  mocked.stopMockReplay = vi.fn(() => fx().stopMockReplay());
  return mocked;
});
vi.mock('../utils/liveWebSocket', () => ({
  liveWS: {
    connect: vi.fn((onMessage, onStatus) => { globalThis.__phase3EdgeFixtures.feeds.push({ onMessage, onStatus }); }),
    disconnect: vi.fn(),
  },
}));

// In-memory localStorage for the persist middleware
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const fixtures = {};
globalThis.__phase3EdgeFixtures = fixtures;

const { liveWS } = await import('../utils/liveWebSocket');
const { useF1Store } = await import('../store/useF1Store.js');
const { leaderLapEndTime, computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { viewSessionType, isRaceSession, pitStopMarkers } = await import('../utils/strategyViews.js');
const {
  hasCachedSession, loadCachedSession, listCachedRaces,
} = await import('./helpers/cachedSession.js');

const store = () => useF1Store.getState();
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Synthetic race: drivers AAA (leader) and BBB, `laps` laps of 90 s from session time 1000. */
function syntheticRace(laps = 5) {
  const lapTimes = [];
  for (const [i, drv] of ['AAA', 'BBB'].entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = 1000 + 90 * (n - 1) + i * 2;
      lapTimes.push({
        Driver: drv, LapNumber: n, LapStartTime: start, Time: start + 90, LapTimeSeconds: 90,
        Position: i + 1, Compound: 'MEDIUM', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return {
    lap_times: lapTimes, track_status: [], driver_info: [{ Abbreviation: 'AAA' }, { Abbreviation: 'BBB' }],
    race_results: [], weather_data: [],
  };
}

/** Synthetic replay frames for syntheticRace: every 0.4 s, the leader's lap. */
function syntheticFrames(laps = 5) {
  const frames = [];
  for (let t = 0; t < laps * 90; t += 0.4) {
    const lap = Math.min(laps, 1 + Math.floor(t / 90));
    frames.push({ t: +t.toFixed(1), drivers: { AAA: { lap, x: 0, y: 0 }, BBB: { lap, x: 0, y: 0 } } });
  }
  return { frames, max_time: frames[frames.length - 1].t, total_laps: laps };
}

const REPLAY = syntheticRace();
const REPLAY_FRAMES = syntheticFrames();

beforeEach(() => {
  Object.assign(fixtures, {
    getSession: async () => REPLAY,
    getFrames: async () => REPLAY_FRAMES,
    liveStatus: { active: true, current_lap: 30, total_laps: 53, session_status: 'Started', session_info: { session_type: 'Race' } },
    snapshot: { lap_times: [], track_status: [], driver_info: [] },
    loadLiveFullSession: async () => ({}),
    stopMockReplay: async () => ({}),
    feeds: [],
  });
  liveWS.connect.mockClear();
  liveWS.disconnect.mockClear();
  store().resetSession();
});
afterEach(() => {
  store().resetSession();
  useF1Store.setState({ isLiveMode: false, liveSessionInfo: null });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a live -> replay switch starts a new load generation at once', () => {
  it('a live entry still waiting for its full session never lands on the replay nor reconnects the feed', async () => {
    const full = deferred();
    const stop = deferred();
    fixtures.liveStatus = { ...fixtures.liveStatus, session_status: 'Finished' };
    fixtures.loadLiveFullSession = () => full.promise;
    fixtures.stopMockReplay = () => stop.promise;
    const live = store().enterLiveMode();
    for (let i = 0; i < 200 && !store().isLiveMode; i++) await settle(1);
    expect(store().isLiveMode).toBe(true);

    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' });
    const load = store().loadSession();
    await settle();
    // out of live mode at once, the feed's clock reset with it
    expect(store().isLiveMode).toBe(false);
    expect(store().totalFrames).toBe(0);
    // the live entry's full session lands while the load waits for the mock replay to stop
    full.resolve(syntheticRace(40));
    await settle();
    stop.resolve({});
    await load;
    await live;
    await settle();

    const s = store();
    expect(liveWS.connect).not.toHaveBeenCalled();
    expect(s.isLiveMode).toBe(false);
    expect(s.sessionData.lap_times).toBe(REPLAY.lap_times);
    expect(s.maxLap).toBe(5);
    expect(s.totalFrames).toBe(REPLAY_FRAMES.frames.length);
    expect([s.currentLap, s.currentFrameIndex, s.currentTime]).toEqual([1, 0, 0]);
    expect(s.getSessionNow()).toBe(computeSessionTimeOffset(REPLAY.lap_times));
  });

  it('a message of the feed of before the switch, delivered after the replay load, changes nothing', async () => {
    await store().enterLiveMode();
    expect(liveWS.connect).toHaveBeenCalledTimes(1);
    const [feed] = fixtures.feeds;
    feed.onMessage({ type: 'frame', data: { t: 1, drivers: {} } }); // a live frame, while live
    expect(store().totalFrames).toBe(1);

    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' });
    await store().loadSession();
    await settle();
    expect(liveWS.disconnect).toHaveBeenCalled();
    const before = store();
    const snapshot = {
      currentLap: before.currentLap, maxLap: before.maxLap, totalFrames: before.totalFrames,
      currentFrameIndex: before.currentFrameIndex, frameData: before.frameData, trackStatus: before.trackStatus,
      currentFlagStatus: before.currentFlagStatus, sessionData: before.sessionData, now: before.getSessionNow(),
      liveConnectionStatus: before.liveConnectionStatus,
    };
    expect(snapshot.totalFrames).toBe(REPLAY_FRAMES.frames.length);

    feed.onMessage({ type: 'lap_count', data: { current_lap: 45, total_laps: 53 } });
    feed.onMessage({ type: 'frame', data: { t: 1, drivers: {} } });
    feed.onMessage({ type: 'track_status', data: { status: '4', message: 'SCDeployed' } });
    feed.onMessage({ type: 'lap_update', data: { Driver: 'AAA', LapNumber: 46 } });
    feed.onStatus('connected');
    const after = store();
    expect({
      currentLap: after.currentLap, maxLap: after.maxLap, totalFrames: after.totalFrames,
      currentFrameIndex: after.currentFrameIndex, frameData: after.frameData, trackStatus: after.trackStatus,
      currentFlagStatus: after.currentFlagStatus, sessionData: after.sessionData, now: after.getSessionNow(),
      liveConnectionStatus: after.liveConnectionStatus,
    }).toEqual(snapshot);
    expect(after.frameData.frames).toHaveLength(REPLAY_FRAMES.frames.length);
  });

  it('a second load started while the first one leaves live mode wins', async () => {
    await store().enterLiveMode();
    const stop = deferred();
    fixtures.stopMockReplay = () => stop.promise;
    const other = syntheticRace(7);
    fixtures.getSession = async (y, r) => (r === 98 ? other : REPLAY);
    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' });
    const first = store().loadSession();
    await settle();
    fixtures.stopMockReplay = async () => ({});
    useF1Store.setState({ round: 98 });
    await store().loadSession();
    stop.resolve({});
    await first;
    await settle();
    expect(store().sessionData.lap_times).toBe(other.lap_times);
    expect(store().maxLap).toBe(7);
  });

  it('Disconnect then Load: the exit\'s stop answered last never wipes the loaded replay', async () => {
    await store().enterLiveMode();
    expect(store().isLiveMode).toBe(true);
    // the backend's first stop awaits the replay task, a second one answers at once
    const exitStop = deferred();
    let stops = 0;
    fixtures.stopMockReplay = () => { stops += 1; return stops === 1 ? exitStop.promise : Promise.resolve({}); };
    const exit = store().exitLiveMode(); // SessionMenu handleDisconnectLive
    await settle();
    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' });
    await store().loadSession(); // SessionMenu handleLoad
    await settle();
    expect(store().sessionData.lap_times).toBe(REPLAY.lap_times);
    expect(store().totalFrames).toBe(REPLAY_FRAMES.frames.length);

    exitStop.resolve({}); // the exit's tail lands after the replay
    await exit;
    await settle();
    const s = store();
    expect(s.isLiveMode).toBe(false);
    expect(s.sessionData.lap_times).toBe(REPLAY.lap_times);
    expect(s.totalFrames).toBe(REPLAY_FRAMES.frames.length);
    expect(s.maxLap).toBe(5);
    expect(s.loadedSessionType).toBe('R');
    expect(s.getSessionNow()).toBe(computeSessionTimeOffset(REPLAY.lap_times));
  });

  it('an exit with nothing after it still resets the session', async () => {
    await store().enterLiveMode();
    await store().exitLiveMode();
    const s = store();
    expect([s.isLiveMode, s.sessionData, s.totalFrames, s.maxLap]).toEqual([false, null, 0, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('lap-mode clock on the last lap (R4)', () => {
  /** Lap mode (no frames) at lap `lap` of `session`. */
  function lapMode(session, lap) {
    const lt = session.lap_times;
    const maxLap = Math.max(...lt.map((r) => Number(r.LapNumber) || 0));
    useF1Store.setState({
      sessionData: session, isLiveMode: false, totalFrames: 0, frameData: null, currentTime: 0, maxTime: 0,
      maxLap, currentLap: 1, lapModeRaceOver: false, isQualifyingReplay: false,
      sessionTimeOffset: computeSessionTimeOffset(lt),
    });
    store().setCurrentLap(lap);
    return maxLap;
  }

  it('synthetic: the last lap is the leader\'s end of lap L-1; race over and live are Infinity', () => {
    const L = lapMode(REPLAY, 5);
    expect(store().getSessionNow()).toBe(1000 + 90 * 4 + 0); // AAA (P1) ends lap 4 at 1360
    expect(store().getSessionNow()).toBe(leaderLapEndTime(REPLAY.lap_times, L - 1));
    store().showRaceOver();
    expect(store().getSessionNow()).toBe(Infinity);
    store().setCurrentLap(L); // a lap seek leaves the race-over state
    expect(store().getSessionNow()).toBe(1360);
    useF1Store.setState({ isLiveMode: true });
    expect(store().getSessionNow()).toBe(Infinity);
  });

  const races = listCachedRaces();
  it.skipIf(races.length === 0)(`every cached race (${races.length}): last lap = leader end of lap L-1, never Infinity`, () => {
    for (const { year, round } of races) {
      const s = loadCachedSession(year, round);
      const L = lapMode(s, Math.max(...s.lap_times.map((r) => Number(r.LapNumber) || 0)));
      const now = store().getSessionNow();
      expect(Number.isFinite(now), `${year} R${round}`).toBe(true);
      expect(now, `${year} R${round}`).toBe(leaderLapEndTime(s.lap_times, L - 1));
      store().showRaceOver();
      expect(store().getSessionNow()).toBe(Infinity);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('after a live -> replay switch the R7 gate follows the session on screen', () => {
  const LIVE_Q = { session_type: 'Qualifying', session_name: 'Qualifying' };

  function goLive(info, data = REPLAY) {
    useF1Store.setState({
      isLiveMode: true, liveSessionInfo: info, sessionData: data, loadedSessionType: null,
      isQualifyingReplay: false, error: null, sessionType: 'R',
    });
  }

  it('live qualifying, race load in flight then failed: the live rows keep the qualifying type', async () => {
    goLive(LIVE_Q);
    expect(viewSessionType(store())).toBe('Q');
    const pending = deferred();
    fixtures.getSession = () => pending.promise;
    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' }); // the menu pills
    const load = store().loadSession();
    await settle();
    expect(store().isLiveMode).toBe(false);
    expect(store().sessionData).toBe(REPLAY); // the live rows still on screen
    expect(store().loadedSessionType).toBe('Q');
    expect(viewSessionType(store())).toBe('Q');
    pending.reject(new Error('HTTP 500'));
    await load;
    expect(store().error).toBe('HTTP 500');
    expect(viewSessionType(store())).toBe('Q');
    expect(isRaceSession(viewSessionType(store()))).toBe(false);
  });

  it('live qualifying, race load succeeds: the gate is the loaded replay\'s type', async () => {
    goLive(LIVE_Q);
    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' });
    await store().loadSession();
    expect(store().loadedSessionType).toBe('R');
    expect(viewSessionType(store())).toBe('R');
  });

  it('live race, qualifying load in flight: still a race on screen; the loaded type once it lands', async () => {
    goLive({ session_type: 'Race', session_name: 'Race' });
    const pending = deferred();
    fixtures.getSession = () => pending.promise;
    useF1Store.setState({ year: 2024, round: 99, sessionType: 'FP2' });
    const load = store().loadSession();
    await settle();
    expect(viewSessionType(store())).toBe('R');
    pending.resolve(REPLAY);
    await load;
    expect(viewSessionType(store())).toBe('FP2');
  });

  it.skipIf(!hasCachedSession(2024, 8, 'Q'))('2024 R8 Q rows live, race load in flight and failed: no pit-loss label', async () => {
    const q = loadCachedSession(2024, 8, 'Q');
    goLive(LIVE_Q, q);
    const labelled = () => pitStopMarkers(q.lap_times, { sessionType: viewSessionType(store()) }).filter((m) => m.label);
    expect(pitStopMarkers(q.lap_times, { sessionType: 'Q' }).length).toBeGreaterThan(0); // runs exist
    expect(labelled()).toEqual([]);
    const pending = deferred();
    fixtures.getSession = () => pending.promise;
    useF1Store.setState({ year: 2024, round: 16, sessionType: 'R' });
    const load = store().loadSession();
    await settle();
    expect(store().sessionData).toBe(q);
    expect(labelled()).toEqual([]);
    pending.reject(new Error('HTTP 500'));
    await load;
    expect(store().sessionData).toBe(q);
    expect(labelled()).toEqual([]);
  });
});
