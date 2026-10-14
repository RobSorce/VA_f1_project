# Analytics Provenance

This document explicitly catalogs every analytical computation in the F1 Race Strategy Dashboard,
distinguishing genuine data-driven analytics from fallback constants and any mock components.

## Verification methodology
Each row was verified by code inspection on 2026-04-16 against branch `v4`.
The verification scripts and raw audit reports are available in `/tmp/audit{1,2,3}_*.md`.

## Computations Catalog

| # | Computation | Source File | Data Origin | Status | Notes |
|---|---|---|---|---|---|
| 1 | Pit stop time loss (mean, stdDev) | `raceSimulation.js::extractRaceParams` | Observed pit laps minus median clean lap, per driver | REAL (FALLBACK 22s only when zero pit observations) | Used in MC pit decisions |
| 2 | Tyre degradation per compound | `raceSimulation.js::raceDegradation` (via `extractRaceParams`) | Per-stint fuel-corrected fits (`utils/degradation.js`) with at least `PRIORS.degradation[c].minFitLaps` clean laps, combined with the cached races' mean (normal-normal, weights from the within / between race spread, `computePriors`); negative fits kept and counted | REAL (the cached races' prior, labelled, until a fit is long enough) | Used in MC pace projection; evidence `notes/experiments/degradation_in_race.txt` |
| 3 | Stint length distribution per compound | `raceSimulation.js::extractRaceParams` | Observed completed stints (StartLap-EndLap) | REAL (FALLBACK 25 laps only when no stints observed) | Used in MC pit timing |
| 4 | Lap-to-lap noise stdDev | `raceSimulation.js::lapNoiseFromFits` | Pooled residual sigma of the race's stint fits, combined with the dry / wet prior of the cached races (`PRIORS.lapNoise`, conjugate update) | REAL (prior alone before the first fit) | Used in MC lap time sampling |
| 5 | Safety car rate and duration | `raceSimulation.js::extractRaceParams` | Observed track_status events / current_lap | REAL (FALLBACK 0.02/lap only when no SC events) | Used in MC SC simulation |
| 6 | Fresh tyre delta | `raceSimulation.js::extractRaceParams` | Mean(tyreLife<=2 laps) vs mean(tyreLife 5-10) | REAL | Used in MC fresh-tyre boost |
| 7 | Race finish projections (`DEFAULT_NUM_SIMULATIONS` = 1,000 seeded MC runs, Web Worker) | `raceSimulation.js::simulateRaceFinish` via `useF1Store.js::computeRaceProjection` (the only writer of `raceProjection`) | All above + driver features from PCA | REAL | Aggregated to expectedPos, posRange, podiumProb; badges with a Wilson interval + hysteresis (`simulationClient.js`), stability in `notes/experiments/mc_benchmark.txt` section 5 |
| 8 | Battle probabilities | `raceSimulation.js::aggregateResults` | Count overtakes across the runs, every pair within 4 positions | REAL | Listed battles: `simulationClient.js::listedBattles` (6 rows; a pair enters / leaves only when its interval clears the cut's) |
| 9 | Risk identification | `raceSimulation.js::identifyRisks` | MC variance + observed paceTrend + tyre limits | REAL | HIGH_VARIANCE, EXTRA_STOP, DEGRADATION, TYRE_CLIFF |
| 10 | PCA cross-race embeddings | Backend `/api/pca/embeddings` | scikit-learn StandardScaler + PCA on 17 features x ~24 sessions | REAL | Pre-computed, served as JSON |
| 11 | Cohen's d feature importance | `StrategyAnalysis.jsx::cohensD` + backend on lasso | `|selMean - restMean| / pooledStdDev` | REAL | Standard statistical effect size |
| 12 | Live PCA (Race Situation) | `livePCA.js` | Standardize -> covariance -> Jacobi eigen -> PC projection | REAL | Frozen basis after lap 8 + Procrustes alignment |
| 13 | Tyre degradation regression (brushed) | Backend `/api/predict/degradation` | Linear regression on user-brushed lap range | REAL | Returns slope, R-squared, n_points |
| 14 | LSTM lap time forecast | Backend `/api/predict/lstm` via `model/predict.py` | PyTorch 2-layer LSTM (64->32->Dense), 12 features, 10-lap window, trained 92 epochs | **REAL LSTM** | Fallback chain: model -> mean -> heuristic; `summary` field reports which was used |
| 15 | Strategy Simulator (what-if) | `useF1Store.js::runSimulation` → `raceSimulation.js::compareStrategies` | Baseline and plan, `DEFAULT_NUM_SIMULATIONS` runs each from the same seed (common random numbers): an identical plan differs by exactly 0 | **REAL DUAL MC** | Delta = baselinePos - customPos |
| 16 | Gemini AI strategy responses | Backend `/api/gemini/strategy` | Google Gemini 2.0 Flash via `google-genai` SDK | **REAL GEMINI** (with safe fallback) | When API unavailable: returns data-driven template with `is_mock: True` flag and visible warning prefix |
| 17 | Insights feed | `insightsGenerator.js` | Composes from #7-9, #11-13, #14 (battles: the listed ones with a gold / green badge) | DERIVED | Natural language wrappers around real computations |

## LSTM Architecture Detail

```
Input:  (batch, 10, 12)  -- 10-lap sliding window, 12 features per lap
        Features: lap_time, sector1, sector2, sector3, compound, tyre_life,
                  fuel_estimate, track_temp, position, gap_to_leader, gap_ahead, drs

Layer 1: nn.LSTM(12, 64, batch_first=True) + Dropout(0.2)
Layer 2: nn.LSTM(64, 32, batch_first=True) + Dropout(0.2)
Output:  nn.Linear(32, 6) -- 5 predicted lap times + 1 pit probability logit

Loss: MSE(lap_times) + 2.0 * BCE(pit_logit)
Training: 92 epochs (early stopping), batch_size=64, AdamW optimizer
Data: StandardScaler normalization, saved as scaler.pkl
```

Model file: `backend/model/saved/lstm_model.pt` (135KB, trained 2025-02-24)

## Fallback Behavior Summary

The Monte Carlo simulation has explicit fallback constants for cases when observed data is insufficient
(e.g., a compound never used in the session). These fallbacks are documented in `raceSimulation.js`:

```js
const FALLBACK_PIT_LOSS = { mean: 22, stdDev: 2 };
const FALLBACK_SC_RATE = 0.02;
const FALLBACK_SC_DURATION = 4;
const FALLBACK_DEG = { mean: 0.04, stdDev: 0.02 };
const FALLBACK_STINT = { mean: 25, stdDev: 5 };
const FALLBACK_LAP_NOISE = 0.3;
const FALLBACK_FRESH_DELTA = -0.4;
```

**Fallbacks are activated only per-compound or per-event when observed data is zero.** The system always
prefers real observations. This is the same pattern used in academic Monte Carlo modeling -- a Bayesian
prior that yields to the observed posterior as data accumulates.

## Visual Analytics Loop Compliance

Every computation above is part of the VA loop (data -> models -> visualization -> interaction -> models):

- **Trigger 1:** Lasso on PCA Biplot -> Cohen's d feature importance (computation #11)
- **Trigger 2:** Brush on LapTimeChart / click on stint -> Degradation regression (computation #13)
- **Trigger 3:** Double-click on driver -> LSTM forecast (computation #14)
- **Continuous:** Live PCA recomputed every 3 laps (computation #12)
- **Continuous:** Monte Carlo recomputed every 3 laps after lap 5 (computations #7-9)

This satisfies the course requirement of "analytics triggered by visual interactions" with multiple
distinct trigger types and computation pipelines.

## Honesty Statement

This project does NOT make any of the following analytical claims that it cannot back up:
- We do not claim deep learning where statistical regression is used
- We do not claim AI insights when fallback templates are returned
- All numeric outputs in the UI trace back to either observed data or explicitly documented fallbacks
- The Gemini AI assistant requires API key configuration; without it, the system shows a clear warning
  rather than synthesized fake responses (mock responses carry `is_mock: True` and a visible prefix)
- The LSTM prediction endpoint reports which method was used in its `summary` field
