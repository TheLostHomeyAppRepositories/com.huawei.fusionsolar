'use strict';

// Unit tests for _syncStringCap on the LUNA2000 Modbus driver. Run: node --test
//
// The two energy-storage-unit software versions live in registers 37799 and 37814, and are
// optional: a battery with one unit has no second version to report, so the capability is
// added and removed to match the hardware. That is the right thing to key on. What it must
// NOT key on is a single empty read — the field log of 2026-08-20 shows both of those
// registers failing individually while the rest of the poll came through, which is exactly
// what the bisection path in lib/modbus-client.js exists for. Removing on the first empty
// answer deleted a capability that was merely unread, and the next good poll added it back.
//
// A poll that fails as a whole never reaches here (isBatteryDataValid returns earlier), so
// the case under test is the partial one.

const Module = require('module');
const _origLoad = Module._load;

// The driver needs `homey` for its base class only; nothing under test touches it.
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const LunaDevice = require('../drivers/luna2000_modbus/device.js');

const CAP = 'luna2000_unit2_software_version';

// Real method, fake device: capabilities are a plain map, and every add/remove is recorded
// so a test can assert on churn rather than only on the end state.
function makeDevice(caps = {}) {
  const d = Object.create(LunaDevice.prototype);
  d.caps = caps;
  d.calls = [];
  d.log = () => {};
  d.hasCapability      = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.addCapability      = async (c) => { d.calls.push(`add:${c}`); d.caps[c] = null; };
  d.removeCapability   = async (c) => { d.calls.push(`remove:${c}`); delete d.caps[c]; };
  d._set               = async (c, v) => { d.calls.push(`set:${c}=${v}`); d.caps[c] = v; };
  return d;
}

test('_syncStringCap — a reported version adds the capability and stores it trimmed', async () => {
  const d = makeDevice();
  await d._syncStringCap(CAP, '  V100R002C00SPC108  ');
  assert.deepStrictEqual(d.calls, [`add:${CAP}`, `set:${CAP}=V100R002C00SPC108`]);
});

test('_syncStringCap — an unchanged version does not add again', async () => {
  const d = makeDevice({ [CAP]: 'V100R002C00SPC108' });
  await d._syncStringCap(CAP, 'V100R002C00SPC108');
  assert.deepStrictEqual(d.calls, [`set:${CAP}=V100R002C00SPC108`], 'it re-added an existing capability');
});

// The point of the change.
test('_syncStringCap — a failed read does not delete a version already known', async () => {
  const d = makeDevice({ [CAP]: 'V100R002C00SPC108' });
  for (const empty of [null, undefined, '', '   ']) {
    await d._syncStringCap(CAP, empty);
  }
  assert.deepStrictEqual(d.calls, [], 'a transient empty read removed the capability');
  assert.strictEqual(d.caps[CAP], 'V100R002C00SPC108', 'the known version was lost');
});

// …while the reason the add/remove exists in the first place still works.
test('_syncStringCap — a unit that never reported a version has its capability removed', async () => {
  const d = makeDevice({ [CAP]: null });
  await d._syncStringCap(CAP, null);
  assert.deepStrictEqual(d.calls, [`remove:${CAP}`], 'an absent unit keeps an empty capability');
});

test('_syncStringCap — a capability holding only whitespace counts as never reported', async () => {
  const d = makeDevice({ [CAP]: '   ' });
  await d._syncStringCap(CAP, null);
  assert.deepStrictEqual(d.calls, [`remove:${CAP}`]);
});

test('_syncStringCap — nothing to remove is not an error', async () => {
  const d = makeDevice();
  await d._syncStringCap(CAP, null);
  assert.deepStrictEqual(d.calls, [], 'it tried to remove a capability that does not exist');
});

// The failure this replaces: empty, good, empty, good — four polls, four store writes.
test('_syncStringCap — an intermittent register does not churn the capability', async () => {
  const d = makeDevice();
  await d._syncStringCap(CAP, 'V1');   // first good read
  d.calls.length = 0;
  for (const v of [null, 'V1', null, 'V1']) await d._syncStringCap(CAP, v);
  assert.ok(!d.calls.some((c) => c.startsWith('remove:')), 'the capability is still being removed and re-added');
  assert.ok(!d.calls.some((c) => c.startsWith('add:')), 'the capability is still being re-added');
});
