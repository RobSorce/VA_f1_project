import React, { Suspense, Component } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { SLOT_OPTIONS } from '../../utils/slotOptions';
import { CHART_FONT, TEXT_COLORS } from '../../utils/colors';

class SlotErrorBoundary extends Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(err, info) { console.error('Slot error:', err, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={errorStyle}>
          <span style={{ fontSize: 16, marginBottom: 4 }}>⚠</span>
          <span>Visualization error</span>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={retryBtnStyle}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const slotStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
  background: 'rgba(10, 10, 24, 0.6)',
  border: '1px solid rgba(255,255,255,0.04)',
  borderRadius: 6,
};

const titleBarStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 8px',
  background: 'rgba(18, 18, 40, 0.8)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  flexShrink: 0,
  minHeight: 28,
};

const selectStyle = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 4,
  color: TEXT_COLORS.secondary,
  fontSize: CHART_FONT.label,
  fontWeight: 600,
  letterSpacing: '0.04em',
  padding: '2px 6px',
  cursor: 'pointer',
  outline: 'none',
  fontFamily: "'JetBrains Mono', monospace",
};

const contentStyle = {
  flex: 1,
  overflow: 'hidden',
  minHeight: 0,
  position: 'relative',
};

const spinnerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: TEXT_COLORS.muted,
  fontSize: CHART_FONT.data,
};

const errorStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: TEXT_COLORS.muted,
  fontSize: CHART_FONT.data,
  gap: 6,
};

const retryBtnStyle = {
  marginTop: 4,
  padding: '3px 10px',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)',
  color: TEXT_COLORS.secondary,
  fontSize: CHART_FONT.label,
  cursor: 'pointer',
};

export default function AnalysisSlot({ slotKey, vizId }) {
  const setSlotContent = useF1Store((s) => s.setSlotContent);
  const match = SLOT_OPTIONS.find((o) => o.id === vizId);
  const Component = match?.component;

  return (
    <div style={slotStyle}>
      <div style={titleBarStyle}>
        <span style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {slotKey.replace('slot', 'Slot ')}
        </span>
        <select
          value={vizId}
          onChange={(e) => setSlotContent(slotKey, e.target.value)}
          style={selectStyle}
        >
          {SLOT_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div style={contentStyle}>
        <SlotErrorBoundary key={vizId}>
          <Suspense fallback={<div style={spinnerStyle}>Loading...</div>}>
            {Component ? <Component /> : <div style={spinnerStyle}>Select a visualization</div>}
          </Suspense>
        </SlotErrorBoundary>
      </div>
    </div>
  );
}
