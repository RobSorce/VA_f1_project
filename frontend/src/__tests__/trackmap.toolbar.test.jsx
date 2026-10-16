// Phase 9d G1 (HIGH, Roberto's screen): the Pit Wall Track Map keeps most
// of its panel at the four target viewports.
//
// The browser pass (docs/evidence/browser_audit_2026-10-16.md,
// "Re-check after Phase 9c") measured at 1536 x 750: panel 387 x 263, its
// .panel-controls wrapped to 181 px (rotation, zoom, S1-S3 / DRS / Corners,
// SPD / THR / BRK, the map legend and ten driver chips in the header row),
// the map's .viz-container 354 x 34 px. Now (utils/views/trackMapLayout.js):
// one row of 24 px icon buttons in the header (zoom in / out / reset and
// Layers; the rotation group from 440 px of content width), the layers, the
// overlay and the legends in the Layers popover below 560 px of content
// height (a strip above the map in a taller panel), a one-line key of what
// is drawn on the map's corner, half the content padding (.panel--dense).
//
// The fit is the static model of the cell (helpers/pitWallMaps.js: the CSS
// as written, PitWallLayout.jsx's grid, the Formula1 metrics of the title);
// the mounted view (mini DOM) is checked to be that model: one header row of
// the modelled buttons, nothing but the map in the panel's content.
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
const { loadCss, px, VIEWPORTS } = await import('./helpers/layoutModel.js');
const {
  trackMapPanelAt, trackMapIsDense, haveFormula1,
} = await import('./helpers/pitWallMaps.js');
const {
  trackMapControls, toolbarLayout, toolbarWidth, mapDrawPadding, TOOL_PX, LAYERS_INLINE_MIN_H, ROTATE_TOOLS_MIN_W,
} = await import('../utils/views/trackMapLayout.js');
const { textWidth } = await import('./helpers/fontWidths.js');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');

const ro = installResizeObserverMock();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = loadCss(SRC);
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function sessionState() {
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: SESSION,
    circuitInfo: SESSION.circuit_info,
    trackStatus: SESSION.track_status,
    sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
    maxLap: 20, totalRaceLaps: 20, currentLap: 1,
    totalFrames: 0, currentTime: 0,
    showTrackDRS: true, showTrackSectors: true,
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

/** TrackMap in a host of the cell size; the panel's content and the map box at the model's sizes. */
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
    host,
    content,
    viz,
    toolbar: () => host.querySelector('.panel-header .track-map-toolbar'),
    tools: () => [...host.querySelectorAll('.panel-header .track-map-tool')],
    layersBtn: () => host.querySelector('.panel-header .track-map-tool--layers'),
    popover: () => dom.document.body.querySelector('#track-map-layers'),
    key: () => host.querySelector('.track-map-key'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const click = (el) => act(async () => { el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true, _stop: false, preventDefault() {}, stopPropagation() { this._stop = true; } }); });
const keydown = (key) => act(async () => {
  dom.document.dispatchEvent({ type: 'keydown', key, bubbles: true, cancelable: true, _stop: false, preventDefault() {}, stopPropagation() {} });
});

