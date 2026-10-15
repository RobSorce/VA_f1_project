# Analytical Insights

This document describes non-obvious patterns and insights that the F1 Race Strategy Dashboard enables users to discover through interactive visual exploration. Each insight demonstrates a capability that goes beyond simple data display.

## Live Insights Feed

The system auto-generates insights visible in the **Strategy Analysis panel -> Insights tab**
(default view). Insights are computed in real time from:

- Monte Carlo race projections (`utils/raceSimulation.js`)
- PCA cross-race clustering (when user lassos)
- LSTM lap-time forecasts (when driver is focused)
- Tyre degradation fits (when a lap range is brushed or selected)
- Live driver features from the Race Situation Map

Each insight carries:
- Category icon (battle, risk, forecast, pattern, degradation)
- Severity (high/notable/info -- left border color)
- Natural-language text grounded in the actual computed values
- Click action that propagates state to coordinated views
- Confidence score based on data sample size

See `frontend/src/utils/insightsGenerator.js` for the generation logic.

---

> **Note (2026-10-15).** The "How to reproduce" steps below describe the views as they are now. The numeric observations under "What the system reveals" were recorded on an earlier version of the dashboard (an earlier PCA feature set with outcome features, a lap-time line chart in place of the Timing Sheet table); they have not been re-measured on the current views and are kept as the record of that exploration, not as results of the current system. The current PCA features and its explained variance are in `docs/PCA_METHODOLOGY.md`.

## Insight 1 — PCA Clusters Reveal Strategy Archetypes Independent of Team

**How to reproduce:** Open the Analytics tab, view the PCA Biplot. Observe the natural clustering of points.

**What the system reveals:** The PCA projection of 499 driver-race feature vectors (17 features including pace, consistency, stint management, degradation rate) reveals 3-4 distinct clusters that correspond to strategy archetypes rather than teams. Cluster boundaries align with pit stop count and stint length combinations, not team identity. This means a Ferrari 2-stop aggressive strategy is closer in feature space to a McLaren 2-stop aggressive strategy than to a Ferrari 1-stop conservative strategy from a different race.

**Why this matters:** A pit wall strategist typically frames decisions within their team ("what's our strategy vs their strategy"). The PCA view reframes the problem as "what strategy archetype are we executing, and what are its historical outcomes?" — enabling cross-team learning.

**VA principle demonstrated:** Dimensionality reduction integrated into the analysis flow (PCA axes are interpretable via loading vectors: PC1 captures pace-consistency trade-off, PC2 captures stint management aggressiveness).

---

## Insight 2 — Lasso Selection + Strategy Analysis Reveals Undercut Effectiveness

**How to reproduce:** In the PCA Biplot, lasso-select a group of points, e.g. the rows with short average stints and more pit stops. The Cross-Race Analysis panel (`PCAAnalysisPanel.jsx`) compares the selection with the other rows: for each feature, Hedges' g with its 95 % normal-approximation interval, against the differences a random selection of the same size gives, plus the strategies (stints) and the pit windows of the selected rows.

**What the system reveals:** The analysis triggered by lasso selection computes that the aggressive short-stint cluster has an average `gap_to_leader_mean` 4.2 seconds lower than the conservative cluster, but `std_lap_time` is 0.31s higher — aggressive strategies gain position but sacrifice consistency. The Cohen's d for `degradation_rate` between clusters is >1.5, confirming it's the primary differentiator.

**Why this matters:** This is analytics triggered by visual interaction — not a pre-computed static result, but a computation (`POST /api/pca/analyze-selection`; in the static demo the same statistics run in the browser, `utils/pcaSelectionStats.js`) that runs on the user-selected subset. The strategist can iteratively refine their selection to test hypotheses about what separates winning from losing strategies.

**VA principle demonstrated:** Composite interaction (lasso → backend computation → visual result) as described in VA_09 slides.

---

## Insight 3 — One Lap Range Across the Views Shows Where a Long Stint Loses Time

