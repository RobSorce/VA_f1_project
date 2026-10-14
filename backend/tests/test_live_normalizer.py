"""Live timing pipeline (live/data_normalizer.py through LiveSessionManager)
on real-format messages. The formats are those of the recorded live-timing
files of the 2024 Italian GP race (FastF1 http cache; notes/experiments/
phase8/live_B/probe_raw_formats.txt): Position is a string, NumberOfLaps an
int and LastLapTime arrives with it; the leader's GapToLeader is 'LAP <n>', a
lapped car's '1L' or '1 L'; TimingAppData's first Stints and
RaceControlMessages' first Messages are lists, later ones dicts."""
import asyncio
import json
import math

import pytest

from live.data_normalizer import LiveDataNormalizer, _parse_gap, _to_int
from live.session_manager import LiveSessionManager

DRIVERS = {"16": {"Tla": "LEC", "TeamName": "Ferrari"},
           "81": {"Tla": "PIA", "TeamName": "McLaren"},
           "43": {"Tla": "COL", "TeamName": "Williams"}}


def manager():
    m = LiveSessionManager()
    send(m, "DriverList", DRIVERS)
    return m


def send(m, topic, data, t=None):
    """One message; with t, the session clock is pinned to t first."""
    if t is not None:
        m.set_session_time(t)
    asyncio.run(m.on_message(topic, data))


def lines(**by_num):
    return {"Lines": by_num}


# ---------------------------------------------------------------- B1

@pytest.mark.parametrize("raw, want", [
    ("2", 2), ("2.0", 2), (2, 2), (2.0, 2), ("", None), (None, None), ("x", None),
    (float("nan"), None),
])
def test_to_int_accepts_the_numeric_forms_of_position(raw, want):
    assert _to_int(raw) == want


def test_a_float_string_position_no_longer_drops_the_lap():
    """int('2.0') raised inside the TimingData handler and the error was
    swallowed: the mock replay (which sent str(2.0)) produced zero laps."""
    m = manager()
    send(m, "TimingData", lines(**{"16": {"Position": "2.0", "NumberOfLaps": 1,
                                          "LastLapTime": {"Value": "1:28.179"}}}))
    assert [(r["Driver"], r["LapNumber"], r["Position"]) for r in m.lap_times] == [("LEC", 1, 2)]


# ---------------------------------------------------------------- B2

@pytest.mark.parametrize("raw, want", [
    ("LAP 30", (0.0, 0)),     # the race leader
    ("LAP 1", (0.0, 0)),
    ("+2.664", (2.664, 0)),
    ("1L", (None, 1)),        # recorded lapped forms
    ("1 L", (None, 1)),
    ("+1 LAP", (None, 1)),
    ("+2 LAPS", (None, 2)),
    ("", None),               # no value: keep the previous one (FastF1)
    (None, None),
])
def test_parse_gap(raw, want):
    assert _parse_gap(raw) == want


def test_leader_gap_is_zero_and_a_lapped_car_has_no_time_gap():
    m = manager()
    send(m, "TimingData", lines(**{
        "16": {"Position": "1", "GapToLeader": "LAP 30", "IntervalToPositionAhead": {"Value": "LAP 30"},
               "NumberOfLaps": 29, "LastLapTime": {"Value": "1:24.000"}},
        "81": {"Position": "2", "GapToLeader": "+2.664", "IntervalToPositionAhead": {"Value": "+2.664"},
               "NumberOfLaps": 29, "LastLapTime": {"Value": "1:24.500"}},
        "43": {"Position": "12", "GapToLeader": "1L", "IntervalToPositionAhead": {"Value": "1L"},
               "NumberOfLaps": 28, "LastLapTime": {"Value": "1:26.000"}},
    }))
    rows = {r["Driver"]: r for r in m.lap_times}
    # 'LAP 30' used to become a 30.0 s gap, '1L' a 0.0 s one (the leader's)
    assert (rows["LEC"]["GapToLeader"], rows["LEC"]["IntervalToAhead"], rows["LEC"]["Lapped"]) == (0.0, 0.0, False)
    assert (rows["PIA"]["GapToLeader"], rows["PIA"]["Lapped"]) == (2.664, False)
    assert rows["COL"]["GapToLeader"] is None and rows["COL"]["IntervalToAhead"] is None
    assert (rows["COL"]["Lapped"], rows["COL"]["LapsDown"]) == (True, 1)
    standings = {s["driver"]: s for s in m.normalizer.build_standings()}
    assert (standings["COL"]["gap_to_leader"], standings["COL"]["lapped"]) == (None, True)
    # '+1 LAP' used to become a 1.0 s gap; an empty value keeps the previous one
    send(m, "TimingData", lines(**{"43": {"GapToLeader": "+1 LAP"}}))
    assert m.normalizer.driver_state["COL"]["gap_to_leader"] is None
    send(m, "TimingData", lines(**{"81": {"GapToLeader": ""}}))
    assert m.normalizer.driver_state["PIA"]["gap_to_leader"] == 2.664
    # back on the lead lap
    send(m, "TimingData", lines(**{"43": {"GapToLeader": "+75.120"}}))
    assert (m.normalizer.driver_state["COL"]["gap_to_leader"], m.normalizer.driver_state["COL"]["lapped"]) \
        == (75.12, False)


