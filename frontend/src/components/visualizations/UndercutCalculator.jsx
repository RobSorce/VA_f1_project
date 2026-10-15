/**
 * Undercut Calculator: for each candidate pit lap of the focus driver, the
 * projected gap to a rival at the flag (every row read at the race end, lead
 * decision D2). The maths is utils/undercut.js undercutSweep (the projection
 * the Circle of Doom's "pit in k laps" uses): the Circle of Doom's pit window
 * (each car's last line crossing and recent pace, the race's pit-loss
 * median), then the engine's lap model (raceSimulation.js: degradation by
 * compound and tyre age, fresh-tyre delta on the first flying lap); the
 * rival's stop is scheduled in every row (its likely stop from the stint-life
 * survival, or a lap chosen here); a stint past the P90 stint length of its
 * compound is charged an extra stop. A lap chosen here is dropped once it is
 * in the rival's past or the rival has changed tyres since (D4). This file
 * only draws it; no model value lives here.
 */
import React, { useMemo, useEffect, useRef, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  driverStyle, tyreColor, tyreLetter, textColor, CHART_FONT, chartFontPx, TEXT_COLORS, GRID_COLORS, STATUS_COLORS,
  withAlpha,
} from '../../utils/colors';
import { extractRaceParams } from '../../utils/raceSimulation';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { FALLBACK_PIT_LOSS, estimatePitLoss } from '../../utils/pitLoss';
import { circleState, circleStateKey } from '../../utils/circleOfDoom';
import { undercutSweep } from '../../utils/undercut';
import {
  causalKey, completedStints, pitLossDisplay, viewSessionType, isRaceSession,
} from '../../utils/strategyViews';
import { drawUndercutSweep } from '../../utils/views/undercutSweepChart';
import { useBoxSize } from '../../utils/views/chartBox';
import { CHART_COLORS, gapColor, chipStyle as tintChip, MINUS } from '../../utils/views/strategyMarks';

