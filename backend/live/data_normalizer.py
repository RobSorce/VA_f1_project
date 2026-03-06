"""
Data Normalizer for F1 Live Timing

Transforms raw SignalR messages into the same data shapes used by the
existing FastF1-based pipeline, so all downstream visualizations and
predictions work unchanged.
"""
import logging
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


class LiveDataNormalizer:
    """Converts raw SignalR topic messages into the project's data formats."""

    def __init__(self):
        # Driver number → abbreviation mapping (from DriverList topic)
        self.driver_map: Dict[str, Dict[str, Any]] = {}
        # Per-driver state tracking
        self.driver_state: Dict[str, Dict[str, Any]] = {}
        # Session start timestamp (for relative timing)
        self.session_start_time: Optional[float] = None
        # Current lap count
        self.lap_count: int = 0

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

    def process_timing_data(self, data: Dict) -> Tuple[List[Dict], List[Dict]]:
        """Process TimingData topic.

        Returns (lap_updates, strategy_updates) where:
        - lap_updates: list of completed lap entries (same shape as lap_times[])
        - strategy_updates: list of new stint entries (same shape as tyre_strategy[])
        """
        lap_updates = []
        strategy_updates = []

        lines = data.get("Lines", data)
        if not isinstance(lines, dict):
            return lap_updates, strategy_updates

        for num, line in lines.items():
            if not isinstance(line, dict):
                continue
            abbr = self.get_abbreviation(num)
            self._ensure_driver_state(abbr)
            state = self.driver_state[abbr]

            # NumberOfLaps — process early so current_lap is set before lap time emission
            if "NumberOfLaps" in line:
                n = line["NumberOfLaps"]
                if n:
                    state["current_lap"] = int(n)

            # Position
            if "Position" in line:
                state["position"] = int(line["Position"]) if line["Position"] else state["position"]

            # Gap and interval
            if "GapToLeader" in line:
                val = line["GapToLeader"]
                if isinstance(val, str):
                    val = val.replace("LAP", "").strip()
                state["gap_to_leader"] = _safe_float(val) or 0.0

            if "IntervalToPositionAhead" in line:
                interval = line["IntervalToPositionAhead"]
                if isinstance(interval, dict):
                    interval = interval.get("Value", "0")
                state["interval"] = _safe_float(str(interval).replace("LAP", "").strip()) or 0.0

            # Pit status
            if "InPit" in line:
                state["in_pit"] = bool(line["InPit"])

            # Stints (tyre changes) — process BEFORE lap time so compound is set
            # Stints can be a dict {"0": {...}} (incremental) or a list [{...}] (initial dump)
            raw_stints = line.get("Stints", {})
            stint_items = []
            if isinstance(raw_stints, dict):
                stint_items = list(raw_stints.items())
            elif isinstance(raw_stints, list):
                stint_items = [(str(i), s) for i, s in enumerate(raw_stints)]

            for stint_key, stint_val in stint_items:
                if not isinstance(stint_val, dict):
                    continue
                compound = stint_val.get("Compound", "").upper()
                compound = COMPOUND_MAP.get(compound, "UNKNOWN")
                new_tyres = stint_val.get("New", False)
                if isinstance(new_tyres, str):
                    new_tyres = new_tyres.lower() == "true"
                tyre_age = stint_val.get("TotalLaps", 0) or 0
                stint_num = int(stint_key) + 1 if stint_key.isdigit() else state["stint_number"]

                if compound != "UNKNOWN" and (compound != state["compound"] or stint_num != state["stint_number"]):
                    state["compound"] = compound
                    state["stint_number"] = stint_num
                    state["tyre_life"] = int(tyre_age)

                    strategy_updates.append({
                        "Driver": abbr,
                        "StintNumber": stint_num,
                        "Compound": compound,
                        "StartLap": state["current_lap"],
                        "EndLap": None,
                        "TotalLaps": 0,
                        "New": new_tyres,
                    })
                else:
                    # Update tyre life even if compound unchanged
                    if tyre_age:
                        state["tyre_life"] = int(tyre_age)
                    # Set compound if still UNKNOWN and we got a valid one
                    if state["compound"] == "UNKNOWN" and compound != "UNKNOWN":
                        state["compound"] = compound

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

            # BestLapTime — update driver's best and emit a lap entry if
            # it's better than what we've already recorded (critical for
            # initial data dumps where LastLapTime may not be the best)
            best_lap = line.get("BestLapTime")
            if isinstance(best_lap, dict):
                best_time_str = best_lap.get("Value")
                best_time_sec = _parse_lap_time(best_time_str)
                if best_time_sec and best_time_sec > 0:
                    emit_best = (
                        state["best_lap_time"] is None
                        or best_time_sec < state["best_lap_time"]
                    )
                    state["best_lap_time"] = best_time_sec
                    if emit_best:
                        lap_updates.append({
                            "Driver": abbr,
                            "DriverNumber": str(num),
                            "LapNumber": max(state["current_lap"], 1),
                            "LapTime": best_time_sec,
                            "LapTimeSeconds": best_time_sec,
                            "Sector1Time": None,
                            "Sector1TimeSeconds": None,
                            "Sector2Time": None,
                            "Sector2TimeSeconds": None,
                            "Sector3Time": None,
                            "Sector3TimeSeconds": None,
                            "Position": state["position"],
                            "Compound": state["compound"],
                            "TyreLife": state["tyre_life"],
                            "GapToLeader": state["gap_to_leader"],
                            "IntervalToAhead": state["interval"],
                            "IsPersonalBest": True,
                            "PitInTime": None,
                            "PitOutTime": None,
                            "PitInTimeSeconds": None,
                            "PitOutTimeSeconds": None,
                            "Team": self.driver_map.get(str(num), {}).get("TeamName", ""),
                            "Stint": state["stint_number"],
                            "SpeedI1": None,
                            "SpeedI2": None,
                            "SpeedFL": None,
                            "SpeedST": None,
                        })

            # Last lap time → emit a completed lap entry
            last_lap = line.get("LastLapTime")
            if isinstance(last_lap, dict):
                lap_time_str = last_lap.get("Value")
                lap_time_sec = _parse_lap_time(lap_time_str)
                if lap_time_sec and lap_time_sec > 0:
                    state["last_lap_time"] = lap_time_sec
                    state["current_lap"] = max(state["current_lap"], self.lap_count)

                    if state["best_lap_time"] is None or lap_time_sec < state["best_lap_time"]:
                        state["best_lap_time"] = lap_time_sec

                    lap_entry = {
                        "Driver": abbr,
                        "DriverNumber": str(num),
                        "LapNumber": state["current_lap"],
                        "LapTime": lap_time_sec,
                        "LapTimeSeconds": lap_time_sec,
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
                        "IsPersonalBest": lap_time_sec == state["best_lap_time"],
                        "PitInTime": None,
                        "PitOutTime": None,
                        "PitInTimeSeconds": None,
                        "PitOutTimeSeconds": None,
                        "Team": self.driver_map.get(str(num), {}).get("TeamName", ""),
                        "Stint": state["stint_number"],
                        "SpeedI1": None,
                        "SpeedI2": None,
                        "SpeedFL": None,
                        "SpeedST": state["speed"] if state["speed"] else None,
                    }
                    lap_updates.append(lap_entry)

                    # Reset sectors for next lap
                    state["sector1"] = None
                    state["sector2"] = None
                    state["sector3"] = None

        return lap_updates, strategy_updates

    # ── LapCount ──────────────────────────────────────────────────────

    def process_lap_count(self, data: Dict) -> int:
        """Process LapCount topic → current lap number."""
        current = data.get("CurrentLap", self.lap_count)
        if current:
            self.lap_count = int(current)
        return self.lap_count

    # ── WeatherData ───────────────────────────────────────────────────

    def process_weather(self, data: Dict) -> Dict[str, Any]:
        """Process WeatherData topic → weather_data entry."""
        return {
            "Time": _time.time(),
            "AirTemp": _safe_float(data.get("AirTemp")),
            "TrackTemp": _safe_float(data.get("TrackTemp")),
            "Humidity": _safe_float(data.get("Humidity")),
            "Pressure": _safe_float(data.get("Pressure")),
            "Rainfall": bool(data.get("Rainfall", False)),
            "WindSpeed": _safe_float(data.get("WindSpeed")),
            "WindDirection": _safe_float(data.get("WindDirection")),
        }

    # ── TrackStatus ───────────────────────────────────────────────────

    def process_track_status(self, data: Dict) -> Dict[str, Any]:
        """Process TrackStatus topic → track_status entry."""
        status = str(data.get("Status", "1"))
        message = data.get("Message", "")
        return {
            "status": status,
            "start_time": _time.time(),
            "end_time": None,
            "message": message or "",
        }

    # ── RaceControlMessages ───────────────────────────────────────────

    def process_race_control(self, data: Dict) -> Dict[str, Any]:
        """Process RaceControlMessages topic."""
        messages = data.get("Messages", data)
        if isinstance(messages, dict):
            # Often comes as {"0": {...}, "1": {...}} or a single message
            result = []
            for key, msg in messages.items():
                if isinstance(msg, dict):
                    result.append({
                        "timestamp": _time.time(),
                        "category": msg.get("Category", ""),
                        "message": msg.get("Message", ""),
                        "flag": msg.get("Flag", ""),
                        "driver_number": msg.get("RacingNumber", ""),
                        "lap": msg.get("Lap", self.lap_count),
                    })
            return result
        return []

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
        }

    def process_session_status(self, data: Dict) -> str:
        """Process SessionStatus topic → status string."""
        return data.get("Status", "")

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
                "lap": state["current_lap"],
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
                "last_lap_time": state["last_lap_time"],
                "compound": state["compound"],
                "tyre_life": state["tyre_life"],
                "in_pit": state["in_pit"],
                "speed": state["speed"],
                "current_lap": state["current_lap"],
            })
        standings.sort(key=lambda x: x["position"])
        return standings