def test_a_lapped_gap_serialises_as_json_null():
    """NaN is not JSON (json.dumps writes NaN, which JSON.parse rejects):
    the lapped gap is None, null on the wire."""
    m = manager()
    send(m, "TimingData", lines(**{"43": {"Position": "12", "GapToLeader": "1L", "NumberOfLaps": 3,
                                          "LastLapTime": {"Value": "1:26.000"}}}))
    text = json.dumps(m.get_snapshot()["lap_times"])
    assert "NaN" not in text and json.loads(text)[0]["GapToLeader"] is None


# ---------------------------------------------------------------- B3

def test_personal_best_fields_do_not_add_lap_rows():
    """BestLapTime (TimingData) and PersonalBestLapTime (TimingStats) used to
    emit extra rows: one completed lap became three rows."""
    m = manager()
    send(m, "LapCount", {"CurrentLap": 13, "TotalLaps": 53})
    send(m, "TimingData", lines(**{"81": {
        "NumberOfLaps": 12, "Position": "2",
        "LastLapTime": {"Value": "1:24.077", "PersonalFastest": True},
        "BestLapTime": {"Value": "1:24.077", "Lap": 12}}}))
    send(m, "TimingStats", lines(**{"81": {"PersonalBestLapTime": {"Value": "1:23.900", "Lap": 12}}}))
    send(m, "TimingData", lines(**{"81": {"BestLapTime": {"Value": "1:23.800", "Lap": 12}}}))
    assert [(r["Driver"], r["LapNumber"], r["LapTimeSeconds"]) for r in m.lap_times] == [("PIA", 12, 84.077)]
    # the best is still tracked
    assert m.normalizer.driver_state["PIA"]["best_lap_time"] == 83.8


def test_lap_number_is_the_drivers_number_of_laps_not_the_leaders_lap_count():
    """LapNumber = max(NumberOfLaps, LapCount) relabelled every row with the
    leader's current lap (LapCount = the lap being driven), and a lapped car's
    lap 11 as lap 13."""
    m = manager()
    send(m, "LapCount", {"CurrentLap": 13, "TotalLaps": 53})
    send(m, "TimingData", lines(**{"43": {"NumberOfLaps": 11, "Position": "18", "GapToLeader": "1L",
                                          "LastLapTime": {"Value": "1:26.500"}}}))
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 12, "Position": "1", "GapToLeader": "LAP 13",
                                          "LastLapTime": {"Value": "1:24.500"}}}))
    assert [(r["Driver"], r["LapNumber"]) for r in m.lap_times] == [("COL", 11), ("LEC", 12)]


def test_one_row_per_completed_lap_even_without_a_lap_time():
    """A NumberOfLaps step without LastLapTime still completes the lap (its
    time is None); a repeated NumberOfLaps or a LastLapTime alone adds none."""
    m = manager()
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 1}}))
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 1, "LastLapTime": {"Value": "1:30.000"}}}))
    send(m, "TimingData", lines(**{"16": {"LastLapTime": {"Value": "1:30.000"}}}))
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 2, "LastLapTime": {"Value": "1:25.000"}}}))
    assert [(r["LapNumber"], r["LapTimeSeconds"]) for r in m.lap_times] == [(1, None), (2, 85.0)]


# ---------------------------------------------------------------- B4

def test_mid_race_stint_snapshot_places_past_stints_on_their_laps():
    """A client connecting on lap 45 gets every stint in one list: they all
    used to start on the current lap (EndLap < StartLap). Recorded PIA,
    Monza 2024: MEDIUM 16 laps, HARD 22 laps, HARD."""
    m = manager()
    send(m, "LapCount", {"CurrentLap": 45, "TotalLaps": 53})
    send(m, "TimingData", lines(**{"81": {"NumberOfLaps": 44, "Position": "2"}}))
    send(m, "TimingAppData", lines(**{"81": {"Stints": [
        {"LapFlags": 0, "Compound": "MEDIUM", "New": "true", "TyresNotChanged": "0", "TotalLaps": 16, "StartLaps": 0},
        {"LapFlags": 0, "Compound": "HARD", "New": "true", "TyresNotChanged": "0", "TotalLaps": 22, "StartLaps": 0},
        {"LapFlags": 1, "Compound": "HARD", "New": "true", "TyresNotChanged": "0", "TotalLaps": 6, "StartLaps": 0},
    ]}}))
    got = [(s["StintNumber"], s["Compound"], s["StartLap"], s["EndLap"], s["TotalLaps"]) for s in m.tyre_strategy]
    assert got == [(1, "MEDIUM", 1, 16, 16), (2, "HARD", 17, 38, 22), (3, "HARD", 39, None, 0)]
    state = m.normalizer.driver_state["PIA"]
    assert (state["compound"], state["stint_number"], state["tyre_life"]) == ("HARD", 3, 6)


