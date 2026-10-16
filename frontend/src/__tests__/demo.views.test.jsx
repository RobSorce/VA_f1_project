// The model-only views in the static demo (utils/demoMode.js): with no
// backend the views say "Requires the local backend" where a model answer
// would be, instead of an empty panel or a spinner:
//  - Race Prediction: a Forecast tab with the note (the LSTM forecast);
//  - Telemetry strip: the note in place of the traces (car telemetry);
//  - Strategy assistant: a question sent gets the note as its answer (the
//    store keeps the BackendOnlyError message), and the inputs say it.
// The demo build answers the API from public/data (demo.apiClient.test.js);
// here the flag is set as a demo build sets it (source 'build').
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installMiniDom } from './helpers/miniDom.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

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

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const {
  useDemoMode, BACKEND_ONLY_TEXT, BACKEND_ONLY_FEATURES,
} = await import('../utils/demoMode.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { default: RacePredictionPanel } = await import('../components/visualizations/RacePredictionPanel.jsx');
const { default: GeminiAssistant } = await import('../components/visualizations/GeminiAssistant.jsx');

const INITIAL = useF1Store.getState();
const HAVE = hasCachedSession(2024, 16);
const monza = HAVE ? loadCachedSession(2024, 16) : null;
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** Mount a component in the mini DOM (zustand reads the live state there). */
async function mount(Component, width = 520, height = 760) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  return { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
}

function monzaAtLap(currentLap) {
  const lapTimes = monza.lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber));
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  const raceSituationData = extractRaceSituationFeatures({
    lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
  });
  useF1Store.setState({
    ...INITIAL,
    year: 2024,
    round: 16,
    sessionType: 'R',
    sessionData: monza,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    maxLap,
    totalRaceLaps: maxLap,
    currentLap,
    totalFrames: 0,
    currentTime: 0,
    raceSituationData,
    selectedDrivers: ['LEC'],
    focusDriver: 'LEC',
  });
}

afterEach(() => {
  useDemoMode.setState({ active: false, source: null, reason: null });
  useF1Store.setState({ ...INITIAL });
});

describe.skipIf(!HAVE)('static demo: the model-only views say what needs the local backend (Monza 2024 lap 30)', () => {
  it('Race Prediction: a Forecast tab with the note; none without the demo and without a forecast', async () => {
    monzaAtLap(30);
    useDemoMode.setState({ active: true, source: 'build', reason: null });
    const view = await mount(RacePredictionPanel);
    const { host } = view;
    const tab = [...host.querySelectorAll('button')].find((b) => text(b) === 'Forecast');
    expect(tab).toBeTruthy();
    await act(async () => { dom.mouse(tab, 'click', { bubbles: true }); });
    const note = host.querySelector('.mcr-backend-only');
    expect(text(note)).toBe(`${BACKEND_ONLY_TEXT}: ${BACKEND_ONLY_FEATURES.forecast}.`);
    // the backend reachable: no forecast yet, no Forecast tab
    await act(async () => { useDemoMode.setState({ active: false, source: null, reason: null }); });
    expect([...host.querySelectorAll('button')].some((b) => text(b) === 'Forecast')).toBe(false);
    await view.unmount();
  });

  it('Telemetry strip: the note in place of the traces (source: the mini DOM has no <select>)', () => {
    // its lap picker is a <select>, which the mini DOM cannot mount, and a
    // server render reads the demo store's initial state: the branch is read
    // from the source, right after the "no driver" state
    const src = fs.readFileSync(path.resolve(__dirname, '../components/visualizations/TelemetryStrip.jsx'), 'utf8');
    expect(src).toMatch(/const demoActive = useDemoMode\(\(s\) => s\.active\);/);
    expect(src).toMatch(/\) : demoActive && !hasData \? \(\s*<div className="telemetry-strip__empty">\{BACKEND_ONLY_TEXT\}: \{BACKEND_ONLY_FEATURES\.telemetry\}\.<\/div>/);
    expect(BACKEND_ONLY_FEATURES.telemetry).toBe('car telemetry');
  });

  it('Strategy assistant: the input names the reason; a question gets the note as its answer', async () => {
    monzaAtLap(30);
    useDemoMode.setState({ active: true, source: 'build', reason: null });
    const view = await mount(GeminiAssistant);
    expect(view.host.querySelector('input.chat-input').getAttribute('placeholder')).toBe(`${BACKEND_ONLY_TEXT} (Gemini)`);
    await view.unmount();
    useF1Store.setState({ geminiMessages: [] });
    await useF1Store.getState().sendGeminiQuery('pit now?');
    const last = useF1Store.getState().geminiMessages.at(-1);
    expect(last.role).toBe('ai');
    expect(last.content).toBe(`${BACKEND_ONLY_TEXT}: ${BACKEND_ONLY_FEATURES.gemini}.`);
  });
});
