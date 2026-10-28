/**
 * Chart help registry — single source of truth for per-panel help content.
 *
 * Consumed by:
 *   - <OverlayPanel> header `(i)` button → opens <HelpOverlay>.
 *   - Settings → Help & Reference accordion → lists every entry.
 *
 * Each entry:
 *   summary      — one-sentence "what question this chart answers" (≤ 140 chars).
 *   howToRead    — 3–6 bullets on axes, colours, units, interactions.
 *   limitations  — 1–4 bullets on failure modes the user must know.
 *   seeAlso      — related {tabId, label} pairs (opens target chart on click).
 *   docsHref     — optional external doc link.
 *
 * No pit-loss value is hard-coded here: pit loss is measured per race
 * (utils/pitLoss.js); the only number quoted is FALLBACK_PIT_LOSS, the
 * labelled fallback used before the first valid green-flag stop. Every other
 * number is the constant of the module that uses it (imported below), or a
 * prior those modules measured over the cached races
 * (docs/evidence/mc_benchmark.txt, degradation_definition_monza.txt).
 * The lap-time forecast's accuracy numbers are those of its held-out
 * evaluation (docs/evidence/evaluate_forecast.txt, copied in
 * utils/forecast.js FORECAST_EVALUATION). A help text names the method and
 * the script behind a number, never a file path.
 */
import { FALLBACK_PIT_LOSS } from './pitLoss';
import { FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS, OUTLIER_K } from './degradation';
import {
  DEFAULT_NUM_SIMULATIONS, PACE_REF_LAPS, OPTIONAL_STOP_MIN_LAPS_LEFT, PRIORS,
} from './raceSimulation';
import { PIT_IN_LAPS_MAX, UNDERCUT_SWEEP_LAPS, STINT_FEASIBLE_QUANTILE } from './undercut';
import { WHATIF_MARKS, BADGE_INTERVAL_PCT } from './simulationClient';
import {
  PACE_WINDOW_LAPS, REF_WINDOW_LAPS, REF_MIN_SAMPLES, TRAFFIC_GAP_S, DEFAULT_PROBABILITY_SAMPLES,
} from './circleOfDoom';
import { LOW_DATA_FRACTION, LOW_DATA_MIN_LAPS } from './views/degradationViews';
import { FORECAST_LAPS, FORECAST_EVALUATION as EVAL } from './forecast';
import { FIRST_SEASON_WITHOUT_DRS } from './seasons';
import { STATUS_GLYPHS, FONT_FLOOR_PX } from './colors';

const PIT_LOSS_METHOD = 'Pit loss is measured from this race\'s green-flag stops: '
  + 'in-lap + out-lap minus twice the driver\'s green-flag median lap; the median over stops is used.';
const PIT_LOSS_FALLBACK = `Before the first valid green-flag stop a ${FALLBACK_PIT_LOSS.median} s fallback `
  + '(an assumption, not data) is used, shown as "fallback".';
// Fuel effect of the degradation fits (utils/degradation.js), an assumption
const FUEL_ASSUMPTION = `Degradation is fuel-corrected with an assumed fuel effect of ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap `
  + '(not measured: within a stint fuel burn and tyre age grow together, so the data cannot separate them).';
// The lap model the race simulation, the undercut and "pit in k laps" share (utils/raceSimulation.js)
// How the lap model's degradation per compound is estimated (raceSimulation.js raceDegradation)
const DEGRADATION_RULE = 'this race\'s per-stint fits once they span enough clean laps '
  + `(${PRIORS.degradation.SOFT.minFitLaps} SOFT, ${PRIORS.degradation.MEDIUM.minFitLaps} MEDIUM, ${PRIORS.degradation.HARD.minFitLaps} HARD: `
  + 'a shorter fit strays further from its whole stint than the stints of one race differ), combined with the average '
  + `of the ${PRIORS.races} cached races and weighted by how much races and stints differ; the prior alone before that; `
  + 'negative fits are kept';
const LAP_MODEL = 'Lap model of the race simulation: each lap after the pit window\'s horizon costs the degradation of its '
  + `compound per lap of tyre age (${DEGRADATION_RULE}); `
  + 'a new set starts from the pace without the wear the old set had; the fresh-tyre delta (this race\'s, else the prior) '
  + 'falls on the first flying lap; the out-lap counts at the in-lap\'s normal time (the pit loss covers the rest).';
const NUMBER = (v) => v.toLocaleString('en-US');

/**
 * The documents a help entry links to (docsHref): the repository's published
 * branch on GitHub. App.jsx's helpHref links use the same base.
 */
export const DOCS_BASE = 'https://github.com/RobSorce/VA_f1_project/blob/v4/docs/';
// A held-out MAE of the forecast evaluation (utils/forecast.js FORECAST_EVALUATION), seconds
const S3 = (v) => `${v.toFixed(3)} s`;

/**
 * What selecting a lap range does (store setSelectedLapRange: the one range of
 * every view), as the views that read it draw it: words only, no
 * digits, so the PCA help keeps its rule of no number of its own (D9).
 */
export const LAP_RANGE_EFFECTS = 'the Lap Times sheet shows each driver\'s latest lap inside them, the Position Tracker brush '
  + 'and the Strategy Timeline band mark them, Tyre Degradation fits them for the focus driver (a range of five laps '
  + 'or more), Telemetry in laps mode compares up to four of them';

