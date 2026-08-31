const WebSocket = require('ws');
const logger = require('./logger');

const DATA_WS_URL = 'wss://pumpportal.fun/api/data';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/**
 * PumpPortal's free subscribeNewToken feed - same proven, reliable, no-RPC
 * discovery source as the old sniper bot. Pushes one message per pump.fun
 * token creation with mint/name/symbol already structured.
 */
class PumpPortalStream {
  constructor({ onNewToken }) {
    this.onNewToken = onNewToken;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.status = 'disconnected';
  }

  start() {
    this._connect();
  }

  stop() {
    if (this.ws) this.ws.close();
  }

  _connect() {
    logger.info('Connecting to PumpPortal data WebSocket');
    this.ws = new WebSocket(DATA_WS_URL);

    this.ws.on('open', () => {
      logger.info('PumpPortal data WebSocket connected');
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.txType === 'create' && msg.mint) {
        try {
          Promise.resolve(this.onNewToken(msg)).catch((e) =>
            logger.error('onNewToken handler failed', { error: e.message }));
        } catch (e) {
          logger.error('onNewToken handler failed', { error: e.message });
        }
      }
    });

    this.ws.on('close', () => {
      this.status = 'disconnected';
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
      this.reconnectAttempts += 1;
      logger.warn('PumpPortal data WebSocket closed, reconnecting', { delay });
      setTimeout(() => this._connect(), delay);
    });

    this.ws.on('error', (err) => {
      logger.error('PumpPortal data WebSocket error', { error: err.message });
    });
  }
}

module.exports = PumpPortalStream;
