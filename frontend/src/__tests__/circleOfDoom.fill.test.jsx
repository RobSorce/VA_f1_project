// The Circle of Doom's plot uses the room of its Pit Wall cell
// at the four target viewports and follows the cell when the window moves
// between Roberto's screens.
//
// The browser pass (docs/evidence/browser_audit_2026-10-16.md,
// "Re-check after Phase 9c") measured at 2048 x 1100 a 609 x 266 main area
// (.cod__main) holding a 356 x 134 plot: the layout of the 1536 x 750 cell,
// kept after the move. The view lays out from the measured .cod box
// (panelLayout: the legend under or beside the plot, the legend line, the
// plot the rest), so a measure that never lands leaves the plot at its old
// size; the shared hook now applies it at the next frame or, frames held
// back, after FRAME_FALLBACK_MS, and measures afresh on a window resize
// (utils/views/chartBox.js useChartBox).
//
// Mounted in the mini DOM with the synthetic race (helpers/chartFixtures.js)
// and the real Formula1 metrics as its text measure; the cell sizes are the
// model of helpers/pitWallMaps.js (codSlotAt: the CSS as written).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock, syntheticSession } = await import('./helpers/chartFixtures.js');
const { loadCss, VIEWPORTS } = await import('./helpers/layoutModel.js');
const { codSlotAt, haveFormula1 } = await import('./helpers/pitWallMaps.js');
const { textWidth } = await import('./helpers/fontWidths.js');
const { screenTexts, FLOORS } = await import('./helpers/screenFont.js');
const { FRAME_FALLBACK_MS } = await import('../utils/views/chartBox.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');

const ro = installResizeObserverMock();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = loadCss(SRC);
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);

// The layout constants of CircleOfDoom.jsx (.cod-legend rows, the legend line, the gaps)
const LEGEND_ROW_H = 14;
const LEGEND_ROW_GAP = 1;
const STATUS_LINE_H = 13;
const BLOCK_GAP = 2;

/** The view's measureText: the face its weight maps to (700 by default). */
const measure = haveFormula1
  ? (t, size, weight = 700) => textWidth(t, size, weight >= 900 ? 900 : weight >= 600 ? 700 : 400)
  : null;

