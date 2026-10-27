"""
Server settings read from the environment (backend/.env, loaded by
api/main.py, or the shell that starts the backend).

- VA_API_HOST: the address the server listens on (default 127.0.0.1, this
  computer only; 0.0.0.0 listens on every interface).
- VA_API_PORT: its port (default 8000, the port the Vite proxy forwards /api to).
- VA_CORS_ORIGINS: the origins a browser may call the API from, separated by
  commas (default the Vite dev and preview servers). The frontend calls
  /api through the Vite proxy, from its own origin, so it needs none of them;
  they are for a page served from another origin. Set but empty: none.
"""
import os

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
# npm run dev (port 5173) and npm run preview (port 4173), by name and by address
DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
)


def server_host(environ=os.environ) -> str:
    """VA_API_HOST, else DEFAULT_HOST."""
    return environ.get("VA_API_HOST", "").strip() or DEFAULT_HOST


def server_port(environ=os.environ) -> int:
    """VA_API_PORT, else DEFAULT_PORT; ValueError for a value that is not a port."""
    raw = environ.get("VA_API_PORT", "").strip()
    if not raw:
        return DEFAULT_PORT
    if not raw.isdigit() or not 1 <= int(raw) <= 65535:
        raise ValueError(f"VA_API_PORT must be a port number (1-65535), not {raw!r}")
    return int(raw)


def cors_origins(environ=os.environ) -> list:
    """VA_CORS_ORIGINS as a list (no trailing slash: an origin has none), else
    DEFAULT_CORS_ORIGINS."""
    raw = environ.get("VA_CORS_ORIGINS")
    if raw is None:
        return list(DEFAULT_CORS_ORIGINS)
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
