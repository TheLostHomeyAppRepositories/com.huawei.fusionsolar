'use strict';

// Battery full: the EV charger may take the next rung (1.3.1, review 2026-10-15).
//
// A charger in solar mode takes the highest rung that fits the surplus and, once running,
// keeps 250 W free above it. While the house battery charges it soaks up that remainder.
// Once the battery is full the remainder goes to the grid, which Andi saw on most full
// afternoons. From the charger's "full" level on, it may now take the next rung up, and the
// full battery covers the gap of less than one rung. Below the second level it rounds down
// again, and the battery refills.
//
// These run the real _stepCharger, _fullBatteryRule and _evaluateEvChargers.
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const chargerMixin        = require('../lib/ems/chargerControl');
const timingMixin         = require('../lib/ems/timing');
const batteryMixin        = require('../lib/ems/battery');
const carsMixin           = require('../lib/ems/cars');
const priceMixin          = require('../lib/ems/price');
const pvForecastMixin     = require('../lib/ems/pvForecast');
const priceForecastMixin  = require('../lib/ems/priceForecast');
const chargeSessionsMixin = require('../lib/ems/chargeSessions');
const {
  STEP_HOLD_MS, BAT_FULL_ON_PCT, BAT_FULL_OFF_PCT, BAT_FULL_SETTLE_MS, IMPORT_ACT_W,
} = require('../lib/ems/constants');

function makeDevice() {
  const dev = {
    logs: [], fired: [],
    log(m) { this.logs.push(m); }, error() {},
    _warmupDone: true,
    _chargerStates: new Map(),
    _addHistoryEvent() {},
    _carStates: [],
    homey: {
      flow: { getTriggerCard: (id) => ({ trigger: (t) => { dev.fired.push({ id, ...t }); return Promise.resolve(); } }) },
      clock: { getTimezone: () => 'Europe/Zurich' },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    },
    getCapabilityValue() { return undefined; },
    _setMode(mode, text) { this._lastMode = { mode, text }; },
    _debugLog() {},
    setStoreValue() { return Promise.resolve(); },
    _chargeSessions: [],
    _getConfig: () => ({}),
  };
  Object.assign(dev, batteryMixin, carsMixin, priceMixin, pvForecastMixin, priceForecastMixin,
    chargerMixin, chargeSessionsMixin, timingMixin);
  return dev;
}

const T0 = Date.now();
const charger1 = (over = {}) => ({ id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1,
  phaseSwitch: false, ...over });
const seed = (dev, patch) => Object.assign(dev._getChargerState('c1'), patch);
const amps = (dev) => dev._getChargerState('c1').currentAmps;

// Two ticks: the step-up is planned on the first and committed STEP_HOLD_MS later.
async function settle(dev, c, budgetW, rule, t0 = T0) {
  await dev._stepCharger(c, budgetW, c.phases, t0, 0, false, rule);
  await dev._stepCharger(c, budgetW, c.phases, t0 + STEP_HOLD_MS + 1, 0, false, rule);
}

// ── the rung ────────────────────────────────────────────────────────────────────────

test('with the battery full the charger takes the next rung above the surplus', async () => {
  // 2000 W of surplus at one phase: 8 A (1840 W) fits, 9 A (2070 W) is 70 W short.
  const plain = makeDevice();
  seed(plain, { currentAmps: 8, currentPhases: 1 });
  await settle(plain, charger1(), 2000, null);
  assert.strictEqual(amps(plain), 8, 'the plain rule rounds down and leaves 160 W to the grid');

  const full = makeDevice();
  seed(full, { currentAmps: 8, currentPhases: 1 });
  await settle(full, charger1(), 2000, { baseW: 2000, roundUp: true });
  assert.strictEqual(amps(full), 9, 'one rung up, the battery covers 70 W');
});

