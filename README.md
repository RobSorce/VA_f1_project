# Race Strategy Dashboard

Interactive visual analytics platform for Formula 1 race strategy analysis.

> Unofficial project, not associated in any way with the Formula 1 companies. F1, FORMULA ONE, FORMULA 1, FIA FORMULA ONE WORLD CHAMPIONSHIP, GRAND PRIX and related marks are trade marks of Formula One Licensing B.V.

**Visual Analytics Course — Sapienza Università di Roma (DIAG)**

**Static demo (GitHub Pages, no backend, five races): https://robsorce.github.io/VA_f1_project/**

## Intended User

> **To be rewritten.** The goals and the usage scenario below were written for an earlier version of the dashboard; on 2026-10-15 the steps and numbers the code contradicts were removed or corrected, and they have not been rewritten for the current views yet.

**Primary persona: Pit wall race strategist** — a performance engineer seated on the F1 pit wall during a Grand Prix, responsible for real-time decisions on pit stop timing, tyre compound selection, and track position management. The persona and its use cases are described in [docs/INTENDED_USER.md](docs/INTENDED_USER.md).

**Context:** Pit wall decisions are made under time pressure on data with many dimensions at once (drivers, laps, sectors, tyre compounds, weather). Pure numerical tables are insufficient — the strategist needs visual pattern recognition augmented by predictive models and dimensionality reduction to compress the decision space.

**Goals during a live session (Monitor mode, the Pit Wall):**
- Monitor real-time gaps, tyre wear, and track position for their driver and direct rivals
- Identify the optimal pit window by comparing tyre degradation rates across the field
- React to race events (safety car, rain, incidents) by immediately evaluating strategic alternatives
- Decide when to undercut/overcut based on the gap to the car ahead and relative tyre age

**Goals in post-session analysis (Analyze mode, the docked layout):**
- Understand why a strategy succeeded or failed by exploring lap-level data across multiple coordinated views
- Find groups of similar (driver, race) rows on the PCA biplot and compare them with the other rows
- Forecast the focus driver's next five laps (lap times and the chance of a pit stop): the forecast method is chosen on validation races, today the LSTM (`backend/scripts/evaluate_forecast.py`, `docs/evidence/evaluate_forecast.txt`)
- Test "what-if" scenarios through the Strategy Simulator (Monte Carlo simulation)

**Usage scenario (to be rewritten):** In a replay of the 2024 Monza GP, the strategist double-clicks their driver in the Leaderboard: the driver becomes the focus driver of every view that follows the focus, and the forecast of the driver's next laps appears in Race Prediction and in the Timing Sheet's forecast rows. A click on the driver's current stint in the Strategy Timeline sets the dashboard's one lap range: each row of the Timing Sheet shows the driver's latest lap inside those laps and its lap-range bar shows them, the Position Tracker moves its brush to them and Tyre Degradation fits the degradation rate of those laps. The PCA biplot does not follow the lap range ([docs/COORDINATION_GRAPH.md](docs/COORDINATION_GRAPH.md), "Not linked").

