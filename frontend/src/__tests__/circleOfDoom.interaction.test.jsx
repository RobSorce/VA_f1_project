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
//    signed (+ behind, − ahead);
//  - a keyboard seek under a pointer at rest (F4): the tooltip is refreshed
//    while its car stays under the pointer, and hidden (the highlight with
//    it) once the car has moved away.
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
const { pitStatus } = await import('../utils/circlePitLane.js');
const { stepLap } = await import('../hooks/useKeyboardShortcuts.js');
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

/** The store's clock in session seconds (lap-indexed mode: the leader's crossing). */
function nowOf() {
  const s = useF1Store.getState();
  return resolveSessionNow({
    currentTime: s.currentTime, sessionTimeOffset: s.sessionTimeOffset, replayActive: false,
    currentLap: s.currentLap, maxLap: s.maxLap, lapTimes: SESSION.lap_times,
  });
}

/** The ring the view draws at the store's clock. */
function stateNow() {
  return circleState(SESSION.lap_times, { sessionNow: nowOf() });
}

/** Stop under way of a car at the store's clock: 'lane', 'out' or null (circlePitLane.pitStatus). */
const stopOf = (d) => pitStatus(SESSION.lap_times, d, nowOf()).status;

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

let view = null;
async function mount(slot = SLOT) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, ...slot });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(CircleOfDoom, { slotSize: slot, measureText: measure })); });
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
/** Centre of a car in plot coordinates (its translate). */
function placeOf(d) {
  const m = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(view.car(d).getAttribute('transform'));
  return [Number(m[1]), Number(m[2])];
}

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
    // an unselected car on the leader's lap carries no tag (none is lapped
    // here), but for a car in the middle of its stop: PIT n or OUT
    expect(stopOf(ahead)).toBeNull();
    expect(stopOf(behind)).toBeNull();
    for (const d of order.filter((x) => x !== ahead && x !== behind)) {
      expect(st.cars.find((c) => c.driver === d).lapOffsetToLeader).toBe(0);
      const stop = stopOf(d);
      if (stop === 'lane') expect(tagOf(d)).toMatch(/^PIT \d+$/);
      else if (stop === 'out') expect(tagOf(d)).toBe('OUT');
      else expect(tagOf(d)).toBeNull();
    }
  });

  it('the hover readout and the tooltip use the same reference, signed: + behind it, − ahead of it', async () => {
    // the cars not stopping at lap 12 (a stopping car's gap goes to the tooltip only)
    const order = (() => { raceAtLap(12); return stateNow().cars.map((c) => c.driver).filter((d) => !stopOf(d)); })();
    expect(order.length).toBeGreaterThanOrEqual(5);
    const ref = order[2];
    raceAtLap(12, { selectedDrivers: [order[3], ref] });
    await mount();
    const st = stateNow();
    for (const [other, sign] of [[order[0], MINUS], [order[order.length - 1], '+']]) {
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

// Lap 12 of the synthetic race: PIA in the pit lane, NOR and HAM on their
// out-laps (helpers/chartFixtures.js: a stop on laps 8 to 11)
describe('a car in the middle of its stop: PIT / OUT, never a gap (stop rule)', () => {
  /** Angle of a car as drawn, clockwise from the top, in (-pi, pi]; its radius. */
  function polarOf(d) {
    const ring = view.host.querySelector('circle.cod-ring');
    const [cx, cy] = [Number(ring.getAttribute('cx')), Number(ring.getAttribute('cy'))];
    const [x, y] = placeOf(d);
    return { angle: Math.atan2(x - cx, cy - y), r: Math.hypot(x - cx, y - cy) };
  }

  it('its tag is PIT n (whole seconds since the pit entry) or OUT; hovering it draws no readout, its gap is in the tooltip "(before its stop)"', async () => {
    raceAtLap(12, { focusDriver: 'VER' });
    await mount();
    const st = stateNow();
    expect(['PIA', 'NOR', 'HAM', 'VER'].map(stopOf)).toEqual(['lane', 'out', 'out', null]);
    const pin = pitStatus(SESSION.lap_times, 'PIA', nowOf()).pitInTime;
    expect(tagOf('PIA')).toBe(`PIT ${Math.floor(nowOf() - pin)}`);
    expect(tagOf('NOR')).toBe('OUT');
    expect(tagOf('HAM')).toBe('OUT');
    expect(view.label('PIA').querySelector('.cod-label__stop')).not.toBeNull();
    await hover('PIA');
    expect(view.host.querySelector('g.cod-gap-layer')).toBeNull();
    const g = gapSeconds('VER', 'PIA', st);
    const k = lapOffset('VER', 'PIA', st);
    expect(tooltipText()).toContain(`Gap to VER ${k ? lapTag(k) : `${signed(g)} s`} (before its stop)`);
    expect(tooltipText()).toMatch(/Status In the pit lane \d+\.\d s · (median lane time this race \d+\.\d s \(\d+ stops\)|no lane median yet)/);
    await act(async () => { dom.mouse(view.car('PIA'), 'mouseout', centreOf('PIA')); });
    await hover('NOR');
    expect(view.host.querySelector('g.cod-gap-layer')).toBeNull();
    expect(tooltipText()).toContain('(before its stop)');
    expect(tooltipText()).toMatch(/Status Out-lap, \d+\.\d s since the pit exit/);
  });

  it('a car in the lane sits on the pit-lane segment, between -θ and the timing line, at its radius; the others on the ring', async () => {
    raceAtLap(12, { focusDriver: 'VER' });
    await mount();
    const lane = view.host.querySelector('path.cod-pitlane');
    const rPit = Number(lane.getAttribute('data-r'));
    const theta = Number(lane.getAttribute('data-span'));
    expect(theta).toBeGreaterThanOrEqual(Math.PI / 9 - 1e-4);
    expect(theta).toBeLessThanOrEqual(Math.PI / 3 + 1e-4);
    const pia = polarOf('PIA');
    expect(view.car('PIA').getAttribute('data-pit')).toBe('true');
    expect(pia.r).toBeCloseTo(rPit, 1);
    expect(pia.angle).toBeGreaterThanOrEqual(-theta - 1e-6);
    expect(pia.angle).toBeLessThanOrEqual(1e-6);
    const R = Number(view.host.querySelector('circle.cod-ring').getAttribute('r'));
    for (const d of ['NOR', 'VER']) expect(polarOf(d).r).toBeCloseTo(R, 1);
  });

  it('a stopping reference: no gap tag against it; its own tag reads PIT / OUT', async () => {
    raceAtLap(12, { focusDriver: 'HAM' });
    await mount();
    expect(tagOf('HAM')).toBe('OUT');
    for (const d of ['RUS', 'VER', 'LEC', 'SAI', 'PER']) expect(tagOf(d)).toBeNull();
    expect(tagOf('PIA')).toMatch(/^PIT \d+$/);
    await hover('LEC');
    expect(view.host.querySelector('g.cod-gap-layer')).toBeNull();
    expect(tooltipText()).toContain("(before HAM's stop)");
  });
});

// The gap list (CircleGapList.jsx): beside the plot under the legend in the
// large slot; in the Pit Wall slot of 1536x864 (371 x 250, the legend under
// the plot) the "gaps" toggle swaps the legend for the gap grid
describe('gap list: hover, clear, the "gaps" toggle', () => {
  const UNDER = { width: 371, height: 250 };
  const KEY = 'va-cod-gaps-v1';

  it('hovering a row highlights its car; the × clears the selection', async () => {
    raceAtLap(15, { selectedDrivers: ['NOR', 'LEC', 'SAI'] });
    await mount();
    const list = view.host.querySelector('.cod-gaps--side');
    expect(list).not.toBeNull();
    expect([...list.querySelectorAll('.cod-gaps__row')].map((r) => r.getAttribute('data-driver'))).toEqual(['NOR', 'LEC', 'SAI']);
    const row = list.querySelector('.cod-gaps__row[data-driver="LEC"]');
    await act(async () => { dom.mouse(row, 'mouseover'); });
    expect(useF1Store.getState().highlightedDriver).toBe('LEC');
    await act(async () => { dom.mouse(row, 'mouseout'); });
    expect(useF1Store.getState().highlightedDriver).toBeNull();
    const clear = list.querySelector('button.cod-gaps__clear');
    expect(clear.getAttribute('aria-label')).toBe('Clear comparison');
    await act(async () => { dom.mouse(clear, 'click'); });
    expect(useF1Store.getState().selectedDrivers).toEqual([]);
    expect(view.host.querySelector('.cod-gaps__hint').textContent).toBe('Shift-click cars to compare');
  });

  it('"gaps" (aria-pressed, on by default) swaps the legend for the gap grid of the same rows, and is kept in localStorage', async () => {
    localStorage.removeItem(KEY);
    raceAtLap(15, { focusDriver: 'LEC' });
    await mount(UNDER);
    const toggle = view.host.querySelector('button.cod-gaps-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const grid = view.host.querySelector('.cod-gaps--grid');
    expect(grid).not.toBeNull();
    expect(view.host.querySelector('.cod-legend')).toBeNull();
    const ring = view.host.querySelector('circle.cod-ring').getAttribute('r');
    await act(async () => { dom.mouse(toggle, 'click'); });
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(view.host.querySelector('button.cod-gaps-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(view.host.querySelector('.cod-gaps--grid')).toBeNull();
    const legend = view.host.querySelector('.cod-legend');
    expect(legend.querySelectorAll('.cod-legend__item').length).toBe(9);
    const cols = Number(/repeat\((\d+)/.exec(legend.style.gridTemplateColumns)[1]);
    expect(Number(grid.getAttribute('data-rows'))).toBe(Math.ceil(9 / cols));
    // the ring does not move
    expect(view.host.querySelector('circle.cod-ring').getAttribute('r')).toBe(ring);
    await view.unmount();
    // kept: a new view opens with the legend
    await mount(UNDER);
    expect(view.host.querySelector('button.cod-gaps-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(view.host.querySelector('.cod-legend')).not.toBeNull();
    localStorage.removeItem(KEY);
  });

  it('beside the plot there is no "gaps" toggle: the list is always under the legend', async () => {
    raceAtLap(15, { focusDriver: 'LEC' });
    await mount();
    expect(view.host.querySelector('.cod--side')).not.toBeNull();
    expect(view.host.querySelector('button.cod-gaps-toggle')).toBeNull();
    expect(view.host.querySelector('.cod__side .cod-legend')).not.toBeNull();
    expect(view.host.querySelector('.cod__side .cod-gaps--side')).not.toBeNull();
  });
});

describe('F4: a keyboard seek under a pointer at rest', () => {
  it('→ (one lap on): the tooltip of the car still under the pointer shows the new lap and gap', async () => {
    // lap 15: every car has made its stop, the leader stays the same
    raceAtLap(15, { selectedDrivers: ['NOR'] });
    await mount();
    const leader = stateNow().cars[0].driver;
    await hover(leader);
    expect(useF1Store.getState().highlightedDriver).toBe(leader);
    const before = tooltipText();
    expect(before).toContain('Lap 15');
    // the → key
    await act(async () => { stepLap(useF1Store.getState(), 1); });
    await settle();
    const st = stateNow();
    expect(st.cars[0].driver).toBe(leader);
    // in lap order the leader is at the line, where the pointer rests
    const hit = Number(view.car(leader).querySelector('circle.cod-car__hit').getAttribute('r'));
    const [x, y] = placeOf(leader);
    const p = dom.toClient(view.svg(), x, y);
    const { clientX, clientY } = centreOf(leader);
    expect(Math.hypot(p.clientX - clientX, p.clientY - clientY)).toBeLessThanOrEqual(hit);
    const g = gapSeconds('NOR', leader, st);
    expect(tooltipShown()).toBe(true);
    expect(tooltipText()).toContain('Lap 16');
    expect(tooltipText()).toContain(`Gap to NOR ${signed(g)} s`);
    expect(tooltipText()).not.toBe(before);
  });

  it('a seek that moves the car away hides the tooltip and drops the highlight', async () => {
    raceAtLap(12);
    await mount();
    const last = stateNow().cars.at(-1).driver;
    await hover(last);
    expect(tooltipShown()).toBe(true);
    const { clientX, clientY } = centreOf(last);
    const hit = Number(view.car(last).querySelector('circle.cod-car__hit').getAttribute('r'));
    // a lap picked on the timeline (Home / End seek the same way)
    await act(async () => { useF1Store.getState().setCurrentLap(4); });
    await settle();
    const [x, y] = placeOf(last);
    const p = dom.toClient(view.svg(), x, y);
    expect(Math.hypot(p.clientX - clientX, p.clientY - clientY)).toBeGreaterThan(hit + 1);
    expect(tooltipShown()).toBe(false);
    expect(useF1Store.getState().highlightedDriver).toBeNull();
  });
});
