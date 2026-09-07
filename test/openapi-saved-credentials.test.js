'use strict';

// Remembering the OpenAPI diagnostic's credentials. Run: node --test
//
// The Fetch All page asked for the server, username and system code on every visit. There
// was a "Pre-fill from device" button, but that only helps once a device is paired — and
// the diagnostic is most needed by people whose pairing has not worked yet, or who are
// checking what the API returns before pairing anything at all.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');
const api  = require(path.join(ROOT, 'api.js'));
const APP  = require(path.join(ROOT, 'app.json'));

const KEY = 'openapi_debug_credentials';

function fakeHomey(initial = {}) {
  const store = { ...initial };
  return {
    store,
    settings: {
      get:   (k) => (k in store ? store[k] : null),
      set:   (k, v) => { store[k] = v; },
      unset: (k) => { delete store[k]; },
    },
  };
}

test('nothing stored yields empty fields, not nulls the page would print', async () => {
  const homey = fakeHomey();
  assert.deepStrictEqual(await api.getOpenapiSaved({ homey }),
    { baseUrl: '', username: '', systemCode: '' });
});

test('what was saved comes back', async () => {
  const homey = fakeHomey();
  await api.putOpenapiSaved({ homey, body: {
    baseUrl: 'https://eu5.fusionsolar.huawei.com', username: 'wirz_OpenAPI', systemCode: 'secret',
  } });
  assert.deepStrictEqual(await api.getOpenapiSaved({ homey }), {
    baseUrl: 'https://eu5.fusionsolar.huawei.com', username: 'wirz_OpenAPI', systemCode: 'secret',
  });
});

test('surrounding whitespace is trimmed, since it is pasted by hand', async () => {
  const homey = fakeHomey();
  await api.putOpenapiSaved({ homey, body: {
    baseUrl: '  https://eu5.fusionsolar.huawei.com  ', username: ' u ', systemCode: ' c ',
  } });
  assert.deepStrictEqual(homey.store[KEY], {
    baseUrl: 'https://eu5.fusionsolar.huawei.com', username: 'u', systemCode: 'c',
  });
});

// Emptying both fields and pressing Save is how a user takes them off the Homey again.
// Storing two empty strings instead would leave the key behind and read, from the outside,
// exactly like credentials that are still there.
test('saving with both fields empty removes the entry rather than blanking it', async () => {
  const homey = fakeHomey({ [KEY]: { baseUrl: 'x', username: 'u', systemCode: 'c' } });
  const res = await api.putOpenapiSaved({ homey, body: { baseUrl: 'x', username: '', systemCode: '' } });
  assert.strictEqual(res.saved, false, 'the page cannot tell "cleared" from "saved"');
  assert.ok(!(KEY in homey.store), 'the key was left behind holding empty strings');
});

// Only *both* empty means "forget these". Clearing the password field alone is what someone
// does before retyping it, and treating that as a clear would take the username with it —
// so a half-filled form saves what it has.
test('a half-filled form is saved, not treated as a clear', async () => {
  const onlyUser = fakeHomey({ [KEY]: { baseUrl: 'x', username: 'old', systemCode: 'old' } });
  const a = await api.putOpenapiSaved({ homey: onlyUser, body: { baseUrl: 'x', username: 'u', systemCode: '' } });
  assert.strictEqual(a.saved, true, 'blanking the password field threw the username away too');
  assert.strictEqual(onlyUser.store[KEY].username, 'u');
  assert.strictEqual(onlyUser.store[KEY].systemCode, '');

  const onlyCode = fakeHomey();
  const b = await api.putOpenapiSaved({ homey: onlyCode, body: { baseUrl: 'x', username: '', systemCode: 'c' } });
  assert.strictEqual(b.saved, true);
  assert.strictEqual(onlyCode.store[KEY].systemCode, 'c');
});

test('a missing body does not throw', async () => {
  const homey = fakeHomey();
  assert.strictEqual((await api.putOpenapiSaved({ homey })).saved, false);
});

// ── The wiring, which is where this kind of change actually breaks ───────────

test('both routes exist and point at handlers api.js exports', () => {
  for (const [name, method] of [['getOpenapiSaved', 'GET'], ['putOpenapiSaved', 'PUT']]) {
    const route = APP.api[name];
    assert.ok(route, `${name} has no route in app.json, so the page gets a 404`);
    assert.strictEqual(route.method, method);
    assert.strictEqual(route.path, '/debug/openapi-saved');
    assert.strictEqual(typeof api[name], 'function');
  }
});

// The general form of the same mistake: a route with no handler 404s, and a handler with no
// route is unreachable. Neither shows up until someone presses the button.
test('every declared route has a handler, and every handler a route', () => {
  const routed   = Object.keys(APP.api || {});
  const exported = Object.keys(api).filter((k) => typeof api[k] === 'function');
  const missing  = routed.filter((k) => !exported.includes(k));
  const orphaned = exported.filter((k) => !routed.includes(k));
  assert.deepStrictEqual(missing, [], 'routes in app.json with no handler in api.js');
  assert.deepStrictEqual(orphaned, [], 'handlers in api.js that no route reaches');
});

test('the page offers a Save button and loads what was saved when the tab opens', () => {
  const src = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');
  assert.match(src, /id="oa-save-btn" onclick="saveOpenApi\(\)"/,
    'the button is gone, so nothing can be saved from the page');
  assert.match(src, /_H\.api\('PUT', '\/debug\/openapi-saved'/,
    'Save no longer sends anything, or sends it somewhere else');
  assert.match(src, /_H\.api\('GET', '\/debug\/openapi-saved'/);
  assert.match(src, /if \(name === 'openapi'\) \{\s*\n\s*loadSavedOpenApi\(\);/,
    'the fields are not filled when the tab opens, so saved credentials look lost');
  assert.match(src, /if \(_oaLoadedSaved\) return;/,
    'the credentials are re-fetched on every tab switch, overwriting what is being typed');
});

test('the new strings exist in all three languages', () => {
  const keys = ['saveCredentials', 'savedCredentials', 'clearedCredentials', 'saveFailed', 'loadedSaved'];
  for (const lang of ['en', 'de', 'nl']) {
    const oa = require(path.join(ROOT, 'locales', `${lang}.json`)).settings.openapi;
    for (const k of keys) {
      assert.strictEqual(typeof oa[k], 'string', `${lang}.json is missing settings.openapi.${k}`);
      assert.ok(oa[k].length > 0, `${lang}.json has an empty settings.openapi.${k}`);
    }
  }
});

// The system code is a password. It is stored in the same place a paired device already
// stores it, which is the point — but nothing else may hand it out, and no diagnostic
// export may sweep it up on its way past.
test('the stored credentials are read by nothing but their own endpoint', () => {
  const files = ['api.js', 'app.js', path.join('lib', 'openapi-coordinator.js'), path.join('lib', 'openapi-client.js')];
  let hits = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    hits += (src.match(new RegExp(KEY, 'g')) || []).length;
  }
  assert.strictEqual(hits, 3,
    `"${KEY}" is referenced ${hits} times; it should be the one get, the one set and the one `
    + 'unset in api.js and nowhere else');

  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  assert.doesNotMatch(src, new RegExp(`log\\([^)]*${KEY}`),
    'the stored credentials are written to the log');
});
