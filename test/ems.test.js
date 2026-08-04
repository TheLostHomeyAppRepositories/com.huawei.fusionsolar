'use strict';

// Unit tests for the pure / near-pure EMS mixin logic. Run: node --test
// The mixins are plain method objects, so we attach them to a minimal fake device
// (`this`) with just the state/helpers each method touches — no Homey runtime needed.

const test   = require('node:test');
const assert = require('node:assert');

const priceMixin   = require('../lib/ems/price');
const carsMixin    = require('../lib/ems/cars');
const chargerMixin = require('../lib/ems/chargerControl');
const batteryMixin = require('../lib/ems/battery');
const pvForecastMixin = require('../lib/ems/pvForecast');
const priceForecastMixin = require('../lib/ems/priceForecast');
const simpleDevicesMixin = require('../lib/ems/simpleDevices');
const exportLimitMixin = require('../lib/ems/exportLimit');
const chargeSessionsMixin = require('../lib/ems/chargeSessions');
const widgetMixin         = require('../lib/ems/widget');
const { MIN_3PH_W, STEP_HOLD_MS, EXPORT_GUARD_W, MIN_CHARGE_W, EXPORT_LIMIT_HOLD_MS } = require('../lib/ems/constants');

function makeDevice(extra = {}) {
  const dev = {
    homey: { clock: { getTimezone: () => 'Europe/Zurich' } },
    log() {}, error() {},
    _postNotification() {},
    _debugLog() {},
    _variablePrice: null,
    _carStates: [],
    _carSocTrack: {},
  };
  Object.assign(dev, priceMixin, carsMixin, chargerMixin, batteryMixin, pvForecastMixin, priceForecastMixin, extra);
  return dev;
}

// Fake device for exercising the real _stepCharger / _chargerSetAmps / _chargerStop
// against an in-memory charger-state map. Flow triggers + history are stubbed so the
// state mutations (currentAmps / currentPhases) run exactly as in production.
function makeChargerDevice(extra = {}) {
  const dev = {
    log() {}, error() {},
    _warmupDone: true,
    _chargerStates: new Map(),
    _addHistoryEvent() {},
    _carStates: [],
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'Europe/Zurich' } },
    // _evaluateEvChargers reads capabilities like 'charge_now' / 'offpeak_enabled' — stub
    // as "unset" (falsy) unless a test overrides it via extra.getCapabilityValue.
    getCapabilityValue() { return undefined; },
    // _setMode lives directly on the device class (buffered mode setter), not a mixin —
    // record the last call so tests can assert on it.
    _setMode(mode, text) { this._lastMode = { mode, text }; },
    _debugLog() {},
    setStoreValue() { return Promise.resolve(); },
    _chargeSessions: [],
  };
  // batteryMixin (_batteryZones), carsMixin (_carForCharger), priceMixin (_offpeakWindow),
  // pvForecastMixin + priceForecastMixin (_priceShouldChargeNow) — all things _evaluateEvChargers
  // calls via `this` for the P1/P3/P3b tiers.
  Object.assign(dev, batteryMixin, carsMixin, priceMixin, pvForecastMixin, priceForecastMixin, chargerMixin, chargeSessionsMixin, extra);
  return dev;
}

// A plain single-phase charger (6–32 A, no phase switching).
const CHARGER_1PH = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
function seedState(dev, id, patch) {
  const st = dev._getChargerState(id);
  Object.assign(st, patch);
  return st;
}

// Fake device for _evaluateSimpleDevices. `_simpleDeviceSetOn` is stubbed to record the
// on/off DECISION (not fire flows), so tests assert what the state machine decided.
function makeSimpleDevice(extra = {}) {
  const dev = {
    log() {}, _warmupDone: true, _addHistoryEvent() {},
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) } },
  };
  Object.assign(dev, simpleDevicesMixin, batteryMixin, pvForecastMixin, chargerMixin, extra);
  dev._setOnCalls = [];
  dev._simpleDeviceSetOn = async function (id, name, on) { this._setOnCalls.push({ id, on }); };
  return dev;
}
// A simple device with `actualOn: null` (EMS-state mode) so drift-sync is skipped and the
// decision is purely surplus/battery/timer driven.
function simpleDev(over = {}) {
  return Object.assign({
    id: 'd1', name: 'HP', actualOn: null, powerW: null,
    minSurplusW: 1000, minPowerW: 0,
    startSustainMs: 60_000, stopGraceMs: 120_000, maxRunMs: 0,
    restartCooldownMs: 0, startupGraceMs: 120_000, stateSource: 'ems',
  }, over);
}

// Fake device for _evaluateExportLimit. Trigger firing + persistence are stubbed; `_fired`
// records which on/off card was fired.
function makeExportDevice(extra = {}) {
  const dev = {
    log() {}, _exportLimitActive: false, _exportLimitActivatedAt: null,
    _loggedExportSocMisconfig: false, _addHistoryEvent() {},
  };
  Object.assign(dev, exportLimitMixin, extra);
  // Override AFTER assign — these names also exist on the mixin (would otherwise call the
  // real store/flow methods that the fake device doesn't have).
  dev._fired = [];
  dev._persistExportLimit = async function () {};
  dev._fireExportLimitTrigger = async function (cfg, cardId) { this._fired.push(cardId); };
  return dev;
}
const EXPORT_CFG = { export_limit_enabled: true, export_limit_trigger_soc: 95, export_limit_deactivate_soc: 90, inverter_devices: [{ id: 'inv1' }] };

// ── price: _parseTime ────────────────────────────────────────────────────────
test('_parseTime parses HH:MM to minutes', () => {
  const d = makeDevice();
  assert.strictEqual(d._parseTime('22:00'), 1320);
  assert.strictEqual(d._parseTime('06:30'), 390);
  assert.strictEqual(d._parseTime('00:00'), 0);
  assert.strictEqual(d._parseTime('23:59'), 1439);
});
test('_parseTime rejects invalid input', () => {
  const d = makeDevice();
  assert.strictEqual(d._parseTime('24:00'), null);
  assert.strictEqual(d._parseTime('9:99'), null);
  assert.strictEqual(d._parseTime('nope'), null);
  assert.strictEqual(d._parseTime(''), null);
  assert.strictEqual(d._parseTime(null), null);
});

// ── price: _getCurrentPrice ──────────────────────────────────────────────────
test('_getCurrentPrice — fixed', () => {
  const d = makeDevice();
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'fixed', price_fixed: 0.30 } }), 0.30);
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'fixed' } }), 0); // missing → 0
});
test('_getCurrentPrice — variable', () => {
  const d = makeDevice({ _variablePrice: 0.257 });
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'variable' } }), 0.257);
  const d2 = makeDevice({ _variablePrice: null });
  assert.strictEqual(d2._getCurrentPrice({ price_config: { mode: 'variable' } }), null); // unknown
});
test('_getCurrentPrice — forecast uses the current slot of the price forecast', () => {
  const now = Date.now();
  const d = makeDevice({ _variablePrice: null });
  d._priceForecast = [{ start: now - 1000, end: now + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = now;
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'forecast' } }), 0.199);
});
test('_getCurrentPrice — forecast ignores a stale forecast', () => {
  const now = Date.now();
  const d = makeDevice({ _variablePrice: null });
  d._priceForecast = [{ start: now - 1000, end: now + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = now - 31 * 3600_000; // older than PRICE_FORECAST_STALE_MS (30h)
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'forecast' } }), null);
});
test('_getCurrentPrice — variable does not fall back to the forecast (separate modes now)', () => {
  const now = Date.now();
  const d = makeDevice({ _variablePrice: null });
  d._priceForecast = [{ start: now - 1000, end: now + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = now;
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'variable' } }), null);
});
test('_getCurrentPrice — default mode is fixed', () => {
  const d = makeDevice();
  assert.strictEqual(d._getCurrentPrice({ price_config: { price_fixed: 0.2 } }), 0.2);
});

// ── price: _offpeakWindow ────────────────────────────────────────────────────
test('_offpeakWindow returns amps + boolean active', () => {
  const d = makeDevice();
  const w = d._offpeakWindow({ offpeak_amps: 16, offpeak_start: '22:00', offpeak_end: '06:00' });
  assert.strictEqual(w.amps, 16);
  assert.strictEqual(typeof w.active, 'boolean');
});
test('_offpeakWindow invalid times → inactive', () => {
  const d = makeDevice();
  const w = d._offpeakWindow({ offpeak_start: 'bad', offpeak_end: 'bad' });
  assert.strictEqual(w.active, false);
});

// ── price: _dualTariffWindow (used by the "Solar & low tariff" charger mode) ──
test('_dualTariffWindow — not configured when mode is not dual', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'fixed', high_windows: { 1: { start: '08:00', end: '20:00' } } } });
  assert.strictEqual(w.configured, false);
});
test('_dualTariffWindow — not configured when dual but no window has both start+end', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'dual', high_windows: { 1: { start: '08:00' } } } });
  assert.strictEqual(w.configured, false);
});
test('_dualTariffWindow — configured when dual with at least one full weekday window', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'dual', high_windows: { 1: { start: '08:00', end: '20:00' } } } });
  assert.strictEqual(w.configured, true);
  assert.strictEqual(typeof w.isHigh, 'boolean');
});
test('_dualTariffWindow — missing/invalid window for today → isHigh false', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'dual', high_windows: {} } });
  assert.strictEqual(w.isHigh, false);
});

// ── chargerControl: _bestPhases ──────────────────────────────────────────────
test('_bestPhases — 3-phase above threshold, 1-phase below', () => {
  const d = makeDevice();
  assert.strictEqual(d._bestPhases(MIN_3PH_W), 3);
  assert.strictEqual(d._bestPhases(MIN_3PH_W + 100), 3);
  assert.strictEqual(d._bestPhases(MIN_3PH_W - 1), 1);
  assert.strictEqual(d._bestPhases(0), 1);
});

