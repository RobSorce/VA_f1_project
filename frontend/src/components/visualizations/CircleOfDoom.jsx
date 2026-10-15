/**
 * Circle of Doom: one lap drawn as a circle measured in SECONDS. The top is
 * the timing line and the cars move clockwise, so the angle between two cars
 * is their time gap. Click a car to focus it: its "pit now" window (purple
 * band from the car back to the predicted rejoin point, hatched p10-p90 arc of
 * the pit loss) and the probability of each rejoin position.
 * Geometry and analytics come from utils/circleOfDoom.js (pure module, see its
 * header for the rules); this file only draws them.
 *
 * Clock. sessionNow (hooks/useSessionNow) = replay frame.t + sessionTimeOffset,
 * session seconds, the time base of the lap table (utils/raceTime.js header).
 * The analytics (estimatePitLoss, circleState, pitWindow, rejoinDistribution:
 * rank, threshold lists, traffic flag at the predicted rejoin, position and
 * traffic probabilities) are memoised on circleStateKey / circleMemoKey: they
 * run again only when a lap or a pit event completes, a track-status period
 * starts or ends, a car on lap 1 passes a timing point, the focus changes or
 * the pit loss changes. Every replay frame only moves the cars (phaseAt) and
 * the band, which follows the focus car, and reads the lapped traffic inside
 * the band off the ring as drawn (ringRelations): no rank or draw is repeated,
 * and the traffic mark never changes between two events.
 *
 * Slot. The view lays itself out from the size of its slot (panelLayout): the
 * legend in a grid under the plot or beside it, whichever leaves the larger
 * ring, and the plot sized explicitly from what is left, so the drawing never
 * depends on a measurement of its own content.
 *
 * Drawing. D3 v7 builds the geometry (d3.arc for the band, the uncertainty arc
 * and the gap arc, d3.format) and the tooltip (a d3 selection on body, as in
 * RaceSituationMap); React renders the marks from it. The drawing is therefore
 * in the DOM from the first render (server rendering included, which the view
 * tests read) and React never competes with D3 for the same nodes.
 * Labels: utils/circleLabelLayout.js places them around the ring with no two
 * boxes overlapping, inside the slot and clear of the ring; if they do not fit,
 * it tries smaller fonts and, for the rejoin label, other angles near its
 * marker (joined by a leader along the label circle); then the dimmed cars
 * (not relevant to the focus) lose the gap tag of their label (it stays in
 * their tooltip), then the ring shrinks.
 * Inside the pit lane: the centre text at fixed sizes, never below 9 px, every
 * line inside the cars on the pit-lane arc. When the room is too small, whole
 * lines leave the centre by priority (the hint first, then the reference lap,
 * the track status, the neutralised note, the focus result; lap/maxLap and the
 * pit loss with its "(fallback)" last) and are printed on the legend line
 * under the plot instead of being shrunk (one line: lap/maxLap and the pit
 * loss always, the others while they fit); the car tooltip always repeats the
 * track status and the reference lap, and the focus's tooltip its result. The ring never shrinks below what the
 * centre lines need. The hover gap readout is placed nearest the middle of its
 * arc where it clears every centre line (else as one more centre line; else
 * only in the tooltip).
 *
 * Coordination. Click a car = setFocusDriver (click again to clear), hover =
 * setHighlightedDriver. The focus is read by the Track Map, Leaderboard,
 * Timing Tower, PositionByLap and the PCA panel; the highlight by the Track
 * Map, Leaderboard, Timing Tower, Lap Times, Strategy Timeline and the race
 * situation map, among others (not by PositionByLap or the PCA views, which
 * follow focus and selection only). Focus (ring), highlight (dashed ring) and
 * selection (red ring, as the Track Map's selected cars; e.g. a click on the
 * Track Map) set in any other view are drawn here; with a selection and no
 * focus the labels of the other cars are dimmed. With a focus (or a selected
 * car) hovering another car draws the time gap between the two.
 *
 * The shared Legend component draws flat colour swatches only; the legend
 * here draws each mark as it appears on the circle (ring, hatch, inner arc)
 * with the same legend classes.
 *
 * Pit in k laps (Task 4). A stepper in the panel header (k = 0..10, also the
 * [ and ] keys, ignored while typing; useKeyboardShortcuts uses neither) and a
 * "rivals stop" toggle (off by default). utils/undercut.js pitInLaps projects
 * every car from the pit window with the race simulation's lap model
 * (degradation by compound and tyre age, fresh-tyre delta on the first flying
 * lap; raceParams from extractRaceParams at sessionNow) for every k at once,
 * memoised on the circle's memo key, the pit loss and the toggle; the stepper
 * only picks a row. k = 0 is the pit window itself; for k > 0 a dashed ghost
 * diamond marks the projected rejoin and the centre line reads "pits in k:
 * P2 → P8 (−1 vs now)" (places better (+) or worse (−) at the end of that
 * out-lap than when pitting now). k stops at the laps the focus car has left.
 */
import React, {
  useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import * as d3 from 'd3';
import { useF1Store, flagAtClock } from '../../store/useF1Store';
import {
  getDriverColor, markColor, textColor, withAlpha, contextColor, UI_COLORS, TEXT_COLORS, SURFACES, CHART_FONT, chartFontPx,
} from '../../utils/colors';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { pitInLapsKeyStep } from '../../hooks/useKeyboardShortcuts';
import { estimatePitLoss, FALLBACK_PIT_LOSS } from '../../utils/pitLoss';
import { extractRaceParams } from '../../utils/raceSimulation';
import { pitInLaps, PIT_IN_LAPS_MAX } from '../../utils/undercut';
import {
  viewSessionType, isRaceSession, pitLossDisplay,
} from '../../utils/strategyViews';
import {
  circleState, phaseAt, pitWindow, rejoinDistribution, ringRelations, gapSeconds, lapOffset,
  circleStateKey, circleMemoKey, REF_WINDOW_LAPS, TRAFFIC_GAP_S,
} from '../../utils/circleOfDoom';
import {
  layoutLabels, polar, wrapAngle, CHAR_EM,
} from '../../utils/circleLabelLayout';
import { useChartBox } from '../../utils/views/chartBox';
import Panel from '../ui/Panel';

/** Pit-window purple: utils/colors.js UI_COLORS.pitWindow (>= 3:1 as a mark). */
const PIT_WINDOW_COLOR = UI_COLORS.pitWindow;
// Its text colour on the tooltip (>= 4.5:1 on the elevated surface)
const PIT_WINDOW_TEXT = textColor(PIT_WINDOW_COLOR, SURFACES.elevated);
// Ghost of the rejoin for "pit in k laps": the rejoin diamond, hollow and dashed
const GHOST_MARK = {
  fill: withAlpha(PIT_WINDOW_COLOR, 0.12), stroke: PIT_WINDOW_COLOR, strokeWidth: 1.4, strokeDasharray: '2.5 1.5',
};
const TWO_PI = 2 * Math.PI;
const MINUS = '−';
// Size of the first render, before the slot is measured (and in server rendering)
const FALLBACK_SIZE = { width: 520, height: 360 };
// Leader lines of cars not relevant to the focus (or not selected): the
// leader grey (.cod-leader, 2.49:1 on the panel) mixed toward the panel down
// to the mark floor of a context item (contextColor, >= 2:1; at opacity 0.3
// it read 1.25:1, D7); their labels turn to the muted text colour (>= 4.5:1,
// docs/COLOR_ENCODING.md, focus + context)
const LEADER_STROKE = 'rgba(255,255,255,0.28)';
const CONTEXT_LEADER = contextColor(LEADER_STROKE, SURFACES.panel);
// Fixed drawing size (size prop) and wide: legend beside the circle instead of under it
const SIDE_LEGEND_ASPECT = 1.45;
// Ring labels are data: drawn at the data type (CHART_FONT.data, >= 11 px)
// and never shrunk; when the ring is too crowded for every label at that
// size, the labels of the cars that matter least leave (thinLabels), the cars
// stay and a hover brings a label back (V13)
// Legend and legend line as laid out by visualizations.css (.cod-legend,
// .cod-status): the label type, read from its token like the CSS does
const legendFont = () => chartFontPx('label');
const LEGEND_WEIGHT = 500;
const LEGEND_ROW_H = 14;
const LEGEND_ROW_GAP = 1;
const LEGEND_COL_GAP = 4;
// Most legend rows under the plot with the full labels (else the short ones)
const LEGEND_MAX_ROWS = 3;
// padding 2 + swatch 16 + gap 3 + padding 2
const LEGEND_ITEM_EXTRA = 23;
const statusFont = () => chartFontPx('label');
const STATUS_WEIGHT = 600;
const STATUS_LINE_H = 13;
const STATUS_SEP = ' · ';
// Gap between the plot, the legend line and the legend (.cod, .cod__main)
const BLOCK_GAP = 2;
// Legend-line items always shown, on more lines when needed (the others only
// when they fit on its single line; the car tooltip has them all)
const STATUS_ESSENTIAL = new Set(['lap', 'loss']);
// Centre text is never smaller: values (lap, track status, reference lap, pit
// loss, the focus result, the hover gap readout) are data, >= 11 px; the
// italic notes are labels, >= 10 px. A line that does not fit leaves the
// centre for the legend line (the readout for the car tooltip)
const MIN_CENTRE_FONT = 11;
const MIN_CENTRE_NOTE = 10;
// px: a ring held at exactly the radius the centre lines need still holds them
const FIT_EPS = 1e-6;
// Width of a character of the Wide face (weight 900) in em, where the text
// cannot be measured (Formula1-Wide: 1.2-1.4 em per character)
const WIDE_EM = 1.3;
// Ring radius tried, as fractions of the largest that fits, until the labels fit
const RING_SCALES = [1, 0.9, 0.8, 0.7];
// Rejoin label next to the marker: positions with at least this probability
// (%), at most this many (the full distribution is in the tooltip)
const PROBABILITY_LABEL_MIN_PCT = 5;
const PROBABILITY_LABEL_MAX = 4;

// Same labels as the weather bar (track-status codes, raceTime.isGreenLap)
const FLAG_LABELS = {
  '1': 'Track Clear', '2': 'Yellow Flag', '4': 'Safety Car', '5': 'Red Flag', '6': 'VSC', '7': 'VSC Ending',
};
const FLAG_CLASS = {
  '1': 'green', '2': 'yellow', '4': 'neutral', '5': 'red', '6': 'neutral', '7': 'neutral',
};
const UNAVAILABLE_TEXT = {
  'no-reference-lap': 'no pit window before the first lap',
  'race-over': 'race over: no pit window',
  'not-running': 'not running',
  finished: 'finished',
  'chequered-flag': 'chequered flag: no pit window',
  'last-lap': 'no pit window on its last lap',
  'first-lap': 'no pit window before it crosses the line',
  'field-on-lap-one': 'no pit window until every car has passed sector 2',
  'not-applicable': 'race sessions only',
};
// Centre text styles as drawn (visualizations.css): weight, italic,
// letter-spacing (em) and upper case, so its lines are measured as drawn
const CENTRE_STYLE = {
  'cod-centre__lap': { weight: 900, spacing: 0.04 },
  'cod-centre__lap--bold': { weight: 700 },
  'cod-centre__flag': { weight: 700, spacing: 0.06, upper: true },
  'cod-centre__value': { weight: 600 },
  'cod-centre__note': { weight: 400, italic: true },
  'cod-centre__focus': { weight: 700 },
  'cod-centre__warn': { weight: 600 },
};
// Line height of the centre text, in em
const CENTRE_LINE_EM = 1.3;
// The order in which centre items leave a centre too small for them (last =
// first to go; centreItems builds them top to bottom: lap, flag, ref, loss,
// focus, neutral, hint): lap/maxLap and the pit loss stay longest
const CENTRE_PRIORITY = ['gap', 'lap', 'loss', 'focus', 'neutral', 'flag', 'ref', 'hint'];
// Centre lines that step aside for the hover gap readout when it has no room
// (least important first; lap, pit loss and the focus result never do)
const GAP_YIELDS = ['hint', 'refnote', 'ref', 'neutral', 'flag'];
// Hover gap readout: angles tried around the middle of its arc (4 degree steps)
const GAP_ANGLE_STEP = Math.PI / 45;
// Gap kept between the readout and a centre line, px
const GAP_PAD = 2;

const fmt1 = d3.format('.1f');

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Signed seconds of a gap: '+12.3' behind, '−4.0' ahead. */
function signedSeconds(s) {
  if (s == null || !Number.isFinite(s)) return '';
  if (Math.abs(s) < 0.05) return '0.0';
  return s > 0 ? `+${fmt1(s)}` : `${MINUS}${fmt1(-s)}`;
}

/**
 * Traffic at the predicted rejoin, for the tooltip: '0.96 s behind PIA
 * (< 1.0 s)' when flagged, else the nearest car ahead and its gap.
 */
function trafficText(traffic) {
  if (!traffic?.carAhead) return 'no car ahead';
  const laps = traffic.carAheadLaps ? ` (${lapTag(traffic.carAheadLaps)})` : '';
  if (traffic.flag) {
    return `${trafficSeconds(traffic.gapSeconds)} behind ${traffic.carAhead}${laps} (< ${fmt1(TRAFFIC_GAP_S)} s)`;
  }
  return `no: ${traffic.carAhead}${laps} ${trafficSeconds(traffic.gapSeconds)} ahead`;
}

/**
 * Seconds of a traffic gap. A flagged gap (under the 1.0 s threshold) keeps
 * two decimals, rounded down, so it never reads as the threshold ('0.96 s',
 * '0.99 s'; '< 0.01 s' below one hundredth); any other gap one decimal.
 */
function trafficSeconds(s) {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < TRAFFIC_GAP_S) {
    const h = Math.floor(s * 100) / 100;
    return h > 0 ? `${h.toFixed(2)} s` : '< 0.01 s';
  }
  return `${fmt1(s)} s`;
}

