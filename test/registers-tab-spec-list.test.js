'use strict';

// The Registers tab's full specification list, from the API that supplies it to the table
// that draws it. Run: node --test
//
// test/modbus-spec-registers.test.js checks that the parsed list itself is sound. This one
// checks the two joints on either side of it, because a correct list wired up wrongly is
// just as misleading: a device handed a list from a document that does not describe it
// would show addresses meaning something else entirely, and a row the app cannot read that
// still invites a click would answer with a red cross and no explanation.
//
// buildSpecTable is not inspected as text but lifted out of settings/index.html and run,
// so what is asserted is the markup a user's browser would get. Pinning the source instead
// would pass on any rewrite that kept the words and changed the behaviour.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const vm     = require('node:vm');

const api  = require('../api.js');
const SPEC = require('../lib/modbus-spec-registers');
const REG  = require('../lib/modbus-registers');

// ── the API end ─────────────────────────────────────────────────────────────

function fakeDevice(id, name) {
  return {
    getId:             () => id,
    getName:           () => name,
    getAvailable:      () => true,
    getSettings:       () => ({ address: '192.168.1.10', port: 502, modbus_id: 1 }),
    getCapabilities:   () => ['measure_power'],
    getCapabilityValue: () => 1234,
  };
}

// Only the two drivers this test cares about exist; every other Modbus driver throws the
// way Homey does when none is paired, which is also the path getDebugDevices skips over.
function fakeHomey(present) {
  return {
    drivers: {
      getDriver(id) {
        if (!(id in present)) throw new Error('Invalid Driver');
        return { getDevices: () => present[id] };
      },
    },
  };
}

test('a SUN2000 is handed the inverter list, and the addresses the app polls', async () => {
  const homey = fakeHomey({ sun2000_modbus: [fakeDevice('inv-1', 'Inverter')] });
  const { devices } = await api.getDebugDevices({ homey });

  assert.strictEqual(devices.length, 1);
  const dev = devices[0];
  assert.strictEqual(dev.specRegisters, SPEC.INVERTER_SPEC_REGISTERS);

  // The marks on the list have to be the app's real polling set, not a guess: 32016 is
  // PV1 voltage, which the driver reads every cycle, and 35155 is the revocation code,
  // which it has never read.
  assert.ok(dev.polledAddresses.includes(32016), 'PV1 voltage is not marked as polled');
  assert.ok(!dev.polledAddresses.includes(35155), 'a register the app never reads is marked as polled');
  assert.ok(dev.polledAddresses.length > 20 && dev.polledAddresses.length < 120,
    `polledAddresses has ${dev.polledAddresses.length} entries — that is the whole list or none of it`);

  // and every one of them must really come from a register map, not from the spec list
  const known = new Set([...Object.values(REG.REGISTERS), ...Object.values(REG.CONTROL_REGISTERS),
    ...Object.values(REG.POWER_METER_REGISTERS)].map((d) => d[0]));
  for (const address of dev.polledAddresses) {
    assert.ok(known.has(address), `${address} is marked as polled but no register map holds it`);
  }
});

test('a battery is handed the battery list, a meter the meter list', async () => {
  for (const [driverId, list] of [['luna2000_modbus', SPEC.BATTERY_SPEC_REGISTERS],
                                  ['dtsu666_modbus',  SPEC.METER_SPEC_REGISTERS]]) {
    const homey = fakeHomey({ [driverId]: [fakeDevice('d', 'D')] });
    const { devices } = await api.getDebugDevices({ homey });
    assert.strictEqual(devices[0].specRegisters, list, driverId);
  }
});

test('a device this document does not describe is handed no list at all', async () => {
  // 40000 is the system time on a SUN2000 and the ESS control mode on an EMMA. Showing an
  // EMMA the inverter's list would not be an approximation, it would be wrong.
  for (const driverId of ['sun2000_emma_modbus', 'luna2000_emma_modbus',
                          'powermeter_emma_modbus', 'smartcharger_emma_modbus',
                          'sdongle_a_modbus']) {
    const homey = fakeHomey({ [driverId]: [fakeDevice('d', 'D')] });
    const { devices } = await api.getDebugDevices({ homey });
    assert.strictEqual(devices[0].specRegisters, null, driverId);
    assert.deepStrictEqual(devices[0].polledAddresses, devices[0].polledAddresses.filter(Number.isInteger),
      `${driverId}: polledAddresses is not a list of addresses`);
  }
});

// ── the drawing end ─────────────────────────────────────────────────────────

function loadBuildSpecTable() {
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf(from);
    const b = html.indexOf(to, a);
    assert.ok(a !== -1 && b > a, `could not find ${from} … ${to} in settings/index.html`);
    return html.slice(a, b);
  };
  const src = cut('function escHtml(', 'function regCellId(')
            + cut('function buildSpecTable(', 'function toggleSpec(');

  const ctx = { _H: { __: (key) => key } };   // the label is the key, so a test can see it
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.buildSpecTable;
}