test('a surplus exactly on a rung takes that rung and nothing above it', async () => {
  const d = makeDevice();
  seed(d, { currentAmps: 8, currentPhases: 1 });
  await settle(d, charger1(), 2070, { baseW: 2070, roundUp: true });
  assert.strictEqual(amps(d), 9);
});

test('the 250 W kept free above a running charger falls away with the battery full', async () => {
  // 9 A (2070 W) fits 2080 W, but the plain rule only climbs with 250 W to spare.
  const plain = makeDevice();
  seed(plain, { currentAmps: 8, currentPhases: 1 });
  await settle(plain, charger1(), 2080, null);
  assert.strictEqual(amps(plain), 8);

  const full = makeDevice();
  seed(full, { currentAmps: 8, currentPhases: 1 });
  await settle(full, charger1(), 2080, { baseW: 2080, roundUp: true });
  assert.strictEqual(amps(full), 10, '10 A is 220 W short, less than one rung');
});

test('at three phases one rung is 690 W', async () => {
  const c = charger1({ phases: 3 });
  const d = makeDevice();
  seed(d, { currentAmps: 6, currentPhases: 3 });
  await settle(d, c, 4500, { baseW: 4500, roundUp: true });
  assert.strictEqual(amps(d), 7, '7 A at three phases is 4830 W, 330 W short');

  // On a rung exactly, the next one would be a whole rung short: it stays.
  const onRung = makeDevice();
  seed(onRung, { currentAmps: 6, currentPhases: 3 });
  await settle(onRung, c, 4140, { baseW: 4140, roundUp: true });
  assert.strictEqual(amps(onRung), 6);
});

// ── when the rule applies ───────────────────────────────────────────────────────────

test('full from the upper level, back below the lower one, with the gap in between', () => {
  const d = makeDevice();
  const c = charger1();
  seed(d, { currentAmps: 9, currentPhases: 1 });
  const rule = (soc, batW = 0) => d._fullBatteryRule(c, { soc, powerW: batW }, -100, false, 2000, T0);
  assert.strictEqual(rule(BAT_FULL_ON_PCT - 1), null, 'not yet full');
  assert.deepStrictEqual(rule(BAT_FULL_ON_PCT), { baseW: 2000, roundUp: true });
  assert.deepStrictEqual(rule(BAT_FULL_OFF_PCT), { baseW: 2000, roundUp: true }, 'still full down to the lower level');
  assert.strictEqual(rule(BAT_FULL_OFF_PCT - 1, -20), null, 'below it, and the battery barely discharges: the plain rule');
  assert.ok(d.logs.some((l) => /battery full/.test(l)) && d.logs.some((l) => /back to the rung/.test(l)), 'both changes logged once');
});

test('the levels come from the charger, with 97 / 93 % as defaults', () => {
  const d = makeDevice();
  const c = charger1({ batFullOnPct: 90, batFullOffPct: 85 });
  assert.ok(d._fullBatteryRule(c, { soc: 90, powerW: 0 }, 0, false, 1000, T0).roundUp);
  assert.ok(d._fullBatteryRule(c, { soc: 86, powerW: 0 }, 0, false, 1000, T0).roundUp);
  assert.strictEqual(BAT_FULL_ON_PCT, 97);
  assert.strictEqual(BAT_FULL_OFF_PCT, 93);
});

test('the rule measures the real surplus: what the battery discharges is a shortfall', () => {
  const d = makeDevice();
  const r = d._fullBatteryRule(charger1(), { soc: 99, powerW: -133 }, 0, false, 2133, T0);
  assert.deepStrictEqual(r, { baseW: 2000, roundUp: true });
});

