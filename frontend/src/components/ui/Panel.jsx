import React, { useRef, useCallback } from 'react';
import { exportAsPng } from '../../utils/exportChart';
import { TEXT_COLORS } from '../../utils/colors';

export default function Panel({ title, icon, controls, children, className = '', style, focused = false, shortcutKey }) {
  const panelRef = useRef(null);

  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    const filename = `${(title || 'chart').replace(/\s+/g, '_').toLowerCase()}.png`;
    exportAsPng(panelRef.current, filename);
  }, [title]);

  return (
    <div ref={panelRef} className={`panel ${className}${focused ? ' panel--focused' : ''}`} style={style}>
      {title && (
        <div className="panel-header">
          <div className="panel-title">
            {icon && <span className="panel-icon">{icon}</span>}
            {title}
            {shortcutKey && (
              <kbd className="panel-shortcut-hint" title={`Press ${shortcutKey} to focus`}>{shortcutKey}</kbd>
            )}
          </div>
          <div className="panel-controls" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {controls}
            <button
              onClick={handleExport}
              title="Export as PNG"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 4,
                border: 'none', background: 'transparent',
                // muted text colour: the glyph is a control, >= 3:1 (V13)
                color: TEXT_COLORS.muted, cursor: 'pointer',
                fontSize: '12px', padding: 0, flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        </div>
      )}
      <div className="panel-content">{children}</div>
    </div>
  );
}
