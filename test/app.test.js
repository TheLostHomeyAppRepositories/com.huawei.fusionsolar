'use strict';

// Unit tests for the app-level sensor-chart capability history.
// Run: node --test
//
// _pruneOrphanCapHistory DELETES persisted user data, so its guard rails (never prune
// on an incomplete device walk, never prune on an empty device list) are covered here
// deliberately — a regression would silently destroy recorded history.
//
// app.js requires the `homey` runtime module, which only exists on-device; stub it (and
// the two native-ish deps pulled in by lib/) before loading the app class.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
  if (request === 'jsmodbus' || request === 'ws') return {};
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const App    = require('../app.js');

// Minimal fake device: one recorded capability (measure_power) and one that must be
// ignored (onoff is not numeric / not "meaningful").
function fakeDevice(id) {
  return {
    getData: () => ({ id }),
    getCapabilities: () => ['measure_power', 'onoff'],
    getCapabilityValue: () => 1234.567,
  };
}

function makeApp({ devices = [], throwOnDriver = false, stored = {} } = {}) {
  const settings = { ...stored };
  const app = Object.create(App.prototype);
  app._capHistory = new Map();
  app.log = () => {};
  app.error = () => {};
  app.homey = {
    settings: {
      get:     (k) => settings[k],
      set:     (k, v) => { settings[k] = v; },
      unset:   (k) => { delete settings[k]; },
      getKeys: () => Object.keys(settings),
    },
    drivers: {
      getDrivers: () => ({
        d1: { getDevices: () => { if (throwOnDriver) throw new Error('driver not ready'); return devices; } },
      }),
    },
  };
  return { app, settings };
}

// ── orphan cleanup ───────────────────────────────────────────────────────────
test('_loadCapHistory — removes persisted series whose device is no longer paired', () => {
  const { app, settings } = makeApp({
    devices: [fakeDevice('alive')],
    stored: {
      'sch_hist_alive::measure_power':   [[1000, 1], [2000, 2]],
      'sch_hist_removed::measure_power': [[1000, 9]],
      'sch_hist_gone::measure_power':    [[1000, 9]],
      ems_config: { keep: true },
    },
  });
  app._loadCapHistory();
  assert.ok(!('sch_hist_removed::measure_power' in settings));
  assert.ok(!('sch_hist_gone::measure_power' in settings));
  assert.ok('sch_hist_alive::measure_power' in settings);       // still paired → kept
  assert.deepStrictEqual(settings.ems_config, { keep: true });   // unrelated keys untouched
  assert.strictEqual(app._capHistory.get('alive::measure_power').length, 2);
});

test('_loadCapHistory — never prunes when a driver lookup threw (device list incomplete)', () => {
  // A driver that fails to enumerate would make every one of its devices look orphaned.
  const { app, settings } = makeApp({
    devices: [fakeDevice('alive')], throwOnDriver: true,
    stored: { 'sch_hist_alive::measure_power': [[1000, 1]] },
  });
  app._loadCapHistory();
  assert.ok('sch_hist_alive::measure_power' in settings);
});

test('_loadCapHistory — never prunes when no devices are paired at all', () => {
  // Far more likely a startup-timing artefact than the user removing every device.
  const { app, settings } = makeApp({
    devices: [],
    stored: { 'sch_hist_alive::measure_power': [[1000, 1]] },
  });
  app._loadCapHistory();
  assert.ok('sch_hist_alive::measure_power' in settings);
});

// ── numeric timestamps (memory: ~55% smaller than the old ISO strings) ───────
test('_snapshotAllCaps — stores epoch ms, not an ISO string, and skips non-numeric caps', () => {
  const { app } = makeApp({ devices: [fakeDevice('alive')] });
  app._snapshotAllCaps();
  assert.strictEqual(app._capHistory.size, 1); // 'onoff' ignored
  const pt = app._capHistory.get('alive::measure_power')[0];
  assert.strictEqual(typeof pt.t, 'number');
});

test('capability history survives a save/load round-trip with numeric timestamps', () => {
  const { app, settings } = makeApp({ devices: [fakeDevice('alive')] });
  app._snapshotAllCaps();
  const original = app._capHistory.get('alive::measure_power')[0];
  app._saveCapHistory();

  const persisted = settings['sch_hist_alive::measure_power'];
  assert.ok(Array.isArray(persisted[0]));            // compact [ms, value] pairs
  assert.strictEqual(typeof persisted[0][0], 'number');

  const { app: app2 } = makeApp({ devices: [fakeDevice('alive')], stored: settings });
  app2._loadCapHistory();
  const restored = app2._capHistory.get('alive::measure_power')[0];
  assert.strictEqual(typeof restored.t, 'number');
  assert.strictEqual(restored.t, original.t);
});

test('getSensorChartData — filters on the numeric timestamp and stays widget-compatible', () => {
  const { app } = makeApp({ devices: [fakeDevice('alive')] });
  const now = Date.now();
  app._capHistory.set('alive::measure_power', [
    { t: now - 48 * 3600_000, v: 1 }, // outside a 24 h window
    { t: now - 1 * 3600_000,  v: 2 },
  ]);
  const out = app.getSensorChartData({ s1: 'alive::measure_power', hours: 24 });
  assert.strictEqual(out.series[0].points.length, 1);
  assert.strictEqual(out.series[0].points[0].v, 2);
  // The chart renderer does `new Date(p.t).getTime()`, which must still round-trip.
  assert.strictEqual(new Date(out.series[0].points[0].t).getTime(), out.series[0].points[0].t);
});

