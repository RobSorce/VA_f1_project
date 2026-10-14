"""Championship standings (api/main.py _compute_championship): the points of a round
are those of its race plus, on sprint weekends, those of its sprint; the best case adds
the most the rules of the season still allow (fastest-lap point 2019-2024 only).

The schedule is built from the disk cache (no FastF1 call); the route functions are
called directly (fastapi.testclient needs httpx, not a backend dependency)."""
import asyncio
import json

import pandas as pd
import pytest

from conftest import CACHE_DIR


@pytest.fixture
def main(monkeypatch):
    import api.main as m

    monkeypatch.setattr(m, 'session_cache', {})
    monkeypatch.setattr(m, 'championship_cache', {})
    return m


def fake_schedule(monkeypatch, m, rounds):
    """rounds: [(round, EventFormat)] served as the FastF1 event schedule."""
    rows = [{'RoundNumber': 0, 'EventFormat': 'testing'}]
    rows += [{'RoundNumber': r, 'EventFormat': f} for r, f in rounds]
    monkeypatch.setattr(m.extractor, 'get_event_schedule', lambda year: pd.DataFrame(rows))


def row(abbr, team, pts):
    return {'Abbreviation': abbr, 'TeamName': team, 'TeamColor': '123456', 'FullName': abbr,
            'CountryCode': '', 'Points': pts}


def write(path, data):
    path.write_text(json.dumps(data))


@pytest.mark.parametrize('year, driver, team', [
    (2018, {'race': 25, 'sprint': 0}, {'race': 43, 'sprint': 0}),
    (2019, {'race': 26, 'sprint': 0}, {'race': 44, 'sprint': 0}),
    (2021, {'race': 26, 'sprint': 3}, {'race': 44, 'sprint': 5}),
    (2024, {'race': 26, 'sprint': 8}, {'race': 44, 'sprint': 15}),
    (2025, {'race': 25, 'sprint': 8}, {'race': 43, 'sprint': 15}),
    (2026, {'race': 25, 'sprint': 8}, {'race': 43, 'sprint': 15}),
])
def test_max_points_follow_the_season_rules(main, year, driver, team):
    assert main._max_points(year) == driver
    assert main._max_points(year, team=True) == team


def season_on_disk(tmp_path, monkeypatch, m, year, sprint_cached=True):
    """5 rounds: R1-R3 run (R2 a sprint weekend), R4 sprint weekend and R5 not run."""
    monkeypatch.setattr(m, 'DISK_CACHE_DIR', tmp_path)
    fake_schedule(monkeypatch, m, [(1, 'conventional'), (2, 'sprint_qualifying'), (3, 'conventional'),
                                   (4, 'sprint_qualifying'), (5, 'conventional')])
    for rnd, (a, b, c) in {1: (25, 18, 0), 2: (18, 25, 1), 3: (26, 15, 0)}.items():
        write(tmp_path / f'session_{year}_{rnd}_R.json',
              {'race_results': [row('AAA', 'Red', a), row('BBB', 'Red', b), row('CCC', 'Blue', c)]})
    if sprint_cached:
        write(tmp_path / f'results_{year}_2_S.json',
              [row('AAA', 'Red', 8), row('CCC', 'Blue', 7), row('BBB', 'Red', 0)])


@pytest.mark.parametrize('year, driver_gain, team_gain', [
    (2024, 26 + 8 + 26, 44 + 15 + 44),   # R4 race + R4 sprint + R5 race, fastest lap counted
    (2025, 25 + 8 + 25, 43 + 15 + 43),   # no fastest-lap point since 2025
])
def test_sprint_points_are_added_and_best_case_follows_the_rules(main, tmp_path, monkeypatch,
                                                                year, driver_gain, team_gain):
    season_on_disk(tmp_path, monkeypatch, main, year)
    res = main._compute_championship(year, fast_only=True)

    drivers = {d['abbr']: d for d in res['drivers']}
    assert drivers['AAA']['totalPoints'] == 25 + 18 + 8 + 26
    assert drivers['CCC']['totalPoints'] == 1 + 7
    r2 = next(p for p in drivers['AAA']['progression'] if p['round'] == 2)
    assert (r2['points'], r2['sprint_points']) == (26, 8)
    teams = {c['team']: c['totalPoints'] for c in res['constructors']}
    assert teams == {'Red': 25 + 18 + 18 + 25 + 8 + 26 + 15, 'Blue': 1 + 7}

    assert res['completed_rounds'] == 3 and res['total_rounds'] == 5
    assert res['missing_rounds'] == [4, 5] and res['missing_sprint_rounds'] == [4]
    assert res['cache_version'] == main.CHAMPIONSHIP_CACHE_VERSION
    assert drivers['AAA']['prediction']['best_case'] == drivers['AAA']['totalPoints'] + driver_gain
    red = next(c for c in res['constructors'] if c['team'] == 'Red')
    assert red['prediction']['best_case'] == red['totalPoints'] + team_gain


