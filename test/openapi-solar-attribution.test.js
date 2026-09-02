'use strict';

// What the SUN2000 OpenAPI device reports as solar. Run: node --test
//
// Reported in issue #25 by the owner of a hybrid SUN2000 + LUNA2000 installation, with two
// captures taken hours after sunset:
//
//   22:15   SUN2000 +2.35 kW   LUNA2000 -2.35 kW   PV 0 W   grid -19 W
//   23:33   SUN2000  +587 W    LUNA2000  -587 W    PV 0 W
//
// The device's class is solarpanel, so Homey Energy files its measure_power under "Solar
// panels". measure_power was active_power — the inverter's AC output, which on a hybrid is
// whatever the inverter is putting out no matter which side it came from. So Homey filed
// battery discharge as solar generation, at night.
//
// What made it survive: the household total stayed correct, because solar and battery
// cancelled. The reporter spotted that himself and asked for the attribution to be fixed
// without breaking the total. That total is Homey's arithmetic rather than this app's, so
// what is checked here is the app's side of it — which figure goes out under which name.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

// device.js needs `homey`; the driver class only uses Device as a base here.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const DEV_TYPE_RESIDENTIAL_INVERTER = 38;

function fakeInverter() {
  const d = Object.create(InverterDevice.prototype);
  d.values = {};
  d.logs = [];
  d.triggered = [];
  d.caps = new Set([
    'measure_power', 'measure_power.mppt', 'measure_power.active_power',
    'measure_temperature.invertor', 'meter_power.inv_total', 'meter_power.inv_daily',
  ]);
  d.log = (...a) => d.logs.push(a.join(' '));
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.values[c] = v; };
  d._trackPower = () => {};
  d.homey = {
    flow: {
      getDeviceTriggerCard: () => ({
        trigger: async (_dev, tokens) => { d.triggered.push(tokens); },
      }),
    },
  };
  return d;
}

const poll = async (kpi) => {
  const d = fakeInverter();
  await d.onPollData({ stationKpi: {}, kpiByType: { [DEV_TYPE_RESIDENTIAL_INVERTER]: [kpi] } });
  return d;
};

// The 22:15 capture. active_power is in kW in this API.
const NIGHT_2215 = { active_power: 2.35, mppt_power: 0, total_cap: 5298.26, day_cap: 12.4 };
const NIGHT_2333 = { active_power: 0.587, mppt_power: 0 };
const DAY        = { active_power: 2.98, mppt_power: 3.041, total_cap: 5301.0, day_cap: 15.1 };

test('battery discharge after sunset is not reported as solar generation', async () => {
  const d = await poll(NIGHT_2215);
  assert.strictEqual(d.values['measure_power'], 0,
    '2.35 kW of battery discharge is still filed under Solar panels');
});

test('the second night capture agrees — this was not a one-off reading', async () => {
  const d = await poll(NIGHT_2333);
  assert.strictEqual(d.values['measure_power'], 0);
});

// The AC figure is the useful one for "what is the inverter doing", and it must not be lost
// in the process — it is what the device tile has always shown as Active Power.
test('the inverter AC output is still reported, under its own name', async () => {
  const d = await poll(NIGHT_2215);
  assert.strictEqual(d.values['measure_power.active_power'], 2350,
    'the AC output disappeared along with the misattribution');
  assert.strictEqual(d.values['measure_power.mppt'], 0, 'the PV reading is no longer published');
});

// Existing flows are keyed on this token. Quietly changing what it means would break
// automations at night without anything visibly failing.
test('the power-changed flow card still reports AC output, not PV', async () => {
  const d = await poll(NIGHT_2215);
  assert.deepStrictEqual(d.triggered, [{ power: 2350 }],
    'the flow token changed meaning, so existing automations now fire on different values');
});

test('in daylight the solar figure is the generation, not the AC output', async () => {
  const d = await poll(DAY);
  assert.strictEqual(d.values['measure_power'], 3041,
    'measure_power is not the PV generation');
  assert.strictEqual(d.values['measure_power.active_power'], 2980);
});

// An inverter that does not report mppt_power must not lose its reading. On an inverter
// with no battery the AC output IS the generation, so the fallback misfiles nothing there —
// and it is strictly what these devices did before, so nobody working today breaks.
// Polled repeatedly on purpose. The note has to be said, because a hybrid inverter in this
// state is silently misfiling battery discharge — and said once, because this runs every
// poll interval for as long as the device exists.
test('an inverter without mppt_power keeps reporting, and says so exactly once', async () => {
  const d = fakeInverter();
  const kpi = { [DEV_TYPE_RESIDENTIAL_INVERTER]: [{ active_power: 1.5 }] };
  for (let i = 0; i < 3; i++) await d.onPollData({ stationKpi: {}, kpiByType: kpi });
  assert.strictEqual(d.values['measure_power'], 1500,
    'an inverter that reports no MPPT power lost its power reading entirely');
  const notes = d.logs.filter((l) => l.includes('mppt_power'));
  assert.ok(notes.length >= 1,
    'the fallback happens silently, so a hybrid inverter in this state looks correct');
  assert.strictEqual(notes.length, 1,
    `the note was written ${notes.length} times in three polls — it repeats for ever`);
});

// A zero is a reading; an absent field is not. Confusing the two here would put the
// fallback on exactly the case it exists to avoid — night-time, where PV is legitimately 0.
test('zero PV is a reading and does not trigger the fallback', async () => {
  const d = await poll(NIGHT_2215);
  assert.strictEqual(d.values['measure_power'], 0);
  assert.deepStrictEqual(d.logs.filter((l) => l.includes('mppt_power')), [],
    'a legitimate 0 W of PV was treated as a missing field');
});

// The reporter's remaining condition was that the household total must not move. That sum
// is Homey's, not this driver's — the app publishes solar, AC output, grid and battery as
// separate figures and Homey combines them. Asserting a formula for that combination here
// would be asserting something this repository cannot show to be true, so what is checked
// instead is the part that is ours: every figure that went in still comes out, under a name
// that says which one it is.
test('nothing was removed in the process, only relabelled', async () => {
  const d = await poll(DAY);
  for (const cap of ['measure_power', 'measure_power.mppt', 'measure_power.active_power',
    'meter_power.inv_total', 'meter_power.inv_daily']) {
    assert.ok(cap in d.values, `${cap} is no longer published at all`);
  }
  assert.notStrictEqual(d.values['measure_power'], d.values['measure_power.active_power'],
    'solar and AC output are the same number here, so this fixture cannot tell them apart');
});
