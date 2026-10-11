'use strict';

// 1.2.331: the EMS reads this app's own devices where they live, not over the local Homey API.
//
// Every tick (15 s) fetched each source device over HTTP — the whole device object, 20–40 KB of
// JSON, parsed for one or two values — even when it was this app's own inverter, meter or
// battery. fetch() also brings in its library (undici), several MB that stay. Devices of other
// apps (an Easee, a car, a heat pump) are still read over the API, with the same answers as
// before. And one memory line ten minutes after the start, to compare versions on Homey.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, App: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const EmsDevice = require(path.join('..', 'drivers', 'energy_management', 'device.js'));
const App       = require(path.join('..', 'app.js'));
Module._load = origLoad;

// lingering: values the device still holds for capabilities it no longer has.
function ownDevice(id, name, caps, { available = true, throws = false, lingering = {} } = {}) {
  const values = { ...lingering, ...caps };
  return {
    getId: () => id,
    getName: () => name,
    getAvailable: () => available,
    hasCapability: (c) => c in caps,
    getCapabilityValue: (c) => { if (throws) throw new Error('Device deleted'); return values[c]; },
  };
}

function ems(own = [], foreign = {}) {
  const d = Object.create(EmsDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d._devCache = new Map();
  d._ownById = null;
  d.indexed = 0;
  d.homey = { drivers: { getDrivers: () => { d.indexed++; return { a: { getDevices: () => own } }; } } };
  d.restCalls = [];
  d._api = {
    getDevice: async (id) => { d.restCalls.push(id); if (!(id in foreign)) throw new Error('HTTP 404'); return foreign[id]; },
    getDevices: async () => { d.restCalls.push('*'); return foreign; },
  };
  return d;
}
const rest = (id, name, caps, available = true) => ({
  id, name, available,
  capabilitiesObj: Object.fromEntries(Object.entries(caps).map(([k, value]) => [k, { id: k, value }])),
});

// ── reading ────────────────────────────────────────────────────────────────────

test('a device of this app is read in the process — no HTTP', async () => {
  const d = ems([ownDevice('inv', 'Wechselrichter', { measure_power: 4210, 'meter_power.grid_import': 812.5 })]);
  assert.strictEqual(await d._cap('inv', 'measure_power', { measured: true }), 4210);
  assert.strictEqual(await d._cap('inv', 'meter_power.grid_import'), 812.5);
  assert.deepStrictEqual(d.restCalls, []);
});

test('a device of another app is read over the API, as before', async () => {
  const d = ems([ownDevice('inv', 'Wechselrichter', { measure_power: 4210 })],
    { easee: rest('easee', 'Easee', { measure_power: 7100, evcharger_charging_state: 'plugged_in_charging' }) });
  assert.strictEqual(await d._cap('easee', 'measure_power', { measured: true }), 7100);
  assert.strictEqual(await d._cap('easee', 'evcharger_charging_state'), 'plugged_in_charging');
  assert.deepStrictEqual(d.restCalls, ['easee'], 'one fetch per device per tick, still');
});

test('the same answers as over the API — value, null, missing capability', async () => {
  const caps = { measure_power: -1500, onoff: false, evcharger_charging_state: 'plugged_in', measure_battery: null, zero: 0 };
  const asked = ['measure_power', 'onoff', 'evcharger_charging_state', 'measure_battery', 'zero', 'not_there'];
  const viaOwn  = ems([ownDevice('x', 'X', caps)]);
  const viaRest = ems([], { x: rest('x', 'X', caps) });
  for (const cap of asked) {
    assert.deepStrictEqual(await viaOwn._cap('x', cap), await viaRest._cap('x', cap), cap);
  }
  // A capability the device no longer has is gone from its API object too, whatever value
  // the device still holds for it.
  const removed = ems([ownDevice('x', 'X', { measure_power: 1 }, { lingering: { 'measure_power.pv1': 812 } })]);
  assert.strictEqual(await removed._cap('x', 'measure_power.pv1'), null);
  const undefinedValue = ems([ownDevice('x', 'X', { measure_power: undefined })]);
  assert.strictEqual(await undefinedValue._cap('x', 'measure_power'), null);
});

test('an unavailable device of this app: a measurement reads as missing, a state does not', async () => {
  const d = ems([ownDevice('bat', 'Batterie', { measure_battery: 64, onoff: true }, { available: false })]);
  assert.strictEqual(await d._cap('bat', 'measure_battery', { measured: true }), null);
  assert.strictEqual(await d._cap('bat', 'onoff'), true);
  assert.ok(d.logs.some((l) => /"Batterie" is unavailable/.test(l)));
  // and the API path answers the same
  const r = ems([], { bat: rest('bat', 'Batterie', { measure_battery: 64, onoff: true }, false) });
  assert.strictEqual(await r._cap('bat', 'measure_battery', { measured: true }), null);
  assert.strictEqual(await r._cap('bat', 'onoff'), true);
});

test('the log says once per device how it is read — the check on a real Homey', async () => {
  const d = ems([ownDevice('inv', 'Wechselrichter', { measure_power: 1 })],
    { easee: rest('easee', 'Easee', { measure_power: 2 }) });
  for (let i = 0; i < 3; i++) {
    await d._cap('inv', 'measure_power');
    await d._cap('easee', 'measure_power');
    d._devCache = new Map(); d._ownById = null;         // next tick
  }
  assert.deepStrictEqual(d.logs, [
    '[EMS] "Wechselrichter" is read directly in the app',
    '[EMS] "Easee" is read over the local Homey API (0.1 KB, 1 capabilities)',
  ]);
});

// 1.2.334: how much one API read carries — to decide whether reading single values pays.
test('the line for a device of another app says how big the object is and how many capabilities it has', () => {
  const caps = Object.fromEntries(Array.from({ length: 112 }, (_, i) => [`measure_temperature.c${i}`, {
    id: `measure_temperature.c${i}`, type: 'number', title: `Temperatur ${i}`, units: '°C', value: 21.5,
    lastUpdated: '2026-10-11T10:00:00.000Z', getable: true, setable: false, insights: true, decimals: 1,
  }]));
  const big = { id: 'lux', name: 'CTA Luxtronik', available: true, capabilitiesObj: caps };
  const kb = Math.round(JSON.stringify(big).length / 1024);
  assert.ok(kb >= 10, 'the fixture should be over 10 KB');
  assert.strictEqual(EmsDevice._apiObjectSize(big), `${kb} KB, 112 capabilities`);
  assert.strictEqual(EmsDevice._apiObjectSize({ capabilities: ['onoff', 'measure_power'] }), '0.0 KB, 2 capabilities');
  assert.strictEqual(EmsDevice._apiObjectSize(null), '0.0 KB, 0 capabilities');
  const circular = { capabilitiesObj: {} };
  circular.self = circular;
  assert.strictEqual(EmsDevice._apiObjectSize(circular), '?, 0 capabilities');
});

test('the size is worked out once per device and start, not on every tick', async () => {
  let serialised = 0;
  const easee = { ...rest('easee', 'Easee', { measure_power: 2 }), toJSON() { serialised++; return { id: 'easee' }; } };
  const d = ems([], { easee });
  for (let i = 0; i < 5; i++) { await d._cap('easee', 'measure_power'); d._devCache = new Map(); }
  assert.strictEqual(serialised, 1);
});

test('a device deleted while the tick runs reads as missing, not as an error', async () => {
  const d = ems([ownDevice('gone', 'Weg', { measure_power: 5 }, { throws: true })]);
  assert.strictEqual(await d._cap('gone', 'measure_power'), null);
});

test('the list of this app\'s devices is built once per tick, and fresh for the next', async () => {
  const own = [ownDevice('inv', 'Wechselrichter', { measure_power: 1 })];
  const d = ems(own);
  for (let i = 0; i < 6; i++) await d._cap('inv', 'measure_power');
  assert.strictEqual(d.indexed, 1);
  own.push(ownDevice('new', 'Neu', { measure_power: 2 }));
  assert.strictEqual(await d._cap('new', 'measure_power'), null, 'not until the next tick');
  d._ownById = null;                                   // what _tickBody does first
  assert.strictEqual(await d._cap('new', 'measure_power'), 2);
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'energy_management', 'device.js'), 'utf8');
  const body = src.slice(src.indexOf('async _tickBody()'), src.indexOf('async _tickBody()') + 600);
  assert.ok(/this\._ownById\s*=\s*null;/.test(body), '_tickBody no longer starts a fresh list');
});

