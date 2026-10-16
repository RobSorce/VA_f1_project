// P3: the lasso analysis, from the request to what the panel shows.
//  - the store posts the selection to POST /api/pca/analyze-selection (the
//    former /tsne/ route stays a backend alias); only the newest request's
//    answer is kept, a cleared selection drops an answer on its way;
//  - the panel (components/visualizations/PCAAnalysisPanel.jsx) labels the
//    numbers "Descriptive differences, not a test", shows N, and per feature
//    Hedges' g, its interval (none for a group of one row) and the random-selection baseline
//    (expected |g| of random selections of the same size), as a forest plot
//    and as numbers.
// The answer below is the backend's (pca_compute.analyze_selection of the 5
// points nearest the lowest PC1 of the artefact), 4 of its 12 rows kept.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import axios from 'axios';
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

// Every request of the API client lands here; a test answers it
const requests = [];
axios.defaults.adapter = (config) => new Promise((resolve, reject) => {
  requests.push({
    config,
    url: `${config.baseURL || ''}${config.url}`,
    method: config.method,
    body: config.data ? JSON.parse(config.data) : null,
    answer: (data) => resolve({ data, status: 200, statusText: 'OK', headers: {}, config, request: {} }),
    fail: (msg) => reject(Object.assign(new Error(msg), { config, response: { status: 400, data: {} } })),
  });
});

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const api = await import('../utils/apiClient');
const useF1StoreModule = await import('../store/useF1Store.js');
const { useF1Store } = useF1StoreModule;
const {
  selectionRows, selectionStatistics, forestHalfWidth, forestX, fmtSigned, fmtInterval, sameSelection, ANALYSIS_LABEL,
  selectionClockNote, missingIntervalNote, progressRowNote,
} = await import('../utils/views/pcaSelection.js');
const { default: PCAAnalysisPanel } = await import('../components/visualizations/PCAAnalysisPanel.jsx');

const SELECTION = ['NOR_2025_8', 'LEC_2025_8', 'PIA_2025_8', 'NOR_2025_1', 'VER_2025_8'];
const ANSWER = {
  summary: "Selection of 5 race entries, compared with the other 529 (descriptive differences, not a test). Beyond what random selections of the same size show: much faster in sector 3 relative to the field (2.89%). Much faster relative to their race's field (race pace vs field, 2.54%). Most common strategy: MEDIUM -> HARD -> HARD (2-stop, 40% of the selection).",
  cluster_label: 'Fast sectors, Fast pace',
  n_selected: 5,
  n_rest: 529,
  n_total: 534,
  statistics: {
    label: 'Descriptive differences, not a test',
    effect_size: "Hedges' g: (selection mean - rest mean) / pooled SD x (1 - 3 / (4 df - 1)), df = N - 2",
    interval: '95% normal-approximation interval of g, g +/- 1.96 SE, SE^2 = (n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)) (Hedges and Olkin 1985); none when a group has fewer than 2 rows (one row has no spread of its own)',
    min_group_for_interval: 2,
    baseline: '|g| of 1000 random selections of 5 rows (seed 20261014): mean per feature (baseline_abs_g) and 95% quantile (baseline_abs_g_p95)',
    baseline_max_abs_g_p95: 1.399,
    note: 'The selection was drawn on a projection of these same features, so large |g| values are expected by construction. Baseline = |g| of random selections of the same size; exceeds_random marks a feature whose |g| is above the 95th percentile of the largest |g| over all features in those random selections.',
  },
  feature_importance: [
    { feature: 'sector3_delta_pct', label: 'Sector 3 vs Field', unit: '%', selected_mean: -2.969, rest_mean: -0.076, g: -3.349, abs_g: 3.349, effect_size: 3.349, ci_low: -4.253, ci_high: -2.446, n_selected: 5, n_rest: 529, baseline_abs_g: 0.366, baseline_abs_g_p95: 0.918, exceeds_random: true, direction: 'lower', magnitude: 'large' },
    { feature: 'grid_position', label: 'Grid Position', unit: '', selected_mean: 2.2, rest_mean: 10.198, g: -1.395, abs_g: 1.395, effect_size: 1.395, ci_low: -2.28, ci_high: -0.511, n_selected: 5, n_rest: 529, baseline_abs_g: 0.367, baseline_abs_g_p95: 0.898, exceeds_random: false, direction: 'lower', magnitude: 'large' },
    { feature: 'pit_count', label: 'Pit Stops', unit: '', selected_mean: 2.0, rest_mean: 1.682, g: 0.453, abs_g: 0.453, effect_size: 0.453, ci_low: -0.428, ci_high: 1.334, n_selected: 5, n_rest: 529, baseline_abs_g: 0.361, baseline_abs_g_p95: 0.742, exceeds_random: false, direction: 'higher', magnitude: 'small' },
    { feature: 'max_stint_length', label: 'Longest Stint', unit: 'laps', selected_mean: 34.6, rest_mean: 33.486, g: 0.107, abs_g: 0.107, effect_size: 0.107, ci_low: -0.774, ci_high: 0.987, n_selected: 4, n_rest: 512, baseline_abs_g: 0.353, baseline_abs_g_p95: 0.883, exceeds_random: false, direction: 'higher', magnitude: 'small' },
  ],
  strategies: [{
    stints: [
      { compound: 'MEDIUM', lap_start: 1, length: 19 },
      { compound: 'HARD', lap_start: 20, length: 31 },
      { compound: 'HARD', lap_start: 51, length: 28 },
    ],
    frequency: 0.4,
    count: 2,
  }],
  common_patterns: [
    { compound: 'SOFT', avg_stint_length: 1.0, count: 1, total_laps: 1 },
    { compound: 'MEDIUM', avg_stint_length: 27.8, count: 5, total_laps: 139 },
  ],
  pit_windows: [{ lap_start: 19, lap_end: 22, count: 3, median_lap: 20 }],
};
// (n_selected / n_rest of 'Longest Stint' are changed to 4 / 512 here, to
// show a feature whose rows have missing values)

