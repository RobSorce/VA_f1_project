"""Request values never name a file outside the disk cache.

session_type (and the other request values) went unchecked into the disk
cache file names of api/main.py (session_{year}_{round}_{session_type}.json,
telemetry_..._{driver}_{lap}.json): on Windows a session_type such as
..\\..\\x read any .json file the backend could reach, and the telemetry route
could write one. Now every value is checked where it enters the API
(api/params.py: year and round bounded integers, session type from a fixed
set, driver codes and point ids by pattern; 422 otherwise) and every cache
path is built by api/main.py _cache_file from those parts only, then checked
to resolve to a file directly inside the cache folder.

The requests go to the ASGI app as uvicorn passes them (asgi_client.py):
percent-encoded attempts arrive decoded, as a server decodes them.
"""
import json

import pytest

import api.main as main
from api import params
from asgi_client import call

# Traversal attempts as a client writes them in a URL (query value or path
# segment): dot segments, percent-encoded, backslashes (Windows), absolute
# POSIX and Windows paths, an encoded NUL
ATTEMPTS = [
    "..",
    "../../../secret",
    "..%2F..%2F..%2Fsecret",
    "%2e%2e%2f%2e%2e%2fsecret",
    "..%5C..%5C..%5Csecret",
    "..\\..\\..\\secret",
    "%2Fetc%2Fpasswd",
    "/etc/passwd",
    "C:%5CWindows%5Cwin.ini",
    "C:\\Windows\\win.ini",
    "R%00",
    "R/../../secret",
]

# The content of the file outside the cache folder
SECRET = "LEAKED-7f3a"

# Every route that takes a session type in its query
SESSION_TYPE_ROUTES = [
    "/api/session/2024/16", "/api/laptimes/2024/16", "/api/telemetry/2024/16/LEC",
    "/api/circuit/2024/16", "/api/strategy/2024/16", "/api/drivers/2024/16",
    "/api/results/2024/16", "/api/positions/2024/16", "/api/frames/2024/16",
    "/api/weather/2024/16", "/api/analytics/sectors/2024/16",
    "/api/analytics/consistency/2024/16", "/api/analytics/speed-rankings/2024/16",
]


@pytest.fixture
def jail(tmp_path, monkeypatch):
    """A cache folder in tmp_path with a secret file next to it, and a record of
    every path the backend opens. The folder session_2024_16_.. inside the
    cache lets ../ climb out of it on Linux too, as Windows always allows: the
    old file name session_2024_16_../../../secret.json resolved to the secret."""
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "session_2024_16_..").mkdir()
    (tmp_path / "secret.json").write_text(json.dumps({"lap_times": [{"marker": SECRET}]}))
    monkeypatch.setattr(main, "DISK_CACHE_DIR", cache)
    monkeypatch.setattr(main, "session_cache", {})
    monkeypatch.setattr(main, "schedule_cache", {})
    monkeypatch.setattr(main, "championship_cache", {})
    opened = []
    real_load, real_save = main._load_from_disk, main._save_to_disk
    monkeypatch.setattr(main, "_load_from_disk", lambda p: opened.append(p) or real_load(p))
    monkeypatch.setattr(main, "_save_to_disk", lambda p, d: opened.append(p) or real_save(p, d))

    def no_fastf1(*a, **k):
        raise AssertionError("a rejected request reached FastF1")
    monkeypatch.setattr(main, "get_raw_session", no_fastf1)
    monkeypatch.setattr(main.extractor, "get_event_schedule", no_fastf1)
    return cache, opened


def assert_inside(cache, opened):
    for p in opened:
        assert p.resolve().parent == cache.resolve(), p


@pytest.mark.parametrize("route", SESSION_TYPE_ROUTES)
@pytest.mark.parametrize("attempt", ATTEMPTS)
def test_a_session_type_that_names_a_path_is_422(jail, route, attempt):
    cache, opened = jail
    r = call(main.app, "GET", f"{route}?session_type={attempt}")
    assert r.status_code == 422, (route, attempt, r.status_code, r.text)
    assert SECRET not in r.text
    assert opened == []


@pytest.mark.parametrize("attempt", ATTEMPTS)
def test_a_driver_that_names_a_path_is_never_a_file(jail, attempt):
    cache, opened = jail
    r = call(main.app, "GET", f"/api/telemetry/2024/16/{attempt}")
    # a decoded '/' makes the path another route's (404); anything else is 422
    assert r.status_code in (404, 422), (attempt, r.status_code, r.text)
    assert opened == []
    r = call(main.app, "GET", f"/api/telemetry/2024/16/LEC?lap={attempt}")
    assert r.status_code == 422
    assert opened == []


@pytest.mark.parametrize("attempt", ATTEMPTS)
def test_the_replay_path_session_type_is_checked(jail, attempt):
    cache, opened = jail
    r = call(main.app, "GET", f"/api/session/2024/16/{attempt}/replay")
    assert r.status_code in (404, 422), (attempt, r.status_code, r.text)


