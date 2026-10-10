'use strict';

// The "Instant Charging" switch on the OCPP charger (1.2.325).
//
// It is a one-shot command — 16 A now — behind a switch, which is what puts it on the tile as a
// quick action. The listener ignored the switch's value and nothing turned it back off, so after
// the first tap the next one — switching it off — started 16 A charging again (review
// 2026-10-10). Only "on" acts now, and the switch goes back off by itself.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/ocpp-server') return { getInstance: () => ({}), existing: () => null };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice = require(path.join('..', 'drivers', 'smartcharger_ocpp', 'device.js'));
Module._load = origLoad;

function charger({ refuse = false } = {}) {
  const timers = [];
  const d = Object.create(OcppDevice.prototype);
  d.values = { charge_now: false };
  d.listeners = {};
  d.charged = 0;
  d.log = () => {};
  d.error = () => {};
  d.hasCapability = (c) => c === 'charge_now';
  d.getCapabilityValue = (c) => d.values[c];
  d.setCapabilityValue = async (c, v) => { d.values[c] = v; };
  d.registerCapabilityListener = (c, fn) => { d.listeners[c] = fn; };
  d.chargeNow = async () => {
    if (refuse) throw new Error('No car connected — plug in first, then Charge Now.');
    d.charged++;
  };
  d.homey = {
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  d.timers = timers;
  // What Homey does with a tap: run the listener, store the value only once it resolved.
  d.tap = async (value) => {
    await d.listeners.charge_now(value);
    d.values.charge_now = value;
  };
  d.later = () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } };
  return d;
}

// The listeners are registered in one method; only the one under test is wanted here.
function listen(d) {
  const keep = d.registerCapabilityListener;
  d.registerCapabilityListener = (c, fn) => { if (c === 'charge_now') keep(c, fn); };
  d.registerMultipleCapabilityListener = () => {};
  d.homey.flow = { getActionCard: () => ({ registerRunListener() {} }), getConditionCard: () => ({ registerRunListener() {} }) };
  d._registerCapabilityListeners();
}

test('switching it on charges at 16 A, and the switch goes back off by itself', async () => {
  const d = charger();
  listen(d);
  await d.tap(true);
  assert.strictEqual(d.charged, 1);
  assert.strictEqual(d.values.charge_now, true, 'Homey shows the tap for a moment');
  d.later();
  assert.strictEqual(d.values.charge_now, false);
});

test('switching it off is not a second "charge now"', async () => {
  const d = charger();
  listen(d);
  d.values.charge_now = true;                    // as an earlier version left it
  await d.tap(false);
  assert.strictEqual(d.charged, 0, 'turning the switch off started 16 A charging');
});

test('two taps are two commands, not one command and one stop', async () => {
  const d = charger();
  listen(d);
  await d.tap(true);
  d.later();
  await d.tap(true);
  assert.strictEqual(d.charged, 2);
});

test('a refused tap leaves the switch off and says why', async () => {
  const d = charger({ refuse: true });
  listen(d);
  await assert.rejects(d.listeners.charge_now(true), /No car connected/);
  d.later();
  assert.strictEqual(d.values.charge_now, false);
});

test('the reset waits until Homey has stored the tap, and is dropped with the device', async () => {
  const d = charger();
  listen(d);
  await d.tap(true);
  const t = d.timers.find((x) => x.live);
  assert.ok(t && t.ms >= 500, 'turned off inside the listener, Homey would overwrite it with "on"');
  d._clearIdleGuard = () => {};
  d._clearTimers();
  assert.strictEqual(t.live, false);
});

test('a switch left on by an earlier version starts from off, before the listener is in place', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8').replace(/\r\n/g, '\n');
  const init = src.slice(src.indexOf('  async onInit() {'), src.indexOf('  async onSettings('));
  const reset = init.indexOf("this.getCapabilityValue('charge_now') === true");
  const listen = init.indexOf('this._registerCapabilityListeners();');
  assert.ok(reset > 0, 'onInit no longer turns a stuck switch off');
  assert.ok(reset < listen);
  assert.match(init, /await this\.setCapabilityValue\('charge_now', false\)/);
});
