// F8 / D7 (Phase 9c repair): the views the verifier of round 1 found still
// drawing focus + context by opacity now mix the colour toward the panel
// (utils/colors.js contextColor / contextText): context text >= 3:1, context
// marks >= 2:1 on the panel, nothing of a context item drawn at an opacity.
//
//  - Championship chart: the end label of every context line read 1.48-2.22:1
//    (fill-opacity 0.3), its line 1.08:1 (stroke-opacity 0.15);
//  - Position Tracker: a context driver's end label 1.48-2.22:1 (opacity 0.3),
//    the compound badges of his stops in a group at opacity 0.12 (the letter
//    1.13:1 on its badge), his lines 1.06:1;
//  - Strategy Timeline: an unselected stint bar at opacity 0.2 (0.15 / 0.12)
//    with its label still black: 1.27-2.03:1 on the faded bar;
//  - Sectors / Consistency: the context team bar at opacity 0.35 / 0.6.
// Each view is mounted in the mini DOM with the synthetic race (a focus and a
// selection on) and every drawn colour is read back.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
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
const {
  contrastRatio, compositeOver, contrastText, SURFACES, TYRE_COLORS, CONTEXT_FLOOR, brushTintOver, STATUS_COLORS,
} = await import('../utils/colors.js');
const { stintLevel, stintFill, stintLabelFill } = await import('../utils/views/strategyTimeline.js');
const { installResizeObserverMock, syntheticSession, syntheticChampionship } = await import('./helpers/chartFixtures.js');
const { default: ChampionshipChart } = await import('../components/visualizations/ChampionshipChart.jsx');
const { default: PositionByLap } = await import('../components/visualizations/PositionByLap.jsx');
const { default: StrategyTimeline } = await import('../components/visualizations/StrategyTimeline.jsx');
const { default: RaceSituationMap } = await import('../components/visualizations/RaceSituationMap.jsx');

const ro = installResizeObserverMock();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const PANEL = SURFACES.panel;
const HEX = /^#[0-9A-F]{6}$/i;
// focus NOR, selection NOR + LEC: the other six drivers are context
const SELECTED = ['NOR', 'LEC'];

function raceState(extra = {}) {
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: SESSION, circuitInfo: SESSION.circuit_info, trackStatus: SESSION.track_status,
    sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
    maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true, totalFrames: 0, currentTime: 0,
    focusDriver: 'NOR', selectedDrivers: SELECTED, highlightedDriver: null,
    championshipData: syntheticChampionship(6),
    ...extra,
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

async function mount(Component) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 1000, height: 560 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  await settle();
  return { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
}

/** The product of the opacities of an element and its ancestors (opacity, and fill- / stroke-opacity of its own kind). */
function effectiveOpacity(el, kind = 'fill') {
  let o = 1;
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const a = n.getAttribute('opacity');
    if (a != null && a !== '') o *= Number(a);
    if (n.style && n.style.opacity !== '' && n.style.opacity != null) o *= Number(n.style.opacity);
  }
  const own = el.getAttribute(`${kind}-opacity`);
  if (own != null && own !== '') o *= Number(own);
  return o;
}

const chartSvg = (host) => host.querySelectorAll('svg').find((s) => s.style.width === '100%' && s.style.height === '100%')
  || host.querySelectorAll('svg').find((s) => s.querySelector('text'));

