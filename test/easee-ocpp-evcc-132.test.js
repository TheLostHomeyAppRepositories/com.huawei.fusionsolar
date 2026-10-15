'use strict';

// A–E from the comparison with evcc's OCPP charger. Run: node --test
//
// Andi, 2026-10-16: "Prüfe nochmals ganz genau, ob wir anhand evcc alles richtig machen …
// Fehlen Capabilities? Fehlen Steuerungen?" — and, on the five gaps found: "Ja, A-E bauen".
//   A. Pause: evcc sets 0 A and keeps the transaction. The copy ended it with RemoteStop,
//      which on an Easee also switches free charging off; the EMS pauses on every stop.
//   B. Phases: evcc offers no switching for an Easee (amperes, no switching key). A charger
//      that ignores the count charges three phases at the current meant for one.
//   C. Current.Offered: what the charger really offers — the place where current control that
//      needs a newer firmware (evcc: beta 9012) shows that it does not take.
//   D. Power: the total, or the phases summed — every value used to overwrite the tile.
//   E. After configuring: Operative, and status and readings asked for at once.

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const { EventEmitter } = require('events');

const OcppServer = require('../lib/ocpp-server.js');
const Easee      = require('../drivers/easee_ocpp/device.js');
const Huawei     = require('../drivers/smartcharger_ocpp/device.js');
const APP        = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

// An Easee device with a session running at 10 A on three phases, and a server that records
// what is sent to the charger.
function easee({ answer = () => ({ status: 'Accepted' }), settings = {} } = {}) {
  const d = Object.create(Easee.prototype);
  d.sent = []; d.logs = []; d.caps = {}; d.triggers = []; d.store = {};
  d.settings = { station_id: 'EH12AB34', number_of_phases: '3', default_charging_amps: '10', auto_start_charging: true, ...settings };
  d.getSetting = (k) => d.settings[k];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d._set = async (c, v) => { d.caps[c] = v; };
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.hasCapability = () => true;
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d._postNotification = async () => {};
  d._recordSession = async () => {};
  d._setMeterReading = async () => {};
  d.homey = {
    setTimeout: () => 0, clearTimeout: () => {},
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (_dev, tokens) => { d.triggers.push([id, tokens]); } }) },
  };
  d._ocppServer = () => ({
    setTxProfileAsync: async (_s, txn, amps, phases) => { d.sent.push(['TxProfile', txn, amps, phases]); return answer('TxProfile', amps); },
    setMaxCurrentAsync: async (_s, amps, phases) => { d.sent.push(['TxDefault', amps, phases]); return answer('TxDefault', amps); },
    remoteStopAsync: async () => { d.sent.push(['RemoteStop']); return { status: 'Accepted' }; },
    remoteStartAsync: async () => { d.sent.push(['RemoteStart']); return { status: 'Accepted' }; },
  });
  Object.assign(d, {
    _txnId: 5, _txnAmps: 10, _txnStartTime: Date.now() - 600_000, _txnMeterStart: 1000,
    _autoStartBlocked: false, sessionPhaseOverride: null, stitchedSession: null, isPaused: false,
    sessionOwner: null, _startVerify: null, _lowPowerSince: null, _carDoneAt: null, _quickAbortCount: 0,
    _pendingTxProfileTimer: null, _pendingStartNotificationTimeout: null, pendingStartAmps: null,
  });
  d.caps.evcharger_charging_state = 'plugged_in_charging';
  d.caps.evcharger_charging = true;
  return d;
}
const fired = (d, id) => d.triggers.filter(([t]) => t === id);

// ── A: pause at 0 A ─────────────────────────────────────────────────────────

