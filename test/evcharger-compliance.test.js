'use strict';

// Both EV chargers against Homey's energy rules. Run: node --test
//
// Checked against apps.developer.homey.app/the-basics/devices/energy, section "EV chargers".
// Three things came out of that reading:
//
//   1. The EMMA charger wrote its own words into evcharger_charging_state — 'charging' and
//      'idle' — exactly as the OCPP driver did before 1.2.201. Homey accepts five words and
//      neither is among them, so the capability was never set on any installation. Its own
//      widget then read the value back, found null, and reported "not connected" for the
//      whole of a live charging session.
//   2. The OCPP driver's target_power dead zone was fixed at the single-phase figures. The
//      documentation's own example scales both the step and the exclude range with the
//      phase count: 1380 / 2760 / 4140 W.
//   3. The EMMA charger had no evcharger_charging at all. It is read-only over Modbus, so
//      it is declared here as a non-setable capability rather than as a switch that cannot
//      switch.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

// Homey's enum, verbatim from the rejection a charger owner's log carried.
const HOMEY_ENUM = [
  'plugged_in_charging', 'plugged_in_discharging', 'plugged_in_paused',
  'plugged_in', 'plugged_out',
];

const CHARGERS = ['smartcharger_ocpp', 'smartcharger_emma_modbus'];
const driver = (id) => APP.drivers.find((d) => d.id === id);

test('both chargers carry what the documentation asks of an EV charger', () => {
  for (const id of CHARGERS) {
    const d = driver(id);
    assert.ok(d, `${id} is gone`);
    assert.strictEqual(d.class, 'evcharger', `${id}: class must be evcharger`);
    assert.strictEqual((d.energy || {}).evCharger, true,
      `${id}: energy.evCharger is what marks this device as a charger to Homey`);
    for (const cap of ['measure_power', 'evcharger_charging', 'evcharger_charging_state']) {
      assert.ok((d.capabilities || []).includes(cap), `${id}: ${cap} is missing`);
    }
    const em = d.energy.meterPowerImportedCapability;
    assert.ok(em && d.capabilities.includes(em),
      `${id}: the charged-energy meter is not declared, or points at nothing`);
  }
});

// A read-only driver must not offer a switch it cannot honour. It has no write path of any
// kind — no Modbus writes, no capability listeners — so the capability is declared for the
// state and the Flow condition Homey generates from it, and marked non-setable.
test('the Modbus charger says plainly that its switch cannot be switched', () => {
  const d = driver('smartcharger_emma_modbus');
  const opt = (d.capabilitiesOptions || {})['evcharger_charging'];
  assert.ok(opt, 'evcharger_charging has no options, so Homey will offer it as a switch');
  assert.strictEqual(opt.setable, false,
    'this driver has no write path at all; a settable switch would silently do nothing');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'smartcharger_emma_modbus', 'device.js'), 'utf8');
  assert.doesNotMatch(src, /registerCapabilityListener/,
    'a capability listener appeared — if the charger can now be controlled, setable: false '
    + 'is no longer the honest declaration');
});

// A declared capability nobody writes is a tile that reads "-" for ever. Both are written
// from the same derived state, so they cannot drift apart into disagreeing about whether
// the car is charging.
test('the Modbus charger fills both charging capabilities from one signal', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'smartcharger_emma_modbus', 'device.js'), 'utf8');
  assert.match(src, /_set\('evcharger_charging',\s*chargingState === 'charging'\)/,
    'evcharger_charging is declared but never written, so the tile stays empty');
  assert.match(src, /_set\('evcharger_charging_state',\s*HOMEY_EV_STATE\[chargingState\]\)/,
    'the state capability is no longer written from the same derived value');
});

// ─── The enum, in the driver that still had the bug ─────────────────────────

test('the Modbus charger writes only words Homey accepts', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'smartcharger_emma_modbus', 'device.js'), 'utf8');
  const map = src.match(/const HOMEY_EV_STATE = \{[\s\S]*?\};/);
  assert.ok(map, 'the translation is gone — the driver is writing its own vocabulary again');
  // eslint-disable-next-line no-new-func
  const states = new Function(`${map[0]}\nreturn HOMEY_EV_STATE;`)();
  for (const [internal, homey] of Object.entries(states)) {
    assert.ok(HOMEY_ENUM.includes(homey),
      `"${internal}" would write "${homey}", which Homey rejects outright`);
  }
  assert.strictEqual(states.charging, 'plugged_in_charging');
  assert.strictEqual(states.idle, 'plugged_out');

  const direct = [...src.matchAll(/_set\('evcharger_charging_state',\s*([^)]*)\)/g)]
    .map((m) => m[1].trim());
  assert.deepStrictEqual(direct, ['HOMEY_EV_STATE[chargingState]'],
    `the capability is written directly as ${direct.join(', ')} instead of through the map`);
});

