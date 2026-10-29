// Circle of Doom: the pit-lane segment, the sector marks and the gap list,
// server-rendered with a real store state on the tracked demo races
// (frontend/public/data: 2024 R16 Monza, 2024 R5 China; no race cache
// needed) in the Pit Wall slot of 1536x750, 1536x864 and 2048x1152
// (helpers/pitWallMaps.js codSlotAt: the CSS as written), measured with the
// real Inter metrics (helpers/fontWidths.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

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

const fs = await import('node:fs');
const path = await import('node:path');
const zlib = await import('node:zlib');
const { fileURLToPath } = await import('node:url');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');
const {
  circleState, pitWindow, gapSeconds,
} = await import('../utils/circleOfDoom.js');
const { estimatePitLoss } = await import('../utils/pitLoss.js');
const { pitStatus } = await import('../utils/circlePitLane.js');
const { sectorFractions } = await import('../utils/circleSectors.js');
const { gapRows } = await import('../utils/circleGapList.js');
const {
  rowParts, fitParts, partsWidth, gridCellWidth, GAP_ROW_PX, GRID_COLS,
} = await import('../utils/views/circleGapRows.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { loadCss, px } = await import('./helpers/layoutModel.js');
const {
  codSlotAt, panelHeaderAt, titleBlockWidth, declAt, sidesAt, haveWebFont,
} = await import('./helpers/pitWallMaps.js');
const { textWidth } = await import('./helpers/fontWidths.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = loadCss(SRC);
const demo = (dir) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SRC, '../public/data', dir, 'session.json.gz'))));
const MONZA = demo('2024_16_R');
const CHINA = demo('2024_5_R');
const INITIAL = useF1Store.getState();
const GAPS_KEY = 'va-cod-gaps-v1';
const TWO_PI = 2 * Math.PI;

/** The view's measureText: the face of its weight (700 by default), tabular figures (.cod). */
const measure = haveWebFont ? (t, size, weight = 700) => textWidth(t, size, weight, { tabular: true }) : null;

// The three target viewports, and the Circle of Doom's slot in its Pit Wall cell
const VPS = [
  { name: '1536x750', W: 1536, H: 750 },
  { name: '1536x864', W: 1536, H: 864 },
  { name: '2048x1152', W: 2048, H: 1152 },
];
const SLOTS = Object.fromEntries(VPS.map((vp) => [vp.name, codSlotAt(css, SRC, vp)]));

const maxLapOf = (s) => Math.max(...s.lap_times.map((r) => r.LapNumber));

function replayAt(session, sessionTime, extra = {}) {
  const offset = computeSessionTimeOffset(session.lap_times);
  const st = circleState(session.lap_times, { sessionNow: sessionTime });
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    loadedSessionType: 'R',
    sessionData: session,
    drivers: session.driver_info,
    trackStatus: session.track_status || [],
    sessionTimeOffset: offset,
    maxLap: maxLapOf(session),
    totalRaceLaps: maxLapOf(session),
    currentLap: Math.min(maxLapOf(session), (st.cars[0]?.lapsCompleted ?? 0) + 1),
    totalFrames: 10000,
    currentTime: sessionTime - offset,
    ...extra,
  });
}

const renderAt = (slot, props = {}) => renderToString(React.createElement(CircleOfDoom, { slotSize: slot, measureText: measure, ...props }));

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
  localStorage.removeItem(GAPS_KEY);
});

