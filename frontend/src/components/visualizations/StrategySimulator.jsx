import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  driverStyle, tyreColor, tyreLetter, markColor, textColor, contrastText, withAlpha, CHART_FONT, chartFontPx,
  TEXT_COLORS, GRID_COLORS, SURFACES, UI_COLORS,
} from '../../utils/colors';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { stintsByDriver } from '../../utils/stints';
import { causalKey, simulatorStints } from '../../utils/strategyViews';
import { DEFAULT_NUM_SIMULATIONS } from '../../utils/raceSimulation';
import { planFromStints, whatIfMarksOf, pairedInterval } from '../../utils/simulationClient';
import { drawStintStrips, stintSegments, lapTicks } from '../../utils/views/stintStripChart';
import { drawPositionRanges, positionRangeRow, POSITION_AXIS_H } from '../../utils/views/positionRangeChart';
import { drawLegend } from '../../utils/views/d3Legend';
import { useBoxSize, useChartBox, fitRows, pageOf } from '../../utils/views/chartBox';
import {
  CHART_COLORS, SEVERITY, PODIUM_COLOR, verdictMark, MINUS,
} from '../../utils/views/strategyMarks';
import Panel from '../ui/Panel';

const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

export default function StrategySimulator() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const simulatorStrategy = useF1Store((s) => s.simulatorStrategy);
  const simulatorResult = useF1Store((s) => s.simulatorResult);
  const simulatorComparisons = useF1Store((s) => s.simulatorComparisons);
  const isSimulatorActive = useF1Store((s) => s.isSimulatorActive);
  const simulatorBaseline = useF1Store((s) => s.simulatorBaseline);
  const setSimulatorStrategy = useF1Store((s) => s.setSimulatorStrategy);
  const setSimulatorBaseline = useF1Store((s) => s.setSimulatorBaseline);
  const runSimulation = useF1Store((s) => s.runSimulation);
  const toggleSimulator = useF1Store((s) => s.toggleSimulator);
  const clearSimulator = useF1Store((s) => s.clearSimulator);
  const addSimulatorComparison = useF1Store((s) => s.addSimulatorComparison);
  const raceSituationData = useF1Store((s) => s.raceSituationData);

  const effectiveMaxLap = totalRaceLaps || maxLap || 60;
  const driver = simulatorStrategy?.driver || focusDriver || (selectedDrivers.length === 1 ? selectedDrivers[0] : null);

  // Local editing state for stints
  const [editStints, setEditStints] = useState([
    { compound: 'SOFT', lapStart: 1, length: Math.round(effectiveMaxLap / 3) },
    { compound: 'MEDIUM', lapStart: Math.round(effectiveMaxLap / 3) + 1, length: Math.round(effectiveMaxLap / 3) },
    { compound: 'HARD', lapStart: Math.round(effectiveMaxLap * 2 / 3) + 1, length: effectiveMaxLap - Math.round(effectiveMaxLap * 2 / 3) },
  ]);
  const [editDriver, setEditDriver] = useState(driver);
  // Tab picked (Plan / Result / Compare); null = the result when there is one
  const [tab, setTab] = useState(null);

  // Sync driver from store
  useEffect(() => {
    if (driver && driver !== editDriver) setEditDriver(driver);
  }, [driver]);

  // If store has a strategy (e.g. from PCA pattern), load it into local state
  useEffect(() => {
    if (simulatorStrategy?.stints?.length && simulatorStrategy.driver) {
      setEditStints(simulatorStrategy.stints.map((s) => ({ ...s })));
      setEditDriver(simulatorStrategy.driver);
    }
  }, [simulatorStrategy]);

  // Available drivers
  const driverList = useMemo(() => {
    if (!raceSituationData?.driverAbbrs) return [];
    return raceSituationData.driverAbbrs;
  }, [raceSituationData]);

  // Current actual strategy for the driver: stints from the FastF1 Stint
  // column of the laps completed at sessionNow (utils/stints.js), so the
  // replay never shows a stint before it happens.
  // Live mode: the current stint stays ongoing until the flag, so the plan
  // reaches the race distance (simulatorStints)
  const sessionNow = useSessionNow();
  const running = useStintsRunning();
  const lapTimes = sessionData?.lap_times;
  const causal = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  const actualStints = useMemo(() => {
    if (!editDriver) return [];
    return stintsByDriver(lapTimes || [], { sessionNow, running })[editDriver] || [];
  }, [lapTimes, causal, editDriver, running]);
  const actualStrategy = useMemo(() => actualStints.map((s) => ({
    compound: s.Compound,
    lapStart: s.StartLap,
    length: s.TotalLaps,
  })), [actualStints]);

  // Recalculate lapStart values when stints change
  const normalizeStints = useCallback((stints) => {
    let lapStart = 1;
    return stints.map((s) => {
      const normalized = { ...s, lapStart };
      lapStart += s.length;
      return normalized;
    });
  }, []);

  const handleCompoundChange = (idx, compound) => {
    const updated = [...editStints];
    updated[idx] = { ...updated[idx], compound };
    setEditStints(updated);
  };

  const handleLengthChange = (idx, newLength) => {
    const updated = [...editStints];
    updated[idx] = { ...updated[idx], length: Math.max(1, newLength) };
    setEditStints(normalizeStints(updated));
  };

  const addStint = () => {
    const totalUsed = editStints.reduce((s, st) => s + st.length, 0);
    const remaining = Math.max(5, effectiveMaxLap - totalUsed);
    const newStints = [...editStints, { compound: 'MEDIUM', lapStart: totalUsed + 1, length: remaining }];
    setEditStints(normalizeStints(newStints));
  };

  const removeStint = (idx) => {
    if (editStints.length <= 1) return;
    const updated = editStints.filter((_, i) => i !== idx);
    setEditStints(normalizeStints(updated));
  };

  const handleRunSimulation = () => {
    if (!editDriver) return;
    const stints = normalizeStints(editStints);
    // Active: the what-if is recomputed at the new clock after a seek
    setSimulatorStrategy({ driver: editDriver, stints });
    if (!isSimulatorActive) toggleSimulator();
    runSimulation();
    setTab('result');
  };

  // The plan's stops the simulation applies: in-laps from the lap in progress
  // on (earlier ones are the race's own history)
  const plannedStops = useMemo(() => planFromStints(normalizeStints(editStints)), [editStints, normalizeStints]);
  const futureStops = plannedStops.filter((s) => s.lap >= currentLap && s.lap < effectiveMaxLap);
  const pastStops = plannedStops.length - futureStops.length;

  const handleSaveComparison = () => {
    if (!simulatorResult) return;
    const label = editStints.map((s) => `${s.compound[0]}${s.length}`).join('-');
    addSimulatorComparison(label, [...editStints], simulatorResult);
  };

  const handleCopyActual = () => {
    // The plan must reach the flag: the ongoing stint is extended to the
    // race length as the editable "no further stop" baseline
    const plan = simulatorStints(actualStints, effectiveMaxLap);
    if (plan.length > 0) {
      setEditStints(plan);
    }
  };

  const totalLaps = editStints.reduce((s, st) => s + st.length, 0);

  // No-driver empty state
  if (!editDriver && driverList.length === 0) {
    return (
      <Panel title="Strategy Simulator">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-md)', color: CHART_COLORS.text, fontWeight: 700, marginBottom: 12 }}>
            What-If Strategy Simulator
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: TEXT_COLORS.secondary, lineHeight: 1.8, maxWidth: 260 }}>
            Start the race replay past <strong>lap 5</strong> to activate Monte Carlo simulation.
          </div>
          <div style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary, marginTop: 12, maxWidth: 260, lineHeight: 1.6 }}>
            Then focus a driver (double-click in Leaderboard) and define an alternative pit strategy to see projected outcomes.
          </div>
        </div>
      </Panel>
    );
  }

  const driverMark = editDriver ? driverStyle(editDriver) : null;
  const canRun = editDriver && currentLap >= 5 && editStints.length > 0 && raceSituationData?.driverFeatures;
  // The tab shown: the one picked while it has content, else the result when
  // there is one, else the plan
  const pickedHasContent = tab === 'plan' || (tab === 'result' && simulatorResult)
    || (tab === 'compare' && simulatorComparisons.length > 0);
  const shownTab = pickedHasContent ? tab : (simulatorResult ? 'result' : 'plan');
  const tabs = [
    { id: 'plan', label: 'Plan' },
    { id: 'result', label: 'Result', disabled: !simulatorResult },
    { id: 'compare', label: `Compare (${simulatorComparisons.length})`, disabled: simulatorComparisons.length === 0 },
  ];
  const lapsOff = totalLaps - effectiveMaxLap;
  const coverSev = Math.abs(lapsOff) > 2 ? SEVERITY.high : SEVERITY.medium;
  // Rows of the strip chart: the custom plan, and the actual strategy so far
  const stripRows = [
    {
      key: 'custom',
      label: 'Plan',
      segments: stintSegments(normalizeStints(editStints)).map((s, i) => ({
        ...s, title: `Plan stint ${i + 1}: ${s.compound}, ${s.length} laps from L${s.start}`,
      })),
    },
    ...(actualStrategy.length > 0 ? [{
      key: 'actual',
      label: actualStints.some((s) => s.ongoing) ? 'So far' : 'Actual',
      segments: stintSegments(actualStrategy).map((s, i) => ({
        ...s, title: `Actual stint ${i + 1}: ${s.compound}, ${s.length} laps from L${s.start}`,
      })),
    }] : []),
  ];

  return (
    <Panel title="Strategy Simulator">
      <div className="sim" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 6, fontSize: CHART_FONT.data }}>

        {/* ── Driver Selector ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', flexShrink: 0,
          background: CHART_COLORS.surface,
          borderRadius: 'var(--radius-md)', borderLeft: `3px solid ${driverMark?.mark || CHART_COLORS.muted}`,
        }}>
          <span style={labelStyle}>DRIVER</span>
          <select
            value={editDriver || ''}
            onChange={(e) => setEditDriver(e.target.value)}
            aria-label="Driver of the plan"
            style={{
              background: CHART_COLORS.surface, border: `1px solid ${GRID_COLORS.rule}`,
              borderRadius: 3, color: driverMark?.text || CHART_COLORS.text, fontSize: CHART_FONT.data,
              fontWeight: 700, padding: '2px 6px', cursor: 'pointer',
            }}
          >
            <option value="" style={optionStyle}>Select driver</option>
            {driverList.map((d) => (
              <option key={d} value={d} style={optionStyle}>{d}</option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: CHART_FONT.label, ...muted }}>
            L{currentLap}/{effectiveMaxLap}
          </span>
          {actualStrategy.length > 0 && (
            <button type="button" onClick={handleCopyActual} title="Copy actual race strategy" style={smallButton}>
              Copy Actual
            </button>
          )}
        </div>

        {/* ── Tabs: one view at a time, each fitted to the panel (no scroll) ── */}
        <div role="tablist" style={{ display: 'flex', gap: 4, flexShrink: 0, borderBottom: `1px solid ${GRID_COLORS.grid}`, paddingBottom: 4 }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={shownTab === t.id}
              disabled={t.disabled}
              onClick={() => setTab(t.id)}
              style={tabStyle(shownTab === t.id, t.disabled)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shownTab === 'plan' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <h6 style={{ ...labelStyle, fontSize: CHART_FONT.data, margin: 0 }}>
                  Custom Strategy ({editStints.length - 1} stops)
                </h6>
                <button type="button" onClick={addStint} style={smallButton}>+ Pit Stop</button>
              </div>

              {/* The plan and the actual strategy as D3 stint strips on one lap axis, the lap in progress marked */}
              <StintStrips rows={stripRows} laps={Math.max(totalLaps, effectiveMaxLap)} currentLap={currentLap} />

              {/* Per-stint rows, fitted to the space left (paged when they do not fit) */}
              <StintEditor
                stints={editStints}
                maxLength={Math.max(5, effectiveMaxLap - 5)}
                onCompound={handleCompoundChange}
                onLength={handleLengthChange}
                onRemove={removeStint}
              />

              {/* Total laps warning: severity glyph and the signed difference */}
              {totalLaps !== effectiveMaxLap && (
                <div style={{ fontSize: CHART_FONT.label, color: coverSev.color, flexShrink: 0 }}>
                  <span aria-label={`severity ${coverSev.word}`}>{coverSev.glyph}</span>
                  {' '}Strategy covers {totalLaps} laps ({lapsOff > 0 ? '+' : lapsOff < 0 ? MINUS : ''}{Math.abs(lapsOff)} vs race length {effectiveMaxLap})
                </div>
              )}

              {/* What the simulation applies: the planned stops from the lap in progress on */}
              {currentLap > 0 && (
                <div
                  title="Each planned stop is made at the end of its in-lap and charged a pit loss drawn around the race's median. The driver's laps, tyres and stops before the lap in progress are the race's own."
                  style={{ fontSize: CHART_FONT.label, ...muted, lineHeight: 1.4, flexShrink: 0 }}
                >
                  From L{currentLap}: {futureStops.length === 0
                    ? 'no further stop'
                    : futureStops.map((s) => `in-lap ${s.lap} → ${s.compound}`).join(', ')}
                  {pastStops > 0 && ` · ${pastStops} earlier stop${pastStops === 1 ? '' : 's'} = race history`}
                </div>
              )}

              {/* ── Run Button ── */}
              <button
                type="button"
                onClick={handleRunSimulation}
                disabled={!canRun}
                style={{
                  width: '100%', padding: '6px 0', flexShrink: 0,
                  background: canRun ? UI_COLORS.brush : withAlpha(TEXT_COLORS.primary, 0.06),
                  border: 'none', borderRadius: 'var(--radius-md)',
                  color: canRun ? contrastText(UI_COLORS.brush) : TEXT_COLORS.secondary,
                  fontWeight: 900, fontSize: CHART_FONT.data,
                  cursor: canRun ? 'pointer' : 'default',
                  textTransform: 'uppercase', letterSpacing: '0.1em',
                  fontFamily: "'Titillium Web', sans-serif",
                }}
              >
                {!canRun
                  ? (currentLap < 5 ? 'Needs lap 5+' : !editDriver ? 'Select a driver' : 'No race data')
                  : `Run Simulation (${DEFAULT_NUM_SIMULATIONS.toLocaleString('en-US')} sims)`}
              </button>
            </>
          )}

          {/* ── Simulation Results ── */}
          {shownTab === 'result' && simulatorResult && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ ...labelStyle, fontSize: CHART_FONT.data }}>Simulation Results</span>
                <button type="button" onClick={handleSaveComparison} style={smallButton}>Save for Compare</button>
              </div>

              {/* Position comparison */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <ResultCard
                  label="Custom Strategy"
                  pos={simulatorResult.simProjection.expectedPos}
                  modePos={whatIfMarksOf(simulatorResult).shown.custom}
                  range={simulatorResult.simProjection.posRange}
                  podium={simulatorResult.simProjection.podiumProb}
                  points={simulatorResult.simProjection.pointsProb}
                  accent={UI_COLORS.brush}
                />
                <ResultCard
                  label={simulatorResult.baselineLabel ? `Baseline: ${simulatorResult.baselineLabel}` : 'Baseline: model stops'}
                  pos={simulatorResult.baselineProjection.expectedPos}
                  modePos={whatIfMarksOf(simulatorResult).shown.baseline}
                  range={simulatorResult.baselineProjection.posRange}
                  podium={simulatorResult.baselineProjection.podiumProb}
                  points={simulatorResult.baselineProjection.pointsProb}
                  accent={TEXT_COLORS.muted}
                />
              </div>

              {/* The two finishing distributions on one position axis (D3) */}
              <ResultRanges result={simulatorResult} positions={driverList.length || 20} />

              {/* Delta summary */}
              <DeltaSummary
                delta={simulatorResult.delta}
                marks={whatIfMarksOf(simulatorResult)}
                paired={simulatorResult.paired}
              />
              <div style={{ fontSize: CHART_FONT.label, ...muted, lineHeight: 1.4, flexShrink: 0 }}>
                {simulatorResult.numSimulations?.toLocaleString('en-US')} sims at L{simulatorResult.computedAtLap},
                {' '}both runs on the same random numbers: an identical plan differs by exactly 0.
                {simulatorBaseline && (
                  <button
                    type="button"
                    onClick={() => setSimulatorBaseline(null)}
                    title="Compare with the model's own stops again"
                    style={{
                      marginLeft: 6, background: 'none', border: 'none', padding: 0,
                      color: UI_COLORS.brush, cursor: 'pointer', fontSize: CHART_FONT.label, textDecoration: 'underline',
                    }}
                  >
                    vs model stops
                  </button>
                )}
              </div>
            </>
          )}

          {/* ── Saved Comparisons ── */}
          {shownTab === 'compare' && simulatorComparisons.length > 0 && (
            <ComparisonTable
              comparisons={simulatorComparisons}
              baseline={simulatorBaseline}
              laps={effectiveMaxLap}
              onBaseline={(comp) => setSimulatorBaseline({ label: comp.label, stints: comp.stints })}
            />
          )}
        </div>

        {/* ── Clear button ── */}
        {(simulatorResult || isSimulatorActive) && (
          <button
            type="button"
            onClick={() => { setTab(null); clearSimulator(); }}
            style={{ ...smallButton, width: '100%', padding: '3px 0', flexShrink: 0 }}
          >
            × Clear Simulator
          </button>
        )}
      </div>
    </Panel>
  );
}

