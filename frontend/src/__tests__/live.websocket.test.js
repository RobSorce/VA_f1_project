// The client socket (utils/liveWebSocket.js): after the backend's
// resync close (code 1013) the client reconnects once, and the new
// connection's session_init reaches the store's handler; a socket the
// client replaced or closed itself never schedules a reconnect of its own
// (a second live entry used to leave the first socket's close handler
// re-opening a connection every second). Fake WebSocket, fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sockets = [];
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    sockets.push(this);
  }

  open() { this.readyState = 1; this.onopen?.(); }

  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }

  // the server closes (or the network drops)
  serverClose(code, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.({ code, reason });
  }

  // the client closes: the close event follows asynchronously, as in a browser
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }
}
FakeSocket.OPEN = 1;

globalThis.window = { location: { protocol: 'http:', host: 'localhost:5173' } };
globalThis.WebSocket = FakeSocket;
const { LiveWebSocket } = await import('../utils/liveWebSocket.js');

beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('live socket reconnects', () => {
  it('a resync close: one reconnect, whose session_init reaches the handler', () => {
    const ws = new LiveWebSocket();
    const got = [];
    const status = [];
    ws.connect((m) => got.push(m.type), (s) => status.push(s));
    sockets[0].open();
    sockets[0].message({ type: 'session_init', data: { session: {} } });
    sockets[0].message({ type: 'resync', data: { reason: 'client_queue_full' } });
    sockets[0].serverClose(1013, 'resync');
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(2);
    sockets[1].open();
    sockets[1].message({ type: 'session_init', data: { session: {} } });
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(2);
    expect(got).toEqual(['session_init', 'resync', 'session_init']);
    expect(status).toEqual(['connected', 'disconnected', 'reconnecting', 'connected']);
  });

  it('a second connect (another live entry) replaces the socket without a reconnect loop', () => {
    const ws = new LiveWebSocket();
    ws.connect(() => {}, () => {});
    sockets[0].open();
    ws.connect(() => {}, () => {});
    sockets[1].open();
    // the first socket's close event arrives after the replacement
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(2);
    expect(sockets[1].closed).toBe(false);
  });

  it('disconnect: no reconnect afterwards, one disconnected status', () => {
    const ws = new LiveWebSocket();
    const status = [];
    ws.connect(() => {}, (s) => status.push(s));
    sockets[0].open();
    ws.disconnect();
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(1);
    expect(status).toEqual(['connected', 'disconnected']);
  });
});
