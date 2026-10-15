'use strict';

// Battery full, the phase count too (1.3.2, review 2026-10-15).
//
// Andi's log from 2026-10-15, afternoon, battery at 100 % from 12:48. The surplus sat
// between 3.7 and 4.8 kW, and the charger switched between one and three phases six times
// in an hour:
//   14:11 → 7 A 3ph, 14:21 → 15 A 1ph, 14:41 start 6 A 3ph, 14:47 → 14 A 1ph,
//   14:57 → 7 A 3ph, 15:03 → 15 A 1ph.
// The cause is the switch rule. Three phases need 4830 W (6 A × 3 × 230 plus a rung of
// headroom), and the charger drops back the moment the surplus falls below 4140 W. At
// 16 A on one phase (3680 W) the rest went to the grid: −1273 W at 14:57, −531 W at 15:13.
// The 1.3.1 rule rounded up within one phase count only.
//
// With the battery full, both edges now sit one three-phase rung lower: three phases from
// 4140 W of real surplus, back to one phase below 3450 W. The 690 W between the two stays.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const chargerMixin = require('../lib/ems/chargerControl');
const timingMixin  = require('../lib/ems/timing');
const { MIN_3PH_W, PHASE_UP_MARGIN_W, PHASE_SWITCH_COOLDOWN_MS } = require('../lib/ems/constants');

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
const charger = () => ({ id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: true });
const state = (d) => d._getChargerState('c1');
const full = (w) => ({ baseW: w, roundUp: true });

// One tick with the charger drawing what it was last told.
async function tick(d, t, realW, rule) {
  const st = state(d);
  const drawn = (st.currentAmps || 0) * (st.currentPhases || 1) * 230;
  const c = { ...charger(), powerW: drawn, rawPowerW: drawn };
  await d._stepCharger(c, realW, 3, t, 0, false, rule === undefined ? null : rule);
  return `${st.currentAmps}A/${st.currentPhases}ph`;
}

// ── the edges ─────────────────────────────────────────────────────────────────────────

test('with the battery full both phase edges sit one three-phase rung lower', () => {
  const d = makeDevice();
  assert.strictEqual(d._bestPhases(MIN_3PH_W, 1, true), 3, 'up as soon as the floor fits: 4140 W');
  assert.strictEqual(d._bestPhases(MIN_3PH_W - 1, 1, true), 1);
  assert.strictEqual(d._bestPhases(MIN_3PH_W - 690, 3, true), 3, 'stays down to 3450 W');
  assert.strictEqual(d._bestPhases(MIN_3PH_W - 691, 3, true), 1);
  // The plain edges are untouched.
  assert.strictEqual(d._bestPhases(MIN_3PH_W + PHASE_UP_MARGIN_W - 1, 1), 1);
  assert.strictEqual(d._bestPhases(MIN_3PH_W + PHASE_UP_MARGIN_W, 1), 3);
  assert.strictEqual(d._bestPhases(MIN_3PH_W - 1, 3), 1);
});

test('at 16 A on one phase with 4.2 kW to spare, a full battery takes three phases', async () => {
  const plain = makeDevice();
  Object.assign(state(plain), { currentAmps: 16, currentPhases: 1 });
  assert.strictEqual(await tick(plain, T0, 4200), '16A/1ph', 'the plain rule wants 4830 W and exports 520 W');

  const d = makeDevice();
  Object.assign(state(d), { currentAmps: 16, currentPhases: 1 });
  assert.strictEqual(await tick(d, T0, 4200, full(4200)), '7A/3ph', '7 A is 630 W short, less than one three-phase rung');

  // Exactly on the floor: 6 A, not the rung above it.
  const edge = makeDevice();
  Object.assign(state(edge), { currentAmps: 16, currentPhases: 1 });
  assert.strictEqual(await tick(edge, T0, MIN_3PH_W, full(MIN_3PH_W)), '6A/3ph');
});

test('a dip below 4140 W keeps three phases while the battery is full', async () => {
  const plain = makeDevice();
  Object.assign(state(plain), { currentAmps: 6, currentPhases: 3, lastPhaseSwitchAt: T0 });
  assert.strictEqual(await tick(plain, T0 + 60_000, 3800), '16A/1ph', 'the plain rule drops at once');

  const d = makeDevice();
  Object.assign(state(d), { currentAmps: 6, currentPhases: 3, lastPhaseSwitchAt: T0 });
  assert.strictEqual(await tick(d, T0 + 60_000, 3800, full(3800)), '6A/3ph', 'the battery covers 340 W');
  assert.strictEqual(await tick(d, T0 + 120_000, 3400, full(3400)), '15A/1ph', 'below 3450 W it drops, to the next rung up on one phase');
});

test('going up still waits out the cooldown', async () => {
  const d = makeDevice();
  Object.assign(state(d), { currentAmps: 16, currentPhases: 1, lastPhaseSwitchAt: T0 });
  assert.strictEqual(await tick(d, T0 + PHASE_SWITCH_COOLDOWN_MS - 1, 4500, full(4500)), '16A/1ph');
  assert.strictEqual(await tick(d, T0 + PHASE_SWITCH_COOLDOWN_MS + 1, 4500, full(4500)), '7A/3ph');
});

test('settling after the rule measures the phase count against the real surplus, plain edges', async () => {
  // Three phases the battery was paying for: 4000 W real against the 4140 W floor.
  const d = makeDevice();
  Object.assign(state(d), { currentAmps: 6, currentPhases: 3, lastPhaseSwitchAt: T0 });
  assert.strictEqual(await tick(d, T0 + 60_000, 4140, { baseW: 4000, roundUp: false }), '16A/1ph');
});

// ── the afternoon of 2026-10-15, replayed ─────────────────────────────────────────────

test('the 2026-10-15 band: three phases once, instead of six switches', async () => {
  // Surplus readings in the band the log shows, eleven minutes apart so the up-cooldown
  // never holds anything back: the plain rule gets every chance to switch.
  const band = [4900, 4300, 4000, 4900, 4100, 3900, 4850, 4050, 4400, 3700, 4880, 3950];
  const switches = async (useRule) => {
    const d = makeDevice();
    Object.assign(state(d), { currentAmps: 16, currentPhases: 1 });
    let last = '1', n = 0;
    for (let i = 0; i < band.length; i++) {
      const p = (await tick(d, T0 + i * 11 * 60_000, band[i], useRule ? full(band[i]) : null)).split('/')[1][0];
      if (p !== last) { n++; last = p; }
    }
    return n;
  };
  const plain = await switches(false);
  const withRule = await switches(true);
  assert.ok(plain >= 6, `the plain rule switched ${plain} times`);
  assert.strictEqual(withRule, 1, 'up once, and it stays');
});
