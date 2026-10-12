"""Track-status periods placed on the race LEADER's lap through the lap windows
[LapStartTime, Time] (data/processors/stints.py map_track_status_to_laps), and
its two users: the replay events (api/routers/replay.py) and the mock live
replay (live/mock_replay.py). The reference is the leader's (Position 1) lap
TrackStatus and FIA race control, never the lowest lap of any car."""
import asyncio
import glob
import json
import os
from types import SimpleNamespace

import pandas as pd
import pytest

from conftest import CACHE_DIR, load_cached_session
from data.processors.stints import (
    build_tyre_strategy, lap_at_session_time, lap_windows, leader_lap_times,
    map_track_status_to_laps,
)


def leader_rows(laps):
    """{lap: the row classified P1 on that lap}."""
    return {int(lt['LapNumber']): lt for lt in laps if lt.get('Position') == 1}


def leader_laps_with(laps, code):
    """Laps whose LEADER (Position 1) TrackStatus carries the code."""
    return {n for n, lt in leader_rows(laps).items() if code in str(lt.get('TrackStatus') or '')}


def mapped_laps(mapped, code):
    out = set()
    for p in mapped:
        if str(p['status']) == code:
            out |= set(range(p['start_lap'], p['end_lap'] + 1))
    return out


# Known differences with the Position-1 TrackStatus, each explained by the data:
#  - 2024 R21, VSC ending ('7') on lap 29: when the VSC ends (6721.7 s) RUS,
#    leading on the road, has just started lap 29 (6720.6 s), but the row
#    classified P1 on lap 29 is OCO's, which starts at 6729.7 s, after the end.
#  - 2024 R8 (Monaco), SC ('4') on lap 1: at the red-flag restart the lap-1 rows
#    end at 5762.3 s but the lap-2 rows start at 5754.7 s; the SC (5756.6 s) is
#    on the leader's lap 2, while the lap-1 row's TrackStatus also carries it.
KNOWN_DIFFERENCES = {
    ('session_2024_21_R.json', '7'): {29},
    ('session_2024_8_R.json', '4'): {1},
}

CODES = ('2', '4', '5', '6', '7')


# ---------------------------------------------------------------- synthetic

def rows_two_cars():
    # leader A: laps of 100 s from t=1000; B one lap behind from lap 3 on
    rows = []
    for n in range(1, 6):
        rows.append({'Driver': 'A', 'LapNumber': n, 'LapStartTime': 1000 + 100 * (n - 1),
                     'Time': 1000 + 100 * n, 'LapTimeSeconds': 100.0, 'Position': 1})
    for n in range(1, 5):
        start = 1000 + 125 * (n - 1)
        rows.append({'Driver': 'B', 'LapNumber': n, 'LapStartTime': start,
                     'Time': start + 125, 'LapTimeSeconds': 125.0, 'Position': 2})
    return rows


def test_lap_at_session_time_is_the_leader_lap():
    w = lap_windows(rows_two_cars())
    # t = 1310: A (leader) is on lap 4 (1300-1400), B on lap 3 (1250-1375)
    assert lap_at_session_time(w, 1310) == 4
    assert lap_at_session_time(w, 1000) == 1
    assert lap_at_session_time(w, 999) is None
    # a gap in the rows: the highest lap already started
    gap = [(1, 0.0, 10.0), (3, 20.0, 30.0)]
    assert lap_at_session_time(gap, 15.0) == 1


def test_missing_lap_start_falls_back_to_time_minus_lap_time():
    rows = [{'LapNumber': 1, 'LapStartTime': None, 'Time': 1100.0, 'LapTimeSeconds': 100.0},
            {'LapNumber': 2, 'LapStartTime': 1100.0, 'Time': 1200.0, 'LapTimeSeconds': 100.0}]
    assert lap_windows(rows) == [(1, 1000.0, 1100.0), (2, 1100.0, 1200.0)]


def test_start_and_end_go_to_the_leader_lap_and_outside_periods_are_dropped():
    rows = rows_two_cars()
    ts = [
        {'status': '2', 'start_time': 0.0, 'end_time': 500.0, 'message': 'Yellow'},       # grid
        {'status': '1', 'start_time': 500.0, 'end_time': 1310.0, 'message': 'AllClear'},  # spans the start
        {'status': '4', 'start_time': 1310.0, 'end_time': 1420.0, 'message': 'SCDeployed'},
        {'status': '1', 'start_time': 1420.0, 'end_time': 1600.0, 'message': 'AllClear'},
        {'status': '2', 'start_time': 1600.0, 'end_time': None, 'message': 'Yellow'},     # after the flag
    ]
    out = map_track_status_to_laps(ts, rows)
    # SC from 1310 (leader on lap 4; B, a lap down, on its lap 3) to 1420 (leader on lap 5)
    assert [(p['status'], p['start_lap'], p['end_lap']) for p in out] == [
        ('1', 1, 4), ('4', 4, 5), ('1', 5, 5)]
    assert out[1]['message'] == 'SCDeployed' and out[1]['start_time'] == 1310.0
    assert map_track_status_to_laps(ts, []) == []


