'use strict';

// Two capabilities fewer on the Easee. Run: node --test
//
// Andi, 2026-10-16, asked which capabilities the Easee driver should lose, then: "1 und 2
// entfernen".
//   1. release_charger — ChangeAvailability → Operative, a maintenance action. The app sends
//      it on every connection, and a pause at 0 A never leaves an Easee
//      unavailable. The shared flow card stays.
//   2. charging_profile — "11.0 kW / 16A / 3P", the target power and current once more; the
//      phase count of an Easee is fixed.
// A device paired before loses both on its next start; the Smart Charger (OCPP) keeps them.

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT  = path.join(__dirname, '..');
const APP   = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const SRC   = fs.readFileSync(path.join(ROOT, 'drivers', 'easee_ocpp', 'device.js'), 'utf8').replace(/\r\n/g, '\n');
const Easee = require('../drivers/easee_ocpp/device.js');
const GONE  = ['release_charger', 'charging_profile'];
const list  = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  assert.ok(m, `${name} is gone`);
  return [...m[1].matchAll(/^\s*'([^']+)',/gm)].map((x) => x[1]);
};

test('the Easee driver declares neither, the Smart Charger (OCPP) keeps both', () => {
  const easee  = APP.drivers.find((d) => d.id === 'easee_ocpp');
  const huawei = APP.drivers.find((d) => d.id === 'smartcharger_ocpp');
  for (const cap of GONE) {
    assert.ok(!easee.capabilities.includes(cap), `${cap} is still declared`);
    assert.ok(!(cap in easee.capabilitiesOptions), `${cap} still has options`);
    assert.ok(huawei.capabilities.includes(cap), `${cap} went from the other driver too`);
  }
});

test('a device paired before loses both on its next start, and does not get them back', () => {
  const remove = list('REMOVE_CAPABILITIES');
  const required = list('REQUIRED_CAPABILITIES');
  for (const cap of GONE) {
    assert.ok(remove.includes(cap), `${cap} stays on a paired device`);
    assert.ok(!required.includes(cap), `${cap} is added back on every start`);
  }
});

test('the remove list runs before the required list is ensured', () => {
  const init = SRC.slice(SRC.indexOf('  async onInit() {'));
  assert.ok(init.indexOf('for (const cap of REMOVE_CAPABILITIES)') < init.indexOf('await this._ensureCapabilities();'));
});

test('the release still works from the flow card, and the slider still shows the limit', async () => {
  assert.strictEqual(typeof Easee.prototype.releaseCharger, 'function', 'the flow card calls it');
  assert.doesNotMatch(SRC, /registerCapabilityListener\('release_charger'/);
  const d = Object.create(Easee.prototype);
  const caps = {};
  d._set = async (c, v) => { caps[c] = v; };
  d.getSetting = (k) => ({ default_charging_amps: '10', number_of_phases: '3' })[k];
  d._txnAmps = 13;
  await d._updateChargingProfile();
  assert.deepStrictEqual(caps, { target_current: 13 });
});
