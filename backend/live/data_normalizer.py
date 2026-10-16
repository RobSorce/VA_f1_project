"""
Data Normalizer for F1 Live Timing

Transforms raw SignalR messages into the same data shapes used by the
existing FastF1-based pipeline, so all downstream visualizations and
predictions work unchanged.

Message formats (checked against the recorded live-timing files of the 2024
Italian GP race; backend/tests/test_live_normalizer.py feeds these formats):
- TimingData: Position is a string ('2'), NumberOfLaps an int; LastLapTime
  always arrives in the same message as the NumberOfLaps it completes.
  GapToLeader / IntervalToPositionAhead.Value are '+1.234', the race leader's
  'LAP <n>' (n = the lap the leader is on), a lapped car's '1L' or '1 L', or
  '' (no value).
- TimingAppData: Stints is a list in the first (snapshot) message and a dict
  of partial updates {"<index>": {...}} afterwards; TotalLaps is the tyre
  set's age, StartLaps its age when fitted, TyresNotChanged '1' a pit-lane
  pass on the same set. A later update can correct a stint already sent
  (recorded races, 1852 stints: Compound 253 times, TyresNotChanged '1' ->
  '0' 190, '0' -> '1' 12). The index is not always the stint: FastF1
  renumbers it between pit entries (_process_stints).
- RaceControlMessages: Messages is a list in the first (snapshot) message
  and a dict {"<index>": {...}} afterwards. Every (re-)subscription sends the
  snapshot again; a message is identified by its index (no index re-sent
  with new content in 3020 recorded messages).
- LastLapTime of 150 s or more is dropped, as FastF1 drops it (_api.py
  _laps_data_driver): the lap that ends after a red flag carries the
  suspension in it (2024 R4 VER lap 2: 1711.131 s).

Times: every live time (lap Time / LapStartTime, PitInTime / PitOutTime,
track-status start_time / end_time, weather Time) is in SESSION seconds on
one clock (session_time), the time base of the replay's FastF1 SessionTime
(decision D13). Live, session
time 0 is the first message after a reset; the mock replay pins the clock to
the replayed session's own times (set_session_time), so its live rows carry
the replay's session times exactly, and un-pins it when it stops (the clock
then runs on from the last pinned time). Wall-clock times (epoch seconds)
are kept apart as received_at (track status, weather, team radio).
"""
import datetime as _dt
import logging
import math
import re
import time as _time
from typing import Dict, Any, Optional, List, Tuple

logger = logging.getLogger(__name__)

# Compound mapping (same as fastf1_extractor)
COMPOUND_MAP = {
    "SOFT": "SOFT",
    "MEDIUM": "MEDIUM",
    "HARD": "HARD",
    "INTERMEDIATE": "INTERMEDIATE",
    "WET": "WET",
    "UNKNOWN": "UNKNOWN",
    "TEST_UNKNOWN": "UNKNOWN",
}

COMPOUND_INT = {
    "SOFT": 1, "MEDIUM": 2, "HARD": 3,
    "INTERMEDIATE": 4, "WET": 5, "UNKNOWN": 0,
}

# FastF1 ignores a LastLapTime of 150 s or more (_api.py: "laps which are
# longer than 150 seconds are ignored"), so the replay's row has no LapTime
MAX_LAP_TIME_S = 150.0


def _parse_lap_time(time_str: str) -> Optional[float]:
    """Parse F1 time string like '1:23.456' or '23.456' to seconds."""
    if not time_str or time_str == "":
        return None
    try:
        if ":" in time_str:
            parts = time_str.split(":")
            return float(parts[0]) * 60 + float(parts[1])
        return float(time_str)
    except (ValueError, TypeError):
        return None


def _safe_float(val) -> Optional[float]:
    if val is None:
        return None
    try:
        f = float(val)
        return f if f == f else None  # NaN check
    except (ValueError, TypeError):
        return None


def _to_int(val) -> Optional[int]:
    """int from an int, a float or a numeric string ('2', '2.0'); None for
    None, '', NaN or anything non-numeric. The feed sends Position as a
    string, and int('2.0') raises (the mock replay used to send str(2.0))."""
    f = _safe_float(val)
    return int(f) if f is not None else None


def _is_true(val) -> bool:
    """The feed's booleans arrive as bools, ints or strings ('true', '1')."""
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true")
    return bool(val)


# A lapped car: '1L', '1 L' (recorded feed), '+1 LAP', '2 LAPS'
_LAPPED_RE = re.compile(r"^\+?\s*(\d+)\s*(?:L|LAPS?)$", re.IGNORECASE)
# The race leader: 'LAP 30'
_LEADER_RE = re.compile(r"^LAP\s*\d+$", re.IGNORECASE)


def _parse_gap(val) -> Optional[Tuple[Optional[float], int]]:
    """Parse a GapToLeader / IntervalToPositionAhead value.

    Returns (seconds, laps_down), or None when the value carries nothing
    ('' or None: FastF1's _api.py keeps the previous value then).
    - 'LAP <n>': the race leader -> (0.0, 0). FastF1 _api.py _align_laps
      takes the driver whose gap string contains 'LAP' as the leader.
    - '+1.234' (or a number) -> (1.234, 0)
    - '<k>L', '<k> L', '+<k> LAP(S)': lapped -> (None, k). A car laps down
      has no time gap (FastF1: "cannot work with '+ 1 Lap' and similar");
      None is the JSON form of NaN (json.dumps writes NaN, which is not
      JSON, and Starlette's JSONResponse refuses it).
    Anything else -> None (ignored).
    """
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        f = _safe_float(val)
        return (f, 0) if f is not None else None
    s = str(val).strip()
    if not s:
        return None
    if _LEADER_RE.match(s):
        return (0.0, 0)
    m = _LAPPED_RE.match(s)
    if m:
        k = int(m.group(1))
        return (None, k) if k > 0 else (0.0, 0)
    f = _safe_float(s.lstrip("+"))
    return (f, 0) if f is not None else None


