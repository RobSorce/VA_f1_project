// The PCA biplot (components/visualizations/PCABiplot.jsx) mounted with the
// real artefact (backend/data/processed/pca_embeddings.json) in a minimal DOM
// (helpers/miniDom.js), its marks and legends read back:
//  - every team name maps to a colour, the legend has every team drawn
//    (11 in the artefact) with swatches equal to the marks (same path, same
//    fill), and the star of the loaded race has a star swatch;
//  - a race filter (all / season / this race) and the finishing position
//    as a sequential colour with its legend, in the tooltip too; the loaded
//    race's own result is withheld until that race has been run at the clock
//    on screen (its own replay at its end; never during another session of
//    the weekend);
//  - during a replay of the loaded race the biplot asks for its rows at
//    the replay clock (store loadPCAEmbeddings, backend pca_embeddings_at) and
//    draws them, labelled "at lap N"; its post-race rows are never drawn
//    before the race has ended.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { CACHE_DIR } from './helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDINGS_FILE = path.resolve(HERE, '../../../backend/data/processed/pca_embeddings.json');

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.getPCAEmbeddings = vi.fn(async (clock) => (clock ? globalThis.__pcaAtClock(clock) : globalThis.__pcaEmbeddings));
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
const d3 = await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { getTeamColor, UNKNOWN_TEAM_COLOR } = await import('../utils/colors.js');
const api = await import('../utils/apiClient');
const {
  markPath, OUTCOME_CLASSES, OUTCOME_PENDING, PODIUM_PLACES, POINTS_PLACES, outcomeClass,
  causalPoints, shownFinish, pointFill, loadedRaceOf, loadedRaceClock, loadedResultHidden,
} = await import('../utils/views/pcaBiplot.js');
const { default: PCABiplot } = await import('../components/visualizations/PCABiplot.jsx');

