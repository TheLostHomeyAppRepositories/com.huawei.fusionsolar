'use strict';

// The EMMA charger and the values it was not given (review 2026-10-10, 1.2.321).
//
// This charger has no register that says "a cable is plugged in". Until 1.3.8 the state came
// from the phase voltages, and a voltage that was not read — a poll cut short by a flow card
// writing to another device on the same EMMA, a batch that timed out — came back null, and
// `?? 0` made it 0 V. In the middle of a charge that read as the car being unplugged:
// "charging stopped" fired, the session ended, and the next poll started both again.
//
// Since 1.3.8 the state comes from the lifetime energy counter (emma-charger-state-138), and
// the rule moved with it: a counter that was not read has not stood still.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const realClient = require(path.join('..', 'lib', 'modbus-client.js'));

// Each poll hands out the next canned read.
let reads = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    return { ...realClient, readModbusRegisters: async () => reads.shift() };
  }
  return origLoad.call(this, request, parent, isMain);
};
const ChargerDevice = require(path.join('..', 'drivers', 'smartcharger_emma_modbus', 'device.js'));
Module._load = origLoad;

// The device's clock, moved by each poll.
const T0 = 1_800_000_000_000;
let now = T0;
const realNow = Date.now;
Date.now = () => now;
test.after(() => { Date.now = realNow; });

// A read result shaped as the real client returns it: values, plus the non-enumerable set of
// registers that were not read.
function read({ volts = [230, 231, 229], kwh = 100, unread = [] } = {}) {
  const r = {
    offeringName: 'SCharger-7KS-S0', ratedPower: 7.4,
    phaseAVoltage: volts[0], phaseBVoltage: volts[1], phaseCVoltage: volts[2],
    totalEnergyCharged: kwh, chargerTemperature: 31,
  };
  for (const k of unread) r[k] = null;
  Object.defineProperty(r, 'unread', { value: new Set(unread), enumerable: false });
  return r;
}
const CUT = ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage', 'totalEnergyCharged', 'chargerTemperature'];

function fakeCharger() {
  const d = Object.create(ChargerDevice.prototype);
  d.values = {};
  d.fired = [];
  d.logs = [];
  d.store = {};
  d._failureCount = 0;
  d._prevChargingState = null;
  d._lastPollStart = 0;
  d._sessionStartedAt = null;
  d._sessionMeterStartKwh = null;
  d._lastMeterKwh = null;
  d._meterStep = null;
  d._lastStepAt = null;
  d._powerBasis = null;
  d._powerEstW = 0;
  d._stillSince = null;
  d._counterRunning = null;
  d._stepFromKwh = null;
  d._meterUnread = 0;
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = () => {};
  d.getName = () => 'EMMA charger';
  d.getSetting = (k) => ({ address: '192.168.1.10', port: 502, modbus_id: 0 }[k]);
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.hasCapability = () => true;
  d.getCapabilityValue = (c) => d.values[c] ?? null;
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.values[c] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = {
    __: (k) => k,
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async () => { d.fired.push(id); } }) },
  };
  // One poll every 30 s from the clock's start, each handed the next read.
  d.t = 0;
  d.poll = async (...results) => {
    for (const r of results) { now = T0 + d.t * 1000; d.t += 30; reads.push(r); await d._fetchAndUpdate(); }
  };
  return d;
}

const sessionsStarted = (d) => d.logs.filter((l) => /Session started/.test(l)).length;
// Two polls whose counter steps: the charge is under way.
const charging = (d) => d.poll(read({ kwh: 100 }), read({ kwh: 100.1 }));

test('a poll that did not read the counter does not end a charge', async () => {
  const d = fakeCharger();
  await charging(d);
  const startedAt = d._sessionStartedAt;
  assert.ok(startedAt);
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
  await d.poll(read({ unread: CUT }));                  // cut short by a write elsewhere
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started'], 'a trigger fired on a poll that read nothing about the car');
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.strictEqual(d.values.evcharger_charging, true);
  assert.strictEqual(d._sessionStartedAt, startedAt, 'the session was ended');
  await d.poll(read({ kwh: 100.3 }));
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started'], 'no "stopped", no second "started" — one charge');
  assert.strictEqual(sessionsStarted(d), 1, 'one charge, two sessions');
});

