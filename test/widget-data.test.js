'use strict';

// The power snapshot every live widget draws from. Run: node --test
//
// The whole point of this file is the difference between "nothing there" and "zero".
// fmt() in the widgets prints null as an em dash, so a null travels all the way to the
// screen as "we don't know" — while a 0 is a measurement, and a wrong one. Two of these
// chains used to end in 0, and a house with no inverter paired was shown a confident
// "0 W" of solar production.

const test   = require('node:test');
const assert = require('node:assert');

const { getDevice, cap, getPowerData } = require('../lib/widget-data');

// A Homey stand-in: `caps` maps driverId -> { capabilityId: value }. A driver that is not
// listed does not exist; a driver listed with null has no paired devices.
function fakeHomey(caps) {
  return {
    drivers: {
      getDriver(id) {
        if (!(id in caps)) throw new Error('no such driver: ' + id);
        const values = caps[id];
        return { getDevices: () => (values === null ? [] : [{ getCapabilityValue: (c) => values[c] ?? null }]) };
      },
    },
  };
}

test('getDevice — an unknown driver or an unpaired one is null, never a throw', () => {
  const homey = fakeHomey({ luna2000_modbus: null });
  assert.strictEqual(getDevice(homey, 'luna2000_modbus'), null, 'driver exists, nothing paired');
  assert.strictEqual(getDevice(homey, 'not_a_driver'), null, 'a throwing lookup is still null');
});

test('cap — a missing device or capability falls back rather than throwing', () => {
  assert.strictEqual(cap(null, 'measure_power'), null);
  assert.strictEqual(cap({ getCapabilityValue: () => { throw new Error('boom'); } }, 'x', 7), 7);
  assert.strictEqual(cap({ getCapabilityValue: () => 0 }, 'measure_power', 99), 0,
    'a real zero reading must survive the fallback — it is a measurement');
});

// The regression this file exists for.
test('getPowerData — with nothing paired every figure is unknown, not zero', () => {
  const homey = fakeHomey({
    sun2000_modbus: null, sun2000_emma_modbus: null, luna2000_modbus: null,
    luna2000_emma_modbus: null, powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null, isitepower_home_openapi_fusionsolar: null,
  });
  const d = getPowerData(homey);
  assert.strictEqual(d.pvPower, null, 'no inverter is not "producing 0 W"');
  assert.strictEqual(d.gridPower, null, 'no meter is not "importing 0 W"');
  assert.strictEqual(d.batteryPower, null);
  assert.strictEqual(d.batterySoc, null);
  assert.strictEqual(d.housePower, null, 'two unknowns must not add up to a confident zero');
});

test('getPowerData — a genuine zero reading is reported as zero', () => {
  const homey = fakeHomey({
    sun2000_modbus: { measure_power: 0, 'measure_power.grid_active_power': 0 },
    sun2000_emma_modbus: null, luna2000_modbus: null, luna2000_emma_modbus: null,
    powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null, isitepower_home_openapi_fusionsolar: null,
  });
  const d = getPowerData(homey);
  assert.strictEqual(d.pvPower, 0, 'the inverter really says zero — that is data');
  assert.strictEqual(d.gridPower, 0);
  assert.strictEqual(d.housePower, 0, 'and the balance derived from it is a real zero too');
});

test('getPowerData — the house balance is derived only when PV and grid are both known', () => {
  const base = {
    sun2000_emma_modbus: null, luna2000_emma_modbus: null, powermeter_emma_modbus: null,
    sdongle_a_modbus: null, isitepower_solar_openapi_fusionsolar: null,
    isitepower_battery_openapi_fusionsolar: null, isitepower_grid_openapi_fusionsolar: null,
    isitepower_home_openapi_fusionsolar: null,
  };
  // PV 3000, importing 500, battery charging 1000 → house = 3000 + 500 - 1000
  const full = getPowerData(fakeHomey(Object.assign({}, base, {
    sun2000_modbus:  { measure_power: 3000, 'measure_power.grid_active_power': 500 },
    luna2000_modbus: { measure_power: 1000, measure_battery: 80 },
  })));
  assert.strictEqual(full.housePower, 2500);
  assert.strictEqual(full.batterySoc, 80);

  // No battery at all is not a gap — a house without one simply draws the difference.
  const noBattery = getPowerData(fakeHomey(Object.assign({}, base, {
    sun2000_modbus: { measure_power: 3000, 'measure_power.grid_active_power': 500 },
    luna2000_modbus: null,
  })));
  assert.strictEqual(noBattery.housePower, 3500);

  // A grid reading without any PV reading cannot produce a balance.
  const noPv = getPowerData(fakeHomey(Object.assign({}, base, {
    sun2000_modbus: null, luna2000_modbus: null,
    powermeter_emma_modbus: { measure_power: 500 },
  })));
  assert.strictEqual(noPv.gridPower, 500);
  assert.strictEqual(noPv.pvPower, null);
  assert.strictEqual(noPv.housePower, null, 'a sum missing one of its terms is not a smaller sum');
});

test('getPowerData — the balance never goes negative', () => {
  const d = getPowerData(fakeHomey({
    sun2000_modbus:  { measure_power: 1000, 'measure_power.grid_active_power': -4000 },
    luna2000_modbus: null, sun2000_emma_modbus: null, luna2000_emma_modbus: null,
    powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null, isitepower_home_openapi_fusionsolar: null,
  }));
  assert.strictEqual(d.housePower, 0, 'exporting more than produced would imply a negative load');
});

test('getPowerData — a paired home meter wins over the derived balance', () => {
  const d = getPowerData(fakeHomey({
    sun2000_modbus:  { measure_power: 3000, 'measure_power.grid_active_power': 500 },
    luna2000_modbus: null, sun2000_emma_modbus: null, luna2000_emma_modbus: null,
    powermeter_emma_modbus: null, sdongle_a_modbus: null,
    isitepower_solar_openapi_fusionsolar: null, isitepower_battery_openapi_fusionsolar: null,
    isitepower_grid_openapi_fusionsolar: null,
    isitepower_home_openapi_fusionsolar: { measure_power: 2222 },
  }));
  assert.strictEqual(d.housePower, 2222, 'a measured figure beats a computed one');
});