const decode = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const textOf = (markup) => decode(markup.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const box = (s) => s.split(',').map(Number);

function attrsOf(tag) {
  const out = {};
  for (const a of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[a[1]] = decode(a[2]);
  return out;
}

/** Everything the tests read from a render. */
function readRender(markup) {
  const ring = attrsOf(markup.match(/<circle class="cod-ring"[^>]*>/)[0]);
  const pit = attrsOf(markup.match(/<path class="cod-pitlane"[^>]*>/)[0]);
  const cx = Number(ring.cx);
  const cy = Number(ring.cy);
  const cars = [...markup.matchAll(/<g class="cod-car(?: [^"]*)?" data-driver="[^"]+"[^>]*>/g)].map((m) => {
    const a = attrsOf(m[0]);
    const [x, y] = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(a.transform).slice(1).map(Number);
    return {
      driver: a['data-driver'], pit: a['data-pit'] === 'true', stop: a['data-stop'] ?? null, angle: Math.atan2(x - cx, cy - y), r: Math.hypot(x - cx, y - cy),
    };
  });
  const labels = Object.fromEntries([...markup.matchAll(/<text class="cod-label[^"]*"[^>]*data-driver="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => [m[1], textOf(m[2]).trim()]));
  const centre = [...markup.matchAll(/<text class="cod-centre__[^"]*"[^>]*data-inner-box="([^"]+)"[^>]*>([^<]*)</g)]
    .map((m) => ({ box: box(m[1]), text: decode(m[2]) }));
  const gapText = markup.match(/<text class="cod-gap-text"[^>]*data-inner-box="([^"]+)"/);
  const marks = [...markup.matchAll(/<text class="cod-sector-mark"[^>]*data-mark="([^"]+)" data-mark-box="([^"]+)"/g)]
    .map((m) => ({ text: m[1], box: box(m[2]) }));
  const ticks = [...markup.matchAll(/<g class="cod-sector" data-sector="(\d)"><line class="cod-sector-tick" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"[^>]*><\/line><line class="cod-sector-hit"[^>]*><title>([^<]*)<\/title>/g)]
    .map((m) => ({
      k: Number(m[1]), angle: Math.atan2(Number(m[2]) - cx, cy - Number(m[3])), title: decode(m[6]),
    }));
  const band = markup.match(/<path class="cod-pit-window"[^>]*>/);
  const gaps = markup.match(/<div class="cod-gaps cod-gaps--(side|grid)"[^>]*>/);
  const gapRowsDrawn = [...markup.matchAll(/<div class="cod-gaps__row[^"]*" data-driver="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => ({
    driver: m[1],
    code: (m[2].match(/<span class="cod-gaps__code"[^>]*>([^<]*)</) || [])[1] ?? '',
    ref: decode((m[2].match(/<span class="cod-gaps__ref[^"]*">([^<]*)</) || [])[1] ?? ''),
    prev: decode((m[2].match(/<span class="cod-gaps__prev">([^<]*)</) || [])[1] ?? ''),
    glyph: decode((m[2].match(/<span class="cod-gaps__trend"[^>]*>([^<]*)</) || [])[1] ?? ''),
  }));
  const plot = markup.match(/<svg class="cod__svg"[^>]*data-hidden-labels="(\d+)"[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const side = markup.match(/<div class="cod__side" style="width:([\d.]+)px"/);
  return {
    cx,
    cy,
    R: Number(ring.r),
    rPit: Number(pit['data-r']),
    theta: Number(pit['data-span']),
    cars,
    labels,
    centre,
    gapTextBox: gapText ? box(gapText[1]) : null,
    marks,
    ticks,
    band: band ? attrsOf(band[0]) : null,
    gaps: gaps ? { mode: gaps[1], ...attrsOf(gaps[0]) } : null,
    gapRowsDrawn,
    more: (markup.match(/<div class="cod-gaps__more"[^>]*>([^<]*)</) || [])[1] ?? null,
    hidden: Number(plot[1]),
    plotW: Number(plot[2]),
    plotH: Number(plot[3]),
    sideW: side ? Number(side[1]) : null,
    legendItems: (markup.match(/class="legend-item cod-legend__item"/g) || []).length,
    legendCols: Number((markup.match(/<div class="chart-legend cod-legend[^"]*" style="grid-template-columns:repeat\((\d+)/) || [])[1] || 0),
    toggle: markup.match(/<button type="button" class="cod-gaps-toggle" aria-pressed="(true|false)"/)?.[1] ?? null,
    statusLines: (markup.match(/class="cod-status__line"/g) || []).length,
  };
}

const overlap = (a, b) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
const wrap = (a) => a - TWO_PI * Math.floor(a / TWO_PI);
const sameAngle = (a, b) => Math.abs(wrap(a - b + Math.PI) - Math.PI);

describe('the slots of the three target viewports', () => {
  it('the legend beside the plot at 1536x750 and 2048x1152, under it at 1536x864', () => {
    replayAt(MONZA, 4600);
    for (const vp of VPS) {
      const r = readRender(renderAt(SLOTS[vp.name]));
      expect(r.gaps.mode, vp.name).toBe(vp.name === '1536x864' ? 'grid' : 'side');
    }
  });
});

// Monza 2024: LEC enters the pit lane at 4628.772, crosses the line inside it
// at 4632.468 and leaves it at 4653.191; HAM is in the lane at 4640 too
describe('pit-lane segment', () => {
  it('a car in the lane is drawn on the segment, between -θ and the timing line, its label PIT and the seconds since its pit entry', () => {
    replayAt(MONZA, 4640, { focusDriver: 'LEC' });
    const lane = circleState(MONZA.lap_times, { sessionNow: 4640 }).cars
      .filter((c) => pitStatus(MONZA.lap_times, c.driver, 4640).status === 'lane').map((c) => c.driver).sort();
    expect(lane).toEqual(['HAM', 'LEC']);
    for (const vp of VPS) {
      const r = readRender(renderAt(SLOTS[vp.name]));
      // the segment: θ = 3 car slots at rPit, within [20°, 60°]
      expect(r.theta).toBeGreaterThanOrEqual(Math.PI / 9 - 1e-4);
      expect(r.theta).toBeLessThanOrEqual(Math.PI / 3 + 1e-4);
      expect(r.cars.filter((c) => c.pit).map((c) => c.driver).sort()).toEqual(lane);
      for (const c of r.cars.filter((x) => x.pit)) {
        expect(c.r, `${vp.name} ${c.driver}`).toBeCloseTo(r.rPit, 1);
        expect(c.angle).toBeGreaterThanOrEqual(-r.theta - 1e-6);
        expect(c.angle).toBeLessThanOrEqual(1e-6);
        expect(c.stop).toBe('lane');
      }
      for (const c of r.cars.filter((x) => !x.pit)) expect(c.r).toBeCloseTo(r.R, 1);
      // whole seconds since the pit entry; a lane car's label is in the relevant tier (kept)
      expect(r.labels.LEC).toBe('LEC PIT 11');
      expect(r.labels.HAM).toMatch(/^HAM PIT \d+$/);
      // the two marks one slot (2 carR + 1 px) apart at least, along the arc
      const [a, b] = r.cars.filter((x) => x.pit);
      const carR = Math.min(7, Math.max(3.5, Math.min(r.plotW, r.plotH) / 70));
      expect(Math.abs(a.angle - b.angle) * r.rPit).toBeGreaterThanOrEqual(2 * carR + 1 - 0.05);
    }
  });

  it('a focus in the lane: the band starts at its drawn angle and runs back to the rejoin point placed from its line time', () => {
    replayAt(MONZA, 4640, { focusDriver: 'LEC' });
    const st = circleState(MONZA.lap_times, { sessionNow: 4640 });
    const win = pitWindow('LEC', st, estimatePitLoss(MONZA.lap_times, { sessionNow: 4640, sessionType: 'R' }), { totalLaps: 53, trackFlag: '1' });
    expect(win).toMatchObject({ available: true, ongoingStop: true });
    for (const vp of VPS) {
      const r = readRender(renderAt(SLOTS[vp.name]));
      const lec = r.cars.find((c) => c.driver === 'LEC');
      expect(r.band, vp.name).not.toBeNull();
      expect(sameAngle(Number(r.band['data-to']), lec.angle)).toBeLessThan(2e-4);
      expect(sameAngle(Number(r.band['data-from']), TWO_PI * win.rejoinPhase)).toBeLessThan(2e-4);
    }
  });

  it('on the out-lap the car leaves the lane at the line and is drawn from its pit exit; the band from it to the rejoin point, never backwards', () => {
    // 4653.2: 0.009 s after LEC's pit exit; 4700: 46.8 s after it
    for (const [now, since] of [[4653.2, 4653.2 - 4653.191], [4700, 4700 - 4653.191]]) {
      replayAt(MONZA, now, { focusDriver: 'LEC' });
      const st = circleState(MONZA.lap_times, { sessionNow: now });
      const r = readRender(renderAt(SLOTS['2048x1152']));
      const lec = r.cars.find((c) => c.driver === 'LEC');
      expect(lec).toMatchObject({ pit: false, stop: 'out' });
      expect(r.labels.LEC).toBe('LEC OUT');
      expect(sameAngle(lec.angle, (TWO_PI * since) / st.refLap.seconds)).toBeLessThan(2e-4);
      if (r.band) {
        const from = Number(r.band['data-from']);
        const to = Number(r.band['data-to']);
        expect(sameAngle(to, lec.angle)).toBeLessThan(2e-4);
        expect(wrap(to - from)).toBeLessThan(Math.PI);
      }
    }
  });
});

describe('sector marks', () => {
  const now = 4600;
  it('two ticks at f1 and f12 of sectorFractions, their titles computed from it', () => {
    replayAt(MONZA, now);
    const st = circleState(MONZA.lap_times, { sessionNow: now });
    const fr = sectorFractions(MONZA.lap_times, st.refLap, now);
    expect(fr).not.toBeNull();
    const r = readRender(renderAt(SLOTS['2048x1152']));
    expect(r.ticks.map((t) => t.k)).toEqual([1, 2]);
    const laps = `laps ${fr.laps[0]}–${fr.laps[1]}`;
    for (const [t, share] of [[r.ticks[0], fr.f1], [r.ticks[1], fr.f12]]) {
      expect(sameAngle(t.angle, TWO_PI * share)).toBeLessThan(1e-3);
      expect(t.title).toBe(`S${t.k} ends at ${(share * 100).toFixed(1)} % of the ${st.refLap.seconds.toFixed(1)} s reference lap `
        + `(median of ${fr.n} clean laps, ${laps})`);
    }
  });

  it('none before sectorFractions has its laps (lap 1)', () => {
    const firstCrossing = Math.min(...MONZA.lap_times.filter((x) => x.LapNumber === 1).map((x) => x.Time));
    replayAt(MONZA, firstCrossing + 5);
    const st = circleState(MONZA.lap_times, { sessionNow: firstCrossing + 5 });
    expect(sectorFractions(MONZA.lap_times, st.refLap, firstCrossing + 5)).toBeNull();
    const r = readRender(renderAt(SLOTS['2048x1152']));
    expect(r.ticks).toEqual([]);
    expect(r.marks).toEqual([]);
  });

  it('rows without sector times (the live feed): no ticks, the PIT label stays', () => {
    const noSectors = {
      ...MONZA,
      lap_times: MONZA.lap_times.map((x) => ({
        ...x, Sector1Time: null, Sector2Time: null, Sector3Time: null, Sector1TimeSeconds: null, Sector2TimeSeconds: null, Sector3TimeSeconds: null,
      })),
    };
    replayAt(noSectors, now);
    const r = readRender(renderToString(React.createElement(CircleOfDoom, { size: { width: 900, height: 700 }, measureText: measure })));
    expect(r.ticks).toEqual([]);
    expect(r.marks.map((m) => m.text)).toEqual(['PIT']);
  });

  // The counts printed are what node lays out: the label type at its floor
  // (10 px; the browser draws 10 to 11.5 px), so at 2048x1152 they overstate
  // the labels the browser has room for
  it('never on each other, on a centre line or on the hover gap readout; clear of the pit-lane span (Monza and China, every 150 s)', () => {
    const stats = {};
    for (const [name, session] of [['Monza 2024', MONZA], ['China 2024', CHINA]]) {
      const lt = session.lap_times;
      const last = maxLapOf(session);
      const flag = Math.max(...lt.filter((x) => x.LapNumber === last).map((x) => x.Time ?? 0));
      const start = Math.min(...lt.filter((x) => x.LapNumber === 2).map((x) => x.LapStartTime));
      for (let t = start; t < flag; t += 150) {
        const st = circleState(lt, { sessionNow: t });
        const focus = st.cars[Math.floor(st.cars.length / 2)]?.driver ?? null;
        const near = st.cars.filter((c) => c.driver !== focus)
          .map((c) => ({ d: c.driver, g: Math.abs(gapSeconds(focus, c.driver, st) ?? Infinity) }))
          .sort((a, b) => a.g - b.g)[0]?.d ?? null;
        replayAt(session, t, { focusDriver: focus, highlightedDriver: near });
        for (const vp of VPS) {
          const r = readRender(renderAt(SLOTS[vp.name]));
          const s = stats[vp.name] || (stats[vp.name] = {
            renders: 0, S1: 0, S2: 0, S3: 0, PIT: 0, onMark: 0, onCentre: 0, onGap: 0, onPit: 0,
          });
          s.renders += 1;
          for (const m of r.marks) s[m.text] += 1;
          r.marks.forEach((m, i) => r.marks.slice(i + 1).forEach((o) => { if (overlap(m.box, o.box)) s.onMark += 1; }));
          for (const m of r.marks) {
            if (r.centre.some((l) => overlap(l.box, m.box))) s.onCentre += 1;
            if (r.gapTextBox && overlap(r.gapTextBox, m.box)) s.onGap += 1;
            // no corner of a mark inside the pit-lane span
            const corners = [[m.box[0], m.box[1]], [m.box[2], m.box[1]], [m.box[0], m.box[3]], [m.box[2], m.box[3]]]
              .map(([x, y]) => Math.atan2(x - r.cx, r.cy - y));
            if (corners.some((a) => a > -r.theta && a < 0)) s.onPit += 1;
          }
        }
      }
    }
    console.log(`sector marks placed / renders: ${JSON.stringify(stats)}`);
    for (const s of Object.values(stats)) {
      expect(s.renders).toBeGreaterThan(50);
      expect({
        onMark: s.onMark, onCentre: s.onCentre, onGap: s.onGap, onPit: s.onPit,
      }).toEqual({
        onMark: 0, onCentre: 0, onGap: 0, onPit: 0,
      });
    }
  }, 120000);
});

/** Rows the gap list has room for at a slot, as the view computes it (module header of CircleOfDoom.jsx). */
function roomOf(r, slot) {
  if (r.gaps.mode === 'side') {
    const legendH = 9 * 14 + 8; // the side legend: one column of nine 14 px rows, 1 px apart
    return Math.floor((slot.height - legendH - 2) / GAP_ROW_PX) - 1;
  }
  return GRID_COLS * (Number(r.gaps['data-rows']) - 1);
}

describe('gap list', () => {
  const now = 4600;
  const st = circleState(MONZA.lap_times, { sessionNow: now });
  // a selection of eight cars (more than any room) and of three; with and without a focus
  const eight = st.cars.slice(2, 10).map((c) => c.driver);
  const CASES = [
    { name: 'three selected', extra: { selectedDrivers: ['SAI', 'PIA', 'VER'] } },
    { name: 'eight selected', extra: { selectedDrivers: eight } },
    { name: 'focus LEC', extra: { focusDriver: 'LEC' } },
    { name: 'focus LEC + two selected', extra: { focusDriver: 'LEC', selectedDrivers: ['NOR', 'RUS'] } },
  ];

  it('its rows are gapRows at the room it has, in race order, printed by rowParts; the rest in one "+n more" row', () => {
    for (const vp of VPS) {
      for (const c of CASES) {
        replayAt(MONZA, now, c.extra);
        const markup = renderAt(SLOTS[vp.name]);
        const r = readRender(markup);
        const room = roomOf(r, SLOTS[vp.name]);
        const opts = { focus: c.extra.focusDriver ?? null, selected: c.extra.selectedDrivers ?? [] };
        let want = gapRows(st, MONZA.lap_times, now, { ...opts, capacity: room });
        if (want.overflow.length) want = gapRows(st, MONZA.lap_times, now, { ...opts, capacity: room - 1 });
        const tag = `${vp.name} ${c.name}`;
        expect(r.gapRowsDrawn.map((x) => x.driver), tag).toEqual(want.rows.map((x) => x.driver));
        const cell = r.gaps.mode === 'grid' ? gridCellWidth(SLOTS[vp.name].width) : r.sideW;
        want.rows.forEach((row, i) => {
          const parts = fitParts(rowParts(row, want.reference, now), cell, measure, 11);
          expect(r.gapRowsDrawn[i], `${tag} ${row.driver}`).toEqual({ driver: row.driver, ...parts });
        });
        expect(r.more).toBe(want.overflow.length ? `+${want.overflow.length} more` : null);
        expect(r.gaps['data-reference']).toBe(want.reference);
        // the header: to the reference; the × only with a selection
        const head = textOf(markup.match(/<div class="cod-gaps__head">[\s\S]*?<\/div>/)[0]).trim();
        expect(head.startsWith(`to ${want.reference} · ${r.gaps.mode === 'grid' ? 'to previous cell' : 'to row above'}`)).toBe(true);
        expect(markup.includes('aria-label="Clear comparison"')).toBe(opts.selected.length > 0);
      }
    }
  });

  it('no focus and no selection: one hint line', () => {
    replayAt(MONZA, now);
    for (const vp of VPS) {
      const markup = renderAt(SLOTS[vp.name]);
      expect(textOf(markup.match(/<div class="cod-gaps [\s\S]*?<\/div><\/div>/)[0]).trim()).toBe('Shift-click cars to compare');
    }
  });

  it('every row fits its room at the data size of its viewport (measured text)', () => {
    for (const vp of VPS) {
      const dataPx = px(css, '--font-size-data', vp);
      for (const c of CASES) {
        replayAt(MONZA, now, c.extra);
        const r = readRender(renderAt(SLOTS[vp.name]));
        const cell = r.gaps.mode === 'grid' ? gridCellWidth(SLOTS[vp.name].width) : r.sideW;
        let want = gapRows(st, MONZA.lap_times, now, { focus: c.extra.focusDriver ?? null, selected: c.extra.selectedDrivers ?? [], capacity: 20 });
        want = { ...want, rows: want.rows };
        for (const row of want.rows) {
          const parts = fitParts(rowParts(row, want.reference, now), cell, measure, dataPx);
          expect(partsWidth(parts, measure, dataPx), `${vp.name} ${c.name} ${row.driver}`).toBeLessThanOrEqual(cell);
        }
      }
    }
  });

  it('on or off, the plot, the ring, the hidden labels and the centre text are the same; beside the plot the list takes no width', () => {
    for (const c of CASES) {
      replayAt(MONZA, now, c.extra);
      for (const vp of VPS) {
        const slot = SLOTS[vp.name];
        localStorage.setItem(GAPS_KEY, '1');
        const on = readRender(renderAt(slot));
        localStorage.setItem(GAPS_KEY, '0');
        const off = readRender(renderAt(slot));
        const key = (r) => ({
          R: r.R, hidden: r.hidden, plotW: r.plotW, plotH: r.plotH, centre: r.centre.map((l) => l.text), statusLines: r.statusLines,
        });
        expect(key(on), `${vp.name} ${c.name}`).toEqual(key(off));
        if (on.gaps.mode === 'side') {
          // the plot is the slot less the legend column (its width) and the 2 px gap
          expect(on.plotW + on.sideW + 2).toBeCloseTo(slot.width, 6);
          expect(off.gaps.mode).toBe('side');
          const lines = Number(on.gaps['data-rows']);
          expect(9 * 14 + 8 + 2 + lines * GAP_ROW_PX).toBeLessThanOrEqual(slot.height);
          expect(on.toggle).toBeNull();
        } else {
          expect(on.toggle).toBe('true');
          expect(off.toggle).toBe('false');
          expect(off.gaps).toBeNull();
        }
      }
    }
  });

  it('the legend keeps its 9 items (beside the plot with the list under it; under the plot with "gaps" off); "gaps" on puts the grid in its box', () => {
    replayAt(MONZA, now, { focusDriver: 'LEC' });
    for (const vp of VPS) {
      localStorage.setItem(GAPS_KEY, '0');
      const off = readRender(renderAt(SLOTS[vp.name]));
      expect(off.legendItems, vp.name).toBe(9);
      localStorage.setItem(GAPS_KEY, '1');
      const on = readRender(renderAt(SLOTS[vp.name]));
      if (on.gaps.mode === 'side') {
        expect(on.legendItems).toBe(9);
      } else {
        expect(on.legendItems).toBe(0);
        expect(Number(on.gaps['data-rows'])).toBe(Math.ceil(9 / off.legendCols));
      }
    }
  });
});

// The header row: the title, the pit-in stepper, "rivals", "gaps" (with the
// legend under the plot) and the export button, from Panel.jsx and the
// controls of CircleOfDoom.jsx (16 px buttons, 3 px apart, the label type;
// 0 4 px padding and a 1 px border on the text buttons)
describe.skipIf(!haveWebFont)('the header controls stay on one row', () => {
  for (const name of ['1536x750', '1536x864']) {
    it(`${name}`, () => {
      const vp = VPS.find((v) => v.name === name);
      replayAt(MONZA, 4600, { focusDriver: 'LEC' });
      const r = readRender(renderAt(SLOTS[name]));
      const label = px(css, '--font-size-label', vp);
      const textBtn = (t) => textWidth(t, label, 600) + 2 * 4 + 2;
      const parts = [textWidth('pit in', label, 600), 16, Math.max(14, textWidth('10', 11, 800)), 16, textBtn('rivals')];
      if (r.toggle != null) parts.push(textBtn('gaps'));
      const controls = parts.reduce((a, b) => a + b, 0) + 3 * (parts.length - 1);
      const cellW = SLOTS[name].cell.width;
      const header = panelHeaderAt(css, vp, 22);
      const available = cellW - 2 - header.pad.left - header.pad.right;
      const needed = titleBlockWidth(css, vp, 'Circle of Doom', null) + 4 + controls + 6 + 22;
      console.log(`${name}: header ${needed.toFixed(1)} of ${available.toFixed(1)} px (gaps toggle ${r.toggle != null})`);
      expect(r.toggle != null).toBe(name === '1536x864');
      expect(needed).toBeLessThanOrEqual(available);
      expect(declAt(css, '.panel-header', 'padding', vp)).toBeTruthy();
      expect(sidesAt(css, declAt(css, '.panel-header', 'padding', vp), vp).left).toBeGreaterThan(0);
    });
  }
});
