"""
Lap-time forecast input: ONE builder of the model window, used by training
(model/prepare_data.py), by serving (model/predict.py behind
POST /api/predict/lstm) and by the evaluation (scripts/evaluate_forecast.py).

The window is built from the session lap rows (``session_*.json['lap_times']``
or live rows of the same shape) of ONE driver, at a clock:

 1. the driver's rows completed at session_now (data/processors/degradation.py
    _is_lap_completed, the rule of isLapCompleted in raceTime.js), optionally
    capped at lap ``lap``; the origin lap is the last of them. Nothing after
    the clock is read (decisions R3 / R6).
 2. the clean laps of those rows: clean_stint_laps of degradation.py (stints
    of build_tyre_strategy, green only, no lap 1, no in-lap or out-lap, no
    slow outlier), the definition shared with the degradation fits.
 3. the last SEQUENCE_LEN clean laps, oldest first; with fewer than
    SEQUENCE_LEN (but at least MIN_WINDOW_LAPS) the first row is repeated on
    the left with is_pad = 1. Below MIN_WINDOW_LAPS there is no window.

Every feature of a window row is known at the end of that lap, and the
origin features at the end of the origin lap (FEATURES below). The reference
time is the last clean lap: the model predicts the next PREDICT_LEN lap
times as deltas to it, so it is a correction of the persistence forecast
("next lap = last clean lap").

Training calls build_window at the end of every lap of every driver (the
serving call at that clock gives the same window: the features depend only
on the rows completed by then), so training and serving windows can never
differ. Pure module (math, bisect, numpy): importable without FastF1 or torch.
"""
import bisect
import math

import numpy as np

from data.processors.degradation import _is_lap_completed, _lap_end_time, _normalise_now, clean_stint_laps, fit_stint
from data.processors.stints import _known_compound, _number, is_tyre_change

# Clean laps in a window (the LSTM sequence length)
SEQUENCE_LEN = 10

# Laps forecast after the origin lap; also the horizon of the pit label
# (model/pit_timing.py PIT_LABEL_HORIZON_LAPS, model/prepare_data.py PREDICT_LEN)
PREDICT_LEN = 5

# Fewest clean laps for a window (the frontend asked for 3 laps before)
MIN_WINDOW_LAPS = 3

# Gap to the car ahead above which there is no traffic effect, seconds. Also
# the value of the leader and of a row without a gap. ASSUMPTION: 30 s is
# above every DRS / dirty-air range and around a pit loss (an undercut
# target); 95% of the clean-lap gaps of the cached races are below 17.1 s
# (a profile of the cached races' features).
GAP_AHEAD_CAP_S = 30.0

# Track temperature when no weather row is in force (the frontend fallback)
DEFAULT_TRACK_TEMP_C = 30.0

# Position of a row that has none (a live row before the classification)
DEFAULT_POSITION = 10.0

COMPOUND_CODES = {
    'SOFT': 0, 'MEDIUM': 1, 'HARD': 2, 'INTERMEDIATE': 3, 'INTER': 3, 'WET': 4,
    'HYPERSOFT': 0, 'ULTRASOFT': 0, 'SUPERSOFT': 0, 'SUPERHARD': 2,
}
# 'UNKNOWN' / missing compound: coded as MEDIUM (the old prepare_data default)
UNKNOWN_COMPOUND_CODE = 1

# Columns of a window row, in model order
FEATURES = [
    'lap_time_delta',      # LapTimeSeconds - reference time (last clean lap), s
    'tyre_life',           # TyreLife of the lap, laps
    'compound',            # COMPOUND_CODES of the lap's stint
    'laps_before_origin',  # origin lap - LapNumber (gaps: pit stops, SC laps)
    'lap_number',          # LapNumber (fuel burnt so far)
    'position',            # Position at the end of the lap
    'gap_ahead',           # IntervalToAhead at the end of the lap, capped at GAP_AHEAD_CAP_S
    'track_temp',          # TrackTemp of the weather row in force at the end of the lap, C
    'is_pad',              # 1 on a left-padding row
    'origin_tyre_life',    # TyreLife of the origin lap (the tyre now on the car)
    'origin_compound',     # COMPOUND_CODES of the origin lap's stint
    'origin_green',        # 1 when the origin lap's TrackStatus is '1'
]
N_FEATURES = len(FEATURES)


