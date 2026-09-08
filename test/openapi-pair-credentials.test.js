'use strict';

// Unit tests for the credentials an OpenAPI pairing dialog opens with. Run: node --test
//
// One FusionSolar account serves all seven OpenAPI drivers. Before this, each pairing
// dialog started empty, so adding the inverter, the battery, the power sensor and the four
// iSitePower devices meant typing the same machine-generated system code seven times.
//
// Two sources, settings first, and the dialog says which one it used. What is tested here
// is mostly the negative space: that nothing is written, that a source with nothing to say
// does not overwrite the page's own defaults with blanks, and that the driver list does not
// fall behind the drivers that exist — which is the bug this replaces.

const Module = require('module');
const _origLoad = Module._load;

// The drivers need `homey` for their base class only; nothing under test touches it.
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Driver: class {}, Device: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const {
  openapiCredentials, fromSettings, fromPairedDevice, OPENAPI_DRIVER_IDS, SETTINGS_KEY,
} = require('../lib/openapi-credentials.js');

const ROOT = path.join(__dirname, '..');

// A Homey stand-in: `settings` is a plain map, `drivers` a map of driver id → devices.
// A driver that is not in the map throws from getDriver, exactly as Homey does for a driver
// this install has never had.
function makeHomey({ settings = {}, drivers = {} } = {}) {
  return {
    settings: {
      get: (k) => (k in settings ? settings[k] : null),
      set: (k, v) => { settings[k] = v; },
      unset: (k) => { delete settings[k]; },
    },
    drivers: {
      getDriver: (id) => {
        if (!(id in drivers)) throw new Error(`Invalid Driver: ${id}`);
        return { getDevices: () => drivers[id] };
      },
    },
    _settings: settings,
  };
}

const device = (s) => ({ getSettings: () => s });

const FULL = {
  base_url: 'https://eu5.fusionsolar.huawei.com',
  username: 'wirz_OpenAPI',
  system_code: 'Sy5tem-C0de',
  station_code: 'NE=1234567',
};

// ── what app settings hold ───────────────────────────────────────────────────

test('fromSettings — the saved credentials come back, labelled as saved', () => {
  const homey = makeHomey({ settings: { [SETTINGS_KEY]: {
    baseUrl: 'https://intl.fusionsolar.huawei.com', username: 'u', systemCode: 'c',
  } } });
  assert.deepStrictEqual(fromSettings(homey), {
    source: 'settings',
    baseUrl: 'https://intl.fusionsolar.huawei.com',
    username: 'u',
    systemCode: 'c',
    stationCode: '',
  });
});

test('fromSettings — half an entry is not an answer', () => {
  for (const saved of [null, undefined, {}, { username: 'u' }, { systemCode: 'c' },
    { username: '', systemCode: 'c' }, { username: 'u', systemCode: '' }]) {
    assert.strictEqual(fromSettings(makeHomey({ settings: { [SETTINGS_KEY]: saved } })), null,
      `${JSON.stringify(saved)} was accepted`);
  }
});

test('fromSettings — a settings store that throws is a source with nothing to say', () => {
  const homey = { settings: { get: () => { throw new Error('not ready'); } } };
  assert.strictEqual(fromSettings(homey), null);
});

// ── what a paired device holds ───────────────────────────────────────────────

test('fromPairedDevice — an already paired device supplies what it polls with', () => {
  const homey = makeHomey({ drivers: { sun2000_openapi_fusionsolar: [device(FULL)] } });
  assert.deepStrictEqual(fromPairedDevice(homey), {
    source: 'device',
    baseUrl: FULL.base_url,
    username: FULL.username,
    systemCode: FULL.system_code,
    stationCode: FULL.station_code,
  });
});

// The bug this replaces: the list named three of the seven drivers, so an account whose
// only devices were iSitePower ones was told nothing could be found.
test('fromPairedDevice — every OpenAPI driver is looked at, not just the first few', () => {
  for (const id of OPENAPI_DRIVER_IDS) {
    const homey = makeHomey({ drivers: { [id]: [device(FULL)] } });
    const found = fromPairedDevice(homey);
    assert.ok(found, `${id} was not searched`);
    assert.strictEqual(found.username, FULL.username);
  }
});

// Both halves have to be there. A device carrying a username but no system code would
// otherwise prefill the dialog with a name and an empty password, and say it came from a
// device — which is worse than an empty form, because it looks like it worked.
test('fromPairedDevice — a device that was never signed in is skipped, not returned', () => {
  // The incomplete ones sit on the driver that is searched first, so a check that accepts
  // half an entry would return one of them rather than falling through to the good device.
  const homey = makeHomey({ drivers: {
    sun2000_openapi_fusionsolar: [
      device({ base_url: 'https://eu5.fusionsolar.huawei.com' }),
      device({ username: 'half', system_code: '' }),
      device({ system_code: 'orphan' }),
    ],
    luna2000_openapi_fusionsolar: [device(FULL)],
  } });
  assert.strictEqual(fromPairedDevice(homey).username, FULL.username);
});

test('fromPairedDevice — an install with no OpenAPI devices at all answers nothing', () => {
  assert.strictEqual(fromPairedDevice(makeHomey()), null);
  assert.strictEqual(fromPairedDevice(makeHomey({
    drivers: { sun2000_openapi_fusionsolar: [] },
  })), null);
});

test('fromPairedDevice — a device whose settings throw does not stop the search', () => {
  const homey = makeHomey({ drivers: {
    sun2000_openapi_fusionsolar: [{ getSettings: () => { throw new Error('gone'); } }],
    powermeter_openapi_fusionsolar: [device(FULL)],
  } });
  assert.strictEqual(fromPairedDevice(homey).username, FULL.username);
});

