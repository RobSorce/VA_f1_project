"""Stints served by the API: the session payload cached on disk by the old
extractor is rebuilt at load time (api/main.py), and the extractor itself
splits stints by the Stint column (data/extractors/fastf1_extractor.py).

The route functions are called directly: fastapi.testclient needs httpx, which
is not a backend dependency, and the TestClient would also run the live-timing
startup hook. The background FastF1 pre-load of load_session is disabled by
marking the raw session as already cached."""
import asyncio
from types import SimpleNamespace

import pandas as pd
import pytest

from conftest import cached_session_path, load_cached_session


def summary(stints, driver):
    return [(s['Compound'], s['StartLap'], s['EndLap']) for s in stints if s['Driver'] == driver]


@pytest.fixture
def api_main(monkeypatch):
    if not cached_session_path(2024, 16).exists():
        pytest.skip('processed cache missing: session_2024_16_R.json')
    import api.main as main

    # fresh memory cache (forces the disk path); no FastF1 pre-load thread
    monkeypatch.setattr(main, 'session_cache', {})
    monkeypatch.setattr(main, 'raw_session_cache', {main.get_cache_key(2024, 16, 'R'): object()})
    return main


def assert_monza_acceptance(stints):
    assert len(stints) == 50
    assert summary(stints, 'PIA') == [('MEDIUM', 1, 16), ('HARD', 17, 38), ('HARD', 39, 53)]
    assert len(summary(stints, 'NOR')) == 3
    assert len(summary(stints, 'HAM')) == 3


def test_session_endpoint_rebuilds_stints_from_disk_cache(api_main):
    on_disk = load_cached_session(2024, 16)
    assert len(on_disk['tyre_strategy']) == 40  # the stale payload the old extractor wrote

    data = asyncio.run(api_main.get_session_data(2024, 16))
    assert_monza_acceptance(data['tyre_strategy'])
    # driver order of the previous payload (classification) is kept
    old_order = list(dict.fromkeys(s['Driver'] for s in on_disk['tyre_strategy']))
    assert list(dict.fromkeys(s['Driver'] for s in data['tyre_strategy'])) == old_order
    # the file itself is not rewritten
    assert len(load_cached_session(2024, 16)['tyre_strategy']) == 40


def test_strategy_endpoint_cold_and_from_memory_cache(api_main):
    cold = asyncio.run(api_main.get_tyre_strategy(2024, 16))['strategies']
    assert_monza_acceptance(cold)
    warm = asyncio.run(api_main.get_tyre_strategy(2024, 16))['strategies']
    assert warm == cold


def test_rebuild_leaves_payloads_without_laps_alone():
    import api.main as main

    payload = {'lap_times': [], 'tyre_strategy': [{'Driver': 'AAA'}]}
    assert main._rebuild_tyre_strategy(payload)['tyre_strategy'] == [{'Driver': 'AAA'}]


def fake_fastf1_session(s):
    """A FastF1-like session (laps DataFrame with timedelta pit times, drivers)
    built from a cached payload, with every column FastF1 laps carry."""
    laps = pd.DataFrame(s['lap_times'])
    for col in ('PitInTime', 'PitOutTime'):
        laps[col] = pd.to_timedelta(laps[col], unit='s')  # FastF1 holds timedeltas
    drivers = [str(d['DriverNumber']) for d in s['driver_info']]
    return SimpleNamespace(laps=laps, drivers=drivers)


def test_extractor_splits_stints_by_the_stint_column():
    from data.extractors.fastf1_extractor import FastF1Extractor

    s = load_cached_session(2024, 16)
    session = fake_fastf1_session(s)

    df = FastF1Extractor().extract_tyre_strategy(session)
    stints = df.to_dict('records')
    assert_monza_acceptance(stints)
    assert list(df.columns) == ['Driver', 'StintNumber', 'Compound', 'StartLap', 'EndLap', 'TotalLaps']
    # session.drivers order, as the old extractor produced
    abbr = {str(d['DriverNumber']): d['Abbreviation'] for d in s['driver_info']}
    assert list(dict.fromkeys(df['Driver'])) == [abbr[n] for n in session.drivers]


def test_extractor_keeps_the_set_through_sc_pit_lane_passes():
    """R1 in the extractor: 2025 R1 (wet, SC) led the field through the pit
    lane on laps 2-4, so FastF1 Stint changes there with no tyre change. The
    extractor must pass TyreLife to build_tyre_strategy, or every Stint change
    counts as a tyre change (NOR would get 6 stints instead of 3)."""
    from data.extractors.fastf1_extractor import FastF1Extractor
    from data.processors.stints import build_tyre_strategy

    s = load_cached_session(2025, 1)
    stints = FastF1Extractor().extract_tyre_strategy(fake_fastf1_session(s)).to_dict('records')
    assert summary(stints, 'NOR') == [('INTERMEDIATE', 1, 34), ('HARD', 35, 44), ('INTERMEDIATE', 45, 57)]
    # same stints as the processor over the full cached rows (the API path)
    full = build_tyre_strategy(s['lap_times'])
    key = lambda rows: sorted((r['Driver'], r['StintNumber'], r['Compound'], r['StartLap'], r['EndLap'])
                              for r in rows)
    assert key(stints) == key(full)
