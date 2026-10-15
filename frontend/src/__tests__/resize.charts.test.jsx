// D4 (Phase 9c, browser pass 2026-10-16 #2): every D3 view follows its
// container. Each chart is mounted in the mini DOM (helpers/miniDom.js) with
// a synthetic race (helpers/chartFixtures.js), drawn at one size, then its
// box is resized (ResizeObserver + the frame the shared hook waits for,
// utils/views/chartBox.js useChartBox): the chart lays out again at the new
// size (viewBox = the box, or the svg's own width / height), so its user
// space is drawn at scale 1 and every label stays at its CHART_FONT size on
// screen, never under the floors (11 px data, 10 px non-data text; on-screen
// size = computed font size x the svg's CTM scale, helpers/screenFont.js).
//
// Before Phase 9c the views kept the viewBox of their first draw: moving the
// browser from a 2048 px screen to the 1536 px one drew them at scale 0.6
// (corner labels 6.5 px, axis ticks 6.6 px).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDINGS = JSON.parse(fs.readFileSync(
  path.resolve(HERE, '../../../backend/data/processed/pca_embeddings.json'), 'utf8',
));

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.getPCAEmbeddings = vi.fn(async () => globalThis.__resizeEmbeddings);
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
globalThis.__resizeEmbeddings = EMBEDDINGS;

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock, syntheticSession, syntheticChampionship } = await import('./helpers/chartFixtures.js');
const { screenTexts, underFloor } = await import('./helpers/screenFont.js');

const VIEWS = {};
for (const name of ['ChampionshipChart', 'ChampionshipStandings', 'LapDeltaChart', 'PCABiplot', 'TireDegradation',
  'RaceSituationMap', 'PositionByLap', 'StrategyTimeline', 'TyreManagement', 'TyreHealth']) {
  VIEWS[name] = (await import(`../components/visualizations/${name}.jsx`)).default;
}

// Installed after d3: d3-timer keeps its own frame source for the transitions
const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const CHAMPIONSHIP = syntheticChampionship(6);
// Font tokens evaluated at Roberto's main screen (1920 x 1080 at 125 %)
const VP = { W: 1536, H: 750 };

function raceState(extra = {}) {
  const lapTimes = SESSION.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: SESSION,
    circuitInfo: SESSION.circuit_info,
    trackStatus: SESSION.track_status,
    sessionTimeOffset: offset,
    maxLap: 20, totalRaceLaps: 20, currentLap: 20,
    lapModeRaceOver: true,
    totalFrames: 0, currentTime: 0,
    focusDriver: 'NOR',
    selectedDrivers: ['NOR', 'LEC', 'VER'],
    // the Race Situation map computes its PCA on mount (store computeRaceSituation)
    raceSituationData: null, raceSituationLap: null,
    championshipData: CHAMPIONSHIP,
    ...extra,
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

async function mount(Component, { width, height }) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  await settle();
  return {
    host,
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

/** The view's chart svg: the one its D3 code draws into (100 % x 100 %, or sized by the view). */
function chartSvg(host) {
  const svgs = host.querySelectorAll('svg');
  return svgs.find((s) => s.style.width === '100%' && s.style.height === '100%')
    || svgs.find((s) => s.getAttribute('width') && !s.getAttribute('viewBox') && s.querySelector('text'))
    || null;
}

/** The box the chart lays out in: viewBox, else the svg's own width / height. */
function userBox(svg) {
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (vb.length === 4) return { width: vb[2], height: vb[3] };
  return { width: Number(svg.getAttribute('width')), height: Number(svg.getAttribute('height')) };
}

/** Resize the box the svg fills (its parent) and let the view lay out again. */
async function resizeBox(svg, width, height) {
  const box = svg.parentElement;
  dom.setRect(box, { left: 0, top: 0, width, height });
  await act(async () => { ro.notify(box, width, height); });
  await settle();
}

const WIDE = { width: 1000, height: 560 };
const NARROW = { width: 600, height: 336 };
const TALL = { width: 1200, height: 700 };

describe('D4: every D3 view lays out again when its container is resized, labels at the floors on screen', () => {
  beforeAll(() => raceState());
  afterAll(() => { useF1Store.setState({ ...INITIAL }); });

  it.each(Object.keys(VIEWS))('%s: drawn at the size of its box, before and after two resizes', async (name) => {
    raceState();
    const view = await mount(VIEWS[name], WIDE);
    try {
      const svg = chartSvg(view.host);
      expect(svg, `${name}: chart svg`).toBeTruthy();
      expect(userBox(svg), `${name}: first draw`).toEqual(WIDE);
      expect(screenTexts(svg, VP).length, `${name}: labels drawn`).toBeGreaterThan(0);
      expect(underFloor(svg, VP), `${name} at ${WIDE.width} x ${WIDE.height}`).toEqual([]);

      // the browser moved to a smaller screen / the dock split shrank the pane
      await resizeBox(svg, NARROW.width, NARROW.height);
      const svg2 = chartSvg(view.host);
      expect(underFloor(svg2, VP), `${name} at ${NARROW.width} x ${NARROW.height}`).toEqual([]);
      expect(userBox(svg2), `${name}: after shrinking`).toEqual(NARROW);

      // and back to a larger one: the chart uses the room
      await resizeBox(svg2, TALL.width, TALL.height);
      const svg3 = chartSvg(view.host);
      expect(userBox(svg3), `${name}: after growing`).toEqual(TALL);
      expect(underFloor(svg3, VP), `${name} at ${TALL.width} x ${TALL.height}`).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});