test('voltages that were not read say nothing — the counter goes on deciding', async () => {
  const d = fakeCharger();
  await charging(d);
  await d.poll(read({ volts: [0, null, null], kwh: 100.2, unread: ['phaseBVoltage', 'phaseCVoltage'] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging',
    'one phase at 0 V and two not read were taken for an unplug');
  await d.poll(read({ volts: [null, null, null], kwh: 100.3, unread: ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage'] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
});

test('an idle charger stays idle across a cut poll — it is not "started" either', async () => {
  const d = fakeCharger();
  await d.poll(read({ volts: [0, 0, 0] }), read({ unread: CUT }), read({ volts: [0, 0, 0] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.deepStrictEqual(d.fired, []);
  assert.strictEqual(d.values.measure_power, 0);
});

test('a real unplug is still seen, on the first poll that reads it', async () => {
  const d = fakeCharger();
  await charging(d);
  await d.poll(read({ unread: CUT }), read({ volts: [0, 0, 0], kwh: 100.1 }));
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started', 'smartcharger_charging_stopped']);
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.strictEqual(d._sessionStartedAt, null);
});

test('a counter that stays unread is given up on after three polls, and that is logged', async () => {
  const d = fakeCharger();
  await charging(d);
  await d.poll(read({ unread: CUT }), read({ unread: CUT }));
  d._pollLogAt = undefined;                              // let the next "Poll OK" line through
  await d.poll(read({ unread: CUT }));
  assert.match(d.logs.at(-1), /^Poll OK: state=charging \(energy counter not read, 3\/3 — last state kept\)/);
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started'], 'three cut polls are still held');
  await d.poll(read({ unread: CUT }));
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started', 'smartcharger_charging_stopped']);
  assert.ok(d.logs.some((l) => /Energy counter not read for 4 polls — taking the charger as not charging/.test(l)));
  // and a good read whose counter has moved starts the count — and the charge — again
  await d.poll(read({ kwh: 100.4 }), read({ unread: CUT }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started', 'smartcharger_charging_stopped', 'smartcharger_charging_started']);
});

test('only the counter counts as missing: voltages alone not read change nothing', async () => {
  const volts = ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage'];
  const d = fakeCharger();
  await charging(d);
  for (let i = 0; i < 6; i++) await d.poll(read({ kwh: 100.2 + i / 10, unread: volts }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
  assert.ok(!d.logs.some((l) => /not read for/.test(l)));
});

test('the first poll after a start that cannot read the counter leaves the restored session alone', async () => {
  const d = fakeCharger();
  d._sessionStartedAt = T0 - 3600_000;                   // restored from the store in onInit
  d._sessionMeterStartKwh = 90;
  d.store.mbSession = { startedAt: d._sessionStartedAt, meterStartKwh: 90 };
  await d.poll(read({ unread: CUT }));
  assert.ok(d._sessionStartedAt, 'nothing was known, and the session was ended anyway');
  assert.ok(d.store.mbSession);
  assert.strictEqual(d.values.evcharger_charging_state, undefined, 'a state was invented');
  await d.poll(read({ kwh: 100.2 }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.strictEqual(sessionsStarted(d), 0, 'the restored session goes on rather than a new one');
});

test('the power the counter shows is not zeroed while the voltages are not read', async () => {
  // Since 1.3.6 the estimate runs from one step of the counter to a later one, two minutes
  // or more apart (emma-charger-136.test.js).
  const volts = ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage'];
  const d = fakeCharger();
  await d.poll(read({ kwh: 100, unread: volts }));
  await d.poll(read({ kwh: 100.05, unread: volts }));   // the counter steps: the span starts
  d.t += 90;                                             // two minutes after that step …
  await d.poll(read({ kwh: 100.25, unread: volts }));   // … 200 Wh more
  assert.ok(d.values.measure_power > 5900 && d.values.measure_power <= 6000,
    `measure_power ${d.values.measure_power} W — 200 Wh in 120 s is 6 kW`);
});

test('a phase the EMMA does not have still reads as 0 V, as before', async () => {
  // Exception 2 is "not there", not "not read": the client leaves it out of `unread`.
  const d = fakeCharger();
  await charging(d);
  await d.poll(read({ volts: [0, null, null], kwh: 100.1 }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started', 'smartcharger_charging_stopped']);
});