def compound_code(compound):
    """COMPOUND_CODES of a compound name; UNKNOWN_COMPOUND_CODE otherwise."""
    return COMPOUND_CODES.get(_known_compound(compound), UNKNOWN_COMPOUND_CODE)


class _TrackTemp:
    """TrackTemp of the weather row in force at a session time (the latest row
    with Time <= t), as weatherAtSessionTime in the store."""

    def __init__(self, weather_rows):
        pts = []
        for w in weather_rows or []:
            if not isinstance(w, dict):
                continue
            t, temp = _number(w.get('Time')), _number(w.get('TrackTemp'))
            if t is not None and temp is not None:
                pts.append((t, temp))
        pts.sort()
        self.times = [p[0] for p in pts]
        self.temps = [p[1] for p in pts]

    def at(self, lap):
        """Track temperature for a lap row: the weather row in force at its end,
        else the row's own TrackTemp (live / legacy rows), else the default."""
        end = _lap_end_time(lap)
        if end is not None and self.times:
            i = bisect.bisect_right(self.times, end) - 1
            if i >= 0:
                return self.temps[i]
        own = _number(lap.get('TrackTemp'))
        return own if own is not None else DEFAULT_TRACK_TEMP_C


def _gap_ahead(lap):
    pos = _number(lap.get('Position'))
    gap = _number(lap.get('IntervalToAhead'))
    if pos == 1 or gap is None or gap <= 0:
        return GAP_AHEAD_CAP_S
    return min(gap, GAP_AHEAD_CAP_S)


def build_window(lap_rows, driver, session_now=None, weather_rows=None, lap=None):
    """The forecast window of one driver at a clock (see the module docstring).

    Args:
        lap_rows: session lap rows (any drivers; only ``driver``'s are read).
        driver: driver code.
        session_now: session seconds; None / NaN = every row (no clock).
        weather_rows: session weather rows (TrackTemp, Time in session seconds).
        lap: optional last lap of the driver to use (a lap clicked in the past).

    Returns a dict:
        driver, origin_lap (last completed lap used), origin_time (its end,
        session s), origin_compound, origin_tyre_life, origin_green,
        ref_lap / ref_time (last clean lap), window_laps (LapNumbers of the
        clean laps, oldest first), n_clean, features (SEQUENCE_LEN x
        N_FEATURES float array, unscaled, FEATURES order), stint_laps (clean
        laps of the origin's stint, for the per-stint fit), stint_fit
        (fit_stint of them or None), reason (None, or why there is no window:
        then features is None).
    """
    now = _normalise_now(session_now)
    cap = _number(lap)
    rows = []
    for r in lap_rows or []:
        if not isinstance(r, dict) or r.get('Driver') != driver:
            continue
        n = _number(r.get('LapNumber'))
        if n is None or (cap is not None and n > cap) or not _is_lap_completed(r, now):
            continue
        rows.append(r)
    out = {
        'driver': driver, 'origin_lap': None, 'origin_time': None, 'origin_compound': None,
        'origin_tyre_life': None, 'origin_green': None, 'ref_lap': None, 'ref_time': None,
        'window_laps': [], 'n_clean': 0, 'features': None, 'stint_laps': [], 'stint_fit': None,
        'reason': None,
    }
    if not rows:
        out['reason'] = f'{driver} has no lap completed at this clock.'
        return out
    origin = max(rows, key=lambda r: _number(r.get('LapNumber')))
    origin_lap = int(_number(origin.get('LapNumber')))
    out['origin_lap'] = origin_lap
    out['origin_time'] = _lap_end_time(origin)

    # Every row here is completed at the clock: no further time filter
    stints = clean_stint_laps(rows, session_now=math.inf, driver=driver)
    clean = []
    for st in stints:
        for r in st['laps']:
            clean.append((r, st['compound']))
    clean.sort(key=lambda p: _number(p[0].get('LapNumber')))
    clean = clean[-SEQUENCE_LEN:]
    origin_stint = stints[-1] if stints else None
    out['stint_laps'] = origin_stint['laps'] if origin_stint else []
    out['stint_fit'] = fit_stint(out['stint_laps']) if origin_stint else None
    out['origin_compound'] = origin_stint['compound'] if origin_stint else _known_compound(origin.get('Compound'))
    out['origin_green'] = str(origin.get('TrackStatus')) == '1'
    out['window_laps'] = [int(_number(r.get('LapNumber'))) for r, _ in clean]
    out['n_clean'] = len(clean)
    if len(clean) < MIN_WINDOW_LAPS:
        out['reason'] = (f'{driver} has {len(clean)} clean lap(s) completed by lap {origin_lap} '
                         f'(green, not lap 1, no pit in-lap or out-lap): at least {MIN_WINDOW_LAPS} are needed.')
        return out

    ref_row = clean[-1][0]
    ref_time = _number(ref_row.get('LapTimeSeconds'))
    ref_lap = int(_number(ref_row.get('LapNumber')))
    origin_tl = _number(origin.get('TyreLife'))
    if origin_tl is None:
        origin_tl = _number(ref_row.get('TyreLife')) + (origin_lap - ref_lap)
    out.update({'ref_lap': ref_lap, 'ref_time': ref_time, 'origin_tyre_life': origin_tl})

    temp = _TrackTemp(weather_rows)
    origin_code = compound_code(out['origin_compound'])
    green = 1.0 if out['origin_green'] else 0.0
    feats = []
    last_pos = DEFAULT_POSITION
    for r, comp in clean:
        n = _number(r.get('LapNumber'))
        pos = _number(r.get('Position'))
        last_pos = pos if pos is not None else last_pos
        feats.append([
            _number(r.get('LapTimeSeconds')) - ref_time,
            _number(r.get('TyreLife')),
            compound_code(comp),
            origin_lap - n,
            n,
            last_pos,
            _gap_ahead(r),
            temp.at(r),
            0.0,
            origin_tl,
            origin_code,
            green,
        ])
    pad = list(feats[0])
    pad[FEATURES.index('is_pad')] = 1.0
    feats = [pad] * (SEQUENCE_LEN - len(feats)) + feats
    out['features'] = np.asarray(feats, dtype=np.float64)
    return out


