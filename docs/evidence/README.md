# Evidence: script outputs

This folder holds the outputs of the measurement scripts that the documentation, the in-app help, code comments and tests cite. A number quoted in `docs/` comes with the file here that prints it and the script that writes that file. Each file is the output of its script's last run: every script was re-run on the code of 2026-10-16, except the three noted under their tables that stop with an error before they write (`mc_benchmark.mjs`, `pca_session_switch_check.mjs`, `pca_views_probe.mjs`); the five whose output depends on the fonts or on the stylesheets changed with them (`dock_fit`, `panel_fit`, `font_floor`, `timing_floors`, `tower_columns`) were re-run on 2026-10-22, when the app moved to the self-hosted Inter and JetBrains Mono. Running a script again rewrites its file in place; a run on another day can differ in the date and the run times it prints. The removal of the strategy assistant on 2026-10-22 changed some outputs; the section "Strategy assistant removed (2026-10-22)" at the end says which files were re-run that day and which still need a run. The PCA label placement, the move to Inter and the removal of the assistant were brought together on 2026-10-26; the section "Integration (2026-10-26)" at the end lists what was run again on the combined code.

How to run the scripts:

- `frontend/scripts/*.mjs`: from `frontend/`, `npx vite-node scripts/<name>.mjs` (they import `src/` modules). Most read the cached race sessions in `backend/data/processed_cache` (git-ignored, filled by `backend/scripts/bulk_download.py`). Each writes its file here; `cod_backtest`, `cvd_check` and `shortcuts_table` take `--out FILE` to write it elsewhere.
- `frontend/scripts/pca_layout_check.mjs`: from `frontend/`, `npm run build:demo` then `node scripts/pca_layout_check.mjs` (plain node; Chrome or Chromium found on the usual paths, or `--chrome PATH`; `--dist DIR` measures another build, `--out FILE` writes elsewhere). It needs no race cache.
- `frontend/scripts/usecases/*.mjs`: from `frontend/`, `npx vite-node scripts/usecases/<name>.mjs` (`--out FILE` writes elsewhere). Each writes `usecase_<name>.txt` here; the table "Use cases" below says which of them need the race cache.
- `frontend/scripts/audit/*.mjs`: static layout, type and colour checks that read the CSS and the components as written. From the repository root, `node frontend/scripts/audit/<name>.mjs`; the ones marked *vite-node* run from `frontend/` as `npx vite-node scripts/audit/<name>.mjs`. Each prints its report and writes the same text here (`--out FILE` writes it elsewhere).
- `backend/scripts/*.py`: from `backend/`, `python -m scripts.<name> --out ../docs/evidence/<file>` (backend virtual environment).
- Test outputs: the three tests listed below write their summary here only when run with `WRITE_EVIDENCE=1`, e.g. from `frontend/`: `WRITE_EVIDENCE=1 npx vitest run src/__tests__/degradation.endpointClock.test.js`.

## Strategy, simulation and degradation

