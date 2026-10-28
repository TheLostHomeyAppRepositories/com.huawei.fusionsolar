'use strict';

// Several inverters and batteries over Modbus, taken together by the widgets (1.3.9).
// Run: node --test
//
// Wim_Hartman (forum, 2026-10-28): two SUN2000 with a LUNA2000 apiece, paired over Modbus on
// unit IDs 1 and 2, every device working. The battery status and power flow widgets showed set
// 1 alone, and he asked for one state of charge for both. getDevice() hands back the first
// device of a driver, and every widget read the Modbus inverter and battery through it — so
// daily yield and energy balance counted one inverter too, and the power flow worked out the
// house as one inverter's solar against the whole plant's grid.
//
// Andi: "Ja, bauen".

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const W = require('../lib/widget-data');
const batteryStatus = require('../widgets/battery-status/api.js');
const dailyYield    = require('../widgets/daily-yield/api.js');
const energyBalance = require('../widgets/energy-balance/api.js');
const powerFlow     = require('../widgets/solar-power-flow/api.js');

// A device: capabilities (present = listed), settings, reachability.
function dev(caps, { unit = 1, available = true, settings = {} } = {}) {
  const all = { address: '192.168.1.20', port: 502, modbus_id: unit, ...settings };
  return {
    getCapabilityValue: (c) => (c in caps ? caps[c] : null),
    hasCapability: (c) => c in caps,
    getSetting: (k) => (k in all ? all[k] : null),
    getAvailable: () => available,
  };
}

// `table` maps driverId -> [devices]. Every driver the widgets ask for exists.
function fakeHomey(table, settings = {}) {
  return {
    i18n: { getLanguage: () => 'en' },
    clock: { getTimezone: () => 'UTC' },
    settings: { get: (k) => settings[k] ?? null },
    drivers: { getDriver: (id) => ({ getDevices: () => table[id] || [] }) },
  };
}

// Wim's plant: the meter on inverter 1, a 5 kWh battery at 90 % on unit 1 and a 15 kWh one at
// 30 % on unit 2.
const inv1 = (o) => dev({ 'measure_power': 3000, 'measure_power.grid_active_power': -500,
  'meter_power.grid_export': 120, 'meter_power.grid_import': 340,
  'meter_power.daily': 12.5, 'meter_power': 4200, ...o }, { unit: 1 });
const inv2 = (o, opt) => dev({ 'measure_power': 2000, 'meter_power.daily': 8.25, 'meter_power': 3100, ...o }, { unit: 2, ...opt });
const bat1 = (o, opt) => dev({ 'measure_power': 1000, 'measure_battery': 90, 'battery_rated_capacity': 5,
  'meter_power.today_batt_input': 4, 'meter_power.today_batt_output': 1,
  'luna2000_battery_status': 'Running', 'measure_battery.backup': 10, ...o },
{ unit: 1, settings: { charging_cutoff_capacity: 100, discharge_cutoff_capacity: 10 }, ...opt });
const bat2 = (o, opt) => dev({ 'measure_power': 2000, 'measure_battery': 30, 'battery_rated_capacity': 15,
  'meter_power.today_batt_input': 6, 'meter_power.today_batt_output': 2,
  'luna2000_battery_status': 'Running', 'measure_battery.backup': 20, ...o },
{ unit: 2, settings: { charging_cutoff_capacity: 90, discharge_cutoff_capacity: 5 }, ...opt });

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);

// ── The power flow (and the traffic light, which reads the same payload) ─────────────────

test('Wim\'s plant: both inverters, both batteries, one state of charge by capacity', () => {
  const homey = fakeHomey({ sun2000_modbus: [inv1(), inv2()], luna2000_modbus: [bat1(), bat2()] });
  const d = W.getPowerData(homey);
  assert.strictEqual(d.pvPower, 5000, 'the second inverter\'s solar is missing');
  assert.strictEqual(d.batteryPower, 3000, 'the second battery is missing');
  close(d.batterySoc, 45, '90 % of 5 kWh and 30 % of 15 kWh hold 45 % together, not the 60 % of a plain mean');
  assert.strictEqual(d.gridPower, -500);
  assert.strictEqual(d.housePower, 1500, 'the house: 5000 W solar − 500 W export − 3000 W into the batteries');
});

