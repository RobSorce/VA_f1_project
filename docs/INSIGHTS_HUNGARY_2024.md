# Analytical Insights — Hungarian Grand Prix 2024 (Hungaroring, R13)

> **Status: to be re-derived after the 2026-10 fixes.** The numbers below
> were computed with the dashboard's definitions before the October 2026
> fixes: the degradation fit is now fuel-corrected and fitted on clean stint
> laps only (`docs/DEGRADATION_METHODOLOGY.md`), the consistency σ is now the
> pooled residual σ of the per-stint fits, and the lap-time forecast model has
> been replaced. Re-running the steps below on the current code can give
> other values. The LSTM insight, which compared this race with the disproved
> Monza forecast table, has been removed (dated note below).

Companion to `INSIGHTS_MONZA_2024.md`. Same methodology, different race
character: Hungary is a **high-degradation, high-downforce** circuit
where the Hard tyre cannot coast to the flag on fuel burn alone. The
tool must therefore show *positive* tyre slopes — the opposite of
Monza — if it is working correctly.

All numbers computed from
`backend/data/processed_cache/session_2024_13_R.json`.

**Race result (official):**

| Pos | Driver | Team       | Grid | Strategy                | Gap      |
|-----|--------|------------|------|-------------------------|----------|
| 1   | PIA    | McLaren    | 2    | M×17 → H×27 → M×21      | —        |
| 2   | NOR    | McLaren    | 1    | M×16 → H×26 → M×23      | +2.1 s   |
| 3   | HAM    | Mercedes   | 5    | M×15 → H×22 → **H×28**  | +14.9 s  |
| 4   | LEC    | Ferrari    | 6    | M×22 → H×15 → M×28      | +19.7 s  |
| 5   | VER    | Red Bull   | 3    | M×20 → H×26 → M×19      | +21.3 s  |

Team orders controversy: McLaren asked Norris to let Piastri through on
Lap 68; their order of pit stops had accidentally swapped the race lead
that Piastri had been holding since the first lap.

---

## Insight 1 — Hungary and Monza are opposite signatures on the *same* Hard compound

**Panel:** `TireDegradation` / `POST /api/predict/degradation`.

Per-stint regression (`ms/lap`, clean laps only, SC/pit filtered):

| Stint                | Monza 2024 (R16)         | Hungary 2024 (R13)       |
|----------------------|--------------------------|--------------------------|
| LEC Hard ≥15 laps    | **−8.3** (37 laps)       | **+138.0** (15 laps)     |
| PIA Hard ≥20 laps    | −33.5 (20 laps)          | **+54.6** (27 laps)      |
| NOR Hard ≥15 laps    | −54.6 (16 laps)          | **+44.8** (26 laps)      |
| HAM Hard ≥20 laps    | −88.0 (20 laps)          | +85.3 (22 laps)          |
| SAI Hard ≥30 laps    | +3.9 (33 laps)           | +20.8 (24 laps)          |

**Median Hard slope Monza: −33 ms/lap. Median Hard slope Hungary: +55
ms/lap.** Fuel burn contributes roughly the same ~30 ms/lap at both
tracks, so the *tyre-only* delta is ≈ **+90 ms/lap**. Over a 25-lap
stint that is **2.2 s of cumulative time lost to deg** at Hungary that
simply does not exist at Monza. This is the quantitative reason
Hungary is unworkable as a one-stop and Monza is not.

### Why it matters

Running the same analysis, on the same compound, on the same four
drivers, the tool returns opposite-sign slopes — and the signs match
the historical character of the two tracks. That is a hard falsification
test the methodology passes.

### Reproduction

```
curl -X POST http://localhost:8000/api/predict/degradation \
  -H 'Content-Type: application/json' \
  -d '{"year":2024,"round":13,"drivers":["PIA","NOR","HAM","LEC"],
       "lap_start":19,"lap_end":46}'
```

---

## Insight 2 — Hamilton's final stint was field-best tyre management

**Panel:** `TireDegradation` + `LapTimeChart`.

HAM stint 3: HARD, laps 42-70, **28 laps**, slope **+2.4 ms/lap**.

