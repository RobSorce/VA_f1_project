// The Pit Wall Track Map is visible under its overlays.
//
// Measured before on the real Monza 2024 outline (public/data/2024_16_R)
// in the four Pit Wall cells: each focus or selected driver added a
// telemetry HUD card (148 px wide, 168 px tall, glass at 0.42 alpha with a
// 64 px blur) on the map's bottom-left corner; one card hid 51 % of the
// track's length at 1536 x 750 and 65 % at 1366 x 768, the focus driver and
// two selected drivers 100 % at both (67 % / 60 % at 1920 / 2048). Under the
// SPD / THR / BRK overlay the corner key also took the ramp and wrapped to
// two lines at 1366 and 1536 (375-378 px needed, 262-346 px there). The
// toolbar buttons kept dark-theme colours in the light theme (glyph 2.26:1,
// an invisible border).
//
// Now (utils/views/trackMapLayout.js): the HUD is a table in a map under
// HUD_CARDS_MIN_H (one 16 px row per driver), the overlays never overlap
// one another, and the track is fitted clear of all of them (fitTrack); the
// corner key shows the ramp in place of S1-S3 under a drawn overlay; the
// toolbar buttons take their colours from the theme's CSS.
//
// Then, fitted around the HUD as drawn, the track was laid out again at
// every change of the selection (Monza at 1536 x 750: a second HUD driver
// shrank it to 0.84x and moved the cars 16-21 px, Shanghai 104 px; the focus
// driver and two selected left a 134 x 67 px track). Now (mapPlan) the track
// is fitted around the map's furniture: the key row, the HUD's slot (its
// capacity), the compass rose at one of four places; the HUD's columns and
// the compass's place chosen for the map and the outline, the compass kept
// clear of the car code labels.
//
// Also, the svg clips at the map's edge, and a code label right of a car
// at the track's rightmost point (28 px from the edge at 1536 x 750) lost
// about 6 px; such a car now has its label on the left (carLabelOnLeft).
//
// Checked here: the CSS gives the boxes the sizes the layout code fits the
// track around; the HUD columns hold their text at the largest type; on the
// three real outlines, in the four Pit Wall maps, at four rotations, no
// point of the outline comes within the gap of the furniture (nor a car
// label within reach of a compass on the right; every label, on its side,
// inside the map), and the drawn HUD stays in its slot for 0-5 drivers; the
// mounted view on Monza (mini DOM) puts the rightmost car's label on the
// left and draws an
// outline whose every sampled point stays off the key, the HUD and the
// compass as they are drawn; and on the three circuits a change of the
// selection, the focus driver or the channel overlay redraws the outline
// and the cars exactly where they were.
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
const { useF1Store, telemetryCacheKey, sessionScopeOf } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const { loadCss, px, VIEWPORTS } = await import('./helpers/layoutModel.js');
const { trackMapPanelAt, declAt, lengthAt, sidesAt } = await import('./helpers/pitWallMaps.js');
const { textWidth, haveFormula1 } = await import('./helpers/fontWidths.js');
const { compositeOver, contrastRatio } = await import('../utils/colors.js');
const L = await import('../utils/views/trackMapLayout.js');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');

const ro = installResizeObserverMock();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(SRC, '../public/data');
const css = loadCss(SRC);
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const n0 = (v) => Number(String(v).replace('px', ''));

const SESSIONS = Object.fromEntries(['2024_16_R', '2024_5_R', '2025_1_R'].map((id) => [
  id, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, id, 'session.json.gz')))),
]));
const MONZA = SESSIONS['2024_16_R'];

