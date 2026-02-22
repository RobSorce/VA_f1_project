import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS } from '../../utils/colors';
import Panel from '../ui/Panel';
import StrategyBriefing from './StrategyBriefing';

export default function StrategyAnalysis() {
  const tsneStrategyAnalysis = useF1Store((s) => s.tsneStrategyAnalysis);
  const selectedTSNEPoints = useF1Store((s) => s.selectedTSNEPoints);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);

  return (
    <Panel title="Strategy Analysis">
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!tsneStrategyAnalysis && selectedTSNEPoints.length === 0 && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              <strong style={{ color: 'var(--color-text-primary)', display: 'block', marginBottom: 8 }}>
                How to use Strategy Analysis
              </strong>
              Each point in the t-SNE plot represents a driver's<br />
              full race performance (pace, degradation, pit timing...).<br /><br />
              <strong style={{ color: 'var(--color-accent-info)' }}>1.</strong> Lasso-select a cluster of similar performances<br />
              <strong style={{ color: 'var(--color-accent-info)' }}>2.</strong> This panel shows what strategies worked in those races<br />
              <strong style={{ color: 'var(--color-accent-info)' }}>3.</strong> Results feed into LSTM predictions for better accuracy<br /><br />
              <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
                Shift+drag on the t-SNE chart to lasso select
              </span>
            </div>
          </div>
        )}

        {selectedTSNEPoints.length > 0 && !tsneStrategyAnalysis && (
          <div className="loading-placeholder">
            <div className="spinner" />
            <span>Analyzing {selectedTSNEPoints.length} selected points...</span>
          </div>
        )}

        {tsneStrategyAnalysis && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
            <div style={{
              background: 'var(--color-bg-tertiary)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--spacing-md)',
            }}>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)' }}>
                Selection Summary
              </h6>
              <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6 }}>
                <div><strong>{selectedTSNEPoints.length}</strong> race-driver points selected</div>
                {tsneStrategyAnalysis.common_patterns && (
                  <div style={{ marginTop: 'var(--spacing-sm)' }}>
                    {tsneStrategyAnalysis.common_patterns.map((pattern, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{
                          width: 10, height: 10, borderRadius: '50%',
                          backgroundColor: TYRE_COLORS[pattern.compound] || '#888',
                        }} />
                        <span>{pattern.compound}: avg {pattern.avg_stint_length?.toFixed(0)} laps</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {tsneStrategyAnalysis.pit_windows && (
              <div style={{
                background: 'var(--color-bg-tertiary)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--spacing-md)',
              }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)' }}>
                  Optimal Pit Windows
                </h6>
                {tsneStrategyAnalysis.pit_windows.map((w, i) => (
                  <div key={i} style={{ fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
                    Stop {i + 1}: Lap {w.lap_start} — {w.lap_end} (confidence: {(w.confidence * 100).toFixed(0)}%)
                  </div>
                ))}
              </div>
            )}

            {tsneStrategyAnalysis.strategies?.length > 0 && (
              <div style={{
                background: 'var(--color-bg-tertiary)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--spacing-md)',
              }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)' }}>
                  Common Strategies
                </h6>
                {tsneStrategyAnalysis.strategies.map((strat, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    fontSize: 'var(--font-size-xs)', marginBottom: 4,
                  }}>
                    <span style={{ color: 'var(--color-text-muted)', width: 20 }}>#{i + 1}</span>
                    {(strat.stints || []).map((s, j) => (
                      <span key={j} style={{
                        padding: '2px 6px',
                        borderRadius: 3,
                        backgroundColor: TYRE_COLORS[s.compound?.toUpperCase()] || '#888',
                        color: s.compound?.toUpperCase() === 'HARD' || s.compound?.toUpperCase() === 'MEDIUM' ? '#000' : '#fff',
                        fontSize: 9,
                        fontWeight: 700,
                      }}>
                        {s.compound?.[0]}{s.length}
                      </span>
                    ))}
                    <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                      {(strat.frequency * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tsneStrategyAnalysis.feature_importance?.length > 0 && (
              <StrategyBriefing />
            )}

            {lstmPredictions && (
              <div style={{
                background: 'var(--color-bg-tertiary)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--spacing-md)',
                borderLeft: '3px solid var(--color-accent-info)',
              }}>
                <h6 style={{ color: 'var(--color-accent-info)', marginBottom: 'var(--spacing-sm)' }}>
                  LSTM Predictions (t-SNE enriched)
                </h6>
                <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6 }}>
                  {lstmPredictions.summary || 'Predictions updated with t-SNE context.'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
