"""
LSTM Model Training (PyTorch)
Train the LSTM on the forecast windows of model/prepare_data.py (built with
the serving builder model/features.py build_window).
Architecture: LSTM(64) → Dropout → LSTM(32) → Dropout → Dense(6)
Output: 5 lap-time deltas to the window's last clean lap (normalised) + 1 pit logit

Split grouped by race (split_races), never by window: overlapping windows of
one race are all in the same set. Test races (held out, never seen in
training or early stopping): every race of the latest cached season plus
the races named in EXTRA_TEST_RACES; validation races (early stopping):
VAL_RACES_N of the others drawn with SPLIT_SEED; training: the rest. The
input scaler and the label statistics are fitted on the training races only.
Every random draw (split, weights, batches, dropout) is seeded.

The race of every window comes from lstm_meta.json (model/prepare_data.py
save_sequences). Without it, or with one that does not describe the saved
windows (stale), no split by race is possible: training is refused
(TrainingDataError) before anything is written, never run on every window
with the test races in it.
"""
import hashlib
import json
import logging
import time
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / 'saved'

# Seed of the race split and of the training run
SPLIT_SEED = 7
TRAIN_SEED = 7

# Races held out for the test set besides the latest season: Monza 2024, the
# race of the forecast in docs/INSIGHTS_MONZA_2024.md (it was in the training
# windows of the previous model)
EXTRA_TEST_RACES = ('2024-16',)

# Validation races (early stopping and learning-rate schedule)
VAL_RACES_N = 4

# Training hyper-parameters. ASSUMPTION: chosen for a CPU run of a few
# minutes, not tuned on the test races.
BATCH_SIZE = 256
LEARNING_RATE = 1e-3
MAX_EPOCHS = 80
PATIENCE = 10
PIT_LOSS_WEIGHT = 1.0

# Number of lap-time outputs (the rest of the output is the pit logit)
TIME_OUTPUTS = 5

# Check PyTorch availability
try:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    logger.warning("PyTorch not available. Will save fallback mean model only.")


# The network class subclasses nn.Module, so it exists only with PyTorch; without it
# train_model() saves the fallback mean model and predict.py never asks for the class.
if TORCH_AVAILABLE:
    class F1LapPredictor(nn.Module):
        """LSTM model for F1 lap time prediction."""

        def __init__(self, n_features=12, hidden1=64, hidden2=32, pred_len=6):
            super().__init__()
            self.lstm1 = nn.LSTM(n_features, hidden1, batch_first=True)
            self.dropout1 = nn.Dropout(0.2)
            self.lstm2 = nn.LSTM(hidden1, hidden2, batch_first=True)
            self.dropout2 = nn.Dropout(0.2)
            self.fc = nn.Linear(hidden2, pred_len)

        def forward(self, x):
            out, _ = self.lstm1(x)
            out = self.dropout1(out)
            out, _ = self.lstm2(out)
            out = self.dropout2(out[:, -1, :])  # Last time step
            out = self.fc(out)
            return out
else:
    F1LapPredictor = None


def split_races(races, seed=SPLIT_SEED):
    """{'train', 'val', 'test'}: sorted race ids ('2024-16') of each set (see
    the module docstring). Deterministic for a given set of races and seed."""
    races = sorted({str(r) for r in races}, key=lambda r: tuple(int(p) for p in r.split('-')))
    if not races:
        return {'train': [], 'val': [], 'test': []}
    latest = max(int(r.split('-')[0]) for r in races)
    test = [r for r in races if int(r.split('-')[0]) == latest or r in EXTRA_TEST_RACES]
    rest = [r for r in races if r not in test]
    rng = np.random.default_rng(seed)
    val = [str(r) for r in rng.choice(rest, size=min(VAL_RACES_N, max(len(rest) - 1, 0)), replace=False)] if rest else []
    key = lambda r: tuple(int(p) for p in r.split('-'))  # noqa: E731
    return {'train': sorted([r for r in rest if r not in val], key=key),
            'val': sorted(val, key=key), 'test': sorted(test, key=key)}


def combined_loss(pred, target, mask, time_weight=1.0, pit_weight=PIT_LOSS_WEIGHT):
    """
    Masked L1 on the normalised lap-time deltas (indices 0-4; mask = the lap
    is a target) + BCE on the pit logit (index 5). L1, because the forecast
    is judged by its mean absolute error.
    """
    err = (pred[:, :TIME_OUTPUTS] - target[:, :TIME_OUTPUTS]).abs() * mask
    l1 = err.sum() / mask.sum().clamp(min=1.0)
    bce = nn.functional.binary_cross_entropy_with_logits(pred[:, TIME_OUTPUTS], target[:, TIME_OUTPUTS])
    return time_weight * l1 + pit_weight * bce


class TrainingDataError(RuntimeError):
    """The saved windows cannot be split by race: lstm_meta.json is missing
    or does not describe lstm_X.npy / lstm_y.npy (stale)."""


