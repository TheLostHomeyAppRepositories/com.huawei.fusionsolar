'use strict';

// The name a person sees for a mode, and the one place it comes from. Run: node --test
//
// From a field screenshot of 1.2.241: the three rows of the LUNA2000 "What the battery modes
// do" group rendered as empty boxes. Homey draws a setting of type "label" as a disabled
// input showing its VALUE, and 1.2.237 had put the explanation in the hint — translatable,
// but hidden behind the (i) — and left the value empty. Three headings over three empty
// boxes, reading as three settings with nothing in them.
//
// The fix fills each box with the answer to the question its heading asks. The mode names
// for that already exist, translated, as the enum titles in app.json — the same text Homey's
// own picker shows on the device tile one screen away. Reading them back from the manifest
// is what stops the box and the picker from ever disagreeing; a copy in locales/*.json would
// have been a fourth place to keep in step.

const test     = require('node:test');
const assert   = require('node:assert');
const manifest = require('../app.json');
const enumLabel = require('../lib/enum-label');

const LANGS = ['en', 'de', 'nl'];

function device(lang, withManifest = true) {
  const d = { homey: { i18n: { getLanguage: () => lang } } };
  if (withManifest) d.homey.manifest = manifest;
  return Object.assign(d, enumLabel);
}

const titleOf = (capId, id, lang) =>
  manifest.capabilities[capId].values.find((v) => String(v.id) === String(id)).title[lang];

// ── it says what the picker says ────────────────────────────────────────────

test('the label is the capability’s own title, in the user’s language', () => {
  for (const capId of ['storage_working_mode_settings', 'remote_charge_discharge_control_mode']) {
    for (const v of manifest.capabilities[capId].values) {
      for (const lang of LANGS) {
        assert.strictEqual(device(lang)._enumLabel(capId, v.id), titleOf(capId, v.id, lang),
          `${capId}/${v.id} (${lang}) does not read as the picker on the same device`);
      }
    }
  }
});

test('a number and its string spell the same mode', () => {
  const d = device('de');
  assert.strictEqual(d._enumLabel('storage_working_mode_settings', 2),
    d._enumLabel('storage_working_mode_settings', '2'));
});

test('a language the app does not carry falls back to English, not to nothing', () => {
  assert.strictEqual(device('fr')._enumLabel('storage_working_mode_settings', '2'),
    titleOf('storage_working_mode_settings', '2', 'en'));
});

// ── it never invents a name ─────────────────────────────────────────────────

test('no value means no name', () => {
  const d = device('de');
  for (const empty of [null, undefined, '']) {
    assert.strictEqual(d._enumLabel('storage_working_mode_settings', empty), null,
      `${JSON.stringify(empty)} produced a name for a mode nobody read`);
  }
});

test('a value the capability does not define says so rather than guessing', () => {
  assert.strictEqual(device('de')._enumLabel('storage_working_mode_settings', 9), 'Mode 9');
});

// With a fallback map in hand the temptation is to reach for SOMETHING in it. A mode the
// firmware reports and the app does not know is exactly when a borrowed name is worst: the
// box would calmly show "Adaptive" for a mode nobody has ever seen.
test('an unknown value does not borrow another mode’s name from the fallback map', () => {
  const MAP = { 0: 'Adaptive', 2: 'Maximise Self-Consumption' };
  assert.strictEqual(device('de')._enumLabel('storage_working_mode_settings', 9, MAP), 'Mode 9');
  assert.strictEqual(device('de', false)._enumLabel('storage_working_mode_settings', 9, MAP), 'Mode 9');
});

// ── it degrades to English rather than to nothing ───────────────────────────

test('without a manifest the caller’s own map is used', () => {
  const d = device('de', false);
  assert.strictEqual(d._enumLabel('storage_working_mode_settings', '2', { 2: 'Maximise Self-Consumption' }),
    'Maximise Self-Consumption');
});

test('an unknown capability falls back the same way', () => {
  assert.strictEqual(device('de')._enumLabel('no_such_capability', '1', { 1: 'Something' }), 'Something');
});

test('a broken i18n does not stop the lookup', () => {
  const d = Object.assign({ homey: { manifest, i18n: { getLanguage() { throw new Error('nope'); } } } }, enumLabel);
  assert.strictEqual(d._enumLabel('storage_working_mode_settings', '2'),
    titleOf('storage_working_mode_settings', '2', 'en'));
});

// ── the fallback maps must not have holes ───────────────────────────────────
//
// They are only reached when the manifest cannot answer, which is exactly when nobody is
// watching. A hole there would show "Mode 5" to a user whose inverter is perfectly normal.

test('every mode the manifest defines is also in the driver’s English fallback map', () => {
  const fs   = require('fs');
  const path = require('path');
  const PAIRS = [
    ['luna2000_modbus',      'STORAGE_WORKING_MODE_LABELS',        'storage_working_mode_settings'],
    ['luna2000_modbus',      'REMOTE_MODE_LABELS',                 'remote_charge_discharge_control_mode'],
    ['luna2000_modbus',      'EXCESS_PV_LABELS',                   'storage_excess_pv_energy_use_in_tou'],
    ['luna2000_emma_modbus', 'STORAGE_WORKING_MODE_LABELS',        'storage_working_mode_settings'],
    ['luna2000_emma_modbus', 'EXCESS_PV_LABELS',                   'storage_excess_pv_energy_use_in_tou'],
  ];

  for (const [driver, mapName, capId] of PAIRS) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', driver, 'device.js'), 'utf8');
    const at  = src.indexOf(`const ${mapName} = {`);
    assert.notStrictEqual(at, -1, `${driver}: ${mapName} is gone`);
    const block = src.slice(at, src.indexOf('};', at));
    const ids   = new Set([...block.matchAll(/'(\d+)':/g)].map((m) => m[1]));

    for (const v of manifest.capabilities[capId].values) {
      assert.ok(ids.has(String(v.id)),
        `${driver}/${mapName} has no entry for ${capId} value ${v.id} — a user would see "Mode ${v.id}"`);
    }
  }
});

// ── and no hint may contradict the box it sits under ────────────────────────
//
// 1.2.237 wrote the hints in its own words. Once the box shows the capability's own title,
// a hint quoting different wording for the same mode reads as two different things: the box
// said "Eigenverbruik maximaliseren" while the hint beside it said "Zelfconsumptie
// maximaliseren". This is the check that would have caught that.

test('no hint quotes a mode name the app spells differently elsewhere', () => {
  // Wordings that were used for a mode that the manifest names differently.
  const WRONG = {
    nl: [['Zelfconsumptie maximaliseren', 'Eigenverbruik maximaliseren'],
         ['Lokale besturing',             'Lokale sturing']],
    de: [],
    en: [],
  };

  const hints = [];
  for (const d of manifest.drivers) {
    for (const s of d.settings || []) {
      for (const c of s.children || [s]) if (c.hint) hints.push([`${d.id}/${c.id}`, c.hint]);
    }
  }
  for (const kind of ['triggers', 'conditions', 'actions']) {
    for (const c of manifest.flow[kind] || []) if (c.hint) hints.push([`${kind}/${c.id}`, c.hint]);
  }
  assert.ok(hints.length > 20, `only ${hints.length} hints found — the scan is looking in the wrong place`);

  for (const [where, hint] of hints) {
    for (const lang of LANGS) {
      if (!hint[lang]) continue;
      for (const [wrong, right] of WRONG[lang]) {
        assert.ok(!hint[lang].includes(wrong),
          `${where} (${lang}) says "${wrong}" where the app elsewhere says "${right}"`);
      }
    }
  }
});
