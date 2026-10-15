// Circle of Doom view: server renders with a real store state (cached Monza
// 2024 and China 2024), read back as markup. The marks are rendered by React
// from D3 generators, so the band, the markers, the labels and the centre text
// are all in the server-rendered markup. Also: the view registration (slot,
// dock, layouts) and the Pit Wall placement next to the Track Map.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Server rendering reads getServerState: point it at the live state so a
// setState before renderToString is what the component sees
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

// In-memory localStorage for the store's persisted settings
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { useF1Store, DOCK_DEFAULTS } = await import('../store/useF1Store.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');
const { SLOT_OPTIONS, SLOT_IDS, PRESETS } = await import('../utils/slotOptions.js');
const { WINDOW_PRESETS } = await import('../utils/windowPresets.js');
const { CHART_HELP } = await import('../utils/chartHelp.js');
const {
  circleState, referenceLap, pitWindow, rejoinDistribution, gapSeconds, phaseAt,
} = await import('../utils/circleOfDoom.js');
const { estimatePitLoss, FALLBACK_PIT_LOSS } = await import('../utils/pitLoss.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

const INITIAL = useF1Store.getState();
const html = () => renderToString(React.createElement(CircleOfDoom));
/** Visible text of a server render (tags dropped, entities decoded). */
const textOf = (markup) => markup
  .replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ');

const MINUS = '−';
const FALLBACK = { width: 520, height: 360 };
const LEGEND_LABELS = [
  'car (team colour)', '2nd car of team', 'focus car', 'selected car', 'pit window', 'predicted rejoin',
  'uncertainty p10–p90', 'cars in pit lane', 'lapped (1L)',
];

/**
 * Display rule of the stacked rejoin label: positions with >= 5 % (at most 4),
 * in position order, plus 'other n%' (the view stacks them two per line, or one
 * per line where a narrower label fits better). Whole percentages that add up
 * to 100 (largest remainder), computed here on the draw counts of 1000 draws.
 */
function expectedProbabilityEntries(positions) {
  const counts = positions.map((p) => ({ position: p.position, k: Math.round(p.probability * 1000) }));
  const shown = [...counts]
    .sort((a, b) => (b.k - a.k) || (a.position - b.position))
    .filter((p) => p.k >= 50)
    .slice(0, 4)
    .sort((a, b) => a.position - b.position);
  const parts = [...shown.map((p) => ({ label: `P${p.position}`, k: p.k })),
    { label: 'other', k: 1000 - shown.reduce((s, p) => s + p.k, 0) }];
  parts.forEach((p, i) => { p.pct = Math.floor(p.k / 10); p.i = i; });
  let left = 100 - parts.reduce((s, p) => s + p.pct, 0);
  for (const p of [...parts].sort((a, b) => ((b.k % 10) - (a.k % 10)) || (b.k - a.k) || (a.i - b.i))) {
    if (left <= 0) break;
    p.pct += 1;
    left -= 1;
  }
  return parts.filter((p) => p.label !== 'other' || p.pct > 0).map((p) => `${p.label} ${p.pct}%`);
}

/** A flagged traffic gap (under 1.0 s) as printed: two decimals rounded down, never '1.0 s'. */
function trafficText(g) {
  if (g >= 1) return `${g.toFixed(1)} s`;
  const h = Math.floor(g * 100);
  return h > 0 ? `${(h / 100).toFixed(2)} s` : '< 0.01 s';
}

function lapClock(seconds) {
  const cs = Math.round(seconds * 100);
  const m = Math.floor(cs / 6000);
  return `${m}:${((cs - m * 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

function signed(s) {
  return s > 0 ? `+${s.toFixed(1)}` : `${MINUS}${(-s).toFixed(1)}`;
}

/** Attributes of the first element whose opening tag matches `re`. */
function attrsOf(markup, re) {
  const m = markup.match(re);
  if (!m) return null;
  const out = {};
  for (const a of m[0].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[a[1]] = a[2];
  return out;
}

function translateOf(attr) {
  const m = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(attr || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Ring geometry from the markup: centre and radius of the ring and pit lane. */
function ringOf(markup) {
  const ring = attrsOf(markup, /<circle class="cod-ring"[^>]*>/);
  const pit = attrsOf(markup, /<circle class="cod-pitlane"[^>]*>/);
  return {
    cx: Number(ring.cx), cy: Number(ring.cy), R: Number(ring.r), rPit: Number(pit.r),
  };
}

/** Every label box (data-box) of the markup, [x0, y0, x1, y1]. */
function labelBoxes(markup) {
  return [...markup.matchAll(/data-box="([^"]+)"/g)].map((m) => m[1].split(',').map(Number));
}

function overlapArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const haveChina = hasCachedSession(2024, 5);
const china = haveChina ? loadCachedSession(2024, 5) : null;

const maxLapOf = (session) => Math.max(...session.lap_times.map((r) => r.LapNumber));
const firstStartOfLap = (session, n) => Math.min(...session.lap_times
  .filter((r) => r.LapNumber === n && r.LapStartTime != null)
  .map((r) => r.LapStartTime));

/** Replay store state (frames loaded) at a session time. */
function replayAt(session, sessionTime, currentLap, extra = {}) {
  const lapTimes = session.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
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

describe('registration and placement', () => {
  it("slot 'circle' (Circle of Doom, strategy) is registered; 'undercut' is gone", () => {
    const circle = SLOT_OPTIONS.find((o) => o.id === 'circle');
    expect(circle).toMatchObject({ label: 'Circle of Doom', category: 'strategy' });
    expect(circle.component).toBeTruthy();
    expect(SLOT_IDS.has('circle')).toBe(true);
    expect(SLOT_OPTIONS.find((o) => o.id === 'undercut')).toBeUndefined();
    expect(SLOT_IDS.has('undercut')).toBe(false);
  });

  it("the dock has a slot of its own for the circle; no default, preset or layout lists 'undercut'", () => {
    expect(DOCK_DEFAULTS).toContain('circle');
    expect(DOCK_DEFAULTS).not.toContain('undercut');
    expect(JSON.stringify(PRESETS)).not.toContain('undercut');
    expect(JSON.stringify(WINDOW_PRESETS)).not.toContain('undercut');
    // the docked "Pit Window" layout puts the circle next to the Track Map, in one split
    const top = WINDOW_PRESETS.pitwindow.dockedLayout.children[0];
    expect(top.direction).toBe('horizontal');
    expect(top.children.map((p) => p.activeTab)).toEqual(['trackmap', 'circle']);
  });

  it('App view map and help registry have the circle entry', () => {
    const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
    expect(app).toMatch(/^\s*circle:\s*\{\s*title: 'Circle of Doom',\s*Component: CircleOfDoom,/m);
    expect(app).toContain("import CircleOfDoom from './components/visualizations/CircleOfDoom';");
    expect(CHART_HELP.circle.title).toBe('Circle of Doom');
    expect(CHART_HELP.circle.howToRead.join(' ')).toMatch(/fallback/);
  });

  it('the help claims only the coordination the views implement', () => {
    const help = [...CHART_HELP.circle.howToRead, ...CHART_HELP.circle.limitations].join(' ');
    expect(help).not.toMatch(/in every view/);
    // views named as following the hover do read highlightedDriver; the ones named
    // as not following it do not
    const reads = (file) => fs.readFileSync(path.join(SRC, 'components/visualizations', file), 'utf8').includes('highlightedDriver');
    for (const f of ['TrackMap.jsx', 'Leaderboard.jsx', 'TimingTower.jsx', 'LapTimeChart.jsx', 'StrategyTimeline.jsx']) expect(reads(f)).toBe(true);
    for (const f of ['PositionByLap.jsx', 'PCABiplot.jsx', 'PCAAnalysisPanel.jsx']) expect(reads(f)).toBe(false);
    expect(help).toMatch(/the Position Tracker and the PCA views follow focus and selection only/);
    expect(help).toMatch(/No pit window before the car has crossed the line for the first time/);
    expect(help).toMatch(/while a car still on lap 1 has not reached the end of sector 2/);
  });

  it('Pit Wall: the circle sits in the Track Map row, in its own column (not over the map)', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/layout/PitWallLayout.jsx'), 'utf8');
    expect(src).toMatch(/gridTemplateColumns: 'minmax\(0, 1fr\) minmax\(0, 1fr\) 280px'/);
    const row = src.slice(src.indexOf('<div style={bottomRowStyle}>'), src.indexOf('<WeatherMini />'));
    expect(row).toMatch(/<TrackMap \/>\s*<\/div>\s*<div style=\{\{ overflow: 'hidden', minHeight: 0 \}\}>\s*<CircleOfDoom \/>/);
  });
});

describe.skipIf(!haveMonza)('Monza 2024: three replay moments, focus LEC', () => {
  const lapTimes = monza?.lap_times;
  const MAX = monza ? maxLapOf(monza) : 0;
  const moments = monza ? [
    { name: 'lap 10', now: firstStartOfLap(monza, 10) + 40, lap: 10 },
    { name: 'lap 15, before LEC stops', now: 4600, lap: 15 },
    { name: 'lap 40', now: firstStartOfLap(monza, 40) + 40, lap: 40 },
  ] : [];

  for (const m of moments) {
    it(`${m.name}: renders, legend, centre text, pit window drawn from the data`, () => {
      replayAt(monza, m.now, m.lap, { focusDriver: 'LEC' });
      const markup = html();
      const text = textOf(markup);

      for (const label of LEGEND_LABELS) expect(text).toContain(label);

      // centre: lap, track status, reference lap, pit loss
      expect(text).toContain(`LAP ${m.lap}/${MAX}`);
      expect(text).toContain('Track Clear');
      const ref = referenceLap(lapTimes, { sessionNow: m.now });
      expect(ref.laps[1] - ref.laps[0] + 1).toBe(5);
      expect(text).toContain(`ref lap ${lapClock(ref.seconds)}`);
      expect(text).toContain('median of last 5 green laps');
      const est = estimatePitLoss(lapTimes, { sessionNow: m.now, sessionType: 'R' });
      if (est.source === 'fallback') {
        expect(text).toContain(`pit loss ${FALLBACK_PIT_LOSS.median.toFixed(1)} s (fallback)`);
      } else {
        expect(text).toContain(`pit loss ${est.median.toFixed(1)} s (${est.n} stops)`);
        expect(text).not.toContain('(fallback)');
      }

      // the focus pit window: band, hatched uncertainty, solid rejoin marker
      expect(markup).toMatch(/<path class="cod-pit-window" d="M[^"]+"/);
      expect(markup).toMatch(/<path class="cod-uncertainty" d="M[^"]+"[^>]*fill="url\(#cod-hatch-/);
      expect(markup).toMatch(/<path class="cod-rejoin-marker" d="M[^"]+"/);

      // ... at the rejoin point of the analytics: focus angle - rejoinOffset x 2 pi
      const st = circleState(lapTimes, { sessionNow: m.now });
      const win = pitWindow('LEC', st, est, { totalLaps: MAX, trackFlag: '1' });
      expect(win.available).toBe(true);
      const lec = st.cars.find((c) => c.driver === 'LEC');
      const angle = phaseAt(lec, m.now, st.refLap).angle - 2 * Math.PI * win.rejoinOffset;
      const { cx, cy, R } = ringOf(markup);
      const marker = translateOf(attrsOf(markup, /<g class="cod-rejoin"[^>]*>/).transform);
      expect(marker[0]).toBeCloseTo(cx + R * Math.sin(angle), 6);
      expect(marker[1]).toBeCloseTo(cy - R * Math.cos(angle), 6);

      // Task 3: the stacked probability label next to the marker, and the projected place
      const dist = rejoinDistribution('LEC', st, est, { totalLaps: MAX, trackFlag: '1' });
      const entries = expectedProbabilityEntries(dist.positions);
      expect(entries[0]).toMatch(/^P\d+ \d+%/);
      const rejoinLabel = textOf(markup.match(/<text class="cod-rejoin-label"[\s\S]*?<\/text>/)[0]).trim();
      // in position order, as stacked lines ('P7 40% · P10 19%' or one per line)
      expect(rejoinLabel.replace(/ · /g, ' ')).toContain(entries.join(' '));
      // the stacked label accounts for the whole distribution: exactly 100 %
      const shownPct = [...rejoinLabel.matchAll(/(\d+)%/g)].reduce((s, x) => s + Number(x[1]), 0);
      expect(shownPct).toBe(100);
      expect(text).toContain(`LEC pits now: P${win.currentPosition} → P${win.predictedPosition}`);
      if (win.traffic.flag) expect(text).toContain(`traffic ${trafficText(win.traffic.gapSeconds)} behind ${win.traffic.carAhead}`);
      else expect(text).not.toContain('traffic ');

      // focus car: ring; every running car is drawn
      expect(markup).toMatch(/<g class="cod-car cod-car--focus" data-driver="LEC"[^>]*>(<circle[^>]*>(<\/circle>)?)*<circle class="cod-focus-ring"/);
      expect((markup.match(/<g class="cod-car[ "]/g) || []).length).toBe(st.cars.length);
    });
  }

  it('labels: gap to the focus from the data, dimmed when not relevant, no overlaps', () => {
    replayAt(monza, 4600, 15, { focusDriver: 'LEC' });
    const markup = html();
    const text = textOf(markup);
    const st = circleState(lapTimes, { sessionNow: 4600 });
    const est = estimatePitLoss(lapTimes, { sessionNow: 4600, sessionType: 'R' });
    const win = pitWindow('LEC', st, est, { totalLaps: maxLapOf(monza), trackFlag: '1' });
    // e.g. 'SAI +4.0' and 'PIA −3.4'
    for (const d of ['SAI', 'PIA']) {
      expect(text).toContain(`${d} ${signed(gapSeconds('LEC', d, st))}`);
    }
    // cars the stop concerns keep their colour; the others are dimmed to the
    // muted text colour, never faded (no opacity on a label: text >= 4.5:1)
    const label = (d) => attrsOf(markup, new RegExp(`<text class="cod-label[^"]*"[^>]*data-driver="${d}"[^>]*>`));
    for (const x of win.wouldPassFocus) expect(label(x.driver).class).not.toContain('cod-label--dim');
    expect(label('PIA').class).not.toContain('cod-label--dim');
    expect(markup).not.toMatch(/<text class="cod-label[^"]*"[^>]*opacity=/);
    const dimmed = [...markup.matchAll(/<text class="cod-label cod-label--dim"[^>]*><tspan class="cod-label__code" fill="#A3A7B7"/g)];
    expect(dimmed.length).toBeGreaterThan(0);
    // overlap removal along the angle: no two label boxes intersect, all in the
    // slot, off the ring; a label left out of a crowded ring is counted
    const hidden = Number((markup.match(/data-hidden-labels="(\d+)"/) || [])[1]);
    expect(labelBoxes(markup).length + hidden).toBe(st.cars.length + 1);
    expect(labelProblems(markup, FALLBACK)).toEqual({ overlaps: 0, outside: 0, onRing: 0 });
  });

  it('a car in the pit lane is drawn on the inner arc (LEC between pit entry and exit)', () => {
    // LEC pit entry 4628.772, pit exit 4653.191
    replayAt(monza, 4640, 16, { focusDriver: 'LEC' });
    const markup = html();
    const { cx, cy, R, rPit } = ringOf(markup);
    expect(rPit).toBeLessThan(R);
    const car = attrsOf(markup, /<g class="cod-car[^"]*" data-driver="LEC"[^>]*>/);
    expect(car['data-pit']).toBe('true');
    const [x, y] = translateOf(car.transform);
    expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(rPit, 6);
    const other = translateOf(attrsOf(markup, /<g class="cod-car[^"]*" data-driver="PIA"[^>]*>/).transform);
    expect(Math.hypot(other[0] - cx, other[1] - cy)).toBeCloseTo(R, 6);
    // the focus is already stopping: its stop is projected
    expect(textOf(markup)).toMatch(/LEC stopping → P\d+/);
  });

  it('hovering a second car while one is focused shows the time gap between the two', () => {
    replayAt(monza, 4600, 15, { focusDriver: 'LEC', highlightedDriver: 'SAI' });
    const markup = html();
    const st = circleState(lapTimes, { sessionNow: 4600 });
    const g = gapSeconds('LEC', 'SAI', st);
    expect(markup).toMatch(/data-gap="LEC-SAI"/);
    expect(markup).toMatch(/<path class="cod-gap-arc" d="M[^"]+"/);
    expect(textOf(markup)).toContain(`${Math.abs(g).toFixed(1)} s`);
    // the hovered car carries the highlight ring
    expect(markup).toMatch(/data-driver="SAI"[^>]*>(<circle[^>]*>(<\/circle>)?)*<circle class="cod-highlight-ring"/);
  });

  it('a car selected in another view (no focus) anchors the hover gap too', () => {
    replayAt(monza, 4600, 15, { selectedDrivers: ['NOR'], highlightedDriver: 'VER' });
    const markup = html();
    expect(markup).toMatch(/data-gap="NOR-VER"/);
    const st = circleState(lapTimes, { sessionNow: 4600 });
    expect(textOf(markup)).toContain(`${Math.abs(gapSeconds('NOR', 'VER', st)).toFixed(1)} s`);
  });

  it('no focus: no pit window, a hint, no dimmed label', () => {
    replayAt(monza, 4600, 15);
    const markup = html();
    // (the legend swatches reuse the mark classes: look for the marks themselves)
    expect(markup).not.toContain('<path class="cod-pit-window"');
    expect(markup).not.toContain('<g class="cod-rejoin"');
    expect(markup).not.toContain('cod-label--dim');
    expect(textOf(markup)).toContain('click a car: pit window');
  });

  it('race sessions only: a short message otherwise', () => {
    replayAt(monza, 4600, 15, { sessionType: 'Q', loadedSessionType: 'Q', focusDriver: 'LEC' });
    const text = textOf(html());
    expect(text).toContain('The Circle of Doom applies to race sessions only (race or sprint).');
    expect(text).not.toContain('pit loss');
  });
});

