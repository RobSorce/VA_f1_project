import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, TYRE_LABELS } from '../../utils/colors';
import Panel from '../ui/Panel';

export default function TyreManagement() {
  const svgRef = useRef(null);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const driver = focusDriver || selectedDrivers[0] || null;
  const driverColor = driver ? getDriverColor(driver) : '#888';

  const chartData = useMemo(() => {
    if (!driver || lapTimes.length === 0) return { stints: [], maxLapNum: 1 };

    const driverLaps = lapTimes
      .filter((d) => d.Driver === driver && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber);

    if (driverLaps.length === 0) return { stints: [], maxLapNum: 1 };

    // Group into stints
    const stints = [];
    let current = { compound: driverLaps[0].Compound || 'UNKNOWN', laps: [] };

    driverLaps.forEach((lap) => {
      const compound = lap.Compound || 'UNKNOWN';
      if (compound !== current.compound || (lap.TyreLife != null && lap.TyreLife <= 1 && current.laps.length > 0)) {
        if (current.laps.length > 0) stints.push(current);
        current = { compound, laps: [] };
      }
      current.laps.push({
        lapNumber: lap.LapNumber,
        lapTime: lap.LapTimeSeconds,
        tyreLife: lap.TyreLife || current.laps.length + 1,
        compound,
      });
    });
    if (current.laps.length > 0) stints.push(current);

    // Compute pace retention per stint (bestTime / lapTime * 100)
    stints.forEach((stint) => {
      const times = stint.laps.map((l) => l.lapTime);
      const median = d3.median(times);
      const threshold = median * 1.5;
      const validTimes = stint.laps.filter((l) => l.lapTime < threshold);
      const bestTime = d3.min(validTimes, (l) => l.lapTime);

      let peakIdx = 0;
      stint.laps.forEach((lap, i) => {
        if (lap.lapTime === bestTime && lap.lapTime < threshold) peakIdx = i;
      });

      let ceiling = 100;
      stint.laps.forEach((lap, i) => {
        const isOutlier = lap.lapTime > threshold;
        lap.isOutlier = isOutlier;

        if (isOutlier) {
          lap.performance = null;
        } else if (i <= peakIdx) {
          lap.performance = 100;
        } else {
          const raw = (bestTime / lap.lapTime) * 100;
          lap.performance = Math.min(ceiling, raw);
          ceiling = lap.performance;
        }
      });

      stint.startLap = stint.laps[0].lapNumber;
      stint.endLap = stint.laps[stint.laps.length - 1].lapNumber;
    });

    const maxLapNum = Math.max(maxLap || 1, d3.max(driverLaps, (d) => d.LapNumber) || 1);
    return { stints, maxLapNum };
  }, [driver, lapTimes, maxLap]);

  const driverBadge = driver ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 800, fontFamily: "'Titillium Web', sans-serif",
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      <span style={{
        width: 3, height: 14, borderRadius: 1.5,
        background: driverColor, flexShrink: 0,
      }} />
      <span style={{ color: driverColor }}>{driver}</span>
    </div>
  ) : null;

  useEffect(() => {
    if (!svgRef.current) return;

    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 600;
    const height = rect.height || 250;
    const margin = { top: 12, right: 16, bottom: 30, left: 40 };
    const stintBarH = 14;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom - stintBarH;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    if (!driver || chartData.stints.length === 0) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', 12)
        .attr('font-family', "'Titillium Web', sans-serif")
        .text('Focus a driver to view pace retention');
      return;
    }

    const defs = svg.append('defs');
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Scales
    const x = d3.scaleLinear().domain([1, chartData.maxLapNum]).range([0, innerW]);

    const allPerf = chartData.stints.flatMap((s) =>
      s.laps.filter((l) => l.performance != null).map((l) => l.performance)
    );
    const perfMin = Math.max(90, (d3.min(allPerf) || 95) - 2);
    const y = d3.scaleLinear().domain([perfMin, 100]).range([innerH, 0]);

    // Grid
    const xTicks = x.ticks(Math.min(12, chartData.maxLapNum));
    g.selectAll('.grid-v').data(xTicks).enter().append('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d))
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', 'rgba(255,255,255,0.04)');

    // X-axis
    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, chartData.maxLapNum)).tickFormat(d3.format('d')).tickSize(3));
    xAxisG.selectAll('text').attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '9px').attr('font-family', 'var(--font-mono)');
    xAxisG.selectAll('line').attr('stroke', 'rgba(255,255,255,0.15)');
    xAxisG.select('.domain').attr('stroke', 'rgba(255,255,255,0.1)');

    g.append('text').attr('x', -4).attr('y', innerH + 20)
      .attr('fill', 'rgba(255,255,255,0.3)').attr('font-size', '8px').attr('font-weight', 700)
      .attr('font-family', "'Titillium Web', sans-serif").attr('text-anchor', 'end').text('LAP');

    // Y-axis
    const yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d.toFixed(0)}%`).tickSize(3));
    yAxisG.selectAll('text').attr('fill', 'rgba(255,255,255,0.3)').attr('font-size', '8px').attr('font-family', 'var(--font-mono)');
    yAxisG.selectAll('line').attr('stroke', 'rgba(255,255,255,0.1)');
    yAxisG.select('.domain').attr('stroke', 'rgba(255,255,255,0.08)');

    // Draw per-stint curves
    chartData.stints.forEach((stint, i) => {
      const validLaps = stint.laps.filter((l) => l.performance != null);
      if (validLaps.length < 2) return;

      const compoundColor = TYRE_COLORS[stint.compound] || '#888';

      const gradId = `mgmt-grad-${i}`;
      const grad = defs.append('linearGradient').attr('id', gradId)
        .attr('x1', '0%').attr('y1', '0%').attr('x2', '0%').attr('y2', '100%');
      grad.append('stop').attr('offset', '0%').attr('stop-color', compoundColor).attr('stop-opacity', 0.18);
      grad.append('stop').attr('offset', '100%').attr('stop-color', compoundColor).attr('stop-opacity', 0.02);

      const area = d3.area()
        .x((d) => x(d.lapNumber)).y0(innerH).y1((d) => y(d.performance))
        .curve(d3.curveMonotoneX);

      g.append('path').datum(validLaps).attr('d', area).attr('fill', `url(#${gradId})`);

      const line = d3.line()
        .x((d) => x(d.lapNumber)).y((d) => y(d.performance))
        .curve(d3.curveMonotoneX);

      g.append('path').datum(validLaps).attr('d', line)
        .attr('fill', 'none').attr('stroke', compoundColor)
        .attr('stroke-width', 1.8).attr('opacity', 0.85);
    });

    // Current lap marker
    if (currentLap > 1 && currentLap <= chartData.maxLapNum) {
      g.append('line')
        .attr('x1', x(currentLap)).attr('x2', x(currentLap))
        .attr('y1', 0).attr('y2', innerH)
        .attr('stroke', '#00e5ff').attr('stroke-width', 1.5).attr('opacity', 0.7);
      g.append('text').attr('x', x(currentLap)).attr('y', -3)
        .attr('text-anchor', 'middle').attr('fill', '#00e5ff')
        .attr('font-size', '8px').attr('font-weight', 700)
        .attr('font-family', 'var(--font-mono)').attr('opacity', 0.8)
        .text(`L${currentLap}`);
    }

    // Stint compound bar
    const barY = innerH + 20;
    chartData.stints.forEach((stint) => {
      const compoundColor = TYRE_COLORS[stint.compound] || '#888';
      const label = TYRE_LABELS[stint.compound] || '?';
      const barX = x(stint.startLap);
      const barW = Math.max(4, x(stint.endLap) - x(stint.startLap));

      g.append('rect').attr('x', barX).attr('y', barY).attr('width', barW).attr('height', stintBarH)
        .attr('rx', 2).attr('fill', compoundColor).attr('opacity', 0.7);

      const badgeCx = barX + 7;
      const badgeCy = barY + stintBarH / 2;
      g.append('circle').attr('cx', badgeCx).attr('cy', badgeCy).attr('r', 6)
        .attr('fill', compoundColor).attr('stroke', 'rgba(0,0,0,0.6)').attr('stroke-width', 1);
      g.append('text').attr('x', badgeCx).attr('y', badgeCy)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
        .attr('fill', stint.compound === 'MEDIUM' || stint.compound === 'HARD' ? '#000' : '#fff')
        .attr('font-size', '8px').attr('font-weight', 900)
        .attr('font-family', "'Titillium Web', sans-serif").text(label);
    });

    // Tooltip interaction
    g.append('rect').attr('width', innerW).attr('height', innerH)
      .attr('fill', 'transparent').attr('cursor', 'crosshair')
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event);
        const hoveredLap = Math.round(x.invert(mx));

        let closest = null;
        let minDist = Infinity;
        chartData.stints.forEach((stint) => {
          stint.laps.forEach((lap) => {
            if (lap.performance == null) return;
            const dist = Math.abs(lap.lapNumber - hoveredLap);
            if (dist < minDist) { minDist = dist; closest = { ...lap, compound: stint.compound }; }
          });
        });

        g.selectAll('.hover-line, .hover-dot').remove();
        d3.select('.tyre-mgmt-tooltip').classed('visible', false).style('opacity', 0);

        if (!closest || minDist > 2) return;

        const compColor = TYRE_COLORS[closest.compound] || '#888';

        g.append('line').attr('class', 'hover-line')
          .attr('x1', x(closest.lapNumber)).attr('x2', x(closest.lapNumber))
          .attr('y1', 0).attr('y2', innerH)
          .attr('stroke', 'rgba(255,255,255,0.15)').attr('stroke-width', 1).attr('stroke-dasharray', '3,3');

        g.append('circle').attr('class', 'hover-dot')
          .attr('cx', x(closest.lapNumber)).attr('cy', y(closest.performance)).attr('r', 4)
          .attr('fill', compColor).attr('stroke', '#fff').attr('stroke-width', 1.5);

        const tooltipHtml = `
          <div style="color:${driverColor};font-weight:700;font-size:11px">${driver}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.5)">Lap ${closest.lapNumber}</div>
          <div style="font-size:11px;font-weight:700">${closest.performance.toFixed(1)}%</div>
          <div style="font-size:9px;color:${compColor}">${closest.compound} &mdash; L${closest.tyreLife}</div>
        `;
        let tooltip = d3.select('.tyre-mgmt-tooltip');
        if (!tooltip.size()) {
          tooltip = d3.select('body').append('div').attr('class', 'tooltip tyre-mgmt-tooltip');
        }
        tooltip.html(tooltipHtml)
          .style('left', event.pageX + 14 + 'px').style('top', event.pageY - 14 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', () => {
        g.selectAll('.hover-line, .hover-dot').remove();
        d3.select('.tyre-mgmt-tooltip').classed('visible', false).style('opacity', 0);
      });
  }, [chartData, driver, driverColor, currentLap]);

  return (
    <Panel title="Pace Retention" className="panel-tyre-management" controls={driverBadge}>
      <div className="viz-container tyre-management-chart">
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </Panel>
  );
}
