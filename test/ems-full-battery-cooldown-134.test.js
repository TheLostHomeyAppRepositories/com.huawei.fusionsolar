'use strict';

// Battery full: one minute instead of five before a running charger steps up again (1.3.4).
//
// Andi, 2026-10-15, 16:27 and a few minutes later: battery at 100 %, the charger at 7 A on
// one phase (1495 W) and the meter exporting 487 W, then 395 W. The rule wanted 9 A
// (2070 W against about 2 kW of surplus), but after the step down at 16:25 the charger may
// not step up for five minutes (FLIP_COOLDOWN_MS), and those were five minutes of export.
// The cooldown is there so a passing cloud does not make the charger flap; with the battery
// full, the battery rides out the dip. A start after a stop keeps the five minutes.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const chargerMixin = require('../lib/ems/chargerControl');
const timingMixin  = require('../lib/ems/timing');
const { FLIP_COOLDOWN_MS, BAT_FULL_FLIP_COOLDOWN_MS } = require('../lib/ems/constants');

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
const full = (w) => ({ baseW: w, roundUp: true });

// Two ticks a hold apart, starting `afterDownMs` after the last step down.
async function tryStepUp(d, rule, afterDownMs, drawn = 1495) {
  const t = T0 + afterDownMs;
  await d._stepCharger(charger(drawn), 2005, 1, t, -395, false, rule);
  await d._stepCharger(charger(drawn), 2005, 1, t + HOLD + 1, -395, false, rule);
}

test('the defaults: one minute with the battery full, five otherwise', () => {
  assert.strictEqual(BAT_FULL_FLIP_COOLDOWN_MS, 60_000);
  assert.strictEqual(FLIP_COOLDOWN_MS, 5 * 60_000);
});

test('16:27 on 2026-10-15: at 7 A, 70 s after the step down, a full battery lets it climb to 9 A', async () => {
  const d = makeDevice();
  Object.assign(d._getChargerState('c1'), { currentAmps: 7, currentPhases: 1, lastDownStepAt: T0 });
  await tryStepUp(d, full(2005), 70_000);
  assert.strictEqual(amps(d), 9, '9 A is 2070 W against 2005 W of surplus');

  const plain = makeDevice();
  Object.assign(plain._getChargerState('c1'), { currentAmps: 7, currentPhases: 1, lastDownStepAt: T0 });
  await tryStepUp(plain, null, 70_000);
  assert.strictEqual(amps(plain), 7, 'without the rule the five minutes still hold');
});

test('inside the minute it still waits', async () => {
  const d = makeDevice();
  Object.assign(d._getChargerState('c1'), { currentAmps: 7, currentPhases: 1, lastDownStepAt: T0 });
  await d._stepCharger(charger(1495), 2005, 1, T0 + 50_000, -395, false, full(2005));
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null, 'not even planned yet');
  assert.strictEqual(amps(d), 7);
});

test('settling after the rule keeps the five minutes', async () => {
  const d = makeDevice();
  Object.assign(d._getChargerState('c1'), { currentAmps: 7, currentPhases: 1, lastDownStepAt: T0 });
  await tryStepUp(d, { baseW: 2300, roundUp: false }, 70_000);
  assert.strictEqual(amps(d), 7);
});

test('a start after a stop keeps the five minutes, battery full or not', async () => {
  const d = makeDevice();
  Object.assign(d._getChargerState('c1'), { currentAmps: null, currentPhases: 1, lastDownStepAt: T0 });
  await tryStepUp(d, full(2005), 70_000, 0);
  assert.strictEqual(amps(d), null, 'no start a minute after a stop');
  await tryStepUp(d, full(2005), FLIP_COOLDOWN_MS + 1, 0);
  assert.ok(amps(d) > 0, 'after five minutes it starts');
});
