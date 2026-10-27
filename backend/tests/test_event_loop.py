"""A slow FastF1 load or cache read never stops the server from answering.

/api/championship ran its work (the FastF1 schedule, every cached session
file) on the event loop, so while it loaded no other request was answered;
other routes read multi-MB cache files there too. That work now runs in a
worker thread. Each case holds the route's blocking call (a FastF1 call or a
cache read) at a gate, sends another request while it waits, and checks that
the other request is answered before the gate opens.
"""
import asyncio
import threading
import time

import pandas as pd
import pytest

import api.main as main
from asgi_client import request

GATE_TIMEOUT_S = 5


class Gate:
    """Wraps a blocking function: the call waits until open() (or the timeout)."""

    def __init__(self):
        self.entered = threading.Event()
        self.opened = threading.Event()

    def wrap(self, fn):
        def held(*a, **k):
            self.entered.set()
            self.opened.wait(GATE_TIMEOUT_S)
            return fn(*a, **k)
        return held

    def open(self):
        self.opened.set()


def schedule(year):
    return pd.DataFrame([{"RoundNumber": 1, "EventFormat": "conventional", "EventName": "Test GP",
                          "Country": "Italy", "Location": "Monza", "EventDate": "2024-09-01"}])


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DISK_CACHE_DIR", tmp_path)
    for name in ("session_cache", "schedule_cache", "championship_cache"):
        monkeypatch.setattr(main, name, {})
    monkeypatch.setattr(main.extractor, "get_event_schedule", schedule)
    return tmp_path


def hold(monkeypatch, gate, case):
    """Put the gate on the blocking call of the case's route."""
    if case == "fastf1":
        monkeypatch.setattr(main.extractor, "get_event_schedule", gate.wrap(schedule))
    elif case == "disk":
        monkeypatch.setattr(main, "_load_from_disk", gate.wrap(main._load_from_disk))
    elif case == "csv":
        monkeypatch.setattr(pd, "read_csv", gate.wrap(pd.read_csv))


async def answered_while_held(gate, target):
    """Start the slow request, then ask /api/health. Returns the health answer,
    the seconds from the slow request's start to that answer, whether the slow
    one was still loading then, and its own answer once the gate opens. A
    route that blocks the event loop holds everything until the gate's
    timeout (GATE_TIMEOUT_S), the health answer included."""
    t0 = time.monotonic()
    slow = asyncio.create_task(request(main.app, "GET", target))
    # wait (off the loop) until the slow route is inside its blocking call
    entered = await asyncio.to_thread(gate.entered.wait, GATE_TIMEOUT_S)
    assert entered, "the route never reached its blocking call"
    health = await asyncio.wait_for(request(main.app, "GET", "/api/health"), timeout=2)
    waited = time.monotonic() - t0
    still_loading = not slow.done()
    gate.open()
    slow_answer = await asyncio.wait_for(slow, timeout=GATE_TIMEOUT_S + 5)
    return health, waited, still_loading, slow_answer


@pytest.mark.parametrize("target,case", [
    ("/api/championship/2024", "fastf1"),
    ("/api/championship/2024?load_all=true", "fastf1"),
    ("/api/championship/2024", "disk"),
    ("/api/schedule/2024", "disk"),
    ("/api/frames/2024/16", "disk"),
    ("/api/telemetry/2024/16/LEC", "disk"),
    ("/api/pca/point-features/LEC_2024_16", "csv"),
])
def test_another_request_is_answered_while_a_route_loads(server, monkeypatch, target, case):
    gate = Gate()
    hold(monkeypatch, gate, case)
    if target.startswith("/api/frames") or target.startswith("/api/telemetry"):
        # after the cache read the route would ask FastF1: a fixed answer instead
        monkeypatch.setattr(main, "get_raw_session", lambda *a, **k: object())
        monkeypatch.setattr(main.extractor, "extract_race_frames", lambda s: {"frames": []})
        monkeypatch.setattr(main.extractor, "extract_telemetry", lambda s, d, lap: None)

    health, waited, still_loading, slow_answer = asyncio.run(answered_while_held(gate, target))

    assert health.status_code == 200 and health.json() == {"status": "healthy"}
    assert still_loading, f"{target} finished before /api/health was answered: it held the event loop"
    assert waited < 2.0, f"/api/health waited {waited:.1f} s for {target}: it held the event loop"
    assert slow_answer.status_code in (200, 404), (target, slow_answer.status_code, slow_answer.text)
