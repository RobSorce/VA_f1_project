/**
 * Gap list of the Circle of Doom (CircleOfDoom.jsx): the gaps between the
 * cars the user follows, shown without hovering. The rows are those of
 * utils/circleGapList.js gapRows (reference car, race order, gaps, trend,
 * stop status); utils/views/circleGapRows.js prints them (codes, gaps, the
 * trend glyph, PIT / OUT, the fit rule, the titles); this file only draws
 * them.
 *
 * Two modes. 'side': a column under the side legend, one GAP_ROW_PX row per
 * car under the header 'to LEC · to row above'. 'grid': the box of the legend
 * under the plot, GRID_COLS columns of the legend's rows, the header on its
 * first row ('to LEC · to previous cell'), the cells in race order, row by
 * row. The driver code is drawn in its ring label's colour (the primary text
 * in the light theme, as the Timing Tower's names), the numbers at the data
 * type (>= 11 px) with tabular figures. With a selection the header
 * carries a × that clears it; with no focus and no selection the list is one
 * hint line. The cars beyond the room are one '+n more' row whose title names
 * them. Hovering a row highlights the car in every view (setHighlightedDriver).
 */
import React from 'react';
import {
  getDriverColor, textColor, SURFACES, chartFontPx,
} from '../../utils/colors';
import {
  rowParts, fitParts, rowTitle, gridCellWidth, GRID_COLS,
} from '../../utils/views/circleGapRows';

const HINT = 'Shift-click cars to compare';

/**
 * @param {Object} props
 * @param {'side'|'grid'} props.mode
 * @param {{reference: string|null, rows: Array<Object>, overflow: Array<Object>}} props.list - gapRows result
 * @param {string|null} props.focus - focus driver
 * @param {boolean} props.hasSelection - a selection exists (the × clears it)
 * @param {number} props.now - session seconds (the lane seconds)
 * @param {number} props.width - px: the column (side) or the slot (grid)
 * @param {number} props.rows - rows of the box: side, the lines that fit; grid, the legend's
 * @param {number} [props.height] - px of the grid: the legend's box it takes the place of
 * @param {function} [props.measure] - text width in px (text, size, weight)
 * @param {function(string|null)} props.onHover - setHighlightedDriver
 * @param {function()} props.onClear - clears the selection
 */
export default function CircleGapList({
  mode, list, focus, hasSelection, now, width, rows, height = null, measure = null, onHover, onClear,
}) {
  const grid = mode === 'grid';
  const style = grid
    ? { width, height: height ?? undefined, gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }
    : { width };
  if (!list.rows.length && !list.overflow.length) {
    return (
      <div className={`cod-gaps cod-gaps--${mode}`} style={style} data-rows={rows}>
        <div className="cod-gaps__hint">{HINT}</div>
      </div>
    );
  }
  const { reference } = list;
  const px = chartFontPx('data');
  const room = grid ? gridCellWidth(width) : width;
  return (
    <div className={`cod-gaps cod-gaps--${mode}`} style={style} data-rows={rows} data-reference={reference}>
      <div className="cod-gaps__head">
        <span className="cod-gaps__head-text">{`to ${reference} · ${grid ? 'to previous cell' : 'to row above'}`}</span>
        {hasSelection && (
          <button type="button" className="cod-gaps__clear" aria-label="Clear comparison" title="Clear comparison" onClick={onClear}>
            ×
          </button>
        )}
      </div>
      {list.rows.map((row, i) => {
        const parts = fitParts(rowParts(row, reference, now), room, measure, px);
        return (
          <div
            key={row.driver}
            className={`cod-gaps__row${row.driver === reference ? ' cod-gaps__row--ref' : ''}`}
            data-driver={row.driver}
            title={rowTitle(row, {
              reference, focus, prev: i > 0 ? list.rows[i - 1].driver : null, now,
            })}
            onMouseEnter={() => onHover(row.driver)}
            onMouseLeave={() => onHover(null)}
          >
            <span className="cod-gaps__code" style={{ '--cod-gaps-code': textColor(getDriverColor(row.driver), SURFACES.panel) }}>{parts.code}</span>
            <span className={`cod-gaps__ref${row.status ? ' cod-gaps__ref--stop' : ''}`}>{parts.ref}</span>
            {parts.prev && <span className="cod-gaps__prev">{parts.prev}</span>}
            {parts.glyph && <span className="cod-gaps__trend" data-trend={row.trend}>{parts.glyph}</span>}
          </div>
        );
      })}
      {list.overflow.length > 0 && (
        <div
          className="cod-gaps__more"
          title={`Also followed: ${list.overflow.map((o) => `${o.position != null ? `P${o.position} ` : ''}${o.driver}`).join(', ')}`}
        >
          {`+${list.overflow.length} more`}
        </div>
      )}
    </div>
  );
}