def windows_fingerprint(X) -> str:
    """sha1 of the window array (lstm_meta.json x_sha1 ties the meta rows to
    the lstm_X.npy they were saved with)."""
    return hashlib.sha1(np.ascontiguousarray(X).tobytes()).hexdigest()


def race_rows(X, y, meta_doc):
    """The race id of every window, from the lstm_meta.json document.

    Raises TrainingDataError when the document is missing or stale: a row
    count other than the windows', other features or horizon than the
    builder's (model/features.py), or an x_sha1 that is not the saved
    windows'. Every check runs before training writes anything.
    """
    from model.features import FEATURES, PREDICT_LEN

    fix = 'Rebuild the windows and their meta file: python -m model.prepare_data.'
    if meta_doc is None:
        raise TrainingDataError(
            f'lstm_meta.json is missing in {MODEL_DIR}: the race of each window is unknown, so the '
            f'windows cannot be split by race (the test races would be trained on). {fix}')
    rows = meta_doc.get('rows')
    problems = []
    if not isinstance(rows, list) or len(rows) != len(X):
        problems.append(f"{len(rows) if isinstance(rows, list) else 'no'} meta rows for {len(X)} windows")
    if len(y) != len(X):
        problems.append(f'{len(y)} label rows for {len(X)} windows')
    if meta_doc.get('features') != FEATURES or (X.ndim == 3 and X.shape[2] != len(FEATURES)):
        problems.append('features differ from model/features.py FEATURES')
    if meta_doc.get('predict_len') not in (None, PREDICT_LEN):
        problems.append(f"horizon {meta_doc.get('predict_len')} != {PREDICT_LEN}")
    if meta_doc.get('x_sha1') is not None and meta_doc['x_sha1'] != windows_fingerprint(X):
        problems.append('x_sha1 is not the sha1 of lstm_X.npy')
    if not problems and not all(isinstance(m, dict) and m.get('race') for m in rows):
        problems.append('a meta row has no race')
    if problems:
        raise TrainingDataError(
            f"lstm_meta.json is stale ({'; '.join(problems)}): the windows cannot be split by race. {fix}")
    return np.array([str(m['race']) for m in rows])


def _load_data():
    """(X, y, lstm_meta.json document or None): the saved windows, built
    first when missing."""
    X_path = MODEL_DIR / 'lstm_X.npy'
    y_path = MODEL_DIR / 'lstm_y.npy'
    meta_path = MODEL_DIR / 'lstm_meta.json'
    if not X_path.exists() or not y_path.exists():
        logger.info("Training data not found, running prepare_data...")
        from model.prepare_data import prepare_sequences, save_sequences
        X, y, meta = prepare_sequences()
        save_sequences(X, y, meta, MODEL_DIR)
        with open(meta_path, encoding='utf-8') as f:
            return X, y, json.load(f)
    X = np.load(X_path)
    y = np.load(y_path)
    meta = None
    if meta_path.exists():
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
    return X, y, meta


def _logit(p):
    p = float(np.clip(p, 1e-6, 1 - 1e-6))
    return float(np.log(p / (1 - p)))