| File | Written by | Cited by (the file or its script) |
|---|---|---|
| `battle_list_rules.txt` | `frontend/scripts/battle_list_rules.mjs` | `docs/analytics_provenance.md`, `docs/MASTER_LEDGER.md`, `frontend/src/utils/simulationClient.js` |
| `c4_pit_in_k_monza.txt` | `frontend/scripts/c4_pit_in_k_monza.mjs` | `docs/analytics_provenance.md`, `frontend/src/utils/__tests__/undercut.cached.test.js` |
| `cod_backtest.txt` | `frontend/scripts/cod_backtest.mjs` | `docs/analytics_provenance.md`, `frontend/src/utils/circleOfDoom.js` |
| `cod_ring_check.txt` | `frontend/scripts/cod_ring_check.mjs` | `frontend/src/utils/circleOfDoom.js`, `frontend/src/utils/circlePitLane.js`, `frontend/src/utils/circleSectors.js`, `frontend/src/utils/circleGapList.js` |
| `race_trace_check.txt` | `frontend/scripts/race_trace_check.mjs` | `frontend/src/utils/raceTrace.js`, `frontend/src/utils/chartHelp.js` |
| `degradation_definition_monza.txt` | `frontend/scripts/degradation_definition.mjs` | `docs/analytics_provenance.md`, `docs/DEGRADATION_METHODOLOGY.md`, `frontend/src/utils/degradation.js`, `frontend/src/utils/chartHelp.js`, `frontend/src/utils/__tests__/degradation.test.js`, `backend/tests/test_degradation.py`, `backend/tests/test_analytics_consistency.py` |
| `degradation_in_race.txt` | `frontend/scripts/degradation_in_race.mjs` | `docs/DEGRADATION_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/scripts/mc_benchmark.mjs` |
| `lap_noise_subclock.txt` | `frontend/scripts/lap_noise_subclock.mjs` | (the script) |
| `mc_benchmark.txt` | `frontend/scripts/mc_benchmark.mjs` | `docs/analytics_provenance.md`, `docs/MASTER_LEDGER.md`, `frontend/src/utils/raceSimulation.js`, `frontend/src/utils/chartHelp.js`, `frontend/src/__tests__/simulation.badges.test.js` |
| `mc_stability.txt` | `frontend/scripts/mc_stability.mjs` | `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/src/utils/simulationClient.js`, `frontend/src/__tests__/simulation.stability.test.js` |
| `s2_lap_noise_monza.txt` | `frontend/scripts/s2_lap_noise.mjs` | `docs/DEGRADATION_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/src/utils/__tests__/raceSimulation.engine.test.js` |
| `s7_undercut_monza.txt` | `frontend/scripts/s7_undercut_monza.mjs` | `frontend/src/utils/__tests__/undercut.cached.test.js` |
| `undercut_monza.txt` | `frontend/scripts/undercut_monza.mjs` | (the script) |
| `whatif_stability.txt` | `frontend/scripts/whatif_stability.mjs` | `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/src/utils/simulationClient.js`, `frontend/src/__tests__/simulation.whatIfMarks.test.jsx` |
| `whatif_stability_verifier_set.txt` | `frontend/scripts/whatif_stability.mjs --set verifier` | (the script) |
| `validate_pit_loss_and_rejoin.txt` | `backend/scripts/validate_pit_loss_and_rejoin.py` | `docs/analytics_provenance.md`, `README.md`, `docs/RELATED_WORK.md`, `frontend/src/utils/__tests__/raceSimulation.test.js`, `docs/INSIGHTS_MONZA_2024.md` |
| `evaluate_forecast.txt` | `backend/scripts/evaluate_forecast.py` | `docs/analytics_provenance.md`, `README.md` (the 30 races of the local cache, the five forecast laps), `frontend/src/utils/forecast.js` (the numbers of the Race Prediction help), `frontend/src/utils/chartHelp.js`, `frontend/src/components/visualizations/LapTimeChart.jsx`, `frontend/src/__tests__/forecast.views.test.jsx` (parses it), `backend/tests/test_forecast_followups.py`, `docs/INTENDED_USER.md`, `docs/INSIGHTS.md`, `docs/INSIGHTS_MONZA_2024.md`, `docs/INSIGHTS_HUNGARY_2024.md`, `docs/INSIGHTS_BRAZIL_2024.md`, `docs/MASTER_LEDGER.md`, `docs/HEURISTIC_EVALUATION.md` |
| `g1_store_endpoint_vs_chart.txt` | test `frontend/src/__tests__/degradation.endpointClock.test.js` (`WRITE_EVIDENCE=1`) | `docs/analytics_provenance.md`, `docs/DEGRADATION_METHODOLOGY.md` |
| `g5_consistency_parity.txt` | test `frontend/src/__tests__/degradation.consistencyParity.test.js` (`WRITE_EVIDENCE=1`) | `docs/analytics_provenance.md`, `docs/DEGRADATION_METHODOLOGY.md` |

`frontend/scripts/mc_benchmark.mjs` compares the working tree with the committed `raceSimulation.js` (git `HEAD`), which it instruments with one line; it stops with an error, before it writes, once `HEAD` already holds the change it measured. `mc_benchmark.txt` is the run against `HEAD` = 7641b61 (named in its third line).