/** The outline as TrackMap.jsx draws it: rotated by the circuit's rotation + offset about its centroid. */
function rotatedOutline(circuit, offsetDeg = 0) {
  const raw = circuit.track_coordinates;
  const rad = (((circuit.rotation || 0) + offsetDeg) * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const cx = raw.reduce((a, d) => a + d.X, 0) / raw.length;
  const cy = raw.reduce((a, d) => a + d.Y, 0) / raw.length;
  return raw.map((d) => ({
    X: cx + (d.X - cx) * cosR - (d.Y - cy) * sinR,
    Y: cy + (d.X - cx) * sinR + (d.Y - cy) * cosR,
  }));
}

const inflate = (r, g) => ({
  x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g,
});
const inside = (x, y, r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
const disjoint = (a, b) => a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;

// Width of the corner key's line as the browser lays it out (Legend.jsx,
// components.css .legend-item, visualizations.css .track-map-key): each item
// 2 x --spacing-xs + swatch + 4 px + label (Formula1 Regular at
// --font-size-label), --spacing-xs between items, 4 px padding each side
const SWATCH_W = { line: 18, band: 14, square: 9 };
function keyLineWidth(items, vp) {
  const label = Math.max(10, px(css, '--font-size-label', vp));
  const xs = px(css, '--spacing-xs', vp);
  return items.reduce((a, it) => a + 2 * xs + SWATCH_W[it.shape] + 4 + (it.label ? textWidth(it.label, label, 400) : 0), 0)
    + (items.length - 1) * xs + 8;
}
const KEY_SECTORS = [['S1', 'line'], ['S2', 'line'], ['S3', 'line'], ['DRS zone', 'band']].map(([label, shape]) => ({ label, shape }));
const ramp = (a, b) => [{ label: a, shape: 'square' }, { label: '', shape: 'square' }, { label: b, shape: 'square' }, { label: 'DRS zone', shape: 'band' }];
const KEY_STATES = {
  sectors: KEY_SECTORS,
  speed: ramp('Speed slow', 'fast'),
  throttle: ramp('Throttle 0 %', '100 %'),
  brake: ramp('Brake 0 %', '100 %'),
};

// The Pit Wall maps at the four viewports (helpers/pitWallMaps.js: the CSS as written)
const MAPS = VIEWPORTS.map((vp) => {
  const m = trackMapPanelAt(css, SRC, vp);
  return { vp, m, map: { width: Math.floor(m.content.width), height: Math.floor(m.content.height) } };
});

describe('the boxes the track is fitted around are the boxes the CSS draws', () => {
  const vp = VIEWPORTS[0];
  const d = (sel, prop) => declAt(css, sel, prop, vp);

  it('the corner key: 6 px from the corner, one 24 px line, the legend unwrapped', () => {
    expect(d('.track-map-key', 'top')).toBe(`${L.MAP_KEY.edge}px`);
    expect(d('.track-map-key', 'left')).toBe(`${L.MAP_KEY.edge}px`);
    expect(d('.track-map-key', 'height')).toBe(`${L.MAP_KEY.height}px`);
    expect(d('.track-map-key', 'overflow')).toBe('hidden');
    expect(d('.track-map-key .chart-legend', 'flex-wrap')).toBe('nowrap');
    // an item: 2 px padding + a 16 px line; the swatches are <= 10 px
    expect(d('.track-map-key .legend-item', 'line-height')).toBe('16px');
    expect(2 + 16 + 2).toBeLessThanOrEqual(L.MAP_KEY.height);
  });

  it('the HUD table: 10 px from the corner, border, padding, 14 px header, 16 px rows, 5 px column gap', () => {
    expect(d('.track-hud', 'left')).toBe(`${L.HUD_EDGE_PX}px`);
    expect(d('.track-hud', 'bottom')).toBe(`${L.HUD_EDGE_PX}px`);
    const pad = sidesAt(css, d('.track-hud', 'padding'), vp);
    expect([pad.top, pad.left]).toEqual([L.HUD_TABLE.padY, L.HUD_TABLE.padX]);
    expect(d('.track-hud', 'border')).toMatch(new RegExp(`^${L.HUD_TABLE.border}px solid`));
    expect(d('.track-hud__h', 'height')).toBe(`${L.HUD_TABLE.headPx}px`);
    expect(d('.track-hud__h', 'line-height')).toBe(`${L.HUD_TABLE.headPx}px`);
    expect(d('.track-hud__c', 'height')).toBe(`${L.HUD_TABLE.rowPx}px`);
    expect(d('.track-hud__c', 'line-height')).toBe(`${L.HUD_TABLE.rowPx}px`);
    expect(d('.track-hud__c + .track-hud__c', 'padding-left')).toBe(`${L.HUD_TABLE.gapPx}px`);
    expect(d('.track-hud__table', 'table-layout')).toBe('fixed');
    // the type fits its line at the largest viewport (12.5 / 11.5 px)
    const big = VIEWPORTS.find((v) => v.name === '2048x1100');
    expect(px(css, '--font-size-data', big) * 1.2).toBeLessThanOrEqual(L.HUD_TABLE.rowPx);
    expect(px(css, '--font-size-label', big) * 1.2).toBeLessThanOrEqual(L.HUD_TABLE.headPx);
    // the badge's line is under the row's
    expect(lengthAt(css, d('.track-hud__tyre', 'height'), vp)).toBeLessThanOrEqual(L.HUD_TABLE.rowPx);
  });

  it('the HUD cards: 10 px from the corner, 6 px apart, 148 px wide, 8 px padding, a 24 px header, 18 px rows', () => {
    expect(d('.track-telemetry-hud-container', 'left')).toBe(`${L.HUD_EDGE_PX}px`);
    expect(d('.track-telemetry-hud-container', 'bottom')).toBe(`${L.HUD_EDGE_PX}px`);
    expect(d('.track-telemetry-hud-container', 'gap')).toBe(`${L.HUD_GAP_PX}px`);
    expect(d('.track-telemetry-hud', 'min-width')).toBe(`${L.HUD_CARD.width}px`);
    expect(sidesAt(css, d('.track-telemetry-hud', 'padding'), vp).top).toBe(L.HUD_CARD.padY);
    expect(d('.track-telemetry-hud--focused', 'border-width')).toBe(`${L.HUD_CARD.border}px`);
    expect(d('.track-telemetry-hud__header', 'height')).toBe(`${L.HUD_CARD.headPx}px`);
    expect(d('.track-telemetry-hud__header', 'margin-bottom')).toBe(`${L.HUD_CARD.headGap}px`);
    expect(d('.track-telemetry-hud__row', 'height')).toBe(`${L.HUD_CARD.rowPx}px`);
    expect(d('.track-telemetry-hud__gear', 'line-height')).toBe(`${L.HUD_CARD.rowPx}px`);
    // a row's tallest line at the largest type: the label at 1.4
    const big = VIEWPORTS.find((v) => v.name === '2048x1100');
    expect(px(css, '--font-size-label', big) * 1.4).toBeLessThanOrEqual(L.HUD_CARD.rowPx);
  });

  it('the compass rose is drawn at COMPASS, at the offsets of its place (TrackMap.jsx)', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/visualizations/TrackMap.jsx'), 'utf8');
    expect(src).toMatch(/position: 'absolute', \.\.\.offsets, zIndex: 10,/);
    expect(src).toMatch(/width: COMPASS\.size, height: COMPASS\.size,/);
    expect(src).toMatch(/boxOffsets\(plan, plan\.compass\.box\)/);
    const map = { width: 366, height: 203 };
    expect(L.boxOffsets(map, { x0: 294, y0: 131, x1: 358, y1: 195 })).toEqual({ right: 8, bottom: 8 });
    expect(L.boxOffsets(map, { x0: 8, y0: 36, x1: 72, y1: 100 })).toEqual({ left: 8, top: 36 });
  });

  it('the car code labels: CAR_LABEL.dx right of the dot, at most CAR_LABEL.width wide at the largest type', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/visualizations/TrackMap.jsx'), 'utf8');
    expect(src).toMatch(/attr\('class', 'car-label'\)\.attr\('dx', CAR_LABEL\.dx\)/);
    expect(d('.car-label', 'text-anchor')).toBe('start');
    expect(d('.car-label', 'font-size')).toBe('calc(var(--font-size-data) / var(--map-zoom, 1))');
    expect(d('.car-label--focused', 'font-size')).toBe('calc(max(12px, var(--font-size-data)) / var(--map-zoom, 1))');
    const big = VIEWPORTS.find((v) => v.name === '2048x1100');
    const size = Math.max(12, px(css, '--font-size-data', big));
    // three capitals at <= 0.75 em (Titillium Web Bold / Black)
    expect(3 * 0.75 * size).toBeLessThanOrEqual(L.CAR_LABEL.width);
    expect(L.CAR_LABEL_REACH_PX).toBe(L.CAR_LABEL.dx + L.CAR_LABEL.width - L.OVERLAY_GAP_PX);
  });
});

describe.skipIf(!haveFormula1)('the HUD table columns hold their text at the largest type (12.5 / 11.5 px)', () => {
  const DATA_PX = 12.5;
  const LABEL_PX = 11.5;
  const MONO_EM = 0.61; // JetBrains Mono, Consolas, DejaVu Sans Mono, Courier: <= 0.61 em
  const mono = (s, size) => s.length * MONO_EM * size;
  const codes = [...new Set(Object.values(SESSIONS).flatMap((s) => s.driver_info.map((d) => d.Abbreviation)))];
  const VALUES = {
    drv: () => Math.max(...codes.map((c) => textWidth(c, DATA_PX, 700))),
    speed: () => mono('350', DATA_PX),
    gear: () => mono('8', DATA_PX),
    thr: () => mono('100', DATA_PX),
    brk: () => mono('100', DATA_PX),
    drs: () => Math.max(...['OFF', 'AVAIL', 'OPEN'].map((t) => mono(t, DATA_PX))),
    // badge: 16 px min, or the widest letter in Formula1 Bold + 1 px each side; 3 px; the laps
    tyre: () => Math.max(16, Math.max(...'SMHIW?'.split('').map((t) => textWidth(t, LABEL_PX, 700))) + 2) + 3 + mono('45', DATA_PX),
  };
  for (const c of L.HUD_TABLE.columns) {
    it(`${c.id}: ${c.px} px >= header and widest value`, () => {
      const head = mono(c.label, LABEL_PX);
      const value = VALUES[c.id]();
      console.log(`HUD column ${c.id}: ${c.px} px; header "${c.label}" ${head.toFixed(1)} px, widest value ${value.toFixed(1)} px`);
      expect(c.px).toBeGreaterThanOrEqual(Math.max(head, value));
    });
  }
});

// The plan of a Pit Wall map for an outline at a rotation (memoised: the
// pure tests and the mounted ones share it)
const PLANS = new Map();
function planAt(id, map, rot = 0) {
  const k = `${id}|${map.width}x${map.height}|${rot}`;
  if (!PLANS.has(k)) {
    const pts = rotatedOutline(SESSIONS[id].circuit_info, rot);
    const padding = L.mapDrawPadding(map.width, map.height);
    const t0 = performance.now();
    const plan = L.mapPlan(pts, map, { padding, drs: true, key: true });
    PLANS.set(k, {
      pts, padding, plan, ms: performance.now() - t0,
    });
  }
  return PLANS.get(k);
}
const apart = (a, b, g) => disjoint(inflate(a, g - 1e-9), b);

