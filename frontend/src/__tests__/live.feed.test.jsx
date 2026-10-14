// Live feed in the store and the race-control views (decisions D8, D13, D14):
//  - B6: a 'resync' (the backend dropped this client's backlog and closes
//    the socket) and every session_init (each connect) rebuild the session
//    from the backend's snapshot; a snapshot asked before a newer rebuild is
//    dropped; a finished session's full FastF1 rows are kept;
//  - B4: 'strategy_correction' {Driver, stints} replaces that driver's
//    stints, 'strategy_update' stays append-only;
//  - B5: live track_status start_time is on the session clock: the change
//    closes the previous period at its start, and the race-control lists
//    show the wall clock of received_at, never start_time read as an epoch;
//  - P3d (D8): while the race runs no retirement is inferred from the feed's
//    rows; once the session is over its classification is explicit data.
// Synthetic feeds, mocked API and socket.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal();
  const { createStore } = await import('zustand/vanilla');
  return {
    ...actual,
    create: (createState) => {
      const api = createStore(createState);
      api.getServerState = api.getState;
      return actual.create(api);
    },
  };
});
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__liveFeedFx;
  mocked.setHealthReporter = vi.fn();
  for (const k of ['getLiveStatus', 'getLiveSnapshot', 'loadLiveFullSession', 'getSession']) {
    mocked[k] = vi.fn((...a) => (fx()[k] ? fx()[k](...a) : Promise.resolve({})));
  }
  return mocked;
});
vi.mock('../utils/liveWebSocket', () => ({
  liveWS: {
    connect: vi.fn((onMessage, onStatus) => { globalThis.__liveFeedFx.feed = { onMessage, onStatus }; }),
    disconnect: vi.fn(),
  },
}));
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
globalThis.__liveFeedFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const { raceStandings } = await import('../utils/views/leaderboard.js');
const { default: RaceControlFeed } = await import('../components/ui/RaceControlFeed.jsx');
const { default: RaceControlPanel } = await import('../components/visualizations/RaceControlPanel.jsx');

const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => { let resolve; const promise = new Promise((a) => { resolve = a; }); return { promise, resolve }; };

/** Feed rows of a race so far: `laps` laps of 95 s per driver, session clock from t0. */
function rows(laps, drivers = ['AAA', 'BBB', 'CCC'], t0 = 3000) {
  const out = [];
  for (let n = 1; n <= laps; n++) {
    for (const [i, d] of drivers.entries()) {
      const start = t0 + 95 * (n - 1) + i * 1.5;
      out.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95,
        Position: i + 1, Compound: 'MEDIUM', TyreLife: n, TrackStatus: '1',
      });
    }
  }
  return out;
}
const snapshotOf = (laps, extra = {}) => ({
  lap_times: rows(laps), track_status: [], driver_info: [{ Abbreviation: 'AAA' }, { Abbreviation: 'BBB' }, { Abbreviation: 'CCC' }],
  tyre_strategy: [], race_control_messages: [], team_radios: [], ...extra,
});
const statusOf = (lap, extra = {}) => ({
  active: true, current_lap: lap, total_laps: 53, session_status: 'Started',
  session_info: { session_type: 'Race', session_name: 'Race' }, ...extra,
});

beforeEach(async () => {
  for (const k of Object.keys(fx)) delete fx[k];
  fx.getLiveStatus = async () => statusOf(10);
  fx.getLiveSnapshot = async () => snapshotOf(10);
  store().resetSession();
  useF1Store.setState({ isLiveMode: false, year: 2024, round: 99, sessionType: 'R' });
  for (const f of Object.values(api)) if (f?.mockClear) f.mockClear();
});

async function goLive() {
  await store().enterLiveMode();
  await settle();
  expect(store().isLiveMode).toBe(true);
  return fx.feed;
}

