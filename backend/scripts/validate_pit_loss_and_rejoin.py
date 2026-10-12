"""
Validate the pit-loss estimator and the "rejoin position" prediction used by the
Circle of Doom view, on every cached race in backend/data/processed_cache.

Run from backend/:
    python -m scripts.validate_pit_loss_and_rejoin
or
    python scripts/validate_pit_loss_and_rejoin.py

Definitions
-----------
- Green lap: a lap whose TrackStatus string is exactly '1' (no yellow, SC, VSC, red).
- Driver green median: median LapTime of the driver's green laps that are neither
  in-laps (PitInTime set) nor out-laps (PitOutTime set), lap 1 excluded.
- Pit loss (correct): (in-lap time + out-lap time) - 2 * driver green median.
  FastF1 splits one stop over two laps: PitInTime lives on the in-lap, PitOutTime
  on the following out-lap. Using only the in-lap (current extractRaceParams in
  frontend/src/utils/raceSimulation.js) misses the out-lap share of the loss.
- Rejoin prediction for a stop with in-lap n:
      T_pred = Time(lap n-1) + 2 * driver green median + estimated pit loss
  predicted position = 1 + #other cars whose actual Time at lap n+1 < T_pred
  actual position    = 1 + #other cars whose actual Time at lap n+1 < actual Time(lap n+1)
  (Sorting cars by the session time at which they complete lap n+1 gives the race
  order at that lap, lapped cars included.)

Estimators compared (rejoin backtest, green-flag stops only)
  causal_fixed : median correct pit loss of stops completed earlier in the same race,
                 22 s fallback before the first stop. Uses only past information.
  current_code : mean of in-lap-only losses (5 < loss < 60) of earlier stops, as the
                 current frontend code does; 22 s fallback.
  constant_22  : the hard-coded fallback.
"""
import glob
import json
import os
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "..", "data", "processed_cache")
FALLBACK = 22.0


def load(path):
    with open(path) as fh:
        laps = json.load(fh)["lap_times"]
    by = {}
    for r in laps:
        by.setdefault(r["Driver"], {})[int(r["LapNumber"])] = r
    return by


def is_green(r):
    return str(r.get("TrackStatus")) == "1"


def green_medians(by):
    med = {}
    for drv, laps in by.items():
        c = [r["LapTimeSeconds"] for n, r in laps.items()
             if n > 1 and r.get("LapTimeSeconds") and r["LapTimeSeconds"] < 200
             and not r.get("PitInTimeSeconds") and not r.get("PitOutTimeSeconds") and is_green(r)]
        if len(c) > 5:
            med[drv] = st.median(c)
    return med


def code_medians(by):
    """Median used by the current frontend code: no track-status filter."""
    med = {}
    for drv, laps in by.items():
        c = sorted(r["LapTimeSeconds"] for r in laps.values()
                   if r.get("LapTimeSeconds") and 0 < r["LapTimeSeconds"] < 200
                   and not r.get("PitInTimeSeconds") and not r.get("PitOutTimeSeconds"))
        if c:
            med[drv] = c[len(c) // 2]
    return med


def green_stops(by, med):
    stops = []
    for drv, laps in by.items():
        if drv not in med:
            continue
        for n, r in laps.items():
            o, p = laps.get(n + 1), laps.get(n - 1)
            if not (r.get("PitInTimeSeconds") and o and p and o.get("PitOutTimeSeconds")
                    and r.get("LapTimeSeconds") and o.get("LapTimeSeconds")
                    and p.get("Time") and o.get("Time")):
                continue
            if not all(is_green(x) for x in (p, r, o)):
                continue
            loss = r["LapTimeSeconds"] + o["LapTimeSeconds"] - 2 * med[drv]
            in_loss = r["LapTimeSeconds"] - med[drv]
            if 10 < loss < 60:
                stops.append({"drv": drv, "lap": n, "loss": loss, "in_loss": in_loss})
    return stops


def code_losses(by, cmed):
    out = []
    for drv, laps in by.items():
        if drv not in cmed:
            continue
        for n, r in laps.items():
            if r.get("PitInTimeSeconds") and r.get("LapTimeSeconds") and 0 < r["LapTimeSeconds"] < 300:
                loss = r["LapTimeSeconds"] - cmed[drv]
                if 5 < loss < 60:
                    out.append((n, loss))
    return out


def main(cache_dir):
    files = sorted(glob.glob(os.path.join(cache_dir, "session_*_R.json")))
    if not files:
        sys.exit(f"No session_*_R.json in {cache_dir}")
    print(f"{'race':10}{'n_green':>8}{'true_loss':>10}{'code_loss':>10}{'in_share':>9}")
    pos_err = {"causal_fixed": [], "current_code": [], "constant_22": []}
    for f in files:
        by = load(f)
        med, cmed = green_medians(by), code_medians(by)
        stops, closs = green_stops(by, med), code_losses(by, cmed)
        name = os.path.basename(f)[8:-7]
        if stops:
            print(f"{name:10}{len(stops):8d}{st.median(s['loss'] for s in stops):10.1f}"
                  f"{(st.mean(l for _, l in closs) if closs else float('nan')):10.1f}"
                  f"{st.median(s['in_loss'] / s['loss'] for s in stops):9.2f}")
        for s in stops:
            n, drv = s["lap"], s["drv"]
            prev = [x["loss"] for x in stops if x["lap"] + 1 < n]
            cprev = [l for m, l in closs if m < n]
            est = {"causal_fixed": st.median(prev) if prev else FALLBACK,
                   "current_code": st.mean(cprev) if cprev else FALLBACK,
                   "constant_22": FALLBACK}
            t_act = by[drv][n + 1]["Time"]
            others = [by[x][n + 1]["Time"] for x in by
                      if x != drv and n + 1 in by[x] and by[x][n + 1].get("Time")]
            p_act = 1 + sum(t < t_act for t in others)
            for k, loss in est.items():
                t_pred = by[drv][n - 1]["Time"] + 2 * med[drv] + loss
                pos_err[k].append((1 + sum(t < t_pred for t in others)) - p_act)
    print()
    for k, v in pos_err.items():
        n = len(v)
        print(f"{k:14} stops={n} exact={100 * sum(x == 0 for x in v) / n:.0f}% "
              f"within_1={100 * sum(abs(x) <= 1 for x in v) / n:.0f}%")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else CACHE_DIR)
