// Race Analysis (components/visualizations/StrategyAnalysis.jsx):
//  - the field's tyre mix is a D3 strip (utils/views/stintStripChart.js) with
//    the compound letter and count on each segment and a cars axis;
//  - "What makes this cluster different" is a D3 bar chart of the signed
//    Cohen's d (utils/views/effectBarsChart.js) with an axis, the cut-off
//    rules and a legend; better / worse in the diverging pair (blue /
//    orange), the words beside every bar;
//  - every other mark is a palette colour with its glyph or word: urgency
//    (!! / ! / i), places gained / lost (▲ / ▼), badge levels (●● / ● / ○);
//    no red / green, no colour literal, no fixed pixel font;
//  - no scroll: lists are fitted to the panel and paged.
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
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const {
  DIVERGING, CHART_FONT, tyreColor, contrastText, TYRE_LABELS,
} = await import('../utils/colors.js');
const { effectRow, effectHalfRange, EFFECT_CUTOFFS } = await import('../utils/views/effectBarsChart.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { default: StrategyAnalysis } = await import('../components/visualizations/StrategyAnalysis.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/StrategyAnalysis.jsx');
const INITIAL = useF1Store.getState();
const HAVE = hasCachedSession(2024, 16);
const monza = HAVE ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function monzaAtLap(currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    sessionData: monza,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    maxLap: MAX_LAP,
    totalRaceLaps: MAX_LAP,
    currentLap,
    totalFrames: 0,
    currentTime: 0,
    raceSituationData: extractRaceSituationFeatures({
      lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    }),
    ...extra,
  });
}