def test_used_tyres_and_same_set_passes_count_laps_not_stints():
    """Laps of a feed stint = TotalLaps - StartLaps (the set's age now minus
    when fitted). TyresNotChanged '1' (a pit-lane pass on the same set,
    recorded 2024 R4 red flag) is not a new stint (DECISIONS.md R1), but its
    laps count."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [
        {"Compound": "MEDIUM", "New": "true", "TyresNotChanged": "0", "TotalLaps": 1, "StartLaps": 0},
        {"Compound": "MEDIUM", "New": "false", "TyresNotChanged": "1", "TotalLaps": 11, "StartLaps": 1},
        {"Compound": "HARD", "New": "false", "TyresNotChanged": "0", "TotalLaps": 18, "StartLaps": 3},
        {"Compound": "HARD", "New": "true", "TyresNotChanged": "0", "TotalLaps": 2, "StartLaps": 0},
    ]}}))
    got = [(s["StintNumber"], s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy]
    assert got == [(1, "MEDIUM", 1, 11), (2, "HARD", 12, 26), (3, "HARD", 27, None)]


def test_live_stints_follow_the_feed_updates():
    """Incremental dict updates: TotalLaps grows lap by lap, a new index after
    a pit entry is a pit stop; the new stint starts on the driver's lap in
    progress, the one after the laps the old one ran."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [
        {"Compound": "MEDIUM", "New": "true", "TyresNotChanged": "0", "TotalLaps": 0, "StartLaps": 0}]}}))
    for n in range(1, 17):
        if n == 16:
            send(m, "TimingData", lines(**{"81": {"InPit": True}}))  # lap 16 is the in-lap
        send(m, "TimingData", lines(**{"81": {"NumberOfLaps": n}}))
        send(m, "TimingAppData", lines(**{"81": {"Stints": {"0": {"TotalLaps": n}}}}))
    assert m.normalizer.driver_state["PIA"]["tyre_life"] == 16
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {
        "Compound": "HARD", "New": "true", "TyresNotChanged": "0", "TotalLaps": 0, "StartLaps": 0}}}}))
    got = [(s["Compound"], s["StartLap"], s["EndLap"], s["TotalLaps"]) for s in m.tyre_strategy]
    assert got == [("MEDIUM", 1, 16, 16), ("HARD", 17, None, 0)]
    # a later partial update of the same index is not a new stint
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {"TotalLaps": 1, "LapFlags": 0}}}}))
    assert len(m.tyre_strategy) == 2


def st(compound, tnc="0", total=0, start=0, new="true"):
    """A feed stint as TimingAppData sends it when it appears."""
    return {"Compound": compound, "New": new, "TyresNotChanged": tnc, "TotalLaps": total, "StartLaps": start}


def laps(m, num, upto, first=1):
    """Lap completions (NumberOfLaps) of one driver, laps first..upto."""
    for n in range(first, upto + 1):
        send(m, "TimingData", lines(**{num: {"NumberOfLaps": n}}))


def in_lap(m, num, n):
    """A pit entry on lap n, then lap n ends in the pit lane (an in-lap):
    the feed's next stint index comes after it (FastF1 lets the stint
    counter go up once between two in-laps)."""
    send(m, "TimingData", lines(**{num: {"InPit": True}}))
    send(m, "TimingData", lines(**{num: {"NumberOfLaps": n}}))
    send(m, "TimingData", lines(**{num: {"InPit": False}}))


def drain(q):
    out = []
    while not q.empty():
        out.append(json.loads(q.get_nowait()))
    return out


def test_a_compound_corrected_after_the_stint_was_sent_replaces_it():
    """Recorded 2024 R16 STR: feed stint 1 sent MEDIUM, corrected to HARD 25 s
    later. The entry kept MEDIUM for the whole stint while the lap rows (and
    FastF1, which applies the correction to all of the stint) said HARD."""
    m = manager()
    q = m.subscribe()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("MEDIUM")]}}))
    laps(m, "81", 18)
    in_lap(m, "81", 19)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("MEDIUM")}}}))
    drain(q)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {"Compound": "HARD"}}}}))
    got = [(s["StintNumber"], s["Compound"], s["StartLap"], s["EndLap"], s["TotalLaps"]) for s in m.tyre_strategy]
    assert got == [(1, "MEDIUM", 1, 19, 19), (2, "HARD", 20, None, 0)]
    # an open dashboard gets the driver's corrected list again as
    # 'strategy_update' messages, the only stint message it applies (it
    # appends them; a lap shows the last entry starting on or before it). The
    # 'strategy_correction' sent before had no consumer: the client kept MEDIUM
    msgs = [x for x in drain(q) if x["type"].startswith("strategy")]
    assert [x["type"] for x in msgs] == ["strategy_update", "strategy_update"]
    assert [(x["data"]["Driver"], x["data"]["Compound"], x["data"]["StartLap"], x["data"]["EndLap"])
            for x in msgs] == [("PIA", "MEDIUM", 1, 19), ("PIA", "HARD", 20, None)]
    laps(m, "81", 20, first=20)
    assert m.lap_times[-1]["Compound"] == "HARD"