test('_saveCapHistory — rounds values but leaves the timestamp untouched', () => {
  const { app, settings } = makeApp({ devices: [fakeDevice('alive')] });
  app._capHistory.set('alive::measure_power', [{ t: 1754400000000, v: 1234.5678 }]);
  app._saveCapHistory();
  assert.deepStrictEqual(settings['sch_hist_alive::measure_power'], [[1754400000000, 1234.57]]);
});

// ── Modbus register map: guards against a known cross-device copy-paste ──────
// EMMA and the SmartCharger both use address 30508 for completely different things:
//   SmartCharger address space → CHARGER_TEMPERATURE   (I32, gain 10, °C)
//   EMMA address space         → EXTERNAL_METER_LINE_VOLTAGE_A_B (U32, gain 100, V)
// The EMMA map once carried the charger's temperature definition verbatim, so the
// sun2000_emma_modbus driver reported a ~400 V line voltage as "4000 °C".
// Verified against wlcrs/huawei-solar-lib registers.py.
const REG = require('../lib/modbus-registers.js');

test('EMMA register map does not claim address 30508 (it is a line voltage there, not a temperature)', () => {
  for (const [name, def] of Object.entries(REG.EMMA_REGISTERS)) {
    assert.notStrictEqual(def[0], 30508,
      `EMMA_REGISTERS.${name} points at 30508, which is EXTERNAL_METER_LINE_VOLTAGE_A_B on EMMA`);
  }
});

test('EMMA exposes no inverter temperature at all', () => {
  const names = [...Object.keys(REG.EMMA_REGISTERS), ...Object.keys(REG.SUN2000_EMMA_DATA_REGISTERS)];
  assert.deepStrictEqual(names.filter((n) => /temperature/i.test(n)), []);
});

test('the SmartCharger map keeps 30508 as its temperature (that one is correct)', () => {
  assert.deepStrictEqual(REG.SMARTCHARGER_REGISTERS.chargerTemperature.slice(0, 3), [30508, 2, 'INT32']);
});

// ── ems_set_car_target matching ──────────────────────────────────────────────
// This card is shared by several flows at once (the generated "Set charge 80/90/100%"
// ones differ only in target_pct), so unlike every other EMS trigger it needs a matcher.
// It was registered twice — once here in the app, once in the EMS device — which Homey
// reported on every start as "Run listener was already registered". The two disagreed
// about a blank filter, so which one won decided whether a hand-built flow fired.
const CAR = 'car-uuid-1';

test('matchCarTarget — a per-value flow fires only for its own target', () => {
  const state = { car_device_id: CAR, target_pct: '80' };
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '80' }, state), true);
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '90' }, state), false);
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '100' }, state), false);
});

test('matchCarTarget — a blank filter matches any target, as the argument label promises', () => {
  // app.json: "Target charge (%) filter — leave empty for any". The device's copy compared
  // '' against '80' and returned false, so this flow never ran.
  const state = { car_device_id: CAR, target_pct: '80' };
  for (const blank of ['', '   ', null, undefined]) {
    assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: blank }, state), true,
      `a filter of ${JSON.stringify(blank)} must match any target`);
  }
});

test('matchCarTarget — another car never matches, whatever the filter says', () => {
  const state = { car_device_id: CAR, target_pct: '80' };
  assert.strictEqual(App.matchCarTarget({ car_device_id: 'other-car', target_pct: '80' }, state), false);
  assert.strictEqual(App.matchCarTarget({ car_device_id: 'other-car', target_pct: '' }, state), false);
});

test('matchCarTarget — surrounding whitespace in a pasted filter is tolerated', () => {
  // The argument is a text field the user types into, and the ids get pasted from the
  // settings page, so a stray space must not silently stop a flow from firing.
  const state = { car_device_id: CAR, target_pct: '80' };
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: ' 80 ' }, state), true);
});

test('matchCarTarget — a number in either place still matches its string form', () => {
  // The state is built with String(), but nothing stops a caller passing a number.
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: 80 }, { car_device_id: CAR, target_pct: '80' }), true);
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '80' }, { car_device_id: CAR, target_pct: 80 }), true);
});

test('the run listener is registered in exactly one place', () => {
  const fs = require('fs');
  const inApp = (fs.readFileSync('app.js', 'utf8').match(/getTriggerCard\('ems_set_car_target'\)\s*\.registerRunListener/g) || []).length;
  const inDev = (fs.readFileSync('drivers/energy_management/device.js', 'utf8')
    .match(/getTriggerCard\('ems_set_car_target'\)\s*[\s\S]{0,40}registerRunListener/g) || []).length;
  assert.strictEqual(inApp, 1, 'app.js must register it once');
  assert.strictEqual(inDev, 0, 'the EMS device must not register it again');
});
