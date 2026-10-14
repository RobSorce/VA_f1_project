"""The live WebSocket stream when a client cannot keep up (B6): its queue
fills, the manager stops feeding it, and the client must not be left
waiting forever on a queue nobody fills. A fake WebSocket stands in for the
real one (fastapi.testclient needs httpx, not a backend dependency)."""
import asyncio
import json

from api.routers import live as live_router
from live.session_manager import RESYNC_MESSAGE, LiveSessionManager


class FakeWebSocket:
    """Records what the endpoint sends; receive_text blocks until closed."""

    def __init__(self):
        self.sent = []
        self.closed = None
        self._closed_event = asyncio.Event()

    async def accept(self):
        pass

    async def send_json(self, data):
        self.sent.append(json.dumps(data))

    async def send_text(self, data):
        if self.closed is not None:
            raise RuntimeError("closed")
        self.sent.append(data)

    async def receive_text(self):
        await self._closed_event.wait()
        raise RuntimeError("closed")

    async def close(self, code=1000, reason=None):
        if self.closed is None:
            self.closed = (code, reason)
        self._closed_event.set()


def test_full_queue_ends_with_a_resync_message():
    async def run():
        m = LiveSessionManager()
        q = m.subscribe()
        for i in range(q.maxsize + 1):
            await m._broadcast({"type": "heartbeat", "data": {"i": i}})
        return m, q

    m, q = asyncio.run(run())
    assert q not in m._subscribers
    # the backlog is dropped: the only message left is the resync
    assert q.qsize() == 1 and q.get_nowait() == RESYNC_MESSAGE
    assert json.loads(RESYNC_MESSAGE)["type"] == "resync"


def test_send_loop_closes_the_socket_after_the_resync():
    """It used to wait on queue.get() forever after the manager dropped the
    queue: a silent freeze with the socket open."""
    async def run():
        m = LiveSessionManager()
        q = m.subscribe()
        for i in range(q.maxsize + 1):
            await m._broadcast({"type": "heartbeat", "data": {"i": i}})
        ws = FakeWebSocket()
        await asyncio.wait_for(live_router._send_updates(ws, q), timeout=2.0)
        return ws

    ws = asyncio.run(run())
    assert ws.sent == [RESYNC_MESSAGE]
    assert ws.closed == (1013, "resync")


def test_endpoint_returns_when_its_client_falls_behind(monkeypatch):
    """Whole endpoint: session_init, then a stream the client never reads;
    on overflow the client gets the resync and the endpoint closes."""
    async def run():
        m = LiveSessionManager()
        monkeypatch.setattr(live_router, "_session_manager", m)
        ws = FakeWebSocket()
        orig_send_text = ws.send_text
        gate = asyncio.Event()

        async def slow_send_text(data):
            await gate.wait()  # the client is stuck until the overflow
            await orig_send_text(data)

        ws.send_text = slow_send_text
        endpoint = asyncio.create_task(live_router.live_websocket(ws))
        while not m._subscribers:
            await asyncio.sleep(0)
        q = m._subscribers[0]
        for i in range(q.maxsize + 2):
            await m._broadcast({"type": "lap_update", "data": {"i": i}})
        gate.set()
        await asyncio.wait_for(endpoint, timeout=2.0)
        return m, ws

    m, ws = asyncio.run(run())
    types = [json.loads(s)["type"] for s in ws.sent]
    assert types[0] == "session_init"
    assert types[-1] == "resync"
    assert ws.closed == (1013, "resync")
    assert m._subscribers == []


def test_a_reader_that_keeps_up_gets_every_message():
    async def run():
        m = LiveSessionManager()
        q = m.subscribe()
        ws = FakeWebSocket()
        sender = asyncio.create_task(live_router._send_updates(ws, q))
        for i in range(3 * q.maxsize):
            await m._broadcast({"type": "lap_update", "data": {"i": i}})
            await asyncio.sleep(0)
        while not q.empty():
            await asyncio.sleep(0)
        sender.cancel()
        return m, q, ws

    m, q, ws = asyncio.run(run())
    assert q in m._subscribers
    assert len(ws.sent) == 3 * q.maxsize and ws.closed is None
