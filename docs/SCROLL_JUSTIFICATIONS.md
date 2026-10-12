# Scrollable Views Justification

The application targets a 1920x1080 no-scroll layout (`overflow: hidden` on body). Scrolling is enabled only where content length is inherently variable and cannot be predicted at design time.

## Justified Scrollable Areas

| Area | Component | Scroll Direction | Justification |
|------|-----------|-----------------|---------------|
| Leaderboard driver list | `Leaderboard.jsx` | Vertical | 20 F1 drivers fit in a standard sidebar at 1080p. No scroll needed at design resolution. Scroll enabled as fallback for smaller viewports or when detailed prediction data expands row height. |
| LapTimeChart timing rows | `LapTimeChart.jsx` | Vertical | Each selected driver renders as a row of lap-time cells. With 20 drivers and variable column count (one per lap, up to 78 laps), the row container must scroll vertically when more than ~8 drivers are selected simultaneously. Horizontal: each row is a fixed-width D3 SVG, no horizontal scroll. |
| PCA Analysis Panel | `PCAAnalysisPanel.jsx` / `StrategyAnalysis.jsx` | Vertical | Displays variable-length cluster analysis results: feature importance bars, pit window cards, stint pattern summaries. Content length depends on user's lasso selection size. The primary biplot remains always visible in a fixed-size container; only the analysis detail panel scrolls. |
| StrategyTimeline | `StrategyTimeline.jsx` | Horizontal (implicit via D3 zoom/pan) | Race length varies 50-78 laps. D3 pan/zoom allows horizontal navigation without CSS scroll. Not a CSS overflow — handled by D3 transform. |
| RacePaceGrid | `RacePaceGrid.jsx` | Horizontal | Grid columns = race laps (up to 78). At 1920px width with 20 driver rows, horizontal scroll is required beyond ~50 visible columns. Vertical: all 20 drivers fit without scroll. |
| Race Control Feed | `RaceControlFeed.jsx` (Pit Wall mode) | Vertical | Accumulates live race control messages over race duration. Message count is unbounded; scroll is essential. |
| Gemini AI chat | `GeminiAssistant.jsx` | Vertical | Chat conversation grows unboundedly. Standard chat UX requires scroll. |
| Settings panel | `SettingsTabContent.jsx` | Vertical | Settings sections exceed viewport at smaller panel sizes. |

## Areas That Must NOT Scroll

| Area | Reason |
|------|--------|
| Main dashboard layout | Fixed 1920x1080 grid. Scroll indicates a flex chain bug. |
| TrackMap | Fixed viewport with D3 zoom/pan. No CSS scroll. |
| PCA Biplot | Fixed viewport with D3 zoom/pan. No CSS scroll. |
| ChampionshipChart | Fixed viewport. Data fits within chart bounds. |
| BottomTabBar | Horizontal overflow handled via `overflow-x: auto` with hidden scrollbar (CSS) for graceful degradation. |

## CSS Implementation

Global rule in `dashboard.css`:
```css
.panel-content { overflow: hidden !important; }
```

Exceptions are granted per-component via specific class selectors:
```css
.timing-sheet__body { overflow-y: auto !important; }
```

This prevents accidental scroll introduction while allowing justified cases.
