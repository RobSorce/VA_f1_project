/**
 * View model of the PCA biplot (components/visualizations/PCABiplot.jsx):
 * which points are drawn (the race filter), their shape (the rows of the
 * race on screen are stars), their colour (team, or the class of the
 * finishing position), the legends of both encodings and the tooltip. Pure
 * functions: the component draws exactly these values.
 *
 * The loaded race is the race of the weekend on screen (store sessionScopeOf:
 * the session loadSession put on screen, never the session pills). Its result
 * and its post-race rows are shown only once that race has been run at the
 * clock on screen (loadedRaceClock 'ended': the race itself on screen, its
 * clock at the end). While it runs (a replay before its end, or live) its rows
 * are those at the clock (store loadPCAEmbeddings, backend pca_embeddings_at),
 * and while another session of the weekend is on screen (practice,
 * qualifying, sprint) it has not started: no row of it is drawn (decisions
 * R3/R6: no view shows what has not happened yet).
 */
import * as d3 from 'd3';
import {
  getTeamColor, F1_POINTS, OUTCOME_COLORS, markColor, textColor, SURFACES, TEXT_COLORS, CHART_FONT,
} from '../colors';

// Areas of the marks (d3.symbol size, px^2): rows of other races, rows of the
// loaded race, a hovered mark
export const MARK_AREA = { other: 50, loaded: 120, hover: 150 };

/**
 * Path of a mark at (0, 0): a star for a row of the loaded race, else a circle.
 * @param {boolean} loaded
 * @param {boolean} [hover]
 * @returns {string}
 */
export function markPath(loaded, hover = false) {
  const area = hover ? MARK_AREA.hover : loaded ? MARK_AREA.loaded : MARK_AREA.other;
  return d3.symbol().type(loaded ? d3.symbolStar : d3.symbolCircle).size(area)();
}

/**
 * Legend swatch of a mark: the mark's own path (components/ui/Legend.jsx
 * shape 'symbol') and a viewBox around it, with room for the stroke.
 * @param {boolean} loaded
 * @returns {{shape: 'symbol', path: string, viewBox: string}}
 */
export function markSwatch(loaded) {
  const path = markPath(loaded);
  const nums = path.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || ['0'];
  const r = Math.max(...nums.map((v) => Math.abs(Number(v)))) + 1.5;
  return { shape: 'symbol', path, viewBox: `${-r} ${-r} ${2 * r} ${2 * r}` };
}

// ── Race filter ───────────────────────────────────────────────────────

export const PCA_FILTERS = ['all', 'season', 'race'];

/**
 * {year, round, sessionType} of the session on screen (a sessionScopeOf
 * result; sessionType 'R' when absent, as sessionScopeOf), or null. The
 * loaded race is the race ('R') of that weekend.
 * @param {{year: number, round: number, sessionType?: string}|null} scope
 */
export function loadedRaceOf(scope) {
  if (!scope?.year || !scope?.round) return null;
  return { year: Number(scope.year), round: Number(scope.round), sessionType: scope.sessionType || 'R' };
}

export function isLoadedRace(point, loaded) {
  return !!loaded && Number(point.year) === loaded.year && Number(point.round) === loaded.round;
}

/**
 * Points kept by a filter: 'all'; 'season' = the loaded race's season;
 * 'race' = the loaded race's rows. Without a loaded race 'season' and 'race'
 * keep nothing.
 */
export function filterPoints(points, filter, loaded) {
  const list = Array.isArray(points) ? points : [];
  if (filter === 'race') return loaded ? list.filter((p) => isLoadedRace(p, loaded)) : [];
  if (filter === 'season') return loaded ? list.filter((p) => Number(p.year) === loaded.year) : [];
  return list;
}