const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mountPanel() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 420, height: 480 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(PCAAnalysisPanel)); });
  return {
    host,
    tab: (name) => [...host.querySelectorAll('button')].find((b) => text(b).startsWith(name)),
    async open(name) {
      const b = this.tab(name);
      expect(b, `tab ${name}`).toBeTruthy();
      await act(async () => { dom.mouse(b, 'click'); });
    },
    body: () => text(host.querySelector('.panel-content')),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

beforeEach(() => { requests.length = 0; });

describe('the request (P3)', () => {
  beforeEach(() => { useF1Store.setState({ ...INITIAL, selectedPCAPoints: SELECTION }); });

  it('fetchPCAAnalysis posts the selection to /api/pca/analyze-selection', async () => {
    const p = useF1Store.getState().fetchPCAAnalysis(SELECTION);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('post');
    expect(requests[0].url).toBe('/api/pca/analyze-selection');
    expect(requests[0].body).toEqual({ point_ids: SELECTION });
    requests[0].answer(ANSWER);
    await p;
    expect(useF1Store.getState().pcaStrategyAnalysis).toBe(ANSWER);
    expect(useF1Store.getState().pcaAnalysisIds).toEqual(SELECTION);
    // the former name is an alias of the new call
    expect(api.analyzeTSNESelection).toBe(api.analyzePCASelection);
  });

  it('only the newest request is kept, whatever order the answers come in', async () => {
    const a = useF1Store.getState().fetchPCAAnalysis(['NOR_2025_8']);
    const b = useF1Store.getState().fetchPCAAnalysis(SELECTION);
    // until an answer arrives the panel waits (no answer of an older selection)
    expect(useF1Store.getState().pcaStrategyAnalysis).toBeNull();
    requests[1].answer(ANSWER);
    await b;
    requests[0].answer({ ...ANSWER, summary: 'stale' });
    await a;
    expect(useF1Store.getState().pcaStrategyAnalysis.summary).not.toBe('stale');
    expect(useF1Store.getState().pcaAnalysisIds).toEqual(SELECTION);
  });

  it('a cleared selection drops the answer still on its way', async () => {
    const a = useF1Store.getState().fetchPCAAnalysis(SELECTION);
    useF1Store.getState().setSelectedPCAPoints([]);
    requests[0].answer(ANSWER);
    await a;
    expect(useF1Store.getState().pcaStrategyAnalysis).toBeNull();
  });

  it('a failed request is reported, not left "Analyzing"', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await mountPanel();
    const a = useF1Store.getState().fetchPCAAnalysis(SELECTION);
    await settle();
    expect(view.body()).toContain('Analyzing selection');
    requests[0].fail('Request failed with status code 400');
    await act(async () => { await a; });
    expect(view.body()).toContain('Analysis failed: Request failed with status code 400');
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
    await view.unmount();
  });
});

