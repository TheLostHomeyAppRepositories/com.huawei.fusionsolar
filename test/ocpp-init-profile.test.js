'use strict';

// When the charger is sent its starting current. Run: node --test
//
// From a field report of 2026-09-12 — three app restarts, sixteen hours, and one error line
// repeated on every start:
//
//   [OCPP] Restored offline state after restart — waiting for charger (quietly)
//   [OcppServer] Listening on port 8887
//   [OCPP] Init profile 16A failed: Charger OtthoniTolto not connected
//
// The charger never connected at all (the server logs every incoming connection before it
// checks anything, and there was none), so the real fault was in that installation's
// network. But the app had just said it would wait quietly and then, three seconds later,
// announced a failure caused by exactly what it had chosen not to complain about. It was
// the only error in the log, so it was reported as the cause.
//
// Reading it turned up the heavier problem: the starting current was sent once, three
// seconds after the app started, and never again. That serves a charger already connected
// through a restart and nobody else — a charger reconnecting later kept whatever limit it
// had. Invisible with the EMS running, because its next tick writes a value anyway.

const Module = require('module');
const _origLoad = Module._load;

// The device requires the server at module scope; this is the seam that lets a test say
// whether a charger is connected without standing up a WebSocket.
const server = {
  connected: new Set(),
  sent: [],
  fail: null,
  isConnected(stationId) { return server.connected.has(stationId); },
  async setMaxCurrentAsync(stationId, amperes, phases) {
    server.sent.push({ stationId, amperes, phases });
    if (server.fail) throw new Error(server.fail);
    return { status: 'Accepted' };
  },
};

Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/ocpp-server') return { getInstance: () => server };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');

const OcppDevice = require('../drivers/smartcharger_ocpp/device.js');
const OcppServer = require('../lib/ocpp-server.js');

const SETTINGS = {
  station_id: 'OtthoniTolto',
  auto_start_charging: true,
  default_charging_amps: '16',
};

function makeDevice(over = {}) {
  const d = Object.create(OcppDevice.prototype);
  d.logs = [];
  d.log = (msg) => d.logs.push(msg);
  d.error = () => {};
  d._txnId = null;
  d._autoStartBlocked = false;
  d._initialProfileAt = null;
  d._settings = { ...SETTINGS, ...over };
  d.getSetting = (k) => d._settings[k];
  d._getPhases = () => 3;
  d.homey = { setTimeout: (fn, ms) => setTimeout(fn, ms) };
  return d;
}

function reset() {
  server.connected = new Set(['OtthoniTolto']);
  server.sent = [];
  server.fail = null;
}

// ── the noise that was reported as the fault ────────────────────────────────

test('a charger that is not there is not sent anything, and not complained about', async () => {
  reset();
  server.connected.clear();
  const d = makeDevice();

  await d._applyInitialProfile('app restart');

  assert.deepStrictEqual(server.sent, [], 'it tried to send to a charger that is not there');
  assert.deepStrictEqual(d.logs, [], 'it announced a failure it had just promised to keep quiet about');
});

// The point of awaiting the call at all: what the charger answered has to reach the log. A
// line that says "applied" regardless would look identical and tell you nothing.
test('the success log carries the charger’s own answer', async () => {
  reset();
  const d = makeDevice();
  await d._applyInitialProfile('charger connected');
  assert.ok(d.logs.some((l) => /Init profile 16A \(charger connected\).*Accepted/.test(l)),
    `nothing in the log reports the response: ${JSON.stringify(d.logs)}`);
});

test('a real failure from a connected charger is still reported', async () => {
  reset();
  server.fail = 'timeout waiting for response';
  const d = makeDevice();

  await d._applyInitialProfile('app restart');

  assert.strictEqual(server.sent.length, 1, 'it did not even try');
  assert.ok(d.logs.some((l) => /failed: timeout/.test(l)), 'a genuine failure went unsaid');
});

// ── the gap behind it ───────────────────────────────────────────────────────

test('a charger that turns up later still gets its starting current', async () => {
  reset();
  server.connected.clear();
  const d = makeDevice();

  await d._applyInitialProfile('app restart');      // too early — nothing to send to
  assert.deepStrictEqual(server.sent, []);

  server.connected.add('OtthoniTolto');             // the charger dials in
  await d._applyInitialProfile('charger connected');

  assert.strictEqual(server.sent.length, 1);
  assert.strictEqual(server.sent[0].amperes, 16);
});

