'use strict';

// Easee charger over its own OCPP 1.6J ("Direct OCPP (Home)", beta, firmware 344 or later).
//
// A copy of drivers/smartcharger_ocpp/device.js, adapted where an Easee differs from the
// Huawei SCharger that driver was built for (Andi, 2026-10-15: copy the driver, then adapt).
// Both register with the same OcppServer — one per port — and share the flow cards, whose
// listeners act on args.device. What is different here, from Easee's developer docs:
//   - Limits go out in amperes (ocppChargingRateUnit): "Watt-based schedules not supported".
//     0 A is sent as 0 A — the 1 W in the other driver works around Huawei firmware.
//   - What the charger is told to sample (ocppConfiguration): no SoC, which an Easee does not
//     know, since OCPP 1.6 has a charger refuse the whole list for one unknown measurand.
//     MeterValueSampleInterval is 0 on an Easee until set, which means no readings at all.
//     HeartbeatInterval is 86400 s: an idle charger would go "offline" after three minutes.
//   - No vehicle SoC tile: an AC charger cannot know the car's state of charge.
//   - No Huawei model setting and no Huawei phase spreading: the 6 A floor is checked for
//     the phases requested.
// And from evcc's OCPP charger (1.3.5, compared on Andi's request 2026-10-16):
//   A. A pause holds the transaction at 0 A instead of ending it with RemoteStop, which on an
//      Easee also switches free charging off; a resume raises the limit again.
//   B. Only the wired phase count: evcc offers no phase switching for an Easee, and a charger
//      that ignores the count charges three phases at the current meant for one.
//   C. Current.Offered — what the charger really offers the car — on a tile of its own, and in
//      the log when it does not follow the limit (current control may need newer firmware).
//   D. The total power, or the phases summed when only those arrive.
//   E. After configuring: Operative, and status and readings asked for at once.
// And from Andi's log of 2026-10-16 00:16 (1.3.6):
//   - Every limit goes out as the default profile (ocppTxDefaultOnly), as evcc does.
//   - A transaction the charger no longer has — it reports Preparing, Finishing or Available —
//     is closed after STALE_TXN_GRACE_MS, not only one beside Available.
//   - A limit the charger refuses is an error, not "Charging limit set".
//   - Each MeterValues message is logged in one line, measurand by measurand.
// And from the next one, 00:24–00:26 (1.3.7): the transaction started, the profile was
// accepted, and the Easee went SuspendedEVSE offering 0 A of the 16 A set. A charger that
// offers less is now named on the tile too, and asked for its own schedule
// (GetCompositeSchedule): 16 A there means the limit comes from outside OCPP — the Easee app or
// cloud, a schedule, the circuit — 0 A means from OCPP.
//
// The charger is pointed at Homey through Easee's commissioning API (connection details with
// url ws://[Homey-IP]:[port], then apply). Without a chargePointId it connects as its serial
// number, which is the Station ID to enter here.

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const OcppServer = require('../../lib/ocpp-server');

const MIN_AMPS            = 6;
const MAX_AMPS            = 32;
const AMPS_TO_WATTS       = (amps, phases = 3) => Math.round(amps * phases * 230);
const BLOCK_AMPS          = 0; // sent as 0 A — an Easee takes amperes (ocppChargingRateUnit)
// How long the "Instant Charging" switch shows "on" after a tap — see _resetChargeNowSwitch.
const CHARGE_NOW_RESET_MS = 1500;
// How long a resume counts as on its way before its StartTransaction — see startCharging.
const RESUME_IN_FLIGHT_MS = 60_000;
// How long after sending the starting current a second attempt is treated as the same one.
// The restart timer and the connect handler can both fire on a restart with the charger
// still attached; wide enough to cover the gap between them, short enough that a charger
// reconnecting minutes later is served again.
const INIT_PROFILE_DEDUP_MS = 10_000;
const IDLE_GUARD_MS       = 300_000;
const QUICK_ABORT_MS      = 2000;
// How long a transaction may stand beside "Available" before it is closed here. A charger
// unplugged while offline delivers its queued StopTransaction when it is back, usually
// within seconds; one that rebooted may never send it at all.
const STALE_TXN_GRACE_MS  = 30_000;
// The connector states with no transaction on them (OCPP 1.6): a transaction still held beside
// one of them has ended — see _watchStaleTransaction.
const NO_TRANSACTION_STATUSES = new Set(['Available', 'Preparing', 'Finishing']);
const MAX_SESSION_HIST    = 10;
const OFFLINE_AFTER_MS    = 180_000;
const LOW_POWER_W         = 100;
const LOW_POWER_FINISH_MS = 180_000;
// A start that never drew power and delivered less than this ends without "charging stopped" —
// see onStopTransaction.
const FALSE_START_WH      = 10;
// How often the debug record of the last non-zero readings is written — see _trackLastNonZero.
const LAST_NON_ZERO_SAVE_MS = 5 * 60_000;

// This app's own vocabulary for what the charger is doing. It drives _computeSessionStatus
// and the session_status capability, which is ours and accepts these words.
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

// Homey's vocabulary, which is a different thing entirely. evcharger_charging_state is a
// built-in enum accepting exactly these five words; anything else is rejected outright.
//
// Field-caught 2026-09-03, in a log that showed the app writing 'idle':
//   _set(evcharger_charging_state, idle) failed: Invalid enum capability value: idle.
//   Expected: plugged_in_charging,plugged_in_discharging,plugged_in_paused,plugged_in,plugged_out
//
// Every word in the map above is in the same position - none of idle, connected, charging
// or error is a member of that enum - so the capability was never once written
// successfully, on any installation, since it was added. It read as "-" for ever, and the
// places comparing against it read null and fell through to their idle branch.
const HOMEY_EV_STATE = {
  idle:      'plugged_out',
  connected: 'plugged_in',
  charging:  'plugged_in_charging',
  // No member of the enum means "faulted". Writing plugged_out would state that the cable
  // is out, which is not something a lost connection tells us. The fault is reported by
  // session_status and by setUnavailable, both of which say it plainly.
  error:     null,
};

// Reading back the other way, so the state survives a restart. Deliberately lossy:
// plugged_in_paused comes back as 'connected', because this app has no paused state of its
// own - pausing is tracked on the session, not here.
const INTERNAL_FROM_HOMEY = {
  plugged_out:            'idle',
  plugged_in:             'connected',
  plugged_in_paused:      'connected',
  plugged_in_charging:    'charging',
  plugged_in_discharging: 'charging',
};

// Where OCPP is more specific than this app's own vocabulary, say so to Homey. Both
// Suspended states mean the cable is in and nothing is flowing, which is exactly what
// plugged_in_paused is for; internally they stay 'connected'.
const OCPP_HOMEY_STATE = {
  'SuspendedEVSE': 'plugged_in_paused',
  'SuspendedEV':   'plugged_in_paused',
  // The transaction is over, the cable still in. Internally Finishing stays 'idle', but Homey
  // was told plugged_out: on a Huawei every stop and every masked pause passes through it
  // (Charging → Finishing → Preparing), and an EMS tick landing in that moment read the car as
  // unplugged — it closed the charge session, split it in two, cleared the "car is at its
  // target" latch and the back-off for a car that ignores its starts, and could switch instant
  // charging off (review 2026-10-10). A charger that stays in Finishing until the cable is pulled
  // would never have had its paused car resumed.
  'Finishing':     'plugged_in',
};

// Capabilities the user can turn off. None on an Easee: the other driver's one is the car's
// state of charge, which an Easee does not report (it is not among its measurands), so this
// driver has neither the tile nor the switch.
const OPTIONAL_CAPABILITIES = {};

const REQUIRED_CAPABILITIES = [
  'evcharger_charging',
  'target_power',
  'target_power_mode',
  'target_current',
  'measure_power',
  'meter_power',
  'evcharger_charging_state',
  'ocpp_server_status',
  'ocpp_last_message',
  'measure_current',
  'measure_current.offered',
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
  'meter_session_energy',
  'session_duration',
];

// Old capabilities to remove during migration.
// resume_automation: the built-in solar/off-peak engine moved to the EMS device —
// this driver is now a pure charger interface.
const REMOVE_CAPABILITIES = [
  'button.pause_charging',
  'button.resume_charging',
  'button.release_charger',
  'resume_automation',
  // Migrated to the standard EV capability `evcharger_charging` (Homey v12.4.5+),
  // which auto-generates the native "Start charging" / "Is charging" flow cards.
  'onoff',
];

class EaseeOcppDevice extends Device {

  // Read by OcppServer: the unit of every charging profile sent to this charger.
  get ocppChargingRateUnit() { return 'A'; }

  // Read by OcppServer: every limit as the default profile, the running transaction included —
  // never a TxProfile that names a transaction (1.3.6, see the header).
  get ocppTxDefaultOnly() { return true; }

  // Read by OcppServer: the stack level of the default profile. evcc puts it on the charger's
  // highest (ChargeProfileMaxStackLevel, 10 on an Easee), so no profile already on the charger
  // outranks it.
  get ocppDefaultStackLevel() { return 10; }

  // Read by OcppServer when the charger connects or boots — what it is told, in this order. A
  // list is offered value by value until the charger takes one, and read back if it takes none.
  //   - Measurands: all of Easee's list that this device shows, then evcc's three for an Easee.
  //   - Sample interval: 30 s. Andi's Easee refused 10 s (2026-10-15); evcc's Easee template
  //     documents 30 s as the minimum and uses it.
  //   - Heartbeat: 60 s instead of a day, so an idle charger is not taken for offline.
  ocppConfiguration() {
    return [
      ['MeterValuesSampledData', [
        'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Current.Offered,Voltage,Temperature',
        'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Current.Offered',
        'Energy.Active.Import.Register,Power.Active.Import,Current.Import',
      ]],
      ['MeterValueSampleInterval', ['30', '60']],
      ['HeartbeatInterval', ['60']],
    ];
  }

  // Read by OcppServer after the keys above (E, 1.3.5): operative — a charger left unavailable
  // takes no car — and its status and readings now, not at their next change. evcc does both on
  // setup. After an app restart the charger has not booted and says nothing new until something
  // changes, so the device showed what it knew before the restart.
  ocppAfterConfiguration() {
    return [
      ['ChangeAvailability', { connectorId: 0, type: 'Operative' }],
      ['TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 1 }],
      ['TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 }],
    ];
  }

  async onInit() {
    this.log(`[Easee] Device initializing: ${this.getName()}`);

    // ── Migrate old button.* capabilities to custom capabilities ────────────
    for (const cap of REMOVE_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try {
          await this.removeCapability(cap);
          this.log(`[Easee] Removed old capability: ${cap}`);
        } catch (e) { this.log(`[Easee] Remove ${cap} failed: ${e.message}`); }
      }
    }
    await this._ensureCapabilities();

    // Effective controller is always Homey (the charger has no self-scheduling of
    // its own — automation lives in the EMS device), so seed the mode once.
    if (this.hasCapability('target_power_mode') && this.getCapabilityValue('target_power_mode') == null) {
      await this._set('target_power_mode', 'homey');
    }

    // ── One-time setting migrations ─────────────────────────────────────────
    try {
      const v = this.getSetting('charger_vendor');
      if (!v || v === 'Unknown (not yet connected)' || v === 'Unknown') {
        await this.setSettings({ charger_vendor: 'Easee' });
        this.log('[Easee] Corrected stale charger_vendor setting to "Easee"');
      }
    } catch (e) { this.log(`[Easee] charger_vendor migration error: ${e.message}`); }

    // Dropdown value-type migration: Homey shows "–" for a dropdown on the
    // device settings list when the stored value's type doesn't match the
    // option ids (which are strings). Devices configured under older versions
    // may have numbers stored — convert once.
    try {
      const DROPDOWN_DEFAULTS = {
        number_of_phases: '3',
        default_charging_amps: '16',
      };
      const fixes = {};
      for (const [key, def] of Object.entries(DROPDOWN_DEFAULTS)) {
        const v = this.getSetting(key);
        if (typeof v === 'number') fixes[key] = String(v);
        else if (v === null || v === undefined || v === '') fixes[key] = def;
      }
      if (Object.keys(fixes).length) {
        await this.setSettings(fixes);
        this.log(`[Easee] Migrated dropdown settings: ${JSON.stringify(fixes)}`);
      }
    } catch (e) { this.log(`[Easee] Dropdown migration skipped: ${e.message}`); }

    // ── Core session state ──────────────────────────────────────────────────
    this._txnId                = null;
    this._txnStartTime         = null;
    this._txnMeterStart        = 0;
    this._txnAmps              = null;
    this._autoStartBlocked     = false;
    this._initialProfileAt     = null;  // when the starting current was last sent
    this._manualStartRequested = false;
    this._quickAbortCount      = 0;
    this.sessionPhaseOverride  = null;
    this.pendingStartAmps      = null;
    this.idTag                 = 'homey';
    this._startInFlight        = false;
    this.assumeActiveFromRestart = false;
    this._lastNonZero          = null;
    this._lastNonZeroSavedAt   = 0;

    // ── Session ownership (tracks who started the current session) ──────────
    this.sessionOwner = null; // 'user' | null ('solar'/'offpeak' were pre-EMS engine owners, may still appear in old stored sessions)

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
    this._carDoneAt        = null;  // when the car was done, in this transaction — see onStopTransaction

    // ── Masked pause / resume ───────────────────────────────────────────────
    this.stitchedSession = null;
    this.isPaused        = false;

    // ── Stop-reason / Fully-Charged heuristic ──────────────────────────────
    this.lastStopReason = null;
    this.lastStopFull   = false;

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
        this.log(`[Easee] Restored session: txnId=${sess.txnId}, amps=${sess.amps}, owner=${sess.owner}`);
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
        this.log(`[Easee] Restored stitched session: started ${new Date(stitched.originalStartTime).toISOString()}, accum=${stitched.accumulatedEnergyWh || 0}Wh, paused=${this.isPaused}, owner=${stitched.owner}`);
      }
    } catch (e) { /* ignore */ }

