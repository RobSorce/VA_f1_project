"""
Run the mock live replay (live/mock_replay.py) of a cached race through the
real LiveSessionManager and compare what the live pipeline built with the
cached session it replays (the replay's own data).

Run from backend/:
    python -m scripts.check_mock_live [year round] [--all]
or
    python scripts/check_mock_live.py 2024 16

Defaults to Monza 2024 (2024 R16). --all checks every cached race.

The mock's sleeps are skipped (asyncio.sleep is replaced by a no-op), so a
race replays in a few seconds. Reported per race:
- handler errors: exceptions caught and logged by LiveSessionManager.on_message
  (a swallowed error drops the message: the old int("2.0") of Position).
- lap rows: rows in the live lap_times, distinct (Driver, LapNumber) keys,
  duplicates, and the cached rows the live data has (by Driver, LapNumber).
- lap fields vs the cached row of the same (Driver, LapNumber): LapTime,
  Position, gap to leader (a lapped car's gap is None with Lapped True),
  PitInTime / PitOutTime and TrackStatus (session seconds), Compound, Stint.
- stints: live tyre_strategy vs build_tyre_strategy(lap_times), and stints
  whose EndLap < StartLap.
- track status: live periods, their time base (session seconds = the cached
  track_status times; epoch seconds are ~1.7e9).
"""
import asyncio
import json
import logging
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from data.processors.stints import build_tyre_strategy  # noqa: E402
from live import mock_replay  # noqa: E402
from live.mock_replay import MockReplay  # noqa: E402
from live.session_manager import LiveSessionManager  # noqa: E402

CACHE_DIR = os.path.join(BACKEND, "data", "processed_cache")


class _ErrorCounter(logging.Handler):
    """Counts the errors LiveSessionManager.on_message logs (and swallows)."""

    def __init__(self):
        super().__init__(level=logging.ERROR)
        self.by_topic = {}
        self.first = None

    def emit(self, record):
        msg = record.getMessage()
        if msg.startswith("Error handling "):
            topic = msg.split(" ")[2].rstrip(":")
            self.by_topic[topic] = self.by_topic.get(topic, 0) + 1
            if self.first is None:
                self.first = msg


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _same(a, b, tol=1e-3):
    a, b = _num(a), _num(b)
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= tol


def run_mock(session):
    """Replay a cached session payload through a LiveSessionManager; returns
    (manager, error counter)."""
    manager = LiveSessionManager()
    counter = _ErrorCounter()
    logger = logging.getLogger("live.session_manager")
    saved = (logger.level, logger.propagate)
    logger.setLevel(logging.ERROR)
    logger.propagate = False  # count the errors, do not print 1000 tracebacks
    logger.addHandler(counter)
    real_sleep = mock_replay.asyncio.sleep

    async def no_sleep(_seconds=0, *args, **kwargs):
        await real_sleep(0)

    mock_replay.asyncio.sleep = no_sleep
    try:
        mock = MockReplay(manager)
        mock._running = True
        asyncio.run(mock._replay_loop(session, None, 1e9, 0, 0))
    finally:
        mock_replay.asyncio.sleep = real_sleep
        logger.removeHandler(counter)
        logger.setLevel(saved[0])
        logger.propagate = saved[1]
    return manager, counter


