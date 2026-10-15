/**
 * View model of the championship chart (components/visualizations/ChampionshipChart.jsx):
 * the colour and dash of every line, and the legend of the chart's marks.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  getTeamColor, markColor, textColor, sessionTeammate, staticTeammateIndex, teammateTint, TEAMMATE_DASHES,
  TEXT_COLORS, UNKNOWN_TEAM_COLOR, CHART_SURFACE,
} from '../colors';

// Dash of the predicted-total segment: dotted, so it never reads as the
// teammate dash (TEAMMATE_DASHES[1] = '6,3')
export const PREDICTION_DASH = '1,4';

/**
 * Colour and dash of every entry (V3): the team colour for a constructor and
 * for the first driver of a team; the teammate tint and dash for his
 * teammate. A driver of the loaded session who drives for the same team in
 * the championship keeps exactly his session place (sessionTeammate), so he
 * is drawn as in the Track Map, the tower and the lap charts; the other
 * drivers of the team (a reserve, a driver of other rounds) take the places
 * left, by the static 2024 order, then championship position, so the drivers
 * of a team never share a style. (V3 r2: a reserve sorted ahead of the
 * session's second driver and took his style, e.g. BEA before HUL.)
 *
 * @param {Array<{abbr?: string, team?: string, teamColor?: string, position?: number}>} entries
 * @param {boolean} isDriverView
 * @returns {Object<string, {color: string, mark: string, text: string, dash: (string|null)}>}
 *   keyed by abbr (drivers) or team (constructors)
 */
export function championshipStyles(entries, isDriverView) {
  const out = {};
  const base = (e) => {
    const known = getTeamColor(e.team);
    return known !== UNKNOWN_TEAM_COLOR ? known : (e.teamColor || UNKNOWN_TEAM_COLOR);
  };
  const style = (color, dash) => ({ color, mark: markColor(color), text: textColor(color), dash });
  if (!isDriverView) {
    for (const e of entries || []) out[e.team] = style(base(e), null);
    return out;
  }
  const teams = new Map();
  for (const e of entries || []) {
    const key = String(e.team || e.teamColor || e.abbr).toLowerCase();
    if (!teams.has(key)) teams.set(key, []);
    teams.get(key).push(e);
  }
  for (const list of teams.values()) {
    const place = new Map();
    // the session's drivers of this team, in their session places
    for (const e of list) {
      const s = sessionTeammate(e.abbr);
      if (s && s.teamColor.toLowerCase() === base(e).toLowerCase() && ![...place.values()].includes(s.index)) {
        place.set(e.abbr, s.index);
      }
    }
    // everyone else: the free places, in the static order then by position
    const rest = list.filter((e) => !place.has(e.abbr)).sort((a, b) => (staticTeammateIndex(a.abbr) - staticTeammateIndex(b.abbr))
      || ((a.position ?? 99) - (b.position ?? 99)) || String(a.abbr).localeCompare(String(b.abbr)));
    let next = 0;
    for (const e of rest) {
      while ([...place.values()].includes(next)) next += 1;
      place.set(e.abbr, next);
      next += 1;
    }
    for (const e of list) {
      const i = place.get(e.abbr);
      const c = base(e);
      const color = i === 0 ? c : teammateTint(c, i);
      out[e.abbr] = style(color, TEAMMATE_DASHES[Math.min(i, TEAMMATE_DASHES.length - 1)] || null);
    }
  }
  return out;
}

/** The teammate dashes the styles use (a Set of TEAMMATE_DASHES values). */
export function usedDashes(styles) {
  return new Set(Object.values(styles || {}).map((s) => s?.dash).filter(Boolean));
}

/**
 * Legend rows of the chart (V4): what a line, a dot, the dotted segment and
 * the dashed boundary mean; lines are labelled at their end (direct labels).
 * The third-driver dash-dot has its row when a third driver is drawn.
 *
 * @param {{isDriverView: boolean, showPredictions: boolean, dashes?: Set<string>}} opts
 */
export function championshipLegend({ isDriverView, showPredictions, dashes = null }) {
  const items = [
    { label: isDriverView ? 'Points so far (team colour)' : 'Points so far', color: TEXT_COLORS.secondary, shape: 'line' },
    { label: 'Round', color: TEXT_COLORS.secondary, shape: 'circle' },
  ];
  if (isDriverView) items.push({ label: 'Teammate: tint, dashed', color: TEXT_COLORS.secondary, shape: 'line', dash: TEAMMATE_DASHES[1] });
  if (isDriverView && dashes?.has(TEAMMATE_DASHES[2])) {
    items.push({ label: 'Third driver: tint, dash-dot', color: TEXT_COLORS.secondary, shape: 'line', dash: TEAMMATE_DASHES[2] });
  }
  if (showPredictions) {
    items.push(
      { label: 'Predicted total (dotted)', color: TEXT_COLORS.secondary, shape: 'line', dash: PREDICTION_DASH },
      { label: 'Last round run', color: TEXT_COLORS.muted, shape: 'line', dash: '4,3', strokeWidth: 1 },
    );
  }
  return items;
}

/**
 * Legend rows of the standings bars (ChampionshipStandings, V4 r2): one row
 * per team, its swatch the bar colour as drawn (markColor on `surface`; the
 * driver view shows the first driver and the teammate tint side by side), and
 * the teammate patterns drawn inside a teammate's bar (dashed, dash-dot).
 *
 * @param {Array<{abbr?: string, team?: string}>} entries
 * @param {Object<string, {color: string, dash: (string|null)}>} styles - championshipStyles
 * @param {boolean} isDriverView
 * @param {string} [surface]
 */
export function championshipStandingsLegend(entries, styles, isDriverView, surface = CHART_SURFACE) {
  const teams = new Map();
  for (const e of entries || []) {
    const st = styles?.[isDriverView ? e.abbr : e.team];
    if (!st) continue;
    const team = e.team || '?';
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(st);
  }
  const items = [];
  for (const [team, list] of teams) {
    const first = list.find((st) => !st.dash) || list[0];
    const second = isDriverView ? list.find((st) => st.dash === TEAMMATE_DASHES[1]) : null;
    items.push(second
      ? {
        label: team, color: markColor(first.color, surface), color2: markColor(second.color, surface), shape: 'pair',
        title: `${team}: first driver in the team colour, teammate in its tint (dashed inside the bar)`,
      }
      : { label: team, color: markColor(first.color, surface), shape: 'square', title: `${team}: team colour` });
  }
  if (isDriverView) {
    const dashes = usedDashes(styles);
    if (dashes.has(TEAMMATE_DASHES[1])) items.push({ label: 'Teammate (dashed in the bar)', color: TEXT_COLORS.secondary, shape: 'line', dash: TEAMMATE_DASHES[1] });
    if (dashes.has(TEAMMATE_DASHES[2])) items.push({ label: 'Third driver (dash-dot)', color: TEXT_COLORS.secondary, shape: 'line', dash: TEAMMATE_DASHES[2] });
  }
  return items;
}