/**
 * The filter buttons: label, number of points kept, and why a filter that
 * keeps nothing is disabled.
 * @param {Array<Object>} points - the points that can be drawn (causalPoints)
 * @param {Object|null} loaded - loadedRaceOf
 * @param {{raceClock?: string, reason?: string}} [clock] - loadedRaceClock of the
 *   session on screen, and the embeddings' current_race.reason (why the race
 *   has no row yet at the clock)
 * @returns {Array<{key: string, label: string, count: number, disabled: boolean, title: string}>}
 */
export function filterOptions(points, loaded, { raceClock = 'ended', reason = null } = {}) {
  const races = new Set((points || []).map((p) => `${p.year}-${p.round}`)).size;
  return PCA_FILTERS.map((key) => {
    const count = filterPoints(points, key, loaded).length;
    const label = key === 'all' ? 'All races' : key === 'season' ? (loaded ? `${loaded.year} season` : 'Season') : 'This race';
    let title;
    if (key === 'all') title = `Every row of the ${races} races in the PCA set`;
    else if (!loaded) title = 'Load a session to filter by its season or race';
    else if (count === 0 && key === 'race' && raceClock === 'not-started') {
      title = `The race of ${loaded.year} R${loaded.round} has not started: the session on screen is ${loaded.sessionType}`;
    } else if (count === 0 && key === 'race' && raceClock === 'running') {
      title = `No row of ${loaded.year} R${loaded.round} at the replay clock yet${reason ? `: ${reason}` : ''}`;
    } else if (count === 0) {
      title = key === 'race'
        ? `${loaded.year} R${loaded.round} is not among the ${races} races in the PCA set`
        : `No race of ${loaded.year} in the PCA set`;
    } else {
      title = key === 'race'
        ? `Only the rows of ${loaded.year} R${loaded.round} (the session on screen)`
        : `Only the races of ${loaded.year}`;
    }
    return { key, label, count, disabled: key !== 'all' && count === 0, title };
  });
}

// ── Outcome (finishing position) ───────────────────────────────────────

// Places that score points (utils/colors.js F1_POINTS: P1..P10) and the podium
export const POINTS_PLACES = Math.max(...Object.keys(F1_POINTS).map(Number));
export const PODIUM_PLACES = 3;

// Sequential classes, brighter = better result: cividis at t = 1, 0.685 and
// 0.37, the lowest t at which the colour still reaches 3:1 against the panel
// background (scripts/pca_outcome_palette.mjs, output in
// notes/experiments/phase67/pca_outcome_palette.txt: contrast 14.86 / 7.03 /
// 3.07, L* 92.2 / 66.1 / 42.1)
export const OUTCOME_CLASSES = [
  { key: 'podium', label: `Podium (P1–P${PODIUM_PLACES})`, color: OUTCOME_COLORS.podium },
  { key: 'points', label: `Points (P${PODIUM_PLACES + 1}–P${POINTS_PLACES})`, color: OUTCOME_COLORS.points },
  { key: 'none', label: `No points (P${POINTS_PLACES + 1}+)`, color: OUTCOME_COLORS.none },
];

// A row whose finishing position is not shown (the loaded race while its
// clock runs, or a row computed as of a lap): drawn as an outline
export const OUTCOME_PENDING = { key: 'pending', label: 'Result not known yet', color: 'none' };

/**
 * Where the loaded weekend's race stands at the clock on screen:
 *  - 'not-started': another session of the weekend is on screen (practice,
 *    qualifying, sprint: sessionType other than 'R'), run before the race;
 *  - 'running': the race is on screen and its clock runs (a replay before its
 *    last frame / lap, session clock finite, or a live feed);
 *  - 'ended': the race is on screen at its end (session clock Infinity).
 * @param {{sessionType?: string, sessionNow: number, isLiveMode: boolean}} p
 *   sessionType of the session on screen ('R' when absent, as sessionScopeOf)
 * @returns {'not-started'|'running'|'ended'}
 */
export function loadedRaceClock({ sessionType = 'R', sessionNow, isLiveMode } = {}) {
  if ((sessionType || 'R') !== 'R') return 'not-started';
  if (isLiveMode || Number.isFinite(sessionNow)) return 'running';
  return 'ended';
}

