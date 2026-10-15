import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  driverStyle, tyreColor, tyreLetter, contrastText, deltaColor, withAlpha, CHART_FONT, chartFontPx,
  TEXT_COLORS, GRID_COLORS, UI_COLORS,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import Panel from '../ui/Panel';
import { useDemoMode, BACKEND_ONLY_TEXT } from '../../utils/demoMode';
import { focusDriverStatus } from '../../utils/views/focusDriverWidget';
import { listedBattles, modePosition } from '../../utils/simulationClient';
import { drawStintStrips } from '../../utils/views/stintStripChart';
import { useBoxSize, fitRows, pageOf } from '../../utils/views/chartBox';
import { severityOf, chipStyle, UP, DOWN } from '../../utils/views/strategyMarks';

// Tooltip of the MOCK chip: what the fallback is (the reply's first line names the reason)
const MOCK_TOOLTIP = 'Heuristic fallback, not Gemini: no API key configured, the google-genai package missing, '
  + 'or the API unavailable. A rule-based answer built from the race context; its first line names the reason.';

const COMPOUND_ORDER = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

function fmtTime(s) {
  if (!s || s <= 0) return '--:--.---';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

/**
 * A scenario's stints as a D3 strip (utils/views/stintStripChart.js) on the
 * race's laps: compound colour, letter and length on each segment.
 */
function ScenarioStrip({ stints, maxLap }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const box = useBoxSize(boxRef);
  useEffect(() => {
    if (!svgRef.current) return;
    const segments = (stints || []).map((st, i) => ({
      key: `${i}`,
      start: st.lap_start,
      length: st.length,
      compound: st.compound || 'UNKNOWN',
      title: `${st.compound} L${st.lap_start}-${st.lap_start + st.length - 1}`,
    }));
    drawStintStrips(svgRef.current, {
      rows: [{ key: 'scenario', label: '', segments }],
      domain: [1, Math.max(2, maxLap + 1)],
      width: box.width > 0 ? box.width : 220,
      rowH: Math.max(18, Math.round(chartFontPx('data') * 1.7)),
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
    });
  });
  return (
    <div ref={boxRef} className="strategy-card__stints">
      <svg ref={svgRef} className="strategy-card__stints-svg" style={{ display: 'block', maxWidth: '100%' }} />
    </div>
  );
}

function StrategyCard({ scenario, isActive, onToggle, onSimulate, maxLap, index }) {
  // risk: the severity scheme (colour, glyph, word), never green / red
  const risk = severityOf(scenario.risk);

  return (
    <div
      className={`strategy-card${isActive ? ' strategy-card--active' : ''}`}
      onClick={onToggle}
      style={{ '--card-index': index }}
    >
      <div className="strategy-card__header">
        <span className="strategy-card__label">{scenario.label}</span>
        {scenario.risk && (
          <span className="strategy-card__risk" title={`Risk: ${scenario.risk}`} style={chipStyle(risk.color, 0.12)}>
            {risk.glyph} {scenario.risk.toUpperCase()}
          </span>
        )}
      </div>

      {/* Stint plan visual (D3) */}
      <ScenarioStrip stints={scenario.stints} maxLap={maxLap || 60} />

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
              background: withAlpha(UI_COLORS.brush, 0.12), border: `1px solid ${UI_COLORS.brush}`,
              borderRadius: 3, padding: '1px 6px', fontSize: CHART_FONT.label, color: TEXT_COLORS.primary,
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
  // Static demo (no backend): Gemini is model-side, the input says so
  const demoActive = useDemoMode((s) => s.active);
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
  const driverMark = activeDriver ? driverStyle(activeDriver) : null;

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
    // among the battles the Race Prediction panel lists (store list)
    if (raceProjection?.battles?.length > 0) {
      const battle = listedBattles(raceProjection).find(
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
        <div className="strategy-console__briefing" style={{ borderColor: driverMark?.mark || GRID_COLORS.rule }}>
          {activeDriver ? (
            <>
              <div className="strategy-console__driver">
                <span className="strategy-console__team-bar" style={{ backgroundColor: driverMark.mark }} />
                <span className="strategy-console__abbr" style={{ color: driverMark.text }}>{activeDriver}</span>
                <span className="strategy-console__team">{driverInfo?.TeamName || ''}</span>
              </div>
              <div className="strategy-console__stats">
                {driverFeats?.position && <span className="strategy-console__stat">P{driverFeats.position}</span>}
                {tyreInfo && (
                  <span className="strategy-console__tyre" title={tyreInfo.compound} style={{
                    backgroundColor: tyreColor(tyreInfo.compound),
                    color: contrastText(tyreColor(tyreInfo.compound)),
                  }}>
                    {tyreLetter(tyreInfo.compound)}{tyreInfo.age != null ? ` L${tyreInfo.age}` : ''}
                  </span>
                )}
                {driverFeats?.recentPace > 0 && (
                  <span className="strategy-console__stat">{fmtTime(driverFeats.recentPace)}</span>
                )}
                {driverFeats?.paceTrend != null && (
                  // pace trend: + = slower each lap (worse, ▲), − = faster (better, ▼)
                  <span
                    className="strategy-console__stat"
                    title="Pace trend: change of the lap time per lap (+ = slower)"
                    style={{ color: deltaColor(driverFeats.paceTrend, { deadband: 0.05 }) }}
                  >
                    {driverFeats.paceTrend > 0.05 ? `${UP} ` : driverFeats.paceTrend < -0.05 ? `${DOWN} ` : ''}
                    {driverFeats.paceTrend > 0 ? '+' : driverFeats.paceTrend < 0 ? '−' : ''}{Math.abs(driverFeats.paceTrend).toFixed(2)}s/lap
                  </span>
                )}
                {driverProjection && modePosition(raceProjection, driverProjection) != null && (
                  <span
                    className="strategy-console__stat"
                    title="Monte Carlo median finishing position: the Race Prediction panel's P label of the driver"
                  >
                    {'\u2192'} P{modePosition(raceProjection, driverProjection)}
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

            {/* Strategy Cards: the cards that fit, paged (no scroll) */}
            {latestScenarios.length > 0 && (
              <ScenarioCards
                scenarios={latestScenarios}
                render={(scenario, i) => (
                  <StrategyCard
                    key={scenario.id}
                    scenario={scenario}
                    index={i}
                    onSimulate={applyGeminiScenario}
                    isActive={geminiOverlays.some((o) => o.id === scenario.id)}
                    onToggle={() => toggleScenario(scenario)}
                    maxLap={maxLap || 60}
                  />
                )}
              />
            )}

            {/* Latest AI response text */}
            {geminiMessages.length > 0 && (() => {
              const lastAi = [...geminiMessages].reverse().find((m) => m.role === 'ai');
              if (!lastAi) return null;
              return (
                <div className="strategy-console__response">
                  <div className="strategy-console__response-label">
                    Analysis
                    {/* the whole answer is in the Radio tab's chat log */}
                    <button type="button" className="strategy-console__response-more" onClick={() => setMode('chat')}>
                      Full answer in Radio {'\u2192'}
                    </button>
                  </div>
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
                          title={MOCK_TOOLTIP}
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
                <div style={{ color: TEXT_COLORS.secondary, fontSize: CHART_FONT.label, fontStyle: 'italic', padding: '4px 0' }}>
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
            placeholder={demoActive ? `${BACKEND_ONLY_TEXT} (Gemini)` : activeDriver ? `Ask about ${activeDriver}'s strategy...` : 'Select a driver first...'}
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

/**
 * The scenario cards that fit the space left in the Strategy tab, paged
 * when they do not (no scroll): a card is a title line, the D3 strip, the
 * outcome and the overlay line.
 */
function ScenarioCards({ scenarios, render }) {
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
  const [page, setPage] = useState(0);
  const line = Math.ceil(chartFontPx('data') * 1.4);
  const cardH = 5 * line + Math.max(18, Math.round(chartFontPx('data') * 1.7)) + 28;
  const fit = fitRows(box.height, scenarios.length, { rowMin: cardH, rowMax: cardH * 2, rowDefault: cardH, pagerH: 22 });
  const pg = pageOf(scenarios, page, fit.perPage);
  const btn = {
    fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, background: 'transparent',
    border: `1px solid ${GRID_COLORS.rule}`, borderRadius: 3, padding: '0 6px', cursor: 'pointer',
  };
  return (
    <div ref={boxRef} className="strategy-console__cards">
      {pg.rows.map((sc, i) => render(sc, pg.first - 1 + i))}
      {fit.paged && (
        <div className="strategy-console__pager" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: 22, flexShrink: 0,
          fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary,
        }}
        >
          <button type="button" aria-label="Previous scenarios" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} style={btn}>{'◀'}</button>
          <span>scenarios {pg.first}{'–'}{pg.last} of {scenarios.length}</span>
          <button type="button" aria-label="Next scenarios" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)} style={btn}>{'▶'}</button>
        </div>
      )}
    </div>
  );
}
