'use strict';

// One name, one register — within everything a single driver reads. Run: node --test
//
// Issue #31. lib/modbus-registers.js defined storageMaxDischargePower twice: at 37048 in
// BATTERY_REGISTERS (the maximum the battery REPORTS, read-only) and at 47077 in
// CONTROL_REGISTERS (the maximum the user SETS). The LUNA2000 driver reads both sets into
// separate objects, so `batt.storageMaxDischargePower` and `ctrl.storageMaxDischargePower`
// were both valid and looked identical at the call site — and the capability titled "Max
// Discharge Power" was filled from the wrong one. It read 5000 W while the setting was 0.
//
// Huawei invited the mistake: the spec names them "[Energy storage] Maximum discharge
// power" and "[Energy storage] Maximum discharging power". The keys now differ, the labels
// say "reported by the battery" against "setting", and this file keeps it that way.
//
// Deliberately scoped per driver. Names ARE shared across sets that different drivers read
// (ratedPower at 30073 and 30076, phaseAVoltage in three families) — that is fine, nothing
// merges them. The hazard is two meanings under one name inside one device.js.

const test   = require('node:test');
const assert = require('node:assert');
const R      = require('../lib/modbus-registers');

// The register sets each Modbus driver reads into separate objects. Mirrors the requires
// and readModbusRegisters calls in each drivers/<id>/device.js.
const DRIVER_SETS = {
  sun2000_modbus:  ['REGISTERS', 'POWER_METER_REGISTERS', 'CONTROL_REGISTERS'],
  luna2000_modbus: ['BATTERY_REGISTERS', 'BATTERY_MODULE_REGISTERS', 'CONTROL_REGISTERS'],
  dtsu666_modbus:  ['POWER_METER_REGISTERS'],
};

test('no key means two different registers inside one driver', () => {
  for (const [driver, names] of Object.entries(DRIVER_SETS)) {
    const seen = new Map(); // key -> [setName, address]
    for (const name of names) {
      const set = R[name];
      assert.ok(set && typeof set === 'object', `${name} is not exported from lib/modbus-registers`);
      for (const [key, def] of Object.entries(set)) {
        const prev = seen.get(key);
        assert.ok(!prev,
          `${driver}: "${key}" is ${prev && prev[0]} @${prev && prev[1]} and ${name} @${def[0]} — `
          + 'two registers under one name, the fault behind issue #31');
        seen.set(key, [name, def[0]]);
      }
    }
  }
});

// ── the two pairs that collided, pinned by address and by wording ───────────

test('the reported maximum kept its address and says who reports it', () => {
  for (const [key, addr, word] of [['essMaxChargePower', 37046, 'charge'], ['essMaxDischargePower', 37048, 'discharge']]) {
    const def = R.BATTERY_REGISTERS[key];
    assert.ok(def, `${key} is missing from BATTERY_REGISTERS`);
    assert.strictEqual(def[0], addr, `${key} moved off ${addr}`);
    assert.match(def[3], /reported by the battery/, `${key} does not say the battery reports it`);
    assert.match(def[3], /read-only/, `${key} does not say it is read-only`);
    assert.match(def[3], new RegExp(`Maximum ${word} power`), `${key} lost Huawei's own wording`);
  }
});

test('the setting kept its address and says it is one', () => {
  for (const [key, addr, word] of [['storageMaxChargePower', 47075, 'charging'], ['storageMaxDischargePower', 47077, 'discharging']]) {
    const def = R.CONTROL_REGISTERS[key];
    assert.ok(def, `${key} is missing from CONTROL_REGISTERS`);
    assert.strictEqual(def[0], addr, `${key} moved off ${addr}`);
    assert.match(def[3], /setting/, `${key} does not say it is a setting`);
    assert.match(def[3], new RegExp(`Maximum ${word} power`), `${key} lost Huawei's own wording`);
  }
});

test('the old shared name is gone from the battery block', () => {
  assert.strictEqual(R.BATTERY_REGISTERS.storageMaxChargePower, undefined);
  assert.strictEqual(R.BATTERY_REGISTERS.storageMaxDischargePower, undefined);
});