describe.skipIf(!haveChina)('China 2024 under the Safety Car', () => {
  it('status, green-flag note, saturated cars at the line, no label overlap', () => {
    const lapTimes = china.lap_times;
    const NOW = 5950; // SC deployed at 5702.9
    const st = circleState(lapTimes, { sessionNow: NOW });
    const leader = st.cars[0];
    replayAt(china, NOW, leader.lapsCompleted + 1, { focusDriver: 'VER' });
    const markup = html();
    const text = textOf(markup);
    expect(text).toContain('Safety Car');
    const est = estimatePitLoss(lapTimes, { sessionNow: NOW, sessionType: 'R' });
    const win = pitWindow('VER', st, est, { totalLaps: maxLapOf(china), trackFlag: '4' });
    expect(win).toMatchObject({ available: true, neutralised: true });
    expect(text).toContain('green-flag pit loss and pace');
    expect(markup).toMatch(/<path class="cod-pit-window" d="M[^"]+"/);
    // cars whose lap runs longer than the green-flag reference lap wait just before the line
    const { cx, cy, R } = ringOf(markup);
    const saturated = st.cars.filter((c) => !c.inPitLane && phaseAt(c, NOW, st.refLap).saturated);
    expect(saturated.length).toBeGreaterThan(0);
    const a = 0.999 * 2 * Math.PI;
    for (const c of saturated) {
      const [x, y] = translateOf(attrsOf(markup, new RegExp(`<g class="cod-car[^"]*" data-driver="${c.driver}"[^>]*>`)).transform);
      expect(x).toBeCloseTo(cx + R * Math.sin(a), 6);
      expect(y).toBeCloseTo(cy - R * Math.cos(a), 6);
    }
    expect(labelProblems(markup, FALLBACK)).toEqual({ overlaps: 0, outside: 0, onRing: 0 });
  });
});

