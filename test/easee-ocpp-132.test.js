'use strict';

// The Easee charger over its own OCPP (1.3.2). Run: node --test
//
// Andi, 2026-10-15: a driver for his own Easee over OCPP, with his icon, made by copying the
// Smart Charger (OCPP) driver and adapting it. Easee documents its native OCPP ("Direct
// OCPP (Home)", beta, firmware 344 or later) at developer.easee.com, and three things in it
// would have broken the copy as it stood:
//   - "Watt-based schedules not supported": the OCPP server sent every limit in watts.
//   - SoC is not among its measurands, and OCPP 1.6 has a charger refuse the WHOLE
//     MeterValuesSampledData list for one unknown entry: no readings at all.
//   - MeterValueSampleInterval 0 and HeartbeatInterval 86400 by default: no readings, and an
//     idle charger silent for a day — the device calls it offline after three minutes.
// The OCPP server is shared (one per port), so it asks the device; the Huawei path stays.

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

const ROOT       = path.join(__dirname, '..');
const read       = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP        = JSON.parse(read('app.json'));
const OcppServer = require('../lib/ocpp-server.js');
const Easee      = require('../drivers/easee_ocpp/device.js');
const driver     = (id) => APP.drivers.find((d) => d.id === id);
const flat       = (settings) => settings.flatMap((s) => (s.children ? s.children : [s]));

// A server that never listens: the constructor starts nothing. Calls are caught at
// _sendCallAsync, which is where they would leave for the socket.
function server(devices) {
  const s = new OcppServer({ log() {}, error() {} });
  const ws = { readyState: 1, OPEN: 1 };
  s.sent = [];
  s._sendCallAsync = async (_ws, action, payload) => { s.sent.push({ action, payload }); return { status: 'Accepted' }; };
  for (const [id, device] of Object.entries(devices)) { s._devices.set(id, device); s._clients.set(id, ws); }
  return { s, ws };
}
const period = (call) => call.payload.csChargingProfiles.chargingSchedule;

// ── what goes out to the charger ────────────────────────────────────────────

test('an Easee gets its limits in amperes, 0 A as 0 A', async () => {
  const { s } = server({ EH123456: Object.create(Easee.prototype) });
  await s.setMaxCurrentAsync('EH123456', 16, 3);
  await s.setTxProfileAsync('EH123456', 77, 0, 1);
  assert.deepStrictEqual(s.sent.map((c) => [period(c).chargingRateUnit, period(c).chargingSchedulePeriod[0].limit]),
    [['A', 16], ['A', 0]]);
  assert.strictEqual(period(s.sent[1]).chargingSchedulePeriod[0].numberPhases, 1);
});

test('a Huawei on the same server keeps watts, and 1 W for 0 A', async () => {
  const { s } = server({ 'scharger-home': {} });
  await s.setMaxCurrentAsync('scharger-home', 16, 3);
  await s.setTxProfileAsync('scharger-home', 78, 0, 3);
  assert.deepStrictEqual(s.sent.map((c) => [period(c).chargingRateUnit, period(c).chargingSchedulePeriod[0].limit]),
    [['W', 11040], ['W', 1]]);
});

test('an Easee without a Station ID (the catch-all) gets amperes too', async () => {
  const { s } = server({ '': Object.create(Easee.prototype) });
  s._resolvedStationIds.set('', 'EH999');
  s._clients.set('EH999', s._clients.get(''));
  await s.setMaxCurrentAsync('', 10, 1);
  assert.strictEqual(period(s.sent[0]).chargingRateUnit, 'A');
});

test('an Easee is told what it knows how to sample, how often, and to say hello every minute', async () => {
  const { s, ws } = server({ EH123456: Object.create(Easee.prototype) });
  await s._configureCharger('EH123456', ws);
  const keys = s.sent.filter((c) => c.action === 'ChangeConfiguration').map((c) => [c.payload.key, c.payload.value]);
  assert.deepStrictEqual(keys, [
    ['MeterValuesSampledData', 'Power.Active.Import,Energy.Active.Import.Register,Current.Import,Voltage,Temperature'],
    ['MeterValueSampleInterval', '10'],
    ['HeartbeatInterval', '60'],
  ]);
  // Easee's own list (Supported Config Keys (Home)): nothing else may be asked for.
  const known = new Set(['Current.Import', 'Current.Offered', 'Energy.Active.Import.Register',
    'Power.Active.Import', 'Temperature', 'Voltage']);
  for (const m of keys[0][1].split(',')) assert.ok(known.has(m), `${m} is not an Easee measurand`);
});

test('a Huawei is configured as before', async () => {
  const { s, ws } = server({ 'scharger-home': {} });
  await s._configureCharger('scharger-home', ws);
  assert.deepStrictEqual(s.sent.map((c) => c.payload.key),
    ['MeterValuesSampledData', 'MeterValueSampleInterval', 'WebSocketPingInterval']);
  assert.match(s.sent[0].payload.value, /SoC/);
});

// ── the device ──────────────────────────────────────────────────────────────

