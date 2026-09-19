'use strict';

// Max charge / discharge power: the setting, the capability, and the cards. Run: node --test
//
// Issue #31 (2026-09-19). The reporter set the battery's max discharge power to 0 and built
// a flow on the capability "Max Discharge Power is less than…" — there was no condition
// card for discharge, only for charge. The capability stayed at 5000 W.
//
// Two numbers, one name. Huawei's spec has "[Energy storage] Maximum discharge power"
// (37048, read-only, what the battery reports it can do) and "[Energy storage] Maximum
// discharging power" (47077, the setting). The driver read both into differently named
// objects but under the SAME key, and the capability was filled from the reported maximum
// — which does not move when the user changes the limit. The device setting was filled
// from the right register all along; a flow just had no way to reach it.
//
// So: the capability follows the setting register, both views are brought in line after a
// successful write, the discharge condition cards exist, and the pairing page calls the
// reported maximum what it is.

const Module = require('module');
const _origLoad = Module._load;

// What the inverter answers and what was written to it. One stub serves the device, the
// driver and the pairing handler; `ctrl` is returned for every read.
const modbus = {
  ctrl: {}, writes: [], fail: null, lastRegs: null,
  async readModbusRegisters(host, port, unit, regs) { modbus.lastRegs = regs; return modbus.ctrl; },
  async writeModbusRegister(host, port, unit, reg, value) {
    if (modbus.fail) throw new Error(modbus.fail);
    modbus.writes.push({ reg, value });
  },
  async writeModbusU32(host, port, unit, reg, value) {
    if (modbus.fail) throw new Error(modbus.fail);
    modbus.writes.push({ reg, value });
  },
  parseIntSafe: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
  unavailableMessage: () => 'unavailable',
};

Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  if (/lib\/modbus-client$/.test(request)) return modbus;
  if (/lib\/poll-log$/.test(request)) return { logPollOk() {}, logPollError() {} };
  if (/lib\/pairing-helper$/.test(request)) {
    return {
      pauseDevicesOnHost: async () => [],
      resumePairedDevices: async () => {},
      parseIntSafe: modbus.parseIntSafe,
    };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const LUNA2000ModbusDevice = require('../drivers/luna2000_modbus/device.js');
const LUNA2000ModbusDriver = require('../drivers/luna2000_modbus/driver.js');
const manifest             = require('../app.json');

const settle = () => new Promise((r) => setTimeout(r, 25));

function card(id, into) {
  const c = {
    registerRunListener(fn) { into.set(id, fn); return c; },
    registerArgumentAutocompleteListener() { return c; },
    trigger: async () => {},
  };
  return c;
}

function makeDevice() {
  const d = Object.create(LUNA2000ModbusDevice.prototype);
  d.caps = { 'measure_power.chargesetting': 5000, 'measure_power.dischargesetting': 5000 };
  d.settings = { address: '192.168.1.10', port: 502, modbus_id: 1,
    max_charge_power: 5000, max_discharge_power: 5000 };
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.getSetting = (k) => d.settings[k];
  d.setSettingsCalls = [];
  d.setSettings = async (o) => {
    d.setSettingsCalls.push({ ...o, _guarded: d._updatingSettingFromModbus === true });
    Object.assign(d.settings, o);
  };
  d.conditions = new Map();
  d.actions = new Map();
  d.homey = {
    __: (k) => k,
    setTimeout, clearTimeout,
    flow: {
      getDeviceTriggerCard: (id) => card(id, new Map()),
      getConditionCard:     (id) => card(id, d.conditions),
      getActionCard:        (id) => card(id, d.actions),
    },
  };
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._settingsInitialized = true;
  d._writeInProgress = false;
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null;
  d._batteryModulesInitialized = true; // skip the one-off module read in _fetchControl
  return d;
}

function reset() { modbus.ctrl = {}; modbus.writes = []; modbus.fail = null; modbus.lastRegs = null; }

// ── the field case: the control poll ────────────────────────────────────────

test('the capabilities follow the setting registers, so a limit of 0 reads as 0', async () => {
  reset();
  modbus.ctrl = { storageMaxChargePower: 3500, storageMaxDischargePower: 0 };
  const d = makeDevice();

  await d._fetchControl('192.168.1.10', 502, 1);

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0, 'the token still shows a number the user never set');
  assert.strictEqual(d.caps['measure_power.chargesetting'], 3500);
  assert.strictEqual(d.settings.max_discharge_power, 0, 'the setting stopped following the inverter');
});

