/**
 * Undercut Calculator: for each candidate pit lap of the focus driver, the
 * projected gap to a rival at one lap for every row, the first lap by which
 * both have stopped in every row. The maths is
 * utils/undercut.js undercutSweep (the projection the Circle of Doom's "pit in
 * k laps" uses): the Circle of Doom's pit window (each car's last line
 * crossing and recent pace, the race's pit-loss median), then the engine's lap
 * model (raceSimulation.js: degradation by compound and tyre age, fresh-tyre
 * delta on the first flying lap); the rival's stop is scheduled in every row
 * (its likely stop from the stint-life survival, or a lap chosen here). This
 * file only draws it; no model value lives here.
 */
import React, { useMemo, useEffect, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { extractRaceParams } from '../../utils/raceSimulation';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { FALLBACK_PIT_LOSS, estimatePitLoss } from '../../utils/pitLoss';
import { circleState, circleStateKey } from '../../utils/circleOfDoom';
import { undercutSweep } from '../../utils/undercut';
import {
  causalKey, completedStints, pitLossDisplay, viewSessionType, isRaceSession,
} from '../../utils/strategyViews';

const MINUS = '−';

/** Signed seconds, '+1.24s' / '−2.71s'. */
function fmt(s, digits = 2) {
  if (s == null || !Number.isFinite(s)) return '—';
  return `${s >= 0 ? '+' : MINUS}${Math.abs(s).toFixed(digits)}s`;
}

/** Signed seconds per lap with three decimals ('+0.093', '−0.827'). */
function perLap(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  return `${s >= 0 ? '+' : MINUS}${Math.abs(s).toFixed(3)}`;
}

const STOP_SOURCE = {
  race: 'stint-life survival of this race',
  prior: 'stint-life survival of the cached races (prior)',
  chosen: 'chosen here',
  'in progress': 'stop in progress',
  none: 'its set is not due before the flag',
};

const UNAVAILABLE = {
  'not-applicable': 'The undercut calculator applies to race sessions only (race or sprint).',
  'race-over': 'Race over: no undercut to project.',
  'chequered-flag': 'Chequered flag: no undercut to project.',
  'first-lap': 'No projection before the focus driver has crossed the line.',
  'field-on-lap-one': 'No projection until every car has passed the end of sector 2 on lap 1.',
  'not-running': 'The focus driver is not running.',
  'rival-not-running': 'The rival is not running.',
  'focus-stopping': 'The focus driver is stopping now: see the Circle of Doom for the rejoin.',
  'last-lap': 'No pit lap left before the flag.',
  'no-tyre-data': 'No tyre data for these drivers yet.',
};

export default function UndercutCalculator() {
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
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
  // Changes only when a lap, a pit event or a track-status event completes,
  // so the memos below do not re-run on every replay frame
  const causal = useMemo(
    () => causalKey(lapTimes, sessionNow, trackStatus),
    [lapTimes, sessionNow, trackStatus],
  );
  // The circle's key also follows the lap-1 timing points (race order on lap 1)
  const stateKey = useMemo(
    () => circleStateKey(lapTimes, sessionNow, trackStatus),
    [lapTimes, sessionNow, trackStatus],
  );

  /* eslint-disable react-hooks/exhaustive-deps -- `stateKey` stands for sessionNow */
  // Race order, last crossings and paces at sessionNow (utils/circleOfDoom.js)
  const state = useMemo(
    () => circleState(lapTimes, { sessionNow, dnfMap, isLiveMode }),
    [lapTimes, stateKey, dnfMap, isLiveMode],
  );
  // Pit loss at sessionNow (utils/pitLoss.js), the race estimator's median
  const pitLoss = useMemo(
    () => estimatePitLoss(lapTimes, { sessionNow, sessionType }),
    [lapTimes, stateKey, sessionType],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  const driverList = useMemo(
    () => state.cars.filter((c) => c.position != null).map((c) => c.driver),
    [state],
  );
  const effectiveFocus = focusDriver || driverList[0] || null;

  // Default rival: the car directly ahead in the race order (the leader's: the car behind)
  const defaultRival = useMemo(() => {
    const idx = driverList.indexOf(effectiveFocus);
    if (idx > 0) return driverList[idx - 1];
    if (idx === 0 && driverList.length > 1) return driverList[1];
    return driverList.find((d) => d !== effectiveFocus) || null;
  }, [driverList, effectiveFocus]);

  // Shared with Sector Delta Waterfall — selecting a rival in either panel
  // updates the other. Falls back to the default (car directly ahead of the
  // focus in the race order) when no comparison is set yet.
  const rival = (comparisonDriver && comparisonDriver !== effectiveFocus)
    ? comparisonDriver
    : defaultRival;

  useEffect(() => {
    if (!comparisonDriver && defaultRival) {
      setComparisonDriver(defaultRival);
    }
  }, [comparisonDriver, defaultRival, setComparisonDriver]);

  // The rival's stop lap: null = its likely stop (stint-life survival)
  const [rivalStopLap, setRivalStopLap] = useState(null);
  useEffect(() => { setRivalStopLap(null); }, [rival]);

  // Race params from what is known at sessionNow (completed laps and stints,
  // utils/stints.js), recomputed whenever the causal key changes, i.e. on
  // every lap / pit / track-status event and on any seek, backward included.
  // Never store.raceProjection.raceParams: that object was computed at the
  // clock of its own run and can hold later laps after a backward seek.
  const raceParams = useMemo(() => extractRaceParams(
    lapTimes, completedStints(lapTimes, sessionNow, { running }), trackStatus, currentLap,
    { sessionNow, sessionTimeOffset, sessionType, running },
  ), [lapTimes, trackStatus, currentLap, causal, sessionTimeOffset, sessionType, running]);

  // Sweep of the candidate pit laps (utils/undercut.js)
  const analysis = useMemo(() => {
    if (!isRace || !effectiveFocus || !rival || effectiveFocus === rival) return null;
    return undercutSweep(effectiveFocus, rival, state, pitLoss, raceParams, {
      totalLaps: totalRaceLaps || maxLap || undefined,
      rivalStopLap: rivalStopLap ?? undefined,
    });
  }, [isRace, effectiveFocus, rival, state, pitLoss, raceParams, totalRaceLaps, maxLap, rivalStopLap]);
  // A chosen rival stop the replay has moved past (the rival completed that
  // lap, or is stopping now) is no longer a choice: back to its likely stop
  const choiceGone = rivalStopLap != null && analysis?.rivalStop != null && analysis.rivalStop.source !== 'chosen';
  useEffect(() => { if (choiceGone) setRivalStopLap(null); }, [choiceGone]);

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

  const focusColor = getDriverColor(effectiveFocus);
  const rivalColor = getDriverColor(rival);
  const pitLossInfo = pitLossDisplay(pitLoss);

  const chipStyle = (color) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 6px', borderRadius: 4,
    background: 'rgba(255,255,255,0.06)',
    border: `1px solid ${color}55`,
  });
  // The set on the car now (driverStateAt, R6: the new set from the pit exit)
  const tyreTag = (tyre) => (tyre?.current ? (
    <span
      title={`${tyre.current.compound}${tyre.current.tyreLife != null ? `, tyre age ${tyre.current.tyreLife}` : ''}`}
      style={{ fontSize: 9, color: TYRE_COLORS[tyre.current.compound] || '#888', fontWeight: 700 }}
    >
      {tyre.current.compound[0]}·L{tyre.current.tyreLife ?? '?'}
    </span>
  ) : null);

  const header = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
      <div style={chipStyle(focusColor)}>
        <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, fontWeight: 700 }}>FOCUS</span>
        <span style={{ fontWeight: 800, color: focusColor, fontSize: 11 }}>{effectiveFocus}</span>
        {tyreTag(analysis?.focusTyre)}
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
        {tyreTag(analysis?.rivalTyre)}
      </div>
    </div>
  );

  // PIT LOSS cell: the race estimator's median, or the labelled fallback
  const pitLossCell = (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap' }} title="Time lost entering and exiting the pits">PIT LOSS</div>
      <div
        title={pitLossInfo.isFallback
          ? `No valid green-flag stop yet: ${FALLBACK_PIT_LOSS.median} s fallback (an assumption, not data)`
          : `Median of ${pitLossInfo.n} green-flag stops in this race: in-lap + out-lap - 2 x the driver's green-flag median lap`}
        style={{ color: '#f5a623', fontWeight: 800, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {pitLossInfo.value != null ? `${pitLossInfo.value.toFixed(1)}s` : '—'}
        {pitLossInfo.isFallback && (
          <span style={{ marginLeft: 3, fontSize: 8, fontWeight: 700, color: 'rgba(255,255,255,0.55)' }}>fallback</span>
        )}
      </div>
    </div>
  );

  if (!analysis?.available) {
    const reason = analysis?.reason;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: 11 }}>
        {header}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, padding: '6px 8px',
          background: 'rgba(255,255,255,0.04)', borderRadius: 4, marginBottom: 8, fontSize: 9,
        }}
        >
          {pitLossCell}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
          {UNAVAILABLE[reason] || 'Not enough data to project yet.'}
        </div>
      </div>
    );
  }

  const {
    rows, best, currentGap, rivalStop, freshGain, degradation, freshDeltaInfo,
  } = analysis;
  const lapsRemaining = Math.max(0, (totalRaceLaps || maxLap) - currentLap);
  const maxAbsGap = Math.max(...rows.map((r) => Math.abs(r.gap)), 1);
  const ahead = best.gap > 0;
  const rivalStopText = rivalStop.inLap != null && rivalStop.inRace
    ? `L${rivalStop.inLap}`
    : 'no stop before the flag';
  const negativeDeg = degradation.focus.mean < 0;
  const freshText = freshDeltaInfo
    ? `${perLap(freshDeltaInfo.value)} s (${freshDeltaInfo.source === 'race' ? `${freshDeltaInfo.n} stints of this race` : 'prior of the cached races'}${freshDeltaInfo.clamped ? ', measured slower: 0' : ''})`
    : perLap(analysis.freshDelta);
  // The rival's stop laps the select offers: its lap in progress to the flag
  const nr = state.cars.find((c) => c.driver === rival)?.lapsCompleted ?? currentLap;
  const raceLaps = totalRaceLaps || maxLap || 0;
  const stopChoices = [];
  for (let l = nr + 1; l < raceLaps; l++) stopChoices.push(l);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: 11, overflow: 'hidden' }}>
      {header}

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
          <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Gap to the rival on the latest lap both have completed (+ = focus ahead)">GAP NOW</div>
          <div
            title={currentGap == null ? 'no lap completed by both yet'
              : `${effectiveFocus} ${currentGap >= 0 ? 'ahead' : 'behind'} by ${Math.abs(currentGap).toFixed(2)} s`}
            style={{ color: currentGap >= 0 ? '#22c55e' : '#ef4444', fontWeight: 800, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {fmt(currentGap)}
          </div>
        </div>
        {pitLossCell}
        <div style={{ minWidth: 0 }}>
          <div
            style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title="New-tyre gain: the focus driver's first flying lap on a new set (pitting now) against the same lap on the current set, from the lap model. + = the new set is faster; − = the model makes the new set slower (negative degradation fits so far)"
          >
            NEW-TYRE GAIN
          </div>
          <div style={{ color: freshGain >= 0 ? '#22c55e' : '#ef4444', fontWeight: 800, fontSize: 11 }}>
            {perLap(freshGain)}s
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, whiteSpace: 'nowrap' }} title="Laps remaining in the race">LAPS LEFT</div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 11 }}>{lapsRemaining}</div>
        </div>
      </div>

      {/* Verdict */}
      <div style={{
        padding: '6px 10px',
        background: ahead ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
        border: `1px solid ${ahead ? '#22c55e55' : '#ef444455'}`,
        borderRadius: 4,
        marginBottom: 6,
        fontSize: 10,
      }}>
        <div style={{ color: ahead ? '#22c55e' : '#ef4444', fontWeight: 800, marginBottom: 2 }}>
          {ahead ? '✓ AHEAD AFTER BOTH STOPS' : '✗ BEHIND AFTER BOTH STOPS'}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.7)' }}>
          Best pit lap: <b style={{ color: '#fff' }}>L{best.inLap}</b> → {effectiveFocus}{' '}
          <b style={{ color: ahead ? '#22c55e' : '#ef4444' }}>
            {ahead ? 'ahead' : 'behind'} by {Math.abs(best.gap).toFixed(2)}s
          </b>
          {' '}at the end of L{best.horizonLap} ({best.change >= 0 ? 'gains' : 'loses'} {Math.abs(best.change ?? 0).toFixed(2)}s on now).
        </div>
      </div>

      {/* Rival's stop: likely (survival) or chosen */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 9, color: 'rgba(255,255,255,0.55)', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, letterSpacing: '0.05em' }}>RIVAL STOPS</span>
        <select
          value={rivalStopLap ?? ''}
          onChange={(e) => setRivalStopLap(e.target.value === '' ? null : Number(e.target.value))}
          disabled={rivalStop.source === 'in progress'}
          title="The rival's in-lap, in every row: its likely stop (the lap its set reaches the median life of its compound given the age it has reached) or a lap chosen here"
          style={{
            background: 'rgba(255,255,255,0.06)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 3, fontSize: 9, padding: '0 2px',
          }}
        >
          <option value="" style={{ color: '#000' }}>likely</option>
          {stopChoices.map((l) => <option key={l} value={l} style={{ color: '#000' }}>L{l}</option>)}
        </select>
        <span title={`Source: ${STOP_SOURCE[rivalStop.source] || rivalStop.source}`}>
          {rivalStopText} · {STOP_SOURCE[rivalStop.source] || rivalStop.source}
        </span>
      </div>

      {/* Sweep table header + legend */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, marginBottom: 4, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', fontWeight: 700, letterSpacing: '0.05em' }}>
          PIT-LAP SWEEP · gap at the end of L{best.horizonLap}, both stopped in every row
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
          const isBest = r.inLap === best.inLap;
          const pct = (Math.abs(r.gap) / maxAbsGap) * 50;
          const color = r.gap > 0 ? '#22c55e' : '#ef4444';
          return (
            <div
              key={r.inLap}
              data-inlap={r.inLap}
              title={`${effectiveFocus} in-lap L${r.inLap}, ${rival} ${rivalStop.inRace ? `in-lap L${rivalStop.inLap}` : 'no stop'}: `
                + `${effectiveFocus} ${r.gap > 0 ? 'ahead' : 'behind'} by ${Math.abs(r.gap).toFixed(2)} s at the end of L${r.horizonLap}`}
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
                {r.k === 0 ? 'NOW' : `L${r.inLap}`}
              </span>
              <div style={{ position: 'relative', height: 12 }}>
                <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.15)' }} />
                <div style={{
                  position: 'absolute',
                  top: 1,
                  bottom: 1,
                  left: r.gap > 0 ? '50%' : `${50 - pct}%`,
                  width: `${pct}%`,
                  background: color,
                  borderRadius: 2,
                  opacity: isBest ? 1 : 0.75,
                }} />
              </div>
              <span style={{ fontWeight: 800, fontSize: 10, textAlign: 'right', color }}>
                {fmt(r.gap)}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', marginTop: 6, lineHeight: 1.4 }}>
        {negativeDeg && (
          <div style={{ color: '#f5a623' }}>
            {degradation.focus.source === 'race' ? 'This race\'s' : 'The prior\'s'} {analysis.focusTyre.compound} degradation is
            {' '}{perLap(degradation.focus.mean)} s/lap so far (fuel-corrected): the model makes a new set slower than the current one.
          </div>
        )}
        Lap model of the race simulation: {analysis.focusTyre.compound} {perLap(degradation.focus.mean)} s/lap
        ({degradation.focus.source === 'race' ? `${degradation.focus.n} stints of this race` : 'prior'}),
        new set {analysis.nextCompound}, fresh-tyre delta {freshText} on the first flying lap; paces and pit
        loss of the Circle of Doom pit window. Every row is read at the end of L{best.horizonLap}, so the two
        cars' pace difference counts the same in every row and the rows differ only by the tyres; with no traffic
        the best lap is the one that balances the wear of the two sets up to that lap. No traffic, no safety car;
        the rival stops once, as shown.
      </div>
    </div>
  );
}
