import React, { useState, useRef, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import Panel from '../ui/Panel';

export default function GeminiAssistant() {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const geminiMessages = useF1Store((s) => s.geminiMessages);
  const geminiOverlays = useF1Store((s) => s.geminiOverlays);
  const sendGeminiQuery = useF1Store((s) => s.sendGeminiQuery);
  const setGeminiOverlays = useF1Store((s) => s.setGeminiOverlays);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [geminiMessages]);

  const handleSend = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    sendGeminiQuery(q);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickQueries = [
    'What is the optimal strategy for the leader?',
    'Should we undercut or overcut?',
    'Compare 1-stop vs 2-stop strategies',
    'When is the best pit window?',
  ];

  return (
    <Panel title="Gemini AI Strategy Assistant">
      <div className="chat-container">
        <div className="chat-messages">
          {geminiMessages.length === 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: 'var(--spacing-md)', padding: 'var(--spacing-xl) 0',
              color: 'var(--color-text-muted)', textAlign: 'center',
            }}>
              <span style={{ fontSize: 32 }}>🏎️</span>
              <span style={{ fontSize: 'var(--font-size-sm)' }}>
                Ask Gemini about race strategy.<br />
                Responses include scenario overlays on the Strategy Timeline.
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-xs)', justifyContent: 'center' }}>
                {quickQueries.map((q) => (
                  <button
                    key={q}
                    className="scenario-btn"
                    onClick={() => { setInput(q); }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {geminiMessages.map((msg, i) => (
            <div key={i} className={`chat-message chat-message--${msg.role}`}>
              {msg.role === 'ai' && (
                <div className="message-label">Gemini</div>
              )}
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>

              {msg.scenarios?.length > 0 && (
                <div style={{ marginTop: 'var(--spacing-sm)', display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-xs)' }}>
                  {msg.scenarios.map((scenario, j) => (
                    <button
                      key={j}
                      className={`scenario-btn${geminiOverlays.some((o) => o.id === scenario.id) ? ' active' : ''}`}
                      onClick={() => {
                        const active = geminiOverlays.some((o) => o.id === scenario.id);
                        if (active) {
                          setGeminiOverlays(geminiOverlays.filter((o) => o.id !== scenario.id));
                        } else {
                          setGeminiOverlays([...geminiOverlays, scenario]);
                        }
                      }}
                    >
                      {scenario.label || `Scenario ${j + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <input
            type="text"
            className="chat-input"
            placeholder="Ask about race strategy..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="btn btn-primary btn-sm" onClick={handleSend}>
            Send
          </button>
        </div>
      </div>
    </Panel>
  );
}
