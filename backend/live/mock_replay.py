"""
Mock Live Replay

Replays a previously cached session at configurable speed for development
and testing. Converts stored session data back into incremental SignalR-style
messages and feeds them into the LiveSessionManager, simulating a live feed.

The messages use the live feed's formats (live/data_normalizer.py module
docstring): Position as an integer string, NumberOfLaps as an int, the
leader's gap 'LAP <n>', a lapped car's '<k>L', InPit True / False at the
pit entry / exit, stints with TotalLaps / StartLaps. Each lap's events are
sent in session-time order (lap completions at their Time, pit entries and
exits, the new stint after the in-lap) with the manager's session clock
pinned to the event's own session time, so the live rows carry the replay's
session times (Time, PitInTime, PitOutTime, TrackStatus); a weather reading
is sent at the leader's lap start it is in force at, on the same clock
(D13). When the replay stops or ends the clock is un-pinned: it runs on from
the last replayed time instead of stamping every later live message with it.
"""
import asyncio
import bisect
import json
import logging
import math
import time as _time
from pathlib import Path
from typing import Optional

from data.processors.stints import build_tyre_strategy, leader_lap_times, map_track_status_to_laps

logger = logging.getLogger(__name__)

CACHE_DIR = Path(__file__).parent.parent / "data" / "processed_cache"


