// Server-side renders of the strategy panels with a real store state, to prove
// what the user reads: the pit-loss legend and the quali gate (R7), the panels
// computing the pit loss at the current clock after a backward seek (D5 #1),
// the session-type gate (D5 #2), the fitted range of the degradation banner
// (D4), the PCA pattern label (D1) and the new set from the pit exit (R3).
// D3 drawing runs in effects, which server rendering does not run: what the
// D3 code draws comes from the view models tested in views.strategy.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Server rendering reads getServerState: point it at the live state so a
// setState before renderToString is what the components see
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

// The PCA panel opens on its 'summary' tab (useState('summary')); while
// globalThis.__openTab is set, that initial tab is replaced to render another
vi.mock('react', async (importOriginal) => {
  const orig = await importOriginal();
  const real = orig.default || orig;
  const useState = (init) => real.useState(
    globalThis.__openTab && init === 'summary' ? globalThis.__openTab : init,
  );
  return { ...orig, default: { ...real, useState }, useState };
});

// In-memory localStorage for the persist middleware
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
const { default: StrategyTimeline } = await import('../components/visualizations/StrategyTimeline.jsx');
const { default: UndercutCalculator } = await import('../components/visualizations/UndercutCalculator.jsx');
const { default: RacePredictionPanel } = await import('../components/visualizations/RacePredictionPanel.jsx');
const { default: TireDegradation } = await import('../components/visualizations/TireDegradation.jsx');
const { default: DriverComparePanel } = await import('../components/visualizations/DriverComparePanel.jsx');
const { default: TireSilhouette } = await import('../components/visualizations/TireSilhouette.jsx');
const { default: PCAAnalysisPanel } = await import('../components/visualizations/PCAAnalysisPanel.jsx');
const { PIT_LOSS_LEGEND } = await import('../utils/strategyViews.js');
const { estimatePitLoss, FALLBACK_PIT_LOSS } = await import('../utils/pitLoss.js');
const { computeSessionTimeOffset, resolveSessionNow, pitOutSeconds } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIZ = path.resolve(HERE, '../components/visualizations');

const INITIAL = useF1Store.getState();
const html = (Component) => renderToString(React.createElement(Component));
/** Visible text of a server render (tags dropped, entities decoded). */
const text = (Component) => html(Component)
  .replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ');

const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;

/** Lap-mode store state (no replay frames) at currentLap, Monza 2024. */
function monzaAtLap(currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  const raceSituationData = extractRaceSituationFeatures({
    lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
  });
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
    raceSituationData,
    ...extra,
  });
  return { sessionNow, raceSituationData };
}

/** Replay store state at a session time (frames loaded), Monza 2024. */
function monzaAtSessionTime(sessionTime, currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    sessionData: monza,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: offset,
    maxLap: MAX_LAP,
    totalRaceLaps: MAX_LAP,
    currentLap,
    totalFrames: 10000,
    currentTime: sessionTime - offset,
    ...extra,
  });
}

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
});

describe.skipIf(!haveMonza)('Strategy Timeline render (R7)', () => {
  it('race: the one-line legend under the timeline explains "≈ estimate · * fallback"', () => {
    monzaAtLap(30);
    const t = text(StrategyTimeline);
    expect(t).toContain(PIT_LOSS_LEGEND);
    expect(t).toContain('≈ estimate');
    expect(t).toContain('* fallback');
    expect(t).not.toContain('No stint has begun yet');
  });

  it('qualifying: no pit-loss legend, runs as tyre sets', () => {
    monzaAtLap(30, { sessionType: 'Q' });
    const t = text(StrategyTimeline);
    expect(t).not.toContain(PIT_LOSS_LEGEND);
    expect(t).toContain('pit loss is shown in race sessions only');
    monzaAtLap(30, { sessionType: 'R', isQualifyingReplay: true });
    expect(text(StrategyTimeline)).toContain('pit loss is shown in race sessions only');
  });

  it('an explicit empty state instead of a blank chart', () => {
    useF1Store.setState({ ...INITIAL, sessionData: { lap_times: [] }, currentLap: 1 });
    expect(text(StrategyTimeline)).toContain('No lap data for this session.');
    // before the race start no stint has begun
    monzaAtSessionTime(computeSessionTimeOffset(monza.lap_times) - 30, 1);
    expect(text(StrategyTimeline)).toContain('No stint has begun yet at the current replay time.');
    // from the race start (lap mode, lap 1) every driver has a row: no empty state
    monzaAtLap(1);
    expect(text(StrategyTimeline)).not.toContain('No stint has begun yet');
  });
});

