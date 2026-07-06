'use strict';

// OCPP 1.6 JSON Central System (WebSocket Server)
// Singleton — shared across all OCPP SmartCharger device instances.
// The SCharger connects to: ws://[homey-ip]:8887/[station-id]

const OCPP_PORT        = 8887;
const PING_INTERVAL_MS = 30_000;

// Seed transaction ID counter with Unix timestamp so it survives restarts
let _txnCounter = Math.floor(Date.now() / 1000);
let _instance   = null;

class OcppServer {

  constructor(homey) {
    this._homey      = homey;
    this._devices    = new Map(); // stationId → device instance
    this._clients    = new Map(); // stationId → WebSocket
    this._txnIds     = new Map(); // stationId → active transactionId (null when idle)
    this._creds      = new Map(); // stationId → {username, password} or null
    this._wss        = null;
    this._port       = 0;
  }

  static getInstance(homey) {
    if (!_instance) {
      _instance = new OcppServer(homey);
      _instance._start();
    }
    return _instance;
  }

  registerDevice(stationId, device) {
    this._homey.log(`[OcppServer] Registered device: ${stationId}`);
    this._devices.set(stationId, device);
    if (this._port) device.onServerStarted(this._port);
  }

  unregisterDevice(stationId) {
    this._homey.log(`[OcppServer] Unregistered device: ${stationId}`);
    this._devices.delete(stationId);
    this._txnIds.delete(stationId);
    this._creds.delete(stationId);
    if (this._devices.size === 0) {
      this._stop();
      _instance = null;
    }
  }

  // Store optional Basic Auth credentials for a station.
  // If username is empty, authentication is skipped for that station.
  setCredentials(stationId, username, password) {
    if (username) {
      this._creds.set(stationId, { username, password: password || '' });
      this._homey.log(`[OcppServer] Credentials set for: ${stationId}`);
    } else {
      this._creds.delete(stationId);
    }
  }

  // ─── Server lifecycle ────────────────────────────────────────────────────

  _start() {
    try {
      const WebSocket = require('ws');
      this._wss = new WebSocket.Server({ port: OCPP_PORT });
      this._homey.log(`[OcppServer] Starting WebSocket server on port ${OCPP_PORT}`);

      this._wss.on('listening', () => {
        this._port = OCPP_PORT;
        this._homey.log(`[OcppServer] Listening on port ${OCPP_PORT}`);
        for (const device of this._devices.values()) device.onServerStarted(OCPP_PORT);
      });

      this._wss.on('connection', (ws, req) => this._onConnection(ws, req));

      this._wss.on('error', (err) => {
        this._homey.error('[OcppServer] Server error:', err.message);
        for (const device of this._devices.values()) device.onServerError(err);
      });

    } catch (err) {
      this._homey.error('[OcppServer] Failed to require ws module:', err.message);
      for (const device of this._devices.values()) device.onServerError(err);
    }
  }

  _stop() {
    if (this._wss) {
      this._wss.close();
      this._wss = null;
      this._port = 0;
      this._homey.log('[OcppServer] Server stopped');
    }
  }

  // ─── Connection handling ─────────────────────────────────────────────────

