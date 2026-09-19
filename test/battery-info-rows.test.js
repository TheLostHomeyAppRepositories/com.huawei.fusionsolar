'use strict';

// The three boxes of the "What the battery modes do" group. Run: node --test
//
// From a field screenshot of 1.2.241: the group rendered as headings over EMPTY boxes.
// Homey draws a setting of type "label" as a disabled input showing its value, and 1.2.237
// had put the explanation in the hint — translatable, but hidden behind the (i) — and left
// the value empty. Three headings, three empty boxes, reading as three settings with
// nothing in them.
//
// Since 1.2.242 each box answers the question its heading asks: the current working mode,
// the current remote mode, and whether the device that does price-driven charging is even
// installed. The mode names come from the capability's own enum titles via _enumLabel, so
// the box can never disagree with the picker one screen away.
//
// Both battery drivers are covered here. The EMMA one has no remote charge/discharge mode,
// so it has two rows rather than three — and it was the half the 1.2.242 mutation probe
// found untested.

const Module = require('module');
const _origLoad = Module._load;

const modbus = {
  ctrl: {},
  async readModbusRegisters(host, port, unit, regs) {
    return Object.fromEntries(
      Object.keys(regs).filter((k) => k in modbus.ctrl).map((k) => [k, modbus.ctrl[k]]));
  },
  async writeModbusRegister() {},
  async writeModbusU32() {},
  parseIntSafe: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
  unavailableMessage: () => 'unavailable',
};

Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  if (/lib\/modbus-client$/.test(request)) return modbus;
  if (/lib\/poll-log$/.test(request)) return { logPollOk() {}, logPollError() {} };
  if (/lib\/pairing-helper$/.test(request)) {
    return { pauseDevicesOnHost: async () => [], resumePairedDevices: async () => {},
      parseIntSafe: modbus.parseIntSafe };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test     = require('node:test');
const assert   = require('node:assert');
const manifest = require('../app.json');

const LunaModbus = require('../drivers/luna2000_modbus/device.js');
const LunaEmma   = require('../drivers/luna2000_emma_modbus/device.js');

const ROWS = ['info_working_mode', 'info_remote_mode', 'info_ems_battery'];
const card = () => { const c = { registerRunListener: () => c, trigger: async () => {} }; return c; };

function makeDevice(Cls, lang = 'de') {
  const d = Object.create(Cls.prototype);
  d.caps = {};
  for (const c of ['storage_working_mode_settings', 'storage_force_charge_discharge',
    'storage_excess_pv_energy_use_in_tou', 'remote_charge_discharge_control_mode',
    'luna2000_unit1_installed', 'luna2000_unit2_installed', 'measure_battery_modules']) d.caps[c] = null;
  d.settings = Object.fromEntries(ROWS.map((r) => [r, '—']));
  d.settings.charge_from_grid = false;
  d.settings.max_grid_charge_power = 2000;
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.getName = () => 'Battery';
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.getSetting = (k) => d.settings[k];
  d.setSettingsCalls = [];
  d.setSettings = async (o) => { d.setSettingsCalls.push({ ...o }); Object.assign(d.settings, o); };
  d.emsDevices = [];
  d.homey = {
    __: (k) => k,
    manifest,
    i18n: { getLanguage: () => lang },
    drivers: { getDriver: (id) => {
      if (id !== 'energy_management') throw new Error('no such driver');
      return { getDevices: () => d.emsDevices };
    } },
    flow: { getDeviceTriggerCard: card, getConditionCard: card, getActionCard: card },
  };
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null;
  d._batteryModulesInitialized = true;
  d._writeInProgress = false;
  d._noteWrite = () => {};
  return d;
}

const titleOf = (capId, id, lang) =>
  manifest.capabilities[capId].values.find((v) => String(v.id) === String(id)).title[lang];

// ── the LUNA2000 Modbus driver ──────────────────────────────────────────────

test('the working-mode box shows the mode, in the user’s language', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_working_mode,
    titleOf('storage_working_mode_settings', 2, 'de'),
    'the box does not say what the picker on the same device says');
});

test('the remote-mode box shows its own mode', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ remoteChargeDischargeControlMode: 0 });
  assert.strictEqual(d.settings.info_remote_mode,
    titleOf('remote_charge_discharge_control_mode', 0, 'de'));
});

// The two modes arrive in different halves of the split read. A row written from whichever
// half happens to be running would blank the other every poll — the 1.2.240 shape.
test('the half that carries one mode does not blank the other’s box', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });                  // live half
  await d._applyControl({ remoteChargeDischargeControlMode: 0 });    // rare half
  assert.strictEqual(d.settings.info_working_mode, titleOf('storage_working_mode_settings', 2, 'de'),
    'the rare half cleared the row the live half had just filled');
  assert.strictEqual(d.settings.info_remote_mode,
    titleOf('remote_charge_discharge_control_mode', 0, 'de'));
});