const EMBEDDINGS = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
globalThis.__pcaEmbeddings = EMBEDDINGS;
const INITIAL = useF1Store.getState();
const TEAMS = [...new Set(EMBEDDINGS.points.map((p) => p.team))];
const LOADED = { year: 2024, round: 16 };
const loadedRows = EMBEDDINGS.points.filter((p) => p.year === LOADED.year && p.round === LOADED.round);

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// Stand-in for the backend's answer at a race clock (pca_compute.pca_embeddings_at,
// tested in backend/tests/test_pca_causal.py): the loaded race's rows at the
// clock (as_of 'session_now', as of lap 10, no finishing position, other
// positions), none before the race (session_now 0)
const AT_LAP = 10;
globalThis.__pcaAtClock = ({ year, round, session_now: now }) => {
  const isRace = (p) => p.year === year && p.round === round;
  const rows = now > 0
    ? EMBEDDINGS.points.filter(isRace).map((p) => ({
      ...p, x: p.x / 2, y: p.y / 2, as_of: 'session_now', as_of_lap: AT_LAP, finish_position: null,
    }))
    : [];
  const points = [...EMBEDDINGS.points.filter((p) => !isRace(p)), ...rows];
  return {
    ...EMBEDDINGS, points, n_points: points.length, features_as_of: 'mixed',
    current_race: {
      year, round, available: true, session_now: now, as_of: 'session_now', as_of_lap: now > 0 ? AT_LAP : 0,
      n_points: rows.length, excluded_from_fit: true, reason: rows.length ? null : 'no row yet',
    },
  };
};

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 640, height: 420 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(PCABiplot)); });
  return {
    host,
    svg: () => host.querySelector('.viz-container svg'),
    marks: () => [...host.querySelectorAll('.viz-container svg path.pca-point')],
    legend: () => [...host.querySelectorAll('.pca-legends .legend-item')].map((el) => {
      const p = el.querySelector('svg path');
      return {
        label: text(el.querySelector('.legend-label')),
        path: p?.getAttribute('d'),
        fill: p?.style.fill,
        stroke: p?.style.stroke || '',
        className: p?.getAttribute('class') || '',
      };
    }),
    legendTitles: () => [...host.querySelectorAll('.pca-legends .legend-title')].map(text),
    button: (label) => [...host.querySelectorAll('.panel-controls button')].find((b) => text(b) === label),
    async click(label) {
      const b = this.button(label);
      expect(b, `button ${label}`).toBeTruthy();
      await act(async () => { dom.mouse(b, 'click'); });
    },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const setLoaded = (extra = {}) => useF1Store.setState({
  ...INITIAL,
  pcaEmbeddings: EMBEDDINGS, selectedPCAPoints: [], selectedDrivers: [],
  loadedYear: LOADED.year, loadedRound: LOADED.round, loadedSessionType: 'R',
  ...extra,
});

describe('the loaded race at the clock on screen (view model, P2 / P6)', () => {
  const lec = EMBEDDINGS.points.find((p) => p.id === 'LEC_2024_16');
  it('a session of the weekend other than the race: result withheld, post-race rows never drawn', () => {
    expect(lec.finish_position).toBe(1);
    for (const sessionType of ['FP1', 'FP2', 'FP3', 'Q', 'SQ', 'S']) {
      const loaded = loadedRaceOf({ ...LOADED, sessionType });
      // at its last frame the session clock is Infinity: the race is still to come
      const ctx = { loaded, resultHidden: loadedResultHidden({ sessionType, sessionNow: Infinity, isLiveMode: false }) };
      expect(loadedRaceClock({ sessionType, sessionNow: Infinity })).toBe('not-started');
      expect(ctx.resultHidden).toBe(true);
      expect(shownFinish(lec, ctx)).toBeNull();
      expect(pointFill(lec, 'finish', ctx)).toBe(OUTCOME_PENDING.color);
      // without the session type in resultHidden, the loaded race's type still withholds it
      expect(shownFinish(lec, { loaded, resultHidden: false })).toBeNull();
      expect(causalPoints(EMBEDDINGS.points, ctx).filter((p) => p.year === 2024 && p.round === 16)).toEqual([]);
    }
  });

  it('the race on screen: withheld while its clock runs, shown at its end', () => {
    const loaded = loadedRaceOf({ ...LOADED, sessionType: 'R' });
    expect(loadedRaceClock({ sessionType: 'R', sessionNow: 4200 })).toBe('running');
    expect(loadedRaceClock({ sessionType: 'R', sessionNow: Infinity, isLiveMode: true })).toBe('running');
    expect(loadedRaceClock({ sessionType: 'R', sessionNow: Infinity })).toBe('ended');
    const running = { loaded, resultHidden: true };
    expect(shownFinish(lec, running)).toBeNull();
    // post-race rows of the race are not drawn while it runs; rows at the clock are
    const atClock = { ...lec, as_of: 'session_now', as_of_lap: 10, finish_position: null };
    expect(causalPoints([lec, atClock], running)).toEqual([atClock]);
    expect(shownFinish(lec, { loaded, resultHidden: false })).toBe(1);
    expect(causalPoints([lec], { loaded, resultHidden: false })).toEqual([lec]);
  });
});

describe('team colours (P5)', () => {
  it('every team name of the artefact maps to a colour (none on the fallback grey)', () => {
    expect(TEAMS.length).toBe(11);
    for (const t of TEAMS) expect(getTeamColor(t), t).not.toBe(UNKNOWN_TEAM_COLOR);
    expect(getTeamColor('Racing Bulls')).toBe(getTeamColor('RB'));
  });

  // the backend creates the cache directory (empty) when it starts: the test needs a session file in it
  const haveSessions = fs.existsSync(CACHE_DIR) && fs.readdirSync(CACHE_DIR).some((n) => /^session_.*\.json$/.test(n));
  it.skipIf(!haveSessions)('every TeamName of the cached sessions maps to a colour', () => {
    const names = new Set();
    for (const f of fs.readdirSync(CACHE_DIR).filter((n) => /^session_.*\.json$/.test(n))) {
      const raw = fs.readFileSync(path.join(CACHE_DIR, f), 'utf8').replace(/\bNaN\b/g, 'null');
      for (const d of JSON.parse(raw).driver_info || []) if (d?.TeamName) names.add(d.TeamName);
    }
    expect(names.size).toBeGreaterThanOrEqual(11);
    const grey = [...names].filter((t) => getTeamColor(t) === UNKNOWN_TEAM_COLOR);
    expect(grey).toEqual([]);
  });

  it('an exact name wins over a fuzzy match', () => {
    expect(getTeamColor('Red Bull Racing')).toBe('#3671C6');
    expect(getTeamColor('red bull racing')).toBe('#3671C6');
    expect(getTeamColor('Visa Cash App RB')).toBe(getTeamColor('RB'));
    expect(getTeamColor(null)).toBe(UNKNOWN_TEAM_COLOR);
  });
});

describe('PCA biplot legend and marks (P5)', () => {
  let view;
  beforeAll(async () => { setLoaded(); view = await mount(); });
  afterAll(async () => { await view?.unmount(); });

  it('the colour legend lists every team drawn (11), swatch = the mark', () => {
    expect(view.marks().length).toBe(EMBEDDINGS.points.length);
    expect(view.legendTitles()).toEqual(['Colour: team', 'Shape']);
    const legend = view.legend();
    const teamEntries = legend.filter((it) => TEAMS.includes(it.label));
    expect(teamEntries.map((it) => it.label).sort()).toEqual([...TEAMS].sort());
    // each swatch: the circle the marks are drawn with, in the marks' fill
    for (const it of teamEntries) {
      const fills = new Set(view.marks().filter((m) => m.__data__.team === it.label).map((m) => m.getAttribute('fill')));
      expect([...fills], it.label).toEqual([it.fill]);
      expect(it.path).toBe(markPath(false));
    }
    // no mark is grey
    expect(view.marks().filter((m) => m.getAttribute('fill') === UNKNOWN_TEAM_COLOR)).toEqual([]);
  });

  it('the loaded race: star marks and a star swatch with the same path and outline class', () => {
    const stars = view.marks().filter((m) => m.getAttribute('d') === markPath(true));
    expect(stars.length).toBe(loadedRows.length);
    expect(stars.every((m) => m.getAttribute('class').includes('pca-point--current'))).toBe(true);
    const starEntry = view.legend().find((it) => it.path === markPath(true));
    // the race has ended (clock at the end): whole-race rows, and the label says so
    expect(starEntry.label).toBe(`${LOADED.year} R${LOADED.round} whole race (on screen)`);
    expect(starEntry.className).toBe('pca-point--current');
    const circleEntry = view.legend().find((it) => it.label === 'Other races (whole race)');
    expect(circleEntry.path).toBe(markPath(false));
    // the old swatch was a gold bar while the marks were team-coloured stars
    expect(view.legend().some((it) => it.label === 'Current Race')).toBe(false);
  });

  it('no loaded session: no star marks and no shape legend', async () => {
    await act(async () => { useF1Store.setState({ loadedYear: null, loadedRound: null }); });
    try {
      expect(view.marks().filter((m) => m.getAttribute('d') === markPath(true))).toEqual([]);
      expect(view.legendTitles()).toEqual(['Colour: team']);
      expect(view.button('This race').hasAttribute('disabled')).toBe(true);
    } finally {
      await act(async () => { useF1Store.setState({ loadedYear: LOADED.year, loadedRound: LOADED.round }); });
    }
  });
});

describe('PCA biplot race filter and outcome colour (P2)', () => {
  let view;
  beforeAll(async () => { setLoaded(); view = await mount(); });
  afterAll(async () => { await view?.unmount(); });

  it('the filter keeps the loaded race / its season, at fixed positions', async () => {
    const pos = new Map(view.marks().map((m) => [m.__data__.id, m.getAttribute('transform')]));
    await view.click('This race');
    expect(view.marks().map((m) => m.__data__.id).sort()).toEqual(loadedRows.map((p) => p.id).sort());
    for (const m of view.marks()) expect(m.getAttribute('transform')).toBe(pos.get(m.__data__.id));
    expect(view.button('This race').getAttribute('aria-checked')).toBe('true');
    // the legend follows the marks drawn
    const teamsHere = [...new Set(loadedRows.map((p) => p.team))];
    expect(view.legend().filter((it) => it.path === markPath(false) && it.label !== 'Other races (whole race)').map((it) => it.label).sort())
      .toEqual(teamsHere.sort());

    await view.click('2024 season');
    expect(view.marks().length).toBe(EMBEDDINGS.points.filter((p) => p.year === 2024).length);
    expect(view.marks().every((m) => m.__data__.year === 2024)).toBe(true);

    await view.click('All races');
    expect(view.marks().length).toBe(EMBEDDINGS.points.length);
  });

  it('a loaded race outside the PCA set disables "This race"', async () => {
    await act(async () => { useF1Store.setState({ loadedYear: 2026, loadedRound: 1 }); });
    try {
      const b = view.button('This race');
      expect(b.hasAttribute('disabled')).toBe(true);
      expect(b.getAttribute('title')).toMatch(new RegExp(`2026 R1 is not among the ${EMBEDDINGS.n_races} races`));
    } finally {
      await act(async () => { useF1Store.setState({ loadedYear: LOADED.year, loadedRound: LOADED.round }); });
    }
  });

  it('colour = finish: three sequential classes, legend = marks, brighter = better', async () => {
    await view.click('Finish');
    expect(view.legendTitles()[0]).toBe('Colour: finish');
    const legend = view.legend();
    expect(legend.slice(0, 3).map((it) => it.label)).toEqual([
      `Podium (P1–P${PODIUM_PLACES})`, `Points (P${PODIUM_PLACES + 1}–P${POINTS_PLACES})`, `No points (P${POINTS_PLACES + 1}+)`,
    ]);
    for (const c of OUTCOME_CLASSES) {
      const entry = legend.find((it) => it.label === c.label);
      expect(entry.fill).toBe(c.color);
      const fills = new Set(view.marks()
        .filter((m) => outcomeClass(m.__data__.finish_position) === c.key)
        .map((m) => m.getAttribute('fill')));
      expect([...fills], c.key).toEqual([c.color]);
    }
    // sequential: lightness falls from podium to no points
    const L = OUTCOME_CLASSES.map((c) => d3.lab(c.color).l);
    expect(L[0]).toBeGreaterThan(L[1]);
    expect(L[1]).toBeGreaterThan(L[2]);
    // every artefact row is classified: no pending entry after the race
    expect(legend.some((it) => it.label === OUTCOME_PENDING.label)).toBe(false);
  });

  it('the tooltip shows grid and finishing position', async () => {
    const m = view.marks().find((x) => x.__data__.id === 'PIA_2024_16');
    await act(async () => { dom.mouse(m, 'mouseenter', { clientX: 5, clientY: 5, bubbles: false }); });
    const tip = dom.document.querySelector('.pca-tooltip').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const p = m.__data__;
    expect(tip).toContain(`Grid P${p.grid_position}`);
    expect(tip).toContain(`Finish P${p.finish_position}`);
    expect(tip).toContain('Features as of end of race');
  });

  it('while the loaded race replays: its rows at the replay clock, its result withheld (P6, P2)', async () => {
    // a replay of the loaded race half way: the session clock is finite
    await act(async () => {
      useF1Store.setState({ totalFrames: 1000, currentTime: 500, sessionTimeOffset: 0, maxTime: 1000, frameDt: 1 });
    });
    await settle();
    expect(Number.isFinite(useF1Store.getState().getSessionNow())).toBe(true);
    // the biplot asked for the race's rows at the replay clock
    expect(api.getPCAEmbeddings).toHaveBeenLastCalledWith({ year: LOADED.year, round: LOADED.round, session_now: 500 });
    const stars = view.marks().filter((m) => m.getAttribute('d') === markPath(true));
    expect(stars.length).toBe(loadedRows.length);
    // every star is a row at the clock, none a post-race row
    expect(stars.every((m) => m.__data__.as_of === 'session_now' && m.__data__.as_of_lap === AT_LAP)).toBe(true);
    expect(new Set(stars.map((m) => m.getAttribute('fill')))).toEqual(new Set(['none']));
    // the shape legend says what the stars are taken at, without a hover
    const starEntry = view.legend().find((it) => it.path === markPath(true));
    expect(starEntry.label).toBe(`${LOADED.year} R${LOADED.round} at lap ${AT_LAP} (on screen)`);
    // other races keep their class colours
    const others = view.marks().filter((m) => m.getAttribute('d') !== markPath(true));
    expect(others.every((m) => OUTCOME_CLASSES.some((c) => c.color === m.getAttribute('fill')))).toBe(true);
    expect(view.legend().some((it) => it.label === OUTCOME_PENDING.label)).toBe(true);
    await act(async () => { dom.mouse(stars[0], 'mouseenter', { clientX: 5, clientY: 5, bubbles: false }); });
    const tip = dom.document.querySelector('.pca-tooltip').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(tip).toContain('Finish shown when the race ends');
    expect(tip).toContain(`Features as of lap ${AT_LAP}`);
    expect(tip).toContain('Replay clock');
    const post = loadedRows.find((p) => p.id === stars[0].__data__.id);
    expect(tip).not.toContain(`Finish P${post.finish_position}`);

    // the replay reaches its end: the whole-race rows and the result are shown
    await act(async () => { useF1Store.setState({ currentTime: 999.5 }); });
    await settle();
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
    expect(api.getPCAEmbeddings).toHaveBeenLastCalledWith(null);
    const after = view.marks().filter((m) => m.getAttribute('d') === markPath(true));
    expect(after.length).toBe(loadedRows.length);
    expect(after.every((m) => m.__data__.as_of === 'post-race' && m.getAttribute('fill') !== 'none')).toBe(true);
    await act(async () => { useF1Store.setState({ totalFrames: 0, currentTime: 0 }); });
    await settle();
  });

  it('another session of the weekend on screen (a sprint at its last frame): the race has not started', async () => {
    // the session clock is Infinity at the end of the sprint
    await act(async () => {
      useF1Store.setState({
        loadedSessionType: 'S', totalFrames: 1000, currentTime: 999.5, sessionTimeOffset: 0, maxTime: 1000, frameDt: 1,
      });
    });
    await settle();
    try {
      expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
      expect(api.getPCAEmbeddings).toHaveBeenLastCalledWith({ year: LOADED.year, round: LOADED.round, session_now: 0 });
      expect(view.marks().filter((m) => m.getAttribute('d') === markPath(true))).toEqual([]);
      expect(view.marks().filter((m) => m.__data__.year === LOADED.year && m.__data__.round === LOADED.round)).toEqual([]);
      const b = view.button('This race');
      expect(b.hasAttribute('disabled')).toBe(true);
      expect(b.getAttribute('title')).toBe(`The race of ${LOADED.year} R${LOADED.round} has not started: the session on screen is S`);
    } finally {
      await act(async () => { useF1Store.setState({ loadedSessionType: 'R', totalFrames: 0, currentTime: 0 }); });
      await settle();
    }
  });

  it('the lasso tests only the points drawn', async () => {
    await view.click('This race');
    const group = view.svg().querySelector('g');
    // a polygon around the whole plot area
    const [x0, y0, x1, y1] = [-40, -10, 600, 380];
    const poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 1]];
    const client = poly.map(([x, y]) => dom.toClient(group, x, y));
    const capture = group.querySelector('rect.lasso-capture');
    expect(capture).toBeTruthy();
    await act(async () => {
      dom.mouse(capture, 'mousedown', { ...client[0], shiftKey: true });
      for (const c of client.slice(1)) dom.mouse(dom.window, 'mousemove', { ...c, shiftKey: true });
      dom.mouse(dom.window, 'mouseup', { ...client.at(-1), shiftKey: true });
    });
    expect([...useF1Store.getState().selectedPCAPoints].sort()).toEqual(loadedRows.map((p) => p.id).sort());
    await view.click('All races');
  });
});