test('a pause holds the transaction at 0 A — no RemoteStop', async () => {
  const d = easee();
  await d.pauseCharging();
  assert.deepStrictEqual(d.sent, [['TxProfile', 5, 0, 3]]);
  assert.strictEqual(d._txnId, 5, 'the transaction is kept');
  assert.strictEqual(d.stitchedSession.paused, true);
  assert.strictEqual(d.stitchedSession.holdAtZero, true);
  assert.strictEqual(d.stitchedSession.stopRequested, false, 'no StopTransaction is ours to swallow');
  assert.strictEqual(d.caps.evcharger_charging, false);
  assert.strictEqual(d.caps.session_status, 'paused');
  assert.strictEqual(fired(d, 'ocpp_charging_paused').length, 1);
});

test('the resume raises the same transaction, and "resumed" waits for power', async () => {
  const d = easee();
  await d.pauseCharging();
  d.sent.length = 0;
  await d.resumeCharging();
  assert.deepStrictEqual(d.sent, [['TxProfile', 5, 10, 3]]);
  assert.strictEqual(d.stitchedSession.paused, false);
  assert.strictEqual(d.isPaused, false);
  assert.strictEqual(fired(d, 'ocpp_charging_resumed').length, 0, 'announced before the car draws');
  d._onPower(2100);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fired(d, 'ocpp_charging_resumed').length, 1);
  assert.strictEqual(fired(d, 'ocpp_charging_resumed')[0][1].amps, 10);
});

test('the EMS: 0 A pauses, the next current resumes at that current', async () => {
  const d = easee();
  await d.setChargingLimitFromCard(0);
  assert.deepStrictEqual(d.sent, [['TxProfile', 5, 0, 3]]);
  assert.strictEqual(d.stitchedSession.zeroAmpPause, true);
  await d.setChargingLimitFromCard(7);
  assert.deepStrictEqual(d.sent.at(-1), ['TxProfile', 5, 7, 3]);
  assert.strictEqual(d._txnAmps, 7);
  assert.ok(!d.sent.some(([a]) => a === 'RemoteStop' || a === 'RemoteStart'));
});

test('a new limit while paused waits for the resume instead of lifting the hold', async () => {
  const d = easee();
  await d.pauseCharging();
  d.sent.length = 0;
  await d.setChargingLimit(8);
  assert.deepStrictEqual(d.sent, [], 'it was sent, and the car charged under "paused"');
  assert.strictEqual(d.stitchedSession.resumeAmps, 8);
  assert.strictEqual(d.stitchedSession.paused, true);
  await d.resumeCharging();
  assert.deepStrictEqual(d.sent, [['TxProfile', 5, 8, 3]]);
});

test('a start on a held session resumes it instead of reporting "already charging"', async () => {
  const d = easee();
  await d.pauseCharging();
  d.sent.length = 0;
  await d.startCharging(12);
  assert.deepStrictEqual(d.sent, [['TxProfile', 5, 12, 3]]);
  assert.strictEqual(d.stitchedSession.paused, false);
});

test('unplugged while paused: one session, reported once', async () => {
  const d = easee();
  await d.pauseCharging();
  await d.onStopTransaction({ transactionId: 5, meterStop: 7400, reason: 'EVDisconnected' });
  assert.strictEqual(d.stitchedSession, null);
  assert.strictEqual(d._txnId, null);
  const stopped = fired(d, 'ocpp_charging_stopped');
  assert.strictEqual(stopped.length, 1);
  assert.strictEqual(stopped[0][1].energy_delivered_wh, 6400);
  assert.ok(!d.logs.some((l) => /Masked pause: segment closed/.test(l)), 'the stop was taken for the pause');
});

test('a hold the charger refuses is undone, and the error reaches the flow', async () => {
  const d = easee({ answer: (_w, amps) => ({ status: amps === 0 ? 'Rejected' : 'Accepted' }) });
  await assert.rejects(d.pauseCharging(), /Rejected to the 0 A limit/);
  assert.strictEqual(d.stitchedSession, null);
  assert.strictEqual(d.isPaused, false);
});

