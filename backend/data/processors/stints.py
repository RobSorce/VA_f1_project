"""
Pure processors over the JSON lap rows of a session payload.

Input rows are dicts shaped like ``session_*.json['lap_times']`` (or records
built from a FastF1 laps DataFrame): Driver, LapNumber, Stint, Compound,
PitOutTime(Seconds), PitInTime(Seconds), LapStartTime, Time, LapTimeSeconds.
Every time is in SESSION seconds. No FastF1, pandas or numpy here, so cached
payloads written by older code can be rebuilt at load time.

- build_tyre_strategy: tyre stints (one per tyre set) from the FastF1
  ``Stint`` column. The old extractor split stints only on compound changes,
  so two back-to-back stints on the same compound were merged (Monza 2024: 40
  stints instead of 50, PIA HARD 17-53 instead of 17-38 + 39-53). ``Stint``
  also increments on pit-lane passes without a tyre change (field led through
  the pit lane under SC / red flag, drive-through), so a Stint change opens a
  new stint only for a tyre change (is_tyre_change; 2025 R1 NOR: INTERMEDIATE
  1-34, HARD 35-44, INTERMEDIATE 45-57). Identical rule and output to
  deriveStints in frontend/src/utils/stints.js at sessionNow = Infinity
  (parity test over every cached session).
- map_track_status_to_laps: the lap range of each track-status period, on the
  race leader's lap (the highest lap whose window [LapStartTime, Time]
  contains the time), for its start and its end. The old code divided the
  session time by the average lap time, ignoring that the race starts ~3300 s
  into the session: 39 average laps late at Monza 2024, and on 2024 R5 (China)
  the VSC / first SC landed on laps 51 / 53 instead of 22 / 23, the laps of
  FIA race control. Same rule as mapTrackStatusToLaps in
  frontend/src/utils/raceTime.js.
- leader_lap_times: the session time at which the race leader started and
  finished each lap (the lap-mode clock of resolveSessionNow in raceTime.js).
"""
import math

# FastF1 placeholders for a missing compound (the cache also holds the string 'nan')
_UNKNOWN_COMPOUNDS = {'', 'UNKNOWN', 'TEST_UNKNOWN', 'NAN', 'NONE', 'NULL'}


def _number(value):
    """Finite float from a number, numeric string or timedelta; None otherwise
    (None, NaN, NaT, inf, empty or non-numeric string)."""
    if value is None or isinstance(value, bool):
        return None
    if hasattr(value, 'total_seconds'):
        value = value.total_seconds()  # NaT gives NaN, rejected below
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _is_set(value):
    """True for a pit timestamp that is present: None, NaN, NaT, 0 and '' are unset."""
    if value is None or isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        return value != ''
    n = _number(value)
    return n is not None and n != 0


def _has_pit_out(lap):
    """True when the row is an out-lap (PitOutTimeSeconds or PitOutTime set)."""
    return _is_set(lap.get('PitOutTimeSeconds')) or _is_set(lap.get('PitOutTime'))


def _known_compound(compound):
    """Upper-case compound name, or None for a FastF1 'unknown' placeholder."""
    if compound is None:
        return None
    s = str(compound).strip().upper()
    return None if s in _UNKNOWN_COMPOUNDS else s


def _dominant_compound(compounds):
    """Most common known compound; ties go to the one seen first. 'UNKNOWN' when none."""
    counts = {}
    for c in compounds:
        if c:
            counts[c] = counts.get(c, 0) + 1
    best, best_count = None, 0
    for c, n in counts.items():
        if n > best_count:
            best, best_count = c, n
    return best or 'UNKNOWN'


def _group_by_driver(lap_rows):
    """{driver: rows sorted by LapNumber}, in order of first appearance.
    One row per (driver, lap): the last one wins."""
    by_driver = {}
    for lap in lap_rows or []:
        if not isinstance(lap, dict) or not lap.get('Driver'):
            continue
        n = _number(lap.get('LapNumber'))
        if n is None:
            continue
        by_driver.setdefault(lap['Driver'], {})[n] = lap
    return {drv: [laps[n] for n in sorted(laps)] for drv, laps in by_driver.items()}


