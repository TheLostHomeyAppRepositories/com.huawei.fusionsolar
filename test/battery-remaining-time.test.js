'use strict';

// The remaining-time estimate on the battery widget. Run: node --test
//
// Reported by gsommer as issue #33: charging at 2 kW from 50 %, a 15 kWh battery was told it
// would be full in a little over an hour. The arithmetic was never wrong — (1 - soc) × kWh
// ÷ kW is right. The capacity was wrong, and it was wrong by design: the widget's frontend
// opened with `var capacityKwh = 5`, and the manifest handed every widget that same 5 as its
// setting's default. Five kilowatt-hours is one LUNA2000 module. Gerhard has three.
//
//     (1 − 0.50) × 5 kWh ÷ 2 kW = 1.25 h      ← what he saw
//     (1 − 0.50) × 15 kWh ÷ 2 kW = 3.75 h     ← what it is
//
// Nobody had typed a wrong number. The app shipped one, and then stated the result to the
// minute. So this file guards two things: that the capacity comes from the battery when the
// battery knows it, and that an unknown capacity draws nothing at all.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WIDGET = path.join(ROOT, 'widgets/battery-status/public/index.html');
const html = fs.readFileSync(WIDGET, 'utf8');

test('the widget no longer carries a battery of its own invention', () => {
  // Anchored to the start of a line: the comment above the fix quotes the old code, and a
  // bare substring search finds the quotation and calls it a relapse.
  assert.ok(!/^\s*var capacityKwh = \d/m.test(html),
    'the frontend starts from a made-up capacity again');
  assert.ok(!/parseFloat\(settings\.battery_capacity_kwh\) \|\| \d/.test(html),
    'an unreadable setting falls back to a number instead of to nothing');

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const setting = manifest.widgets['battery-status'].settings.find((s) => s.id === 'battery_capacity_kwh');
  assert.strictEqual(setting.value, 0,
    'the manifest ships a capacity to people who never entered one');
  assert.strictEqual(setting.min, 0, 'zero has to be expressible, or "unknown" has no value');
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(/LUNA2000/.test(setting.hint[lang]),
      `the ${lang} hint does not say the battery may report this by itself`);
  }
});

test('the OpenAPI battery reports its capacity too', () => {
  // The widget falls back through luna2000_modbus → EMMA → OpenAPI → iSitePower. A plant
  // reached only through the cloud would otherwise still have no capacity and no estimate.
  // The field is called rated_capacity there and already arrives in kWh, so no conversion —
  // the same capability, two sources, two units on the wire.
  const src = fs.readFileSync(path.join(ROOT, 'drivers/luna2000_openapi_fusionsolar/device.js'), 'utf8');
  assert.ok(/sumKwh\('rated_capacity'\)/.test(src), 'the OpenAPI battery never reads rated_capacity');
  assert.ok(/_set\('battery_rated_capacity', ratedCapacityKwh\)/.test(src),
    'it reads the capacity and never writes it to the capability');
  assert.ok(/ratedCapacityKwh > 0/.test(src),
    'a zero or missing figure would be written as a capacity');

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const driver = manifest.drivers.find((d) => d.id === 'luna2000_openapi_fusionsolar');
  assert.ok(driver.capabilities.includes('battery_rated_capacity'),
    'the OpenAPI battery cannot carry the capability');
});

