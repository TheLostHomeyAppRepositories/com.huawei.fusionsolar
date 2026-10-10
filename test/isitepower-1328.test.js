'use strict';

// iSitePower-M, three findings from the review of 2026-10-10 (1.2.328).
//
//   1. The home meter went on adding the last known power whenever no load reading came —
//      through a cloud outage, a refused call or API access withdrawn alike. One reading of 800 W
//      followed by a day without data booked 19.2 kWh that never happened into Homey Energy.
//   2. The grid meter started its own integral at 0 when the first poll had no Mains data, and
//      the first poll with Mains data then wrote the lifetime total: 0 → 4212.5 kWh in one step.
//   3. Without a grid device, the PV and house baselines were never written; and an app start
//      that found only one of them missing rewrote all, the grid ones from a later reading.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, App: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const HomeDevice    = require(path.join('..', 'drivers', 'isitepower_home_openapi_fusionsolar', 'device.js'));
const GridDevice    = require(path.join('..', 'drivers', 'isitepower_grid_openapi_fusionsolar', 'device.js'));
const BatteryDevice = require(path.join('..', 'drivers', 'isitepower_battery_openapi_fusionsolar', 'device.js'));
const SolarDevice   = require(path.join('..', 'drivers', 'isitepower_solar_openapi_fusionsolar', 'device.js'));
const App           = require(path.join('..', 'app.js'));
Module._load = origLoad;

const { integrationHours } = require('../lib/isitepower-utils');

const MIN = 60_000;
const AC_OUTPUT = 60010;
const MAINS     = 60001;

function device(Cls, { caps = {}, store = {} } = {}) {
  const d = Object.create(Cls.prototype);
  d.caps = { ...caps };
  d.store = { ...store };
  d.logs = [];
  d.availabilityCalls = 0;
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.getName = () => 'iSitePower';
  d.getSetting = (k) => ({ poll_interval: 5 }[k]);
  d.hasCapability = () => true;
  d.addCapability = async () => {};
  d.getCapabilityValue = (k) => (k in d.caps ? d.caps[k] : null);
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.getAvailable = () => false;
  d.setAvailable = async () => { d.availabilityCalls++; };
  d.removeCapability = async () => {};
  d.homey = {
    __: (k) => k,
    app: { getCoordinator: () => ({ register: () => {} }) },
    flow: { getDeviceTriggerCard: () => ({ trigger: () => Promise.resolve() }) },
  };
  return d;
}
const load = (kw) => ({ kpiByType: { [AC_OUTPUT]: [{ active_power: kw }] }, freshKpiByType: { [AC_OUTPUT]: [{ active_power: kw }] } });
const nothing = () => ({ kpiByType: {}, freshKpiByType: {} });

// ── the integration interval ───────────────────────────────────────────────────

test('one reading stands for its interval, and not for a gap', () => {
  const now = 1_000_000_000;
  assert.strictEqual(integrationHours(now - 5 * MIN, now, 5), 5 / 60);
  assert.strictEqual(integrationHours(now - 14 * MIN, now, 5), 14 / 60, 'a late poll still counts');
  assert.strictEqual(integrationHours(now - 16 * MIN, now, 5), 0, 'over 15 min at a 5-min interval is a gap');
  assert.strictEqual(integrationHours(now - 140 * MIN, now, 60), 140 / 60, 'at 60 min, up to 150 min');
  assert.strictEqual(integrationHours(now - 151 * MIN, now, 60), 0);
  assert.strictEqual(integrationHours(now + 1000, now, 5), 0, 'a clock going back books nothing');
});

// ── 1. the home meter ──────────────────────────────────────────────────────────

test('the home meter counts what it measured over the interval', async () => {
  const d = device(HomeDevice);
  d._homeKwh = 10; d._lastEnergyTs = Date.now() - 5 * MIN;
  await d.onPollData(load(0.8));
  assert.strictEqual(d.caps.measure_power, 800);
  assert.ok(Math.abs(d.caps.meter_power - (10 + 0.8 * 5 / 60)) < 0.002);
});