const ROWS = [
  { address: 32016, length: 1, type: 'INT16', specType: 'I16', decimalPower: -1, rw: 'RO', unit: 'V', label: 'PV1 voltage' },
  { address: 35155, length: 64, type: 'STRING', specType: 'String', decimalPower: 0, rw: 'RO', unit: '', label: 'Revocation code' },
  { address: 40133, length: 21, type: null, specType: 'MLD/Bytes', decimalPower: 0, rw: 'RW', unit: '', label: '[Power grid scheduling] cosφ-P/Pn characteristic curve' },
  { address: 47321, length: 1, type: null, specType: 'INT32', decimalPower: 0, rw: 'RW', unit: 'W', label: 'Battery charge and discharge power', conflict: true },
];

const DEV = { driverId: 'sun2000_modbus', deviceId: 'inv-1', specRegisters: ROWS, polledAddresses: [32016] };

const rowFor = (html, address) =>
  html.split('<tr').find((chunk) => chunk.includes(`data-spec="${address} `) || chunk.includes(`>${address}<span`));

test('a device with no list draws nothing rather than an empty heading', () => {
  const build = loadBuildSpecTable();
  assert.strictEqual(build({ ...DEV, specRegisters: null }, 0), '');
  assert.strictEqual(build({ ...DEV, specRegisters: [] }, 0), '');
});

test('a readable row can be clicked, and passes the register it actually describes', () => {
  const html = loadBuildSpecTable()(DEV, 3);
  const row  = rowFor(html, 32016);
  assert.ok(row, 'the PV1 voltage row is missing');
  assert.match(row, /readSingleRegister\('sun2000_modbus','inv-1',32016,1,'INT16',-1,'sv-3-32016'\)/,
    'the click would read a different register than the row shows');
});

test('a row the app cannot decode is listed but not offered', () => {
  const html = loadBuildSpecTable()(DEV, 0);
  for (const address of [40133, 47321]) {
    const row = rowFor(html, address);
    assert.ok(row, `${address} is not listed`);
    assert.ok(!row.includes('readSingleRegister'),
      `${address} invites a click that could only fail`);
    assert.ok(!row.includes('class="reg-row"'), `${address} still looks clickable`);
  }
});

test('the two reasons a row cannot be read are told apart', () => {
  // One is the app's limit — no decoder for MLD/Bytes. The other is the specification
  // contradicting itself. Saying the first about the second would send somebody looking
  // for a bug in the app.
  const html = loadBuildSpecTable()(DEV, 0);
  assert.match(rowFor(html, 40133), /settings\.registers\.specNotReadable/);
  assert.match(rowFor(html, 47321), /settings\.registers\.specTypeConflict/);
});

test('only the registers the app polls carry the mark', () => {
  const html = loadBuildSpecTable()(DEV, 0);
  assert.match(rowFor(html, 32016), /badge-polled/, 'a polled register is not marked');
  for (const address of [35155, 40133, 47321]) {
    assert.ok(!rowFor(html, address).includes('badge-polled'),
      `${address} is marked as polled but the app never reads it`);
  }
});

test('every row carries what the filter searches, in the case it searches for', () => {
  const html = loadBuildSpecTable()(DEV, 0);
  for (const r of ROWS) {
    const row = rowFor(html, r.address);
    assert.ok(row.includes(`data-spec="${r.address} `),
      `${r.address}: the filter cannot match it by address`);
    const at = row.indexOf('data-spec="');
    const value = row.slice(at + 11, row.indexOf('"', at + 11));
    assert.strictEqual(value, value.toLowerCase(),
      `${r.address}: data-spec is not lowercased, so a typed capital would never match`);
  }
  // …and the query is lowercased to meet it
  const src = fs.readFileSync('settings/index.html', 'utf8');
  const fn  = src.slice(src.indexOf('function filterSpec('), src.indexOf('// ── Live register read'));
  assert.match(fn, /\.toLowerCase\(\)/, 'filterSpec does not lowercase what was typed');
});

test('the heading counts the rows it is about to show', () => {
  const html = loadBuildSpecTable()(DEV, 0);
  assert.match(html, new RegExp(`>${ROWS.length} ·`), 'the count is not the number of rows');
});

test('the value cells cannot collide with the ones the bulk read fills', () => {
  // readRegisters clears a failed group with a query on [id^="rv-…"]. A specification cell
  // sharing that prefix would be wiped by a group it has nothing to do with.
  const html = loadBuildSpecTable()(DEV, 0);
  assert.ok(!html.includes('id="rv-'), 'a specification cell uses the bulk read\'s id prefix');
  assert.match(html, /id="sv-0-32016"/);
});