def is_tyre_change(prev, lap):
    """Tyre-change test between two consecutive lap rows of one driver.

    True when the compound differs from the previous lap's compound, or
    TyreLife does not continue (continues = same compound AND
    1 <= TyreLife(lap) - TyreLife(prev) <= 2), or TyreLife is missing on
    either side. Unknown compounds compare as equal to each other and
    different from a known one. Same test as isTyreChange in
    frontend/src/utils/stints.js.
    """
    before = _number((prev or {}).get('TyreLife'))
    after = _number((lap or {}).get('TyreLife'))
    if before is None or after is None:
        return True
    if _known_compound((prev or {}).get('Compound')) != _known_compound((lap or {}).get('Compound')):
        return True
    d = after - before
    return d < 1 or d > 2


def _split_driver_stints(laps):
    """Split one driver's laps (sorted by LapNumber) into stints.

    - A change of the FastF1 Stint value (both values present) opens a new
      stint only for a tyre change (is_tyre_change); otherwise the same set is
      kept and the rows stay in the current stint (SC pit-lane pass,
      drive-through: RUS in 2025 R8 laps 62/63 does not split).
    - Rows with Stint null (on the row or on the stint so far) open a new
      stint on a pit-out with a tyre change, or on a compound change against
      the stint's last known compound; otherwise they extend the current
      stint, which adopts the first Stint value that follows (2025 R6: the
      first ~23 laps of every driver lack Stint and Compound).
    Every decision uses only the row and the rows before it.
    """
    stints = []
    cur = None
    prev = None
    for lap in laps:
        s = _number(lap.get('Stint'))
        comp = _known_compound(lap.get('Compound'))
        compound_changed = (comp is not None and cur is not None
                            and cur['last_compound'] is not None
                            and comp != cur['last_compound'])
        if cur is None:
            opens = True
        elif s is not None and cur['stint'] == s:
            opens = False
        elif s is not None and cur['stint'] is not None:
            opens = is_tyre_change(prev, lap)
        else:
            opens = (_has_pit_out(lap) and is_tyre_change(prev, lap)) or compound_changed
        if opens:
            cur = {'stint': s, 'laps': [lap], 'last_compound': comp}
            stints.append(cur)
        else:
            if s is not None:
                cur['stint'] = s
            cur['laps'].append(lap)
        if comp is not None:
            cur['last_compound'] = comp
        prev = lap
    return stints


def build_tyre_strategy(lap_rows, driver_order=None):
    """Tyre stints of every driver from the FastF1 Stint column of the lap rows.

    Output rows keep the tyre_strategy shape:
      {Driver, StintNumber, Compound, StartLap, EndLap, TotalLaps}
    StintNumber is the stint's 1-based index for the driver (FastF1 numbering
    can restart when early rows lack the column). Compound is the most common
    known compound of the stint's laps ('UNKNOWN' when none). StartLap / EndLap
    are the first / last lap of the stint and TotalLaps = EndLap - StartLap + 1.

    Args:
        lap_rows: list of lap dicts (session payload ``lap_times``).
        driver_order: optional driver codes listed first, in this order (e.g.
            the classification order of the previous payload); the other
            drivers follow in order of first appearance in ``lap_rows``.

    Returns:
        list of stint dicts, grouped by driver, each driver's stints in order.
    """
    grouped = _group_by_driver(lap_rows)
    order = []
    for drv in list(driver_order or []) + list(grouped):
        if drv in grouped and drv not in order:
            order.append(drv)
    out = []
    for drv in order:
        for i, st in enumerate(_split_driver_stints(grouped[drv])):
            start_lap = int(_number(st['laps'][0].get('LapNumber')))
            end_lap = int(_number(st['laps'][-1].get('LapNumber')))
            out.append({
                'Driver': drv,
                'StintNumber': i + 1,
                'Compound': _dominant_compound(_known_compound(lap.get('Compound')) for lap in st['laps']),
                'StartLap': start_lap,
                'EndLap': end_lap,
                'TotalLaps': end_lap - start_lap + 1,
            })
    return out


# ---------------------------------------------------------------------------
# Track-status periods -> laps
# ---------------------------------------------------------------------------

def lap_windows(lap_rows):
    """(lap_number, start_s, end_s) for every lap row with a usable window.

    start = LapStartTime when > 0, else Time - LapTimeSeconds (rows missing
    LapStartTime); end = Time (session seconds at the end of the lap).
    """
    out = []
    for lap in lap_rows or []:
        if not isinstance(lap, dict):
            continue
        n = _number(lap.get('LapNumber'))
        end = _number(lap.get('Time'))
        start = _number(lap.get('LapStartTime'))
        if start is None or start <= 0:
            duration = _number(lap.get('LapTimeSeconds'))
            start = end - duration if end is not None and duration is not None and duration > 0 else None
        if n is None or start is None or end is None or end < start:
            continue
        out.append((int(n), start, end))
    return out