// ── cars: _pickChargingCar ───────────────────────────────────────────────────
test('_pickChargingCar — none / single', () => {
  assert.strictEqual(makeDevice({ _carStates: [] })._pickChargingCar(), null);
  const one = { id: 'a', name: 'Audi', soc: 50, target: 90 };
  assert.strictEqual(makeDevice({ _carStates: [one] })._pickChargingCar(), one);
});
test('_pickChargingCar — picks the most-recently-risen car', () => {
  const a = { id: 'a', name: 'A', soc: 50, target: 90 };
  const b = { id: 'b', name: 'B', soc: 40, target: 80 };
  const now = Date.now();
  const d = makeDevice({
    _carStates: [a, b],
    _carSocTrack: { a: { lastRiseAt: now - 5 * 60000 }, b: { lastRiseAt: now - 30000 } },
  });
  assert.strictEqual(d._pickChargingCar(), b); // b rose more recently
});
test('_pickChargingCar — no recent rise → null', () => {
  const a = { id: 'a', name: 'A', soc: 50, target: 90 };
  const b = { id: 'b', name: 'B', soc: 40, target: 80 };
  const old = Date.now() - 60 * 60000; // 60 min ago (> 30 min window)
  const d = makeDevice({
    _carStates: [a, b],
    _carSocTrack: { a: { lastRiseAt: old }, b: { lastRiseAt: old } },
  });
  assert.strictEqual(d._pickChargingCar(), null);
});

// ── cars: _carForCharger (CR1) ───────────────────────────────────────────────
test('_carForCharger — explicit mapping wins', () => {
  const a = { id: 'a', name: 'A' }; const b = { id: 'b', name: 'B' };
  const d = makeDevice({ _carStates: [a, b] });
  assert.strictEqual(d._carForCharger({ carId: 'b' }), b);
  assert.strictEqual(d._carForCharger({ carId: 'nope' }), null);
});
test('_carForCharger — single car without mapping', () => {
  const a = { id: 'a', name: 'A' };
  const d = makeDevice({ _carStates: [a] });
  assert.strictEqual(d._carForCharger({ carId: null }), a);
});
test('_carForCharger — multi car without mapping falls back to heuristic', () => {
  const a = { id: 'a', name: 'A' }; const b = { id: 'b', name: 'B' };
  const now = Date.now();
  const d = makeDevice({
    _carStates: [a, b],
    _carSocTrack: { a: { lastRiseAt: now - 60000 }, b: { lastRiseAt: now - 10000 } },
  });
  assert.strictEqual(d._carForCharger({ carId: null }), b);
});

// ── cars: _setCapTitle guards setCapabilityOptions against redundant calls ───
test('_setCapTitle — skips setCapabilityOptions when the title is unchanged', async () => {
  let calls = 0;
  const d = makeDevice({ setCapabilityOptions: async () => { calls++; } });
  await d._setCapTitle('measure_car_soc.a', 'My Car');
  await d._setCapTitle('measure_car_soc.a', 'My Car'); // same title again — e.g. a second settings save
  assert.strictEqual(calls, 1);
});
test('_setCapTitle — calls setCapabilityOptions again when the title actually changes', async () => {
  let calls = 0;
  const d = makeDevice({ setCapabilityOptions: async () => { calls++; } });
  await d._setCapTitle('measure_car_soc.a', 'My Car');
  await d._setCapTitle('measure_car_soc.a', 'Renamed Car');
  assert.strictEqual(calls, 2);
});

// ── battery: _batteryZones ───────────────────────────────────────────────────
test('_batteryZones — no low zone: below min is a hard stop', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80 }; // min_battery_soc_low defaults to 0 → no reserve zone
  assert.deepStrictEqual(
    d._batteryZones(cfg, { soc: 90 }),
    { minSoc: 80, minSocLow: 0, hasLowZone: false, batLow: false, batReserve: false, batHardStop: false });
  const low = d._batteryZones(cfg, { soc: 70 });
  assert.strictEqual(low.batLow, true);
  assert.strictEqual(low.batReserve, false);
  assert.strictEqual(low.batHardStop, true);
});
test('_batteryZones — soc null → nothing triggers', () => {
  const d = makeDevice();
  const z = d._batteryZones({ min_battery_soc: 80, min_battery_soc_low: 50 }, { soc: null });
  assert.strictEqual(z.batLow, false);
  assert.strictEqual(z.batReserve, false);
  assert.strictEqual(z.batHardStop, false);
});
test('_batteryZones — reserve (orange) zone between low and min', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 50 };
  const reserve = d._batteryZones(cfg, { soc: 60 });
  assert.strictEqual(reserve.batReserve, true);
  assert.strictEqual(reserve.batHardStop, false);
  // boundary: exactly at the low floor is still reserve (>=), not hard stop
  assert.strictEqual(d._batteryZones(cfg, { soc: 50 }).batReserve, true);
  // below the low floor → hard stop, no longer reserve
  const hard = d._batteryZones(cfg, { soc: 40 });
  assert.strictEqual(hard.batReserve, false);
  assert.strictEqual(hard.batHardStop, true);
  // exactly at min is not "low" at all
  assert.strictEqual(d._batteryZones(cfg, { soc: 80 }).batLow, false);
});
test('_batteryZones — misconfigured low ≥ min disables the reserve zone', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 90 };
  assert.strictEqual(d._batteryZones(cfg, { soc: 75 }).hasLowZone, false);
  assert.strictEqual(d._batteryZones(cfg, { soc: 75 }).batHardStop, true); // treated as hard stop, not reserve
});

// ── chargerControl: _stepCharger ─────────────────────────────────────────────
const T = 1_000_000_000; // fixed "now" base for deterministic timing

test('_stepCharger — warmup tick observes only, never commands', async () => {
  const d = makeChargerDevice({ _warmupDone: false });
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  const res = await d._stepCharger(CHARGER_1PH, 5000, 1, T, -1000, false);
  assert.strictEqual(res.amps, 10); // returns current, no change
  assert.strictEqual(d._getChargerState('c1').currentAmps, 10);
});

test('_stepCharger — budget below minimum, charger off → stays off, no command', async () => {
  const d = makeChargerDevice();
  const r = await d._stepCharger(CHARGER_1PH, 1000, 1, T, 0, false); // 1000 W < 6A(1380 W)
  assert.strictEqual(r.amps, 0);
  assert.strictEqual(r.allocatedW, 0);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // never started
});

test('_stepCharger — start requires STEP_HOLD before committing', async () => {
  const d = makeChargerDevice();
  // First tick with enough surplus for 6 A: arms a pending step, does not command yet.
  let r = await d._stepCharger(CHARGER_1PH, 1500, 1, T, -1500, false);
  assert.strictEqual(r.amps, 0);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 6);
  // Still within the hold window → keeps waiting.
  r = await d._stepCharger(CHARGER_1PH, 1500, 1, T + STEP_HOLD_MS - 1, -1500, false);
  assert.strictEqual(r.amps, 0);
  // Past the hold window → commits the start at 6 A.
  r = await d._stepCharger(CHARGER_1PH, 1500, 1, T + STEP_HOLD_MS + 1, -1500, false);
  assert.strictEqual(r.amps, 6);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 6);
});

test('_stepCharger — running, no rung fits, still exporting → hold at minimum', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  // budget below the 6 A rung, but grid is exporting past the guard → hold at 6 A, don't stop.
  const r = await d._stepCharger(CHARGER_1PH, 800, 1, T, -(EXPORT_GUARD_W + 100), false);
  assert.strictEqual(r.amps, 6);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 6);
});

test('_stepCharger — running, no rung fits, not exporting → stop', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  const r = await d._stepCharger(CHARGER_1PH, 800, 1, T, 0, false); // not exporting
  assert.strictEqual(r.amps, 0);
  assert.strictEqual(r.allocatedW, 0);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // stopped
});

test('_stepCharger — down-step held while still exporting, bypassed when forced', async () => {
  // Running at 16 A, budget now only supports 6 A, but grid still exporting past guard.
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });
  const held = await d._stepCharger(CHARGER_1PH, 1380, 1, T, -(EXPORT_GUARD_W + 100), false);
  assert.strictEqual(held.amps, 16); // export guard holds the higher rung
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16);
  // Forced down (sustained import) bypasses the guard and steps immediately.
  const forced = await d._stepCharger(CHARGER_1PH, 1380, 1, T + 1, 300, true);
  assert.strictEqual(forced.amps, 6);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 6);
});

// Regression: a running single-phase charger must ramp UP with growing surplus.
// (Previously stuck forever at its start amps because UP_MARGIN_W 250 W > the 230 W
//  single-phase rung gap made the step-up guard mathematically unsatisfiable.)
test('_stepCharger — 1-phase charger ramps up with surplus (leaving margin)', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 6, currentPhases: 1 });
  // 6000 W budget: highest rung leaving 250 W headroom is 25 A (5750 W); 26 A (5980) + 250 > 6000.
  let r = await d._stepCharger(CHARGER_1PH, 6000, 1, T, -6000, false);
  assert.strictEqual(r.amps, 6); // first tick arms the pending step
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 25);
  r = await d._stepCharger(CHARGER_1PH, 6000, 1, T + STEP_HOLD_MS + 1, -6000, false);
  assert.strictEqual(r.amps, 25); // committed after the hold
  assert.strictEqual(d._getChargerState('c1').currentAmps, 25);
});

