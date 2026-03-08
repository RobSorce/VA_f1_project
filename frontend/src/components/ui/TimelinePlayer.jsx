import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useReplayEngine } from '../../hooks/useReplayEngine';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';

const SPEED_OPTIONS = [0.5, 1, 2, 5, 10, 20, 50];

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

  const [expanded, setExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tooltipData, setTooltipData] = useState(null);

  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const qualiSvgRef = useRef(null);
  const collapseTimerRef = useRef(null);
  const interactingRef = useRef(false);

  const sessionType = useF1Store((s) => s.sessionType);
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
    const width = containerEl.clientWidth;
    const hasDriverSelection = selectedDrivers?.length > 0;
    const height = hasDriverSelection ? 78 : 68;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const margin = { left: 12, right: 12, top: 14, bottom: 14 };
    const trackY = margin.top + 12;
    const trackHeight = 6;
    const innerWidth = width - margin.left - margin.right;
    // Layer 3 markers go below tick labels (only used when drivers are selected)
    const layer3Y = trackY + trackHeight + 22;

    const xScale = d3.scaleLinear().domain([1, maxLap]).range([margin.left, margin.left + innerWidth]);

    // Helper: resolve event x position. Uses lap-based positioning (now accurate
    // thanks to frame-data lookup). Falls back to time-fraction for band width
    // when laps collapse (e.g. red flag: no laps complete during suspension).
    const eventX = (evt, which = 'start') => {
      return xScale(which === 'end' ? evt.endLap : evt.startLap);
    };
    // For bands: check if we need time-fraction fallback (when lap span is tiny
    // but time span is significant, like a red flag suspension)
    const bandX = (evt) => {
      const x1 = xScale(evt.startLap);
      const x2 = xScale(Math.max(evt.endLap, evt.startLap + 0.5));
      const lapW = x2 - x1;
      // If the band is very narrow but the event has significant time span, use time fractions
      const sf = evt.startTimeFraction;
      const ef = evt.endTimeFraction;
      if (lapW < 20 && sf != null && ef != null && (ef - sf) > 0.02) {
        return {
          x1: margin.left + sf * innerWidth,
          x2: margin.left + ef * innerWidth,
        };
      }
      return { x1, x2 };
    };

    const g = svg.append('g');

    // Track background
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', innerWidth)
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', 'rgba(255, 255, 255, 0.08)');

    // Progress fill (drawn BEFORE event bands so events render on top)
    const progressWidth = xScale(currentLap) - margin.left;
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', Math.max(0, progressWidth))
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', '#e10600');

    // Safety Car / VSC / Red Flag bands (rendered ON TOP of progress fill)
    const segmentEvents = raceEvents.filter(
      (e) => e.type === 'SAFETY_CAR' || e.type === 'VSC' || e.type === 'RED_FLAG'
    );
    for (const evt of segmentEvents) {
      const { x1, x2: x2Raw } = bandX(evt);
      const bandW = Math.max(x2Raw - x1, 6);
      // Full-height background band
      g.append('rect')
        .attr('x', x1)
        .attr('y', 2)
        .attr('width', bandW)
        .attr('height', height - 4)
        .attr('rx', 2)
        .attr('fill', evt.type === 'VSC' ? 'rgba(255, 140, 0, 0.12)' : evt.type === 'RED_FLAG' ? 'rgba(255, 0, 0, 0.15)' : 'rgba(255, 204, 0, 0.12)');
      // Track-level band (on top of progress fill)
      g.append('rect')
        .attr('x', x1)
        .attr('y', trackY - 1)
        .attr('width', bandW)
        .attr('height', trackHeight + 2)
        .attr('rx', 2)
        .attr('fill', evt.color)
        .attr('opacity', 0.5);
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
        .attr('stroke', isMain ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)')
        .attr('stroke-width', isMain ? 1 : 0.5);

      if (isMain) {
        g.append('text')
          .attr('x', x)
          .attr('y', trackY + trackHeight + 2 + tickH + 9)
          .attr('text-anchor', 'middle')
          .attr('fill', 'rgba(255,255,255,0.35)')
          .attr('font-size', '8px')
          .attr('font-family', 'var(--font-mono)')
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

    for (const evt of raceEvents) {
      const x = eventX(evt, 'start');
      const markerY = trackY - 7;

      // ── Layer 1: Green Flag ──
      if (evt.type === 'GREEN_FLAG') {
        const marker = markersG.append('circle')
          .attr('cx', x).attr('cy', markerY)
          .attr('r', 4)
          .attr('fill', evt.color)
          .attr('stroke', 'rgba(0,0,0,0.5)')
          .attr('stroke-width', 1)
          .style('cursor', 'pointer');
        marker
          .on('mouseenter', (event) => {
            d3.select(event.target).attr('r', 6);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', (event) => {
            d3.select(event.target).attr('r', 4);
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => { seekToLap(evt.lap); });

      // ── Layer 1: SC / VSC / Red Flag markers ──
      } else if (evt.type === 'SAFETY_CAR' || evt.type === 'VSC' || evt.type === 'RED_FLAG') {
        const scG = markersG.append('g')
          .attr('transform', `translate(${x}, ${markerY})`)
          .style('cursor', 'pointer');
        scG.append('circle')
          .attr('r', 5)
          .attr('fill', evt.color)
          .attr('stroke', 'rgba(0,0,0,0.5)')
          .attr('stroke-width', 1);
        scG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#000')
          .attr('font-size', '6px')
          .attr('font-weight', '900')
          .text(evt.type === 'VSC' ? 'V' : evt.type === 'RED_FLAG' ? 'R' : 'SC');
        scG
          .on('mouseenter', (event) => {
            scG.select('circle').attr('r', 7);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            scG.select('circle').attr('r', 5);
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
        const size = 8;
        const sq = 2;
        const flagG = markersG.append('g').attr('transform', `translate(${x - size / 2}, ${markerY - size / 2})`);
        flagG.append('rect').attr('width', size).attr('height', size).attr('fill', '#ffffff').attr('rx', 1);
        for (let row = 0; row < size / sq; row++) {
          for (let col = 0; col < size / sq; col++) {
            if ((row + col) % 2 === 0) {
              flagG.append('rect')
                .attr('x', col * sq).attr('y', row * sq)
                .attr('width', sq).attr('height', sq)
                .attr('fill', '#000000');
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
        const r = evt.count > 3 ? 6 : 5;
        pitG.append('circle')
          .attr('r', r)
          .attr('fill', 'rgba(0, 191, 255, 0.15)')
          .attr('stroke', '#00bfff')
          .attr('stroke-width', 1);
        pitG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#00bfff')
          .attr('font-size', '7px')
          .attr('font-weight', '900')
          .text(evt.count || 'P');
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

      // ── Layer 2: Fastest lap (only the final one) ──
      } else if (evt.type === 'FASTEST_LAP') {
        const flG = markersG.append('g')
          .attr('transform', `translate(${x}, ${markerY})`)
          .style('cursor', 'pointer');
        flG.append('path')
          .attr('d', 'M0,-5 L4,0 L0,5 L-4,0 Z')
          .attr('fill', '#a855f7')
          .attr('stroke', 'rgba(168,85,247,0.5)')
          .attr('stroke-width', 0.5)
          .attr('filter', 'drop-shadow(0 0 3px rgba(168,85,247,0.6))');
        flG
          .on('mouseenter', (event) => {
            flG.select('path').attr('d', 'M0,-7 L5,0 L0,7 L-5,0 Z');
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            flG.select('path').attr('d', 'M0,-5 L4,0 L0,5 L-4,0 Z');
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => {
            seekToLap(evt.lap);
            if (evt.driver) setHighlightedDriver(evt.driver);
          });

      // ── Layer 3: Driver pit stop (only for selected drivers) ──
      } else if (evt.type === 'DRIVER_PIT' && hasSelection && selSet.has(evt.driver)) {
        const drvColor = getDriverColor(evt.driver);
        const dpG = markersG.append('g')
          .attr('transform', `translate(${x}, ${layer3Y})`)
          .style('cursor', 'pointer');
        dpG.append('rect')
          .attr('x', -5).attr('y', -5)
          .attr('width', 10).attr('height', 10)
          .attr('rx', 2)
          .attr('fill', drvColor)
          .attr('opacity', 0.9)
          .attr('stroke', 'rgba(255,255,255,0.3)')
          .attr('stroke-width', 0.5);
        dpG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#000')
          .attr('font-size', '6px')
          .attr('font-weight', '900')
          .text('P');
        dpG
          .on('mouseenter', (event) => {
            dpG.select('rect').attr('x', -6).attr('y', -6).attr('width', 12).attr('height', 12);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
            setHighlightedDriver(evt.driver);
          })
          .on('mouseleave', () => {
            dpG.select('rect').attr('x', -5).attr('y', -5).attr('width', 10).attr('height', 10);
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
        const drvColor = getDriverColor(evt.driver);
        const isGain = evt.color === '#22c55e';
        const pcG = markersG.append('g')
          .attr('transform', `translate(${x}, ${layer3Y})`)
          .style('cursor', 'pointer');
        pcG.append('path')
          .attr('d', isGain ? 'M0,-5 L5,5 L-5,5 Z' : 'M0,5 L5,-5 L-5,-5 Z')
          .attr('fill', drvColor)
          .attr('stroke', isGain ? '#22c55e' : '#ef4444')
          .attr('stroke-width', 1)
          .attr('opacity', 0.9);
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
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');

    markersG.append('circle')
      .attr('cx', playheadX)
      .attr('cy', trackY + trackHeight / 2)
      .attr('r', 5)
      .attr('fill', '#e10600')
      .attr('stroke', '#ffffff')
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
  }, [expanded, hasData, maxLap, currentLap, raceEvents, seekToLap, seekToFrame, totalFrames, openPanel, setSelectedLapRange, setHighlightedDriver, selectedDrivers, isQualifyingReplay]);

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
    const width = containerEl.clientWidth;
    const height = 68;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const margin = { left: 12, right: 12, top: 14, bottom: 14 };
    const trackY = margin.top + 12;
    const trackHeight = 6;
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
      .attr('fill', 'rgba(255, 255, 255, 0.08)');

    // Progress fill
    const currentTime = frames[Math.min(currentFrameIndex, frames.length - 1)]?.t || 0;
    const progressWidth = xScale(currentTime) - margin.left;
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', Math.max(0, progressWidth))
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', '#e10600');

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
        .attr('stroke', isMain ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)')
        .attr('stroke-width', isMain ? 1 : 0.5);

      if (isMain) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        g.append('text')
          .attr('x', x)
          .attr('y', trackY + trackHeight + 2 + tickH + 9)
          .attr('text-anchor', 'middle')
          .attr('fill', 'rgba(255,255,255,0.35)')
          .attr('font-size', '8px')
          .attr('font-family', 'var(--font-mono)')
          .text(`${mins}:${String(secs).padStart(2, '0')}`);
      }
    }

    // Segment label
    g.append('text')
      .attr('x', margin.left + 4)
      .attr('y', trackY - 4)
      .attr('fill', 'rgba(255,255,255,0.6)')
      .attr('font-size', '9px')
      .attr('font-weight', '700')
      .attr('font-family', 'var(--font-mono)')
      .text(qualiSegment);

    // Frame count
    g.append('text')
      .attr('x', margin.left + innerWidth - 4)
      .attr('y', trackY - 4)
      .attr('text-anchor', 'end')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-family', 'var(--font-mono)')
      .text(`Frame ${currentFrameIndex + 1}/${totalFrames}`);

    // Playhead
    const playheadX = xScale(currentTime);
    g.append('line')
      .attr('x1', playheadX).attr('x2', playheadX)
      .attr('y1', trackY - 10)
      .attr('y2', trackY + trackHeight + 2)
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round');
    g.append('circle')
      .attr('cx', playheadX)
      .attr('cy', trackY + trackHeight / 2)
      .attr('r', 5)
      .attr('fill', '#e10600')
      .attr('stroke', '#ffffff')
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
  }, [expanded, isQualifyingReplay, frameData, currentFrameIndex, totalFrames, qualiSegment, seekToFrame]);

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
    const flagColors = { '1': '#00ff00', '2': '#ffcc00', '4': '#ffcc00', '5': '#ff0000', '6': '#ff8c00', '7': '#ff8c00' };
    return (
      <div className="timeline-player collapsed timeline-player--live">
        <div className="timeline-player__collapsed-row">
          <div className="timeline-player__left" style={{ gap: '8px' }}>
            <span className={`live-pulse${liveConnected ? ' active' : ''}`} />
            <span className="live-badge">LIVE</span>
            <span
              className="timeline-player__flag-dot"
              style={{ backgroundColor: flagColors[flagStatus] || '#00ff00' }}
            />
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
              onClick={exitLiveMode}
              style={{
                marginLeft: 8, padding: '3px 10px', borderRadius: 4,
                border: '1px solid rgba(239,68,68,0.3)',
                background: 'rgba(239,68,68,0.1)',
                color: '#f87171', fontSize: 9, fontWeight: 700,
                letterSpacing: '0.06em', cursor: 'pointer',
                fontFamily: "'Formula1', 'Titillium Web', sans-serif",
              }}
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
              title="Skip to end"
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
                {/* ── Legend below SVG ── */}
                <div className="timeline-player__legend">
                  <span className="timeline-player__legend-item">
                    <span className="timeline-player__legend-dot" style={{ backgroundColor: '#00ff00' }} />
                    Start
                  </span>
                  <span className="timeline-player__legend-item">
                    <span className="timeline-player__legend-dot" style={{ backgroundColor: '#ffcc00' }} />
                    SC
                  </span>
                  <span className="timeline-player__legend-item">
                    <span className="timeline-player__legend-dot" style={{ backgroundColor: '#ff8c00' }} />
                    VSC
                  </span>
                  <span className="timeline-player__legend-item">
                    <span className="timeline-player__legend-dot" style={{ backgroundColor: '#ff0000' }} />
                    Red
                  </span>
                  <span className="timeline-player__legend-divider" />
                  <span className="timeline-player__legend-item">
                    <span className="timeline-player__legend-dot" style={{ backgroundColor: '#00bfff', borderRadius: '50%', border: '1px solid #00bfff' }} />
                    Pits
                  </span>
                  <span className="timeline-player__legend-item">
                    <svg width="7" height="7" style={{ flexShrink: 0 }}><path d="M3.5,0 L7,3.5 L3.5,7 L0,3.5 Z" fill="#a855f7" /></svg>
                    FL
                  </span>
                  {selectedDrivers?.length > 0 && (
                    <>
                      <span className="timeline-player__legend-divider" />
                      <span className="timeline-player__legend-item timeline-player__legend-item--driver">
                        <svg width="7" height="7" style={{ flexShrink: 0 }}>
                          <rect width="7" height="7" rx="1.5" fill="rgba(255,255,255,0.5)" />
                        </svg>
                        Pit
                      </span>
                      <span className="timeline-player__legend-item timeline-player__legend-item--driver">
                        <svg width="7" height="7" style={{ flexShrink: 0 }}>
                          <path d="M3.5,0 L7,7 L0,7 Z" fill="rgba(255,255,255,0.5)" stroke="#22c55e" strokeWidth="1" />
                        </svg>
                        Move
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="timeline-player__speed-pills">
              {SPEED_OPTIONS.map((speed) => (
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
