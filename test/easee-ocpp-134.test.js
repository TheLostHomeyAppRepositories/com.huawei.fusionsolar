'use strict';

// The Easee's first connection, and what evcc knows about it (1.3.4). Run: node --test
//
// Andi's log, 2026-10-15 23:36: the Easee connected under its serial number while its device
// waited for the Station ID "easee". The server logged "Catch-all device matched" with no such
// device, nothing reached the Easee device, and the charger got the Huawei configuration —
// every key twice, interleaved: SoC in the measurands (Rejected, as expected), a 10 s sample
// interval (Rejected), WebSocketPingInterval (NotSupported).
//
// evcc's Easee template (templates/definition/charger/ocpp-easee.yaml, docs.evcc.io) explains
// the interval: "Minimum meter interval: 30s". It samples Energy, Power and Current.Import, and
// puts its default profile on the charger's highest stack level. And: current control over OCPP
// needs a newer (beta) firmware than connecting does — so the firmware goes into the log.

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
const read       = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(d) { this.sent.push(JSON.parse(d)); }
  ping() {}
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
const req = (id) => ({ url: `/${id}`, socket: { remoteAddress: '192.0.2.60' }, headers: {} });

function server({ answer = () => ({ status: 'Accepted' }) } = {}) {
  const logs = [];
  const s = new OcppServer({ log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) });
  s.logs = logs;
  s.calls = [];
  s._sendCallAsync = async (_ws, action, payload) => { s.calls.push({ action, payload }); return answer(action, payload); };
  return s;
}
function device(proto, stationId) {
  const d = Object.create(proto);
  d.events = [];
  d.caps = {};
  d.getName = () => 'Easee Charger (OCPP)';
  d.getSetting = (k) => ({ station_id: stationId })[k];
  d.log = (...a) => d.events.push(a.join(' '));
  d._set = async (cap, v) => { d.caps[cap] = v; };
  d.onServerStarted = () => {};
  d.onOcppConnected = () => d.events.push('connected');
  return d;
}
const changes = (s) => s.calls.filter((c) => c.action === 'ChangeConfiguration').map((c) => `${c.payload.key}=${c.payload.value}`);

// ── what an Easee is told ───────────────────────────────────────────────────

test('a refused interval is followed by the next, and one refused throughout is read back', async () => {
  const s = server({
    answer: (action, p) => {
      if (action === 'GetConfiguration') return { configurationKey: [{ key: p.key[0], readonly: false, value: '0' }] };
      if (p.key === 'MeterValueSampleInterval') return { status: 'Rejected' };
      return { status: 'Accepted' };
    },
  });
  const ws = new FakeSocket();
  s._devices.set('EH12AB34', device(Easee.prototype, 'EH12AB34'));
  await s._configureCharger('EH12AB34', ws);
  assert.deepStrictEqual(changes(s), [
    'MeterValuesSampledData=Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,Temperature',
    'MeterValueSampleInterval=30',
    'MeterValueSampleInterval=60',
    'HeartbeatInterval=60',
  ]);
  const get = s.calls.find((c) => c.action === 'GetConfiguration');
  assert.deepStrictEqual(get.payload, { key: ['MeterValueSampleInterval'] }, 'one key per request — an Easee answers no more');
  assert.ok(s.logs.some((l) => /EH12AB34 keeps MeterValueSampleInterval = 0/.test(l)), s.logs.join('\n'));
});

test('a refused measurand list falls back to evcc’s three for an Easee', async () => {
  const s = server({
    answer: (action, p) => ({ status: p.key === 'MeterValuesSampledData' && /Voltage/.test(p.value) ? 'Rejected' : 'Accepted' }),
  });
  s._devices.set('EH12AB34', device(Easee.prototype, 'EH12AB34'));
  await s._configureCharger('EH12AB34', new FakeSocket());
  assert.deepStrictEqual(changes(s).slice(0, 2), [
    'MeterValuesSampledData=Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,Temperature',
    'MeterValuesSampledData=Energy.Active.Import.Register,Power.Active.Import,Current.Import',
  ]);
  assert.ok(!s.calls.some((c) => c.action === 'GetConfiguration'), 'the second list was taken — nothing to read back');
});

