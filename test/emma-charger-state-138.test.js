'use strict';

// The Smart Charger behind an EMMA: whether it is charging (1.3.8).
// Run: node --test
//
// Log 72d9130e (Thomas_Scherzinger, 1.3.7, 2026-10-27): the charger answers on unit ID 24 as
// "FusionCharge", 22 kW, and every register reads. The first poll already said
// "state=charging, P≈0 W, meter 10.525 kWh", with no car. Charging was any phase above 10 V,
// and this charger reports its supply voltage whether a car draws or not. Its register table
// has no state, no cable and no current — only the lifetime counter tells a charge, by rising.
//
// Andi: "Ja, A bauen".

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const realClient = require(path.join('..', 'lib', 'modbus-client.js'));

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

const T0 = 1_800_000_000_000;
let now = T0;
const realNow = Date.now;
Date.now = () => now;
test.after(() => { Date.now = realNow; });

// What unit 24 answered in log 72d9130e: the supply voltage on all three phases.
function read({ volts = [231.4, 229.8, 232.1], kwh = 10.525, unread = [] } = {}) {
  const r = {
    offeringName: 'FusionCharge', ratedPower: 22,
    phaseAVoltage: volts[0], phaseBVoltage: volts[1], phaseCVoltage: volts[2],
    totalEnergyCharged: kwh, chargerTemperature: 18.5,
  };
  for (const k of unread) r[k] = null;
  Object.defineProperty(r, 'unread', { value: new Set(unread), enumerable: false });
  Object.defineProperty(r, 'refusedByDevice', { value: new Set(), enumerable: false });
  return r;
}

function fakeCharger() {
  const d = Object.create(ChargerDevice.prototype);
  Object.assign(d, {
    values: {}, fired: [], logs: [], store: {}, unavailable: null,
    _failureCount: 0, _prevChargingState: null, _lastPollStart: 0,
    _sessionStartedAt: null, _sessionMeterStartKwh: null,
    _lastMeterKwh: null, _meterStep: null, _lastStepAt: null, _powerBasis: null, _powerEstW: 0,
    _stillSince: null, _counterRunning: null, _stepFromKwh: null, _meterUnread: 0,
  });
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = () => {};
  d.getName = () => 'Smart Charger (EMMA Modbus)';
  d.getSetting = (k) => ({ address: '192.168.178.43', port: 502, modbus_id: 24 }[k]);
  d.getAvailable = () => d.unavailable === null;
  d.setAvailable = async () => { d.unavailable = null; };
  d.setUnavailable = async (m) => { d.unavailable = m; };
  d.hasCapability = () => true;
  d.getCapabilityValue = (c) => d.values[c] ?? null;
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.values[c] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = {
    __: (k) => k,
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async () => { d.fired.push(id); } }) },
  };
  // A poll at `s` seconds from the clock's start.
  d.at = async (s, r) => { now = T0 + s * 1000; reads.push(r); await d._fetchAndUpdate(); };
  return d;
}

const state = (d) => d.values.evcharger_charging_state;
const kwhAt = (wattsFrom, s, stepWh = 1) => (10_525 + Math.floor(wattsFrom * s / 3600 / stepWh) * stepWh) / 1000;

test('log 72d9130e: supply voltage on all three phases and a counter that stands still is no charge', async () => {
  const d = fakeCharger();
  for (let s = 0; s <= 30 * 60; s += 30) {
    await d.at(s, read());
    assert.strictEqual(state(d), 'plugged_out', `"charging" at ${s} s with no car`);
  }
  assert.strictEqual(d.values.evcharger_charging, false);
  assert.strictEqual(d.values.measure_power, 0);
  assert.deepStrictEqual(d.fired, []);
  assert.strictEqual(d._sessionStartedAt, null);
  assert.ok(!d.logs.some((l) => /Session started/.test(l)));
  assert.match(d.logs[0], /^Poll OK: state=idle, P≈0 W, meter 10\.525 kWh$/);
});

test('the counter\'s first rise starts the charge, and its energy counts from the reading before', async () => {
  const d = fakeCharger();
  await d.at(0, read());
  await d.at(30, read());
  await d.at(60, read({ kwh: 10.533 }));                    // the car begins to draw
  assert.strictEqual(state(d), 'plugged_in_charging');
  assert.strictEqual(d.values.evcharger_charging, true);
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
  assert.strictEqual(d._sessionMeterStartKwh, 10.525, 'the first step was left out of the session');
});

test('a charge ends once the counter has stood still for six minutes — not sooner, and only once', async () => {
  const d = fakeCharger();
  let s = 0;
  for (; s <= 20 * 60; s += 30) await d.at(s, read({ kwh: kwhAt(11_000, s) }));   // 11 kW, 1 Wh counter
  const lastStep = s - 30;
  const kwh = kwhAt(11_000, lastStep);
  assert.ok(d.values.measure_power > 10_500 && d.values.measure_power < 11_500, `${d.values.measure_power} W`);
  for (; s <= lastStep + 360; s += 30) {
    await d.at(s, read({ kwh }));
    assert.strictEqual(state(d), 'plugged_in_charging', `ended ${s - lastStep} s after the last step`);
  }
  await d.at(lastStep + 390, read({ kwh }));
  assert.strictEqual(state(d), 'plugged_out');
  assert.strictEqual(d.values.measure_power, 0);
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started', 'smartcharger_charging_stopped']);
  assert.strictEqual(d._sessionStartedAt, null);
});

