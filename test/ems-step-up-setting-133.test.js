'use strict';

// Battery full: one setting with the battery, not two per charger (1.3.3).
//
// 1.3.1–1.3.2 asked for the "full" level and the level to fall back below at every EV
// charger. Andi, 2026-10-15: the level belongs to the battery. The surplus split beside it
// already says "from charge level X % the devices get Y %", and a second charger should not
// need it entered again. So: Home batteries → surplus split, one line:
//   "From charge level [97] % the EV charger may charge one step higher".
// The fall-back level is 4 points lower, 0 switches it off, and the line only shows once an
// EV charger is configured.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const { BAT_FULL_ON_PCT, BAT_FULL_GAP_PCT, BAT_FULL_OFF_PCT } = require('../lib/ems/constants');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('settings', 'index.html');
const DEV  = read('drivers', 'energy_management', 'device.js');

function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} is not in the page`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('the defaults: from 97 %, back below 93 %', () => {
  assert.strictEqual(BAT_FULL_ON_PCT, 97);
  assert.strictEqual(BAT_FULL_GAP_PCT, 4);
  assert.strictEqual(BAT_FULL_OFF_PCT, 93);
});

// The derivation in _getChargers, run.
function levels(evStepUpSoc) {
  const ctx = { BAT_FULL_ON_PCT, BAT_FULL_GAP_PCT, cfg: { ev_step_up_soc: evStepUpSoc } };
  vm.createContext(ctx);
  vm.runInContext([
    DEV.match(/const pctOrUndef = [^\n]*/)[0],
    DEV.match(/const stepUpSoc = pctOrUndef\(cfg\.ev_step_up_soc\);/)[0],
    DEV.match(/const batFullOnPct = [^\n]*/)[0],
    'var out = { batFullTopUp: batFullOnPct > 0, batFullOnPct, batFullOffPct: Math.max(0, batFullOnPct - BAT_FULL_GAP_PCT) };',
  ].join('\n'), ctx);
  return { ...ctx.out };
}

test('every charger gets the battery\'s level, the fall-back 4 points lower', () => {
  assert.deepStrictEqual(levels(undefined), { batFullTopUp: true, batFullOnPct: 97, batFullOffPct: 93 }, 'unset is the default');
  assert.deepStrictEqual(levels(''), { batFullTopUp: true, batFullOnPct: 97, batFullOffPct: 93 }, 'an empty field is not 0');
  assert.deepStrictEqual(levels(90), { batFullTopUp: true, batFullOnPct: 90, batFullOffPct: 86 });
  assert.deepStrictEqual(levels(0), { batFullTopUp: false, batFullOnPct: 0, batFullOffPct: 0 }, '0 switches it off');
  // The charger object carries exactly that, for every charger alike.
  assert.match(DEV, /batFullTopUp:  batFullOnPct > 0,\n\s*batFullOnPct,\n\s*batFullOffPct: Math\.max\(0, batFullOnPct - BAT_FULL_GAP_PCT\),/);
  assert.doesNotMatch(DEV, /full_battery_on_pct|full_battery_off_pct|full_battery_topup/, 'the per-charger keys are gone');
});

test('validation keeps the level at 0 or from 50 %', () => {
  assert.match(DEV, /clamp\(cfg, 'ev_step_up_soc', 0, 100\);/);
  assert.match(DEV, /if \(Number\(cfg\.ev_step_up_soc\) > 0 && Number\(cfg\.ev_step_up_soc\) < 50\) \{[\s\S]{0,80}cfg\.ev_step_up_soc = 50;/);
});

test('the settings page: one line under the surplus split, saved and loaded with it', () => {
  // Under the ramp's hint, before the announcement note, inside the surplus-split box.
  const ramp = PAGE.indexOf('data-i18n="homeBatteries.shareRamp.hint"');
  const row  = PAGE.indexOf('id="ems-ev-step-up-row"');
  const note = PAGE.indexOf('id="ems-battery-announce-note"');
  assert.ok(ramp > 0 && ramp < row && row < note, 'the line sits with the surplus split');
  assert.match(PAGE, /<div id="ems-ev-step-up-row" style="display:none;/, 'hidden until a charger is there');
  assert.match(PAGE, /<input id="ems-ev-step-up-soc" type="number" value="97" min="0" max="100"/);
  assert.match(PAGE, /ev_step_up_soc:\s+\(function\(\) \{\n\s+var v = parseInt\(document\.getElementById\('ems-ev-step-up-soc'\)\.value, 10\);\n\s+return \(isFinite\(v\) && v >= 0 && v <= 100\) \? v : 97;/);
  assert.match(PAGE, /document\.getElementById\('ems-ev-step-up-soc'\)\.value = \(cfg\.ev_step_up_soc !== undefined && cfg\.ev_step_up_soc !== null && cfg\.ev_step_up_soc !== ''\) \? cfg\.ev_step_up_soc : 97;/);
  // The per-charger row of 1.3.1–1.3.2 is gone.
  assert.doesNotMatch(PAGE, /ems-charger-fulltopup|ems-charger-fullon|ems-charger-fulloff|fullRow/);
});

// emsSyncEvStepUp as the page has it, over a stubbed charger list.
function visible(selectValues) {
  const row = { style: { display: 'none' } };
  const ctx = {
    document: {
      getElementById: (id) => (id === 'ems-ev-step-up-row' ? row : null),
      querySelectorAll: (q) => (q === '#ems-charger-list .ems-row-device' ? selectValues.map((value) => ({ value })) : []),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource(PAGE, 'emsSyncEvStepUp') + '\nemsSyncEvStepUp();', ctx);
  return row.style.display !== 'none';
}

test('the line shows only with an EV charger configured', () => {
  assert.strictEqual(visible([]), false, 'no charger row');
  assert.strictEqual(visible(['']), false, 'the empty row the page adds when there is none');
  assert.strictEqual(visible(['', 'easee-1']), true);
  assert.strictEqual(visible(['easee-1']), true);
});

test('the display follows the list: added, chosen, removed, devices reloaded', () => {
  // Called at the end of each place the charger list changes.
  const add = fnSource(PAGE, 'emsAddChargerRow');
  assert.match(add, /emsRenderChargerFlows\(flowSection, sel\.value, entry, \{\}\);\n\s+emsSyncEvStepUp\(\);\n\s+\}\);/, 'when a device is chosen');
  assert.match(add, /\n      emsSyncEvStepUp\(\);\n    \}$/, 'when a row is added');
  assert.match(fnSource(PAGE, 'emsRenumberChargers'), /emsSyncEvStepUp\(\);/, 'when a row is removed');
  assert.match(fnSource(PAGE, 'emsRefreshAllSelects'), /emsSyncEvStepUp\(\);/, 'when the device list is reloaded');
});

test('the texts are with the battery, in three languages', () => {
  for (const l of ['en', 'de', 'nl']) {
    const s = require(`../locales/${l}.json`).settings;
    for (const k of ['evStepUpFrom', 'evStepUp', 'evStepUpHint']) assert.ok(s.homeBatteries.shareRamp[k], `${l}: ${k}`);
    for (const k of ['fullBattery', 'fullBatteryOn', 'fullBatteryOff', 'fullBatteryHint']) {
      assert.strictEqual(s.chargers[k], undefined, `${l}: chargers.${k} is still there`);
    }
    assert.match(s.homeBatteries.shareRamp.evStepUpHint, /4140/);
    assert.doesNotMatch(s.homeBatteries.shareRamp.evStepUpHint, /Home Assistant/);
  }
  assert.strictEqual(require('../locales/de.json').settings.homeBatteries.shareRamp.evStepUp, 'darf der EV-Lader eine Stufe höher laden');
});
