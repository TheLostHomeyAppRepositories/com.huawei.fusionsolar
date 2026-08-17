'use strict';

// "Copy configuration" produces text meant to be pasted into a forum thread or a bug
// report — read, in other words, by strangers. Everything in ems_config travels with it,
// including the Solcast API key. A key leaked into a support thread stays valid long after
// the thread is forgotten, so the redaction is the load-bearing part of that button and is
// tested against the real function rather than a reimplementation. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const vm     = require('vm');

const html = fs.readFileSync('settings/index.html', 'utf8');

const redact = (() => {
  const start = html.indexOf('var CONFIG_SECRET_RE =');
  assert.ok(start > 0, 'the redaction block is missing from settings/index.html');
  const fnAt = html.indexOf('function redactConfig', start);
  const open = html.indexOf('{', fnAt);
  let depth = 0, end = open;
  for (let k = open; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}' && --depth === 0) { end = k; break; }
  }
  const sandbox = { _H: { __: () => '<redacted>' } };
  vm.createContext(sandbox);
  vm.runInContext(`${html.slice(start, end + 1)}\nglobalThis.f = redactConfig;`, sandbox);
  return sandbox.f;
})();

test('the Solcast API key never leaves the page', () => {
  const out = redact({ solcast_api_key: 'abc123-secret', pv_forecast_enabled: true }, null);
  assert.strictEqual(out.solcast_api_key, '<redacted>');
  assert.strictEqual(out.pv_forecast_enabled, true, 'ordinary settings are untouched');
});

test('every name a credential is likely to hide behind is caught', () => {
  const input = {
    solcast_api_key: 'k', apiKey: 'k', homey_api_key: 'k',
    password: 'p', systemCode: 'c', username: 'u',
    access_token: 't', refreshToken: 't', client_secret: 's', credentials: 'x',
  };
  const out = redact(input, null);
  for (const k of Object.keys(input)) {
    assert.strictEqual(out[k], '<redacted>', `${k} came through in the clear`);
  }
});

test('secrets nested in arrays of devices are caught too', () => {
  // ems_config is mostly arrays of device objects; a top-level-only sweep would miss them.
  const out = redact({
    chargers: [{ id: 'c1', name: 'Easee', api_key: 'leak-me' }],
    car_devices: [{ id: 'car1', token: 'leak-me-too', battery_capacity_kwh: 77 }],
  }, null);
  assert.strictEqual(out.chargers[0].api_key, '<redacted>');
  assert.strictEqual(out.chargers[0].name, 'Easee', 'the useful part survives');
  assert.strictEqual(out.car_devices[0].token, '<redacted>');
  assert.strictEqual(out.car_devices[0].battery_capacity_kwh, 77);
});

test('an unset secret stays visibly unset', () => {
  // "" and null are not secrets, and replacing them would tell a reader the opposite of
  // the truth — that a key is configured when the missing key IS the bug being reported.
  const out = redact({ solcast_api_key: '', homey_api_key: null }, null);
  assert.strictEqual(out.solcast_api_key, '');
  assert.strictEqual(out.homey_api_key, null);
});

test('the key name decides, not the value', () => {
  // A device named "Schlüsselkasten" or a mode called "code" must not be blanked out —
  // the export is worthless if half of it reads <redacted>.
  const out = redact({ name: 'Schlüsselkasten', charge_mode: 'solar_price', notes: 'password reset done' }, null);
  assert.strictEqual(out.name, 'Schlüsselkasten');
  assert.strictEqual(out.charge_mode, 'solar_price');
  assert.strictEqual(out.notes, 'password reset done');
});

test('the export names the redaction rather than silently dropping keys', () => {
  // A missing key reads as "not configured", which sends a helper down the wrong path.
  // Replacing the value keeps the shape and still answers "is it set?".
  const out = redact({ solcast_api_key: 'k' }, null);
  assert.ok('solcast_api_key' in out, 'the key itself must survive');
});

test('the button and its warning exist in all three locales', () => {
  assert.match(html, /emsCopyConfig\(\)/, 'no button wired to the export');
  for (const lang of ['en', 'de', 'nl']) {
    const c = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8')).settings.config;
    for (const k of ['copyButton', 'copyHint', 'redacted', 'redactNote']) {
      assert.ok(c && c[k] && c[k].trim(), `${lang}: settings.config.${k} missing`);
    }
  }
});