describe('the model: the Pit Wall Track Map at the four viewports (CSS as written, real title metrics)', () => {
  const rows = VIEWPORTS.map((vp) => ({ vp, m: trackMapPanelAt(css, SRC, vp) }));

  it('the Track Map panel is .panel--dense (half the content padding)', () => {
    expect(trackMapIsDense(SRC)).toBe(true);
  });

  it.each(rows.map((r) => [r.vp.name, r]))('%s: the map container keeps >= 70 % of the panel height (>= 180 px at 1536 x 750)', (name, { m }) => {
    const share = m.map.height / m.cell.height;
    console.log(`${name}: panel ${m.cell.width.toFixed(0)} x ${m.cell.height.toFixed(0)}, header ${m.header.height.toFixed(1)} px (one row), `
      + `map ${m.map.width.toFixed(0)} x ${m.map.height.toFixed(0)} = ${(100 * share).toFixed(1)} % of the panel height; `
      + `toolbar ${m.toolbar.buttons} buttons ${m.toolbar.width} px, header row ${m.headerRow.needed.toFixed(1)} of ${m.headerRow.available.toFixed(1)} px`);
    expect(m.controls.layers).toBe('popover');
    expect(share).toBeGreaterThanOrEqual(0.7);
    if (name === '1536x750') expect(m.map.height).toBeGreaterThanOrEqual(180);
  });

  it.skipIf(!haveFormula1).each(rows.map((r) => [r.vp.name, r]))('%s: the header is one row: title, key, toolbar and export fit the panel width', (name, { m }) => {
    expect(m.headerRow.needed).toBeLessThanOrEqual(m.headerRow.available);
  });

  it('before Phase 9d: the controls in one wrapped header row left the map 34 px of the 263 px panel at 1536 x 750', () => {
    // the browser's numbers: .panel-controls 181 px tall, the map 354 x 34
    const m = rows.find((r) => r.vp.name === '1536x750').m;
    const oldMap = m.cell.height - 2 * 2 - (m.header.pad.top + 181 + m.header.pad.bottom + 1) - 2 * px(css, '--spacing-md', VIEWPORTS[0]);
    expect(oldMap).toBeLessThan(40);
    expect(oldMap / m.cell.height).toBeLessThan(0.15);
  });

  it('controls choice and toolbar widths (trackMapLayout.js)', () => {
    expect(trackMapControls({ width: 0, height: 0 })).toEqual({ layers: 'popover', rotateTools: false });
    expect(trackMapControls({ width: ROTATE_TOOLS_MIN_W, height: LAYERS_INLINE_MIN_H })).toEqual({ layers: 'inline', rotateTools: true });
    expect(toolbarWidth(4, 1)).toBe(4 * TOOL_PX + 1 + 4 * 4);
    expect(toolbarLayout({ layers: 'popover', rotateTools: false })).toEqual({ buttons: 4, separators: 1, width: 113 });
    expect(toolbarLayout({ layers: 'inline', rotateTools: true })).toEqual({ buttons: 6, separators: 1, width: 6 * 24 + 1 + 6 * 4 });
    // the drawing margin follows the box: 28 px in the Pit Wall map, 70 px in a big one, never over a quarter
    expect(mapDrawPadding(366, 203)).toBe(28);
    expect(mapDrawPadding(1100, 620)).toBe(70);
    expect(mapDrawPadding(60, 48)).toBe(12);
  });
});

