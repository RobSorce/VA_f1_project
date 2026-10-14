"""The shared degradation definition (data/processors/degradation.py): clean
stint laps, fuel correction, per-stint fit, compound degradation and
consistency sigma. Same cases as frontend/src/utils/__tests__/degradation.test.js;
the JS/Python parity on every cached race is
frontend/src/utils/__tests__/degradation.parity.test.js."""
import math

import pytest

from conftest import load_cached_session
from data.processors.degradation import (
    FUEL_EFFECT_S_PER_LAP, MAX_LAP_TIME_S, MIN_FIT_LAPS, clean_stint_laps, compound_degradation,
    consistency_sigma, fit_stint, fuel_corrected_time, is_clean_lap, stint_fits,
)

T0 = 1000.0
DUR = 90.0
BASE = 80.0
DEG = 0.05
WIGGLE = [0.1, -0.05, 0.02, -0.1, 0.06, -0.03, 0.08, -0.07]


def wiggle(n):
    return WIGGLE[n % 8]


def lap(driver, n, **extra):
    start = T0 + (n - 1) * DUR
    row = {
        'Driver': driver, 'LapNumber': float(n), 'LapStartTime': start, 'Time': start + DUR,
        'TrackStatus': '1', 'Stint': 1.0, 'Compound': 'MEDIUM', 'TyreLife': float(n),
        'PitInTimeSeconds': None, 'PitOutTimeSeconds': None,
        'LapTimeSeconds': BASE + DEG * n - FUEL_EFFECT_S_PER_LAP * (n - 1),
    }
    row.update(extra)
    return row


def stint(driver, first_lap, last_lap, first=1, deg=DEG, noise=lambda n: 0.0, **extra):
    out = []
    for n in range(first_lap, last_lap + 1):
        tl = first + (n - first_lap)
        out.append(lap(driver, n, TyreLife=float(tl),
                       LapTimeSeconds=BASE + deg * tl - FUEL_EFFECT_S_PER_LAP * (n - 1) + noise(n), **extra))
    return out


def with_stop(rows, driver, in_lap):
    out = []
    for r in rows:
        r = dict(r)
        if r['Driver'] == driver and r['LapNumber'] == in_lap:
            r['PitInTimeSeconds'] = r['Time'] - 5
        if r['Driver'] == driver and r['LapNumber'] == in_lap + 1:
            r['PitOutTimeSeconds'] = r['LapStartTime'] + 20
        out.append(r)
    return out


def lap_numbers(laps):
    return [int(r['LapNumber']) for r in laps]


# ---------------------------------------------------------------- fit_stint

def test_fit_recovers_a_known_line():
    fit = fit_stint(stint('AAA', 2, 15, first=2))
    assert fit['slope'] == pytest.approx(DEG, abs=1e-12)
    assert fit['raw_slope'] == pytest.approx(DEG - FUEL_EFFECT_S_PER_LAP, abs=1e-12)
    assert fit['intercept'] == pytest.approx(BASE, abs=1e-9)
    assert fit['n'] == 14
    assert fit['residual_sigma'] < 1e-9
    assert (fit['tyre_life_min'], fit['tyre_life_max']) == (2, 15)


def test_fuel_corrected_time():
    assert fuel_corrected_time({'LapTimeSeconds': 90, 'LapNumber': 11}) == pytest.approx(90 + 10 * FUEL_EFFECT_S_PER_LAP)
    assert fuel_corrected_time({'LapTimeSeconds': 90, 'LapNumber': 1}) == 90


def test_fit_minimum_laps_and_degenerate_tyre_life():
    assert fit_stint(stint('AAA', 2, MIN_FIT_LAPS, first=2)) is None          # MIN_FIT_LAPS - 1 laps
    assert fit_stint(stint('AAA', 2, MIN_FIT_LAPS + 1, first=2)) is not None
    flat = [dict(r, TyreLife=5.0) for r in stint('AAA', 2, 12, first=2)]
    assert fit_stint(flat) is None
    assert fit_stint(None) is None


def test_negative_slope_is_kept():
    fit = fit_stint(stint('AAA', 2, 15, first=2, deg=-0.04))
    assert fit['slope'] == pytest.approx(-0.04, abs=1e-12)


