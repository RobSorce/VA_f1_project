// Circle of Doom in its Pit Wall slot at common viewports (1920x1080,
// 2048x1100, 1440x900, 1536x750, 1366x768), laid out from the slot size as in the browser and
// measured with the real Inter metrics (public/fonts, advance widths).
// Centre text never below 10 px (the label floor): lines without room leave the centre for the
// legend line, lap/maxLap and the pit loss with its "(fallback)" last.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Server rendering reads getServerState: point it at the live state
vi.mock('zustand', async (importOriginal) => {
  const orig = await importOriginal();
  const bind = (createState) => {
    const api = orig.createStore(createState);
    api.getServerState = api.getState;
    const useBound = (selector, equalityFn) => orig.useStore(api, selector, equalityFn);
    Object.assign(useBound, api);
    return useBound;
  };
  return { ...orig, create: (createState) => (createState ? bind(createState) : bind) };
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

const { useF1Store } = await import('../store/useF1Store.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');
const { estimatePitLoss } = await import('../utils/pitLoss.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const { haveWebFont, faceWidths } = await import('./helpers/fontWidths.js');

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Real font metrics: advance widths of the Inter faces of tokens.css
// (helpers/fontWidths.js; italic is synthesised from the upright face)
const haveFonts = haveWebFont;
/** The view's measureText: width of a text in the face of its weight (weight 700 by default), tabular figures (.cod). */
const realMeasure = haveFonts ? (text, size, weight = 700) => faceWidths(weight, { tabular: true })(text, size) : null;

// ---------------------------------------------------------------------------
// The Pit Wall slot of the circle (.cod, the panel content) at a viewport,
// from PitWallLayout.jsx (480 px sidebar, rows 44px / 1fr / 35vh, bottom row
// minmax(0, 1fr) minmax(0, 1fr) 280px, 1 px gaps) and the CSS (base.css root
// font clamp(13px, 6.4px + 0.5vw, 16px); components.css .panel 1 px border,
// header 0.5rem padding + the 22 px export button + 1 px border, content
// padding 1rem). Checked against the browser: 1920x1080 -> 545 x 306,
// 1680x1050 -> 427 x 299, 1440x900 -> 310 x 250, 1536x864 -> 357 x 236.
function pitWallSlot(vw, vh) {
  const rem = Math.min(16, Math.max(13, 6.4 + 0.005 * vw));
  const column = (vw - 480 - 1 - 280 - 2) / 2;
  return {
    width: column - 2 - 2 * rem,
    height: 0.35 * vh - 2 - (rem + 22 + 1) - 2 * rem,
  };
}

// the four V13 target viewports (1536x750: a 1920x1080 screen at 125 % with
// the browser maximised) and the earlier 1440x900
const VIEWPORTS = {
  '1920x1080': [1920, 1080], '2048x1100': [2048, 1100], '1440x900': [1440, 900], '1536x750': [1536, 750], '1366x768': [1366, 768],
};
// the sweep adds the sizes of the earlier review (a 1920x1080 laptop at 125 %, 1680x1050)
const SWEEP_VIEWPORTS = { ...VIEWPORTS, '1536x864': [1536, 864], '1680x1050': [1680, 1050] };

// ---------------------------------------------------------------------------
const INITIAL = useF1Store.getState();
const maxLapOf = (session) => Math.max(...session.lap_times.map((r) => r.LapNumber));

function replayAt(session, sessionTime, currentLap, extra = {}) {
  const offset = computeSessionTimeOffset(session.lap_times);
  const maxLap = maxLapOf(session);
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    loadedSessionType: 'R',
    sessionData: session,
    drivers: session.driver_info,
    trackStatus: session.track_status || [],
    sessionTimeOffset: offset,
    maxLap,
    totalRaceLaps: maxLap,
    currentLap,
    totalFrames: 10000,
    currentTime: sessionTime - offset,
    ...extra,
  });
}

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
});

