"""model/train.py without PyTorch: the module imports (the nn.Module subclass is defined
only with torch) and train_model() reaches its fallback, the mean model.

The torch-less run happens in a subprocess, where 'import torch' is made to fail, so
the torch already imported by this test session is not disturbed."""
import subprocess
import sys
import textwrap

import numpy as np
import pytest

from conftest import BACKEND

NO_TORCH = textwrap.dedent("""
    import json, sys
    from pathlib import Path
    import numpy as np
    for name in ('torch', 'torch.nn', 'torch.utils', 'torch.utils.data'):
        sys.modules[name] = None  # 'import torch' raises ImportError, as without torch
    sys.path.insert(0, sys.argv[1])
    import model.train as train
    out = Path(sys.argv[2])
    train.MODEL_DIR = out
    rng = np.random.default_rng(0)
    X = rng.normal(size=(20, 10, 12))
    np.save(out / 'lstm_X.npy', X)
    np.save(out / 'lstm_y.npy', rng.normal(size=(20, 6)))
    # the race of each window (train.py refuses to train without it)
    from model.features import FEATURES
    races = ['2024-1', '2024-2', '2024-3', '2024-4', '2024-5', '2024-6', '2024-7', '2025-1']
    (out / 'lstm_meta.json').write_text(json.dumps({
        'features': FEATURES, 'predict_len': 5, 'x_sha1': train.windows_fingerprint(X),
        'rows': [{'race': races[i % len(races)], 'driver': 'AAA', 'origin_lap': i} for i in range(20)]}))
    (out / 'data_stats.json').write_text(json.dumps({'y_time_mean': 90.0, 'y_time_std': 5.0}))
    print(json.dumps({'torch': train.TORCH_AVAILABLE, 'cls': train.F1LapPredictor is None,
                      'ret': train.train_model() is None,
                      'fallback': (out / 'lstm_fallback_mean.npy').exists()}))
""")


def test_train_imports_and_falls_back_without_torch(tmp_path):
    proc = subprocess.run([sys.executable, '-c', NO_TORCH, str(BACKEND), str(tmp_path)],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout.strip().splitlines()[-1] == \
        '{"torch": false, "cls": true, "ret": true, "fallback": true}'
    assert np.load(tmp_path / 'lstm_fallback_mean.npy').shape == (6,)


def test_model_class_with_torch():
    torch = pytest.importorskip('torch')
    from model.train import F1LapPredictor, TORCH_AVAILABLE

    assert TORCH_AVAILABLE
    out = F1LapPredictor(n_features=12, pred_len=6)(torch.zeros(4, 10, 12))
    assert tuple(out.shape) == (4, 6)
