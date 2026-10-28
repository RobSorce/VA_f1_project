// The Race Trace's text layout (components/visualizations/RaceTrace.jsx) on
// the tracked demo race 2024 R5 (frontend/public/data), measured in the
// app's own faces: every text of the chart is as wide as the font files of
// public/fonts make it (scripts/audit/fontMetrics.mjs), Inter for the chart
// text, JetBrains Mono for an .axis text, at the 1536 x 750 floors (11 px
// data, 10 px labels), instead of the mini DOM's 5 px a character.
//  - the y tick labels keep their sign: the left margin holds the widest;
//  - the x axis title 'lap' and the tick labels never share a spot.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { loadFaces } from '../../scripts/audit/fontMetrics.mjs';

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
const INTER = loadFaces('Inter');
const MONO = loadFaces('JetBrains Mono');
const haveFonts = INTER != null && MONO != null;
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { setSessionDriverColors, FONT_FLOOR_PX } = await import('../utils/colors.js');
const { default: RaceTrace } = await import('../components/visualizations/RaceTrace.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const CHINA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, '../public/data/2024_5_R/session.json.gz'))));
const LT = CHINA.lap_times;
const MAX_LAP = Math.max(...LT.map((r) => r.LapNumber));
const INITIAL = useF1Store.getState();

// A text's size and face as the CSS draws it at 1536 x 750
const sizeOf = (el) => (/font-size-label/.test(el.style['font-size'] || '') ? FONT_FLOOR_PX.label : FONT_FLOOR_PX.data);
const weightOf = (el) => Number(el.getAttribute('font-weight') || 400);
const faceOf = (el) => (el.closest('.axis') ? MONO : INTER);
const widthOf = (el) => faceOf(el).width(el.textContent, sizeOf(el), weightOf(el));
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
const baseLength = ElementProto.getComputedTextLength;
if (haveFonts) ElementProto.getComputedTextLength = function measured() { return widthOf(this); };

function state(extra = {}) {
  setSessionDriverColors(CHINA.driver_info);
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 5, sessionType: 'R',
    sessionData: CHINA, trackStatus: CHINA.track_status,
    sessionTimeOffset: computeSessionTimeOffset(LT),
    maxLap: MAX_LAP, totalRaceLaps: MAX_LAP, currentLap: 32, lapModeRaceOver: false,
    totalFrames: 0, currentTime: 0, isLiveMode: false,
    focusDriver: null, lapDeltaBaseDriver: null, selectedDrivers: [], highlightedDriver: null,
    selectedLapRange: null, brushLapRange: null,
    raceTraceReference: 'field', raceTraceWindow: 'focus',
    ...extra,
  });
}

let view = null;
async function mount({ width, height }) {
  if (view) await view.unmount();
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(RaceTrace)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  view = { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); view = null; } };
  return view;
}
const chartSvg = (host) => host.querySelectorAll('svg').find((s) => s.style.width === '100%');
const translateOf = (el) => (el.getAttribute('transform') || '').match(/translate\(([-\d.]+),\s*([-\d.]+)\)/).slice(1).map(Number);

afterEach(async () => {
  if (view) await view.unmount();
});
afterAll(() => {
  ElementProto.getComputedTextLength = baseLength;
  useF1Store.setState({ ...INITIAL });
});

describe.skipIf(!haveFonts)('axes', () => {
  // the y tick label's right edge is at x = -9 of the plot (6 px tick, 3 px padding)
  for (const [name, extra] of [
    ['every car (down to the lapped cars, tick labels of 7 characters)', { raceTraceWindow: 'all' }],
    ['VER ± one stop (tick labels of 6 characters)', { focusDriver: 'VER' }],
  ]) {
    it(`window ${name}: the left margin holds the widest y tick label`, async () => {
      state(extra);
      const { host } = await mount({ width: 593, height: 211 });
      const svg = chartSvg(host);
      const [left] = translateOf(svg.querySelector('g'));
      const ticks = svg.querySelectorAll('.rt-axis-y .tick text');
      expect(ticks.length).toBeGreaterThan(2);
      expect(Math.max(...ticks.map((t) => t.textContent.length))).toBeGreaterThanOrEqual(6);
      for (const t of ticks) expect(MONO.width(t.textContent, FONT_FLOOR_PX.data) + 9, t.textContent).toBeLessThanOrEqual(left);
    });
  }

  for (const lap of [36, 41]) {
    it(`currentLap ${lap}: no x tick label reaches into the 'lap' title`, async () => {
      state({ currentLap: lap });
      const { host } = await mount({ width: 593, height: 211 });
      const svg = chartSvg(host);
      const title = svg.querySelectorAll('.rt-axis-title').find((t) => t.textContent === 'lap');
      const titleLeft = Number(title.getAttribute('x')) - widthOf(title);
      const ticks = svg.querySelectorAll('.rt-axis-x .tick');
      expect(ticks.length).toBeGreaterThan(3);
      for (const tick of ticks) {
        const t = tick.querySelector('text');
        if (!t) continue;
        expect(translateOf(tick)[0] + widthOf(t) / 2, t.textContent).toBeLessThan(titleLeft);
      }
      // the drop takes the tick labels under the title only
      expect(ticks.filter((tick) => tick.querySelector('text')).length).toBeGreaterThanOrEqual(ticks.length - 1);
    });
  }
});
