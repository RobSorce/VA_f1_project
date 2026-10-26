import React from 'react';
import { CHART_FONT, TEXT_COLORS, contrastText, withAlpha } from '../../utils/colors';

// Side of the square a 'symbol' swatch is drawn in (CSS px)
const SYMBOL_SWATCH_PX = 11;
// Size of a 'line' / 'dash' swatch (CSS px)
const LINE_SWATCH = { w: 18, h: 10 };
// Diameter of each dot of a 'pair' swatch (CSS px)
const PAIR_DOT_PX = 9;

/**
 * Reusable legend component: each swatch is drawn like the mark it explains.
 * @param {Array} items - [{ label, color, shape?, active?, onClick?, title?,
 *   path?, viewBox?, className?, stroke?, strokeWidth?, dash?, double?, glyph? }].
 *   shape 'line' draws a stroke (dashed with `dash`, an SVG stroke-dasharray:
 *   the teammate dash, a projection; two rails `double` px off the middle:
 *   the Lap Delta base line); 'circle' / 'square' a dot / cell;
 *   'band' a translucent area with its edge; 'glyph' the glyph or letter
 *   itself in the colour (◆ ● P, a compound letter); 'badge' a filled chip
 *   with the glyph in contrastText; 'pair' two dots, `color` and `color2`
 *   (a team: first driver and teammate tint, V3); 'symbol' draws `path` (an SVG path, e.g.
 *   the d3.symbol of the marks) in `viewBox`, filled with `color` (a CSS
 *   value: var() works) and outlined with `stroke` or by the CSS of
 *   `className`, so the swatch is the mark itself.
 * @param {'line'|'circle'|'square'|'band'|'glyph'|'badge'|'pair'|'symbol'} shape - default shape for items
 * @param {string} [title] - name of the encoding, shown before the items
 */
export default function Legend({ items = [], shape = 'line', title }) {
  return (
    <div className="chart-legend" style={{ fontSize: CHART_FONT.label }}>
      {title && (
        <span className="legend-title" style={{ alignSelf: 'center', fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, fontWeight: 600 }}>
          {title}
        </span>
      )}
      {items.map((item, i) => {
        const s = item.shape || shape;
        const dimmed = item.active === false;
        return (
          <div
            // a row may have no label (a compound badge whose letter says it)
            key={item.key || item.label || `${s}-${item.glyph || item.color}-${i}`}
            className={`legend-item${dimmed ? ' dimmed' : ''}`}
            onClick={item.onClick}
            title={item.title}
            data-shape={s}
            style={{ fontSize: CHART_FONT.label, ...(item.onClick ? { cursor: 'pointer' } : {}) }}
          >
            <Swatch item={item} shape={s} />
            <span className="legend-label" style={{ color: TEXT_COLORS.secondary }}>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Swatch({ item, shape }) {
  if (shape === 'symbol') {
    return (
      <svg
        className="legend-symbol"
        width={SYMBOL_SWATCH_PX}
        height={SYMBOL_SWATCH_PX}
        viewBox={item.viewBox}
        aria-hidden="true"
        // the size inline too: a legend inside a chart's .viz-container would
        // take that rule's width / height 100 % over the attributes
        style={{ flexShrink: 0, overflow: 'visible', width: SYMBOL_SWATCH_PX, height: SYMBOL_SWATCH_PX }}
      >
        <path
          d={item.path}
          className={item.className}
          style={{
            fill: item.color,
            ...(item.stroke ? { stroke: item.stroke, strokeWidth: item.strokeWidth || 1 } : {}),
          }}
        />
      </svg>
    );
  }
  if (shape === 'line') {
    // `double`: two rails that many px above and below the middle (the Lap
    // Delta base line), else one stroke
    const ys = item.double > 0
      ? [LINE_SWATCH.h / 2 - item.double, LINE_SWATCH.h / 2 + item.double]
      : [LINE_SWATCH.h / 2];
    return (
      <svg width={LINE_SWATCH.w} height={LINE_SWATCH.h} aria-hidden="true" className="legend-line"
        style={{ flexShrink: 0, width: LINE_SWATCH.w, height: LINE_SWATCH.h }}>
        {ys.map((yy) => (
          <line
            key={yy}
            x1={1} x2={LINE_SWATCH.w - 1} y1={yy} y2={yy}
            stroke={item.color} strokeWidth={item.strokeWidth || 2.5}
            strokeDasharray={item.dash || undefined} strokeLinecap="butt"
          />
        ))}
      </svg>
    );
  }
  if (shape === 'band') {
    return (
      <span
        className="legend-color legend-color--band"
        style={{
          width: 14, height: 9, borderRadius: 2, flexShrink: 0,
          background: item.fill || withAlpha(item.color, 0.25), border: `1px solid ${item.color}`,
        }}
      />
    );
  }
  if (shape === 'glyph') {
    return (
      <span className="legend-glyph" style={{ color: item.color, fontWeight: 800, minWidth: 10, textAlign: 'center', lineHeight: 1 }}>
        {item.glyph}
      </span>
    );
  }
  if (shape === 'pair') {
    return (
      <span className="legend-pair" style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
        {[item.color, item.color2 || item.color].map((c, i) => (
          <span key={i} style={{ width: PAIR_DOT_PX, height: PAIR_DOT_PX, borderRadius: '50%', background: c }} />
        ))}
      </span>
    );
  }
  if (shape === 'badge') {
    return (
      <span
        className="legend-badge"
        style={{
          background: item.color, color: contrastText(item.color), fontWeight: 800,
          minWidth: 14, padding: '0 3px', borderRadius: 3, textAlign: 'center', lineHeight: 1.3,
        }}
      >
        {item.glyph}
      </span>
    );
  }
  return (
    <span
      className={shape === 'circle' ? 'legend-color legend-color--circle' : shape === 'square' ? 'legend-color legend-color--square' : 'legend-color'}
      style={{ backgroundColor: item.color, ...(shape === 'square' ? { width: 9, height: 9, borderRadius: 2 } : {}) }}
    />
  );
}