test('a charger that boots as it connects is configured once', async () => {
  const s = server();
  const ws = new FakeSocket();
  await Promise.all([s._configureCharger('CP1', ws), s._configureCharger('CP1', ws)]);
  assert.deepStrictEqual(changes(s), ['MeterValuesSampledData=Power.Active.Import,Energy.Active.Import.Register,SoC,Current.Import,Voltage',
    'MeterValueSampleInterval=10', 'WebSocketPingInterval=30'], 'a Huawei still gets its list, once');
});

test('the default profile sits on stack level 10 for an Easee, 0 for a Huawei', async () => {
  const s = server();
  for (const [id, proto] of [['EH12AB34', Easee.prototype], ['scharger', Huawei.prototype]]) {
    s._devices.set(id, device(proto, id));
    s._clients.set(id, new FakeSocket());
    await s.setMaxCurrentAsync(id, 16, 3);
  }
  const levels = s.calls.filter((c) => c.action === 'SetChargingProfile').map((c) => c.payload.csChargingProfiles.stackLevel);
  assert.deepStrictEqual(levels, [10, 0]);
});

test('the boot message puts vendor, model and firmware in the log', () => {
  const s = server();
  s._configureCharger = () => {};
  const ws = new FakeSocket();
  s._handleCall('EH12AB34', ws, 'b1', 'BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'Easee Home', firmwareVersion: '344/1.0' });
  assert.ok(s.logs.some((l) => l === '[OcppServer] EH12AB34: Easee Easee Home, firmware 344/1.0'), s.logs.join('\n'));
});

// ── a Station ID that does not match ────────────────────────────────────────

test('a charger under another Station ID is named in the log and on the waiting device', () => {
  const s = server();
  s._configureCharger = () => {};
  const d = device(Easee.prototype, 'easee');
  s.registerDevice('easee', d);
  const ws = new FakeSocket();
  s._onConnection(ws, req('EH12AB34'));
  assert.ok(s.logs.some((l) => /EH12AB34: no device has this Station ID \(waiting for: easee\) — enter EH12AB34 as the Station ID, or leave it empty/.test(l)), s.logs.join('\n'));
  assert.ok(!s.logs.some((l) => /Catch-all device matched/.test(l)), 'it claims a device without a Station ID that does not exist');
  assert.strictEqual(d.caps.ocpp_last_message, 'Other Station ID: EH12AB34');
  assert.strictEqual(d._otherStationId, 'EH12AB34');
  ws.close();
});

test('correcting the Station ID serves the charger already connected, without a reconnect', () => {
  const s = server();
  const configured = [];
  s._configureCharger = (id) => configured.push(id);
  const d = device(Easee.prototype, 'easee');
  s.registerDevice('easee', d);
  const ws = new FakeSocket();
  s._onConnection(ws, req('EH12AB34'));
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => { timers.push(fn); return 0; };
  try { s.renameDevice('easee', 'EH12AB34', d); } finally { global.setTimeout = realSetTimeout; }
  assert.ok(d.events.includes('connected'), 'the device never heard its charger is there');
  timers.forEach((fn) => fn());
  assert.ok(configured.includes('EH12AB34'), 'the charger is not told what to sample');
  assert.strictEqual(s._deviceFor('EH12AB34'), d);
  ws.close();
});

test('emptying the Station ID takes the charger that came first', () => {
  const s = server();
  s._configureCharger = () => {};
  const d = device(Easee.prototype, 'easee');
  s.registerDevice('easee', d);
  const ws = new FakeSocket();
  s._onConnection(ws, req('EH12AB34'));
  const realSetTimeout = global.setTimeout;
  global.setTimeout = () => 0;
  try { s.renameDevice('easee', '', d); } finally { global.setTimeout = realSetTimeout; }
  assert.ok(d.events.includes('connected'));
  assert.strictEqual(s._resolveStationId(''), 'EH12AB34');
  ws.close();
});

test('the device says it on the tile, in the offline text, and forgets it once its charger is there', async () => {
  for (const proto of [Easee.prototype, Huawei.prototype]) {
    const d = Object.create(proto);
    const caps = {};
    let unavailable = null;
    d.getSetting = (k) => ({ station_id: 'easee' })[k];
    d.log = () => {};
    d._set = async (cap, v) => { caps[cap] = v; };
    d.onOtherStation('EH12AB34');
    assert.strictEqual(caps.ocpp_last_message, 'Other Station ID: EH12AB34');
    // The watchdog's offline branch, with nothing heard from "easee".
    d._ocppServer = () => ({ lastMessageAtFor: () => null });
    d._bootGraceStart = Date.now() - 10 * 60_000;
    d.chargerOffline = false;
    d._expectedOfflineUntil = Date.now() + 60_000;
    d.setUnavailable = async (t) => { unavailable = t; };
    d.setStoreValue = async () => {};
    d._updateSessionStatus = async () => {};
    d._chargingState = () => 'idle';
    d._postNotification = async () => {};
    await d._checkChargerOnline();
    assert.strictEqual(unavailable, 'No charger with Station ID "easee" — "EH12AB34" connected instead; enter it as the Station ID');
    d.homey = { setTimeout: () => 0 };
    d.onOcppConnected();
    assert.strictEqual(d._otherStationId, null);
  }
});

test('the Easee device asks for evcc’s values, and the pairing page says whose ID it is', () => {
  const d = Object.create(Easee.prototype);
  assert.strictEqual(d.ocppDefaultStackLevel, 10);
  const conf = Object.fromEntries(d.ocppConfiguration());
  assert.deepStrictEqual(conf.MeterValueSampleInterval, ['30', '60']);
  assert.ok(!('WebSocketPingInterval' in conf), 'an Easee answers NotSupported');
  // Andi, 2026-10-15: "Es ist wichtig, dass man in der Easee Installer App nur die URL ohne die
  // Station ID eingibt. Bsp: ws://homey:8887 — die Station ID fügt die App selber hinzu! Die
  // entspricht der Seriennummer des Laders."
  const html = read('drivers/easee_ocpp/pair/start.html');
  assert.match(html, /<code>ws:\/\/\[Homey-IP\]:8887<\/code> — the URL only, nothing after the port/);
  assert.match(html, /The app adds the Station ID itself: the charger's serial number/);
  const app = JSON.parse(read('app.json'));
  const set = (id) => app.drivers.find((x) => x.id === 'easee_ocpp').settings
    .flatMap((g) => g.children || [g]).find((x) => x.id === id);
  assert.match(set('ocpp_port').hint.en, /nothing after the port — the app adds the Station ID/);
  assert.match(set('ocpp_port').hint.de, /nichts nach dem Port — die App hängt die Station-ID selbst an/);
  assert.match(set('ocpp_port').hint.nl, /niets na de poort — de app voegt de Station ID zelf toe/);
  for (const lang of ['en', 'de', 'nl']) assert.doesNotMatch(set('station_id').hint[lang], /charge point|Charge-Point/i, lang);
  assert.match(read('README.md'), /5\. Enter `ws:\/\/<Homey-IP>:8887` as the OCPP URL — the URL only, nothing after the port\. The app adds the Station ID itself: the charger's serial number\./);
  assert.doesNotMatch(read('lib/ocpp-server.js') + read('drivers/easee_ocpp/device.js') + read('drivers/easee_ocpp/pair/start.html'),
    /EHLACH/, 'Andi’s serial number does not belong in a public repository');
});
