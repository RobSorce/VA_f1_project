// D6 (Phase 9c, F7): the base driver's zero line of the Lap Delta chart has a
// style no other encoding of the chart uses, a label on the chart naming it
// ("base: NOR") and a legend row drawn like it.
//
// Before Phase 9c it was dashed 6,3: the teammate dash (colors.js
// TEAMMATE_DASHES[1]), so with a teammate on the chart (PIA for NOR) the
// zero line and the teammate's line had the same pattern. The first Phase 9c
// round made it one solid 2 px grey line: a Haas driver's line is one solid
// 2 px grey line too (#B6BABD, CIEDE2000 8.1 from it, verifier r1). It is now
// a double line (two rails), a pattern no driver line has whatever its colour.
import { describe, it, expect, vi, afterAll } from 'vitest';
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
const C = await import('../utils/colors.js');
const {
  TEAMMATE_DASHES, TEXT_COLORS, CHART_SURFACE, contrastRatio, getDriverColor, markColor,
} = C;
const { PREDICTION_DASH } = await import('../utils/views/championshipChart.js');
const { lapDeltaLegend, BASE_LINE } = await import('../utils/views/lapDeltaChart.js');
const { syntheticSession, SYNTH_DRIVERS } = await import('./helpers/chartFixtures.js');
const { default: LapDeltaChart } = await import('../components/visualizations/LapDeltaChart.jsx');

const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
// the same field with the two Haas drivers (grey team colour #B6BABD)
const HAAS = [
  { abbr: 'HUL', number: '27', name: 'Nico Hulkenberg', team: 'Haas F1 Team', color: '#B6BABD', pace: 0.5 },
  { abbr: 'MAG', number: '20', name: 'Kevin Magnussen', team: 'Haas F1 Team', color: '#B6BABD', pace: 0.6 },
];
SYNTH_DRIVERS.push(...HAAS);
const SESSION_HAAS = syntheticSession(20);
SYNTH_DRIVERS.splice(SYNTH_DRIVERS.length - HAAS.length, HAAS.length);
// NOR the base; PIA his teammate (dashed 6,3), VER and his teammate PER
const COMPARED = ['PIA', 'VER', 'PER'];

let view = null;
async function mountChart({ session = SESSION, base = 'NOR', compared = COMPARED } = {}) {
  if (typeof C.setSessionDriverColors === 'function') C.setSessionDriverColors(session.driver_info);
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: session,
    sessionTimeOffset: computeSessionTimeOffset(session.lap_times),
    maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true,
    totalFrames: 0, currentTime: 0,
    focusDriver: base, lapDeltaBaseDriver: null,
    selectedDrivers: [base, ...compared],
  });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 900, height: 420 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(LapDeltaChart)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  view = { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
  return view;
}

/** The chart's svg (100 % x 100 % of its box), not a legend swatch. */
const chartSvg = (host) => host.querySelectorAll('svg').find((s) => s.style.width === '100%');

const dashOf = (el) => {
  const d = el.getAttribute('stroke-dasharray');
  return d == null || d === '' || d === 'none' || d === 'null' ? null : d.replace(/\s+/g, '');
};

/** The zero line: the full-width horizontal line that is not a grid line nor the hover rule. */
function zeroLine(svg) {
  const tagged = svg.querySelector('.delta-base-line');
  if (tagged) return tagged;
  return svg.querySelectorAll('line').find((l) => l.getAttribute('x1') === '0'
    && l.getAttribute('y1') === l.getAttribute('y2')
    && !l.closest('.grid') && l.style.display !== 'none' && !l.closest('.axis') && !l.closest('.tick'));
}

