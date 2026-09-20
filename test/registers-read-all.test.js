'use strict';

// Reading the whole reference list: what gets asked for, in how many pieces, and what the
// three possible answers look like afterwards. Run: node --test
//
// From the field: "Live lesen" fills only the registers the app itself polls — six of them
// on an SDongle — and the 47-row reference list beside it stayed at dashes. Reading those by
// hand was never going to happen, because a single-row click pays its own connect-and-settle
// second. So the list got a bulk read of its own.
//
// 1.2.245 did that in one probe, sized from an estimate of 11 ms per Modbus request. The
// field said 400-900 ms. The inverter's 31 requests therefore ran past the 20 s timeout,
// probeModbusUnit destroyed the socket, and every remaining batch bisected against a dead
// connection — a page of "no connection to modbus server" for a read that was working fine.
// It is now read a few requests at a time, and the chunking is the first thing tested here:
// every register has to appear in exactly one chunk, or the walk quietly misses some.
//
// The rest is about honesty. After the read every row has to say something definite, and the
// three things it can say must stay distinguishable: a value, a register that was asked for
// and stayed silent, and a register that was never asked. Collapsing the last two would turn
// "we did not ask" into "your device has nothing".

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

// Walks every chunk the way the settings page does, and returns what the whole walk saw.
async function readAll(driverId, devices) {
  const homey = fakeHomey({ [driverId]: devices || [fakeDevice('d-1')] });
  const seen = { asked: [], values: {}, unanswered: [], skipped: [], replies: [] };

  let chunk = 0;
  let total = 1;
  do {
    const res = await api.readDebugSpecRegisters({
      homey, body: { driverId, deviceId: 'd-1', chunk },
    });
    assert.ok(!res.error, `chunk ${chunk}: ${res.error}`);
    seen.replies.push(res);
    seen.asked.push(...Object.keys(probeCalls[probeCalls.length - 1].registers).map(Number));
    Object.assign(seen.values, res.values);
    seen.unanswered.push(...res.unanswered);
    seen.skipped.push(...res.skipped);
    total = res.chunks;
    chunk += 1;
  } while (chunk < total);

  return seen;
}

const ascending = (a, b) => a - b;

// ── the chunking ────────────────────────────────────────────────────────────

test('every register belongs to exactly one chunk', async () => {
  // The walk trusts the chunks to partition the list. A register in two chunks is a wasted
  // round trip; one in none is a row that stays blank for no stated reason, which is exactly
  // what this list is built not to do.
  for (const driverId of ['sun2000_modbus', 'luna2000_modbus', 'sdongle_a_modbus',
                          'sun2000_emma_modbus', 'smartcharger_emma_modbus', 'dtsu666_modbus']) {
    reset();
    const seen = await readAll(driverId);
    const expected = SPEC.DRIVER_SPEC_REGISTERS[driverId]
      .filter((r) => r.type && r.rw !== 'WO')
      .map((r) => r.address)
      .sort(ascending);

    assert.deepStrictEqual([...seen.asked].sort(ascending), expected,
      `${driverId}: the chunks do not cover the readable registers exactly once`);
  }
});

test('no chunk is bigger than the connection can carry', async () => {
  // A chunk is sized in requests, not registers, because it is requests that take the time —
  // 400 to 900 ms each on this hardware. Eight of them is about five seconds, which is what
  // keeps a single call short enough to return promptly.
  reset();
  const seen = await readAll('sun2000_modbus');
  assert.ok(seen.replies.length > 1, 'the inverter list still comes back in one piece');
  for (const res of seen.replies) {
    assert.ok(res.requests >= 1 && res.requests <= 8, `a chunk asked for ${res.requests} requests`);
  }
  assert.ok(seen.replies.length >= 3, `only ${seen.replies.length} chunks for 31 requests`);
});

test('a chunk that does not exist is refused rather than read as empty', async () => {
  reset();
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('d-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'd-1', chunk: 99 },
  });
  assert.match(res.error, /chunk/i);
  assert.strictEqual(probeCalls.length, 0);
});

