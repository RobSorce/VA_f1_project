import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, getTyreTextColor } from '../../utils/colors';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { deriveStints } from '../../utils/stints';
import { focusForecast } from '../../utils/forecast';
import {
  causalKey, stintBars, pitStopMarkers, pitCountsByDriver, describeStopLoss, simulatorStints,
  layoutStopLabels, pitLaneNow, stintLapsText, viewSessionType, isRaceSession, PIT_LOSS_LEGEND,
} from '../../utils/strategyViews';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

export default function StrategyTimeline({ showOverlays = false }) {
  const svgRef = useRef(null);
  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const pcaStrategyAnalysis = useF1Store((s) => s.pcaStrategyAnalysis);
  const geminiOverlays = useF1Store((s) => s.geminiOverlays);
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

  const legendItems = [
    { label: 'Soft', color: TYRE_COLORS.SOFT, shape: 'circle' },
    { label: 'Medium', color: TYRE_COLORS.MEDIUM, shape: 'circle' },
    { label: 'Hard', color: TYRE_COLORS.HARD, shape: 'circle' },
    { label: 'Inter', color: TYRE_COLORS.INTERMEDIATE, shape: 'circle' },
    { label: 'Wet', color: TYRE_COLORS.WET, shape: 'circle' },
    { label: 'Predicted', color: '#888', shape: 'line' },
    ...(showOverlays ? [{ label: 'Gemini', color: '#f5a623', shape: 'line' }] : []),
  ];

  useEffect(() => {
    if (!svgRef.current) return;
    if (strategies.length === 0) {
      // No stint has begun yet (before the race start, or no lap data): clear
      // the old drawing; the empty-state message below the SVG explains it
      d3.select(svgRef.current).selectAll('*').remove();
      return;
    }

    // Always read fresh container dimensions so the chart fills its space
    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width) || 600;
    const height = Math.round(rect.height) || 350;
    const margin = { top: 12, right: 18, bottom: 28, left: 96 };
    const innerW = width - margin.left - margin.right;
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
      pat.append('rect').attr('width', 6).attr('height', 6).attr('fill', TYRE_COLORS[compound] || '#888');
      pat.append('line')
        .attr('x1', 0).attr('y1', 0).attr('x2', 6).attr('y2', 6)
        .attr('stroke', 'rgba(0,0,0,0.3)').attr('stroke-width', 2);
    });

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Group strategies by driver
    const driverStrats = d3.group(strategies, (d) => d.Driver);
    const driverList = Array.from(driverStrats.keys()).sort();

    // Find max lap: the race length, so the axis does not grow as laps complete
    let maxLap = totalRaceLaps || storeMaxLap || 0;
    strategies.forEach((s) => {
      const end = s.LapStart + s.StintLength - 1;
      if (end > maxLap) maxLap = end;
    });

    // Scales
    const x = d3.scaleLinear().domain([1, maxLap]).range([0, innerW]);
    const y = d3.scaleBand()
      .domain(driverList)
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
      .attr('stroke', 'rgba(255,255,255,0.04)')
      .attr('stroke-width', 1);

    // Axis
    g.append('g').attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(10, maxLap)).tickFormat(d3.format('d')));
    // X axis label
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', innerW / 2).attr('y', innerH + margin.bottom - 4)
      .attr('fill', 'rgba(255,255,255,0.4)').attr('font-size', '9px')
      .attr('font-weight', 600).text('Lap');

    // Driver labels: colored by team, bolder
    g.append('g').call(d3.axisLeft(y))
      .selectAll('text')
      .attr('font-weight', 800)
      .attr('font-size', 11)
      .attr('font-family', 'var(--font-display)')
      .each(function (driver) {
        d3.select(this).attr('fill', getDriverColor(driver));
      });

    // Pit stop count per driver: tyre changes visible at sessionNow (the count
    // steps up at the pit exit, together with the new bar: bars - 1)
    const pitCountMap = pitCountsByDriver(pitMarkers);

    // Horizontal row separators (subtle lines between drivers)
    driverList.forEach((driver) => {
      g.append('line')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', y(driver) + y.bandwidth() + y.step() * y.padding() / 2)
        .attr('y2', y(driver) + y.bandwidth() + y.step() * y.padding() / 2)
        .attr('stroke', 'rgba(255,255,255,0.03)')
        .attr('stroke-width', 1);
    });

    // Add pit count badges to the left of driver names on y-axis
    driverList.forEach((driver) => {
      const pits = pitCountMap[driver] || 0;
      // Filled circle pill so the count reads at a glance even at small font.
      const cx = -78;
      const cy = y(driver) + y.bandwidth() / 2;
      g.append('rect')
        .attr('x', cx - 11).attr('y', cy - 8)
        .attr('width', 22).attr('height', 16)
        .attr('rx', 4)
        .attr('fill', pits > 0 ? 'rgba(229, 57, 53, 0.18)' : 'rgba(255,255,255,0.04)')
        .attr('stroke', pits > 0 ? 'rgba(229, 57, 53, 0.50)' : 'rgba(255,255,255,0.10)')
        .attr('stroke-width', 1);
      g.append('text')
        .attr('class', 'pit-count-badge')
        .attr('x', cx)
        .attr('y', cy)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('font-size', 10)
        .attr('font-weight', 800)
        .attr('font-family', 'var(--font-mono)')
        .attr('fill', pits > 0 ? '#ff7878' : 'rgba(255,255,255,0.45)')
        .text(`${pits}P`);
    });

    // Y-axis label — header above the column, explains what the badges mean.
    g.append('text')
      .attr('x', -78).attr('y', -2)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.55)')
      .attr('font-size', 8.5)
      .attr('font-weight', 700)
      .attr('font-family', 'var(--font-display)')
      .attr('letter-spacing', '0.08em')
      .text('STOPS');
    g.append('text')
      .attr('x', -34).attr('y', -2)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.55)')
      .attr('font-size', 8.5)
      .attr('font-weight', 700)
      .attr('font-family', 'var(--font-display)')
      .attr('letter-spacing', '0.08em')
      .text('DRIVER');

    // Draw stints (already causal: a bar covers the laps completed at sessionNow;
    // a stint just begun is a sliver at its first lap)
    driverStrats.forEach((stints, driver) => {
      const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(driver);

      stints.forEach((stint) => {
        const lapStart = stint.LapStart;
        const length = stint.StintLength;
        const compound = stint.Compound;

        const barW = Math.max(2, x(lapStart + length) - x(lapStart));

        const compoundDimmed = highlightedCompound && highlightedCompound !== compound;
        let barOpacity = isSelected ? 0.85 : 0.2;
        if (compoundDimmed) barOpacity *= 0.3;
        barOpacity = Math.max(barOpacity, 0.12); // floor: always perceptible

        g.append('rect')
          .attr('class', 'stint-bar')
          .attr('data-driver', driver)
          .attr('data-compound', compound)
          .attr('x', x(lapStart))
          .attr('y', y(driver))
          .attr('width', barW)
          .attr('height', y.bandwidth())
          .attr('rx', 4)
          .attr('fill', TYRE_COLORS[compound] || '#888')
          .attr('opacity', barOpacity)
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
              `<div class="tooltip-title" style="color:${getDriverColor(driver)}">${driver}</div>` +
              `<div class="tooltip-row"><span class="tooltip-label">Compound</span><span class="tooltip-value" style="color:${TYRE_COLORS[compound] || '#888'}">${compound}</span></div>` +
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

        // Label inside bar: compound initial + lap count
        if (barW > 24) {
          g.append('text')
            .attr('class', 'stint-bar-label')
            .attr('x', x(lapStart) + barW / 2)
            .attr('y', y(driver) + y.bandwidth() / 2)
            .attr('fill', getTyreTextColor(compound))
            .text(`${compound[0]}${length}`);
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
    layoutStopLabels(drawnMarkers, x, { yOf: (d) => y(d) }).forEach((stop) => {
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
        .attr('fill', stop.source === 'pending' ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.9)')
        .attr('stroke', 'rgba(0,0,0,0.5)')
        .attr('stroke-width', 0.7);
      if (!stop.showLabel) return;
      // Pit-loss label — background pill for readability, sized to the text
      marker.append('rect')
        .attr('x', pitX - stop.pillW / 2)
        .attr('y', pitY - 14)
        .attr('width', stop.pillW)
        .attr('height', 11)
        .attr('rx', 3)
        .attr('fill', 'rgba(10,10,25,0.85)')
        .attr('stroke', 'rgba(255,255,255,0.12)')
        .attr('stroke-width', 0.5);
      marker.append('text')
        .attr('class', 'pit-loss-label')
        .attr('x', pitX)
        .attr('y', pitY - 6)
        .attr('text-anchor', 'middle')
        .attr('fill', stop.source === 'measured' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)')
        .attr('font-size', 8)
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
        .attr('stroke', 'rgba(255,255,255,0.85)')
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

    // PCA ghost rows
    if (pcaStrategyAnalysis?.strategies) {
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
            .attr('fill', TYRE_COLORS[compound] || '#888');
        });
      });
    }

    // Gemini overlay rows
    if (showOverlays && geminiOverlays?.length) {
      geminiOverlays.forEach((scenario, i) => {
        const driver = scenario.driver || driverList[0];
        if (!y(driver)) return;

        (scenario.stints || []).forEach((stint) => {
          const compound = (stint.compound || 'MEDIUM').toUpperCase();
          g.append('rect')
            .attr('class', 'stint-bar stint-bar--gemini')
            .attr('x', x(stint.lap_start || 1))
            .attr('y', y(driver) - 3)
            .attr('width', Math.max(2, x((stint.lap_start || 1) + (stint.length || 10)) - x(stint.lap_start || 1)))
            .attr('height', y.bandwidth() + 6)
            .attr('rx', 3)
            .attr('fill', 'var(--color-gemini-ghost)');
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
            .attr('stroke', TYRE_COLORS[compound] || '#888')
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '4,3')
            .attr('opacity', 0.7);
          // Compound label above
          g.append('text')
            .attr('x', x(lapStart) + 4)
            .attr('y', y(driver) - 6)
            .attr('fill', TYRE_COLORS[compound] || '#888')
            .attr('font-size', '7px')
            .attr('font-weight', 700)
            .text(`SIM: ${compound[0]} L${lapStart}–${lapStart + length - 1}`);
        });
      }
    }

    // Current lap indicator line
    if (currentLap > 0 && currentLap <= maxLap) {
      g.append('line')
        .attr('x1', x(currentLap)).attr('x2', x(currentLap))
        .attr('y1', -4).attr('y2', innerH)
        .attr('stroke', 'rgba(255,255,255,0.35)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3,3')
        .attr('pointer-events', 'none');
      g.append('text')
        .attr('x', x(currentLap))
        .attr('y', -6)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.5)')
        .attr('font-size', 7)
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
        .attr('fill', 'rgba(100,180,255,0.08)')
        .attr('stroke', 'rgba(100,180,255,0.3)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,2')
        .attr('pointer-events', 'none');
    }

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
  }, [strategies, pitMarkers, inPitLane, storeMaxLap, totalRaceLaps, selectedDrivers, currentLap, lstmPredictions, focusDriver, pcaStrategyAnalysis, geminiOverlays, showOverlays, toggleDriver, setHighlightedDriver, setSelectedStint, highlightedCompound, selectedLapRange, setSelectedLapRange, simulatorStrategy]);

  // Lightweight highlight effect — updates opacity without full redraw
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('.stint-bar').each(function () {
      const el = d3.select(this);
      const driver = el.attr('data-driver');
      if (!driver) return;
      const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(driver);
      const baseOpacity = isSelected ? 0.85 : 0.2;
      const isHl = highlightedDriver && driver === highlightedDriver;
      const isDimmed = highlightedDriver && driver !== highlightedDriver;
      el.attr('opacity', isDimmed ? Math.min(baseOpacity, 0.15) : isHl ? Math.min(1, baseOpacity + 0.15) : baseOpacity);
    });
  }, [highlightedDriver, selectedDrivers]);

  return (
    <Panel title="Strategy Timeline" controls={<Legend items={legendItems} shape="circle" />} focused={focusedView === 'strategy'} shortcutKey="7">
      <div className="viz-container">
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {strategies.length === 0 && (
          <div
            className="strategy-timeline__empty"
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'center', padding: 12,
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
          flexShrink: 0, padding: '2px 10px 4px', fontSize: 9, lineHeight: 1.3,
          color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
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
