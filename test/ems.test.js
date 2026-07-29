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
const simpleDevicesMixin = require('../lib/ems/simpleDevices');
const exportLimitMixin = require('../lib/ems/exportLimit');
const { MIN_3PH_W, STEP_HOLD_MS, EXPORT_GUARD_W, MIN_CHARGE_W, EXPORT_LIMIT_HOLD_MS } = require('../lib/ems/constants');

function makeDevice(extra = {}) {
  const dev = {
    homey: { clock: { getTimezone: () => 'Europe/Zurich' } },
    log() {}, error() {},
    _variablePrice: null,
    _carStates: [],
    _carSocTrack: {},
  };
  Object.assign(dev, priceMixin, carsMixin, chargerMixin, batteryMixin, pvForecastMixin, extra);
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
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) } },
  };
  Object.assign(dev, chargerMixin, extra);
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
  Object.assign(dev, simpleDevicesMixin, batteryMixin, pvForecastMixin, extra);
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
  // adaptive: cap 10, soc 50 → deficit 5, 4 < 5 → block; soc 70 → deficit 3, 4 < 3 → no
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'adaptive', battery_capacity_kwh: 10 }, { soc: 50 }, now), true);
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'adaptive', battery_capacity_kwh: 10 }, { soc: 70 }, now), false);
  // adaptive without capacity → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'adaptive', battery_capacity_kwh: 0 }, { soc: 50 }, now), false);
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