describe.skipIf(!haveMonza)('Undercut Calculator render (D5 #1, #2)', () => {
  const stale = {
    raceProjection: {
      // a projection computed at lap 51, still in the store after a seek back
      raceParams: { pitLoss: { median: 26.19, mean: 27, stdDev: 4, p10: 23, p90: 34, n: 29, source: 'race', samples: [] } },
      projections: [], battles: [], risks: [],
    },
  };

  it('after a backward seek the PIT LOSS cell is the value at the current clock, not the stale projection', () => {
    monzaAtLap(10, { ...stale, focusDriver: 'NOR', comparisonDriver: 'LEC' });
    const at10 = text(UndercutCalculator);
    expect(estimatePitLoss(monza.lap_times, { sessionNow: resolveSessionNow({ currentLap: 10, lapTimes: monza.lap_times }) }).source)
      .toBe('fallback');
    expect(at10).toContain('PIT LOSS');
    expect(at10).toContain(`${FALLBACK_PIT_LOSS.median.toFixed(1)}s fallback`);
    expect(at10).not.toContain('26.2s');

    monzaAtLap(30, { ...stale, focusDriver: 'NOR', comparisonDriver: 'LEC' });
    const est30 = estimatePitLoss(monza.lap_times, { sessionNow: resolveSessionNow({ currentLap: 30, lapTimes: monza.lap_times }) });
    expect(est30.source).toBe('race');
    const at30 = text(UndercutCalculator);
    expect(at30).toContain(`${est30.median.toFixed(1)}s`);
    expect(at30).not.toContain('fallback </');
  });

  it('outside race sessions it shows no pit-loss maths', () => {
    monzaAtLap(30, { sessionType: 'Q', focusDriver: 'NOR', comparisonDriver: 'LEC' });
    const t = text(UndercutCalculator);
    expect(t).toContain('applies to race sessions only');
    expect(t).not.toContain('PIT LOSS');
  });

  it('the race params are memoised on the causal key, never read from store.raceProjection', () => {
    const src = fs.readFileSync(path.join(VIZ, 'UndercutCalculator.jsx'), 'utf8');
    expect(src).not.toMatch(/raceProjection\?\.raceParams\)\s*return/);
    expect(src).not.toMatch(/useF1Store\(\(s\) => s\.raceProjection\)/);
    expect(src).toMatch(/\[lapTimes, trackStatus, currentLap, causal, sessionTimeOffset, sessionType, running\]/);
  });
});

describe.skipIf(!haveMonza)('Race Prediction render (D5 #1, #2)', () => {
  it('the header pit loss is the estimate at the current clock (fallback early, measured later)', () => {
    monzaAtLap(6);
    expect(text(RacePredictionPanel)).toContain(`Pit loss: ${FALLBACK_PIT_LOSS.median.toFixed(1)}s fallback`);
    monzaAtLap(30);
    const est30 = estimatePitLoss(monza.lap_times, { sessionNow: resolveSessionNow({ currentLap: 30, lapTimes: monza.lap_times }) });
    const t = text(RacePredictionPanel);
    expect(t).toContain(`Pit loss: ${est30.median.toFixed(1)}s`);
    expect(t).toContain(`n=${est30.n}`);
  });

  it('outside race sessions: no Monte Carlo, an explicit message', () => {
    monzaAtLap(30, { sessionType: 'FP2' });
    const t = text(RacePredictionPanel);
    expect(t).toContain('Race prediction applies to race sessions only');
    expect(t).not.toContain('Pit loss:');
  });

  it('the projection memo is keyed on the causal key (recomputed on any seek) and passes sessionType', () => {
    const src = fs.readFileSync(path.join(VIZ, 'RacePredictionPanel.jsx'), 'utf8');
    expect(src).toMatch(/causalKey\(lapTimesAll, sessionNow, trackStatus\)/);
    expect(src).toMatch(/sessionTimeOffset,\s*causal, isRace, sessionType, running\]\);/);
    expect(src).toMatch(/sessionType,\s*running,\s*\}\);/);
  });
});

describe.skipIf(!haveMonza)('Tyre Degradation banner render (D4)', () => {
  it('shows the fitted range L{lap_start}-L{lap_end_used}, marked "so far" while partial', () => {
    monzaAtLap(18, {
      focusDriver: 'PIA',
      selectedLapRange: [10, 25],
      degradationRegression: {
        slope: 2.0393, slope_fuel_corrected: 2.0693, lap_start: 10, lap_end: 25, lap_end_used: 17,
      },
    });
    const t = text(TireDegradation);
    expect(t).toContain('BRUSHED LAPS');
    expect(t).toContain('L10 – L25');
    expect(t).toMatch(/fitted L10 – L17 \(so far\)/);
    expect(t).toContain('+2039 ms/lap');

    monzaAtLap(40, {
      focusDriver: 'PIA',
      selectedLapRange: [10, 25],
      degradationRegression: {
        slope: -0.1414, slope_fuel_corrected: -0.1114, lap_start: 10, lap_end: 25, lap_end_used: 25,
      },
    });
    const done = text(TireDegradation);
    expect(done).toMatch(/fitted L10 – L25/);
    expect(done).not.toContain('(so far)');
  });
});

