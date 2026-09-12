'use strict';

// Which devices are allowed to name the EMS mode. Run: node --test
//
// From a configuration export of 2026-09-12, 21:03 — no sun, the battery discharging,
// and the EMS reporting:
//
//   mode:     "solar_pool"
//   modeText: "Hydrojet Pool · Bat 55%"
//
// The pool was `enabled: false` — taken out of EMS control — with no start or stop card
// configured at all. The EMS could not have started it and cannot stop it, yet it named
// itself after it, wrote it to ems_status_text, and fired ems_mode_changed, the per-mode
// flow and a history entry on the way there.
//
// Two faults meeting. The mode is a statement about what the EMS is doing, so a device it
// does not steer does not belong in it. And the value it was read from had been frozen for
// hours: _evaluateSimpleDevices creates the state entry and only then skips a disabled
// device, so `isOn` keeps whatever it happened to be when the entry was seeded. The widget
// already knew this and reads the live `actualOn` instead (see the note on the skip);
// the mode was left reading the stale entry.

const test   = require('node:test');
const assert = require('node:assert');

const simpleMixin = require('../lib/ems/simpleDevices');

function makeDevice() {
  const d = {
    _heatPumpStates: new Map(), _boilerStates: new Map(), _poolStates: new Map(),
    _dehumidifierStates: new Map(), _airconStates: new Map(),
  };
  Object.assign(d, simpleMixin);
  return d;
}

// ── the field case ──────────────────────────────────────────────────────────

test('a device outside EMS control does not name the mode', () => {
  const d = makeDevice();
  d._poolStates.set('pool1', { isOn: true });          // frozen hours ago, never corrected

  const active = d._simpleActive({ pool: [{ id: 'pool1', name: 'Hydrojet Pool', enabled: false }] });

  assert.strictEqual(active.count, 0, 'a device the EMS does not steer was counted as active');
  assert.strictEqual(active.mode, null, 'the EMS named itself after a device it does not control');
  assert.deepStrictEqual(active.names, []);
});

// The sharper half of the same fault: without the filter this reads as two types running
// at once and the mode degrades to the generic "solar_multi", so even the ONE device the
// EMS really is running stops being named correctly.
test('a disabled device does not turn one running type into several', () => {
  const d = makeDevice();
  d._poolStates.set('pool1', { isOn: true });
  d._boilerStates.set('b1', { isOn: true });

  const active = d._simpleActive({
    pool:   [{ id: 'pool1', name: 'Hydrojet Pool', enabled: false }],
    boiler: [{ id: 'b1', name: 'Heizstab Boiler', enabled: true }],
  });

  assert.strictEqual(active.mode, 'solar_boiler');
  assert.deepStrictEqual(active.names, ['Heizstab Boiler']);
  assert.strictEqual(active.count, 1);
});

// Per device, not per type — one pool out of EMS control must not silence the other.
test('the filter is per device, not per type', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });
  d._poolStates.set('p2', { isOn: true });

  const active = d._simpleActive({
    pool: [{ id: 'p1', name: 'Pool A', enabled: false }, { id: 'p2', name: 'Pool B', enabled: true }],
  });

  assert.strictEqual(active.count, 1);
  assert.deepStrictEqual(active.names, ['Pool B']);
  assert.strictEqual(active.mode, 'solar_pool');
});

// ── what must keep working ──────────────────────────────────────────────────

test('a device the EMS runs still names the mode', () => {
  const d = makeDevice();
  d._poolStates.set('pool1', { isOn: true });

  const active = d._simpleActive({ pool: [{ id: 'pool1', name: 'Hydrojet Pool', enabled: true }] });

  assert.strictEqual(active.count, 1);
  assert.strictEqual(active.mode, 'solar_pool');
  assert.deepStrictEqual(active.names, ['Hydrojet Pool']);
});

// The per-device toggle arrived after these configs existed; a device saved before it has
// no `enabled` field at all and has always been under EMS control.
test('a config without the toggle counts as under EMS control', () => {
  const d = makeDevice();
  d._heatPumpStates.set('hp1', { isOn: true });

  const active = d._simpleActive({ heat_pump: [{ id: 'hp1', name: 'CTA Luxtronik' }] });

  assert.strictEqual(active.count, 1);
  assert.strictEqual(active.mode, 'solar_hp');
});

test('a device that is not running is not counted', () => {
  const d = makeDevice();
  d._poolStates.set('pool1', { isOn: false });

  const active = d._simpleActive({ pool: [{ id: 'pool1', name: 'Pool', enabled: true }] });

  assert.strictEqual(active.count, 0);
  assert.strictEqual(active.mode, null);
});

test('a device with no state entry yet is not counted', () => {
  const d = makeDevice();
  const active = d._simpleActive({ pool: [{ id: 'unseen', name: 'Pool', enabled: true }] });
  assert.strictEqual(active.count, 0);
});

