"""Gemini prompt context: the pit loss comes from raceParams.pitLoss.median
(mean only when median is missing) and says whether it was measured in the
race or is the fallback assumption (api/routers/gemini.py)."""
import pytest

from api.routers.gemini import (
    FALLBACK_PIT_LOSS_S, GeminiRequest, _build_prompt, _mock_response, _pit_loss_info,
)

RACE = {'median': 26.806, 'mean': 27.632, 'stdDev': 4.347, 'p10': 23.46, 'p90': 34.266,
        'n': 30, 'source': 'race'}
FALLBACK = {'median': 22, 'mean': 22, 'stdDev': 2.5, 'p10': 18.796, 'p90': 25.204,
            'n': 0, 'source': 'fallback'}


def prompt(race_params):
    return _build_prompt(GeminiRequest(query='q', race_context={'raceParams': race_params}))


def pit_line(text):
    return next(line.strip() for line in text.splitlines() if line.strip().startswith('Pit loss'))


def test_measured_median_is_the_point_estimate():
    line = pit_line(prompt({'pitLoss': RACE, 'scRate': 0.02}))
    assert line.startswith('Pit loss: 26.8s (median of 30 green-flag pit stops measured in this race')
    assert 'p10-p90 23.5-34.3s' in line and 'sd 4.3s' in line
    assert '27.6' not in line  # the mean is not the point estimate


def test_fallback_is_labelled():
    line = pit_line(prompt({'pitLoss': FALLBACK, 'scRate': 0.02}))
    assert line.startswith('Pit loss: 22.0s (FALLBACK assumption, not race data')


def test_mean_used_only_without_median():
    info = _pit_loss_info({'pitLoss': {'mean': 25.0, 'median': None, 'source': 'race', 'n': 4}})
    assert (info['value'], info['stat']) == (25.0, 'mean')
    assert pit_line(prompt({'pitLoss': {'mean': 25.0}})) == 'Pit loss: 25.0s (mean, source not stated)'


@pytest.mark.parametrize('race_params', [
    {'pitLoss': None, 'scRate': None},
    {'pitLoss': {'median': None, 'mean': None, 'source': None}},
    {'pitLoss': {'median': float('nan')}},
    {'pitLoss': 'n/a'},
    {'scRate': 0.01},
])
def test_none_values_are_guarded(race_params):
    text = prompt(race_params)
    assert pit_line(text) == 'Pit loss: no data'
    assert ('Safety car prob' in text) == (race_params.get('scRate') is not None)


def test_mock_response_labels_the_pit_loss_source():
    def mock(pit_loss):
        ctx = {'raceParams': {'pitLoss': pit_loss}} if pit_loss is not None else {}
        req = GeminiRequest(query='pit now?', drivers=['PIA'], current_lap=20, race_context=ctx)
        return _mock_response(req)['response']

    assert 'Pit loss: ~27s (race median)' in mock(RACE)
    assert 'Pit loss: ~22s (fallback assumption)' in mock(FALLBACK)
    assert f'Pit loss: ~{FALLBACK_PIT_LOSS_S:.0f}s (fallback assumption)' in mock(None)
    # raceParams explicitly null used to crash on .get
    req = GeminiRequest(query='pit now?', drivers=['PIA'], race_context={'raceParams': None})
    assert 'fallback assumption' in _mock_response(req)['response']
