"""python api/main.py loads the app module once (api/main.py, top).

Started as a script, the module used to run twice: as __main__, whose app
uvicorn served, and as api.main, imported by the routers for load_session.
Two session caches, two FastF1 locks, two FastF1 loads of one session at a
time. The script now hands uvicorn the import path 'api.main:app' and stops
before building anything, so the one module is api.main. Checked here by
running the file as __main__ with uvicorn.run recorded instead of served.
"""
import runpy

import dotenv
import fastapi
import pytest
import uvicorn

from conftest import BACKEND

MAIN = BACKEND / "api" / "main.py"


@pytest.fixture
def run_script(monkeypatch):
    """Run api/main.py as __main__; returns the uvicorn.run calls and whether
    the script built a FastAPI app (it must not)."""
    served, built = [], []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: served.append((app, kw)))
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: None)  # a local backend/.env stays out
    monkeypatch.setattr(fastapi, "FastAPI", lambda *a, **k: built.append(a) or pytest.fail("the script built an app"))
    for k in ("VA_API_HOST", "VA_API_PORT"):
        monkeypatch.delenv(k, raising=False)

    def run():
        with pytest.raises(SystemExit) as stop:
            runpy.run_path(str(MAIN), run_name="__main__")
        assert stop.value.code == 0
        return served, built
    return run


def test_the_script_serves_api_main_by_its_import_path(run_script):
    served, built = run_script()
    assert served == [("api.main:app", {"host": "127.0.0.1", "port": 8000})]
    assert built == []


def test_the_script_listens_where_the_environment_says(run_script, monkeypatch):
    monkeypatch.setenv("VA_API_HOST", "0.0.0.0")
    monkeypatch.setenv("VA_API_PORT", "8100")
    served, _ = run_script()
    assert served == [("api.main:app", {"host": "0.0.0.0", "port": 8100})]


def test_the_import_path_names_the_module_the_routers_use():
    """uvicorn imports 'api.main' and serves its app: the module the routers'
    `from api.main import load_session` reach."""
    import importlib
    import api.main as main
    from api.routers import analytics, predictions
    assert importlib.import_module("api.main") is main
    assert analytics._get_load_session() is main.load_session
    assert predictions._get_load_session() is main.load_session
