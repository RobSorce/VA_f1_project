# Analytical Insights

> **Status: to be re-derived after the 2026-10 fixes.** The insights below were written before the October 2026 fixes (forecast model, degradation definition, PCA features, pit loss). Claims the audit disproved have been removed, each with a dated note in its place; the remaining observations are kept as the record of that exploration until they are measured again on the current code.

This document describes non-obvious patterns and insights that the dashboard enables users to discover through interactive visual exploration. Each insight demonstrates a capability that goes beyond simple data display.

## Live Insights Feed

The system auto-generates insights visible in the **Strategy Analysis panel -> Insights tab**
(default view). Insights are computed in real time from:

- Monte Carlo race projections (`utils/raceSimulation.js`)
- PCA cross-race clustering (when user lassos)
- The focus driver's lap-time forecast, once it has been asked (a double-click on the driver or Shift+P), named by the method that made it and reported only when the change it forecasts is larger than that method's held-out error
- Live driver features from the Race Situation Map (its pace trend gives the tyre degradation alerts)

(Correction, 2026-10-15: this list also named the tyre degradation fits of a brushed or selected lap range. The rule for them in `insightsGenerator.js` reads fields the degradation route does not return (`regressions`, `r_squared`, `n_points`), so that insight never appears.)

Each insight carries:
- Category icon (battle, risk, forecast, pattern, degradation)
- Severity (high/notable/info -- left border color)
- Natural-language text grounded in the actual computed values
- Click action that propagates state to coordinated views
- Confidence score based on the laps run so far

See `frontend/src/utils/insightsGenerator.js` for the generation logic.

---

> **Note (2026-10-15).** The "How to reproduce" steps below describe the views as they are now. The numeric observations under "What the system reveals" were recorded on an earlier version of the dashboard (an earlier PCA feature set with outcome features, a lap-time line chart in place of the Timing Sheet table); they have not been re-measured on the current views and are kept as the record of that exploration, not as results of the current system. Insight 3 is the exception: its numbers were measured on the current code (`docs/evidence/insight3_sector_trend.txt`). The current PCA features and its explained variance are in `docs/PCA_METHODOLOGY.md`.

## Insight 1 — PCA Clusters Reveal Strategy Archetypes Independent of Team

**How to reproduce:** Open the Analytics tab, view the PCA Biplot. Observe the natural clustering of points.

**What the system reveals:** The PCA projection of 499 driver-race feature vectors (17 features including pace, consistency, stint management, degradation rate) reveals 3-4 distinct clusters that correspond to strategy archetypes rather than teams. Cluster boundaries align with pit stop count and stint length combinations, not team identity. This means a Ferrari 2-stop aggressive strategy is closer in feature space to a McLaren 2-stop aggressive strategy than to a Ferrari 1-stop conservative strategy from a different race.

**Why this matters:** A pit wall strategist typically frames decisions within their team ("what's our strategy vs their strategy"). The PCA view reframes the problem as "what strategy archetype are we executing, and what are its historical outcomes?" — enabling cross-team learning.

**VA principle demonstrated:** Dimensionality reduction integrated into the analysis flow (PCA axes are interpretable via loading vectors: PC1 captures pace-consistency trade-off, PC2 captures stint management aggressiveness).

---

## Insight 2 — Lasso Selection + Strategy Analysis Reveals Undercut Effectiveness

**How to reproduce:** In the PCA Biplot, lasso-select a group of points, e.g. the rows with short average stints and more pit stops. The Cross-Race Analysis panel (`PCAAnalysisPanel.jsx`) compares the selection with the other rows: for each feature, Hedges' g with its 95 % normal-approximation interval, against the differences a random selection of the same size gives, plus the strategies (stints) and the pit windows of the selected rows.

**What the system reveals:** Removed on 2026-10-15. The observation recorded here (a short-stint group against a long-stint group, compared on the gap to the leader, the lap-time spread and a "Cohen's d above 1.5 on the degradation rate" called the primary differentiator) was disproved by the audit and is not kept. It was measured on an earlier feature set: the gap to the leader is an outcome and is no longer a feature, and the panel now reports Hedges' g with its interval against a random-selection baseline (`docs/PCA_METHODOLOGY.md`, section 5). No replacement observation has been measured yet.

**Why this matters:** This is analytics triggered by visual interaction — not a pre-computed static result, but a computation (`POST /api/pca/analyze-selection`; in the static demo the same statistics run in the browser, `utils/pcaSelectionStats.js`) that runs on the user-selected subset. The strategist can iteratively refine their selection to test hypotheses about what separates winning from losing strategies.

**VA principle demonstrated:** Composite interaction (lasso → backend computation → visual result) as described in VA_09 slides.

---

## Insight 3 — One Lap Range Across the Views Shows Where a Long Stint Loses Time

