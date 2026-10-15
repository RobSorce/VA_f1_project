import React, { useMemo, useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  driverStyle, tyreColor, tyreLetter, withAlpha, markColor, textColor, CHART_FONT, chartFontPx,
  TEXT_COLORS, GRID_COLORS, SURFACES,
} from '../../utils/colors';
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
import { drawPositionRanges, positionRangeRow, POSITION_AXIS_H } from '../../utils/views/positionRangeChart';
import { drawLegend } from '../../utils/views/d3Legend';
import { useBoxSize, useChartBox, fitRows, pageOf } from '../../utils/views/chartBox';
import {
  placesMark, severityOf, levelMark, PODIUM_COLOR, CHART_COLORS, chipStyle, UP, DOWN,
} from '../../utils/views/strategyMarks';
import { useDemoMode, BACKEND_ONLY_TEXT, BACKEND_ONLY_FEATURES } from '../../utils/demoMode';
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

// Rows of the projection table: height range (px) and the pager's height
const ROW_MIN = 16;
const ROW_MAX = 26;
const ROW_DEFAULT = 20;
const PAGER_H = 22;
// Text columns beside the chart: P label, gain / loss, driver, now, podium
const TABLE_COLUMNS = '30px 30px 38px 54px 60px';

// Colours of the D3 position-range chart and its legend
const RANGE_COLORS = {
  bars: TEXT_COLORS.muted,
  range: TEXT_COLORS.secondary,
  shown: TEXT_COLORS.primary,
  shownStroke: SURFACES.page,
  now: TEXT_COLORS.primary,
  text: TEXT_COLORS.primary,
  rule: GRID_COLORS.rule,
  axis: GRID_COLORS.axis,
};

const muted = { color: CHART_COLORS.secondary };

