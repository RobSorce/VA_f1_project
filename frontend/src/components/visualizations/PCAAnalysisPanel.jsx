import React, { useMemo, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';
import { patternStopCount } from '../../utils/strategyViews';
import {
  selectionRows, selectionStatistics, forestHalfWidth, forestX, fmtSigned, fmtInterval, fmtMean,
  sameSelection, selectionClockNote, missingIntervalNote, progressRowNote,
} from '../../utils/views/pcaSelection';
import Panel from '../ui/Panel';

/* ── Shared tab pill style helper ── */
const tabPillStyle = (active) => ({
  padding: '3px 8px', fontSize: '9px', fontWeight: 600,
  borderRadius: 4, border: 'none', cursor: 'pointer',
  background: active ? 'rgba(100,196,255,0.15)' : 'transparent',
  color: active ? '#fff' : 'rgba(255,255,255,0.6)',
  transition: 'background 0.12s, color 0.12s',
});

// Forest plot strip: drawing width (viewBox units) and height (px)
const FOREST_W = 200;
const FOREST_H = 16;
// Colour of a feature flagged above random, and of the others
const ABOVE_RANDOM_COLOR = '#64C4FF';
const WITHIN_RANDOM_COLOR = 'rgba(255,255,255,0.75)';
// Columns of a row: feature, forest strip, numbers
const FOREST_COLUMNS = 'minmax(80px, 1fr) minmax(90px, 1.6fr) minmax(96px, auto)';

export default function PCAAnalysisPanel() {
  const pcaStrategyAnalysis = useF1Store((s) => s.pcaStrategyAnalysis);
  const selectedPCAPoints = useF1Store((s) => s.selectedPCAPoints);
  const setSelectedPCAPoints = useF1Store((s) => s.setSelectedPCAPoints);
  const applyPCAPattern = useF1Store((s) => s.applyPCAPattern);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const simulatorStrategy = useF1Store((s) => s.simulatorStrategy);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const pcaAnalysisIds = useF1Store((s) => s.pcaAnalysisIds);
  const pcaAnalysisError = useF1Store((s) => s.pcaAnalysisError);
  const [activeTab, setActiveTab] = useState('summary');

  // An analysis is shown only for the selection it answers (an answer set
  // without its ids is taken as the selection's)
  const analysis = pcaStrategyAnalysis && (!pcaAnalysisIds || sameSelection(pcaAnalysisIds, selectedPCAPoints))
    ? pcaStrategyAnalysis
    : null;
  const rows = useMemo(() => selectionRows(analysis), [analysis]);
  const stats = useMemo(() => selectionStatistics(analysis), [analysis]);
  const half = useMemo(() => forestHalfWidth(rows, stats.threshold), [rows, stats.threshold]);
  const strategies = useMemo(() => analysis?.strategies || [], [analysis]);
  const commonPatterns = useMemo(() => analysis?.common_patterns || [], [analysis]);
  const pitWindows = useMemo(() => analysis?.pit_windows || [], [analysis]);
  // Rows of the race on screen taken at the replay clock (null otherwise)
  const clockNote = selectionClockNote(analysis);


  // Convert PCA strategy pattern stints to simulator format with cumulative lapStart
  const applyStrategyToSimulator = (strategy) => {
    const driver = focusDriver || (selectedDrivers.length === 1 ? selectedDrivers[0] : null);
    if (!driver) return;
    let lapStart = 1;
    const stints = strategy.stints.map((s) => {
      const stint = { compound: s.compound, lapStart, length: s.length };
      lapStart += s.length;
      return stint;
    });
    applyPCAPattern({ driver, stints });
  };

  const canApply = !!(focusDriver || (selectedDrivers.length === 1));

  // Parse selected point IDs to get driver/year/round info
  const selectionInfo = useMemo(() => {
    if (!selectedPCAPoints || selectedPCAPoints.length === 0) return null;
    const drivers = new Set();
    const years = new Set();
    const rounds = new Set();
    for (const id of selectedPCAPoints) {
      const parts = id.rsplit ? id.split('_') : id.split('_');
      if (parts.length >= 3) {
        const round = parts.pop();
        const year = parts.pop();
        const driver = parts.join('_');
        drivers.add(driver);
        years.add(year);
        rounds.add(round);
      }
    }
    return {
      count: selectedPCAPoints.length,
      drivers: [...drivers],
      years: [...years],
      races: rounds.size,
    };
  }, [selectedPCAPoints]);

  // Tab definitions — must be before any early returns (Rules of Hooks)
  const pcaTabs = useMemo(() => {
    const tabs = [{ id: 'summary', label: 'Summary' }];
    if (strategies.length > 0 || commonPatterns.length > 0)
      tabs.push({ id: 'patterns', label: `Patterns (${strategies.length})` });
    if (rows.length > 0)
      tabs.push({ id: 'differences', label: 'Differences' });
    if (pitWindows.length > 0 || (selectionInfo && selectionInfo.drivers.length > 0))
      tabs.push({ id: 'details', label: 'Details' });
    return tabs;
  }, [strategies, commonPatterns, rows, pitWindows, selectionInfo]);
  // A tab the new answer does not have falls back to the summary
  const tab = pcaTabs.some((t) => t.id === activeTab) ? activeTab : 'summary';

  // No selection state
  if (!selectedPCAPoints || selectedPCAPoints.length === 0) {
    return (
      <Panel title="Cross-Race Analysis">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-md)', color: '#64C4FF', fontWeight: 700, marginBottom: 12 }}>
            PCA Biplot Analysis
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8, maxWidth: 240 }}>
            <strong>Lasso-select</strong> points on the PCA biplot to analyze cross-race strategy patterns.
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6, marginTop: 12, maxWidth: 240 }}>
            Each point is one driver in one race (the race on screen: the laps completed so far during its replay). Clusters reveal similar strategies across different races and seasons.
          </div>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
            <span>Click a point to toggle selection</span>
            <span>Shift+drag to lasso-select a group</span>
            <span>Loading vectors show feature directions</span>
          </div>
        </div>
      </Panel>
    );
  }

  // Waiting for analysis response (or its error)
  if (!analysis) {
    return (
      <Panel title="Cross-Race Analysis">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
            {pcaAnalysisError ? `Analysis failed: ${pcaAnalysisError}` : 'Analyzing selection...'}
          </div>
        </div>
      </Panel>
    );
  }

  // The clock of the race on screen's rows, wherever its stints / stops show
  const clockBanner = clockNote ? (
    <div className="pca-clock-note" style={{
      fontSize: 'var(--font-size-xs)', color: 'var(--color-text-primary)', lineHeight: 1.5,
      padding: '3px 6px', borderLeft: '2px solid var(--color-text-secondary)', background: 'rgba(255,255,255,0.04)',
    }}>
      {clockNote}
    </div>
  ) : null;

  // What the numbers are: label, group sizes, how many features pass the
  // random-selection threshold
  const statsBanner = (
    <div className="pca-stats-banner" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {stats.label}
      </div>
      <div>
        {stats.nSelected != null && stats.nRest != null
          ? `N = ${stats.nSelected} selected vs ${stats.nRest} other rows`
          : `N = ${selectedPCAPoints.length} selected`}
        {stats.threshold != null && rows.length > 0
          ? ` · ${stats.nAboveRandom} of ${stats.nFeatures} features above random`
          : ''}
      </div>
      {/* the selection's mix of row kinds, and the baseline drawn with it */}
      {stats.composition && (
        <div className="pca-composition">{stats.composition}</div>
      )}
      {clockBanner && <div style={{ marginTop: 4 }}>{clockBanner}</div>}
    </div>
  );

  return (
    <Panel title="Cross-Race Analysis">
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* Tab pills */}
        {pcaTabs.length > 1 && (
          <div style={{
            display: 'flex', gap: 4, padding: '4px 8px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            {pcaTabs.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={tabPillStyle(tab === t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Tab content — takes all remaining space */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 'var(--spacing-sm)' }}>

          {tab === 'summary' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              {/* Selection summary + cluster label */}
              <div style={{
                background: 'linear-gradient(135deg, rgba(100,196,255,0.08) 0%, rgba(100,196,255,0.02) 100%)',
                borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)', borderLeft: '3px solid #64C4FF',
              }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#64C4FF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  {analysis.cluster_label || 'Selected Cluster'}
                </div>
                <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6, color: 'var(--color-text-primary)' }}>
                  {analysis.summary}
                </div>
                <div style={{ marginTop: 6 }}>{statsBanner}</div>
                {selectionInfo && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                    <span>{selectionInfo.count} race entries</span>
                    <span>{selectionInfo.drivers.length} drivers</span>
                    <span>{selectionInfo.years.length > 1 ? `${selectionInfo.years.length} seasons` : `${selectionInfo.years[0]} season`}</span>
                  </div>
                )}
                {selectedPCAPoints.length > 0 && (
                  <button onClick={() => setSelectedPCAPoints([])} style={{
                    marginTop: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 3, padding: '2px 8px', fontSize: '9px', color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
                  }}>Clear selection</button>
                )}
              </div>

              {/* Compound usage inline */}
              {commonPatterns.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {commonPatterns.map((p, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                      background: 'rgba(255,255,255,0.04)', borderLeft: `3px solid ${TYRE_COLORS[p.compound] || '#888'}`,
                    }}>
                      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: TYRE_COLORS[p.compound] || '#888' }}>{p.compound}</span>
                      <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>{p.count} stints · avg {p.avg_stint_length?.toFixed(0) || '?'}L</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'patterns' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              {clockBanner}
              {strategies.length > 0 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                  <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Strategy Patterns
                  </h6>
                  {strategies.map((s, i) => {
                    const isApplied = simulatorStrategy?.stints?.length === s.stints.length &&
                      s.stints.every((st, j) => simulatorStrategy.stints[j]?.compound === st.compound);
                    return (
                    <div key={i}
                      onClick={() => canApply && applyStrategyToSimulator(s)}
                      title={canApply ? 'Click to simulate this strategy' : 'Focus a driver first (double-click in Leaderboard)'}
                      style={{
                      marginBottom: 8, padding: '6px 8px',
                      background: isApplied ? 'rgba(100,196,255,0.12)' : i === 0 ? 'rgba(100,196,255,0.06)' : 'transparent',
                      borderRadius: 'var(--radius-sm)',
                      borderLeft: isApplied ? '2px solid #22c55e' : i === 0 ? '2px solid #64C4FF' : '2px solid transparent',
                      cursor: canApply ? 'pointer' : 'default', transition: 'background 0.15s, border-color 0.15s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: isApplied ? '#22c55e' : i === 0 ? '#64C4FF' : 'var(--color-text-primary)' }}>
                          {s.count}× ({(s.frequency * 100).toFixed(0)}%)
                        </span>
                        {/* N stints = N - 1 stops (same rule as insightsGenerator / tsne_compute.py) */}
                        <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>{patternStopCount(s.stints)}-stop strategy</span>
                        {canApply && (
                          <span style={{
                            marginLeft: 'auto', fontSize: '8px', fontWeight: 600,
                            color: isApplied ? '#22c55e' : 'rgba(100,196,255,0.6)',
                            padding: '1px 5px', borderRadius: 3,
                            background: isApplied ? 'rgba(34,197,94,0.1)' : 'rgba(100,196,255,0.08)',
                          }}>{isApplied ? '\u2713 Applied' : 'Simulate \u2192'}</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', gap: 1 }}>
                        {s.stints.map((stint, j) => {
                          const totalLaps = s.stints.reduce((sum, st) => sum + st.length, 0);
                          const pct = totalLaps > 0 ? (stint.length / totalLaps) * 100 : 100 / s.stints.length;
                          return (
                            <div key={j} style={{
                              width: `${pct}%`, minWidth: 16, backgroundColor: TYRE_COLORS[stint.compound] || '#888',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '7px', fontWeight: 700, color: stint.compound === 'HARD' ? '#333' : '#000',
                            }}>{stint.length}L</div>
                          );
                        })}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'differences' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', height: '100%', overflowY: 'auto' }}>
              {statsBanner}
              <div className="pca-forest" role="table" aria-label="Differences of the selection from the other rows"
                style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)' }}>
                {/* Column heads and the axis direction */}
                <div role="row" style={{
                  display: 'grid', gridTemplateColumns: FOREST_COLUMNS, gap: 6,
                  fontSize: '9px', color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: 4,
                }}>
                  <span role="columnheader">Feature</span>
                  <span role="columnheader" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>lower in selection</span><span>higher</span>
                  </span>
                  <span role="columnheader" style={{ textAlign: 'right' }}>g [interval] · random |g|</span>
                </div>
                {rows.map((r) => {
                  const color = r.exceedsRandom ? ABOVE_RANDOM_COLOR : WITHIN_RANDOM_COLOR;
                  const x = (v) => forestX(v, half, FOREST_W);
                  const interval = fmtInterval(r.ciLow, r.ciHigh);
                  // a group too small for an interval (one row has no spread of its own)
                  const noInterval = interval ? null : missingIntervalNote(r, stats.minGroupForInterval);
                  // a feature that moves with race progress, rows at the clock mixed with whole races
                  const progressNote = progressRowNote(r, stats);
                  const otherN = r.nSelected != null && r.nRest != null
                    && (r.nSelected !== stats.nSelected || r.nRest !== stats.nRest);
                  // the |g| this row must pass (its own during a replay, else the one of all rows)
                  const threshold = r.threshold ?? stats.threshold;
                  return (
                    <div key={r.feature} role="row" className="pca-forest-row"
                      title={`g = ${r.g} · selection mean ${fmtMean(r.selectedMean, r.unit)} · other rows ${fmtMean(r.restMean, r.unit)}`}
                      style={{
                        display: 'grid', gridTemplateColumns: FOREST_COLUMNS, gap: 6,
                        alignItems: 'center', padding: '2px 0', borderTop: '1px solid rgba(255,255,255,0.05)',
                      }}>
                      <span role="cell" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-primary)', fontWeight: r.exceedsRandom ? 700 : 500 }}>
                        {r.label}
                        {r.exceedsRandom && (
                          <span className="pca-above-random" style={{ display: 'block', fontSize: '8px', color: ABOVE_RANDOM_COLOR, fontWeight: 700 }}>
                            above random
                          </span>
                        )}
                        {progressNote && (
                          <span className="pca-progress-note" title={stats.progressNote || undefined}
                            style={{ display: 'block', fontSize: '8px', color: 'var(--color-text-secondary)', fontWeight: 600, fontStyle: 'italic' }}>
                            {progressNote}
                          </span>
                        )}
                      </span>
                      <svg role="cell" viewBox={`0 0 ${FOREST_W} ${FOREST_H}`} preserveAspectRatio="none"
                        width="100%" height={FOREST_H} aria-label={`g ${fmtSigned(r.g)}`}>
                        {/* expected |g| of a random selection of the same size */}
                        {r.baseline != null && (
                          <rect className="pca-forest-baseline" x={x(-r.baseline)} y={1}
                            width={x(r.baseline) - x(-r.baseline)} height={FOREST_H - 2}
                            style={{ fill: 'rgba(255,255,255,0.14)' }} />
                        )}
                        {/* threshold this feature must pass to be flagged */}
                        {threshold != null && [-threshold, threshold].map((t) => (
                          <line key={t} className="pca-forest-threshold" x1={x(t)} x2={x(t)} y1={0} y2={FOREST_H}
                            vectorEffect="non-scaling-stroke" strokeDasharray="2,2"
                            style={{ stroke: 'rgba(255,255,255,0.45)', strokeWidth: 1 }} />
                        ))}
                        <line x1={x(0)} x2={x(0)} y1={0} y2={FOREST_H} vectorEffect="non-scaling-stroke"
                          style={{ stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1 }} />
                        {interval && (
                          <line className="pca-forest-interval" x1={x(r.ciLow)} x2={x(r.ciHigh)} y1={FOREST_H / 2} y2={FOREST_H / 2}
                            vectorEffect="non-scaling-stroke" style={{ stroke: color, strokeWidth: 2 }} />
                        )}
                        <line className="pca-forest-g" x1={x(r.g)} x2={x(r.g)} y1={2} y2={FOREST_H - 2}
                          vectorEffect="non-scaling-stroke" style={{ stroke: color, strokeWidth: 3 }} />
                      </svg>
                      <span role="cell" style={{ fontSize: '9px', textAlign: 'right', lineHeight: 1.35, fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ color, fontWeight: 700 }}>g {fmtSigned(r.g)}</span>
                        {interval && <span style={{ color: 'var(--color-text-secondary)' }}> {interval}</span>}
                        {noInterval && (
                          <span className="pca-no-interval" style={{ display: 'block', color: 'var(--color-text-secondary)' }}>
                            {noInterval}
                          </span>
                        )}
                        <span style={{ display: 'block', color: 'var(--color-text-secondary)' }}>
                          {r.baseline != null ? `random |g| ${r.baseline.toFixed(2)}` : 'no random baseline'}
                          {stats.perFeatureThreshold && r.threshold != null
                            ? <span className="pca-row-threshold">{` · threshold ${r.threshold.toFixed(2)}`}</span>
                            : null}
                          {otherN ? ` · n ${r.nSelected} vs ${r.nRest}` : ''}
                        </span>
                      </span>
                    </div>
                  );
                })}
                <div style={{ marginTop: 6, fontSize: '8.5px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  {`Tick = Hedges' g (selection minus other rows, in pooled SDs); bar = ${stats.intervalName || 'interval'}`
                    + (stats.minGroupForInterval != null
                      ? ` (none for a group of fewer than ${stats.minGroupForInterval} rows: one row has no spread of its own)`
                      : '')
                    + '; shaded = expected |g| of a random selection of the same size and mix; dashed = the threshold a feature must pass to be marked "above random"'
                    + (stats.perFeatureThreshold
                      ? ` (each feature its own: the ${stats.thresholdLevel != null ? `${(stats.thresholdLevel * 100).toFixed(1)}% quantile` : 'same high percentile'} of its random |g|, so that 5% of random selections pass some threshold).`
                      : '.')
                    + (stats.progressNote ? ` ${stats.progressNote}.` : '')}
                </div>
              </div>
              {(stats.note || stats.effectSize || stats.baseline) && (
                <details style={{ fontSize: '8.5px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Method</summary>
                  {stats.effectSize && <div>{stats.effectSize}</div>}
                  {stats.interval && <div>{stats.interval}</div>}
                  {stats.baseline && <div>{stats.baseline}</div>}
                  {stats.composition && <div>{stats.composition}</div>}
                  {stats.perFeatureThreshold
                    ? stats.thresholdText && <div className="pca-threshold-rule">{stats.thresholdText}</div>
                    : stats.threshold != null && <div>{`Above random: |g| > ${stats.threshold}`}</div>}
                  {stats.note && <div style={{ marginTop: 4 }}>{stats.note}</div>}
                </details>
              )}
            </div>
          )}

          {tab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              {pitWindows.length > 0 && clockBanner}
              {pitWindows.length > 0 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                  <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Common Pit Windows
                  </h6>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {pitWindows.map((pw, i) => (
                      <div key={i}
                        onClick={() => setSelectedLapRange([pw.lap_start, pw.lap_end])}
                        title="Click to highlight this lap range across all views"
                        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-xs)', cursor: 'pointer' }}>
                        <span style={{
                          padding: '2px 6px', borderRadius: 3, fontWeight: 700, fontSize: '9px',
                          backgroundColor: i === 0 ? 'rgba(100,196,255,0.15)' : 'rgba(255,255,255,0.06)',
                          color: i === 0 ? '#64C4FF' : 'var(--color-text-secondary)',
                        }}>L{pw.lap_start}–L{pw.lap_end}</span>
                        <span style={{ color: 'var(--color-text-muted)' }}>{pw.count} stops in this window</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectionInfo && selectionInfo.drivers.length > 0 && selectionInfo.drivers.length <= 12 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                  <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Drivers in Selection
                  </h6>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {selectionInfo.drivers.map((d) => (
                      <span key={d}
                        onClick={() => { setFocusDriver(d); setSelectedDrivers([d]); }}
                        title={`Focus ${d} — enables strategy simulation`}
                        style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '3px 8px', borderRadius: 'var(--radius-sm)',
                        background: focusDriver === d ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                        borderLeft: `2px solid ${getDriverColor(d)}`,
                        fontSize: 'var(--font-size-xs)', fontWeight: 600, color: getDriverColor(d),
                        cursor: 'pointer', outline: focusDriver === d ? `1px solid ${getDriverColor(d)}` : 'none',
                      }}>{d}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
