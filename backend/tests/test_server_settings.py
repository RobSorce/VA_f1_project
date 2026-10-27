"""Who can reach the API (api/settings.py, api/main.py).

CORS was open to every origin with credentials, and the server listened on
every interface. Now a browser may call the API only from the origins of
VA_CORS_ORIGINS (default the Vite dev and preview servers), without
credentials, and the server listens on VA_API_HOST (default 127.0.0.1).
"""
import pytest
from fastapi.middleware.cors import CORSMiddleware

import api.main as main
from api import settings
from asgi_client import call

EVIL = "http://evil.example"


def preflight(origin, method="POST"):
    return call(main.app, "OPTIONS", "/api/live/reset", headers={
        "origin": origin, "access-control-request-method": method,
        "access-control-request-headers": "content-type",
    })


def test_defaults_are_the_dev_and_preview_servers_and_this_computer_only():
    assert settings.cors_origins({}) == [
        "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173",
    ]
    assert settings.server_host({}) == "127.0.0.1"
    assert settings.server_port({}) == 8000


def test_the_environment_sets_them():
    env = {"VA_CORS_ORIGINS": " https://a.example, https://b.example/ ,", "VA_API_HOST": "0.0.0.0",
           "VA_API_PORT": "8100"}
    assert settings.cors_origins(env) == ["https://a.example", "https://b.example"]
    assert settings.server_host(env) == "0.0.0.0"
    assert settings.server_port(env) == 8100
    assert settings.cors_origins({"VA_CORS_ORIGINS": ""}) == []  # set but empty: no origin
    assert settings.server_host({"VA_API_HOST": " "}) == "127.0.0.1"


@pytest.mark.parametrize("port", ["0", "65536", "80a", "-1", "8000.0"])
def test_a_port_that_is_not_one_is_refused(port):
    with pytest.raises(ValueError):
        settings.server_port({"VA_API_PORT": port})


def test_the_app_uses_the_settings_without_credentials():
    cors = [m for m in main.app.user_middleware if m.cls is CORSMiddleware]
    assert len(cors) == 1
    opts = cors[0].kwargs
    assert opts["allow_origins"] == settings.cors_origins()
    assert opts["allow_credentials"] is False
    assert "*" not in opts["allow_origins"] and "*" not in opts["allow_methods"]


@pytest.mark.parametrize("origin", settings.DEFAULT_CORS_ORIGINS)
def test_a_dev_or_preview_page_passes_the_preflight(origin):
    r = preflight(origin)
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == origin
    assert "access-control-allow-credentials" not in r.headers


@pytest.mark.parametrize("origin", [EVIL, "http://localhost:3000", "null", "http://localhost:5173.evil.example"])
def test_another_origin_is_refused(origin):
    r = preflight(origin)
    assert r.status_code == 400
    assert "access-control-allow-origin" not in r.headers
    # a simple GET still answers (CORS only decides whether the page may read
    # it), but without the header that lets the browser hand it to the page
    r = call(main.app, "GET", "/api/health", headers={"origin": origin})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers
