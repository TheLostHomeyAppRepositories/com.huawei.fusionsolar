'use strict';

// Without an EMS device, the EMS device, EMS battery and EMS forecast widgets said "EMS
// device unreachable", as if something had broken, when there simply is none. They say
// "No EMS device found" now, in the EMS history's words. A failed request still says
// unreachable (1.2.340).
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const W = path.join(__dirname, '..', 'widgets');
const html = (w) => fs.readFileSync(path.join(W, w, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function dicts(w) {
  const src = html(w);
  const ctx = {};
  vm.createContext(ctx);
  const a = src.indexOf('var DICTS = ');
  vm.runInContext(src.slice(a, src.indexOf('})();', a) + 5), ctx);
  return ctx.DICTS;
}

const EMS = ['ems-device', 'ems-battery', 'ems-forecast'];

test('the EMS widgets name a missing EMS device in the EMS history\'s words', () => {
  const words = dicts('ems-history');
  for (const w of EMS) {
    const d = dicts(w);
    for (const l of ['de', 'en', 'nl']) {
      assert.strictEqual(d[l].noEms, words[l].noEms, `${w} ${l}`);
      assert.notStrictEqual(d[l].noEms, d[l].unreachable, `${w} ${l}`);
    }
  }
  assert.strictEqual(words.de.noEms, 'Kein EMS-Gerät gefunden');
});

test('no EMS device draws that message; any other failure still says unreachable', () => {
  const bat = html('ems-battery');
  assert.match(bat, /if \(s && s\.error === 'no_ems_device'\) \{ showNoData\(T\.noEms\); syncHeight\(\); return; \}\n    if \(!s \|\| s\.error\) \{ showNoData\(T\.unreachable\);/);
  const fc = html('ems-forecast');
  assert.match(fc, /if \(data && data\.error === 'no_ems_device'\) \{ showNoData\(T\.noEms\); syncHeight\(\); return; \}\n    if \(!data \|\| data\.error\) \{ showNoData\(T\.unreachable\);/);
  const dev = html('ems-device');
  assert.match(dev, /if \(!s \|\| s\.error === 'no_ems_device'\) \{ showNoData\(s \? T\.noEms : T\.unreachable\);/);
  assert.match(dev, /: code === 'no_ems_device' \? T\.noEms\n/);
  // With no device chosen and no EMS device either, there is nothing to choose.
  assert.match(dev, /showNoData\(r\.error === 'no_ems_device' \? T\.noEms : T\.noSetting\);\n\s*fitHeight\(Homey, document\.body\);/);
  for (const w of EMS) assert.match(html(w), /render\(\{ error: 'unreachable' \}\)/, `${w}: a failed request no longer says unreachable`);
});

test('the three widget APIs answer no_ems_device when there is none', async () => {
  const homey = { i18n: { getLanguage: () => 'de' }, drivers: { getDriver: () => ({ getDevices: () => [] }) } };
  assert.strictEqual((await require('../widgets/ems-device/api.js').getStatus({ homey, query: { device: 'x' } })).error, 'no_ems_device');
  assert.strictEqual((await require('../widgets/ems-device/api.js').getStatus({ homey, query: {} })).error, 'no_ems_device');
  assert.strictEqual((await require('../widgets/ems-battery/api.js').getStatus({ homey })).error, 'no_ems_device');
  assert.strictEqual((await require('../widgets/ems-forecast/api.js').getForecast({ homey })).error, 'no_ems_device');
});
