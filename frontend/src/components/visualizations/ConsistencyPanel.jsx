import React, { useMemo, useRef, useCallback, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';


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
  const currentLap = useF1Store((s) => s.currentLap);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
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

  // Compute consistency from lap_times, filtered by currentLap for incremental reveal
  const { drivers, sessionAvg, minLapsThreshold } = useMemo(() => {
    const lapTimes = sessionData?.lap_times || [];
    if (lapTimes.length === 0 || !replayStarted) return { drivers: [], sessionAvg: null, minLapsThreshold: 0 };

    // Use 75% of currentLap (or race length, whichever is capped) as the
    // minimum — DNFs produce artificially narrow σ from tiny samples
    // (H1/V1.4, demonstrated by HUL at São Paulo 2024).
    const threshold75 = Math.max(3, Math.floor(currentLap * 0.75));

    const driverLaps = {};
    for (const lt of lapTimes) {
      if (lt.LapNumber > currentLap) continue; // incremental: only laps up to current
      const drv = lt.Driver;
      const t = lt.LapTimeSeconds;
      const compound = lt.Compound || 'UNKNOWN';
      const tyreLife = lt.TyreLife || 0;
      if (!drv || !t || typeof t !== 'number' || isNaN(t) || t <= 0) continue;
      if (lt.PitInTime || lt.PitOutTime) continue; // skip pit laps

      if (!driverLaps[drv]) driverLaps[drv] = [];
      driverLaps[drv].push({ time: t, compound, tyre_life: tyreLife });
    }

    const results = [];
    const allValidTimes = [];

    for (const [drv, laps] of Object.entries(driverLaps)) {
      const times = laps.map((l) => l.time);
      if (times.length < 3) continue;

      // Remove outliers (> 1.5x median)
      const sorted = [...times].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
      const threshold = median * 1.5;
      const valid = laps.filter((l) => l.time <= threshold);
      const outliers = laps.length - valid.length;
      const validTimes = valid.map((l) => l.time);
      if (validTimes.length < 2) continue;

      const avg = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
      const fastest = Math.min(...validTimes);
      const slowest = Math.max(...validTimes);
      const range = slowest - fastest;
      // Population stdDev (÷ n): we describe the full observed distribution, not inferring a population
      const variance = validTimes.reduce((a, t) => a + (t - avg) ** 2, 0) / validTimes.length;
      const stdDev = Math.sqrt(variance);
      const cvPercent = avg > 0 ? (stdDev / avg) * 100 : 0;

      allValidTimes.push(...validTimes);

      // Per-compound breakdown
      const compoundMap = {};
      for (const l of valid) {
        if (!compoundMap[l.compound]) compoundMap[l.compound] = { times: [], tyre_lives: [] };
        compoundMap[l.compound].times.push(l.time);
        compoundMap[l.compound].tyre_lives.push(l.tyre_life);
      }

      const compounds = {};
      for (const [c, cdata] of Object.entries(compoundMap)) {
        const n = cdata.times.length;
        const cAvg = cdata.times.reduce((a, b) => a + b, 0) / n;
        const avgTyreLife = cdata.tyre_lives.reduce((a, b) => a + b, 0) / n;

        // Linear regression: lap time vs tyre life → degradation slope
        let degRate = 0;
        if (n > 2) {
          const meanTL = avgTyreLife;
          const meanT = cAvg;
          let num = 0, den = 0;
          for (let i = 0; i < n; i++) {
            num += (cdata.tyre_lives[i] - meanTL) * (cdata.times[i] - meanT);
            den += (cdata.tyre_lives[i] - meanTL) ** 2;
          }
          if (den > 0) {
            // slope (seconds per tyre-life unit) → normalise to % of avg lap time
            degRate = Math.round(((num / den) / cAvg) * 100 * 100) / 100; // % per lap
          }
        }

        compounds[c] = {
          avg: Math.round(cAvg * 1000) / 1000,
          count: n,
          avg_tyre_life: Math.round(avgTyreLife * 10) / 10,
          deg_rate: degRate,
        };
      }

      results.push({
        driver: drv,
        team: '',
        number: '',
        avg_lap: Math.round(avg * 1000) / 1000,
        fastest: Math.round(fastest * 1000) / 1000,
        slowest: Math.round(slowest * 1000) / 1000,
        range: Math.round(range * 1000) / 1000,
        std_dev: Math.round(stdDev * 1000) / 1000,
        cv_percent: Math.round(cvPercent * 100) / 100,
        sample_size: validTimes.length,
        lap_count: validTimes.length,
        insufficient_data: validTimes.length < threshold75,
        outliers,
        compounds,
      });
    }

    // Use median CV as the consistency threshold (relative to the field)
    const allCVs = results.map((r) => r.cv_percent).sort((a, b) => a - b);
    const medianCV = allCVs.length > 0 ? allCVs[Math.floor(allCVs.length / 2)] : 1;
    results.forEach((r) => {
      r.is_consistent = r.cv_percent <= medianCV;
    });

    results.sort((a, b) => a.avg_lap - b.avg_lap);
    const sAvg = allValidTimes.length > 0
      ? Math.round((allValidTimes.reduce((a, b) => a + b, 0) / allValidTimes.length) * 1000) / 1000
      : null;

    return { drivers: results, sessionAvg: sAvg, minLapsThreshold: threshold75 };
  }, [sessionData, currentLap, replayStarted]);

  if (!drivers.length) {
    return (
      <div className="consistency-panel__empty">
        {(sessionData?.lap_times?.length > 0) && !replayStarted
          ? 'Press play to start the race replay'
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
            <span>Session Average: <strong>{formatTime(sessionAvg)}</strong></span>
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
        <span className="sectors-panel__legend-item">
          <span className="sectors-panel__legend-dot" style={{ borderRadius: 2, background: '#22c55e' }} />
          Consistent
        </span>
        <span className="sectors-panel__legend-item">
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
                ? `Low data — only ${d.lap_count} laps, below ${minLapsThreshold}-lap threshold. σ is not comparable to full-race drivers.`
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
                    title={`Only ${d.lap_count} laps (< ${minLapsThreshold}) — σ from a small sample is not comparable.`}
                  >
                    LOW DATA
                  </span>
                )}
                {/* Collapsed-state key metric: σ visible without expanding */}
                {!expanded && (
                  <span className="consistency-card__collapsed-sigma">
                    &plusmn;{d.std_dev.toFixed(3)}s
                  </span>
                )}
                <span
                  className={`consistency-card__badge${d.is_consistent ? ' consistency-card__badge--consistent' : ' consistency-card__badge--inconsistent'}`}
                >
                  {d.is_consistent ? 'Consistent' : 'Inconsistent'}
                </span>
                <span className="consistency-card__cv">CV: {d.cv_percent.toFixed(2)}%</span>
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
                      <div className="consistency-card__stat">
                        <span>Std Dev</span>
                        <span className="consistency-card__stat-value">&plusmn;{d.std_dev.toFixed(3)}s</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Sample Size</span>
                        <span className="consistency-card__stat-value">{d.sample_size} laps</span>
                      </div>
                      <div className="consistency-card__stat">
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
                            style={{ color: data.deg_rate > 0 ? 'var(--color-accent-danger)' : 'var(--sector-green)' }}
                          >
                            Deg: {data.deg_rate > 0 ? '+' : ''}{data.deg_rate}%
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
