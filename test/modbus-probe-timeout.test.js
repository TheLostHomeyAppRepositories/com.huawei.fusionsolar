'use strict';

// What a probe does with the connection it gave up on. Run: node --test
//
// Field-caught 2026-09-03. A unit-ID scan reported that connections opened and that not one
// address returned register content — on a plant whose inverter, asked on its own from
// another machine, answers all five of its registers in 1.6 s. The scan was not failing to
// reach the hardware; it was ruining the hardware's state for itself.
//
// probeModbusUnit raced the read against a timeout, and a race only abandons the loser.
// When the timeout won it returned null and released the host lock while the connection was
// still open and still working through the registers it had been asked for, one response
// timeout at a time. The next unit ID then opened a second connection to a device that
// accepts exactly one — so one slow address emptied every address after it.
//
// Socket lifetime cannot be checked by reading the code, so these run against a real server
// that accepts connections and never answers, which is precisely the case that times out.

const test   = require('node:test');
const assert = require('node:assert');
const net    = require('net');

const { probeModbusUnit } = require('../lib/modbus-client');

// Must clear POST_CONNECT_MS (1 s) so the probe reaches an actual read before giving up —
// timing out during the settling delay would exercise a different path.
const TIMEOUT_MS = 1400;
const REGISTERS = {
  a: [30000, 2, 'UINT32', '', 0],
  b: [37100, 1, 'UINT16', '', 0],
};

// Accepts connections, answers nothing, and keeps count of how many are open at once.
//
// resume() is not decoration. A server socket nobody reads from stays paused, and a paused
// stream never processes the incoming FIN — so it reports the connection as open long after
// the peer has gone. Written without it, this file accused the fix below of doing nothing
// while the client end was demonstrably destroyed. The request jsmodbus sends has to be
// consumed for a close to be observable at all.
function silentServer() {
  const state = { open: 0, maxOpen: 0, total: 0, closedAt: [] };
  const server = net.createServer((socket) => {
    state.open += 1;
    state.total += 1;
    state.maxOpen = Math.max(state.maxOpen, state.open);
    socket.resume();
    socket.on('error', () => { /* a destroyed peer arrives as ECONNRESET */ });
    socket.on('close', () => { state.open -= 1; state.closedAt.push(Date.now()); });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ state, server, port: server.address().port }));
  });
}

test('a probe that times out tears down the connection it opened', async () => {
  const { state, server, port } = await silentServer();
  try {
    const got = await probeModbusUnit('127.0.0.1', port, 1, REGISTERS, TIMEOUT_MS);
    const resolvedAt = Date.now();
    assert.strictEqual(got, null, 'a server that never answers must read as no response');
    assert.strictEqual(state.total, 1, 'the probe did not connect at all');
    assert.strictEqual(state.open, 0,
      'the probe returned while its connection was still open — the next unit ID would open '
      + 'a second one on a device that accepts exactly one');
    // Not just closed eventually, but closed as part of giving up. Left to its own devices
    // the abandoned connection worked on for one response timeout per register.
    assert.ok(resolvedAt - state.closedAt[0] < 500,
      'the connection closed well after the probe returned, so the bus was handed on early');
  } finally {
    server.close();
  }
});

// The consequence, stated as the scan experiences it: two addresses in a row, the first slow.
test('a slow address does not leave a second connection open over the next one', async () => {
  const { state, server, port } = await silentServer();
  try {
    await probeModbusUnit('127.0.0.1', port, 1, REGISTERS, TIMEOUT_MS);
    await probeModbusUnit('127.0.0.1', port, 2, REGISTERS, TIMEOUT_MS);
    assert.strictEqual(state.total, 2, 'both addresses should have been probed');
    assert.strictEqual(state.maxOpen, 1,
      'two connections were open at the same time; Huawei gateways drop the older on a new '
      + 'connect, which is what emptied every address after the first slow one');
  } finally {
    server.close();
  }
});

// The timeout is a bound, not a suggestion. Holding the bus until an unresponsive socket
// finally settles would reintroduce the delay the timeout exists to prevent.
test('giving up stays bounded even though it now waits for the socket', async () => {
  const { server, port } = await silentServer();
  try {
    const started = Date.now();
    await probeModbusUnit('127.0.0.1', port, 1, REGISTERS, TIMEOUT_MS);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= TIMEOUT_MS,
      `returned after ${elapsed} ms, before its own timeout — the budget is not being used`);
    assert.ok(elapsed < TIMEOUT_MS + 3000,
      `${elapsed} ms to give up on one address; the wait for the socket is unbounded`);
  } finally {
    server.close();
  }
});

// A connection that is refused outright must not be dragged through the same wait.
test('a refused connection still fails fast', async () => {
  const started = Date.now();
  const got = await probeModbusUnit('127.0.0.1', 1, 1, REGISTERS, TIMEOUT_MS);
  assert.strictEqual(got, null);
  assert.ok(Date.now() - started < 1000,
    'nothing is listening, so this should fail immediately rather than wait out a timeout');
});
