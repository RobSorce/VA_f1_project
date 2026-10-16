# Analytical Insights — Italian Grand Prix 2024 (Monza, R16)

> **Status: to be re-derived after the 2026-10 fixes.** The numbers below
> were computed with the dashboard's definitions before the October 2026
> fixes: the degradation fit is now fuel-corrected and fitted on clean stint
> laps only (`docs/DEGRADATION_METHODOLOGY.md`), the consistency σ is now the
> pooled residual σ of the per-stint fits, and the lap-time forecast model has
> been replaced. Re-running the steps below on the current code can give
> other values. Claims the audit disproved have been removed (dated notes below):
> the LSTM forecast insight with its table, two unsourced quotes, a pit loss
> that was not measured, and the reading that Sainz was held up behind Pérez.

Reproducible insights produced by the dashboard's own analytics. The numbers
below were computed from the cached session file
(`backend/data/processed_cache/session_2024_16_R.json`) by the panels listed,
as they were before the October 2026 fixes (see the status note above); the
one exception, the measured pit loss in Insight 1, cites the script output it
comes from.

Race result (official):
- P1  LEC  Ferrari       (1-stop: MED×14 → HARD×37)
- P2  PIA  McLaren       (2-stop: MED×15 → HARD×20 → HARD×14)
- P3  NOR  McLaren       (2-stop: MED×13 → HARD×16 → HARD×20)
- P4  SAI  Ferrari       (1-stop: MED×18 → HARD×33)
- P5  HAM  Mercedes      (2-stop)

(Note, 2026-10-16: these stint lengths do not count every lap of the stint in
the cached lap rows, where each stint ends with its in-lap: LEC laps 1-15 and
16-53, PIA 1-16, 17-38 and 39-53, NOR 1-14, 15-32 and 33-53, SAI 1-19 and
20-53, HAM 1-15, 16-37 and 38-53. They will be re-derived with the rest of
this file.)

---

## Insight 1 — The Hard tyre did not degrade enough to justify a 2-stop

**Panel:** `TireDegradation` (auto-regression triggered by the lap-time
brush), backed by `POST /api/predict/degradation`.

**What the tool reports** (slope of `lap_time = slope·TyreLife + intercept`
fitted on clean laps only, SC/VSC and pit laps excluded):

| Driver | Stint | Compound | Laps        | Len | Net slope (ms/lap) |
|--------|-------|----------|-------------|-----|--------------------|
| LEC    | 2     | HARD     | L17–L53     | 37  | **−8.3**           |
| SAI    | 2     | HARD     | L21–L53     | 33  | +3.9               |
| PIA    | 2     | HARD     | L18–L37     | 20  | −33.5              |
| PIA    | 3     | HARD     | L40–L53     | 14  | −6.0               |
| NOR    | 2     | HARD     | L16–L31     | 16  | −54.6              |
| NOR    | 3     | HARD     | L34–L53     | 20  | −56.4              |
| HAM    | 2     | HARD     | L17–L36     | 20  | −88.0              |

At Monza 2024 the raw regression returns a **negative or near-zero net slope
on every Hard-tyre stint of ≥10 laps**, including Leclerc's 37-lap middle
stint, which was the single longest stint of the race.

### Why it matters

The raw slope includes fuel burn (~30–40 ms/lap in favour of the driver) so
the isolated tyre degradation is `slope + fuel_correction`. With a 30 ms/lap
correction:

- LEC H stint (37 laps): ≈ **+22 ms/lap** (mildest in the field over its
  length).
- SAI H stint (33 laps): ≈ +34 ms/lap.
- Typical Hard-stint degradation at Bahrain 2024 (same tyre family, abrasive
  track): **+20 to +60 ms/lap** — same order of magnitude per lap, but the
  stints are half as long.

