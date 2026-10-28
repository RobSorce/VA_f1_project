import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store, sessionScopeOf, telemetryKeySuffix } from '../../store/useF1Store';
import {
  getDriverColor, TYRE_LABELS, tyreColor, tyreLetter, markColor, textColor, deltaColor, signedDelta,
  TEXT_COLORS, GRID_COLORS, SURFACES, CHART_FONT, UNKNOWN_TEAM_COLOR, chartFontPx,
} from '../../utils/colors';

// Dash of a stint's fit line (legend and line)
const FIT_DASH = '6,3';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey, fittedLapRange } from '../../utils/strategyViews';
import { FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS } from '../../utils/degradation';
import {
  tyreDegradationView, formatSlope, FUEL_NOTE, FIT_NOTE, placeSlopeLabels, monoLabelBox,
  MONO_ASCENT_EM, MONO_DESCENT_EM,
} from '../../utils/views/degradationViews';
import { driverStateAt, nonFinisherMap } from '../../utils/driverState';
import { focusForecast } from '../../utils/forecast';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

export default function TireDegradation() {
  const svgRef = useRef(null);
  // The box the chart fills (.deg-plot, the svg's parent): it lays out again
  // at each new size (D4)
  const box = useChartBox(svgRef);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const degradationRegression = useF1Store((s) => s.degradationRegression);
  const fetchDegradationRegression = useF1Store((s) => s.fetchDegradationRegression);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const brushLapRange = useF1Store((s) => s.brushLapRange);
  // The session on screen (year, round, type; 'live' for a live feed): a
  // new session re-asks the brushed fit. The store sends that session's
  // identity and the clock (session_now), never the year / round pills.
  const sessionKey = useF1Store((s) => telemetryKeySuffix(sessionScopeOf(s)) || (s.isLiveMode ? 'live' : ''));

  // Auto-trigger degradation regression when a lap range is selected via
  // visual interaction. Debounced + min-width guarded so dragging the
  // bottom-bar brush doesn't spam the backend with hundreds of requests
  // (each mousemove updates selectedLapRange) — only the *settled* range
  // after 250 ms of no further changes fires the request, and the
  // backend's "Insufficient data" 422 is avoided by requiring ≥ 5 laps
  // up front (least-squares on < 5 points is meaningless anyway).
  const activeRange = brushLapRange || selectedLapRange;
  useEffect(() => {
    const driver = focusDriver || selectedDrivers[0];
    if (!activeRange || !driver || !sessionKey) return;
    const [lo, hi] = activeRange;
    if (typeof lo !== 'number' || typeof hi !== 'number' || hi - lo < 4) return;
    const t = setTimeout(() => {
      fetchDegradationRegression({
        drivers: [driver],
        lap_start: lo,
        lap_end: hi,
      });
    }, 250);
    return () => clearTimeout(t);
  }, [activeRange, focusDriver, selectedDrivers, sessionKey, fetchDegradationRegression]);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  // Causal "now" (session seconds); the key changes only when a lap or a pit
  // event completes, so chartData is not rebuilt on every replay frame
  const sessionNow = useSessionNow();
  const causal = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);

  // Pick driver: focusDriver → first selectedDriver → null
  const driver = focusDriver || selectedDrivers[0] || null;
  const driverColor = driver ? getDriverColor(driver) : UNKNOWN_TEAM_COLOR;

  // Has the focused driver retired by sessionNow? Only once the final lap row
  // has ended (or, for a retirement in the pits, the car entered the pits):
  // utils/driverState.js, never from the leader's lap number. Results DNFs
  // and classified drivers who stopped before the flag (nonFinisherMap; live:
  // the feed's retirements only).
  const driverDnf = driver ? (nonFinisherMap(lapTimes, dnfMap, { live: isLiveMode })[driver] || null) : null;
  const isDriverRetired = useMemo(
    () => (driver && driverDnf
      ? driverStateAt(lapTimes, driver, sessionNow, { dnf: driverDnf }).retired
      : false),
    [lapTimes, driver, driverDnf, causal],
  );

  // Per-stint scatter and fit from the shared degradation definition
  // (utils/degradation.js via tyreDegradationView): stints of utils/stints.js
  // (a same-compound stop opens a new stint), clean laps only in the fit
  // (lap 1, pit in/out laps, non-green laps and slow outliers left out), fit
  // of the fuel-corrected time on TyreLife, null below MIN_FIT_LAPS laps.
  // The brush restricts the laps to the brushed window; when the driver has
  // too few completed laps in it (the replay has not reached it yet) the
  // whole race is drawn and the banner still reports the brushed range.
  // sessionNow enters through causal, which changes whenever the laps do.
  const chartData = useMemo(
    () => tyreDegradationView(lapTimes, driver, { sessionNow, lapRange: activeRange }),
    [driver, lapTimes, causal, activeRange],
  );

  // Pit window info
  const pitWindow = useMemo(() => {
    if (degradationRegression?.undercut_window) {
      return degradationRegression.undercut_window;
    }
    // The forecast of the driver shown, if it is the one asked (utils/forecast.js)
    const pit = focusForecast(lstmPredictions, driver)?.optimal_pit_lap;
    if (Number.isFinite(pit)) {
      return [Math.max(1, pit - 3), pit + 3];
    }
    return null;
  }, [degradationRegression, lstmPredictions, driver]);

  // Driver badge for panel header
  const driverBadge = driver ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: CHART_FONT.data, fontWeight: 800, fontFamily: 'var(--font-primary)',
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      <span style={{
        width: 3, height: 14, borderRadius: 1.5,
        background: markColor(driverColor), flexShrink: 0,
      }} />
      <span style={{ color: textColor(driverColor) }}>{driver}</span>
    </div>
  ) : null;

  // Legend (V4): the compounds of the stints shown (FIA colour + the letter
  // the stint labels carry), the clean / excluded laps and the fit line
  const legendItems = useMemo(() => {
    const compounds = new Set();
    chartData.stints.forEach((s) => compounds.add(s.compound));
    const items = [...compounds].map((c) => ({
      label: c,
      color: tyreColor(c),
      glyph: TYRE_LABELS[c] || tyreLetter(c),
      shape: 'badge',
    }));
    if (items.length) {
      items.push(
        { label: 'Clean lap', color: TEXT_COLORS.secondary, shape: 'circle' },
        { label: 'Not fitted', color: TEXT_COLORS.muted, glyph: '○', shape: 'glyph' },
        { label: 'Fit', color: TEXT_COLORS.secondary, shape: 'line', dash: FIT_DASH },
      );
    }
    return items;
  }, [chartData]);

  // D3 rendering — scatter plot with regression lines
  useEffect(() => {
    if (!svgRef.current) return;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, { width: 600, height: 250 });
    const margin = { top: 12, right: 16, bottom: 30, left: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    // No driver state
    if (!driver || chartData.stints.length === 0) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data)
        .attr('font-family', 'var(--font-primary)')
        .text('Focus a driver to view tyre degradation');
      return;
    }

    // Check we have data
    const hasData = chartData.stints.some((s) => s.cleanLaps.length >= 2);
    if (!hasData) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data)
        .attr('font-family', 'var(--font-primary)')
        .text('Not enough lap data for degradation analysis');
      return;
    }

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Compute global max tyre life across stints
    let maxTyreLife = 1;
    chartData.stints.forEach((s) => {
      s.cleanLaps.forEach((l) => {
        if (l.tyreLife > maxTyreLife) maxTyreLife = l.tyreLife;
      });
    });

    // Scales
    const x = d3.scaleLinear()
      .domain([0, maxTyreLife + 1])
      .range([0, innerW]);

    const yPad = (chartData.yExtent[1] - chartData.yExtent[0]) * 0.12 || 1;
    const y = d3.scaleLinear()
      .domain([chartData.yExtent[0] - yPad, chartData.yExtent[1] + yPad])
      .range([innerH, 0]);

    // Grid lines
    const xTicks = x.ticks(Math.min(12, maxTyreLife));
    g.selectAll('.grid-v')
      .data(xTicks)
      .enter()
      .append('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d))
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', GRID_COLORS.grid)
      .attr('stroke-width', 1);

    const yTicks = y.ticks(5);
    g.selectAll('.grid-h')
      .data(yTicks)
      .enter()
      .append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', (d) => y(d)).attr('y2', (d) => y(d))
      .attr('stroke', GRID_COLORS.grid)
      .attr('stroke-width', 1);

    // X-axis
    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, maxTyreLife)).tickFormat(d3.format('d')).tickSize(3));

    xAxisG.selectAll('text')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.data)
      .attr('font-family', 'var(--font-mono)');
    xAxisG.selectAll('line').attr('stroke', GRID_COLORS.axis);
    xAxisG.select('.domain').attr('stroke', GRID_COLORS.axis);

    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 24)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label)
      .attr('font-weight', 700)
      .attr('font-family', 'var(--font-primary)')
      .text('Tyre life (laps)');

    // Y-axis — format as m:ss.sss
    const formatLapTime = (sec) => {
      const m = Math.floor(sec / 60);
      const s = (sec % 60).toFixed(1).padStart(4, '0');
      return `${m}:${s}`;
    };
    const yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(formatLapTime).tickSize(3));

    yAxisG.selectAll('text')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.data)
      .attr('font-family', 'var(--font-mono)');
    yAxisG.selectAll('line').attr('stroke', GRID_COLORS.axis);
    yAxisG.select('.domain').attr('stroke', GRID_COLORS.axis);

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2).attr('y', -42)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label)
      .attr('font-weight', 700)
      .attr('font-family', 'var(--font-primary)')
      .text('Lap time');

    // Draw each stint: scatter points + regression line; the stint labels
    // and the slope labels after, placed inside the plot
    const fontPx = chartFontPx('data');
    const stintLabels = [];
    const slopeItems = [];
    chartData.stints.forEach((stint) => {
      if (stint.cleanLaps.length < 2) return;
      // FIA compound colour (marks >= 3:1 on the panel); its text >= 4.5:1
      const compoundColor = markColor(tyreColor(stint.compound), SURFACES.panel);
      const compoundText = textColor(tyreColor(stint.compound), SURFACES.panel);

      // Scatter points (clean laps)
      g.selectAll(`.dot-stint-${stint.stintIndex}`)
        .data(stint.cleanLaps)
        .enter()
        .append('circle')
        .attr('cx', (d) => x(d.tyreLife))
        .attr('cy', (d) => y(d.lapTime))
        .attr('r', 3)
        .attr('fill', compoundColor)
        .attr('opacity', 0.9)
        .attr('stroke', SURFACES.page)
        .attr('stroke-width', 0.5);

      // Laps left out of the fit (lap 1, pit in/out, non-green, slow
      // outliers) — small hollow circles
      const outliers = stint.excludedLaps.filter((l) => l.lapTime <= chartData.yExtent[1] + yPad);
      g.selectAll(`.outlier-stint-${stint.stintIndex}`)
        .data(outliers)
        .enter()
        .append('circle')
        .attr('cx', (d) => x(d.tyreLife))
        .attr('cy', (d) => y(d.lapTime))
        .attr('r', 2.5)
        .attr('fill', 'none')
        .attr('stroke', TEXT_COLORS.muted)
        .attr('stroke-width', 1);

      // Fit line, drawn in raw lap time (fitLapTime: the fitted
      // fuel-corrected time with the fuel correction taken back out)
      if (stint.fit && stint.line) {
        const { tyreMin, tyreMax, y1, y2 } = stint.line;

        g.append('line')
          .attr('class', 'deg-fit-line')
          .attr('data-stint', stint.stintNumber)
          .attr('x1', x(tyreMin))
          .attr('y1', y(y1))
          .attr('x2', x(tyreMax))
          .attr('y2', y(y2))
          .attr('stroke', compoundColor)
          .attr('stroke-width', 1.8)
          .attr('stroke-dasharray', FIT_DASH);

        // Slope annotation at the end of the fit line: the degradation of
        // the shared definition (fuel-corrected slope, fuel effect an assumed
        // constant, FUEL_NOTE under the chart) and the raw slope, which
        // includes the fuel burn (often negative on low-degradation tracks)
        slopeItems.push({
          key: String(stint.stintNumber),
          x: x(tyreMax),
          y: y(y2),
          lines: [`${formatSlope(stint.fit.slope)} s/lap (fuel-corr.*)`, `${formatSlope(stint.fit.rawSlope)} s/lap (raw)`],
          // the stint's name, leading the block when it has to go far from its line
          tag: `S${stint.stintNumber} ${tyreLetter(stint.compound)}`,
          color: compoundText,
        });
      }

      // Stint label at first point (and why a stint has no line), kept
      // inside the plot
      const first = stint.cleanLaps[0];
      // the compound letter with the stint: the cue of the FIA colour
      const label = stint.fit
        ? `S${stint.stintNumber} ${tyreLetter(stint.compound)}`
        : `S${stint.stintNumber} ${tyreLetter(stint.compound)} no fit (${stint.cleanCount} < ${MIN_FIT_LAPS} clean laps)`;
      const w = monoLabelBox(label, 0, 0, fontPx).x1;
      const lx = Math.max(0, Math.min(innerW - w, x(first.tyreLife) - 2));
      const ly = Math.max(MONO_ASCENT_EM * fontPx, Math.min(innerH - MONO_DESCENT_EM * fontPx, y(first.lapTime) - 8));
      stintLabels.push(monoLabelBox(label, lx, ly, fontPx));
      g.append('text')
        .attr('x', lx)
        .attr('y', ly)
        .attr('fill', compoundText)
        .style('font-size', CHART_FONT.data)
        .attr('font-weight', 700)
        .attr('font-family', 'var(--font-mono)')
        .text(label);
    });

    // The slope labels: inside the plot, the two lines one under the other,
    // over no stint label and no other stint's slopes, led by the stint's tag
    // when placed far from the line's end (placeSlopeLabels)
    const placed = placeSlopeLabels(slopeItems, {
      width: innerW, height: innerH, fontPx, obstacles: stintLabels,
    });
    for (const p of placed) {
      const item = slopeItems.find((it) => it.key === p.key);
      p.lines.forEach((line, i) => {
        g.append('text')
          .attr('class', 'deg-slope-label')
          .attr('data-stint', p.key)
          .attr('x', p.x)
          .attr('y', line.y)
          .attr('fill', i === 0 ? item.color : TEXT_COLORS.muted)
          .style('font-size', CHART_FONT.data)
          .attr('font-weight', i === 0 ? 700 : 600)
          .attr('font-family', 'var(--font-mono)')
          .text(line.text);
      });
    }

    // Tooltip on hover
    g.append('rect')
      .attr('width', innerW).attr('height', innerH)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mousemove', (event) => {
        const [mx, my] = d3.pointer(event);
        const hoveredTyreLife = x.invert(mx);
        const hoveredLapTime = y.invert(my);

        // Find closest clean data point across all stints
        let closest = null;
        let closestStint = null;
        let minDist = Infinity;
        chartData.stints.forEach((stint) => {
          stint.cleanLaps.forEach((d) => {
            // Normalize distance across both axes
            const dx = (d.tyreLife - hoveredTyreLife) / (maxTyreLife || 1);
            const dy = (d.lapTime - hoveredLapTime) / ((chartData.yExtent[1] - chartData.yExtent[0]) || 1);
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) { minDist = dist; closest = d; closestStint = stint; }
          });
        });

        g.selectAll('.hover-line-v, .hover-line-h, .hover-dot').remove();
        d3.select('.deg-tooltip').classed('visible', false).style('opacity', 0);

        if (!closest || minDist > 0.15) return;

        const compColor = tyreColor(closestStint.compound);

        // Crosshair
        g.append('line')
          .attr('class', 'hover-line-v')
          .attr('x1', x(closest.tyreLife)).attr('x2', x(closest.tyreLife))
          .attr('y1', 0).attr('y2', innerH)
          .attr('stroke', GRID_COLORS.rule)
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3');
        g.append('line')
          .attr('class', 'hover-line-h')
          .attr('x1', 0).attr('x2', innerW)
          .attr('y1', y(closest.lapTime)).attr('y2', y(closest.lapTime))
          .attr('stroke', GRID_COLORS.axis)
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3');

        g.append('circle')
          .attr('class', 'hover-dot')
          .attr('cx', x(closest.tyreLife))
          .attr('cy', y(closest.lapTime))
          .attr('r', 4.5)
          .attr('fill', compColor)
          .attr('stroke', TEXT_COLORS.primary)
          .attr('stroke-width', 1.5);

        // Tooltip content
        const fit = closestStint.fit;
        const slopeText = fit
          ? `${formatSlope(fit.slope)} s/lap fuel-corr. (raw ${formatSlope(fit.rawSlope)}) · ${fit.n} laps`
          : `no fit (${closestStint.cleanCount} < ${MIN_FIT_LAPS} clean laps)`;
        const tooltipHtml = `
          <div style="color:${textColor(driverColor, SURFACES.elevated)};font-weight:700;font-size:${CHART_FONT.data}">${driver}</div>
          <div style="font-size:${CHART_FONT.data};color:${TEXT_COLORS.muted}">Lap ${closest.lapNumber} · tyre lap ${closest.tyreLife}</div>
          <div style="font-size:12px;font-weight:700">${Math.floor(closest.lapTime / 60)}:${(closest.lapTime % 60).toFixed(3).padStart(6, '0')}</div>
          <div style="font-size:${CHART_FONT.data};color:${textColor(compColor, SURFACES.elevated)}">${closestStint.compound} — S${closestStint.stintNumber}</div>
          <div style="font-size:${CHART_FONT.data};color:${TEXT_COLORS.muted}">Deg: ${slopeText}</div>
        `;
        let tooltip = d3.select('.deg-tooltip');
        if (!tooltip.size()) {
          tooltip = d3.select('body').append('div').attr('class', 'tooltip deg-tooltip');
        }
        tooltip
          .html(tooltipHtml)
          .style('left', event.pageX + 14 + 'px')
          .style('top', event.pageY - 14 + 'px')
          .classed('visible', true)
          .style('opacity', 1);
      })
      .on('mouseleave', () => {
        g.selectAll('.hover-line-v, .hover-line-h, .hover-dot').remove();
        d3.select('.deg-tooltip').classed('visible', false).style('opacity', 0);
      });

    return () => {
      d3.select('body').select('.deg-tooltip').remove();
    };
  }, [chartData, driver, driverColor, currentLap, isDriverRetired, driverDnf, box.width, box.height]);

  // Build a banner whenever there's a brushed range — primary feedback
  // that the user's selection actually triggered analysis. Source priority:
  // backend regression result (richest, includes fuel-corrected slope and
  // optimal-pit-lap projection) → fall back to the local stint regressions
  // visible on screen.
  const brushBanner = (() => {
    if (!activeRange) return null;
    const [lo, hi] = activeRange;
    const reg = degradationRegression;
    const hasFit = reg && reg.slope != null && reg.lap_start === lo && reg.lap_end === hi;
    const slopeMs = hasFit ? Math.round(reg.slope * 1000) : null;
    const slopeFc = hasFit && reg.slope_fuel_corrected != null
      ? Math.round(reg.slope_fuel_corrected * 1000) : null;
    // The store clamps the fit to the laps completed so far: lap_end_used is
    // the last lap actually fitted (< hi while the replay is inside the brush)
    const fit = hasFit ? fittedLapRange(reg) : null;
    return (
      <div className="deg-brush-banner">
        <span className="deg-brush-banner__label">BRUSHED LAPS</span>
        <span className="deg-brush-banner__range">L{lo} – L{hi}</span>
        {hasFit ? (
          <>
            {fit && (
              <>
                <span className="deg-brush-banner__sep">·</span>
                <span
                  className="deg-brush-banner__fit"
                  title={fit.partial
                    ? 'Fitted on the laps of the brushed range completed so far; the fit extends as the replay advances'
                    : 'Fitted on the whole brushed range'}
                >
                  <span style={{ color: TEXT_COLORS.muted, marginRight: 4 }}>fitted</span>
                  <strong>L{fit.start} – L{fit.end}</strong>
                  {fit.partial && (
                    <span style={{ color: TEXT_COLORS.muted, marginLeft: 4 }}>(so far)</span>
                  )}
                </span>
              </>
            )}
            <span className="deg-brush-banner__sep">·</span>
            <span className="deg-brush-banner__slope">
              <span style={{ color: TEXT_COLORS.muted, marginRight: 4 }}>raw</span>
              {/* + losing time per lap (orange), − gaining (blue): sign always shown */}
              <strong style={{ color: deltaColor(slopeMs) }}>
                {signedDelta(slopeMs, 0)} ms/lap
              </strong>
            </span>
            {slopeFc != null && (
              <span
                className="deg-brush-banner__slope"
                title={`raw slope + ${(reg.fuel_correction_per_lap ?? FUEL_EFFECT_S_PER_LAP).toFixed(3)} s/lap: an assumed fuel effect, not measured`}
              >
                <span style={{ color: TEXT_COLORS.muted, marginRight: 4 }}>fuel-corr.*</span>
                <strong style={{ color: deltaColor(slopeFc) }}>
                  {signedDelta(slopeFc, 0)} ms/lap
                </strong>
              </span>
            )}
          </>
        ) : reg?.reason ? (
          <span className="deg-brush-banner__reason">{reg.reason}</span>
        ) : (
          <span className="deg-brush-banner__reason">computing…</span>
        )}
      </div>
    );
  })();

  return (
    <Panel
      title="Tyre Degradation"
      className="panel-degradation"
      controls={<>{driverBadge}<Legend items={legendItems} /></>}
    >
      {brushBanner}
      <div className="viz-container deg-manager">
        {/* The svg fills .deg-plot, the row the fit note and the pit window
            leave: its viewBox is that box, so the drawing is never scaled down
            (measuring .deg-manager, note included, drew every label at 0.94) */}
        <div className="deg-plot">
          <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        </div>
        {/* The fuel constant and the clean-lap rule behind every slope above
            (utils/degradation.js; FUEL_EFFECT_S_PER_LAP is an assumption) */}
        <div
          className="deg-fit-note"
          style={{
            padding: '2px 12px', fontSize: CHART_FONT.label, lineHeight: 1.3, flexShrink: 0,
            color: TEXT_COLORS.muted, fontFamily: 'var(--font-mono)',
          }}
        >
          *{FUEL_NOTE} · {FIT_NOTE}
        </div>
        {pitWindow && (
          <div className="deg-pit-window">
            <span className="deg-pit-window__label">&#9668; NEXT PIT WINDOW</span>
            <span className="deg-pit-window__range">LAP {pitWindow[0]} &ndash; {pitWindow[1]}</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
