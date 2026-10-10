'use strict';

// Unit ID 0 is a real Modbus address: every EMMA device answers on it, and an SDongle with
// older firmware may too. Three places treated it as "nothing entered" (review 2026-10-10):
//
//   1. The EMMA charger's pairing dialog came filled in with 1, while the hint beneath it, the
//      README, the device setting and the three other EMMA dialogs all say 0.
//   2. The SDongle dialog tested the connection on unit 0 and then saved the device on 100
//      (`|| 100`): a passed test, followed by a device asking a unit that does not answer.
//   3. A click on a single row in the register list read unit 1 for a device set to 0
//      (`|| 1`), while "Live lesen" beside it read the right unit.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP  = require('../app.json');

const MODBUS_PAIRING = [
  'sun2000_modbus', 'luna2000_modbus', 'dtsu666_modbus', 'sdongle_a_modbus',
  'sun2000_emma_modbus', 'luna2000_emma_modbus', 'powermeter_emma_modbus', 'smartcharger_emma_modbus',
];

function settingDefault(driverId) {
  const flat = (s) => s.flatMap((x) => (x.children ? flat(x.children) : [x]));
  const d = APP.drivers.find((x) => x.id === driverId);
  return flat(d.settings || []).find((x) => x.id === 'modbus_id').value;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const id of MODBUS_PAIRING) {
  test(`${id}: the dialog, the connection test and the saved device agree on the unit ID`, () => {
    const html = read(`drivers/${id}/pair/start.html`);
    const def  = settingDefault(id);

    const prefill = html.match(/id="modbus-id" value="(\d+)"/);
    assert.ok(prefill, 'no prefilled unit ID field');
    assert.strictEqual(Number(prefill[1]), def, 'the dialog suggests another unit than the device defaults to');

    const saved = html.match(/modbus_id:\s*([^\n]+?),\s*\n/);
    assert.ok(saved, 'no modbus_id in createDevice');
    const store = (modbusId) => vm.runInNewContext(saved[1], { modbusId, parseInt });
    assert.strictEqual(store('0'), 0, `unit 0 is saved as ${store('0')}`);
    assert.strictEqual(store('7'), 7);
    assert.strictEqual(store(''), def, 'an empty field is saved as another unit than the device defaults to');

    const tested = read(`drivers/${id}/driver.js`).match(/modbusId = parseIntSafe\(modbusId, (\d+)\)/);
    assert.ok(tested, 'no connection-test default in driver.js');
    assert.strictEqual(Number(tested[1]), def, 'the connection test falls back to another unit than the device');
  });
}

// ── the single-row read in the register list ──────────────────────────────────

const client = require('../lib/modbus-client');
const probes = [];
client.probeModbusUnit = async (host, port, unitId) => { probes.push(unitId); return { r: 42 }; };
const api = require('../api.js');            // must come after the replacement

function homeyWith(modbusId) {
  const dev = {
    getId: () => 'd-1',
    getSettings: () => ({ address: '192.168.1.10', port: '502', modbus_id: modbusId }),
    getSetting: (k) => ({ address: '192.168.1.10', port: '502', modbus_id: modbusId }[k]),
  };
  return {
    log: () => {},
    drivers: { getDriver: (id) => { if (id !== 'sun2000_emma_modbus') throw new Error('Invalid Driver'); return { getDevices: () => [dev] }; } },
  };
}
const single = (modbusId) => api.postDebugRegisterSingle({
  homey: homeyWith(modbusId),
  body: { driverId: 'sun2000_emma_modbus', deviceId: 'd-1', address: 30000, length: 1, type: 'UINT16' },
});

test('a click on a register row reads the unit the device is set to, 0 included', async () => {
  probes.length = 0;
  assert.deepStrictEqual(await single(0), { value: 42 });
  assert.deepStrictEqual(await single('0'), { value: 42 });
  assert.deepStrictEqual(await single(3), { value: 42 });
  assert.deepStrictEqual(probes, [0, 0, 3]);
});

test('a device with no unit ID at all is still read on 1', async () => {
  probes.length = 0;
  await single(undefined);
  await single('');
  assert.deepStrictEqual(probes, [1, 1]);
});
