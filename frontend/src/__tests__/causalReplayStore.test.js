// D4 (store part): during a replay the store's analytics read only laps
// completed at sessionNow, the brushed lap range used for analytics never
// goes past the last completed lap, and a pit counts only once it happened.
// Data-dependent: skips when the cached Monza 2024 (R16) is absent.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Fake degradation backend: the same least-squares fit as
// backend/api/routers/predictions.py (lap time on lap number, 0 < t < 200,
// at least 3 laps), over the cached lap table.
function fakeDegradation(req) {
  const lapTimes = globalThis.__causalStoreFixtures.session.lap_times;
  const pts = lapTimes.filter((r) => req.drivers.includes(r.Driver)
    && r.LapNumber >= req.lap_start && r.LapNumber <= req.lap_end
    && r.LapTimeSeconds > 0 && r.LapTimeSeconds < 200);
  if (pts.length < 3) {
    return { slope: null, lap_start: req.lap_start, lap_end: req.lap_end, reason: 'no fit' };
  }
  const n = pts.length;
  const mx = pts.reduce((a, r) => a + r.LapNumber, 0) / n;
  const my = pts.reduce((a, r) => a + r.LapTimeSeconds, 0) / n;
  let sxy = 0, sxx = 0;
  for (const r of pts) {
    sxy += (r.LapNumber - mx) * (r.LapTimeSeconds - my);
    sxx += (r.LapNumber - mx) ** 2;
  }
  return { slope: sxy / sxx, lap_start: req.lap_start, lap_end: req.lap_end, reason: null };
}

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__causalStoreFixtures;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async () => fx().session);
  mocked.getFrames = vi.fn(async () => fx().frames);
  mocked.predictDegradation = vi.fn(async (req) => fakeDegradation(req));
  mocked.predictLSTM = vi.fn(async () => ({}));
  return mocked;
});
vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
// Only the arguments of the Monte Carlo calls are under test
vi.mock('../utils/raceSimulation', () => ({ simulateRaceFinish: vi.fn(() => null) }));

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

const api = await import('../utils/apiClient');
const { simulateRaceFinish } = await import('../utils/raceSimulation');
const { useF1Store, lastCompletedLap, clampLapRange } = await import('../store/useF1Store.js');
const { isLapCompleted, pitOutSeconds } = await import('../utils/raceTime.js');
const {
  hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames,
} = await import('./helpers/cachedSession.js');

const YEAR = 2024;
const ROUND = 16;
const fixtures = {};
globalThis.__causalStoreFixtures = fixtures;
const haveRace = hasCachedSession(YEAR, ROUND) && hasCachedFrames(YEAR, ROUND);

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** Last lap of `driver` completed at sessionNow, read straight from the data. */
function driverLastDone(lapTimes, driver, now) {
  let last = 0;
  for (const r of lapTimes) {
    if (r.Driver === driver && isLapCompleted(r, now) && r.LapNumber > last) last = r.LapNumber;
  }
  return last;
}

