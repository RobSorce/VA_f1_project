import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { listedBattles } from '../../utils/simulationClient';

/* Gemini logo — the official 4-pointed spark/star shape */
function GeminiLogo({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <path
        d="M14 0C14 7.732 7.732 14 0 14c7.732 0 14 6.268 14 14 0-7.732 6.268-14 14-14C20.268 14 14 7.732 14 0z"
        fill="white"
      />
    </svg>
  );
}

const fabStyle = {
  position: 'fixed',
  bottom: 76,
  right: 16,
  width: 44,
  height: 44,
  borderRadius: '50%',
  background: 'linear-gradient(135deg, #4285F4 0%, #886FBF 50%, #D96570 100%)',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 2px 16px rgba(66,133,244,0.35), 0 0 20px rgba(136,111,191,0.15)',
  zIndex: 9999,
  transition: 'transform 0.15s ease, box-shadow 0.15s ease',
};

const panelWrapperBase = {
  position: 'fixed',
  bottom: 128,
  right: 16,
  width: 320,
  height: 450,
  zIndex: 9999,
  transition: 'opacity 0.25s ease, transform 0.25s ease',
};

const panelStyle = {
  width: '100%',
  height: '100%',
  background: 'rgba(12,12,28,0.92)',
  backdropFilter: 'blur(30px) saturate(1.6)',
  WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const QUICK_QUERIES = [
  'When to pit?',
  'Undercut risk?',
  'Strategy options?',
  '1-stop vs 2-stop?',
];

export default function GeminiFloatingButton() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const geminiMessages = useF1Store((s) => s.geminiMessages);
  const sendGeminiQuery = useF1Store((s) => s.sendGeminiQuery);
  const raceProjection = useF1Store((s) => s.raceProjection);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);

  // Derive loading state from messages — last message is user means waiting for AI
  const loading = geminiMessages.length > 0 && geminiMessages[geminiMessages.length - 1].role === 'user';

  // Listen for keyboard shortcut (G key) toggle event
  useEffect(() => {
    const handler = () => setOpen((prev) => !prev);
    window.addEventListener('toggle-gemini-panel', handler);
    return () => window.removeEventListener('toggle-gemini-panel', handler);
  }, []);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [geminiMessages, loading]);

  const handleSend = useCallback((text) => {
    const q = (text || input).trim();
    if (!q || loading) return;
    setInput('');
    sendGeminiQuery(q);
  }, [input, loading, sendGeminiQuery]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Dynamic quick queries based on context
  const quickQueries = useMemo(() => {
    const queries = [...QUICK_QUERIES];
    const activeDriver = focusDriver || selectedDrivers[0];
    if (activeDriver) {
      queries[2] = `Best strategy for ${activeDriver}?`;
    }
    // the first battle the Race Prediction panel lists (store list: badge
    // level, then race order, so it changes only on evidence or new data)
    const [b] = listedBattles(raceProjection);
    if (b) queries.push(`${b.behind} vs ${b.ahead}?`);
    return queries;
  }, [focusDriver, selectedDrivers, raceProjection]);

  return (
    <>
      {/* Floating panel */}
      <div style={{
        ...panelWrapperBase,
        pointerEvents: open ? 'auto' : 'none',
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0) scale(1)' : 'translateY(12px) scale(0.95)',
      }}>
        <div style={panelStyle}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            <span style={{
              fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              fontSize: 12, fontWeight: 700, color: '#e0e0e0',
              letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>
              Gemini AI
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: 'none', border: 'none', color: '#7a7f9a',
                cursor: 'pointer', fontSize: 16, padding: '2px 6px', borderRadius: 4,
              }}
            >
              {'\u2715'}
            </button>
          </div>

          <div style={{
            flex: 1, overflowY: 'auto', padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {geminiMessages.length === 0 && !loading && (
              <div style={{
                color: '#7a7f9a', fontSize: 11, textAlign: 'center',
                marginTop: 20, lineHeight: 1.5,
                display: 'flex', flexDirection: 'column', gap: 12,
              }}>
                <span>Ask about race strategy, tyres, or driver battles.</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
                  {quickQueries.map((q) => (
                    <button
                      key={q}
                      onClick={() => handleSend(q)}
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 12, padding: '3px 8px',
                        fontSize: 9, color: '#aab', cursor: 'pointer',
                        transition: 'background 0.15s, color 0.15s',
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {geminiMessages.map((msg, i) => (
              <div key={i} style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                background: msg.role === 'user' ? 'rgba(66,133,244,0.18)' : 'rgba(255,255,255,0.05)',
                color: msg.role === 'user' ? '#e0e0e0' : '#bbc',
                borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                padding: '6px 10px', fontSize: 11, maxWidth: '85%',
                wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: 1.4,
              }}>
                {msg.content || msg.text}
              </div>
            ))}
            {loading && (
              <div style={{ color: '#7a7f9a', fontSize: 10, fontStyle: 'italic', padding: '4px 0' }}>
                Thinking...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div style={{
            display: 'flex', gap: 6, padding: '8px 12px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Gemini..."
              disabled={loading}
              style={{
                flex: 1, background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8, padding: '7px 10px', fontSize: 11,
                color: '#e0e0e0', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <button
              onClick={() => handleSend()}
              disabled={loading}
              style={{
                background: 'linear-gradient(135deg, #4285F4, #886FBF)',
                border: 'none', borderRadius: 8, padding: '7px 12px',
                fontSize: 10, fontWeight: 700, color: '#fff',
                cursor: loading ? 'default' : 'pointer',
                opacity: loading ? 0.4 : 1,
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Floating button */}
      <button
        style={fabStyle}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Open Gemini AI chat"
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.08)';
          e.currentTarget.style.boxShadow = '0 4px 24px rgba(66,133,244,0.45), 0 0 30px rgba(136,111,191,0.25)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.boxShadow = '0 2px 16px rgba(66,133,244,0.35), 0 0 20px rgba(136,111,191,0.15)';
        }}
      >
        <GeminiLogo />
      </button>
    </>
  );
}
