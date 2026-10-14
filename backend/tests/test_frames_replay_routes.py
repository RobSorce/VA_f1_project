"""The /ws/replay websocket is gone (it grouped every frame under lap 1: the frames carry
the lap per driver, not per frame), no client used it, and the REST replay route and
GET /api/frames stay registered."""
from pathlib import Path

from conftest import BACKEND


def all_paths(routes):
    # FastAPI 0.143 keeps included routers as _IncludedRouter entries (original_router)
    for r in routes:
        inner = getattr(r, 'original_router', None)
        if inner is not None:
            yield from all_paths(inner.routes)
        elif getattr(r, 'path', None):
            yield r.path


def test_no_replay_websocket_and_rest_routes_kept():
    import api.main as main

    paths = set(all_paths(main.app.routes))
    assert not [p for p in paths if p.startswith('/ws/replay')]
    assert '/api/session/{year}/{round_num}/{session_type}/replay' in paths
    assert '/api/frames/{year}/{round_num}' in paths


def test_frontend_never_opened_the_replay_websocket():
    src = BACKEND.parent / 'frontend' / 'src'
    files = [p for p in src.rglob('*') if p.suffix in ('.js', '.jsx', '.ts', '.tsx')] if src.exists() else []
    assert not [p for p in files if 'ws/replay' in p.read_text(encoding='utf-8', errors='ignore')]