def test_a_pass_rewritten_as_a_tyre_change_keeps_its_first_lap():
    """Recorded 2025 R8 RUS: feed stint 1 arrives on lap 54 as a drive-through
    on the same HARD set and is rewritten on lap 63 as a new MEDIUM set;
    stint 2 (HARD) arrives on lap 69. FastF1 gives a stint the laps that end
    after its first message: MEDIUM 54-68, HARD from 69. The TotalLaps count
    alone put the HARD on lap 60 (the rewrite reset the set's age)."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("HARD")]}}))
    laps(m, "81", 52)
    in_lap(m, "81", 53)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"0": {"TotalLaps": 53}}}}))
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("HARD", tnc="1", total=53, start=53, new="false")}}}))
    assert [(s["Compound"], s["StartLap"]) for s in m.tyre_strategy] == [("HARD", 1)]
    laps(m, "81", 61, first=54)
    in_lap(m, "81", 62)  # the drive-through: pit-out lap 63
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("MEDIUM")}}}))
    laps(m, "81", 67, first=63)
    in_lap(m, "81", 68)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {"TotalLaps": 6}}}}))
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"2": st("HARD")}}}))
    got = [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy]
    assert got == [("HARD", 1, 53), ("MEDIUM", 54, 68), ("HARD", 69, None)]


def test_an_index_reused_for_a_later_set_starts_that_set_on_its_lap():
    """Recorded 2025 R1 BOR (wet race): six feed indexes for five pit
    entries. Index 5 arrives on lap 5 as a pass on the INTERMEDIATE set, and
    the feed rewrites it on lap 34, after the next in-lap, as a new MEDIUM
    set (TyresNotChanged '1' -> '0', New 'true', TotalLaps 0). FastF1 counts
    one stint per bracket between in-laps, so the rewrite is the stint of
    lap 34 (replay: MEDIUM 34-44). Taken by its index, the MEDIUM was drawn
    from lap 5 and the INTERMEDIATE laps 5-33 disappeared."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("INTERMEDIATE")]}}))
    laps(m, "81", 1)
    in_lap(m, "81", 2)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {
        "1": st("INTERMEDIATE", tnc="1", total=2, start=2, new="false"),
        "2": st("INTERMEDIATE", tnc="1", total=2, start=2, new="false")}}}))
    in_lap(m, "81", 3)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {
        "3": st("INTERMEDIATE", tnc="1", total=3, start=3, new="false"),
        "4": st("INTERMEDIATE", tnc="1", total=3, start=3, new="false")}}}))
    in_lap(m, "81", 4)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {
        "5": st("INTERMEDIATE", tnc="1", total=4, start=4, new="false")}}}))
    laps(m, "81", 32, first=5)
    in_lap(m, "81", 33)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"4": {"TotalLaps": 32}, "5": st("MEDIUM")}}}))
    laps(m, "81", 43, first=34)
    in_lap(m, "81", 44)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"6": st("INTERMEDIATE")}}}))
    got = [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy]
    assert got == [("INTERMEDIATE", 1, 33), ("MEDIUM", 34, 44), ("INTERMEDIATE", 45, None)]


def test_a_connect_places_the_set_in_use_by_its_age_when_the_runs_miss_laps():
    """Recorded 2025 R1 LAW, connect on lap 42 (40 laps done, 4 pit entries):
    the feed counted none of the laps of stints 0-4 (TotalLaps = StartLaps)
    and 16 of the 29 of stint 5, so the runs put the MEDIUM fitted on lap 34
    on lap 17 (replay: 34) and stints 0-4 all on lap 1 (two stints on one
    StartLap). Indexes above the pit entries are merged as FastF1 merges
    them; the set in use counts its own 7 laps: it starts on lap 34, and the
    stints that ran no lap have no entry."""
    m = manager()
    inter = {"Compound": "INTERMEDIATE", "New": "false", "TyresNotChanged": "1"}
    send(m, "TimingAppData", lines(**{"81": {"Stints": [
        dict(inter, TyresNotChanged="0", TotalLaps=0, StartLaps=0),
        dict(inter, TotalLaps=0, StartLaps=0),
        dict(inter, TotalLaps=0, StartLaps=0, LapNumber=2),
        dict(inter, TotalLaps=2, StartLaps=2),
        dict(inter, TotalLaps=3, StartLaps=3),
        dict(inter, New="true", TyresNotChanged="0", TotalLaps=16, StartLaps=0, LapNumber=29),
        {"Compound": "MEDIUM", "New": "true", "TyresNotChanged": "0", "TotalLaps": 7, "StartLaps": 0,
         "LapNumber": 40},
    ]}}), t=8717.766)
    send(m, "TimingData", lines(**{"81": {"RacingNumber": "81", "Position": "15", "NumberOfLaps": 40,
                                          "NumberOfPitStops": 4}}), t=8717.766)
    got = [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy]
    assert got == [("INTERMEDIATE", 1, 33), ("MEDIUM", 34, None)]


