'use strict';

// Where a car's charge target comes from. Run: node --test
//
// Reported on an Audi Q4 that would not charge past 80%. Its vehicle device exposes no
// target-SoC capability, and for exactly that case the EMS used to write an 80 into its own
// store and then enforce it — a limit nobody had chosen, applied as if they had, and
// changeable only through a flow action while the settings page showed the field and told
// you to go and use one.
//
// Now the number is typed where the car is configured, and an empty field means no target:
// the charger holds only when it has a figure to hold against.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const carsMixin = require('../lib/ems/cars.js');

const ROOT = path.join(__dirname, '..');

// The slice of an EmsDevice that _updateCarCapabilities actually touches. Capability reads
// come from `caps`, keyed "deviceId/capabilityId"; store writes are recorded so a test can
// assert that nothing was written behind the user's back.
function makeDevice({ caps = {}, targets = {}, setAt = {} } = {}) {
  const d = Object.assign({}, carsMixin);
  d.log = () => {};
  d.error = () => {};
  d.stored = {};
  d._carTargets = targets;
  d._carTargetSetAt = setAt;
  d._carSocTrack = {};
  d._carStates = [];
  d._capTitlesApplied = {};
  d._cap = async (deviceId, capId) => {
    const v = caps[`${deviceId}/${capId}`];
    return v === undefined ? null : v;
  };
  d.hasCapability = () => true;
  d._set = async () => {};
  d.setStoreValue = async (k, v) => { d.stored[k] = v; };
  return d;
}

const CAR = {
  id: 'car1',
  device_id: 'dev1',
  name: 'Audi - Q4',
  battery_capacity_kwh: 80,
  soc_capability: 'measure_battery',
};

const withSoc = (soc) => ({ 'dev1/measure_battery': soc });

async function stateFor(car, opts = {}) {
  const d = makeDevice(opts);
  await d._updateCarCapabilities({ car_devices: [car] });
  return { state: d._carStates[0], device: d };
}

// ── the reported fault ──────────────────────────────────────────────────────

test('a car with no target source has no target, and is therefore not held', async () => {
  const { state } = await stateFor(CAR, { caps: withSoc(80) });
  assert.strictEqual(state.soc, 80);
  assert.strictEqual(state.target, null, 'a limit was invented for a car that named none');
  assert.strictEqual(state.targetConfigured, false);
});

// The 80 was not merely a default in code — it was written into the device store on first
// sight of the car, so it outlived the version that put it there.
test('nothing is written to the store for a car that named no target', async () => {
  const d = makeDevice({ caps: withSoc(80) });
  await d._updateCarCapabilities({ car_devices: [CAR] });
  assert.deepStrictEqual(d.stored, {}, 'the EMS stored a target the user never chose');
  assert.deepStrictEqual(d._carTargets, {});
});

// ── where a target may come from ────────────────────────────────────────────

test('the number typed into the car settings is the target', async () => {
  const { state } = await stateFor({ ...CAR, target_soc: 100 }, { caps: withSoc(80) });
  assert.strictEqual(state.target, 100);
  assert.strictEqual(state.targetConfigured, true);
});

test('the vehicle reporting its own target outranks the typed number', async () => {
  const car = { ...CAR, target_soc: 100, target_soc_capability: 'target_soc' };
  const { state } = await stateFor(car, {
    caps: { ...withSoc(80), 'dev1/target_soc': 90 },
  });
  assert.strictEqual(state.target, 90);
});

// A vehicle that has a target capability but has not answered yet is a blind spot, not a
// car without a limit — the distinction the charger's log now makes.
test('a target capability that has not answered still counts as configured', async () => {
  const car = { ...CAR, target_soc_capability: 'target_soc' };
  const { state } = await stateFor(car, { caps: withSoc(80) });
  assert.strictEqual(state.target, null);
  assert.strictEqual(state.targetConfigured, true);
});

test('a value set through the flow action outranks the typed number', async () => {
  const { state } = await stateFor({ ...CAR, target_soc: 100 }, {
    caps: withSoc(80),
    targets: { car1: 85 },
  });
  assert.strictEqual(state.target, 85);
});

