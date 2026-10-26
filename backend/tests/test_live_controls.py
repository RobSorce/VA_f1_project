"""The live-timing controls change the server's state: POST with a JSON body.

They were GET requests, so any page, link or image on the network could
reset or start the live session. Now each one answers 405 to a GET and 415
to a POST that is not JSON (a form or plain-text POST, which a page on
another origin can send without a CORS preflight; api/commands.py). The
read-only live routes stay GET.
"""
import pytest

import api.main as main
from api.routers import live
from asgi_client import call

JSON = {"content-type": "application/json"}

# route -> a valid JSON body
CONTROLS = {
    "/api/live/connect-signalr": {"reset": False},
    "/api/live/disconnect-signalr": {},
    "/api/live/reset": {},
    "/api/live/load-team-radios": {},
    "/api/live/mock/start": {"year": 2024, "round": 16, "speed": 10},
    "/api/live/mock/stop": {},
    "/api/live/openf1/start": {"session_key": None},
    "/api/live/openf1/stop": {},
}
READS = ["/api/live/status", "/api/live/snapshot", "/api/live/frames", "/api/live/mock/sessions",
         "/api/live/openf1/status", "/api/live/load-full-session"]


class FakeManager:
    def __init__(self):
        self.calls = []
        self._openf1_enabled = False
        self._openf1_car_data = {}
        self._openf1_positions = {}
        self.lap_times, self.driver_info, self.driver_statuses = [], {}, {}
        self.session_info = {}

    def reset(self):
        self.calls.append("reset")

    async def stop_openf1(self):
        self.calls.append("stop_openf1")

    async def start_openf1(self, session_key=None):
        self.calls.append(("start_openf1", session_key))

    async def fetch_static_team_radios(self):
        self.calls.append("team_radios")
        return {"status": "ok"}

    def get_status(self):
        return {"active": False}

    def get_snapshot(self):
        return {}

    def get_frames_snapshot(self):
        return {"frames": []}


class FakeReplay:
    def __init__(self):
        self.calls = []
        self.is_running = False

    async def start(self, year, round_num, speed):
        self.calls.append(("start", year, round_num, speed))

    async def stop(self):
        self.calls.append("stop")


@pytest.fixture
def live_state(monkeypatch):
    manager, replay = FakeManager(), FakeReplay()
    monkeypatch.setattr(main, "_live_session_manager", manager)
    monkeypatch.setattr(main, "_live_signalr_task", None)
    monkeypatch.setattr(live, "_session_manager", manager)
    monkeypatch.setattr(live, "_mock_replay", replay)
    return manager, replay


@pytest.mark.parametrize("route", CONTROLS)
def test_a_control_is_not_a_get(live_state, route):
    manager, replay = live_state
    r = call(main.app, "GET", f"{route}?reset=true&year=2024&round=16")
    assert r.status_code == 405, (route, r.status_code)
    assert manager.calls == [] and replay.calls == []


@pytest.mark.parametrize("route", CONTROLS)
@pytest.mark.parametrize("ctype,body", [
    (None, b""),
    ("application/x-www-form-urlencoded", b"reset=true&year=2024"),
    ("text/plain", b'{"reset": true}'),
    ("multipart/form-data; boundary=x", b"--x--"),
])
def test_a_control_without_a_json_body_is_refused(live_state, route, ctype, body):
    manager, replay = live_state
    headers = {"content-type": ctype} if ctype else {}
    r = call(main.app, "POST", route, body, headers)
    assert r.status_code == 415, (route, ctype, r.status_code, r.text)
    assert manager.calls == [] and replay.calls == []


def test_the_controls_act_on_a_json_post(live_state):
    manager, replay = live_state
    assert call(main.app, "POST", "/api/live/reset", {}).json() == {"status": "reset"}
    assert call(main.app, "POST", "/api/live/mock/start", CONTROLS["/api/live/mock/start"]).json()["status"] == "started"
    replay.is_running = True
    assert call(main.app, "POST", "/api/live/mock/stop", {}).json() == {"status": "stopped"}
    assert call(main.app, "POST", "/api/live/openf1/start", {"session_key": 9158}).json()["status"] == "started"
    assert call(main.app, "POST", "/api/live/openf1/stop", {}).json() == {"status": "stopped"}
    assert call(main.app, "POST", "/api/live/load-team-radios", {}).json() == {"status": "ok"}
    assert call(main.app, "POST", "/api/live/disconnect-signalr", {}).json() == {"status": "not_connected"}
    assert manager.calls == ["reset", ("start_openf1", 9158), "stop_openf1", "team_radios", "stop_openf1"]
    assert replay.calls == [("start", 2024, 16, 10.0), "stop"]


@pytest.mark.parametrize("body", [
    {"year": 2017}, {"round": 0}, {"round": 31}, {"speed": 0}, {"speed": 1000}, {"year": "../x"},
])
def test_the_mock_replay_parameters_are_bounded(live_state, body):
    r = call(main.app, "POST", "/api/live/mock/start", body)
    assert r.status_code == 422
    assert live_state[1].calls == []


@pytest.mark.parametrize("route", READS)
def test_the_reads_stay_get(live_state, route, monkeypatch):
    route_obj = next(r for r in main.app.router.routes if getattr(r, "path", None) == route) \
        if route == "/api/live/load-full-session" else None
    if route_obj is not None:
        assert route_obj.methods == {"GET"}
        return
    r = call(main.app, "GET", route)
    assert r.status_code == 200, (route, r.status_code)
