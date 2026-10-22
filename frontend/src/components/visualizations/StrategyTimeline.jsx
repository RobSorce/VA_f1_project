import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, TYRE_COLORS, TYRE_LABELS, tyreColor, tyreLetter, textColor, tintedChip,
  STATUS_COLORS, TEXT_COLORS, GRID_COLORS, UI_COLORS, SURFACES, CHART_FONT, chartFontPx,
} from '../../utils/colors';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { deriveStints } from '../../utils/stints';
import { focusForecast } from '../../utils/forecast';
import {
  causalKey, stintBars, pitStopMarkers, pitCountsByDriver, describeStopLoss, simulatorStints,
  layoutStopLabels, pitLaneNow, stintLapsText, viewSessionType, isRaceSession, PIT_LOSS_LEGEND,
} from '../../utils/strategyViews';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize, fitRows, pageOf } from '../../utils/views/chartBox';
import { stintLevel, stintFill, stintLabelFill } from '../../utils/views/strategyTimeline';

// Driver rows fitted to the pane (V13): a row is never lower than the data
// type needs (its label, the STOPS badge of 16 px and the bar, 20 px at 11 px
// type); the drivers that do not fit are paged with the pager under the chart
const ROW_MIN_PAD = 9;
// Columns of rows side by side: at most 3, each at least 340 px wide (its
// 96 px label area, 16 px gap and >= 228 px of laps: >= 4 px a lap)
const MAX_COLS = 3;
const COL_MIN_W = 340;
const COL_GAP = 16;
const pagerBtn = {
  fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, background: 'transparent',
  border: `1px solid ${GRID_COLORS.rule}`, borderRadius: 3, padding: '0 6px', cursor: 'pointer',
};
const MARGIN = { top: 12, right: 18, bottom: 28, left: 96 };