test('a held session whose transaction the charger ended meanwhile is started anew', async () => {
  const d = easee();
  await d.pauseCharging();
  d._txnId = null;                                  // the charger closed it while held
  d.sent.length = 0;
  await d.resumeCharging();
  assert.ok(d.sent.some(([a]) => a === 'RemoteStart'), JSON.stringify(d.sent));
});

// ── B: only the wired phase count ───────────────────────────────────────────

test('one phase on a three-phase Easee is refused before anything changes', async () => {
  const d = easee();
  await assert.rejects(d.setChargingLimit(16, 1), /does not switch phases over OCPP/);
  assert.strictEqual(d.sessionPhaseOverride, null, 'the refused phase count stayed behind');
  assert.deepStrictEqual(d.sent, []);
  d._txnId = null;
  await assert.rejects(d._startChargingInner(16, 1), /does not switch phases over OCPP/);
  assert.deepStrictEqual(d.sent, []);
  await d.setChargingLimit(16, 3);
  assert.deepStrictEqual(d.sent, [['TxDefault', 16, 3]]);
});

// ── C: the offered current ──────────────────────────────────────────────────

const mv = (...sampled) => ({ connectorId: 1, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampled }] });

test('the offered current is shown, and a charger that ignores the limit is named after two readings', () => {
  const d = easee();
  d._txnAmps = 8;
  d.onMeterValues(mv({ measurand: 'Current.Offered', value: '16', unit: 'A' }));
  assert.strictEqual(d.caps['measure_current.offered'], 16);
  assert.strictEqual(d.caps.ocpp_last_message, 'MeterValues received', 'one reading may still be the old limit');
  d.onMeterValues(mv({ measurand: 'Current.Offered', value: '16', unit: 'A' }));
  assert.strictEqual(d.caps.ocpp_last_message, 'Offers 16 A, set 8 A');
  assert.ok(d.logs.some((l) => /offers 16 A although 8 A was set .* newer Easee firmware/.test(l)));
  d.onMeterValues(mv({ measurand: 'Current.Offered', value: '16', unit: 'A' }));
  assert.strictEqual(d.logs.filter((l) => /although/.test(l)).length, 1, 'said again on every reading');
  assert.strictEqual(d.caps.ocpp_last_message, 'Offers 16 A, set 8 A', 'the next reading wiped it');
  d.onMeterValues(mv({ measurand: 'Current.Offered', value: '8', unit: 'A' }));
  assert.strictEqual(d.caps.ocpp_last_message, 'MeterValues received');
});

test('a charger that offers less names a limit of its own; per phase, the highest counts', () => {
  const d = easee();
  d._txnAmps = 16;
  for (let i = 0; i < 2; i++) {
    d.onMeterValues(mv(
      { measurand: 'Current.Offered', phase: 'L1', value: '10' },
      { measurand: 'Current.Offered', phase: 'L2', value: '10' },
    ));
  }
  assert.strictEqual(d.caps['measure_current.offered'], 10);
  assert.ok(d.logs.some((l) => /offers 10 A of the 16 A set — a limit of its own/.test(l)));
});

test('paused at 0 A, an offered 0 A is no mismatch', async () => {
  const d = easee();
  await d.pauseCharging();
  for (let i = 0; i < 3; i++) d.onMeterValues(mv({ measurand: 'Current.Offered', value: '0' }));
  assert.ok(!d.logs.some((l) => /offers/.test(l)));
});

test('the manifest has the offered current for the Easee only', () => {
  const easeeDrv = APP.drivers.find((x) => x.id === 'easee_ocpp');
  assert.ok(easeeDrv.capabilities.includes('measure_current.offered'));
  assert.deepStrictEqual(easeeDrv.capabilitiesOptions['measure_current.offered'].title,
    { en: 'Offered current', de: 'Angebotener Strom', nl: 'Aangeboden stroom' });
  assert.ok(!APP.drivers.find((x) => x.id === 'smartcharger_ocpp').capabilities.includes('measure_current.offered'));
  const conf = Object.fromEntries(Object.create(Easee.prototype).ocppConfiguration());
  assert.ok(conf.MeterValuesSampledData[0].includes('Current.Offered'));
  assert.strictEqual(conf.MeterValuesSampledData.at(-1), 'Energy.Active.Import.Register,Power.Active.Import,Current.Import',
    'evcc’s three stay the last resort');
});