test('without a driver list (or in a test fake) everything goes over the API, as before', async () => {
  const d = ems([], { x: rest('x', 'X', { measure_power: 3 }) });
  d.homey = {};
  assert.strictEqual(await d._cap('x', 'measure_power'), 3);
  assert.deepStrictEqual(d.restCalls, ['x']);
});

test('reading only this app\'s devices never loads the fetch library', async () => {
  const d = ems([ownDevice('m', 'Zähler', { measure_power: 1 }), ownDevice('b', 'Batterie', { measure_battery: 50 })]);
  d._api = { getDevice: (id) => fetch(`http://127.0.0.1:9/${id}`) };   // a real fetch, were it asked
  await d._cap('m', 'measure_power', { measured: true });
  await d._cap('b', 'measure_battery', { measured: true });
  assert.ok(!process.moduleLoadList.some((m) => m.includes('undici')));
});

// ── the widget ─────────────────────────────────────────────────────────────────

test('the widget names a device of this app without asking the API', async () => {
  const d = ems([ownDevice('ocpp', 'Lader Garage', {})], { easee: rest('easee', 'Easee Home', {}) });
  assert.strictEqual(await d._widgetDeviceName('ocpp'), 'Lader Garage');
  assert.deepStrictEqual(d.restCalls, []);
  assert.strictEqual(await d._widgetDeviceName('easee'), 'Easee Home');
  assert.deepStrictEqual(d.restCalls, ['easee']);
});

