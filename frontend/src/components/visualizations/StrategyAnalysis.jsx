import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  driverStyle, tyreColor, tyreLetter, contrastText, withAlpha, deltaColor, CHART_FONT, chartFontPx,
  TEXT_COLORS, GRID_COLORS, UI_COLORS, DIVERGING,
} from '../../utils/colors';
import { generateInsights } from '../../utils/insightsGenerator';
import {
  listedBattles, modePosition, positionChange, projectionRisks,
} from '../../utils/simulationClient';
import { drawStintStrips } from '../../utils/views/stintStripChart';
import { drawEffectBars, effectRow } from '../../utils/views/effectBarsChart';
import { useBoxSize, fitRows, pageOf } from '../../utils/views/chartBox';
import {
  SEVERITY, severityOf, levelMark, placesMark, chipStyle, CHART_COLORS, UP, DOWN, MINUS,
} from '../../utils/views/strategyMarks';
import Panel from '../ui/Panel';

/* ── Shared tab pill style helper ── */
const tabPillStyle = (active) => ({
  padding: '3px 8px', fontSize: CHART_FONT.label, fontWeight: 700,
  borderRadius: 4, border: `1px solid ${active ? TEXT_COLORS.secondary : 'transparent'}`, cursor: 'pointer',
  background: active ? withAlpha(TEXT_COLORS.primary, 0.1) : 'transparent',
  color: active ? TEXT_COLORS.primary : TEXT_COLORS.secondary,
  transition: 'background 0.12s, color 0.12s',
});

// Urgency of a closing battle (laps to close): the severity scheme of
// strategyMarks (colour, word) and the glyph drawn in the badge
const BATTLE_SEVERITY = { imminent: SEVERITY.high, approaching: SEVERITY.medium, developing: SEVERITY.low };
const BATTLE_GLYPH = { imminent: '!', approaching: '▶', developing: '→' };

