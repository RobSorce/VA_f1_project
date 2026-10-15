/**
 * Focus + context of the Strategy Timeline's stint bars
 * (components/visualizations/StrategyTimeline.jsx, D7 / F8, Phase 9c).
 *
 * A stint bar is drawn in its compound colour; when it is context (its driver
 * not selected while others are, another driver hovered, another compound
 * hovered in the legend) the colour is mixed toward the panel (contextColor:
 * >= 2:1 on the panel), never faded by opacity, and the label inside it is
 * black or white by contrast with the fill drawn (>= 3:1 on it). Before, an
 * unselected bar was drawn at opacity 0.2 (0.15 hovered away, 0.12 at the
 * floor) with its label still in the contrast colour of the full compound
 * colour: black on a faded bar read 1.27-2.03:1.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component.
 *
 * Pure module: no React, no D3, no store access.
 */
import { tyreColor, contextColor, contrastText, SURFACES } from '../colors';

/** The surface the timeline is drawn on (the panel). */
export const STINT_SURFACE = SURFACES.panel;
/** How far toward the panel a context bar is mixed (floors permitting). */
export const STINT_CONTEXT_MIX = { context: 0.5, deep: 0.85 };

/**
 * Emphasis of one stint bar: 'full' (its compound colour), 'context' or
 * 'deep' (another compound hovered in the legend).
 *
 * @param {{selected: boolean, highlighted?: boolean, hoverActive?: boolean, compoundDimmed?: boolean}} s
 *   selected: no selection or the driver selected; highlighted: the driver
 *   hovered; hoverActive: a driver is hovered; compoundDimmed: another
 *   compound is hovered in the legend
 * @returns {'full'|'context'|'deep'}
 */
export function stintLevel({ selected, highlighted = false, hoverActive = false, compoundDimmed = false }) {
  if (compoundDimmed) return 'deep';
  if (highlighted) return 'full';
  if (hoverActive || !selected) return 'context';
  return 'full';
}

/** Fill of a stint bar at an emphasis level (always opaque). */
export function stintFill(compound, level = 'full', surface = STINT_SURFACE) {
  const c = tyreColor(compound);
  if (level === 'full') return c;
  return contextColor(c, surface, { mix: STINT_CONTEXT_MIX[level] ?? STINT_CONTEXT_MIX.context });
}

/** Colour of the label inside a stint bar: black or white by contrast with the fill drawn. */
export function stintLabelFill(compound, level = 'full', surface = STINT_SURFACE) {
  return contrastText(stintFill(compound, level, surface));
}
