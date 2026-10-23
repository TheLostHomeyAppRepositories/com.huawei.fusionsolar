'use strict';

// A device that takes the connection and answers nothing is a failed poll (1.3.5).
// Run: node --test
//
// Log 8db9a58f (2026-10-23, v1.3.4, "Non legge i dati"): a SUN2000 moved from an address that
// refused port 502 to one that accepted it — and then let every request on unit 1 time out.
// The client handed the driver nothing but nulls, the driver said "Poll OK: PV not read this
// time, last value kept" and kept the device available, and each poll took about 70 s. Its
// owner saw no fault anywhere, only no data. Andi: "Ja".

const Module = require('module');
const _origLoad = Module._load;

let _fakeRead = null;
const setFakeRead = (fn) => { _fakeRead = fn; };

Module._load = function (request, parent, isMain) {
  if (request === 'jsmodbus') {
    return {
      client: {
        TCP: class {
          async readHoldingRegisters(start, count) {
            if (!_fakeRead) throw new Error('no read handler installed');
            return _fakeRead(start, count);
          }
        },
      },
    };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const net    = require('net');
const path   = require('path');
const modbus = require('../lib/modbus-client.js');
Module._load = _origLoad;

const { readRegisters, unavailableMessage } = modbus;

const timeout   = () => new Error('Req timed out');
const exception = (code) => Object.assign(new Error('A Modbus Exception Occurred - See Response Body'),
  { response: { body: { code } } });
const respond   = (count) => ({ response: { body: { valuesAsBuffer: Buffer.alloc(count * 2, 1) } } });

// Three batches, far enough apart to stay separate.
const REGS = {
  a: [30000, 1, 'UINT16', '', 0],
  b: [32000, 1, 'UINT16', '', 0],
  c: [34000, 1, 'UINT16', '', 0],
};
const client = (answer, asked = []) => ({
  async readHoldingRegisters(start, count) { asked.push(start); return answer(start, count); },
});

test('every request timed out: a failed poll, flagged, after the plan was asked in full', async () => {
  const asked = [];
  await assert.rejects(
    readRegisters(REGS, client(() => { throw timeout(); }, asked), null, { failIfSilent: true }),
    (err) => err.modbusSilent === true && !err.modbusConnectionLost,
  );
  // The plan is not abandoned early: Huawei drops the first request of a connection, so the
  // first batch is asked twice and every batch after it still gets its turn.
  assert.deepStrictEqual(asked, [30000, 30000, 32000, 34000]);
});

test('one answer of any kind and the poll stands, with its nulls', async () => {
  const cases = {
    'a value':       (s, c) => { if (s === 34000) return respond(c); throw timeout(); },
    'an exception':  (s) => { if (s === 34000) throw exception(2); throw timeout(); },
    'a late reply':  (s) => { if (s === 34000) throw new Error('fc does not match'); throw timeout(); },
  };
  for (const [what, answer] of Object.entries(cases)) {
    const out = await readRegisters(REGS, client(answer), null, { failIfSilent: true });
    assert.strictEqual(out.a, null, what);
    assert.strictEqual(out.b, null, what);
  }
});

test('the Tester\'s probe still gets its nulls — there an unanswered register is the finding', async () => {
  const out = await readRegisters(REGS, client(() => { throw timeout(); }));
  assert.deepStrictEqual({ ...out }, { a: null, b: null, c: null });
});

test('a poll cut short for a waiting write is not silent', async () => {
  let n = 0;
  const out = await readRegisters(REGS, client(() => { throw timeout(); }), () => ++n > 1, { failIfSilent: true });
  assert.deepStrictEqual({ ...out }, { a: null, b: null, c: null });
});

test('a socket that went keeps its own error', async () => {
  let n = 0;
  const lost = () => (++n === 1 ? timeout() : new Error('no connection to modbus server'));
  await assert.rejects(
    readRegisters(REGS, client(() => { throw lost(); }), null, { failIfSilent: true }),
    (err) => err.modbusConnectionLost === true && !err.modbusSilent,
  );
});

async function withServer(fn) {
  const srv = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port); } finally { await new Promise((r) => srv.close(r)); }
}

test('a silent poll names host, port and unit, is not asked all over again, and counts towards the back-off', async () => {
  modbus._resetStaticCache();
  const asked = [];
  setFakeRead((start) => { asked.push(start); throw timeout(); });
  try {
    await withServer(async (port) => {
      modbus.resetModbusBackoff('127.0.0.1', port);
      const poll = () => modbus.readModbusRegisters('127.0.0.1', port, 1, REGS);

      await assert.rejects(poll(), (err) => {
        assert.strictEqual(err.message,
          `127.0.0.1:${port} accepts the connection but answered no request on unit 1 — every one timed out`);
        assert.strictEqual(err.unitId, 1);
        return err.modbusSilent === true;
      });
      assert.strictEqual(asked.length, 4, `asked ${asked.length} times — the whole poll was repeated`);

      await assert.rejects(poll());
      await assert.rejects(poll());
      asked.length = 0;
      await assert.rejects(poll(), /backing off/);
      assert.strictEqual(asked.length, 0, 'three silent polls and the bus is still being asked');
      modbus.resetModbusBackoff('127.0.0.1', port);
    });
  } finally { setFakeRead(null); }
});

test('the tile says the device took the connection and answered nothing — not that it is off', () => {
  const en = require(path.join('..', 'locales', 'en.json'));
  const homey = { __: (k) => k.split('.').reduce((o, p) => o[p], en) };
  const err = Object.assign(new Error('192.168.50.177:502 accepts the connection but answered no request on unit 1 — every one timed out'),
    { modbusSilent: true, unitId: 1 });
  assert.strictEqual(unavailableMessage(homey, err, '192.168.50.177'),
    '192.168.50.177 accepts the connection but answers no request on unit ID 1. Is this the right device\'s address, '
    + 'and is the unit ID right? The Tester in the app settings tries the usual IDs.');
  // the timeout sentence it would have fallen into otherwise
  assert.match(unavailableMessage(homey, new Error('Req timed out'), '192.168.50.177'), /is not responding/);
});

test('the sentence is there in all three languages, with the host and the unit', () => {
  for (const lang of ['en', 'de', 'nl']) {
    const text = require(path.join('..', 'locales', `${lang}.json`)).modbus.errors.host.silent;
    assert.ok(text && text.includes('{{host}}') && text.includes('{{id}}'), lang);
    assert.match(text, /Tester/, lang);
    assert.doesNotMatch(text, /Home Assistant/i, lang);
  }
});
