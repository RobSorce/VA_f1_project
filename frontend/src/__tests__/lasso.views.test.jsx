// P4: the lasso (utils/lasso.js), the interaction that triggers the
// analytics of both scatter views, tested in the mounted components with
// synthetic pointer events (helpers/miniDom.js gives SVG elements the browser's
// getScreenCTM: the svg's viewport and every transform down to the element).
//
// The lasso is drawn in the plot group, translated by the plot margin. Before
// the fix d3.drag measured the pointer against the group's parent (the svg),
// so the polygon and its hit test were off by the margin ((46,15) on the PCA
// biplot, (52,20) on the Race Situation Map), and the group had no background
// rect, so a shift-drag could only start on a mark.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDINGS_FILE = path.resolve(HERE, '../../../backend/data/processed/pca_embeddings.json');

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.getPCAEmbeddings = vi.fn(async () => globalThis.__pcaEmbeddings);
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
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { default: PCABiplot } = await import('../components/visualizations/PCABiplot.jsx');
const { default: RaceSituationMap } = await import('../components/visualizations/RaceSituationMap.jsx');
const { pointInPolygon } = await import('../utils/lasso.js');

const EMBEDDINGS = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
globalThis.__pcaEmbeddings = EMBEDDINGS;
const INITIAL = useF1Store.getState();

// Where the panel sits on screen (client px)
const HOST_RECT = { left: 120, top: 70, width: 640, height: 420 };

async function mount(Component) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, HOST_RECT);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  return {
    host,
    svg: host.querySelector('.viz-container svg'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

/** Centre (in the plot group's user space) of a mark: cx/cy, else its translate. */
function markCentre(el) {
  if (el.getAttribute('cx') != null) return [Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))];
  const m = dom.parseTransform(el.getAttribute('transform'));
  return [m.e, m.f];
}

/** Radius of a mark: r, else the largest coordinate of its path (d3.symbol at 0,0). */
function markRadius(el) {
  if (el.getAttribute('r') != null) return Number(el.getAttribute('r'));
  const nums = (el.getAttribute('d') || '').match(/-?\d*\.?\d+(e-?\d+)?/g) || [];
  return Math.max(0, ...nums.map((v) => Math.abs(Number(v))));
}

/** Element a browser would deliver a mousedown at (clientX, clientY) to:
 * the topmost mark or rect under the pointer (pointer-events not 'none'),
 * else the svg. Marks are the elements of `markSelector`. */
function hitTarget(svg, markSelector, clientX, clientY) {
  const candidates = [...svg.querySelectorAll(`${markSelector}, rect`)]
    .filter((el) => el.getAttribute('pointer-events') !== 'none');
  for (const el of candidates.reverse()) {
    const inv = el.parentNode.getScreenCTM().inverse();
    const x = inv.a * clientX + inv.c * clientY + inv.e;
    const y = inv.b * clientX + inv.d * clientY + inv.f;
    if (el.localName === 'rect') {
      const rx = Number(el.getAttribute('x') || 0);
      const ry = Number(el.getAttribute('y') || 0);
      const w = Number(el.getAttribute('width') || 0);
      const h = Number(el.getAttribute('height') || 0);
      if (x >= rx && x <= rx + w && y >= ry && y <= ry + h) return el;
    } else {
      const [cx, cy] = markCentre(el);
      if (Math.hypot(x - cx, y - cy) <= markRadius(el)) return el;
    }
  }
  return svg;
}

/** The mark with the largest distance to its nearest neighbour (screen px),
 * and that distance. */
function mostIsolated(marks) {
  const centres = marks.map(markCentre);
  let best = null;
  centres.forEach(([x, y], i) => {
    let nn = Infinity;
    centres.forEach(([u, v], j) => { if (j !== i) nn = Math.min(nn, Math.hypot(x - u, y - v)); });
    if (!best || nn > best.nn) best = { el: marks[i], centre: [x, y], nn };
  });
  return best;
}

/** A closed polygon of k vertices around (cx, cy) in the group's user space. */
function ring(cx, cy, r, k = 24) {
  return Array.from({ length: k + 1 }, (_, i) => [
    cx + r * Math.cos((2 * Math.PI * i) / k), cy + r * Math.sin((2 * Math.PI * i) / k),
  ]);
}

/**
 * Shift-drag along `polygon` (the plot group's user space). The mousedown goes
 * to `downTarget` (default: what a browser hits at the first vertex); moves
 * and the release go to the window, as d3.drag listens there.
 */
async function drawLasso(group, polygon, { svg, markSelector, downTarget } = {}) {
  const client = polygon.map(([x, y]) => dom.toClient(group, x, y));
  const target = downTarget || hitTarget(svg, markSelector, client[0].clientX, client[0].clientY);
  let pathDuringDrag = null;
  // the views redraw on a selection change: read the DOM before the release
  const targetInGroup = group.contains(target);
  await act(async () => {
    dom.mouse(target, 'mousedown', { ...client[0], shiftKey: true });
    for (const c of client.slice(1)) dom.mouse(dom.window, 'mousemove', { ...c, shiftKey: true });
    pathDuringDrag = group.querySelector('path.lasso-path');
    dom.mouse(dom.window, 'mouseup', { ...client.at(-1), shiftKey: true });
  });
  return { target, targetInGroup, pathDuringDrag };
}

