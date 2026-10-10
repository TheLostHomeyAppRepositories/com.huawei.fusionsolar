'use strict';

// Four faults in the OCPP charger driver, found by comparing it with the standalone Huawei EV
// charger app it shares its origin with (2026-10-10, 1.2.327).
//
//   1. Finishing — transaction over, cable still in — was reported to Homey as plugged_out. On a
//      Huawei every stop and every masked pause passes through it, and an EMS tick in that moment
//      read the car as unplugged.
//   2. A start on a running, paused or resuming session sent RemoteStart again, and 3 s later the
//      safety-net profile at the default 16 A, while the EMS believed 6–7 A.
//   3. A masked pause left the last power reading standing — a Huawei sends MeterValues only
//      during a transaction — so the EMS kept counting it as the charger's draw.
//   4. The lifetime energy register took any value, 0 and backwards included: Homey Energy books
//      a fall followed by the real figure as a lifetime of consumption in one day.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const sent = [];
const fakeServer = {
  isConnected: () => true,
  async remoteStartAsync() { sent.push(['RemoteStart']); return { status: 'Accepted' }; },
  async setMaxCurrentAsync(id, amps) { sent.push(['TxDefault', amps]); return { status: 'Accepted' }; },
  async setTxProfileAsync(id, txn, amps) { sent.push(['TxProfile', amps]); return { status: 'Accepted' }; },
  async remoteStopAsync() { sent.push(['RemoteStop']); return { status: 'Accepted' }; },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/ocpp-server') return { getInstance: () => fakeServer, existing: () => fakeServer };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice = require(path.join('..', 'drivers', 'smartcharger_ocpp', 'device.js'));
Module._load = origLoad;

function charger(caps = {}) {
  sent.length = 0;
  const d = Object.create(OcppDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.timers = [];
  d.caps = { meter_power: 1000, measure_power: 0, ...caps };
  d.store = {};
  d.settings = { station_id: 'CP1', auto_start_charging: false, default_charging_amps: '16', number_of_phases: '3' };
  d.getSetting = (k) => d.settings[k];
  d.hasCapability = () => true;
  d.getCapabilityValue = (k) => d.caps[k];
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; d.timers.push(t); return t; },
    clearTimeout: (t) => { const i = d.timers.indexOf(t); if (i >= 0) d.timers.splice(i, 1); },
    flow: { getDeviceTriggerCard: () => ({ trigger: () => Promise.resolve() }) },
  };
  d._updateSessionStatus = async () => {};
  d._updateChargingProfile = async () => {};
  d._postNotification = async () => {};
  d._recordSession = async () => {};
  d._handleStateChange = async () => {};
  d._fireFaultTrigger = () => {};
  d._saveSession = async () => {};
  d._getPhases = () => 3;
  d._txnId = null; d._txnAmps = null; d._autoStartBlocked = false;
  d.stitchedSession = null; d._quickAbortCount = 0;
  return d;
}
const fire = async (d) => { const due = d.timers.splice(0); for (const t of due) await t.fn(); await new Promise((r) => setImmediate(r)); };

// ── 1. Finishing ───────────────────────────────────────────────────────────────

