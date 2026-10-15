'use strict';

// Step 1 after re-reading Easee's Smart Charging page (1.3.3). Run: node --test
//
// Andi, 2026-10-16: "Ja, 1 bauen".
//   - Easee keeps charging profiles in flash: "Lifetime write and erases: 100,000 cycles. Daily
//     recommended maximum writes: 25 schedules. Exceeding the recommended figure … will void
//     your warranty." A profile the charger already holds is not written again, and every
//     write is counted in the log against the 25.
//   - Easee's own keys — LockConnectorPhaseMode, DynamicChargerCurrent, DynamicCircuitCurrent,
//     FreeCharging, FreeChargingIdTag — are documented for its cloud OCPP only. They are read
//     out one by one at every connection, so the next field log says which firmware 344 knows,
//     and whether a DynamicChargerCurrent of 0 holds the charger at 0 A ("the lowest limit
//     will always apply").

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
const Huawei     = require('../drivers/smartcharger_ocpp/device.js');

const KEYS = ['LockConnectorPhaseMode', 'DynamicChargerCurrent', 'DynamicCircuitCurrent', 'FreeCharging', 'FreeChargingIdTag'];

function server(proto, { answer } = {}) {
  const logs = [];
  const s = new OcppServer({ log: (...a) => logs.push(a.join(' ')), error: () => {} });
  s.logs = logs;
  s.calls = [];
  s._sendCallAsync = async (_ws, action, payload) => {
    s.calls.push([action, payload]);
    return answer ? answer(action, payload) : { status: 'Accepted' };
  };
  const ws = { readyState: 1, OPEN: 1 };
  s._devices.set('EH12AB34', Object.create(proto));
  s._clients.set('EH12AB34', ws);
  return { s, ws };
}
const profiles = (s) => s.calls.filter(([a]) => a === 'SetChargingProfile')
  .map(([, p]) => p.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit);

// ── the keys read out ───────────────────────────────────────────────────────

test('an Easee has its own keys read out one by one, last, and the log says each', async () => {
  const known = { LockConnectorPhaseMode: 'Auto', DynamicChargerCurrent: '0' };
  const { s, ws } = server(Easee.prototype, {
    answer: (action, p) => {
      if (action !== 'GetConfiguration') return { status: 'Accepted' };
      const key = p.key[0];
      return key in known
        ? { configurationKey: [{ key, readonly: false, value: known[key] }] }
        : { configurationKey: [], unknownKey: [key] };
    },
  });
  await s._configureCharger('EH12AB34', ws);
  const reads = s.calls.filter(([a]) => a === 'GetConfiguration').map(([, p]) => p.key);
  assert.deepStrictEqual(reads, KEYS.map((k) => [k]), 'not one key per request, or not all of them');
  const order = s.calls.map(([a]) => a);
  assert.ok(order.lastIndexOf('TriggerMessage') < order.indexOf('GetConfiguration'), 'the readings were asked for after the read-out');
  assert.ok(s.logs.includes('[OcppServer] EH12AB34 keeps LockConnectorPhaseMode = Auto'));
  assert.ok(s.logs.includes('[OcppServer] EH12AB34 keeps DynamicChargerCurrent = 0'));
  assert.ok(s.logs.includes('[OcppServer] EH12AB34 does not know FreeCharging'), s.logs.join('\n'));
});

test('a Huawei is not asked for Easee keys', async () => {
  const { s, ws } = server(Huawei.prototype);
  await s._configureCharger('EH12AB34', ws);
  assert.ok(!s.calls.some(([a]) => a === 'GetConfiguration'));
});

// ── the flash ───────────────────────────────────────────────────────────────

test('a profile the Easee already holds is not written again; another one is', async () => {
  const { s } = server(Easee.prototype);
  assert.deepStrictEqual(await s.setMaxCurrentAsync('EH12AB34', 10, 3), { status: 'Accepted' });
  const again = await s.setMaxCurrentAsync('EH12AB34', 10, 3);
  assert.deepStrictEqual(again, { status: 'Accepted', unchanged: true });
  await s.setMaxCurrentAsync('EH12AB34', 16, 3);
  await s.setMaxCurrentAsync('EH12AB34', 16, 3);
  await s.setTxProfileAsync('EH12AB34', 7, 16, 3);   // the Easee gets the default profile, same one
  assert.deepStrictEqual(profiles(s), [10, 16]);
  assert.ok(s.logs.some((l) => /EH12AB34: default profile 16 A unchanged — not written again/.test(l)));
});

test('a refused profile is not remembered, and a new connection writes it once more', async () => {
  let refuse = true;
  const { s } = server(Easee.prototype, { answer: () => ({ status: refuse ? 'Rejected' : 'Accepted' }) });
  await s.setMaxCurrentAsync('EH12AB34', 10, 3);
  refuse = false;
  await s.setMaxCurrentAsync('EH12AB34', 10, 3);
  assert.deepStrictEqual(profiles(s), [10, 10], 'the refused profile counted as held');
  s._clients.set('EH12AB34', { readyState: 1, OPEN: 1 });   // the charger reconnected
  await s.setMaxCurrentAsync('EH12AB34', 10, 3);
  assert.deepStrictEqual(profiles(s), [10, 10, 10]);
});

test('every write is counted against the 25 a day, and the 26th is called out', async () => {
  const { s } = server(Easee.prototype);
  for (let a = 6; a <= 31; a++) await s.setMaxCurrentAsync('EH12AB34', a, 3);
  assert.ok(s.logs.includes('[OcppServer] EH12AB34: charging profile 1 of 25 today'));
  assert.ok(s.logs.includes('[OcppServer] EH12AB34: charging profile 25 of 25 today'));
  assert.ok(s.logs.includes('[OcppServer] EH12AB34: charging profile 26 today — more than the 25 a day its maker advises (flash wear)'));
});

test('a Huawei is written every time and not counted, as before', async () => {
  const { s } = server(Huawei.prototype);
  await s.setMaxCurrentAsync('EH12AB34', 10, 3);
  await s.setMaxCurrentAsync('EH12AB34', 10, 3);
  assert.strictEqual(profiles(s).length, 2);
  assert.ok(!s.logs.some((l) => /charging profile \d/.test(l)));
});

test('the Easee device names its budget and its keys', () => {
  const d = Object.create(Easee.prototype);
  assert.strictEqual(d.ocppProfileWritesPerDay, 25);
  assert.deepStrictEqual(d.ocppReadKeys(), KEYS);
});

test('with auto-start off, the Easee is not sent its 0 A every five minutes', () => {
  const d = Object.create(Easee.prototype);
  let intervals = 0;
  d.getSetting = (k) => ({ auto_start_charging: false })[k];
  d.homey = { setInterval: () => { intervals++; return 1; }, clearInterval: () => {} };
  d.log = () => {};
  d._idleGuardTimer = null;
  d._startIdleGuard();
  assert.strictEqual(intervals, 0, '288 profile writes a day');
});
