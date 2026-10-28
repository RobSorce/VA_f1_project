// The Circle of Doom's pointer rules, mounted in the mini DOM with the
// synthetic race (helpers/chartFixtures.js), so they run without the race
// cache:
//  - a click focuses a car, the second click of a double-click leaves the
//    focus on; Shift-, Ctrl- or Cmd-click toggles the car in the selection
//    shared with the other views and leaves the focus alone; Shift on
//    mousedown starts no text selection;
//  - with no focus, the gaps are measured from the selected car first in race
//    order: its label reads 'ref', the other selected cars' labels carry
//    gapSeconds to it, the hover readout and the tooltip use the same car,
//    signed (+ behind, − ahead).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  return mocked;
});
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
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { circleState, gapSeconds, lapOffset } = await import('../utils/circleOfDoom.js');
const { installResizeObserverMock, syntheticSession } = await import('./helpers/chartFixtures.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');

const ro = installResizeObserverMock();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const MINUS = '−';
// A slot large enough for every label of the 8 cars and the readout on the ring
const SLOT = { width: 720, height: 460 };
// Text widths where the mini DOM lays out no text: 0.62 em a character
const measure = (text, size) => text.length * size * 0.62;

/** The view's rule for a gap tag: one decimal, + behind, − ahead. */
function signed(s) {
  if (Math.abs(s) < 0.05) return '0.0';
  return s > 0 ? `+${s.toFixed(1)}` : `${MINUS}${(-s).toFixed(1)}`;
}
const lapTag = (k) => (k > 0 ? `${k}L` : `${MINUS}${-k}L`);

function raceAtLap(lap, extra = {}) {
  const offset = computeSessionTimeOffset(SESSION.lap_times);
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R',
    sessionData: SESSION, drivers: SESSION.driver_info,
    trackStatus: SESSION.track_status, sessionTimeOffset: offset,
    maxLap: 20, totalRaceLaps: 20, currentLap: lap,
    totalFrames: 0, currentTime: 0,
    ...extra,
  });
}

/** The ring the view draws at the store's clock (lap-indexed mode: the leader's crossing). */
function stateNow() {
  const s = useF1Store.getState();
  const sessionNow = resolveSessionNow({
    currentTime: s.currentTime, sessionTimeOffset: s.sessionTimeOffset, replayActive: false,
    currentLap: s.currentLap, maxLap: s.maxLap, lapTimes: SESSION.lap_times,
  });
  return circleState(SESSION.lap_times, { sessionNow });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

let view = null;
async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, ...SLOT });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(CircleOfDoom, { slotSize: SLOT, measureText: measure })); });
  await settle();
  const svg = () => host.querySelector('svg.cod__svg');
  // the plot on screen at its own size, as the browser lays it out
  const [, , w, h] = svg().getAttribute('viewBox').split(' ').map(Number);
  dom.setRect(svg(), { left: 0, top: 0, width: w, height: h });
  view = {
    host,
    svg,
    car: (d) => host.querySelector(`g.cod-car[data-driver="${d}"]`),
    label: (d) => host.querySelector(`text.cod-label[data-driver="${d}"]`),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
  return view;
}

/** The pointer on the centre of a car (client coordinates). */
const centreOf = (d) => dom.toClient(view.car(d), 0, 0);
const click = (d, init = {}) => act(async () => { dom.mouse(view.car(d), 'click', { ...centreOf(d), ...init }); });
const hover = (d) => act(async () => { dom.mouse(view.car(d), 'mouseover', centreOf(d)); });
const tooltip = () => dom.document.body.querySelector('.cod-tooltip');
const tooltipShown = () => {
  const t = tooltip();
  return !!t && /\bvisible\b/.test(t.getAttribute('class') || '');
};
const tooltipText = () => (tooltip()?.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const tagOf = (d) => view.label(d)?.querySelector('.cod-label__gap')?.textContent ?? null;

beforeEach(() => {
  for (const t of dom.document.body.querySelectorAll('.cod-tooltip')) t.remove();
});
afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  useF1Store.setState({ ...INITIAL });
});