def test_period_without_end_lasts_to_the_last_lap():
    out = map_track_status_to_laps(
        [{'status': '4', 'start_time': 1150.0, 'end_time': None, 'message': 'SCDeployed'}],
        rows_two_cars())
    assert (out[0]['start_lap'], out[0]['end_lap']) == (2, 5)


def test_leader_lap_times_follow_the_position_1_row():
    rows = rows_two_cars()
    # a retiring car's truncated lap 2 ends first but has no Position
    rows.append({'Driver': 'C', 'LapNumber': 2, 'LapStartTime': 1100, 'Time': 1150,
                 'LapTimeSeconds': 50.0, 'Position': None})
    t = leader_lap_times(rows)
    assert t[1] == (1000, 1100)
    assert t[2] == (1100, 1200)       # A's lap 2, not C's 1150
    assert t[5] == (1400, 1500)
    # no Position at all: the earliest Time of the lap
    bare = [{**r, 'Position': None} for r in rows_two_cars()]
    assert leader_lap_times(bare)[3] == (1200, 1300)
    assert leader_lap_times([]) == {}


# ---------------------------------------------------------------- cached races

def test_china_2024_vsc_and_sc_on_the_race_control_laps():
    """FIA race control, 2024 R5: VSC deployed on lap 22, SC deployed on laps
    23 and 27; leader TrackStatus: '6' on laps 22-23, '4' on laps 23-31."""
    s = load_cached_session(2024, 5)
    laps = s['lap_times']
    out = map_track_status_to_laps(s['track_status'], laps)
    sc = [p for p in out if p['status'] == '4']
    vsc = [p for p in out if p['status'] in ('6', '7')]
    assert [p['start_lap'] for p in vsc] == [22]
    assert [p['start_lap'] for p in sc] == [23, 27]
    assert [(p['start_lap'], p['end_lap']) for p in vsc] == [(22, 23)]
    assert [(p['start_lap'], p['end_lap']) for p in sc] == [(23, 26), (27, 31)]
    assert leader_laps_with(laps, '6') == {22, 23} == mapped_laps(out, '6')
    assert leader_laps_with(laps, '4') == set(range(23, 32)) == mapped_laps(out, '4')
    # the any-driver minimum puts the VSC one lap early (a lapped car's lap 21)
    assert min(int(lt['LapNumber']) for lt in laps if '6' in str(lt.get('TrackStatus'))) == 21
    # the pre-race yellow (session time 0-224 s) is not a race event
    assert all(p['start_time'] > 0 for p in out)


CACHED_RACES = sorted(glob.glob(os.path.join(str(CACHE_DIR), 'session_*_*_R.json')))


@pytest.mark.skipif(not CACHED_RACES, reason='processed cache missing')
@pytest.mark.parametrize('path', CACHED_RACES, ids=os.path.basename)
def test_mapped_periods_span_the_leader_track_status_laps(path):
    """For every status code, the laps covered by the mapped periods are the
    laps whose LEADER (Position 1) TrackStatus carries the code, except the
    known differences listed above."""
    with open(path, encoding='utf-8') as fh:
        s = json.load(fh)
    out = map_track_status_to_laps(s['track_status'], s['lap_times'])
    name = os.path.basename(path)
    for code in CODES:
        got, want = mapped_laps(out, code), leader_laps_with(s['lap_times'], code)
        assert got ^ want == KNOWN_DIFFERENCES.get((name, code), set()), code


# ---------------------------------------------------------------- replay events

def fake_session(laps_json):
    """A raw-session stand-in: .laps as FastF1 has it (timedeltas)."""
    df = pd.DataFrame(laps_json)
    for col in ('LapStartTime', 'Time', 'LapTime'):
        df[col] = pd.to_timedelta(df[col], unit='s')
    return SimpleNamespace(laps=df)


