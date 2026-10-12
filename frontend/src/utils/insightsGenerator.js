/**
 * Auto-generate natural-language insights from analytical data.
 * Each insight has: { id, category, severity, text, actions, confidence }
 *
 * Categories: battle, risk, opportunity, pattern, forecast, degradation
 * Severity: info (gray), notable (yellow), high (red)
 * Actions: array of { label, drivers?, tab?, pattern? }
 * Confidence: 0-1 based on data quality (more laps = higher confidence)
 */

export function generateInsights({
  raceProjection,
  raceSituationData,
  lstmPredictions,
  degradationRegression,
  pcaStrategyAnalysis,
  currentLap,
  maxLap,
  focusDriver,
}) {
  const insights = [];
  const progress = maxLap > 0 ? currentLap / maxLap : 0;
  const confidence = Math.min(1, currentLap / 10);

  // Category 1: Monte Carlo battles (high-probability overtakes)
  if (raceProjection?.battles?.length > 0) {
    for (const battle of raceProjection.battles.slice(0, 3)) {
      if (battle.prob >= 50) {
        insights.push({
          id: `battle-${battle.behind}-${battle.ahead}`,
          category: 'battle',
          severity: battle.prob >= 70 ? 'high' : 'notable',
          text: `${battle.behind} has ${battle.prob}% probability of passing ${battle.ahead} before the end of the race (Monte Carlo, 100 sims).`,
          actions: [{
            label: 'Focus both',
            drivers: [battle.behind, battle.ahead],
          }],
          confidence,
        });
      }
    }
  }

  // Category 2: High-variance finishes (uncertainty alerts)
  if (raceProjection?.projections?.length > 0) {
    const uncertain = raceProjection.projections
      .filter(p => (p.posRange[1] - p.posRange[0]) >= 6)
      .slice(0, 2);
    for (const p of uncertain) {
      insights.push({
        id: `uncertain-${p.driver}`,
        category: 'risk',
        severity: 'notable',
        text: `${p.driver} has high outcome variance \u2014 could finish anywhere from P${p.posRange[0]} to P${p.posRange[1]} depending on strategy and safety cars.`,
        actions: [{ label: 'Focus', drivers: [p.driver] }],
        confidence,
      });
    }
  }

  // Category 3: Tyre degradation alerts
  if (raceSituationData?.driverFeatures) {
    const features = raceSituationData.driverFeatures;
    const degradingDrivers = Object.entries(features)
      .filter(([, f]) => f.paceTrend > 0.15)
      .sort(([, a], [, b]) => b.paceTrend - a.paceTrend)
      .slice(0, 2);
    for (const [drv, f] of degradingDrivers) {
      insights.push({
        id: `degradation-${drv}`,
        category: 'degradation',
        severity: f.paceTrend > 0.25 ? 'high' : 'notable',
        text: `${drv} is losing ${f.paceTrend.toFixed(2)}s per lap on ${f.compoundName} tyres. Pit window closing fast (est. ${f.estLapsToPit} laps to compound cliff).`,
        actions: [{ label: 'Focus', drivers: [drv] }],
        confidence,
      });
    }
  }

  // Category 4: LSTM forecast insights (pace trajectory)
  if (focusDriver && lstmPredictions?.[focusDriver]?.predicted_times?.length >= 3) {
    const times = lstmPredictions[focusDriver].predicted_times;
    const delta = times[times.length - 1] - times[0];
    if (Math.abs(delta) >= 0.3) {
      insights.push({
        id: `lstm-${focusDriver}`,
        category: 'forecast',
        severity: 'info',
        text: delta < 0
          ? `LSTM forecast: ${focusDriver} is projected to improve pace by ${Math.abs(delta).toFixed(2)}s over the next ${times.length} laps.`
          : `LSTM forecast: ${focusDriver} is projected to slow by ${delta.toFixed(2)}s over the next ${times.length} laps \u2014 possible degradation onset.`,
        actions: [{ label: 'Open Prediction', tab: 'prediction' }],
        confidence: Math.min(1, currentLap / 15),
      });
    }
  }

  // Category 5: PCA cluster patterns (if user has lassoed)
  if (pcaStrategyAnalysis?.strategies?.length > 0) {
    const top = pcaStrategyAnalysis.strategies[0];
    if (top && top.frequency >= 0.4) {
      const stintDesc = top.stints.map(s => s.compound[0]).join('-');
      // N stints = N - 1 stops (same rule as the backend summary in tsne_compute.py)
      const stops = Math.max(0, top.stints.length - 1);
      insights.push({
        id: `pca-${stintDesc}`,
        category: 'pattern',
        severity: 'info',
        text: `Selected PCA cluster (${pcaStrategyAnalysis.selection_count || 'N'} races) shows ${Math.round(top.frequency * 100)}% dominance of ${stops}-stop ${stintDesc} strategy.`,
        actions: [{ label: 'Apply to Simulator', pattern: top }],
        confidence: 0.9,
      });
    }
  }

  // Category 6: Degradation regression (if brushed)
  if (degradationRegression?.regressions?.length > 0) {
    for (const reg of degradationRegression.regressions.slice(0, 2)) {
      if (reg.slope > 0.1) {
        insights.push({
          id: `regress-${reg.driver}`,
          category: 'degradation',
          severity: 'notable',
          text: `In the brushed lap range, ${reg.driver}'s ${reg.compound} tyres degraded at ${reg.slope.toFixed(3)}s/lap (R\u00B2=${(reg.r_squared || 0).toFixed(2)}).`,
          actions: [{ label: 'Focus', drivers: [reg.driver] }],
          confidence: Math.min(1, (reg.n_points || 0) / 10),
        });
      }
    }
  }

  // Category 7: Race phase insight (context)
  if (progress > 0.6 && progress < 0.8) {
    insights.push({
      id: 'phase-late',
      category: 'pattern',
      severity: 'info',
      text: `Race is in the late phase (${Math.round(progress * 100)}% complete). Strategic windows are closing \u2014 pit decisions now have maximum impact on finishing position.`,
      actions: [],
      confidence: 1,
    });
  }

  // Sort: high severity first, then by confidence
  const sevOrder = { high: 0, notable: 1, info: 2 };
  insights.sort((a, b) => {
    const so = (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3);
    if (so !== 0) return so;
    return b.confidence - a.confidence;
  });

  return insights.slice(0, 7);
}
