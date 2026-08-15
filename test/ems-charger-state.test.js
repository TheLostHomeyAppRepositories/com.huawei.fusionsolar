'use strict';

// Persistence of the per-charger control state (lib/ems/chargerState.js).
//
// The bug this covers, from the 2026-08-15 field log: the app was updated while the Audi
// was plugged in at 100%. On restart the EMS had forgotten both that the car was at its
// target and that a session was running — so it started a full car, ramped it to 16 A,
// stopped two minutes later once the SoC came back, and the session's kWh were gone from
// the log. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const chargerStateMixin   = require('../lib/ems/chargerState');
const chargerMixin        = require('../lib/ems/chargerControl');
const chargeSessionsMixin = require('../lib/ems/chargeSessions');
const { CHARGER_STATE_KEY, CHARGER_STATE_MAX_GAP_MS, CHARGER_STATE_SAVE_MS } = require('../lib/ems/constants');

// Minimal device: a settings store that records writes, plus the two mixins whose state
// is being persisted. _getChargerState and _finalizeChargeSession are the real ones.
function makeDevice(stored = undefined, extra = {}) {
  const store = { [CHARGER_STATE_KEY]: stored };
  const dev = {
    logs: [], writes: 0,
    log(m) { this.logs.push(m); },
    error() {},
    _chargerStates: new Map(),
    _chargeSessions: [],
    _getConfig: () => ({ price_config: { currency: 'CHF' } }),
    _getCurrentPrice: () => null,
    _addHistoryEvent() {},
    setStoreValue: () => Promise.resolve(),
    homey: {
      settings: {
        get: (k) => store[k],
        set: (k, v) => { store[k] = v; dev.writes++; },
      },
    },
    _store: store,
  };
  Object.assign(dev, chargerStateMixin, chargerMixin, chargeSessionsMixin, extra);
  return dev;
}

const CH = 'charger-1';
const T0 = 1_770_000_000_000;

function session(over = {}) {
  return {
    sessionActive: true, sessionStartedAt: T0 - 3600_000, sessionEnergyKwh: 12.5,
    sessionGridKwh: 4, sessionCostSum: 1.2, sessionCostedKwh: 4, sessionCarName: 'Audi - Q4',
    ...over,
  };
}

// ── restoring ──────────────────────────────────────────────────────────────────

test('the "car is at its target" latch survives a restart', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: { targetReachedCar: 'car-a' } } });
  dev._restoreChargerStates(T0 + 60_000);
  assert.strictEqual(dev._getChargerState(CH).targetReachedCar, 'car-a');
});

test('a running session resumes with its accumulated energy intact', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: session() } });
  dev._restoreChargerStates(T0 + 60_000);
  const st = dev._getChargerState(CH);
  assert.strictEqual(st.sessionActive, true);
  assert.strictEqual(st.sessionEnergyKwh, 12.5);
  assert.strictEqual(st.sessionStartedAt, T0 - 3600_000);
  assert.strictEqual(st.sessionCarName, 'Audi - Q4');
  assert.strictEqual(dev._chargeSessions.length, 0, 'still running — nothing booked yet');
});

test('the commanded current is NEVER restored, even when the blob carries it', () => {
  // The July lesson: a current the EMS did not command in THIS process is a belief, not a
  // measurement. After a restart only the charger's measured draw may set this.
  const dev = makeDevice({
    savedAt: T0,
    states: { [CH]: { currentAmps: 16, currentPhases: 3, targetReachedCar: 'car-a' } },
  });
  dev._restoreChargerStates(T0 + 60_000);
  const st = dev._getChargerState(CH);
  assert.strictEqual(st.currentAmps, null);
  assert.strictEqual(st.currentPhases, null);
  assert.strictEqual(st.targetReachedCar, 'car-a', 'the decision does come back');
});

test('the phase-switch cooldown comes back, so a restart cannot re-switch the relay', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: { lastPhaseSwitchAt: T0 - 30_000 } } });
  dev._restoreChargerStates(T0 + 60_000);
  assert.strictEqual(dev._getChargerState(CH).lastPhaseSwitchAt, T0 - 30_000);
});

test('a timestamp from the future is dropped rather than left to never expire', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: { lastPhaseSwitchAt: T0 + 60 * 60_000 } } });
  dev._restoreChargerStates(T0 + 1000);
  assert.strictEqual(dev._getChargerState(CH).lastPhaseSwitchAt, null);
});

test('a non-timestamp field is not mistaken for a clock problem', () => {
  // targetReachedCar holds a car id, which may be any string — including a numeric one.
  const dev = makeDevice({ savedAt: T0, states: { [CH]: { targetReachedCar: '99999999999999' } } });
  dev._restoreChargerStates(T0 + 1000);
  assert.strictEqual(dev._getChargerState(CH).targetReachedCar, '99999999999999');
});

// ── the stale blob ─────────────────────────────────────────────────────────────

test('state older than the gap is not resumed', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: { targetReachedCar: 'car-a' } } });
  dev._restoreChargerStates(T0 + CHARGER_STATE_MAX_GAP_MS + 1);
  assert.strictEqual(dev._chargerStates.size, 0);
  assert.match(dev.logs.join('\n'), /charger state discarded/);
});

