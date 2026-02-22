import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';

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

  // Compute consistency from lap_times, filtered by currentLap for incremental reveal
  const { drivers, sessionAvg } = useMemo(() => {
    const lapTimes = sessionData?.lap_times || [];
    if (lapTimes.length === 0) return { drivers: [], sessionAvg: null };

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
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = median * 1.5;
      const valid = laps.filter((l) => l.time <= threshold);
      const outliers = laps.length - valid.length;
      const validTimes = valid.map((l) => l.time);
      if (validTimes.length < 2) continue;

      const avg = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
      const fastest = Math.min(...validTimes);
      const slowest = Math.max(...validTimes);
      const range = slowest - fastest;
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
            degRate = Math.round(((num / den) * 100 / cAvg) * 100) / 100; // % per lap
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

    return { drivers: results, sessionAvg: sAvg };
  }, [sessionData, currentLap]);

  if (!drivers.length) {
    return (
      <div className="consistency-panel__empty">
        No consistency data available. Load a session first.
      </div>
    );
  }

  return (
    <div className="consistency-panel">
      {sessionAvg && (
        <div className="consistency-panel__session-summary">
          <span>Session Average: <strong>{formatTime(sessionAvg)}</strong></span>
          <span>{drivers.length} drivers analyzed</span>
        </div>
      )}

      <div className="consistency-panel__grid">
        {drivers.map((d) => {
          const color = getDriverColor(d.driver);
          const compoundEntries = Object.entries(d.compounds || {});
          return (
            <div key={d.driver} className="consistency-card glass-card">
              <div className="consistency-card__header">
                <span className="consistency-card__team-bar" style={{ backgroundColor: color }} />
                <span className="consistency-card__name">{d.driver}</span>
                {d.number && <span className="consistency-card__number">#{d.number}</span>}
                <span
                  className={`consistency-card__badge${d.is_consistent ? ' consistency-card__badge--consistent' : ' consistency-card__badge--inconsistent'}`}
                >
                  {d.is_consistent ? 'Consistent' : 'Inconsistent'}
                </span>
                <span className="consistency-card__cv">CV: {d.cv_percent.toFixed(2)}%</span>
              </div>

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
            </div>
          );
        })}
      </div>
    </div>
  );
}