test('not while the grid imports, not when switched off, not without the battery power', () => {
  const d = makeDevice();
  assert.strictEqual(d._fullBatteryRule(charger1(), { soc: 99, powerW: 0 }, IMPORT_ACT_W, false, 2000, T0), null);
  assert.strictEqual(d._fullBatteryRule(charger1(), { soc: 99, powerW: 0 }, 0, true, 2000, T0), null, 'sustained import');
  assert.strictEqual(makeDevice()._fullBatteryRule(charger1({ batFullTopUp: false }), { soc: 99, powerW: 0 }, 0, false, 2000, T0), null);
  assert.strictEqual(makeDevice()._fullBatteryRule(charger1(), { soc: 99, powerW: null }, 0, false, 2000, T0), null);
  assert.strictEqual(makeDevice()._fullBatteryRule(charger1(), { soc: null, powerW: 0 }, 0, false, 2000, T0), null);
});

// ── no climbing on the battery, and a way back down ───────────────────────────────

test('the charger does not climb rung after rung on the battery', async () => {
  // 9 A drawn at a real 237 V is 2133 W against 2000 W of surplus; the battery covers 133 W
  // and the meter reads zero. The budget is therefore the draw. Rounding THAT up would take
  // 10 A, then 11 A, each paid by the battery.
  const d = makeDevice();
  const c = charger1({ powerW: 2133, rawPowerW: 2133 });
  seed(d, { currentAmps: 9, currentPhases: 1 });
  for (let i = 0; i < 12; i++) {
    const t = T0 + i * (STEP_HOLD_MS + 1);
    const rule = d._fullBatteryRule(c, { soc: 99, powerW: -133 }, 0, false, 2133, t);
    await d._stepCharger(c, 2133, 1, t, 0, false, rule);
  }
  assert.strictEqual(amps(d), 9);

  const naive = makeDevice();
  seed(naive, { currentAmps: 9, currentPhases: 1 });
  for (let i = 0; i < 4; i++) {
    await naive._stepCharger(c, 2133 + (amps(naive) - 9) * 237, 1, T0 + i * (STEP_HOLD_MS + 1), 0, false, { baseW: 2133 + (amps(naive) - 9) * 237, roundUp: true });
  }
  assert.ok(amps(naive) > 9, 'measured against the meter alone, it would climb');
});

test('after the rule the charger steps down off the rung the battery paid for', async () => {
  // 10 A (2300 W) on 2070 W of surplus, the battery covering 230 W. The plain rule cannot
  // see that: the meter reads zero, the budget is the draw, and the draw fits.
  const c = charger1({ powerW: 2300, rawPowerW: 2300 });
  const plain = makeDevice();
  seed(plain, { currentAmps: 10, currentPhases: 1 });
  await plain._stepCharger(c, 2300, 1, T0, 0, false, null);
  assert.strictEqual(amps(plain), 10, 'the plain rule would keep it for ever');

  const d = makeDevice();
  seed(d, { currentAmps: 10, currentPhases: 1, batFull: true });
  const rule = d._fullBatteryRule(c, { soc: 92, powerW: -230 }, 0, false, 2300, T0);
  assert.deepStrictEqual(rule, { baseW: 2070, roundUp: false }, 'settling: real surplus, rounded down');
  await d._stepCharger(c, 2300, 1, T0, 0, false, rule);
  assert.strictEqual(amps(d), 9);

  // Once the battery no longer pays, the settle is over and the plain rule is back.
  assert.strictEqual(d._fullBatteryRule(c, { soc: 92, powerW: 40 }, 0, false, 2070, T0 + 60_000), null);
  assert.strictEqual(d._getChargerState('c1').batFullSettleUntil, null);
});

test('the settle ends on its own after a while, and only a running charger settles', () => {
  const c = charger1();
  const d = makeDevice();
  seed(d, { currentAmps: 10, currentPhases: 1, batFull: true });
  assert.ok(d._fullBatteryRule(c, { soc: 92, powerW: -500 }, 0, false, 2300, T0));
  assert.strictEqual(d._fullBatteryRule(c, { soc: 92, powerW: -500 }, 0, false, 2300, T0 + BAT_FULL_SETTLE_MS + 1), null);

  const idle = makeDevice();
  seed(idle, { currentAmps: 0, currentPhases: 1, batFull: true });
  assert.strictEqual(idle._fullBatteryRule(c, { soc: 92, powerW: -500 }, 0, false, 2300, T0), null);
});

