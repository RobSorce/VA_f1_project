import React, { useMemo, useRef, useCallback, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey } from '../../utils/strategyViews';
import { MIN_FIT_LAPS, OUTLIER_K } from '../../utils/degradation';
import {
  consistencyView, formatSlope, LOW_DATA_FRACTION, FUEL_NOTE, FIT_NOTE,
} from '../../utils/views/degradationViews';

const LOW_DATA_PERCENT = Math.round(LOW_DATA_FRACTION * 100);


function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

const COMPOUND_COLORS = {
  SOFT: 'var(--tyre-soft)',
  MEDIUM: 'var(--tyre-medium)',
  HARD: 'var(--tyre-hard)',
  INTERMEDIATE: 'var(--tyre-intermediate)',
  WET: 'var(--tyre-wet)',
};

export default function ConsistencyPanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);

  const panelRef = useRef(null);
  const gridRef = useRef(null);
  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, 'consistency_analysis.png');
  }, []);

  // Per-driver expansion state. Default = collapsed. Focus driver and
  // explicit user toggles always override.
  const [expandedMap, setExpandedMap] = useState({});
  const [bulkMode, setBulkMode] = useState(null); // 'all' | null
  const isCardExpanded = useCallback((drv) => {
    // Precedence: explicit user toggle > focus driver > bulk mode > default.
    // Default is always collapsed — per user feedback, expanding all at
    // once overflows the panel and there's no way to see the last cards.
    if (drv in expandedMap) return expandedMap[drv];
    if (drv === focusDriver) return true;
    if (bulkMode === 'all') return true;
    return false;
  }, [expandedMap, bulkMode, focusDriver]);
  const toggleCard = useCallback((drv) => {
    setExpandedMap((m) => ({ ...m, [drv]: !isCardExpanded(drv) }));
  }, [isCardExpanded]);
  const expandAll = useCallback(() => { setExpandedMap({}); setBulkMode('all'); }, []);
  const collapseAll = useCallback(() => { setExpandedMap({}); setBulkMode(null); }, []);

  const replayStarted = totalFrames > 0;

  // Causal "now" in session seconds (utils/raceTime.js). The statistics change
  // only when a lap completes or a pit event happens (causalKey), not on
  // every replay tick.
  const sessionNow = useSessionNow();
  const lapTimes = sessionData?.lap_times;
  const lapKey = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);

  // Consistency from the laps completed at sessionNow, on the shared
  // degradation definition (consistencyView, utils/views/degradationViews):
  // σ = pooled residual sigma of the per-stint fits (consistencySigma), so
  // lap 1, pit laps, non-green laps, tyre wear, fuel burn and stops do not
  // count as inconsistency
  const { drivers, sessionAvg, minLapsThreshold } = useMemo(
    () => (replayStarted ? consistencyView(lapTimes, sessionNow)
      : { drivers: [], sessionAvg: null, minLapsThreshold: 0 }),
    // sessionNow enters through lapKey, which changes whenever the result does
    [lapTimes, lapKey, replayStarted],
  );

  if (!drivers.length) {
    return (
      <div className="consistency-panel__empty">
        {(sessionData?.lap_times?.length > 0) && !replayStarted
          ? 'Press play to start the race replay'
          : (sessionData?.lap_times?.length > 0)
            ? `No consistency yet: σ needs a stint with at least ${MIN_FIT_LAPS} clean laps `
              + '(lap 1, pit in/out laps and non-green laps do not count).'
            : 'No consistency data available. Load a session first.'}
      </div>
    );
  }

  return (
    <div ref={panelRef} className="consistency-panel">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 8px 0',
        gap: 10,
      }}>
        {sessionAvg ? (
          <div className="consistency-panel__session-summary" style={{ margin: 0 }}>
            <span title="Mean of the clean laps of the drivers listed (lap 1, pit in/out laps, non-green laps and slow outliers left out)">
              Session Average: <strong>{formatTime(sessionAvg)}</strong>
            </span>
            <span>{drivers.length} drivers analyzed</span>
          </div>
        ) : <span />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* Expand/Collapse all — H7: power users can force full detail
              regardless of the small-viewport default. */}
          <button
            type="button"
            className="consistency-panel__bulk-btn"
            onClick={expandAll}
            title="Expand all cards"
          >Expand all</button>
          <button
            type="button"
            className="consistency-panel__bulk-btn"
            onClick={collapseAll}
            title="Collapse all cards"
          >Collapse all</button>
          <button
            onClick={handleExport}
            title="Export as PNG"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 4,
              border: 'none', background: 'transparent',
              color: 'rgba(255,255,255,0.3)', cursor: 'pointer',
              fontSize: '12px', padding: 0, flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Color Legend ── */}
      <div className="sectors-panel__legend" style={{ padding: '2px 8px 4px' }}>
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: 'var(--tyre-soft)' }} />
          Soft
        </span>
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: 'var(--tyre-medium)' }} />
          Medium
        </span>
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ background: 'var(--tyre-hard)' }} />
          Hard
        </span>
        <span className="sectors-panel__legend-item" title="σ at or below the field's median σ">
          <span className="sectors-panel__legend-dot" style={{ borderRadius: 2, background: '#22c55e' }} />
          Consistent
        </span>
        <span className="sectors-panel__legend-item" title="σ above the field's median σ">
          <span className="sectors-panel__legend-dot" style={{ borderRadius: 2, background: '#ef4444' }} />
          Inconsistent
        </span>
      </div>

      <div ref={gridRef} className="consistency-panel__grid">
        {drivers.map((d) => {
          const color = getDriverColor(d.driver);
          const compoundEntries = Object.entries(d.compounds || {});
          const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(d.driver);
          const isHl = highlightedDriver === d.driver;
          const isDimmed = highlightedDriver && !isHl;
          const expanded = isCardExpanded(d.driver);
          return (
            <div key={d.driver}
              className={[
                'consistency-card',
                'glass-card',
                !expanded && 'consistency-card--collapsed',
                d.insufficient_data && 'consistency-card--low-data',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => setHighlightedDriver(d.driver)}
              onMouseLeave={() => setHighlightedDriver(null)}
              title={d.insufficient_data
                ? `Low data — σ from only ${d.lap_count} laps, below ${minLapsThreshold} laps (${LOW_DATA_PERCENT} % of the largest sample in the field). σ is not comparable to full-race drivers.`
                : undefined}
              style={{
                opacity: !isSelected ? 0.35 : isDimmed ? 0.5 : (d.insufficient_data ? 0.55 : 1),
                outline: isHl ? `1px solid ${color}` : undefined,
                transition: 'opacity 0.15s, outline 0.15s',
              }}
            >
              {/* Header — click the name/body region to set focus; click
                  the chevron to toggle expansion. Two targets, one row. */}
              <div
                className="consistency-card__header"
                onClick={() => setFocusDriver(d.driver)}
                style={{ cursor: 'pointer' }}
              >
                <span className="consistency-card__team-bar" style={{ backgroundColor: color }} />
                <span className="consistency-card__name">{d.driver}</span>
                {d.number && <span className="consistency-card__number">#{d.number}</span>}
                {d.insufficient_data && (
                  <span
                    className="consistency-card__low-data-chip"
                    title={`Only ${d.lap_count} laps (< ${minLapsThreshold}, ${LOW_DATA_PERCENT} % of the largest sample) — σ from a small sample is not comparable.`}
                  >
                    LOW DATA
                  </span>
                )}
                {/* Collapsed-state key metric: σ visible without expanding */}
                {!expanded && (
                  <span className="consistency-card__collapsed-sigma" title="σ = residual sigma of the per-stint fits">
                    &plusmn;{d.std_dev.toFixed(3)}s
                  </span>
                )}
                <span
                  className={`consistency-card__badge${d.is_consistent ? ' consistency-card__badge--consistent' : ' consistency-card__badge--inconsistent'}`}
                >
                  {d.is_consistent ? 'Consistent' : 'Inconsistent'}
                </span>
                <span className="consistency-card__cv" title="σ / average clean lap">CV: {d.cv_percent.toFixed(2)}%</span>
                <button
                  type="button"
                  className={`consistency-card__chevron${expanded ? ' consistency-card__chevron--open' : ''}`}
                  aria-label={expanded ? `Collapse ${d.driver}` : `Expand ${d.driver}`}
                  aria-expanded={expanded}
                  onClick={(e) => { e.stopPropagation(); toggleCard(d.driver); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              </div>

              {expanded && (
                <>
                  <div className="consistency-card__body">
                    <div className="consistency-card__col">
                      <div className="consistency-card__col-title">Performance</div>
                      <div className="consistency-card__stat">
                        <span>Average</span>
                        <span className="consistency-card__stat-value">{formatTime(d.avg_lap)}</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Fastest</span>
                        <span className="consistency-card__stat-value" style={{ color: 'var(--sector-green)' }}>{formatTime(d.fastest)}</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Slowest</span>
                        <span className="consistency-card__stat-value" style={{ color: 'var(--color-accent-danger)' }}>{formatTime(d.slowest)}</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Range</span>
                        <span className="consistency-card__stat-value">{d.range.toFixed(3)}s</span>
                      </div>
                    </div>

                    <div className="consistency-card__col">
                      <div className="consistency-card__col-title">Consistency</div>
                      <div
                        className="consistency-card__stat"
                        title={`Pooled residual sigma of ${d.fitted_stints} per-stint fit(s) of lap time on tyre life (${FIT_NOTE}): tyre wear, fuel burn and stops do not count as inconsistency`}
                      >
                        <span>Residual σ</span>
                        <span className="consistency-card__stat-value">&plusmn;{d.std_dev.toFixed(3)}s</span>
                      </div>
                      <div className="consistency-card__stat" title="Clean laps of the fitted stints">
                        <span>Sample Size</span>
                        <span className="consistency-card__stat-value">{d.sample_size} laps</span>
                      </div>
                      <div className="consistency-card__stat" title={`Slow laps of the fitted stints more than ${OUTLIER_K} robust sigmas above their stint's fit`}>
                        <span>Outliers</span>
                        <span className="consistency-card__stat-value">{d.outliers} removed</span>
                      </div>
                    </div>
                  </div>

                  {compoundEntries.length > 0 && (
                    <div className="consistency-card__tyres">
                      <div className="consistency-card__col-title">Tire Performance</div>
                      {compoundEntries.map(([compound, data]) => (
                        <div key={compound} className="consistency-card__tyre-row">
                          <span
                            className="consistency-card__tyre-dot"
                            style={{ backgroundColor: COMPOUND_COLORS[compound] || '#888' }}
                          />
                          <span className="consistency-card__tyre-name">{compound}</span>
                          <span className="consistency-card__tyre-stat">
                            Avg: {formatTime(data.avg)}
                          </span>
                          <span
                            className="consistency-card__tyre-stat"
                            title={data.deg_slope != null
                              ? `Mean degradation of ${data.deg_fits} fitted stint(s) on this compound; ${FUEL_NOTE}`
                              : `No stint on this compound has ${MIN_FIT_LAPS} or more clean laps: no fit`}
                            style={{
                              color: data.deg_slope == null ? undefined
                                : data.deg_slope > 0 ? 'var(--color-accent-danger)' : 'var(--sector-green)',
                            }}
                          >
                            Deg: {data.deg_slope != null ? `${formatSlope(data.deg_slope)} s/lap` : 'no fit'}
                          </span>
                          <span className="consistency-card__tyre-stat">
                            {data.count}L, Age {data.avg_tyre_life}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
