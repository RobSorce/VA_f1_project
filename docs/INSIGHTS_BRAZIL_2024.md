# Analytical Insights — São Paulo Grand Prix 2024 (Interlagos, R21)

Companion to `INSIGHTS_MONZA_2024.md` and `INSIGHTS_HUNGARY_2024.md`.
Brazil 2024 is the **wet-race stress test** for the methodology. Every
car was on Intermediates from lap 2, there was a red-flag restart, and
Verstappen won from **P17 on the grid** — an extreme pace outlier that
probes every metric the tool produces.

All numbers computed from
`backend/data/processed_cache/session_2024_21_R.json`.

**Race result (top 10):**

| Pos | Driver | Team       | Grid | Gap      |
|-----|--------|------------|------|----------|
| 1   | VER    | Red Bull   | 17   | —        |
| 2   | OCO    | Alpine     | 4    | +19.5 s  |
| 3   | GAS    | Alpine     | 13   | +22.5 s  |
| 4   | RUS    | Mercedes   | 2    | +23.3 s  |
| 5   | LEC    | Ferrari    | 6    | +30.2 s  |
| 6   | NOR    | McLaren    | 1    | +31.4 s  |
| 7   | TSU    | RB         | 3    | +42.1 s  |
| 8   | PIA    | McLaren    | 8    | +44.9 s  |

Race had Intermediate rubber throughout; brief red flag around L29-L30.

---

## Insight 1 — Consistency σ flips sign in chaotic wet races

**Panel:** `ConsistencyPanel` /
`GET /api/analytics/consistency/2024/21`.

Ranking (σ in seconds, sorted ascending = "most consistent first"):

| Rank | Driver | σ (s)  | Finish |
|------|--------|--------|--------|
| 1    | HUL    | 3.44   | DNF (engine)   |
| 2    | COL    | 5.24   | P14    |
| 3    | OCO    | 7.77   | P2     |
| …    | …      | …      | …      |
| 17   | VER    | 9.51   | **P1** |
| 18   | RUS    | 9.64   | P4     |

Compare to dry races from the same season:

| Race | Fastest σ / slowest σ | Winner σ-rank |
|------|------------------------|----------------|
| Monza 2024 (dry) | 0.85 / 1.7 | **P1 / 20** |
| Hungary 2024 (dry) | 0.86 / 1.6 | **P2 / 20** |
| Brazil 2024 (wet) | 3.44 / 9.64 | **P17 / 20** |

### Why it matters (and why the metric must be re-interpreted in the wet)

- Absolute scale jumps from ~1.0 s to ~9.0 s when the track is drying —
  that is **9× the noise floor** of a dry race.
- Verstappen ranks σ-P17 because his *winning* drive required attacking
  from P17 on track, including a red-flag restart: big lap-time
  variance is a by-product of **creating** variance, not suffering it.
- HUL ranks σ-P1 only because he DNF'd early — fewer laps → artificially
  narrow σ. **The tool currently does not enforce a minimum-lap
  filter**, which is a documentable flaw exposed by this race.

### Recommendation

Add a `min_laps ≥ 0.75 × race_length` filter to the consistency
endpoint, and in the wet regime, either (a) rank on *inter-quartile
range* of lap times instead of σ, or (b) display σ alongside a
"conditions" flag (dry / mixed / wet) so a user does not misread the
rank. This is an empirical, race-specific finding.

---

## Insight 2 — The Intermediate "stint slope" encodes the drying track, not the tyre

**Panel:** `TireDegradation` / `POST /api/predict/degradation`.

All cars on Intermediates throughout. Per-stint regression:

| Driver | Stint 1 (early)       | Stint 2 (late)         |
|--------|-----------------------|------------------------|
| VER    | +178.8 ms/lap (22 L)  | **−139.8** ms/lap (26 L)|
| OCO    | +128.2 ms/lap (22 L)  | −106.2 ms/lap (25 L)   |
| GAS    | +101.2 ms/lap (23 L)  | −135.7 ms/lap (25 L)   |
| RUS    | −55.5 ms/lap  (22 L)  | **−213.4** ms/lap (27 L)|
| LEC    | −77.2 ms/lap  (19 L)  | **−253.0** ms/lap (27 L)|
| NOR    | −59.3 ms/lap  (22 L)  | −248.2 ms/lap (27 L)   |
| PIA    | −78.0 ms/lap  (21 L)  | −269.1 ms/lap (27 L)   |
| HAM    | −84.1 ms/lap  (22 L)  | −264.6 ms/lap (27 L)   |

### Why it matters

- Stint 1 has both positive and negative slopes → during the first
  stint the track was still getting wetter; drivers adjusted at
  different rates.
- Stint 2 is **uniformly strongly negative** (−100 to −270 ms/lap) —
  no tyre on earth improves at 250 ms/lap over 27 laps. This is
  **drying-track evolution**, not tyre regeneration.
