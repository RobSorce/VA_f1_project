// Strategy Simulator (components/visualizations/StrategySimulator.jsx):
//  - the plan and the actual strategy are D3 stint strips
//    (utils/views/stintStripChart.js) on a lap axis with the lap in progress
//    marked; every segment carries its compound letter (black or white by
//    contrast), never colour alone;
//  - the result draws the custom plan and the baseline on one D3 position
//    axis (utils/views/positionRangeChart.js) with a legend; the verdict is in
//    the diverging pair (blue ▲ / orange ▼, • no clear change), never green /
//    red;
//  - no scroll: Plan / Result / Compare tabs, each fitted to the panel, the
//    stint rows and the saved plans paged when they do not fit;
//  - no colour literal, no fixed pixel font size in the panel.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installMiniDom } from './helpers/miniDom.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

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
// The Result tab's sections measure their own height (miniDom reports the
// nearest ancestor's rect otherwise, so every section would be the panel's
// height and fitBlocks would keep only the verdict)
const SECTION_H = { cards: 70, ranges: 110, verdict: 40, note: 36 };
const baseRect = El.prototype.getBoundingClientRect;
El.prototype.getBoundingClientRect = function rect() {
  const r = baseRect.call(this);
  const cls = (this.getAttribute?.('class') || '').split(/\s+/);
  for (const key of Object.keys(SECTION_H)) {
    if (cls.includes(`sim-result__${key}`)) return { ...r, height: SECTION_H[key], bottom: r.top + SECTION_H[key] };
  }
  return r;
};
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const {
  DIVERGING, CHART_FONT, tyreColor, contrastText, TYRE_LABELS,
} = await import('../utils/colors.js');
const { stintSegments, lapTicks } = await import('../utils/views/stintStripChart.js');
const { verdictMark } = await import('../utils/views/strategyMarks.js');
const { whatIfMarksOf } = await import('../utils/simulationClient.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { default: StrategySimulator } = await import('../components/visualizations/StrategySimulator.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/StrategySimulator.jsx');
const INITIAL = useF1Store.getState();
const HAVE = hasCachedSession(2024, 16);
const monza = HAVE ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;
const store = () => useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function monzaAt(currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R', loadedYear: 2024, loadedRound: 16,
    sessionData: monza, trackStatus: monza.track_status || [], sessionTimeOffset: offset,
    maxLap: MAX_LAP, totalRaceLaps: null, currentLap, totalFrames: 0, currentTime: 0, isLiveMode: false,
    raceSituationData: extractRaceSituationFeatures({ lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: offset }),
    ...extra,
  });
}
const stints = (...list) => list.map(([compound, lapStart], i) => ({
  compound, lapStart, length: (list[i + 1]?.[1] ?? MAX_LAP + 1) - lapStart,
}));

