import React from 'react';

// Side of the square a 'symbol' swatch is drawn in (CSS px)
const SYMBOL_SWATCH_PX = 11;

/**
 * Reusable legend component.
 * @param {Array} items - [{ label, color, shape?, active?, onClick?, title?,
 *   path?, viewBox?, className?, stroke?, strokeWidth? }]. shape 'symbol'
 *   draws `path` (an SVG path, e.g. the d3.symbol of the marks) in `viewBox`,
 *   filled with `color` (a CSS value: var() works) and outlined with `stroke`
 *   or by the CSS of `className`, so the swatch is the mark itself.
 * @param {'line'|'circle'|'symbol'} shape - default shape for items
 * @param {string} [title] - name of the encoding, shown before the items
 */
export default function Legend({ items = [], shape = 'line', title }) {
  return (
    <div className="chart-legend">
      {title && (
        <span className="legend-title" style={{ alignSelf: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
          {title}
        </span>
      )}
      {items.map((item) => {
        const s = item.shape || shape;
        const dimmed = item.active === false;
        return (
          <div
            key={item.label}
            className={`legend-item${dimmed ? ' dimmed' : ''}`}
            onClick={item.onClick}
            title={item.title}
            style={item.onClick ? { cursor: 'pointer' } : {}}
          >
            {s === 'symbol' ? (
              <svg
                className="legend-symbol"
                width={SYMBOL_SWATCH_PX}
                height={SYMBOL_SWATCH_PX}
                viewBox={item.viewBox}
                aria-hidden="true"
                style={{ flexShrink: 0, overflow: 'visible' }}
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
            ) : (
              <span
                className={s === 'circle' ? 'legend-color legend-color--circle' : 'legend-color'}
                style={{ backgroundColor: item.color }}
              />
            )}
            <span className="legend-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
