import React, { useMemo, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { extractRaceParams } from '../../utils/raceSimulation';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { completedLaps } from '../../utils/raceTime';
import { FALLBACK_PIT_LOSS } from '../../utils/pitLoss';
import {
  causalKey, completedStints, pitLossDisplay, viewSessionType, isRaceSession,
} from '../../utils/strategyViews';

const FALLBACK_DEG = { mean: 0.04, stdDev: 0.02 };

function fmt(s, withSign = true) {
  if (s == null || !isFinite(s)) return '—';
  const sign = s >= 0 ? (withSign ? '+' : '') : '-';
  return `${sign}${Math.abs(s).toFixed(2)}s`;
}

export default function UndercutCalculator() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const raceSituationData = useF1Store((s) => s.raceSituationData);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const comparisonDriver = useF1Store((s) => s.comparisonDriver);
  const setComparisonDriver = useF1Store((s) => s.setComparisonDriver);

  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);
  // Undercut maths uses the race pit loss: race sessions ('R', 'S') only
  const sessionType = useF1Store(viewSessionType);
  const isRace = isRaceSession(sessionType);
  const sessionNow = useSessionNow();
  // Live mode: stints still being run are not completed stint lengths
  const running = useStintsRunning();

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const trackStatus = useMemo(() => sessionData?.track_status || [], [sessionData]);
  const driverFeatures = raceSituationData?.driverFeatures || {};
  // Changes only when a lap, a pit event or a track-status event completes,
  // so the memos below do not re-run on every replay frame
  const causal = useMemo(
    () => causalKey(lapTimes, sessionNow, trackStatus),
    [lapTimes, sessionNow, trackStatus],
  );

  // Latest standings (ordered by position), from the laps completed at
  // sessionNow: the lap in progress has no position yet
  const standings = useMemo(() => {
    const latest = {};
    for (const lt of completedLaps(lapTimes, sessionNow)) {
      if (!latest[lt.Driver] || lt.LapNumber > latest[lt.Driver].LapNumber) {
        latest[lt.Driver] = lt;
      }
    }
    return Object.values(latest)
      .filter((r) => r.Position != null && r.Position > 0)
      .sort((a, b) => a.Position - b.Position);
  }, [lapTimes, causal]);

  const driverList = standings.map((d) => d.Driver);

  const effectiveFocus = focusDriver || driverList[0] || null;

  const defaultRival = useMemo(() => {
    const idx = standings.findIndex((d) => d.Driver === effectiveFocus);
    if (idx > 0) return standings[idx - 1].Driver;
    if (idx === 0 && standings.length > 1) return standings[1].Driver;
    return driverList.find((d) => d !== effectiveFocus) || null;
  }, [standings, effectiveFocus, driverList]);

  // Shared with Sector Delta Waterfall — selecting a rival in either panel
  // updates the other. Falls back to the heuristic default (car directly
  // ahead of focus in current standings) when no comparison is set yet.
  const rival = (comparisonDriver && comparisonDriver !== effectiveFocus)
    ? comparisonDriver
    : defaultRival;

  useEffect(() => {
    if (!comparisonDriver && defaultRival) {
      setComparisonDriver(defaultRival);
    }
  }, [comparisonDriver, defaultRival, setComparisonDriver]);

  // Race params from what is known at sessionNow (completed laps and stints,
  // utils/stints.js), recomputed whenever the causal key changes, i.e. on
  // every lap / pit / track-status event and on any seek, backward included.
  // Never store.raceProjection.raceParams: that object was computed at the
  // clock of its own run and can hold later laps after a backward seek.
  const raceParams = useMemo(() => extractRaceParams(
    lapTimes, completedStints(lapTimes, sessionNow, { running }), trackStatus, currentLap,
    { sessionNow, sessionTimeOffset, sessionType, running },
  ), [lapTimes, trackStatus, currentLap, causal, sessionTimeOffset, sessionType, running]);

  // Analytical sweep: for each candidate pit lap, compute end-of-race delta
  const analysis = useMemo(() => {
    if (!effectiveFocus || !rival || effectiveFocus === rival) return null;

    const fFeat = driverFeatures[effectiveFocus];
    const rFeat = driverFeatures[rival];
    if (!fFeat || !rFeat) return null;

    const currentGap = (rFeat.gapToLeader || 0) - (fFeat.gapToLeader || 0);
    // Negative gap means focus is ahead; positive means rival is ahead of focus
    // Focus wants to end with gap >= 0 (ahead of rival)
    const focusIsAhead = currentGap < 0;

    const lapsRemaining = Math.max(1, maxLap - currentLap);
    // Pit loss = the race estimator's median (utils/pitLoss.js), or the
    // labelled fallback before the first valid green-flag stop
    const pitLossInfo = pitLossDisplay(raceParams?.pitLoss);
    const pitLoss = pitLossInfo.value;
    const freshDelta = raceParams?.freshDelta || -0.4; // negative = faster

    const fCompound = fFeat.compoundName || 'MEDIUM';
    const rCompound = rFeat.compoundName || 'MEDIUM';
    const fDeg = raceParams?.tyreDeg?.[fCompound]?.mean ?? FALLBACK_DEG.mean;
    const rDeg = raceParams?.tyreDeg?.[rCompound]?.mean ?? FALLBACK_DEG.mean;
    const fTyreLife = fFeat.tyreLife || 0;
    const rTyreLife = rFeat.tyreLife || 0;

    // Next compound's deg for focus (after pit)
    const nextCompound = fCompound === 'SOFT' ? 'MEDIUM' : fCompound === 'MEDIUM' ? 'HARD' : 'HARD';
    const fDegNew = raceParams?.tyreDeg?.[nextCompound]?.mean ?? FALLBACK_DEG.mean;

    // Estimate rival's expected pit lap (their stint limit)
    const rStintLimit = raceParams?.stintLength?.[rCompound]?.mean ?? 25;
    const rivalPitLapRel = Math.max(1, Math.round(rStintLimit - rTyreLife));

    // Sweep candidate pit laps (0 = now, 1 = next lap, ...)
    const maxSweep = Math.min(15, lapsRemaining - 1);
    const rows = [];

    for (let k = 0; k <= maxSweep; k++) {
      // k laps after currentLap, focus pits
      // Before focus pit: both degrade
      //   focus delta to rival per lap = (fDeg*(fTyreLife+i) - rDeg*(rTyreLife+i))
      //   Actually we want: change in gap from focus to rival
      //   gap_rival_minus_focus change = (focus_laptime - rival_laptime)
      //     = fDeg*(fTyreLife+i) - rDeg*(rTyreLife+i)
      //   (+) means focus loses time to rival
      let gap = currentGap; // positive = rival ahead
      for (let i = 1; i <= k; i++) {
        const fLapDeg = fDeg * (fTyreLife + i);
        const rLapDeg = rDeg * (rTyreLife + i);
        // Slower driver increases gap accordingly
        gap += (fLapDeg - rLapDeg);
      }
      // Focus pit: loses pitLoss, resets to fresh tyres
      gap += pitLoss;

      // Remaining laps after focus pit
      let rivalPitted = false;
      for (let i = 1; i <= lapsRemaining - k; i++) {
        // Check if rival has reached their pit lap (scheduled)
        if (!rivalPitted && (k + i) >= rivalPitLapRel && i > 1) {
          gap -= pitLoss; // rival pays pit cost (reduces gap)
          rivalPitted = true;
          continue;
        }
        const fLapDeg = fDegNew * i + freshDelta; // focus on fresh tyres
        let rLapCost;
        if (!rivalPitted) {
          rLapCost = rDeg * (rTyreLife + k + i); // rival still on old tyres
        } else {
          // Rival on fresh tyres after their stop — same nextCompound assumption
          const rNextCompound = rCompound === 'SOFT' ? 'MEDIUM' : 'HARD';
          const rDegNew = raceParams?.tyreDeg?.[rNextCompound]?.mean ?? FALLBACK_DEG.mean;
          const rivalFreshLap = i - (rivalPitLapRel - k);
          rLapCost = rDegNew * Math.max(0, rivalFreshLap) + freshDelta;
        }
        gap += (fLapDeg - rLapCost);
      }
      // Final gap (positive = rival still ahead)
      rows.push({
        pitAtLap: currentLap + k,
        relative: k,
        projectedGap: +gap.toFixed(2),
        focusFinishesAhead: gap < 0,
      });
    }

    // Find optimal pit lap (one that minimizes projectedGap, i.e., maximizes focus ahead)
    const bestRow = rows.reduce((best, r) => (r.projectedGap < best.projectedGap ? r : best), rows[0]);

    // Undercut threshold heuristic:
    const undercutGainPerLap = Math.abs(freshDelta) + rDeg * rTyreLife;
    // Threshold = time you can be behind and still emerge ahead after 3 laps on fresh tyres
    const undercutThreshold = Math.max(0, 3 * undercutGainPerLap - pitLoss + currentGap);

    return {
      rows,
      bestRow,
      currentGap,
      focusIsAhead,
      lapsRemaining,
      pitLoss,
      pitLossInfo,
      freshDelta,
      fDeg,
      rDeg,
      fTyreLife,
      rTyreLife,
      fCompound,
      rCompound,
      rivalPitLapRel,
      undercutGainPerLap,
      undercutThreshold,
    };
  }, [effectiveFocus, rival, driverFeatures, raceParams, currentLap, maxLap]);

  if (!isRace) {
    return (
      <div style={{ padding: 20, color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        The undercut calculator applies to race sessions only (race or sprint).
      </div>
    );
  }
  if (!effectiveFocus || !rival) {
    return (
      <div style={{ padding: 20, color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        Select a focus driver. Need at least two drivers with data.
      </div>
    );
  }
  if (!analysis) {
    return (
      <div style={{ padding: 20, color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        Not enough data. Wait until driver features populate (lap 5+).
      </div>
    );
  }

  const focusColor = getDriverColor(effectiveFocus);
  const rivalColor = getDriverColor(rival);

  const { rows, bestRow } = analysis;
  const maxAbsGap = Math.max(...rows.map((r) => Math.abs(r.projectedGap)), 1);

  const chipStyle = (color) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 6px', borderRadius: 4,
    background: 'rgba(255,255,255,0.06)',
    border: `1px solid ${color}55`,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: 11, overflow: 'hidden' }}>
      {/* Header: focus chip + rival picker chip, compact so nothing wraps oddly */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={chipStyle(focusColor)}>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, fontWeight: 700 }}>FOCUS</span>
          <span style={{ fontWeight: 800, color: focusColor, fontSize: 11 }}>{effectiveFocus}</span>
          <span style={{ fontSize: 9, color: TYRE_COLORS[analysis.fCompound] || '#888', fontWeight: 700 }}>
            {analysis.fCompound[0]}·L{analysis.fTyreLife}
          </span>
        </div>
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>vs</span>
        <div style={chipStyle(rivalColor)}>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, fontWeight: 700 }}>RIVAL</span>
          <select
            value={rival}
            onChange={(e) => setComparisonDriver(e.target.value)}
            style={{
              background: 'transparent',
              color: rivalColor,
              border: 'none',
              borderRadius: 3,
              fontWeight: 800,
              fontSize: 11,
              padding: '0 2px',
              cursor: 'pointer',
            }}
          >
            {driverList.filter((d) => d !== effectiveFocus).map((d) => (
              <option key={d} value={d} style={{ color: '#000' }}>{d}</option>
            ))}
          </select>
          <span style={{ fontSize: 9, color: TYRE_COLORS[analysis.rCompound] || '#888', fontWeight: 700 }}>
            {analysis.rCompound[0]}·L{analysis.rTyreLife}
          </span>
        </div>
      </div>

      {/* Inputs summary — 4 KPI cells.
          minWidth:0 on cells lets overflowing text get truncated instead of
          forcing the grid wider than the panel. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 6,
        padding: '6px 8px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 4,
        marginBottom: 8,
        fontSize: 9,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Current gap focus↔rival">GAP NOW</div>
          <div
            title={`${analysis.focusIsAhead ? 'ahead' : 'behind'} ${Math.abs(analysis.currentGap).toFixed(2)}s`}
            style={{ color: analysis.focusIsAhead ? '#22c55e' : '#ef4444', fontWeight: 800, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {analysis.focusIsAhead ? '−' : '+'}{Math.abs(analysis.currentGap).toFixed(2)}s
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap' }} title="Time lost entering and exiting the pits">PIT LOSS</div>
          <div
            title={analysis.pitLossInfo.isFallback
              ? `No valid green-flag stop yet: ${FALLBACK_PIT_LOSS.median} s fallback (an assumption, not data)`
              : `Median of ${analysis.pitLossInfo.n} green-flag stops in this race: in-lap + out-lap - 2 x the driver's green-flag median lap`}
            style={{ color: '#f5a623', fontWeight: 800, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {analysis.pitLoss.toFixed(1)}s
            {analysis.pitLossInfo.isFallback && (
              <span style={{ marginLeft: 3, fontSize: 8, fontWeight: 700, color: 'rgba(255,255,255,0.55)' }}>fallback</span>
            )}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Seconds gained per lap on fresh tyres vs rival's old tyres">UC GAIN/L</div>
          <div style={{ color: '#22c55e', fontWeight: 800, fontSize: 11 }}>
            {analysis.undercutGainPerLap.toFixed(2)}s
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap' }} title="Laps remaining in the race">LAPS LEFT</div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 11 }}>{analysis.lapsRemaining}</div>
        </div>
      </div>

      {/* Verdict */}
      <div style={{
        padding: '6px 10px',
        background: bestRow.focusFinishesAhead ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
        border: `1px solid ${bestRow.focusFinishesAhead ? '#22c55e55' : '#ef444455'}`,
        borderRadius: 4,
        marginBottom: 8,
        fontSize: 10,
      }}>
        <div style={{ color: bestRow.focusFinishesAhead ? '#22c55e' : '#ef4444', fontWeight: 800, marginBottom: 2 }}>
          {bestRow.focusFinishesAhead ? '✓ UNDERCUT VIABLE' : '✗ UNDERCUT NOT VIABLE'}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.7)' }}>
          Best pit lap: <b style={{ color: '#fff' }}>L{bestRow.pitAtLap}</b> → projected finish{' '}
          <b style={{ color: bestRow.focusFinishesAhead ? '#22c55e' : '#ef4444' }}>
            {bestRow.focusFinishesAhead ? 'ahead' : 'behind'} {Math.abs(bestRow.projectedGap).toFixed(2)}s
          </b>
          . Rival expected to pit ~L{currentLap + analysis.rivalPitLapRel}.
        </div>
      </div>

      {/* Sweep table header + legend */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, marginBottom: 4, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', fontWeight: 700, letterSpacing: '0.05em' }}>
          PIT-LAP SWEEP · projected finish gap
        </span>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#22c55e' }} />
            focus ahead
          </span>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444' }} />
            focus behind
          </span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.map((r) => {
          const isBest = r.pitAtLap === bestRow.pitAtLap;
          const pct = (Math.abs(r.projectedGap) / maxAbsGap) * 50;
          const color = r.focusFinishesAhead ? '#22c55e' : '#ef4444';
          return (
            <div
              key={r.pitAtLap}
              style={{
                display: 'grid',
                gridTemplateColumns: '56px 1fr 70px',
                gap: 6,
                padding: '3px 4px',
                alignItems: 'center',
                background: isBest ? 'rgba(34,197,94,0.08)' : undefined,
                borderRadius: 3,
                marginBottom: 1,
              }}
            >
              <span style={{ fontWeight: isBest ? 800 : 600, color: isBest ? '#22c55e' : 'rgba(255,255,255,0.75)', fontSize: 10 }}>
                {r.relative === 0 ? 'NOW' : `L${r.pitAtLap}`}
              </span>
              <div style={{ position: 'relative', height: 12 }}>
                <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.15)' }} />
                <div style={{
                  position: 'absolute',
                  top: 1,
                  bottom: 1,
                  left: r.projectedGap < 0 ? `${50 - pct}%` : '50%',
                  width: `${pct}%`,
                  background: color,
                  borderRadius: 2,
                  opacity: isBest ? 1 : 0.75,
                }} />
              </div>
              <span style={{ fontWeight: 800, fontSize: 10, textAlign: 'right', color }}>
                {r.projectedGap < 0 ? '−' : '+'}{Math.abs(r.projectedGap).toFixed(2)}s
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)', marginTop: 6, lineHeight: 1.4 }}>
        Analytical projection using tyre-deg and fresh-delta from the laps completed so far, and the
        pit loss measured from this race's green-flag stops (median; {FALLBACK_PIT_LOSS.median} s
        fallback, labelled, before the first valid stop).
        Assumes rival pits on estimated optimal lap (tyre life reaches stint-length mean).
      </div>
    </div>
  );
}
