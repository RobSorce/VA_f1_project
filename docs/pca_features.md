# PCA feature matrix

The feature dictionary of the cross-race PCA is `docs/PCA_METHODOLOGY.md`, section 1 "The cross-race feature space": every feature with its definition and unit, the eligibility rule of a (driver, race) row, and what is deliberately left out of the matrix (stint count, temperatures, absolute times, the race outcome) and why.

The code that builds it is `backend/data/processors/pca_compute.py`:

- `FEATURE_COLS`: the features, in matrix order; `FEATURE_LABELS`: their readable names, units and "better" direction.
- `build_feature_matrix_from_cache`: one row per (driver, race) of the cached race sessions, saved as `backend/data/processed/pca_feature_matrix.csv`.
- `compute_pca`: StandardScaler, then PCA with two components, saved as `backend/data/processed/pca_embeddings.json`; `pca_embeddings_at`: the biplot during a replay (basis fitted without the race on screen, its rows at the replay clock).

Rebuild and report (rows, races, excluded pairs, explained variance, loadings): from `backend/`, `python -m scripts.pca_rebuild`.

An earlier version of this page described a larger feature set built by `tsne_features.py` and `tsne_compute.py`; those modules and the t-SNE projection were removed (`docs/PCA_METHODOLOGY.md`, section 2 "Why PCA and not t-SNE").
