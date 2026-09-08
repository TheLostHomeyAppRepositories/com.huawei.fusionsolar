'use strict';

// Unit tests for the PV string count and the grid frequency on the SUN2000 Modbus driver.
// Run: node --test
//
// Two things the driver never read, both plainly in the Huawei Modbus definitions:
//
//   30071  Number of PV strings   "A maximum of 24 PV strings are supported. The number of
//                                  PV strings read by the host is defined by the Number of
//                                  PV strings signal. PVn voltage: 32014 + 2n. PVn current:
//                                  32015 + 2n. n ranges from 1 to 24."
//   32085  Grid frequency         I16, gain 100
//
// The driver read PV1 and PV2 and stopped, so a four-string inverter showed half its
// strings. The production reading was never affected — 32064 is the total DC input across
// all strings — so what was missing is the per-string detail, not the yield.
//
// Why the strings are asked for only after the inverter has said it has them: the addresses
// past PV2 sit in the same span as PV1 and PV2, and lib/modbus-client.js writes off a whole
// batch when a reply comes back desynchronised. A speculative read of PV24 on a two-string
// inverter can therefore take PV1 and PV2 down with it. The last test in the register
// section is the one that pins that.

const Module = require('module');
const _origLoad = Module._load;

// What the synthetic inverter answers, and what the driver asked it for. Set per test.
let pollAnswer = {};
let pollTable  = null;

// The driver needs `homey` for its base class only; nothing under test touches it. Its own
// Modbus client is replaced so a whole poll can run against the synthetic inverter above —
// the rest of that module (parseIntSafe, unavailableMessage) stays real. Only the driver
// uses this specifier, so nothing else in the file is affected.
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    return {
      ...realClient,
      // Answers only what it was asked for. A register missing from the table comes back
      // absent, exactly as it would from an inverter that was never asked.
      readModbusRegisters: async (host, port, unitId, registers) => {
        pollTable = registers;
        const out = {};
        for (const name of Object.keys(registers)) out[name] = pollAnswer[name] ?? null;
        return out;
      },
    };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { REGISTERS, pvStringRegisters, MAX_PV_STRINGS } = require('../lib/modbus-registers.js');
const realClient = require('../lib/modbus-client.js');
const { readRegisters, buildReadPlan } = realClient;

// ── the register table ───────────────────────────────────────────────────────

test('pvStringRegisters — PVn sits at 32014 + 2n and 32015 + 2n, as the spec states', () => {
  const t = pvStringRegisters(6);
  for (let n = 3; n <= 6; n++) {
    assert.strictEqual(t[`pv${n}Voltage`][0], 32014 + 2 * n, `PV${n} voltage address`);
    assert.strictEqual(t[`pv${n}Current`][0], 32015 + 2 * n, `PV${n} current address`);
  }
  // Spelled out once rather than only through the formula, so a wrong formula cannot
  // agree with itself.
  assert.strictEqual(t.pv3Voltage[0], 32020);
  assert.strictEqual(t.pv3Current[0], 32021);
  assert.strictEqual(t.pv6Voltage[0], 32026);
  assert.strictEqual(t.pv6Current[0], 32027);
});

test('pvStringRegisters — the added strings are declared exactly like PV1 and PV2', () => {
  const t = pvStringRegisters(4);
  for (const n of [3, 4]) {
    const [, wordsV, typeV, , gainV] = t[`pv${n}Voltage`];
    const [, wordsC, typeC, , gainC] = t[`pv${n}Current`];
    assert.deepStrictEqual([wordsV, typeV, gainV], [1, 'INT16', -1], `PV${n} voltage shape`);
    assert.deepStrictEqual([wordsC, typeC, gainC], [1, 'INT16', -2], `PV${n} current shape`);
  }
  // A wrong scale here is worse than a missing string: 3800 would be published as 3800 V.
  const [, , , , pv1Gain] = REGISTERS.pv1Voltage;
  const [, , , , pv1Cur]  = REGISTERS.pv1Current;
  assert.strictEqual(t.pv3Voltage[4], pv1Gain);
  assert.strictEqual(t.pv3Current[4], pv1Cur);
});

test('pvStringRegisters — starts at three, so PV1 and PV2 are not declared twice', () => {
  const t = pvStringRegisters(24);
  assert.ok(!('pv1Voltage' in t) && !('pv2Voltage' in t), 'it redeclares a static register');
  for (const name of Object.keys(t)) {
    assert.ok(!(name in REGISTERS), `${name} is declared in both tables`);
  }
});