test('_stepCharger — 1-phase step-up still honours the import margin', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 6, currentPhases: 1 });
  // Budget exactly covers 7 A (1610 W) but leaves no 250 W margin → must NOT step up.
  const r = await d._stepCharger(CHARGER_1PH, 1610, 1, T, -1610, false);
  assert.strictEqual(r.amps, 6);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null); // no step armed
  // With margin present (1610 + 250) it steps to 7 A after the hold.
  await d._stepCharger(CHARGER_1PH, 1860, 1, T + 1, -1860, false); // arm
  const up = await d._stepCharger(CHARGER_1PH, 1860, 1, T + 1 + STEP_HOLD_MS + 1, -1860, false);
  assert.strictEqual(up.amps, 7);
});

// ── pvForecast: Solcast parsing + aggregation ────────────────────────────────
test('_pvPeriodHours parses ISO-8601 durations', () => {
  const d = makeDevice();
  assert.strictEqual(d._pvPeriodHours('PT30M'), 0.5);
  assert.strictEqual(d._pvPeriodHours('PT1H'), 1);
  assert.strictEqual(d._pvPeriodHours('PT15M'), 0.25);
  assert.strictEqual(d._pvPeriodHours('PT1H30M'), 1.5);
  assert.strictEqual(d._pvPeriodHours('garbage'), 0.5); // default
  assert.strictEqual(d._pvPeriodHours(undefined), 0.5);
});

test('_parseSolcastForecasts — maps, sorts, drops invalid rows', () => {
  const d = makeDevice();
  const slots = d._parseSolcastForecasts({ forecasts: [
    { period_end: '2026-07-27T10:30:00.0000000Z', pv_estimate: 3.5, pv_estimate10: 2.0, pv_estimate90: 4.5, period: 'PT30M' },
    { period_end: '2026-07-27T10:00:00.0000000Z', pv_estimate: 3.0, period: 'PT30M' }, // earlier → sorts first
    { period_end: 'not-a-date',                   pv_estimate: 9,   period: 'PT30M' }, // bad timestamp → dropped
    { period_end: '2026-07-27T11:00:00.0000000Z', pv_estimate: 'x', period: 'PT30M' }, // bad power → dropped
  ] });
  assert.strictEqual(slots.length, 2);
  assert.ok(slots[0].end < slots[1].end);          // ascending
  assert.strictEqual(slots[0].kw, 3.0);
  assert.strictEqual(slots[1].kw, 3.5);
  assert.strictEqual(slots[1].kw10, 2.0);
  assert.strictEqual(slots[0].kw10, null);          // missing percentile → null
  assert.strictEqual(slots[0].h, 0.5);
});
test('_parseSolcastForecasts — empty / missing forecasts → []', () => {
  const d = makeDevice();
  assert.deepStrictEqual(d._parseSolcastForecasts({}), []);
  assert.deepStrictEqual(d._parseSolcastForecasts(null), []);
});

test('_pvSumKwh sums kW×h for slots whose end is in (from, to]', () => {
  const d = makeDevice();
  const slots = [
    { end: 1000, kw: 4, h: 0.5 },
    { end: 2000, kw: 2, h: 0.5 },
    { end: 3000, kw: 6, h: 0.5 },
  ];
  assert.strictEqual(d._pvSumKwh(slots, 1000, 3000), 4); // 2·0.5 + 6·0.5 (end 1000 excluded, 3000 included)
  assert.strictEqual(d._pvSumKwh(slots, 0, 1000), 2);    // only end 1000
  assert.strictEqual(d._pvSumKwh(slots, 3000, 9000), 0); // nothing after
  assert.strictEqual(d._pvSumKwh(null, 0, 9000), 0);
});

test('_pvMsUntilLocalMidnight — deterministic in UTC', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 22, 0, 0); // 22:00 UTC → 2 h to midnight
  assert.strictEqual(d._pvMsUntilLocalMidnight(now, 'UTC'), 2 * 3600 * 1000);
});

test('_pvForecastNextKwh — energy over the next N hours', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({ _pvForecastFetchedAt: now, _pvForecast: [
    { end: now + 30 * 60000, kw: 4, h: 0.5 },
    { end: now + 60 * 60000, kw: 2, h: 0.5 },
    { end: now + 180 * 60000, kw: 8, h: 0.5 }, // +3 h → outside a 2 h window
  ] });
  assert.strictEqual(d._pvForecastNextKwh(2, now), 3); // 4·0.5 + 2·0.5
  assert.strictEqual(d._pvForecastNextKwh(0, now), 0);
});

test('_pvForecastStale — fresh / old / never-fetched / no-data', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [{ end: now + 30 * 60000, kw: 4, h: 0.5 }];
  assert.strictEqual(makeDevice({ _pvForecast: slots, _pvForecastFetchedAt: now })._pvForecastStale(now), false);
  assert.strictEqual(makeDevice({ _pvForecast: slots, _pvForecastFetchedAt: now - 25 * 3600 * 1000 })._pvForecastStale(now), true);
  assert.strictEqual(makeDevice({ _pvForecast: slots, _pvForecastFetchedAt: null })._pvForecastStale(now), true);
  assert.strictEqual(makeDevice({ _pvForecast: null, _pvForecastFetchedAt: now })._pvForecastStale(now), true);
});

test('_pvForecast aggregation helpers return 0 when stale', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now - 25 * 3600 * 1000, // > 24 h → stale
    _pvForecast: [{ end: now + 30 * 60000, kw: 4, h: 0.5 }, { end: now + 60 * 60000, kw: 2, h: 0.5 }],
  });
  assert.strictEqual(d._pvForecastNextKwh(6, now), 0);
  assert.strictEqual(d._pvForecastNowKw(now), 0);
  assert.strictEqual(d._pvForecastRemainingTodayKwh(now), 0);
  assert.strictEqual(d._pvForecastTomorrowKwh(now), 0);
  assert.strictEqual(d._pvForecastUntilKwh('16:00', now), 0);
});

test('_solcastResourceIds — single / multi / separators', () => {
  const d = makeDevice();
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: 'abcd-1234' }), ['abcd-1234']);
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: 'a-1\nb-2' }), ['a-1', 'b-2']);
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: 'a-1, b-2 ; c-3' }), ['a-1', 'b-2', 'c-3']);
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: '   ' }), []);
  assert.deepStrictEqual(d._solcastResourceIds({}), []);
});

test('_mergeForecastSlots — sums two sites per slot end-time', () => {
  const d = makeDevice();
  const north = [{ end: 1000, kw: 3, kw10: 2, kw90: 4, h: 0.5 }, { end: 2000, kw: 1, kw10: null, kw90: 2, h: 0.5 }];
  const south = [{ end: 1000, kw: 5, kw10: 3, kw90: 6, h: 0.5 }, { end: 2000, kw: 2, kw10: 1, kw90: 3, h: 0.5 }];
  const merged = d._mergeForecastSlots([north, south]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].kw, 8);        // 3 + 5
  assert.strictEqual(merged[0].kw10, 5);       // 2 + 3
  assert.strictEqual(merged[1].kw, 3);        // 1 + 2
  assert.strictEqual(merged[1].kw10, null);    // one site missing P10 → null
  assert.strictEqual(merged[0].h, 0.5);
});
test('_mergeForecastSlots — single array passes through', () => {
  const d = makeDevice();
  const one = [{ end: 1000, kw: 3, kw10: null, kw90: null, h: 0.5 }];
  assert.strictEqual(d._mergeForecastSlots([one]), one);
});

test('_pvForecastNowKw — current in-progress slot', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({ _pvForecastFetchedAt: now, _pvForecast: [
    { end: now - 10 * 60000, kw: 9, h: 0.5 }, // already ended → not "now"
    { end: now + 20 * 60000, kw: 4, h: 0.5 }, // in progress → this one
    { end: now + 50 * 60000, kw: 6, h: 0.5 },
  ] });
  assert.strictEqual(d._pvForecastNowKw(now), 4);
  assert.strictEqual(makeDevice({ _pvForecastFetchedAt: now, _pvForecast: [] })._pvForecastNowKw(now), 0);
});

test('_pvForecastTomorrowKwh — sums the next local calendar day', () => {
  const now = Date.UTC(2026, 0, 1, 22, 0, 0); // 22:00 UTC → midnight in 2 h
  const mid = now + 2 * 3600 * 1000;           // next local midnight (UTC)
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [
      { end: now + 60 * 60000,        kw: 5, h: 0.5 }, // still today → excluded
      { end: mid + 6 * 3600 * 1000,   kw: 4, h: 0.5 }, // tomorrow 06:00
      { end: mid + 12 * 3600 * 1000,  kw: 8, h: 0.5 }, // tomorrow 12:00
      { end: mid + 30 * 3600 * 1000,  kw: 9, h: 0.5 }, // day after → excluded
    ],
  });
  assert.strictEqual(d._pvForecastTomorrowKwh(now), 6); // 4·0.5 + 8·0.5
});

test('_pvForecastConfigured — needs enabled + key + at least one site', () => {
  const d = makeDevice();
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: 'a-1' }), true);
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: false, solcast_api_key: 'k', solcast_resource_id: 'a-1' }), false);
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: true, solcast_api_key: '', solcast_resource_id: 'a-1' }), false);
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: '' }), false);
});

test('_pvMsUntilLocalTime — future / past / invalid', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 14, 0, 0); // 14:00 UTC
  assert.strictEqual(d._pvMsUntilLocalTime(now, 'UTC', '16:00'), 2 * 3600 * 1000); // 2 h ahead
  assert.strictEqual(d._pvMsUntilLocalTime(now, 'UTC', '13:00'), 0);               // already passed → 0
  assert.strictEqual(d._pvMsUntilLocalTime(now, 'UTC', 'nope'), 0);                // invalid → 0
});

