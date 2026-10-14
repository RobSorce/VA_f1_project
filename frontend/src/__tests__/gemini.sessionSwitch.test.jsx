// P3a (lead decision D7) and causality (R3 / R6), the assistant paths: the
// chat (sendGeminiQuery: GeminiAssistant, GeminiFloatingButton) and the Pit
// Wall "AI Strategist" box (askGeminiQuick: GeminiQuickQuery). An answer
//  - of a request sent for another screen never lands, including a mock live
//    race followed by the replay of the same race and a reload of the race on
//    screen (same screenKeyOf: the screen generation tells them apart);
//  - of a question asked at a clock later than the one now on screen (a seek
//    back) never lands either;
//  - and the assistants are never left waiting: a screen switch clears the
//    chat, its overlays and the quick answer; a dropped answer whose question
//    is still in the chat is replaced by a note.
// The telemetry spinner belongs to the requests of the screen on screen.
// Synthetic races, the second one's clock LATER than the first's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

const { buttons, wrap } = vi.hoisted(() => {
  const buttons = [];
  const wrap = (orig) => (type, props, ...rest) => {
    if (type === 'button' && typeof props?.onClick === 'function' && typeof props.children === 'string') {
      buttons.push({ text: props.children, onClick: props.onClick });
    }
    return orig(type, props, ...rest);
  };
  return { buttons, wrap };
});
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, jsxDEV: wrap(m.jsxDEV) };
});
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, jsx: wrap(m.jsx), jsxs: wrap(m.jsxs) };
});
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__geminiSwitchFx;
  mocked.setHealthReporter = vi.fn();
  for (const k of ['getSession', 'getFrames', 'getTelemetry', 'queryGemini', 'startMockReplay', 'getLiveStatus',
    'getLiveSnapshot', 'loadLiveFullSession', 'stopMockReplay']) {
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
globalThis.__geminiSwitchFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store, screenKeyOf } = await import('../store/useF1Store.js');
const { default: GeminiAssistant } = await import('../components/visualizations/GeminiAssistant.jsx');
const { default: GeminiQuickQuery } = await import('../components/ui/GeminiQuickQuery.jsx');

const store = () => useF1Store.getState();
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const chat = () => store().geminiMessages.map((m) => `${m.role}: ${m.content}`);
const waiting = () => store().geminiMessages.at(-1)?.role === 'user';

