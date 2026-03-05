"""
Shared JSON serialization helpers.
Used by api/main.py and scripts/bulk_download.py.
"""
import math
from typing import Any, Dict, List

import numpy as np
import pandas as pd


def clean_dataframe_for_json(df: Any) -> List[Dict[str, Any]]:
    """
    Clean a DataFrame for JSON serialization.
    Converts timedelta, datetime, and numpy types to JSON-serializable formats.
    Handles NaN, inf, and -inf values.
    """
    if df is None or (hasattr(df, 'empty') and df.empty):
        return []

    def clean_value(value):
        """Clean a single value for JSON serialization."""
        if value is None:
            return None

        # Handle numpy NaN/inf
        if isinstance(value, (np.floating, np.integer)):
            if np.isnan(value) or np.isinf(value):
                return None
            return float(value)

        # Handle native float NaN/inf
        if isinstance(value, float):
            if math.isnan(value) or math.isinf(value):
                return None
            return value

        # Handle timedelta
        if hasattr(value, 'total_seconds'):
            result = value.total_seconds()
            if math.isnan(result) or math.isinf(result):
                return None
            return result

        # Handle NaT (Not a Time) — must check before isoformat since NaT has isoformat
        if isinstance(value, type(pd.NaT)):
            return None

        # Handle datetime/Timestamp
        if hasattr(value, 'isoformat'):
            return value.isoformat()

        # Handle numpy arrays
        if isinstance(value, np.ndarray):
            return value.tolist()

        # Handle numpy bool
        if isinstance(value, np.bool_):
            return bool(value)

        return value

    # Convert DataFrame to records
    records = df.to_dict('records')

    cleaned = []
    for record in records:
        clean_record = {}
        for key, value in record.items():
            clean_record[key] = clean_value(value)
        cleaned.append(clean_record)

    return cleaned