// Unchanged behaviour, kept under test because the new fallback runs right beside it: a
// target just set by hand wins over the vehicle's reading until the round trip completes.
test('a target just set by hand wins over the vehicle for a few minutes', async () => {
  const car = { ...CAR, target_soc_capability: 'target_soc' };
  const { state } = await stateFor(car, {
    caps: { ...withSoc(50), 'dev1/target_soc': 80 },
    targets: { car1: 100 },
    setAt: { car1: Date.now() },
  });
  assert.strictEqual(state.target, 100);
});

test('an empty or nonsensical entry is no target at all', async () => {
  for (const raw of ['', null, undefined, 0, -5, 'full', {}]) {
    const { state } = await stateFor({ ...CAR, target_soc: raw }, { caps: withSoc(80) });
    assert.strictEqual(state.target, null, `${JSON.stringify(raw)} was taken as a target`);
    assert.strictEqual(state.targetConfigured, false);
  }
});

test('a typed target is clamped to a percentage', async () => {
  const { state } = await stateFor({ ...CAR, target_soc: 140 }, { caps: withSoc(80) });
  assert.strictEqual(state.target, 100);
});

// The seeding did not live where the target is resolved — it happened while the per-car
// capabilities were being synced, which is why it survived every restart: written once,
// long before anything asked what the target was.
test('syncing the per-car capabilities writes no target of its own', async () => {
  const d = makeDevice();
  d._ensureCap = async () => {};
  d._setCapTitle = async () => {};
  d.getCapabilities = () => [];

  await d._syncCarCapabilities({ car_devices: [CAR] });

  assert.deepStrictEqual(d._carTargets, {}, 'a target was invented while syncing capabilities');
  assert.deepStrictEqual(d.stored, {}, 'and written to the store');
});

// ── the two sources not fighting each other ─────────────────────────────────

// Without this, a flow's stored value would outrank the settings field for ever, so typing
// 100 into a page that already had a stored 80 would appear to do nothing.
test('saving the settings clears a flow-set target for cars that now name one', () => {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  d._carTargets = { car1: 80, car2: 80 };
  d.stored = {};
  d.setStoreValue = async (k, v) => { d.stored[k] = v; };

  d._dropCarTargetOverrides({ car_devices: [
    { id: 'car1', target_soc: 100 },   // named in settings → the override goes
    { id: 'car2' },                    // not named → the flow's value stands
  ] });

  assert.deepStrictEqual(d._carTargets, { car2: 80 });
});

test('a save that names no targets leaves the store untouched', () => {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  d._carTargets = { car1: 90 };
  d.setStoreValue = async () => { throw new Error('wrote for nothing'); };
  d._dropCarTargetOverrides({ car_devices: [{ id: 'car1' }] });
  assert.deepStrictEqual(d._carTargets, { car1: 90 });
});

// The device class needs `homey` for its base class only.
function requireDeviceClass() {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Device: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(ROOT, 'drivers', 'energy_management', 'device.js'));
  } finally {
    Module._load = origLoad;
  }
}

// Testing the method alone would not notice it being dropped from the one place that runs
// it. Saving the settings page is the moment the field has to win.
test('saving the settings is what runs the override cleanup', () => {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  const cfg = { car_devices: [{ id: 'car1', target_soc: 100 }] };
  d._carTargets = { car1: 80 };
  d.log = () => {}; d.error = () => {};
  d._getConfig = () => cfg;
  d._validateConfig = () => false;
  d.setStoreValue = async () => {};
  d.homey = { settings: { set: () => {} } };
  d._syncCarCapabilities = async () => {};
  d._syncPvForecastCapabilities = async () => {};
  d._stopTick = () => {};
  d._startTick = () => {};

  d.onConfigChanged();

  assert.deepStrictEqual(d._carTargets, {}, 'the stale flow value outlived the save');
});

// ── the install that already has the invented 80 ──────────────────────────────

