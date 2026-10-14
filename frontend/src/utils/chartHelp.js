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
 * (notes/experiments/mc_benchmark.txt, degradation_definition_monza.txt).
 * The lap-time forecast's accuracy numbers are those of its held-out
 * evaluation (notes/experiments/phase6/evaluate_forecast.txt, copied in
 * utils/forecast.js FORECAST_EVALUATION).
 */
import { FALLBACK_PIT_LOSS } from './pitLoss';
import { FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS, OUTLIER_K } from './degradation';
import {
  DEFAULT_NUM_SIMULATIONS, PACE_REF_LAPS, OPTIONAL_STOP_MIN_LAPS_LEFT, PRIORS,
} from './raceSimulation';
import { PIT_IN_LAPS_MAX, UNDERCUT_SWEEP_LAPS, STINT_FEASIBLE_QUANTILE } from './undercut';
import { WHATIF_MARKS, BADGE_INTERVAL_PCT } from './simulationClient';
import { PACE_WINDOW_LAPS } from './circleOfDoom';
import { LOW_DATA_FRACTION } from './views/degradationViews';
import { FORECAST_LAPS, FORECAST_EVALUATION as EVAL } from './forecast';

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
// A held-out MAE of the forecast evaluation (utils/forecast.js FORECAST_EVALUATION), seconds
const S3 = (v) => `${v.toFixed(3)} s`;