describe('the furniture of the four Pit Wall maps (trackMapLayout.js mapPlan): the same for any selection', () => {
  it.each(MAPS.map((r) => [r.vp.name, r]))('%s: the key row, the HUD slot and the compass, apart, in the map; the HUD for 0-5 drivers in its slot', (name, { map }) => {
    for (const id of Object.keys(SESSIONS)) {
      for (const rot of [0, 90, 180, 270]) {
        const { plan } = planAt(id, map, rot);
        // the key row: the corner key's whole line, whatever it lists
        expect(plan.key).toEqual({
          x0: L.MAP_KEY.edge, y0: L.MAP_KEY.edge, x1: map.width - L.MAP_KEY.edge, y1: L.MAP_KEY.edge + L.MAP_KEY.height,
        });
        // the HUD slot: a table, the driver, the tyre and the speed at least,
        // the focus driver and two selected drivers on rows of their own
        const slot = plan.hud;
        expect(slot.mode).toBe('table');
        expect(slot.columns.slice(0, 3).map((c) => c.id)).toEqual(['drv', 'tyre', 'speed']);
        expect(slot.rows).toBeGreaterThanOrEqual(3);
        expect(slot.box.y1 - slot.box.y0).toBeLessThanOrEqual(map.height * L.HUD_MAX_SHARE);
        expect(slot.box.x1).toBeLessThanOrEqual(map.width - L.HUD_EDGE_PX);
        // the compass at one of its places; the three HUD_GAP_PX apart, in the map
        expect(L.COMPASS_PLACES).toContain(plan.compass.place);
        const c = plan.compass.box;
        expect([c.x1 - c.x0, c.y1 - c.y0]).toEqual([L.COMPASS.size, L.COMPASS.size]);
        expect(apart(plan.key, slot.box, L.HUD_GAP_PX)).toBe(true);
        expect(apart(plan.key, c, L.HUD_GAP_PX)).toBe(true);
        expect(apart(slot.box, c, L.HUD_GAP_PX)).toBe(true);
        expect(plan.list).toEqual([plan.key, slot.box, c]);
        for (const r of plan.list) {
          expect(r.x0).toBeGreaterThanOrEqual(0);
          expect(r.y0).toBeGreaterThanOrEqual(0);
          expect(r.x1).toBeLessThanOrEqual(map.width);
          expect(r.y1).toBeLessThanOrEqual(map.height);
        }
        // the HUD as drawn for 0-5 drivers: inside the slot, from its bottom-left
        expect(L.hudTable(slot, 0)).toBeNull();
        for (const n of [1, 2, 3, 4, 5]) {
          const hud = L.hudTable(slot, n);
          expect(hud.mode).toBe('table');
          expect(hud.columns).toBe(slot.columns);
          expect(hud.rows).toBe(Math.min(n, slot.rows));
          expect(hud.shown + (hud.more ? 1 : 0)).toBe(hud.rows);
          expect(hud.shown + hud.more).toBe(n);
          if (n <= 3) expect(hud.more).toBe(0); // the focus driver and two selected: every row
          expect([hud.box.x0, hud.box.x1, hud.box.y1]).toEqual([slot.box.x0, slot.box.x1, slot.box.y1]);
          expect(hud.box.y0).toBeGreaterThanOrEqual(slot.box.y0);
        }
      }
    }
  });

  it('the compass places: bottom-right (raised above a HUD that reaches under it), top-right / top-left under the key row, above the HUD on the left', () => {
    const map = { width: 282, height: 211 };
    const key = L.mapKeyBox(map);
    const wide = L.hudSlot(map); // every column that fits: 252 px, under the bottom-right corner
    expect(wide.box.x1 + L.HUD_GAP_PX).toBeGreaterThan(map.width - L.COMPASS.edge - L.COMPASS.size);
    const right = map.width - L.COMPASS.edge - L.COMPASS.size;
    expect(L.compassAt(map, 'br', { key, hud: wide.box })).toEqual({
      x0: right, y0: wide.box.y0 - L.HUD_GAP_PX - L.COMPASS.size, x1: right + L.COMPASS.size, y1: wide.box.y0 - L.HUD_GAP_PX,
    });
    const narrow = L.hudSlot(map, { columns: L.hudColumnSets(wide.columns).at(-1) });
    expect(L.compassAt(map, 'br', { key, hud: narrow.box }).y1).toBe(map.height - L.COMPASS.edge);
    expect(L.compassAt(map, 'tr', { key, hud: narrow.box }).y0).toBe(key.y1 + L.HUD_GAP_PX);
    expect(L.compassAt(map, 'tl', { key, hud: narrow.box })).toEqual({
      x0: L.COMPASS.edge, y0: key.y1 + L.HUD_GAP_PX, x1: L.COMPASS.edge + L.COMPASS.size, y1: key.y1 + L.HUD_GAP_PX + L.COMPASS.size,
    });
    expect(L.compassAt(map, 'tr', { hud: narrow.box }).y0).toBe(L.COMPASS.edge);
    expect(L.compassAt(map, 'bl', { key, hud: narrow.box }).y1).toBe(narrow.box.y0 - L.HUD_GAP_PX);
    expect(L.compassAt(map, 'bl', { key })).toBeNull();
    // no room: null (a 100 x 90 map with the key row and a HUD)
    const tiny = { width: 100, height: 90 };
    const tinySlot = L.hudSlot(tiny);
    for (const p of L.COMPASS_PLACES) expect(L.compassAt(tiny, p, { key: L.mapKeyBox(tiny), hud: tinySlot.box })).toBeNull();
  });

  it('a big map: a slot of HUD_CARDS_MAX cards, a card per driver up to it, then a table in the slot; the column sets, widest first', () => {
    expect(L.hudLayout({ width: 900, height: 620 }, 3).mode).toBe('cards');
    expect(L.hudLayout({ width: 900, height: 620 }, 5).mode).toBe('table');
    expect(L.hudLayout({ width: 900, height: 400 }, 1).mode).toBe('table');
    expect(L.hudLayout({ width: 900, height: 620 }, 0)).toBeNull();
    const slot = L.hudSlot({ width: 900, height: 620 });
    expect(slot.mode).toBe('cards');
    expect(slot.box.x1 - slot.box.x0).toBe(L.HUD_CARDS_MAX * L.HUD_CARD.width + (L.HUD_CARDS_MAX - 1) * L.HUD_GAP_PX);
    const one = L.hudTable(slot, 1);
    expect(one.box.x1 - one.box.x0).toBe(L.HUD_CARD.width);
    const table = L.hudTable(slot, 12);
    expect(table.mode).toBe('table');
    expect(table.box.y0).toBeGreaterThanOrEqual(slot.box.y0);
    expect(table.box.x1).toBeLessThanOrEqual(slot.box.x1);
    expect(table.shown + table.more).toBe(12);
    expect(L.hudTableColumns(250).map((c) => c.id)).toEqual(['drv', 'tyre', 'speed', 'gear', 'brk', 'thr']);
    expect(L.hudTableColumns(200).map((c) => c.id)).toEqual(['drv', 'tyre', 'speed', 'gear', 'brk']);
    expect(L.hudTableColumns(1000, { drs: false }).map((c) => c.id)).not.toContain('drs');
    expect(L.hudColumnSets(L.HUD_TABLE.columns).map((s) => s.map((c) => c.id).join(' '))).toEqual([
      'drv tyre speed gear brk thr drs', 'drv tyre speed gear brk thr', 'drv tyre speed gear brk', 'drv tyre speed gear', 'drv tyre speed',
    ]);
  });

  it.each(MAPS.map((r) => [r.vp.name, r]))('%s: the choice keeps the most columns whose track is HUD_KEEP_SHARE of the largest', (name, { map }) => {
    const out = [];
    for (const id of Object.keys(SESSIONS)) {
      for (const rot of [0, 90, 180, 270]) {
        const { pts, padding, plan } = planAt(id, map, rot);
        const key = plan.key;
        const fitWith = (columns, place) => {
          const hud = L.hudSlot(map, { columns });
          const at = L.compassAt(map, place, { key, hud: hud.box });
          if (!at) return 0;
          const reach = at.x0 + at.x1 > map.width ? L.CAR_LABEL_REACH_PX : 0;
          const f = L.fitTrack(pts, map, { padding, obstacles: [key, hud.box, { ...at, x0: at.x0 - reach }] });
          return f.clear ? f.scale : 0;
        };
        const sets = L.hudColumnSets(L.hudSlot(map).columns);
        const best = Math.max(...L.COMPASS_PLACES.map((p) => fitWith(sets.at(-1), p)));
        expect(plan.fit.clear).toBe(true);
        expect(plan.fit.scale).toBeGreaterThanOrEqual(L.HUD_KEEP_SHARE * best - 1e-9);
        // one more column, at any place, costs the track more than that
        const i = sets.findIndex((s) => s.length === plan.hud.columns.length);
        if (i > 0) for (const p of L.COMPASS_PLACES) expect(fitWith(sets[i - 1], p)).toBeLessThan(L.HUD_KEEP_SHARE * best);
        out.push(`${id} r${rot} ${plan.hud.columns.length} col, compass ${plan.compass.place}`);
      }
    }
    console.log(`${name}: ${out.join('; ')}`);
  });

  it.skipIf(!haveFormula1).each(MAPS.map((r) => [r.vp.name, r]))('%s: the corner key is one line in every state (sectors, the speed / throttle / brake ramps)', (name, { map, vp }) => {
    const room = map.width - 2 * L.MAP_KEY.edge;
    for (const [state, items] of Object.entries(KEY_STATES)) {
      const w = keyLineWidth(items, vp);
      console.log(`${name} corner key, ${state}: ${w.toFixed(1)} of ${room} px`);
      expect(w).toBeLessThanOrEqual(room);
    }
    // before: the ramp after S1-S3 needed 375-378 px
    const before = keyLineWidth([...KEY_SECTORS, ...KEY_STATES.speed.slice(0, 3)], vp);
    if (name === '1366x768' || name === '1536x750') expect(before).toBeGreaterThan(room);
  });
});