def test_a_connect_after_a_stop_opens_the_stint_of_the_index_still_to_come():
    """Recorded 2024 R2 BOT, connect on lap 37: in the pit lane after the
    lap-35 in-lap (NumberOfPitStops 2), the SOFT set (index 2) arrives after
    the snapshot. With the snapshot's last index (1) as the stint counter it
    went to the HARD stint and renamed it SOFT; the counter is the pit
    entries, so it opens stint 3."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [
        {"Compound": "SOFT", "New": "true", "TyresNotChanged": "0", "TotalLaps": 7, "StartLaps": 0, "LapNumber": 6},
        {"Compound": "HARD", "New": "true", "TyresNotChanged": "0", "TotalLaps": 28, "StartLaps": 0,
         "LapNumber": 29}]}}), t=7130.0)
    send(m, "TimingData", lines(**{"81": {"RacingNumber": "81", "NumberOfLaps": 35, "NumberOfPitStops": 2,
                                          "InPit": True}}), t=7130.0)
    send(m, "TimingData", lines(**{"81": {"InPit": False, "PitOut": True}}), t=7147.46)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"2": st("SOFT")}}}), t=7152.3)
    got = [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy]
    assert got == [("SOFT", 1, 7), ("HARD", 8, 35), ("SOFT", 36, None)]


def test_a_resubscription_does_not_undo_a_newer_value_of_the_stint():
    """A re-subscription snapshot repeats every index's merged record. A
    stint fed by two indexes (FastF1's renumbering) took the newer value of
    one of them; re-applied whole, in index order, the other index's older
    value undid it (2025 R1 BEA / LAW, 4 of 1196 driver-gaps). Only what
    changed during the gap is applied."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("MEDIUM")]}}))
    laps(m, "81", 9)
    in_lap(m, "81", 10)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("HARD")}}}))
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"2": st("HARD")}}}))   # same bracket: stint 2
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {"Compound": "SOFT"}}}}))  # the newest
    want = [("MEDIUM", 1, 10), ("SOFT", 11, None)]
    assert [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy] == want
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("MEDIUM"), dict(st("HARD"), Compound="SOFT"),
                                                         st("HARD")]}}))
    assert [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy] == want


def test_a_tyre_change_rewritten_as_a_pass_is_withdrawn():
    """TyresNotChanged '0' -> '1' (12 times in the recorded feed): the set
    sent as new was a pit-lane pass on the one in use."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("MEDIUM")]}}))
    laps(m, "81", 9)
    in_lap(m, "81", 10)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("MEDIUM", total=10, start=10, new="false")}}}))
    assert len(m.tyre_strategy) == 2
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {"TyresNotChanged": "1"}}}}))
    assert [(s["StintNumber"], s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy] == [
        (1, "MEDIUM", 1, None)]


def test_a_pass_flag_on_another_compound_is_a_new_set():
    """Recorded 2025 R8 BOR: on SOFT, a stint flagged TyresNotChanged '1'
    turns out MEDIUM: another compound is another set (FastF1: a new stint)."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("SOFT")]}}))
    laps(m, "81", 34)
    in_lap(m, "81", 35)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("UNKNOWN", tnc="1", new="false")}}}))
    assert len(m.tyre_strategy) == 1
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": {"Compound": "MEDIUM"}}}}))
    assert [(s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy] == [
        ("SOFT", 1, 35), ("MEDIUM", 36, None)]


def test_a_stint_first_sent_late_starts_where_its_laps_began():
    """Recorded 2025 R6: the feed sends no stint before lap 24; stint 0 then
    arrives 23 laps old and starts on lap 1, not 24."""
    m = manager()
    laps(m, "81", 23)
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"0": st("HARD", total=23)}}}))
    assert [(s["Compound"], s["StartLap"]) for s in m.tyre_strategy] == [("HARD", 1)]


def test_tyres_fitted_after_the_flag_open_no_stint():
    """Recorded 2024 R14: four tyre changes after 'Finished' became stints
    'from lap 45' of a 44-lap race. A pass after the flag still names the
    compound of a set fitted UNKNOWN (2024 R23 COL / OCO)."""
    m = manager()
    send(m, "TimingAppData", lines(**{"81": {"Stints": [st("MEDIUM")]}, "16": {"Stints": [st("UNKNOWN")]}}))
    laps(m, "81", 44)
    send(m, "SessionStatus", {"Status": "Finished"})
    send(m, "TimingAppData", lines(**{"81": {"Stints": {"1": st("SOFT")}},
                                      "16": {"Stints": {"1": st("MEDIUM", tnc="1")}}}))
    assert [(s["Driver"], s["Compound"], s["StartLap"], s["EndLap"]) for s in m.tyre_strategy] == [
        ("PIA", "MEDIUM", 1, None), ("LEC", "MEDIUM", 1, None)]


