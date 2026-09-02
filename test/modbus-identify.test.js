'use strict';

// Which registers count as proof that a device is there. Run: node --test
//
// The function under test lives inside the POST /scan/modbus handler in api.js and cannot
// be required, so it is lifted out of the source and evaluated here. That is worth doing
// rather than asserting on its text: the bug this file exists for was a condition that read
// perfectly well and was wrong about one value.
//
// Field-caught 2026-09-02. The scan reported an EMMA, a LUNA2000 behind an EMMA and an EMMA
// meter on a plant whose owner has none of them. Measured against the SDongle at unit 100:
// it answers all four EMMA addresses, with a plain 0 for each rather than an exception. The
// old conditions asked only whether a number came back, and 0 is a number.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const API = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

function loadIdentify() {
  const label = API.match(/const CONN_TYPE_LABEL = \{[^\n]*\};/);
  assert.ok(label, 'CONN_TYPE_LABEL is gone — the identification block was restructured');
  const start = API.indexOf('function identifyFromData(');
  assert.ok(start > 0, 'identifyFromData is gone or renamed');
  const end = API.indexOf('\n    }', start);
  assert.ok(end > start, 'the end of identifyFromData could not be found');
  const src = `${label[0]}\n${API.slice(start, end + 6)}\nreturn identifyFromData;`;
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

const identify = loadIdentify();
const confirmedOf = (r) => r.compatible.filter((c) => c.confirmed).map((c) => c.driver.split(' ')[0]);

// The exact reading that caused the report, copied from the probe output.
const SDONGLE_100 = {
  modelName: null, luna2000Modules: null, sdongleConnType: 4, sdongleLoadPower: 2688,
  dtsuMeterStatus: 0,
  emmaPvPower: 0, emmaFeedInPower: 0, emmaBatteryCapacity: 0, emmaChargerRatedPow: null,
};

test('an SDongle answering the EMMA registers with zeroes is not an EMMA', () => {
  const got = identify(100, SDONGLE_100);
  assert.deepStrictEqual(confirmedOf(got), ['sdongle_a_modbus'],
    'a device that returned 0 for every EMMA register was identified as EMMA hardware');
  assert.strictEqual(got.type, 'SDongle A');
});

// The same reading, minus the SDongle proof, so nothing else can carry the result. This is
// the case the emmaLive gate actually has to catch: all four zero, nothing else recognised.
test('four zeroes on their own confirm nothing at all', () => {
  const got = identify(101, {
    ...SDONGLE_100, sdongleConnType: 0, sdongleLoadPower: 0,
  });
  assert.deepStrictEqual(confirmedOf(got), []);
  assert.strictEqual(got.anyConfirmed, false,
    'an address that answered every register with 0 counts as a find');
});

// The gate must not cost real detections. An EMMA feeding the grid at night reports 0 PV,
// and that has to keep working — the group is alive, this one register happens not to be.
test('an EMMA at night is still an EMMA', () => {
  const got = identify(0, {
    modelName: null, luna2000Modules: null, sdongleConnType: null, sdongleLoadPower: null,
    dtsuMeterStatus: null,
    emmaPvPower: 0, emmaFeedInPower: -1840, emmaBatteryCapacity: 5.2, emmaChargerRatedPow: null,
  });
  const drivers = confirmedOf(got);
  assert.ok(drivers.includes('sun2000_emma_modbus'), 'zero PV power at night reads as no EMMA');
  assert.ok(drivers.includes('powermeter_emma_modbus'), 'the EMMA meter was lost');
  assert.ok(drivers.includes('luna2000_emma_modbus'), 'the battery behind the EMMA was lost');
});

// A single non-zero register is enough to open the group; that is the whole rule.
test('one register with content is enough to trust the rest', () => {
  const got = identify(0, {
    emmaPvPower: 4210, emmaFeedInPower: 0, emmaBatteryCapacity: 0, emmaChargerRatedPow: null,
  });
  assert.ok(confirmedOf(got).includes('sun2000_emma_modbus'));
});

// Registers the scan never asked for must not read as registers that gave no answer. With
// the probe split in two, an unqueried key is absent rather than null, and the tester line
// says which of the two happened.
test('a register that was never queried does not report a measurement', () => {
  const got = identify(1, {
    modelName: 'SUN2000-10KTL-M1', luna2000Modules: 1, sdongleConnType: 0,
    sdongleLoadPower: 0, dtsuMeterStatus: 1,
  });
  const emma = got.compatible.find((c) => c.driver.startsWith('sun2000_emma_modbus'));
  assert.match(emma.detail, /not queried/,
    'an address that was never asked is reported as one that failed to answer');
  assert.doesNotMatch(emma.detail, /not found/);
  const direct = got.compatible.find((c) => c.driver.startsWith('dtsu666_modbus'));
  assert.strictEqual(direct.confirmed, true, 'the meter that did answer was lost');
});

// The reading measured at unit 1: the whole point of the split is that these five arrive.
test('the direct-Modbus stage alone identifies the inverter, battery and meter', () => {
  const got = identify(1, {
    modelName: 'SUN2000-10KTL-M101074311-0', luna2000Modules: 1, sdongleConnType: 4,
    sdongleLoadPower: 0, dtsuMeterStatus: 1,
  });
  assert.deepStrictEqual(confirmedOf(got).sort(),
    ['dtsu666_modbus', 'luna2000_modbus', 'sun2000_modbus']);
  // sdongleLoadPower is 0 here, which is what a SUN2000 returns for 37500. The SDongle
  // condition already knew that; the EMMA ones did not, which is how this all started.
  assert.ok(!confirmedOf(got).includes('sdongle_a_modbus'),
    'a connection type with no house load confirmed an SDongle again');
});
