"""
Request values that name a season, a round, a session, a driver or a lap,
checked where they enter the API.

They become parts of the disk-cache file names (api/main.py _cache_file) and
FastF1 arguments, so each one is a bounded integer, one of a fixed set or a
fixed pattern: a value that could name another file (``..``, a slash or a
backslash, a drive or an absolute path, plain or percent-encoded) is answered
422 and never reaches a path. The annotated types below work as path and
query parameters and as fields of request bodies alike.
"""
import re
from typing import Annotated

from pydantic import AfterValidator

# First season with FastF1 timing data, the session picker's first (api/main.py FIRST_SEASON)
FIRST_SEASON = 2018
# The upper bounds only reject absurd values: a season or a round not
# published yet is still asked as before
LAST_SEASON = 2100
MAX_ROUND = 30
MAX_LAP = 200

# The FastF1 session identifiers the app loads: race, sprint, qualifying,
# sprint qualifying (since 2024), sprint shootout (2023), free practice
SESSION_TYPES = ("R", "S", "Q", "SQ", "SS", "FP1", "FP2", "FP3")
# Session type of a request that names none (D16): the race
DEFAULT_SESSION_TYPE = "R"
# The frontend's session type for any practice session of a live feed
# (frontend/src/utils/strategyViews.js viewSessionType): a label for the
# race-only logic of a request that loads no cached session, never a
# session to load
LIVE_PRACTICE_LABEL = "FP"

_DRIVER_CODE = re.compile(r"[A-Z]{3}")
# A PCA biplot point: driver code, season, round (data/processors/pca_compute.py)
_POINT_ID = re.compile(r"[A-Z]{3}_\d{4}_\d{1,2}")


def session_type_code(value) -> str:
    """The session-type code of a request ('R', 'S', 'Q', 'SQ', 'SS',
    'FP1'-'FP3'): upper-cased, DEFAULT_SESSION_TYPE when empty. ValueError for
    any other value."""
    code = str(value or "").strip().upper() or DEFAULT_SESSION_TYPE
    if code not in SESSION_TYPES:
        raise ValueError(f"session_type must be one of {', '.join(SESSION_TYPES)}")
    return code


def session_label(value) -> str:
    """The session type of a request that may load no cached session (the
    forecast of a live feed): a SESSION_TYPES code or LIVE_PRACTICE_LABEL,
    normalised as session_type_code. ValueError for any other value."""
    code = str(value or "").strip().upper() or DEFAULT_SESSION_TYPE
    return code if code == LIVE_PRACTICE_LABEL else session_type_code(code)


def driver_code(value) -> str:
    """A three-letter driver code (VER, LEC); ValueError for anything else."""
    if not isinstance(value, str) or not _DRIVER_CODE.fullmatch(value):
        raise ValueError("driver must be a three-letter driver code, e.g. VER")
    return value


def point_id(value) -> str:
    """A biplot point id, '{driver}_{year}_{round}' (LEC_2024_16); ValueError otherwise."""
    if not isinstance(value, str) or not _POINT_ID.fullmatch(value):
        raise ValueError("point_id must be '{driver}_{year}_{round}', e.g. LEC_2024_16")
    return value


def _between(name: str, low: int, high: int) -> AfterValidator:
    def check(value: int) -> int:
        if not low <= value <= high:
            raise ValueError(f"{name} must be between {low} and {high}")
        return value
    return AfterValidator(check)


Season = Annotated[int, _between("year", FIRST_SEASON, LAST_SEASON)]
RoundNumber = Annotated[int, _between("round", 1, MAX_ROUND)]
LapNumber = Annotated[int, _between("lap", 1, MAX_LAP)]
SessionType = Annotated[str, AfterValidator(session_type_code)]
SessionLabel = Annotated[str, AfterValidator(session_label)]
DriverCode = Annotated[str, AfterValidator(driver_code)]
PointId = Annotated[str, AfterValidator(point_id)]
