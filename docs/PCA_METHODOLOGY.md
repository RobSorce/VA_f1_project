# PCA Methodology

## 1. The Feature Space

Each data point in the PCA biplot represents one (driver, race) pair. The feature matrix is built from historical session data cached in `backend/data/processed_cache/session_*_R.json`.

**17 features per observation:**

| Feature | Description | Unit |
|---------|------------|------|
| `avg_lap_time` | Mean lap time across the race | s |
| `std_lap_time` | Standard deviation of lap times (consistency) | s |
| `best_lap_time` | Fastest single lap | s |
| `avg_sector1` | Mean sector 1 time | s |
| `avg_sector2` | Mean sector 2 time | s |
| `avg_sector3` | Mean sector 3 time | s |
| `pit_count` | Number of pit stops | count |
| `stint_count` | Number of tyre stints | count |
| `avg_stint_length` | Mean laps per stint | laps |
| `max_stint_length` | Longest stint in the race | laps |
| `degradation_rate` | Tyre degradation slope (lap time vs tyre life) | %/lap |
| `grid_position` | Qualifying-determined starting position | rank |
| `gap_to_leader_mean` | Average gap to race leader | s |
| `rolling_pace_3` | Rolling pace over last 3 laps | s |
| `rolling_pace_5` | Rolling pace over last 5 laps | s |
| `track_temp` | Track surface temperature | C |
| `air_temp` | Ambient air temperature | C |

**Removed features (data leakage):**
- `finish_position`: directly encodes the race outcome, making PC1 trivially equal to finishing order.
- `position_change`: derived from finish_position minus grid_position.
- `fuel_corrected_pace`: always NaN from disk cache; excluded.

All features are standardized (zero mean, unit variance) before PCA is applied.

## 2. Why PCA and Not t-SNE

Four reasons specific to this project:

1. **Interpretability via loadings.** PCA produces eigenvectors that we draw as biplot arrows. The strategist can read "PC1 is dominated by pace features, PC2 by tyre-life features" directly from the arrow directions. t-SNE has no such mapping: its axes are meaningless, and there are no loadings to display.

2. **Deterministic, stable axes.** PCA with a frozen basis (see `frontend/src/utils/livePCA.js`, `WARMUP_LAPS = 8`) produces stable axes that do not rotate between lap updates. After 8 warmup laps the eigenvectors and standardization parameters are frozen; subsequent updates only project new data onto the fixed axes. t-SNE is stochastic and would produce different layouts on every recomputation, making live strategy tracking during a race impossible.

3. **No false negatives.** PCA preserves Euclidean distances in the projection: two drivers with similar stint shapes in the high-dimensional feature space remain close in the 2D projection. t-SNE models similarity as conditional probabilities on local density and amplifies separations, meaning two genuinely similar drivers could end up far apart in the embedding (false negative). For strategy comparison, missing a similarity is more dangerous than a spurious proximity.

4. **Euclidean distance is the right metric.** The engineered features are all continuous numeric quantities measured on comparable scales (after standardization). The notion of "similar strategy profile" corresponds to Euclidean proximity in this space, which is exactly what PCA preserves.

## 3. Why Not UMAP or MDS

- **MDS** minimizes a stress function iteratively, is non-deterministic across runs, and introduces both false positives and false negatives. It is slower than PCA for live updates and offers no loading vectors for interpretation.
- **UMAP** shares the non-linearity and interpretability problems of t-SNE. While it preserves more global structure than t-SNE, its axes remain uninterpretable and it is non-deterministic.
- The course syllabus covers PCA, MDS, and t-SNE. UMAP is outside the scope of the lectures. PCA is the principled choice among the three taught techniques given the linear, interpretable feature space.

## 4. Trade-offs We Accept

PCA introduces **false positives**: two drivers that are far apart in the full 17-dimensional space can project close together in 2D if they differ primarily along dimensions not captured by PC1 and PC2. The biplot mitigates this by showing the loading vectors. If two points are close but separated along a loading arrow direction, the strategist can inspect the raw feature bars in the PCA Analysis Panel to disambiguate.

The first two principal components typically capture 55-75% of total variance in our dataset, depending on the race. The remaining variance is distributed across PC3-PC17. We display the explained variance ratio in the panel header so the user knows how much information the 2D view captures.

## 5. How PCA is Integrated in the Analysis Flow

This is the critical VA requirement: dimensionality reduction integrated in the analysis pipeline, with analytics triggered by visual interaction.

**The flow:**

1. **Data loading.** User selects a race. The backend computes the feature matrix over all historical (driver, race) observations from cached sessions, applies StandardScaler, fits PCA, and streams the 2D points with loadings to the frontend via `/api/pca/embeddings`.

2. **Biplot rendering.** `PCABiplot.jsx` renders points colored by team, with loading arrows showing feature contributions to each PC. The current race's drivers are highlighted with star markers.

3. **Lasso selection (visual interaction).** The user draws a freehand lasso around a region of interest on the biplot. On lasso release, the selected point IDs are written to `selectedTSNEPoints` in the Zustand store and sent to the backend via `POST /api/tsne/analyze-selection`.

4. **Backend analytics.** The backend computes over the lassoed subset:
   - Feature importance ranking (which features most differentiate the cluster from the rest, using Cohen's d effect size).
   - Common pit-stop windows across the selected driver-race observations.
   - Stint pattern summary (compound sequences, stint lengths).

5. **PCA Analysis Panel.** `PCAAnalysisPanel.jsx` / `StrategyAnalysis.jsx` displays the cluster analysis results. The user can click a pit window to set `selectedLapRange` in the store.

6. **Cross-view coordination.** When `selectedLapRange` is set, `LapTimeChart`, `TrackMap`, and `StrategyTimeline` all dim the out-of-range region, focusing the strategist on the laps of interest.

This chain (lasso on biplot -> backend cluster analysis -> cross-view highlighting) is analytics triggered by visual interaction, integrated in the analysis flow.