// ── Styles of the panel (palette of utils/colors.js, CSS font tokens) ──
const muted = { color: TEXT_COLORS.secondary };
const labelStyle = {
  fontSize: CHART_FONT.label, fontWeight: 700, color: TEXT_COLORS.secondary, textTransform: 'uppercase',
};
const optionStyle = { background: CHART_COLORS.surface, color: CHART_COLORS.text };
const smallButton = {
  background: withAlpha(TEXT_COLORS.primary, 0.06), border: `1px solid ${GRID_COLORS.rule}`,
  borderRadius: 3, padding: '2px 8px', fontSize: CHART_FONT.label, color: TEXT_COLORS.primary,
  cursor: 'pointer', fontWeight: 600,
};
const tabStyle = (active, disabled) => ({
  padding: '3px 8px', fontSize: CHART_FONT.label, fontWeight: 700,
  borderRadius: 4, border: `1px solid ${active ? TEXT_COLORS.secondary : 'transparent'}`,
  cursor: disabled ? 'default' : 'pointer',
  background: active ? withAlpha(TEXT_COLORS.primary, 0.1) : 'transparent',
  color: active ? TEXT_COLORS.primary : TEXT_COLORS.secondary,
  opacity: disabled ? 0.55 : 1,
});

// Stint editor rows: height range and the pager's height (px)
const EDIT_ROW_MIN = 24;
const EDIT_ROW_MAX = 30;
const PAGER_H = 22;

