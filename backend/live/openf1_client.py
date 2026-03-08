"""
OpenF1 API Client for Live Telemetry

Polls the OpenF1 API (https://api.openf1.org) for car telemetry and position
data during live F1 sessions.

IMPORTANT: As of 2025, the free OpenF1 API is fully locked during live sessions.
An API key (paid subscription) is required for real-time access. Without a key,
the client will still work for post-session data (after the session ends) and
during non-race periods.

Endpoints used:
  - /v1/car_data   -> speed, throttle, brake, gear, RPM, DRS (~3.7 Hz)
  - /v1/location   -> x, y, z car coordinates (~3.7 Hz)
  - /v1/sessions   -> find the current/latest session key

With API key: real-time data with ~3s latency
Without key: historical data only (blocked during live sessions)
"""
import asyncio
import logging
import os
import time
from typing import Any, Callable, Dict, List, Optional

import aiohttp

logger = logging.getLogger(__name__)

BASE_URL = "https://api.openf1.org/v1"

# Polling intervals (seconds)
TELEMETRY_POLL_INTERVAL = 2.0    # car_data + location every 2s
SESSION_POLL_INTERVAL = 60.0     # check for active session every 60s
LOCKED_RETRY_INTERVAL = 30.0     # retry when API is locked (live session)

# How far back to look on first request (seconds)
INITIAL_LOOKBACK = 30