test('the widget asks the battery for its capacity', () => {
  const api = fs.readFileSync(path.join(ROOT, 'widgets/battery-status/api.js'), 'utf8');
  assert.ok(/battery_rated_capacity/.test(api), 'the widget never reads the capability');
  assert.ok(/capacityKwh/.test(api), 'the capacity is read but not returned');
  // From the same device the rest of the figures come from, or the estimate would describe
  // one battery with another's size.
  assert.ok(/cap\(device, 'battery_rated_capacity'/.test(api),
    'the capacity is read from a different device than the state of charge');
});

// ── the estimate itself, executed ───────────────────────────────────────────

function estimate({ soc, powerW, capacityKwh = null, setting = null,
  socCeiling = null, socFloor = null, socReserve = null }) {
  // Lift the two pieces that decide the line: the formatter and the branch that uses it.
  // The end marker is searched for AFTER the start, not from it — otherwise a marker that is
  // a prefix of the opening line finds itself and the slice comes back empty.
  const cut = (from, to) => {
    const a = html.indexOf(from);
    const b = html.indexOf(to, a + from.length);
    assert.ok(a !== -1 && b > a, `could not find ${from} … ${to}`);
    return html.slice(a, b);
  };
  const fmt = cut('function fmtRemaining(', '\nfunction ');
  const branch = cut('    // Remaining time. The battery', "    document.getElementById('batt-remaining')");

  // The block that reads the widget's own setting is lifted and RUN, not stood in for. The
  // first version of this helper handed settingCapacityKwh straight to the branch and so
  // never executed those lines — which is where the bug lived. The mutation probe caught
  // it: putting "var settingCapacityKwh = 5" back survived the whole file.
  const init = cut('  // Reported by gsommer as issue #33', '  function render(');

  const ctx = {
    T: { remaining: '' },
    Math, isFinite, parseFloat, NaN,
    // What Homey hands the widget: the setting as a string, or nothing at all.
    Homey: { getSettings: () => (setting === null ? {} : { battery_capacity_kwh: String(setting) }) },
    data: { powerW, capacityKwh, socCeiling, socFloor, socReserve },
    soc,
    result: null,
  };
  vm.createContext(ctx);
  vm.runInContext(`${fmt}\n${init}\n(function(){\n${branch}\nresult = remaining;\n})();`, ctx);
  return ctx.result;
}

test('the widget hands on the capacity it read', async () => {
  // api.js reads the capability and has to put it in the payload — reading it and dropping
  // it looks identical from the outside, and the widget then falls back to the setting.
  const Module = require('module');
  const _orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
    return _orig.call(this, request, parent, isMain);
  };
  const widgetApi = require('../widgets/battery-status/api.js');
  Module._load = _orig;

  const battery = {
    getCapabilityValue: (c) => ({
      measure_battery: 50, measure_power: 2000, battery_rated_capacity: 15,
      'measure_battery.backup': 30,
    }[c] ?? null),
    // Homey hands settings back as they were stored, which for a number field written from
    // a register can be a string. The widget has to cope with both.
    getSetting: (id) => ({ charging_cutoff_capacity: 90, discharge_cutoff_capacity: '15' }[id]),
    getAvailable: () => true,
    getCapabilities: () => ['measure_battery', 'measure_power', 'battery_rated_capacity'],
  };
  const homey = {
    i18n: { getLanguage: () => 'de' },
    drivers: {
      getDriver: (id) => {
        if (id !== 'luna2000_modbus') throw new Error('Invalid Driver');
        return { getDevices: () => [battery] };
      },
    },
  };

  const data = await widgetApi.getData({ homey });
  assert.strictEqual(data.capacityKwh, 15, 'the capacity never reaches the widget');
  assert.strictEqual(data.soc, 50, 'the rest of the payload broke');

  // And the three limits, each from the right place: two settings and one capability.
  assert.strictEqual(data.socCeiling, 90, 'the charge ceiling never reaches the widget');
  assert.strictEqual(data.socFloor, 15, 'the discharge floor never reaches the widget');
  assert.strictEqual(data.socReserve, 30, 'the backup reserve never reaches the widget');
  assert.strictEqual(typeof data.socFloor, 'number',
    'a setting stored as text arrives as text and every comparison against it becomes a guess');
});