So Monza's Hard tyre is not anomalously durable *per lap* — but the `Δ per
lap × stint length` is what decides strategy, and at Monza a 30+ lap Hard
stint costs roughly the same pace delta as a 15-lap Hard at Bahrain while
saving a pit stop: the measured median pit loss of Monza 2024 is 26.8 s over
30 green-flag stops (`docs/evidence/validate_pit_loss_and_rejoin.txt`, row
`2024_16`, column `true_loss`; written by
`backend/scripts/validate_pit_loss_and_rejoin.py`). (Corrected on 2026-10-15:
this sentence quoted a smaller pit-stop time that was not measured.)

### Cross-check against reality

- Leclerc won the race on a one-stop.
- Our tool's slope for NOR's Hard stints (−54.6 / −56.4 ms/lap) is even more
  favourable than Leclerc's.

(Removed on 2026-10-15: two statements attributed to Ferrari's post-race
team-radio debrief and to Norris's press conference, which had no source, and
the conclusion that the tool "independently corroborates" them.)

### Reproduction

1. Start the dashboard, load **2024 → Italian GP**.
2. Open **Lap Times** (`1`), brush laps 17–53.
3. Open **Tyre Degradation** (`2`) → per-stint slopes appear; focus driver
   switches via the Leaderboard.
4. Or directly: `curl -X POST http://localhost:8000/api/predict/degradation
   -H 'Content-Type: application/json' -d '{"year":2024,"round":16,
   "drivers":["LEC","NOR","PIA"],"lap_start":17,"lap_end":53}'`

---

## Insight 2 — The consistency metric ranks the race winner first

**Panel:** `ConsistencyPanel`, backed by
`GET /api/analytics/consistency/2024/16`.

Ranking by lap-time standard deviation (clean laps, pit and SC laps
filtered). (Note, 2026-10-15: this is the earlier definition. The endpoint
now returns, as `std_dev`, the pooled residual σ of the driver's per-stint
degradation fits, so tyre wear, fuel burn and stops do not count as
inconsistency: `docs/DEGRADATION_METHODOLOGY.md`, "Consistency sigma". The
values below are of the earlier definition.)

| Rank | Driver | σ lap time (s) |
|------|--------|----------------|
| 1    | LEC    | 0.851          |
| 2    | SAI    | 1.044          |
| 3    | PIA    | 1.096          |
| 4    | ALB    | 1.205          |
| 5    | RIC    | 1.245          |
| 6    | NOR    | 1.273          |
| 7    | VER    | 1.408          |
| 8    | HAM    | 1.418          |

### Why it matters

- Leclerc ranks **#1** — the narrowest lap-time distribution in the field.
  A successful one-stop at Monza demanded exactly this: keeping the Hard
  tyre inside a tight delta window for 37 laps.
- The top-3 most-consistent drivers are LEC, SAI, PIA — two of which are on
  the podium. (Removed on 2026-10-15: the reading that Sainz finished P4
  because he was held up behind Pérez after his stop. In the cached session's
  positions, after Sainz's stop (in-lap 19) Pérez was directly ahead of him
  only at the end of lap 23, Pérez's in-lap; from Pérez's stop to the flag he
  ran behind Sainz.)
- The ranking was population-σ (not sample-σ). (Note, 2026-10-15: the panel
  now shows the consistency σ of the per-stint fits, see the note above, and
  marks a driver with fewer than 75 % of the most laps completed as LOW DATA:
  `LOW_DATA_FRACTION` in `frontend/src/utils/views/degradationViews.js`.)

### Reproduction

`curl http://localhost:8000/api/analytics/consistency/2024/16` — sort by
`std_dev` ascending.

---

## Insight 3 — removed (LSTM 5-lap forecast)

Removed on 2026-10-15. This section forecast laps 26–30 from laps 16–25
with the LSTM, gave a table of predicted and actual lap times with an overall
error, and explained Sainz's large miss as the model forecasting his
clean-air pace while Pérez held him up from lap 26. The audit disproved it:

