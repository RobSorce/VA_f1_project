# View Coordination Graph

All coordination flows through the Zustand store (`frontend/src/store/useF1Store.js`). A view **writes** a coordination field when it calls a store action that assigns it; a view **subscribes** to a field when it reads it with a `useF1Store` selector, so it redraws when the field changes. A read inside an event handler (`getState()`) is not a subscription.

The tables at the end of this document are generated from the code by `frontend/scripts/coordination_matrix.mjs`: it reads which coordination fields each store action assigns (following the actions it calls) and scans every `useF1Store` selector and store call under `frontend/src/components` and `frontend/src/hooks`. `frontend/src/__tests__/coordination.matrix.test.js` fails when the tables no longer match the code; after changing a link, run `node scripts/coordination_matrix.mjs --write` from `frontend/`. Session loads and replay-clock moves (`loadSession`, `setCurrentLap`, ...) are not counted as links: they reset or re-ask state for another session or clock, they do not carry a choice from one view to another. `commandRegistry` (the command bar and palette) and `useKeyboardShortcuts` (the keys, `docs/SHORTCUTS.md`) appear as writers too.

## The links, view by view

### 1. Drivers: selection, hover, focus

- `selectedDrivers`: a click on a driver (`toggleDriver`) in the Leaderboard, Timing Tower, Track Map, Timing Sheet, Race Pace Grid, Strategy Timeline, Telemetry, Race Situation map, Championship chart or standings, or the command palette's driver list; a Shift-, Ctrl- or Cmd-click on a car of the Circle of Doom; a lasso on the Race Situation map or the PCA biplot (`setSelectedDrivers`); a driver clicked in the Cross-Race Analysis panel's Details, or an insight card of Strategy Analysis. Almost every view subscribes and highlights or filters the selected drivers.
- `highlightedDriver`: hover (`setHighlightedDriver`). Every view that writes it also subscribes to it, so the driver under the pointer is highlighted in all of them at once, except the Timeline Player, which highlights the driver of a race event under the pointer without following the highlight itself.
- `focusDriver`: `setFocusDriver`, from a driver row or mark (a double-click in the Leaderboard, the Timing Sheet, the Timing Tower, the Race Pace Grid and the Race Situation map, a click on a car in the Circle of Doom; the generated table lists every view that sets it), the `F` key or `Shift+P`. Setting the same driver again clears the focus. Setting the focus also makes it the Lap Delta baseline (`lapDeltaBaseDriver`) and clears the forecast of the previous focus driver (`forecastReset`). A double-click in the Leaderboard, the Timing Sheet or the Race Pace Grid, and `Shift+P`, also ask the lap-time forecast of that driver (`triggerPrediction`); a double-click on the driver already in focus keeps the focus and asks again.
- `comparisonDriver`: the rival of the Sector Delta Waterfall and the Undercut Calculator; set by either of them, or by a Strategy Analysis insight that names a pair of drivers (the car behind becomes the focus, the car ahead the rival). The Undercut Calculator (`UndercutCalculator.jsx`) is in the view map of `App.jsx` but not in the dock registry (`frontend/src/utils/slotOptions.js`), so no control of the dashboard opens it; the Circle of Doom's "pit in k laps" (section 6) took its place.

### 2. One lap range for every view (`selectedLapRange` = `brushLapRange`)