/**
 * True until the loaded race has been run at the clock on screen
 * (loadedRaceClock other than 'ended'): its result and its post-race rows are
 * not shown.
 * @param {{sessionType?: string, sessionNow: number, isLiveMode: boolean}} p
 */
export function loadedResultHidden(p = {}) {
  return loadedRaceClock(p) !== 'ended';
}

/** True when the loaded race's result is withheld in this context. */
function resultWithheld(loaded, resultHidden) {
  return !!loaded && (!!resultHidden || (loaded.sessionType || 'R') !== 'R');
}

/**
 * The points that may be drawn: every point, except the loaded race's
 * post-race rows until that race has been run at the clock on screen. The
 * store's embeddings at a race clock carry its rows at that clock instead
 * (as_of 'session_now'); post-race embeddings still on screen while those
 * load never show the race's final rows.
 * @param {Array<Object>} points
 * @param {{loaded: Object|null, resultHidden: boolean}} ctx
 */
export function causalPoints(points, { loaded, resultHidden } = {}) {
  const list = Array.isArray(points) ? points : [];
  if (!resultWithheld(loaded, resultHidden)) return list;
  return list.filter((p) => !isLoadedRace(p, loaded) || (p.as_of && p.as_of !== 'post-race'));
}

/**
 * Finishing position shown for a point, or null (not classified, a row as of
 * a lap, or the loaded race before it has been run at the clock on screen:
 * its own clock running, or another session of the weekend on screen).
 * @param {Object} point
 * @param {{loaded: Object|null, resultHidden: boolean}} ctx
 * @returns {number|null}
 */
export function shownFinish(point, { loaded, resultHidden } = {}) {
  if (resultWithheld(loaded, resultHidden) && isLoadedRace(point, loaded)) return null;
  if (point.as_of && point.as_of !== 'post-race') return null;
  const f = Number(point.finish_position);
  return point.finish_position != null && Number.isFinite(f) ? f : null;
}

/** Outcome class key of a finishing position (null -> 'pending'). */
export function outcomeClass(finish) {
  if (finish == null) return OUTCOME_PENDING.key;
  if (finish <= PODIUM_PLACES) return 'podium';
  if (finish <= POINTS_PLACES) return 'points';
  return 'none';
}

export const COLOR_BY = [
  { key: 'team', label: 'Team' },
  { key: 'finish', label: 'Finish' },
];

/**
 * Fill of a mark: its team colour (drawn through markColor: >= 3:1 on the
 * panel, V13), or the colour of its outcome class ('none' = outline only,
 * for a result not shown). Team mode encodes the team, not the driver: both
 * drivers of a team share the colour on purpose (the legend lists teams).
 */
export function pointFill(point, colorBy, ctx = {}) {
  if (colorBy !== 'finish') return markColor(getTeamColor(point.team), SURFACES.panel);
  const key = outcomeClass(shownFinish(point, ctx));
  return OUTCOME_CLASSES.find((c) => c.key === key)?.color || OUTCOME_PENDING.color;
}

// ── Legends ───────────────────────────────────────────────────────────

// Fill of the shape swatches (the shape legend says nothing about colour)
export const SHAPE_SWATCH_FILL = 'var(--color-text-secondary)';

/** One entry per team drawn, in name order, swatch = the circle mark. */
export function teamLegendItems(points) {
  const teams = [...new Set((points || []).map((p) => p.team || 'Unknown'))].sort((a, b) => a.localeCompare(b));
  return teams.map((team) => ({ label: team, color: markColor(getTeamColor(team), SURFACES.panel), ...markSwatch(false) }));
}