## PCA

| File | Written by | Cited by (the file or its script) |
|---|---|---|
| `pca_rebuild.txt` | `backend/scripts/pca_rebuild.py` | `docs/pca_features.md`, `README.md`, `docs/PCA_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/src/__tests__/pca.help.test.js`, `docs/INTENDED_USER.md` |
| `pca_diagnostic.txt` | `backend/scripts/pca_diagnostic.py` | `docs/pca_features.md`, `docs/PCA_METHODOLOGY.md`, `frontend/src/__tests__/pca.help.test.js` |
| `pca_selection_baseline.txt` | `backend/scripts/pca_selection_baseline.py` | `docs/PCA_METHODOLOGY.md`, `docs/analytics_provenance.md`, `frontend/src/__tests__/pca.help.test.js` |
| `pca_clock_check.txt` | `backend/scripts/pca_clock_check.py` | `docs/PCA_METHODOLOGY.md`, `docs/analytics_provenance.md`, `frontend/src/__tests__/pca.help.test.js` |
| `pca_interval_coverage.txt` | `backend/scripts/pca_interval_coverage.py` | `docs/PCA_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `backend/data/processors/pca_compute.py`, `frontend/src/__tests__/pca.help.test.js`, `frontend/src/__tests__/pca.selectionPanel.test.jsx` |
| `pca_stratified_baseline.txt` | `backend/scripts/pca_stratified_baseline.py` | `docs/PCA_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/src/__tests__/pca.help.test.js` |
| `pca_mixed_threshold.txt` | `backend/scripts/pca_mixed_threshold.py` | `docs/PCA_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `backend/data/processors/pca_compute.py`, `backend/tests/test_pca_stratified.py`, `frontend/src/__tests__/pca.help.test.js` |
| `pca_progress_features.txt` | `backend/scripts/pca_progress_features.py` | `docs/PCA_METHODOLOGY.md`, `backend/data/processors/pca_compute.py`, `frontend/src/__tests__/pca.help.test.js` |
| `pca_repair_check.txt` | `frontend/scripts/pca_repair_check.mjs` | `docs/PCA_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `docs/analytics_provenance.md`, `frontend/src/__tests__/pca.help.test.js` |
| `live_pca_rewind.txt` | `frontend/scripts/live_pca_rewind.mjs` | `docs/analytics_provenance.md`, `docs/PCA_METHODOLOGY.md`, `docs/MASTER_LEDGER.md`, `frontend/src/__tests__/pca.help.test.js` |
| `live_pca_compare.txt` | `frontend/scripts/live_pca_compare.mjs` | (the script) |
| `pca_outcome_palette.txt` | `frontend/scripts/pca_outcome_palette.mjs` | `docs/COLOR_ENCODING.md`, `frontend/src/utils/colors.js`, `frontend/src/utils/views/pcaBiplot.js` |
| `pca_layout_check.txt` | `frontend/scripts/pca_layout_check.mjs` (headless Chrome on the demo build) | `docs/USE_CASES.md` (UC2) |
| `pca_session_switch_answers.json` | `backend/scripts/pca_session_switch_answers.py` | input of `frontend/scripts/pca_session_switch_check.mjs` |
| `pca_session_switch_check.txt` | `frontend/scripts/pca_session_switch_check.mjs` | (the script) |
| `pca_selection_sample.json` | a saved response of `POST /api/pca/analyze-selection` (5 points) | input of `frontend/scripts/pca_views_probe.mjs`, which writes `pca_views_probe_<label>.txt` here |
| `pca_selection_parity.txt` | test `frontend/src/__tests__/demo.pcaSelectionStats.test.js` (`WRITE_EVIDENCE=1`) | (the test) |

`frontend/scripts/pca_session_switch_check.mjs` and `frontend/scripts/pca_views_probe.mjs` stop with an error on the current code, before they write: `pca_session_switch_check.txt` is the output of the last run that completed, and no `pca_views_probe_<label>.txt` is kept.

## Colour and contrast

| File | Written by | Cited by (the file or its script) |
|---|---|---|
| `cvd_check.txt` | `frontend/scripts/cvd_check.mjs` | `docs/COLOR_ENCODING.md`, `frontend/src/utils/colors.js`, `frontend/src/utils/views/deltaHatch.js`, `frontend/src/utils/views/racePaceGrid.js`; the Track Map help names the script |
| `contrast_pairs.txt` | `frontend/scripts/audit/contrast_pairs.mjs` | `docs/COLOR_ENCODING.md`, `docs/MASTER_LEDGER.md`, `frontend/src/utils/colors.js`, `frontend/src/components/visualizations/RacePaceGrid.jsx`, `frontend/src/styles/tokens.css`, `frontend/src/styles/components.css`, `frontend/src/styles/visualizations.css` |
| `token_contrast.txt` | `frontend/scripts/audit/token_contrast.mjs` | `frontend/src/styles/tokens.css` |
| `chrome_contrast.txt` | `frontend/scripts/audit/chrome_contrast.mjs` | `frontend/src/__tests__/layout.contrast.test.js` |
| `light_contrast.txt` | `frontend/scripts/audit/light_contrast.mjs` | `frontend/src/styles/visualizations.css`, `frontend/src/styles/tokens.css` |
| `focus_context_contrast.txt` | `frontend/scripts/audit/focus_context_contrast.mjs` | `frontend/src/components/CommandPalette/CommandBar.css` |
| `posbrush_labels.txt` | `frontend/scripts/audit/posbrush_labels.mjs` | `docs/COLOR_ENCODING.md` |
| `area_alpha.txt` | `frontend/scripts/audit/area_alpha.mjs` | `docs/COLOR_ENCODING.md`, `frontend/src/utils/views/deltaHatch.js` |
| `ramp_ends.txt` | `frontend/scripts/audit/ramp_ends.mjs` | `docs/COLOR_ENCODING.md`, `frontend/src/utils/colors.js` |
| `third_tint_hue.txt` | `frontend/scripts/audit/third_tint_hue.mjs` | `docs/COLOR_ENCODING.md`, `frontend/src/utils/colors.js` |
| `timing_bands.txt` | `frontend/scripts/audit/timing_bands.mjs` (vite-node) | `docs/COLOR_ENCODING.md` |
| `legend_rows.txt` | `frontend/scripts/audit/legend_rows.mjs` (vite-node) | `docs/COLOR_ENCODING.md` |
| `lane_marks_check.txt` | `frontend/scripts/audit/lane_marks_check.mjs` (vite-node) | `docs/COLOR_ENCODING.md` |
| `cross_view_styles.txt` | `frontend/scripts/audit/cross_view_styles.mjs` (vite-node) | `docs/COLOR_ENCODING.md`, `frontend/src/__tests__/colors.doc.test.js` |
| `color_doc_hex.txt` | `frontend/scripts/color_doc_check.mjs` (from `frontend/`, `node scripts/color_doc_check.mjs`) | `docs/COLOR_ENCODING.md`, `frontend/src/__tests__/colors.doc.test.js` |

## Layout, type and views

| File | Written by | Cited by (the file or its script) |
|---|---|---|
| `layout_fit.txt` | `frontend/scripts/audit/layout_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `docs/SCROLL_HEURISTIC_EVALUATION.md`, `frontend/src/styles/tokens.css`, `frontend/src/components/visualizations/Leaderboard.jsx`, `frontend/src/utils/views/chartBox.js`, `frontend/src/__tests__/helpers/layoutModel.js`, `docs/INTENDED_USER.md`, `docs/MASTER_LEDGER.md` |
| `panel_fit.txt` | `frontend/scripts/audit/panel_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `frontend/src/styles/dashboard.css`, `frontend/src/styles/visualizations.css`, `frontend/src/utils/views/timingSheetFit.js`, `frontend/src/__tests__/layout.gridFit.test.js`, `frontend/src/__tests__/leaderboard.fit.test.jsx` |
| `dock_fit.txt` | `frontend/scripts/audit/dock_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `frontend/src/utils/dockCapacity.js`, `frontend/src/__tests__/dock.fit.test.jsx` |
| `overflow_inventory.txt` | `frontend/scripts/audit/overflow_inventory.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `frontend/src/styles/dashboard.css`, `frontend/src/__tests__/helpers/scrollInventory.js` |
| `font_floor.txt` | `frontend/scripts/audit/font_floor.mjs` | `frontend/src/styles/base.css` |
| `cheatsheet_fit.txt` | `frontend/scripts/audit/cheatsheet_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `docs/SCROLL_HEURISTIC_EVALUATION.md`, `frontend/src/components/ShortcutCheatsheet/ShortcutCheatsheet.css`, `docs/INTENDED_USER.md`, `docs/MASTER_LEDGER.md` |
| `compare_fit.txt` | `frontend/scripts/audit/compare_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `frontend/src/__tests__/layout.gridFit.test.js` |
| `strategy_fit.txt` | `frontend/scripts/audit/strategy_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `frontend/src/styles/components.css`, `frontend/src/utils/windowPresets.js`, `frontend/src/__tests__/layout.gridFit.test.js` |
| `tower_columns.txt` | `frontend/scripts/audit/tower_columns.mjs` | `docs/SCROLL_JUSTIFICATIONS.md`, `frontend/src/components/visualizations/TimingTower.jsx`, `frontend/src/styles/tokens.css` |
| `laptimes_sheet_fit.txt` | `frontend/scripts/audit/laptimes_sheet_fit.mjs` | `docs/SCROLL_JUSTIFICATIONS.md` |
| `leaderboard_sidebar_fit.txt` | `frontend/scripts/audit/leaderboard_sidebar_fit.mjs` | `frontend/src/components/layout/SidebarFocusCards.jsx`, `frontend/src/__tests__/layout.render.test.jsx` |
| `timing_floors.txt` | `frontend/scripts/audit/timing_floors.mjs` | `frontend/src/utils/views/timingSheetFit.js` |
| `view_catalogue.txt` | `frontend/scripts/audit/view_catalogue.mjs` | `docs/MASTER_LEDGER.md` |
| `range_scenarios.txt` | `frontend/scripts/audit/range_scenarios.mjs` (vite-node) | `docs/COORDINATION_GRAPH.md` |
| `shortcuts_table.txt` | `frontend/scripts/shortcuts_table.mjs` (vite-node; `--write` also rewrites the generated block of `docs/SHORTCUTS.md`) | `docs/SHORTCUTS.md`, `frontend/src/__tests__/shortcuts.doc.test.js` |
| `insight3_sector_trend.txt` | `frontend/scripts/audit/insight3_sector_trend.mjs` | `docs/INSIGHTS.md` |
| `export_demo_data_report.txt` | `backend/scripts/export_demo_data.py --report FILE` (it also rewrites `frontend/public/data`, byte-identical when nothing changed) | `README.md`, `docs/INTENDED_USER.md`, `frontend/src/__tests__/docs.factcheck.test.js` |