test('the widget\'s device picker asks for the whole device list only when it has to', async () => {
  const cfg = { chargers: [{ id: 'ocpp' }], heat_pump_devices: [{ id: 'wp' }] };
  const allOwn = ems([ownDevice('ocpp', 'Lader', {}), ownDevice('wp', 'Wärmepumpe', {})]);
  allOwn._getConfig = () => cfg;
  assert.deepStrictEqual(await allOwn.getEmsControllableDevices(), [
    { id: 'ocpp', kind: 'charger', name: 'Lader' },
    { id: 'wp', kind: 'heat_pump', name: 'Wärmepumpe' },
  ]);
  assert.deepStrictEqual(allOwn.restCalls, [], 'the whole device list of the Homey was fetched');

  const mixed = ems([ownDevice('ocpp', 'Lader', {})], { wp: rest('wp', 'Fremde WP', {}) });
  mixed._getConfig = () => cfg;
  assert.deepStrictEqual((await mixed.getEmsControllableDevices()).map((x) => x.name), ['Lader', 'Fremde WP']);
  assert.deepStrictEqual(mixed.restCalls, ['*']);
});

// ── the memory line ────────────────────────────────────────────────────────────

test('the memory line says what the process holds, and whether fetch\'s library is in', () => {
  const mem = { peakRss: 97.3, heapUsed: 14.2, heapTotal: 18, external: 3.4 };   // MB, as lib/memory-usage.js reads them
  assert.strictEqual(App.memoryLine(mem, ['NativeModule internal/deps/undici/undici']),
    'Memory after 10 min: peak rss 97.3 MB, heap 14.2/18.0 MB, external 3.4 MB, undici (fetch) loaded: yes');
  assert.match(App.memoryLine({ ...mem, peakRss: null }, []), /peak rss \? MB/, 'a figure that could not be read');
  assert.match(App.memoryLine(mem, ['NativeModule http']), /undici \(fetch\) loaded: no$/);
  assert.match(App.memoryLine(mem, null), /undici \(fetch\) loaded: unknown$/, 'a runtime without process.moduleLoadList');
});

