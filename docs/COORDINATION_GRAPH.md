# View Coordination Graph

All coordination flows through the Zustand store (`useF1Store.js`). Views emit selections by calling store actions; other views react via Zustand selectors.

## Coordination Matrix

| Emitter \ Receiver | TrackMap | LapTimeChart | Leaderboard | PCABiplot | StrategyAnalysis | TireDeg | StrategyTimeline | RaceSituation |
|---------------------|---------|-------------|------------|----------|----------------|---------|-----------------|--------------|
| **Leaderboard** | `selectedDrivers` | `selectedDrivers` | — | highlight | `selectedDrivers` | `focusDriver` | `selectedDrivers` | `selectedDrivers` |
| **TrackMap** | — | `highlightedDriver` | `highlightedDriver` | — | — | — | — | — |
| **LapTimeChart** | `brushLapRange` | — | — | — | — | `brushLapRange`→regression | `selectedLapRange` | — |
| **PCABiplot** | — | — | — | — | `selectedTSNEPoints` | — | — | — |
| **StrategyAnalysis** | — | — | — | highlight back | — | — | `selectedLapRange` | — |

## Bidirectional Pairs

### 1. PCABiplot <-> StrategyAnalysis/PCAAnalysisPanel
- **Forward**: Lasso on biplot writes `selectedTSNEPoints` -> `StrategyAnalysis.jsx` calls `fetchTSNEAnalysis` -> displays cluster features, pit windows
  - `PCABiplot.jsx:~210` (lasso release handler) -> `useF1Store.setSelectedTSNEPoints`
  - `StrategyAnalysis.jsx:~30` (useEffect on `selectedTSNEPoints`) -> `fetchTSNEAnalysis`
- **Backward**: Click pit window in analysis panel writes `selectedLapRange` -> PCABiplot highlights drivers in that range
  - `PCAAnalysisPanel.jsx` -> `useF1Store.setSelectedLapRange`

### 2. Leaderboard <-> All Visualizations
- **Forward**: Click driver in Leaderboard writes `selectedDrivers` -> every chart (TrackMap, LapTimeChart, TireDeg, etc.) filters/highlights
  - `Leaderboard.jsx:~onclick` -> `toggleDriver()`
  - All visualization components subscribe to `selectedDrivers` via Zustand selectors
- **Backward**: Hover on TrackMap or LapTimeChart writes `highlightedDriver` -> Leaderboard highlights row
  - `TrackMap.jsx` / `LapTimeChart.jsx` -> `setHighlightedDriver`
  - `Leaderboard.jsx` subscribes to `highlightedDriver`

### 3. LapTimeChart <-> TireDegradation (via brush)
- **Forward**: Brush on LapTimeChart writes `brushLapRange` -> TireDegradation triggers regression on that range
  - `LapTimeChart.jsx` D3 brush handler -> `setBrushLapRange`
  - `TireDegradation.jsx:~27` useEffect on `brushLapRange` -> `fetchDegradationRegression`
- **Backward**: Both charts share `selectedDrivers` and `focusDriver` state

### 4. Driver Focus (double-click flow)
- Double-click on Leaderboard -> `setFocusDriver` -> persistent highlight in TrackMap, LapTimeChart, TireDeg, RaceSituation, all panels

## Store Fields Used for Coordination

| Field | Emitters | Receivers |
|-------|---------|----------|
| `selectedDrivers` | Leaderboard, CommandPalette | All visualizations |
| `highlightedDriver` | TrackMap, LapTimeChart, Leaderboard | TrackMap, LapTimeChart, Leaderboard, PCABiplot |
| `focusDriver` | Leaderboard (dbl-click) | TireDeg, TelemetryStrip, RaceSituation, LapDelta |
| `selectedTSNEPoints` | PCABiplot (lasso) | StrategyAnalysis, PCAAnalysisPanel |
| `brushLapRange` | LapTimeChart (D3 brush) | TireDegradation |
| `selectedLapRange` | PCAAnalysisPanel, StrategyAnalysis | LapTimeChart, TrackMap, StrategyTimeline |
| `currentLap` | TimelinePlayer, keyboard | All time-dependent visualizations |

## Analytics Triggered by Visual Interaction

1. **Lasso on PCA biplot** -> backend `POST /api/tsne/analyze-selection` -> feature importance (Cohen's d), pit windows, stint patterns -> displayed in `PCAAnalysisPanel`
2. **Brush on LapTimeChart** -> backend `POST /api/predict/degradation` -> linear regression on brushed range -> displayed in `TireDegradation`
3. **Click driver in Leaderboard** -> PCA focus highlighting + `raceSituationData.driverFeatures` recomputed with updated driver context
