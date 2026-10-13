// R8, R5 (frontend events), R2 (store stops) and the store parts of D2 / D4 /
// D5: the replay clock is reset on every session load / reset / qualifying
// segment change, a qualifying segment has its own origin, every
// clock-derived analytic follows any clock jump, and the timeline and
// race-control lists show only what has happened at the replay's now.
// Data-dependent blocks skip when their cached session is absent.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// Serve cached sessions through the real load path (loadSession -> loadFrames)
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__replayClockFixtures;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async (y, r, t) => fx().sessions[`${y}_${r}_${t}`]);
  mocked.getFrames = vi.fn(async (y, r, t) => {
    if (fx().framesGate) await fx().framesGate;
    return fx().frames[`${y}_${r}_${t}`] || {};
  });
  mocked.predictLSTM = vi.fn(async () => (fx().lstm ? fx().lstm() : {}));
  mocked.predictDegradation = vi.fn(async (req) => ({ slope: 0.05, lap_start: req.lap_start, lap_end: req.lap_end }));
  mocked.queryGemini = vi.fn(async () => ({ response: 'ok', scenarios: [] }));
  return mocked;
});
vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));

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
const {
  useF1Store, flagAtSessionTime, weatherAtSessionTime, laterClockReset, formatReplayClock,
  degradationGapReason, qualiSegmentOffsets, loadedSessionTypeOf, flagAtClock,
} = await import('../store/useF1Store.js');
const {
  buildTrackStatusEvents, fastestLapEvent, positionChangeEvents, useReplayEngine,
} = await import('../hooks/useReplayEngine.js');
const {
  mapTrackStatusToLaps, isLapCompleted, lapStartTime, leaderLapEndTime, lapWindows, leaderLapAt,
  computeSessionTimeOffset, raceClockLimit,
} = await import('../utils/raceTime.js');
const { stepLap } = await import('../hooks/useKeyboardShortcuts.js');
const { pitStops, pitLaneVisits } = await import('../utils/stints.js');
const { default: RaceControlFeed } = await import('../components/ui/RaceControlFeed.jsx');
const { default: RaceControlPanel } = await import('../components/visualizations/RaceControlPanel.jsx');
const { default: StrategyTimeline } = await import('../components/visualizations/StrategyTimeline.jsx');
const {
  viewSessionType, pitStopMarkers, pitCountsByDriver, PIT_LOSS_LEGEND,
} = await import('../utils/strategyViews.js');
const { default: Leaderboard } = await import('../components/visualizations/Leaderboard.jsx');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');
const { trackMapSessionNow } = await import('../utils/views/trackMap.js');
const {
  hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames, listCachedRaces,
} = await import('./helpers/cachedSession.js');

const fixtures = { sessions: {}, frames: {} };
globalThis.__replayClockFixtures = fixtures;

const store = () => useF1Store.getState();
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const have = (y, r, t = 'R') => hasCachedSession(y, r, t) && hasCachedFrames(y, r, t);

/** Load a cached session (with its frames) through the store's real load path. */
async function load(year, round, type = 'R') {
  fixtures.sessions[`${year}_${round}_${type}`] = loadCachedSession(year, round, type);
  fixtures.frames[`${year}_${round}_${type}`] = loadCachedFrames(year, round, type);
  useF1Store.setState({ year, round, sessionType: type, isLiveMode: false });
  await store().loadSession();
}

/** Leader rows per lap: the Position-1 row, else the earliest classified one. */
function leaderRows(lapTimes) {
  const byLap = new Map();
  for (const r of lapTimes) {
    if (r.LapNumber == null || r.Time == null || r.Position == null) continue;
    const cur = byLap.get(r.LapNumber);
    const better = !cur
      || (Number(r.Position) === 1 && Number(cur.Position) !== 1)
      || (Number(r.Position) !== 1 && Number(cur.Position) !== 1 && r.Time < cur.Time);
    if (better) byLap.set(r.LapNumber, r);
  }
  return byLap;
}

const lapsWithLeaderStatus = (lapTimes, codes) => [...leaderRows(lapTimes)]
  .filter(([, r]) => codes.some((c) => String(r.TrackStatus ?? '').includes(c)))
  .map(([lap]) => lap).sort((a, b) => a - b);

function covered(events, type) {
  const laps = new Set();
  for (const e of events.filter((ev) => ev.type === type)) {
    for (let l = e.startLap; l <= e.endLap; l++) laps.add(l);
  }
  return [...laps].sort((a, b) => a - b);
}

/** First frame whose session time is >= target. */
function frameAtSession(target) {
  const s = store();
  const frames = s.frameData.frames;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t + s.sessionTimeOffset >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Every clock-derived analytic in the store belongs to a clock <= now. */
function assertNothingFromLaterClock() {
  const s = store();
  const now = s.getSessionNow();
  const stamps = [
    s.raceSituationData?.computedAtNow, s.raceProjection?.computedAtNow,
    s.simulatorResult?.computedAtNow, s.degradationRegression?.computedAtNow,
    s._rivalContextAt, s._lstmAt,
  ];
  for (const at of stamps) {
    if (typeof at === 'number') expect(at).toBeLessThanOrEqual(now);
  }
  if (s.raceSituationData) expect(typeof s.raceSituationData.computedAtNow).toBe('number');
  if (s.raceProjection) expect(typeof s.raceProjection.computedAtNow).toBe('number');
}

/**
 * Server-render an element against the store's CURRENT state. zustand 4.5
 * serves getInitialState() as the server snapshot, so the current state is
 * copied into that object for the render and the object is restored after.
 */
function renderWithStore(element) {
  const initial = useF1Store.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, useF1Store.getState());
  try {
    return renderToString(element);
  } finally {
    for (const k of Object.keys(initial)) delete initial[k];
    Object.assign(initial, saved);
  }
}

/** Render a probe that calls useReplayEngine once (SSR) and return its raceEvents. */
function timelineEvents() {
  let events;
  function Probe() {
    events = useReplayEngine().raceEvents;
    return null;
  }
  renderWithStore(createElement(Probe));
  return events;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  fixtures.framesGate = null;
  fixtures.lstm = null;
});