// ── D: power per phase ──────────────────────────────────────────────────────

test('power per phase is summed, a total wins over the phases, and energy likewise', () => {
  const d = easee();
  const meter = [];
  d._setMeterReading = async (wh) => { meter.push(wh); };
  d.onMeterValues(mv(
    { measurand: 'Power.Active.Import', phase: 'L1', value: '2300' },
    { measurand: 'Power.Active.Import', phase: 'L2', value: '2310' },
    { measurand: 'Power.Active.Import', phase: 'L3', value: '2290' },
  ));
  assert.strictEqual(d.caps.measure_power, 6900, 'the tile showed the last phase alone');
  d.onMeterValues(mv(
    { measurand: 'Power.Active.Import', value: '6.95', unit: 'kW' },
    { measurand: 'Power.Active.Import', phase: 'L1', value: '2300' },
  ));
  assert.strictEqual(d.caps.measure_power, 6950);
  d.onMeterValues(mv(
    { measurand: 'Energy.Active.Import.Register', phase: 'L1', value: '1000' },
    { measurand: 'Energy.Active.Import.Register', phase: 'L2', value: '1100' },
  ));
  assert.deepStrictEqual(meter, [2100]);
});

test('a resume is announced from summed phase power too', async () => {
  const d = easee();
  await d.pauseCharging();
  await d.resumeCharging();
  d.onMeterValues(mv(
    { measurand: 'Power.Active.Import', phase: 'L1', value: '60' },
    { measurand: 'Power.Active.Import', phase: 'L2', value: '60' },
  ));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fired(d, 'ocpp_charging_resumed').length, 1, '120 W summed is power flowing');
});

// ── E: after configuring ────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; }
  send() {} ping() {} close() { this.readyState = 3; this.emit('close'); } terminate() { this.close(); }
}

test('an Easee is made operative and asked for its status and readings; a Huawei is not', async () => {
  for (const [proto, expected] of [
    [Easee.prototype, [
      ['ChangeAvailability', { connectorId: 0, type: 'Operative' }],
      ['TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 1 }],
      ['TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 }],
    ]],
    [Huawei.prototype, []],
  ]) {
    const logs = [];
    const s = new OcppServer({ log: (...a) => logs.push(a.join(' ')), error: () => {} });
    const calls = [];
    s._sendCallAsync = async (_ws, action, payload) => { calls.push([action, payload]); return { status: 'Accepted' }; };
    s._devices.set('X', Object.create(proto));
    await s._configureCharger('X', new FakeSocket());
    assert.deepStrictEqual(calls.filter(([a]) => a !== 'ChangeConfiguration' && a !== 'GetConfiguration'), expected);
    if (expected.length) {
      assert.ok(logs.includes('[OcppServer] TriggerMessage {"requestedMessage":"MeterValues","connectorId":1} → Accepted'), logs.join('\n'));
      // After the keys: the readings asked for are sampled the way just configured.
      const order = calls.map(([a]) => a);
      assert.ok(order.lastIndexOf('ChangeConfiguration') < order.indexOf('ChangeAvailability'));
    }
  }
});

test('an answer that fails does not stop the next', async () => {
  const s = new OcppServer({ log: () => {}, error: () => {} });
  const calls = [];
  s._sendCallAsync = async (_ws, action, payload) => {
    calls.push(action);
    if (action === 'ChangeAvailability') throw new Error('timed out');
    return { status: 'Accepted' };
  };
  s._devices.set('X', Object.create(Easee.prototype));
  await s._configureCharger('X', new FakeSocket());
  assert.deepStrictEqual(calls.filter((a) => a === 'TriggerMessage').length, 2);
});
