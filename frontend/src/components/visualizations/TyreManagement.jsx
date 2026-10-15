import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, TYRE_LABELS, tyreColor, tyreLetter, contrastText, markColor, textColor,
  TEXT_COLORS, GRID_COLORS, SURFACES, CHART_FONT, chartFontPx, UNKNOWN_TEAM_COLOR,
} from '../../utils/colors';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

const PIT_DASH = '2,3';
import { useSessionNow } from '../../hooks/useSessionNow';
import { stintsByDriver } from '../../utils/stints';
import { causalKey, driverCompletedLaps, groupLapsByStint } from '../../utils/strategyViews';
import Panel from '../ui/Panel';

export default function TyreManagement() {
  const svgRef = useRef(null);
  // The box the chart fills: it lays out again at each new size (D4)
  const box = useChartBox(svgRef);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  // Causal "now" (session seconds); the key changes only when a lap or a pit
  // event completes, so chartData is not rebuilt on every replay frame
  const sessionNow = useSessionNow();
  const causal = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  const driver = focusDriver || selectedDrivers[0] || null;
  const driverColor = driver ? getDriverColor(driver) : UNKNOWN_TEAM_COLOR;

  const chartData = useMemo(() => {
    if (!driver || lapTimes.length === 0) return { stints: [], maxLapNum: 1 };

    // Only laps completed at sessionNow: the lap in progress has no time yet
    const driverLaps = driverCompletedLaps(lapTimes, driver, sessionNow);

    if (driverLaps.length === 0) return { stints: [], maxLapNum: maxLap || 1 };

    // Group into stints from the FastF1 Stint column (utils/stints.js): one
    // stint per tyre set, a drive-through does not split it
    const driverStints = stintsByDriver(lapTimes, { sessionNow })[driver] || [];
    const stints = groupLapsByStint(driverLaps, driverStints).map(({ stint, laps }) => ({
      compound: stint.Compound,
      laps: laps.map((lap, i) => ({
        lapNumber: lap.LapNumber,
        lapTime: lap.LapTimeSeconds,
        tyreLife: lap.TyreLife || i + 1,
        compound: stint.Compound,
      })),
    }));

    // Compute pace retention per stint.
    //
    // Definition: 100% = the driver's *opening pace* on this stint
    //   (median of clean laps 2-4 — skipping cold lap 1 and any outliers).
    // Anything below 100% = pace lost vs that opening baseline,
    //   i.e. true pace decay over the stint.
    //
    // Why not "stint best": the previous implementation used the fastest
    // lap of the stint as 100%. That conflates *warm-up* with *degradation*:
    // an early slow lap looks like it has poor "retention" simply because
    // a faster lap exists later in the stint. Opening pace is what
    // strategists actually care about — "how much pace are you losing
    // compared to when these tyres were fresh?".
    stints.forEach((stint) => {
      const times = stint.laps.map((l) => l.lapTime);
      const median = d3.median(times);
      const threshold = median * 1.4;

      // Outlier-filtered laps for the baseline calculation.
      const cleanLaps = stint.laps.filter((l) => l.lapTime < threshold);

      // Baseline: median of laps 2-4 (after warm-up, before degradation).
      // Falls back to lap-1 if the stint is too short.
      const baselinePool = cleanLaps.slice(1, Math.min(4, cleanLaps.length));
      const baseline = baselinePool.length > 0
        ? d3.median(baselinePool, (l) => l.lapTime)
        : (cleanLaps[0]?.lapTime || median);

      stint.laps.forEach((lap) => {
        const isOutlier = lap.lapTime > threshold;
        lap.isOutlier = isOutlier;

        if (isOutlier) {
          lap.performance = null;
        } else {
          // raw = baseline / lap → if lap is slower than baseline, raw < 1.
          // capped at 100% so a faster-than-baseline lap (driver pushing
          // harder than the warmup average) doesn't read above 100%.
          const raw = (baseline / lap.lapTime) * 100;
          lap.performance = Math.min(100, raw);
        }
      });

      stint.startLap = stint.laps[0].lapNumber;
      stint.endLap = stint.laps[stint.laps.length - 1].lapNumber;
      stint.baseline = baseline;
    });

    const maxLapNum = maxLap || 1;
    // Pit stops (tyre changes) visible at sessionNow: the first lap of every
    // later stint. A stint exists from its pit exit (utils/stints.js), so the
    // PIT line appears at the pit exit, with the Strategy Timeline, before
    // the new set has a completed lap
    const pitLaps = driverStints.slice(1).map((s) => s.StartLap);
    return { stints, maxLapNum, pitLaps };
  }, [driver, lapTimes, maxLap, causal]);

  const driverBadge = driver ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: CHART_FONT.data, fontWeight: 800, fontFamily: "'Titillium Web', sans-serif",
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      <span style={{
        width: 3, height: 14, borderRadius: 1.5,
        background: markColor(driverColor), flexShrink: 0,
      }} />
      <span style={{ color: textColor(driverColor) }}>{driver}</span>
    </div>
  ) : null;

  useEffect(() => {
    if (!svgRef.current) return;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, { width: 600, height: 250 });
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
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data)
        .attr('font-family', "'Titillium Web', sans-serif")
        .text('Focus a driver to view pace retention');
      return;
    }

    const defs = svg.append('defs');
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Scales — auto-scale Y but with reasonable range
    const x = d3.scaleLinear().domain([1, chartData.maxLapNum]).range([0, innerW]);

    const allPerf = chartData.stints.flatMap((s) =>
      s.laps.filter((l) => l.performance != null).map((l) => l.performance)
    );
    const perfMin = Math.max(85, Math.floor((d3.min(allPerf) || 95) - 2));
    const y = d3.scaleLinear().domain([perfMin, 100]).range([innerH, 0]);

    // Grid
    const xTicks = x.ticks(Math.min(12, chartData.maxLapNum));
    g.selectAll('.grid-v').data(xTicks).enter().append('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d))
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', GRID_COLORS.grid);

    // X-axis
    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, chartData.maxLapNum)).tickFormat(d3.format('d')).tickSize(3));
    xAxisG.selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data).attr('font-family', 'var(--font-mono)');
    xAxisG.selectAll('line').attr('stroke', GRID_COLORS.axis);
    xAxisG.select('.domain').attr('stroke', GRID_COLORS.axis);

    g.append('text').attr('x', -4).attr('y', innerH + 20)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label).attr('font-weight', 700)
      .attr('font-family', "'Titillium Web', sans-serif").attr('text-anchor', 'end').text('LAP');

    // Y-axis
    const yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d.toFixed(0)}%`).tickSize(3));
    yAxisG.selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data).attr('font-family', 'var(--font-mono)');
    yAxisG.selectAll('line').attr('stroke', GRID_COLORS.axis);
    yAxisG.select('.domain').attr('stroke', GRID_COLORS.axis);
    // Y-axis label
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', 'rotate(-90)').attr('x', -innerH / 2).attr('y', -32)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 700).text('Pace Retention (%)');

    // Pit stop markers
    (chartData.pitLaps || []).forEach((pitLap) => {
      g.append('line')
        .attr('x1', x(pitLap)).attr('x2', x(pitLap))
        .attr('y1', 0).attr('y2', innerH)
        .attr('stroke', GRID_COLORS.rule).attr('stroke-width', 1).attr('stroke-dasharray', PIT_DASH);
      g.append('text')
        .attr('x', x(pitLap)).attr('y', -3)
        .attr('text-anchor', 'middle').attr('fill', TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.label).attr('font-weight', 700)
        .attr('font-family', 'var(--font-mono)')
        .text('PIT');
    });

    // Draw per-stint curves
    chartData.stints.forEach((stint, i) => {
      const validLaps = stint.laps.filter((l) => l.performance != null);
      if (validLaps.length < 2) return;

      // FIA compound colour as a mark (>= 3:1 on the panel)
      const compoundColor = markColor(tyreColor(stint.compound), SURFACES.panel);

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
        .attr('stroke-width', 1.8);
    });

    // Current lap marker
    if (currentLap > 1 && currentLap <= chartData.maxLapNum) {
      g.append('line')
        .attr('x1', x(currentLap)).attr('x2', x(currentLap))
        .attr('y1', 0).attr('y2', innerH)
        .attr('stroke', TEXT_COLORS.secondary).attr('stroke-width', 1.5);
      g.append('text').attr('x', x(currentLap)).attr('y', -3)
        .attr('text-anchor', 'middle').attr('fill', TEXT_COLORS.secondary)
        .style('font-size', CHART_FONT.label).attr('font-weight', 700)
        .attr('font-family', 'var(--font-mono)')
        .text(`L${currentLap}`);
    }

    // Stint compound bar
    const barY = innerH + 20;
    chartData.stints.forEach((stint) => {
      const compoundColor = tyreColor(stint.compound);
      const label = tyreLetter(stint.compound);
      const barX = x(stint.startLap);
      const barW = Math.max(4, x(stint.endLap) - x(stint.startLap));

      g.append('rect').attr('x', barX).attr('y', barY).attr('width', barW).attr('height', stintBarH)
        .attr('rx', 2).attr('fill', compoundColor).attr('opacity', 0.7);

      // compound badge: FIA colour + letter in contrastText
      const badgeR = Math.max(6, Math.ceil(chartFontPx('label') * 0.65));
      const badgeCx = barX + badgeR + 1;
      const badgeCy = barY + stintBarH / 2;
      g.append('circle').attr('cx', badgeCx).attr('cy', badgeCy).attr('r', badgeR)
        .attr('fill', compoundColor).attr('stroke', SURFACES.page).attr('stroke-width', 1);
      g.append('text').attr('x', badgeCx).attr('y', badgeCy)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
        .attr('fill', contrastText(compoundColor))
        .style('font-size', CHART_FONT.label).attr('font-weight', 900)
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

        const compColor = tyreColor(closest.compound);

        g.append('line').attr('class', 'hover-line')
          .attr('x1', x(closest.lapNumber)).attr('x2', x(closest.lapNumber))
          .attr('y1', 0).attr('y2', innerH)
          .attr('stroke', GRID_COLORS.rule).attr('stroke-width', 1).attr('stroke-dasharray', '3,3');

        g.append('circle').attr('class', 'hover-dot')
          .attr('cx', x(closest.lapNumber)).attr('cy', y(closest.performance)).attr('r', 4)
          .attr('fill', compColor).attr('stroke', TEXT_COLORS.primary).attr('stroke-width', 1.5);

        const tooltipHtml = `
          <div style="color:${textColor(driverColor, SURFACES.elevated)};font-weight:700;font-size:${CHART_FONT.data}">${driver}</div>
          <div style="font-size:${CHART_FONT.data};color:${TEXT_COLORS.muted}">Lap ${closest.lapNumber}</div>
          <div style="font-size:${CHART_FONT.data};font-weight:700">${closest.performance.toFixed(1)}%</div>
          <div style="font-size:${CHART_FONT.data};color:${textColor(compColor, SURFACES.elevated)}">${closest.compound} &mdash; L${closest.tyreLife}</div>
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

    return () => { d3.selectAll('.tyre-mgmt-tooltip').remove(); };
  }, [chartData, driver, driverColor, currentLap, box.width, box.height]);

  const tyreLegendItems = useMemo(() => {
    if (!chartData.stints.length) return [];
    const seen = new Set();
    return chartData.stints
      .filter((s) => { if (seen.has(s.compound)) return false; seen.add(s.compound); return true; })
      .map((s) => ({
        label: s.compound,
        color: tyreColor(s.compound),
        glyph: TYRE_LABELS[s.compound] || tyreLetter(s.compound),
        shape: 'badge',
      }));
  }, [chartData.stints]);

  // Legend (V4): compounds (line colour + badge letter), the current-lap
  // line and the pit stops
  const legendItems = tyreLegendItems.length ? [
    ...tyreLegendItems,
    { label: 'Current lap', color: TEXT_COLORS.secondary, shape: 'line' },
    { label: 'Pit', color: TEXT_COLORS.muted, shape: 'line', dash: PIT_DASH, strokeWidth: 1.5 },
  ] : [];

  return (
    <Panel title="Pace Retention" className="panel-tyre-management" controls={driverBadge}>
      {legendItems.length > 0 && (
        <div style={{ padding: '0 8px' }}>
          <Legend items={legendItems} />
        </div>
      )}
      <div className="viz-container tyre-management-chart">
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </Panel>
  );
}
