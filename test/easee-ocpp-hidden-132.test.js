'use strict';

// The Easee driver is hidden from pairing. Run: node --test
//
// Andi, 2026-10-16: "Setze den Driver auf deprecated: true damit niemand ihn sieht" — until it
// has been tested on a charger. Homey then leaves it out of "Add device"; a device already
// paired keeps working, so nothing else may change with it: the flow cards still take it,
// the widgets still find it, and the other drivers stay listed.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const APP  = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the Easee driver is deprecated, and only that one', () => {
  assert.strictEqual(APP.drivers.find((d) => d.id === 'easee_ocpp').deprecated, true);
  assert.deepStrictEqual(APP.drivers.filter((d) => d.deprecated).map((d) => d.id), ['easee_ocpp']);
});

test('a device already paired keeps its flow cards and its widgets', () => {
  const cards = ['triggers', 'conditions', 'actions'].flatMap((k) => APP.flow[k])
    .filter((c) => (c.args || []).some((a) => /easee_ocpp/.test(a.filter || '')));
  assert.strictEqual(cards.length, 26);
  assert.match(read('widgets/charger-status/api.js'), /getDevice\(homey, 'easee_ocpp'\)/);
  assert.match(read('widgets/session-history/api.js'), /getDevice\(homey, 'easee_ocpp'\)/);
});

test('the README says it is not offered for pairing', () => {
  assert.match(read('README.md'), /### Easee Charger \(OCPP\)\r?\n\r?\n> \*\*Not offered for pairing\*\*: the driver is marked deprecated/);
});
