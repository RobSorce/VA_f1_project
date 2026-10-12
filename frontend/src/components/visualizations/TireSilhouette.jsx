import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS } from '../../utils/colors';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { deriveStints } from '../../utils/stints';
import { causalKey, tyreStintStatus } from '../../utils/strategyViews';
import Panel from '../ui/Panel';

/**
 * Top-down F1 car silhouette with 4 tyre indicators.
 * Shows compound color + wear opacity for each tyre.
 * Bidirectionally coordinated with StrategyTimeline via selectedStint / highlightedCompound.
 */
export default function TireSilhouette() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedStint = useF1Store((s) => s.selectedStint);
  const highlightedCompound = useF1Store((s) => s.highlightedCompound);
  const setHighlightedCompound = useF1Store((s) => s.setHighlightedCompound);

  const driver = focusDriver || selectedDrivers[0] || null;

  // Stints of every driver from the laps completed at sessionNow
  // (utils/stints.js): the replay never reveals a stint's final length early
  const sessionNow = useSessionNow();
  const lapTimes = sessionData?.lap_times;
  const causal = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  // Live mode: the set a driver is racing on stays ongoing until the flag
  const running = useStintsRunning();
  const allStints = useMemo(
    () => deriveStints(lapTimes || [], { sessionNow, running }),
    [lapTimes, causal, running],
  );

  // Find current stint data for the driver
  const stintInfo = useMemo(() => {
    if (!driver) return null;
    const driverStints = allStints.filter((s) => s.Driver === driver);
    if (driverStints.length === 0) return null;

    // A stint explicitly selected in StrategyTimeline, when it exists at sessionNow;
    // otherwise the driver's current (last) stint
    const selected = selectedStint && selectedStint.driver === driver
      ? driverStints.find((s) => s.StartLap === selectedStint.lapStart)
      : null;
    const active = selected || driverStints[driverStints.length - 1];
    // Ongoing stint: its final length is unknown, so wear is read against the
    // average same-compound stint that ended in a pit stop after at least as
    // many laps (utils/strategyViews.js tyreStintStatus; unknown if none)
    return tyreStintStatus(active, { allStints });
  }, [driver, allStints, selectedStint]);

  const compound = stintInfo?.compound || 'UNKNOWN';
  const tyreColor = TYRE_COLORS[compound] || '#888';
  const life = stintInfo?.tyreLife || 0;
  const lifeKnown = stintInfo?.tyreLife != null;
  // Opacity: 1.0 fresh → 0.3 worn
  const tyreOpacity = Math.max(0.3, 1 - life * 0.7);

  const handleTyreClick = () => {
    if (highlightedCompound === compound) {
      setHighlightedCompound(null);
    } else {
      setHighlightedCompound(compound);
    }
  };

  if (!driver) {
    return (
      <Panel title="Tyre Status">
        <div className="loading-placeholder" style={{ padding: 16, textAlign: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
            Select or focus a driver to see tyre status
          </span>
        </div>
      </Panel>
    );
  }

  const tyreR = 14;
  const carW = 50;
  const carH = 120;
  const svgW = 180;
  const svgH = 180;
  const cx = svgW / 2;
  const cy = svgH / 2;

  // Tyre positions relative to car center
  const tyres = [
    { id: 'FL', label: 'FL', x: cx - carW / 2 - 6, y: cy - carH / 2 + 18 },
    { id: 'FR', label: 'FR', x: cx + carW / 2 + 6, y: cy - carH / 2 + 18 },
    { id: 'RL', label: 'RL', x: cx - carW / 2 - 6, y: cy + carH / 2 - 18 },
    { id: 'RR', label: 'RR', x: cx + carW / 2 + 6, y: cy + carH / 2 - 18 },
  ];

  return (
    <Panel title="Tyre Status">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 0' }}>
        {/* Driver name */}
        <div style={{
          fontSize: '11px', fontWeight: 800, color: 'var(--color-text-primary)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          {driver}
        </div>

        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
          {/* Car body silhouette */}
          <g transform={`translate(${cx}, ${cy})`}>
            {/* Main body */}
            <path
              d={`M-12,-55 C-18,-50 -22,-35 -22,-20 L-22,25 C-22,40 -18,50 -12,55 L12,55 C18,50 22,40 22,25 L22,-20 C22,-35 18,-50 12,-55 Z`}
              fill="rgba(255,255,255,0.06)"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="1.5"
            />
            {/* Nose cone */}
            <path
              d="M-6,-55 L0,-65 L6,-55"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            {/* Rear wing */}
            <rect x={-20} y={50} width={40} height={4} rx={2}
              fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            {/* Front wing */}
            <rect x={-18} y={-58} width={36} height={3} rx={1.5}
              fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
            {/* Cockpit */}
            <ellipse cx={0} cy={-10} rx={8} ry={12}
              fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" strokeWidth="0.8" />
          </g>

          {/* Tyres */}
          {tyres.map((t) => (
            <g key={t.id} onClick={handleTyreClick} style={{ cursor: 'pointer' }}>
              {/* Wear ring (background) */}
              <circle cx={t.x} cy={t.y} r={tyreR + 2}
                fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
              {/* Tyre fill */}
              <circle cx={t.x} cy={t.y} r={tyreR}
                fill={tyreColor}
                opacity={highlightedCompound && highlightedCompound !== compound ? 0.2 : tyreOpacity}
                stroke={highlightedCompound === compound ? '#fff' : 'rgba(0,0,0,0.5)'}
                strokeWidth={highlightedCompound === compound ? 2 : 1.5}
              />
              {/* Wear arc overlay */}
              {life > 0 && (
                <circle cx={t.x} cy={t.y} r={tyreR}
                  fill="none"
                  stroke="rgba(0,0,0,0.3)"
                  strokeWidth={tyreR * 2}
                  strokeDasharray={`${life * Math.PI * tyreR * 2} ${Math.PI * tyreR * 2}`}
                  strokeDashoffset={0}
                  transform={`rotate(-90 ${t.x} ${t.y})`}
                  style={{ mixBlendMode: 'multiply' }}
                  opacity={0.3}
                />
              )}
              {/* Tyre label */}
              <text x={t.x} y={t.y}
                textAnchor="middle" dominantBaseline="central"
                fill={compound === 'HARD' || compound === 'MEDIUM' ? '#000' : '#fff'}
                fontSize="8px" fontWeight="800"
                style={{ pointerEvents: 'none' }}
              >
                {t.label}
              </text>
            </g>
          ))}
        </svg>

        {/* Info row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: '10px', color: 'var(--color-text-secondary)',
        }}>
          <span style={{
            padding: '2px 8px', borderRadius: 4,
            background: tyreColor,
            color: compound === 'HARD' || compound === 'MEDIUM' ? '#000' : '#fff',
            fontWeight: 800, fontSize: '9px',
          }}>
            {compound}
          </span>
          <span
            title={stintInfo?.lengthSource === 'race-average'
              ? `Reference length: average of ${stintInfo.lengthSamples} ${compound} stint(s) in this race that ended in a pit stop after at least ${stintInfo.lapsOnTyre} laps`
              : stintInfo?.lengthSource === 'actual'
                ? 'Completed stint: its real length'
                : `No ${compound} stint in this race has yet ended in a pit stop after at least ${stintInfo?.lapsOnTyre || 0} laps: length unknown`}
          >
            Lap {stintInfo?.lapsOnTyre || 0} / {stintInfo?.stintLength == null
              ? '?'
              : stintInfo.lengthSource === 'race-average'
                ? `~${Math.round(stintInfo.stintLength)}`
                : stintInfo.stintLength}
          </span>
          <span style={{ color: !lifeKnown ? 'var(--color-text-muted)' : life > 0.7 ? '#ef4444' : life > 0.4 ? '#fbbf24' : '#22c55e', fontWeight: 700 }}>
            {lifeKnown ? `${((1 - life) * 100).toFixed(0)}% life` : 'life ?'}
          </span>
        </div>

        {highlightedCompound && (
          <div style={{
            fontSize: '9px', color: 'var(--color-text-muted)', textAlign: 'center',
          }}>
            Filtering: {highlightedCompound} stints highlighted
            <button
              onClick={() => setHighlightedCompound(null)}
              style={{
                marginLeft: 6, padding: '1px 6px', fontSize: '8px',
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 3, color: 'var(--color-text-secondary)', cursor: 'pointer',
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