def train_model():
    """Train the LSTM on the training races; returns the model (None without
    torch or data). Raises TrainingDataError, before writing anything, when
    lstm_meta.json is missing or stale (race_rows)."""
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    X, y, meta = _load_data()
    logger.info(f"Training data: X={X.shape}, y={y.shape}")
    if X.shape[0] == 0:
        logger.error("No training data available")
        return None

    races = race_rows(X, y, meta)
    split = split_races(races)
    idx = {k: np.flatnonzero(np.isin(races, v)) for k, v in split.items()}
    if not len(idx['train']):
        raise TrainingDataError(f'No training race in the split {split}: nothing to train on.')
    logger.info(f"Split: { {k: len(v) for k, v in idx.items()} } windows; races {split}")

    X = np.nan_to_num(X.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    y = y.astype(np.float32)
    n_features, seq_len, pred_len = X.shape[2], X.shape[1], y.shape[1]

    # Label statistics of the training races only
    y_tr = y[idx['train']]
    deltas = y_tr[:, :TIME_OUTPUTS]
    y_mean = float(np.nanmean(deltas))
    y_std = float(np.nanstd(deltas)) or 1.0
    pit_rate = float(np.nanmean(y_tr[:, TIME_OUTPUTS])) if pred_len > TIME_OUTPUTS else 0.0
    data_stats = {'y_delta_mean': y_mean, 'y_delta_std': y_std, 'pit_rate': pit_rate,
                  'target': 'lap time minus the last clean lap of the window, s'}
    with open(MODEL_DIR / 'data_stats.json', 'w') as f:
        json.dump(data_stats, f, indent=2)

    # Fallback mean model: mean normalised delta per lap + logit of the pit rate
    norm = (deltas - y_mean) / y_std
    mean_y = np.nan_to_num(np.nanmean(norm, axis=0), nan=0.0).tolist()
    if pred_len > TIME_OUTPUTS:
        mean_y.append(_logit(pit_rate))
    np.save(MODEL_DIR / 'lstm_fallback_mean.npy', np.asarray(mean_y, dtype=np.float32))

    if not TORCH_AVAILABLE:
        logger.info("Saved fallback mean model (PyTorch not available)")
        return None

    from sklearn.preprocessing import StandardScaler
    import joblib

    torch.manual_seed(TRAIN_SEED)
    np.random.seed(TRAIN_SEED)

    scaler = StandardScaler().fit(X[idx['train']].reshape(-1, n_features))
    joblib.dump(scaler, MODEL_DIR / 'scaler.pkl')

    def tensors(rows):
        xs = scaler.transform(X[rows].reshape(-1, n_features)).reshape(len(rows), seq_len, n_features)
        ys = y[rows].copy()
        mask = ~np.isnan(ys[:, :TIME_OUTPUTS])
        ys[:, :TIME_OUTPUTS] = np.where(mask, (ys[:, :TIME_OUTPUTS] - y_mean) / y_std, 0.0)
        return (torch.tensor(np.nan_to_num(xs), dtype=torch.float32), torch.tensor(ys, dtype=torch.float32),
                torch.tensor(mask, dtype=torch.float32))

    train_ds = TensorDataset(*tensors(idx['train']))
    val_rows = idx['val'] if len(idx['val']) else idx['train']
    val_ds = TensorDataset(*tensors(val_rows))
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,
                              generator=torch.Generator().manual_seed(TRAIN_SEED))
    val_loader = DataLoader(val_ds, batch_size=1024, shuffle=False)

    model = F1LapPredictor(n_features=n_features, hidden1=64, hidden2=32, pred_len=pred_len)
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=4, factor=0.5)

    best_val_loss = float('inf')
    best_epoch = 0
    patience_counter = 0
    started = time.perf_counter()
    epoch = 0
    for epoch in range(MAX_EPOCHS):
        model.train()
        train_loss = 0.0
        for X_batch, y_batch, m_batch in train_loader:
            optimizer.zero_grad()
            loss = combined_loss(model(X_batch), y_batch, m_batch)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            train_loss += loss.item() * X_batch.size(0)
        train_loss /= len(train_ds)

        model.eval()
        val_loss = 0.0
        val_abs, val_n = 0.0, 0.0
        with torch.no_grad():
            for X_batch, y_batch, m_batch in val_loader:
                pred = model(X_batch)
                val_loss += combined_loss(pred, y_batch, m_batch).item() * X_batch.size(0)
                val_abs += float(((pred[:, :TIME_OUTPUTS] - y_batch[:, :TIME_OUTPUTS]).abs() * m_batch).sum()) * y_std
                val_n += float(m_batch.sum())
        val_loss /= len(val_ds)
        scheduler.step(val_loss)
        logger.info(f"Epoch {epoch+1}/{MAX_EPOCHS} — train_loss: {train_loss:.4f}, val_loss: {val_loss:.4f}, "
                    f"val lap MAE: {val_abs / max(val_n, 1):.3f} s, lr: {optimizer.param_groups[0]['lr']:.6f}")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_epoch = epoch + 1
            patience_counter = 0
            torch.save(model.state_dict(), MODEL_DIR / 'lstm_model.pt')
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                logger.info(f"Early stopping at epoch {epoch+1}")
                break
    train_seconds = time.perf_counter() - started

    from model.features import FEATURES
    config = {
        'n_features': n_features,
        'seq_len': seq_len,
        'pred_len': pred_len,
        'hidden1': 64,
        'hidden2': 32,
        'features': FEATURES,
        'target': data_stats['target'],
        'y_delta_mean': y_mean,
        'y_delta_std': y_std,
        'pit_rate_train': pit_rate,
        'best_val_loss': float(best_val_loss),
        'best_epoch': best_epoch,
        'epochs_trained': epoch + 1,
        'train_seconds': round(train_seconds, 1),
        'split_seed': SPLIT_SEED,
        'train_seed': TRAIN_SEED,
        'split': split,
        'windows': {k: int(len(v)) for k, v in idx.items()},
    }
    with open(MODEL_DIR / 'model_config.json', 'w') as f:
        json.dump(config, f, indent=2)

    logger.info(f"Training complete in {train_seconds:.1f} s. Best val_loss: {best_val_loss:.4f} (epoch {best_epoch})")
    logger.info(f"Model saved to {MODEL_DIR / 'lstm_model.pt'}")
    return model


if __name__ == '__main__':
    import sys

    logging.basicConfig(level=logging.INFO)
    try:
        train_model()
    except TrainingDataError as e:
        print(f'Training refused: {e}', file=sys.stderr)
        sys.exit(1)
