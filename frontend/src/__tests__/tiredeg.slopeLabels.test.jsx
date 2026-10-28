// Tyre Degradation: every slope label inside the plot, none over another.
//
// The browser pass found the two slope labels of a stint ("+0.022 s/lap
// (fuel-corr.*)" and "-0.008 s/lap (raw)") cut at the plot's right edge once
// a lap range kept a single stint (a click on a stint of the Strategy
// Timeline): they started 4 px right of the end of the fit line, and with one
// stint that end is the last tyre lap of the axis. At 1536 x 864 (Monza 2024,
// LEC, L16 - L53) they ran from 1469 to 1648 px against a plot ending at
// 1493 px, and the two lines overlapped by 2 px (baselines 13 px apart for
// 15 px of line).
//
// Here the chart is drawn for every driver of the demo race 2024 R16
// (frontend/public/data) with each of his stints as the lap range, and with
// no range, in a low wide plot (the Simulator preset's bottom pane at
// 1536 x 864, as in the browser) and a narrow one, at the data type sizes of
// 1536 x 864 and 2048 x 1152. A label's box is measured in its face,
// JetBrains Mono Bold / SemiBold (public/fonts: advance widths, hhea ascent
// and descent).
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { computedFontSize } from './helpers/screenFont.js';
import { loadCss, px } from './helpers/layoutModel.js';
import { loadFaces } from '../../scripts/audit/fontMetrics.mjs';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { stintsByDriver } = await import('../utils/stints.js');
const { installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const {
  placeSlopeLabels, monoLabelBox, MONO_ADVANCE_EM, MONO_ASCENT_EM, MONO_DESCENT_EM,
} = await import('../utils/views/degradationViews.js');
const { default: TireDegradation } = await import('../components/visualizations/TireDegradation.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const MONZA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(HERE, '../../public/data/2024_16_R/session.json.gz'))));
const MAX_LAP = Math.max(...MONZA.lap_times.map((r) => r.LapNumber));
const MONO = loadFaces('JetBrains Mono');
const CSS = loadCss(path.resolve(HERE, '..'));

// The plot's svg box: the Simulator preset's bottom pane at 1536 x 864 with
// the brush banner (the browser's 1194 x 121), and a narrow overlay
const PLOTS = [
  { name: 'wide 1194 x 121', width: 1194, height: 121 },
  { name: 'narrow 420 x 260', width: 420, height: 260 },
];
const VIEWPORTS = [{ W: 1536, H: 864 }, { W: 2048, H: 1152 }];

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

/** Draw the chart for `driver` with `range` in a plot of `box` at the type sizes of `vp`. */
async function draw(driver, range, box, vp) {
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R',
    sessionData: MONZA, trackStatus: MONZA.track_status || [],
    sessionTimeOffset: computeSessionTimeOffset(MONZA.lap_times),
    maxLap: MAX_LAP, totalRaceLaps: MAX_LAP, currentLap: MAX_LAP, lapModeRaceOver: true,
    totalFrames: 0, currentTime: 0, focusDriver: driver, selectedDrivers: [driver],
    selectedLapRange: range, brushLapRange: range,
    // the brushed fit of the backend is not asked here
    fetchDegradationRegression: vi.fn(),
  });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, ...box });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(TireDegradation)); });
  const plot = host.querySelector('.deg-plot');
  const svg = plot.querySelector('svg');
  dom.setRect(plot, { left: 0, top: 0, ...box });
  dom.setRect(svg, { left: 0, top: 0, ...box });
  await act(async () => { ro.notify(plot, box.width, box.height); });
  await settle();
  return { host, svg, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
}

/** The plot area (inner group and its hover rect) and the boxes of the slope and stint labels, in plot px. */
function labelsOf(svg, vp) {
  const hover = [...svg.querySelectorAll('rect')].find((r) => r.getAttribute('cursor') === 'crosshair');
  if (!hover) return null;
  const area = { width: Number(hover.getAttribute('width')), height: Number(hover.getAttribute('height')) };
  const g = hover.parentNode;
  const texts = [...g.children].filter((t) => t.localName === 'text');
  const box = (t) => {
    const px = computedFontSize(t, vp).px;
    const weight = Number(t.getAttribute('font-weight')) || 400;
    const w = MONO.width(t.textContent, px, weight);
    const x = Number(t.getAttribute('x'));
    const y = Number(t.getAttribute('y'));
    const anchor = t.getAttribute('text-anchor') || 'start';
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    return {
      text: t.textContent, x0, x1: x0 + w, y0: y - MONO.ascent(px, weight), y1: y + MONO.descent(px, weight),
    };
  };
  const slope = texts.filter((t) => /s\/lap/.test(t.textContent)).map(box);
  const stint = texts.filter((t) => /^S\d/.test(t.textContent)).map(box);
  // the fit lines (dashed): one per fitted stint
  const fits = [...g.children].filter((l) => l.localName === 'line' && l.getAttribute('stroke-dasharray')).length;
  return {
    area, slope, stint, fits,
  };
}

