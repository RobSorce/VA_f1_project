# F1 Race Strategy Dashboard — Project Draft

## Visual Analytics Course — Sapienza Università di Roma

### Overview

This project is an interactive F1 race strategy dashboard designed for race strategists and performance engineers. It combines real telemetry data from the FastF1 library with machine learning (LSTM, t-SNE) and AI-assisted analysis (Gemini) to support real-time and post-race strategy decisions.

### Intended User

The primary user is an **F1 race strategist** who needs to:
- Monitor race progression across multiple dimensions simultaneously
- Identify optimal pit stop windows based on tyre degradation patterns
- Compare current race strategy against historical race data
- Evaluate alternative strategy scenarios with AI assistance
- Discover hidden patterns in driver-race performance space

### Architecture

- **Backend:** Python FastAPI serving REST endpoints. Data extraction via FastF1, feature engineering, t-SNE embeddings, LSTM predictions, Gemini AI integration.
- **Frontend:** React + Vite + Zustand for reactive state management. D3.js v7 for all visualizations. No-scroll tabbed layout (1920×1080).
- **Data:** 8 cached 2024 F1 races (~953MB FastF1 cache). ~160 driver-race feature vectors for t-SNE.

### Key Features

1. **Bidirectional View Coordination** — Track Map ↔ Lap Time Chart, t-SNE ↔ Strategy Timeline, Leaderboard ↔ All views
2. **t-SNE Strategy Space** — Lasso selection triggers strategy analysis and enriches LSTM predictions
3. **LSTM Lap Predictions** — Dashed overlays on Lap Time Chart, hatched stints on Strategy Timeline
4. **Gemini AI Assistant** — Natural language strategy queries with amber overlay scenarios
5. **D3 Brush → Regression** — Brush lap range on Lap Times → degradation regression + optimal pit lap
6. **Driver Focus System** — Double-click any driver for persistent cross-view emphasis (enlarged dot, thicker line, glow effect)
7. **F1 TV Broadcast Design** — PS5-inspired glassmorphism, animated leaderboard with position transitions, team color bars, tyre dots
8. **Timeline Player** — Collapsible replay control with D3 scrubable timeline, race event markers, adjustable speed

### Datasets

- FastF1 library: telemetry, lap times, positions, tyre strategy, weather, circuit info
- 2024 Season: Rounds 1-8 cached locally
- Derived: t-SNE feature matrix (20 features × ~160 rows), LSTM training sequences

### Analytical Insights

See `INSIGHTS.md` for 5+ analytical insights discovered during development and testing.
