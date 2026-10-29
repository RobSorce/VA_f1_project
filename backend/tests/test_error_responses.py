"""Error answers never carry an exception's text (api/errors.py).

The routes answered a failure with str(e) (HTTP 500 detail, or a 200 with
{"error": str(e)} on the live routes), which can name files, folders, hosts
or tokens. Now each failure is a status code with a generic message, and the
exception's text and traceback go to the server log. Each case below makes
the work behind a route raise an exception whose text is SENSITIVE.
"""
import logging

import pandas as pd
import pytest

import api.main as main
from api.errors import GENERIC_DETAIL
from api.routers import live
from asgi_client import call

SENSITIVE = r"C:\Users\owner\AppData\Local\fastf1\token=7f3a9c"
JSON = {"content-type": "application/json"}


def boom(*a, **k):
    raise RuntimeError(SENSITIVE)


@pytest.fixture
def failing(tmp_path, monkeypatch, caplog):
    """Empty caches in tmp_path, and every FastF1 call raising SENSITIVE."""
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(main, "DISK_CACHE_DIR", tmp_path)
    for name in ("session_cache", "schedule_cache", "championship_cache"):
        monkeypatch.setattr(main, name, {})
    # The raw session cache is one dict, main.raw_session_cache and
    # app.state.raw_session_cache: emptied in place and refilled after, since
    # pytest 9.2's monkeypatch does not see the values a Starlette State keeps
    saved = dict(main.raw_session_cache)
    main.raw_session_cache.clear()
    monkeypatch.setattr(main.extractor, "get_session", boom)
    monkeypatch.setattr(main.extractor, "get_event_schedule", boom)
    yield caplog
    main.raw_session_cache.clear()
    main.raw_session_cache.update(saved)


def assert_generic(r, status, caplog):
    assert r.status_code == status, (r.status_code, r.text)
    assert SENSITIVE not in r.text and "RuntimeError" not in r.text and "token" not in r.text
    assert "server log" in r.json()["detail"]
    # the details are in the server log, with the traceback
    logged = [rec for rec in caplog.records if rec.exc_info and SENSITIVE in str(rec.exc_info[1])]
    assert logged, "the exception was not logged with its traceback"


@pytest.mark.parametrize("method,target,body", [
    ("GET", "/api/session/2024/16", None),
    ("GET", "/api/laptimes/2024/16", None),
    ("GET", "/api/telemetry/2024/16/LEC", None),
    ("GET", "/api/positions/2024/16", None),
    ("GET", "/api/frames/2024/16", None),
    ("GET", "/api/schedule/2024", None),
    ("GET", "/api/championship/2024", None),
    ("GET", "/api/championship/2024?load_all=true", None),
    ("GET", "/api/session/2024/16/R/replay", None),
    ("GET", "/api/analytics/sectors/2024/16", None),
    ("POST", "/api/predict/degradation",
     dict(year=2024, round=16, drivers=["LEC"], lap_start=1, lap_end=50)),
])
def test_a_failing_route_answers_500_without_the_exception(failing, method, target, body):
    r = call(main.app, method, target, body)
    assert_generic(r, 500, failing)
    assert r.exception is None  # handled by the route, not left to the server


class FakeManager:
    session_info = {"start_date": "2024-09-01", "event_name": "Italian", "session_name": "Race"}
    lap_times, driver_info, driver_statuses = [], {}, {}

    def reset(self):
        raise RuntimeError(SENSITIVE)

    async def start_openf1(self, session_key=None):
        raise RuntimeError(SENSITIVE)


class FakeReplay:
    is_running = False

    def __init__(self, error):
        self.error = error

    async def start(self, *a):
        raise self.error