test('_pvForecastUntilKwh — sums up to a wall-clock cutoff today', () => {
  const now = Date.UTC(2026, 0, 1, 14, 0, 0); // 14:00 UTC
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [
      { end: now + 30 * 60000,  kw: 4, h: 0.5 }, // 14:30 → before 16:00
      { end: now + 90 * 60000,  kw: 2, h: 0.5 }, // 15:30 → before 16:00
      { end: now + 150 * 60000, kw: 8, h: 0.5 }, // 16:30 → after 16:00 (excluded)
    ],
  });
  assert.strictEqual(d._pvForecastUntilKwh('16:00', now), 3); // 4·0.5 + 2·0.5
  assert.strictEqual(d._pvForecastUntilKwh('13:00', now), 0); // cutoff already passed
});

// ── simpleDevices: _evaluateSimpleDevices state machine ──────────────────────
test('_evaluateSimpleDevices — control disabled → no action', async () => {
  const d = makeSimpleDevice();
  const r = await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev()], new Map(), 'start', 'stop', 'tok', 'ctrl', { ctrl: false });
  assert.strictEqual(r, 0);
  assert.strictEqual(d._setOnCalls.length, 0);
});

test('_evaluateSimpleDevices — battery hard-stop forces a running device off', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // SoC 10 < min 80 → hard stop; battery idle (no overflow) → off despite ample surplus
  await d._evaluateSimpleDevices({ soc: 10, powerW: 0 }, -2000, [simpleDev()], state, 'start', 'stop', 'tok', 'ctrl', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});

test('_evaluateSimpleDevices — battery-overflow exception keeps it on (guards MIN_CHARGE_W path)', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // Hard-stop SoC, but battery charging AND exporting ≥ MIN_CHARGE_W → overflow exception → stays on
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -(MIN_CHARGE_W + 200), [simpleDev()], state, 'start', 'stop', 'tok', 'ctrl', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — overflow hysteresis: a running device stays on below the START threshold but above the CONTINUE one', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // Export is below MIN_CHARGE_W (the old fixed threshold — would have wrongly hard-stopped
  // a device that only just started, since its own draw reduces the apparent export on the
  // very next tick) but above MIN_CHARGE_W/2 (the CONTINUE threshold) — regression for the
  // reported "Pool/Entfeuchter stop within a minute of starting" bug.
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -(MIN_CHARGE_W / 2 + 50), [simpleDev()], state, 'start', 'stop', 'tok', 'ctrl', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});
test('_evaluateSimpleDevices — overflow hysteresis: a device NOT yet running needs the higher START threshold', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // Export clears the old flat MIN_CHARGE_W threshold and the CONTINUE threshold, but not
  // the higher 2×MIN_CHARGE_W START threshold — must not start via the overflow exception yet.
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -(MIN_CHARGE_W + 200), [simpleDev()], state, 'start', 'stop', 'tok', 'ctrl', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});

test('_evaluateSimpleDevices — start needs sustained surplus', async () => {
  const now = Date.now();
  const cfg = { min_battery_soc: 80 };
  const bat = { soc: 90, powerW: 0 }; // not hard-stop
  // surplus present but only just now → no start yet
  const d1 = makeSimpleDevice();
  await d1._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(d1._setOnCalls, [{ id: 'd1', on: false }]);
  // surplus held past startSustainMs → start
  const d2 = makeSimpleDevice();
  await d2._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(d2._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — min-run holds a fresh device on through a dip', async () => {
  const now = Date.now();
  const d = makeSimpleDevice();
  // started 1 min ago (< min-run 5 min), surplus now gone → hold-time keeps it on
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [simpleDev()],
    new Map([['d1', { isOn: true, startedAt: now - 60_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — stop-grace holds, then releases when expired', async () => {
  const now = Date.now();
  const cfg = { min_battery_soc: 80 };
  const bat = { soc: 90, powerW: 0 };
  // past min-run, surplus gone 30 s ago → within 120 s grace → stays on
  const d1 = makeSimpleDevice();
  await d1._evaluateSimpleDevices(bat, 0, [simpleDev({ stopGraceMs: 120_000 })],
    new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: now - 30_000, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(d1._setOnCalls, [{ id: 'd1', on: true }]);
  // grace expired (130 s > 120 s) → off
  const d2 = makeSimpleDevice();
  await d2._evaluateSimpleDevices(bat, 0, [simpleDev({ stopGraceMs: 120_000 })],
    new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: now - 130_000, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(d2._setOnCalls, [{ id: 'd1', on: false }]);
});

// ── exportLimit: _evaluateExportLimit hysteresis + hold timer ─────────────────
test('_evaluateExportLimit — activates when battery full and exporting', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 96 }, -500);
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_on']);
});
test('_evaluateExportLimit — no activation when not exporting', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 96 }, -50); // above the -100 W export floor
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — no activation when battery not full', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 90 }, -500); // below trigger SoC 95
  assert.strictEqual(d._exportLimitActive, false);
});
test('_evaluateExportLimit — hold timer blocks immediate deactivate', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() });
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 80 }, -500); // SoC below deactivate, but just activated
  assert.strictEqual(d._exportLimitActive, true); // held
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — deactivates after hold when SoC drops', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1 });
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 80 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});
test('_evaluateExportLimit — disabling while active fires OFF', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() });
  await d._evaluateExportLimit({ ...EXPORT_CFG, export_limit_enabled: false }, { soc: 96 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});

// ── pvForecast: _forecastGateBlocksStarts (solar-forecast start gate) ─────────
test('_forecastGateBlocksStarts — off / manual / adaptive / guards', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  function dev() {
    return makeDevice({
      homey: { clock: { getTimezone: () => 'UTC' } },
      _pvForecastFetchedAt: now,
      _pvForecast: [
        { end: now + 30 * 60000, kw: 4, h: 0.5 },
        { end: now + 60 * 60000, kw: 4, h: 0.5 },
      ], // remaining today = 4 kWh
    });
  }
  const withBat = { battery_devices: [{ id: 'b1' }] };
  // off → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'off' }, { soc: 60 }, now), false);
  // no battery configured → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ forecast_gate_mode: 'manual', forecast_gate_kwh: 5 }, { soc: 60 }, now), false);
  // manual: 4 < 5 → block; 4 < 3 → no
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'manual', forecast_gate_kwh: 5 }, { soc: 60 }, now), true);
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'manual', forecast_gate_kwh: 3 }, { soc: 60 }, now), false);
  // adaptive: cap 10 (on the single configured battery), soc 50 → deficit 5, 4 < 5 → block; soc 70 → deficit 3, 4 < 3 → no
  const oneBat10 = { battery_devices: [{ id: 'b1', capacity_kwh: 10 }] };
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...oneBat10, forecast_gate_mode: 'adaptive' }, { soc: 50 }, now), true);
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...oneBat10, forecast_gate_mode: 'adaptive' }, { soc: 70 }, now), false);
  // adaptive without capacity → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'adaptive' }, { soc: 50 }, now), false);
  // adaptive: multiple batteries → capacities are summed (4+6=10, same as the single-10 case)
  const twoBat = { battery_devices: [{ id: 'b1', capacity_kwh: 4 }, { id: 'b2', capacity_kwh: 6 }] };
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...twoBat, forecast_gate_mode: 'adaptive' }, { soc: 50 }, now), true);
  // stale forecast → never (falls back to normal)
  const stale = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _pvForecastFetchedAt: now - 25 * 3600 * 1000, _pvForecast: [{ end: now + 30 * 60000, kw: 4, h: 0.5 }] });
  assert.strictEqual(stale._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'manual', forecast_gate_kwh: 5 }, { soc: 60 }, now), false);
});

test('_evaluateSimpleDevices — forecast gate blocks a start, running device continues', async () => {
  const now = Date.now();
  const cfg = { min_battery_soc: 80, battery_devices: [{ id: 'b1' }], forecast_gate_mode: 'manual', forecast_gate_kwh: 100 };
  const bat = { soc: 90, powerW: 0 };
  const fc  = { _pvForecastFetchedAt: now, _pvForecast: [{ end: now + 30 * 60000, kw: 0, h: 0.5 }] }; // remaining ~0 < 100 → gate active

  // OFF + sustained surplus → would start, but gated → stays off
  const dStart = makeSimpleDevice(fc);
  await dStart._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(dStart._setOnCalls, [{ id: 'd1', on: false }]);

  // Already running → gate does NOT stop it
  const dRun = makeSimpleDevice(fc);
  await dRun._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: true, startedAt: now - 600000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(dRun._setOnCalls, [{ id: 'd1', on: true }]);
});

// ── priceForecast: time helpers ────────────────────────────────────────────────
test('_priceFloorToHour — floors to local hour boundary', () => {
  const d = makeDevice();
  const t = Date.UTC(2026, 0, 1, 12, 37, 22); // arbitrary
  const floored = d._priceFloorToHour(t, 'UTC');
  assert.strictEqual(floored, Date.UTC(2026, 0, 1, 12, 0, 0));
});