**How to reproduce:** In the Docked Layout (the Prediction preset holds the Position Tracker and the Timing Sheet; add the Strategy Timeline and Tyre Degradation from the dock), load Monza 2024 (R16) and click a long Hard stint on the Strategy Timeline. The click sets the one lap range of the dashboard (`selectedLapRange`, equal to `brushLapRange`, `docs/COORDINATION_GRAPH.md` section 2): each row of the Timing Sheet (`LapTimeChart.jsx`) shows the driver's latest lap inside the range, with its S1 / S2 / S3, the sheet names the range in its title and on its lap-range bar, the Position Tracker moves its brush to the stint, and Tyre Degradation fits it. Drag the sheet's bar (or the Position Tracker brush) over the first third of the stint, then over the last third: every view follows, and the sheet gives each sector's time at both ends of the stint.

**What the system reveals:** At Monza 2024 a long Hard stint does not slow down evenly. Over the 25 Hard stints of more than 15 clean laps, the last third of the stint is a median 0.172 s a lap faster than the first third (the fuel burnt outweighs the tyre loss), and the gain comes from sectors 2 and 3 (median -0.130 s and -0.099 s), while sector 1 barely changes (median +0.012 s) and is the sector with the largest rise, or the smallest gain, in 16 of the 25 stints. A few stints lose time in every sector (Gasly's and Zhou's second stints: +0.896 s and +0.824 s a lap). (`node frontend/scripts/audit/insight3_sector_trend.mjs`, output `docs/evidence/insight3_sector_trend.txt`.)

**Why this matters:** A single degradation slope for the stint hides where on the lap the tyre gives up its performance; the same lap range in every view lets the strategist read the stint in time (Position Tracker), per lap and per sector (Timing Sheet) and as a fitted rate (Tyre Degradation) without re-selecting it in each view.

**VA principle demonstrated:** Coordinated multiple views with one shared lap range (brushing and linking): a lap range set in the Strategy Timeline, the Position Tracker or the Timing Sheet is the lap range of the views that follow it (the generated tables of `docs/COORDINATION_GRAPH.md` list them; the Track Map and the PCA biplot do not follow it).

---

## Insight 4 — LSTM Predictions Diverge from Linear Extrapolation at Stint Boundaries

**How to reproduce:** Double-click a driver in the Leaderboard (or press Shift+P with a focus driver) to ask the lap-time forecast. The Timing Sheet shows the forecast rows of the focus driver and its forecast mini-chart (solid line: laps run, dashed: forecast); compare the forecast with a linear extrapolation of the recent trend.

**What the system reveals:** The LSTM model, trained on historical lap sequences, predicts a non-linear lap time increase in the 2-3 laps before an expected pit stop (when tyre life exceeds ~80% of historical stint length for that compound). This divergence from linear extrapolation is most visible on Soft compound stints: the LSTM predicts a 0.3-0.5s/lap degradation cliff that a linear model would miss.

> **Note (2026-10-15).** This observation was made on the previous LSTM, which was trained on a random 80/20 split of the forecast windows rather than of the races (`backend/model/train.py` before commit a35d519) and has been replaced. The model served now, and its held-out comparison with a per-stint linear extrapolation and the other baselines, are in `docs/evidence/evaluate_forecast.txt` (`backend/scripts/evaluate_forecast.py`). The observation has not been measured on the current model.

**Why this matters:** Pit window decisions hinge on predicting exactly when lap times will spike. (Removed on 2026-10-16: a sentence stating that the LSTM captures a non-linear degradation curve that linear models cannot represent; as the note above says, that has not been measured on the current model.) The forecast rows and the forecast mini-chart of the Timing Sheet (`LapTimeChart`) let the strategist see the data and the prediction together.

**VA principle demonstrated:** ML prediction integrated into the visual analytics pipeline, triggered by user interaction (double-click on leaderboard).

---

## Insight 5 — Position Tracker Brush Reveals Undercut Timing Windows

**How to reproduce:** Open the Position Tracker (`PositionByLap.jsx`) and the Timing Sheet (`LapTimeChart.jsx`) in the Docked Layout. Brush a lap range around a position crossover between two drivers: the brush writes `brushLapRange`, and each row of the Timing Sheet then shows the driver's latest lap inside that range (the link works both ways: a range dragged on the sheet's bar is drawn on the Position Tracker).

**What the system reveals:** By brushing the 3-4 lap window where two drivers exchange positions, the Timing Sheet (`LapTimeChart`) shows the exact lap time differential that enabled the overtake. (Removed on 2026-10-15: a sentence that put the undercut's lap-time gain "on the out-lap". The out-lap includes the pit-lane exit, so a fresh-tyre gain can only show from the first flying lap after the stop.) The crossover point — where cumulative time lost in the pit stop equals time gained from fresh tyres — is where the two drivers' lines cross in the Position Tracker and in the Lap Delta chart.

**Why this matters:** The Position Tracker's brush-to-Timing Sheet coordination provides a "time microscope" for analyzing overtakes. Instead of scrolling through 50+ laps of data, the strategist can visually identify the position change and immediately zoom into the causal lap time differential.

**VA principle demonstrated:** Coordinated brush interaction across views enabling progressive refinement of analysis scope (overview → focus → detail).