- The store keeps one lap range under two names: `setBrushLapRange` and `setSelectedLapRange` both set `brushLapRange` and `selectedLapRange` to the same value, and `clearSelection` clears both (`frontend/src/store/useF1Store.js`). Every lap-range action replaces the range, so the newest one shows in every view; a clear in any view clears it everywhere (`frontend/src/__tests__/coordination.matrix.test.js`, scenarios in `docs/evidence/range_scenarios.txt`).
- Written by the **Position Tracker** brush (`PositionByLap.jsx`: `setBrushLapRange([lapStart, lapEnd])`; a click on the chart or the "LAP a–b" chip clears it), the **Timing Sheet**'s lap-range bar (`LapTimeChart.jsx`, through `lapBrushUpdate` of `frontend/src/utils/views/lapTimeChart.js`; a click on the bar or its "L a–L b" chip clears it), a stint click on the **Strategy Timeline**, a pit-window click in the **Cross-Race Analysis** panel (`PCAAnalysisPanel.jsx`) and a race-event click on the **Timeline Player**.
- Shown by the Position Tracker (it moves its brush to the stored range, `brush.move`), the Timing Sheet (each row shows the driver's latest lap inside the range, the title names the range and the bar draws it), the Strategy Timeline (shades the laps) and Telemetry (in laps mode, compares the laps of the range).
- **Tyre Degradation** (`TireDegradation.jsx`) subscribes to the range: its chart fits the range for the focus driver (else the first selected one) once that driver has 3 completed laps in it (`BRUSH_MIN_LAPS`), and for a range of 5 laps or more it asks the backend fit of those laps (section "Analytics triggered by visual interaction"); it writes nothing back.
- Example: a stint clicked on the Strategy Timeline (laps 5-15) makes each row of the sheet show the driver's latest lap inside laps 5-15, names them in the sheet's title and on its bar, moves the Position Tracker brush to laps 5-15 and refits Tyre Degradation; a new brush on the Position Tracker (laps 30-40) then moves every view to laps 30-40, and its clear leaves no range anywhere.
- Another session put on screen clears the range (`screenSwitchState` of the store, decision D8): laps of one race never filter the next.

### 3. (merged into section 2)

- The lap range was described in two sections, a brushed and a selected range; the code has one range, section 2.

### 4. PCA lasso -> Cross-Race Analysis -> Strategy Timeline (`selectedPCAPoints`, `pcaStrategyAnalysis`)

- **PCA biplot** (`PCABiplot.jsx`): a lasso (Shift+drag) or a click on a point calls `setSelectedPCAPoints(ids)`, `fetchPCAAnalysis(ids)` and `setSelectedDrivers` with the drivers of those rows; its clear action empties the selection and the driver selection.
- **Cross-Race Analysis** (`PCAAnalysisPanel.jsx`, beside the biplot) subscribes to `selectedPCAPoints` and to the analysis `fetchPCAAnalysis` stores in `pcaStrategyAnalysis`; its clear button calls `setSelectedPCAPoints([])`, which drops the analysis, and the biplot redraws without the selection. A pit-window click sets the lap range (section 2); a driver clicked in its Details becomes the focus and the only selected driver.
- **Strategy Timeline** subscribes to `pcaStrategyAnalysis` and draws the selection's tyre strategies as extra rows under the drivers; **Strategy Analysis** (`StrategyAnalysis.jsx`) reads it for its insights.
- The store field is `selectedPCAPoints`. There is no t-SNE field, action or view: the dashboard's projection is the PCA (`docs/PCA_METHODOLOGY.md`, section 2).

### 5. Race Situation map -> Strategy Analysis (`selectedDrivers`)

- **Race Situation map** (`RaceSituationMap.jsx`): a click toggles a driver, a double-click focuses it, a lasso writes `setSelectedDrivers(ids)`.
- **Strategy Analysis** (`StrategyAnalysis.jsx`, beside the map in the Analytics (PCA) view, and a dock view of its own) subscribes to `selectedDrivers` and compares the selected drivers with the rest of the field on their race-state features (the map's inputs plus the predicted pace and the laps to the likely stop; Cohen's d, computed in the browser). Its insight cards write `selectedDrivers`, `focusDriver` and `comparisonDriver`.

### 6. Circle of Doom (`focusDriver`, `highlightedDriver`, `selectedDrivers`)

- **Circle of Doom** (`CircleOfDoom.jsx`, dock view "Circle of Doom", Pit Window window preset): a click on a car sets the focus (`setFocusDriver`; a click on the focus car clears it, the second click of a double-click does nothing), a Shift-, Ctrl- or Cmd-click adds the car to the selection or takes it out (`toggleDriver`; the focus stays, there is one focus at a time), a hover highlights the driver (`setHighlightedDriver`). It subscribes to `focusDriver` (the car whose pit window, rejoin probabilities and "pit in k laps" it draws), `highlightedDriver` (a ring on the car and the time gap from the reference car to it) and `selectedDrivers` (a blue ring, the selection colour of every view; with a selection and no focus, the other cars' labels turn grey and the selected cars' labels carry their gap to the selected car first in race order, the reference).
- Reverse direction: a focus or a highlight set in the Leaderboard, the Timing Tower, the Timing Sheet, the Race Pace Grid, the Track Map, the Race Situation map or the PCA panel moves the circle's focus or ring; a car clicked on the circle is the focus of every view that follows `focusDriver` (Track Map, Leaderboard, Timing Tower, Position Tracker, PCA panel, ...).
- Its keys `[` and `]` and the "Rivals stop" toggle change only the circle's own projection (component state, not the store).

### 7. Tyre views (`selectedStint`, `highlightedCompound`)

- A stint click on the Strategy Timeline writes `selectedStint`, drawn by the Tyre Silhouette; hovering a compound on the Tyre Silhouette writes `highlightedCompound`, which the Strategy Timeline highlights.

### 8. Not linked

Earlier versions of this document claimed links the code does not have; the generated tables confirm each of these:

- The Track Map subscribes to no lap range: out-of-range laps are not dimmed there.
- The PCA biplot does not subscribe to `selectedLapRange`: a pit-window click in the Cross-Race Analysis panel does not change the biplot.
- Strategy Analysis (`StrategyAnalysis.jsx`) writes no lap range.
- The Circle of Doom subscribes to no lap range and writes none.
- `trackProgress` (a playhead on the Track Map along the focus driver's lap) has a subscriber, the Track Map, but no writer: nothing sets it.
- `watchedRivals` is only reset (by `setFocusDriver` and `clearSelection`); no view subscribes to it.

## Analytics triggered by visual interaction

Each entry is a computation that runs because of an interaction on a view, on the data at the replay clock. A click that only selects, focuses or highlights a driver is a coordination link (sections 1 to 7), not an analytic, and is not listed.

1. **Lasso or click on the PCA biplot** -> `fetchPCAAnalysis` -> backend `POST /api/pca/analyze-selection` (the former `/api/tsne/analyze-selection` path is kept as an alias), with the replay clock -> per-feature Hedges' g with its interval and a random-selection baseline, pit windows and stint patterns -> drawn in the Cross-Race Analysis panel; the selection's strategies are drawn on the Strategy Timeline (`docs/PCA_METHODOLOGY.md`, section 5).
2. **Lasso or click on the Race Situation map** -> Strategy Analysis compares the selected drivers with the rest of the field on their race-state features (Cohen's d per feature, computed in the browser).
3. **Lap range brushed** (Position Tracker or the Timing Sheet's bar) **or selected** (stint, pit window, race event) -> Tyre Degradation refits that range in the browser and, for a range of 5 laps or more, calls `fetchDegradationRegression` -> backend `POST /api/predict/degradation` for the focus driver (else the first selected one), on the laps completed at the replay clock -> the fit of that range in the Tyre Degradation banner (`docs/DEGRADATION_METHODOLOGY.md`, "Consumers").
4. **Double-click a driver** (Leaderboard, Timing Sheet, Race Pace Grid; or `Shift+P`) -> focus + `triggerPrediction` -> backend `POST /api/predict/lstm` -> the forecast of the next laps by the method served (named on its chip) in Race Prediction and in the Timing Sheet's forecast rows.
5. **Click a car on the Circle of Doom** -> for that car, in the browser (`frontend/src/utils/circleOfDoom.js`): the pit window if it pitted now (rejoin point, projected place, the cars it would lose places to or gain over), the probability of each rejoin place (1000 draws of this race's pit loss) and the traffic flag at the rejoin (less than 1.0 s behind a car). **`[` / `]` or the stepper** -> "pit in k laps": the same projection after k more laps on the current set, with the race simulation's lap model (`frontend/src/utils/undercut.js` `pitInLaps`); **"Rivals stop"** -> the same with the other cars changing sets on their likely laps. Recomputed on a focus change and on each lap, pit or track-status event (`circleMemoKey`), not every frame.
6. **A plan edited in the Strategy Simulator** (its stint editor, then Run) -> two Monte Carlo runs from the same seed, the plan against the model's own stops (`compareStrategies`, in a Web Worker) -> the result cards, the finishing distributions and the verdict.

The Monte Carlo projection of Race Prediction and the Race Situation map's live PCA are recomputed by the replay clock (every lap), not by an interaction.

## Generated tables

<!-- coordination-matrix:start (generated by frontend/scripts/coordination_matrix.mjs; do not edit by hand) -->

### Coordination fields: who writes, who subscribes

| Field | Holds | Written by | Subscribed by |
|-------|-------|------------|---------------|
| `selectedDrivers` | the drivers selected (multi-select) | ChampionshipChart, ChampionshipStandings, CircleOfDoom, LapTimeChart, Leaderboard, PCAAnalysisPanel, PCABiplot, RacePaceGrid, RaceSituationMap, StrategyAnalysis, StrategyTimeline, TelemetryStrip, TimingTower, TrackMap, commandRegistry | ChampionshipChart, ChampionshipStandings, CircleOfDoom, CommandBar, CommandPalette, ConsistencyPanel, DriverComparePanel, LapDeltaChart, LapTimeChart, Leaderboard, PCAAnalysisPanel, PCABiplot, PositionByLap, RaceControlPanel, RacePaceGrid, RacePredictionPanel, RaceSituationMap, RadioPipToast, SectorsPanel, ShortcutHints, StrategyAnalysis, StrategySimulator, StrategyTimeline, TelemetryStrip, TimelinePlayer, TimingTower, TireDegradation, TireSilhouette, TrackMap, TyreHealth, TyreManagement |
| `highlightedDriver` | the driver under the pointer (hover) | ChampionshipChart, ChampionshipStandings, CircleOfDoom, ConsistencyPanel, DriverMFDCard, LapTimeChart, Leaderboard, RacePaceGrid, RaceSituationMap, SectorsPanel, StrategyTimeline, TelemetryStrip, TimelinePlayer, TimingTower, TrackMap, commandRegistry | ChampionshipChart, ChampionshipStandings, CircleOfDoom, ConsistencyPanel, DriverMFDCard, LapDeltaChart, LapTimeChart, Leaderboard, RacePaceGrid, RaceSituationMap, SectorsPanel, StrategyTimeline, TelemetryStrip, TimingTower, TrackMap |
| `focusDriver` | the focus driver (one at a time) | CircleOfDoom, ConsistencyPanel, LapTimeChart, Leaderboard, PCAAnalysisPanel, PositionByLap, RacePaceGrid, RaceSituationMap, SectorsPanel, SessionSelectorScreen, StrategyAnalysis, TelemetryStrip, TimingTower, commandRegistry, useKeyboardShortcuts | CircleOfDoom, CommandBar, CommandPalette, ConsistencyPanel, FocusDriverWidget, LapDeltaChart, LapTimeChart, Leaderboard, PCAAnalysisPanel, PitWallLayout, PitWallSectorPanel, PositionByLap, RaceControlPanel, RacePredictionPanel, RaceSituationMap, RadioPipToast, SectorDeltaWaterfall, ShortcutHints, SidebarFocusCards, StrategyAnalysis, StrategySimulator, StrategyTimeline, TelemetryStrip, TimingTower, TireDegradation, TireSilhouette, TrackMap, TyreHealth, TyreManagement, UndercutCalculator |
| `watchedRivals` | the focus driver's watched rivals | CircleOfDoom, ConsistencyPanel, LapTimeChart, Leaderboard, PCAAnalysisPanel, PositionByLap, RacePaceGrid, RaceSituationMap, SectorsPanel, SessionSelectorScreen, StrategyAnalysis, TelemetryStrip, TimingTower, commandRegistry, useKeyboardShortcuts | — |
| `lapDeltaBaseDriver` | the baseline driver of the Lap Delta chart | CircleOfDoom, ConsistencyPanel, LapTimeChart, Leaderboard, PCAAnalysisPanel, PositionByLap, RacePaceGrid, RaceSituationMap, SectorsPanel, SessionSelectorScreen, StrategyAnalysis, TelemetryStrip, TimingTower, commandRegistry, useKeyboardShortcuts | LapDeltaChart, LapTimesTabContent |
| `compareDrivers` | the two drivers of the Driver Comparison | DriverComparePanel, Leaderboard, commandRegistry, useKeyboardShortcuts | DriverComparePanel |
| `comparisonDriver` | the rival of the Sector Delta Waterfall and the Undercut Calculator | SectorDeltaWaterfall, StrategyAnalysis, UndercutCalculator | SectorDeltaWaterfall, UndercutCalculator |
| `selectedLapRange` | the one lap range (a brush, the sheet bar, a stint, a pit window, a race event), equal to brushLapRange | LapTimeChart, PCAAnalysisPanel, PositionByLap, StrategyTimeline, TimelinePlayer, commandRegistry | LapTimeChart, StrategyTimeline, TelemetryStrip, TireDegradation |
| `brushLapRange` | the same lap range, under the name the Position Tracker, the Timing Sheet and Tyre Degradation read | LapTimeChart, PCAAnalysisPanel, PositionByLap, StrategyTimeline, TimelinePlayer, commandRegistry | LapTimeChart, PositionByLap, TireDegradation |
| `selectedPCAPoints` | the (driver, race) rows lassoed or clicked on the PCA biplot | PCAAnalysisPanel, PCABiplot, commandRegistry | PCAAnalysisPanel, PCABiplot |
| `pcaStrategyAnalysis` | the backend analysis of that PCA selection (fetchPCAAnalysis) | PCAAnalysisPanel, PCABiplot | PCAAnalysisPanel, StrategyAnalysis, StrategyTimeline |
| `selectedStint` | the stint clicked on a tyre view | StrategyTimeline, commandRegistry | TireSilhouette |
| `highlightedCompound` | the compound highlighted on a tyre view | TireSilhouette, commandRegistry | StrategyTimeline, TireSilhouette |
| `trackProgress` | the playhead along the lap (0-1) of the speed trace | — | TrackMap |

### Analysis views: emitter (row) -> receiver (column)

A cell lists the fields the row view writes and the column view subscribes to.

| Emitter \ Receiver | Leaderboard | TrackMap | LapTimeChart | PositionByLap | StrategyTimeline | TireDegradation | PCABiplot | PCAAnalysisPanel | StrategyAnalysis | RaceSituationMap | CircleOfDoom | RacePaceGrid | LapDeltaChart | TelemetryStrip | TimelinePlayer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Leaderboard** | · | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `selectedDrivers` |
| **TrackMap** | `highlightedDriver` `selectedDrivers` | · | `highlightedDriver` `selectedDrivers` | `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `selectedDrivers` |
| **LapTimeChart** | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | · | `brushLapRange` `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` `selectedLapRange` | `brushLapRange` `focusDriver` `selectedDrivers` `selectedLapRange` | `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` `selectedLapRange` | `selectedDrivers` |
| **PositionByLap** | `focusDriver` | `focusDriver` | `brushLapRange` `focusDriver` `selectedLapRange` | · | `focusDriver` `selectedLapRange` | `brushLapRange` `focusDriver` `selectedLapRange` | — | `focusDriver` | `focusDriver` | `focusDriver` | `focusDriver` | — | `focusDriver` `lapDeltaBaseDriver` | `focusDriver` `selectedLapRange` | — |
| **StrategyTimeline** | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `brushLapRange` `highlightedDriver` `selectedDrivers` `selectedLapRange` | `brushLapRange` `selectedDrivers` | · | `brushLapRange` `selectedDrivers` `selectedLapRange` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` `selectedLapRange` | `selectedDrivers` |
| **TireDegradation** | — | — | — | — | — | · | — | — | — | — | — | — | — | — | — |
| **PCABiplot** | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `pcaStrategyAnalysis` `selectedDrivers` | `selectedDrivers` | · | `pcaStrategyAnalysis` `selectedDrivers` `selectedPCAPoints` | `pcaStrategyAnalysis` `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` | `selectedDrivers` |
| **PCAAnalysisPanel** | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `brushLapRange` `focusDriver` `selectedDrivers` `selectedLapRange` | `brushLapRange` `focusDriver` `selectedDrivers` | `focusDriver` `pcaStrategyAnalysis` `selectedDrivers` `selectedLapRange` | `brushLapRange` `focusDriver` `selectedDrivers` `selectedLapRange` | `selectedDrivers` `selectedPCAPoints` | · | `focusDriver` `pcaStrategyAnalysis` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` `selectedLapRange` | `selectedDrivers` |
| **StrategyAnalysis** | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `selectedDrivers` | · | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` |
| **RaceSituationMap** | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | · | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `selectedDrivers` |
| **CircleOfDoom** | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | · | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `selectedDrivers` |
| **RacePaceGrid** | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | · | `focusDriver` `highlightedDriver` `lapDeltaBaseDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `selectedDrivers` |
| **LapDeltaChart** | — | — | — | — | — | — | — | — | — | — | — | — | · | — | — |
| **TelemetryStrip** | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `lapDeltaBaseDriver` `selectedDrivers` | · | `selectedDrivers` |
| **TimelinePlayer** | `highlightedDriver` | `highlightedDriver` | `brushLapRange` `highlightedDriver` `selectedLapRange` | `brushLapRange` | `highlightedDriver` `selectedLapRange` | `brushLapRange` `selectedLapRange` | — | — | — | `highlightedDriver` | `highlightedDriver` | `highlightedDriver` | `highlightedDriver` | `highlightedDriver` `selectedLapRange` | · |

### Analysis views linked both ways

| View A | View B | A -> B | B -> A |
|--------|--------|--------|--------|
| Leaderboard | TrackMap | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` |
| Leaderboard | LapTimeChart | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| Leaderboard | PositionByLap | `focusDriver` `selectedDrivers` | `focusDriver` |
| Leaderboard | StrategyTimeline | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` |
| Leaderboard | PCABiplot | `selectedDrivers` | `selectedDrivers` |
| Leaderboard | PCAAnalysisPanel | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| Leaderboard | StrategyAnalysis | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| Leaderboard | RaceSituationMap | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| Leaderboard | CircleOfDoom | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| Leaderboard | RacePaceGrid | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| Leaderboard | TelemetryStrip | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| Leaderboard | TimelinePlayer | `selectedDrivers` | `highlightedDriver` |
| TrackMap | LapTimeChart | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| TrackMap | PositionByLap | `selectedDrivers` | `focusDriver` |
| TrackMap | StrategyTimeline | `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` |
| TrackMap | PCABiplot | `selectedDrivers` | `selectedDrivers` |
| TrackMap | PCAAnalysisPanel | `selectedDrivers` | `focusDriver` `selectedDrivers` |
| TrackMap | StrategyAnalysis | `selectedDrivers` | `focusDriver` `selectedDrivers` |
| TrackMap | RaceSituationMap | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| TrackMap | CircleOfDoom | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| TrackMap | RacePaceGrid | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| TrackMap | TelemetryStrip | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| TrackMap | TimelinePlayer | `selectedDrivers` | `highlightedDriver` |
| LapTimeChart | PositionByLap | `brushLapRange` `focusDriver` `selectedDrivers` | `brushLapRange` `focusDriver` `selectedLapRange` |
| LapTimeChart | StrategyTimeline | `focusDriver` `highlightedDriver` `selectedDrivers` `selectedLapRange` | `brushLapRange` `highlightedDriver` `selectedDrivers` `selectedLapRange` |
| LapTimeChart | PCABiplot | `selectedDrivers` | `selectedDrivers` |
| LapTimeChart | PCAAnalysisPanel | `focusDriver` `selectedDrivers` | `brushLapRange` `focusDriver` `selectedDrivers` `selectedLapRange` |
| LapTimeChart | StrategyAnalysis | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| LapTimeChart | RaceSituationMap | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| LapTimeChart | CircleOfDoom | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| LapTimeChart | RacePaceGrid | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| LapTimeChart | TelemetryStrip | `focusDriver` `highlightedDriver` `selectedDrivers` `selectedLapRange` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| LapTimeChart | TimelinePlayer | `selectedDrivers` | `brushLapRange` `highlightedDriver` `selectedLapRange` |
| PositionByLap | StrategyTimeline | `focusDriver` `selectedLapRange` | `brushLapRange` `selectedDrivers` |
| PositionByLap | PCAAnalysisPanel | `focusDriver` | `brushLapRange` `focusDriver` `selectedDrivers` |
| PositionByLap | StrategyAnalysis | `focusDriver` | `focusDriver` `selectedDrivers` |
| PositionByLap | RaceSituationMap | `focusDriver` | `focusDriver` `selectedDrivers` |
| PositionByLap | CircleOfDoom | `focusDriver` | `focusDriver` `selectedDrivers` |
| PositionByLap | TelemetryStrip | `focusDriver` `selectedLapRange` | `focusDriver` `selectedDrivers` |
| StrategyTimeline | PCABiplot | `selectedDrivers` | `pcaStrategyAnalysis` `selectedDrivers` |
| StrategyTimeline | PCAAnalysisPanel | `selectedDrivers` | `focusDriver` `pcaStrategyAnalysis` `selectedDrivers` `selectedLapRange` |
| StrategyTimeline | StrategyAnalysis | `selectedDrivers` | `focusDriver` `selectedDrivers` |
| StrategyTimeline | RaceSituationMap | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| StrategyTimeline | CircleOfDoom | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| StrategyTimeline | RacePaceGrid | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| StrategyTimeline | TelemetryStrip | `highlightedDriver` `selectedDrivers` `selectedLapRange` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| StrategyTimeline | TimelinePlayer | `selectedDrivers` | `highlightedDriver` `selectedLapRange` |
| PCABiplot | PCAAnalysisPanel | `pcaStrategyAnalysis` `selectedDrivers` `selectedPCAPoints` | `selectedDrivers` `selectedPCAPoints` |
| PCABiplot | StrategyAnalysis | `pcaStrategyAnalysis` `selectedDrivers` | `selectedDrivers` |
| PCABiplot | RaceSituationMap | `selectedDrivers` | `selectedDrivers` |
| PCABiplot | CircleOfDoom | `selectedDrivers` | `selectedDrivers` |
| PCABiplot | RacePaceGrid | `selectedDrivers` | `selectedDrivers` |
| PCABiplot | TelemetryStrip | `selectedDrivers` | `selectedDrivers` |
| PCAAnalysisPanel | StrategyAnalysis | `focusDriver` `pcaStrategyAnalysis` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| PCAAnalysisPanel | RaceSituationMap | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| PCAAnalysisPanel | CircleOfDoom | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| PCAAnalysisPanel | RacePaceGrid | `selectedDrivers` | `focusDriver` `selectedDrivers` |
| PCAAnalysisPanel | TelemetryStrip | `focusDriver` `selectedDrivers` `selectedLapRange` | `focusDriver` `selectedDrivers` |
| StrategyAnalysis | RaceSituationMap | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| StrategyAnalysis | CircleOfDoom | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| StrategyAnalysis | RacePaceGrid | `selectedDrivers` | `focusDriver` `selectedDrivers` |
| StrategyAnalysis | TelemetryStrip | `focusDriver` `selectedDrivers` | `focusDriver` `selectedDrivers` |
| RaceSituationMap | CircleOfDoom | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| RaceSituationMap | RacePaceGrid | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| RaceSituationMap | TelemetryStrip | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| RaceSituationMap | TimelinePlayer | `selectedDrivers` | `highlightedDriver` |
| CircleOfDoom | RacePaceGrid | `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| CircleOfDoom | TelemetryStrip | `focusDriver` `highlightedDriver` `selectedDrivers` | `focusDriver` `highlightedDriver` `selectedDrivers` |
| CircleOfDoom | TimelinePlayer | `selectedDrivers` | `highlightedDriver` |
| RacePaceGrid | TelemetryStrip | `focusDriver` `highlightedDriver` `selectedDrivers` | `highlightedDriver` `selectedDrivers` |
| RacePaceGrid | TimelinePlayer | `selectedDrivers` | `highlightedDriver` |
| TelemetryStrip | TimelinePlayer | `selectedDrivers` | `highlightedDriver` `selectedLapRange` |

<!-- coordination-matrix:end -->
