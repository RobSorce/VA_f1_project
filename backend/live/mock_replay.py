"""
Mock Live Replay

Replays a previously cached session at configurable speed for development
and testing. Converts stored session data back into incremental SignalR-style
messages and feeds them into the LiveSessionManager, simulating a live feed.
"""
import asyncio
import json
import logging
import time as _time
from pathlib import Path
from typing import Optional

from data.processors.stints import build_tyre_strategy, leader_lap_times, map_track_status_to_laps

logger = logging.getLogger(__name__)

CACHE_DIR = Path(__file__).parent.parent / "data" / "processed_cache"


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
        """Stop the mock replay."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Mock replay stopped")

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

            # 3. Send session started
            await self.manager.on_message("SessionStatus", {"Status": "Started"})

            # The race leader's lap clock (session seconds): lap L runs from
            # leader_laps[L][0] to leader_laps[L][1]
            lap_times = session_data.get("lap_times", [])
            leader_laps = leader_lap_times(lap_times)
            weather_list = session_data.get("weather_data", [])

            # 4. Send weather: the reading in force at the race start
            race_start = leader_laps[1][0] if 1 in leader_laps else None
            w = _weather_at(weather_list, race_start)
            if w is not None:
                await self.manager.on_message("WeatherData", _weather_message(w))
            await asyncio.sleep(0.1)

            # 5. Group lap times by lap number and replay them
            laps_by_number = {}
            for lt in lap_times:
                lap_num = lt.get("LapNumber")
                if lap_num:
                    laps_by_number.setdefault(int(lap_num), []).append(lt)

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
            for changes in status_by_lap.values():
                changes.sort(key=lambda ts: float(ts["start_time"]))

            # Send initial tyre stints, one per tyre set (FastF1 Stint column):
            # the cached tyre_strategy may predate that rule, so rebuild it
            strategies = build_tyre_strategy(lap_times) or session_data.get("tyre_strategy", [])
            stints_by_lap = {}
            for stint in strategies:
                start_lap = stint.get("StartLap", 1)
                stints_by_lap.setdefault(start_lap, []).append(stint)

            for lap_num in range(1, max_lap + 1):
                if not self._running:
                    break

                # Send lap count
                await self.manager.on_message("LapCount", {
                    "CurrentLap": lap_num,
                    "TotalLaps": max_lap,
                })

                # Send stint changes
                for stint in stints_by_lap.get(lap_num, []):
                    driver = stint.get("Driver", "")
                    # Find driver number
                    driver_num = None
                    for num, info in driver_list.items():
                        if info.get("Tla") == driver:
                            driver_num = num
                            break
                    if driver_num:
                        await self.manager.on_message("TimingData", {
                            "Lines": {
                                driver_num: {
                                    "Stints": {
                                        str(stint.get("StintNumber", 1) - 1): {
                                            "Compound": stint.get("Compound", "UNKNOWN"),
                                            "New": True,
                                            "TotalLaps": 0,
                                        }
                                    }
                                }
                            }
                        })

                # Send lap times for this lap
                for lt in laps_by_number.get(lap_num, []):
                    driver = lt.get("Driver", "")
                    driver_num = None
                    for num, info in driver_list.items():
                        if info.get("Tla") == driver:
                            driver_num = num
                            break

                    if not driver_num:
                        continue

                    lap_time_sec = lt.get("LapTimeSeconds") or lt.get("LapTime")
                    if lap_time_sec and lap_time_sec > 0:
                        minutes = int(lap_time_sec // 60)
                        seconds = lap_time_sec - minutes * 60
                        time_str = f"{minutes}:{seconds:06.3f}" if minutes else f"{seconds:.3f}"
                    else:
                        time_str = ""

                    # Build timing line
                    line = {
                        "Position": str(lt.get("Position", "")),
                        "GapToLeader": str(lt.get("GapToLeader", "0")),
                        "IntervalToPositionAhead": {"Value": str(lt.get("IntervalToAhead", "0"))},
                        "LastLapTime": {"Value": time_str},
                        "NumberOfLaps": lap_num,
                        "InPit": bool(lt.get("PitInTimeSeconds")),
                    }

                    # Add sectors
                    sectors = {}
                    for i in range(1, 4):
                        sec_time = lt.get(f"Sector{i}TimeSeconds")
                        if sec_time:
                            sectors[str(i - 1)] = {"Value": f"{sec_time:.3f}"}
                    if sectors:
                        line["Sectors"] = sectors

                    await self.manager.on_message("TimingData", {
                        "Lines": {driver_num: line}
                    })

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
                            # Find driver number
                            num = None
                            for n, info in driver_list.items():
                                if info.get("Tla") == abbr:
                                    num = n
                                    break
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
                lap_window = leader_laps.get(lap_num)
                if lap_num % 5 == 0 and lap_window and lap_window[0] is not None:
                    w = _weather_at(weather_list, lap_window[0])
                    if w is not None:
                        await self.manager.on_message("WeatherData", _weather_message(w))

                # Delay to simulate real-time; the lap's track status changes
                # are sent during it, in session-time order, each at its
                # fraction of the leader's lap
                elapsed = 0.0
                for ts in status_by_lap.get(lap_num, []):
                    if not self._running:
                        break
                    wait = _lap_fraction(float(ts["start_time"]), lap_window) * delay_per_lap - elapsed
                    if wait > 0:
                        await asyncio.sleep(wait)
                        elapsed += wait
                    await self.manager.on_message("TrackStatus", {
                        "Status": ts.get("status", "1"),
                        "Message": ts.get("message", ""),
                    })
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