# ---------------------------------------------------------------- B5

def test_pit_times_track_status_and_lap_times_on_the_session_clock():
    m = manager()
    send(m, "SessionStatus", {"Status": "Started"}, t=3350.494)
    send(m, "TrackStatus", {"Status": "1", "Message": "AllClear"}, t=792.826)
    send(m, "TimingData", lines(**{"81": {"NumberOfLaps": 1, "LastLapTime": {"Value": "1:28.000"}}}), t=3438.494)
    send(m, "TimingData", lines(**{"81": {"InPit": True}}), t=3500.0)            # pit entry, lap 2
    send(m, "TrackStatus", {"Status": "2", "Message": "Yellow"}, t=3510.0)
    send(m, "TimingData", lines(**{"81": {"NumberOfLaps": 2, "LastLapTime": {"Value": "1:30.000"}}}), t=3528.494)
    send(m, "TrackStatus", {"Status": "1", "Message": "AllClear"}, t=3540.0)
    send(m, "TimingData", lines(**{"81": {"InPit": False}}), t=3550.0)           # pit exit, lap 3
    send(m, "TimingData", lines(**{"81": {"NumberOfLaps": 3, "LastLapTime": {"Value": "1:45.000"}}}), t=3633.494)
    send(m, "TimingData", lines(**{"81": {"NumberOfLaps": 4, "LastLapTime": {"Value": "1:24.000"}}}), t=3717.494)
    got = [(r["LapNumber"], r["LapStartTime"], r["Time"], r["PitInTime"], r["PitOutTime"], r["TrackStatus"])
           for r in m.lap_times]
    assert got == [
        (1, 3350.494, 3438.494, None, None, "1"),       # lap 1 starts at 'Started'
        (2, 3438.494, 3528.494, 3500.0, None, "12"),    # in-lap
        (3, 3528.494, 3633.494, None, 3550.0, "21"),    # out-lap
        (4, 3633.494, 3717.494, None, None, "1"),
    ]
    assert all(r["PitInTimeSeconds"] == r["PitInTime"] and r["PitOutTimeSeconds"] == r["PitOutTime"]
               for r in m.lap_times)
    # track status in session seconds (it was epoch), closed on the next change
    assert [(p["status"], p["start_time"], p["end_time"]) for p in m.track_status] == [
        ("1", 792.826, 3510.0), ("2", 3510.0, 3540.0), ("1", 3540.0, None)]
    assert all(p["received_at"] > 1e9 for p in m.track_status)  # wall clock kept for display


def test_track_status_is_stamped_on_the_leaders_lap():
    m = manager()
    send(m, "TrackStatus", {"Status": "1"}, t=100.0)
    send(m, "LapCount", {"CurrentLap": 22, "TotalLaps": 56})
    send(m, "TrackStatus", {"Status": "6", "Message": "VSCDeployed"}, t=4900.0)
    send(m, "LapCount", {"CurrentLap": 23})
    send(m, "TrackStatus", {"Status": "4", "Message": "SCDeployed"}, t=5000.0)
    assert [(p["status"], p["start_lap"], p["end_lap"]) for p in m.track_status] == [
        ("1", 1, 22), ("6", 22, 23), ("4", 23, None)]


def test_pit_passages_before_the_race_start_belong_to_no_lap():
    """Leaving the garage for the grid is a pit exit before 'Started'; a
    pit-lane starter's exit after 'Started' is its lap-1 PitOutTime."""
    m = manager()
    send(m, "TimingData", lines(**{"16": {"InPit": True}, "81": {"InPit": True}}), t=1000.0)
    send(m, "TimingData", lines(**{"16": {"InPit": False}}), t=1500.0)   # LEC to the grid
    send(m, "SessionStatus", {"Status": "Started"}, t=3350.0)
    send(m, "TimingData", lines(**{"81": {"InPit": False}}), t=3365.0)   # PIA from the pit lane
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 1, "LastLapTime": {"Value": "1:28.000"}},
                                   "81": {"NumberOfLaps": 1, "LastLapTime": {"Value": "1:45.000"}}}), t=3460.0)
    assert {r["Driver"]: (r["PitInTime"], r["PitOutTime"]) for r in m.lap_times} == {
        "LEC": (None, None), "PIA": (None, 3365.0)}


