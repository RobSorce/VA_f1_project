"""build_tyre_strategy: one stint per tyre set from the FastF1 Stint column
(data/processors/stints.py). A Stint change opens a new stint only for a tyre
change (is_tyre_change): pit-lane passes that keep the set do not split."""
import glob
import json
import os

import pytest

from conftest import CACHE_DIR, load_cached_session
from data.processors.stints import (
    _group_by_driver, _has_pit_out, _number, build_tyre_strategy, is_tyre_change,
)


def lap(driver, n, stint, compound, pit_in=None, pit_out=None, tyre_life=None):
    return {
        'Driver': driver, 'LapNumber': float(n), 'Stint': stint, 'Compound': compound,
        'TyreLife': tyre_life,
        'PitInTimeSeconds': pit_in, 'PitInTime': pit_in,
        'PitOutTimeSeconds': pit_out, 'PitOutTime': pit_out,
    }


def summary(stints, driver):
    return [(s['Compound'], s['StartLap'], s['EndLap']) for s in stints if s['Driver'] == driver]


# ---------------------------------------------------------------- synthetic

def test_same_compound_stop_opens_a_new_stint():
    rows = [lap('AAA', n, 1.0, 'HARD') for n in range(1, 4)]
    rows[-1]['PitInTimeSeconds'] = rows[-1]['PitInTime'] = 300.0
    rows += [lap('AAA', 4, 2.0, 'HARD', pit_out=320.0), lap('AAA', 5, 2.0, 'HARD')]
    out = build_tyre_strategy(rows)
    assert out == [
        {'Driver': 'AAA', 'StintNumber': 1, 'Compound': 'HARD', 'StartLap': 1, 'EndLap': 3, 'TotalLaps': 3},
        {'Driver': 'AAA', 'StintNumber': 2, 'Compound': 'HARD', 'StartLap': 4, 'EndLap': 5, 'TotalLaps': 2},
    ]


def test_stint_column_wins_over_pit_flags():
    # a drive-through: pit-in / pit-out flags but the same tyre set (Stint unchanged)
    rows = [lap('AAA', 1, 1.0, 'SOFT'), lap('AAA', 2, 1.0, 'SOFT', pit_in=200.0),
            lap('AAA', 3, 1.0, 'SOFT', pit_out=210.0), lap('AAA', 4, 1.0, 'SOFT')]
    assert summary(build_tyre_strategy(rows), 'AAA') == [('SOFT', 1, 4)]


def test_stint_change_without_a_tyre_change_keeps_the_stint():
    # 2025 R1 under SC: the field is led through the pit lane on laps 2-4,
    # FastF1 Stint goes 1 -> 4 while the same INTERMEDIATE set keeps ageing
    rows = [lap('AAA', 1, 1.0, 'INTERMEDIATE', tyre_life=1.0),
            lap('AAA', 2, 1.0, 'INTERMEDIATE', pit_in=200.0, tyre_life=2.0),
            lap('AAA', 3, 2.0, 'INTERMEDIATE', pit_in=300.0, pit_out=210.0, tyre_life=3.0),
            lap('AAA', 4, 3.0, 'INTERMEDIATE', pit_in=400.0, pit_out=310.0, tyre_life=4.0),
            lap('AAA', 5, 4.0, 'INTERMEDIATE', pit_out=410.0, tyre_life=5.0),
            lap('AAA', 6, 4.0, 'INTERMEDIATE', tyre_life=6.0),
            lap('AAA', 7, 4.0, 'INTERMEDIATE', pit_in=700.0, tyre_life=7.0),
            lap('AAA', 8, 5.0, 'HARD', pit_out=710.0, tyre_life=1.0)]
    out = build_tyre_strategy(rows)
    assert summary(out, 'AAA') == [('INTERMEDIATE', 1, 7), ('HARD', 8, 8)]
    assert [s['StintNumber'] for s in out] == [1, 2]


def test_stint_change_on_the_same_compound_with_a_new_set_opens_a_stint():
    rows = [lap('AAA', 1, 1.0, 'HARD', tyre_life=10.0),
            lap('AAA', 2, 1.0, 'HARD', pit_in=1.0, tyre_life=11.0),
            lap('AAA', 3, 2.0, 'HARD', pit_out=2.0, tyre_life=1.0),
            lap('AAA', 4, 2.0, 'HARD', tyre_life=2.0)]
    assert summary(build_tyre_strategy(rows), 'AAA') == [('HARD', 1, 2), ('HARD', 3, 4)]