describe('the helper of the Strategy Timeline bars (utils/views/strategyTimeline.js)', () => {
  it('every compound at every level: an opaque bar >= 2:1 on the panel, its label >= 3:1 on the bar', () => {
    for (const compound of Object.keys(TYRE_COLORS)) {
      for (const level of ['full', 'context', 'deep']) {
        const fill = stintFill(compound, level);
        expect(fill, `${compound} ${level}`).toMatch(HEX);
        expect(contrastRatio(fill, PANEL), `${compound} ${level} bar`).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark - 1e-9);
        expect(stintLabelFill(compound, level)).toBe(contrastText(fill));
        expect(contrastRatio(stintLabelFill(compound, level), fill), `${compound} ${level} label`).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
      }
    }
  });

  it('levels: selected full, unselected or another driver hovered context, another compound hovered deep', () => {
    expect(stintLevel({ selected: true })).toBe('full');
    expect(stintLevel({ selected: false })).toBe('context');
    expect(stintLevel({ selected: true, hoverActive: true })).toBe('context');
    expect(stintLevel({ selected: false, highlighted: true, hoverActive: true })).toBe('full');
    expect(stintLevel({ selected: true, compoundDimmed: true })).toBe('deep');
  });
});

describe('mounted with a focus and a selection: context drawn by colour, never by opacity', () => {
  beforeAll(() => raceState());
  afterAll(() => { useF1Store.setState({ ...INITIAL }); });

  it('Championship chart: every line, dot and end label opaque; context lines >= 2:1, labels >= 3:1', async () => {
    const view = await mount(ChampionshipChart);
    try {
      const svg = chartSvg(view.host);
      const lines = svg.querySelector('.lines');
      expect(lines, 'lines group').toBeTruthy();
      const labels = lines.querySelectorAll('text');
      expect(labels.length).toBeGreaterThan(SELECTED.length);
      for (const t of labels) {
        expect(effectiveOpacity(t, 'fill'), t.textContent).toBe(1);
        expect(contrastRatio(t.getAttribute('fill'), PANEL), t.textContent).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
      }
      const paths = lines.querySelectorAll('path').filter((p) => p.getAttribute('stroke') !== 'transparent'
        && p.getAttribute('stroke-dasharray') == null);
      for (const p of paths) {
        expect(effectiveOpacity(p, 'stroke')).toBe(1);
        expect(contrastRatio(p.getAttribute('stroke'), PANEL)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
      }
      for (const c of lines.querySelectorAll('circle')) {
        expect(effectiveOpacity(c, 'fill')).toBe(1);
        expect(contrastRatio(c.getAttribute('fill'), PANEL)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
      }
    } finally {
      await view.unmount();
    }
  });

  it('Position Tracker: end labels, lines and compound badges of context drivers opaque, at the floors', async () => {
    const view = await mount(PositionByLap);
    try {
      const svg = chartSvg(view.host);
      const labels = svg.querySelectorAll('.pos-driver-label');
      expect(labels.length).toBeGreaterThan(SELECTED.length);
      for (const t of labels) {
        expect(effectiveOpacity(t), t.textContent).toBe(1);
        expect(contrastRatio(t.getAttribute('fill'), PANEL), t.textContent).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
        // the labels are drawn above the brush: >= 3:1 inside a brushed range
        // too (verifier r2: 2.79-2.84:1 there when computed on the panel alone)
        expect(contrastRatio(t.getAttribute('fill'), brushTintOver(PANEL)), `${t.textContent} on the brush tint`).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
      }
      const badges = svg.querySelectorAll('.pos-compound-badge');
      expect(badges.length).toBeGreaterThan(0);
      for (const b of badges) {
        expect(effectiveOpacity(b)).toBe(1);
        const fill = b.getAttribute('fill');
        expect(contrastRatio(fill, PANEL)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
        const letter = b.parentNode.querySelectorAll('.pos-compound-letter')
          .find((t) => t.getAttribute('x') === b.getAttribute('cx') && t.getAttribute('y') === b.getAttribute('cy'));
        expect(letter, 'badge letter').toBeTruthy();
        expect(effectiveOpacity(letter)).toBe(1);
        expect(contrastRatio(letter.getAttribute('fill'), compositeOver(fill, PANEL))).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
      }
      // the lines of the context drivers (the drivers neither focus nor selected): opaque, >= 2:1
      const ctxLines = svg.querySelectorAll('path').filter((p) => p.getAttribute('fill') === 'none'
        && p.getAttribute('stroke') && p.getAttribute('stroke') !== 'transparent' && p.getAttribute('stroke-width') === '1.5'
        && p.getAttribute('opacity') === '1');
      expect(ctxLines.length).toBeGreaterThan(0);
      for (const p of ctxLines) expect(contrastRatio(p.getAttribute('stroke'), PANEL)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
    } finally {
      await view.unmount();
    }
  });

  it('Strategy Timeline: context bars mixed (>= 2:1), their labels in contrastText of the bar drawn (>= 3:1), on a hover too', async () => {
    const view = await mount(StrategyTimeline);
    try {
      const check = () => {
        const svg = chartSvg(view.host);
        const bars = svg.querySelectorAll('.stint-bar');
        expect(bars.length).toBeGreaterThan(0);
        let context = 0;
        for (const b of bars) {
          expect(b.getAttribute('opacity'), 'no bar opacity').toBeNull();
          const fill = b.getAttribute('fill');
          expect(contrastRatio(fill, PANEL)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark - 1e-9);
          if (!SELECTED.includes(b.getAttribute('data-driver'))) context += 1;
        }
        expect(context).toBeGreaterThan(0);
        for (const t of svg.querySelectorAll('.stint-bar-label')) {
          expect(effectiveOpacity(t)).toBe(1);
          const x = Number(t.getAttribute('x'));
          const bar = bars.find((b) => b.getAttribute('data-driver') === t.getAttribute('data-driver')
            && Number(b.getAttribute('x')) <= x && x <= Number(b.getAttribute('x')) + Number(b.getAttribute('width')));
          expect(bar, 'the bar under the label').toBeTruthy();
          expect(contrastRatio(t.getAttribute('fill'), bar.getAttribute('fill'))).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
        }
      };
      check();
      // another driver hovered: every bar recoloured (context), the labels follow
      await act(async () => { useF1Store.setState({ highlightedDriver: 'VER' }); });
      check();
      await act(async () => { useF1Store.setState({ highlightedDriver: null }); });
    } finally {
      await view.unmount();
    }
  });

  it('Race Situation map: context dots, tyre badges, letters and codes opaque, at the floors (verifier r2: 1.16-2.81:1 by opacity)', async () => {
    const view = await mount(RaceSituationMap);
    try {
      // the labels fade in on entering (600 ms): let the transition end
      await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
      const svg = view.host.querySelectorAll('svg').find((x) => x.querySelector('.situation-label'));
      expect(svg, 'map svg').toBeTruthy();
      const abbrOf = (el) => el.__data__?.abbr;
      const isContext = (el) => !SELECTED.includes(abbrOf(el));
      const dots = svg.querySelectorAll('circle.driver-point');
      const badges = svg.querySelectorAll('circle.tyre-dot');
      const letters = svg.querySelectorAll('text.tyre-letter');
      const labels = svg.querySelectorAll('text.situation-label');
      expect(dots.filter(isContext).length).toBeGreaterThan(0);
      const dotFill = Object.fromEntries(dots.map((d) => [abbrOf(d), d.getAttribute('fill')]));
      for (const d of dots) {
        expect(effectiveOpacity(d), abbrOf(d)).toBe(1);
        expect(contrastRatio(d.getAttribute('fill'), PANEL), abbrOf(d)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
      }
      const badgeFill = Object.fromEntries(badges.map((b) => [abbrOf(b), b.getAttribute('fill')]));
      for (const b of badges) {
        expect(effectiveOpacity(b), abbrOf(b)).toBe(1);
        expect(contrastRatio(b.getAttribute('fill'), PANEL), abbrOf(b)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
      }
      for (const t of letters) {
        expect(effectiveOpacity(t), abbrOf(t)).toBe(1);
        expect(contrastRatio(t.getAttribute('fill'), badgeFill[abbrOf(t)]), abbrOf(t)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
      }
      expect(labels.filter(isContext).length).toBeGreaterThan(0);
      for (const t of labels) {
        expect(effectiveOpacity(t), t.textContent).toBe(1);
        // a style (the stylesheet's .situation-label rule set no fill any more)
        const fill = t.style.fill;
        expect(fill, t.textContent).toMatch(HEX);
        expect(contrastRatio(fill, PANEL), t.textContent).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
        // on its dark halo over its own dot (the label sits on the dot)
        const halo = compositeOver(t.getAttribute('stroke'), dotFill[t.__data__.abbr] || PANEL);
        expect(contrastRatio(fill, halo), `${t.textContent} on its halo`).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
      }
      // a context code is de-emphasised (mixed), a selected one is white
      const ctx = labels.find(isContext);
      const sel = labels.find((t) => !isContext(t));
      expect(contrastRatio(ctx.style.fill, PANEL)).toBeLessThan(contrastRatio(sel.style.fill, PANEL));
    } finally {
      await view.unmount();
    }
  });
});

describe('CSS: no context team bar is faded by opacity', () => {
  const dash = fs.readFileSync(path.join(SRC, 'styles/dashboard.css'), 'utf8');
  it('Sectors and Consistency context rules set no opacity; the views mix the bar (contextColor)', () => {
    for (const m of dash.matchAll(/\n([^{}\n]*(sectors-panel__row--context|consistency-card--context)[^{}]*)\{([^}]*)\}/g)) {
      expect(m[3], m[1].trim()).not.toMatch(/opacity/);
    }
    const sectors = fs.readFileSync(path.join(SRC, 'components/visualizations/SectorsPanel.jsx'), 'utf8');
    expect(sectors).toMatch(/contextColor\(markColor\(color\), SURFACES\.panel\)/);
    const cons = fs.readFileSync(path.join(SRC, 'components/visualizations/ConsistencyPanel.jsx'), 'utf8');
    expect(cons).toMatch(/isContext \? contextColor\(markColor\(color\), SURFACES\.panel\) : markColor\(color\)/);
  });

  // Phase 9c repair r2 (verifier r2, F8): CSS that won over what the views draw
  const viz = fs.readFileSync(path.join(SRC, 'styles/visualizations.css'), 'utf8');
  const rulesOf = (css, re) => [...css.matchAll(/\n([^{}\n]+)\{([^}]*)\}/g)].filter((m) => re.test(m[1]));
  it('Telemetry trace lines: no CSS opacity (it beat the drawn opacity 1 of a context trace: 1.32-1.42:1)', () => {
    const rules = rulesOf(viz, /\.telem-(speed|throttle|brake|gear|rpm)-line/);
    expect(rules.length).toBeGreaterThanOrEqual(10);
    for (const m of rules) expect(m[2], m[1].trim()).not.toMatch(/(^|[^-])opacity/);
  });
  it('a low-data Consistency card has no filter (saturate(0.6) took a context team bar from 2.01:1 to about 1.5:1)', () => {
    for (const m of rulesOf(dash, /consistency-card--low-data/)) expect(m[2], m[1].trim()).not.toMatch(/filter|opacity/);
  });
  it('a retired car on the Track Map: the retired grey at full opacity (opacity 0.2 read 1.13-1.62:1)', () => {
    const rules = rulesOf(viz, /car-marker--retired/);
    expect(rules.length).toBeGreaterThan(0);
    for (const m of rules) expect(m[2], m[1].trim()).not.toMatch(/opacity|grayscale/);
    const dot = rules.find((m) => /\.car-marker--retired \.car-dot\s*$/.test(m[1]));
    expect(dot[2]).toMatch(/fill: var\(--status-retired\);/);
    expect(contrastRatio(STATUS_COLORS.retired, PANEL)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
  });
  it('the Race Situation labels: no fill in the stylesheet (it beat the drawn context colour)', () => {
    for (const m of rulesOf(dash, /\.situation-label/)) expect(m[2], m[1].trim()).not.toMatch(/(^|\s)fill:/);
  });
});