test('several of one type run under that type’s own name', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });
  d._poolStates.set('p2', { isOn: true });

  const active = d._simpleActive({
    pool: [{ id: 'p1', name: 'Pool A', enabled: true }, { id: 'p2', name: 'Pool B', enabled: true }],
  });

  assert.strictEqual(active.count, 2);
  assert.strictEqual(active.mode, 'solar_pool', 'two of one type is not "several types"');
  assert.deepStrictEqual(active.names, ['Pool A', 'Pool B']);
});

// This is what solar_multi exists for: naming the mode after one of them read as a claim
// about the others (a pool plus a dehumidifier used to report "Solar heat pump").
test('several types at once get the generic label', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });
  d._dehumidifierStates.set('dh1', { isOn: true });

  const active = d._simpleActive({
    pool:         [{ id: 'p1', name: 'Pool', enabled: true }],
    dehumidifier: [{ id: 'dh1', name: 'Entfeuchter', enabled: true }],
  });

  assert.strictEqual(active.count, 2);
  assert.strictEqual(active.mode, 'solar_multi');
});

// The status text is read by people, so the order has to be the same every tick rather
// than however the config happened to be assembled.
test('names follow the fixed type order, not the caller’s', () => {
  const d = makeDevice();
  d._airconStates.set('ac1', { isOn: true });
  d._heatPumpStates.set('hp1', { isOn: true });
  d._poolStates.set('p1', { isOn: true });

  const active = d._simpleActive({
    aircon:    [{ id: 'ac1', name: 'Klima', enabled: true }],
    pool:      [{ id: 'p1', name: 'Pool', enabled: true }],
    heat_pump: [{ id: 'hp1', name: 'CTA Luxtronik', enabled: true }],
  });

  assert.deepStrictEqual(active.names, ['CTA Luxtronik', 'Pool', 'Klima']);
});

test('nothing running names nothing', () => {
  const active = makeDevice()._simpleActive({});
  assert.deepStrictEqual(active, { count: 0, mode: null, names: [], text: '' });
});

// ── the pairing that must not drift ─────────────────────────────────────────

// The lists come in keyed the way the state maps are keyed. If a kind were ever added to
// one and not the other, a device list would silently be looked up in no map at all.
test('every state map has a mode name, and nothing else does', () => {
  const kinds = Object.keys(makeDevice()._simpleStateMaps());
  assert.deepStrictEqual(kinds, ['heat_pump', 'boiler', 'pool', 'dehumidifier', 'aircon']);

  for (const kind of kinds) {
    const d = makeDevice();
    const map = d._simpleStateMaps()[kind];
    map.set('x', { isOn: true });
    const active = d._simpleActive({ [kind]: [{ id: 'x', name: kind, enabled: true }] });
    assert.strictEqual(active.count, 1, `${kind} was not paired with its own state map`);
    assert.ok(active.mode && active.mode !== 'solar_multi', `${kind} has no mode name of its own`);
  }
});

// ── the words that reach the screen ─────────────────────────────────────────

// ems_status_text and the history line. Assembled in _tickBody it could not be driven at
// all; here the pluralisation and the fallback are pinned.

test('the status text names the running devices', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });
  d._dehumidifierStates.set('dh1', { isOn: true });

  const active = d._simpleActive({
    pool:         [{ id: 'p1', name: 'Hydrojet Pool', enabled: true }],
    dehumidifier: [{ id: 'dh1', name: 'Entfeuchter', enabled: true }],
  }, ' · Bat 55%');

  assert.strictEqual(active.text, 'Hydrojet Pool, Entfeuchter · Bat 55%');
});

test('a device outside EMS control is not in the status text either', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });
  d._boilerStates.set('b1', { isOn: true });

  const active = d._simpleActive({
    pool:   [{ id: 'p1', name: 'Hydrojet Pool', enabled: false }],
    boiler: [{ id: 'b1', name: 'Heizstab Boiler', enabled: true }],
  }, ' · Bat 55%');

  assert.strictEqual(active.text, 'Heizstab Boiler · Bat 55%');
});

// A running device with no name would otherwise put the word "undefined" on the screen.
test('an unnamed device falls back to a count, not to a blank', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });

  const active = d._simpleActive({ pool: [{ id: 'p1', enabled: true }] }, ' · Bat 55%');

  assert.strictEqual(active.text, '1 Gerät aktiv · Bat 55%');
});

test('the count is pluralised', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true });
  d._poolStates.set('p2', { isOn: true });

  const active = d._simpleActive({ pool: [{ id: 'p1', enabled: true }, { id: 'p2', enabled: true }] });

  assert.strictEqual(active.text, '2 Geräte aktiv');
});
