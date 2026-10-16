// A seek puts the Track Map's cars at the new frame at once.
//
// The cars are keyed D3 groups moved by a transition of their transform: a
// straight line from the old place to the new one. Between two consecutive
// frames of a replay that line follows the track; across a seek (the
// timeline clicked, a lap picked, a frame step while paused) it is the chord
// between two places of the lap, and the cars flew through the infield for
// 300 ms (paused) or a frame's time (playing). Now (TrackMap.jsx, the main
// effect): a car glides only from one frame to the next during playback (or
// a live feed); paused, or on a jump of more than one frame, it is set at
// the new frame at once, a glide still running interrupted.
//
// Mounted in the mini DOM in the 1536 x 750 Pit Wall cell on Monza 2024: 40
// frames, each car on a point of the outline 25 points further on at every
// frame. The expected places are the outline's points as the map's plan
// draws them (trackMapLayout.js mapPlan, the fit of the track).
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
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
const d3 = await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const { loadCss, VIEWPORTS } = await import('./helpers/layoutModel.js');
const { trackMapPanelAt } = await import('./helpers/pitWallMaps.js');
const L = await import('../utils/views/trackMapLayout.js');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');

const ro = installResizeObserverMock();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = loadCss(SRC);
const INITIAL = useF1Store.getState();
const MONZA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, '../public/data/2024_16_R/session.json.gz'))));
const COORDS = MONZA.circuit_info.track_coordinates;
const DRIVERS = MONZA.driver_info.map((d) => d.Abbreviation);
const FRAMES = 40;
const STEP = 25; // outline points a car moves from one frame to the next
const FRAME_DT = 0.4;

/** The outline point of driver i at frame f. */
const pointOf = (i, f) => (i * 37 + f * STEP) % COORDS.length;