// Both paths fire within a couple of seconds of each other when the charger was attached
// through a restart. Sending the same profile twice is harmless and says nothing.
test('the two paths together send it once, not twice', async () => {
  reset();
  const d = makeDevice();

  await d._applyInitialProfile('charger connected');
  await d._applyInitialProfile('app restart');

  assert.strictEqual(server.sent.length, 1, 'the same profile went out twice');
});

// Wide enough to cover the gap between the two paths, short enough that a charger
// reconnecting minutes later is served again rather than silently skipped.
test('a charger reconnecting much later is served again', async () => {
  reset();
  const d = makeDevice();

  await d._applyInitialProfile('charger connected');
  d._initialProfileAt = Date.now() - 60_000;        // a minute on
  await d._applyInitialProfile('charger connected');

  assert.strictEqual(server.sent.length, 2);
});

// ── what gets sent ──────────────────────────────────────────────────────────

test('the configured default is what goes out', async () => {
  reset();
  const d = makeDevice({ default_charging_amps: '10' });
  await d._applyInitialProfile('app restart');
  assert.strictEqual(server.sent[0].amperes, 10);
  assert.strictEqual(server.sent[0].phases, 3);
});

test('a nonsensical default falls back rather than sending zero', async () => {
  reset();
  const d = makeDevice({ default_charging_amps: 'sixteen' });
  await d._applyInitialProfile('app restart');
  assert.strictEqual(server.sent[0].amperes, 16, '0 A would block the charger instead');
});

// Auto-start off means "do not charge unless told", which the server sends as a 1 W limit.
test('with auto-start off the charger is blocked, not started', async () => {
  reset();
  const d = makeDevice({ auto_start_charging: false });
  await d._applyInitialProfile('app restart');
  assert.strictEqual(server.sent[0].amperes, 0);
});

// ── what must not be disturbed ──────────────────────────────────────────────

test('a live session is left alone', async () => {
  reset();
  const d = makeDevice();
  d._txnId = 42;

  await d._applyInitialProfile('charger connected');

  assert.deepStrictEqual(server.sent, [], 'it overrode a car that was already charging');
});

test('a blocked session is not a live one', async () => {
  reset();
  const d = makeDevice();
  d._txnId = 42;
  d._autoStartBlocked = true;

  await d._applyInitialProfile('charger connected');
  assert.strictEqual(server.sent.length, 1);
});

// ── both paths are actually wired ───────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const SRC  = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');

test('the connect handler and the restart timer both call it', () => {
  const connect = SRC.slice(SRC.indexOf('onOcppConnected()'));
  assert.match(connect.slice(0, 600), /_applyInitialProfile\('charger connected'\)/);
  assert.match(SRC, /_applyInitialProfile\('app restart'\)/);
});

// ── the server's own answer ─────────────────────────────────────────────────

function serverWith(clients, resolved = {}) {
  const s = Object.create(OcppServer.prototype);
  s._clients = new Map(Object.entries(clients));
  s._resolvedStationIds = new Map(Object.entries(resolved));
  return s;
}

const OPEN = { readyState: 1, OPEN: 1 };
const SHUT = { readyState: 3, OPEN: 1 };

test('isConnected answers about the socket the send methods would use', () => {
  const s = serverWith({ OtthoniTolto: OPEN });
  assert.strictEqual(s.isConnected('OtthoniTolto'), true);
  assert.strictEqual(s.isConnected('SomethingElse'), false);
});

test('a socket that is not open does not count as connected', () => {
  assert.strictEqual(serverWith({ OtthoniTolto: SHUT }).isConnected('OtthoniTolto'), false);
});

// The catch-all device has an empty station id and resolves to whatever actually dialled
// in. Answering about the literal empty string would say "not connected" for a charger
// that is plainly there.
test('a catch-all device resolves to the station that connected', () => {
  const s = serverWith({ Whatever: OPEN }, { '': 'Whatever' });
  assert.strictEqual(s.isConnected(''), true);
});

test('a catch-all with nothing connected is not connected', () => {
  assert.strictEqual(serverWith({}).isConnected(''), false);
});
