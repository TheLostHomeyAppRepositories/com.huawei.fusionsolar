'use strict';

const { Device } = require('homey');
const {
  BATTERY_REGISTERS,
  BATTERY_MODULE_REGISTERS,
  CONTROL_REGISTERS,
  isBatteryDataValid,
  isBatteryAbsent,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister, writeModbusU32, parseIntSafe } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

// Capabilities removed in previous versions — cleaned up on init
const DEPRECATED_CAPABILITIES = [
  'luna2000_unit1_status', // renamed to luna2000_battery_status
];

const UNIT1_STATUS_MAP = {
  0: 'Offline',
  1: 'Standby',
  2: 'Running',
  3: 'Fault',
  4: 'Sleep mode',
};

// Battery module slot keys — used to count installed packs from BATTERY_MODULE_REGISTERS
const BATTERY_MODULE_KEYS = ['unit1Pack1', 'unit1Pack2', 'unit1Pack3', 'unit2Pack1', 'unit2Pack2', 'unit2Pack3'];

// Maps storage working mode register value → human-readable label (used as flow trigger token)
const STORAGE_WORKING_MODE_LABELS = {
  '0': 'Adaptive',
  '1': 'Fixed Charge/Discharge',
  '2': 'Maximise Self-Consumption',
  '3': 'Time of Use (LG)',
  '4': 'Fully Fed to Grid',
  '5': 'Time of Use (LUNA2000)',
  '6': 'Third-party Scheduling',
};

const EXCESS_PV_LABELS = {
  '0': 'Feed to Grid',
  '1': 'Charge Battery',
};

const REMOTE_MODE_LABELS = {
  '0': 'Local Control',
  '1': 'Remote: Max Self-Consumption',
  '2': 'Remote: Fully Fed to Grid',
  '3': 'Remote: Time of Use',
  '4': 'Remote: AI Control',
  '5': 'Remote: Three-party Scheduling',
};

// All battery capabilities are always present (device IS a LUNA2000)
const REQUIRED_CAPABILITIES = [
  'measure_power',           // combined W: positive = charging, negative = discharging
  'measure_battery',         // SoC 0-100 %
  'meter_power.charged',     // lifetime total charged (kWh) – used by Homey energy dashboard
  'meter_power.discharged',  // lifetime total discharged (kWh) – used by Homey energy dashboard
  'measure_power.batt_charge',
  'measure_power.batt_discharge',
  'measure_power.chargesetting',
  'measure_power.dischargesetting',
  'meter_power.today_batt_input',
  'meter_power.today_batt_output',
  'luna2000_battery_status',
  'storage_working_mode_settings',
  'storage_force_charge_discharge',
  'storage_excess_pv_energy_use_in_tou',
  'remote_charge_discharge_control_mode',
  'measure_battery_modules',
  'luna2000_unit1_installed',
  'luna2000_unit2_installed',
  'battery_state_string',        // human-readable state: "1234 W Laden (73%)" — hidden in UI
  // software version capabilities are added/removed dynamically based on register response
];

// Only the battery-related control registers
const STORAGE_CONTROL_REGISTERS = {
  storageWorkingMode:               CONTROL_REGISTERS.storageWorkingMode,
  storageForceChargeDischarge:      CONTROL_REGISTERS.storageForceChargeDischarge,
  storageExcessPvEnergyUseInTou:    CONTROL_REGISTERS.storageExcessPvEnergyUseInTou,
  remoteChargeDischargeControlMode: CONTROL_REGISTERS.remoteChargeDischargeControlMode,
  storageMaxChargePower:            CONTROL_REGISTERS.storageMaxChargePower,
  storageMaxDischargePower:         CONTROL_REGISTERS.storageMaxDischargePower,
  storageChargingCutoffCapacity:    CONTROL_REGISTERS.storageChargingCutoffCapacity,
  storageDischargeCutoffCapacity:   CONTROL_REGISTERS.storageDischargeCutoffCapacity,
  storageChargeFromGrid:            CONTROL_REGISTERS.storageChargeFromGrid,
  storageGridChargeCutoffSoc:       CONTROL_REGISTERS.storageGridChargeCutoffSoc,
  storageGridChargePower:           CONTROL_REGISTERS.storageGridChargePower,
  storageBackupPowerSoc:            CONTROL_REGISTERS.storageBackupPowerSoc,
  storageUnit1No:                   CONTROL_REGISTERS.storageUnit1No,
  storageUnit2No:                   CONTROL_REGISTERS.storageUnit2No,
};

// Maps writable enum capability → Modbus register address (47xxx)
const CONTROL_WRITE_MAP = {
  storage_working_mode_settings:        47086,
  storage_force_charge_discharge:       47100,
  storage_excess_pv_energy_use_in_tou:  47299,
  remote_charge_discharge_control_mode: 47589,
};

