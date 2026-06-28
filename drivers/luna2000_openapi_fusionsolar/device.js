'use strict';

const { Device } = require('homey');

const DEV_TYPE_BATTERY     = 39; // Residential battery (LUNA2000)
const DEV_TYPE_BATTERY_ESS = 41; // C&I and utility ESS

const REQUIRED_CAPABILITIES = [
  'measure_power',    // battery power (W): positive = charging, negative = discharging
  'measure_battery',  // SoC (%)
];

const EXTRA_CAPABILITIES = [
  'measure_power.batt_charge',      // charge power (W, positive only)
  'measure_power.batt_discharge',   // discharge power (W, positive only)
  'measure_power.chargesetting',    // max charge power (W)
  'measure_power.dischargesetting', // max discharge power (W)
  'meter_power.today_batt_input',   // charged today (kWh)
  'meter_power.today_batt_output',  // discharged today (kWh)
  'measure_battery.soh',            // battery state of health (%)
  'openapi_battery_status',         // running state string
  'openapi_battery_mode',           // charge/discharge mode string
  'measure_voltage.battery',        // battery bus voltage (V)
  'meter_power.charged',            // total lifetime charged (kWh)
  'meter_power.discharged',         // total lifetime discharged (kWh)
  'battery_state_string',           // human-readable: "1234 W 🔺 73%"
  'openapi_working_mode_control',   // setable picker: working mode
];

// Removed capabilities — stripped from already-paired devices on init
const DEPRECATED_CAPABILITIES = [
  'measure_voltage.busbar',
  'meter_power.batt_rated',
  'openapi_battery_run_state',
];

const BATTERY_STATUS_MAP = {
  0: 'Offline',
  1: 'Standby',
  2: 'Running',
  3: 'Faulty',
  4: 'Hibernating',
};

const BATTERY_MODE_MAP = {
  0:  'None',
  1:  'Forced charge/discharge',
  2:  'Time-of-use price',
  3:  'Fixed charge/discharge',
  4:  'Automatic charge/discharge',
  5:  'Fully fed to grid',
  6:  'TOU',
  7:  'Remote scheduling – max. self-consumption',
  8:  'Remote scheduling – fully fed to grid',
  9:  'Remote scheduling – TOU',
  10: 'AI energy control',
  11: 'Remote control – AI energy control',
  12: 'Third-party dispatch',
};

class FusionSolarBatteryDevice extends Device {

