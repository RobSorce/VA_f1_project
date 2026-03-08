"""
Live Session Manager

Manages the lifecycle of a live F1 session: accumulates data from the
SignalR client via the normalizer, maintains full session state matching
the historical data format, and pushes incremental updates to connected
WebSocket clients.

Also manages an OpenF1 client for live telemetry (speed, throttle, brake,
gear, RPM, DRS) and car positions (x, y, z) since those feeds are paywalled
on the F1 SignalR hub since 2025.
"""
import asyncio
import json
import logging
import time as _time
from typing import Dict, Any, Optional, List

from .data_normalizer import LiveDataNormalizer

logger = logging.getLogger(__name__)


class LiveSessionManager:
    """Central hub for live session state accumulation and distribution."""

    def __init__(self):
        self.normalizer = LiveDataNormalizer()

        # Accumulated session state (matches /api/session/{year}/{round} shape)
        self.session_info: Dict[str, Any] = {}
        self.driver_info: List[Dict[str, Any]] = []
        self.lap_times: List[Dict[str, Any]] = []
        self.tyre_strategy: List[Dict[str, Any]] = []
        self.weather_data: List[Dict[str, Any]] = []
        self.track_status: List[Dict[str, Any]] = []
        self.race_control_messages: List[Dict[str, Any]] = []
        self.race_results: List[Dict[str, Any]] = []

        # Frames for position replay
        self.frames: List[Dict[str, Any]] = []
        self.driver_colors: Dict[str, str] = {}

        # Session lifecycle
        self.session_active = False
        self.session_status = ""  # "Started", "Inactive", "Finished", etc.
        self.current_lap = 0
        self.total_laps: Optional[int] = None

        # Per-driver telemetry buffers (for accumulating CarData per lap)
        self.telemetry_buffers: Dict[str, List[Dict]] = {}
        self.completed_telemetry: Dict[str, List[Dict]] = {}  # "DRIVER-LAP" → samples

        # OpenF1 telemetry client
        self._openf1_client = None
        self._openf1_enabled = False
        # Latest per-driver telemetry from OpenF1 (for frame building)
        self._openf1_car_data: Dict[str, Dict] = {}   # driver_num → latest sample
        self._openf1_positions: Dict[str, Dict] = {}   # driver_num → latest {x, y, z}

        # Connected WebSocket client queues
        self._subscribers: List[asyncio.Queue] = []
        self._lock = asyncio.Lock()

    # ── Subscriber management ─────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue:
        """Register a new WebSocket client. Returns a queue for receiving messages."""
        queue = asyncio.Queue(maxsize=500)
        self._subscribers.append(queue)
        logger.info(f"Client subscribed (total: {len(self._subscribers)})")
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        """Remove a WebSocket client."""
        if queue in self._subscribers:
            self._subscribers.remove(queue)
        logger.info(f"Client unsubscribed (total: {len(self._subscribers)})")

    async def _broadcast(self, message: Dict[str, Any]):
        """Send a message to all connected clients."""
        data = json.dumps(message, default=str)
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.remove(q)

    # ── Snapshot (full state for new connections) ─────────────────────

    def get_snapshot(self) -> Dict[str, Any]:
        """Return full accumulated session data matching /api/session format."""
        return {
            "lap_times": self.lap_times,
            "circuit_info": self.session_info.get("circuit_info", {}),
            "driver_info": self.driver_info,
            "race_results": self.race_results,
            "weather_data": self.weather_data,
            "tyre_strategy": self.tyre_strategy,
            "track_status": self.track_status,
        }

    def get_frames_snapshot(self) -> Dict[str, Any]:
        """Return accumulated frames matching /api/frames format."""
        return {
            "frames": self.frames[-500:],  # Last 500 frames to limit payload
            "driver_colors": self.driver_colors,
            "total_laps": self.total_laps or self.current_lap,
            "max_time": self.frames[-1]["t"] if self.frames else 0,
        }

    def get_status(self) -> Dict[str, Any]:
        """Return current live session status."""
        return {
            "active": self.session_active,
            "session_info": self.session_info,
            "session_status": self.session_status,
            "current_lap": self.current_lap,
            "total_laps": self.total_laps,
            "openf1_active": self._openf1_enabled,
            "openf1_locked": (self._openf1_client._api_locked
                              if self._openf1_client else False),
            "connected_clients": len(self._subscribers),
            "lap_count": len(self.lap_times),
            "driver_count": len(self.driver_info),
        }

    # ── Message routing (called by SignalR client callback) ───────────

    async def on_message(self, topic: str, data: Any):
        """Route a SignalR message to the appropriate handler."""
        try:
            if topic == "DriverList":
                await self._handle_driver_list(data)
            elif topic == "TimingData":
                await self._handle_timing_data(data)
            elif topic == "TimingAppData":
                await self._handle_timing_app_data(data)
            elif topic == "LapCount":
                await self._handle_lap_count(data)
            elif topic == "WeatherData":
                await self._handle_weather(data)
            elif topic == "TrackStatus":
                await self._handle_track_status(data)
            elif topic == "RaceControlMessages":
                await self._handle_race_control(data)
            elif topic == "TimingStats":
                await self._handle_timing_stats(data)
            elif topic == "SessionInfo":
                await self._handle_session_info(data)
            elif topic == "SessionStatus":
                await self._handle_session_status(data)
            elif topic == "CarData":
                await self._handle_car_data(data)
            elif topic == "Position":
                await self._handle_position(data)
            elif topic == "HeartBeat":
                await self._broadcast({"type": "heartbeat", "data": {"timestamp": _time.time()}})
        except Exception as e:
            logger.error(f"Error handling {topic}: {e}", exc_info=True)

    # ── Individual topic handlers ─────────────────────────────────────

    async def _handle_driver_list(self, data: Dict):
        self.driver_info = self.normalizer.process_driver_list(data)
        # Build driver colors map
        for d in self.driver_info:
            self.driver_colors[d["Abbreviation"]] = d.get("TeamColor", "#FFFFFF")
        self.session_active = True
        await self._broadcast({
            "type": "driver_list",
            "data": self.driver_info,
        })

    async def _handle_timing_data(self, data: Dict):
        lap_updates, strategy_updates = self.normalizer.process_timing_data(data)

        for lap_entry in lap_updates:
            self.lap_times.append(lap_entry)
            logger.info(f"lap_update: {lap_entry.get('Driver')} L{lap_entry.get('LapNumber')} "
                        f"{lap_entry.get('LapTimeSeconds', '?')}s")
            await self._broadcast({
                "type": "lap_update",
                "data": lap_entry,
            })

        for stint_entry in strategy_updates:
            # Update EndLap of previous stint for same driver
            for existing in reversed(self.tyre_strategy):
                if existing["Driver"] == stint_entry["Driver"] and existing["EndLap"] is None:
                    existing["EndLap"] = stint_entry["StartLap"] - 1
                    existing["TotalLaps"] = existing["EndLap"] - existing["StartLap"] + 1
                    break
            self.tyre_strategy.append(stint_entry)
            await self._broadcast({
                "type": "strategy_update",
                "data": stint_entry,
            })

        # Broadcast position update with current standings
        if lap_updates or strategy_updates:
            standings = self.normalizer.build_standings()
            await self._broadcast({
                "type": "position_update",
                "data": standings,
            })

    async def _handle_timing_app_data(self, data: Dict):
        """TimingAppData carries stint/tyre info — process similarly."""
        lines = data.get("Lines", data)
        if not isinstance(lines, dict):
            return
        # Create a TimingData-like wrapper for stints
        wrapper = {"Lines": {}}
        for num, line in lines.items():
            if isinstance(line, dict) and "Stints" in line:
                wrapper["Lines"][num] = {"Stints": line["Stints"]}
        if wrapper["Lines"]:
            _, strategy_updates = self.normalizer.process_timing_data(wrapper)
            for stint_entry in strategy_updates:
                for existing in reversed(self.tyre_strategy):
                    if existing["Driver"] == stint_entry["Driver"] and existing["EndLap"] is None:
                        existing["EndLap"] = stint_entry["StartLap"] - 1
                        existing["TotalLaps"] = existing["EndLap"] - existing["StartLap"] + 1
                        break
                self.tyre_strategy.append(stint_entry)
                await self._broadcast({
                    "type": "strategy_update",
                    "data": stint_entry,
                })

    async def _handle_lap_count(self, data: Dict):
        old_lap = self.current_lap
        self.current_lap = self.normalizer.process_lap_count(data)
        if data.get("TotalLaps"):
            self.total_laps = int(data["TotalLaps"])
        logger.info(f"LapCount: current={self.current_lap} total={self.total_laps} (raw: {data})")
        if self.current_lap != old_lap:
            await self._broadcast({
                "type": "lap_count",
                "data": {
                    "current_lap": self.current_lap,
                    "total_laps": self.total_laps,
                },
            })

    async def _handle_weather(self, data: Dict):
        weather_entry = self.normalizer.process_weather(data)
        self.weather_data.append(weather_entry)
        await self._broadcast({
            "type": "weather_update",
            "data": weather_entry,
        })

    async def _handle_track_status(self, data: Dict):
        status_entry = self.normalizer.process_track_status(data)
        # Close previous status period
        if self.track_status:
            self.track_status[-1]["end_time"] = status_entry["start_time"]
        self.track_status.append(status_entry)
        await self._broadcast({
            "type": "track_status",
            "data": status_entry,
        })

    async def _handle_race_control(self, data: Dict):
        messages = self.normalizer.process_race_control(data)
        if isinstance(messages, list):
            self.race_control_messages.extend(messages)
            for msg in messages:
                await self._broadcast({
                    "type": "race_control",
                    "data": msg,
                })

    async def _handle_timing_stats(self, data: Dict):
        """TimingStats contains per-driver personal bests — extract best lap times."""
        lines = data.get("Lines", data)
        if not isinstance(lines, dict):
            return
        for num, stats in lines.items():
            if not isinstance(stats, dict):
                continue
            abbr = self.normalizer.get_abbreviation(num)
            self.normalizer._ensure_driver_state(abbr)
            state = self.normalizer.driver_state[abbr]

            # PersonalBestLapTime → emit a lap entry if better than current best
            pb = stats.get("PersonalBestLapTime")
            if isinstance(pb, dict):
                from .data_normalizer import _parse_lap_time
                val = pb.get("Value")
                pb_sec = _parse_lap_time(val) if val else None
                if pb_sec and pb_sec > 0:
                    if state["best_lap_time"] is None or pb_sec < state["best_lap_time"]:
                        state["best_lap_time"] = pb_sec
                        lap_entry = {
                            "Driver": abbr,
                            "DriverNumber": str(num),
                            "LapNumber": max(state["current_lap"], 1),
                            "LapTime": pb_sec,
                            "LapTimeSeconds": pb_sec,
                            "Sector1Time": None, "Sector1TimeSeconds": None,
                            "Sector2Time": None, "Sector2TimeSeconds": None,
                            "Sector3Time": None, "Sector3TimeSeconds": None,
                            "Position": state["position"],
                            "Compound": state["compound"],
                            "TyreLife": state["tyre_life"],
                            "GapToLeader": state["gap_to_leader"],
                            "IntervalToAhead": state["interval"],
                            "IsPersonalBest": True,
                            "PitInTime": None, "PitOutTime": None,
                            "PitInTimeSeconds": None, "PitOutTimeSeconds": None,
                            "Team": self.normalizer.driver_map.get(str(num), {}).get("TeamName", ""),
                            "Stint": state["stint_number"],
                            "SpeedI1": None, "SpeedI2": None,
                            "SpeedFL": None, "SpeedST": None,
                        }
                        self.lap_times.append(lap_entry)
                        await self._broadcast({
                            "type": "lap_update",
                            "data": lap_entry,
                        })

    async def _handle_session_info(self, data: Dict):
        self.session_info = self.normalizer.process_session_info(data)
        self.session_active = True
        await self._broadcast({
            "type": "session_info",
            "data": self.session_info,
        })

    async def _handle_session_status(self, data: Dict):
        old_status = self.session_status
        self.session_status = self.normalizer.process_session_status(data)
        logger.info(f"Session status: {old_status} → {self.session_status}")

        if self.session_status in ("Started", "Active"):
            self.session_active = True
        elif self.session_status in ("Finished", "Finalised", "Ends"):
            await self._broadcast({
                "type": "session_end",
                "data": {
                    "status": self.session_status,
                    "final_standings": self.normalizer.build_standings(),
                },
            })

        await self._broadcast({
            "type": "session_status",
            "data": {"status": self.session_status},
        })

    async def _handle_car_data(self, data: Any):
        """Handle decompressed CarData — telemetry samples."""
        car_data = self.normalizer.process_car_data(data)

        # Accumulate telemetry per driver per lap
        for num, samples in car_data.items():
            abbr = self.normalizer.get_abbreviation(num)
            state = self.normalizer.driver_state.get(abbr, {})
            current_lap = state.get("current_lap", 0)
            key = f"{abbr}-{current_lap}"

            if key not in self.telemetry_buffers:
                self.telemetry_buffers[key] = []
            self.telemetry_buffers[key].append(samples)

        # Store car_data for frame building
        self._last_car_data = car_data

    async def _handle_position(self, data: Any):
        """Handle decompressed Position data — build frame."""
        position_data = self.normalizer.process_position(data)
        car_data = getattr(self, "_last_car_data", {})

        frame = self.normalizer.build_position_frame(car_data, position_data)
        self.frames.append(frame)

        # Keep frames buffer bounded
        if len(self.frames) > 5000:
            self.frames = self.frames[-3000:]

        await self._broadcast({
            "type": "frame",
            "data": frame,
        })

    # ── OpenF1 Telemetry ─────────────────────────────────────────────

    async def start_openf1(self, session_key: Optional[int] = None):
        """Start the OpenF1 telemetry client for live car data and positions."""
        if self._openf1_client and self._openf1_client.is_running:
            await self._openf1_client.stop()

        try:
            from .openf1_client import OpenF1Client
            self._openf1_client = OpenF1Client(
                on_car_data=self._on_openf1_car_data,
                on_location=self._on_openf1_location,
            )
            await self._openf1_client.start(session_key=session_key)
            self._openf1_enabled = True
            logger.info("OpenF1 telemetry client started")
        except Exception as e:
            logger.warning(f"OpenF1 client start failed: {e}")
            self._openf1_enabled = False

    async def stop_openf1(self):
        """Stop the OpenF1 telemetry client."""
        if self._openf1_client:
            await self._openf1_client.stop()
            self._openf1_client = None
        self._openf1_enabled = False
        logger.info("OpenF1 telemetry client stopped")

    async def _on_openf1_car_data(self, driver_number: str, samples: list):
        """Callback from OpenF1 client with car telemetry samples."""
        if not samples:
            return

        latest = samples[-1]
        self._openf1_car_data[driver_number] = latest

        # Update normalizer driver state with speed
        abbr = self.normalizer.get_abbreviation(driver_number)
        self.normalizer._ensure_driver_state(abbr)
        self.normalizer.driver_state[abbr]["speed"] = latest.get("speed", 0)

        # Accumulate into telemetry buffers (per driver per lap)
        state = self.normalizer.driver_state.get(abbr, {})
        current_lap = state.get("current_lap", 0)
        key = f"{abbr}-{current_lap}"
        if key not in self.telemetry_buffers:
            self.telemetry_buffers[key] = []
        for s in samples:
            self.telemetry_buffers[key].append({
                "timestamp": s.get("date", ""),
                "speed": s.get("speed", 0),
                "rpm": s.get("rpm", 0),
                "gear": s.get("gear", 0),
                "throttle": s.get("throttle", 0),
                "brake": s.get("brake", 0),
                "drs": s.get("drs", 0),
            })

        # Broadcast telemetry update (last samples for live display)
        await self._broadcast({
            "type": "telemetry_update",
            "data": {
                "driver": abbr,
                "driver_number": driver_number,
                "samples": samples[-5:],
            },
        })

    async def _on_openf1_location(self, driver_number: str, samples: list):
        """Callback from OpenF1 client with car position samples."""
        if not samples:
            return

        latest = samples[-1]
        self._openf1_positions[driver_number] = latest

        # Build a position frame from all known positions + car data
        frame_drivers = {}
        for num in set(list(self._openf1_positions.keys()) +
                       list(self._openf1_car_data.keys())):
            abbr = self.normalizer.get_abbreviation(num)
            self.normalizer._ensure_driver_state(abbr)
            state = self.normalizer.driver_state[abbr]
            pos = self._openf1_positions.get(num, {})
            car = self._openf1_car_data.get(num, {})

            from .data_normalizer import COMPOUND_INT
            frame_drivers[abbr] = {
                "x": pos.get("x"),
                "y": pos.get("y"),
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

        frame = {"t": _time.time(), "drivers": frame_drivers}
        self.frames.append(frame)
        if len(self.frames) > 5000:
            self.frames = self.frames[-3000:]

        await self._broadcast({"type": "frame", "data": frame})

    # ── Session reset ─────────────────────────────────────────────────

    def reset(self):
        """Reset all accumulated state for a new session."""
        self.normalizer = LiveDataNormalizer()
        self.session_info = {}
        self.driver_info = []
        self.lap_times = []
        self.tyre_strategy = []
        self.weather_data = []
        self.track_status = []
        self.race_control_messages = []
        self.race_results = []
        self.frames = []
        self.driver_colors = {}
        self.session_active = False
        self.session_status = ""
        self.current_lap = 0
        self.total_laps = None
        self.telemetry_buffers = {}
        self.completed_telemetry = {}
        self._last_car_data = {}
        self._openf1_car_data = {}
        self._openf1_positions = {}
        logger.info("Session manager reset")