// Text of the panel: the palette's neutrals (utils/colors.js), sizes at the
// CSS font tokens (data >= 11 px, labels >= 10 px)
const muted = { color: TEXT_COLORS.secondary };
const label = { color: TEXT_COLORS.secondary, fontWeight: 700, fontSize: CHART_FONT.label };
// Colour of the pit-loss value and of a model caveat (the predicted accent)
const NOTE_COLOR = STATUS_COLORS.predicted;

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

  // The rival's stop chosen here: { lap, stints } (the rival's stint count when
  // chosen, D4) or null = its likely stop (stint-life survival)
  const [rivalChoice, setRivalChoice] = useState(null);
  useEffect(() => { setRivalChoice(null); }, [rival]);

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
      rivalStopLap: rivalChoice?.lap ?? undefined,
      rivalStopStints: rivalChoice?.stints ?? undefined,
    });
  }, [isRace, effectiveFocus, rival, state, pitLoss, raceParams, totalRaceLaps, maxLap, rivalChoice]);
  // A chosen rival stop the replay has moved past (the rival completed that
  // lap, or is stopping now), or made before the rival changed tyres, is no
  // longer a choice (D4): back to its likely stop
  const choiceGone = rivalChoice != null && analysis?.rivalStop != null && analysis.rivalStop.source !== 'chosen';
  useEffect(() => { if (choiceGone) setRivalChoice(null); }, [choiceGone]);

  if (!isRace) {
    return (
      <div style={{ padding: 20, ...muted, fontSize: CHART_FONT.data }}>
        The undercut calculator applies to race sessions only (race or sprint).
      </div>
    );
  }
  if (!effectiveFocus || !rival) {
    return (
      <div style={{ padding: 20, ...muted, fontSize: CHART_FONT.data }}>
        Select a focus driver. Need at least two drivers with data.
      </div>
    );
  }

  const focusStyle = driverStyle(effectiveFocus);
  const rivalStyle = driverStyle(rival);
  const pitLossInfo = pitLossDisplay(pitLoss);

  const chipStyle = (mark) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 6px', borderRadius: 4,
    background: withAlpha(TEXT_COLORS.primary, 0.06),
    border: `1px solid ${mark}`,
  });
  // The set on the car now (driverStateAt, R6: the new set from the pit exit):
  // the compound letter (the colour is never the only cue), tyre age
  const tyreTag = (tyre) => (tyre?.current ? (
    <span
      title={`${tyre.current.compound}${tyre.current.tyreLife != null ? `, tyre age ${tyre.current.tyreLife}` : ''}`}
      style={{ fontSize: CHART_FONT.data, color: textColor(tyreColor(tyre.current.compound)), fontWeight: 700 }}
    >
      {tyreLetter(tyre.current.compound)}·L{tyre.current.tyreLife ?? '?'}
    </span>
  ) : null);

  const header = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
      <div style={chipStyle(focusStyle.mark)}>
        <span style={label}>FOCUS</span>
        <span style={{ fontWeight: 800, color: focusStyle.text, fontSize: CHART_FONT.data }}>{effectiveFocus}</span>
        {tyreTag(analysis?.focusTyre)}
      </div>
      <span style={{ ...muted, fontSize: CHART_FONT.label }}>vs</span>
      <div style={chipStyle(rivalStyle.mark)}>
        <span style={label}>RIVAL</span>
        <select
          value={rival}
          onChange={(e) => setComparisonDriver(e.target.value)}
          aria-label="Rival driver"
          style={{
            background: CHART_COLORS.surface,
            color: rivalStyle.text,
            border: 'none',
            borderRadius: 3,
            fontWeight: 800,
            fontSize: CHART_FONT.data,
            padding: '0 2px',
            cursor: 'pointer',
          }}
        >
          {driverList.filter((d) => d !== effectiveFocus).map((d) => (
            <option key={d} value={d} style={{ background: CHART_COLORS.surface, color: CHART_COLORS.text }}>{d}</option>
          ))}
        </select>
        {tyreTag(analysis?.rivalTyre)}
      </div>
    </div>
  );

  // PIT LOSS cell: the race estimator's median, or the labelled fallback
  const pitLossCell = (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...label, whiteSpace: 'nowrap' }} title="Time lost entering and exiting the pits">PIT LOSS</div>
      <div
        title={pitLossInfo.isFallback
          ? `No valid green-flag stop yet: ${FALLBACK_PIT_LOSS.median} s fallback (an assumption, not data)`
          : `Median of ${pitLossInfo.n} green-flag stops in this race: in-lap + out-lap - 2 x the driver's green-flag median lap`}
        style={{ color: NOTE_COLOR, fontWeight: 800, fontSize: CHART_FONT.data, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {pitLossInfo.value != null ? `${pitLossInfo.value.toFixed(1)}s` : '—'}
        {pitLossInfo.isFallback && (
          <span style={{ marginLeft: 3, fontSize: CHART_FONT.label, fontWeight: 700, ...muted }}>fallback</span>
        )}
      </div>
    </div>
  );

  const kpiGrid = {
    display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, padding: '4px 8px',
    background: withAlpha(TEXT_COLORS.primary, 0.04), borderRadius: 4, marginBottom: 6,
  };

  if (!analysis?.available) {
    const reason = analysis?.reason;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: CHART_FONT.data }}>
        {header}
        <div style={kpiGrid}>
          {pitLossCell}
        </div>
        <div style={{ ...muted, fontSize: CHART_FONT.data }}>
          {UNAVAILABLE[reason] || 'Not enough data to project yet.'}
        </div>
      </div>
    );
  }

  const {
    rows, best, currentGap, rivalStop, freshGain, degradation, freshDeltaInfo, horizon, feasibility,
  } = analysis;
  const atFlag = horizon?.source === 'race-end';
  const horizonText = atFlag ? `the flag (end of L${best.horizonLap})` : `the end of L${best.horizonLap}`;
  const stopsText = (list) => list.map((x) => `L${x.lap} (${x.compound})`).join(', ');
  const lapsRemaining = Math.max(0, (totalRaceLaps || maxLap) - currentLap);
  const ahead = best.gap > 0;
  const verdictColor = gapColor(best.gap);
  const rivalStopText = rivalStop.inLap != null && rivalStop.inRace
    ? `L${rivalStop.inLap}`
    : 'no stop before the flag';
  const negativeDeg = degradation.focus.mean < 0;
  const freshText = freshDeltaInfo
    ? `${perLap(freshDeltaInfo.value)} s (${freshDeltaInfo.source === 'race' ? `${freshDeltaInfo.n} stints of this race` : 'prior of the cached races'}${freshDeltaInfo.clamped ? ', measured slower: 0' : ''})`
    : perLap(analysis.freshDelta);
  const quantilePct = Math.round((feasibility?.quantile ?? 0) * 100);
  // The rival's stop laps the select offers: its lap in progress to the flag
  const nr = state.cars.find((c) => c.driver === rival)?.lapsCompleted ?? currentLap;
  const raceLaps = totalRaceLaps || maxLap || 0;
  const stopChoices = [];
  for (let l = nr + 1; l < raceLaps; l++) stopChoices.push(l);

  // The sweep's columns: x label ("NOW", "L23"), the lap with "+n" when the
  // plan is charged extra stops, the gap and its tooltip
  const sweepRows = rows.map((r) => ({
    key: String(r.inLap),
    label: r.k === 0 ? 'NOW' : `L${r.inLap}`,
    lapText: `${r.k === 0 ? 'NOW' : `L${r.inLap}`}${r.extraStops?.length ? ` +${r.extraStops.length}` : ''}`,
    gap: r.gap,
    extra: r.extraStops?.length || 0,
    title: `${effectiveFocus} in-lap L${r.inLap}${r.extraStops?.length ? ` plus an extra stop at ${stopsText(r.extraStops)} (a stint past its P${quantilePct} length)` : ''}, `
      + `${rival} ${rivalStop.inRace ? `in-lap L${rivalStop.inLap}` : 'no stop'}: `
      + `${effectiveFocus} ${r.gap > 0 ? 'ahead' : 'behind'} by ${Math.abs(r.gap).toFixed(2)} s at the end of L${r.horizonLap}`,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: CHART_FONT.data, overflow: 'hidden' }}>
      {header}

      {/* Inputs summary — 4 KPI cells.
          minWidth:0 on cells lets overflowing text get truncated instead of
          forcing the grid wider than the panel. */}
      <div style={kpiGrid}>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Gap to the rival on the latest lap both have completed (+ = focus ahead)">GAP NOW</div>
          <div
            title={currentGap == null ? 'no lap completed by both yet'
              : `${effectiveFocus} ${currentGap >= 0 ? 'ahead' : 'behind'} by ${Math.abs(currentGap).toFixed(2)} s`}
            style={{ color: gapColor(currentGap), fontWeight: 800, fontSize: CHART_FONT.data, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {fmt(currentGap)}
          </div>
        </div>
        {pitLossCell}
        <div style={{ minWidth: 0 }}>
          <div
            style={{ ...label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title="New-tyre gain: the focus driver's first flying lap on a new set (pitting now) against the same lap on the current set, from the lap model. + = the new set is faster; − = the model makes the new set slower (negative degradation fits so far)"
          >
            NEW-TYRE GAIN
          </div>
          <div style={{ color: gapColor(freshGain), fontWeight: 800, fontSize: CHART_FONT.data }}>
            {perLap(freshGain)}s
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...label, whiteSpace: 'nowrap' }} title="Laps remaining in the race">LAPS LEFT</div>
          <div style={{ color: CHART_COLORS.text, fontWeight: 800, fontSize: CHART_FONT.data }}>{lapsRemaining}</div>
        </div>
      </div>

      {/* Verdict: the words, the check / cross and the sign carry it; the colour repeats it */}
      <div style={{
        padding: '4px 10px',
        ...tintChip(verdictColor, 0.1),
        borderRadius: 4,
        marginBottom: 4,
        fontSize: CHART_FONT.data,
      }}>
        <div style={{ fontWeight: 800, marginBottom: 2 }}>
          {ahead ? '✓ AHEAD AFTER BOTH STOPS' : '✗ BEHIND AFTER BOTH STOPS'}
        </div>
        <div style={{ color: TEXT_COLORS.secondary }}>
          Best pit lap: <b style={{ color: CHART_COLORS.text }}>L{best.inLap}</b> → {effectiveFocus}{' '}
          <b style={{ color: CHART_COLORS.text }}>
            {ahead ? 'ahead' : 'behind'} by {Math.abs(best.gap).toFixed(2)}s
          </b>
          {' '}at {horizonText} ({best.change >= 0 ? 'gains' : 'loses'} {Math.abs(best.change ?? 0).toFixed(2)}s on now)
          {best.extraStops?.length ? `, with an extra stop at ${stopsText(best.extraStops)}` : ''}.
        </div>
      </div>

      {/* Rival's stop: likely (survival) or chosen */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: CHART_FONT.label, ...muted, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, letterSpacing: '0.05em' }}>RIVAL STOPS</span>
        <select
          value={rivalChoice?.lap ?? ''}
          onChange={(e) => setRivalChoice(e.target.value === ''
            ? null
            : { lap: Number(e.target.value), stints: analysis.rivalTyre?.stints ?? null })}
          disabled={rivalStop.source === 'in progress'}
          aria-label="Rival's in-lap"
          title="The rival's in-lap, in every row: its likely stop (the lap its set reaches the median life of its compound given the age it has reached) or a lap chosen here (dropped once the rival has passed that lap or changed tyres)"
          style={{
            background: CHART_COLORS.surface, color: CHART_COLORS.text, border: `1px solid ${GRID_COLORS.rule}`,
            borderRadius: 3, fontSize: CHART_FONT.label, padding: '0 2px',
          }}
        >
          <option value="" style={{ background: CHART_COLORS.surface, color: CHART_COLORS.text }}>likely</option>
          {stopChoices.map((l) => <option key={l} value={l} style={{ background: CHART_COLORS.surface, color: CHART_COLORS.text }}>L{l}</option>)}
        </select>
        <span title={`Source: ${STOP_SOURCE[rivalStop.source] || rivalStop.source}`}>
          {rivalStopText} · {STOP_SOURCE[rivalStop.source] || rivalStop.source}
          {rivalStop.extraStops?.length ? ` · extra stop ${stopsText(rivalStop.extraStops)} (stint past P${quantilePct})` : ''}
        </span>
      </div>

      {/* Sweep header; the D3 column chart below has its own axes and legend */}
      <div style={{ fontSize: CHART_FONT.label, ...muted, fontWeight: 700, letterSpacing: '0.05em', marginBottom: 2 }}>
        PIT-LAP SWEEP · gap at {horizonText}, both plans to the finish
      </div>
      <SweepChart rows={sweepRows} bestKey={String(best.inLap)} focus={effectiveFocus} />

      <div style={{ fontSize: CHART_FONT.label, ...muted, marginTop: 4, lineHeight: 1.35 }}>
        {negativeDeg && (
          <div style={{ color: NOTE_COLOR }}>
            {degradation.focus.source === 'race' ? 'This race\'s' : 'The prior\'s'} {analysis.focusTyre.compound} degradation is
            {' '}{perLap(degradation.focus.mean)} s/lap so far (fuel-corrected): the model makes a new set slower than the current one.
          </div>
        )}
        <span title={'Paces and pit loss of the Circle of Doom pit window. Every column is read at the same lap, so the two cars\' pace '
          + 'difference counts the same in every column and the columns differ only by the tyres; with no traffic the best '
          + 'lap is the one that balances the wear of the two sets over the rest of the race.'}
        >
          Lap model of the race simulation: {analysis.focusTyre.compound} {perLap(degradation.focus.mean)} s/lap
          ({degradation.focus.source === 'race' ? `${degradation.focus.n} stints of this race` : 'prior'}),
          new set {analysis.nextCompound}, fresh-tyre delta {freshText} on the first flying lap. A stint longer than the
          P{quantilePct} stint length of its compound
          ({analysis.focusTyre.compound} {feasibility?.focus?.current} laps, {analysis.nextCompound} {feasibility?.focus?.next})
          is charged an extra stop (+n on the column). No traffic, no safety car; the rival stops as shown.
        </span>
      </div>
    </div>
  );
}

