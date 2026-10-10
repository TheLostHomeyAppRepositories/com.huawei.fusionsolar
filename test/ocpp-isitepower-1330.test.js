'use strict';

// Six small faults (review 2026-10-10, 1.2.330): two in the iSitePower drivers, four in the OCPP
// charger, the latter found by comparing it with the standalone Huawei EV charger app.
//
//   iSitePower Solar and Battery wrote 0 W whenever the plant delivered nothing — into Insights,
//   to flows comparing the power, and for the battery as "idle", which fired the charging-state
//   cards on every silent spell of the cloud.
//
//   OCPP:
//   1. "Fully charged" was any stop with reason Local — a stop by hand at the charger included.
//   2. The plug-in time was cleared on Finishing, which every stop of a paused car passes through.
//   3. Saving the default current set the running session to it, over the EMS or a flow.
//   4. A start that never drew power still fired "charging stopped", with no start before it.
//   5. The debug record of the last non-zero readings was written to the store for every
//      measurand of every MeterValues.
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
  setCredentials() {},
  renameDevice() {},
  registerDevice() {},
  unregisterDevice() {},
  holderOf: () => null,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, App: class {} };
  if (request === '../../lib/ocpp-server') return { getInstance: () => fakeServer, existing: () => fakeServer };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice    = require(path.join('..', 'drivers', 'smartcharger_ocpp', 'device.js'));
