# F1 Race Strategy Dashboard

Interactive visual analytics platform for Formula 1 race strategy analysis.

**Visual Analytics Course — Sapienza Università di Roma (DIAG)**

## Intended User

**Primary persona: Pit wall race strategist** — a performance engineer seated on the F1 pit wall during a Grand Prix, responsible for real-time decisions on pit stop timing, tyre compound selection, and track position management.

**Context:** Pit wall decisions must be made in under 30 seconds on data with high dimensionality (20 drivers x 3 sectors x 50+ laps x 5 compounds x weather). Pure numerical tables are insufficient — the strategist needs visual pattern recognition augmented by predictive models and dimensionality reduction to compress the decision space.

**Goals during a live session (Monitor mode):**
- Monitor real-time gaps, tyre wear, and track position for their driver and direct rivals
- Identify the optimal pit window by comparing tyre degradation rates across the field
- React to race events (safety car, rain, incidents) by immediately evaluating strategic alternatives
- Decide when to undercut/overcut based on the gap to the car ahead and relative tyre age

**Goals in post-session analysis (Analyze mode):**
- Understand why a strategy succeeded or failed by exploring lap-level data across multiple coordinated views
- Identify clusters of historically similar strategies via PCA dimensionality reduction and compare their outcomes
- Forecast 3-5 laps ahead using LSTM predictions to anticipate position changes before they happen
- Test "what-if" scenarios through the Strategy Simulator (Monte Carlo simulation)

**Usage scenario:** During the 2024 Monza GP, the strategist focuses on their driver (double-click on Leaderboard). All views highlight that driver. The StrategyTimeline shows the current stint is 18 laps on Hard compound. A click on that stint selects its laps in every view: the Timing Sheet filters its rows to them and shows them on its lap-range bar, the Position Tracker brushes them and the Tyre Degradation panel fits the stint's degradation rate. The PCA biplot clusters this stint profile with historical 2-stop aggressive strategies. The LSTM prediction (triggered by double-click) forecasts a 0.5s lap time spike in 3 laps. The strategist radios: "Box this lap."