test('it is written once, ten minutes after the start, and the timer goes with the app', async () => {
  const a = Object.create(App.prototype);
  const logs = [];
  const timers = [];
  let cleared = null;
  a.log = (...x) => logs.push(x.join(' '));
  a.error = a.log;
  a.homey = { setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { cleared = t; }, clearInterval: () => {} };
  a._scheduleMemoryLog();
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 10 * 60 * 1000);
  const timer = a._memoryLogTimer;
  await a.onUninit();
  assert.strictEqual(cleared, timer);
  timers[0].fn();
  assert.ok(logs.some((l) => /^Memory after 10 min: peak rss \d+\.\d MB/.test(l)), logs.join(' | '));
  assert.strictEqual(a._memoryLogTimer, null);
  // 1.2.332: whatever fails while reading the figures is written, not thrown — a throw in a
  // timer is uncaught and takes the whole app down (the app crashed within the ten minutes).
  const real = App.memoryLine;
  App.memoryLine = () => { throw new Error('EPERM: uv_resident_set_memory'); };
  try {
    a._scheduleMemoryLog();
    assert.doesNotThrow(() => timers[1].fn());
    assert.ok(logs.includes('Memory after 10 min: not readable — EPERM: uv_resident_set_memory'), logs.join(' | '));
  } finally {
    App.memoryLine = real;
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const onInit = src.slice(src.indexOf('async onInit()'), src.indexOf('async onUninit()'));
  assert.ok(/this\._scheduleMemoryLog\(\);/.test(onInit), 'onInit no longer schedules it');
});

// ── 1.2.333: reading memory without /proc ──────────────────────────────────────
//
// On Homey, process.memoryUsage() throws "ENOENT: no such file or directory,
// uv_resident_set_memory" — its container has no /proc. That stopped 1.2.331 and left the EMS
// diagnostics' memory card empty on every Homey. Each test here runs with that thrower in place.

const { readMemory } = require('../lib/memory-usage');

function onHomey(fn) {
  const real = process.memoryUsage;
  process.memoryUsage = () => { throw new Error('ENOENT: no such file or directory, uv_resident_set_memory'); };
  try { return fn(); } finally { process.memoryUsage = real; }
}

test('the figures are read without process.memoryUsage()', () => {
  const m = onHomey(() => readMemory());
  for (const k of ['peakRss', 'heapUsed', 'heapTotal', 'external']) {
    assert.strictEqual(typeof m[k], 'number', k);
    assert.ok(m[k] >= 0, k);
  }
  assert.ok(m.heapUsed <= m.heapTotal);
  assert.ok(m.peakRss > m.heapUsed, 'the peak RSS is the whole process, more than the heap');
});

test('a figure that cannot be read is null, and nothing throws', () => {
  const v8 = require('v8');
  const realHeap = v8.getHeapStatistics;
  const realUsage = process.resourceUsage;
  v8.getHeapStatistics = () => { throw new Error('nope'); };
  process.resourceUsage = () => { throw new Error('nope'); };
  try {
    assert.deepStrictEqual(readMemory(), { peakRss: null, heapUsed: null, heapTotal: null, external: null });
  } finally {
    v8.getHeapStatistics = realHeap;
    process.resourceUsage = realUsage;
  }
});

test('the log line and the EMS diagnostics both work on Homey', () => {
  const line = onHomey(() => App.memoryLine());
  assert.match(line, /^Memory after 10 min: peak rss \d+\.\d MB, heap \d+\.\d\/\d+\.\d MB, external \d+\.\d MB, undici \(fetch\) loaded: (yes|no)$/);
  const d = Object.create(EmsDevice.prototype);
  const mem = onHomey(() => d._memUsage());
  assert.ok(mem && typeof mem.peakRss === 'number' && typeof mem.heapUsed === 'number', JSON.stringify(mem));
});

