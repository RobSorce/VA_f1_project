# Intended User

## Persona: F1 Pit Wall Strategist

**Role**: Race strategist on an F1 team's pit wall, responsible for real-time decisions about pit stop timing, tyre compound selection, and race pace management.

**Background**: Engineering degree (typically mechanical or aerospace), with experience in motorsport data analysis. Fluent in F1 terminology (stint, compound, degradation, undercut, overcut, delta, DRS, safety car). Uses official F1 timing screens, team telemetry systems, and Pirelli tyre data daily.

**Working context**: During a race, the strategist monitors many data streams simultaneously under time pressure. Decisions (pit now vs wait) must be made quickly, often while radio communication is ongoing. Post-race, the strategist reviews data to evaluate strategy performance and prepare for the next event.

## Primary Use Cases

> **To be rewritten.** These use cases were written for an earlier version of the dashboard and have not been rewritten for the current views. On 2026-10-15 only the steps and numbers the code contradicts were removed or corrected to describe the code, each with a dated note; no use case was added.

The current use cases, with step-by-step walkthroughs in the static demo and every number traced to a script output, are in [USE_CASES.md](USE_CASES.md).

### 1. Real-time race monitoring and pit window identification
**Scenario**: During a Grand Prix, the strategist needs to determine the optimal lap to pit their driver.

**How the system supports this**:
- The Leaderboard and Track Map provide position overview (who is where, gaps).
- The Tyre Degradation chart fits each stint's fuel-corrected lap times (clean laps only) against tyre life and labels the stint with its fuel-corrected and its raw slope, in s/lap: the rate at which the stint loses pace (`docs/DEGRADATION_METHODOLOGY.md`).
- Double-clicking a driver (Leaderboard, Timing Sheet, Race Pace Grid) focuses it and asks its lap-time forecast: the next five lap times and the probability of a stop within them, from the method selected on the validation races (the LSTM for both, `docs/evidence/evaluate_forecast.txt`). The forecast rows show in the Timing Sheet and in Race Prediction.
- The Strategy Timeline shows every driver's stints and pit stops, the focus driver's forecast stints (hatched), the strategies of a PCA selection as extra rows, and the Strategy Simulator's plan over its driver's row.
- Setting a lap range (the Position Tracker brush, the Timing Sheet's lap-range bar, a stint on the Strategy Timeline) triggers a degradation regression to quantify the rate of pace loss.

(Corrected on 2026-10-15: the Tyre Degradation chart was said to show when performance "drops off", which a straight-line fit cannot show; the double-click was said to run "LSTM prediction", while the served method is the one selected on the validation races; and the Strategy Timeline was said to show undercut windows, which it does not draw.)

### 2. Cross-race strategy pattern analysis
**Scenario**: Before a race weekend, the strategist reviews the cached races to identify which strategy patterns (1-stop, 2-stop, early vs late pit) went with which results.

**How the system supports this**:
- The PCA Biplot projects the (driver, race) rows of the cached races into 2D, coloured by team or by finishing class: 534 rows of 30 races (`docs/evidence/pca_rebuild.txt`), the 24 races of 2024 and six of 2025 (`docs/evidence/evaluate_forecast.txt` lists them). Its filters are all races, the season and the race on screen. The static demo carries five races (`docs/evidence/export_demo_data_report.txt`).
- Lasso selection on the biplot triggers backend analysis (descriptive differences per feature: Hedges' g with an interval and a random-selection baseline; common pit windows, stint patterns).
- The loading vectors on the biplot show which features drive each axis; the axes are labelled by their top loadings (with the current feature set: race pace against the field on the first axis, stint length and pit stops on the second, `docs/evidence/pca_rebuild.txt`).
- The Cross-Race Analysis panel (`PCAAnalysisPanel.jsx`, beside the biplot) shows the tyre strategies and the pit windows of the selection, and the Strategy Timeline draws the selection's strategies as extra rows.

(Corrected on 2026-10-15: the scenario said the review was "at the upcoming circuit", but the biplot has no circuit filter and the cached races are the ones listed above; the loading example named "pace-dominant vs tyre-management-dominant strategies", while the second axis is stint length and pit stops; the selection's details were said to be in the Strategy Analysis panel, which follows the Race Situation map, not the biplot.)

### 3. Driver comparison and competitive analysis
**Scenario**: The strategist needs to compare their driver's pace, consistency, and tyre management against a direct competitor to decide whether an undercut or overcut is viable.

**How the system supports this**:
- Press `C` to turn compare mode on, then click the two drivers in the Leaderboard (a third click replaces the older of the two); `Shift+G`, or `8`, opens the Driver Compare panel. The panel also takes the two drivers from its own two driver menus, or from the first two selected drivers when it opens with none chosen.
- The Driver Compare Panel shows head-to-head gap and lap-time charts, best sector times, top speeds, a race summary (average and fastest lap, consistency σ, pit stops, racing laps) and the two tyre strategies.
- The Lap Delta Chart shows the cumulative time difference of the selected drivers (the first five drivers when nobody is selected) against the base driver (`lapDeltaBaseDriver`, set with the focus, else the focus driver), with hatched shading for behind (orange, +) and ahead (blue, −).
- The Race Pace Grid classifies each driver-lap against that driver's median clean lap at the replay clock: fast (more than 0.3 s under it, blue), normal, slow (at least 0.5 s over it, yellow) or very slow (at least 2 s over it, orange), with the session and personal bests in purple ◆ and green ●, and pit in / out laps in pink with P / O (`TIMING_BANDS` in `frontend/src/utils/colors.js`).

(Corrected on 2026-10-15: the steps read "select two drivers in the Leaderboard and press `C`", but `C` only switches compare mode on, and the clicks that choose the drivers come after it; the panel was said to show tyre degradation slopes, which it does not.)

## Why This User, Not a General Audience

The system is designed for expert users who:
- Understand F1-specific terminology without explanation (no glossary needed).
- Can interpret PCA loading vectors and linear regression slopes.
- Value data density over visual simplicity: the dashboard fills a fixed viewport and the page never scrolls at the four supported window sizes, 1536 × 750, 1366 × 768, 1920 × 1080 and 2048 × 1100 (`docs/evidence/layout_fit.txt`); the few areas that scroll inside their panel are listed and justified in `docs/SCROLL_JUSTIFICATIONS.md`.
- Need keyboard shortcuts for speed (the shortcut cheatsheet lists 43, `docs/evidence/cheatsheet_fit.txt`).
- Trust quantitative metrics (lap time to 3 decimal places, degradation slope in s/lap) over qualitative summaries.

(Corrected on 2026-10-15: the layout was described as a 1920x1080 no-scroll layout, and the shortcut count was given as 30+ without a source.)

A casual F1 fan would find the interface overwhelming. That is by design: the pit wall strategist's working environment (F1 timing screens, team radio, several monitors) is inherently information-dense, and our dashboard matches that cognitive load expectation.
