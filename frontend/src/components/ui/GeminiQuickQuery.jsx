import React, { useState, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { queryGemini } from '../../utils/apiClient';

const QUICK_QUERIES = ['Pit window?', 'Strategy?', 'Tyre deg?'];

const panelStyle = {
  padding: '10px 12px',
  background: 'rgba(12,12,28,0.75)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

const titleStyle = {
  fontFamily: "'Formula1', 'Titillium Web', sans-serif",
  fontSize: 10, fontWeight: 700, color: '#7a7f9a',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 8,
};

export default function GeminiQuickQuery() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);

  const [input, setInput] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sendQuery = useCallback(async (text) => {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    setResponse('');
    try {
      const result = await queryGemini({
        query: text.trim(),
        year: sessionData?.year,
        round: sessionData?.round,
        driver: focusDriver || selectedDrivers[0] || null,
        current_lap: currentLap,
      });
      setResponse(result?.response || result?.answer || JSON.stringify(result));
    } catch (err) {
      setError(err?.message || 'Failed to get response');
    } finally {
      setLoading(false);
    }
  }, [sessionData, currentLap, focusDriver, selectedDrivers]);

  const handleSubmit = (e) => {
    e.preventDefault();
    sendQuery(input);
  };

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>AI Strategist</div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about strategy..."
          disabled={loading}
          style={{
            flex: 1, background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: '6px 8px', fontSize: 10,
            color: '#e0e0e0', outline: 'none',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        />
        <button type="submit" disabled={loading} style={{
          background: '#e10600', border: 'none', borderRadius: 6,
          padding: '6px 10px', fontSize: 9, fontWeight: 700,
          color: '#fff', cursor: loading ? 'default' : 'pointer',
          opacity: loading ? 0.4 : 1,
        }}>
          {loading ? '...' : 'Ask'}
        </button>
      </form>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {QUICK_QUERIES.map((q) => (
          <button
            key={q}
            onClick={() => { setInput(q); sendQuery(q); }}
            disabled={loading}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12, padding: '3px 10px',
              fontSize: 9, color: '#aab', cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {q}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: '#7a7f9a', fontSize: 10, fontStyle: 'italic', marginTop: 6 }}>Thinking...</div>}
      {error && <div style={{ color: '#FF4444', fontSize: 10, marginTop: 6 }}>{error}</div>}
      {response && !loading && (
        <div style={{
          marginTop: 8, padding: '8px 10px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 6, fontSize: 10, color: '#bbc',
          lineHeight: 1.5, whiteSpace: 'pre-wrap',
          maxHeight: 120, overflow: 'hidden',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {response}
        </div>
      )}
    </div>
  );
}
