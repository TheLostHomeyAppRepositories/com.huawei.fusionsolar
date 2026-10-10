'use strict';

// The off-peak texts on the settings page (1.2.326). Three places said the off-peak window is
// switched on with the tile toggle — but a charger in "Solar & off-peak window" mode uses the
// window regardless; the toggle only adds it for chargers left in "Solar only"
// (lib/ems/chargerControl.js). Found in the README review of 2026-10-10.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const APP  = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const LANGS = ['en', 'de', 'nl'];
const loc = (l) => JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${l}.json`), 'utf8')).settings;

test('the code: "Solar & off-peak window" uses the window regardless of the tile toggle', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ems', 'chargerControl.js'), 'utf8');
  assert.match(src, /c\.chargeMode === 'solar_offpeak' \|\| \(c\.chargeMode === 'solar' && this\.getCapabilityValue\('offpeak_enabled'\) === true\)/,
    'the rule these texts describe has changed — check them again');
});

for (const l of LANGS) {
  test(`${l}: the texts say which charger needs the toggle and which does not`, () => {
    const s = loc(l);
    const offpeakMode = s.chargers.mode.solarOffpeak;
    const solarMode   = s.chargers.mode.solar;
    const toggle      = APP.capabilities.offpeak_enabled.title[l];

    const hint = s.chargers.modeHint.solarOffpeak;
    assert.doesNotMatch(hint, /enabled via|aktiviert über|in te schakelen via/i, 'the mode hint still sends the reader to the toggle');
    assert.ok(hint.includes(toggle), `the mode hint names the toggle as "${toggle}", the word on the tile`);

    const toggleHint = s.evChargers.offpeak.toggleHint;
    assert.ok(toggleHint.includes(offpeakMode) && toggleHint.includes(solarMode), 'the section hint names both modes');
    assert.ok(toggleHint.includes(toggle));

    const tip = s.emsInfo.offpeakTip;
    assert.ok(tip.includes(offpeakMode) && tip.includes(solarMode), 'the tip names both modes');
  });
}

test('the inline English fallbacks on the settings page match en.json', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');
  const en = loc('en');
  assert.ok(html.includes(en.evChargers.offpeak.toggleHint));
  assert.ok(html.includes(en.emsInfo.offpeakTip));
});
