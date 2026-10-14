"""The mock live replay (live/mock_replay.py) end to end through the real
LiveSessionManager: the live lap rows must be the cached session it replays,
on the replay's session clock (scripts/check_mock_live.py runs the same
comparison over every cached race)."""
import json
import math

import pytest

from conftest import load_cached_session
from data.processors.stints import build_tyre_strategy
from scripts.check_mock_live import run_mock


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def same(a, b):
    a, b = num(a), num(b)
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= 1e-3)


@pytest.fixture(scope="module")
def monza():
    s = load_cached_session(2024, 16)
    manager, errors = run_mock(s)
    return s, manager, errors


def test_mock_monza_2024_yields_every_lap(monza):
    """B1: Position was sent as str(2.0) and int('2.0') raised inside the
    swallowed TimingData handler: 1008 errors, zero laps."""
    s, m, errors = monza
    assert errors.by_topic == {}
    keys = [(r["Driver"], int(r["LapNumber"])) for r in m.lap_times]
    assert len(m.lap_times) == len(s["lap_times"]) == 1008
    assert set(keys) == {(r["Driver"], int(r["LapNumber"])) for r in s["lap_times"]}
    assert len(set(keys)) == len(keys)  # no duplicate (best-lap) rows


def test_mock_monza_rows_equal_the_cached_rows(monza):
    s, m, _ = monza
    ref = {(r["Driver"], int(r["LapNumber"])): r for r in s["lap_times"]}
    lapped = 0
    for r in m.lap_times:
        c = ref[(r["Driver"], int(r["LapNumber"]))]
        key = (r["Driver"], r["LapNumber"])
        assert same(r["LapTimeSeconds"], c["LapTimeSeconds"]), key
        assert same(r["Position"], c["Position"]), key
        assert same(r["Time"], c["Time"]), key
        assert same(r["LapStartTime"], c["LapStartTime"]), key
        assert same(r["PitInTimeSeconds"], c["PitInTimeSeconds"]), key
        assert same(r["PitOutTimeSeconds"], c["PitOutTimeSeconds"]), key
        assert str(r["TrackStatus"]) == str(c["TrackStatus"]), key
        assert r["Compound"] == c["Compound"], key
        if r["Lapped"]:
            lapped += 1
            assert r["GapToLeader"] is None, key
        else:
            assert same(r["GapToLeader"], c["GapToLeader"]), key
    assert lapped > 0  # Monza 2024 has lapped cars ('1L' in the feed)
    # 31 pit entries and 30 exits in the cached race, all on their laps
    assert sum(r["PitInTimeSeconds"] is not None for r in m.lap_times) == 31
    assert sum(r["PitOutTimeSeconds"] is not None for r in m.lap_times) == 30


def test_mock_monza_stints_and_track_status(monza):
    s, m, _ = monza
    want = [(x["Driver"], x["StartLap"], x["Compound"]) for x in build_tyre_strategy(s["lap_times"])]
    got = [(x["Driver"], x["StartLap"], x["Compound"]) for x in m.tyre_strategy]
    assert sorted(got) == sorted(want) and len(got) == 50
    assert all(x["EndLap"] is None or x["EndLap"] >= x["StartLap"] for x in m.tyre_strategy)
    pia = [(x["Compound"], x["StartLap"], x["EndLap"]) for x in m.tyre_strategy if x["Driver"] == "PIA"]
    assert pia == [("MEDIUM", 1, 16), ("HARD", 17, 38), ("HARD", 39, None)]
    # session seconds (the cached period), not epoch seconds
    assert [(p["status"], p["start_time"]) for p in m.track_status] == [("1", 792.826)]


@pytest.mark.parametrize("rnd", [4, 8, 21])
def test_mock_red_flag_races_keep_the_replay_lap_track_status(rnd):
    """2024 R4 / R8 / R21 are red-flagged: the restart lap starts at the
    restart ('Started' after 'Aborted'), so its TrackStatus is the replay's
    (it used to include the red flag)."""
    s = load_cached_session(2024, rnd)
    m, errors = run_mock(s)
    assert errors.by_topic == {}
    ref = {(r["Driver"], int(r["LapNumber"])): r for r in s["lap_times"]}
    assert len(m.lap_times) == len(s["lap_times"])
    for r in m.lap_times:
        c = ref[(r["Driver"], int(r["LapNumber"]))]
        assert str(r["TrackStatus"]) == str(c["TrackStatus"]), (r["Driver"], r["LapNumber"])
        assert same(r["LapStartTime"], c["LapStartTime"]), (r["Driver"], r["LapNumber"])


def test_mock_snapshot_is_valid_json(monza):
    """Lapped gaps are None, never NaN: the snapshot round-trips as JSON."""
    _, m, _ = monza
    snap = m.get_snapshot()
    text = json.dumps({k: snap[k] for k in ("lap_times", "tyre_strategy", "track_status")}, allow_nan=False)
    assert json.loads(text)["lap_times"][0]["Driver"]
