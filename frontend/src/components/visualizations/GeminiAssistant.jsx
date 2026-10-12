import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import Panel from '../ui/Panel';
import { focusDriverStatus } from '../ui/FocusDriverWidget';

const COMPOUND_ORDER = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

function fmtTime(s) {
  if (!s || s <= 0) return '--:--.---';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

function StintBar({ stint, maxLap }) {
  const color = TYRE_COLORS[stint.compound] || '#888';
  const isDark = stint.compound === 'HARD' || stint.compound === 'MEDIUM';
  const left = ((stint.lap_start - 1) / maxLap) * 100;
  const width = (stint.length / maxLap) * 100;
  return (
    <div
      style={{
        position: 'absolute', left: `${left}%`, width: `${Math.max(width, 2)}%`,
        height: '100%', background: color, borderRadius: 3,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 8, fontWeight: 700, color: isDark ? '#000' : '#fff',
        overflow: 'hidden', whiteSpace: 'nowrap',
      }}
      title={`${stint.compound} L${stint.lap_start}-${stint.lap_start + stint.length - 1}`}
    >
      {stint.length > 5 ? `${stint.compound[0]} ${stint.length}L` : stint.compound[0]}
    </div>
  );
}

function StrategyCard({ scenario, isActive, onToggle, onSimulate, maxLap, index }) {
  const riskColors = { low: '#22c55e', medium: '#f5a623', high: '#ef4444' };
  const riskColor = riskColors[scenario.risk] || '#888';

  return (
    <div
      className={`strategy-card${isActive ? ' strategy-card--active' : ''}`}
      onClick={onToggle}
      style={{ '--card-index': index }}
    >
      <div className="strategy-card__header">
        <span className="strategy-card__label">{scenario.label}</span>
        {scenario.risk && (
          <span className="strategy-card__risk" style={{ color: riskColor, borderColor: `${riskColor}44` }}>
            {scenario.risk.toUpperCase()}
          </span>
        )}
      </div>

      {/* Stint plan visual */}
      <div className="strategy-card__stints">
        {(scenario.stints || []).map((stint, i) => (
          <StintBar key={i} stint={stint} maxLap={maxLap || 60} />
        ))}
      </div>

      {/* Projected outcome */}
      <div className="strategy-card__outcome">
        {scenario.projected_position && (
          <span className="strategy-card__metric">
            <span className="strategy-card__metric-label">Finish</span>
            <span className="strategy-card__metric-value">P{scenario.projected_position}</span>
          </span>
        )}
        {scenario.total_stops != null && (
          <span className="strategy-card__metric">
            <span className="strategy-card__metric-label">Stops</span>
            <span className="strategy-card__metric-value">{scenario.total_stops}</span>
          </span>
        )}
        {scenario.time_delta && (
          <span className="strategy-card__metric">
            <span className="strategy-card__metric-label">Delta</span>
            <span className="strategy-card__metric-value">{scenario.time_delta}</span>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="strategy-card__overlay-hint">
          {isActive ? 'Overlaid on timeline' : 'Click to overlay'}
        </div>
        {scenario.stints?.length > 0 && onSimulate && (
          <button
            onClick={(e) => { e.stopPropagation(); onSimulate(scenario); }}
            style={{
              background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.3)',
              borderRadius: 3, padding: '1px 6px', fontSize: '8px', color: '#00e676',
              cursor: 'pointer', fontWeight: 700,
            }}
          >
            Simulate
          </button>
        )}
      </div>
    </div>
  );
}

export default function GeminiAssistant() {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('strategy'); // 'strategy' | 'chat'
  const messagesEndRef = useRef(null);

  const geminiMessages = useF1Store((s) => s.geminiMessages);
  const geminiOverlays = useF1Store((s) => s.geminiOverlays);
  const sendGeminiQuery = useF1Store((s) => s.sendGeminiQuery);
  const setGeminiOverlays = useF1Store((s) => s.setGeminiOverlays);
  const raceProjection = useF1Store((s) => s.raceProjection);
  const applyGeminiScenario = useF1Store((s) => s.applyGeminiScenario);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const drivers = useF1Store((s) => s.drivers);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const rivalContext = useF1Store((s) => s.rivalContext);
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const frameData = useF1Store((s) => s.frameData);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const sessionData = useF1Store((s) => s.sessionData);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const sessionNow = useSessionNow();

  const activeDriver = focusDriver || selectedDrivers[0] || null;
  const driverColor = activeDriver ? getDriverColor(activeDriver) : '#888';

  // Current tyre: race replay / lap mode = the set in force from the lap data
  // at sessionNow (FocusDriverWidget focusDriverStatus, R3: the new set from
  // the pit exit; the frames switch at the out-lap start, in the pit lane);
  // live and qualifying replay = frame data
  const lapStatus = useMemo(
    () => (isQualifyingReplay || isLiveMode || !activeDriver
      ? null
      : focusDriverStatus(sessionData?.lap_times, activeDriver, sessionNow)),
    [sessionData, activeDriver, sessionNow, isQualifyingReplay, isLiveMode],
  );
  const frameTyreInfo = useMemo(() => {
    if (!activeDriver || !frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    const d = frameData.frames[idx]?.drivers?.[activeDriver];
    if (!d) return null;
    const NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };
    return { compound: NAMES[d.tyre] || 'UNKNOWN', age: d.tyre_life != null ? Math.round(d.tyre_life) : null };
  }, [activeDriver, frameData, currentFrameIndex]);
  const tyreInfo = lapStatus?.compound
    ? { compound: lapStatus.compound, age: lapStatus.tyreLife }
    : frameTyreInfo;

  // Get driver features from race situation PCA
  const driverFeats = useMemo(() => {
    if (!activeDriver || !raceSituationData?.driverFeatures) return null;
    return raceSituationData.driverFeatures[activeDriver] || null;
  }, [activeDriver, raceSituationData]);

  // Get MC projection for active driver
  const driverProjection = useMemo(() => {
    if (!activeDriver || !raceProjection?.projections) return null;
    return raceProjection.projections.find((p) => p.driver === activeDriver) || null;
  }, [activeDriver, raceProjection]);

  // Auto-scroll chat
  useEffect(() => {
    if (mode === 'chat') messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [geminiMessages, mode]);

  const handleSend = useCallback(() => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    sendGeminiQuery(q);
    setMode('chat');
  }, [input, sendGeminiQuery]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickQuery = useCallback((q) => {
    sendGeminiQuery(q);
    setMode('chat');
  }, [sendGeminiQuery]);

  // Generate strategy comparison request
  const handleCompareStrategies = useCallback(() => {
    const driver = activeDriver || 'the leader';
    sendGeminiQuery(`Compare strategy options for ${driver} from the current race situation`);
    setMode('chat');
  }, [activeDriver, sendGeminiQuery]);

  // Contextual quick queries based on actual race state
  const quickQueries = useMemo(() => {
    const queries = [];
    if (!activeDriver) return ['Select a driver (double-click in leaderboard)'];

    // Tyre-based queries
    if (driverFeats) {
      const tyreAge = driverFeats.tyreLife || tyreInfo?.age || 0;
      const estPit = driverFeats.estLapsToPit;
      if (estPit != null && estPit <= 5) {
        queries.push(`Pit ${activeDriver} now or extend the stint?`);
      }
      if (driverFeats.paceTrend > 0.05) {
        queries.push(`${activeDriver} is losing pace. Should we undercut?`);
      }
    }

    // Battle-based queries
    if (rivalContext?.length > 0) {
      const ahead = rivalContext.find((r) => r.position < (driverFeats?.position || 99));
      const behind = rivalContext.find((r) => r.position > (driverFeats?.position || 0));
      if (ahead) {
        queries.push(`Undercut ${ahead.driver} for position?`);
      }
      if (behind && behind.gapTrend === 'closing') {
        queries.push(`Defend against ${behind.driver}?`);
      }
    }

    // Battle queries from MC
    if (raceProjection?.battles?.length > 0) {
      const battle = raceProjection.battles.find(
        (b) => b.behind === activeDriver || b.ahead === activeDriver
      );
      if (battle && queries.length < 3) {
        const isAttacking = battle.behind === activeDriver;
        queries.push(
          isAttacking
            ? `Attack ${battle.ahead}? (${battle.prob}% chance)`
            : `Defend against ${battle.behind}? (${battle.prob}% threat)`
        );
      }
    }

    // Risk queries
    if (raceProjection?.risks?.length > 0) {
      const myRisk = raceProjection.risks.find((r) => r.driver === activeDriver);
      if (myRisk && queries.length < 4) {
        queries.push(`Mitigate ${myRisk.type?.toLowerCase() || 'risk'} for ${activeDriver}`);
      }
    }

    // Fallback generic queries
    if (queries.length === 0) {
      queries.push(`Best strategy for ${activeDriver}?`);
    }
    if (queries.length < 3) {
      queries.push('1-stop vs 2-stop?');
    }
    if (queries.length < 4) {
      queries.push('When is the optimal pit window?');
    }

    return queries.slice(0, 4);
  }, [activeDriver, driverFeats, tyreInfo, rivalContext, raceProjection]);

  // Get scenarios from the latest AI response
  const latestScenarios = useMemo(() => {
    for (let i = geminiMessages.length - 1; i >= 0; i--) {
      if (geminiMessages[i].role === 'ai' && geminiMessages[i].scenarios?.length > 0) {
        return geminiMessages[i].scenarios;
      }
    }
    return [];
  }, [geminiMessages]);

  const toggleScenario = useCallback((scenario) => {
    const active = geminiOverlays.some((o) => o.id === scenario.id);
    if (active) {
      setGeminiOverlays(geminiOverlays.filter((o) => o.id !== scenario.id));
    } else {
      setGeminiOverlays([...geminiOverlays, scenario]);
    }
  }, [geminiOverlays, setGeminiOverlays]);

  const driverInfo = useMemo(() => {
    if (!activeDriver || !drivers?.length) return null;
    return drivers.find((d) => d.Abbreviation === activeDriver);
  }, [activeDriver, drivers]);

  const loading = geminiMessages.length > 0 && geminiMessages[geminiMessages.length - 1].role === 'user';

  return (
    <Panel title="Strategy Engineer">
      <div className="strategy-console">
        {/* Driver Briefing Header */}
        <div className="strategy-console__briefing" style={{ borderColor: `${driverColor}44` }}>
          {activeDriver ? (
            <>
              <div className="strategy-console__driver">
                <span className="strategy-console__team-bar" style={{ backgroundColor: driverColor }} />
                <span className="strategy-console__abbr" style={{ color: driverColor }}>{activeDriver}</span>
                <span className="strategy-console__team">{driverInfo?.TeamName || ''}</span>
              </div>
              <div className="strategy-console__stats">
                {driverFeats?.position && <span className="strategy-console__stat">P{driverFeats.position}</span>}
                {tyreInfo && (
                  <span className="strategy-console__tyre" style={{
                    backgroundColor: TYRE_COLORS[tyreInfo.compound] || '#888',
                    color: tyreInfo.compound === 'HARD' || tyreInfo.compound === 'MEDIUM' ? '#000' : '#fff',
                  }}>
                    {tyreInfo.compound[0]}{tyreInfo.age != null ? ` L${tyreInfo.age}` : ''}
                  </span>
                )}
                {driverFeats?.recentPace > 0 && (
                  <span className="strategy-console__stat">{fmtTime(driverFeats.recentPace)}</span>
                )}
                {driverFeats?.paceTrend != null && (
                  <span className="strategy-console__stat" style={{
                    color: driverFeats.paceTrend > 0.05 ? '#ef4444' : driverFeats.paceTrend < -0.05 ? '#22c55e' : '#888',
                  }}>
                    {driverFeats.paceTrend > 0 ? '+' : ''}{driverFeats.paceTrend.toFixed(2)}s/lap
                  </span>
                )}
                {driverProjection && (
                  <span className="strategy-console__stat" title="Monte Carlo projected finish">
                    {'\u2192'} P{typeof driverProjection.expectedPos === 'number' ? driverProjection.expectedPos.toFixed(1) : driverProjection.expectedPos}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="strategy-console__no-driver">
              Double-click a driver in the leaderboard to assign your role as their strategist
            </div>
          )}
        </div>

        {/* Mode Toggle */}
        <div className="strategy-console__tabs">
          <button
            className={`strategy-console__tab${mode === 'strategy' ? ' strategy-console__tab--active' : ''}`}
            onClick={() => setMode('strategy')}
          >
            Strategy
          </button>
          <button
            className={`strategy-console__tab${mode === 'chat' ? ' strategy-console__tab--active' : ''}`}
            onClick={() => setMode('chat')}
          >
            Radio
          </button>
        </div>

        {/* Strategy Mode */}
        {mode === 'strategy' && (
          <div className="strategy-console__body">
            {/* Quick tactical queries */}
            <div className="strategy-console__quick">
              {quickQueries.map((q) => (
                <button
                  key={q}
                  className="strategy-console__quick-btn"
                  onClick={() => handleQuickQuery(q)}
                  disabled={!activeDriver || loading}
                >
                  {q}
                </button>
              ))}
            </div>

            {/* Compare Strategies button */}
            {activeDriver && (
              <button
                className="strategy-console__compare-btn"
                onClick={handleCompareStrategies}
                disabled={loading || currentLap < 3}
              >
                {loading ? 'Analyzing...' : `Compare Strategies for ${activeDriver}`}
              </button>
            )}

            {/* Strategy Cards */}
            {latestScenarios.length > 0 && (
              <div className="strategy-console__cards">
                {latestScenarios.map((scenario, i) => (
                  <StrategyCard
                    key={scenario.id}
                    scenario={scenario}
                    index={i}
                    onSimulate={applyGeminiScenario}
                    isActive={geminiOverlays.some((o) => o.id === scenario.id)}
                    onToggle={() => toggleScenario(scenario)}
                    maxLap={maxLap || 60}
                  />
                ))}
              </div>
            )}

            {/* Latest AI response text */}
            {geminiMessages.length > 0 && (() => {
              const lastAi = [...geminiMessages].reverse().find((m) => m.role === 'ai');
              if (!lastAi) return null;
              return (
                <div className="strategy-console__response">
                  <div className="strategy-console__response-label">Analysis</div>
                  <div className="strategy-console__response-text">{lastAi.content}</div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Chat/Radio Mode */}
        {mode === 'chat' && (
          <div className="strategy-console__body">
            <div className="chat-messages">
              {geminiMessages.length === 0 && (
                <div style={{
                  color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)',
                  textAlign: 'center', padding: 'var(--spacing-lg) 0',
                }}>
                  Ask a question or use the Strategy tab for analysis.
                </div>
              )}
              {geminiMessages.map((msg, i) => (
                <div key={i} className={`chat-message chat-message--${msg.role}`}>
                  {msg.role === 'ai' && (
                    <div className="message-label">
                      Engineer
                      {msg.is_mock && (
                        <span
                          className="message-mock-chip"
                          title="Mock fallback — no Gemini API key configured. Responses are hand-written examples, not live model output."
                        >
                          MOCK
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                  {msg.scenarios?.length > 0 && (
                    <div style={{ marginTop: 'var(--spacing-xs)', display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-xs)' }}>
                      {msg.scenarios.map((scenario, j) => (
                        <button
                          key={j}
                          className={`scenario-btn${geminiOverlays.some((o) => o.id === scenario.id) ? ' active' : ''}`}
                          onClick={() => toggleScenario(scenario)}
                        >
                          {scenario.label || `Scenario ${j + 1}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div style={{ color: '#7a7f9a', fontSize: 10, fontStyle: 'italic', padding: '4px 0' }}>
                  Analyzing race data...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Input bar — always visible */}
        <div className="chat-input-area">
          <input
            type="text"
            className="chat-input"
            placeholder={activeDriver ? `Ask about ${activeDriver}'s strategy...` : 'Select a driver first...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeDriver}
          />
          <button className="btn btn-primary btn-sm" onClick={handleSend} disabled={!activeDriver || loading}>
            Send
          </button>
        </div>
      </div>
    </Panel>
  );
}
