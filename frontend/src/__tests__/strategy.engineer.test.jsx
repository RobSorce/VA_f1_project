// V6 / V1 / minor backlog, Strategy Engineer (components/visualizations/GeminiAssistant.jsx):
//  - a scenario's stints are a D3 strip (utils/views/stintStripChart.js) with
//    the compound letter on each segment, not percentage-positioned divs;
//  - the risk chip carries its severity glyph and word (!! / ! / i), never
//    green / amber / red alone; the pace trend its arrow and sign;
//  - the briefing's projected finish is the Monte Carlo MEDIAN (the Race
//    Prediction P label), not the mean (it once read "→ P6.6" beside a P5 label);
//  - the MOCK chip's tooltip names the heuristic fallback and its causes;
//  - no colour literal, no fixed pixel font size in the panel.
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
// the chat log keeps its newest message in view (the mini DOM does not scroll)
if (!dom.window.Element.prototype.scrollIntoView) dom.window.Element.prototype.scrollIntoView = () => {};
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { CHART_FONT, tyreColor, contrastText } = await import('../utils/colors.js');
const { SEVERITY } = await import('../utils/views/strategyMarks.js');
const { modePosition } = await import('../utils/simulationClient.js');
const { default: GeminiAssistant } = await import('../components/visualizations/GeminiAssistant.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/GeminiAssistant.jsx');
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

const SCENARIO = {
  id: 's1',
  label: 'Two-stop: pit L18 and L36',
  risk: 'high',
  projected_position: 4,
  total_stops: 2,
  stints: [
    { compound: 'MEDIUM', lap_start: 1, length: 17 },
    { compound: 'HARD', lap_start: 18, length: 18 },
    { compound: 'SOFT', lap_start: 36, length: 18 },
  ],
};

// A projection row whose mean (6.6) and median (5) differ
const PROJ = {
  driver: 'VER', currentPos: 6, expectedPos: 6.6, posRange: [3, 12],
  posCount: { 3: 100, 4: 200, 5: 250, 6: 150, 9: 150, 12: 150 },
  posDistribution: { 3: 10, 4: 20, 5: 25, 6: 15, 9: 15, 12: 15 }, podiumProb: 10, pointsProb: 80,
};

async function mount(width = 420, height = 640) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(GeminiAssistant)); });
  return {
    host,
    async click(el) { await act(async () => { dom.mouse(el, 'click'); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('D3 strips; no colour literal, no fixed pixel font size, no percentage div bars, no raw mean label', () => {
    expect(src).toMatch(/drawStintStrips\(/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba\(\s*\d/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/(width|left):\s*`\$\{[^}]*\}%`/);
    expect(src).not.toMatch(/expectedPos\.toFixed/);
    expect(src).not.toMatch(/no Gemini API key configured\. Responses are hand-written/);
  });
});

describe('the Strategy Engineer panel', () => {
  it('scenario card: D3 strip with letters, the risk glyph; the median P label; the pace trend arrow', async () => {
    useF1Store.setState({
      ...INITIAL,
      focusDriver: 'VER',
      maxLap: 53,
      currentLap: 20,
      raceProjection: { numSimulations: 1000, projections: [PROJ], battles: [], risks: [] },
      raceSituationData: { driverAbbrs: ['VER'], driverFeatures: { VER: { position: 6, paceTrend: 0.12, recentPace: 82.4, tyreLife: 12 } } },
      geminiMessages: [
        { role: 'user', content: 'Compare strategies' },
        { role: 'ai', content: 'Heuristic fallback: no API key.\nTwo-stop looks best.', scenarios: [SCENARIO], is_mock: true },
      ],
    });
    const view = await mount();
    // the median, not the mean
    const proj = useF1Store.getState().raceProjection;
    const median = modePosition(proj, PROJ);
    expect(median).toBe(5);
    const stats = text(view.host.querySelector('.strategy-console__stats'));
    expect(stats).toContain(`→ P${median}`);
    expect(stats).not.toContain('P6.6');
    // pace trend: arrow and sign
    expect(stats).toContain('▲ +0.12s/lap');

    // the scenario strip
    const svg = view.host.querySelector('svg.strategy-card__stints-svg');
    expect(svg).toBeTruthy();
    const segs = [...svg.querySelectorAll('g.strip-seg')];
    expect(segs.map((g) => [g.getAttribute('data-compound'), Number(g.getAttribute('data-start')), Number(g.getAttribute('data-length'))]))
      .toEqual(SCENARIO.stints.map((st) => [st.compound, st.lap_start, st.length]));
    for (const g of segs) {
      const c = g.getAttribute('data-compound');
      expect(g.querySelector('rect').getAttribute('fill')).toBe(tyreColor(c));
      expect(g.querySelector('text').getAttribute('fill')).toBe(contrastText(tyreColor(c)));
      expect(text(g.querySelector('text'))[0]).toBe(c[0]);
      expect(g.querySelector('text').style['font-size']).toBe(CHART_FONT.data);
    }
    // the risk chip: glyph and word
    expect(text(view.host.querySelector('.strategy-card__risk'))).toBe(`${SEVERITY.high.glyph} HIGH`);

    // the MOCK chip (Radio tab): the fallback and its causes
    const radio = [...view.host.querySelectorAll('button')].find((b) => text(b) === 'Radio');
    await view.click(radio);
    const chip = view.host.querySelector('.message-mock-chip');
    expect(chip.getAttribute('title')).toMatch(/Heuristic fallback, not Gemini: no API key configured, the google-genai package missing, or the API unavailable/);
    await view.unmount();
  });
});
