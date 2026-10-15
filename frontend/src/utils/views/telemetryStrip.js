/**
 * View model of the telemetry strip (components/visualizations/TelemetryStrip.jsx):
 * the laps drawn at sessionNow, how far a running lap is revealed, and the
 * comparison cards.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store state (weatherAtSessionTime is a
 * pure function exported by the store module).
 */
import { weatherAtSessionTime } from '../../store/useF1Store';
import { isLapCompleted, lapStartTime } from '../raceTime';
import { driverStateAt } from '../driverState';

/* ── Causal lap choice and cards (pure, tested in __tests__/views.timing*.test.js) ── */

/**
 * The lap a driver's telemetry trace shows at sessionNow (session seconds),
 * decision R6: with replay frames the lap in progress (drawn only up to now,
 * see truncateToNow), otherwise the driver's last completed lap.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {string} driver
 * @param {number} sessionNow - session seconds, Infinity = whole session
 * @param {Object} [opts] - { replayActive }
 * @returns {{lap: number|null, inProgress: boolean, lapsCompleted: number}}
 */
export function telemetryReferenceLap(lapTimes, driver, sessionNow, { replayActive = false } = {}) {
  const st = driverStateAt(lapTimes, driver, sessionNow, { dnf: false });
  if (replayActive && st.inProgress) {
    return { lap: st.inProgress.LapNumber, inProgress: true, lapsCompleted: st.lapsCompleted };
  }
  return { lap: st.lastCompleted ? st.lastCompleted.LapNumber : null, inProgress: false, lapsCompleted: st.lapsCompleted };
}

/**
 * Driver + lap pairs whose telemetry is fetched and drawn at sessionNow.
 * 'drivers' mode: each driver's reference lap (telemetryReferenceLap).
 * 'laps' mode: the focus driver's reference lap, then up to 3 comparison laps
 * that the driver has COMPLETED at now: a brushed or typed lap still to come
 * is neither fetched nor drawn until it is over.
 *
 * @returns {Array<{driver: string, lap: number, inProgress: boolean}>}
 */
export function telemetryTargets(lapTimes, sessionNow, {
  mode = 'drivers', focusDriver = null, selectedDrivers = [], compareLaps = [], replayActive = false,
} = {}) {
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return [];
  if (mode === 'drivers') {
    const drvs = selectedDrivers.length > 0 ? selectedDrivers.slice(0, 4) : (focusDriver ? [focusDriver] : []);
    return drvs
      .map((d) => ({ driver: d, ...telemetryReferenceLap(lapTimes, d, sessionNow, { replayActive }) }))
      .filter((t) => t.lap != null)
      .map(({ driver, lap, inProgress }) => ({ driver, lap, inProgress }));
  }
  const driver = focusDriver || selectedDrivers[0];
  if (!driver) return [];
  const ref = telemetryReferenceLap(lapTimes, driver, sessionNow, { replayActive });
  if (ref.lap == null) return [];
  // Comparison laps: only those the driver has completed at sessionNow
  const done = (compareLaps || []).filter((l) => l !== ref.lap && l >= 1 && l <= ref.lapsCompleted);
  return [
    { driver, lap: ref.lap, inProgress: ref.inProgress },
    ...done.slice(0, 3).map((l) => ({ driver, lap: l, inProgress: false })),
  ];
}

/**
 * Telemetry samples recorded by sessionNow (sample SessionTime, session
 * seconds): a lap still in progress is drawn only up to now.
 *
 * @param {Array<Object>} samples
 * @param {number} cutNow - session seconds (Infinity keeps everything)
 * @returns {Array<Object>}
 */
export function truncateToNow(samples, cutNow) {
  if (!Array.isArray(samples) || cutNow === Infinity || cutNow == null) return samples;
  return samples.filter((d) => d.SessionTime == null || d.SessionTime <= cutNow);
}

