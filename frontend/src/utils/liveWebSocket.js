/**
 * Live F1 Timing WebSocket Client
 *
 * Manages WebSocket connection to /api/live/ws for receiving real-time
 * F1 session data. Includes auto-reconnect with exponential backoff.
 */

const WS_PATH = '/api/live/ws';

export class LiveWebSocket {
  constructor() {
    this._ws = null;
    this._onMessage = null;
    this._onStatusChange = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._shouldReconnect = false;
    this._reconnectTimer = null;
  }

  /**
   * Connect to the live WebSocket.
   * @param {Function} onMessage - Called with (parsed message object) for each update
   * @param {Function} onStatusChange - Called with ('connected'|'disconnected'|'reconnecting')
   */
  connect(onMessage, onStatusChange) {
    this._onMessage = onMessage;
    this._onStatusChange = onStatusChange;
    this._shouldReconnect = true;
    this._reconnectDelay = 1000;
    this._doConnect();
  }

  _doConnect() {
    if (this._ws) {
      try { this._ws.close(); } catch (_) { /* ignore */ }
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${WS_PATH}`;

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.error('WebSocket creation failed:', e);
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      console.log('[LiveWS] Connected');
      this._reconnectDelay = 1000;
      this._onStatusChange?.('connected');
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._onMessage?.(msg);
      } catch (e) {
        console.warn('[LiveWS] Parse error:', e);
      }
    };

    this._ws.onclose = (event) => {
      console.log('[LiveWS] Closed:', event.code, event.reason);
      this._onStatusChange?.('disconnected');
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = (event) => {
      console.warn('[LiveWS] Error:', event);
      // onclose will fire after this
    };
  }

  _scheduleReconnect() {
    if (!this._shouldReconnect) return;
    this._onStatusChange?.('reconnecting');
    console.log(`[LiveWS] Reconnecting in ${this._reconnectDelay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._doConnect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
  }

  /**
   * Disconnect and stop reconnecting.
   */
  disconnect() {
    this._shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._onStatusChange?.('disconnected');
  }

  /**
   * @returns {boolean} Whether the WebSocket is currently open
   */
  get isConnected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const liveWS = new LiveWebSocket();