const SolarDevice   = require(path.join('..', 'drivers', 'isitepower_solar_openapi_fusionsolar', 'device.js'));
const BatteryDevice = require(path.join('..', 'drivers', 'isitepower_battery_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const MIN = 60_000;
const tick = () => new Promise((r) => setImmediate(r));

// ── iSitePower ─────────────────────────────────────────────────────────────────

function ispDevice(Cls, caps) {
  const d = Object.create(Cls.prototype);
  d.caps = { ...caps };
  d.store = {};
  d.fired = [];
  d.log = () => {};
  d.error = () => {};
  d.getName = () => 'iSitePower';
  d.getSetting = (k) => ({ poll_interval: 5 }[k]);
  d.hasCapability = () => true;
  d.addCapability = async () => {};
  d.getCapabilityValue = (k) => (k in d.caps ? d.caps[k] : null);
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = { flow: { getDeviceTriggerCard: (id) => ({ trigger: async (_d, t) => { d.fired.push([id, t]); } }) } };
  return d;
}
const kpi = (type, map) => ({ kpiByType: { [type]: [map] }, freshKpiByType: { [type]: [map] } });
const none = { kpiByType: {}, freshKpiByType: {} };

test('iSitePower Solar keeps its last power when the plant delivers nothing', async () => {
  const d = ispDevice(SolarDevice, { measure_power: 1500, measure_current: 6.5 });
  await d.onPollData({ ...none, stationKpi: null });
  assert.strictEqual(d.caps.measure_power, 1500, 'no data was written as 0 W');
  assert.strictEqual(d.caps.measure_current, 6.5);
  await d.onPollData({ ...kpi(60043, { total_output_power: 2.1, total_output_current: 9 }), stationKpi: null });
  assert.strictEqual(d.caps.measure_power, 2100);
  assert.strictEqual(d.caps.measure_current, 9);
});

test('iSitePower Solar still reads 0 when the plant answers without a PV figure', async () => {
  const d = ispDevice(SolarDevice, { measure_power: 1500 });
  await d.onPollData({ ...kpi(60092, { ac_output_apparent_power: 0.4 }), stationKpi: null });
  assert.strictEqual(d.caps.measure_power, 0);
});

test('iSitePower Battery keeps its readings and fires no card when the plant delivers nothing', async () => {
  const d = ispDevice(BatteryDevice, { measure_power: -800, 'measure_power.batt_charge': 0, 'measure_power.batt_discharge': 800, 'meter_power.charged': 12 });
  d._chargedKwh = 12; d._lastEnergyTs = Date.now() - 5 * MIN; d._prevChargingState = 'discharging'; d._prevSoc = 60;
  await d.onPollData(none);
  assert.strictEqual(d.caps.measure_power, -800);
  assert.strictEqual(d.caps['measure_power.batt_discharge'], 800);
  assert.deepStrictEqual(d.fired, [], 'the silence read as "idle"');
  assert.strictEqual(d.caps['meter_power.charged'], 12);
  assert.ok(Date.now() - d._lastEnergyTs < 1000, 'the charge total\'s clock did not move on, so the gap would be booked later');

  await d.onPollData(kpi(60014, { soc: 60, charge_discharge_power: -0.8 }));   // back, still discharging
  assert.deepStrictEqual(d.fired, []);
  await d.onPollData(kpi(60014, { soc: 60, charge_discharge_power: 1.2 }));
  assert.strictEqual(d.caps.measure_power, 1200);
  assert.ok(d.fired.some(([id]) => id === 'luna2000_charging_started'));
});

// ── OCPP ───────────────────────────────────────────────────────────────────────

function charger({ autoStart = true } = {}) {
  sent.length = 0;
  const d = Object.create(OcppDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.timers = [];
  d.fired = [];
  d.caps = { meter_power: 1000, measure_power: 0 };
  d.store = {};
  d.settings = { station_id: 'CP1', ocpp_port: 8887, auto_start_charging: autoStart, default_charging_amps: '16', number_of_phases: '3' };
  d.getSetting = (k) => d.settings[k];
  d.getName = () => 'Charger';
  d.hasCapability = () => true;
  d.getCapabilityValue = (k) => d.caps[k];
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.getStoreValue = (k) => d.store[k];
  // A copy, as Homey stores it: the device goes on changing the object it handed over.
  d.setStoreValue = async (k, v) => { d.store[k] = structuredClone(v); d.storeWrites = (d.storeWrites || 0) + 1; };
  d.homey = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; d.timers.push(t); return t; },
    clearTimeout: (t) => { const i = d.timers.indexOf(t); if (i >= 0) d.timers.splice(i, 1); },
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (_d, tokens) => { d.fired.push([id, tokens]); } }) },
  };
  d._updateSessionStatus = async () => {};
  d._updateChargingProfile = async () => {};
  d._postNotification = async () => {};
  d._recordSession = async () => {};
  d._fireFaultTrigger = () => {};
  d._saveSession = async () => {};
  d._startIdleGuard = () => {};
  d._getPhases = () => 3;
  d._txnId = null; d._txnAmps = null; d._autoStartBlocked = false; d._carDoneAt = null;
  d.stitchedSession = null; d._quickAbortCount = 0; d._lastNonZeroSavedAt = 0;
  return d;
}
const status = async (d, s) => { d.onStatusNotification({ connectorId: 1, status: s }); await tick(); };
const power  = (d, w) => d.onMeterValues({ connectorId: 1, meterValue: [{ sampledValue: [{ measurand: 'Power.Active.Import', value: String(w), unit: 'W' }] }] });
function running(d, txn = 7) {
  d._txnId = txn; d._txnStartTime = Date.now() - 3600_000; d._txnMeterStart = 900_000; d._txnAmps = 10;
  d._internalChargingState = 'charging';
}
const stop = (d, reason, meterStop = 1_002_000) => d.onStopTransaction({ transactionId: d._txnId, meterStop, reason });
const settle = (d) => d._computeSessionStatus('connected');

// 1. fully charged

test('a Local stop after the car said it was done (SuspendedEV) is a full car', async () => {
  const d = charger();
  running(d);
  d._handleStateChange = async () => {};
  await status(d, 'SuspendedEV');
  await stop(d, 'Local');
  assert.strictEqual(settle(d), 'fully_charged');
  assert.strictEqual(d.store.lastStopFull, true);
  assert.strictEqual(d._carDoneAt, null, 'the next session would start out "done"');
});

