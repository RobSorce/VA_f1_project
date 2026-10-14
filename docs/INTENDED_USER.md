# Intended User

## Persona: F1 Pit Wall Strategist

**Role**: Race strategist on an F1 team's pit wall, responsible for real-time decisions about pit stop timing, tyre compound selection, and race pace management.

**Background**: Engineering degree (typically mechanical or aerospace), 3-10 years of experience in motorsport data analysis. Fluent in F1 terminology (stint, compound, degradation, undercut, overcut, delta, DRS, safety car). Uses official F1 timing screens, team telemetry systems, and Pirelli tyre data daily.

**Working context**: During a race, the strategist monitors 20+ data streams simultaneously under time pressure. Decisions (pit now vs wait) must be made in under 30 seconds, often while radio communication is ongoing. Post-race, the strategist reviews data to evaluate strategy performance and prepare for the next event.

## Primary Use Cases

### 1. Real-time race monitoring and pit window identification
**Scenario**: During a Grand Prix, the strategist needs to determine the optimal lap to pit their driver.

**How the system supports this**:
- The Leaderboard and Track Map provide position overview (who is where, gaps).
- The Tyre Degradation chart shows the linear regression slope of lap time vs tyre life, indicating when performance drops off.
- Double-clicking a driver triggers LSTM prediction, showing forecast lap times for the next 5 laps.
- The Strategy Timeline shows all drivers' pit stop history, ghost pit stops (predicted), and undercut windows.
- Brushing a lap range on the LapTimeChart triggers a degradation regression to quantify the rate of pace loss.

### 2. Cross-race strategy pattern analysis
**Scenario**: Before a race weekend, the strategist reviews historical data to identify which strategy patterns (1-stop, 2-stop, early vs late pit) have been most successful at the upcoming circuit.

**How the system supports this**:
- The PCA Biplot projects historical driver-race observations into 2D, revealing strategy clusters.
- Lasso selection on the biplot triggers backend analysis (descriptive differences per feature: Hedges' g with an interval and a random-selection baseline; common pit windows, stint patterns).
- The loading vectors on the biplot show which features drive the clustering (e.g., pace-dominant vs tyre-management-dominant strategies).
- Cross-referencing with the Strategy Analysis panel shows what lap ranges and compound sequences characterize each cluster.

### 3. Driver comparison and competitive analysis
**Scenario**: The strategist needs to compare their driver's pace, consistency, and tyre management against a direct competitor to decide whether an undercut or overcut is viable.

**How the system supports this**:
- Select two drivers in the Leaderboard and press `C` to enter compare mode.
- The Driver Compare Panel shows head-to-head lap times, sector splits, tyre degradation slopes, and consistency metrics.
- The Lap Delta Chart shows cumulative time difference between the two drivers, with red/green shading for behind/ahead.
- The Race Pace Grid classifies each driver-lap as green (competitive), yellow (normal), or red (slow) relative to the field median.

## Why This User, Not a General Audience

The system is designed for expert users who:
- Understand F1-specific terminology without explanation (no glossary needed).
- Can interpret PCA loading vectors and linear regression slopes.
- Value data density over visual simplicity (the 1920x1080 no-scroll layout maximizes information per pixel).
- Need keyboard shortcuts for speed (30+ shortcuts for sub-second navigation during live races).
- Trust quantitative metrics (lap time to 3 decimal places, degradation slope in s/lap) over qualitative summaries.

A casual F1 fan would find the interface overwhelming. That is by design: the pit wall strategist's working environment (F1 timing screens, team radio, 6+ monitors) is inherently information-dense, and our dashboard matches that cognitive load expectation.
