import React, { useMemo, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';
import { simulateRaceFinish } from '../../utils/raceSimulation';
import Panel from '../ui/Panel';

export default function RacePredictionPanel() {
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const predictionLoading = useF1Store((s) => s.predictionLoading);
  const lastPredictionTrigger = useF1Store((s) => s.lastPredictionTrigger);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const sessionData = useF1Store((s) => s.sessionData);
  const trackStatus = useF1Store((s) => s.trackStatus);
  const setRaceProjection = useF1Store((s) => s.setRaceProjection);

  const effectiveMaxLap = totalRaceLaps || maxLap;

  // ── Monte Carlo race projection (all drivers, real data) ──
  const raceProjection = useMemo(() => {
    if (!raceSituationData?.driverFeatures) return null;
    return simulateRaceFinish({
      driverFeatures: raceSituationData.driverFeatures,
      currentLap,
      maxLap: effectiveMaxLap,
      lapTimes: sessionData?.lap_times,
      strategies: sessionData?.tyre_strategy,
      trackStatus,
    });
  }, [raceSituationData, currentLap, effectiveMaxLap, sessionData, trackStatus]);

  // Sync to store so Gemini can access it
  useEffect(() => {
    setRaceProjection(raceProjection);
  }, [raceProjection, setRaceProjection]);

  const lapsRemaining = effectiveMaxLap - currentLap;
  const raceProgress = effectiveMaxLap > 0 ? currentLap / effectiveMaxLap : 0;
  const numDrivers = raceSituationData?.driverAbbrs?.length || 20;

  return (
    <Panel title="Race Prediction (Monte Carlo)">
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── MONTE CARLO PROJECTED FINISH (all drivers) ── */}
        {raceProjection && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>

            {/* Race progress + params header */}
            <div style={{
              background: 'linear-gradient(135deg, rgba(0,230,118,0.10) 0%, rgba(0,230,118,0.02) 100%)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--spacing-sm) var(--spacing-md)',
              borderLeft: '3px solid #00e676',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#00e676', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Monte Carlo Projection
                </span>
                <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                  Lap {currentLap}/{effectiveMaxLap} &middot; {lapsRemaining} to go
                </span>
              </div>
              <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 6 }}>
                <div style={{
                  height: '100%', borderRadius: 2, backgroundColor: '#00e676',
                  width: `${Math.min(100, raceProgress * 100)}%`, transition: 'width 0.5s ease',
                }} />
              </div>
              {/* Real data params summary */}
              {raceProjection.raceParams && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: '8px', color: 'var(--color-text-muted)' }}>
                  <span>Pit loss: {raceProjection.raceParams.pitLoss.mean.toFixed(1)}s {'\u00B1'}{raceProjection.raceParams.pitLoss.stdDev.toFixed(1)}</span>
                  <span>Lap noise: {'\u00B1'}{raceProjection.raceParams.lapNoise.toFixed(2)}s</span>
                  <span>SC rate: {(raceProjection.raceParams.scRate * 100).toFixed(1)}%/lap</span>
                  <span>100 sims</span>
                </div>
              )}
            </div>

            {/* ── Compact Legend ── */}
            <div style={{
              display: 'flex', gap: 10, flexWrap: 'wrap', padding: '0 var(--spacing-sm)',
              fontSize: '8px', color: 'var(--color-text-muted)',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff', border: '1px solid rgba(0,0,0,0.3)', flexShrink: 0 }} />
                Expected
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderTop: '4px solid var(--color-text-muted)', flexShrink: 0 }} />
                Current
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 8, height: 4, borderRadius: 1, background: '#00e676', flexShrink: 0 }} />
                Gain
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 8, height: 4, borderRadius: 1, background: '#e10600', flexShrink: 0 }} />
                Loss
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 8, height: 4, borderRadius: 1, background: '#ffd700', opacity: 0.7, flexShrink: 0 }} />
                Points
              </span>
            </div>

            {/* ── Position probability table ── */}
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)' }}>

              {raceProjection.projections.map((p) => {
                const deltaColor = p.delta > 0.5 ? '#00e676' : p.delta < -0.5 ? '#e10600' : 'var(--color-text-muted)';
                const isSelected = selectedDrivers.includes(p.driver);

                // Build probability bar segments
                const barSegments = [];
                const sortedPositions = Object.entries(p.posDistribution)
                  .map(([pos, pct]) => [parseInt(pos), pct])
                  .sort((a, b) => a[0] - b[0]);

                for (const [pos, pct] of sortedPositions) {
                  if (pct < 3) continue;
                  const hue = pos <= 3 ? 140 : pos <= 10 ? 45 : 0;
                  const sat = Math.min(100, pct * 2);
                  barSegments.push({ pos, pct, color: `hsl(${hue}, ${sat}%, ${40 + pct * 0.3}%)` });
                }

                return (
                  <div key={p.driver} style={{
                    padding: '5px 6px',
                    borderRadius: 4,
                    background: isSelected ? 'rgba(255,255,255,0.04)' : 'transparent',
                    borderLeft: isSelected ? '2px solid ' + getDriverColor(p.driver) : '2px solid transparent',
                    marginBottom: 1,
                  }}>
                    {/* Row 1: Position, driver, delta, podium/pts */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      {/* Position */}
                      <span style={{
                        fontWeight: 900, fontSize: 'var(--font-size-sm)', minWidth: 26,
                        color: p.modePos <= 3 ? '#ffd700' : p.modePos <= 10 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                      }}>
                        P{p.modePos}
                      </span>

                      {/* Delta arrow */}
                      {Math.abs(p.delta) >= 0.5 ? (
                        <span style={{
                          fontSize: '8px', color: deltaColor, fontWeight: 700,
                          minWidth: 18, textAlign: 'center',
                        }}>
                          {p.delta > 0 ? '\u25B2' : '\u25BC'}{Math.abs(Math.round(p.delta))}
                        </span>
                      ) : (
                        <span style={{ minWidth: 18, textAlign: 'center', fontSize: '8px', color: 'var(--color-text-muted)' }}>
                          {'\u2022'}
                        </span>
                      )}

                      {/* Driver name */}
                      <span style={{
                        fontWeight: 700, fontSize: 'var(--font-size-xs)',
                        color: getDriverColor(p.driver), minWidth: 32,
                      }}>
                        {p.driver}
                      </span>

                      {/* Current position */}
                      <span style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
                        now P{p.currentPos}
                      </span>

                      {/* Spacer */}
                      <span style={{ flex: 1 }} />

                      {/* Range */}
                      <span style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
                        P{p.posRange[0]}{'\u2013'}P{p.posRange[1]}
                      </span>

                      {/* Podium / Points */}
                      {p.podiumProb > 0 && (
                        <span style={{
                          fontSize: '8px', fontWeight: 700, minWidth: 28, textAlign: 'right',
                          color: p.podiumProb >= 50 ? '#ffd700' : 'var(--color-text-muted)',
                        }}>
                          {p.podiumProb}%
                          <span style={{ fontWeight: 400, fontSize: '7px' }}> pod</span>
                        </span>
                      )}
                    </div>

                    {/* Row 2: Probability bar */}
                    <div style={{ position: 'relative', height: 8, marginLeft: 2, marginRight: 2 }}>
                      {/* Full range track */}
                      <div style={{
                        position: 'absolute', top: 2, left: 0, right: 0, height: 4,
                        borderRadius: 2, background: 'rgba(255,255,255,0.04)',
                      }} />
                      {/* P5-P95 range band */}
                      <div style={{
                        position: 'absolute', top: 2, height: 4, borderRadius: 2,
                        background: 'rgba(255,255,255,0.10)',
                        left: `${((p.posRange[0] - 1) / numDrivers) * 100}%`,
                        width: `${(Math.max(1, p.posRange[1] - p.posRange[0] + 1) / numDrivers) * 100}%`,
                      }} />
                      {/* Probability segments */}
                      {barSegments.map((seg) => (
                        <div key={seg.pos} style={{
                          position: 'absolute', top: 0, height: 8, borderRadius: 2,
                          backgroundColor: seg.color,
                          opacity: Math.min(1, seg.pct / 25),
                          left: `${((seg.pos - 1) / numDrivers) * 100}%`,
                          width: `${Math.max(4, (1 / numDrivers) * 100)}%`,
                        }} />
                      ))}
                      {/* Current position marker (small triangle) */}
                      <div style={{
                        position: 'absolute', top: -1,
                        left: `${((p.currentPos - 1) / numDrivers) * 100}%`,
                        transform: 'translateX(-2px)',
                        width: 0, height: 0,
                        borderLeft: '2px solid transparent',
                        borderRight: '2px solid transparent',
                        borderTop: '3px solid var(--color-text-muted)',
                      }} />
                      {/* Expected position dot */}
                      <div style={{
                        position: 'absolute', top: 1,
                        left: `${((p.expectedPos - 1) / numDrivers) * 100}%`,
                        transform: 'translateX(-3px)',
                        width: 6, height: 6, borderRadius: '50%',
                        backgroundColor: '#fff', border: '1px solid rgba(0,0,0,0.3)',
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── KEY BATTLES (overtake probabilities) ── */}
            {raceProjection.battles.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Overtake Probabilities
                </h6>
                {raceProjection.battles.map((b, i) => {
                  const probColor = b.prob >= 60 ? '#00e676' : b.prob >= 30 ? '#ffd700' : '#64C4FF';
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
                      fontSize: 'var(--font-size-xs)',
                    }}>
                      {/* Probability badge */}
                      <span style={{
                        flexShrink: 0, minWidth: 36, textAlign: 'center',
                        fontWeight: 900, fontSize: 'var(--font-size-sm)',
                        color: probColor,
                      }}>
                        {b.prob}%
                      </span>

                      <div style={{ flex: 1, lineHeight: 1.4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <strong style={{ color: getDriverColor(b.behind) }}>{b.behind}</strong>
                          <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>P{b.behindCurrentPos}</span>
                          <span style={{ color: probColor, fontSize: '10px' }}>{'\u2192'}</span>
                          <strong style={{ color: getDriverColor(b.ahead) }}>{b.ahead}</strong>
                          <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>P{b.aheadCurrentPos}</span>
                        </div>
                        <div style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
                          {b.behind} on {b.behindCompound} &middot; {b.ahead} on {b.aheadCompound}
                        </div>
                      </div>

                      {/* Probability bar */}
                      <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', flexShrink: 0 }}>
                        <div style={{
                          height: '100%', borderRadius: 2, backgroundColor: probColor,
                          width: `${b.prob}%`,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── RISK FACTORS ── */}
            {raceProjection.risks.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Risk Factors
                </h6>
                {raceProjection.risks.map((r, i) => {
                  const sevColor = r.severity === 'high' ? '#e10600' : r.severity === 'medium' ? '#ffd700' : '#64C4FF';
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6,
                      fontSize: 'var(--font-size-xs)', lineHeight: 1.5,
                    }}>
                      <span style={{
                        flexShrink: 0, width: 18, height: 18, borderRadius: 3,
                        backgroundColor: sevColor, color: '#000', fontWeight: 900,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px',
                      }}>
                        {r.severity === 'high' ? '!!' : '!'}
                      </span>
                      <div>
                        <span style={{
                          fontSize: '7px', fontWeight: 700, padding: '1px 4px',
                          borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.06)',
                          color: sevColor, marginRight: 4,
                        }}>
                          {r.type}
                        </span>
                        <span style={{ color: 'var(--color-text-primary)' }}>{r.description}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── LSTM per-driver predictions (from triggerPrediction) ── */}
        {lstmPredictions && typeof lstmPredictions === 'object' && (
          <div style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.10) 0%, rgba(168,85,247,0.02) 100%)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--spacing-sm) var(--spacing-md)',
            borderLeft: '3px solid #a855f7',
            marginTop: 'var(--spacing-sm)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#a855f7', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                LSTM Predictions
              </span>
              {predictionLoading && (
                <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>Loading...</span>
              )}
              {lastPredictionTrigger && (
                <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                  {lastPredictionTrigger.driver} @ L{lastPredictionTrigger.lap}
                </span>
              )}
            </div>
            {Object.entries(lstmPredictions).map(([driver, pred]) => {
              if (!pred || driver === 'driver_predictions') return null;
              // Handle both direct per-driver results and legacy format
              const prediction = pred.predicted_lap_time || pred.predicted_position_change || pred;
              if (!prediction || typeof prediction !== 'object' && typeof prediction !== 'number') return null;
              return (
                <div key={driver} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
                  fontSize: 'var(--font-size-xs)',
                }}>
                  <span style={{ fontWeight: 700, color: getDriverColor(driver) }}>{driver}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    {typeof prediction === 'number'
                      ? prediction.toFixed(3) + 's'
                      : JSON.stringify(prediction).slice(0, 40)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Early-race state: collecting data ── */}
        {!raceProjection && raceSituationData && currentLap >= 3 && (
          <div style={{
            background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)',
            padding: 'var(--spacing-md)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              Monte Carlo simulation available after <strong style={{ color: '#00e676' }}>lap 5</strong>.
              <br />
              Collecting real pace data, pit stops, and tyre degradation to calibrate...
            </div>
          </div>
        )}

        {/* ── Empty state: no replay running ── */}
        {!raceProjection && !raceSituationData && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              <strong style={{ color: '#00e676', display: 'block', marginBottom: 8, fontSize: 'var(--font-size-md)' }}>
                Monte Carlo Race Prediction
              </strong>
              Runs <strong>100 simulations</strong> using real session data to project
              <strong> finish positions</strong> with probability distributions.<br /><br />
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: '12px', textAlign: 'left' }}>
                <div style={{ fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6, fontSize: '9px', textTransform: 'uppercase' }}>What it uses</div>
                <div style={{ marginBottom: 4, fontSize: 'var(--font-size-xs)' }}>
                  <span style={{ color: '#00e676', fontWeight: 700 }}>{'\u2713'}</span> Real tyre degradation from observed lap times
                </div>
                <div style={{ marginBottom: 4, fontSize: 'var(--font-size-xs)' }}>
                  <span style={{ color: '#00e676', fontWeight: 700 }}>{'\u2713'}</span> Actual pit stop durations from this session
                </div>
                <div style={{ marginBottom: 4, fontSize: 'var(--font-size-xs)' }}>
                  <span style={{ color: '#00e676', fontWeight: 700 }}>{'\u2713'}</span> Safety car probability from track events
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)' }}>
                  <span style={{ color: '#00e676', fontWeight: 700 }}>{'\u2713'}</span> Lap-to-lap variance for realistic noise
                </div>
              </div>
              <div style={{ marginTop: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                Start the race replay to activate predictions.
              </div>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