class OpenF1Client:
    """Async client that polls OpenF1 for live telemetry data."""

    def __init__(self, on_car_data: Callable, on_location: Callable,
                 api_key: Optional[str] = None):
        """
        Args:
            on_car_data: async callback(driver_number, samples_list)
            on_location: async callback(driver_number, samples_list)
            api_key: Optional OpenF1 API key for real-time access during live sessions
        """
        self._on_car_data = on_car_data
        self._on_location = on_location
        self._api_key = api_key or os.environ.get("OPENF1_API_KEY")
        self._session: Optional[aiohttp.ClientSession] = None
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._api_locked = False  # True when API returns 402/403 during live session

        # Current OpenF1 session key
        self._session_key: Optional[int] = None

        # Track last-seen timestamps to avoid duplicate data
        self._last_car_data_date: Optional[str] = None
        self._last_location_date: Optional[str] = None

        # Rate limiter
        self._request_times: List[float] = []

    async def start(self, session_key: Optional[int] = None):
        """Start polling. Optionally provide a known session_key."""
        self._running = True
        self._session_key = session_key
        self._last_car_data_date = None
        self._last_location_date = None
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(f"OpenF1 client started (session_key={session_key})")

    async def stop(self):
        """Stop polling."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
        logger.info("OpenF1 client stopped")

    async def _ensure_session(self):
        if self._session is None or self._session.closed:
            headers = {}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10),
                headers=headers,
            )

    async def _rate_limit(self):
        """Simple rate limiter: max 3 requests per second."""
        now = time.monotonic()
        # Remove timestamps older than 1 second
        self._request_times = [t for t in self._request_times if now - t < 1.0]
        if len(self._request_times) >= 3:
            wait = 1.0 - (now - self._request_times[0])
            if wait > 0:
                await asyncio.sleep(wait)
        self._request_times.append(time.monotonic())

    async def _get(self, endpoint: str, params: Dict[str, Any]) -> Optional[List[Dict]]:
        """Make a rate-limited GET request to OpenF1 API."""
        await self._ensure_session()
        await self._rate_limit()

        url = f"{BASE_URL}/{endpoint}"
        try:
            async with self._session.get(url, params=params) as resp:
                if resp.status == 200:
                    self._api_locked = False
                    return await resp.json()
                elif resp.status == 429:
                    logger.warning("OpenF1 rate limited — backing off 5s")
                    await asyncio.sleep(5)
                    return None
                elif resp.status in (402, 403):
                    # API is locked during live sessions without a key
                    if not self._api_locked:
                        logger.warning(
                            "OpenF1 API locked (live session in progress). "
                            "Set OPENF1_API_KEY env var for real-time access. "
                            f"Will retry every {LOCKED_RETRY_INTERVAL}s."
                        )
                        self._api_locked = True
                    return None
                else:
                    logger.warning(f"OpenF1 {endpoint} returned {resp.status}")
                    return None
        except asyncio.TimeoutError:
            logger.debug(f"OpenF1 {endpoint} request timed out")
            return None
        except Exception as e:
            logger.debug(f"OpenF1 {endpoint} request failed: {e}")
            return None

    async def find_active_session(self) -> Optional[int]:
        """Find the most recent / active session on OpenF1."""
        data = await self._get("sessions", {"session_key": "latest"})
        if data and len(data) > 0:
            session = data[0] if isinstance(data, list) else data
            key = session.get("session_key")
            if key:
                logger.info(f"OpenF1 active session: {key} "
                           f"({session.get('session_name', '?')} - "
                           f"{session.get('meeting_name', '?')})")
                return int(key)
        return None

    async def _poll_loop(self):
        """Main polling loop for car_data and location."""
        try:
            # Find session if not provided
            if self._session_key is None:
                self._session_key = await self.find_active_session()
                if self._session_key is None:
                    logger.warning("No active OpenF1 session found — will retry in 60s")
                    while self._running and self._session_key is None:
                        await asyncio.sleep(SESSION_POLL_INTERVAL)
                        self._session_key = await self.find_active_session()
                    if not self._running:
                        return

            logger.info(f"OpenF1 polling started for session {self._session_key}"
                        f"{' (with API key)' if self._api_key else ' (free tier)'}")

            while self._running:
                try:
                    if self._api_locked:
                        # API is locked during live session — wait longer before retrying
                        await asyncio.sleep(LOCKED_RETRY_INTERVAL)
                    else:
                        # Poll car_data and location in parallel
                        await asyncio.gather(
                            self._poll_car_data(),
                            self._poll_location(),
                        )
                        await asyncio.sleep(TELEMETRY_POLL_INTERVAL)
                except Exception as e:
                    logger.error(f"OpenF1 poll error: {e}", exc_info=True)
                    await asyncio.sleep(TELEMETRY_POLL_INTERVAL)

        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error(f"OpenF1 poll loop error: {e}", exc_info=True)

    async def _poll_car_data(self):
        """Poll car_data endpoint for speed, throttle, brake, gear, RPM, DRS."""
        params = {"session_key": self._session_key}

        if self._last_car_data_date:
            # Get data newer than last seen
            params["date>"] = self._last_car_data_date
        else:
            # First request — get last N seconds of data
            params["date>"] = f"latest-{INITIAL_LOOKBACK}"

        data = await self._get("car_data", params)
        if not data:
            return

        # Group by driver_number
        by_driver: Dict[str, List[Dict]] = {}
        latest_date = self._last_car_data_date
        for sample in data:
            num = str(sample.get("driver_number", ""))
            if not num:
                continue
            by_driver.setdefault(num, []).append({
                "date": sample.get("date", ""),
                "speed": sample.get("speed", 0),
                "throttle": sample.get("throttle", 0),
                "brake": sample.get("brake", 0),
                "gear": sample.get("n_gear", 0),
                "rpm": sample.get("rpm", 0),
                "drs": sample.get("drs", 0),
            })
            d = sample.get("date", "")
            if d and (latest_date is None or d > latest_date):
                latest_date = d

        if latest_date:
            self._last_car_data_date = latest_date

        # Dispatch to callback
        for driver_num, samples in by_driver.items():
            try:
                await self._on_car_data(driver_num, samples)
            except Exception as e:
                logger.debug(f"car_data callback error for {driver_num}: {e}")

    async def _poll_location(self):
        """Poll location endpoint for x, y, z coordinates."""
        params = {"session_key": self._session_key}

        if self._last_location_date:
            params["date>"] = self._last_location_date
        else:
            params["date>"] = f"latest-{INITIAL_LOOKBACK}"

        data = await self._get("location", params)
        if not data:
            return

        # Group by driver_number
        by_driver: Dict[str, List[Dict]] = {}
        latest_date = self._last_location_date
        for sample in data:
            num = str(sample.get("driver_number", ""))
            if not num:
                continue
            by_driver.setdefault(num, []).append({
                "date": sample.get("date", ""),
                "x": sample.get("x", 0),
                "y": sample.get("y", 0),
                "z": sample.get("z", 0),
            })
            d = sample.get("date", "")
            if d and (latest_date is None or d > latest_date):
                latest_date = d

        if latest_date:
            self._last_location_date = latest_date

        # Dispatch to callback
        for driver_num, samples in by_driver.items():
            try:
                await self._on_location(driver_num, samples)
            except Exception as e:
                logger.debug(f"location callback error for {driver_num}: {e}")

    @property
    def is_running(self) -> bool:
        return self._running
