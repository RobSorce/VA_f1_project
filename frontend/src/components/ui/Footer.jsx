import React, { useRef, useEffect, useCallback } from 'react';
import { useF1Store } from '../../store/useF1Store';

export default function Footer() {
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const isPlaying = useF1Store((s) => s.isPlaying);
  const playSpeed = useF1Store((s) => s.playSpeed);
  const setCurrentLap = useF1Store((s) => s.setCurrentLap);
  const setIsPlaying = useF1Store((s) => s.setIsPlaying);
  const setPlaySpeed = useF1Store((s) => s.setPlaySpeed);
  const isLoadingFrames = useF1Store((s) => s.isLoadingFrames);
  const frameData = useF1Store((s) => s.frameData);

  const intervalRef = useRef(null);

  const tick = useCallback(() => {
    const { currentLap, maxLap } = useF1Store.getState();
    if (currentLap >= maxLap) {
      useF1Store.getState().setIsPlaying(false);
      return;
    }
    useF1Store.getState().setCurrentLap(currentLap + 1);
  }, []);

  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(tick, 1000 / playSpeed);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, playSpeed, tick]);

  const togglePlay = () => {
    if (maxLap <= 1) return; // No data loaded
    if (currentLap >= maxLap) {
      // Restart from beginning
      setCurrentLap(1);
    }
    setIsPlaying(!isPlaying);
  };
  const stepBack = () => setCurrentLap(Math.max(1, currentLap - 1));
  const stepForward = () => setCurrentLap(Math.min(maxLap, currentLap + 1));

  const hasData = maxLap > 1;
  const framesStatus = isLoadingFrames
    ? 'Loading telemetry...'
    : frameData?.frames?.length
      ? `${frameData.frames.length} frames`
      : '';

  return (
    <footer className="app-footer">
      <div className="footer-left">
        <span className="lap-display">
          LAP <strong>{currentLap}</strong> / {maxLap}
        </span>
        {framesStatus && (
          <span style={{
            color: isLoadingFrames ? 'var(--color-accent-warning)' : 'var(--color-text-muted)',
            fontSize: 'var(--font-size-xs)',
            marginLeft: 8,
          }}>
            {framesStatus}
          </span>
        )}
      </div>

      <div className="footer-center">
        <div className="time-controls">
          <button className="time-btn" onClick={stepBack} disabled={!hasData} title="Previous Lap">
            &#9664;&#9664;
          </button>
          <button
            className={`time-btn time-btn--play${isPlaying ? ' playing' : ''}`}
            onClick={togglePlay}
            disabled={!hasData}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button className="time-btn" onClick={stepForward} disabled={!hasData} title="Next Lap">
            &#9654;&#9654;
          </button>

          <input
            type="range"
            className="time-slider"
            min={1}
            max={maxLap}
            value={currentLap}
            onChange={(e) => setCurrentLap(Number(e.target.value))}
            disabled={!hasData}
          />

          <select
            className="speed-select"
            value={playSpeed}
            onChange={(e) => setPlaySpeed(Number(e.target.value))}
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={5}>5x</option>
            <option value={10}>10x</option>
          </select>
        </div>
      </div>

      <div className="footer-right">
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
          Race Control — Sapienza
        </span>
      </div>
    </footer>
  );
}