/**
 * Tooltip of a control that selects a lap range (a pit window of the
 * Cross-Race Analysis panel): what the click really does (D9).
 *
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function lapRangeTooltip(start, end) {
  return `Click to select laps ${start}–${end} of the race on screen: ${LAP_RANGE_EFFECTS}.`;
}

export const CHART_HELP = {
  trackmap: {
    title: 'Track Map',
    summary: `Live circuit map with driver dots, sector colours, DRS zones (seasons before ${FIRST_SEASON_WITHOUT_DRS}) and an optional telemetry overlay.`,
    howToRead: [
      'Dots are drivers in their team colour; the second driver of a team in a lighter or darker tint of it (the legend shows each team\'s pair). The focus driver is enlarged.',
      'S1 / S2 / S3 are drawn in reddish purple, yellow and sky blue (told apart under every colour-vision deficiency, CIEDE2000 >= 14.1, cvd_check script); DRS zones have white edges and the label DRS.',
      'Channel overlay (Speed / Throttle / Brake) recolours the track using the focus driver\'s telemetry on the most recent cached lap — auto-fetches if nothing is cached yet. Speed is drawn on the cividis scale (grey = slow, yellow = fast), throttle from grey to sky blue, brake from grey to orange; the low end stays visible on the dark map (no brake and the slowest corners included), and the legend shows the low, middle and high colour.',
      `Shift+S toggles sectors; Shift+D toggles DRS zones (seasons before ${FIRST_SEASON_WITHOUT_DRS}: there is no DRS from that season, so the zones and the toggle are hidden); R / Shift+R rotates the track.`,
      'Telemetry of the focus driver and the selected drivers, bottom-left: a card each on a big map, else a table of the driver, the tyre (compound and laps on the set) and the speed, then the gear, brake, throttle and DRS as the room allows. "+3 cols" in its header counts the columns left out for room, "+2 more" on its last row the drivers past it; the Layers panel names both.',
    ],
    limitations: [
      'Telemetry channels only load for drivers whose car-data has been cached — some rookies or DNFs may be missing.',
      'The sector colours mark the three timing sectors of the circuit (fixed colours): they do not encode lap or sector times.',
    ],
    seeAlso: [
      { tabId: 'telemetry', label: 'Telemetry strip' },
      { tabId: 'sectors', label: 'Sector rankings' },
    ],
  },

  laptimes: {
    title: 'Lap Times',
    summary: 'Timing sheet: each driver\'s sector times, lap time, gap to the fastest lap and tyre, with a lap-range bar to pick laps.',
    howToRead: [
      'One row per driver in running order: the three sector times and the lap time of the driver\'s latest lap (during a replay the lap in progress, its sectors filled in as they are completed), the gap to the fastest lap, the tyre and its laps.',
      `Purple with ${STATUS_GLYPHS.overallBest} = session best, green with ${STATUS_GLYPHS.personalBest} = personal best (F1 timing convention; the glyph repeats the colour). The legend above the sheet lists every colour with its glyph.`,
      'Lap-range bar under the sheet: drag to pick a lap range, click to clear it. It is the same brushed range as the Position Tracker\'s, so a range set in either view is drawn in both: the sheet then shows each driver\'s latest lap inside the range and the title names it, the Tyre Degradation panel fits it for the focus driver (else the first selected one) and the Strategy Timeline shades it.',
      'Click a row to select the driver; hover a row to highlight the driver in the other views.',
      `Double-click a driver's row: that driver becomes the focus and gets the forecast of the next ${FORECAST_LAPS} laps (amber rows at their target laps, named by the method that made it; see Race Prediction).`,
    ],
    limitations: [
      'Laps under SC / VSC or yellow flags show their real times: slow because of the caution, not the pace.',
      'Lap 1, pit in / out laps and non-green laps are kept for context but left out of the brushed degradation fit.',
    ],
    seeAlso: [
      { tabId: 'tiredeg', label: 'Tyre Degradation' },
      { tabId: 'lapdelta', label: 'Lap Delta' },
      { tabId: 'consistency', label: 'Consistency' },
    ],
  },

  lapdelta: {
    title: 'Lap Delta',
    summary: 'Cumulative lap-time delta vs a baseline driver — reads undercut/overcut dynamics at a glance.',
    howToRead: [
      'Y-axis = the driver\'s cumulative race time minus the base driver\'s, lap by lap: up (+) = behind the base driver, down (−) = ahead of him.',
      'A rising line = losing time to the base driver on those laps; a falling line = gaining.',
      'Pit stops appear as discrete jumps the size of the race\'s pit loss (see the per-stop labels in Strategy Timeline).',
      'The compared drivers are the selected ones (else five drivers of the session); hovering a driver in another view keeps his line in full colour, mixes the other lines toward the panel and hides their hatched areas.',
      'Each compared driver is a line in his colour, the second driver of a team dashed; the base driver is the double grey zero line (two thin rails, a style no driver line has), labelled "base: XXX". Orange hatching rising to the right (+) = behind the base driver, blue hatching falling to the right (−) = ahead; every value carries its sign.',
    ],
    limitations: [
      'The base driver is the focus driver (setting the focus sets it); with no focus there is no chart.',
      'Does not account for lapped traffic — a driver held up by blue flags still shows as "losing pace."',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'racepace', label: 'Race Pace Grid' },
    ],
  },

  sectors: {
    title: 'Sectors & Speeds',
    summary: 'Sector times of every driver: the lap in progress (Live), each sector\'s best times ranked (Best) and the speed-trap tops (Top Speeds).',
    howToRead: [
      'Live: one row per driver in running order, the three sector times of the lap in progress (only the sectors already run during a replay), else of the last completed lap.',
      'Best and Top Speeds: one ranked column per sector (S1, S2, S3) or per speed trap (sector 1, sector 2, finish line, speed trap); columns or rows that do not fit are paged, never scrolled.',
      'Times sorted fastest → slowest; the session best in purple with ◆ (the glyph repeats the colour); on the live tab personal bests are green with ●.',
      'Best tab: each sector is a chart of the gap to the session best, drivers in ranking order, a grey bar as long as the gap (one scale per sector, the axis in s under the rows when there is room) and its value next to it (+0.123); the session best has no bar, its time in purple with ◆.',
    ],
    limitations: [
      'Best and Top Speeds are over every completed lap so far (in-laps, out-laps and laps under a safety car included); they ignore stint-level variation.',
    ],
    seeAlso: [
      { tabId: 'trackmap', label: 'Track Map' },
    ],
  },

  tyres: {
    title: 'Tyres',
    summary: 'Tyre Health and Pace Retention of the focus driver in one view: one tab each, or both stacked with Split.',
    howToRead: [
      'Tyre Health: the estimated life of each set lap by lap (see its help).',
      'Pace Retention: each lap as a share of the stint\'s opening pace (see its help).',
      'Split shows the two charts one above the other on the same laps; a tab shows one.',
    ],
    limitations: [
      'Both charts are heuristics of the view, not the degradation fit: for the fitted tyre wear see Tyre Degradation.',
    ],
    seeAlso: [
      { tabId: 'tiredeg', label: 'Tyre Degradation' },
      { tabId: 'tyrehealth', label: 'Tyre Health' },
      { tabId: 'tyremgmt', label: 'Pace Retention' },
    ],
  },

  tiredeg: {
    title: 'Tyre Degradation',
    summary: 'Per-stint linear fit of lap time on tyre life — degradation in s/lap, with the definition every view shares.',
    howToRead: [
      'X-axis = tyre life (laps on the set); Y-axis = lap time. One scatter and one fit line per stint: a stint is one tyre set, so a stop onto the same compound starts a new stint.',
      `The fit uses the clean laps only: lap 1, pit in / out laps, laps not fully green and slow outliers (more than ${OUTLIER_K} robust sigmas above the stint's fit) are drawn as hollow circles and left out. A stint needs ${MIN_FIT_LAPS} clean laps for a fit.`,
      'Two slopes per stint: **fuel-corr.** (the degradation every view uses: raw slope + the fuel effect) and **raw** (the lap-time trend, fuel burn included, often negative on low-degradation tracks).',
      FUEL_ASSUMPTION,
      'A lap range brushed on the Position Tracker or dragged on the Lap Times bar (else a stint, pit window or race event clicked in another view) fits that range only; the replay draws only the laps completed so far.',
      'Dots and fit lines in the compound colour; each stint label carries the compound letter (e.g. "S1 M").',
    ],
    limitations: [
      `The fuel effect is one assumed constant (${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap) for every car and track; a different value shifts every fuel-corrected slope by the difference.`,
      'The fit is linear in tyre life; a late-stint drop-off is averaged into the slope.',
      'Early in a stint (few laps, track still evolving) a fit can be negative: it is kept and shown, not set to 0.',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times (for brushing)' },
      { tabId: 'tyres', label: 'Tyres' },
      { tabId: 'tyrehealth', label: 'Tyre Health' },
    ],
    docsHref: `${DOCS_BASE}DEGRADATION_METHODOLOGY.md`,
  },

  tyrehealth: {
    title: 'Tyre Health',
    // D9: what components/visualizations/TyreHealth.jsx draws and computes
    // (its constants are checked against the source, __tests__/help.texts.test.js)
    summary: 'Estimated tyre life of the focus driver, lap by lap: one curve per stint in the compound colour, from tyre age and pace.',
    howToRead: [
      'One driver: the focus driver, else the first selected. x = lap, y = estimated tyre life in %, 100 % for a new tyre.',
      'One line per stint (tyre set) in the compound colour, with a light fill under it; the bar under the lap axis spans each stint with its compound letter; dashed PIT lines mark the stops, the solid L line the current lap.',
      'The CRITICAL (< 30 %) and WORN (< 60 %) zones are tinted orange and yellow and named on the chart.',
      'Life of a lap = 100 × (1 − (tyre age / max life)^1.6) − 80 × the fraction the lap is slower than the stint\'s best lap, and it never rises again within a stint (running minimum). Max life: SOFT 22, MEDIUM 32, HARD 45, INTERMEDIATE 30, WET 25 laps, or 1.1 × the stint\'s length when the stint ran longer.',
      'Laps slower than 1.4 × the stint\'s median lap (in-laps, safety car) are left out of the curve. Hover a lap for its life, compound and tyre age.',
    ],
    limitations: [
      'A heuristic, not measured wear: the compound lives, the exponent 1.6 and the pace weight 80 are fixed constants of the view, not fitted to this race.',
      'Tyre age and pace only: punctures, graining and a drying or wet track are not modelled.',
      'Completed laps only: the lap in progress has no time yet.',
    ],
    seeAlso: [
      { tabId: 'tiredeg', label: 'Tyre Degradation' },
      { tabId: 'tyremgmt', label: 'Pace Retention' },
    ],
  },

  tyremgmt: {
    title: 'Pace Retention',
    summary: 'How much of its opening pace the focus driver keeps on each set, lap by lap.',
    howToRead: [
      'One driver: the focus driver, else the first selected. x = race lap, y = pace retention in %.',
      'Retention of a lap = the stint\'s opening pace / the lap time × 100, at most 100 %; the opening pace is the median of the stint\'s laps 2 to 4 (its first lap when it has only one), counting only the laps kept below.',
      'Laps slower than 1.4 × the stint\'s median lap (in-laps, safety car) are left out.',
      'One line per stint in the compound colour (the badge below carries its letter); dashed PIT lines mark the stops, the L line the current lap. Hover a lap for its retention, compound and tyre age.',
    ],
    limitations: [
      'Raw lap times: fuel burn (the car gets faster) and track evolution are in the curve, so it understates the tyre loss; it is not the degradation fit.',
      'Doesn\'t separate tyre management from traffic, car setup or fuel saving.',
    ],
    seeAlso: [
      { tabId: 'tiredeg', label: 'Tyre Degradation' },
      { tabId: 'consistency', label: 'Consistency' },
    ],
  },

  consistency: {
    title: 'Consistency',
    summary: 'Lap-to-lap consistency per driver: the scatter of the clean laps around each stint\'s tyre-wear line — cards collapse for overview, expand for detail.',
    howToRead: [
      'σ = residual sigma: each stint gets the same fit as Tyre Degradation (fuel-corrected lap time on tyre life), and σ pools the scatter of the clean laps around those lines. Tyre wear, fuel burn and stops are in the lines, so they do not count as inconsistency.',
      `Clean laps only: lap 1, pit in / out laps, laps not fully green and slow outliers (more than ${OUTLIER_K} robust sigmas above the stint's fit) are left out; a stint needs ${MIN_FIT_LAPS} clean laps.`,
      'Ranked by average clean lap; the Consistent / Inconsistent chip compares σ with the field\'s median σ. Deg = the mean fuel-corrected slope of the driver\'s fitted stints on that compound.',
      'Click the chevron to expand; click the header body to set focus driver.',
      `Drivers who completed fewer laps than ${LOW_DATA_FRACTION} × the most laps completed in the field, rounded down (at least ${LOW_DATA_MIN_LAPS}), get a "LOW DATA" chip: their σ rests on a short race (a retirement), so it is not comparable.`,
      FUEL_ASSUMPTION,
    ],
    limitations: [
      'No σ before a stint has enough clean laps for a fit.',
      'Wet and dry stints are fitted separately, but a changing track within a stint (drying, rain) still widens σ.',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'racepace', label: 'Race Pace Grid' },
    ],
    docsHref: `${DOCS_BASE}DEGRADATION_METHODOLOGY.md`,
  },

  analytics: {
    title: 'Analytics',
    summary: 'PCA biplot of per-(driver, race) feature vectors — lasso a group to compare it with the other rows.',
    howToRead: [
      'Each point is one driver in one cached race; the axes are the first two principal components of standardized pace, sector, consistency, degradation, stint and grid features (pace and sectors relative to the same race\'s field).',
      'Axis labels show the share of the variance each component captures.',
      'Arrows are feature loadings — the direction a point moves when that feature rises.',
      'Filters: all races, the season, or the race of the session on screen (stars). Colour: team, or the finishing class (podium, points, no points).',
      'During a replay of a cached race its stars are its rows at the replay clock (only the laps completed so far, projected on axes fitted without that race), labelled "at lap N" in the shape legend; its result shows once the race has ended. While another session of the weekend is on screen the race has not started and has no stars.',
      'Lasso-select (Shift+drag) a group → the Cross-Race Analysis panel beside the biplot compares it with the other rows (Hedges\' g, its normal-approximation interval, a random baseline with the same mix of rows).',
      `Its Details list the selection's common pit windows; a click on one selects its laps in the race on screen: ${LAP_RANGE_EFFECTS}.`,
    ],
    limitations: [
      'The other races\' points use their whole race; the finishing position is metadata for the colour and the tooltip, never a feature.',
      'PCA assumes linear feature relationships; non-linear patterns (e.g. wet/dry split) are spread across components instead of separated.',
    ],
    seeAlso: [
      { tabId: 'crossrace', label: 'Cross-Race Analysis' },
      { tabId: 'analysis', label: 'Strategy Analysis' },
      { tabId: 'racesituation', label: 'Race Situation Map' },
    ],
    docsHref: `${DOCS_BASE}PCA_METHODOLOGY.md`,
  },

  prediction: {
    title: 'Race Prediction',
    summary: `Focus driver's lap-time forecast (next ${FORECAST_LAPS} laps; double-click a driver) + pit-stop probability + Monte Carlo position projections.`,
    howToRead: [
      `Forecast tab: double-click a driver (Leaderboard, Lap Times, Race Pace Grid) to ask for that driver's next ${FORECAST_LAPS} lap times from the laps completed at the replay clock; each time is drawn at its target lap. The chip names the method that made it: the method with the lowest MAE on the ${EVAL.valRaces} validation races is served, and the MAE beside it is that method's on the ${EVAL.testRaces} held-out test races.`,
      `Held-out test MAE over laps +1..+${FORECAST_LAPS} (${EVAL.source}): LSTM ${S3(EVAL.testMae.lstm)}, last clean lap + compound mean degradation ${S3(EVAL.testMae.compound_mean)}, persistence (next laps = last clean lap) ${S3(EVAL.testMae.persistence)}, per-stint linear extrapolation ${S3(EVAL.testMae.stint_linear)}; the LSTM's error grows from ${S3(EVAL.lstmTestMaeByLap[0])} at lap +1 to ${S3(EVAL.lstmTestMaeByLap[FORECAST_LAPS - 1])} at lap +${FORECAST_LAPS}. Validation MAE, on which the method is chosen: LSTM ${S3(EVAL.valMae.lstm)}, persistence ${S3(EVAL.valMae.persistence)}, compound mean ${S3(EVAL.valMae.compound_mean)}, per-stint linear ${S3(EVAL.valMae.stint_linear)}.`,
      'The LSTM is served only while it has the best validation MAE. When it does not, the chip names the method served instead and the forecast says the LSTM loses (and by how much); it also says so when the LSTM chosen on validation loses on the test races.',
      `Pit probability: a stop within ${FORECAST_LAPS} laps, by the method named beside it. Held-out Brier score: LSTM ${EVAL.pitBrier.lstm}, tyre-age logistic regression ${EVAL.pitBrier.tyre_age_logistic}, base rate ${EVAL.pitBrier.base_rate} (LSTM PR-AUC ${EVAL.lstmPitPrAuc}).`,
      'Optimal pit-lap suggestion + predicted stints (no pit lap without the race distance).',
      `Monte Carlo panel (below): ${NUMBER(DEFAULT_NUM_SIMULATIONS)} race-to-flag runs (seeded: the same race state always gives the same result), run in a background worker. Each row shows the median finishing position (P label: half of the runs finish there or better; gold = P1-P3, i.e. a podium in at least half of the runs, the same statement as the gold "pod" figure), the places gained (▲, blue) or lost (▼, orange) from the current position to that one, and the podium probability; rows are listed by the position shown, then the current race position. Beside the table a D3 chart on one position axis: bars = share of the runs finishing at each position (every position with at least one run), the line under them = the P5–P95 range, filled diamond = the P label, hollow triangle = the current position, dashed rules after P3 and P10 = podium and points places; the legend names every mark. Rows that do not fit the panel are paged (◀ ▶), never scrolled. The Battles tab is a table of the listed pairs (share and badge ●● / ● / ○), the Risks tab a list with the severity glyph (!! high, ! medium, i low).`,
      'Every mark drawn from the runs (P label, its gold, the arrow, the row order, the battle badges, the battles listed, the risk rows) changes only on evidence beyond the Monte Carlo error, never on noise alone: a mark moves when the interval of the share behind it clears its threshold, otherwise it keeps its previous state. The marks drawn once per driver or per pair are judged with intervals that hold for the whole table at once (95 % together, not row by row). The battles listed are those surely among the most likely (fewer rows while pairs are too close to call), two badges (●●), one badge (●), then the others, each in race order.',
      `Monte Carlo inputs, all from the race so far: pace = each driver's last ${PACE_REF_LAPS} clean laps; tyre wear by compound = ${DEGRADATION_RULE}; lap noise = the scatter of the laps around those per-stint fits, pooled over every stint fitted so far (no prior mixed in; few stints early in the race give a rough value, so the header shows n, the clean laps behind it; before the first fit, the cached races' value: dry ${PRIORS.lapNoise.dry.value} s, wet ${PRIORS.lapNoise.wet.value} s); stops = when sets of that compound were changed so far this race (sets still running count as still running), one stop forced in a dry race until two dry compounds are used (none in a sprint, which has no mandatory stop), no optional stop with fewer than ${OPTIONAL_STOP_MIN_LAPS_LEFT} laps left; safety car = episodes so far per lap, pulled toward the average of the ${PRIORS.races} cached races (${PRIORS.safetyCar.episodesPerRace} episode per ${PRIORS.safetyCar.lapsPerRace} laps), shown as "prior" until one happens.`,
      FUEL_ASSUMPTION,
    ],
    limitations: [
      `Accuracy varies with conditions (${EVAL.source}): the LSTM's test MAE per race runs from ${S3(EVAL.lstmRaceMae.low)} to ${S3(EVAL.lstmRaceMae.high)} (${EVAL.lstmRaceMae.highRace}); from a stint on INTERMEDIATE tyres it is ${S3(EVAL.intermediateMae.lstm)}, where compound mean degradation does better (${S3(EVAL.intermediateMae.compound_mean)}).`,
      `The LSTM's pit probabilities above 50 % are over-confident on the test races (the method named beside a probability says whether it is the LSTM's): predicted ${EVAL.lstmPitAbove50.predictedLow}-${EVAL.lstmPitAbove50.predictedHigh}, observed ${EVAL.lstmPitAbove50.observedLow}-${EVAL.lstmPitAbove50.observedHigh}.`,
      'Too few clean laps of the driver at the clock (green, not lap 1, no pit in-lap or out-lap) give no forecast: at the start, right after a stop or under a long safety car the panel shows the reason instead.',
      'Monte Carlo: no traffic or overtaking difficulty (places come from projected race time), weather not forecast (wet compounds stay), a safety car compresses the gaps by the ratio measured on the cached races; each stop is charged a pit loss drawn around this race\'s median (the labelled fallback before the first measured stop).',
    ],
    seeAlso: [
      { tabId: 'strategy', label: 'Strategy Timeline' },
      { tabId: 'simulator', label: 'Strategy Simulator' },
    ],
    docsHref: `${DOCS_BASE}analytics_provenance.md`,
  },

  simulator: {
    title: 'Strategy Simulator',
    summary: 'Monte Carlo race-to-flag simulator — changes a hypothetical strategy and shows the resulting position distribution.',
    howToRead: [
      'Edit the pit-strategy input (add / remove / move a pit stop) and see the result vs baseline.',
      `Both runs (${NUMBER(DEFAULT_NUM_SIMULATIONS)} simulations each) use the same random numbers, so an identical plan differs by exactly 0 and every difference comes from the plan.`,
      'Each planned stop from the lap in progress on is made at the end of its in-lap and charged a pit loss drawn around the race\'s median; stops before it are the race\'s own history.',
      'Tabs: Plan (the custom plan and the actual strategy so far as stint strips, compound colour and letter, on a lap axis with the lap in progress marked; the stint editor; Run), Result (the two cards, then both finishing distributions on one D3 position axis: bars = share of runs per position, line = P5–P95, diamond = the card\'s P label, the median), Compare (the saved plans as a table with their strips, P label and difference). Lists that do not fit are paged, never scrolled.',
      'Delta card: Δ position (baseline expected position minus the plan\'s: positive = the plan finishes higher; the mean of the run-by-run differences, ± its Monte Carlo error), Δ podium and Δ points probability. The baseline is the model\'s own stops, or a plan picked with "vs".',
      `Every mark of the result changes only on evidence beyond the Monte Carlo error, never on noise alone: PLACES GAINED / LOST (and the blue ▲ / orange ▼ of each difference) only when the interval of the run-by-run difference excludes 0, otherwise NO CLEAR CHANGE (or the previous verdict of the same plan while the difference stays on its side); each card's P label is the median finishing position, moved only beyond the same error; with the model's stops as the baseline, the baseline card shows the Race Prediction panel's P label of the driver (the same run). A mark kept only within the error yields to one beyond it: the plan's card takes the position within its error nearest the baseline's, and a verdict kept only by the previous one becomes NO CLEAR CHANGE. The intervals hold for the ${WHATIF_MARKS} marks of a result together (${BADGE_INTERVAL_PCT} % together, not mark by mark).`,
    ],
    limitations: [
      'The other drivers follow the model\'s stops (when their sets are due by this race\'s stint-life estimate); no reactive pit calls.',
      'Same lap model, safety-car model and limits as the Race Prediction Monte Carlo (no traffic, weather not forecast).',
    ],
    seeAlso: [
      { tabId: 'strategy', label: 'Strategy Timeline' },
      { tabId: 'prediction', label: 'Race Prediction' },
    ],
  },

  strategy: {
    title: 'Strategy Timeline',
    summary: 'Strategy timeline (Gantt) — stints, pit stops, predicted stints, PCA pattern rows and the Simulator\'s plan.',
    howToRead: [
      'One row per driver; horizontal bars are stints coloured by compound, one bar per tyre set (FastF1 Stint column; a pit-lane pass without a tyre change, such as a drive-through or the field led through the pits under SC, keeps the set), so two stints on the same compound stay separate.',
      'During replay only what has happened is drawn: a bar covers the laps completed so far, and a new bar appears at the pit exit, when the new set goes on, then grows as its laps complete. STOPS counts tyre changes so far: always the number of bars minus one.',
      'Diamonds mark pit stops (tyre changes), from the pit exit; a dashed outline diamond marks a car in the pit lane right now. The label is that stop\'s pit loss: a plain number when measured (in-lap + out-lap minus twice the driver\'s green-flag median lap), "≈" and the race median when the stop cannot be measured ("est", an estimate), "*" on the fallback ("fallback", before any measured green-flag stop), no number while the stop is being measured. The line under the chart repeats this legend; hover a diamond for details.',
      'Qualifying and practice: the bars are the runs\' tyre sets and stops carry no pit-loss label (pit loss is a race quantity).',
      'Hatched bars: the predicted remaining stints of the focus driver\'s forecast (Race Prediction). A dashed line: the Strategy Simulator\'s plan. Under the drivers, the tyre strategies of a lasso selection on the PCA biplot.',
      'Click a stint: the driver is selected and the stint\'s laps become the lap range of every view; double-click it: the Strategy Simulator starts from that driver\'s strategy so far.',
    ],
    limitations: [
      'The predicted stints are a model estimate of the forecast, not the team\'s plan.',
      'Stops under SC / VSC are not measured (every car is slow, so in-lap + out-lap minus the green median is not a pit loss): they show the green-flag race median, marked "≈" ("est").',
    ],
    seeAlso: [
      { tabId: 'simulator', label: 'Strategy Simulator' },
      { tabId: 'prediction', label: 'Race Prediction' },
    ],
  },

  // The docked / overlay "Strategy Analysis" view: StrategyAnalysis.jsx
  // ("Race Analysis", beside the Race Situation map)
  analysis: {
    title: 'Strategy Analysis',
    summary: 'Race Analysis: insights from the analytical outputs, the field at the replay clock, and for the drivers you select what sets them apart from the field.',
    howToRead: [
      'Two tabs. Insights: cards built from the race projection, the Race Situation features, the lap-time forecast, the degradation fit and the PCA analysis, each with its category glyph, its severity (glyph, colour and word) and a confidence; a card that names drivers says what a click does (→ …): two drivers are both selected, the first (the car behind) becomes the focus and the second the comparison driver of Sector Delta and the Undercut Calculator; one driver becomes the focus.',
      'Analysis, with no driver selected: the field. Overview = the field\'s tyre mix (a strip of cars per compound, letter and count on it); Battles = pairs closing in (gap, pace delta per lap, laps to close; the badge glyph ! imminent ≤ 3 laps, ▶ approaching ≤ 7, → developing); Overtakes = the pairs the Race Prediction panel projects (Monte Carlo pass probability with its badge); Alerts = Pit Window Open (drivers about to pit, ~laps, compound letter), Losing Pace (+ s/lap), On The Move (▲ places gained) and the projection\'s risk alerts. A battle or overtake row selects both drivers (focus on the car behind); a pit-window chip or a risk row makes that driver the focus.',
      'Analysis, with drivers selected (on the Race Situation map, the leaderboard or any view): Summary (compounds, tyre age, pace), Threats (battles of the selection with the cars around it, ▼ threat / ▲ opportunity), Insights (shared pit windows, pace loss, tyre-age gaps) with "What makes this cluster different": one bar per feature, Cohen\'s d of the selection against the rest of the field (+ = higher in the selection; features under 0.2 left out), and Drivers (position, projected finish, compound, pace, trend, pit estimate).',
      'Lists fit the panel and page the rest (◀ ▶), never scroll.',
    ],
    limitations: [
      'Battles, pit windows and pace trends come from the Race Situation features at the replay clock (recent pace, gap, estimated laps to the pit): estimates, not timing data.',
      'Cohen\'s d of a few selected drivers against the field is descriptive, not a significance test.',
    ],
    seeAlso: [
      { tabId: 'racesituation', label: 'Race Situation Map' },
      { tabId: 'prediction', label: 'Race Prediction' },
    ],
  },

  // The Cross-Race Analysis panel of the Analytics tab (PCAAnalysisPanel.jsx),
  // beside the PCA biplot; it has no tab of its own (openTabId)
  crossrace: {
    title: 'Cross-Race Analysis',
    summary: 'Descriptive differences between a lasso selection on the PCA biplot and the other rows — not a significance test.',
    howToRead: [
      'One row per feature: Hedges\' g (selection mean minus the other rows\' mean, in pooled standard deviations, with the small-sample correction), its normal-approximation interval (g plus or minus the normal quantile times the large-sample standard error of g; Method gives the formula), and N of both groups.',
      'Shaded band = the |g| a random selection of the same size and the same mix of rows reaches on average; dashed lines = the threshold a feature must pass to be marked "above random" (after a race: a high percentile of the largest |g| over all features in those random selections, one threshold for all; during a replay, once the race on screen has rows at the replay clock, each feature has its own, the same high percentile of its own random |g|, set so that random selections pass some threshold as rarely as with one threshold for all, because pit stops and stint lengths reach far larger |g| by the mix of rows alone; Method gives it).',
      'During a replay the rows of the race on screen are taken at the replay clock and the other races are whole races: each random selection holds as many rows of each kind as the selection, and the line under N states the mix and the lap. So "above random" for a selection of rows of the race on screen only means above random groups of that race\'s rows (a baseline within the race on screen); after the race, the same selection is compared with random rows of every race.',
      'A row marked "progress-dependent" (pit stops, stint lengths, tyre degradation) compares rows of the race on screen, which count only the laps completed so far, with whole races: the two kinds differ in it whatever the drivers did, so read it against the random baseline, which draws the same mix.',
      'Patterns and Details: the selection\'s tyre strategies, stints and common pit windows (in-laps of tyre changes).',
      'Rows of the race on screen during its replay are taken at the replay clock: a note says so, and their stints and stops end there.',
      'Triggered by a lasso selection on the Analytics biplot.',
      'The g axis is drawn above the strips; features that do not fit are paged (◀ ▶); "Method" holds the explanation of the marks and replaces the rows while open.',
    ],
    limitations: [
      'The selection was drawn on a projection of these same features, so large |g| values are expected by construction: read each value against the random baseline, not against fixed small / medium / large cut-offs.',
      'Small selections give wide intervals and a high threshold. A single selected row (a clicked point) gets no interval: one row has no spread of its own, so its rows say "no interval" and show only g, N and the random baseline. A feature with missing values shows its own N.',
    ],
    seeAlso: [
      { tabId: 'analytics', label: 'Analytics (PCA)' },
    ],
    openTabId: 'analytics',
  },

  racesituation: {
    title: 'Race Situation',
    summary: 'Live PCA of each driver\'s race state, refitted every lap — lasso-select to select those drivers in the other panels.',
    howToRead: [
      'Each dot is a driver at this lap, from position, gap to the leader, recent pace, pace trend, tyre age, stint number and position change (completed laps only), standardized with this lap\'s field.',
      'The two axes span the plane of this lap\'s first two principal components; inside that plane they turn only as much as needed to follow the previous lap (orthogonal Procrustes), so the map does not jump when the two components swap or rotate. During a replay the previous lap\'s axes are those of a replay played from the start, so a lap reached by playing, a lap seek or a step back is drawn on the same axes (a click on the timeline in the middle of a lap refits the map at that moment, so it can be drawn turned or mirrored against the same lap played through). Each axis title gives the share of the variance that axis captures; the line under the lap number gives the plane\'s total.',
      'Arrows are feature loadings drawn from the field average (the crosshair), one per input in the fit: each dot sits at the crosshair plus its standardized features times the arrows (all arrows share one length scale), so the arrows read the dots exactly.',
      'Trails show the dots of the last laps; a dot moves to its new place with a short animation.',
      'Driver colours; focus driver ringed. Lasso selects a subset — a "Clear N selected" action appears when the selection is non-empty.',
      'Each dot is in its driver\'s colour (the second driver of a team in a tint of it); the badge under it is the compound with its letter.',
    ],
    limitations: [
      'Refitted every lap: an axis can change meaning from lap to lap (read its title and the arrows), and a past trail point was drawn on its own lap\'s axes.',
      'Until every driver has enough clean laps the pace is left out of the fit (a note on the map says so).',
    ],
    seeAlso: [
      { tabId: 'analytics', label: 'Analytics (PCA)' },
      { tabId: 'analysis', label: 'Strategy Analysis' },
    ],
  },

  racepace: {
    title: 'Race Pace Grid',
    summary: 'Pace grid — each lap time shaded by its Δ to the driver\'s median clean lap, so fast / slow stints are visible at a glance.',
    howToRead: [
      'Rows = laps, columns = drivers (headers in the driver\'s colour).',
      'Cell colour against the driver\'s median lap: blue = more than 0.3 s faster, white = normal, yellow = 0.5–2 s slower, orange = more than 2 s slower; ◆ purple = session best, ● green = personal best, P / O pink = pit in / out lap; "-" = no clean lap. The legend under the grid lists every colour.',
      'Use to spot stint-long trends — solid blocks of one colour reveal pace deficits or surges.',
      `Double-click a cell: that driver becomes the focus and gets the lap-time forecast of the ${FORECAST_LAPS} laps after that lap (a lap later than the replay's counts as the replay's).`,
    ],
    limitations: [
      'The median is the driver\'s, over the clean laps completed so far (lap 1 and pit laps left out): early in the race it rests on few laps.',
      'Does not distinguish dirty air vs clean air pace.',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'lapdelta', label: 'Lap Delta' },
    ],
  },

  telemetry: {
    title: 'Telemetry',
    summary: 'Car telemetry of a lap: speed, gap, throttle and brake, gear and RPM, for the focus and selected drivers or for several laps.',
    howToRead: [
      'Five stacked charts on one x axis along the lap, in metres (or seconds from the lap start): speed, the GAP to the reference trace, throttle and brake, gear, RPM.',
      'Drivers mode: the focus driver and the selected drivers on the same lap; laps mode: the laps of the lap range (up to four).',
      'Focus driver: throttle in sky blue, brake in orange (not green / red); other traces in their driver colour, the second driver of a team dashed; in laps mode the laps take the series colours and the compared laps are dashed. The legend names every trace; gear is a step line.',
      'GAP chart: the gap of each compared trace to the reference trace (named in the legend rows "+ behind" / "− ahead of"); orange hatching rising to the right (+) = behind it, blue hatching falling to the right (−) = ahead.',
      'Hover for per-channel numeric readouts.',
    ],
    limitations: [
      'Requires cached telemetry for the focus driver on that lap — missing laps show a placeholder.',
    ],
    seeAlso: [
      { tabId: 'trackmap', label: 'Track Map (channel overlay)' },
      { tabId: 'sectordelta', label: 'Sector Delta' },
    ],
  },

  championship: {
    title: 'Championship',
    summary: 'Season standings + weighted-moving-average projection to the season end.',
    howToRead: [
      'A D3 chart of the cumulative points by round and a D3 bar chart of the points so far at the loaded round (team colours; the bar of a teammate carries the teammate dash; the legend above the bars names the teams).',
      'The Predictions button of the chart extends it with a projection to the season end.',
      'Projection (backend, from round 3): the points so far plus the weighted mean of the last 5 rounds\' points (weights 1 to 5, the latest the heaviest) times the rounds left.',
      'Lines in the team colour; the second driver of a team in a tint of it and dashed, a third driver (a reserve) in another tint and dash-dot; a driver of the loaded session keeps the style he has in the other views when he drives for the same team in the championship (a driver who changed team mid-season is coloured by his team at the latest round, and the tooltip of his Standings bar names the change); the projection to season-end is dotted.',
    ],
    limitations: [
      'The weighted mean is simple and does not model upgrades, DNFs, or regulation changes.',
      'The projection is one number per driver: no interval is drawn.',
    ],
    seeAlso: [
      { tabId: 'prediction', label: 'Race Prediction (single race)' },
    ],
  },

  settings: {
    title: 'Settings',
    summary: 'App-level preferences — units, playback speed, appearance, dock customisation.',
    howToRead: [
      'Single-open accordion: click a section to expand, click again to collapse.',
      'The **Dock** section lets you toggle any panel in or out of the bottom bar.',
      'Changes apply immediately; settings persist in localStorage.',
    ],
    limitations: [
      'Theme is currently locked to dark; light-theme tokens exist but are not switchable from the UI.',
    ],
    seeAlso: [],
  },

  compare: {
    title: 'Driver Comparison',
    summary: 'Head-to-head comparison of two drivers — lap-time delta, sectors, consistency side-by-side.',
    howToRead: [
      'Pick two drivers from the two selectors; with the panel empty and two drivers selected, those two are taken. Shift+G opens it in compare mode (C) once two drivers have been clicked in the Leaderboard.',
      'Six sections (gap and lap charts, sectors, top speeds, race summary, tyres) in columns that fit the pane, paged with ◀ ▶. Consistency (σ) is the residual sigma of each driver\'s per-stint fits, as in the Consistency panel.',
      'The better value of each row is blue with ▲; on the gap chart each side is shaded in its driver\'s colour and labelled "A ahead" / "B ahead".',
    ],
    limitations: [
      'Does not normalise for stint phase — comparing an in-lap to a regular lap is your responsibility.',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'lapdelta', label: 'Lap Delta' },
    ],
  },

  positionlaps: {
    title: 'Position Tracker',
    summary: 'Position-per-lap lines for all drivers — classic Formula 1 race-position chart.',
    howToRead: [
      'Y-axis is inverted (P1 at top).',
      'Click a line: that driver becomes the focus (again to clear it) and the other lines turn to context; hover a line for its position, lap, tyre and tyre age.',
      'Each stop is marked on the driver\'s line and starts a new compound segment; the position usually drops at a stop.',
      'Drag across the chart to brush a lap range: it is the same range as the Lap Times bar\'s (either view sets it, both draw it), and Tyre Degradation fits it; a click on the chart or the "LAP a–b" chip clears it.',
      'Line colour = the tyre compound of each stint; a badge with its letter (S M H I W) sits on the first lap and at every stop. The driver code at the end of each line is in the driver\'s colour. Dashed line (PROJECTION toggle) = the focus driver\'s recent position change extrapolated over 5 laps, not a model forecast; purple band (UNDERCUT toggle) = "PIT WINDOW (vs the car ahead)": drawn when the car ahead\'s tyres are at least 3 laps older than the focus driver\'s, from the current lap over as many laps as the age difference (at most 8, ending 5 laps before the flag), in the pit window colour of every view.',
    ],
    limitations: [
      'Uses the Position field at each lap end — in some sessions this lags one lap behind on-track reality.',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'racesituation', label: 'Race Situation' },
    ],
  },

  sectordelta: {
    title: 'Sector Delta',
    summary: 'Sector-by-sector waterfall of the focus driver against a reference driver, lap by lap: where the time is gained or lost.',
    howToRead: [
      'One column per lap both drivers completed at the replay clock, oldest left: the most recent laps the panel width holds (a narrower panel shows fewer laps, never a scroll bar).',
      'In each column three bars, S1, S2, S3 from left to right: S1 starts at 0 and each next sector starts where the previous one ended; the white bar across the column is the lap total (focus minus reference, seconds, on the signed y axis).',
      'Up (+, ▲, orange) = the focus driver slower in that sector, down (−, ▼, blue) = faster; the sign and the arrow carry the direction, the colour repeats it, and the legend names both.',
      'The line above the chart: the mean of each sector over the laps drawn, signed, with its arrow. The reference is the shared comparison driver (also the Undercut Calculator\'s rival), picked in the header.',
    ],
    limitations: [
      'A sector without a valid time for either driver shows "?" and the lap has no total.',
      'Raw sector times: traffic, flags and pit laps are not removed.',
    ],
    seeAlso: [
      { tabId: 'sectors', label: 'Sector rankings' },
      { tabId: 'trackmap', label: 'Track Map' },
    ],
  },

  circle: {
    title: 'Circle of Doom',
    summary: 'One lap drawn as a circle in seconds: where every car is in time, and where the focus car would rejoin if it pitted now.',
    howToRead: [
      `The ring is one lap measured in seconds: the reference lap, the median of the clean green-flag laps of all drivers over the leader's last ${REF_WINDOW_LAPS} laps (widened back until ${REF_MIN_SAMPLES} laps qualify). The top is the timing line and the cars move clockwise, so the angle between two cars is their time gap.`,
      `Cars are filled with the team colour; the second car of each team is drawn in a tint of the team colour with a white outline. Labels give the driver code and the gap to the focus car (+ behind, − ahead), or the laps between them (1L). With no focus, only the selected cars' labels carry a gap: to the selected car first in race order, whose own label reads "ref" (the other labels keep the laps they are down on the leader). Labels of cars that do not matter to the focus are drawn in grey. Labels never shrink below the data size (${FONT_FLOOR_PX.data} px): when the ring is too crowded for all of them, the labels of the cars that matter least leave (first the grey ones, then from the back of the field); the cars stay, and hovering a car brings its label back.`,
      'A selected car has a blue ring (the selection colour of every view). Shift-click a car to add it to the selection or take it out (Ctrl-click on Windows and Cmd-click on macOS work too); the focus stays. The selection is shared with the Track Map and the Timing Tower, so a car selected there is ringed here too. With a selection and no focus, the labels of the other cars turn grey (still readable) and their leader lines fade.',
      'Cars in the pit lane sit on the inner dashed arc, drawn in the pit colour of every view (pink). Cars lapped by the leader are drawn hollow: a ring in the team colour around the panel colour (the second car of a team keeps its white outline outside the ring).',
      'Click a car to focus it. The purple band runs from the car back to where it would rejoin if it pitted now; the diamond is the predicted rejoin point and the hatched arc spans the p10–p90 of the pit loss.',
      `Next to the diamond: the probability of each rejoin position, from ${NUMBER(DEFAULT_PROBABILITY_SAMPLES)} seeded draws of the pit loss (a bootstrap of this race's measured stops). The position ranks the projected crossing of the line at the end of the out-lap against the other cars, lap by lap, as the validated rejoin rule does. When there is no room beside the diamond, the label sits a little further along the ring, joined to it by a purple leader.`,
      'In the tooltip, "Gain the place" lists the cars on the same lap behind the focus car by less than the pit loss, and "Within reach" the cars on the same lap ahead of it by less than the pit loss (they would drop behind if they pitted): the undercut threshold, which assumes equal pace. "Lapped traffic" lists the cars inside the band that are a lap down (1L) or about to lap the focus car (-1L): they never change place with it.',
      PIT_LOSS_METHOD,
      PIT_LOSS_FALLBACK,
      `A "traffic" mark on the rejoin means the projected crossing of the line at the end of the out-lap is less than ${TRAFFIC_GAP_S.toFixed(1)} s behind another car's crossing, on any lap (dirty air, DRS range); the tooltip gives the share of the draws flagged. It is computed with the rank, on the same projections, so it changes only when a lap, a pit stop or the track status changes.`,
      'Click a car to focus it in the other views too (Track Map, Leaderboard, Timing Tower, Position Tracker, PCA panel). Hover a car to highlight it in the views that follow the highlight (Track Map, Leaderboard, Timing Tower, Lap Times, Strategy Timeline and others; the Position Tracker and the PCA panel follow focus and selection only, the PCA biplot the selection only). A double-click focuses a car too (its second click does not clear the focus); a click on the focus car clears it. Hovering a car shows its time gap to the reference car of the labels (the focus, else the first selected car in race order), signed as the labels, and its tooltip names the same car. Centre: lap, track status, reference lap, the loss used and the focus car\'s projected place.',
      'On lap 1, until a car crosses the line, its place comes from the last lap-1 timing point it has passed (end of sector 2), then from its grid slot; a car whose place the data leave open shows none.',
      `Pit in k laps: the stepper in the header (k = 0 to ${PIT_IN_LAPS_MAX}, also the [ and ] keys, with AltGr or Option where the keyboard layout needs it, not while typing) keeps the focus car out k more laps before it stops. The dashed diamond (ghost) marks its projected rejoin, its label gives the projected place, and the centre reads "pits in k: (place now) → (projected place) (±n vs now)": the n places better (+) or worse (−) than pitting now, counted at the end of that same out-lap (pitting now, the car would by then have k laps on the new set). k = 0 is the pit window above; k stops at the laps the car has left.`,
      `Pit in k laps projects every car from the pit window: each car's pace and line crossing as above, then lap by lap the ${LAP_MODEL.charAt(0).toLowerCase()}${LAP_MODEL.slice(1)}`,
      'The ghost sits back from the focus car by the rejoin\'s distance plus the time the k laps take the focus beyond k reference laps (the ring turns once per reference lap). "Rivals stop" (header toggle, off by default): the other cars change their sets on the lap the set reaches the median life of its compound in this race, given the age it has reached (stint-life survival), each charged the pit loss.',
    ],
    limitations: [
      'Pit in k laps assumes no traffic (no time lost behind another car), no safety car, the paces measured now, linear tyre wear by compound and no stops by the other cars unless "rivals stop" is on. With this race\'s degradation fits still negative (early in a stint the track can improve faster than the assumed fuel effect) the model makes a new set slower, so waiting looks better.',
      'Under Safety Car or VSC the pit loss, the paces and the reference lap stay green-flag figures (no validated SC / VSC estimator yet); a car whose lap runs longer than the reference lap stops just before the line.',
      'The other cars are assumed not to stop before the focus car completes its out-lap; the probabilities carry the pit-loss uncertainty only, not unseen rival stops or pace changes.',
      'No pit window before the car has crossed the line for the first time (the projected place starts from its own line time), while a car still on lap 1 has not reached the end of sector 2 (a car on lap 1 is projected to the line from there, with the median last sector of the cars already across), once the leader has taken the chequered flag, nor when the out-lap would end after the car\'s own last lap (a lapped car finishes a lap or more early).',
      'Race and sprint sessions only: there is no race pit loss in qualifying or practice.',
    ],
    seeAlso: [
      { tabId: 'trackmap', label: 'Track Map' },
      { tabId: 'strategy', label: 'Strategy Timeline' },
      { tabId: 'positionlaps', label: 'Position Tracker' },
    ],
  },

  undercut: {
    title: 'Undercut Calculator',
    summary: 'Undercut / overcut: for each lap the focus driver could pit on, the projected gap to a rival at the flag, both cars on their plans to the finish.',
    howToRead: [
      `Pit-lap sweep: one column per candidate in-lap of the focus driver, left to right in race order (the lap in progress, "NOW", and the next ${UNDERCUT_SWEEP_LAPS}: how many columns are shown, nothing else). The column is the projected gap to the rival at the flag (the end of the last lap both cars complete; without a race distance, a live feed with no lap count, at the end of the lap after the last column or the rival's stop, named "the end of Lxx"), the same lap for every column whatever their number, on a signed axis: up (+, ▲) = focus ahead, down (−, ▼) = behind; the colour repeats the direction and the legend names both. The best column is the largest gap, marked with a diamond and its value. Reading every column at the same lap keeps the two cars' pace difference the same in every column, so the columns differ only by the tyres: with no traffic, the best column is the stop that balances the wear of the old and the new set over the rest of the race.`,
      'The rival stops in every column, before or after the focus: on its likely lap (the lap its set reaches the median life of its compound in this race, given the age it has reached: stint-life survival; the prior of the cached races before this race has data), on a lap picked under RIVAL STOPS, or on its stop in progress. A lap picked there is dropped (back to the likely lap) once the rival has passed it or has changed tyres since it was picked.',
      `A plan must be one the tyres can run: every stint up to the flag is held to the tyre age by which ${Math.round(STINT_FEASIBLE_QUANTILE * 100)} % of the sets of its compound are changed (this race's stint-life survival, the cached races' past its data; a modelling choice). A longer stint is charged an extra stop (the pit loss and a new set), for the focus ("+n" on the column, at the zero line) and for the rival alike.`,
      `Both cars start from the Circle of Doom pit window: the gap on the latest lap both completed (GAP NOW, + = focus ahead), each car's pace (median of its last ${PACE_WINDOW_LAPS} clean laps) and the pit loss (PIT LOSS cell); LAPS LEFT = the laps remaining in the race.`,
      'The line above the sweep reads the best column: ✓ AHEAD AFTER BOTH STOPS or ✗ BEHIND AFTER BOTH STOPS, then the best pit lap, the gap at the flag and what it gains or loses on GAP NOW, and any extra stop it needs.',
      LAP_MODEL,
      'NEW-TYRE GAIN: the focus driver\'s first flying lap on a new set (pitting now) against the same lap on the current set: + = the new set is faster, the per-lap undercut of the model.',
      PIT_LOSS_METHOD,
      PIT_LOSS_FALLBACK,
      FUEL_ASSUMPTION,
    ],
    limitations: [
      'No traffic: no time lost behind the rival or other cars, no DRS; the gap is decided by lap times alone, so a faster car behind is projected through.',
      'The rival stops on the lap shown (plus any extra stop its stints need); no other reaction, no safety car.',
      'The paces are held constant to the flag: the pace difference of the two cars over every remaining lap is in the gap (the same in every column), so early in the race the gaps are large and only their differences between columns say which lap is best.',
      'Linear tyre wear: the best lap is where one more lap on the old set costs as much as one lap fewer on the new set saves. It follows the degradation estimates (the cached races\' until this race has a fit long enough), not the track position an undercut fights for (no traffic).',
      'Early in a stint this race\'s degradation fits can be negative (the track improves faster than the assumed fuel effect). The lap model uses only fits long enough and combines them with the cached races (see Race Prediction); if the estimate is still negative the model makes a new set slower; the panel says so when it happens.',
      'The pit loss is a green-flag value; the time lost to the field by a stop under SC / VSC differs and is not modelled.',
      'Race and sprint sessions only: there is no race pit loss in qualifying or practice.',
    ],
    seeAlso: [
      { tabId: 'strategy', label: 'Strategy Timeline' },
      { tabId: 'simulator', label: 'Strategy Simulator' },
    ],
  },

  racecontrol: {
    title: 'Race Control',
    summary: 'Chronological feed of race-control messages, track-status changes, live retirements, and team-radio audio — a single place to read & listen to everything around the session.',
    howToRead: [
      'Each row: time · lap · category badge · driver chip · flag chip · message.',
      'Category chips at the top filter the feed (Flag / DRS / Safety Car / Car Event / Penalty / Stewards / Other) — each category has its own glyph (F, D, S, C, P, ⚖, ·) on its chip and on every row; count next to each chip is the per-category total.',
      'The feed, the DNF list and the team radios show the rows that fit the panel and page the rest (◀ newer, ▶ older); a message longer than two lines shows whole in its tooltip.',
      'Right rail (toggle "DNFs"): drivers currently OUT of the session — populated live from SignalR Retired/Stopped/KnockedOut flags.',
      'Right rail (toggle "Radio"): team-radio captures with inline audio player + auto-transcript. Each row shows driver chip + UTC timestamp + an HTML5 audio player + the locally-produced transcript (faster-whisper tiny.en running on CPU; ~1-2 s per clip after the first model load).',
      'Toggle "Auto-play" in the filter bar to hear new radios automatically as they arrive — playback is scoped to your selected drivers (or focus driver if nothing is selected). Audio + transcript pop up as a floating "Picture-in-Picture" toast in the top-right corner of the app, visible from any tab (Pit Wall, Track Map, anywhere). The toast is queued chronologically, has mute / dismiss controls, and dismisses 1.5 s after each clip ends. If your browser blocks autoplay (rare on desktop), tap the orange "Tap to enable" banner once.',
      'Track-status header pill mirrors the track-map status (Track clear / Yellow / SC / VSC / Red flag).',
    ],
    limitations: [
      'F1\'s SignalR feed ships team-radio AUDIO ONLY — no transcripts. We auto-transcribe locally with faster-whisper (tiny.en, int8, CPU). Driver radio is low-bitrate with engine noise, so expect occasional garbled words; this is NOT a substitute for F1\'s broadcast captions. To upgrade quality, set VA_WHISPER_MODEL=base.en or small.en in the backend env.',
      'Penalty / stewards classification is best-effort: F1 sends most non-flag messages with Category="Other" and the type embedded in the message text (e.g. "5-second penalty").',
      'In live mode timestamps come from the SignalR feed (broadcast time); in replay mode they come from the cached session.',
    ],
    seeAlso: [
      { tabId: 'trackmap', label: 'Track Map' },
      { tabId: 'strategy', label: 'Strategy Timeline' },
    ],
  },
};

/** Convenience — flat array of { tabId, ...entry } for Settings listing. */
export const CHART_HELP_LIST = Object.entries(CHART_HELP).map(([tabId, entry]) => ({
  tabId,
  ...entry,
}));

/** Lookup with graceful fallback. */
export function getChartHelp(tabId) {
  return CHART_HELP[tabId] || null;
}
