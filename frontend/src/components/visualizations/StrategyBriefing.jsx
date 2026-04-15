import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';

// Feature name → display label (fallback if backend doesn't provide it)
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
  gap_to_leader_mean: 'Gap to Leader',
  rolling_pace_3: 'Last 3 Pace',
  rolling_pace_5: 'Last 5 Pace',
  track_temp: 'Track Temp',
  air_temp: 'Air Temp',
};

function featureLabel(fi) {
  return fi.label || FEATURE_DISPLAY[fi.feature] || fi.feature.replace(/_/g, ' ');
}

function magnitudeLabel(effectSize) {
  if (effectSize >= 0.8) return 'large';
  if (effectSize >= 0.5) return 'medium';
  return 'small';
}

function magnitudeColor(effectSize) {
  if (effectSize >= 0.8) return 'rgba(225,6,0,0.9)';
  if (effectSize >= 0.5) return 'rgba(255,165,0,0.9)';
  return 'rgba(255,255,255,0.4)';
}

export default function StrategyBriefing() {
  const radarRef = useRef(null);
  const barsRef = useRef(null);
  const pcaStrategyAnalysis = useF1Store((s) => s.pcaStrategyAnalysis);

  const featureImportance = useMemo(
    () => pcaStrategyAnalysis?.feature_importance || [],
    [pcaStrategyAnalysis]
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

    // Grid circles with labels
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
        .text(featureLabel(f));
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
    const xScale = d3.scaleLinear().domain([0, maxEffect]).range([0, width - 130]);

    const g = svg.append('g').attr('transform', 'translate(120, 4)');

    top6.forEach((f, i) => {
      const y = i * (barH + gap);
      const color = f.direction === 'higher' ? '#22c55e' : '#ef4444';

      // Label
      svg.append('text')
        .attr('x', 116).attr('y', y + barH / 2 + 4)
        .attr('text-anchor', 'end')
        .attr('fill', 'rgba(255,255,255,0.6)')
        .attr('font-size', '8px')
        .attr('font-weight', '600')
        .text(featureLabel(f));

      // Bar
      g.append('rect')
        .attr('x', 0).attr('y', y)
        .attr('width', xScale(f.effect_size))
        .attr('height', barH)
        .attr('rx', 2)
        .attr('fill', color)
        .attr('opacity', 0.6);

      // Value + magnitude
      const mag = f.magnitude || magnitudeLabel(f.effect_size);
      g.append('text')
        .attr('x', xScale(f.effect_size) + 4).attr('y', y + barH / 2 + 1)
        .attr('fill', color)
        .attr('font-size', '8px')
        .attr('font-weight', '700')
        .attr('dominant-baseline', 'middle')
        .text(`${f.effect_size.toFixed(2)} ${f.direction === 'higher' ? '\u2191' : '\u2193'} ${mag}`);
    });
  }, [featureImportance]);

  if (!pcaStrategyAnalysis?.feature_importance?.length) return null;

  return (
    <div style={{
      background: 'var(--color-bg-tertiary)',
      borderRadius: 'var(--radius-md)',
      padding: '8px',
    }}>
      {/* Section header */}
      <div style={{
        fontSize: '9px', fontWeight: 700, color: 'var(--color-text-secondary)',
        marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        How This Cluster Differs (Cohen's d)
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#22c55e' }} />
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>Higher in cluster</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#ef4444' }} />
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>Lower in cluster</span>
        </div>
      </div>

      {/* Radar chart */}
      {topFeatures.length >= 3 && (
        <div style={{ marginBottom: 8 }}>
          <div ref={radarRef}>
            <svg />
          </div>
        </div>
      )}

      {/* Feature importance bars */}
      {featureImportance.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: '9px', fontWeight: 700, color: 'var(--color-text-secondary)',
            marginBottom: 4, textTransform: 'uppercase',
          }}>
            Feature Importance
          </div>
          <div ref={barsRef}>
            <svg />
          </div>
        </div>
      )}

      {/* Magnitude scale legend */}
      <div style={{
        display: 'flex', gap: 8, fontSize: '7px', color: 'rgba(255,255,255,0.35)',
        borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6,
      }}>
        <span>Effect size: </span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>&lt;0.5 = small</span>
        <span style={{ color: 'rgba(255,165,0,0.7)' }}>0.5–0.8 = medium</span>
        <span style={{ color: 'rgba(225,6,0,0.7)' }}>&gt;0.8 = large</span>
      </div>
    </div>
  );
}
