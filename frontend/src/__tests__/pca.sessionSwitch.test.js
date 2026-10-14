// P6 / P3 (round 3): the cross-race PCA answers follow the screen.
//  - P6: a session load drops the previous screen's embeddings and lasso
//    analysis (store pcaScreenReset): the post-race analysis of a race never
//    shows on a practice session of its weekend, nor on the same race
//    reloaded at its start; the selection stays and its analysis is asked
//    again for the new screen (practice: session_now 0, the race not started).
//  - P3: whatever drops the analysis of a selection on screen also asks for it
//    again (refetchDroppedPCA): the frames of a replay moving the clock back
//    (loadFrames -> laterClockReset), and an answer that arrives after the
//    clock moved back; the panel never waits on an analysis nobody asked for.
// Synthetic sessions, mocked API.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__pcaSwitchFx;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn((y, r, t) => fx().getSession(y, r, t));
  mocked.getFrames = vi.fn((y, r, t) => fx().getFrames(y, r, t));
  mocked.stopMockReplay = vi.fn(async () => ({ status: 'not_running' }));
  mocked.analyzePCASelection = vi.fn((ids, opts) => fx().analyze(ids, opts));
  mocked.getPCAEmbeddings = vi.fn((params) => fx().embeddings(params));
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
globalThis.__pcaSwitchFx = fx;
const { useF1Store, pcaScreenReset } = await import('../store/useF1Store.js');

const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
};

const T0 = 2000;
/** A synthetic race: `laps` laps of 95 s from session time T0, three drivers. */
function race(laps, drivers = ['AAA', 'BBB', 'CCC']) {
  const lap_times = [];
  for (const [i, d] of drivers.entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = T0 + 95 * (n - 1) + i * 1.5;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.05 * n,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return { lap_times, track_status: [], driver_info: drivers.map((d) => ({ Abbreviation: d })), race_results: [], weather_data: [] };
}

/** Replay frames of that race: one per 4 s, the leader's lap. */
function frames(laps) {
  const out = [];
  for (let t = 0; t <= 95 * laps; t += 4) {
    const lap = Math.min(laps, 1 + Math.floor(t / 95));
    out.push({ t, drivers: { AAA: { lap }, BBB: { lap }, CCC: { lap } } });
  }
  return { frames: out, max_time: out[out.length - 1].t, total_laps: laps };
}

const IDS = ['AAA_2024_99', 'BBB_2024_99', 'XXX_2023_5'];
// The answer says which request it answers
const answerOf = (opts) => {
  const tag = opts?.year == null ? 'post-race' : `at ${opts.session_now}`;
  return {
    tag, n_selected: 3, n_rest: 10, n_total: 13, feature_importance: [], pit_windows: [],
    strategies: opts?.year == null ? [{ stints: [{ compound: 'HARD', length: 30 }], count: 2, frequency: 1 }] : [],
  };
};

let calls;
beforeEach(() => {
  calls = [];
  const SAME = race(30);
  Object.assign(fx, {
    getSession: async () => SAME,
    getFrames: async () => ({}),
    analyze: async (ids, opts) => { calls.push({ ids, opts }); return answerOf(opts); },
    embeddings: async () => ({ points: [], n_points: 0 }),
  });
  store().resetSession();
  // (resetSession keeps a cross-race selection; each test starts with none)
  useF1Store.setState({ isLiveMode: false, year: 2024, round: 99, sessionType: 'R', selectedPCAPoints: [] });
});

async function postRaceAnalysis() {
  await store().loadSession();
  await settle();
  store().showRaceOver();
  store().setSelectedPCAPoints(IDS);
  await store().fetchPCAAnalysis(IDS);
  expect(store().pcaStrategyAnalysis.tag).toBe('post-race');
  expect(store()._pcaAnalysisAt).toBe(Infinity);
  return store().pcaStrategyAnalysis;
}

describe('P6: a session load drops the previous screen\'s PCA answers', () => {
  it('pcaScreenReset drops the embeddings and the analysis, keeps the selection, and moves both sequences on', () => {
    const s = { _pcaEmbeddingsSeq: 4, _pcaAnalysisSeq: 7, selectedPCAPoints: IDS };
    expect(pcaScreenReset(s)).toEqual({
      pcaEmbeddings: null, _pcaEmbeddingsAt: null, _pcaEmbeddingsSeq: 5,
      pcaStrategyAnalysis: null, pcaAnalysisIds: null, pcaAnalysisError: null, _pcaAnalysisAt: null,
      _pcaAnalysisSeq: 8,
    });
  });

  it('the post-race analysis of the race never shows on its weekend\'s FP2; the FP2 asks with session_now 0', async () => {
    const post = await postRaceAnalysis();
    const before = calls.length;
    useF1Store.setState({ sessionType: 'FP2' });
    const loading = store().loadSession();
    await settle();
    // the screen is the FP2 now: the post-race answer is gone at once
    expect(store().loadedSessionType).toBe('FP2');
    expect(store().pcaStrategyAnalysis).not.toBe(post);
    await loading;
    await settle();
    expect(store().selectedPCAPoints).toEqual(IDS);
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1).opts).toEqual({ year: 2024, round: 99, session_now: 0 });
    expect(store().pcaStrategyAnalysis.tag).toBe('at 0');
    expect(store().pcaStrategyAnalysis.strategies).toEqual([]);
    expect(store().pcaAnalysisIds).toEqual(IDS);
  });

  it('the same race reloaded: the post-race answer is gone before its frames arrive, and asked again at the race start', async () => {
    const post = await postRaceAnalysis();
    const fr = deferred();
    fx.getFrames = () => fr.promise;
    const loading = store().loadSession();
    await settle();
    // frames still loading: lap 1 of the race, no post-race answer on screen
    expect(store().isLoadingFrames).toBe(true);
    expect(store().pcaStrategyAnalysis).not.toBe(post);
    expect(store().pcaStrategyAnalysis?.tag).not.toBe('post-race');
    expect(calls.at(-1).opts).toEqual({ year: 2024, round: 99, session_now: T0 });
    fr.resolve(frames(30));
    await loading;
    await settle();
    expect(store().pcaStrategyAnalysis.tag).toBe(`at ${T0}`);
    expect(store()._pcaAnalysisAt).toBe(T0);
  });

  it('embeddings on screen are dropped and asked again for the new screen', async () => {
    await store().loadSession();
    await settle();
    store().showRaceOver();
    await store().loadPCAEmbeddings();
    const emb = store().pcaEmbeddings;
    expect(emb).toBeTruthy();
    const got = [];
    fx.embeddings = async (params) => { got.push(params); return { points: [], n_points: 0, tag: 'fp2' }; };
    useF1Store.setState({ sessionType: 'FP2' });
    await store().loadSession();
    await settle();
    expect(got).toEqual([{ year: 2024, round: 99, session_now: 0 }]);
    expect(store().pcaEmbeddings.tag).toBe('fp2');
  });
});