test('_priceForecastAnchor — this_day / tomorrow / next_hours', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 14, 37, 0); // 14:37 UTC
  assert.strictEqual(d._priceForecastAnchor(now, 'UTC', 'this_day'), Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.strictEqual(d._priceForecastAnchor(now, 'UTC', 'tomorrow'), Date.UTC(2026, 0, 2, 0, 0, 0));
  assert.strictEqual(d._priceForecastAnchor(now, 'UTC', 'next_hours'), Date.UTC(2026, 0, 1, 14, 0, 0));
});
test('_priceForecastAnchor — stable regardless of the calling millisecond (regression: caused duplicate slots on every re-trigger)', () => {
  const d = makeDevice();
  const base = Date.UTC(2026, 0, 1, 14, 37, 12); // 14:37:12.000 UTC
  const a1 = d._priceForecastAnchor(base, 'UTC', 'this_day');
  const a2 = d._priceForecastAnchor(base + 1, 'UTC', 'this_day');      // +1ms
  const a3 = d._priceForecastAnchor(base + 999, 'UTC', 'this_day');    // +999ms, still same second... next
  const a4 = d._priceForecastAnchor(base + 61237, 'UTC', 'this_day');  // over a minute later, arbitrary ms
  assert.strictEqual(a1, Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.strictEqual(a1, a2);
  assert.strictEqual(a1, a3);
  assert.strictEqual(a1, a4);
});
test('_priceFloorToHour — stable regardless of the calling millisecond', () => {
  const d = makeDevice();
  const base = Date.UTC(2026, 0, 1, 14, 37, 12); // 14:37:12.000 UTC
  const h1 = d._priceFloorToHour(base, 'UTC');
  const h2 = d._priceFloorToHour(base + 555, 'UTC');
  assert.strictEqual(h1, Date.UTC(2026, 0, 1, 14, 0, 0));
  assert.strictEqual(h1, h2);
});

test('_priceMsUntilDeadline — today if still ahead, else rolls to tomorrow', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 14, 37, 0); // 14:37 UTC
  assert.strictEqual(d._priceMsUntilDeadline(now, 'UTC', '20:00'), (5 * 60 + 23) * 60_000); // 5h23m
  assert.strictEqual(d._priceMsUntilDeadline(now, 'UTC', '07:00'), (16 * 60 + 23) * 60_000); // rolled to tomorrow, 16h23m
  assert.strictEqual(d._priceMsUntilDeadline(now, 'UTC', 'garbage'), null);
});

// ── priceForecast: ingestion ─────────────────────────────────────────────────
test('_ingestPriceForecast — parses, anchors and stores slots', async () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, setStoreValue: async () => {} });
  const now = Date.UTC(2026, 0, 1, 0, 0, 0); // exactly midnight UTC
  await d._ingestPriceForecast(JSON.stringify([0.10, 0.20, 0.30]), 'this_day', now);
  assert.strictEqual(d._priceForecast.length, 3);
  assert.deepStrictEqual(d._priceForecast[0], { start: now, end: now + 3600_000, price: 0.10 });
  assert.strictEqual(d._priceForecast[2].price, 0.30);
  assert.strictEqual(d._priceForecastUpdatedAt, now);
});

test('_ingestPriceForecast — rejects invalid JSON / non-array', async () => {
  const d = makeDevice({ setStoreValue: async () => {} });
  await assert.rejects(() => d._ingestPriceForecast('not json', 'this_day', Date.now()));
  await assert.rejects(() => d._ingestPriceForecast('{}', 'this_day', Date.now()));
  await assert.rejects(() => d._ingestPriceForecast('[]', 'this_day', Date.now()));
});

test('_ingestPriceForecast — later push overwrites overlapping slots, keeps others', async () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, setStoreValue: async () => {} });
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  await d._ingestPriceForecast(JSON.stringify([0.10, 0.20]), 'this_day', now); // hours 0,1
  await d._ingestPriceForecast(JSON.stringify([0.99]), 'next_hours', now); // overwrites hour 0
  assert.strictEqual(d._priceForecast.length, 2);
  assert.strictEqual(d._priceForecast[0].price, 0.99); // overwritten
  assert.strictEqual(d._priceForecast[1].price, 0.20); // untouched
});
test('_ingestPriceForecast — self-heals a pre-existing near-duplicate slot (leftover from the sub-ms anchor-drift bug)', async () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, setStoreValue: async () => {} });
  const hour0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const hour1 = hour0 + 3600_000;
  // Seed a stale slot 785 ms off from the clean hour1 boundary — exactly the kind of
  // near-duplicate the old (unfixed) anchor calculation would have produced.
  d._priceForecast = [{ start: hour1 + 785, end: hour1 + 785 + 3600_000, price: 0.77 }];
  await d._ingestPriceForecast(JSON.stringify([0.10, 0.20]), 'this_day', hour0);
  assert.strictEqual(d._priceForecast.length, 2); // stale 0.77 entry collapsed into the fresh hour1 slot, not appended
  assert.strictEqual(d._priceForecast[1].price, 0.20);
});

// ── priceForecast: staleness + slot lookup ────────────────────────────────────
test('_priceForecastStale — fresh / old / never-ingested', () => {
  const now = Date.now();
  assert.strictEqual(makeDevice({ _priceForecast: [{}], _priceForecastUpdatedAt: now })._priceForecastStale(now), false);
  assert.strictEqual(makeDevice({ _priceForecast: [{}], _priceForecastUpdatedAt: now - 31 * 3600_000 })._priceForecastStale(now), true);
  assert.strictEqual(makeDevice({ _priceForecast: null, _priceForecastUpdatedAt: now })._priceForecastStale(now), true);
});

// ── priceForecast: _checkPriceForecastStaleness (proactive notification) ─────
test('_checkPriceForecastStaleness — never configured → no notification', () => {
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: null, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(Date.now());
  assert.strictEqual(calls, 0);
});
test('_checkPriceForecastStaleness — fresh (under the notify threshold) → no notification', () => {
  const now = Date.now();
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: now - 3600_000, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(now);
  assert.strictEqual(calls, 0);
});
test('_checkPriceForecastStaleness — stale past the notify threshold → notifies exactly once', () => {
  const now = Date.now();
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: now - 49 * 3600_000, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(now);
  d._checkPriceForecastStaleness(now + 60_000); // still stale, called again — must not re-notify
  assert.strictEqual(calls, 1);
  assert.strictEqual(d._priceForecastStaleNotified, true);
});
test('_checkPriceForecastStaleness — re-arms once fresh again', () => {
  const now = Date.now();
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: now - 49 * 3600_000, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(now); // notifies once
  d._priceForecastUpdatedAt = now; // fresh data arrives
  d._checkPriceForecastStaleness(now);
  assert.strictEqual(d._priceForecastStaleNotified, false);
  d._priceForecastUpdatedAt = now - 49 * 3600_000; // goes stale again later
  d._checkPriceForecastStaleness(now);
  assert.strictEqual(calls, 2); // notified again on the second episode
});

test('_priceSlotsBetween — overlap filter, ascending', () => {
  const slots = [
    { start: 1000, end: 2000, price: 1 },
    { start: 2000, end: 3000, price: 2 },
    { start: 3000, end: 4000, price: 3 },
  ];
  const d = makeDevice({ _priceForecast: slots });
  assert.deepStrictEqual(d._priceSlotsBetween(1500, 3500).map((s) => s.price), [1, 2, 3]);
  assert.deepStrictEqual(d._priceSlotsBetween(2000, 3000).map((s) => s.price), [2]);
});

// ── priceForecast: _priceSelectCheapestSlots (the core planning algorithm) ────
test('_priceSelectCheapestSlots — picks cheapest slots first', () => {
  const d = makeDevice();
  const slots = [
    { start: 0, end: 3600_000, price: 0.30 },
    { start: 3600_000, end: 7200_000, price: 0.10 }, // cheapest
    { start: 7200_000, end: 10800_000, price: 0.20 },
  ];
  const sel = d._priceSelectCheapestSlots(slots, 1, 0);
  assert.deepStrictEqual([...sel], [3600_000]);
});

test('_priceSelectCheapestSlots — tie-break prefers the LATER slot', () => {
  const d = makeDevice();
  const slots = [
    { start: 0, end: 3600_000, price: 0.10 },
    { start: 3600_000, end: 7200_000, price: 0.10 }, // same price, later → preferred
  ];
  const sel = d._priceSelectCheapestSlots(slots, 1, 0);
  assert.deepStrictEqual([...sel], [3600_000]);
});

test('_priceSelectCheapestSlots — precondition block always included from the end', () => {
  const d = makeDevice();
  const slots = [
    { start: 0, end: 3600_000, price: 0.05 },        // cheapest, but not needed once precondition covers it
    { start: 3600_000, end: 7200_000, price: 0.50 }, // expensive, but last slot → forced by precondition
  ];
  const sel = d._priceSelectCheapestSlots(slots, 1, 1); // 1h needed, 1h precondition
  assert.deepStrictEqual([...sel], [3600_000]);
});

test('_priceSelectCheapestSlots — needing more than available selects everything', () => {
  const d = makeDevice();
  const slots = [{ start: 0, end: 3600_000, price: 0.10 }, { start: 3600_000, end: 7200_000, price: 0.20 }];
  const sel = d._priceSelectCheapestSlots(slots, 10, 0);
  assert.strictEqual(sel.size, 2);
});

test('_priceSlotSelectedNow — membership check', () => {
  const d = makeDevice();
  const slots = [{ start: 0, end: 3600_000, price: 0.1 }, { start: 3600_000, end: 7200_000, price: 0.2 }];
  const sel = new Set([3600_000]);
  assert.strictEqual(d._priceSlotSelectedNow(sel, slots, 5000), false);
  assert.strictEqual(d._priceSlotSelectedNow(sel, slots, 3600_001), true);
});

// ── priceForecast: _priceShouldChargeNow (the D10 decision) ──────────────────
test('_priceShouldChargeNow — no deadline/capacity configured → never', () => {
  const d = makeDevice();
  assert.strictEqual(d._priceShouldChargeNow(null, 7000, {}, Date.now()).shouldCharge, false);
  assert.strictEqual(d._priceShouldChargeNow({ soc: 40, target: 80 }, 7000, {}, Date.now()).shouldCharge, false);
});

test('_priceShouldChargeNow — target already reached → never', () => {
  const d = makeDevice();
  const car = { soc: 90, target: 80, capacityKwh: 20, readyBy: '07:00' };
  assert.strictEqual(d._priceShouldChargeNow(car, 7000, {}, Date.now()).shouldCharge, false);
});

test('_priceShouldChargeNow — solar forecast alone covers the need → never (yet)', () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0); // 20:00 UTC, deadline 07:00 tomorrow → 11h window
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [{ end: now + 3600_000, kw: 20, h: 1 }], // 20 kWh forecast, way more than needed
  });
  const car = { soc: 40, target: 80, capacityKwh: 20, readyBy: '07:00' }; // needs 8 kWh
  const d1 = d._priceShouldChargeNow(car, 7000, {}, now);
  assert.strictEqual(d1.shouldCharge, false);
  assert.strictEqual(d1.reason, 'solar forecast covers the remaining need');
});