test('pvStringRegisters — an inverter claiming more strings than exist gets 24', () => {
  assert.strictEqual(MAX_PV_STRINGS, 24);
  const t = pvStringRegisters(99);
  assert.strictEqual(Object.keys(t).length, (24 - 2) * 2);
  assert.ok('pv24Current' in t);
  assert.ok(!('pv25Voltage' in t));
  assert.strictEqual(t.pv24Voltage[0], 32062);
  assert.strictEqual(t.pv24Current[0], 32063);
});

test('pvStringRegisters — nothing is added until a count is actually known', () => {
  for (const junk of [0, 1, 2, null, undefined, NaN, -5, 'four', {}]) {
    assert.deepStrictEqual(pvStringRegisters(junk), {}, `${String(junk)} produced registers`);
  }
});

test('the string block ends before the next declared register', () => {
  // PV24 current is 32063 and inputPower is 32064. One register of margin, and no test
  // anywhere else would notice if a future edit moved either of them.
  const last = pvStringRegisters(24).pv24Current[0];
  const addresses = Object.values(REGISTERS).map(([a]) => a).filter((a) => a > last);
  assert.strictEqual(Math.min(...addresses), 32064);
});

test('a two-string inverter is never asked for an address it has no string for', () => {
  const table = { ...REGISTERS, ...pvStringRegisters(0) };
  const spans = buildReadPlan(table).map((group) => [
    Math.min(...group.map((r) => r.start)),
    Math.max(...group.map((r) => r.end)),
  ]);
  // 32020..32063 is PV3..PV24. On a two-string inverter those addresses are unimplemented,
  // and a request that covers one can lose the whole batch it travels in — including PV1
  // and PV2 at 32016..32019.
  for (const [start, end] of spans) {
    assert.ok(start > 32063 || end < 32020,
      `a span covers unrequested string registers: ${start}..${end}`);
  }
});

// ── grid frequency ───────────────────────────────────────────────────────────

test('grid frequency is declared at 32085 as a signed word with gain 100', () => {
  assert.deepStrictEqual(REGISTERS.gridFrequency.slice(0, 3), [32085, 1, 'INT16']);
  assert.strictEqual(REGISTERS.gridFrequency[4], -2);
});

// ── the values that come back ────────────────────────────────────────────────

// Answers readHoldingRegisters from a synthetic memory image, so the assertion is on the
// decoded reading rather than on the table that produced it.
function fakeClient(memory) {
  return {
    async readHoldingRegisters(start, count) {
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.writeUInt16BE((memory[start + i] ?? 0) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  };
}

test('a four-string inverter reads back four strings and 50.00 Hz', async () => {
  const memory = {
    30071: 4,
    32016: 3801, 32017: 512,   // PV1  380.1 V   5.12 A
    32018: 3792, 32019: 498,   // PV2  379.2 V   4.98 A
    32020: 3775, 32021: 503,   // PV3  377.5 V   5.03 A
    32022: 3810, 32023: 487,   // PV4  381.0 V   4.87 A
    32085: 5000,               // 50.00 Hz
  };
  const table = { ...REGISTERS, ...pvStringRegisters(4) };
  const data  = await readRegisters(table, fakeClient(memory));

  assert.strictEqual(data.pvStringCount, 4);
  assert.strictEqual(data.gridFrequency, 50);
  assert.strictEqual(data.pv3Voltage, 377.5);
  assert.strictEqual(data.pv3Current, 5.03);
  assert.strictEqual(data.pv4Voltage, 381);
  assert.strictEqual(data.pv4Current, 4.87);
  // The two that already worked, so the merge cannot have displaced them.
  assert.strictEqual(data.pv1Voltage, 380.1);
  assert.strictEqual(data.pv2Current, 4.98);
});

test('a grid at 49.87 Hz is not rounded to 50', async () => {
  const data = await readRegisters({ gridFrequency: REGISTERS.gridFrequency },
    fakeClient({ 32085: 4987 }));
  assert.strictEqual(data.gridFrequency, 49.87);
});

// ── the driver ───────────────────────────────────────────────────────────────

const SunDevice = require('../drivers/sun2000_modbus/device.js');

// Real method, fake device: capabilities are a plain map and every add is recorded, so a
// test can assert on what the driver asked Homey to do rather than only on the end state.
function makeDevice(caps = {}) {
  const d = Object.create(SunDevice.prototype);
  d.caps  = caps;
  d.calls = [];
  d._pvStringCount = null;
  d.log   = () => {};
  d.error = () => {};
  d.hasCapability    = (c) => c in d.caps;
  d.addCapability    = async (c) => { d.calls.push(`add:${c}`); d.caps[c] = null; };
  d.removeCapability = async (c) => { d.calls.push(`remove:${c}`); delete d.caps[c]; };
  return d;
}

test('_updatePvStringCapabilities — four strings add a row each for PV3 and PV4', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(4);
  assert.deepStrictEqual(d.calls, [
    'add:measure_voltage.pv3', 'add:measure_current.pv3',
    'add:measure_voltage.pv4', 'add:measure_current.pv4',
  ]);
  assert.strictEqual(d._pvStringCount, 4);
});

test('_updatePvStringCapabilities — two strings add nothing at all', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(2);
  assert.deepStrictEqual(d.calls, []);
  assert.strictEqual(d._pvStringCount, 2);
});

