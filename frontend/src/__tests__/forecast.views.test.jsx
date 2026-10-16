// Phase 6, what the views show of the lap-time forecast (L4, L5).
//  - L4: the backend removed driver_predictions[driver].predicted_position_change
//    and positions (a 5-lap pace forecast says nothing about overtakes): no
//    view reads them; the Leaderboard footer shows no pit probability when
//    the response has none (it showed "0%") and names the pit method.
//  - L5: the help text quotes the numbers of
//    docs/evidence/evaluate_forecast.txt (parsed here, every
//    number compared) and names the script, never a file path, never "~0.4 s MAE dry / 2.5 s wet" nor "HEURISTIC
//    2-3x worse"; the panel names the served method (method_label) and says
//    when the LSTM loses (lstm_note).
import { describe, it, expect, vi, beforeAll } from 'vitest';
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
// The panels size themselves with a ResizeObserver (not in the mini DOM)
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { CHART_HELP } = await import('../utils/chartHelp.js');
const { FORECAST_EVALUATION: EVAL, forecastEntry } = await import('../utils/forecast.js');
const { default: Leaderboard } = await import('../components/visualizations/Leaderboard.jsx');
const { default: RacePredictionPanel } = await import('../components/visualizations/RacePredictionPanel.jsx');

const SRC = path.resolve(__dirname, '..');
const EVAL_FILE = path.resolve(__dirname, '../../../docs/evidence/evaluate_forecast.txt');
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const store = () => useF1Store.getState();
const INITIAL = store();

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...sourceFiles(p)); } else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** A synthetic race on screen at lap 20 (three drivers). */
function race(laps = 30) {
  const lap_times = [];
  for (const [i, d] of ['AAA', 'BBB', 'CCC'].entries()) {
    for (let n = 1; n <= laps; n++) {
      const start = 2000 + 95 * (n - 1) + i * 1.5;
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + 95, LapTimeSeconds: 95 + 0.05 * n,
        Position: i + 1, Compound: 'HARD', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return { lap_times, track_status: [], driver_info: [{ Abbreviation: 'AAA' }, { Abbreviation: 'BBB' }, { Abbreviation: 'CCC' }], race_results: [], weather_data: [] };
}

function entry(extra = {}) {
  return forecastEntry({
    driver: 'AAA', origin_lap: 19, target_laps: [20, 21, 22, 23, 24], predicted_times: [96, 96.1, 96.2, 96.3, 96.4],
    method: 'persistence', method_label: 'Persistence (next laps = last clean lap)',
    held_out: { metric: 'MAE over laps +1..+5, s', races: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], values: { persistence: 0.637, lstm: 0.9 }, selected_on: 'validation' },
    lstm_note: 'The LSTM does not beat Persistence (next laps = last clean lap) on the validation races (MAE 0.900 s vs 0.535 s over laps +1..+5), so Persistence (next laps = last clean lap) is shown.',
    pit_probability: 0.2, pit_method: 'tyre_age_logistic', optimal_pit_lap: 27,
    predicted_stints: [], driver_predictions: { AAA: {} }, summary: 'Persistence forecast of laps 20-24.',
    ...extra,
  }, { driver: 'AAA', askedLap: 20, at: 0 });
}

async function render(Component, rect = { left: 0, top: 0, width: 420, height: 700 }) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, rect);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  return {
    host,
    async rerender() { await act(async () => { root.render(React.createElement(Component)); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

beforeAll(() => {
  const data = race();
  useF1Store.setState({
    ...INITIAL, sessionData: data, drivers: data.driver_info, loadedYear: 2024, loadedRound: 99, loadedSessionType: 'R',
    year: 2024, round: 99, sessionType: 'R', maxLap: 30, currentLap: 20, focusDriver: 'AAA', selectedDrivers: ['AAA'],
    computeRaceProjection: () => {}, computeRaceSituation: () => {},
  });
});

describe('L4: no view reads a field the backend removed', () => {
  it('grep: predicted_position_change, driver_predictions and the response\'s positions are read nowhere', () => {
    const hits = [];
    for (const f of sourceFiles(SRC)) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/predicted_position_change|driver_predictions|pred(?:iction)?s?\??\.positions\b|lstmPredictions\??\.positions/.test(line)) {
          hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('Leaderboard footer: the focus driver\'s pit probability with its method; nothing for a null probability (was "0%")', async () => {
    useF1Store.setState({ lstmPredictions: { AAA: entry() } });
    const view = await render(Leaderboard);
    const body = text(view.host);
    expect(body).toContain('AAA PIT PROB (tyre-age logistic regression)20%');
    expect(body).toContain('OPT PIT LAPL27');
    // no position arrow from the forecast (the old ▲ / ▼ next to the name)
    useF1Store.setState({ lstmPredictions: { AAA: entry({ pit_probability: null, pit_method: null, optimal_pit_lap: null }) } });
    await view.rerender();
    expect(text(view.host)).not.toContain('PIT PROB');
    expect(text(view.host)).not.toMatch(/\b0%/);
    // another driver's forecast under the focus key is never shown
    useF1Store.setState({ lstmPredictions: { AAA: { ...entry(), driver: 'BBB' } } });
    await view.rerender();
    expect(text(view.host)).not.toContain('PIT PROB');
    await view.unmount();
    useF1Store.setState({ lstmPredictions: null });
  });
});

describe('L5: accuracy claims are the evaluation\'s numbers', () => {
  /** The numbers of evaluate_forecast.txt the help quotes, parsed from the file. */
  function parseEvaluation() {
    const t = fs.readFileSync(EVAL_FILE, 'utf8').replace(/\r\n/g, '\n');
    const row = (method, set) => {
      const m = t.match(new RegExp(`^${method}\\s+${set}\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`, 'm'));
      return m.slice(1).map(Number);
    };
    const section = (start, end) => t.slice(t.indexOf(start), end ? t.indexOf(end, t.indexOf(start)) : undefined);
    const compound = section('Test pooled MAE by origin compound', 'Test pooled MAE per race');
    const inter = compound.match(/^INTERMEDIATE\s+\d+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/m).slice(1).map(Number);
    const perRace = section('Test pooled MAE per race', 'Ranking').split('\n')
      .map((l) => l.match(/^(\d{4}-\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)).filter(Boolean)
      .map((m) => ({ race: m[1], lstm: Number(m[5]) }));
    const pit = (method) => t.match(new RegExp(`^${method}\\s+([\\d.]+)\\s+([\\d.]+)`, 'm')).slice(1).map(Number);
    const calib = section('Calibration, test, lstm', 'Calibration, test, tyre_age_logistic');
    const bins = ['0.5, 0.6', '0.6, 0.7'].map((b) => calib.match(new RegExp(`^\\[${b}\\]\\s+\\d+\\s+([\\d.]+)\\s+([\\d.]+)`, 'm')).slice(1).map(Number));
    return {
      valRaces: Number(t.match(/^val\s+races \((\d+)\)/m)[1]),
      testRaces: Number(t.match(/^test\s+races \((\d+)\)/m)[1]),
      test: Object.fromEntries(['lstm', 'compound_mean', 'persistence', 'stint_linear'].map((m) => [m, row(m, 'test')])),
      val: Object.fromEntries(['lstm', 'compound_mean', 'persistence', 'stint_linear'].map((m) => [m, row(m, 'val')])),
      inter: { persistence: inter[0], stint_linear: inter[1], compound_mean: inter[2], lstm: inter[3] },
      perRace,
      pit: { lstm: pit('lstm'), tyre_age_logistic: pit('tyre_age_logistic'), base_rate: pit('base_rate') },
      bins,
      selected: t.match(/^SELECTED lap-time method[^:]*: (\w+)/m)[1],
    };
  }

  it('FORECAST_EVALUATION equals evaluate_forecast.txt, number by number', () => {
    const e = parseEvaluation();
    console.log('L5 parsed from evaluate_forecast.txt:', JSON.stringify({ test: e.test, val: e.val, inter: e.inter, pit: e.pit, bins: e.bins, selected: e.selected }));
    expect(EVAL.source).toBe('evaluate_forecast script');
    expect([EVAL.valRaces, EVAL.testRaces]).toEqual([e.valRaces, e.testRaces]);
    for (const m of ['lstm', 'compound_mean', 'persistence', 'stint_linear']) {
      expect(EVAL.testMae[m], `test ${m}`).toBe(e.test[m][5]);
      expect(EVAL.valMae[m], `val ${m}`).toBe(e.val[m][5]);
    }
    expect(EVAL.lstmTestMaeByLap).toEqual(e.test.lstm.slice(0, 5));
    expect(EVAL.intermediateMae).toEqual({ lstm: e.inter.lstm, compound_mean: e.inter.compound_mean });
    const lstmByRace = e.perRace.map((r) => r.lstm);
    expect(EVAL.lstmRaceMae.low).toBe(Math.min(...lstmByRace));
    expect(EVAL.lstmRaceMae.high).toBe(Math.max(...lstmByRace));
    expect(EVAL.lstmRaceMae.highRace).toBe(e.perRace.find((r) => r.lstm === Math.max(...lstmByRace)).race);
    expect(EVAL.pitBrier).toEqual({ lstm: e.pit.lstm[0], tyre_age_logistic: e.pit.tyre_age_logistic[0], base_rate: e.pit.base_rate[0] });
    expect(EVAL.lstmPitPrAuc).toBe(e.pit.lstm[1]);
    expect(EVAL.lstmPitAbove50).toEqual({
      predictedLow: e.bins[0][0], predictedHigh: e.bins[1][0],
      observedLow: Math.min(e.bins[0][1], e.bins[1][1]), observedHigh: Math.max(e.bins[0][1], e.bins[1][1]),
    });
    // the method the help describes as served is the one the evaluation selected
    expect(e.selected).toBe('lstm');
  });

  it('the Race Prediction help quotes those numbers, names the script, and drops the old claims', () => {
    const help = [CHART_HELP.prediction.summary, ...CHART_HELP.prediction.howToRead, ...CHART_HELP.prediction.limitations].join(' ');
    console.log('L5 help text:\n' + [...CHART_HELP.prediction.howToRead.slice(0, 4), ...CHART_HELP.prediction.limitations.slice(0, 3)].join('\n'));
    expect(help).toContain('(evaluate_forecast script)');
    expect(help).not.toMatch(/notes\/|evidence\/|\.txt/);
    expect(help).toContain('LSTM 0.608 s, last clean lap + compound mean degradation 0.630 s, persistence (next laps = last clean lap) 0.637 s, per-stint linear extrapolation 0.749 s');
    expect(help).toContain('from 0.465 s at lap +1 to 0.737 s at lap +5');
    expect(help).toContain('Validation MAE, on which the method is chosen: LSTM 0.508 s, persistence 0.535 s, compound mean 0.537 s, per-stint linear 0.598 s');
    expect(help).toContain('LSTM 0.1147, tyre-age logistic regression 0.1156, base rate 0.1187 (LSTM PR-AUC 0.293)');
    expect(help).toContain('from 0.301 s to 1.532 s (2025-1)');
    expect(help).toContain('INTERMEDIATE tyres it is 1.307 s, where compound mean degradation does better (1.230 s)');
    expect(help).toContain('predicted 0.538-0.617, observed 0.345-0.359');
    expect(help).toContain('the 4 validation races');
    expect(help).toContain('the 7 held-out test races');
    expect(help).toContain('the chip names the method served instead and the forecast says the LSTM loses');
    expect(help).not.toMatch(/0\.4 s MAE|2\.5 s wet|2-3×|2–3×|HEURISTIC|spread pill|INSIGHTS_HUNGARY/);
    // every decimal number of the forecast lines is one of the evaluation's
    const e = fs.readFileSync(EVAL_FILE, 'utf8');
    const forecastLines = [...CHART_HELP.prediction.howToRead.slice(0, 4), ...CHART_HELP.prediction.limitations.slice(0, 2)].join(' ');
    for (const n of forecastLines.match(/\d+\.\d+/g)) expect(e.includes(n), n).toBe(true);
  });

  it('the panel names the served method, its held-out MAE, and says the LSTM loses', async () => {
    useF1Store.setState({
      raceProjection: { projections: [], numSimulations: 0, computedAtNow: 0, computedAtLap: 20 },
      raceSituationData: { driverFeatures: {} },
      lstmPredictions: { AAA: entry() },
    });
    const view = await render(RacePredictionPanel);
    const tab = [...view.host.querySelectorAll('button')].find((b) => text(b) === 'Forecast');
    expect(tab).toBeTruthy();
    await act(async () => { dom.mouse(tab, 'click'); });
    const body = text(view.host);
    expect(body).toContain('Lap-time forecast');
    expect(body).toContain('Persistence (next laps = last clean lap)');
    expect(body).toContain('held-out MAE 0.637 s (7 test races)');
    expect(body).toContain('The LSTM does not beat Persistence');
    expect(body).toContain('L20 96.00s');
    expect(body).toContain('pit (tyre-age logistic regression): 20%');
    expect(body).not.toMatch(/HEURISTIC|Δ position/);
    // a forecast with no laps (too few clean laps): the reason
    useF1Store.setState({ lstmPredictions: { AAA: entry({ predicted_times: [], target_laps: [], method: null, method_label: null, pit_probability: null, reason: 'Fewer than 3 clean laps at the clock.' }) } });
    await view.rerender();
    expect(text(view.host)).toContain('Fewer than 3 clean laps at the clock.');
    await view.unmount();
  });
});
