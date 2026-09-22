'use strict';

// The battery reads its own capacity instead of being told. Run: node --test
//
// Register 37758 is the stack's nameplate capacity — 15000 on the wire for a three-module
// LUNA2000, which is 15 kWh. Until now that number was typed into the EMS by hand, and a
// wrong or forgotten entry quietly changed what the adaptive solar-forecast gate and
// price-optimised charging decided.
//
// Most of what follows defends one word: zero. At all four places that use this figure,
// zero does not mean "a very small battery", it means "unknown" — the forecast gate returns
// inactive('no_capacity') and price charging stops planning. So a reading that fails, or a
// battery that answers 0 while it boots, must never arrive as a capacity of zero. The typed
// number is the floor, and it stays the whole answer for any battery that reports nothing.

// The two device classes below pull in the `homey` runtime, which only exists on-device.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
  if (request === 'jsmodbus' || request === 'ws') return {};
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const batteryMixin = require('../lib/ems/battery.js');
const REG = require('../lib/modbus-registers');
const { buildReadPlan } = require('../lib/modbus-client');

// ── the register ────────────────────────────────────────────────────────────

test('37758 is read in kilowatt-hours, not in the watt-hours it arrives as', () => {
  const def = REG.BATTERY_REGISTERS.ratedCapacity;
  assert.ok(def, 'the battery no longer reads its rated capacity');
  assert.deepStrictEqual(def.slice(0, 3), [37758, 2, 'UINT32']);
  assert.strictEqual(def[4], -3, 'the gain does not turn 15000 Wh into 15 kWh');
});

test('the capacity rides along in a request the battery was making anyway', () => {
  // Measured, and the reason it is NOT in STATIC_REGISTER_ADDRESSES: 37758-37759 merges
  // into the same request as the state of charge at 37760. Caching a nameplate looks
  // obviously right until you notice it saves nothing and costs a day of staleness — add a
  // module and the capacity should be right at the next poll, not tomorrow.
  const without = { ...REG.BATTERY_REGISTERS };
  delete without.ratedCapacity;
  assert.strictEqual(buildReadPlan(REG.BATTERY_REGISTERS).length, buildReadPlan(without).length,
    'the capacity now costs the battery an extra Modbus request');
  assert.ok(!REG.STATIC_REGISTER_ADDRESSES.has(37758),
    'the capacity is cached for a day, so a changed battery stays wrong until tomorrow');
});

// ── what the EMS makes of it ────────────────────────────────────────────────

function emsDevice(learned = {}) {
  const d = Object.assign({}, batteryMixin);
  d._capacityByBattery = { ...learned };
  d.log = () => {};
  return d;
}

test('a chosen capability decides the capacity', () => {
  const d = emsDevice({ 'bat-1': 15 });
  assert.strictEqual(d._capacityKwhFor({ id: 'bat-1', cap_capacity: 'battery_rated_capacity', capacity_kwh: 9 }), 15);
});

test('without a chosen capability the typed number decides, whatever was read', () => {
  // A battery may report a capacity and still not be the one the owner wants counted. The
  // reading only takes over when it was picked on purpose.
  const d = emsDevice({ 'bat-1': 15 });
  assert.strictEqual(d._capacityKwhFor({ id: 'bat-1', capacity_kwh: 9 }), 9);
});

test('a reading that fails falls back to the last one, never to zero', () => {
  // The whole point. The value is held for the life of the app because a nameplate does not
  // go stale between two polls — and because zero is not a capacity, it is a word meaning
  // "switch the adaptive gate off".
  const d = emsDevice({ 'bat-1': 15 });
  const bd = { id: 'bat-1', cap_capacity: 'battery_rated_capacity', capacity_kwh: 0 };
  assert.strictEqual(d._capacityKwhFor(bd), 15, 'a held capacity was dropped');

  // And when nothing was ever read, the typed number carries it — not zero.
  const fresh = emsDevice();
  assert.strictEqual(fresh._capacityKwhFor({ id: 'bat-2', cap_capacity: 'battery_rated_capacity', capacity_kwh: 12 }), 12);
});

test('a battery that reports nothing behaves exactly as it does today', () => {
  // An EMMA battery, or a LUNA that does not answer 37758, or a configuration saved before
  // any of this existed: all three have no cap_capacity, and all three keep their number.
  const d = emsDevice();
  assert.strictEqual(d._capacityKwhFor({ id: 'emma-1', capacity_kwh: 10 }), 10);
  assert.strictEqual(d._capacityKwhFor({ id: 'emma-1' }), 0, 'nothing typed and nothing read is still nothing');
  assert.strictEqual(d._capacityKwhFor(null), 0);
  assert.strictEqual(d._capacityKwhFor(undefined), 0);
});

