// Lap-time forecast in the store.
//  - the store builds no model features; POST /api/predict/lstm gets
//    identifiers only, in the shape of the backend (backend/api/routers/
//    predictions.py LSTMRequest): {year, round, session_type, driver,
//    session_now, max_lap, lap} for a session with cached rows, and
//    {driver, session_now, session_type, lap_rows, weather_rows, max_lap}
//    for a live feed without one.
//  - one trigger (triggerPrediction, a double-click), one shape
//    (lstmPredictions = { [driver]: entry } tagged {driver, lap, method}),
//    cleared on a focus change, a session switch and a later-clock reset:
//    rapid focus switching with delayed answers never shows another driver's
//    forecast.
// Synthetic races, mocked API (utils/apiClient).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__forecastFx;
  mocked.setHealthReporter = vi.fn();
  for (const k of ['getSession', 'predictLSTM', 'getLiveStatus', 'getLiveSnapshot', 'startMockReplay', 'stopMockReplay']) {
    mocked[k] = vi.fn((...a) => (fx()[k] ? fx()[k](...a) : Promise.resolve({})));
  }
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
globalThis.__forecastFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const {
  focusForecast, forecastPoints, forecastEntry, forecastRequestOf, forecastMethodText,
} = await import('../utils/forecast.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { generateInsights } = await import('../utils/insightsGenerator.js');

const store = () => useF1Store.getState();
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
};

const DRIVERS = ['AAA', 'BBB', 'CCC'];

/** A synthetic race: `laps` laps of ~95 s from session time t0, weather every 60 s. */
function race(laps, drivers = DRIVERS, t0 = 2000) {
  const lap_times = [];
  for (const [i, d] of drivers.entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = t0 + 95 * (n - 1) + i * 1.5;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.05 * n + 0.1 * i,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
        Sector1TimeSeconds: 30, Sector2TimeSeconds: 32, Sector3TimeSeconds: 33,
      });
    }
  }
  const weather_data = [];
  for (let t = t0 - 60; t < t0 + 95 * laps; t += 60) weather_data.push({ Time: t, TrackTemp: 40, AirTemp: 25 });
  return { lap_times, track_status: [], driver_info: drivers.map((d) => ({ Abbreviation: d })), race_results: [], weather_data };
}

const SESSION = race(30);