test('the grid comes from the inverter the meter is wired to, whichever was paired first', () => {
  const noMeter = dev({ 'measure_power': 2000 }, { unit: 2 });
  const homey = fakeHomey({ sun2000_modbus: [noMeter, inv1()] });
  assert.strictEqual(W.getPowerData(homey).gridPower, -500);
  assert.strictEqual(W.meterInverter(homey).getSetting('modbus_id'), 1);
  // none has a meter: the first paired, as before
  const a = dev({ 'measure_power': 1 }, { unit: 1 });
  assert.strictEqual(W.meterInverter(fakeHomey({ sun2000_modbus: [a, dev({}, { unit: 2 })] })), a);
  assert.strictEqual(W.meterInverter(fakeHomey({})), null);
});

test('an inverter or battery that cannot be reached is left out, not counted as zero', () => {
  const homey = fakeHomey({
    sun2000_modbus: [inv1(), inv2({}, { available: false })],
    luna2000_modbus: [bat1(), bat2({}, { available: false })],
  });
  const d = W.getPowerData(homey);
  assert.strictEqual(d.pvPower, 3000);
  assert.strictEqual(d.batteryPower, 1000);
  assert.strictEqual(d.batterySoc, 90, 'the unreachable battery\'s last reading was averaged in');
  // and none reachable at all is unknown, not 0
  const none = W.getPowerData(fakeHomey({ sun2000_modbus: [inv2({}, { available: false })] }));
  assert.strictEqual(none.pvPower, null);
});

test('one unit paired twice is one inverter', () => {
  const homey = fakeHomey({ sun2000_modbus: [inv1(), inv1(), inv2()] });
  assert.strictEqual(W.getDevices(homey, 'sun2000_modbus').length, 2);
  assert.strictEqual(W.getPowerData(homey).pvPower, 5000, 'counted twice');
  // another address with the same unit ID is another inverter
  const other = dev({ 'measure_power': 700 }, { unit: 1, settings: { address: '192.168.1.21' } });
  assert.strictEqual(W.getPowerData(fakeHomey({ sun2000_modbus: [inv1(), other] })).pvPower, 3700);
});

test('one inverter and one battery read exactly as before', async () => {
  const homey = fakeHomey({ sun2000_modbus: [inv1()], luna2000_modbus: [bat2()] });
  const d = await powerFlow.getData({ homey });
  assert.strictEqual(d.pvPower, 3000);
  assert.strictEqual(d.batteryPower, 2000);
  assert.strictEqual(d.batterySoc, 30);
  assert.strictEqual(d.gridPower, -500);
});

test('capWeighted: a plain mean where a battery does not say its capacity; null with nothing', () => {
  const a = dev({ 'measure_battery': 80, 'battery_rated_capacity': 10 });
  const b = dev({ 'measure_battery': 40 }, { unit: 2 });
  const soc = (d) => W.cap(d, 'measure_battery', null);
  assert.strictEqual(W.capWeighted([a, b], soc), 60);
  assert.strictEqual(W.capWeighted([], soc), null);
  assert.strictEqual(W.capWeighted([dev({})], soc), null);
  assert.strictEqual(W.capSum([dev({}), dev({}, { unit: 2 })], 'measure_power'), null, 'nothing known is not 0');
  assert.strictEqual(W.capSum([dev({ 'measure_power': 0 })], 'measure_power'), 0, 'a real zero stays a zero');
});

// ── Battery status ─────────────────────────────────────────────────────────────────────

test('battery status: the two batteries as one', async () => {
  const d = await batteryStatus.getData({ homey: fakeHomey({ luna2000_modbus: [bat1(), bat2()] }) });
  close(d.soc, 45, 'state of charge');
  assert.strictEqual(d.powerW, 3000);
  assert.strictEqual(d.todayChargedKwh, 10);
  assert.strictEqual(d.todayDischargedKwh, 3);
  assert.strictEqual(d.capacityKwh, 20);
  assert.strictEqual(d.status, 'charging', 'both "Running", and the summed power charges');
  assert.strictEqual(d.unreachable, false);
  // The limits weighted the same way, so the distance to full is what both have left:
  // 5 kWh × (100 − 90) % + 15 kWh × (90 − 30) % = 0.5 + 9 = 9.5 kWh.
  close((d.socCeiling - d.soc) / 100 * d.capacityKwh, 9.5, 'to full');
  close((d.soc - d.socFloor) / 100 * d.capacityKwh, 5 * 0.80 + 15 * 0.25, 'to the floor');
  close(d.socReserve, (10 * 5 + 20 * 15) / 20, 'reserve');
});