describe('B6 (D14): the store rebuilds from the snapshot on resync and on every session_init', () => {
  it('a reconnect\'s session_init replaces the rows, lap counters and retirements', async () => {
    const feed = await goLive();
    expect(store().sessionData.lap_times.length).toBe(30);
    // messages lost while the socket was down: the reconnect's snapshot has them
    feed.onMessage({
      type: 'session_init',
      data: {
        session: snapshotOf(14, { driver_statuses: [{ Driver: 'CCC', Retired: true, Status: 'Retired', LastLap: 12 }] }),
        frames: { frames: [] },
        status: statusOf(15),
      },
    });
    expect(store().sessionData.lap_times.length).toBe(42);
    expect(store().maxLap).toBe(14);
    expect(store().currentLap).toBe(15);
    expect(store().dnfMap.CCC.status).toBe('Retired');
  });

  it('a resync message asks the snapshot at once; one asked before a newer rebuild is dropped', async () => {
    const feed = await goLive();
    const asked = api.getLiveSnapshot.mock.calls.length;
    fx.getLiveSnapshot = async () => snapshotOf(12);
    feed.onMessage({ type: 'resync', data: { reason: 'client_queue_full' } });
    await settle();
    expect(api.getLiveSnapshot.mock.calls.length).toBe(asked + 1);
    expect(store().sessionData.lap_times.length).toBe(36);

    // a slow snapshot of the resync, overtaken by the reconnect's session_init
    const slow = deferred();
    fx.getLiveSnapshot = () => slow.promise;
    feed.onMessage({ type: 'resync', data: { reason: 'client_queue_full' } });
    await settle();
    feed.onMessage({ type: 'session_init', data: { session: snapshotOf(20), frames: { frames: [] }, status: statusOf(21) } });
    feed.onMessage({ type: 'lap_update', data: rows(21).slice(-3)[0] });
    slow.resolve(snapshotOf(13));
    await settle();
    expect(store().sessionData.lap_times.length).toBe(61);
    expect(store().maxLap).toBe(21);
  });

  it('a finished session keeps its full FastF1 rows; its classification marks the non-finishers (D8)', async () => {
    fx.getLiveStatus = async () => statusOf(53, { session_status: 'Finalised' });
    const full = {
      lap_times: rows(53), track_status: [], driver_info: [],
      race_results: [{ Abbreviation: 'CCC', ClassifiedPosition: 'R', Status: 'Engine', Laps: 30 }],
    };
    fx.loadLiveFullSession = async () => full;
    const feed = await goLive();
    expect(store().sessionData).toBe(full);
    expect(store().dnfMap.CCC).toMatchObject({ status: 'Engine', classifiedPosition: 'R' });
    feed.onMessage({ type: 'session_init', data: { session: snapshotOf(10), frames: { frames: [] }, status: statusOf(53) } });
    expect(store().sessionData).toBe(full);
  });

  it('a session_init of a feed left behind (replay loaded since) changes nothing', async () => {
    const feed = await goLive();
    fx.getSession = async () => ({ lap_times: rows(5, ['XXX']), track_status: [], driver_info: [], race_results: [] });
    await store().loadSession();
    await settle();
    feed.onMessage({ type: 'session_init', data: { session: snapshotOf(40), frames: { frames: [] }, status: statusOf(40) } });
    expect(store().isLiveMode).toBe(false);
    expect(store().sessionData.lap_times.every((r) => r.Driver === 'XXX')).toBe(true);
  });
});

describe('B4 (D14): strategy_correction replaces the driver\'s stints', () => {
  it('in place of the driver\'s first entry; other drivers and strategy_update untouched', async () => {
    const feed = await goLive();
    const s = (d, n, c, start) => ({ Driver: d, StintNumber: n, Compound: c, StartLap: start });
    feed.onMessage({ type: 'strategy_update', data: s('AAA', 1, 'HARD', 1) });
    feed.onMessage({ type: 'strategy_update', data: s('BBB', 1, 'MEDIUM', 1) });
    feed.onMessage({ type: 'strategy_update', data: s('AAA', 2, 'SOFT', 20) });
    feed.onMessage({ type: 'strategy_update', data: s('CCC', 1, 'HARD', 1) });
    const ids = () => store().sessionData.tyre_strategy.map((x) => `${x.Driver}${x.StintNumber}:${x.Compound}`);
    expect(ids()).toEqual(['AAA1:HARD', 'BBB1:MEDIUM', 'AAA2:SOFT', 'CCC1:HARD']);
    feed.onMessage({
      type: 'strategy_correction',
      data: { Driver: 'AAA', stints: [s('AAA', 1, 'MEDIUM', 1), s('AAA', 2, 'MEDIUM', 18), s('AAA', 3, 'SOFT', 20)] },
    });
    expect(ids()).toEqual(['AAA1:MEDIUM', 'AAA2:MEDIUM', 'AAA3:SOFT', 'BBB1:MEDIUM', 'CCC1:HARD']);
    expect(store().sessionData.strategies).toBe(store().sessionData.tyre_strategy);
    // a driver with no entry yet: appended
    feed.onMessage({ type: 'strategy_correction', data: { Driver: 'DDD', stints: [s('DDD', 1, 'HARD', 1)] } });
    expect(ids().at(-1)).toBe('DDD1:HARD');
    feed.onMessage({ type: 'strategy_update', data: s('BBB', 2, 'HARD', 25) });
    expect(ids().at(-1)).toBe('BBB2:HARD');
  });
});