export const CHART_HELP = {
  trackmap: {
    title: 'Track Map',
    summary: 'Live circuit map with driver dots, sector colours, DRS zones, and an optional telemetry channel overlay.',
    howToRead: [
      'Dots are drivers, colour = team. The focus driver is enlarged.',
      'Sectors colour by fastest driver per sector (SB purple, PB green).',
      'Channel overlay (Speed / Throttle / Brake) recolours the track using the focus driver\'s telemetry on the most recent cached lap — auto-fetches if nothing is cached yet.',
      'Shift+S toggles sectors; Shift+D toggles DRS zones; R / Shift+R rotates the track.',
    ],
    limitations: [
      'Telemetry channels only load for drivers whose car-data has been cached — some rookies or DNFs may be missing.',
      'Sector colours are recomputed at every lap boundary, so values shown during mid-lap playback are the previous lap\'s.',
    ],
    seeAlso: [
      { tabId: 'telemetry', label: 'Telemetry strip' },
      { tabId: 'sectors', label: 'Sector rankings' },
    ],
  },

  laptimes: {
    title: 'Lap Times',
    summary: 'Per-driver lap-time lines with brush-to-analyse range selection.',
    howToRead: [
      'Each line is a driver; dots are individual laps, colour-coded by driver.',
      'Purple dot = session best, green = personal best — F1 TV convention.',
      'Drag to brush a lap range; the Tyre Degradation panel auto-fits a regression on the brushed range for the focus driver.',
      'Click a driver\'s line to set focus (highlights across all panels).',
      `Double-click a driver's row: that driver becomes the focus and gets the forecast of the next ${FORECAST_LAPS} laps (amber rows at their target laps, named by the method that made it; see Race Prediction).`,
    ],
    limitations: [
      'SC / VSC / yellow-flag laps are visually dimmed but not removed — the numbers are real lap times under caution.',
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
      'Y-axis = cumulative seconds gained (up) or lost (down) vs the baseline driver.',
      'Positive slope = catching up; negative = falling back.',
      'Pit stops appear as discrete jumps the size of the race\'s pit loss (see the per-stop labels in Strategy Timeline).',
      'Click a line to swap baseline drivers.',
    ],
    limitations: [
      'Baseline defaults to the focus driver; with no focus, falls back to the first selected driver.',
      'Does not account for lapped traffic — a driver held up by blue flags still shows as "losing pace."',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'racepace', label: 'Race Pace Grid' },
    ],
  },

  sectors: {
    title: 'Sectors & Speeds',
    summary: 'Ranked best per-sector times for every driver in the session.',
    howToRead: [
      'Three columns, one per sector (S1, S2, S3).',
      'Times sorted fastest → slowest; session-best highlighted purple (SB).',
      'Colours match the Track Map\'s sector colours.',
    ],
    limitations: [
      'Only best-of-session times; ignores stint-level variation.',
      'Outlier sectors from pit in / out laps are filtered but the filter is conservative.',
    ],
    seeAlso: [
      { tabId: 'trackmap', label: 'Track Map' },
    ],
  },

  tyres: {
    title: 'Tyres',
    summary: 'Tyre compounds per stint, stint lengths, and fresh-tyre indicator.',
    howToRead: [
      'One row per driver; coloured bars are stints (S/M/H/I/W for Soft/Medium/Hard/Intermediate/Wet).',
      'Bar width = stint length in laps.',
      'Dashed border = scrubbed (used) set; solid = fresh out of the box.',
    ],
    limitations: [
      'Assumes the scrubbed-set flag from FastF1 is accurate; occasional misclassification for very short test stints.',
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
      'Drag on Lap Times to fit a lap range only; the replay draws only the laps completed so far.',
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
    docsHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/INSIGHTS_MONZA_2024.md',
  },

  tyrehealth: {
    title: 'Tyre Health',
    summary: 'Per-driver tyre-health bars using a 1.6 decay exponent calibrated on 24 dry sessions.',
    howToRead: [
      'Four bars per driver: current compound health + each used set in the garage.',
      'Colour gradient green → amber → red as life decays.',
      'Pace penalty ≈ (life/normalised_max)^1.6 × 80 — calibrated against Pirelli session briefings.',
    ],
    limitations: [
      'Only models thermal / wear degradation — does not predict punctures, graining, or rain-track transitions.',
      'Calibration is from 2022-24 dry Pirelli compounds; 2025 compound changes may shift the curve.',
    ],
    seeAlso: [
      { tabId: 'tiredeg', label: 'Tyre Degradation' },
      { tabId: 'tyremgmt', label: 'Pace Retention' },
    ],
  },

  tyremgmt: {
    title: 'Pace Retention',
    summary: 'Per-stint pace-retention score — how well a driver holds their opening pace as tyres age.',
    howToRead: [
      'Score = (stint end pace) / (stint peak pace); 1.00 = perfect retention, < 1 = losing pace.',
      'Ranked bar list; colour gradient indicates drivers managing well vs poorly.',
      'Only stints of 8+ laps are scored (shorter samples are too noisy).',
    ],
    limitations: [
      'Peak pace is taken from the fastest 5 laps of the stint — can be dominated by quali-mode runs.',
      'Doesn\'t separate tyre management from car setup or strategy dilution (e.g. fuel saving).',
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
      `Drivers whose σ rests on fewer than ${Math.round(LOW_DATA_FRACTION * 100)} % of the largest sample in the field get a "LOW DATA" chip and are de-saturated.`,
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
    docsHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/INSIGHTS_BRAZIL_2024.md',
  },

  ai: {
    title: 'AI Assistant',
    summary: 'Gemini-backed race-strategy engineer — asks your free-form question with the live session context.',
    howToRead: [
      'Type a question; prompt is enriched server-side with driver features, recent laps, weather, and stints.',
      'Responses may include coloured "scenario buttons" — click to project that strategy on the Strategy Timeline.',
      'An amber "MOCK" chip on a reply means no API key is configured; the response is a hand-written example, not live model output.',
    ],
    limitations: [
      'The model is general-purpose — will occasionally hallucinate team-radio phrases. Verify any concrete claim.',
      'Does not see telemetry directly — reasons from lap times and stint summaries.',
    ],
    seeAlso: [
      { tabId: 'strategy', label: 'Strategy Timeline' },
      { tabId: 'simulator', label: 'Strategy Simulator' },
    ],
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
      'Lasso-select (Shift+drag) a group → the Strategy Analysis panel compares it with the other rows (Hedges\' g, its normal-approximation interval, a random baseline with the same mix of rows).',
    ],
    limitations: [
      'The other races\' points use their whole race; the finishing position is metadata for the colour and the tooltip, never a feature.',
      'PCA assumes linear feature relationships; non-linear patterns (e.g. wet/dry split) are spread across components instead of separated.',
    ],
    seeAlso: [
      { tabId: 'analysis', label: 'Strategy Analysis' },
      { tabId: 'racesituation', label: 'Race Situation Map' },
    ],
    docsHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/PCA_METHODOLOGY.md',
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
      `Monte Carlo panel (below): ${NUMBER(DEFAULT_NUM_SIMULATIONS)} race-to-flag runs (seeded: the same race state always gives the same result), run in a background worker. Each row shows the median finishing position (P label: half of the runs finish there or better; gold = P1-P3, i.e. a podium in at least half of the runs, the same statement as the gold "pod" figure), the places gained (▲, green) or lost (▼, red) from the current position to that one, and the podium probability; rows are listed by the position shown, then the current race position.`,
      'Every mark drawn from the runs (P label, its gold, the arrow, the row order, the battle colours, the battles listed, the risk rows) changes only on evidence beyond the Monte Carlo error, never on noise alone: a mark moves when the interval of the share behind it clears its threshold, otherwise it keeps its previous state. The marks drawn once per driver or per pair are judged with intervals that hold for the whole table at once (95 % together, not row by row). The battles listed are those surely among the most likely (fewer rows while pairs are too close to call), green, gold, then the others, each in race order.',
      `Monte Carlo inputs, all from the race so far: pace = each driver's last ${PACE_REF_LAPS} clean laps; tyre wear by compound = ${DEGRADATION_RULE}; lap noise = the scatter of the laps around those per-stint fits, pooled over every stint fitted so far (no prior mixed in; few stints early in the race give a rough value, so the header shows n, the clean laps behind it; before the first fit, the cached races' value: dry ${PRIORS.lapNoise.dry.value} s, wet ${PRIORS.lapNoise.wet.value} s); stops = when sets of that compound were changed so far this race (sets still running count as still running), one stop forced in a dry race until two dry compounds are used, no optional stop with fewer than ${OPTIONAL_STOP_MIN_LAPS_LEFT} laps left; safety car = episodes so far per lap, pulled toward the average of the ${PRIORS.races} cached races (${PRIORS.safetyCar.episodesPerRace} episode per ${PRIORS.safetyCar.lapsPerRace} laps), shown as "prior" until one happens.`,
      FUEL_ASSUMPTION,
    ],
    limitations: [
      `Accuracy varies with conditions (${EVAL.source}): the LSTM's test MAE per race runs from ${S3(EVAL.lstmRaceMae.low)} to ${S3(EVAL.lstmRaceMae.high)} (${EVAL.lstmRaceMae.highRace}); from a stint on INTERMEDIATE tyres it is ${S3(EVAL.intermediateMae.lstm)}, where compound mean degradation does better (${S3(EVAL.intermediateMae.compound_mean)}).`,
      `Pit probabilities above 50 % are over-confident on the test races: predicted ${EVAL.lstmPitAbove50.predictedLow}-${EVAL.lstmPitAbove50.predictedHigh}, observed ${EVAL.lstmPitAbove50.observedLow}-${EVAL.lstmPitAbove50.observedHigh}.`,
      'Too few clean laps of the driver at the clock (green, not lap 1, no pit in-lap or out-lap) give no forecast: at the start, right after a stop or under a long safety car the panel shows the reason instead.',
      'Monte Carlo: no traffic or overtaking difficulty (places come from projected race time), weather not forecast (wet compounds stay), a safety car compresses the gaps by the ratio measured on the cached races; each stop is charged a pit loss drawn around this race\'s median (the labelled fallback before the first measured stop).',
    ],
    seeAlso: [
      { tabId: 'strategy', label: 'Strategy Timeline' },
      { tabId: 'simulator', label: 'Strategy Simulator' },
    ],
    docsHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/INSIGHTS_BRAZIL_2024.md',
  },

  simulator: {
    title: 'Strategy Simulator',
    summary: 'Monte Carlo race-to-flag simulator — changes a hypothetical strategy and shows the resulting position distribution.',
    howToRead: [
      'Edit the pit-strategy input (add / remove / move a pit stop) and see the result vs baseline.',
      `Both runs (${NUMBER(DEFAULT_NUM_SIMULATIONS)} simulations each) use the same random numbers, so an identical plan differs by exactly 0 and every difference comes from the plan.`,
      'Each planned stop from the lap in progress on is made at the end of its in-lap and charged a pit loss drawn around the race\'s median; stops before it are the race\'s own history.',
      'Distribution bar: expected finish with P10 / P90 confidence band.',
      'Delta card: Δ position (baseline expected position minus the plan\'s: positive = the plan finishes higher; the mean of the run-by-run differences, ± its Monte Carlo error), Δ podium and Δ points probability. The baseline is the model\'s own stops, or a plan picked with "vs".',
      `Every mark of the result changes only on evidence beyond the Monte Carlo error, never on noise alone: PLACES GAINED / LOST (and the green / red of each difference) only when the interval of the run-by-run difference excludes 0, otherwise NO CLEAR CHANGE (or the previous verdict of the same plan while the difference stays on its side); each card's P label is the median finishing position, moved only beyond the same error; with the model's stops as the baseline, the baseline card shows the Race Prediction panel's P label of the driver (the same run). A mark kept only within the error yields to one beyond it: the plan's card takes the position within its error nearest the baseline's, and a verdict kept only by the previous one becomes NO CLEAR CHANGE. The intervals hold for the ${WHATIF_MARKS} marks of a result together (${BADGE_INTERVAL_PCT} % together, not mark by mark).`,
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
    summary: 'Strategy timeline (Gantt) — stints, pit stops, predicted / ghost / Gemini overlays.',
    howToRead: [
      'One row per driver; horizontal bars are stints coloured by compound, one bar per tyre set (FastF1 Stint column; a pit-lane pass without a tyre change, such as a drive-through or the field led through the pits under SC, keeps the set), so two stints on the same compound stay separate.',
      'During replay only what has happened is drawn: a bar covers the laps completed so far, and a new bar appears at the pit exit, when the new set goes on, then grows as its laps complete. STOPS counts tyre changes so far: always the number of bars minus one.',
      'Diamonds mark pit stops (tyre changes), from the pit exit; a dashed outline diamond marks a car in the pit lane right now. The label is that stop\'s pit loss: a plain number when measured (in-lap + out-lap minus twice the driver\'s green-flag median lap), "≈" and the race median when the stop cannot be measured ("est", an estimate), "*" on the fallback ("fallback", before any measured green-flag stop), no number while the stop is being measured. The line under the chart repeats this legend; hover a diamond for details.',
      'Qualifying and practice: the bars are the runs\' tyre sets and stops carry no pit-loss label (pit loss is a race quantity).',
      'Predicted-remaining stints are shown with a lighter fill.',
      'Overlay buttons (from Gemini answers or the Simulator) inject a scenario for comparison.',
    ],
    limitations: [
      'Predicted stints past current lap assume optimal tyre life; actual driver choice may deviate.',
      'Stops under SC / VSC are not measured (every car is slow, so in-lap + out-lap minus the green median is not a pit loss): they show the green-flag race median, marked "≈" ("est").',
    ],
    seeAlso: [
      { tabId: 'simulator', label: 'Strategy Simulator' },
      { tabId: 'ai', label: 'AI Assistant' },
    ],
  },

  analysis: {
    title: 'Strategy Analysis',
    summary: 'Descriptive differences between a lasso selection on the PCA biplot and the other rows — not a significance test.',
    howToRead: [
      'One row per feature: Hedges\' g (selection mean minus the other rows\' mean, in pooled standard deviations, with the small-sample correction), its normal-approximation interval (g plus or minus the normal quantile times the large-sample standard error of g; Method gives the formula), and N of both groups.',
      'Shaded band = the |g| a random selection of the same size and the same mix of rows reaches on average; dashed lines = the threshold a feature must pass to be marked "above random" (after a race: a high percentile of the largest |g| over all features in those random selections, one threshold for all; during a replay each feature has its own, the same high percentile of its own random |g|, set so that random selections pass some threshold as rarely as with one threshold for all, because pit stops and stint lengths reach far larger |g| by the mix of rows alone; Method gives it).',
      'During a replay the rows of the race on screen are taken at the replay clock and the other races are whole races: each random selection holds as many rows of each kind as the selection, and the line under N states the mix and the lap.',
      'A row marked "progress-dependent" (pit stops, stint lengths, tyre degradation) compares rows of the race on screen, which count only the laps completed so far, with whole races: the two kinds differ in it whatever the drivers did, so read it against the random baseline, which draws the same mix.',
      'Patterns and Details: the selection\'s tyre strategies, stints and pit windows (in-laps of tyre changes); click a pit window to highlight its laps in the other views.',
      'Rows of the race on screen during its replay are taken at the replay clock: a note says so, and their stints and stops end there.',
      'Triggered by a lasso selection on the Analytics biplot.',
    ],
    limitations: [
      'The selection was drawn on a projection of these same features, so large |g| values are expected by construction: read each value against the random baseline, not against fixed small / medium / large cut-offs.',
      'Small selections give wide intervals and a high threshold. A single selected row (a clicked point) gets no interval: one row has no spread of its own, so its rows say "no interval" and show only g, N and the random baseline. A feature with missing values shows its own N.',
    ],
    seeAlso: [
      { tabId: 'analytics', label: 'Analytics (PCA)' },
    ],
  },

  racesituation: {
    title: 'Race Situation',
    summary: 'Live PCA of each driver\'s race state, refitted every lap — lasso-select to filter other panels.',
    howToRead: [
      'Each dot is a driver at this lap, from position, gap to the leader, recent pace, pace trend, tyre age, stint number and position change (completed laps only), standardized with this lap\'s field.',
      'The two axes span the plane of this lap\'s first two principal components; inside that plane they turn only as much as needed to follow the previous lap (orthogonal Procrustes), so the map does not jump when the two components swap or rotate. During a replay the previous lap\'s axes are those of a replay played from the start, so the same moment of the race looks the same whether it is reached by playing, a seek or a step back. Each axis title gives the share of the variance that axis captures; the line under the lap number gives the plane\'s total.',
      'Arrows are feature loadings drawn from the field average (the crosshair), one per input in the fit: each dot sits at the crosshair plus its standardized features times the arrows (all arrows share one length scale), so the arrows read the dots exactly.',
      'Trails show the dots of the last laps; a dot moves to its new place with a short animation.',
      'Driver colours; focus driver ringed. Lasso selects a subset — a "Clear N selected" action appears when the selection is non-empty.',
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
    summary: 'Median-normalised pace grid — cells shaded by Δ to race median so fast/slow stints are visible at a glance.',
    howToRead: [
      'Rows = drivers, columns = laps.',
      'Cell colour: green = below median (fast), red = above median (slow), empty = no clean lap.',
      'Use to spot stint-long trends — solid blocks of one colour reveal pace deficits or surges.',
      `Double-click a cell: that driver becomes the focus and gets the lap-time forecast of the ${FORECAST_LAPS} laps after that lap (a lap later than the replay's counts as the replay's).`,
    ],
    limitations: [
      'Normalisation is whole-race median; cold laps at the start look artificially slow.',
      'Does not distinguish dirty air vs clean air pace.',
    ],
    seeAlso: [
      { tabId: 'laptimes', label: 'Lap Times' },
      { tabId: 'lapdelta', label: 'Lap Delta' },
    ],
  },

  telemetry: {
    title: 'Telemetry',
    summary: 'Throttle / brake / gear strip for the focus driver on the current lap.',
    howToRead: [
      'Three stacked channels, common X-axis in metres along the lap.',
      'Throttle green fill; brake red fill; gear step line.',
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
    summary: 'Season standings + weighted-moving-average projection — Standings and Prediction & AI subtabs.',
    howToRead: [
      '**Standings:** chart of cumulative points by round + classic table.',
      '**Prediction & AI:** same chart extended with a projection to season-end, plus an embedded Gemini-style commentary.',
      'Projection is a weighted moving average of the last 6 results.',
    ],
    limitations: [
      'WMA is simple and does not model upgrades, DNFs, or regulation changes.',
      'Projection confidence narrows as the season progresses.',
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
      'Pick two drivers from the selectors (or use Shift+G after selecting two on the Leaderboard).',
      'Panel splits into two columns with matched metrics. Consistency (σ) is the residual sigma of each driver\'s per-stint fits, as in the Consistency panel.',
      'Delta numbers are colour-coded: green = Driver A better, red = Driver B better.',
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
      'Hover a driver to dim the rest; click to set focus.',
      'Pit stops appear as sharp position drops.',
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
    summary: 'Waterfall of sector-time deltas — where each driver gains or loses vs the session-best sector.',
    howToRead: [
      'Per-driver row with three stacked bars (S1, S2, S3).',
      'Green = gain vs best, red = loss — magnitude in seconds.',
      'Useful for setup / circuit-character comparisons.',
    ],
    limitations: [
      'Uses best-of-session sectors; a driver with one freak lap gets the "best" even if most of their laps are slower.',
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
      'The ring is one lap measured in seconds: the reference lap, the median of the clean green-flag laps of all drivers over the leader\'s last 5 laps (widened back until 10 laps qualify). The top is the timing line and the cars move clockwise, so the angle between two cars is their time gap.',
      'Cars are filled with the team colour; the second car of each team has a white outline. Labels give the driver code and the gap to the focus car (+ behind, − ahead), or the laps between them (1L). Labels of cars that do not matter to the focus are dimmed.',
      'A car selected in another view (for example clicked on the Track Map) has a red ring; with a selection and no focus, the labels of the other cars are dimmed.',
      'Cars in the pit lane sit on the inner dashed arc. Cars lapped by the leader are drawn faded.',
      'Click a car to focus it. The purple band runs from the car back to where it would rejoin if it pitted now; the diamond is the predicted rejoin point and the hatched arc spans the p10–p90 of the pit loss.',
      'Next to the diamond: the probability of each rejoin position, from 1000 draws of the pit loss (a bootstrap of this race\'s measured stops). The position ranks the projected crossing of the line at the end of the out-lap against the other cars, lap by lap, as the validated rejoin rule does. When there is no room beside the diamond, the label sits a little further along the ring, joined to it by a purple leader.',
      'In the tooltip, "Gain the place" lists the cars on the same lap behind the focus car by less than the pit loss, and "Within reach" the cars on the same lap ahead of it by less than the pit loss (they would drop behind if they pitted): the undercut threshold, which assumes equal pace. "Lapped traffic" lists the cars inside the band that are a lap down (1L) or about to lap the focus car (-1L): they never change place with it.',
      PIT_LOSS_METHOD,
      PIT_LOSS_FALLBACK,
      'A "traffic" mark on the rejoin means the rejoin point is less than 1.0 s behind another car on the ring as drawn, on any lap (dirty air, DRS range). It is read again at every frame, so it follows the drawing, including a car held just before the line.',
      'Click a car to focus it in the other views too (Track Map, Leaderboard, Timing Tower, Position Tracker, PCA panel). Hover a car to highlight it in the views that follow the highlight (Track Map, Leaderboard, Timing Tower, Lap Times, Strategy Timeline and others; the Position Tracker and the PCA views follow focus and selection only). With a focus set, hovering another car shows the time gap between the two. Centre: lap, track status, reference lap, the loss used and the focus car\'s projected place.',
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
      `Pit-lap sweep: each row is a candidate in-lap for the focus driver (the lap in progress, "NOW", and the next ${UNDERCUT_SWEEP_LAPS}: how many rows are shown, nothing else); the bar is the projected gap to the rival at the flag (the end of the last lap both cars complete), the same lap for every row whatever the table length. Signed: + (green, right) = focus ahead, − (red, left) = behind. The best row is the largest gap. Reading every row at the same lap keeps the two cars' pace difference the same in every row, so the rows differ only by the tyres: with no traffic, the best row is the stop that balances the wear of the old and the new set over the rest of the race.`,
      'The rival stops in every row, before or after the focus: on its likely lap (the lap its set reaches the median life of its compound in this race, given the age it has reached: stint-life survival; the prior of the cached races before this race has data), on a lap picked under RIVAL STOPS, or on its stop in progress. A lap picked there is dropped (back to the likely lap) once the rival has passed it or has changed tyres since it was picked.',
      `A plan must be one the tyres can run: every stint up to the flag is held to the tyre age by which ${Math.round(STINT_FEASIBLE_QUANTILE * 100)} % of the sets of its compound are changed (this race's stint-life survival, the cached races' past its data; a modelling choice). A longer stint is charged an extra stop (the pit loss and a new set), for the focus (+n next to the row's lap) and for the rival alike.`,
      `Both cars start from the Circle of Doom pit window: the gap on the latest lap both completed (GAP NOW, + = focus ahead), each car's pace (median of its last ${PACE_WINDOW_LAPS} clean laps) and the pit loss (PIT LOSS cell).`,
      LAP_MODEL,
      'NEW-TYRE GAIN: the focus driver\'s first flying lap on a new set (pitting now) against the same lap on the current set: + = the new set is faster, the per-lap undercut of the model.',
      PIT_LOSS_METHOD,
      PIT_LOSS_FALLBACK,
      FUEL_ASSUMPTION,
    ],
    limitations: [
      'No traffic: no time lost behind the rival or other cars, no DRS; the gap is decided by lap times alone, so a faster car behind is projected through.',
      'The rival stops on the lap shown (plus any extra stop its stints need); no other reaction, no safety car.',
      'The paces are held constant to the flag: the pace difference of the two cars over every remaining lap is in the gap (the same in every row), so early in the race the gaps are large and only their differences between rows say which lap is best.',
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
      'Category chips at the top filter the feed (Flag / DRS / Safety Car / Penalty / Stewards / Other) — count next to each chip is the per-category total.',
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