test('no runtime code calls process.memoryUsage() any more', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.homeybuild', 'test', 'scripts', '.git', 'docs'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(__dirname, '..'));
  const callers = files.filter((f) => /process\.memoryUsage\s*\(/.test(fs.readFileSync(f, 'utf8')
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
  assert.deepStrictEqual(callers.map((f) => path.relative(path.join(__dirname, '..'), f)), []);
});

test('the diagnostics card shows what was read and skips what was not', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  assert.ok(/memRow\('residentRss', mem\.peakRss\)/.test(html));
  assert.ok(/Number\(v\)\.toFixed\(1\) \+ ' MB'/.test(html), 'a whole number shows as "4 MB" beside "19.2 MB" again');
  assert.ok(!/mem\.arrayBuffers|mem\.rss\b/.test(html), 'the card still asks for a figure that is no longer read');
  for (const lang of ['en', 'de', 'nl']) {
    const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8')).settings.diagLabels;
    assert.ok(/RSS/.test(labels.residentRss), lang);
    assert.ok(!('arrayBuffers' in labels), lang);
  }
});

// ── 1.2.335: the start-up memory trace ─────────────────────────────────────────
//
// Every start climbs to about 100 MB RSS within minutes. A line at fixed moments of the start,
// and one after the EMS's first tick, shows in which stretch it climbs.

function traceApp() {
  const a = Object.create(App.prototype);
  a.logs = [];
  a.timers = [];
  a.log = (...x) => a.logs.push(x.join(' '));
  a.error = a.log;
  a.homey = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; a.timers.push(t); return t; },
    clearTimeout: (t) => { a.cleared = (a.cleared || []).concat([t]); },
    clearInterval: () => {},
  };
  return a;
}

test('a trace line names the stretch, the seconds since the start and the figures', () => {
  const a = traceApp();
  a.traceStartMemory('too early');
  assert.deepStrictEqual(a.logs, [], 'a line before the trace was started');
  a._startTraceAt = Date.now() - 31_000;
  a.traceStartMemory('30s');
  assert.match(a.logs[0], /^Start memory \+31s \[30s\]: peak rss \d+\.\d MB, heap \d+\.\d\/\d+\.\d MB, external \d+\.\d MB$/);
  a._startTraceAt = Date.now() - (6 * 60 + 1) * 1000;
  a.traceStartMemory('late');
  assert.strictEqual(a.logs.length, 1, 'a line after the six-minute window');
});

test('the fixed moments are 15 s, 30 s, 1, 2 and 5 min after the start, and go with the app', async () => {
  const a = traceApp();
  a._startTraceAt = Date.now();
  a._scheduleStartTrace();
  assert.deepStrictEqual(a.timers.map((t) => Math.round(t.ms / 1000)), [15, 30, 60, 120, 300]);
  a.timers[2].fn();
  assert.match(a.logs[0], /\[60s\]/);
  await a.onUninit();
  for (const t of a.timers) assert.ok(a.cleared.includes(t), 'a trace timer outlives the app');
});

test('the app traces its start, its end of onInit and the restored sensor-chart history', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const onInit = src.slice(src.indexOf('async onInit()'), src.indexOf('static matchCarTarget'));
  assert.ok(/this\._wrapLogger\(\);[^\n]*\n\s*this\._startTraceAt = Date\.now\(\);\n\s*this\.traceStartMemory\('app start'\);/.test(onInit),
    'the first trace no longer follows the log capture directly');
  assert.ok(/this\.traceStartMemory\('app ready'\);\n\s*this\._scheduleStartTrace\(\);\n\s*\}\n/.test(onInit),
    'onInit no longer ends with the "app ready" trace and the timed ones');
  assert.ok(/series in history`\);\n\s*this\.traceStartMemory\('sensor chart restored'\);/.test(src));
});

test('the EMS traces its first tick, and only that one', async () => {
  const traced = [];
  const d = Object.create(EmsDevice.prototype);
  d.log = () => {};
  d.homey = { app: { traceStartMemory: (l) => traced.push(l) } };
  d._diag = { tickCount: 0, maxTickMs: 0, tickErrors: 0 };
  d._tickBody = async () => {};
  d._flushMode = async () => {};
  d._saveHistory = () => {};
  d._warmupDone = false;
  d._tickCount = 0;
  for (let i = 0; i < 3; i++) await d._tick();
  assert.deepStrictEqual(traced, ['EMS first tick done']);
});
