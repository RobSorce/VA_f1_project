import React, { useMemo, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

const SPEED_COLS = [
  { key: 'SpeedI1', label: 'Sector 1' },
  { key: 'SpeedI2', label: 'Sector 2' },
  { key: 'SpeedFL', label: 'Finish Line' },
  { key: 'SpeedST', label: 'Speed Trap' },
];

export default function SectorsPanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const [view, setView] = useState('times');

  const toDisplaySpeed = (kmh) => speedUnit === 'mph' ? Math.round(kmh * 0.6214 * 10) / 10 : kmh;
  const speedLabel = speedUnit === 'mph' ? 'mph' : 'km/h';

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);

  // Sector time rankings
  const { sectors, sessionBests } = useMemo(() => {
    if (lapTimes.length === 0) return { sectors: {}, sessionBests: {} };

    const driverSectors = {};
    for (const lt of lapTimes) {
      if (lt.LapNumber > currentLap) continue;
      const drv = lt.Driver;
      if (!drv) continue;
      if (!driverSectors[drv]) driverSectors[drv] = { 1: [], 2: [], 3: [] };

      for (const s of [1, 2, 3]) {
        const val = lt[`Sector${s}TimeSeconds`];
        if (val && typeof val === 'number' && val > 0 && val < 300 && !isNaN(val)) {
          driverSectors[drv][s].push(val);
        }
      }
    }

    const sBests = {};
    const sResult = {};

    for (const s of [1, 2, 3]) {
      const allTimes = [];
      for (const [drv, secs] of Object.entries(driverSectors)) {
        if (secs[s].length > 0) {
          const best = Math.min(...secs[s]);
          allTimes.push({ driver: drv, best: Math.round(best * 1000) / 1000 });
        }
      }

      allTimes.sort((a, b) => a.best - b.best);
      const sessionBest = allTimes.length > 0 ? allTimes[0].best : null;
      sBests[String(s)] = sessionBest;

      allTimes.forEach((entry, i) => {
        entry.rank = i + 1;
        entry.is_session_best = entry.best === sessionBest;
      });

      sResult[String(s)] = allTimes;
    }

    return { sectors: sResult, sessionBests: sBests };
  }, [lapTimes, currentLap]);

  // Speed rankings
  const speedRankings = useMemo(() => {
    if (lapTimes.length === 0) return {};

    const result = {};
    for (const { key } of SPEED_COLS) {
      const driverSpeeds = {};
      for (const lt of lapTimes) {
        if (lt.LapNumber > currentLap) continue;
        const drv = lt.Driver;
        const val = lt[key];
        if (!drv || val == null || typeof val !== 'number' || isNaN(val) || val <= 0) continue;
        if (!driverSpeeds[drv] || val > driverSpeeds[drv].speed) {
          driverSpeeds[drv] = { speed: val, lap: lt.LapNumber };
        }
      }

      const ranked = Object.entries(driverSpeeds)
        .sort(([, a], [, b]) => b.speed - a.speed)
        .map(([driver, { speed, lap }], i) => ({
          driver, speed: Math.round(speed * 10) / 10, lap, rank: i + 1,
        }));

      result[key] = ranked;
    }
    return result;
  }, [lapTimes, currentLap]);

  if (!Object.keys(sectors).length) {
    return (
      <div className="sectors-panel__empty">
        No sector data available. Load a session first.
      </div>
    );
  }

  return (
    <div className="sectors-panel-wrapper">
      {/* ── Toggle ── */}
      <div className="sectors-panel__toggle">
        <button
          className={`sectors-panel__toggle-btn${view === 'times' ? ' sectors-panel__toggle-btn--active' : ''}`}
          onClick={() => setView('times')}
        >
          Sector Times
        </button>
        <button
          className={`sectors-panel__toggle-btn${view === 'speeds' ? ' sectors-panel__toggle-btn--active' : ''}`}
          onClick={() => setView('speeds')}
        >
          Top Speeds
        </button>
      </div>

      {/* ── Sector Times View ── */}
      {view === 'times' && (
        <div className="sectors-panel__columns">
          {['1', '2', '3'].map((s) => {
            const items = sectors[s] || [];
            const best = sessionBests[s];
            const worst = items.length > 0 ? items[items.length - 1].best : best;
            const range = worst - (best || 0);
            return (
              <div key={s} className="sectors-panel__column">
                <div className="sectors-panel__col-header">
                  <span className="sectors-panel__col-title">SECTOR {s}</span>
                  {best && (
                    <span className="sectors-panel__col-best">{formatTime(best)}</span>
                  )}
                </div>
                <div className="sectors-panel__col-body">
                  {items.map((entry) => {
                    const color = getDriverColor(entry.driver);
                    const isBest = entry.is_session_best;
                    const gap = entry.best - (best || 0);
                    const barPct = range > 0 ? Math.max(0, 1 - gap / range) * 100 : 100;
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isBest ? ' sectors-panel__row--best' : ''}`}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: color }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span className="sectors-panel__bar-cell">
                          <span
                            className="sectors-panel__bar-fill"
                            style={{
                              width: `${barPct}%`,
                              background: isBest
                                ? 'var(--sector-purple)'
                                : entry.rank <= 3
                                  ? 'var(--sector-green)'
                                  : 'rgba(255, 210, 0, 0.5)',
                            }}
                          />
                        </span>
                        <span
                          className="sectors-panel__time"
                          style={{ color: isBest ? 'var(--sector-purple)' : 'var(--color-text-primary)' }}
                        >
                          {formatTime(entry.best)}
                        </span>
                        {entry.rank > 1 && items[0] && (
                          <span className="sectors-panel__gap">
                            +{(entry.best - items[0].best).toFixed(3)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Top Speeds View (list columns) ── */}
      {view === 'speeds' && (
        <div className="sectors-panel__columns">
          {SPEED_COLS.map(({ key, label }) => {
            const items = speedRankings[key] || [];
            const fastest = items[0]?.speed || 0;
            return (
              <div key={key} className="sectors-panel__column sectors-panel__column--speed">
                <div className="sectors-panel__col-header">
                  <span className="sectors-panel__col-title">{label}</span>
                  {fastest > 0 && (
                    <span className="sectors-panel__col-best sectors-panel__col-best--purple">
                      {toDisplaySpeed(fastest)} {speedLabel}
                    </span>
                  )}
                </div>
                <div className="sectors-panel__col-body">
                  {items.map((entry) => {
                    const color = getDriverColor(entry.driver);
                    const isFastest = entry.rank === 1;
                    return (
                      <div
                        key={entry.driver}
                        className={`sectors-panel__row${isFastest ? ' sectors-panel__row--best' : ''}`}
                      >
                        <span className="sectors-panel__rank">{entry.rank}</span>
                        <span className="sectors-panel__team-bar" style={{ backgroundColor: color }} />
                        <span className="sectors-panel__driver">{entry.driver}</span>
                        <span
                          className="sectors-panel__speed-val"
                          style={{ color: isFastest ? 'var(--sector-purple)' : 'var(--color-text-primary)' }}
                        >
                          {toDisplaySpeed(entry.speed)}
                        </span>
                        <span className="sectors-panel__speed-unit">{speedLabel}</span>
                        {entry.rank > 1 && fastest > 0 && (
                          <span className="sectors-panel__gap">
                            -{toDisplaySpeed(fastest - entry.speed).toFixed(1)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
