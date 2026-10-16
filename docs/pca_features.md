# PCA feature matrix

The feature dictionary of the cross-race PCA is `docs/PCA_METHODOLOGY.md`, section 1 "The cross-race feature space": every feature with its definition and unit, the eligibility rule of a (driver, race) row, what is deliberately left out of the matrix (stint count, temperatures, absolute times, the race outcome) and why, and the explained variance and race share (eta-squared) of every component.

The code that builds it is `backend/data/processors/pca_compute.py`:

- `FEATURE_COLS`: the 12 features, in matrix order; `FEATURE_LABELS`: their readable names, units and "better" direction; `FEATURE_CATEGORY`: the aspect each one describes (one per summary sentence and cluster label).
- `MIN_LAP_SHARE` (0.9 of the leader's laps), `MIN_CLEAN_LAPS` (5) and `RECENT_LAPS` (5): the assumptions of the eligibility rule and of the recent-pace feature.
- `race_feature_rows`: the eligible rows of one race at a clock (`session_now`; none = post-race), from its cached session payload; `visible_stints`: a driver's stints visible at that clock.
- `build_feature_matrix_from_cache`: one post-race row per (driver, race) of the cached race sessions (`backend/data/processed_cache/session_*_R.json`), saved as `backend/data/processed/pca_feature_matrix.csv`.
- `fit_pca`: median fill, `StandardScaler`, then `PCA(n_components=2)` with a fixed sign rule; `compute_pca`: that fit over every row, saved as `backend/data/processed/pca_embeddings.json`; `load_pca_embeddings`: that file, built when missing.
- `pca_embeddings_at`: the biplot during a replay (basis fitted without the race on screen, `_fit_without`; its rows at the replay clock, `current_race_rows`).
- `analyze_selection`: the descriptive comparison of a lasso selection (`docs/PCA_METHODOLOGY.md`, section 5).

Routes (`backend/api/main.py`): `GET /api/pca/embeddings`, `POST /api/pca/analyze-selection`, `GET /api/pca/point-features/{point_id}` (the feature values of one post-race row).

Rebuild and report (rows, races, excluded pairs, explained variance, eta-squared of the race, loadings), from `backend/`: `python -m scripts.pca_rebuild --out ../docs/evidence/pca_rebuild.txt`. The report of every component is `python -m scripts.pca_diagnostic --out ../docs/evidence/pca_diagnostic.txt`.
