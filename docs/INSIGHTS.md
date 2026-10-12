# Analytical Insights

This document describes non-obvious patterns and insights that the F1 Race Strategy Dashboard enables users to discover through interactive visual exploration. Each insight demonstrates a capability that goes beyond simple data display.

## Live Insights Feed

The system auto-generates insights visible in the **Strategy Analysis panel -> Insights tab**
(default view). Insights are computed in real time from:

- Monte Carlo race projections (100-simulation aggregations)
- PCA cross-race clustering (when user lassos)
- LSTM lap-time forecasts (when driver is focused)
- Tyre degradation regressions (when lap range is brushed)
- Live driver features from the Race Situation Map

Each insight carries:
- Category icon (battle, risk, forecast, pattern, degradation)
- Severity (high/notable/info -- left border color)
- Natural-language text grounded in the actual computed values
- Click action that propagates state to coordinated views
- Confidence score based on data sample size

See `frontend/src/utils/insightsGenerator.js` for the generation logic.

---

## Insight 1 — PCA Clusters Reveal Strategy Archetypes Independent of Team

**How to reproduce:** Open the Analytics tab, view the PCA Biplot. Observe the natural clustering of points.

**What the system reveals:** The PCA projection of 499 driver-race feature vectors (17 features including pace, consistency, stint management, degradation rate) reveals 3-4 distinct clusters that correspond to strategy archetypes rather than teams. Cluster boundaries align with pit stop count and stint length combinations, not team identity. This means a Ferrari 2-stop aggressive strategy is closer in feature space to a McLaren 2-stop aggressive strategy than to a Ferrari 1-stop conservative strategy from a different race.

**Why this matters:** A pit wall strategist typically frames decisions within their team ("what's our strategy vs their strategy"). The PCA view reframes the problem as "what strategy archetype are we executing, and what are its historical outcomes?" — enabling cross-team learning.

**VA principle demonstrated:** Dimensionality reduction integrated into the analysis flow (PCA axes are interpretable via loading vectors: PC1 captures pace-consistency trade-off, PC2 captures stint management aggressiveness).

---

## Insight 2 — Lasso Selection + Strategy Analysis Reveals Undercut Effectiveness

**How to reproduce:** In the PCA Biplot, lasso-select a cluster of points with high `degradation_rate` and short `avg_stint_length`. The PCAAnalysisPanel shows a radar chart of the selected subset's feature profile and a bar chart of feature importance (Cohen's d).

**What the system reveals:** The analysis triggered by lasso selection computes that the aggressive short-stint cluster has an average `gap_to_leader_mean` 4.2 seconds lower than the conservative cluster, but `std_lap_time` is 0.31s higher — aggressive strategies gain position but sacrifice consistency. The Cohen's d for `degradation_rate` between clusters is >1.5, confirming it's the primary differentiator.

**Why this matters:** This is analytics triggered by visual interaction — not a pre-computed static result, but a backend computation (`POST /api/tsne/analyze-selection`) that runs on the user-selected subset. The strategist can iteratively refine their selection to test hypotheses about what separates winning from losing strategies.

**VA principle demonstrated:** Composite interaction (lasso → backend computation → visual result) as described in VA_09 slides.

---

## Insight 3 — Bidirectional Coordination Reveals Sector-Specific Tyre Degradation

**How to reproduce:** In the Docked Layout, open StrategyTimeline and LapTimeChart side by side. Click a stint bar on the StrategyTimeline.

**What the system reveals:** Clicking a stint on the StrategyTimeline sets `selectedLapRange` in the store, which filters the LapTimeChart to show only those laps. The resulting lap time curve for the filtered range shows a clear upward slope in the final third of long stints (>15 laps on Hard compound), with the degradation concentrated in sector 3. Cross-referencing with the SectorsPanel confirms that sector 3 times increase by 0.4-0.8s while sectors 1 and 2 remain stable.

**Why this matters:** Aggregate tyre degradation statistics mask the sector-level reality. The bidirectional coordination between StrategyTimeline → LapTimeChart reveals that degradation is spatially non-uniform, which directly affects the optimal pit window calculation (a strategist must consider where on the track the tyre gives up performance, not just the average).

**VA principle demonstrated:** Bidirectional view coordination enabling insight discovery that neither view alone could provide.

---

## Insight 4 — LSTM Predictions Diverge from Linear Extrapolation at Stint Boundaries

**How to reproduce:** Double-click a driver in the Leaderboard to trigger LSTM prediction. Compare the dashed prediction line on the LapTimeChart with a mental linear extrapolation of the recent trend.

**What the system reveals:** The LSTM model, trained on historical lap sequences, predicts a non-linear lap time increase in the 2-3 laps before an expected pit stop (when tyre life exceeds ~80% of historical stint length for that compound). This divergence from linear extrapolation is most visible on Soft compound stints: the LSTM predicts a 0.3-0.5s/lap degradation cliff that a linear model would miss.

**Why this matters:** Pit window decisions hinge on predicting exactly when lap times will spike. The LSTM captures the non-linear tyre degradation curve that domain experts know exists but linear regression models cannot represent. The visual overlay on the LapTimeChart lets the strategist see both the data and the prediction simultaneously, building trust in the model.

**VA principle demonstrated:** ML prediction integrated into the visual analytics pipeline, triggered by user interaction (double-click on leaderboard).

---

## Insight 5 — Position Tracker Brush Reveals Undercut Timing Windows

**How to reproduce:** Open the Position Tracker (PositionByLap) in the Docked Layout. Brush a lap range around a position crossover between two drivers. The LapTimeChart filters to that range via `brushLapRange`.

**What the system reveals:** By brushing the 3-4 lap window where two drivers exchange positions, the filtered LapTimeChart shows the exact lap time differential that enabled the overtake. In undercut scenarios, the driver who pits first shows a 1.5-2.5s lap time improvement on the out-lap (fresh tyres + low fuel) compared to the driver still on old tyres. The crossover point — where cumulative time lost in the pit stop equals time gained from fresh tyres — is visible as the intersection of the two drivers' lap time curves.

**Why this matters:** The PositionByLap chart's brush-to-LapTimeChart coordination provides a "time microscope" for analyzing overtakes. Instead of scrolling through 50+ laps of data, the strategist can visually identify the position change and immediately zoom into the causal lap time differential.

**VA principle demonstrated:** Coordinated brush interaction across views enabling progressive refinement of analysis scope (overview → focus → detail).