def test_restart_after_a_red_flag_starts_the_first_pit_out_lap():
    """FastF1 (core.py): after 'Aborted' -> 'Started', a driver's first lap
    out of the pit lane without a lap time starts at the restart (recorded
    2024 R4: restart 5458.774 s = the replay's lap-2 LapStartTime)."""
    m = manager()
    send(m, "SessionStatus", {"Status": "Started"}, t=3760.422)
    send(m, "TrackStatus", {"Status": "1"}, t=130.211)
    send(m, "TimingData", lines(**{"16": {"InPit": True}}), t=3889.856)
    send(m, "TrackStatus", {"Status": "5", "Message": "Red"}, t=3803.324)
    send(m, "SessionStatus", {"Status": "Aborted"}, t=3802.84)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 1, "LastLapTime": {"Value": "2:10.735"}}}), t=3891.506)
    send(m, "TrackStatus", {"Status": "1"}, t=4889.956)
    send(m, "SessionStatus", {"Status": "Started"}, t=5458.774)
    send(m, "TimingData", lines(**{"16": {"InPit": False}}), t=5465.329)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 2}}), t=5602.63)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 3, "LastLapTime": {"Value": "1:40.000"}}}), t=5702.63)
    got = [(r["LapNumber"], r["LapStartTime"], r["TrackStatus"]) for r in m.lap_times]
    assert got == [(1, 3760.422, "15"), (2, 5458.774, "1"), (3, 5602.63, "1")]
    assert m.normalizer.race_start_time == 3760.422


def test_a_connect_during_a_red_flag_takes_the_next_start_for_the_restart():
    """Recorded 2024 R4: a connect at 4630.807 s, between 'Aborted'
    (3802.84) and the restart (5458.774). The snapshot carries 'Aborted';
    the restart was taken for the race start, restart_time stayed None and
    LEC's lap 2 started at the connect, under the red flag ('51'). Replay:
    5458.774, '1'."""
    m = manager()
    t = 4630.807
    send(m, "TimingData", lines(**{"16": {"RacingNumber": "16", "NumberOfLaps": 1, "InPit": True,
                                          "NumberOfPitStops": 1}}), t=t)
    send(m, "TrackStatus", {"Status": "5", "Message": "Red"}, t=t)
    send(m, "LapCount", {"CurrentLap": 2, "TotalLaps": 53}, t=t)
    send(m, "SessionStatus", {"Status": "Aborted"}, t=t)
    send(m, "TrackStatus", {"Status": "1", "Message": "AllClear"}, t=4889.956)
    send(m, "SessionStatus", {"Status": "Started"}, t=5458.774)
    send(m, "TimingData", lines(**{"16": {"InPit": False}}), t=5465.329)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 2}}), t=5602.63)
    assert (m.normalizer.race_start_time, m.normalizer.restart_time) == (None, 5458.774)
    lap2 = [(r["LapStartTime"], r["TrackStatus"]) for r in m.lap_times if r["LapNumber"] == 2]
    assert lap2 == [(5458.774, "1")]


def test_the_lap_through_the_red_flag_has_no_time_and_starts_at_the_restart():
    """Recorded 2024 R4 VER lap 2: the feed's LastLapTime is 28:31.131, the
    suspension included. FastF1 drops a lap time of 150 s or more (_api.py),
    so the replay's row has none and starts at the restart, green. Kept, the
    lap started 1711 s before its end, under the red flag, and the restart
    rule (no lap time) never fired: 42 rows of 2024 R4 / R8 / R21."""
    m = manager()
    send(m, "TrackStatus", {"Status": "1"}, t=130.211)
    send(m, "SessionStatus", {"Status": "Started"}, t=3760.422)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 1, "LastLapTime": {"Value": "2:11.235"}}}), t=3891.657)
    send(m, "TrackStatus", {"Status": "5", "Message": "Red"}, t=3900.0)
    send(m, "SessionStatus", {"Status": "Aborted"}, t=3900.5)
    send(m, "TimingData", lines(**{"16": {"InPit": True}}), t=3950.0)
    send(m, "TrackStatus", {"Status": "1"}, t=5400.0)
    send(m, "SessionStatus", {"Status": "Started"}, t=5458.774)
    send(m, "TimingData", lines(**{"16": {"InPit": False}}), t=5465.329)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 2, "LastLapTime": {"Value": "28:31.131"}}}), t=5602.788)
    send(m, "TimingData", lines(**{"16": {"NumberOfLaps": 3, "LastLapTime": {"Value": "1:37.212"}}}), t=5700.0)
    got = [(r["LapNumber"], r["LapTime"], r["LapStartTime"], r["TrackStatus"]) for r in m.lap_times]
    assert got == [(1, 131.235, 3760.422, "1"), (2, None, 5458.774, "1"), (3, 97.212, 5602.788, "1")]
    assert m.normalizer.driver_state["LEC"]["last_lap_time"] == 97.212


def test_live_clock_starts_at_the_first_message():
    n = LiveDataNormalizer()
    t0 = n.session_time()
    assert t0 == 0.0 and n.session_time() >= t0
    n.set_session_time(1234.5)
    assert n.session_time() == 1234.5
    n.set_session_time(None)
    assert n.session_time() < 1e6  # monotonic seconds since the first call, not epoch


