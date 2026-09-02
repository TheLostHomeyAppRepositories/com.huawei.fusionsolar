'use strict';

// Which registers count as proof that a device is there. Run: node --test
//
// The rules under test live inside the POST /scan/confirm handler in api.js and cannot be
// required, so DRIVER_CONFIRM is lifted out of the source and evaluated here. That is worth
// doing rather than asserting on its text: the bug this file exists for was a condition that
// read perfectly well and was wrong about one value.
//
// Field-caught 2026-09-02. The device tester reported an EMMA, a LUNA2000 behind an EMMA and
// an EMMA meter on an installation whose owner has none of them. Measured against the SDongle
// at unit 100: it answers all four EMMA addresses, with a plain 0 for each rather than an
// exception. The old conditions asked only whether a number came back, and 0 is a number.
//
// This was fixed twice, because the same rules existed in two places. The unit-ID scan is
// gone; /scan/confirm is the path that remains, and it is the one that has to stay right.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const API = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

function loadConfirmRules() {
  const start = API.indexOf('const emmaLive =');
  assert.ok(start > 0, 'the emmaLive guard is gone — a zero would be proof again');
  const mapAt = API.indexOf('const DRIVER_CONFIRM = {', start);
  assert.ok(mapAt > start, 'DRIVER_CONFIRM is gone or was moved above its helpers');
  const end = API.indexOf('\n      };', mapAt);
  assert.ok(end > mapAt, 'the end of DRIVER_CONFIRM could not be found');
  const src = `${API.slice(start, end + 9)}\nreturn DRIVER_CONFIRM;`;
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

const RULES = loadConfirmRules();
const confirms = (driver, data) => {
  const rule = RULES[driver];
  assert.ok(rule, `${driver} has no confirmation rule at all`);
  return rule.check(data);
};

// The exact reading that caused the report, copied from the probe output at unit 100.
const SDONGLE_EMMA_REGS = {
  emmaPvPower: 0, emmaFeedInPower: 0, emmaBatteryCapacity: 0, emmaChargerRatedPow: null,
};

test('an SDongle answering the EMMA registers with zeroes is not an EMMA', () => {
  for (const driver of ['sun2000_emma_modbus', 'luna2000_emma_modbus', 'powermeter_emma_modbus']) {
    assert.strictEqual(confirms(driver, SDONGLE_EMMA_REGS), false,
      `${driver} was confirmed by four registers that all returned 0`);
  }
});

// The gate must not cost real detections. An EMMA feeding the grid at night reports 0 PV,
// and that has to keep working — the group is alive, this one register happens not to be.
test('an EMMA at night is still an EMMA', () => {
  const night = {
    emmaPvPower: 0, emmaFeedInPower: -1840, emmaBatteryCapacity: 5.2, emmaChargerRatedPow: null,
  };
  assert.strictEqual(confirms('sun2000_emma_modbus', night), true,
    'zero PV power at night reads as no EMMA');
  assert.strictEqual(confirms('powermeter_emma_modbus', night), true, 'the EMMA meter was lost');
  assert.strictEqual(confirms('luna2000_emma_modbus', night), true,
    'the battery behind the EMMA was lost');
});

// One non-zero register is enough to open the group; that is the whole rule.
test('one register with content is enough to trust the rest', () => {
  assert.strictEqual(confirms('sun2000_emma_modbus', {
    emmaPvPower: 4210, emmaFeedInPower: 0, emmaBatteryCapacity: 0, emmaChargerRatedPow: null,
  }), true);
});

// The gate only works if the group is actually read. Confirming an EMMA driver from its own
// single register would leave nothing to compare against, which is how this started.
test('the EMMA drivers read the whole group, not just the register that names them', () => {
  for (const driver of ['sun2000_emma_modbus', 'luna2000_emma_modbus', 'powermeter_emma_modbus']) {
    const addresses = Object.values(RULES[driver].registers).map((def) => def[0]).sort();
    assert.deepStrictEqual(addresses, [30076, 30354, 30358, 30369],
      `${driver} reads only part of the EMMA group, so a lone 0 has nothing to be judged against`);
  }
});

// Never had the bug — its comment records the same lesson, which is where the fix came from.
test('the SDongle rule still refuses a connection type with no house load', () => {
  assert.strictEqual(confirms('sdongle_a_modbus', { sdongleConnType: 4, sdongleLoadPower: 0 }), false,
    'a SUN2000 returns 0 for register 37500 and would be confirmed as an SDongle');
  assert.strictEqual(confirms('sdongle_a_modbus', { sdongleConnType: 0, sdongleLoadPower: 2688 }), false,
    'connection type 0 means N/A and is returned by non-SDongle devices');
  assert.strictEqual(confirms('sdongle_a_modbus', { sdongleConnType: 4, sdongleLoadPower: 2688 }), true,
    'the reading measured on the real SDongle at unit 100 is no longer recognised');
});

// The direct-Modbus rules, with the readings measured at unit 1.
test('the direct-Modbus rules identify the inverter, battery and meter', () => {
  assert.strictEqual(confirms('sun2000_modbus', { modelName: 'SUN2000-10KTL-M101074311-0' }), true);
  assert.strictEqual(confirms('sun2000_modbus', { modelName: '' }), false,
    'an empty model name counts as a find');
  assert.strictEqual(confirms('luna2000_modbus', { luna2000Modules: 1 }), true);
  assert.strictEqual(confirms('luna2000_modbus', { luna2000Modules: 0 }), false,
    'zero battery modules confirms a battery');
  assert.strictEqual(confirms('dtsu666_modbus', { dtsuMeterStatus: 1 }), true);
  assert.strictEqual(confirms('dtsu666_modbus', { dtsuMeterStatus: 0 }), false,
    'an offline meter reads as present');
});
