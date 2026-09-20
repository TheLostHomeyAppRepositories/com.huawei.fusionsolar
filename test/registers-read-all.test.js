'use strict';

// Reading the whole reference list: what gets asked for, in how many pieces, and what the
// three possible answers look like afterwards. Run: node --test
//
// From the field: "Live lesen" fills only the registers the app itself polls — six of them
// on an SDongle — and the 47-row reference list beside it stayed at dashes. Reading those by
// hand was never going to happen, because a single-row click pays its own connect-and-settle
// second. So the list got a bulk read of its own.
//
// 1.2.245 did that in one probe, sized from an estimate of 11 ms per Modbus request, and it
// died on its own timeout. 1.2.246 cut it into fixed pieces of eight requests, and that died
// too — on the inverter, because what a request costs depends on which device answers it.
// Measured on one plant within a minute: 190 ms from the SDongle, 1.6 s from the inverter
// behind it. Eight requests is 1.5 s on one and 14 s on the other, the settings page gives
// up at twelve, and the walk never reached its second piece.
//
// So the caller names a run of plan groups and sizes it from how long the last one took.
// Two things are tested first here: that those runs tile the plan exactly, and that the
// walk advances by what was read rather than by what it asked for.
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

// Walks the whole plan the way the settings page does, and returns what the walk saw.
async function readAll(driverId, devices, count = 4) {
  const homey = fakeHomey({ [driverId]: devices || [fakeDevice('d-1')] });
  const seen = { asked: [], values: {}, unanswered: [], skipped: [], replies: [] };

  let from = 0;
  let total = 1;
  do {
    const res = await api.readDebugSpecRegisters({
      homey, body: { driverId, deviceId: 'd-1', from, count },
    });
    assert.ok(!res.error, `from ${from}: ${res.error}`);
    seen.replies.push(res);
    seen.asked.push(...Object.keys(probeCalls[probeCalls.length - 1].registers).map(Number));
    Object.assign(seen.values, res.values);
    seen.unanswered.push(...res.unanswered);
    seen.skipped.push(...res.skipped);
    total = res.total;
    from += res.count;            // what was read, not what was asked for
  } while (from < total);

  return seen;
}

const ascending = (a, b) => a - b;

// ── the chunking ────────────────────────────────────────────────────────────

test('every register is read exactly once as the walk goes by', async () => {
  // The walk trusts the pieces to tile the plan. A register in two pieces is a wasted round
  // trip; one in none is a row that stays blank for no stated reason, which is exactly what
  // this list is built not to do.
  for (const driverId of ['sun2000_modbus', 'luna2000_modbus', 'sdongle_a_modbus',
                          'sun2000_emma_modbus', 'smartcharger_emma_modbus', 'dtsu666_modbus']) {
    reset();
    const seen = await readAll(driverId);
    const expected = SPEC.DRIVER_SPEC_REGISTERS[driverId]
      .filter((r) => r.type && r.rw !== 'WO')
      .map((r) => r.address)
      .sort(ascending);

    assert.deepStrictEqual([...seen.asked].sort(ascending), expected,
      `${driverId}: the walk does not cover the readable registers exactly once`);
  }
});

test('it tiles the plan whatever size the caller asks for', async () => {
  // The caller varies the size as it goes, so the tiling has to hold at every size rather
  // than only at the one the walk happens to start with.
  const expected = SPEC.INVERTER_SPEC_REGISTERS
    .filter((r) => r.type && r.rw !== 'WO').map((r) => r.address).sort(ascending);
  for (const count of [1, 2, 3, 7, 16]) {
    reset();
    const seen = await readAll('sun2000_modbus', undefined, count);
    assert.deepStrictEqual([...seen.asked].sort(ascending), expected,
      `a walk in pieces of ${count} groups did not cover the list exactly once`);
  }
});

test('the caller decides how much is read, and gets what it asked for', async () => {
  // Only the caller can time a reply, and timing it is the only way to know whether this
  // device answers in 190 ms or in 1.6 s. So the size is its decision, not this end's.
  reset();
  const homey = fakeHomey({ sun2000_modbus: [fakeDevice('d-1')] });
  const body = (count) => ({ driverId: 'sun2000_modbus', deviceId: 'd-1', from: 0, count });

  const one  = await api.readDebugSpecRegisters({ homey, body: body(1) });
  const five = await api.readDebugSpecRegisters({ homey, body: body(5) });

  assert.strictEqual(one.requests, 1);
  assert.strictEqual(five.requests, 5);
  assert.ok(five.unanswered.length > one.unanswered.length,
    'asking for five groups read no more registers than asking for one');
});