def test_replay_events_china_2024():
    from api.routers.replay import _build_events

    s = load_cached_session(2024, 5)
    session = fake_session(s['lap_times'])
    extractor = SimpleNamespace(extract_track_status=lambda _session: s['track_status'])
    events = _build_events(extractor, session, 56)

    sc = [e for e in events if e['type'] == 'SAFETY_CAR']
    vsc = [e for e in events if e['type'] == 'VSC']
    assert [(e['startLap'], e['endLap']) for e in sc] == [(23, 26), (27, 31)]
    assert [(e['startLap'], e['endLap']) for e in vsc] == [(22, 23)]
    # the old avg-lap mapping put the pre-race yellow on lap 1; it is gone now
    yellows = [e for e in events if e['type'] == 'YELLOW_FLAG']
    assert all(e.get('lap', e.get('startLap')) >= 20 for e in yellows)
    assert events[0] == {'type': 'GREEN_FLAG', 'lap': 1, 'description': 'Race start'}
    assert events[-1]['type'] == 'CHEQUERED_FLAG' and events[-1]['lap'] == 56


# ---------------------------------------------------------------- mock replay

class RecordingManager:
    """LiveSessionManager stand-in that records every message with the current lap."""

    def __init__(self):
        self.session_info = {}
        self.lap = 0
        self.messages = []

    def reset(self):
        self.messages = []

    async def on_message(self, topic, data):
        if topic == 'LapCount':
            self.lap = data['CurrentLap']
        self.messages.append((self.lap, topic, data))


def run_mock_replay(session_data, speed=1e9, sleeps=None, monkeypatch=None):
    """Run the mock replay loop to the end. With `sleeps` (a list) and
    monkeypatch, asyncio.sleep in the mock is replaced by a recorder that
    appends ('sleep', seconds) to the message log and returns at once."""
    from live import mock_replay
    from live.mock_replay import MockReplay

    manager = RecordingManager()
    if sleeps is not None:
        async def fake_sleep(seconds):
            sleeps.append(seconds)
            manager.messages.append((manager.lap, 'sleep', seconds))
        monkeypatch.setattr(mock_replay.asyncio, 'sleep', fake_sleep)
    mock = MockReplay(manager)
    mock._running = True
    asyncio.run(mock._replay_loop(session_data, None, speed, 0, 0))
    return manager.messages


def statuses_seen_per_lap(msgs):
    """{LapCount: statuses in force at some point of that lap}: the one in force
    when the lap starts plus every TrackStatus message received during it."""
    seen, cur, lap = {}, '1', None
    for n, topic, data in msgs:
        if topic == 'LapCount':
            lap = n
            seen.setdefault(lap, set()).add(cur)
        elif topic == 'TrackStatus':
            cur = data['Status']
            if lap is not None:
                seen.setdefault(lap, set()).add(cur)
    return seen


def test_mock_replay_sends_track_status_on_the_race_control_laps():
    s = load_cached_session(2024, 5)
    msgs = run_mock_replay(s)
    status = [(lap, d['Status']) for lap, topic, d in msgs if topic == 'TrackStatus']
    assert [lap for lap, code in status if code == '6'] == [22]   # VSC deployed lap 22
    assert [lap for lap, code in status if code == '4'] == [23, 27]  # SC deployed laps 23, 27
    assert status[0] == (1, '1')  # the green at the start, not the grid yellow
    seen = statuses_seen_per_lap(msgs)
    for code in CODES:
        shown = {lap for lap, codes in seen.items() if code in codes}
        assert shown == leader_laps_with(s['lap_times'], code), code


@pytest.mark.skipif(not CACHED_RACES, reason='processed cache missing')
@pytest.mark.parametrize('path', CACHED_RACES, ids=os.path.basename)
def test_mock_replay_shows_each_status_on_the_leader_track_status_laps(path):
    """A status is in force at some point of LapCount L exactly on the laps whose
    leader TrackStatus carries it (2024 R11/R21/R3: a VSC deployed and ended
    inside one lap is still shown on that lap)."""
    with open(path, encoding='utf-8') as fh:
        s = json.load(fh)
    seen = statuses_seen_per_lap(run_mock_replay(s))
    name = os.path.basename(path)
    for code in CODES:
        shown = {lap for lap, codes in seen.items() if code in codes}
        want = leader_laps_with(s['lap_times'], code)
        assert shown ^ want == KNOWN_DIFFERENCES.get((name, code), set()), code


