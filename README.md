# F1 Race Strategy Dashboard

Interactive visual analytics platform for Formula 1 race strategy analysis.

**Visual Analytics Course — Sapienza Università di Roma (DIAG)**

## Intended User

**F1 Race Strategist** — a performance engineer who monitors live race data to make pit stop timing, tyre compound, and track position decisions. The dashboard provides:

- Real-time race monitoring with animated track map and F1 TV broadcast-style leaderboard
- Historical strategy comparison via t-SNE embedding space with lasso selection
- LSTM-based lap time and pit window predictions with degradation regression
- AI-assisted strategy analysis via Gemini with visual scenario overlays
- Interactive visual exploration with bidirectional view coordination
- Driver focus system — double-click any driver for persistent cross-view highlighting
- Collapsible timeline player with D3 scrubable race events and speed control

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React + Vite + Zustand + D3.js)              │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
│  │Track Map │↔│Lap Times  │ │t-SNE     │↔│Strategy  │  │
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
│  t-SNE Embeddings | Session Cache | REST API            │
├─────────────────────────────────────────────────────────┤
│  Data: FastF1 Cache (8 races, 2024 season, ~953MB)      │
└─────────────────────────────────────────────────────────┘
```

## Setup

### Backend
```bash
cd backend
pip install -r requirements.txt

# (Optional) Pre-compute t-SNE embeddings
python -m data.processors.tsne_features
python -m data.processors.tsne_compute

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

### Environment Variables (optional)
```
GEMINI_API_KEY=your_key_here   # For real Gemini AI responses
```

## Tabs

| Tab | Content |
|-----|---------|
| **Race Overview** | Track Map (animated car positions, trails, DRS zones) + Lap Time Chart |
| **Strategy & Timing** | Lap Time Chart (with brush) + Strategy Timeline + Tyre Degradation |
| **Analytics** | t-SNE Scatterplot (with lasso) + Strategy Analysis Results |
| **AI Assistant** | Strategy Timeline (with overlays) + Gemini Chat |

## Layout

The dashboard uses a no-scroll tabbed layout (1920×1080) with:
- **Persistent sidebar** — F1 TV broadcast-style leaderboard always visible (280px left)
- **Tabbed main area** — 4 tabs with glass-pill navigation and fade transitions
- **Collapsible timeline** — hover to expand: D3 scrubable timeline with race events

## Bidirectional Coordination

- **Track Map ↔ Lap Time Chart:** Click/hover driver → highlights in both views
- **t-SNE ↔ Strategy Timeline:** Lasso select → ghost strategy rows appear
- **Leaderboard ↔ All Charts:** Click row → all charts update
- **Lap Time Brush → Degradation:** Brush lap range → regression overlay
- **Driver Focus:** Double-click any driver → persistent highlighting across all views (1.5x dot, 3px line, glow)

## Technologies

- **Frontend:** React 18, Vite 5, Zustand 4, D3.js 7
- **Backend:** Python, FastAPI, FastF1, scikit-learn, TensorFlow (LSTM)
- **AI:** Google Gemini API
- **Data:** FastF1 library (real F1 telemetry)

## Documentation

- [DRAFT.md](DRAFT.md) — Project summary
- [RELATED_WORK.md](RELATED_WORK.md) — Related systems and academic work
- [INSIGHTS.md](INSIGHTS.md) — Analytical insights from testing