  _onConnection(ws, req) {
    // URL: /[station-id]  or  /ocpp/[station-id]
    const url       = req.url || '/';
    const stationId = url.split('/').filter(Boolean).pop() || 'unknown';
    this._homey.log(`[OcppServer] Client connected: ${stationId} (${req.socket.remoteAddress})`);

    // Validate Basic Auth if credentials are configured for this station
    const creds = this._creds.get(stationId);
    if (creds) {
      const authHeader = req.headers['authorization'] || '';
      const valid = this._checkBasicAuth(authHeader, creds.username, creds.password);
      if (!valid) {
        this._homey.log(`[OcppServer] Auth failed for ${stationId} — closing connection`);
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    this._clients.set(stationId, ws);

    const device = this._devices.get(stationId);
    if (device) device.onOcppConnected();

    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on('message', (data) => {
      try {
        this._onMessage(stationId, ws, JSON.parse(data.toString()));
      } catch (err) {
        this._homey.error(`[OcppServer] Parse error from ${stationId}:`, err.message);
      }
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      this._clients.delete(stationId);
      this._homey.log(`[OcppServer] Client disconnected: ${stationId}`);
      const dev = this._devices.get(stationId);
      if (dev) dev.onOcppDisconnected();
    });

    ws.on('error', (err) => {
      this._homey.error(`[OcppServer] Client error (${stationId}):`, err.message);
    });
  }

  // ─── OCPP 1.6 message dispatch ───────────────────────────────────────────
  // Call:   [2, uniqueId, action, payload]
  // Result: [3, uniqueId, payload]
  // Error:  [4, uniqueId, errorCode, errorDescription, details]

  _onMessage(stationId, ws, msg) {
    if (!Array.isArray(msg)) return;
    const [type, uniqueId, ...rest] = msg;

    if (type === 2) {
      const [action, payload] = rest;
      this._homey.log(`[OcppServer] ← ${stationId}: ${action}`);
      this._handleCall(stationId, ws, uniqueId, action, payload || {});
    }
    // type 3/4 = responses to our outgoing calls — not tracked for now
  }

  _handleCall(stationId, ws, uniqueId, action, payload) {
    const device = this._devices.get(stationId);
    const now    = new Date().toISOString();

    switch (action) {

      case 'BootNotification':
        this._send(ws, [3, uniqueId, {
          currentTime: now,
          interval:    60,
          status:      'Accepted',
        }]);
        if (device) device.onBootNotification(payload);
        // Configure charger 2 s after boot to let it settle
        setTimeout(() => this._configureCharger(stationId, ws), 2000);
        break;

      case 'Heartbeat':
        this._send(ws, [3, uniqueId, { currentTime: now }]);
        break;

      case 'StatusNotification': {
        this._send(ws, [3, uniqueId, {}]);
        // When charger becomes Available and we still hold a txnId → stale, clear it
        if ((payload.status === 'Available') && this._txnIds.get(stationId)) {
          this._txnIds.set(stationId, null);
        }
        if (device) device.onStatusNotification(payload);
        break;
      }

      case 'MeterValues':
        this._send(ws, [3, uniqueId, {}]);
        // Transaction recovery: if MeterValues carry a txnId we don't know about, adopt it
        if (payload.transactionId && !this._txnIds.get(stationId)) {
          this._txnIds.set(stationId, payload.transactionId);
        }
        if (device) device.onMeterValues(payload);
        break;

      case 'StartTransaction': {
        const txnId = ++_txnCounter;
        this._txnIds.set(stationId, txnId);
        this._send(ws, [3, uniqueId, {
          transactionId: txnId,
          idTagInfo:     { status: 'Accepted' },
        }]);
        if (device) device.onStartTransaction(payload, txnId);
        break;
      }

      case 'StopTransaction':
        this._txnIds.set(stationId, null);
        this._send(ws, [3, uniqueId, {
          idTagInfo: { status: 'Accepted' },
        }]);
        if (device) device.onStopTransaction(payload);
        break;

      case 'Authorize':
        this._send(ws, [3, uniqueId, { idTagInfo: { status: 'Accepted' } }]);
        break;

      case 'DataTransfer':
        this._send(ws, [3, uniqueId, { status: 'Accepted' }]);
        break;

      default:
        this._homey.log(`[OcppServer] Unknown action: ${action}`);
        this._send(ws, [4, uniqueId, 'NotImplemented', `Action ${action} not implemented`, {}]);
    }
  }

  // ─── Charger setup after BootNotification ────────────────────────────────

  _configureCharger(stationId, ws) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    this._homey.log(`[OcppServer] Configuring charger ${stationId}`);

    // Tell charger what to sample and how often
    this._sendCall(ws, 'ChangeConfiguration', {
      key:   'MeterValuesSampledData',
      value: 'Power.Active.Import,Energy.Active.Import.Register,SoC,Current.Import,Voltage',
    });
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      this._sendCall(ws, 'ChangeConfiguration', {
        key:   'MeterValueSampleInterval',
        value: '10',
      });
    }, 500);
    // Tell charger to ping us every 30 s so it matches our server-side ping timer
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      this._sendCall(ws, 'ChangeConfiguration', {
        key:   'WebSocketPingInterval',
        value: '30',
      });
    }, 1000);
  }

  // ─── Outgoing commands ───────────────────────────────────────────────────

  remoteStart(stationId, connectorId = 1, idTag = 'homey') {
    const ws = this._clients.get(stationId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    this._sendCall(ws, 'RemoteStartTransaction', { connectorId, idTag });
  }

  remoteStop(stationId) {
    const ws    = this._clients.get(stationId);
    const txnId = this._txnIds.get(stationId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    if (!txnId) throw new Error(`No active transaction for ${stationId}`);
    this._sendCall(ws, 'RemoteStopTransaction', { transactionId: txnId });
  }

  // Set max charging current via SetChargingProfile (amperes=0 pauses charging).
  // Uses TxDefaultProfile on connector 1 — correct for single-connector chargers
  // like the Huawei SCharger. evcc confirmed this is the right purpose/connector combo.
  setMaxCurrent(stationId, amperes) {
    const ws = this._clients.get(stationId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    this._sendCall(ws, 'SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId:      1,
        stackLevel:             0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind:    'Relative',
        chargingSchedule: {
          chargingRateUnit:       'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: amperes, numberPhases: 3 }],
        },
      },
    });
    this._homey.log(`[OcppServer] SetChargingProfile ${stationId}: ${amperes}A`);
  }

  // Set charging limit via TxProfile (stackLevel 1, bound to active transaction).
  // Use this during an active session to override TxDefaultProfile.
  setTxProfile(stationId, txnId, amperes) {
    const ws = this._clients.get(stationId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    this._sendCall(ws, 'SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId:      2,
        transactionId:          txnId,
        stackLevel:             1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind:    'Relative',
        chargingSchedule: {
          chargingRateUnit:       'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: amperes, numberPhases: 3 }],
        },
      },
    });
    this._homey.log(`[OcppServer] SetChargingProfile TxProfile ${stationId}: txnId=${txnId} ${amperes}A`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _checkBasicAuth(header, expectedUser, expectedPass) {
    if (!header.startsWith('Basic ')) return false;
    try {
      const decoded  = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon    = decoded.indexOf(':');
      const user     = decoded.slice(0, colon);
      const pass     = decoded.slice(colon + 1);
      return user === expectedUser && pass === expectedPass;
    } catch {
      return false;
    }
  }

  _send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  _sendCall(ws, action, payload) {
    const uniqueId = `homey-${Date.now()}`;
    this._send(ws, [2, uniqueId, action, payload]);
    this._homey.log(`[OcppServer] → ${action}`);
  }

}

module.exports = OcppServer;
