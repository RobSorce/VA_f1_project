"""HTTP requests sent straight to the ASGI app, without a server.

fastapi.testclient needs httpx, which is not a backend dependency, and httpx
normalises the URL it sends (``..`` segments). Here the request reaches the
app as uvicorn passes it: ``raw_path`` as sent, ``path`` percent-decoded
(``%2e%2e%2f`` becomes ``../``), the query string untouched. The app's
startup events do not run (the live-timing objects stay unset).
"""
import asyncio
import json
from urllib.parse import unquote


class Response:
    def __init__(self, status, headers, body):
        self.status_code = status
        self.headers = headers
        self.body = body

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.body)


async def request(app, method, target, body=None, headers=None):
    """Send one request to `app`; `target` is the path and query as on the
    request line, e.g. '/api/session/2024/16?session_type=..%2Fx'. A dict or
    list body is sent as JSON."""
    path, _, query = target.partition("?")
    head = {k.lower(): v for k, v in (headers or {}).items()}
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        head.setdefault("content-type", "application/json")
    body = body or b""
    if body:
        head.setdefault("content-length", str(len(body)))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "server": ("127.0.0.1", 8000),
        "client": ("127.0.0.1", 50000),
        "root_path": "",
        "path": unquote(path),
        "raw_path": path.encode("latin-1"),
        "query_string": query.encode("latin-1"),
        "headers": [(k.encode("latin-1"), str(v).encode("latin-1")) for k, v in head.items()],
    }
    sent_body = False
    done = asyncio.Event()
    start = {}
    chunks = []

    async def receive():
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": body, "more_body": False}
        await done.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            start.update(message)
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                done.set()

    try:
        await app(scope, receive, send)
    except Exception:
        # Starlette re-raises an unhandled exception after its 500 answer
        # (uvicorn then logs it); without an answer it is the test's failure
        if not start:
            raise
    headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in start.get("headers", [])}
    return Response(start.get("status"), headers, b"".join(chunks))


def call(app, method, target, body=None, headers=None):
    """request() from synchronous test code."""
    return asyncio.run(request(app, method, target, body, headers))