/** A backend response for one driver (the fields of model/predict.py forecast_from_context). */
function answer(body, extra = {}) {
  const origin = Math.min(body.lap ?? 19, 19);
  return {
    driver: body.driver,
    origin_lap: origin,
    target_laps: [1, 2, 3, 4, 5].map((k) => origin + k),
    predicted_times: [96.1, 96.2, 96.3, 96.4, 96.5],
    method: 'lstm',
    method_label: 'LSTM',
    held_out: { metric: 'MAE over laps +1..+5', races: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'], values: { lstm: 0.608, persistence: 0.637 }, selected_on: 'validation' },
    lstm_note: 'The LSTM has the best validation MAE (0.508 s over laps +1..+5).',
    pit_probability: 0.2,
    pit_method: 'lstm',
    optimal_pit_lap: 26,
    predicted_stints: [{ driver: body.driver, compound: 'HARD', lap_start: origin, length: 7 }],
    driver_predictions: { [body.driver]: {} },
    window: { laps: [10, 19], ref_lap: origin, ref_time: 95.95, features: ['origin_tyre_life'], values: [[origin]] },
    ...extra,
  };
}

/** A double-click on a driver row (Leaderboard, Lap Times): focus, then the forecast. */
function doubleClick(driver, lap = store().currentLap) {
  store().setFocusDriver(driver);
  return store().triggerPrediction(driver, lap);
}

beforeEach(async () => {
  for (const k of Object.keys(fx)) delete fx[k];
  store().resetSession();
  useF1Store.setState({
    isLiveMode: false, liveSessionInfo: null, liveConnected: false, year: 2024, round: 99, sessionType: 'R',
    totalRaceLaps: null,
  });
  fx.getSession = async () => SESSION;
  await store().loadSession();
  await settle();
  store().setCurrentLap(20);
  await settle();
  for (const f of Object.values(api)) if (f?.mockClear) f.mockClear();
});

describe('the forecast request carries identifiers, never features', () => {
  it('replay: {year, round, session_type, driver, session_now, max_lap, lap}; a later clicked lap is clamped', async () => {
    fx.predictLSTM = async (b) => answer(b);
    await doubleClick('AAA', 20);
    await store().triggerPrediction('AAA', 27); // a lap after the replay's
    await store().triggerPrediction('AAA', 12); // a past lap
    const bodies = api.predictLSTM.mock.calls.map((c) => c[0]);
    expect(bodies).toHaveLength(3);
    for (const b of bodies) {
      expect(Object.keys(b).sort()).toEqual(['driver', 'lap', 'max_lap', 'round', 'session_now', 'session_type', 'year']);
      expect(b).toMatchObject({ year: 2024, round: 99, session_type: 'R', driver: 'AAA', max_lap: 30 });
      expect(b.session_now).toBe(store().getSessionNow());
      expect(Number.isFinite(b.session_now)).toBe(true);
    }
    expect(bodies.map((b) => b.lap)).toEqual([20, 20, 12]);
    console.log('L1 replay request body:', JSON.stringify(bodies[0]));
  });

  it('the mocked response lands tagged {driver, lap, method} under the driver, nothing else', async () => {
    const now = store().getSessionNow();
    fx.predictLSTM = async (b) => answer(b);
    await doubleClick('BBB', 20);
    const lp = store().lstmPredictions;
    expect(Object.keys(lp)).toEqual(['BBB']);
    expect(lp.BBB).toMatchObject({ driver: 'BBB', lap: 19, method: 'lstm', askedLap: 20, computedAtNow: now });
    expect(store()._lstmAt).toBe(now);
    expect(store().predictionLoading).toBe(false);
    // the views' points: each time at its target lap
    expect(forecastPoints(lp.BBB).map((p) => p.lap)).toEqual([20, 21, 22, 23, 24]);
    expect(forecastMethodText(lp.BBB)).toBe('LSTM · held-out MAE 0.608 s (7 test races)');
    // the old flat fields of the response are never at the top level
    for (const k of ['predicted_times', 'pit_probability', 'optimal_pit_lap', 'predicted_stints', 'driver_predictions']) {
      expect(k in lp).toBe(false);
    }
  });

  it('live feed without a cached race: that driver\'s lap rows, weather rows and the race distance (total laps)', async () => {
    fx.getLiveStatus = async () => ({ active: true, current_lap: 30, total_laps: 57, session_status: 'Started', session_info: { session_type: 'Race', session_name: 'Race' } });
    fx.getLiveSnapshot = async () => ({ lap_times: SESSION.lap_times, track_status: [], driver_info: SESSION.driver_info, weather_data: SESSION.weather_data });
    await store().enterLiveMode();
    await settle();
    expect(store().isLiveMode).toBe(true);
    fx.predictLSTM = async (b) => answer(b);
    await doubleClick('CCC', 30);
    const b = api.predictLSTM.mock.calls.at(-1)[0];
    expect(Object.keys(b).sort()).toEqual(['driver', 'lap', 'lap_rows', 'max_lap', 'session_now', 'session_type', 'weather_rows']);
    expect(b.session_now).toBeNull(); // every received lap is completed
    expect(b.max_lap).toBe(57); // the feed's total laps, not the laps run so far (30)
    expect(b.lap_rows.length).toBe(30);
    expect(b.lap_rows.every((r) => r.Driver === 'CCC')).toBe(true);
    expect(b.session_type).toBe('R');
    expect(Object.keys(store().lstmPredictions)).toEqual(['CCC']);
  });

  it('mock live replay of a cached race: identifiers at the clock of the latest received lap', async () => {
    fx.startMockReplay = async () => ({});
    fx.getLiveStatus = async () => ({ active: true, current_lap: 10, total_laps: 30, session_status: 'Started' });
    const rows = SESSION.lap_times.filter((r) => r.LapNumber <= 10);
    fx.getLiveSnapshot = async () => ({ lap_times: rows, track_status: [], driver_info: SESSION.driver_info });
    await store().enterLiveMode(2024, 98, 10);
    await settle();
    fx.predictLSTM = async (b) => answer(b);
    await doubleClick('AAA', 10);
    const b = api.predictLSTM.mock.calls.at(-1)[0];
    const lastEnd = Math.max(...rows.map((r) => r.Time));
    expect(b).toMatchObject({ year: 2024, round: 98, driver: 'AAA', session_now: lastEnd, max_lap: 30, lap: 10 });
    expect(b.lap_rows).toBeUndefined();
  });

  it('the store source builds no forecast features (the grep of the old feature code is empty)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../store/useF1Store.js'), 'utf8');
    for (const word of ['last_10_laps', 'fuel_estimate', 'gap_to_leader:', 'track_temp', 'sector1:', 'triggerLSTMPredictions', 'fetchLSTMPrediction']) {
      expect(src.includes(word), word).toBe(false);
    }
    const trigger = src.slice(src.indexOf('  triggerPrediction: async'), src.indexOf('  updateRivalContext: () =>'));
    expect(trigger.length).toBeGreaterThan(100);
    for (const word of ['LapTimeSeconds', 'TyreLife', 'Compound', 'weather', 'Position']) {
      expect(trigger.includes(word), word).toBe(false);
    }
  });

  it('forecastRequestOf: nothing to ask without session rows; the race-over clock is sent as null', () => {
    expect(forecastRequestOf({ sessionData: null }, { driver: 'AAA', lap: 3, sessionNow: 1 })).toBeNull();
    const s = { ...store(), currentLap: 30 };
    expect(forecastRequestOf(s, { driver: 'AAA', lap: 30, sessionNow: Infinity }).session_now).toBeNull();
  });
});

