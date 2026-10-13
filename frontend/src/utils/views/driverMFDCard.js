/**
 * View model of the driver MFD card (components/ui/DriverMFDCard.jsx):
 * the tyre set in force for the highlighted driver at sessionNow.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import { driverStateAt } from '../driverState';

/**
 * The tyre set in force for one driver at sessionNow (session seconds), from
 * the lap data (decision R3/R6, utils/driverState.js): the old set until the
 * pit exit, then the new one with its out-lap tyre age. null before the
 * driver's first lap.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver
 * @param {number} sessionNow - session seconds, Infinity = whole race
 * @returns {{compound: string, tyreLife: number|null}|null}
 */
export function mfdTyreInfo(lapTimes, driver, sessionNow) {
  if (!driver || !Array.isArray(lapTimes)) return null;
  const st = driverStateAt(lapTimes, driver, sessionNow, { dnf: false });
  if (!st.stint) return null;
  return {
    compound: st.compound || 'UNKNOWN',
    tyreLife: st.tyreLife != null ? Math.round(st.tyreLife) : null,
  };
}
