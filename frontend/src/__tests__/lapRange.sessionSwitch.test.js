// F9 / D8: the lap range (selectedLapRange / brushLapRange, the one range of
// every view) belongs to the race it was drawn on. A switch of what the
// dashboard shows (loadSession, enterLiveMode, exitLiveMode, resetSession)
// clears it, so laps 30-40 brushed on one race never filter the Timing Sheet,
// the Position Tracker brush, the Strategy Timeline band or the Tyre
// Degradation fit of the next one. The Session menu's confirmation says so.
// Synthetic sessions, mocked API (no backend).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) {
    mocked[k] = typeof v === 'function' ? vi.fn((...a) => (globalThis.__lapRangeFx[k] ? globalThis.__lapRangeFx[k](...a) : Promise.resolve({}))) : v;
  }
  mocked.setHealthReporter = vi.fn();
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

/** A synthetic race of `laps` laps, two drivers. */
function race(laps, t0 = 2000) {
  const lap_times = [];
  for (const [i, d] of ['AAA', 'BBB'].entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = t0 + 95 * (n - 1) + i;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return {
    lap_times, race_results: [], track_status: [], weather_data: [],
    driver_info: [{ Abbreviation: 'AAA', TeamName: 'McLaren' }, { Abbreviation: 'BBB', TeamName: 'Ferrari' }],
  };
}

const fx = {
  getSession: async (y, r) => race(r === 2 ? 30 : 50),
  stopMockReplay: async () => ({ status: 'not_running' }),
  startMockReplay: async () => ({}),
  getLiveStatus: async () => ({
    active: true, current_lap: 10, total_laps: 50, session_status: 'Started',
    session_info: { session_type: 'Race', session_name: 'Race' },
  }),
  getLiveSnapshot: async () => ({ lap_times: race(10).lap_times, driver_info: race(10).driver_info, track_status: [] }),
};
globalThis.__lapRangeFx = fx;

const { useF1Store } = await import('../store/useF1Store.js');
const { sessionSwitchSummary } = await import('../utils/sessionSwitchWarning.js');
const store = () => useF1Store.getState();
const ranges = () => [store().selectedLapRange, store().brushLapRange];

/** Race 1 (50 laps) on screen, laps 30-40 brushed. */
async function onRaceWithRange() {
  store().resetSession();
  useF1Store.setState({ isLiveMode: false, year: 2024, round: 1, sessionType: 'R' });
  await store().loadSession();
  expect(store().loadedRound).toBe(1);
  store().setBrushLapRange([30, 40]);
  expect(ranges()).toEqual([[30, 40], [30, 40]]);
}

beforeEach(async () => {
  await onRaceWithRange();
});

describe('D8: a session switch clears the lap range', () => {
  it('loadSession: the range of race 1 does not filter race 2', async () => {
    useF1Store.setState({ round: 2 });
    await store().loadSession();
    expect(store().loadedRound).toBe(2);
    expect(ranges()).toEqual([null, null]);
    // and the analytics range (Tyre Degradation, the degradation endpoint) with it
    expect(store().getAnalysisLapRange()).toBeNull();
  });

  it('loadSession of the race on screen (a reload) clears it too', async () => {
    store().setSelectedLapRange([5, 9]);
    await store().loadSession();
    expect(ranges()).toEqual([null, null]);
  });

  it('a range set from the Strategy Timeline or a pit window (setSelectedLapRange) is cleared the same way', async () => {
    store().setSelectedLapRange([12, 18]);
    useF1Store.setState({ round: 2 });
    await store().loadSession();
    expect(ranges()).toEqual([null, null]);
  });

  it('resetSession (back to the selector)', () => {
    store().resetSession();
    expect(ranges()).toEqual([null, null]);
  });

  it('enterLiveMode, then exitLiveMode', async () => {
    await store().enterLiveMode();
    expect(store().isLiveMode).toBe(true);
    expect(ranges()).toEqual([null, null]);
    // a range brushed on the live feed does not survive the exit either
    store().setBrushLapRange([3, 6]);
    await store().exitLiveMode();
    expect(store().isLiveMode).toBe(false);
    expect(ranges()).toEqual([null, null]);
  });

  it('a range set while a load is in flight belongs to the session still on screen: the commit clears it', async () => {
    let release;
    fx.getSession = (y, r) => new Promise((resolve) => { release = () => resolve(race(r === 2 ? 30 : 50)); });
    useF1Store.setState({ round: 2 });
    const pending = store().loadSession();
    await new Promise((r) => setTimeout(r, 0));
    store().setBrushLapRange([41, 45]); // drawn on race 1, still on screen
    release();
    await pending;
    expect(store().loadedRound).toBe(2);
    expect(ranges()).toEqual([null, null]);
    fx.getSession = async (y, r) => race(r === 2 ? 30 : 50);
  });

  it('the Session menu confirmation lists the range as cleared, not kept', () => {
    const { kept, cleared } = sessionSwitchSummary(store());
    expect(kept.join(' ')).not.toMatch(/lap range|brushed laps/);
    expect(cleared).toContain('lap range 30–40');
    expect(cleared).toContain('brushed laps 30–40');
  });
});