// The consequence that made the bug visible: the widget compared against a value the
// capability could never hold.
test('the widget compares against the value the capability actually holds', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'smartcharger_emma_modbus', 'device.js'), 'utf8');
  // The definition, not the first mention of the name — the comment above it says
  // "getWidgetStatus()" too, and anchoring there sliced the wrong four hundred characters.
  const at = src.indexOf('\n  getWidgetStatus() {');
  assert.ok(at > 0, 'getWidgetStatus is gone or renamed');
  const end = src.indexOf('\n  }\n', at);
  assert.ok(end > at, 'the end of getWidgetStatus could not be found');
  const fn = src.slice(at, end); // the whole method: a fixed window cut off the comparison
  assert.doesNotMatch(fn, /state === 'charging'/,
    'the widget checks for a word the capability never contains, so it reports '
    + '"not connected" throughout a charging session');
  assert.match(fn, /state === HOMEY_EV_STATE\.charging/,
    'the widget no longer derives its status from the charging state');
});

// ─── The dead zone, phase by phase ──────────────────────────────────────────

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice = require(path.join('..', 'drivers', 'smartcharger_ocpp', 'device.js'));
Module._load = origLoad;

function fakeOcpp(phases) {
  const d = Object.create(OcppDevice.prototype);
  d.applied = null;
  d.log = () => {};
  d.error = () => {};
  d.getSetting = (k) => (k === 'number_of_phases' ? String(phases) : undefined);
  d.hasCapability = () => true;
  d.getCapabilityOptions = () => ({ title: { en: 'Target Charging Power' } });
  d.setCapabilityOptions = async (_cap, opts) => { d.applied = opts; };
  return d;
}

test('the dead zone follows the phase count, as the documentation shows', async () => {
  const one = fakeOcpp(1);
  await one._applyTargetPowerRange();
  assert.strictEqual(one.applied.excludeMax, 1380, 'single phase: 6 A × 230 V');
  assert.strictEqual(one.applied.step, 230);

  const three = fakeOcpp(3);
  await three._applyTargetPowerRange();
  assert.strictEqual(three.applied.excludeMax, 4140,
    'three phases: the firmware spreads the watt limit over all of them, so the floor is '
    + '6 A on each — a fixed 1380 lets Homey ask for power that cannot be delivered');
  assert.strictEqual(three.applied.step, 690);
});

// Homey's rule: the range must contain zero, and so must the exclude range. Every device
// needs to be able to idle.
test('zero stays inside both ranges', async () => {
  for (const phases of [1, 3]) {
    const d = fakeOcpp(phases);
    await d._applyTargetPowerRange();
    const o = d.applied;
    assert.ok(o.min <= 0 && 0 <= o.max, `${phases}-phase: min/max does not contain 0`);
    assert.ok(o.excludeMin <= 0 && 0 <= o.excludeMax,
      `${phases}-phase: exclude range does not contain 0`);
  }
});

// setCapabilityOptions replaces what it is given. The title lives in app.json and must not
// be lost to a call that only meant to change the numbers.
test('applying the range keeps the options already there', async () => {
  const d = fakeOcpp(3);
  await d._applyTargetPowerRange();
  assert.deepStrictEqual(d.applied.title, { en: 'Target Charging Power' },
    'the title declared in app.json was overwritten by the range update');
});

// A phase change has to reach the slider, and from the settings being saved rather than the
// stored ones — Homey persists those only after onSettings resolves.
test('changing the phase count re-applies the range from the new setting', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');
  assert.match(src, /_applyTargetPowerRange\(parseInt\(newSettings\.number_of_phases, 10\)\)/,
    'a phase change leaves the slider on the old range until the next restart');
  assert.match(src, /await this\._applyTargetPowerRange\(\);/,
    'the range is never applied at startup, so an existing device keeps whatever app.json '
    + 'declared');
});