/** Every problem of a render's label boxes: overlaps, outside the drawing, inside the ring. */
function labelProblems(markup, size) {
  const { cx, cy, R } = ringOf(markup);
  const minSide = Math.min(size.width, size.height);
  // the ring's outermost marks: uncertainty arc (bandHalf + 6) or a ring around a car
  const bandHalf = Math.min(8, Math.max(4, minSide / 60));
  const carR = Math.min(7, Math.max(3.5, minSide / 70));
  const rClear = R + Math.max(bandHalf + 6, carR * 1.35 + 5.5);
  const boxes = labelBoxes(markup);
  const out = { overlaps: 0, outside: 0, onRing: 0 };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (overlapArea(boxes[i], boxes[j]) > 0) out.overlaps += 1;
    const b = boxes[i];
    if (b[0] < 0 || b[1] < 0 || b[2] > size.width || b[3] > size.height) out.outside += 1;
    const dx = Math.max(b[0] - cx, 0, cx - b[2]);
    const dy = Math.max(b[1] - cy, 0, cy - b[3]);
    if (Math.hypot(dx, dy) < rClear) out.onRing += 1;
  }
  return out;
}

const htmlAt = (size) => renderToString(React.createElement(CircleOfDoom, { size }));
const PIT_WALL = { width: 391, height: 306 };

