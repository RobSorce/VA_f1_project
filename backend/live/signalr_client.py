"""
F1 Live Timing SignalR Client

Connects to the Formula 1 live timing SignalR hub at livetiming.formula1.com
using the legacy SignalR 1.5 protocol. Provides real-time timing data including
lap times, sector times, positions, gaps, tyre compounds, weather, and telemetry.
"""
import asyncio
import json
import logging
import base64
import zlib
import re
import time
from typing import Callable, Optional, List, Dict, Any
from urllib.parse import quote

import aiohttp

logger = logging.getLogger(__name__)

# F1 Live Timing endpoints
BASE_URL = "https://livetiming.formula1.com"
SIGNALR_URL = f"{BASE_URL}/signalr"
HUB_NAME = "streaming"

# Topics to subscribe to
LIVE_TOPICS = [
    "TimingData",
    "TimingAppData",
    "CarData.z",
    "Position.z",
    "WeatherData",
    "TrackStatus",
    "RaceControlMessages",
    "DriverList",
    "SessionInfo",
    "LapCount",
    "SessionStatus",
    "TimingStats",
    "ExtrapolatedClock",
    "TeamRadio",
    "HeartBeat",
]

# Compressed topics (zlib + base64)
COMPRESSED_TOPICS = {"CarData.z", "Position.z"}


def _fix_python_json(raw: str) -> str:
    """Fix Python-style JSON from F1 feed (True/False/None, single quotes)."""
    # Replace Python booleans and None with JSON equivalents
    s = raw
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"\bNone\b", "null", s)
    # Replace single quotes with double quotes (careful with apostrophes)
    # Only do this if the string doesn't parse as JSON directly
    return s


def _decompress_z(data_str: str) -> Any:
    """Decompress base64-encoded zlib data from .z topics."""
    try:
        raw_bytes = base64.b64decode(data_str)
        decompressed = zlib.decompress(raw_bytes, -zlib.MAX_WBITS)
        text = decompressed.decode("utf-8")
        return json.loads(text)
    except Exception as e:
        logger.debug(f"Decompression failed: {e}")
        return None