**Why visual analytics (not just visualization):** The system integrates dimensionality reduction (PCA biplot with interpretable loading vectors), predictive models (LSTM lap-time forecast, Monte Carlo race simulation), and analytics triggered by visual interaction (lasso selection on PCA triggers a backend comparison of the selection with the other rows: Hedges' g per feature with an interval and a random-selection baseline). This goes beyond information visualization into visual analytics as defined by the VA course framework.

## Architecture

```
+------------------------------------------------------------------+
| Frontend: React 18 + Vite 5 + Zustand 4 + D3 7                   |
|   Pit Wall | docked split-pane layout | dock | timeline player   |
|   one Zustand store: every link between views goes through it    |
|   Monte Carlo race simulation in a Web Worker                    |
+------------------------------------------------------------------+
| Backend: FastAPI (port 8000)                                     |
|   FastF1 extractor | features | PCA + selection analysis         |
|   forecast (LSTM and baselines) | degradation fit | replay frames|
|   live timing                                                    |
+------------------------------------------------------------------+
| Data: FastF1 cache + processed JSON cache (both git-ignored),    |
|   the PCA matrix and the trained forecast model (in the repo),   |
|   the static demo data in frontend/public/data                   |
+------------------------------------------------------------------+
```

## Data coverage

- **What can be loaded:** the session picker lists the seasons from 2018 (`FIRST_SEASON`, `backend/api/main.py`) to the current one, and the next one once its calendar is published. Any Race, Qualifying, Sprint or free-practice session that FastF1 serves can be loaded; CONNECT LIVE follows a session in progress.
- **Caches:** the first load of a session downloads it through FastF1 (slow, needs internet) and keeps it in two git-ignored caches: `data/cache` at the repository root (FastF1's own cache, set in `backend/data/extractors/fastf1_extractor.py`) and `backend/data/processed_cache` (the processed JSON, so later loads are instant). A fresh clone has neither. `backend/scripts/bulk_download.py` downloads the race session of every round of the seasons asked into the processed cache (`python -m scripts.bulk_download --years 2024` from `backend/`).
- **Known issue (checked 2026-10-16):** the Formula 1 live-timing archive that FastF1 downloads from (`livetiming.formula1.com/static/...`) answers HTTP 401 to its data files, so a session that is not cached yet cannot be loaded until that changes; sessions already in the two caches, and the static demo, are not affected. The same day the legacy SignalR endpoint that CONNECT LIVE uses (`backend/live/signalr_client.py`, `/signalr/negotiate`) also answered 401, so live mode cannot connect either; the mock replay still works.
- **The races behind the analyses:** the numbers in `docs/` were computed on a local cache of 30 races: every race of 2024 (rounds 1-24) and the 2025 rounds 1, 6, 8, 16, 21 and 24. The list is the train / validation / test split printed by `backend/scripts/evaluate_forecast.py` (`docs/evidence/evaluate_forecast.txt`); `backend/scripts/pca_rebuild.py` counts the same 30 races (`docs/evidence/pca_rebuild.txt`).
- **Shipped with the repository:** the cross-race PCA built from those 30 races (`backend/data/processed/pca_feature_matrix.csv` and `pca_embeddings.json`, 534 (driver, race) rows, `docs/evidence/pca_rebuild.txt`), the trained forecast model and its method selection (`backend/model/saved/`), and the static demo data of five races (`frontend/public/data`, below).

## Setup

Requirements: Python 3 with `venv`, and Node.js with npm (the Pages workflow, `.github/workflows/deploy.yml`, builds with Node 22). Run the backend and the frontend in two terminals.

### Backend (FastAPI, http://localhost:8000)

Linux / macOS:
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python api/main.py
```

Windows (PowerShell; in `cmd` activate with `.venv\Scripts\activate.bat`, in Git Bash with `source .venv/Scripts/activate`):
```powershell
cd backend
py -m venv .venv            # or: python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python api\main.py
```

`python api/main.py` is the same as `uvicorn api.main:app` run from `backend/`: the app module is imported once, as `api.main`. It listens on `127.0.0.1:8000`, this computer only (`VA_API_HOST` and `VA_API_PORT`, below, change it). Do not start `uvicorn main:app` from `backend/api/`: the routers import `api.main`, which would load a second copy of the module (two caches, two FastF1 locks).

Optional, with the virtual environment active and from `backend/`:
- Team-radio transcription in live mode: `pip install faster-whisper` (model chosen by `VA_WHISPER_MODEL`).
- Rebuild the PCA from the cached races: `python -m scripts.pca_rebuild` (it rewrites `data/processed/`).
- Retrain the forecast: `python -m model.prepare_data`, then `python -m model.train`, then `python -m scripts.evaluate_forecast` (it chooses the method the app serves). These steps read the cached races.
- Backend tests: `pip install pytest`, then `python -m pytest -q tests`. The tests that need cached races are skipped while the caches are empty (a fresh clone); the frontend tests follow the same rule. The Pages workflow (`.github/workflows/deploy.yml`) runs both suites, with PyTorch from its CPU wheel index, and deploys the demo only when they pass.

### Frontend (Vite, http://localhost:5173)

Linux, macOS and Windows alike:
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api` (the live WebSocket included) to `http://localhost:8000`. When the backend does not answer, the app switches to the static demo below.

Other scripts (from `frontend/`): `npm test` (Vitest), `npm run build` (production build in `dist/`), `npm run build:demo` and `npm run check:demo` (the GitHub Pages build and its check without a backend).

### Static demo (GitHub Pages, no backend)
https://robsorce.github.io/VA_f1_project/ is the demo build (`npm run build:demo`, `.github/workflows/deploy.yml`, which deploys on a push to `main` or `v4`): the API is answered from `frontend/public/data`, written by `backend/scripts/export_demo_data.py` for five races (2024 R16 Monza, 2024 R5 China with its safety cars, 2025 R1 Australia in the wet, 2025 R16 Monza for a use case on boxing now or waiting for a gap in traffic, 2024 R7 Imola for one on an undercut or a cover; 8.89 MB, `docs/evidence/export_demo_data_report.txt`). A normal build whose backend does not answer switches to the same demo. Either way the weather bar shows a DEMO chip, and a switch at run time raises a toast; the LSTM forecast, telemetry, live timing and the other races say "Requires the local backend".

### Environment variables (optional)
The variables the code reads are listed, with what each one does, in [.env.example](.env.example):
- backend (`backend/.env`, a copy of `.env.example` loaded by `backend/api/main.py`, or the shell): `OPENF1_API_KEY` (OpenF1 access during a live session), `VA_WHISPER_MODEL` (team-radio transcription model);
- frontend (`frontend/.env`): `VITE_DEMO=1` makes a normal build the static demo;
- demo build (the shell running `npm run build:demo`): `DEMO_BASE`, the path the site is served under (the deploy workflow sets it from the repository name).
- backend server (`backend/.env` or the shell): `VA_API_HOST` and `VA_API_PORT`, where it listens (default `127.0.0.1:8000`, this computer only), and `VA_CORS_ORIGINS`, the origins a browser may call the API from (default the Vite dev and preview servers; no credentials).

## Layout

After a session is picked on the start screen (season, event and session, or CONNECT LIVE), the dashboard fills the browser window; the page itself never scrolls (the views that scroll inside their own pane are listed in [docs/SCROLL_JUSTIFICATIONS.md](docs/SCROLL_JUSTIFICATIONS.md)).

- **Top bar** (weather bar): session and weather, the command bar, the layout presets and the session menu; the DEMO chip in the static demo.
- **Pit Wall** (Monitor mode, shown after a session loads; `p` switches between it and the analysis area): the Timing Tower with the sector panel and the focus-driver card on the left; the session bar, the Race Pace Grid, the Track Map, the Circle of Doom, the weather and the race-control feed on the right.
- **Analysis area** (Analyze mode): the Leaderboard sidebar (collapsible, with the focus-driver cards) beside the Track Map, or beside the docked layout once a view is opened. The docked layout is a split-pane workspace: each pane holds tabs (its `+` adds one), the splitters resize the panes, "Arrange" cycles the arrangement and "Exit Layout" returns to the Pit Wall. The layout presets of the top bar fill it in one click (Strategy, Tyres, Pace, Prediction, Overview, Pit Window, Simulator), and the custom layout builder picks a pane shape and a view per slot.
- **Dock** (bottom bar): one button per view, grouped Monitor, Timing, Tyres, Strategy, Analysis, Prediction and System, with the Pit Wall as a mode switch. A click opens the view as a tab of the docked layout and a second click closes it; drag a button to reorder the dock, right-click it to configure; the buttons that do not fit go to the ⋯ overflow menu.
- **Timeline player** (bottom, collapsible): play / pause and replay speed, and a scrubber with the race's track-status events (flags, safety car, VSC); a click on a race event sets the lap range.
- **Settings** open as a floating panel over any mode.
- **Keyboard:** Ctrl+K (Cmd+K) opens the command palette, `?` the shortcut cheat sheet ([docs/SHORTCUTS.md](docs/SHORTCUTS.md)).

## Bidirectional Coordination

Every link goes through the Zustand store; [docs/COORDINATION_GRAPH.md](docs/COORDINATION_GRAPH.md) describes each one and lists, generated from the code (`frontend/scripts/coordination_matrix.mjs`), which view writes and which view subscribes to each coordination field.

- **Track Map (TrackMap) ↔ Leaderboard (Leaderboard):** a click on a driver in either view selects it in both (`selectedDrivers`); hovering highlights it in both (`highlightedDriver`)
- **Position Tracker (PositionByLap) ↔ Timing Sheet (LapTimeChart):** a lap range brushed on the Position Tracker or dragged on the Timing Sheet's lap-range bar is the dashboard's one lap range (`brushLapRange`, always equal to `selectedLapRange`): each view draws the range set in the other, the sheet shows each driver's latest lap inside it, and a clear in either view clears it in both
- **Strategy Timeline (StrategyTimeline) ↔ Timing Sheet (LapTimeChart), Position Tracker:** a click on a stint sets the same lap range: each row of the sheet shows the driver's latest lap inside it and the sheet's bar shows it, the Position Tracker moves its brush to it; a range dragged on the bar or brushed on the Position Tracker is shaded on the timeline
- **PCA Biplot (PCABiplot) ↔ Cross-Race Analysis (PCAAnalysisPanel):** a lasso or a click on the biplot selects rows (`selectedPCAPoints`) and asks their analysis; the panel's clear button empties the selection on the biplot
- **PCA Biplot (PCABiplot) ↔ Leaderboard (Leaderboard):** a lasso selects the drivers of the lassoed rows in the leaderboard; a click on a leaderboard row rings that driver's points on the biplot (`selectedDrivers`)
- **Race Situation map (RaceSituationMap) ↔ Race Analysis (StrategyAnalysis):** a lasso on the map selects drivers (`selectedDrivers`) that the Race Analysis panel compares with the field; an insight that names drivers selects them on the map
- **Race Pace Grid (RacePaceGrid) ↔ Leaderboard (Leaderboard):** a double-click on a column header focuses that driver (`focusDriver`); clicks and hovers select and highlight in both (`selectedDrivers`, `highlightedDriver`)
- **Lap range → Tyre Degradation (one way):** the lap range (set in any of the views above) is fitted for the focus driver by the backend degradation route
- **Driver focus:** a double-click on a driver (Leaderboard, Timing Sheet, Race Pace Grid) makes it the focus driver of every view that follows the focus and asks its lap-time forecast

## Technologies

- **Frontend:** React 18, Vite 5, Zustand 4, D3.js 7
- **Backend:** Python, FastAPI, FastF1, scikit-learn, PyTorch (LSTM)
- **Data:** FastF1 library (real F1 timing and telemetry)

## Documentation

- [docs/RELATED_WORK.md](docs/RELATED_WORK.md) — Related systems and academic work, and credits
- [docs/INSIGHTS.md](docs/INSIGHTS.md) — Analytical insights discovered through the system
- [docs/INTENDED_USER.md](docs/INTENDED_USER.md) — Intended user persona and use cases
- [docs/USE_CASES.md](docs/USE_CASES.md) — Five use cases (strategist, race engineer, data analyst) on cached races, repeatable in the static demo
- [docs/PCA_METHODOLOGY.md](docs/PCA_METHODOLOGY.md) — PCA methodology and justification
- [docs/DEGRADATION_METHODOLOGY.md](docs/DEGRADATION_METHODOLOGY.md) — Tyre degradation computation
- [docs/COORDINATION_GRAPH.md](docs/COORDINATION_GRAPH.md) — View coordination graph
- [docs/COLOR_ENCODING.md](docs/COLOR_ENCODING.md) — Color encoding documentation
- [docs/SCROLL_JUSTIFICATIONS.md](docs/SCROLL_JUSTIFICATIONS.md) — The views that scroll inside their pane, and why
- [docs/SHORTCUTS.md](docs/SHORTCUTS.md) — Keyboard shortcuts reference
- [docs/evidence/README.md](docs/evidence/README.md) — The script outputs every number in the documentation comes from

## Credits

- [FastF1](https://github.com/theOehrly/Fast-F1) (MIT licence): the backend reads the sessions, laps, telemetry, schedules and results of past sessions through it.
- [f1-race-replay](https://github.com/IAmTomShaw/f1-race-replay) (MIT licence): the replay frames built by `backend/data/extractors/fastf1_extractor.py` (`extract_race_frames`) reuse its frame format.
- [Inter](https://github.com/rsms/inter) 4.1 and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) 2.304 (SIL Open Font License 1.1): the typefaces of the dashboard, self-hosted in `frontend/public/fonts` with their licences (`OFL.txt`).
- [MultiViewer](https://multiviewer.app/changelog), Circle of Doom (introduced in v2.8.0, 24 Jul 2026; changed in v2.9.0, 26 Sep 2026): the inspiration of our Circle of Doom view. Ours has a pit-loss estimator checked on the cached races (`backend/scripts/validate_pit_loss_and_rejoin.py`, `docs/evidence/validate_pit_loss_and_rejoin.txt`: the dashboard's estimator, `frontend/src/utils/pitLoss.js`, is the row `causal_fixed`, its median over a whole race the column `true_loss`; the row `current_code` is the earlier in-lap-only estimate it is compared with), the probability of each rejoin position, a "pit in k laps" projection, and the coordination with the rest of the dashboard.
