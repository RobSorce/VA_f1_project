import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useReplayEngine } from '../../hooks/useReplayEngine';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS } from '../../utils/colors';

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
  } = useReplayEngine();

  const isLoadingFrames = useF1Store((s) => s.isLoadingFrames);
  const frameData = useF1Store((s) => s.frameData);
  const openPanel = useF1Store((s) => s.openPanel);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
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
    const height = 68;

    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    const margin = { left: 12, right: 12, top: 14, bottom: 14 };
    const trackY = margin.top + 12;
    const trackHeight = 6;
    const innerWidth = width - margin.left - margin.right;

    const xScale = d3.scaleLinear().domain([1, maxLap]).range([margin.left, margin.left + innerWidth]);

    const g = svg.append('g');

    // Track background
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', innerWidth)
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', 'rgba(255, 255, 255, 0.08)');

    // Safety Car / VSC / Red Flag bands (full-height behind everything)
    const segmentEvents = raceEvents.filter(
      (e) => e.type === 'SAFETY_CAR' || e.type === 'VSC' || e.type === 'RED_FLAG'
    );
    for (const evt of segmentEvents) {
      const x1 = xScale(evt.startLap);
      const x2 = xScale(Math.max(evt.endLap, evt.startLap + 0.5));
      const bandW = Math.max(x2 - x1, 4);
      // Full-height background band
      g.append('rect')
        .attr('x', x1)
        .attr('y', 2)
        .attr('width', bandW)
        .attr('height', height - 4)
        .attr('rx', 2)
        .attr('fill', evt.type === 'VSC' ? 'rgba(255, 140, 0, 0.08)' : evt.type === 'RED_FLAG' ? 'rgba(255, 0, 0, 0.1)' : 'rgba(255, 204, 0, 0.08)');
      // Track-level band
      g.append('rect')
        .attr('x', x1)
        .attr('y', trackY - 1)
        .attr('width', bandW)
        .attr('height', trackHeight + 2)
        .attr('rx', 2)
        .attr('fill', evt.color)
        .attr('opacity', 0.4);
    }

    // Progress fill
    const progressWidth = xScale(currentLap) - margin.left;
    g.append('rect')
      .attr('x', margin.left)
      .attr('y', trackY)
      .attr('width', Math.max(0, progressWidth))
      .attr('height', trackHeight)
      .attr('rx', 3)
      .attr('fill', '#e10600');

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

    // ── Event markers ───────────────────────────────────────────
    for (const evt of raceEvents) {
      const x = xScale(evt.startLap);
      const markerY = trackY - 7;

      if (evt.type === 'CHEQUERED_FLAG') {
        const size = 8;
        const sq = 2;
        const flagG = g.append('g').attr('transform', `translate(${x - size / 2}, ${markerY - size / 2})`);
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
      } else if (evt.type === 'PIT_WINDOW') {
        // Pit stop wrench icon
        const pitG = g.append('g')
          .attr('transform', `translate(${x}, ${markerY})`)
          .style('cursor', 'pointer');
        pitG.append('circle')
          .attr('r', 5)
          .attr('fill', 'rgba(0, 191, 255, 0.2)')
          .attr('stroke', '#00bfff')
          .attr('stroke-width', 1);
        pitG.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#00bfff')
          .attr('font-size', '7px')
          .attr('font-weight', '900')
          .text('P');
        pitG
          .on('mouseenter', (event) => {
            pitG.select('circle').attr('r', 7);
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            pitG.select('circle').attr('r', 5);
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => {
            seekToLap(evt.lap);
            openPanel('degradation');
          });
      } else if (evt.type === 'FASTEST_LAP') {
        // Purple diamond for fastest lap
        const flG = g.append('g')
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
      } else if (evt.type === 'POSITION_CHANGE') {
        // Small triangle for position changes
        const pcG = g.append('g')
          .attr('transform', `translate(${x}, ${trackY + trackHeight + 4})`)
          .style('cursor', 'pointer');
        const isGain = evt.color === '#22c55e';
        pcG.append('path')
          .attr('d', isGain ? 'M0,-3 L3,3 L-3,3 Z' : 'M0,3 L3,-3 L-3,-3 Z')
          .attr('fill', evt.color)
          .attr('opacity', 0.7);
        pcG
          .on('mouseenter', (event) => {
            setTooltipData({ x: event.clientX, y: event.clientY, text: evt.description });
            interactingRef.current = true;
          })
          .on('mouseleave', () => {
            setTooltipData(null);
            interactingRef.current = false;
          })
          .on('click', () => {
            seekToLap(evt.lap);
            if (evt.driver) setHighlightedDriver(evt.driver);
          });
      } else if (evt.type === 'SAFETY_CAR' || evt.type === 'VSC' || evt.type === 'RED_FLAG') {
        // SC/VSC/Red flag clickable marker
        const scG = g.append('g')
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
            seekToLap(evt.startLap);
            setSelectedLapRange([evt.startLap, evt.endLap]);
          });
      } else if (evt.type === 'GREEN_FLAG') {
        const marker = g.append('circle')
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
      }
    }

    // Playhead indicator (vertical line)
    const playheadX = xScale(currentLap);
    g.append('line')
      .attr('x1', playheadX)
      .attr('x2', playheadX)
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

    // Click-to-seek on the track area
    const hitArea = svg.append('rect')
      .attr('x', margin.left)
      .attr('y', 0)
      .attr('width', innerWidth)
      .attr('height', height - margin.bottom)
      .attr('fill', 'transparent')
      .style('cursor', 'pointer');

    const seekFromEvent = (event) => {
      const rect = svgRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const lap = xScale.invert(mouseX);
      seekToLap(Math.round(lap));
    };

    hitArea.on('mousedown', (event) => {
      event.preventDefault();
      setIsDragging(true);
      interactingRef.current = true;
      seekFromEvent(event);
    });

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
  }, [expanded, hasData, maxLap, currentLap, raceEvents, seekToLap, openPanel, setSelectedLapRange, setHighlightedDriver, isQualifyingReplay]);

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
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div className="timeline-player__timeline-wrapper">
                  <svg ref={svgRef} className="timeline-player__svg" />
                </div>
                {/* ── Legend ──────────────────────────────────────── */}
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
                    Red Flag
                  </span>
                  <span className="timeline-player__legend-item">
                    <span className="timeline-player__legend-dot" style={{ backgroundColor: '#00bfff' }} />
                    Pit
                  </span>
                  <span className="timeline-player__legend-item">
                    <svg width="8" height="8" style={{ flexShrink: 0 }}><path d="M4,0 L8,4 L4,8 L0,4 Z" fill="#a855f7" /></svg>
                    Fastest
                  </span>
                  <span className="timeline-player__legend-item">
                    <svg width="8" height="8" style={{ flexShrink: 0 }}><path d="M4,1 L7,7 L1,7 Z" fill="#22c55e" /></svg>
                    Overtake
                  </span>
                  <span className="timeline-player__legend-item">
                    <svg width="8" height="8" style={{ display: 'inline-block', flexShrink: 0 }}>
                      <rect width="8" height="8" fill="#fff" rx="1" />
                      <rect x="0" y="0" width="4" height="4" fill="#000" />
                      <rect x="4" y="4" width="4" height="4" fill="#000" />
                    </svg>
                    Finish
                  </span>
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