/**
 * The samples each drawn lap holds at sessionNow, causal (decision R6): a lap
 * in progress holds only its samples recorded by cutNow (truncateToNow), every
 * trace alike, the focus trace included. Nothing recorded after now is in the
 * chart's data, drawn or hidden: no axis, delta trace, sector boundary,
 * annotation or playhead can read it. A completed lap holds all its samples.
 * extent = the x of the last sample held (a running lap's lap time and full
 * length are not known yet; the x-axis takes the track's length from the
 * circuit outline); domainLimit = that extent for a running lap (null
 * otherwise), the bound of its y domains (inDomain).
 *
 * @param {Array<{driver: string, lap: number, inProgress: boolean}>} targets - telemetryTargets output
 * @param {Object} cache - store.telemetryCache: { 'DRV-lap-R': samples }
 * @param {Object} opts
 * @param {string} opts.cacheKeySuffix - the store's cache key suffix, '-<year>-<round>-<type>' (useF1Store.js telemetryKeySuffix)
 * @param {number} opts.cutNow - session seconds (Infinity keeps every sample)
 * @param {'distance'|'time'} [opts.xAxisMode='distance'] - time mode: Distance = the lap
 *   Time, _origDistance = metres
 * @returns {Array<Object|null>} one entry per target (same index): null when nothing is
 *   held, else { driver, lap, inProgress, key, data, extent, domainLimit }
 */
export function traceSamplesAt(targets, cache, { cacheKeySuffix = '-R', cutNow = Infinity, xAxisMode = 'distance' } = {}) {
  return (targets || []).map(({ driver, lap, inProgress }) => {
    const key = `${driver}-${lap}${cacheKeySuffix}`;
    const cached = cache?.[key];
    if (!Array.isArray(cached) || cached.length === 0) return null;
    const rawData = inProgress ? truncateToNow(cached, cutNow) : cached;
    if (rawData.length === 0) return null;
    const last = rawData[rawData.length - 1];
    const extent = xAxisMode === 'time' ? (last.Time ?? last.Distance) : last.Distance;
    const data = xAxisMode === 'time'
      ? rawData.map((d) => ({ ...d, Distance: d.Time != null ? d.Time : d.Distance, _origDistance: d.Distance }))
      : rawData;
    return {
      driver, lap, inProgress: !!inProgress, key, data, extent,
      domainLimit: inProgress && cutNow !== Infinity ? extent : null,
    };
  });
}

/**
 * x of the last sample recorded by cutNow (session seconds), in axis units:
 * Distance (m), or the lap Time (s) in time mode. -Infinity when no sample is
 * recorded yet. A running lap's samples beyond it are in the future: they
 * are never in its trace (traceSamplesAt) and never set an axis (inDomain).
 *
 * @param {Array<Object>} samples - one lap's telemetry (Distance, Time, SessionTime)
 * @param {number} cutNow - session seconds
 * @param {'distance'|'time'} [xAxisMode='distance']
 * @returns {number}
 */
export function recordedExtent(samples, cutNow, xAxisMode = 'distance') {
  const recorded = truncateToNow(samples || [], cutNow);
  const last = recorded[recorded.length - 1];
  if (!last) return -Infinity;
  return xAxisMode === 'time' ? (last.Time ?? last.Distance) : last.Distance;
}

/**
 * How far a running lap's trace is revealed at `now` (session seconds), from
 * the lap's OWN samples: the point between the last sample recorded by now
 * (SessionTime <= now) and the next one, interpolated in time. Never from the
 * car's position on the track map: just after the timing line that position
 * is still nearest to the END of the track outline, which would reveal the
 * whole lap ahead of time.
 *
 * @param {Array<Object>} data - one lap's trace samples (SessionTime; Distance =
 *   the axis x: metres, or the lap Time in time mode with _origDistance = metres)
 * @param {number} now - session seconds (Infinity = the whole lap)
 * @returns {{x: number, distance: number, complete: boolean}|null}
 *   x in axis units, distance in metres; -Infinity before the first sample;
 *   complete when every sample is recorded (nothing to hide). null when the
 *   samples carry no SessionTime.
 */