export default function RacePredictionPanel() {
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const predictionLoading = useF1Store((s) => s.predictionLoading);
  // Static demo (no backend): the forecast is model-only, its tab says so
  const demoActive = useDemoMode((s) => s.active);
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
  // Battles listed: the store's list (it changes only on evidence beyond the
  // Monte Carlo error, utils/simulationClient.js listedBattles)
  const battles = useMemo(() => listedBattles(raceProjection), [raceProjection]);
  // Risk rows: the store's (judged beyond the Monte Carlo error, chained)
  const risks = useMemo(() => projectionRisks(raceProjection), [raceProjection]);

  const lapsRemaining = effectiveMaxLap - currentLap;
  const raceProgress = effectiveMaxLap > 0 ? currentLap / effectiveMaxLap : 0;
  const numDrivers = raceSituationData?.driverAbbrs?.length || raceProjection?.projections?.length || 20;

  const predTabs = useMemo(() => {
    if (!raceProjection) return [];
    const tabs = [{ id: 'projections', label: 'Projections' }];
    if (battles.length > 0)
      tabs.push({ id: 'battles', label: `Battles (${battles.length})` });
    if (risks.length > 0)
      tabs.push({ id: 'risks', label: `Risks (${risks.length})` });
    if (forecast || demoActive) tabs.push({ id: 'lstm', label: 'Forecast' });
    return tabs;
  }, [raceProjection, battles, risks, forecast, demoActive]);
  // A tab that has gone (no listed battle any more) falls back to the projections
  const shownTab = predTabs.some((t) => t.id === activeTab) ? activeTab : 'projections';

  const tabPillStyle = (active) => ({
    padding: '3px 8px', fontSize: CHART_FONT.label, fontWeight: 700,
    borderRadius: 4, border: `1px solid ${active ? CHART_COLORS.secondary : 'transparent'}`, cursor: 'pointer',
    background: active ? withAlpha(TEXT_COLORS.primary, 0.1) : 'transparent',
    color: active ? CHART_COLORS.text : CHART_COLORS.secondary,
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
              background: CHART_COLORS.surface,
              borderRadius: 'var(--radius-md)', padding: '4px var(--spacing-md)',
              borderLeft: `3px solid ${CHART_COLORS.secondary}`, flexShrink: 0, margin: '0 var(--spacing-sm)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3, gap: 8 }}>
                <span style={{ fontSize: CHART_FONT.data, fontWeight: 700, color: CHART_COLORS.text, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Monte Carlo Projection
                </span>
                <span style={{ fontSize: CHART_FONT.label, ...muted }}>
                  Lap {currentLap}/{effectiveMaxLap} &middot; {lapsRemaining} to go
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={currentLap}
                aria-valuemin={0}
                aria-valuemax={effectiveMaxLap}
                style={{ height: 3, borderRadius: 2, background: GRID_COLORS.axis, overflow: 'hidden', marginBottom: 4 }}
              >
                <div style={{
                  height: '100%', borderRadius: 2, backgroundColor: CHART_COLORS.secondary,
                  width: `${Math.min(100, raceProgress * 100)}%`, transition: 'width 0.5s ease',
                }} />
              </div>
              {raceParams && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: CHART_FONT.label, ...muted }}>
                  <span title={pitLossInfo.isFallback
                    ? 'No valid green-flag stop yet: fallback value (an assumption, not data)'
                    : `Median of ${pitLossInfo.n} green-flag stops in this race (in-lap + out-lap - 2 x the driver's green-flag median lap). Each simulated stop draws its loss around this median.`}
                  >
                    Pit loss: {pitLossInfo.value.toFixed(1)}s
                    {pitLossInfo.isFallback
                      ? ' fallback'
                      : ` median, race${pitLossInfo.p10 != null && pitLossInfo.p90 != null
                        ? ` (P10–P90 ${pitLossInfo.p10.toFixed(1)}–${pitLossInfo.p90.toFixed(1)}s, n=${pitLossInfo.n})`
                        : ` (n=${pitLossInfo.n})`}`}
                  </span>
                  <span title={lapNoiseEstimate?.source === 'race'
                    ? `Pooled residual sigma of the ${lapNoiseEstimate.stints} per-stint degradation fits of this race so far`
                      + ` (${lapNoiseEstimate.laps} clean laps, ${lapNoiseEstimate.dof} degrees of freedom): the lap-to-lap scatter`
                      + ' around each stint\'s tyre-age line. Few stints early in the race give a rough value: n is shown next to it.'
                    : `No fitted stint in this race yet: the value of the cached ${lapNoiseEstimate?.prior?.kind || 'dry'} races`}
                  >
                    Lap noise: {'±'}{raceParams.lapNoise.toFixed(2)}s{lapNoiseEstimate?.source ? ` ${lapNoiseEstimate.source}` : ''}
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
                display: 'flex', gap: 4, padding: '4px 8px', flexShrink: 0, flexWrap: 'wrap',
                borderBottom: `1px solid ${GRID_COLORS.grid}`,
              }}>
                {predTabs.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)} style={tabPillStyle(shownTab === t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {/* Tab content: every tab fits its box (rows paged, never scrolled) */}
            <div style={{
              flex: 1, minHeight: 0, overflow: 'hidden', padding: 'var(--spacing-sm)', display: 'flex', flexDirection: 'column',
            }}>

              {shownTab === 'projections' && (
                <ProjectionTable
                  projection={raceProjection}
                  selectedDrivers={selectedDrivers}
                  numDrivers={numDrivers}
                />
              )}

              {shownTab === 'battles' && battles.length > 0 && (
                <div style={{ background: CHART_COLORS.surface, borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)' }}>
                  <h6 style={{ color: CHART_COLORS.secondary, margin: '0 0 6px', fontSize: CHART_FONT.data, textTransform: 'uppercase', fontWeight: 700 }}>
                    Overtake Probabilities
                  </h6>
                  {/* A table of the listed pairs (at most BATTLE_LIST_SIZE rows): the share and its badge level */}
                  {battles.map((b) => {
                    // Badge level (Wilson interval + hysteresis, store): colour and glyph
                    const lv = levelMark(b.level);
                    const behind = driverStyle(b.behind);
                    const ahead = driverStyle(b.ahead);
                    return (
                      <div key={battleKey(b)} className="mcr-battle" style={{
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                        fontSize: CHART_FONT.data,
                      }}>
                        <span
                          title={`${b.behind} finishes ahead of ${b.ahead} in ${b.prob}% of the simulations. `
                            + `● = at least ${BATTLE_BADGE_PCT[0]} %, ●● = at least ${BATTLE_BADGE_PCT[1]} %. `
                            + `Listed: the pairs within 4 positions that are, beyond the Monte Carlo error, among the ${BATTLE_LIST_SIZE} `
                            + `most likely: a pair enters when fewer than ${BATTLE_LIST_SIZE} other pairs could be as likely (their `
                            + `intervals reach its interval) and stays until ${BATTLE_LIST_SIZE} other pairs are surely more likely; `
                            + 'while pairs are too close to call the list holds fewer rows. '
                            + `Order: two badges, one badge, then the others, each in race order. ${badgeRule(numSims)}`}
                          style={{
                            flexShrink: 0, minWidth: 64, display: 'inline-flex', gap: 4, alignItems: 'baseline',
                            fontWeight: 900, color: lv.color, fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          <span aria-label={lv.word} style={{ minWidth: 18 }}>{lv.glyph}</span>
                          {b.prob}%
                        </span>
                        <div style={{ flex: 1, lineHeight: 1.35, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                            <strong style={{ color: behind.text }}>{b.behind}</strong>
                            <span style={muted}>P{b.behindCurrentPos}</span>
                            <span style={muted}>{'→'}</span>
                            <strong style={{ color: ahead.text }}>{b.ahead}</strong>
                            <span style={muted}>P{b.aheadCurrentPos}</span>
                          </div>
                          <div style={{ fontSize: CHART_FONT.label, ...muted }}>
                            {b.behind} on {b.behindCompound} &middot; {b.ahead} on {b.aheadCompound}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {shownTab === 'risks' && risks.length > 0 && (
                <div style={{ background: CHART_COLORS.surface, borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)' }}>
                  <h6 style={{ color: CHART_COLORS.secondary, margin: '0 0 6px', fontSize: CHART_FONT.data, textTransform: 'uppercase', fontWeight: 700 }}>
                    Risk Factors
                  </h6>
                  {risks.map((r, i) => {
                    const sev = severityOf(r.severity);
                    return (
                      <div key={i} className="mcr-risk" style={{
                        display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4,
                        fontSize: CHART_FONT.data, lineHeight: 1.35,
                      }}>
                        <span
                          title={`Severity ${sev.word}`}
                          style={{
                            flexShrink: 0, minWidth: 20, height: 18, borderRadius: 3, padding: '0 3px',
                            border: `1.5px solid ${sev.color}`, color: sev.color, fontWeight: 900,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: CHART_FONT.data,
                          }}
                        >
                          {sev.glyph}
                        </span>
                        <div>
                          <span style={{
                            fontSize: CHART_FONT.label, fontWeight: 700, padding: '1px 4px',
                            borderRadius: 2, ...chipStyle(sev.color, 0.12), marginRight: 4,
                          }}>{r.type}</span>
                          <span style={{ color: CHART_COLORS.text }}>{r.description}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {shownTab === 'lstm' && !forecast && demoActive && (
                <div className="mcr-backend-only" style={{
                  fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary, lineHeight: 1.5,
                  padding: 'var(--spacing-sm) var(--spacing-md)',
                }}>
                  {BACKEND_ONLY_TEXT}: {BACKEND_ONLY_FEATURES.forecast}.
                </div>
              )}
              {shownTab === 'lstm' && forecast && (
                <div style={{
                  background: CHART_COLORS.surface,
                  borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)',
                  borderLeft: `3px solid ${CHART_COLORS.secondary}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: CHART_FONT.data, fontWeight: 700, color: CHART_COLORS.text, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      Lap-time forecast
                      {/* The method served (response method_label): chosen on
                          the validation races; the LSTM is named only when it
                          made the forecast, and lstm_note says when it loses */}
                      {forecast.method && (
                        <span
                          title={[forecast.lstm_note, forecast.method_note].filter(Boolean).join(' ') || undefined}
                          style={{
                            fontFamily: 'var(--font-mono)', fontSize: CHART_FONT.label, fontWeight: 700, letterSpacing: '0.04em',
                            padding: '1px 6px', borderRadius: 4, ...chipStyle(TEXT_COLORS.secondary, 0.1),
                            cursor: 'help', textTransform: 'none',
                          }}>{forecastMethodLabel(forecast)}</span>
                      )}
                      {forecastHeldOutMae(forecast) != null && (
                        <span
                          title={`${forecast.held_out?.metric || 'MAE over laps +1..+5'}; the method was chosen `
                            + `on the ${forecast.held_out?.selected_on || 'held-out'} races `
                            + '(notes/experiments/phase6/evaluate_forecast.txt).'}
                          style={{
                            fontFamily: 'var(--font-mono)', fontSize: CHART_FONT.label, fontWeight: 700, letterSpacing: '0.04em',
                            padding: '1px 6px', borderRadius: 4, ...chipStyle(TEXT_COLORS.muted, 0.08),
                            cursor: 'help', textTransform: 'none',
                          }}>{forecastHeldOutText(forecast)}</span>
                      )}
                    </span>
                    {predictionLoading && (
                      <span style={{ fontSize: CHART_FONT.label, ...muted }}>Loading...</span>
                    )}
                    {lastPredictionTrigger && (
                      <span style={{ fontSize: CHART_FONT.label, ...muted }}>
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
            background: CHART_COLORS.surface, borderRadius: 'var(--radius-md)',
            padding: 'var(--spacing-md)', textAlign: 'center',
          }}>
            <div style={{ fontSize: CHART_FONT.data, ...muted, lineHeight: 1.6 }}>
              {currentLap < 5 ? (
                <>
                  Monte Carlo simulation available after <strong style={{ color: CHART_COLORS.text }}>lap 5</strong>.
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
            <div style={{ fontSize: 'var(--font-size-sm)', color: CHART_COLORS.secondary, lineHeight: 1.8 }}>
              Race prediction applies to race sessions only (race or sprint).
            </div>
          </div>
        )}

        {/* ── Empty state: no replay running ── */}
        {isRace && !raceProjection && !raceSituationData && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: CHART_COLORS.secondary, lineHeight: 1.8 }}>
              <strong style={{ color: CHART_COLORS.text, display: 'block', marginBottom: 8, fontSize: 'var(--font-size-md)' }}>
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
 * The Projections tab: a table (median P label, places gained / lost, driver,
 * current position, podium share) beside a D3 chart of each driver's
 * finishing positions (utils/views/positionRangeChart.js), on rows of one
 * height; rows fitted to the box, paged when they do not fit (no scroll).
 */
function ProjectionTable({ projection, selectedDrivers, numDrivers }) {
  const rowsBoxRef = useRef(null);
  const chartBoxRef = useRef(null);
  const svgRef = useRef(null);
  const legendRef = useRef(null);
  const rowsBox = useBoxSize(rowsBoxRef);
  // the D3 chart's box: the shared, frame-throttled hook of the D3 views (D4)
  const chartBox = useChartBox(chartBoxRef, { parent: false });
  const [page, setPage] = useState(0);
  const badges = projection?.badges;

  // Rows by the position shown, then the current race position (never a raw Monte Carlo statistic)
  const ordered = useMemo(() => orderedProjections(projection), [projection]);
  const fit = fitRows(rowsBox.height > 0 ? rowsBox.height - POSITION_AXIS_H : 0, ordered.length, {
    rowMin: ROW_MIN, rowMax: ROW_MAX, rowDefault: ROW_DEFAULT, pagerH: PAGER_H,
  });
  const pg = pageOf(ordered, page, fit.perPage);
  const rows = pg.rows.map((p) => ({
    p,
    // Finishing position shown: the store's median (it changes only beyond the
    // Monte Carlo error of the whole column); its colour and the arrow follow it
    shownPos: modePosition(projection, p),
    change: positionChange(projection, p) ?? 0,
  }));
  const chartRows = rows.map(({ p, shownPos }) => positionRangeRow(p, {
    key: p.driver, label: p.driver, shown: shownPos, current: p.currentPos,
  }));

  useEffect(() => {
    if (!legendRef.current) return;
    const width = rowsBox.width > 0 ? rowsBox.width : 600;
    const g = d3.select(legendRef.current).selectAll('g.mcr-legend').data([0]).join('g').attr('class', 'mcr-legend chart-legend');
    const h = drawLegend(g, [
      { key: 'bars', label: 'share of runs per position', shape: 'rect', color: RANGE_COLORS.bars },
      { key: 'range', label: 'P5–P95', shape: 'line', color: RANGE_COLORS.range },
      { key: 'shown', label: 'P label (median)', shape: 'diamond', color: RANGE_COLORS.shown, stroke: RANGE_COLORS.shownStroke },
      { key: 'now', label: 'now', shape: 'triangle-down', color: RANGE_COLORS.now, hollow: true },
      { key: 'limits', label: 'podium | points limit', shape: 'dash', color: RANGE_COLORS.rule },
      { key: 'gain', label: `${UP} places gained`, shape: 'rect', color: CHART_COLORS.better },
      { key: 'loss', label: `${DOWN} places lost`, shape: 'rect', color: CHART_COLORS.worse },
      // the gold of the P label and of the "pod" share (V4 r2: only in tooltips)
      { key: 'podium', label: `gold P / pod: a podium (in >= ${PODIUM_BADGE_PCT} % of runs)`, shape: 'rect', color: PODIUM_COLOR },
    ], {
      font: CHART_FONT.data, fontPx: chartFontPx('data'), maxWidth: width - 8, textColor: RANGE_COLORS.text,
    });
    d3.select(legendRef.current).attr('width', width).attr('height', h + 2);
  }, [rowsBox.width]);

  useEffect(() => {
    if (!svgRef.current) return;
    drawPositionRanges(svgRef.current, {
      rows: chartRows,
      positions: numDrivers,
      width: chartBox.width > 0 ? chartBox.width : 160,
      rowH: fit.rowH,
      colors: RANGE_COLORS,
      font: CHART_FONT.data,
    });
  });

  const head = { fontSize: CHART_FONT.label, color: CHART_COLORS.secondary, fontWeight: 700 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 4 }}>
      <svg ref={legendRef} className="mcr-legend-svg" style={{ display: 'block', flexShrink: 0, maxWidth: '100%' }} />
      <div ref={rowsBoxRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div className="mcr-table" style={{ display: 'flex', alignItems: 'flex-start' }}>
          {/* Text columns: a table, one row per driver, the same height as the chart's rows */}
          <div role="table" aria-label="Monte Carlo projected finish" style={{ flexShrink: 0 }}>
            <div role="row" style={{
              display: 'grid', gridTemplateColumns: TABLE_COLUMNS, gap: 4, height: POSITION_AXIS_H, alignItems: 'end',
            }}>
              <span role="columnheader" style={head} title="Median finishing position">P</span>
              <span role="columnheader" style={head} title="Places gained (▲) or lost (▼) from the current position to the P label">+/−</span>
              <span role="columnheader" style={head}>Driver</span>
              <span role="columnheader" style={head}>Now</span>
              <span role="columnheader" style={{ ...head, textAlign: 'right' }}>Podium</span>
            </div>
            {rows.map(({ p, shownPos, change }) => {
              const isSelected = selectedDrivers.includes(p.driver);
              const style = driverStyle(p.driver);
              const mark = placesMark(change);
              const podiumBadge = badges ? badges.podium?.[p.driver] : p.podiumProb >= PODIUM_BADGE_PCT;
              return (
                <div key={p.driver} role="row" className="mcr-row-text" style={{
                  display: 'grid', gridTemplateColumns: TABLE_COLUMNS, gap: 4, alignItems: 'center',
                  height: fit.rowH, fontSize: CHART_FONT.data, lineHeight: 1,
                  background: isSelected ? withAlpha(TEXT_COLORS.primary, 0.06) : 'transparent',
                  boxShadow: isSelected ? `inset 2px 0 0 ${style.mark}` : 'none',
                }}>
                  {/* Position */}
                  <span
                    role="cell"
                    title={`Median finishing position: half of the simulations finish P${shownPos} or better `
                      + `(${p.posDistribution?.[shownPos] ?? 0}% exactly P${shownPos}; expected ${p.expectedPos}). ${positionRule} `
                      + `Gold = a podium place, i.e. a podium in at least ${PODIUM_BADGE_PCT} % of the simulations.`}
                    style={{
                      fontWeight: 900, paddingLeft: 4,
                      color: shownPos <= 3 ? PODIUM_COLOR : shownPos <= 10 ? CHART_COLORS.text : CHART_COLORS.secondary,
                    }}
                  >
                    P{shownPos}
                  </span>

                  {/* Gain / loss arrow: current position against the position shown */}
                  <span
                    role="cell"
                    title={change !== 0
                      ? `P${p.currentPos} now, P${shownPos} shown: ${change > 0 ? 'gains' : 'loses'} ${Math.abs(change)} place${Math.abs(change) === 1 ? '' : 's'}`
                      : `P${p.currentPos} now, P${shownPos} shown: no change`}
                    style={{ color: mark.color, fontWeight: 700, textAlign: 'center' }}
                  >
                    {change !== 0 ? `${mark.glyph}${Math.abs(change)}` : mark.glyph}
                  </span>

                  {/* Driver name */}
                  <span role="cell" style={{ fontWeight: 700, color: style.text }}>
                    {p.driver}
                  </span>

                  {/* Current position */}
                  <span role="cell" style={muted}>
                    now P{p.currentPos}
                  </span>

                  {/* Podium share: gold = podium badge (Wilson interval + hysteresis).
                      On every row, 0 % included: a chip hidden at 0 % appeared and
                      disappeared on Monte Carlo noise alone (D5) */}
                  <span
                    role="cell"
                    title={`Podium in ${p.podiumProb}% of the simulations. Gold = at least ${PODIUM_BADGE_PCT} %, `
                      + `the same statement as a gold P label (P1-P3: the median finishing position). ${positionRule}`}
                    style={{
                      fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap',
                      color: podiumBadge ? PODIUM_COLOR : CHART_COLORS.secondary,
                    }}
                  >
                    {p.podiumProb}% pod
                  </span>
                </div>
              );
            })}
          </div>
          {/* The D3 chart column: the position axis, then one row per table row */}
          <div ref={chartBoxRef} style={{ flex: 1, minWidth: 80, marginLeft: 6 }}>
            <svg ref={svgRef} className="mcr-svg" style={{ display: 'block' }} />
          </div>
        </div>
        {fit.paged && (
          <div className="mcr-pager" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: PAGER_H,
            fontSize: CHART_FONT.label, ...muted, flexShrink: 0,
          }}
          >
            <button type="button" aria-label="Previous rows" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} style={pagerButton}>{'◀'}</button>
            <span>rows {pg.first}{'–'}{pg.last} of {ordered.length}</span>
            <button type="button" aria-label="Next rows" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)} style={pagerButton}>{'▶'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

const pagerButton = {
  fontSize: CHART_FONT.label,
  color: TEXT_COLORS.primary,
  background: 'transparent',
  border: `1px solid ${GRID_COLORS.rule}`,
  borderRadius: 3,
  padding: '0 6px',
  cursor: 'pointer',
};

/**
 * The focus driver's lap-time forecast (store.lstmPredictions entry,
 * utils/forecast.js): each predicted time at its target lap, the pit
 * probability with the method behind it, the projected pit lap and stints,
 * and the response's notes (lstm_note says when the LSTM loses; reason when
 * there is no forecast).
 */
function ForecastRow({ pred }) {
  const driver = pred.driver;
  const points = forecastPoints(pred);
  const pit = forecastPit(pred);
  const optimal = typeof pred.optimal_pit_lap === 'number' ? pred.optimal_pit_lap : null;
  const stints = Array.isArray(pred.predicted_stints) ? pred.predicted_stints : [];
  const summary = typeof pred.summary === 'string' ? pred.summary : null;
  const notes = [pred.lstm_note, pred.method_note, pred.pit_note, pred.pit_projection_reason].filter(Boolean);

  // Pit-probability emphasis: the severity scheme (glyph and word in the
  // tooltip): high >= 60 %, medium 30-60 %, low < 30 %
  const pitPct = pit.probability != null ? Math.round(pit.probability * 100) : null;
  const pitSev = pitPct == null ? null : severityOf(pitPct >= 60 ? 'high' : pitPct >= 30 ? 'medium' : 'low');

  return (
    <div style={{
      padding: '6px 4px',
      borderBottom: `1px solid ${GRID_COLORS.grid}`,
      fontSize: CHART_FONT.data,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      {/* Header: driver, origin lap, pit probability */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, color: driverStyle(driver).text, letterSpacing: '0.04em' }}>
          {driver}
        </span>
        {Number.isFinite(pred.lap) && (
          <span style={muted}>from lap {pred.lap}</span>
        )}
        {pitPct != null && (
          <span
            title={`Pit stop within ${FORECAST_LAPS} laps${pit.label ? `, by the ${pit.label}` : ''} (${pitSev.word}: ${pitSev.glyph}).`}
            style={{ marginLeft: 'auto', ...muted }}
          >
            pit{pit.label ? ` (${pit.label})` : ''}: <strong style={{ color: pitSev.color, fontFamily: 'var(--font-mono)' }}>{pitPct}%</strong>
          </span>
        )}
      </div>

      {/* Predicted laps, each at its target lap */}
      {points.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {points.map(({ lap, time }) => (
            <span key={lap} style={{
              fontFamily: 'var(--font-mono)',
              padding: '1px 5px',
              borderRadius: 3,
              background: withAlpha(TEXT_COLORS.primary, 0.04),
              border: `1px solid ${GRID_COLORS.axis}`,
              color: CHART_COLORS.text,
            }}>
              L{lap} {time.toFixed(2)}s
            </span>
          ))}
        </div>
      )}

      {/* Projected pit lap + predicted stints */}
      {(optimal != null || stints.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {optimal != null && (
            <span style={muted}>
              optimal pit: <strong style={{ color: CHART_COLORS.text, fontFamily: 'var(--font-mono)' }}>L{optimal}</strong>
            </span>
          )}
          {stints.length > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...muted }}>
              stints:
              {stints.map((s, i) => {
                const hex = tyreColor(s.compound);
                return (
                  <span key={i} title={s.compound} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '0 5px', borderRadius: 3,
                    background: withAlpha(hex, 0.13), border: `1px solid ${markColor(hex)}`,
                    color: textColor(hex), fontFamily: 'var(--font-mono)', fontWeight: 700,
                  }}>
                    {tyreLetter(s.compound)} × {s.length || '?'}
                  </span>
                );
              })}
            </span>
          )}
        </div>
      )}

      {/* The response's summary and notes (which method, why, held-out standing) */}
      {summary && (
        <div style={{ fontSize: CHART_FONT.label, ...muted }}>
          {summary}
        </div>
      )}
      {notes.map((n) => (
        <div key={n} style={{ fontSize: CHART_FONT.label, ...muted }}>{n}</div>
      ))}

      {/* No forecast (fewer than 3 clean laps at the clock): the reason */}
      {points.length === 0 && (
        <div style={muted}>
          {pred.reason || 'No forecast for this lap.'}
        </div>
      )}
    </div>
  );
}
