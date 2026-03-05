"""
Live Timing Router

Provides REST and WebSocket endpoints for real-time F1 session data.
"""
import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

router = APIRouter(prefix="/api/live", tags=["live"])
logger = logging.getLogger(__name__)

# These are set by main.py on startup
_session_manager = None
_mock_replay = None


def set_session_manager(manager):
    global _session_manager
    _session_manager = manager


def set_mock_replay(replay):
    global _mock_replay
    _mock_replay = replay


@router.get("/status")
async def live_status():
    """Get current live session status."""
    if _session_manager is None:
        return {"active": False, "message": "Live timing not initialized"}
    return _session_manager.get_status()


@router.get("/snapshot")
async def live_snapshot():
    """Get full accumulated session data (same format as /api/session)."""
    if _session_manager is None:
        return {"error": "Live timing not initialized"}
    return _session_manager.get_snapshot()


@router.get("/frames")
async def live_frames():
    """Get accumulated frames (same format as /api/frames)."""
    if _session_manager is None:
        return {"frames": [], "driver_colors": {}, "total_laps": 0, "max_time": 0}
    return _session_manager.get_frames_snapshot()


# ── WebSocket endpoint ────────────────────────────────────────────────

@router.websocket("/ws")
async def live_websocket(ws: WebSocket):
    """WebSocket endpoint for streaming live updates.

    On connect: sends full snapshot as session_init.
    Then streams incremental updates as they arrive.
    """
    await ws.accept()
    logger.info("Live WebSocket client connected")

    if _session_manager is None:
        await ws.send_json({"type": "error", "data": {"message": "Live timing not initialized"}})
        await ws.close()
        return

    # Send initial snapshot
    try:
        snapshot = _session_manager.get_snapshot()
        frames = _session_manager.get_frames_snapshot()
        await ws.send_json({
            "type": "session_init",
            "data": {
                "session": snapshot,
                "frames": frames,
                "status": _session_manager.get_status(),
            },
        })
    except Exception as e:
        logger.error(f"Error sending snapshot: {e}")
        await ws.close()
        return

    # Subscribe to updates
    queue = _session_manager.subscribe()

    try:
        # Two concurrent tasks: sending updates and receiving client messages
        send_task = asyncio.create_task(_send_updates(ws, queue))
        recv_task = asyncio.create_task(_receive_messages(ws))

        # Wait for either to finish (client disconnect or error)
        done, pending = await asyncio.wait(
            [send_task, recv_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()

    except WebSocketDisconnect:
        logger.info("Live WebSocket client disconnected")
    except Exception as e:
        logger.warning(f"Live WebSocket error: {e}")
    finally:
        _session_manager.unsubscribe(queue)
        try:
            await ws.close()
        except Exception:
            pass


async def _send_updates(ws: WebSocket, queue: asyncio.Queue):
    """Forward messages from the session manager queue to the WebSocket."""
    while True:
        data = await queue.get()
        try:
            await ws.send_text(data)
        except Exception:
            break


async def _receive_messages(ws: WebSocket):
    """Receive and handle client messages (keepalive, etc.)."""
    while True:
        try:
            msg = await ws.receive_text()
            # Could handle client commands here (e.g., ping)
        except WebSocketDisconnect:
            break
        except Exception:
            break


# ── Mock replay endpoints ─────────────────────────────────────────────

@router.get("/mock/sessions")
async def list_mock_sessions():
    """List available cached sessions for mock replay."""
    if _mock_replay is None:
        return {"sessions": []}
    from live.mock_replay import MockReplay
    return {"sessions": MockReplay.list_available_sessions()}


@router.get("/mock/start")
async def start_mock_replay(
    year: int = Query(2024),
    round: int = Query(7),
    speed: float = Query(10.0),
):
    """Start a mock live replay from cached session data."""
    if _mock_replay is None:
        return {"error": "Mock replay not initialized"}

    if _mock_replay.is_running:
        await _mock_replay.stop()

    try:
        await _mock_replay.start(year, round, speed)
        return {
            "status": "started",
            "year": year,
            "round": round,
            "speed": speed,
            "message": f"Mock replay started at {speed}x speed",
        }
    except FileNotFoundError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Mock replay start error: {e}")
        return {"error": str(e)}


@router.get("/mock/stop")
async def stop_mock_replay():
    """Stop the running mock replay."""
    if _mock_replay and _mock_replay.is_running:
        await _mock_replay.stop()
        return {"status": "stopped"}
    return {"status": "not_running"}
