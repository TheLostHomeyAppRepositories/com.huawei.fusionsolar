'use strict';

// Andi's Easee log of 2026-10-16 00:24–00:26, firmware 344. Run: node --test
//
// 1. Right after its boot the Easee answered none of the calls the server had sent at once —
//    configuration, boot profile, starting current, a card — and dropped the connection after
//    43 s. After the reconnect every call was answered. OCPP-J 1.6, 4.1.1: no new CALL until
//    every earlier one is answered or timed out; the library behind evcc queues per charger.
// 2. Then the start worked — profile 16 A Accepted, RemoteStart Accepted, StartTransaction —
//    and the Easee went SuspendedEVSE with Current.Offered = 0 A. Something held it at 0 A.
//    The device now says so on the tile and asks the charger for its own schedule, which tells
//    OCPP (0 A there) from a limit outside it (16 A there: the Easee app or cloud, a schedule,
//    the circuit).

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');

const OcppServer = require('../lib/ocpp-server.js');
const Easee      = require('../drivers/easee_ocpp/device.js');

function socket() {
  return { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } };
}
const answer = (s, ws, i, payload = { status: 'Accepted' }) => s._onMessage('X', ws, [3, ws.sent[i][1], payload]);
const tick = () => new Promise((r) => setImmediate(r));

// ── one call at a time ──────────────────────────────────────────────────────

test('a second call waits until the first is answered', async () => {
  const s = new OcppServer({ log() {}, error() {} });
  const ws = socket();
  const first  = s._sendCallAsync(ws, 'ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '30' });
  const second = s._sendCallAsync(ws, 'SetChargingProfile', { connectorId: 1 });
  await tick();
  assert.deepStrictEqual(ws.sent.map((m) => m[2]), ['ChangeConfiguration'], 'both went out at once');
  answer(s, ws, 0);
  assert.deepStrictEqual(await first, { status: 'Accepted' });
  await tick();
  assert.deepStrictEqual(ws.sent.map((m) => m[2]), ['ChangeConfiguration', 'SetChargingProfile']);
  answer(s, ws, 1, { status: 'Rejected' });
  assert.deepStrictEqual(await second, { status: 'Rejected' });
});

test('a call that times out lets the next one go, and the next one’s clock starts when it is sent', async () => {
  const s = new OcppServer({ log() {}, error() {} });
  const ws = socket();
  const first  = s._sendCallAsync(ws, 'GetConfiguration', {}, 30);
  const second = s._sendCallAsync(ws, 'TriggerMessage', {}, 20);   // shorter than the wait before it
  await assert.rejects(first, /timed out after 30ms/);
  await tick();
  assert.strictEqual(ws.sent.length, 2);
  answer(s, ws, 1);                                  // within its own 20 ms, though 30 have passed since it was queued
  assert.deepStrictEqual(await second, { status: 'Accepted' });
});

test('two chargers do not wait for each other', async () => {
  const s = new OcppServer({ log() {}, error() {} });
  const a = socket(), b = socket();
  s._sendCallAsync(a, 'Reset', {}, 50).catch(() => {});
  s._sendCallAsync(b, 'Reset', {}, 50).catch(() => {});
  await tick();
  assert.deepStrictEqual([a.sent.length, b.sent.length], [1, 1]);
});

// ── a charger that offers less ──────────────────────────────────────────────

function easee(schedule) {
  const d = Object.create(Easee.prototype);
  d.logs = []; d.caps = {}; d.asked = [];
  d.getSetting = (k) => ({ station_id: 'EH12AB34', number_of_phases: '3' })[k];
  d.log = (...a) => d.logs.push(a.join(' '));
  d._set = async (c, v) => { d.caps[c] = v; };
  d._onPower = () => {};
  d._setMeterReading = async () => {};
  d._ocppServer = () => ({
    getCompositeScheduleAsync: async (...args) => { d.asked.push(args); return schedule; },
  });
  Object.assign(d, { _txnId: 1792103057, _txnAmps: 16, _autoStartBlocked: false, stitchedSession: null });
  return d;
}
const offered = (d, a) => d.onMeterValues({ connectorId: 1, transactionId: 1792103057, meterValue: [{ sampledValue: [
  { measurand: 'Current.Offered', value: String(a), unit: 'A' },
] }] });

test('offered 0 A of 16 A: on the tile, and the charger asked for its own schedule — once', async () => {
  const d = easee({ status: 'Accepted', chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }] } });
  offered(d, '0.000');
  assert.strictEqual(d.caps.ocpp_last_message, 'MeterValues received');
  offered(d, '0.000');
  await tick();
  assert.strictEqual(d.caps.ocpp_last_message, 'Offers 0 A, set 16 A');
  assert.deepStrictEqual(d.asked, [['EH12AB34', 1, 60]]);
  assert.ok(d.logs.some((l) => /Its own schedule: Accepted — 16 A now \(so the lower current comes from outside OCPP: the Easee app or cloud/.test(l)), d.logs.join('\n'));
  offered(d, '0.000');
  await tick();
  assert.strictEqual(d.asked.length, 1, 'asked again on every reading');
  offered(d, '16.000');
  assert.strictEqual(d.caps.ocpp_last_message, 'MeterValues received', 'the note outlived the mismatch');
});

test('a schedule at 0 A says OCPP holds it; one that cannot be read says so', async () => {
  const d = easee({ status: 'Accepted', chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 0 }] } });
  offered(d, '0'); offered(d, '0');
  await tick();
  assert.ok(d.logs.some((l) => /0 A now \(so OCPP itself holds it at 0\)/.test(l)), d.logs.join('\n'));
  const e = easee(null);
  e._ocppServer = () => ({ getCompositeScheduleAsync: async () => { throw new Error('NotImplemented: GetCompositeSchedule'); } });
  offered(e, '0'); offered(e, '0');
  await tick();
  assert.ok(e.logs.some((l) => /Its own schedule could not be read: NotImplemented/.test(l)));
});

test('the server asks for the schedule in amperes on connector 1', async () => {
  const s = new OcppServer({ log() {}, error() {} });
  const calls = [];
  s._sendCallAsync = async (_ws, action, payload) => { calls.push([action, payload]); return { status: 'Accepted' }; };
  s._clients.set('EH12AB34', socket());
  await s.getCompositeScheduleAsync('EH12AB34');
  assert.deepStrictEqual(calls, [['GetCompositeSchedule', { connectorId: 1, duration: 60, chargingRateUnit: 'A' }]]);
});