def _num(value):
    """Finite float, or None (None, NaN, non-numeric)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _lap_time_str(seconds):
    """'1:23.456' / '58.123' as the feed writes LastLapTime; '' without a time."""
    if not seconds or seconds <= 0:
        return ""
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return f"{minutes}:{rest:06.3f}" if minutes else f"{rest:.3f}"


def _laps_down(row, leader_laps):
    """Laps the race leader completed beyond this row's lap before the row
    ended (the feed's '<k>L'): leader lap ends j > LapNumber with end <= Time."""
    n, t = _num(row.get("LapNumber")), _num(row.get("Time"))
    if n is None or t is None:
        return 0
    k = 0
    j = int(n) + 1
    while j in leader_laps:
        end = leader_laps[j][1]
        if end is None or end > t:
            break
        k += 1
        j += 1
    return k


def _timing_line(lt, leader_laps):
    """The TimingData line of a completed lap row, in the feed's formats."""
    lap_num = int(_num(lt.get("LapNumber")))
    line = {
        "NumberOfLaps": lap_num,
        "LastLapTime": {"Value": _lap_time_str(_num(lt.get("LapTimeSeconds")) or _num(lt.get("LapTime")))},
    }
    pos = _num(lt.get("Position"))
    if pos is not None:
        line["Position"] = str(int(pos))
    gap, interval = _num(lt.get("GapToLeader")), _num(lt.get("IntervalToAhead"))
    k = _laps_down(lt, leader_laps)
    if pos == 1:
        line["GapToLeader"] = f"LAP {lap_num + 1}"
        line["IntervalToPositionAhead"] = {"Value": f"LAP {lap_num + 1}"}
    else:
        if k > 0:
            line["GapToLeader"] = f"{k}L"
        elif gap is not None:
            line["GapToLeader"] = f"+{gap:.3f}"
        if interval is not None:
            line["IntervalToPositionAhead"] = {"Value": f"+{interval:.3f}"}
    sectors = {}
    for i in range(1, 4):
        sec_time = _num(lt.get(f"Sector{i}TimeSeconds"))
        if sec_time:
            sectors[str(i - 1)] = {"Value": f"{sec_time:.3f}"}
    if sectors:
        line["Sectors"] = sectors
    return line


def _weather_at(weather_list, session_time):
    """Weather row in force at a session time: the latest row with Time <=
    session_time (a reading is known once taken); before the first row, the
    first row; None without rows. Same rule as weatherAtSessionTime in
    frontend/src/store/useF1Store.js."""
    if not weather_list:
        return None
    if session_time is None:
        return weather_list[0]
    best = None
    for w in weather_list:
        try:
            t = float(w.get("Time"))
        except (TypeError, ValueError):
            continue
        if t > session_time:
            continue
        if best is None or t >= float(best.get("Time")):
            best = w
    return best if best is not None else weather_list[0]


def _weather_message(w):
    """WeatherData message body of one weather row."""
    return {
        "AirTemp": str(w.get("AirTemp", "")),
        "TrackTemp": str(w.get("TrackTemp", "")),
        "Humidity": str(w.get("Humidity", "")),
        "Pressure": str(w.get("Pressure", "")),
        "WindSpeed": str(w.get("WindSpeed", "")),
        "WindDirection": str(w.get("WindDirection", "")),
        "Rainfall": w.get("Rainfall", False),
    }


def _lap_fraction(session_time, window):
    """Position of a session time inside a leader lap window (start, end),
    clamped to [0, 1]; 0 when the window is unknown or empty."""
    start, end = window if window else (None, None)
    if session_time is None or start is None or end is None or end <= start:
        return 0.0
    return min(1.0, max(0.0, (session_time - start) / (end - start)))


class MockReplay:
    """Simulates a live F1 session from cached historical data."""

    def __init__(self, session_manager):
        """
        Args:
            session_manager: LiveSessionManager instance to feed messages into.
        """
        self.manager = session_manager
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self, year: int, round_num: int, speed: float = 10.0, session_type: str = "R"):
        """Start replaying a cached session.

        Args:
            year: Season year
            round_num: Round number
            speed: Playback multiplier (10 = 10x real-time)
            session_type: Session type ('R', 'Q', etc.)
        """
        session_path = CACHE_DIR / f"session_{year}_{round_num}_{session_type}.json"
        frames_path = CACHE_DIR / f"frames_{year}_{round_num}_{session_type}.json"

        if not session_path.exists():
            raise FileNotFoundError(f"No cached session: {session_path.name}")

        with open(session_path) as f:
            session_data = json.load(f)

        frames_data = None
        if frames_path.exists():
            with open(frames_path) as f:
                frames_data = json.load(f)

        logger.info(f"Starting mock replay: {year} R{round_num} at {speed}x speed")

        # Reset session manager
        self.manager.reset()
        self._running = True

        self._task = asyncio.create_task(
            self._replay_loop(session_data, frames_data, speed, year, round_num)
        )

    async def stop(self):
        """Stop the mock replay and un-pin the manager's session clock (it
        stayed pinned at the last replayed time: after a stopped mock of 2024
        R16, two live laps fed 0.4 s apart both ended at 6654.29;
        backend/tests/test_live_mock_replay.py)."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._unpin()
        logger.info("Mock replay stopped")

    def _unpin(self):
        """Un-pin the manager's session clock (it then runs on from the last
        pinned time); a manager without a clock is left alone."""
        pin = getattr(self.manager, "set_session_time", None)
        if pin is not None:
            pin(None)

    async def _send(self, topic: str, data: dict, session_time: Optional[float] = None):
        """Send one message, first pinning the manager's session clock to the
        message's own session time (a manager without a clock, e.g. a test
        recorder, just gets the message)."""
        if session_time is not None and math.isfinite(session_time):
            pin = getattr(self.manager, "set_session_time", None)
            if pin is not None:
                pin(session_time)
        await self.manager.on_message(topic, data)

    async def _replay_loop(self, session_data: dict, frames_data: Optional[dict],
                           speed: float, year: int, round_num: int):
        """Main replay loop — converts historical data to live messages."""
        try:
            # 1. Send session info
            await self.manager.on_message("SessionInfo", {
                "Meeting": {
                    "Name": session_data.get("circuit_info", {}).get("event_name", f"{year} R{round_num}"),
                    "Circuit": {
                        "ShortName": session_data.get("circuit_info", {}).get("location", "Unknown"),
                    },
                    "Country": {
                        "Name": session_data.get("circuit_info", {}).get("country", "Unknown"),
                    },
                },
                "Type": "Race",
                "Name": "Race",
            })

            # Store circuit info for snapshot
            self.manager.session_info["circuit_info"] = session_data.get("circuit_info", {})

            # 2. Send driver list
            driver_list = {}
            for d in session_data.get("driver_info", []):
                num = str(d.get("DriverNumber", ""))
                abbr = d.get("Abbreviation", num)
                color = d.get("TeamColor", "#FFFFFF").lstrip("#")
                driver_list[num] = {
                    "Tla": abbr,
                    "FirstName": d.get("FullName", abbr).split()[0] if d.get("FullName") else abbr,
                    "LastName": " ".join(d.get("FullName", "").split()[1:]) if d.get("FullName") else "",
                    "TeamName": d.get("TeamName", ""),
                    "TeamColour": color,
                    "RacingNumber": num,
                }
            await self.manager.on_message("DriverList", driver_list)

            # The race leader's lap clock (session seconds): lap L runs from
            # leader_laps[L][0] to leader_laps[L][1]
            lap_times = session_data.get("lap_times", [])
            leader_laps = leader_lap_times(lap_times)
            weather_list = session_data.get("weather_data", [])
            race_start = leader_laps[1][0] if 1 in leader_laps else None
            num_of = {info["Tla"]: num for num, info in driver_list.items()}

            # 3. Send session started, at the race start (lap 1 starts then);
            # a pit-lane starter is in the pit lane until its lap-1 PitOutTime
            for lt in lap_times:
                if (_num(lt.get("LapNumber")) == 1 and lt.get("Driver") in num_of
                        and _num(lt.get("PitOutTimeSeconds")) is not None):
                    await self._send("TimingData", {"Lines": {num_of[lt["Driver"]]: {"InPit": True}}},
                                     race_start)
            await self._send("SessionStatus", {"Status": "Started"}, race_start)

            # 4. Send weather: the reading in force at the race start, on the
            # session clock (its live Time is that session time)
            w = _weather_at(weather_list, race_start)
            if w is not None:
                await self._send("WeatherData", _weather_message(w), race_start)
            await asyncio.sleep(0.1)

            # 5. Group lap times by lap number and replay them
            laps_by_number = {}
            rows_by_key = {}
            for lt in lap_times:
                lap_num = _num(lt.get("LapNumber"))
                if lap_num:
                    laps_by_number.setdefault(int(lap_num), []).append(lt)
                    rows_by_key[(lt.get("Driver"), int(lap_num))] = lt

            max_lap = max(laps_by_number.keys()) if laps_by_number else 0

            # Calculate delay between laps based on average lap time
            avg_lap_time = 90.0  # default
            valid_times = [lt.get("LapTimeSeconds") or lt.get("LapTime")
                          for lt in lap_times
                          if (lt.get("LapTimeSeconds") or lt.get("LapTime")) and
                             (lt.get("LapTimeSeconds") or lt.get("LapTime")) > 0]
            if valid_times:
                avg_lap_time = sum(valid_times) / len(valid_times)

            delay_per_lap = avg_lap_time / speed

            # Track status changes, each on the lap the race leader is on when
            # it happens (start_time is in session seconds; periods that ended
            # before the race start or began after the last lap are dropped).
            # Within a lap they are sent in session-time order, each at its
            # fraction of the leader's lap, so a status deployed and ended
            # inside one lap is still in force for part of that lap.
            track_statuses = session_data.get("track_status", [])
            status_by_lap = {}
            for ts in map_track_status_to_laps(track_statuses, lap_times):
                status_by_lap.setdefault(ts["start_lap"], []).append(ts)

            # The other events of the race, each sent while LapCount is the
            # leader's lap at its session time (window_of), in session-time
            # order with the statuses: (time, order, seq, kind, payload)
            windows = sorted((s, lap) for lap, (s, _) in leader_laps.items() if s is not None)
            window_starts = [s for s, _ in windows]

            def window_of(t, fallback):
                if t is None or not windows:
                    return fallback
                i = bisect.bisect_right(window_starts, t) - 1
                return windows[max(i, 0)][1]

            events_by_lap = {}
            seq = 0

            def add_event(lap, t, order, kind, payload):
                nonlocal seq
                seq += 1
                events_by_lap.setdefault(lap, []).append((t, order, seq, kind, payload))

            for lap, changes in status_by_lap.items():
                for ts in changes:
                    add_event(lap, float(ts["start_time"]), -1, "status", ts)

            # Red flags: SessionStatus 'Aborted' when the red flag ('5') is
            # shown, 'Started' at the restart. The restart time is the
            # LapStartTime FastF1 gives every car's first lap out of the pit
            # lane after it (the most common LapStartTime of the later pit-out
            # laps; the recorded 'Started' times of 2024 R4 / R8 / R21)
            for ts in map_track_status_to_laps(track_statuses, lap_times):
                if str(ts.get("status")) != "5":
                    continue
                aborted = float(ts["start_time"])
                starts = [round(_num(lt.get("LapStartTime")), 3) for lt in lap_times
                          if _num(lt.get("LapStartTime")) is not None
                          and _num(lt.get("PitOutTimeSeconds")) is not None
                          and _num(lt.get("LapStartTime")) > aborted]
                add_event(window_of(aborted, ts["start_lap"]), aborted, -2, "SessionStatus",
                          {"Status": "Aborted"})
                if starts:
                    restart = max(set(starts), key=lambda s: (starts.count(s), -s))
                    if starts.count(restart) >= 2:
                        add_event(window_of(restart, ts["start_lap"]), restart, -2, "SessionStatus",
                                  {"Status": "Started"})

            # Tyre stints, one per tyre set (FastF1 Stint column): the cached
            # tyre_strategy may predate that rule, so rebuild it. A new stint
            # is sent right after its in-lap ends (the feed adds it during
            # the stop), the first one at the start of its lap. TotalLaps /
            # StartLaps are the set's age now / when fitted (TyreLife of the
            # stint's first lap - 1), so the stint's laps = TotalLaps -
            # StartLaps, the count the live side places stints with.
            strategies = build_tyre_strategy(lap_times) or session_data.get("tyre_strategy", [])
            stints_by_lap = {}
            stint_of = {}  # (driver, lap) -> (feed stint index, StartLap, StartLaps)
            for stint in strategies:
                driver = stint.get("Driver", "")
                driver_num = num_of.get(driver)
                if not driver_num:
                    continue
                idx = int(stint.get("StintNumber", 1)) - 1
                start_lap = int(stint.get("StartLap", 1))
                end_lap = int(stint.get("EndLap") or start_lap)
                first = rows_by_key.get((driver, start_lap)) or {}
                life = _num(first.get("TyreLife"))
                start_laps = int(life) - 1 if life is not None and life >= 1 else 0
                for n in range(start_lap, end_lap + 1):
                    stint_of[(driver, n)] = (idx, start_lap, start_laps)
                body = {"Lines": {driver_num: {"Stints": {str(idx): {
                    "Compound": stint.get("Compound", "UNKNOWN"),
                    "New": "true" if start_laps == 0 else "false",
                    "TyresNotChanged": "0",
                    "TotalLaps": start_laps,
                    "StartLaps": start_laps,
                }}}}}
                in_lap = rows_by_key.get((driver, start_lap - 1)) if start_lap > 1 else None
                t_in = _num(in_lap.get("Time")) if in_lap else None
                if t_in is None:
                    stints_by_lap.setdefault(start_lap, []).append(body)
                else:
                    add_event(window_of(t_in, start_lap), t_in, 2, "TimingData", body)

            # Lap completions at their Time; pit entry / exit (InPit) at the
            # rows' PitInTime / PitOutTime
            for lt in lap_times:
                driver_num = num_of.get(lt.get("Driver", ""))
                n = _num(lt.get("LapNumber"))
                if not driver_num or not n:
                    continue
                n = int(n)
                for key, in_pit in (("PitInTimeSeconds", True), ("PitOutTimeSeconds", False)):
                    t = _num(lt.get(key))
                    if t is not None:
                        add_event(window_of(t, n), t, 0, "TimingData",
                                  {"Lines": {driver_num: {"InPit": in_pit}}})
                t_end = _num(lt.get("Time"))
                add_event(window_of(t_end, n), t_end if t_end is not None else math.inf, 1, "lap",
                          (driver_num, lt))

            for lap_num in range(1, max_lap + 1):
                if not self._running:
                    break

                lap_window = leader_laps.get(lap_num)
                lap_start = lap_window[0] if lap_window else None

                # Send lap count
                await self._send("LapCount", {
                    "CurrentLap": lap_num,
                    "TotalLaps": max_lap,
                }, lap_start)

                # Send the stints that start without an in-lap (stint 1)
                for body in stints_by_lap.get(lap_num, []):
                    await self._send("TimingData", body, lap_start)

                # Send frame data if available (for position updates)
                if frames_data and frames_data.get("frames"):
                    total_frames = len(frames_data["frames"])
                    # Map lap to frame range
                    frames_per_lap = total_frames / max(max_lap, 1)
                    start_frame = int((lap_num - 1) * frames_per_lap)
                    end_frame = int(lap_num * frames_per_lap)
                    # Send a few frames per lap
                    step = max(1, (end_frame - start_frame) // 5)
                    for fi in range(start_frame, min(end_frame, total_frames), step):
                        frame = frames_data["frames"][fi]
                        # Convert frame to Position-like format
                        position_entries = {}
                        car_entries = []
                        for abbr, fd in frame.get("drivers", {}).items():
                            num = num_of.get(abbr)
                            if num:
                                position_entries[num] = {
                                    "X": fd.get("x"),
                                    "Y": fd.get("y"),
                                    "Status": "OnTrack",
                                }
                                car_entries.append({
                                    "Cars": {
                                        num: {
                                            "Channels": {
                                                "0": fd.get("speed", 0),
                                                "2": 0,
                                                "3": fd.get("gear", 0),
                                                "4": fd.get("throttle", 0),
                                                "5": fd.get("brake", 0),
                                                "45": fd.get("drs", 0),
                                            }
                                        }
                                    }
                                })

                        # Send car data
                        if car_entries:
                            await self.manager.on_message("CarData", {"Entries": car_entries})

                        # Send position
                        if position_entries:
                            await self.manager.on_message("Position", {
                                "Position": [{"Entries": position_entries, "Timestamp": ""}]
                            })

                        if not self._running:
                            break

                # Weather updates every 5 laps: the reading in force when the
                # race leader starts this lap (session time)
                if lap_num % 5 == 0 and lap_window and lap_window[0] is not None:
                    w = _weather_at(weather_list, lap_window[0])
                    if w is not None:
                        await self._send("WeatherData", _weather_message(w), lap_window[0])

                # Delay to simulate real-time. The lap's events go out in
                # session-time order: each track status change at its fraction
                # of the leader's lap (the playback is paced on them), lap
                # completions, pit entries / exits and new stints between them
                elapsed = 0.0
                for t, _order, _seq, kind, payload in sorted(events_by_lap.get(lap_num, [])):
                    if not self._running:
                        break
                    if kind == "status":
                        wait = _lap_fraction(t, lap_window) * delay_per_lap - elapsed
                        if wait > 0:
                            await asyncio.sleep(wait)
                            elapsed += wait
                        await self._send("TrackStatus", {
                            "Status": payload.get("status", "1"),
                            "Message": payload.get("message", ""),
                        }, t)
                    elif kind == "lap":
                        driver_num, lt = payload
                        when = t if math.isfinite(t) else None
                        await self._send("TimingData", {
                            "Lines": {driver_num: _timing_line(lt, leader_laps)}
                        }, when)
                        # The tyre set's age after this lap (TimingAppData)
                        n = int(_num(lt.get("LapNumber")))
                        stint = stint_of.get((lt.get("Driver"), n))
                        if stint:
                            idx, start_lap, start_laps = stint
                            await self._send("TimingAppData", {"Lines": {driver_num: {"Stints": {
                                str(idx): {"TotalLaps": start_laps + n - start_lap + 1},
                            }}}}, when)
                    else:
                        await self._send(kind, payload, t)
                await asyncio.sleep(max(0.0, delay_per_lap - elapsed))

            # Session end
            await self.manager.on_message("SessionStatus", {"Status": "Finished"})
            logger.info(f"Mock replay complete: {max_lap} laps replayed")

        except asyncio.CancelledError:
            logger.info("Mock replay cancelled")
        except Exception as e:
            logger.error(f"Mock replay error: {e}", exc_info=True)
        finally:
            self._running = False
            self._unpin()

    @property
    def is_running(self) -> bool:
        return self._running

    @staticmethod
    def list_available_sessions() -> list:
        """List cached sessions available for mock replay."""
        sessions = []
        if CACHE_DIR.exists():
            for f in sorted(CACHE_DIR.glob("session_*_R.json")):
                parts = f.stem.split("_")  # session_2024_7_R
                if len(parts) == 4:
                    sessions.append({
                        "year": int(parts[1]),
                        "round": int(parts[2]),
                        "session_type": parts[3],
                        "file": f.name,
                    })
        return sessions