describe('P3: a dropped analysis of a selection on screen is asked again', () => {
  it('frames that put the clock before the analysis drop it and ask it again at the frame clock', async () => {
    const fr = deferred();
    fx.getFrames = () => fr.promise;
    const loading = store().loadSession();
    await settle();
    // an analysis from a later clock than the replay's first frame (as after
    // a lap-mode seek while the frames download)
    useF1Store.setState({
      selectedPCAPoints: IDS, pcaStrategyAnalysis: answerOf({ year: 2024, round: 99, session_now: T0 + 500 }),
      pcaAnalysisIds: IDS, _pcaAnalysisAt: T0 + 500,
    });
    const before = calls.length;
    fr.resolve(frames(30));
    await loading;
    await settle();
    expect(store().totalFrames).toBeGreaterThan(0);
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1).opts).toEqual({ year: 2024, round: 99, session_now: T0 });
    expect(store().pcaStrategyAnalysis.tag).toBe(`at ${T0}`);
  });

  it('an answer that arrives after the clock moved back is asked again at the new clock', async () => {
    await store().loadSession();
    await settle();
    useF1Store.setState({ selectedPCAPoints: IDS, currentLap: 20 });
    const first = deferred();
    fx.analyze = (ids, opts) => { calls.push({ ids, opts }); return calls.length === 1 ? first.promise : Promise.resolve(answerOf(opts)); };
    const p = store().fetchPCAAnalysis(IDS);
    const at20 = calls[0].opts.session_now;
    // the clock moves back with no reset of the analysis (none stored yet)
    useF1Store.setState({ currentLap: 10 });
    first.resolve(answerOf(calls[0].opts));
    await p;
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].opts.session_now).toBeLessThan(at20);
    expect(store().pcaStrategyAnalysis.tag).toBe(`at ${calls[1].opts.session_now}`);
  });
});