test('the registers nobody asks for are reported once, with the first chunk', async () => {
  // They belong to no chunk, so reporting them per chunk would either repeat them or lose
  // them depending on where the walk stopped.
  reset();
  const seen = await readAll('sun2000_modbus');
  const expected = SPEC.INVERTER_SPEC_REGISTERS
    .filter((r) => !r.type || r.rw === 'WO').map((r) => r.address).sort(ascending);

  assert.deepStrictEqual(seen.skipped.sort(ascending), expected);
  assert.deepStrictEqual(seen.replies[0].skipped.sort(ascending), expected,
    'the first chunk did not carry them');
  for (const res of seen.replies.slice(1)) {
    assert.deepStrictEqual(res.skipped, [], 'a later chunk repeated the skipped registers');
  }
});

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
    const askedFor = new Set((await readAll(driverId)).asked);

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
  const asked = new Set((await readAll('sun2000_modbus')).asked);
  assert.ok(!asked.has(40200));
  assert.ok(!asked.has(40201));
  assert.ok(asked.has(32016), 'PV1 voltage should have been asked for');
});

test('the register it asks for is described the way the decoder expects', async () => {
  reset();
  await readAll('dtsu666_modbus');
  const def = probeCalls[0].registers['37101'];
  const row = SPEC.METER_SPEC_REGISTERS.find((r) => r.address === 37101);
  assert.deepStrictEqual(def.slice(0, 3), [row.address, row.length, row.type]);
  assert.strictEqual(def[4], row.decimalPower, 'the gain would be applied wrongly');
});

test('it reads the unit the device is actually configured for', async () => {
  reset();
  await readAll('dtsu666_modbus', [fakeDevice('d-1', { modbusId: '100' })]);
  assert.strictEqual(probeCalls[0].unitId, 100);
});

// ── what it reports back ────────────────────────────────────────────────────

test('answered, silent and never-asked are three separate answers', async () => {
  reset();
  probeResult = { 37100: 1, 37101: 230.4, 37103: null };   // 37105 and the rest absent
  const seen = await readAll('dtsu666_modbus');

  assert.strictEqual(seen.values['37100'], 1);
  assert.strictEqual(seen.values['37101'], 230.4);
  assert.ok(!('37103' in seen.values), 'a null answer was reported as a value');
  assert.ok(seen.unanswered.includes(37103), 'a null answer was not reported as silence');
  assert.ok(seen.unanswered.includes(37105), 'a register with no reply at all went unreported');

  // every register in the list is accounted for exactly once
  const all = [...Object.keys(seen.values).map(Number), ...seen.unanswered, ...seen.skipped];
  assert.strictEqual(new Set(all).size, all.length, 'a register is reported twice');
  assert.strictEqual(all.length, SPEC.METER_SPEC_REGISTERS.length,
    'the three lists do not add up to the whole reference list');
});

test('a zero is a reading, not a missing one', async () => {
  // The battery reports 0 W all night. Treating a falsy value as "no answer" would paint
  // every idle register as absent hardware.
  reset();
  probeResult = { 37100: 0 };
  const seen = await readAll('dtsu666_modbus');
  assert.strictEqual(seen.values['37100'], 0);
  assert.ok(!seen.unanswered.includes(37100));
});

// ── what it does to the port ────────────────────────────────────────────────

