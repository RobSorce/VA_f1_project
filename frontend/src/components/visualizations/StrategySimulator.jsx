import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';
import Panel from '../ui/Panel';

const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

export default function StrategySimulator() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const simulatorStrategy = useF1Store((s) => s.simulatorStrategy);
  const simulatorResult = useF1Store((s) => s.simulatorResult);
  const simulatorComparisons = useF1Store((s) => s.simulatorComparisons);
  const isSimulatorActive = useF1Store((s) => s.isSimulatorActive);
  const setSimulatorStrategy = useF1Store((s) => s.setSimulatorStrategy);
  const runSimulation = useF1Store((s) => s.runSimulation);
  const clearSimulator = useF1Store((s) => s.clearSimulator);
  const addSimulatorComparison = useF1Store((s) => s.addSimulatorComparison);
  const raceProjection = useF1Store((s) => s.raceProjection);
  const raceSituationData = useF1Store((s) => s.raceSituationData);

  const effectiveMaxLap = totalRaceLaps || maxLap || 60;
  const driver = simulatorStrategy?.driver || focusDriver || (selectedDrivers.length === 1 ? selectedDrivers[0] : null);

  // Local editing state for stints
  const [editStints, setEditStints] = useState([
    { compound: 'SOFT', lapStart: 1, length: Math.round(effectiveMaxLap / 3) },
    { compound: 'MEDIUM', lapStart: Math.round(effectiveMaxLap / 3) + 1, length: Math.round(effectiveMaxLap / 3) },
    { compound: 'HARD', lapStart: Math.round(effectiveMaxLap * 2 / 3) + 1, length: effectiveMaxLap - Math.round(effectiveMaxLap * 2 / 3) },
  ]);
  const [editDriver, setEditDriver] = useState(driver);

  // Sync driver from store
  useEffect(() => {
    if (driver && driver !== editDriver) setEditDriver(driver);
  }, [driver]);

  // If store has a strategy (e.g. from PCA pattern), load it into local state
  useEffect(() => {
    if (simulatorStrategy?.stints?.length && simulatorStrategy.driver) {
      setEditStints(simulatorStrategy.stints.map((s) => ({ ...s })));
      setEditDriver(simulatorStrategy.driver);
    }
  }, [simulatorStrategy]);

  // Available drivers
  const driverList = useMemo(() => {
    if (!raceSituationData?.driverAbbrs) return [];
    return raceSituationData.driverAbbrs;
  }, [raceSituationData]);

  // Current actual strategy for the driver
  const actualStrategy = useMemo(() => {
    const strats = sessionData?.tyre_strategy || sessionData?.strategies || [];
    if (!editDriver) return [];
    return strats
      .filter((s) => (s.Driver || s.driver) === editDriver)
      .map((s) => ({
        compound: s.Compound || 'UNKNOWN',
        lapStart: s.LapStart || s.StartLap || 1,
        length: s.StintLength || s.TotalLaps || ((s.EndLap || 10) - (s.StartLap || 1) + 1),
      }))
      .sort((a, b) => a.lapStart - b.lapStart);
  }, [sessionData, editDriver]);

  // Recalculate lapStart values when stints change
  const normalizeStints = useCallback((stints) => {
    let lapStart = 1;
    return stints.map((s) => {
      const normalized = { ...s, lapStart };
      lapStart += s.length;
      return normalized;
    });
  }, []);

  const handleCompoundChange = (idx, compound) => {
    const updated = [...editStints];
    updated[idx] = { ...updated[idx], compound };
    setEditStints(updated);
  };

  const handleLengthChange = (idx, newLength) => {
    const updated = [...editStints];
    updated[idx] = { ...updated[idx], length: Math.max(1, newLength) };
    setEditStints(normalizeStints(updated));
  };

  const addStint = () => {
    const totalUsed = editStints.reduce((s, st) => s + st.length, 0);
    const remaining = Math.max(5, effectiveMaxLap - totalUsed);
    const newStints = [...editStints, { compound: 'MEDIUM', lapStart: totalUsed + 1, length: remaining }];
    setEditStints(normalizeStints(newStints));
  };

  const removeStint = (idx) => {
    if (editStints.length <= 1) return;
    const updated = editStints.filter((_, i) => i !== idx);
    setEditStints(normalizeStints(updated));
  };

  const handleRunSimulation = () => {
    if (!editDriver) return;
    const stints = normalizeStints(editStints);
    setSimulatorStrategy({ driver: editDriver, stints });
    // Give store time to update, then run
    setTimeout(() => runSimulation(), 50);
  };

  const handleSaveComparison = () => {
    if (!simulatorResult) return;
    const label = editStints.map((s) => `${s.compound[0]}${s.length}`).join('-');
    addSimulatorComparison(label, [...editStints], simulatorResult);
  };

  const handleCopyActual = () => {
    if (actualStrategy.length > 0) {
      setEditStints(actualStrategy.map((s) => ({ ...s })));
    }
  };

  // Stint bar visualization ref
  const barRef = useRef(null);
  const totalLaps = editStints.reduce((s, st) => s + st.length, 0);

  // No-driver empty state
  if (!editDriver && driverList.length === 0) {
    return (
      <Panel title="Strategy Simulator">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-md)', color: '#00e676', fontWeight: 700, marginBottom: 12 }}>
            What-If Strategy Simulator
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8, maxWidth: 260 }}>
            Start the race replay past <strong>lap 5</strong> to activate Monte Carlo simulation.
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 12, maxWidth: 260, lineHeight: 1.6 }}>
            Then focus a driver (double-click in Leaderboard) and define an alternative pit strategy to see projected outcomes.
          </div>
        </div>
      </Panel>
    );
  }

  const driverColor = editDriver ? getDriverColor(editDriver) : '#888';
  const canRun = editDriver && currentLap >= 5 && editStints.length > 0 && raceSituationData?.driverFeatures;

  return (
    <Panel title="Strategy Simulator">
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>

          {/* ── Driver Selector ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
            background: 'linear-gradient(135deg, rgba(0,230,118,0.08) 0%, rgba(0,230,118,0.02) 100%)',
            borderRadius: 'var(--radius-md)', borderLeft: `3px solid ${driverColor}`,
          }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
              DRIVER
            </span>
            <select
              value={editDriver || ''}
              onChange={(e) => setEditDriver(e.target.value)}
              style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 3, color: driverColor, fontSize: 'var(--font-size-xs)',
                fontWeight: 700, padding: '2px 6px', cursor: 'pointer',
              }}
            >
              <option value="">Select driver</option>
              {driverList.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
              L{currentLap}/{effectiveMaxLap}
            </span>
            {actualStrategy.length > 0 && (
              <button
                onClick={handleCopyActual}
                title="Copy actual race strategy"
                style={{
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 3, padding: '2px 6px', fontSize: '8px', color: 'rgba(255,255,255,0.5)',
                  cursor: 'pointer', fontWeight: 600,
                }}
              >
                Copy Actual
              </button>
            )}
          </div>

          {/* ── Stint Editor ── */}
          <div style={{
            background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h6 style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700, margin: 0 }}>
                Custom Strategy ({editStints.length - 1} stops)
              </h6>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={addStint}
                  style={{
                    background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.3)',
                    borderRadius: 3, padding: '1px 8px', fontSize: '9px', color: '#00e676',
                    cursor: 'pointer', fontWeight: 700,
                  }}
                >
                  + Pit Stop
                </button>
              </div>
            </div>

            {/* Visual stint bar */}
            <div ref={barRef} style={{
              position: 'relative',
              display: 'flex', height: 20, borderRadius: 4, overflow: 'hidden', gap: 1, marginBottom: 8,
            }}>
              {editStints.map((stint, i) => {
                const pct = totalLaps > 0 ? (stint.length / totalLaps) * 100 : 100 / editStints.length;
                return (
                  <div key={i} style={{
                    width: `${pct}%`, minWidth: 0,
                    backgroundColor: TYRE_COLORS[stint.compound] || '#888',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '8px', fontWeight: 700,
                    color: stint.compound === 'HARD' ? '#333' : '#000',
                    overflow: 'hidden', whiteSpace: 'nowrap',
                  }}>
                    {pct >= 6 ? `${stint.length}L` : ''}
                  </div>
                );
              })}

              {/* Current lap marker — absolute inside the bar */}
              {currentLap > 0 && currentLap <= totalLaps && (
                <div style={{
                  position: 'absolute',
                  left: `${(currentLap / totalLaps) * 100}%`,
                  top: 0, bottom: 0, width: 2,
                  backgroundColor: '#fff', opacity: 0.85,
                  transform: 'translateX(-1px)',
                  pointerEvents: 'none',
                  boxShadow: '0 0 4px rgba(255,255,255,0.6)',
                }} />
              )}
            </div>

            {/* Per-stint rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {editStints.map((stint, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
                  background: 'rgba(255,255,255,0.02)', borderRadius: 3,
                  borderLeft: `3px solid ${TYRE_COLORS[stint.compound] || '#888'}`,
                }}>
                  <span style={{ fontSize: '8px', fontWeight: 700, color: 'var(--color-text-muted)', minWidth: 14 }}>
                    S{i + 1}
                  </span>

                  {/* Compound selector */}
                  <div style={{ display: 'flex', gap: 2 }}>
                    {COMPOUNDS.slice(0, 3).map((c) => (
                      <button
                        key={c}
                        onClick={() => handleCompoundChange(i, c)}
                        style={{
                          width: 18, height: 18, borderRadius: '50%',
                          backgroundColor: TYRE_COLORS[c],
                          border: stint.compound === c ? '2px solid #fff' : '2px solid transparent',
                          cursor: 'pointer',
                          opacity: stint.compound === c ? 1 : 0.4,
                          transition: 'opacity 0.1s',
                          fontSize: '7px', fontWeight: 900,
                          color: c === 'HARD' ? '#333' : '#000',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                        title={c}
                      >
                        {c[0]}
                      </button>
                    ))}
                  </div>

                  {/* Length slider */}
                  <span style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>L{stint.lapStart}</span>
                  <input
                    type="range"
                    min={3}
                    max={Math.max(5, effectiveMaxLap - 5)}
                    value={stint.length}
                    onChange={(e) => handleLengthChange(i, parseInt(e.target.value))}
                    style={{
                      flex: 1, height: 3, appearance: 'none', background: 'rgba(255,255,255,0.1)',
                      borderRadius: 2, outline: 'none', cursor: 'pointer',
                      accentColor: TYRE_COLORS[stint.compound] || '#888',
                    }}
                  />
                  <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-primary)', minWidth: 22, textAlign: 'right' }}>
                    {stint.length}L
                  </span>

                  {/* Remove */}
                  {editStints.length > 1 && (
                    <button
                      onClick={() => removeStint(i)}
                      title="Remove stint"
                      style={{
                        width: 16, height: 16, borderRadius: '50%',
                        background: 'rgba(225,6,0,0.15)', border: 'none',
                        color: '#e10600', cursor: 'pointer', fontSize: '10px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Total laps warning */}
            {totalLaps !== effectiveMaxLap && (
              <div style={{
                fontSize: '8px', marginTop: 4,
                color: Math.abs(totalLaps - effectiveMaxLap) > 2 ? '#e10600' : '#ffd700',
              }}>
                Strategy covers {totalLaps} laps ({totalLaps > effectiveMaxLap ? '+' : ''}{totalLaps - effectiveMaxLap} vs race length {effectiveMaxLap})
              </div>
            )}
          </div>

          {/* ── Actual Strategy comparison ── */}
          {actualStrategy.length > 0 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)' }}>
              <h6 style={{ color: 'var(--color-text-muted)', fontSize: '9px', textTransform: 'uppercase', fontWeight: 700, margin: '0 0 4px' }}>
                Actual Strategy
              </h6>
              <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', gap: 1 }}>
                {actualStrategy.map((stint, i) => {
                  const actualTotal = actualStrategy.reduce((s, st) => s + st.length, 0);
                  const pct = actualTotal > 0 ? (stint.length / actualTotal) * 100 : 100 / actualStrategy.length;
                  return (
                    <div key={i} style={{
                      width: `${pct}%`, minWidth: 16,
                      backgroundColor: TYRE_COLORS[stint.compound] || '#888',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '7px', fontWeight: 700, color: stint.compound === 'HARD' ? '#333' : '#000',
                    }}>
                      {stint.compound[0]} {stint.length}L
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Run Button ── */}
          <button
            onClick={handleRunSimulation}
            disabled={!canRun}
            style={{
              width: '100%', padding: '8px 0',
              background: canRun
                ? 'linear-gradient(135deg, #00e676 0%, #00c853 100%)'
                : 'rgba(255,255,255,0.06)',
              border: 'none', borderRadius: 'var(--radius-md)',
              color: canRun ? '#000' : 'var(--color-text-muted)',
              fontWeight: 900, fontSize: 'var(--font-size-sm)',
              cursor: canRun ? 'pointer' : 'default',
              textTransform: 'uppercase', letterSpacing: '0.1em',
              fontFamily: "'Titillium Web', sans-serif",
            }}
          >
            {!canRun
              ? (currentLap < 5 ? 'Needs lap 5+' : !editDriver ? 'Select a driver' : 'No race data')
              : 'Run Simulation (100 sims)'}
          </button>

          {/* ── Simulation Results ── */}
          {simulatorResult && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(0,230,118,0.10) 0%, rgba(0,230,118,0.02) 100%)',
              borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)',
              borderLeft: '3px solid #00e676',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#00e676', textTransform: 'uppercase' }}>
                  Simulation Results
                </span>
                <button
                  onClick={handleSaveComparison}
                  style={{
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 3, padding: '2px 8px', fontSize: '8px', color: 'rgba(255,255,255,0.5)',
                    cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  Save for Compare
                </button>
              </div>

              {/* Position comparison */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                <ResultCard
                  label="Custom Strategy"
                  pos={simulatorResult.simProjection.expectedPos}
                  modePos={simulatorResult.simProjection.modePos}
                  range={simulatorResult.simProjection.posRange}
                  podium={simulatorResult.simProjection.podiumProb}
                  points={simulatorResult.simProjection.pointsProb}
                  color="#00e676"
                />
                <ResultCard
                  label="Baseline"
                  pos={simulatorResult.baselineProjection.expectedPos}
                  modePos={simulatorResult.baselineProjection.modePos}
                  range={simulatorResult.baselineProjection.posRange}
                  podium={simulatorResult.baselineProjection.podiumProb}
                  points={simulatorResult.baselineProjection.pointsProb}
                  color="var(--color-text-muted)"
                />
              </div>

              {/* Delta summary */}
              <DeltaSummary delta={simulatorResult.delta} />
            </div>
          )}

          {/* ── Saved Comparisons ── */}
          {simulatorComparisons.length > 0 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)' }}>
              <h6 style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700, margin: '0 0 6px' }}>
                Strategy Comparisons ({simulatorComparisons.length})
              </h6>
              {simulatorComparisons.map((comp, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
                  background: 'rgba(255,255,255,0.02)', borderRadius: 3, marginBottom: 2,
                  fontSize: 'var(--font-size-xs)',
                }}>
                  <span style={{ fontWeight: 700, color: 'var(--color-text-primary)', minWidth: 60 }}>
                    {comp.label}
                  </span>
                  <div style={{ display: 'flex', gap: 1, flex: 1, height: 10, borderRadius: 2, overflow: 'hidden' }}>
                    {comp.stints.map((s, j) => (
                      <div key={j} style={{
                        flex: s.length, backgroundColor: TYRE_COLORS[s.compound] || '#888',
                        minWidth: 4,
                      }} />
                    ))}
                  </div>
                  {comp.result && (
                    <span style={{
                      fontWeight: 700, fontSize: '9px',
                      color: comp.result.delta.position > 0 ? '#00e676' : comp.result.delta.position < 0 ? '#e10600' : 'var(--color-text-muted)',
                    }}>
                      P{comp.result.simProjection.modePos}
                      {comp.result.delta.position !== 0 && ` (${comp.result.delta.position > 0 ? '+' : ''}${comp.result.delta.position.toFixed(1)})`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Clear button ── */}
          {(simulatorResult || isSimulatorActive) && (
            <button
              onClick={clearSimulator}
              style={{
                width: '100%', padding: '4px 0',
                background: 'rgba(225,6,0,0.08)', border: '1px solid rgba(225,6,0,0.2)',
                borderRadius: 'var(--radius-md)', color: '#e10600',
                fontWeight: 600, fontSize: '9px', cursor: 'pointer',
              }}
            >
              Clear Simulator
            </button>
          )}

        </div>
      </div>
    </Panel>
  );
}

function ResultCard({ label, pos, modePos, range, podium, points, color }) {
  const safePos = typeof pos === 'number' ? pos : 0;
  const safeMode = modePos ?? '—';
  const r0 = range?.[0] ?? '—';
  const r1 = range?.[1] ?? '—';
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)',
      padding: '6px 8px', borderTop: `2px solid ${color}`,
    }}>
      <div style={{ fontSize: '8px', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 900, color }}>
        P{safeMode}
      </div>
      <div style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
        avg P{safePos.toFixed(1)} · range P{r0}–P{r1}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: '8px', flexWrap: 'wrap' }}>
        {podium > 0 && (
          <span style={{ color: '#ffd700', fontWeight: 700 }}>
            {podium}% podium
          </span>
        )}
        {points > 0 && (
          <span style={{ color: 'var(--color-text-secondary)' }}>
            {points}% points
          </span>
        )}
      </div>
    </div>
  );
}

function DeltaSummary({ delta }) {
  const posColor = delta.position > 0.5 ? '#00e676' : delta.position < -0.5 ? '#e10600' : 'var(--color-text-muted)';
  const posArrow = delta.position > 0.5 ? '\u25B2' : delta.position < -0.5 ? '\u25BC' : '\u2022';
  const posLabel = delta.position > 0.5 ? 'GAIN' : delta.position < -0.5 ? 'LOSS' : 'NEUTRAL';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px',
      background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 900, color: posColor }}>
          {posArrow} {Math.abs(delta.position).toFixed(1)}
        </div>
        <div style={{ fontSize: '7px', fontWeight: 700, color: posColor, textTransform: 'uppercase' }}>
          {posLabel}
        </div>
      </div>
      <div style={{ flex: 1, fontSize: '9px', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
        {delta.podium !== 0 && (
          <div>
            Podium: <span style={{ color: delta.podium > 0 ? '#00e676' : '#e10600', fontWeight: 700 }}>
              {delta.podium > 0 ? '+' : ''}{delta.podium.toFixed(0)}%
            </span>
          </div>
        )}
        {delta.points !== 0 && (
          <div>
            Points: <span style={{ color: delta.points > 0 ? '#00e676' : '#e10600', fontWeight: 700 }}>
              {delta.points > 0 ? '+' : ''}{delta.points.toFixed(0)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
