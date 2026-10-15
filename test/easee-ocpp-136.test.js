'use strict';

// Andi's Easee log of 2026-10-16 00:16 (1.3.6). Run: node --test
//
//   [Easee] Restored session: txnId=1792100076, amps=16, owner=user
//   ← StatusNotification {"status":"Preparing"}
//   [Easee] Charge Now: 16A
//   → SetChargingProfile … setTxProfile response: {"status":"Rejected"}
//   [Easee] Charging limit set to 16A                       (six times, every one Rejected)
//
// The app had restored a transaction from its store that the Easee no longer had: it reported
// Preparing — car plugged in, no transaction. Every limit went out as a TxProfile naming that
// transaction, the Easee refused each one, the log said "set" all the same, and "Charge now"
// raised a limit instead of starting. The starting current was never sent either: a device with
// a transaction leaves the default profile alone.

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

function easee({ answer = () => ({ status: 'Accepted' }) } = {}) {
  const d = Object.create(Easee.prototype);
  d.sent = []; d.logs = []; d.caps = {}; d.triggers = []; d.timers = [];
  d.settings = { station_id: 'EH12AB34', number_of_phases: '3', default_charging_amps: '10', auto_start_charging: true };
  d.getSetting = (k) => d.settings[k];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d._set = async (c, v) => { d.caps[c] = v; };
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.hasCapability = () => true;
  d.setStoreValue = async () => {};
  d._postNotification = async () => {};
  d.homey = {
    setTimeout: (fn) => { d.timers.push(fn); return d.timers.length; }, clearTimeout: () => {},
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (_dev, tokens) => { d.triggers.push([id, tokens]); } }) },
  };
  d._ocppServer = () => ({
    setTxProfileAsync: async (_s, txn, amps) => { d.sent.push(['TxProfile', txn, amps]); return answer(amps); },
    setMaxCurrentAsync: async (_s, amps) => { d.sent.push(['TxDefault', amps]); return answer(amps); },
    remoteStartAsync: async () => { d.sent.push(['RemoteStart']); return { status: 'Accepted' }; },
  });
  Object.assign(d, {
    _txnId: 1792100076, _txnAmps: 16, _txnStartTime: Date.now() - 3600_000, _txnMeterStart: 0,
    _autoStartBlocked: false, sessionPhaseOverride: null, stitchedSession: null, isPaused: false,
    _pendingTxProfileTimer: null, _staleTxnTimer: null, _lastRawStatus: null, pendingStartAmps: null,
  });
  return d;
}

// ── every limit as the default profile ──────────────────────────────────────

test('an Easee gets its limit as the default profile even during a transaction; a Huawei a TxProfile', async () => {
  const s = new OcppServer({ log() {}, error() {} });
  const calls = [];
  s._sendCallAsync = async (_ws, action, payload) => { calls.push(payload); return { status: 'Accepted' }; };
  const ws = { readyState: 1, OPEN: 1 };
  s._devices.set('EH12AB34', Object.create(Easee.prototype));
  s._devices.set('scharger', Object.create(Huawei.prototype));
  s._clients.set('EH12AB34', ws);
  s._clients.set('scharger', ws);
  await s.setTxProfileAsync('EH12AB34', 1792100076, 12, 3);
  await s.setTxProfileAsync('scharger', 77, 12, 3);
  const [e, h] = calls.map((c) => c.csChargingProfiles);
  assert.strictEqual(e.chargingProfilePurpose, 'TxDefaultProfile');
  assert.strictEqual(e.transactionId, undefined, 'it still names a transaction');
  assert.strictEqual(e.stackLevel, 10);
  assert.deepStrictEqual([e.chargingSchedule.chargingRateUnit, e.chargingSchedule.chargingSchedulePeriod[0].limit], ['A', 12]);
  assert.strictEqual(h.chargingProfilePurpose, 'TxProfile');
  assert.strictEqual(h.transactionId, 77);
});

