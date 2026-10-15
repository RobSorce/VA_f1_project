/**
 * Shaded delta areas (behind / ahead of a reference driver) of the Lap Delta
 * chart and of the telemetry GAP chart: a light tint of the diverging pair
 * crossed by hatch lines at full strength, '/' for behind (worse, orange) and
 * '\' for ahead (better, blue).
 *
 * The tint alone reads 1.45:1 on the raised surface, and 3:1 would need an
 * alpha of 0.56-0.62 (notes/experiments/phase9/repair2_area_alpha.txt), a
 * fill that would sit under the team-coloured lines (McLaren orange, Williams
 * blue) and cut their contrast. The hatch lines are the diverging colours
 * themselves (>= 3:1 as marks, cvd_check.txt), and their direction is a second
 * cue besides the hue (V1).
 *
 * Pure module: no React, no store; the D3 selection is passed in.
 */
import { DIVERGING, withAlpha } from '../colors';

export const DELTA_HATCH = Object.freeze({ tint: 0.14, spacing: 6, width: 1.5 });

/**
 * Append the two hatch patterns to `defs` (a D3 selection of an SVG's <defs>).
 * The lines are <line> elements, so a `path` selector of the chart (clip
 * paths, transitions) never reaches them.
 *
 * @param {Object} defs - D3 selection of <defs>
 * @param {string} id - id prefix, unique in the document
 * @returns {{worse: string, better: string}} fill values, url(#...)
 */
export function defineDeltaHatches(defs, id) {
  const S = DELTA_HATCH.spacing;
  const make = (key, color, rising) => {
    const pid = `${id}-${key}`;
    defs.select(`#${pid}`).remove();
    const p = defs.append('pattern')
      .attr('id', pid)
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('width', S).attr('height', S);
    p.append('rect').attr('width', S).attr('height', S).attr('fill', withAlpha(color, DELTA_HATCH.tint));
    // one diagonal through the tile plus the two corner pieces, so the lines
    // join from tile to tile
    const segs = rising
      ? [[0, S, S, 0], [-1, 1, 1, -1], [S - 1, S + 1, S + 1, S - 1]]
      : [[0, 0, S, S], [-1, S - 1, 1, S + 1], [S - 1, -1, S + 1, 1]];
    for (const [x1, y1, x2, y2] of segs) {
      p.append('line')
        .attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
        .attr('stroke', color).attr('stroke-width', DELTA_HATCH.width);
    }
    return `url(#${pid})`;
  };
  return {
    worse: make('worse', DIVERGING.worse, true),
    better: make('better', DIVERGING.better, false),
  };
}

/**
 * The same hatch as a CSS background, for the legend swatch (Legend 'band'
 * with `fill`): the swatch is the mark itself.
 *
 * @param {'worse'|'better'} kind
 * @returns {string}
 */
export function deltaHatchCss(kind) {
  const color = kind === 'better' ? DIVERGING.better : DIVERGING.worse;
  const tint = withAlpha(color, DELTA_HATCH.tint);
  const angle = kind === 'better' ? 45 : -45;
  return `repeating-linear-gradient(${angle}deg, ${color} 0 ${DELTA_HATCH.width}px, ${tint} ${DELTA_HATCH.width}px ${DELTA_HATCH.spacing / Math.SQRT2}px)`;
}
