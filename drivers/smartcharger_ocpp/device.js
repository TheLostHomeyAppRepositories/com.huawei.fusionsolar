'use strict';

const { Device } = require('homey');
const OcppServer = require('../../lib/ocpp-server');

const BLOCK_AMPS       = 0;   // 0 A limit sent as chargingRateUnit 'A' — see _blockProfile note
const IDLE_GUARD_MS    = 300_000; // refresh block profile every 5 min
const QUICK_ABORT_MS   = 2000;    // StopTransaction within 2 s = charger quick-abort
const MAX_SESSION_HIST = 10;

const OCPP_STATUS_MAP = {
  'Available':     'idle',
  'Preparing':     'connected',
  'Charging':      'charging',
  'SuspendedEVSE': 'connected',
  'SuspendedEV':   'connected',
  'Finishing':     'idle',
  'Reserved':      'idle',
  'Unavailable':   'error',
  'Faulted':       'error',
};

const REQUIRED_CAPABILITIES = [
  'onoff',
  'target_current',
  'measure_power',
  'meter_power',
  'evcharger_charging_state',
  'vehicle_soc',
  'ocpp_server_status',
  'ocpp_last_message',
  'measure_current',
  'measure_current.l1',
  'measure_current.l2',
  'measure_current.l3',
  'measure_voltage',
  'measure_voltage.l1',
  'measure_voltage.l2',
  'measure_voltage.l3',
  'measure_temperature',
];

class SmartChargerOcppDevice extends Device {

