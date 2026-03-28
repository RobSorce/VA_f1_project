import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';
import Panel from '../ui/Panel';

const FEATURE_DISPLAY = {
  avg_lap_time: 'Avg Lap Time',
  std_lap_time: 'Consistency',
  best_lap_time: 'Best Lap',
  avg_sector1: 'Sector 1',
  avg_sector2: 'Sector 2',
  avg_sector3: 'Sector 3',
  pit_count: 'Pit Stops',
  stint_count: 'Stints',
  avg_stint_length: 'Avg Stint',
  max_stint_length: 'Max Stint',
  degradation_rate: 'Tyre Deg.',
  grid_position: 'Grid Pos.',
  finish_position: 'Finish Pos.',
  position_change: 'Pos. Gained',
  fuel_corrected_pace: 'Fuel-Adj Pace',
  gap_to_leader_mean: 'Gap to Leader',
  rolling_pace_3: 'Last 3 Pace',
  rolling_pace_5: 'Last 5 Pace',
  track_temp: 'Track Temp',
  air_temp: 'Air Temp',
};

function featureLabel(fi) {
  return fi.label || FEATURE_DISPLAY[fi.feature] || fi.feature.replace(/_/g, ' ');
}

export default function PCAAnalysisPanel() {
  const tsneStrategyAnalysis = useF1Store((s) => s.tsneStrategyAnalysis);
  const selectedTSNEPoints = useF1Store((s) => s.selectedTSNEPoints);
  const setSelectedTSNEPoints = useF1Store((s) => s.setSelectedTSNEPoints);
  const applyPCAPattern = useF1Store((s) => s.applyPCAPattern);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const simulatorStrategy = useF1Store((s) => s.simulatorStrategy);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const radarRef = useRef(null);
  const barsRef = useRef(null);

  const analysis = tsneStrategyAnalysis;
  const featureImportance = useMemo(() => analysis?.feature_importance || [], [analysis]);
  const topFeatures = useMemo(() => featureImportance.slice(0, 8), [featureImportance]);
  const strategies = useMemo(() => analysis?.strategies || [], [analysis]);
  const commonPatterns = useMemo(() => analysis?.common_patterns || [], [analysis]);
  const pitWindows = useMemo(() => analysis?.pit_windows || [], [analysis]);

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
    if (!selectedTSNEPoints || selectedTSNEPoints.length === 0) return null;
    const drivers = new Set();
    const years = new Set();
    const rounds = new Set();
    for (const id of selectedTSNEPoints) {
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
      count: selectedTSNEPoints.length,
      drivers: [...drivers],
      years: [...years],
      races: rounds.size,
    };
  }, [selectedTSNEPoints]);

  // Radar chart
  useEffect(() => {
    if (!radarRef.current || topFeatures.length < 3) return;

    const container = radarRef.current;
    const width = container.clientWidth || 220;
    const height = 180;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) - 25;

    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);
    const n = topFeatures.length;
    const angleSlice = (2 * Math.PI) / n;
    const maxEffect = d3.max(topFeatures, (d) => d.effect_size) || 1;
    const rScale = d3.scaleLinear().domain([0, maxEffect]).range([0, radius]);

    [0.25, 0.5, 0.75, 1].forEach((level) => {
      g.append('circle')
        .attr('r', radius * level)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(255,255,255,0.08)')
        .attr('stroke-dasharray', '2,3');
    });

    topFeatures.forEach((_, i) => {
      const angle = angleSlice * i - Math.PI / 2;
      g.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', radius * Math.cos(angle))
        .attr('y2', radius * Math.sin(angle))
        .attr('stroke', 'rgba(255,255,255,0.1)');
    });

    topFeatures.forEach((f, i) => {
      const angle = angleSlice * i - Math.PI / 2;
      const labelR = radius + 14;
      g.append('text')
        .attr('x', labelR * Math.cos(angle))
        .attr('y', labelR * Math.sin(angle))
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', 'rgba(255,255,255,0.5)')
        .attr('font-size', '7px')
        .attr('font-weight', '600')
        .text(featureLabel(f));
    });

    const radarLine = d3.lineRadial()
      .angle((_, i) => angleSlice * i)
      .radius((d) => rScale(d.effect_size))
      .curve(d3.curveCardinalClosed);

    g.append('path')
      .datum(topFeatures)
      .attr('d', radarLine)
      .attr('fill', 'rgba(225, 6, 0, 0.15)')
      .attr('stroke', '#e10600')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.8);

    topFeatures.forEach((f, i) => {
      const angle = angleSlice * i - Math.PI / 2;
      const r = rScale(f.effect_size);
      g.append('circle')
        .attr('cx', r * Math.cos(angle))
        .attr('cy', r * Math.sin(angle))
        .attr('r', 3)
        .attr('fill', f.direction === 'higher' ? '#22c55e' : '#ef4444')
        .attr('stroke', '#fff')
        .attr('stroke-width', 0.5);
    });
  }, [topFeatures]);

  // Feature importance bars
  useEffect(() => {
    if (!barsRef.current || featureImportance.length === 0) return;

    const container = barsRef.current;
    const width = container.clientWidth || 240;
    const barH = 14;
    const gap = 3;
    const top6 = featureImportance.slice(0, 6);
    const height = top6.length * (barH + gap) + 10;

    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);

    const maxEffect = d3.max(top6, (d) => d.effect_size) || 1;
    const xScale = d3.scaleLinear().domain([0, maxEffect]).range([0, width - 130]);

    const g = svg.append('g').attr('transform', 'translate(120, 4)');

    top6.forEach((f, i) => {
      const y = i * (barH + gap);
      const color = f.direction === 'higher' ? '#22c55e' : '#ef4444';

      svg.append('text')
        .attr('x', 116).attr('y', y + barH / 2 + 4)
        .attr('text-anchor', 'end')
        .attr('fill', 'rgba(255,255,255,0.6)')
        .attr('font-size', '8px')
        .attr('font-weight', '600')
        .text(featureLabel(f));

      g.append('rect')
        .attr('x', 0).attr('y', y)
        .attr('width', xScale(f.effect_size))
        .attr('height', barH)
        .attr('rx', 2)
        .attr('fill', color)
        .attr('opacity', 0.6);

      const mag = f.magnitude || (f.effect_size >= 0.8 ? 'large' : f.effect_size >= 0.5 ? 'medium' : 'small');
      g.append('text')
        .attr('x', xScale(f.effect_size) + 4).attr('y', y + barH / 2 + 1)
        .attr('fill', color)
        .attr('font-size', '8px')
        .attr('font-weight', '700')
        .attr('dominant-baseline', 'middle')
        .text(`${f.effect_size.toFixed(2)} ${f.direction === 'higher' ? '\u2191' : '\u2193'} ${mag}`);
    });
  }, [featureImportance]);

  // No selection state
  if (!selectedTSNEPoints || selectedTSNEPoints.length === 0) {
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
            Each point represents one driver's full race performance. Clusters reveal similar strategies across different races and seasons.
          </div>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
            <span>Click a point to toggle selection</span>
            <span>Drag to lasso-select a group</span>
            <span>Loading vectors show feature directions</span>
          </div>
        </div>
      </Panel>
    );
  }

  // Waiting for analysis response
  if (!analysis) {
    return (
      <Panel title="Cross-Race Analysis">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>Analyzing selection...</div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Cross-Race Analysis">
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
            {selectionInfo && (
              <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                <span>{selectionInfo.count} race entries</span>
                <span>{selectionInfo.drivers.length} drivers</span>
                <span>{selectionInfo.years.length > 1 ? `${selectionInfo.years.length} seasons` : `${selectionInfo.years[0]} season`}</span>
              </div>
            )}
            {selectedTSNEPoints.length > 0 && (
              <button
                onClick={() => setSelectedTSNEPoints([])}
                style={{
                  marginTop: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 3, padding: '2px 8px', fontSize: '9px', color: 'rgba(255,255,255,0.5)',
                  cursor: 'pointer',
                }}
              >
                Clear selection
              </button>
            )}
          </div>

          {/* Strategy patterns */}
          {strategies.length > 0 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                Strategy Patterns
              </h6>
              {strategies.slice(0, 4).map((s, i) => {
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
                  cursor: canApply ? 'pointer' : 'default',
                  transition: 'background 0.15s, border-color 0.15s',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: isApplied ? '#22c55e' : i === 0 ? '#64C4FF' : 'var(--color-text-primary)' }}>
                      {s.count}× ({(s.frequency * 100).toFixed(0)}%)
                    </span>
                    <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                      {s.stints.length}-stop strategy
                    </span>
                    {canApply && (
                      <span style={{
                        marginLeft: 'auto', fontSize: '8px', fontWeight: 600,
                        color: isApplied ? '#22c55e' : 'rgba(100,196,255,0.6)',
                        padding: '1px 5px', borderRadius: 3,
                        background: isApplied ? 'rgba(34,197,94,0.1)' : 'rgba(100,196,255,0.08)',
                      }}>
                        {isApplied ? '✓ Applied' : 'Simulate →'}
                      </span>
                    )}
                  </div>
                  {/* Stint bar visualization */}
                  <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', gap: 1 }}>
                    {s.stints.map((stint, j) => {
                      const totalLaps = s.stints.reduce((sum, st) => sum + st.length, 0);
                      const pct = totalLaps > 0 ? (stint.length / totalLaps) * 100 : 100 / s.stints.length;
                      return (
                        <div key={j} style={{
                          width: `${pct}%`, minWidth: 16,
                          backgroundColor: TYRE_COLORS[stint.compound] || '#888',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '7px', fontWeight: 700, color: stint.compound === 'HARD' ? '#333' : '#000',
                        }}>
                          {stint.length}L
                        </div>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {/* Tyre compound patterns */}
          {commonPatterns.length > 0 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                Compound Usage
              </h6>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {commonPatterns.map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255,255,255,0.04)',
                    borderLeft: `3px solid ${TYRE_COLORS[p.compound] || '#888'}`,
                  }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: TYRE_COLORS[p.compound] || '#888' }}>
                      {p.compound}
                    </span>
                    <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                      {p.count} stints · avg {p.avg_stint_length?.toFixed(0) || '?'}L
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pit windows */}
          {pitWindows.length > 0 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                Common Pit Windows
              </h6>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {pitWindows.slice(0, 5).map((pw, i) => (
                  <div key={i}
                    onClick={() => setSelectedLapRange([pw.lap_start, pw.lap_end])}
                    title="Click to highlight this lap range across all views"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-xs)', cursor: 'pointer' }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontWeight: 700, fontSize: '9px',
                      backgroundColor: i === 0 ? 'rgba(100,196,255,0.15)' : 'rgba(255,255,255,0.06)',
                      color: i === 0 ? '#64C4FF' : 'var(--color-text-secondary)',
                    }}>
                      L{pw.lap_start}–L{pw.lap_end}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {pw.count} stops in this window
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Radar chart — feature profile */}
          {topFeatures.length >= 3 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                Cluster Feature Profile
              </h6>
              <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#22c55e' }} />
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>Higher in cluster</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#ef4444' }} />
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>Lower in cluster</span>
                </div>
              </div>
              <div ref={radarRef}><svg /></div>
            </div>
          )}

          {/* Feature importance bars */}
          {featureImportance.length > 0 && (
            <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                Feature Importance (Cohen's d)
              </h6>
              <div ref={barsRef}><svg /></div>
              <div style={{
                display: 'flex', gap: 8, fontSize: '7px', color: 'rgba(255,255,255,0.35)',
                borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6, marginTop: 6,
              }}>
                <span style={{ color: 'rgba(255,255,255,0.4)' }}>&lt;0.5 = small</span>
                <span style={{ color: 'rgba(255,165,0,0.7)' }}>0.5–0.8 = medium</span>
                <span style={{ color: 'rgba(225,6,0,0.7)' }}>&gt;0.8 = large</span>
              </div>
            </div>
          )}

          {/* Selected drivers breakdown */}
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
                    fontSize: 'var(--font-size-xs)', fontWeight: 600,
                    color: getDriverColor(d),
                    cursor: 'pointer',
                    outline: focusDriver === d ? `1px solid ${getDriverColor(d)}` : 'none',
                  }}>
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </Panel>
  );
}