describe('D6: the Lap Delta base line', () => {
  afterAll(async () => {
    if (view) await view.unmount();
    useF1Store.setState({ ...INITIAL });
  });

  it('is drawn in a style no other line of the chart has (never the teammate dash)', async () => {
    const { host } = await mountChart();
    const svg = chartSvg(host);
    const base = zeroLine(svg);
    expect(base, 'zero line drawn').toBeTruthy();
    const baseStyle = { stroke: base.getAttribute('stroke'), dash: dashOf(base), width: base.getAttribute('stroke-width') };
    // not a teammate / third-driver dash, not the projection dots
    expect(TEAMMATE_DASHES.filter(Boolean)).not.toContain(baseStyle.dash);
    expect(baseStyle.dash).not.toBe(PREDICTION_DASH);
    // never the style of a driver's line drawn on the chart
    const lines = svg.querySelectorAll('.delta-line');
    expect(lines.length).toBe(COMPARED.length);
    for (const l of lines) {
      const same = l.getAttribute('stroke') === baseStyle.stroke && dashOf(l) === baseStyle.dash;
      expect(same, `${l.getAttribute('data-driver')} drawn like the base line`).toBe(false);
    }
    // a teammate's line is dashed, the base line is not dashed like it
    const pia = lines.find((l) => l.getAttribute('data-driver') === 'PIA');
    expect(dashOf(pia)).toBe(TEAMMATE_DASHES[1]);
    expect(baseStyle.dash).not.toBe(dashOf(pia));
    // neutral (no team colour), a mark >= 3:1 on the chart surface
    for (const d of ['NOR', ...COMPARED]) expect(baseStyle.stroke).not.toBe(markColor(getDriverColor(d)));
    expect(contrastRatio(baseStyle.stroke, CHART_SURFACE)).toBeGreaterThanOrEqual(3);
    // a double line: two parallel rails of BASE_LINE.width, 2 x offset apart;
    // every driver line is one path (a single stroke)
    const rails = base.querySelectorAll('line');
    expect(rails).toHaveLength(2);
    expect(Number(baseStyle.width)).toBe(BASE_LINE.width);
    const ys = rails.map((r) => Number(r.getAttribute('y1'))).sort((a, b) => a - b);
    for (const r of rails) expect(r.getAttribute('y1')).toBe(r.getAttribute('y2'));
    expect(ys[1] - ys[0]).toBeCloseTo(2 * BASE_LINE.offset, 6);
    for (const l of lines) expect(l.tagName.toLowerCase()).toBe('path');
  });

  it('stays apart from a grey team line: a Haas driver compared, his line one solid 2 px stroke, the base line double', async () => {
    await view.unmount();
    const { host } = await mountChart({ session: SESSION_HAAS, base: 'VER', compared: ['HUL', 'MAG'] });
    const svg = chartSvg(host);
    const base = zeroLine(svg);
    const haas = svg.querySelectorAll('.delta-line').filter((l) => ['HUL', 'MAG'].includes(l.getAttribute('data-driver')));
    expect(haas).toHaveLength(2);
    const solid = haas.find((l) => dashOf(l) === null);
    expect(solid, 'the first Haas driver drawn solid').toBeTruthy();
    // the colours are close (both neutral greys): the pattern tells them apart
    expect(C.deltaE2000(solid.getAttribute('stroke'), base.getAttribute('stroke'))).toBeLessThan(10);
    expect(base.querySelectorAll('line')).toHaveLength(2);
    expect(solid.tagName.toLowerCase()).toBe('path');
    expect(Number(solid.getAttribute('stroke-width'))).toBe(2);
    expect(Number(base.getAttribute('stroke-width'))).not.toBe(2);
    await view.unmount();
    view = null;
    await mountChart();
  });

  it('is named on the chart: "base: NOR", in a neutral text colour', () => {
    const svg = chartSvg(view.host);
    const label = svg.querySelectorAll('text').find((t) => t.textContent.trim() === 'base: NOR');
    expect(label, 'base label').toBeTruthy();
    expect(label.getAttribute('fill')).toBe(TEXT_COLORS.secondary);
  });

  it('has a legend row drawn like it; no other legend row has its style', () => {
    const legend = lapDeltaLegend('NOR', COMPARED);
    const row = legend.find((i) => i.label === 'base: NOR (zero line)');
    expect(row, 'legend row').toBeTruthy();
    expect(row).toMatchObject({ shape: 'line', color: BASE_LINE.stroke, strokeWidth: BASE_LINE.width, double: BASE_LINE.offset });
    expect(row.dash || null).toBe(BASE_LINE.dash);
    const others = legend.filter((i) => i !== row && i.shape === 'line');
    for (const o of others) expect(o.color === row.color && (o.dash || null) === (row.dash || null)).toBe(false);
    for (const o of others) expect(o.double || 0).toBe(0);
    // and the legend drawn by the view has the row, its swatch the drawn style
    const item = view.host.querySelectorAll('.legend-item').find((el) => el.textContent.includes('base: NOR'));
    expect(item).toBeTruthy();
    const swatches = item.querySelectorAll('line');
    expect(swatches).toHaveLength(2);
    const swatch = swatches[0];
    expect(swatch.getAttribute('stroke')).toBe(BASE_LINE.stroke);
    expect(dashOf(swatch)).toBe(BASE_LINE.dash);
    const drawn = zeroLine(chartSvg(view.host));
    expect(drawn.getAttribute('stroke')).toBe(BASE_LINE.stroke);
    expect(dashOf(drawn)).toBe(BASE_LINE.dash);
  });
});
