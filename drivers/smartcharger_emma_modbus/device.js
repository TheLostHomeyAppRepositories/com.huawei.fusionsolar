'use strict';

const { Device } = require('homey');
const {
  SMARTCHARGER_REGISTERS,
  isSmartChargerDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { logPollOk } = require('../../lib/poll-log');
const modbusPolling = require('../../lib/modbus-polling');

const DEFAULT_INTERVAL_S = 30;
const MIN_INTERVAL_S     = 10;

const REQUIRED_CAPABILITIES = [
  'measure_power',              // real-time charging power (W) — required by Homey evCharger
  'evcharger_charging_state',   // current charging state      — required by Homey evCharger
  'meter_power',                // total energy charged (kWh)
  'measure_voltage.phase1',     // Phase A voltage (V)
  'measure_voltage.phase2',     // Phase B voltage (V)
  'measure_voltage.phase3',     // Phase C voltage (V)
  'measure_temperature',        // charger temperature (°C)
  'smartcharger_rated_power',   // rated power (kW) — static spec value
  'smartcharger_offering_name', // product name — read from register 30000
];

class SmartChargerModbusDevice extends Device {

  async onInit() {
    this.log(`[SmartCharger] Device initialised: ${this.getName()}`);
    this._failureCount      = 0;
    this._prevChargingState = null;
    this._lastPollStart     = 0;

    // ── Session tracking (for the Charger Status widget) ──────────────────
    // No session registers exist — a "session" is the span the derived
    // charging state stays 'charging'. Energy comes from the lifetime
    // counter delta; live watts are estimated from that same delta.
    this._sessionStartedAt     = null;
    this._sessionMeterStartKwh = null;
    this._lastMeterKwh         = null;
    this._lastMeterAt          = null;
    this._powerEstW            = 0;
    try {
      const sess = await this.getStoreValue('mbSession');
      if (sess && sess.startedAt) {
        this._sessionStartedAt     = sess.startedAt;
        this._sessionMeterStartKwh = sess.meterStartKwh ?? null;
        this.log(`[SmartCharger] Restored session: started ${new Date(sess.startedAt).toISOString()}`);
      }
    } catch (e) { /* ignore */ }

    await this._ensureCapabilities();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  // Poll timing for the shared mixin (lib/modbus-polling). Declared per driver, not
  // in the mixin, because the interval genuinely differs between device families.
  get pollDefaultS() { return DEFAULT_INTERVAL_S; }
  get pollMinS()     { return MIN_INTERVAL_S; }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;
    this._lastPollStart = Date.now();

    const address = this.getSetting('address');
    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseIntSafe(this.getSetting('modbus_id'), 1);

    try {
      const d = await readModbusRegisters(address, port, modbusId, SMARTCHARGER_REGISTERS);

      if (!isSmartChargerDataValid(d)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.chargerNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // Offering name — only update if it changed and is non-empty
      if (d.offeringName) {
        await this._set('smartcharger_offering_name', d.offeringName);
      }

      // Rated power (kW) — static spec value
      if (d.ratedPower !== null && d.ratedPower !== undefined) {
        await this._set('smartcharger_rated_power', d.ratedPower);
      }

      // Phase voltages (V)
      await this._set('measure_voltage.phase1', d.phaseAVoltage ?? null);
      await this._set('measure_voltage.phase2', d.phaseBVoltage ?? null);
      await this._set('measure_voltage.phase3', d.phaseCVoltage ?? null);

      // Total energy charged (kWh)
      await this._set('meter_power', d.totalEnergyCharged ?? null);

      // Live power estimate from the lifetime-counter delta (no power
      // register exists). Counter resolution is 1 Wh, poll ≥10 s →
      // ±~120 W accuracy at 30 s polls. 0 W while not charging.
      const nowTs = Date.now();
      if (d.totalEnergyCharged != null && this._lastMeterKwh != null && this._lastMeterAt) {
        const dtMs = nowTs - this._lastMeterAt;
        if (dtMs > 0) {
          const deltaWh = (d.totalEnergyCharged - this._lastMeterKwh) * 1000;
          this._powerEstW = Math.max(0, Math.round(deltaWh * 3_600_000 / dtMs));
        }
      }
      if (d.totalEnergyCharged != null) {
        this._lastMeterKwh = d.totalEnergyCharged;
        this._lastMeterAt  = nowTs;
      }

      // Charger temperature (°C)
      await this._set('measure_temperature', d.chargerTemperature ?? null);

      // Derive charging state from voltage presence:
      // If any phase voltage > 10 V, a car session is likely active
      const hasVoltage = (d.phaseAVoltage ?? 0) > 10
        || (d.phaseBVoltage ?? 0) > 10
        || (d.phaseCVoltage ?? 0) > 10;
      const chargingState = hasVoltage ? 'charging' : 'idle';
      await this._set('evcharger_charging_state', chargingState);

      // measure_power: estimated while charging, 0 while idle
      if (chargingState !== 'charging') this._powerEstW = 0;
      await this._set('measure_power', this._powerEstW);

      if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
        if (chargingState === 'charging') {
          this.homey.flow.getDeviceTriggerCard('smartcharger_charging_started')
            .trigger(this, {}).catch((err) => this.log('Flow trigger smartcharger_charging_started failed:', err.message));
        } else {
          this.homey.flow.getDeviceTriggerCard('smartcharger_charging_stopped')
            .trigger(this, {}).catch((err) => this.log('Flow trigger smartcharger_charging_stopped failed:', err.message));
        }
      }

      // Session anchors for the widget: set on idle→charging, cleared on charging→idle
      if (chargingState === 'charging' && !this._sessionStartedAt) {
        this._sessionStartedAt     = Date.now();
        this._sessionMeterStartKwh = d.totalEnergyCharged ?? null;
        await this.setStoreValue('mbSession', { startedAt: this._sessionStartedAt, meterStartKwh: this._sessionMeterStartKwh }).catch(() => {});
        this.log('[SmartCharger] Session started');
      } else if (chargingState !== 'charging' && this._sessionStartedAt) {
        this._sessionStartedAt     = null;
        this._sessionMeterStartKwh = null;
        await this.setStoreValue('mbSession', null).catch(() => {});
        this.log('[SmartCharger] Session ended');
      }
      this._prevChargingState = chargingState;

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, 'Poll OK: state=' + chargingState);

    } catch (err) {
      this._failureCount += 1;
      this.error(`Fetch error (${this._failureCount}):`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          unavailableMessage(this.homey, err, this.getSetting('address')),
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

  // ─── Widget API ────────────────────────────────────────────────────────────
  // Same shape as smartcharger_ocpp's getWidgetStatus() so the Charger Status
  // widget works with either driver. This driver has no OCPP session data:
  // no requested amps/limit, no pause — nulls degrade gracefully in the UI.

  getWidgetStatus() {
    const state = this.getCapabilityValue('evcharger_charging_state');
    let sessionStatus;
    if (!this.getAvailable()) sessionStatus = 'offline';
    else if (state === 'charging') sessionStatus = 'charging';
    else sessionStatus = 'not_connected';

    // Active phase count from voltage presence (1P or 3P wiring)
    const volts = [
      this.getCapabilityValue('measure_voltage.phase1'),
      this.getCapabilityValue('measure_voltage.phase2'),
      this.getCapabilityValue('measure_voltage.phase3'),
    ].filter((v) => typeof v === 'number' && v > 10);
    const phases = volts.length || 3;

    const powerW = this.getCapabilityValue('measure_power') || 0;
    // Estimated current from power (no current registers exist)
    const currentA = powerW > 0 ? powerW / (phases * 230) : null;

    let sessionEnergyWh = null;
    if (this._sessionStartedAt && this._sessionMeterStartKwh != null) {
      const meterNow = this.getCapabilityValue('meter_power');
      if (meterNow != null) sessionEnergyWh = Math.max(0, Math.round((meterNow - this._sessionMeterStartKwh) * 1000));
    }

    return {
      sessionStatus,
      sessionOwner:     null,
      isPaused:         false,
      requestedAmps:    null,
      limitKw:          null,
      phases,
      phaseLabel:       phases === 1 ? 'Mono-Phase' : phases === 2 ? 'Bi-Phase' : 'Tri-Phase',
      powerW,
      currentA,
      sessionStartTime: this._sessionStartedAt,
      sessionEnergyWh,
    };
  }

}

Object.assign(SmartChargerModbusDevice.prototype, modbusPolling);

module.exports = SmartChargerModbusDevice;