    try {
      const sr = await this.getStoreValue('lastStopReason');
      if (sr) this.lastStopReason = sr;
      this.lastStopFull = (await this.getStoreValue('lastStopFull')) === true;
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
        this.log('[Easee] Restored offline state after restart — waiting for charger (quietly)');
      }
    } catch (e) { /* ignore */ }

    // After restart, if the device was charging, suppress the idle guard
    // until the charger reconnects and sends a StatusNotification.
    const wasCharging = this._chargingState() === 'charging';
    this.assumeActiveFromRestart = wasCharging;

    // Charging automation lives in the Energy Management System device —
    // this driver is a pure charger interface (control + telemetry only).

    // Session tile sensors: 60s refresh so the tile shows live numbers
    // during a session; one immediate pass to show restored session on boot.
    this._sessionTileInterval = this.homey.setInterval(() => {
      this._updateSessionTileSensors().catch(() => {});
    }, 60_000);
    this._updateSessionTileSensors().catch(() => {});

    // ── Register with OcppServer ────────────────────────────────────────────
    // The server of this device's port: one per port since 1.2.323.
    const stationId = this.getSetting('station_id');
    this._ocppPort  = parseInt(this.getSetting('ocpp_port'), 10) || 8887;
    const server    = this._ocppServer();
    if (server.registerDevice(stationId, this)) {
      server.setCredentials(stationId, this.getSetting('ocpp_username'), this.getSetting('ocpp_password'));
    }

    await this._set('ocpp_server_status', 'starting');
    await this._applyTargetPowerRange();
    // A switch left on by an earlier version (see the charge_now listener) would make the next
    // tap a switch-off, which now does nothing — so it starts from off.
    if (this.hasCapability('charge_now') && this.getCapabilityValue('charge_now') === true) {
      await this.setCapabilityValue('charge_now', false).catch(() => {});
    }
    this._registerCapabilityListeners();
    this._registerFlowActions();
    this._registerFlowConditions();
    this._startIdleGuard();

    // Offline watchdog — fires every 30 s
    this._offlineWatchdog = this.homey.setInterval(() => {
      this._checkChargerOnline().catch((err) => this.log(`[Easee] Watchdog error: ${err.message}`));
    }, 30_000);

    // Three seconds after init, for the charger that was already connected when the app
    // restarted. A charger that turns up later is served by onOcppConnected instead — see
    // _applyInitialProfile for why one timer alone was not enough.
    this.homey.setTimeout(() => {
      this._applyInitialProfile('app restart').catch(() => {});
    }, 3000);

    this._updateChargingProfile().catch(() => {});
    this.log('[Easee] Device initialized');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // newSettings: getSetting() still holds the old Station ID until this method resolves.
    const stationId = newSettings.station_id ?? this.getSetting('station_id') ?? '';
    const oldId     = (oldSettings && oldSettings.station_id) ?? this.getSetting('station_id') ?? '';
    const ocppPort  = parseInt(newSettings.ocpp_port, 10) || 8887;
    const oldPort   = this._ocppPort ?? (parseInt(this.getSetting('ocpp_port'), 10) || 8887);
    const moving    = ocppPort !== oldPort || changedKeys.includes('station_id');

    // A Station ID another device holds on that port is refused here, with its name, rather
    // than taken from it — see OcppServer.registerDevice. Asked of the server without starting
    // one: a port nobody uses yet has nobody to collide with.
    if (moving) {
      const there  = OcppServer.existing(ocppPort);
      const holder = there && there.holderOf(stationId, this);
      if (holder) throw new Error(this._stationIdTakenText(stationId, holder.getName(), ocppPort));
    }

    // newSettings, not getSetting(): Homey persists only after this method resolves, so
    // reading the stored value here would still give the old one and the tile would appear
    // or disappear one save too late.
    if (changedKeys.some((k) => Object.values(OPTIONAL_CAPABILITIES).includes(k))) {
      await this._applyOptionalCapabilities(newSettings);
    }

    const amps      = parseInt(newSettings.default_charging_amps, 10) || 16;
    const autoStart = newSettings.auto_start_charging !== false;

    // After the checks that can refuse the page, so a refused save moves nothing.
    //
    // A new port is a different server. Until 1.2.323 there was only one, and saving any
    // setting of any device restarted it on that device's port — with two chargers on two
    // ports, whichever device was saved last cut the other charger off (review 2026-10-10).
    // The device now leaves the server of its old port, which stops when nobody is left on
    // it, and joins the one of its new port.
    let server;
    if (ocppPort !== oldPort) {
      const left = OcppServer.existing(oldPort);
      if (left) left.unregisterDevice(oldId, this);
      this._ocppPort = ocppPort;
      server = this._ocppServer();
      server.registerDevice(stationId, this);
    } else {
      server = this._ocppServer();
      if (changedKeys.includes('station_id')) server.renameDevice(oldId, stationId, this);
    }
    server.setCredentials(stationId, newSettings.ocpp_username, newSettings.ocpp_password);

    if (changedKeys.includes('auto_start_charging')) {
      this._startIdleGuard();
      const currentState = this._chargingState();
      this._updateSessionStatus(currentState, autoStart).catch(() => {});

      if (!autoStart) {
        if (!this._txnId) {
          try {
            const r = await server.setMaxCurrentAsync(stationId, BLOCK_AMPS, this._getPhases());
            this.log('[Easee] Block TxDefault response:', JSON.stringify(r));
          } catch (e) { this.log('[Easee] Block TxDefault failed:', e.message); }
        } else {
          this._autoStartBlocked = true;
          try {
            const r = await server.setTxProfileAsync(stationId, this._txnId, BLOCK_AMPS, this._getPhases());
            this.log('[Easee] Block TxProfile response:', JSON.stringify(r));
          } catch (e) { this.log('[Easee] Block TxProfile failed:', e.message); }
        }
      } else {
        if (!this._txnId) {
          try {
            const r = await server.setMaxCurrentAsync(stationId, amps, this._getPhases());
            this.log('[Easee] Restore TxDefault response:', JSON.stringify(r));
          } catch (e) { this.log('[Easee] Restore TxDefault failed:', e.message); }
        }
      }
    }

    if (changedKeys.includes('default_charging_amps')) {
      if (!this._txnId) {
        const targetAmps = autoStart ? amps : BLOCK_AMPS;
        try {
          const r = await server.setMaxCurrentAsync(stationId, targetAmps, this._getPhases());
          this.log('[Easee] Updated TxDefault response:', JSON.stringify(r));
        } catch (e) { this.log('[Easee] Updated TxDefault failed:', e.message); }
      } else {
        // A default is for the next session. Saving it used to set the running one to it too,
        // over whatever the EMS, a flow or the slider had set — and the EMS, which sends again
        // only when its own target moves, went on believing its figure (review 2026-10-10). The
        // stop restores the resting limit from this setting.
        this.log(`[Easee] Default current now ${amps}A — the running session keeps its limit, the new default applies from the next start`);
      }
      if (!autoStart) this._startIdleGuard();
    }

    if (changedKeys.includes('number_of_phases')) {
      this._updateChargingProfile().catch(() => {});
      // newSettings, not the stored value: Homey persists after this resolves.
      this._applyTargetPowerRange(parseInt(newSettings.number_of_phases, 10)).catch(() => {});
    }
  }

  // Homey's target_power slider speaks watts, and which watt values mean anything depends
  // on how many phases are wired. The pilot signal (IEC 61851) cannot express less than
  // 6 A, and a three-phase charger delivers at least 6 A on each of the three — about
  // 4140 W, not 1380 W.
  //
  // The options were fixed at the single-phase figures: a dead zone up to 1380 W and a
  // 230 W step. On a three-phase charger Homey would therefore offer 2000 W as a valid
  // request, and the driver would raise it to its 6 A minimum without saying so — asking
  // for less than half of what actually flowed. Homey's own documentation scales both with
  // the phase count, and this does the same.
  //
  // Existing options are read and spread rather than replaced, so the titles declared in
  // app.json survive whatever the merge semantics turn out to be.
  async _applyTargetPowerRange(phaseOverride) {
    if (!this.hasCapability('target_power')) return;
    const phases = (phaseOverride === 1 || phaseOverride === 3) ? phaseOverride : this._devicePhases();
    const step   = phases * 230;
    try {
      const current = this.getCapabilityOptions('target_power') || {};
      const range = {
        min:        0,               // this charger does not discharge
        max:        MAX_AMPS * step,
        step,
        excludeMin: 0,
        excludeMax: MIN_AMPS * step, // below this the charger cannot deliver at all
      };
      // Homey calls setCapabilityOptions expensive and asks for it sparingly; this runs on
      // every start, and the range changes only with the phase setting.
      if (Object.keys(range).every((k) => current[k] === range[k])) return;
      await this.setCapabilityOptions('target_power', { ...current, ...range });
      this.log(`[Easee] target_power range: 0–${MAX_AMPS * step} W, step ${step} W, `
        + `nothing below ${MIN_AMPS * step} W (${phases}-phase)`);
    } catch (err) {
      this.error('setCapabilityOptions(target_power) failed:', err.message);
    }
  }

  async onDeleted() {
    this._clearTimers();
    this._leaveOcppServer();
    this.log('[Easee] Device deleted');
  }

  async onUninit() {
    this._clearTimers();
    this._leaveOcppServer();
    // The readings since the last write — see _trackLastNonZero.
    if (this._lastNonZero) await this.setStoreValue('lastNonZero', this._lastNonZero).catch(() => {});
  }

  // Without starting a server to leave: both of the two above may run for one device.
  _leaveOcppServer() {
    const server = OcppServer.existing(this._ocppPort ?? this.getSetting('ocpp_port'));
    if (server) server.unregisterDevice(this.getSetting('station_id'), this);
  }

  /** The server this device is registered with — the one of its port. */
  _ocppServer() {
    return OcppServer.getInstance(this.homey, this._ocppPort ?? (parseInt(this.getSetting('ocpp_port'), 10) || 8887));
  }

  _stationIdTakenText(stationId, holderName, port) {
    return stationId
      ? this.homey.__('errors.ocppStationIdTaken', { id: stationId, name: holderName, port })
      : this.homey.__('errors.ocppAnyStationTaken', { name: holderName, port });
  }

  // From the server, when the Station ID is held by another device on this port. The device
  // says so instead of waiting in silence — and the offline watchdog leaves that message alone.
  onRegistrationRefused(stationId, holderName, port) {
    this._stationIdTaken = true;
    const text = this._stationIdTakenText(stationId, holderName, port);
    this.log(`[Easee] Not registered: ${text}`);
    this.setUnavailable(text).catch(() => {});
  }

  // From the server, when the device holds its Station ID — at once, or once the device that
  // held it is gone or moved.
  onRegistered() {
    if (!this._stationIdTaken) return;
    this._stationIdTaken = false;
    this.log('[Easee] Station ID free — registered');
    this.setAvailable().catch(() => {});
  }

  _clearTimers() {
    this._clearIdleGuard();
    if (this._sessionTileInterval) {
      this.homey.clearInterval(this._sessionTileInterval);
      this._sessionTileInterval = null;
    }
    if (this._offlineWatchdog) {
      this.homey.clearInterval(this._offlineWatchdog);
      this._offlineWatchdog = null;
    }
    if (this._chargeNowReset) {
      this.homey.clearTimeout(this._chargeNowReset);
      this._chargeNowReset = null;
    }
    if (this._pendingTxProfileTimer) {
      this.homey.clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
    }
    if (this._pendingStartNotificationTimeout) {
      this.homey.clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = null;
    }
    if (this._staleTxnTimer) {
      this.homey.clearTimeout(this._staleTxnTimer);
      this._staleTxnTimer = null;
    }
  }

  // ─── Called by OcppServer ────────────────────────────────────────────────

  // From the server: a charger connected under another Station ID while this device waits for
  // its own — Andi's Easee came as its serial number to a device set to "easee" (2026-10-15). Said on the
  // tile and, once the watchdog gives up, in the offline text; the log is not where one looks.
  onOtherStation(stationId) {
    this._otherStationId = stationId;
    this.log(`[Easee] A charger connected as "${stationId}", but this device waits for "${this.getSetting('station_id')}" — `
      + `enter ${stationId} as the Station ID`);
    this._set('ocpp_last_message', `Other Station ID: ${stationId}`).catch(() => {});
  }

  onOcppConnected() {
    this._otherStationId = null;
    this.log('[Easee] Charger connected');
    this._set('ocpp_server_status', 'connected').catch(() => {});
    // A moment to settle before being told anything, the same two seconds the server waits
    // before configuring the sampling interval.
    this.homey.setTimeout(() => {
      this._applyInitialProfile('charger connected').catch(() => {});
    }, 2000);
  }

  /**
   * Send the configured starting current to the charger.
   *
   * It used to be one shot, three seconds after the app started — which serves a charger
   * that is already connected and nobody else. After a Homey restart the charger reconnects
   * on its own schedule, often well past that mark, and then never received the current at
   * all: it kept whatever limit it had. Invisible to anyone running the EMS, because the
   * next tick writes a value anyway; the people it actually cost are those using
   * auto_start_charging with a default of their own.
   *
   * So it now runs on connect as well. Both paths share this method, which is also the only
   * place that decides whether sending is worth trying at all:
   *
   * A charger that is not connected gets nothing and no complaint. The device has already
   * said it is "waiting for charger (quietly)"; announcing three seconds later that a send
   * failed because the charger is not there contradicts that, and it was the only error
   * line in the log of the report that prompted this — so it read as the fault itself.
   */
  async _applyInitialProfile(reason) {
    if (this._txnId && !this._autoStartBlocked) return; // live session — leave alone

    const server    = this._ocppServer();
    const stationId = this.getSetting('station_id');
    if (!server.isConnected(stationId)) return;

    // On an app restart with the charger still attached, both paths fire within a couple of
    // seconds of each other. Sending the same profile twice is harmless and says nothing.
    if (this._initialProfileAt && Date.now() - this._initialProfileAt < INIT_PROFILE_DEDUP_MS) return;
    this._initialProfileAt = Date.now();

    const autoStart = this.getSetting('auto_start_charging') !== false;
    const initAmps  = autoStart ? (parseInt(this.getSetting('default_charging_amps'), 10) || 16) : BLOCK_AMPS;
    try {
      const r = await server.setMaxCurrentAsync(stationId, initAmps, this._getPhases());
      this.log(`[Easee] Init profile ${initAmps}A (${reason}) → ${(r && r.status) || 'no status'}`);
    } catch (e) {
      this.log(`[Easee] Init profile ${initAmps}A (${reason}) failed: ${e.message}`);
    }
  }

  // A lost connection does not end a transaction. OCPP 1.6 has the charger carry on charging
  // and deliver what happened meanwhile — MeterValues, StopTransaction — once it is back. Until
  // 1.2.310 this dropped _txnId, and nothing brought it back: the charger's "Charging" after the
  // reconnect was no change of state, so no session hook ran. Homey's off switch then did
  // nothing ("No active transaction to stop"), a 0 A pause had "nothing to pause", and a new
  // limit went to the default profile, which the session's own profile overrides — the EMS
  // had lost the car for the rest of the session (review 2026-10-10). The transaction and its
  // auto-start block stay; a transaction that really ended while the charger was away is
  // closed by _watchStaleTransaction.
  onOcppDisconnected() {
    this.log(`[Easee] Charger disconnected${this._txnId ? ` — transaction ${this._txnId} kept, the charger carries on without us` : ''}`);
    this._set('ocpp_server_status', 'waiting').catch(() => {});
    // 'error' not 'idle': connectivity loss must be visible to the user
    this._setChargingState('error').catch(() => {});
    this._updateSessionStatus('error').catch(() => {});
    this._set('measure_power', 0).catch(() => {});
  }

  onBootNotification(payload) {
    this.log('[Easee] BootNotification:', JSON.stringify(payload));
    this._set('ocpp_last_message', 'Boot: ' + (payload.chargePointModel || '?')).catch(() => {});
    if (!this.getAvailable()) this.setAvailable().catch(() => {});
    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const bootAmps    = autoStart ? defaultAmps : BLOCK_AMPS;
    this.homey.setTimeout(async () => {
      try {
        const r = await this._ocppServer()
          .setMaxCurrentAsync(this.getSetting('station_id'), bootAmps, this._getPhases());
        this.log(`[Easee] Boot profile ${bootAmps}A → ${(r && r.status) || 'no status'}`);
      } catch (e) { this.log(`[Easee] Boot profile ${bootAmps}A failed: ${e.message}`); }
    }, 3000);
  }

  onStatusNotification(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    this.log('[Easee] StatusNotification:', JSON.stringify(payload));
    const rawStatus  = payload.status || '';
    const homeyState = OCPP_STATUS_MAP[rawStatus] || 'idle';
    this._lastRawStatus = rawStatus;
    // Not only Available: Preparing and Finishing are no transaction either (OCPP 1.6 — before
    // one starts, after one stops). Andi's Easee came back after an app update reporting
    // Preparing, with the car plugged in and the transaction the app had restored long gone
    // (2026-10-16): every limit went to that transaction, and "Charge now" raised a limit
    // instead of starting (1.3.6).
    if (NO_TRANSACTION_STATUSES.has(rawStatus) && this._txnId) this._watchStaleTransaction(this._txnId);
    // The car's own "done": it stopped drawing with the charger still offering current.
    if (rawStatus === 'SuspendedEV' && this._txnId && this._carDoneAt === null) this._carDoneAt = Date.now();

    // First StatusNotification after restart confirms charger is live — clear
    // the restart-guard so the idle guard can run normally from here on.
    this.assumeActiveFromRestart = false;

    this._setChargingState(homeyState, OCPP_HOMEY_STATE[rawStatus]).catch(() => {});
    this._set('ocpp_last_message', 'Status: ' + rawStatus).catch(() => {});

    if (rawStatus === 'Charging' && !this._autoStartBlocked) {
      this._set('evcharger_charging', true).catch(() => {});
    } else if (rawStatus === 'Available' || rawStatus === 'Finishing') {
      this._set('evcharger_charging', false).catch(() => {});
    }

    this._updateSessionStatus(homeyState).catch(() => {});

    this._handleStateChange(homeyState, rawStatus)
      .catch((err) => this.log('[Easee] State change error:', err.message));

    this.homey.flow.getDeviceTriggerCard('ocpp_charging_state_changed')
      .trigger(this, { state: homeyState })
      .catch(() => {});

    this._fireFaultTrigger(payload, rawStatus);
  }

  /**
   * "Available" means no car and no session, so a transaction still held beside it ended while
   * the charger was away — or the StopTransaction is on its way. Give that message
   * STALE_TXN_GRACE_MS; if the charger still reports Available and has not sent it, close the
   * transaction here, as a stop with the reason EVDisconnected at the last meter reading.
   * The server's own map already forgets a transaction on Available; this is the device's half.
   *
   * Needed since a dropped connection keeps the transaction (onOcppDisconnected): a charger
   * that lost power reboots, reports Available and may never send the stop. It applies just as
   * much to a transaction restored from the store after an app restart.
   */
  _watchStaleTransaction(txnId) {
    if (this._staleTxnTimer) return;
    this._staleTxnTimer = this.homey.setTimeout(() => {
      this._staleTxnTimer = null;
      const status = this._lastRawStatus;
      if (this._txnId !== txnId || !NO_TRANSACTION_STATUSES.has(status)) return;
      this.log(`[Easee] Transaction ${txnId} ended while the charger was away — it reports ${status} `
        + `and sent no StopTransaction in ${STALE_TXN_GRACE_MS / 1000} s; closing it here`);
      this._locallyClosedTxnId = txnId;
      const meterStop = Math.round((this.getCapabilityValue('meter_power') || 0) * 1000);
      // Unplugged only when the charger says Available; Preparing and Finishing have the car on it.
      const reason = status === 'Available' ? 'EVDisconnected' : 'Other';
      this.onStopTransaction({ transactionId: txnId, meterStop, reason, closedLocally: true })
        .catch((err) => this.log('[Easee] Closing the stale transaction failed:', err.message));
    }, STALE_TXN_GRACE_MS);
  }

  // Every StatusNotification carries errorCode, and it used to go no further than the log
  // line above. A fault did reach a flow — as state "error" on the state-changed trigger —
  // but WHICH fault did not, so a ground fault and an over-temperature shutdown were
  // indistinguishable to anyone building an alert.
  //
  // Fired on the error code rather than on the connector status: a charger can report a
  // fault while the connector still reads Available or Charging, and NoError is the normal
  // value on every healthy notification. Repeats are suppressed, because a charger that is
  // faulted says so on every status change until it clears.
  _fireFaultTrigger(payload, rawStatus) {
    const code = (payload.errorCode || '').trim();
    const faulted = code && code !== 'NoError';
    if (!faulted) {
      this._lastFaultCode = null;
      return;
    }
    if (this._lastFaultCode === code) return;
    this._lastFaultCode = code;

    this.log(`[Easee] Charger fault: ${code}${payload.info ? ` — ${payload.info}` : ''}`);
    this.homey.flow.getDeviceTriggerCard('ocpp_charger_fault')
      .trigger(this, {
        error_code:        code,
        vendor_error_code: payload.vendorErrorCode || '',
        info:              payload.info || '',
        status:            rawStatus,
      })
      .catch((err) => this.log('[Easee] Trigger ocpp_charger_fault failed:', err.message));
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
      this.homey.setTimeout(async () => {
        if (this._txnId) return;
        await this._handleUnpluggedWithoutCharging(connStart);
      }, 4000);
    }

    // Fresh plug-in: clear stale "Fully Charged" flag from previous session
    if (newState === 'connected' && oldRawStatus === 'Available' && this.lastStopReason) {
      this.log(`[Easee] Fresh plug-in — clearing previous stop reason (was ${this.lastStopReason})`);
      await this._setLastStop(null);
    }

    if (newState === oldState) {
      this._prevRawStatus = rawStatus;
      return;
    }

    this.log(`[Easee] State: ${oldState || 'null'} → ${newState}`);

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
      this.log('[Easee] Car plugged in');

      const autoStart = this.getSetting('auto_start_charging') !== false;
      if (autoStart) {
        this.log('[Easee] Auto-start ON — proactively sending RemoteStartTransaction');
        this.homey.setTimeout(() => {
          if (this._txnId && !this._autoStartBlocked) {
            this.log('[Easee] Session already active — skipping proactive RemoteStart');
            return;
          }
          try { this.startCharging().catch(() => {}); } catch (e) { /* ignore */ }
        }, 500);
      } else {
        await this._postNotification('🚗', 'Car Plugged In', 'Car connected — ready to start');
        this.homey.flow.getDeviceTriggerCard('ocpp_car_plugged_waiting')
          .trigger(this, {})
          .catch((err) => this.log('[Easee] Trigger ocpp_car_plugged_waiting failed:', err.message));
      }
    }

    // State-driven session hooks — secondary guard alongside StartTransaction/StopTransaction
    if (oldState !== 'charging' && newState === 'charging') {
      await this.handleSessionStart();
    }
    if (oldState === 'charging' && (newState === 'idle' || newState === 'connected' || newState === 'error')) {
      await this.handleSessionEnd();
    }

    // The plug-in time goes with a real unplug only, above. It also went on any step from
    // connected to idle — and Finishing is idle here, so a paused car's stop (SuspendedEV →
    // Finishing → Preparing) lost it with the cable still in, and the unplug then reported
    // "plugged in for 0s" (review 2026-10-10).
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
      this.log(`[Easee] handleSessionStart: synthetic txnId=${this._txnId}`);
    } else {
      this.log(`[Easee] handleSessionStart: session already tracked (txnId=${this._txnId})`);
    }
  }

  async handleSessionEnd() {
    const currentEnergy = this.getCapabilityValue('meter_power') || 0;
    const energyWh      = Math.max(0, Math.round((currentEnergy * 1000) - this._txnMeterStart));
    const durationMs    = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    this.log(`[Easee] handleSessionEnd: ~${energyWh}Wh over ${this._formatDuration(durationMs)}`);
    // Do NOT reset transactionId here — onStopTransaction is the sole owner of that cleanup.
  }

  async _handleUnpluggedWithoutCharging(connStart) {
    if (this.stitchedSession) {
      await this._finalizeStitchedSession('EVDisconnected');
    }
    await this._setLastStop(null);

    const durationMs  = connStart ? (Date.now() - connStart) : 0;
    const durationStr = this._formatDuration(durationMs);
    const message     = `Disconnected · plugged in for ${durationStr}`;

    await this._postNotification('🚗', 'Disconnected', message);
    this.homey.flow.getDeviceTriggerCard('ocpp_disconnected')
      .trigger(this, { connected_minutes: Math.round(durationMs / 60000), message })
      .catch((err) => this.log('[Easee] Trigger ocpp_disconnected failed:', err.message));
  }

  onMeterValues(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    // One line per message with every value as sent, while the field test asks what an Easee
    // delivers: totals or phases, whether Current.Offered follows the limit (1.3.6).
    const parts = [];
    for (const mv of (payload.meterValue || [])) {
      for (const sv of (mv.sampledValue || [])) {
        parts.push(`${sv.measurand || 'Energy.Active.Import.Register'}${sv.phase ? `[${sv.phase}]` : ''}=${sv.value}${sv.unit ? ` ${sv.unit}` : ''}`);
      }
    }
    this.log(`[Easee] MeterValues${payload.transactionId != null ? ` (tx ${payload.transactionId})` : ''}: ${parts.join(', ') || '(empty)'}`);

    for (const mv of (payload.meterValue || [])) {
      const sampledValues = mv.sampledValue || [];
      // D (1.3.5): a value without a phase is the total; values per phase are summed, and only
      // used when no total came. Every Power.Active.Import used to overwrite the tile, so a
      // charger sending L1, L2 and L3 showed the last phase alone. As evcc does.
      const sums = {
        power:  { total: null, phases: 0, seen: false },
        energy: { total: null, phases: 0, seen: false },
      };
      let offeredA = null;

      for (const sv of sampledValues) {
        const measurand = sv.measurand || 'Energy.Active.Import.Register';
        let val = parseFloat(sv.value);
        if (!Number.isFinite(val)) continue;
        const unit = (sv.unit || '').toLowerCase();
        if (unit.startsWith('k')) val *= 1000;
        else if (unit === 'mw' || unit === 'mwh' || unit === 'ma') val /= 1000;

        switch (measurand) {

          case 'Power.Active.Import': {
            const sum = sums.power;
            if (sv.phase) { sum.phases += val; sum.seen = true; } else sum.total = val;
            break;
          }

          case 'Energy.Active.Import.Register': {
            const sum = sums.energy;
            if (sv.phase) { sum.phases += val; sum.seen = true; } else sum.total = val;
            break;
          }

          // C (1.3.5): what the charger offers the car, per phase — the highest of them.
          case 'Current.Offered':
            offeredA = Math.max(offeredA ?? 0, val);
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

      const power = sums.power.total ?? (sums.power.seen ? sums.power.phases : null);
      if (power !== null) this._onPower(Math.round(power));
      const energy = sums.energy.total ?? (sums.energy.seen ? sums.energy.phases : null);
      if (energy !== null) {
        this._setMeterReading(energy).catch(() => {});
        this._trackLastNonZero('meter_power', energy / 1000);
      }
      if (offeredA !== null) {
        this._set('measure_current.offered', offeredA).catch(() => {});
        this._checkOfferedCurrent(offeredA);
      }
    }

    this._set('ocpp_last_message', this._offeredNote || 'MeterValues received').catch(() => {});
  }

  // One power reading, total or summed (D): the tile, the verified start, the low-power streak.
  _onPower(powerW) {
    this._set('measure_power', powerW).catch(() => {});
    this._trackLastNonZero('measure_power', powerW);

    // Power-verified start: first real draw → announce started / resumed
    if (this._startVerify && this._startVerify.txId === this._txnId && powerW > LOW_POWER_W) {
      const v = this._startVerify;
      this._startVerify = null;
      if (this._pendingStartNotificationTimeout) {
        this.homey.clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      this.log(`[Easee] Power flowing (${powerW}W) — announcing verified ${v.isMaskedResume ? 'resume' : 'start'}`);
      this._announceVerifiedStart(v).catch((err) => this.log(`[Easee] Announce error: ${err.message}`));
    }

    // Low-power streak: Charging but ~0W for 3 min → 'finishing'
    if (this._txnId && this._chargingState() === 'charging') {
      if (powerW < LOW_POWER_W) {
        if (!this._lowPowerSince) this._lowPowerSince = Date.now();
        // As long as 'finishing' waits, and kept apart from the streak, which a status
        // change resets.
        if (this._carDoneAt === null && Date.now() - this._lowPowerSince >= LOW_POWER_FINISH_MS) {
          this._carDoneAt = this._lowPowerSince;
        }
      } else {
        this._lowPowerSince = null;
        this._carDoneAt     = null;
      }
      this._updateSessionStatus('charging').catch(() => {});
    } else {
      this._lowPowerSince = null;
    }
  }

  /**
   * Whether the charger offers the car the current it was given (C, 1.3.5). evcc reads
   * Current.Offered for this. Easee's own OCPP controls the current only from a newer firmware
   * than it connects with (evcc tested a beta, 9012), and this is where that shows: a car offered
   * 16 A after 8 A was set. Said once a mismatch has held for two readings — the first one after
   * a change may still carry the old value — and once per pair of figures.
   */
  _checkOfferedCurrent(offeredA) {
    if (!this._txnId || this._autoStartBlocked) { this._offeredMismatch = null; this._offeredNote = null; return; }
    const paused = !!(this.stitchedSession && this.stitchedSession.paused);
    const setA   = paused ? 0 : this._txnAmps;
    if (!Number.isFinite(setA)) return;
    const offered = Math.round(offeredA * 10) / 10;
    if (Math.abs(offered - setA) <= 1) { this._offeredMismatch = null; this._offeredNote = null; return; }
    const key = `${setA}/${offered}`;
    const m = this._offeredMismatch && this._offeredMismatch.key === key ? this._offeredMismatch : { key, count: 0, said: false };
    m.count++;
    this._offeredMismatch = m;
    if (m.count < 2 || m.said) return;
    m.said = true;
    if (offered > setA) {
      this.log(`[Easee] The charger offers ${offered} A although ${setA} A was set — it does not follow the limit; `
        + 'current control over OCPP may need a newer Easee firmware');
      // Kept on the tile while it lasts: every MeterValues would overwrite it otherwise.
      this._offeredNote = `Offers ${offered} A, set ${setA} A`;
    } else {
      this.log(`[Easee] The charger offers ${offered} A of the ${setA} A set — a limit of its own (circuit, Easee app) is lower`);
      this._offeredNote = `Offers ${offered} A, set ${setA} A`;
      this._logChargerSchedule().catch(() => {});
    }
  }

  // The charger's own view of its limit, into the log — once per mismatch (1.3.7).
  async _logChargerSchedule() {
    const server = this._ocppServer();
    if (!server || typeof server.getCompositeScheduleAsync !== 'function') return;
    try {
      const r = await server.getCompositeScheduleAsync(this.getSetting('station_id'), 1, 60);
      const sched   = r && r.chargingSchedule;
      const periods = (sched && sched.chargingSchedulePeriod) || [];
      const first   = periods[0];
      this.log(`[Easee] Its own schedule: ${r && r.status}`
        + (first ? ` — ${first.limit} ${sched.chargingRateUnit || ''} now`
          + ` (${first.limit > 0 ? 'so the lower current comes from outside OCPP: the Easee app or cloud, a schedule, the circuit' : 'so OCPP itself holds it at 0'})` : ''));
    } catch (err) {
      this.log(`[Easee] Its own schedule could not be read: ${err.message}`);
    }
  }

  async onStartTransaction(payload, txnId) {
    this.log('[Easee] StartTransaction txnId:', txnId);
    this._lowPowerSince = null;
    this._carDoneAt     = null;

    if (payload.idTag) {
      this.idTag = payload.idTag;
      // Persist idTag so RemoteStart works correctly after a Homey restart
      this.learnedIdTag = payload.idTag;
      this.setStoreValue('learnedIdTag', payload.idTag).catch(() => {});
    }

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;

    this._txnId         = txnId;
    this._txnStartTime  = Date.now();
    this._txnMeterStart = payload.meterStart != null
      ? payload.meterStart
      : (this.getCapabilityValue('meter_power') || 0) * 1000;
    await this._setLastStop(null);

    const manualStart = this._manualStartRequested;
    this._manualStartRequested = false;

    if (!autoStart && !manualStart) {
      this._autoStartBlocked = true;
      this._txnAmps = BLOCK_AMPS;
      this.log(`[Easee] Auto-start OFF — blocking with ${BLOCK_AMPS}A TxProfile`);
      try {
        const r = await this._ocppServer()
          .setTxProfileAsync(this.getSetting('station_id'), txnId, BLOCK_AMPS, this._getPhases());
        this.log(`[Easee] Block TxProfile → ${(r && r.status) || 'no status'}`);
      } catch (e) { this.log('[Easee] Block TxProfile failed:', e.message); }

      await this._set('evcharger_charging', false);
      await this._setChargingState('connected');
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
      await this._set('evcharger_charging', true);
      await this._setChargingState('charging');
      await this._set('ocpp_last_message', isMaskedResume ? 'Charging resumed' : 'Charging started');
      await this._updateSessionStatus('charging');
      this._updateChargingProfile().catch(() => {});

      // Power-verified start: set watcher; fires _announceVerifiedStart() when >100W arrives.
      const startedTxId = txnId;
      this._startVerify = { txId: startedTxId, isMaskedResume, activeAmps };

      if (this._pendingStartNotificationTimeout) this.homey.clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = this.homey.setTimeout(async () => {
        this._pendingStartNotificationTimeout = null;
        if (!this._startVerify || this._startVerify.txId !== startedTxId) return;
        if (this._txnId !== startedTxId) return;
        const what = isMaskedResume ? 'Resume' : 'Start';
        this.log(`[Easee] ${what} requested but no power after 90s — car may be full`);
        await this._postNotification('🪫', `${what} Requested`, `${what} requested · car isn't drawing power (battery may be full?)`);
      }, 90_000);
    }
  }

  async onStopTransaction(payload) {
    this.log('[Easee] StopTransaction:', JSON.stringify(payload));

    // The charger's own stop for a transaction already closed here by _watchStaleTransaction,
    // delivered late from its offline queue. Booking it again would record a second session
    // with the whole meter reading as its energy.
    if (!payload.closedLocally && payload.transactionId != null && !this._txnId
        && payload.transactionId === this._locallyClosedTxnId) {
      this.log(`[Easee] StopTransaction for ${payload.transactionId} arrived after it was closed here — already accounted`);
      this._locallyClosedTxnId = null;
      return;
    }

    const meterStop  = payload.meterStop || 0;
    const reason     = payload.reason || 'Unknown';
    const durationMs = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    const energyWh   = Math.max(0, meterStop - this._txnMeterStart);

    // ── Masked pause: this stop is OURS — accumulate segment, suppress events ──
    if (this.stitchedSession && this.stitchedSession.stopRequested) {
      this.stitchedSession.stopRequested       = false;
      this.stitchedSession.accumulatedEnergyWh = (this.stitchedSession.accumulatedEnergyWh || 0) + Math.max(0, energyWh);
      await this._persistStitched();
      this.log(`[Easee] Masked pause: segment closed (+${Math.max(0, energyWh)}Wh, ${this.stitchedSession.accumulatedEnergyWh}Wh accumulated)`);

      this._quickAbortCount = 0;
      this._txnId = null; this._txnStartTime = null;
      this._txnMeterStart = 0;
      // Deliberately preserve _txnAmps — it's the resume target shown by charging_profile.
      this._autoStartBlocked = false;
      this._lowPowerSince = null;
      this._startVerify   = null;
      if (this._pendingStartNotificationTimeout) {
        this.homey.clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      if (this._pendingTxProfileTimer) {
        this.homey.clearTimeout(this._pendingTxProfileTimer);
        this._pendingTxProfileTimer = null;
      }
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('evcharger_charging', false);
      // The transaction has ended, so nothing flows — but a charger sends its sampled MeterValues
      // only during a transaction, so no 0 W sample may come to say so, and the last reading stood for the
      // whole pause. The EMS reads it as the charger's draw: it booked it as session energy,
      // counted it in the house load, and kept sending stops to a charger that seemed to draw
      // (review 2026-10-10).
      await this._set('measure_power', 0);
      for (const cap of ['measure_current', 'measure_current.l1', 'measure_current.l2', 'measure_current.l3']) {
        await this._set(cap, 0);
      }
      await this._updateSessionStatus('connected');

      this.homey.setTimeout(async () => {
        try {
          const r = await this._ocppServer()
            .setMaxCurrentAsync(this.getSetting('station_id'), BLOCK_AMPS, this._getPhases());
          this.log(`[Easee] Masked pause: ${BLOCK_AMPS}A hold → ${(r && r.status) || 'no status'}`);
        } catch (e) { this.log(`[Easee] Masked pause hold failed: ${e.message}`); }
      }, 2000);
      return;
    }

    // ── Quick-abort: charger aborts <2 s (reason=Other) — retry once ─────────
    const wasQuickAbort = reason === 'Other' && durationMs > 0 && durationMs < QUICK_ABORT_MS;
    if (wasQuickAbort && this._quickAbortCount < 1 && this._txnAmps && this._txnAmps > 0) {
      const retryAmps   = this._txnAmps;
      const retryPhases = this.sessionPhaseOverride;
      this._quickAbortCount++;
      this.log(`[Easee] Quick abort (${durationMs}ms, reason=Other) — retrying at ${retryAmps}A in 3s`);

      if (this._pendingStartNotificationTimeout) {
        this.homey.clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      if (this._pendingTxProfileTimer) {
        this.homey.clearTimeout(this._pendingTxProfileTimer);
        this._pendingTxProfileTimer = null;
      }
      this._startVerify = null;
      this._txnId = null; this._txnStartTime = null;
      this._autoStartBlocked = false;
      this.sessionPhaseOverride = null;
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('evcharger_charging', false);
      await this._setChargingState('connected');

      const stationId = this.getSetting('station_id');
      this.homey.setTimeout(async () => {
        try {
          this._manualStartRequested = true;
          this.sessionPhaseOverride = retryPhases;
          const server = this._ocppServer();
          const limit = await server.setMaxCurrentAsync(stationId, retryAmps, retryPhases || this._devicePhases());
          const start = await server.remoteStartAsync(stationId);
          this.log(`[Easee] Quick-abort retry: profile → ${(limit && limit.status) || 'no status'}, `
            + `start → ${(start && start.status) || 'no status'}`);
        } catch (e) { this.log('[Easee] Retry failed:', e.message); }
      }, 3000);
      return;
    }
    this._quickAbortCount = 0;

    // ── Stitched resume ended — report as ONE continuous session ─────────────
    const wasStitched   = !!this.stitchedSession;
    let reportStartTime = this._txnStartTime;
    let reportEnergyWh  = energyWh;
    if (this.stitchedSession) {
      reportStartTime = this.stitchedSession.originalStartTime;
      reportEnergyWh  = (this.stitchedSession.accumulatedEnergyWh || 0) + Math.max(0, energyWh);
      this.log(`[Easee] Masked pause: final stop — stitched session total=${reportEnergyWh}Wh, reason=${reason}`);
      this.stitchedSession = null;
      this.isPaused = false;
      await this._persistStitched();
    }
    const reportDurationMs = reportStartTime ? (Date.now() - reportStartTime) : 0;

    const wasBlocked      = this._autoStartBlocked;
    const sessionAmps     = this._txnAmps;
    const sessionPhases   = this._getPhases();
    const sessionOwnerWas = this.sessionOwner;
    // A start that never drew power — "charging started" waits for it — and delivered nothing
    // still fired "charging stopped": a stop with no start before it, for a car that refused
    // the start or the second of two quick aborts (review 2026-10-10). A resumed session
    // started long before and still ends with the card.
    const verify     = this._startVerify;
    const falseStart = !wasStitched && !!verify && verify.txId === this._txnId && reportEnergyWh < FALSE_START_WH;

    // "Fully charged" is the charger's own stop (Local) after the car was done: SuspendedEV, or
    // three minutes under 100 W. Local alone is also a stop at the charger by hand, which then
    // read as a full car until the next plug-in (review 2026-10-10).
    await this._setLastStop(reason, reason === 'Local' && this._carDoneAt !== null);

    this._txnId = null; this._txnStartTime = null;
    this._txnMeterStart = 0; this._txnAmps = null;
    this._autoStartBlocked = false;
    this._lowPowerSince = null;
    this._carDoneAt     = null;
    this._startVerify   = null;
    this.sessionPhaseOverride = null;
    this.isPaused = false;
    this.sessionOwner = null;
    if (this._pendingStartNotificationTimeout) {
      this.homey.clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = null;
    }
    if (this._pendingTxProfileTimer) {
      this.homey.clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
    }
    await this.setStoreValue('activeSession', null).catch(() => {});

    await this._set('evcharger_charging', false);
    const settledState = (() => {
      const cur = this._chargingState();
      if (cur && cur !== 'charging') return cur;
      return 'connected';
    })();
    // With the same override as the status itself: a Finishing that arrived before this stop
    // is still a car on the cable (see OCPP_HOMEY_STATE).
    await this._setChargingState(settledState, OCPP_HOMEY_STATE[this._lastRawStatus]);
    await this._set('measure_power', 0);
    if (meterStop > 0) await this._setMeterReading(meterStop);
    await this._set('ocpp_last_message', 'Charging stopped');
    await this._updateSessionStatus(settledState);
    this._updateChargingProfile().catch(() => {});

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const restoreAmps = autoStart ? defaultAmps : BLOCK_AMPS;
    this.homey.setTimeout(async () => {
      try {
        const r = await this._ocppServer()
          .setMaxCurrentAsync(this.getSetting('station_id'), restoreAmps, this._getPhases());
        this.log(`[Easee] Restore profile ${restoreAmps}A → ${(r && r.status) || 'no status'}`);
      } catch (e) { this.log(`[Easee] Restore profile ${restoreAmps}A failed: ${e.message}`); }
    }, 2000);

    if (!wasBlocked) {
      if (reportDurationMs >= 5000) {
        await this._recordSession({ durationMs: reportDurationMs, energyWh: reportEnergyWh, amps: sessionAmps, phases: sessionPhases, reason, startTime: reportStartTime, owner: sessionOwnerWas });
      }
      if (falseStart) {
        this.log(`[Easee] The start never drew power (${reason}, ${this._formatDuration(reportDurationMs)}) — no "charging stopped"`);
        return;
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
        .catch((err) => this.log('[Easee] Trigger ocpp_charging_stopped failed:', err.message));
    }
  }

  onServerStarted(port) {
    this.log(`[Easee] Server listening on port ${port}`);
    this._set('ocpp_server_status', 'waiting').catch(() => {});
  }

  onServerError(err) {
    this.error('[Easee] Server error:', err.message);
    this._set('ocpp_server_status', 'error').catch(() => {});
    this.setUnavailable('OCPP server error: ' + err.message).catch(() => {});
  }

  // ─── Charging control ────────────────────────────────────────────────────

  /**
   * A start is not a second start. On a session that is running, paused, or being resumed this
   * used to send RemoteStart once more and, 3 s later, the start's safety-net profile at the
   * default current — so the EMS's own retry for a car that ignored its start (start and current
   * together), its resume after a 0 A pause (both cards at once) and Homey's native start could
   * leave the car at 16 A while the EMS believed 6–7 A, and the EMS sends a current only when
   * it changes (review 2026-10-10). Now:
   *   - running: only an explicitly given current is applied, as a new limit;
   *   - paused: it resumes, at the given current if there is one;
   *   - being resumed (no transaction yet, under a minute): the resume is already on its way.
   * resumeCharging's own start passes `fromResume`.
   */
  async startCharging(amps, overridePhases, owner, { fromResume = false } = {}) {
    if (!fromResume) {
      // A paused session first: held at 0 A it still has its transaction, and the branch
      // below would set a limit the hold then swallows instead of resuming (A, 1.3.5).
      if (this.stitchedSession && this.stitchedSession.paused && this.stitchedSession.holdAtZero && this._txnId) {
        this.log(`[Easee] Start on a paused session — resuming${amps != null ? ` at ${amps}A` : ''}`);
        if (amps != null) {
          this._validateProfileRequest(amps, this._getPhases());
          this._txnAmps = amps;
          this.stitchedSession.resumeAmps = amps;
        }
        return this.resumeCharging(owner || 'user');
      }
      if (this._txnId && !this._autoStartBlocked) {
        if (amps != null && amps !== this._txnAmps) {
          this.log(`[Easee] Start on a running session — applying ${amps}A as its limit`);
          return this.setChargingLimit(amps, overridePhases, owner);
        }
        this.log('[Easee] Start on a running session — already charging, nothing sent');
        return undefined;
      }
      if (this.stitchedSession && this.stitchedSession.paused) {
        this.log(`[Easee] Start on a paused session — resuming${amps != null ? ` at ${amps}A` : ''}`);
        if (amps != null) {
          this._validateProfileRequest(amps, this._getPhases());
          this._txnAmps = amps;
          this.stitchedSession.resumeAmps = amps;
        }
        return this.resumeCharging(owner || 'user');
      }
      if (!this._txnId && this.stitchedSession && this.stitchedSession.resuming
          && (Date.now() - (this._resumeStartedAt || 0)) < RESUME_IN_FLIGHT_MS) {
        if (amps != null) this._txnAmps = amps;
        this.log('[Easee] Start while a resume is on its way — nothing sent');
        return undefined;
      }
    }
    this._startInFlight = true;
    try {
      return await this._startChargingInner(amps, overridePhases, owner);
    } finally {
      this._startInFlight = false;
    }
  }

  async _startChargingInner(amps, overridePhases, owner) {
    this._refuseOtherPhases(overridePhases);
    const stationId   = this.getSetting('station_id');
    const server      = this._ocppServer();
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;

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
      this.log(`[Easee] Unblock TxProfile response: ${JSON.stringify(unblockResp)}`);
      await this._set('evcharger_charging', true);
      await this._setChargingState('charging');
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
      this.log(`[Easee] Unblocked transaction ${this._txnId} at ${targetAmps}A (owner: ${this.sessionOwner})`);
      return;
    }

    // No active transaction — set limit and send RemoteStartTransaction
    this._txnAmps = targetAmps;
    this.sessionOwner = owner || 'user';
    this._manualStartRequested = true;
    try {
      const limitResp = await server.setMaxCurrentAsync(stationId, targetAmps, this._getPhases());
      this.log(`[Easee] setMaxCurrent response: ${JSON.stringify(limitResp)}`);
    } catch (e) { this.log('[Easee] setMaxCurrent before start failed:', e.message); }
    const startResp = await server.remoteStartAsync(stationId);
    this.log(`[Easee] RemoteStart response: ${JSON.stringify(startResp)}`);
    if (startResp && startResp.status === 'Rejected') {
      this.log('[Easee] RemoteStart rejected by charger');
    }
    this._updateChargingProfile().catch(() => {});

    // Safety-net: re-apply TxProfile 3 s after RemoteStart
    if (this._pendingTxProfileTimer) this.homey.clearTimeout(this._pendingTxProfileTimer);
    const safetyAmps   = targetAmps;
    const safetyPhases = this._getPhases();
    this._pendingTxProfileTimer = this.homey.setTimeout(() => {
      this._pendingTxProfileTimer = null;
      if (!this._txnId || this._autoStartBlocked) return;
      // The current in force when it fires, not the one captured 3 s ago: a later start or
      // resume may have set another one in between.
      const amps = this._txnAmps || safetyAmps;
      server.setTxProfileAsync(stationId, this._txnId, amps, safetyPhases)
        .then(r => this.log(`[Easee] Safety-net TxProfile applied: ${amps}A — ${JSON.stringify(r)}`))
        .catch(e => this.log(`[Easee] Safety-net TxProfile failed: ${e.message}`));
    }, 3000);
  }

  async stopCharging(source) {
    if (!this._txnId) {
      if (this.stitchedSession && this.stitchedSession.paused) {
        this.log('[Easee] Stop during masked pause — finalizing logical session');
        await this._finalizeStitchedSession('Remote');
        await this._updateSessionStatus('connected');
        return;
      }
      this.log('[Easee] No active transaction to stop');
      return;
    }
    try {
      const response = await this._ocppServer().remoteStopAsync(this.getSetting('station_id'), this._txnId);
      this.log('[Easee] RemoteStop response:', JSON.stringify(response));
    } catch (e) {
      this.log('[Easee] RemoteStop failed:', e.message);
      throw e;
    }
  }

  // ─── Masked Pause / Resume ───────────────────────────────────────────────

  async pauseCharging(context) {
    if (this.stitchedSession && this.stitchedSession.paused) {
      this.log('[Easee] Already paused — ignoring duplicate pause');
      return;
    }
    if (!this._txnId) {
      throw new Error('No active charging session to pause.');
    }

    if (!context || context === 'user') {
      this.sessionOwner = 'user';
    }

    const resumeAmps   = this._txnAmps || parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const resumePhases = this.sessionPhaseOverride;
    const prior        = this.stitchedSession;
    const pauseOwner   = this.sessionOwner;

    // A (1.3.5): the transaction is held at 0 A, not ended. evcc pauses an OCPP charger this
    // way; the RemoteStop of the other driver ends the transaction, and on an Easee it also
    // switches free charging off. No StopTransaction is ours to swallow (stopRequested false),
    // and the session's energy stays in its one transaction.
    this.stitchedSession = {
      originalStartTime:   prior ? prior.originalStartTime   : this._txnStartTime,
      accumulatedEnergyWh: prior ? (prior.accumulatedEnergyWh || 0) : 0,
      paused:              true,
      stopRequested:       false,
      holdAtZero:          true,
      resuming:            false,
      resumeAmps,
      resumePhases,
      owner:               pauseOwner,
    };
    this.isPaused = true;
    await this._persistStitched();

    this.log(`[Easee] Pause: transaction ${this._txnId} held at 0 A (context=${context || 'user'}, will resume at ${resumeAmps}A)`);

    const pauseMessage = 'Charging paused';

    try {
      const holdResponse = await this._ocppServer()
        .setTxProfileAsync(this.getSetting('station_id'), this._txnId, BLOCK_AMPS, this._getPhases());
      if (holdResponse && holdResponse.status && holdResponse.status !== 'Accepted') {
        throw new Error(`Charger answered ${holdResponse.status} to the 0 A limit`);
      }
      await this._set('evcharger_charging', false);
      await this._updateSessionStatus(this._chargingState());
      await this._postNotification('⏸️', 'Charging Paused', pauseMessage);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_paused')
        .trigger(this, { resume_amps: resumeAmps, message: pauseMessage })
        .catch((err) => this.log('[Easee] Trigger ocpp_charging_paused failed:', err.message));
    } catch (e) {
      this.log(`[Easee] Pause failed: ${e.message}`);
      this.stitchedSession = prior || null;
      this.isPaused = !!(prior && prior.paused);
      await this._persistStitched();
      throw e;
    }
  }

  async resumeCharging(source) {
    if (!this.stitchedSession || !this.stitchedSession.paused) {
      if (this._txnId) {
        this.log('[Easee] Not paused — ignoring resume');
        return;
      }
      throw new Error('No paused charging session to resume.');
    }

    const { resumeAmps, resumePhases } = this.stitchedSession;

    // A (1.3.5): held at 0 A, the transaction is still there — raise its limit. "Charging
    // resumed" waits for power, as after a start. Without the transaction (the charger ended it
    // meanwhile) the session is started anew below.
    if (this.stitchedSession.holdAtZero && this._txnId) {
      const amps = this._txnAmps || resumeAmps;
      this._validateProfileRequest(amps, this._getPhases());
      this.stitchedSession.paused   = false;
      this.stitchedSession.resuming = true;
      this.isPaused = false;
      await this._persistStitched();
      this.log(`[Easee] Resume: transaction ${this._txnId} back to ${amps}A`);
      try {
        const r = await this._ocppServer()
          .setTxProfileAsync(this.getSetting('station_id'), this._txnId, amps, this._getPhases());
        if (r && r.status && r.status !== 'Accepted') throw new Error(`Charger answered ${r.status} to ${amps} A`);
      } catch (e) {
        this.log(`[Easee] Resume failed: ${e.message}`);
        this.stitchedSession.paused   = true;
        this.stitchedSession.resuming = false;
        this.isPaused = true;
        await this._persistStitched();
        throw e;
      }
      this._txnAmps = amps;
      await this._saveSession();
      await this._set('target_current', amps);
      this._updateChargingProfile().catch(() => {});
      this._startVerify = { txId: this._txnId, isMaskedResume: true, activeAmps: amps };
      await this._updateSessionStatus(this._chargingState());
      return;
    }

    this.stitchedSession.paused   = false;
    this.stitchedSession.resuming = true;
    this.isPaused = false;
    await this._persistStitched();

    this.log(`[Easee] Masked resume: starting transaction stitched onto paused session (${resumeAmps}A${resumePhases ? `/${resumePhases}P` : ''})`);
    this._resumeStartedAt = Date.now();
    try {
      // Preserve the phase override from the paused session; keep existing owner
      await this.startCharging(this._txnAmps || resumeAmps, resumePhases || undefined, this.sessionOwner, { fromResume: true });
    } catch (e) {
      this.log(`[Easee] Resume failed: ${e.message}`);
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

    this.log(`[Easee] Stitched session finalized (${reason}): ${reportEnergyWh}Wh over ${durationStr}`);
    await this._setLastStop(reason);

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
      .catch((err) => this.log('[Easee] Trigger ocpp_charging_stopped failed:', err.message));
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
      const message = `Charging resumed · ${this._kwLabel(amps, phases)} (${amps}A) / ${this._phaseLabel(phases)}`;
      await this._postNotification('▶️', 'Charging Resumed', message);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_resumed')
        .trigger(this, { amps, phases, phase_label: this._phaseLabel(phases), message })
        .catch((err) => this.log('[Easee] Trigger ocpp_charging_resumed failed:', err.message));
      return;
    }

    const message = `Charging started · ${this._kwLabel(amps, phases)} (${amps}A) / ${this._phaseLabel(phases)}`;
    await this._postNotification('🔋', 'Charging Started', message);
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
      .trigger(this, { amps, phases, phase_label: this._phaseLabel(phases), message,
        transaction_id: this._txnId || 0, meter_start: this._txnMeterStart || 0 })
      .catch((err) => this.log('[Easee] Trigger ocpp_charging_started failed:', err.message));
  }

  // ─── Release charger ─────────────────────────────────────────────────────

  async releaseCharger() {
    this.log('[Easee] Releasing charger: ChangeAvailability → Operative');
    try {
      const response = await this._ocppServer().changeAvailabilityAsync(this.getSetting('station_id'), 0, 'Operative');
      this.log('[Easee] ChangeAvailability response:', JSON.stringify(response));
    } catch (e) {
      this.log('[Easee] Release failed:', e.message);
      throw e;
    }
  }

  // ─── The energy register ────────────────────────────────────────────────
  //
  // meter_power is the charger's lifetime register and the meter Homey Energy books the car's
  // consumption from — by difference, re-anchoring on a fall and counting the recovery as new
  // energy. A 0, or a reading below the last one, followed by the real figure booked the whole
  // lifetime as one day: the same fault 1.2.320 closed for the cloud meters. Every value went
  // straight through here. Now a reading of 0 or less is not one, and a dip is held until it
  // lasts (lib/capability-set.js _setCumulative: 6 h, then believed and logged — a charger
  // that was replaced or reset).
  async _setMeterReading(wh) {
    if (!(wh > 0)) return;
    await this._setCumulative('meter_power', parseFloat((wh / 1000).toFixed(3)));
  }

  // ─── Charge Now ──────────────────────────────────────────────────────────
  // One-tap 16A start — takes over any engine session without suppressing future automation.

  // Homey stores the switch's new value only after the listener has resolved, so turning it
  // off from inside the listener would be overwritten at once; a moment later it sticks. After a
  // refused tap Homey keeps the old value anyway, and this changes nothing.
  _resetChargeNowSwitch() {
    if (this._chargeNowReset) this.homey.clearTimeout(this._chargeNowReset);
    this._chargeNowReset = this.homey.setTimeout(() => {
      this._chargeNowReset = null;
      if (this.hasCapability('charge_now') && this.getCapabilityValue('charge_now') !== false) {
        this.setCapabilityValue('charge_now', false).catch(() => {});
      }
    }, CHARGE_NOW_RESET_MS);
  }

  async chargeNow() {
    if (this.chargerOffline) {
      throw new Error('Charger is offline — cannot start charging.');
    }
    const state = this.getCapabilityValue('session_status');
    if (!this._txnId && state === 'not_connected') {
      throw new Error('No car connected — plug in first, then Charge Now.');
    }

    const targetAmps  = 16; // always 16A — "important travel" semantics
    this.log(`[Easee] Charge Now: ${targetAmps}A`);

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

  // ─── Reboot charger ──────────────────────────────────────────────────────
  // A reboot takes 2–3 minutes of silence — suppress the offline watchdog alert.

  async rebootCharger(type = 'Soft') {
    this._expectedOfflineUntil = Date.now() + 300_000;
    this.log(`[Easee] Sending Reset (${type}) to charger...`);
    const response = await this._ocppServer().resetAsync(this.getSetting('station_id'), type);
    this.log(`[Easee] Reset (${type}) response: ${JSON.stringify(response)}`);
    return response;
  }

  // ─── Set charging limit ───────────────────────────────────────────────────

  async setChargingLimit(amps, overridePhases, source) {
    if (!Number.isInteger(amps) || amps < MIN_AMPS || amps > MAX_AMPS) {
      throw new Error(`Invalid amps: ${amps}. Must be a whole number between ${MIN_AMPS} and ${MAX_AMPS}.`);
    }

    this._refuseOtherPhases(overridePhases);

    // A — paused at 0 A: the new current waits for the resume. Sent now, it would lift the hold
    // while the device still read "paused".
    if (this.stitchedSession && this.stitchedSession.paused && this.stitchedSession.holdAtZero) {
      this._txnAmps = amps;
      this.stitchedSession.resumeAmps = amps;
      await this._persistStitched();
      this.log(`[Easee] ${amps}A kept for the resume — the session is paused at 0 A`);
      return;
    }

    // Set phase override first so _getPhases() returns the right value for validate
    if (overridePhases === 1 || overridePhases === 3) {
      this.sessionPhaseOverride = overridePhases;
      this.log(`[Easee] Phase override set to ${overridePhases} via explicit amps+phase card`);
    }

    // Hardware floor check before any state mutation
    this._validateProfileRequest(amps, this._getPhases());

    const stationId  = this.getSetting('station_id');
    const server     = this._ocppServer();
    const prevAmps   = this._txnAmps;
    const prevPhases = this._getPhases();

    // Cancel any pending safety-net TxProfile — an explicit limit always wins
    if (this._pendingTxProfileTimer) {
      this.homey.clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
      this.log('[Easee] Cancelled pending safety-net TxProfile — explicit limit takes precedence');
    }

    if (this._txnId && !this._autoStartBlocked) {
      const r = await server.setTxProfileAsync(stationId, this._txnId, amps, this._getPhases());
      this.log(`[Easee] Limit ${amps}A → ${JSON.stringify(r)}`);
      this._assertAccepted(r, `${amps} A`);
      this._txnAmps = amps;
      await this._saveSession();
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
          .catch((err) => this.log('[Easee] Trigger ocpp_charging_limit_changed failed:', err.message));
      }
    } else {
      // No active transaction: remember for next start
      const r = await server.setMaxCurrentAsync(stationId, amps, this._getPhases());
      this.log(`[Easee] Limit ${amps}A for the next start → ${JSON.stringify(r)}`);
      this._assertAccepted(r, `${amps} A`);
      this.pendingStartAmps = amps;
      await this._set('target_current', amps);
      this._updateChargingProfile().catch(() => {});
    }
    this.log(`[Easee] Charging limit set to ${amps}A`);
  }

  // The "Set max charging current" card. 0 A pauses — what its tooltip promised all along, and
  // what an EMS stop sends through "EMS wants to set charger current" ({ amps: 0 }), which
  // setChargingLimit refuses (6–32 A only), so a flow wired that way failed on every stop.
  // A session paused this way resumes at the next current above 0; one paused by hand, or by
  // anything else, stays paused until it is resumed the usual way.
  async setChargingLimitFromCard(amps) {
    if (amps === 0) {
      if (!this._txnId) {
        this.log('[Easee] 0 A with no session running — nothing to pause');
        return;
      }
      const wasPaused = !!(this.stitchedSession && this.stitchedSession.paused);
      await this.pauseCharging();
      if (!wasPaused && this.stitchedSession && this.stitchedSession.paused) {
        this.stitchedSession.zeroAmpPause = true;
        await this._persistStitched();
      }
      return;
    }
    if (this.stitchedSession && this.stitchedSession.paused && this.stitchedSession.zeroAmpPause) {
      if (!Number.isInteger(amps) || amps < MIN_AMPS || amps > MAX_AMPS) {
        throw new Error(`Invalid amps: ${amps}. Must be a whole number between ${MIN_AMPS} and ${MAX_AMPS}.`);
      }
      this._validateProfileRequest(amps, this._getPhases());
      this.log(`[Easee] ${amps} A after a 0 A pause — resuming`);
      // Both, as chargeNow does: resumeCharging starts at _txnAmps first, and the pause keeps
      // _txnAmps on purpose. Setting only resumeAmps resumed at the current from BEFORE the
      // pause — 16 A, when the EMS had paused at 0 A and then asked for 7 A, and the EMS only
      // sends a current when it changes, so it never corrected it (review 2026-10-10).
      this._txnAmps = amps;
      this.stitchedSession.resumeAmps = amps;
      return this.resumeCharging('user');
    }
    return this.setChargingLimit(amps);
  }

  // Finishing — the charger done, the cable still in — maps to 'idle' like an empty socket, so
  // it is asked for by its raw name, the way _handleStateChange already does to tell a real
  // unplug from the end of a session.
  _carPluggedIn() {
    const state = this._chargingState();
    return state === 'connected' || state === 'charging'
      || (state === 'idle' && this._prevRawStatus === 'Finishing');
  }

  // ─── Offline watchdog ─────────────────────────────────────────────────────

  async _checkChargerOnline() {
    if (this._stationIdTaken) return; // not registered — "offline" would be the wrong reason
    const server   = this._ocppServer();
    // This charger's own last message, not the server's: with two chargers on one Homey the
    // server-wide time kept a silent one looking online for as long as the other talked.
    const lastSeen = server ? server.lastMessageAtFor(this.getSetting('station_id') || '') : null;
    const silentMs = lastSeen ? (Date.now() - lastSeen) : null;
    const isOffline = !server || silentMs === null || silentMs > OFFLINE_AFTER_MS;

    if (isOffline && !this.chargerOffline) {
      if (silentMs === null && !this._bootGraceStart) this._bootGraceStart = Date.now();
      if (silentMs === null && (Date.now() - this._bootGraceStart) < OFFLINE_AFTER_MS) return;

      this.chargerOffline = true;
      this.log(`[Easee] Charger OFFLINE: ${silentMs === null ? 'never connected' : Math.round(silentMs / 1000) + 's silent'}`);
      await this.setUnavailable(this._otherStationId
        ? `No charger with Station ID "${this.getSetting('station_id')}" — "${this._otherStationId}" connected instead; enter it as the Station ID`
        : 'Charger offline — no OCPP messages received').catch(() => {});
      await this._updateSessionStatus(this._chargingState());

      const expected = Date.now() < this._expectedOfflineUntil;
      if (!expected) {
        await this._postNotification('📡', 'Charger Offline', 'Charger offline — connection lost');
        this.homey.flow.getDeviceTriggerCard('ocpp_charger_offline')
          .trigger(this, { message: 'Charger offline — connection lost' })
          .catch((err) => this.log('[Easee] Trigger ocpp_charger_offline failed:', err.message));
      }
      this._offlineWasAlerted = !expected;
      await this.setStoreValue('chargerWasOffline', true).catch(() => {});
      return;
    }

    if (!isOffline && this.chargerOffline) {
      this.chargerOffline = false;
      this._bootGraceStart = null;
      await this.setStoreValue('chargerWasOffline', false).catch(() => {});
      this.log('[Easee] Charger back ONLINE');
      await this.setAvailable().catch(() => {});
      await this._updateSessionStatus(this._chargingState());

      if (this._offlineWasAlerted) {
        await this._postNotification('📡', 'Charger Online', 'Charger back online');
        this.homey.flow.getDeviceTriggerCard('ocpp_charger_online')
          .trigger(this, { message: 'Charger back online' })
          .catch((err) => this.log('[Easee] Trigger ocpp_charger_online failed:', err.message));
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
            const r = await this._ocppServer()
              .setMaxCurrentAsync(this.getSetting('station_id'), BLOCK_AMPS, this._getPhases());
            this.log(`[Easee] Idle guard: refreshed 0A TxDefaultProfile → ${(r && r.status) || 'no status'}`);
          } catch (e) { this.log(`[Easee] Idle guard refresh failed: ${e.message}`); }
        }
      }, IDLE_GUARD_MS);
      this.log('[Easee] Idle guard started (auto-start OFF)');
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
    // Standard EV control capabilities. Homey's "Set target power" flow sets
    // target_power_mode, evcharger_charging and target_power in quick succession —
    // registerMultipleCapabilityListener debounces them into one call so we send
    // a single command to the charger. (Homey EV charger spec, v12.4.5+.)
    this.registerMultipleCapabilityListener(
      ['evcharger_charging', 'target_power', 'target_power_mode'],
      async ({ evcharger_charging, target_power, target_power_mode }) => {
        // Who is in charge. Homey's documentation is explicit: in "device" mode the
        // charger runs its own logic and target power values from Homey are ignored; in
        // "homey" mode Homey is in control and the device does what it is told.
        //
        // This used to be logged and otherwise disregarded, which made the mode picker
        // decorative — Homey could show "Automatic" while the app acted on every value it
        // was handed. Honouring it costs nothing at the moment it matters: Homey sends the
        // mode together with the value whenever it takes control, which is precisely why
        // these three capabilities share one debounced listener.
        const previousMode = this.getCapabilityValue('target_power_mode');
        if (target_power_mode !== undefined) {
          this.log(`[Easee] target_power_mode → ${target_power_mode}`);
          // The documentation also asks that a switch back to device mode discard the
          // setpoint and resume internal logic. What is deliberately NOT done here is
          // yanking a session that is already running: this charger's automation lives in
          // the EMS device, which sets its own limit on the next decision anyway, and
          // cutting a car's charge because someone changed a picker would be its own bug.
          if (previousMode === 'homey' && target_power_mode !== 'homey') {
            this.log('[Easee] Homey handed control back; the running limit stands until the '
              + 'charger or the EMS sets its own');
          }
        }
        const effectiveMode = target_power_mode ?? previousMode ?? 'homey';

        // Explicit stop wins over everything else. This is the on/off switch rather than a
        // power target, so it is honoured in either mode.
        if (evcharger_charging === false) {
          await this.stopCharging();
          return;
        }

        // A watt target translates to an amp limit (0 / dead-zone → stop).
        if (target_power !== undefined && target_power !== null) {
          if (effectiveMode !== 'homey') {
            this.log(`[Easee] target_power ${target_power} W ignored — mode is `
              + `"${effectiveMode}", so the charger is in control`);
            return;
          }
          const amps = this._wattsToAmps(target_power);
          if (amps <= 0) {
            await this.stopCharging();
            return;
          }
          if (this._txnId && !this._autoStartBlocked) await this.setChargingLimit(amps);
          else await this.startCharging(amps);
          return;
        }

        // Plain start at the current/default limit.
        if (evcharger_charging === true) {
          await this.startCharging();
        }
      },
      500,
    );

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

    // A one-shot command behind a switch: the switch is what puts it on the tile as a quick
    // action. The listener used to ignore the value, and nothing turned the switch back off, so
    // after the first "charge now" the next tap — switching it off — started 16 A charging
    // again (review 2026-10-10). Only "on" acts now, and the switch goes back off by itself: a
    // standing "on" would claim an instant charge the EMS may already have turned down again.
    if (this.hasCapability('charge_now')) {
      this.registerCapabilityListener('charge_now', async (value) => {
        if (value !== true) return;
        try {
          await this.chargeNow();
        } finally {
          this._resetChargeNowSwitch();
        }
      });
    }

  }

  // ─── Flow conditions ──────────────────────────────────────────────────────
  //
  // These answer questions rather than issue commands, which this driver could not do at
  // all until now — it had ten triggers and eleven actions and no conditions, alone among
  // the drivers in this app. "Is the charger online" is the one that was most missed:
  // every one of those eleven actions fails on an offline charger, and there was no way to
  // ask first.
  //
  // Read through args.device, not `this`. The action cards above register once per device
  // instance and then filter on the id, which works for one charger and quietly stops
  // working for two — Homey keeps only the last run listener registered on a card, so the
  // survivor's filter rejects every other device. Taking the device from the arguments
  // needs no filter and is correct however many chargers exist.
  _registerFlowConditions() {
    this.homey.flow.getConditionCard('ocpp_charger_is_online')
      .registerRunListener(async (args) => !args.device.chargerOffline);

    this.homey.flow.getConditionCard('ocpp_is_charging')
      .registerRunListener(async (args) => args.device._chargingState() === 'charging');

    // Plugged in covers everything from the cable going in to it coming out: waiting for a
    // start, charging, paused, finished. 'error' means the charger stopped telling us, which
    // is not the same as an empty socket — and not proof of a cable either.
    this.homey.flow.getConditionCard('ocpp_car_is_plugged_in')
      .registerRunListener(async (args) => args.device._carPluggedIn());

    this.homey.flow.getConditionCard('ocpp_session_status_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('session_status') === args.status);
  }

  // ─── Flow actions ─────────────────────────────────────────────────────────

  _registerFlowActions() {
    // Every listener acts on args.device, never on `this`.
    //
    // These used to call the methods on `this` and guard with
    // `if (args.device.id !== this.id) return;`. That works for one charger and stops
    // working, silently, for two: Homey keeps only the LAST run listener registered on a
    // card, and each device registers over the previous one. The survivor's guard then
    // rejects every device except itself, so an action pointed at the other charger does
    // nothing at all — no error, no log line, just a Flow step that appears to succeed.
    //
    // Taking the device from the arguments removes the need for a guard: whichever
    // instance happened to register last, the listener operates on the charger the Flow
    // actually names. The registration is still per device, which is now harmless.
    this.homey.flow.getActionCard('ocpp_set_max_current')
      .registerRunListener(async (args) => args.device.setChargingLimitFromCard(Number(args.amperes)));

    this.homey.flow.getActionCard('ocpp_remote_start')
      .registerRunListener(async (args) => args.device.startCharging());

    this.homey.flow.getActionCard('ocpp_start_charging_at')
      .registerRunListener(async (args) => args.device.startCharging(args.amperes));

    this.homey.flow.getActionCard('ocpp_start_charging_at_phase')
      .registerRunListener(async (args) =>
        args.device.startCharging(args.amperes, parseInt(args.phases, 10)));

    this.homey.flow.getActionCard('ocpp_set_charging_limit_at_phase')
      .registerRunListener(async (args) =>
        args.device.setChargingLimit(args.amperes, parseInt(args.phases, 10)));

    this.homey.flow.getActionCard('ocpp_remote_stop')
      .registerRunListener(async (args) => args.device.stopCharging());

    this.homey.flow.getActionCard('ocpp_pause_charging')
      .registerRunListener(async (args) => args.device.pauseCharging());

    this.homey.flow.getActionCard('ocpp_resume_charging')
      .registerRunListener(async (args) => args.device.resumeCharging());

    this.homey.flow.getActionCard('ocpp_release_charger')
      .registerRunListener(async (args) => args.device.releaseCharger());

    this.homey.flow.getActionCard('ocpp_reboot_charger')
      .registerRunListener(async (args) => args.device.rebootCharger(args.type || 'Soft'));

    this.homey.flow.getActionCard('ocpp_charge_now')
      .registerRunListener(async (args) => args.device.chargeNow());
  }

  // ─── Capabilities management ─────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      // An optional capability that is switched off is handled below, not here — adding it
      // and removing it again on every start would churn the device for no reason.
      if (OPTIONAL_CAPABILITIES[cap] && !this._optionalWanted(cap)) continue;
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          this.log(`[Easee] Added capability: ${cap}`);
        } catch (err) {
          this.error(`addCapability(${cap}) failed:`, err.message);
        }
      }
    }
    await this._applyOptionalCapabilities();
  }

  // Defaults to on when the setting has never been written — an existing device that was
  // paired before the switch existed keeps the tile it already has.
  _optionalWanted(cap) {
    return this.getSetting(OPTIONAL_CAPABILITIES[cap]) !== false;
  }

  // Brings the device in line with the switches. Called at startup and whenever one of them
  // changes, so the tile appears and disappears without needing the device re-paired.
  async _applyOptionalCapabilities(settings) {
    for (const [cap, key] of Object.entries(OPTIONAL_CAPABILITIES)) {
      const wanted = settings ? settings[key] !== false : this._optionalWanted(cap);
      const has    = this.hasCapability(cap);
      if (wanted === has) continue;
      try {
        if (wanted) await this.addCapability(cap);
        else        await this.removeCapability(cap);
        this.log(`[Easee] ${wanted ? 'Added' : 'Removed'} optional capability: ${cap}`);
      } catch (err) {
        this.error(`${wanted ? 'add' : 'remove'}Capability(${cap}) failed:`, err.message);
      }
    }
  }

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    // Mirror the amp limit onto the standard `target_power` (W) capability so the
    // native EV tile/energy view reflects the setpoint. setCapabilityValue does not
    // re-trigger the capability listener, so this can't loop.
    if (capability === 'target_current' && this.hasCapability('target_power')) {
      const w = AMPS_TO_WATTS(value, this._getPhases());
      if (this.getCapabilityValue('target_power') !== w) {
        this.setCapabilityValue('target_power', w).catch(() => {});
      }
    }
    if (this.getCapabilityValue(capability) === value) return;
    try { await this.setCapabilityValue(capability, value); }
    catch (err) { this.log(`_set(${capability}, ${value}) failed:`, err.message); }
  }

  // ─── Session status capability ────────────────────────────────────────────

  // What the charger is doing, in this app's own words. Held in memory while running and
  // recovered from the Homey capability after a restart - which is why that capability has
  // to carry a value Homey will actually accept; see HOMEY_EV_STATE for why it did not.
  _chargingState() {
    if (this._internalChargingState) return this._internalChargingState;
    return INTERNAL_FROM_HOMEY[this.getCapabilityValue('evcharger_charging_state')] || 'idle';
  }

  // Writes both: this app's word is kept as it is, Homey's is translated. `homeyOverride`
  // lets a caller that knows more than the internal vocabulary can express - a paused
  // connector, say - pass the more precise enum value.
  async _setChargingState(internal, homeyOverride) {
    this._internalChargingState = internal;
    const homeyState = homeyOverride || HOMEY_EV_STATE[internal];
    if (homeyState) await this._set('evcharger_charging_state', homeyState);
  }

  // The last stop's reason, and whether it was the car finishing — see onStopTransaction. Both
  // survive a restart: a car left on the cable overnight still reads as full in the morning.
  async _setLastStop(reason, full = false) {
    this.lastStopReason = reason;
    this.lastStopFull   = full;
    await this.setStoreValue('lastStopReason', reason).catch(() => {});
    await this.setStoreValue('lastStopFull', full).catch(() => {});
  }

  _computeSessionStatus(chargingState, autoStartOverride) {
    if (this.chargerOffline) return 'offline';
    if (chargingState === 'error') return 'error';
    if (this.stitchedSession && this.stitchedSession.paused && chargingState !== 'idle') return 'paused';
    if (chargingState === 'charging') {
      if (this._lowPowerSince && (Date.now() - this._lowPowerSince) >= LOW_POWER_FINISH_MS) return 'finishing';
      return 'charging';
    }
    if (chargingState === 'idle') return 'not_connected';
    if (chargingState === 'connected') {
      if (this.lastStopFull) return 'fully_charged';
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
    const amps   = this._txnAmps || this.pendingStartAmps || parseInt(this.getSetting('default_charging_amps'), 10) || 16;
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

  // Convert a standard `target_power` (W) request into an amp limit for the phase count, as
  // Homey's EV charger documentation processes it (checked 2026-10-15): rounded DOWN to a
  // whole step — 5000 W is 4830 W, not 5520 W, so a surplus is never overshot — and inside
  // the dead zone idle. The dead zone is 6 A on every phase, the excludeMax that
  // _applyTargetPowerRange gives Homey; the other driver idles below 1380 W only and raises
  // 2000 W on three phases to 4140 W. This charger does not discharge: nothing below 0.
  _wattsToAmps(watts) {
    if (!Number.isFinite(watts) || watts <= 0) return 0;
    const amps = Math.floor(watts / (this._getPhases() * 230));
    if (amps < MIN_AMPS) return 0;
    return Math.min(amps, MAX_AMPS);
  }

  // ─── Hardware floor validation ────────────────────────────────────────────
  // The limit goes out in amperes per phase, so 6 A is the floor whatever the phase count.

  _validateProfileRequest(amps, requestedPhases) {
    const devicePhases = this._devicePhases();
    if (requestedPhases > devicePhases) {
      throw new Error(`This charger is configured as ${this._phaseLabel(devicePhases)} — a ${this._phaseLabel(requestedPhases)} profile can't be delivered on it.`);
    }
    this._refuseOtherPhases(requestedPhases);
    if (amps < 6) {
      throw new Error(`Below the 6A minimum charging current (IEC hardware floor) — ${amps}A ${this._phaseLabel(requestedPhases)} can't be delivered.`);
    }
  }

  // B (1.3.5): an Easee is not known to switch phases over OCPP. evcc offers no phase switching
  // for it — the charger takes amperes and names neither switching key — and Easee documents
  // none. If it ignores the count, "16 A on one phase" charges 16 A on three: 11 kW instead of
  // 3.7. Until a test shows otherwise, only the wired count is accepted, and it is checked
  // before anything is changed — a refused request must not leave its phase count behind.
  _refuseOtherPhases(requestedPhases) {
    const devicePhases = this._devicePhases();
    if ((requestedPhases === 1 || requestedPhases === 3) && requestedPhases !== devicePhases) {
      throw new Error(`An Easee does not switch phases over OCPP — this one is set to ${this._phaseLabel(devicePhases)}, `
        + `so a ${this._phaseLabel(requestedPhases)} limit is refused. Change "Number of phases" if the wiring differs.`);
    }
  }

  // A limit the charger refused is the caller's error: a flow card fails, the slider shows it,
  // and nothing reports a limit that is not in force. Until 1.3.6 the answer was logged and
  // "Charging limit set to 16A" followed — six times in Andi's log, every one Rejected.
  _assertAccepted(response, what) {
    const status = response && response.status;
    if (status && status !== 'Accepted') throw new Error(`The charger refused ${what} (${status})`);
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
      this.log(`[Easee] Timeline notification skipped (disabled): ${emoji} ${title}`);
      return;
    }
    try {
      this.log(`[Easee] Timeline: ${emoji} ${title} — ${text}`);
      await this.homey.notifications.createNotification({ excerpt: `${emoji} ${text}` });
    } catch (err) {
      this.log(`[Easee] Notification failed: ${err.message}`);
      try {
        if (this.homey.timeline && this.homey.timeline.createPost) {
          await this.homey.timeline.createPost({ text: `${emoji} ${text}` });
          this.log(`[Easee] Timeline posted (fallback): ${title}`);
        }
      } catch (err2) {
        this.log(`[Easee] Timeline fallback also failed: ${err2.message}`);
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
    // Every reading kept here, the store written at most every five minutes and on shutdown.
    // It was written for each measurand of each MeterValues — the whole map, about ten times
    // per message, every few seconds while charging — for a debug summary (review 2026-10-10).
    const now = Date.now();
    if (now - this._lastNonZeroSavedAt < LAST_NON_ZERO_SAVE_MS) return;
    this._lastNonZeroSavedAt = now;
    this.setStoreValue('lastNonZero', this._lastNonZero).catch((err) => {
      this.log(`[Easee] Failed to persist lastNonZero: ${err.message}`);
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
      charging:            cap('evcharger_charging'),
      txnId:               this._txnId,
      autoStartEnabled:    this.getSetting('auto_start_charging') !== false,
      isPaused:            this.isPaused,
      chargerVendor:       this.getSetting('charger_vendor') || 'Easee',
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

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(EaseeOcppDevice);

// Only _setCumulative from the shared set: this driver keeps its own _set (target_power mirror),
// and _setCumulative writes through whatever _set the device has.
EaseeOcppDevice.prototype._setCumulative = require('../../lib/capability-set')._setCumulative;

module.exports = EaseeOcppDevice;
