import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS } from '../../utils/colors';
import Panel from '../ui/Panel';

export default function StrategyBriefing() {
  const radarRef = useRef(null);
  const barsRef = useRef(null);
  const tsneStrategyAnalysis = useF1Store((s) => s.tsneStrategyAnalysis);
  const selectedTSNEPoints = useF1Store((s) => s.selectedTSNEPoints);

  const featureImportance = useMemo(
    () => tsneStrategyAnalysis?.feature_importance || [],
    [tsneStrategyAnalysis]
  );

  const topFeatures = useMemo(
    () => featureImportance.slice(0, 8),
    [featureImportance]
  );

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

    // Max effect size for scale
    const maxEffect = d3.max(topFeatures, (d) => d.effect_size) || 1;
    const rScale = d3.scaleLinear().domain([0, maxEffect]).range([0, radius]);

    // Grid circles
    [0.25, 0.5, 0.75, 1].forEach((level) => {
      g.append('circle')
        .attr('r', radius * level)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(255,255,255,0.08)')
        .attr('stroke-dasharray', '2,3');
    });

    // Axis lines
    topFeatures.forEach((_, i) => {
      const angle = angleSlice * i - Math.PI / 2;
      g.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', radius * Math.cos(angle))
        .attr('y2', radius * Math.sin(angle))
        .attr('stroke', 'rgba(255,255,255,0.1)');
    });

    // Feature labels
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
        .text(f.feature.replace(/_/g, ' ').replace(/avg |std /, ''));
    });

    // Radar polygon
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

    // Dots on vertices
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
    const xScale = d3.scaleLinear().domain([0, maxEffect]).range([0, width - 120]);

    const g = svg.append('g').attr('transform', 'translate(110, 4)');

    top6.forEach((f, i) => {
      const y = i * (barH + gap);
      const color = f.direction === 'higher' ? '#22c55e' : '#ef4444';

      // Label
      svg.append('text')
        .attr('x', 106).attr('y', y + barH / 2 + 4)
        .attr('text-anchor', 'end')
        .attr('fill', 'rgba(255,255,255,0.6)')
        .attr('font-size', '8px')
        .attr('font-weight', '600')
        .text(f.feature.replace(/_/g, ' '));

      // Bar
      g.append('rect')
        .attr('x', 0).attr('y', y)
        .attr('width', xScale(f.effect_size))
        .attr('height', barH)
        .attr('rx', 2)
        .attr('fill', color)
        .attr('opacity', 0.6);

      // Value
      g.append('text')
        .attr('x', xScale(f.effect_size) + 4).attr('y', y + barH / 2 + 1)
        .attr('fill', color)
        .attr('font-size', '8px')
        .attr('font-weight', '700')
        .attr('dominant-baseline', 'middle')
        .text(`${f.effect_size.toFixed(2)} ${f.direction === 'higher' ? '\u2191' : '\u2193'}`);
    });
  }, [featureImportance]);

  const strategies = tsneStrategyAnalysis?.strategies || [];
  const patterns = tsneStrategyAnalysis?.common_patterns || [];

  return (
    <Panel title="Strategy Briefing">
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
        {/* Summary */}
        <div style={{
          background: 'var(--color-bg-tertiary)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--spacing-sm)',
          fontSize: 'var(--font-size-xs)',
        }}>
          <strong>{selectedTSNEPoints.length}</strong> points selected
          {patterns.length > 0 && (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {' '}| avg stint: {patterns[0]?.avg_stint_length?.toFixed(0)} laps
            </span>
          )}
        </div>

        {/* Radar chart */}
        {topFeatures.length >= 3 && (
          <div style={{
            background: 'var(--color-bg-tertiary)',
            borderRadius: 'var(--radius-md)',
            padding: '8px',
          }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase' }}>
              Feature Profile
            </div>
            <div ref={radarRef}>
              <svg />
            </div>
          </div>
        )}

        {/* Feature importance bars */}
        {featureImportance.length > 0 && (
          <div style={{
            background: 'var(--color-bg-tertiary)',
            borderRadius: 'var(--radius-md)',
            padding: '8px',
          }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase' }}>
              Feature Importance (Effect Size)
            </div>
            <div ref={barsRef}>
              <svg />
            </div>
          </div>
        )}

        {/* Mini strategy timelines */}
        {strategies.length > 0 && (
          <div style={{
            background: 'var(--color-bg-tertiary)',
            borderRadius: 'var(--radius-md)',
            padding: '8px',
          }}>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase' }}>
              Common Strategies
            </div>
            {strategies.map((strat, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 'var(--font-size-xs)', marginBottom: 4,
              }}>
                <span style={{ color: 'var(--color-text-muted)', width: 18, fontSize: '9px' }}>#{i + 1}</span>
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
                <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto', fontSize: '9px' }}>
                  {(strat.frequency * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