/**
 * The pit-lap sweep as a D3 column chart (utils/views/undercutSweepChart.js)
 * filling the space left in the panel: every candidate lap is a column, so
 * nothing scrolls. The columns are also listed for assistive technology (the
 * chart is an image with a label).
 */
function SweepChart({ rows, bestKey, focus }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const box = useBoxSize(boxRef);
  useEffect(() => {
    if (!svgRef.current || box.width <= 0 || box.height <= 0) return;
    drawUndercutSweep(svgRef.current, {
      rows,
      bestKey,
      width: box.width,
      height: box.height,
      focus,
      colors: {
        ahead: CHART_COLORS.better,
        behind: CHART_COLORS.worse,
        even: CHART_COLORS.neutral,
        text: CHART_COLORS.text,
        muted: CHART_COLORS.muted,
        grid: CHART_COLORS.grid,
        axis: CHART_COLORS.axis,
      },
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
      legendFont: CHART_FONT.data,
      legendFontPx: chartFontPx('data'),
    });
  }, [rows, bestKey, focus, box.width, box.height]);
  return (
    <div ref={boxRef} className="ucs-chart" style={{ flex: 1, minHeight: 90, position: 'relative', overflow: 'hidden' }}>
      <svg ref={svgRef} className="ucs-svg" style={{ display: 'block' }} />
      <ul className="ucs-rows" style={VISUALLY_HIDDEN}>
        {rows.map((r) => (
          <li key={r.key} data-inlap={r.key}>{r.lapText}: {fmt(r.gap)}</li>
        ))}
      </ul>
    </div>
  );
}

// Present to assistive technology, not drawn
const VISUALLY_HIDDEN = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};