class F1SignalRClient:
    """Async client for the F1 Live Timing SignalR 1.5 hub."""

    def __init__(self, on_message: Callable[[str, Any], None]):
        """
        Args:
            on_message: Callback invoked as on_message(topic, data) for each
                        received message. Called from the asyncio event loop.
        """
        self._on_message = on_message
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._running = False
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 30.0
        self._connection_token: Optional[str] = None
        self._message_id: Optional[str] = None
        self._groups_token: Optional[str] = None
        self._invoke_id = 0

    async def start(self):
        """Start the client with auto-reconnect loop."""
        self._running = True
        while self._running:
            try:
                await self._connect_and_listen()
            except asyncio.CancelledError:
                break
            except Exception as e:
                if not self._running:
                    break
                logger.warning(f"SignalR connection error: {e}. Reconnecting in {self._reconnect_delay:.0f}s...")
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)

        await self._cleanup()

    async def stop(self):
        """Stop the client gracefully."""
        self._running = False
        if self._ws and not self._ws.closed:
            await self._ws.close()
        await self._cleanup()

    async def _cleanup(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def _connect_and_listen(self):
        """Negotiate, connect, subscribe, and listen for messages."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()

        # Step 1: Negotiate
        self._connection_token = await self._negotiate()
        logger.info("SignalR negotiation successful")

        # Step 2: Connect via WebSocket
        ws_url = self._build_ws_url("connect")
        logger.info(f"Connecting to SignalR WebSocket...")

        self._ws = await self._session.ws_connect(
            ws_url,
            heartbeat=30.0,
            timeout=aiohttp.ClientTimeout(total=None),
        )

        # Wait for init message {"S":1}
        init_msg = await asyncio.wait_for(self._ws.receive(), timeout=15)
        if init_msg.type == aiohttp.WSMsgType.TEXT:
            init_data = json.loads(init_msg.data)
            if init_data.get("S") == 1:
                logger.info("SignalR connection initialized")

        # Step 3: Subscribe to topics
        await self._subscribe(LIVE_TOPICS)
        logger.info(f"Subscribed to {len(LIVE_TOPICS)} topics")

        # Reset reconnect delay on successful connection
        self._reconnect_delay = 1.0

        # Step 4: Listen for messages
        await self._listen()

    async def _negotiate(self) -> str:
        """Perform SignalR negotiate handshake to get connection token."""
        params = {
            "connectionData": json.dumps([{"name": HUB_NAME}]),
            "clientProtocol": "1.5",
        }
        url = f"{SIGNALR_URL}/negotiate"

        async with self._session.get(url, params=params) as resp:
            resp.raise_for_status()
            data = await resp.json()
            token = data.get("ConnectionToken")
            if not token:
                raise ValueError("No ConnectionToken in negotiate response")
            return token

    def _build_ws_url(self, action: str) -> str:
        """Build WebSocket URL for connect/reconnect."""
        token_encoded = quote(self._connection_token, safe="")
        conn_data = quote(json.dumps([{"name": HUB_NAME}]), safe="")
        url = (
            f"wss://livetiming.formula1.com/signalr/{action}"
            f"?transport=webSockets"
            f"&connectionToken={token_encoded}"
            f"&connectionData={conn_data}"
            f"&clientProtocol=1.5"
        )
        if self._message_id:
            url += f"&messageId={quote(str(self._message_id), safe='')}"
        if self._groups_token:
            url += f"&groupsToken={quote(self._groups_token, safe='')}"
        return url

    async def _subscribe(self, topics: List[str]):
        """Send subscribe message to the hub."""
        self._invoke_id += 1
        msg = {
            "H": HUB_NAME,
            "M": "Subscribe",
            "A": [topics],
            "I": str(self._invoke_id),
        }
        await self._ws.send_json(msg)

    async def _listen(self):
        """Main message loop — receives and dispatches SignalR messages."""
        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                if not msg.data or msg.data == "{}":
                    continue  # keepalive
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    # Try fixing Python-style JSON
                    try:
                        data = json.loads(_fix_python_json(msg.data))
                    except Exception:
                        logger.debug(f"Unparseable message: {msg.data[:200]}")
                        continue

                # Update message tracking tokens
                if "C" in data:
                    self._message_id = data["C"]
                if "G" in data:
                    self._groups_token = data["G"]

                # Process messages in the "M" array (hub invocations)
                if "M" in data and isinstance(data["M"], list):
                    for m in data["M"]:
                        hub = m.get("H", "")
                        method = m.get("M", "")
                        args = m.get("A", [])
                        if args:
                            self._dispatch_message(method, args)

                # Process "R" (invoke result — initial data dump after subscribe)
                # Order: DriverList → TimingAppData → everything else
                # so abbreviation map and compounds are ready for TimingData
                if "R" in data and isinstance(data["R"], dict):
                    r_data = data["R"]
                    priority_order = ["DriverList", "TimingAppData"]
                    for topic in priority_order:
                        if topic in r_data:
                            self._process_topic(topic, r_data[topic])
                    for topic, payload in r_data.items():
                        if topic in priority_order:
                            continue  # already processed
                        self._process_topic(topic, payload)

                # Some messages come directly as topic updates
                if "A" in data:
                    for item in data["A"]:
                        if isinstance(item, dict):
                            for topic, payload in item.items():
                                self._process_topic(topic, payload)

            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                logger.warning(f"WebSocket closed/error: {msg.type}")
                break

    def _dispatch_message(self, method: str, args: list):
        """Dispatch a hub method invocation."""
        if not args:
            return
        # The first arg is usually a dict of topic→data
        payload = args[0]
        if isinstance(payload, dict):
            for topic, data in payload.items():
                self._process_topic(topic, data)
        elif isinstance(payload, str):
            # Sometimes it's a single topic name with data in args[1]
            if len(args) >= 2:
                self._process_topic(payload, args[1])

    def _process_topic(self, topic: str, data: Any):
        """Process a single topic update, decompressing if needed."""
        # Handle compressed topics
        if topic in COMPRESSED_TOPICS and isinstance(data, str):
            decompressed = _decompress_z(data)
            if decompressed is not None:
                clean_topic = topic.replace(".z", "")
                self._on_message(clean_topic, decompressed)
            else:
                logger.warning(f"Decompression failed for {topic}, data[:80]={data[:80]}")
            return

        # Handle nested compressed data (sometimes the value is a dict with compressed entries)
        if topic in COMPRESSED_TOPICS and isinstance(data, dict):
            for key, val in data.items():
                if isinstance(val, str):
                    decompressed = _decompress_z(val)
                    if decompressed is not None:
                        clean_topic = topic.replace(".z", "")
                        self._on_message(clean_topic, decompressed)
            return

        # Regular topic
        self._on_message(topic, data)

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and not self._ws.closed
