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
    """Forward messages from the session manager queue to the WebSocket.

    When the client's queue overflowed, the manager stopped feeding it and
    queued a resync message as the last one: send it, close the socket
    (1013, try again later) and return, so the client reconnects to a fresh
    session_init instead of waiting forever on a queue nobody fills."""
    from live.session_manager import RESYNC_MESSAGE

    while True:
        data = await queue.get()
        try:
            await ws.send_text(data)
        except Exception:
            break
        if data == RESYNC_MESSAGE:
            logger.info("Live WebSocket client fell behind: closing for resync")
            try:
                await ws.close(code=1013, reason="resync")
            except Exception:
                pass
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


# ── OpenF1 telemetry endpoints ───────────────────────────────────

@router.get("/openf1/start")
async def start_openf1_telemetry(session_key: int = Query(None)):
    """Start polling OpenF1 API for live telemetry and car positions.

    Optionally provide a session_key. If omitted, the client will
    auto-detect the latest/active session on OpenF1.
    """
    if _session_manager is None:
        return {"error": "Live timing not initialized"}

    try:
        await _session_manager.start_openf1(session_key=session_key)
        return {
            "status": "started",
            "session_key": session_key,
            "message": "OpenF1 telemetry polling started",
        }
    except Exception as e:
        logger.error(f"OpenF1 start error: {e}")
        return {"error": str(e)}


@router.get("/openf1/stop")
async def stop_openf1_telemetry():
    """Stop polling OpenF1 API."""
    if _session_manager is None:
        return {"error": "Live timing not initialized"}
    await _session_manager.stop_openf1()
    return {"status": "stopped"}


@router.get("/openf1/status")
async def openf1_status():
    """Check OpenF1 telemetry polling status."""
    if _session_manager is None:
        return {"active": False}
    return {
        "active": _session_manager._openf1_enabled,
        "has_car_data": len(_session_manager._openf1_car_data) > 0,
        "has_positions": len(_session_manager._openf1_positions) > 0,
        "drivers_with_telemetry": list(_session_manager._openf1_car_data.keys()),
        "drivers_with_positions": list(_session_manager._openf1_positions.keys()),
    }