## Use cases

| File | Written by | Cited by (the file or its script) |
|---|---|---|
| `usecase_uc1_monza24_strategy.txt` | `frontend/scripts/usecases/uc1_monza24_strategy.mjs` (reads the demo files; compares them with the race cache when present) | `docs/USE_CASES.md` (UC1, and the prior's provenance in UC3) |
| `usecase_uc2_monza24_analyst.txt` | `frontend/scripts/usecases/uc2_monza24_analyst.mjs`, which runs `backend/scripts/usecase_monza24_analyst.py` with the backend virtual environment (needs the race cache) | `docs/USE_CASES.md` (UC2) |
| `usecase_uc3_monza25_cod.txt` | `frontend/scripts/usecases/uc3_monza25_cod.mjs` (needs the race cache) | `docs/USE_CASES.md` (UC3) |
| `usecase_uc4_china24_sc.txt` | `frontend/scripts/usecases/uc4_china24_sc.mjs` (reads the demo files; its section 7 needs the race cache and is skipped without it) | `docs/USE_CASES.md` (UC4) |
| `usecase_uc5_imola24_undercut.txt` | `frontend/scripts/usecases/uc5_imola24_undercut.mjs` (needs the race cache) | `docs/USE_CASES.md` (UC5) |

## Browser audits (no script)

| File | What it is | Cited by |
|---|---|---|
| `browser_audit_2026-10-14.md` | measurements taken in the page (JavaScript in the browser console) at the target viewports, before the fixed-viewport layout | `docs/SCROLL_JUSTIFICATIONS.md`, `docs/SCROLL_HEURISTIC_EVALUATION.md`, `frontend/src/styles/base.css` |
| `browser_audit_2026-10-16.md` | the same method, after the layout rework and its re-check | `frontend/src/__tests__/leaderboard.fit.test.jsx`, `frontend/src/__tests__/dock.fit.test.jsx`, `frontend/src/__tests__/circleOfDoom.fill.test.jsx`, `frontend/src/__tests__/trackmap.toolbar.test.jsx`, `frontend/src/utils/views/trackMapLayout.js` |

The static checks of `frontend/scripts/audit/` model the browser from the CSS and the font files (`frontend/public/fonts`); the browser audits measure what such a model cannot (view internals, real rendering).

## Strategy assistant removed (2026-10-22)

The strategy assistant (its chat, its Pit Wall quick query, its floating button, the AI Strategist view and its backend route) was removed on 2026-10-22, with `s4_assistant_cards.txt` and the two scripts that wrote it.

- Re-run on 2026-10-22: `cheatsheet_fit.txt`, `contrast_pairs.txt`, `font_floor.txt`, `lane_marks_check.txt`, `layout_fit.txt`, `overflow_inventory.txt`, `strategy_fit.txt`, `view_catalogue.txt`, `color_doc_hex.txt` and `shortcuts_table.txt` (with the generated blocks of `docs/SHORTCUTS.md` and `docs/COORDINATION_GRAPH.md`). The other audits of `frontend/scripts/audit/` print the same on the code before and after the removal, and their files were kept (`chrome_contrast.txt` cited `dashboard.css` line numbers that had already moved by 2 before the removal; the run of 2026-10-26 below updates them).
- `export_demo_data_report.txt`: the export needs the race cache; the report was written from the tracked `frontend/public/data/manifest.json` (without the assistant in `backend_only`) by `report_lines` of `backend/scripts/export_demo_data.py`, the function the export writes it with. On the previous manifest that function reproduces the previous report byte for byte.
- `mc_stability.txt` is still the run of 2026-10-16: the script needs the race cache. Its four rows named "assistant" measure marks of the removed assistant; `mc_stability.mjs` no longer computes them, so a run with the cache drops them and changes the lines that count or rank the marks ("marks over 5 %", "by clock").
- `mc_benchmark.txt` and `pca_session_switch_check.txt` cannot be run again (above). In each, one line of fixed text that listed the assistant among the readers of a value was edited by hand on 2026-10-22, identically in the script that prints it (`mc_benchmark.mjs`: the readers of `listedBattles`; `pca_session_switch_check.mjs`: the readers of the PCA strategy patterns); no number was changed. The rows "assistant quick-query battle" of `mc_benchmark.txt` measure the first listed battle, the one the assistant's quick query named.

## Integration (2026-10-26)

The PCA label placement, the move to the self-hosted Inter and JetBrains Mono and the removal of the strategy assistant were made apart and brought together on 2026-10-26. On the combined code:

- Every audit of `frontend/scripts/audit/` was run again. `chrome_contrast.txt` and `overflow_inventory.txt` were rewritten with the new `dashboard.css` and `components.css` line numbers (every ratio and verdict is the same); `contrast_pairs.txt`, `layout_fit.txt`, `panel_fit.txt` and `token_contrast.txt` only with the new date; `dock_fit.txt` and `font_floor.txt` with the nine-item dock in Inter and the stylesheets of both changes. `dock_fit.mjs` keeps the ten-item dock of 2026-10-16 (it held the AI Strategist) for the "before 9c" replay, whose lines need the Windows font file `C:/Windows/Fonts/segoeuib.ttf` and are printed only where that file is (not in this run). The other audits print the same and their files were kept.
- `pca_layout_check.txt` was run on the demo build in Inter. It now also measures a label over another text of the plot or over the Clear button, a label cut by the plot's container, and the face the labels are drawn in.
- `color_doc_check.mjs`, `cvd_check.mjs`, `pca_outcome_palette.mjs`, `shortcuts_table.mjs --write` and `coordination_matrix.mjs` print the same; `color_doc_hex.txt`, `cvd_check.txt`, `pca_outcome_palette.txt`, `shortcuts_table.txt` and the generated blocks of `docs/SHORTCUTS.md` and `docs/COORDINATION_GRAPH.md` were kept.
- `usecase_uc1_monza24_strategy.txt` and `usecase_uc4_china24_sc.txt`: run without the race cache, the scripts print every line that reads the demo files as before; the lines that compare with the race cache need it, so both files were kept.
- The scripts that need the race cache were not run (no cache in this run).

## Wordmark (2026-10-29)

The name is drawn as a wordmark (`frontend/src/components/ui/Wordmark.jsx`, `frontend/src/utils/wordmark.js`) in the weather bar, the header and on the start screen, with a new token, `--color-brand-accent`, for its line and dot and for the favicon.

- `contrast_pairs.mjs` now also measures the wordmark's line and dot (3:1), its word and the start screen's tagline (4.5:1) on the weather bar, the header and every stop of the start screen's gradient, alone and under its glow, in both themes; the favicon's mark on its square; and prints, not gated, the data colours nearest to the accent (CIEDE2000, the four vision types). `contrast_pairs.txt` was rewritten: 98 pairs, 0 under their threshold.
- `font_floor.mjs` resolves the SVG text size of the wordmark (drawn at 1 em of its place, whose CSS size the CSS pass checks) and counts `Wordmark.jsx` in the layout lane; `font_floor.txt` was rewritten.
- `chrome_contrast.txt` (one chrome text colour less: the start screen's subtitle is now the wordmark's tagline, in `components.css`; every verdict the same), `overflow_inventory.txt` (new `dashboard.css` and `components.css` line numbers) and `color_doc_hex.txt` (the accent in `docs/COLOR_ENCODING.md`) were rewritten.
- The other audits of `frontend/scripts/audit/` print the same and their files were kept, `layout_fit.txt` included (the weather bar's height is a token; the wordmark does not change it). `view_catalogue.txt` differs from a run on this code by two views added before this change (Field Pace, Race Trace); it was kept.

## Logo (2026-10-29)

The drawn wordmark gave way to the logo files of `frontend/public/brand`, shown by `frontend/src/components/ui/Wordmark.jsx` in the weather bar, the header, the start screen, the session menu and Settings > About; `frontend/src/utils/wordmark.js` and the `--color-brand-accent` token are gone, and the favicon is the set at the root of `frontend/public` (`favicon.svg`, `favicon.ico`, the PNGs).

- `contrast_pairs.mjs` section 13 reads the logo's colours from the brand files and names them by the intro files' parts: the letters, the orange and the kerb red at 3:1 on the weather bar and the header (the primary file) and on every stop of the start screen, alone and under its glow (the intro file; the light one paints its own white panel, so its marks are measured on it), in both themes; the tagline at 4.5:1; the favicon's marks on its own tile. Printed, not gated: the cone, the session menu and Settings > About, the light intro file's panel against the start screen, and the data colours nearest to the orange and the kerb red (CIEDE2000, the four vision types). `contrast_pairs.txt` was rewritten: 125 pairs, 0 under their threshold.
- `font_floor.mjs` no longer resolves the wordmark's SVG text size (the logo is an image); `font_floor.txt` was rewritten.
- `chrome_contrast.txt` and `overflow_inventory.txt` (new `dashboard.css` and `components.css` line numbers; every verdict the same) and `color_doc_hex.txt` (the logo paragraph of `docs/COLOR_ENCODING.md`) were rewritten.
- The other audits of `frontend/scripts/audit/` print the same and their files were kept, `layout_fit.txt` included (the bars' heights are tokens; the logo does not change them). `view_catalogue.txt` still differs from a run on this code by the views added before the wordmark (Field Pace, Race Trace) and the Circle of Doom's gap list; it was kept.