  async onInit() {
    this.log(`[OCPP] Device initialised: ${this.getName()}`);
    await this._ensureCapabilities();

    this._txnId                    = null;
    this._txnStartTime             = null;
    this._txnMeterStart            = 0;
    this._txnAmps                  = null;
    this._autoStartBlocked         = false;
    this._manualStartRequested     = false;
    this._quickAbortCount          = 0;
    this._idleGuardTimer           = null;
    this._prevState                = null;
    this._prevRawStatus            = null;
    this._connectionStart          = null;
    this._pendingStartTriggerTimer = null;
    this._pendingTxProfileTimer    = null;

    // Restore persisted session (survives app restart mid-charge)
    try {
      const sess = await this.getStoreValue('activeSession');
      if (sess && sess.txnId) {
        this._txnId         = sess.txnId;
        this._txnStartTime  = sess.startTime || null;
        this._txnMeterStart = sess.meterStart || 0;
        this._txnAmps       = sess.amps || null;
        this.log(`[OCPP] Restored session: txnId=${sess.txnId}, amps=${sess.amps}`);
      }
    } catch (e) { /* ignore */ }

    try {
      const cs = await this.getStoreValue('connectionStart');
      if (cs) this._connectionStart = cs;
    } catch (e) { /* ignore */ }

    try {
      const ps = await this.getStoreValue('prevState');
      if (ps) { this._prevState = ps.state; this._prevRawStatus = ps.raw; }
    } catch (e) { /* ignore */ }

    const stationId = this.getSetting('station_id');
    const server    = OcppServer.getInstance(this.homey);
    server.registerDevice(stationId, this);
    server.setCredentials(stationId, this.getSetting('ocpp_username'), this.getSetting('ocpp_password'));

    await this._set('ocpp_server_status', 'starting');

    this._registerCapabilityListeners();
    this._registerFlowActions();
    this._startIdleGuard();

    // Send initial profile 3 s after init so the charger gets the correct limit
    // immediately after a Homey app restart — BootNotification only fires on
    // charger reboot, not on app restart.
    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    setTimeout(() => {
      if (this._txnId && !this._autoStartBlocked) return; // active session — leave it alone
      const initAmps = autoStart ? defaultAmps : BLOCK_AMPS;
      try {
        OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), initAmps);
        this.log(`[OCPP] Init profile applied: ${initAmps}A`);
      } catch (e) { /* charger may not be connected yet */ }
    }, 3000);
  }

  async onSettings({ newSettings, changedKeys }) {
    const stationId = this.getSetting('station_id');
    const server    = OcppServer.getInstance(this.homey);
    server.setCredentials(stationId, newSettings.ocpp_username, newSettings.ocpp_password);

    const amps       = parseInt(newSettings.default_charging_amps) || 16;
    const autoStart  = newSettings.auto_start_charging !== false;

    if (changedKeys.includes('auto_start_charging')) {
      this._startIdleGuard();
      if (!autoStart) {
        // Just turned auto-start OFF
        if (!this._txnId) {
          try { server.setMaxCurrent(stationId, BLOCK_AMPS); } catch (e) { /* charger may be offline */ }
        } else {
          // Active session: block it
          this._autoStartBlocked = true;
          try { server.setTxProfile(stationId, this._txnId, BLOCK_AMPS); } catch (e) { /* ignore */ }
        }
      } else {
        // Just turned auto-start ON — apply default profile if idle
        if (!this._txnId) {
          try { server.setMaxCurrent(stationId, amps); } catch (e) { /* ignore */ }
        }
      }
    }

    if (changedKeys.includes('default_charging_amps')) {
      if (!this._txnId) {
        // Idle: update the default profile
        const targetAmps = autoStart ? amps : BLOCK_AMPS;
        try { server.setMaxCurrent(stationId, targetAmps); } catch (e) { /* ignore */ }
      } else if (!this._autoStartBlocked) {
        // Active session: update the running limit
        this._txnAmps = amps;
        try { server.setTxProfile(stationId, this._txnId, amps); } catch (e) { /* ignore */ }
        await this._saveSession();
      }
      // Restart idle guard only if auto-start is off (interval unchanged otherwise)
      if (!autoStart) this._startIdleGuard();
    }
  }

  async onDeleted() {
    this._clearTimers();
    OcppServer.getInstance(this.homey).unregisterDevice(this.getSetting('station_id'));
  }

  async onUninit() {
    this._clearTimers();
    OcppServer.getInstance(this.homey).unregisterDevice(this.getSetting('station_id'));
  }

  _clearTimers() {
    this._clearIdleGuard();
    if (this._pendingStartTriggerTimer) { clearTimeout(this._pendingStartTriggerTimer); this._pendingStartTriggerTimer = null; }
    if (this._pendingTxProfileTimer)    { clearTimeout(this._pendingTxProfileTimer);    this._pendingTxProfileTimer = null; }
  }

  // ─── Called by OcppServer ────────────────────────────────────────────────

  onOcppConnected() {
    this.log('[OCPP] Charger connected');
    this._set('ocpp_server_status', 'connected').catch(() => {});
  }

  onOcppDisconnected() {
    this.log('[OCPP] Charger disconnected');
    // Clear in-memory session — charger will re-send StartTransaction or
    // MeterValues on reconnect if a session is still active.
    this._txnId = null;
    this._autoStartBlocked = false;
    this._set('ocpp_server_status', 'waiting').catch(() => {});
    this._set('evcharger_charging_state', 'idle').catch(() => {});
    this._set('measure_power', 0).catch(() => {});
  }

  onBootNotification(payload) {
    this.log('[OCPP] BootNotification:', JSON.stringify(payload));
    this._set('ocpp_last_message', 'Boot: ' + (payload.chargePointModel || '?')).catch(() => {});
    if (!this.getAvailable()) this.setAvailable().catch(() => {});
    // Re-apply default profile 3 s after boot so charger has settled
    const autoStart  = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    const bootAmps   = autoStart ? defaultAmps : BLOCK_AMPS;
    setTimeout(() => {
      try {
        OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), bootAmps);
        this.log(`[OCPP] Boot profile applied: ${bootAmps}A`);
      } catch (e) { /* charger may not be ready yet */ }
    }, 3000);
  }

  onStatusNotification(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    this.log('[OCPP] StatusNotification:', JSON.stringify(payload));
    const rawStatus  = payload.status || '';
    const homeyState = OCPP_STATUS_MAP[rawStatus] || 'idle';

    this._set('evcharger_charging_state', homeyState).catch(() => {});
    this._set('ocpp_last_message', 'Status: ' + rawStatus).catch(() => {});

    if (rawStatus === 'Charging' && !this._autoStartBlocked) {
      this._set('onoff', true).catch(() => {});
    } else if (rawStatus === 'Available' || rawStatus === 'Finishing') {
      this._set('onoff', false).catch(() => {});
    }

    this._handleStateChange(homeyState, rawStatus)
      .catch((err) => this.log('[OCPP] State change error:', err.message));

    this.homey.flow.getDeviceTriggerCard('ocpp_charging_state_changed')
      .trigger(this, { state: homeyState })
      .catch(() => {});
  }

  async _handleStateChange(newState, rawStatus) {
    const oldState     = this._prevState;
    const oldRawStatus = this._prevRawStatus;
    if (newState === oldState) return;

    this.log(`[OCPP] State: ${oldState || 'null'} → ${newState}`);

    // Car newly plugged in
    const wasGenuinelyFree = oldState === null
      || (oldState === 'idle' && oldRawStatus !== 'Finishing' && oldRawStatus !== 'Reserved');
    if (wasGenuinelyFree && newState === 'connected') {
      this._connectionStart = Date.now();
      await this.setStoreValue('connectionStart', this._connectionStart).catch(() => {});
      this.log('[OCPP] Car plugged in');

      const autoStart = this.getSetting('auto_start_charging') !== false;
      if (autoStart) {
        // Some chargers require an explicit RemoteStartTransaction rather than
        // self-authorising locally. Proactively send one so auto-start works
        // regardless of the charger's local-auth configuration.
        // Guard: if the charger self-authorised in the meantime (_txnId set and
        // not blocked), skip — otherwise we'd send RemoteStart mid-session.
        this.log('[OCPP] Auto-start ON — proactively sending RemoteStartTransaction');
        setTimeout(() => {
          if (this._txnId && !this._autoStartBlocked) {
            this.log('[OCPP] Session already active — skipping proactive RemoteStart');
            return;
          }
          try { this.startCharging().catch(() => {}); } catch (e) { /* ignore */ }
        }, 500);
      } else {
        // Auto-start OFF: car is physically connected, waiting for manual start.
        // Fire the trigger immediately on plug-in, before any transaction.
        // This covers chargers that require RemoteStart (and never self-start).
        this.homey.flow.getDeviceTriggerCard('ocpp_car_plugged_waiting')
          .trigger(this, {})
          .catch((err) => this.log('[OCPP] Trigger ocpp_car_plugged_waiting failed:', err.message));
      }
    }

    // Car unplugged without charging (Preparing → Available without a transaction)
    if (oldState === 'connected' && newState === 'idle' && !this._txnId) {
      this._connectionStart = null;
      await this.setStoreValue('connectionStart', null).catch(() => {});
    }

    this._prevState     = newState;
    this._prevRawStatus = rawStatus;
    await this.setStoreValue('prevState', { state: newState, raw: rawStatus }).catch(() => {});
  }

  onMeterValues(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    this.log('[OCPP] MeterValues');
    for (const mv of (payload.meterValue || [])) {
      const sampledValues = mv.sampledValue || [];

      for (const sv of sampledValues) {
        const measurand = sv.measurand || 'Energy.Active.Import.Register';
        let val = parseFloat(sv.value);
        if (!Number.isFinite(val)) continue;
        const unit = (sv.unit || '').toLowerCase();
        if (unit.startsWith('k')) val *= 1000;
        else if (unit === 'mw' || unit === 'mwh' || unit === 'ma') val /= 1000;

        switch (measurand) {
          case 'Power.Active.Import':
            this._set('measure_power', Math.round(val)).catch(() => {});
            break;
          case 'Energy.Active.Import.Register':
            this._set('meter_power', parseFloat((val / 1000).toFixed(3))).catch(() => {});
            break;
          case 'SoC':
            this._set('vehicle_soc', Math.round(val)).catch(() => {});
            break;
          case 'Current.Import': {
            const ph = sv.phase || '';
            if (ph.startsWith('L1'))      this._set('measure_current.l1', val).catch(() => {});
            else if (ph.startsWith('L2')) this._set('measure_current.l2', val).catch(() => {});
            else if (ph.startsWith('L3')) this._set('measure_current.l3', val).catch(() => {});
            break;
          }
          case 'Voltage': {
            const ph = sv.phase || '';
            if (ph.startsWith('L1'))      this._set('measure_voltage.l1', val).catch(() => {});
            else if (ph.startsWith('L2')) this._set('measure_voltage.l2', val).catch(() => {});
            else if (ph.startsWith('L3')) this._set('measure_voltage.l3', val).catch(() => {});
            break;
          }
          case 'Temperature':
            this._set('measure_temperature', val).catch(() => {});
            break;
        }
      }

      // Compute aggregates from per-phase values
      let totalA = 0, countA = 0, totalV = 0, countV = 0;
      for (const sv of sampledValues) {
        if (sv.measurand === 'Current.Import' && sv.phase) {
          totalA += parseFloat(sv.value) || 0;
          countA++;
        }
        if (sv.measurand === 'Voltage' && sv.phase) {
          totalV += parseFloat(sv.value) || 0;
          countV++;
        }
      }
      if (countA > 0) this._set('measure_current', totalA).catch(() => {});
      if (countV > 0) this._set('measure_voltage', totalV / countV).catch(() => {});
    }
    this._set('ocpp_last_message', 'MeterValues received').catch(() => {});
  }

  async onStartTransaction(payload, txnId) {
    this.log('[OCPP] StartTransaction txnId:', txnId);

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    const activeAmps  = this._txnAmps || defaultAmps;

    this._txnId         = txnId;
    this._txnStartTime  = Date.now();
    // Use the charger's reported meterStart (Wh) if present — more accurate than
    // the last MeterValues reading which may be up to 10 s stale.
    this._txnMeterStart = payload.meterStart != null
      ? payload.meterStart
      : (this.getCapabilityValue('meter_power') || 0) * 1000;

    const manualStart = this._manualStartRequested;
    this._manualStartRequested = false;

    if (!autoStart && !manualStart) {
      // Block the transaction immediately with a 0 A TxProfile
      this._autoStartBlocked = true;
      this._txnAmps = BLOCK_AMPS;
      this.log(`[OCPP] Auto-start OFF — blocking with ${BLOCK_AMPS}A TxProfile`);
      try {
        OcppServer.getInstance(this.homey).setTxProfile(this.getSetting('station_id'), txnId, BLOCK_AMPS);
      } catch (e) { this.log('[OCPP] Block TxProfile failed:', e.message); }

      await this._set('onoff', false);
      await this._set('evcharger_charging_state', 'connected');
      await this._set('ocpp_last_message', 'Car connected — waiting for start');
      await this._saveSession();
      // Note: ocpp_car_plugged_waiting is fired from _handleStateChange on
      // StatusNotification(Preparing) — before any transaction — so chargers that
      // require explicit RemoteStart (and never self-start) also trigger the flow.
    } else {
      this._autoStartBlocked = false;
      this._txnAmps = activeAmps;
      await this._saveSession();
      await this._set('onoff', true);
      await this._set('evcharger_charging_state', 'charging');
      await this._set('ocpp_last_message', 'Charging started');

      // Delay the trigger by 2500 ms — longer than QUICK_ABORT_MS (2000 ms).
      // If the charger quick-aborts the session, onStopTransaction cancels
      // this timer so no false "charging started" flow fires.
      const startedTxId = txnId;
      if (this._pendingStartTriggerTimer) {
        clearTimeout(this._pendingStartTriggerTimer);
      }
      this._pendingStartTriggerTimer = setTimeout(() => {
        this._pendingStartTriggerTimer = null;
        if (this._txnId !== startedTxId) return; // session already superseded
        this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
          .trigger(this, { amps: activeAmps })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charging_started failed:', err.message));
      }, 2500);
    }
  }

  async onStopTransaction(payload) {
    this.log('[OCPP] StopTransaction:', JSON.stringify(payload));

    const meterStop  = payload.meterStop || 0;
    const reason     = payload.reason || 'Unknown';
    const durationMs = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    const energyWh   = Math.max(0, meterStop - this._txnMeterStart);
    const energyKwh  = parseFloat((energyWh / 1000).toFixed(3));

    // Quick-abort: charger aborts immediately (reason=Other, <2 s) — retry once
    const wasQuickAbort = reason === 'Other' && durationMs > 0 && durationMs < QUICK_ABORT_MS;
    if (wasQuickAbort && this._quickAbortCount < 1 && this._txnAmps && this._txnAmps > 0) {
      const retryAmps = this._txnAmps;
      this._quickAbortCount++;
      this.log(`[OCPP] Quick abort (${durationMs} ms, reason=Other) — retrying at ${retryAmps}A in 3 s`);
      // Cancel the pending start trigger — the session never actually started
      if (this._pendingStartTriggerTimer) {
        clearTimeout(this._pendingStartTriggerTimer);
        this._pendingStartTriggerTimer = null;
      }
      this._txnId = null; this._txnStartTime = null; this._autoStartBlocked = false;
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('onoff', false);
      await this._set('evcharger_charging_state', 'connected');
      const stationId = this.getSetting('station_id');
      setTimeout(() => {
        try {
          // Mark as manual so onStartTransaction won't block the retry even
          // when auto_start_charging is OFF.
          this._manualStartRequested = true;
          OcppServer.getInstance(this.homey).setMaxCurrent(stationId, retryAmps);
          OcppServer.getInstance(this.homey).remoteStart(stationId);
          this.log('[OCPP] Quick-abort retry sent');
        } catch (e) { this.log('[OCPP] Retry failed:', e.message); }
      }, 3000);
      return;
    }
    this._quickAbortCount = 0;

    const wasBlocked  = this._autoStartBlocked;
    const sessionAmps = this._txnAmps;

    this._txnId = null; this._txnStartTime = null;
    this._txnMeterStart = 0; this._txnAmps = null;
    this._autoStartBlocked = false;
    await this.setStoreValue('activeSession', null).catch(() => {});

    await this._set('onoff', false);
    await this._set('evcharger_charging_state', 'idle');
    await this._set('measure_power', 0);
    // Update the absolute cumulative energy meter (meterStop is in Wh, capability in kWh)
    if (meterStop) await this._set('meter_power', parseFloat((meterStop / 1000).toFixed(3)));
    await this._set('ocpp_last_message', 'Charging stopped');

    // Restore default profile
    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    const restoreAmps = autoStart ? defaultAmps : BLOCK_AMPS;
    setTimeout(() => {
      try { OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), restoreAmps); } catch (e) { /* ignore */ }
    }, 2000);

    if (!wasBlocked) {
      if (durationMs > 5000) {
        await this._recordSession({ durationMs, energyWh, amps: sessionAmps, reason });
      }
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_stopped')
        .trigger(this, { energy_delivered_kwh: energyKwh, reason })
        .catch((err) => this.log('[OCPP] Trigger ocpp_charging_stopped failed:', err.message));
    }
  }

  onServerStarted(port) {
    this.log(`[OCPP] Server listening on port ${port}`);
    this._set('ocpp_server_status', 'waiting').catch(() => {});
  }

  onServerError(err) {
    this.error('[OCPP] Server error:', err.message);
    this._set('ocpp_server_status', 'error').catch(() => {});
    this.setUnavailable('OCPP server error: ' + err.message).catch(() => {});
  }

  // ─── Charging control ────────────────────────────────────────────────────

  async startCharging(amps) {
    const stationId   = this.getSetting('station_id');
    const server      = OcppServer.getInstance(this.homey);
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    const targetAmps  = amps != null ? amps : defaultAmps;

    if (this._txnId && this._autoStartBlocked) {
      // Existing blocked transaction: just raise the limit
      this._autoStartBlocked = false;
      this._txnAmps = targetAmps;
      await this._saveSession();
      server.setTxProfile(stationId, this._txnId, targetAmps);
      await this._set('onoff', true);
      await this._set('evcharger_charging_state', 'charging');
      await this._set('ocpp_last_message', 'Charging started');
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
        .trigger(this, { amps: targetAmps }).catch(() => {});
      this.log(`[OCPP] Unblocked transaction ${this._txnId} at ${targetAmps}A`);
      return;
    }

    // No active transaction — set limit and send RemoteStartTransaction.
    // Mark as manual so onStartTransaction doesn't block the session even
    // when auto_start_charging is OFF.
    this._txnAmps = targetAmps;
    this._manualStartRequested = true;
    server.setMaxCurrent(stationId, targetAmps);
    server.remoteStart(stationId);
    this.log(`[OCPP] RemoteStart sent at ${targetAmps}A`);

    // Safety-net: re-apply the TxProfile 3 s after RemoteStart in case the
    // charger ignores the TxDefaultProfile that was set just before the start.
    if (this._pendingTxProfileTimer) clearTimeout(this._pendingTxProfileTimer);
    const safetyAmps = targetAmps;
    this._pendingTxProfileTimer = setTimeout(() => {
      this._pendingTxProfileTimer = null;
      if (!this._txnId || this._autoStartBlocked) return; // session gone or blocked
      try {
        server.setTxProfile(stationId, this._txnId, safetyAmps);
        this.log(`[OCPP] Safety-net TxProfile applied: ${safetyAmps}A`);
      } catch (e) { /* ignore — session may have ended */ }
    }, 3000);
  }

  // ─── Idle guard ──────────────────────────────────────────────────────────

  _startIdleGuard() {
    this._clearIdleGuard();
    const autoStart = this.getSetting('auto_start_charging') !== false;
    if (!autoStart) {
      this._idleGuardTimer = this.homey.setInterval(async () => {
        if (!this._txnId) {
          try {
            OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), BLOCK_AMPS);
            this.log('[OCPP] Idle guard: refreshed 0A TxDefaultProfile');
          } catch (e) { /* charger may be offline */ }
        }
      }, IDLE_GUARD_MS);
      this.log('[OCPP] Idle guard started (auto-start OFF)');
    }
  }

  _clearIdleGuard() {
    if (this._idleGuardTimer) {
      this.homey.clearInterval(this._idleGuardTimer);
      this._idleGuardTimer = null;
    }
  }

  // ─── Session persistence ─────────────────────────────────────────────────

  async _saveSession() {
    await this.setStoreValue('activeSession', {
      txnId:      this._txnId,
      startTime:  this._txnStartTime,
      meterStart: this._txnMeterStart,
      amps:       this._txnAmps,
    }).catch(() => {});
  }

  async _recordSession(entry) {
    try {
      const history = (await this.getStoreValue('sessionHistory')) || [];
      history.push({ ...entry, stopTime: Date.now() });
      while (history.length > MAX_SESSION_HIST) history.shift();
      await this.setStoreValue('sessionHistory', history);
    } catch (e) { /* ignore */ }
  }

  // ─── Capability listeners ────────────────────────────────────────────────

  _registerCapabilityListeners() {
    const stationId = this.getSetting('station_id');
    const server    = () => OcppServer.getInstance(this.homey);

    this.registerCapabilityListener('onoff', async (value) => {
      if (value) {
        await this.startCharging();
      } else {
        server().remoteStop(stationId);
      }
    });

    this.registerCapabilityListener('target_current', async (value) => {
      const s = server();
      if (this._txnId && !this._autoStartBlocked) {
        s.setTxProfile(stationId, this._txnId, value);
      } else {
        s.setMaxCurrent(stationId, value);
      }
      this._txnAmps = value;
      if (this._txnId) await this._saveSession();
    });
  }

  // ─── Flow actions ────────────────────────────────────────────────────────

  _registerFlowActions() {
    const stationId = this.getSetting('station_id');
    const server    = () => OcppServer.getInstance(this.homey);

    this.homey.flow.getActionCard('ocpp_set_max_current')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        if (this._txnId && !this._autoStartBlocked) {
          server().setTxProfile(stationId, this._txnId, args.amperes);
        } else {
          server().setMaxCurrent(stationId, args.amperes);
        }
        this._txnAmps = args.amperes;
        await this._set('target_current', args.amperes);
        if (this._txnId) await this._saveSession();
      });

    this.homey.flow.getActionCard('ocpp_remote_start')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.startCharging();
      });

    this.homey.flow.getActionCard('ocpp_start_charging_at')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.startCharging(args.amperes);
      });

    this.homey.flow.getActionCard('ocpp_remote_stop')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        server().remoteStop(stationId);
      });
  }

  // ─── Capabilities ────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try { await this.addCapability(cap); } catch (err) {
          this.error(`addCapability(${cap}) failed:`, err.message);
        }
      }
    }
  }

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try { await this.setCapabilityValue(capability, value); } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = SmartChargerOcppDevice;
