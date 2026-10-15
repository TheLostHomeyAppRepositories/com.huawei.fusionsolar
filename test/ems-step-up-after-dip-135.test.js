'use strict';

// After a dip, a running charger steps up on its adjustment interval alone (1.3.5).
//
// Until 1.3.4 every step DOWN also locked stepping up for FLIP_COOLDOWN_MS (5 min). That
// was a second, longer copy of the adjustment interval (step_hold_s), and nobody could set
// it. On a house without room for the remainder it meant five minutes of export after every
// dip: Andi's meter on 2026-10-15 at 16:27 showed 487 W, with the charger held at 7 A against
// 2 kW of surplus. Andi, asked whether the lock makes sense: rebuild it as proposed.
//   - A running charger steps up as soon as the surplus has held for the interval.
//   - A START after a stop still waits five minutes: a car started and stopped every
//     minute is woken each time.
//   - Switching up to three phases keeps its own ten minutes (tested elsewhere).
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const chargerMixin = require('../lib/ems/chargerControl');
const timingMixin  = require('../lib/ems/timing');
const constants    = require('../lib/ems/constants');
const { FLIP_COOLDOWN_MS } = constants;

function makeDevice() {
  const dev = {
    log() {}, error() {},
    _warmupDone: true,
    _chargerStates: new Map(),
    _addHistoryEvent() {},
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) },
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
    },
  };
  Object.assign(dev, timingMixin, chargerMixin);
  return dev;
}

const T0 = Date.now();
const HOLD = 60_000;   // Andi's step_hold_s
const charger = (drawn) => ({ id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1,
  phaseSwitch: false, stepHoldMs: HOLD, powerW: drawn, rawPowerW: drawn });
const amps = (d) => d._getChargerState('c1').currentAmps;
const seeded = (patch) => { const d = makeDevice(); Object.assign(d._getChargerState('c1'), patch); return d; };

test('FLIP_COOLDOWN_MS stays five minutes, and the 1.3.4 one-minute variant is gone', () => {
  assert.strictEqual(FLIP_COOLDOWN_MS, 5 * 60_000);
  assert.strictEqual(constants.BAT_FULL_FLIP_COOLDOWN_MS, undefined);
});

test('ten seconds after a step down, a running charger climbs once the interval has passed', async () => {
  const d = seeded({ currentAmps: 7, currentPhases: 1, lastDownStepAt: T0 });
  const t = T0 + 10_000;
  await d._stepCharger(charger(1610), 2400, 1, t, -790, false);
  assert.strictEqual(amps(d), 7, 'not before the interval');
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 9, 'but the step is planned at once');
  await d._stepCharger(charger(1610), 2400, 1, t + HOLD + 1, -790, false);
  assert.strictEqual(amps(d), 9, '9 A with 250 W to spare under 2400 W');
});

test('16:27 on 2026-10-15, replayed: the full battery takes 9 A one interval after the dip', async () => {
  const d = seeded({ currentAmps: 7, currentPhases: 1, lastDownStepAt: T0 });
  const rule = { baseW: 2005, roundUp: true };
  await d._stepCharger(charger(1495), 2005, 1, T0 + 20_000, -395, false, rule);
  await d._stepCharger(charger(1495), 2005, 1, T0 + 20_000 + HOLD + 1, -395, false, rule);
  assert.strictEqual(amps(d), 9, 'about 80 s after the step down, not five minutes');
});

test('a start after a stop still waits five minutes', async () => {
  const d = seeded({ currentAmps: null, currentPhases: 1, lastDownStepAt: T0 });
  await d._stepCharger(charger(0), 2400, 1, T0 + 70_000, -2400, false);
  await d._stepCharger(charger(0), 2400, 1, T0 + 70_000 + HOLD + 1, -2400, false);
  assert.strictEqual(amps(d), null, 'no start a minute after the stop');
  await d._stepCharger(charger(0), 2400, 1, T0 + FLIP_COOLDOWN_MS + 1, -2400, false);
  await d._stepCharger(charger(0), 2400, 1, T0 + FLIP_COOLDOWN_MS + HOLD + 2, -2400, false);
  assert.ok(amps(d) > 0, 'after five minutes it starts');
});
