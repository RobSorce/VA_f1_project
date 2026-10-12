"""Pytest setup: make backend/ importable and expose the processed cache."""
import json
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

CACHE_DIR = BACKEND / "data" / "processed_cache"


def cached_session_path(year, rnd, session_type="R"):
    return CACHE_DIR / f"session_{year}_{rnd}_{session_type}.json"


def load_cached_session(year, rnd, session_type="R"):
    """Cached session payload, or skip the test when the (git-ignored) cache is absent."""
    p = cached_session_path(year, rnd, session_type)
    if not p.exists():
        pytest.skip(f"processed cache missing: {p.name}")
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)
