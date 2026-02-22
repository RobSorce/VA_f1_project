import React from 'react';

export default function Panel({ title, icon, controls, children, className = '', style }) {
  return (
    <div className={`panel ${className}`} style={style}>
      {title && (
        <div className="panel-header">
          <div className="panel-title">
            {icon && <span className="panel-icon">{icon}</span>}
            {title}
          </div>
          {controls && <div className="panel-controls">{controls}</div>}
        </div>
      )}
      <div className="panel-content">{children}</div>
    </div>
  );
}
