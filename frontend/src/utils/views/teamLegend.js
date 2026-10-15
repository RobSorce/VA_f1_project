/**
 * Legend rows of the views that colour a driver by his team (V3 / V4): one
 * row per team, its swatch the two colours its drivers are drawn in (the team
 * colour for the first driver, the teammate tint for the second; the teammate
 * rule of utils/colors.js), each as a mark (>= 3:1 on the surface).
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  getTeamColor, markColor, teammateTint, UNKNOWN_TEAM_COLOR, CHART_SURFACE,
} from '../colors';

/**
 * @param {Array<{TeamName?: string, teamName?: string}>} driverInfo - the
 *   session's driver_info (or any list with a team name per driver)
 * @param {string} [surface=CHART_SURFACE] - surface the marks are drawn on
 * @returns {Array<{label: string, color: string, color2: string, shape: 'pair', title: string}>}
 */
export function teamPairLegend(driverInfo, surface = CHART_SURFACE) {
  const seen = new Set();
  const items = [];
  for (const d of driverInfo || []) {
    const team = d?.TeamName || d?.teamName;
    if (!team || seen.has(team)) continue;
    seen.add(team);
    const base = getTeamColor(team);
    if (base === UNKNOWN_TEAM_COLOR) continue;
    items.push({
      label: team,
      color: markColor(base, surface),
      color2: markColor(teammateTint(base), surface),
      shape: 'pair',
      title: `${team}: first driver in the team colour, teammate in its tint (dashed where drawn as a line)`,
    });
  }
  return items;
}