def test_mock_replay_spreads_status_changes_over_the_lap_in_session_time_order(monkeypatch):
    """Within one lap the changes arrive in session-time order, each after the
    share of the lap's playback time that precedes it, so a status deployed and
    ended inside one lap is in force for a positive time."""
    rows = []
    for drv, pos, offset in (('AAA', 1, 0.0), ('BBB', 2, 1.0)):
        for n in range(1, 4):
            start = 1000.0 + 100.0 * (n - 1) + (offset if n > 1 else 0.0)
            rows.append({'Driver': drv, 'DriverNumber': str(pos), 'LapNumber': float(n),
                         'LapStartTime': start, 'Time': 1100.0 + 100.0 * (n - 1) + offset,
                         'LapTimeSeconds': 100.0, 'Position': float(pos), 'Stint': 1.0,
                         'Compound': 'MEDIUM', 'TyreLife': float(n)})
    session = {
        'driver_info': [{'DriverNumber': '1', 'Abbreviation': 'AAA'},
                        {'DriverNumber': '2', 'Abbreviation': 'BBB'}],
        'lap_times': rows,
        # listed out of order on purpose; VSC deployed and ended inside lap 2 (1100-1200)
        'track_status': [
            {'status': '1', 'start_time': 1160.0, 'end_time': None, 'message': 'AllClear'},
            {'status': '6', 'start_time': 1120.0, 'end_time': 1150.0, 'message': 'VSCDeployed'},
            {'status': '7', 'start_time': 1150.0, 'end_time': 1160.0, 'message': 'VSCEnding'},
            {'status': '1', 'start_time': 900.0, 'end_time': 1120.0, 'message': 'AllClear'},
        ],
        'weather_data': [],
    }
    sleeps = []
    msgs = run_mock_replay(session, speed=10.0, sleeps=sleeps, monkeypatch=monkeypatch)
    lap2 = [(topic, d) for lap, topic, d in msgs if lap == 2 and topic in ('TrackStatus', 'sleep')]
    assert [d['Status'] for topic, d in lap2 if topic == 'TrackStatus'] == ['6', '7', '1']
    delay = 100.0 / 10.0  # average lap time / speed
    # 6 at 20 % of the lap, 7 at 50 %, 1 at 60 %, then the rest of the lap
    waits = [d for topic, d in lap2 if topic == 'sleep']
    assert waits == pytest.approx([0.2 * delay, 0.3 * delay, 0.1 * delay, 0.4 * delay])
    assert sum(waits) == pytest.approx(delay)


def test_mock_replay_weather_is_the_reading_in_force_at_the_leader_lap_start():
    s = load_cached_session(2024, 5)
    msgs = run_mock_replay(s)
    weather = s['weather_data']
    starts = leader_lap_times(s['lap_times'])

    def in_force(t):
        return max((w for w in weather if w['Time'] <= t), key=lambda w: w['Time'])

    def as_sent(w):
        return str(w['AirTemp']), str(w['TrackTemp']), str(w['Humidity'])

    sent = [(lap, (d['AirTemp'], d['TrackTemp'], d['Humidity'])) for lap, topic, d in msgs
            if topic == 'WeatherData']
    # first reading: the one in force at the race start, not the session's first row
    assert sent[0] == (0, as_sent(in_force(starts[1][0])))
    by_lap = dict(sent[1:])
    assert sorted(by_lap) == [n for n in range(5, 57, 5)]
    for lap, values in by_lap.items():
        assert values == as_sent(in_force(starts[lap][0])), lap
    # 2024 R5 lap 5: the leader starts it at 3721.1 s; the reading in force was
    # taken at 3708.3 s (the old index ratio sent the row of 888 s)
    assert in_force(starts[5][0])['Time'] == pytest.approx(3708.259)


def test_mock_replay_sends_one_stint_per_tyre_set():
    s = load_cached_session(2024, 16)
    msgs = run_mock_replay(s)
    stint_msgs = [(lap, line) for lap, topic, d in msgs if topic == 'TimingData'
                  for line in d['Lines'].values() if 'Stints' in line]
    assert len(stint_msgs) == len(build_tyre_strategy(s['lap_times'])) == 50
    pia = next(str(d['DriverNumber']) for d in s['driver_info'] if d['Abbreviation'] == 'PIA')
    pia_stints = [(lap, idx, v['Compound']) for lap, topic, d in msgs if topic == 'TimingData'
                  for num, line in d['Lines'].items() if num == pia and 'Stints' in line
                  for idx, v in line['Stints'].items()]
    assert pia_stints == [(1, '0', 'MEDIUM'), (17, '1', 'HARD'), (39, '2', 'HARD')]