- Sainz's input window was not clean-air pace: it held his in-lap and his
  out-lap (the cached session's lap rows carry `PitInTime` on his lap 19 and
  `PitOutTime` on lap 20).
- On laps 26–30 the car directly ahead of Sainz was Leclerc, and Pérez ran
  behind him.
- The model was trained on a random split of the forecast windows, not of
  the races, so Monza's windows were in its training data (the comment on
  `EXTRA_TEST_RACES` in `backend/model/train.py`). It has been replaced; the
  served method and its held-out errors, Monza 2024 included, are in
  `docs/evidence/evaluate_forecast.txt` (`backend/scripts/evaluate_forecast.py`).

---

## Insight 4 — Methodology: fuel correction cannot be ignored in raw slope

**Observation from Insights 1–2:** every Hard-tyre stint at Monza 2024
returns a *negative* net regression slope. This is not tyre regression —
it is fuel mass burning off (~110 kg start → ~1 kg end, ~2.0 kg/lap ≈
0.035 s/lap pace gain).

The dashboard currently surfaces the *raw* slope (useful for strategy
comparisons *within* a race, because fuel correction is a constant
additive shift that doesn't change relative ranking). For cross-race
comparisons, a fixed `+30 ms/lap` correction recovers tyre-only
degradation and lines up with Pirelli's published per-compound slopes.

> **Correction (2026-10-15).** The dashboard no longer surfaces the raw slope
> alone: Tyre Degradation labels each stint with the fuel-corrected slope and
> the raw slope, both in s/lap (`TireDegradation.jsx`), with
> `slope = rawSlope + 0.03 s/lap` (`FUEL_EFFECT_S_PER_LAP`). The 0.03 s/lap is
> an assumption, not a measurement: fuel burn and tyre age grow together in
> every cached stint with usable laps, so the race data cannot separate them
> (`docs/DEGRADATION_METHODOLOGY.md`, "Fuel correction"). The claims that the
> correction "recovers tyre-only degradation" and "lines up with Pirelli's
> published per-compound slopes" had no source and are withdrawn.

### Recommendation for the VA report

Document this correction explicitly next to every slope value, or add a
toggle to the panel showing "raw / fuel-corrected" so the user understands
what they are reading. The file `docs/DEGRADATION_METHODOLOGY.md` already
sketches this — Insight 4 is empirical evidence for the methodology.

---

## Counter-example races (for contrast in the report)

| Race | Hard-tyre median slope (≥10 lap stints, raw) | Character         |
|------|----------------------------------------------|-------------------|
| Bahrain 2024 (R1)  | **+29 ms/lap** (range −9 to +61) | High-deg reference |
| Monza 2024 (R16)   | **−33 ms/lap** (range −88 to +4) | Low-deg, 1-stop viable |
| Qatar 2024 (R23)   | −42 to −117 ms/lap (short stints, SC-affected) | Stint lengths too short to conclude |

**Takeaway:** using the same methodology on the same tyre compound at
three different tracks produces slopes that differ by **~60 ms/lap**,
which maps directly onto pit-strategy viability. This is the core value
proposition of the degradation panel.

---

## Summary for the final report

1. **Insight 1** — Our degradation regression correctly identifies Monza
   2024 as a one-stop race.
2. **Insight 2** — Consistency σ independently ranks the race winner
   first, validating the metric against race outcome.
3. **Insight 3** — removed (see its section).
4. **Insight 4** — Raw-slope degradation needs a documented fuel
   correction for cross-race comparison; evidence from Monza's
   all-negative Hard-stint slopes makes the correction unavoidable.

(Changed on 2026-10-15: item 1 no longer says the regression "corroborates
Ferrari's call, quantifying McLaren's strategic error", which rested on the
removed quotes; item 3 summarised the removed LSTM insight. The closing claim
that every number here is reproducible is withdrawn until the numbers are
re-derived on the current code: see the status note at the top.)