test('outside the rule nothing changes, also right after a start', () => {
  // The first look after a start must not pull a running charger down to the real surplus:
  // that would change the plain rule for every installation with a battery.
  const d = makeDevice();
  seed(d, { currentAmps: 12, currentPhases: 1 });
  assert.strictEqual(d._fullBatteryRule(charger1(), { soc: 60, powerW: -3521 }, 0, false, 2760, T0), null);
});

// ── the whole loop ───────────────────────────────────────────────────────────────────

test('_evaluateEvChargers: battery full, the charger takes the next rung and says so', async () => {
  const realNow = Date.now;
  let clock = T0;
  Date.now = () => clock;
  try {
    const d = makeDevice();
    seed(d, { currentAmps: 8, currentPhases: 1 });
    // 8 A drawn, 160 W exported, battery full and idle: 2000 W of surplus.
    const c = charger1({ powerW: 1840, rawPowerW: 1840 });
    const battery = { soc: 99, powerW: 0 };
    await d._evaluateEvChargers(battery, -160, [c], {});
    clock += STEP_HOLD_MS + 1;
    await d._evaluateEvChargers(battery, -160, [c], {});
    assert.strictEqual(amps(d), 9);
    assert.match(d._lastMode.text, /^Akku voll · 9A\/1ph/);

    // Below the lower level the label goes, and the next decision is the plain one again.
    clock += STEP_HOLD_MS + 1;
    await d._evaluateEvChargers({ soc: 92, powerW: 0 }, 70, [charger1({ powerW: 2070, rawPowerW: 2070 })], {});
    assert.doesNotMatch(d._lastMode.text, /Akku voll/);
  } finally {
    Date.now = realNow;
  }
});

// ── settings ─────────────────────────────────────────────────────────────────────────

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('the levels are per charger: settings page, validation, charger object', () => {
  const page = read('settings', 'index.html');
  assert.match(page, /fullChk\.className = 'ems-charger-fulltopup';/);
  assert.match(page, /fullChk\.checked = !\(stored && stored\.full_battery_topup === false\);/, 'on unless switched off');
  assert.match(page, /c\.full_battery_topup = fullChkEl \? fullChkEl\.checked : true;/);
  assert.match(page, /c\.full_battery_on_pct  = \(isFinite\(fullOnP\)  && fullOnP  >= 50 && fullOnP  <= 100\) \? fullOnP  : 97;/);
  assert.match(page, /entry\.appendChild\(stepRow\); entry\.appendChild\(fullRow\);/);

  const dev = read('drivers', 'energy_management', 'device.js');
  assert.match(dev, /clamp\(c, 'full_battery_on_pct', 50, 100\);/);
  assert.match(dev, /full_battery_off_pct ≥ on/);
  assert.match(dev, /batFullTopUp:  c\.full_battery_topup !== false,/);
  assert.match(dev, /batFullOnPct:  pctOrUndef\(c\.full_battery_on_pct\),/);
  // An empty field must not become 0 %, which would round up all day.
  const pctOrUndef = eval(dev.match(/const pctOrUndef = (\(v\) => [^;]*);/)[1]);
  assert.strictEqual(pctOrUndef(''), undefined);
  assert.strictEqual(pctOrUndef(null), undefined);
  assert.strictEqual(pctOrUndef('95'), 95);

  for (const l of ['en', 'de', 'nl']) {
    const c = require(`../locales/${l}.json`).settings.chargers;
    for (const k of ['fullBattery', 'fullBatteryOn', 'fullBatteryOff', 'fullBatteryHint']) {
      assert.ok(c[k], `${l}: ${k}`);
    }
    assert.doesNotMatch(c.fullBatteryHint, /Home Assistant/);
  }
});
