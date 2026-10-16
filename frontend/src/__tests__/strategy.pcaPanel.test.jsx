// Cross-Race Analysis (components/visualizations/PCAAnalysisPanel.jsx):
//  - the forest plot is drawn by D3 (utils/views/pcaForestChart.js): one strip
//    per feature on a shared g axis drawn by d3-axis above the rows, with a D3
//    legend naming the marks;
//  - the strategy patterns are D3 stint strips with the compound letter;
//  - no scroll: the Differences rows (once overflow-y: auto) and the patterns
//    are fitted to the panel and paged;
//  - "above random" is a label as well as the accent colour (palette, no
//    literal); no fixed pixel font size.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installMiniDom } from './helpers/miniDom.js';

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
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { CHART_FONT, tyreColor, contrastText } = await import('../utils/colors.js');
const { forestTicks, forestTickLabel, FOREST_W } = await import('../utils/views/pcaForestChart.js');
const { forestHalfWidth, selectionRows, forestX } = await import('../utils/views/pcaSelection.js');
const { default: PCAAnalysisPanel } = await import('../components/visualizations/PCAAnalysisPanel.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/PCAAnalysisPanel.jsx');
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

const feature = (i, g, above = false) => ({
  feature: `f${i}`, label: `Feature ${i}`, unit: '', selected_mean: g, rest_mean: 0, g, abs_g: Math.abs(g), effect_size: Math.abs(g),
  ci_low: g - 0.8, ci_high: g + 0.8, n_selected: 5, n_rest: 529, baseline_abs_g: 0.36, baseline_abs_g_p95: 0.9,
  exceeds_random: above, direction: g < 0 ? 'lower' : 'higher', magnitude: 'large',
});
const SELECTION = ['NOR_2025_8', 'LEC_2025_8', 'PIA_2025_8', 'NOR_2025_1', 'VER_2025_8'];
const ANSWER = {
  summary: 'Selection of 5 race entries.',
  cluster_label: 'Fast sectors',
  n_selected: 5,
  n_rest: 529,
  n_total: 534,
  statistics: {
    label: 'Descriptive differences, not a test',
    effect_size: "Hedges' g",
    interval: '95% normal-approximation interval of g',
    min_group_for_interval: 2,
    baseline: '|g| of 1000 random selections of 5 rows',
    baseline_max_abs_g_p95: 1.399,
    note: 'Descriptive.',
  },
  feature_importance: Array.from({ length: 12 }, (_, i) => feature(i, (i % 2 ? -1 : 1) * (3.2 - i * 0.25), i === 0)),
  strategies: Array.from({ length: 6 }, (_, i) => ({
    stints: [
      { compound: 'MEDIUM', lap_start: 1, length: 19 + i },
      { compound: 'HARD', lap_start: 20 + i, length: 33 - i },
    ],
    frequency: 0.4 - i * 0.05,
    count: 6 - i,
  })),
  common_patterns: [{ compound: 'MEDIUM', avg_stint_length: 27.8, count: 5, total_laps: 139 }],
  pit_windows: [{ lap_start: 19, lap_end: 22, count: 3, median_lap: 20 }],
};

async function mount(width = 420, height = 300) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(PCAAnalysisPanel)); });
  const buttons = () => [...host.querySelectorAll('button')];
  return {
    host,
    async open(name) {
      const b = buttons().find((x) => text(x).startsWith(name));
      expect(b, `tab ${name}`).toBeTruthy();
      await act(async () => { dom.mouse(b, 'click'); });
    },
    async click(el) { await act(async () => { dom.mouse(el, 'click'); }); },
    button: (label) => buttons().find((b) => b.getAttribute('aria-label') === label),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}
const noScroll = (host) => [host, ...host.querySelectorAll('*')]
  .filter((el) => /auto|scroll/.test(`${el.style.overflow || ''}${el.style.overflowY || ''}${el.style['overflow-y'] || ''}`));

