import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, getTyreTextColor } from '../../utils/colors';
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

  const strategies = useMemo(() => {
    const raw = sessionData?.tyre_strategy || sessionData?.strategies || [];
    // Normalize field names — FastF1 extractor uses StartLap/EndLap/TotalLaps
    return raw.map((s) => ({
      ...s,
      LapStart: s.LapStart || s.StartLap || s.Stint_Start || 1,
      StintLength: s.StintLength || s.TotalLaps || s.Stint_Length || (s.EndLap ? s.EndLap - (s.StartLap || 1) + 1 : 10),
      Compound: s.Compound || 'UNKNOWN',
      Driver: s.Driver || s.driver || '',
    }));
  }, [sessionData]);

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
    if (!svgRef.current || strategies.length === 0) return;

    // Always read fresh container dimensions so the chart fills its space
    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width) || 600;
    const height = Math.round(rect.height) || 350;
    const margin = { top: 12, right: 18, bottom: 28, left: 70 };
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

    // Find max lap
    let maxLap = 0;
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

    // Compute pit stop count per driver (stints - 1, only counting stints that started)
    const pitCountMap = {};
    driverStrats.forEach((stints, driver) => {
      const started = stints.filter((s) => s.LapStart <= currentLap);
      pitCountMap[driver] = Math.max(0, started.length - 1);
    });

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
      g.append('text')
        .attr('class', 'pit-count-badge')
        .attr('x', -62)
        .attr('y', y(driver) + y.bandwidth() / 2)
        .attr('text-anchor', 'end')
        .attr('dominant-baseline', 'central')
        .attr('font-size', 8)
        .attr('font-weight', 700)
        .attr('font-family', 'var(--font-mono)')
        .attr('fill', pits > 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.2)')
        .text(`${pits}P`);
    });

    // Draw stints (filtered incrementally by currentLap)
    driverStrats.forEach((stints, driver) => {
      const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(driver);

      stints.forEach((stint) => {
        const lapStart = stint.LapStart;
        // Skip stints that haven't started yet
        if (lapStart > currentLap) return;
        // Truncate ongoing stints to currentLap
        const fullLength = stint.StintLength;
        const length = Math.min(fullLength, currentLap - lapStart + 1);
        const compound = (stint.Compound || 'UNKNOWN').toUpperCase();

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
              stintLength: fullLength,
            });
          })
          .on('dblclick', () => {
            // Pre-fill simulator with this driver's full strategy
            const driverStintArr = driverStrats.get(driver) || [];
            const simStints = driverStintArr.map((s) => ({
              compound: (s.Compound || 'MEDIUM').toUpperCase(),
              lapStart: s.LapStart,
              length: s.StintLength,
            }));
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
              `<div class="tooltip-row"><span class="tooltip-label">Laps</span><span class="tooltip-value">${lapStart}–${lapStart + length - 1} (${length} laps)</span></div>` +
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

    // Pit stop duration markers (between stints)
    const lapTimes = sessionData?.lap_times || [];
    driverStrats.forEach((stints, driver) => {
      const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(driver);
      if (!isSelected) return;
      const sorted = [...stints].sort((a, b) => a.LapStart - b.LapStart);
      for (let i = 0; i < sorted.length - 1; i++) {
        const endLap = sorted[i].LapStart + sorted[i].StintLength - 1;
        if (endLap > currentLap) continue;
        // Find the pit lap in lap_times
        const pitLap = lapTimes.find(
          (lt) => lt.Driver === driver && lt.LapNumber === endLap && lt.PitInTimeSeconds > 0
        );
        if (!pitLap) continue;
        // Estimate pit duration from the spike in lap time vs median
        const driverLaps = lapTimes.filter(
          (lt) => lt.Driver === driver && lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300
            && !lt.PitInTimeSeconds && !lt.PitOutTimeSeconds
        );
        const median = driverLaps.length > 0
          ? driverLaps.map((l) => l.LapTimeSeconds).sort((a, b) => a - b)[Math.floor(driverLaps.length / 2)]
          : 0;
        const pitDuration = median > 0 ? Math.max(0, pitLap.LapTimeSeconds - median) : 0;
        if (pitDuration <= 0) continue;

        const pitX = x(endLap + 0.5);
        const pitY = y(driver);
        // Diamond marker
        const halfBand = y.bandwidth() / 2;
        g.append('path')
          .attr('d', `M${pitX},${pitY - 2} l5,${halfBand + 2} l-5,${halfBand + 2} l-5,-${halfBand + 2} Z`)
          .attr('fill', 'rgba(255,255,255,0.9)')
          .attr('stroke', 'rgba(0,0,0,0.5)')
          .attr('stroke-width', 0.7);
        // Duration label — background pill for readability
        const durText = `${pitDuration.toFixed(1)}s`;
        g.append('rect')
          .attr('x', pitX - 12)
          .attr('y', pitY - 14)
          .attr('width', 24)
          .attr('height', 11)
          .attr('rx', 3)
          .attr('fill', 'rgba(10,10,25,0.85)')
          .attr('stroke', 'rgba(255,255,255,0.12)')
          .attr('stroke-width', 0.5);
        g.append('text')
          .attr('x', pitX)
          .attr('y', pitY - 6)
          .attr('text-anchor', 'middle')
          .attr('fill', 'rgba(255,255,255,0.9)')
          .attr('font-size', 8)
          .attr('font-weight', 700)
          .attr('font-family', 'var(--font-mono)')
          .text(durText);
      }
    });

    // LSTM predicted stints
    if (lstmPredictions?.predicted_stints) {
      lstmPredictions.predicted_stints.forEach((stint) => {
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
      if (stint) {
        setSelectedLapRange([stint.LapStart, stint.LapStart + stint.StintLength - 1]);
      }
    });

    return () => {
      d3.select('body').select('.strat-tooltip').remove();
    };
  }, [strategies, selectedDrivers, currentLap, lstmPredictions, pcaStrategyAnalysis, geminiOverlays, showOverlays, toggleDriver, setHighlightedDriver, setSelectedStint, highlightedCompound, selectedLapRange, setSelectedLapRange, simulatorStrategy]);

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
      </div>
    </Panel>
  );
}