test('a control poll that did not return the limit leaves the capability alone', async () => {
  reset();
  modbus.ctrl = {}; // nothing came back for these two
  const d = makeDevice();
  await d._fetchControl('192.168.1.10', 502, 1);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000, 'an unread register was reported as a value');
});

// ── the write paths: both views move together, and only on success ──────────

test('a limit set from the flow card shows in the capability and the setting at once', async () => {
  reset();
  const d = makeDevice();
  d._registerFlowActions();

  d.actions.get('luna2000_set_max_discharge_power')({ device: d, power: 0 });
  await settle();

  assert.deepStrictEqual(modbus.writes, [{ reg: 47077, value: 0 }]);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0, 'the token lags behind the write');
  assert.strictEqual(d.settings.max_discharge_power, 0);
});

test('the charge card does the same for its own pair', async () => {
  reset();
  const d = makeDevice();
  d._registerFlowActions();

  d.actions.get('luna2000_set_max_charge_power')({ device: d, power: 2000 });
  await settle();

  assert.deepStrictEqual(modbus.writes, [{ reg: 47075, value: 2000 }]);
  assert.strictEqual(d.caps['measure_power.chargesetting'], 2000);
  assert.strictEqual(d.settings.max_charge_power, 2000);
});

test('a write the inverter refused changes neither view', async () => {
  reset();
  modbus.fail = 'timeout waiting for response';
  const d = makeDevice();
  d._registerFlowActions();

  d.actions.get('luna2000_set_max_discharge_power')({ device: d, power: 0 });
  await settle();

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000, 'the token claims a limit the inverter never took');
  assert.strictEqual(d.settings.max_discharge_power, 5000);
  assert.ok(d.logs.some((l) => /failed/.test(l)), 'the refusal went unlogged');
});

test('a limit edited in the device settings reaches the capability after the write', async () => {
  reset();
  const d = makeDevice();
  d.settings.max_discharge_power = 0; // Homey has already applied the edit when onSettings runs

  await d.onSettings({ newSettings: { max_discharge_power: 0 }, changedKeys: ['max_discharge_power'] });
  await settle();

  assert.deepStrictEqual(modbus.writes, [{ reg: 47077, value: 0 }]);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0);
});

test('a settings edit the inverter refused leaves the capability on the old limit', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.max_discharge_power = 0;

  await d.onSettings({ newSettings: { max_discharge_power: 0 }, changedKeys: ['max_discharge_power'] });
  await settle();

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000);
});

// ── the helper itself ───────────────────────────────────────────────────────

test('_reflectMaxPower writes the setting under the guard that stops it echoing back', async () => {
  reset();
  const d = makeDevice();
  await d._reflectMaxPower('max_discharge_power', 0);

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0);
  assert.deepStrictEqual(d.setSettingsCalls, [{ max_discharge_power: 0, _guarded: true }],
    'setSettings ran without _updatingSettingFromModbus, so onSettings will write the value straight back');
  assert.strictEqual(d._updatingSettingFromModbus, false, 'the guard was left set');
});

test('_reflectMaxPower does not rewrite a setting that already matches', async () => {
  reset();
  const d = makeDevice();
  await d._reflectMaxPower('max_charge_power', 5000);
  assert.deepStrictEqual(d.setSettingsCalls, [], 'a no-op write to the settings store');
});

test('_reflectMaxPower ignores what it cannot use', async () => {
  reset();
  const d = makeDevice();
  await d._reflectMaxPower('max_discharge_power', NaN);
  await d._reflectMaxPower('not_a_limit', 1000);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000);
  assert.deepStrictEqual(d.setSettingsCalls, []);
});

// ── the missing condition cards ─────────────────────────────────────────────

test('the discharge conditions compare the discharge setting, not the charge one', () => {
  const d = makeDevice();
  d._registerConditions();
  const below = d.conditions.get('luna2000_max_discharge_power_below');
  const above = d.conditions.get('luna2000_max_discharge_power_above');
  assert.ok(below && above, 'the discharge pair is not registered');

  // charge still at 5000, discharge blocked at 0 — the reporter's exact situation
  const dev = { getSetting: (k) => ({ max_charge_power: 5000, max_discharge_power: 0 })[k] };
  assert.strictEqual(below({ device: dev, power: 1 }), true, '"below 1" is the documented way to ask "is it blocked"');
  assert.strictEqual(above({ device: dev, power: 1000 }), false);

  const open = { getSetting: (k) => ({ max_charge_power: 0, max_discharge_power: 5000 })[k] };
  assert.strictEqual(above({ device: open, power: 1000 }), true);
  assert.strictEqual(below({ device: open, power: 1000 }), false);
});