**How to reproduce:** In the Docked Layout (the Prediction preset holds the Position Tracker and the Timing Sheet; add the Strategy Timeline and Tyre Degradation from the dock), load Monza 2024 (R16) and click a long Hard stint on the Strategy Timeline. The click sets the one lap range of the dashboard (`selectedLapRange`, equal to `brushLapRange`, `docs/COORDINATION_GRAPH.md` section 2): the Timing Sheet (`LapTimeChart.jsx`) filters its rows to those laps (each row: the driver's latest lap inside the range, with its S1 / S2 / S3) and names the range in its title and on its lap-range bar, the Position Tracker moves its brush to the stint, and Tyre Degradation fits it. Drag the sheet's bar (or the Position Tracker brush) over the first third of the stint, then over the last third: every view follows, and the sheet gives each sector's time at both ends of the stint.

**What the system reveals:** At Monza 2024 a long Hard stint does not slow down evenly. Over the 25 Hard stints of more than 15 clean laps, the last third of the stint is a median 0.172 s a lap faster than the first third (the fuel burnt outweighs the tyre loss), and the gain comes from sectors 2 and 3 (median -0.130 s and -0.099 s), while sector 1 barely changes (median +0.012 s) and is the sector with the largest rise, or the smallest gain, in 16 of the 25 stints. A few stints lose time in every sector (Gasly's and Zhou's second stints: +0.896 s and +0.824 s a lap). (`node notes/experiments/phase9/repair3/insight3_sector_trend.mjs`, output `insight3_sector_trend.txt`.)

**Why this matters:** A single degradation slope for the stint hides where on the lap the tyre gives up its performance; the same lap range in every view lets the strategist read the stint in time (Position Tracker), per lap and per sector (Timing Sheet) and as a fitted rate (Tyre Degradation) without re-selecting it in each view.

**VA principle demonstrated:** Coordinated multiple views with one shared selection (brushing and linking): a selection made in any view is the selection of every view.

---

## Insight 4 — LSTM Predictions Diverge from Linear Extrapolation at Stint Boundaries

**How to reproduce:** Double-click a driver in the Leaderboard (or press Shift+P with a focus driver) to ask the lap-time forecast. The Timing Sheet shows the forecast rows of the focus driver and its forecast mini-chart (solid line: laps run, dashed: forecast); compare the forecast with a linear extrapolation of the recent trend.

**What the system reveals:** The LSTM model, trained on historical lap sequences, predicts a non-linear lap time increase in the 2-3 laps before an expected pit stop (when tyre life exceeds ~80% of historical stint length for that compound). This divergence from linear extrapolation is most visible on Soft compound stints: the LSTM predicts a 0.3-0.5s/lap degradation cliff that a linear model would miss.

**Why this matters:** Pit window decisions hinge on predicting exactly when lap times will spike. The LSTM captures the non-linear tyre degradation curve that domain experts know exists but linear regression models cannot represent. The visual overlay on the LapTimeChart lets the strategist see both the data and the prediction simultaneously, building trust in the model.

**VA principle demonstrated:** ML prediction integrated into the visual analytics pipeline, triggered by user interaction (double-click on leaderboard).

---

## Insight 5 — Position Tracker Brush Reveals Undercut Timing Windows

**How to reproduce:** Open the Position Tracker (`PositionByLap.jsx`) and the Timing Sheet (`LapTimeChart.jsx`) in the Docked Layout. Brush a lap range around a position crossover between two drivers: the brush writes `brushLapRange`, and each row of the Timing Sheet then shows the driver's latest lap inside that range (the link works both ways: a range dragged on the sheet's bar is drawn on the Position Tracker).

**What the system reveals:** By brushing the 3-4 lap window where two drivers exchange positions, the filtered LapTimeChart shows the exact lap time differential that enabled the overtake. In undercut scenarios, the driver who pits first shows a 1.5-2.5s lap time improvement on the out-lap (fresh tyres + low fuel) compared to the driver still on old tyres. The crossover point — where cumulative time lost in the pit stop equals time gained from fresh tyres — is where the two drivers' lines cross in the Position Tracker and in the Lap Delta chart.

**Why this matters:** The Position Tracker's brush-to-Timing Sheet coordination provides a "time microscope" for analyzing overtakes. Instead of scrolling through 50+ laps of data, the strategist can visually identify the position change and immediately zoom into the causal lap time differential.

**VA principle demonstrated:** Coordinated brush interaction across views enabling progressive refinement of analysis scope (overview → focus → detail).