// ── a transaction the charger no longer has ─────────────────────────────────

function statusOn(d, status) {
  d._setChargingState = async () => {};
  d._updateSessionStatus = async () => {};
  d._handleStateChange = async () => {};
  d.closed = [];
  d.onStopTransaction = async (p) => { d.closed.push(p); };
  d.onStatusNotification({ connectorId: 1, errorCode: 'NoError', status });
}

for (const [status, reason] of [['Preparing', 'Other'], ['Finishing', 'Other'], ['Available', 'EVDisconnected']]) {
  test(`a restored transaction beside ${status} is closed after the grace, as "${reason}"`, () => {
    const d = easee();
    statusOn(d, status);
    assert.strictEqual(d.timers.length, 1, 'nothing watches the transaction');
    assert.deepStrictEqual(d.closed, [], 'closed before the charger could deliver its own stop');
    d.timers[0]();
    assert.strictEqual(d.closed.length, 1);
    assert.deepStrictEqual([d.closed[0].transactionId, d.closed[0].reason, d.closed[0].closedLocally], [1792100076, reason, true]);
    assert.ok(d.logs.some((l) => new RegExp(`it reports ${status} and sent no StopTransaction`).test(l)));
  });
}

test('a transaction beside Charging or a pause is left alone', () => {
  for (const status of ['Charging', 'SuspendedEVSE', 'SuspendedEV']) {
    const d = easee();
    statusOn(d, status);
    assert.strictEqual(d.timers.length, 0, status);
  }
});

test('the charger’s own stop inside the grace wins', () => {
  const d = easee();
  statusOn(d, 'Preparing');
  d._txnId = null;                                   // StopTransaction arrived meanwhile
  d.timers[0]();
  assert.deepStrictEqual(d.closed, []);
});

// ── a refused limit ─────────────────────────────────────────────────────────

test('a refused limit is an error, and nothing claims it was set', async () => {
  const d = easee({ answer: () => ({ status: 'Rejected' }) });
  d.caps.target_current = 10;
  await assert.rejects(d.setChargingLimit(12), /The charger refused 12 A \(Rejected\)/);
  assert.strictEqual(d._txnAmps, 16, 'the refused current became the session’s');
  assert.strictEqual(d.caps.target_current, 10);
  assert.deepStrictEqual(d.triggers, [], '"Charging limit changed" for a limit that is not in force');
  assert.ok(!d.logs.some((l) => /Charging limit set to 12A/.test(l)));
  d._txnId = null;
  await assert.rejects(d.setChargingLimit(8), /The charger refused 8 A/);
  assert.strictEqual(d.pendingStartAmps, null);
});

test('an accepted limit is set as before', async () => {
  const d = easee();
  await d.setChargingLimit(12);
  assert.strictEqual(d._txnAmps, 12);
  assert.strictEqual(d.caps.target_current, 12);
  assert.strictEqual(d.triggers.filter(([t]) => t === 'ocpp_charging_limit_changed').length, 1);
});

// ── MeterValues in the log ──────────────────────────────────────────────────

test('each MeterValues message is logged in one line, value by value', () => {
  const d = easee();
  d._onPower = () => {};
  d._setMeterReading = async () => {};
  d.onMeterValues({ connectorId: 1, transactionId: 12, meterValue: [{ sampledValue: [
    { measurand: 'Power.Active.Import', value: '0', unit: 'W' },
    { measurand: 'Current.Offered', value: '16', unit: 'A' },
    { measurand: 'Current.Import', phase: 'L1', value: '0.1', unit: 'A' },
    { value: '6754000', unit: 'Wh' },
  ] }] });
  assert.ok(d.logs.includes('[Easee] MeterValues (tx 12): Power.Active.Import=0 W, Current.Offered=16 A, '
    + 'Current.Import[L1]=0.1 A, Energy.Active.Import.Register=6754000 Wh'), d.logs.join('\n'));
});
