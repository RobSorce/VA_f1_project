from conftest import load_cached_session


def test_monza_cache_loads():
    s = load_cached_session(2024, 16)
    assert len(s["lap_times"]) == 1008