/** The mocked API functions that run the selection analysis (the old name is
 * an alias of the new one). */
function analysisCalls() {
  const out = [];
  for (const name of ['analyzePCASelection', 'analyzeTSNESelection']) {
    try { if (api[name]?.mock) out.push(api[name]); } catch { /* not exported */ }
  }
  return [...new Set(out)];
}

/** Vertices of a lasso path's d ('M x,y L x,y ... Z'). */
function pathVertices(d) {
  const nums = (d || '').match(/-?\d*\.?\d+(e-?\d+)?/g) || [];
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([Number(nums[i]), Number(nums[i + 1])]);
  return out;
}

describe('pointInPolygon (ray casting)', () => {
  it('inside / outside a square', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInPolygon([5, 5], sq)).toBe(true);
    expect(pointInPolygon([15, 5], sq)).toBe(false);
    expect(pointInPolygon([-1, -1], sq)).toBe(false);
  });
});

describe('PCA biplot lasso (P4)', () => {
  let view;
  // the biplot redraws its plot group on every render: always the current one
  let group;
  const MARKS = 'path.pca-point';

  beforeAll(async () => {
    useF1Store.setState({
      ...INITIAL,
      pcaEmbeddings: EMBEDDINGS,
      selectedPCAPoints: [],
      selectedDrivers: [],
      year: 2024, round: 16, loadedYear: 2024, loadedRound: 16, loadedSessionType: 'R',
    });
    view = await mount(PCABiplot);
  });
  afterAll(async () => { await view?.unmount(); });
  beforeEach(() => { group = view.svg.querySelector('g'); });

  it('draws every point of the artefact inside a translated plot group', () => {
    const marks = view.svg.querySelectorAll(MARKS);
    expect(marks.length).toBe(EMBEDDINGS.points.length);
    const t = dom.parseTransform(group.getAttribute('transform'));
    // the margin the old code ignored
    expect([t.e, t.f]).toEqual([46, 15]);
  });

  it('a shift-drag that starts on empty plot background starts a lasso', async () => {
    const marks = [...view.svg.querySelectorAll(MARKS)];
    const centres = marks.map(markCentre);
    // an empty spot: 20 px or more from every mark, inside the plot
    const spot = [];
    for (let x = 30; x < 500 && !spot.length; x += 7) {
      for (let y = 30; y < 300 && !spot.length; y += 7) {
        if (centres.every(([u, v]) => Math.hypot(x - u, y - v) >= 20)) spot.push(x, y);
      }
    }
    expect(spot.length).toBe(2);
    const { target, targetInGroup, pathDuringDrag } = await drawLasso(group, ring(spot[0], spot[1], 6), { svg: view.svg, markSelector: MARKS });
    // the browser delivers the mousedown to the background, inside the plot group
    expect(target).not.toBe(view.svg);
    expect(targetInGroup).toBe(true);
    expect(pathDuringDrag).not.toBeNull();
    // a lasso around no point clears the selection
    expect(useF1Store.getState().selectedPCAPoints).toEqual([]);
  });

  it('a lasso drawn tightly around one point selects exactly that point and runs the analysis', async () => {
    const marks = [...view.svg.querySelectorAll(MARKS)];
    const iso = mostIsolated(marks);
    expect(iso.nn).toBeGreaterThan(12);
    const r = Math.min(10, iso.nn * 0.45);
    expect(r).toBeGreaterThan(markRadius(iso.el));
    const id = iso.el.__data__.id;
    for (const fn of analysisCalls()) fn.mockClear();
    const { pathDuringDrag } = await drawLasso(group, ring(...iso.centre, r), { svg: view.svg, markSelector: MARKS });
    expect(pathDuringDrag).not.toBeNull();
    expect(useF1Store.getState().selectedPCAPoints).toEqual([id]);
    // the interaction-triggered analytics: the selection is sent for analysis
    const calls = analysisCalls().flatMap((fn) => fn.mock.calls);
    expect(calls.map((c) => c[0])).toEqual([[id]]);
  });

  it('the lasso polygon is drawn where the pointer went (plot-group coordinates, no margin offset)', async () => {
    const marks = [...view.svg.querySelectorAll(MARKS)];
    const iso = mostIsolated(marks);
    const r = Math.min(10, iso.nn * 0.45);
    const poly = ring(...iso.centre, r);
    // mousedown on the plot group itself: reaches d3.drag even without a background
    const { pathDuringDrag } = await drawLasso(group, poly, { downTarget: iso.el });
    const drawn = pathVertices(pathDuringDrag.getAttribute('d'));
    // offset of the drawn polygon from the pointer path, px (to 0.01 px: d3 writes path coordinates to 3 decimals)
    const offset = [drawn[0][0] - poly[0][0], drawn[0][1] - poly[0][1]].map((v) => Math.round(v * 100) / 100 + 0);
    expect(offset).toEqual([0, 0]);
    expect(useF1Store.getState().selectedPCAPoints).toEqual([iso.el.__data__.id]);
  });

  it('works when the svg is drawn at 125 % of its viewBox (display scaling)', async () => {
    const marks = [...view.svg.querySelectorAll(MARKS)];
    const iso = mostIsolated(marks);
    const r = Math.min(10, iso.nn * 0.45);
    dom.setRect(view.svg, { ...HOST_RECT, width: HOST_RECT.width * 1.25, height: HOST_RECT.height * 1.25 });
    try {
      await drawLasso(group, ring(...iso.centre, r), { svg: view.svg, markSelector: MARKS });
      expect(useF1Store.getState().selectedPCAPoints).toEqual([iso.el.__data__.id]);
    } finally {
      view.svg._rect = null;
    }
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Race Situation Map lasso (P4)', () => {
  let view;
  let group;
  const MARKS = 'circle.driver-point';

  beforeAll(async () => {
    const monza = loadCachedSession(2024, 16);
    const lapTimes = monza.lap_times;
    const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
    useF1Store.setState({
      ...INITIAL,
      sessionData: { lap_times: lapTimes }, drivers: monza.driver_info,
      loadedYear: 2024, loadedRound: 16, loadedSessionType: 'FP2', isQualifyingReplay: false,
      maxLap, currentLap: 20, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
      isLiveMode: false, totalFrames: 0, frameData: null, dnfMap: {}, lapModeRaceOver: false,
      raceSituationData: null, raceSituationLap: null, _prevPcaResult: null,
      selectedDrivers: [], highlightedDriver: null, focusDriver: null,
    });
    useF1Store.getState().computeRaceSituation();
    expect(useF1Store.getState().raceSituationData?.driverAbbrs?.length).toBeGreaterThan(10);
    view = await mount(RaceSituationMap);
    group = view.svg.querySelector('g.situation-main');
  });
  afterAll(async () => { await view?.unmount(); });

  it('draws the drivers inside a translated plot group', () => {
    expect(view.svg.querySelectorAll(MARKS).length).toBe(useF1Store.getState().raceSituationData.driverAbbrs.length);
    const t = dom.parseTransform(group.getAttribute('transform'));
    expect([t.e, t.f]).toEqual([52, 20]);
  });

  it('a lasso drawn tightly around one driver selects exactly that driver', async () => {
    const marks = [...view.svg.querySelectorAll(MARKS)];
    const iso = mostIsolated(marks);
    expect(iso.nn).toBeGreaterThan(8);
    const r = Math.max(4, Math.min(14, iso.nn * 0.45));
    const abbr = iso.el.__data__.abbr;
    const { pathDuringDrag } = await drawLasso(group, ring(...iso.centre, r), { svg: view.svg, markSelector: MARKS });
    expect(pathDuringDrag).not.toBeNull();
    expect(useF1Store.getState().selectedDrivers).toEqual([abbr]);
  });

  it('a shift-drag that starts on empty plot background starts a lasso', async () => {
    const centres = [...view.svg.querySelectorAll(MARKS)].map(markCentre);
    const spot = [];
    for (let x = 20; x < 540 && !spot.length; x += 7) {
      for (let y = 20; y < 330 && !spot.length; y += 7) {
        if (centres.every(([u, v]) => Math.hypot(x - u, y - v) >= 30)) spot.push(x, y);
      }
    }
    expect(spot.length).toBe(2);
    const { target, targetInGroup, pathDuringDrag } = await drawLasso(group, ring(spot[0], spot[1], 6), { svg: view.svg, markSelector: MARKS });
    expect(target).not.toBe(view.svg);
    expect(targetInGroup).toBe(true);
    expect(pathDuringDrag).not.toBeNull();
    expect(useF1Store.getState().selectedDrivers).toEqual([]);
  });

  it('the lasso polygon is drawn where the pointer went (no margin offset)', async () => {
    const marks = [...view.svg.querySelectorAll(MARKS)];
    const iso = mostIsolated(marks);
    const r = Math.max(4, Math.min(14, iso.nn * 0.45));
    const poly = ring(...iso.centre, r);
    const { pathDuringDrag } = await drawLasso(group, poly, { downTarget: iso.el });
    const drawn = pathVertices(pathDuringDrag.getAttribute('d'));
    // offset of the drawn polygon from the pointer path, px (to 0.01 px: d3 writes path coordinates to 3 decimals)
    const offset = [drawn[0][0] - poly[0][0], drawn[0][1] - poly[0][1]].map((v) => Math.round(v * 100) / 100 + 0);
    expect(offset).toEqual([0, 0]);
    expect(useF1Store.getState().selectedDrivers).toEqual([iso.el.__data__.abbr]);
  });
});
