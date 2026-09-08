'use strict';

// Three things the northbound API reference settles. Run: node --test
//
// 1. /thirdData/getStationList, which this app used for pairing, is retired: "iMaster NetEco
//    V600R023C00SPC210 and later versions do not support this interface." An account on a
//    newer server would find no plants, and pairing would read that as an account with none.
//
// 2. getStationRealKpi allows Roundup(plants/100) calls every five minutes — one, for a
//    single-plant account, which the poller already spends. A refusal was reported as "no
//    data", the same conflation of "turned away" with "nothing to say" that cost issue #28
//    days on the device interface.
//
// 3. getDevRealKpi serves device types 1, 10, 17, 38, 39, 41 and 47 (section 3.2.6). A
//    dongle is not among them, and asking for one spends a call to be told failCode 20013.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');

let queue = [];
let sent  = [];

function fakeRequest(options, onResponse) {
  const req = new EventEmitter();
  req.write = (payload) => { sent.push({ path: options.path, body: JSON.parse(payload) }); };
  req.end = () => {
    const next = queue.shift();
    if (next === 'GARBAGE') {
      const res = new EventEmitter();
      res.headers = {};
      setImmediate(() => { res.emit('data', '<html>404</html>'); res.emit('end'); });
      return onResponse(res);
    }
    const body = next ?? { success: false, failCode: 999, message: 'test ran out of responses' };
    const res = new EventEmitter();
    res.headers = {};
    setImmediate(() => { res.emit('data', JSON.stringify(body)); res.emit('end'); });
    onResponse(res);
  };
  req.destroy = () => {};
  return req;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https') return { request: fakeRequest };
  return origLoad.call(this, request, parent, isMain);
};
const client = require(path.join(ROOT, 'lib', 'openapi-client.js'));
Module._load = origLoad;

const run = async (fn, ...responses) => {
  queue = [...responses];
  sent  = [];
  return fn();
};
const paths = () => sent.map((s) => s.path);

const OK   = (data) => ({ success: true, data });
const FAIL = (failCode, message = null) => ({ success: false, failCode, message });

const NEW_PLANTS = OK({ list: [{ plantCode: 'NE=1', plantName: 'Wirz Gams', capacity: 11.3 }], total: 1 });
const OLD_PLANTS = OK({ list: [{ stationCode: 'NE=1', stationName: 'Wirz Gams', capacity: 11.3 }], total: 1 });

// ── A: the plant list ────────────────────────────────────────────────────────

test('the current interface is asked first, and answers end it', async () => {
  const r = await run(() => client.getStationList('https://eu5.test', 'tok'), NEW_PLANTS);
  assert.deepStrictEqual(paths(), ['/thirdData/stations'],
    'the retired interface is still the one being called for pairing');
  assert.strictEqual(r.endpoint, 'stations');
  assert.strictEqual(r.stations.length, 1);
});

// The pairing pages read stationCode; the current interface calls it plantCode. Left
// unnormalised, pairing against a newer server would offer a dropdown of blank entries.
test('both interfaces yield stationCode and plantCode alike', async () => {
  const viaNew = await run(() => client.getStationList('https://eu5.test', 'tok'), NEW_PLANTS);
  assert.strictEqual(viaNew.stations[0].stationCode, 'NE=1');
  assert.strictEqual(viaNew.stations[0].stationName, 'Wirz Gams');
  assert.strictEqual(viaNew.stations[0].plantCode, 'NE=1');

  const viaOld = await run(() => client.getStationList('https://eu5.test', 'tok'), FAIL(20001), OLD_PLANTS);
  assert.strictEqual(viaOld.stations[0].plantCode, 'NE=1');
  assert.strictEqual(viaOld.stations[0].stationCode, 'NE=1');
});

test('a server that has never heard of the new path falls back to the old one', async () => {
  // Not JSON: post() rejects rather than returning a code, which is what a 404 page does.
  const r = await run(() => client.getStationList('https://eu5.test', 'tok'), 'GARBAGE', OLD_PLANTS);
  assert.deepStrictEqual(paths(), ['/thirdData/stations', '/thirdData/getStationList'],
    'a rejected request ended pairing instead of trying the interface it replaced');
  assert.strictEqual(r.endpoint, 'getStationList');
  assert.strictEqual(r.stations.length, 1);
});

test('a refusal on the new path also falls back', async () => {
  const r = await run(() => client.getStationList('https://eu5.test', 'tok'), FAIL(20008), OLD_PLANTS);
  assert.deepStrictEqual(paths(), ['/thirdData/stations', '/thirdData/getStationList']);
  assert.strictEqual(r.stations.length, 1);
});

// An expired session is not a wrong endpoint. Falling back would spend the old interface's
// daily allowance on a call that cannot succeed either, and hide the re-login the caller needs.
test('an expired session is reported, not retried on the other interface', async () => {
  const r = await run(() => client.getStationList('https://eu5.test', 'tok'), FAIL(305));
  assert.strictEqual(r.expired, true);
  assert.deepStrictEqual(paths(), ['/thirdData/stations'],
    'a session that needs renewing was spent on the retired interface as well');
});

test('when neither interface answers, the reason comes back', async () => {
  const r = await run(() => client.getStationList('https://eu5.test', 'tok'), FAIL(20001), FAIL(20001));
  assert.deepStrictEqual(r.stations, []);
  assert.strictEqual(r.failCode, 20001);
  assert.match(r.failMessage, /account does not exist/,
    'pairing fails with no reason at all, which reads as an account with no plants');
});

// ── B: the station reading carries its reason ────────────────────────────────

test('a refused station reading says so instead of reading as empty', async () => {
  const r = await run(() => client.getStationRealKpiRaw('https://eu5.test', 'tok', 'NE=1'), FAIL(407));
  assert.strictEqual(r.raw, null);
  assert.strictEqual(r.failCode, 407);
  assert.match(r.failMessage, /[Rr]ate limit/,
    'a call turned away is indistinguishable from a plant with nothing to report');
});

test('a station reading that arrives carries no reason', async () => {
  const r = await run(
    () => client.getStationRealKpiRaw('https://eu5.test', 'tok', 'NE=1'),
    OK([{ stationCode: 'NE=1', dataItemMap: { day_power: 31.89 } }]),
  );
  assert.deepStrictEqual(r.raw, { day_power: 31.89 });
  assert.strictEqual(r.failCode, null);
});

// ── C: the device types the interface actually serves ────────────────────────

test('the served device types are the ones section 3.2.6 lists', () => {
  for (const t of [1, 10, 17, 38, 39, 41, 47]) {
    assert.ok(client.DEV_KPI_TYPES.has(t), `type ${t} is in the reference but not in the set`);
  }
  // An EMMA is not in the reference and answers anyway — measured on the plant in #28.
  assert.ok(client.DEV_KPI_TYPES.has(23070),
    'the EMMA type was dropped, which takes the grid readings off an EMMA-managed plant');
  // A dongle is not served. Asking spends a call to be told failCode 20013.
  assert.ok(!client.DEV_KPI_TYPES.has(62), 'a dongle is queried again, for a guaranteed 20013');
  assert.ok(!client.DEV_KPI_TYPES.has(23071), 'a SmartGuard is queried, which the reference does not serve');
});

test('the diagnostic reports an unserved type rather than asking for it', () => {
  const fs  = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  assert.match(src, /if \(!OPENAPI_DEV_KPI_TYPES\.has\(t\)\) \{/,
    'every device type in the plant is queried again, dongles included');
  assert.match(src, /not queried — getDevRealKpi does not serve this device type/,
    'a skipped type vanishes from the report, which is worse than one that says why');
});
