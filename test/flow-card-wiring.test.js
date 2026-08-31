'use strict';

// Is every flow card the app declares actually wired at both ends? Run: node --test
//
// Two halves of the same field-caught fault (app.js:65): "Every EMS trigger card carries a
// device-id argument; a card with arguments NEEDS a run listener or flows built on it never
// fire (field-caught: the dehumidifier stop flow never ran)". A card can be broken in two
// ways nothing else in this suite notices, because both are silent at runtime:
//   1. declared with an argument, but no run listener  -> Homey drops every matching flow
//   2. offered to the user in the settings page, but no code path ever fires it
// Neither shows up in `homey app validate`, and neither throws.
//
// app.js needs the `homey` runtime module, which only exists on-device; stub it (and the
// two native-ish deps pulled in by lib/) before loading the app class.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
  if (request === 'jsmodbus' || request === 'ws') return {};
  return _origLoad.call(this, request, parent, isMain);
};

const test     = require('node:test');
const assert   = require('node:assert');
const fs       = require('fs');
const path     = require('path');
const App      = require('../app.js');
const manifest = require('../app.json');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// -- what app.js registers, observed by actually running onInit --------------
// Not a source scan: the cards come from a map (app.js `emsDeviceTriggers`), so their ids
// are unquoted object keys that no regex over the file would find. Running the real onInit
// against a recording stub is the only derivation that cannot drift from the code.
function recordingApp() {
  const triggers   = new Map(); // card id -> the run listener it was given (triggers only)
  const conditions = new Map();
  const sink       = new Map();
  const app = Object.create(App.prototype);
  app.log = () => {};
  app.error = () => {};
  app._wrapLogger = () => {};   // the real one patches process.stdout for the whole process

  const card = (id, into) => {
    const c = {
      registerRunListener: (fn) => { into.set(id, fn); return c; },
      registerArgumentAutocompleteListener: () => c,
      trigger: async () => {},
    };
    return c;
  };
  app.homey = {
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    clock:      { getTimezone: () => 'UTC' },
    settings:   { get: () => null, set: () => {}, unset: () => {}, getKeys: () => [] },
    drivers:    { getDrivers: () => ({}), getDriver: () => ({ getDevices: () => [] }) },
    dashboards: { getWidget: () => ({ registerSettingAutocompleteListener: () => {} }) },
    i18n:       { getLanguage: () => 'en' },
    flow: {
      getTriggerCard:       (id) => card(id, triggers),
      getDeviceTriggerCard: (id) => card(id, sink),
      getConditionCard:     (id) => card(id, conditions),
      getActionCard:        (id) => card(id, sink),
    },
  };
  return { app, triggers, conditions };
}

// A driver's own device.js registers a few status-changed cards. Those files cannot be
// require()d (they need `homey`), so that half is read rather than run.
function registeredByDrivers() {
  const found = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        const re = /get(?:Device)?TriggerCard\('([a-z0-9_]+)'\)[\s\S]{0,80}?registerRunListener/g;
        for (const m of s.matchAll(re)) found.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, 'drivers'));
  return found;
}

// Where a trigger is FIRED. The EMS runtime only -- deliberately not api.js, whose
// postEmsTestTrigger fires whatever cardId the settings page hands it (api.js:2019) and
// would therefore "prove" every card in the manifest, and deliberately not app.js, which
// registers rather than fires.
function firedBySource() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'drivers'));
  walk(path.join(ROOT, 'lib'));

  const fired = new Set();
  const ids   = (manifest.flow.triggers || []).map((t) => t.id);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const id of ids) if (new RegExp('[\'"`]' + id + '[\'"`]').test(s)) fired.add(id);
  }
  return fired;
}

// -- 1. a card with an argument needs a run listener -------------------------
// A `device`-typed argument is Homey's own device picker and is matched for us; every
// other argument is matched by the run listener, and without one the card matches nothing.
test('every trigger card with an argument of its own has a run listener', async () => {
  const { app, triggers } = recordingApp();
  await app.onInit();
  const wired = new Set([...triggers.keys(), ...registeredByDrivers()]);

  const needsOne = (manifest.flow.triggers || [])
    .filter((t) => (t.args || []).some((a) => a.type !== 'device'))
    .map((t) => t.id);

  const missing = needsOne.filter((id) => !wired.has(id));
  assert.deepStrictEqual(missing, [],
    'these trigger cards declare an argument but nothing matches it, so every flow built on '
    + 'them is silently dropped:\n  ' + missing.join('\n  '));
});