describe('fitTrack: the three real outlines in the four Pit Wall maps, clear of the overlays', () => {
  it('no overlay: the centred plain fit (the former layout)', () => {
    const pts = rotatedOutline(MONZA.circuit_info);
    const f = L.fitTrack(pts, { width: 366, height: 203 }, { padding: 28 });
    const xs = pts.map((p) => p.X);
    const ys = pts.map((p) => p.Y);
    const tw = Math.max(...xs) - Math.min(...xs);
    const th = Math.max(...ys) - Math.min(...ys);
    const s = Math.min((366 - 56) / tw, (203 - 56) / th);
    expect(f.scale).toBeCloseTo(s, 9);
    expect(f.left).toBeCloseTo((366 - tw * s) / 2, 9);
    expect(f.top).toBeCloseTo((203 - th * s) / 2, 9);
    expect(f.clear).toBe(true);
  });

  it('carLabelOnLeft: a code label that would cross the right edge goes on the left of the dot', () => {
    expect(L.CAR_LABEL_EDGE_PX).toBe(L.CAR_LABEL.dx + L.CAR_LABEL.width);
    const W = 366;
    expect(L.carLabelOnLeft(W - L.CAR_LABEL_EDGE_PX, W)).toBe(false); // the label ends on the edge
    expect(L.carLabelOnLeft(W - L.CAR_LABEL_EDGE_PX + 0.5, W)).toBe(true);
    expect(L.carLabelOnLeft(W - 28, W)).toBe(true); // the rightmost point at a 28 px margin
    expect(L.carLabelOnLeft(28, W)).toBe(false);
    expect(L.carLabelOnLeft(-9999, W)).toBe(false); // a car off the map (no position)
    expect(L.carLabelOnLeft(Number.NaN, W)).toBe(false);
    // a map narrower than two labels: always the right
    expect(L.carLabelOnLeft(70, 2 * L.CAR_LABEL_EDGE_PX)).toBe(false);
  });

  it('an overlay in an empty corner leaves the plain fit; a map too small for its overlays keeps the plain fit, flagged', () => {
    const square = [{ X: 0, Y: 0 }, { X: 100, Y: 0 }, { X: 100, Y: 100 }, { X: 0, Y: 100 }, { X: 50, Y: 50 }];
    const plain = L.fitTrack(square, { width: 300, height: 300 }, { padding: 20 });
    const corner = L.fitTrack(square, { width: 300, height: 300 }, { padding: 20, obstacles: [{ x0: 0, y0: 0, x1: 20 - L.OVERLAY_GAP_PX - 1, y1: 20 - L.OVERLAY_GAP_PX - 1 }] });
    expect(corner.scale).toBeCloseTo(plain.scale, 9);
    const full = L.fitTrack(square, { width: 300, height: 300 }, { padding: 20, obstacles: [{ x0: 0, y0: 0, x1: 300, y1: 300 }] });
    expect(full.clear).toBe(false);
    expect(full.scale).toBeCloseTo(plain.scale, 9);
    expect(L.fitTrack([], { width: 300, height: 300 }).clear).toBe(true);
    expect(L.fitTrack(square, { width: 0, height: 0 }).width).toBe(0);
  });

  // The share of the plain fit the track keeps at least: Roberto's main
  // screen (1536 x 750) and his second (2048 x 1100), and anywhere
  const KEEPS = { '1536x750': 0.7, '2048x1100': 0.9 };
  // A car code label's box from its car's position: CAR_LABEL.dx right of
  // the dot, CAR_LABEL.width wide; dy 4 px, at most 12.5 px type, taken
  // generously both ways (a middle or an alphabetic baseline): 7 px above
  // the dot to 11.5 px under it
  const labelBox = (x, y) => ({
    x0: x + L.CAR_LABEL.dx, y0: y - 7, x1: x + L.CAR_LABEL.dx + L.CAR_LABEL.width, y1: y + 11.5,
  });
  // ... and on the left of the dot (carLabelOnLeft: dx -CAR_LABEL.dx, text-anchor end)
  const labelBoxLeft = (x, y) => ({
    x0: x - L.CAR_LABEL.dx - L.CAR_LABEL.width, y0: y - 7, x1: x - L.CAR_LABEL.dx, y1: y + 11.5,
  });
  const rows = [];
  for (const [id, session] of Object.entries(SESSIONS)) {
    for (const { vp, map } of MAPS) {
      it(`${id} ${vp.name}: four rotations: every point >= ${L.OVERLAY_GAP_PX} px off the furniture, no car label on it`, () => {
        for (const rot of [0, 90, 180, 270]) {
          const { pts, padding: pad, plan, ms } = planAt(id, map, rot);
          const plain = L.fitTrack(pts, map, { padding: pad });
          const f = plan.fit;
          expect(f.clear).toBe(true);
          // a compass on the right is fitted CAR_LABEL_REACH_PX wider on its left
          const c = plan.compass.box;
          const reach = c.x0 + c.x1 > map.width ? L.CAR_LABEL_REACH_PX : 0;
          expect(plan.obstacles).toEqual([plan.key, plan.hud.box, { ...c, x0: c.x0 - reach }]);
          let xmin = Infinity; let ymax = -Infinity;
          for (const p of pts) { xmin = Math.min(xmin, p.X); ymax = Math.max(ymax, p.Y); }
          const zones = plan.obstacles.map((r) => inflate(r, L.OVERLAY_GAP_PX - 1e-6));
          const at = pts.map((p) => [f.left + (p.X - xmin) * f.scale, f.top + (ymax - p.Y) * f.scale]);
          expect(at.filter(([x, y]) => zones.some((r) => inside(x, y, r)))).toHaveLength(0);
          // a car anywhere on the outline: its code label off the key, the HUD and the compass
          expect(at.filter(([x, y]) => plan.list.some((r) => !disjoint(labelBox(x, y), r)))).toHaveLength(0);
          // inside the padded box
          expect(f.left).toBeGreaterThanOrEqual(pad - 1e-6);
          expect(f.top).toBeGreaterThanOrEqual(pad - 1e-6);
          expect(f.left + f.width).toBeLessThanOrEqual(map.width - pad + 1e-6);
          expect(f.top + f.height).toBeLessThanOrEqual(map.height - pad + 1e-6);
          // a car anywhere on the outline, its code label on the side
          // carLabelOnLeft gives: inside the map (the svg clips at its edge; on
          // the right only, a car at the rightmost point lost about 6 px of it
          // at 1536 x 750) and off the key, the HUD and the compass
          const sided = at.map(([x, y]) => (L.carLabelOnLeft(x, map.width) ? labelBoxLeft(x, y) : labelBox(x, y)));
          const flipped = at.filter(([x]) => L.carLabelOnLeft(x, map.width)).length;
          expect(sided.filter((b) => b.x0 < 0 || b.x1 > map.width + 1e-6)).toHaveLength(0);
          expect(sided.filter((b) => plan.list.some((r) => !disjoint(b, r)))).toHaveLength(0);
          expect(ms).toBeLessThan(250);
          const share = f.scale / plain.scale;
          rows.push(`${id} ${vp.name} r${rot}: HUD ${plan.hud.columns.map((x) => x.id).join('/')} x ${plan.hud.rows} rows, compass ${plan.compass.place}; track ${f.width.toFixed(0)} x ${f.height.toFixed(0)} = ${(100 * share).toFixed(0)} % of the plain fit (${plain.width.toFixed(0)} x ${plain.height.toFixed(0)}), right margin ${(map.width - f.left - f.width).toFixed(1)} px, labels on the left ${(100 * flipped / at.length).toFixed(1)} % of the outline, ${ms.toFixed(1)} ms`);
          expect(share).toBeGreaterThanOrEqual(KEEPS[vp.name] ?? 0.5);
        }
      });
    }
  }
  afterAll(() => { for (const r of rows) console.log(r); });
});