describe('the panel (P3)', () => {
  let view;
  beforeAll(async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: SELECTION, pcaStrategyAnalysis: ANSWER, pcaAnalysisIds: SELECTION });
    view = await mountPanel();
  });
  afterAll(async () => { await view?.unmount(); });

  it('summary: the label, N and how many features pass the random threshold', () => {
    const banner = text(view.host.querySelector('.pca-stats-banner'));
    expect(banner).toContain('Descriptive differences, not a test');
    expect(banner).toContain('N = 5 selected vs 529 other rows');
    expect(banner).toContain('1 of 4 features above random');
    expect(view.body()).not.toMatch(/Cohen/);
  });

  it('differences: g, its interval, N and the random baseline next to each value', async () => {
    await view.open('Differences');
    const body = view.body();
    expect(body).toContain('Descriptive differences, not a test');
    expect(body).not.toMatch(/Cohen/);
    const rows = [...view.host.querySelectorAll('.pca-forest-row')];
    // (each cell's second line is a block span: textContent joins the lines)
    expect(rows.map((r) => text(r.querySelector('[role="cell"]')))).toEqual([
      'Sector 3 vs Fieldabove random', 'Grid Position', 'Pit Stops', 'Longest Stint',
    ]);
    const nums = rows.map((r) => text(r.querySelectorAll('[role="cell"]')[2]));
    expect(nums).toEqual([
      'g −3.35 [−4.25, −2.45]random |g| 0.37',
      'g −1.40 [−2.28, −0.51]random |g| 0.37',
      'g +0.45 [−0.43, +1.33]random |g| 0.36',
      // its own N, as it differs from the selection's
      'g +0.11 [−0.77, +0.99]random |g| 0.35 · n 4 vs 512',
    ]);
    // only the flagged feature carries the marker (not colour alone)
    expect(view.host.querySelectorAll('.pca-above-random')).toHaveLength(1);
    // the method strings of the answer and the threshold
    const method = text(view.host.querySelector('details'));
    expect(method).toContain(ANSWER.statistics.effect_size);
    expect(method).toContain(ANSWER.statistics.interval);
    expect(method).toContain(ANSWER.statistics.baseline);
    expect(method).toContain('Above random: |g| > 1.399');
    expect(body).toContain('bar = 95% normal-approximation interval of g (none for a group of fewer than 2 rows: one row has no spread of its own)');
    expect(view.host.querySelectorAll('.pca-no-interval')).toHaveLength(0);
  });

  it('the forest plot draws g, the interval, the baseline band and the threshold on one axis', () => {
    const half = forestHalfWidth(selectionRows(ANSWER), 1.399);
    expect(half).toBe(4.5); // largest |value| 4.253 -> next 0.5
    const W = 200;
    const rows = [...view.host.querySelectorAll('.pca-forest-row')];
    ANSWER.feature_importance.forEach((fi, i) => {
      const r = rows[i];
      expect(Number(r.querySelector('.pca-forest-g').getAttribute('x1'))).toBeCloseTo(forestX(fi.g, half, W), 9);
      const ci = r.querySelector('.pca-forest-interval');
      expect(Number(ci.getAttribute('x1'))).toBeCloseTo(forestX(fi.ci_low, half, W), 9);
      expect(Number(ci.getAttribute('x2'))).toBeCloseTo(forestX(fi.ci_high, half, W), 9);
      const band = r.querySelector('.pca-forest-baseline');
      expect(Number(band.getAttribute('x'))).toBeCloseTo(forestX(-fi.baseline_abs_g, half, W), 9);
      expect(Number(band.getAttribute('width'))).toBeCloseTo((2 * fi.baseline_abs_g / (2 * half)) * W, 9);
      const th = [...r.querySelectorAll('.pca-forest-threshold')].map((l) => Number(l.getAttribute('x1')));
      expect(th[0]).toBeCloseTo(forestX(-1.399, half, W), 9);
      expect(th[1]).toBeCloseTo(forestX(1.399, half, W), 9);
    });
  });

  it('an answer of another selection is not shown', async () => {
    await act(async () => { useF1Store.setState({ selectedPCAPoints: ['ALB_2024_1'] }); });
    expect(view.body()).toContain('Analyzing selection');
    await act(async () => { useF1Store.setState({ selectedPCAPoints: SELECTION }); });
    expect(view.body()).toContain('N = 5 selected vs 529 other rows');
  });

  it('no selection: the instructions name the shift key of the lasso', async () => {
    await act(async () => { useF1Store.setState({ selectedPCAPoints: [] }); });
    expect(view.body()).toContain('Shift+drag to lasso-select a group');
    await act(async () => { useF1Store.setState({ selectedPCAPoints: SELECTION, pcaStrategyAnalysis: ANSWER, pcaAnalysisIds: SELECTION }); });
  });
});