test('Finishing tells Homey the car is still plugged in', async () => {
  const d = charger();
  d.onStatusNotification({ connectorId: 1, status: 'Finishing' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(d.caps.evcharger_charging_state, 'plugged_in');
  d.onStatusNotification({ connectorId: 1, status: 'Available' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(d.caps.evcharger_charging_state, 'plugged_out', 'a real unplug is still one');
});

test('the stop that follows a Finishing keeps the car plugged in; one after Available does not', async () => {
  for (const [last, want] of [['Finishing', 'plugged_in'], ['Available', 'plugged_out']]) {
    const d = charger();
    d._txnId = 7; d._txnStartTime = Date.now() - 600_000; d._txnMeterStart = 900_000; d._txnAmps = 10;
    d._internalChargingState = 'idle';
    d._lastRawStatus = last;
    await d.onStopTransaction({ transactionId: 7, meterStop: 1_002_000, reason: 'Local' });
    assert.strictEqual(d.caps.evcharger_charging_state, want, last);
  }
});

test('the EMS counts plugged_in as connected', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'energy_management', 'device.js'), 'utf8');
  const set = /const DISCONNECTED_STATES = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(set, 'the EMS no longer has its list of disconnected states');
  assert.ok(!/'plugged_in'/.test(set[1]));
  assert.ok(/'plugged_out'/.test(set[1]));
});

// ── 2. a start is not a second start ───────────────────────────────────────────

test('a start on a running session sends nothing — and a given current becomes its limit', async () => {
  const d = charger();
  d._txnId = 7; d._txnAmps = 7;
  await d.startCharging();
  assert.deepStrictEqual(sent, [], 'RemoteStart was sent to a running session');
  await d.startCharging(7);
  assert.deepStrictEqual(sent, [], 'the same current again changes nothing');
  await d.startCharging(9);
  assert.deepStrictEqual(sent, [['TxProfile', 9]]);
  assert.strictEqual(d._txnAmps, 9);
});

test('a start on a paused session resumes it — at the given current, or the one it paused with', async () => {
  for (const [amps, want] of [[undefined, 7], [12, 12]]) {
    const d = charger();
    d._txnAmps = 7;
    d.stitchedSession = { paused: true, resumeAmps: 7, accumulatedEnergyWh: 500 };
    let resumed = null;
    d._startChargingInner = async (a) => { resumed = a; };
    await d.startCharging(amps);
    assert.strictEqual(resumed, want);
    assert.strictEqual(d.stitchedSession.paused, false);
    assert.strictEqual(d.stitchedSession.resuming, true);
  }
});

test('a start while a resume is on its way sends nothing, but keeps the current it asked for', async () => {
  const d = charger();
  d.stitchedSession = { paused: true, resumeAmps: 7, accumulatedEnergyWh: 500 };
  d._txnAmps = 7;
  const inner = [];
  d._startChargingInner = async (a) => { inner.push(a); };
  await d.resumeCharging('ems');                 // the EMS's set-current card resumed it
  await d.startCharging();                       // its start card arrives a moment later
  await d.startCharging(8);
  assert.deepStrictEqual(inner, [7], 'a second start went out while the resume was under way');
  assert.strictEqual(d._txnAmps, 8);
  d._resumeStartedAt -= 61_000;                  // a resume that never produced a transaction
  await d.startCharging();
  assert.strictEqual(inner.length, 2, 'a resume stuck forever would block every later start');
});

test('the safety-net profile applies the current in force when it fires', async () => {
  const d = charger();
  await d.startCharging(16);                     // a plain start, nothing running
  assert.deepStrictEqual(sent, [['TxDefault', 16], ['RemoteStart']]);
  d._txnId = 8;                                  // StartTransaction arrived
  d._txnAmps = 7;                                // and something set 7 A since
  sent.length = 0;
  await fire(d);
  assert.deepStrictEqual(sent, [['TxProfile', 7]]);
});

// ── 3. a masked pause draws nothing ────────────────────────────────────────────

test('a masked pause puts power and current to 0', async () => {
  const d = charger({ measure_power: 7350, measure_current: 32, 'measure_current.l1': 10.7, 'measure_current.l2': 10.6, 'measure_current.l3': 10.7 });
  d._txnId = 7; d._txnStartTime = Date.now() - 600_000; d._txnMeterStart = 900_000; d._txnAmps = 10;
  d.stitchedSession = { paused: true, stopRequested: true, accumulatedEnergyWh: 0 };
  await d.onStopTransaction({ transactionId: 7, meterStop: 902_000, reason: 'Remote' });
  assert.strictEqual(d.caps.measure_power, 0, 'the last reading stood for the whole pause');
  for (const c of ['measure_current', 'measure_current.l1', 'measure_current.l2', 'measure_current.l3']) {
    assert.strictEqual(d.caps[c], 0, c);
  }
});

// ── 4. the energy register only goes up ────────────────────────────────────────

const energy = (d, wh) => d.onMeterValues({ connectorId: 1, meterValue: [{ sampledValue: [{ measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: String(wh) }] }] });
const settle = () => new Promise((r) => setImmediate(r));

test('a reading of 0 is not a reading, and a dip is held', async () => {
  const d = charger({ meter_power: 1000 });
  energy(d, 1_000_500); await settle();
  assert.strictEqual(d.caps.meter_power, 1000.5);
  energy(d, 0); await settle();
  assert.strictEqual(d.caps.meter_power, 1000.5, '0 went through — Homey books the recovery as consumption');
  energy(d, 990_000); await settle();
  assert.strictEqual(d.caps.meter_power, 1000.5, 'a reading below the last went through');
  energy(d, 1_001_000); await settle();
  assert.strictEqual(d.caps.meter_power, 1001);
});

test('a stop with meterStop 0 leaves the register alone', async () => {
  const d = charger({ meter_power: 1000.5 });
  d._txnId = 7; d._txnStartTime = Date.now() - 600_000; d._txnMeterStart = 1_000_000; d._txnAmps = 10;
  d._lastRawStatus = 'Finishing';
  await d.onStopTransaction({ transactionId: 7, meterStop: 0, reason: 'Local' });
  assert.strictEqual(d.caps.meter_power, 1000.5);
});

test('a first reading of 0, with no earlier one to compare, is not written either', async () => {
  const d = charger({ meter_power: undefined });
  energy(d, 0); await settle();
  assert.strictEqual(d.caps.meter_power, undefined, 'a 0 became the first meter reading — and the high-water mark');
  energy(d, 1_000_000); await settle();
  assert.strictEqual(d.caps.meter_power, 1000);
});