// ── The mounted view (mini DOM) on Monza ─────────────────────────────────

const RACES = {
  '2024_16_R': { year: 2024, round: 16, laps: 53 },
  '2024_5_R': { year: 2024, round: 5, laps: 56 },
  '2025_1_R': { year: 2025, round: 1, laps: 57 },
};

/**
 * A race at lap 20 in the store: the cars at the circuit's first point, or
 * (spread) spread along the outline, in its own units.
 */
function raceState(id, { focus = null, selected = [], spread = false } = {}) {
  const S = SESSIONS[id];
  const { year, round, laps } = RACES[id];
  const coords = S.circuit_info.track_coordinates;
  const drivers = Object.fromEntries(S.driver_info.map((d, i) => {
    const p = spread ? coords[Math.floor((i * coords.length) / S.driver_info.length)] : { X: 0, Y: 0 };
    return [d.Abbreviation, {
      x: p.X, y: p.Y, speed: 280 + i, throttle: 100, brake: 0, gear: 8, drs: i % 3 === 0 ? 12 : 0, tyre: 2, tyre_life: 12, lap: 20, position: i + 1,
    }];
  }));
  useF1Store.setState({
    ...INITIAL,
    year, round, sessionType: 'R',
    loadedYear: year, loadedRound: round, loadedSessionType: 'R',
    sessionData: S,
    circuitInfo: S.circuit_info,
    trackStatus: S.track_status,
    sessionTimeOffset: computeSessionTimeOffset(S.lap_times),
    maxLap: laps, totalRaceLaps: laps, currentLap: 20,
    // lap mode (no frame clock): the map's clock is lap 20, so the focus
    // driver has completed laps and the channel overlay can be drawn
    frameData: { frames: [{ t: 0, lap: 20, drivers }] },
    currentFrameIndex: 0, totalFrames: 0, currentTime: 0,
    showTrackDRS: true, showTrackSectors: true, trackRotationOffset: 0,
    focusDriver: focus, selectedDrivers: selected,
    telemetryCache: {},
  });
}
const monzaState = (opts) => raceState('2024_16_R', opts);

