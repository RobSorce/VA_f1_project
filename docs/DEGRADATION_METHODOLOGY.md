# Tyre Degradation Methodology

One definition of the laps a degradation fit may use, the fuel correction, the
per-stint fit, compound degradation and the consistency sigma, implemented
twice with the same names and the same results:

- `frontend/src/utils/degradation.js` (camelCase)
- `backend/data/processors/degradation.py` (snake_case)

`frontend/src/utils/__tests__/degradation.parity.test.js` runs both on every
cached race (whole race, two clocks inside the race, and the lap range 10–25)
and requires every lap list to match and every number to agree to 1e-9.

Every number below comes from `frontend/scripts/degradation_definition.mjs`
(output: `notes/experiments/degradation_definition_monza.txt`, 30 cached races).
Run it from `frontend/` with `npx vite-node scripts/degradation_definition.mjs`.

## Clean stint laps — `cleanStintLaps(lapTimes, { sessionNow, driver })`

1. **Stints** are those of `stints.js` `deriveStints` (`stints.py`
   `build_tyre_strategy`) over the laps completed at `sessionNow`: one per tyre
   set, so a same-compound stop opens a new stint. Only stints with at least one
   completed lap are returned.
2. **A lap of the stint is usable** when it is completed at `sessionNow` and
   - `LapNumber > 1` (standing start),
   - not an in-lap (pit entry) and not an out-lap (pit exit),
   - green: `TrackStatus` is exactly `'1'` (no yellow, SC, VSC or red at any
     point of the lap),
   - `0 < LapTimeSeconds < 200` (`MAX_LAP_TIME_S`),
   - `TyreLife` is a number.
3. **Slow outliers.** When the laps of step 2 have a fit (see below), the
   residuals `e` of that fit are taken, robust sigma
   `s = max(1.4826 × median|e − median(e)|, 0.001 s)`, and a lap with
   `e − median(e) > 3.5 × s` is removed. One pass, slow side only. Removed
   laps are returned as `outliers`.

Monza 2024 (1008 lap rows): lap 1 removes 20, in-laps 31, out-laps 30; 927
laps pass step 2; step 3 removes 29 (3.13 %); 898 clean laps remain.

## Fuel correction

```
fuelCorrected = LapTimeSeconds + FUEL_EFFECT_S_PER_LAP × (LapNumber − 1)
FUEL_EFFECT_S_PER_LAP = 0.03 s/lap
```

**This constant is an assumption, not a measurement.** 0.030 s/lap is the value
the dashboard already used. It cannot be fitted from the race data: in all
1442 cached stints with usable laps, `LapNumber − TyreLife` is constant over
the stint's laps, so fuel burn and tyre age grow together and only their sum is
observed. Consequence: on every fitted stint `slope = rawSlope + 0.03`
(max deviation 1.58e-15 s/lap over 1222 fits). Track evolution is folded into
the same sum and is not separated either.

## Per-stint fit — `fitStint(laps)`

Ordinary least squares of the fuel-corrected time on `TyreLife`:

| field | meaning |
|---|---|
| `slope` | fuel-corrected s per lap of tyre life (the degradation) |
| `rawSlope` | the same fit on `LapTimeSeconds` (fuel burn included) |
| `intercept` | fuel-corrected s at `TyreLife` 0 |
| `n` | laps used |
| `residualSigma` | `sqrt(SSE / (n − 2))`, s |
| `slopeStdErr` | `residualSigma / sqrt(Σ(TyreLife − mean)²)`, s/lap |
| `tyreLifeMin`, `tyreLifeMax` | `TyreLife` range of the laps |

Negative slopes are returned as they are, never clamped. The fit is `null`
with fewer than `MIN_FIT_LAPS = 8` laps or a single `TyreLife` value.

**`MIN_FIT_LAPS = 8` is an assumption** read off the cached races (whole
stints, diagnostic fit at any n): below 8 laps 22 % or more of the fits are
steeper than ±0.3 s/lap and their median slope standard error is 0.079 s/lap
or more; at 8 laps 13.16 % and 0.066 s/lap; at 10–11 laps 8.54 % and 0.039.
A higher minimum would leave a stint without a fit for longer in replay.

`stintFits(lapTimes, { sessionNow, driver, lapStart, lapEnd })` returns one
row per stint, `{ driver, stintNumber, compound, startLap, endLap, ...fit }`,
fitted on the stint's clean laps inside `[lapStart, lapEnd]`. Stints with no
lap in the range are left out; a stint with too few laps keeps its row with
the fit fields `null` and `n` = its clean laps in the range. The outlier step
is decided on the whole stint (at `sessionNow`), before the range is applied.

