// The Strategy Simulator's verdict (places gained / lost, its ± and the
// podium and points changes) stays on screen in the Simulator preset.
//
// The browser pass found the verdict below the visible part of the panel at
// 1536 x 864: the Result tab stacked its header line, the two P label cards,
// the finishing distributions, the verdict and the run note in an overflow
// hidden column of 173 px, so the column ended before the verdict began
// (and cut the distributions' baseline row). Now the sections under the
// header line are fitted to the height left (chartBox fitBlocks): each whole
// or given up whole, the verdict always kept, the ones given up named in a
// "+N" of the header line; no text gets smaller.
//
// The column is modelled at each target viewport: the Simulator pane of the
// preset (helpers/layoutModel.js), the panel's chrome (components.css .panel
// border, header padding var(--spacing-sm) around the 22 px export button,
// content padding var(--spacing-md)) and the panel's own rows from the type
// sizes at the viewport (the label and data tokens, line-height 1.4 of the
// body, Inter's line-height: normal for buttons and the select). Checked
// against Chrome on the demo build (2024 R16, lap 31, LEC): result column
// 148.1 / 101.8 / 294.3 px at 1536 x 864 / 1536 x 750 / 2048 x 1152, the
// model's 148.1 / 102.9 / 294.3 (Chrome draws the select 1 px taller at
// 1536 x 750), the sections within 0.1 px.
import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { loadCss, px, dockedPanesAt } from './helpers/layoutModel.js';
import { haveWebFont, textWidth, lineHeight } from './helpers/fontWidths.js';

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
// the driver <select>: the properties React reads from it
const El = dom.window.Element;
const accessor = (name, get) => {
  if (!(name in El.prototype)) {
    Object.defineProperty(El.prototype, name, {
      get, set(v) { this[`_${name}`] = v; }, configurable: true,
    });
  }
};
accessor('options', function options() { return this.localName === 'select' ? this.querySelectorAll('option') : undefined; });
accessor('value', function value() { return this._value ?? this.getAttribute('value') ?? ''; });
accessor('selected', function selected() { return !!this._selected; });
accessor('defaultSelected', function defaultSelected() { return !!this._defaultSelected; });
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.els = new Set(); observers.add(this); }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  disconnect() { this.els.clear(); observers.delete(this); }
};
// The sections' heights at the viewport under test (the panel measures them)
let SECTION_H = {};
const has = (el, c) => (el.getAttribute?.('class') || '').split(/\s+/).includes(c);
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
const baseRect = ElementProto.getBoundingClientRect;
ElementProto.getBoundingClientRect = function rect() {
  const r = baseRect.call(this);
  for (const key of ['cards', 'ranges', 'verdict', 'note']) {
    if (has(this, `sim-result__${key}`)) return { ...r, height: SECTION_H[key], bottom: r.top + SECTION_H[key] };
  }
  return r;
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { CHART_FONT, FONT_FLOOR_PX } = await import('../utils/colors.js');
const { fitBlocks } = await import('../utils/views/chartBox.js');
const { POSITION_AXIS_H } = await import('../utils/views/positionRangeChart.js');
const { WINDOW_PRESETS } = await import('../utils/windowPresets.js');
const { default: StrategySimulator } = await import('../components/visualizations/StrategySimulator.jsx');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = loadCss(SRC);
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const GAP = 6;

const VIEWPORTS = [
  { name: '1536x864', W: 1536, H: 864 },
  { name: '1536x750', W: 1536, H: 750 },
  { name: '2048x1152', W: 2048, H: 1152 },
];
const NOTE = '1,000 sims at L31, both runs on the same random numbers: an identical plan differs by exactly 0.';

/** The Simulator panel at a viewport: its rows and the Result tab's sections (px). */
function simulatorAt(vp) {
  const pane = dockedPanesAt(css, WINDOW_PRESETS.simulator.dockedLayout, vp).find((p) => p.tabs.includes('simulator'));
  const rem = px(css, '1rem', vp);
  const L = Math.max(FONT_FLOOR_PX.label, px(css, '--font-size-label', vp));
  const D = Math.max(FONT_FLOOR_PX.data, px(css, '--font-size-data', vp));
  // line-height: normal of Inter, in whole px as Chrome lays a line out
  const normal = (size) => Math.round(lineHeight(size));
  const header = px(css, '--spacing-sm', vp) * 2 + 22 + 1;
  const sim = {
    width: pane.width - 2 - 2 * px(css, '--spacing-md', vp),
    height: pane.height - 2 - header - 2 * px(css, '--spacing-md', vp),
  };
  // driver line: 4 px padding around the select (2 px padding, 1 px border,
  // 2 px more of Chrome's own); tab and Clear buttons: 3 px padding, 1 px
  // border (the tab line 4 px padding and a 1 px rule more)
  const driverRow = 8 + 8 + normal(D);
  const tabsRow = 8 + normal(L) + 5;
  const clearRow = 8 + normal(L);
  const body = sim.height - driverRow - tabsRow - clearRow - 3 * GAP;
  const resultHeader = Math.max(1.4 * D, 6 + normal(L));
  const noteLines = haveWebFont ? Math.ceil(textWidth(NOTE, L) / sim.width) : 2;
  return {
    pane,
    sim,
    body,
    result: body - resultHeader - GAP,
    sections: {
      header: resultHeader,
      // label, P (--font-size-lg), avg and range, podium and points; 2 + 2 px
      // margins, 4 px padding, the 2 px accent
      cards: 3 * 1.4 * L + 1.4 * px(css, '--font-size-lg', vp) + 4 + 8 + 2,
      // legend line (drawLegend) + 2, the axis and two rows
      ranges: Math.round(D * 1.45) + 2 + POSITION_AXIS_H + 2 * Math.max(20, Math.round(D * 2)),
      // 4 px padding; the difference (at the data size: --font-size-md is no
      // token), its ± and the verdict word; beside them the podium and points rows
      verdict: 8 + Math.max(1.4 * D + 2 * 1.4 * L, 2 * 1.5 * D),
      note: noteLines * 1.4 * L,
    },
  };
}

const RESULT = {
  simProjection: {
    expectedPos: 3.9, posRange: [2, 6], podiumProb: 40, pointsProb: 100, posCount: { 2: 150, 3: 250, 4: 300, 5: 200, 6: 100 },
  },
  baselineProjection: {
    expectedPos: 2.8, posRange: [1, 5], podiumProb: 72, pointsProb: 100, posCount: { 1: 200, 2: 300, 3: 250, 4: 150, 5: 100 },
  },
  delta: { position: -1.1, podium: -32, points: 0 },
  paired: {
    position: { mean: -1.1, sd: 2.4, n: 1000 },
    podium: { mean: -0.32, sd: 0.5, n: 1000 },
    points: { mean: 0, sd: 0, n: 1000 },
  },
  marks: { verdict: -1, shown: { custom: 4, baseline: 3 }, podium: -1, points: 0 },
  numSimulations: 1000,
  computedAtLap: 31,
  baselineLabel: null,
};
const DRIVERS = Array.from({ length: 20 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);

async function mountAt(model) {
  useF1Store.setState({
    ...INITIAL,
    sessionData: null, focusDriver: 'D01', selectedDrivers: [], currentLap: 31, maxLap: 53, totalRaceLaps: 53,
    raceSituationData: { driverAbbrs: DRIVERS }, simulatorResult: RESULT, simulatorComparisons: [], isSimulatorActive: true,
  });
  SECTION_H = model.sections;
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: model.sim.width, height: model.sim.height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(StrategySimulator)); });
  // the result column gets its box from the layout
  const column = host.querySelector('.sim-result');
  if (column) {
    const box = { width: model.sim.width, height: model.result };
    dom.setRect(column, { left: 0, top: 0, ...box });
    await act(async () => {
      for (const o of observers) if (o.els.has(column)) o.cb([{ target: column, contentRect: box }]);
    });
  }
  return {
    host,
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

/** The Result tab's sections on screen, in order: header, cards, ranges, verdict, note. */
function sectionsOf(host) {
  const body = host.querySelector('.sim').children[2];
  const kind = (el) => {
    const t = text(el);
    if (/^Simulation Results/.test(t)) return 'header';
    if (el.matches('.sim-ranges') || el.querySelector('.sim-ranges')) return 'ranges';
    if (/PLACES (GAINED|LOST)|NO CLEAR CHANGE/.test(t)) return 'verdict';
    if (/Custom Strategy/i.test(t)) return 'cards';
    if (/sims at L/.test(t)) return 'note';
    return 'other';
  };
  const out = [];
  const visit = (el) => {
    for (const c of el.children) {
      if (has(c, 'sim-result')) visit(c);
      else out.push({ kind: kind(c), el: c });
    }
  };
  visit(body);
  return out;
}

/** Top and bottom of each section stacked from the top of the tab's body (6 px gaps). */
function stack(sections, heights) {
  let y = 0;
  return sections.map((s) => {
    const top = y;
    y = top + heights[s.kind] + GAP;
    return { ...s, top, bottom: top + heights[s.kind] };
  });
}

afterAll(() => { useF1Store.setState({ ...INITIAL }); observers.clear(); });

describe('fitBlocks (utils/views/chartBox.js)', () => {
  const blocks = (h) => [
    { key: 'a', priority: 1, height: h.a }, { key: 'b', priority: 2, height: h.b },
    { key: 'v', priority: 0, height: h.v }, { key: 'n', priority: 3, height: h.n },
  ];
  it('keeps blocks by priority while they fit, each whole; a smaller one after a too-tall one still fits', () => {
    const r = fitBlocks(165, blocks({ a: 80, b: 85, v: 54, n: 15 }), 6);
    expect([...r.shown].sort()).toEqual(['a', 'n', 'v']);
    expect(r.hidden).toEqual(['b']);
    expect(fitBlocks(400, blocks({ a: 80, b: 85, v: 54, n: 15 }), 6).hidden).toEqual([]);
  });
  it('the first in priority is kept at any height; an unknown height (column or block) keeps the block', () => {
    expect([...fitBlocks(20, blocks({ a: 80, b: 85, v: 54, n: 15 }), 6).shown]).toEqual(['v']);
    expect(fitBlocks(0, blocks({ a: 80, b: 85, v: 54, n: 15 }), 6).hidden).toEqual([]);
    expect(fitBlocks(100, blocks({ a: 0, b: 85, v: 54, n: 15 }), 6).shown.has('a')).toBe(true);
  });
});

describe('the Simulator preset: the verdict on screen, no section cut', () => {
  // The sections Chrome shows at each viewport (the demo build, see above)
  const SHOWN = {
    '1536x864': ['header', 'cards', 'verdict'],
    '1536x750': ['header', 'verdict', 'note'],
    '2048x1152': ['header', 'cards', 'ranges', 'verdict', 'note'],
  };
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: the verdict whole inside the Result tab, every section shown whole, the others named`, async () => {
      const model = simulatorAt(vp);
      const v = await mountAt(model);
      try {
        const heights = { ...model.sections, other: 0 };
        const laid = stack(sectionsOf(v.host), heights);
        const verdict = laid.find((s) => s.kind === 'verdict');
        expect(verdict, 'verdict rendered').toBeTruthy();
        expect(verdict.bottom, `verdict ends at ${verdict.bottom.toFixed(1)} of ${model.body.toFixed(1)} px`).toBeLessThanOrEqual(model.body);
        for (const s of laid) expect(s.bottom, `${s.kind} cut`).toBeLessThanOrEqual(model.body);
        expect(laid.map((s) => s.kind)).toEqual(SHOWN[vp.name]);
        // the sections given up, named in the header line
        const gone = ['cards', 'ranges', 'note'].filter((k) => !SHOWN[vp.name].includes(k));
        const chip = v.host.querySelector('.sim-result__hidden');
        if (gone.length === 0) {
          expect(chip).toBeNull();
        } else {
          expect(text(chip)).toBe(`+${gone.length}`);
          const names = { cards: 'the P label cards', ranges: 'the finishing distributions', note: 'the run note' };
          expect(chip.getAttribute('title')).toBe(`Hidden for the pane's height: ${gone.map((k) => names[k]).join(', ')}. Enlarge the pane to show them.`);
        }
        // nothing got smaller: every text size of the tab is a type token
        const sizes = laid.flatMap((s) => [s.el, ...s.el.querySelectorAll('*')]).map((el) => el.style?.fontSize).filter(Boolean);
        for (const fs of sizes) expect([CHART_FONT.label, CHART_FONT.data, 'var(--font-size-lg)', 'var(--font-size-md)']).toContain(fs);
      } finally {
        await v.unmount();
      }
    });
  }

  it('"vs model stops" stays in the header line when a saved plan is the baseline', async () => {
    const v = await mountAt(simulatorAt(VIEWPORTS[1]));
    try {
      await act(async () => { useF1Store.setState({ simulatorBaseline: { label: 'M-H', stints: [] } }); });
      const header = sectionsOf(v.host).find((s) => s.kind === 'header').el;
      const button = [...header.querySelectorAll('button')].find((b) => text(b) === 'vs model stops');
      expect(button).toBeTruthy();
      await act(async () => { dom.mouse(button, 'click'); });
      expect(useF1Store.getState().simulatorBaseline).toBeNull();
    } finally {
      await v.unmount();
    }
  });
});
