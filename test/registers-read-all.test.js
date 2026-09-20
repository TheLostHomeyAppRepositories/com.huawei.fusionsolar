'use strict';

// Reading the whole reference list: what gets asked for, and what the three possible
// answers look like afterwards. Run: node --test
//
// From the field: "Live lesen" fills only the registers the app itself polls — six of them
// on an SDongle — and the 47-row reference list beside it stayed at dashes. Reading those by
// hand was never going to happen, because a single-row click pays its own connect-and-settle
// second. So the list got a bulk read of its own.
//
// What is pinned here is mostly about honesty rather than speed. After the read every row
// has to say something definite, and the three things it can say must stay distinguishable:
// a value, a register that was asked for and stayed silent, and a register that was never
// asked. Collapsing the last two would turn "we did not ask" into "your device has nothing".
//
// probeModbusUnit is replaced before api.js is loaded, because api.js destructures it at
// module scope and would otherwise hold the real one.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const vm     = require('node:vm');

const client = require('../lib/modbus-client');
const probeCalls = [];
let probeResult = {};
let probeThrows = null;
let probeDead   = false;

// api.js destructures probeModbusUnit at module scope, so it keeps whatever function is on
// the module the moment it loads. Everything a test wants to vary therefore has to be
// varied through this one closure rather than by reassigning the export later.
client.probeModbusUnit = async (host, port, unitId, registers, timeoutMs) => {
  probeCalls.push({ host, port, unitId, registers, timeoutMs });
  if (probeThrows) throw probeThrows;
  return probeDead ? null : probeResult;
};

const api  = require('../api.js');            // must come after the replacement
const SPEC = require('../lib/modbus-spec-registers');

// ── a device that records whether its polling was stopped and started ───────

function fakeDevice(id, { address = '192.168.1.10', modbusId = '1' } = {}) {
  const dev = {
    stopped: 0, started: 0,
    getId:   () => id,
    getName: () => id,
    getAvailable: () => true,
    getCapabilities: () => [],
    getCapabilityValue: () => null,
    getSettings: () => ({ address, port: '502', modbus_id: modbusId }),
    getSetting: (k) => ({ address, port: '502', modbus_id: modbusId }[k]),
    _stopPolling:  async () => { dev.stopped += 1; },
    _startPolling: async () => { dev.started += 1; },
  };
  return dev;
}

function fakeHomey(present) {
  return {
    app: { log: () => {} },
    drivers: {
      getDriver(id) {
        if (!(id in present)) throw new Error('Invalid Driver');
        return { getDevices: () => present[id] };
      },
    },
  };
}

function reset() {
  probeCalls.length = 0;
  probeResult = {};
  probeThrows = null;
  probeDead   = false;
}

// ── what it asks the device for ─────────────────────────────────────────────

test('it asks for every register it can decode, and for nothing it cannot', async () => {
  // Across several devices on purpose. The SDongle's list happens to have no undecodable
  // rows at all, so on its own it cannot tell whether those are being skipped — a mutation
  // probe found exactly that hole. The inverter has eight and the EMMA fourteen.
  const DEVICES = [
    ['sdongle_a_modbus',     SPEC.SDONGLE_SPEC_REGISTERS],
    ['sun2000_modbus',       SPEC.INVERTER_SPEC_REGISTERS],
    ['luna2000_emma_modbus', SPEC.EMMA_SPEC_REGISTERS],
  ];

  let sawUndecodable = 0;
  let sawWriteOnly   = 0;

  for (const [driverId, list] of DEVICES) {
    reset();
    await api.readDebugSpecRegisters({
      homey: fakeHomey({ [driverId]: [fakeDevice('d-1')] }),
      body:  { driverId, deviceId: 'd-1' },
    });

    assert.strictEqual(probeCalls.length, 1, `${driverId}: not read in a single connection`);
    const askedFor = new Set(Object.keys(probeCalls[0].registers).map(Number));

    for (const r of list) {
      const readable = r.type && r.rw !== 'WO';
      if (!r.type) sawUndecodable += 1;
      if (r.rw === 'WO') sawWriteOnly += 1;
      assert.strictEqual(askedFor.has(r.address), Boolean(readable),
        `${driverId}/${r.address} (${r.specType}, ${r.rw}) — `
        + `${readable ? 'should have been asked for' : 'should not have been'}`);
    }
    assert.ok(askedFor.size > 30, `${driverId}: only ${askedFor.size} registers were asked for`);
  }

  // If either kind ever disappears from all three lists, the assertion above becomes
  // vacuous for it and this says so rather than passing quietly.
  assert.ok(sawUndecodable >= 5, `only ${sawUndecodable} undecodable rows were covered`);
  assert.ok(sawWriteOnly >= 5, `only ${sawWriteOnly} write-only rows were covered`);
});

