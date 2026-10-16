"""Selectable seasons: /api/seasons lists 2018 up to the clock year + 1, the current and
the next season only once their schedule is published; the training data of
model/prepare_data.py follows the same clock bound.

FastF1 is replaced by a fake event schedule; the route function is called directly."""
import asyncio
import datetime
import json
import time

import pandas as pd
import pytest


@pytest.fixture
def main(monkeypatch, tmp_path):
    import api.main as m

    monkeypatch.setattr(m, 'DISK_CACHE_DIR', tmp_path)
    monkeypatch.setattr(m, 'schedule_cache', {})
    monkeypatch.setattr(m, '_season_published_cache', {})
    return m


def published(rounds_by_year, calls):
    """Fake FastF1 schedule: rounds_by_year[year] numbered rounds (0 = not published)."""
    def get_event_schedule(year):
        calls.append(year)
        n = rounds_by_year.get(year, 0)
        if n is None:
            raise ConnectionError('offline')
        return pd.DataFrame({'RoundNumber': list(range(1, n + 1)), 'EventName': ['x'] * n})
    return get_event_schedule


def seasons(m):
    return asyncio.run(m.get_seasons())['seasons']


def test_current_season_listed_once_published_next_one_not_yet(main, monkeypatch):
    calls = []
    monkeypatch.setattr(main, '_current_year', lambda: 2026)
    monkeypatch.setattr(main.extractor, 'get_event_schedule', published({2026: 23, 2027: 0}, calls))
    assert seasons(main) == list(range(2018, 2027))
    assert sorted(calls) == [2026, 2027]  # past seasons need no check


def test_upper_bound_comes_from_the_clock(main, monkeypatch):
    calls = []
    monkeypatch.setattr(main, '_current_year', lambda: 2027)
    monkeypatch.setattr(main.extractor, 'get_event_schedule', published({2027: 24, 2028: 22}, calls))
    assert seasons(main) == list(range(2018, 2029))


def test_answers_are_cached_and_a_failed_check_is_retried(main, monkeypatch):
    calls = []
    rounds = {2026: None, 2027: 0}  # 2026: FastF1 unreachable
    monkeypatch.setattr(main, '_current_year', lambda: 2026)
    monkeypatch.setattr(main.extractor, 'get_event_schedule', published(rounds, calls))
    assert seasons(main)[-1] == 2025
    rounds[2026] = 23
    assert seasons(main)[-1] == 2026
    assert calls == [2026, 2027, 2026]  # 2027 "not published" kept for an hour, 2026 retried
    assert seasons(main)[-1] == 2026 and len(calls) == 3


def test_a_cached_schedule_answers_without_fastf1(main, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(main, '_current_year', lambda: 2026)
    monkeypatch.setattr(main.extractor, 'get_event_schedule', published({}, calls))
    (tmp_path / 'schedule_2026.json').write_text(json.dumps(
        {'year': 2026, 'events': [{'RoundNumber': 0}, {'RoundNumber': 1}]}))
    assert seasons(main)[-1] == 2026
    assert calls == [2027]


def test_a_busy_fastf1_lock_does_not_hold_the_route(main, monkeypatch):
    """A first-time session load holds _fastf1_lock for minutes: the route used to wait
    2 x 30 s for it and then leave out the current season."""
    calls = []
    monkeypatch.setattr(main, '_current_year', lambda: 2026)
    monkeypatch.setattr(main, '_SEASON_LOCK_WAIT_S', 0.2)
    monkeypatch.setattr(main.extractor, 'get_event_schedule', published({2026: 23, 2027: 0}, calls))
    assert main._fastf1_lock.acquire(timeout=5)
    try:
        t = time.monotonic()
        assert seasons(main) == list(range(2018, 2027))  # no answer yet: the clock's season
        assert time.monotonic() - t < 2
        assert calls == [] and main._season_published_cache == {}  # a guess is not cached
    finally:
        main._fastf1_lock.release()
    assert seasons(main) == list(range(2018, 2027)) and sorted(calls) == [2026, 2027]


def test_a_busy_fastf1_lock_keeps_the_last_answer(main, monkeypatch):
    calls = []
    monkeypatch.setattr(main, '_current_year', lambda: 2026)
    monkeypatch.setattr(main, '_SEASON_LOCK_WAIT_S', 0.2)
    monkeypatch.setattr(main.extractor, 'get_event_schedule', published({2026: 23, 2027: 24}, calls))
    stale = time.monotonic() - 2 * main._SEASON_RECHECK_S
    main._season_published_cache.update({2026: (True, stale), 2027: (False, stale)})
    assert main._fastf1_lock.acquire(timeout=5)
    try:
        assert seasons(main) == list(range(2018, 2027))  # 2027 due for a re-check, FastF1 busy
    finally:
        main._fastf1_lock.release()
    assert seasons(main) == list(range(2018, 2028)) and calls == [2027]


def test_prepare_data_years_reach_the_next_season():
    from model.prepare_data import YEARS

    assert YEARS[0] == 2018
    assert YEARS[-1] == datetime.date.today().year + 1