@pytest.mark.parametrize("attempt", ["../../../secret", "..\\..\\x", "/etc/passwd", "C:\\x.json", "%2e%2e%2f"])
def test_post_bodies_check_their_session_type(jail, attempt):
    body = dict(year=2024, round=16, drivers=["LEC"], lap_start=1, lap_end=50, session_type=attempt)
    assert call(main.app, "POST", "/api/predict/degradation", body).status_code == 422
    lstm = dict(year=2024, round=16, driver="LEC", session_type=attempt)
    assert call(main.app, "POST", "/api/predict/lstm", lstm).status_code == 422
    assert jail[1] == []


@pytest.mark.parametrize("target", [
    "/api/session/2017/16", "/api/session/2101/16", "/api/session/-1/16", "/api/session/2024/0",
    "/api/session/2024/31", "/api/session/..%2F2024/16", "/api/schedule/1900", "/api/schedule/..",
    "/api/championship/9999", "/api/telemetry/2024/16/LEC?lap=0", "/api/telemetry/2024/16/lec",
    "/api/telemetry/2024/16/LECC", "/api/pca/point-features/LEC_2024_16.json",
    "/api/pca/point-features/..%5CLEC_2024_16", "/api/pca/embeddings?year=2024&round=99",
])
def test_years_rounds_laps_drivers_and_point_ids_are_bounded(jail, target):
    r = call(main.app, "GET", target)
    assert r.status_code in (404, 422), (target, r.status_code, r.text)
    assert jail[1] == []


def test_the_old_file_name_did_reach_the_secret(jail):
    """The attack the checks stop: the name the old code built from the
    session type ../../../secret resolves to the secret file."""
    cache, _ = jail
    old = cache / "session_2024_16_../../../secret.json"
    assert old.resolve() == (cache.parent / "secret.json").resolve()
    with pytest.raises(ValueError):
        main._disk_cache_path("session", 2024, 16, "../../../secret")


@pytest.mark.parametrize("parts", [
    ("session", 2024, 16, ".."),
    ("session", 2024, 16, "../../../secret"),
    ("session", 2024, 16, "..\\..\\secret"),
    ("session", 2024, 16, "/etc/passwd"),
    ("session", 2024, 16, "C:\\Windows\\win"),
    ("session", 2024, 16, "%2e%2e%2f"),
    ("telemetry", 2024, 16, "R", "../LEC", "fastest"),
    ("schedule", "2024/../../x"),
    ("session", ""),
    ("session", 2024, 16, "R\x00"),
])
def test_cache_file_refuses_any_part_that_leaves_the_folder(jail, parts):
    with pytest.raises(ValueError):
        main._cache_file(*parts)


def test_cache_file_names_stay_as_before(jail):
    cache, _ = jail
    assert main._disk_cache_path("session", 2024, 16, "R") == cache.resolve() / "session_2024_16_R.json"
    assert main._disk_cache_path("frames", 2024, 16, "q") == cache.resolve() / "frames_2024_16_Q.json"
    assert main._cache_file("telemetry", 2024, 16, "R", "LEC", "fastest").name == "telemetry_2024_16_R_LEC_fastest.json"
    assert main._cache_file("schedule", 2024).name == "schedule_2024.json"


def test_a_valid_request_still_reads_its_cache_file(jail):
    cache, opened = jail
    payload = {"lap_times": [], "circuit_info": {"name": "Monza"}, "driver_info": [], "race_results": [],
               "weather_data": [], "tyre_strategy": [], "track_status": []}
    (cache / "session_2024_16_R.json").write_text(json.dumps(payload))
    main.raw_session_cache["2024_16_R"] = object()  # no background FastF1 preload
    try:
        r = call(main.app, "GET", "/api/circuit/2024/16?session_type=r")
    finally:
        main.raw_session_cache.pop("2024_16_R", None)
    assert r.status_code == 200 and r.json() == {"name": "Monza"}
    assert_inside(cache, opened)


@pytest.mark.parametrize("value,code", [("R", "R"), ("q", "Q"), (" fp1 ", "FP1"), ("", "R"), (None, "R"),
                                        ("sq", "SQ"), ("SS", "SS"), ("s", "S"), ("R\n", "R")])
def test_session_type_codes(value, code):
    assert params.session_type_code(value) == code


@pytest.mark.parametrize("value", ["RACE", "FP4", "../R", "R/", "R\\", "Q.json", "R.", 1])
def test_other_session_types_are_refused(value):
    with pytest.raises(ValueError):
        params.session_type_code(value)


@pytest.mark.parametrize("value", ["VER\n", "ve", "VERS", "V3R", "../", "", None, 33])
def test_driver_codes_are_three_capital_letters(value):
    with pytest.raises(ValueError):
        params.driver_code(value)
    assert params.driver_code("VER") == "VER"
