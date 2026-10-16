// The Track Map's telemetry HUD on the Pit Wall says what it
// leaves out.
//
// Measured at 1536 x 750 (Monza 2024, the default orientation): the map's
// plan (trackMapLayout.js mapPlan) kept the HUD columns that left the track
// largest, the driver, the speed and the throttle (the tyre was dropped
// before the brake), and nothing said that four columns were missing; with
// the focus driver and four selected drivers the last row read "+3 more:
// HAM, PIA, SAI", 134 px of text in 95 px, cut to an ellipsis (the HUD has
// no pointer events: no tooltip either). Now: the columns in their order of
// use to a strategist (the driver, the tyre and the speed always, then the
// gear, the brake, the throttle and DRS as room allows), "+k cols" in the
// driver column's header when columns are left out, "+k more" (the count)
// on the last row, and the Layers popover names both. The 9d guarantees
// hold: the track keeps >= 70 % of its plain fit at 1536 x 750 (>= 90 % at
// 2048 x 1100) and is fitted around the HUD's slot, whoever is selected.
//
// Mounted in the mini DOM in the four Pit Wall cells (helpers/pitWallMaps.js:
// the CSS as written), Monza 2024, the focus driver and four selected
// drivers; the hint's width from the Formula1 metrics of public/fonts.
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
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const { loadCss, px, VIEWPORTS } = await import('./helpers/layoutModel.js');
const { trackMapPanelAt, declAt } = await import('./helpers/pitWallMaps.js');
const { textWidth, haveFormula1 } = await import('./helpers/fontWidths.js');
const L = await import('../utils/views/trackMapLayout.js');
const { CHART_HELP } = await import('../utils/chartHelp.js');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');

const ro = installResizeObserverMock();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = loadCss(SRC);
const INITIAL = useF1Store.getState();
const MONZA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, '../public/data/2024_16_R/session.json.gz'))));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (el) => act(async () => {
  el.dispatchEvent({
    type: 'click', bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {},
  });
});
const MONO_EM = 0.61; // the HUD's mono face (JetBrains Mono and its fallbacks) <= 0.61 em
const mono = (s, size) => s.length * MONO_EM * size;
const col = (id) => L.HUD_TABLE.columns.find((c) => c.id === id);

// The Pit Wall maps at the four viewports, the plan of Monza in its default orientation
const MAPS = VIEWPORTS.map((vp) => {
  const m = trackMapPanelAt(css, SRC, vp);
  const map = { width: Math.floor(m.content.width), height: Math.floor(m.content.height) };
  const outline = L.rotateOutline(MONZA.circuit_info.track_coordinates, MONZA.circuit_info.rotation || 0).points;
  const padding = L.mapDrawPadding(map.width, map.height);
  const plan = L.mapPlan(outline, map, { padding, drs: true, key: true });
  const plain = L.fitTrack(outline, map, { padding });
  return {
    vp, m, map, plan, share: plan.fit.scale / plain.scale,
  };
});

const FOCUS = 'NOR';
const SELECTED = ['LEC', 'HAM', 'PIA', 'SAI'];
const HUD_DRIVERS = [FOCUS, ...SELECTED];