describe.skipIf(!haveMonza || !haveChina)('labels never overlap, stay in the slot and off the ring', () => {
  it('the cases that overlapped: China after the flag (all cars at the line), Monza 3468 s PIA, Monza 7457 s LEC', () => {
    const cases = [
      { session: china, now: 9504.2, lap: maxLapOf(china), extra: {} },
      { session: monza, now: 3468, lap: 6, extra: { focusDriver: 'PIA' } },
      { session: monza, now: 7457, lap: 49, extra: { focusDriver: 'LEC' } },
    ];
    for (const c of cases) {
      for (const size of [FALLBACK, PIT_WALL]) {
        replayAt(c.session, c.now, c.lap, c.extra);
        const markup = htmlAt(size);
        expect(markup).toContain('data-layout="fits"');
        expect(labelProblems(markup, size)).toEqual({ overlaps: 0, outside: 0, onRing: 0 });
      }
    }
    // China after the flag: every car is at phase 0, the labels fan out around the top
    replayAt(china, 9504.2, maxLapOf(china));
    const angles = [...htmlAt(PIT_WALL).matchAll(/data-angle="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBe(angles.length);
  });

  it('the last replay frame (sessionNow = Infinity, every car at the line)', () => {
    const maxTime = 99999;
    replayAt(monza, 0, maxLapOf(monza), { maxTime, frameDt: 0.5, focusDriver: 'LEC' });
    useF1Store.setState({ currentTime: maxTime });
    for (const size of [FALLBACK, PIT_WALL]) {
      const markup = htmlAt(size);
      expect(textOf(markup)).toContain('LEC: race over: no pit window');
      expect(labelProblems(markup, size)).toEqual({ overlaps: 0, outside: 0, onRing: 0 });
    }
  });

  for (const [name, getSession] of [['Monza 2024', () => monza], ['China 2024', () => china]]) {
    it(`${name}: every 150 s from the start to after the flag, five focus choices, two slot sizes`, () => {
      const session = getSession();
      const lapTimes = session.lap_times;
      const last = maxLapOf(session);
      const start = firstStartOfLap(session, 1);
      const end = Math.max(...lapTimes.map((r) => r.Time ?? 0)) + 60;
      const total = { renders: 0, windows: 0, overlaps: 0, outside: 0, onRing: 0, clamped: 0 };
      for (let now = start - 30; now < end; now += 150) {
        const st = circleState(lapTimes, { sessionNow: now });
        const picks = new Set([null, st.cars[0]?.driver, st.cars[Math.floor(st.cars.length / 2)]?.driver,
          st.cars[st.cars.length - 1]?.driver, st.cars.find((c) => c.inPitLane)?.driver]);
        for (const focus of picks) {
          replayAt(session, now, Math.min(last, (st.cars[0]?.lapsCompleted ?? 0) + 1), { focusDriver: focus ?? null });
          for (const size of [FALLBACK, PIT_WALL]) {
            const markup = htmlAt(size);
            total.renders += 1;
            if (markup.includes('<g class="cod-rejoin"')) total.windows += 1;
            if (markup.includes('data-layout="clamped"')) total.clamped += 1;
            const p = labelProblems(markup, size);
            total.overlaps += p.overlaps;
            total.outside += p.outside;
            total.onRing += p.onRing;
          }
        }
      }
      expect(total.windows).toBeGreaterThan(100);
      expect({ ...total, renders: 0, windows: 0 }).toEqual({
        renders: 0, windows: 0, overlaps: 0, outside: 0, onRing: 0, clamped: 0,
      });
    }, 120000);
  }
});

describe.skipIf(!haveMonza)('coordination with the Track Map: a selection made there is drawn on the circle', () => {
  it('a selected car gets the red ring; without a focus the other labels are dimmed', () => {
    replayAt(monza, 4600, 15);
    const plain = html();
    replayAt(monza, 4600, 15, { selectedDrivers: ['HAM'] });
    const markup = html();
    expect(markup).not.toBe(plain);
    expect(markup).toMatch(/<g class="cod-car cod-car--selected" data-driver="HAM"[^>]*>(<circle[^>]*>(<\/circle>)?)*<circle class="cod-select-ring"/);
    expect((markup.match(/<circle class="cod-select-ring"/g) || []).length).toBe(1);
    const label = (d) => attrsOf(markup, new RegExp(`<text class="cod-label[^"]*"[^>]*data-driver="${d}"[^>]*>`));
    expect(label('HAM').class).not.toContain('cod-label--dim');
    expect(label('HAM').class).toContain('cod-label--selected');
    // a context label is drawn in the muted text colour (never faded)
    expect(label('ALB').class).toContain('cod-label--dim');
    expect(markup).toMatch(/data-driver="ALB"[^>]*><tspan class="cod-label__code" fill="#A3A7B7"/);
    expect(textOf(markup)).toContain('selected car');
  });

  it('with a focus, selected cars keep their ring and full opacity', () => {
    replayAt(monza, 4600, 15, { focusDriver: 'LEC', selectedDrivers: ['ZHO', 'HAM'] });
    const markup = html();
    for (const d of ['ZHO', 'HAM']) {
      expect(markup).toMatch(new RegExp(`data-driver="${d}"[^>]*>(<circle[^>]*>(</circle>)?)*<circle class="cod-select-ring"`));
      expect(attrsOf(markup, new RegExp(`<text class="cod-label[^"]*"[^>]*data-driver="${d}"[^>]*>`)).class).not.toContain('cod-label--dim');
    }
  });
});

describe.skipIf(!haveMonza)('pit window closes at the flag', () => {
  it("after the leader's flag a running car shows 'chequered flag'", () => {
    replayAt(monza, 7831.479 + 1, maxLapOf(monza), { focusDriver: 'OCO' });
    const markup = html();
    expect(textOf(markup)).toContain('OCO: chequered flag: no pit window');
    expect(markup).not.toContain('<g class="cod-rejoin"');
  });
});

describe('dock and docked layout', () => {
  it('a dock saved before the circle existed gets it once, after Strategy; removing it sticks', async () => {
    const OLD = ['pitwall', 'laptimes', 'tyres', 'strategy', 'analytics', 'prediction', 'racecontrol', 'ai', 'championship'];
    localStorage.clear();
    localStorage.setItem('va-dock-items-v1', JSON.stringify(OLD));
    vi.resetModules();
    let store = (await import('../store/useF1Store.js')).useF1Store;
    const items = store.getState().dockItems;
    expect(items).toEqual(['pitwall', 'laptimes', 'tyres', 'strategy', 'circle', 'analytics', 'prediction', 'racecontrol', 'ai', 'championship']);
    // saved at once with the list of defaults offered, so the two never disagree
    expect(JSON.parse(localStorage.getItem('va-dock-items-v1'))).toEqual(items);
    expect(JSON.parse(localStorage.getItem('va-dock-offered-v1'))).toContain('circle');
    // the user removes it: the next load keeps it out
    localStorage.setItem('va-dock-items-v1', JSON.stringify(OLD));
    vi.resetModules();
    store = (await import('../store/useF1Store.js')).useF1Store;
    expect(store.getState().dockItems).toEqual(OLD);
    // a first visit gets the defaults
    localStorage.clear();
    vi.resetModules();
    store = (await import('../store/useF1Store.js')).useF1Store;
    expect(store.getState().dockItems).toContain('circle');
    localStorage.clear();
  });

  it("docked panes name the circle tab 'Circle of Doom' and can add it", async () => {
    const src = fs.readFileSync(path.join(SRC, 'components/layout/DockedLayout.jsx'), 'utf8');
    expect(src).toMatch(/\{ id: 'circle', label: 'Circle of Doom' \}/);
    // the same module registry as the layout (the test above reset it)
    const { default: DockedLayout } = await import('../components/layout/DockedLayout.jsx');
    const { useF1Store: store } = await import('../store/useF1Store.js');
    store.setState({ dockedLayout: WINDOW_PRESETS.pitwindow.dockedLayout });
    const none = { Component: () => null };
    const markup = renderToString(React.createElement(DockedLayout, {
      vizComponents: { trackmap: none, circle: none, strategy: none },
    }));
    expect(textOf(markup)).toContain('Circle of Doom');
    expect(textOf(markup)).toContain('Track Map');
    expect(markup).not.toMatch(/>circle</);
  });
});

/** Inside the pit lane: room radius, centre-line boxes, the gap readout's box, pit-lane car marks. */
function innerOf(markup) {
  const g = attrsOf(markup, /<g class="cod-centre"[^>]*>/);
  const parse = (s) => s.split(',').map(Number);
  const centre = [...markup.matchAll(/<text class="cod-centre__[^"]*"[^>]*data-inner-box="([^"]+)"/g)].map((m) => parse(m[1]));
  const gap = markup.match(/<text class="cod-gap-text"[^>]*data-inner-box="([^"]+)"/);
  const pits = [...markup.matchAll(/<g class="cod-car[^"]*" data-driver="[^"]+" data-pit="true"[^>]*>/g)]
    .map((m) => translateOf(attrsOf(m[0], /<g[^>]*>/).transform));
  return {
    rInner: Number(g['data-inner-r']), fits: g['data-inner-fits'] === 'true', centre, gap: gap ? parse(gap[1]) : null, pits,
  };
}

function cornerDistance(box, cx, cy) {
  return Math.hypot(Math.max(Math.abs(box[0] - cx), Math.abs(box[2] - cx)), Math.max(Math.abs(box[1] - cy), Math.abs(box[3] - cy)));
}

/** Problems inside the pit lane: gap readout on a centre line, text outside the room, pit-lane car on the text. */
function innerProblems(markup, size) {
  const { cx, cy } = ringOf(markup);
  const inner = innerOf(markup);
  const minSide = Math.min(size.width, size.height);
  const carR = Math.min(7, Math.max(3.5, minSide / 70));
  // largest mark of a pit-lane car: the focus dot (1.35 carR) and its ring (+ 3.5)
  const carMark = carR * 1.35 + 3.5;
  const out = {
    gapOnCentre: 0, outsideRoom: 0, pitCarOnText: 0, centreClamped: inner.fits ? 0 : 1,
  };
  const texts = inner.gap ? [...inner.centre, inner.gap] : inner.centre;
  // (attributes are rounded to 0.1 px and the radius to 0.01 px)
  for (const b of texts) if (cornerDistance(b, cx, cy) > inner.rInner + 0.1) out.outsideRoom += 1;
  if (inner.gap) for (const b of inner.centre) if (overlapArea(b, inner.gap) > 0) out.gapOnCentre += 1;
  for (const [x, y] of inner.pits) {
    // nearest point of the text box to the car centre, within the car mark
    for (const b of texts) {
      if (Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3])) < carMark - 0.1) out.pitCarOnText += 1;
    }
  }
  return out;
}

