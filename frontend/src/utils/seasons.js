/**
 * Selectable seasons and the season of the session on screen (D15).
 *
 * The year pickers (SessionMenu, SessionSelectorScreen, SessionSelector,
 * SettingsTabContent) list the seasons of GET /api/seasons (backend
 * api/main.py get_seasons: 2018 up to the clock year + 1, the current and the
 * next season once their schedule is published), newest first. When the
 * backend cannot be reached the list the pickers had before is used
 * (FALLBACK_SEASONS), so the selector still works offline on cached races.
 *
 * DRS: FastF1 says "drs is no longer included in 2026" (fastf1/_api.py), so
 * from that season the DRS channel is 0 on every sample and the cached 2026
 * sessions have circuit_info.drs_zones = []. Every DRS layer, toggle and HUD
 * readout asks seasonHasDrs(sessionSeasonOf(state)) and is hidden from 2026.
 *
 * Pure module: no React, no store access (state objects are passed in).
 */

/** The hard-coded year list of the pickers before /api/seasons was read: the offline fallback. */
export const FALLBACK_SEASONS = Object.freeze([2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]);

/**
 * First season without DRS. A regulation fact, not a model choice: FastF1
 * stops reporting DRS from 2026 (see the module comment).
 */
export const FIRST_SEASON_WITHOUT_DRS = 2026;

/**
 * The seasons of a /api/seasons payload ({ seasons: [2018, ...] } or a bare
 * array), as integers, unique, newest first. FALLBACK_SEASONS when the payload
 * holds none.
 *
 * @param {Object|Array} payload
 * @returns {number[]}
 */
export function seasonsFromResponse(payload) {
  const list = Array.isArray(payload) ? payload : payload?.seasons;
  const years = [...new Set((Array.isArray(list) ? list : [])
    .map((y) => Number(y))
    .filter((y) => Number.isInteger(y) && y > 0))]
    .sort((a, b) => b - a);
  return years.length ? years : [...FALLBACK_SEASONS];
}

/**
 * Options of a year picker: the seasons, plus the selected year when it is
 * not among them (a year kept from an earlier visit, e.g. offline), newest
 * first, so the picker always shows the year in use.
 *
 * @param {number[]} seasons - store.seasons
 * @param {number} [selected] - store.year
 * @returns {number[]}
 */
export function yearOptions(seasons, selected) {
  const out = Array.isArray(seasons) && seasons.length ? [...seasons] : [...FALLBACK_SEASONS];
  const y = Number(selected);
  if (Number.isInteger(y) && y > 0 && !out.includes(y)) out.push(y);
  return out.sort((a, b) => b - a);
}

/**
 * Does a season have DRS? false from FIRST_SEASON_WITHOUT_DRS on; true when
 * the season is unknown (nothing hidden on a guess).
 *
 * @param {number|null|undefined} year
 * @returns {boolean}
 */
export function seasonHasDrs(year) {
  const y = Number(year);
  if (year == null || !Number.isFinite(y)) return true;
  return y < FIRST_SEASON_WITHOUT_DRS;
}

/**
 * Season of the session on screen, from store fields: live feed -> the year
 * of its SessionInfo StartDate, else the mock replay's year; replay -> the
 * year loadSession recorded (store.loadedYear; never the year pill, which the
 * session menus change without loading). null when unknown.
 *
 * @param {Object} s - store state
 * @returns {number|null}
 */
export function sessionSeasonOf(s) {
  if (s?.isLiveMode) {
    const start = s.liveSessionInfo?.start_date;
    const t = typeof start === 'string' && start ? Date.parse(start) : NaN;
    if (Number.isFinite(t)) return new Date(t).getUTCFullYear();
    const mock = Number(s.liveMockSession?.year);
    return Number.isInteger(mock) ? mock : null;
  }
  const y = Number(s?.loadedYear);
  return s?.loadedYear != null && Number.isInteger(y) ? y : null;
}
