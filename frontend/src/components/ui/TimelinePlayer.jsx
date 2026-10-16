import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useReplayEngine, trackStatusBandLaps } from '../../hooks/useReplayEngine';
import { useF1Store, loadedSessionTypeOf } from '../../store/useF1Store';
import {
  CHART_FONT, DIVERGING, FLAG_COLORS, STATUS_COLORS, STATUS_GLYPHS, TRACK_STATUS_STYLES, UI_COLORS,
  chartFontPx, contrastText, getDriverColor, markColor, withAlpha,
} from '../../utils/colors';
import { useChartBox } from '../../utils/views/chartBox';
import { PLAYBACK_SPEEDS } from '../../utils/playbackSpeed';

// Track-status events of the timeline: FIA colour (utils/colors.js) and the
// letter drawn in the marker and in the legend, so the colour is never the
// only cue (SC and VSC share the safety-car amber, told apart by SC / V).
const EVENT_STYLES = {
  GREEN_FLAG: { color: FLAG_COLORS.green, glyph: 'G', label: 'Start' },
  YELLOW_FLAG: { color: FLAG_COLORS.yellow, glyph: 'Y', label: 'Yellow' },
  SAFETY_CAR: { color: FLAG_COLORS.safetyCar, glyph: 'SC', label: 'SC' },
  VSC: { color: FLAG_COLORS.safetyCar, glyph: 'V', label: 'VSC' },
  RED_FLAG: { color: FLAG_COLORS.red, glyph: 'R', label: 'Red' },
};
const LEGEND_EVENTS = ['GREEN_FLAG', 'YELLOW_FLAG', 'SAFETY_CAR', 'VSC', 'RED_FLAG'];
// Event marker radius (px): room for a two-letter glyph at the label size
const MARKER_R = 8;
// Neutral strokes of the timeline (not data): track, minor / major ticks
const TRACK_FILL = 'rgba(255, 255, 255, 0.08)';
const TICK_MINOR = 'rgba(255,255,255,0.25)';
const TICK_MAJOR = 'rgba(255,255,255,0.5)';
// A position change marker gains when the event says so (change > 0, or
// "gained" in its description for events without the number)
const isPositionGain = (evt) => (evt.change != null ? evt.change > 0 : / gained /.test(evt.description || ''));

/**
 * Collapsible timeline player rendered at the bottom of the dashboard.
 * Replaces the original Footer component.
 *
 * - Collapsed (~40px): thin progress bar, current lap text, play/pause button.
 * - Expanded (~100px on hover): full D3 scrubable timeline with lap ticks,
 *   event markers, speed pills, and skip controls.
 */