# ---------------------------------------------------------------- B7

def test_race_control_snapshot_list_is_kept():
    """The first RaceControlMessages message (every message so far, on
    connect) is a list; it used to be dropped."""
    m = manager()
    send(m, "RaceControlMessages", {"Messages": [
        {"Utc": "2024-09-01T12:08:03", "Lap": 1, "Category": "Other",
         "Message": "BLUE HEAD PADDING MATERIAL MUST BE USED"},
        {"Utc": "2024-09-01T12:20:01", "Lap": 1, "Category": "Flag", "Flag": "GREEN", "Scope": "Track",
         "Message": "GREEN LIGHT - PIT EXIT OPEN"}]})
    send(m, "RaceControlMessages", {"Messages": {"2": {
        "Utc": "2024-09-01T13:03:34", "Lap": 1, "Category": "Flag", "Flag": "GREEN", "Message": "GREEN FLAG"}}})
    msgs = m.race_control_messages
    assert [x["message"] for x in msgs] == [
        "BLUE HEAD PADDING MATERIAL MUST BE USED", "GREEN LIGHT - PIT EXIT OPEN", "GREEN FLAG"]
    assert [x["flag"] for x in msgs] == ["", "GREEN", "GREEN"]
    # timestamp: the message's own Utc (epoch seconds), not the arrival time
    assert msgs[0]["timestamp"] == 1725192483.0 and msgs[0]["utc"] == "2024-09-01T12:08:03"
    assert all(math.isfinite(x["timestamp"]) for x in msgs)


PADDING = {"Utc": "2024-10-20T18:07:00", "Lap": 1, "Category": "Other",
           "Message": "PINK HEAD PADDING MATERIAL MUST BE USED"}
YELLOW = {"Utc": "2024-10-20T19:30:00", "Lap": 12, "Category": "Flag", "Flag": "YELLOW",
          "Message": "YELLOW IN TRACK SECTOR 4"}


def test_a_resubscription_adds_no_race_control_message_twice():
    """signalr_client re-subscribes after every dropped connection and
    /api/live/connect-signalr keeps the state by default: the snapshot list
    of every message so far comes again, and was appended again (recorded
    2024 R16, re-subscribed on lap 40: 96 messages kept for 59 sent)."""
    m = manager()
    q = m.subscribe()
    first = [PADDING, dict(PADDING), {"Utc": "2024-10-20T19:03:34", "Lap": 1, "Category": "Flag",
                                      "Flag": "GREEN", "Message": "GREEN FLAG"}]
    send(m, "RaceControlMessages", {"Messages": first})
    send(m, "RaceControlMessages", {"Messages": {"3": YELLOW}})
    send(m, "RaceControlMessages", {"Messages": first + [YELLOW]})  # re-subscription snapshot
    # recorded 2024 R19: indexes 0 and 1 are the same text at the same second, two messages
    assert [x["message"] for x in m.race_control_messages] == [
        PADDING["Message"], PADDING["Message"], "GREEN FLAG", YELLOW["Message"]]
    assert sum(1 for x in drain(q) if x["type"] == "race_control") == 4
    # the next session without a reset: index 0 again, but a new message
    send(m, "RaceControlMessages", {"Messages": [dict(PADDING, Utc="2024-10-27T19:08:01")]})
    assert len(m.race_control_messages) == 5


class _NoTranscriber:
    def submit(self, cap, on_done):
        pass


def test_a_resubscription_repeats_no_track_status_or_team_radio():
    """The snapshot also resends the track status in force (a new period of
    the same status) and every team-radio capture so far (appended and
    queued for transcription again)."""
    m = manager()
    m._radio_transcriber = _NoTranscriber()  # no speech model in tests
    send(m, "SessionInfo", {"Path": "2024/2024-10-20_United_States_Grand_Prix/2024-10-20_Race/"})
    send(m, "TrackStatus", {"Status": "1", "Message": "AllClear"}, t=100.0)
    send(m, "TrackStatus", {"Status": "4", "Message": "SCDeployed"}, t=200.0)
    send(m, "TrackStatus", {"Status": "4", "Message": "SCDeployed"}, t=900.0)  # re-subscription
    assert [(p["status"], p["start_time"], p["end_time"]) for p in m.track_status] == [
        ("1", 100.0, 200.0), ("4", 200.0, None)]
    send(m, "TrackStatus", {"Status": "1", "Message": "AllClear"}, t=950.0)
    assert [p["status"] for p in m.track_status] == ["1", "4", "1"]
    radio = {"Captures": [{"Utc": "2024-10-20T19:10:00", "RacingNumber": "81",
                           "Path": "TeamRadio/OSCPIA01_81_20241020_191000.mp3"}]}
    send(m, "TeamRadio", radio)
    send(m, "TeamRadio", radio)
    assert len(m.team_radios) == 1