/**
 * Places of "pit in k laps" against pitting now (pitInLaps positionsVsNow:
 * + = better at the end of that out-lap): '+1 vs now', '−2 vs now', '= now'.
 */
function placesVsNow(n) {
  if (!n) return '= now';
  return `${n > 0 ? '+' : MINUS}${Math.abs(n)} vs now`;
}

/** Lap tag: 1 -> '1L' (one lap down), -1 -> '−1L' (one lap up). */
function lapTag(k) {
  return k > 0 ? `${k}L` : `${MINUS}${-k}L`;
}

/** m:ss.ss */
function lapClock(seconds) {
  const cs = Math.round(seconds * 100);
  const m = Math.floor(cs / 6000);
  const rest = (cs - m * 6000) / 100;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

/**
 * Whole percentages of `values` (percent, summing to 100) that add up to
 * exactly 100: each value rounded down, the points left over going to the
 * largest remainders (the larger value first on a tie).
 */
function apportionPercent(values) {
  const exact = values.map((v) => Math.round(v * 1e6) / 1e6);
  const out = exact.map((v) => Math.floor(v));
  let left = Math.round(100 - out.reduce((a, b) => a + b, 0));
  const order = exact.map((_, i) => i)
    .sort((a, b) => ((exact[b] - out[b]) - (exact[a] - out[a])) || (exact[b] - exact[a]) || (a - b));
  for (let i = 0; left > 0 && i < order.length; i += 1, left -= 1) out[order[i]] += 1;
  return out;
}

/**
 * Entries of the stacked rejoin label, in position order, e.g. ['P7 40%',
 * 'P10 19%', 'P11 21%', 'P13 20%']: every position with at least 5 % (the 4
 * most likely when more qualify; the 2 most likely when none does), and the
 * rest as 'other n%'. The percentages are apportioned (apportionPercent), so
 * the label adds up to exactly 100 %.
 */
function probabilityEntries(positions) {
  if (!positions?.length) return [];
  const byProb = [...positions]
    .sort((a, b) => (b.probability - a.probability) || (a.position - b.position));
  let shown = byProb.filter((p) => p.probability >= PROBABILITY_LABEL_MIN_PCT / 100)
    .slice(0, PROBABILITY_LABEL_MAX);
  if (!shown.length) shown = byProb.slice(0, 2);
  shown.sort((a, b) => a.position - b.position);
  const rest = Math.max(0, 1 - shown.reduce((sum, p) => sum + p.probability, 0));
  const pcts = apportionPercent([...shown.map((p) => p.probability * 100), rest * 100]);
  const entries = shown.map((p, i) => `P${p.position} ${pcts[i]}%`);
  if (pcts[shown.length] > 0) entries.push(`other ${pcts[shown.length]}%`);
  return entries;
}

/**
 * The most likely rejoin position and the rest, e.g. ['P7 40%', 'other 60%']
 * (apportioned, so it adds up to exactly 100 %); null for a single position.
 */
function compactEntries(positions) {
  if (!positions || positions.length < 2) return null;
  const top = positions.reduce((a, b) => (b.probability > a.probability ? b : a));
  const [p, rest] = apportionPercent([top.probability * 100, (1 - top.probability) * 100]);
  return [`P${top.position} ${p}%`, `other ${rest}%`];
}

/**
 * Line sets the rejoin label may use, preferred first: two entries per line
 * ('P7 40% · P10 19%') with the traffic note on one line, or one entry per line
 * with the note on two (narrower, for the sides of a tall slot); in a slot too
 * small for those, the most likely position and the rest (compact, the full
 * distribution stays in the tooltip), on one line or two.
 */
function rejoinLineSets(entries, traffic, compact = null) {
  const sets = [];
  const add = (lines, trafficOneLine) => {
    const set = lines.map((text) => ({ text, traffic: false }));
    if (traffic) {
      const gap = `traffic ${trafficSeconds(traffic.gapSeconds)}`;
      if (trafficOneLine) set.push({ text: `${gap} behind ${traffic.carAhead}`, traffic: true });
      else set.push({ text: gap, traffic: true }, { text: `behind ${traffic.carAhead}`, traffic: true });
    }
    sets.push(set);
  };
  const pairs = [];
  for (let i = 0; i < entries.length; i += 2) pairs.push(entries.slice(i, i + 2).join(' · '));
  add(pairs, true);
  add(entries, false);
  if (compact) {
    add([compact.join(' · ')], true);
    add(compact, false);
  }
  return sets;
}

/**
 * Line sets of the ghost's label ("pit in k laps", k > 0), preferred first:
 * 'pit in 3: P8 (−1 vs now)' on one line, on two, then 'in 3: P8' alone (the
 * comparison stays in the centre and the tooltip).
 */
function ghostLineSets(k, r) {
  const head = `pit in ${k}: P${r.predictedPosition}`;
  const vs = `(${placesVsNow(r.positionsVsNow)})`;
  return [
    [{ text: `${head} ${vs}`, traffic: false }],
    [{ text: head, traffic: false }, { text: vs, traffic: false }],
    [{ text: `in ${k}: P${r.predictedPosition}`, traffic: false }],
  ];
}

/** Note under the reference lap: which laps its median covers. */
function referenceNote(ref) {
  if (ref?.source === 'fallback') return 'median of completed laps (fallback)';
  if (ref?.source !== 'race' || !ref.laps) return '';
  const [from, to] = ref.laps;
  if (to - from + 1 === REF_WINDOW_LAPS) return `median of last ${REF_WINDOW_LAPS} green laps`;
  return from === to ? `median of green lap ${from}` : `median of green laps ${from}–${to}`;
}

/**
 * Centre items for a ring of radius R, top to bottom: lap/maxLap, track
 * status, reference lap, pit loss, focus result, neutralised note, hint.
 * Each: { key, lines: [{ key, text, cls, size }], narrow (the same on more,
 * shorter lines), status: its chunk on the legend line when it leaves the
 * centre (none for the hint: the car tooltip says it) }. Sizes in px, never
 * below MIN_CENTRE_FONT.
 */
function centreItems(R, {
  currentLap, lapTotal, trackFlag, refLap, pitLoss, focusDriver, win, pitIn = null,
}) {
  const big = clamp(R * 0.12, MIN_CENTRE_FONT, 18);
  const small = clamp(R * 0.075, MIN_CENTRE_FONT, 12);
  const tiny = MIN_CENTRE_NOTE;
  const line = (key, text, cls, size) => ({
    key, text, cls, size,
  });
  const items = [];
  const lapText = `LAP ${currentLap}${lapTotal ? `/${lapTotal}` : ''}`;
  items.push({
    key: 'lap',
    lines: [line('lap', lapText, 'cod-centre__lap', big)],
    // the Wide face takes about twice the room of the Bold one
    narrow: [line('lap', lapText, 'cod-centre__lap cod-centre__lap--bold', big)],
    status: { key: 'lap', text: lapText, cls: 'cod-status__lap' },
  });
  const flagKind = FLAG_CLASS[trackFlag] || 'green';
  const flagText = FLAG_LABELS[trackFlag] || FLAG_LABELS['1'];
  items.push({
    key: 'flag',
    lines: [line('flag', flagText, `cod-centre__flag cod-centre__flag--${flagKind}`, small)],
    status: { key: 'flag', text: flagText, cls: `cod-status__flag cod-status__flag--${flagKind}` },
  });
  const refSeconds = refLap?.seconds ?? null;
  if (refSeconds != null) {
    const refText = `ref lap ${lapClock(refSeconds)}`;
    const note = referenceNote(refLap);
    items.push({
      key: 'ref',
      lines: [line('ref', refText, 'cod-centre__value', small),
        ...(note ? [line('refnote', note, 'cod-centre__note', tiny)] : [])],
      status: { key: 'ref', text: refText, cls: 'cod-status__note' },
    });
  } else {
    const text = 'ring starts when a lap is completed';
    items.push({
      key: 'ref',
      lines: [line('ref', text, 'cod-centre__note', tiny)],
      status: { key: 'ref', text, cls: 'cod-status__note' },
    });
  }
  const loss = pitLossDisplay(pitLoss);
  if (!loss.notApplicable) {
    const head = `pit loss ${fmt1(loss.value)} s`;
    const tail = loss.isFallback ? '(fallback)' : `(${loss.n} stop${loss.n === 1 ? '' : 's'})`;
    const cls = `cod-centre__value${loss.isFallback ? ' cod-centre__value--fallback' : ''}`;
    items.push({
      key: 'loss',
      lines: [line('loss', `${head} ${tail}`, cls, small)],
      narrow: [line('loss', head, cls, small), line('loss2', tail, cls, small)],
      status: { key: 'loss', text: `${head} ${tail}`, cls: `cod-status__value${loss.isFallback ? ' cod-status__value--fallback' : ''}` },
    });
  }
  if (focusDriver && win) {
    if (win.available) {
      let [a, b] = win.ongoingStop
        ? [`${focusDriver} stopping`, `→ P${win.predictedPosition}`]
        : [`${focusDriver} pits now:`, `P${win.currentPosition} → P${win.predictedPosition}`];
      // Pit in k laps (k > 0): the projected place and the places vs pitting now
      if (pitIn?.row && pitIn.k > 0) {
        a = `${focusDriver} pits in ${pitIn.k}:`;
        b = `P${win.currentPosition} → P${pitIn.row.predictedPosition} (${placesVsNow(pitIn.row.positionsVsNow)})`;
      }
      items.push({
        key: 'focus',
        lines: [line('focus', `${a} ${b}`, 'cod-centre__focus', small)],
        narrow: [line('focus', a, 'cod-centre__focus', small), line('focus2', b, 'cod-centre__focus', small)],
        status: { key: 'focus', text: `${a} ${b}`, cls: 'cod-status__focus' },
      });
      if (win.neutralised) {
        const text = 'green-flag pit loss and pace';
        items.push({
          key: 'neutral',
          lines: [line('neutral', text, 'cod-centre__warn', tiny)],
          narrow: [line('neutral', 'green-flag', 'cod-centre__warn', tiny),
            line('neutral2', 'pit loss and pace', 'cod-centre__warn', tiny)],
          status: { key: 'neutral', text, cls: 'cod-status__warn' },
        });
      }
    } else {
      const reason = UNAVAILABLE_TEXT[win.reason] || win.reason;
      items.push({
        key: 'focus',
        lines: [line('focus', `${focusDriver}: ${reason}`, 'cod-centre__note', tiny)],
        narrow: [line('focus', `${focusDriver}:`, 'cod-centre__note', tiny), line('focus2', reason, 'cod-centre__note', tiny)],
        status: { key: 'focus', text: `${focusDriver}: ${reason}`, cls: 'cod-status__note' },
      });
    }
  } else if (!focusDriver && refSeconds != null) {
    items.push({ key: 'hint', lines: [line('hint', 'click a car: pit window', 'cod-centre__note', tiny)], status: null });
  }
  return items;
}

/**
 * Second car of each team (white outline): the team's drivers ordered by car
 * number; from driver_info, else from the lap rows (Team, DriverNumber).
 */
function secondTeamCars(driversInfo, lapTimes) {
  const byTeam = new Map();
  const add = (abbr, team, number) => {
    if (!abbr || !team) return;
    if (!byTeam.has(team)) byTeam.set(team, new Map());
    byTeam.get(team).set(abbr, Number(number));
  };
  if (Array.isArray(driversInfo) && driversInfo.length) {
    for (const d of driversInfo) add(d?.Abbreviation, d?.TeamName, d?.DriverNumber);
  } else {
    for (const r of lapTimes || []) add(r?.Driver, r?.Team, r?.DriverNumber);
  }
  const out = new Set();
  for (const members of byTeam.values()) {
    const order = [...members.entries()].sort((a, b) => {
      const na = Number.isFinite(a[1]) ? a[1] : Infinity;
      const nb = Number.isFinite(b[1]) ? b[1] : Infinity;
      return (na - nb) || a[0].localeCompare(b[0]);
    });
    order.slice(1).forEach(([abbr]) => out.add(abbr));
  }
  return out;
}

/**
 * Width in px of a text as drawn: measured in the real font (measure(text,
 * size, weight, italic)) or, without a canvas, CHAR_EM per character (WIDE_EM
 * for weight 900, the Wide face); plus the letter-spacing.
 */
function textWidth(measure, text, size, {
  weight = 700, italic = false, spacing = 0, upper = false,
} = {}) {
  const t = upper ? text.toUpperCase() : text;
  const base = measure ? measure(t, size, weight, italic) : t.length * size * (weight >= 900 ? WIDE_EM : CHAR_EM);
  return base + spacing * size * t.length;
}

/** Every corner of the box within r of (cx, cy). */
function boxInCircle(box, cx, cy, r) {
  const dx = Math.max(Math.abs(box[0] - cx), Math.abs(box[2] - cx));
  const dy = Math.max(Math.abs(box[1] - cy), Math.abs(box[3] - cy));
  return Math.hypot(dx, dy) <= r;
}

/** The two boxes intersect once each is grown by pad. */
function boxesMeet(a, b, pad = 0) {
  return a[0] - pad < b[2] && b[0] - pad < a[2] && a[1] - pad < b[3] && b[1] - pad < a[3];
}

/**
 * Centre lines stacked around (cx, cy) at their own sizes (px): { key, text,
 * cls, size } -> the same with y and box [x0, y0, x1, y1].
 */
function stackCentre(lines, cx, cy, measure) {
  const heights = lines.map((l) => l.size * CENTRE_LINE_EM);
  let y = cy - heights.reduce((a, b) => a + b, 0) / 2;
  return lines.map((l, j) => {
    const h = heights[j];
    const w = textWidth(measure, l.text, l.size, Object.assign({}, ...l.cls.split(' ').map((c) => CENTRE_STYLE[c] || {})));
    const yc = y + h / 2;
    y += h;
    return {
      ...l, y: yc, box: [cx - w / 2, yc - h / 2, cx + w / 2, yc + h / 2],
    };
  });
}

/** Distance from (cx, cy) to the farthest corner of the box. */
function cornerReach(box, cx, cy) {
  return Math.hypot(Math.max(Math.abs(box[0] - cx), Math.abs(box[2] - cx)),
    Math.max(Math.abs(box[1] - cy), Math.abs(box[3] - cy)));
}

/**
 * Centre items that fit inside the room of radius rInner around (cx, cy), at
 * their fixed sizes: every item on its wide lines, else on its narrow ones
 * (items with `narrow`), else the lowest-priority item leaves (CENTRE_PRIORITY)
 * and the rest are tried again. Items: { key, lines, narrow? }, top to
 * bottom. Returns the placed lines, the items left out and the room the
 * placed lines need (reach, px).
 */
function fitCentre(items, rInner, cx, cy, measure) {
  let kept = [...items];
  const dropped = [];
  for (;;) {
    for (const useNarrow of [false, true]) {
      if (useNarrow && !kept.some((it) => it.narrow)) continue;
      const lines = stackCentre(kept.flatMap((it) => (useNarrow && it.narrow ? it.narrow : it.lines)), cx, cy, measure);
      const reach = Math.max(0, ...lines.map((l) => cornerReach(l.box, cx, cy)));
      if (reach <= rInner) return { lines, dropped, reach };
    }
    const worst = kept.reduce((a, b) => (CENTRE_PRIORITY.indexOf(b.key) > CENTRE_PRIORITY.indexOf(a.key) ? b : a));
    kept = kept.filter((it) => it !== worst);
    dropped.push(worst);
  }
}

/**
 * Ring geometry of a plot of width x height px: car and band sizes, the label
 * font, the largest ring radius R0 that leaves room for the labels, and the
 * inset from the ring to the room inside the cars on the pit-lane arc.
 */
function ringGeometry(width, height, measure) {
  const minSide = Math.min(width, height);
  const carR = clamp(minSide / 70, 3.5, 7);
  const bandHalf = clamp(minSide / 60, 4, 8);
  // the data type: >= 11 px at every size (V13), the token's value in the browser
  const fs0 = chartFontPx('data');
  // room kept beside the ring for a label such as 'VER +88.8'
  const baseLabelW = measure ? measure('VER +88.8', fs0) + 4 : fs0 * CHAR_EM * 9;
  const gapOut = carR + bandHalf + 10;
  const R0 = Math.max(30, Math.min(
    width / 2 - gapOut - baseLabelW - 6,
    height / 2 - gapOut - (fs0 + 2) - 6,
  ));
  // ring -> pit-lane arc (band, car, 5 px) -> room clear of a focus-size car and its ring
  const inset = bandHalf + carR + 5 + carR * 1.35 + 4.5;
  return {
    width, height, cx: width / 2, cy: height / 2, carR, bandHalf, fs0, gapOut, R0, inset,
  };
}

/** Room inside the cars on the pit-lane arc of a ring of radius R. */
function innerRoom(geo, R) {
  return Math.max(8, R - geo.inset);
}

/**
 * Legend grid: the columns that fit in `width` px under the plot (balanced:
 * 9 items in 3 x 3 rather than 4 + 4 + 1), with the full labels while they
 * take at most LEGEND_MAX_ROWS rows, else the short ones; or the columns a
 * `height` px column beside the plot needs (full labels). Sizes as laid out
 * by .cod-legend.
 */
function legendGrid(measure, {
  side, width, height, items = LEGEND_ITEMS,
}) {
  const n = items.length;
  const grid = (short) => {
    const colW = Math.max(...items.map((it) => textWidth(measure, short ? it.short : it.label, legendFont(),
      { weight: LEGEND_WEIGHT }))) + LEGEND_ITEM_EXTRA;
    let cols;
    if (side) {
      const maxRows = Math.max(1, Math.floor((height + LEGEND_ROW_GAP) / (LEGEND_ROW_H + LEGEND_ROW_GAP)));
      cols = Math.ceil(n / maxRows);
    } else {
      cols = clamp(Math.floor((width + LEGEND_COL_GAP) / (colW + LEGEND_COL_GAP)), 1, n);
      cols = Math.ceil(n / Math.ceil(n / cols));
    }
    const rows = Math.ceil(n / cols);
    return {
      side,
      short,
      cols,
      rows,
      w: cols * colW + (cols - 1) * LEGEND_COL_GAP,
      h: rows * LEGEND_ROW_H + (rows - 1) * LEGEND_ROW_GAP,
    };
  };
  const full = grid(false);
  return side || full.rows <= LEGEND_MAX_ROWS ? full : grid(true);
}

/**
 * The legend line: the chunks ({ key, text, cls }) of the centre items that
 * have no room inside the ring, in CENTRE_PRIORITY order, joined by ' · ' on
 * one line of at most `width` px. lap/maxLap and the pit loss are always on
 * it (on a second line, split at spaces, if they must); any other chunk only
 * when it still fits (the car tooltip has them all).
 */
function statusLines(chunks, width, measure) {
  const w = (t) => textWidth(measure, t, statusFont(), { weight: STATUS_WEIGHT });
  const sep = w(STATUS_SEP);
  const lines = [];
  let line = [];
  let used = 0;
  const ordered = [...chunks].sort((x, y) => CENTRE_PRIORITY.indexOf(x.key) - CENTRE_PRIORITY.indexOf(y.key));
  for (const c of ordered) {
    const cw = w(c.text);
    if (used + (line.length ? sep : 0) + cw <= width) {
      used += (line.length ? sep : 0) + cw;
      line.push(c);
    } else if (STATUS_ESSENTIAL.has(c.key)) {
      // on the next line(s), split at its spaces when wider than a line
      if (line.length) lines.push(line);
      line = [];
      used = 0;
      let cur = '';
      for (const word of c.text.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if (cur && w(next) > width) {
          lines.push([{ ...c, text: cur }]);
          cur = word;
        } else {
          cur = next;
        }
      }
      line = [{ ...c, text: cur }];
      used = w(cur);
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

/**
 * Layout of the view in its slot (module header). `cell` = the slot (px):
 * the legend goes under the plot or beside it, whichever leaves the larger
 * ring, and the plot gets the rest; `fixed` = a fixed plot size instead (size
 * prop, first render), the legend beside it when it is wide. The centre items
 * (buildItems(R0), their sizes follow the ring) are fitted inside the room of
 * the largest ring; the ones that do not fit go to the legend line, which
 * takes its height from the plot, and the fit runs again until nothing more
 * moves.
 *
 * @returns {{side: boolean, legend: Object, plotW: number, plotH: number, geo: Object,
 *   centre: {lines: Array<Object>, reach: number}, status: Array<Array<Object>>}}
 */
function panelLayout({
  cell, fixed, measure, buildItems, legendItems = LEGEND_ITEMS,
}) {
  const sides = fixed ? [fixed.width > SIDE_LEGEND_ASPECT * fixed.height] : [false, true];
  let best = null;
  for (const side of sides) {
    let moved = [];
    let out = null;
    for (let i = 0; i <= CENTRE_PRIORITY.length; i += 1) {
      let plotW;
      let plotH;
      let legend;
      if (fixed) {
        ({ width: plotW, height: plotH } = fixed);
        legend = legendGrid(measure, {
          side, width: plotW, height: plotH, items: legendItems,
        });
      } else {
        legend = legendGrid(measure, {
          side, width: cell.width, height: cell.height, items: legendItems,
        });
        plotW = side ? cell.width - legend.w - BLOCK_GAP : cell.width;
        plotH = side ? cell.height : cell.height - legend.h - BLOCK_GAP;
      }
      const status = statusLines(moved.map((it) => it.status), Math.max(40, plotW), measure);
      if (!fixed && status.length) plotH -= status.length * STATUS_LINE_H + BLOCK_GAP;
      const geo = ringGeometry(Math.max(40, plotW), Math.max(40, plotH), measure);
      const items = buildItems(geo.R0).filter((it) => !moved.some((m) => m.key === it.key));
      const centre = fitCentre(items, innerRoom(geo, geo.R0), geo.cx, geo.cy, measure);
      out = {
        side, legend, plotW: geo.width, plotH: geo.height, geo, centre, status,
      };
      const newly = centre.dropped.filter((it) => it.status);
      if (!newly.length) break;
      moved = [...moved, ...newly];
    }
    if (!best || out.geo.R0 > best.geo.R0) best = out;
  }
  return best;
}

/**
 * Place of the hover gap readout inside rInner, clear of the centre lines: the
 * angle nearest the middle of the gap arc (4 degree steps both ways), at the
 * largest radius that fits there. null when no place clears the centre block.
 */
function placeGapText(text, size, {
  cx, cy, rInner, mid, avoid, measure,
}) {
  // + the 3 px outline drawn around the glyphs (.cod-gap-text)
  const w = textWidth(measure, text, size) + 6;
  const h = size * CENTRE_LINE_EM;
  for (let j = 0; j * GAP_ANGLE_STEP <= Math.PI; j += 1) {
    for (const sign of j ? [1, -1] : [1]) {
      const a = mid + sign * j * GAP_ANGLE_STEP;
      for (let r = rInner - Math.min(w, h) / 2; r >= 0; r -= 2) {
        const [x, y] = polar(cx, cy, r, a);
        const box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
        if (!boxInCircle(box, cx, cy, rInner)) continue;
        // further in only comes closer to the centre block
        if (avoid.some((b) => boxesMeet(b, box, GAP_PAD))) break;
        return { x, y, box };
      }
    }
  }
  return null;
}

/** A box moved inside the drawing (only when no layout fits). */
function clampBox(box, width, height) {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const x0 = clamp(box[0], 2, Math.max(2, width - 2 - w));
  const y0 = clamp(box[1], 2, Math.max(2, height - 2 - h));
  return [x0, y0, x0 + w, y0 + h];
}

/**
 * Leader of the rejoin label: radially out from the marker to the label
 * circle, then along it to the label's anchor (SVG path, absolute px).
 */
function rejoinLeaderPath(cx, cy, rFrom, rTo, markerAngle, placed) {
  const [x0, y0] = polar(cx, cy, rFrom, markerAngle);
  const [x1, y1] = polar(cx, cy, rTo, markerAngle);
  let d = `M${x0},${y0}L${x1},${y1}`;
  let delta = wrapAngle(placed - markerAngle);
  if (delta > Math.PI) delta -= TWO_PI;
  if (Math.abs(delta) > 1e-3) {
    const [x2, y2] = polar(cx, cy, rTo, markerAngle + delta);
    d += `A${rTo},${rTo} 0 0 ${delta > 0 ? 1 : 0} ${x2},${y2}`;
  }
  return d;
}

/** Car the hover gap is measured from: the focus, else the first selected car (not the hovered one). */
function gapAnchor(focusDriver, selectedDrivers, highlightedDriver) {
  if (focusDriver && focusDriver !== highlightedDriver) return focusDriver;
  return (selectedDrivers || []).find((d) => d !== highlightedDriver) || null;
}

/** Tooltip on body, shared with the other views' tooltip style. */
function tooltipSelection() {
  return d3.select('body').selectAll('.cod-tooltip').data([0]).join('div')
    .attr('class', 'tooltip cod-tooltip');
}

function showTooltip(event, html) {
  tooltipSelection()
    .html(html)
    .style('left', `${event.clientX + 12}px`)
    .style('top', `${event.clientY - 10}px`)
    .classed('visible', true)
    .style('opacity', 1);
}

function hideTooltip() {
  d3.select('body').selectAll('.cod-tooltip').classed('visible', false).style('opacity', 0);
}

function row(label, value) {
  return `<div class="tooltip-row"><span class="tooltip-label">${label}</span>`
    + `<span class="tooltip-value">${value}</span></div>`;
}

/**
 * Width in px of a text in the font it is drawn with (canvas measureText, the
 * family the element inherits; weight 700, the labels', unless given; italic
 * when asked), or null without a canvas (server rendering: the layout then
 * estimates CHAR_EM per character). Measured again once the web fonts have
 * loaded.
 */
function useTextMeasure(el) {
  const [fontsVersion, setFontsVersion] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    if (!fonts) return undefined;
    let alive = true;
    const bump = () => { if (alive) setFontsVersion((v) => v + 1); };
    fonts.ready.then(bump);
    fonts.addEventListener?.('loadingdone', bump);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', bump);
    };
  }, []);
  return useMemo(() => {
    if (!el || typeof document === 'undefined') return null;
    const ctx = document.createElement('canvas').getContext?.('2d');
    if (!ctx) return null;
    const family = getComputedStyle(el).fontFamily || 'sans-serif';
    const cache = new Map();
    return (text, fontSize, weight = 700, italic = false) => {
      const key = `${fontSize}|${weight}|${italic ? 1 : 0}|${text}`;
      if (!cache.has(key)) {
        ctx.font = `${italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
        cache.set(key, ctx.measureText(text).width);
      }
      return cache.get(key);
    };
  }, [el, fontsVersion]);
}

/** Legend swatch: each mark as drawn on the circle. */
function Swatch({ kind, hatchId }) {
  const car = TEXT_COLORS.muted;
  return (
    <svg className="cod-legend__swatch" width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
      {kind === 'car' && <circle cx="10" cy="6" r="4" fill={car} stroke="rgba(0,0,0,0.55)" strokeWidth="1" />}
      {kind === 'second' && <circle cx="10" cy="6" r="4" fill={car} stroke="#fff" strokeWidth="1.5" />}
      {kind === 'focus' && (
        <>
          <circle cx="10" cy="6" r="3.6" fill={car} />
          <circle cx="10" cy="6" r="5.4" className="cod-focus-ring" />
        </>
      )}
      {kind === 'selected' && (
        <>
          <circle cx="10" cy="6" r="3.4" fill={car} />
          <circle cx="10" cy="6" r="5" className="cod-select-ring" />
        </>
      )}
      {kind === 'band' && <rect x="1" y="2" width="18" height="8" className="cod-pit-window" />}
      {kind === 'rejoin' && <path d="M10,0.8 L15.2,6 L10,11.2 L4.8,6 Z" className="cod-rejoin-marker" />}
      {kind === 'rejoin-ghost' && (
        <>
          <path d="M5.6,1.6 L10,6 L5.6,10.4 L1.2,6 Z" className="cod-rejoin-marker" />
          <path d="M14.4,2.2 L18.2,6 L14.4,9.8 L10.6,6 Z" {...GHOST_MARK} />
        </>
      )}
      {kind === 'uncertainty' && (
        <rect x="1" y="3" width="18" height="6" className="cod-uncertainty" fill={`url(#${hatchId})`} />
      )}
      {kind === 'pit' && (
        <>
          <path d="M1,9 Q10,2 19,9" className="cod-pitlane" />
          <circle cx="10" cy="5.6" r="3.2" fill={car} stroke="rgba(0,0,0,0.55)" strokeWidth="1" />
        </>
      )}
      {kind === 'lapped' && <circle cx="10" cy="6" r="4" fill={car} fillOpacity="0.45" stroke="rgba(0,0,0,0.55)" strokeWidth="1" />}
    </svg>
  );
}

// short: the label in a small slot (the full one stays in the item's title)
const LEGEND_ITEMS = [
  { kind: 'car', label: 'car (team colour)', short: 'car' },
  { kind: 'second', label: '2nd car of team', short: '2nd car' },
  { kind: 'focus', label: 'focus car', short: 'focus' },
  { kind: 'selected', label: 'selected car', short: 'selected' },
  { kind: 'band', label: 'pit window', short: 'pit window' },
  { kind: 'rejoin', label: 'predicted rejoin', short: 'rejoin' },
  { kind: 'uncertainty', label: 'uncertainty p10–p90', short: 'p10–p90' },
  { kind: 'pit', label: 'cars in pit lane', short: 'pit lane' },
  { kind: 'lapped', label: 'lapped (1L)', short: 'lapped (1L)' },
];
// While the stepper is past 0 the ghost is drawn: the rejoin entry shows both
// diamonds (same number of entries, so the legend keeps its size)
const LEGEND_ITEMS_GHOST = LEGEND_ITEMS.map((it) => (it.kind === 'rejoin'
  ? { kind: 'rejoin-ghost', label: 'rejoin: now · in k laps', short: 'rejoin · k' }
  : it));

function CircleLegend({
  hatchId, side, cols, short, items = LEGEND_ITEMS,
}) {
  return (
    <div
      className={`chart-legend cod-legend${side ? ' cod-legend--side' : ''}`}
      style={{ gridTemplateColumns: `repeat(${cols}, max-content)` }}
    >
      {items.map((item) => (
        <div key={item.kind} className="legend-item cod-legend__item" title={item.label}>
          <Swatch kind={item.kind} hatchId={hatchId} />
          <span className="legend-label">{short ? item.short : item.label}</span>
        </div>
      ))}
    </div>
  );
}

function HatchPattern({ id }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
      <rect width="4" height="4" fill={withAlpha(PIT_WINDOW_COLOR, 0.10)} />
      <line x1="0" y1="0" x2="0" y2="4" stroke={PIT_WINDOW_COLOR} strokeWidth="1.6" />
    </pattern>
  );
}

/**
 * @param {Object} [props]
 * @param {{width: number, height: number}} [props.size] - fixed drawing size in px
 *   (exports, tests); laid out from the slot otherwise
 * @param {{width: number, height: number}} [props.slotSize] - size of the slot in px
 *   (tests: the Pit Wall cell at a given viewport); measured otherwise
 * @param {function(string, number, number=, boolean=): number} [props.measureText] -
 *   text width in px (text, font size, weight, italic) instead of the canvas
 *   measurement (tests with the real font metrics)
 * @param {number} [props.pitInK=0] - initial k of the "pit in k laps" stepper (tests, exports)
 */
export default function CircleOfDoom({
  size = null, slotSize = null, measureText = null, pitInK: initialPitInK = 0,
} = {}) {
  const sessionData = useF1Store((s) => s.sessionData);
  const storeTrackStatus = useF1Store((s) => s.trackStatus);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const driversInfo = useF1Store((s) => s.drivers);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  // Pit loss and pit window: race sessions ('R', 'S') only
  const sessionType = useF1Store(viewSessionType);
  const isRace = isRaceSession(sessionType);
  const sessionNow = useSessionNow();
  const sessionTimeOffset = useF1Store((s) => s.sessionTimeOffset);
  // Live mode: the stints still being run (stint-life estimate of "rivals stop")
  const running = useStintsRunning();

  // Pit in k laps: the stepper (k) and the "rivals stop" toggle
  const [pitInK, setPitInK] = useState(initialPitInK);
  const [rivalsStop, setRivalsStop] = useState(false);

  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const hatchId = `cod-hatch-${uid}`;
  const legendHatchId = `cod-hatch-legend-${uid}`;

  const [wrapEl, setWrapEl] = useState(null);
  const [plotEl, setPlotEl] = useState(null);
  // The slot's box, kept up to date by the shared hook of every D3 view (D4:
  // one ResizeObserver, one measure per frame, utils/views/chartBox.js); the
  // wrap element itself is measured (parent: false). null until measured.
  const wrapBox = useChartBox(useMemo(() => ({ current: wrapEl }), [wrapEl]), { parent: false });
  const wrapSize = wrapBox.width > 0 && wrapBox.height > 0 ? wrapBox : null;
  const canvasMeasure = useTextMeasure(plotEl);
  const measure = measureText || canvasMeasure;

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const trackStatus = useMemo(
    () => (storeTrackStatus?.length ? storeTrackStatus : sessionData?.track_status || []),
    [storeTrackStatus, sessionData],
  );
  const secondCars = useMemo(() => secondTeamCars(driversInfo, lapTimes), [driversInfo, lapTimes]);
  // Grid slots (known before the start; 0 = pit lane): order the cars still on lap 1
  const gridPositions = useMemo(() => {
    const out = {};
    for (const r of sessionData?.race_results || []) {
      const g = Number(r?.GridPosition);
      if (r?.Abbreviation && r.GridPosition != null && Number.isFinite(g) && g >= 0) out[r.Abbreviation] = g;
    }
    return out;
  }, [sessionData]);

  // Changes only when a lap, a pit event or a track-status period completes,
  // or a car on lap 1 passes a timing point
  const stateKey = useMemo(
    () => circleStateKey(lapTimes, sessionNow, trackStatus),
    [lapTimes, sessionNow, trackStatus],
  );
  /* eslint-disable react-hooks/exhaustive-deps -- `stateKey` stands for sessionNow */
  const pitLoss = useMemo(
    () => estimatePitLoss(lapTimes, { sessionNow, sessionType }),
    [lapTimes, stateKey, sessionType],
  );
  const state = useMemo(
    () => circleState(lapTimes, { sessionNow, dnfMap, gridPositions, isLiveMode }),
    [lapTimes, stateKey, dnfMap, gridPositions, isLiveMode],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  // Per frame: the cars move with the clock
  const cars = useMemo(
    () => state.cars.map((c) => ({ ...c, ...phaseAt(c, sessionNow, state.refLap) })),
    [state, sessionNow],
  );

  const trackFlag = flagAtClock(trackStatus, lapTimes, sessionNow);
  const memoKey = circleMemoKey(focusDriver, lapTimes, sessionNow, pitLoss, trackStatus);

  // Analytics triggered by the focus: memoised on the focus, completed laps,
  // pit events, track-status events and the pit loss (circleMemoKey), never
  // recomputed by a frame alone
  const analytics = useMemo(() => {
    if (!focusDriver || !isRace) return null;
    const ring = { ...state, sessionNow, cars };
    const opts = { totalLaps: totalRaceLaps || undefined, trackFlag };
    const win = pitWindow(focusDriver, ring, pitLoss, opts);
    const dist = win.available ? rejoinDistribution(focusDriver, ring, pitLoss, opts) : null;
    return { win, dist };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoKey, state, pitLoss, isRace, totalRaceLaps]);

  // Race simulation estimates at sessionNow (degradation by compound,
  // fresh-tyre delta, stint-life survival, tyre changes) for "pit in k laps":
  // only with a focus, recomputed on the circle's events
  /* eslint-disable react-hooks/exhaustive-deps -- `stateKey` stands for sessionNow */
  const raceParams = useMemo(() => {
    if (!focusDriver || !isRace) return null;
    return extractRaceParams(lapTimes, [], trackStatus, currentLap, {
      sessionNow, sessionTimeOffset, sessionType, running, dnfMap,
    });
  }, [focusDriver, isRace, lapTimes, trackStatus, currentLap, stateKey, sessionTimeOffset, sessionType,
    running, dnfMap]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Pit in k laps, every k at once (utils/undercut.js): recomputed on the
  // focus, a lap / pit / track-status event, the pit loss or the toggle; the
  // stepper only picks a row
  const pitInTable = useMemo(() => {
    if (!analytics?.win?.available || !raceParams) return null;
    const ring = { ...state, sessionNow, cars };
    return pitInLaps(focusDriver, ring, pitLoss, raceParams, {
      totalLaps: totalRaceLaps || undefined, trackFlag, rivalsStop,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analytics, raceParams, rivalsStop]);
  const kMax = pitInTable?.available ? pitInTable.kMax : PIT_IN_LAPS_MAX;
  const kShown = Math.min(pitInK, kMax);
  const pitIn = pitInTable?.available && kShown > 0
    ? { k: kShown, row: pitInTable.rows[kShown], table: pitInTable }
    : null;

  // [ and ] step k (pitInLapsKeyStep: not while typing, not with modifiers)
  const kMaxRef = useRef(kMax);
  kMaxRef.current = kMax;
  const stepK = useCallback((d) => {
    setPitInK((k) => clamp(Math.min(k, kMaxRef.current) + d, 0, kMaxRef.current));
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (e) => {
      const d = pitInLapsKeyStep(e, useF1Store.getState(), document.activeElement);
      if (!d) return;
      e.preventDefault();
      stepK(d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepK]);

  // Per frame: the band of the memoised window and the lapped traffic inside
  // it, read off the ring as drawn now; the rank, the traffic flag and the
  // probabilities stay those of the memo key
  const live = useMemo(() => {
    const win = analytics?.win;
    if (!win?.available) return analytics;
    const ring = ringRelations(win, { ...state, sessionNow, cars });
    return ring ? { win: { ...win, ...ring }, dist: analytics.dist } : analytics;
  }, [analytics, state, sessionNow, cars]);

  // Gap or lap tag of every car relative to the focus (labels)
  const focusTags = useMemo(() => {
    const tags = new Map();
    if (!focusDriver || !state.cars.some((c) => c.driver === focusDriver)) return tags;
    for (const c of state.cars) {
      if (c.driver === focusDriver) continue;
      const k = lapOffset(focusDriver, c.driver, state);
      if (k) {
        tags.set(c.driver, lapTag(k));
      } else {
        const g = gapSeconds(focusDriver, c.driver, state);
        tags.set(c.driver, signedSeconds(g));
      }
    }
    return tags;
  }, [state, focusDriver]);

  // Slot layout and centre text: changes with the slot, the focus and the
  // events behind the centre text (lap, track status, pit loss, window), never
  // with the frame alone. Before the slot is measured: a fixed plot.
  const lapTotal = totalRaceLaps || maxLap || null;
  const cell = slotSize || (size ? null : wrapSize);
  const fixed = size || (cell && cell.width > 40 && cell.height > 40 ? null : FALLBACK_SIZE);
  const focusWin = analytics?.win || null;
  const pitInRow = pitIn?.row || null;
  /* eslint-disable react-hooks/exhaustive-deps -- the slot sizes stand for the size objects */
  const panel = useMemo(() => panelLayout({
    cell,
    fixed,
    measure,
    legendItems: pitInRow ? LEGEND_ITEMS_GHOST : LEGEND_ITEMS,
    buildItems: (R) => centreItems(R, {
      currentLap,
      lapTotal,
      trackFlag,
      refLap: state.refLap,
      pitLoss,
      focusDriver,
      win: focusWin,
      pitIn: pitInRow ? { k: kShown, row: pitInRow } : null,
    }),
  }), [cell?.width, cell?.height, fixed?.width, fixed?.height, measure, currentLap, lapTotal, trackFlag,
    state.refLap, pitLoss, focusDriver, focusWin, pitInRow, kShown]);
  /* eslint-enable react-hooks/exhaustive-deps */
  const { plotW: width, plotH: height } = panel;

  const scene = useMemo(() => {
    const win = live?.win;
    const dist = live?.dist;
    const { geo } = panel;
    const {
      carR, bandHalf, fs0, gapOut, R0, cx, cy,
    } = geo;
    const selected = new Set(selectedDrivers || []);

    const focusCar = cars.find((c) => c.driver === focusDriver) || null;
    const windowOn = !!(win?.available && focusCar && focusCar.angle != null);

    // Relevant to the focus: the focus, its neighbours, the cars its stop
    // passes, covers or meets as traffic, and whatever is highlighted or
    // selected. Without a focus, a selection dims the cars not selected.
    const relevant = new Set([highlightedDriver, ...selected].filter(Boolean));
    if (focusCar) {
      relevant.add(focusDriver);
      for (const c of cars) {
        if (c.position != null && focusCar.position != null
          && Math.abs(c.position - focusCar.position) === 1) relevant.add(c.driver);
      }
      if (win?.available) {
        for (const x of win.wouldPassFocus) relevant.add(x.driver);
        for (const x of win.wouldDropBehindFocus) relevant.add(x.driver);
        for (const x of win.trafficOnly) relevant.add(x.driver);
        if (win.traffic?.carAhead) relevant.add(win.traffic.carAhead);
      }
    }
    const dimOn = !!focusCar || selected.size > 0;
    const isDim = (c) => dimOn && !relevant.has(c.driver);

    // Label texts (the same at every ring size); a dimmed car's label may drop its tag
    const tagOf = (c) => {
      if (focusCar) return c.driver === focusDriver ? '' : (focusTags.get(c.driver) || '');
      return c.lapOffsetToLeader > 0 ? lapTag(c.lapOffsetToLeader) : '';
    };
    const onRing = cars.filter((c) => c.angle != null);
    const items = onRing.map((c) => {
      const tag = tagOf(c);
      return { key: c.driver, angle: c.angle, text: tag ? `${c.driver} ${tag}` : c.driver };
    });
    const shortItems = onRing.some((c) => isDim(c) && tagOf(c))
      ? onRing.map((c, i) => (isDim(c) ? { ...items[i], text: c.driver } : items[i]))
      : null;
    let rejoin = null;
    let lineSets = null;
    if (windowOn && pitInRow) {
      // Pit in k laps: the ring's label goes to the ghost (the pit-now
      // probabilities stay in the rejoin marker's tooltip)
      lineSets = ghostLineSets(kShown, pitInRow);
      rejoin = {
        angle: focusCar.angle - TWO_PI * pitInRow.ghostOffset,
        variants: lineSets.map((set) => set.map((l) => l.text)),
      };
    } else if (windowOn) {
      const entries = probabilityEntries(dist?.positions);
      lineSets = rejoinLineSets(entries.length ? entries : [`P${win.predictedPosition}`],
        win.traffic?.flag ? win.traffic : null, entries.length > 2 ? compactEntries(dist?.positions) : null);
      rejoin = {
        angle: focusCar.angle - TWO_PI * win.rejoinOffset,
        variants: lineSets.map((set) => set.map((l) => l.text)),
      };
    }

    // Largest ring whose labels fit (utils/circleLabelLayout.js): full labels
    // and the full rejoin label first, then the dimmed cars' labels without
    // their tag, then the compact rejoin label; never smaller than the ring
    // the centre text needs
    const rFloor = Math.min(R0, panel.centre.reach + geo.inset);
    const fullRejoin = rejoin && { ...rejoin, variants: rejoin.variants.slice(0, 2) };
    const attempts = [[items, fullRejoin]];
    if (shortItems) attempts.push([shortItems, fullRejoin]);
    if (rejoin && rejoin.variants.length > 2) attempts.push([shortItems || items, rejoin]);
    let chosen = null;
    for (const scale of RING_SCALES) {
      const R = Math.max(30, R0 * scale, rFloor);
      if (chosen && R >= chosen.R) continue;
      const rLabel = R + gapOut;
      // outermost mark of the ring: the uncertainty arc, or a ring around a car
      const rClear = R + Math.max(bandHalf + 6, carR * 1.35 + 5.5) + 1;
      for (const [variant, rejoinVariant] of attempts) {
        const layout = layoutLabels(variant, rejoinVariant, {
          width, height, cx, cy, rLabel, rClear, fontSize: fs0, minFontSize: fs0, measure,
        });
        if (!chosen || layout.problems < chosen.layout.problems) {
          chosen = {
            R, rLabel, layout, short: variant === shortItems,
          };
        }
        if (layout.ok) break;
      }
      if (chosen.layout.ok) break;
    }
    // Too crowded at the data type: the labels of the cars that matter least
    // leave until the others fit (focus, hovered, selected and relevant cars
    // first, then by place); their cars stay, a hover brings a label back
    let hiddenLabels = 0;
    if (!chosen.layout.ok) {
      const rank = (it) => {
        const c = onRing.find((x) => x.driver === it.key);
        const tier = it.key === focusDriver ? 0 : it.key === highlightedDriver ? 1 : selected.has(it.key) ? 2
          : !isDim(c) ? 3 : 4;
        return tier * 1000 + (c?.position ?? 999);
      };
      const ordered = [...(shortItems || items)].sort((a, b) => rank(a) - rank(b));
      let thin = null;
      for (const scale of RING_SCALES) {
        const R = Math.max(30, R0 * scale, rFloor);
        const rLabel = R + gapOut;
        const rClear = R + Math.max(bandHalf + 6, carR * 1.35 + 5.5) + 1;
        const at = (k) => layoutLabels(ordered.slice(0, k), rejoin, {
          width, height, cx, cy, rLabel, rClear, fontSize: fs0, minFontSize: fs0, measure,
        });
        let lo = 0;
        let hi = ordered.length - 1;
        let best = at(0).ok ? { k: 0, layout: at(0) } : null;
        while (best && lo < hi) {
          const mid = Math.ceil((lo + hi + 1) / 2);
          const layout = at(mid);
          if (layout.ok) { best = { k: mid, layout }; lo = mid; } else hi = mid - 1;
        }
        if (best && (!thin || best.k > thin.k)) thin = { ...best, R, rLabel };
        if (thin && thin.k >= ordered.length - 1) break;
      }
      if (thin) {
        chosen = { R: thin.R, rLabel: thin.rLabel, layout: thin.layout, short: !!shortItems };
        hiddenLabels = onRing.length - thin.k;
      }
    }
    const { R, rLabel, layout } = chosen;
    const fs = layout.fontSize;
    const rPit = R - bandHalf - carR - 5;

    // Cars
    const drawn = [];
    for (const c of onRing) {
      const isFocus = c.driver === focusDriver;
      const rad = isFocus ? carR * 1.35 : carR;
      const r = c.inPitLane ? rPit : R;
      const [x, y] = polar(cx, cy, r, c.angle);
      const dim = isDim(c);
      drawn.push({
        ...c,
        x,
        y,
        r,
        rad,
        isFocus,
        isHighlighted: c.driver === highlightedDriver,
        isSelected: selected.has(c.driver),
        second: secondCars.has(c.driver),
        lappedByLeader: c.lapOffsetToLeader > 0,
        color: markColor(getDriverColor(c.driver), SURFACES.panel),
        // label text in the driver colour at >= 4.5:1 on the panel
        text: textColor(getDriverColor(c.driver), SURFACES.panel),
        tag: chosen.short && dim ? '' : tagOf(c),
        dim,
      });
    }
    // Draw order: dimmed first, the focus last (on top)
    drawn.sort((a, b) => (Number(b.dim) - Number(a.dim)) || (Number(a.isFocus) - Number(b.isFocus)));
    const carByDriver = new Map(drawn.map((c) => [c.driver, c]));

    // Pit window (focus car)
    let windowMarks = null;
    if (windowOn) {
      const af = focusCar.angle;
      const aRejoin = af - TWO_PI * win.rejoinOffset;
      const a10 = af - TWO_PI * win.rejoinArcOffset[0];
      const a90 = af - TWO_PI * win.rejoinArcOffset[1];
      const arc = d3.arc();
      const [mx, my] = polar(cx, cy, R, aRejoin);
      const set = layout.lines ? lineSets[rejoin.variants.indexOf(layout.lines)] : null;
      windowMarks = {
        band: arc({
          innerRadius: R - bandHalf, outerRadius: R + bandHalf, startAngle: aRejoin, endAngle: af,
        }),
        uncertainty: arc({
          innerRadius: R + bandHalf + 1.5,
          outerRadius: R + bandHalf + 6,
          startAngle: Math.min(a10, a90),
          endAngle: Math.max(a10, a90),
        }),
        marker: { x: mx, y: my, s: carR * 1.35, angle: aRejoin },
        traffic: !!win.traffic?.flag,
        lines: set || [],
        // the label belongs to the ghost while k > 0
        labelOf: pitInRow ? 'ghost' : 'rejoin',
      };
      // Pit in k laps: the ghost of the rejoin, moved back by the time the k
      // laps take the focus beyond k reference laps (pitInLaps ghostOffset)
      if (pitInRow) {
        const aGhost = af - TWO_PI * pitInRow.ghostOffset;
        const [gx, gy] = polar(cx, cy, R, aGhost);
        windowMarks.ghost = {
          x: gx, y: gy, s: carR * 1.35, angle: aGhost, k: kShown, row: pitInRow,
        };
      }
    }

    // Labels at their final angles; leaders from the car (or the rejoin marker)
    const placed = layout.labels.map((l) => {
      const box = layout.ok ? l.box : clampBox(l.box, width, height);
      if (l.rejoin) {
        return {
          ...l,
          box,
          leader: rejoinLeaderPath(cx, cy, R + bandHalf + 6, rLabel - 2, l.markerAngle, l.placed),
        };
      }
      const car = carByDriver.get(l.key);
      return {
        ...l,
        box,
        car,
        from: polar(cx, cy, car.r + car.rad + 1, car.angle),
        to: polar(cx, cy, rLabel - 2, l.placed),
      };
    });

    // Centre text (panelLayout: fixed sizes, inside the room of the ring)
    const rInner = innerRoom(geo, R);
    let centre = panel.centre.lines;

    // Time gap between the hovered car and the focus (or a selected car): its
    // readout where it clears the centre text, else as one more centre line,
    // else only in the tooltip
    let gapMark = null;
    const anchorDriver = gapAnchor(focusDriver, selectedDrivers, highlightedDriver);
    if (anchorDriver && highlightedDriver) {
      const A = carByDriver.get(anchorDriver);
      const B = carByDriver.get(highlightedDriver);
      const g = A && B ? gapSeconds(anchorDriver, highlightedDriver, state) : null;
      if (g != null) {
        // b behind a (g > 0): b is counter-clockwise of a
        const start = g > 0 ? B.angle : A.angle;
        let end = g > 0 ? A.angle : B.angle;
        if (end < start) end += TWO_PI;
        const k = lapOffset(anchorDriver, highlightedDriver, state);
        const rGap = R - bandHalf - 2.5;
        gapMark = {
          path: d3.arc()({
            innerRadius: rGap - 0.75, outerRadius: rGap + 0.75, startAngle: start, endAngle: end,
          }),
          text: `${fmt1(Math.abs(g))} s${k ? ` · ${lapTag(Math.abs(k))}` : ''}`,
          mid: (start + end) / 2,
          a: anchorDriver,
          b: highlightedDriver,
          size: Math.max(MIN_CENTRE_FONT, fs + 1),
        };
        let spot = placeGapText(gapMark.text, gapMark.size, {
          cx, cy, rInner, mid: gapMark.mid, avoid: centre.map((l) => l.box), measure,
        });
        // No room at the data type: the readout of the car the user points at
        // outranks the reference notes; the least important centre lines step
        // aside while it is shown (the car tooltip repeats them)
        for (const key of GAP_YIELDS) {
          if (spot) break;
          const kept = centre.filter((l) => !l.key.startsWith(key));
          if (kept.length === centre.length) continue;
          const restacked = stackCentre(kept.map((l) => ({
            key: l.key, text: l.text, cls: l.cls, size: l.size,
          })), cx, cy, measure);
          const at = placeGapText(gapMark.text, gapMark.size, {
            cx, cy, rInner, mid: gapMark.mid, avoid: restacked.map((l) => l.box), measure,
          });
          if (at) { centre = restacked; spot = at; } else centre = restacked;
        }
        if (!spot) centre = panel.centre.lines;
        if (spot) {
          Object.assign(gapMark, { x: spot.x, y: spot.y, box: spot.box });
        } else {
          const withGap = stackCentre([
            {
              key: 'gap', text: `${gapMark.a}–${gapMark.b} ${gapMark.text}`, cls: 'cod-centre__value', size: gapMark.size,
            },
            ...centre.map((l) => ({
              key: l.key, text: l.text, cls: l.cls, size: l.size,
            })),
          ], cx, cy, measure);
          if (withGap.every((l) => cornerReach(l.box, cx, cy) <= rInner + FIT_EPS)) {
            centre = withGap;
            gapMark.inCentre = true;
          } else {
            gapMark.inTooltip = true;
          }
        }
      }
    }

    return {
      cx,
      cy,
      R,
      rPit,
      rInner,
      bandHalf,
      carR,
      fs,
      drawn,
      placed,
      windowMarks,
      gapMark,
      centre,
      centreFits: centre.every((l) => cornerReach(l.box, cx, cy) <= rInner + FIT_EPS),
      layoutOk: layout.ok,
      hiddenLabels,
    };
  }, [cars, live, panel, width, height, focusDriver, highlightedDriver, selectedDrivers, focusTags,
    secondCars, state, measure, pitInRow, kShown]);

  // Tooltip rows of "pit in k laps" (k > 0): the projected place, against
  // pitting now at the same lap, and the inputs of the lap model
  const pitInRows = useCallback(() => {
    if (!pitIn) return '';
    const { k, row: r, table } = pitIn;
    const dCur = table.degradation?.current;
    const dNext = table.degradation?.next;
    const fresh = table.freshDeltaInfo;
    const degText = (d) => (d
      ? `${d.compound} ${d.mean >= 0 ? '+' : MINUS}${Math.abs(d.mean).toFixed(3)} s/lap (${d.source === 'race' ? `${d.n} stints` : 'prior'})`
      : '—');
    let html = row(`Pit in ${k}`, `in-lap L${r.inLap}, rejoin P${r.predictedPosition} at the end of L${r.targetLap}`)
      + row('Pitting now instead', `P${r.positionIfPitNow} at the end of L${r.targetLap} (${placesVsNow(r.positionsVsNow)}; `
        + `waiting ${r.secondsVsNow >= 0 ? 'costs' : 'gains'} ${fmt1(Math.abs(r.secondsVsNow))} s)`)
      + row('Lap model', `${degText(dCur)} → ${degText(dNext)}`)
      + row('Fresh-tyre delta', fresh
        ? `${fresh.value >= 0 ? '+' : MINUS}${Math.abs(fresh.value).toFixed(3)} s on the first flying lap (${fresh.source === 'race' ? `${fresh.n} stints` : 'prior'})`
        : '—');
    html += row('Other cars', table.rivalsStop
      ? `stop when their sets are due${r.rivalStops.length ? `: ${r.rivalStops.join(', ')}` : ' (none by then)'}`
      : 'no stops (toggle "rivals stop")');
    return html;
  }, [pitIn]);

  // Tooltip content
  const distributionRows = useCallback(() => {
    const win = live?.win;
    const dist = live?.dist;
    if (!win?.available) return '';
    const loss = pitLossDisplay(pitLoss);
    const lossText = loss.isFallback
      ? `${fmt1(loss.value)} s fallback`
      : `${fmt1(loss.value)} s (p10–p90 ${fmt1(win.pitLoss.p10)}–${fmt1(win.pitLoss.p90)} s, ${loss.n} stops)`;
    const method = dist?.method === 'bootstrap'
      ? `bootstrap of ${loss.n} stops`
      : `normal(${FALLBACK_PIT_LOSS.median}, ${FALLBACK_PIT_LOSS.stdDev}) fallback`;
    const probs = (dist?.positions || [])
      .map((p) => `P${p.position} ${(p.probability * 100).toFixed(1)}%`)
      .join(' · ');
    const names = (list) => (list.length ? list.map((x) => x.driver).join(', ') : 'none');
    let html = row('Pit now', `P${win.currentPosition} → P${win.predictedPosition}`)
      + row('Rejoin positions', probs || '—')
      + row('Draws', `${dist?.samples ?? 0}, ${method}`)
      + row('Pit loss', lossText)
      + row('Traffic at the rejoin', trafficText(win.traffic))
      + row('Traffic probability', dist?.trafficProbability != null
        ? `${Math.round(dist.trafficProbability * 100)}%` : '—')
      + row('Gain the place', names(win.wouldPassFocus))
      + row('Within reach', names(win.wouldDropBehindFocus))
      + row('Lapped traffic', win.trafficOnly.length
        ? win.trafficOnly.map((x) => `${x.driver} ${x.label}`).join(', ') : 'none');
    if (win.neutralised) html += row('Track', 'neutralised: green-flag figures');
    html += pitInRows();
    return html;
  }, [live, pitLoss, pitInRows]);

  const carTooltip = useCallback((c) => {
    // A car on lap 1 whose place the data leave open has no position
    const place = c.position != null ? `P${c.position}` : 'lap 1, place not known yet';
    let html = `<div class="tooltip-title" style="color:${c.color}">${c.driver} — ${place}</div>`
      + row('Lap', `${c.finished ? 'finished' : c.lapsCompleted + 1}`)
      + row('Since the line', `${fmt1(c.elapsed)} s${c.saturated ? ' (longer than the ref lap)' : ''}`);
    if (focusDriver && c.driver !== focusDriver && focusTags.get(c.driver)) {
      html += row(`Gap to ${focusDriver}`, `${focusTags.get(c.driver)}${focusTags.get(c.driver).endsWith('L') ? '' : ' s'}`);
    } else if (!focusDriver) {
      // the selected car the hover gap is drawn from
      const anchor = gapAnchor(null, selectedDrivers, c.driver);
      const g = anchor ? gapSeconds(anchor, c.driver, state) : null;
      if (g != null) {
        const k = lapOffset(anchor, c.driver, state);
        html += row(`Gap to ${anchor}`, k ? lapTag(k) : `${signedSeconds(g)} s`);
      }
    }
    if (c.inPitLane) html += row('Status', 'in the pit lane');
    if (c.lappedByLeader) html += row('Lapped', `${c.lapOffsetToLeader} lap${c.lapOffsetToLeader > 1 ? 's' : ''} down on the leader`);
    // Track status and reference lap, also when the centre has no room for them
    html += row('Track', FLAG_LABELS[trackFlag] || FLAG_LABELS['1']);
    const ref = state.refLap;
    if (ref?.seconds != null) {
      const note = referenceNote(ref);
      html += row('Reference lap', `${lapClock(ref.seconds)}${note ? ` (${note})` : ''}`);
    }
    if (c.driver === focusDriver) html += distributionRows();
    else html += '<div class="tooltip-row"><span class="tooltip-label">Click to focus: pit window</span></div>';
    return html;
  }, [focusDriver, focusTags, distributionRows, selectedDrivers, state, trackFlag]);

  // Hide the shared tooltip when the view goes away
  useEffect(() => () => hideTooltip(), []);

  const onCarEnter = (event, c) => {
    setHighlightedDriver(c.driver);
    showTooltip(event, carTooltip(c));
  };
  const onCarMove = (event, c) => showTooltip(event, carTooltip(c));
  const onCarLeave = () => {
    setHighlightedDriver(null);
    hideTooltip();
  };
  const onCarClick = (event, c) => {
    event.stopPropagation();
    setFocusDriver(c.driver);
  };
  const rejoinTooltip = (event) => showTooltip(
    event,
    `<div class="tooltip-title" style="color:${PIT_WINDOW_TEXT}">${focusDriver} pit now</div>${distributionRows()}`,
  );
  const ghostTooltip = (event) => showTooltip(
    event,
    `<div class="tooltip-title" style="color:${PIT_WINDOW_TEXT}">${focusDriver} pits in ${kShown}</div>${pitInRows()}`,
  );

  // Header: the "pit in k laps" stepper ([ and ]) and the "rivals stop" toggle
  const stepBtn = {
    width: 16, height: 16, padding: 0, borderRadius: 3, lineHeight: '14px',
    border: '1px solid rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.06)',
    color: TEXT_COLORS.primary, fontSize: 11, fontWeight: 700, cursor: 'pointer',
  };
  const pitInTitle = focusDriver
    ? `Pit in k laps ([ and ] keys): ${focusDriver} stays out k more laps, then stops; dashed diamond = its projected rejoin. `
      + 'Lap model of the race simulation (degradation by compound and tyre age, fresh-tyre delta), no traffic.'
    : 'Pit in k laps ([ and ] keys): click a car first';
  const headerControls = isRace ? (
    <div className="cod-pitin" title={pitInTitle} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: CHART_FONT.label }}>
      <span style={{ color: TEXT_COLORS.muted, fontWeight: 600, whiteSpace: 'nowrap' }}>pit in</span>
      <button type="button" aria-label="Pit one lap earlier ([)" disabled={kShown <= 0} onClick={() => stepK(-1)} style={stepBtn}>
        {MINUS}
      </button>
      <span className="cod-pitin__k" data-k={kShown} style={{ minWidth: 14, textAlign: 'center', fontWeight: 800, color: TEXT_COLORS.primary }}>
        {kShown}
      </span>
      <button type="button" aria-label="Pit one lap later (])" disabled={kShown >= kMax} onClick={() => stepK(1)} style={stepBtn}>
        +
      </button>
      <button
        type="button"
        className="cod-pitin__rivals"
        aria-pressed={rivalsStop}
        title="Other cars stop when their sets are due: the lap a set reaches the median life of its compound in this race, given the age it has reached (stint-life survival). Off: the other cars do not stop."
        onClick={() => setRivalsStop((v) => !v)}
        style={{
          ...stepBtn,
          width: 'auto',
          padding: '0 4px',
          fontSize: CHART_FONT.label,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          background: rivalsStop ? withAlpha(PIT_WINDOW_COLOR, 0.25) : stepBtn.background,
          borderColor: rivalsStop ? PIT_WINDOW_COLOR : 'rgba(255,255,255,0.45)',
        }}
      >
        rivals
      </button>
    </div>
  ) : null;

  let body = null;
  if (!sessionData) {
    body = <div className="loading-placeholder"><span>No session loaded.</span></div>;
  } else if (!isRace) {
    body = (
      <div className="loading-placeholder">
        <span>The Circle of Doom applies to race sessions only (race or sprint).</span>
      </div>
    );
  } else if (!lapTimes.length) {
    body = <div className="loading-placeholder"><span>No lap data for this session.</span></div>;
  }

  if (body) {
    return (
      <Panel title="Circle of Doom">
        <div className="viz-container">{body}</div>
      </Panel>
    );
  }

  const {
    cx, cy, R, rPit, rInner, bandHalf, carR, fs, drawn, placed, windowMarks, gapMark, centre, centreFits, layoutOk,
    hiddenLabels,
  } = scene;
  const boxAttr = (box) => box.map((v) => v.toFixed(1)).join(',');
  // Laid out from the slot: the plot gets its size explicitly
  const plotStyle = fixed ? undefined : { flex: 'none', width, height };

  return (
    <Panel title="Circle of Doom" controls={headerControls}>
      <div ref={setWrapEl} className={`cod${panel.side ? ' cod--side' : ''}`}>
        <div className="cod__main">
          <div ref={setPlotEl} className="cod__plot" style={plotStyle}>
            <svg
              className="cod__svg"
              data-layout={layoutOk ? 'fits' : 'clamped'}
              data-hidden-labels={hiddenLabels}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="Circle of Doom: one lap in seconds, timing line at the top"
            >
              <defs>
                <HatchPattern id={hatchId} />
              </defs>

              {/* Ring = one reference lap; tick = timing line; inner dashed arc = pit lane */}
              <g className="cod-ring-layer">
                <circle className="cod-ring" cx={cx} cy={cy} r={R} />
                <circle className="cod-pitlane" cx={cx} cy={cy} r={rPit} />
                <line className="cod-line-tick" x1={cx} y1={cy - R - bandHalf - 3} x2={cx} y2={cy - R + bandHalf + 3} />
              </g>

              {windowMarks && (
                <g className="cod-window-layer">
                  <path className="cod-pit-window" d={windowMarks.band} transform={`translate(${cx},${cy})`} />
                  <path
                    className="cod-uncertainty"
                    d={windowMarks.uncertainty}
                    transform={`translate(${cx},${cy})`}
                    fill={`url(#${hatchId})`}
                  />
                </g>
              )}

              {gapMark && (
                <g
                  className="cod-gap-layer"
                  data-gap={`${gapMark.a}-${gapMark.b}`}
                  data-gap-place={gapMark.inCentre ? 'centre' : gapMark.inTooltip ? 'tooltip' : 'ring'}
                >
                  <path className="cod-gap-arc" d={gapMark.path} transform={`translate(${cx},${cy})`} />
                  {!gapMark.inCentre && !gapMark.inTooltip && (
                    <text
                      className="cod-gap-text"
                      x={gapMark.x}
                      y={gapMark.y}
                      fontSize={gapMark.size}
                      data-inner-box={boxAttr(gapMark.box)}
                    >
                      {gapMark.text}
                    </text>
                  )}
                </g>
              )}

              <g className="cod-leader-layer">
                {placed.map((l) => (l.rejoin ? (
                  <path key="leader-rejoin" className="cod-leader cod-leader--rejoin" d={l.leader} />
                ) : (
                  <line
                    key={`leader-${l.key}`}
                    className="cod-leader"
                    x1={l.from[0]}
                    y1={l.from[1]}
                    x2={l.to[0]}
                    y2={l.to[1]}
                    style={l.car.dim ? { stroke: CONTEXT_LEADER } : undefined}
                  />
                )))}
              </g>

              <g className="cod-car-layer">
                {drawn.map((c) => (
                  <g
                    key={c.driver}
                    className={`cod-car${c.isFocus ? ' cod-car--focus' : ''}${c.inPitLane ? ' cod-car--pit' : ''}${c.isSelected ? ' cod-car--selected' : ''}`}
                    data-driver={c.driver}
                    data-pit={c.inPitLane ? 'true' : undefined}
                    transform={`translate(${c.x},${c.y})`}
                    onMouseEnter={(e) => onCarEnter(e, c)}
                    onMouseMove={(e) => onCarMove(e, c)}
                    onMouseLeave={onCarLeave}
                    onClick={(e) => onCarClick(e, c)}
                  >
                    <circle className="cod-car__hit" r={c.rad + 5} />
                    {c.isFocus && <circle className="cod-focus-ring" r={c.rad + 3.5} />}
                    {c.isHighlighted && !c.isFocus && <circle className="cod-highlight-ring" r={c.rad + 3.5} />}
                    {c.isSelected && <circle className="cod-select-ring" r={c.rad + 2} />}
                    <circle
                      className="cod-car__dot"
                      r={c.rad}
                      fill={c.color}
                      fillOpacity={c.lappedByLeader ? 0.45 : 1}
                      stroke={c.second ? '#fff' : 'rgba(0,0,0,0.55)'}
                      strokeWidth={c.second ? 1.5 : 1}
                    />
                  </g>
                ))}
              </g>

              {windowMarks?.ghost && (
                <g
                  className="cod-ghost"
                  data-k={windowMarks.ghost.k}
                  data-position={windowMarks.ghost.row.predictedPosition}
                  transform={`translate(${windowMarks.ghost.x},${windowMarks.ghost.y})`}
                  onMouseEnter={ghostTooltip}
                  onMouseMove={ghostTooltip}
                  onMouseLeave={hideTooltip}
                >
                  <path
                    className="cod-ghost-marker"
                    d={`M0,${-windowMarks.ghost.s} L${windowMarks.ghost.s},0 L0,${windowMarks.ghost.s} L${-windowMarks.ghost.s},0 Z`}
                    {...GHOST_MARK}
                  />
                </g>
              )}

              {windowMarks && (
                <g
                  className="cod-rejoin"
                  transform={`translate(${windowMarks.marker.x},${windowMarks.marker.y})`}
                  onMouseEnter={rejoinTooltip}
                  onMouseMove={rejoinTooltip}
                  onMouseLeave={hideTooltip}
                >
                  {windowMarks.traffic && <circle className="cod-traffic-ring" r={windowMarks.marker.s + 4} />}
                  <path
                    className="cod-rejoin-marker"
                    d={`M0,${-windowMarks.marker.s} L${windowMarks.marker.s},0 L0,${windowMarks.marker.s} L${-windowMarks.marker.s},0 Z`}
                  />
                </g>
              )}

              <g className="cod-label-layer">
                {placed.map((l) => {
                  const [x0, y0, x1, y1] = l.box;
                  const xm = (x0 + x1) / 2;
                  if (l.rejoin) {
                    const lineH = fs + 2;
                    return (
                      <text
                        key="rejoin-label"
                        className="cod-rejoin-label"
                        x={xm}
                        y={y0 + lineH / 2}
                        fontSize={fs}
                        data-box={l.box.map((v) => v.toFixed(1)).join(',')}
                        data-of={windowMarks.labelOf}
                      >
                        {windowMarks.lines.map((line, i) => (
                          <tspan
                            // eslint-disable-next-line react/no-array-index-key -- lines are positional
                            key={i}
                            x={xm}
                            dy={i === 0 ? 0 : lineH}
                            className={line.traffic ? 'cod-rejoin-label__traffic' : undefined}
                          >
                            {line.text}
                          </tspan>
                        ))}
                      </text>
                    );
                  }
                  const c = l.car;
                  return (
                    <text
                      key={`label-${l.key}`}
                      className={`cod-label${c.isFocus ? ' cod-label--focus' : ''}${c.isSelected ? ' cod-label--selected' : ''}${c.dim ? ' cod-label--dim' : ''}`}
                      x={xm}
                      y={(y0 + y1) / 2}
                      fontSize={fs}
                      data-driver={c.driver}
                      data-angle={wrapAngle(l.placed).toFixed(4)}
                      data-box={l.box.map((v) => v.toFixed(1)).join(',')}
                    >
                      <tspan className="cod-label__code" fill={c.dim ? TEXT_COLORS.muted : c.text}>{c.driver}</tspan>
                      {c.tag && <tspan className="cod-label__gap" dx={3}>{c.tag}</tspan>}
                    </text>
                  );
                })}
              </g>

              {/* data-inner-*: the room inside the pit-lane cars and each text box (tests) */}
              <g className="cod-centre" data-inner-r={rInner.toFixed(2)} data-inner-fits={centreFits ? 'true' : 'false'}>
                {centre.map((l) => (
                  <text
                    key={l.key}
                    className={l.cls}
                    x={cx}
                    y={l.y}
                    fontSize={l.size}
                    data-inner-box={boxAttr(l.box)}
                  >
                    {l.text}
                  </text>
                ))}
              </g>
            </svg>
          </div>
          {/* Legend line: the centre lines with no room inside the ring (never shrunk) */}
          {panel.status.length > 0 && (
            <div className="cod-status" style={fixed ? undefined : { width }}>
              {panel.status.map((line, i) => (
                // eslint-disable-next-line react/no-array-index-key -- lines are positional
                <div key={i} className="cod-status__line">
                  {line.map((chunk, j) => (
                    <React.Fragment key={`${chunk.key}-${chunk.text}`}>
                      {j > 0 && <span className="cod-status__sep">{STATUS_SEP}</span>}
                      <span className={chunk.cls} data-status={chunk.key}>{chunk.text}</span>
                    </React.Fragment>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <svg width="0" height="0" className="cod-defs" aria-hidden="true">
          <defs><HatchPattern id={legendHatchId} /></defs>
        </svg>
        <CircleLegend
          hatchId={legendHatchId}
          side={panel.side}
          cols={panel.legend.cols}
          short={panel.legend.short}
          items={pitInRow ? LEGEND_ITEMS_GHOST : LEGEND_ITEMS}
        />
      </div>
    </Panel>
  );
}