/** First frame index whose session time is >= target (session seconds). */
function frameAtSession(target) {
  const s = useF1Store.getState();
  const frames = s.frameData.frames;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t + s.sessionTimeOffset >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe('lastCompletedLap / clampLapRange (synthetic)', () => {
  const laps = [
    { Driver: 'AAA', LapNumber: 1, Time: 100 }, { Driver: 'AAA', LapNumber: 2, Time: 190 },
    { Driver: 'BBB', LapNumber: 1, Time: 102 }, { Driver: 'BBB', LapNumber: 2, Time: 195 },
  ];
  it('per driver, min over drivers, leader without drivers', () => {
    expect(lastCompletedLap(laps, 192, ['AAA'])).toBe(2);
    expect(lastCompletedLap(laps, 192, ['BBB'])).toBe(1);
    expect(lastCompletedLap(laps, 192, ['AAA', 'BBB'])).toBe(1);
    expect(lastCompletedLap(laps, 192)).toBe(2);
    expect(lastCompletedLap(laps, 50)).toBe(0);
    expect(lastCompletedLap(laps, Infinity, ['BBB'])).toBe(2);
  });
  it('clamps the end, null when nothing of the range is completed', () => {
    expect(clampLapRange([10, 25], 17)).toEqual([10, 17]);
    expect(clampLapRange([10, 25], 30)).toEqual([10, 25]);
    expect(clampLapRange([10, 25], 9)).toBeNull();
    expect(clampLapRange(null, 9)).toBeNull();
  });
});

describe.skipIf(!haveRace)('causal replay analytics in the store (Monza 2024)', () => {
  let session;

  beforeAll(async () => {
    session = loadCachedSession(YEAR, ROUND);
    fixtures.session = session;
    fixtures.frames = loadCachedFrames(YEAR, ROUND);
    useF1Store.getState().resetSession();
    useF1Store.setState({ year: YEAR, round: ROUND, sessionType: 'R', isLiveMode: false });
    await useF1Store.getState().loadSession();
  }, 120000);

  beforeEach(() => {
    // Lap-change side effects (LSTM, race situation) run on timers: hold them
    vi.useFakeTimers();
    api.predictDegradation.mockClear();
    api.predictLSTM.mockClear();
    simulateRaceFinish.mockClear();
    useF1Store.setState({
      brushLapRange: null, selectedLapRange: null, _degradationRequest: null,
      degradationRegression: null, focusDriver: null, selectedDrivers: [],
    });
    useF1Store.getState().setCurrentFrameIndex(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('brush laps 10-25 at lap 18: the fit uses completed laps only, then follows the replay and freezes after lap 25', async () => {
    const DRIVER = 'PIA';
    const store = () => useF1Store.getState();
    const lapTimes = session.lap_times;
    const req = { year: YEAR, round: ROUND, drivers: [DRIVER], lap_start: 10, lap_end: 25 };

    useF1Store.setState({ brushLapRange: [10, 25] });
    store().setCurrentFrameIndex(store().lapFrameMap[18]);
    expect(store().currentLap).toBe(18);
    let now = store().getSessionNow();
    const doneAt18 = driverLastDone(lapTimes, DRIVER, now);
    expect(doneAt18).toBeLessThan(25);

    await store().fetchDegradationRegression(req);
    expect(api.predictDegradation).toHaveBeenCalledTimes(1);
    const sent = api.predictDegradation.mock.calls[0][0];
    expect(sent.lap_start).toBe(10);
    expect(sent.lap_end).toBe(doneAt18);
    // every lap the fit can read is completed at now
    for (const r of lapTimes) {
      if (r.Driver === DRIVER && r.LapNumber >= sent.lap_start && r.LapNumber <= sent.lap_end) {
        expect(isLapCompleted(r, now)).toBe(true);
      }
    }
    // the stored result echoes the brush and says which laps were fitted
    expect(store().degradationRegression.lap_start).toBe(10);
    expect(store().degradationRegression.lap_end).toBe(25);
    expect(store().degradationRegression.lap_end_used).toBe(doneAt18);
    expect(store().getAnalysisLapRange([DRIVER])).toEqual([10, doneAt18]);

    // Play on frame by frame to the end of lap 40: re-requests follow the
    // completed laps, never ahead of them
    const endIdx = store().lapFrameMap[41];
    const slopes = [];
    for (let i = store().currentFrameIndex + 1; i <= endIdx; i++) {
      const before = api.predictDegradation.mock.calls.length;
      store().setCurrentFrameIndex(i);
      if (api.predictDegradation.mock.calls.length > before) {
        now = store().getSessionNow();
        const call = api.predictDegradation.mock.calls[before][0];
        expect(call.lap_end).toBeLessThanOrEqual(25);
        expect(call.lap_end).toBe(Math.min(25, driverLastDone(lapTimes, DRIVER, now)));
        await flush();
        slopes.push({ lapEnd: call.lap_end, slope: store().degradationRegression.slope });
      }
    }
    await flush();
    const ends = api.predictDegradation.mock.calls.map((c) => c[0].lap_end);
    expect(ends[ends.length - 1]).toBe(25);
    for (let k = 1; k < ends.length; k++) expect(ends[k]).toBeGreaterThan(ends[k - 1]);

    // Once the replay is past lap 25 the fit is final: same request, same slope
    const finalSlope = fakeDegradation({ ...req }).slope;
    expect(store().degradationRegression.slope).toBeCloseTo(finalSlope, 12);
    expect(store().degradationRegression.lap_end_used).toBe(25);
    const lastCallIdx = api.predictDegradation.mock.calls.length;
    store().setCurrentFrameIndex(store().lapFrameMap[50]);
    await flush();
    expect(api.predictDegradation.mock.calls.length).toBe(lastCallIdx);
    expect(store().degradationRegression.slope).toBeCloseTo(finalSlope, 12);
    // the slope while the replay was inside the brush differed from the final one
    expect(slopes.length).toBeGreaterThan(1);
    expect(slopes[0].slope).not.toBeCloseTo(finalSlope, 6);
  });

  it('a backward seek drops a fit that now holds future laps', async () => {
    const store = () => useF1Store.getState();
    useF1Store.setState({ brushLapRange: [10, 25] });
    store().setCurrentFrameIndex(store().lapFrameMap[30]);
    await store().fetchDegradationRegression({ year: YEAR, round: ROUND, drivers: ['PIA'], lap_start: 10, lap_end: 25 });
    expect(store().degradationRegression.lap_end_used).toBe(25);
    store().setCurrentFrameIndex(store().lapFrameMap[15]);
    await flush();
    const last = api.predictDegradation.mock.calls[api.predictDegradation.mock.calls.length - 1][0];
    expect(last.lap_end).toBe(driverLastDone(session.lap_times, 'PIA', store().getSessionNow()));
    expect(store().degradationRegression.lap_end_used).toBe(last.lap_end);
    // Brush entirely in the future: no request, no slope
    store().setCurrentFrameIndex(store().lapFrameMap[5]);
    await flush();
    expect(store().degradationRegression.slope).toBeNull();
    expect(store().degradationRegression.lap_end_used).toBeLessThan(10);
  });

  it('LSTM inputs and rival context use completed laps only', async () => {
    const store = () => useF1Store.getState();
    // Mid-way through leader lap 18
    const idx = store().lapFrameMap[18] + Math.floor((store().lapFrameMap[19] - store().lapFrameMap[18]) / 2);
    store().setCurrentFrameIndex(idx);
    const now = store().getSessionNow();
    useF1Store.setState({ focusDriver: 'PIA' });

    await store().triggerLSTMPredictions();
    expect(api.predictLSTM).toHaveBeenCalledTimes(1);
    const sentLaps = api.predictLSTM.mock.calls[0][0].last_10_laps.map((l) => l.lap_number);
    const piaDone = driverLastDone(session.lap_times, 'PIA', now);
    expect(Math.max(...sentLaps)).toBe(piaDone);
    expect(piaDone).toBeLessThan(store().currentLap);

    // A later lap than the replay is clamped to the replay
    await store().triggerPrediction('PIA', 40);
    const sent2 = api.predictLSTM.mock.calls[1][0];
    expect(sent2.current_lap).toBe(store().currentLap);
    expect(Math.max(...sent2.last_10_laps.map((l) => l.lap_number))).toBe(piaDone);

    store().updateRivalContext();
    const rivals = store().rivalContext;
    expect(rivals.length).toBeGreaterThan(0);
    for (const r of rivals) {
      const lastDone = driverLastDone(session.lap_times, r.driver, now);
      const row = session.lap_times.find((x) => x.Driver === r.driver && x.LapNumber === lastDone);
      expect(r.position).toBe(row.Position);
    }
  });

  it('the focus-driver pit trigger fires at the pit exit, not at the lap change before it', () => {
    const store = () => useF1Store.getState();
    const trigger = vi.fn();
    const noop = vi.fn();
    const saved = {
      triggerLSTMPredictions: store().triggerLSTMPredictions,
      updateRivalContext: store().updateRivalContext,
      computeRaceSituation: store().computeRaceSituation,
    };
    useF1Store.setState({
      focusDriver: 'PIA', triggerLSTMPredictions: trigger, updateRivalContext: noop, computeRaceSituation: noop,
    });
    try {
      // PIA's first stop: the out-lap row carries the pit exit time
      const outLap = session.lap_times
        .filter((r) => r.Driver === 'PIA' && pitOutSeconds(r) != null && r.LapNumber > 1)
        .sort((a, b) => a.LapNumber - b.LapNumber)[0];
      const exit = pitOutSeconds(outLap);
      const exitIdx = frameAtSession(exit);
      const startIdx = store().lapFrameMap[outLap.LapNumber - 1];
      store().setCurrentFrameIndex(startIdx);
      vi.runOnlyPendingTimers();
      trigger.mockClear();

      // Every frame before the pit exit: no pit trigger (lap changes into an
      // odd lap do not predict either)
      for (let i = startIdx + 1; i < exitIdx; i++) {
        const lapBefore = store().currentLap;
        store().setCurrentFrameIndex(i);
        vi.runOnlyPendingTimers();
        const lapChangedToEven = store().currentLap !== lapBefore && store().currentLap % 2 === 0;
        if (!lapChangedToEven) expect(trigger).not.toHaveBeenCalled();
        trigger.mockClear();
      }
      // The frame that crosses the pit exit time fires it
      store().setCurrentFrameIndex(exitIdx);
      vi.runOnlyPendingTimers();
      expect(trigger).toHaveBeenCalledTimes(1);
    } finally {
      useF1Store.setState(saved);
    }
  });

  it('Monte Carlo projections receive sessionNow and sessionTimeOffset', () => {
    const store = () => useF1Store.getState();
    store().setCurrentFrameIndex(store().lapFrameMap[18] + 10);
    useF1Store.setState({
      raceSituationData: { driverFeatures: { PIA: {}, NOR: {} } },
      simulatorStrategy: { driver: 'PIA', stints: [{ compound: 'HARD', lapStart: 1, length: 53 }] },
    });
    store().computeRaceProjection();
    store().runSimulation();
    // projection + simulator baseline + simulator custom run
    expect(simulateRaceFinish).toHaveBeenCalledTimes(3);
    for (const [args] of simulateRaceFinish.mock.calls) {
      expect(args.sessionNow).toBe(store().getSessionNow());
      expect(Number.isFinite(args.sessionNow)).toBe(true);
      expect(args.sessionTimeOffset).toBe(store().sessionTimeOffset);
    }
    useF1Store.setState({ raceSituationData: null, simulatorStrategy: null });
  });
});