/**
 * The stint strips of the plan (and of the actual strategy) drawn by D3
 * (utils/views/stintStripChart.js): compound colour and letter, length, a lap
 * axis, the lap in progress as a vertical line.
 */
function StintStrips({ rows, laps, currentLap }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  // a D3 drawing: the shared, frame-throttled hook of the D3 views (D4)
  const box = useChartBox(boxRef, { parent: false });
  const rowH = Math.max(18, Math.round(chartFontPx('data') * 1.8));
  useEffect(() => {
    if (!svgRef.current) return;
    drawStintStrips(svgRef.current, {
      rows,
      domain: [1, laps + 1],
      width: box.width > 0 ? box.width : 240,
      rowH,
      labelW: 48,
      axis: { ticks: lapTicks(laps), format: (v) => `L${v}` },
      marker: currentLap > 0 && currentLap <= laps
        ? { value: currentLap + 0.5, title: `Lap in progress: L${currentLap}` }
        : null,
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
    });
  });
  return (
    <div ref={boxRef} className="sim-strips" style={{ flexShrink: 0, minWidth: 0 }}>
      <svg ref={svgRef} className="sim-strips-svg" style={{ display: 'block', maxWidth: '100%' }} />
    </div>
  );
}

/** The editable stints, rows fitted to the box, paged when they do not fit. */
function StintEditor({ stints, maxLength, onCompound, onLength, onRemove }) {
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
  const [page, setPage] = useState(0);
  const fit = fitRows(box.height, stints.length, {
    rowMin: EDIT_ROW_MIN, rowMax: EDIT_ROW_MAX, rowDefault: EDIT_ROW_MAX, pagerH: PAGER_H,
  });
  const pg = pageOf(stints.map((s, i) => ({ s, i })), page, fit.perPage);
  return (
    <div ref={boxRef} className="sim-editor" style={{ flex: 1, minHeight: EDIT_ROW_MIN, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {pg.rows.map(({ s: stint, i }) => {
        const hex = tyreColor(stint.compound);
        return (
          <div key={i} className="sim-stint-row" style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px', height: fit.rowH, flexShrink: 0,
            borderLeft: `3px solid ${markColor(hex)}`,
          }}>
            <span style={{ fontSize: CHART_FONT.label, fontWeight: 700, ...muted, minWidth: 16 }}>
              S{i + 1}
            </span>

            {/* Compound selector: the letter on the FIA colour (black or white by contrast) */}
            <div role="radiogroup" aria-label={`Stint ${i + 1} compound`} style={{ display: 'flex', gap: 2 }}>
              {COMPOUNDS.slice(0, 3).map((c) => {
                const on = stint.compound === c;
                const fill = tyreColor(c);
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onCompound(i, c)}
                    title={c}
                    style={{
                      width: 20, height: 20, borderRadius: '50%', padding: 0,
                      backgroundColor: on ? fill : 'transparent',
                      border: `2px solid ${on ? TEXT_COLORS.primary : markColor(fill)}`,
                      color: on ? contrastText(fill) : textColor(fill),
                      cursor: 'pointer', fontSize: CHART_FONT.label, fontWeight: 900, lineHeight: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {tyreLetter(c)}
                  </button>
                );
              })}
            </div>

            {/* Length slider */}
            <span style={{ fontSize: CHART_FONT.label, ...muted }}>L{stint.lapStart}</span>
            <input
              type="range"
              min={3}
              max={maxLength}
              value={stint.length}
              aria-label={`Stint ${i + 1} length`}
              onChange={(e) => onLength(i, parseInt(e.target.value, 10))}
              style={{ flex: 1, minWidth: 40, cursor: 'pointer', accentColor: markColor(hex) }}
            />
            <span style={{ fontSize: CHART_FONT.data, fontWeight: 700, color: TEXT_COLORS.primary, minWidth: 26, textAlign: 'right' }}>
              {stint.length}L
            </span>

            {/* Remove */}
            {stints.length > 1 && (
              <button
                type="button"
                onClick={() => onRemove(i)}
                title="Remove stint"
                aria-label={`Remove stint ${i + 1}`}
                style={{ ...smallButton, padding: '0 6px', flexShrink: 0 }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {fit.paged && (
        <Pager page={pg} total={stints.length} onPage={setPage} what="stints" />
      )}
    </div>
  );
}

/** ◀ rows a–b of n ▶ */
function Pager({ page, total, onPage, what }) {
  return (
    <div className="sim-pager" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: PAGER_H, flexShrink: 0,
      fontSize: CHART_FONT.label, ...muted,
    }}
    >
      <button type="button" aria-label={`Previous ${what}`} disabled={page.page === 0} onClick={() => onPage(page.page - 1)} style={{ ...smallButton, padding: '0 6px' }}>{'◀'}</button>
      <span>{what} {page.first}{'–'}{page.last} of {total}</span>
      <button type="button" aria-label={`Next ${what}`} disabled={page.page >= page.pages - 1} onClick={() => onPage(page.page + 1)} style={{ ...smallButton, padding: '0 6px' }}>{'▶'}</button>
    </div>
  );
}

/**
 * The finishing distributions of the custom plan and the baseline on one
 * position axis (D3, utils/views/positionRangeChart.js): the share of the
 * runs per position, the P5–P95 range and the P label of each card.
 */
function ResultRanges({ result, positions }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const legendRef = useRef(null);
  // a D3 drawing: the shared, frame-throttled hook of the D3 views (D4)
  const box = useChartBox(boxRef, { parent: false });
  const marks = whatIfMarksOf(result);
  const rows = [
    positionRangeRow(result.simProjection, { key: 'custom', label: 'Custom strategy', shown: marks.shown.custom }),
    positionRangeRow(result.baselineProjection, { key: 'baseline', label: 'Baseline', shown: marks.shown.baseline }),
  ];
  const rowH = Math.max(20, Math.round(chartFontPx('data') * 2));
  useEffect(() => {
    const width = box.width > 0 ? box.width : 240;
    if (legendRef.current) {
      const g = d3.select(legendRef.current).selectAll('g.mcr-legend').data([0]).join('g').attr('class', 'mcr-legend chart-legend');
      const h = drawLegend(g, [
        { key: 'bars', label: 'share of runs per position', shape: 'rect', color: RANGE_COLORS.bars },
        { key: 'range', label: 'P5–P95', shape: 'line', color: RANGE_COLORS.range },
        { key: 'shown', label: 'P label (median)', shape: 'diamond', color: RANGE_COLORS.shown, stroke: RANGE_COLORS.shownStroke },
      ], {
        font: CHART_FONT.data, fontPx: chartFontPx('data'), maxWidth: width - 8, textColor: RANGE_COLORS.text,
      });
      d3.select(legendRef.current).attr('width', width).attr('height', h + 2);
    }
    if (svgRef.current) {
      drawPositionRanges(svgRef.current, {
        rows, positions, width: Math.max(80, width - RANGE_LABEL_W), rowH, colors: RANGE_COLORS, font: CHART_FONT.data,
      });
    }
  });
  return (
    <div ref={boxRef} className="sim-ranges" style={{ flexShrink: 0, minWidth: 0 }}>
      <svg ref={legendRef} className="sim-ranges-legend" style={{ display: 'block', maxWidth: '100%' }} />
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div role="list" aria-label="Plans" style={{ width: RANGE_LABEL_W, flexShrink: 0, paddingTop: POSITION_AXIS_H }}>
          {rows.map((r) => (
            <div key={r.key} role="listitem" style={{ height: rowH, display: 'flex', alignItems: 'center', fontSize: CHART_FONT.label, ...muted, fontWeight: 700 }}>
              {r.key === 'custom' ? 'Plan' : 'Baseline'}
            </div>
          ))}
        </div>
        <svg ref={svgRef} className="sim-ranges-svg" style={{ display: 'block', minWidth: 0 }} />
      </div>
    </div>
  );
}
const RANGE_LABEL_W = 62;
// Colours of the position-range chart (the Race Prediction panel's)
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

/** Saved comparisons: a table (label, D3 stint strip, P label and difference, "vs"), paged to fit. */
function ComparisonTable({ comparisons, baseline, laps, onBaseline }) {
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
  const [page, setPage] = useState(0);
  const fit = fitRows(box.height > 0 ? box.height - 24 : 0, comparisons.length, {
    rowMin: 24, rowMax: 30, rowDefault: 26, pagerH: PAGER_H,
  });
  const pg = pageOf(comparisons.map((comp, i) => ({ comp, i })), page, fit.perPage);
  return (
    <div ref={boxRef} className="sim-compare" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <h6 style={{ ...labelStyle, fontSize: CHART_FONT.data, margin: '0 0 4px', height: 20, flexShrink: 0 }}>
        Strategy Comparisons ({comparisons.length})
      </h6>
      <div role="table" aria-label="Saved strategy comparisons" style={{ display: 'flex', flexDirection: 'column' }}>
        {pg.rows.map(({ comp, i }) => {
          const marks = comp.result ? whatIfMarksOf(comp.result) : null;
          const verdict = marks ? verdictMark(marks.verdict) : null;
          const diff = comp.result ? shownDifference(comp.result.delta, comp.result.paired) : null;
          return (
            <div key={i} role="row" style={{
              display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr) auto auto', gap: 6, alignItems: 'center',
              height: fit.rowH, flexShrink: 0,
            }}>
              <span role="cell" style={{ fontWeight: 700, color: TEXT_COLORS.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={comp.label}>
                {comp.label}
              </span>
              <span role="cell" style={{ minWidth: 0 }}>
                <ComparisonStrip stints={comp.stints} laps={laps} rowH={Math.max(16, fit.rowH - 6)} />
              </span>
              {marks ? (
                <span role="cell" title="P label of the plan (median) and the places it gains (▲, +) or loses (▼, −) on its baseline" style={{ fontWeight: 700, color: verdict.color, whiteSpace: 'nowrap' }}>
                  P{marks.shown.custom ?? '—'} {verdict.glyph} {signedPlaces(diff)}
                </span>
              ) : <span role="cell" />}
              <button
                type="button"
                role="cell"
                onClick={() => onBaseline(comp)}
                title="Compare the custom strategy with this plan (same random numbers)"
                aria-pressed={baseline?.stints === comp.stints}
                style={{
                  ...smallButton, padding: '0 6px',
                  background: baseline?.stints === comp.stints ? withAlpha(UI_COLORS.brush, 0.2) : smallButton.background,
                }}
              >
                vs
              </button>
            </div>
          );
        })}
      </div>
      {fit.paged && <Pager page={pg} total={comparisons.length} onPage={setPage} what="plans" />}
    </div>
  );
}

/** One saved plan as a D3 stint strip (compound letter and length on each segment). */
function ComparisonStrip({ stints, laps, rowH }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  // a D3 drawing: the shared, frame-throttled hook of the D3 views (D4)
  const box = useChartBox(boxRef, { parent: false });
  useEffect(() => {
    if (!svgRef.current) return;
    const segs = stintSegments(stints);
    const end = Math.max(laps, ...segs.map((s) => s.start + s.length - 1));
    drawStintStrips(svgRef.current, {
      rows: [{ key: 'plan', label: '', segments: segs }],
      domain: [1, end + 1],
      width: box.width > 0 ? box.width : 120,
      rowH,
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
    });
  });
  return (
    <div ref={boxRef} style={{ minWidth: 0 }}>
      <svg ref={svgRef} className="sim-compare-strip" style={{ display: 'block', maxWidth: '100%' }} />
    </div>
  );
}

function ResultCard({ label, pos, modePos, range, podium, points, accent }) {
  const safePos = typeof pos === 'number' ? pos : 0;
  const safeMode = modePos ?? '—';
  const r0 = range?.[0] ?? '—';
  const r1 = range?.[1] ?? '—';
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: withAlpha(TEXT_COLORS.primary, 0.03), borderRadius: 'var(--radius-sm)',
      padding: '4px 8px', borderTop: `2px solid ${accent}`,
    }}>
      <div style={{ fontSize: CHART_FONT.label, fontWeight: 600, ...muted, marginBottom: 2, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
        {label}
      </div>
      <div
        title="Median finishing position: half of the simulations finish there or better (the same rule as the Race Prediction table)"
        style={{ fontSize: 'var(--font-size-lg)', fontWeight: 900, color: TEXT_COLORS.primary }}
      >
        P{safeMode}
      </div>
      <div style={{ fontSize: CHART_FONT.label, ...muted }}>
        avg P{safePos.toFixed(1)} · range P{r0}–P{r1}
      </div>
      {/* Always shown (a chip hidden at 0 % appeared and disappeared on Monte
          Carlo noise); gold = the P label is a podium, as in the Race Prediction panel */}
      <div style={{ display: 'flex', gap: 8, marginTop: 2, fontSize: CHART_FONT.label, flexWrap: 'wrap' }}>
        <span style={{ color: modePos <= 3 ? PODIUM_COLOR : TEXT_COLORS.secondary, fontWeight: 700 }}>
          {podium ?? 0}% podium
        </span>
        <span style={muted}>
          {points ?? 0}% points
        </span>
      </div>
    </div>
  );
}

/**
 * Signed difference in places: "+1.8", "−1.6", "0.0" (positive = places
 * gained); two decimals below 0.1, so a difference beyond the Monte Carlo
 * error never reads 0.0.
 */
function signedPlaces(v) {
  if (!v) return '0.0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(Math.abs(v) < 0.095 ? 2 : 1)}`;
}

/**
 * The position difference shown: the mean of the run-by-run differences
 * (paired.position: the baseline's expected position minus the plan's,
 * unrounded) when known, else delta.position.
 */
function shownDifference(delta, paired) {
  const m = paired?.position?.mean;
  return Number.isFinite(m) ? m : delta?.position;
}

/** Half-width of a paired interval (pairedInterval), or null. */
function pairedHalfWidth(stats) {
  const iv = pairedInterval(stats);
  return iv ? (iv[1] - iv[0]) / 2 : null;
}

function DeltaSummary({ delta, marks, paired }) {
  // The verdict, its arrow and colour (whatIfMarks, strategyMarks.verdictMark:
  // blue ▲ gained, orange ▼ lost, • no clear change): a gain or a loss only
  // beyond the Monte Carlo error of the run-by-run differences (both runs
  // share their random numbers), never on noise alone
  const mark = verdictMark(marks.verdict);
  const posLabel = marks.verdict > 0 ? 'PLACES GAINED' : marks.verdict < 0 ? 'PLACES LOST' : 'NO CLEAR CHANGE';
  const posHalf = pairedHalfWidth(paired?.position);
  const share = (k) => {
    const m = paired?.[k]?.mean;
    return Number.isFinite(m) ? 100 * m : delta[k];
  };
  const pct = (v) => {
    const r = Math.round(v);
    return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}%`;
  };
  const rows = [['Podium', 'podium'], ['Points', 'points']]
    .filter(([, k]) => paired || delta[k] !== 0);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '4px 8px', flexShrink: 0,
      background: withAlpha(TEXT_COLORS.primary, 0.03), borderRadius: 'var(--radius-sm)',
    }}>
      <div
        style={{ textAlign: 'center' }}
        title={'Expected finishing position of the baseline minus that of the custom strategy (positive = the custom strategy finishes higher), '
          + 'the mean of the run-by-run differences. Gained or lost only when its Monte Carlo interval (±) excludes 0; '
          + 'inside it, NO CLEAR CHANGE (or the previous verdict of this plan while the difference stays on its side).'}
      >
        <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 900, color: mark.color }}>
          {mark.glyph} {signedPlaces(shownDifference(delta, paired))}
        </div>
        {posHalf != null && (
          <div style={{ fontSize: CHART_FONT.label, ...muted }}>
            {'±'}{posHalf.toFixed(2)}
          </div>
        )}
        <div style={{ fontSize: CHART_FONT.label, fontWeight: 700, color: mark.color, textTransform: 'uppercase' }}>
          {posLabel}
        </div>
      </div>
      <div
        style={{ flex: 1, fontSize: CHART_FONT.data, ...muted, lineHeight: 1.5 }}
        title="Change of the podium / points probability (custom minus baseline), coloured (with its arrow) only when beyond the Monte Carlo error"
      >
        {rows.map(([label, k]) => {
          const m = verdictMark(marks[k]);
          return (
            <div key={k}>
              {label}: <span style={{ color: m.color, fontWeight: 700 }}>{marks[k] ? `${m.glyph} ` : ''}{pct(share(k))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
