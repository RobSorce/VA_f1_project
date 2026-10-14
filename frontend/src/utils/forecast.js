/**
 * Lap-time forecast of POST /api/predict/lstm: the request the store sends
 * and the one shape it keeps (store.lstmPredictions).
 *
 * The backend builds the model window itself from the session's lap rows at
 * a clock (backend/model/features.py build_window, the function the model
 * was trained with), so the request carries identifiers only, never features:
 *  - a session with cached rows on screen (a replay, or a mock live replay of
 *    a cached race): {year, round, session_type, driver, session_now,
 *    max_lap, lap};
 *  - a live feed with no cached race (sessionScopeOf null): {driver,
 *    session_now, session_type, lap_rows, weather_rows, max_lap}, with the
 *    driver's lap rows received so far.
 * The response names the method it served (method / method_label: the
 * method chosen on the validation races, backend/model/predict.py), every
 * method's held-out MAE (held_out.values, the test races of
 * notes/experiments/phase6/evaluate_forecast.txt) and lstm_note, which says
 * when the LSTM loses.
 *
 * store.lstmPredictions = null | { [driver]: entry }: one entry, the focus
 * driver's, asked by a double-click (store triggerPrediction), tagged with
 * driver, lap (the origin lap: the last lap the forecast used), method and
 * computedAtNow (the clock it was asked at).
 */
import { sessionScopeOf, viewSessionType } from './strategyViews';
import { lapEndTime } from './raceTime';

/** Laps forecast after the origin lap (backend model/features.py PREDICT_LEN). */
export const FORECAST_LAPS = 5;

/**
 * The held-out evaluation the help text quotes (utils/chartHelp.js
 * prediction): every number is copied from
 * notes/experiments/phase6/evaluate_forecast.txt (backend
 * scripts/evaluate_forecast.py; __tests__/forecast.help.test.js checks each
 * one against that file). MAE in seconds over laps +1..+5, pooled; the method
 * is chosen on the validation races, the test races give the held-out
 * numbers. A response carries its own held_out numbers (the served file).
 */
export const FORECAST_EVALUATION = Object.freeze({
  source: 'notes/experiments/phase6/evaluate_forecast.txt',
  valRaces: 4,
  testRaces: 7,
  // pooled MAE, s
  valMae: Object.freeze({ lstm: 0.508, persistence: 0.535, compound_mean: 0.537, stint_linear: 0.598 }),
  testMae: Object.freeze({ lstm: 0.608, compound_mean: 0.630, persistence: 0.637, stint_linear: 0.749 }),
  // the LSTM's test MAE at laps +1 .. +5
  lstmTestMaeByLap: Object.freeze([0.465, 0.556, 0.624, 0.691, 0.737]),
  // test MAE of the windows whose origin stint is on INTERMEDIATE tyres
  intermediateMae: Object.freeze({ lstm: 1.307, compound_mean: 1.230 }),
  // the LSTM's test MAE per race: lowest, highest (and that race)
  lstmRaceMae: Object.freeze({ low: 0.301, high: 1.532, highRace: '2025-1' }),
  // pit stop within 5 laps: test Brier score, the LSTM's PR-AUC
  pitBrier: Object.freeze({ lstm: 0.1147, tyre_age_logistic: 0.1156, base_rate: 0.1187 }),
  lstmPitPrAuc: 0.293,
  // LSTM calibration bins above 0.5: mean predicted vs observed rate
  lstmPitAbove50: Object.freeze({ predictedLow: 0.538, predictedHigh: 0.617, observedLow: 0.345, observedHigh: 0.359 }),
});

