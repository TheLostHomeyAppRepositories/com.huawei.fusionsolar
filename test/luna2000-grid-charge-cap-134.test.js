'use strict';

// A forced charge from the grid is held to the grid charge power (1.3.4). Run: node --test
//
// ArnarS (forum, 2026-10-15/16): "Start charging with 3000 W until 76 %" at night, and the log
// said "Force charging confirmed by poll: P=126 W (target 3000 W)". With "Set grid charge power
// to 1500 W" in the same flow the battery picked up the pace and reached its target. His
// question — "Does the value in this registry cap the value from the start charging card?" —
// yes: from the grid the inverter charges at most the grid charge power (47242), itself held
// to its limit (47244). Andi: "Ja, beides bauen" — the cards' hint says so, and the log says
// so when the power asked for is above it.

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

const ROOT   = path.join(__dirname, '..');
const APP    = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const SRC    = fs.readFileSync(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'), 'utf8');
const Device = require('../drivers/luna2000_modbus/device.js');
const CARDS  = ['luna2000_start_force_charge', 'luna2000_start_force_charge_duration'];

function battery(settings) {
  const d = Object.create(Device.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.getSetting = (k) => settings[k];
  return d;
}

test('3000 W asked with a grid charge power of 150 W is named in the log', () => {
  const d = battery({ charge_from_grid: true, max_grid_charge_power: 150 });
  d._warnGridChargeCap(3000, 'Force charge');
  assert.deepStrictEqual(d.logs, ['Force charge: 3000 W asked, but the grid charge power is 150 W — from the grid the battery '
    + 'charges at most that (raise it with "Set grid charge power", within "Set max power charge from grid")']);
});

test('nothing is said when the power fits, the value is unknown, or grid charging is off', () => {
  for (const settings of [
    { charge_from_grid: true, max_grid_charge_power: 3000 },
    { charge_from_grid: true, max_grid_charge_power: '3000' },
    { charge_from_grid: true },
    { charge_from_grid: false, max_grid_charge_power: 150 },   // not kept up to date then
  ]) {
    const d = battery(settings);
    d._warnGridChargeCap(3000, 'Force charge');
    assert.deepStrictEqual(d.logs, [], JSON.stringify(settings));
  }
});

test('both charge cards check it, right after the power is worked out', () => {
  for (const [id, label] of [['luna2000_start_force_charge', 'Force charge'], ['luna2000_start_force_charge_duration', 'Force charge (timed)']]) {
    const at = SRC.indexOf(`cards['${id}'] = `);
    assert.ok(at > 0, id);
    const body = SRC.slice(at, SRC.indexOf('\n      };', at));
    assert.match(body, new RegExp(`self\\._warnGridChargeCap\\(powerW, '${label.replace(/[()]/g, '\\$&')}'\\)`), id);
  }
});

test('the hints of both cards say it, in all three languages, naming the card that raises it', () => {
  const set = APP.flow.actions.find((c) => c.id === 'luna2000_set_grid_charge_power').titleFormatted;
  for (const id of CARDS) {
    const hint = APP.flow.actions.find((c) => c.id === id).hint;
    assert.match(hint.en, /grid charge power \(register 47242, which cannot exceed its limit 47244\)/);
    assert.match(hint.de, /Netzladeleistung der Batterie begrenzt \(Register 47242, höchstens ihre Obergrenze 47244\)/);
    assert.match(hint.nl, /laadvermogen uit het net van de batterij \(register 47242, hoogstens de limiet 47244\)/);
    assert.ok(hint.en.includes('"Set grid charge power"') && set.en.startsWith('Set grid charge power'));
    assert.ok(hint.de.includes('„Netzladeleistung auf … W setzen“') && set.de === 'Netzladeleistung auf [[power]] W setzen');
    assert.ok(hint.nl.includes('„Laadvermogen uit het net instellen op … W"') && set.nl === 'Laadvermogen uit het net instellen op [[power]] W');
    // What the hint said before stays in front.
    assert.match(hint.en, /^Starts force charging the LUNA2000/);
  }
});