test('an unreasonable ask is trimmed instead of obeyed', async () => {
  // A caller asking for the whole plan in one call is asking for precisely the failure this
  // was built to avoid, so the ask is capped here as well as sized there.
  reset();
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ sun2000_modbus: [fakeDevice('d-1')] }),
    body:  { driverId: 'sun2000_modbus', deviceId: 'd-1', from: 0, count: 1000 },
  });
  assert.ok(res.requests <= 16, `it read ${res.requests} requests in one call`);
  assert.ok(res.total > res.requests, 'the whole plan went in one call after all');
});

test('the last piece is short, and says how short', async () => {
  // The walk advances by `count`. If the reply claimed the size that was asked for, the
  // walk would step past the end and think it had finished early.
  reset();
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('d-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'd-1', from: 0, count: 8 },
  });
  assert.strictEqual(res.total, 1, 'the meter needs more than one request now');
  assert.strictEqual(res.count, 1, 'it claimed to have read more groups than exist');
});

test('a start past the end is refused rather than read as empty', async () => {
  reset();
  const res = await api.readDebugSpecRegisters({
    homey: fakeHomey({ dtsu666_modbus: [fakeDevice('d-1')] }),
    body:  { driverId: 'dtsu666_modbus', deviceId: 'd-1', from: 99, count: 2 },
  });
  assert.ok(res.error, 'reading past the end produced no error');
  assert.strictEqual(probeCalls.length, 0);
});

