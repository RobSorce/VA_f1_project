# Race Strategy Dashboard — Master Ledger

> Single-source, exhaustive entry point for the final Visual Analytics report.
> Every subsequent document (INSIGHTS, RELATED_WORK, PCA_METHODOLOGY, etc.) is a deeper dive on a section that already appears here.
>
> **Corrections of 2026-10-15.** The statements below that the code contradicted have been corrected in place to describe the code as it is; the usage scenario of section 2 is marked to be rewritten.

Author: **Roberto Sorce** — Sapienza Università di Roma, Visual Analytics 2024/2025.
Repository: [github.com/RobSorce/VA_f1_project](https://github.com/RobSorce/VA_f1_project), branch `v4` (React 18 + Vite + Zustand + D3 on the front; FastAPI + FastF1 + PyTorch + scikit-learn on the back).

---

## 0 · Table of contents

1. [What the system is and why](#1--what-the-system-is-and-why)
2. [Intended user and scenarios](#2--intended-user-and-scenarios)
3. [System architecture](#3--system-architecture)
4. [Backend](#4--backend)
5. [Frontend](#5--frontend)
6. [State: the Zustand store](#6--state-the-zustand-store)
7. [Analytics pipelines](#7--analytics-pipelines)
8. [Visualizations catalogue (28 views in 30 files: 22 draw with D3, 8 HTML only)](#8--visualizations-catalogue-28-views-in-30-files-22-draw-with-d3-8-html-only)
9. [Bidirectional coordination graph](#9--bidirectional-coordination-graph)
10. [Three rendering modes + docked layout engine](#10--three-rendering-modes--docked-layout-engine)
11. [Customizable bottom dock](#11--customizable-bottom-dock)
12. [Command palette (the CLI-style searchbar)](#12--command-palette-the-cli-style-searchbar)
13. [Keyboard shortcuts](#13--keyboard-shortcuts)
14. [Design system](#14--design-system)
15. [Color encoding](#15--color-encoding)
16. [Legends and annotation conventions](#16--legends-and-annotation-conventions)
17. [Live timing subsystem](#17--live-timing-subsystem)
18. [Replay engine](#18--replay-engine)
19. [VA framework mapping](#19--va-framework-mapping)
20. [Performance / caching](#20--performance--caching)
21. [Development workflow](#21--development-workflow)

---

## 1 · What the system is and why

**Race Strategy Dashboard** is a full-stack visual-analytics platform for Formula 1 race-strategy decision making.
It is *not* an F1 information dashboard. It is a decision-support tool that closes the loop

```
real telemetry  ->  feature engineering  ->  dimensionality reduction + ML
       <-  visual interaction  <-  analytics triggered by visual selection
```

so that a pit-wall strategist can answer questions of the form *"is this stint tracking toward an undercut opportunity and which historically similar strategies succeeded?"* quickly.

The project targets the **Visual Analytics** course at Sapienza, so three things are non-negotiable:

1. **Analytics must be coupled to visualization.** Lasso on PCA → backend compares the selected points with the other rows (Hedges' g with its 95% interval and a random-selection baseline: descriptive differences, not a test), and the result re-renders in the Cross-Race Analysis panel with the selection's tyre strategies, pit windows and per-feature differences.
2. **Coordination is bidirectional.** Selecting a driver in the Leaderboard highlights them in Track Map, Timing Sheet, PCA biplot, Race Situation, Telemetry, Compare, Consistency (`selectedDrivers`; the Sector Delta and the Undercut Calculator follow the focus driver and the rival instead). Conversely, clicking a PCA point or a driver on the Track Map selects that driver back in the Leaderboard, and a battle in Strategy Analysis sets the focus driver and its rival. The generated tables of `docs/COORDINATION_GRAPH.md` list every writer and subscriber.
3. **The dashboard is expressive, not decorative.** Every color, axis, legend, and glyph has a job. Nothing is there for "visual interest."

---

## 2 · Intended user and scenarios

### Persona: Pit-wall race strategist
A performance engineer seated on the F1 pit wall during a Grand Prix. Real-time decisions on pit-stop timing, tyre-compound selection, and track-position management. Works in a cognitively expensive regime: 20 drivers × 3 sectors × ~55 laps × 5 compounds × weather state, with <30 s to call a decision.

### Two modes of work

**Monitor mode (live-session).** Pit Wall (`PitWallLayout.jsx`), full screen: the Timing Tower with the focus driver's cards (sector panel, focus widget) on the left; the Race Pace Grid, then the Track Map, the Circle of Doom and a side column (weather, race-control feed). Optimized for glance-ability.

**Analyze mode (post-session / replay).** Every other view opens as a tab of the docked split-pane workspace (`DockedLayout`) beside the Leaderboard sidebar; with no view open, the base screen is the Track Map beside the Leaderboard. Brushing and linking across the views (§9). Settings is the one view that opens as a floating window, over any mode.

### Usage scenario (to be rewritten; Monza 2024 reference used in README)

> *Focus driver: Norris.* Current stint on the Hard compound (Strategy Timeline). A click on the stint sets the dashboard's one lap range: each row of the Timing Sheet shows the driver's latest lap inside it, the Position Tracker brushes it and Tyre Degradation fits it. The double-click that set the focus also asked the lap-time forecast of the next five laps (Timing Sheet forecast rows, Race Prediction). Call: *"Box this lap."*

(Corrected on 2026-10-15: the scenario quoted a stint length, a degradation trend and a forecast spike that no script measured, and said the PCA biplot clusters "this stint profile"; the biplot shows (driver, race) rows and does not follow the lap range, `docs/COORDINATION_GRAPH.md`, section 8.)

The full persona, goals, and tasks are in [`INTENDED_USER.md`](INTENDED_USER.md).

---

## 3 · System architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (fixed viewport, no page scroll)          │
│  React 18 + Vite 5 + Zustand 4 + D3.js 7                              │
│                                                                       │
│   Pit Wall | docked workspace (base: Track Map) | Settings window     │
│   28 views in 30 files (22 draw with D3, 8 HTML only), one store      │
│   Command palette · Keyboard shortcuts · Auto-hide dock               │
└───────────────┬──────────────────────────────────────────────────────┘
                │   axios (REST)  +  WebSocket (live timing)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          BACKEND (FastAPI :8000)                      │
│                                                                       │
│  Routers: predictions, analytics, live, replay                        │
│  Extractors: FastF1Extractor (thread-locked, disk + memory cache)    │
│  Processors: feature_engineering, pca_compute, degradation, stints    │
│  Model: PyTorch LSTM 64→32→Dense (lap time + pit probability)        │
│  Live: SignalR client, OpenF1 poller, mock replay                    │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ DATA SOURCES                                                          │
│  • FastF1 (2018 onwards: laps, telemetry, weather, track status)     │
│  • OpenF1 REST (live car data + positions, SignalR paywalled 2025)   │
└──────────────────────────────────────────────────────────────────────┘
```

Vite dev server proxies `/api` to `http://localhost:8000`. CORS allows all origins in development.

---

## 4 · Backend

### 4.1 Stack
`FastAPI` for the HTTP API, `uvicorn` as the ASGI server, `FastF1` for authoritative F1 session data, `scikit-learn >= 1.4` (`requirements.txt`) for scaling / PCA, `PyTorch` for the LSTM, `numpy` + `pandas` for everything in between.

### 4.2 Entry point: `backend/api/main.py`

Key design decisions:

- **Graceful router loading.** Each router is imported inside a `try/except`. If `predictions` fails because PyTorch isn't installed, the rest of the app still boots. The loaded set is printed as `_routers_loaded`.
- **Three-tier session cache.** Memory dict → disk JSON (`backend/data/processed_cache/session_{year}_{round}_R.json`) → FastF1 extraction. A disk-cached session loads without FastF1.
- **Thread-locked FastF1 access.** FastF1 is not thread-safe, so every call is guarded by `_fastf1_lock = threading.Lock()`. The lock is exposed on `app.state.fastf1_lock` so routers can use the same one.
- **Background raw-session prefetch.** When a disk-cached session is served, a daemon thread pre-loads the raw FastF1 session with `telemetry=True` so the first telemetry request is instant.
- **Offline mode.** When the raw session is only needed for cached laps/telemetry, `fastf1.Cache.offline_mode(True)` is set so the lookup never touches the network.

### 4.3 Endpoint map

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Health check |
| `/api/seasons` | GET | Seasons from 2018 (`FIRST_SEASON`) to the current one, and the next once its schedule is published |
| `/api/schedule/{year}` | GET | Event schedule, disk-cached per year |
| `/api/session/{year}/{round}` | GET | Full session (laps, circuit, drivers, results, weather, strategy, track status) |
| `/api/laptimes/{year}/{round}` | GET | Lap times, optionally filtered by driver |
| `/api/telemetry/{year}/{round}/{driver}` | GET | Per-lap telemetry (Speed, RPM, Throttle, Brake, Gear, DRS, Distance, Time) |
| `/api/circuit/{year}/{round}` | GET | Track coordinates, corners, DRS zones |
| `/api/strategy/{year}/{round}` | GET | Tyre strategies / stints |
| `/api/drivers/{year}/{round}` | GET | Driver info (abbr, name, team, color, country) |
| `/api/results/{year}/{round}` | GET | Final race results |
| `/api/positions/{year}/{round}` | GET | Per-lap position arrays |
| `/api/frames/{year}/{round}` | GET | Frame-based replay data |
| `/api/weather/{year}/{round}` | GET | Weather timeseries |
| `/api/championship/{year}` | GET | Full season cumulative standings + weighted prediction |
| `/api/tsne/embeddings` | GET | Former route name: alias of `/api/pca/embeddings` without parameters (the t-SNE projection was removed) |
| `/api/pca/embeddings` | GET | PCA points + loadings + explained variance + auto axis labels; `?year&round&session_now`: that race's rows at the replay clock, axes fitted without it |
| `/api/pca/analyze-selection` | POST | Descriptive analysis of selected point IDs (Hedges' g, 95% interval, N, random baseline; optional year / round / session_now); `/api/tsne/analyze-selection` is an alias |
| `/api/tsne/point-features/{id}` | GET | Former route name: alias of `/api/pca/point-features/{id}`, the raw features of a biplot point |
| `/api/predict/lstm` | POST | Lap-time forecast of the next 5 laps and the probability of a stop within them, by the methods selected on the validation races (§7.4) |
| `/api/predict/degradation` | POST | Linear regression on brushed lap range |
| `/api/analytics/sectors/{year}/{round}` | GET | Best sector rankings per driver |
| `/api/analytics/consistency/{year}/{round}` | GET | Consistency σ per driver: the pooled residual σ of the per-stint degradation fits (`docs/DEGRADATION_METHODOLOGY.md`) |
| `/api/live/connect-signalr` | GET | Start SignalR + OpenF1 poller |
| `/api/live/disconnect-signalr` | GET | Stop live stream |
| `/api/live/load-full-session` | GET | Resolve live session → load via FastF1 |
| `/api/live/ws` | WS | Live timing stream to frontend |
| `/api/session/{year}/{round}/{session_type}/replay` | GET | Replay data of a session (race or qualifying), `api/routers/replay.py` |

### 4.4 Routers

- **`api/routers/predictions.py`** — hosts `/api/predict/lstm` and `/api/predict/degradation`. The forecast endpoint calls `model/predict.py`, which serves the methods chosen on the validation races in `model/saved/forecast_selection.json` (written by `scripts/evaluate_forecast.py`) and skips a method that cannot run (no torch, no model) for the next one in the ranking; the router's built-in heuristic answers only when `model/predict.py` cannot be imported or fails (§7.4). The degradation endpoint fits the clean laps of each stint in an arbitrary lap range, for arbitrary driver(s) (`docs/DEGRADATION_METHODOLOGY.md`).
- **`api/routers/analytics.py`** — sector rankings (best S1 / S2 / S3 per driver with SB/PB classification), speed-trap rankings and consistency (the pooled residual σ of each driver's per-stint degradation fits, on the laps completed at `session_now`).
- **`api/routers/live.py`** — WebSocket endpoint `/api/live/ws`, REST lifecycle endpoints, and hooks into `live.session_manager.LiveSessionManager` + `live.mock_replay.MockReplay`.
- **`api/routers/replay.py`** — race/qualifying frame endpoints for the timeline scrubber.

### 4.5 Data processing

- **`data/extractors/fastf1_extractor.py`** — 12+ extraction methods. Handles DNS/DNF (no laps), classified-position fallback via `race_results`, pit in/out detection, sector time conversion, and track-coordinate sanitization (numpy → float).
- **`data/processors/feature_engineering.py`** — per-lap helpers (fuel-corrected pace, gap to the leader, sector performance, pit-stop metrics, recent pace). `api/main.py` creates a `FeatureEngineer`, but neither the forecast (`model/features.py`) nor the PCA (`pca_compute.py`) uses it. The per-stint degradation fits are in `data/processors/degradation.py` (`docs/DEGRADATION_METHODOLOGY.md`).
- **`data/processors/pca_compute.py`** — per-(driver, race) feature matrix (534 rows × 12 features from 30 cached races, `docs/evidence/pca_rebuild.txt`), `StandardScaler` + `PCA(n_components=2)` saved as `pca_embeddings.json` (`points`, `loadings`, `explained_variance`, axis labels from the top-2 loadings), the replay-clock biplot (`pca_embeddings_at`), and the lasso analysis (`analyze_selection`); the `/api/tsne/...` paths are aliases of the PCA routes.

### 4.6 Feature set (12 features)

```
pace_delta_pct, best_lap_delta_pct, recent_pace_delta_pct,
sector1_delta_pct, sector2_delta_pct, sector3_delta_pct,
consistency_pct, degradation_slope,
pit_count, avg_stint_length, max_stint_length,
grid_position
```

Pace and sector features are relative to the same race's field. Not features: the stint count (= stops + 1), track / air temperature (race identity), absolute lap / sector times (circuit length), and the outcome (finishing position, position change, gap to the leader); the finishing position is point metadata only.

This matters for the VA report — see `docs/PCA_METHODOLOGY.md`.

### 4.7 LSTM model (`backend/model/train.py`)

```
F1LapPredictor(nn.Module):
  LSTM(n_features = 12, 64)  →  Dropout(0.2)
  LSTM(64, 32)               →  Dropout(0.2)
  Linear(32, 6)              →  [delta_t+1 … delta_t+5 (normalised), pit logit]
Loss: masked L1 on the lap-time deltas + BCE on the pit logit (PIT_LOSS_WEIGHT 1.0)
Optimizer: Adam (lr 1e-3), ReduceLROnPlateau (patience 4, factor 0.5)
Early stopping: PATIENCE 10, MAX_EPOCHS 80
Split: by race, never by window: test = every race of the latest cached
season + Monza 2024 (EXTRA_TEST_RACES); validation = 4 races drawn with
SPLIT_SEED 7; training = the rest
```

The windows are built by `model/features.py` `build_window` (the same builder at training and at serving) and saved by `model/prepare_data.py`; the label statistics (`y_delta_mean`, `y_delta_std`), fitted on the training races only, are saved to `data_stats.json` and `model_config.json` so inference can de-normalise. Which method is served is decided by `scripts/evaluate_forecast.py` on the validation races (`docs/evidence/evaluate_forecast.txt`, §7.4).

### 4.8 Live timing
- `live/signalr_client.py` — F1 SignalR client. It subscribes to `LIVE_TOPICS`, `CarData.z` and `Position.z` among them, but those two feeds have been paywalled since 2025, so in practice it receives the other topics (timing, lap count, track status, race control, weather, team radio, session).
- `live/openf1_client.py` — polls OpenF1 REST every 2 s (`TELEMETRY_POLL_INTERVAL`) for car data + positions; without an OpenF1 API key the live data are blocked while a session runs (module docstring).
- `live/session_manager.py` — accumulates messages, maintains a consistent snapshot, emits WS updates.
- `live/mock_replay.py` — replays a cached session as if it were live, for testing without an active Grand Prix.

---

## 5 · Frontend

### 5.1 Stack
React 18 (function components + hooks) + Vite 5 + Zustand 4 (single store) + D3.js 7 (used via `useEffect` + `useRef` — React renders the SVG shell, D3 owns the contents). `axios` for REST, native WebSocket for live, `html2canvas` for chart export.

### 5.2 Directory layout

```
frontend/src/
├── App.jsx                    ── mode selector, overlay tab registry, keyboard hooks
├── main.jsx                   ── Vite entry
├── store/useF1Store.js        ── Zustand store (single source of truth)
│
├── components/
│   ├── layout/
│   │   ├── DockedLayout.jsx   ── JetBrains-style split panes (max 4, draggable splitters)
│   │   ├── OverlayPanel.jsx   ── Draggable / resizable floating window
│   │   ├── PitWallLayout.jsx  ── Full-screen Monitor mode
│   │   ├── SidebarFocusCards.jsx ── Focus driver's cards under the Leaderboard
│   │   └── AnalysisLayout.jsx, AnalysisSlot.jsx, DetailPanel.jsx,
│   │       PanelToggleBar.jsx ── earlier layout, not rendered by App.jsx
│   │
│   ├── visualizations/        ── 28 views in 30 files (see §8)
│   │
│   ├── ui/                    ── generic UI components, among them:
│   │   ├── BottomTabBar.jsx       ── The customizable dock
│   │   ├── DockContextMenu.jsx
│   │   ├── DockOverflowPopover.jsx
│   │   ├── DockCustomizePopover.jsx
│   │   ├── LayoutBuilder.jsx
│   │   ├── LayoutPresetBar.jsx
│   │   ├── LayoutDockPopover.jsx
│   │   ├── TimelinePlayer.jsx     ── D3 scrubber with SC/VSC/flag bands
│   │   ├── SessionSelector.jsx
│   │   ├── SessionSelectorScreen.jsx
│   │   ├── Header.jsx / Footer.jsx    ── not rendered by App.jsx
│   │   ├── WeatherBar.jsx / WeatherMini.jsx
│   │   ├── Legend.jsx
│   │   ├── DriverMFDCard.jsx
│   │   ├── FocusDriverWidget.jsx
│   │   ├── RaceControlFeed.jsx
│   │   ├── WelcomeToast.jsx
│   │   ├── PitWallSectorPanel.jsx
│   │   └── Panel.jsx              ── Shared title + controls shell
│   │
│   ├── tabs/                  ── 7 tab content containers
│   ├── CommandPalette/        ── Cmd+K palette (see §12)
│   ├── ShortcutCheatsheet/    ── ? overlay
│   └── ShortcutHints/         ── Contextual hint strip
│
├── hooks/
│   ├── useKeyboardShortcuts.js    ── Global key handler (30+ bindings)
│   └── useReplayEngine.js         ── RAF playback loop
│
├── utils/
│   ├── apiClient.js               ── axios wrapper of the REST routes (the static demo answers when the backend does not)
│   ├── colors.js                  ── teams, drivers, tyres, flags, points
│   ├── windowPresets.js           ── 7 docked-layout presets
│   ├── slotOptions.js             ── Lazy slot registry (icons, categories, hints)
│   ├── lasso.js                   ── D3 lasso tool
│   ├── livePCA.js                 ── In-browser PCA refitted every lap, Procrustes-aligned to the previous lap
│   ├── liveWebSocket.js           ── Live WS client
│   ├── raceSimulation.js          ── Monte Carlo race simulation (DEFAULT_NUM_SIMULATIONS = 1,000 runs, §7.5)
│   ├── raceSituationFeatures.js   ── Feature extraction from current state
│   ├── raceSituationReference.js  ── Replay alignment reference of the live PCA (the axes a replay from lap 3 draws)
│   ├── trackPositionEstimator.js  ── Track-coord lookup
│   └── exportChart.js             ── html2canvas export
│
└── styles/
    ├── tokens.css                 ── Design system vars (colors, fonts, spacing)
    ├── base.css                   ── Reset, fixed-viewport root (the page never scrolls)
    ├── components.css             ── Panels, buttons, glass pills
    ├── dashboard.css              ── Dashboard, sidebar, dock, leaderboard
    └── visualizations.css         ── D3 chart styles (tooltips, axes, legends)
```

### 5.3 Build
`npm run dev` → Vite dev server at :5173 with HMR. `npm run build` → static bundle in `frontend/dist/`.

---

## 6 · State: the Zustand store

`store/useF1Store.js` is the coordination hub. Every chart reads and writes through selectors.

### 6.1 State surface (grouped)

- **Session:** `year, round, sessionType, sessionData, drivers, circuitInfo, schedule, isLoading`.
- **Replay:** `currentLap, maxLap, currentFrameIndex, totalFrames, currentTime, isPlaying, playSpeed, frameData`.
- **Selection:** `selectedDrivers, focusDriver, highlightedDriver, comparisonDriver, compareDrivers, compareMode`.
- **Selection (projection):** `selectedPCAPoints, pcaStrategyAnalysis` (the PCA is the one projection; the t-SNE projection and its store fields were removed).
- **Lap range:** `brushLapRange, selectedLapRange`: one lap range under two names, always equal (every lap-range action sets both; `docs/COORDINATION_GRAPH.md` section 2).
- **Predictions:** `lstmPredictions, degradationRegression, raceProjection`.
- **Live:** `isLiveMode, liveConnected, liveSessionInfo, liveStandings, liveTelemetry`.
- **Layout:** `activeTab, openOverlays, overlayTiles, dockedLayout, overlayVizMapping, dockItems, showDashboard, leaderboardCollapsed, trackRotationOffset`.
- **UI modes:** `commandPaletteOpen, cheatsheetOpen, showTrackSectors, showTrackDRS, telemetryChannels, tempUnit, speedUnit`.
- **Track overlays:** DRS / sector toggles synced with keyboard shortcuts (the corner labels are a toggle of the Track Map itself, `showCorners`).
- **Championship:** `championshipData`.

### 6.2 Docked-layout tree helpers
Internal (underscore-prefixed) helpers manage the split-pane tree:
- `_countPanes(tree)` — count leaf panes.
- `_collectDockedTabs(tree)` — flatten active-tab IDs per pane.
- `_appendPane(tree, tabId)` — add a pane holding that tab (a new split; the existing content keeps n/(n+1) of the space).
- `_addTabToFirstLeaf(tree, tabId)` — add a tab to the first pane (how `setActiveTab` opens a view in an existing layout).
- `_removeTabFromTree(tree, tabId)` — remove a tab and collapse singleton splits.
- `_buildDockedTree(tabIds, variant)` — build a tree from tab IDs in one of four arrangements (grid, side by side, stacked, main + sidebar), with at most `MAX_PANES = 4` panes.
- `_groupTabs(tabIds)` — round-robin distribute the tabs into at most `MAX_PANES` groups.

### 6.3 Persistence
- `DOCK_STORAGE_KEY` — user's dock items persisted across sessions in `localStorage`.
- Settings (unit preferences, telemetry channels, show-dashboard) persisted the same way.

### 6.4 Chosen action verbs
`setSelectedDrivers`, `setFocusDriver`, `setComparisonDriver`, `toggleDriver`, `triggerPrediction`, `fetchDegradationRegression`, `setActiveTab`, `focusOverlay`, `closeOverlay`, `closeAllOverlays`, `tileOverlay`, `arrangeOverlays`, `applyWindowPreset`, `addDockItem`, `removeDockItem`, `resetDockItems`, `openCommandPalette`, `cycleLeaderboardColumn`, `rotateTrackCW`, `rotateTrackCCW`, `resetTrackRotation`.

---

## 7 · Analytics pipelines

Five distinct analytical methods, each coupled to a visualization.

### 7.1 PCA (principal projection for the Analytics tab)

- Backend: `sklearn.preprocessing.StandardScaler` + `sklearn.decomposition.PCA(n_components=2, random_state=42)` on the 12-feature matrix (§4.6; 534 rows of 30 cached races, `docs/evidence/pca_rebuild.txt`).
- Output: `points` (x, y, id, driver, team, year, round, race_name), `loadings` (12 × 2 with feature label), `explained_variance` [v1, v2], auto-labels for each axis from the top-2 loadings by magnitude.
- Biplot encoding: (driver, race) points coloured by team or by finishing class, loading arrows from origin, arrow length ∝ combined magnitude, label on arrow tip.
- **Methodology doc:** `docs/PCA_METHODOLOGY.md`. Features and selection rationale: `docs/pca_features.md`.

### 7.2 t-SNE (removed)

- The t-SNE projection was removed: the PCA is the dashboard's one projection (`docs/PCA_METHODOLOGY.md`, section 2 "Why PCA and not t-SNE"). The backend keeps the three former `/api/tsne/...` paths only as aliases of the `/api/pca/...` routes (`backend/api/main.py`); no store field, view or embedding file of t-SNE is left.

### 7.3 Lasso-triggered selection analysis

When the user lassos a region of the PCA biplot:
1. Frontend POSTs selected IDs → `/api/pca/analyze-selection`, with the biplot's clock during a replay (year, round, session_now).
2. Backend subsets the feature matrix to selected points vs rest (the race on screen: its rows at the replay clock).
3. For each feature: Hedges' g (small-sample corrected), its 95% interval (normal approximation of the standard error of g; none for a group of one row: `docs/PCA_METHODOLOGY.md` §5, `docs/evidence/pca_interval_coverage.txt`), N, and the |g| random selections of the same size and the same mix of row kinds reach (during a replay each random selection draws as many rows of the race on screen at the clock, and of finished races, as the selection holds: stratified, `docs/evidence/pca_stratified_baseline.txt`); a feature is "above random" past the 95th percentile of the largest |g| over all features in those random selections, or, when the compared rows mix the two kinds, past its own threshold (the same quantile level of its own random |g| for every feature, set so that 5% of the random selections pass some threshold: the progress-dependent features reach far larger |g| by the mix alone; `docs/evidence/pca_mixed_threshold.txt`). Pit stops, stint lengths and tyre degradation are marked "progress-dependent" on their rows while the kinds are mixed. Labelled "Descriptive differences, not a test" (`docs/PCA_METHODOLOGY.md` §5).
4. Ranked features, stints, tyre strategies and pit windows (in-laps of tyre changes) are returned.
5. `PCAAnalysisPanel.jsx` (Cross-Race Analysis) renders this in tabs (Summary / Patterns / Differences / Details); a pit-window click sets the lap range. `StrategyAnalysis.jsx` (the Strategy Analysis view) turns the selection's dominant strategy into one of its insight cards (`utils/insightsGenerator.js`); its own clickable battle rows, from the Monte Carlo battles, call `selectPair(behind, ahead)`, which sets the selected drivers, the focus driver and the rival of Sector Delta Waterfall and Undercut Calculator.

### 7.4 LSTM lap-time + pit-probability forecast

- Input: the driver's last 10 clean laps completed at the clock (`SEQUENCE_LEN`; at least 3, padded on the left), built in the backend from the session's lap rows by `model/features.py` `build_window`, 12 features per lap: lap-time delta to the last clean lap, tyre life, compound, laps before the origin lap, lap number, position, gap to the car ahead, track temperature, a padding flag, and the origin lap's tyre life, compound and green flag.
- Output: the next 5 lap times (as deltas to the last clean lap) + the probability of a stop within those 5 laps.
- Methods: the LSTM and the baselines of `model/baselines.py` (persistence, per-stint linear, compound mean; for the pit probability a tyre-age logistic and the base rate). The served method is the one with the best validation error (lap times: MAE, pit probability: Brier score), written to `model/saved/forecast_selection.json` by `scripts/evaluate_forecast.py`; now the LSTM for both, with its held-out test numbers in `docs/evidence/evaluate_forecast.txt`. A method that cannot run (no torch, no model) is skipped for the next one; the router's built-in heuristic answers only when `model/predict.py` cannot be imported or fails. Every response names its method.
- Triggered by: double-click on a driver (Leaderboard, Timing Sheet, Race Pace Grid), `Shift+P`, `predict-pit` command.

### 7.5 Monte Carlo race simulation (`utils/raceSimulation.js`)

- `DEFAULT_NUM_SIMULATIONS` (1,000) seeded simulations of the remaining race per call, run in a Web Worker; runtimes for 100 / 1,000 / 10,000 runs and badge stability in `docs/evidence/mc_benchmark.txt` (section 5, `frontend/scripts/mc_benchmark.mjs`).
- Every mark the views draw from a projection changes only on evidence beyond the Monte Carlo error (`utils/simulationClient.js` `projectionBadges`, chained by the store): the badges, the finishing position shown (P label: the median simulated position, `shownPositions` / `modePosition`, moved only when the median has moved beyond the error of the whole column), the battle list (the pairs surely among the six most likely, no fill by a point estimate: `docs/evidence/battle_list_rules.txt`) and its order (badge level, then race order) and the risk rows (`raceSimulation.js` `evaluateRisks`: the range ends and the mean stops to come judged beyond their sampling interval); measured on a same-state recompute with a new seed, mark by mark, in `docs/evidence/mc_stability.txt` (`frontend/scripts/mc_stability.mjs`, lead decision D5).
- The Strategy Simulator's marks follow the same rule (`whatIfMarks`, chained over the recomputes of the same plan): the verdict PLACES GAINED / LOST and the colour of each difference only when the interval of the run-by-run difference of the two runs (common random numbers) excludes 0, otherwise NO CLEAR CHANGE; each card's P label is its median finishing position, and with the model's stops as the baseline the baseline card is the Race Prediction panel's P label of that driver (the same run: `whatIfMarks` `stopModel` / `panelMode`); a mark kept only within the error yields to one beyond it when they contradict each other (`whatIfContradiction`: the plan's card, then a saved plan's card, moves within its error, `shownPositionRange`; a verdict held only by hysteresis becomes NO CLEAR CHANGE); measured, with the contradictions left and the baseline-card / panel agreement, in `docs/evidence/whatif_stability.txt` (`frontend/scripts/whatif_stability.mjs`).
- `extractRaceParams` measures pit loss (`utils/pitLoss.js`), tyre degradation per compound (`raceDegradation`: fits long enough, combined with the cached races' prior) and race-pace noise (`lapNoiseFromFits`: the pooled residual sigma of the race's per-stint fits at the clock, no floor and no prior mixed in, lead decision D1; the cached races' dry / wet value only before the first fit); see `docs/evidence/degradation_in_race.txt` (degradation) and `docs/evidence/s2_lap_noise_monza.txt` (lap noise).
- Output fed to Leaderboard → overtake probability badge (on the car ahead of an adjacent pair: the chance that the car behind passes it before the flag), coloured by the battle badge level of the store (grey below 30 %, yellow at least 30 %, orange at least 60 %, with the ⇅ glyph and the percentage, each changing only when the 95 % Wilson interval clears the threshold; never green / red, `docs/COLOR_ENCODING.md`).

### 7.6 Linear regression for degradation (brush-triggered)

- Set a lap range in any view (the Position Tracker's D3 brush, the Timing Sheet's lap-range bar, a stint on the Strategy Timeline, a pit window, a race event) → the one lap range (`brushLapRange` = `selectedLapRange`) in the store.
- `TireDegradation` subscribes, calls `/api/predict/degradation` with the range.
- Backend: least-squares fit per stint of the fuel-corrected lap time on tyre life, on the stint's clean laps (`docs/DEGRADATION_METHODOLOGY.md`); the response carries the fuel-corrected slope and the raw slope, in s/lap.
- Rendered as a fit line per stint, labelled with the fuel-corrected and the raw slope in s/lap (`TireDegradation.jsx`).

---

## 8 · Visualizations catalogue (28 views in 30 files: 22 draw with D3, 8 HTML only)

Every view is a React component in `src/components/visualizations/` that reads and writes the Zustand store inside a title-bearing `<Panel>` shell with a legend of its marks. The 28 views below are drawn by 30 files: the Sectors panel's Best tab has two files of its own, `SectorsBestTab.jsx` and its D3 chart `SectorsBestChart.jsx`. Twenty-two of the files draw SVG with D3 (`d3.select` in the component, or a drawing helper of `src/utils/views/`: `stintStripChart`, `positionRangeChart`, `sectorDeltaWaterfallChart`, `undercutSweepChart`, `effectBarsChart`, `pcaForestChart`, `pcaBiplot`, `d3Legend`); eight are HTML only (tables, grids or cards) and are described as such below: Leaderboard, Timing Tower, Race Pace Grid (its cell colour comes from a d3 threshold scale), the Sectors panel and its Best tab's frame (`SectorsPanel.jsx`, `SectorsBestTab.jsx`), Consistency panel, Race Control and Tyre Silhouette (`node frontend/scripts/audit/view_catalogue.mjs`, output `docs/evidence/view_catalogue.txt`). Charts read their box (`utils/views/chartBox.js` useBoxSize) and tables fit or page their rows (`docs/SCROLL_JUSTIFICATIONS.md`).

### 8.1 Position & timing
| View | File | Drawn as | Encoding | Analytics coupling |
|---|---|---|---|---|
| Track Map | `TrackMap.jsx` | D3 | Animated car dots on the circuit (d3.zoom pan / zoom, rotation). Sectors in `SECTOR_COLORS` with their S1-S3 legend, DRS zones, corner labels, channel overlay (speed on cividis from `SPEED_RAMP_START`, throttle / brake from the lifted track grey `CHANNEL_RAMP_LOW` to their Okabe-Ito channel colours, sky blue / orange; ramp ends >= 3:1, `docs/evidence/contrast_pairs.txt`). | Focus-driver telemetry caching, auto-fetch on channel toggle. |
| Leaderboard | `Leaderboard.jsx` | HTML table | F1 TV broadcast-style tower: position, code, team bar, tyre compound letter, gap / interval / tyre / pits column, fastest-lap FL badge, overtake-probability `⇅ XX%` badge (Monte Carlo, its three levels in the legend). The rows fit the sidebar (28 down to 18 px) and are paged below that. | `cycleLeaderboardColumn()` for INT / GAP / TYRE / PIT; a double-click asks the forecast. |
| Timing Tower (Pit Wall) | `TimingTower.jsx` | HTML table | Same data, higher density, classified-position fallback for DNF / DNS from `race_results`. | — |
| Position Tracker | `PositionByLap.jsx` | D3 | Lap × position lines, pit-window band, position trend; a D3 brush on the lap axis. | Sets and draws the one lap range. |
| Track Position / Race Situation | `RaceSituationMap.jsx` | D3 | Live PCA of the race-situation features, refitted every lap and turned onto the previous lap's axes (`livePCA.js`; during a replay the axes of a replay from the first lap, `raceSituationReference.js`); each dot drawn at its score, one loading arrow per input. Lasso. Team-coloured dots. | Lasso → StrategyAnalysis. |
| Circle of Doom | `CircleOfDoom.jsx` | D3 | The cars on a circle of one lap in seconds, the focus driver's pit-loss arc and rejoin point. | — |

### 8.2 Lap times & pace
| View | File | Drawn as | Encoding | Analytics |
|---|---|---|---|---|
| Lap Times (Timing Sheet) | `LapTimeChart.jsx` | HTML table + D3 forecast chart | A timing sheet: one row per driver (the whole field), each with the latest lap inside the lap range, its sectors, gap and tyre, in the F1 TV timing convention with the palette's `STATUS_COLORS` (`utils/colors.js`): overall best purple `#C084FC` with ◆, personal best green `#34D399` with ●, pit lap pink `#F472B6` with the text PIT; the colour is never the only cue. An HTML lap-range bar under the sheet sets the lap range. With a focus driver's forecast: the forecast rows and a D3 mini-chart of the recent laps and the forecast. | Sets and shows the one lap range. |
| Lap Delta Chart | `LapDeltaChart.jsx` | D3 | Cumulative gap delta vs the reference driver, shaded in the diverging pair with its sign. | `selectedDrivers` ↔ `focusDriver`. |
| Race Pace Grid | `RacePaceGrid.jsx` | HTML grid | Driver × lap cells classified against the driver's pace (fast / slower / much slower; bests and pit laps with their glyph). | — |
| Sector Delta Waterfall | `SectorDeltaWaterfall.jsx` | D3 | Diverging bars S1 / S2 / S3 of the focus driver against the rival for the most recent laps its width holds, with axes, a zero line and a legend; cumulative column and an average row. | `comparisonDriver` store field, shared with Undercut and StrategyAnalysis. |
| Sectors panel | `SectorsPanel.jsx`, `SectorsBestTab.jsx`, `SectorsBestChart.jsx` | HTML tables + D3 (Best tab) | Three views: the live sector times of the lap in progress, the ranked best sectors (one D3 chart per sector of each driver's gap to the session best, the best's own time with ◆) and the speed-trap rankings (there is no separate speed panel). | — |
| Consistency panel | `ConsistencyPanel.jsx` | HTML cards | One card per driver: the residual σ of the per-stint fits (`consistencySigma`), against the field's median σ. | — |

### 8.3 Strategy
| View | File | Drawn as | Encoding | Analytics |
|---|---|---|---|---|
| Strategy Timeline | `StrategyTimeline.jsx` | D3 | Gantt: each driver row = stint segments in the tyre compound colour with the compound letter, pit-stop glyphs, the focus driver's predicted stints (hatched), the PCA selection's strategies as extra rows and the Strategy Simulator's plan (dashed); the lap range as a band. | A stint click sets the one lap range. |
| Tyre Degradation | `TireDegradation.jsx` | D3 | Scatter of tyre life vs lap time + per-stint linear regression line. | Lap range → regression fetch. |
| Tyre Health | `TyreHealth.jsx` | D3 | For the focus driver (else the first selected driver): one health line and area per stint on a race lap × health (0-100 %) axis, with a compound strip below. Age decay: `100·(1 - (age/maxLife)^1.6)`. Pace penalty: `deviation·80`. The constants are the component's assumptions (`TyreHealth.jsx`). | — |
| Tyre Management (dock label: Pace Retention) | `TyreManagement.jsx` | D3 | Pace retention per stint (100 % = the driver's opening pace of the stint) against the race lap. | — |
| Tyre Silhouette | `TireSilhouette.jsx` | HTML | Compound indicator icon. | — |
| Strategy Simulator | `StrategySimulator.jsx` | D3 + table | Three tabs: Plan (the custom plan and the actual strategy as D3 stint strips on a lap axis, the stint editor), Result (cards and the two finishing-position distributions on one D3 position axis, `positionRangeChart`), Compare (the saved plans as a table with D3 strips, paged). | Monte Carlo (`utils/raceSimulation.js`). |
| Race Analysis (dock label: Strategy Analysis) | `StrategyAnalysis.jsx` | D3 + text | Insights (`utils/insightsGenerator.js`) and an analysis of a lasso selection on the Race Situation map; the field's tyre mix as D3 stint strips and the selection's differences as D3 effect bars. Battle rows clickable → `selectPair`. | Cohen's d of the selected drivers against the rest of the field on the map's features, computed in the browser; no random baseline. |
| Undercut Calculator | `UndercutCalculator.jsx` | D3 | FOCUS / RIVAL chips, KPI grid, and the gap after the stops for every candidate pit lap as a D3 sweep chart in the diverging pair (blue / orange = ahead / behind), always with the sign. | `comparisonDriver` shared. |
| Race Control | `RaceControlPanel.jsx` | HTML lists | Race-control messages and events, newest first, paged. | — |

### 8.4 Telemetry
| View | File | Drawn as | Encoding |
|---|---|---|---|
| Telemetry Strip | `TelemetryStrip.jsx` | D3 | Five mini charts: speed, delta, throttle and brake (one chart), gear, RPM. X-axis toggles between Distance (m) and Lap time (s) — TIME mode uses swap-trick (remap `Distance ← Time` on a per-trace copy, keep original as `_origDistance` for playhead lookups). Tick formatter `xTickFormat(mode)` renders `1.2k` (meters) or `12s` (seconds). |
| Speed trace | part of the `TrackMap.jsx` channel overlay | D3 | — |

### 8.5 Projections & predictions
| View | File | Drawn as | Encoding |
|---|---|---|---|
| PCA Biplot | `PCABiplot.jsx` | D3 | Scatter + loading arrows from the origin. Axes labelled by their top loadings. D3 lasso (`utils/lasso.js`). Clear-N-selected button. |
| Cross-Race Analysis | `PCAAnalysisPanel.jsx` | D3 + text | Tabs Summary / Patterns / Differences / Details (each shown when the selection has it): the selection's strategy patterns as D3 stint strips, the feature differences as a D3 forest plot (Hedges' g with its interval, `pcaForestChart`), and pit windows that set the lap range. |
| Race Prediction | `RacePredictionPanel.jsx` | Table + D3 | One table row per driver (median position P label, change, podium share) beside a D3 position-range chart of the Monte Carlo outcome (share of runs per position, P5-P95, the P3 / P10 limits, a legend). |
| Driver Compare | `DriverComparePanel.jsx` | D3 + tables | Head-to-head of two drivers: D3 gap and lap-time charts, metric tables (sectors, top speeds, race summary) and the two tyre strategies as D3 stint strips, laid in columns and pages that fit the pane. |

### 8.6 Championship
| View | File | Drawn as | Encoding |
|---|---|---|---|
| Championship Chart | `ChampionshipChart.jsx` | D3 | Cumulative points line per driver / constructor (teammates tinted and dashed, a third driver dash-dot), round dots, dotted predicted-total continuation when `showPredictions`, legend. |
| Championship Standings | `ChampionshipStandings.jsx` | D3 | Horizontal bars of the points so far at the loaded round in the team colours of the chart (a teammate's bar carries the teammate dash), the gap to the leader in the label, a legend of the teams and patterns. No predicted total. |

---

## 9 · Bidirectional coordination graph

All coordination routes through the Zustand store. Every selection mutates one or more fields; every chart subscribes via selector and redraws.

```
selectedDrivers ── Leaderboard, TrackMap, LapTimeChart, LapDeltaChart,
                    Strategy Timeline, Telemetry, Compare, Consistency,
                    Sectors, PCA biplot, Race Situation, ...
                    (not SectorDeltaWaterfall or UndercutCalculator)

focusDriver ─── TrackMap (dot drawn 1.5 × larger), LapTimeChart,
                 Leaderboard, TyreHealth, TyreDegradation,
                 SectorDeltaWaterfall (as 'focus'),
                 UndercutCalculator (as 'focus'),
                 Race Prediction, LapDeltaChart (its base driver), ...

comparisonDriver ─── SectorDeltaWaterfall (as 'reference'),
                      UndercutCalculator (as 'rival')
                      (both panels default to car ahead of focus on mount)

selectedPCAPoints ── PCABiplot ring, Cross-Race Analysis
                      (drives the analyze-selection backend call; its
                      result, pcaStrategyAnalysis, also feeds the Strategy
                      Timeline rows and a StrategyAnalysis insight)

brushLapRange = selectedLapRange ── the one lap range: Timing Sheet bar
                      and rows, Position Tracker brush, Strategy Timeline
                      band, TireDegradation regression fetch
                      (docs/COORDINATION_GRAPH.md, generated from the code)

battles (Monte Carlo) ── Leaderboard overtake badge

currentLap / currentFrameIndex ── every chart that shows time (TrackMap cars,
                      Leaderboard gaps, Strategy Timeline playhead,
                      TimelinePlayer, Telemetry playhead, RaceSituation)

raceProjection (Monte Carlo) ── Leaderboard overtake badges,
                      StrategySimulator outcome cards

championshipData ── ChampionshipChart, ChampionshipStandings

isLiveMode ── TrackMap render path, Leaderboard source,
              RaceControlFeed, WeatherBar pulse dot
```

Full graph with every arrow and trigger, and the complete subscriber lists generated from the code: [`COORDINATION_GRAPH.md`](COORDINATION_GRAPH.md).

### 9.1 Driver-focus system
Double-click a driver (Leaderboard, Timing Sheet, Timing Tower, Race Pace Grid, Race Situation map), or press `F` on the highlighted (else the first selected) driver:
- Each view that follows `focusDriver` marks it its own way (the Track Map draws its dot 1.5 × larger, `TrackMap.jsx`); the focus driver is also the Lap Delta base driver.
- A double-click in the Leaderboard, the Timing Sheet or the Race Pace Grid also asks its lap-time forecast.
- Pressing `F` on the focus driver, or "Clear All Selections" in the command palette, clears it (Escape closes windows, not the focus).

### 9.2 Battle-click pair selection (`selectPair`)
Defined in `StrategyAnalysis.jsx` and called from its battle rows (the Monte Carlo battles):
```js
setSelectedDrivers([behind, ahead]);
setFocusDriver(behind);
setComparisonDriver(ahead);
```
This single action sets the focus and the rival of Sector Delta and Undercut, and selects the pair in every view keyed on `selectedDrivers` (Compare takes them when it opens with no drivers chosen).

---

## 10 · Three rendering modes + docked layout engine

Decided by `App.jsx` in a strict order:

1. **Pit Wall (Monitor mode)** — `activeTab === 'pitwall'` (the store's initial tab). Full-screen `PitWallLayout`: `TimingTower` with the focus cards (`PitWallSectorPanel`, `FocusDriverWidget`) on the left; `SessionInfoBar`, `RacePaceGrid`, then `TrackMap`, `CircleOfDoom` and a side column (`WeatherMini`, `RaceControlFeed`).
2. **Docked (Analyze mode)** — `dockedLayout && !isPitWall`. `DockedLayout` in the center, sidebar on the left (`Leaderboard` + `SidebarFocusCards`: `PitWallSectorPanel` + `FocusDriverWidget`).
3. **Base (no view open)** — `ChartsTabContent` (the Track Map) beside the Leaderboard sidebar.

Every view other than the Pit Wall opens as a tab of the docked layout (`setActiveTab` creates it when there is none); only Settings opens as a floating `OverlayPanel`, over any of the three.

### 10.1 DockedLayout details (JetBrains-style splits)
- Tree structure: either `Split { direction, ratio, children:[A,B] }` or `Pane { tabs:[], activeTab }`.
- Hard cap `MAX_PANES = 4` enforced in the store.
- Excess tabs distributed round-robin via `_groupTabs(tabIds)`.
- Draggable splitters. Per-pane tab bar with `+` picker (portal-based dropdown) and `×` close. Close collapses pane; sibling expands; tree auto-cleans via `cleanupTree`.
- Layout toolbar: pane count badge, arrange button (`Ctrl+G` cycles grid / horizontal / vertical / main+sidebar), exit button.

### 10.2 Window presets (`utils/windowPresets.js`)
7 presets, each defining a `dockedLayout` tree plus a legacy `windows[]` array for floating fallback:

| Preset | Layout |
|---|---|
| **Strategy** | Analytics + Strategy Timeline on top (55/45), Lap Times below — vertical 60/40 |
| **Tyres** | Lap Times + Tyres side by side (55/45) |
| **Pace** | Lap Times + Sectors on top, Consistency below |
| **Prediction** | Position Tracker + Lap Times left column, Prediction + Strategy Timeline right column |
| **Overview** | Sectors + Consistency on top, Compare below |
| **Pit Window** | Track Map + Circle of Doom on top (50/50), Strategy Timeline below — vertical 50/50 |
| **Simulator** | Simulator + Strategy Timeline on top, Prediction below |

### 10.3 OverlayPanel
- Only Settings opens in it (the utility tabs of `setActiveTab`).
- Per-type default sizes (`PANEL_SIZES`): settings 820×580, championship 880×600, default 700×520; below 1440 × 900 a window opens at most at 82 % of its container (`pickDefaultSize`).
- Cascade offset based on position in `openOverlays` (each new overlay offsets +24 px).
- `ResizeObserver` + `MutationObserver` for the `autoFit` prop (used by Settings accordion): panel height tracks content, stops once user manually resizes; off below 1440 × 900.
- 8 px edge padding, minimum 420 × 320 (`MIN_W`, `MIN_H`).

---

## 11 · Customizable bottom dock

`BottomTabBar.jsx` is the main navigation surface in Analyze mode.

### 11.1 Structure
- **Body:** user-customizable dock items from `dockItems` state (persisted in `localStorage` under `DOCK_STORAGE_KEY`), then the `⋯` overflow button.
- **Fixed buttons**, after a divider: Layouts (presets and all views), `⌘K` (command palette), Settings.
- **Capacity measurement:** the dock measures its buttons and `utils/dockCapacity.js` says how many items fit beside the `⋯` button and the fixed buttons; the rest go into the `⋯` overflow popover.

### 11.2 Drag-to-reorder
Native HTML5 drag & drop. `onDragStart` sets `dragId`; `onDragOver` sets `dropTargetId`; `onDrop` computes `next = [...dockItems]`, splices out and in. Visual states: `--dragging` (dashed outline, scale 0.96, never faded), `--drop-target` (red-accent inset border).

### 11.3 Per-item affordances
- **Click:** open/focus tab.
- **Right-click:** opens `DockContextMenu`: Open, Move ←, Move →, Remove from dock, Customize dock…, Reset dock to defaults (a second click confirms).
- **Hover:** no remove badge (the `.bottom-tab-bar__remove-badge` CSS rule is no longer used).
- **Tooltip:** `"{label}{hint} — drag to reorder, right-click to configure"`.

### 11.4 Add / manage
- **Settings → Dock section** (accordion): every panel as a toggle grouped by category, plus "Reset dock to defaults" (confirm-to-apply).
- **Customize dock popover** (`DockCustomizePopover.jsx`, "Customize dock…" in the right-click menu): search box + categorized panel toggles.
- **Keyboard:** `Cmd/Ctrl+Alt+D` resets the dock (no confirmation).

### 11.5 Categories (from `slotOptions.js`)
`monitor` · `timing` · `tyres` · `strategy` · `analysis` · `prediction` · `system` (`CATEGORY_ORDER`). Each slot carries a Feather-style SVG `icon`, `category` and `hint` letter (single-key shortcut); only Pit Wall carries the `isMode` flag (a mode switch, not a view). The dock's toggle lists leave out Pit Wall (`isMode`) and Settings (by its id).

### 11.6 No scroll
The dock never scrolls: `.bottom-tab-bar` has `overflow: hidden` and `max-width: calc(100vw - 2 * var(--dock-side-gutter))`, and the items that do not fit go into the `⋯` popover (§11.1; `docs/SCROLL_HEURISTIC_EVALUATION.md`, S2).

---

## 12 · Command palette (the CLI-style searchbar)

`Cmd/Ctrl+K` opens a VS Code-style palette.

### 12.1 Implementation
- `components/CommandPalette/CommandPalette.jsx` — glass-blur modal centered on screen.
- `commandRegistry.js` — returns an array of command objects from `createCommandRegistry()`.
- `fuzzyMatch(query, target)` — ordered-character fuzzy match with score; exact substring → 0, unmatched chars accumulate positive score, returns −1 if the full query never appears.
- Filter + sort by `_score` ascending. Groups: Navigation · Actions · Drivers · Laps · Replay · Analytics · Track Map · Layout · Help.

### 12.2 Command categories
**Navigation (number keys):** Lap Times (1), Tyres (2), Strategy Timeline (3), Sectors (4), Prediction (5), Analytics/PCA (6), Compare (8), Consistency (9), Championship (0).

**Actions:** Select Driver (D → sub-menu of all drivers), Focus Driver, Compare Drivers (C → toggle), Jump to Lap (a sub-menu, no key; the `L` key toggles the Leaderboard).

**Mode switching:** Close All Overlays (X), Back to Pit Wall (`toggle-mode`, no key: it closes every window and the docked layout and shows the Pit Wall; the `P` key switches Pit Wall / Analysis and keeps the windows).

**Replay:** Play/Pause (Space), First / Last Lap (Home / End), Speed Up / Down (> / <).

**Analytics:** Run lap-time forecast + Race Prediction view (⇧P), Tyres (T: Tyre Health and Pace Retention), Analytics PCA (A), Driver Comparison (⇧G — only available when `compareDrivers.length === 2`), Cycle Leaderboard View (V).

**Track Map:** Toggle Sectors (⇧S), Toggle DRS (⇧D, seasons before 2026), Rotate CW / CCW (R / ⇧R), Reset Orientation.

**Layout:** Toggle Bottom Bar (⇧H), Arrange Open Overlays (only when >1).

**Utility / Help:** Clear All Selections, Show Shortcuts (?).

### 12.3 Sub-commands
Commands like `select-driver` or `jump-to-lap` carry a `getSubCommands()` function. Choosing the parent switches the palette to sub-menu mode; the input searches within that sub-list. Useful for "Select Driver" (20 drivers) and "Jump to Lap" (up to 78 laps).

### 12.4 `available` gate
Commands can define `available: () => bool`. Example: `driver-comparison` requires `compareDrivers.length === 2`. The filter stage drops unavailable commands before sorting.

### 12.5 Initial command (external launch)
Keyboard shortcut `D` opens the palette already in "Select Driver" sub-menu via `_paletteInitialCommand`; no other key uses it (`L` toggles the Leaderboard).

---

## 13 · Keyboard shortcuts

Defined in `hooks/useKeyboardShortcuts.js` and mirrored in `ShortcutCheatsheet/ShortcutCheatsheet.jsx` (press `?` to open).

### 13.1 Number keys (aligned with pit-wall workflow)
`1` Lap Times · `2` Tyres · `3` Strategy Timeline · `4` Sectors · `5` Prediction · `6` Analytics/PCA · `8` Compare · `9` Consistency · `0` Championship (`7` opens no view).

### 13.2 Layout & modes
`P` Toggle Pit Wall ↔ Analysis · `⇧P` Lap-time forecast of the focus driver + open Race Prediction · `W` Close last tab/window · `X` Close all / exit layout · `Escape` Close overlays/docked · `⇧H` Toggle bottom bar auto-hide · `Ctrl+G` Cycle arrangements · `Ctrl+Alt+D` Reset dock · `Ctrl+←/→/↑/↓` Tile / maximize / restore window.

### 13.3 Selection & focus
`D` Open driver selector (palette sub-menu) · `F` Focus / unfocus driver · `C` Toggle compare mode · `L` Toggle leaderboard · `V` Cycle leaderboard column · `⇧G` Driver comparison (compare mode with two drivers chosen).

### 13.4 Replay
`Space` Play/pause · `←/→` Navigate laps · `Home/End` First/last lap · `>/<` Playback speed.

### 13.5 Track map
`R / ⇧R` Rotate CW/CCW · `⇧S` Toggle sectors · `⇧D` Toggle DRS (seasons before 2026).

### 13.6 Other
`S` Strategy Timeline · `T` Tyres · `A` Analytics · `M` Strategy Simulator · `?` Cheatsheet · `/` Focus command bar · `Cmd/Ctrl+K` Command palette.

### 13.7 Defensive rules
- Input focus detection — typed keys inside text fields never trigger shortcuts.
- Platform-aware mod key via `navigator.platform` (Cmd vs Ctrl). Rendered as `⌘` on Mac, `Ctrl` elsewhere via `modKey`.

---

## 14 · Design system

### 14.1 Typography

**Two font families, both self-hosted** (WOFF2 under `frontend/public/fonts/`, one static face per weight the CSS uses, declared in `tokens.css`; no request goes to a font service) **and both under the SIL Open Font License 1.1** (the `OFL.txt` next to each):

| Family | Role | Usage |
|---|---|---|
| **Inter** 4.1 (400, 500, 600, 700, 800, 900) — `fonts/inter/` | Text and titles | The wordmark, titles, leaderboard, timing tower, tab headers, panel text, settings, the command palette (`--rh-font-sans`). |
| **JetBrains Mono** 2.304 (400, 500, 600, 700; fallback: Fira Code, SF Mono, Cascadia Code) — `fonts/jetbrains-mono/` | Monospace | Numeric values, lap times, tyre life, telemetry tooltips, keyboard kbd chips, the command palette's keys, the status marks of the timing tower. |

Numbers that change during the replay are drawn with tabular figures (`font-variant-numeric: tabular-nums`; JetBrains Mono's are tabular by design).

```css
--font-primary : 'Inter', system-ui, sans-serif;
--font-display : 'Inter', system-ui, sans-serif;
--font-mono    : 'JetBrains Mono', 'Fira Code', monospace;
--rh-font-sans : 'Inter', system-ui, -apple-system, sans-serif;
```

### 14.2 Type scale
`max(data floor, 0.6875rem) (xs)` · `max(data floor, 0.8125rem) (sm)` · `0.9375rem (base)` · `1.0625rem (lg)` · `1.25rem (xl)` · `1.5rem (2xl)` · `2rem (3xl)` · `2.5rem (4xl)`. Type floors (`tokens.css`): data text `--font-size-data`, `clamp(11px, …, 12.5px)`, and other text `--font-size-label`, `clamp(10px, …, 11.5px)`, growing with the viewport height.
Weights: `400 / 500 / 600 / 700 / 800 / 900`.
Tracking: `-0.02em (tight)` / `+0.01em (subtle)` / `+0.08em (wide, used for uppercase kickers)`.

### 14.3 Spacing
`0.25rem / 0.5rem / 1rem / 1.5rem / 2rem / 3rem` (xs → 2xl).

### 14.4 Radii
`4px (sm)` · `8px (md)` · `16px (lg)` · `24px (xl)` · `9999px (full)` · plus a finer-grained `--rh-radius-*` scale `5/6/8/10/12/14px` for the palette.

### 14.5 Z-index
`0 base · 100 dropdown · 200 sticky · 300 overlay · 400 modal · 500 tooltip`.

### 14.6 Shadows (PS5/F1 glassmorphism)
```css
--shadow-glass: 0 8px 32px rgba(0,0,0,.3),
                0 2px 8px rgba(0,0,0,.15),
                inset 0 1px 0 rgba(255,255,255,.10),
                inset 0 0 0 .5px rgba(255,255,255,.05);
```
Inner highlights simulate the iOS 26 / PS5 frosted-glass look.

### 14.7 Glassmorphism
- Background `rgba(18,18,36,0.28)` (light 0.20, heavy 0.42).
- Backdrop filter `blur(40px)` + `saturate(1.8)` (heavy `blur(64px)`).
- Border `1px solid rgba(255,255,255,0.10)`.
- Inset highlight at top edge (`inset 0 1px 0 rgba(255,255,255,.10)`).

### 14.8 Layout heights
The chrome rows shrink with the viewport height: weather bar `clamp(38px, 5.2vh, 44px)`, collapsed timeline `clamp(36px, 4.8vh, 40px)`, bottom dock `clamp(46px, 6.2vh, 52px)` plus a `clamp(6px, 0.8vh, 8px)` margin; Leaderboard sidebar `clamp(240px, 18.75vw, 300px)`; panel gap `0.75rem`. The root (`.app-container`) is exactly the viewport height with `overflow: hidden`: the page never scrolls, and the few areas that scroll inside their panel are justified in `docs/SCROLL_JUSTIFICATIONS.md`.

### 14.9 Light theme
A warm-neutral palette under `[data-theme="light"]`: text primary `#111827`, secondary `#4B5563`. Sector / tyre color hue shifts for readability on white (`--tyre-hard: #B0B0B4`, `--sector-green: #059669`, `--sector-yellow: #B45309`). Glass blur reduced to 24-40 px.

---

## 15 · Color encoding

All colors live in `utils/colors.js` and `styles/tokens.css`. Full justification in [`COLOR_ENCODING.md`](COLOR_ENCODING.md).

### 15.1 Team colors (F1 2024 official)
| Team | Hex |
|---|---|
| Red Bull Racing | `#3671C6` |
| Ferrari | `#E8002D` |
| Mercedes | `#27F4D2` |
| McLaren | `#FF8000` |
| Aston Martin | `#229971` |
| Alpine | `#FF87BC` |
| Williams | `#64C4FF` |
| RB | `#6692FF` |
| Kick Sauber | `#52E252` |
| Haas F1 Team | `#B6BABD` |

Driver → team color map hard-coded for 2024/2025 grid (VER, PER, LEC, SAI, BEA, HAM, RUS, ANT, NOR, PIA, ALO, STR, GAS, OCO, DOO, ALB, SAR, COL, TSU, RIC, LAW, HAD, BOT, ZHO, BOR, HUL, MAG) as the fallback; the loaded session's `driver_info` overrides it (`setSessionDriverColors`).

### 15.2 Tyre compounds (F1 broadcast standard)
| Compound | Hex | Text on bg |
|---|---|---|
| SOFT | `#FF3333` | black |
| MEDIUM | `#FFC300` | black |
| HARD | `#EEEEEE` | black |
| INTERMEDIATE | `#39B54A` | black |
| WET | `#00AAFF` | black |
| UNKNOWN | `#888888` | black |

(The text colour is chosen by contrast, `getTyreTextColor` → `contrastText` in `utils/colors.js`; it is black on every compound colour.)

Short labels: `S / M / H / I / W`. Undercut uses abbreviated `{letter}·L{tyreLife}` (e.g., `S·L12`) to prevent wrapping on narrow panels.

### 15.3 Sector timing (F1 TV convention, `STATUS_COLORS` of `utils/colors.js`)
- **Purple `#C084FC` with ◆** — overall best sector in the session.
- **Green `#34D399` with ●** — personal best for the driver.
- **Yellow `#FDE047`** — more than 0.3 s (sector) / 0.5 s (lap) over the reference; **orange `#F0883E`** — more than 1.0 s / 2.0 s over it (`TIMING_BANDS`: one ordered scale in the Timing Tower, the Pit Wall sector panel and the Race Pace Grid).
- **Pink `#F472B6` with P / O** — pit in / out lap.

### 15.4 State flags
`FLAG_COLORS` of `utils/colors.js`, mirrored as `--flag-*` in `tokens.css`: green `#34D399`, yellow `#FACC15`, safety car `#F59E0B`, red `#F87171`, blue `#60A5FA`; always with their label. Pit: `--status-pit` `#F472B6`. The old `--state-*` tokens (`#00ff00`, `#ff0000`, `#00bfff`) are gone.

Timeline player band tints: SC, VSC and red flag 0.14 · yellow flag 0.08 (`TimelinePlayer.jsx`); SC and VSC share the safety-car amber and are told apart by SC / V.

### 15.5 Accent
- F1 red: `#e10600` (brand), `#b80500` (dark).
- Robinhood-Legend palette accent (command palette): `#D5FD51`.

### 15.6 Country flags
3-letter IOC/FIFA codes (FastF1 format) → ISO-3166-1 alpha-2 → flag emoji via `String.fromCodePoint(0x1F1E6 + offset)`. Table covers 35 countries.

### 15.7 Monte Carlo overtake probability
Three levels (`BATTLE_BADGE_PCT` = 30 / 60 in `utils/simulationClient.js`): grey below 30 % · yellow at least 30 % · orange at least 60 %, always with the ⇅ glyph and the percentage, never green / red (`BATTLE_LEVEL_COLORS` in `Leaderboard.jsx`, §7.5). Badge background at 0.1 and border at 0.45 of the level colour.

### 15.8 Diverging bar rules (Sector Delta)
Negative = focus faster = blue `#5DA5E8` with ▼ and −. Positive = focus slower = orange `#F0883E` with ▲ and + (`DIVERGING` in `utils/colors.js`). The bars carry no value labels: each bar's value is in its tooltip, and the lap total is drawn as a line (`utils/views/sectorDeltaWaterfallChart.js`).

---

## 16 · Legends and annotation conventions

- **Every panel with an encoding has a `<Legend>`** in its `<Panel>` controls slot. `items: [{ label, color, shape }]`, `shape` one of `'circle' | 'square' | 'line' | 'band' | 'glyph' | 'badge' | 'pair' | 'symbol'` (`components/ui/Legend.jsx`).
- **Race Situation legend** = one row per team with its two driver colours (matches the dots), then the compound badges drawn under the dots.
- **Leaderboard legend strip**: ▲ places gained / ▼ lost vs grid, the compound badges, the pit P, the three ⇅ overtake levels and the ⚔ battle mark.
- **Sector Delta legend**: `▼ focus faster (−)` blue, `▲ focus slower (+)` orange.
- **Undercut legend**: `▲ focus ahead (+)` blue, `▼ focus behind (−)` orange.
- **Tooltips** follow a single pattern: glass background, mono values right-aligned, label left-aligned, stroke hairline.
- **Axes**: numeric ticks are mono-font (`JetBrains Mono`). Units always explicit in the label (`Distance (m)`, `Lap time (s)`, `Tyre life (laps)`).
- **No decorative icons inside charts.** Icons (Feather-style) are reserved for navigation (dock, command palette, settings) and action glyphs (FL, battle ⇅, pit P).

---

## 17 · Live timing subsystem

### 17.1 Stack
- `F1SignalRClient` — async, auto-reconnect. Subscribes to `LIVE_TOPICS`, among them `TimingData`, `TimingAppData`, `LapCount`, `TrackStatus`, `RaceControlMessages`, `SessionInfo`, `DriverList`, `WeatherData`, `TeamRadio`, and `CarData.z` / `Position.z` (paywalled since 2025, so in practice not received).
- `OpenF1Client` — polls `https://api.openf1.org/v1/car_data` and `.../location` every 2 s (`TELEMETRY_POLL_INTERVAL`); without an OpenF1 API key the live data are blocked while a session runs.
- `LiveSessionManager` — accumulates both streams into a single snapshot (`session_info`, `drivers`, `timing`, `positions`, `messages`). Emits WebSocket updates on change.
- `MockReplay` — replays cached sessions as if they were live so the whole pipeline can be tested off-season.

### 17.2 WebSocket protocol (`/api/live/ws`)
Messages tagged by `type` (`live/session_manager.py`, `api/routers/live.py`): among them `session_init`, `driver_list`, `lap_update`, `driver_status`, `position_update`, `strategy_update`, `lap_count`, `weather_update`, `track_status`, `race_control`, `team_radio`, `session_info`, `session_status`, `session_end`, `frame`, `heartbeat`, `resync`. Frontend `liveWebSocket.js` dispatches to store slices. UI indicators: a pulsing `LIVE` badge on the `WeatherBar` (faded while disconnected) and a `LIVE` badge on the Timeline Player.

### 17.3 Load-full-session
Connecting after a session finishes only gives a state snapshot — no lap history. `/api/live/load-full-session` resolves `session_info.event_name` against the FastF1 schedule, then calls `load_session` for the full lap history.

---

## 18 · Replay engine

`hooks/useReplayEngine.js` runs a `requestAnimationFrame` loop.

- **Wall-clock anchoring:** `wallStart = performance.now()`, `sessionStart = frames[lastIdx].t`. Each tick computes elapsed wall-clock * `playSpeed` and finds the corresponding frame index.
- **External seek detection:** if `currentFrameIndex` changes from outside the loop (e.g., scrub on timeline), `wallStart` rebases.
- **Session-swap safety:** frames are re-read from the store each tick so a session change mid-playback doesn't leave the loop indexing into a stale array.
- **Speeds:** 0.25 / 0.5 / 1 / 2 / 4 / 8.
- **Timeline Player (`ui/TimelinePlayer.jsx`)** — D3 scrubber with SC / VSC / Red Flag / Yellow Flag bands (tints 0.14 / 0.08), event marks (flags, chequered flag, pit window, fastest lap; the pit stops and position changes of the selected drivers), a tick per lap labelled every 1, 5 or 10 laps by race length, live mode degrades to a simple progress bar.

---

## 19 · VA framework mapping

| VA principle | How this project satisfies it |
|---|---|
| **Overview first, zoom / filter, details on demand** (Shneiderman 1996) | SessionSelectorScreen → Pit Wall / Analysis overview → docked workspace → brush / lasso / click → tooltip and the Cross-Race Analysis / Strategy Analysis detail panels. |
| **Coupled visualization + analytics** | Lasso triggers a descriptive comparison (Hedges' g, random baseline); a lap range triggers the degradation fit; double-click triggers the lap-time forecast. (A battle click only selects the pair, `selectPair`: a selection, not an analytic.) |
| **Multiple coordinated views** | 28 views in 30 files (22 draw with D3, 8 HTML only), one store, bidirectional routing (§9). |
| **Interpretable dimensionality reduction** | PCA with loadings arrows + auto-labeled axes (the one projection; t-SNE was removed, `docs/PCA_METHODOLOGY.md`). |
| **Prediction with uncertainty** | Lap-time point forecasts with the method's held-out error + Monte Carlo distribution bands + Strategy Simulator cards with the median position, the average, the range and the podium / points shares. |
| **Preservation of domain conventions** | F1 TV broadcast colors (purple = overall best, green = personal best, each with its glyph; tyre compound colors with their letter), team colors for 2024 grid, the pit colour with P / O, race-control flag states with their label. |
| **No-scroll, glanceable layout** | Fixed-viewport layout: the page never scrolls at the supported window sizes (`docs/SCROLL_JUSTIFICATIONS.md`), auto-hide dock, JetBrains-style splits with a strict 4-pane cap. |

---

## 20 · Performance / caching

- **Memory + disk + FastF1** triple cache on the backend: a disk-cached session is read without FastF1.
- **Background raw-session prefetch** — disk-hit triggers a daemon thread to load the raw FastF1 session so telemetry is ready without a user-visible pause.
- **Pre-computed embeddings** — `python -m scripts.pca_rebuild` (from `backend/`, through `data/processors/pca_compute.py`) saves `data/processed/pca_feature_matrix.csv` and `pca_embeddings.json`, so the PCA is instant at request time (the t-SNE pre-compute modules were removed with the t-SNE projection).
- **Compact JSON on disk** (`separators=(',', ':')`).
- **Tile / brush on-demand** — degradation regression only runs when the user sets a lap range.
- **RAF-driven playback** — single loop, no intervals, no jitter.
- **Live PCA in `livePCA.js`** — refitted every lap (current means, SDs, eigenvectors), its axes turned inside the PC1-PC2 plane onto the previous lap's (orthogonal Procrustes, `LIVE_PCA_ALIGN`), so the points do not jump when two components swap or rotate; during a replay the previous lap's axes are those of a replay from the first lap (`raceSituationReference.js`), so a rewind, a step back or a seek draws a lap as playing drew it (`docs/evidence/live_pca_rewind.txt`); dots, arrows (one per input) and crosshair share one basis (`docs/evidence/pca_repair_check.txt`).
- **Max 4 docked panes** with round-robin tab distribution keeps rendering bounded.
- **Telemetry cache (`telemetryCache`)** keyed by `{ABBR}-{lap}-{year}-{round}-{sessionType}` in the store (`telemetryCacheKey`) so repeated requests hit memory.

---

## 21 · Development workflow

### 21.1 Running
```bash
# Backend
cd backend
python api/main.py     # with the backend virtual environment active

# Frontend
cd frontend
npm install
npm run dev            # :5173, HMR, /api proxied to :8000
```

### 21.2 Pre-computing data (optional but recommended)
```bash
python -m scripts.pca_rebuild        # PCA feature matrix + embeddings
python -m model.prepare_data
python -m model.train
```

### 21.3 Env
`backend/.env` (a copy of the repository's `.env.example`) holds the optional backend variables: `OPENF1_API_KEY` for a live session, `VA_WHISPER_MODEL` for the team-radio transcription.

### 21.4 Code conventions
- React components: SVG via `useRef`, D3 inside `useEffect`, Zustand via selectors.
- Inline styles are fine for one-off decisions; `styles/*.css` for anything reused.
- No emojis in code; only when the domain uses them (flag badges, FL, ⇅ battles).
- Avoid inventing `// TODO` — if something is incomplete, either finish it or open an issue.
- Comments: only when the WHY is non-obvious (see `TyreHealth.jsx` for the 1.6-exponent calibration note).

### 21.5 Tested viewport
The layout is checked at 1536 × 750, 1366 × 768, 1920 × 1080 and 2048 × 1100 (`frontend/scripts/audit/layout_fit.mjs`, `docs/evidence/layout_fit.txt`; `docs/SCROLL_JUSTIFICATIONS.md`). The bottom bar never scrolls: the items that do not fit go into its `⋯` popover.

### 21.6 Companion docs
| File | Scope |
|---|---|
| [`INSIGHTS.md`](INSIGHTS.md) | Analytical insights discovered through the system |
| [`INTENDED_USER.md`](INTENDED_USER.md) | Persona + tasks + goals for the VA report |
| [`RELATED_WORK.md`](RELATED_WORK.md) | Related academic + commercial systems |
| [`PCA_METHODOLOGY.md`](PCA_METHODOLOGY.md) | Why PCA, feature selection, leakage audit |
| [`pca_features.md`](pca_features.md) | Feature column dictionary |
| [`DEGRADATION_METHODOLOGY.md`](DEGRADATION_METHODOLOGY.md) | Linear-regression degradation derivation |
| [`COLOR_ENCODING.md`](COLOR_ENCODING.md) | Every color choice justified |
| [`COORDINATION_GRAPH.md`](COORDINATION_GRAPH.md) | Every arrow in the brushing/linking graph |
| [`SHORTCUTS.md`](SHORTCUTS.md) | Keyboard shortcut reference |
| [`analytics_provenance.md`](analytics_provenance.md) | Where each analytic number comes from |
| [`SCROLL_JUSTIFICATIONS.md`](SCROLL_JUSTIFICATIONS.md) | Where and why scroll is allowed |

---

## Appendix A · One-line elevator pitch

> A pit-wall decision-support dashboard that couples 28 coordinated F1 race visualizations to four analytics pipelines (PCA biplot with loadings + lasso-to-descriptive comparison (Hedges' g), lap-time + pit-probability forecast (the method selected on the validation races, the LSTM), Monte Carlo race-outcome simulation, brush-to-degradation regression), wrapped in a JetBrains-style docked workspace with a customizable bottom dock, a VS-Code-style fuzzy command palette and the 43 keyboard shortcuts of the cheatsheet (`docs/evidence/cheatsheet_fit.txt`) — all themed on the official F1 TV broadcast language (team colors, tyre compound codes, purple/green sector timing, Inter + JetBrains Mono typography, iOS-26 glassmorphism).

---

*End of master ledger. Every line above is load-bearing for the final report — if something here is wrong or stale, fix it here first, then fan out to the companion docs.*