class LUNA2000ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevChargingState         = null;
    this._prevBatteryStatus         = null;
    this._prevWorkingMode           = null;
    this._prevExcessPv              = null;
    this._prevRemoteMode            = null;
    this._batteryModuleCount        = null;  // tracks last known module count for setEnergy
    this._batteryModulesInitialized = false; // true once a non-zero module count has been read and locked
    this._failureCount              = 0;
    this._updatingFromModbus        = false;
    this._updatingSettingFromModbus = false;
    this._writeInProgress           = false;
    this._settingsInitialized       = false; // true after first successful _fetchControl
    this._controlPollCounter        = 4;     // start at 4 so first poll immediately reads control registers
    this._forceTimer                = null;  // pending auto-stop timer for timed force charge/discharge
    this._pendingForceMode          = null;  // set after a force charge/discharge write; cleared once poll confirms
    this._lastPollStart             = 0;
    await this._ensureCapabilities();
    this._registerControlListeners();
    this._registerFlowActions();
    this._registerConditions();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }

    if (!this._updatingSettingFromModbus && this._settingsInitialized) {
      const address  = this.getSetting('address');
      const port     = parseInt(this.getSetting('port'), 10) || 502;
      const modbusId = parseIntSafe(this.getSetting('modbus_id'), 1);

      if (changedKeys.includes('charge_from_grid')) {
        const raw = newSettings.charge_from_grid ? 1 : 0;
        this.log(`Write charge_from_grid: ${raw} → reg 47087`);
        writeModbusRegister(address, port, modbusId, 47087, raw)
          .catch((err) => this.error('charge_from_grid write failed:', err.message));
      }

      const socSettings = {
        grid_charge_cutoff_soc:   { reg: 47088, scale: 10, u32: false },
        charging_cutoff_capacity: { reg: 47081, scale: 10, u32: false },
        discharge_cutoff_capacity:{ reg: 47082, scale: 10, u32: false },
        backup_power_soc:         { reg: 47102, scale: 10, u32: false },
      };
      for (const [key, { reg, scale, u32 }] of Object.entries(socSettings)) {
        if (changedKeys.includes(key)) {
          // Homey renders 0 as a blank number field — treat blank (null/NaN) as 0
          const val = parseFloat(newSettings[key]);
          const raw = Math.round((Number.isFinite(val) ? val : 0) * scale);
          this.log(`Write ${key}: ${newSettings[key]} → reg ${reg} raw=${raw}`);
          (u32 ? writeModbusU32 : writeModbusRegister)(address, port, modbusId, reg, raw)
            .catch((err) => this.error(`${key} write failed:`, err.message));
        }
      }

      const wattSettings = {
        max_charge_power:     { reg: 47075 },
        max_discharge_power:  { reg: 47077 },
      };
      for (const [key, { reg }] of Object.entries(wattSettings)) {
        if (changedKeys.includes(key)) {
          const raw = Math.round(parseFloat(newSettings[key]) || 0);
          this.log(`Write ${key}: ${raw} W → reg ${reg}`);
          writeModbusU32(address, port, modbusId, reg, raw)
            .catch((err) => this.error(`${key} write failed:`, err.message));
        }
      }

      // Register 47242 (active grid charge power set point) requires Charge from Grid
      // (47087) to be enabled — otherwise the inverter ignores the write.
      if (changedKeys.includes('max_grid_charge_power')) {
        const raw = Math.round(parseFloat(newSettings.max_grid_charge_power) || 0);
        this.log(`Write max_grid_charge_power: ${raw} W → reg 47242 (ensuring charge_from_grid enabled first)`);
        const ensureEnabled = !this.getSetting('charge_from_grid')
          ? writeModbusRegister(address, port, modbusId, 47087, 1)
              .then(() => {
                this._updatingSettingFromModbus = true;
                return this.setSettings({ charge_from_grid: true })
                  .catch(() => {})
                  .finally(() => { this._updatingSettingFromModbus = false; });
              })
          : Promise.resolve();
        ensureEnabled
          .then(() => writeModbusU32(address, port, modbusId, 47242, raw))
          .catch((err) => this.error('max_grid_charge_power write failed:', err.message));
      }
    }
  }

  async onUninit() {
    if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
    await this._stopPolling();
  }

  async onDeleted() {
    if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
    await this._stopPolling();
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

  _registerControlListeners() {
    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseIntSafe(this.getSetting('modbus_id'), 1);

    for (const [cap, regAddress] of Object.entries(CONTROL_WRITE_MAP)) {
      this.registerCapabilityListener(cap, (value) => {
        if (this._updatingFromModbus) return; // ignore updates triggered by poll reads

        const previousValue = this.getCapabilityValue(cap);
        this.log(`Write start  [${cap} → reg ${regAddress}] value=${value}`);
        this._writeInProgress = true;

        // Fire-and-forget: return immediately so Homey never shows a UI timeout.
        // On failure the capability is reverted to its previous value.
        writeModbusRegister(host(), port(), unitId(), regAddress, parseInt(value, 10))
          .then(() => {
            this.log(`Write OK     [${cap} → reg ${regAddress}]`);
          })
          .catch(async (err) => {
            this.error(`Write failed [${cap} → reg ${regAddress}]:`, err.message);
            this._updatingFromModbus = true;
            await this._set(cap, previousValue).catch(() => {});
            this._updatingFromModbus = false;
          })
          .finally(() => {
            this._writeInProgress = false;
          });
      });
    }
  }

  // ─── Flow actions ──────────────────────────────────────────────────────────

  _registerFlowActions() {
    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseIntSafe(this.getSetting('modbus_id'), 1);

    const writeEnum = (cardId, capabilityId, mode) => {
      const reg   = CONTROL_WRITE_MAP[capabilityId];
      const value = parseInt(mode, 10);
      this.log(`Write start  [${cardId} → reg ${reg}] value=${value}`);
      this._writeInProgress = true;
      // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
      (async () => {
        try {
          await writeModbusRegister(host(), port(), unitId(), reg, value);
          this.log(`Write OK     [${cardId} → reg ${reg}]`);
          this._updatingFromModbus = true;
          await this._set(capabilityId, mode).catch(() => {});
        } catch (err) {
          this.error(`Write failed [${cardId} → reg ${reg}]:`, err.message);
        } finally {
          this._updatingFromModbus = false;
          this._writeInProgress   = false;
        }
      })();
    };

    this.homey.flow
      .getActionCard('luna2000_set_working_mode')
      .registerRunListener(({ mode }) =>
        writeEnum('luna2000_set_working_mode', 'storage_working_mode_settings', mode));

    this.homey.flow
      .getActionCard('luna2000_set_excess_pv')
      .registerRunListener(({ mode }) =>
        writeEnum('luna2000_set_excess_pv', 'storage_excess_pv_energy_use_in_tou', mode));

    this.homey.flow
      .getActionCard('luna2000_set_remote_mode')
      .registerRunListener(({ mode }) =>
        writeEnum('luna2000_set_remote_mode', 'remote_charge_discharge_control_mode', mode));

    this.homey.flow
      .getActionCard('luna2000_set_force_charge_discharge')
      .registerRunListener(({ mode }) =>
        writeEnum('luna2000_set_force_charge_discharge', 'storage_force_charge_discharge', mode));

    this.homey.flow
      .getActionCard('luna2000_start_force_charge')
      .registerRunListener(({ device, power, target_soc }) => {
        const h = host(), p = port(), u = unitId();
        const maxChargeW = this.getSetting('max_charge_power') || 5000;
        const powerW  = Math.round(Math.min(Math.max(0, power), maxChargeW));
        const socRaw  = Math.round(Math.max(0, Math.min(50, target_soc)) * 10);
        const already = this.getCapabilityValue('storage_force_charge_discharge') === '1';
        this.log(`Force charge: power=${powerW} W, target SoC=${target_soc}% (raw ${socRaw})${already ? ' [already in force-charge mode]' : ''}`);
        this._writeInProgress = true;
        this._pendingForceMode = { direction: 'charging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        // Each register is written independently: a failure on one does not skip the rest.
        // The mode write (47100) is the most critical and always attempted last.
        (async () => {
          let anyFail = false;
          try {
            await writeModbusU32(h, p, u, 47247, powerW);
          } catch (err) { this.error('Force charge: power write failed:', err.message); anyFail = true; }
          try {
            await writeModbusRegister(h, p, u, 47101, socRaw);
          } catch (err) { this.error('Force charge: SOC write failed:', err.message); anyFail = true; }
          if (!already) {
            try {
              await writeModbusRegister(h, p, u, 47100, 1);
            } catch (err) { this.error('Force charge: mode write failed:', err.message); anyFail = true; }
          }
          this.log(anyFail ? 'Force charge command sent (with partial write failures)' : 'Force charge command sent');
          this._writeInProgress = false;
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_start_force_discharge')
      .registerRunListener(({ device, power }) => {
        const h = host(), p = port(), u = unitId();
        const maxDischargeW = this.getSetting('max_discharge_power') || 5000;
        const powerW  = Math.round(Math.min(Math.max(0, power), maxDischargeW));
        const already = this.getCapabilityValue('storage_force_charge_discharge') === '2';
        this.log(`Force discharge: power=${powerW} W${already ? ' [already in force-discharge mode]' : ''}`);
        this._writeInProgress = true;
        this._pendingForceMode = { direction: 'discharging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        // Reg 47082 (persistent Discharge Cutoff Capacity) is NOT written here — the firmware
        // rejects or times out writes to that register during force-discharge activation.
        // Use luna2000_set_discharge_cutoff_soc to configure the cutoff separately beforehand.
        // Reg 47247 = max charge power; reg 47249 = max discharge power (separate registers).
        (async () => {
          let anyFail = false;
          try {
            await writeModbusU32(h, p, u, 47249, powerW);
          } catch (err) { this.error('Force discharge: power write failed:', err.message); anyFail = true; }
          if (!already) {
            try {
              await writeModbusRegister(h, p, u, 47100, 2);
            } catch (err) { this.error('Force discharge: mode write failed:', err.message); anyFail = true; }
          }
          this.log(anyFail ? 'Force discharge command sent (with partial write failures)' : 'Force discharge command sent');
          this._writeInProgress = false;
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_start_force_charge_duration')
      .registerRunListener(({ device, power, duration }) => {
        const h = host(), p = port(), u = unitId();
        const maxChargeW = this.getSetting('max_charge_power') || 5000;
        const powerW     = Math.round(Math.min(Math.max(0, power), maxChargeW));
        const durationMs = Math.round(Math.max(1, duration) * 60 * 1000);
        const already    = this.getCapabilityValue('storage_force_charge_discharge') === '1';
        this.log(`Force charge for ${duration} min: power=${powerW} W${already ? ' [already in force-charge mode]' : ''}`);
        if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
        this._writeInProgress = true;
        this._pendingForceMode = { direction: 'charging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(h, p, u, 47247, powerW);
            if (!already) await writeModbusRegister(h, p, u, 47100, 1);
            this.log('Force charge (timed) command sent');
            this._forceTimer = this.homey.setTimeout(async () => {
              this._forceTimer = null;
              try {
                await writeModbusRegister(h, p, u, 47100, 0);
                this.log(`Force charge auto-stopped after ${duration} min`);
              } catch (err) {
                this.error('Force charge auto-stop failed:', err.message);
              }
            }, durationMs);
          } catch (err) {
            this.error('Force charge (timed) failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_start_force_discharge_duration')
      .registerRunListener(({ device, power, duration }) => {
        const h = host(), p = port(), u = unitId();
        const maxDischargeW = this.getSetting('max_discharge_power') || 5000;
        const powerW     = Math.round(Math.min(Math.max(0, power), maxDischargeW));
        const durationMs = Math.round(Math.max(1, duration) * 60 * 1000);
        const already    = this.getCapabilityValue('storage_force_charge_discharge') === '2';
        this.log(`Force discharge for ${duration} min: power=${powerW} W${already ? ' [already in force-discharge mode]' : ''}`);
        if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
        this._writeInProgress = true;
        this._pendingForceMode = { direction: 'discharging', powerW, sentAt: Date.now() };
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(h, p, u, 47249, powerW);
            if (!already) await writeModbusRegister(h, p, u, 47100, 2);
            this.log('Force discharge (timed) command sent');
            this._forceTimer = this.homey.setTimeout(async () => {
              this._forceTimer = null;
              try {
                await writeModbusRegister(h, p, u, 47100, 0);
                this.log(`Force discharge auto-stopped after ${duration} min`);
              } catch (err) {
                this.error('Force discharge auto-stop failed:', err.message);
              }
            }, durationMs);
          } catch (err) {
            this.error('Force discharge (timed) failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_force_charge_power')
      .registerRunListener(({ device, power }) => {
        const maxChargeW = this.getSetting('max_charge_power') || 5000;
        const powerW = Math.round(Math.min(Math.max(0, power), maxChargeW));
        this.log(`Set force charge power: ${powerW} W`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47247, powerW);
            this.log('Force charge power written');
          } catch (err) {
            this.error('Set force charge power failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_charge_from_grid')
      .registerRunListener(({ device, mode }) => {
        const value = parseInt(mode, 10);
        this.log(`Set charge from grid: ${value === 1 ? 'Enable' : 'Disable'} (reg 47087)`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47087, value);
            this.log('Charge from grid written');
          } catch (err) {
            this.error('Set charge from grid failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_grid_charge_cutoff_soc')
      .registerRunListener(({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(20, Math.min(100, target_soc)) * 10);
        this.log(`Set grid charge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47088)`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47088, socRaw);
            this.log('Grid charge cutoff SoC written');
          } catch (err) {
            this.error('Set grid charge cutoff SoC failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_max_charge_power')
      .registerRunListener(({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set max charge power: ${powerW} W → reg 47075`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47075, powerW);
            this.log('Max charge power written');
            this._updatingSettingFromModbus = true;
            await this.setSettings({ max_charge_power: powerW }).catch(() => {});
            this._updatingSettingFromModbus = false;
          } catch (err) {
            this.error('Set max charge power failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_max_discharge_power')
      .registerRunListener(({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set max discharge power: ${powerW} W → reg 47077`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47077, powerW);
            this.log('Max discharge power written');
            this._updatingSettingFromModbus = true;
            await this.setSettings({ max_discharge_power: powerW }).catch(() => {});
            this._updatingSettingFromModbus = false;
          } catch (err) {
            this.error('Set max discharge power failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_force_charge_soc')
      .registerRunListener(({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(50, target_soc)) * 10);
        this.log(`Set force charge target SoC: ${target_soc}% (raw ${socRaw})`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47101, socRaw);
            this.log('Force charge target SoC written');
          } catch (err) {
            this.error('Set force charge SoC failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_grid_charge_power')
      .registerRunListener(({ device, power }) => {
        const raw = Math.round(Math.max(0, parseFloat(power) || 0));
        this.log(`Set grid charge power: ${raw} W → reg 47242`);
        this._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47242, raw);
            this.log('Grid charge power written');
            this._updatingSettingFromModbus = true;
            await this.setSettings({ max_grid_charge_power: raw }).catch(() => {});
          } catch (err) {
            this.error('Set grid charge power failed:', err.message);
          } finally {
            this._updatingSettingFromModbus = false;
            this._writeInProgress           = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_charge_cutoff_soc')
      .registerRunListener(({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(90, Math.min(100, target_soc)) * 10);
        this.log(`Set charge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47081)`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47081, socRaw);
            this.log('Charge cutoff SoC written');
          } catch (err) {
            this.error('Set charge cutoff SoC failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_discharge_cutoff_soc')
      .registerRunListener(({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(12, Math.min(20, target_soc)) * 10);
        this.log(`Set discharge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47082)`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47082, socRaw);
            this.log('Discharge cutoff SoC written');
          } catch (err) {
            this.error('Set discharge cutoff SoC failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_backup_reserve_soc')
      .registerRunListener(({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(50, target_soc)) * 10);
        this.log(`Set backup reserve SoC: ${target_soc}% (raw ${socRaw}, reg 47102)`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47102, socRaw);
            this.log('Backup reserve SoC written');
          } catch (err) {
            this.error('Set backup reserve SoC failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_max_grid_charge_power')
      .registerRunListener(({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set max grid charge power: ${powerW} W → reg 47244`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47244, powerW);
            this.log('Max grid charge power written');
          } catch (err) {
            this.error('Set max grid charge power failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_force_discharge_power')
      .registerRunListener(({ device, power }) => {
        const maxDischargeW = this.getSetting('max_discharge_power') || 5000;
        const powerW = Math.round(Math.min(Math.max(0, power), maxDischargeW));
        this.log(`Set force discharge power: ${powerW} W → reg 47249`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47249, powerW);
            this.log('Force discharge power written');
          } catch (err) {
            this.error('Set force discharge power failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_power_limit_grid')
      .registerRunListener(({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set grid-tied power limit: ${powerW} W → reg 47079`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47079, powerW);
            this.log('Grid-tied power limit written');
          } catch (err) {
            this.error('Set grid-tied power limit failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_backup_offgrid')
      .registerRunListener(({ device, mode }) => {
        const value = parseInt(mode, 10);
        this.log(`Set backup off-grid: ${value === 1 ? 'Enable' : 'Disable'} (reg 47604)`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47604, value);
            this.log('Backup off-grid written');
          } catch (err) {
            this.error('Set backup off-grid failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_capacity_control_mode')
      .registerRunListener(({ device, mode }) => {
        const value = parseInt(mode, 10);
        this.log(`Set capacity control mode: ${value} (reg 47954)`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47954, value);
            this.log('Capacity control mode written');
          } catch (err) {
            this.error('Set capacity control mode failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });

    this.homey.flow
      .getActionCard('luna2000_set_capacity_control_soc')
      .registerRunListener(({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(50, target_soc)) * 10);
        this.log(`Set capacity control peak-shaving SoC: ${target_soc}% (raw ${socRaw}, reg 47955)`);
        this._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47955, socRaw);
            this.log('Capacity control SoC written');
          } catch (err) {
            this.error('Set capacity control SoC failed:', err.message);
          } finally {
            this._writeInProgress = false;
          }
        })();
      });
  }

  // ─── Conditions ────────────────────────────────────────────────────────────

  _registerConditions() {
    this.homey.flow
      .getConditionCard('luna2000_is_charging')
      .registerRunListener((args) => args.device._prevChargingState === 'charging');

    this.homey.flow
      .getConditionCard('luna2000_is_discharging')
      .registerRunListener((args) => args.device._prevChargingState === 'discharging');

    this.homey.flow
      .getConditionCard('luna2000_soc_above')
      .registerRunListener((args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc !== undefined && soc > args.soc;
      });

    this.homey.flow
      .getConditionCard('luna2000_soc_below')
      .registerRunListener((args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return soc !== null && soc !== undefined && soc < args.soc;
      });

    this.homey.flow
      .getDeviceTriggerCard('luna2000_battery_status_changed')
      .registerRunListener((args, state) => args.status === state.status);

    this.homey.flow
      .getConditionCard('luna2000_battery_status_is')
      .registerRunListener((args) => this.getCapabilityValue('luna2000_battery_status') === args.status);

    this.homey.flow
      .getConditionCard('luna2000_working_mode_is')
      .registerRunListener((args) => this.getCapabilityValue('storage_working_mode_settings') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_excess_pv_is')
      .registerRunListener((args) => this.getCapabilityValue('storage_excess_pv_energy_use_in_tou') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_remote_mode_is')
      .registerRunListener((args) => this.getCapabilityValue('remote_charge_discharge_control_mode') === args.mode);

    this.homey.flow
      .getConditionCard('luna2000_max_charge_power_above')
      .registerRunListener((args) => {
        const current = parseFloat(args.device.getSetting('max_charge_power'));
        return Number.isFinite(current) && current > args.power;
      });

    this.homey.flow
      .getConditionCard('luna2000_max_charge_power_below')
      .registerRunListener((args) => {
        const current = parseFloat(args.device.getSetting('max_charge_power'));
        return Number.isFinite(current) && current < args.power;
      });
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let s = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(s) || s < MIN_INTERVAL_S) s = DEFAULT_INTERVAL_S;
    return s * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs());
    this._watchdogTimer = this.homey.setInterval(() => {
      if (this._fetchInProgress) {
        const staleSec = Math.round((Date.now() - this._lastPollStart) / 1000);
        if (staleSec > 120) {
          this.error('Watchdog: _fetchInProgress stuck for ' + staleSec + 's — resetting');
          this._fetchInProgress = false;
        }
      }
    }, 60_000);
  }

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
    if (this._watchdogTimer) {
      this.homey.clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    if (this._writeInProgress) return; // pause poll while a write is queued/running
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

    const abort = () => this._writeInProgress;

    try {
      const batt = await readModbusRegisters(address, port, modbusId, BATTERY_REGISTERS, abort);

      if (!isBatteryDataValid(batt)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          const msg = isBatteryAbsent(batt)
            ? this.homey.__('modbus.errors.batteryNotOnRS485')
            : this.homey.__('modbus.errors.batteryNotDetected');
          await this.setUnavailable(msg);
        }
        this._fetchInProgress = false;
        return;
      }

      const prevSoc = this.getCapabilityValue('measure_battery');
      const soc     = batt.storageSOC ?? 0;
      const power   = batt.storageChargeDischarge ?? 0; // positive = charging, negative = discharging

      const IDLE_THRESHOLD_W = 50;
      const chargingState = power > IDLE_THRESHOLD_W ? 'charging'
        : power < -IDLE_THRESHOLD_W ? 'discharging'
        : 'idle';

      await this._set('measure_power',                power);  // Homey home battery convention
      await this._set('measure_battery',              soc);
      let battLabel;
      let battLabelAlways = false; // show label even at 0 W
      if (soc >= 100) {
        battLabel = this.homey.__('modbus.battery.state.full');
        battLabelAlways = true;
      } else if (soc < 5 && Math.abs(power) <= IDLE_THRESHOLD_W) {
        battLabel = this.homey.__('modbus.battery.state.empty');
        battLabelAlways = true;
      } else {
        battLabel = power < 0 ? '🔻' : '🔺';
      }
      const battWatts = Math.round(Math.abs(power));
      const battStr = battWatts === 0
        ? battLabelAlways ? `${battLabel} (${Math.round(soc)}%)` : `(${Math.round(soc)}%)`
        : `${battWatts} W ${battLabel} ${Math.round(soc)}%`;
      await this._set('battery_state_string', battStr);
      await this._set('meter_power.charged',          batt.storageTotalCharge ?? null);
      await this._set('meter_power.discharged',       batt.storageTotalDischarge ?? null);
      await this._set('measure_power.batt_charge',    Math.max(0,  power));
      await this._set('measure_power.batt_discharge',  Math.max(0, -power));
      await this._set('measure_power.chargesetting',   batt.storageMaxChargePower ?? null);
      await this._set('measure_power.dischargesetting', batt.storageMaxDischargePower ?? null);
      if (batt.storageUnit1Status !== null && batt.storageUnit1Status !== undefined) {
        const statusLabel = UNIT1_STATUS_MAP[batt.storageUnit1Status] ?? `Status ${batt.storageUnit1Status}`;
        await this._set('luna2000_battery_status', statusLabel);
        if (this._prevBatteryStatus !== null && statusLabel !== this._prevBatteryStatus) {
          this.homey.flow.getDeviceTriggerCard('luna2000_battery_status_changed')
            .trigger(this, { status: statusLabel }, { status: statusLabel }).catch((err) => this.log('Flow trigger luna2000_battery_status_changed failed:', err.message));
          if (this.getSetting('enable_timeline_notifications') !== false) {
            this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${statusLabel}` })
              .catch((err) => this.log('Timeline notification failed:', err.message));
          }
        }
        this._prevBatteryStatus = statusLabel;
      }
      await this._set('meter_power.today_batt_input',  batt.storageDayCharge ?? null);
      await this._set('meter_power.today_batt_output', batt.storageDayDischarge ?? null);

      await this._syncStringCap('luna2000_unit1_software_version', batt.storageUnit1SoftwareVer);
      await this._syncStringCap('luna2000_unit2_software_version', batt.storageUnit2SoftwareVer);

      // Read control registers every 5th poll — they change rarely and the read
      // adds ~1 s of connection time that delays pending writes.
      this._controlPollCounter = (this._controlPollCounter + 1) % 5;
      if (this._controlPollCounter === 0) {
        await this._fetchControl(address, port, modbusId);
      }

      if (prevSoc !== soc) {
        await this.homey.flow
          .getDeviceTriggerCard('luna2000_soc_changed')
          .trigger(this, { soc })
          .catch((err) => this.log('Flow trigger luna2000_soc_changed failed:', err.message));
      }

      if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
        this.homey.flow
          .getDeviceTriggerCard('luna2000_charging_state_changed')
          .trigger(this, { state: chargingState })
          .catch((err) => this.log('Flow trigger luna2000_charging_state_changed failed:', err.message));
        if (chargingState === 'charging') {
          this.homey.flow.getDeviceTriggerCard('luna2000_charging_started')
            .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_charging_started failed:', err.message));
        } else if (chargingState === 'discharging') {
          this.homey.flow.getDeviceTriggerCard('luna2000_discharging_started')
            .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_discharging_started failed:', err.message));
        }
      }
      this._prevChargingState = chargingState;

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      this.log('Poll OK: SoC=' + Math.round(soc) + '% P=' + Math.round(power) + 'W');

      // Confirm pending force charge/discharge command once the poll shows the expected direction
      if (this._pendingForceMode) {
        const { direction, powerW, sentAt } = this._pendingForceMode;
        const confirmed = direction === 'discharging' ? power < -50 : power > 50;
        const elapsedS  = Math.round((Date.now() - sentAt) / 1000);
        if (confirmed) {
          this.log(`Force ${direction} confirmed by poll: P=${Math.round(power)} W (target ${powerW} W, ${elapsedS}s after command)`);
          this._pendingForceMode = null;
        } else if (elapsedS > 300) {
          this.log(`Force ${direction} NOT confirmed after ${elapsedS}s — battery may have ignored the command`);
          this._pendingForceMode = null;
        }
      }

    } catch (err) {
      this._failureCount += 1;
      this.error(`Fetch error (${this._failureCount}):`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          `${this.homey.__('modbus.errors.fetchFailed')}: ${err.message}`,
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

  // Adds the capability and sets its value when present; removes it when absent.
  // Used for optional string capabilities that only exist on some hardware configurations.
  async _syncStringCap(capId, value) {
    const hasValue = value && typeof value === 'string' && value.trim().length > 0;
    if (hasValue) {
      if (!this.hasCapability(capId)) await this.addCapability(capId);
      await this._set(capId, value.trim());
    } else if (this.hasCapability(capId)) {
      await this.removeCapability(capId);
    }
  }

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(address, port, modbusId, STORAGE_CONTROL_REGISTERS, () => this._writeInProgress);

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      const newMode = toEnum(ctrl.storageWorkingMode);
      await this._set('storage_working_mode_settings',        newMode);
      await this._set('storage_force_charge_discharge',       toEnum(ctrl.storageForceChargeDischarge));
      await this._set('storage_excess_pv_energy_use_in_tou',  toEnum(ctrl.storageExcessPvEnergyUseInTou));
      await this._set('remote_charge_discharge_control_mode', toEnum(ctrl.remoteChargeDischargeControlMode));
      this._updatingFromModbus = false;

      // Fire working mode changed trigger when mode changes (skip on first read)
      if (newMode !== null) {
        if (this._prevWorkingMode !== null && newMode !== this._prevWorkingMode) {
          const modeLabel = STORAGE_WORKING_MODE_LABELS[newMode] ?? `Mode ${newMode}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_working_mode_changed')
            .trigger(this, { mode: modeLabel })
            .catch((err) => this.log('Flow trigger luna2000_working_mode_changed failed:', err.message));
        }
        this._prevWorkingMode = newMode;
      }

      // Fire excess PV changed trigger
      const newExcessPv = toEnum(ctrl.storageExcessPvEnergyUseInTou);
      if (newExcessPv !== null) {
        if (this._prevExcessPv !== null && newExcessPv !== this._prevExcessPv) {
          const label = EXCESS_PV_LABELS[newExcessPv] ?? `Mode ${newExcessPv}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_excess_pv_changed')
            .trigger(this, { mode: label })
            .catch((err) => this.log('Flow trigger luna2000_excess_pv_changed failed:', err.message));
        }
        this._prevExcessPv = newExcessPv;
      }

      // Fire remote mode changed trigger
      const newRemoteMode = toEnum(ctrl.remoteChargeDischargeControlMode);
      if (newRemoteMode !== null) {
        if (this._prevRemoteMode !== null && newRemoteMode !== this._prevRemoteMode) {
          const label = REMOTE_MODE_LABELS[newRemoteMode] ?? `Mode ${newRemoteMode}`;
          this.homey.flow.getDeviceTriggerCard('luna2000_remote_mode_changed')
            .trigger(this, { mode: label })
            .catch((err) => this.log('Flow trigger luna2000_remote_mode_changed failed:', err.message));
        }
        this._prevRemoteMode = newRemoteMode;
      }

      await this._set('luna2000_unit1_installed', ctrl.storageUnit1No !== null && ctrl.storageUnit1No !== undefined ? ctrl.storageUnit1No > 0 : null);
      await this._set('luna2000_unit2_installed', ctrl.storageUnit2No !== null && ctrl.storageUnit2No !== undefined ? ctrl.storageUnit2No > 0 : null);

      // Sync settings from modbus if they differ
      const settingUpdates = {};

      if (ctrl.storageChargeFromGrid !== null && ctrl.storageChargeFromGrid !== undefined) {
        const enabled    = ctrl.storageChargeFromGrid === 1;
        const currentVal = this.getSetting('charge_from_grid');
        if (currentVal === null || currentVal === undefined || enabled !== currentVal)
          settingUpdates.charge_from_grid = enabled;
      }
      const numericSync = [
        ['storageGridChargeCutoffSoc',     'grid_charge_cutoff_soc'],
        ['storageChargingCutoffCapacity',  'charging_cutoff_capacity'],
        ['storageDischargeCutoffCapacity', 'discharge_cutoff_capacity'],
        ['storageMaxChargePower',          'max_charge_power'],
        ['storageMaxDischargePower',       'max_discharge_power'],
        ['storageBackupPowerSoc',          'backup_power_soc'],
      ];
      // Fields that Homey renders as blank when the value is 0 — always sync so
      // a stored null gets populated and a stored 0 triggers a settings refresh.
      const alwaysSync = new Set(['discharge_cutoff_capacity', 'backup_power_soc']);
      for (const [key, settingId] of numericSync) {
        const v = ctrl[key];
        if (v !== null && v !== undefined) {
          const current = parseFloat(this.getSetting(settingId));
          if (alwaysSync.has(settingId) || !Number.isFinite(current) || Math.abs(v - current) > 0.5) {
            settingUpdates[settingId] = v;
          }
        }
      }

      // Register 47242 (active grid charge power set point) only reflects a meaningful
      // value when charge_from_grid is enabled — skip sync when it is disabled.
      if (ctrl.storageChargeFromGrid === 1 && ctrl.storageGridChargePower !== null && ctrl.storageGridChargePower !== undefined) {
        const v       = ctrl.storageGridChargePower;
        const current = parseFloat(this.getSetting('max_grid_charge_power'));
        if (!Number.isFinite(current) || Math.abs(v - current) > 0.5) settingUpdates.max_grid_charge_power = v;
      }
      if (Object.keys(settingUpdates).length > 0) {
        this._updatingSettingFromModbus = true;
        await this.setSettings(settingUpdates)
          .catch((err) => this.log('setSettings sync failed:', err.message));
        this._updatingSettingFromModbus = false;
      }

      // Battery module count — read once at startup, then locked permanently.
      // Registers 47750–47755 are unreliable during operation (return transient 0 or
      // wrong counts) and battery modules are never added/removed during normal use.
      // Retries automatically on each control-poll cycle until a non-zero count is seen.
      if (!this._batteryModulesInitialized) {
        try {
          const mods  = await readModbusRegisters(address, port, modbusId, BATTERY_MODULE_REGISTERS, () => this._writeInProgress);
          const count = BATTERY_MODULE_KEYS.filter((k) => mods[k] !== null && mods[k] !== undefined && mods[k] !== 0).length;
          await this._set('measure_battery_modules', count);

          if (count > 0) {
            this._batteryModulesInitialized = true;
            this._batteryModuleCount        = count;
            const batteries = Array(count).fill('INTERNAL');
            await this.setEnergy({
              batteries,
              homeBattery:                    true,
              meterPowerImportedCapability:   'meter_power.charged',
              meterPowerExportedCapability:   'meter_power.discharged',
            }).catch((err) => this.log('setEnergy failed:', err.message));
            this.log(`Battery modules: ${count} → energy.batteries locked to ${JSON.stringify(batteries)}`);
          } else {
            this.log('Battery modules: read returned 0 — will retry on next control poll');
          }
        } catch (err) {
          this.log('Battery module register read skipped:', err.message);
        }
      }

      // Mark settings as initialised — onSettings writes are now safe
      this._settingsInitialized = true;

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    } finally {
      this._updatingFromModbus         = false;
      this._updatingSettingFromModbus  = false;
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

module.exports = LUNA2000ModbusDevice;