def rows_from_legacy_laps(last_laps, driver=None, current_lap=None):
    """Session-shaped lap rows from the legacy request dicts (lap_time,
    tyre_life, compound, sector1-3, position, gap_to_leader, gap_ahead,
    fuel_estimate, track_temp, drs, lap_number) so that build_window reads
    them like cached rows. The dicts carry no track status, pit times or
    clock: every lap is taken as green and completed, and a stop is inferred
    from the tyres (decision R2: a stop is a tyre change): between two
    consecutive laps with a TyreLife each, a tyre change (stints.py
    is_tyre_change) marks the earlier lap as the in-lap and the later as the
    out-lap (PitInTime / PitOutTime True). lap_number missing: the laps are
    numbered so the last one is current_lap (or the count). gap_ahead <= 0
    (what the frontend sent) is no gap (capped)."""
    laps = [l for l in (last_laps or []) if isinstance(l, dict)]
    n = len(laps)
    last = int(current_lap) if _number(current_lap) is not None else n
    rows = []
    for i, l in enumerate(laps):
        num = _number(l.get('lap_number'))
        rows.append({
            'Driver': driver or 'UNK',
            'LapNumber': num if num is not None else last - (n - 1 - i),
            'LapTimeSeconds': _number(l.get('lap_time')),
            'TyreLife': _number(l.get('tyre_life')),
            'Compound': l.get('compound'),
            'Position': _number(l.get('position')),
            'IntervalToAhead': _number(l.get('gap_ahead')),
            'TrackStatus': '1',
            'TrackTemp': _number(l.get('track_temp')),
        })
    rows.sort(key=lambda r: r['LapNumber'])
    for prev, cur in zip(rows, rows[1:]):
        if (prev['TyreLife'] is not None and cur['TyreLife'] is not None
                and cur['LapNumber'] == prev['LapNumber'] + 1 and is_tyre_change(prev, cur)):
            prev['PitInTime'] = True
            cur['PitOutTime'] = True
    return rows