test('the registers nobody asks for are reported once, with the first piece', async () => {
  // They belong to no chunk, so reporting them per chunk would either repeat them or lose
  // them depending on where the walk stopped.
  reset();
  const seen = await readAll('sun2000_modbus');
  const expected = SPEC.INVERTER_SPEC_REGISTERS
    .filter((r) => !r.type || r.rw === 'WO').map((r) => r.address).sort(ascending);

  assert.deepStrictEqual(seen.skipped.sort(ascending), expected);
  assert.deepStrictEqual(seen.replies[0].skipped.sort(ascending), expected,
    'the first piece did not carry them');
  for (const res of seen.replies.slice(1)) {
    assert.deepStrictEqual(res.skipped, [], 'a later piece repeated the skipped registers');
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

test('polling stops for each piece and starts again afterwards', async () => {
  reset();
  const dev = fakeDevice('d-1');
  await readAll('sdongle_a_modbus', [dev], 2);

  assert.ok(dev.stopped > 1, 'the walk took more than one piece but paused only once');
  assert.strictEqual(dev.started, dev.stopped,
    'the device was left with its polling stopped between pieces');
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

// Answers each piece in turn, keyed by where it starts, so the walk is exercised rather
// than a single reply. What the reader asked for is recorded too: the size it chooses is
// half of what is being tested.
function runReader(rows, pieceFrom, startingWith = '\u2014') {
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
      api: (method, path, body, cb) => {
        asked.push({ from: body.from, count: body.count });
        cb(null, pieceFrom(body));
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(loadReader(), ctx);
  ctx._specRows[0] = rows;
  ctx.readSpecRegisters('d', 'x', 0);
  return { cells, status, btn, asked };
}

const ROWS = [
  { address: 100, type: 'UINT16', rw: 'RO', specType: 'U16' },   // answers, first piece
  { address: 150, type: 'UINT16', rw: 'RO', specType: 'U16' },   // answers, second piece
  { address: 200, type: 'UINT16', rw: 'RO', specType: 'U16' },   // silent, second piece
  { address: 300, type: 'UINT16', rw: 'WO', specType: 'U16' },   // write-only
  { address: 400, type: null,     rw: 'RW', specType: 'MLD' },   // undecodable
];

// A register answers in each piece on purpose. With only one in the whole walk, a tally that
// assigns instead of adding counts the same — which is how "the summary counts only the last
// piece" once survived the probe.
const PIECES = {
  0: { timestamp: '2026-09-20T12:00:00.000Z', from: 0, count: 1, total: 2, requests: 1,
    values: { 100: 42 }, unanswered: [], skipped: [300, 400] },
  1: { timestamp: '2026-09-20T12:00:05.000Z', from: 1, count: 1, total: 2, requests: 1,
    values: { 150: 7 }, unanswered: [200], skipped: [] },
};
const twoPieces = (body) => PIECES[body.from];

test('the reader walks the plan in order and stops at the end', () => {
  const { asked, btn } = runReader(ROWS, twoPieces);
  assert.deepStrictEqual(asked.map((a) => a.from), [0, 1],
    'the walk did not visit each piece exactly once');
  assert.strictEqual(btn.disabled, false, 'the button stayed disabled after the walk');
});

test('the first ask is a small one', () => {
  // The first call is the only one with nothing measured behind it. Asking big there is how
  // the inverter's walk stalled: fourteen seconds on a page that gives up at twelve.
  const { asked } = runReader(ROWS, twoPieces);
  assert.ok(asked[0].count <= 2, `the first call asked for ${asked[0].count} groups`);
});

test('a device that answers quickly is asked for more next time', () => {
  // The stub replies instantly, which is the fast end of the range the field showed. The
  // walk has to notice and stop paying a connection per two requests.
  const { asked } = runReader(ROWS, twoPieces);
  assert.ok(asked[1].count > asked[0].count,
    `the second call still asked for ${asked[1].count} after an instant reply`);
});

test('the walk advances by what was read, not by what it asked for', () => {
  // The last piece is short. Advancing by the ask would step past the end and call the walk
  // finished with registers still unread.
  const short = {
    0: { timestamp: '2026-09-20T12:00:00.000Z', from: 0, count: 1, total: 3, requests: 1,
      values: { 100: 42 }, unanswered: [], skipped: [] },
    1: { timestamp: '2026-09-20T12:00:01.000Z', from: 1, count: 1, total: 3, requests: 1,
      values: { 150: 7 }, unanswered: [], skipped: [] },
    2: { timestamp: '2026-09-20T12:00:02.000Z', from: 2, count: 1, total: 3, requests: 1,
      values: {}, unanswered: [200], skipped: [] },
  };
  const { asked } = runReader(ROWS, (body) => short[body.from]);
  assert.deepStrictEqual(asked.map((a) => a.from), [0, 1, 2],
    'the walk skipped a piece by trusting its own ask');
});

test('each of the three answers leaves a different mark on the row', () => {
  const { cells } = runReader(ROWS, twoPieces);

  assert.match(cells['sv-0-100'].innerHTML, /42/, 'the value did not reach its cell');
  assert.match(cells['sv-0-200'].innerHTML, /val-error/, 'silence does not read as silence');
  assert.match(cells['sv-0-300'].innerHTML, /specWriteOnly/, 'a write-only row lost its reason');
  assert.strictEqual(cells['sv-0-400'].innerHTML, '\u2014',
    'a row skipped for its type was overwritten, losing the type it was showing');

  const marks = new Set(Object.values(cells).map((c) => c.innerHTML));
  assert.strictEqual(marks.size, 5, 'two different outcomes render alike');
});

test('a register reading zero shows the zero', () => {
  const { cells } = runReader(ROWS, () => ({
    timestamp: '2026-09-20T12:00:00.000Z', from: 0, count: 1, total: 1,
    values: { 100: 0 }, unanswered: [], skipped: [],
  }));
  assert.match(cells['sv-0-100'].innerHTML, />0</, 'a zero was swallowed');
});

test('the summary counts the whole walk, not just its last piece', () => {
  const { status } = runReader(ROWS, twoPieces);
  // two, one from each piece — the point of the test
  assert.match(status.textContent, /2 settings\.registers\.specAnswered/);
  assert.match(status.textContent, /1 settings\.registers\.specSilent/);
  assert.match(status.textContent, /2 settings\.registers\.specNotAsked/);
});

test('a piece that fails keeps what the earlier ones already found', () => {
  // This is the whole reason the read is walked rather than done in one call: half an answer
  // is worth keeping, and throwing it away would look like the device had nothing.
  const replies = {
    0: PIECES[0],
    1: { error: 'Connection failed or timed out', from: 1, total: 2 },
  };
  const { cells, status, btn } = runReader(ROWS, (body) => replies[body.from]);

  assert.match(cells['sv-0-100'].innerHTML, /42/, 'the first piece was thrown away');
  assert.match(status.textContent, /Connection failed/);
  assert.match(status.textContent, /specStoppedAfter/, 'it does not say how far it got');
  assert.strictEqual(btn.disabled, false);
});

test('a read that fails at the very first piece does not clear the rows', () => {
  const { cells, status, btn } = runReader(ROWS, () => ({ error: 'Connection failed' }), 'was here');

  assert.match(status.textContent, /Connection failed/);
  assert.strictEqual(btn.disabled, false);
  for (const cell of Object.values(cells)) {
    assert.strictEqual(cell.innerHTML, 'was here',
      'a failed read cleared the rows, which reads as "the device has nothing"');
  }
});