describe.skipIf(!haveMonza)('pit exit in the views (R2, R3)', () => {
  const lt = monza ? monza.lap_times : [];
  const out17 = lt.find((r) => r.Driver === 'PIA' && r.LapNumber === 17);

  it('DriverComparePanel: Pit Stops and the new stint appear together at PIA\'s pit exit', () => {
    const exit = pitOutSeconds(out17);
    // MetricsTable row: <PIA value> Pit Stops <NOR value>
    const row = (t) => /(\d+) Pit Stops \d+/.exec(t)?.[1];
    monzaAtSessionTime(exit - 0.5, 17, { compareDrivers: ['PIA', 'NOR'] });
    const before = text(DriverComparePanel);
    expect(row(before)).toBe('0');
    expect(before).not.toContain('HARD: laps from lap 17');
    monzaAtSessionTime(exit, 17, { compareDrivers: ['PIA', 'NOR'] });
    const after = text(DriverComparePanel);
    expect(row(after)).toBe('1');
    expect(html(DriverComparePanel)).toContain('HARD: laps from lap 17 (no lap completed yet)');
  });

  it('TireSilhouette: the new HARD set from the pit exit, MEDIUM in the pit lane', () => {
    const exit = pitOutSeconds(out17);
    monzaAtSessionTime(exit - 0.5, 17, { focusDriver: 'PIA' });
    const inLane = text(TireSilhouette);
    expect(inLane).toContain('MEDIUM');
    expect(inLane).not.toContain('HARD');
    monzaAtSessionTime(exit, 17, { focusDriver: 'PIA' });
    const t = text(TireSilhouette);
    expect(t).toContain('HARD');
    expect(t).toMatch(/Lap 1 \//);
  });
});

describe.skipIf(!haveMonza)('live mode: the set a driver races on is ongoing until the flag (R3, round 2)', () => {
  /** Live-style store state: the Monza laps received up to lap upTo, no session clock. */
  function liveAt(upTo, extra = {}) {
    const rows = monza.lap_times
      .filter((r) => r.LapNumber <= upTo)
      .map((r) => ({
        ...r, Time: null, LapStartTime: null,
        PitInTime: null, PitInTimeSeconds: null, PitOutTime: null, PitOutTimeSeconds: null,
      }));
    useF1Store.setState({
      ...INITIAL,
      isLiveMode: true,
      liveSessionInfo: { session_type: 'Race', session_name: 'Race' },
      sessionData: { lap_times: rows },
      currentLap: upTo, maxLap: upTo, totalRaceLaps: MAX_LAP, totalFrames: 0,
      focusDriver: 'PIA', selectedDrivers: ['PIA'], dnfMap: {},
      ...extra,
    });
  }

  it('TireSilhouette at lap 30 of 53: PIA on lap 15 of the HARD set, not a completed 14-lap stint', () => {
    liveAt(30);
    const h = html(TireSilhouette);
    expect(h).not.toContain('Completed stint: its real length');
    const t = text(TireSilhouette);
    expect(t).toContain('HARD');
    // reference length: the HARD stints that already ended in a stop
    expect(t).toMatch(/Lap 15 \/ ~\d+ \d+% life/);
    expect(t).not.toMatch(/ 0% life/);
  });

  it('after the chequered flag (lap 53 of 53) the last stint is a completed stint', () => {
    liveAt(MAX_LAP);
    expect(html(TireSilhouette)).toContain('Completed stint: its real length');
  });
});

describe('PCA pattern label (D1)', () => {
  it('a 3-stint pattern reads "2-stop strategy"', async () => {
    useF1Store.setState({
      ...INITIAL,
      selectedPCAPoints: ['PIA_2024_16', 'NOR_2024_16', 'HAM_2024_16'],
      pcaStrategyAnalysis: {
        summary: 'test', cluster_label: 'Selected',
        strategies: [{
          count: 3, frequency: 1,
          stints: [
            { compound: 'MEDIUM', lap_start: 1, length: 16 },
            { compound: 'HARD', lap_start: 17, length: 22 },
            { compound: 'HARD', lap_start: 39, length: 15 },
          ],
        }],
        feature_importance: [], common_patterns: [], pit_windows: [],
      },
    });
    // Open the Patterns tab
    globalThis.__openTab = 'patterns';
    let t;
    try {
      t = text(PCAAnalysisPanel);
    } finally {
      delete globalThis.__openTab;
    }
    expect(t).toContain('Patterns (1)');
    expect(t).toContain('2-stop strategy');
    expect(t).not.toContain('3-stop strategy');
  });
});
