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
 * of a team never share a style. (Formerly a reserve sorted ahead of the
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

/**
 * The teams of a driver over the season, oldest first (D11: a driver who
 * changed team mid-season). The championship colours a driver by `team`,
 * his team at the latest round he scored a result in (the backend keeps the
 * last one); the session views colour him by his team in the session on
 * screen. What is known of the earlier teams:
 *  - a progression row that carries its own `team` (exact rounds);
 *  - else the session on screen, when it is of the same season: the
 *    driver's team at that round (its driver_info).
 *
 * @param {{team?: string, progression?: Array<{round: number, team?: string}>,
 *   seasonProgression?: Array<{round: number, team?: string}>}} entry
 * @param {{round?: number, team?: string}|null} [session] - the round of the
 *   session on screen and the driver's team in it (same season only)
 * @returns {Array<{team: string, from: number, to: number, exact: boolean, session?: boolean}>}
 *   spells of one team, rounds `from`..`to` as known; `exact`: the rounds
 *   come from the progression rows; `session`: the spell is the session's
 */
export function driverTeamSpells(entry, session = null) {
  // the whole season (seasonProgression: the rows before a view cut them at
  // the round on screen), so `team` is matched with its own last round
  const rows = (entry?.seasonProgression || entry?.progression || [])
    .filter((p) => Number.isFinite(p?.round)).sort((a, b) => a.round - b.round);
  const latest = entry?.team || '';
  const lastRound = rows.length ? rows[rows.length - 1].round : null;
  const spells = [];
  if (rows.some((p) => p.team)) {
    for (const p of rows) {
      const team = p.team || spells[spells.length - 1]?.team || latest;
      const cur = spells[spells.length - 1];
      if (cur && cur.team === team) cur.to = p.round;
      else spells.push({ team, from: p.round, to: p.round, exact: true });
    }
    return spells;
  }
  if (latest) spells.push({ team: latest, from: lastRound, to: lastRound, exact: false });
  const sTeam = session?.team;
  const sRound = Number(session?.round);
  if (sTeam && latest && Number.isFinite(sRound) && lastRound != null && sRound !== lastRound
    && !sameTeam(sTeam, latest)) {
    spells.push({ team: sTeam, from: sRound, to: sRound, exact: false, session: true });
    spells.sort((a, b) => a.from - b.from);
  }
  return spells;
}

// One team under two names (a rename such as 'RB' / 'Visa Cash App RB'
// shares the palette colour) is not a team change
function sameTeam(a, b) {
  if (String(a).toLowerCase() === String(b).toLowerCase()) return true;
  const ca = getTeamColor(a);
  return ca !== UNKNOWN_TEAM_COLOR && ca === getTeamColor(b);
}

/**
 * Tooltip line of a driver who changed team (D11), e.g.
 * "Red Bull Racing → Racing Bulls from R3" (rounds known), or
 * "Red Bull Racing (R1, session on screen) → Racing Bulls (R24)" (only the
 * session's round known); null when one team is known.
 *
 * @param {Object} entry - championship driver entry
 * @param {{round?: number, team?: string}|null} [session]
 * @returns {string|null}
 */
export function teamChangeNote(entry, session = null) {
  const spells = driverTeamSpells(entry, session);
  if (spells.length < 2) return null;
  if (spells.every((s) => s.exact)) {
    return spells.map((s, i) => (i === 0 ? s.team : `${s.team} from R${s.from}`)).join(' → ');
  }
  return spells.map((s) => `${s.team} (R${s.to}${s.session ? ', session on screen' : ''})`).join(' → ');
}

/**
 * Tooltip of a standings bar / championship line: the entry, its points and,
 * for a driver who changed team, the earlier team and why the colour is the
 * latest team's (D11).
 *
 * @param {{abbr?: string, name?: string, team?: string, position?: number, totalPoints?: number}} entry
 * @param {boolean} isDriverView
 * @param {{round?: number, team?: string}|null} [session]
 * @returns {string}
 */
export function championshipTooltip(entry, isDriverView, session = null) {
  const who = isDriverView ? (entry?.name ? `${entry.name} (${entry.abbr})` : entry?.abbr) : entry?.team;
  const lines = [`${entry?.position ?? '?'}. ${who}: ${entry?.totalPoints ?? 0} pts`];
  if (isDriverView && entry?.team) lines.push(`Team: ${entry.team}`);
  const change = isDriverView ? teamChangeNote(entry, session) : null;
  if (change) lines.push(`${change}: drawn in the colour of ${entry.team}, his team at the latest round`);
  return lines.join('\n');
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
 * Legend rows of the standings bars (ChampionshipStandings): one row
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