describe('B5 (D13): live track status on the session clock, wall clock from received_at', () => {
  // 2024 R21: the red flag at session 7159.333 s, received 16:37:21.777 UTC
  const RED = { status: '5', start_time: 7159.333, end_time: null, message: '', start_lap: 32, received_at: 1730047041.777 };
  const wall = (s) => new Date(s * 1000).toLocaleTimeString();

  it('a change closes the previous period at its start (session s) and on its lap', async () => {
    const feed = await goLive();
    feed.onMessage({ type: 'track_status', data: { status: '4', start_time: 7000.5, end_time: null, message: 'SC', start_lap: 30, received_at: 1730046883 } });
    feed.onMessage({ type: 'track_status', data: RED });
    const ts = store().trackStatus;
    expect(ts.map((p) => [p.status, p.start_time, p.end_time, p.start_lap, p.end_lap])).toEqual([
      ['4', 7000.5, 7159.333, 30, 32], ['5', 7159.333, null, 32, undefined],
    ]);
    expect(store().currentFlagStatus).toBe('5');
  });

  it('RaceControlFeed and RaceControlPanel show received_at, never start_time read as an epoch', () => {
    useF1Store.setState({
      isLiveMode: true, sessionData: { lap_times: [] }, trackStatus: [RED],
      raceControlMessages: [{ timestamp: 1730047042, message: 'RED FLAG', category: 'Flag', flag: 'RED' }],
    });
    const epoch1970 = new Date(7159333).toLocaleTimeString();
    const feed = renderToString(<RaceControlFeed />);
    expect(feed).toContain(wall(RED.received_at));
    expect(feed).not.toContain(epoch1970);
    // newest first on one wall clock: the message (16:37:22) above the flag (16:37:21.777)
    expect(feed.indexOf('RED FLAG')).toBeLessThan(feed.indexOf('Red Flag'));
    const panel = renderToString(<RaceControlPanel />);
    expect(panel).toContain(wall(RED.received_at));
    expect(panel).not.toContain(epoch1970);
    // without received_at (an older backend) no wall-clock time is invented
    useF1Store.setState({ trackStatus: [{ ...RED, received_at: undefined }], raceControlMessages: [] });
    expect(renderToString(<RaceControlFeed />)).toContain('--:--');
    expect(renderToString(<RaceControlFeed />)).not.toContain(epoch1970);
    useF1Store.setState({ isLiveMode: false, trackStatus: [] });
  });
});

describe('P3d live (D8): no retirement inferred while the race runs', () => {
  it('the feed\'s rows so far: nobody retired; a retirement the feed reports is', async () => {
    const feed = await goLive();
    // CCC is a lap down on the feed's latest lap: read as a final result the
    // latest lap would be taken for the flag and CCC for a retirement
    const lapRows = rows(10).filter((r) => !(r.Driver === 'CCC' && r.LapNumber === 10));
    useF1Store.setState({ sessionData: { ...store().sessionData, lap_times: lapRows } });
    expect(raceStandings(lapRows, store().getSessionNow(), { dnfMap: store().dnfMap, isLiveMode: true })
      .filter((r) => r.isRetired)).toEqual([]);
    feed.onMessage({ type: 'driver_status', data: { Driver: 'CCC', Retired: true, Status: 'Retired', LastLap: 9 } });
    expect(raceStandings(lapRows, store().getSessionNow(), { dnfMap: store().dnfMap, isLiveMode: true })
      .filter((r) => r.isRetired).map((r) => r.abbr)).toEqual(['CCC']);
  });
});