test('a nonsensical reading is refused rather than passed on', () => {
  for (const learned of [0, -5, NaN, Infinity, null, 'fifteen', {}]) {
    const d = emsDevice({ 'bat-1': learned });
    assert.strictEqual(
      d._capacityKwhFor({ id: 'bat-1', cap_capacity: 'battery_rated_capacity', capacity_kwh: 7 }), 7,
      `${String(learned)} was taken as a capacity`);
  }
});

test('all four places that need the capacity ask the same accessor', () => {
  // Three of four used to compute it themselves. A choice that reaches the gate but not its
  // diagnosis, or the widget but not price charging, is worse than no choice at all: the
  // numbers disagree and nothing says which one is deciding.
  for (const rel of ['lib/ems/pvForecast.js', 'lib/ems/priceForecast.js', 'lib/ems/widget.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const raw = src.split('\n').filter((l) => /capacity_kwh/.test(l)
      && !/^\s*(\/\/|\*)/.test(l.trim())
      && !/_capacityKwhFor|cap_capacity/.test(l));
    assert.deepStrictEqual(raw, [], `${rel} still reads capacity_kwh on its own`);
    assert.ok(/_capacityKwhFor\(/.test(src), `${rel} never asks the accessor`);
  }
});

// ── what the two devices actually do with it ────────────────────────────────
//
// The three tests below exist because the mutation probe killed twelve of fifteen and left
// exactly these: everything above reads source text, and source text cannot tell you that a
// transient zero deletes a capability or that an unread poll forgets one.

const LunaDevice = require('../drivers/luna2000_modbus/device.js');
const EmsDevice  = require('../drivers/energy_management/device.js');

function fakeBattery(initial = {}) {
  const dev = {
    caps: new Set(Object.keys(initial)),
    values: { ...initial },
    logs: [],
    hasCapability:      (c) => dev.caps.has(c),
    addCapability:      async (c) => { dev.caps.add(c); },
    removeCapability:   async (c) => { dev.caps.delete(c); delete dev.values[c]; },
    getCapabilityValue: (c) => (c in dev.values ? dev.values[c] : null),
    setCapabilityValue: async (c, v) => { dev.values[c] = v; },
    log: (...a) => dev.logs.push(a.join(' ')),
  };
  dev._set = LunaDevice.prototype._set.bind(dev);
  dev._syncNumberCap = LunaDevice.prototype._syncNumberCap.bind(dev);
  return dev;
}

test('the capability appears with the first real reading and carries the value', async () => {
  const dev = fakeBattery();
  await dev._syncNumberCap('battery_rated_capacity', 15);
  assert.ok(dev.caps.has('battery_rated_capacity'), 'the capability was never created');
  assert.strictEqual(dev.values.battery_rated_capacity, 15);
});

test('a zero answer neither creates the capability nor deletes a value already held', async () => {
  // Zero is what this battery's nameplate registers are known to answer while they warm up
  // — _fetchControl only trusts a module count above zero for the same reason. Treating it
  // as a capacity would put 0 kWh in front of the EMS, which reads that as "unknown" and
  // switches the adaptive forecast gate off.
  const empty = fakeBattery();
  await empty._syncNumberCap('battery_rated_capacity', 0);
  assert.ok(!empty.caps.has('battery_rated_capacity'), 'a zero created the capability');

  const known = fakeBattery({ battery_rated_capacity: 15 });
  for (const answer of [0, null, undefined, NaN, -1]) {
    await known._syncNumberCap('battery_rated_capacity', answer);
    assert.ok(known.caps.has('battery_rated_capacity'), `${String(answer)} deleted a known capacity`);
    assert.strictEqual(known.values.battery_rated_capacity, 15, `${String(answer)} overwrote a known capacity`);
  }
});

test('a battery that never answers loses the capability instead of showing an empty row', async () => {
  const dev = fakeBattery({ battery_rated_capacity: null });
  await dev._syncNumberCap('battery_rated_capacity', null);
  assert.ok(!dev.caps.has('battery_rated_capacity'), 'an empty row was left behind');
});

test('the EMS remembers a capacity across a poll that could not read it', async () => {
  // The other half of "never zero": _getBattery is where the reading is taken, and what it
  // remembers is what _capacityKwhFor hands on. One unreadable poll must not undo it.
  const reads = [];
  const dev = Object.create(EmsDevice.prototype);
  dev.log = () => {};
  dev._cap = async (id, cap) => { reads.push(`${id}/${cap}`); return dev._answer; };

  const cfg = { battery_devices: [{ id: 'bat-1', cap_soc: 'measure_battery', cap_capacity: 'battery_rated_capacity', capacity_kwh: 9 }] };

  dev._answer = 15;
  await dev._getBattery(cfg);
  assert.strictEqual(dev._capacityByBattery['bat-1'], 15, 'the reading was never remembered');
  assert.ok(reads.some((r) => r.endsWith('/battery_rated_capacity')), 'the capacity capability was never read');

  dev._answer = null;
  await dev._getBattery(cfg);
  assert.strictEqual(dev._capacityByBattery['bat-1'], 15, 'an unreadable poll forgot the capacity');
  assert.strictEqual(dev._capacityKwhFor(cfg.battery_devices[0]), 15, 'and the consumers lost it');
});

test('the EMS never remembers a zero, whatever the battery said', async () => {
  const dev = Object.create(EmsDevice.prototype);
  dev.log = () => {};
  const cfg = { battery_devices: [{ id: 'bat-1', cap_capacity: 'battery_rated_capacity', capacity_kwh: 9 }] };
  for (const answer of [0, -3, NaN, 'fifteen', null]) {
    dev._cap = async () => answer;
    await dev._getBattery(cfg);
    assert.strictEqual(dev._capacityByBattery['bat-1'], undefined, `${String(answer)} was remembered as a capacity`);
    assert.strictEqual(dev._capacityKwhFor(cfg.battery_devices[0]), 9, 'the typed number stopped carrying it');
  }
});

// ── the capability on the battery ───────────────────────────────────────────

test('the capability is declared, in kilowatt-hours, with an icon that exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const cap = manifest.capabilities.battery_rated_capacity;
  assert.ok(cap, 'the capability is gone from the manifest');
  assert.strictEqual(cap.type, 'number');
  assert.strictEqual(cap.getable, true);
  assert.strictEqual(cap.setable, false);
  assert.strictEqual(cap.insights, false, 'a constant in a graph is noise');
  assert.deepStrictEqual(cap.units, { en: 'kWh' });
  for (const lang of ['en', 'de', 'nl']) {
    assert.strictEqual(typeof cap.title[lang], 'string', `no ${lang} title`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, cap.icon.replace(/^\//, ''))), `icon missing: ${cap.icon}`);

  const driver = manifest.drivers.find((d) => d.id === 'luna2000_modbus');
  assert.ok(driver.capabilities.includes('battery_rated_capacity'),
    'the battery driver cannot carry the capability');
});

test('the capability comes and goes with the reading, like the version strings beside it', () => {
  // Not in REQUIRED_CAPABILITIES: a battery that never answers 37758 should show nothing,
  // not an empty row. That is the pattern _syncStringCap already follows for the two
  // software versions, including its rule about not removing a value that is still there.
  const driver = fs.readFileSync(path.join(ROOT, 'drivers/luna2000_modbus/device.js'), 'utf8');
  const required = driver.slice(driver.indexOf('REQUIRED_CAPABILITIES'), driver.indexOf('];', driver.indexOf('REQUIRED_CAPABILITIES')));
  assert.ok(!required.includes('battery_rated_capacity'),
    'the capability is forced onto every battery, including ones that cannot report it');
  assert.ok(/_syncNumberCap\('battery_rated_capacity', batt\.ratedCapacity\)/.test(driver),
    'the reading is never written to the capability');
});

// ── the settings page ───────────────────────────────────────────────────────

test('the capacity picker offers nameplates only, and never guesses', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings/index.html'), 'utf8');
  const fn = html.slice(html.indexOf('function emsRenderBatteryCaps'), html.indexOf('function emsGetBatteryDevices'));
  assert.ok(fn.length > 200, 'the battery renderer was not found where it was expected');

  // Narrow: a wide meter_power filter would offer an EMMA its chargeable capacity, which
  // moves with the state of charge — a choice that looks right and makes the gate wander.
  assert.ok(/capCaps = caps\.filter/.test(fn), 'there is no capacity picker');
  assert.ok(!/capCaps[\s\S]{0,200}indexOf\('meter_power'\)/.test(fn),
    'the capacity picker offers every meter_power capability');

  // No auto-detection, unlike the two rows above it: a stored configuration has no
  // cap_capacity, and detecting one would move an existing installation off the number its
  // owner typed without being asked.
  const defLine = /var defCap = ([^;]+);/.exec(fn);
  assert.ok(defLine, 'the picker has no default at all');
  assert.ok(!/emsDetect/.test(defLine[1]),
    'the capacity picker guesses a capability for configurations that never chose one');
});

test('the chosen capability is saved, and the dataset is cleared with the others', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings/index.html'), 'utf8');
  assert.ok(/if \(row\.dataset\.capCapacity\) d\.cap_capacity = row\.dataset\.capCapacity;/.test(html),
    'the choice is rendered but never saved');
  assert.ok(/\['capSoc','capPower','capCapacity'\]/.test(html),
    'the old choice survives a device change');
});

test('every string the picker shows exists in all three languages', () => {
  for (const key of ['batteryCapacity', 'batteryCapacityHint']) {
    for (const lang of ['de', 'en', 'nl']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'));
      assert.strictEqual(typeof dict.settings.caps[key], 'string', `${lang}.json is missing settings.caps.${key}`);
    }
  }
});
