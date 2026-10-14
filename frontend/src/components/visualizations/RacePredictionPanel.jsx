import React, { useMemo, useEffect, useRef, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import {
  causalKey, pitLossDisplay, viewSessionType, isRaceSession,
} from '../../utils/strategyViews';
import {
  battleKey, listedBattles, modePosition, positionChange, orderedProjections, projectionRisks,
  BADGE_INTERVAL_PCT, PODIUM_BADGE_PCT, BATTLE_BADGE_PCT, BATTLE_LIST_SIZE,
} from '../../utils/simulationClient';
import {
  focusForecast, forecastPoints, forecastPit, forecastMethodLabel, forecastHeldOutText, forecastHeldOutMae,
  FORECAST_LAPS,
} from '../../utils/forecast';
import Panel from '../ui/Panel';

// Badge rule shown in the tooltips (utils/simulationClient.js projectionBadges)
const badgeRule = (n) => `The badge turns on only when the ${BADGE_INTERVAL_PCT} % Wilson interval of the share `
  + `of the ${n != null ? `${n.toLocaleString('en-US')} ` : ''}simulations lies entirely at or above the threshold, `
  + 'and off only when it lies entirely below; while the threshold is inside the interval (within the '
  + 'Monte Carlo error) it keeps its previous state. The intervals hold for every pair of the projection at once.';
// Rule of the finishing position shown (utils/simulationClient.js shownPositions)
const positionRule = `It moves only when the median lies beyond the Monte Carlo error: ${BADGE_INTERVAL_PCT} % Wilson `
  + 'intervals of the cumulative shares, taken together over every row of the table; inside the error the '
  + 'previous position is kept.';

export default function RacePredictionPanel() {
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const predictionLoading = useF1Store((s) => s.predictionLoading);
  const lastPredictionTrigger = useF1Store((s) => s.lastPredictionTrigger);
  const focusDriver = useF1Store((s) => s.focusDriver);
  // The focus driver's lap-time forecast (double-click a driver), utils/forecast.js
  const forecast = focusForecast(lstmPredictions, focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const sessionData = useF1Store((s) => s.sessionData);
  const trackStatus = useF1Store((s) => s.trackStatus);
  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);
  // The projection is the store's (computeRaceProjection, its only writer):
  // the panel reads it, as every other view does
  const raceProjection = useF1Store((s) => s.raceProjection);
  const computeRaceProjection = useF1Store((s) => s.computeRaceProjection);
  // The Monte Carlo race projection exists for race sessions ('R', 'S') only
  const sessionType = useF1Store(viewSessionType);
  const isRace = isRaceSession(sessionType);
  const sessionNow = useSessionNow();
  // Live mode: stints still being run are not completed stint lengths
  const running = useStintsRunning();
  const lapTimesAll = sessionData?.lap_times;
  // Changes when a lap, a pit event or a track-status event completes, and
  // on any seek (backward included)
  const causal = useMemo(
    () => causalKey(lapTimesAll, sessionNow, trackStatus),
    [lapTimesAll, sessionNow, trackStatus],
  );

  const [activeTab, setActiveTab] = useState('projections');
  const tabContentRef = useRef(null);
  const [contentHeight, setContentHeight] = useState(400);
  const effectiveMaxLap = totalRaceLaps || maxLap;

  // ── Monte Carlo race projection (all drivers, real data) ──
  // The store recomputes it on every new lap of the race situation and after
  // a clock jump; while the panel is open it also asks for it when something
  // new is known within a lap (a stop, a track-status change). Same inputs ->
  // same seed -> the store does not run it again.
  useEffect(() => {
    if (isRace) computeRaceProjection();
  }, [raceSituationData, currentLap, effectiveMaxLap, sessionData, trackStatus, sessionTimeOffset,
    causal, isRace, sessionType, running]);

  // Pit loss shown in the header: the estimator's median, labelled when it is the fallback
  const pitLossInfo = pitLossDisplay(raceProjection?.raceParams?.pitLoss);
  const raceParams = raceProjection?.raceParams;
  const scEstimate = raceParams?.estimates?.safetyCar;
  const lapNoiseEstimate = raceParams?.estimates?.lapNoise;
  const numSims = raceProjection?.numSimulations;
  const badges = raceProjection?.badges;
  // Battles listed: the store's list (it changes only on evidence beyond the
  // Monte Carlo error, utils/simulationClient.js listedBattles)
  const battles = useMemo(() => listedBattles(raceProjection), [raceProjection]);
  // Risk rows: the store's (judged beyond the Monte Carlo error, chained)
  const risks = useMemo(() => projectionRisks(raceProjection), [raceProjection]);

  // Measure tab content area for dynamic row sizing
  useEffect(() => {
    if (!tabContentRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const h = entries[0].contentRect.height;
      if (h > 0) setContentHeight(h);
    });
    obs.observe(tabContentRef.current);
    return () => obs.disconnect();
  }, []);

  const lapsRemaining = effectiveMaxLap - currentLap;
  const raceProgress = effectiveMaxLap > 0 ? currentLap / effectiveMaxLap : 0;
  const numDrivers = raceSituationData?.driverAbbrs?.length || 20;

  // Dynamic row sizing for projections table
  const projCount = raceProjection?.projections?.length || 20;
  const legendH = 24; // legend row height
  const availableForRows = contentHeight - legendH;
  const rowBudget = projCount > 0 ? availableForRows / projCount : 36;
  // compact: hide probability bar when rows are very tight
  const compactRows = rowBudget < 28;
  const rowPadV = Math.max(1, Math.min(5, Math.floor((rowBudget - (compactRows ? 14 : 22)) / 2)));

  const predTabs = useMemo(() => {
    if (!raceProjection) return [];
    const tabs = [{ id: 'projections', label: 'Projections' }];
    if (battles.length > 0)
      tabs.push({ id: 'battles', label: `Battles (${battles.length})` });
    if (risks.length > 0)
      tabs.push({ id: 'risks', label: `Risks (${risks.length})` });
    if (forecast) tabs.push({ id: 'lstm', label: 'Forecast' });
    return tabs;
  }, [raceProjection, battles, risks, forecast]);
  // A tab that has gone (no listed battle any more) falls back to the projections
  const shownTab = predTabs.some((t) => t.id === activeTab) ? activeTab : 'projections';

  const tabPillStyle = (active) => ({
    padding: '3px 8px', fontSize: '9px', fontWeight: 600,
    borderRadius: 4, border: 'none', cursor: 'pointer',
    background: active ? 'rgba(0,230,118,0.15)' : 'transparent',
    color: active ? '#fff' : 'rgba(255,255,255,0.45)',
    transition: 'background 0.12s, color 0.12s',
  });

  return (
    <Panel title="Race Prediction (Monte Carlo)">
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* ── MONTE CARLO PROJECTED FINISH (all drivers) ── */}
        {isRace && raceProjection && (
          <>
            {/* Race progress header — always visible */}
            <div style={{
              background: 'linear-gradient(135deg, rgba(0,230,118,0.10) 0%, rgba(0,230,118,0.02) 100%)',
              borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)',
              borderLeft: '3px solid #00e676', flexShrink: 0, margin: '0 var(--spacing-sm)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#00e676', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Monte Carlo Projection
                </span>
                <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                  Lap {currentLap}/{effectiveMaxLap} &middot; {lapsRemaining} to go
                </span>
              </div>
              <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 6 }}>
                <div style={{
                  height: '100%', borderRadius: 2, backgroundColor: '#00e676',
                  width: `${Math.min(100, raceProgress * 100)}%`, transition: 'width 0.5s ease',
                }} />
              </div>
              {raceParams && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: '8px', color: 'var(--color-text-muted)' }}>
                  <span title={pitLossInfo.isFallback
                    ? 'No valid green-flag stop yet: fallback value (an assumption, not data)'
                    : `Median of ${pitLossInfo.n} green-flag stops in this race (in-lap + out-lap - 2 x the driver's green-flag median lap). Each simulated stop draws its loss around this median.`}
                  >
                    Pit loss: {pitLossInfo.value.toFixed(1)}s
                    {pitLossInfo.isFallback
                      ? ' fallback'
                      : ` median, race${pitLossInfo.p10 != null && pitLossInfo.p90 != null
                        ? ` (P10\u2013P90 ${pitLossInfo.p10.toFixed(1)}\u2013${pitLossInfo.p90.toFixed(1)}s, n=${pitLossInfo.n})`
                        : ` (n=${pitLossInfo.n})`}`}
                  </span>
                  <span title={lapNoiseEstimate?.source === 'race'
                    ? `Pooled residual sigma of the ${lapNoiseEstimate.stints} per-stint degradation fits of this race so far`
                      + ` (${lapNoiseEstimate.laps} clean laps, ${lapNoiseEstimate.dof} degrees of freedom): the lap-to-lap scatter`
                      + ' around each stint\'s tyre-age line. Few stints early in the race give a rough value: n is shown next to it.'
                    : `No fitted stint in this race yet: the value of the cached ${lapNoiseEstimate?.prior?.kind || 'dry'} races`}
                  >
                    Lap noise: {'\u00B1'}{raceParams.lapNoise.toFixed(2)}s{lapNoiseEstimate?.source ? ` ${lapNoiseEstimate.source}` : ''}
                    {lapNoiseEstimate ? ` (n=${lapNoiseEstimate.laps ?? 0} laps)` : ''}
                  </span>
                  <span title={scEstimate
                    ? `Safety-car / VSC episodes per leader lap: ${scEstimate.episodes} episode${scEstimate.episodes === 1 ? '' : 's'} started in ${scEstimate.laps} laps so far, `
                      + `shrunk toward the prior of the cached races (${scEstimate.prior?.episodesPerRace} per ${scEstimate.prior?.lapsPerRace} laps, `
                      + `weight ${scEstimate.prior?.weightRaces} race). ${scEstimate.source === 'prior' ? 'No episode in this race yet: the prior.' : ''}`
                    : undefined}
                  >
                    SC rate: {(raceParams.scRate * 100).toFixed(1)}%/lap{scEstimate?.source ? ` ${scEstimate.source}` : ''}
                    {scEstimate?.source === 'race' ? ` (${scEstimate.episodes} ep.)` : ''}
                  </span>
                  {numSims != null && (
                    <span title={`Seed ${raceProjection.seed}: from the session and what is known at the clock, so the same state always gives the same projection`}>
                      {numSims.toLocaleString('en-US')} sims
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Tab pills */}
            {predTabs.length > 1 && (
              <div style={{
                display: 'flex', gap: 4, padding: '4px 8px', flexShrink: 0,
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                {predTabs.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)} style={tabPillStyle(shownTab === t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {/* Tab content */}
            <div ref={tabContentRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 'var(--spacing-sm)' }}>

              {shownTab === 'projections' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                  {/* Compact Legend */}
                  <div style={{
                    display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: '8px', color: 'var(--color-text-muted)',
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff', border: '1px solid rgba(0,0,0,0.3)', flexShrink: 0 }} />
                      Expected
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderTop: '4px solid var(--color-text-muted)', flexShrink: 0 }} />
                      Current
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 8, height: 4, borderRadius: 1, background: '#00e676', flexShrink: 0 }} />
                      Gain
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 8, height: 4, borderRadius: 1, background: '#e10600', flexShrink: 0 }} />
                      Loss
                    </span>
                  </div>

                  {/* Position probability table: rows by the position shown, then the
                      current race position (never a raw Monte Carlo statistic) */}
                  <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)' }}>
                    {orderedProjections(raceProjection).map((p) => {
                // Finishing position shown: the store's median (it changes only beyond the
                // Monte Carlo error of the whole column); its colour and the arrow follow it
                const shownPos = modePosition(raceProjection, p);
                const change = positionChange(raceProjection, p) ?? 0;
                const deltaColor = change > 0 ? '#00e676' : change < 0 ? '#e10600' : 'var(--color-text-muted)';
                const isSelected = selectedDrivers.includes(p.driver);

                // Build probability bar segments
                const barSegments = [];
                const sortedPositions = Object.entries(p.posDistribution)
                  .map(([pos, pct]) => [parseInt(pos), pct])
                  .sort((a, b) => a[0] - b[0]);

                for (const [pos, pct] of sortedPositions) {
                  if (pct < 3) continue;
                  const hue = pos <= 3 ? 140 : pos <= 10 ? 45 : 0;
                  const sat = Math.min(100, pct * 2);
                  barSegments.push({ pos, pct, color: `hsl(${hue}, ${sat}%, ${40 + pct * 0.3}%)` });
                }

                return (
                  <div key={p.driver} style={{
                    padding: `${rowPadV}px 6px`,
                    borderRadius: 4,
                    background: isSelected ? 'rgba(255,255,255,0.04)' : 'transparent',
                    borderLeft: isSelected ? '2px solid ' + getDriverColor(p.driver) : '2px solid transparent',
                    marginBottom: 0,
                  }}>
                    {/* Row 1: Position, driver, delta, podium/pts */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: compactRows ? 0 : 3 }}>
                      {/* Position */}
                      <span
                        title={`Median finishing position: half of the simulations finish P${shownPos} or better `
                          + `(${p.posDistribution?.[shownPos] ?? 0}% exactly P${shownPos}; expected ${p.expectedPos}). ${positionRule} `
                          + `Gold = a podium place, i.e. a podium in at least ${PODIUM_BADGE_PCT} % of the simulations.`}
                        style={{
                          fontWeight: 900, fontSize: 'var(--font-size-sm)', minWidth: 26,
                          color: shownPos <= 3 ? '#ffd700' : shownPos <= 10 ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        }}
                      >
                        P{shownPos}
                      </span>

                      {/* Gain / loss arrow: current position against the position shown */}
                      {change !== 0 ? (
                        <span
                          title={`P${p.currentPos} now, P${shownPos} shown: ${change > 0 ? 'gains' : 'loses'} ${Math.abs(change)} place${Math.abs(change) === 1 ? '' : 's'}`}
                          style={{
                            fontSize: '8px', color: deltaColor, fontWeight: 700,
                            minWidth: 18, textAlign: 'center',
                          }}
                        >
                          {change > 0 ? '\u25B2' : '\u25BC'}{Math.abs(change)}
                        </span>
                      ) : (
                        <span style={{ minWidth: 18, textAlign: 'center', fontSize: '8px', color: 'var(--color-text-muted)' }}>
                          {'\u2022'}
                        </span>
                      )}

                      {/* Driver name */}
                      <span style={{
                        fontWeight: 700, fontSize: 'var(--font-size-xs)',
                        color: getDriverColor(p.driver), minWidth: 32,
                      }}>
                        {p.driver}
                      </span>

                      {/* Current position */}
                      <span style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
                        now P{p.currentPos}
                      </span>

                      {/* Spacer */}
                      <span style={{ flex: 1 }} />

                      {/* Range */}
                      <span style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
                        P{p.posRange[0]}{'\u2013'}P{p.posRange[1]}
                      </span>

                      {/* Podium / Points: gold = podium badge (Wilson interval + hysteresis).
                          On every row, 0 % included: a chip hidden at 0 % appeared and
                          disappeared on Monte Carlo noise alone (D5) */}
                      <span
                        title={`Podium in ${p.podiumProb}% of the simulations. Gold = at least ${PODIUM_BADGE_PCT} %, `
                          + `the same statement as a gold P label (P1-P3: the median finishing position). ${positionRule}`}
                        style={{
                          fontSize: '8px', fontWeight: 700, minWidth: 28, textAlign: 'right',
                          color: (badges ? badges.podium?.[p.driver] : p.podiumProb >= PODIUM_BADGE_PCT) ? '#ffd700' : 'var(--color-text-muted)',
                        }}
                      >
                        {p.podiumProb}%
                        <span style={{ fontWeight: 400, fontSize: '7px' }}> pod</span>
                      </span>
                    </div>

                    {/* Row 2: Probability bar (hidden in compact mode) */}
                    {!compactRows && (
                    <div style={{ position: 'relative', height: 8, marginLeft: 2, marginRight: 2 }}>
                      {/* Full range track */}
                      <div style={{
                        position: 'absolute', top: 2, left: 0, right: 0, height: 4,
                        borderRadius: 2, background: 'rgba(255,255,255,0.04)',
                      }} />
                      {/* P5-P95 range band */}
                      <div style={{
                        position: 'absolute', top: 2, height: 4, borderRadius: 2,
                        background: 'rgba(255,255,255,0.10)',
                        left: `${((p.posRange[0] - 1) / numDrivers) * 100}%`,
                        width: `${(Math.max(1, p.posRange[1] - p.posRange[0] + 1) / numDrivers) * 100}%`,
                      }} />
                      {/* Probability segments */}
                      {barSegments.map((seg) => (
                        <div key={seg.pos} style={{
                          position: 'absolute', top: 0, height: 8, borderRadius: 2,
                          backgroundColor: seg.color,
                          opacity: Math.min(1, seg.pct / 25),
                          left: `${((seg.pos - 1) / numDrivers) * 100}%`,
                          width: `${Math.max(4, (1 / numDrivers) * 100)}%`,
                        }} />
                      ))}
                      {/* Current position marker (small triangle) */}
                      <div style={{
                        position: 'absolute', top: -1,
                        left: `${((p.currentPos - 1) / numDrivers) * 100}%`,
                        transform: 'translateX(-2px)',
                        width: 0, height: 0,
                        borderLeft: '2px solid transparent',
                        borderRight: '2px solid transparent',
                        borderTop: '3px solid var(--color-text-muted)',
                      }} />
                      {/* Expected position dot */}
                      <div style={{
                        position: 'absolute', top: 1,
                        left: `${((p.expectedPos - 1) / numDrivers) * 100}%`,
                        transform: 'translateX(-3px)',
                        width: 6, height: 6, borderRadius: '50%',
                        backgroundColor: '#fff', border: '1px solid rgba(0,0,0,0.3)',
                      }} />
                    </div>
                    )}
                  </div>
                );
              })}
                  </div>
                </div>
              )}

              {shownTab === 'battles' && battles.length > 0 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                  <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Overtake Probabilities
                  </h6>
                  {battles.map((b) => {
                    // Colour = battle badge level (Wilson interval + hysteresis, store)
                    const { level } = b;
                    const probColor = level >= 2 ? '#00e676' : level === 1 ? '#ffd700' : '#64C4FF';
                    return (
                      <div key={battleKey(b)} style={{
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: compactRows ? 2 : 8,
                        fontSize: 'var(--font-size-xs)',
                      }}>
                        <span
                          title={`${b.behind} finishes ahead of ${b.ahead} in ${b.prob}% of the simulations. `
                            + `Gold = at least ${BATTLE_BADGE_PCT[0]} %, green = at least ${BATTLE_BADGE_PCT[1]} %. `
                            + `Listed: the pairs within 4 positions that are, beyond the Monte Carlo error, among the ${BATTLE_LIST_SIZE} `
                            + `most likely: a pair enters when fewer than ${BATTLE_LIST_SIZE} other pairs could be as likely (their `
                            + `intervals reach its interval) and stays until ${BATTLE_LIST_SIZE} other pairs are surely more likely; `
                            + 'while pairs are too close to call the list holds fewer rows. '
                            + `Order: green, gold, then the others, each in race order. ${badgeRule(numSims)}`}
                          style={{
                            flexShrink: 0, minWidth: 36, textAlign: 'center',
                            fontWeight: 900, fontSize: compactRows ? 'var(--font-size-xs)' : 'var(--font-size-sm)', color: probColor,
                          }}
                        >
                          {b.prob}%
                        </span>
                        <div style={{ flex: 1, lineHeight: 1.4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <strong style={{ color: getDriverColor(b.behind) }}>{b.behind}</strong>
                            <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>P{b.behindCurrentPos}</span>
                            <span style={{ color: probColor, fontSize: '10px' }}>{'\u2192'}</span>
                            <strong style={{ color: getDriverColor(b.ahead) }}>{b.ahead}</strong>
                            <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>P{b.aheadCurrentPos}</span>
                          </div>
                          <div style={{ fontSize: '8px', color: 'var(--color-text-muted)' }}>
                            {b.behind} on {b.behindCompound} &middot; {b.ahead} on {b.aheadCompound}
                          </div>
                        </div>
                        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', flexShrink: 0 }}>
                          <div style={{ height: '100%', borderRadius: 2, backgroundColor: probColor, width: `${b.prob}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {shownTab === 'risks' && risks.length > 0 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                  <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Risk Factors
                  </h6>
                  {risks.map((r, i) => {
                    const sevColor = r.severity === 'high' ? '#e10600' : r.severity === 'medium' ? '#ffd700' : '#64C4FF';
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: compactRows ? 2 : 6,
                        fontSize: 'var(--font-size-xs)', lineHeight: compactRows ? 1.2 : 1.5,
                      }}>
                        <span style={{
                          flexShrink: 0, width: 18, height: 18, borderRadius: 3,
                          backgroundColor: sevColor, color: '#000', fontWeight: 900,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px',
                        }}>{r.severity === 'high' ? '!!' : '!'}</span>
                        <div>
                          <span style={{
                            fontSize: '7px', fontWeight: 700, padding: '1px 4px',
                            borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.06)',
                            color: sevColor, marginRight: 4,
                          }}>{r.type}</span>
                          <span style={{ color: 'var(--color-text-primary)' }}>{r.description}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {shownTab === 'lstm' && forecast && (
                <div style={{
                  background: 'linear-gradient(135deg, rgba(168,85,247,0.10) 0%, rgba(168,85,247,0.02) 100%)',
                  borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)',
                  borderLeft: '3px solid #a855f7',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#a855f7', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6 }}>
                      Lap-time forecast
                      {/* The method served (response method_label): chosen on
                          the validation races; the LSTM is named only when it
                          made the forecast, and lstm_note says when it loses */}
                      {forecast.method && (
                        <span
                          title={[forecast.lstm_note, forecast.method_note].filter(Boolean).join(' ') || undefined}
                          style={{
                            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                            padding: '1px 6px', borderRadius: 4,
                            color: forecast.method === 'lstm' ? '#d5fd51' : '#f5a623',
                            background: forecast.method === 'lstm' ? 'rgba(213, 253, 81, 0.14)' : 'rgba(245, 166, 35, 0.14)',
                            border: `1px solid ${forecast.method === 'lstm' ? 'rgba(213, 253, 81, 0.45)' : 'rgba(245, 166, 35, 0.45)'}`,
                            cursor: 'help', textTransform: 'none',
                          }}>{forecastMethodLabel(forecast)}</span>
                      )}
                      {forecastHeldOutMae(forecast) != null && (
                        <span
                          title={`${forecast.held_out?.metric || 'MAE over laps +1..+5'}; the method was chosen `
                            + `on the ${forecast.held_out?.selected_on || 'held-out'} races `
                            + '(notes/experiments/phase6/evaluate_forecast.txt).'}
                          style={{
                            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                            padding: '1px 6px', borderRadius: 4, color: 'rgba(255,255,255,0.85)',
                            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.25)',
                            cursor: 'help', textTransform: 'none',
                          }}>{forecastHeldOutText(forecast)}</span>
                      )}
                    </span>
                    {predictionLoading && (
                      <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>Loading...</span>
                    )}
                    {lastPredictionTrigger && (
                      <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                        {lastPredictionTrigger.driver} @ L{lastPredictionTrigger.lap}
                      </span>
                    )}
                  </div>
                  <ForecastRow pred={forecast} />
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Early-race state: collecting data (or the first run still in the worker) ── */}
        {isRace && !raceProjection && raceSituationData && currentLap >= 3 && (
          <div style={{
            background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)',
            padding: 'var(--spacing-md)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              {currentLap < 5 ? (
                <>
                  Monte Carlo simulation available after <strong style={{ color: '#00e676' }}>lap 5</strong>.
                  <br />
                  Collecting real pace data, pit stops, and tyre degradation to calibrate...
                </>
              ) : effectiveMaxLap > currentLap ? (
                'Running the Monte Carlo simulations...'
              ) : (
                'No lap left to project.'
              )}
            </div>
          </div>
        )}

        {/* ── Not a race session: no race projection ── */}
        {!isRace && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              Race prediction applies to race sessions only (race or sprint).
            </div>
          </div>
        )}

        {/* ── Empty state: no replay running ── */}
        {isRace && !raceProjection && !raceSituationData && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              <strong style={{ color: '#00e676', display: 'block', marginBottom: 8, fontSize: 'var(--font-size-md)' }}>
                Monte Carlo Race Prediction
              </strong>
              Start the race replay to activate predictions.
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * The focus driver's lap-time forecast (store.lstmPredictions entry,
 * utils/forecast.js): each predicted time at its target lap, the pit
 * probability with the method behind it, the projected pit lap and stints,
 * and the response's notes (lstm_note says when the LSTM loses; reason when
 * there is no forecast).
 */
const COMPOUND_LETTER = {
  SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W', UNKNOWN: '?',
};
const COMPOUND_HEX = {
  SOFT: '#FF3333', MEDIUM: '#FFC300', HARD: '#EEEEEE',
  INTERMEDIATE: '#39B54A', WET: '#00AAFF', UNKNOWN: '#888',
};
function ForecastRow({ pred }) {
  const driver = pred.driver;
  const points = forecastPoints(pred);
  const pit = forecastPit(pred);
  const optimal = typeof pred.optimal_pit_lap === 'number' ? pred.optimal_pit_lap : null;
  const stints = Array.isArray(pred.predicted_stints) ? pred.predicted_stints : [];
  const summary = typeof pred.summary === 'string' ? pred.summary : null;
  const notes = [pred.lstm_note, pred.method_note, pred.pit_note, pred.pit_projection_reason].filter(Boolean);

  // Pit-probability colour: green < 30%, amber 30-60%, red ≥ 60%
  const pitPct = pit.probability != null ? Math.round(pit.probability * 100) : null;
  const pitColor = pitPct == null ? 'rgba(255,255,255,0.5)'
    : pitPct >= 60 ? '#ef4444'
    : pitPct >= 30 ? '#f5a623'
    : '#22c55e';

  return (
    <div style={{
      padding: '6px 4px',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      fontSize: 'var(--font-size-xs)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      {/* Header: driver, origin lap, pit probability */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 800, color: getDriverColor(driver), letterSpacing: '0.04em' }}>
          {driver}
        </span>
        {Number.isFinite(pred.lap) && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>from lap {pred.lap}</span>
        )}
        {pitPct != null && (
          <span
            title={`Pit stop within ${FORECAST_LAPS} laps${pit.label ? `, by the ${pit.label}` : ''}.`}
            style={{ marginLeft: 'auto', fontSize: 10, color: 'rgba(255,255,255,0.55)' }}
          >
            pit{pit.label ? ` (${pit.label})` : ''}: <strong style={{ color: pitColor, fontFamily: 'var(--font-mono)' }}>{pitPct}%</strong>
          </span>
        )}
      </div>

      {/* Predicted laps, each at its target lap */}
      {points.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {points.map(({ lap, time }) => (
            <span key={lap} style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.85)',
            }}>
              L{lap} {time.toFixed(2)}s
            </span>
          ))}
        </div>
      )}

      {/* Projected pit lap + predicted stints */}
      {(optimal != null || stints.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 10 }}>
          {optimal != null && (
            <span style={{ color: 'rgba(255,255,255,0.55)' }}>
              optimal pit: <strong style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>L{optimal}</strong>
            </span>
          )}
          {stints.length > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'rgba(255,255,255,0.55)' }}>
              stints:
              {stints.map((s, i) => {
                const letter = COMPOUND_LETTER[s.compound] || '?';
                const hex = COMPOUND_HEX[s.compound] || '#888';
                return (
                  <span key={i} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '0 5px', borderRadius: 3,
                    background: `${hex}22`, border: `1px solid ${hex}55`,
                    color: hex, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                  }}>
                    {letter} × {s.length || '?'}
                  </span>
                );
              })}
            </span>
          )}
        </div>
      )}

      {/* The response's summary and notes (which method, why, held-out standing) */}
      {summary && (
        <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.6)' }}>
          {summary}
        </div>
      )}
      {notes.map((n) => (
        <div key={n} style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.6)' }}>{n}</div>
      ))}

      {/* No forecast (fewer than 3 clean laps at the clock): the reason */}
      {points.length === 0 && (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
          {pred.reason || 'No forecast for this lap.'}
        </div>
      )}
    </div>
  );
}
