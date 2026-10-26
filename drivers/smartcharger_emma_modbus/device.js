'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const {
  SMARTCHARGER_REGISTERS,
  isSmartChargerDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, parseIntSafe, unavailableMessage, notRead, refused } = require('../../lib/modbus-client');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const modbusPolling = require('../../lib/modbus-polling');

const DEFAULT_INTERVAL_S = 30;
const MIN_INTERVAL_S     = 10;

// The three registers the charging state is derived from.
const VOLTAGES = ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage'];
// How many polls in a row the last state stands in for voltages that were not read. A flow
// card writing to another device on the same EMMA cuts a poll short, and a batch can time
// out on its own — one or two polls, not more. Past that the registers are not coming, and
// the state falls back to what it always was without them: unplugged.
const VOLTS_UNREAD_MAX_HELD = 3;

// The highest phase voltage the charger's register table allows ([0, 800] V). A higher one
// is not this charger's: on one EMMA's own unit, 30500–30505 hold its smart meter's status
// and voltages at gain 100, which read here at gain 10 as some 2300 V (log 2aafa4d3).
const MAX_PHASE_VOLTAGE = 800;

// The power is estimated from one step of the lifetime counter to a later one at least this
// far apart, never from one poll to the next. Measured on an EMMA (log 965c9d46, 2026-10-23):
// the counter moves in steps, so a 30 s poll caught either none (0 W) or two — 24 230 W, about
// 200 Wh in 30 s, while the whole house, car included, used 9–13 kW. Each end of a span is seen
// up to one poll late, and over two minutes and more those two delays largely cancel.
const POWER_MIN_SPAN_MS = 120_000;
// How long the last estimate stands without a step, as a multiple of the span it came from.
// Between two steps the car is still charging; past twice the usual wait it has stopped.
const POWER_HOLD_FACTOR = 2;

// Homey's evcharger_charging_state is a fixed enum and accepts only these five words:
// plugged_in_charging, plugged_in_discharging, plugged_in_paused, plugged_in, plugged_out.
// This driver used to write its own two, 'charging' and 'idle', and Homey rejected every
// one of them — so the capability was never set on any installation, and getWidgetStatus()
// read it back as null and reported "not connected" while a car was charging. The same
// mistake lived in the OCPP driver and was fixed there in 1.2.201.
//
// Only two of the five are reachable here, and that is a property of the hardware rather
// than a shortcut. This charger is read through the EMMA gateway, which offers voltage,
// power, temperature and a lifetime meter — and nothing that reports a connected cable
// while no current flows. A car waiting to start, or paused, therefore reads as unplugged.
// Guessing plugged_in instead would claim a cable no register ever mentioned.
const HOMEY_EV_STATE = {
  charging: 'plugged_in_charging',
  idle:     'plugged_out',
};