const decode = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const textOf = (markup) => decode(markup.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

/** What a render shows: centre lines (text, font size, box), legend line, plot and legend sizes, label boxes. */
function readRender(markup) {
  const svg = markup.match(/<svg class="cod__svg"[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const ring = markup.match(/<circle class="cod-ring" cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/);
  const centreG = markup.match(/<g class="cod-centre" data-inner-r="([^"]+)" data-inner-fits="([^"]+)"/);
  const centre = [...markup.matchAll(/<text class="(cod-centre__[^"]*)" x="[^"]*" y="[^"]*" font-size="([^"]+)" data-inner-box="([^"]+)"[^>]*>([^<]*)</g)]
    .map((m) => ({
      cls: m[1], size: Number(m[2]), box: m[3].split(',').map(Number), text: decode(m[4]),
    }));
  const status = markup.match(/<div class="cod-status"[^>]*>([\s\S]*?)<\/div><\/div>/);
  const statusLines = (markup.match(/class="cod-status__line"/g) || []).length;
  const plotStyle = markup.match(/<div class="cod__plot" style="flex:none;width:([\d.]+)px;height:([\d.]+)px"/);
  const legend = markup.match(/<div class="chart-legend cod-legend( cod-legend--side)?" style="grid-template-columns:repeat\((\d+), max-content\)"/);
  const gap = markup.match(/<text class="cod-gap-text"[^>]*font-size="([^"]+)" data-inner-box="([^"]+)"/);
  const labels = [...markup.matchAll(/data-box="([^"]+)"/g)].map((m) => m[1].split(',').map(Number));
  return {
    width: Number(svg[1]),
    height: Number(svg[2]),
    cx: Number(ring[1]),
    cy: Number(ring[2]),
    R: Number(ring[3]),
    rInner: Number(centreG[1]),
    fits: centreG[2] === 'true',
    layout: markup.match(/data-layout="([^"]+)"/)[1],
    centre,
    centreText: centre.map((l) => l.text).join(' | '),
    statusText: status ? textOf(status[1]).trim() : '',
    statusLines,
    plot: plotStyle ? { width: Number(plotStyle[1]), height: Number(plotStyle[2]) } : null,
    legend: legend ? { side: !!legend[1], cols: Number(legend[2]) } : null,
    gap: gap ? { size: Number(gap[1]), box: gap[2].split(',').map(Number) } : null,
    labels,
  };
}

function overlaps(a, b) {
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
}

const renderAt = (slot) => renderToString(React.createElement(CircleOfDoom, { slotSize: slot, measureText: realMeasure }));

const haveChina = hasCachedSession(2024, 5);
const haveMonza = hasCachedSession(2024, 16);
const china = haveChina ? loadCachedSession(2024, 5) : null;
const monza = haveMonza ? loadCachedSession(2024, 16) : null;

describe('the Pit Wall slot', () => {
  it("the car tooltip always repeats the track status and the reference lap (the centre may have no room)", () => {
    const view = fs.readFileSync(path.join(SRC, 'components/visualizations/CircleOfDoom.jsx'), 'utf8');
    const tooltip = view.slice(view.indexOf('const carTooltip = useCallback'), view.indexOf('// Hide the shared tooltip'));
    expect(tooltip).toContain("row('Track', FLAG_LABELS[trackFlag] || FLAG_LABELS['1'])");
    expect(tooltip).toContain("row('Reference lap'");
  });

  it('is derived from PitWallLayout.jsx and the panel CSS as written', () => {
    const layout = fs.readFileSync(path.join(SRC, 'components/layout/PitWallLayout.jsx'), 'utf8');
    expect(layout).toContain("gridTemplateColumns: '480px 1fr'");
    expect(layout).toContain("gridTemplateRows: '44px 1fr 35vh'");
    expect(layout).toContain("gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 280px'");
    const base = fs.readFileSync(path.join(SRC, 'styles/base.css'), 'utf8');
    expect(base).toContain('font-size: clamp(13px, calc(6.4px + 0.5vw), 16px);');
    // the slot sizes measured in the browser (2026-10-13), within 1.5 px
    for (const [[vw, vh], [w, h]] of [[[1920, 1080], [545, 306]], [[1680, 1050], [427, 299]],
      [[1440, 900], [310, 250]], [[1536, 864], [357, 236]]]) {
      const slot = pitWallSlot(vw, vh);
      expect(Math.abs(slot.width - w)).toBeLessThan(1.5);
      expect(Math.abs(slot.height - h)).toBeLessThan(1.5);
    }
  });
});

const SCENARIOS = haveChina && haveMonza ? [
  { name: 'China lap 14, focus VER (12 stops measured)', session: china, now: 4726.2, lap: 14, extra: { focusDriver: 'VER' } },
  { name: 'China lap 8, focus LEC (fallback pit loss)', session: china, now: 4078.2, lap: 8, extra: { focusDriver: 'LEC' } },
  { name: 'China under the Safety Car, focus VER', session: china, now: 5950, lap: 27, extra: { focusDriver: 'VER' } },
  { name: 'Monza lap 15, focus LEC, hovering SAI', session: monza, now: 4600, lap: 15, extra: { focusDriver: 'LEC', highlightedDriver: 'SAI' } },
  { name: 'Monza lap 15, no focus', session: monza, now: 4600, lap: 15, extra: {} },
] : [];

describe.skipIf(!haveFonts || !SCENARIOS.length)('centre text at the Pit Wall viewports (real font metrics)', () => {
  for (const [vp, [vw, vh]] of Object.entries(VIEWPORTS)) {
    it(`${vp}: never below 10 px, inside the ring's room; lap and pit loss always shown, in the centre or on the legend line`, () => {
      const slot = pitWallSlot(vw, vh);
      for (const sc of SCENARIOS) {
        replayAt(sc.session, sc.now, sc.lap, sc.extra);
        const markup = renderAt(slot);
        const r = readRender(markup);
        const est = estimatePitLoss(sc.session.lap_times, { sessionNow: sc.now, sessionType: 'R' });
        const lossText = est.source === 'fallback'
          ? 'pit loss 22.0 s (fallback)'
          : `pit loss ${est.median.toFixed(1)} s (${est.n} stops)`;
        const lapText = `LAP ${sc.lap}/${maxLapOf(sc.session)}`;
        const labelOverlaps = r.labels.reduce((n, a, i) => n + r.labels.slice(i + 1).filter((b) => overlaps(a, b)).length, 0);
        console.log(`${vp} ${sc.name}: label overlaps ${labelOverlaps}; slot ${slot.width.toFixed(0)}x${slot.height.toFixed(0)}, plot ${r.width.toFixed(0)}x${r.height.toFixed(0)}, `
          + `legend ${r.legend.side ? 'side' : 'under'} ${r.legend.cols} col, R ${r.R.toFixed(0)}, layout ${r.layout}; `
          + `centre [${r.centre.map((l) => `${l.text}@${l.size.toFixed(1)}`).join(' | ')}]; legend line [${r.statusText}]`
          + `${r.gap ? `; gap readout @${r.gap.size.toFixed(1)}` : ''}`);
        // never below 10 px (the label floor), every line inside the room clear of the pit-lane cars
        for (const l of r.centre) expect(l.size).toBeGreaterThanOrEqual(10);
        expect(r.fits).toBe(true);
        for (const l of r.centre) {
          const reach = Math.hypot(Math.max(Math.abs(l.box[0] - r.cx), Math.abs(l.box[2] - r.cx)),
            Math.max(Math.abs(l.box[1] - r.cy), Math.abs(l.box[3] - r.cy)));
          expect(reach).toBeLessThanOrEqual(r.rInner + 0.1);
        }
        // the hover gap readout: at least 10 px, clear of every centre line
        if (r.gap) {
          expect(r.gap.size).toBeGreaterThanOrEqual(10);
          for (const l of r.centre) expect(overlaps(l.box, r.gap.box)).toBe(false);
        }
        // lap/maxLap and the pit loss, with "(fallback)" when it is one: in the centre
        // (whole or wrapped on two lines) or on the legend line
        const shown = `${r.centreText.replace(/ \| /g, ' ')} ${r.statusText}`;
        expect(shown).toContain(lapText);
        expect(shown).toContain(lossText);
        // the track status and the reference lap: in the centre or on the legend
        // line while there is room (always at 1920x1080), else in the car tooltip
        if (vp === '1920x1080') {
          expect(shown.toUpperCase()).toMatch(/TRACK CLEAR|SAFETY CAR/);
          expect(shown).toMatch(/ref lap \d:\d\d\.\d\d/);
        }
        // a line is in one place only
        for (const l of r.centre) expect(r.statusText).not.toContain(l.text);
        // plot, legend line and legend fit in the slot
        if (r.legend.side) {
          expect(r.width + 2).toBeLessThanOrEqual(slot.width);
        } else {
          const rows = Math.ceil(9 / r.legend.cols);
          const used = r.height + (r.statusLines ? 2 + 13 * r.statusLines : 0) + 2 + rows * 14 + (rows - 1);
          expect(used).toBeLessThanOrEqual(slot.height + 0.5);
          expect(r.width).toBeLessThanOrEqual(slot.width + 0.5);
        }
        if (vp === '1920x1080') {
          // the large slot keeps lap and pit loss in the centre
          expect(r.centreText).toContain(lapText);
          expect(r.centreText.replace(/ \| /g, ' ')).toContain(lossText);
        }
      }
    });
  }
});

// "Pit in k laps" (k > 0): the centre line is longer ("LEC pits in 3: P2 → P8
// (−1 vs now)"), the ring's label is the ghost's, the legend's rejoin entry
// shows both diamonds
describe.skipIf(!haveFonts || !SCENARIOS.length)('pit in k laps at the Pit Wall viewports (real font metrics)', () => {
  for (const [vp, [vw, vh]] of Object.entries(VIEWPORTS)) {
    it(`${vp}: k = 3 and 10, the centre and the ghost's legend entry fit like k = 0`, () => {
      const slot = pitWallSlot(vw, vh);
      for (const sc of SCENARIOS.filter((s) => s.extra.focusDriver)) {
        replayAt(sc.session, sc.now, sc.lap, sc.extra);
        for (const k of [3, 10]) {
          const markup = renderToString(React.createElement(CircleOfDoom, { slotSize: slot, measureText: realMeasure, pitInK: k }));
          const r = readRender(markup);
          const shown = `${r.centreText.replace(/ \| /g, ' ')} ${r.statusText}`;
          const ghost = /<g class="cod-ghost"/.test(markup);
          console.log(`${vp} ${sc.name}, k ${k}: ghost ${ghost}, R ${r.R.toFixed(0)}, layout ${r.layout}; centre [${r.centre.map((l) => `${l.text}@${l.size.toFixed(1)}`).join(' | ')}]; legend line [${r.statusText}]`);
          for (const l of r.centre) expect(l.size).toBeGreaterThanOrEqual(10);
          expect(r.fits).toBe(true);
          expect(shown).toContain(`LAP ${sc.lap}/${maxLapOf(sc.session)}`);
          expect(shown).toMatch(/pit loss \d+\.\d s/);
          for (const l of r.centre) expect(r.statusText).not.toContain(l.text);
          // labels (the ghost's included): no overlap, nothing clamped into the slot
          // (the 1366x768 slot keeps the sweep's allowance above)
          const labelOverlaps = r.labels.reduce((n, a, i) => n + r.labels.slice(i + 1).filter((b) => overlaps(a, b)).length, 0);
          if (vp !== '1366x768') expect({ labelOverlaps, layout: r.layout }).toEqual({ labelOverlaps: 0, layout: 'fits' });
          if (ghost) {
            expect(markup).toMatch(/<text class="cod-rejoin-label"[^>]*data-of="ghost"/);
            expect(markup).toContain('title="rejoin: now · in k laps"');
            // the focus line: in the centre, on the legend line or (no room) in the tooltip
            if (shown.includes('pits in')) expect(shown).toMatch(/pits in \d+: P\d+ → P\d+ \((= now|[+−]\d+ vs now)\)/);
          }
          if (r.legend.side) {
            expect(r.width + 2).toBeLessThanOrEqual(slot.width);
          } else {
            const rows = Math.ceil(9 / r.legend.cols);
            const used = r.height + (r.statusLines ? 2 + 13 * r.statusLines : 0) + 2 + rows * 14 + (rows - 1);
            expect(used).toBeLessThanOrEqual(slot.height + 0.5);
            expect(r.width).toBeLessThanOrEqual(slot.width + 0.5);
          }
        }
      }
    });
  }
});

const { circleState, gapSeconds } = await import('../utils/circleOfDoom.js');
const firstStartOfLap = (session, n) => Math.min(...session.lap_times
  .filter((r) => r.LapNumber === n && r.LapStartTime != null).map((r) => r.LapStartTime));

describe.skipIf(!haveFonts || !haveChina || !haveMonza)('sweep at the Pit Wall viewports (real font metrics)', () => {
  for (const [name, getSession] of [['Monza 2024', () => monza], ['China 2024', () => china]]) {
    it(`${name}: every 150 s, four focus choices, the nearest rival hovered, five viewports`, () => {
      const session = getSession();
      const lapTimes = session.lap_times;
      const last = maxLapOf(session);
      const flag = Math.max(...lapTimes.filter((r) => r.LapNumber === last).map((r) => r.Time ?? 0));
      const totals = {};
      for (const vp of Object.keys(SWEEP_VIEWPORTS)) {
        totals[vp] = {
          renders: 0, centreUnder9: 0, notFits: 0, readoutOnCentre: 0, lapOrLossMissing: 0, labelOverlaps: 0, clamped: 0,
          labelFontMin: Infinity, hiddenLabelsMax: 0, hiddenLabelsSum: 0, examples: [],
        };
      }
      for (let now = firstStartOfLap(session, 2); now < flag; now += 150) {
        const st = circleState(lapTimes, { sessionNow: now });
        const lap = Math.min(last, st.cars[0].lapsCompleted + 1);
        const est = estimatePitLoss(lapTimes, { sessionNow: now, sessionType: 'R' });
        const lossText = est.source === 'fallback' ? 'pit loss 22.0 s (fallback)' : `pit loss ${est.median.toFixed(1)} s (${est.n} stop`;
        const focuses = [null, st.cars[0]?.driver, st.cars[Math.floor(st.cars.length / 2)]?.driver,
          st.cars.find((c) => c.inPitLane)?.driver].filter((d, i, all) => all.indexOf(d) === i);
        for (const focus of focuses) {
          const nearest = focus ? st.cars.filter((c) => c.driver !== focus)
            .map((c) => ({ d: c.driver, g: Math.abs(gapSeconds(focus, c.driver, st) ?? Infinity) }))
            .sort((a, b) => a.g - b.g)[0]?.d : null;
          replayAt(session, now, lap, { focusDriver: focus, highlightedDriver: nearest ?? null });
          for (const [vp, [vw, vh]] of Object.entries(SWEEP_VIEWPORTS)) {
            const markup = renderAt(pitWallSlot(vw, vh));
            const r = readRender(markup);
            const t = totals[vp];
            t.renders += 1;
            // ring labels: never under the data type (11 px), a crowded ring
            // leaves the least relevant labels out instead (data-hidden-labels)
            for (const m of markup.matchAll(/<text class="cod-label[^"]*"[^>]*font-size="([^"]+)"/g)) {
              t.labelFontMin = Math.min(t.labelFontMin, Number(m[1]));
            }
            const hidden = Number((markup.match(/data-hidden-labels="(\d+)"/) || [])[1] || 0);
            t.hiddenLabelsMax = Math.max(t.hiddenLabelsMax, hidden);
            t.hiddenLabelsSum += hidden;
            if (r.centre.some((l) => l.size < 9) || (r.gap && r.gap.size < 9)) t.centreUnder9 += 1;
            if (!r.fits) t.notFits += 1;
            if (r.gap && r.centre.some((l) => overlaps(l.box, r.gap.box))) t.readoutOnCentre += 1;
            const shown = `${r.centreText.replace(/ \| /g, ' ')} ${r.statusText}`;
            if (!shown.includes(`LAP ${lap}/${last}`) || !shown.includes(lossText)) t.lapOrLossMissing += 1;
            t.labelOverlaps += r.labels.reduce((n, a, i) => n + r.labels.slice(i + 1).filter((b) => overlaps(a, b)).length, 0);
            if (r.layout === 'clamped') {
              t.clamped += 1;
              if (t.examples.length < 3) t.examples.push(`${now.toFixed(1)} s ${focus ?? 'no focus'} R ${r.R.toFixed(0)}`);
            }
          }
        }
      }
      console.log(`${name}: ${JSON.stringify(totals)}`);
      for (const [vp, t] of Object.entries(totals)) {
        expect(t.renders).toBeGreaterThan(80);
        expect(t.labelFontMin).toBeGreaterThanOrEqual(11);
        expect({
          centreUnder9: t.centreUnder9, notFits: t.notFits, readoutOnCentre: t.readoutOnCentre, lapOrLossMissing: t.lapOrLossMissing,
        }).toEqual({
          centreUnder9: 0, notFits: 0, readoutOnCentre: 0, lapOrLossMissing: 0,
        });
        // labels: no overlap and nothing clamped into the slot, but in the
        // 273 x 204 px slot of 1366x768 (ring radius 38), where a crowded field
        // (20 labels and the rejoin label round a 55 px label circle) can leave
        // one pair overlapping (measured: China 4 of 164 states, Monza 0)
        if (vp === '1366x768') {
          expect(t.clamped / t.renders).toBeLessThan(0.05);
        } else {
          expect({ labelOverlaps: t.labelOverlaps, clamped: t.clamped }).toEqual({ labelOverlaps: 0, clamped: 0 });
        }
      }
    }, 300000);
  }
});