test('a setting that is not there reads as unknown, not as zero', () => {
  // Zero is a floor somebody could have chosen; "not known" is not. The two have to stay
  // apart at the source, because everything downstream treats 0 as a real limit — and a
  // device that simply has no such setting would otherwise look like one configured to run
  // itself flat. Tested here directly: the widget's own fake throws from getSetting, which
  // exercises the catch and never reaches the branch this guards.
  const { setting } = require('../lib/widget-data');
  const device = { getSetting: (id) => ({ present: 15, zero: 0, blank: '' }[id]) };

  assert.strictEqual(setting(device, 'present'), 15);
  assert.strictEqual(setting(device, 'zero'), 0, 'a real zero was thrown away');
  assert.strictEqual(setting(device, 'blank'), '', 'an empty string is still an answer');
  assert.strictEqual(setting(device, 'missing'), null, 'a missing setting became a value');
  assert.strictEqual(setting(device, 'missing', 42), 42, 'the fallback is ignored');
  assert.strictEqual(setting(null, 'present'), null, 'a missing device became a value');
});

test('a battery that knows none of its limits sends nulls, not zeroes', async () => {
  // Zero is a floor somebody could have set. "Not known" has to stay distinguishable from
  // it, or an OpenAPI plant would look like a battery configured to run itself flat.
  const Module = require('module');
  const _orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
    return _orig.call(this, request, parent, isMain);
  };
  const widgetApi = require('../widgets/battery-status/api.js');
  Module._load = _orig;

  const bare = {
    getCapabilityValue: (c) => ({ measure_battery: 50, measure_power: 2000 }[c] ?? null),
    getSetting: () => { throw new Error('no settings on this device'); },
    getAvailable: () => true,
    getCapabilities: () => ['measure_battery', 'measure_power'],
  };
  const homey = {
    i18n: { getLanguage: () => 'en' },
    drivers: {
      getDriver: (id) => {
        if (id !== 'luna2000_modbus') throw new Error('Invalid Driver');
        return { getDevices: () => [bare] };
      },
    },
  };

  const data = await widgetApi.getData({ homey });
  assert.strictEqual(data.socCeiling, null);
  assert.strictEqual(data.socFloor, null);
  assert.strictEqual(data.socReserve, null);
  assert.strictEqual(data.capacityKwh, null);
});

test("Gerhard's battery now says three and three quarter hours, not one", () => {
  // The exact case from the issue: 15 kWh, 50 %, charging at 2 kW.
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: 15 }), '3h 45min');
  // And what he used to see, for the record — the widget's old default of five.
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, setting: 5 }), '1h 15min');
});

test('the battery outranks the typed number', () => {
  // The hardware knows; the setting is somebody's recollection of it.
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: 15, setting: 5 }), '3h 45min');
});

test('a battery that reports nothing still uses the typed number', () => {
  // An EMMA battery or an OpenAPI plant reports no nameplate. Those people typed a figure
  // once and it has to keep working.
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: null, setting: 10 }), '2h 30min');

  // And a battery that answers zero must be treated the same way, not as a battery of no
  // size. Without the "> 0" test on the reading, a zero would win over the typed number and
  // the line would go blank for somebody who had configured it correctly — the one case
  // where dropping that check changes what a person sees.
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: 0, setting: 10 }), '2h 30min');
  for (const answer of [NaN, Infinity, -5, 'fifteen']) {
    assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: answer, setting: 10 }), '2h 30min',
      `${String(answer)} from the battery displaced a good typed number`);
  }
});

test('an unknown capacity draws no time at all', () => {
  // The whole point of the issue. Nothing is the honest answer; "1h 15min" was not.
  for (const capacityKwh of [null, undefined, 0, -5, NaN, 'fifteen']) {
    assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh, setting: null }), '',
      `a capacity of ${String(capacityKwh)} produced an estimate`);
  }
});

test('discharging counts down to empty, not to full', () => {
  // 15 kWh at 80 %, giving out 3 kW: twelve kilowatt-hours to spend, four hours of it.
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15 }), '4h 0min');
});