def test_a_sprint_not_cached_is_reported_and_still_counted_as_available(main, tmp_path, monkeypatch):
    season_on_disk(tmp_path, monkeypatch, main, 2024, sprint_cached=False)
    res = main._compute_championship(2024, fast_only=True)

    assert res['missing_sprint_rounds'] == [2, 4]
    assert res['missing_rounds'] == [2, 4, 5]  # the banner offers "Load All"
    aaa = next(d for d in res['drivers'] if d['abbr'] == 'AAA')
    assert aaa['totalPoints'] == 25 + 18 + 26
    assert aaa['prediction']['best_case'] == aaa['totalPoints'] + 8 + (26 + 8 + 26)


def test_sprint_results_are_fetched_once_then_read_from_disk(main, tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'DISK_CACHE_DIR', tmp_path)
    calls = []

    def fake_results(year, rnd, session_type):
        calls.append((year, rnd, session_type))
        return pd.DataFrame([row('AAA', 'Red', 8.0), row('BBB', 'Red', float('nan'))])

    monkeypatch.setattr(main.extractor, 'get_session_results', fake_results)
    assert main._load_sprint_results(2024, 5, fast_only=True) is None  # fast mode: disk only
    rows = main._load_sprint_results(2024, 5, fast_only=False)
    assert [(r['Abbreviation'], r['Points']) for r in rows] == [('AAA', 8.0), ('BBB', None)]
    assert main._load_sprint_results(2024, 5, fast_only=True) == rows
    assert calls == [(2024, 5, 'S')]

    # a classification without points (sprint not run yet) is neither returned nor cached
    monkeypatch.setattr(main.extractor, 'get_session_results',
                        lambda *a: pd.DataFrame([row('AAA', 'Red', float('nan'))]))
    assert main._load_sprint_results(2024, 6, fast_only=False) is None
    assert not (tmp_path / 'results_2024_6_S.json').exists()


def test_a_disk_cache_from_an_older_points_model_is_recomputed(main, tmp_path, monkeypatch):
    season_on_disk(tmp_path, monkeypatch, main, 2024)
    write(tmp_path / 'championship_2024.json', {'year': 2024, 'drivers': [], 'constructors': [],
                                                'missing_rounds': []})  # no cache_version
    res = asyncio.run(main.get_championship(2024))
    assert res['cache_version'] == main.CHAMPIONSHIP_CACHE_VERSION
    assert res['drivers'][0]['abbr'] == 'AAA' and res['drivers'][0]['totalPoints'] == 77


def cached_2024_or_skip():
    needed = [CACHE_DIR / f'session_2024_{r}_R.json' for r in range(1, 25)]
    needed += [CACHE_DIR / f'results_2024_{r}_S.json' for r in (5, 6, 11, 19, 21, 23)]
    needed.append(CACHE_DIR / 'schedule_2024.json')
    missing = [p.name for p in needed if not p.exists()]
    if missing:
        pytest.skip(f'processed cache missing: {missing[:3]}')


def test_2024_standings_match_the_official_totals(main, monkeypatch):
    """2024 final standings (FIA): VER 437, NOR 374, LEC 356, PIA 292, SAI 290;
    McLaren 666, Ferrari 652, Red Bull Racing 589, Mercedes 468."""
    cached_2024_or_skip()
    events = json.loads((CACHE_DIR / 'schedule_2024.json').read_text())['events']
    fake_schedule(monkeypatch, main, [(e['RoundNumber'], e['EventFormat']) for e in events if e['RoundNumber']])

    res = main._compute_championship(2024, fast_only=True)
    assert res['missing_rounds'] == [] and res['completed_rounds'] == 24
    totals = {d['abbr']: d['totalPoints'] for d in res['drivers']}
    assert [totals[a] for a in ('VER', 'NOR', 'LEC', 'PIA', 'SAI')] == [437, 374, 356, 292, 290]
    assert sum(p['sprint_points'] for p in res['drivers'][0]['progression']) == 38
    teams = {c['team']: c['totalPoints'] for c in res['constructors']}
    assert [teams[t] for t in ('McLaren', 'Ferrari', 'Red Bull Racing', 'Mercedes')] == [666, 652, 589, 468]

    # the file served by /api/championship/2024 holds the same totals
    on_disk = json.loads((CACHE_DIR / 'championship_2024.json').read_text())
    assert on_disk.get('cache_version') == main.CHAMPIONSHIP_CACHE_VERSION
    assert {d['abbr']: d['totalPoints'] for d in on_disk['drivers']}['VER'] == 437