  async onInit() {
    this.log(`Battery device initialised: ${this.getName()}`);
    this._prevSoc            = null;
    this._prevChargingState  = null;
    this._prevBatteryMode    = null;
    this._updatingFromApi    = false;
    await this._ensureCapabilities();
    this._registerConditionListeners();
    this._registerActionListeners();
    this._registerCapabilityListeners();
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    const stationChanged = changedKeys.includes('station_code');
    if (stationChanged) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode);
    } else if (changedKeys.some((k) => ['base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      this.homey.app.getCoordinator().settingsChanged(this);
    }
  }

  async onUninit()  { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  _registerConditionListeners() {
    this.homey.flow.getConditionCard('luna2000_is_charging')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_power') ?? 0) > 50);
    this.homey.flow.getConditionCard('luna2000_is_discharging')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_power') ?? 0) < -50);
    this.homey.flow.getConditionCard('luna2000_soc_above')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_battery') ?? 0) > args.soc);
    this.homey.flow.getConditionCard('luna2000_soc_below')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_battery') ?? 0) < args.soc);
  }

  _registerActionListeners() {
    const coord = () => this.homey.app.getCoordinator();

    // ─── Working Mode ─────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_set_working_mode')
      .registerRunListener(async ({ mode }) => {
        this.log(`OpenAPI: Set working mode to ${mode}`);
        await coord().sendBatteryModeTask(this, mode);
      });

    // ─── Force Charge until SoC ───────────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_start_force_charge')
      .registerRunListener(async ({ power, target_soc }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`OpenAPI: Force charge power=${powerW}W target SoC=${target_soc}%`);
        await coord().sendChargeDischargeTask(this, 1, {
          controlType: 1, targetSOC: target_soc, powerDispatch: powerW,
        });
      });

    // ─── Force Discharge until SoC ────────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_start_force_discharge')
      .registerRunListener(async ({ power, target_soc }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`OpenAPI: Force discharge power=${powerW}W stop at SoC=${target_soc}%`);
        await coord().sendChargeDischargeTask(this, 2, {
          controlType: 1, targetSOC: target_soc, powerDispatch: -powerW,
        });
      });

    // ─── Force Charge for duration ────────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_start_force_charge_duration')
      .registerRunListener(async ({ power, duration }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`OpenAPI: Force charge power=${powerW}W for ${duration} min`);
        await coord().sendChargeDischargeTask(this, 1, {
          controlType: 2, dispatchTime: Math.round(duration), powerDispatch: powerW,
        });
      });

    // ─── Force Discharge for duration ─────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_start_force_discharge_duration')
      .registerRunListener(async ({ power, duration }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`OpenAPI: Force discharge power=${powerW}W for ${duration} min`);
        await coord().sendChargeDischargeTask(this, 2, {
          controlType: 2, dispatchTime: Math.round(duration), powerDispatch: -powerW,
        });
      });

    // ─── Stop Force Charge/Discharge ──────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_stop_force_charge_discharge')
      .registerRunListener(async () => {
        this.log('OpenAPI: Stop force charge/discharge');
        await coord().sendChargeDischargeTask(this, 0);
      });

    // ─── Third-party Dispatch ─────────────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_dispatch_battery_power')
      .registerRunListener(async ({ power }) => {
        const w = Math.round(power);
        this.log(`OpenAPI: Dispatch battery power to ${w}W`);
        await coord().sendBatteryDispatchTask(this, w);
      });

    // ─── Battery Configuration ────────────────────────────────────────────────
    this.homey.flow.getActionCard('openapi_set_max_charge_power')
      .registerRunListener(async ({ power }) => {
        const w = Math.round(Math.max(200, power));
        this.log(`OpenAPI: Set max charge power to ${w}W`);
        await coord().sendBatteryConfigTask(this, { maximumChargePower: w });
      });

    this.homey.flow.getActionCard('openapi_set_max_discharge_power')
      .registerRunListener(async ({ power }) => {
        const w = Math.round(Math.max(200, power));
        this.log(`OpenAPI: Set max discharge power to ${w}W`);
        await coord().sendBatteryConfigTask(this, { maximumDischargePower: w });
      });

    this.homey.flow.getActionCard('openapi_set_end_of_charge_soc')
      .registerRunListener(async ({ soc }) => {
        const v = Math.max(90, Math.min(100, soc));
        this.log(`OpenAPI: Set end-of-charge SoC to ${v}%`);
        await coord().sendBatteryConfigTask(this, { endOfChargeSoc: v });
      });

    this.homey.flow.getActionCard('openapi_set_end_of_discharge_soc')
      .registerRunListener(async ({ soc }) => {
        const v = Math.max(0, Math.min(20, soc));
        this.log(`OpenAPI: Set end-of-discharge SoC to ${v}%`);
        await coord().sendBatteryConfigTask(this, { endOfDischargeSoc: v });
      });
  }

  _registerCapabilityListeners() {
    this.registerCapabilityListener('openapi_working_mode_control', async (value) => {
      if (this._updatingFromApi) return;
      this.log(`UI: Set working mode to ${value}`);
      await this.homey.app.getCoordinator().sendBatteryModeTask(this, value);
    });
  }

  // ─── Coordinator interface ─────────────────────────────────────────────────

  getDevTypes() { return [DEV_TYPE_BATTERY, DEV_TYPE_BATTERY_ESS]; }

  async onPollData({ kpiByType }) {
    // Use residential battery (39) if available, otherwise C&I ESS (41)
    const maps = (kpiByType[DEV_TYPE_BATTERY] || []).length
      ? kpiByType[DEV_TYPE_BATTERY]
      : kpiByType[DEV_TYPE_BATTERY_ESS] || [];

    if (!maps.length) return;

    const num     = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const avg     = (key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sumRndW = (key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
    };
    const sumKwh  = (key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };

    const battPowerW = sumRndW('ch_discharge_power'); // + = charging, − = discharging
    await this._set('measure_power',   battPowerW);
    await this._set('measure_battery', avg('battery_soc'));

    // Add extra capabilities dynamically on first successful fetch
    for (const cap of EXTRA_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
    }

    await this._set('measure_power.batt_charge',      battPowerW !== null ? Math.max(0,  battPowerW) : null);
    await this._set('measure_power.batt_discharge',   battPowerW !== null ? Math.max(0, -battPowerW) : null);
    await this._set('measure_power.chargesetting',    sumRndW('max_charge_power'));
    await this._set('measure_power.dischargesetting', sumRndW('max_discharge_power'));
    await this._set('meter_power.today_batt_input',   sumKwh('charge_cap'));
    await this._set('meter_power.today_batt_output',  sumKwh('discharge_cap'));

    await this._set('measure_battery.soh',            avg('battery_soh'));
    await this._set('measure_voltage.battery',       avg('busbar_u'));
    await this._set('meter_power.charged',           sumKwh('total_charged_energy'));
    await this._set('meter_power.discharged',        sumKwh('total_discharged_energy'));

    const battModeVal = num(maps[0].ch_discharge_model);
    if (battModeVal !== null) {
      await this._set('openapi_battery_mode', BATTERY_MODE_MAP[battModeVal] ?? `Mode ${battModeVal}`);
      const MODE_TO_ENUM = { 4: 'maximumSelfConsumption', 2: 'TOU', 6: 'TOU', 9: 'TOU', 12: 'thirdPartyDispatch' };
      const enumVal = MODE_TO_ENUM[battModeVal];
      if (enumVal) {
        this._updatingFromApi = true;
        await this._set('openapi_working_mode_control', enumVal);
        this._updatingFromApi = false;
      }
    }

    const battStatusVal = num(maps[0].battery_status);
    if (battStatusVal !== null) {
      await this._set('openapi_battery_status', BATTERY_STATUS_MAP[battStatusVal] ?? `State ${battStatusVal}`);
    }

    // battery_state_string — same logic as luna2000_modbus
    const soc = avg('battery_soc');
    const battPower = battPowerW ?? 0;
    if (soc !== null) {
      const IDLE_W = 50;
      let battLabel;
      let battLabelAlways = false;
      if (soc >= 100) {
        battLabel = 'Full'; battLabelAlways = true;
      } else if (soc < 5 && Math.abs(battPower) <= IDLE_W) {
        battLabel = 'Empty'; battLabelAlways = true;
      } else {
        battLabel = battPower < 0 ? '🔻' : '🔺';
      }
      const battWatts = Math.round(Math.abs(battPower));
      const battStr = battWatts === 0
        ? battLabelAlways ? `${battLabel} (${Math.round(soc)}%)` : `(${Math.round(soc)}%)`
        : `${battWatts} W ${battLabel} ${Math.round(soc)}%`;
      await this._set('battery_state_string', battStr);
    }

    // ─── Flow triggers ─────────────────────────────────────────────────────────
    if (soc !== null && soc !== this._prevSoc) {
      this._prevSoc = soc;
      await this.homey.flow
        .getDeviceTriggerCard('openapi_battery_soc_changed')
        .trigger(this, { soc })
        .catch((err) => this.log('Flow trigger openapi_battery_soc_changed failed:', err.message));
    }

    const IDLE_THRESHOLD_W = 50;
    const powerW = battPowerW ?? 0;
    const chargingState = powerW > IDLE_THRESHOLD_W ? 'charging'
      : powerW < -IDLE_THRESHOLD_W ? 'discharging'
      : 'idle';

    if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
      await this.homey.flow
        .getDeviceTriggerCard('openapi_battery_charging_state_changed')
        .trigger(this, { state: chargingState })
        .catch((err) => this.log('Flow trigger openapi_battery_charging_state_changed failed:', err.message));
      if (chargingState === 'charging') {
        this.homey.flow.getDeviceTriggerCard('luna2000_charging_started')
          .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_charging_started failed:', err.message));
      } else if (chargingState === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('luna2000_discharging_started')
          .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_discharging_started failed:', err.message));
      }
    }
    this._prevChargingState = chargingState;

    const battModeStr = this.getCapabilityValue('openapi_battery_mode');
    if (battModeStr !== null && this._prevBatteryMode !== null && battModeStr !== this._prevBatteryMode) {
      this.homey.flow.getDeviceTriggerCard('luna2000_working_mode_changed')
        .trigger(this, { mode: battModeStr })
        .catch((err) => this.log('Flow trigger luna2000_working_mode_changed failed:', err.message));
    }
    this._prevBatteryMode = battModeStr;
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
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

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = FusionSolarBatteryDevice;