describe('the mounted Track Map in its Pit Wall cell (mini DOM): the model\'s layout', () => {
  beforeAll(() => sessionState());
  afterAll(() => useF1Store.setState({ ...INITIAL }));

  for (const vp of VIEWPORTS) {
    it(`${vp.name}: one header row of the modelled buttons, the map alone in the content, the layers in the popover`, async () => {
      const m = trackMapPanelAt(css, SRC, vp);
      const v = await mountInCell(m);
      try {
        // the panel: dense, the header's controls = the toolbar + the export button
        expect(v.host.querySelector('.panel').getAttribute('class')).toMatch(/\bpanel--dense\b/);
        const controls = v.host.querySelector('.panel-controls');
        expect([...controls.children].map((el) => el.getAttribute('class') || el.localName)).toEqual(['track-map-toolbar', 'panel-export-btn']);
        const bar = v.toolbar();
        expect(bar.style.flexWrap).toBe('nowrap');
        expect(bar.getAttribute('role')).toBe('toolbar');
        // the buttons the model counts, each TOOL_PX square, each named
        const tools = v.tools();
        expect(tools).toHaveLength(m.toolbar.buttons);
        for (const b of tools) {
          expect(b.style.width).toBe(`${TOOL_PX}px`);
          expect(b.style.height).toBe(`${TOOL_PX}px`);
          expect(b.getAttribute('aria-label')).toBeTruthy();
          expect(b.getAttribute('title')).toBe(b.getAttribute('aria-label'));
        }
        const seps = [...bar.children].filter((el) => el.getAttribute('aria-hidden') === 'true');
        expect(seps).toHaveLength(m.toolbar.separators);
        expect(tools.some((b) => /^Rotate clockwise/.test(b.getAttribute('title')))).toBe(m.controls.rotateTools);
        // no layer toggle, channel button or legend in the header
        expect(text(v.host.querySelector('.panel-header .panel-controls'))).toBe('');
        // the content holds the map only (the key lies over it, absolutely placed)
        expect([...v.content.children]).toEqual([v.viz]);
        expect(v.host.querySelector('.track-map-layers--inline')).toBeNull();
        // the key of what is drawn: S1-S3 and the DRS zone, on one line of the map's width
        const keyItems = [...v.key().querySelectorAll('.legend-item')].map(text);
        expect(keyItems).toEqual(['S1', 'S2', 'S3', 'DRS zone']);
        if (haveFormula1) {
          const label = px(css, '--font-size-label', vp);
          const xs = px(css, '--spacing-xs', vp);
          const swatch = { S1: 18, S2: 18, S3: 18, 'DRS zone': 14 };
          const w = keyItems.reduce((a, t) => a + 2 * xs + swatch[t] + 4 + textWidth(t, label, 400), 0) + (keyItems.length - 1) * xs + 8;
          expect(w).toBeLessThanOrEqual(m.map.width - 12);
        }
        // the map is laid out in the content box
        const svg = v.viz.querySelector('svg');
        expect(svg.getAttribute('viewBox')).toBe(`0 0 ${Math.floor(m.content.width)} ${Math.floor(m.content.height)}`);
      } finally {
        await v.unmount();
      }
    });
  }

  it('1536x750: the Layers popover has the toggles, the overlay, the key and the drivers; Escape closes it', async () => {
    const m = trackMapPanelAt(css, SRC, VIEWPORTS.find((x) => x.name === '1536x750'));
    const v = await mountInCell(m);
    try {
      const btn = v.layersBtn();
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
      await click(btn);
      const pop = v.popover();
      expect(pop).not.toBeNull();
      expect(btn.getAttribute('aria-expanded')).toBe('true');
      expect(btn.getAttribute('aria-controls')).toBe('track-map-layers');
      expect(pop.getAttribute('role')).toBe('dialog');
      const groups = [...pop.querySelectorAll('.track-map-layers__group')].map((g) => g.getAttribute('aria-label'));
      expect(groups).toEqual(['Orientation', 'Layers', 'Overlay', 'Key', 'Drivers']);
      const buttons = [...pop.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || text(b));
      for (const name of ['Rotate clockwise (R)', 'Rotate counter-clockwise (Shift+R)', 'Reset to default orientation',
        'S1', 'S2', 'S3', 'DRS', 'Corners', 'SPD', 'THR', 'BRK']) expect(buttons).toContain(name);
      expect(pop.querySelectorAll('.track-map-layers__group[aria-label="Drivers"] .legend-item')).toHaveLength(8);
      // S1 off from the popover: the toggle and the key on the map follow
      const s1 = [...pop.querySelectorAll('button')].find((b) => text(b) === 'S1');
      expect(s1.getAttribute('aria-pressed')).toBe('true');
      await click(s1);
      expect(s1.getAttribute('aria-pressed')).toBe('false');
      expect([...v.key().querySelectorAll('.legend-item')].map(text)).toEqual(['S2', 'S3', 'DRS zone']);
      await click(s1);
      // Escape closes; the Layers button again closes / opens
      await keydown('Escape');
      expect(v.popover()).toBeNull();
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      await click(btn);
      expect(v.popover()).not.toBeNull();
      await click(btn);
      expect(v.popover()).toBeNull();
    } finally {
      await v.unmount();
    }
  });

  it('a 2026 session (no DRS): the popover has no DRS toggle, the key no DRS zone', async () => {
    useF1Store.setState({ loadedYear: 2026, loadedRound: 1, loadedSessionType: 'R' });
    const m = trackMapPanelAt(css, SRC, VIEWPORTS.find((x) => x.name === '1536x750'));
    const v = await mountInCell(m);
    try {
      expect([...v.key().querySelectorAll('.legend-item')].map(text)).toEqual(['S1', 'S2', 'S3']);
      await click(v.layersBtn());
      const names = [...v.popover().querySelectorAll('button')].map(text);
      expect(names).toContain('Corners');
      expect(names).not.toContain('DRS');
      await keydown('Escape');
    } finally {
      await v.unmount();
      useF1Store.setState({ loadedYear: null, loadedRound: null, loadedSessionType: null });
    }
  });

  it('a tall panel (content >= LAYERS_INLINE_MIN_H): the layers are a strip above the map, no Layers button, no key overlay', async () => {
    const m = trackMapPanelAt(css, SRC, VIEWPORTS.find((x) => x.name === '1920x1080'));
    const tall = {
      ...m,
      cell: { width: 900, height: 760 },
      content: { width: 900 - 6 - 16, height: 760 - 6 - m.header.height - 16 },
    };
    expect(tall.content.height).toBeGreaterThanOrEqual(LAYERS_INLINE_MIN_H);
    const v = await mountInCell(tall);
    try {
      expect(v.host.querySelector('.track-map-layers--inline')).not.toBeNull();
      expect(v.layersBtn()).toBeNull();
      expect(v.key()).toBeNull();
      expect(v.tools()).toHaveLength(toolbarLayout(trackMapControls(tall.content)).buttons);
      const strip = v.host.querySelector('.track-map-layers--inline');
      expect([...strip.querySelectorAll('.track-map-layers__group')].map((g) => g.getAttribute('aria-label')))
        .toEqual(['Layers', 'Overlay', 'Key', 'Drivers']);
    } finally {
      await v.unmount();
    }
  });
});
