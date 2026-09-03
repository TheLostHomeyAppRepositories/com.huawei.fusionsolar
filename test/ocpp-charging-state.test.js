'use strict';

// What the OCPP charger writes into Homey's charging-state capability. Run: node --test
//
// Field-caught 2026-09-03. A charger connected, reported Available, answered every
// heartbeat, showed no error — and every value on the device stayed blank. Its log carried
// this line, once per status change:
//
//   _set(evcharger_charging_state, idle) failed: Invalid enum capability
//   (evcharger_charging_state) value: idle. Expected: plugged_in_charging,
//   plugged_in_discharging,plugged_in_paused,plugged_in,plugged_out
//
// evcharger_charging_state is Homey's own enum, not ours. The app was writing its internal
// vocabulary straight into it — idle, connected, charging, error — and not one of those
// four is a member. So the capability had never been written successfully on any
// installation since it was added, and every comparison against it read null.
//
// The two vocabularies are now kept apart and translated at the point of writing. This file
// pins the enum, because the failure mode is a value that looks perfectly reasonable.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const ChargerDevice = require(path.join('..', 'drivers', 'smartcharger_ocpp', 'device.js'));
Module._load = origLoad;

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');

// Homey's enum, verbatim from the error the charger's owner reported.
const HOMEY_ENUM = [
  'plugged_in_charging', 'plugged_in_discharging', 'plugged_in_paused',
  'plugged_in', 'plugged_out',
];

function fakeCharger(initial) {
  const d = Object.create(ChargerDevice.prototype);
  d.values = initial ? { evcharger_charging_state: initial } : {};
  d.rejected = [];
  d.log = () => {};
  d.hasCapability = () => true;
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  // Rejects exactly as Homey does, so a bad value fails the test instead of being recorded.
  d._set = async (c, v) => {
    if (c === 'evcharger_charging_state' && !HOMEY_ENUM.includes(v)) {
      d.rejected.push(v);
      throw new Error(`Invalid enum capability (${c}) value: ${v}`);
    }
    d.values[c] = v;
  };
  return d;
}

const written = async (internal, override) => {
  const d = fakeCharger();
  await d._setChargingState(internal, override);
  assert.deepStrictEqual(d.rejected, [], `Homey rejected ${d.rejected[0]}`);
  return d.values.evcharger_charging_state;
};

test('every state this app can be in writes a value Homey accepts', async () => {
  for (const internal of ['idle', 'connected', 'charging', 'error']) {
    const v = await written(internal);
    assert.ok(v === undefined || HOMEY_ENUM.includes(v),
      `internal state "${internal}" writes "${v}", which is not in Homey's enum`);
  }
});

test('an idle connector reads as unplugged, not as the word idle', async () => {
  assert.strictEqual(await written('idle'), 'plugged_out');
});

test('a connected car and a charging car are told apart', async () => {
  assert.strictEqual(await written('connected'), 'plugged_in');
  assert.strictEqual(await written('charging'), 'plugged_in_charging');
});

// A lost connection says nothing about whether the cable is in. Writing plugged_out to fill
// the gap would state something the charger never reported.
test('a fault writes nothing rather than inventing a plug state', async () => {
  const d = fakeCharger('plugged_in_charging');
  await d._setChargingState('error');
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging',
    'the fault overwrote the last known plug state with a guess');
  assert.strictEqual(d._chargingState(), 'error',
    'the app lost track of the fault because only the capability was consulted');
});

// OCPP distinguishes two ways a session can be held up; Homey has a word for both and this
// app does not. The finer value goes to Homey, the coarser one stays internal.
test('a suspended connector is reported as paused, not merely plugged in', async () => {
  assert.strictEqual(await written('connected', 'plugged_in_paused'), 'plugged_in_paused');
  const d = fakeCharger();
  await d._setChargingState('connected', 'plugged_in_paused');
  assert.strictEqual(d._chargingState(), 'connected',
    'the internal vocabulary gained a state the session logic does not handle');
});

test('the state survives a restart by being read back out of the capability', async () => {
  assert.strictEqual(fakeCharger('plugged_in_charging')._chargingState(), 'charging');
  assert.strictEqual(fakeCharger('plugged_in')._chargingState(), 'connected');
  assert.strictEqual(fakeCharger('plugged_in_paused')._chargingState(), 'connected');
  assert.strictEqual(fakeCharger('plugged_out')._chargingState(), 'idle');
  assert.strictEqual(fakeCharger()._chargingState(), 'idle',
    'a device that has never reported anything should read as idle, not as undefined');
});

// The bug was not one bad call site, it was eight of them writing a vocabulary that had
// never been checked against Homey's. One writer is what keeps that from recurring.
test('nothing writes the capability except the one place that translates', async () => {
  const direct = [...SRC.matchAll(/_set\('evcharger_charging_state',\s*([^)]*)\)/g)]
    .map((m) => m[1].trim());
  assert.deepStrictEqual(direct, ['homeyState'],
    `${direct.length} places write the capability directly: ${direct.join(', ')} — `
    + 'each one is a chance to write a word Homey does not know');
});

// The OCPP status map feeds the internal vocabulary. If a status ever maps to a word the
// translation has no entry for, that state silently writes nothing at all.
test('every OCPP status maps to a state the translation knows', () => {
  const grab = (name) => {
    const at = SRC.indexOf(`const ${name} = {`);
    assert.ok(at > 0, `${name} is gone or renamed`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${SRC.slice(SRC.indexOf('{', at), SRC.indexOf('};', at) + 1)}`)();
  };
  const statuses = grab('OCPP_STATUS_MAP');
  const homeyOf  = grab('HOMEY_EV_STATE');
  for (const [ocpp, internal] of Object.entries(statuses)) {
    assert.ok(internal in homeyOf,
      `OCPP status ${ocpp} maps to "${internal}", which has no Homey translation`);
    const v = homeyOf[internal];
    assert.ok(v === null || HOMEY_ENUM.includes(v),
      `OCPP status ${ocpp} would write "${v}", which Homey rejects`);
  }
  for (const v of Object.values(grab('OCPP_HOMEY_STATE'))) {
    assert.ok(HOMEY_ENUM.includes(v), `the override "${v}" is not in Homey's enum`);
  }
});