test('with no load reading, nothing is counted — not through a day of silence', async () => {
  const d = device(HomeDevice, { caps: { measure_power: 800, meter_power: 10 } });
  d._homeKwh = 10; d._lastEnergyTs = Date.now() - 5 * MIN;
  for (let i = 0; i < 288; i++) await d.onPollData(nothing());   // a day of 5-min polls
  assert.strictEqual(d.caps.meter_power, 10, 'consumption was invented while nothing was known');
  // and when data returns, only the interval since the last poll is booked
  d._lastEnergyTs -= 5 * MIN;
  await d.onPollData(load(0.8));
  assert.ok(d.caps.meter_power - 10 < 0.07, `${d.caps.meter_power - 10} kWh booked for 5 minutes`);
});

test('after a long gap without polls, the next reading does not stand for the gap', async () => {
  const d = device(HomeDevice, { caps: { meter_power: 10 } });
  d._homeKwh = 10; d._lastEnergyTs = Date.now() - 60 * MIN;     // the app was down for an hour
  await d.onPollData(load(2));
  assert.strictEqual(d.caps.meter_power, 10, '2 kW for an hour nobody measured');
});

test('the grid and battery totals do not book a gap either', async () => {
  const grid = device(GridDevice, { caps: { meter_power: 50 } });
  grid._importedKwh = 50; grid._lastEnergyTs = Date.now() - 60 * MIN;
  await grid._accumulate(2000);
  assert.strictEqual(grid.caps.meter_power, 50);
  const batt = device(BatteryDevice);
  batt._chargedKwh = 7; batt._lastEnergyTs = Date.now() - 60 * MIN;
  await batt._accumulateCharged(2000);
  assert.strictEqual(batt.caps['meter_power.charged'], 7);
  batt._lastEnergyTs -= 5 * MIN;                                 // the next interval counts again
  await batt._accumulateCharged(2000);
  assert.ok(Math.abs(batt.caps['meter_power.charged'] - (7 + 2 * 5 / 60)) < 0.002);
});

test('no iSitePower device sets itself available — the coordinator decides', async () => {
  const home = device(HomeDevice);   home._homeKwh = 0; home._lastEnergyTs = Date.now();
  const grid = device(GridDevice);   grid._importedKwh = 0; grid._lastEnergyTs = Date.now(); grid._prevGridW = 0; grid._mainsOffset = null;
  const batt = device(BatteryDevice); batt._chargedKwh = 0; batt._lastEnergyTs = Date.now();
  const sol  = device(SolarDevice);
  await home.onPollData(nothing());
  await grid.onPollData(nothing());
  await batt.onPollData(nothing());
  await sol.onPollData({ ...nothing(), stationKpi: null });
  for (const d of [home, grid, batt, sol]) assert.strictEqual(d.availabilityCalls, 0);
});

// ── 2. the grid meter ──────────────────────────────────────────────────────────

const mains = (kwh) => ({ kpiByType: { [MAINS]: [{ active_power: 0.3, total_energy_consumption: kwh }] }, freshKpiByType: { [MAINS]: [{ active_power: 0.3, total_energy_consumption: kwh }] } });

async function gridDevice(opts) {
  const d = device(GridDevice, opts);
  await d.onInit();
  return d;
}

test('a first poll without Mains data and a second with it do not make a lifetime of import', async () => {
  const d = await gridDevice();
  await d.onPollData(nothing());                 // grace cycle after pairing: the integral starts at 0
  assert.strictEqual(d.caps.meter_power, 0);
  await d.onPollData(mains(4212.5));
  assert.strictEqual(d.caps.meter_power, 0, '0 → 4212.5 kWh in one step');
  await d.onPollData(mains(4213.7));
  assert.ok(Math.abs(d.caps.meter_power - 1.2) < 1e-9, 'it follows the Mains meter\'s increments');
  assert.strictEqual(d.store.mains_offset, -4212.5);
});

test('a meter that has shown nothing yet reads the Mains meter\'s own total', async () => {
  const d = await gridDevice();
  await d.onPollData(mains(4212.5));
  assert.strictEqual(d.caps.meter_power, 4212.5);
  assert.strictEqual(d.store.mains_offset, 0);
});

test('an installation that already followed the Mains meter keeps doing so — downtime import included', async () => {
  const d = await gridDevice({ caps: { meter_power: 4200 }, store: { imported_kwh: 4200 } });   // no offset stored yet
  await d.onPollData(mains(4212.5));             // 12.5 kWh were used while the app updated
  assert.strictEqual(d.caps.meter_power, 4212.5);
  assert.strictEqual(d.store.mains_offset, 0);
});