test('but its running session is still booked, ending when the numbers were last true', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: session() } });
  dev._restoreChargerStates(T0 + 6 * 60 * 60_000); // six hours down
  assert.strictEqual(dev._chargeSessions.length, 1);
  const s = dev._chargeSessions[0];
  assert.strictEqual(s.energyKwh, 12.5);
  assert.strictEqual(s.carName, 'Audi - Q4');
  assert.strictEqual(s.endedAt, T0, 'not "now" — the downtime was not charging time');
  assert.match(dev.logs.join('\n'), /1 running session\(s\) closed/);
});

test('a stale session under the negligible threshold is still dropped', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: session({ sessionEnergyKwh: 0.01 }) } });
  dev._restoreChargerStates(T0 + 6 * 60 * 60_000);
  assert.strictEqual(dev._chargeSessions.length, 0);
});

test('a clock that jumped backwards is treated as a bad gap, not a fresh save', () => {
  const dev = makeDevice({ savedAt: T0, states: { [CH]: { targetReachedCar: 'car-a' } } });
  dev._restoreChargerStates(T0 - 60_000);
  assert.strictEqual(dev._chargerStates.size, 0);
});

test('no stored state at all is not an error', () => {
  const dev = makeDevice(undefined);
  dev._restoreChargerStates(T0);
  assert.strictEqual(dev._chargerStates.size, 0);
  assert.strictEqual(dev.logs.length, 0);
});

// ── saving ─────────────────────────────────────────────────────────────────────

test('nothing is written while no charger is known', () => {
  const dev = makeDevice();
  assert.strictEqual(dev._saveChargerStates(false, T0), false);
  assert.strictEqual(dev.writes, 0);
});

test('a decision reaches disk on the tick it is made', () => {
  const dev = makeDevice();
  dev._getChargerState(CH);
  dev._saveChargerStates(false, T0);            // first write establishes the baseline
  const before = dev.writes;
  dev._getChargerState(CH).targetReachedCar = 'car-a';
  assert.strictEqual(dev._saveChargerStates(false, T0 + 20_000), true);
  assert.strictEqual(dev.writes, before + 1);
  assert.strictEqual(dev._store[CHARGER_STATE_KEY].states[CH].targetReachedCar, 'car-a');
});

test('accumulating kWh alone does not write every tick', () => {
  const dev = makeDevice();
  const st = dev._getChargerState(CH);
  st.sessionActive = true; st.sessionEnergyKwh = 1;
  dev._saveChargerStates(false, T0);
  const before = dev.writes;
  for (let i = 1; i <= 10; i++) {
    st.sessionEnergyKwh += 0.06;
    dev._saveChargerStates(false, T0 + i * 20_000);   // ten ticks, well inside the cadence
  }
  assert.strictEqual(dev.writes, before, 'no settings write per tick');
});

test('…but they are not lost either: the periodic write picks them up', () => {
  const dev = makeDevice();
  const st = dev._getChargerState(CH);
  st.sessionActive = true; st.sessionEnergyKwh = 1;
  dev._saveChargerStates(false, T0);
  st.sessionEnergyKwh = 4.2;
  assert.strictEqual(dev._saveChargerStates(false, T0 + CHARGER_STATE_SAVE_MS), true);
  assert.strictEqual(dev._store[CHARGER_STATE_KEY].states[CH].sessionEnergyKwh, 4.2);
});

test('shutdown forces the write, so a deploy costs the session nothing', () => {
  const dev = makeDevice();
  const st = dev._getChargerState(CH);
  st.sessionActive = true; st.sessionEnergyKwh = 1;
  dev._saveChargerStates(false, T0);
  st.sessionEnergyKwh = 9.9;
  assert.strictEqual(dev._saveChargerStates(true, T0 + 20_000), true);
  assert.strictEqual(dev._store[CHARGER_STATE_KEY].states[CH].sessionEnergyKwh, 9.9);
});

test('what is saved is exactly what can be restored', () => {
  const dev = makeDevice();
  const st = dev._getChargerState(CH);
  Object.assign(st, session(), { targetReachedCar: 'car-a', currentAmps: 16, currentPhases: 3 });
  dev._saveChargerStates(true, T0);

  const dev2 = makeDevice(dev._store[CHARGER_STATE_KEY]);
  dev2._restoreChargerStates(T0 + 30_000);
  const st2 = dev2._getChargerState(CH);
  assert.strictEqual(st2.sessionEnergyKwh, 12.5);
  assert.strictEqual(st2.targetReachedCar, 'car-a');
  assert.strictEqual(st2.currentAmps, null, 'still measured, never remembered');
});

test('a settings store that throws does not take the tick down', () => {
  const dev = makeDevice();
  dev._getChargerState(CH);
  dev.homey.settings.set = () => { throw new Error('disk full'); };
  assert.strictEqual(dev._saveChargerStates(true, T0), false);
  assert.match(dev.logs.join('\n'), /charger state save failed: disk full/);
});
