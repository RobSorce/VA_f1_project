import React, { useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { TYRE_COLORS, getDriverColor } from '../../utils/colors';
import Panel from '../ui/Panel';
import StrategyBriefing from './StrategyBriefing';

export default function StrategyAnalysis() {
  const tsneStrategyAnalysis = useF1Store((s) => s.tsneStrategyAnalysis);
  const selectedTSNEPoints = useF1Store((s) => s.selectedTSNEPoints);
  const projectionMode = useF1Store((s) => s.projectionMode);
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const driversInfo = useF1Store((s) => s.drivers);
  const raceProjection = useF1Store((s) => s.raceProjection);

  // ── Compute rich live analysis (selected drivers only) ──
  const liveAnalysis = useMemo(() => {
    if (projectionMode !== 'live' || !raceSituationData || selectedDrivers.length === 0) return null;

    const allFeatures = raceSituationData.driverFeatures;
    const allAbbrs = raceSituationData.driverAbbrs;
    const selected = selectedDrivers.filter((d) => allFeatures[d]);
    if (selected.length === 0) return null;

    const rest = allAbbrs.filter((d) => !selected.includes(d) && allFeatures[d]);

    const driverInfoMap = {};
    for (const d of driversInfo || []) driverInfoMap[d.Abbreviation] = d;

    const meanOf = (drivers, key) => {
      const vals = drivers.map((d) => allFeatures[d]?.[key]).filter((v) => v != null && Number.isFinite(v));
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };

    const cohensD = (selDrivers, restDrivers, key) => {
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

    const compounds = selected.map((d) => allFeatures[d].compoundName);
    const uniqueCompounds = [...new Set(compounds)];
    const avgTyreLife = meanOf(selected, 'tyreLife');
    const avgPace = meanOf(selected, 'recentPace');
    const avgPosition = meanOf(selected, 'position');

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
      const { d, selMean, restMean, direction } = cohensD(selected, rest, key);
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
      insights.push({ type: 'pit-traffic', icon: '!', color: '#ffd700',
        text: `${selected.length} drivers have similar pit windows (${minPit}\u2013${maxPit} laps). Expect pit traffic.` });
    } else if (selected.length >= 2 && minPit <= 3) {
      const soonDrivers = selected.filter((d) => allFeatures[d].estLapsToPit <= 3);
      insights.push({ type: 'imminent-pit', icon: '!', color: '#e10600',
        text: `${soonDrivers.join(', ')} likely pitting in 1\u20133 laps.` });
    }
    const degradingDrivers = selected.filter((d) => allFeatures[d].paceTrend > 0.1);
    if (degradingDrivers.length > 0 && degradingDrivers.length < selected.length) {
      insights.push({ type: 'degradation', icon: '\u25B2', color: '#e10600',
        text: `${degradingDrivers.join(', ')} losing pace rapidly \u2014 may pit earlier than expected.` });
    }
    if (uniqueCompounds.length === 1 && selected.length >= 2) {
      const ages = selected.map((d) => ({ abbr: d, age: allFeatures[d].tyreLife })).sort((a, b) => a.age - b.age);
      const ageDiff = ages[ages.length - 1].age - ages[0].age;
      if (ageDiff >= 8) {
        insights.push({ type: 'tyre-age-gap', icon: '\u0394', color: '#64C4FF',
          text: `${ages[ages.length - 1].abbr} has ${ageDiff} laps older tyres than ${ages[0].abbr} \u2014 undercut advantage.` });
      }
    }

    const threats = [];
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const a = { abbr: selected[i], ...allFeatures[selected[i]] };
        const b = { abbr: selected[j], ...allFeatures[selected[j]] };
        const [ahead, behind] = a.position < b.position ? [a, b] : [b, a];
        const gap = Math.abs(behind.gapToLeader - ahead.gapToLeader);
        if (gap <= 0 || gap > 30) continue;
        const paceDelta = behind.recentPace - ahead.recentPace;
        if (paceDelta >= 0) continue;
        const lapsToClose = gap / Math.abs(paceDelta);
        if (lapsToClose > 15) continue;
        const type = lapsToClose <= 3 ? 'imminent' : lapsToClose <= 7 ? 'approaching' : 'developing';
        const color = type === 'imminent' ? '#e10600' : type === 'approaching' ? '#ffd700' : '#64C4FF';
        threats.push({ behind: behind.abbr, ahead: ahead.abbr, gap: gap.toFixed(1),
          paceDelta: paceDelta.toFixed(2), lapsToClose: lapsToClose.toFixed(0), type, color,
          behindCompound: behind.compoundName, aheadCompound: ahead.compoundName });
      }
    }
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
        const color = type === 'imminent' ? '#e10600' : type === 'approaching' ? '#ffd700' : '#64C4FF';
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
  }, [projectionMode, raceSituationData, selectedDrivers, driversInfo]);

  const isLiveMode = projectionMode === 'live';

  return (
    <Panel title={isLiveMode ? 'Race Analysis' : 'Strategy Analysis'}>
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ══════════ LIVE MODE ══════════ */}

        {/* ── CLUSTER ANALYSIS (selected drivers) ── */}
        {isLiveMode && liveAnalysis && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>

            <div style={{
              background: 'linear-gradient(135deg, rgba(0,230,118,0.08) 0%, rgba(0,230,118,0.02) 100%)',
              borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)', borderLeft: '3px solid #00e676',
            }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: '#00e676', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {liveAnalysis.clusterLabel}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6, color: 'var(--color-text-primary)' }}>
                {liveAnalysis.summary}
              </div>
            </div>

            {liveAnalysis.threats.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Threats & Opportunities
                </h6>
                {liveAnalysis.threats.map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, fontSize: 'var(--font-size-xs)', lineHeight: 1.5 }}>
                    <span style={{
                      flexShrink: 0, width: 18, height: 18, borderRadius: '50%',
                      backgroundColor: t.color, color: '#000', fontWeight: 900,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px',
                    }}>
                      {t.type === 'imminent' ? '!' : t.type === 'approaching' ? '\u25B6' : '\u2192'}
                    </span>
                    <div>
                      <strong style={{ color: getDriverColor(t.behind) }}>{t.behind}</strong>
                      <span style={{ color: 'var(--color-text-muted)' }}> ({t.behindCompound})</span>
                      {' '}closing on{' '}
                      <strong style={{ color: getDriverColor(t.ahead) }}>{t.ahead}</strong>
                      <span style={{ color: 'var(--color-text-muted)' }}> ({t.aheadCompound})</span>
                      <br />
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        Gap: {t.gap}s | Delta: {t.paceDelta}s/lap | ~{t.lapsToClose} laps
                      </span>
                      {t.isExternal && (
                        <span style={{
                          marginLeft: 6, fontSize: '8px', padding: '1px 4px', borderRadius: 3,
                          backgroundColor: 'rgba(255,255,255,0.08)',
                          color: t.isThreat ? '#e10600' : '#00e676',
                        }}>
                          {t.isThreat ? 'THREAT' : 'OPPORTUNITY'}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {liveAnalysis.insights.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Strategic Insights
                </h6>
                {liveAnalysis.insights.map((ins, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, fontSize: 'var(--font-size-xs)', lineHeight: 1.5 }}>
                    <span style={{
                      flexShrink: 0, width: 16, height: 16, borderRadius: 3,
                      backgroundColor: ins.color, color: '#000', fontWeight: 900,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px',
                    }}>
                      {ins.icon}
                    </span>
                    <span style={{ color: 'var(--color-text-primary)' }}>{ins.text}</span>
                  </div>
                ))}
              </div>
            )}

            {liveAnalysis.featureBars.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  What makes this cluster different
                </h6>
                <div style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: '8px', color: 'var(--color-text-muted)' }}>
                  <span><span style={{ color: '#00e676' }}>{'\u25CF'}</span> Better for selected</span>
                  <span><span style={{ color: '#e10600' }}>{'\u25CF'}</span> Worse for selected</span>
                </div>
                {liveAnalysis.featureBars.slice(0, 8).map((fb) => {
                  const barColor = fb.lowerBetter === true
                    ? (fb.direction === 'lower' ? '#00e676' : '#e10600')
                    : fb.lowerBetter === false
                      ? (fb.direction === 'higher' ? '#00e676' : '#e10600')
                      : (fb.direction === 'higher' ? '#64C4FF' : '#ffd700');
                  const barWidth = Math.min(100, (fb.effectSize / 2) * 100);
                  return (
                    <div key={fb.key} style={{ marginBottom: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-xs)', marginBottom: 2 }}>
                        <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{fb.label}</span>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}>
                          {fb.selMean.toFixed(1)} vs {fb.restMean.toFixed(1)} {fb.unit}
                          <span style={{ color: barColor, marginLeft: 4, fontWeight: 700 }}>
                            {fb.direction === 'higher' ? '\u2191' : '\u2193'} {fb.magnitude}
                          </span>
                        </span>
                      </div>
                      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 2, backgroundColor: barColor, width: `${barWidth}%`, transition: 'width 0.3s ease' }} />
                      </div>
                    </div>
                  );
                })}
                <div style={{ fontSize: '8px', color: 'var(--color-text-muted)', marginTop: 6 }}>
                  Bar length = Cohen's d effect size (how different from rest of field)
                </div>
              </div>
            )}

            <div>
              <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700, paddingLeft: 2 }}>
                Driver Details
              </h6>
              {liveAnalysis.drivers.map((d) => {
                const trendStr = d.paceTrend > 0.05 ? `+${d.paceTrend.toFixed(2)}s/lap` : d.paceTrend < -0.05 ? `${d.paceTrend.toFixed(2)}s/lap` : 'stable';
                const trendColor = d.paceTrend > 0.05 ? '#e10600' : d.paceTrend < -0.05 ? '#00e676' : 'var(--color-text-muted)';
                const proj = raceProjection?.projections.find((p) => p.driver === d.abbr);

                return (
                  <div key={d.abbr} style={{
                    background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)',
                    padding: '8px 12px', borderLeft: `3px solid ${getDriverColor(d.abbr)}`, marginBottom: 4,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <strong style={{ color: getDriverColor(d.abbr), fontSize: 'var(--font-size-sm)' }}>{d.abbr}</strong>
                      <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>{d.team}</span>
                      <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 'var(--font-size-sm)' }}>
                        P{d.position}
                        {proj && Math.abs(proj.delta) >= 0.5 && (
                          <span style={{ fontSize: '9px', marginLeft: 4, color: proj.delta > 0 ? '#00e676' : '#e10600' }}>
                            {'\u2192'}P{proj.modePos}
                            <span style={{ fontSize: '7px', marginLeft: 2 }}>({proj.podiumProb}% pod)</span>
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', flexWrap: 'wrap' }}>
                      <span>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: TYRE_COLORS[d.compoundName] || '#888', marginRight: 4, verticalAlign: 'middle' }} />
                        {d.compoundName} L{d.tyreLife}
                      </span>
                      <span>Pace: {d.recentPace?.toFixed(1)}s</span>
                      <span style={{ color: trendColor }}>Trend: {trendStr}</span>
                      <span>Pit ~{d.estLapsToPit}L</span>
                      {d.positionTrend !== 0 && (
                        <span style={{ color: d.positionTrend > 0 ? '#00e676' : '#e10600' }}>
                          {d.positionTrend > 0 ? '+' : ''}{d.positionTrend} pos
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Live mode empty state ── */}
        {isLiveMode && !liveAnalysis && selectedDrivers.length === 0 && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              <strong style={{ color: '#00e676', display: 'block', marginBottom: 8, fontSize: 'var(--font-size-md)' }}>
                Race Situation Analysis
              </strong>
              Select drivers on the Race Situation Map or Leaderboard to see
              <strong> cluster analysis</strong>, strategic insights, and threats/opportunities.
            </div>
          </div>
        )}

        {/* ══════════ HISTORICAL MODE (t-SNE / PCA) ══════════ */}

        {!isLiveMode && !tsneStrategyAnalysis && selectedTSNEPoints.length === 0 && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              <strong style={{ color: 'var(--color-text-primary)', display: 'block', marginBottom: 8, fontSize: 'var(--font-size-md)' }}>
                What does the scatterplot show?
              </strong>
              Each point is one driver's full race performance,
              projected from <strong style={{ color: 'var(--color-accent-info)' }}>19 features</strong> into 2D.<br /><br />
              <strong style={{ color: 'var(--color-text-primary)' }}>Points close together = similar race profiles.</strong><br /><br />
              <div style={{
                background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)',
                padding: '12px', textAlign: 'left', marginTop: 8,
              }}>
                <div style={{ fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 6, fontSize: 'var(--font-size-xs)', textTransform: 'uppercase' }}>
                  How to use
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: 'var(--color-accent-info)', fontWeight: 700, minWidth: 16 }}>1.</span>
                  <span>Find a cluster of nearby points</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: 'var(--color-accent-info)', fontWeight: 700, minWidth: 16 }}>2.</span>
                  <span><strong>Shift + drag</strong> to lasso-select them</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--color-accent-info)', fontWeight: 700, minWidth: 16 }}>3.</span>
                  <span>See strategy patterns and feature analysis</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {!isLiveMode && selectedTSNEPoints.length > 0 && !tsneStrategyAnalysis && (
          <div className="loading-placeholder">
            <div className="spinner" />
            <span>Analyzing {selectedTSNEPoints.length} selected points...</span>
          </div>
        )}

        {!isLiveMode && tsneStrategyAnalysis && !tsneStrategyAnalysis.error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
            {tsneStrategyAnalysis.summary && (
              <div style={{
                background: 'linear-gradient(135deg, rgba(225,6,0,0.08) 0%, rgba(225,6,0,0.02) 100%)',
                borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)',
                borderLeft: '3px solid var(--color-f1-red)',
              }}>
                {tsneStrategyAnalysis.cluster_label && (
                  <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-f1-red)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                    {tsneStrategyAnalysis.cluster_label}
                  </div>
                )}
                <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6, color: 'var(--color-text-primary)' }}>
                  {tsneStrategyAnalysis.summary}
                </div>
              </div>
            )}

            {tsneStrategyAnalysis.strategies?.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Strategies Used ({tsneStrategyAnalysis.n_selected || selectedTSNEPoints.length} races)
                </h6>
                {tsneStrategyAnalysis.strategies.map((strat, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-xs)', marginBottom: 6 }}>
                    <span style={{ color: 'var(--color-text-muted)', width: 20, fontSize: '9px' }}>#{i + 1}</span>
                    {(strat.stints || []).map((s, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && <span style={{ color: 'var(--color-text-muted)', fontSize: 8 }}>{'\u2192'}</span>}
                        <span style={{
                          padding: '2px 6px', borderRadius: 3,
                          backgroundColor: TYRE_COLORS[s.compound?.toUpperCase()] || '#888',
                          color: s.compound?.toUpperCase() === 'HARD' || s.compound?.toUpperCase() === 'MEDIUM' ? '#000' : '#fff',
                          fontSize: 9, fontWeight: 700,
                        }}>
                          {s.compound?.[0]}{s.length > 0 ? s.length : ''}
                        </span>
                      </React.Fragment>
                    ))}
                    <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto', fontSize: '10px' }}>
                      {strat.count} race{strat.count !== 1 ? 's' : ''} ({(strat.frequency * 100).toFixed(0)}%)
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tsneStrategyAnalysis.common_patterns?.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Compound Usage
                </h6>
                {tsneStrategyAnalysis.common_patterns.map((pattern, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 'var(--font-size-sm)' }}>
                    <span style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: TYRE_COLORS[pattern.compound] || '#888', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600 }}>{pattern.compound}</span>
                    <span style={{ color: 'var(--color-text-muted)' }}>avg {pattern.avg_stint_length?.toFixed(0)} laps/stint</span>
                    <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto', fontSize: 'var(--font-size-xs)' }}>
                      {pattern.count} stint{pattern.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tsneStrategyAnalysis.pit_windows?.length > 0 && (
              <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)' }}>
                <h6 style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                  Pit Stop Windows
                </h6>
                {tsneStrategyAnalysis.pit_windows.map((w, i) => (
                  <div key={i} style={{ fontSize: 'var(--font-size-sm)', marginBottom: 4, display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--color-text-muted)', minWidth: 50 }}>Stop {i + 1}</span>
                    <span>
                      Lap <strong>{w.lap_start}</strong>{'\u2013'}<strong>{w.lap_end}</strong>
                      {w.median_lap && <span style={{ color: 'var(--color-text-muted)' }}> (median: {w.median_lap})</span>}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                      {w.count} pit{w.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tsneStrategyAnalysis.feature_importance?.length > 0 && (
              <StrategyBriefing />
            )}
          </div>
        )}

        {!isLiveMode && tsneStrategyAnalysis?.error && (
          <div className="loading-placeholder" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
              {tsneStrategyAnalysis.error}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
