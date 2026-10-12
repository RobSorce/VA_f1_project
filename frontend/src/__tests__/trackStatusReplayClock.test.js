// D2: track status and weather are on the SESSION clock (FastF1 SessionTime),
// replay frames on the replay clock (frame.t starts at 0). The store must
// compare them through sessionTimeOffset: session time = frame.t + offset.
// Data-dependent: skips when the cached 2024 R5 (China, VSC + SC) is absent.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

// Serve the cached race through the real load path (loadSession -> loadFrames)
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__trackStatusReplayFixtures;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async () => fx().session);
  mocked.getFrames = vi.fn(async () => fx().frames);
  return mocked;
});
vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));

// In-memory localStorage so the store's persist middleware stays quiet while
// the replay is stepped frame by frame
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { useF1Store, weatherAtSessionTime, flagAtSessionTime } = await import('../store/useF1Store.js');
const { buildTrackStatusEvents } = await import('../hooks/useReplayEngine.js');
const {
  hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames,
} = await import('./helpers/cachedSession.js');

const YEAR = 2024;
const ROUND = 5;
const fixtures = {};
globalThis.__trackStatusReplayFixtures = fixtures;

const haveRace = hasCachedSession(YEAR, ROUND) && hasCachedFrames(YEAR, ROUND);

/**
 * Leader row of each lap: the row classified P1 on that lap; when no row has
 * Position 1, the earliest-finishing classified row (a retiring car's
 * truncated row must not stand for the leader).
 */
function leaderRows(lapTimes) {
  const byLap = new Map();
  for (const r of lapTimes) {
    if (r.LapNumber == null || r.Time == null || r.Position == null) continue;
    const lap = Number(r.LapNumber);
    const cur = byLap.get(lap);
    const better = !cur
      || (Number(r.Position) === 1 && Number(cur.Position) !== 1)
      || (Number(r.Position) !== 1 && Number(cur.Position) !== 1 && r.Time < cur.Time);
    if (better) byLap.set(lap, r);
  }
  return byLap;
}

/** Laps whose leader TrackStatus string contains any of the given codes. */
function lapsWithStatus(leaders, codes) {
  const out = new Set();
  for (const [lap, r] of leaders) {
    if (codes.some((c) => String(r.TrackStatus ?? '').includes(c))) out.add(lap);
  }
  return out;
}

/**
 * Step the replay frame by frame through setCurrentFrameIndex, the real
 * playback path, recording the leader lap and flag of every frame.
 */
function stepAllFrames() {
  const frames = useF1Store.getState().frameData.frames;
  const out = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    useF1Store.getState().setCurrentFrameIndex(i);
    const s = useF1Store.getState();
    out[i] = { lap: s.currentLap, flag: s.currentFlagStatus, t: frames[i].t };
  }
  return out;
}

/**
 * Compare, at leader-lap granularity, the laps where the replay shows one of
 * `codes` with the laps whose leader TrackStatus contains one of them.
 * A lap that differs is tolerated only when a status change of that kind lies
 * within one frame step of that lap's start or end (frame boundary effect).
 */
function compareLaps(steps, codes, leaders, trackStatus, offset, frameDt) {
  const expected = lapsWithStatus(leaders, codes);
  const shown = new Set(steps.filter((x) => codes.includes(x.flag)).map((x) => x.lap));
  // Session-time span of each leader lap on the replay
  const span = new Map();
  for (const x of steps) {
    const ts = x.t + offset;
    const cur = span.get(x.lap);
    if (!cur) span.set(x.lap, [ts, ts]);
    else cur[1] = ts;
  }
  const edges = [];
  for (const p of trackStatus) {
    if (!codes.includes(String(p.status))) continue;
    edges.push(p.start_time);
    if (p.end_time != null) edges.push(p.end_time);
  }
  const nearEdge = (lap) => {
    const sp = span.get(lap);
    if (!sp) return false;
    return edges.some((e) => Math.abs(e - sp[0]) <= frameDt || Math.abs(e - sp[1]) <= frameDt);
  };
  const diff = [...new Set([...expected, ...shown])]
    .filter((lap) => expected.has(lap) !== shown.has(lap));
  return { expected, shown, untolerated: diff.filter((lap) => !nearEdge(lap)) };
}