test('_priceShouldChargeNow — no price data → fail-safe continuous charging', () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _pvForecast: null });
  const car = { soc: 40, target: 80, capacityKwh: 20, readyBy: '07:00' };
  const decision = d._priceShouldChargeNow(car, 7000, {}, now);
  assert.strictEqual(decision.shouldCharge, true);
  assert.match(decision.reason, /no price forecast/);
});

test('_priceShouldChargeNow — charges only in the selected cheap slot', () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0); // 20:00 UTC, deadline 22:00 → 2h window
  const slots = [
    { start: now, end: now + 3600_000, price: 0.30 },              // 20-21h: expensive
    { start: now + 3600_000, end: now + 7200_000, price: 0.10 },   // 21-22h: cheap
  ];
  const car = { soc: 60, target: 80, capacityKwh: 20, readyBy: '22:00' }; // needs 4 kWh
  const base = { homey: { clock: { getTimezone: () => 'UTC' } }, _pvForecast: null, _priceForecast: slots, _priceForecastUpdatedAt: now };
  // 20:00 (expensive slot) → not yet
  const d1 = makeDevice({ ...base });
  const dec1 = d1._priceShouldChargeNow(car, 4000, {}, now); // 4kW charger → needs 1h
  assert.strictEqual(dec1.shouldCharge, false);
  // 21:00 (cheap slot) → charges
  const d2 = makeDevice({ ...base });
  const dec2 = d2._priceShouldChargeNow(car, 4000, {}, now + 3600_000);
  assert.strictEqual(dec2.shouldCharge, true);
  // chargeSlots exposes the full plan (for the settings-page "next charge window"
  // preview) regardless of which tick asked — both decisions should report the same
  // single selected slot (21-22h, the cheap one).
  assert.strictEqual(dec1.chargeSlots.length, 1);
  assert.strictEqual(dec1.chargeSlots[0].start, now + 3600_000);
  assert.strictEqual(dec2.chargeSlots.length, 1);
  assert.strictEqual(dec2.chargeSlots[0].start, now + 3600_000);
});
test('_priceShouldChargeNow — chargeSlots is always an array, even on early-exit paths', () => {
  const d = makeDevice();
  assert.deepStrictEqual(d._priceShouldChargeNow(null, 4000, {}).chargeSlots, []);
  assert.deepStrictEqual(d._priceShouldChargeNow({ soc: 80, target: 80, capacityKwh: 20, readyBy: '22:00' }, 4000, {}).chargeSlots, []);
});

// ── priceForecast: _priceSelectExpensiveSlots (home-battery discharge reserve) ─
test('_priceSelectExpensiveSlots — picks the most expensive slots first', () => {
  const d = makeDevice();
  const slots = [
    { start: 0,       end: 3600_000,   price: 0.10 },
    { start: 3600_000, end: 7200_000,  price: 0.30 },
    { start: 7200_000, end: 10800_000, price: 0.20 },
  ];
  const selected = d._priceSelectExpensiveSlots(slots, 1);
  assert.deepStrictEqual([...selected], [3600_000]);
});
test('_priceSelectExpensiveSlots — tie-break prefers the EARLIER slot', () => {
  const d = makeDevice();
  const slots = [
    { start: 0,       end: 3600_000,  price: 0.20 },
    { start: 3600_000, end: 7200_000, price: 0.20 },
  ];
  const selected = d._priceSelectExpensiveSlots(slots, 1);
  assert.deepStrictEqual([...selected], [0]);
});

// ── priceForecast: _batteryPriceMode (home-battery price control) ────────────
test('_batteryPriceMode — disabled battery → normal', () => {
  const d = makeDevice();
  const r = d._batteryPriceMode({ price_charge_enabled: false }, 50, {});
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — unknown SoC → normal', () => {
  const d = makeDevice({ _priceForecast: [{}], _priceForecastUpdatedAt: Date.now() });
  const r = d._batteryPriceMode({ price_charge_enabled: true }, null, {});
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — stale forecast → normal', () => {
  const d = makeDevice({ _priceForecast: null, _priceForecastUpdatedAt: null });
  const r = d._batteryPriceMode({ price_charge_enabled: true }, 50, {});
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — charges in the cheapest slot within the 24h rolling lookahead (no deadline)', () => {
  const now = Date.UTC(2026, 0, 1, 4, 0, 0); // 04:00 UTC
  const slots = [
    { start: now, end: now + 3600_000, price: 0.30 },              // 04-05h: expensive
    { start: now + 3600_000, end: now + 7200_000, price: 0.05 },   // 05-06h: cheap
  ];
  const base = { homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now };
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5, capacity_kwh: 10 }; // needs 1h at 5kW for 50%
  const d1 = makeDevice({ ...base });
  assert.strictEqual(d1._batteryPriceMode(bd, 40, {}, now).mode !== 'charge', true); // expensive slot, not yet
  const d2 = makeDevice({ ...base });
  assert.strictEqual(d2._batteryPriceMode(bd, 40, {}, now + 3600_000).mode, 'charge'); // cheap slot
});
test('_batteryPriceMode — waits for a genuinely cheaper hour later within the lookahead instead of committing early', () => {
  const now = Date.UTC(2026, 0, 1, 4, 0, 0);
  const slots = [
    { start: now,                end: now + 3600_000,  price: 0.20 }, // 04-05h: moderate
    { start: now + 20 * 3600_000, end: now + 21 * 3600_000, price: 0.02 }, // 00:00 next day: much cheaper, still within 24h
  ];
  const base = { homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now };
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5, capacity_kwh: 10, price_discharge_reserve_hours: 0 }; // needs 1h; reserve isolated off
  const d = makeDevice({ ...base });
  const r = d._batteryPriceMode(bd, 40, {}, now);
  assert.notStrictEqual(r.mode, 'charge'); // not the cheapest — waits
  assert.strictEqual(r.chargeSlots.length, 1);
  assert.strictEqual(r.chargeSlots[0].start, now + 20 * 3600_000); // planned for the later, cheaper slot
});
test('_batteryPriceMode — returns the full reserveSlots list even when currently in a non-reserved hour', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,               end: now + 3600_000,  price: 0.10 },
    { start: now + 3600_000,    end: now + 7200_000,  price: 0.30 }, // the peak, reserved
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 1 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now);
  assert.strictEqual(r.mode, 'hold');
  assert.strictEqual(r.reserveSlots.length, 1);
  assert.strictEqual(r.reserveSlots[0].start, now + 3600_000);
});
test('_batteryPriceMode — already at/above target → no charge', () => {
  const now = Date.now();
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_by: '06:00', price_charge_power_kw: 5, capacity_kwh: 10 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: [{ start: now, end: now + 3600_000, price: 0.01 }], _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 95, {}, now);
  assert.notStrictEqual(r.mode, 'charge');
});
test('_batteryPriceMode — holds discharge outside the reserved top-expensive hours', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,               end: now + 3600_000,  price: 0.10 }, // now: mid price
    { start: now + 3600_000,    end: now + 7200_000,  price: 0.30 }, // later: the peak
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 1 }; // target 0 → never charges, isolates the reserve check
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now);
  assert.strictEqual(r.mode, 'hold');
});
test('_batteryPriceMode — allows discharge during the reserved top-expensive hour', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,               end: now + 3600_000,  price: 0.10 },
    { start: now + 3600_000,    end: now + 7200_000,  price: 0.30 }, // the peak
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 1 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now + 3600_000); // now = the peak slot
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — reserve disabled (0 hours) and target met → normal (nothing to do)', () => {
  const now = Date.now();
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 0 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: [{ start: now, end: now + 3600_000, price: 0.10 }], _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now);
  assert.strictEqual(r.mode, 'normal');
});

// ── chargerControl: global offpeak_enabled toggle must not hijack explicit price modes ──
test('_evaluateEvChargers — global offpeak_enabled toggle does not override solar_price chargeMode', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
    getCapabilityValue: (cap) => (cap === 'offpeak_enabled' ? true : undefined), // global toggle ON
    _offpeakWindow: () => ({ active: true, amps: 10 }), // off-peak window also active
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true };
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  // Must follow the price-mode decision (16A, price_ev), NOT the fixed off-peak amps (10A).
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16);
  assert.strictEqual(d._lastMode.mode, 'price_ev');
});

// ── chargerControl: shared grid-import budget (price_charge_max_grid_kw) ─────
test('_evaluateEvChargers — solar_price charger skips grid-charging when the shared budget is already spent', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
    _priceChargeCommittedW: 5000, // battery already claimed the entire 5 kW budget
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true, price_charge_max_grid_kw: 5 };
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // no budget left — did not grid-charge
  assert.notStrictEqual(d._lastMode.mode, 'price_ev');
});
test('_evaluateEvChargers — with two solar_price chargers, only as many as fit the shared budget grid-charge', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  // Each wants 16A × 1ph × 230V = 3680 W; a 5 kW budget fits one but not both.
  const c1 = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const c2 = { id: 'c2', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car2', powerW: 0 };
  const car1 = { id: 'car1', name: 'EV1', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const car2 = { id: 'car2', name: 'EV2', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car1, car2],
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true, price_charge_max_grid_kw: 5 };
  await d._evaluateEvChargers(battery, 0, [c1, c2], cfg, null, null);
  const chargedCount = [d._getChargerState('c1').currentAmps, d._getChargerState('c2').currentAmps].filter((a) => a === 16).length;
  assert.strictEqual(chargedCount, 1); // exactly one fit the shared budget
});
test('_evaluateEvChargers — price_charge_max_grid_kw unset (0) → unlimited, no budget tracking needed', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
    _priceChargeCommittedW: 999999, // would exceed any real cap, but the feature is off
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true }; // price_charge_max_grid_kw unset
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16); // unaffected — no cap configured
});