// ── the two together ─────────────────────────────────────────────────────────

test('openapiCredentials — what was saved wins over what is paired', () => {
  const homey = makeHomey({
    settings: { [SETTINGS_KEY]: { baseUrl: '', username: 'saved', systemCode: 'sc' } },
    drivers:  { sun2000_openapi_fusionsolar: [device(FULL)] },
  });
  const c = openapiCredentials(homey);
  assert.strictEqual(c.source, 'settings');
  assert.strictEqual(c.username, 'saved');
});

test('openapiCredentials — with nothing saved it falls back to a paired device', () => {
  const homey = makeHomey({ drivers: { isitepower_home_openapi_fusionsolar: [device(FULL)] } });
  assert.strictEqual(openapiCredentials(homey).source, 'device');
});

// The dialogs differ in which server they default to — eu5 for the SUN2000 family, intl for
// iSitePower — so an empty answer has to be recognisable as empty rather than arrive as a
// blank URL that overwrites the page's own default.
test('openapiCredentials — knowing nothing is said plainly, with no values attached', () => {
  const c = openapiCredentials(makeHomey());
  assert.strictEqual(c.source, 'none');
  assert.deepStrictEqual(
    [c.baseUrl, c.username, c.systemCode, c.stationCode], ['', '', '', '']);
});

test('openapiCredentials — reading credentials never writes any', () => {
  const settings = {};
  const homey = makeHomey({ settings, drivers: { sun2000_openapi_fusionsolar: [device(FULL)] } });
  openapiCredentials(homey);
  assert.deepStrictEqual(settings, {}, 'pairing quietly widened where the system code is kept');
});

// ── the list against the app ─────────────────────────────────────────────────

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

test('the driver list is every OpenAPI driver the app declares', () => {
  const declared = app.drivers
    .map((d) => d.id)
    .filter((id) => id.endsWith('_openapi_fusionsolar'))
    .sort();
  assert.deepStrictEqual([...OPENAPI_DRIVER_IDS].sort(), declared);
});

// ── the drivers ──────────────────────────────────────────────────────────────

test('every OpenAPI driver answers the pairing dialog asking what is known', async () => {
  for (const id of OPENAPI_DRIVER_IDS) {
    const DriverClass = require(path.join(ROOT, 'drivers', id, 'driver.js'));
    const d = Object.create(DriverClass.prototype);
    d.log = () => {};
    d.homey = makeHomey({ drivers: { [id]: [device(FULL)] } });

    const handlers = {};
    await d.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });

    assert.ok(handlers.credentials, `${id} registers no credentials handler`);
    const c = await handlers.credentials();
    assert.strictEqual(c.username, FULL.username, `${id} returned the wrong credentials`);
    // The handler it has always had must still be there.
    assert.ok(handlers.login, `${id} lost its login handler`);
  }
});

// ── the settings tab's own button ───────────────────────────────────────────

const api = require('../api.js');

test('GET /debug/openapi-credentials finds an iSitePower device too', async () => {
  const homey = makeHomey({ drivers: { isitepower_solar_openapi_fusionsolar: [device(FULL)] } });
  const res = await api.getOpenapiCredentials({ homey });
  assert.strictEqual(res.username, FULL.username);
  assert.strictEqual(res.stationCode, FULL.station_code);
});

// The tab has two buttons and they must not become the same button: this one says
// "Pre-fill from device", and its answer has to be what a device is actually polling with.
test('GET /debug/openapi-credentials does not answer from the saved credentials', async () => {
  const homey = makeHomey({
    settings: { [SETTINGS_KEY]: { baseUrl: '', username: 'saved', systemCode: 'sc' } },
  });
  const res = await api.getOpenapiCredentials({ homey });
  assert.strictEqual(res.username, '', 'the saved entry was passed off as a device');
});

// ── the pairing pages ────────────────────────────────────────────────────────

const PAGES = OPENAPI_DRIVER_IDS.map((id) => [id,
  fs.readFileSync(path.join(ROOT, 'drivers', id, 'pair', 'start.html'), 'utf8')]);

test('every pairing page asks, and none of them signs in by itself', () => {
  for (const [id, html] of PAGES) {
    assert.ok(html.includes("Homey.emit('credentials'"), `${id} never asks`);
    // A login on open would spend one of the five the API allows per ten minutes, without
    // anybody having asked for it.
    assert.ok(!/\bdoLogin\(\s*\)\s*;/.test(html.replace(/onclick="doLogin\(\)"/g, '')),
      `${id} signs in on its own`);
  }
});

test('a page prefilled with a regional server shows that region, not "Other"', () => {
  for (const [id, html] of PAGES) {
    assert.ok(html.includes('function syncServerSelect()'), `${id} cannot resync its picker`);
    const prefill = html.slice(html.indexOf('async function prefill()'));
    assert.ok(/if \(c\.baseUrl\) \{[\s\S]{0,200}syncServerSelect\(\);/.test(prefill),
      `${id} writes a URL without moving the picker to it`);
  }
});

test('a page says where a filled-in system code came from, in both languages', () => {
  for (const [id, html] of PAGES) {
    for (const key of ['prefillSaved', 'prefillDevice']) {
      assert.strictEqual((html.match(new RegExp(`${key}:`, 'g')) || []).length, 2,
        `${id} is missing ${key} in one of the two languages`);
    }
    assert.ok(html.includes("c.source === 'settings' ? t.prefillSaved : t.prefillDevice"),
      `${id} does not distinguish the two sources`);
    // Nothing known means nothing said: no notice, and no blanks written over the page's
    // own defaults.
    assert.ok(html.includes('if (!c || !c.username) return;'),
      `${id} acts on an answer that has no credentials in it`);
  }
});