describe('view model (utils/views/pcaSelection.js)', () => {
  it('formats signed values and intervals with a true minus sign', () => {
    expect(fmtSigned(-3.349)).toBe('−3.35');
    expect(fmtSigned(0.453)).toBe('+0.45');
    expect(fmtSigned(0.001)).toBe('0.00');
    expect(fmtInterval(-0.368, 0.834)).toBe('[−0.37, +0.83]');
    expect(fmtInterval(null, 1)).toBeNull();
  });

  it('an answer of the former route (effect size + direction only) still reads', () => {
    const legacy = { feature_importance: [{ feature: 'pit_count', label: 'Pit Stops', effect_size: 0.9, direction: 'lower' }] };
    const [r] = selectionRows(legacy);
    expect(r.g).toBe(-0.9);
    expect(r.ciLow).toBeNull();
    expect(r.baseline).toBeNull();
    expect(selectionStatistics(legacy).label).toBe(ANALYSIS_LABEL);
  });

  it('sameSelection ignores order', () => {
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSelection(['a'], ['a', 'b'])).toBe(false);
  });

  it('missingIntervalNote: why a row has no interval', () => {
    const row = { ciLow: null, ciHigh: null, nSelected: 1, nRest: 533 };
    expect(missingIntervalNote(row, 2)).toBe('no interval: 1 selected row');
    expect(missingIntervalNote({ ...row, nSelected: 533, nRest: 1 }, 2)).toBe('no interval: 1 other row');
    expect(missingIntervalNote({ ...row, ciLow: -1, ciHigh: 1 }, 2)).toBeNull();
    // a former answer gives no reason
    expect(missingIntervalNote(row, null)).toBeNull();
  });
});

// P3 (round 3): a click selects one point; one row has no spread of its own,
// so the backend gives no interval (pca_compute.MIN_GROUP_FOR_INTERVAL; the
// former percentile bootstrap gave a narrow interval excluding 0 for 11 of
// 12 features of this very row, docs/evidence/pca_interval_coverage.txt).
// The rows below are the backend's answer for LEC_2024_16 alone (2 of 12 kept).
describe('a single selected point (P3)', () => {
  const ONE = ['LEC_2024_16'];
  const SINGLE = {
    ...ANSWER,
    n_selected: 1,
    n_rest: 533,
    statistics: { ...ANSWER.statistics, baseline_max_abs_g_p95: 4.041 },
    feature_importance: [
      { feature: 'sector2_delta_pct', label: 'Sector 2 vs Field', unit: '%', selected_mean: -1.579, rest_mean: -0.08, g: -1.707, abs_g: 1.707, effect_size: 1.707, ci_low: null, ci_high: null, n_selected: 1, n_rest: 533, baseline_abs_g: 0.802, baseline_abs_g_p95: 1.955, exceeds_random: false, direction: 'lower', magnitude: 'large' },
      { feature: 'pace_delta_pct', label: 'Race Pace vs Field', unit: '%', selected_mean: -1.118, rest_mean: -0.111, g: -1.211, abs_g: 1.211, effect_size: 1.211, ci_low: null, ci_high: null, n_selected: 1, n_rest: 533, baseline_abs_g: 0.789, baseline_abs_g_p95: 1.921, exceeds_random: false, direction: 'lower', magnitude: 'large' },
    ],
  };

  it('each row says it has no interval and draws no interval bar; g, N and the baseline stay', async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: ONE, pcaStrategyAnalysis: SINGLE, pcaAnalysisIds: ONE });
    const view = await mountPanel();
    try {
      await view.open('Differences');
      const rows = [...view.host.querySelectorAll('.pca-forest-row')];
      expect(rows).toHaveLength(2);
      expect(view.host.querySelectorAll('.pca-forest-interval')).toHaveLength(0);
      expect([...view.host.querySelectorAll('.pca-no-interval')].map(text))
        .toEqual(['no interval: 1 selected row', 'no interval: 1 selected row']);
      expect(text(rows[0].querySelectorAll('[role="cell"]')[2]))
        .toBe('g −1.71no interval: 1 selected rowrandom |g| 0.80');
      expect(view.body()).toContain('N = 1 selected vs 533 other rows');
    } finally {
      await view.unmount();
    }
  });
});