@pytest.mark.parametrize('before, after, change', [
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': 5.0}, False),
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': 6.0}, False),  # +2 continues
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': 7.0}, True),   # +3
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': 4.0}, True),   # +0
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': 1.0}, True),   # new set
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'MEDIUM', 'TyreLife': 5.0}, True),
    ({'Compound': 'SOFT', 'TyreLife': None}, {'Compound': 'SOFT', 'TyreLife': 5.0}, True),
    ({'Compound': 'SOFT', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': float('nan')}, True),
    ({'Compound': 'nan', 'TyreLife': 4.0}, {'Compound': 'UNKNOWN', 'TyreLife': 5.0}, False),
    ({'Compound': 'nan', 'TyreLife': 4.0}, {'Compound': 'SOFT', 'TyreLife': 5.0}, True),
    ({'Compound': 'soft', 'TyreLife': '4'}, {'Compound': 'SOFT', 'TyreLife': 5}, False),
])
def test_is_tyre_change(before, after, change):
    assert is_tyre_change(before, after) is change


def test_null_rows_split_on_pit_out_with_a_tyre_change_or_compound_change():
    rows = [lap('AAA', 1, None, 'MEDIUM'), lap('AAA', 2, None, 'MEDIUM'),
            lap('AAA', 3, None, 'MEDIUM', pit_out=250.0), lap('AAA', 4, None, None),
            lap('AAA', 5, None, 'HARD'), lap('AAA', 6, None, 'HARD')]
    # lap 3 is an out-lap with no TyreLife on either side (= a tyre change):
    # new stint; lap 5 changes compound: new stint
    assert summary(build_tyre_strategy(rows), 'AAA') == [
        ('MEDIUM', 1, 2), ('MEDIUM', 3, 4), ('HARD', 5, 6)]


def test_null_stint_pit_out_without_a_tyre_change_does_not_split():
    rows = [lap('AAA', 1, None, 'SOFT', tyre_life=1.0),
            lap('AAA', 2, None, 'SOFT', pit_in=1.0, tyre_life=2.0),
            lap('AAA', 3, None, 'SOFT', pit_out=2.0, tyre_life=3.0),
            lap('AAA', 4, None, 'SOFT', tyre_life=4.0)]
    assert summary(build_tyre_strategy(rows), 'AAA') == [('SOFT', 1, 4)]


def test_null_rows_adopt_the_next_stint_value():
    # first laps without Stint/Compound (2025 R6), then the column appears
    rows = [lap('AAA', n, None, None) for n in range(1, 4)]
    rows += [lap('AAA', 4, 1.0, 'MEDIUM'), lap('AAA', 5, 1.0, 'MEDIUM'),
             lap('AAA', 6, 2.0, 'HARD', pit_out=600.0)]
    out = build_tyre_strategy(rows)
    assert summary(out, 'AAA') == [('MEDIUM', 1, 5), ('HARD', 6, 6)]
    assert [s['StintNumber'] for s in out] == [1, 2]


def test_unknown_compounds_and_dominant_compound():
    rows = [lap('AAA', 1, 1.0, 'nan'), lap('AAA', 2, 1.0, 'UNKNOWN'), lap('AAA', 3, 1.0, None)]
    rows += [lap('BBB', 1, 1.0, 'SOFT'), lap('BBB', 2, 1.0, 'MEDIUM'), lap('BBB', 3, 1.0, 'MEDIUM')]
    out = build_tyre_strategy(rows)
    assert summary(out, 'AAA') == [('UNKNOWN', 1, 3)]
    assert summary(out, 'BBB') == [('MEDIUM', 1, 3)]


def test_nan_and_zero_pit_times_are_not_pit_outs():
    assert not _has_pit_out({'PitOutTimeSeconds': float('nan'), 'PitOutTime': None})
    assert not _has_pit_out({'PitOutTimeSeconds': 0, 'PitOutTime': ''})
    assert _has_pit_out({'PitOutTimeSeconds': None, 'PitOutTime': 4733.923})