// ── chargerControl: whole-house grid-import ceiling (grid_import_limit_kw) ───
// Distinct from price_charge_max_grid_kw: this is a hard main-fuse safety limit that
// applies to EVERY unconditional-draw tier (Instant/Always/Off-peak here; Price/Low-
// tariff too), gracefully reducing to the highest amp-ladder rung that fits rather than
// rejecting outright. this._gridImportCommittedW is normally seeded per-tick in
// device.js from measured gridW — tests set it directly to simulate that.
test('_evaluateEvChargers — Instant charging (P0) gracefully reduces amps to fit the grid-import ceiling', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _gridImportCommittedW: 0,
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { grid_import_limit_kw: 2 }; // 2000 W headroom → 8 A @ 1ph/230V (8×230=1840 ≤ 2000, 9×230=2070 > 2000)
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 8);
  assert.strictEqual(d._lastMode.mode, 'instant_ev');
});
test('_evaluateEvChargers — Instant charging (P0) stops the charger entirely when even the minimum amp does not fit', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _gridImportCommittedW: 900, // only 100 W headroom left of a 1 kW ceiling — below 6A's 1380 W minimum
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { grid_import_limit_kw: 1 };
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 }); // pretend it was already running
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // stopped — no headroom at all
});
test('_evaluateEvChargers — "Always charge" (P0.5) gracefully reduces amps to fit the grid-import ceiling', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false, chargeMode: 'always' };
  const d = makeChargerDevice({ _gridImportCommittedW: 0 });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { grid_import_limit_kw: 2 };
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 8);
});
test('_evaluateEvChargers — Off-peak (P3) gracefully reduces amps to fit the grid-import ceiling', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false, chargeMode: 'solar_offpeak' };
  const d = makeChargerDevice({
    _offpeakWindow: () => ({ active: true, amps: 16 }),
    _gridImportCommittedW: 0,
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true, grid_import_limit_kw: 2 };
  await d._evaluateEvChargers(battery, 500, [charger], cfg, null, null); // importing → solar can't claim
  assert.strictEqual(d._getChargerState('c1').currentAmps, 8); // reduced from the 16A off-peak amps
  assert.strictEqual(d._lastMode.mode, 'offpeak_ev');
});
test('_evaluateEvChargers — Price-optimised charging (P3b) skips grid-charging when the import ceiling has no headroom, even though the price budget fits', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
    _gridImportCommittedW: 2000, // already at the ceiling — no headroom for the price budget's charger
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true, grid_import_limit_kw: 2 }; // price_charge_max_grid_kw unset — price budget alone would allow this
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // denied by the import ceiling, not the price budget
  assert.notStrictEqual(d._lastMode.mode, 'price_ev');
});
test('_evaluateEvChargers — grid_import_limit_kw unset (0) → unlimited, ceiling has no effect', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _gridImportCommittedW: 999999, // would exceed any real cap, but the feature is off
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = {}; // grid_import_limit_kw unset
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 32); // unaffected — no ceiling configured
});

// ── simpleDevices: whole-house grid-import ceiling (grid_import_limit_kw) ────
test('_evaluateSimpleDevices — a new start is denied when the grid-import ceiling has no headroom', async () => {
  const now = Date.now();
  const d = makeSimpleDevice({ _gridImportCommittedW: 1900 }); // already close to the 2 kW ceiling
  const cfg = { min_battery_soc: 80, grid_import_limit_kw: 2 }; // 100 W headroom left, device wants 1000 W
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  // Surplus/timer logic alone would start it (same fixture as "start needs sustained surplus")
  // — the ceiling denies it anyway.
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});
test('_evaluateSimpleDevices — an already-running device is left alone even with zero headroom (no short-cycling)', async () => {
  const now = Date.now();
  const d = makeSimpleDevice({ _gridImportCommittedW: 999999 }); // way past any ceiling
  const cfg = { min_battery_soc: 80, grid_import_limit_kw: 2 };
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [simpleDev()],
    new Map([['d1', { isOn: true, startedAt: now - 60_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]); // held on by min-run — ceiling only gates NEW starts
});
test('_evaluateSimpleDevices — grid_import_limit_kw unset (0) → unlimited, ceiling has no effect', async () => {
  const now = Date.now();
  const d = makeSimpleDevice({ _gridImportCommittedW: 999999 }); // would exceed any real cap, but the feature is off
  const cfg = { min_battery_soc: 80 }; // grid_import_limit_kw unset
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', 'ctrl', cfg);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]); // unaffected — no ceiling configured
});

// ── chargerControl integration: 'solar_price' charge mode (D10) ──────────────
test('_evaluateEvChargers — solar_price charger charges in the cheap slot, sets PRICE_EV mode', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true };
  const allocated = await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null); // gridW=0 → not exporting → solarCanClaim=false
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16); // charges at max
  assert.ok(allocated > 0);
  assert.strictEqual(d._lastMode.mode, 'price_ev');
});

test('_evaluateEvChargers — solar_price charger waits when solar is claiming the surplus', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' } },
    _warmupDone: false, // avoid the solar-allocation loop actually issuing amp commands past P3b
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true };
  // Strong export (-5000 W) ≥ minClaimW → solar claims it, P3b does not force-charge.
  await d._evaluateEvChargers(battery, -5000, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // not forced on by price logic
});

// ── chargeSessions: _trackChargeSession / _finalizeChargeSession ─────────────
test('_trackChargeSession — accumulates energy over ticks and finalizes on disconnect', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, powerW: 7360 }; // 7.36 kW (32A x 1ph x 230V)
  const dtMs = 15_000; // one 15 s tick

  // 4 ticks at 7.36 kW for 15 s each → 4 * 7.36 * (15/3600) kWh
  for (let i = 0; i < 4; i++) d._trackChargeSession(charger, cfg, dtMs);
  assert.strictEqual(d._chargeSessions.length, 0); // still connected — no session finalized yet

  const disconnected = { id: 'c1', connected: false, powerW: 0 };
  d._trackChargeSession(disconnected, cfg, dtMs);

  assert.strictEqual(d._chargeSessions.length, 1);
  const s = d._chargeSessions[0];
  const expectedKwh = Math.round(4 * 7.36 * (15 / 3600) * 100) / 100;
  assert.strictEqual(s.energyKwh, expectedKwh);
  assert.strictEqual(s.currency, 'CHF');
  assert.strictEqual(s.avgPrice, 0.30); // fixed price the whole session
  assert.strictEqual(Math.round(s.cost * 100) / 100, Math.round(expectedKwh * 0.30 * 100) / 100);
});
test('_trackChargeSession — negligible-energy sessions are not logged', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30 } };
  // One tick at low power — well under the 0.05 kWh logging floor.
  d._trackChargeSession({ id: 'c1', connected: true, powerW: 100 }, cfg, 15_000);
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0 }, cfg, 15_000);
  assert.strictEqual(d._chargeSessions.length, 0);
});
test('_trackChargeSession — pauses within one plug-in period stay a single session', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30 } };
  const on  = { id: 'c1', connected: true, powerW: 7360 };
  const off = { id: 'c1', connected: true, powerW: 0 }; // still plugged in, just not drawing (e.g. no surplus)
  for (let i = 0; i < 10; i++) d._trackChargeSession(on, cfg, 15_000);
  for (let i = 0; i < 10; i++) d._trackChargeSession(off, cfg, 15_000); // paused — still connected
  for (let i = 0; i < 10; i++) d._trackChargeSession(on, cfg, 15_000); // resumes
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0 }, cfg, 15_000); // unplugged
  assert.strictEqual(d._chargeSessions.length, 1); // one session, not three
  assert.ok(d._chargeSessions[0].energyKwh > 0);
});
test('_trackChargeSession — carName resolved via _carForCharger when known', () => {
  const car = { id: 'car1', name: 'Tesla', soc: 40, target: 80 };
  const d = makeChargerDevice({ _chargeSessions: [], _carStates: [car] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30 } };
  const charger = { id: 'c1', connected: true, powerW: 7360, carId: 'car1' };
  for (let i = 0; i < 5; i++) d._trackChargeSession(charger, cfg, 15_000);
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0, carId: 'car1' }, cfg, 15_000);
  assert.strictEqual(d._chargeSessions[0].carName, 'Tesla');
});
test('_trackChargeSession — no price configured (mode variable, unset) → energy logged, cost null', () => {
  const d = makeChargerDevice({ _chargeSessions: [], _variablePrice: null });
  const cfg = { price_config: { mode: 'variable' } }; // no value ever pushed → _getCurrentPrice returns null
  const charger = { id: 'c1', connected: true, powerW: 7360 };
  for (let i = 0; i < 5; i++) d._trackChargeSession(charger, cfg, 15_000);
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0 }, cfg, 15_000);
  assert.strictEqual(d._chargeSessions.length, 1);
  assert.ok(d._chargeSessions[0].energyKwh > 0);
  assert.strictEqual(d._chargeSessions[0].cost, null);
  assert.strictEqual(d._chargeSessions[0].avgPrice, null);
});

test('getEmsChargeSessions — returns newest first, capped, as shallow clones', () => {
  const d = makeChargerDevice({
    _chargeSessions: [
      { chargerId: 'c1', startedAt: 1, endedAt: 2, energyKwh: 1 },
      { chargerId: 'c1', startedAt: 3, endedAt: 4, energyKwh: 2 },
    ],
  });
  const out = d.getEmsChargeSessions();
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].energyKwh, 2); // newest first
  out[0].energyKwh = 999;
  assert.strictEqual(d._chargeSessions[1].energyKwh, 2); // clone, not a live reference
});