describe('forest axis helpers (pure)', () => {
  it('ticks at the ends, halves and 0; signed labels', () => {
    expect(forestTicks(4.5)).toEqual([-4.5, -2.25, 0, 2.25, 4.5]);
    expect(forestTickLabel(-4.5)).toBe('−4.5');
    expect(forestTickLabel(2)).toBe('+2');
    expect(forestTickLabel(0)).toBe('0');
  });
});

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('D3 forest and strips; no scroll, no colour literal, no fixed pixel font, no percentage div bars', () => {
    expect(src).toMatch(/drawForestStrip\(/);
    expect(src).toMatch(/drawForestAxis\(/);
    expect(src).toMatch(/drawStintStrips\(/);
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba\(\s*\d/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/(width|left):\s*`\$\{[^}]*\}%`/);
    expect(src).not.toMatch(/tsne/i);
  });
});

describe('the panel, a short box (420 x 300)', () => {
  it('differences: rows paged (no scroll), the g axis drawn by D3, the legend', async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: SELECTION, pcaStrategyAnalysis: ANSWER, pcaAnalysisIds: SELECTION });
    const view = await mount();
    await view.open('Differences');
    const rows = () => [...view.host.querySelectorAll('.pca-forest-row')].map((r) => text(r.querySelector('[role="cell"]')));
    const first = rows();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(12);
    // the pager walks every feature
    const seen = [...first];
    for (let guard = 0; guard < 12; guard++) {
      const next = view.button('Next features');
      if (!next || next.hasAttribute('disabled')) break;
      await view.click(next);
      seen.push(...rows());
    }
    expect(seen.map((t) => t.replace('above random', ''))).toEqual(ANSWER.feature_importance.map((f) => f.label));
    // the axis: d3-axis ticks at the font token, on the strips' scale
    const half = forestHalfWidth(selectionRows(ANSWER), 1.399);
    const axis = view.host.querySelector('svg.pca-forest-axis-svg');
    expect([...axis.querySelectorAll('.tick text')].map(text)).toEqual(forestTicks(half).map(forestTickLabel));
    expect(axis.querySelector('g.pca-forest-axis').style['font-size']).toBe(CHART_FONT.data);
    // a strip's g tick on the forestX scale (user units)
    const r0 = view.host.querySelector('.pca-forest-row');
    expect(r0).toBeTruthy();
    const legend = [...view.host.querySelectorAll('svg.pca-forest-legend .chart-legend__item')].map(text);
    expect(legend).toHaveLength(5);
    expect(legend[1]).toMatch(/interval/);
    expect([legend[0], ...legend.slice(2)]).toEqual(["Hedges' g", 'random |g| (shaded)', 'threshold (dashed)', 'above random (labelled)']);
    expect(Number.isFinite(forestX(0, half, FOREST_W))).toBe(true);
    expect(noScroll(view.host)).toEqual([]);
    await view.unmount();
  });

  it('patterns: D3 stint strips with letters, paged', async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: SELECTION, pcaStrategyAnalysis: ANSWER, pcaAnalysisIds: SELECTION });
    const view = await mount();
    await view.open('Patterns');
    const strips = [...view.host.querySelectorAll('svg.pca-pattern-strip')];
    expect(strips.length).toBeGreaterThan(0);
    expect(strips.length).toBeLessThan(ANSWER.strategies.length);
    for (const svg of strips) {
      for (const g of svg.querySelectorAll('g.strip-seg')) {
        const c = g.getAttribute('data-compound');
        expect(g.querySelector('rect').getAttribute('fill')).toBe(tyreColor(c));
        expect(g.querySelector('text').getAttribute('fill')).toBe(contrastText(tyreColor(c)));
        expect(text(g.querySelector('text'))[0]).toBe(c[0]);
      }
    }
    expect(text(view.host.querySelector('.pca-pager'))).toContain(`patterns 1–${strips.length} of ${ANSWER.strategies.length}`);
    expect(noScroll(view.host)).toEqual([]);
    await view.unmount();
  });
});