test('a Local stop with the car still drawing is a stop by hand, not a full car', async () => {
  for (const autoStart of [true, false]) {
    const d = charger({ autoStart });
    running(d);
    power(d, 7000);
    await stop(d, 'Local');
    assert.strictEqual(settle(d), autoStart ? 'connected' : 'smart_charging');
    assert.strictEqual(d.store.lastStopFull, false);
  }
});

test('three minutes under 100 W is the car being done too — and drawing again undoes it', async () => {
  const d = charger();
  running(d);
  power(d, 40);
  d._lowPowerSince -= 3 * MIN;
  power(d, 40);
  assert.ok(d._carDoneAt !== null);
  await stop(d, 'Local');
  assert.strictEqual(settle(d), 'fully_charged');

  const e = charger();
  running(e);
  power(e, 40);
  e._lowPowerSince -= 2 * MIN;
  power(e, 40);
  assert.strictEqual(e._carDoneAt, null, 'two minutes are not three');

  const f = charger();
  running(f);
  f._handleStateChange = async () => {};
  await status(f, 'SuspendedEV');
  f._internalChargingState = 'charging';
  power(f, 6500);
  await stop(f, 'Local');
  assert.strictEqual(settle(f), 'connected', 'the car drew again after its SuspendedEV');
});

test('a SuspendedEV with no transaction says nothing about a session', async () => {
  const d = charger();
  d._handleStateChange = async () => {};
  await status(d, 'SuspendedEV');
  // A charger that starts on its own gets a synthetic transaction without a StartTransaction,
  // so nothing would clear this before that session's stop.
  assert.strictEqual(d._carDoneAt, null);
});

test('only the charger\'s own stop counts — ours (Remote) after a done car is not "fully charged"', async () => {
  const d = charger();
  running(d);
  d._handleStateChange = async () => {};
  await status(d, 'SuspendedEV');
  await stop(d, 'Remote');
  assert.strictEqual(settle(d), 'connected');
});

test('a new transaction starts with the car not done, and a fresh plug-in clears the verdict', async () => {
  const d = charger();
  d._carDoneAt = 123;
  await d.onStartTransaction({ connectorId: 1, meterStart: 1_000_000 }, 8);
  assert.strictEqual(d._carDoneAt, null);

  const e = charger();
  e.lastStopReason = 'Local'; e.lastStopFull = true;
  e._prevState = 'idle'; e._prevRawStatus = 'Available';
  await status(e, 'Preparing');
  assert.strictEqual(e.lastStopFull, false);
  assert.strictEqual(e.store.lastStopFull, false);
});

test('the verdict survives a restart', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');
  assert.ok(/this\.lastStopFull = \(await this\.getStoreValue\('lastStopFull'\)\) === true;/.test(src));
});

// 2. the plug-in time

test('a paused car\'s stop keeps the plug-in time; the unplug reports the whole time', async () => {
  const d = charger({ autoStart: false });
  d._prevState = 'idle'; d._prevRawStatus = 'Available';
  await status(d, 'Preparing');
  assert.ok(d._connectionStart);
  d._connectionStart -= 120 * MIN;
  const pluggedAt = d._connectionStart;
  for (const s of ['SuspendedEV', 'Finishing', 'Preparing']) await status(d, s);
  assert.strictEqual(d._connectionStart, pluggedAt, 'Finishing cleared the plug-in time with the cable still in');
  await status(d, 'Available');
  for (const t of d.timers.splice(0)) await t.fn();
  const gone = d.fired.find(([id]) => id === 'ocpp_disconnected');
  assert.ok(gone);
  assert.strictEqual(gone[1].connected_minutes, 120);
});

// 3. the default current