test('the discharge conditions are strict, like the charge ones', () => {
  const d = makeDevice();
  d._registerConditions();
  const dev = { getSetting: () => 1000 };
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_above')({ device: dev, power: 1000 }), false);
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_below')({ device: dev, power: 1000 }), false);
});

test('a setting never synced yet makes neither condition true', () => {
  const d = makeDevice();
  d._registerConditions();
  const dev = { getSetting: () => null };
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_above')({ device: dev, power: 0 }), false);
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_below')({ device: dev, power: 100000 }), false);
});

test('the discharge cards mirror the charge cards in everything but the words', () => {
  const byId = Object.fromEntries(manifest.flow.conditions.map((c) => [c.id, c]));
  for (const kind of ['above', 'below']) {
    const charge = byId['luna2000_max_charge_power_' + kind];
    const disch  = byId['luna2000_max_discharge_power_' + kind];
    assert.ok(disch, `luna2000_max_discharge_power_${kind} is not declared`);
    assert.deepStrictEqual(disch.args, charge.args, `${kind}: the arguments differ from the charge card`);
    for (const lang of ['en', 'de', 'nl']) {
      assert.ok(disch.title[lang] && disch.titleFormatted[lang] && disch.hint[lang], `${kind}: ${lang} text missing`);
      assert.match(disch.titleFormatted[lang], /\[\[power\]\]/, `${kind}: ${lang} title does not show the threshold`);
    }
    assert.match(disch.title.en, /discharge/);
    assert.match(disch.title.de, /Entladeleistung/);
    assert.match(disch.title.nl, /ontlaadvermogen/);
    assert.match(disch.hint.en, /47077/, `${kind}: the hint does not name the register it compares`);
  }
  assert.match(byId.luna2000_max_discharge_power_below.hint.en, /threshold 1/,
    'the below-card should say how to ask "is it blocked", as the charge card does');
});

// ── the pairing page asks for what it labels ────────────────────────────────

test('pairing probes the reported maximum under its own name and hands it on as such', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: -300, essMaxChargePower: 5000,
    essMaxDischargePower: 5000, storageDayCharge: 1.2, storageDayDischarge: 0.4 };
  const drv = Object.create(LUNA2000ModbusDriver.prototype);
  drv.log = () => {};
  drv.homey = { __: (k) => k };
  const handlers = {};
  await drv.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });

  const r = await handlers.connect({ address: '192.168.1.10', port: 502, modbusId: 1, name: 'x' });

  assert.strictEqual(modbus.lastRegs.essMaxChargePower[0], 37046, 'the probe asks a different register than it labels');
  assert.strictEqual(modbus.lastRegs.essMaxDischargePower[0], 37048);
  assert.strictEqual('storageMaxChargePower' in modbus.lastRegs, false, 'the old shared key is still being probed');
  assert.strictEqual(r.kpi.essMaxChargePower, 5000);
  assert.strictEqual(r.kpi.essMaxDischargePower, 5000);
});

// The page cannot be run here; its two bindings to the KPI are read instead.
test('the pairing page shows the reported maximum, not the setting', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'luna2000_modbus', 'pair', 'start.html'), 'utf8');
  assert.match(html, /kpi\.essMaxChargePower/);
  assert.match(html, /kpi\.essMaxDischargePower/);
  assert.doesNotMatch(html, /kpi\.storageMax(Dis)?[Cc]hargePower/, 'the page still reads the old key');
});

// Anchored on the i18n keys, not on the file as a whole. The <div> carries the same words
// as a pre-script fallback, and matching anywhere let a mutation that reverted only the
// English i18n entry pass — while that entry is exactly what the user sees, because the
// script overwrites the div's text from it.
test('the pairing labels call the value the battery’s, in both languages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'luna2000_modbus', 'pair', 'start.html'), 'utf8');

  for (const [key, expected] of [
    ['labelMaxCharge',    ['Battery max. charge',    'Batterie: max. Laden']],
    ['labelMaxDischarge', ['Battery max. discharge', 'Batterie: max. Entladen']],
  ]) {
    const found = [...html.matchAll(new RegExp(`${key}:\\s*'([^']*)'`, 'g'))].map((m) => m[1]);
    assert.deepStrictEqual(found, expected,
      `${key} does not read as the battery's own maximum in both languages`);
  }

  // The div is what shows for the instant before the script runs; it must not disagree.
  assert.match(html, /id="kpi-label-max-charge">Battery max\. charge</);
  assert.match(html, /id="kpi-label-max-discharge">Battery max\. discharge</);
});