test('_updatePvStringCapabilities — a second poll does not add the same rows again', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(3);
  d.calls = [];
  await d._updatePvStringCapabilities(3);
  assert.deepStrictEqual(d.calls, [], 'it re-added capabilities the device already has');
});

// The point of reading the count once. 30071 answers 0 while the inverter restarts, and a
// count taken at face value every poll would strip the extra rows off a working install —
// with them the readings, the Insights logs and anything a flow built on them.
test('_updatePvStringCapabilities — a later empty read does not strip the rows', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(4);
  d.calls = [];
  for (const answer of [0, null, undefined, NaN]) {
    await d._updatePvStringCapabilities(answer);
  }
  assert.deepStrictEqual(d.calls, [], 'a missing count removed capabilities');
  assert.strictEqual(d._pvStringCount, 4);
});

test('_updatePvStringCapabilities — a count of zero is not mistaken for an answer', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(0);
  assert.strictEqual(d._pvStringCount, null, 'zero was accepted as the string count');
  // ...and the next poll, which does answer, is still able to set it.
  await d._updatePvStringCapabilities(3);
  assert.strictEqual(d._pvStringCount, 3);
});

// The other half of reading it once. A count that changes mid-session is not a rewired roof
// — it is a register answering something else — and acting on it would change which
// addresses the next poll asks for, which is the one decision that must not flap.
test('_updatePvStringCapabilities — a later, different count is not acted on either', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(4);
  d.calls = [];
  await d._updatePvStringCapabilities(2);
  assert.strictEqual(d._pvStringCount, 4, 'the string count changed under the running poll');
  assert.deepStrictEqual(d.calls, [], 'capabilities were churned');
  await d._updatePvStringCapabilities(8);
  assert.strictEqual(d._pvStringCount, 4);
});

test('_updatePvStringCapabilities — an implausible count stops at the documented maximum', async () => {
  const d = makeDevice();
  await d._updatePvStringCapabilities(60);
  assert.strictEqual(d._pvStringCount, MAX_PV_STRINGS);
  assert.strictEqual(d.calls.length, (MAX_PV_STRINGS - 2) * 2);
  assert.ok(d.calls.includes('add:measure_current.pv24'));
  assert.ok(!d.calls.some((c) => c.includes('pv25')));
});

// ── a whole poll ────────────────────────────────────────────────────────

// Enough of a Homey device to run _fetchAndUpdate against the fake client above. The
// neighbouring reads (power meter, control registers) are stubbed out: they have their own
// tests and would only add noise here.
function makePollDevice(caps = {}) {
  const d = Object.create(SunDevice.prototype);
  d.caps = caps;
  d.sets = {};
  d.added = [];
  d._fetchInProgress = false;
  d._writeInProgress = false;
  d._failureCount    = 0;
  d._prevDeviceStatus = null;
  d._controlPollCounter = 1;
  d._pvStringCount   = null;
  d.log   = () => {};
  d.error = () => {};
  d.getName    = () => 'Inverter';
  d.getSetting = (k) => ({ address: '10.0.0.5', port: 502, modbus_id: 1,
    enable_timeline_notifications: false }[k]);
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.hasCapability      = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.addCapability      = async (c) => { d.added.push(c); d.caps[c] = null; };
  d.removeCapability   = async (c) => { delete d.caps[c]; };
  d._set = async (c, v) => { if (v !== null && v !== undefined) { d.sets[c] = v; d.caps[c] = v; } };
  d._fetchPowerMeter = async () => {};
  d._fetchControl    = async () => {};
  d._trackPower      = () => {};
  d.homey = {
    __: (k) => k,
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    notifications: { createNotification: async () => {} },
  };
  return d;
}

test('the first poll does not ask for strings the inverter has not reported yet', async () => {
  pollAnswer = { pvStringCount: 4, pv1Voltage: 380.1, gridFrequency: 50 };
  const d = makePollDevice();
  await d._fetchAndUpdate();

  assert.ok(!('pv3Voltage' in pollTable), 'it asked for PV3 before knowing the string count');
  assert.strictEqual(d._pvStringCount, 4, 'the count was not picked up');
  assert.deepStrictEqual(d.added, [
    'measure_voltage.pv3', 'measure_current.pv3',
    'measure_voltage.pv4', 'measure_current.pv4',
  ]);
});

