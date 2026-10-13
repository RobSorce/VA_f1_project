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
 * labelled fallback used before the first valid green-flag stop.
 */
import { FALLBACK_PIT_LOSS } from './pitLoss';

const PIT_LOSS_METHOD = 'Pit loss is measured from this race\'s green-flag stops: '
  + 'in-lap + out-lap minus twice the driver\'s green-flag median lap; the median over stops is used.';
const PIT_LOSS_FALLBACK = `Before the first valid green-flag stop a ${FALLBACK_PIT_LOSS.median} s fallback `
  + '(an assumption, not data) is used, shown as "fallback".';

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
    ],
    limitations: [
      'SC / VSC / yellow-flag laps are visually dimmed but not removed — the numbers are real lap times under caution.',
      'Pit in / out laps are kept for context but excluded from brushed regressions.',
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
    summary: 'Per-stint linear regression of lap time vs tyre life — quantifies degradation in ms/lap.',
    howToRead: [
      'X-axis = tyre life (laps on current compound); Y-axis = clean lap time (SC/pit filtered).',
      'Each stint gets its own scatter + regression line.',
      'Two slopes annotated per stint: **raw** (includes fuel burn) and **tyre only** (raw + 30 ms/lap fuel correction).',
      'Negative raw slope is common at low-deg tracks — read the fuel-corrected number for true tyre wear.',
    ],
    limitations: [
      'Fuel correction is a fixed 30 ms/lap; actual car-specific burn rate varies ±5 ms/lap.',
      'Regression assumes linear degradation; thermal-cliff behaviour (late-stint collapse) is flattened.',
      'See docs/INSIGHTS_MONZA_2024.md for a worked example (Monza = low deg, Hungary = high deg).',
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
    summary: 'Population σ of lap times per driver — cards collapse for overview, expand for detail.',
    howToRead: [
      'Ranked by average lap time; σ (standard deviation) quantifies how tightly packed a driver\'s lap distribution is.',
      'Consistent / Inconsistent chip is relative to the field\'s median CV%.',
      'Click the chevron to expand; click the header body to set focus driver.',
      'Drivers with < 75 % of race laps get a "LOW DATA" chip and are de-saturated.',
    ],
    limitations: [
      'Pit in/out laps are excluded; everything else (including SC laps) counts.',
      'In wet races σ jumps from ~1 s to ~9 s — absolute values are not comparable across conditions. See docs/INSIGHTS_BRAZIL_2024.md for a worked case.',
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
    summary: 'PCA biplot of per-(driver, race) feature vectors — lasso a cluster to run a Cohen\'s-d analysis.',
    howToRead: [
      'Each point is a (driver, year, round) pair; axes are the top 2 principal components of 17 features.',
      'Axis labels show % variance captured by each component.',
      'Arrows are feature loading vectors — length shows how much a feature drives the projection.',
      'Lasso-select a cluster → Strategy Analysis panel fills with Cohen\'s-d features separating the cluster.',
    ],
    limitations: [
      'Scaled on 499 rows from 24 cached sessions — new races don\'t reshape the basis in real time (frozen after 8 warmup laps with Procrustes alignment).',
      'PCA assumes linear feature relationships; non-linear patterns (e.g. wet/dry split) are split across components instead of separated.',
    ],
    seeAlso: [
      { tabId: 'analysis', label: 'Strategy Analysis' },
      { tabId: 'racesituation', label: 'Race Situation Map' },
    ],
    docsHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/PCA_METHODOLOGY.md',
  },

  prediction: {
    title: 'Race Prediction',
    summary: 'LSTM-based lap-time forecast (next 5 laps) + pit-stop probability + Monte Carlo position projections.',
    howToRead: [
      'LSTM block: 5-lap forecast with a colour-coded spread pill (tight = high confidence).',
      'Chip reads "LSTM" (trained model) or "HEURISTIC" (fallback, MAE ~2-3× worse).',
      'Optimal pit-lap suggestion + predicted stints.',
      'Monte Carlo panel (below): 100 iterations of race-to-flag simulation, showing expected-position and podium / points probabilities.',
    ],
    limitations: [
      'Model accuracy varies with conditions: ~0.4 s MAE dry, up to 2.5 s wet. Wet laps push confidence outside the useful range.',
      'Freshly pitted drivers (first 3-5 laps on new tyres) are the worst-case — see docs/INSIGHTS_HUNGARY_2024.md.',
      'Monte Carlo uses N=100 iterations; re-computes on every currentLap change.',
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
      'Distribution bar: expected finish with P10 / P90 confidence band.',
      'Delta card: Δ position, Δ podium probability, Δ points probability vs the actual strategy.',
    ],
    limitations: [
      'N=100 iterations — median is stable, but probability tails have ~±5 % noise. Use 500+ for post-race analysis.',
      'Rival cars are assumed to continue their actual strategy; does not model reactive pit calls from competitors.',
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
    summary: 'Cohen\'s d feature ranking — which metrics separate your PCA/t-SNE lasso selection from the rest.',
    howToRead: [
      'Ranked list of features by |Cohen\'s d| — 0.2 small, 0.5 medium, 0.8 large effect.',
      'Bar length + sign indicates magnitude and direction.',
      'Triggered by a lasso selection on the Analytics biplot.',
    ],
    limitations: [
      'Cohen\'s d assumes roughly normal distributions — heavily skewed features (e.g. pit-loss gaps) can overstate the effect.',
      'fuel_corrected_pace is always NaN from the disk cache and is skipped.',
    ],
    seeAlso: [
      { tabId: 'analytics', label: 'Analytics (PCA)' },
    ],
  },

  racesituation: {
    title: 'Race Situation',
    summary: 'Live race-state map with exponentially-smoothed features per driver — lasso-select to filter other panels.',
    howToRead: [
      'Each driver is a dot positioned by its dominant state features.',
      'Team colours; focus driver enlarged.',
      'Lasso selects a subset — a "Clear N selected" action appears when the selection is non-empty.',
    ],
    limitations: [
      'Exponential smoothing has a ~5-lap half-life; recent jumps (pit stops, SC restarts) take a few laps to fully register.',
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
      'Panel splits into two columns with matched metrics.',
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
    ],
    limitations: [
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
    summary: 'Undercut / overcut viability calculator — projects gain or loss from pitting now vs staying out.',
    howToRead: [
      'Inputs from the race so far: gap to the rival, tyre age and degradation of both cars, fresh-tyre delta and pit loss (PIT LOSS cell).',
      PIT_LOSS_METHOD,
      PIT_LOSS_FALLBACK,
      'Pit-lap sweep: each row is a candidate pit lap for the focus driver, the bar is the projected gap at the flag.',
      'Green = focus driver finishes ahead (undercut works); red = finishes behind.',
    ],
    limitations: [
      'Ignores traffic and dirty air between the two cars.',
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