async function mount(width = 460, height = 520) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(StrategyAnalysis)); });
  const buttons = () => [...host.querySelectorAll('button')];
  return {
    host,
    async open(name) {
      const b = buttons().find((x) => text(x) === name) || buttons().find((x) => text(x).startsWith(name));
      expect(b, `tab ${name}`).toBeTruthy();
      await act(async () => { dom.mouse(b, 'click'); });
    },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const noScroll = (host) => [host, ...host.querySelectorAll('*')]
  .filter((el) => /auto|scroll/.test(`${el.style.overflow || ''}${el.style.overflowY || ''}${el.style['overflow-y'] || ''}`));

describe('effect rows (pure)', () => {
  it('signed d, better / worse / neutral judgement and the words', () => {
    const lower = effectRow({ key: 'recentPace', label: 'Recent Pace', effectSize: 0.9, direction: 'lower', lowerBetter: true, magnitude: 'large' });
    expect(lower).toMatchObject({ d: -0.9, judgement: 'better', words: '↓ large, better' });
    const higher = effectRow({ key: 'positionTrend', label: 'Pos. Gained', effectSize: 0.4, direction: 'lower', lowerBetter: false, magnitude: 'small' });
    expect(higher).toMatchObject({ d: -0.4, judgement: 'worse', words: '↓ small, worse' });
    const neutral = effectRow({ key: 'tyreLife', label: 'Tyre Age', effectSize: 0.6, direction: 'higher', lowerBetter: null, magnitude: 'medium' });
    expect(neutral).toMatchObject({ d: 0.6, judgement: 'neutral', words: '↑ medium' });
    expect(effectHalfRange([lower, neutral])).toBe(1);
    expect(effectHalfRange([{ d: 2.2 }])).toBe(2.5);
    expect(EFFECT_CUTOFFS).toEqual([0.2, 0.5, 0.8]);
  });
});

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('D3 tyre mix and effect bars; no scroll, no colour literal, no fixed pixel font, no percentage div bars', () => {
    expect(src).toMatch(/drawStintStrips\(/);
    expect(src).toMatch(/drawEffectBars\(/);
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba\(\s*\d/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/(width|left):\s*`\$\{[^}]*\}%`/);
  });
});

describe.skipIf(!HAVE)('Race Analysis, Monza 2024 lap 30', () => {
  it('field overview: the tyre mix is a D3 strip with letters, counts and a cars axis', async () => {
    monzaAtLap(30);
    const feats = useF1Store.getState().raceSituationData.driverFeatures;
    const counts = {};
    for (const f of Object.values(feats)) counts[f.compoundName || 'UNKNOWN'] = (counts[f.compoundName || 'UNKNOWN'] || 0) + 1;
    const view = await mount();
    await view.open('Analysis');
    const svg = view.host.querySelector('svg.sa-tyre-mix');
    expect(svg).toBeTruthy();
    const segs = [...svg.querySelectorAll('g.strip-seg')];
    expect(Object.fromEntries(segs.map((g) => [g.getAttribute('data-compound'), Number(g.getAttribute('data-length'))]))).toEqual(counts);
    for (const g of segs) {
      const c = g.getAttribute('data-compound');
      expect(g.querySelector('rect').getAttribute('fill')).toBe(tyreColor(c));
      expect(g.querySelector('text').getAttribute('fill')).toBe(contrastText(tyreColor(c)));
      const label = text(g.querySelector('text'));
      if (label) expect(label.startsWith(TYRE_LABELS[c] || c[0])).toBe(true);
    }
    const ticks = [...svg.querySelectorAll('g.strip-axis .tick text')].map(text);
    expect(ticks[0]).toBe('0 cars');
    expect(ticks[ticks.length - 1]).toBe(`${Object.values(counts).reduce((a, b) => a + b, 0)} cars`);
    expect(svg.querySelector('g.strip-axis').style['font-size']).toBe(CHART_FONT.data);
    expect(noScroll(view.host)).toEqual([]);
    await view.unmount();
  });

  it('selected drivers: the effect bars are a D3 chart in the diverging pair with words, axis and legend', async () => {
    monzaAtLap(30, { selectedDrivers: ['VER', 'PER', 'SAR', 'ZHO'] });
    const view = await mount(520, 560);
    await view.open('Analysis');
    await view.open('Insights');
    const svg = view.host.querySelector('svg.sa-effects-svg');
    expect(svg, 'effect bars drawn').toBeTruthy();
    const rows = [...svg.querySelectorAll('g.eff-row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const g of rows) {
      const bar = g.querySelector('rect.eff-bar');
      const cls = bar.getAttribute('class');
      const fill = bar.getAttribute('fill');
      if (cls.includes('better')) expect(fill).toBe(DIVERGING.better);
      else if (cls.includes('worse')) expect(fill).toBe(DIVERGING.worse);
      else expect(fill).toBe(DIVERGING.neutral);
      expect(text(g.querySelector('text.eff-words'))).toMatch(/^[↑↓] (small|medium|large)(, (better|worse))?$/);
      expect(g.querySelector('text.eff-label').style['font-size']).toBe(CHART_FONT.data);
    }
    expect(svg.querySelectorAll('g.eff-x .tick').length).toBeGreaterThanOrEqual(2);
    expect(svg.querySelectorAll('line.eff-cut').length).toBeGreaterThan(0);
    expect([...svg.querySelectorAll('g.eff-legend .chart-legend__item')].map(text))
      .toEqual(['better for selected', 'worse for selected', 'no better direction', '|d| 0.2 / 0.5 / 0.8']);
    expect(noScroll(view.host)).toEqual([]);
    await view.unmount();
  });

  it('the insights list is paged in a short panel, every card carries its severity glyph and word', async () => {
    monzaAtLap(30, { focusDriver: 'LEC' });
    const view = await mount(420, 260);
    const cards = [...view.host.querySelectorAll('.sa-insight')];
    if (cards.length === 0) { await view.unmount(); return; }
    for (const c of cards) expect(text(c)).toMatch(/(!!|!|i) \w+ · (high|medium|low)/);
    const pager = view.host.querySelector('.sa-pager');
    const total = Number(/\((\d+)\)/.exec(text([...view.host.querySelectorAll('button')].find((b) => text(b).startsWith('Insights'))))?.[1] || 0);
    if (total > cards.length) expect(text(pager)).toContain(`insights 1–${cards.length} of ${total}`);
    expect(noScroll(view.host)).toEqual([]);
    await view.unmount();
  });
});
