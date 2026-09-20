'use strict';

// The SDongle's own software version, and the cost of fetching it. Run: node --test
//
// The dongle reports its OS version at 30050 — the same address the inverter uses for its
// software version, on a different unit. Andi asked for it on the device tile the way the
// inverter already has one.
//
// The thing worth guarding is not that the string arrives but what it costs and what
// happens when it does not. 30050 sits far from the dongle's power block at 37498, so asking
// for it on every poll would buy a whole extra round trip for a value that cannot change;
// it belongs in STATIC_REGISTER_ADDRESSES, where it is read once and then cached for a day.
// And a dongle that answers with an empty string must not wipe a version that was read
// correctly a moment earlier.
//
// The driver is loaded through an intercepted require, the way test/modbus-pv-strings.test.js
// does it: `homey` only supplies a base class, and the Modbus client is swapped for one that
// answers whatever the test has set. Intercepting rather than reassigning the export matters
// because the driver destructures readModbusRegisters at module scope.

const Module = require('module');
const _origLoad = Module._load;

let answer = {};
const realClient = require('../lib/modbus-client.js');

Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    return { ...realClient, readModbusRegisters: async () => answer };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const SdongleDevice = require('../drivers/sdongle_a_modbus/device.js');

Module._load = _origLoad;   // nothing after this line wants the fakes

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const REG      = require('../lib/modbus-registers');
const manifest = require('../app.json');

const CAP = 'sdongle_software_version';

// ── the register, and what reading it costs ─────────────────────────────────

test('the version is read from 30050 as a fifteen-word string', () => {
  assert.deepStrictEqual(REG.SDONGLE_A_REGISTERS.softwareVersion.slice(0, 3),
    [30050, 15, 'STRING']);
});

test('it is read once a day, not on every poll', () => {
  // Without this the dongle pays an extra request every minute, forever, for a string that
  // cannot change: 30050 is nowhere near the power registers at 37498 and upward, so it can
  // never ride along in a batch with them.
  assert.ok(REG.STATIC_REGISTER_ADDRESSES.has(30050),
    '30050 is not cached, so the dongle now spends a round trip on it every poll');

  const { buildReadPlan } = realClient;
  const plan = buildReadPlan(REG.SDONGLE_A_REGISTERS);
  const withVersion = plan.find((g) => g.some((e) => e.start === 30050));
  assert.strictEqual(withVersion.length, 1,
    'the version shares a request with a power register — then caching it saves nothing');
});

// ── the capability ──────────────────────────────────────────────────────────

