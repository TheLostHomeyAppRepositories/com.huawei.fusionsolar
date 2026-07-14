'use strict';

const { Device } = require('homey');
const OcppServer = require('../../lib/ocpp-server');
const SolarOffpeakEngine = require('../../lib/solar-offpeak-engine');

const VALID_AMPS          = [6, 8, 10, 12, 14, 16];
const AMPS_TO_WATTS       = (amps, phases = 3) => Math.round(amps * phases * 230);
const BLOCK_AMPS          = 0; // server converts 0A → 1W (Huawei firmware bug workaround)
const IDLE_GUARD_MS       = 300_000;
const QUICK_ABORT_MS      = 2000;
const MAX_SESSION_HIST    = 10;
const OFFLINE_AFTER_MS    = 180_000;
const LOW_POWER_W         = 100;
const LOW_POWER_FINISH_MS = 180_000;

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
  'session_status',
  'charging_profile',
  'status_summary',
  'pause_charging',
  'resume_charging',
  'charge_now',
  'release_charger',
  'resume_automation',
  'meter_session_energy',
  'session_duration',
];

// Old button capabilities to remove during migration
const REMOVE_CAPABILITIES = [
  'button.pause_charging',
  'button.resume_charging',
  'button.release_charger',
];

class SmartChargerOcppDevice extends Device {

  async onInit() {
    this.log(`[OCPP] Device initializing: ${this.getName()}`);

    // ── Migrate old button.* capabilities to custom capabilities ────────────
    for (const cap of REMOVE_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try {
          await this.removeCapability(cap);
          this.log(`[OCPP] Removed old capability: ${cap}`);
        } catch (e) { this.log(`[OCPP] Remove ${cap} failed: ${e.message}`); }
      }
    }
    await this._ensureCapabilities();

    // ── One-time setting migrations ─────────────────────────────────────────
    try {
      const v = this.getSetting('charger_vendor');
      if (!v || v === 'Unknown (not yet connected)' || v === 'Unknown') {
        await this.setSettings({ charger_vendor: 'Huawei' });
        this.log('[OCPP] Corrected stale charger_vendor setting to "Huawei"');
      }
    } catch (e) { this.log(`[OCPP] charger_vendor migration error: ${e.message}`); }

    // Dropdown value-type migration: Homey shows "–" for a dropdown on the
    // device settings list when the stored value's type doesn't match the
    // option ids (which are strings). Devices configured under older versions
    // may have numbers stored — convert once.
    try {
      const DROPDOWN_DEFAULTS = {
        number_of_phases: '3',
        default_charging_amps: '16',
        offpeak_amps: '16',
        charger_model: 'other',
      };
      const fixes = {};
      for (const [key, def] of Object.entries(DROPDOWN_DEFAULTS)) {
        const v = this.getSetting(key);
        if (typeof v === 'number') fixes[key] = String(v);
        else if (v === null || v === undefined || v === '') fixes[key] = def;
      }
      if (Object.keys(fixes).length) {
        await this.setSettings(fixes);
        this.log(`[OCPP] Migrated dropdown settings: ${JSON.stringify(fixes)}`);
      }
    } catch (e) { this.log(`[OCPP] Dropdown migration skipped: ${e.message}`); }

    // ── Core session state ──────────────────────────────────────────────────
    this._txnId                = null;
    this._txnStartTime         = null;
    this._txnMeterStart        = 0;
    this._txnAmps              = null;
    this._autoStartBlocked     = false;
    this._manualStartRequested = false;
    this._quickAbortCount      = 0;
    this.sessionPhaseOverride  = null;
    this.pendingStartAmps      = null;
    this.idTag                 = 'homey';
    this._startInFlight        = false;
    this.assumeActiveFromRestart = false;
    this._lastNonZero          = null;

    // ── Session ownership (tracks who started the current session) ──────────
    this.sessionOwner = null; // 'user' | 'solar' | 'offpeak' | null

    // ── Adaptive car-phase memory ───────────────────────────────────────────
    this._rememberedCarPhases = null;

    // ── Learned idTag for RemoteStart after restart ─────────────────────────
    this.learnedIdTag = 'homey';

    // ── Timer handles ───────────────────────────────────────────────────────
    this._idleGuardTimer                  = null;
    this._pendingTxProfileTimer           = null;
    this._pendingStartNotificationTimeout = null;

    // ── State tracking ──────────────────────────────────────────────────────
    this._prevState        = null;
    this._prevRawStatus    = null;
    this._connectionStart  = null;
    this._lowPowerSince    = null;
    this._startVerify      = null;

    // ── Masked pause / resume ───────────────────────────────────────────────
    this.stitchedSession = null;
    this.isPaused        = false;

    // ── Stop-reason / Fully-Charged heuristic ──────────────────────────────
    this.lastStopReason = null;

    // ── Offline watchdog ────────────────────────────────────────────────────
    this.chargerOffline        = false;
    this._expectedOfflineUntil = 0;
    this._offlineWatchdog      = null;
    this._offlineWasAlerted    = false;
    this._bootGraceStart       = null;

    // ── Restore persisted state ─────────────────────────────────────────────
    try {
      const sess = await this.getStoreValue('activeSession');
      if (sess && sess.txnId) {
        this._txnId         = sess.txnId;
        this._txnStartTime  = sess.startTime || null;
        this._txnMeterStart = sess.meterStart || 0;
        this._txnAmps       = sess.amps || null;
        this.sessionPhaseOverride = sess.phases || null;
        this.sessionOwner   = sess.owner || null;
        this.log(`[OCPP] Restored session: txnId=${sess.txnId}, amps=${sess.amps}, owner=${sess.owner}`);
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

    try {
      const stitched = await this.getStoreValue('stitchedSession');
      if (stitched && stitched.originalStartTime) {
        this.stitchedSession = stitched;
        this.isPaused = stitched.paused === true;
        if (stitched.owner) this.sessionOwner = stitched.owner;
        this.log(`[OCPP] Restored stitched session: started ${new Date(stitched.originalStartTime).toISOString()}, accum=${stitched.accumulatedEnergyWh || 0}Wh, paused=${this.isPaused}, owner=${stitched.owner}`);
      }
    } catch (e) { /* ignore */ }

    try {
      const sr = await this.getStoreValue('lastStopReason');
      if (sr) this.lastStopReason = sr;
    } catch (e) { /* ignore */ }

    try {
      const lnz = await this.getStoreValue('lastNonZero');
      if (lnz) this._lastNonZero = lnz;
    } catch (e) { /* ignore */ }

    try {
      const rcp = await this.getStoreValue('rememberedCarPhases');
      if (rcp === 1 || rcp === 2 || rcp === 3) this._rememberedCarPhases = rcp;
    } catch (e) { /* ignore */ }

    try {
      const lt = await this.getStoreValue('learnedIdTag');
      if (lt) this.learnedIdTag = lt;
    } catch (e) { /* ignore */ }

    // Restore offline state across restarts so the device card stays correct
    // and the "back online" notification fires once rather than being silently lost.
    try {
      if (await this.getStoreValue('chargerWasOffline')) {
        this.chargerOffline = true;
        this._offlineWasAlerted = true;
        this.log('[OCPP] Restored offline state after restart — waiting for charger (quietly)');
      }
    } catch (e) { /* ignore */ }

    // After restart, if the device was charging, suppress the idle guard
    // until the charger reconnects and sends a StatusNotification.
    const wasCharging = this.getCapabilityValue('evcharger_charging_state') === 'charging';
    this.assumeActiveFromRestart = wasCharging;

    // ── Solar / off-peak automation engine ─────────────────────────────────
    this.automationEngine = new SolarOffpeakEngine(this);
    await this.automationEngine.restoreInputs();
    this.automationEngine.start();

    // Session tile sensors: 60s refresh so the tile shows live numbers
    // during a session; one immediate pass to show restored session on boot.
    this._sessionTileInterval = this.homey.setInterval(() => {
      this._updateSessionTileSensors().catch(() => {});
    }, 60_000);
    this._updateSessionTileSensors().catch(() => {});

    // ── Register with OcppServer ────────────────────────────────────────────
    const stationId = this.getSetting('station_id');
    const ocppPort  = parseInt(this.getSetting('ocpp_port')) || 8887;
    const server    = OcppServer.getInstance(this.homey, ocppPort);
    server.registerDevice(stationId, this);
    server.setCredentials(stationId, this.getSetting('ocpp_username'), this.getSetting('ocpp_password'));

    await this._set('ocpp_server_status', 'starting');
    this._registerCapabilityListeners();
    this._registerFlowActions();
    this._startIdleGuard();

    // Offline watchdog — fires every 30 s
    this._offlineWatchdog = this.homey.setInterval(() => {
      this._checkChargerOnline().catch((err) => this.log(`[OCPP] Watchdog error: ${err.message}`));
    }, 30_000);

    // Send initial profile 3 s after init (BootNotification only fires on charger
    // reboot, not on Homey app restart — this catches the restart case).
    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    setTimeout(() => {
      if (this._txnId && !this._autoStartBlocked) return; // live session — leave alone
      const initAmps = autoStart ? defaultAmps : BLOCK_AMPS;
      try {
        OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), initAmps, this._getPhases());
        this.log(`[OCPP] Init profile applied: ${initAmps}A`);
      } catch (e) { /* charger may not be connected yet */ }
    }, 3000);

