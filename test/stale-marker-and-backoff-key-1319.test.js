'use strict';

// 1.3.19 — two fixes from forum logs on 1.3.18.
//
// 1. Log 9bf89137: a SUN2000 behind a SDongle A without a Huawei meter. The dongle never has a
//    grid or house power, and 1.3.16 keeps the last reading when there is none — but the last
//    reading stored by an earlier version was the marker itself, 2147483647 W, so it stood on
//    the tile for good. A stored marker is now cleared; a real last reading still stays.
//
// 2. Log 25183824: an unreachable SDongle wrote an error line every minute for 17 h. The
//    circuit breaker's "backing off … (last: <fault>)" alternated with "<fault>" and re-armed
//    the error throttle on every poll. The wrapped fault now counts as the same failure.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const { logPollError, ERROR_ALWAYS_FIRST } = require(path.join(ROOT, 'lib', 'poll-log.js'));

let reply = {};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return { ...real, readModbusRegisters: async () => ({ ...reply }) };
  }
  return origLoad.call(this, request, parent, isMain);
};
const SdongleDevice = require(path.join(ROOT, 'drivers', 'sdongle_a_modbus', 'device.js'));
Module._load = origLoad;

const CAPS = ['measure_power', 'measure_power.solar', 'measure_power.grid_active_power', 'measure_power.battery', 'measure_power.active_power'];

function sdongle(caps = {}) {
  const d = Object.create(SdongleDevice.prototype);
  d.caps = { ...caps };
  d.writes = [];
  d.logs = [];
  d.settings = { address: '192.0.2.5', port: 502, modbus_id: 100 };
  d.homey = { __: (k) => k };
  d.getSetting = (k) => d.settings[k];
  d.hasCapability = (c) => CAPS.includes(c);
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.writes.push([c, v]); d.caps[c] = v; };
  d.getCapabilities = () => CAPS;
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._updateEnergyWarning = async () => {};
  d._failureCount = 0;
  d._fetchInProgress = false;
  return d;
}

// loadPower is UINT32, so its marker is 0xFFFFFFFF; gridPower is INT32 (0x7FFFFFFF).
const NO_METER = { totalInputPower: 3456, loadPower: 0xFFFFFFFF, gridPower: 0x7FFFFFFF, batteryPower: 0, totalActivePower: 3300 };

// ── 1. stored marker ─────────────────────────────────────────────────────────

test('the field log: a marker stored by an earlier version is cleared, not kept for good', async () => {
  const d = sdongle({ 'measure_power': 4294967295, 'measure_power.grid_active_power': 2147483647 });
  reply = { ...NO_METER };
  await d._fetchAndUpdate();
  assert.strictEqual(d.caps['measure_power.grid_active_power'], null);
  assert.strictEqual(d.caps['measure_power'], null);
  assert.strictEqual(d.caps['measure_power.solar'], 3456, 'the powers the dongle does have are written as before');
  assert.ok(d.logs.some((l) => /Cleared measure_power\.grid_active_power: it still held 2147483647/.test(l)), d.logs.join('\n'));
});

test('every marker an earlier version could have stored is recognised, either sign', async () => {
  for (const marker of [2147483647, -2147483647, -2147483648, 4294967295]) {
    const d = sdongle({ 'measure_power.grid_active_power': marker });
    reply = { ...NO_METER };
    await d._fetchAndUpdate();
    assert.strictEqual(d.caps['measure_power.grid_active_power'], null, String(marker));
  }
});

test('a real last reading is still kept when the dongle has no value (1.3.16 unchanged)', async () => {
  for (const real of [-1800, 0, 2147483646, -2147483646]) {
    const d = sdongle({ 'measure_power.grid_active_power': real });
    reply = { ...NO_METER };
    await d._fetchAndUpdate();
    assert.strictEqual(d.caps['measure_power.grid_active_power'], real, String(real));
  }
});

test('cleared once: later polls without a value neither write nor log again', async () => {
  const d = sdongle({ 'measure_power.grid_active_power': 2147483647 });
  reply = { ...NO_METER };
  for (let i = 0; i < 5; i++) await d._fetchAndUpdate();
  assert.strictEqual(d.writes.filter(([c]) => c === 'measure_power.grid_active_power').length, 1);
  assert.strictEqual(d.logs.filter((l) => l.startsWith('Cleared')).length, 1);
});