test('the poll after that asks for them, and publishes what comes back', async () => {
  pollAnswer = {
    pvStringCount: 4,
    pv1Voltage: 380.1, pv1Current: 5.12,
    pv2Voltage: 379.2, pv2Current: 4.98,
    pv3Voltage: 377.5, pv3Current: 5.03,
    pv4Voltage: 381.0, pv4Current: 4.87,
    gridFrequency: 49.98,
    inputPower: 3820,
  };
  const d = makePollDevice();
  await d._fetchAndUpdate();   // learns the count
  await d._fetchAndUpdate();   // asks for the strings

  assert.strictEqual(pollTable.pv4Current?.[0], 32023, 'PV4 current was not requested');
  assert.strictEqual(d.sets['measure_voltage.pv3'], 377.5);
  assert.strictEqual(d.sets['measure_current.pv3'], 5.03);
  assert.strictEqual(d.sets['measure_voltage.pv4'], 381);
  assert.strictEqual(d.sets['measure_current.pv4'], 4.87);
  // The first two still arrive, and the reading that was there before all of this.
  assert.strictEqual(d.sets['measure_voltage.pv1'], 380.1);
  assert.strictEqual(d.sets['measure_power'], 3820);
});

test('a poll publishes the grid frequency', async () => {
  pollAnswer = { gridFrequency: 49.98, inputPower: 100 };
  const d = makePollDevice({ measure_frequency: null });
  await d._fetchAndUpdate();
  assert.strictEqual(d.sets.measure_frequency, 49.98);
});

// An inverter that stops answering 30071 must not take the strings down with it: the
// capability is left holding its last reading, the same as every other register here.
test('a string that goes unread leaves its last reading standing', async () => {
  pollAnswer = { pvStringCount: 3, pv3Voltage: 377.5 };
  const d = makePollDevice();
  await d._fetchAndUpdate();
  await d._fetchAndUpdate();
  assert.strictEqual(d.caps['measure_voltage.pv3'], 377.5);

  pollAnswer = { pvStringCount: 3 };   // the string block came back empty
  await d._fetchAndUpdate();
  assert.strictEqual(d.caps['measure_voltage.pv3'], 377.5, 'the reading was cleared');
  assert.ok('pv3Voltage' in pollTable, 'the string stopped being requested');
});

// ── what an existing install is given ───────────────────────────────────────

// A capability added to the manifest reaches a device that is already paired only if
// _ensureCapabilities asks for it. Without that the grid frequency would appear on newly
// added inverters and never on the ones people already have — the kind of gap that is
// invisible in development, where every device is freshly paired.
test('an inverter paired before this version is given every declared capability', async () => {
  const d = makeDevice();
  await d._ensureCapabilities();
  const manifest = app.drivers.find((x) => x.id === 'sun2000_modbus').capabilities;
  for (const cap of manifest) {
    assert.ok(cap in d.caps, `an existing install would never get ${cap}`);
  }
});

test('_ensureCapabilities asks for nothing the manifest does not declare', async () => {
  const d = makeDevice();
  await d._ensureCapabilities();
  const declared = new Set(app.drivers.find((x) => x.id === 'sun2000_modbus').capabilities);
  for (const cap of Object.keys(d.caps)) {
    assert.ok(declared.has(cap), `${cap} is added at init but not declared`);
  }
});

// ── the manifest ─────────────────────────────────────────────────────────────

const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
const driver = app.drivers.find((d) => d.id === 'sun2000_modbus');

test('the Modbus inverter declares the grid frequency it now reads', () => {
  assert.ok(driver.capabilities.includes('measure_frequency'));
  assert.ok(driver.capabilitiesOptions.measure_frequency, 'no title for measure_frequency');
});

// Without these, every string past PV2 appears in the app under the bare capability title —
// four rows all called "Voltage", which is a different kind of missing information.
test('every string the driver can add has a name of its own', () => {
  const titles = new Set();
  for (let n = 1; n <= MAX_PV_STRINGS; n++) {
    for (const kind of ['measure_voltage', 'measure_current']) {
      const opts = driver.capabilitiesOptions[`${kind}.pv${n}`];
      assert.ok(opts, `${kind}.pv${n} has no capabilitiesOptions`);
      for (const lang of ['en', 'de', 'nl']) {
        assert.ok(opts.title?.[lang], `${kind}.pv${n} has no ${lang} title`);
      }
      assert.ok(!titles.has(opts.title.en), `duplicate title: ${opts.title.en}`);
      titles.add(opts.title.en);
    }
  }
});

test('a string the driver cannot add has no leftover entry in the manifest', () => {
  assert.ok(!driver.capabilitiesOptions[`measure_voltage.pv${MAX_PV_STRINGS + 1}`]);
});
