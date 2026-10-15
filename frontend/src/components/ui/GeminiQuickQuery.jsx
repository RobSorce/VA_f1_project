import React, { useState, useCallback, useRef } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  CHART_FONT, TEXT_COLORS, FLAG_COLORS, UI_COLORS,
} from '../../utils/colors';
import { useBoxSize } from '../../utils/views/chartBox';

const QUICK_QUERIES = ['Pit window?', 'Strategy?', 'Tyre deg?'];

const panelStyle = {
  flex: 'none',
  padding: '8px 12px',
  background: 'rgba(12,12,28,0.75)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

const titleStyle = {
  fontFamily: "'Formula1', 'Titillium Web', sans-serif",
  fontSize: CHART_FONT.label, fontWeight: 700, color: TEXT_COLORS.muted,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 6,
};

// The answer: a card over the side column above the Ask box (the side column
// is position: relative, PitWallLayout.jsx), so an answer never pushes the
// Ask box out of its 263 px column; it closes with x, and a long answer
// scrolls inside the card (docs/SCROLL_JUSTIFICATIONS.md, quick answer)
const answerStyle = {
  position: 'absolute', top: 0, left: 0, right: 0,
  display: 'flex', flexDirection: 'column',
  background: 'rgba(16,16,32,0.97)',
  borderBottom: `1px solid ${UI_COLORS.controlBorder}`,
  zIndex: 2,
};
const answerHeadStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '6px 8px 4px 12px', flex: 'none',
  fontSize: CHART_FONT.label, fontWeight: 700, color: TEXT_COLORS.muted,
  textTransform: 'uppercase', letterSpacing: '0.08em',
};
const answerTextStyle = {
  flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
  padding: '0 12px 8px',
  fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary,
  lineHeight: 1.5, whiteSpace: 'pre-wrap',
  fontFamily: "'JetBrains Mono', monospace",
};

export default function GeminiQuickQuery() {
  const [input, setInput] = useState('');
  // The answer lives in the store (askGeminiQuick): it belongs to the session
  // on screen, so a late answer of another session or of a later clock never
  // lands here, and a session switch clears it
  const { response, loading, error } = useF1Store((s) => s.geminiQuick);
  const askGeminiQuick = useF1Store((s) => s.askGeminiQuick);
  // The answer the user closed (a new answer opens the card again)
  const [closed, setClosed] = useState(null);
  const panelRef = useRef(null);
  const box = useBoxSize(panelRef);

  const sendQuery = useCallback((text) => askGeminiQuick(text), [askGeminiQuick]);

  const handleSubmit = (e) => {
    e.preventDefault();
    sendQuery(input);
  };

  const showAnswer = !!response && !loading && closed !== response;

  return (
    <>
      <div ref={panelRef} style={panelStyle} className="pitwall-quick">
        <div style={titleStyle}>AI Strategist</div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <input
            type="text"
            className="pitwall-quick__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about strategy..."
            aria-label="Ask the AI Strategist"
            disabled={loading}
            style={{ fontSize: CHART_FONT.label }}
          />
          <button type="submit" disabled={loading} style={{
            background: UI_COLORS.accent, border: 'none', borderRadius: 6,
            padding: '5px 10px', fontSize: CHART_FONT.label, fontWeight: 700,
            color: TEXT_COLORS.primary, cursor: loading ? 'default' : 'pointer',
          }}>
            {loading ? '...' : 'Ask'}
          </button>
        </form>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {QUICK_QUERIES.map((q) => (
            <button
              key={q}
              className="pitwall-quick__chip"
              onClick={() => { setInput(q); sendQuery(q); }}
              disabled={loading}
              style={{ fontSize: CHART_FONT.label }}
            >
              {q}
            </button>
          ))}
        </div>

        {loading && <div style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.label, fontStyle: 'italic', marginTop: 4 }}>Thinking...</div>}
        {error && <div style={{ color: FLAG_COLORS.red, fontSize: CHART_FONT.label, marginTop: 4 }}>{error}</div>}
      </div>
      {showAnswer && (
        <div style={{ ...answerStyle, bottom: box.height || 0 }} className="pitwall-quick__answer" role="region" aria-label="AI Strategist answer">
          <div style={answerHeadStyle}>
            <span>Answer</span>
            <button
              type="button"
              className="pitwall-quick__close"
              onClick={() => setClosed(response)}
              aria-label="Close the answer"
              title="Close the answer"
            >
              ×
            </button>
          </div>
          <div style={answerTextStyle}>{response}</div>
        </div>
      )}
    </>
  );
}
