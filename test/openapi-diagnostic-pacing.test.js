'use strict';

// What the diagnostic report costs in API calls. Run: node --test
//
// Issue #28, and the reason it ran long. getDevRealKpi allows
//
//   Σ over device types of Roundup(devices of that type / 100)
//
// calls every five minutes — one per device type on a household plant. The poller already
// spends one per type per cycle, so the whole allowance is accounted for before anyone
// opens the settings page.
//
// The report used to fetch every type again, at first all at once and later spaced by 1.5 s,
// which changes a burst into a slower burst but not the number of calls in a five-minute
// window. Huawei refused the surplus with failCode 407, and before that refusal was
// surfaced it arrived as an empty device list — which reads as a missing device. Days went
// into hunting a battery that was answering the poller the entire time.
//
// So the report now shows what the poller last received, with its age, and spends the
// allowance only on types nobody polls.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const { DEV_KPI_WINDOW_MS, devKpiAllowance } = require(path.join(ROOT, 'lib', 'openapi-coordinator.js'));

// ── A stubbed client, so the timing measured is the report's own ─────────────

const calls = [];
let devList = [
  { id: 1001, devTypeId: 1 }, { id: 1002, devTypeId: 39 },
  { id: 1003, devTypeId: 47 }, { id: 1004, devTypeId: 62 },
];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './lib/openapi-client') {
    return {
      login:                async () => 'tok',
      getStationList:       async () => ({ stations: [{ stationCode: 'NE=1', stationName: 'test' }] }),
      getStationRealKpiRaw: async () => ({ raw: { day_power: 1 } }),
      getDevList:           async () => ({ devices: devList }),
      getDevRealKpi: async (baseUrl, token, ids, devTypeId) => {
        calls.push({ devTypeId, at: Date.now() });
        return { devices: [{ dataItemMap: { live: true } }], failCode: null, failMessage: null };
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const api = require(path.join(ROOT, 'api.js'));
Module._load = origLoad;

// A Homey whose coordinator holds what the poller last received.
function fakeHomey({ polled = {}, ageMs = 42_000 } = {}) {
  const paused = [];
  const kpiByType = {};
  for (const [typeId, maps] of Object.entries(polled)) {
    kpiByType[typeId] = { maps, at: Date.now() - ageMs };
  }
  return {
    paused,
    app: {
      getCoordinator: () => ({
        snapshotFor: (code) => (code === 'NE=1' ? { stationCode: code, kpiByType, devIdsByType: {} } : null),
        pauseAll: (ms) => { paused.push(ms); },
      }),
    },
  };
}

const run = async (homey) => {
  calls.length = 0;
  return api.fetchOpenapiDebug({ homey, body: { baseUrl: 'https://eu5.test', username: 'u', systemCode: 's' } });
};

const stepFor = (report, typeId) => report.steps.find((s) => s.step === `getDevRealKpi(type=${typeId})`);

// ── The allowance, borrowed rather than restated ─────────────────────────────

test('the report and the poller compute the same allowance', () => {
  // Huawei's own worked example: 20 inverters and 20 meters is two calls; 120 and 120 is four.
  assert.strictEqual(devKpiAllowance({ 1: new Array(20), 17: new Array(20) }), 2);
  assert.strictEqual(devKpiAllowance({ 1: new Array(120), 17: new Array(120) }), 4);
  assert.strictEqual(DEV_KPI_WINDOW_MS, 5 * 60 * 1000);

  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  assert.match(src, /devKpiAllowance:\s+openapiDevKpiAllowance,/,
    'the report works the allowance out for itself again, which can drift from the poller');
});

// ── The point of the change: polled types cost nothing ───────────────────────

test('a fully polled plant costs no API calls at all', async () => {
  const homey = fakeHomey({ polled: {
    1: [{ day_cap: 26 }], 39: [{ battery_soc: 67 }], 47: [{ active_power: -25 }], 62: [{ x: 1 }],
  } });
  const report = await run(homey);
  assert.deepStrictEqual(calls, [],
    'the report fetched types the poller already had — the surplus Huawei refuses with 407');
  assert.deepStrictEqual(homey.paused, [], 'polling was held off for a run that made no calls');

  const step = stepFor(report, '39');
  assert.match(step.data, /from the last poll, \d+s ago \(no API call\)/,
    'the reader cannot tell a polled reading from a freshly fetched one, nor how old it is');
  assert.strictEqual(report.stationDetails[0].kpiSource['39'].source, 'poll');
  assert.ok(report.stationDetails[0].kpiSource['39'].ageMs >= 40_000);
});

test('the polled readings are rendered in the same shape as fetched ones', async () => {
  const homey = fakeHomey({ polled: { 1: [{ day_cap: 26 }], 39: [], 47: [], 62: [] } });
  const report = await run(homey);
  assert.deepStrictEqual(report.stationDetails[0].kpiByType['1'], [{ dataItemMap: { day_cap: 26 } }],
    'the page renders dev.dataItemMap, so a bare map would show as an empty table');
  assert.deepStrictEqual(calls.map((c) => c.devTypeId), [39, 47, 62],
    'an empty snapshot entry was taken for a reading and no call was made');
});

test('only the unpolled types are fetched', async () => {
  const homey = fakeHomey({ polled: { 1: [{ day_cap: 26 }], 39: [{ battery_soc: 67 }], 47: [{ a: 1 }] } });
  const report = await run(homey);
  assert.deepStrictEqual(calls.map((c) => c.devTypeId), [62],
    'the allowance was spent on types the poller had already read');
  assert.strictEqual(report.stationDetails[0].kpiSource['62'].source, 'live');
  assert.deepStrictEqual(homey.paused, [DEV_KPI_WINDOW_MS],
    'the poller was not held off, so its next cycle lands in the window this run spent from');
});

test('no coordinator at all still produces a report, by fetching everything', async () => {
  const homey = { app: { getCoordinator: () => { throw new Error('no coordinator'); } } };
  const report = await run(homey);
  assert.deepStrictEqual(calls.map((c) => c.devTypeId), [1, 39, 47, 62],
    'an unpaired plant — the case the page exists for — got no data');
  assert.strictEqual(report.stationDetails[0].kpiSource['1'].source, 'live');
});

// The state right after an app restart: the poller has not filled its snapshot yet, so every
// type has to be fetched. Two releases in a row made this case worse — one ran for four
// minutes and timed the page out, the next answered with one device type out of four and
// three lines of apology. Whatever else changes, a run with nothing to reuse still fetches
// everything it can and lets a refusal report itself.
test('a run with an empty snapshot still fetches every type', async () => {
  const homey = fakeHomey();          // nothing polled: four types, allowance four
  const report = await run(homey);
  assert.strictEqual(calls.length, 4,
    'types were skipped rather than asked for — a 407 says more than a refusal to ask');
  assert.ok(report.steps.every((s) => !/not fetched/.test(s.data || '')),
    'the report explains what it declined to fetch instead of fetching it');

  const line = report.steps.find((s) => s.step === 'call allowance');
  assert.ok(line, 'the report no longer states what it was allowed to spend');
  assert.match(line.data, /4 getDevRealKpi call\(s\) per 5 min/);
  assert.match(line.data, /0 type\(s\) served from the last poll, 4 fetched live/);
});

// The allowance is never the constraint: it is a sum of Roundup(devices per type / 100),
// every type on a plant has at least one device, so it is never smaller than the number of
// types, and the loop makes at most one call per type.
test('a run that reuses nothing still fits inside the allowance', () => {
  for (const types of [1, 2, 4, 9]) {
    const byType = {};
    for (let i = 0; i < types; i++) byType[i] = ['id'];
    assert.ok(devKpiAllowance(byType) >= types,
      `${types} types allow ${devKpiAllowance(byType)} calls; one call per type would not fit`);
  }
  // And a type with a hundred-odd devices raises its own share rather than lowering it.
  assert.strictEqual(devKpiAllowance({ 1: new Array(101), 39: ['a'] }), 3);

});

// Huawei's allowance counts devices, not types: 101 inverters are two calls, not one. Those
// coincide on every household plant, which is why counting types passes unnoticed there —
// and why the arithmetic is borrowed from the poller rather than restated.
test('the allowance counts devices, not device types', async () => {
  const many = [];
  for (let i = 0; i < 101; i++) many.push({ id: 1000 + i, devTypeId: 1 });
  many.push({ id: 2000, devTypeId: 39 });

  const homey = fakeHomey({ polled: { 1: [{ x: 1 }], 39: [{ x: 1 }] } });
  const saved = devList;
  devList = many;
  try {
    const report = await run(homey);
    const line = report.steps.find((s) => s.step === 'call allowance');
    assert.match(line.data, /^3 getDevRealKpi call\(s\) per 5 min/,
      'Roundup(101/100) + Roundup(1/100) is three; counting types gives two');
  } finally { devList = saved; }
});

// ── The two coordinator methods this rests on ────────────────────────────────

const { StationSession } = require(path.join(ROOT, 'lib', 'openapi-coordinator.js'));

const bareHomey = () => ({
  log() {}, error() {},
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});

// The age is the whole reason a polled reading may be shown at all. Restamping it on the way
// out would turn a reading of known age into one that merely claims to be fresh.
test('the snapshot carries the age the reading actually has', () => {
  const s = new StationSession(bareHomey(), 'ST1');
  const anHourAgo = Date.now() - 3_600_000;
  s._lastGoodKpiByType = { 39: { maps: [{ battery_soc: 67 }], at: anHourAgo } };
  const snap = s.snapshot();
  assert.strictEqual(snap.kpiByType['39'].at, anHourAgo,
    'the snapshot restamps the reading, so an hour-old value reports itself as current');
});

// A diagnostic run stands the poller down for five minutes. A 407 stands it down for
// fifteen. Taking the later of the two matters: assigning instead would let a diagnostic
// cut short a backoff Huawei asked for.
test('standing the poller down never shortens a longer pause', () => {
  const s = new StationSession(bareHomey(), 'ST1');
  s.pausePolling(15 * 60_000);
  const long = s._backoffUntil;
  s.pausePolling(5 * 60_000);
  assert.strictEqual(s._backoffUntil, long,
    'a five-minute pause overwrote a fifteen-minute one, so polling resumes into the limit');
  s.pausePolling(30 * 60_000);
  assert.ok(s._backoffUntil > long, 'a longer pause no longer extends an existing one');
});

// The 407 that started all of this has to stay legible where it still occurs.
test('a rate-limited type is still reported with its code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  assert.match(src, /failCode \$\{r\.failCode\}: \$\{r\.failMessage\}/,
    'the reason was dropped from the report again');

  const client = fs.readFileSync(path.join(ROOT, 'lib', 'openapi-client.js'), 'utf8');
  const from   = client.indexOf('const FAIL_MESSAGES');
  const table  = client.slice(from, client.indexOf('};', from));
  assert.match(table, /^\s*407:.*[Rr]ate limit/m,
    '407 no longer reads as a rate limit, which is the one code this report exists to show');
});