describe('placeSlopeLabels (utils/views/degradationViews.js)', () => {
  const lines = ['+0.022 s/lap (fuel-corr.*)', '-0.008 s/lap (raw)'];
  const plot = { width: 1124, height: 79, fontPx: 11 };
  it('the face metrics are JetBrains Mono\'s (public/fonts)', () => {
    for (const w of [600, 700]) {
      expect(MONO.width('+0.022 s/lap (fuel-corr.*)', 10, w)).toBeCloseTo(26 * MONO_ADVANCE_EM * 10, 6);
      expect(MONO.ascent(10, w)).toBeCloseTo(MONO_ASCENT_EM * 10, 6);
      expect(MONO.descent(10, w)).toBeCloseTo(MONO_DESCENT_EM * 10, 6);
    }
  });
  it('a fit line ending at the right edge: the block moved inside, its lines one under the other', () => {
    const [p] = placeSlopeLabels([{ key: '2', x: 1100, y: 40, lines }], plot);
    expect(p.box.x1).toBeLessThanOrEqual(1124);
    expect(p.box.y0).toBeGreaterThanOrEqual(0);
    expect(p.box.y1).toBeLessThanOrEqual(79);
    expect(p.lines.map((l) => l.text)).toEqual(lines);
    expect(p.lines[1].y - p.lines[0].y).toBeCloseTo((MONO_ASCENT_EM + MONO_DESCENT_EM) * 11, 6);
  });
  it('room to the right: the block starts 4 px after the end of the line, as before', () => {
    const [p] = placeSlopeLabels([{ key: '1', x: 300, y: 40, lines }], plot);
    expect(p.x).toBe(304);
  });
  it('two stints ending at the same place: two blocks, apart; an obstacle is kept clear', () => {
    const stintLabel = monoLabelBox('S1 M', 1080, 20, 11);
    const ps = placeSlopeLabels([
      { key: '1', x: 1110, y: 40, lines }, { key: '2', x: 1110, y: 40, lines },
    ], { ...plot, obstacles: [stintLabel] });
    expect(ps).toHaveLength(2);
    const [a, b] = ps.map((p) => p.box);
    expect(overlap(a, b)).toBe(false);
    for (const p of ps) expect(overlap(p.box, stintLabel)).toBe(false);
  });
  it('a plot narrower than a line: no label (the slope stays in the tooltip and the banner)', () => {
    expect(placeSlopeLabels([{ key: '1', x: 50, y: 40, lines }], { ...plot, width: 120 })).toEqual([]);
  });
});

const overlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.01 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.01;
const outside = (b, area) => Math.max(0, -b.x0, b.x1 - area.width, -b.y0, b.y1 - area.height);

// Every driver's stints at the flag: each one is a lap range
const STINTS = stintsByDriver(MONZA.lap_times);
const CASES = Object.entries(STINTS).flatMap(([driver, stints]) => [
  ...stints.map((s) => ({ driver, range: [s.StartLap, s.StartLap + s.TotalLaps - 1] })),
  { driver, range: null },
]);

afterAll(() => {
  useF1Store.setState({ ...INITIAL });
  dom.document.documentElement.style.removeProperty('--font-size-data');
});

describe('Tyre Degradation slope labels, Monza 2024 (demo data)', () => {
  it('the demo race has one-stint ranges to test: 20 drivers, LEC L16 - L53 among them', () => {
    expect(Object.keys(STINTS)).toHaveLength(20);
    expect(CASES).toContainEqual({ driver: 'LEC', range: [16, 53] });
    expect(MONO).not.toBeNull();
  });

  for (const vp of VIEWPORTS) {
    for (const plot of PLOTS) {
      it(`${plot.name}, type of ${vp.W} x ${vp.H}: each fitted stint's two slope lines inside the plot, over no other label`, async () => {
        // the data size of the viewport (tokens.css --font-size-data), as the page sets it
        const data = px(CSS, '--font-size-data', vp);
        dom.document.documentElement.style.setProperty('--font-size-data', `${data}px`);
        const problems = [];
        let oneStint = 0;
        for (const { driver, range } of CASES) {
          const v = await draw(driver, range, plot, vp);
          try {
            const L = labelsOf(v.svg, vp);
            if (!L) continue;
            const what = `${driver} ${range ? `L${range[0]}-L${range[1]}` : 'race'}`;
            if (range && L.slope.length === 2) oneStint += 1;
            // two lines per fitted stint: the fuel-corrected and the raw slope
            expect(L.slope.length, what).toBe(2 * L.fits);
            for (const b of L.slope) {
              const out = outside(b, L.area);
              if (out > 0.5) problems.push(`${what}: "${b.text}" ${out.toFixed(1)} px out of the ${L.area.width} x ${L.area.height} plot`);
            }
            const all = [...L.slope, ...L.stint];
            for (let i = 0; i < L.slope.length; i++) {
              for (let j = 0; j < all.length; j++) {
                if (j === i || (j < L.slope.length && j < i)) continue;
                if (overlap(L.slope[i], all[j])) problems.push(`${what}: "${L.slope[i].text}" over "${all[j].text}"`);
              }
            }
          } finally {
            await v.unmount();
          }
        }
        expect(oneStint).toBeGreaterThan(20);
        expect(problems).toEqual([]);
      }, 60000);
    }
  }
});