export default function StrategyTimeline() {
  const svgRef = useRef(null);
  const boxRef = useRef(null);
  // The box the chart fills (the svg's container): rows and layout follow it (D4)
  const box = useChartBox(boxRef, { parent: false });
  const [page, setPage] = useState(0);
  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const pcaStrategyAnalysis = useF1Store((s) => s.pcaStrategyAnalysis);
  const setSelectedPCAPoints = useF1Store((s) => s.setSelectedPCAPoints);
  const currentLap = useF1Store((s) => s.currentLap);
  const setSelectedStint = useF1Store((s) => s.setSelectedStint);
  const highlightedCompound = useF1Store((s) => s.highlightedCompound);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const simulatorStrategy = useF1Store((s) => s.simulatorStrategy);
  const setSimulatorStrategy = useF1Store((s) => s.setSimulatorStrategy);
  const raceProjection = useF1Store((s) => s.raceProjection);
  const storeMaxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  // Pit loss and its labels exist for race sessions only ('R', 'S'); in
  // qualifying / practice the bars are the runs' tyre sets, unlabelled
  const sessionType = useF1Store(viewSessionType);
  const isRace = isRaceSession(sessionType);
  const sessionNow = useSessionNow();
  // Live mode: drivers still racing keep their current stint ongoing
  const running = useStintsRunning();
  const lapTimes = sessionData?.lap_times;

  // Changes only when a lap, a pit entry or a pit exit completes, so the
  // memos below (and the D3 redraw) do not re-run on every replay frame.
  const causal = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);

  // Stints from the FastF1 Stint column (utils/stints.js), visible at
  // sessionNow: one bar per tyre set, stint 1 from the race start, a new
  // stint from its pit exit (0 laps until its first lap completes); a bar
  // covers the laps completed so far.
  const strategies = useMemo(
    () => stintBars(deriveStints(lapTimes || [], { sessionNow, running })),
    [lapTimes, causal, running],
  );

  // Pit stops (tyre changes) visible at sessionNow: from the pit exit, the
  // same instant the new bar appears, so the STOPS badge = bars - 1. Each is
  // labelled with its pit loss (utils/pitLoss.js perStopLoss): measured
  // "26.8s", race median "≈24.7s", fallback "22.0s*", or no number while
  // measuring; no number outside race sessions.
  const pitMarkers = useMemo(
    () => pitStopMarkers(lapTimes || [], { sessionNow, sessionType }),
    [lapTimes, causal, sessionType],
  );

  // Cars in the pit lane right now (pit entry passed, pit exit not yet): an
  // outline marker; the stop counts at the pit exit
  const inPitLane = useMemo(() => pitLaneNow(lapTimes || [], sessionNow), [lapTimes, causal]);

  // Legend (V4): every mark of the chart. Compounds as their badge (FIA
  // colour + letter, as in the bars' labels), the pit-stop diamonds, the
  // hatched predicted stints, the lap-range band and the Simulator's plan
  const legendItems = [
    ...['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) => ({
      label: c === 'INTERMEDIATE' ? 'Inter' : c[0] + c.slice(1).toLowerCase(),
      color: TYRE_COLORS[c], glyph: TYRE_LABELS[c], shape: 'badge',
    })),
    { label: 'Pit stop', color: TEXT_COLORS.primary, glyph: '◆', shape: 'glyph' },
    { label: 'In pit lane', color: TEXT_COLORS.primary, glyph: '◇', shape: 'glyph' },
    { label: 'Predicted (hatched)', color: TEXT_COLORS.secondary, shape: 'band' },
    ...(selectedLapRange ? [{ label: 'Lap range', color: UI_COLORS.brush, shape: 'band', fill: UI_COLORS.brushFill }] : []),
    ...(simulatorStrategy?.stints?.length ? [{ label: 'Simulator', color: TEXT_COLORS.secondary, shape: 'line', dash: '4,3' }] : []),
  ];

  // Drivers (alphabetical) and the page of them that fits the chart's height
  const driverList = useMemo(() => [...new Set(strategies.map((d) => d.Driver))].sort(), [strategies]);
  const rowMin = Math.ceil(chartFontPx('data') + ROW_MIN_PAD);
  // a wide, low pane holds up to three columns of rows (each with its own
  // label area); one column whenever every driver fits in one
  const rowsFit = fitRows(box.height - MARGIN.top - MARGIN.bottom, driverList.length, { rowMin, rowMax: 1000 });
  const maxCols = box.width > 0
    ? Math.max(1, Math.min(MAX_COLS, Math.floor((box.width - MARGIN.right) / COL_MIN_W))) : 1;
  const nCols = rowsFit.paged ? maxCols : 1;
  const fit = { perPage: rowsFit.perPage * nCols, paged: rowsFit.perPage * nCols < driverList.length };
  const pg = pageOf(driverList, page, fit.perPage);
  const shownDrivers = pg.rows;
  const perCol = Math.ceil(shownDrivers.length / nCols) || 1;
  const columnsShown = Array.from({ length: Math.ceil(shownDrivers.length / perCol) || 1 },
    (_, i) => shownDrivers.slice(i * perCol, i * perCol + perCol));
  const shownKey = columnsShown.map((c) => c.join(',')).join('|');
  // The focus driver's page comes up when the focus changes
  useEffect(() => {
    const i = focusDriver ? driverList.indexOf(focusDriver) : -1;
    if (i >= 0 && fit.perPage > 0) setPage(Math.floor(i / fit.perPage));
  }, [focusDriver, fit.perPage, driverList]);

  useEffect(() => {
    if (!svgRef.current) return;
    if (strategies.length === 0) {
      // No stint has begun yet (before the race start, or no lap data): clear
      // the old drawing; the empty-state message below the SVG explains it
      d3.select(svgRef.current).selectAll('*').remove();
      return;
    }

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, { width: 600, height: 350 });
    const margin = MARGIN;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    // Add hatched pattern for predictions
    const defs = svg.append('defs');
    ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].forEach((compound) => {
      const pat = defs.append('pattern')
        .attr('id', `hatch-${compound}`)
        .attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 6).attr('height', 6);
      pat.append('rect').attr('width', 6).attr('height', 6).attr('fill', tyreColor(compound));
      pat.append('line')
        .attr('x1', 0).attr('y1', 0).attr('x2', 6).attr('y2', 6)
        .attr('stroke', 'rgba(0,0,0,0.3)').attr('stroke-width', 2);
    });

    // Group strategies by driver
    const driverStrats = d3.group(strategies, (d) => d.Driver);

    // Find max lap: the race length, so the axis does not grow as laps complete
    let maxLap = totalRaceLaps || storeMaxLap || 0;
    strategies.forEach((s) => {
      const end = s.LapStart + s.StintLength - 1;
      if (end > maxLap) maxLap = end;
    });

    // Columns of the page's drivers side by side (one lap scale for all)
    const colW = (width - margin.right) / columnsShown.length;
    const innerW = colW - margin.left - (columnsShown.length > 1 ? COL_GAP : 0);
    const x = d3.scaleLinear().domain([1, maxLap]).range([0, innerW]);

    columnsShown.forEach((rowsShown, ci) => {
      const g = svg.append('g').attr('transform', `translate(${ci * colW + margin.left},${margin.top})`);
      const y = d3.scaleBand()
        .domain(rowsShown)
        .range([0, innerH])
        .padding(0.15);

      // Gridlines (subtle vertical lines per 5 laps for readability)
      const xTicks = x.ticks(Math.min(10, maxLap));
      g.append('g').attr('class', 'grid-lines')
        .selectAll('line')
        .data(xTicks)
        .join('line')
        .attr('x1', d => x(d)).attr('x2', d => x(d))
        .attr('y1', 0).attr('y2', innerH)
        .attr('stroke', GRID_COLORS.grid)
        .attr('stroke-width', 1);

      // Axis
      g.append('g').attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(Math.min(10, maxLap)).tickFormat(d3.format('d')))
        .selectAll('text').style('font-size', CHART_FONT.data).attr('fill', TEXT_COLORS.muted);
      // X axis label
      g.append('text').attr('text-anchor', 'middle')
        .attr('x', innerW / 2).attr('y', innerH + margin.bottom - 4)
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
        .attr('font-weight', 600).text('Lap');

      // Driver labels: in the driver's colour (teammate tint, V3), >= 4.5:1
      g.append('g').call(d3.axisLeft(y))
        .selectAll('text')
        .attr('font-weight', 800)
        .style('font-size', CHART_FONT.data)
        .attr('font-family', 'var(--font-display)')
        .each(function (driver) {
          d3.select(this).attr('fill', textColor(getDriverColor(driver)));
        });

      // Pit stop count per driver: tyre changes visible at sessionNow (the count
      // steps up at the pit exit, together with the new bar: bars - 1)
      const pitCountMap = pitCountsByDriver(pitMarkers);

      // Horizontal row separators (subtle lines between drivers)
      rowsShown.forEach((driver) => {
        g.append('line')
          .attr('x1', 0).attr('x2', innerW)
          .attr('y1', y(driver) + y.bandwidth() + y.step() * y.padding() / 2)
          .attr('y2', y(driver) + y.bandwidth() + y.step() * y.padding() / 2)
          .attr('stroke', GRID_COLORS.grid)
          .attr('stroke-width', 1);
      });

      // Add pit count badges to the left of driver names on y-axis
      rowsShown.forEach((driver) => {
        const pits = pitCountMap[driver] || 0;
        // Filled circle pill so the count reads at a glance even at small font.
        const cx = -78;
        const cy = y(driver) + y.bandwidth() / 2;
        // pit colour tint behind, its text lifted to 4.5:1 on it (tintedChip)
        const chip = tintedChip(STATUS_COLORS.pit, 0.18, SURFACES.panel);
        g.append('rect')
          .attr('x', cx - 11).attr('y', cy - 8)
          .attr('width', 22).attr('height', 16)
          .attr('rx', 4)
          .attr('fill', pits > 0 ? chip.background : 'rgba(255,255,255,0.04)')
          .attr('stroke', pits > 0 ? chip.borderColor : 'rgba(255,255,255,0.30)')
          .attr('stroke-width', 1);
        g.append('text')
          .attr('class', 'pit-count-badge')
          .attr('x', cx)
          .attr('y', cy)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .style('font-size', CHART_FONT.data)
          .attr('font-weight', 800)
          .attr('font-family', 'var(--font-mono)')
          .attr('fill', pits > 0 ? chip.color : TEXT_COLORS.muted)
          .text(`${pits}P`);
      });

      // Y-axis label — header above the column, explains what the badges mean.
      g.append('text')
        .attr('x', -78).attr('y', -2)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.label)
        .attr('font-weight', 700)
        .attr('font-family', 'var(--font-display)')
        .attr('letter-spacing', '0.08em')
        .text('STOPS');
      g.append('text')
        .attr('x', -34).attr('y', -2)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.label)
        .attr('font-weight', 700)
        .attr('font-family', 'var(--font-display)')
        .attr('letter-spacing', '0.08em')
        .text('DRIVER');

      const fontPxBar = chartFontPx('data');
      // Draw stints (already causal: a bar covers the laps completed at sessionNow;
      // a stint just begun is a sliver at its first lap)
      driverStrats.forEach((stints, driver) => {
        if (y(driver) == null) return; // on another page
        const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(driver);

        stints.forEach((stint) => {
          const lapStart = stint.LapStart;
          const length = stint.StintLength;
          const compound = stint.Compound;

          const barW = Math.max(2, x(lapStart + length) - x(lapStart));

          const compoundDimmed = !!highlightedCompound && highlightedCompound !== compound;
          // full colour when selected; an unselected bar (or another driver
          // hovered, another compound hovered in the legend) is context: its
          // colour mixed toward the panel, never an opacity, and the label
          // inside in contrastText of the fill drawn (utils/views/strategyTimeline.js, D7)
          const hovered = useF1Store.getState().highlightedDriver;
          const level = stintLevel({
            selected: isSelected, highlighted: hovered === driver, hoverActive: !!hovered, compoundDimmed,
          });

          g.append('rect')
            .attr('class', 'stint-bar')
            .attr('data-driver', driver)
            .attr('data-compound', compound)
            .attr('x', x(lapStart))
            .attr('y', y(driver))
            .attr('width', barW)
            .attr('height', y.bandwidth())
            .attr('rx', 4)
            .attr('fill', stintFill(compound, level))
            .on('click', () => {
              toggleDriver(driver);
              setSelectedStint({
                driver,
                stintNumber: stint.StintNumber || 0,
                compound,
                lapStart,
                stintLength: length,
                ongoing: stint.ongoing,
              });
            })
            .on('dblclick', () => {
              // Pre-fill simulator with this driver's strategy so far; the
              // ongoing stint is extended to the flag as the editable baseline
              const simStints = simulatorStints(driverStrats.get(driver) || [], maxLap);
              if (simStints.length > 0) {
                setSimulatorStrategy({ driver, stints: simStints });
              }
            })
            .on('mouseenter', function (event) {
              setHighlightedDriver(driver);
              let tt = d3.select('.strat-tooltip');
              if (!tt.size()) tt = d3.select('body').append('div').attr('class', 'tooltip strat-tooltip');
              tt.html(
                `<div class="tooltip-title" style="color:${textColor(getDriverColor(driver), SURFACES.elevated)}">${driver}</div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Compound</span><span class="tooltip-value" style="color:${textColor(tyreColor(compound), SURFACES.elevated)}">${compound}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Laps</span><span class="tooltip-value">${stintLapsText(stint)}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Stint</span><span class="tooltip-value">#${stint.StintNumber || ''}</span></div>` +
                `<div class="tooltip-row"><span class="tooltip-label">Pit Stops</span><span class="tooltip-value">${pitCountMap[driver] || 0}</span></div>`
              ).style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px')
                .classed('visible', true).style('opacity', 1);
            })
            .on('mousemove', function (event) {
              d3.select('.strat-tooltip')
                .style('left', event.pageX + 12 + 'px').style('top', event.pageY - 10 + 'px');
            })
            .on('mouseleave', () => {
              setHighlightedDriver(null);
              d3.select('.strat-tooltip').classed('visible', false).style('opacity', 0);
            });

          // Label inside the bar: compound letter + lap count where it fits,
          // else the letter alone (V1: a stint is never told by its colour
          // only; soft / intermediate are CIEDE2000 5.7 apart under
          // deuteranopia); only a sliver under one letter has none (tooltip)
          const full = `${tyreLetter(compound)}${length}`;
          const label = barW >= full.length * fontPxBar * 0.62 + 6 ? full
            : barW >= fontPxBar * 0.7 + 4 ? tyreLetter(compound) : '';
          if (label) {
            g.append('text')
              .attr('class', 'stint-bar-label')
              .attr('data-driver', driver)
              .attr('data-compound', compound)
              .attr('x', x(lapStart) + barW / 2)
              .attr('y', y(driver) + y.bandwidth() / 2)
              .attr('fill', stintLabelFill(compound, level))
              .text(label);
          }
        });
      });

      // Pit stop markers: one diamond per tyre change visible at sessionNow
      // (from the pit exit), labelled with that stop's pit loss
      // (utils/strategyViews.js formatStopLoss): measured "26.8s", race median
      // "≈24.7s" for a stop that cannot be measured, fallback "22.0s*" before
      // any measured green stop, no number while the stop is being measured
      // and outside race sessions. A label that would overlap the previous one
      // on the row is left out; the tooltip always has it.
      const halfBand = y.bandwidth() / 2;
      // Only the markers drawn reserve room for a label; pills are compared
      // across rows too (tight rows: adjacent rows' pills would overlap)
      const drawnMarkers = pitMarkers.filter((m) => y(m.Driver) != null
        && (selectedDrivers.length === 0 || selectedDrivers.includes(m.Driver)));
      // pill sized to the data font (>= 11 px): width per character and height
      const fontPx = chartFontPx('data');
      const pillH = Math.ceil(fontPx + 3);
      const pillTop = pillH + 3;
      layoutStopLabels(drawnMarkers, x, {
        yOf: (d) => y(d), charWidth: fontPx * 0.62, pillH, pillTop,
      }).forEach((stop) => {
        const driver = stop.Driver;
        if (y(driver) == null) return;
        const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(driver);
        if (!isSelected) return;

        const pitX = stop.x;
        const pitY = y(driver);
        const marker = g.append('g').attr('class', 'pit-marker').attr('data-source', stop.source);
        marker.append('title').text(
          `${driver} pit stop, lap ${stop.inLap}: ${stop.fromCompound} → ${stop.toCompound}\n${describeStopLoss(stop)}`,
        );
        // Diamond marker (dimmer while the stop is being measured)
        marker.append('path')
          .attr('d', `M${pitX},${pitY - 2} l5,${halfBand + 2} l-5,${halfBand + 2} l-5,-${halfBand + 2} Z`)
          .attr('fill', stop.source === 'pending' ? TEXT_COLORS.muted : TEXT_COLORS.primary)
          .attr('stroke', SURFACES.page)
          .attr('stroke-width', 0.7);
        if (!stop.showLabel) return;
        // Pit-loss label — background pill for readability, sized to the text
        marker.append('rect')
          .attr('x', pitX - stop.pillW / 2)
          .attr('y', pitY - pillTop)
          .attr('width', stop.pillW)
          .attr('height', pillH)
          .attr('rx', 3)
          .attr('fill', 'rgba(10,10,25,0.85)')
          .attr('stroke', 'rgba(255,255,255,0.30)')
          .attr('stroke-width', 0.5);
        marker.append('text')
          .attr('class', 'pit-loss-label')
          .attr('x', pitX)
          .attr('y', pitY - pillTop + pillH / 2)
          .attr('dominant-baseline', 'central')
          .attr('text-anchor', 'middle')
          .attr('fill', stop.source === 'measured' ? TEXT_COLORS.primary : TEXT_COLORS.secondary)
          .style('font-size', CHART_FONT.data)
          .attr('font-weight', 700)
          .attr('font-family', 'var(--font-mono)')
          .text(stop.label);
      });

      // Cars in the pit lane now: outline diamond at the in-lap; the old set is
      // still the current one and the stop counts at the pit exit
      inPitLane.forEach((p) => {
        if (y(p.Driver) == null) return;
        const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(p.Driver);
        if (!isSelected) return;
        const pitX = x(p.inLap + 0.5);
        const pitY = y(p.Driver);
        const marker = g.append('g').attr('class', 'pit-lane-marker');
        marker.append('title').text(`${p.Driver} in the pit lane (entered on lap ${p.inLap})`);
        marker.append('path')
          .attr('d', `M${pitX},${pitY - 2} l5,${halfBand + 2} l-5,${halfBand + 2} l-5,-${halfBand + 2} Z`)
          .attr('fill', 'none')
          .attr('stroke', TEXT_COLORS.primary)
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '2,1.5');
      });

      // Predicted stints of the focus driver's forecast (utils/forecast.js)
      const forecast = focusForecast(lstmPredictions, focusDriver);
      if (Array.isArray(forecast?.predicted_stints)) {
        forecast.predicted_stints.forEach((stint) => {
          const driver = stint.driver;
          if (y(driver) == null) return;
          const compound = (stint.compound || 'MEDIUM').toUpperCase();

          g.append('rect')
            .attr('class', 'stint-bar stint-bar--predicted')
            .attr('x', x(stint.lap_start))
            .attr('y', y(driver))
            .attr('width', Math.max(2, x(stint.lap_start + stint.length) - x(stint.lap_start)))
            .attr('height', y.bandwidth())
            .attr('rx', 3)
            .attr('fill', `url(#hatch-${compound})`);
        });
      }

      // PCA ghost rows (under the first column)
      if (ci === 0 && pcaStrategyAnalysis?.strategies) {
        const ghostY = innerH + 5;
        pcaStrategyAnalysis.strategies.forEach((strat, i) => {
          const rowY = ghostY + i * 18;
          (strat.stints || []).forEach((stint) => {
            const compound = (stint.compound || 'MEDIUM').toUpperCase();
            g.append('rect')
              .attr('class', 'stint-bar stint-bar--pca-ghost')
              .attr('x', x(stint.lap_start || 1))
              .attr('y', rowY)
              .attr('width', Math.max(2, x((stint.lap_start || 1) + (stint.length || 10)) - x(stint.lap_start || 1)))
              .attr('height', 14)
              .attr('rx', 2)
              .attr('fill', tyreColor(compound));
          });
        });
      }

      // Simulator strategy ghost overlay
      if (simulatorStrategy?.stints?.length && simulatorStrategy.driver) {
        const driver = simulatorStrategy.driver;
        if (y(driver) != null) {
          simulatorStrategy.stints.forEach((stint) => {
            const compound = (stint.compound || 'MEDIUM').toUpperCase();
            const lapStart = stint.lapStart || 1;
            const length = stint.length || 10;
            g.append('rect')
              .attr('x', x(lapStart))
              .attr('y', y(driver) - 4)
              .attr('width', Math.max(2, x(lapStart + length) - x(lapStart)))
              .attr('height', y.bandwidth() + 8)
              .attr('rx', 4)
              .attr('fill', 'none')
              .attr('stroke', tyreColor(compound))
              .attr('stroke-width', 2)
              .attr('stroke-dasharray', '4,3');
            // Compound label above (letter = the cue of the compound colour)
            g.append('text')
              .attr('x', x(lapStart) + 4)
              .attr('y', y(driver) - 6)
              .attr('fill', textColor(tyreColor(compound), SURFACES.panel))
              .style('font-size', CHART_FONT.label)
              .attr('font-weight', 700)
              .text(`SIM: ${tyreLetter(compound)} L${lapStart}–${lapStart + length - 1}`);
          });
        }
      }

      // Current lap indicator line
      if (currentLap > 0 && currentLap <= maxLap) {
        g.append('line')
          .attr('x1', x(currentLap)).attr('x2', x(currentLap))
          .attr('y1', -4).attr('y2', innerH)
          .attr('stroke', GRID_COLORS.rule)
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3')
          .attr('pointer-events', 'none');
        g.append('text')
          .attr('x', x(currentLap))
          .attr('y', -6)
          .attr('text-anchor', 'middle')
          .attr('fill', TEXT_COLORS.muted)
          .style('font-size', CHART_FONT.label)
          .attr('font-weight', 600)
          .text(`L${currentLap}`);
      }

      // Selected lap range highlight
      if (selectedLapRange) {
        const [lo, hi] = selectedLapRange;
        g.append('rect')
          .attr('x', x(lo))
          .attr('y', 0)
          .attr('width', Math.max(1, x(hi) - x(lo)))
          .attr('height', innerH)
          .attr('fill', UI_COLORS.brushFill)
          .attr('stroke', UI_COLORS.brush)
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '4,2')
          .attr('pointer-events', 'none');
      }
    });

    // Stint click → set selectedLapRange
    svg.selectAll('.stint-bar').on('click.laprange', function () {
      const d = d3.select(this);
      const driver = d.attr('data-driver');
      if (!driver) return;
      const stint = strategies.find((s) => s.Driver === driver &&
        Math.abs(x(s.LapStart) - parseFloat(d.attr('x'))) < 2);
      // A stint just begun has no completed lap yet: no range to select
      if (stint && stint.StintLength > 0) {
        setSelectedLapRange([stint.LapStart, stint.LapStart + stint.StintLength - 1]);
      }
    });

    return () => {
      d3.select('body').select('.strat-tooltip').remove();
    };
  }, [strategies, pitMarkers, inPitLane, storeMaxLap, totalRaceLaps, selectedDrivers, currentLap, lstmPredictions, focusDriver, pcaStrategyAnalysis, toggleDriver, setHighlightedDriver, setSelectedStint, highlightedCompound, selectedLapRange, setSelectedLapRange, simulatorStrategy, shownKey, box.width, box.height]);

  // Lightweight highlight effect — recolours the bars and their labels
  // (focus + context by colour, never opacity: stintLevel) without a full redraw
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('.stint-bar, .stint-bar-label').each(function () {
      const el = d3.select(this);
      const driver = el.attr('data-driver');
      const compound = el.attr('data-compound');
      if (!driver) return;
      const level = stintLevel({
        selected: selectedDrivers.length === 0 || selectedDrivers.includes(driver),
        highlighted: highlightedDriver === driver,
        hoverActive: !!highlightedDriver,
        compoundDimmed: !!highlightedCompound && highlightedCompound !== compound,
      });
      el.attr('fill', el.classed('stint-bar') ? stintFill(compound, level) : stintLabelFill(compound, level));
    });
  }, [highlightedDriver, selectedDrivers, highlightedCompound]);

  return (
    <Panel
      title="Strategy Timeline"
      className="panel--dense"
      controls={(
        <>
          {fit.paged && (
            <div className="strategy-timeline__pager" style={{
              display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
              fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, whiteSpace: 'nowrap',
            }}
            >
              <button type="button" aria-label="Previous drivers" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} style={pagerBtn}>{'\u25C0'}</button>
              <span>Drivers {pg.first}{'\u2013'}{pg.last} of {driverList.length}</span>
              <button type="button" aria-label="Next drivers" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)} style={pagerBtn}>{'\u25B6'}</button>
            </div>
          )}
          <Legend items={legendItems} />
        </>
      )}
      focused={focusedView === 'strategy'}
      shortcutKey="3"
    >
      <div ref={boxRef} className="viz-container">
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {strategies.length === 0 && (
          <div
            className="strategy-timeline__empty"
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: CHART_FONT.data, color: TEXT_COLORS.muted, textAlign: 'center', padding: 12,
            }}
          >
            {lapTimes?.length
              ? 'No stint has begun yet at the current replay time.'
              : 'No lap data for this session.'}
          </div>
        )}
      </div>
      <div
        className="strategy-timeline__legend"
        style={{
          flexShrink: 0, padding: '2px 10px 4px', fontSize: CHART_FONT.label, lineHeight: 1.3,
          color: TEXT_COLORS.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
        title={isRace ? PIT_LOSS_LEGEND : undefined}
      >
        {isRace
          ? PIT_LOSS_LEGEND
          : 'Bars are tyre sets (runs); pit loss is shown in race sessions only.'}
      </div>
    </Panel>
  );
}
