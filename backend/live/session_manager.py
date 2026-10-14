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
import glob
import json
import logging
import os
import time as _time
from typing import Dict, Any, Optional, List

from .data_normalizer import LiveDataNormalizer
from .team_radio_transcriber import TeamRadioTranscriber

logger = logging.getLogger(__name__)

# Resolve once: backend/data/processed_cache (sibling of `live/`)
_CACHE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "processed_cache",
)

# The last message a client gets when its queue overflows (a reader too slow
# to keep up): its backlog is dropped, the manager stops feeding it, and the
# WebSocket endpoint closes the socket after sending this (api/routers/live.py
# _send_updates), so the client reconnects to a fresh session_init snapshot
# instead of waiting forever on a queue nobody fills.
RESYNC_MESSAGE = json.dumps({"type": "resync", "data": {"reason": "client_queue_full"}})


def _lookup_cached_circuit(event_name: str) -> Optional[Dict[str, Any]]:
    """Find circuit_info by event_name across cached sessions.

    Live SignalR session_info has event_name (e.g. "Miami Grand Prix") but no
    track coordinates. Past seasons of the same GP share the circuit shape, so
    we look up the most recent cached session_<year>_<round>_R.json whose
    schedule matches the event_name and reuse its circuit_info.
    """
    if not event_name:
        return None

    # Walk schedules newest-first so we get the freshest layout
    for sched_path in sorted(
        glob.glob(os.path.join(_CACHE_DIR, "schedule_*.json")), reverse=True
    ):
        try:
            with open(sched_path) as f:
                sched = json.load(f)
        except Exception:
            continue
        events = sched.get("events", []) if isinstance(sched, dict) else []
        for evt in events:
            if str(evt.get("EventName", "")).strip().lower() != event_name.strip().lower():
                continue
            year = sched.get("year")
            rnd = evt.get("RoundNumber")
            if not (year and rnd):
                continue
            # Try Race first, fall back to any session type
            for stype in ("R", "Q", "S", "FP3", "FP2", "FP1"):
                sess_path = os.path.join(_CACHE_DIR, f"session_{year}_{rnd}_{stype}.json")
                if not os.path.exists(sess_path):
                    continue
                try:
                    with open(sess_path) as f:
                        sess = json.load(f)
                except Exception:
                    continue
                ci = sess.get("circuit_info") or {}
                if ci.get("track_coordinates"):
                    logger.info(
                        f"Resolved live circuit_info for '{event_name}' from "
                        f"session_{year}_{rnd}_{stype}.json ({len(ci['track_coordinates'])} pts)"
                    )
                    return ci
    return None


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
        # Driver-status snapshot for live retirements (Retired/Stopped/KnockedOut).
        # Keyed by abbreviation. Pushed to new WS clients in `session_init`.
        self.driver_statuses: Dict[str, Dict[str, Any]] = {}
        # Team-radio captures. Each entry starts as {timestamp, driver,
        # driver_number, audio_url, received_at}; the transcription worker
        # then mutates it with `transcript` (str or None) and
        # `transcript_status` ("ok"|"empty"|"download_failed"|"queued").
        self.team_radios: List[Dict[str, Any]] = []
        # Lazy: only spun up once we get the first TeamRadio capture so the
        # ~80 MB whisper model doesn't load when transcription is unused.
        self._radio_transcriber: Optional[TeamRadioTranscriber] = None

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
            # Unsubscribing alone left the client's send loop waiting forever
            # on a queue nobody fills (a silent freeze): drop its backlog and
            # end its stream with a resync message instead
            self._subscribers.remove(q)
            dropped = 0
            while not q.empty():
                q.get_nowait()
                dropped += 1
            q.put_nowait(RESYNC_MESSAGE)
            logger.warning(f"Client queue full: dropped {dropped} queued messages, "
                           f"sent resync (clients left: {len(self._subscribers)})")

    # ── Snapshot (full state for new connections) ─────────────────────

    def get_snapshot(self) -> Dict[str, Any]:
        """Return full accumulated session data matching /api/session format."""
        # SignalR's SessionInfo carries event_name but no track shape — backfill
        # circuit_info from the most recent cached session for the same GP so
        # the live TrackMap has coordinates from lap 1.
        circuit_info = self.session_info.get("circuit_info") or {}
        if not circuit_info.get("track_coordinates"):
            event_name = self.session_info.get("event_name")
            if event_name:
                cached_ci = _lookup_cached_circuit(event_name)
                if cached_ci:
                    circuit_info = cached_ci
                    # Cache so we don't hit disk on every snapshot/WS reconnect
                    self.session_info["circuit_info"] = cached_ci
        return {
            "lap_times": self.lap_times,
            "circuit_info": circuit_info,
            "driver_info": self.driver_info,
            "race_results": self.race_results,
            "weather_data": self.weather_data,
            "tyre_strategy": self.tyre_strategy,
            "track_status": self.track_status,
            "session_info": self.session_info,
            "session_status": self.session_status,
            "current_lap": self.current_lap,
            "total_laps": self.total_laps,
            "driver_statuses": list(self.driver_statuses.values()),
            "race_control_messages": self.race_control_messages,
            "team_radios": self.team_radios,
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

    def set_session_time(self, t: Optional[float]):
        """Pin the session clock (mock replay: the replayed session's own time
        of the next message), so the live times equal the replay's."""
        self.normalizer.set_session_time(t)

    async def on_message(self, topic: str, data: Any):
        """Route a SignalR message to the appropriate handler."""
        # Starts the session clock on the first message after a reset
        self.normalizer.session_time()
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
            elif topic == "TeamRadio":
                await self._handle_team_radio(data)
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

        # Drop any lap_times entries whose Driver field is still a raw
        # racing number (i.e. were emitted before the DriverList arrived
        # in an earlier process_timing_data run that predates the no-Tla
        # guard). Without this, viewers see ghost rows like "1", "11"
        # next to the proper "VER", "PER" rows.
        valid_abbrs = {d["Abbreviation"] for d in self.driver_info}
        if self.lap_times:
            before = len(self.lap_times)
            self.lap_times = [
                lt for lt in self.lap_times
                if lt.get("Driver") in valid_abbrs
            ]
            removed = before - len(self.lap_times)
            if removed:
                logger.info(f"Scrubbed {removed} pre-DriverList lap_times entries with raw racing numbers")

        self.session_active = True
        await self._broadcast({
            "type": "driver_list",
            "data": self.driver_info,
        })

    async def _handle_timing_data(self, data: Dict):
        lap_updates, strategy_updates, status_updates = self.normalizer.process_timing_data(data)

        for lap_entry in lap_updates:
            self.lap_times.append(lap_entry)
            logger.info(f"lap_update: {lap_entry.get('Driver')} L{lap_entry.get('LapNumber')} "
                        f"{lap_entry.get('LapTimeSeconds', '?')}s")
            await self._broadcast({
                "type": "lap_update",
                "data": lap_entry,
            })

        for status_entry in status_updates:
            # Maintain a server-side copy so newly connecting clients receive
            # the current retirement set in their initial snapshot.
            self.driver_statuses[status_entry["Driver"]] = status_entry
            logger.info(f"driver_status: {status_entry['Driver']} retired={status_entry['Retired']} "
                        f"stopped={status_entry['Stopped']} lap={status_entry['LastLap']}")
            await self._broadcast({
                "type": "driver_status",
                "data": status_entry,
            })

        corrected = await self._apply_stints(strategy_updates)

        # Broadcast position update with current standings
        if lap_updates or strategy_updates or corrected:
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
            _, strategy_updates, _ = self.normalizer.process_timing_data(wrapper)
            await self._apply_stints(strategy_updates)

    async def _apply_stints(self, strategy_updates: List[Dict[str, Any]]) -> bool:
        """Apply the normalizer's stint output: the corrections of entries
        already sent (stint_corrections), then the new entries. True when a
        correction was applied."""
        corrections = self.normalizer.take_stint_corrections()
        for driver, stints in corrections.items():
            await self._replace_stints(driver, stints)
        for stint_entry in strategy_updates:
            await self._add_stint(stint_entry)
        return bool(corrections)

    async def _replace_stints(self, driver: str, stints: List[Dict[str, Any]]):
        """Replace a driver's tyre_strategy entries with the feed's corrected
        list (a compound corrected after the stint was sent, a pit-lane pass
        that turned out to be a tyre change or the reverse), in place in the
        list. Each stint but the last closes on the lap before the next one
        (as _add_stint); the last stays open.

        Broadcast as 'strategy_update' messages, one per entry of the
        driver's corrected list, in order: the dashboard appends every
        'strategy_update' and has no other stint message (frontend
        useF1Store.js _handleLiveMessage), and a lap shows the driver's
        last entry that starts on or before it, so the whole list sent
        again, from lap 1, is what an open dashboard ends up showing. The
        'strategy_correction' message used before had no consumer: a
        connected client kept the old compound until it reconnected (16
        FastF1 stints of the recorded feed, verify_live/
        r2_client_strategy_view_WORKTREE.txt); now the client is right on
        the 1532 of 1552 the server is right on (notes/experiments/phase8/
        repair_r2/AFTER_r2_client_strategy_view.txt). A reconnecting client
        gets the corrected list alone (session_init)."""
        stints = [dict(s) for s in stints]
        for cur, nxt in zip(stints, stints[1:]):
            cur["EndLap"] = nxt["StartLap"] - 1
            cur["TotalLaps"] = max(0, cur["EndLap"] - cur["StartLap"] + 1)
        if stints:
            stints[-1]["EndLap"], stints[-1]["TotalLaps"] = None, 0
        others_before = 0
        for s in self.tyre_strategy:
            if s["Driver"] == driver:
                break
            others_before += 1
        others = [s for s in self.tyre_strategy if s["Driver"] != driver]
        self.tyre_strategy = others[:others_before] + stints + others[others_before:]
        for stint_entry in stints:
            await self._broadcast({
                "type": "strategy_update",
                "data": stint_entry,
            })

    async def _add_stint(self, stint_entry: Dict[str, Any]):
        """Append a new stint and close the driver's previous open one on
        the lap before it. StartLap comes from normalizer._process_stints
        (the lap a stint arrived on, or the feed's cumulative stint laps for
        the past stints of a mid-race snapshot, which so close on their own
        laps); a stint left with no completed lap keeps EndLap = StartLap - 1
        and TotalLaps 0 (DECISIONS.md R3)."""
        for existing in reversed(self.tyre_strategy):
            if existing["Driver"] == stint_entry["Driver"] and existing["EndLap"] is None:
                existing["EndLap"] = stint_entry["StartLap"] - 1
                existing["TotalLaps"] = max(0, existing["EndLap"] - existing["StartLap"] + 1)
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
        if status_entry is None:
            return  # the status in force, sent again by a re-subscription
        # Close previous status period (session seconds, leader's lap)
        if self.track_status:
            self.track_status[-1]["end_time"] = status_entry["start_time"]
            self.track_status[-1]["end_lap"] = status_entry["start_lap"]
        self.track_status.append(status_entry)
        await self._broadcast({
            "type": "track_status",
            "data": status_entry,
        })

    async def _handle_race_control(self, data: Dict):
        # Only messages not seen before: a re-subscription resends them all
        messages = self.normalizer.process_race_control(data)
        if isinstance(messages, list):
            self.race_control_messages.extend(messages)
            for msg in messages:
                await self._broadcast({
                    "type": "race_control",
                    "data": msg,
                })

    async def fetch_static_team_radios(self, session_path: Optional[str] = None) -> Dict[str, Any]:
        """Pull the full TeamRadio.json from F1's static CDN.

        F1 paywalls this file during live sessions (returns 403). It opens up
        once the session ends or for any past session, so we use it to
        backfill everything that wasn't pushed via SignalR.

        Returns a dict with `status` and `added` count for the API caller.
        """
        path = session_path or self.session_info.get("path", "")
        if not path:
            return {"status": "no_session_path", "added": 0}
        url = f"https://livetiming.formula1.com/static/{path}TeamRadio.json"
        try:
            import aiohttp
            async with aiohttp.ClientSession() as http:
                async with http.get(url, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                    if resp.status == 403:
                        logger.info(
                            f"TeamRadio.json paywalled (live session in progress): {url}"
                        )
                        return {"status": "paywalled", "added": 0, "url": url}
                    if resp.status != 200:
                        logger.warning(f"TeamRadio.json fetch {resp.status}: {url}")
                        return {"status": f"http_{resp.status}", "added": 0, "url": url}
                    raw = await resp.text()
        except Exception as e:
            logger.warning(f"TeamRadio.json fetch failed: {e}")
            return {"status": "fetch_failed", "added": 0, "error": str(e)}

        # F1 prefixes a UTF-8 BOM on these files
        raw = raw.lstrip("﻿")
        try:
            payload = json.loads(raw)
        except Exception as e:
            logger.warning(f"TeamRadio.json parse failed: {e}")
            return {"status": "parse_failed", "added": 0}

        captures = self.normalizer.process_team_radio(payload, path)
        # Skip ones we've already broadcast (match by audio_url)
        existing_urls = {r.get("audio_url") for r in self.team_radios}

        # Lazy-start transcriber on first capture
        new_caps = [c for c in captures if c.get("audio_url") not in existing_urls]
        if new_caps and self._radio_transcriber is None:
            self._radio_transcriber = TeamRadioTranscriber()
            await self._radio_transcriber.start()

        for cap in new_caps:
            cap["transcript"] = None
            cap["transcript_status"] = "queued"
            self.team_radios.append(cap)
            await self._broadcast({"type": "team_radio", "data": cap})

            if self._radio_transcriber is not None:
                async def _on_done(updated_cap, _orig=cap):
                    await self._broadcast({
                        "type": "team_radio_transcript",
                        "data": {
                            "audio_url": updated_cap.get("audio_url"),
                            "transcript": updated_cap.get("transcript"),
                            "transcript_status": updated_cap.get("transcript_status"),
                        },
                    })
                self._radio_transcriber.submit(cap, _on_done)

        logger.info(f"TeamRadio backfill: +{len(new_caps)} captures from {url}")
        return {"status": "ok", "added": len(new_caps), "total": len(self.team_radios)}

    async def _handle_team_radio(self, data: Dict):
        # SessionInfo's `path` is the static-asset prefix (e.g.
        # "2025/2025-05-04_Miami_Grand_Prix/2025-05-04_Race/"). Without it
        # the audio URLs come out malformed; bail rather than emit broken
        # links.
        session_path = self.session_info.get("path", "")
        if not session_path:
            logger.warning("TeamRadio received before SessionInfo path is known — dropping")
            return
        captures = self.normalizer.process_team_radio(data, session_path)
        # A re-subscription resends every capture so far (the Captures
        # snapshot): skip the ones already kept, as the static backfill does
        known_urls = {r.get("audio_url") for r in self.team_radios}
        captures = [c for c in captures if c.get("audio_url") not in known_urls]

        # Lazy-start the transcriber on first capture so we don't pay the
        # ~80 MB model-load cost on every backend boot.
        if captures and self._radio_transcriber is None:
            self._radio_transcriber = TeamRadioTranscriber()
            await self._radio_transcriber.start()

        for cap in captures:
            cap["transcript"] = None
            cap["transcript_status"] = "queued"
            self.team_radios.append(cap)
            logger.info(f"team_radio: {cap.get('driver')} @ {cap.get('timestamp')}")
            await self._broadcast({
                "type": "team_radio",
                "data": cap,
            })

            # Submit for background transcription. The callback fires WHEN the
            # transcript is ready and broadcasts an update message that the
            # frontend matches by audio_url.
            if self._radio_transcriber is not None:
                async def _on_done(updated_cap, _orig=cap):
                    logger.info(
                        f"team_radio_transcript: {updated_cap.get('driver')} "
                        f"[{updated_cap.get('transcript_status')}] "
                        f"'{(updated_cap.get('transcript') or '')[:80]}'"
                    )
                    await self._broadcast({
                        "type": "team_radio_transcript",
                        "data": {
                            "audio_url": updated_cap.get("audio_url"),
                            "transcript": updated_cap.get("transcript"),
                            "transcript_status": updated_cap.get("transcript_status"),
                        },
                    })
                self._radio_transcriber.submit(cap, _on_done)

    async def _handle_timing_stats(self, data: Dict):
        """TimingStats contains per-driver personal bests — keep the best lap time.

        A personal best is not a lap row: the lap it was set on already has
        its row (TimingData LastLapTime), so the row this used to emit was a
        duplicate, labelled with the driver's current lap instead of the lap
        the best was set on."""
        lines = data.get("Lines", data)
        if not isinstance(lines, dict):
            return
        from .data_normalizer import _parse_lap_time
        for num, stats in lines.items():
            if not isinstance(stats, dict):
                continue
            info = self.normalizer.driver_map.get(str(num), {})
            if not info.get("Tla"):
                continue  # before DriverList: no abbreviation to file it under
            abbr = info["Tla"]
            self.normalizer._ensure_driver_state(abbr)
            state = self.normalizer.driver_state[abbr]

            pb = stats.get("PersonalBestLapTime")
            if isinstance(pb, dict):
                val = pb.get("Value")
                pb_sec = _parse_lap_time(val) if val else None
                if pb_sec and pb_sec > 0:
                    if state["best_lap_time"] is None or pb_sec < state["best_lap_time"]:
                        state["best_lap_time"] = pb_sec

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
            # F1 paywalls TeamRadio.json during live sessions — once the
            # session ends it usually opens up. Try the static CDN backfill
            # so the user gets every radio (with transcripts) for the
            # session they just watched.
            try:
                result = await self.fetch_static_team_radios()
                logger.info(f"Post-session TeamRadio backfill: {result}")
            except Exception as e:
                logger.warning(f"Post-session TeamRadio backfill failed: {e}")

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
        # Tear down the transcriber so a stale model doesn't keep accepting
        # work for the old session. Re-created lazily on next radio capture.
        if self._radio_transcriber is not None:
            try:
                # Fire-and-forget — runs on the existing loop.
                asyncio.create_task(self._radio_transcriber.stop())
            except RuntimeError:
                pass
            self._radio_transcriber = None
        self.normalizer = LiveDataNormalizer()
        self.session_info = {}
        self.driver_info = []
        self.lap_times = []
        self.tyre_strategy = []
        self.weather_data = []
        self.track_status = []
        self.race_control_messages = []
        self.race_results = []
        self.driver_statuses = {}
        self.team_radios = []
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