const DOCKED = { width: 606, height: 446 };
const PIT_WALL_1680 = { width: 427, height: 239 };

describe.skipIf(!haveMonza || !haveChina)('inside the pit lane: the hover gap readout never covers the centre text', () => {
  it('China 2024 at 4726.2 s, lap 14, focus VER, hovering NOR, PER and LEC (the reported case)', () => {
    for (const hover of ['NOR', 'PER', 'LEC']) {
      for (const size of [PIT_WALL_1680, PIT_WALL, FALLBACK, DOCKED]) {
        replayAt(china, 4726.2, 14, { focusDriver: 'VER', highlightedDriver: hover });
        const markup = htmlAt(size);
        expect(markup).toMatch(new RegExp(`data-gap="VER-${hover}"`));
        const inner = innerOf(markup);
        // at the data type (>= 11 px) the 427 x 239 slot can leave the readout
        // no room inside the ring even with the notes stepped aside: it is then
        // in the hovered car's tooltip ("Gap to VER"); the other slots draw it
        const place = (markup.match(/data-gap-place="([a-z]+)"/) || [])[1];
        if (size === PIT_WALL_1680 && place === 'tooltip') {
          expect(inner.gap).toBeNull();
        } else {
          expect(place).toBe('ring');
          expect(inner.gap).not.toBeNull();
        }
        expect(innerProblems(markup, size)).toEqual({
          gapOnCentre: 0, outsideRoom: 0, pitCarOnText: 0, centreClamped: 0,
        });
      }
    }
  });

  for (const [name, getSession] of [['Monza 2024', () => monza], ['China 2024', () => china]]) {
    it(`${name}: every 120 s, three focus choices, the nearest rivals hovered, four slot sizes`, () => {
      const session = getSession();
      const lapTimes = session.lap_times;
      const last = maxLapOf(session);
      const start = firstStartOfLap(session, 2);
      const flag = Math.max(...lapTimes.filter((r) => r.LapNumber === last).map((r) => r.Time ?? 0));
      const total = {
        renders: 0, readouts: 0, inCentre: 0, gapOnCentre: 0, outsideRoom: 0, pitCarOnText: 0, centreClamped: 0,
      };
      for (let now = start; now < flag; now += 120) {
        const st = circleState(lapTimes, { sessionNow: now });
        const focuses = new Set([st.cars[0]?.driver, st.cars[Math.floor(st.cars.length / 2)]?.driver,
          st.cars.find((c) => c.inPitLane)?.driver].filter(Boolean));
        for (const focus of focuses) {
          // the three cars nearest the focus in time, and the car furthest from it
          const rivals = st.cars.filter((c) => c.driver !== focus)
            .map((c) => ({ d: c.driver, g: Math.abs(gapSeconds(focus, c.driver, st) ?? Infinity) }))
            .filter((x) => Number.isFinite(x.g))
            .sort((a, b) => a.g - b.g);
          const hovers = [...rivals.slice(0, 3), rivals[rivals.length - 1]].filter(Boolean).map((x) => x.d);
          for (const hover of hovers) {
            replayAt(session, now, Math.min(last, st.cars[0].lapsCompleted + 1), { focusDriver: focus, highlightedDriver: hover });
            for (const size of [FALLBACK, PIT_WALL, PIT_WALL_1680, DOCKED]) {
              const markup = htmlAt(size);
              total.renders += 1;
              if (markup.includes('class="cod-gap-text"')) total.readouts += 1;
              else if (markup.includes('data-gap=')) total.inCentre += 1;
              const p = innerProblems(markup, size);
              for (const k of ['gapOnCentre', 'outsideRoom', 'pitCarOnText', 'centreClamped']) total[k] += p[k];
            }
          }
        }
      }
      console.log(`${name}: ${JSON.stringify(total)}`);
      expect(total.readouts).toBeGreaterThan(300);
      expect({
        gapOnCentre: total.gapOnCentre, outsideRoom: total.outsideRoom, pitCarOnText: total.pitCarOnText, centreClamped: total.centreClamped,
      }).toEqual({
        gapOnCentre: 0, outsideRoom: 0, pitCarOnText: 0, centreClamped: 0,
      });
    }, 180000);
  }
});

