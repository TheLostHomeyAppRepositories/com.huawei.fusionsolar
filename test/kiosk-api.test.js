'use strict';

// Unit tests for the FusionSolar Kiosk read path. Run: node --test
//
// The whole point of this file is one field report (log 9c7e4414, 2026-08-21): "I have to
// restart the app all the time to get the solar production shown". The Kiosk device polls a
// REST endpoint whose payload is JSON embedded as an HTML-escaped string inside more JSON.
// Two independent fallbacks used to turn a payload that did not unpack into a complete set
// of zeros — a failed inner parse that was swallowed, and a KPI block that defaulted to {}
// with every figure folded to 0. Nothing threw, the device stayed available, and the tile
// read 0 W. These tests pin both doors shut.

const test   = require('node:test');
const assert = require('node:assert');
const { parseKioskUrl, buildApiUrl, extractKpiValues } = require('../lib/kiosk-api');

// The shape the API really returns, as documented in fetchKioskData.
const REAL_KPI = {
  realTimePower: '2.345',      // kW, as a string
  dailyEnergy: '12.5',
  monthEnergy: '340.2',
  yearEnergy: '4120.8',
  cumulativeEnergy: '18400.6',
};

// ── the URL plumbing (unchanged behaviour, pinned) ───────────────────────────
test('parseKioskUrl — takes the kk token and the origin out of both URL shapes', () => {
  const a = parseKioskUrl('https://uni001eu5.fusionsolar.huawei.com/pvmswebsite/assets/build/cloud.html#/kiosk?kk=ABC123');
  assert.strictEqual(a.baseUrl, 'https://uni001eu5.fusionsolar.huawei.com');
  assert.strictEqual(a.kk, 'ABC123');

  const b = parseKioskUrl('https://eu5.fusionsolar.huawei.com/singleKiosk.html?kk=XYZ789');
  assert.strictEqual(b.baseUrl, 'https://eu5.fusionsolar.huawei.com');
  assert.strictEqual(b.kk, 'XYZ789');
});

test('parseKioskUrl — a URL without a kk token is refused, not half-accepted', () => {
  assert.throws(() => parseKioskUrl('https://eu5.fusionsolar.huawei.com/singleKiosk.html'), /kk/);
  assert.throws(() => parseKioskUrl(''), /Invalid kiosk URL/);
});

test('buildApiUrl — the endpoint carries the token', () => {
  assert.strictEqual(
    buildApiUrl('https://eu5.fusionsolar.huawei.com', 'ABC'),
    'https://eu5.fusionsolar.huawei.com/rest/pvms/web/kiosk/v1/station-kiosk-file?kk=ABC',
  );
});

// ── the zero trap ────────────────────────────────────────────────────────────
test('extractKpiValues — a full payload decodes, kW converted to W', () => {
  const out = extractKpiValues({ realKpi: REAL_KPI });
  assert.strictEqual(out.realTimePower, 2345);       // 2.345 kW → W
  assert.strictEqual(out.dailyEnergy, 12.5);
  assert.strictEqual(out.monthEnergy, 340.2);
  assert.strictEqual(out.yearEnergy, 4120.8);
  assert.strictEqual(out.cumulativeEnergy, 18400.6);
});

test('extractKpiValues — the stationOverview shape is read too', () => {
  const out = extractKpiValues({ stationOverview: { activePower: '1.5', dayPower: '3' } });
  assert.strictEqual(out.realTimePower, 1500);
  assert.strictEqual(out.dailyEnergy, 3);
});

// The heart of it: no KPI block is a broken response, not a reading of zero.
test('extractKpiValues — a payload with no KPI block throws instead of reporting zeros', () => {
  assert.throws(() => extractKpiValues({ success: true }), /no KPI data/);
  assert.throws(() => extractKpiValues({}), /no KPI data/);
  assert.throws(() => extractKpiValues(null), /no KPI data/);
});

test('extractKpiValues — a missing single figure is null, not zero', () => {
  const out = extractKpiValues({ realKpi: { realTimePower: '2.0' } });
  assert.strictEqual(out.realTimePower, 2000, 'the figure that WAS reported must survive');
  assert.strictEqual(out.dailyEnergy, null);
  assert.strictEqual(out.monthEnergy, null);
  assert.strictEqual(out.yearEnergy, null);
  // The one that did the real damage: Homey derives the daily yield from this counter by
  // difference, so a 0 here books the whole lifetime output as one day's production.
  assert.strictEqual(out.cumulativeEnergy, null);
});

test('extractKpiValues — unparseable and empty values are null, a real zero stays zero', () => {
  const out = extractKpiValues({
    realKpi: { realTimePower: 0, dailyEnergy: '', monthEnergy: 'N/A', yearEnergy: null, cumulativeEnergy: '0.0' },
  });
  assert.strictEqual(out.realTimePower, 0, 'a genuinely reported zero is a measurement');
  assert.strictEqual(out.dailyEnergy, null);
  assert.strictEqual(out.monthEnergy, null);
  assert.strictEqual(out.yearEnergy, null);
  assert.strictEqual(out.cumulativeEnergy, 0);
});

// ── what the device does with a null ─────────────────────────────────────────
// device.js needs the homey module and never loads in the test process, so its wiring is
// checked by reading it — the same way the EMS device's wiring is checked in app.test.js.
test('the Kiosk device neither writes a missing figure nor fires a flow with it', () => {
  const fs  = require('fs');
  const dev = fs.readFileSync('drivers/fusionsolar_kiosk/device.js', 'utf8');

  const set = dev.slice(dev.indexOf('async _set(capability, value)'));
  assert.match(set, /if \(value === null \|\| value === undefined\) return;/,
    'a missing figure is written through again, blanking the tile');

  assert.match(dev, /if \(kpi\.realTimePower !== null\) \{/, 'power_changed can fire with a null token');
  assert.match(dev, /if \(kpi\.dailyEnergy !== null\) \{/, 'daily_energy_updated can fire with a null token');
});

test('the Kiosk device reports its polls like every other driver', () => {
  const fs  = require('fs');
  const dev = fs.readFileSync('drivers/fusionsolar_kiosk/device.js', 'utf8');
  assert.match(dev, /require\('\.\.\/\.\.\/lib\/poll-log'\)/, 'the throttled loggers are not imported');
  assert.match(dev, /logPollOk\(this,/, 'a successful poll still leaves no trace in the log');
  assert.match(dev, /logPollError\(this,/, 'a failing poll does not go through the throttle');
});

// The swallowed inner parse — the second door into the zero trap. fetchKioskData does its
// own HTTP, so the branch is checked by reading it rather than by standing up a server.
test('a response whose inner JSON does not parse is rejected, not silently emptied', () => {
  const fs  = require('fs');
  const api = fs.readFileSync('lib/kiosk-api.js', 'utf8');
  const block = api.slice(api.indexOf('if (typeof outer.data === \'string\')'), api.indexOf('} else if (outer.data'));

  assert.match(block, /reject\(new Error\(`Failed to parse response data/,
    'the inner parse failure is swallowed again, leaving an envelope with no realKpi');
  assert.ok(!/catch \(_\) \{ \/\* keep outer/.test(block), 'the silent fallback is back');
});