test('a marker is only cleared when the dongle has no value — a real value simply replaces it', async () => {
  const d = sdongle({ 'measure_power.grid_active_power': 2147483647 });
  reply = { ...NO_METER, gridPower: -3180 };
  await d._fetchAndUpdate();
  assert.deepStrictEqual(d.writes.filter(([c]) => c === 'measure_power.grid_active_power'), [['measure_power.grid_active_power', -3180]]);
  assert.ok(!d.logs.some((l) => l.startsWith('Cleared')));
});

test('a failing clear is logged and the poll carries on', async () => {
  const d = sdongle({ 'measure_power.grid_active_power': 2147483647 });
  const set = d.setCapabilityValue;
  d.setCapabilityValue = async (c, v) => { if (v === null) throw new Error('nope'); return set(c, v); };
  reply = { ...NO_METER };
  await d._fetchAndUpdate();
  assert.ok(d.logs.some((l) => /Clearing measure_power\.grid_active_power failed: nope/.test(l)), d.logs.join('\n'));
  assert.strictEqual(d.caps['measure_power.solar'], 3456);
  assert.strictEqual(d._failureCount, 0);
});

// ── 2. backoff wrapper in the error throttle ─────────────────────────────────

function makeDevice() {
  const errors = [];
  return { errors, error: (l) => errors.push(l) };
}

const FAULT   = 'Socket error: connect EHOSTUNREACH 192.168.1.51:502';
const BACKOFF = `192.168.1.51:502 failed 3 polls in a row — backing off, will retry shortly (last: ${FAULT})`;

test('the field log: an outage with the breaker\'s line every fourth poll is throttled like any other', () => {
  const d = makeDevice();
  // One poll a minute, every fourth answered by the circuit breaker — as in log 25183824.
  const minutes = 1000;
  for (let i = 1; i <= minutes; i++) {
    const msg = i % 4 === 0 ? BACKOFF : FAULT;
    logPollError(d, `Fetch error (${i}): ${msg}`, msg, i * 60_000);
  }
  // Before: 1000 lines. Now: the first three plus one heartbeat per 15 minutes.
  assert.ok(d.errors.length <= ERROR_ALWAYS_FIRST + Math.ceil(minutes / 15), String(d.errors.length));
  assert.ok(d.errors.length >= ERROR_ALWAYS_FIRST + 60, String(d.errors.length));
});

test('the breaker line still shows in full when it is the one written', () => {
  const d = makeDevice();
  logPollError(d, `Fetch error (1): ${BACKOFF}`, BACKOFF, 60_000);
  assert.deepStrictEqual(d.errors, [`Fetch error (1): ${BACKOFF}`]);
});

test('a breaker line wrapping a different fault is a different failure', () => {
  const d = makeDevice();
  for (let i = 1; i <= 5; i++) logPollError(d, `e${i}`, FAULT, i * 60_000);
  assert.strictEqual(d.errors.length, 3);
  const other = '192.168.1.51:502 failed 3 polls in a row — backing off, will retry shortly (last: Connection to 192.168.1.51:502 timed out)';
  logPollError(d, 'e6', other, 6 * 60_000);
  assert.strictEqual(d.errors.length, 4);
});

test('a breaker line without a wrapped fault keeps its own key', () => {
  const d = makeDevice();
  for (let i = 1; i <= 5; i++) logPollError(d, `e${i}`, FAULT, i * 60_000);
  logPollError(d, 'e6', '192.168.1.51:502 failed 3 polls in a row — backing off, will retry shortly', 6 * 60_000);
  assert.strictEqual(d.errors.length, 4);
});

test('the breaker message the client builds is the one the throttle unwraps', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'lib', 'modbus-client.js'), 'utf8');
  assert.match(src, /backing off, will retry shortly\$\{last \? ` \(last: \$\{last\.message\}\)` : ''\}/);
});

// ── release ──────────────────────────────────────────────────────────────────

test('the release: version 1.3.19 or later, both fixes in the changelog', () => {
  const app = require(path.join(ROOT, 'app.json'));
  const [ma, mi, pa] = app.version.split('.').map(Number);
  assert.ok(ma * 1e6 + mi * 1e3 + pa >= 1003019, app.version);
  const log = require(path.join(ROOT, '.homeychangelog.json'))['1.3.19'];
  assert.ok(log, 'no changelog entry for 1.3.19');
  for (const l of ['en', 'de', 'nl']) {
    assert.match(log[l], /SDongle/, l);
    assert.match(log[l], /2147483647/, l);
  }
});
