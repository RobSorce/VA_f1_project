"""
Error answers carry a status code and a generic message; what went wrong
(the exception's text and its traceback) goes to the server log only. The
text of an exception can name files, folders, hosts or library internals,
so it is never sent to the client.
"""
import logging

from fastapi import HTTPException

GENERIC_DETAIL = "Internal server error. The details are in the server log."


def server_error(logger: logging.Logger, what: str, status_code: int = 500) -> HTTPException:
    """Log the exception being handled, with its traceback, and return the
    HTTPException to raise: '{what} failed.' and status_code, nothing of the
    exception. In an except block: raise server_error(logger, "Loading the session")."""
    logger.error("%s failed", what, exc_info=True)
    return HTTPException(status_code=status_code, detail=f"{what} failed. The details are in the server log.")