// ── widget: lib/ems/widget.js (ems-device / ems-battery widget backend) ─────
function makeWidgetDevice(extra = {}) {
  const dev = {
    log() {}, error() {},
    _chargerStates:      new Map(),
    _heatPumpStates:     new Map(),
    _boilerStates:       new Map(),
    _poolStates:         new Map(),
    _dehumidifierStates: new Map(),
    _batteryStates:      new Map(),
    _carStates: [],
    homey: { clock: { getTimezone: () => 'Europe/Zurich' }, settings: { set() {} } },
    _cap: async () => null,
    _stopTick() {}, _startTick() {},
    _validateConfig() { return false; },
    _getConfig() { return {}; },
  };
  Object.assign(dev, widgetMixin, chargerMixin, simpleDevicesMixin, batteryMixin, carsMixin, extra);
  return dev;
}

test('_trackSimpleDeviceDaily — accumulates kWh and runtime only while isOn', () => {
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily([{ id: 'd1', powerW: 2000 }], new Map([['d1', { isOn: true }]]), 3600_000);
  assert.deepStrictEqual(d._simpleDeviceDaily('d1'), { kwh: 2, runtimeMs: 3600_000 });
});
test('_trackSimpleDeviceDaily — an off device accumulates nothing', () => {
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily([{ id: 'd1', powerW: 2000 }], new Map([['d1', { isOn: false }]]), 3600_000);
  assert.deepStrictEqual(d._simpleDeviceDaily('d1'), { kwh: 0, runtimeMs: 0 });
});
test('_simpleDeviceDaily — resets once the stored date no longer matches today', () => {
  const d = makeWidgetDevice();
  d._simpleDailyStats = { d1: { date: '2000-01-01', kwh: 5, runtimeMs: 999 } };
  assert.deepStrictEqual(d._simpleDeviceDaily('d1'), { kwh: 0, runtimeMs: 0 });
});

test('getEmsControllableDevices — lists chargers and simple devices, resolving names via the API', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({ chargers: [{ id: 'c1' }], heat_pump_devices: [{ id: 'h1' }] }),
    _api: { getDevices: async () => ({ c1: { id: 'c1', name: 'Carport' }, h1: { id: 'h1', name: 'Heat pump' } }) },
  });
  assert.deepStrictEqual(await d.getEmsControllableDevices(), [
    { id: 'c1', kind: 'charger', name: 'Carport' },
    { id: 'h1', kind: 'heat_pump', name: 'Heat pump' },
  ]);
});
test('getEmsControllableDevices — falls back to a truncated id when the local API is unavailable', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({ chargers: [{ id: 'c1234567890' }] }),
    _api: { getDevices: async () => { throw new Error('no api key'); } },
  });
  const list = await d.getEmsControllableDevices();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'c1234567…');
});

test('_findControllable — finds charger and simple-device entries, null for an unknown id', () => {
  const d = makeWidgetDevice();
  const cfg = { chargers: [{ id: 'c1' }], boiler_devices: [{ id: 'b1' }] };
  assert.deepStrictEqual(d._findControllable(cfg, 'c1'), { kind: 'charger', entry: cfg.chargers[0] });
  assert.deepStrictEqual(d._findControllable(cfg, 'b1'), { kind: 'boiler', entry: cfg.boiler_devices[0] });
  assert.strictEqual(d._findControllable(cfg, 'nope'), null);
});

test('getEmsControllableStatus — charger kind reports live power, mode and an active session', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar_price', max_amps: 16, min_amps: 6, ev_phases: '1' }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    // _getChargers lives directly on the EmsDevice class (device.js), not in a
    // mixin — stub it here the same way _getBattery is stubbed below.
    _getChargers: async ({ chargers }) => chargers.map((c) => ({
      id: c.id, connected: true, powerW: 3000, chargeMode: c.charge_mode,
    })),
    _api: { getDevice: async () => ({ name: 'Carport' }) },
  });
  const st = d._getChargerState('c1');
  st.sessionActive = true; st.sessionStartedAt = Date.now() - 60_000; st.sessionEnergyKwh = 1.234;
  const status = await d.getEmsControllableStatus('c1');
  assert.strictEqual(status.kind, 'charger');
  assert.strictEqual(status.name, 'Carport');
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.chargeMode, 'solar_price');
  assert.strictEqual(status.sessionEnergyKwh, 1.23);
  assert.strictEqual(status.carName, null);
});
test('getEmsControllableStatus — unknown id → not_found', async () => {
  const d = makeWidgetDevice({ _getConfig: () => ({ chargers: [] }) });
  assert.strictEqual((await d.getEmsControllableStatus('nope')).error, 'not_found');
});
test('getEmsControllableStatus — simple-device kind reports on/off, power and today\'s stats', async () => {
  const cfg = { boiler_devices: [{ id: 'b1', min_surplus_w: 1800, cap_power: 'measure_power' }] };
  const d = makeWidgetDevice({ _getConfig: () => cfg, _cap: async () => 1200 });
  d._boilerStates.set('b1', { isOn: true, startedAt: Date.now() - 120_000 });
  d._simpleDailyStats = { b1: { date: d._localDateStr(), kwh: 3.4, runtimeMs: 7_200_000 } };
  const status = await d.getEmsControllableStatus('b1');
  assert.strictEqual(status.kind, 'boiler');
  assert.strictEqual(status.isOn, true);
  assert.strictEqual(status.powerW, 1200);
  assert.strictEqual(status.minSurplusW, 1800);
  assert.strictEqual(status.todayKwh, 3.4);
  assert.strictEqual(status.todayRuntimeMs, 7_200_000);
  assert.ok(status.runtimeMs >= 120_000);
});

test('setEmsChargerMode — rejects an invalid mode without touching config', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar' }] };
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  const res = await d.setEmsChargerMode('c1', 'bogus');
  assert.strictEqual(res.error, 'invalid_mode');
  assert.strictEqual(saved, null);
  assert.strictEqual(cfg.chargers[0].charge_mode, 'solar');
});
test('setEmsChargerMode — patches the mode, persists, and restarts the tick', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar' }] };
  let saved = null, restarted = false;
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    homey: { settings: { set: (k, v) => { saved = v; } } },
    _startTick() { restarted = true; },
  });
  const res = await d.setEmsChargerMode('c1', 'always');
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.chargers[0].charge_mode, 'always');
  assert.strictEqual(saved, cfg);
  assert.strictEqual(restarted, true);
});
test('setEmsChargerMode — unknown charger id → not_found', async () => {
  const d = makeWidgetDevice({ _getConfig: () => ({ chargers: [] }) });
  assert.strictEqual((await d.setEmsChargerMode('nope', 'solar')).error, 'not_found');
});

test('setEmsSimpleDeviceMinSurplus — patches min_surplus_w on the matching simple device', async () => {
  const cfg = { boiler_devices: [{ id: 'b1', min_surplus_w: 1500 }] };
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  const res = await d.setEmsSimpleDeviceMinSurplus('b1', 2200);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.boiler_devices[0].min_surplus_w, 2200);
  assert.strictEqual(saved, cfg);
});
test('setEmsSimpleDeviceMinSurplus — a charger id is rejected (chargers have no min_surplus_w)', async () => {
  const d = makeWidgetDevice({ _getConfig: () => ({ chargers: [{ id: 'c1' }] }) });
  assert.strictEqual((await d.setEmsSimpleDeviceMinSurplus('c1', 2200)).error, 'not_found');
});

test('getEmsBatteryStatus — classifies the orange zone and surfaces the active price mode', async () => {
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 40, battery_devices: [{ id: 'bat1', price_charge_enabled: true }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getBattery: async () => ({ soc: 60, powerW: 500, socPerDevice: { bat1: 60 } }),
  });
  d._batteryStates.set('bat1', { priceMode: 'charge' });
  const status = await d.getEmsBatteryStatus();
  assert.strictEqual(status.hasBattery, true);
  assert.strictEqual(status.soc, 60);
  assert.strictEqual(status.zone, 'orange');
  assert.strictEqual(status.priceEnabled, true);
  assert.strictEqual(status.priceMode, 'charge');
});
test('getEmsBatteryStatus — no battery configured', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({}),
    _getBattery: async () => ({ soc: null, powerW: null, socPerDevice: {} }),
  });
  assert.strictEqual((await d.getEmsBatteryStatus()).hasBattery, false);
});

test('getEmsBatteryStatus — sums capacity_kwh across batteries and derives the current energy in kWh', async () => {
  const cfg = {
    min_battery_soc: 80,
    battery_devices: [{ id: 'bat1', capacity_kwh: 5 }, { id: 'bat2', capacity_kwh: 8.4 }],
  };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getBattery: async () => ({ soc: 65, powerW: 0, socPerDevice: {} }),
  });
  const status = await d.getEmsBatteryStatus();
  assert.strictEqual(status.capacityKwh, 13.4);
  assert.strictEqual(status.energyKwh, 8.7); // 13.4 * 0.65 = 8.71 -> rounds to 8.7
});
test('getEmsBatteryStatus — no capacity configured → capacityKwh/energyKwh stay null', async () => {
  const cfg = { min_battery_soc: 80, battery_devices: [{ id: 'bat1' }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getBattery: async () => ({ soc: 65, powerW: 0, socPerDevice: {} }),
  });
  const status = await d.getEmsBatteryStatus();
  assert.strictEqual(status.capacityKwh, null);
  assert.strictEqual(status.energyKwh, null);
});

test('setEmsBatteryZones — clamps values to 0..100 and persists', async () => {
  const cfg = {};
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  const res = await d.setEmsBatteryZones({ normalSoc: 150, reserveSoc: -10 });
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.min_battery_soc, 100);
  assert.strictEqual(cfg.min_battery_soc_low, 0);
  assert.strictEqual(saved, cfg);
});