/** The driver's lap 10 telemetry in the cache: the circuit's points with a speed ramp. */
function cacheLapTelemetry(driver, id = '2024_16_R') {
  const pts = SESSIONS[id].circuit_info.track_coordinates;
  const samples = pts.map((p, i) => ({
    X: p.X, Y: p.Y, Distance: p.Distance, Speed: 90 + (240 * i) / pts.length, Throttle: 100, Brake: 0,
  }));
  const key = telemetryCacheKey(driver, 10, sessionScopeOf(useF1Store.getState()));
  useF1Store.setState({ telemetryCache: { [key]: samples } });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

async function mountInCell(model, box = null) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: model.cell.width, height: model.cell.height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(TrackMap)); });
  const content = host.querySelector('.panel-content');
  const viz = host.querySelector('.viz-container');
  const top = model.border + model.header.height + model.contentPad.top;
  const mapBox = box || model.content;
  dom.setRect(content, { left: 0, top, width: model.content.width, height: model.content.height });
  dom.setRect(viz, { left: 0, top, width: mapBox.width, height: mapBox.height });
  await act(async () => {
    ro.notify(content, model.content.width, model.content.height);
    ro.notify(viz, mapBox.width, mapBox.height);
  });
  await settle();
  return {
    host, viz, top,
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

/** The browser measures the corner key: its line's width from the real metrics. */
async function measureKey(v, vp) {
  const key = v.host.querySelector('.track-map-key');
  if (!key) return null;
  const items = [...key.querySelectorAll('.legend-item')].map((el) => ({ label: text(el), shape: el.getAttribute('data-shape') }));
  const width = Math.ceil(keyLineWidth(items, vp));
  dom.setRect(key, { left: L.MAP_KEY.edge, top: v.top + L.MAP_KEY.edge, width, height: L.MAP_KEY.height });
  await act(async () => { ro.notify(key, width, L.MAP_KEY.height); });
  await settle();
  return { items, rect: { x0: L.MAP_KEY.edge, y0: L.MAP_KEY.edge, x1: L.MAP_KEY.edge + width, y1: L.MAP_KEY.edge + L.MAP_KEY.height } };
}

/** The overlays as drawn: the HUD's and the compass's boxes from their styles and the CSS. */
function drawnOverlays(v, map) {
  const out = {};
  const hud = v.viz.querySelector('.track-hud');
  if (hud) {
    const w = n0(hud.style.width);
    const h = n0(hud.style.height);
    out.hud = { x0: L.HUD_EDGE_PX, y0: map.height - L.HUD_EDGE_PX - h, x1: L.HUD_EDGE_PX + w, y1: map.height - L.HUD_EDGE_PX };
  }
  const cards = v.viz.querySelectorAll('.track-telemetry-hud');
  if (cards.length) {
    const h = L.hudCardHeight({ drs: true });
    const w = cards.length * L.HUD_CARD.width + (cards.length - 1) * L.HUD_GAP_PX;
    out.hud = { x0: L.HUD_EDGE_PX, y0: map.height - L.HUD_EDGE_PX - h, x1: L.HUD_EDGE_PX + w, y1: map.height - L.HUD_EDGE_PX };
  }
  // the compass from the offsets it is drawn at (left or right, top or bottom)
  const c = v.viz.querySelector('.track-map-compass');
  const s = n0(c.style.width);
  const set = (v) => v != null && v !== '';
  const x0 = set(c.style.left) ? n0(c.style.left) : map.width - n0(c.style.right) - s;
  const y0 = set(c.style.top) ? n0(c.style.top) : map.height - n0(c.style.bottom) - s;
  out.compass = {
    x0, y0, x1: x0 + s, y1: y0 + s,
  };
  out.compassPlace = c.getAttribute('data-place');
  return out;
}

/** Points along the drawn outline (d3.line, curveCatmullRom: M then cubic C segments), 1 per ~1 px. */
function outlineSamples(svg) {
  const d = svg.querySelector('.track-outline')?.getAttribute('d') || '';
  const toks = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
  const out = [];
  let i = 0; let cmd = null; let x = 0; let y = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[MLCZ]/i.test(toks[i])) cmd = toks[i++].toUpperCase();
    if (cmd === 'M' || cmd === 'L') {
      const nx = num(); const ny = num();
      if (cmd === 'L') {
        const len = Math.hypot(nx - x, ny - y);
        const k = Math.max(1, Math.ceil(len));
        for (let j = 1; j <= k; j += 1) out.push([x + ((nx - x) * j) / k, y + ((ny - y) * j) / k, len / k]);
      } else out.push([nx, ny, 0]);
      x = nx; y = ny;
      if (cmd === 'M') cmd = 'L';
    } else if (cmd === 'C') {
      const x1 = num(); const y1 = num(); const x2 = num(); const y2 = num(); const x3 = num(); const y3 = num();
      const chord = Math.hypot(x3 - x, y3 - y) + Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      const k = Math.max(4, Math.ceil(chord / 2));
      let px0 = x; let py0 = y;
      for (let j = 1; j <= k; j += 1) {
        const t = j / k; const u = 1 - t;
        const bx = u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        const by = u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        out.push([bx, by, Math.hypot(bx - px0, by - py0)]);
        px0 = bx; py0 = by;
      }
      x = x3; y = y3;
    } else if (cmd === 'Z') {
      cmd = null;
    } else {
      i += 1;
    }
  }
  return out;
}

const STATES = [
  { id: 'S0', focus: null, selected: [], hud: 0 },
  { id: 'S1', focus: 'NOR', selected: [], hud: 1 },
  { id: 'S2', focus: 'NOR', selected: [], hud: 1, overlay: 'speed' },
  { id: 'S3', focus: 'NOR', selected: ['LEC', 'HAM'], hud: 3 },
  { id: 'S5', focus: 'NOR', selected: ['LEC', 'HAM', 'PIA', 'SAI'], hud: 5 },
];