test('a battery that is neither charging nor discharging counts down to nothing', () => {
  // The ±50 W dead band: a trickle is not a direction, and a near-zero divisor would
  // otherwise produce hours of rounding noise.
  for (const powerW of [0, 25, -25, 50, -50]) {
    assert.strictEqual(estimate({ soc: 50, powerW, capacityKwh: 15 }), '',
      `${powerW} W produced an estimate`);
  }
});

test('a full battery and an empty one show no countdown', () => {
  assert.strictEqual(estimate({ soc: 100, powerW: 2000, capacityKwh: 15 }), '', 'full and still counting');
  assert.strictEqual(estimate({ soc: 0, powerW: -2000, capacityKwh: 15 }), '', 'empty and still counting');
});

// ── the limits the battery actually honours ─────────────────────────────────
//
// Gerhard's second question on issue #33: a battery does not charge to 100 % or discharge
// to 0 %, and the estimate was counting to both. He was right that it matters, and right
// about why — the usable amount moves every time one of those settings changes, so the
// estimate has to follow them rather than be told once.

test('discharging stops at the floor, not at empty', () => {
  // 15 kWh at 80 %, giving out 3 kW. To zero that is four hours; to the 15 % the inverter
  // actually stops at it is three and a quarter. Three quarters of an hour that was never
  // his to spend.
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15 }), '4h 0min');
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15, socFloor: 15 }), '3h 15min');
});

test('charging stops at the ceiling, not at full', () => {
  // A maximum charge level of 90 % means the last 1.5 kWh are never going in.
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: 15, socCeiling: 90 }), '3h 0min');
});

test('the floor is whichever of the two is higher', () => {
  // The backup reserve usually sits above the discharge cutoff, and then it is the reserve
  // that stops the battery. But not always — somebody with no backup box and a raised
  // cutoff is the other way round, and the estimate has to take whichever binds first.
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15, socFloor: 15, socReserve: 30 }), '2h 30min');
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15, socFloor: 30, socReserve: 15 }), '2h 30min');
});

test('each limit falls back on its own, not as a set', () => {
  // An EMMA battery reports the reserve and neither cutoff; an OpenAPI plant reports none.
  // Knowing one of three has to be worth more than knowing none.
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15, socReserve: 20 }), '3h 0min',
    'a battery that knows only its reserve was treated as knowing nothing');
  assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: 15, socFloor: 15 }), '3h 45min',
    'a floor leaked into the charging direction');
  assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15, socCeiling: 90 }), '4h 0min',
    'a ceiling leaked into the discharging direction');
});

test('a battery already outside its window counts down to nothing', () => {
  // Lower the maximum to 90 while the battery sits at 95, or raise the reserve above where
  // the battery already is. "noch -1h 40min" is not an answer.
  assert.strictEqual(estimate({ soc: 95, powerW: 2000, capacityKwh: 15, socCeiling: 90 }), '',
    'charging past the ceiling produced a countdown');
  assert.strictEqual(estimate({ soc: 20, powerW: -3000, capacityKwh: 15, socReserve: 30 }), '',
    'discharging below the reserve produced a countdown');
  assert.strictEqual(estimate({ soc: 30, powerW: -3000, capacityKwh: 15, socReserve: 30 }), '',
    'sitting exactly on the reserve produced a countdown');
});

test('a limit that arrives as nonsense is ignored rather than obeyed', () => {
  for (const bad of [NaN, Infinity, null, undefined, 'ninety']) {
    assert.strictEqual(estimate({ soc: 50, powerW: 2000, capacityKwh: 15, socCeiling: bad }), '3h 45min',
      `a ceiling of ${String(bad)} changed the estimate`);
    assert.strictEqual(estimate({ soc: 80, powerW: -3000, capacityKwh: 15, socFloor: bad }), '4h 0min',
      `a floor of ${String(bad)} changed the estimate`);
  }
});