test('the offset survives a restart, and the meter never goes back', async () => {
  const d = await gridDevice({ caps: { meter_power: 30 }, store: { imported_kwh: 30, mains_offset: -4182.5 } });
  await d.onPollData(mains(4213.5));
  assert.ok(Math.abs(d.caps.meter_power - 31) < 1e-9);
  await d.onPollData(mains(4100));               // one of two Mains units missing this poll
  assert.ok(Math.abs(d.caps.meter_power - 31) < 1e-9);
});

// ── 3. the baselines ───────────────────────────────────────────────────────────

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function app(devices, settings = {}) {
  const a = Object.create(App.prototype);
  a.logs = []; a.timers = [];
  a.settingsStore = { ...settings };
  a.log = (...x) => a.logs.push(x.join(' '));
  a.error = a.log;
  a.homey = {
    setTimeout: (fn, ms) => { a.timers.push({ fn, ms }); return a.timers.length; },
    clearTimeout: () => {},
    clock: { getTimezone: () => 'UTC' },
    settings: { get: (k) => (k in a.settingsStore ? a.settingsStore[k] : null), set: (k, v) => { a.settingsStore[k] = v; } },
    drivers: {
      getDriver: (id) => {
        if (!(id in devices)) throw new Error('no driver');
        const caps = devices[id];
        return { getDevices: () => [{ getCapabilityValue: (c) => (c in caps ? caps[c] : null) }] };
      },
    },
  };
  return a;
}

test('PV and house baselines are written on a plant with no grid device', () => {
  const a = app({ isitepower_solar_openapi_fusionsolar: { meter_power: 1000 }, isitepower_home_openapi_fusionsolar: { meter_power: 500 } });
  const r = a._saveMidnightBaseline();
  assert.deepStrictEqual(r, { written: ['pv', 'house'], reason: null });
  assert.deepStrictEqual(a.settingsStore.eb_pv_baseline, { date: TODAY, baseline: 1000 });
  assert.deepStrictEqual(a.settingsStore.eb_house_baseline, { date: TODAY, baseline: 500 });
  assert.ok(!a.logs.some((l) => /no inverter or grid meter is paired/.test(l)));
});

test('an app start that finds only the PV baseline missing writes only that one', () => {
  const a = app({
    sun2000_modbus: { 'meter_power.grid_export': 1300, 'meter_power.grid_import': 700 },
    isitepower_solar_openapi_fusionsolar: { meter_power: 1000 },
  }, {
    eb_grid_export_baseline: { date: TODAY, baseline: 1234.5 },
    eb_grid_import_baseline: { date: TODAY, baseline: 678.9 },
  });
  a._ensureTodayBaseline();
  a.timers.shift().fn();
  assert.strictEqual(a.settingsStore.eb_grid_export_baseline.baseline, 1234.5, 'today\'s grid baseline was re-taken from a later reading');
  assert.strictEqual(a.settingsStore.eb_grid_import_baseline.baseline, 678.9);
  assert.deepStrictEqual(a.settingsStore.eb_pv_baseline, { date: TODAY, baseline: 1000 });
  assert.strictEqual(a.timers.length, 0);
  assert.ok(!a.logs.some((l) => /No baseline for today/.test(l)), a.logs.join(' | '));
  assert.ok(!a.logs.some((l) => /baseline saved – (export|import)/.test(l)));
});

test('an unread PV total is retried like an unread grid counter', () => {
  const a = app({ isitepower_solar_openapi_fusionsolar: {} });
  a._ensureTodayBaseline();
  a.timers.shift().fn();
  assert.strictEqual(a.timers.length, 1, 'it gave up on an unread PV total at once');
});

test('the midnight timer still writes every baseline, whatever is stored', () => {
  const a = app({ sun2000_modbus: { 'meter_power.grid_export': 1300, 'meter_power.grid_import': 700 } }, {
    eb_grid_export_baseline: { date: TODAY, baseline: 1 },
  });
  const r = a._saveMidnightBaseline();
  assert.deepStrictEqual(r.written, ['export', 'import']);
  assert.strictEqual(a.settingsStore.eb_grid_export_baseline.baseline, 1300);
});
