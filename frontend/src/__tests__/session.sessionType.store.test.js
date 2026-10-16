// Session type, the store side: the analytics, strategy, telemetry, degradation
// and LSTM requests of a loaded session carry ITS type (loadedSessionType),
// year and round, never the pills the session menus change without loading.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async () => globalThis.__sessionTypeFx.session);
  mocked.getTelemetry = vi.fn(async () => ({ telemetry: [{ Distance: 0 }] }));
  mocked.predictDegradation = vi.fn(async () => ({ slope: 0.01 }));
  mocked.predictLSTM = vi.fn(async () => ({}));
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
globalThis.__sessionTypeFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function laps(n, drivers = ['AAA', 'BBB'], t0 = 2000) {
  const out = [];
  for (const [i, d] of drivers.entries()) {
    for (let k = 1; k <= n; k++) {
      const start = t0 + 95 * (k - 1) + i;
      out.push({ Driver: d, LapNumber: k, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.01 * k,
        Position: i + 1, Compound: 'MEDIUM', TyreLife: k, TrackStatus: '1' });
    }
  }
  return out;
}

beforeEach(() => {
  fx.session = { lap_times: laps(20), track_status: [], driver_info: [], race_results: [], weather_data: [] };
  store().resetSession();
  for (const f of Object.values(api)) if (f?.mockClear) f.mockClear();
});

describe('requests of a loaded session carry its type', () => {
  for (const type of ['S', 'FP2', 'R']) {
    it(`loaded ${type}, then the pills moved to 2023 R5 Q: every request names 2024 R7 ${type}`, async () => {
      useF1Store.setState({ year: 2024, round: 7, sessionType: type, isLiveMode: false });
      await store().loadSession();
      await settle();
      expect(api.getSectors).toHaveBeenLastCalledWith(2024, 7, type);
      expect(api.getConsistency).toHaveBeenLastCalledWith(2024, 7, type);
      expect(api.getSpeedRankings).toHaveBeenLastCalledWith(2024, 7, type);
      expect(api.getStrategy).toHaveBeenLastCalledWith(2024, 7, type);
      useF1Store.setState({ year: 2023, round: 5, sessionType: 'Q' }); // pills only
      store().setCurrentLap(15);
      await store().fetchDriverTelemetry('AAA', 3);
      expect(api.getTelemetry).toHaveBeenLastCalledWith(2024, 7, 'AAA', 3, type);
      await store().fetchDegradationRegression({ drivers: ['AAA'], lap_start: 2, lap_end: 12 });
      const deg = api.predictDegradation.mock.calls.at(-1)[0];
      expect([deg.year, deg.round, deg.session_type]).toEqual([2024, 7, type]);
      expect(deg.session_now).toBe(store().getSessionNow());
      useF1Store.setState({ focusDriver: 'AAA' });
      await store().triggerPrediction('AAA', 15);
      const lstm = api.predictLSTM.mock.calls.at(-1)[0];
      expect([lstm.year, lstm.round, lstm.session_type]).toEqual([2024, 7, type]);
    });
  }
});