describe.skipIf(!haveMonza || !haveChina)('the stacked rejoin label adds up to 100 %', () => {
  it('Monza and China, every 60 s, every fifth car focused, Pit Wall size', () => {
    let labels = 0;
    let off = 0;
    for (const session of [monza, china]) {
      const lapTimes = session.lap_times;
      const last = maxLapOf(session);
      const flag = Math.max(...lapTimes.filter((r) => r.LapNumber === last).map((r) => r.Time ?? 0));
      for (let now = firstStartOfLap(session, 2); now < flag; now += 60) {
        const st = circleState(lapTimes, { sessionNow: now });
        for (const car of st.cars.filter((_, i) => i % 5 === 0)) {
          replayAt(session, now, Math.min(last, st.cars[0].lapsCompleted + 1), { focusDriver: car.driver });
          const m = htmlAt(PIT_WALL).match(/<text class="cod-rejoin-label"[\s\S]*?<\/text>/);
          if (!m) continue;
          labels += 1;
          const sum = [...textOf(m[0]).matchAll(/(\d+)%/g)].reduce((s, x) => s + Number(x[1]), 0);
          if (sum !== 100) off += 1;
        }
      }
    }
    console.log(`rejoin labels: ${labels}, not adding up to 100 %: ${off}`);
    expect(labels).toBeGreaterThan(300);
    expect(off).toBe(0);
  }, 180000);
});

