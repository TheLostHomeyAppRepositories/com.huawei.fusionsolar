'use strict';

// Holding a charger at its car's charge target, and letting go again. Run: node --test
//
// Reported the same day 1.2.231 shipped: an Audi Q4 at 80%, 3.3 kW going to the grid, the
// battery full, and the charger stopped. 1.2.231 had removed the invented 80% limit — but
// the hold is released in exactly one place, and that place sits behind `car.target !== null`.
// A charger already holding from when the invented limit existed therefore had nothing left
// to release it, and "holding until unplug" became literal.
//
// The whole block now lives in _updateTargetHold so it can be driven directly. That is the
// point of the extraction: nothing in the suite could reach it before.

const test   = require('node:test');
const assert = require('node:assert');

const chargerMixin = require('../lib/ems/chargerControl.js');

// Enough of an EmsDevice to run the real method: a charger-state map the test can inspect,
// a fixed car, and recorders for the two things it announces.
function makeDevice(car, state = {}) {
  const d = Object.assign({}, chargerMixin);
  d.logs = [];
  d.history = [];
  d.state = { targetReachedCar: null, socBlindLogged: false, ...state };
  d.log = (msg) => d.logs.push(msg);
  d.error = () => {};
  d._getChargerState = () => d.state;
  d._carForCharger = () => car;
  d._addHistoryEvent = (cat, kind, text, id) => d.history.push({ kind, text, id });
  return d;
}

const CHARGER = [{ id: 'easee-1', connected: true }];

const car = (over = {}) => ({
  id: 'csppdc2', name: 'Audi - Q4', soc: 80, target: null, targetConfigured: false, ...over,
});

// ── the reported fault ──────────────────────────────────────────────────────

test('a hold with no target left to hold against is released', () => {
  const d = makeDevice(car(), { targetReachedCar: 'csppdc2' });

  d._updateTargetHold(CHARGER);

  assert.strictEqual(d.state.targetReachedCar, null, 'the charger is still held until unplug');
  assert.ok(d.logs.some((l) => /releasing the hold/.test(l)), 'it let go without saying so');
  assert.ok(d.history.some((h) => h.kind === 'target_released'));
});

// The other half: releasing on a momentary gap in the reading would restart a car that
// really is full, which is why only a car with NO target source releases.
test('a hold survives a target that has merely not been read yet', () => {
  const d = makeDevice(car({ target: null, targetConfigured: true }), { targetReachedCar: 'csppdc2' });
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.state.targetReachedCar, 'csppdc2', 'a blind spell released a full car');
});

test('releasing is announced once, not on every tick', () => {
  const d = makeDevice(car(), { targetReachedCar: 'csppdc2' });
  d._updateTargetHold(CHARGER);
  const after = d.logs.length;
  d._updateTargetHold(CHARGER);
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.logs.length, after, 'it repeats itself every 20 seconds');
  assert.strictEqual(d.history.filter((h) => h.kind === 'target_released').length, 1);
});

// ── the behaviour that was already there ────────────────────────────────────

test('a car at its target puts its charger on hold', () => {
  const d = makeDevice(car({ soc: 90, target: 90, targetConfigured: true }));
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.state.targetReachedCar, 'csppdc2');
  assert.strictEqual(d.history.filter((h) => h.kind === 'target_reached').length, 1);
});

test('reaching the target is announced once, however long the hold lasts', () => {
  const d = makeDevice(car({ soc: 90, target: 90, targetConfigured: true }));
  d._updateTargetHold(CHARGER);
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.history.filter((h) => h.kind === 'target_reached').length, 1);
});

test('raising the target releases the hold', () => {
  const d = makeDevice(car({ soc: 80, target: 100, targetConfigured: true }),
    { targetReachedCar: 'csppdc2' });
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.state.targetReachedCar, null);
});

// Two percent of hysteresis: a car sitting exactly at its target must not flap between
// held and released as the reading wobbles.
test('a car resting on its target stays held', () => {
  for (const soc of [90, 89, 88]) {
    const d = makeDevice(car({ soc, target: 90, targetConfigured: true }),
      { targetReachedCar: 'csppdc2' });
    d._updateTargetHold(CHARGER);
    assert.strictEqual(d.state.targetReachedCar, 'csppdc2', `released at ${soc}%`);
  }
});

test('a car below its target is not held', () => {
  const d = makeDevice(car({ soc: 50, target: 90, targetConfigured: true }));
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.state.targetReachedCar, null);
});

// ── the edges ───────────────────────────────────────────────────────────────

test('an unplugged charger is left alone', () => {
  const d = makeDevice(car(), { targetReachedCar: 'csppdc2' });
  d._updateTargetHold([{ id: 'easee-1', connected: false }]);
  assert.strictEqual(d.state.targetReachedCar, 'csppdc2', 'P2 clears this on unplug, not here');
});

test('a charger with no car assigned is left alone', () => {
  const d = makeDevice(null, { targetReachedCar: 'csppdc2' });
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.state.targetReachedCar, 'csppdc2');
});

test('a car with no SoC reading does not release a hold either', () => {
  const d = makeDevice(car({ soc: null, target: 90, targetConfigured: true }),
    { targetReachedCar: 'csppdc2' });
  d._updateTargetHold(CHARGER);
  assert.strictEqual(d.state.targetReachedCar, 'csppdc2');
});

// ── what the log says ───────────────────────────────────────────────────────

test('a car that never had a target is not called unreadable', () => {
  const d = makeDevice(car());
  d._updateTargetHold(CHARGER);
  assert.ok(d.logs.some((l) => /has no charge target/.test(l)));
  assert.ok(!d.logs.some((l) => /not checkable/.test(l)));
});

test('a target that has not arrived yet is called exactly that', () => {
  const d = makeDevice(car({ soc: null, target: null, targetConfigured: true }));
  d._updateTargetHold(CHARGER);
  assert.ok(d.logs.some((l) => /not checkable/.test(l)));
});