def _utc_epoch(utc) -> Optional[float]:
    """Epoch seconds of a feed 'Utc' string ('2024-09-01T12:08:03', UTC)."""
    if not isinstance(utc, str) or not utc:
        return None
    try:
        d = _dt.datetime.fromisoformat(utc.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    return d.timestamp()


class LiveDataNormalizer:
    """Converts raw SignalR topic messages into the project's data formats."""

    def __init__(self):
        # Driver number → abbreviation mapping (from DriverList topic)
        self.driver_map: Dict[str, Dict[str, Any]] = {}
        # Per-driver state tracking
        self.driver_state: Dict[str, Dict[str, Any]] = {}
        # Session start timestamp (for relative timing)
        self.session_start_time: Optional[float] = None
        # Current lap count (the race leader's lap, LapCount CurrentLap) and
        # the race distance (LapCount TotalLaps; None until sent)
        self.lap_count: int = 0
        self.total_laps: Optional[int] = None
        # Session clock (see the module docstring): time.monotonic() at
        # session time 0, or a pinned session time (mock replay)
        self._clock_origin: Optional[float] = None
        self._pinned_time: Optional[float] = None
        # Session time of the first SessionStatus 'Started' (lap 1 starts
        # then: the replay's lap-1 LapStartTime is the 'Started' time)
        self.race_start_time: Optional[float] = None
        # Session time of the last restart ('Started' after 'Aborted': red flag)
        self.restart_time: Optional[float] = None
        self._aborted = False
        # SessionStatus 'Finished' seen: the leader has taken the flag
        self.session_finished = False
        # Track-status changes [(session time, status code)] in arrival order,
        # for the TrackStatus string of each lap row
        self.track_status_history: List[Tuple[float, str]] = []
        # Lap rows completed before any track status was known (a connect's
        # TimingData snapshot comes before its TrackStatus snapshot): their
        # TrackStatus is set when the first status arrives
        self._rows_without_status: List[Dict[str, Any]] = []
        # (Status, Message) of the track status in force: a re-subscription
        # snapshot sends it again, which is not a change
        self._track_status_in_force: Optional[Tuple[str, str]] = None
        # Race-control messages already returned, by (feed index, Utc,
        # Category, Message): the snapshot of a re-subscription repeats them
        self._race_control_seen: set = set()
        # Drivers whose tyre_strategy entries already sent were corrected by
        # the feed: {abbr: the driver's full corrected entry list}, taken by
        # the session manager (take_stint_corrections)
        self.stint_corrections: Dict[str, List[Dict[str, Any]]] = {}

    # ── Session clock ─────────────────────────────────────────────────

    def session_time(self) -> float:
        """Now on the session clock (seconds). Live: seconds since the first
        call after a reset (the manager calls it on every message, so 0 is
        the first message). Mock replay: the pinned session time."""
        if self._pinned_time is not None:
            return self._pinned_time
        now = _time.monotonic()
        if self._clock_origin is None:
            self._clock_origin = now
        return round(now - self._clock_origin, 3)

    def set_session_time(self, t: Optional[float]):
        """Pin the session clock to `t` (mock replay: the replayed session's
        own time of the message about to be sent). None un-pins it: the
        clock then runs on from the last pinned time (a stopped mock left it
        pinned, so every later live message got the same time: two laps fed
        0.4 s apart both ended at 6654.29;
        backend/tests/test_live_mock_replay.py)."""
        if t is None:
            if self._pinned_time is not None:
                self._clock_origin = _time.monotonic() - self._pinned_time
            self._pinned_time = None
            return
        self._pinned_time = float(t)

    def _lap_track_status(self, start: Optional[float], end: float) -> str:
        """Track-status codes in force during a lap [start, end], in time
        order, each once: FastF1's Laps TrackStatus rule (core.py
        _add_track_status_to_laps): a status period [t, next_t] counts when
        the lap ends in it, starts in it, or contains it; the last period
        counts for every lap that ends after it began. '' with no status.

        The first status known is the one in force when the feed was joined
        (the TrackStatus snapshot), so its period starts before it: a lap
        that ended before it arrived (a connect's TimingData snapshot rows)
        gets it, not ''. A lap whose start is unknown (start None: a connect
        during it, no lap time) ran through every period up to its end that
        the history holds (2024 R8, connect during the lap-1 red flag: the
        lap-1 rows lacked the '5' in force at the connect)."""
        out = ""
        hist = self.track_status_history
        lo = -math.inf if start is None else start
        for i, (t, code) in enumerate(hist):
            t0 = -math.inf if i == 0 else t
            next_t = hist[i + 1][0] if i + 1 < len(hist) else None
            if next_t is None:
                sel = t0 <= end
            else:
                sel = (t0 <= end <= next_t) or (t0 <= lo <= next_t) or (lo <= t0 and next_t <= end)
            if sel and code not in out:
                out += code
        return out

    def get_abbreviation(self, racing_number: str) -> str:
        """Get driver abbreviation from racing number."""
        info = self.driver_map.get(str(racing_number), {})
        return info.get("Tla", str(racing_number))

    def _ensure_driver_state(self, abbr: str):
        """Initialize state tracking for a driver."""
        if abbr not in self.driver_state:
            self.driver_state[abbr] = {
                "current_lap": 0,
                "position": 0,
                "gap_to_leader": 0.0,
                "interval": 0.0,
                "compound": "UNKNOWN",
                "tyre_life": 0,
                "stint_number": 1,
                "in_pit": False,
                "last_lap_time": None,
                "sector1": None,
                "sector2": None,
                "sector3": None,
                "speed": 0,
                "best_lap_time": None,
                # Retirement / out-of-session tracking. F1 SignalR's TimingData
                # carries these flags per-driver during a race; they're how
                # we know to dim a driver on the timing tower mid-session
                # (race_results only arrives at session end).
                "retired": False,
                "stopped": False,
                "knocked_out": False,
                "status": "",          # free-text Status field if present
                "retired_lap": None,   # lap on which retired/stopped flipped True
                # Laps down on the leader (GapToLeader '1L'); gap_to_leader
                # is None (NaN) while lapped
                "lapped": False,
                "laps_down": 0,
                # Session time at which the lap `last_lap_end_lap` ended
                "last_lap_end": None,
                "last_lap_end_lap": None,
                # InPit transitions of the lap in progress (session seconds),
                # stamped on its row when it completes
                "pending_pit_in": None,
                "pending_pit_out": None,
                # restart_time whose first pit-out lap has been completed
                "restart_seen": None,
                # TimingAppData stints merged as FastF1 merges them, by stint
                # (the feed index renumbered, see _process_stints):
                # {stint: {Compound, New, TyresNotChanged, TotalLaps, StartLaps, ...}}
                "feed_stints": {},
                # {feed index: the stint its latest message went to}, and
                # {feed index: its values as the feed merges them}
                "stint_index_map": {},
                "index_values": {},
                # FastF1's stint counter between two pit entries (in-lap
                # ends), and whether a message of this bracket concerned it
                "bracket_stint": 0,
                "bracket_matched": False,
                # TimingData NumberOfPitStops (None until a record says), and
                # a snapshot whose counter is still to be set from it
                "pit_stops": None,
                "bracket_sync": False,
                # {stint: the driver's lap in progress when the stint's first
                # message arrived in an update}: the stint's first lap (FastF1)
                "stint_first_lap": {},
                # stints that first arrived after SessionStatus 'Finished'
                "post_race_stints": set(),
                # stints of a mid-race snapshot (no arrival lap: placed by
                # the cumulative TotalLaps rule, _stint_anchors), the laps
                # completed when it arrived, and the first lap of its set in
                # use when the feed's own records rule the cumulative
                # placement out (_note_snapshot_laps)
                "snapshot_stints": set(),
                "snapshot_laps": None,
                "snapshot_age_anchor": None,
                # (StintNumber, Compound, StartLap, New) of the tyre_strategy
                # entries sent so far, in order
                "stints_sent": [],
            }

    # ── DriverList ────────────────────────────────────────────────────

    def process_driver_list(self, data: Dict) -> List[Dict[str, Any]]:
        """Process DriverList topic → driver_info format.

        SignalR sends incremental updates, so we merge into the existing
        driver_map rather than replacing it.

        Returns list of {DriverNumber, Abbreviation, FullName, TeamName, TeamColor}
        for ALL known drivers (not just the ones in this update).
        """
        for num, info in data.items():
            if not isinstance(info, dict):
                continue
            num_str = str(num)
            # Merge into existing entry (don't replace — updates are partial)
            if num_str in self.driver_map:
                self.driver_map[num_str].update(info)
            else:
                self.driver_map[num_str] = info
            abbr = self.driver_map[num_str].get("Tla", num_str)
            self._ensure_driver_state(abbr)

        # Rebuild full driver list from accumulated map
        drivers = []
        for num_str, info in self.driver_map.items():
            abbr = info.get("Tla", num_str)
            team_colour = info.get("TeamColour", "FFFFFF")
            if team_colour and not team_colour.startswith("#"):
                team_colour = f"#{team_colour}"

            drivers.append({
                "DriverNumber": num_str,
                "Abbreviation": abbr,
                "FullName": f"{info.get('FirstName', '')} {info.get('LastName', '')}".strip() or abbr,
                "TeamName": info.get("TeamName", ""),
                "TeamColor": team_colour,
            })
        return drivers

    # ── TimingData ────────────────────────────────────────────────────

    def process_timing_data(self, data: Dict) -> Tuple[List[Dict], List[Dict], List[Dict]]:
        """Process TimingData topic.

        Returns (lap_updates, strategy_updates, status_updates) where:
        - lap_updates: list of completed lap entries (same shape as lap_times[])
        - strategy_updates: list of new stint entries (same shape as tyre_strategy[])
        - status_updates: list of driver-status changes (Retired / Stopped flips)
        Corrections of stints already sent go to stint_corrections.
        """
        lap_updates = []
        strategy_updates = []
        status_updates = []

        lines = data.get("Lines", data)
        if not isinstance(lines, dict):
            return lap_updates, strategy_updates, status_updates

        for num, line in lines.items():
            if not isinstance(line, dict):
                continue
            # Skip TimingData rows that arrive before DriverList. Without a
            # real Tla we'd stamp lap_times with the raw racing number, and
            # that number leaks through every consumer (TimingTower,
            # RacePaceGrid, TrackMap) as a phantom extra driver.
            info = self.driver_map.get(str(num), {})
            if not info.get("Tla"):
                continue
            abbr = info["Tla"]
            self._ensure_driver_state(abbr)
            state = self.driver_state[abbr]

            # Retirement flags. F1 sends these as bool *transitions* — we
            # only emit a status update when the value flips from False to
            # True so we don't spam the WS.
            for key, statefield in (
                ("Retired", "retired"),
                ("Stopped", "stopped"),
                ("KnockedOut", "knocked_out"),
            ):
                if key in line:
                    new_val = bool(line[key])
                    if new_val and not state[statefield]:
                        state[statefield] = True
                        if state["retired_lap"] is None:
                            state["retired_lap"] = state["current_lap"]
                        status_updates.append({
                            "Driver": abbr,
                            "Retired": state["retired"],
                            "Stopped": state["stopped"],
                            "KnockedOut": state["knocked_out"],
                            "Status": state["status"] or key,
                            "LastLap": state["retired_lap"],
                        })
                    elif not new_val and state[statefield]:
                        # F1 occasionally clears a flag (e.g. driver re-joins after
                        # a brief stop). Reflect that too.
                        state[statefield] = False
                        if not (state["retired"] or state["stopped"] or state["knocked_out"]):
                            state["retired_lap"] = None
                        status_updates.append({
                            "Driver": abbr,
                            "Retired": state["retired"],
                            "Stopped": state["stopped"],
                            "KnockedOut": state["knocked_out"],
                            "Status": "Active",
                            "LastLap": state["current_lap"],
                        })

            if "Status" in line and isinstance(line["Status"], str):
                state["status"] = line["Status"]

            # Pit entries so far: the key comes with the first stop (with
            # InPit True), so a full record (RacingNumber) without it is 0.
            # The stint counter of _process_stints is never below it: set
            # from it after a snapshot (_sync_snapshot_bracket), raised by it
            # otherwise (FastF1's counter stays put across an in-lap whose
            # bracket had no message: the 2025 R6 feed sends no stint before
            # lap 24, so the stops before it merged two sets into one)
            if "NumberOfPitStops" in line:
                state["pit_stops"] = _to_int(line["NumberOfPitStops"]) or 0
            elif "RacingNumber" in line:
                state["pit_stops"] = 0
            if state["pit_stops"] is not None:
                if state["bracket_sync"]:
                    self._sync_snapshot_bracket(state)
                    strategy_updates.extend(self._rebuild_stints(abbr, state))
                elif state["pit_stops"] > state["bracket_stint"]:
                    state["bracket_stint"] = state["pit_stops"]
                    state["bracket_matched"] = state["pit_stops"] in state["feed_stints"]

            # Position (a string in the feed: '2')
            if "Position" in line:
                pos = _to_int(line["Position"])
                if pos:
                    state["position"] = pos

            # Gap and interval: 'LAP <n>' is the leader (0), '<k>L' a car
            # laps down (gap None = NaN, lapped flag), '' carries nothing
            if "GapToLeader" in line:
                parsed = _parse_gap(line["GapToLeader"])
                if parsed is not None:
                    state["gap_to_leader"], state["laps_down"] = parsed
                    state["lapped"] = state["laps_down"] > 0

            if "IntervalToPositionAhead" in line:
                interval = line["IntervalToPositionAhead"]
                if isinstance(interval, dict):
                    interval = interval.get("Value")
                parsed = _parse_gap(interval)
                if parsed is not None:
                    state["interval"] = parsed[0]

            # Stints (tyre changes) — process BEFORE the lap so compound is set.
            # Stints can be a dict {"0": {...}} (incremental) or a list [{...}] (initial dump)
            if "Stints" in line:
                strategy_updates.extend(self._process_stints(abbr, state, line["Stints"]))

            # Sectors
            sectors = line.get("Sectors", {})
            if isinstance(sectors, dict):
                for sec_key, sec_val in sectors.items():
                    if not isinstance(sec_val, dict):
                        continue
                    sec_num = int(sec_key) + 1 if sec_key.isdigit() else None
                    if sec_num and 1 <= sec_num <= 3:
                        val = sec_val.get("Value")
                        time_sec = _parse_lap_time(val) if val else None
                        if time_sec:
                            state[f"sector{sec_num}"] = time_sec

            # BestLapTime: the driver's best so far. Not a lap: the lap it
            # was set on has its own row (LastLapTime), so emitting one here
            # duplicated it (and relabelled it with the current lap).
            best_lap = line.get("BestLapTime")
            if isinstance(best_lap, dict):
                best_time_sec = _parse_lap_time(best_lap.get("Value"))
                if best_time_sec and best_time_sec > 0:
                    state["best_lap_time"] = best_time_sec

            # A completed lap: NumberOfLaps (laps completed) goes up. The row
            # is that lap, LapNumber = NumberOfLaps, never the leader's
            # LapCount (a lapped car's lap 11 stays lap 11); its time is the
            # LastLapTime of the same message (always together in the
            # recorded feed), None when the feed gives none or FastF1 would
            # drop it (MAX_LAP_TIME_S: the lap through a red flag, which the
            # restart rule of _complete_lap then starts at the restart). Not
            # on lap 1: the feed sends no lap-1 time and FastF1 takes it from
            # Ergast, uncapped (core.py _add_first_lap_time_from_ergast),
            # which the mock replay sends (29 cached lap-1 rows of 2024 R4 /
            # R8 / R23 run 152-188 s).
            n = _to_int(line.get("NumberOfLaps")) if "NumberOfLaps" in line else None
            if n is not None and n > state["current_lap"]:
                lap_time_sec = None
                last_lap = line.get("LastLapTime")
                if isinstance(last_lap, dict):
                    lap_time_sec = _parse_lap_time(last_lap.get("Value"))
                    if not (lap_time_sec and lap_time_sec > 0) or (n > 1 and lap_time_sec >= MAX_LAP_TIME_S):
                        lap_time_sec = None
                row = self._complete_lap(num, abbr, state, n, lap_time_sec)
                if "RacingNumber" in line:
                    # a full record: a snapshot (connect, re-subscription), so
                    # the lap ended before now, when is not known; the next
                    # lap then starts LapTime before its end, not at the
                    # connect (it started on the earlier unknown end: 2024 R1
                    # connect on lap 14, VER lap 13 started at 4860.799
                    # instead of 4763.969)
                    state["last_lap_end"] = None
                lap_updates.append(row)
            if n is not None and state["snapshot_stints"] and state["snapshot_laps"] is None:
                # the laps of a driver whose stints came in a mid-race
                # snapshot (TimingAppData comes first on connect)
                self._note_snapshot_laps(state, n)
                strategy_updates.extend(self._rebuild_stints(abbr, state))

            # Pit lane: 'InPit' True is sent once on entry, False once on exit
            # (FastF1 _api.py). Entry is stamped on the lap in progress (the
            # in-lap), exit on the lap in progress after it (the out-lap); an
            # exit in the same message as a completed lap belongs to the next
            # lap, so the lap above is completed first.
            if "InPit" in line:
                in_pit = _is_true(line["InPit"])
                if in_pit and not state["in_pit"]:
                    state["pending_pit_in"] = self.session_time()
                elif not in_pit and state["in_pit"]:
                    state["pending_pit_out"] = self.session_time()
                state["in_pit"] = in_pit

        return lap_updates, strategy_updates, status_updates

    def _complete_lap(self, num, abbr: str, state: Dict[str, Any], lap_number: int,
                      lap_time_sec: Optional[float]) -> Dict[str, Any]:
        """The lap_times row of a lap that has just ended (now, on the
        session clock), in the replay's row shape (session seconds).

        LapStartTime as FastF1 sets it: lap 1 starts at the race start
        ('Started'); after a red-flag restart, a driver's first lap that
        leaves the pit lane after the restart starts at the restart when it
        has no lap time (core.py Session._load_laps_data); any other lap
        starts when the driver's previous lap ended, or LapTime before its
        end when that lap was not seen (mid-race connect)."""
        t = self.session_time()
        pit_in, pit_out = state["pending_pit_in"], state["pending_pit_out"]
        state["pending_pit_in"] = state["pending_pit_out"] = None
        if pit_in is not None and state["bracket_matched"]:
            # an in-lap ends a stint bracket (_process_stints): the stint
            # counter goes up once a message of the bracket concerned it
            state["bracket_stint"] += 1
            state["bracket_matched"] = False
        restart_lap = (self.restart_time is not None and state["restart_seen"] != self.restart_time
                       and pit_out is not None and pit_out > self.restart_time)
        if restart_lap:
            state["restart_seen"] = self.restart_time
        if lap_number == 1 and self.race_start_time is not None:
            start = self.race_start_time
        elif restart_lap and not lap_time_sec:
            start = self.restart_time
        elif state["last_lap_end_lap"] == lap_number - 1 and state["last_lap_end"] is not None:
            start = state["last_lap_end"]
        elif lap_time_sec:
            start = round(t - lap_time_sec, 3)
        else:
            start = None
        state["current_lap"] = lap_number
        state["last_lap_end"] = t
        state["last_lap_end_lap"] = lap_number
        if lap_time_sec:
            state["last_lap_time"] = lap_time_sec
            if state["best_lap_time"] is None or lap_time_sec < state["best_lap_time"]:
                state["best_lap_time"] = lap_time_sec

        lap_entry = {
            "Driver": abbr,
            "DriverNumber": str(num),
            "LapNumber": lap_number,
            "LapTime": lap_time_sec,
            "LapTimeSeconds": lap_time_sec,
            "Time": t,
            "LapStartTime": start,
            "Sector1Time": state["sector1"],
            "Sector1TimeSeconds": state["sector1"],
            "Sector2Time": state["sector2"],
            "Sector2TimeSeconds": state["sector2"],
            "Sector3Time": state["sector3"],
            "Sector3TimeSeconds": state["sector3"],
            "Position": state["position"],
            "Compound": state["compound"],
            "TyreLife": state["tyre_life"],
            "GapToLeader": state["gap_to_leader"],
            "IntervalToAhead": state["interval"],
            "Lapped": state["lapped"],
            "LapsDown": state["laps_down"],
            "IsPersonalBest": bool(lap_time_sec) and lap_time_sec == state["best_lap_time"],
            "PitInTime": pit_in,
            "PitOutTime": pit_out,
            "PitInTimeSeconds": pit_in,
            "PitOutTimeSeconds": pit_out,
            "TrackStatus": self._lap_track_status(start, t),
            "Team": self.driver_map.get(str(num), {}).get("TeamName", ""),
            "Stint": state["stint_number"],
            "SpeedI1": None,
            "SpeedI2": None,
            "SpeedFL": None,
            "SpeedST": state["speed"] if state["speed"] else None,
        }

        if not self.track_status_history:
            self._rows_without_status.append(lap_entry)

        # Reset sectors for next lap
        state["sector1"] = None
        state["sector2"] = None
        state["sector3"] = None
        return lap_entry

    def _process_stints(self, abbr: str, state: Dict[str, Any], raw_stints) -> List[Dict[str, Any]]:
        """Merge a TimingAppData 'Stints' payload (list = snapshot, dict =
        partial updates) into the driver's stints and rebuild the driver's
        tyre_strategy entries from them (_rebuild_stints).

        The feed's stint index is not the stint: FastF1 (core.py
        Session.__fix_tyre_info, 'Problem 2', GH#715 / GH#742) lets the stint
        counter go up at most once between two pit entries (the ends of two
        in-laps), so a message for a higher index belongs to the counter's
        stint, and every stint keeps its first message's time and the later
        values. The live side does the same as the messages arrive: an
        update for index i goes to stint min(i, counter); the counter goes up
        when an in-lap ends after a message of the bracket concerned it
        (_complete_lap). Without it the feed's reuse of an index for another
        set drew the new set from the old index's lap (2025 R1 BOR: index 5,
        a pass on lap 5, rewritten on lap 34 as the MEDIUM set: MEDIUM from
        lap 5; FastF1 starts it on 34; BEA the same on lap 40). Replaying
        FastF1's rule offline on the recorded feed gives the replay's stints
        for 597 of 598 drivers, 588 without the renumbering.
        One exception, kept from before: a set fitted after the chequered
        flag (below).
        The counter is never below NumberOfPitStops either (process_timing_data,
        _sync_snapshot_bracket). A snapshot (connect, re-subscription) is the
        feed's merged state by index: a known index goes to its stint (only
        what changed since it was last seen), a new one to its index shifted
        as the last known one was.

        A stint's first lap: the driver's lap in progress when its first
        update arrived (FastF1 gives a stint the laps that end after its
        first message, even when later messages rewrite it: 2025 R8 RUS,
        index 1, a drive-through on the same HARD set on lap 54, became a
        MEDIUM set on lap 63; FastF1 starts the MEDIUM on 54), less the laps
        a full first record says it had already run (TotalLaps - StartLaps:
        the 2025 R6 feed sends no stint before lap 24, its stint 0 arrives 23
        laps old); a snapshot's stints have no arrival lap (_stint_anchors).
        """
        if isinstance(raw_stints, dict):
            items, streamed = list(raw_stints.items()), True
        elif isinstance(raw_stints, list):
            items, streamed = list(enumerate(raw_stints)), False
        else:
            return []
        feed = state["feed_stints"]
        first_lap = state["stint_first_lap"]
        index_map = state["stint_index_map"]
        fresh = not feed
        shift = 0
        if index_map:
            top = max(index_map)
            shift = index_map[top] - top
        for key, val in items:
            idx = _to_int(key)
            if idx is None or not isinstance(val, dict):
                continue
            seen = state["index_values"].setdefault(idx, {})
            if not streamed and idx in index_map:
                # a re-subscription repeats what this index already sent:
                # only its changes are news (re-applied whole, its old values
                # undid newer ones another index had brought to the stint)
                val = {k: v for k, v in val.items() if seen.get(k) != v}
            seen.update(val)
            if streamed and self.session_finished and (
                    idx not in index_map or index_map[idx] in state["post_race_stints"]):
                # a set fitted after the chequered flag is a stint of its own
                # (no race lap, _rebuild_stints): FastF1 merges it into the
                # last stint, whose compound it then takes for the whole
                # stint (2024 R14 ALO / RIC / STR / TSU: the replay's last
                # stint has the compound fitted after the flag, the feed's
                # race message another one)
                stint = index_map.get(idx, max(feed, default=-1) + 1)
            elif streamed:
                stint = min(idx, state["bracket_stint"])
            else:
                stint = index_map.get(idx, idx + shift)
                if fresh:
                    state["snapshot_stints"].add(stint)
            index_map[idx] = stint
            if stint == state["bracket_stint"]:
                state["bracket_matched"] = True
            if streamed and stint not in feed:
                run = 0
                if "TotalLaps" in val and "StartLaps" in val:
                    run = (_to_int(val["TotalLaps"]) or 0) - (_to_int(val["StartLaps"]) or 0)
                first_lap[stint] = max(1, state["current_lap"] + 1 - max(0, run))
                if self.session_finished:
                    state["post_race_stints"].add(stint)
            feed.setdefault(stint, {}).update(val)
        if fresh and state["snapshot_stints"] and state["current_lap"] > 0:
            self._note_snapshot_laps(state, state["current_lap"])
        if not streamed and feed:
            # the in-laps before a snapshot were not seen: the counter comes
            # from the TimingData record that follows it on connect
            # (signalr_client: DriverList, TimingAppData, then the others);
            # until then, the snapshot's last stint
            state["bracket_sync"] = True
            if max(feed) >= state["bracket_stint"]:
                state["bracket_stint"] = max(feed)
                state["bracket_matched"] = True
        return self._rebuild_stints(abbr, state)

    def _sync_snapshot_bracket(self, state: Dict[str, Any]):
        """FastF1's stint counter after a snapshot. The in-laps before it
        were not seen, and the snapshot's last index is below the counter in
        58 of 1774 driver-snapshots, a car that has stopped and whose new
        index has not come yet (taken as the counter, it sends that index's
        message to the old stint: 2024 R2 BOT, connect on lap 37, the SOFT of
        lap 36 renames the HARD stint). NumberOfPitStops (pit
        entries) is the counter in 1757 of 1774 driver-snapshots of the
        recorded feed and never below it; above it 17 times, where FastF1
        found no message in a bracket (2025 R6) or the feed sent more
        indexes than stops (2025 R1: six indexes for three stops on lap 14).
        A connect's snapshot stints above it are those extra indexes: they
        are merged (_merge_snapshot_extras) so that the set in use is the
        counter's stint and the feed's later reuse of an index opens a stint
        (2025 R1 BOR, MEDIUM from lap 34). A re-subscription only raises the
        counter (in-laps lost in the gap: 2025 R6 ALO, a stop in a 3-lap gap,
        had its MEDIUM merged into the HARD stint)."""
        state["bracket_sync"] = False
        pits = state["pit_stops"]
        feed = state["feed_stints"]
        fresh = not state["stint_first_lap"] and set(feed) <= state["snapshot_stints"]
        if fresh:
            self._merge_snapshot_extras(state, pits)
            state["bracket_stint"] = pits
            state["bracket_matched"] = pits in feed
        elif pits > state["bracket_stint"]:
            state["bracket_stint"] = pits
            state["bracket_matched"] = pits in feed

    @staticmethod
    def _same_set(stint: Dict[str, Any], before: Dict[str, Any]) -> bool:
        """A snapshot stint that only repeats the set of the stint before it:
        TyresNotChanged '1' (a pit-lane pass on the same set) on the same
        compound or an unknown one (_rebuild_stints opens no entry for it)."""
        if not _is_true(stint.get("TyresNotChanged")):
            return False
        a = COMPOUND_MAP.get(str(stint.get("Compound", "")).upper(), "UNKNOWN")
        b = COMPOUND_MAP.get(str(before.get("Compound", "")).upper(), "UNKNOWN")
        return a == "UNKNOWN" or b == "UNKNOWN" or a == b

    def _merge_snapshot_extras(self, state: Dict[str, Any], pits: int):
        """Merge a connect snapshot's stints down to pits + 1 (the counter's
        stints 0..pits), as FastF1 merges the indexes of one bracket: the
        later values win (dict update).

        The extra indexes are taken among the stints that repeat the set of
        the stint before them (_same_set), the latest first: merging one of
        them changes no tyre set. The previous rule merged every index above
        pits into stint pits, which lost a set whenever the extras were
        earlier passes (2025 R1 BOR, connect on lap 47: indexes 0-6 for 5
        pit entries, the INTER of lap 45 overwrote the MEDIUM of laps 34-44;
        BEA lost its MEDIUM of laps 40-44 the same way). Only
        when no such stint is left are the top indexes merged into pits, as
        before. The index map follows the renumbering."""
        feed, index_map = state["feed_stints"], state["stint_index_map"]
        while feed and max(feed) > pits:
            keys = sorted(feed)
            pos = next((i for i in range(len(keys) - 1, 0, -1)
                        if self._same_set(feed[keys[i]], feed[keys[i - 1]])), None)
            if pos is None:
                for stint in [x for x in keys if x > pits]:
                    feed.setdefault(pits, {}).update(feed.pop(stint))
                for idx, stint in index_map.items():
                    if stint > pits:
                        index_map[idx] = pits
                break
            gone, into = keys[pos], keys[pos - 1]
            feed[into].update(feed.pop(gone))
            # the stints above it move down one
            for stint in keys[pos + 1:]:
                feed[stint - 1] = feed.pop(stint)
            for idx, stint in index_map.items():
                if stint == gone:
                    index_map[idx] = into
                elif stint > gone:
                    index_map[idx] = stint - 1
        state["snapshot_stints"] = set(feed)

    def _note_snapshot_laps(self, state: Dict[str, Any], laps_done: int):
        """The laps completed when a mid-race snapshot's stints arrived, and
        the one case where the set in use is not placed by the cumulative
        TotalLaps rule (D12): when the feed's own records rule that placement
        out. The set in use then starts where its own age puts it (laps + 1
        - its run), frozen at the snapshot.

        Ruled out: (a) it starts on or before the LapNumber of an earlier
        stint (a lap the feed timed on that earlier stint, so the set in use
        cannot have been fitted yet: 2025 R8 RUS, connect on lap 74, the
        MEDIUM's TotalLaps count 6 of its 15 laps, so the runs put the HARD
        of lap 69 on lap 60, before the MEDIUM's LapNumber 67; 2025 R1 LAW,
        the runs count 22 of 39 laps and put the MEDIUM of lap 34 on lap 17,
        before the INTER's LapNumber 29); (b) a set before it would run no
        lap while the runs miss laps (2025 R1 TSU, connect on lap 50: the
        MEDIUM of laps 34-47 has TotalLaps 0, so the INTER of lap 48 landed
        on its lap and the MEDIUM was dropped). The age is only taken when it
        is later than the cumulative placement and agrees with the LapNumbers
        (after the earlier ones, not after the set's own). Nothing else moves
        a stint: the age anchor used whenever the runs missed laps moved a
        dry race (2025 R6 Miami, connect on lap 32: BOR's HARD from 26, the
        runs' 20 is right: its TotalLaps lag its laps), and is gone."""
        state["snapshot_laps"] = laps_done
        state["snapshot_age_anchor"] = None
        feed = state["feed_stints"]
        snap = sorted(state["snapshot_stints"] & set(feed))
        if len(snap) < 2:
            return
        runs = [max(0, (_to_int(feed[x].get("TotalLaps")) or 0) - (_to_int(feed[x].get("StartLaps")) or 0))
                for x in snap]
        cumulative = 1 + sum(runs[:-1])
        age = max(1, min(laps_done + 1, laps_done + 1 - runs[-1]))
        if age <= cumulative:
            return
        timed = [_to_int(feed[x].get("LapNumber")) for x in snap]
        after = max((n for n in timed[:-1] if n), default=0) + 1
        own = timed[-1]
        before_timed_lap = cumulative < after
        empty_set = (runs[-2] == 0 and sum(runs) < laps_done - 1
                     and not self._same_set(feed[snap[-1]], feed[snap[-2]]))
        if (before_timed_lap or empty_set) and age >= after and (not own or age <= own):
            state["snapshot_age_anchor"] = age

    def _stint_anchors(self, state: Dict[str, Any]) -> Dict[int, int]:
        """{stint: its first lap}.

        A stint with an arrival lap starts there; a stint of a snapshot
        starts after the laps of the stints before it, each of which ran
        TotalLaps - StartLaps laps (its set's age now minus when fitted; the
        past stints used to all get the current lap, EndLap < StartLap): the
        cumulative TotalLaps rule (decision D12), but for the set in use where
        the feed's own records rule it out (_note_snapshot_laps), the stints
        before it then ending no later. The first stint is on the car from
        lap 1 (2025 R6: its late first message counted one lap too few for 3
        drivers).
        """
        feed, first_lap = state["feed_stints"], state["stint_first_lap"]
        order = sorted(feed)
        anchors = {}
        laps_before = 0
        for stint in order:
            s = feed[stint]
            if stint in first_lap:
                laps_before = first_lap[stint] - 1
            anchors[stint] = laps_before + 1
            laps_before += max(0, (_to_int(s.get("TotalLaps")) or 0) - (_to_int(s.get("StartLaps")) or 0))
        snap = [x for x in order if x in state["snapshot_stints"] and x not in first_lap]
        if snap and state["snapshot_age_anchor"] is not None:
            anchors[snap[-1]] = state["snapshot_age_anchor"]
            for stint in reversed(snap[:-1]):
                anchors[stint] = min(anchors[stint], anchors[order[order.index(stint) + 1]])
        if order:
            anchors[order[0]] = 1
        return anchors

    def _rebuild_stints(self, abbr: str, state: Dict[str, Any]) -> List[Dict[str, Any]]:
        """The driver's tyre_strategy entries from its stints. Returns the
        entries that follow the ones already sent; when an entry already
        sent changed (the feed corrected it), the driver's full list goes to
        stint_corrections instead and nothing is returned.

        A stint = one tyre set (decision R1): a stint with
        TyresNotChanged '1' (pit-lane pass on the same set) is not a new
        set. Its compound, New and TyresNotChanged are the latest the feed
        sent: FastF1 applies the later corrections of a stint to all of it
        (core.py Session.__fix_tyre_info), and so do the replay's lap rows.
        A stint followed by one that starts on the same lap runs no lap (a
        lap belongs to the stint whose first message is the latest before
        the lap ends): it has no lap row in the replay and no entry here (it
        used to give two stints on one StartLap on a mid-race connect).
        """
        feed = state["feed_stints"]
        anchors = self._stint_anchors(state)
        post_race = state["post_race_stints"]
        race = [x for x in sorted(feed) if x not in post_race]
        kept = [x for i, x in enumerate(race)
                if i + 1 == len(race) or anchors[race[i + 1]] > anchors[x]]
        kept += [x for x in sorted(feed) if x in post_race]
        stints = []
        set_number = 0
        set_compound = None  # known compound of the set in use
        for stint in kept:
            s = feed[stint]
            compound = COMPOUND_MAP.get(str(s.get("Compound", "")).upper(), "UNKNOWN")
            known = compound if compound != "UNKNOWN" else None
            # TyresNotChanged '1' on another compound is a new set all the
            # same (2025 R8 BOR: SOFT, then MEDIUM flagged '1'; FastF1 and
            # build_tyre_strategy open a stint there)
            same_set = (set_number and _is_true(s.get("TyresNotChanged"))
                        and (known is None or set_compound is None or known == set_compound))
            if not same_set:
                if stint in post_race:
                    # tyres fitted after the chequered flag run no race lap
                    # (2024 R14: 4 stints 'from lap 45' of 44; a pass on the
                    # set in use still names its compound, 2024 R23 COL / OCO)
                    continue
                set_number += 1
                set_compound = None
                set_start = anchors[stint]
                set_new = _is_true(s.get("New", False))
            if known and set_compound is None:
                # the set's entry, once its compound is known: from the stint
                # that fitted it or from a later pass on it (2024 R23 COL /
                # OCO: fitted UNKNOWN, MEDIUM on the pass)
                set_compound = known
                stints.append({
                    "Driver": abbr,
                    "StintNumber": set_number,
                    "Compound": known,
                    "StartLap": set_start,
                    "EndLap": None,
                    "TotalLaps": 0,
                    "New": set_new,
                })
            if set_compound:
                state["compound"] = set_compound
            state["stint_number"] = set_number
        if feed:
            age = _to_int(feed[max(feed)].get("TotalLaps"))
            if age is not None:
                state["tyre_life"] = age

        keys = [(e["StintNumber"], e["Compound"], e["StartLap"], e["New"]) for e in stints]
        sent = state["stints_sent"]
        state["stints_sent"] = keys
        if keys[:len(sent)] == sent:
            return stints[len(sent):]
        self.stint_corrections[abbr] = stints
        return []

    def take_stint_corrections(self) -> Dict[str, List[Dict[str, Any]]]:
        """{driver: full corrected tyre_strategy entries} since the last call."""
        out, self.stint_corrections = self.stint_corrections, {}
        return out

    # ── LapCount ──────────────────────────────────────────────────────

    def process_lap_count(self, data: Dict) -> int:
        """Process LapCount topic → current lap number (TotalLaps, when
        sent, is kept as the race distance: lap_in_progress caps at it)."""
        current = _to_int(data.get("CurrentLap"))
        if current:
            self.lap_count = current
        total = _to_int(data.get("TotalLaps"))
        if total:
            self.total_laps = total
        return self.lap_count

    def lap_in_progress(self, state: Dict[str, Any]) -> int:
        """The lap a driver is on (decision D11): laps completed + 1, capped
        at the race distance when it is known (a car that has taken the flag
        stays on the last lap). The live frames' 'lap', as in the replay
        frames (frames_<y>_<r>_R.json: lap 1 from t = 0); lap rows keep
        LapNumber = NumberOfLaps, the lap completed."""
        lap = int(state.get("current_lap") or 0) + 1
        if self.total_laps:
            lap = min(lap, self.total_laps)
        return lap

    # ── WeatherData ───────────────────────────────────────────────────

    def process_weather(self, data: Dict) -> Dict[str, Any]:
        """Process WeatherData topic → weather_data entry. Time is in session
        seconds, the time base of the lap rows (D13: a weather Time in epoch
        seconds matched no lap, so every live lap showed the first reading);
        received_at is the wall clock (epoch s)."""
        return {
            "Time": self.session_time(),
            "received_at": _time.time(),
            "AirTemp": _safe_float(data.get("AirTemp")),
            "TrackTemp": _safe_float(data.get("TrackTemp")),
            "Humidity": _safe_float(data.get("Humidity")),
            "Pressure": _safe_float(data.get("Pressure")),
            "Rainfall": bool(data.get("Rainfall", False)),
            "WindSpeed": _safe_float(data.get("WindSpeed")),
            "WindDirection": _safe_float(data.get("WindDirection")),
        }

    # ── TrackStatus ───────────────────────────────────────────────────

    def process_track_status(self, data: Dict) -> Optional[Dict[str, Any]]:
        """Process TrackStatus topic → track_status entry.

        start_time is in session seconds (the replay's track_status time
        base), not epoch seconds; received_at keeps the wall clock (epoch s)
        for display: a wall-clock view reads received_at (2024 R21, the red
        flag at 16:37:21.777 UTC next to race control's 'RED FLAG' of
        16:37:22; start_time read as epoch shows it in 1970).
        start_lap is the race leader's lap at the change (the feed's
        LapCount, decision R5; 1 before the race starts).

        None when Status and Message repeat the status in force: the snapshot
        of a re-subscription sends it again (the feed itself never repeated
        one in 344 recorded messages)."""
        status = str(data.get("Status", "1"))
        message = data.get("Message", "")
        if (status, message or "") == self._track_status_in_force:
            return None
        self._track_status_in_force = (status, message or "")
        t = self.session_time()
        self.track_status_history.append((t, status))
        for row in self._rows_without_status:
            row["TrackStatus"] = self._lap_track_status(row.get("LapStartTime"), row["Time"])
        self._rows_without_status = []
        return {
            "status": status,
            "start_time": t,
            "end_time": None,
            "message": message or "",
            "start_lap": max(1, self.lap_count),
            "end_lap": None,
            "received_at": _time.time(),
        }

    # ── RaceControlMessages ───────────────────────────────────────────

    def process_race_control(self, data: Dict) -> List[Dict[str, Any]]:
        """Process RaceControlMessages topic.

        Messages is a list in the snapshot sent on connect (every message so
        far: it used to be dropped, so a mid-race connect had no race-control
        history) and a dict {"<index>": {...}} in later updates. timestamp is
        the message's own Utc (epoch seconds) when present, else now.

        Returns only the messages not returned before: every re-subscription
        (signalr_client reconnects, a connect without reset) sends the whole
        list again. A message is its feed index (the list position in a
        snapshot) with its Utc, Category and Message: the index alone would
        drop the messages of a new session not preceded by a reset, the
        content alone two real messages (2024 R19 / R20: indexes 0 and 1 are
        the same text at the same second)."""
        messages = data.get("Messages", data) if isinstance(data, dict) else data
        if isinstance(messages, dict):
            iterable = messages.items()
        elif isinstance(messages, list):
            iterable = enumerate(messages)
        else:
            return []
        result = []
        for key, msg in iterable:
            if isinstance(msg, dict):
                utc = msg.get("Utc")
                idx = _to_int(key)
                seen_key = (idx if idx is not None else str(key), utc,
                            msg.get("Category"), msg.get("Message"))
                if seen_key in self._race_control_seen:
                    continue
                self._race_control_seen.add(seen_key)
                result.append({
                    "timestamp": _utc_epoch(utc) or _time.time(),
                    "utc": utc or "",
                    "category": msg.get("Category", ""),
                    "message": msg.get("Message", ""),
                    "flag": msg.get("Flag", ""),
                    "driver_number": msg.get("RacingNumber", ""),
                    "lap": msg.get("Lap", self.lap_count),
                })
        return result

    # ── SessionInfo / SessionStatus ───────────────────────────────────

    def process_session_info(self, data: Dict) -> Dict[str, Any]:
        """Process SessionInfo topic → session metadata."""
        meeting = data.get("Meeting", {})
        return {
            "event_name": meeting.get("Name", ""),
            "circuit_name": meeting.get("Circuit", {}).get("ShortName", ""),
            "country": meeting.get("Country", {}).get("Name", ""),
            "location": meeting.get("Circuit", {}).get("ShortName", ""),
            "session_type": data.get("Type", "Race"),
            "session_name": data.get("Name", ""),
            "gmt_offset": data.get("GmtOffset", ""),
            "start_date": data.get("StartDate", ""),
            "end_date": data.get("EndDate", ""),
            # Static-asset path used to build TeamRadio audio URLs:
            #   https://livetiming.formula1.com/static/<Path>/<radio.Path>
            "path": data.get("Path", ""),
        }

    # ── TeamRadio ─────────────────────────────────────────────────────

    def process_team_radio(self, data: Dict, session_path: str) -> List[Dict[str, Any]]:
        """Process TeamRadio topic → list of radio captures with audio URL.

        F1 doesn't ship transcripts in this feed — only audio. Each capture
        gives a relative .mp3 path that we resolve against the session's
        static asset prefix.
        """
        captures = data.get("Captures", data) if isinstance(data, dict) else []
        if isinstance(captures, dict):
            iterable = captures.values()
        elif isinstance(captures, list):
            iterable = captures
        else:
            return []

        base = "https://livetiming.formula1.com/static/"
        results = []
        for cap in iterable:
            if not isinstance(cap, dict):
                continue
            num = str(cap.get("RacingNumber", ""))
            abbr = self.get_abbreviation(num) if num else ""
            path = cap.get("Path", "")
            if not path:
                continue
            url = f"{base}{session_path}{path}" if session_path else f"{base}{path}"
            results.append({
                "timestamp": cap.get("Utc", ""),
                "driver_number": num,
                "driver": abbr,
                "audio_url": url,
                "received_at": _time.time(),
            })
        return results

    def process_session_status(self, data: Dict) -> str:
        """Process SessionStatus topic → status string.

        The first 'Started' is the race start on the session clock: lap 1
        starts then (the replay's lap-1 LapStartTime equals the 'Started'
        time, 3350.494 s at Monza 2024), and pit-lane passages before it (cars
        leaving the garage for the grid) belong to no lap, so the pending ones
        are dropped; a pit-lane starter leaves after 'Started', so its lap-1
        PitOutTime is kept. A 'Started' after 'Aborted' (red flag) is a
        restart (recorded feed: 2024 R4 / R8 / R21 restart at 5458.774 /
        5754.733 / 8637.645 s, the replay's LapStartTime of the restart lap),
        also when the 'Aborted' came in the snapshot of a connect during the
        red flag: the restart used to be taken for the race start there, so
        restart_time stayed None and every restart lap started at the
        connect (2024 R4 ALO lap 2 at 4630.807 s, not 5458.774). 'Aborted'
        always follows a 'Started' (34 recorded races), so the race start is
        then before the connect and unknown: race_start_time stays None. So
        it does when the 'Started' comes in the snapshot of a connect once
        the race is under way (a lap completed or the leader past lap 1): it
        used to be taken for the race start and dropped the pit entry the
        TimingData snapshot had just stamped on a car in the pit lane (2024
        R1 PER lap 13 lost its PitInTime)."""
        status = data.get("Status", "")
        if status == "Started":
            under_way = self.lap_count > 1 or any(st["current_lap"] > 0 for st in self.driver_state.values())
            if self._aborted:
                self.restart_time = self.session_time()
            elif self.race_start_time is None and not under_way:
                self.race_start_time = self.session_time()
                for state in self.driver_state.values():
                    state["pending_pit_in"] = state["pending_pit_out"] = None
            self._aborted = False
        elif status == "Aborted":
            self._aborted = True
        elif status == "Finished":
            self.session_finished = True
        return status

    # ── CarData (decompressed from CarData.z) ─────────────────────────

    def process_car_data(self, data: Any) -> Dict[str, Dict[str, Any]]:
        """Process decompressed CarData → per-driver telemetry samples.

        Returns {driver_number: {speed, throttle, brake, gear, rpm, drs}}.
        """
        result = {}
        entries = data.get("Entries", []) if isinstance(data, dict) else []
        for entry in entries:
            cars = entry.get("Cars", {})
            timestamp = entry.get("Utc", "")
            for num, car in cars.items():
                channels = car.get("Channels", {})
                abbr = self.get_abbreviation(num)
                self._ensure_driver_state(abbr)

                speed = channels.get("0", 0)  # Speed
                self.driver_state[abbr]["speed"] = speed

                result[num] = {
                    "timestamp": timestamp,
                    "speed": speed,
                    "rpm": channels.get("2", 0),
                    "gear": channels.get("3", 0),
                    "throttle": channels.get("4", 0),
                    "brake": channels.get("5", 0),
                    "drs": channels.get("45", 0),
                }
        return result

    # ── Position (decompressed from Position.z) ───────────────────────

    def process_position(self, data: Any) -> Dict[str, Dict[str, Any]]:
        """Process decompressed Position → per-driver position/coordinates.

        Returns {driver_number: {x, y, z, status, timestamp}}.
        Note: Since 2025 Dutch GP, x/y may be unavailable (paywalled).
        """
        result = {}
        entries = data.get("Position", []) if isinstance(data, dict) else []
        for entry in entries:
            timestamp = entry.get("Timestamp", "")
            entries_inner = entry.get("Entries", {})
            for num, pos in entries_inner.items():
                result[num] = {
                    "timestamp": timestamp,
                    "x": _safe_float(pos.get("X")),
                    "y": _safe_float(pos.get("Y")),
                    "z": _safe_float(pos.get("Z")),
                    "status": pos.get("Status", ""),
                }
        return result

    # ── Build frame from current state ────────────────────────────────

    def build_position_frame(self, car_data: Dict, position_data: Dict) -> Dict[str, Any]:
        """Build a frame entry matching the frames[] format.

        Returns {t, drivers: {ABBR: {x, y, lap, position, gap_to_leader, ...}}}.
        """
        frame_drivers = {}
        for num in set(list(car_data.keys()) + list(position_data.keys())):
            abbr = self.get_abbreviation(num)
            self._ensure_driver_state(abbr)
            state = self.driver_state[abbr]

            pos = position_data.get(num, {})
            car = car_data.get(num, {})

            frame_drivers[abbr] = {
                "x": pos.get("x"),  # May be None in live
                "y": pos.get("y"),  # May be None in live
                "lap": self.lap_in_progress(state),
                "position": state["position"],
                "gap_to_leader": state["gap_to_leader"],
                "speed": car.get("speed", state["speed"]),
                "gear": car.get("gear", 0),
                "drs": car.get("drs", 0),
                "throttle": car.get("throttle", 0),
                "brake": car.get("brake", 0),
                "tyre": COMPOUND_INT.get(state["compound"], 0),
                "tyre_life": state["tyre_life"],
                "is_pit_in": state["in_pit"],
            }

        return {
            "t": _time.time(),
            "drivers": frame_drivers,
        }

    # ── Build standings list ──────────────────────────────────────────

    def build_standings(self) -> List[Dict[str, Any]]:
        """Build current driver standings from accumulated state."""
        standings = []
        for abbr, state in self.driver_state.items():
            if state["position"] <= 0:
                continue
            standings.append({
                "position": state["position"],
                "driver": abbr,
                "gap_to_leader": state["gap_to_leader"],
                "interval": state["interval"],
                "lapped": state["lapped"],
                "laps_down": state["laps_down"],
                "last_lap_time": state["last_lap_time"],
                "compound": state["compound"],
                "tyre_life": state["tyre_life"],
                "in_pit": state["in_pit"],
                "speed": state["speed"],
                "current_lap": state["current_lap"],
            })
        standings.sort(key=lambda x: x["position"])
        return standings