describe('clicks on a car', () => {
  it('a plain click sets the focus and leaves the selection alone', async () => {
    raceAtLap(12);
    await mount();
    await click('NOR');
    expect(useF1Store.getState().focusDriver).toBe('NOR');
    expect(useF1Store.getState().selectedDrivers).toEqual([]);
  });

  it('Shift-, Ctrl- and Cmd-click toggle selectedDrivers; the focus is unchanged', async () => {
    raceAtLap(12, { focusDriver: 'NOR' });
    await mount();
    await click('PIA', { shiftKey: true });
    expect(useF1Store.getState().selectedDrivers).toEqual(['PIA']);
    await click('LEC', { ctrlKey: true });
    expect(useF1Store.getState().selectedDrivers).toEqual(['PIA', 'LEC']);
    await click('PIA', { metaKey: true });
    expect(useF1Store.getState().selectedDrivers).toEqual(['LEC']);
    await click('NOR', { shiftKey: true });
    expect(useF1Store.getState().selectedDrivers).toEqual(['LEC', 'NOR']);
    // the focus car itself can be selected; the focus never moves or clears
    expect(useF1Store.getState().focusDriver).toBe('NOR');
    // the selected cars get the blue selection ring
    for (const d of ['LEC', 'NOR']) expect(view.car(d).querySelector('circle.cod-select-ring')).toBeTruthy();
    expect(view.car('PIA').querySelector('circle.cod-select-ring')).toBeNull();
  });

  it('the second click of a double-click (detail 2) leaves the focus on; a later click clears it', async () => {
    raceAtLap(12);
    await mount();
    await click('VER', { detail: 1 });
    expect(useF1Store.getState().focusDriver).toBe('VER');
    await click('VER', { detail: 2 });
    expect(useF1Store.getState().focusDriver).toBe('VER');
    await click('VER', { detail: 1 });
    expect(useF1Store.getState().focusDriver).toBeNull();
  });

  it('Shift on mousedown starts no text selection (default prevented); the plot is user-select none', async () => {
    raceAtLap(12);
    await mount();
    let ev;
    await act(async () => { ev = dom.mouse(view.car('HAM'), 'mousedown', { ...centreOf('HAM'), shiftKey: true }); });
    expect(ev.defaultPrevented).toBe(true);
    await act(async () => { ev = dom.mouse(view.car('HAM'), 'mousedown', centreOf('HAM')); });
    expect(ev.defaultPrevented).toBe(false);
    const css = fs.readFileSync(path.join(SRC, 'styles/visualizations.css'), 'utf8');
    expect(css).toMatch(/\n\.cod__svg \{[^}]*user-select: none;/);
  });

  it("the car tooltip ends with the click rules: 'Click: focus · Shift-click: compare'", async () => {
    raceAtLap(12);
    await mount();
    await hover('PIA');
    expect(tooltipShown()).toBe(true);
    expect(tooltip().innerHTML).toMatch(/<span class="tooltip-label">Click: focus · Shift-click: compare<\/span><\/div>$/);
  });
});

describe('gap tags with no focus: measured from the selected car first in race order', () => {
  it("two selected cars: the first in race order is tagged 'ref', the other carries gapSeconds to it", async () => {
    const order = (() => { raceAtLap(12); return stateNow().cars.map((c) => c.driver); })();
    // selected in the order opposite to the race order: the race order decides
    const [ahead, behind] = [order[2], order[5]];
    raceAtLap(12, { selectedDrivers: [behind, ahead] });
    await mount();
    const st = stateNow();
    expect(view.svg().getAttribute('data-hidden-labels')).toBe('0');
    expect(tagOf(ahead)).toBe('ref');
    const k = lapOffset(ahead, behind, st);
    expect(tagOf(behind)).toBe(k ? lapTag(k) : signed(gapSeconds(ahead, behind, st)));
    expect(tagOf(behind)).toMatch(/^\+\d+\.\d$/);
    // an unselected car on the leader's lap carries no tag (none is lapped here)
    for (const d of order.filter((x) => x !== ahead && x !== behind)) {
      expect(st.cars.find((c) => c.driver === d).lapOffsetToLeader).toBe(0);
      expect(tagOf(d)).toBeNull();
    }
  });

  it('the hover readout and the tooltip use the same reference, signed: + behind it, − ahead of it', async () => {
    const order = (() => { raceAtLap(12); return stateNow().cars.map((c) => c.driver); })();
    const ref = order[3];
    raceAtLap(12, { selectedDrivers: [order[6], ref] });
    await mount();
    const st = stateNow();
    for (const [other, sign] of [[order[0], MINUS], [order[7], '+']]) {
      await hover(other);
      const g = gapSeconds(ref, other, st);
      expect(signed(g).startsWith(sign)).toBe(true);
      const layer = view.host.querySelector('g.cod-gap-layer');
      expect(layer.getAttribute('data-gap')).toBe(`${ref}-${other}`);
      expect(layer.getAttribute('data-gap-place')).toBe('ring');
      expect(layer.querySelector('text.cod-gap-text').textContent).toBe(`${signed(g)} s`);
      expect(tooltipText()).toContain(`Gap to ${ref} ${signed(g)} s`);
      await act(async () => { dom.mouse(view.car(other), 'mouseout', centreOf(other)); });
    }
  });

  it('with a focus the readout is signed too (from the focus)', async () => {
    raceAtLap(12, { focusDriver: 'LEC', selectedDrivers: ['VER'] });
    await mount();
    const st = stateNow();
    await hover('SAI');
    const g = gapSeconds('LEC', 'SAI', st);
    const layer = view.host.querySelector('g.cod-gap-layer');
    expect(layer.getAttribute('data-gap')).toBe('LEC-SAI');
    const text = layer.querySelector('text.cod-gap-text')?.textContent ?? tooltipText();
    expect(text).toContain(`${signed(g)} s`);
    // every label but the focus's carries its tag to the focus, whatever the selection
    expect(tagOf('VER')).toBe(signed(gapSeconds('LEC', 'VER', st)));
  });

  it('hovering the reference itself draws no readout', async () => {
    const order = (() => { raceAtLap(12); return stateNow().cars.map((c) => c.driver); })();
    raceAtLap(12, { selectedDrivers: [order[4], order[1]] });
    await mount();
    await hover(order[1]);
    expect(view.host.querySelector('g.cod-gap-layer')).toBeNull();
    expect(tooltipText()).not.toContain('Gap to');
  });

  it('the legend keeps its 9 items', async () => {
    raceAtLap(12, { selectedDrivers: ['NOR', 'SAI'] });
    await mount();
    expect(view.host.querySelectorAll('.cod-legend__item').length).toBe(9);
  });
});