/** The outcome classes, plus the outline entry when a drawn point has no result shown. */
export function outcomeLegendItems(points, ctx = {}) {
  const items = OUTCOME_CLASSES.map((c) => ({ label: c.label, color: c.color, ...markSwatch(false) }));
  if ((points || []).some((p) => shownFinish(p, ctx) == null)) {
    items.push({
      label: OUTCOME_PENDING.label,
      color: 'none',
      stroke: 'var(--color-text-secondary)',
      strokeWidth: 1.5,
      title: 'Rows of the race on screen while its clock runs (computed as of a lap): its result is not known yet',
      ...markSwatch(false),
    });
  }
  return items;
}

/**
 * Shape legend: circle = other races (whole races), star = the loaded race
 * (with the marks' outline, class pca-point--current), its label saying what
 * the stars are taken at: 'at lap N' for rows at the replay clock, 'whole
 * race' for post-race rows. Empty when no drawn point is a row of the loaded
 * race.
 */
export function shapeLegendItems(points, loaded) {
  const rows = (points || []).filter((p) => isLoadedRace(p, loaded));
  if (!rows.length) return [];
  const atClock = rows.filter((p) => p.as_of && p.as_of !== 'post-race');
  const lap = atClock.length ? Math.max(...atClock.map((p) => Number(p.as_of_lap) || 0)) : null;
  return [
    {
      label: 'Other races (whole race)',
      color: SHAPE_SWATCH_FILL,
      title: 'Rows of the other cached races: features of the whole race',
      ...markSwatch(false),
    },
    {
      label: atClock.length
        ? `${loaded.year} R${loaded.round} at lap ${lap} (on screen)`
        : `${loaded.year} R${loaded.round} whole race (on screen)`,
      color: SHAPE_SWATCH_FILL,
      className: 'pca-point--current',
      title: atClock.length
        ? `Rows of the race on screen from the laps completed by lap ${lap} (the replay clock), projected on axes fitted without this race; their colour follows the colour legend`
        : 'Rows of the race on screen: features of the whole race (the race has ended); their colour follows the colour legend',
      ...markSwatch(true),
    },
  ];
}

// ── Tooltip ───────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const row = (label, value) =>
  `<div class="tooltip-row"><span class="tooltip-label">${esc(label)}</span><span class="tooltip-value">${esc(value)}</span></div>`;

/**
 * Tooltip HTML of a point: driver, race, team, grid and finishing position,
 * and the clock its features are taken at.
 */
export function tooltipHtml(point, ctx = {}) {
  const { loaded, resultHidden } = ctx;
  const grid = Number(point.grid_position);
  const finish = shownFinish(point, ctx);
  let finishText = finish != null ? `P${finish}` : 'not classified';
  if (resultWithheld(loaded, resultHidden) && isLoadedRace(point, loaded)) finishText = 'shown when the race ends';
  else if (point.as_of && point.as_of !== 'post-race') finishText = 'race still running';
  const asOf = point.as_of && point.as_of !== 'post-race'
    ? `lap ${point.as_of_lap ?? '?'}`
    : `end of race${point.as_of_lap != null ? ` (lap ${point.as_of_lap})` : ''}`;
  const note = isLoadedRace(point, loaded) && point.as_of && point.as_of !== 'post-race'
    ? `<div style="margin-top:4px;font-size:${CHART_FONT.label};color:${TEXT_COLORS.muted}">Replay clock: only the laps completed so far; the axes are fitted without this race</div>`
    : '';
  return (
    `<div class="tooltip-title" style="color:${textColor(getTeamColor(point.team), SURFACES.elevated)}">${esc(point.driver)} — ${esc(point.race_name || `R${point.round}`)}</div>`
    + row('Team', point.team || 'Unknown')
    + row('Race', `${point.year} R${point.round}`)
    + row('Grid', Number.isFinite(grid) && point.grid_position != null ? `P${grid}` : '—')
    + row('Finish', finishText)
    + row('Features as of', asOf)
    + note
    + `<div style="margin-top:4px;font-size:${CHART_FONT.label};color:${TEXT_COLORS.muted}">Click to select | Shift+drag to lasso</div>`
  );
}