test('a slow charge in 0.1 kWh steps (1.4 kW, a step every 4.3 minutes) is one charge, not one per step', async () => {
  const d = fakeCharger();
  for (let s = 0; s <= 90 * 60; s += 30) {
    await d.at(s, read({ kwh: kwhAt(1_400, s, 100) }));
    if (s >= 300) assert.strictEqual(state(d), 'plugged_in_charging', `not charging at ${s} s`);
  }
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
  assert.strictEqual(d.logs.filter((l) => /Session started/.test(l)).length, 1);
});

test('a car that tapers off — steps further apart than twice the last span — is still charging', async () => {
  const d = fakeCharger();
  await d.at(0,   read({ kwh: 10.5 }));
  await d.at(30,  read({ kwh: 10.6 }));
  await d.at(150, read({ kwh: 11.0 }));                     // 0.4 kWh in 120 s: 12 kW
  for (let s = 180; s <= 450; s += 30) await d.at(s, read({ kwh: 11.0 }));
  assert.strictEqual(d.values.measure_power, 0, 'the estimate has dropped, as it did before');
  assert.strictEqual(state(d), 'plugged_in_charging', 'the charge ended with the estimate');
  await d.at(480, read({ kwh: 11.1 }));                     // the next step, 5.5 minutes on
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
});

test('a very slow charge waits twice its last span, even past six minutes', async () => {
  // 0.1 kWh steps 300 s apart (1.2 kW), then one 420 s after that: the car draws less.
  const d = fakeCharger();
  const steps = { 30: 10.6, 330: 10.7, 750: 10.8 };
  let kwh = 10.5;
  for (let s = 0; s <= 780; s += 30) {
    kwh = steps[s] ?? kwh;
    await d.at(s, read({ kwh }));
    if (s >= 30) assert.strictEqual(state(d), 'plugged_in_charging', `ended at ${s} s, ${s - 330} s after a 300 s span`);
  }
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
});

test('a charger whose EMMA has no voltage registers at all still charges by its counter', async () => {
  // Exception 2 on all three: null, and not "not read" — 0 V each, but no phase was read.
  const d = fakeCharger();
  await d.at(0,  read({ kwh: 10.5, volts: [null, null, null] }));
  await d.at(30, read({ kwh: 10.6, volts: [null, null, null] }));
  assert.strictEqual(state(d), 'plugged_in_charging', 'three missing phases were taken for 0 V');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
});

test('after a restart, a charge the store says was running goes on until the counter says', async () => {
  const restored = () => {
    const d = fakeCharger();
    d._sessionStartedAt = T0 - 3600_000;
    d._sessionMeterStartKwh = 10.0;
    d.store.mbSession = { startedAt: d._sessionStartedAt, meterStartKwh: 10.0 };
    return d;
  };
  // the counter moves: the same session goes on
  let d = restored();
  await d.at(0, read({ kwh: 10.6 }));
  assert.strictEqual(state(d), 'plugged_in_charging');
  await d.at(30, read({ kwh: 10.7 }));
  assert.strictEqual(state(d), 'plugged_in_charging');
  assert.deepStrictEqual(d.fired, []);
  assert.strictEqual(d._sessionMeterStartKwh, 10.0);
  assert.ok(!d.logs.some((l) => /Session (started|ended)/.test(l)));
  // the counter stands still: the session ends once it has for six minutes
  d = restored();
  for (let s = 0; s <= 360; s += 30) {
    await d.at(s, read({ kwh: 10.6 }));
    assert.strictEqual(state(d), 'plugged_in_charging', `ended at ${s} s`);
  }
  await d.at(390, read({ kwh: 10.6 }));
  assert.strictEqual(state(d), 'plugged_out');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_stopped']);
  assert.strictEqual(d.store.mbSession, null);
});

test('three phases at 0 V end a charge at once, whatever the counter last did', async () => {
  const d = fakeCharger();
  await d.at(0,  read({ kwh: 10.5 }));
  await d.at(30, read({ kwh: 10.6 }));
  assert.strictEqual(state(d), 'plugged_in_charging');
  await d.at(60, read({ kwh: 10.6, volts: [0, 0, 0] }));
  assert.strictEqual(state(d), 'plugged_out');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started', 'smartcharger_charging_stopped']);
  // and the voltages coming back is no charge either: the counter has not moved
  await d.at(90, read({ kwh: 10.6 }));
  assert.strictEqual(state(d), 'plugged_out');
});

test('a counter that went back (replaced, reset) is no charge', async () => {
  const d = fakeCharger();
  await d.at(0,  read({ kwh: 10.5 }));
  await d.at(30, read({ kwh: 0.0 }));
  await d.at(60, read({ kwh: 0.0 }));
  assert.strictEqual(state(d), 'plugged_out');
  assert.deepStrictEqual(d.fired, []);
  await d.at(90, read({ kwh: 0.1 }));
  assert.strictEqual(state(d), 'plugged_in_charging');
});

test('the two trigger cards say the counter decides, in all three languages', () => {
  const app = require(path.join('..', 'app.json'));
  for (const id of ['smartcharger_charging_started', 'smartcharger_charging_stopped']) {
    const card = app.flow.triggers.find((c) => c.id === id);
    assert.ok(card, id);
    assert.match(card.hint.en, /energy counter/, `${id} en`);
    assert.match(card.hint.de, /Energiezähler/, `${id} de`);
    assert.match(card.hint.nl, /energieteller/, `${id} nl`);
    for (const lang of ['en', 'de', 'nl']) {
      assert.doesNotMatch(card.hint[lang], /10 V/, `${id} ${lang}: still the voltage rule`);
      assert.doesNotMatch(card.hint[lang], /Home Assistant/i, `${id} ${lang}`);
    }
  }
});