// The registration must also name a card that exists -- a typo'd id registers a listener
// on nothing and reads exactly like a working one.
test('every run listener app.js registers names a card the manifest declares', async () => {
  const { app, triggers, conditions } = recordingApp();
  await app.onInit();
  const trg = new Set((manifest.flow.triggers   || []).map((t) => t.id));
  const cnd = new Set((manifest.flow.conditions || []).map((c) => c.id));
  for (const id of triggers.keys())   assert.ok(trg.has(id), id + ': no such trigger card');
  for (const id of conditions.keys()) assert.ok(cnd.has(id), id + ': no such condition card');
});

// -- 2. a card the settings page builds flows on must be honest about itself --
// The battery and inverter rows in settings/index.html create a real Homey flow for the
// user, whose "when" is this trigger. Two kinds are legitimate, and the difference has to
// be visible IN THE MANIFEST, because the manifest hint is the only text Homey shows next
// to the card in its own flow editor:
//   - the EMS fires it   -> a working trigger; its hint must not call itself a placeholder
//   - nothing fires it   -> a scaffold whose WHEN the user replaces; it MUST say so
// A row that is neither is the fault this file exists for: a flow that looks configured
// and can never run. That is how ems_battery_force_charge went unnoticed from 1.2.38 --
// fired by the EMS, yet still described in app.json as a placeholder to be replaced.
function offeredBySettings() {
  const html = read('settings/index.html');
  return [...new Set([...html.matchAll(/triggerId: *'([a-z0-9_]+)'/g)].map((m) => m[1]))];
}
const hintOf = (id) => {
  const c = (manifest.flow.triggers || []).find((t) => t.id === id);
  return (c && c.hint && c.hint.en) || '';
};
const callsItselfAPlaceholder = (id) => /placeholder/i.test(hintOf(id));

test('every trigger the settings page builds a flow on is either fired or declared a placeholder', () => {
  const offered = offeredBySettings();
  assert.ok(offered.length >= 10, 'the generated-flow rows moved -- this test found almost none');

  const fired = firedBySource();
  const mute  = offered.filter((id) => !fired.has(id) && !callsItselfAPlaceholder(id));
  assert.deepStrictEqual(mute, [],
    'the settings page offers to build a flow on these cards, nothing fires them, and their '
    + 'hint does not warn the user to replace the trigger -- so the flow it creates looks '
    + 'configured and can never run:\n  ' + mute.join('\n  '));
});

test('a trigger the EMS actually fires does not describe itself as a placeholder', () => {
  const fired = firedBySource();
  const lying = offeredBySettings()
    .filter((id) => fired.has(id) && callsItselfAPlaceholder(id));
  assert.deepStrictEqual(lying, [],
    'the EMS fires these, but their hint still tells the user to replace the trigger -- '
    + 'follow that advice and the EMS loses its grip on the flow:\n  ' + lying.join('\n  '));
});

test('every trigger the settings page names is declared in the manifest', () => {
  const declared = new Set((manifest.flow.triggers || []).map((t) => t.id));
  for (const id of offeredBySettings()) {
    assert.ok(declared.has(id), id + ': the page names a card app.json does not declare');
  }
});

// -- 3. a listener that is registered must actually compare something --------
// The listeners come from a map of card id -> argument name (app.js `emsDeviceTriggers`).
// Get that name wrong and the comparison is `undefined === undefined`: the card is wired,
// Homey is happy, and every flow fires for every device. That is not a missing listener,
// so test 1 above cannot see it -- but calling the listener can. Each one is handed the
// argument names the manifest declares for its own card.
test('each registered listener compares the arguments its card actually declares', async () => {
  const { app, triggers } = recordingApp();
  await app.onInit();

  let checked = 0;
  for (const t of manifest.flow.triggers || []) {
    const own = (t.args || []).filter((a) => a.type !== 'device');
    const fn  = triggers.get(t.id);
    if (!own.length || !fn) continue; // no listener is test 1's business, not this one

    const mine = {};
    for (const a of own) mine[a.name] = 'value-of-' + a.name;
    assert.strictEqual(await fn(mine, mine), true,
      t.id + ': the listener rejects a flow whose arguments are exactly the fired state');

    // The first argument is the device id on every one of these cards.
    const other = Object.assign({}, mine, { [own[0].name]: 'some-other-device' });
    assert.strictEqual(await fn(other, mine), false,
      t.id + ': ' + own[0].name + ' is not compared, so this card fires every flow for every device');
    checked++;
  }
  assert.ok(checked >= 15, 'only ' + checked + ' listeners were exercised -- the wiring moved');
});