def test_driver_order_then_first_appearance_and_unsorted_rows():
    rows = [lap('BBB', 2, 1.0, 'SOFT'), lap('AAA', 1, 1.0, 'SOFT'), lap('BBB', 1, 1.0, 'SOFT'),
            lap('CCC', 1, 1.0, 'HARD'), {'Driver': None, 'LapNumber': 1.0}, {'Driver': 'DDD'}]
    assert [s['Driver'] for s in build_tyre_strategy(rows)] == ['BBB', 'AAA', 'CCC']
    assert [s['Driver'] for s in build_tyre_strategy(rows, driver_order=['CCC', 'ZZZ', 'AAA'])] == \
        ['CCC', 'AAA', 'BBB']
    assert summary(build_tyre_strategy(rows), 'BBB') == [('SOFT', 1, 2)]


def test_empty_input():
    assert build_tyre_strategy([]) == []
    assert build_tyre_strategy(None) == []


# ---------------------------------------------------------------- cached races

def test_monza_2024_acceptance():
    s = load_cached_session(2024, 16)
    out = build_tyre_strategy(s['lap_times'])
    assert len(out) == 50
    assert summary(out, 'PIA') == [('MEDIUM', 1, 16), ('HARD', 17, 38), ('HARD', 39, 53)]
    assert summary(out, 'NOR') == [('MEDIUM', 1, 14), ('HARD', 15, 32), ('HARD', 33, 53)]
    assert summary(out, 'HAM') == [('MEDIUM', 1, 15), ('HARD', 16, 37), ('HARD', 38, 53)]
    assert summary(out, 'LEC') == [('MEDIUM', 1, 15), ('HARD', 16, 53)]
    for s_ in out:
        assert s_['TotalLaps'] == s_['EndLap'] - s_['StartLap'] + 1


def test_australia_2025_sc_pit_lane_passes_do_not_split():
    """2025 R1: NOR's laps 2-4 pass through the pit lane under SC (Stint 1 -> 4,
    same INTERMEDIATE set, TyreLife 2 -> 5): three stints, not six."""
    s = load_cached_session(2025, 1)
    out = build_tyre_strategy(s['lap_times'])
    assert summary(out, 'NOR') == [('INTERMEDIATE', 1, 34), ('HARD', 35, 44), ('INTERMEDIATE', 45, 57)]
    nor = sorted((lt for lt in s['lap_times'] if lt['Driver'] == 'NOR'), key=lambda lt: lt['LapNumber'])
    assert [lt['Stint'] for lt in nor[:5]] == [1.0, 1.0, 2.0, 3.0, 4.0]
    assert all(_has_pit_out(lt) for lt in nor[2:5])


def test_drive_through_does_not_split_2025_r8_rus():
    """RUS in 2025 R8: pit-in on lap 62, pit-out on lap 63, Stint unchanged."""
    s = load_cached_session(2025, 8)
    out = build_tyre_strategy(s['lap_times'])
    assert summary(out, 'RUS') == [('HARD', 1, 53), ('MEDIUM', 54, 68), ('HARD', 69, 76)]


CACHED_SESSIONS = sorted(glob.glob(os.path.join(str(CACHE_DIR), 'session_*_*_*.json')))


@pytest.mark.skipif(not CACHED_SESSIONS, reason='processed cache missing')
@pytest.mark.parametrize('path', CACHED_SESSIONS, ids=os.path.basename)
def test_every_cached_session_has_one_stint_per_tyre_set(path):
    """Every stint boundary is a tyre change of the data (is_tyre_change on the
    two rows around it), no Stint change inside a stint is one, and the stints
    are numbered 1..k, contiguous and non-overlapping, covering every row."""
    with open(path, encoding='utf-8') as fh:
        laps = json.load(fh)['lap_times']
    out = build_tyre_strategy(laps)
    for drv, rows in _group_by_driver(laps).items():
        stints = [s for s in out if s['Driver'] == drv]
        assert [s['StintNumber'] for s in stints] == list(range(1, len(stints) + 1))
        assert stints[0]['StartLap'] == int(_number(rows[0]['LapNumber']))
        assert stints[-1]['EndLap'] == int(_number(rows[-1]['LapNumber']))
        for a, b in zip(stints, stints[1:]):
            assert a['EndLap'] < b['StartLap']
        starts = {s['StartLap'] for s in stints[1:]}
        for prev, row in zip(rows, rows[1:]):
            n = int(_number(row['LapNumber']))
            s_prev, s_row = _number(prev.get('Stint')), _number(row.get('Stint'))
            if n in starts:
                assert is_tyre_change(prev, row), (drv, n)
            elif s_prev is not None and s_row is not None and s_prev != s_row:
                assert not is_tyre_change(prev, row), (drv, n)