test('a write-only register is never read, on any device', async () => {
  // 40200 is Startup and 40201 Shutdown on an inverter. A read cannot set them off, but it
  // cannot return anything either, so asking would spend a round trip to print a cross.
  reset();
  await api.readDebugSpecRegisters({
    homey: fakeHomey({ sun2000_modbus: [fakeDevice('inv-1')] }),
    body:  { driverId: 'sun2000_modbus', deviceId: 'inv-1' },
  });
  const asked = Object.keys(probeCalls[0].registers).map(Number);
  assert.ok(!asked.includes(40200));
  assert.ok(!asked.includes(40201));
  assert.ok(asked.includes(32016), 'PV1 voltage should have been asked for');
});

test('the register it asks for is described the way the decoder expects', async () => {
  reset();
  await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('meter-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  const def = probeCalls[0].registers['37101'];
  const row = SPEC.METER_SPEC_REGISTERS.find((r) => r.address === 37101);
  assert.deepStrictEqual(def.slice(0, 3), [row.address, row.length, row.type]);
  assert.strictEqual(def[4], row.decimalPower, 'the gain would be applied wrongly');
});

test('it reads the unit the device is actually configured for', async () => {
  reset();
  await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('meter-1', { modbusId: '100' })] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.strictEqual(probeCalls[0].unitId, 100);
});

// ── what it reports back ────────────────────────────────────────────────────

test('answered, silent and never-asked are three separate answers', async () => {
  reset();
  probeResult = { 37100: 1, 37101: 230.4, 37103: null };   // 37105 and the rest absent
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('meter-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });

  assert.deepStrictEqual(res.values['37100'], 1);
  assert.deepStrictEqual(res.values['37101'], 230.4);
  assert.ok(!('37103' in res.values), 'a null answer was reported as a value');
  assert.ok(res.unanswered.includes(37103), 'a null answer was not reported as silence');
  assert.ok(res.unanswered.includes(37105), 'a register with no reply at all went unreported');

  // every register in the list is accounted for exactly once
  const seen = [...Object.keys(res.values).map(Number), ...res.unanswered, ...res.skipped];
  assert.strictEqual(new Set(seen).size, seen.length, 'a register is reported twice');
  assert.strictEqual(seen.length, SPEC.METER_SPEC_REGISTERS.length,
    'the three lists do not add up to the whole reference list');
});

test('a zero is a reading, not a missing one', async () => {
  // The battery reports 0 W all night. Treating a falsy value as "no answer" would paint
  // every idle register as absent hardware.
  reset();
  probeResult = { 37100: 0 };
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('meter-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.strictEqual(res.values['37100'], 0);
  assert.ok(!res.unanswered.includes(37100));
});

// ── what it does to the port ────────────────────────────────────────────────

test('polling stops for the read and starts again afterwards', async () => {
  reset();
  const dev = fakeDevice('meter-1');
  await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [dev] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.strictEqual(dev.stopped, 1);
  assert.strictEqual(dev.started, 1);
});

test('polling starts again even when the read blows up', async () => {
  // Huawei allows one session on the port. A read that leaves polling stopped takes the
  // device off the air until the app is restarted, which is far worse than a failed read.
  reset();
  probeThrows = new Error('socket hang up');
  const dev = fakeDevice('meter-1');
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [dev] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.match(res.error, /socket hang up/);
  assert.strictEqual(dev.started, 1, 'the device was left with its polling stopped');
});

test('every device on the same host is paused, not just the one being read', async () => {
  // They queue on one socket. Pausing only the target leaves its neighbours free to take
  // the slot mid-read.
  reset();
  const meter = fakeDevice('meter-1');
  const inverter = fakeDevice('inv-1');
  const elsewhere = fakeDevice('other-1', { address: '10.0.0.9' });
  await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [meter], sun2000_modbus: [inverter, elsewhere] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.strictEqual(inverter.stopped, 1, 'a device sharing the host kept polling');
  assert.strictEqual(elsewhere.stopped, 0, 'a device on another host was paused for nothing');
});

// ── when it cannot ──────────────────────────────────────────────────────────

test('a driver with no reference list says so instead of reading nothing', async () => {
  reset();
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ smartcharger_emma_modbus: [fakeDevice('c-1')] }),
    body:  { driverId: 'no_such_driver', deviceId: 'c-1' },
  });
  assert.ok(res.error, 'an unknown driver produced no error');
  assert.strictEqual(probeCalls.length, 0);
});

test('a device without an IP is not dialled', async () => {
  reset();
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('meter-1', { address: '' })] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.match(res.error, /IP address/);
  assert.strictEqual(probeCalls.length, 0);
});

test('a connection that never opens is an error, not an empty list of readings', async () => {
  reset();
  probeDead = true;
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('meter-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'meter-1' },
  });
  assert.ok(res.error, 'a dead connection was reported as a successful read of nothing');
  assert.ok(!res.values, 'a dead connection still produced a values map');
});