    this._updateChargingProfile().catch(() => {});
    this.log('[OCPP] Device initialized');
  }

  async onSettings({ newSettings, changedKeys }) {
    const stationId = this.getSetting('station_id');
    const ocppPort  = parseInt(newSettings.ocpp_port) || 8887;
    const server    = OcppServer.getInstance(this.homey, ocppPort);
    server.setCredentials(stationId, newSettings.ocpp_username, newSettings.ocpp_password);

    const amps      = parseInt(newSettings.default_charging_amps) || 16;
    const autoStart = newSettings.auto_start_charging !== false;

    if (newSettings.charger_model === '7ks' && String(newSettings.number_of_phases) === '3') {
      throw new Error('SCharger-7KS-S0 only supports Mono-Phase wiring — please set "Number of phases" to 1.');
    }
    if (newSettings.charger_model === '22kt' && String(newSettings.number_of_phases) === '1') {
      throw new Error('SCharger-22KT-S0 requires Tri-Phase wiring — please set "Number of phases" to 3.');
    }

    // Validate HH:MM format for off-peak time fields
    const timeRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
    for (const key of ['offpeak_weekday_start', 'offpeak_weekday_end', 'offpeak_weekend_start', 'offpeak_weekend_end']) {
      if (changedKeys.includes(key) && newSettings[key]) {
        if (!timeRe.test(newSettings[key].trim())) {
          throw new Error(`"${key}" must be in HH:MM format (e.g. 22:00 or 06:00), got "${newSettings[key]}".`);
        }
      }
    }
    // A zero-length window (start === end) would never open — catch it early.
    if (newSettings.offpeak_weekday_start && newSettings.offpeak_weekday_end
      && newSettings.offpeak_weekday_start.trim() === newSettings.offpeak_weekday_end.trim()) {
      throw new Error('Off-peak weekday start and end time must differ — a zero-length window is always closed.');
    }
    if (newSettings.offpeak_weekend_differs === true
      && newSettings.offpeak_weekend_start && newSettings.offpeak_weekend_end
      && newSettings.offpeak_weekend_start.trim() === newSettings.offpeak_weekend_end.trim()) {
      throw new Error('Off-peak weekend start and end time must differ — a zero-length window is always closed.');
    }

    // Solar / off-peak require smart charging (auto_start OFF)
    const willAutoStart = newSettings.auto_start_charging !== false;
    if (willAutoStart) {
      if (newSettings.solar_enabled === true) {
        throw new Error('Solar charging requires smart charging mode — please disable "Auto-start charging" first.');
      }
      if (newSettings.offpeak_enabled === true) {
        throw new Error('Off-peak charging requires smart charging mode — please disable "Auto-start charging" first.');
      }
    }

    // Engine restart when solar/offpeak settings toggle
    const engineKeys = ['solar_enabled', 'offpeak_enabled', 'offpeak_weekday_start', 'offpeak_weekday_end',
      'offpeak_weekend_differs', 'offpeak_weekend_start', 'offpeak_weekend_end', 'offpeak_amps',
      'offpeak_solar_first', 'solar_has_battery', 'solar_min_battery_soc', 'solar_count_battery_discharge',
      'solar_grid_tolerance_w', 'solar_start_sustain_s', 'solar_step_hold_s', 'solar_stop_grace_s'];
    if (changedKeys.some((k) => engineKeys.includes(k))) {
      // When a mode is disabled while it owns the current session, hand back to user
      if (changedKeys.includes('solar_enabled') && newSettings.solar_enabled !== true
        && this.sessionOwner === 'solar') {
        this.sessionOwner = 'user';
        this.log('[OCPP] Solar disabled — session ownership transferred to user');
      }
      if (changedKeys.includes('offpeak_enabled') && newSettings.offpeak_enabled !== true
        && this.sessionOwner === 'offpeak') {
        this.sessionOwner = 'user';
        this.log('[OCPP] Off-peak disabled — session ownership transferred to user');
      }
      // Suppression clearance: toggling a mode off→on resets engine state
      if (changedKeys.includes('solar_enabled') && newSettings.solar_enabled === true) {
        this.automationEngine.clearSuppression('solar');
      }
      if (changedKeys.includes('offpeak_enabled') && newSettings.offpeak_enabled === true) {
        this.automationEngine.clearSuppression('offpeak');
      }
    }

    if (changedKeys.includes('auto_start_charging')) {
      this._startIdleGuard();
      const currentState = this.getCapabilityValue('evcharger_charging_state') || 'idle';
      this._updateSessionStatus(currentState, autoStart).catch(() => {});

      if (!autoStart) {
        if (!this._txnId) {
          try {
            const r = await server.setMaxCurrentAsync(stationId, BLOCK_AMPS, this._getPhases());
            this.log('[OCPP] Block TxDefault response:', JSON.stringify(r));
          } catch (e) { this.log('[OCPP] Block TxDefault failed:', e.message); }
        } else {
          this._autoStartBlocked = true;
          try {
            const r = await server.setTxProfileAsync(stationId, this._txnId, BLOCK_AMPS, this._getPhases());
            this.log('[OCPP] Block TxProfile response:', JSON.stringify(r));
          } catch (e) { this.log('[OCPP] Block TxProfile failed:', e.message); }
        }
      } else {
        if (!this._txnId) {
          try {
            const r = await server.setMaxCurrentAsync(stationId, amps, this._getPhases());
            this.log('[OCPP] Restore TxDefault response:', JSON.stringify(r));
          } catch (e) { this.log('[OCPP] Restore TxDefault failed:', e.message); }
        }
      }
    }

    if (changedKeys.includes('default_charging_amps')) {
      if (!this._txnId) {
        const targetAmps = autoStart ? amps : BLOCK_AMPS;
        try {
          const r = await server.setMaxCurrentAsync(stationId, targetAmps, this._getPhases());
          this.log('[OCPP] Updated TxDefault response:', JSON.stringify(r));
        } catch (e) { this.log('[OCPP] Updated TxDefault failed:', e.message); }
      } else if (!this._autoStartBlocked) {
        this._txnAmps = amps;
        try {
          const r = await server.setTxProfileAsync(stationId, this._txnId, amps, this._getPhases());
          this.log('[OCPP] Updated TxProfile response:', JSON.stringify(r));
        } catch (e) { this.log('[OCPP] Updated TxProfile failed:', e.message); }
        await this._saveSession();
      }
      if (!autoStart) this._startIdleGuard();
    }

    if (changedKeys.includes('number_of_phases')) {
      this._updateChargingProfile().catch(() => {});
    }
  }

  async onDeleted() {
    this._clearTimers();
    OcppServer.getInstance(this.homey).unregisterDevice(this.getSetting('station_id'));
    this.log('[OCPP] Device deleted');
  }

  async onUninit() {
    this._clearTimers();
    OcppServer.getInstance(this.homey).unregisterDevice(this.getSetting('station_id'));
  }

  _clearTimers() {
    this._clearIdleGuard();
    if (this.automationEngine) this.automationEngine.stop();
    if (this._sessionTileInterval) {
      this.homey.clearInterval(this._sessionTileInterval);
      this._sessionTileInterval = null;
    }
    if (this._offlineWatchdog) {
      this.homey.clearInterval(this._offlineWatchdog);
      this._offlineWatchdog = null;
    }
    if (this._pendingTxProfileTimer) {
      clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
    }
    if (this._pendingStartNotificationTimeout) {
      clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = null;
    }
  }

  // ─── Called by OcppServer ────────────────────────────────────────────────

  onOcppConnected() {
    this.log('[OCPP] Charger connected');
    this._set('ocpp_server_status', 'connected').catch(() => {});
  }

  onOcppDisconnected() {
    this.log('[OCPP] Charger disconnected');
    this._txnId = null;
    this._autoStartBlocked = false;
    this._set('ocpp_server_status', 'waiting').catch(() => {});
    // 'error' not 'idle': connectivity loss must be visible to the user
    this._set('evcharger_charging_state', 'error').catch(() => {});
    this._updateSessionStatus('error').catch(() => {});
    this._set('measure_power', 0).catch(() => {});
  }

  onBootNotification(payload) {
    this.log('[OCPP] BootNotification:', JSON.stringify(payload));
    this._set('ocpp_last_message', 'Boot: ' + (payload.chargePointModel || '?')).catch(() => {});
    if (!this.getAvailable()) this.setAvailable().catch(() => {});
    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    const bootAmps    = autoStart ? defaultAmps : BLOCK_AMPS;
    setTimeout(() => {
      try {
        OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), bootAmps, this._getPhases());
        this.log(`[OCPP] Boot profile applied: ${bootAmps}A`);
      } catch (e) { /* charger may not be ready yet */ }
    }, 3000);
  }

  onStatusNotification(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    this.log('[OCPP] StatusNotification:', JSON.stringify(payload));
    const rawStatus  = payload.status || '';
    const homeyState = OCPP_STATUS_MAP[rawStatus] || 'idle';

    // First StatusNotification after restart confirms charger is live — clear
    // the restart-guard so the idle guard can run normally from here on.
    this.assumeActiveFromRestart = false;

    this._set('evcharger_charging_state', homeyState).catch(() => {});
    this._set('ocpp_last_message', 'Status: ' + rawStatus).catch(() => {});

    if (rawStatus === 'Charging' && !this._autoStartBlocked) {
      this._set('onoff', true).catch(() => {});
    } else if (rawStatus === 'Available' || rawStatus === 'Finishing') {
      this._set('onoff', false).catch(() => {});
    }

    this._updateSessionStatus(homeyState).catch(() => {});

    this._handleStateChange(homeyState, rawStatus)
      .catch((err) => this.log('[OCPP] State change error:', err.message));

    this.homey.flow.getDeviceTriggerCard('ocpp_charging_state_changed')
      .trigger(this, { state: homeyState })
      .catch(() => {});
  }

  async _handleStateChange(newState, rawStatus) {
    const oldState     = this._prevState;
    const oldRawStatus = this._prevRawStatus;

    // Genuine unplug detection — only rawStatus='Available' means cable-free
    const cableWasIn = oldState === 'connected' || oldState === 'charging'
      || (oldState === 'idle' && oldRawStatus === 'Finishing');
    if (cableWasIn && rawStatus === 'Available' && oldRawStatus !== 'Available') {
      const connStart = this._connectionStart;
      this._connectionStart = null;
      await this.setStoreValue('connectionStart', null).catch(() => {});
      await this._resetSessionTileSensors();
      // Deferred 4 s: let pending StopTransaction settle before reporting unplug
      setTimeout(async () => {
        if (this._txnId) return;
        await this._handleUnpluggedWithoutCharging(connStart);
      }, 4000);
    }

    // Fresh plug-in: clear stale "Fully Charged" flag from previous session
    if (newState === 'connected' && oldRawStatus === 'Available' && this.lastStopReason) {
      this.log(`[OCPP] Fresh plug-in — clearing previous stop reason (was ${this.lastStopReason})`);
      this.lastStopReason = null;
      await this.setStoreValue('lastStopReason', null).catch(() => {});
    }

    if (newState === oldState) {
      this._prevRawStatus = rawStatus;
      return;
    }

    this.log(`[OCPP] State: ${oldState || 'null'} → ${newState}`);

    const wasGenuinelyFree = oldState === null
      || (oldState === 'idle' && oldRawStatus !== 'Finishing' && oldRawStatus !== 'Reserved');

    if (wasGenuinelyFree && newState === 'connected') {
      // Boot replay guard: if this is the first StatusNotification after a
      // restart and we already restored a connectionStart from the store,
      // keep the original plug-in time instead of stamping Date.now().
      const bootReplay = oldState === null && this._connectionStart;
      if (!bootReplay) {
        this._connectionStart = Date.now();
        await this.setStoreValue('connectionStart', this._connectionStart).catch(() => {});
      }
      this.log('[OCPP] Car plugged in');

      const autoStart = this.getSetting('auto_start_charging') !== false;
      if (autoStart) {
        this.log('[OCPP] Auto-start ON — proactively sending RemoteStartTransaction');
        setTimeout(() => {
          if (this._txnId && !this._autoStartBlocked) {
            this.log('[OCPP] Session already active — skipping proactive RemoteStart');
            return;
          }
          try { this.startCharging().catch(() => {}); } catch (e) { /* ignore */ }
        }, 500);
      } else {
        await this._postNotification('🚗', 'Car Plugged In', 'Car connected — ready to start');
        this.homey.flow.getDeviceTriggerCard('ocpp_car_plugged_waiting')
          .trigger(this, {})
          .catch((err) => this.log('[OCPP] Trigger ocpp_car_plugged_waiting failed:', err.message));
      }
    }

    // State-driven session hooks — secondary guard alongside StartTransaction/StopTransaction
    if (oldState !== 'charging' && newState === 'charging') {
      await this.handleSessionStart();
    }
    if (oldState === 'charging' && (newState === 'idle' || newState === 'connected' || newState === 'error')) {
      await this.handleSessionEnd();
    }

    if (oldState === 'connected' && newState === 'idle' && !this._txnId) {
      this._connectionStart = null;
      await this.setStoreValue('connectionStart', null).catch(() => {});
    }

    this._prevState     = newState;
    this._prevRawStatus = rawStatus;
    await this.setStoreValue('prevState', { state: newState, raw: rawStatus }).catch(() => {});
  }

  // Status-driven session hooks — secondary guard alongside StartTransaction/StopTransaction.
  // handleSessionStart establishes a baseline if none exists (e.g. charger self-authorized).
  // handleSessionEnd logs only — onStopTransaction owns the actual cleanup.
  async handleSessionStart() {
    if (!this._txnId) {
      this._txnId        = Math.floor(Date.now() / 1000);
      this._txnStartTime = Date.now();
      this._txnMeterStart = (this.getCapabilityValue('meter_power') || 0) * 1000;
      this.log(`[OCPP] handleSessionStart: synthetic txnId=${this._txnId}`);
    } else {
      this.log(`[OCPP] handleSessionStart: session already tracked (txnId=${this._txnId})`);
    }
  }

  async handleSessionEnd() {
    const currentEnergy = this.getCapabilityValue('meter_power') || 0;
    const energyWh      = Math.max(0, Math.round((currentEnergy * 1000) - this._txnMeterStart));
    const durationMs    = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    this.log(`[OCPP] handleSessionEnd: ~${energyWh}Wh over ${this._formatDuration(durationMs)}`);
    // Do NOT reset transactionId here — onStopTransaction is the sole owner of that cleanup.
  }

  async _handleUnpluggedWithoutCharging(connStart) {
    if (this.stitchedSession) {
      await this._finalizeStitchedSession('EVDisconnected');
    }
    this.lastStopReason = null;
    await this.setStoreValue('lastStopReason', null).catch(() => {});

    const durationMs  = connStart ? (Date.now() - connStart) : 0;
    const durationStr = this._formatDuration(durationMs);
    const message     = `Disconnected · plugged in for ${durationStr}`;

    await this._postNotification('🚗', 'Disconnected', message);
    this.homey.flow.getDeviceTriggerCard('ocpp_disconnected')
      .trigger(this, { connected_minutes: Math.round(durationMs / 60000), message })
      .catch((err) => this.log('[OCPP] Trigger ocpp_disconnected failed:', err.message));
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

          case 'Power.Active.Import': {
            const powerW = Math.round(val);
            this._set('measure_power', powerW).catch(() => {});
            this._trackLastNonZero('measure_power', powerW);

            // Power-verified start: first real draw → announce started / resumed
            if (this._startVerify && this._startVerify.txId === this._txnId && powerW > LOW_POWER_W) {
              const v = this._startVerify;
              this._startVerify = null;
              if (this._pendingStartNotificationTimeout) {
                clearTimeout(this._pendingStartNotificationTimeout);
                this._pendingStartNotificationTimeout = null;
              }
              this.log(`[OCPP] Power flowing (${powerW}W) — announcing verified ${v.isMaskedResume ? 'resume' : 'start'}`);
              this._announceVerifiedStart(v).catch((err) => this.log(`[OCPP] Announce error: ${err.message}`));
            }

            // Low-power streak: Charging but ~0W for 3 min → 'finishing'
            if (this._txnId && this.getCapabilityValue('evcharger_charging_state') === 'charging') {
              if (powerW < LOW_POWER_W) {
                if (!this._lowPowerSince) this._lowPowerSince = Date.now();
              } else {
                this._lowPowerSince = null;
              }
              this._updateSessionStatus('charging').catch(() => {});
            } else {
              this._lowPowerSince = null;
            }
            break;
          }

          case 'Energy.Active.Import.Register':
            this._set('meter_power', parseFloat((val / 1000).toFixed(3))).catch(() => {});
            this._trackLastNonZero('meter_power', val / 1000);
            break;

          case 'SoC':
            this._set('vehicle_soc', Math.round(val)).catch(() => {});
            break;

          case 'Current.Import': {
            const ph = sv.phase || '';
            if (ph.startsWith('L1'))      { this._set('measure_current.l1', val).catch(() => {}); this._trackLastNonZero('measure_current.l1', val); }
            else if (ph.startsWith('L2')) { this._set('measure_current.l2', val).catch(() => {}); this._trackLastNonZero('measure_current.l2', val); }
            else if (ph.startsWith('L3')) { this._set('measure_current.l3', val).catch(() => {}); this._trackLastNonZero('measure_current.l3', val); }
            break;
          }

          case 'Voltage': {
            const ph = sv.phase || '';
            if (ph.startsWith('L1'))      { this._set('measure_voltage.l1', val).catch(() => {}); this._trackLastNonZero('measure_voltage.l1', val); }
            else if (ph.startsWith('L2')) { this._set('measure_voltage.l2', val).catch(() => {}); this._trackLastNonZero('measure_voltage.l2', val); }
            else if (ph.startsWith('L3')) { this._set('measure_voltage.l3', val).catch(() => {}); this._trackLastNonZero('measure_voltage.l3', val); }
            break;
          }

          case 'Temperature':
            this._set('measure_temperature', val).catch(() => {});
            this._trackLastNonZero('measure_temperature', val);
            break;
        }
      }

      // Aggregates from per-phase values
      let totalA = 0, countA = 0, totalV = 0, countV = 0;
      for (const sv of sampledValues) {
        if (sv.measurand === 'Current.Import' && sv.phase) { totalA += parseFloat(sv.value) || 0; countA++; }
        if (sv.measurand === 'Voltage' && sv.phase)        { totalV += parseFloat(sv.value) || 0; countV++; }
      }
      if (countA > 0) this._set('measure_current', totalA).catch(() => {});
      if (countV > 0) this._set('measure_voltage', totalV / countV).catch(() => {});
    }

    this._set('ocpp_last_message', 'MeterValues received').catch(() => {});
  }

  async onStartTransaction(payload, txnId) {
    this.log('[OCPP] StartTransaction txnId:', txnId);
    this._lowPowerSince = null;

    if (payload.idTag) {
      this.idTag = payload.idTag;
      // Persist idTag so RemoteStart works correctly after a Homey restart
      this.learnedIdTag = payload.idTag;
      this.setStoreValue('learnedIdTag', payload.idTag).catch(() => {});
    }

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;

    this._txnId         = txnId;
    this._txnStartTime  = Date.now();
    this._txnMeterStart = payload.meterStart != null
      ? payload.meterStart
      : (this.getCapabilityValue('meter_power') || 0) * 1000;
    this.lastStopReason = null;
    await this.setStoreValue('lastStopReason', null).catch(() => {});

    const manualStart = this._manualStartRequested;
    this._manualStartRequested = false;

    if (!autoStart && !manualStart) {
      this._autoStartBlocked = true;
      this._txnAmps = BLOCK_AMPS;
      this.log(`[OCPP] Auto-start OFF — blocking with ${BLOCK_AMPS}A TxProfile`);
      try {
        OcppServer.getInstance(this.homey).setTxProfile(this.getSetting('station_id'), txnId, BLOCK_AMPS, this._getPhases());
      } catch (e) { this.log('[OCPP] Block TxProfile failed:', e.message); }

      await this._set('onoff', false);
      await this._set('evcharger_charging_state', 'connected');
      await this._set('ocpp_last_message', 'Car connected — waiting for start');
      await this._saveSession();
      await this._updateSessionStatus('connected');

    } else {
      const isMaskedResume = !!(this.stitchedSession && this.stitchedSession.resuming);
      const activeAmps     = this._txnAmps || this.pendingStartAmps || defaultAmps;
      this._txnAmps        = activeAmps;
      this.pendingStartAmps = null;
      this._autoStartBlocked = false;
      await this._saveSession();
      await this._set('onoff', true);
      await this._set('evcharger_charging_state', 'charging');
      await this._set('ocpp_last_message', isMaskedResume ? 'Charging resumed' : 'Charging started');
      await this._updateSessionStatus('charging');
      this._updateChargingProfile().catch(() => {});

      // Power-verified start: set watcher; fires _announceVerifiedStart() when >100W arrives.
      const startedTxId = txnId;
      this._startVerify = { txId: startedTxId, isMaskedResume, activeAmps };

      if (this._pendingStartNotificationTimeout) clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = setTimeout(async () => {
        this._pendingStartNotificationTimeout = null;
        if (!this._startVerify || this._startVerify.txId !== startedTxId) return;
        if (this._txnId !== startedTxId) return;
        const what = isMaskedResume ? 'Resume' : 'Start';
        this.log(`[OCPP] ${what} requested but no power after 90s — car may be full`);
        await this._postNotification('🪫', `${what} Requested`, `${what} requested · car isn't drawing power (battery may be full?)`);
      }, 90_000);
    }
  }

  async onStopTransaction(payload) {
    this.log('[OCPP] StopTransaction:', JSON.stringify(payload));

    const meterStop  = payload.meterStop || 0;
    const reason     = payload.reason || 'Unknown';
    const durationMs = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    const energyWh   = Math.max(0, meterStop - this._txnMeterStart);

    // ── Masked pause: this stop is OURS — accumulate segment, suppress events ──
    if (this.stitchedSession && this.stitchedSession.stopRequested) {
      this.stitchedSession.stopRequested       = false;
      this.stitchedSession.accumulatedEnergyWh = (this.stitchedSession.accumulatedEnergyWh || 0) + Math.max(0, energyWh);
      await this._persistStitched();
      this.log(`[OCPP] Masked pause: segment closed (+${Math.max(0, energyWh)}Wh, ${this.stitchedSession.accumulatedEnergyWh}Wh accumulated)`);

      this._quickAbortCount = 0;
      this._txnId = null; this._txnStartTime = null;
      this._txnMeterStart = 0;
      // Deliberately preserve _txnAmps — it's the resume target shown by charging_profile.
      this._autoStartBlocked = false;
      this._lowPowerSince = null;
      this._startVerify   = null;
      if (this._pendingStartNotificationTimeout) {
        clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      if (this._pendingTxProfileTimer) {
        clearTimeout(this._pendingTxProfileTimer);
        this._pendingTxProfileTimer = null;
      }
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('onoff', false);
      await this._updateSessionStatus('connected');

      setTimeout(() => {
        try {
          OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), BLOCK_AMPS, this._getPhases());
          this.log(`[OCPP] Masked pause: ${BLOCK_AMPS}A hold applied for paused gap`);
        } catch (e) { /* ignore */ }
      }, 2000);
      return;
    }

    // ── Quick-abort: charger aborts <2 s (reason=Other) — retry once ─────────
    const wasQuickAbort = reason === 'Other' && durationMs > 0 && durationMs < QUICK_ABORT_MS;
    if (wasQuickAbort && this._quickAbortCount < 1 && this._txnAmps && this._txnAmps > 0) {
      const retryAmps   = this._txnAmps;
      const retryPhases = this.sessionPhaseOverride;
      this._quickAbortCount++;
      this.log(`[OCPP] Quick abort (${durationMs}ms, reason=Other) — retrying at ${retryAmps}A in 3s`);

      if (this._pendingStartNotificationTimeout) {
        clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      if (this._pendingTxProfileTimer) {
        clearTimeout(this._pendingTxProfileTimer);
        this._pendingTxProfileTimer = null;
      }
      this._startVerify = null;
      this._txnId = null; this._txnStartTime = null;
      this._autoStartBlocked = false;
      this.sessionPhaseOverride = null;
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('onoff', false);
      await this._set('evcharger_charging_state', 'connected');

      const stationId = this.getSetting('station_id');
      setTimeout(() => {
        try {
          this._manualStartRequested = true;
          this.sessionPhaseOverride = retryPhases;
          OcppServer.getInstance(this.homey).setMaxCurrent(stationId, retryAmps, retryPhases || this._devicePhases());
          OcppServer.getInstance(this.homey).remoteStart(stationId);
          this.log('[OCPP] Quick-abort retry sent');
        } catch (e) { this.log('[OCPP] Retry failed:', e.message); }
      }, 3000);
      return;
    }
    this._quickAbortCount = 0;

    // ── Stitched resume ended — report as ONE continuous session ─────────────
    let reportStartTime = this._txnStartTime;
    let reportEnergyWh  = energyWh;
    if (this.stitchedSession) {
      reportStartTime = this.stitchedSession.originalStartTime;
      reportEnergyWh  = (this.stitchedSession.accumulatedEnergyWh || 0) + Math.max(0, energyWh);
      this.log(`[OCPP] Masked pause: final stop — stitched session total=${reportEnergyWh}Wh, reason=${reason}`);
      this.stitchedSession = null;
      this.isPaused = false;
      await this._persistStitched();
    }
    const reportDurationMs = reportStartTime ? (Date.now() - reportStartTime) : 0;

    const wasBlocked      = this._autoStartBlocked;
    const sessionAmps     = this._txnAmps;
    const sessionPhases   = this._getPhases();
    const sessionOwnerWas = this.sessionOwner;

    this.lastStopReason = reason;
    await this.setStoreValue('lastStopReason', reason).catch(() => {});

    this._txnId = null; this._txnStartTime = null;
    this._txnMeterStart = 0; this._txnAmps = null;
    this._autoStartBlocked = false;
    this._lowPowerSince = null;
    this._startVerify   = null;
    this.sessionPhaseOverride = null;
    this.isPaused = false;
    this.sessionOwner = null;
    if (this._pendingStartNotificationTimeout) {
      clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = null;
    }
    if (this._pendingTxProfileTimer) {
      clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
    }
    await this.setStoreValue('activeSession', null).catch(() => {});

    await this._set('onoff', false);
    const settledState = (() => {
      const cur = this.getCapabilityValue('evcharger_charging_state');
      if (cur && cur !== 'charging') return cur;
      return 'connected';
    })();
    await this._set('evcharger_charging_state', settledState);
    await this._set('measure_power', 0);
    if (meterStop) await this._set('meter_power', parseFloat((meterStop / 1000).toFixed(3)));
    await this._set('ocpp_last_message', 'Charging stopped');
    await this._updateSessionStatus(settledState);
    this._updateChargingProfile().catch(() => {});

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;
    const restoreAmps = autoStart ? defaultAmps : BLOCK_AMPS;
    setTimeout(() => {
      try { OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), restoreAmps, this._getPhases()); } catch (e) { /* ignore */ }
    }, 2000);

    if (!wasBlocked) {
      if (reportDurationMs >= 5000) {
        await this._recordSession({ durationMs: reportDurationMs, energyWh: reportEnergyWh, amps: sessionAmps, phases: sessionPhases, reason, startTime: reportStartTime, owner: sessionOwnerWas });
      }

      const durationStr = this._formatDuration(reportDurationMs);
      const energyStr   = this._formatEnergy(reportEnergyWh);
      const energyKwh   = parseFloat((reportEnergyWh / 1000).toFixed(3));
      const message     = `Charging finished · ${energyStr} · ${durationStr}`;

      if (reportEnergyWh > 0) {
        await this._postNotification('🔌', 'Charging Stopped', message);
      }

      this.homey.flow.getDeviceTriggerCard('ocpp_charging_stopped')
        .trigger(this, {
          energy_delivered_kwh:       energyKwh,
          energy_delivered_wh:        reportEnergyWh,
          energy_delivered_formatted: energyStr,
          duration_minutes:           Math.round(reportDurationMs / 60000),
          duration_formatted:         durationStr,
          reason,
          amps:    sessionAmps || 0,
          phases:  sessionPhases,
          message,
        })
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

  async startCharging(amps, overridePhases, owner) {
    this._startInFlight = true;
    try {
      return await this._startChargingInner(amps, overridePhases, owner);
    } finally {
      this._startInFlight = false;
    }
  }

  async _startChargingInner(amps, overridePhases, owner) {
    const stationId   = this.getSetting('station_id');
    const server      = OcppServer.getInstance(this.homey);
    const defaultAmps = parseInt(this.getSetting('default_charging_amps')) || 16;

    // Set (or clear) session phase override before any _getPhases() call
    this.sessionPhaseOverride = (overridePhases === 1 || overridePhases === 3) ? overridePhases : null;

    const targetAmps = amps != null ? amps : (this.pendingStartAmps || defaultAmps);
    this.pendingStartAmps = null;

    // Hardware floor check before any state mutation
    this._validateProfileRequest(targetAmps, this._getPhases());

    if (this._txnId && this._autoStartBlocked) {
      // Existing blocked transaction: raise the limit instead of starting fresh
      this._autoStartBlocked = false;
      this._txnAmps = targetAmps;
      this.sessionOwner = owner || 'user';
      await this._saveSession();
      const unblockResp = await server.setTxProfileAsync(stationId, this._txnId, targetAmps, this._getPhases());
      this.log(`[OCPP] Unblock TxProfile response: ${JSON.stringify(unblockResp)}`);
      await this._set('onoff', true);
      await this._set('evcharger_charging_state', 'charging');
      await this._set('ocpp_last_message', 'Charging started');
      await this._updateSessionStatus('charging');
      this._updateChargingProfile().catch(() => {});
      const phases  = this._getPhases();
      const message = `Charging started · ${this._kwLabel(targetAmps, phases)} (${targetAmps}A) / ${this._phaseLabel(phases)}`;
      await this._postNotification('🔋', 'Charging Started', message);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
        .trigger(this, { amps: targetAmps, phases, phase_label: this._phaseLabel(phases), message,
          transaction_id: this._txnId || 0, meter_start: this._txnMeterStart || 0 })
        .catch(() => {});
      this.log(`[OCPP] Unblocked transaction ${this._txnId} at ${targetAmps}A (owner: ${this.sessionOwner})`);
      return;
    }

    // No active transaction — set limit and send RemoteStartTransaction
    this._txnAmps = targetAmps;
    this.sessionOwner = owner || 'user';
    this._manualStartRequested = true;
    try {
      const limitResp = await server.setMaxCurrentAsync(stationId, targetAmps, this._getPhases());
      this.log(`[OCPP] setMaxCurrent response: ${JSON.stringify(limitResp)}`);
    } catch (e) { this.log('[OCPP] setMaxCurrent before start failed:', e.message); }
    const startResp = await server.remoteStartAsync(stationId);
    this.log(`[OCPP] RemoteStart response: ${JSON.stringify(startResp)}`);
    if (startResp && startResp.status === 'Rejected') {
      this.log('[OCPP] RemoteStart rejected by charger');
    }
    this._updateChargingProfile().catch(() => {});

    // Safety-net: re-apply TxProfile 3 s after RemoteStart
    if (this._pendingTxProfileTimer) clearTimeout(this._pendingTxProfileTimer);
    const safetyAmps   = targetAmps;
    const safetyPhases = this._getPhases();
    this._pendingTxProfileTimer = setTimeout(() => {
      this._pendingTxProfileTimer = null;
      if (!this._txnId || this._autoStartBlocked) return;
      server.setTxProfileAsync(stationId, this._txnId, safetyAmps, safetyPhases)
        .then(r => this.log(`[OCPP] Safety-net TxProfile applied: ${safetyAmps}A — ${JSON.stringify(r)}`))
        .catch(e => this.log(`[OCPP] Safety-net TxProfile failed: ${e.message}`));
    }, 3000);
  }

  async stopCharging(source) {
    if (!this._txnId) {
      if (this.stitchedSession && this.stitchedSession.paused) {
        this.log('[OCPP] Stop during masked pause — finalizing logical session');
        if (source !== 'engine' && this.automationEngine
          && (this.sessionOwner === 'solar' || this.sessionOwner === 'offpeak')) {
          this.automationEngine.noteUserStop(this.sessionOwner);
        }
        await this._finalizeStitchedSession('Remote');
        await this._updateSessionStatus('connected');
        return;
      }
      this.log('[OCPP] No active transaction to stop');
      return;
    }
    // User stopped an engine session — signal the engine to back off
    if (source !== 'engine' && this.automationEngine
      && (this.sessionOwner === 'solar' || this.sessionOwner === 'offpeak')) {
      this.automationEngine.noteUserStop(this.sessionOwner);
    }
    try {
      const response = await OcppServer.getInstance(this.homey).remoteStopAsync(this.getSetting('station_id'));
      this.log('[OCPP] RemoteStop response:', JSON.stringify(response));
    } catch (e) {
      this.log('[OCPP] RemoteStop failed:', e.message);
      throw e;
    }
  }

  // ─── Masked Pause / Resume ───────────────────────────────────────────────

  async pauseCharging(context) {
    if (this.stitchedSession && this.stitchedSession.paused) {
      this.log('[OCPP] Already paused — ignoring duplicate pause');
      return;
    }
    if (!this._txnId) {
      throw new Error('No active charging session to pause.');
    }

    // User manually pausing an engine session → hand ownership to user
    if (!context || context === 'user') {
      if (this.automationEngine && (this.sessionOwner === 'solar' || this.sessionOwner === 'offpeak')) {
        this.automationEngine.noteUserStop(this.sessionOwner);
      }
      this.sessionOwner = 'user';
    }

    const resumeAmps   = this._txnAmps || parseInt(this.getSetting('default_charging_amps')) || 16;
    const resumePhases = this.sessionPhaseOverride;
    const prior        = this.stitchedSession;
    const pauseOwner   = this.sessionOwner;

    this.stitchedSession = {
      originalStartTime:   prior ? prior.originalStartTime   : this._txnStartTime,
      accumulatedEnergyWh: prior ? (prior.accumulatedEnergyWh || 0) : 0,
      paused:              true,
      stopRequested:       true,
      resuming:            false,
      resumeAmps,
      resumePhases,
      owner:               pauseOwner,
    };
    this.isPaused = true;
    await this._persistStitched();

    this.log(`[OCPP] Masked pause: stopping transaction ${this._txnId} (context=${context || 'user'}, will resume at ${resumeAmps}A)`);

    let pauseMessage;
    if (context === 'solar-stale') {
      pauseMessage = 'Solar charging paused — energy data is stale (check update flows)';
    } else if (context === 'solar') {
      pauseMessage = 'Solar charging paused — surplus below floor';
    } else {
      pauseMessage = 'Charging paused';
    }

    try {
      const stopResponse = await OcppServer.getInstance(this.homey).remoteStopAsync(this.getSetting('station_id'));
      if (stopResponse && stopResponse.status === 'Rejected') {
        throw new Error('Charger rejected the stop request');
      }
      await this._postNotification('⏸️', 'Charging Paused', pauseMessage);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_paused')
        .trigger(this, { resume_amps: resumeAmps, message: pauseMessage })
        .catch((err) => this.log('[OCPP] Trigger ocpp_charging_paused failed:', err.message));
    } catch (e) {
      this.log(`[OCPP] Pause failed: ${e.message}`);
      this.stitchedSession = prior || null;
      this.isPaused = !!(prior && prior.paused);
      await this._persistStitched();
      throw e;
    }
  }

  async resumeCharging(source) {
    if (!this.stitchedSession || !this.stitchedSession.paused) {
      if (this._txnId) {
        this.log('[OCPP] Not paused — ignoring resume');
        return;
      }
      throw new Error('No paused charging session to resume.');
    }

    // User manually resuming an engine-paused session → transfer ownership
    if (source !== 'engine' && this.automationEngine
      && (this.sessionOwner === 'solar' || this.sessionOwner === 'offpeak')) {
      this.automationEngine.noteUserStop(this.sessionOwner);
      this.sessionOwner = 'user';
      if (this.stitchedSession) this.stitchedSession.owner = 'user';
    }

    const { resumeAmps, resumePhases } = this.stitchedSession;
    this.stitchedSession.paused   = false;
    this.stitchedSession.resuming = true;
    this.isPaused = false;
    await this._persistStitched();

    this.log(`[OCPP] Masked resume: starting transaction stitched onto paused session (${resumeAmps}A${resumePhases ? `/${resumePhases}P` : ''})`);
    try {
      // Preserve the phase override from the paused session; keep existing owner
      await this.startCharging(this._txnAmps || resumeAmps, resumePhases || undefined, this.sessionOwner);
    } catch (e) {
      this.log(`[OCPP] Resume failed: ${e.message}`);
      this.stitchedSession.paused   = true;
      this.stitchedSession.resuming = false;
      this.isPaused = true;
      await this._persistStitched();
      throw e;
    }
  }

  async _persistStitched() {
    await this.setStoreValue('stitchedSession', this.stitchedSession).catch(() => {});
  }

  async _finalizeStitchedSession(reason) {
    const s = this.stitchedSession;
    if (!s) return;
    this.stitchedSession = null;
    this.isPaused = false;
    await this._persistStitched();

    const reportDurationMs = s.originalStartTime ? (Date.now() - s.originalStartTime) : 0;
    const reportEnergyWh   = s.accumulatedEnergyWh || 0;
    const durationStr      = this._formatDuration(reportDurationMs);
    const energyStr        = this._formatEnergy(reportEnergyWh);
    const message          = `Charging finished · ${energyStr} · ${durationStr}`;

    this.log(`[OCPP] Stitched session finalized (${reason}): ${reportEnergyWh}Wh over ${durationStr}`);
    this.lastStopReason = reason;
    await this.setStoreValue('lastStopReason', reason).catch(() => {});

    if (reportDurationMs >= 5000 && s.originalStartTime) {
      await this._recordSession({ durationMs: reportDurationMs, energyWh: reportEnergyWh, amps: s.resumeAmps || null, phases: this._getPhases(), reason, startTime: s.originalStartTime, owner: s.owner || null });
    }
    if (reportEnergyWh > 0) {
      await this._postNotification('🔌', 'Charging Stopped', message);
    }
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_stopped')
      .trigger(this, {
        energy_delivered_kwh:       parseFloat((reportEnergyWh / 1000).toFixed(3)),
        energy_delivered_wh:        reportEnergyWh,
        energy_delivered_formatted: energyStr,
        duration_minutes:           Math.round(reportDurationMs / 60000),
        duration_formatted:         durationStr,
        reason,
        amps:    s.resumeAmps || 0,
        phases:  this._getPhases(),
        message,
      })
      .catch((err) => this.log('[OCPP] Trigger ocpp_charging_stopped failed:', err.message));
  }

  // ─── Power-verified start announcement ──────────────────────────────────

  async _announceVerifiedStart(v) {
    const amps   = v.activeAmps || this._txnAmps || 0;
    const phases = this._getPhases();

    if (v.isMaskedResume) {
      if (this.stitchedSession) {
        this.stitchedSession.resuming = false;
        await this._persistStitched();
      }
      const ownerEmoji = this.sessionOwner === 'solar' ? '☀️ ' : this.sessionOwner === 'offpeak' ? '🌙 ' : '';
      const message = `${ownerEmoji}Charging resumed · ${this._kwLabel(amps, phases)} (${amps}A) / ${this._phaseLabel(phases)}`;
      await this._postNotification('▶️', 'Charging Resumed', message);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_resumed')
        .trigger(this, { amps, phases, phase_label: this._phaseLabel(phases), message })
        .catch((err) => this.log('[OCPP] Trigger ocpp_charging_resumed failed:', err.message));
      return;
    }

    const ownerEmoji = this.sessionOwner === 'solar' ? '☀️ ' : this.sessionOwner === 'offpeak' ? '🌙 ' : '';
    const message = `${ownerEmoji}Charging started · ${this._kwLabel(amps, phases)} (${amps}A) / ${this._phaseLabel(phases)}`;
    const emoji = this.sessionOwner === 'solar' ? '☀️' : this.sessionOwner === 'offpeak' ? '🌙' : '🔋';
    await this._postNotification(emoji, 'Charging Started', message);
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
      .trigger(this, { amps, phases, phase_label: this._phaseLabel(phases), message,
        transaction_id: this._txnId || 0, meter_start: this._txnMeterStart || 0 })
      .catch((err) => this.log('[OCPP] Trigger ocpp_charging_started failed:', err.message));
  }

  // ─── Release charger ─────────────────────────────────────────────────────

  async releaseCharger() {
    this.log('[OCPP] Releasing charger: ChangeAvailability → Operative');
    try {
      const response = await OcppServer.getInstance(this.homey).changeAvailabilityAsync(this.getSetting('station_id'), 0, 'Operative');
      this.log('[OCPP] ChangeAvailability response:', JSON.stringify(response));
    } catch (e) {
      this.log('[OCPP] Release failed:', e.message);
      throw e;
    }
  }

  // ─── Charge Now ──────────────────────────────────────────────────────────
  // One-tap 16A start — takes over any engine session without suppressing future automation.

  async chargeNow() {
    if (this.chargerOffline) {
      throw new Error('Charger is offline — cannot start charging.');
    }
    const state = this.getCapabilityValue('session_status');
    if (!this._txnId && state === 'not_connected') {
      throw new Error('No car connected — plug in first, then Charge Now.');
    }

    const targetAmps  = 16; // always 16A — "important travel" semantics
    this.log(`[OCPP] Charge Now: ${targetAmps}A`);

    // If an engine session is paused, resume it at 16A
    if (this.stitchedSession && this.stitchedSession.paused) {
      this._txnAmps = targetAmps;
      this.stitchedSession.resumeAmps = targetAmps;
      await this.resumeCharging('user');
      return;
    }
    // If a session is active (engine or otherwise), raise limit to 16A
    if (this._txnId && !this._autoStartBlocked) {
      await this.setChargingLimit(targetAmps, undefined, 'user');
      return;
    }
    // Otherwise start fresh at 16A
    await this.startCharging(targetAmps, undefined, 'user');
  }

  // ─── Resume Automation ────────────────────────────────────────────────────
  // Clears engine suppression from a user-stopped solar/off-peak session.

  async resumeAutomation() {
    if (this.automationEngine) {
      this.automationEngine.clearSuppression('all');
    }
    this.log('[OCPP] Resume automation: engine suppression cleared');
  }

  // ─── Reboot charger ──────────────────────────────────────────────────────
  // A reboot takes 2–3 minutes of silence — suppress the offline watchdog alert.

  async rebootCharger(type = 'Soft') {
    this._expectedOfflineUntil = Date.now() + 300_000;
    this.log(`[OCPP] Sending Reset (${type}) to charger...`);
    const response = await OcppServer.getInstance(this.homey).resetAsync(this.getSetting('station_id'), type);
    this.log(`[OCPP] Reset (${type}) response: ${JSON.stringify(response)}`);
    return response;
  }

  // ─── Set charging limit ───────────────────────────────────────────────────

  async setChargingLimit(amps, overridePhases, source) {
    if (!VALID_AMPS.includes(amps)) {
      throw new Error(`Invalid amps: ${amps}. Must be one of ${VALID_AMPS.join(', ')}.`);
    }

    // User changing limit on an engine session → transfer ownership
    if (source !== 'solar' && source !== 'engine' && this.automationEngine
      && (this.sessionOwner === 'solar' || this.sessionOwner === 'offpeak')) {
      this.automationEngine.noteUserStop(this.sessionOwner);
      this.sessionOwner = 'user';
    }

    // Set phase override first so _getPhases() returns the right value for validate
    if (overridePhases === 1 || overridePhases === 3) {
      this.sessionPhaseOverride = overridePhases;
      this.log(`[OCPP] Phase override set to ${overridePhases} via explicit amps+phase card`);
    }

    // Hardware floor check before any state mutation
    this._validateProfileRequest(amps, this._getPhases());

    const stationId  = this.getSetting('station_id');
    const server     = OcppServer.getInstance(this.homey);
    const prevAmps   = this._txnAmps;
    const prevPhases = this._getPhases();

    // Cancel any pending safety-net TxProfile — an explicit limit always wins
    if (this._pendingTxProfileTimer) {
      clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
      this.log('[OCPP] Cancelled pending safety-net TxProfile — explicit limit takes precedence');
    }

    if (this._txnId && !this._autoStartBlocked) {
      this._txnAmps = amps;
      await this._saveSession();
      const r = await server.setTxProfileAsync(stationId, this._txnId, amps, this._getPhases());
      this.log(`[OCPP] setTxProfile response: ${JSON.stringify(r)}`);
      await this._set('target_current', amps);
      this._updateChargingProfile().catch(() => {});

      const newPhases = this._getPhases();
      if (prevAmps !== null && (prevAmps !== amps || prevPhases !== newPhases)) {
        const message = prevAmps
          ? `Charging limit changed · ${this._kwLabel(prevAmps, prevPhases)} (${prevAmps}A) → ${this._kwLabel(amps, newPhases)} (${amps}A) / ${this._phaseLabel(newPhases)}`
          : `Charging limit changed · ${this._kwLabel(amps, newPhases)} (${amps}A) / ${this._phaseLabel(newPhases)}`;
        await this._postNotification('⚡', 'Charging Limit Changed', message);
        this.homey.flow.getDeviceTriggerCard('ocpp_charging_limit_changed')
          .trigger(this, {
            amps,
            previous_amps: prevAmps || 0,
            phases:        newPhases,
            phase_label:   this._phaseLabel(newPhases),
            message,
          })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charging_limit_changed failed:', err.message));
      }
    } else {
      // No active transaction: remember for next start
      this.pendingStartAmps = amps;
      const r = await server.setMaxCurrentAsync(stationId, amps, this._getPhases());
      this.log(`[OCPP] setMaxCurrent response: ${JSON.stringify(r)}`);
      await this._set('target_current', amps);
      this._updateChargingProfile().catch(() => {});
    }
    this.log(`[OCPP] Charging limit set to ${amps}A`);
  }

  // ─── Offline watchdog ─────────────────────────────────────────────────────

  async _checkChargerOnline() {
    const server   = OcppServer.getInstance(this.homey);
    const lastSeen = server ? server.lastMessageAt : null;
    const silentMs = lastSeen ? (Date.now() - lastSeen) : null;
    const isOffline = !server || silentMs === null || silentMs > OFFLINE_AFTER_MS;

    if (isOffline && !this.chargerOffline) {
      if (silentMs === null && !this._bootGraceStart) this._bootGraceStart = Date.now();
      if (silentMs === null && (Date.now() - this._bootGraceStart) < OFFLINE_AFTER_MS) return;

      this.chargerOffline = true;
      this.log(`[OCPP] Charger OFFLINE: ${silentMs === null ? 'never connected' : Math.round(silentMs / 1000) + 's silent'}`);
      await this.setUnavailable('Charger offline — no OCPP messages received').catch(() => {});
      await this._updateSessionStatus(this.getCapabilityValue('evcharger_charging_state') || 'idle');

      const expected = Date.now() < this._expectedOfflineUntil;
      if (!expected) {
        await this._postNotification('📡', 'Charger Offline', 'Charger offline — connection lost');
        this.homey.flow.getDeviceTriggerCard('ocpp_charger_offline')
          .trigger(this, { message: 'Charger offline — connection lost' })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charger_offline failed:', err.message));
      }
      this._offlineWasAlerted = !expected;
      await this.setStoreValue('chargerWasOffline', true).catch(() => {});
      return;
    }

    if (!isOffline && this.chargerOffline) {
      this.chargerOffline = false;
      this._bootGraceStart = null;
      await this.setStoreValue('chargerWasOffline', false).catch(() => {});
      this.log('[OCPP] Charger back ONLINE');
      await this.setAvailable().catch(() => {});
      await this._updateSessionStatus(this.getCapabilityValue('evcharger_charging_state') || 'idle');

      if (this._offlineWasAlerted) {
        await this._postNotification('📡', 'Charger Online', 'Charger back online');
        this.homey.flow.getDeviceTriggerCard('ocpp_charger_online')
          .trigger(this, { message: 'Charger back online' })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charger_online failed:', err.message));
      }
      this._offlineWasAlerted = false;
    }
  }

  // ─── Idle guard ─────────────────────────────────────────────────────────

  _startIdleGuard() {
    this._clearIdleGuard();
    const autoStart = this.getSetting('auto_start_charging') !== false;
    if (!autoStart) {
      this._idleGuardTimer = this.homey.setInterval(async () => {
        // Skip while a start sequence is in flight, or after a restart
        // while waiting for the charger to reconnect and send StatusNotification.
        if (this._startInFlight || this.assumeActiveFromRestart) return;
        if (!this._txnId) {
          try {
            OcppServer.getInstance(this.homey).setMaxCurrent(this.getSetting('station_id'), BLOCK_AMPS, this._getPhases());
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

  // ─── Session persistence ──────────────────────────────────────────────────

  async _saveSession() {
    await this.setStoreValue('activeSession', {
      txnId:      this._txnId,
      startTime:  this._txnStartTime,
      meterStart: this._txnMeterStart,
      amps:       this._txnAmps,
      phases:     this.sessionPhaseOverride,
      owner:      this.sessionOwner,
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
    this.registerCapabilityListener('onoff', async (value) => {
      if (value) await this.startCharging();
      else await this.stopCharging();
    });

    this.registerCapabilityListener('target_current', async (value) => {
      await this.setChargingLimit(value);
    });

    if (this.hasCapability('release_charger')) {
      this.registerCapabilityListener('release_charger', async () => {
        await this.releaseCharger();
      });
    }

    if (this.hasCapability('pause_charging')) {
      this.registerCapabilityListener('pause_charging', async () => {
        await this.pauseCharging('user');
      });
    }

    if (this.hasCapability('resume_charging')) {
      this.registerCapabilityListener('resume_charging', async () => {
        await this.resumeCharging('user');
      });
    }

    if (this.hasCapability('charge_now')) {
      this.registerCapabilityListener('charge_now', async () => {
        await this.chargeNow();
      });
    }

    if (this.hasCapability('resume_automation')) {
      this.registerCapabilityListener('resume_automation', async () => {
        await this.resumeAutomation();
      });
    }
  }

  // ─── Flow actions ─────────────────────────────────────────────────────────

  _registerFlowActions() {
    this.homey.flow.getActionCard('ocpp_set_max_current')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.setChargingLimit(args.amperes);
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

    this.homey.flow.getActionCard('ocpp_start_charging_at_phase')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.startCharging(args.amperes, parseInt(args.phases));
      });

    this.homey.flow.getActionCard('ocpp_set_charging_limit_at_phase')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.setChargingLimit(args.amperes, parseInt(args.phases));
      });

    this.homey.flow.getActionCard('ocpp_remote_stop')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.stopCharging();
      });

    this.homey.flow.getActionCard('ocpp_pause_charging')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.pauseCharging();
      });

    this.homey.flow.getActionCard('ocpp_resume_charging')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.resumeCharging();
      });

    this.homey.flow.getActionCard('ocpp_release_charger')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.releaseCharger();
      });

    this.homey.flow.getActionCard('ocpp_reboot_charger')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.rebootCharger(args.type || 'Soft');
      });

    this.homey.flow.getActionCard('ocpp_charge_now')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.chargeNow();
      });

    this.homey.flow.getActionCard('ocpp_resume_automation')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this.resumeAutomation();
      });

    for (const key of ['production_w', 'grid_w', 'battery_soc', 'battery_power_w']) {
      this.homey.flow.getActionCard(`ocpp_update_solar_${key}`)
        .registerRunListener(async (args) => {
          if (args.device.id !== this.id) return;
          this.updateSolarInput(key, args.value);
        });
    }
  }

  // ─── Solar input (with batched log debounce) ──────────────────────────────

  updateSolarInput(key, value) {
    if (!this.automationEngine) throw new Error('Solar engine not initialized');
    this.automationEngine.feedInput(key, value);
    // Batch all updates that arrive within 1200ms into one log line
    this._solarInputBatch = this._solarInputBatch || {};
    this._solarInputBatch[key] = value;
    if (this._solarInputLogTimer) this.homey.clearTimeout(this._solarInputLogTimer);
    this._solarInputLogTimer = this.homey.setTimeout(() => {
      const b = this._solarInputBatch || {};
      this._solarInputBatch = {};
      this._solarInputLogTimer = null;
      const parts = [];
      if ('production_w'   in b) parts.push(`production ${b.production_w} W`);
      if ('grid_w'         in b) parts.push(`grid ${b.grid_w > 0 ? '+' : ''}${b.grid_w} W`);
      if ('battery_soc'    in b) parts.push(`battery ${b.battery_soc}%`);
      if ('battery_power_w' in b) parts.push(`battery power ${b.battery_power_w} W`);
      if (parts.length) this.log(`[OCPP] Solar data in: ${parts.join(' · ')}`);
    }, 1200);
  }

  // ─── Capabilities management ─────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          this.log(`[OCPP] Added capability: ${cap}`);
        } catch (err) {
          this.error(`addCapability(${cap}) failed:`, err.message);
        }
      }
    }
  }

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try { await this.setCapabilityValue(capability, value); }
    catch (err) { this.log(`_set(${capability}, ${value}) failed:`, err.message); }
  }

  // ─── Session status capability ────────────────────────────────────────────

  _computeSessionStatus(chargingState, autoStartOverride) {
    if (this.chargerOffline) return 'offline';
    if (chargingState === 'error') return 'error';
    if (this.stitchedSession && this.stitchedSession.paused && chargingState !== 'idle') return 'paused';
    if (chargingState === 'charging') {
      if (this._lowPowerSince && (Date.now() - this._lowPowerSince) >= LOW_POWER_FINISH_MS) return 'finishing';
      if (this.sessionOwner === 'solar') return 'solar_charging';
      if (this.sessionOwner === 'offpeak') return 'offpeak_charging';
      return 'charging';
    }
    if (chargingState === 'idle') return 'not_connected';
    if (chargingState === 'connected') {
      if (this.lastStopReason === 'Local') return 'fully_charged';
      const autoStart = (autoStartOverride !== undefined)
        ? autoStartOverride !== false
        : this.getSetting('auto_start_charging') !== false;
      return autoStart ? 'connected' : 'smart_charging';
    }
    return 'not_connected';
  }

  async _updateSessionStatus(chargingState, autoStartOverride) {
    const status = this._computeSessionStatus(chargingState, autoStartOverride);
    await this._set('session_status', status);
    await this._set('status_summary', this._composeStatusSummary(status));
  }

  _composeStatusSummary(status) {
    const session = this.getCurrentSessionInfo();
    switch (status) {
      case 'solar_charging': {
        const powerW = this.getCapabilityValue('measure_power') || 0;
        return `☀️ ${(powerW / 1000).toFixed(1)} kW`;
      }
      case 'offpeak_charging': {
        const powerW = this.getCapabilityValue('measure_power') || 0;
        return `🌙 ${(powerW / 1000).toFixed(1)} kW`;
      }
      case 'charging': {
        const powerW = this.getCapabilityValue('measure_power') || 0;
        return `Charging · ${(powerW / 1000).toFixed(1)} kW`;
      }
      case 'finishing':
        return session ? `Finishing · ${this._formatEnergy(session.energyWh)}` : 'Finishing';
      case 'paused':
        return session ? `Paused · ${this._formatEnergy(session.energyWh)}` : 'Paused';
      case 'fully_charged':  return 'Fully Charged';
      case 'smart_charging': return 'Ready to start';
      case 'connected':      return 'Connected';
      case 'not_connected':  return 'Idle';
      case 'offline':        return 'Offline';
      case 'error':          return 'Error';
      default: return status;
    }
  }

  // ─── Charging profile capability ─────────────────────────────────────────

  async _updateChargingProfile() {
    const amps   = this._txnAmps || this.pendingStartAmps || parseInt(this.getSetting('default_charging_amps')) || 16;
    const phases = this._getPhases();
    const kw     = (Math.floor(amps * phases * 230 / 100) / 10).toFixed(1);
    await this._set('charging_profile', `${kw} kW / ${amps}A / ${phases}P`);
    await this._set('target_current', amps);
  }

  // ─── Phase count ──────────────────────────────────────────────────────────

  _getPhases() {
    if (this.sessionPhaseOverride === 1 || this.sessionPhaseOverride === 3) return this.sessionPhaseOverride;
    const phases = parseInt(this.getSetting('number_of_phases'), 10);
    return (phases === 1 || phases === 3) ? phases : 3;
  }

  _devicePhases() {
    const phases = parseInt(this.getSetting('number_of_phases'), 10);
    return (phases === 1 || phases === 3) ? phases : 3;
  }

  // ─── Hardware floor validation ────────────────────────────────────────────
  // Huawei's OCPP firmware ignores numberPhases — it always spreads the watt
  // limit across all physical phases. A 6A request on a 3-phase unit results
  // in ~2A/phase (under the IEC 61851 6A floor), causing an instant abort.

  _validateProfileRequest(amps, requestedPhases) {
    const devicePhases = this._devicePhases();
    if (requestedPhases > devicePhases) {
      throw new Error(`This charger is configured as ${this._phaseLabel(devicePhases)} — a ${this._phaseLabel(requestedPhases)} profile can't be delivered on it.`);
    }
    const model = this.getSetting('charger_model') || 'other';
    const watts = AMPS_TO_WATTS(amps, requestedPhases);
    if (model === '7ks' || model === '22kt') {
      // Huawei firmware ignores numberPhases and spreads watts across all physical phases.
      // A 6A mono request on a 3-phase unit = 2A/phase → instant abort (IEC 61851 floor).
      const perPhaseAmps = watts / (devicePhases * 230);
      if (perPhaseAmps < 6) {
        const minKw = (Math.floor(1380 * devicePhases / 100) / 10).toFixed(1);
        throw new Error(`Below this charger's minimum: Huawei chargers ignore the phase choice, so the ${watts}W requested spreads across all ${devicePhases} phases (~${Math.round(perPhaseAmps * 10) / 10}A each, under the 6A hardware floor). Lowest deliverable is 6A ${this._phaseLabel(devicePhases)} = ${minKw} kW.`);
      }
    } else {
      // Other vendors may honour numberPhases — validate per requested phase.
      if (amps < 6) {
        throw new Error(`Below the 6A minimum charging current (IEC hardware floor) — ${amps}A ${this._phaseLabel(requestedPhases)} can't be delivered.`);
      }
    }
  }

  // ─── Label helpers ────────────────────────────────────────────────────────

  _kwLabel(amps, phases) {
    // Truncated to one decimal (EV convention: 16A mono = 3680W = "3.6 kW", not "3.7")
    return `${(Math.floor(AMPS_TO_WATTS(amps, phases) / 100) / 10).toFixed(1)} kW`;
  }

  _phaseLabel(phases) {
    return phases === 1 ? 'Mono-Phase' : 'Tri-Phase';
  }

  // ─── Timeline notifications ───────────────────────────────────────────────

  async _postNotification(emoji, title, text) {
    if (this.getSetting('enable_timeline_notifications') === false) {
      this.log(`[OCPP] Timeline notification skipped (disabled): ${emoji} ${title}`);
      return;
    }
    try {
      this.log(`[OCPP] Timeline: ${emoji} ${title} — ${text}`);
      await this.homey.notifications.createNotification({ excerpt: `${emoji} ${text}` });
    } catch (err) {
      this.log(`[OCPP] Notification failed: ${err.message}`);
      try {
        if (this.homey.timeline && this.homey.timeline.createPost) {
          await this.homey.timeline.createPost({ text: `${emoji} ${text}` });
          this.log(`[OCPP] Timeline posted (fallback): ${title}`);
        }
      } catch (err2) {
        this.log(`[OCPP] Timeline fallback also failed: ${err2.message}`);
      }
    }
  }

  // ─── Format helpers ───────────────────────────────────────────────────────

  _formatEnergy(wh) {
    if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
    return `${Math.round(wh)} Wh`;
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours   = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  // ─── Debug helpers ────────────────────────────────────────────────────────

  _trackLastNonZero(key, value) {
    if (!value || value <= 0) return;
    if (!this._lastNonZero) this._lastNonZero = {};
    this._lastNonZero[key] = { value, at: new Date().toISOString() };
    this.setStoreValue('lastNonZero', this._lastNonZero).catch((err) => {
      this.log(`[OCPP] Failed to persist lastNonZero: ${err.message}`);
    });
  }

  getDebugSummary() {
    const cap = (id) => {
      try { return this.getCapabilityValue(id); } catch (e) { return null; }
    };
    return {
      name:                this.getName(),
      chargingState:       cap('evcharger_charging_state'),
      sessionStatus:       cap('session_status'),
      onoff:               cap('onoff'),
      txnId:               this._txnId,
      autoStartEnabled:    this.getSetting('auto_start_charging') !== false,
      isPaused:            this.isPaused,
      chargerVendor:       this.getSetting('charger_vendor') || 'Huawei',
      chargerModel:        this.getSetting('charger_model') || 'other',
      numberOfPhases:      this._getPhases(),
      physicalPhases:      this._devicePhases(),
      phaseOverrideActive: this.sessionPhaseOverride !== null,
      pendingStartAmps:    this.pendingStartAmps,
      current: {
        power:        cap('measure_power'),
        meterPower:   cap('meter_power'),
        currentTotal: cap('measure_current'),
        currentL1:    cap('measure_current.l1'),
        currentL2:    cap('measure_current.l2'),
        currentL3:    cap('measure_current.l3'),
        voltageAvg:   cap('measure_voltage'),
        voltageL1:    cap('measure_voltage.l1'),
        voltageL2:    cap('measure_voltage.l2'),
        voltageL3:    cap('measure_voltage.l3'),
        temperature:  cap('measure_temperature'),
      },
      lastNonZero: this._lastNonZero || {},
    };
  }

  // ─── Widget API ───────────────────────────────────────────────────────────

  getWidgetStatus() {
    const sessionStatus = this.getCapabilityValue('session_status') || 'not_connected';
    const session       = this.getCurrentSessionInfo();
    const amps          = this._txnAmps
      || (this.stitchedSession ? this.stitchedSession.resumeAmps : null)
      || null;
    const phases = this._getPhases();

    // Phase-current averaging: filter noise (<0.5 A) and average only active phases
    const phaseCurrents = [
      this.getCapabilityValue('measure_current.l1'),
      this.getCapabilityValue('measure_current.l2'),
      this.getCapabilityValue('measure_current.l3'),
    ].filter((v) => typeof v === 'number' && v > 0.5);
    const currentA = phaseCurrents.length > 0
      ? phaseCurrents.reduce((a, b) => a + b, 0) / phaseCurrents.length
      : (this.getCapabilityValue('measure_current') || 0);

    return {
      sessionStatus,
      sessionOwner:     this.sessionOwner || null,
      isPaused:         this.isPaused === true,
      requestedAmps:    amps,
      limitKw:          amps ? this._kwLabel(amps, phases) : null,
      phases,
      phaseLabel:       this._phaseLabel(phases),
      powerW:           this.getCapabilityValue('measure_power') || 0,
      currentA,
      sessionStartTime: session ? session.startTime : null,
      sessionEnergyWh:  session ? session.energyWh : null,
    };
  }

  async getSessionHistory() {
    try {
      const raw = (await this.getStoreValue('sessionHistory')) || [];
      return raw.map(s => ({
        ...s,
        startTime: s.stopTime != null && s.durationMs != null ? s.stopTime - s.durationMs : null,
      })).reverse();
    } catch (e) {
      return [];
    }
  }

  // ─── Session tile sensors ──────────────────────────────────────────────────
  // meter_session_energy (kWh) + session_duration ("2h 13m") mirror the same
  // stitched-session numbers as the history widget — one source of truth
  // (getCurrentSessionInfo), so restarts and masked pauses are already handled.
  // Refreshed every 60s while a session exists; reset on unplug.

  async _updateSessionTileSensors() {
    const info = this.getCurrentSessionInfo();
    if (!info) return; // between sessions: hold last values (reset happens on unplug)
    const kwh = Math.round((info.energyWh || 0) / 10) / 100;
    await this._set('meter_session_energy', kwh);
    await this._set('session_duration', this._formatDuration(info.durationMs || 0));
  }

  async _resetSessionTileSensors() {
    await this._set('meter_session_energy', 0);
    await this._set('session_duration', '—');
  }

  getCurrentSessionInfo() {
    const s         = this.stitchedSession;
    const startTime = s ? s.originalStartTime : this._txnStartTime;
    if (!startTime) return null;

    let energyWh;
    if (s) {
      const accumulated = s.accumulatedEnergyWh || 0;
      // When paused there is no active transaction; only accumulated segments count.
      // When resumed and running, add the live segment on top.
      if (!s.paused && this._txnId && this._txnMeterStart) {
        const meterNow = (this.getCapabilityValue('meter_power') || 0) * 1000;
        energyWh = accumulated + Math.max(0, meterNow - this._txnMeterStart);
      } else {
        energyWh = accumulated;
      }
    } else {
      const meterNow = (this.getCapabilityValue('meter_power') || 0) * 1000;
      energyWh = Math.max(0, meterNow - this._txnMeterStart);
    }

    return {
      startTime,
      paused:     !!(s && s.paused),
      durationMs: Date.now() - startTime,
      energyWh:   Math.round(energyWh),
      amps:       this._txnAmps || (s ? s.resumeAmps : null),
      phases:     this._getPhases(),
    };
  }
}

module.exports = SmartChargerOcppDevice;
