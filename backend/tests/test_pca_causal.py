"""Current-race points during a replay (P6) and pit windows (P7) of the
cross-race PCA (data/processors/pca_compute.py).

P6: the current race's points used end-of-race features at every clock. Now
pca_embeddings_at fits the basis without that race and computes its points
from the laps completed at session_now; every point says what it is
(as_of 'post-race' / 'session_now').
P7: pit windows used the stint StartLap (the out-lap): one lap late. Now they
use the in-lap of each R2 stop (the lap carrying PitInTime).
"""
import asyncio
import copy
import json
import math

import pandas as pd
import pytest

from conftest import load_cached_session
from data.processors import pca_compute as pc
from data.processors.stints import leader_lap_times


def clock_after_lap(payload, lap):
    """Session seconds just after the race leader finished ``lap``."""
    return leader_lap_times(payload['lap_times'])[lap][1] + 1.0


def scramble_future(payload, now):
    """Copy of the payload with everything not yet known at ``now`` changed:
    times, sectors, positions and pit entries of the laps not completed at now,
    compound / tyre life / Stint of the laps not started at now, and the
    final classification. Lap windows (LapStartTime, Time) are kept."""
    out = copy.deepcopy(payload)
    for lap in out['lap_times']:
        end, start = lap.get('Time'), lap.get('LapStartTime')
        if end is not None and end <= now:
            continue
        if end is not None and lap.get('LapTimeSeconds') is not None:
            lap['LapTimeSeconds'] *= 1.37
            lap['LapTime'] = lap['LapTimeSeconds']
        for k in (1, 2, 3):
            if lap.get(f'Sector{k}TimeSeconds') is not None:
                lap[f'Sector{k}TimeSeconds'] *= 0.71
        lap['Position'] = 20.0 - (lap.get('Position') or 0)
        if lap.get('PitInTimeSeconds') and lap['PitInTimeSeconds'] > now:
            lap['PitInTimeSeconds'] += 3.0
            lap['PitInTime'] = lap['PitInTimeSeconds']
        if start is not None and start > now:
            lap['Compound'] = 'SOFT' if lap.get('Compound') != 'SOFT' else 'HARD'
            lap['TyreLife'] = (lap.get('TyreLife') or 0) + 7
            lap['Stint'] = (lap.get('Stint') or 0) + 3
    for r in out['race_results']:
        r['Position'] = 21.0 - (r.get('Position') or 0)
        r['Status'] = 'Scrambled'
    return out


@pytest.mark.parametrize('year,rnd,lap', [(2024, 16, 20), (2024, 16, 40), (2025, 1, 30), (2024, 8, 60)])
def test_current_race_rows_use_only_the_past(year, rnd, lap):
    payload = load_cached_session(year, rnd)
    now = clock_after_lap(payload, lap)
    real = pc.race_feature_rows(payload, year, rnd, session_now=now)
    fake = pc.race_feature_rows(scramble_future(payload, now), year, rnd, session_now=now)
    assert real, 'no eligible row at this clock'
    assert pd.DataFrame(real).equals(pd.DataFrame(fake))
    assert all(r['as_of_lap'] == lap and r['finish_position'] is None for r in real)
    # and they differ from the post-race rows (the old points)
    post = {r['driver']: r for r in pc.race_feature_rows(payload, year, rnd)}
    assert any(post[r['driver']]['pace_delta_pct'] != r['pace_delta_pct'] for r in real if r['driver'] in post)


def test_replay_biplot_fits_without_the_current_race():
    payload = load_cached_session(2024, 16)
    now = clock_after_lap(payload, 20)
    out = pc.pca_embeddings_at(2024, 16, now)
    cur = [p for p in out['points'] if (p['year'], p['round']) == (2024, 16)]
    other = [p for p in out['points'] if (p['year'], p['round']) != (2024, 16)]
    matrix = pd.read_csv(pc.PROCESSED_DIR / pc.MATRIX_FILE)
    assert len(other) == int(((matrix['year'] != 2024) | (matrix['round'] != 16)).sum())
    assert cur and all(p['as_of'] == 'session_now' and p['as_of_lap'] == 20 and p['finish_position'] is None
                       for p in cur)
    assert all(p['as_of'] == 'post-race' for p in other)
    assert out['features_as_of'] == 'mixed'
    json.dumps(out, allow_nan=False)
    assert out['current_race'] == {
        'year': 2024, 'round': 16, 'available': True, 'session_now': now, 'as_of': 'session_now',
        'as_of_lap': 20, 'n_points': len(cur), 'excluded_from_fit': True, 'reason': None,
    }
    # the basis does not move when the current race's post-race rows change
    scrambled = matrix.copy()
    mask = (scrambled['year'] == 2024) & (scrambled['round'] == 16)
    scrambled.loc[mask, pc.FEATURE_COLS] = scrambled.loc[mask, pc.FEATURE_COLS] * 3 + 1
    _, fit_a = pc._fit_without(matrix, 2024, 16, None)
    _, fit_b = pc._fit_without(scrambled, 2024, 16, None)
    assert (abs(fit_a['pca'].components_ - fit_b['pca'].components_) < 1e-12).all()


def test_replay_biplot_before_any_eligible_row():
    payload = load_cached_session(2024, 16)
    out = pc.pca_embeddings_at(2024, 16, clock_after_lap(payload, 3))
    assert out['current_race']['n_points'] == 0
    assert out['current_race']['as_of_lap'] == 3
    assert out['current_race']['reason']