/** Names of the pit-probability methods (backend model/baselines.py METHOD_LABELS). */
const PIT_METHOD_LABELS = Object.freeze({
  lstm: 'LSTM',
  tyre_age_logistic: 'tyre-age logistic regression',
  base_rate: 'base rate',
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Body of the forecast request for one driver at the clock on screen, or
 * null when nothing can be asked (no session rows).
 *
 * @param {Object} s - store state
 * @param {Object} p
 * @param {string} p.driver
 * @param {number} p.lap - the driver's last lap to use (a clicked lap, never
 *   later than the replay's)
 * @param {number} p.sessionNow - the store's clock (session seconds; Infinity = no limit)
 * @returns {Object|null}
 */
export function forecastRequestOf(s, { driver, lap, sessionNow }) {
  const lapTimes = s?.sessionData?.lap_times;
  if (!driver || !Array.isArray(lapTimes) || !lapTimes.length) return null;
  const scope = sessionScopeOf(s);
  const sessionType = viewSessionType(s);
  const askedLap = finite(lap) ? lap : null;
  if (s.isLiveMode) {
    // The race distance is the feed's total laps (store maxLap is the
    // furthest lap received so far); unknown: the backend projects no pit lap
    const maxLap = finite(s.totalRaceLaps) && s.totalRaceLaps > 0 ? s.totalRaceLaps : null;
    if (scope) {
      // A mock replay of a cached race: its cached rows, up to the end of
      // the latest lap row received (the feed's clock; every received lap is
      // over), never the laps the feed has not sent yet
      let clock = null;
      for (const row of lapTimes) {
        const end = lapEndTime(row);
        if (finite(end) && (clock == null || end > clock)) clock = end;
      }
      return {
        year: scope.year, round: scope.round, session_type: sessionType, driver,
        session_now: clock, max_lap: maxLap, lap: askedLap,
      };
    }
    // A live feed: no cached payload, its rows are sent (that driver's only:
    // the window reads no other car's row)
    return {
      driver,
      session_now: null,
      session_type: sessionType,
      lap_rows: lapTimes.filter((r) => r?.Driver === driver),
      weather_rows: Array.isArray(s.sessionData?.weather_data) ? s.sessionData.weather_data : [],
      max_lap: maxLap,
      lap: askedLap,
    };
  }
  if (!scope) return null;
  return {
    year: scope.year,
    round: scope.round,
    session_type: scope.sessionType || sessionType,
    driver,
    // JSON has no Infinity: the race-over clock is sent as null (every lap
    // completed) and the lap caps the window
    session_now: finite(sessionNow) ? sessionNow : null,
    max_lap: finite(s.maxLap) && s.maxLap > 0 ? s.maxLap : null,
    lap: askedLap,
  };
}

/**
 * The store's entry for one forecast response: the response with its tags
 * (driver, lap = origin lap, method, askedLap, computedAtNow). null when the
 * response is not an object or is another driver's.
 *
 * @param {Object} response - POST /api/predict/lstm answer
 * @param {Object} p
 * @param {string} p.driver - the driver asked for
 * @param {number} p.askedLap
 * @param {number} p.at - session seconds of the clock it was asked at
 * @returns {Object|null}
 */
export function forecastEntry(response, { driver, askedLap, at }) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  if (response.driver != null && response.driver !== driver) return null;
  return {
    ...response,
    driver,
    lap: finite(response.origin_lap) ? response.origin_lap : askedLap,
    method: response.method ?? null,
    askedLap,
    computedAtNow: at,
  };
}

/**
 * The forecast of `driver` in store.lstmPredictions, only when it is tagged
 * with that driver (never another driver's forecast under the key).
 *
 * @param {Object|null} lstmPredictions - store.lstmPredictions
 * @param {string|null} driver
 * @returns {Object|null}
 */
export function focusForecast(lstmPredictions, driver) {
  if (!driver || !lstmPredictions || typeof lstmPredictions !== 'object') return null;
  const entry = lstmPredictions[driver];
  return entry && typeof entry === 'object' && entry.driver === driver ? entry : null;
}

/**
 * Forecast points {lap, time}: each predicted time at its target lap
 * (target_laps = origin + 1 .. origin + FORECAST_LAPS), never at "the last
 * lap on screen + i".
 *
 * @param {Object|null} entry - focusForecast
 * @returns {Array<{lap: number, time: number}>}
 */
export function forecastPoints(entry) {
  const times = Array.isArray(entry?.predicted_times) ? entry.predicted_times : [];
  const targets = Array.isArray(entry?.target_laps) ? entry.target_laps : [];
  const out = [];
  times.forEach((time, i) => {
    const lap = finite(targets[i]) ? targets[i] : (finite(entry?.lap) ? entry.lap + i + 1 : null);
    if (finite(time) && time > 0 && time < 300 && finite(lap)) out.push({ lap, time });
  });
  return out;
}

/**
 * Name of the method that made the forecast (the response's method_label).
 *
 * @param {Object|null} entry
 * @returns {string}
 */
export function forecastMethodLabel(entry) {
  return entry?.method_label || entry?.method || 'Forecast';
}

/**
 * Held-out MAE (s, laps +1..+5 pooled, test races) of the served method,
 * from the response (held_out.values[method]); null when not given.
 *
 * @param {Object|null} entry
 * @returns {number|null}
 */
export function forecastHeldOutMae(entry) {
  const v = entry?.held_out?.values?.[entry?.method];
  return finite(v) ? v : null;
}

/**
 * The served method's held-out error, e.g. "held-out MAE 0.608 s (7 test
 * races)"; '' when the response has none.
 *
 * @param {Object|null} entry
 * @returns {string}
 */
export function forecastHeldOutText(entry) {
  const mae = forecastHeldOutMae(entry);
  if (mae == null) return '';
  const n = Array.isArray(entry?.held_out?.races) ? entry.held_out.races.length : null;
  return `held-out MAE ${mae.toFixed(3)} s${n ? ` (${n} test races)` : ''}`;
}

/**
 * One line naming the served method and its held-out error, e.g.
 * "LSTM · held-out MAE 0.608 s (7 test races)".
 *
 * @param {Object|null} entry
 * @returns {string}
 */
export function forecastMethodText(entry) {
  const label = forecastMethodLabel(entry);
  const held = forecastHeldOutText(entry);
  return held ? `${label} · ${held}` : label;
}

/**
 * A window feature of the origin lap (the last row of window.values), e.g.
 * 'origin_tyre_life'; null when the response has no window.
 *
 * @param {Object|null} entry
 * @param {string} name - one of window.features
 * @returns {number|null}
 */
export function forecastOriginFeature(entry, name) {
  const i = Array.isArray(entry?.window?.features) ? entry.window.features.indexOf(name) : -1;
  const values = entry?.window?.values;
  const last = Array.isArray(values) && values.length ? values[values.length - 1] : null;
  return i >= 0 && Array.isArray(last) && finite(last[i]) ? last[i] : null;
}

/**
 * Pit probability of the forecast and the method behind it; probability
 * null outside a race, with too few clean laps, or with no pit method.
 *
 * @param {Object|null} entry
 * @returns {{probability: number|null, method: string|null, label: string|null}}
 */
export function forecastPit(entry) {
  const p = entry?.pit_probability;
  const method = entry?.pit_method ?? null;
  return {
    probability: finite(p) ? p : null,
    method,
    label: method ? (PIT_METHOD_LABELS[method] || method) : null,
  };
}