async function mount(width = 460, height = 560) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(StrategySimulator)); });
  return {
    host,
    tab: (name) => [...host.querySelectorAll('[role="tab"]')].find((b) => text(b).startsWith(name)),
    async click(el) { await act(async () => { dom.mouse(el, 'click'); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('stint strip helpers (pure)', () => {
  it('segments from lap starts or lengths; lap ticks', () => {
    expect(stintSegments([{ compound: 'SOFT', length: 10 }, { compound: 'HARD', length: 43 }]))
      .toEqual([{ key: '0', start: 1, length: 10, compound: 'SOFT' }, { key: '1', start: 11, length: 43, compound: 'HARD' }]);
    expect(stintSegments([{ compound: 'MEDIUM', lapStart: 5, length: 3 }])[0]).toMatchObject({ start: 5, length: 3 });
    expect(lapTicks(53)).toEqual([1, 10, 20, 30, 40, 50, 53]);
  });
});

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('D3 strips and position ranges; no scroll, no colour literal, no fixed pixel font, no percentage div bars', () => {
    expect(src).toMatch(/drawStintStrips\(/);
    expect(src).toMatch(/drawPositionRanges\(/);
    expect(src).toMatch(/drawLegend\(/);
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba\(\s*\d/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/(width|left):\s*`\$\{[^}]*\}%`/);
  });
});

describe.skipIf(!HAVE)('the simulator panel, Monza 2024 lap 12, LEC', () => {
  it('plan tab: the custom plan and the actual strategy as D3 stint strips with letters, lap axis, lap marker', async () => {
    const plan = stints(['MEDIUM', 1], ['HARD', 26]);
    monzaAt(12, { focusDriver: 'LEC', simulatorStrategy: { driver: 'LEC', stints: plan } });
    const view = await mount();
    expect(view.tab('Plan').getAttribute('aria-selected')).toBe('true');
    const svg = view.host.querySelector('svg.sim-strips-svg');
    expect(svg).toBeTruthy();
    const rows = [...svg.querySelectorAll('g.strip-row')];
    expect(rows.map((g) => g.getAttribute('data-key'))).toEqual(['custom', 'actual']);
    const segs = [...rows[0].querySelectorAll('g.strip-seg')];
    expect(segs.map((g) => [g.getAttribute('data-compound'), Number(g.getAttribute('data-length'))]))
      .toEqual(plan.map((s) => [s.compound, s.length]));
    for (const g of svg.querySelectorAll('g.strip-seg')) {
      const c = g.getAttribute('data-compound');
      expect(g.querySelector('rect').getAttribute('fill')).toBe(tyreColor(c));
      const label = text(g.querySelector('text'));
      if (label) {
        expect(label.startsWith(TYRE_LABELS[c])).toBe(true);
        expect(g.querySelector('text').getAttribute('fill')).toBe(contrastText(tyreColor(c)));
      }
      expect(g.querySelector('text').style['font-size']).toBe(CHART_FONT.data);
    }
    // the plan's segments are wide enough to carry their letter here
    for (const g of segs) expect(text(g.querySelector('text'))).not.toBe('');
    expect([...svg.querySelectorAll('g.strip-axis .tick text')].map(text)[0]).toBe('L1');
    expect(Number(svg.querySelector('line.strip-marker').getAttribute('data-value'))).toBe(12.5);
    // stint editor rows, compound buttons with letters
    const editRows = [...view.host.querySelectorAll('.sim-stint-row')];
    expect(editRows).toHaveLength(2);
    expect([...editRows[0].querySelectorAll('[role="radio"]')].map(text)).toEqual(['S', 'M', 'H']);
    // no scroll container
    const all = [view.host, ...view.host.querySelectorAll('*')];
    expect(all.filter((el) => /auto|scroll/.test(`${el.style.overflow || ''}${el.style.overflowY || ''}${el.style['overflow-y'] || ''}`))).toEqual([]);
    await view.unmount();
  });

  it('result tab: cards, the two distributions on one D3 position axis with legend, the verdict in the diverging pair', async () => {
    const plan = stints(['MEDIUM', 1], ['HARD', 26]);
    monzaAt(12, { focusDriver: 'LEC', simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: null });
    store().runSimulation();
    const r = store().simulatorResult;
    expect(r).toBeTruthy();
    const view = await mount();
    // a result opens on the Result tab
    expect(view.tab('Result').getAttribute('aria-selected')).toBe('true');
    const svg = view.host.querySelector('svg.sim-ranges-svg');
    const rows = [...svg.querySelectorAll('g.mcr-row')];
    expect(rows.map((g) => g.getAttribute('data-key'))).toEqual(['custom', 'baseline']);
    const marks = whatIfMarksOf(r);
    expect(Number(rows[0].querySelector('path.mcr-shown').getAttribute('data-pos'))).toBe(marks.shown.custom);
    expect(Number(rows[1].querySelector('path.mcr-shown').getAttribute('data-pos'))).toBe(marks.shown.baseline);
    // a plan has no current-position marker
    expect(svg.querySelectorAll('path.mcr-now')).toHaveLength(0);
    expect(svg.querySelector('g.mcr-axis').style['font-size']).toBe(CHART_FONT.data);
    expect([...view.host.querySelectorAll('svg.sim-ranges-legend .chart-legend__item')].map(text))
      .toEqual(['share of runs per position', 'P5–P95', 'P label (median)']);
    // the verdict: glyph and colour of verdictMark (blue / orange / neutral)
    const body = text(view.host);
    const vm = verdictMark(marks.verdict);
    expect(body).toContain(marks.verdict > 0 ? 'PLACES GAINED' : marks.verdict < 0 ? 'PLACES LOST' : 'NO CLEAR CHANGE');
    expect(body).toContain(`${vm.glyph} `);
    expect([DIVERGING.better, DIVERGING.worse, DIVERGING.neutral]).toContain(vm.color);
    expect((body.match(/% podium/g) || []).length).toBe(2);
    await view.unmount();
  });

  it('compare tab: saved plans as a table with D3 strips; paged when the panel is short', async () => {
    const plan = stints(['MEDIUM', 1], ['HARD', 26]);
    monzaAt(12, { focusDriver: 'LEC', simulatorStrategy: { driver: 'LEC', stints: plan } });
    store().runSimulation();
    const r = store().simulatorResult;
    const saved = Array.from({ length: 12 }, (_, i) => ({ label: `P${i}`, stints: plan, result: r }));
    useF1Store.setState({ simulatorComparisons: saved });
    const view = await mount(460, 300);
    await view.click(view.tab('Compare'));
    const table = view.host.querySelector('.sim-compare');
    expect(table).toBeTruthy();
    const rowsShown = table.querySelectorAll('[role="row"]').length;
    expect(rowsShown).toBeGreaterThan(0);
    expect(rowsShown).toBeLessThan(saved.length);
    expect(table.querySelectorAll('svg.sim-compare-strip g.strip-seg').length).toBe(rowsShown * plan.length);
    expect(text(table.querySelector('.sim-pager'))).toContain(`plans 1–${rowsShown} of ${saved.length}`);
    await view.unmount();
  });
});
