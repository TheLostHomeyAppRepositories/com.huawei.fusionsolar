'use strict';

// Read Device Identification (FC 0x2B / MEI 0x0E). Run: node --test
//
// Hand-written framing, because jsmodbus implements function codes 1-6, 15 and 16 and not
// this one. Hand-written protocol code is exactly what should not be checked by reading
// it, so every case here runs against a real TCP server that speaks the wire format back.
//
// The point of the function: it asks a device who it is without knowing any register
// address, so a scan can say "answered — Huawei SUN2000" where a register probe can only
// say "answered, nothing recognised". It is OPTIONAL in the Modbus spec, so a null result
// means "did not answer this", never "not a Modbus device".

const test   = require('node:test');
const assert = require('node:assert');
const net    = require('net');

const { readDeviceIdentification } = require('../lib/modbus-client');

// Builds the reply a conforming device sends: MBAP header + the identification PDU.
function deviceIdReply(objects, { unitId = 1, transaction = 1 } = {}) {
  const parts = [Buffer.from([0x2B, 0x0E, 0x01, 0x01, 0x00, 0x00, objects.length])];
  for (const [id, value] of objects) {
    const v = Buffer.from(value, 'latin1');
    parts.push(Buffer.from([id, v.length]), v);
  }
  const pdu = Buffer.concat(parts);
  const frame = Buffer.alloc(7 + pdu.length);
  frame.writeUInt16BE(transaction, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(pdu.length + 1, 4);
  frame.writeUInt8(unitId, 6);
  pdu.copy(frame, 7);
  return frame;
}

// `respond` receives the request the client sent and the socket, so a test can both check
// what went out and decide what comes back.
function withServer(respond, run) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once('data', (req) => { try { respond(req, socket); } catch (e) { reject(e); } });
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await run(server.address().port));
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

const HUAWEI = [[0x00, 'Huawei'], [0x01, 'SUN2000-6KTL-M1'], [0x02, 'V100R001C00SPC172']];

test('a conforming device answers with vendor, product and revision', async () => {
  const got = await withServer(
    (req, socket) => socket.end(deviceIdReply(HUAWEI)),
    (port) => readDeviceIdentification('127.0.0.1', port, 1),
  );
  assert.deepStrictEqual(got, {
    vendorName:  'Huawei',
    productCode: 'SUN2000-6KTL-M1',
    revision:    'V100R001C00SPC172',
  });
});

test('the request is a well-formed FC 43 / MEI 14 frame for the right unit', async () => {
  let seen = null;
  await withServer(
    (req, socket) => { seen = Buffer.from(req); socket.end(deviceIdReply(HUAWEI)); },
    (port) => readDeviceIdentification('127.0.0.1', port, 17),
  );
  assert.ok(seen, 'the server received nothing at all');
  assert.strictEqual(seen.length, 11, 'MBAP header (7) plus a four-byte PDU');
  assert.strictEqual(seen.readUInt16BE(2), 0, 'protocol id must be 0 for Modbus');
  assert.strictEqual(seen.readUInt16BE(4), 5, 'length counts the unit id and the PDU');
  assert.strictEqual(seen[6], 17, 'the unit id asked for is not the one sent');
  assert.deepStrictEqual([...seen.slice(7)], [0x2B, 0x0E, 0x01, 0x00],
    'function code, MEI type, basic-identification code, first object id');
});

// The common case on hardware that does not implement this. It must read as "no answer",
// not as an error worth putting in front of the user.
test('an Illegal Function exception is a quiet null, not a failure', async () => {
  const got = await withServer(
    (req, socket) => {
      const pdu = Buffer.from([0xAB, 0x01]); // 0x2B | 0x80, exception 1
      const frame = Buffer.alloc(9);
      frame.writeUInt16BE(1, 0); frame.writeUInt16BE(0, 2);
      frame.writeUInt16BE(3, 4); frame.writeUInt8(1, 6);
      pdu.copy(frame, 7);
      socket.end(frame);
    },
    (port) => readDeviceIdentification('127.0.0.1', port, 1),
  );
  assert.strictEqual(got, null);
});

// TCP may split a reply anywhere. A reader that assumes one chunk works on a LAN and fails
// on the device that matters, so the split is forced here.
test('a reply arriving in two pieces is still read', async () => {
  const got = await withServer(
    (req, socket) => {
      const frame = deviceIdReply(HUAWEI);
      socket.write(frame.slice(0, 9));                       // mid-PDU, past the header
      setTimeout(() => socket.end(frame.slice(9)), 20);
    },
    (port) => readDeviceIdentification('127.0.0.1', port, 1),
  );
  assert.strictEqual(got && got.vendorName, 'Huawei');
});

test('a device that says nothing at all times out to null', async () => {
  const started = Date.now();
  const got = await withServer(
    () => { /* accept the connection and stay silent */ },
    (port) => readDeviceIdentification('127.0.0.1', port, 1, 300),
  );
  assert.strictEqual(got, null);
  assert.ok(Date.now() - started < 3000, 'the timeout argument was ignored');
});

test('a refused connection is null rather than a thrown error', async () => {
  // Port 1 on loopback: nothing listens, and the connection is refused immediately.
  assert.strictEqual(await readDeviceIdentification('127.0.0.1', 1, 1, 300), null);
});

// A truncated object list must not throw — a device may cut the reply short, and losing
// the last field is better than losing the whole answer.
test('a truncated reply yields what did arrive', async () => {
  const got = await withServer(
    (req, socket) => {
      const full = deviceIdReply(HUAWEI);
      // Claim three objects but stop inside the second one.
      const cut = full.slice(0, 7 + 7 + 8 + 3);
      cut.writeUInt16BE(cut.length - 6, 4);
      socket.end(cut);
    },
    (port) => readDeviceIdentification('127.0.0.1', port, 1),
  );
  assert.strictEqual(got && got.vendorName, 'Huawei');
  assert.ok(!(got && got.revision), 'the field that never arrived was invented');
});