// ── and what the tab does with the answer ───────────────────────────────────

function loadReader() {
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf(from);
    const b = html.indexOf(to, a);
    assert.ok(a !== -1 && b > a, `could not find ${from} … ${to}`);
    return html.slice(a, b);
  };
  let src = cut('function escHtml(', 'function regCellId(')
          + cut('function fmtVal(', 'function regCellId(').split('function regCellId(')[0]
          + cut('const _specRows = {};', 'function toggleSpec(');

  // `const` at a script's top level never becomes a property of the context, and the test
  // has to seed the rows, so it is re-declared as a var instead.
  assert.ok(src.includes('const _specRows = {};'), 'the row store is gone');
  src = 'var _specRows = {};' + src.replace('const _specRows = {};', '');
  return src;
}

function runReader(rows, result) {
  const cells = {};
  for (const r of rows) cells[`sv-0-${r.address}`] = { innerHTML: '—', style: {} };
  const status = { textContent: '', innerHTML: '', style: {} };
  const btn = { disabled: false };

  const ctx = {
    document: {
      getElementById: (id) => (id === 'spec-status-0' ? status
        : id === 'spec-btn-0' ? btn : cells[id] || null),
    },
    _H: { __: (k) => k, api: (method, path, body, cb) => cb(null, result) },
  };
  vm.createContext(ctx);
  vm.runInContext(loadReader(), ctx);
  ctx._specRows[0] = rows;
  ctx.readSpecRegisters('d', 'x', 0);
  return { cells, status, btn };
}

const ROWS = [
  { address: 100, type: 'UINT16', rw: 'RO', specType: 'U16' },   // answers
  { address: 200, type: 'UINT16', rw: 'RO', specType: 'U16' },   // silent
  { address: 300, type: 'UINT16', rw: 'WO', specType: 'U16' },   // write-only
  { address: 400, type: null,     rw: 'RW', specType: 'MLD' },   // undecodable
];

test('each of the three answers leaves a different mark on the row', () => {
  const { cells } = runReader(ROWS, {
    timestamp: '2026-09-20T12:00:00.000Z',
    values: { 100: 42 },
    unanswered: [200],
    skipped: [300, 400],
  });

  assert.match(cells['sv-0-100'].innerHTML, /42/, 'the value did not reach its cell');
  assert.match(cells['sv-0-200'].innerHTML, /val-error/, 'silence does not read as silence');
  assert.match(cells['sv-0-300'].innerHTML, /specWriteOnly/, 'a write-only row lost its reason');
  assert.strictEqual(cells['sv-0-400'].innerHTML, '—',
    'a row skipped for its type was overwritten, losing the type it was showing');

  const marks = new Set(Object.values(cells).map((c) => c.innerHTML));
  assert.strictEqual(marks.size, 4, 'two different outcomes render alike');
});

test('a register reading zero shows the zero', () => {
  const { cells } = runReader(ROWS, {
    timestamp: '2026-09-20T12:00:00.000Z', values: { 100: 0 }, unanswered: [], skipped: [],
  });
  assert.match(cells['sv-0-100'].innerHTML, />0</, 'a zero was swallowed');
});

test('the summary counts all three, and the button comes back', () => {
  const { status, btn } = runReader(ROWS, {
    timestamp: '2026-09-20T12:00:00.000Z',
    values: { 100: 42 }, unanswered: [200], skipped: [300, 400],
  });
  assert.match(status.textContent, /1 settings\.registers\.specAnswered/);
  assert.match(status.textContent, /1 settings\.registers\.specSilent/);
  assert.match(status.textContent, /2 settings\.registers\.specNotAsked/);
  assert.strictEqual(btn.disabled, false, 'the button stayed disabled after the read');
});

test('a failed read says so and does not paint the rows as empty', () => {
  const cells = {};
  for (const r of ROWS) cells[`sv-0-${r.address}`] = { innerHTML: 'was here', style: {} };
  const status = { textContent: '', innerHTML: '', style: {} };
  const btn = { disabled: false };
  const ctx = {
    document: {
      getElementById: (id) => (id === 'spec-status-0' ? status
        : id === 'spec-btn-0' ? btn : cells[id] || null),
    },
    _H: { __: (k) => k, api: (m, p, b, cb) => cb(null, { error: 'Connection failed' }) },
  };
  vm.createContext(ctx);
  vm.runInContext(loadReader(), ctx);
  ctx._specRows[0] = ROWS;
  ctx.readSpecRegisters('d', 'x', 0);

  assert.match(status.textContent, /Connection failed/);
  assert.strictEqual(btn.disabled, false);
  for (const cell of Object.values(cells)) {
    assert.strictEqual(cell.innerHTML, 'was here',
      'a failed read cleared the rows, which reads as "the device has nothing"');
  }
});