## Why the slow-outlier rule (`OUTLIER_K = 3.5`, an assumption)

Over the 27262 step-2 laps of the stints with a fit, the slow tail of the
residuals is far heavier than the fast tail and than a normal tail: beyond
3.5 robust sigmas 3.08 % of the laps are slow, 0.32 % fast, where a normal
distribution puts 0.047 % on both sides together. The floor of 0.001 s
(timing resolution) never binds: the smallest robust sigma of a fitted stint
is 0.0354 s.

Effect: 839 of 28230 step-2 laps removed (2.97 %). Across the 1222 stints
fitted with and without the step, the slope moves by a median of 0.0000 s/lap
(90th percentile 0.0285). The large changes are laps that are not tyre wear,
e.g. 2024 R4 GAS stint 2: a green lap 3 of 138.362 s against a stint median of
101.117 s; removing it turns the slope from −1.0446 into +0.2316 s/lap.
Sensitivity at Monza 2024: the MEDIUM median slope is +0.0096 s/lap with the
step and −0.0017 without (HARD +0.0182 / +0.0208).

## Compound degradation — `compoundDegradation(fits)`

Per compound, over the fits with a slope: `mean`, `median`, `stdDev` (sample,
0 with one fit), `n`, `negativeCount`. Negative fits are kept and counted.

Monza 2024 (s/lap):

| compound | n | mean | median | stdDev | negative |
|---|---|---|---|---|---|
| MEDIUM | 18 | +0.0065 | +0.0096 | 0.0602 | 9 |
| HARD | 29 | +0.0135 | +0.0182 | 0.0341 | 11 |

## In-race estimate of the Monte Carlo — `raceDegradation(fits)` (`raceSimulation.js`)

The lap model of the race simulation (and of the Undercut Calculator and the
Circle of Doom "pit in k laps") does not use the plain compound mean above.
Per compound, from the fits at the clock:

1. only fits with at least `minFitLaps` clean laps are used (SOFT 8, MEDIUM 13,
   HARD 15 on the cached races): the shortest fit whose slope on its first k
   laps strays from its whole-stint slope by less than the stints of one race
   differ from one another (`computePriors`, partial-stint check). Shorter fits
   are counted (`short`) and kept in `allFits`;
2. the race's wear rate is the normal-normal combination of the cached races'
   mean of race means (`raceMean`, precision 1 / `betweenSd`²) and the fits
   used, each weighted by 1 / (`withinSd`² + its `slopeStdErr`²). Negative
   fits enter as they are, never clamped.

Lap noise is the race's pooled residual sigma combined with the cached races'
prior of the same kind (dry / wet), worth `nu0` residual degrees of freedom.
All of it is printed, with the Monza 2024 table at every projection clock, by
`frontend/scripts/degradation_in_race.mjs`
(`notes/experiments/degradation_in_race.txt`): at the 48 clocks of laps 5-52
MEDIUM is +0.0140 s/lap or more and HARD +0.0053 or more (the plain mean of
every fit so far was down to −0.1119 and −0.1750), lap noise 0.304-0.439 s.

## Consistency sigma — `consistencySigma(lapTimes, driver, { sessionNow, lapStart, lapEnd })`

Pooled residual sigma of the driver's per-stint fits:
`sigma = sqrt(Σ SSE / Σ (n − 2))` over the fitted stints, so tyre wear, fuel
burn and stops do not count as inconsistency. Returns `{ sigma, n, stints,
outliers }` (`outliers` = slow laps left out by step 3; `sigma` null when no
stint is fitted). Monza 2024, 19 classified finishers: median 0.342 s,
min 0.298 s (LEC), max 0.568 s (STR).

## Causality

Every function takes `sessionNow` (session seconds, `raceTime.js`). Only laps
completed by then are used; a stint's `endLap` is its last completed lap. A
lap's outlier status can change while its stint grows, because the stint's
fit changes.

## Consumers

Views, the simulator and the backend endpoints take their degradation and
consistency numbers from this module. Code that still fits on its own
(`TireDegradation.jsx`, `raceSimulation.js`, the consistency views,
`backend/api/routers/predictions.py`, `backend/api/routers/analytics.py`)
does not follow this definition until it is switched over.

## Limits

- Fuel effect and track evolution are an assumed constant (see above).
- Changing conditions inside a stint (rain, drying track) are not modelled:
  wet races keep large slopes and sigmas (e.g. the 2024 R21 INTERMEDIATE
  stints in table D of the script output).
- A fit on 8 laps still has a median slope standard error of 0.066 s/lap;
  `slopeStdErr` is returned so a view can show it.
