import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store talks to the backend through apiClient and liveWebSocket: replace
// every network call with a stub that serves the test fixtures below.
vi.mock('../apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__sessionTimeStoreFixtures;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async () => fx().session);
  mocked.getLiveStatus = vi.fn(async () => fx().liveStatus);
  mocked.getLiveSnapshot = vi.fn(async () => fx().snapshot);
  mocked.loadLiveFullSession = vi.fn(async () => fx().fullSession);
  return mocked;
});
vi.mock('../liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));

const { useF1Store } = await import('../../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../raceTime.js');
const { hasCachedSession, loadCachedSession } = await import('../../__tests__/helpers/cachedSession.js');

const fixtures = {};
globalThis.__sessionTimeStoreFixtures = fixtures;

// Small synthetic session on the SESSION clock (start at 500 s, 90 s laps)
function syntheticSession() {
  const lap_times = [];
  for (const [i, d] of ['AAA', 'BBB'].entries()) {
    for (let n = 1; n <= 4; n++) {
      const start = 500 + (n - 1) * 90 + (n > 1 ? i : 0);
      const end = 500 + n * 90 + i;
      lap_times.push({ Driver: d, LapNumber: n, LapStartTime: start, Time: end, LapTimeSeconds: end - start });
    }
  }
  return { lap_times, driver_info: [], race_results: [], track_status: [] };
}

beforeEach(() => {
  useF1Store.getState().resetSession();
  useF1Store.setState({ isLiveMode: false, currentTime: 0, maxTime: 0, frameDt: 0.4 });
});

describe('store sessionTimeOffset and getSessionNow', () => {
  it('starts at 0, and getSessionNow is Infinity with no session', () => {
    expect(useF1Store.getState().sessionTimeOffset).toBe(0);
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
  });

  it('loadSession sets the offset from lap_times; getSessionNow follows lap / replay / live mode', async () => {
    fixtures.session = syntheticSession();
    useF1Store.setState({ year: 2024, round: 99, sessionType: 'R' });
    await useF1Store.getState().loadSession();
    const s = useF1Store.getState();
    expect(s.sessionTimeOffset).toBe(500);
    expect(s.maxLap).toBe(4);
    expect(s.totalFrames).toBe(0);
    // lap mode, lap 1: race start
    expect(s.getSessionNow()).toBe(500);
    // lap mode, lap 3: the leader (AAA) finished lap 2 at 680
    useF1Store.setState({ currentLap: 3 });
    expect(useF1Store.getState().getSessionNow()).toBe(680);
    // last lap: the leader's start of it, as every lap (R4): AAA ended lap 3 at 770
    useF1Store.setState({ currentLap: 4 });
    expect(useF1Store.getState().getSessionNow()).toBe(770);
    // the race-over state (skip to end): no limit; any lap seek leaves it
    useF1Store.getState().showRaceOver();
    expect(useF1Store.getState().lapModeRaceOver).toBe(true);
    expect(useF1Store.getState().currentLap).toBe(4);
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
    useF1Store.getState().setCurrentLap(4);
    expect(useF1Store.getState().lapModeRaceOver).toBe(false);
    expect(useF1Store.getState().getSessionNow()).toBe(770);
    // replay frames loaded: replay time + offset
    useF1Store.setState({ currentLap: 2, totalFrames: 100, currentTime: 123, maxTime: 400, frameDt: 0.4 });
    expect(useF1Store.getState().getSessionNow()).toBe(623);
    // last frame of the replay: no limit
    useF1Store.setState({ currentTime: 399.8 });
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
    // live mode: no limit
    useF1Store.setState({ currentTime: 123, isLiveMode: true });
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
  });

  it('resetSession and exitLiveMode clear the offset', async () => {
    useF1Store.setState({ sessionData: syntheticSession(), sessionTimeOffset: 500 });
    useF1Store.getState().resetSession();
    expect(useF1Store.getState().sessionTimeOffset).toBe(0);
    useF1Store.setState({ sessionData: syntheticSession(), sessionTimeOffset: 500, isLiveMode: true });
    await useF1Store.getState().exitLiveMode();
    expect(useF1Store.getState().sessionTimeOffset).toBe(0);
  });

  it('live lap_update recomputes the offset from the new lap_times', () => {
    useF1Store.setState({ sessionData: { lap_times: [] }, isLiveMode: true, currentLap: 1, maxLap: 1 });
    const handle = useF1Store.getState()._handleLiveMessage;
    handle({ type: 'lap_update', data: { Driver: 'AAA', LapNumber: 1, LapTimeSeconds: 91 } });
    expect(useF1Store.getState().sessionTimeOffset).toBe(0); // live rows carry no session clock
    handle({ type: 'lap_update', data: { Driver: 'BBB', LapNumber: 1, LapStartTime: 700, Time: 791, LapTimeSeconds: 91 } });
    expect(useF1Store.getState().sessionTimeOffset).toBe(700);
    handle({ type: 'lap_update', data: { Driver: 'CCC', LapNumber: 2, LapStartTime: 650, Time: 740, LapTimeSeconds: 90 } });
    expect(useF1Store.getState().sessionTimeOffset).toBe(650);
  });

  it('enterLiveMode sets the offset from the snapshot, then from the full session when finished', async () => {
    fixtures.liveStatus = { active: true, current_lap: 3, total_laps: 4, session_status: 'Started' };
    fixtures.snapshot = { lap_times: [{ Driver: 'AAA', LapNumber: 1, LapTimeSeconds: 91 }], driver_info: [] };
    await useF1Store.getState().enterLiveMode();
    expect(useF1Store.getState().isLiveMode).toBe(true);
    expect(useF1Store.getState().sessionTimeOffset).toBe(0);

    fixtures.liveStatus = { ...fixtures.liveStatus, session_status: 'Finished' };
    fixtures.fullSession = syntheticSession();
    await useF1Store.getState().enterLiveMode();
    expect(useF1Store.getState().sessionData).toBe(fixtures.fullSession);
    expect(useF1Store.getState().sessionTimeOffset).toBe(500);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('store on cached Monza 2024 (R16)', () => {
  it('loadSession gives the race-start offset (~3350.5 s)', async () => {
    fixtures.session = loadCachedSession(2024, 16);
    useF1Store.setState({ year: 2024, round: 16, sessionType: 'R' });
    await useF1Store.getState().loadSession();
    const s = useF1Store.getState();
    expect(s.sessionTimeOffset).toBe(computeSessionTimeOffset(fixtures.session.lap_times));
    expect(s.sessionTimeOffset).toBeCloseTo(3350.5, 0);
  });
});