def test_the_live_routes_answer_with_a_status_code(failing, monkeypatch):
    import fastf1
    manager = FakeManager()
    monkeypatch.setattr(main, "_live_session_manager", manager)
    monkeypatch.setattr(main, "_live_signalr_task", None)
    monkeypatch.setattr(live, "_session_manager", manager)
    monkeypatch.setattr(fastf1, "get_event_schedule", boom)

    assert_generic(call(main.app, "POST", "/api/live/connect-signalr", {"reset": True}), 500, failing)
    assert_generic(call(main.app, "POST", "/api/live/openf1/start", {}), 500, failing)
    assert_generic(call(main.app, "GET", "/api/live/load-full-session"), 500, failing)

    monkeypatch.setattr(live, "_mock_replay", FakeReplay(RuntimeError(SENSITIVE)))
    assert_generic(call(main.app, "POST", "/api/live/mock/start", {"year": 2024, "round": 16}), 500, failing)
    # a race not cached: 404, its message names the race, not the file
    monkeypatch.setattr(live, "_mock_replay", FakeReplay(FileNotFoundError(SENSITIVE)))
    r = call(main.app, "POST", "/api/live/mock/start", {"year": 2024, "round": 16})
    assert r.status_code == 404 and SENSITIVE not in r.text
    assert r.json()["detail"] == "No cached session for 2024 round 16: load it once first."


def test_the_live_answers_without_a_session_carry_a_status_code(monkeypatch):
    monkeypatch.setattr(main, "_live_session_manager", None)
    monkeypatch.setattr(live, "_session_manager", None)
    monkeypatch.setattr(live, "_mock_replay", None)
    for method, target, body in [
        ("POST", "/api/live/connect-signalr", {}), ("POST", "/api/live/reset", {}),
        ("POST", "/api/live/load-team-radios", {}), ("GET", "/api/live/load-full-session", None),
        ("GET", "/api/live/snapshot", None), ("POST", "/api/live/openf1/start", {}),
        ("POST", "/api/live/openf1/stop", {}), ("POST", "/api/live/mock/start", {}),
    ]:
        r = call(main.app, method, target, body)
        assert r.status_code == 503, (target, r.status_code, r.text)
        assert "not initialized" in r.json()["detail"]
    manager = FakeManager()
    manager.session_info = {}
    monkeypatch.setattr(main, "_live_session_manager", manager)
    assert call(main.app, "GET", "/api/live/load-full-session").status_code == 409


def test_an_exception_no_route_catches_is_a_generic_500(failing, monkeypatch):
    monkeypatch.setattr(main, "load_pca_embeddings", boom)
    r = call(main.app, "GET", "/api/pca/embeddings")
    assert r.status_code == 500
    assert r.json() == {"detail": GENERIC_DETAIL}
    assert SENSITIVE not in r.text
    # handed on to the server, which logs it with its traceback
    assert isinstance(r.exception, RuntimeError) and SENSITIVE in str(r.exception)


def test_the_team_radio_fetch_failure_keeps_its_text_in_the_log(monkeypatch, caplog):
    import asyncio
    import aiohttp
    from live.session_manager import LiveSessionManager

    class Broken:
        def __init__(self, *a, **k):
            raise RuntimeError(SENSITIVE)
    monkeypatch.setattr(aiohttp, "ClientSession", Broken)
    caplog.set_level(logging.INFO)
    out = asyncio.run(LiveSessionManager().fetch_static_team_radios("2024/2024-09-01_Italian_Grand_Prix/2024-09-01_Race/"))
    assert out == {"status": "fetch_failed", "added": 0}
    assert any(rec.exc_info and SENSITIVE in str(rec.exc_info[1]) for rec in caplog.records)


def test_no_route_sends_an_exception_text():
    """No str(e) / str(exc) left in an answer of the API modules."""
    from conftest import BACKEND
    import re
    for path in [BACKEND / "api" / "main.py", *sorted((BACKEND / "api" / "routers").glob("*.py"))]:
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"detail\s*=\s*str\(", text), path.name
        assert not re.search(r"""["']error["']\s*:\s*str\(""", text), path.name