/** A synthetic race: `laps` laps of 95 s from session time t0. */
function race(laps, drivers, t0) {
  const lap_times = [];
  for (const [i, d] of drivers.entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = t0 + 95 * (n - 1) + i * 1.5;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.05 * n,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return { lap_times, track_status: [], driver_info: drivers.map((d) => ({ Abbreviation: d })), race_results: [], weather_data: [] };
}

// A: 2024 R91, race start at session time 200 s; B: 2024 R92, start 3000 s
const A = race(30, ['AAA', 'BBB', 'CCC'], 200);
const B = race(30, ['XXX', 'YYY', 'ZZZ'], 3000);

/**
 * Server-render against the store's CURRENT state: zustand serves
 * getInitialState() as the server snapshot, so the current state is copied
 * into that object for the render and restored after.
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

async function loadReplay(round, data, lap) {
  fx.getSession = async () => data;
  useF1Store.setState({ isLiveMode: false, year: 2024, round, sessionType: 'R' });
  await store().loadSession();
  await settle();
  if (lap) store().setCurrentLap(lap);
  useF1Store.setState({ focusDriver: data.driver_info[0].Abbreviation, selectedDrivers: [data.driver_info[0].Abbreviation] });
  await settle();
}

/** Start a load with its session answer held back; land() lets it commit, fail() makes it fail. */
function startLoad(round, data) {
  const b = deferred();
  fx.getSession = () => b.promise;
  useF1Store.setState({ year: 2024, round, sessionType: 'R' });
  const loading = store().loadSession();
  return {
    land: async () => { b.resolve(data); await loading; await settle(); },
    fail: async () => { b.reject(new Error('backend down')); await loading; await settle(); },
  };
}

beforeEach(async () => {
  for (const k of Object.keys(fx)) delete fx[k];
  store().resetSession();
  useF1Store.setState({ isLiveMode: false, liveSessionInfo: null, liveConnected: false, telemetryLoading: false });
  await loadReplay(91, A, 20);
  for (const f of Object.values(api)) if (f?.mockClear) f.mockClear();
});

describe('P3a: assistant answers of another screen never land, and nothing is left waiting', () => {
  it('mock live of R91 at lap 25 -> Load Session of R91: a question asked in the load window gets no live answer', async () => {
    store().resetSession();
    fx.startMockReplay = async () => ({});
    fx.getLiveStatus = async () => ({ active: true, session_status: 'Started', current_lap: 25, total_laps: 30 });
    fx.getLiveSnapshot = async () => ({
      lap_times: A.lap_times.filter((r) => r.LapNumber <= 25), driver_info: A.driver_info, track_status: [],
    });
    useF1Store.setState({ year: 2024, round: 91, sessionType: 'R' });
    await store().enterLiveMode(2024, 91, 10);
    await settle();
    useF1Store.setState({ focusDriver: 'AAA', selectedDrivers: ['AAA'] });
    expect(screenKeyOf(store())).toBe('live:2024-91-R');

    const load = startLoad(91, A);
    await settle(5);
    // the load left live mode at its start: the same key as the replay it loads
    expect(screenKeyOf(store())).toBe('replay:2024-91-R');
    expect(store().currentLap).toBe(25); // the live rows are still on screen
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    const asked = store().sendGeminiQuery('When should AAA pit?');
    expect(api.queryGemini.mock.calls.at(-1)[0].current_lap).toBe(25);
    await load.land();
    expect(store().currentLap).toBe(1);
    gem.resolve({ response: 'LIVE-LAP-25 ANSWER', scenarios: [{ id: 's', stints: [{ compound: 'HARD', lap_start: 27 }] }] });
    await asked;
    await settle();
    expect(chat()).toEqual([]);
    expect(store().geminiOverlays).toEqual([]);
  });

  it('a reload of the race on screen (R91 lap 20 -> Load R91): the lap-20 answer does not land at lap 1', async () => {
    const load = startLoad(91, A);
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    const asked = store().sendGeminiQuery('When should AAA pit?');
    expect(api.queryGemini.mock.calls.at(-1)[0].current_lap).toBe(20);
    await load.land();
    expect(screenKeyOf(store())).toBe('replay:2024-91-R');
    gem.resolve({ response: 'LAP-20 ANSWER', scenarios: [{ id: 's1', label: 'pit L22' }] });
    await asked;
    await settle();
    expect(chat()).toEqual([]);
    expect(store().geminiOverlays).toEqual([]);
  });

  it('R91 -> R92 while the answer is on its way: R92 starts with an empty chat, the assistant is not waiting', async () => {
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    const asked = store().sendGeminiQuery('Pit window?');
    expect(waiting()).toBe(true);
    await loadReplay(92, B, 10);
    gem.resolve({ response: 'R91 answer', scenarios: [] });
    await asked;
    await settle();
    expect(chat()).toEqual([]);
    expect(waiting()).toBe(false);
    const html = renderWithStore(<GeminiAssistant />);
    expect(html).not.toContain('Analyzing...');
    expect((html.match(/strategy-console__quick-btn"[^>]*disabled=""/g) || []).length).toBe(0);
  });

  it('an answer and its overlays received on R91 do not stay on R92 (the commit clears them)', async () => {
    fx.queryGemini = async () => ({ response: 'R91 answer', scenarios: [{ id: 'a', label: 'pit L24' }] });
    await store().sendGeminiQuery('Pit window?');
    expect(chat()).toEqual(['user: Pit window?', 'ai: R91 answer']);
    expect(store().geminiOverlays).toHaveLength(1);
    await loadReplay(92, B, 10);
    expect(chat()).toEqual([]);
    expect(store().geminiOverlays).toEqual([]);
  });

  it('dropped while the next load is still in flight, and that load fails: a note answers the question', async () => {
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    const asked = store().sendGeminiQuery('Pit window?');
    const load = startLoad(92, B);
    gem.resolve({ response: 'R91 answer' });
    await asked;
    await load.fail();
    expect(screenKeyOf(store())).toBe('replay:2024-91-R');
    expect(store().geminiMessages.map((m) => m.role)).toEqual(['user', 'ai']);
    expect(store().geminiMessages[1].dropped).toBe('screen');
    expect(waiting()).toBe(false);
  });
});

describe('R3 / R6: an answer asked at a later clock than the one on screen never lands', () => {
  it('a seek back from lap 20 to lap 5 while the answer is on its way: a note instead of the lap-20 answer', async () => {
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    const asked = store().sendGeminiQuery('Pit window?');
    store().setCurrentLap(5);
    await settle();
    gem.resolve({ response: 'LAP-20 ANSWER', scenarios: [{ id: 'x', label: 'pit L22' }] });
    await asked;
    await settle();
    expect(store().geminiMessages.map((m) => m.role)).toEqual(['user', 'ai']);
    expect(store().geminiMessages[1].dropped).toBe('clock');
    expect(store().geminiMessages[1].content).not.toContain('LAP-20');
    expect(store().geminiOverlays).toEqual([]);
    expect(waiting()).toBe(false);
  });

  it('playing forward while the answer is on its way: it lands (asked at an earlier clock)', async () => {
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    const asked = store().sendGeminiQuery('Pit window?');
    store().setCurrentLap(22);
    await settle();
    gem.resolve({ response: 'LAP-20 ANSWER', scenarios: [] });
    await asked;
    expect(chat()).toEqual(['user: Pit window?', 'ai: LAP-20 ANSWER']);
  });
});

describe('the Pit Wall quick query goes through the store (askGeminiQuick)', () => {
  it('R91 question, R92 loaded, the answer arrives: nothing of R91 on R92', async () => {
    const gem = deferred();
    fx.queryGemini = () => gem.promise;
    buttons.length = 0;
    renderWithStore(<GeminiQuickQuery />);
    const quick = buttons.find((b) => b.text === 'Pit window?');
    quick.onClick();
    expect(api.queryGemini.mock.calls.at(-1)[0]).toMatchObject({ year: 2024, round: 91, current_lap: 20 });
    expect(store().geminiQuick.loading).toBe(true);
    await loadReplay(92, B, 3);
    expect(store().geminiQuick).toEqual({ loading: false, response: '', error: '' });
    gem.resolve({ response: 'R91 lap-20 answer' });
    await settle();
    expect(store().geminiQuick).toEqual({ loading: false, response: '', error: '' });
    expect(renderWithStore(<GeminiQuickQuery />)).not.toContain('R91 lap-20 answer');
  });

  it('an answer for the screen on screen is shown; a newer quick query replaces an older one', async () => {
    const first = deferred();
    fx.queryGemini = () => first.promise;
    const p1 = store().askGeminiQuick('Strategy?');
    fx.queryGemini = async () => ({ response: 'second answer' });
    await store().askGeminiQuick('Tyre deg?');
    first.resolve({ response: 'first answer' });
    await p1;
    expect(store().geminiQuick).toEqual({ loading: false, response: 'second answer', error: '' });
    expect(renderWithStore(<GeminiQuickQuery />)).toContain('second answer');
  });

  it('the body names the session on screen, never the pills', async () => {
    fx.queryGemini = async () => ({ response: 'ok' });
    useF1Store.setState({ round: 21 }); // the pill only, no load
    await store().askGeminiQuick('Pit window?');
    expect(api.queryGemini.mock.calls.at(-1)[0]).toMatchObject({ year: 2024, round: 91, session_type: 'R' });
  });
});

describe('the telemetry spinner belongs to the screen on screen', () => {
  it('R91 telemetry answered after R92 landed leaves R92\'s own request spinning', async () => {
    const t91 = deferred();
    fx.getTelemetry = () => t91.promise;
    const p91 = store().fetchDriverTelemetry('AAA', 12);
    await loadReplay(92, B, 5);
    expect(store().telemetryLoading).toBe(false); // nothing of R92 asked yet
    const t92 = deferred();
    fx.getTelemetry = () => t92.promise;
    const p92 = store().fetchDriverTelemetry('XXX', 2);
    expect(store().telemetryLoading).toBe(true);
    t91.resolve({ telemetry: [{ Distance: 0, Speed: 100 }] });
    await p91;
    expect(store().telemetryLoading).toBe(true);
    expect(Object.keys(store().telemetryCache)).toEqual([]);
    t92.resolve({ telemetry: [{ Distance: 0, Speed: 200 }] });
    await p92;
    expect(store().telemetryLoading).toBe(false);
    expect(Object.keys(store().telemetryCache)).toEqual(['XXX-2-2024-92-R']);
  });

  it('two requests of the same screen: the spinner stays until both answered', async () => {
    const t1 = deferred();
    const t2 = deferred();
    fx.getTelemetry = (y, r, d) => (d === 'AAA' ? t1.promise : t2.promise);
    const p1 = store().fetchDriverTelemetry('AAA', 12);
    const p2 = store().fetchDriverTelemetry('BBB', 12);
    t1.resolve({ telemetry: [] });
    await p1;
    expect(store().telemetryLoading).toBe(true);
    t2.resolve({ telemetry: [] });
    await p2;
    expect(store().telemetryLoading).toBe(false);
  });
});
