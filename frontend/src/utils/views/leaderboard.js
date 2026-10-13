/**
 * View model of the leaderboard (components/visualizations/Leaderboard.jsx):
 * the causal race and qualifying standings at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { getDriverColor } from '../colors';
import { driverStateAt, lastRankedLap, nonFinisherMap, qualifyingOrder } from '../driverState';
import { pitStops } from '../stints';
import { pitCountsByDriver } from '../strategyViews';

/* ── Causal race standings (pure, tested in __tests__/views.timing*.test.js) ── */
/**
 * Race standings at sessionNow (session seconds), causal (decision R6,
 * utils/driverState.js):
 *  - order: more laps completed first, then the earlier line crossing of the
 *    last completed lap (utils/driverState.js lastRankedLap: a car's truncated
 *    lap after it stopped on track does not count); drivers with no completed
 *    lap by grid slot;
 *  - last lap time, gap and interval of the last completed lap (a lap's values
 *    are known at its end, never those of the lap in progress);
 *  - tyre = the set in force (the new set from the pit exit), IN PIT while in
 *    the pit lane, retired only once the retirement has happened;
 *  - pit stops = tyre changes visible at now (utils/stints.js pitStops, R2).
 * Drivers who have not started a lap yet are left out.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} sessionNow - session seconds, Infinity = whole race
 * @param {Object} [opts] - { dnfMap, gridPositions: { driver: grid slot } }
 * @returns {Array<Object>} rows, active drivers first
 */
export function raceStandings(lapTimes, sessionNow, { dnfMap = {}, gridPositions = {} } = {}) {
  const now = sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
  const rows = Array.isArray(lapTimes) ? lapTimes : [];
  const byDriver = new Map();
  for (const lt of rows) {
    if (!lt?.Driver) continue;
    if (!byDriver.has(lt.Driver)) byDriver.set(lt.Driver, []);
    byDriver.get(lt.Driver).push(lt);
  }
  const stops = pitCountsByDriver(pitStops(rows, { sessionNow: now }));
  // Results DNFs plus classified drivers who stopped before the flag
  const nonFinishers = nonFinisherMap(rows, dnfMap);

  const out = [];
  for (const [drv, driverRows] of byDriver) {
    const st = driverStateAt(driverRows, drv, now, { dnf: !!nonFinishers[drv] });
    const done = st.lastCompleted;
    if (!done && !st.inProgress) continue; // no lap started yet
    const dnf = st.retired ? (nonFinishers[drv] || null) : null;
    const ranked = lastRankedLap(driverRows, drv, now);
    out.push({
      pos: 99,
      abbr: drv,
      color: getDriverColor(drv),
      compound: st.compound || 'UNKNOWN',
      tyreLife: st.tyreLife || 0,
      lapTime: done?.LapTimeSeconds || null,
      bestLap: null,
      interval: done?.IntervalToAhead || null,
      gapToLeader: done?.GapToLeader || null,
      isPitting: st.inPitLane,
      isRetired: st.retired,
      retiredStatus: st.retired ? (dnf?.status || 'RET') : null,
      // the lap of the retirement from the rows (dnfMap lastLap = race_results
      // Laps is a final result, known only once the final row has ended)
      retiredLap: st.retired ? (st.retiredLap ?? st.lapsCompleted) : null,
      isGrid: false,
      pitStops: stops[drv] || 0,
      // Order on the last lap that counts (lastRankedLap: never the truncated
      // row of a car that stopped on track)
      _laps: ranked ? Number(ranked.LapNumber) : 0,
      _crossed: ranked && Number.isFinite(ranked.Time) ? ranked.Time : Infinity,
      _position: ranked && Number.isFinite(ranked.Position) ? ranked.Position : Infinity,
      _grid: gridPositions[drv] ?? Infinity,
    });
  }
  const order = (a, b) => (b._laps - a._laps) || (a._crossed - b._crossed)
    || (a._position - b._position) || (a._grid - b._grid);
  const active = out.filter((r) => !r.isRetired).sort(order);
  const retired = out.filter((r) => r.isRetired).sort(order);
  return [...active, ...retired].map(({ _laps, _crossed, _position, _grid, ...r }, i) => ({ ...r, pos: i + 1 }));
}

const QUALI_COMPOUND_NAMES = { 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };

/**
 * Qualifying standings at sessionNow (session seconds), causal (R6): the
 * order and gaps of each driver's best lap COMPLETED by now
 * (utils/driverState.js qualifyingOrder), never the final classification
 * (race_results Position) nor a lap still to come; drivers without a time yet
 * come after, with no gap. Tyre: the replay frame's (the car on track now),
 * else the best lap's.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {number} sessionNow - session seconds
 * @param {Object} [opts]
 * @param {string[]} [opts.drivers] - the active segment's drivers (all when empty)
 * @param {Object} [opts.frameDrivers] - the replay frame's drivers ({tyre, tyre_life, speed})
 * @param {Object} [opts.stops] - pitCountsByDriver at sessionNow
 * @returns {Array<Object>} leaderboard rows
 */
export function qualifyingStandings(lapTimes, sessionNow, { drivers = [], frameDrivers = {}, stops = {} } = {}) {
  const order = qualifyingOrder(lapTimes, sessionNow, { drivers });
  const leaderTime = order[0]?.best ? order[0].best.LapTimeSeconds : null;
  return order.map(({ driver: abbr, best }, i) => {
    const fd = frameDrivers[abbr];
    const time = best ? best.LapTimeSeconds : null;
    const gap = i === 0 || time == null || leaderTime == null ? null : +(time - leaderTime).toFixed(3);
    return {
      pos: i + 1,
      abbr,
      color: getDriverColor(abbr),
      compound: fd ? (QUALI_COMPOUND_NAMES[fd.tyre] || 'UNKNOWN') : (best?.Compound || 'UNKNOWN'),
      tyreLife: fd ? fd.tyre_life : 0,
      lapTime: time,
      bestLap: time,
      interval: gap,
      gapToLeader: gap,
      isPitting: false,
      isRetired: false,
      retiredStatus: null,
      retiredLap: null,
      isGrid: false,
      pitStops: stops[abbr] || 0,
      speed: fd?.speed || null,
    };
  });
}