test('a Dutch device gets Dutch, from the same source', async () => {
  const d = makeDevice(LunaModbus, 'nl');
  await d._applyControl({ storageWorkingMode: 2, remoteChargeDischargeControlMode: 0 });
  assert.strictEqual(d.settings.info_working_mode, titleOf('storage_working_mode_settings', 2, 'nl'));
  assert.strictEqual(d.settings.info_remote_mode,
    titleOf('remote_charge_discharge_control_mode', 0, 'nl'));
});

test('the EMS box says whether the device that does this is installed', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.absent');

  d.emsDevices = [{}];
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.present');
});

// getDriver throws on an app that has never had an Energy Management device. That is an
// answer, not a failure.
test('no Energy Management driver at all reads as "not added"', async () => {
  const d = makeDevice(LunaModbus);
  d.homey.drivers.getDriver = () => { throw new Error('no such driver'); };
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.absent');
});

test('a mode that did not move writes nothing to the store', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });
  const after = d.setSettingsCalls.length;
  await d._applyControl({ storageWorkingMode: 2 });
  assert.deepStrictEqual(d.setSettingsCalls.slice(after).filter((c) => 'info_working_mode' in c), [],
    'the same string was written to the store again');
});

test('a register that did not arrive leaves its box alone', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });
  await d._applyControl({});
  assert.strictEqual(d.settings.info_working_mode, titleOf('storage_working_mode_settings', 2, 'de'));
});

// The rows are decoration; the settings sync is not. One must not take the other down.
test('a store that refuses an info row still gets the real settings sync', async () => {
  const d = makeDevice(LunaModbus);
  const real = d.setSettings;
  d.setSettings = async (o) => {
    if (Object.keys(o).some((k) => k.startsWith('info_'))) throw new Error('store is busy');
    return real(o);
  };
  d.settings.max_discharge_power = 5000;

  await d._applyControl({ storageWorkingMode: 2, storageMaxDischargePower: 0,
    storageDischargeCutoffCapacity: 15, storageBackupPowerSoc: 0 });

  assert.strictEqual(d.settings.max_discharge_power, 0,
    'a refused decoration row took the real settings sync with it');
  assert.ok(d.logs.some((l) => /info rows failed/.test(l)), 'the refusal went unlogged');
});

test('the info rows are written under the guard, like every other sync', async () => {
  const d = makeDevice(LunaModbus);
  let guarded = null;
  const real = d.setSettings;
  d.setSettings = async (o) => {
    if ('info_working_mode' in o) guarded = d._updatingSettingFromModbus;
    return real(o);
  };
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(guarded, true,
    'setSettings ran without _updatingSettingFromModbus, so onSettings would act on it');
  assert.strictEqual(d._updatingSettingFromModbus, false, 'the guard was left set');
});

// ── the EMMA battery driver ─────────────────────────────────────────────────
//
// Same group, two rows. Its working mode is the EMMA's ESS control mode (40000), and it has
// no remote charge/discharge mode at all — which is why it has no row for one.

test('the EMMA driver fills its own boxes', async () => {
  const d = makeDevice(LunaEmma);
  modbus.ctrl = { essControlMode: 2 };

  await d._fetchControl('192.168.1.10', 502, 0);

  assert.strictEqual(d.settings.info_working_mode,
    titleOf('storage_working_mode_settings', 2, 'de'),
    'the EMMA box is still empty, or says something the picker does not');
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.absent');
});

test('the EMMA driver reports an installed Energy Management device too', async () => {
  const d = makeDevice(LunaEmma);
  d.emsDevices = [{}];
  modbus.ctrl = { essControlMode: 2 };

  await d._fetchControl('192.168.1.10', 502, 0);

  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.present');
});

test('the EMMA driver never invents a remote mode it does not have', async () => {
  const d = makeDevice(LunaEmma);
  modbus.ctrl = { essControlMode: 2 };

  await d._fetchControl('192.168.1.10', 502, 0);

  assert.strictEqual(d.settings.info_remote_mode, '—',
    'a row was filled for a capability this device does not have');
});

test('an EMMA whose mode register stayed silent keeps its placeholder', async () => {
  const d = makeDevice(LunaEmma);
  modbus.ctrl = {};

  await d._fetchControl('192.168.1.10', 502, 0);

  assert.strictEqual(d.settings.info_working_mode, '—',
    'an unread register was turned into a mode name');
});