test('the 6 A floor holds per phase requested, with no Huawei phase spreading', () => {
  const d = Object.create(Easee.prototype);
  d.getSetting = (k) => ({ number_of_phases: '3' })[k];
  d._phaseLabel = Easee.prototype._phaseLabel;
  assert.doesNotThrow(() => d._validateProfileRequest(6, 1), '6 A on one phase of a three-phase Easee is deliverable');
  assert.throws(() => d._validateProfileRequest(5, 3), /6A minimum/);
  d.getSetting = (k) => ({ number_of_phases: '1' })[k];
  assert.throws(() => d._validateProfileRequest(10, 3), /can't be delivered/);
});

// Homey's EV charger documentation, "Capability value processing" (Andi asked for the check,
// 2026-10-15): 5000 W charges at 4830 W — rounded down to a step — and anything inside the
// exclude range idles. Rounded to the nearest amp, 5400 W on three phases was 8 A = 5520 W,
// more than the surplus it was meant to follow.
test('target power is rounded down to whole amps, and the dead zone idles', () => {
  const d = Object.create(Easee.prototype);
  let phases = 1;
  d._getPhases = () => phases;
  assert.strictEqual(d._wattsToAmps(5000), 21, '5000 W single-phase: 21 A = 4830 W');
  assert.strictEqual(d._wattsToAmps(1379), 0);
  assert.strictEqual(d._wattsToAmps(1380), 6);
  assert.strictEqual(d._wattsToAmps(-5000), 0, 'it does not discharge, and -5000 W is no charge order');
  assert.strictEqual(d._wattsToAmps(99999), 32);
  phases = 3;
  assert.strictEqual(d._wattsToAmps(5400), 7, '5400 W three-phase: 7 A = 4830 W, not 8 A = 5520 W');
  assert.strictEqual(d._wattsToAmps(2000), 0, 'under 6 A on each of three phases: idle, as Homey’s exclude range says');
  assert.strictEqual(d._wattsToAmps(4140), 6);
});

// "setCapabilityOptions() ... is an expensive call": once per phase change, not per start.
test('the target power range is written only when it changes', async () => {
  const d = Object.create(Easee.prototype);
  let options = { title: { en: 'Target Charging Power' }, min: 0, max: 22000, step: 230, excludeMin: 0, excludeMax: 1380 };
  let writes = 0;
  d.hasCapability = () => true;
  d.getSetting = (k) => ({ number_of_phases: '3' })[k];
  d.getCapabilityOptions = () => options;
  d.setCapabilityOptions = async (_cap, o) => { writes++; options = o; };
  d.log = () => {}; d.error = () => {};
  await d._applyTargetPowerRange();
  assert.strictEqual(writes, 1, 'the manifest’s single-phase range must become three-phase');
  assert.deepStrictEqual([options.max, options.step, options.excludeMax], [22080, 690, 4140]);
  assert.deepStrictEqual(options.title, { en: 'Target Charging Power' });
  await d._applyTargetPowerRange();
  assert.strictEqual(writes, 1, 'a second start wrote the same range again');
  await d._applyTargetPowerRange(1);
  assert.strictEqual(writes, 2);
  assert.deepStrictEqual([options.max, options.step, options.excludeMax], [7360, 230, 1380]);
});

// The rest of the page, as the manifest states it.
test('the manifest follows Homey’s EV charger page', () => {
  const d = driver('easee_ocpp');
  for (const cap of ['measure_power', 'evcharger_charging', 'evcharger_charging_state', 'meter_power',
    'target_power', 'target_power_mode']) assert.ok(d.capabilities.includes(cap), `${cap} is missing`);
  assert.strictEqual(d.energy.meterPowerImportedCapability, 'meter_power');
  assert.ok(!('meterPowerExportedCapability' in d.energy), 'it does not discharge, so no exported meter');
  const tp = d.capabilitiesOptions.target_power;
  assert.deepStrictEqual([tp.min, tp.max, tp.step, tp.excludeMin, tp.excludeMax], [0, 22000, 230, 0, 1380]);
  // "available as of v12.4.5" — and target_power needs 12.13.0 (README).
  assert.match(APP.compatibility, /^>=12\.(1[3-9]|[2-9]\d)\./);
  // The three capabilities Homey sets together arrive in one debounced call.
  const src = read('drivers/easee_ocpp/device.js');
  assert.match(src, /registerMultipleCapabilityListener\(\s*\['evcharger_charging', 'target_power', 'target_power_mode'\],[\s\S]{0,4000}?\n      500,\n    \);/);
});

test('a missing vendor becomes Easee, and the source names no Huawei model', () => {
  const src = read('drivers/easee_ocpp/device.js');
  assert.match(src, /setSettings\(\{ charger_vendor: 'Easee' \}\)/);
  assert.doesNotMatch(src, /charger_model|7ks|22kt|SCharger-7KS/);
  assert.doesNotMatch(src, /'vehicle_soc',\n/, 'the SoC tile is back in the required list');
  assert.doesNotMatch(src, /\[OCPP\]/, 'its log lines read like the other charger’s');
  assert.match(src, /class EaseeOcppDevice extends Device/);
  assert.match(read('drivers/easee_ocpp/driver.js'), /class EaseeOcppDriver extends Driver/);
});

// ── the manifest ────────────────────────────────────────────────────────────

test('the driver: an EV charger with Andi’s icon and images of its own', () => {
  const d = driver('easee_ocpp');
  assert.ok(d, 'easee_ocpp is missing from app.json');
  assert.strictEqual(d.name.en, 'Easee Charger (OCPP)');
  assert.strictEqual(d.class, 'evcharger');
  assert.strictEqual(d.energy.evCharger, true);
  for (const [k, size] of [['small', 75], ['large', 500], ['xlarge', 1000]]) {
    const file = path.join(ROOT, d.images[k]);
    assert.ok(d.images[k].startsWith('/drivers/easee_ocpp/'), `${k} points at another driver`);
    const png = fs.readFileSync(file);
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `${k} is not ${size}×${size}`);
  }
  const icon = read('drivers/easee_ocpp/assets/icon.svg');
  assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 960 960">/);
  assert.doesNotMatch(icon, /<svg[^>]*\b(width|height)=/, 'Homey wants the viewBox alone');
  assert.match(icon, /<path d="m409\.276621 4\.96645611c/, 'not the path of Andi’s icon');
});

test('no SoC tile and no Huawei settings; Easee as vendor; the hints speak of Easee', () => {
  const d = driver('easee_ocpp');
  assert.ok(!d.capabilities.includes('vehicle_soc'));
  assert.ok(!('vehicle_soc' in d.capabilitiesOptions));
  const ids = flat(d.settings).map((s) => s.id);
  for (const gone of ['charger_model', 'show_vehicle_soc']) assert.ok(!ids.includes(gone), `${gone} is still offered`);
  const set = (id) => flat(d.settings).find((s) => s.id === id);
  assert.strictEqual(set('charger_vendor').value, 'Easee');
  for (const lang of ['en', 'de', 'nl']) {
    for (const id of ['station_id', 'ocpp_port', 'ocpp_username', 'ocpp_password', 'charger_vendor']) {
      assert.doesNotMatch(set(id).hint[lang], /SCharger|Huawei/, `${id} (${lang}) still speaks of Huawei`);
    }
    assert.doesNotMatch(set('station_id').hint[lang], /:8887\//, `${lang}: the port is a setting, not a constant`);
  }
  // The rest is the copy, setting for setting.
  const ocppIds = flat(driver('smartcharger_ocpp').settings).map((s) => s.id)
    .filter((id) => id !== 'charger_model' && id !== 'show_vehicle_soc');
  assert.deepStrictEqual(ids, ocppIds);
});

test('every OCPP flow card takes an Easee as well', () => {
  const cards = ['triggers', 'conditions', 'actions'].flatMap((k) => APP.flow[k]);
  const ocpp = cards.filter((c) => (c.args || []).some((a) => /smartcharger_ocpp/.test(a.filter || '')));
  assert.strictEqual(ocpp.length, 26);
  for (const c of ocpp) {
    const f = c.args.find((a) => a.type === 'device').filter;
    assert.strictEqual(f, 'driver_id=smartcharger_ocpp||driver_id=easee_ocpp', `${c.id}: ${f}`);
  }
  // Shared cards only work because every listener acts on the device the flow names.
  const src = read('drivers/easee_ocpp/device.js');
  const listeners = src.match(/registerRunListener\(async \(args\) =>[^\n]*\n?[^\n]*/g) || [];
  assert.ok(listeners.length >= 15);
  for (const l of listeners) assert.match(l, /args\.device/, l);
});

test('the pairing page explains Easee’s commissioning, and a password brings its user name', () => {
  const html = read('drivers/easee_ocpp/pair/start.html');
  assert.match(html, /local-ocpp\/v1\/connection-details/);
  assert.match(html, /local-ocpp\/v1\/connections\/chargers/);
  assert.match(html, /DualProtocol/);
  assert.match(html, /firmware 344/);
  assert.doesNotMatch(html, /SCharger|FusionSolar/);
  assert.match(html, /easee:\$\{stationId\}/, 'the device id would collide with the other driver’s');
  assert.match(html, /\|\| \(password \? stationId : ''\)/);
});

// ── the widgets ─────────────────────────────────────────────────────────────

function homeyWith(byId) {
  return {
    i18n: { getLanguage: () => 'de' },
    drivers: { getDriver(id) { if (!byId[id]) throw new Error('no such driver'); return { getDevices: () => [byId[id]] }; } },
  };
}

test('the charger widgets find an Easee', async () => {
  const easee = {
    getWidgetStatus: () => ({ state: 'charging' }),
    getSessionHistory: async () => [{ energyWh: 1 }],
    getCurrentSessionInfo: () => null,
  };
  const status = await require('../widgets/charger-status/api.js').getStatus({ homey: homeyWith({ easee_ocpp: easee }) });
  assert.strictEqual(status.state, 'charging');
  const hist = await require('../widgets/session-history/api.js').getSessions({ homey: homeyWith({ easee_ocpp: easee }) });
  assert.deepStrictEqual(hist.history, [{ energyWh: 1 }]);
});