test('polling stops for each chunk and starts again afterwards', async () => {
  reset();
  const dev = fakeDevice('d-1');
  const homey = fakeHomey({ sdongle_a_modbus: [dev] });
  let chunk = 0;
  let total = 1;
  do {
    const res = await api.readDebugSpecRegisters({
      homey, body: { driverId: 'sdongle_a_modbus', deviceId: 'd-1', chunk },
    });
    total = res.chunks;
    chunk += 1;
  } while (chunk < total);

  assert.ok(dev.stopped > 1, 'the walk took more than one chunk but paused only once');
  assert.strictEqual(dev.started, dev.stopped,
    'the device was left with its polling stopped between chunks');
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
  // fmtVal is defined above escHtml in the page, and the reader needs both.
  let src = cut('function fmtVal(', 'function escHtml(')
          + cut('function escHtml(', 'function regCellId(')
          + cut('const _specRows = {};', 'function toggleSpec(');

  // `const` at a script's top level never becomes a property of the context, and the test
  // has to seed the rows, so it is re-declared as a var instead.
  assert.ok(src.includes('const _specRows = {};'), 'the row store is gone');
  src = 'var _specRows = {};' + src.replace('const _specRows = {};', '');
  return src;
}

// Answers each chunk in turn, so the reader's walk is exercised rather than one reply.
function runReader(rows, replies, startingWith = '—') {
  const cells = {};
  for (const r of rows) cells[`sv-0-${r.address}`] = { innerHTML: startingWith, style: {} };
  const status = { textContent: '', innerHTML: '', style: {} };
  const btn = { disabled: false };
  const asked = [];

  const ctx = {
    document: {
      getElementById: (id) => (id === 'spec-status-0' ? status
        : id === 'spec-btn-0' ? btn : cells[id] || null),
    },
    _H: {
      __: (k) => k,
      api: (method, path, body, cb) => { asked.push(body.chunk); cb(null, replies[body.chunk]); },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(loadReader(), ctx);
  ctx._specRows[0] = rows;
  ctx.readSpecRegisters('d', 'x', 0);
  return { cells, status, btn, asked };
}

const ROWS = [
  { address: 100, type: 'UINT16', rw: 'RO', specType: 'U16' },   // answers, first chunk
  { address: 150, type: 'UINT16', rw: 'RO', specType: 'U16' },   // answers, second chunk
  { address: 200, type: 'UINT16', rw: 'RO', specType: 'U16' },   // silent, second chunk
  { address: 300, type: 'UINT16', rw: 'WO', specType: 'U16' },   // write-only
  { address: 400, type: null,     rw: 'RW', specType: 'MLD' },   // undecodable
];

// A register answers in each chunk on purpose. With only one in the whole walk, a tally that
// assigns instead of adding counts the same — which is how "the summary counts only the last
// chunk" survived the probe.
const TWO_CHUNKS = [
  { timestamp: '2026-09-20T12:00:00.000Z', chunk: 0, chunks: 2, requests: 1,
    values: { 100: 42 }, unanswered: [], skipped: [300, 400] },
  { timestamp: '2026-09-20T12:00:05.000Z', chunk: 1, chunks: 2, requests: 1,
    values: { 150: 7 }, unanswered: [200], skipped: [] },
];

test('the reader walks every chunk in order and stops at the last', () => {
  const { asked, btn } = runReader(ROWS, TWO_CHUNKS);
  assert.deepStrictEqual(asked, [0, 1], 'the walk did not visit each chunk exactly once');
  assert.strictEqual(btn.disabled, false, 'the button stayed disabled after the walk');
});

test('each of the three answers leaves a different mark on the row', () => {
  const { cells } = runReader(ROWS, TWO_CHUNKS);

  assert.match(cells['sv-0-100'].innerHTML, /42/, 'the value did not reach its cell');
  assert.match(cells['sv-0-200'].innerHTML, /val-error/, 'silence does not read as silence');
  assert.match(cells['sv-0-300'].innerHTML, /specWriteOnly/, 'a write-only row lost its reason');
  assert.strictEqual(cells['sv-0-400'].innerHTML, '—',
    'a row skipped for its type was overwritten, losing the type it was showing');

  const marks = new Set(Object.values(cells).map((c) => c.innerHTML));
  assert.strictEqual(marks.size, 5, 'two different outcomes render alike');
});

test('a register reading zero shows the zero', () => {
  const { cells } = runReader(ROWS, [{
    timestamp: '2026-09-20T12:00:00.000Z', chunk: 0, chunks: 1,
    values: { 100: 0 }, unanswered: [], skipped: [],
  }]);
  assert.match(cells['sv-0-100'].innerHTML, />0</, 'a zero was swallowed');
});

test('the summary counts the whole walk, not just its last piece', () => {
  const { status } = runReader(ROWS, TWO_CHUNKS);
  // two, one from each chunk — the point of the test
  assert.match(status.textContent, /2 settings\.registers\.specAnswered/);
  assert.match(status.textContent, /1 settings\.registers\.specSilent/);
  assert.match(status.textContent, /2 settings\.registers\.specNotAsked/);
});

test('a chunk that fails keeps what the earlier ones already found', () => {
  // This is the whole reason the read is walked rather than done in one call: half an answer
  // is worth keeping, and throwing it away would look like the device had nothing.
  const replies = [TWO_CHUNKS[0], { error: 'Connection failed or timed out', chunk: 1, chunks: 2 }];
  const { cells, status, btn } = runReader(ROWS, replies);

  assert.match(cells['sv-0-100'].innerHTML, /42/, 'the first chunk was thrown away');
  assert.match(status.textContent, /Connection failed/);
  assert.match(status.textContent, /specStoppedAfter/, 'it does not say how far it got');
  assert.strictEqual(btn.disabled, false);
});

test('a read that fails at the very first chunk does not clear the rows', () => {
  const { cells, status, btn } = runReader(ROWS, [{ error: 'Connection failed' }], 'was here');

  assert.match(status.textContent, /Connection failed/);
  assert.strictEqual(btn.disabled, false);
  for (const cell of Object.values(cells)) {
    assert.strictEqual(cell.innerHTML, 'was here',
      'a failed read cleared the rows, which reads as "the device has nothing"');
  }
});