test('the capability exists, is read-only, and has a title in every language', () => {
  const cap = manifest.capabilities[CAP];
  assert.ok(cap, `${CAP} is not defined`);
  assert.strictEqual(cap.type, 'string');
  assert.strictEqual(cap.getable, true);
  assert.strictEqual(cap.setable, false, 'a version the user could type in is not a reading');
  assert.strictEqual(cap.insights, false, 'a version string in Insights is a chart of nothing');
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(cap.title[lang], `${CAP}: no ${lang} title`);
  }
  assert.ok(fs.existsSync(path.join('.', cap.icon.replace(/^\//, ''))),
    `${CAP}: the icon at ${cap.icon} is not there`);
});

test('the driver declares it, and asks for it on a device that predates it', () => {
  const driver = manifest.drivers.find((d) => d.id === 'sdongle_a_modbus');
  assert.ok(driver.capabilities.includes(CAP), 'the driver does not declare the capability');

  // An existing paired dongle has no such capability until onInit adds it, so it has to be
  // in the list the driver catches up on rather than only in the manifest.
  const src = fs.readFileSync(path.join('drivers', 'sdongle_a_modbus', 'device.js'), 'utf8');
  const block = src.slice(src.indexOf('const REQUIRED_CAPABILITIES'), src.indexOf('];', src.indexOf('const REQUIRED_CAPABILITIES')));
  assert.ok(block.includes(CAP),
    'already-paired dongles would never gain the capability');
});

// ── what the driver does with the answer ────────────────────────────────────

function makeDevice() {
  const dev = Object.create(SdongleDevice.prototype);
  dev.caps = {};
  dev._fetchInProgress = false;
  dev._failureCount = 0;
  dev.log = () => {};
  dev.error = () => {};
  dev.getSetting = (k) => ({ address: '10.0.0.5', port: '502', modbus_id: '100' }[k]);
  dev.getAvailable = () => true;
  dev.setAvailable = async () => {};
  dev.setUnavailable = async () => {};
  dev.homey = { __: (k) => k };
  dev._set = async (cap, value) => { dev.caps[cap] = value; };
  return dev;
}

const GOOD = {
  loadPower: 1784, totalInputPower: 6108, gridPower: -4324,
  batteryPower: 0, totalActivePower: 6108, connectionType: 4,
};

test('the version reaches the tile', async () => {
  const dev = makeDevice();
  answer = { ...GOOD, softwareVersion: 'V200R025C00SPC120' };
  await dev._fetchAndUpdate();
  assert.strictEqual(dev.caps[CAP], 'V200R025C00SPC120');
});

test('an empty answer leaves the version that was already there', async () => {
  // A dongle mid-restart answers a string register with spaces. Writing that through would
  // replace a correct version with a blank one and look like the dongle had lost it.
  const dev = makeDevice();
  answer = { ...GOOD, softwareVersion: 'V200R025C00SPC120' };
  await dev._fetchAndUpdate();

  for (const empty of ['', null, undefined]) {
    dev._fetchInProgress = false;
    answer = { ...GOOD, softwareVersion: empty };
    await dev._fetchAndUpdate();
    assert.strictEqual(dev.caps[CAP], 'V200R025C00SPC120',
      `an answer of ${JSON.stringify(empty)} overwrote a good version`);
  }
});

test('the version does not disturb the readings that were already working', async () => {
  const dev = makeDevice();
  answer = { ...GOOD, softwareVersion: 'V200R025C00SPC120' };
  await dev._fetchAndUpdate();
  assert.strictEqual(dev.caps['measure_power'], 1784);
  assert.strictEqual(dev.caps['measure_power.grid_active_power'], -4324);
  assert.strictEqual(dev.caps['measure_power.battery'], 0, 'a zero was dropped');
});

// ── the connection type, while we are in here ───────────────────────────────

test('both the documented and the observed WLAN-FE code read as WLAN-FE', () => {
  // The reference table lists 5; the dongle in the field reports 4. Mapping only one of them
  // would show the other as "Type 4" or "Type 5" to somebody whose hardware is perfectly
  // ordinary.
  const src = fs.readFileSync(path.join('drivers', 'sdongle_a_modbus', 'device.js'), 'utf8');
  const block = src.slice(src.indexOf('const CONNECTION_TYPE_MAP'), src.indexOf('};', src.indexOf('const CONNECTION_TYPE_MAP')));
  assert.match(block, /4:\s*'WLAN-FE'/);
  assert.match(block, /5:\s*'WLAN-FE'/);
});

test('an unknown connection type says so rather than borrowing a name', async () => {
  const dev = makeDevice();
  answer = { ...GOOD, connectionType: 9, softwareVersion: 'V1' };
  await dev._fetchAndUpdate();
  assert.strictEqual(dev.caps['sdongle_type'], 'Type 9');
});

test('a known connection type is named', async () => {
  for (const [code, name] of [[0, 'N/A'], [2, 'WLAN'], [3, '4G'], [4, 'WLAN-FE'], [5, 'WLAN-FE']]) {
    const dev = makeDevice();
    answer = { ...GOOD, connectionType: code, softwareVersion: 'V1' };
    await dev._fetchAndUpdate();
    assert.strictEqual(dev.caps['sdongle_type'], name, `code ${code}`);
  }
});