// Deleting the code that wrote the 80 does nothing for the installs that already have it
// in their store. Moving it into the settings is what makes it visible and changeable —
// without this the new field would look broken: type nothing, and the old limit stands.
function makeMigrationDevice(cfg, targets, migrated = false) {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  d.log = () => {};
  d._carTargets = targets;
  d.store = { carTargetsMigrated: migrated };
  d.savedConfig = null;
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d._getConfig = () => cfg;
  d.homey = { settings: { set: (k, v) => { d.savedConfig = v; } } };
  return d;
}

test('the stored target becomes the one shown in the settings', async () => {
  const cfg = { car_devices: [{ id: 'car1', name: 'Audi - Q4' }] };
  const d = makeMigrationDevice(cfg, { car1: 80 });

  await d._migrateCarTargetsIntoConfig();

  assert.strictEqual(cfg.car_devices[0].target_soc, 80, 'the limit vanished instead of surfacing');
  assert.deepStrictEqual(d._carTargets, {}, 'it stayed in the store as well');
  assert.ok(d.savedConfig, 'the migrated config was not persisted');
  assert.strictEqual(d.store.carTargetsMigrated, true);
});

test('a target already typed in the settings is not overwritten by the store', async () => {
  const cfg = { car_devices: [{ id: 'car1', target_soc: 100 }] };
  const d = makeMigrationDevice(cfg, { car1: 80 });
  await d._migrateCarTargetsIntoConfig();
  assert.strictEqual(cfg.car_devices[0].target_soc, 100);
  assert.deepStrictEqual(d._carTargets, {});
});

// Once. Afterwards the flow action's value is an override again, and does not get written
// into somebody's settings behind their back.
test('it runs once, not on every restart', async () => {
  const cfg = { car_devices: [{ id: 'car1' }] };
  const d = makeMigrationDevice(cfg, { car1: 90 }, true);
  await d._migrateCarTargetsIntoConfig();
  assert.strictEqual(cfg.car_devices[0].target_soc, undefined);
  assert.deepStrictEqual(d._carTargets, { car1: 90 });
  assert.strictEqual(d.savedConfig, null);
});

test('an install with nothing to move writes no config', async () => {
  const cfg = { car_devices: [{ id: 'car1' }] };
  const d = makeMigrationDevice(cfg, {});
  await d._migrateCarTargetsIntoConfig();
  assert.strictEqual(d.savedConfig, null, 'it rewrote the config for nothing');
  assert.strictEqual(d.store.carTargetsMigrated, true, 'it will try again on every restart');
});

// What the charger then does with a null target — hold or let go — was pinned here as two
// assertions about the source text, because the logic sat inside _evaluateEvChargers and
// could not be driven from a test. That was not enough: 1.2.233 had to fix a standing hold
// that no longer had a target to release it, and neither assertion noticed. The block now
// lives in _updateTargetHold and is tested for real in test/ems-target-hold.test.js.

// ── the settings tab ────────────────────────────────────────────────────────

const SETTINGS = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');

test('the target can be typed where the car is configured', () => {
  assert.match(SETTINGS, /className = 'ems-car-target-soc'/);
  // Created is not the same as shown: the element has to be appended to the row, or the
  // field simply is not there and the old flow-only route is back.
  assert.match(SETTINGS, /tgtRow\.appendChild\(tgtNum\)/);
  assert.match(SETTINGS, /target_soc:\s+emsCarTargetValue\(entry\)/);
});

test('an empty box is saved as no target rather than as zero', () => {
  const start = SETTINGS.indexOf('function emsCarTargetValue(');
  assert.ok(start > 0, 'emsCarTargetValue is gone');
  const fn = SETTINGS.slice(start, start + 500);
  assert.match(fn, /if \(rawValue === ''\) return null;/);
});

test('both new strings exist in all three locales', () => {
  for (const lang of ['en', 'de', 'nl']) {
    const car = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'))
      .settings.carRow;
    assert.ok(car.targetSocNoLimit, `${lang}: no placeholder for the empty field`);
    assert.ok(car.noCapabilitySelected, `${lang}: no hint under the field`);
    // The old hint sent people to a flow action because there was nowhere else to go.
    assert.ok(!/80 \/ 90 \/ 100/.test(car.noCapabilitySelected),
      `${lang}: the hint still offers the flow's three fixed values as the only way`);
  }
});