const REQUIRED_CAPABILITIES = [
  'measure_power',              // real-time charging power (W) — required by Homey evCharger
  // Read-only here (setable: false in app.json): this driver has no write path at all, and
  // a switch that cannot switch is worse than none. It is declared because Homey documents
  // it for EV chargers and generates the "is charging" Flow condition from it.
  'evcharger_charging',
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
    // counter delta; live watts are estimated from its steps (_estimatePower).
    this._sessionStartedAt     = null;
    this._sessionMeterStartKwh = null;
    this._lastMeterKwh         = null;
    this._meterStep            = null;   // { kWh, at }: the step the next estimate starts from
    this._lastStepAt           = null;
    this._powerBasis           = null;   // { kWh, spanMs }: what the current estimate came from
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

  async onSettings({ newSettings, changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._restartPolling(newSettings);
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
    // 0, like the three sibling EMMA drivers: this register block is answered by the EMMA,
    // not by the charger. The old default of 1 is the inverter's RS485 address behind an
    // EMMA, so it pointed the probe at the wrong device entirely.
    const modbusId = parseIntSafe(this.getSetting('modbus_id'), 0);

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

      // A name, and the rated power refused: the device answering is not the charger. Every
      // charger has a rated power at 30076 — the Tester will not confirm one without it — and
      // once read it is served from the nameplate cache, so only a unit that never had one
      // can refuse it poll after poll. The name was all the check above asks for, so a device
      // paired on the EMMA's own unit reported "Poll OK: state=idle" for good, with not one
      // value behind it (log f3b5238a).
      //
      // Until 1.3.7 it took every charger register refused, and that was not enough: one
      // EMMA answers 30500–30505 on its own unit with its smart meter's values, and the
      // device read those as phase voltages and showed "charging" with no car (log 2aafa4d3).
      // Counted like any failed poll, so one odd answer does not take the device down.
      if (refused(d, 'ratedPower')) {
        this._failureCount += 1;
        logPollError(this, `Not the charger (${this._failureCount}): unit ${modbusId} answers as "${d.offeringName}" `
          + 'and refuses the rated power (30076) every charger has', 'not-the-charger');
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.chargerIsEmma', { id: modbusId, name: d.offeringName }));
        }
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

      // A voltage the charger cannot have is not a reading of it (see MAX_PHASE_VOLTAGE): it
      // is neither shown nor taken for a cable, and counts as not read — the last state stands
      // for a few polls, as for any voltage that did not arrive.
      const implausible = VOLTAGES.filter((k) => typeof d[k] === 'number' && d[k] > MAX_PHASE_VOLTAGE);
      if (implausible.length) {
        if (!this._implausibleLogged) {
          this._implausibleLogged = true;
          this.log(`[SmartCharger] Ignoring phase voltage(s) above ${MAX_PHASE_VOLTAGE} V: `
            + implausible.map((k) => `${k}=${d[k]}`).join(', ') + ' — not this charger\'s registers');
        }
        for (const k of implausible) {
          d[k] = null;
          if (d.unread) d.unread.add(k);
        }
      }

      // Phase voltages (V)
      await this._set('measure_voltage.phase1', d.phaseAVoltage ?? null);
      await this._set('measure_voltage.phase2', d.phaseBVoltage ?? null);
      await this._set('measure_voltage.phase3', d.phaseCVoltage ?? null);

      // Total energy charged (kWh)
      await this._set('meter_power', d.totalEnergyCharged ?? null);

      // Live power estimate from the lifetime counter (no power register exists).
      // 0 W while not charging — see below.
      this._estimatePower(d.totalEnergyCharged, Date.now());

      // Charger temperature (°C)
      await this._set('measure_temperature', d.chargerTemperature ?? null);

      // Derive charging state from voltage presence:
      // If any phase voltage > 10 V, a car session is likely active
      const live = VOLTAGES.some((k) => (d[k] ?? 0) > 10);
      let chargingState = live ? 'charging' : 'idle';
      // A voltage that was not READ is not 0 V. `?? 0` made it one, so a poll cut short in
      // the middle of a charge read as the car being unplugged: "charging stopped" fired, the
      // session ended, and the next poll started both again — one charge, two sessions
      // (review 2026-10-10). The last state stands instead, for a few polls; null when there
      // is none yet, and then nothing below is touched. A register the EMMA says it does not
      // have (exception 2) is still 0 V, as before.
      let held = false;
      if (!live && notRead(d, ...VOLTAGES)) {
        this._voltsUnread = (this._voltsUnread || 0) + 1;
        if (this._voltsUnread <= VOLTS_UNREAD_MAX_HELD) {
          chargingState = this._prevChargingState;
          held = true;
        } else if (this._voltsUnread === VOLTS_UNREAD_MAX_HELD + 1) {
          this.log(`[SmartCharger] Phase voltages not read for ${this._voltsUnread} polls — taking the charger as unplugged`);
        }
      } else {
        this._voltsUnread = 0;
      }

      // measure_power: estimated while charging, 0 while idle. The next charge starts its
      // estimate afresh, rather than spreading its first step over the hours in between.
      if (chargingState === 'idle') {
        this._powerEstW  = 0;
        this._powerBasis = null;
        this._meterStep  = null;
      }
      await this._set('measure_power', this._powerEstW);

      if (chargingState !== null) {
        // This driver's own word drives everything below; Homey gets the translated one.
        await this._set('evcharger_charging_state', HOMEY_EV_STATE[chargingState]);
        await this._set('evcharger_charging', chargingState === 'charging');

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
      }

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      // The power and what it came from, so a log shows the counter's step size as well.
      const basis = this._powerBasis;
      logPollOk(this, 'Poll OK: state=' + (chargingState ?? 'unknown')
        + (held ? ` (voltages not read, ${this._voltsUnread}/${VOLTS_UNREAD_MAX_HELD} — last state kept)` : '')
        + `, P≈${this._powerEstW} W`
        + (basis ? ` (${+basis.kWh.toFixed(3)} kWh in ${Math.round(basis.spanMs / 1000)} s)` : '')
        + (d.totalEnergyCharged != null ? `, meter ${d.totalEnergyCharged} kWh` : ''));

    } catch (err) {
      this._failureCount += 1;
      logPollError(this, `Fetch error (${this._failureCount}): ${err.message}`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          unavailableMessage(this.homey, err, this.getSetting('address')),
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

  // ─── Power estimate ────────────────────────────────────────────────────────

  /**
   * Charging power from the lifetime counter, taken from one step of it to a later one.
   *
   * Until 1.3.6 it was the counter's rise from one poll to the next, which is only right for a
   * counter that moves on every poll. This one does not (see POWER_MIN_SPAN_MS): the estimate
   * jumped between 0 W and twice the real power, and the double looked enough like the PV
   * output that it was reported as the wrong register.
   *
   * Both ends of a span are steps, first seen at the poll after they happened, so the energy
   * between them is exact and only the timing is off — by at most one poll interval, against a
   * span of two minutes or more. The estimate stands between steps, and drops to 0 W once no
   * step has come for twice the span it was taken over. A reading that went missing changes
   * nothing; a counter that went back (replaced, reset) starts over.
   *
   * @param {number|null} kWh  the counter as read this poll
   * @param {number} now       ms
   */
  _estimatePower(kWh, now) {
    if (kWh === null || kWh === undefined) return;
    const prev = this._lastMeterKwh;
    this._lastMeterKwh = kWh;
    if (prev === null || prev === undefined || kWh < prev) {
      this._meterStep = null;
      return;
    }
    if (kWh > prev) {
      this._lastStepAt = now;
      const from = this._meterStep;
      // The first step seen is only where the measurement starts: when the counter moved
      // before it is not known.
      if (!from) { this._meterStep = { kWh, at: now }; return; }
      const spanMs = now - from.at;
      if (spanMs < POWER_MIN_SPAN_MS) return;
      this._powerEstW  = Math.round((kWh - from.kWh) * 1000 * 3_600_000 / spanMs);
      this._powerBasis = { kWh: kWh - from.kWh, spanMs };
      this._meterStep  = { kWh, at: now };
      return;
    }
    if (this._powerBasis && now - this._lastStepAt > POWER_HOLD_FACTOR * this._powerBasis.spanMs) {
      this._powerEstW  = 0;
      this._powerBasis = null;
      this._meterStep  = null;
    }
  }

  // ─── Widget API ────────────────────────────────────────────────────────────
  // Same shape as smartcharger_ocpp's getWidgetStatus() so the Charger Status
  // widget works with either driver. This driver has no OCPP session data:
  // no requested amps/limit, no pause — nulls degrade gracefully in the UI.

  getWidgetStatus() {
    // Compared against Homey's word, not this driver's. It used to read 'charging', which
    // the capability never held — every write of that value was rejected — so the widget
    // reported "not connected" throughout a live charging session.
    const state = this.getCapabilityValue('evcharger_charging_state');
    let sessionStatus;
    if (!this.getAvailable()) sessionStatus = 'offline';
    else if (state === HOMEY_EV_STATE.charging) sessionStatus = 'charging';
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

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(SmartChargerModbusDevice);

module.exports = SmartChargerModbusDevice;
