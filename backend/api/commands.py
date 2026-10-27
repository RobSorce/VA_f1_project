"""
State-changing requests (the live-timing controls) are POSTs with a JSON body.

Any page or link can make the browser send a GET (an image, a prefetch), and
a page on another origin can send a form or a plain-text POST without a CORS
preflight. A JSON POST from another origin needs the preflight, which the
CORS allow-list (api/settings.py) refuses: requiring JSON keeps other sites
from resetting or starting the live session through the user's browser.
"""
from fastapi import HTTPException, Request


async def json_command(request: Request) -> None:
    """Route dependency of the state-changing routes: 415 unless the request
    says its body is JSON (Content-Type: application/json)."""
    media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if media_type != "application/json":
        raise HTTPException(status_code=415, detail="Send a JSON body (Content-Type: application/json).")