**Why visual analytics (not just visualization):** The system integrates dimensionality reduction (PCA biplot with interpretable loading vectors), machine learning (LSTM lap time prediction, Monte Carlo simulation), and analytics triggered by visual interaction (lasso selection on PCA triggers a backend comparison of the selection with the other rows: Hedges' g per feature with an interval and a random-selection baseline). This goes beyond information visualization into visual analytics as defined by the VA course framework.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React + Vite + Zustand + D3.js)              │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
│  │Track Map │↔│Lap Times  │ │PCA biplot│↔│Strategy  │  │
│  │Leaderboard│ │Brush→Regr │ │Lasso→    │ │Timeline  │  │
│  └──────────┘ └───────────┘ │Analysis  │ │+Overlays │  │
│                             └──────────┘ └──────────┘  │
│  Zustand Store (bidirectional coordination hub)         │
├─────────────────────────────────────────────────────────┤
│  Backend (FastAPI)                                       │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
│  │FastF1    │ │Feature    │ │LSTM      │ │Gemini    │  │
│  │Extractor │ │Engineering│ │Predictor │ │AI Client │  │
│  └──────────┘ └───────────┘ └──────────┘ └──────────┘  │
│  PCA Projections | Session Cache | REST API             │
├─────────────────────────────────────────────────────────┤
│  Data: FastF1 Cache (8 races, 2024 season, ~953MB)      │
└─────────────────────────────────────────────────────────┘
```

## Setup

### Backend
```bash
cd backend
pip install -r requirements.txt

# (Optional) Pre-compute the PCA feature matrix and biplot
# (otherwise built from the session cache on the first request)
python -m data.processors.pca_compute

# (Optional) Train LSTM model
python -m model.prepare_data
python -m model.train

# Start API server
python api/main.py
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend proxies API requests to `http://localhost:8000`.

### Static demo (GitHub Pages, no backend)
The GitHub Pages site is the demo build (`npm run build:demo`, `.github/workflows/deploy.yml`): the API is answered from `frontend/public/data`, written by `backend/scripts/export_demo_data.py` for three races (2024 R16 Monza, 2024 R5 China with its safety cars, 2025 R1 Australia in the wet; 5.54 MB, `notes/experiments/phase9/verify_cleanup-demo_r2/export_rerun_report.txt`). A normal build whose backend does not answer switches to the same demo. Either way the weather bar shows a DEMO chip, and a switch at run time raises a toast; the LSTM forecast, Gemini, telemetry, live timing and the other races say "Requires the local backend".

### Environment Variables (optional)
```
GEMINI_API_KEY=your_key_here   # For real Gemini AI responses
```

## Tabs

| Tab | Content |
|-----|---------|
| **Race Overview** | Track Map (animated car positions, trails, DRS zones) + Lap Time Chart |
| **Strategy & Timing** | Lap Time Chart (with brush) + Strategy Timeline + Tyre Degradation |
| **Analytics** | PCA Biplot (with lasso) + Strategy Analysis Results |
| **AI Assistant** | Strategy Timeline (with overlays) + Gemini Chat |

## Layout

The dashboard uses a no-scroll tabbed layout (1920×1080) with:
- **Persistent sidebar** — F1 TV broadcast-style leaderboard always visible (280px left)
- **Tabbed main area** — 4 tabs with glass-pill navigation and fade transitions
- **Collapsible timeline** — hover to expand: D3 scrubable timeline with race events

## Bidirectional Coordination

Every link goes through the Zustand store; [docs/COORDINATION_GRAPH.md](docs/COORDINATION_GRAPH.md) describes each one and lists, generated from the code (`frontend/scripts/coordination_matrix.mjs`), which view writes and which view subscribes to each coordination field.

- **Track Map (TrackMap) ↔ Leaderboard (Leaderboard):** a click on a driver in either view selects it in both (`selectedDrivers`); hovering highlights it in both (`highlightedDriver`)
- **Position Tracker (PositionByLap) ↔ Timing Sheet (LapTimeChart):** a lap range brushed on the Position Tracker or dragged on the Timing Sheet's lap-range bar is the dashboard's one lap range (`brushLapRange`, always equal to `selectedLapRange`): each view draws the range set in the other, the sheet shows each driver's latest lap inside it, and a clear in either view clears it in both
- **Strategy Timeline (StrategyTimeline) ↔ Timing Sheet (LapTimeChart), Position Tracker:** a click on a stint sets the same lap range: the sheet filters its rows to those laps and shows them on its bar, the Position Tracker moves its brush to them; a range dragged on the bar or brushed on the Position Tracker is shaded on the timeline
- **PCA Biplot (PCABiplot) ↔ Cross-Race Analysis (PCAAnalysisPanel):** a lasso or a click on the biplot selects rows (`selectedPCAPoints`) and asks their analysis; the panel's clear button empties the selection on the biplot
- **PCA Biplot (PCABiplot) ↔ Leaderboard (Leaderboard):** a lasso selects the drivers of the lassoed rows in the leaderboard; a click on a leaderboard row rings that driver's points on the biplot (`selectedDrivers`)
- **Race Situation map (RaceSituationMap) ↔ Race Analysis (StrategyAnalysis):** a lasso on the map selects drivers (`selectedDrivers`) that the Race Analysis panel compares with the field; an insight that names drivers selects them on the map
- **Race Pace Grid (RacePaceGrid) ↔ Leaderboard (Leaderboard):** a double-click on a column header focuses that driver (`focusDriver`); clicks and hovers select and highlight in both (`selectedDrivers`, `highlightedDriver`)
- **Lap range → Tyre Degradation (one way):** the lap range (set in any of the views above) is fitted for the focus driver by the backend degradation route
- **Driver focus:** a double-click on a driver (Leaderboard, Timing Sheet, Race Pace Grid) focuses it in every view and asks its lap-time forecast

## Technologies

- **Frontend:** React 18, Vite 5, Zustand 4, D3.js 7
- **Backend:** Python, FastAPI, FastF1, scikit-learn, PyTorch (LSTM)
- **AI:** Google Gemini API
- **Data:** FastF1 library (real F1 telemetry)

## Documentation

- [docs/RELATED_WORK.md](docs/RELATED_WORK.md) — Related systems and academic work
- [docs/INSIGHTS.md](docs/INSIGHTS.md) — Analytical insights discovered through the system
- [docs/INTENDED_USER.md](docs/INTENDED_USER.md) — Intended user persona and use cases
- [docs/PCA_METHODOLOGY.md](docs/PCA_METHODOLOGY.md) — PCA methodology and justification
- [docs/DEGRADATION_METHODOLOGY.md](docs/DEGRADATION_METHODOLOGY.md) — Tyre degradation computation
- [docs/COORDINATION_GRAPH.md](docs/COORDINATION_GRAPH.md) — View coordination graph
- [docs/COLOR_ENCODING.md](docs/COLOR_ENCODING.md) — Color encoding documentation
- [docs/SHORTCUTS.md](docs/SHORTCUTS.md) — Keyboard shortcuts reference