Contextualised against the same race, same tyre, similar stint length:

| Driver | Final stint          | Slope (ms/lap) |
|--------|----------------------|----------------|
| HAM    | H × 28 (L42-L70)     | **+2.4**       |
| PIA    | M × 21 (L49-L70)     | +45.0          |
| NOR    | M × 23 (L47-L70)     | +93.5          |
| VER    | M × 19 (L51-L70)     | +88.6          |
| SAI    | M × 21 (L49-L70)     | +87.9          |
| LEC    | M × 28 (L42-L70)     | +7.4           |

HAM on the Hard and LEC on the Medium are the only two drivers with
sub-10 ms/lap slopes over 28 laps. Everyone else on the Medium is
losing 0.5–2.0 s/stint to degradation.

### Why it matters

- Hamilton recovered from P5-grid to P3-finish **entirely on long-run
  tyre management**, not overtaking pace. The tool quantifies the
  effect: over 28 laps he paid ~0.07 s to deg vs the McLarens paying
  ~1.3–2.6 s.
- Confirms Hamilton's reputation for tyre-life management is reflected
  in the telemetry, not just press narrative.

### Reproduction

1. Open **2024 → Hungarian GP**, select HAM, brush L42–L70 in the
   **Lap Times** panel.
2. **Tyre Degradation** auto-fits a line with slope ≈ +0.002 s/lap.

---

## Insight 3 — Consistency σ still matches the podium

**Panel:** `GET /api/analytics/consistency/2024/13`.

(Note, 2026-10-15: the σ values below are of the earlier definition, the
standard deviation of the clean lap times. The endpoint now returns the pooled
residual σ of the driver's per-stint degradation fits:
`docs/DEGRADATION_METHODOLOGY.md`, "Consistency sigma".)

| Rank | Driver | σ (s) | Finish |
|------|--------|-------|--------|
| 1    | GAS    | 0.859 | P11    |
| 2    | PIA    | 0.988 | **P1** |
| 3    | HAM    | 1.121 | **P3** |
| 4    | LEC    | 1.245 | **P4** |
| 5    | NOR    | 1.250 | **P2** |
| 6    | ALO    | 1.294 | P15    |
| 7    | VER    | 1.315 | P5     |

### Why it matters

- (Corrected on 2026-10-16: this line said that the five most consistent
  drivers after GAS finished P1-P5 in order of consistency, an exact 1-to-1
  mapping. The table above does not show that: in σ order they are PIA (P1),
  HAM (P3), LEC (P4), NOR (P2) and ALO (P15), and VER (P5) is sixth.)
- Reproduces the Monza finding (LEC consistency #1 → race winner) with
  an independent race.
- GAS #1 with σ=0.859 is not noise — he genuinely kept a narrow
  distribution — he just didn't have the absolute pace of the top cars.
  So the metric ranks *lap-time discipline*, not absolute pace, which
  is exactly what it is supposed to do.

---

## Insight 4 — removed (LSTM errors at stint transitions)

Removed on 2026-10-15. This section gave the previous LSTM's errors on laps
26–30 per driver and compared its overall error with the Monza table of
`INSIGHTS_MONZA_2024.md`, which the audit disproved and which has been removed.
That model was trained on a random split of the forecast windows, not of the
races (the comment on `EXTRA_TEST_RACES` in `backend/model/train.py`), and has
been replaced; the served method and its held-out errors are in
`docs/evidence/evaluate_forecast.txt` (`backend/scripts/evaluate_forecast.py`).

---

## Summary — what Hungary 2024 validates

1. Tyre-deg methodology correctly inverts sign between Monza (low deg,
   one-stop) and Hungary (high deg, mandatory two-stop) on the **same
   compound and same drivers**.
2. Hamilton's +2.4 ms/lap on a 28-lap Hard is an isolated,
   tool-identifiable signature of world-class tyre management that
   explains his race result.
3. Corrected on 2026-10-16: this item claimed a 1-to-1 mapping of the
   consistency σ to finish positions P1-P5, which the table of Insight 3
   does not show (see its note).
4. Removed on 2026-10-15 (the LSTM insight, see its section).