export function revealPoint(data, now) {
  if (!Array.isArray(data) || data.length === 0 || data[0]?.SessionTime == null) return null;
  const meters = (d) => d._origDistance ?? d.Distance;
  const last = data[data.length - 1];
  if (now == null || Number.isNaN(now) || now === Infinity
      || (last.SessionTime != null && last.SessionTime <= now)) {
    return { x: last.Distance, distance: meters(last), complete: true };
  }
  // Last sample recorded by now (SessionTime ascending)
  let lo = 0;
  let hi = data.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = data[mid].SessionTime;
    if (at != null && at <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return { x: -Infinity, distance: -Infinity, complete: false };
  const a = data[idx];
  const b = data[idx + 1];
  const span = b.SessionTime - a.SessionTime;
  const f = span > 0 ? Math.max(0, Math.min(1, (now - a.SessionTime) / span)) : 0;
  return {
    x: a.Distance + (b.Distance - a.Distance) * f,
    distance: meters(a) + (meters(b) - meters(a)) * f,
    complete: false,
  };
}

/**
 * True when a sample may set a y-axis domain: no limit on the trace, or
 * recorded by now (x <= trace.domainLimit, see recordedExtent).
 *
 * @param {{domainLimit?: number|null}} trace
 * @param {{Distance: number}} d - a sample (Distance holds the x value in both axis modes)
 * @returns {boolean}
 */
export function inDomain(trace, d) {
  return trace.domainLimit == null || (d.Distance != null && d.Distance <= trace.domainLimit);
}

/**
 * Comparison cards for the drawn laps at sessionNow, causal (decision R6):
 * a lap in progress shows only its sectors already run, no lap time, and the
 * tyre set in force (the old set until the pit exit); a completed lap shows
 * its own values. Best sectors come from the driver's completed laps;
 * weather is the reading in force at the lap's start (session time).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full session)
 * @param {Array<Object>} weather - sessionData.weather_data
 * @param {Array<{driver: string, lap: number}>} targets - telemetryTargets output
 * @param {number} sessionNow - session seconds
 * @returns {Array<Object>} one card per target
 */
export function telemetryCards(lapTimes, weather, targets, sessionNow) {
  const rows = Array.isArray(lapTimes) ? lapTimes : [];
  return (targets || []).map(({ driver, lap }) => {
    const lapData = rows.find((lt) => lt.Driver === driver && lt.LapNumber === lap) || null;
    const completed = lapData ? isLapCompleted(lapData, sessionNow) : false;
    const st = completed ? null : driverStateAt(rows, driver, sessionNow, { dnf: false });
    const live = st && st.inProgress === lapData ? st : null;
    // Best sector times over the driver's completed laps (for color-coding)
    let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity;
    for (const lt of rows) {
      if (lt.Driver !== driver || !isLapCompleted(lt, sessionNow)) continue;
      if (lt.Sector1TimeSeconds > 0 && lt.Sector1TimeSeconds < bestS1) bestS1 = lt.Sector1TimeSeconds;
      if (lt.Sector2TimeSeconds > 0 && lt.Sector2TimeSeconds < bestS2) bestS2 = lt.Sector2TimeSeconds;
      if (lt.Sector3TimeSeconds > 0 && lt.Sector3TimeSeconds < bestS3) bestS3 = lt.Sector3TimeSeconds;
    }
    // Weather in force at the start of this lap
    const start = lapData ? lapStartTime(lapData) : null;
    const w = start != null ? weatherAtSessionTime(weather, start) : null;
    // A lap not over yet: the set in force at now, never the row's own fields
    const tyreLife = completed ? lapData?.TyreLife : st?.tyreLife;
    return {
      driver, lap,
      compound: (completed ? lapData?.Compound : st?.compound) || 'UNKNOWN',
      tyreLife: tyreLife != null ? Math.round(tyreLife) : null,
      airTemp: w?.AirTemp ?? null,
      trackTemp: w?.TrackTemp ?? null,
      lapTime: completed ? lapData.LapTimeSeconds : null,
      s1: completed ? lapData.Sector1TimeSeconds : (live?.visibleSectors.s1 ?? null),
      s2: completed ? lapData.Sector2TimeSeconds : (live?.visibleSectors.s2 ?? null),
      s3: completed ? lapData.Sector3TimeSeconds : (live?.visibleSectors.s3 ?? null),
      bestS1: bestS1 < Infinity ? bestS1 : null,
      bestS2: bestS2 < Infinity ? bestS2 : null,
      bestS3: bestS3 < Infinity ? bestS3 : null,
    };
  });
}