function replayState() {
  const frames = Array.from({ length: FRAMES }, (_, f) => ({
    t: f * FRAME_DT,
    lap: 1,
    drivers: Object.fromEntries(DRIVERS.map((abbr, i) => {
      const p = COORDS[pointOf(i, f)];
      return [abbr, {
        x: p.X, y: p.Y, speed: 250, throttle: 100, brake: 0, gear: 7, drs: 0, tyre: 2, tyre_life: 1, lap: 1, position: i + 1,
      }];
    })),
  }));
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    loadedYear: 2024, loadedRound: 16, loadedSessionType: 'R',
    sessionData: MONZA,
    circuitInfo: MONZA.circuit_info,
    trackStatus: MONZA.track_status,
    sessionTimeOffset: computeSessionTimeOffset(MONZA.lap_times),
    maxLap: 53, totalRaceLaps: 53, currentLap: 1,
    frameData: { frames },
    currentFrameIndex: 0, totalFrames: FRAMES, frameDt: FRAME_DT, currentTime: 0,
    isPlaying: false, playSpeed: 1,
    showTrackDRS: true, showTrackSectors: true, trackRotationOffset: 0,
    focusDriver: null, selectedDrivers: [],
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

// The 1536 x 750 Pit Wall cell (helpers/pitWallMaps.js: the CSS as written)
const VP = VIEWPORTS.find((v) => v.name === '1536x750');
const MODEL = trackMapPanelAt(css, SRC, VP);
const MAP = { width: Math.floor(MODEL.content.width), height: Math.floor(MODEL.content.height) };

async function mountInCell() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: MODEL.cell.width, height: MODEL.cell.height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(TrackMap)); });
  const content = host.querySelector('.panel-content');
  const viz = host.querySelector('.viz-container');
  const top = MODEL.border + MODEL.header.height + MODEL.contentPad.top;
  dom.setRect(content, { left: 0, top, width: MODEL.content.width, height: MODEL.content.height });
  dom.setRect(viz, { left: 0, top, width: MAP.width, height: MAP.height });
  await act(async () => {
    ro.notify(content, MODEL.content.width, MODEL.content.height);
    ro.notify(viz, MAP.width, MAP.height);
  });
  await settle();
  return {
    host, viz,
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

// Where the map draws an outline point: the plan's fit of the outline as drawn
// (the circuit's rotation about its centroid), as TrackMap.jsx lays it out
const OUTLINE = L.rotateOutline(COORDS, MONZA.circuit_info.rotation || 0).points;
const PLAN = L.mapPlan(OUTLINE, MAP, { padding: L.mapDrawPadding(MAP.width, MAP.height), drs: true, key: true });
const XMIN = Math.min(...OUTLINE.map((p) => p.X));
const YMAX = Math.max(...OUTLINE.map((p) => p.Y));
const drawnAt = (k) => [PLAN.fit.left + (OUTLINE[k].X - XMIN) * PLAN.fit.scale, PLAN.fit.top + (YMAX - OUTLINE[k].Y) * PLAN.fit.scale];

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const cars = (v) => [...v.viz.querySelectorAll('.car-marker')].map((g) => ({ g, code: text(g.querySelector('.car-label')) }));
const translateOf = (g) => {
  const m = /translate\(\s*(-?[\d.e+-]+)[,\s]+(-?[\d.e+-]+)\s*\)/.exec(g.getAttribute('transform') || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
};
/** The transitions D3 has scheduled or running on a node (d3-transition keeps them on node.__transition). */
const transitions = (g) => Object.values(g.__transition || {});

/** Every car at its place of frame f now, and no transition left on any. */
function expectAtFrame(v, f) {
  const list = cars(v);
  expect(list).toHaveLength(DRIVERS.length);
  const moving = list.filter(({ g }) => transitions(g).length > 0).map(({ code }) => code);
  expect(moving).toEqual([]);
  for (const { g, code } of list) {
    const [x, y] = translateOf(g);
    const [ex, ey] = drawnAt(pointOf(DRIVERS.indexOf(code), f));
    expect(x).toBeCloseTo(ex, 6);
    expect(y).toBeCloseTo(ey, 6);
  }
}

// The steps after the mount run in synchronous act() calls: no macrotask
// between them, so a transition scheduled by one step (the glide of the
// playback case) cannot start before the next step looks at it (d3-timer
// waits for a later task)
const step = (patch) => act(() => { useF1Store.setState(patch); });

describe('A seek sets the Track Map cars at the new frame at once; playback glides from frame to frame', () => {
  afterAll(() => useF1Store.setState({ ...INITIAL }));

  it('1536x750, Monza 2024: paused seeks forward and back, a frame step, a jump during playback', async () => {
    replayState();
    const v = await mountInCell();
    try {
      expect(v.viz.querySelector('svg').getAttribute('data-track-fit')).toBe('clear');
      expectAtFrame(v, 0);

      // paused: a seek forward, a seek back, a step of one frame
      for (const f of [25, 6, 7]) {
        step({ currentFrameIndex: f });
        expectAtFrame(v, f);
      }

      // playback: the next frame glides, over one frame's time at 1x
      step({ isPlaying: true, currentFrameIndex: 8 });
      const glides = cars(v).map(({ g }) => transitions(g));
      expect(glides.every((t) => t.length === 1)).toBe(true);
      expect(glides.map((t) => t[0].duration)).toEqual(glides.map(() => FRAME_DT * 1000));

      // a jump of more than one frame while playing: the running glide is
      // stopped (it would end at frame 8) and every car is at frame 30
      step({ currentFrameIndex: 30 });
      expectAtFrame(v, 30);

      // paused again: the cars stay at the frame on screen
      step({ isPlaying: false });
      expectAtFrame(v, 30);

      // a live feed (no playback): each new frame glides 300 ms, as before;
      // the frames trimmed to the newest (the index jumps back) set the cars at once
      step({ isLiveMode: true, currentFrameIndex: 31 });
      expect(cars(v).map(({ g }) => transitions(g).map((t) => t.duration))).toEqual(cars(v).map(() => [300]));
      step({ currentFrameIndex: 12 });
      expectAtFrame(v, 12);
    } finally {
      for (const { g } of cars(v)) d3.interrupt(g);
      await v.unmount();
    }
  }, 20000);
});
