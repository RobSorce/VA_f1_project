# PCA Feature Matrix Documentation

## Overview

The PCA projection uses 17 numerical features per (driver, race) observation. Features are extracted from FastF1 session data by `backend/data/processors/tsne_features.py` and standardized with `sklearn.preprocessing.StandardScaler` before PCA computation in `backend/data/processors/tsne_compute.py`.

The feature matrix contains 499 observations from 24 cached F1 sessions (2023-2024 seasons).

## Feature Descriptions

### Pace Features (6)

| Feature | Unit | Description | Rationale |
|---------|------|-------------|-----------|
| `avg_lap_time` | seconds | Mean lap time excluding outliers (pit laps, SC laps, first lap) | Core performance metric — captures overall race pace |
| `std_lap_time` | seconds | Standard deviation of clean lap times | Consistency indicator — low std = stable pace management |
| `best_lap_time` | seconds | Fastest single lap in the race | Peak performance capability |
| `rolling_pace_3` | seconds | Rolling mean of last 3 clean laps (at race end) | Recent pace trend — captures end-of-race performance |
| `rolling_pace_5` | seconds | Rolling mean of last 5 clean laps (at race end) | Smoothed recent pace — less noisy than rolling_pace_3 |
| `gap_to_leader_mean` | seconds | Mean time gap to race leader across all laps | Relative performance — how far behind the leader on average |

### Sector Balance (3)

| Feature | Unit | Description | Rationale |
|---------|------|-------------|-----------|
| `avg_sector1` | seconds | Mean sector 1 time | Sector-level performance profiling |
| `avg_sector2` | seconds | Mean sector 2 time | Different sectors stress different car characteristics (traction, top speed, aero) |
| `avg_sector3` | seconds | Mean sector 3 time | Sector balance reveals setup philosophy and driver style |

### Strategy Features (4)

| Feature | Unit | Description | Rationale |
|---------|------|-------------|-----------|
| `pit_count` | count | Number of pit stops | Primary strategy dimension (1-stop vs 2-stop vs 3-stop) |
| `stint_count` | count | Number of distinct tyre stints | Related to pit_count but captures anomalies (red flags, punctures) |
| `avg_stint_length` | laps | Mean number of laps per stint | Captures tyre management philosophy (push vs conserve) |
| `max_stint_length` | laps | Longest single stint | Identifies the "anchor stint" that defines the strategy window |

### Tyre Performance (1)

| Feature | Unit | Description | Rationale |
|---------|------|-------------|-----------|
| `degradation_rate` | seconds/lap | Linear regression slope of lap time vs tyre life | Quantifies how quickly the driver loses pace as tyres wear — key for pit timing |

### Starting Position (1)

| Feature | Unit | Description | Rationale |
|---------|------|-------------|-----------|
| `grid_position` | position (1-20) | Qualifying result / starting grid slot | Constrains strategy options (front-runners vs midfield vs backmarkers face different strategic landscapes). This is an INPUT to the race, not an outcome. |

### Environmental (2)

| Feature | Unit | Description | Rationale |
|---------|------|-------------|-----------|
| `track_temp` | Celsius | Track surface temperature at race start | Affects tyre degradation rates and optimal compound choice |
| `air_temp` | Celsius | Air temperature at race start | Correlated with track temp; affects engine cooling and aero performance |

## Excluded Features (Data Leakage Prevention)

The following features are computed by `tsne_features.py` but **explicitly excluded** from the PCA feature matrix to prevent data leakage:

| Feature | Reason for Exclusion |
|---------|---------------------|
| `finish_position` | **Direct race outcome.** Including this would cause PCA clusters to reflect final results rather than strategic behavior. The clustering would be trivially correlated with success/failure. |
| `position_change` | **Derived from outcome** (`grid_position - finish_position`). Same leakage risk as `finish_position`. |
| `fuel_corrected_pace` | **Always NaN** in our dataset (fuel load data not available from FastF1 disk cache). Excluded to avoid NaN propagation. |

## Standardization

All 17 features are standardized using `sklearn.preprocessing.StandardScaler` (zero mean, unit variance) before PCA. This is necessary because features have different units and scales (seconds vs counts vs Celsius). Without standardization, high-magnitude features (e.g., `avg_lap_time` ~90s) would dominate over low-magnitude features (e.g., `pit_count` ~2).

The scaler is fitted on the full dataset and cached at `backend/data/processed/tsne_scaler.pkl`.

## PCA Results

- **Method:** `sklearn.decomposition.PCA(n_components=2, random_state=42)`
- **Explained variance ratio:** Stored in `pca_embeddings.json` alongside loadings
- **Loading vectors:** The biplot displays arrows for each feature's contribution to PC1 and PC2, enabling interpretation of the axes
- **Expected interpretation:** PC1 typically captures the pace-consistency trade-off; PC2 captures strategy aggressiveness (short stints + more stops vs long stints + fewer stops). Exact loadings vary with dataset composition.

## Validation

To verify no leakage exists, the following assertions should hold:

```python
from sklearn.decomposition import PCA
import pandas as pd

X = pd.read_csv('backend/data/processed/tsne_feature_matrix.csv')
assert 'finish_position' not in FEATURE_COLS
assert 'position_change' not in FEATURE_COLS
assert 'fuel_corrected_pace' not in FEATURE_COLS

# Variance explained: 2 PCs should explain 40-70% of variance
# >90% suggests feature redundancy; <30% suggests features are too heterogeneous
pca = PCA(n_components=2).fit(StandardScaler().fit_transform(X[FEATURE_COLS]))
ratio = pca.explained_variance_ratio_.sum()
assert 0.30 < ratio < 0.90, f"Explained variance {ratio:.2%} outside expected range"
```