export default function TimelinePlayer() {
  const {
    currentLap,
    maxLap,
    isPlaying,
    playSpeed,
    raceEvents,
    togglePlayPause,
    seekToLap,
    seekToFrame,
    skipToStart,
    skipToEnd,
    setPlaySpeed,
    currentFrameIndex,
    totalFrames,
    isLiveMode,
  } = useReplayEngine();

  const isLoadingFrames = useF1Store((s) => s.isLoadingFrames);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const frameData = useF1Store((s) => s.frameData);
  const openPanel = useF1Store((s) => s.openPanel);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const qualiSegment = useF1Store((s) => s.qualiSegment);
  const qualiSegments = useF1Store((s) => s.qualiSegments);
  const setQualiSegment = useF1Store((s) => s.setQualiSegment);
  // Lap mode: the race-over state (after the leader's last lap, skip-to-end)
  const lapModeRaceOver = useF1Store((s) => s.lapModeRaceOver && s.totalFrames === 0);

  const [expanded, setExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tooltipData, setTooltipData] = useState(null);

  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const qualiSvgRef = useRef(null);
  // The width the expanded timeline fills, kept up to date (D4, the shared
  // hook of utils/views/chartBox.js): a resize while the strip is expanded
  // lays it out again, not only the next lap or the next expand
  const timelineBox = useChartBox(svgRef);
  const qualiBox = useChartBox(qualiSvgRef);
  const collapseTimerRef = useRef(null);
  const interactingRef = useRef(false);

  const sessionType = useF1Store(loadedSessionTypeOf); // the loaded session, not the pill
  const hasFrames = totalFrames > 1;
  const isNonRace = sessionType && sessionType !== 'R' && sessionType !== 'S' && sessionType !== 'Q';
  const hasData = maxLap > 1 || hasFrames;
  const canPlay = hasFrames; // Race, sprint, and qualifying with frames can play
  // Progress based on frame index for smooth progress bar movement
  const progress = totalFrames > 1
    ? currentFrameIndex / (totalFrames - 1)
    : (maxLap > 1 ? (currentLap - 1) / (maxLap - 1) : 0);

  // ── Auto-collapse logic ──────────────────────────────────────────
  const startCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = setTimeout(() => {
      if (!interactingRef.current) {
        setExpanded(false);
      }
    }, 1500);
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    setExpanded(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    interactingRef.current = false;
    startCollapseTimer();
  }, [startCollapseTimer]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, []);

  // ── Collapsed progress bar click-to-seek ────────────────────────
  const handleProgressBarClick = useCallback(
    (e) => {
      if (!hasData) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      // Seek to frame position for smooth scrubbing
      if (totalFrames > 1) {
        seekToFrame(Math.round(fraction * (totalFrames - 1)));
      } else {
        const lap = Math.round(1 + fraction * (maxLap - 1));
        seekToLap(lap);
      }
    },
    [hasData, maxLap, totalFrames, seekToLap, seekToFrame]
  );

  // ── D3 Timeline rendering (race/sprint only — qualifying has maxLap=1) ──
  useEffect(() => {
    if (!expanded || !svgRef.current || !hasData || isQualifyingReplay || maxLap <= 1) return;

    const svg = d3.select(svgRef.current);
    const containerEl = svgRef.current.parentElement;
    const width = timelineBox.width > 0 ? timelineBox.width : containerEl.clientWidth;
    const hasDriverSelection = selectedDrivers?.length > 0;
    // Geometry from the type tokens: tick labels at the data size, marker
    // letters at the label size (utils/colors.js CHART_FONT, >= 11 / 10 px)
    const tickPx = chartFontPx('data');
    const margin = { left: 12, right: 12, top: 2 * MARKER_R + 2, bottom: 4 };
    const trackY = margin.top + 2;
    const trackHeight = 6;
    const tickLabelY = trackY + trackHeight + 2 + 8 + tickPx;
    // Layer 3 markers go below tick labels (only used when drivers are selected)
    const layer3Y = tickLabelY + 10;
    const height = hasDriverSelection ? layer3Y + 8 : tickLabelY + margin.bottom;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const innerWidth = width - margin.left - margin.right;

    const xScale = d3.scaleLinear().domain([1, maxLap]).range([margin.left, margin.left + innerWidth]);

    // Helper: resolve event x position on the lap axis
    const eventX = (evt, which = 'start') => {
      return xScale(which === 'end' ? evt.endLap : evt.startLap);
    };
    // Bands: the period's leader laps on the same lap axis
    // (trackStatusBandLaps), never replay-time fractions (another axis)
    const bandX = (evt) => {
      const [from, to] = trackStatusBandLaps(evt, maxLap);
      return { x1: xScale(from), x2: xScale(to) };
    };

    const g = svg.append('g');

    // Track background
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', innerWidth)
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', TRACK_FILL);

    // Progress fill (drawn BEFORE event bands so events render on top)
    const progressWidth = xScale(currentLap) - margin.left;
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', Math.max(0, progressWidth))
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', UI_COLORS.accent);

    // Safety Car / VSC / Red Flag / Yellow Flag bands (rendered ON TOP of progress fill).
    // Causal: only periods started at the replay's now, a running one ending
    // on the leader's current lap (hooks/useReplayEngine.js buildTrackStatusEvents)
    const segmentEvents = raceEvents.filter(
      (e) => e.type === 'SAFETY_CAR' || e.type === 'VSC' || e.type === 'RED_FLAG' || e.type === 'YELLOW_FLAG'
    );
    for (const evt of segmentEvents) {
      const { x1: x1Raw, x2: x2Raw } = bandX(evt);
      const bandW = Math.max(x2Raw - x1Raw, 6);
      // A minimum-width band on the last lap stays inside the track
      const x1 = Math.min(x1Raw, margin.left + innerWidth - bandW);
      // Full-height background band, a tint of the status colour
      const st = EVENT_STYLES[evt.type];
      const bgFill = withAlpha(st.color, evt.type === 'YELLOW_FLAG' ? 0.08 : 0.14);
      g.append('rect')
        .attr('x', x1)
        .attr('y', 2)
        .attr('width', bandW)
        .attr('height', height - 4)
        .attr('rx', 2)
        .attr('fill', bgFill);
      // Track-level band (on top of progress fill)
      g.append('rect')
        .attr('x', x1)
        .attr('y', trackY - 1)
        .attr('width', bandW)
        .attr('height', trackHeight + 2)
        .attr('rx', 2)
        .attr('fill', st.color)
        .attr('opacity', 0.6);
    }

    // Lap tick marks
    const tickInterval = maxLap <= 30 ? 1 : maxLap <= 60 ? 5 : 10;
    for (let lap = 1; lap <= maxLap; lap++) {
      const isMain = lap === 1 || lap === maxLap || lap % tickInterval === 0;
      const tickH = isMain ? 8 : 4;
      const x = xScale(lap);
      g.append('line')
        .attr('x1', x)
        .attr('x2', x)
        .attr('y1', trackY + trackHeight + 2)
        .attr('y2', trackY + trackHeight + 2 + tickH)
        .attr('stroke', isMain ? TICK_MAJOR : TICK_MINOR)
        .attr('stroke-width', isMain ? 1 : 0.5);

      if (isMain) {
        g.append('text')
          .attr('x', x)
          .attr('y', tickLabelY)
          .attr('text-anchor', 'middle')
          .style('fill', 'var(--color-text-muted)')
          .style('font-size', CHART_FONT.data)
          .style('font-family', 'var(--font-mono)')
          .text(lap);
      }
    }

    // Click-to-seek hit area (inside g, BEFORE the marker group so markers render on top)
    const seekFromEvent = (event) => {
      const rect = svgRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const lap = xScale.invert(mouseX);
      seekToLap(Math.round(lap));
    };

    g.append('rect')
      .attr('x', margin.left)
      .attr('y', 0)
      .attr('width', innerWidth)
      .attr('height', height)
      .attr('fill', 'transparent')
      .style('cursor', 'pointer')
      .on('mousedown', (event) => {
        event.preventDefault();
        setIsDragging(true);
        interactingRef.current = true;
        seekFromEvent(event);
      });

    // Marker group (rendered AFTER hitArea so markers are on top and get pointer events)
    const markersG = g.append('g');

    // ── Event markers (layered rendering) ─────────────────────────
    // Layer 1: Race-level context (always visible)
    // Layer 2: Aggregated race events (always visible, refined)
    // Layer 3: Driver-specific events (only for selected drivers — coordinated view)
    const selSet = new Set(selectedDrivers || []);
    const hasSelection = selSet.size > 0;

    // A track-status marker: the status colour with its letter (EVENT_STYLES)
    const statusMarker = (x, y, type) => {
      const st = EVENT_STYLES[type];
      const mG = markersG.append('g')
        .attr('transform', `translate(${x}, ${y})`)
        .style('cursor', 'pointer');
      mG.append('circle')
        .attr('r', MARKER_R)
        .attr('fill', st.color)
        .attr('stroke', 'rgba(0,0,0,0.6)')
        .attr('stroke-width', 1);
      mG.append('text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('fill', contrastText(st.color))
        .style('font-size', CHART_FONT.label)
        .attr('font-weight', '900')
        .text(st.glyph);
      return mG;
    };

    for (const evt of raceEvents) {
      const x = eventX(evt, 'start');
      const markerY = trackY - MARKER_R - 1;

      // ── Layer 1: Green Flag ──
      if (evt.type === 'GREEN_FLAG') {
        const marker = statusMarker(x, markerY, evt.type);
        marker
          .on('mouseenter', (event) => {
            marker.select('circle').attr('r', MARKER_R + 2);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            marker.select('circle').attr('r', MARKER_R);
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => { seekToLap(evt.lap); });

      // ── Layer 1: SC / VSC / Red Flag / Yellow Flag markers ──
      } else if (evt.type === 'SAFETY_CAR' || evt.type === 'VSC' || evt.type === 'RED_FLAG' || evt.type === 'YELLOW_FLAG') {
        const scG = statusMarker(x, markerY, evt.type);
        scG
          .on('mouseenter', (event) => {
            scG.select('circle').attr('r', MARKER_R + 2);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            scG.select('circle').attr('r', MARKER_R);
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => {
            if (evt.startTimeFraction != null && totalFrames > 1) {
              seekToFrame(Math.round(evt.startTimeFraction * (totalFrames - 1)));
            } else {
              seekToLap(evt.startLap);
            }
            setSelectedLapRange([evt.startLap, evt.endLap]);
          });

      // ── Layer 1: Chequered Flag ──
      } else if (evt.type === 'CHEQUERED_FLAG') {
        const size = 12;
        const sq = 3;
        const flagG = markersG.append('g').attr('transform', `translate(${x - size / 2}, ${markerY - size / 2})`);
        flagG.append('rect').attr('width', size).attr('height', size).attr('fill', FLAG_COLORS.chequered).attr('rx', 1);
        for (let row = 0; row < size / sq; row++) {
          for (let col = 0; col < size / sq; col++) {
            if ((row + col) % 2 === 0) {
              flagG.append('rect')
                .attr('x', col * sq).attr('y', row * sq)
                .attr('width', sq).attr('height', sq)
                .attr('fill', contrastText(FLAG_COLORS.chequered));
            }
          }
        }
        flagG.style('cursor', 'pointer')
          .on('mouseenter', (event) => {
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
          })
          .on('mouseleave', () => setTooltipData(null))
          .on('click', () => { seekToLap(evt.lap); });

      // ── Layer 2: Pit window (aggregated, shows count) ──
      } else if (evt.type === 'PIT_WINDOW') {
        const pitG = markersG.append('g')
          .attr('transform', `translate(${x}, ${markerY})`)
          .style('cursor', 'pointer');
        // Pit stops: the timing pit colour, the number of stops (or P) inside
        const r = MARKER_R;
        pitG.append('circle')
          .attr('r', r)
          .attr('fill', STATUS_COLORS.pit)
          .attr('stroke', 'rgba(0,0,0,0.6)')
          .attr('stroke-width', 1);
        pitG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', contrastText(STATUS_COLORS.pit))
          .style('font-size', CHART_FONT.label)
          .attr('font-weight', '900')
          .text(evt.count || STATUS_GLYPHS.pit);
        pitG
          .on('mouseenter', (event) => {
            pitG.select('circle').attr('r', r + 2);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            pitG.select('circle').attr('r', r);
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => {
            seekToLap(evt.lap);
            openPanel('degradation');
          });

      // ── Layer 2: Fastest lap among the laps completed at the replay's now
      // (hooks/useReplayEngine.js fastestLapEvent): never a lap not run yet ──
      } else if (evt.type === 'FASTEST_LAP') {
        const flG = markersG.append('g')
          .attr('transform', `translate(${x}, ${markerY})`)
          .style('cursor', 'pointer');
        // Fastest lap: the overall-best diamond of the timing views
        flG.append('path')
          .attr('d', 'M0,-7 L6,0 L0,7 L-6,0 Z')
          .attr('fill', STATUS_COLORS.overallBest)
          .attr('stroke', 'rgba(0,0,0,0.6)')
          .attr('stroke-width', 1);
        flG
          .on('mouseenter', (event) => {
            flG.select('path').attr('d', 'M0,-9 L7,0 L0,9 L-7,0 Z');
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            flG.select('path').attr('d', 'M0,-7 L6,0 L0,7 L-6,0 Z');
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => {
            seekToLap(evt.lap);
            if (evt.driver) setHighlightedDriver(evt.driver);
          });

      // ── Layer 3: Driver pit stop (only for selected drivers) ──
      } else if (evt.type === 'DRIVER_PIT' && hasSelection && selSet.has(evt.driver)) {
        const drvColor = markColor(getDriverColor(evt.driver));
        const dpG = markersG.append('g')
          .attr('transform', `translate(${x}, ${layer3Y})`)
          .style('cursor', 'pointer');
        dpG.append('rect')
          .attr('x', -7).attr('y', -7)
          .attr('width', 14).attr('height', 14)
          .attr('rx', 2)
          .attr('fill', drvColor)
          .attr('stroke', 'rgba(0,0,0,0.6)')
          .attr('stroke-width', 1);
        dpG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', contrastText(drvColor))
          .style('font-size', CHART_FONT.label)
          .attr('font-weight', '900')
          .text(STATUS_GLYPHS.pit);
        dpG
          .on('mouseenter', (event) => {
            dpG.select('rect').attr('x', -8).attr('y', -8).attr('width', 16).attr('height', 16);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
            setHighlightedDriver(evt.driver);
          })
          .on('mouseleave', () => {
            dpG.select('rect').attr('x', -7).attr('y', -7).attr('width', 14).attr('height', 14);
            setTooltipData(null);
            interactingRef.current = false;
            setHighlightedDriver(null);
          })
          .on('click', () => {
            seekToLap(evt.lap);
            openPanel('degradation');
          });

      // ── Layer 3: Position change (only for selected drivers) ──
      } else if (evt.type === 'POSITION_CHANGE' && hasSelection && selSet.has(evt.driver)) {
        // Up triangle = places gained, down = lost (the shape is the cue;
        // the outline repeats it in the diverging blue / orange)
        const drvColor = markColor(getDriverColor(evt.driver));
        const isGain = isPositionGain(evt);
        const pcG = markersG.append('g')
          .attr('transform', `translate(${x}, ${layer3Y})`)
          .style('cursor', 'pointer');
        pcG.append('path')
          .attr('d', isGain ? 'M0,-6 L6,6 L-6,6 Z' : 'M0,6 L6,-6 L-6,-6 Z')
          .attr('fill', drvColor)
          .attr('stroke', isGain ? DIVERGING.better : DIVERGING.worse)
          .attr('stroke-width', 1.5);
        pcG
          .on('mouseenter', (event) => {
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
            setHighlightedDriver(evt.driver);
          })
          .on('mouseleave', () => {
            setTooltipData(null);
            interactingRef.current = false;
            setHighlightedDriver(null);
          })
          .on('click', () => {
            seekToLap(evt.lap);
            if (evt.driver) setHighlightedDriver(evt.driver);
          });
      }
    }

    // Playhead indicator (vertical line) — in markers group so it's on top
    const playheadX = xScale(currentLap);
    markersG.append('line')
      .attr('x1', playheadX)
      .attr('x2', playheadX)
      .attr('y1', trackY - 10)
      .attr('y2', trackY + trackHeight + 2)
      .attr('stroke', UI_COLORS.focusRing)
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');

    markersG.append('circle')
      .attr('cx', playheadX)
      .attr('cy', trackY + trackHeight / 2)
      .attr('r', 5)
      .attr('fill', UI_COLORS.accent)
      .attr('stroke', UI_COLORS.focusRing)
      .attr('stroke-width', 1.5);

    // Drag handlers for the hit area
    const handleDrag = (event) => {
      if (!isDragging) return;
      seekFromEvent(event);
    };

    const handleDragEnd = () => {
      setIsDragging(false);
      interactingRef.current = false;
    };

    svg.on('mousemove', handleDrag);
    svg.on('mouseup', handleDragEnd);
    svg.on('mouseleave', handleDragEnd);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, hasData, maxLap, currentLap, raceEvents, seekToLap, seekToFrame, totalFrames, openPanel, setSelectedLapRange, setHighlightedDriver, selectedDrivers, isQualifyingReplay, timelineBox.width]);

  // Handle drag on the SVG (additional global listener for edge cases)
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMove = (e) => {
      const activeSvg = isQualifyingReplay ? qualiSvgRef.current : svgRef.current;
      if (!activeSvg) return;
      const rect = activeSvg.getBoundingClientRect();
      const innerWidth = rect.width - 24;
      const mouseX = e.clientX - rect.left - 12;
      const fraction = Math.max(0, Math.min(1, mouseX / innerWidth));
      if (totalFrames > 1) {
        seekToFrame(Math.round(fraction * (totalFrames - 1)));
      } else {
        const lap = Math.round(1 + fraction * (maxLap - 1));
        seekToLap(lap);
      }
    };

    const handleGlobalUp = () => {
      setIsDragging(false);
      interactingRef.current = false;
    };

    window.addEventListener('mousemove', handleGlobalMove);
    window.addEventListener('mouseup', handleGlobalUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMove);
      window.removeEventListener('mouseup', handleGlobalUp);
    };
  }, [isDragging, maxLap, totalFrames, seekToLap, seekToFrame, isQualifyingReplay]);

  // ── D3 Timeline rendering for qualifying (frame/time-based) ──────
  useEffect(() => {
    if (!expanded || !qualiSvgRef.current || !isQualifyingReplay || !frameData?.frames?.length) return;

    const svg = d3.select(qualiSvgRef.current);
    const containerEl = qualiSvgRef.current.parentElement;
    const width = qualiBox.width > 0 ? qualiBox.width : containerEl.clientWidth;
    const tickPx = chartFontPx('data');
    const margin = { left: 12, right: 12, top: tickPx + 6, bottom: 4 };
    const trackY = margin.top + 4;
    const trackHeight = 6;
    const tickLabelY = trackY + trackHeight + 2 + 8 + tickPx;
    const height = tickLabelY + margin.bottom;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const innerWidth = width - margin.left - margin.right;

    const frames = frameData.frames;
    const maxTime = frames[frames.length - 1]?.t || 1;
    const xScale = d3.scaleLinear().domain([0, maxTime]).range([margin.left, margin.left + innerWidth]);

    const g = svg.append('g');

    // Track background
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', innerWidth)
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', TRACK_FILL);

    // Progress fill
    const currentTime = frames[Math.min(currentFrameIndex, frames.length - 1)]?.t || 0;
    const progressWidth = xScale(currentTime) - margin.left;
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', Math.max(0, progressWidth))
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', UI_COLORS.accent);

    // Time tick marks (every 60 seconds)
    const tickIntervalSec = maxTime <= 120 ? 30 : maxTime <= 300 ? 60 : 120;
    for (let t = 0; t <= maxTime; t += tickIntervalSec) {
      const isMain = t === 0 || Math.abs(t - maxTime) < tickIntervalSec || t % (tickIntervalSec * 2) === 0;
      const tickH = isMain ? 8 : 4;
      const x = xScale(t);
      g.append('line')
        .attr('x1', x).attr('x2', x)
        .attr('y1', trackY + trackHeight + 2)
        .attr('y2', trackY + trackHeight + 2 + tickH)
        .attr('stroke', isMain ? TICK_MAJOR : TICK_MINOR)
        .attr('stroke-width', isMain ? 1 : 0.5);

      if (isMain) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        g.append('text')
          .attr('x', x)
          .attr('y', tickLabelY)
          .attr('text-anchor', 'middle')
          .style('fill', 'var(--color-text-muted)')
          .style('font-size', CHART_FONT.data)
          .style('font-family', 'var(--font-mono)')
          .text(`${mins}:${String(secs).padStart(2, '0')}`);
      }
    }

    // Segment label
    g.append('text')
      .attr('x', margin.left + 4)
      .attr('y', trackY - 5)
      .style('fill', 'var(--color-text-secondary)')
      .style('font-size', CHART_FONT.data)
      .attr('font-weight', '700')
      .style('font-family', 'var(--font-mono)')
      .text(qualiSegment);

    // Frame count
    g.append('text')
      .attr('x', margin.left + innerWidth - 4)
      .attr('y', trackY - 5)
      .attr('text-anchor', 'end')
      .style('fill', 'var(--color-text-muted)')
      .style('font-size', CHART_FONT.data)
      .style('font-family', 'var(--font-mono)')
      .text(`Frame ${currentFrameIndex + 1}/${totalFrames}`);

    // Playhead
    const playheadX = xScale(currentTime);
    g.append('line')
      .attr('x1', playheadX).attr('x2', playheadX)
      .attr('y1', trackY - 4)
      .attr('y2', trackY + trackHeight + 2)
      .attr('stroke', UI_COLORS.focusRing)
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');
    g.append('circle')
      .attr('cx', playheadX)
      .attr('cy', trackY + trackHeight / 2)
      .attr('r', 5)
      .attr('fill', UI_COLORS.accent)
      .attr('stroke', UI_COLORS.focusRing)
      .attr('stroke-width', 1.5);

    // Click-to-seek hit area
    const hitArea = svg.append('rect')
      .attr('x', margin.left)
      .attr('y', 0)
      .attr('width', innerWidth)
      .attr('height', height - margin.bottom)
      .attr('fill', 'transparent')
      .style('cursor', 'pointer');

    hitArea.on('mousedown', (event) => {
      event.preventDefault();
      setIsDragging(true);
      interactingRef.current = true;
      const rect = qualiSvgRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, (mouseX - margin.left) / innerWidth));
      seekToFrame(Math.round(fraction * (totalFrames - 1)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, isQualifyingReplay, frameData, currentFrameIndex, totalFrames, qualiSegment, seekToFrame, qualiBox.width]);

  // Compute elapsed time from frame data
  const elapsedTime = useMemo(() => {
    if (!frameData?.frames?.length || currentFrameIndex <= 0) return null;
    const frame = frameData.frames[Math.min(currentFrameIndex, frameData.frames.length - 1)];
    if (!frame?.t) return null;
    const totalSec = frame.t;
    const mins = Math.floor(totalSec / 60);
    const secs = Math.floor(totalSec % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }, [frameData, currentFrameIndex]);

  const framesStatus = isLoadingFrames
    ? 'Loading telemetry...'
    : isQualifyingReplay && frameData?.frames?.length
      ? `${qualiSegment} — ${frameData.frames.length} frames`
      : frameData?.frames?.length
        ? (elapsedTime ? `${elapsedTime} elapsed` : `${frameData.frames.length} frames`)
        : isNonRace
          ? 'Use \u2190 \u2192 arrow keys to browse laps'
          : '';

  // ── Live mode: simplified bar ──────────────────────────────────
  if (isLiveMode) {
    const liveSessionInfo = useF1Store.getState().liveSessionInfo;
    const liveConnected = useF1Store.getState().liveConnected;
    const exitLiveMode = useF1Store.getState().exitLiveMode;
    const flagStatus = useF1Store.getState().currentFlagStatus;
    // Track status: FIA colour dot with its label (never the colour alone)
    const flag = TRACK_STATUS_STYLES[flagStatus] || TRACK_STATUS_STYLES['1'];
    return (
      <div className="timeline-player collapsed timeline-player--live">
        <div className="timeline-player__collapsed-row">
          <div className="timeline-player__left" style={{ gap: '8px' }}>
            <span className={`live-pulse${liveConnected ? ' active' : ''}`} />
            <span className="live-badge">LIVE</span>
            <span
              className="timeline-player__flag-dot"
              style={{ backgroundColor: flag.color }}
              aria-hidden="true"
            />
            <span className="timeline-player__flag-label">{flag.short}</span>
          </div>
          <div className="timeline-player__progress-track" style={{ pointerEvents: 'none' }}>
            <div
              className="timeline-player__progress-fill timeline-player__progress-fill--live"
              style={{ width: totalRaceLaps > 1 ? `${((currentLap - 1) / (totalRaceLaps - 1)) * 100}%` : '0%' }}
            />
          </div>
          <div className="timeline-player__right">
            <span className="timeline-player__lap-text">
              LAP <strong>{currentLap}</strong> / {totalRaceLaps || '?'}
            </span>
            <span className="timeline-player__status-text" style={{ color: 'var(--color-text-muted)' }}>
              {liveSessionInfo?.session_type || 'Race'}
              {liveSessionInfo?.event_name ? ` — ${liveSessionInfo.event_name}` : ''}
            </span>
            <button
              type="button"
              onClick={exitLiveMode}
              className="timeline-player__disconnect"
            >
              DISCONNECT
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className={`timeline-player ${expanded ? 'expanded' : 'collapsed'}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* ── Collapsed view ────────────────────────────────────── */}
        <div className="timeline-player__collapsed-row">
          <div className="timeline-player__left">
            <button
              className="timeline-player__skip-btn"
              onClick={skipToStart}
              disabled={!hasData}
              title="Skip to start"
            >
              {'\u23EE'}
            </button>
            <button
              className={`timeline-player__play-btn ${isPlaying ? 'playing' : ''} ${isLoadingFrames ? 'loading' : ''}`}
              onClick={togglePlayPause}
              disabled={!canPlay}
              title={!canPlay && isNonRace ? 'Replay not available for this session type' : isLoadingFrames ? 'Loading telemetry...' : isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {isLoadingFrames ? '\u23F3' : isPlaying ? '\u23F8' : '\u25B6'}
            </button>
            <button
              className="timeline-player__skip-btn"
              onClick={skipToEnd}
              disabled={!hasData}
              title={hasFrames ? 'Skip to end' : 'Skip to the race end (final results)'}
            >
              {'\u23ED'}
            </button>
          </div>

          {/* ── Qualifying segment pills ─────────────────────────── */}
          {isQualifyingReplay && qualiSegments && (
            <div className="timeline-player__quali-pills">
              {['Q1', 'Q2', 'Q3'].map((seg) => (
                <button
                  key={seg}
                  className={`timeline-player__quali-pill ${qualiSegment === seg ? 'active' : ''}`}
                  disabled={!qualiSegments[seg]}
                  onClick={() => setQualiSegment(seg)}
                  title={qualiSegments[seg] ? `${qualiSegments[seg].frames?.length || 0} frames` : 'No data'}
                >
                  {seg}
                </button>
              ))}
            </div>
          )}

          <div
            className="timeline-player__progress-track"
            onClick={handleProgressBarClick}
          >
            <div
              className="timeline-player__progress-fill"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          <div className="timeline-player__right">
            <span className="timeline-player__lap-text">
              {isQualifyingReplay
                ? <><strong>{qualiSegment}</strong> &mdash; {elapsedTime || '0:00'}</>
                : lapModeRaceOver
                  ? <>LAP <strong>{currentLap}</strong> / {maxLap} &middot; FINISH</>
                  : <>LAP <strong>{currentLap}</strong> / {maxLap}</>
              }
            </span>
            {framesStatus && (
              <span
                className="timeline-player__status-text"
                style={{
                  color: isLoadingFrames
                    ? 'var(--color-accent-warning)'
                    : 'var(--color-text-muted)',
                }}
              >
                {framesStatus}
              </span>
            )}
          </div>
        </div>

        {/* ── Expanded view ─────────────────────────────────────── */}
        {expanded && (
          <div className="timeline-player__expanded-row">
            {isQualifyingReplay ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div className="timeline-player__timeline-wrapper">
                  <svg ref={qualiSvgRef} className="timeline-player__svg" />
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div className="timeline-player__timeline-wrapper">
                  <svg ref={svgRef} className="timeline-player__svg" />
                </div>
                {/* ── Legend below SVG: the markers as drawn ── */}
                <div className="timeline-player__legend">
                  {LEGEND_EVENTS.map((type) => {
                    const st = EVENT_STYLES[type];
                    return (
                      <span key={type} className="timeline-player__legend-item">
                        <svg className="timeline-player__legend-mark" width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
                          <circle r={MARKER_R} fill={st.color} />
                          <text textAnchor="middle" dominantBaseline="central" fill={contrastText(st.color)}
                                fontWeight="900" style={{ fontSize: CHART_FONT.label }}>{st.glyph}</text>
                        </svg>
                        {st.label}
                      </span>
                    );
                  })}
                  <span className="timeline-player__legend-divider" />
                  <span className="timeline-player__legend-item">
                    <svg className="timeline-player__legend-mark" width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
                      <circle r={MARKER_R} fill={STATUS_COLORS.pit} />
                      <text textAnchor="middle" dominantBaseline="central" fill={contrastText(STATUS_COLORS.pit)}
                            fontWeight="900" style={{ fontSize: CHART_FONT.label }}>{STATUS_GLYPHS.pit}</text>
                    </svg>
                    Pit stops
                  </span>
                  <span className="timeline-player__legend-item">
                    <svg className="timeline-player__legend-mark" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                      <path d="M0,-7 L6,0 L0,7 L-6,0 Z" fill={STATUS_COLORS.overallBest} />
                    </svg>
                    Fastest lap
                  </span>
                  {selectedDrivers?.length > 0 && (
                    <>
                      <span className="timeline-player__legend-divider" />
                      <span className="timeline-player__legend-item timeline-player__legend-item--driver">
                        <svg className="timeline-player__legend-mark" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                          <rect x="-6" y="-6" width="12" height="12" rx="2" style={{ fill: 'var(--color-text-secondary)' }} />
                        </svg>
                        Driver pit
                      </span>
                      <span className="timeline-player__legend-item timeline-player__legend-item--driver">
                        <svg className="timeline-player__legend-mark" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                          <path d="M0,-6 L6,6 L-6,6 Z" style={{ fill: 'var(--color-text-secondary)' }} stroke={DIVERGING.better} strokeWidth="1.5" />
                        </svg>
                        Gained 3+
                      </span>
                      <span className="timeline-player__legend-item timeline-player__legend-item--driver">
                        <svg className="timeline-player__legend-mark" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                          <path d="M0,6 L6,-6 L-6,-6 Z" style={{ fill: 'var(--color-text-secondary)' }} stroke={DIVERGING.worse} strokeWidth="1.5" />
                        </svg>
                        Lost 3+
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="timeline-player__speed-pills">
              {PLAYBACK_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  className={`timeline-player__speed-pill ${playSpeed === speed ? 'active' : ''}`}
                  onClick={() => setPlaySpeed(speed)}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Tooltip ──────────────────────────────────────────────── */}
      {tooltipData && (
        <div
          className="timeline-player__tooltip"
          style={{
            left: tooltipData.x,
            top: tooltipData.y - 36,
          }}
        >
          {tooltipData.text}
        </div>
      )}
    </>
  );
}
