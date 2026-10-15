// V8: the Session menu's confirmation before a session switch read
// selectedTSNEPoints, a field the store does not have, so a PCA lasso never
// triggered it. It now reads the store through utils/sessionSwitchWarning.js
// (selectedPCAPoints), and says what a load really keeps and clears: a real
// loadSession (mocked API) keeps every "kept" item and clears every
// "cleared" one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async () => globalThis.__sessionMenuFx.session());
  mocked.analyzePCASelection = vi.fn(async () => ({ feature_importance: [] }));
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
function race(laps) {
  const lap_times = [];
  for (const [i, d] of ['AAA', 'BBB'].entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = 2000 + 95 * (n - 1) + i;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return {
    lap_times, race_results: [], track_status: [], weather_data: [],
    driver_info: [{ Abbreviation: 'AAA', TeamName: 'T1' }, { Abbreviation: 'BBB', TeamName: 'T2' }],
  };
}

const fx = { session: async () => race(10) };
globalThis.__sessionMenuFx = fx;
const { useF1Store } = await import('../store/useF1Store.js');
const { sessionSwitchSummary, sessionSwitchMessage } = await import('../utils/sessionSwitchWarning.js');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = () => useF1Store.getState();

const ANALYTICAL = {
  openOverlays: ['laptimes', 'analysis'],
  selectedLapRange: [3, 6],
  brushLapRange: [2, 5],
  selectedPCAPoints: ['AAA_2024_1', 'BBB_2024_1', 'AAA_2023_5'],
  focusDriver: 'AAA',
  geminiMessages: [{ role: 'user', text: 'pit now?' }, { role: 'ai', text: 'no' }],
  geminiOverlays: [{ label: 'pit L32' }],
  simulatorStrategy: { stops: [{ lap: 20, compound: 'HARD' }] },
  simulatorResult: { delta: 0 },
  lstmPredictions: { AAA: { predicted_laps: [] } },
  telemetryCompareLaps: [3, 4],
};

beforeEach(async () => {
  store().resetSession();
  useF1Store.setState({ year: 2024, round: 1, sessionType: 'R', openOverlays: [] });
  fx.session = async () => race(10);
  await store().loadSession();
});

describe('V8: the session-switch confirmation reads the PCA lasso', () => {
  it('a lasso alone triggers it and names the points (the store field is selectedPCAPoints)', () => {
    expect('selectedTSNEPoints' in store()).toBe(false);
    expect(Array.isArray(store().selectedPCAPoints)).toBe(true);
    useF1Store.setState({ selectedPCAPoints: ['AAA_2024_1', 'BBB_2024_1', 'AAA_2023_5'] });
    const msg = sessionSwitchMessage(store());
    expect(msg).toContain('3 lasso-selected points');
    console.log(`V8 confirmation with a 3-point lasso:\n${msg}`);
  });

  it('nothing to keep or clear: no confirmation', () => {
    useF1Store.setState({ selectedPCAPoints: [], focusDriver: null, openOverlays: [], selectedLapRange: null, brushLapRange: null });
    expect(sessionSwitchMessage(store())).toBeNull();
  });

  it('SessionMenu asks through the helper and no longer reads selectedTSNEPoints', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/ui/SessionMenu.jsx'), 'utf8');
    expect(src).not.toMatch(/TSNE|tsne/);
    expect(src).toMatch(/sessionSwitchMessage\(useF1Store\.getState\(\)\)/);
    expect(src).toMatch(/window\.confirm\(msg\)/);
  });

  it('a real load keeps every "kept" item and clears every "cleared" one', async () => {
    useF1Store.setState(ANALYTICAL);
    const before = sessionSwitchSummary(store());
    // D8: the lap ranges are cleared by a load, not kept
    expect(before.kept).toHaveLength(3);
    expect(before.cleared).toHaveLength(7);
    expect(before.cleared).toContain('lap range 3–6');
    console.log(`before the load: ${JSON.stringify(before)}`);
    fx.session = async () => race(12);
    useF1Store.setState({ round: 2 });
    await store().loadSession();
    expect(store().loadedRound).toBe(2);
    const after = sessionSwitchSummary(store());
    console.log(`after the load: ${JSON.stringify(after)}`);
    expect(after.kept).toEqual(before.kept);
    expect(after.cleared).toEqual([]);
  });
});
