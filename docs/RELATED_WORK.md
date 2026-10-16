# Related Work

Every entry below names a source that can be opened (a URL or a DOI). The tools and projects this dashboard builds on are listed under [Credits](#credits).

## 1. F1 Broadcast & Commercial Systems

### F1 Live Timing (Formula 1)
The official F1 timing (the F1 app, and F1.com for F1 TV subscribers) shows a full leaderboard, track segment and driver telemetry data and an interactive circuit map with a real-time driver tracker. Our Leaderboard and TimingTower components adopt its visual language (position tower, interval/gap columns, compound dots). In this dashboard a click on a driver in the leaderboard selects it in every view that subscribes to the driver selection (`selectedDrivers`, `docs/COORDINATION_GRAPH.md`).

Source: Formula 1, "Improved Live Timing on F1.com for the 2022 season", https://www.formula1.com/en/latest/article/improved-live-timing-on-f1-com-for-the-2022-season.3Y1ipx839mv7xeteTqQ8Mk

### F1 Insights powered by AWS (Amazon Web Services)
AWS provides on-screen graphics during broadcasts, among them Tyre Performance, Pit Stop Strategy and Battle Forecast; the page calls Pit Stop Strategy, Time Lost and Track Dominance AI-powered. They are graphics embedded in the broadcast: the viewer cannot select drivers, adjust parameters, or explore alternative strategies. Our forecast and Strategy Simulator serve a similar analytical purpose but are interactive: the user triggers the lap-time forecast by double-clicking a driver and explores "what-if" scenarios in the Strategy Simulator panel.

Source: Amazon Web Services, "F1 Insights powered by AWS", https://aws.amazon.com/sports/f1/

## 2. Dimensionality Reduction in Visual Analytics

### Van der Maaten & Hinton — "Visualizing Data using t-SNE" (JMLR, 2008)
The paper that introduces t-SNE. Its cost function focuses on retaining the local structure of the data, and among its weaknesses (section 6.2) it names the non-convex cost function: the map depends on the optimization parameters and may differ each time t-SNE is run from a random start. Our system initially used t-SNE but migrated to PCA because: (a) PCA is a linear projection, so a distance along an axis means the same anywhere on the plot and inter-cluster comparisons are meaningful; (b) PCA axes are linear combinations of input features, enabling the biplot's loading vectors; (c) PCA is deterministic, ensuring consistency across sessions. t-SNE was later removed from the dashboard altogether: the PCA is its one projection (`docs/PCA_METHODOLOGY.md`, section 2 "Why PCA and not t-SNE").

Source: L. van der Maaten, G. Hinton, Journal of Machine Learning Research 9 (2008) 2579-2605, https://www.jmlr.org/papers/v9/vandermaaten08a.html

### Wattenberg, Viégas & Johnson — "How to Use t-SNE Effectively" (Distill, 2016)
This interactive article shows that t-SNE results depend strongly on its hyperparameters (the perplexity among them) and that cluster sizes and the distances between clusters in a t-SNE plot might not mean anything. This guided our decision to use PCA: in our use case (comparing race strategies), the user needs to reason about "how different are these two strategy clusters?", a question a t-SNE plot cannot answer.

Source: M. Wattenberg, F. Viégas, I. Johnson, Distill (2016), doi:10.23915/distill.00002, https://distill.pub/2016/misread-tsne/

### The PCA in this dashboard
The PCA biplot is part of the analysis flow, not a static preprocessing step. Its loading vectors show which features drive the clustering, and a lasso or a click on the biplot triggers a backend `analyze_selection()` call (`POST /api/pca/analyze-selection`) that compares the selected rows with the other rows feature by feature: Hedges' g effect sizes, each with a 95% normal-approximation interval (g +/- 1.96 SE, SE^2 = (n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)), the large-sample standard error of Hedges and Olkin 1985; a bootstrap would be degenerate for the one- or two-row selections a click or a short lasso makes) and the value random selections of the same size and the same mix of rows reach (during a replay, rows of the race on screen at the clock and rows of finished races; `docs/PCA_METHODOLOGY.md`, section 5). The same call returns the selection's common pit windows and stint patterns; the Cross-Race Analysis panel draws the comparison as a forest plot and the Strategy Timeline draws the selection's strategies.

Source: L. V. Hedges, I. Olkin, *Statistical Methods for Meta-Analysis*, Elsevier (1985), doi:10.1016/C2009-0-03396-0

## 3. Real-Time Dashboards and Interaction Design

### Few — "Information Dashboard Design" (2006)
Stephen Few's principles for dashboard design — no scrolling, maximum data-ink ratio, consistent grid layout, pre-attentive encoding for alerts — inform our layout: the dashboard fills the browser window and the page itself never scrolls; the views that scroll inside their own pane are listed, each with its reason, in `docs/SCROLL_JUSTIFICATIONS.md`. The leaderboard sidebar (the Timing Tower on the Pit Wall) follows his recommendation of keeping the most important overview always visible while detail views occupy the main area.

Source: S. Few, *Information Dashboard Design*, O'Reilly Media (2006), ISBN 0-596-10016-7, https://app.oreilly.com/pub/pr/1512

### Norman — "The Design of Everyday Things" (revised and expanded edition, 2013)
Norman's action cycle (gulf of execution + gulf of evaluation) guides our interaction model. For execution: interactive elements show their affordance (hover effects, cursor changes, keyboard hints). For evaluation: an action produces immediate visual feedback, for example selecting a driver highlights them in every view that subscribes to the selection. The bidirectional coordination shows the effect of an action in the linked views, reducing the evaluation gulf.

Source: D. Norman, *The Design of Everyday Things*, revised and expanded edition, Basic Books (2013), ISBN 978-0-465-05065-9, https://www.hachettebookgroup.com/titles/don-norman/the-design-of-everyday-things/9780465050659/

### Shneiderman — "The Eyes Have It" (1996)
The visual information-seeking mantra (overview first, zoom and filter, details on demand) structures the dashboard: the Pit Wall gives the overview (timing tower, race pace grid, track map, Circle of Doom, race control feed); the docked layout enables zoom and filter (split panes of coordinated views that share one driver selection and one lap range); details are on demand in the tooltips, in the driver card shown for the driver under the pointer and in the help of each view.

Source: B. Shneiderman, "The eyes have it: a task by data type taxonomy for information visualizations", Proceedings 1996 IEEE Symposium on Visual Languages, 336-343, doi:10.1109/VL.1996.545307

## 4. Comparison Summary

| System | Interactive | DR | Prediction | Bidirectional Coord. | Analytics on Interaction |
|--------|-------------|-----|------------|----------------------|--------------------------|
| F1 Live Timing | Partly (interactive circuit map) | No | No | N/A | No |
| F1 Insights (AWS) | No | No | Yes (broadcast-only) | N/A | No |
| **Our system** | **Yes** | **PCA** | **LSTM + Monte Carlo** | **Yes (70 view pairs linked both ways)** | **Yes (lasso→analysis, double-click→forecast)** |

The 70 pairs are the rows of the table "Analysis views linked both ways" in `docs/COORDINATION_GRAPH.md`, generated from the code by `frontend/scripts/coordination_matrix.mjs`.

Our system differentiates itself by combining all five capabilities — interactive exploration, dimensionality reduction with interpretable axes, predictive modeling, bidirectional multi-view coordination, and analytics triggered by visual interaction — in a single integrated dashboard.

## Credits

- **FastF1** (theOehrly, MIT licence), https://github.com/theOehrly/Fast-F1, documentation https://docs.fastf1.dev: the backend reads the sessions, laps, telemetry, schedules and results of past sessions through it (`backend/data/extractors/fastf1_extractor.py`); live sessions come through the backend's own live-timing clients (`backend/live/`).
- **f1-race-replay** (IAmTomShaw, MIT licence), https://github.com/IAmTomShaw/f1-race-replay: the replay frames built by `extract_race_frames` (`backend/data/extractors/fastf1_extractor.py`) reuse its frame format, as the function's docstring says.
- **MultiViewer, Circle of Doom**, https://multiviewer.app/changelog (introduced in v2.8.0, 24 Jul 2026; changed in v2.9.0, 26 Sep 2026): the inspiration of the Circle of Doom view. In ours, the pit loss comes from an estimator checked on the cached races (`backend/scripts/validate_pit_loss_and_rejoin.py`, `docs/evidence/validate_pit_loss_and_rejoin.txt`: the dashboard's estimator, `frontend/src/utils/pitLoss.js`, is the row `causal_fixed`, with which the script's rejoin rule predicts the exact position of 71% of the 709 green-flag stops, and its median over a whole race is the column `true_loss`; the row `current_code` is the earlier in-lap-only estimate, 33%, kept in the output for comparison); it gives the probability of each rejoin position; it projects the rejoin of a stop k laps later ("pit in k laps"); and it is coordinated with the rest of the dashboard (focus, hover and selection go through the shared store, `docs/COORDINATION_GRAPH.md`).