def test_static_biplot_is_labelled_post_race():
    out = pc.load_pca_embeddings()
    assert out['features_as_of'] == 'post-race'
    assert {p['as_of'] for p in out['points']} == {'post-race'}


def test_route_passes_the_clock():
    import api.main as main
    payload = load_cached_session(2024, 16)
    now = clock_after_lap(payload, 20)
    served = asyncio.run(main.get_pca_embeddings(year=2024, round=16, session_now=now))
    assert served['current_race']['as_of_lap'] == 20
    static = asyncio.run(main.get_pca_embeddings())
    assert 'current_race' not in static and static['features_as_of'] == 'post-race'


def in_laps(payload, driver):
    return sorted(int(l['LapNumber']) for l in payload['lap_times']
                  if l['Driver'] == driver and l.get('PitInTimeSeconds'))


def test_pit_windows_use_the_in_lap():
    payload = load_cached_session(2024, 16)
    assert in_laps(payload, 'LEC') == [15]
    res = pc.analyze_selection(['LEC_2024_16'])
    assert [(w['lap_start'], w['lap_end'], w['count']) for w in res['pit_windows']] == [(15, 15, 1)]
    # PIA: MEDIUM 1-16, HARD 17-38, HARD 39-53 -> in-laps 16 and 38 (both R2 stops)
    assert in_laps(payload, 'PIA') == [16, 38]
    res = pc.analyze_selection(['PIA_2024_16'])
    assert [(w['lap_start'], w['lap_end']) for w in res['pit_windows']] == [(16, 16), (38, 38)]
    assert [(s['compound'], s['lap_start'], s['length']) for s in res['strategies'][0]['stints']] == [
        ('MEDIUM', 1, 16), ('HARD', 17, 22), ('HARD', 39, 15)]


def test_analysis_during_a_replay_stops_at_the_clock(monkeypatch):
    payload = load_cached_session(2024, 16)
    lec12 = next(l for l in payload['lap_times'] if l['Driver'] == 'LEC' and l['LapNumber'] == 12)
    now = lec12['Time'] + 0.5  # LEC has completed lap 12; his stop (in-lap 15) is in the future
    lec = pc.analyze_selection(['LEC_2024_16'], None, 2024, 16, now)
    assert lec['pit_windows'] == []  # LEC's stop is still in the future
    assert [(s['compound'], s['lap_start'], s['length']) for s in lec['strategies'][0]['stints']] == [
        ('MEDIUM', 1, 12)]
    assert lec['n_selected'] == 1
    # post-race, the analysis does see the stop on lap 15
    assert pc.analyze_selection(['LEC_2024_16'])['pit_windows'][0]['lap_start'] == 15
    # same answer whatever happens after the clock
    ids = ['LEC_2024_16', 'PIA_2024_16', 'NOR_2024_16', 'VER_2024_1', 'HAM_2024_2']
    res = pc.analyze_selection(ids, None, 2024, 16, now)
    assert res['n_selected'] == 5 and not math.isinf(now)
    real_load = pc._load_payload
    fake = scramble_future(payload, now)
    monkeypatch.setattr(pc, '_load_payload',
                        lambda y, r: fake if (int(y), int(r)) == (2024, 16) else real_load(y, r))
    assert pc.analyze_selection(ids, None, 2024, 16, now) == res


def test_analysis_says_what_clock_the_current_race_is_at():
    """The answer carries current_race (the clock of that race's rows, stints
    and stops) and, when the selection holds rows of it at a replay clock, a
    summary sentence that says so; post-race and without year / round, no such
    sentence."""
    payload = load_cached_session(2024, 16)
    now = clock_after_lap(payload, 10)
    emb = pc.pca_embeddings_at(2024, 16, now)
    ids = [p['id'] for p in emb['points'] if p['year'] == 2024 and p['round'] == 16]
    assert len(ids) == emb['current_race']['n_points'] > 0
    res = pc.analyze_selection(ids, None, 2024, 16, now)
    assert res['current_race'] == {'year': 2024, 'round': 16, 'as_of': 'session_now', 'session_now': now,
                                   'as_of_lap': 10, 'n_selected': len(ids)}
    assert 'completed by lap 10 (the replay clock)' in res['summary']
    # every in-lap of the windows is a lap completed by the clock
    assert all(w['lap_end'] <= 10 for w in res['pit_windows'])
    post = pc.analyze_selection(ids, None, 2024, 16, None)
    assert post['current_race']['as_of'] == 'post-race' and post['current_race']['session_now'] is None
    assert 'replay clock' not in post['summary']
    assert 'current_race' not in pc.analyze_selection(ids)


def test_a_race_not_started_has_no_rows():
    """session_now 0 (another session of the weekend on screen: the race has
    not started) leaves the race out of the biplot and of the analysis."""
    emb = pc.pca_embeddings_at(2024, 16, 0.0)
    assert emb['current_race']['n_points'] == 0 and emb['current_race']['as_of_lap'] == 0
    assert not [p for p in emb['points'] if p['year'] == 2024 and p['round'] == 16]
    res = pc.analyze_selection(['LEC_2024_16', 'VER_2024_1'], None, 2024, 16, 0.0)
    assert res['n_selected'] == 1 and res['current_race']['n_selected'] == 0
    assert res['pit_windows'] and all(w['count'] >= 1 for w in res['pit_windows'])
