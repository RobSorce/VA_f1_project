# Tyre Degradation Methodology

## Canonical Definition

**Tyre degradation rate** is the slope of the linear regression of lap time vs tyre life (laps on the current set), computed per stint.

```
lapTime = intercept + slope * tyreLife
```

A positive slope means lap times increase with tyre age (degradation). The slope is expressed in **seconds per lap** (s/lap).

## Outlier Filtering

Before computing the regression, outlier laps are excluded:

1. **Threshold filter**: laps where `lapTime > 1.3 * median_stint_time` are excluded. This removes safety car laps, red flag laps, and abnormally slow laps.
2. **Pit in/out laps**: laps with `PitInTime` or `PitOutTime` set are excluded (pit entry/exit slow the lap artificially).
3. **Invalid laps**: laps with `lapTime <= 0` or `lapTime >= 300s` are excluded.

## Three Implementations

### 1. TireDegradation.jsx (user-facing chart)

**File:** `frontend/src/components/visualizations/TireDegradation.jsx`

Shows a scatter plot of lap time vs tyre life per stint, with a dashed linear regression fit line and a slope annotation (e.g., "+0.037 s/lap"). Points are colored by tyre compound (Soft=#FF3333, Medium=#FFC300, Hard=#EEEEEE). Outlier laps are shown as small hollow circles.

- **Unit**: seconds per lap (s/lap)
- **Outlier filter**: 1.3x median + pit in/out
- **Regression**: client-side least squares (`linearRegression()` in the component)

### 2. ConsistencyPanel.jsx (driver consistency metrics)

**File:** `frontend/src/components/visualizations/ConsistencyPanel.jsx`, lines 103-117

Computes the same regression slope per compound, then normalizes to a percentage of the average lap time:

```
degRate = (slope / avgLapTime) * 100  [% per lap]
```

- **Unit**: % per lap
- **Outlier filter**: same threshold (applied upstream in valid lap filtering)
- **Purpose**: enables cross-circuit comparison (a +0.04 s/lap slope means different things on a 70s circuit vs a 110s circuit)

### 3. raceSimulation.js (Monte Carlo parameters)

**File:** `frontend/src/utils/raceSimulation.js`, lines 124-152

Computes the linear regression slope of lapTime vs tyreLife per driver per stint, then aggregates per compound across all drivers to get a distribution (mean + stdDev). During Monte Carlo simulation, each simulated lap samples a degradation rate from this distribution.

- **Unit**: seconds per lap (s/lap)
- **Outlier filter**: uses a separate "clean lap" filter that excludes pit laps, SC laps, and lap 1
- **Additional guard**: slopes outside [-0.5, 1.0] are discarded; negative slopes are clamped to 0

## Numerical Agreement

For a given driver and stint, the TireDegradation chart and ConsistencyPanel should agree:

```
TireDegradation slope (s/lap) = ConsistencyPanel deg_rate (%) * avgLapTime / 100
```

Small differences (< 5%) may arise because:
- The outlier filter cutoffs differ slightly (TireDegradation uses per-stint median; ConsistencyPanel filters upstream).
- ConsistencyPanel groups all laps of the same compound across multiple stints; TireDegradation separates by stint.

The Monte Carlo simulation's per-compound mean slope should be close to the TireDegradation per-stint slopes for that compound, averaged across drivers.

## Stint Detection

Stints are detected by monitoring:
1. Change in tyre compound (always indicates a new stint).
2. TyreLife reset to <= 1 combined with a PitOutTime flag (same compound, new set).

A minimum of 2 clean laps per stint is required for a regression to be computed.
