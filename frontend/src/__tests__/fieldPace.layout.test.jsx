// The Race Pace view's row text (components/visualizations/FieldPace.jsx) on
// the five tracked demo races (frontend/public/data), measured in Inter as
// the font files of public/fonts make it (scripts/audit/fontMetrics.mjs) at
// the 1536 x 750 floors, instead of the mini DOM's 5 px a character: a
// driver label never covers its row's team name or gap text, nor another
// label of the row.
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
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { setSessionDriverColors, FONT_FLOOR_PX } = await import('../utils/colors.js');
const { default: FieldPace } = await import('../components/visualizations/FieldPace.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const DEMO = [[2024, 16], [2024, 5], [2024, 7], [2025, 16], [2025, 1]];
const load = (y, r) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, `../public/data/${y}_${r}_R/session.json.gz`))));
const INITIAL = useF1Store.getState();

const sizeOf = (el) => (/font-size-label/.test(el.style['font-size'] || '') ? FONT_FLOOR_PX.label : FONT_FLOOR_PX.data);
const widthOf = (el) => INTER.width(el.textContent, sizeOf(el), Number(el.getAttribute('font-weight') || 400));
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
const baseLength = ElementProto.getComputedTextLength;
if (INTER) ElementProto.getComputedTextLength = function measured() { return widthOf(this); };

/** [left, right] of a text drawn at its x with its text-anchor. */
function extent(t) {
  const x = Number(t.getAttribute('x'));
  const w = widthOf(t);
  const anchor = t.getAttribute('text-anchor') || 'start';
  return anchor === 'end' ? [x - w, x] : anchor === 'middle' ? [x - w / 2, x + w / 2] : [x, x + w];
}

let view = null;
async function mount(session, { width, height }) {
  if (view) await view.unmount();
  setSessionDriverColors(session.driver_info);
  const lt = session.lap_times;
  const maxLap = Math.max(...lt.map((r) => r.LapNumber));
  useF1Store.setState({
    ...INITIAL, sessionType: 'R', sessionData: session, trackStatus: session.track_status,
    sessionTimeOffset: computeSessionTimeOffset(lt), maxLap, totalRaceLaps: maxLap, currentLap: maxLap, lapModeRaceOver: true,
    totalFrames: 0, currentTime: 0, focusDriver: null, selectedDrivers: [], highlightedDriver: null,
    brushLapRange: null, selectedLapRange: null,
  });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(FieldPace)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  view = { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); view = null; } };
  return view;
}

afterEach(async () => {
  if (view) await view.unmount();
});
afterAll(() => {
  ElementProto.getComputedTextLength = baseLength;
  useF1Store.setState({ ...INITIAL });
});

describe.skipIf(!INTER)('driver labels in their row', () => {
  for (const [year, round] of DEMO) {
    it(`${year} R${round} at 560, 594 and 700 px: no label over the team name, the gap text or another label`, async () => {
      const session = load(year, round);
      let labels = 0;
      for (const width of [560, 594, 700]) {
        const { host } = await mount(session, { width, height: 260 });
        const svg = host.querySelectorAll('svg').find((s) => s.style.width === '100%');
        for (const row of svg.querySelectorAll('.fp-row')) {
          const team = extent(row.querySelector('.fp-team'));
          const gap = row.querySelector('.fp-gap') ? extent(row.querySelector('.fp-gap')) : [Infinity, Infinity];
          const own = row.querySelectorAll('.fp-label').map((t) => ({ text: t.textContent, e: extent(t) }));
          // every racing driver's mark keeps a label (the code at least)
          expect(own.length).toBe(row.querySelectorAll('.fp-mark').length);
          for (const [i, l] of own.entries()) {
            labels += 1;
            const where = `${row.getAttribute('data-team')} ${l.text} at ${width} px`;
            expect(l.e[0], `${where}: team name to ${team[1].toFixed(1)}`).toBeGreaterThanOrEqual(team[1]);
            expect(l.e[1], `${where}: gap text from ${gap[0].toFixed(1)}`).toBeLessThanOrEqual(gap[0]);
            for (const m of own.slice(i + 1)) {
              expect(l.e[1] <= m.e[0] || m.e[1] <= l.e[0], `${where} and ${m.text}`).toBe(true);
            }
          }
        }
      }
      expect(labels).toBeGreaterThan(40);
    });
  }
});