describe('the mounted Track Map on Monza 2024 in its Pit Wall cell: no overlay hides the track', () => {
  afterAll(() => useF1Store.setState({ ...INITIAL }));
  const summary = [];
  afterAll(() => { for (const r of summary) console.log(r); });

  for (const { vp, m, map } of MAPS) {
    for (const st of STATES) {
      it(`${vp.name} ${st.id}: HUD, key and compass as modelled; the outline's sampled length under them 0 %`, async () => {
        monzaState(st);
        if (st.overlay) cacheLapTelemetry(st.focus);
        const v = await mountInCell(m);
        try {
          if (st.overlay) {
            // the channel overlay from the Layers popover
            await act(async () => {
              v.host.querySelector('.track-map-tool--layers').dispatchEvent({ type: 'click', bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {} });
            });
            const btn = [...dom.document.body.querySelector('#track-map-layers').querySelectorAll('button')].find((b) => text(b) === 'SPD');
            await act(async () => { btn.dispatchEvent({ type: 'click', bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {} }); });
            await settle();
          }
          const key = await measureKey(v, vp);
          const svg = v.viz.querySelector('svg');
          expect(svg.getAttribute('viewBox')).toBe(`0 0 ${map.width} ${map.height}`);
          expect(svg.getAttribute('data-track-fit')).toBe('clear');
          // the key: S1-S3 + DRS zone, or the ramp + DRS zone under the drawn overlay; one line
          expect(key.items.map((k) => k.label)).toEqual(st.overlay
            ? ['Speed slow', '', 'fast', 'DRS zone'] : ['S1', 'S2', 'S3', 'DRS zone']);
          if (st.overlay) expect(v.viz.querySelectorAll('.channel-overlay-layer line').length).toBeGreaterThan(100);
          expect(key.rect.x1 - key.rect.x0).toBeLessThanOrEqual(map.width - 2 * L.MAP_KEY.edge);
          expect(v.host.querySelector('.track-map-key__more')).toBeNull();
          // the HUD: a table of hud rows (+ "more") in the plan's slot, never the cards here
          expect(v.viz.querySelectorAll('.track-telemetry-hud')).toHaveLength(0);
          const mapPlan = planAt('2024_16_R', map, 0).plan;
          const plan = L.hudTable(mapPlan.hud, st.hud);
          const table = v.viz.querySelector('.track-hud');
          if (!st.hud) expect(table).toBeNull();
          else {
            expect(n0(table.style.width)).toBe(L.hudTableWidth(plan.columns));
            expect(n0(table.style.height)).toBe(plan.box.y1 - plan.box.y0);
            expect(table.querySelectorAll('tbody tr')).toHaveLength(plan.rows);
            expect(table.querySelectorAll('thead th')).toHaveLength(mapPlan.hud.columns.length);
            expect(text(table.querySelector('tbody tr td'))).toBe('NOR');
            if (plan.more) expect(text(table.querySelector('.track-hud__more'))).toBe(`+${plan.more} more`);
          }
          // the overlays as drawn, pairwise apart, and the outline off them;
          // the compass where the plan puts it
          const ov = drawnOverlays(v, map);
          expect(ov.compass).toEqual(mapPlan.compass.box);
          expect(ov.compassPlace).toBe(mapPlan.compass.place);
          const boxes = [key.rect, ov.hud, ov.compass].filter(Boolean);
          for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) expect(disjoint(boxes[a], boxes[b])).toBe(true);
          const samples = outlineSamples(svg);
          expect(samples.length).toBeGreaterThan(300);
          let total = 0; let under = 0; let underStroke = 0;
          let xmin = Infinity; let xmax = -Infinity; let ymin = Infinity; let ymax = -Infinity;
          for (const [x, y, len] of samples) {
            total += len;
            if (boxes.some((r) => inside(x, y, r))) under += len;
            if (boxes.some((r) => inside(x, y, inflate(r, 12)))) underStroke += len; // the 24 px outline's half-width
            xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
          }
          summary.push(`${vp.name} ${st.id}: map ${map.width} x ${map.height}; key ${(key.rect.x1 - key.rect.x0)} x ${L.MAP_KEY.height} [${key.items.map((k) => k.label || '·').join(', ')}]; `
            + `HUD ${ov.hud ? `${ov.hud.x1 - ov.hud.x0} x ${ov.hud.y1 - ov.hud.y0} (${st.hud} driver(s))` : 'none'}; compass ${ov.compassPlace} at ${ov.compass.x0},${ov.compass.y0}; `
            + `track ${(xmax - xmin).toFixed(0)} x ${(ymax - ymin).toFixed(0)}, ${total.toFixed(0)} px long, under an overlay ${(100 * under / total).toFixed(1)} % (stroke ${(100 * underStroke / total).toFixed(1)} %)`);
          expect(under).toBe(0);
          expect(underStroke).toBe(0);
        } finally {
          await v.unmount();
        }
      });
    }
  }

  it('a big map (884 x 620): the cards, the track clear of them', async () => {
    monzaState({ focus: 'NOR', selected: ['LEC', 'HAM'] });
    const m = trackMapPanelAt(css, SRC, VIEWPORTS.find((x) => x.name === '1920x1080'));
    const big = { ...m, cell: { width: 900, height: 760 }, content: { width: 884, height: 700 } };
    const v = await mountInCell(big, { width: 884, height: 620 });
    try {
      const map = { width: 884, height: 620 };
      expect(v.viz.querySelectorAll('.track-telemetry-hud')).toHaveLength(3);
      expect(v.viz.querySelector('.track-hud')).toBeNull();
      const ov = drawnOverlays(v, map);
      expect(disjoint(ov.hud, ov.compass)).toBe(true);
      const samples = outlineSamples(v.viz.querySelector('svg'));
      const under = samples.filter(([x, y]) => [ov.hud, ov.compass].some((r) => inside(x, y, inflate(r, 12))));
      expect(under).toHaveLength(0);
    } finally {
      await v.unmount();
    }
  });

  it('a key that overflows its line gives way, item by item, to a "+k" chip (measured after layout)', async () => {
    monzaState({});
    const m = trackMapPanelAt(css, SRC, VIEWPORTS[0]);
    const v = await mountInCell(m);
    try {
      const key = v.host.querySelector('.track-map-key');
      expect([...key.querySelectorAll('.legend-item')]).toHaveLength(4);
      // a browser where the line is 600 px in a 200 px key
      Object.defineProperty(key, 'scrollWidth', { configurable: true, get: () => 600 });
      dom.setRect(key, { left: 6, top: v.top + 6, width: 200, height: 24 });
      // a new map width: the key is fitted again
      dom.setRect(v.viz, { left: 0, top: v.top, width: m.content.width - 10, height: m.content.height });
      await act(async () => { ro.notify(v.viz, m.content.width - 10, m.content.height); });
      await settle();
      const k2 = v.host.querySelector('.track-map-key');
      expect([...k2.querySelectorAll('.legend-item')]).toHaveLength(1);
      expect(text(k2.querySelector('.track-map-key__more'))).toBe('+3');
    } finally {
      await v.unmount();
    }
  });

  // The svg clips at the map's edge; a code label right of a car at
  // the track's rightmost point (28 px from the edge at 1536 x 750) lost
  // about 6 px of its 41 px reach
  it('1536x750: a car at the track\'s rightmost point has its code label left of the dot, a car elsewhere right of it', async () => {
    const { m, map } = MAPS.find((r) => r.vp.name === '1536x750');
    monzaState({});
    const coords = MONZA.circuit_info.track_coordinates;
    const drawn = rotatedOutline(MONZA.circuit_info);
    let iR = 0; let iL = 0;
    drawn.forEach((p, i) => { if (p.X > drawn[iR].X) iR = i; if (p.X < drawn[iL].X) iL = i; });
    const frame = useF1Store.getState().frameData.frames[0];
    const at = (i) => ({ x: coords[i].X, y: coords[i].Y });
    useF1Store.setState({
      totalFrames: 1,
      frameData: { frames: [{ ...frame, drivers: { ...frame.drivers, NOR: { ...frame.drivers.NOR, ...at(iR) }, LEC: { ...frame.drivers.LEC, ...at(iL) } } }] },
    });
    const v = await mountInCell(m);
    try {
      const label = (code) => [...v.viz.querySelectorAll('.car-label')].find((t) => text(t) === code);
      const xOf = (code) => Number(/translate\(\s*(-?[\d.e+-]+)/.exec(label(code).parentNode.getAttribute('transform'))[1]);
      const plan = planAt('2024_16_R', map, 0).plan;
      // NOR at the rightmost point: the plan's right margin, too little for the label on the right
      expect(xOf('NOR')).toBeCloseTo(plan.fit.left + plan.fit.width, 6);
      expect(xOf('NOR') + L.CAR_LABEL_EDGE_PX).toBeGreaterThan(map.width);
      expect(label('NOR').getAttribute('class').split(/\s+/)).toContain('car-label--left');
      expect(Number(label('NOR').getAttribute('dx'))).toBe(-L.CAR_LABEL.dx);
      expect(xOf('NOR') - L.CAR_LABEL_EDGE_PX).toBeGreaterThanOrEqual(0);
      // LEC at the leftmost point: right of the dot, inside the map
      expect(label('LEC').getAttribute('class').split(/\s+/)).not.toContain('car-label--left');
      expect(Number(label('LEC').getAttribute('dx'))).toBe(L.CAR_LABEL.dx);
      expect(xOf('LEC') + L.CAR_LABEL_EDGE_PX).toBeLessThanOrEqual(map.width);
      // the CSS draws the left one from its end
      expect(declAt(css, '.car-label--left', 'text-anchor', VIEWPORTS[0])).toBe('end');
    } finally {
      await v.unmount();
    }
  });

  // with no plan (no outline yet) the HUD was not drawn at all
  it('no outline yet (the circuit still loading): the focus driver\'s HUD still reads, in the slot of the box', async () => {
    const { m, map } = MAPS.find((r) => r.vp.name === '1536x750');
    monzaState({ focus: 'NOR' });
    useF1Store.setState({ circuitInfo: null });
    const v = await mountInCell(m);
    try {
      expect(v.viz.querySelector('.track-outline')).toBeNull();
      const table = v.viz.querySelector('.track-hud');
      expect(table).not.toBeNull();
      expect(text(table.querySelector('tbody tr td'))).toBe('NOR');
      expect(n0(table.style.width)).toBe(L.hudTableWidth(L.hudSlot(map).columns));
    } finally {
      await v.unmount();
    }
  });
});