describe.skipIf(!haveMonza)('lap 1: a car not yet across the line has no pit window', () => {
  it('Monza 2024 at 3439.4 s: NOR (still on lap 1) shows the reason, no band', () => {
    replayAt(monza, 3439.4, 1, { focusDriver: 'NOR' });
    const markup = html();
    const st = circleState(monza.lap_times, { sessionNow: 3439.4 });
    expect(st.cars.find((c) => c.driver === 'NOR').lapsCompleted).toBe(0);
    expect(textOf(markup)).toContain('NOR: no pit window before it crosses the line');
    expect(markup).not.toContain('<g class="cod-rejoin"');
    expect(markup).not.toContain('<path class="cod-pit-window"');
  });
});

describe.skipIf(!haveMonza || !haveChina)('a flagged traffic gap never reads as the 1.0 s threshold', () => {
  it('gaps of 0.95-0.999 s are printed with two decimals, rounded down', () => {
    const found = [];
    for (const session of [china, monza]) {
      const lapTimes = session.lap_times;
      const last = maxLapOf(session);
      for (let now = firstStartOfLap(session, 3); now < firstStartOfLap(session, last - 2) && found.length < 6; now += 20) {
        const st = circleState(lapTimes, { sessionNow: now });
        const est = estimatePitLoss(lapTimes, { sessionNow: now, sessionType: 'R' });
        for (const c of st.cars) {
          const w = pitWindow(c.driver, st, est, { totalLaps: last });
          if (w.available && w.traffic.flag && w.traffic.gapSeconds >= 0.95) {
            found.push({ session, now, focus: c.driver, gap: w.traffic.gapSeconds, ahead: w.traffic.carAhead, lap: st.cars[0].lapsCompleted + 1 });
            break;
          }
        }
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const f of found) {
      replayAt(f.session, f.now, f.lap, { focusDriver: f.focus });
      const label = textOf(htmlAt(FALLBACK).match(/<text class="cod-rejoin-label"[\s\S]*?<\/text>/)[0]);
      const printed = `${(Math.floor(f.gap * 100) / 100).toFixed(2)} s`;
      expect(printed).toMatch(/^0\.9\d s$/);
      expect(label).toContain(`traffic ${printed} behind ${f.ahead}`);
      expect(label).not.toContain('traffic 1.0 s');
    }
  }, 120000);
});