describe('one trigger, one shape, never another driver\'s forecast', () => {
  const orders = [];
  const permute = (rest, acc = []) => {
    if (!rest.length) { orders.push(acc); return; }
    rest.forEach((d, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, d]));
  };
  permute(DRIVERS);

  /** The forecast every view reads (utils/forecast.js focusForecast): the focus driver's own, or none. */
  function assertOnlyTheFocusDriver(step) {
    const s = store();
    const lp = s.lstmPredictions;
    if (lp != null) {
      expect(Object.keys(lp), step).toEqual([s.focusDriver]);
      expect(lp[s.focusDriver].driver, step).toBe(s.focusDriver);
    }
    for (const d of DRIVERS) {
      const shown = focusForecast(lp, d);
      if (shown) expect(shown.driver, step).toBe(s.focusDriver);
    }
  }

  for (const order of orders) {
    it(`double-clicks AAA, BBB, CCC in a row, answers in the order ${order.join(', ')}: only CCC's lands`, async () => {
      const pending = {};
      fx.predictLSTM = (b) => { pending[b.driver] = deferred(); return pending[b.driver].promise.then(() => answer(b)); };
      const reqs = DRIVERS.map((d) => doubleClick(d, 20));
      expect(store().focusDriver).toBe('CCC');
      expect(store().predictionLoading).toBe(true);
      assertOnlyTheFocusDriver('before any answer');
      for (const d of order) {
        pending[d].resolve();
        await settle();
        assertOnlyTheFocusDriver(`after ${d}'s answer`);
      }
      await Promise.all(reqs);
      expect(Object.keys(store().lstmPredictions)).toEqual(['CCC']);
      expect(store().lstmPredictions.CCC.driver).toBe('CCC');
      expect(store().predictionLoading).toBe(false);
    });
  }

  it('focus toggled off (a second double-click on CCC) before its answer: nothing lands, nothing is asked', async () => {
    const pending = {};
    fx.predictLSTM = (b) => { pending[b.driver] = deferred(); return pending[b.driver].promise.then(() => answer(b)); };
    const r1 = doubleClick('AAA', 20);
    const r2 = doubleClick('CCC', 20);
    const r3 = doubleClick('CCC', 20); // toggles the focus off: no request
    expect(store().focusDriver).toBeNull();
    expect(api.predictLSTM).toHaveBeenCalledTimes(2);
    pending.CCC.resolve();
    pending.AAA.resolve();
    await Promise.all([r1, r2, r3]);
    await settle();
    expect(store().lstmPredictions).toBeNull();
    expect(store().predictionLoading).toBe(false);
  });

  it('an older request of the same driver answered after a newer one is dropped', async () => {
    const pending = [];
    fx.predictLSTM = (b) => { const d = deferred(); pending.push(d); return d.promise.then(() => answer(b)); };
    store().setFocusDriver('AAA');
    const old = store().triggerPrediction('AAA', 12);
    const newer = store().triggerPrediction('AAA', 20);
    pending[1].resolve();
    await newer;
    expect(store().lstmPredictions.AAA.askedLap).toBe(20);
    pending[0].resolve();
    await old;
    expect(store().lstmPredictions.AAA.askedLap).toBe(20);
  });

  it('clearSelection drops the focus driver\'s forecast and its request in flight (backlog L3)', async () => {
    fx.predictLSTM = async (b) => answer(b);
    await doubleClick('AAA', 20);
    expect(store().lstmPredictions?.AAA).toBeTruthy();
    store().clearSelection();
    expect(store().focusDriver).toBeNull();
    expect(store().lstmPredictions).toBeNull();
    expect(store().lastPredictionTrigger).toBeNull();
    // a request still in flight when the selection is cleared lands nowhere
    const pending = deferred();
    fx.predictLSTM = (b) => pending.promise.then(() => answer(b));
    const req = doubleClick('BBB', 20);
    expect(store().predictionLoading).toBe(true);
    store().clearSelection();
    expect(store().predictionLoading).toBe(false);
    pending.resolve();
    await req;
    await settle();
    expect(store().lstmPredictions).toBeNull();
    expect(store().predictionLoading).toBe(false);
  });

  it('a response tagged with another driver is not kept', async () => {
    fx.predictLSTM = async (b) => ({ ...answer(b), driver: 'ZZZ' });
    await doubleClick('AAA', 20);
    expect(store().lstmPredictions).toBeNull();
    expect(forecastEntry({ driver: 'ZZZ' }, { driver: 'AAA', askedLap: 3, at: 1 })).toBeNull();
    expect(forecastEntry({ predicted_times: [1] }, { driver: 'AAA', askedLap: 3, at: 1 }).driver).toBe('AAA');
  });

  it('cleared on a focus change, a session switch and a later-clock reset; an earlier forecast stays on a forward seek', async () => {
    fx.predictLSTM = async (b) => answer(b);
    await doubleClick('AAA', 20);
    expect(store().lstmPredictions?.AAA).toBeTruthy();
    // focus change
    store().setFocusDriver('BBB');
    expect(store().lstmPredictions).toBeNull();
    // forward seek keeps it, backward seek before the clock it was asked at drops it
    await store().triggerPrediction('BBB', 20);
    store().setCurrentLap(25);
    expect(store().lstmPredictions?.BBB?.askedLap).toBe(20);
    store().setCurrentLap(10);
    expect(store().lstmPredictions).toBeNull();
    // session switch
    store().setCurrentLap(20);
    await store().triggerPrediction('BBB', 20);
    expect(store().lstmPredictions?.BBB).toBeTruthy();
    useF1Store.setState({ round: 98 });
    await store().loadSession();
    await settle();
    expect(store().lstmPredictions).toBeNull();
    expect(store().lastPredictionTrigger).toBeNull();
  });

  it('no automatic trigger: replay laps, seeks and focus changes ask nothing', async () => {
    store().setFocusDriver('AAA');
    store().setCurrentLap(22);
    store().setCurrentLap(24);
    store().setCurrentLap(12);
    await new Promise((r) => setTimeout(r, 200)); // past the clock-jump settle
    expect(api.predictLSTM).not.toHaveBeenCalled();
  });

  it('readers: the race situation uses the forecast only at its origin lap, the insights name the method', async () => {
    fx.predictLSTM = async (b) => answer(b, { predicted_times: [96.1, 96.6, 97.1, 97.6, 98.1] });
    await doubleClick('AAA', 20);
    const lstmPredictions = store().lstmPredictions;
    const now = store().getSessionNow();
    const at = (sessionNow, currentLap) => extractRaceSituationFeatures({
      lapTimes: SESSION.lap_times, dnfMap: {}, currentLap, lstmPredictions, focusDriver: 'AAA', sessionNow,
    }).driverFeatures.AAA.predictedPace5;
    // at the clock asked (AAA's last completed lap = the origin, 19): the forecast's lap +5
    expect(at(now, 20)).toBe(98.1);
    // a lap later the forecast is about earlier laps: not used
    expect(at(now + 95, 21)).not.toBe(98.1);
    // another driver's key never feeds BBB's row
    expect(extractRaceSituationFeatures({
      lapTimes: SESSION.lap_times, dnfMap: {}, currentLap: 20, lstmPredictions, focusDriver: 'BBB', sessionNow: now,
    }).driverFeatures.BBB.predictedPace5).not.toBe(98.1);
    const insights = generateInsights({ lstmPredictions, focusDriver: 'AAA', currentLap: 20, maxLap: 30 });
    const text = insights.find((i) => i.category === 'forecast')?.text;
    expect(text).toMatch(/^LSTM forecast: AAA is projected to slow by 2\.00s over laps 20-24 \(held-out MAE 0\.608 s\)/);
    expect(generateInsights({ lstmPredictions, focusDriver: 'BBB', currentLap: 20, maxLap: 30 })
      .some((i) => i.category === 'forecast')).toBe(false);
  });
});