test('battery status: two states with no word between them follow the summed power', async () => {
  const homey = fakeHomey({ luna2000_modbus: [
    bat1({ 'luna2000_battery_status': 'Standby', 'measure_power': 0 }),
    bat2({ 'measure_power': -1500 }),
  ] });
  const d = await batteryStatus.getData({ homey });
  assert.strictEqual(d.status, 'discharging');
});

test('battery status: no capacity for the pair when one battery does not say its own', async () => {
  const homey = fakeHomey({ luna2000_modbus: [bat1(), bat2({ 'battery_rated_capacity': null })] });
  const d = await batteryStatus.getData({ homey });
  assert.strictEqual(d.capacityKwh, null, 'a sum missing one battery counts down to a time that is not there');
  close(d.soc, 60, 'the plain mean');
});

test('battery status: with the first battery unreachable, the second is shown, not "unreachable"', async () => {
  const homey = fakeHomey({ luna2000_modbus: [bat1({}, { available: false }), bat2()] });
  const d = await batteryStatus.getData({ homey });
  assert.strictEqual(d.unreachable, false);
  assert.strictEqual(d.soc, 30);
  assert.strictEqual(d.powerW, 2000);
  assert.strictEqual(d.capacityKwh, 15);
  // Settings outlive a battery that has gone: its limits must not be weighted in either.
  assert.strictEqual(d.socCeiling, 90, 'the unreachable battery\'s ceiling was weighted in');
  assert.strictEqual(d.socFloor, 5);
});

test('battery status: one battery reads exactly as before', async () => {
  const d = await batteryStatus.getData({ homey: fakeHomey({ luna2000_modbus: [bat2()] }) });
  assert.strictEqual(d.soc, 30);
  assert.strictEqual(d.powerW, 2000);
  assert.strictEqual(d.capacityKwh, 15);
  assert.strictEqual(d.socCeiling, 90);
  assert.strictEqual(d.socFloor, 5);
  assert.strictEqual(d.socReserve, 20);
});

// ── Daily yield and energy balance ─────────────────────────────────────────────────────

test('daily yield: today and lifetime of both inverters, and their optimizers', async () => {
  const homey = fakeHomey({ sun2000_modbus: [
    inv1({ 'optimizer_total_count': 12, 'optimizer_online_count': 12 }),
    inv2({ 'optimizer_total_count': 8, 'optimizer_online_count': 7 }),
  ] });
  const d = await dailyYield.getData({ homey });
  assert.strictEqual(d.dailyKwh, 20.75);
  assert.strictEqual(d.totalKwh, 7300);
  assert.strictEqual(d.optimizerTotal, 20);
  assert.strictEqual(d.optimizerOnline, 19);
});

test('energy balance: both inverters\' yield, both batteries, the grid from the meter inverter', async () => {
  const today = W.todayStr(fakeHomey({}));
  const homey = fakeHomey(
    { sun2000_modbus: [inv2(), inv1()], luna2000_modbus: [bat1(), bat2()] },
    { eb_grid_export_baseline: { date: today, baseline: 110 }, eb_grid_import_baseline: { date: today, baseline: 337 } },
  );
  const d = await energyBalance.getData({ homey });
  assert.strictEqual(d.pvTodayKwh, 20.75);
  assert.strictEqual(d.gridExportKwh, 10, 'the export counter of the inverter without the meter');
  assert.strictEqual(d.gridImportKwh, 3);
  assert.strictEqual(d.battChargedKwh, 10);
  assert.strictEqual(d.battDischargedKwh, 3);
  // The inverters' AC output already has the batteries netted out: 20.75 − 10 exported + 3 imported.
  assert.strictEqual(d.houseConsumptionKwh, 13.75);
});

test('the midnight baseline reads the grid counters off the same inverter as the widget', () => {
  const app    = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const widget = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'energy-balance', 'api.js'), 'utf8');
  assert.match(app, /const sun2000\s+= meterInverter\(this\.homey\);/);
  assert.match(widget, /const sun2000\s+= meterInverter\(homey\);/);
});