async function saveDefault(d, amps) {
  await d.onSettings({
    oldSettings: { ...d.settings },
    newSettings: { ...d.settings, default_charging_amps: String(amps) },
    changedKeys: ['default_charging_amps'],
  });
}

test('a new default current leaves the running session at its limit', async () => {
  const d = charger();
  running(d);
  d._txnAmps = 7;
  await saveDefault(d, 10);
  assert.deepStrictEqual(sent, [], 'the running session was set to the new default');
  assert.strictEqual(d._txnAmps, 7);
  assert.ok(d.logs.some((l) => /applies from the next start/.test(l)));
});

test('without a session the new default becomes the resting limit at once', async () => {
  const d = charger();
  await saveDefault(d, 10);
  assert.deepStrictEqual(sent, [['TxDefault', 10]]);
});

test('the stop restores the resting limit from the new default', async () => {
  const d = charger();
  running(d);
  await saveDefault(d, 10);
  d.settings.default_charging_amps = '10';             // what Homey has stored by now
  await stop(d, 'Remote');
  for (const t of d.timers.splice(0)) await t.fn();
  assert.deepStrictEqual(sent, [['TxDefault', 10]]);
});

// 4. a false start

const stoppedCards = (d) => d.fired.filter(([id]) => id === 'ocpp_charging_stopped');

test('a start that never drew power and delivered nothing ends without "charging stopped"', async () => {
  const d = charger();
  running(d);
  d._startVerify = { txId: 7, isMaskedResume: false, activeAmps: 10 };
  await stop(d, 'EVDisconnected', 900_005);
  assert.deepStrictEqual(stoppedCards(d), []);
  assert.ok(d.logs.some((l) => /never drew power/.test(l)));
});

test('a session that drew power, or delivered energy, still ends with the card', async () => {
  const drew = charger();
  running(drew);
  await stop(drew, 'Local', 900_000);                  // verified (no watcher left), 0 Wh
  assert.strictEqual(stoppedCards(drew).length, 1);

  const delivered = charger();
  running(delivered);
  delivered._startVerify = { txId: 7, isMaskedResume: false, activeAmps: 10 };   // no power samples, but energy
  await stop(delivered, 'Local', 900_010);
  assert.strictEqual(stoppedCards(delivered).length, 1);

  const other = charger();
  running(other);
  other._startVerify = { txId: 6, isMaskedResume: false, activeAmps: 10 };       // an older transaction's watcher
  await stop(other, 'Local', 900_000);
  assert.strictEqual(stoppedCards(other).length, 1);
});

test('a resumed session whose resume never drew power still ends with the card', async () => {
  const d = charger();
  running(d);
  d.stitchedSession = { originalStartTime: Date.now() - 7200_000, accumulatedEnergyWh: 0 };
  d._startVerify = { txId: 7, isMaskedResume: true, activeAmps: 10 };
  await stop(d, 'Local', 900_000);
  assert.strictEqual(stoppedCards(d).length, 1);
});

// 5. lastNonZero

test('the last non-zero readings are written at most every five minutes, and on shutdown', async () => {
  const d = charger();
  d._lastNonZeroSavedAt = 0;
  const writes = () => d.storeWrites || 0;
  for (let i = 0; i < 10; i++) d._trackLastNonZero('measure_power', 7000 + i);
  assert.strictEqual(writes(), 1);
  assert.strictEqual(d.store.lastNonZero.measure_power.value, 7000);
  d._lastNonZeroSavedAt -= 5 * MIN;
  d._trackLastNonZero('measure_power', 7100);
  assert.strictEqual(writes(), 2);
  d._trackLastNonZero('measure_voltage.l1', 231);
  assert.strictEqual(writes(), 2);
  assert.strictEqual(d._lastNonZero['measure_voltage.l1'].value, 231, 'kept in memory for the debug summary');

  d._clearTimers = () => {};
  await d.onUninit();
  assert.strictEqual(d.store.lastNonZero['measure_voltage.l1'].value, 231);
});