export default function StrategyAnalysis() {
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const driversInfo = useF1Store((s) => s.drivers);
  const raceProjection = useF1Store((s) => s.raceProjection);
  // Projected overtakes: the battles the Race Prediction panel lists (the
  // store's list and badge levels, Wilson interval + hysteresis)
  const mcBattles = useMemo(() => listedBattles(raceProjection), [raceProjection]);
  // Risk rows: the store's (judged beyond the Monte Carlo error, chained)
  const mcRisks = useMemo(() => projectionRisks(raceProjection), [raceProjection]);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const setComparisonDriver = useF1Store((s) => s.setComparisonDriver);

  // Fire-and-forget helper: when an insight names a driver pair (behind, ahead)
  // route it to every cross-panel hook — selection, focus, and the shared
  // comparison driver used by Sector Delta Waterfall + Undercut Calculator.
  // The car closing up becomes the focus (the one weighing the undercut);
  // the car ahead becomes the comparison/rival.
  const selectPair = (behind, ahead) => {
    setSelectedDrivers([behind, ahead]);
    setFocusDriver(behind);
    setComparisonDriver(ahead);
  };
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const degradationRegression = useF1Store((s) => s.degradationRegression);
  const pcaStrategyAnalysis = useF1Store((s) => s.pcaStrategyAnalysis);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const focusDriver = useF1Store((s) => s.focusDriver);

  const [mainSection, setMainSection] = useState('insights');
  const [fieldTab, setFieldTab] = useState('overview');
  const [clusterTab, setClusterTab] = useState('summary');

  // Auto-generated insights from all analytical outputs
  const insights = useMemo(() => generateInsights({
    raceProjection, raceSituationData, lstmPredictions,
    degradationRegression, pcaStrategyAnalysis,
    currentLap, maxLap, focusDriver,
  }), [raceProjection, raceSituationData, lstmPredictions,
      degradationRegression, pcaStrategyAnalysis,
      currentLap, maxLap, focusDriver]);

  const driverInfoMap = useMemo(() => {
    const map = {};
    for (const d of driversInfo || []) map[d.Abbreviation] = d;
    return map;
  }, [driversInfo]);

  // ── Helpers ──
  const meanOf = (drivers, allFeatures, key) => {
    const vals = drivers.map((d) => allFeatures[d]?.[key]).filter((v) => v != null && Number.isFinite(v));
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const cohensD = (selDrivers, restDrivers, allFeatures, key) => {
    const selVals = selDrivers.map((d) => allFeatures[d]?.[key]).filter((v) => v != null && Number.isFinite(v));
    const restVals = restDrivers.map((d) => allFeatures[d]?.[key]).filter((v) => v != null && Number.isFinite(v));
    if (selVals.length < 1 || restVals.length < 1) return { d: 0, selMean: 0, restMean: 0, direction: 'same' };
    const selMean = selVals.reduce((a, b) => a + b, 0) / selVals.length;
    const restMean = restVals.reduce((a, b) => a + b, 0) / restVals.length;
    const selVar = selVals.reduce((s, v) => s + (v - selMean) ** 2, 0) / Math.max(1, selVals.length - 1);
    const restVar = restVals.reduce((s, v) => s + (v - restMean) ** 2, 0) / Math.max(1, restVals.length - 1);
    const pooledStd = Math.sqrt((selVar + restVar) / 2);
    const effect = pooledStd > 1e-10 ? Math.abs(selMean - restMean) / pooledStd : 0;
    return { d: effect, selMean, restMean, direction: selMean > restMean ? 'higher' : 'lower' };
  };

  // ── Find all battles in the field (for both overview and selection modes) ──
  const findBattles = (drivers, allFeatures, maxGap = 20, maxLaps = 12) => {
    const battles = [];
    for (let i = 0; i < drivers.length; i++) {
      for (let j = i + 1; j < drivers.length; j++) {
        const a = { abbr: drivers[i], ...allFeatures[drivers[i]] };
        const b = { abbr: drivers[j], ...allFeatures[drivers[j]] };
        const [ahead, behind] = a.position < b.position ? [a, b] : [b, a];
        const gap = Math.abs(behind.gapToLeader - ahead.gapToLeader);
        if (gap <= 0 || gap > maxGap) continue;
        const paceDelta = behind.recentPace - ahead.recentPace;
        if (paceDelta >= 0) continue;
        const lapsToClose = gap / Math.abs(paceDelta);
        if (lapsToClose > maxLaps) continue;
        const type = lapsToClose <= 3 ? 'imminent' : lapsToClose <= 7 ? 'approaching' : 'developing';
        const color = BATTLE_SEVERITY[type].color;
        battles.push({ behind: behind.abbr, ahead: ahead.abbr, gap: gap.toFixed(1),
          paceDelta: paceDelta.toFixed(2), lapsToClose: lapsToClose.toFixed(0), type, color,
          behindCompound: behind.compoundName, aheadCompound: ahead.compoundName });
      }
    }
    battles.sort((a, b) => parseFloat(a.lapsToClose) - parseFloat(b.lapsToClose));
    return battles;
  };

  // ── Field-wide overview (when no drivers are selected) ──
  const fieldOverview = useMemo(() => {
    if (!raceSituationData || selectedDrivers.length > 0) return null;

    const { driverAbbrs, driverFeatures } = raceSituationData;
    const all = driverAbbrs.filter((d) => driverFeatures[d]);
    if (all.length < 3) return null;

    // Key battles across the entire field
    const battles = findBattles(all, driverFeatures, 15, 10);

    // Imminent pit stops
    const pitSoon = all
      .filter((d) => driverFeatures[d].estLapsToPit <= 4)
      .map((d) => ({ abbr: d, laps: driverFeatures[d].estLapsToPit, compound: driverFeatures[d].compoundName }))
      .sort((a, b) => a.laps - b.laps);

    // Drivers losing pace rapidly
    const degrading = all
      .filter((d) => driverFeatures[d].paceTrend > 0.12)
      .map((d) => ({ abbr: d, trend: driverFeatures[d].paceTrend, compound: driverFeatures[d].compoundName, tyreLife: driverFeatures[d].tyreLife }))
      .sort((a, b) => b.trend - a.trend);

    // Drivers gaining positions
    const gainers = all
      .filter((d) => driverFeatures[d].positionTrend >= 2)
      .map((d) => ({ abbr: d, gained: driverFeatures[d].positionTrend, pace: driverFeatures[d].recentPace }))
      .sort((a, b) => b.gained - a.gained);

    // Compound distribution
    const compoundCounts = {};
    all.forEach((d) => {
      const c = driverFeatures[d].compoundName || 'UNKNOWN';
      compoundCounts[c] = (compoundCounts[c] || 0) + 1;
    });

    return { battles: battles.slice(0, 8), pitSoon, degrading: degrading.slice(0, 4), gainers: gainers.slice(0, 4), compoundCounts, totalDrivers: all.length };
  }, [raceSituationData, selectedDrivers]);

  // ── Cluster analysis (selected drivers) ──
  const liveAnalysis = useMemo(() => {
    if (!raceSituationData || selectedDrivers.length === 0) return null;

    const allFeatures = raceSituationData.driverFeatures;
    const allAbbrs = raceSituationData.driverAbbrs;
    const selected = selectedDrivers.filter((d) => allFeatures[d]);
    if (selected.length === 0) return null;

    const rest = allAbbrs.filter((d) => !selected.includes(d) && allFeatures[d]);

    const compounds = selected.map((d) => allFeatures[d].compoundName);
    const uniqueCompounds = [...new Set(compounds)];
    const avgTyreLife = meanOf(selected, allFeatures, 'tyreLife');
    const avgPace = meanOf(selected, allFeatures, 'recentPace');
    const avgPosition = meanOf(selected, allFeatures, 'position');

    const summaryParts = [];
    summaryParts.push(`${selected.length} driver${selected.length > 1 ? 's' : ''} selected`);
    if (uniqueCompounds.length === 1) {
      summaryParts.push(`All on ${uniqueCompounds[0]} tyres (avg age: ${avgTyreLife.toFixed(0)} laps)`);
    } else {
      summaryParts.push(`Mixed compounds: ${uniqueCompounds.join(', ')} (avg age: ${avgTyreLife.toFixed(0)} laps)`);
    }
    summaryParts.push(`Avg pace: ${avgPace.toFixed(1)}s`);

    const clusterLabel = uniqueCompounds.length === 1
      ? `${uniqueCompounds[0]} runners \u2014 similar situation`
      : avgPosition <= 5 ? 'Front-runners cluster'
        : avgPosition >= 15 ? 'Backfield cluster' : 'Midfield cluster';

    const FEATURE_KEYS = ['position', 'gapToLeader', 'recentPace', 'paceTrend',
      'tyreLife', 'stintNumber', 'predictedPace5', 'estLapsToPit', 'positionTrend'];
    const FEATURE_DISPLAY = {
      position: { label: 'Position', unit: '', lowerBetter: true },
      gapToLeader: { label: 'Gap to Leader', unit: 's', lowerBetter: true },
      recentPace: { label: 'Recent Pace', unit: 's', lowerBetter: true },
      paceTrend: { label: 'Pace Trend', unit: 's/lap', lowerBetter: true },
      tyreLife: { label: 'Tyre Age', unit: 'laps', lowerBetter: null },
      stintNumber: { label: 'Stint #', unit: '', lowerBetter: null },
      predictedPace5: { label: 'Predicted Pace +5', unit: 's', lowerBetter: true },
      estLapsToPit: { label: 'Est. to Pit', unit: 'laps', lowerBetter: null },
      positionTrend: { label: 'Pos. Gained', unit: '', lowerBetter: false },
    };

    const featureBars = [];
    for (const key of FEATURE_KEYS) {
      if (rest.length === 0) break;
      const { d, selMean, restMean, direction } = cohensD(selected, rest, allFeatures, key);
      if (d < 0.2) continue;
      const meta = FEATURE_DISPLAY[key];
      const magnitude = d < 0.5 ? 'small' : d < 0.8 ? 'medium' : 'large';
      featureBars.push({ key, ...meta, effectSize: d, selMean, restMean, direction, magnitude });
    }
    featureBars.sort((a, b) => b.effectSize - a.effectSize);

    const insights = [];
    const pitWindows = selected.map((d) => allFeatures[d].estLapsToPit);
    const minPit = Math.min(...pitWindows);
    const maxPit = Math.max(...pitWindows);
    if (selected.length >= 2 && maxPit - minPit <= 5 && maxPit <= 10) {
      insights.push({ type: 'pit-traffic', icon: SEVERITY.medium.glyph, color: SEVERITY.medium.color,
        text: `${selected.length} drivers have similar pit windows (${minPit}\u2013${maxPit} laps). Expect pit traffic.` });
    } else if (selected.length >= 2 && minPit <= 3) {
      const soonDrivers = selected.filter((d) => allFeatures[d].estLapsToPit <= 3);
      insights.push({ type: 'imminent-pit', icon: SEVERITY.high.glyph, color: SEVERITY.high.color,
        text: `${soonDrivers.join(', ')} likely pitting in 1\u20133 laps.` });
    }
    const degradingDrivers = selected.filter((d) => allFeatures[d].paceTrend > 0.1);
    if (degradingDrivers.length > 0 && degradingDrivers.length < selected.length) {
      insights.push({ type: 'degradation', icon: UP, color: SEVERITY.high.color,
        text: `${degradingDrivers.join(', ')} losing pace rapidly \u2014 may pit earlier than expected.` });
    }
    if (uniqueCompounds.length === 1 && selected.length >= 2) {
      const ages = selected.map((d) => ({ abbr: d, age: allFeatures[d].tyreLife })).sort((a, b) => a.age - b.age);
      const ageDiff = ages[ages.length - 1].age - ages[0].age;
      if (ageDiff >= 8) {
        insights.push({ type: 'tyre-age-gap', icon: '\u0394', color: SEVERITY.low.color,
          text: `${ages[ages.length - 1].abbr} has ${ageDiff} laps older tyres than ${ages[0].abbr} \u2014 undercut advantage.` });
      }
    }

    // Battles among selected + between selected and nearby drivers
    const threats = findBattles(selected, allFeatures, 30, 15);
    for (const sel of selected) {
      for (const r of rest) {
        const a = { abbr: sel, ...allFeatures[sel] };
        const b = { abbr: r, ...allFeatures[r] };
        if (Math.abs(a.position - b.position) > 3) continue;
        const [ahead, behind] = a.position < b.position ? [a, b] : [b, a];
        const gap = Math.abs(behind.gapToLeader - ahead.gapToLeader);
        if (gap <= 0 || gap > 15) continue;
        const paceDelta = behind.recentPace - ahead.recentPace;
        if (paceDelta >= 0) continue;
        const lapsToClose = gap / Math.abs(paceDelta);
        if (lapsToClose > 10) continue;
        const isSelectedAhead = selected.includes(ahead.abbr);
        const type = lapsToClose <= 3 ? 'imminent' : lapsToClose <= 7 ? 'approaching' : 'developing';
        const color = BATTLE_SEVERITY[type].color;
        threats.push({ behind: behind.abbr, ahead: ahead.abbr, gap: gap.toFixed(1),
          paceDelta: paceDelta.toFixed(2), lapsToClose: lapsToClose.toFixed(0), type, color,
          behindCompound: behind.compoundName, aheadCompound: ahead.compoundName,
          isExternal: true, isThreat: !isSelectedAhead });
      }
    }
    threats.sort((a, b) => parseFloat(a.lapsToClose) - parseFloat(b.lapsToClose));

    const drivers = selected.map((abbr) => ({
      abbr, team: driverInfoMap[abbr]?.TeamName || 'Unknown', ...allFeatures[abbr],
    })).sort((a, b) => a.position - b.position);

    return { clusterLabel, summary: summaryParts.join('. ') + '.', featureBars, insights, threats: threats.slice(0, 6), drivers };
  }, [raceSituationData, selectedDrivers, driverInfoMap]);

  // ── Shared battle row (CLICKABLE: selects both drivers + syncs Sector Delta / Undercut) ──
  // The urgency badge: its glyph (! imminent, ▶ approaching, → developing)
  // on the severity colour; threat / opportunity with ▼ / ▲ and the word
  const battleRow = (t) => {
    const sev = BATTLE_SEVERITY[t.type];
    const side = t.isThreat ? placesMark(-1) : placesMark(1);
    return (
      <div
        onClick={() => selectPair(t.behind, t.ahead)}
        className="sa-battle"
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, height: '100%', boxSizing: 'border-box',
          fontSize: CHART_FONT.data, lineHeight: 1.4,
          cursor: 'pointer', padding: '2px 6px', borderRadius: 'var(--radius-sm)',
          transition: 'background 0.12s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = HOVER_BG; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        title={`Click to select both drivers. Urgency: ${t.type} (${sev.word})`}
      >
        <span style={{
          flexShrink: 0, width: 18, height: 18, borderRadius: '50%',
          backgroundColor: sev.color, color: contrastText(sev.color), fontWeight: 900,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: CHART_FONT.label,
        }} aria-label={t.type}>
          {BATTLE_GLYPH[t.type]}
        </span>
        <div style={{ minWidth: 0 }}>
          <strong style={{ color: driverStyle(t.behind).text }}>{t.behind}</strong>
          <span style={muted}> ({t.behindCompound})</span>
          {' '}closing on{' '}
          <strong style={{ color: driverStyle(t.ahead).text }}>{t.ahead}</strong>
          <span style={muted}> ({t.aheadCompound})</span>
          {t.isExternal && (
            <span style={{
              marginLeft: 6, fontSize: CHART_FONT.label, padding: '0 4px', borderRadius: 3, fontWeight: 700,
              border: `1px solid ${side.color}`, color: side.color,
            }}>
              {side.glyph} {t.isThreat ? 'THREAT' : 'OPPORTUNITY'}
            </span>
          )}
          <br />
          <span style={muted}>
            Gap: {t.gap}s | Delta: {t.paceDelta}s/lap | ~{t.lapsToClose} laps
          </span>
        </div>
      </div>
    );
  };

  // The battle lists: rows of two text lines
  const battleRowH = 2 * LINE_PX() + 6;
  const overtakeRowH = LINE_PX() + 8;

  /* ── Build field-mode tab definitions ── */
  const fieldTabs = useMemo(() => {
    if (!fieldOverview) return [];
    const tabs = [{ id: 'overview', label: 'Overview' }];
    if (fieldOverview.battles.length > 0)
      tabs.push({ id: 'battles', label: `Battles (${fieldOverview.battles.length})` });
    if (mcBattles.length > 0)
      tabs.push({ id: 'overtakes', label: `Overtakes (${Math.min(8, mcBattles.length)})` });
    if (fieldOverview.pitSoon.length > 0 || fieldOverview.degrading.length > 0 || fieldOverview.gainers.length > 0 || mcRisks.length > 0)
      tabs.push({ id: 'alerts', label: 'Alerts' });
    return tabs;
  }, [fieldOverview, mcBattles, mcRisks]);
  const shownFieldTab = fieldTabs.some((t) => t.id === fieldTab) ? fieldTab : 'overview';

  /* ── Build cluster-mode tab definitions ── */
  const clusterTabs = useMemo(() => {
    if (!liveAnalysis) return [];
    const tabs = [{ id: 'summary', label: 'Summary' }];
    if (liveAnalysis.threats.length > 0)
      tabs.push({ id: 'threats', label: `Threats (${liveAnalysis.threats.length})` });
    if (liveAnalysis.insights.length > 0 || liveAnalysis.featureBars.length > 0)
      tabs.push({ id: 'insights', label: 'Insights' });
    if (liveAnalysis.drivers.length > 0)
      tabs.push({ id: 'drivers', label: `Drivers (${liveAnalysis.drivers.length})` });
    return tabs;
  }, [liveAnalysis]);
  const shownClusterTab = clusterTabs.some((t) => t.id === clusterTab) ? clusterTab : 'summary';

  const tabBar = (tabs, active, onPick) => (
    <div style={{
      display: 'flex', gap: 4, padding: '4px 8px', flexShrink: 0, flexWrap: 'wrap',
      borderBottom: `1px solid ${GRID_COLORS.grid}`,
    }}>
      {tabs.map((s) => (
        <button key={s.id} type="button" onClick={() => onPick(s.id)} style={{ ...tabPillStyle(active === s.id), fontVariantNumeric: 'tabular-nums' }}>
          {s.label}
        </button>
      ))}
    </div>
  );

  return (
    <Panel title="Race Analysis">
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* ── Top-level section toggle ── */}
        {tabBar([
          { id: 'insights', label: `Insights${insights.length > 0 ? ` (${insights.length})` : ''}` },
          { id: 'analysis', label: 'Analysis' },
        ], mainSection, setMainSection)}

        {/* ══════════ INSIGHTS TAB ══════════ */}
        {mainSection === 'insights' && (
          <InsightsList
            insights={insights}
            onFocusPair={selectPair}
            onFocusOne={setFocusDriver}
          />
        )}

        {/* ══════════ ANALYSIS TAB ══════════ */}
        {mainSection === 'analysis' && (
          <>

        {/* ══════════ FIELD OVERVIEW (no selection) ══════════ */}

        {fieldOverview && (
          <>
            {fieldTabs.length > 1 && tabBar(fieldTabs, shownFieldTab, setFieldTab)}

            {/* Tab content — takes all remaining space; lists are paged, never scrolled */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 'var(--spacing-sm)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>

              {shownFieldTab === 'overview' && (
                <>
                  {/* The field's tyre mix: a D3 strip of cars per compound, letters and counts on it */}
                  <div style={card}>
                    <h6 style={sectionTitle}>Field Tyre Distribution</h6>
                    <TyreMix counts={fieldOverview.compoundCounts} total={fieldOverview.totalDrivers} />
                  </div>
                  <div style={{ fontSize: CHART_FONT.data, ...muted, textAlign: 'center', padding: '4px 0' }}>
                    Select drivers on the map or leaderboard for detailed cluster analysis
                  </div>
                </>
              )}

              {shownFieldTab === 'battles' && (
                <div style={{ ...card, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <h6 style={sectionTitle}>Key Battles</h6>
                  <PagedList
                    items={fieldOverview.battles.slice(0, 8)}
                    rowH={battleRowH}
                    what="battles"
                    renderItem={(t) => battleRow(t)}
                  />
                </div>
              )}

              {shownFieldTab === 'overtakes' && (
                <div style={{ ...card, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <h6 style={sectionTitle}>Projected Overtakes (Monte Carlo)</h6>
                  <PagedList
                    items={mcBattles.slice(0, 8)}
                    rowH={overtakeRowH}
                    what="pairs"
                    renderItem={(b) => {
                      // the Race Prediction battle badges (store badge rule): glyph and colour
                      const lv = levelMark(b.level);
                      return (
                        <div
                          onClick={() => selectPair(b.behind, b.ahead)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, height: '100%',
                            fontSize: CHART_FONT.data, cursor: 'pointer', padding: '0 4px',
                            borderRadius: 'var(--radius-sm)', transition: 'background 0.12s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = HOVER_BG; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span title={lv.word} style={{ fontWeight: 800, color: lv.color, minWidth: 54, fontVariantNumeric: 'tabular-nums' }}>
                            {lv.glyph} {b.prob}%
                          </span>
                          <strong style={{ color: driverStyle(b.behind).text }}>{b.behind}</strong>
                          <span style={muted}>passes</span>
                          <strong style={{ color: driverStyle(b.ahead).text }}>{b.ahead}</strong>
                        </div>
                      );
                    }}
                  />
                </div>
              )}

              {shownFieldTab === 'alerts' && (
                <>
                  {/* Pit stop alerts: severity glyph, laps, compound letter */}
                  {fieldOverview.pitSoon.length > 0 && (
                    <div style={card}>
                      <h6 style={sectionTitle}>Pit Window Open</h6>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {fieldOverview.pitSoon.map((d) => {
                          const sev = d.laps <= 2 ? SEVERITY.high : SEVERITY.medium;
                          return (
                            <span key={d.abbr}
                              onClick={() => setFocusDriver(d.abbr)}
                              title={`${d.abbr}: pit window in about ${d.laps} laps (${sev.word})`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '2px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                background: withAlpha(sev.color, 0.1),
                                borderLeft: `2px solid ${sev.color}`,
                                fontSize: CHART_FONT.data,
                              }}>
                              <span style={{ color: sev.color, fontWeight: 900 }}>{sev.glyph}</span>
                              <strong style={{ color: driverStyle(d.abbr).text }}>{d.abbr}</strong>
                              <span style={muted}>~{d.laps}L</span>
                              <TyreLetter compound={d.compound} />
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Degradation alerts: + s/lap slower, in the "worse" colour with its sign */}
                  {fieldOverview.degrading.length > 0 && (
                    <div style={card}>
                      <h6 style={sectionTitle}>Losing Pace</h6>
                      {fieldOverview.degrading.map((d) => (
                        <div key={d.abbr} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, fontSize: CHART_FONT.data }}>
                          <strong style={{ color: driverStyle(d.abbr).text, minWidth: 28 }}>{d.abbr}</strong>
                          <span style={{ color: DIVERGING.worse, fontWeight: 700 }}>{UP} +{d.trend.toFixed(2)}s/lap</span>
                          <span style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <TyreLetter compound={d.compound} />
                            {d.compound} L{d.tyreLife}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Drivers gaining: places gained in the "better" colour with ▲ */}
                  {fieldOverview.gainers.length > 0 && (
                    <div style={card}>
                      <h6 style={sectionTitle}>On The Move</h6>
                      {fieldOverview.gainers.map((d) => (
                        <div key={d.abbr} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, fontSize: CHART_FONT.data }}>
                          <strong style={{ color: driverStyle(d.abbr).text, minWidth: 28 }}>{d.abbr}</strong>
                          <span style={{ color: placesMark(d.gained).color, fontWeight: 700 }}>{placesMark(d.gained).glyph} +{d.gained} positions</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Monte Carlo risks: severity glyph and word, paged */}
                  {mcRisks.length > 0 && (
                    <div style={{ ...card, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                      <h6 style={sectionTitle}>Risk Alerts</h6>
                      <PagedList
                        items={mcRisks}
                        rowH={2 * LINE_PX() + 6}
                        what="risks"
                        renderItem={(r) => {
                          const sev = severityOf(r.severity);
                          return (
                            <div
                              onClick={() => setFocusDriver(r.driver)}
                              title={`${r.type} (${sev.word}): ${r.description}`}
                              style={{
                                display: 'flex', alignItems: 'flex-start', gap: 6, height: '100%', overflow: 'hidden',
                                fontSize: CHART_FONT.data, cursor: 'pointer', padding: '2px 4px',
                                borderRadius: 'var(--radius-sm)', transition: 'background 0.12s',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = HOVER_BG; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              <span style={{
                                flexShrink: 0, fontSize: CHART_FONT.label, fontWeight: 800, padding: '0 4px',
                                borderRadius: 3, textTransform: 'uppercase', ...chipStyle(sev.color, 0.15),
                              }}>{sev.glyph} {r.type}</span>
                              <span style={{ color: TEXT_COLORS.secondary, lineHeight: 1.35 }}>{r.description}</span>
                            </div>
                          );
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* ── No data yet ── */}
        {!raceSituationData && !fieldOverview && !liveAnalysis && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: TEXT_COLORS.secondary, lineHeight: 1.8 }}>
              <strong style={{ color: TEXT_COLORS.primary, display: 'block', marginBottom: 8, fontSize: 'var(--font-size-md)' }}>
                Race Situation Analysis
              </strong>
              Waiting for race data to build the situation map...
            </div>
          </div>
        )}

        {/* ══════════ CLUSTER ANALYSIS (selected drivers) ══════════ */}

        {liveAnalysis && selectedDrivers.length > 0 && (
          <>
            {clusterTabs.length > 1 && tabBar(clusterTabs, shownClusterTab, setClusterTab)}

            {/* Tab content */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 'var(--spacing-sm)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>

              {shownClusterTab === 'summary' && (
                <div style={{
                  background: CHART_COLORS.surface,
                  borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)', borderLeft: `3px solid ${TEXT_COLORS.secondary}`,
                }}>
                  <div style={{ fontSize: CHART_FONT.data, fontWeight: 700, color: TEXT_COLORS.primary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                    {liveAnalysis.clusterLabel}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.5, color: TEXT_COLORS.primary }}>
                    {liveAnalysis.summary}
                  </div>
                </div>
              )}

              {shownClusterTab === 'threats' && liveAnalysis.threats.length > 0 && (
                <div style={{ ...card, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <h6 style={sectionTitle}>Threats &amp; Opportunities</h6>
                  <PagedList items={liveAnalysis.threats} rowH={battleRowH} what="pairs" renderItem={(t) => battleRow(t)} />
                </div>
              )}

              {shownClusterTab === 'insights' && (
                <>
                  {liveAnalysis.insights.length > 0 && (
                    <div style={card}>
                      <h6 style={sectionTitle}>Strategic Insights</h6>
                      {liveAnalysis.insights.map((ins, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4, fontSize: CHART_FONT.data, lineHeight: 1.4 }}>
                          <span style={{
                            flexShrink: 0, width: 16, height: 16, borderRadius: 3,
                            backgroundColor: ins.color, color: contrastText(ins.color), fontWeight: 900,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: CHART_FONT.label,
                          }}>
                            {ins.icon}
                          </span>
                          <span style={{ color: TEXT_COLORS.primary }}>{ins.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {liveAnalysis.featureBars.length > 0 && (
                    <div style={{ ...card, flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column' }}>
                      <h6 style={sectionTitle}>What makes this cluster different</h6>
                      <EffectBars bars={liveAnalysis.featureBars.slice(0, 8)} />
                      <div style={{ fontSize: CHART_FONT.label, ...muted, marginTop: 4 }}>
                        Bar = Cohen&apos;s d effect size of the selected drivers against the rest of the field (+ = higher in the selection)
                      </div>
                    </div>
                  )}
                </>
              )}

              {shownClusterTab === 'drivers' && (
                <PagedList
                  items={liveAnalysis.drivers}
                  rowH={2 * LINE_PX() + 14}
                  what="drivers"
                  renderItem={(d) => {
                    const trendStr = d.paceTrend > 0.05 ? `+${d.paceTrend.toFixed(2)}s/lap` : d.paceTrend < -0.05 ? `${MINUS}${Math.abs(d.paceTrend).toFixed(2)}s/lap` : 'stable';
                    // pace trend: + = slower each lap (worse), − = faster (better)
                    const trendColor = deltaColor(d.paceTrend, { deadband: 0.05 });
                    const trendGlyph = d.paceTrend > 0.05 ? `${UP} ` : d.paceTrend < -0.05 ? `${DOWN} ` : '';
                    const proj = raceProjection?.projections.find((p) => p.driver === d.abbr);
                    // Places to gain / lose: current position against the finishing position
                    // shown (the store's median, stable on Monte Carlo noise)
                    const change = proj ? (positionChange(raceProjection, proj) ?? 0) : 0;
                    const style = driverStyle(d.abbr);
                    return (
                      <div
                        onClick={() => setFocusDriver(d.abbr)}
                        style={{
                          background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', height: 'calc(100% - 4px)', boxSizing: 'border-box',
                          padding: '3px 10px', borderLeft: `3px solid ${style.mark}`, overflow: 'hidden',
                          cursor: 'pointer', transition: 'background 0.12s',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = HOVER_BG; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)'; }}
                        title={`Click to focus ${d.abbr}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: CHART_FONT.data }}>
                          <strong style={{ color: style.text }}>{d.abbr}</strong>
                          <span style={muted}>{d.team}</span>
                          <span style={{ marginLeft: 'auto', fontWeight: 700, color: TEXT_COLORS.primary }}>
                            P{d.position}
                            {proj && change !== 0 && (
                              <span style={{ marginLeft: 4, color: placesMark(change).color }}>
                                {placesMark(change).glyph} P{modePosition(raceProjection, proj)}
                                <span style={{ fontSize: CHART_FONT.label, marginLeft: 2 }}>({proj.podiumProb}% pod)</span>
                              </span>
                            )}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 10, fontSize: CHART_FONT.data, ...muted, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <TyreLetter compound={d.compoundName} />
                            {d.compoundName} L{d.tyreLife}
                          </span>
                          <span>Pace: {d.recentPace?.toFixed(1)}s</span>
                          <span style={{ color: trendColor }}>Trend: {trendGlyph}{trendStr}</span>
                          <span>Pit ~{d.estLapsToPit}L</span>
                          {d.positionTrend !== 0 && (
                            <span style={{ color: placesMark(d.positionTrend).color }}>
                              {placesMark(d.positionTrend).glyph} {d.positionTrend > 0 ? '+' : MINUS}{Math.abs(d.positionTrend)} pos
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
              )}
            </div>
          </>
        )}

          </>
        )}
      </div>
    </Panel>
  );
}

// ── Styles (palette of utils/colors.js, CSS font tokens) ─────────────
const muted = { color: TEXT_COLORS.secondary };
const HOVER_BG = withAlpha(TEXT_COLORS.primary, 0.06);
const card = {
  background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)', flexShrink: 0,
};
const sectionTitle = {
  color: TEXT_COLORS.secondary, margin: '0 0 4px', fontSize: CHART_FONT.data, textTransform: 'uppercase', fontWeight: 700, flexShrink: 0,
};
// Height of one text line at the data size, px
const LINE_PX = () => Math.ceil(chartFontPx('data') * 1.4);
const PAGER_H = 22;

/** The compound letter on its FIA colour (black or white by contrast). */
function TyreLetter({ compound }) {
  const fill = tyreColor(compound);
  return (
    <span title={compound} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 14, height: 14, padding: '0 2px', borderRadius: 7, background: fill, color: contrastText(fill),
      fontSize: CHART_FONT.label, fontWeight: 800, lineHeight: 1,
    }}>
      {tyreLetter(compound)}
    </span>
  );
}

/**
 * Rows of one height fitted to the space left (chartBox.fitRows), paged
 * when they do not fit: no scroll.
 */
function PagedList({ items, rowH, what, renderItem }) {
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
  const [page, setPage] = useState(0);
  const fit = fitRows(box.height, items.length, { rowMin: rowH, rowMax: rowH, rowDefault: rowH, pagerH: PAGER_H });
  const pg = pageOf(items, page, fit.perPage);
  const btn = {
    fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, background: 'transparent',
    border: `1px solid ${GRID_COLORS.rule}`, borderRadius: 3, padding: '0 6px', cursor: 'pointer',
  };
  return (
    <div ref={boxRef} className="sa-list" style={{ flex: 1, minHeight: rowH, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {pg.rows.map((item, i) => (
        <div key={`${pg.page}-${i}`} className="sa-list-row" style={{ height: fit.rowH, flexShrink: 0, overflow: 'hidden' }}>
          {renderItem(item)}
        </div>
      ))}
      {fit.paged && (
        <div className="sa-pager" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: PAGER_H, flexShrink: 0,
          fontSize: CHART_FONT.label, ...muted, marginTop: 'auto',
        }}
        >
          <button type="button" aria-label={`Previous ${what}`} disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)} style={btn}>{'◀'}</button>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{what} {pg.first}{'–'}{pg.last} of {items.length}</span>
          <button type="button" aria-label={`Next ${what}`} disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)} style={btn}>{'▶'}</button>
        </div>
      )}
    </div>
  );
}

/** The field's tyre mix as a D3 strip (utils/views/stintStripChart.js): cars per compound, letter and count on each. */
function TyreMix({ counts, total }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const box = useBoxSize(boxRef);
  useEffect(() => {
    if (!svgRef.current) return;
    let at = 0;
    const segments = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([compound, count]) => {
      const seg = {
        key: compound, start: at, length: count, compound, title: `${compound}: ${count} of ${total} cars`,
      };
      at += count;
      return seg;
    });
    const ticks = [0, Math.round(total / 2), total].filter((v, i, a) => a.indexOf(v) === i);
    drawStintStrips(svgRef.current, {
      rows: [{ key: 'field', label: 'Field', segments }],
      domain: [0, Math.max(1, total)],
      width: box.width > 0 ? box.width : 240,
      rowH: Math.max(20, Math.round(chartFontPx('data') * 1.9)),
      axis: { ticks, format: (v) => `${v} cars`, at: (v) => v },
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
    });
  });
  return (
    <div ref={boxRef} style={{ minWidth: 0 }}>
      <svg ref={svgRef} className="sa-tyre-mix" style={{ display: 'block', maxWidth: '100%' }} />
    </div>
  );
}

/** "What makes this cluster different": the D3 effect bars (utils/views/effectBarsChart.js). */
function EffectBars({ bars }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const box = useBoxSize(boxRef);
  useEffect(() => {
    if (!svgRef.current || box.width <= 0 || box.height <= 0) return;
    drawEffectBars(svgRef.current, {
      rows: bars.map(effectRow),
      width: box.width,
      height: box.height,
      colors: {
        better: DIVERGING.better,
        worse: DIVERGING.worse,
        neutral: DIVERGING.neutral,
        text: TEXT_COLORS.primary,
        muted: TEXT_COLORS.muted,
        grid: GRID_COLORS.grid,
        axis: GRID_COLORS.axis,
        rule: GRID_COLORS.rule,
      },
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
      legendFont: CHART_FONT.data,
      legendFontPx: chartFontPx('data'),
    });
  });
  return (
    <div ref={boxRef} className="sa-effects" style={{ flex: 1, minHeight: 80, overflow: 'hidden' }}>
      <svg ref={svgRef} className="sa-effects-svg" style={{ display: 'block' }} />
    </div>
  );
}

/* ── InsightsList component ── */
function InsightsList({ insights, onFocusPair, onFocusOne }) {
  const categoryIcon = {
    battle: '⚔',
    risk: '⚠',
    opportunity: '↑',
    pattern: '◉',
    forecast: '→',
    degradation: '▾',
  };

  if (insights.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: CHART_FONT.data, ...muted, marginBottom: 6 }}>
            No insights yet
          </div>
          <div style={{ fontSize: CHART_FONT.label, ...muted, lineHeight: 1.5 }}>
            Insights appear as the race progresses and you interact with the PCA biplot,
            telemetry brush, or driver selection.
          </div>
        </div>
      </div>
    );
  }

  // A card: up to three lines of text, the action, the category line
  const rowH = 5 * LINE_PX() + 14;
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 6 }}>
      <PagedList
        items={insights}
        rowH={rowH}
        what="insights"
        renderItem={(ins) => {
          // severity: colour, glyph and word (strategyMarks.severityOf)
          const sev = severityOf(ins.severity);
          return (
            <div
              className="sa-insight"
              style={{
                padding: '4px 10px', height: 'calc(100% - 4px)', boxSizing: 'border-box', overflow: 'hidden',
                background: withAlpha(TEXT_COLORS.primary, 0.03),
                borderLeft: `3px solid ${sev.color}`,
                borderRadius: 4,
                fontSize: CHART_FONT.data,
                lineHeight: 1.4,
                cursor: ins.actions?.[0] ? 'pointer' : 'default',
                transition: 'background 0.12s',
              }}
              title={ins.text}
              onMouseEnter={(e) => { e.currentTarget.style.background = HOVER_BG; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = withAlpha(TEXT_COLORS.primary, 0.03); }}
              onClick={() => {
                const action = ins.actions?.[0];
                if (!action) return;
                const ds = action.drivers;
                if (Array.isArray(ds) && ds.length >= 2) {
                  // Two-driver insight → syncs focus + comparison with Sector Delta / Undercut.
                  // Convention: ds[0] = car behind / the one acting, ds[1] = target.
                  onFocusPair(ds[0], ds[1]);
                } else if (Array.isArray(ds) && ds.length === 1) {
                  onFocusOne(ds[0]);
                }
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <span style={{ color: sev.color, fontWeight: 700 }} aria-label={ins.category}>
                  {categoryIcon[ins.category] || '•'}
                </span>
                <div style={{
                  flex: 1, color: TEXT_COLORS.primary, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {ins.text}
                </div>
              </div>
              {ins.actions?.[0] && (
                <div style={{ marginTop: 2, fontSize: CHART_FONT.label, color: UI_COLORS.brush, fontWeight: 600 }}>
                  → {ins.actions[0].label}
                </div>
              )}
              <div style={{
                marginTop: 2, display: 'flex', justifyContent: 'space-between',
                fontSize: CHART_FONT.label, ...muted,
              }}>
                <span>
                  <span style={{ color: sev.color, fontWeight: 800 }}>{sev.glyph}</span> {ins.category} · {sev.word}
                </span>
                <span>conf. {Math.round(ins.confidence * 100)}%</span>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