// A click on a car (or its Leaderboard
// row) changed the HUD's rows, the track was fitted again and every car
// moved under the pointer (Monza at 1536 x 750: 16-33 px a driver;
// Shanghai 104 px). Now the track is fitted around the HUD's slot: the
// outline and the cars stay where they are through the whole sequence.
describe('a change of the selection, the focus driver or the channel overlay never moves the track', () => {
  afterAll(() => useF1Store.setState({ ...INITIAL }));
  const summary = [];
  afterAll(() => { for (const r of summary) console.log(r); });
  const click = (el) => act(async () => {
    el.dispatchEvent({
      type: 'click', bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {},
    });
  });
  const carAt = (v) => Object.fromEntries([...v.viz.querySelectorAll('.car-marker')]
    .map((g) => [text(g.querySelector('.car-label')), g.getAttribute('transform')]));

  for (const id of Object.keys(SESSIONS)) {
    for (const { vp, m, map } of MAPS) {
      it(`${id} ${vp.name}: focus, three selected drivers, the speed overlay, a new focus driver: the outline and the cars unmoved`, async () => {
        raceState(id, { spread: true });
        cacheLapTelemetry('NOR', id);
        const v = await mountInCell(m);
        try {
          await measureKey(v, vp);
          const svg = v.viz.querySelector('svg');
          const outline = () => svg.querySelector('.track-outline').getAttribute('d');
          const first = { d: outline(), cars: carAt(v), compass: drawnOverlays(v, map).compass };
          expect(first.d.length).toBeGreaterThan(100);
          expect(Object.keys(first.cars).length).toBe(SESSIONS[id].driver_info.length);
          const steps = [];
          const check = async (label, rows) => {
            await settle();
            await measureKey(v, vp);
            expect(outline()).toBe(first.d);
            expect(carAt(v)).toEqual(first.cars);
            expect(drawnOverlays(v, map).compass).toEqual(first.compass);
            const table = v.viz.querySelector('.track-hud');
            expect(table ? table.querySelectorAll('tbody tr').length : 0).toBe(rows);
            steps.push(label);
          };
          await act(async () => { useF1Store.setState({ focusDriver: 'NOR' }); });
          await check('focus NOR', 1);
          // a click on LEC's car selects it
          const lec = [...v.viz.querySelectorAll('.car-marker')].find((g) => text(g.querySelector('.car-label')) === 'LEC');
          await click(lec);
          expect(useF1Store.getState().selectedDrivers).toEqual(['LEC']);
          await check('+LEC (click)', 2);
          await act(async () => { useF1Store.setState({ selectedDrivers: ['LEC', 'VER'] }); });
          await check('+VER', 3);
          await act(async () => { useF1Store.setState({ selectedDrivers: ['LEC', 'VER', 'PIA'] }); });
          const rows = Math.min(4, planAt(id, map, 0).plan.hud.rows);
          await check('+PIA', rows);
          // the speed overlay on NOR's lap: the key shows the ramp
          await click(v.host.querySelector('.track-map-tool--layers'));
          const spd = [...dom.document.body.querySelector('#track-map-layers').querySelectorAll('button')].find((b) => text(b) === 'SPD');
          await click(spd);
          await check('SPD overlay', rows);
          expect(v.viz.querySelectorAll('.channel-overlay-layer line').length).toBeGreaterThan(100);
          expect(text(v.host.querySelector('.track-map-key'))).toMatch(/Speed slow/);
          // a new focus driver without a cached lap: the overlay is gone, the key back to S1-S3
          await act(async () => { useF1Store.setState({ focusDriver: 'HAM' }); });
          await check('focus HAM', rows);
          expect(v.viz.querySelectorAll('.channel-overlay-layer line')).toHaveLength(0);
          expect(text(v.host.querySelector('.track-map-key'))).toMatch(/S1/);
          summary.push(`${id} ${vp.name}: ${steps.join(', ')}: outline, ${Object.keys(first.cars).length} cars and the compass unmoved`);
        } finally {
          await v.unmount();
        }
      });
    }
  }
});

describe('the toolbar buttons read in both themes (>= 3:1 glyph and border on the header)', () => {
  const vp = VIEWPORTS[0];
  const tokenAt = (theme, name) => {
    const v = theme === 'light' ? declAt(css, '[data-theme="light"]', name, vp) : css.tokens.get(name);
    return String(v).trim();
  };
  const header = (theme) => {
    // the page, the panel (.panel), the header (.panel-header), as composited by the browser
    const page = tokenAt(theme, '--color-bg-primary');
    const panel = theme === 'light' ? declAt(css, '[data-theme="light"] .panel', 'background', vp) : tokenAt('dark', '--glass-bg');
    const head = theme === 'light'
      ? declAt(css, '[data-theme="light"] .panel-header', 'background', vp)
      : declAt(css, '.panel-header', 'background', vp);
    return compositeOver(head, compositeOver(panel, page));
  };
  const resolve = (theme, value) => String(value).replace(/var\((--[\w-]+)\)/g, (_, n) => tokenAt(theme, n));

  it('MapTool carries no inline colour: the CSS of .track-map-tool does, per theme', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/visualizations/TrackMap.jsx'), 'utf8');
    const tool = src.slice(src.indexOf('const MapTool = React.forwardRef'), src.indexOf('/* ── A labelled group'));
    expect(tool).not.toMatch(/border:|color:|background:/);
  });

  for (const theme of ['dark', 'light']) {
    it(`${theme}: glyph and border >= 3:1, the open button's too, and the panel's export button beside them`, () => {
      const bg = header(theme);
      const sel = theme === 'light' ? '[data-theme="light"] .track-map-tool' : '.track-map-tool';
      const glyph = resolve(theme, declAt(css, '.track-map-tool', 'color', vp));
      const borderDecl = theme === 'light' ? declAt(css, sel, 'border-color', vp) : declAt(css, '.track-map-tool', 'border', vp);
      const border = resolve(theme, String(borderDecl).replace(/^[\d.]+px solid /, ''));
      const active = resolve(theme, declAt(css, '.track-map-tool[data-active="true"]', 'color', vp));
      const activeBorder = resolve(theme, declAt(css, '.track-map-tool[data-active="true"]', 'border-color', vp));
      const r = {
        glyph: contrastRatio(glyph, bg),
        border: contrastRatio(border, bg),
        active: contrastRatio(active, bg),
        activeBorder: contrastRatio(activeBorder, bg),
        exportGlyph: contrastRatio(resolve(theme, declAt(css, '.panel-export-btn', 'color', vp)), bg),
      };
      console.log(`${theme}: header ${bg}; glyph ${glyph} ${r.glyph.toFixed(2)}:1, border ${border} ${r.border.toFixed(2)}:1, open ${r.active.toFixed(2)}:1 / border ${r.activeBorder.toFixed(2)}:1; export button ${r.exportGlyph.toFixed(2)}:1`);
      for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(3);
    });
  }

  it('the mounted buttons have the class, the open Layers button data-active', async () => {
    monzaState({});
    const m = trackMapPanelAt(css, SRC, VIEWPORTS[0]);
    const v = await mountInCell(m);
    try {
      const tools = [...v.host.querySelectorAll('.panel-header .track-map-tool')];
      expect(tools.length).toBeGreaterThan(0);
      for (const b of tools) {
        expect(b.style.color || '').toBe('');
        expect(b.style.border || '').toBe('');
      }
      const layers = v.host.querySelector('.track-map-tool--layers');
      expect(layers.getAttribute('data-active')).toBeNull();
      await act(async () => { layers.dispatchEvent({ type: 'click', bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {} }); });
      expect(layers.getAttribute('data-active')).toBe('true');
      await act(async () => { layers.dispatchEvent({ type: 'click', bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {} }); });
    } finally {
      await v.unmount();
      useF1Store.setState({ ...INITIAL });
    }
  });
});
