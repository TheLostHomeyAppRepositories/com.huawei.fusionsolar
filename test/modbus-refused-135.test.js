'use strict';

// Which nulls a device refused, and the bookkeeping surviving the nameplate cache (1.3.5).
// Run: node --test
//
// refused(): a register the device answered with a Modbus exception. Needed to tell the EMMA's
// own unit from the charger behind it — see emma-charger-135.test.js.
//
// The cache: on a block holding a nameplate register, every poll after the first is served
// partly from the cache and rebuilt into a new object. `unread` stayed behind on the old one,
// so notRead() answered false from the second poll on — the SUN2000's optimizer guard
// (1.2.316) and the EMMA charger's held voltages (1.2.321) worked on the first poll only.

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
const modbus = require('../lib/modbus-client.js');
Module._load = _origLoad;

const { readRegisters, notRead, refused } = modbus;

const exception = (code) => Object.assign(new Error('A Modbus Exception Occurred - See Response Body'),
  { response: { body: { code } } });
const respond = (count) => ({ response: { body: { valuesAsBuffer: Buffer.alloc(count * 2, 1) } } });

// Far enough apart that each is a batch of its own.
const REGS = {
  name:     [30000, 1, 'UINT16', '', 0],
  value3:   [32000, 1, 'UINT16', '', 0],
  absent:   [34000, 1, 'UINT16', '', 0],
  timedOut: [36000, 1, 'UINT16', '', 0],
  busy:     [38000, 1, 'UINT16', '', 0],
};
const answer = (start, count) => {
  if (start === 32000) throw exception(3);
  if (start === 34000) throw exception(2);
  if (start === 36000) throw new Error('Req timed out');
  if (start === 38000) throw exception(4);
  return respond(count);
};

test('refused() names what the device said no to, whatever the code — a timeout said nothing', async () => {
  const out = await readRegisters(REGS, { readHoldingRegisters: async (s, c) => answer(s, c) });
  assert.strictEqual(refused(out, 'value3'), true, 'exception 3');
  assert.strictEqual(refused(out, 'busy'), true, 'exception 4');
  assert.strictEqual(refused(out, 'absent'), true, 'exception 2 is a refusal as well');
  assert.strictEqual(refused(out, 'timedOut'), false, 'a timeout is not an answer');
  assert.strictEqual(refused(out, 'name'), false);
  // notRead() is unchanged: exception 2 is "not there", everything else "not read"
  assert.strictEqual(notRead(out, 'absent'), false);
  assert.strictEqual(notRead(out, 'value3'), true);
  assert.strictEqual(notRead(out, 'timedOut'), true);
  assert.ok(!JSON.stringify(Object.keys(out)).includes('refused'), 'the set is not one of the values');
  assert.strictEqual(refused(null, 'x'), false);
  assert.strictEqual(refused({}, 'x'), false);
});

async function withServer(fn) {
  const srv = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port); } finally { await new Promise((r) => srv.close(r)); }
}

test('a poll served partly from the nameplate cache still says what was not read and what was refused', async () => {
  modbus._resetStaticCache();
  const regs = {
    offeringName: [30000, 1, 'UINT16', '', 0],   // 30000 is a nameplate address: cached
    voltage:      [30500, 1, 'UINT16', '', 0],
    energy:       [33000, 1, 'UINT16', '', 0],   // a batch of its own
  };
  let poll = 0;
  setFakeRead((start, count) => {
    if (poll === 2 && start === 30500) throw new Error('Req timed out');
    if (poll === 2 && start === 33000) throw exception(3);
    return respond(count);
  });
  try {
    await withServer(async (port) => {
      poll = 1;
      await modbus.readModbusRegisters('127.0.0.1', port, 3, regs);
      poll = 2;
      const second = await modbus.readModbusRegisters('127.0.0.1', port, 3, regs);
      assert.notStrictEqual(second.offeringName, null, 'the name did not come from the cache');
      assert.strictEqual(notRead(second, 'voltage'), true, 'a timed-out register counted as read — the 1.2.316 guard is off');
      assert.strictEqual(refused(second, 'energy'), true);
      assert.strictEqual(refused(second, 'voltage'), false);
      assert.deepStrictEqual(Object.keys(second), Object.keys(regs));
    });
  } finally { setFakeRead(null); }
});