def check(year, rnd, out=print):
    path = os.path.join(CACHE_DIR, f"session_{year}_{rnd}_R.json")
    with open(path, encoding="utf-8") as fh:
        session = json.load(fh)
    cached = session["lap_times"]
    manager, errors = run_mock(session)
    live = manager.lap_times

    out(f"== {year} R{rnd}: {os.path.basename(path)}")
    out(f"handler errors: {sum(errors.by_topic.values())} {errors.by_topic}")
    if errors.first:
        out(f"  first: {errors.first}")
    keys = [(r.get("Driver"), _num(r.get("LapNumber"))) for r in live]
    distinct = set(keys)
    cached_by = {(r["Driver"], _num(r["LapNumber"])): r for r in cached}
    out(f"lap rows: live {len(live)}, distinct (Driver, LapNumber) {len(distinct)}, "
        f"duplicates {len(live) - len(distinct)}, cached rows {len(cached)}, "
        f"cached keys present in live {len(distinct & set(cached_by))}")
    pb_rows = sum(1 for r in live if r.get("IsPersonalBest") and not r.get("Sector1Time")
                  and not r.get("Sector2Time") and not r.get("Sector3Time"))
    out(f"rows without sectors flagged IsPersonalBest (best-lap copies): {pb_rows}")

    counts = {}

    def tally(name, ok):
        c = counts.setdefault(name, [0, 0])
        c[0 if ok else 1] += 1

    lapped_rows = 0
    for r in live:
        ref = cached_by.get((r.get("Driver"), _num(r.get("LapNumber"))))
        if ref is None:
            tally("row matches a cached (Driver, LapNumber)", False)
            continue
        tally("row matches a cached (Driver, LapNumber)", True)
        tally("LapTime", _same(r.get("LapTimeSeconds"), ref.get("LapTimeSeconds")))
        tally("Position", _same(r.get("Position"), ref.get("Position")))
        if r.get("Lapped"):
            lapped_rows += 1
            tally("lapped row: gap None", r.get("GapToLeader") is None)
        else:
            tally("GapToLeader (not lapped)", _same(r.get("GapToLeader"), ref.get("GapToLeader")))
        tally("Time (session s)", _same(r.get("Time"), ref.get("Time")))
        tally("PitInTime (session s)", _same(r.get("PitInTimeSeconds"), ref.get("PitInTimeSeconds")))
        tally("PitOutTime (session s)", _same(r.get("PitOutTimeSeconds"), ref.get("PitOutTimeSeconds")))
        tally("TrackStatus", str(r.get("TrackStatus") or "") == str(ref.get("TrackStatus") or ""))
        tally("Compound", str(r.get("Compound")) == str(ref.get("Compound")))
    out(f"lapped rows (Lapped True): {lapped_rows}")
    for name, (ok, bad) in counts.items():
        out(f"  {name}: equal {ok}, different {bad}")

    ref_stints = build_tyre_strategy(cached)
    live_stints = [(s["Driver"], s["StartLap"], s["Compound"]) for s in manager.tyre_strategy]
    want = [(s["Driver"], s["StartLap"], s["Compound"]) for s in ref_stints]
    backwards = sum(1 for s in manager.tyre_strategy
                    if s.get("EndLap") is not None and s["EndLap"] < s["StartLap"])
    out(f"stints: live {len(live_stints)}, build_tyre_strategy {len(want)}, "
        f"identical (Driver, StartLap, Compound) {len(set(live_stints) & set(want))}, "
        f"EndLap < StartLap {backwards}")

    ts = manager.track_status
    starts = [_num(p.get("start_time")) for p in ts]
    starts = [s for s in starts if s is not None]
    base = ("epoch seconds" if starts and min(starts) > 1e9 else
            "session seconds" if starts else "n/a")
    sent = [(p.get("status"), _num(p.get("start_time"))) for p in ts]
    cached_ts = {(str(p.get("status")), _num(p.get("start_time"))) for p in session.get("track_status", [])}
    on_cached_clock = sum(1 for code, t in sent if (str(code), t) in cached_ts)
    out(f"track status: {len(ts)} periods, start_time base: {base}, "
        f"(status, start_time) equal to a cached period: {on_cached_clock}")
    return {
        "errors": sum(errors.by_topic.values()),
        "live_rows": len(live),
        "distinct": len(distinct),
        "cached_rows": len(cached),
        "counts": counts,
        "stints_backwards": backwards,
    }


def main(argv):
    logging.basicConfig(level=logging.CRITICAL)
    if "--all" in argv:
        races = []
        for name in sorted(os.listdir(CACHE_DIR)):
            if name.startswith("session_") and name.endswith("_R.json"):
                _, y, r, _ = name[:-5].split("_")
                races.append((int(y), int(r)))
        races.sort()
    else:
        args = [a for a in argv if not a.startswith("--")]
        races = [(int(args[0]), int(args[1]))] if len(args) >= 2 else [(2024, 16)]
    totals = {}
    for year, rnd in races:
        res = check(year, rnd)
        for name, (ok, bad) in res["counts"].items():
            t = totals.setdefault(name, [0, 0])
            t[0] += ok
            t[1] += bad
        for k in ("errors", "live_rows", "distinct", "cached_rows", "stints_backwards"):
            totals[k] = totals.get(k, 0) + res[k]
    if len(races) > 1:
        print(f"== TOTAL over {len(races)} races")
        for k, v in totals.items():
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main(sys.argv[1:])