// ─────────────────────────────────────────────────────────────────────────
describe('formatReplayClock / laterClockReset (synthetic)', () => {
  it('formats replay seconds, negative before replay time 0', () => {
    expect(formatReplayClock(0)).toBe('0:00');
    expect(formatReplayClock(2042.89)).toBe('34:02');
    expect(formatReplayClock(3725)).toBe('1:02:05');
    expect(formatReplayClock(-3318.169)).toBe('-55:18');
    expect(formatReplayClock(null)).toBe('--:--');
  });

  it('drops exactly the analytics computed at a later clock', () => {
    const s = {
      raceSituationData: { computedAtNow: 500 }, raceProjection: { computedAtNow: 300 },
      simulatorResult: { computedAtNow: Infinity }, _rivalContextAt: 400, _lstmAt: 399,
      degradationRegression: { computedAtNow: 450, slope: 0.1 },
      _degradationRequest: { lap_start: 1, lap_end: 9, drivers: ['A'], lap_end_used: 5 },
    };
    const out = laterClockReset(s, 400);
    expect(out.raceSituationData).toBeNull();
    expect(out._prevPcaResult).toBeNull();
    expect('raceProjection' in out).toBe(false);
    expect(out.simulatorResult).toBeNull();
    expect('rivalContext' in out).toBe(false);
    expect('lstmPredictions' in out).toBe(false);
    // the fit belongs to another request: dropped, and the request re-asked
    expect(out.degradationRegression).toBeNull();
    expect(out._degradationRequest.lap_end_used).toBeNull();
    expect(laterClockReset(s, Infinity)).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('degradationGapReason (synthetic)', () => {
  const rows = [
    { Driver: 'AAA', LapNumber: 1, LapStartTime: 100, Time: 190 },
    { Driver: 'AAA', LapNumber: 2, LapStartTime: 190, Time: 280, PitInTimeSeconds: 275 },
    { Driver: 'BBB', LapNumber: 1, LapStartTime: 100, Time: 191 },
    { Driver: 'BBB', LapNumber: 2, LapStartTime: 191, Time: 282 },
    { Driver: 'BBB', LapNumber: 3, LapStartTime: 282, Time: 373 },
  ];
  it('names a retirement only once it is visible, else the laps are still to come', () => {
    expect(degradationGapReason(rows, ['AAA'], Infinity, 3, { AAA: { status: 'Retired' } }))
      .toBe('AAA retired on lap 2: no lap from lap 3 to fit.');
    // pit entry of the final lap reached: the retirement in the pits is known
    expect(degradationGapReason(rows, ['AAA'], 276, 3, { AAA: { status: 'Retired' } }))
      .toBe('AAA retired on lap 2: no lap from lap 3 to fit.');
    // before it: nothing tells the retirement yet
    expect(degradationGapReason(rows, ['AAA'], 200, 3, { AAA: { status: 'Retired' } }))
      .toBe('No lap of the brushed range is completed yet at the current replay time.');
    expect(degradationGapReason(rows, ['ZZZ'], Infinity, 3)).toBe('No lap data for ZZZ: no lap from lap 3 to fit.');
    expect(degradationGapReason(rows, ['BBB'], Infinity, 5)).toBe("BBB's last lap is 3: no lap from lap 5 to fit.");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('timeline events helpers (synthetic, future rows never change the past)', () => {
  const base = [
    { Driver: 'AAA', LapNumber: 1, LapStartTime: 100, Time: 190, LapTime: 90, Position: 1 },
    { Driver: 'AAA', LapNumber: 2, LapStartTime: 190, Time: 275, LapTime: 85, Position: 1 },
    { Driver: 'BBB', LapNumber: 1, LapStartTime: 100, Time: 192, LapTime: 92, Position: 5 },
    { Driver: 'BBB', LapNumber: 2, LapStartTime: 192, Time: 280, LapTime: 88, Position: 2 },
  ];
  const future = [
    { Driver: 'BBB', LapNumber: 3, LapStartTime: 280, Time: 360, LapTime: 80, Position: 6 },
  ];
  it('fastest lap and position changes come from completed laps only', () => {
    const now = 300; // BBB lap 3 (80 s, a 4-place loss) is running
    const a = fastestLapEvent(base, now);
    const b = fastestLapEvent([...base, ...future], now);
    expect(b).toEqual(a);
    expect(a.driver).toBe('AAA');
    expect(a.description).toBe('Fastest lap so far: AAA (1:25.000)');
    expect(positionChangeEvents([...base, ...future], now)).toEqual(positionChangeEvents(base, now));
    expect(positionChangeEvents(base, now).map((e) => e.lap)).toEqual([2]);
    // once lap 3 is over it counts
    expect(fastestLapEvent([...base, ...future], 360).driver).toBe('BBB');
    expect(fastestLapEvent([...base, ...future], Infinity).description).toBe('Fastest lap: BBB (1:20.000)');
    expect(positionChangeEvents([...base, ...future], 360).map((e) => e.lap)).toEqual([2, 3]);
    expect(fastestLapEvent(base, 200)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('live track status: the lap in force is stamped on each change', () => {
  it('places live periods on the timeline with the stamped laps', () => {
    useF1Store.setState({
      isLiveMode: true, currentLap: 21, maxLap: 21, trackStatus: [], sessionData: { lap_times: [] },
    });
    const handle = store()._handleLiveMessage;
    const lapCount = (n) => handle({ type: 'lap_count', data: { current_lap: n, total_laps: 56 } });
    const status = (code, msg) => handle({ type: 'track_status', data: { status: code, start_time: 1.7e9, end_time: null, message: msg } });
    lapCount(22); status('6', 'VSCDeployed');
    lapCount(23); status('4', 'SCDeployed');
    lapCount(27); status('1', 'AllClear');
    const ts = store().trackStatus;
    expect(ts.map((p) => [p.status, p.start_lap, p.end_lap])).toEqual([
      ['6', 22, 23], ['4', 23, 27], ['1', 27, undefined],
    ]);
    expect(store().currentFlagStatus).toBe('1');
    const events = buildTrackStatusEvents({ trackStatus: ts, lapTimes: [], maxLap: 56 });
    expect(events.map((e) => [e.type, e.startLap, e.endLap])).toEqual([['VSC', 22, 23], ['SAFETY_CAR', 23, 27]]);
    useF1Store.setState({ isLiveMode: false });
    store().resetSession();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!(have(2024, 16) && have(2024, 5)))('R8: the replay clock is reset on session load and reset (D2 problem 2)', () => {
  it('play Monza to frame 8000, then load China as SessionMenu does: no old replay time', async () => {
    vi.useFakeTimers();
    await load(2024, 16);
    store().setCurrentFrameIndex(8000);
    expect(store().currentTime).toBeGreaterThan(3000);
    useF1Store.setState({ isPlaying: true });

    // China loads; its frames are held back so the frame-less window is seen
    let release;
    fixtures.framesGate = new Promise((r) => { release = r; });
    fixtures.sessions['2024_5_R'] = loadCachedSession(2024, 5);
    fixtures.frames['2024_5_R'] = loadCachedFrames(2024, 5);
    useF1Store.setState({ year: 2024, round: 5, sessionType: 'R' });
    const loading = store().loadSession();
    await flush();
    const china = fixtures.sessions['2024_5_R'];
    let s = store();
    expect(s.sessionData.lap_times).toBe(china.lap_times);
    expect(s.isPlaying).toBe(false);
    expect([s.currentTime, s.maxTime, s.currentFrameIndex, s.totalFrames]).toEqual([0, 0, 0, 0]);
    expect(s.sessionTimeOffset).toBeCloseTo(3318.169, 3);
    // the race start, not 3318.169 + 3200 (the verifier's 6518.169)
    expect(s.getSessionNow()).toBe(s.sessionTimeOffset);
    expect(s.currentFlagStatus).toBe(flagAtSessionTime(china.track_status, s.getSessionNow()));
    const startWeather = weatherAtSessionTime(china.weather_data, s.getSessionNow());
    expect(startWeather.Time).toBeCloseTo(3288.257, 3);

    release();
    await loading;
    s = store();
    expect(s.totalFrames).toBe(fixtures.frames['2024_5_R'].frames.length);
    expect(s.currentFrameIndex).toBe(0);
    expect(s.currentTime).toBe(fixtures.frames['2024_5_R'].frames[0].t);
    expect(s.getSessionNow()).toBeCloseTo(3318.169 + s.currentTime, 6);
    expect(s.currentFlagStatus).toBe(flagAtSessionTime(china.track_status, s.getSessionNow()));
    expect(weatherAtSessionTime(china.weather_data, s.getSessionNow())).toBe(startWeather);
  });

  it('resetSession clears currentTime, maxTime, frames and flag', async () => {
    vi.useFakeTimers();
    await load(2024, 16);
    store().setCurrentFrameIndex(8000);
    useF1Store.setState({ currentFlagStatus: '4', raceProjection: { computedAtNow: 1 } });
    store().resetSession();
    const s = store();
    expect([s.currentTime, s.maxTime, s.currentFrameIndex, s.totalFrames, s.frameDt]).toEqual([0, 0, 0, 0, 0.4]);
    expect(s.currentFlagStatus).toBe('1');
    expect(s.frameData).toBeNull();
    expect(s.raceProjection).toBeNull();
    expect(s.sessionTimeOffset).toBe(0);
  });

  // Round 3 (D2 problem 1): a historical load still in flight never lands on
  // what replaced it. Each switch (live entry, live exit, the reset to the
  // selector) starts a new load generation, so the old frames are dropped.
  const leaveFor = {
    enterLiveMode: async () => {
      api.getLiveStatus.mockResolvedValueOnce({
        active: true, current_lap: 12, total_laps: 56, session_status: 'Started',
      });
      api.getLiveSnapshot.mockResolvedValueOnce({
        lap_times: [], track_status: [{ status: '4', start_time: 1, message: 'SCDeployed' }], driver_info: [],
      });
      await store().enterLiveMode();
    },
    exitLiveMode: async () => {
      useF1Store.setState({ isLiveMode: true });
      await store().exitLiveMode();
    },
    resetSession: async () => { store().resetSession(); },
  };
  for (const [name, leave] of Object.entries(leaveFor)) {
    it(`frames of a 2024 R16 load still in flight when ${name} runs are discarded (round 3)`, async () => {
      vi.useFakeTimers();
      let release;
      fixtures.framesGate = new Promise((r) => { release = r; });
      fixtures.sessions['2024_16_R'] = loadCachedSession(2024, 16);
      fixtures.frames['2024_16_R'] = loadCachedFrames(2024, 16);
      useF1Store.setState({ year: 2024, round: 16, sessionType: 'R', isLiveMode: false });
      const loading = store().loadSession();
      await flush();
      expect(store().isLoadingFrames).toBe(true);
      expect(store().totalFrames).toBe(0);

      await leave();
      release();
      await loading;
      await flush();
      const s = store();
      expect([s.totalFrames, s.currentTime, s.maxTime, s.currentFrameIndex]).toEqual([0, 0, 0, 0]);
      expect(s.frameData).toBeNull();
      expect(s.lapFrameMap).toBeNull();
      expect(s.isLoadingFrames).toBe(false);
      expect(s.isLoading).toBe(false); // the abandoned load leaves no spinner behind
      if (name === 'enterLiveMode') {
        expect(s.isLiveMode).toBe(true);
        expect(s.currentLap).toBe(12); // the feed's lap, not R16's lap-12 frame clock
        expect(s.maxLap).toBe(1);      // the snapshot's rows, not R16's 53 laps
        expect(s.currentFlagStatus).toBe('4');
        // the next live position frame starts the live list, not R16's 11406 frames
        s._handleLiveMessage({ type: 'frame', data: { t: 1, drivers: {} } });
        expect(store().totalFrames).toBe(1);
      } else {
        expect(s.isLiveMode).toBe(false);
        expect(s.sessionData).toBeNull();
        expect(s.maxLap).toBe(1);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// The session-type pill (store.sessionType) is the type of the NEXT load: the
// session menus change it without loading. The R7 gate must follow the type of
// the session on screen (loadedSessionType, recorded by loadSession).
describe.skipIf(!(hasCachedSession(2026, 1, 'FP2') && have(2024, 16)))('R7: the session-type gate follows the loaded session, not the pill, in the views and the store (round 2)', () => {
  /** Visible text of a StrategyTimeline render at the store's current state. */
  const timelineText = () => renderWithStore(createElement(StrategyTimeline))
    .replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const QUALI_NOTE = 'pit loss is shown in race sessions only';

  it('FP2 loaded, then the Race pill (no load): no pit-loss labels on practice runs', async () => {
    vi.useFakeTimers();
    const fp2 = loadCachedSession(2026, 1, 'FP2');
    fixtures.sessions['2026_1_FP2'] = fp2;
    useF1Store.setState({ year: 2026, round: 1, sessionType: 'FP2', isLiveMode: false });
    await store().loadSession();
    expect(store().loadedSessionType).toBe('FP2');
    useF1Store.setState({ currentLap: store().maxLap });

    store().setSessionType('R'); // SettingsTabContent / SessionMenu pill: no load
    const s = store();
    expect(s.sessionType).toBe('R');
    expect(loadedSessionTypeOf(s)).toBe('FP2');
    expect(viewSessionType(s)).toBe('FP2');
    const markers = pitStopMarkers(fp2.lap_times, { sessionType: viewSessionType(s) });
    expect(markers.length).toBeGreaterThan(0); // runs as stints
    expect(markers.filter((m) => m.label)).toEqual([]);
    const t = timelineText();
    expect(t).toContain(QUALI_NOTE);
    expect(t).not.toContain(PIT_LOSS_LEGEND);
  });

  it('FP2 in the store: no race projection, simulator run or Gemini pit loss (R7 in the store)', async () => {
    vi.useFakeTimers();
    fixtures.sessions['2026_1_FP2'] = loadCachedSession(2026, 1, 'FP2');
    useF1Store.setState({ year: 2026, round: 1, sessionType: 'FP2', isLiveMode: false });
    await store().loadSession();
    store().setCurrentLap(20);
    vi.advanceTimersByTime(5000); // the clock-jump recompute (race situation + projection)
    let s = store();
    // the inputs exist (before this fix a 'race' pit loss of 3 practice runs, 42.5 s, got through)
    expect(s.raceSituationData?.driverFeatures).toBeTruthy();
    store().computeRaceProjection();
    s = store();
    expect(s.raceProjection).toBeNull();
    const drv = s.raceSituationData.driverAbbrs[0];
    useF1Store.setState({
      simulatorStrategy: { driver: drv, stints: [{ compound: 'SOFT', lapStart: 1, length: 10 }, { compound: 'MEDIUM', lapStart: 11, length: 24 }] },
      isSimulatorActive: true,
    });
    store().runSimulation();
    expect(store().simulatorResult).toBeNull();
    api.queryGemini.mockClear();
    const sent = store().sendGeminiQuery('when should I pit?');
    await vi.runAllTimersAsync();
    await sent;
    expect(api.queryGemini).toHaveBeenCalledTimes(1);
    const ctx = api.queryGemini.mock.calls[0][0].race_context;
    expect(ctx).toBeTruthy();
    expect(ctx.raceParams?.pitLoss ?? null).toBeNull();
  });

  it('race loaded, then the Qualifying pill (no load): the race keeps its pit-loss legend', async () => {
    vi.useFakeTimers();
    await load(2024, 16);
    expect(store().loadedSessionType).toBe('R');
    useF1Store.setState({ totalFrames: 0, currentLap: 30 }); // lap mode, lap 30
    expect(timelineText()).toContain(PIT_LOSS_LEGEND);

    store().setSessionType('Q');
    expect(viewSessionType(store())).toBe('R');
    const t = timelineText();
    expect(t).toContain(PIT_LOSS_LEGEND);
    expect(t).not.toContain(QUALI_NOTE);

    // reset: nothing on screen, the pill is all there is
    store().resetSession();
    expect(store().loadedSessionType).toBeNull();
    expect(viewSessionType(store())).toBe('Q');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!have(2024, 8, 'Q'))('R8: qualifying replay, one origin per segment (D2 problem 3)', () => {
  let session;
  let segments;
  beforeAll(async () => {
    await load(2024, 8, 'Q');
    session = fixtures.sessions['2024_8_Q'];
    segments = fixtures.frames['2024_8_Q'].segments;
  }, 120000);

  it('mirrors the extractor lap choice: the FastF1 origins of every segment', () => {
    const s = store();
    expect(s.isQualifyingReplay).toBe(true);
    // FastF1 3.x on the raw 2024 R8 qualifying with the extractor's code
    // (split_qualifying_sessions, pick_fastest, min telemetry SessionTime):
    // Q1 1511.792, Q2 2471.405, Q3 3846.252 s
    expect(s.qualiSegmentOffsets.Q1).toBeCloseTo(1511.792, 3);
    expect(s.qualiSegmentOffsets.Q2).toBeCloseTo(2471.405, 3);
    expect(s.qualiSegmentOffsets.Q3).toBeCloseTo(3846.252, 3);
    expect(qualiSegmentOffsets(session.lap_times, segments)).toEqual(s.qualiSegmentOffsets);
    // the old single offset (first lap start of the session) is far off
    expect(Math.min(...session.lap_times.map((r) => r.LapStartTime).filter((v) => v > 0))).toBeCloseTo(779.008, 3);
    expect(s.qualiSegment).toBe('Q3');
    expect(s.sessionTimeOffset).toBe(s.qualiSegmentOffsets.Q3);
  });

  it('every driver starts moving in the frames within one frame step of LapStartTime - origin', () => {
    const offsets = store().qualiSegmentOffsets;
    let checked = 0;
    for (const seg of ['Q1', 'Q2', 'Q3']) {
      const frames = segments[seg].frames;
      const dt = frames[1].t - frames[0].t;
      for (const drv of Object.keys(frames[0].drivers)) {
        const p0 = frames[0].drivers[drv];
        const k = frames.findIndex((f) => f.drivers[drv].x !== p0.x || f.drivers[drv].y !== p0.y);
        expect(k).toBeGreaterThan(0);
        const tMove = frames[k].t;
        // A personal-best lap of the driver starts at origin + [tMove - dt, tMove]
        const match = session.lap_times.some((r) => {
          if (r.Driver !== drv || r.IsPersonalBest !== true) return false;
          const rel = lapStartTime(r) - offsets[seg];
          return rel >= tMove - dt - 1e-6 && rel <= tMove + 1e-6;
        });
        expect(match, `${seg} ${drv}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(20 + 15 + 9);
  });

  it('switching segment resets clock, offset, flag and weather; the Q1 yellow is shown in Q1', () => {
    vi.useFakeTimers();
    store().setCurrentFrameIndex(500);
    expect(store().currentTime).toBeGreaterThan(0);
    store().setQualiSegment('Q1');
    let s = store();
    const q1 = s.qualiSegmentOffsets.Q1;
    expect(s.qualiSegment).toBe('Q1');
    expect([s.currentFrameIndex, s.currentTime]).toEqual([0, segments.Q1.frames[0].t]);
    expect(s.maxTime).toBe(segments.Q1.max_time);
    expect(s.sessionTimeOffset).toBe(q1);
    expect(s.getSessionNow()).toBeCloseTo(q1, 6);
    expect(s.currentFlagStatus).toBe(flagAtSessionTime(session.track_status, q1));
    const w = weatherAtSessionTime(session.weather_data, s.getSessionNow());
    expect(w.Time).toBeLessThanOrEqual(q1);

    // Every Q1 frame shows the status in force at frame.t + Q1 origin; the
    // yellow at 1584.022-1585.76 s is inside Q1 and is shown
    const shown = new Set();
    for (let i = 0; i < segments.Q1.frames.length; i++) {
      store().setCurrentFrameIndex(i);
      s = store();
      expect(s.currentFlagStatus).toBe(flagAtSessionTime(session.track_status, segments.Q1.frames[i].t + q1));
      shown.add(s.currentFlagStatus);
    }
    expect(shown.has('2')).toBe(true);
    // The segment's last frame is not the end of the session
    expect(Number.isFinite(store().getSessionNow())).toBe(true);
    expect(store().getSessionNow()).toBeCloseTo(q1 + segments.Q1.frames[segments.Q1.frames.length - 1].t, 6);

    store().setQualiSegment('Q2');
    expect(store().sessionTimeOffset).toBe(store().qualiSegmentOffsets.Q2);
    expect(store().currentTime).toBe(segments.Q2.frames[0].t);
  });

  it('Leaderboard PIT column = the Strategy Timeline STOPS badge (tyre changes at now, R2; round 2)', () => {
    vi.useFakeTimers();
    const lt = session.lap_times;
    for (const seg of ['Q1', 'Q3']) {
      store().setQualiSegment(seg);
      const frames = segments[seg].frames;
      for (const k of [Math.floor(frames.length / 2), frames.length - 1]) {
        store().setCurrentFrameIndex(k);
        useF1Store.setState({ leaderboardColumnMode: 3 }); // PIT
        const now = store().getSessionNow();
        expect(Number.isFinite(now)).toBe(true);
        const badge = pitCountsByDriver(pitStopMarkers(lt, { sessionNow: now, sessionType: 'Q' }));
        // one tower row per driver of the segment: "<pos> <CODE> ... <n>P"
        const rows = renderWithStore(createElement(Leaderboard, { collapsed: false }))
          .split('tower-row__pos-group').slice(1)
          .map((chunk) => ({
            code: /\b([A-Z]{3})\b/.exec(chunk.replace(/<[^>]+>/g, ' '))?.[1],
            pits: Number(/tower-pit-count[^>]*>(\d+)/.exec(chunk)?.[1]),
          }));
        const segDrivers = Object.keys(segments[seg].driver_colors);
        expect(rows.map((r) => r.code).sort()).toEqual([...segDrivers].sort());
        for (const r of rows) expect(r.pits, `${seg} frame ${k} ${r.code}`).toBe(badge[r.code] || 0);
        if (k === frames.length - 1) expect(rows.some((r) => r.pits > 0)).toBe(true);
      }
    }
  });

  it('TrackMap: the last frame of a segment is not the end of the session, and nobody "wins" (round 2, D2 problem 1)', () => {
    vi.useFakeTimers();
    const plain = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const seg of ['Q1', 'Q2', 'Q3']) {
      store().setQualiSegment(seg);
      const frames = segments[seg].frames;
      store().setCurrentFrameIndex(frames.length - 1);
      const s = store();
      // the store's clock at the segment's last frame: finite (origin + frame.t)
      expect(s.getSessionNow()).toBeCloseTo(s.qualiSegmentOffsets[seg] + frames[frames.length - 1].t, 6);
      // the map uses the same clock: no chequered flag, no winner
      const map = plain(renderWithStore(createElement(TrackMap)));
      expect(map, seg).not.toContain('CHEQUERED FLAG');
      expect(map, seg).not.toMatch(/ WINS\b/);
      // the map's own clock (frame on screen) = the store's now, not Infinity
      expect(trackMapSessionNow({
        ...s, frameTime: s.frameData.frames[s.currentFrameIndex].t, lapTimes: s.sessionData.lap_times,
      })).toBe(s.getSessionNow());
      const board = plain(renderWithStore(createElement(Leaderboard, { collapsed: false })));
      expect(board, seg).not.toContain('CHEQUERED FLAG');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!have(2024, 16))('R8: clock-derived analytics follow every clock jump (Monza 2024, D5 problem 1)', () => {
  let session;
  beforeAll(async () => {
    vi.useFakeTimers();
    await load(2024, 16);
    session = fixtures.sessions['2024_16_R'];
    vi.useRealTimers();
  }, 120000);

  beforeEach(() => {
    vi.useFakeTimers();
    useF1Store.setState({
      focusDriver: null, selectedDrivers: [], brushLapRange: null, selectedLapRange: null,
      _degradationRequest: null, degradationRegression: null, isSimulatorActive: false, simulatorStrategy: null,
    });
    store().setCurrentFrameIndex(0);
    vi.advanceTimersByTime(500);
  });

  const settle = () => vi.advanceTimersByTime(500);
  const stopsAt = (now) => pitStops(session.lap_times, { sessionNow: now }).length;

  it('seek back from lap 51 to laps 10 and 3: projection and pit loss never from a later clock', async () => {
    const lfm = store().lapFrameMap;
    store().setCurrentFrameIndex(lfm[51]);
    settle();
    const at51 = store().raceProjection;
    expect(at51).not.toBeNull();
    expect(at51.computedAtLap).toBe(51);
    const n51 = at51.raceParams.pitLoss.n;
    expect(n51).toBeGreaterThan(stopsAt(leaderLapEndTime(session.lap_times, 9)));

    // Lap 10: dropped in the same update as the seek, then recomputed there
    store().setCurrentFrameIndex(lfm[10]);
    expect(store().raceProjection).toBeNull();
    assertNothingFromLaterClock();
    settle();
    const at10 = store().raceProjection;
    const now10 = store().getSessionNow();
    expect(at10.computedAtLap).toBe(10);
    expect(at10.computedAtNow).toBe(now10);
    // the pit loss can only be measured on stops that already happened
    expect(at10.raceParams.pitLoss.n).toBeLessThanOrEqual(stopsAt(now10));
    expect(at10.raceParams.pitLoss.n).toBeLessThan(n51);
    expect(store().raceSituationData.computedAtLap).toBe(10);

    // The Gemini context carries the lap-10 values
    await store().sendGeminiQuery('pit now?');
    const ctx = api.queryGemini.mock.calls.at(-1)[0].race_context;
    expect(ctx.raceParams.pitLoss).toEqual(at10.raceParams.pitLoss);
    expect(ctx.currentLap).toBe(10);

    // Lap 3 through setCurrentLap: no projection is possible there
    store().setCurrentLap(3);
    expect(store().raceProjection).toBeNull();
    settle();
    expect(store().raceProjection).toBeNull();
    assertNothingFromLaterClock();
    await store().sendGeminiQuery('and now?');
    expect(api.queryGemini.mock.calls.at(-1)[0].race_context.raceParams).toBeUndefined();
  });

  it('a backward seek inside the same lap drops what was computed later in that lap', () => {
    const lfm = store().lapFrameMap;
    useF1Store.setState({ focusDriver: 'PIA' });
    const mid = lfm[30] + Math.floor((lfm[31] - lfm[30]) / 2);
    store().setCurrentFrameIndex(mid);
    settle();
    expect(store().raceSituationData).not.toBeNull();
    const later = store().raceSituationData.computedAtNow;
    store().setCurrentFrameIndex(lfm[30] + 2);
    expect(store().currentLap).toBe(30);
    expect(store().getSessionNow()).toBeLessThan(later);
    expect(store().raceSituationData).toBeNull();
    assertNothingFromLaterClock();
    settle();
    expect(store().raceSituationData.computedAtNow).toBe(store().getSessionNow());
    expect(store()._rivalContextAt).toBe(store().getSessionNow());
  });

  it('random seeks (frames and laps, both directions): never a value from a later clock', () => {
    useF1Store.setState({ focusDriver: 'NOR' });
    const n = store().totalFrames;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 25; k++) {
      if (k % 5 === 4) store().setCurrentLap(1 + Math.floor(rnd() * 52));
      else store().setCurrentFrameIndex(Math.floor(rnd() * n));
      assertNothingFromLaterClock();
      if (k % 2 === 0) settle();
      assertNothingFromLaterClock();
    }
  });

  it('an LSTM response requested before a backward seek is discarded', async () => {
    const lfm = store().lapFrameMap;
    useF1Store.setState({ focusDriver: 'PIA', lstmPredictions: null, _lstmAt: null });
    store().setCurrentFrameIndex(lfm[40]);
    let answer;
    fixtures.lstm = () => new Promise((r) => { answer = r; });
    const pending = store().triggerLSTMPredictions();
    store().setCurrentFrameIndex(lfm[12]);
    answer({ PIA: { predicted_times: [90] } });
    await pending;
    expect(store().lstmPredictions).toBeNull();
    // asked at the current clock it is kept, stamped with that clock
    fixtures.lstm = null;
    await store().triggerLSTMPredictions();
    expect(store()._lstmAt).toBe(store().getSessionNow());
  });

  it('degradation: the fitted lap range is exposed, and a retirement is named (D4 problems 10-11)', async () => {
    const lfm = store().lapFrameMap;
    useF1Store.setState({ brushLapRange: [10, 25] });
    store().setCurrentFrameIndex(lfm[18]);
    await store().fetchDegradationRegression({ year: 2024, round: 16, drivers: ['PIA'], lap_start: 10, lap_end: 25 });
    const reg = store().degradationRegression;
    expect(reg.lap_end).toBe(25);
    expect(reg.lap_end_used).toBeLessThan(18);
    expect(reg.fitted_lap_range).toEqual([10, reg.lap_end_used]);

    // TSU retired in the pits on lap 7 (pit entry 3983.674 s). A new brush
    // (no fit of another range held, so the reason is the result itself)
    useF1Store.setState({ brushLapRange: [10, 20], degradationRegression: null });
    store().setCurrentFrameIndex(store().totalFrames - 1);
    expect(store().getSessionNow()).toBe(Infinity);
    await store().fetchDegradationRegression({ year: 2024, round: 16, drivers: ['TSU'], lap_start: 10, lap_end: 20 });
    expect(store().degradationRegression.reason).toBe('TSU retired on lap 7: no lap from lap 10 to fit.');
    expect(store().degradationRegression.fitted_lap_range).toBeNull();
    // before the retirement happened nothing reveals it
    store().setCurrentFrameIndex(frameAtSession(3983.674) - 1);
    await store().fetchDegradationRegression({ year: 2024, round: 16, drivers: ['TSU'], lap_start: 10, lap_end: 20 });
    expect(store().degradationRegression.reason)
      .toBe('No lap of the brushed range is completed yet at the current replay time.');
    store().setCurrentFrameIndex(frameAtSession(3983.674) + 1);
    await store().fetchDegradationRegression({ year: 2024, round: 16, drivers: ['TSU'], lap_start: 10, lap_end: 20 });
    expect(store().degradationRegression.reason).toBe('TSU retired on lap 7: no lap from lap 10 to fit.');
  });

  it('timeline markers are causal: fastest lap, pit stops and position changes (D4 problem 14)', () => {
    const lfm = store().lapFrameMap;
    store().setCurrentFrameIndex(lfm[20]);
    const now = store().getSessionNow();
    const events = timelineEvents();
    const fl = events.filter((e) => e.type === 'FASTEST_LAP');
    expect(fl).toHaveLength(1);
    expect(fl[0]).toEqual(fastestLapEvent(session.lap_times, now));
    const flRow = session.lap_times.find((r) => r.Driver === fl[0].driver && r.LapNumber === fl[0].lap);
    expect(isLapCompleted(flRow, now)).toBe(true);
    // the race's fastest lap is set later than lap 20: not shown yet
    const final = fastestLapEvent(session.lap_times, Infinity);
    expect(final.lap).toBeGreaterThan(20);
    expect(fl[0].lap).toBeLessThan(20);
    // pit stops: exactly the tyre changes whose pit exit is reached
    const pits = events.filter((e) => e.type === 'DRIVER_PIT');
    expect(pits.length).toBe(pitStops(session.lap_times, { sessionNow: now }).length);
    expect(pits.length).toBeLessThan(pitStops(session.lap_times).length);
    for (const e of events.filter((ev) => ev.type === 'POSITION_CHANGE')) {
      const row = session.lap_times.find((r) => r.Driver === e.driver && r.LapNumber === e.lap);
      expect(isLapCompleted(row, now)).toBe(true);
    }
  });

  it('race-control DNF list: TSU only once the pit entry of the retirement is reached', () => {
    store().setCurrentFrameIndex(frameAtSession(3983.674) - 2);
    expect(renderWithStore(createElement(RaceControlPanel))).not.toContain('Out of session');
    store().setCurrentFrameIndex(frameAtSession(3983.674) + 1);
    const html = renderWithStore(createElement(RaceControlPanel));
    expect(html).toContain('Out of session');
    expect(html).toContain('TSU');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!have(2025, 1))('R2: the focus-driver pit trigger counts tyre changes only (2025 R1, NOR)', () => {
  it('SC pit-lane passes on laps 2-4 do not fire it; the lap-35 stop does', async () => {
    vi.useFakeTimers();
    await load(2025, 1);
    const session = fixtures.sessions['2025_1_R'];
    const visits = pitLaneVisits(session.lap_times).filter((v) => v.Driver === 'NOR');
    const stops = pitStops(session.lap_times).filter((v) => v.Driver === 'NOR');
    expect(visits.map((v) => v.inLap)).toEqual([2, 3, 4]);
    expect(stops.map((v) => v.outLap)).toEqual([35, 45]);
    const trigger = vi.fn();
    const noop = vi.fn();
    const saved = {
      triggerLSTMPredictions: store().triggerLSTMPredictions,
      updateRivalContext: store().updateRivalContext,
      computeRaceSituation: store().computeRaceSituation,
    };
    useF1Store.setState({
      focusDriver: 'NOR', triggerLSTMPredictions: trigger, updateRivalContext: noop, computeRaceSituation: noop,
    });
    try {
      // Step over each pit exit; a frame that changes lap into an even lap or
      // turns SC/VSC back to green triggers for its own reasons
      const stepOver = (exit) => {
        const idx = frameAtSession(exit);
        store().setCurrentFrameIndex(idx - 3);
        vi.advanceTimersByTime(500);
        trigger.mockClear();
        let fired = false;
        for (let i = idx - 2; i <= idx + 2; i++) {
          const before = store();
          const lapBefore = before.currentLap;
          const flagBefore = before.currentFlagStatus;
          store().setCurrentFrameIndex(i);
          vi.runOnlyPendingTimers();
          const s = store();
          const otherReason = (s.currentLap !== lapBefore && s.currentLap % 2 === 0)
            || (s.currentFlagStatus === '1' && ['4', '6', '7'].includes(flagBefore));
          if (trigger.mock.calls.length && !otherReason) fired = true;
          trigger.mockClear();
        }
        return fired;
      };
      for (const v of visits) expect(stepOver(v.pitOutTime), `visit lap ${v.inLap}`).toBe(false);
      expect(stepOver(stops[0].pitOutTime)).toBe(true);
    } finally {
      useF1Store.setState(saved);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The flag always follows the dashboard's clock (getSessionNow). Lap mode on
// the last lap is the leader starting it (R4), as the replay's seek to that
// lap; the race-over state (Infinity: skip to end, showRaceOver, as the
// replay's last frame) shows the flag in force at the chequered flag, never a
// period that began after the race (rounds 2-3, D2 problems 2 and 3).
describe('the flag follows the dashboard clock on every lap seek (round 2, D2 problems 2-3)', () => {
  /** Lap-mode store state (no frames) for a cached race. */
  function lapMode(session) {
    useF1Store.setState({
      sessionData: session, trackStatus: session.track_status || [], isLiveMode: false,
      isQualifyingReplay: false, frameData: null, lapFrameMap: null, totalFrames: 0,
      currentTime: 0, maxTime: 0, currentFrameIndex: 0,
      sessionTimeOffset: computeSessionTimeOffset(session.lap_times),
      maxLap: Math.max(...session.lap_times.map((r) => r.LapNumber || 0)),
    });
  }

  it.skipIf(!hasCachedSession(2024, 22))('2024 R22: the last lap is the leader starting lap 50; the race-over state is green, not the yellow 220 s after the finish', () => {
    vi.useFakeTimers();
    const session = loadCachedSession(2024, 22);
    lapMode(session);
    const last = store().maxLap;
    store().setCurrentLap(last);
    // R4 on the last lap too: the leader's end of lap 49
    expect(store().getSessionNow()).toBe(leaderLapEndTime(session.lap_times, last - 1));
    expect(store().currentFlagStatus).toBe('1');
    // the race-over state (the timeline's skip to end): every lap complete
    store().showRaceOver();
    expect(store().lapModeRaceOver).toBe(true);
    expect(store().currentLap).toBe(last);
    expect(store().getSessionNow()).toBe(Infinity);
    const leader = session.lap_times.find((r) => r.LapNumber === last && r.Position === 1);
    expect(String(leader.TrackStatus)).toBe('1');
    expect(flagAtSessionTime(session.track_status, Infinity)).toBe('2'); // the post-race yellow
    expect(store().currentFlagStatus).toBe('1');
    expect(store().currentFlagStatus).toBe(flagAtClock(session.track_status, session.lap_times, Infinity));
    // the race-control feed stops at the chequered flag too: its newest entry
    // is not the post-race yellow the flag pill does not show
    const yellow = session.track_status.filter((e) => Number(e.start_time) > leader.Time);
    expect(yellow.length).toBeGreaterThan(0);
    const html = renderToString(createElement(RaceControlFeed));
    for (const e of yellow) {
      expect(html).not.toContain(formatReplayClock(e.start_time - store().sessionTimeOffset));
    }
    expect(raceClockLimit(session.lap_times, Infinity)).toBe(leader.Time);
    // any lap seek leaves the race-over state
    store().setCurrentLap(last);
    expect(store().lapModeRaceOver).toBe(false);
    expect(store().getSessionNow()).toBe(leaderLapEndTime(session.lap_times, last - 1));
  });

  it.skipIf(!have(2024, 3))('2024 R3 lap 58: lap mode and the replay seek to that lap agree (green), the VSC of lap 58 only in the race-over state', async () => {
    vi.useFakeTimers();
    const session = loadCachedSession(2024, 3);
    lapMode(session);
    const last = store().maxLap;
    expect(last).toBe(58);
    store().setCurrentLap(last);
    const lapNow = store().getSessionNow();
    expect(lapNow).toBe(leaderLapEndTime(session.lap_times, 57));
    expect(store().currentFlagStatus).toBe('1');
    // the VSC deployed during lap 58 is in force at the chequered flag only
    store().showRaceOver();
    expect(store().currentFlagStatus).toBe('6');
    // with frames, the seek to lap 58 shows the same flag as lap mode
    await load(2024, 3);
    store().setCurrentLap(last);
    const replayNow = store().getSessionNow();
    expect(Math.abs(replayNow - lapNow)).toBeLessThan(1);
    expect(store().currentFlagStatus).toBe('1');
    expect(store().currentFlagStatus).toBe(flagAtSessionTime(session.track_status, replayNow));
  }, 120000);

  it.skipIf(!hasCachedSession(2024, 17))('2024 R17 lap 51: the flag at the leader starting the last lap (R4), as on every other lap', () => {
    vi.useFakeTimers();
    const session = loadCachedSession(2024, 17);
    lapMode(session);
    const last = store().maxLap;
    store().setCurrentLap(last);
    const now = leaderLapEndTime(session.lap_times, last - 1);
    expect(store().getSessionNow()).toBe(now);
    expect(store().currentFlagStatus).toBe(flagAtSessionTime(session.track_status, now));
    expect(store().currentFlagStatus).toBe('2');
  });

  it.skipIf(!hasCachedSession(2024, 16))('lap-mode keyboard: ArrowRight past the last lap reaches the race-over state, ArrowLeft returns to the last lap', () => {
    vi.useFakeTimers();
    const session = loadCachedSession(2024, 16);
    lapMode(session);
    const last = store().maxLap;
    store().setCurrentLap(last);
    stepLap(store(), 1);
    expect(store().lapModeRaceOver).toBe(true);
    expect(store().getSessionNow()).toBe(Infinity);
    stepLap(store(), -1);
    expect(store().lapModeRaceOver).toBe(false);
    expect(store().currentLap).toBe(last);
    expect(store().getSessionNow()).toBe(leaderLapEndTime(session.lap_times, last - 1));
  });

  it('every cached race, lap mode, every lap: the flag is the one at getSessionNow; on the last lap one the leader ran his last lap under', () => {
    vi.useFakeTimers();
    const races = listCachedRaces();
    expect(races.length).toBeGreaterThan(0);
    for (const { year, round } of races) {
      const session = loadCachedSession(year, round);
      if (!session.track_status?.length) continue;
      lapMode(session);
      const last = store().maxLap;
      for (let lap = 1; lap <= last; lap++) {
        store().setCurrentLap(lap);
        const s = store();
        expect(s.currentFlagStatus, `${year} R${round} lap ${lap}`)
          .toBe(flagAtClock(session.track_status, session.lap_times, s.getSessionNow()));
      }
      const leader = session.lap_times.find((r) => r.LapNumber === last && Number(r.Position) === 1);
      if (leader?.TrackStatus != null) {
        expect(String(leader.TrackStatus), `${year} R${round} last lap`).toContain(store().currentFlagStatus);
      }
    }
  }, 120000);

  it.skipIf(!have(2024, 8, 'Q'))('qualifying replay: a lap step with no frame keeps the replay clock and its flag (Q1 yellow)', async () => {
    vi.useFakeTimers();
    await load(2024, 8, 'Q');
    store().setQualiSegment('Q1');
    store().setCurrentFrameIndex(181);
    let s = store();
    expect(s.currentFlagStatus).toBe('2');
    const now = s.getSessionNow();
    expect(flagAtSessionTime(s.trackStatus, now)).toBe('2');
    // the keyboard's ArrowRight: setCurrentLap(currentLap + 1), lap 2 has no frame
    store().setCurrentLap(s.currentLap + 1);
    s = store();
    expect(s.getSessionNow()).toBe(now);
    expect(s.currentFlagStatus).toBe('2');
    expect(s.currentFlagStatus).toBe(flagAtSessionTime(s.trackStatus, s.getSessionNow()));
  }, 120000);
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!have(2024, 5))('R5 (frontend): track-status events on the leader lap, causal (2024 R5)', () => {
  let session;
  let frames;
  beforeAll(async () => {
    vi.useFakeTimers();
    await load(2024, 5);
    session = fixtures.sessions['2024_5_R'];
    frames = fixtures.frames['2024_5_R'].frames;
    vi.useRealTimers();
  }, 120000);

  const maxLap = () => store().maxLap;

  it('without frames: SC / VSC bands on the leader laps, the pre-race yellow dropped (D2 problems 4-5)', () => {
    const events = buildTrackStatusEvents({ trackStatus: session.track_status, lapTimes: session.lap_times, maxLap: maxLap() });
    expect(covered(events, 'SAFETY_CAR')).toEqual(lapsWithLeaderStatus(session.lap_times, ['4']));
    expect(covered(events, 'SAFETY_CAR')).toEqual([23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect(covered(events, 'VSC')).toEqual([22, 23]);
    // FIA race control: VSC deployed on lap 22, SC on laps 23 and 27
    expect(events.filter((e) => e.type === 'VSC').map((e) => e.startLap)).toEqual([22]);
    expect(events.filter((e) => e.type === 'SAFETY_CAR').map((e) => e.startLap)).toEqual([23, 27]);
    // Yellow 0-223.861 s ended before the race start (3318.169 s): dropped
    expect(events.some((e) => e.startTime === 0)).toBe(false);
    // same lap spans as the shared rule, and the same with frames
    const mapped = mapTrackStatusToLaps(session.track_status, session.lap_times).filter((p) => String(p.status) !== '1');
    expect(events.map((e) => [e.startLap, e.endLap])).toEqual(mapped.map((p) => [p.start_lap, p.end_lap]));
    const withFrames = buildTrackStatusEvents({
      trackStatus: session.track_status, lapTimes: session.lap_times, frames, maxLap: maxLap(),
      sessionTimeOffset: store().sessionTimeOffset,
    });
    expect(withFrames.map((e) => [e.type, e.startLap, e.endLap])).toEqual(events.map((e) => [e.type, e.startLap, e.endLap]));
  });

  it('causal: a period appears at its start; a running one ends on the leader lap at now', () => {
    const lt = session.lap_times;
    const args = { trackStatus: session.track_status, lapTimes: lt, maxLap: maxLap() };
    // leader lap 22 starts at 5456.2 s, the VSC at 5457.31 s
    const lap22 = leaderLapEndTime(lt, 21);
    let ev = buildTrackStatusEvents({ ...args, sessionNow: lap22 });
    expect(ev.filter((e) => e.type === 'VSC')).toHaveLength(0);
    expect(ev.every((e) => e.startTime <= lap22)).toBe(true);
    // start of leader lap 25: the first SC is running, the second not started
    const lap25 = leaderLapEndTime(lt, 24);
    ev = buildTrackStatusEvents({ ...args, sessionNow: lap25 });
    const sc = ev.filter((e) => e.type === 'SAFETY_CAR');
    expect(sc.map((e) => [e.startLap, e.endLap, e.ongoing])).toEqual([[23, 25, true]]);
    expect(sc[0].endTime).toBe(lap25);
    // VSC ended at 5702.945 s, lap 23: final
    expect(ev.filter((e) => e.type === 'VSC').map((e) => [e.startLap, e.endLap, e.ongoing])).toEqual([[22, 23, false]]);
  });

  it('every cached race: event lap spans = mapTrackStatusToLaps, with and without frames', () => {
    let races = 0;
    for (const { year, round } of listCachedRaces()) {
      const s = loadCachedSession(year, round);
      const maxL = Math.max(...s.lap_times.map((r) => Number(r.LapNumber) || 0));
      const events = buildTrackStatusEvents({ trackStatus: s.track_status, lapTimes: s.lap_times, maxLap: maxL });
      const mapped = mapTrackStatusToLaps(s.track_status, s.lap_times)
        .filter((p) => ['2', '4', '5', '6', '7'].includes(String(p.status)));
      expect(events.map((e) => [e.startLap, e.endLap]), `${year} R${round}`)
        .toEqual(mapped.map((p) => [p.start_lap, p.end_lap]));
      if (hasCachedFrames(year, round)) {
        const withFrames = buildTrackStatusEvents({
          trackStatus: s.track_status, lapTimes: s.lap_times, maxLap: maxL,
          frames: loadCachedFrames(year, round).frames,
          sessionTimeOffset: Math.min(...s.lap_times.map((r) => r.LapStartTime).filter((v) => v > 0)),
        });
        expect(withFrames.map((e) => [e.startLap, e.endLap])).toEqual(events.map((e) => [e.startLap, e.endLap]));
      }
      races++;
    }
    expect(races).toBeGreaterThan(0);
  });

  it('timeline (hook) in replay at lap 22: yellow shown, VSC / SC not yet', () => {
    vi.useFakeTimers();
    store().setCurrentFrameIndex(store().lapFrameMap[22]);
    const events = timelineEvents();
    const now = store().getSessionNow();
    expect(now).toBeLessThan(5457.31);
    expect(events.some((e) => e.type === 'VSC' || e.type === 'SAFETY_CAR')).toBe(false);
    expect(events.some((e) => e.type === 'YELLOW_FLAG' && e.startTime === 5361.06)).toBe(true);
    store().setCurrentFrameIndex(frameAtSession(6300));
    const later = timelineEvents();
    expect(later.filter((e) => e.type === 'SAFETY_CAR').map((e) => e.startLap)).toEqual([23, 27]);
  });

  it('race-control lists: only reached changes, timed on the replay clock (D2 problem 6)', () => {
    vi.useFakeTimers();
    const offset = store().sessionTimeOffset;
    store().setCurrentFrameIndex(0);
    let feed = renderWithStore(createElement(RaceControlFeed));
    let panel = renderWithStore(createElement(RaceControlPanel));
    // at the race start only the pre-race yellow (0 s) has happened
    for (const html of [feed, panel]) {
      expect(html).not.toContain('SCDeployed');
      expect(html).not.toContain('VSCDeployed');
      expect(html).toContain(formatReplayClock(0 - offset));
    }
    // after the first SC deployment (5702.945 s), before the second (6283.584 s)
    store().setCurrentFrameIndex(frameAtSession(6000));
    feed = renderWithStore(createElement(RaceControlFeed));
    panel = renderWithStore(createElement(RaceControlPanel));
    for (const html of [feed, panel]) {
      expect(html).toContain('VSCDeployed');
      expect(html.split('SCDeployed').length - 1).toBe(2); // 'VSCDeployed' + one 'SCDeployed'
      expect(html).toContain(formatReplayClock(5702.945 - offset));
      expect(html).not.toContain(formatReplayClock(6283.584 - offset));
    }
    // the panel places each change on the leader's lap at its time
    const windows = lapWindows(session.lap_times);
    expect(leaderLapAt(windows, 5457.31)).toBe(22);
    expect(panel).toContain('L22');
    expect(panel).toContain('L23');
  });
});