def test_residual_sigma_and_slope_std_err():
    laps = stint('AAA', 2, 13, first=2, noise=wiggle)
    fit = fit_stint(laps)
    xs = [r['TyreLife'] for r in laps]
    ys = [fuel_corrected_time(r) for r in laps]
    mx = sum(xs) / len(xs)
    sse = sum((y - fit['intercept'] - fit['slope'] * x) ** 2 for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    assert fit['residual_sigma'] == pytest.approx(math.sqrt(sse / (len(xs) - 2)), abs=1e-12)
    assert fit['slope_std_err'] == pytest.approx(fit['residual_sigma'] / math.sqrt(sxx), abs=1e-12)


# ---------------------------------------------------------------- clean_stint_laps

def test_clean_lap_filters():
    rows = stint('AAA', 1, 12) + stint('AAA', 13, 30, first=1, Stint=2.0, Compound='HARD')
    rows = with_stop(rows, 'AAA', 12)
    for r in rows:
        if r['LapNumber'] == 5:
            r['TrackStatus'] = '4'
        if r['LapNumber'] == 6:
            r['TrackStatus'] = '12'
        if r['LapNumber'] == 20:
            r['LapTimeSeconds'] = float(MAX_LAP_TIME_S)
        if r['LapNumber'] == 21:
            r['LapTimeSeconds'] = None
        if r['LapNumber'] == 22:
            r['TyreLife'] = None
    out = clean_stint_laps(rows)
    assert [(s['driver'], s['stint_number'], s['compound'], s['start_lap'], s['end_lap']) for s in out] == [
        ('AAA', 1, 'MEDIUM', 1, 12), ('AAA', 2, 'HARD', 13, 30)]
    assert lap_numbers(out[0]['laps']) == [2, 3, 4, 7, 8, 9, 10, 11]
    assert lap_numbers(out[1]['laps']) == [14, 15, 16, 17, 18, 19, 23, 24, 25, 26, 27, 28, 29, 30]
    assert all(not s['outliers'] for s in out)
    assert sum(1 for r in rows if is_clean_lap(r)) == 22


def test_clean_laps_are_causal():
    rows = with_stop(stint('AAA', 1, 12) + stint('AAA', 13, 30, first=1, Stint=2.0, Compound='HARD'), 'AAA', 12)
    out = clean_stint_laps(rows, session_now=T0 + 10 * DUR + 30)
    assert len(out) == 1 and out[0]['end_lap'] == 10
    assert lap_numbers(out[0]['laps']) == [2, 3, 4, 5, 6, 7, 8, 9, 10]
    # just after the pit exit: the new stint has no completed lap, so no entry yet
    assert [s['stint_number'] for s in clean_stint_laps(rows, session_now=T0 + 12 * DUR + 25)] == [1]
    assert clean_stint_laps(rows, session_now=float('nan')) == clean_stint_laps(rows)


def test_slow_outliers_only():
    rows = stint('AAA', 2, 25, first=2, noise=lambda n: wiggle(n) + (3 if n == 14 else 0) + (-3 if n == 13 else 0))
    [st] = clean_stint_laps(rows)
    assert lap_numbers(st['outliers']) == [14]
    assert 13 in lap_numbers(st['laps'])
    assert len(st['laps']) == 23


def test_no_outlier_on_a_perfect_line_or_a_short_stint():
    [st] = clean_stint_laps(stint('AAA', 2, 25, first=2))
    assert st['outliers'] == [] and len(st['laps']) == 24
    [st] = clean_stint_laps(stint('AAA', 2, MIN_FIT_LAPS, first=2, noise=lambda n: 5 if n == 4 else 0))
    assert st['outliers'] == [] and len(st['laps']) == MIN_FIT_LAPS - 1


def test_driver_filter():
    rows = stint('AAA', 1, 12) + stint('BBB', 1, 12)
    assert [s['driver'] for s in clean_stint_laps(rows, driver='BBB')] == ['BBB']
    assert [s['driver'] for s in clean_stint_laps(rows)] == ['AAA', 'BBB']
    assert clean_stint_laps([]) == [] and clean_stint_laps(None) == []


# ---------------------------------------------------------------- stint_fits

TWO_STINTS = with_stop(
    stint('AAA', 1, 20, noise=wiggle)
    + stint('AAA', 21, 40, first=1, deg=0.02, noise=wiggle, Stint=2.0, Compound='HARD'), 'AAA', 20)


def test_stint_fits_rows():
    fits = stint_fits(TWO_STINTS)
    assert [(f['stint_number'], f['compound'], f['start_lap'], f['end_lap'], f['n']) for f in fits] == [
        (1, 'MEDIUM', 1, 20, 18), (2, 'HARD', 21, 40, 19)]
    assert {k: fits[0][k] for k in fit_stint(clean_stint_laps(TWO_STINTS)[0]['laps'])} == \
        fit_stint(clean_stint_laps(TWO_STINTS)[0]['laps'])


def test_stint_fits_lap_range():
    fits = stint_fits(TWO_STINTS, lap_start=10, lap_end=30)
    assert [(f['stint_number'], f['n'], f['tyre_life_min'], f['tyre_life_max']) for f in fits] == [
        (1, 10, 10, 19), (2, 9, 2, 10)]
    assert [f['stint_number'] for f in stint_fits(TWO_STINTS, lap_start=25)] == [2]
    assert [f['stint_number'] for f in stint_fits(TWO_STINTS, lap_end=15)] == [1]
    [short] = stint_fits(TWO_STINTS, lap_start=2, lap_end=6)
    assert short['slope'] is None and short['residual_sigma'] is None and short['n'] == 5
    assert (short['tyre_life_min'], short['tyre_life_max']) == (2, 6)


# ---------------------------------------------------------------- compound / consistency

def test_compound_degradation():
    deg = compound_degradation([
        {'compound': 'HARD', 'slope': 0.02}, {'compound': 'HARD', 'slope': -0.01},
        {'compound': 'HARD', 'slope': 0.05}, {'compound': 'HARD', 'slope': None},
        {'compound': 'SOFT', 'slope': 0.1}])
    assert list(deg) == ['HARD', 'SOFT']
    assert deg['HARD']['n'] == 3 and deg['HARD']['negative_count'] == 1
    assert deg['HARD']['mean'] == pytest.approx(0.02, abs=1e-12)
    assert deg['HARD']['median'] == pytest.approx(0.02, abs=1e-12)
    assert deg['HARD']['std_dev'] == pytest.approx(0.03, abs=1e-12)
    assert deg['SOFT'] == {'mean': 0.1, 'median': 0.1, 'std_dev': 0, 'n': 1, 'negative_count': 0}
    assert compound_degradation([]) == {}


def test_consistency_sigma_pools_the_stint_residuals():
    rows = with_stop(stint('AAA', 1, 20, noise=wiggle)
                     + stint('AAA', 21, 40, first=1, noise=lambda n: 2 * wiggle(n), Stint=2.0, Compound='HARD'),
                     'AAA', 20)
    fits = stint_fits(rows, driver='AAA')
    sse = sum(f['residual_sigma'] ** 2 * (f['n'] - 2) for f in fits)
    dof = sum(f['n'] - 2 for f in fits)
    c = consistency_sigma(rows, 'AAA')
    assert c['sigma'] == pytest.approx(math.sqrt(sse / dof), abs=1e-12)
    assert (c['n'], c['stints'], c['outliers']) == (37, 2, 0)
    assert consistency_sigma(stint('AAA', 1, 6), 'AAA') == {'sigma': None, 'n': 0, 'stints': 0, 'outliers': 0}


# ---------------------------------------------------------------- Monza 2024 (cached)

def test_monza_2024_numbers():
    """Numbers of notes/experiments/degradation_definition_monza.txt."""
    laps = load_cached_session(2024, 16)['lap_times']
    pia = stint_fits(laps, driver='PIA', lap_start=10, lap_end=25)
    assert [(f['stint_number'], f['compound'], f['n']) for f in pia] == [(1, 'MEDIUM', 6), (2, 'HARD', 8)]
    assert pia[0]['slope'] is None
    assert round(pia[1]['slope'], 4) == -0.1278
    deg = compound_degradation(stint_fits(laps))
    assert (deg['MEDIUM']['n'], round(deg['MEDIUM']['median'], 4), deg['MEDIUM']['negative_count']) == (18, 0.0096, 9)
    assert (deg['HARD']['n'], round(deg['HARD']['median'], 4), deg['HARD']['negative_count']) == (29, 0.0182, 11)
    clean = clean_stint_laps(laps)
    assert sum(len(s['outliers']) for s in clean) == 29
    assert sum(len(s['laps']) for s in clean) == 898
    assert round(consistency_sigma(laps, 'LEC')['sigma'], 3) == 0.298