describe.skipIf(!haveRace)('replay clock vs session clock (2024 R5, SC + VSC)', () => {
  let steps;
  let session;

  beforeAll(async () => {
    session = loadCachedSession(YEAR, ROUND);
    fixtures.session = session;
    fixtures.frames = loadCachedFrames(YEAR, ROUND);
    useF1Store.getState().resetSession();
    useF1Store.setState({ year: YEAR, round: ROUND, sessionType: 'R', isLiveMode: false });
    await useF1Store.getState().loadSession();
    // Lap-change side effects (LSTM, race situation) are not under test
    vi.useFakeTimers();
    steps = stepAllFrames();
    vi.clearAllTimers();
    vi.useRealTimers();
  }, 120000);

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('loads the frames through the real load path, with the min-LapStartTime offset', () => {
    const s = useF1Store.getState();
    expect(s.totalFrames).toBe(fixtures.frames.frames.length);
    const minStart = Math.min(...session.lap_times
      .map((r) => Number(r.LapStartTime)).filter((v) => Number.isFinite(v) && v > 0));
    expect(s.sessionTimeOffset).toBe(minStart);
    expect(s.trackStatus.length).toBe(session.track_status.length);
  });

  it("currentFlagStatus is '4' exactly on the leader laps whose TrackStatus contains '4'", () => {
    const s = useF1Store.getState();
    const leaders = leaderRows(session.lap_times);
    const { expected, shown, untolerated } = compareLaps(
      steps, ['4'], leaders, session.track_status, s.sessionTimeOffset, s.frameDt,
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(untolerated).toEqual([]);
    expect([...shown].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
  });

  it("the VSC flag ('6'/'7') follows the leader laps whose TrackStatus contains it", () => {
    const s = useF1Store.getState();
    const leaders = leaderRows(session.lap_times);
    const { expected, untolerated } = compareLaps(
      steps, ['6', '7'], leaders, session.track_status, s.sessionTimeOffset, s.frameDt,
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(untolerated).toEqual([]);
  });

  it('every frame shows the status in force at frame.t + sessionTimeOffset', () => {
    const offset = useF1Store.getState().sessionTimeOffset;
    for (const x of steps) {
      expect(x.flag).toBe(flagAtSessionTime(session.track_status, x.t + offset));
    }
  });

  it('seeking by lap (setCurrentLap) uses the same clock; live mode keeps the feed flag', () => {
    vi.useFakeTimers();
    const leaders = leaderRows(session.lap_times);
    const onlyStatus = (code) => [...leaders.keys()]
      .filter((l) => String(leaders.get(l).TrackStatus) === code).sort((a, b) => a - b);
    // A lap run entirely under SC: its start frame is under SC
    const sc = onlyStatus('4');
    const green = onlyStatus('1');
    expect(sc.length).toBeGreaterThan(0);
    useF1Store.getState().setCurrentLap(sc[Math.floor(sc.length / 2)]);
    expect(useF1Store.getState().currentFlagStatus).toBe('4');
    useF1Store.getState().setCurrentLap(green[Math.floor(green.length / 2)]);
    expect(useF1Store.getState().currentFlagStatus).toBe('1');

    useF1Store.setState({ isLiveMode: true, currentFlagStatus: '4' });
    useF1Store.getState().updateFlagForLap(green[0]);
    expect(useF1Store.getState().currentFlagStatus).toBe('4');
    useF1Store.setState({ isLiveMode: false });

    // Lap-indexed mode (no frames): the flag at the moment the race LEADER
    // starts lap L = the leader's (Position 1) lap L-1 end (R4,
    // utils/raceTime.js resolveSessionNow), never a retiring car's truncated
    // row: every lap the leader ran entirely under SC shows '4' at its start,
    // lap 28 included (TSU's lap-27 row ends at 6257.294 s inside a yellow,
    // the leader's at 6304.279 s under SC: D2 problem 1)
    expect(sc).toContain(28);
    const saved = (({ frameData, lapFrameMap, totalFrames }) => ({ frameData, lapFrameMap, totalFrames }))(useF1Store.getState());
    try {
      useF1Store.setState({ frameData: null, lapFrameMap: null, totalFrames: 0 });
      for (const lap of sc.filter((l) => l > 1)) {
        useF1Store.getState().setCurrentLap(lap);
        expect(useF1Store.getState().getSessionNow()).toBe(leaders.get(lap - 1).Time);
        expect(useF1Store.getState().currentFlagStatus, `lap ${lap}`).toBe('4');
      }
      for (const lap of green.filter((l) => l > 1 && l < useF1Store.getState().maxLap)) {
        useF1Store.getState().setCurrentLap(lap);
        expect(useF1Store.getState().currentFlagStatus, `lap ${lap}`).toBe('1');
      }
    } finally {
      useF1Store.setState(saved);
    }
  });

  it('weather shown mid-race is the latest row at the SESSION time, not at the replay time', () => {
    const s0 = useF1Store.getState();
    const midLap = Math.round(s0.maxLap / 2);
    const idx = s0.lapFrameMap[midLap];
    expect(idx).toBeDefined();
    vi.useFakeTimers();
    useF1Store.getState().setCurrentFrameIndex(idx + 50);
    const s = useF1Store.getState();
    const frameT = s.frameData.frames[idx + 50].t;
    const sessionT = frameT + s.sessionTimeOffset;
    expect(s.getSessionNow()).toBeCloseTo(sessionT, 6);

    const weather = session.weather_data;
    const shown = weatherAtSessionTime(weather, s.getSessionNow());
    const atOrBefore = weather.filter((w) => w.Time <= sessionT);
    const expected = atOrBefore.reduce((a, b) => (b.Time >= a.Time ? b : a));
    expect(shown).toBe(expected);
    // Nearest row to the session time among the readings already taken;
    // the only nearer row, if any, is a reading not taken yet (in the future)
    const nearest = weather.reduce((a, b) => (Math.abs(b.Time - sessionT) < Math.abs(a.Time - sessionT) ? b : a));
    expect(shown === nearest || nearest.Time > sessionT).toBe(true);
    // ...and within one sampling interval of it (largest gap in the data)
    let maxGap = 0;
    for (let i = 1; i < weather.length; i++) maxGap = Math.max(maxGap, weather[i].Time - weather[i - 1].Time);
    expect(sessionT - shown.Time).toBeGreaterThanOrEqual(0);
    expect(sessionT - shown.Time).toBeLessThanOrEqual(maxGap);
    // The raw replay time picks a row about sessionTimeOffset seconds earlier
    const rawRow = weather.filter((w) => w.Time <= frameT).reduce((a, b) => (b.Time >= a.Time ? b : a));
    expect(rawRow).not.toBe(shown);
  });

  it('timeline SC / VSC bands cover the leader laps whose TrackStatus contains them, with or without frames', () => {
    const s = useF1Store.getState();
    const leaders = leaderRows(session.lap_times);
    for (const frames of [s.frameData.frames, undefined]) {
      const events = buildTrackStatusEvents({
        trackStatus: session.track_status,
        lapTimes: session.lap_times,
        frames,
        maxLap: s.maxLap,
        sessionTimeOffset: s.sessionTimeOffset,
      });
      const covered = (type) => {
        const laps = new Set();
        for (const e of events.filter((ev) => ev.type === type)) {
          for (let l = e.startLap; l <= e.endLap; l++) laps.add(l);
        }
        return [...laps].sort((a, b) => a - b);
      };
      expect(covered('SAFETY_CAR')).toEqual([...lapsWithStatus(leaders, ['4'])].sort((a, b) => a - b));
      expect(covered('VSC')).toEqual([...lapsWithStatus(leaders, ['6', '7'])].sort((a, b) => a - b));
    }
  });
});