def lap_at_session_time(windows, t):
    """The lap the race LEADER is on at session time ``t`` (seconds), from
    ``lap_windows`` output: the highest lap number among the windows
    [start, end] that contain t (= the highest lap of any car in the replay
    frame at t). When no window contains t (a gap in the rows): the highest
    lap whose start is <= t. None before the first lap. Same rule as
    leaderLapAt in frontend/src/utils/raceTime.js.
    """
    containing = [n for n, start, end in windows if start <= t <= end]
    if containing:
        return max(containing)
    started = [n for n, start, _ in windows if start <= t]
    return max(started) if started else None


def map_track_status_to_laps(track_status, lap_rows):
    """Lap range of each track-status period (extract_track_status output),
    on the race leader's lap.

    An event at session time t belongs to the lap the race leader is on at t
    (lap_at_session_time), for the start and the end of a period alike. This
    matches FIA race control (2024 R5: VSC deployed on lap 22, SC deployed on
    laps 23 and 27) and the leader's (Position 1) TrackStatus. Each period
    {status, start_time, end_time, message} (session seconds; the last period
    has end_time None) is returned as a copy with two more keys:
      start_lap: 1 when the period began by the race start (min lap start),
                 else lap_at_session_time(start_time);
      end_lap:   the last lap when the period lasts to the end of the race
                 (end_time None or after the last lap), else
                 lap_at_session_time(end_time); never below start_lap.
    Periods outside the race are dropped: those that ended by the race start
    (grid and formation lap) and those that began after the last lap ended
    (in-lap after the chequered flag). Periods keep their input order.
    Returns [] when no lap row has a usable window. Identical output to
    mapTrackStatusToLaps in frontend/src/utils/raceTime.js.
    """
    windows = lap_windows(lap_rows)
    if not windows:
        return []
    race_start = min(start for _, start, _ in windows)
    race_end = max(end for _, _, end in windows)
    last_lap = max(n for n, _, _ in windows)
    out = []
    for period in track_status or []:
        if not isinstance(period, dict):
            continue
        start = _number(period.get('start_time'))
        end = _number(period.get('end_time'))
        if start is None:
            continue
        if end is not None and end <= race_start:
            continue
        if start > race_end:
            continue
        start_lap = 1 if start <= race_start else lap_at_session_time(windows, start)
        if end is None or end >= race_end:
            end_lap = last_lap
        else:
            end_lap = lap_at_session_time(windows, end)
        out.append({**period, 'start_lap': start_lap, 'end_lap': max(start_lap, end_lap)})
    return out


# ---------------------------------------------------------------------------
# The race leader's lap clock
# ---------------------------------------------------------------------------

def leader_lap_times(lap_rows):
    """{lap: (start_s, end_s)}: when the race LEADER started and finished each lap.

    end of lap L = Time of the row with Position 1 on lap L; fallback the
    earliest Time over the rows of lap L with a Position (a retiring car's
    truncated row has none); last resort the earliest Time of lap L.
    start of lap 1 = the race start (the earliest lap window start); start of
    lap L > 1 = the end of lap L - 1. Same clock as the lap mode of
    resolveSessionNow in frontend/src/utils/raceTime.js. Laps without any Time
    are left out; [] input gives {}.
    """
    leader, classified, any_row = {}, {}, {}
    for lap in lap_rows or []:
        if not isinstance(lap, dict):
            continue
        n = _number(lap.get('LapNumber'))
        end = _number(lap.get('Time'))
        if n is None or end is None:
            continue
        n = int(n)
        pos = _number(lap.get('Position'))
        if pos == 1 and (n not in leader or end < leader[n]):
            leader[n] = end
        if pos is not None and (n not in classified or end < classified[n]):
            classified[n] = end
        if n not in any_row or end < any_row[n]:
            any_row[n] = end
    ends = {n: leader.get(n, classified.get(n, t)) for n, t in any_row.items()}
    windows = lap_windows(lap_rows)
    race_start = min((start for _, start, _ in windows), default=None)
    out = {}
    for n in sorted(ends):
        start = race_start if n == 1 else ends.get(n - 1)
        out[n] = (start, ends[n])
    return out