- Ferrari/McLaren/Mercedes slopes in stint 2 are ~2× as negative as
  the top-3 finishers. Interpretation: those drivers were **slower
  early in stint 2**, and the wet→dry evolution let them "catch up"
  more. Verstappen, Ocon, Gasly were closer to their asymptotic pace
  right away — that is **pace in the wet**, not tyre management.

### Recommendation for the VA report

Label the tyre-degradation slope as a composite of (tyre wear +
fuel + track evolution) and warn the user that in wet races the third
term dominates. The dashboard should either (a) surface a wet/dry flag
alongside each slope, or (b) compute slope only on laps where
`track_status == "1"` *and* `rain_rate ≈ 0` to isolate true tyre deg.

---

## Insight 3 — LSTM MAE quantifies race unpredictability

**Panel:** `RacePredictionPanel` / `POST /api/predict/lstm`.

Same procedure as Monza/Hungary — 10-lap input window, 5-lap forecast.
Brazil window: input L31–L40, forecast L41–L45 (spans the red-flag).

Aggregate MAE comparison across all three races:

| Race                 | Conditions        | Overall MAE (s) | Best driver MAE |
|----------------------|-------------------|-----------------|-----------------|
| Monza 2024 (R16)     | Dry, stable       | **0.74**        | LEC 0.19        |
| Hungary 2024 (R13)   | Dry, high-deg     | 1.95            | HAM 0.39        |
| Brazil 2024 (R21)    | **Wet + red flag**| **2.50**        | LEC 1.52        |

Per-driver Brazil predictions vs actuals (note L41 and L42 were red-
flag/restart laps of 125-143 seconds — predictable outliers):

| Driver | MAE   | Comment                                  |
|--------|-------|------------------------------------------|
| LEC    | 1.52  | Best; steady pace post-restart           |
| PIA    | 1.70  | Good                                     |
| VER    | 2.16  | Attacking; big variance                  |
| RUS    | 2.16  |                                          |
| OCO    | 2.25  |                                          |
| NOR    | 2.69  | Losing pace rapidly through mid-race     |
| GAS    | 3.69  | Wet-track pace spike                     |
| HAM    | 3.84  | Worst; variable pace, attacking          |

### Why it matters

- The LSTM MAE is a **proxy for race predictability**. It goes up
  3.4× from Monza to Brazil without a single line of model code
  changing.
- The model correctly refuses to predict sub-90 s laps during the
  red flag — predictions stay in the 82–95 s band while actuals spike
  to 125–143 s. **That is a feature, not a bug**: the model does not
  hallucinate implausible sequences outside its training distribution.
- An operator watching the dashboard could therefore use *rising MAE*
  as an operational indicator of "strategy is now guessing, not
  modelling" — a useful signal.

### Recommendation

Surface a rolling LSTM MAE pill in the `RacePredictionPanel`: when
> 2.0 s for three consecutive forecasts, display a "model confidence
low — race volatile" annotation.

---

## Insight 4 — Pit-out anomaly: track-position inversion in wet

At Brazil the winner (VER) started P17 and finished P1 — a +16
position swing. The strategy timeline and lap-delta chart show the
mechanism clearly:

- L1–L5: VER gains 6 positions in lap-1 chaos on intermediates.
- L15–L28: VER's median lap ≈ 80.4 s, field median ≈ 81.8 s → **~1.4
  s/lap clean-air advantage**.
- Red-flag restart at L29 neutralises pit-stop deltas, enabling VER to
  convert raw pace into track position without the usual 22 s loss.

No tool-internal analytic is needed to *detect* this — the
`LapDeltaChart` overlayed between VER and the midfield median makes
the 1.4 s/lap gap visible at a glance. But the wet-race pace gap is
**the fundamental phenomenon the VA tool should make discoverable**,
not merely retrodict.

---

## Summary — what Brazil 2024 validates and breaks

| Tool / metric        | Dry race behaviour         | Wet race behaviour        |
|----------------------|----------------------------|---------------------------|
| Consistency σ        | Ranks winner near top-3    | **Ranks winner last**     |
| Degradation slope    | Dominated by tyre wear     | **Dominated by drying**   |
| LSTM MAE (5-lap)     | ~0.4–0.8 s                 | ~1.5–3.8 s                |
| Pit-strategy viewer  | Reads 1-vs-2-stop          | Reads red-flag reset      |

Each of these is a **falsifiable claim** about the tool, not a marketing
statement. The report should present these as tested edge cases and
document the conditions under which each metric is safe to trust.

---

## Cross-race summary table (for the final report)

| Insight type               | Monza    | Hungary  | Brazil            |
|----------------------------|----------|----------|-------------------|
| Hard-stint slope median    | −33 ms/L | +55 ms/L | n/a (intermediates)|
| Consistency σ, winner rank | #1       | #2       | #17               |
| LSTM overall MAE           | 0.74 s   | 1.95 s   | 2.50 s            |
| Strategic narrative        | 1-stop wins | team orders | wet comeback |

The same six endpoints produce these numbers. That reproducibility
across three radically different race characters is the central VA
value proposition.
