# Analytics Provenance

Every analytical computation of the dashboard, where it is computed, what it is computed from, and which of its values are measured on the race and which are labelled priors or assumptions. Every number below is printed by a script whose output is saved under `docs/evidence/` (index: `docs/evidence/README.md`); the file is named next to the number.

Status words: **MEASURED** = computed from the session's data at the replay clock (only the laps completed by then); **PRIOR** = a value measured over the 30 cached races, used and labelled as such until the race has data of its own; **ASSUMPTION** = a fixed constant that is not measured, named in the code and in the help; **MODEL** = a fitted statistical or learned model; **HEURISTIC** = a rule of a view, with its constants in its help.

## Computations catalog

### Race model (Monte Carlo) and its inputs — `frontend/src/utils/raceSimulation.js`

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 1 | Pit-stop time loss | `utils/pitLoss.js` `estimatePitLoss` | Each green-flag stop of the race: in-lap + out-lap minus twice the driver's green-flag median lap; the median over the stops so far | MEASURED (a 22 s fallback, spread 2.5 s, before the first valid stop, shown as "fallback": `FALLBACK_PIT_LOSS`, ASSUMPTION) | The same definition as `backend/scripts/validate_pit_loss_and_rejoin.py`: Monza 2024 median 26.8 s (`validate_pit_loss_and_rejoin.txt`, row `2024_16`, column `true_loss`; the estimator's rejoin backtest is its row `causal_fixed`, not `current_code`, an earlier in-lap-only estimate). Race and sprint sessions only. |
| 2 | Tyre degradation per compound | `raceDegradation`, from `utils/degradation.js` `stintFits` | Per-stint fuel-corrected fits with at least `minFitLaps` clean laps (SOFT 8, MEDIUM 13, HARD 15), combined with the cached races' mean (normal-normal, weights from the within / between race spread); negative fits kept and counted | MEASURED + PRIOR (the prior alone until a fit is long enough) | `degradation_in_race.txt`, sections A-B; the fit itself: `docs/DEGRADATION_METHODOLOGY.md`. The fuel effect 0.03 s/lap is an ASSUMPTION. |
| 3 | Lap-to-lap noise | `lapNoiseFromFits` | Pooled residual sigma of the race's per-stint fits at the clock, shown with its n (clean laps) | MEASURED (the cached races' dry 0.408 s / wet 1.031 s, labelled prior, only before the race's first fit) | `s2_lap_noise_monza.txt` (Monza 2024: 0.436, 0.402, 0.381 s at the leader's laps 20, 30, 40), `degradation_in_race.txt` section C |
| 4 | Fresh-tyre delta | `freshDeltaEstimate` | The first flying lap on a new set against that stint's own tyre-age line, paired within driver and stint, fuel-corrected, at most 0 | MEASURED (prior -0.140 s over 501 stints before the race has one) | `mc_benchmark.txt`, section 1 |
| 5 | Stint life per compound | `stintLifeEstimate` (Kaplan-Meier) | Tyre age at each tyre change; running stints and stints to the flag censored, a retired driver's last stint dropped | MEASURED (past the race's longest stint, the prior's tail; prior medians SOFT 17, MEDIUM 21, HARD 34 laps) | `mc_benchmark.txt`, section 1. Also gives a car's laps to its likely stop (Race Situation features, the Circle of Doom's "rivals stop"). |
| 6 | Safety-car rate and length | `safetyCarEstimate` | Episodes (runs of SC / VSC / red periods) started by the clock, per leader lap, shrunk toward the prior with the weight of one race | MEASURED + PRIOR (1 episode per 60.6 laps over the cached races) | `mc_benchmark.txt`, section 1 |
| 7 | Race finish projection | `simulateRaceFinish` via store `computeRaceProjection` (Web Worker, `utils/simulationClient.js`) | 1-6 above and each driver's state at the clock (position, gap, pace of the last 3 clean laps, tyre: `utils/raceSituationFeatures.js`); `DEFAULT_NUM_SIMULATIONS` = 1,000 seeded runs to the flag | MODEL | Median finishing position (the P label), P5-P95, podium probability. Every mark changes only beyond the Monte Carlo error (Wilson intervals with hysteresis): on a new seed a P label changes in 3.58 % of 810 recomputes (`mc_stability.txt`). Recomputed with the race situation, every lap from lap 5, race sessions only. |
| 8 | Battle probabilities | `aggregateResults` | Share of the runs in which the car behind finishes ahead, every pair within 4 positions | MODEL | The listed battles and their badges (`simulationClient.js` `listedBattles`, `BATTLE_LIST_SIZE` = 6): a pair enters or leaves only beyond the Monte Carlo error (`mc_stability.txt`, `battle_list_rules.txt`) |
| 9 | Risks | `evaluateRisks` / `identifyRisks` | The runs' spread and extra stops, the pace trend and the tyre limits | MODEL + HEURISTIC thresholds | Types EXTRA STOP, TYRE CLIFF, HIGH VARIANCE, DEGRADATION, with their severity |
| 10 | Strategy Simulator (what-if) | store `runSimulation` -> `simulationClient.js` `runSimulationJob('compare')` -> `compareStrategies` | Baseline and plan, 1,000 runs each from the same seed (common random numbers): an identical plan differs by exactly 0 | MODEL | Δ position = the mean of the run-by-run differences with its Monte Carlo error; verdict, P labels and colours only beyond that error (`whatIfMarks`): the verdict changes in 1.82 % of 3240 chained recomputes (`whatif_stability.txt`) |

The priors of rows 2-6 are measured over the 30 cached races by `computePriors` and frozen in `PRIORS` (`frontend/scripts/mc_benchmark.mjs`, `mc_benchmark.txt`: "raceSimulation.js PRIORS equal to this: true"). Two numeric guards are not data: a drawn pit loss is kept above 5 s and its sampling spread above 0.5 s (`PIT_LOSS_NUMERIC_FLOOR`, `PIT_LOSS_SAMPLING_MIN_SD`).

### Circle of Doom — `frontend/src/utils/circleOfDoom.js`, `frontend/src/utils/undercut.js`

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 11 | Reference lap and positions on the ring | `referenceLap`, `phases`, `circleState` | Median of the clean green laps of every driver over the leader's last 5 laps (widened back until 10 laps qualify); each car's time since its last line crossing over the reference lap | MEASURED | The circle is one lap in seconds: the angle between two cars is their time gap. |
| 12 | Pit window of the focus car | `pitWindow` | Its line crossing at the end of the out-lap if it pitted now (last crossing + 2 × its pace of the last 5 clean laps + the race's median pit loss), ranked against the other cars' crossings of that lap (actual, or projected at their own pace with their pending pit loss) | MEASURED (pit loss as row 1) | Backtest on 709 green stops of 30 races, prediction at the end of lap n - 1: rank exact 46.7 %, within one place 72.8 %; the validation script's rule on the same stops, which knows the rivals' own later stops, 71.1 % / 88.3 % (`cod_backtest.txt`). Also: the cars a stop now would lose places to, the cars that would drop behind if they pitted (the undercut threshold, equal paces), the lapped traffic inside the band. |
| 13 | Rejoin-position probabilities | `rejoinDistribution` | 1,000 seeded draws of the pit loss (bootstrap of the race's measured stops; normal(22, 2.5) with the fallback), each re-ranked | MODEL | Covers the pit-loss uncertainty only: mean probability given to the actual position 0.452 over the 709 stops, 0.825 on the 110 stops with no rival stop before the rejoin (`cod_backtest.txt`) |
| 14 | Traffic flag at the rejoin | `pitWindow` (traffic), share of draws in `rejoinDistribution` | The projected crossing less than 1.0 s (`TRAFFIC_GAP_S`, ASSUMPTION) behind another car's crossing, on any lap | MODEL | Raised on 15.0 % of the 709 backtest stops (`cod_backtest.txt`) |
| 15 | Pit in k laps | `undercut.js` `pitInLaps` | The pit window k = 0 to 10 laps later: the window's paces up to its target lap, then the lap model of the race simulation (rows 2, 4; with "rivals stop", the other cars stop at their likely laps, row 5) | MODEL | Monza 2024 table at the end of lap 12: `c4_pit_in_k_monza.txt`; k = 1 to 5 against the actual stops: `cod_backtest.txt` ("Pit in k laps") |

The Undercut Calculator's pit-lap sweep (`undercut.js` `undercutSweep`, the gap to a rival at the flag for each candidate in-lap) shares rows 1-5 and 12; its view (`UndercutCalculator.jsx`) is in `App.jsx`'s view map but not in the dock registry, so no control opens it.

### Cross-race PCA and the lasso analysis — `backend/data/processors/pca_compute.py`

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 16 | PCA embeddings | `GET /api/pca/embeddings` (`compute_pca`, `pca_embeddings_at`) | scikit-learn `StandardScaler` + PCA on 12 features x 534 (driver, race) rows of 30 cached races | MODEL | PC1 44.1 %, PC2 20.3 % of the variance (`pca_rebuild.txt`). During a replay of a cached race its rows are taken at the replay clock, on axes fitted without it (`pca_clock_check.txt`). Method: `docs/PCA_METHODOLOGY.md`. |
| 17 | Lasso selection analysis | `POST /api/pca/analyze-selection` (`analyze_selection`), shown by `PCAAnalysisPanel.jsx` | Hedges' g per feature (selection against the other rows) with its 95 % normal-approximation interval (none for a group of one row), N, a seeded random-selection baseline and threshold, stratified by row kind during a replay, per-feature thresholds when the rows mix the two kinds | MODEL | Labelled "Descriptive differences, not a test" (`pca_interval_coverage.txt`, `pca_selection_baseline.txt`, `pca_stratified_baseline.txt`, `pca_mixed_threshold.txt`) |

The static demo (no backend) computes rows 16 (at a replay clock) and 17 in the browser with a port of the same module (`frontend/src/utils/pcaSelectionStats.js`; parity test `frontend/src/__tests__/demo.pcaSelectionStats.test.js`).

### Live race state — `frontend/src/utils/raceSituationFeatures.js`, `frontend/src/utils/livePCA.js`

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 18 | Race-state features | `extractRaceSituationFeatures` | Per driver at the clock: position, gap to the leader, recent pace and pace trend (clean racing laps), tyre age, stint number, position change; plus laps to the likely stop (row 5) and a predicted pace | MEASURED | Inputs of rows 7, 19 and 20 |
| 19 | Live PCA (Race Situation map) | `computePCA` | Standardize -> covariance -> Jacobi eigen -> PC projection of the 7 features, refitted every lap | MODEL | Axes turned inside the PC1-PC2 plane onto the previous lap's (orthogonal Procrustes, `LIVE_PCA_ALIGN`); dots, arrows and crosshair share that basis (`pca_repair_check.txt`, `live_pca_rewind.txt`) |
| 20 | Selection against the field | `StrategyAnalysis.jsx` (Cohen's d) | The race-state features of the selected drivers against the rest of the field (pooled standard deviation); features under 0.2 left out | MODEL | Descriptive, computed in the browser on a lasso or click on the map (or any driver selection) |

### Degradation and consistency — `frontend/src/utils/degradation.js` = `backend/data/processors/degradation.py`

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 21 | Per-stint degradation fit | `stintFits` (chart), `POST /api/predict/degradation` (brushed range, `stint_fits`) | OLS of the fuel-corrected lap time on tyre life over the stint's clean laps (at least 8) | MEASURED (fuel effect 0.03 s/lap and the 8-lap minimum: ASSUMPTIONS) | The endpoint returns per stint the slope (fuel-corrected and raw), intercept, n, residual sigma, slope standard error, a projected pit lap (1.5 s of fitted loss, ASSUMPTION) and an undercut window; the chart and the endpoint agree to 0 on 1135 stint rows (`g1_store_endpoint_vs_chart.txt`). Definition and numbers: `docs/DEGRADATION_METHODOLOGY.md`, `degradation_definition_monza.txt`. |
| 22 | Consistency sigma | `consistencySigma` (Consistency cards, Driver Comparison), `GET /api/analytics/consistency` | Pooled residual sigma of the driver's per-stint fits | MEASURED | Frontend and backend rows equal on 30 races x 3 clocks (`g5_consistency_parity.txt`) |

### Lap-time forecast and pit probability — `backend/model/predict.py`

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 23 | Lap-time forecast of the focus driver, next 5 laps | `POST /api/predict/lstm` (store `triggerPrediction`) | A 10-lap window of the driver's laps at the clock (`model/features.py` `build_window`, 12 features); the served method is the one with the lowest validation MAE (`model/saved/forecast_selection.json`, written by `backend/scripts/evaluate_forecast.py`): LSTM, persistence, last clean lap + compound mean degradation, per-stint linear extrapolation | MODEL | The LSTM is served (validation MAE 0.508 s); held-out test MAE over laps +1..+5: LSTM 0.608 s, compound mean 0.630 s, persistence 0.637 s, stint linear 0.749 s (`evaluate_forecast.txt`; 19 training, 4 validation, 7 test races). Every response names its method. |
| 24 | Pit probability within 5 laps | same route | The served method by Brier score on the validation races: LSTM, tyre-age logistic regression, base rate | MODEL | Test Brier: LSTM 0.1147, logistic 0.1156, base rate 0.1187 (`evaluate_forecast.txt`) |

The LSTM (`model/train.py`): two LSTM layers (64 and 32 units, dropout 0.2 after each) and a dense layer of 6 outputs, the 5 lap times as deltas to the last clean lap of the window and 1 pit-stop logit; loss L1 on the lap times plus BCE on the pit logit; Adam with early stopping on the validation loss (`model/saved/model_config.json`: 13 epochs trained, best epoch 3).

### Other views

| # | Computation | Code | Data origin | Status | Notes |
|---|---|---|---|---|---|
| 25 | Championship projection | `GET /api/championship/{year}` (`backend/api/main.py`) | Points so far + the weighted mean of the last 5 rounds' points (weights 1 to 5) x the rounds left, from round 3 | HEURISTIC | A point estimate, no interval |
| 26 | Tyre Health | `TyreHealth.jsx` | Tyre age over a fixed life per compound and the pace loss within the stint | HEURISTIC | Constants in its help (`chartHelp.js` `tyrehealth`) |
| 27 | Pace Retention | `TyreManagement.jsx` | Each lap against the median of the stint's laps 2 to 4 | HEURISTIC | Raw lap times (fuel burn included) |
| 28 | Position Tracker "PIT WINDOW" band | `PositionByLap.jsx` `computeUndercutWindow` | Drawn when the car ahead's tyres are at least 3 laps older than the focus driver's, over that many laps (at most 8) | HEURISTIC | |
| 29 | Insights feed | `utils/insightsGenerator.js` (Strategy Analysis) | Text built from rows 7-9, 17, 18 and 23 | DERIVED | Its degradation insight reads fields the degradation endpoint does not return (`regressions`, `r_squared`), so it is never shown (`docs/DEGRADATION_METHODOLOGY.md`, "Consumers") |

## Analytics triggered by visual interaction

The computations run because of an interaction on a view, at the replay clock (the coordination behind them: `docs/COORDINATION_GRAPH.md`, "Analytics triggered by visual interaction"). A click that only selects, focuses or highlights a driver is coordination, not an analytic, and is not listed.

- **Lasso or click on the PCA biplot** -> the lasso analysis, row 17, drawn in the Cross-Race Analysis panel and on the Strategy Timeline.
- **Lasso or click on the Race Situation map** -> the selection against the field, row 20, in Strategy Analysis.
- **Lap range brushed or selected** (Position Tracker brush, Timing Sheet bar, stint, pit window, race event) -> the degradation fit of that range, row 21, in Tyre Degradation.
- **Double-click a driver** (Leaderboard, Timing Sheet, Race Pace Grid) or `Shift+P` -> the forecast and pit probability, rows 23-24, in Race Prediction and the Timing Sheet's forecast rows.
- **Click a car on the Circle of Doom** -> its pit window, rejoin probabilities and traffic flag, rows 12-14; `[` / `]` or the stepper -> pit in k laps, row 15; the "Rivals stop" toggle -> the same with the rivals' likely stops.
- **A plan edited in the Strategy Simulator** -> the what-if, row 10.

Recomputed with the replay clock rather than by an interaction: the race projection, battles and risks (rows 7-9, every lap from lap 5), the live PCA (row 19, every lap from lap 3).

## Honesty statement

- No number of the UI is an unlabelled constant: a value that is not measured on the race is a prior measured over the cached races (shown as "prior"), the pit-loss fallback (shown as "fallback"), or an assumption named in the code and in the help (the fuel effect, the minimum fit length, the traffic gap).
- The forecast names the method that made it and quotes the held-out error of every method; the LSTM is served only while it has the best validation error.
- Statistics of a selection (rows 17, 20) are descriptive differences, not significance tests.
