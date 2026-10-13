/**
 * View model of the position chart (components/visualizations/PositionByLap.jsx):
 * the pit-stop markers visible at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { isLapCompleted } from '../raceTime';
import { pitStops } from '../stints';

/**
 * Pit-stop markers for the position chart at sessionNow (session seconds):
 * one per tyre change visible at that time (utils/stints.js pitStops, R2:
 * from the pit exit; drive-throughs and SC pit-lane passes are not stops),
 * placed on the in-lap at the position the driver had at its end.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} sessionNow - session seconds, Infinity = whole race
 * @returns {Array<{driver: string, lap: number, position: number, fromCompound: string,
 *   toCompound: string, tyreAge: number|null}>}
 */
export function positionPitMarkers(lapTimes, sessionNow) {
  const rows = Array.isArray(lapTimes) ? lapTimes : [];
  const inLaps = new Map();
  for (const lt of rows) inLaps.set(`${lt.Driver}_${lt.LapNumber}`, lt);
  const out = [];
  for (const stop of pitStops(rows, { sessionNow })) {
    const inRow = inLaps.get(`${stop.Driver}_${stop.inLap}`);
    // The in-lap is over at the pit exit; its end position places the marker
    if (!inRow?.Position || !isLapCompleted(inRow, sessionNow)) continue;
    out.push({
      driver: stop.Driver,
      lap: stop.inLap,
      position: inRow.Position,
      fromCompound: stop.fromCompound,
      toCompound: stop.toCompound,
      tyreAge: inRow.TyreLife ?? null,
    });
  }
  return out;
}
