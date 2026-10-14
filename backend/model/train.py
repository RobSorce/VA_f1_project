"""
LSTM Model Training (PyTorch)
Train LSTM on cached multi-season race data for lap time prediction.
Architecture: LSTM(64) → Dropout → LSTM(32) → Dropout → Dense(6)
Output: 5 normalized lap times + 1 pit probability
"""
import numpy as np
import json
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / 'saved'

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


def combined_loss(pred, target, time_weight=1.0, pit_weight=2.0):
    """
    Combined loss: MSE for lap times (indices 0-4) + BCE for pit probability (index 5).
    """
    mse = nn.functional.mse_loss(pred[:, :5], target[:, :5])
    bce = nn.functional.binary_cross_entropy_with_logits(pred[:, 5], target[:, 5])
    return time_weight * mse + pit_weight * bce


def train_model():
    """Train LSTM on prepared data."""
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    X_path = MODEL_DIR / 'lstm_X.npy'
    y_path = MODEL_DIR / 'lstm_y.npy'
    stats_path = MODEL_DIR / 'data_stats.json'

    if not X_path.exists() or not y_path.exists():
        logger.info("Training data not found, running prepare_data...")
        from model.prepare_data import prepare_sequences
        result = prepare_sequences()
        if len(result) == 5:
            X, y, scaler, y_time_mean, y_time_std = result
        else:
            logger.error("prepare_sequences returned no data")
            return None
        np.save(X_path, X)
        np.save(y_path, y)
    else:
        X = np.load(X_path)
        y = np.load(y_path)

    # Load data stats
    if stats_path.exists():
        with open(stats_path) as f:
            data_stats = json.load(f)
    else:
        # WARNING: If y was loaded from .npy, it is already normalized (mean~0, std~1).
        # We cannot recover the original scale here. Save a warning and use
        # reasonable defaults for F1 lap times.
        logger.warning(
            "data_stats.json not found. y data may already be normalized. "
            "Using default lap time scale (mean=90s, std=5s). "
            "Re-run prepare_data to generate correct stats."
        )
        data_stats = {
            'y_time_mean': 90.0,
            'y_time_std': 5.0,
        }
        # Save so future runs don't hit this again
        with open(stats_path, 'w') as f:
            json.dump(data_stats, f, indent=2)

    logger.info(f"Training data: X={X.shape}, y={y.shape}")

    if X.shape[0] == 0:
        logger.error("No training data available")
        return None

    # Replace any remaining NaN/inf
    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
    y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)

    n_features = X.shape[2]
    seq_len = X.shape[1]
    pred_len = y.shape[1]

    # Shuffle and split 80/20
    indices = np.random.permutation(len(X))
    X, y = X[indices], y[indices]
    split = int(len(X) * 0.8)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    logger.info(f"Train: {X_train.shape[0]} samples, Val: {X_val.shape[0]} samples")

    if not TORCH_AVAILABLE:
        # Fallback: save mean predictions
        mean_y = y_train.mean(axis=0)
        np.save(MODEL_DIR / 'lstm_fallback_mean.npy', mean_y)
        logger.info("Saved fallback mean model (PyTorch not available)")
        return None

    # Build PyTorch datasets
    train_ds = TensorDataset(
        torch.tensor(X_train, dtype=torch.float32),
        torch.tensor(y_train, dtype=torch.float32),
    )
    val_ds = TensorDataset(
        torch.tensor(X_val, dtype=torch.float32),
        torch.tensor(y_val, dtype=torch.float32),
    )
    train_loader = DataLoader(train_ds, batch_size=64, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=64, shuffle=False)

    # Build model
    model = F1LapPredictor(n_features=n_features, hidden1=64, hidden2=32, pred_len=pred_len)
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=5, factor=0.5)

    # Training loop with early stopping
    best_val_loss = float('inf')
    patience = 15
    patience_counter = 0
    max_epochs = 100

    for epoch in range(max_epochs):
        # Train
        model.train()
        train_loss = 0.0
        for X_batch, y_batch in train_loader:
            optimizer.zero_grad()
            pred = model(X_batch)
            loss = combined_loss(pred, y_batch)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            train_loss += loss.item() * X_batch.size(0)
        train_loss /= len(train_ds)

        # Validate
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for X_batch, y_batch in val_loader:
                pred = model(X_batch)
                loss = combined_loss(pred, y_batch)
                val_loss += loss.item() * X_batch.size(0)
        val_loss /= len(val_ds)

        scheduler.step(val_loss)
        current_lr = optimizer.param_groups[0]['lr']

        logger.info(f"Epoch {epoch+1}/{max_epochs} — train_loss: {train_loss:.4f}, val_loss: {val_loss:.4f}, lr: {current_lr:.6f}")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            # Save best model
            torch.save(model.state_dict(), MODEL_DIR / 'lstm_model.pt')
        else:
            patience_counter += 1
            if patience_counter >= patience:
                logger.info(f"Early stopping at epoch {epoch+1}")
                break

    # Save model config
    config = {
        'n_features': n_features,
        'seq_len': seq_len,
        'pred_len': pred_len,
        'hidden1': 64,
        'hidden2': 32,
        'best_val_loss': float(best_val_loss),
        'epochs_trained': epoch + 1,
        'y_time_mean': data_stats['y_time_mean'],
        'y_time_std': data_stats['y_time_std'],
    }
    with open(MODEL_DIR / 'model_config.json', 'w') as f:
        json.dump(config, f, indent=2)

    # Also save fallback mean in case PyTorch isn't available at inference
    mean_y = y_train.mean(axis=0)
    np.save(MODEL_DIR / 'lstm_fallback_mean.npy', mean_y)

    logger.info(f"Training complete. Best val_loss: {best_val_loss:.4f}")
    logger.info(f"Model saved to {MODEL_DIR / 'lstm_model.pt'}")
    return model


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    train_model()
