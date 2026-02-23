import React from 'react';

export default function Panel({ title, icon, controls, children, className = '', style, focused = false, shortcutKey }) {
  return (
    <div className={`panel ${className}${focused ? ' panel--focused' : ''}`} style={style}>
      {title && (
        <div className="panel-header">
          <div className="panel-title">
            {icon && <span className="panel-icon">{icon}</span>}
            {title}
            {shortcutKey && (
              <kbd className="panel-shortcut-hint" title={`Press ${shortcutKey} to focus`}>{shortcutKey}</kbd>
            )}
          </div>
          {controls && <div className="panel-controls">{controls}</div>}
        </div>
      )}
      <div className="panel-content">{children}</div>
    </div>
  );
}