// P6: the analysis of a selection is asked at the biplot's clock
// (store pcaRequestOf): during a replay of the loaded race its rows, stints
// and stops stop at the replay clock (backend analyze_selection, tested in
// backend/tests/test_pca_causal.py), before the race (another session of the
// weekend on screen) it has none, and an answer from a later clock is dropped
// on a seek back. The panel says when the selection's rows of that race are
// taken at the replay clock.
describe('the request at the biplot clock (P6)', () => {
  const { laterClockReset, pcaRequestOf } = useF1StoreModule;
  const REPLAY = {
    loadedYear: 2024, loadedRound: 16, loadedSessionType: 'R',
    totalFrames: 1000, currentTime: 500, sessionTimeOffset: 0, maxTime: 1000, frameDt: 1,
  };
  const IDS = ['LEC_2024_16', 'PIA_2024_16', 'VER_2024_1'];
  const AT_CLOCK = {
    ...ANSWER,
    pit_windows: [{ lap_start: 5, lap_end: 5, count: 1, median_lap: 5 }],
    current_race: { year: 2024, round: 16, as_of: 'session_now', session_now: 500, as_of_lap: 10, n_selected: 2 },
  };
  beforeEach(() => { useF1Store.setState({ ...INITIAL, ...REPLAY, selectedPCAPoints: IDS }); });

  it('during a replay of the race: year, round and the replay clock are posted', async () => {
    expect(pcaRequestOf(useF1Store.getState()).params).toEqual({ year: 2024, round: 16, session_now: 500 });
    const p = useF1Store.getState().fetchPCAAnalysis(IDS);
    expect(requests[0].body).toEqual({ point_ids: IDS, year: 2024, round: 16, session_now: 500 });
    requests[0].answer(AT_CLOCK);
    await p;
    expect(useF1Store.getState().pcaStrategyAnalysis).toBe(AT_CLOCK);
    expect(useF1Store.getState()._pcaAnalysisAt).toBe(500);
  });

  it('the race at its end: post-race (no clock); a seek back drops that answer', async () => {
    useF1Store.setState({ currentTime: 999.5 });
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
    const p = useF1Store.getState().fetchPCAAnalysis(IDS);
    expect(requests[0].body).toEqual({ point_ids: IDS });
    requests[0].answer(ANSWER);
    await p;
    expect(useF1Store.getState()._pcaAnalysisAt).toBe(Infinity);
    // seek back to session second 500: the whole-race answer is from a later clock
    const drop = laterClockReset(useF1Store.getState(), 500);
    expect(drop.pcaStrategyAnalysis).toBeNull();
    expect(drop._pcaAnalysisAt).toBeNull();
    // the same answer at clock 500 stays
    expect(laterClockReset({ ...useF1Store.getState(), _pcaAnalysisAt: 500 }, 500)).toEqual({});
  });

  it('another session of the weekend (a sprint at its end): session_now 0, the race has not started', async () => {
    useF1Store.setState({ loadedSessionType: 'S', currentTime: 999.5 });
    expect(useF1Store.getState().getSessionNow()).toBe(Infinity);
    const p = useF1Store.getState().fetchPCAAnalysis(IDS);
    expect(requests[0].body).toEqual({ point_ids: IDS, year: 2024, round: 16, session_now: 0 });
    requests[0].answer(ANSWER);
    await p;
    expect(useF1Store.getState()._pcaAnalysisAt).toBeNull();
  });

  it('the clock moves back while the request runs: its answer is dropped', async () => {
    const p = useF1Store.getState().fetchPCAAnalysis(IDS);
    useF1Store.setState({ currentTime: 300 });
    requests[0].answer(AT_CLOCK);
    await p;
    expect(useF1Store.getState().pcaStrategyAnalysis).toBeNull();
  });

  it('the panel says the race on screen\'s rows stop at the replay clock (summary, patterns, pit windows)', async () => {
    useF1Store.setState({ pcaStrategyAnalysis: AT_CLOCK, pcaAnalysisIds: IDS });
    const view = await mountPanel();
    try {
      const note = '2 selected rows of 2024 R16 as of lap 10 (the replay clock): their stints, stops and pit windows stop there; the other races are whole races.';
      expect(selectionClockNote(AT_CLOCK)).toBe(note);
      expect(text(view.host.querySelector('.pca-clock-note'))).toBe(note);
      await view.open('Patterns');
      expect(text(view.host.querySelector('.pca-clock-note'))).toBe(note);
      await view.open('Details');
      expect(view.body()).toContain('L5–L5');
      expect(text(view.host.querySelector('.pca-clock-note'))).toBe(note);
      // post-race rows, or no row of that race: no note
      expect(selectionClockNote(ANSWER)).toBeNull();
      expect(selectionClockNote({ current_race: { ...AT_CLOCK.current_race, n_selected: 0 } })).toBeNull();
      expect(selectionClockNote({ current_race: { ...AT_CLOCK.current_race, as_of: 'post-race' } })).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

// P3 (round 4): during a replay the rows of the race on screen are taken at
// the replay clock and the other races are whole races. The backend draws the
// random baseline with the selection's mix of the two kinds (stratified), the
// statistics block states the composition and the lap, and the features whose
// distribution moves with race progress (pit stops, stint lengths, tyre
// degradation) are marked progress_dependent; the panel shows the composition
// under N and a note on each such row. The answer below is the backend's
// (pca_compute.analyze_selection of 3 rows of 2024 R16 at the end of leader
// lap 20 and 2 rows of finished races), 4 of its 12 rows kept.
describe('a replay selection: composition and progress-dependent rows (P3)', () => {
  const IDS = ['LEC_2024_16', 'PIA_2024_16', 'NOR_2024_16', 'VER_2024_1', 'HAM_2024_2'];
  const MIXED = {
    ...ANSWER,
    summary: 'Selection of 5 race entries, compared with the other 529 (descriptive differences, not a test). Beyond what random selections of the same size and mix show: much faster in sector 2 relative to the field (1.37%). Much better grid positions (3.2 vs 10.2 avg). Much faster relative to their race\'s field (race pace vs field, 0.97%). Most common strategy: MEDIUM -> HARD (1-stop, 60% of the selection). The 3 selected rows of 2024 R16 use only the laps completed by lap 20 (the replay clock): their stints and stops end there; the other races are whole races. The random selections of the baseline keep the same mix of rows.',
    cluster_label: 'Fast sectors, Front of grid',
    n_selected: 5,
    n_rest: 529,
    n_total: 534,
    statistics: {
      ...ANSWER.statistics,
      baseline: "|g| of 1000 random selections of 5 rows with the selection's mix (3 of the race on screen at lap 20, 2 of finished races, each drawn from the rows of its kind; seed 20261014): mean per feature (baseline_abs_g) and 95% quantile (baseline_abs_g_p95)",
      baseline_max_abs_g_p95: 1.555,
      threshold_rule: 'per_feature',
      threshold_level: 0.994,
      threshold: "above random: |g| above the feature's own threshold (threshold_abs_g), the 99.4% quantile of its random |g|, the same level for every feature, chosen so that 5% of the random selections pass the threshold of some feature (rows of two kinds: the progress-dependent features reach far larger random |g| and would otherwise set the threshold of all)",
      composition: { selected_live: 3, selected_finished: 2, rest_live: 16, rest_finished: 513, as_of_lap: 20, mixed: true, no_random_alternative: false },
      composition_text: 'selection: 3 rows of the race on screen at lap 20, 2 rows of finished races; baseline drawn with the same mix',
      progress_dependent_features: ['avg_stint_length', 'max_stint_length', 'pit_count', 'degradation_slope'],
      progress_note: 'progress-dependent (avg stint length, longest stint, pit stops, tyre degradation): the rows of the race on screen use only the laps completed by lap 20, those of finished races the whole race, so the two kinds differ in these features whatever the drivers did; the random baseline draws the same mix, so read these rows against it',
      note: 'The selection was drawn on a projection of these same features, so large |g| values are expected by construction. Baseline = |g| of random selections of the same size and the same mix of row kinds (during a replay: rows of the race on screen at the clock, rows of finished races); exceeds_random marks a feature whose |g| is above the 95th percentile of the largest |g| over all features in those random selections. When the compared rows mix the two kinds, each feature is held to its own threshold instead: the same high percentile of its own random |g| for every feature, chosen so that 5% of the random selections pass the threshold of some feature (the progress-dependent features reach far larger |g| in random selections and would otherwise set the threshold of all).',
    },
    feature_importance: [
      { feature: 'sector2_delta_pct', label: 'Sector 2 vs Field', unit: '%', selected_mean: -1.435, rest_mean: -0.065, g: -1.588, abs_g: 1.588, effect_size: 1.588, ci_low: -2.474, ci_high: -0.702, n_selected: 5, n_rest: 529, baseline_abs_g: 0.347, baseline_abs_g_p95: 0.823, threshold_abs_g: 1.077, exceeds_random: true, progress_dependent: false, direction: 'lower', magnitude: 'large' },
      { feature: 'avg_stint_length', label: 'Avg Stint Length', unit: 'laps', selected_mean: 14.5, rest_mean: 23.515, g: -1.367, abs_g: 1.367, effect_size: 1.367, ci_low: -2.252, ci_high: -0.483, n_selected: 5, n_rest: 529, baseline_abs_g: 0.982, baseline_abs_g_p95: 1.55, threshold_abs_g: 1.768, exceeds_random: false, progress_dependent: true, direction: 'lower', magnitude: 'large' },
      { feature: 'grid_position', label: 'Grid Position', unit: '', selected_mean: 3.2, rest_mean: 10.189, g: -1.217, abs_g: 1.217, effect_size: 1.217, ci_low: -2.1, ci_high: -0.333, n_selected: 5, n_rest: 529, baseline_abs_g: 0.34, baseline_abs_g_p95: 0.784, threshold_abs_g: 1.11, exceeds_random: true, progress_dependent: false, direction: 'lower', magnitude: 'large' },
      { feature: 'pit_count', label: 'Pit Stops', unit: '', selected_mean: 1.2, rest_mean: 1.662, g: -0.646, abs_g: 0.646, effect_size: 0.646, ci_low: -1.527, ci_high: 0.236, n_selected: 5, n_rest: 529, baseline_abs_g: 0.721, baseline_abs_g_p95: 1.216, threshold_abs_g: 1.505, exceeds_random: false, progress_dependent: true, direction: 'lower', magnitude: 'medium' },
    ],
    current_race: { year: 2024, round: 16, as_of: 'session_now', session_now: 5063.137, as_of_lap: 20, n_selected: 3 },
  };
  const COMPOSITION = 'selection: 3 rows of the race on screen at lap 20, 2 rows of finished races; baseline drawn with the same mix';

  it('the stats banner states the composition and the lap (summary and differences)', async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: IDS, pcaStrategyAnalysis: MIXED, pcaAnalysisIds: IDS });
    const view = await mountPanel();
    try {
      expect(text(view.host.querySelector('.pca-composition'))).toBe(COMPOSITION);
      expect(text(view.host.querySelector('.pca-stats-banner'))).toContain('N = 5 selected vs 529 other rows');
      await view.open('Differences');
      expect(text(view.host.querySelector('.pca-composition'))).toBe(COMPOSITION);
    } finally {
      await view.unmount();
    }
  });

  it('a progress-dependent row carries a note; the others do not; the method gives the mix', async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: IDS, pcaStrategyAnalysis: MIXED, pcaAnalysisIds: IDS });
    const view = await mountPanel();
    try {
      await view.open('Differences');
      const rows = [...view.host.querySelectorAll('.pca-forest-row')];
      const notes = rows.map((r) => text(r.querySelector('.pca-progress-note')) || null);
      expect(notes).toEqual([
        null, 'progress-dependent: lap 20 rows vs whole races', null, 'progress-dependent: lap 20 rows vs whole races',
      ]);
      // a text note, not colour alone; the flag "above random" stays separate
      expect(text(rows[0].querySelector('.pca-above-random'))).toBe('above random');
      expect(rows[1].querySelector('.pca-above-random')).toBeNull();
      expect(rows[1].querySelector('.pca-progress-note').getAttribute('title')).toBe(MIXED.statistics.progress_note);
      const body = view.body();
      expect(body).toContain('shaded = expected |g| of a random selection of the same size and mix');
      expect(body).toContain(MIXED.statistics.progress_note);
      const method = text(view.host.querySelector('details'));
      expect(method).toContain(MIXED.statistics.baseline);
      expect(method).toContain(COMPOSITION);
    } finally {
      await view.unmount();
    }
  });

  it('view model: rows, statistics and the note', () => {
    const rows = selectionRows(MIXED);
    expect(rows.map((r) => r.progressDependent)).toEqual([false, true, false, true]);
    const st = selectionStatistics(MIXED);
    expect(st.composition).toBe(COMPOSITION);
    expect(st.asOfLap).toBe(20);
    expect(st.progressNote).toBe(MIXED.statistics.progress_note);
    expect(progressRowNote(rows[1], st)).toBe('progress-dependent: lap 20 rows vs whole races');
    expect(progressRowNote(rows[0], st)).toBeNull();
    // without the lap (an answer without rows at a clock)
    expect(progressRowNote(rows[1], { asOfLap: null })).toBe('progress-dependent: rows at the clock vs whole races');
    // a post-race answer: no composition note, no progress flag
    expect(selectionStatistics(ANSWER).composition).toBeNull();
    expect(selectionRows(ANSWER).some((r) => r.progressDependent)).toBe(false);
  });

  // Verifier r1: with rows of two kinds the one threshold of every feature
  // (95th percentile of the largest |g|, 1.555 here) was set by the
  // progress-dependent features; each feature now has its own
  // (threshold_abs_g, the same quantile level of its own random |g|), and the
  // grid position of these 5 rows passes its own 1.11 (not 1.555).
  it('per-feature thresholds: each row draws and states its own; the method gives the rule', async () => {
    const rows = selectionRows(MIXED);
    expect(rows.map((r) => r.threshold)).toEqual([1.077, 1.768, 1.11, 1.505]);
    const st = selectionStatistics(MIXED);
    expect(st.perFeatureThreshold).toBe(true);
    expect(st.thresholdLevel).toBe(0.994);
    // a post-race answer: one threshold for every row, from the statistics block
    expect(selectionRows(ANSWER).map((r) => r.threshold)).toEqual([1.399, 1.399, 1.399, 1.399]);
    expect(selectionStatistics(ANSWER).perFeatureThreshold).toBe(false);
    const half = forestHalfWidth(rows, st.threshold);
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: IDS, pcaStrategyAnalysis: MIXED, pcaAnalysisIds: IDS });
    const view = await mountPanel();
    try {
      expect(text(view.host.querySelector('.pca-stats-banner'))).toContain('2 of 4 features above random');
      await view.open('Differences');
      const forest = [...view.host.querySelectorAll('.pca-forest-row')];
      MIXED.feature_importance.forEach((fi, i) => {
        const th = [...forest[i].querySelectorAll('.pca-forest-threshold')].map((l) => Number(l.getAttribute('x1')));
        expect(th[0]).toBeCloseTo(forestX(-fi.threshold_abs_g, half, 200), 9);
        expect(th[1]).toBeCloseTo(forestX(fi.threshold_abs_g, half, 200), 9);
        expect(text(forest[i].querySelector('.pca-row-threshold'))).toBe(`· threshold ${fi.threshold_abs_g.toFixed(2)}`);
      });
      expect(text(forest[2].querySelector('.pca-above-random'))).toBe('above random');
      const body = view.body();
      expect(body).toContain('(each feature its own: the 99.4% quantile of its random |g|, so that 5% of random selections pass some threshold).');
      const method = text(view.host.querySelector('details'));
      expect(method).toContain(MIXED.statistics.threshold);
      expect(method).not.toContain('Above random: |g| > 1.555');
    } finally {
      await view.unmount();
    }
  });
});

describe('a post-race answer keeps one threshold (P3, verifier r1)', () => {
  it('no per-row threshold text; the method gives the one threshold', async () => {
    useF1Store.setState({ ...INITIAL, selectedPCAPoints: SELECTION, pcaStrategyAnalysis: ANSWER, pcaAnalysisIds: SELECTION });
    const view = await mountPanel();
    try {
      await view.open('Differences');
      expect(view.host.querySelectorAll('.pca-row-threshold')).toHaveLength(0);
      expect(text(view.host.querySelector('details'))).toContain('Above random: |g| > 1.399');
      expect(view.body()).toContain('dashed = the threshold a feature must pass to be marked "above random".');
    } finally {
      await view.unmount();
    }
  });
});