function raceAtLap(lap) {
  const offset = computeSessionTimeOffset(SESSION.lap_times);
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R',
    sessionData: SESSION, drivers: SESSION.driver_info,
    trackStatus: SESSION.track_status, sessionTimeOffset: offset,
    maxLap: 20, totalRaceLaps: 20, currentLap: lap,
    totalFrames: 0, currentTime: 0,
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

let view = null;
async function mountIn(slot) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: slot.width, height: slot.height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(CircleOfDoom, { measureText: measure })); });
  await settle();
  view = {
    host,
    wrap: () => host.querySelector('.cod'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
  return view;
}

/** The slot (.cod) gets a new size: its rect and the observer's notification. */
async function resizeSlot(slot, { notify = true } = {}) {
  const el = view.wrap();
  dom.setRect(el, { left: 0, top: 0, width: slot.width, height: slot.height });
  if (notify) {
    await act(async () => { ro.notify(el, slot.width, slot.height); });
    await settle();
  }
}

/** What the view laid out: the plot, the legend grid, the legend line, the ring. */
function laidOut() {
  const wrap = view.wrap();
  const plot = wrap.querySelector('.cod__plot');
  const svg = plot.querySelector('svg.cod__svg');
  const legend = wrap.querySelector('.cod-legend');
  const cols = Number(/repeat\((\d+)/.exec(legend.style.gridTemplateColumns)[1]);
  const items = legend.querySelectorAll('.cod-legend__item').length;
  const rows = Math.ceil(items / cols);
  return {
    side: /\bcod--side\b/.test(wrap.getAttribute('class')),
    plotW: parseFloat(plot.style.width),
    plotH: parseFloat(plot.style.height),
    viewBox: svg.getAttribute('viewBox'),
    legendH: rows * LEGEND_ROW_H + (rows - 1) * LEGEND_ROW_GAP,
    statusLines: wrap.querySelectorAll('.cod-status__line').length,
    R: Number(svg.querySelector('.cod-ring').getAttribute('r')),
    svg,
  };
}

/**
 * Texts of the plot under their floor on screen: data text >= 11 px, the
 * italic centre notes and warnings (labels, CircleOfDoom.jsx
 * MIN_CENTRE_NOTE) and the label-token texts >= 10 px.
 */
function codUnderFloor(svg, vp) {
  return screenTexts(svg, vp)
    .map((t) => ({ ...t, floor: /(^|\s)cod-centre__(note|warn)(\s|$)/.test(t.cls) ? FLOORS.label : t.floor }))
    .filter((t) => !(t.screenPx >= t.floor - 0.01))
    .map((t) => `${t.text} [${t.cls}] ${t.screenPx.toFixed(2)} px < ${t.floor}`);
}

/** The plot takes the whole slot less the legend and the legend line (and their gaps). */
function expectFills(slot, lay) {
  expect(lay.viewBox).toBe(`0 0 ${lay.plotW} ${lay.plotH}`);
  const status = lay.statusLines ? lay.statusLines * STATUS_LINE_H + BLOCK_GAP : 0;
  if (lay.side) {
    expect(lay.plotH + status).toBeCloseTo(slot.height, 0);
    expect(lay.plotW).toBeLessThanOrEqual(slot.width);
    expect(lay.plotW).toBeGreaterThan(slot.width * 0.6);
  } else {
    expect(lay.plotW).toBe(slot.width);
    expect(lay.plotH + status + lay.legendH + BLOCK_GAP).toBeCloseTo(slot.height, 0);
  }
  // the ring grows with the smaller side of the plot: it keeps all but the
  // room of the labels beside it (gapOut + the widest label, about 90 px a
  // side at most) and is never under 40 % of the half-side
  const half = Math.min(lay.plotW, lay.plotH) / 2;
  expect(lay.R).toBeGreaterThanOrEqual(0.4 * half);
  expect(lay.R).toBeLessThanOrEqual(half);
}

describe.skipIf(!haveFormula1)('the Circle of Doom plot uses its Pit Wall cell at the four viewports', () => {
  beforeAll(() => raceAtLap(12));
  afterAll(async () => {
    if (view) await view.unmount();
    view = null;
    useF1Store.setState({ ...INITIAL });
  });

  const slots = Object.fromEntries(VIEWPORTS.map((vp) => [vp.name, codSlotAt(css, SRC, vp)]));
  const radius = {};

  it.each(VIEWPORTS.map((vp) => [vp.name]))('%s: the plot fills the slot less the legend and the legend line; labels at the floors', async (name) => {
    const slot = slots[name];
    const vp = VIEWPORTS.find((x) => x.name === name);
    await mountIn(slot);
    await resizeSlot(slot);
    const lay = laidOut();
    radius[name] = { R: lay.R, side: Math.min(lay.plotW, lay.plotH) };
    console.log(`${name}: slot ${slot.width} x ${slot.height} -> plot ${lay.plotW} x ${lay.plotH} (legend ${lay.side ? 'beside' : `under, ${lay.legendH} px`}, ${lay.statusLines} legend line(s)), ring R ${lay.R.toFixed(1)}`);
    expectFills(slot, lay);
    expect(codUnderFloor(lay.svg, vp)).toEqual([]);
    expect(screenTexts(lay.svg, vp).length).toBeGreaterThan(0);
    await view.unmount();
    view = null;
  }, 20000);

  it('the ring grows with min(width, height) of the plot: ordered by that side, never smaller', () => {
    const byside = Object.values(radius).sort((a, b) => a.side - b.side);
    expect(byside).toHaveLength(4);
    for (let i = 1; i < byside.length; i += 1) expect(byside[i].R).toBeGreaterThanOrEqual(byside[i - 1].R);
    // the 2048 px screen: about four times the ring of the 1536 px one
    expect(radius['2048x1100'].R).toBeGreaterThan(3 * radius['1536x750'].R);
  });
});

describe.skipIf(!haveFormula1)('the plot follows the cell when the window moves between the screens', () => {
  beforeAll(() => raceAtLap(12));
  afterAll(async () => {
    if (view) await view.unmount();
    view = null;
    useF1Store.setState({ ...INITIAL });
  });
  const s1536 = () => codSlotAt(css, SRC, VIEWPORTS.find((x) => x.name === '1536x750'));
  const s2048 = () => codSlotAt(css, SRC, VIEWPORTS.find((x) => x.name === '2048x1100'));
  const s1366 = () => codSlotAt(css, SRC, VIEWPORTS.find((x) => x.name === '1366x768'));

  it('1536 x 750 -> 2048 x 1100 with the frames held back: the plot grows after FRAME_FALLBACK_MS', async () => {
    await mountIn(s1536());
    await resizeSlot(s1536());
    const before = laidOut();
    expectFills(s1536(), before);
    // moved to the 2048 px screen: the observer reports, no frame runs
    const el = view.wrap();
    dom.setRect(el, { left: 0, top: 0, width: s2048().width, height: s2048().height });
    await act(async () => { ro.notify(el, s2048().width, s2048().height); });
    expect(laidOut().plotW).toBe(before.plotW);
    await act(async () => { await new Promise((r) => setTimeout(r, FRAME_FALLBACK_MS + 40)); });
    const after = laidOut();
    expectFills(s2048(), after);
    expect(after.R).toBeGreaterThan(before.R);
  });

  it('back on a 1366 px window, reported by the window resize only: measured afresh', async () => {
    const el = view.wrap();
    dom.setRect(el, { left: 0, top: 0, width: s1366().width, height: s1366().height });
    await act(async () => { dom.mouse(dom.window, 'resize', { bubbles: false }); });
    await settle();
    expectFills(s1366(), laidOut());
  });
});