function raceState() {
  const drivers = Object.fromEntries(MONZA.driver_info.map((d, i) => [d.Abbreviation, {
    x: 0, y: 0, speed: 280 + i, throttle: 100, brake: 0, gear: 8, drs: 0, tyre: 2, tyre_life: 12, lap: 20, position: i + 1,
  }]));
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    loadedYear: 2024, loadedRound: 16, loadedSessionType: 'R',
    sessionData: MONZA,
    circuitInfo: MONZA.circuit_info,
    trackStatus: MONZA.track_status,
    sessionTimeOffset: computeSessionTimeOffset(MONZA.lap_times),
    maxLap: 53, totalRaceLaps: 53, currentLap: 20,
    frameData: { frames: [{ t: 0, lap: 20, drivers }] },
    currentFrameIndex: 0, totalFrames: 0, currentTime: 0,
    showTrackDRS: true, showTrackSectors: true, trackRotationOffset: 0,
    focusDriver: FOCUS, selectedDrivers: SELECTED,
    telemetryCache: {},
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

async function mountInCell(model) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: model.cell.width, height: model.cell.height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(TrackMap)); });
  const content = host.querySelector('.panel-content');
  const viz = host.querySelector('.viz-container');
  const top = model.border + model.header.height + model.contentPad.top;
  dom.setRect(content, { left: 0, top, width: model.content.width, height: model.content.height });
  dom.setRect(viz, { left: 0, top, width: model.content.width, height: model.content.height });
  await act(async () => {
    ro.notify(content, model.content.width, model.content.height);
    ro.notify(viz, model.content.width, model.content.height);
  });
  await settle();
  return {
    host, viz,
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('The HUD columns, their priority, the hint and the count (trackMapLayout.js)', () => {
  it('the columns in their order of priority: the driver, the tyre and the speed always, then gear, brake, throttle, DRS', () => {
    expect(L.HUD_TABLE.columns.map((c) => c.id)).toEqual(['drv', 'tyre', 'speed', 'gear', 'brk', 'thr', 'drs']);
    expect(L.HUD_TABLE.dropOrder).toEqual(['drs', 'thr', 'brk', 'gear']);
    expect(L.hudColumnSets(L.HUD_TABLE.columns).at(-1).map((c) => c.id)).toEqual(['drv', 'tyre', 'speed']);
    // however narrow the room, the three stay
    expect(L.hudTableColumns(0).map((c) => c.id)).toEqual(['drv', 'tyre', 'speed']);
  });

  it('the columns left out and their hint (DRS only in a season with DRS)', () => {
    const three = L.HUD_TABLE.columns.slice(0, 3);
    expect(L.hudHiddenColumns(three).map((c) => c.label)).toEqual(['GEAR', 'BRK', 'THR', 'DRS']);
    expect(L.hudHiddenColumns(three, { drs: false }).map((c) => c.label)).toEqual(['GEAR', 'BRK', 'THR']);
    expect(L.hudHiddenColumns(L.HUD_TABLE.columns)).toEqual([]);
    expect(L.hudColumnsHint(4)).toBe('+4 cols');
    expect(L.hudColumnsHint(0)).toBe('');
  });

  it('the Track Map help names the HUD columns in their order and what +k cols / +k more count', () => {
    const help = CHART_HELP.trackmap.howToRead.join(' ');
    expect(help).toContain('the driver, the tyre (compound and laps on the set) and the speed, then the gear, brake, throttle and DRS');
    expect(help).toContain('"+3 cols" in its header counts the columns left out');
    expect(help).toContain('"+2 more" on its last row the drivers past it; the Layers panel names both');
    expect(L.hudColumnsHint(3)).toBe('+3 cols');
  });

  it.skipIf(!haveFormula1)('the hint fits the driver column and the free left of the tyre header, at the largest type (11.5 px)', () => {
    // the CSS: the hint in Formula1 Regular, the driver header lets it run on; the tyre label right-aligned
    expect(declAt(css, '.track-hud__cols', 'font-family', VIEWPORTS[0])).toMatch(/^'Formula1'/);
    expect(declAt(css, '.track-hud__cols', 'font-weight', VIEWPORTS[0])).toBe('400');
    expect(declAt(css, '.track-hud__h--drv', 'overflow', VIEWPORTS[0])).toBe('visible');
    expect(declAt(css, '.track-hud__h', 'text-align', VIEWPORTS[0])).toBe('right');
    for (const size of [10, 11.5]) {
      const hint = textWidth(L.hudColumnsHint(4), size, 400);
      const room = col('drv').px + L.HUD_TABLE.gapPx + col('tyre').px - mono(col('tyre').label, size) - 2;
      console.log(`"+4 cols" at ${size} px: ${hint.toFixed(1)} px; room before the TYRE label ${room.toFixed(1)} px`);
      expect(hint).toBeLessThanOrEqual(room);
    }
  });
});

describe('The mounted HUD in the four Pit Wall cells, Monza 2024, the focus driver and four selected', () => {
  afterAll(() => useF1Store.setState({ ...INITIAL }));
  const summary = [];
  afterAll(() => { for (const r of summary) console.log(r); });

  for (const {
    vp, m, map, plan, share,
  } of MAPS) {
    it(`${vp.name}: the priority columns, "+k cols" when columns are left out, "+k more" whole, the names in the Layers popover`, async () => {
      // the 9d guarantees of the plan this HUD sits in
      expect(plan.fit.clear).toBe(true);
      expect(share).toBeGreaterThanOrEqual({ '1536x750': 0.7, '2048x1100': 0.9 }[vp.name] ?? 0.5);
      raceState();
      const v = await mountInCell(m);
      try {
        const table = v.viz.querySelector('.track-hud');
        expect(table).not.toBeNull();
        const drawn = L.hudTable(plan.hud, HUD_DRIVERS.length);
        const heads = [...table.querySelectorAll('thead th')].map((th) => /track-hud__h--(\w+)/.exec(th.getAttribute('class'))[1]);
        expect(heads).toEqual(plan.hud.columns.map((c) => c.id));
        expect(heads.slice(0, 3)).toEqual(['drv', 'tyre', 'speed']);
        // in the order of priority
        const order = L.HUD_TABLE.columns.map((c) => c.id);
        expect([...heads].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(heads);

        // the hint of the columns left out
        const hidden = L.hudHiddenColumns(plan.hud.columns, { drs: true });
        const hint = table.querySelector('.track-hud__cols');
        if (hidden.length) {
          expect(text(hint)).toBe(`+${hidden.length} cols`);
          expect(hint.parentNode.getAttribute('class')).toMatch(/track-hud__h--drv/);
          expect(table.querySelector('table').getAttribute('aria-label')).toContain(hidden.map((c) => c.title).join(', '));
        } else {
          expect(hint).toBeNull();
        }

        // the last row: the count only, whole in the table at the viewport's label size
        const label = px(css, '--font-size-label', vp);
        const inner = L.hudTableWidth(plan.hud.columns) - 2 * L.HUD_TABLE.border - 2 * L.HUD_TABLE.padX;
        const more = table.querySelector('.track-hud__more');
        const left = HUD_DRIVERS.slice(drawn.shown);
        expect(drawn.more).toBe(left.length);
        if (drawn.more) {
          expect(text(more)).toBe(`+${drawn.more} more`);
          expect(mono(text(more), label)).toBeLessThanOrEqual(inner);
        } else {
          expect(more).toBeNull();
        }

        // the Layers popover names what the table counts
        await click(v.host.querySelector('.track-map-tool--layers'));
        const pop = dom.document.body.querySelector('#track-map-layers');
        const group = [...pop.querySelectorAll('.track-map-layers__group')].find((g) => g.getAttribute('aria-label') === 'HUD');
        const notes = group ? [...group.querySelectorAll('.track-map-layers__note')].map(text) : [];
        const expected = [
          ...(hidden.length ? [`+${hidden.length} cols hidden: ${hidden.map((c) => c.label).join(', ')}`] : []),
          ...(left.length ? [`+${left.length} more drivers: ${left.join(', ')}`] : []),
        ];
        expect(notes).toEqual(expected);
        await click(v.host.querySelector('.track-map-tool--layers'));
        summary.push(`${vp.name}: map ${map.width} x ${map.height}, track ${(100 * share).toFixed(1)} % of its plain fit; HUD ${heads.join('/')} `
          + `(${L.hudTableWidth(plan.hud.columns)} px)${hint ? `, header "${text(hint)}"` : ''}, ${drawn.shown} rows${more ? ` + "${text(more)}" (${mono(text(more), label).toFixed(1)} of ${inner} px)` : ''}; `
          + `popover: ${expected.join(' / ') || 'nothing left out'}`);
      } finally {
        await v.unmount();
      }
    }, 20000);
  }

  it('1366x768, the focus driver and one selected: every column shown, nobody left out: no hint, no last row, no HUD group', async () => {
    // Monza in its default orientation keeps every column there (the track
    // is 66 % of its plain fit with them, 95 % of the best any choice gives)
    const { m, plan } = MAPS.find((r) => r.vp.name === '1366x768');
    expect(L.hudHiddenColumns(plan.hud.columns)).toEqual([]);
    raceState();
    useF1Store.setState({ selectedDrivers: ['LEC'] });
    const v = await mountInCell(m);
    try {
      const table = v.viz.querySelector('.track-hud');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(table.querySelector('.track-hud__more')).toBeNull();
      expect(table.querySelector('.track-hud__cols')).toBeNull();
      expect(table.querySelector('table').getAttribute('aria-label')).toBe('Telemetry of the focus and selected drivers');
      await click(v.host.querySelector('.track-map-tool--layers'));
      const pop = dom.document.body.querySelector('#track-map-layers');
      const groups = [...pop.querySelectorAll('.track-map-layers__group')].map((g) => g.getAttribute('aria-label'));
      expect(groups).not.toContain('HUD');
      await click(v.host.querySelector('.track-map-tool--layers'));
    } finally {
      await v.unmount();
    }
  }, 20000);
});
