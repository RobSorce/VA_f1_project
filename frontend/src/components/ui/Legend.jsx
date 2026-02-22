import React from 'react';

/**
 * Reusable legend component.
 * @param {Array} items - [{ label, color, shape?, active?, onClick? }]
 * @param {'line'|'circle'} shape - default shape for items
 */
export default function Legend({ items = [], shape = 'line' }) {
  return (
    <div className="chart-legend">
      {items.map((item) => {
        const s = item.shape || shape;
        const dimmed = item.active === false;
        return (
          <div
            key={item.label}
            className={`legend-item${dimmed ? ' dimmed' : ''}`}
            onClick={item.onClick}
            style={item.onClick ? { cursor: 'pointer' } : {}}
          >
            <span
              className={s === 'circle' ? 'legend-color legend-color--circle' : 'legend-color'}
              style={{ backgroundColor: item.color }}
            />
            <span className="legend-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
