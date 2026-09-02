'use strict';

// What the OpenAPI coordinator does when the cloud stops answering. Run: node --test
//
// Field report, issue #26: the plant owner switched "Access to API" off, the API began
// returning failCode 20056, and a LUNA2000 sat at 22 % SoC for hours while the official
// app showed it charging. Nothing on screen said the figure was old.
//
// Three things made that possible, and each is asserted here:
//   1. the cached KPI had no age at all, so a reading from six hours ago was served
//      exactly like one from five minutes ago;
//   2. a failed call does not throw — the station KPI comes back as kpi:null and the
//      device KPI as an empty list — so the poll's catch block never ran;
//   3. the loop that hands data to the devices called setAvailable() every time, which
//      does not merely fail to flag stale data: it asserts the device is fine.

const test   = require('node:test');
const assert = require('node:assert');

const { StationSession } = require('../lib/openapi-coordinator');

const MINUTE = 60_000;
const TYPE = 39;

// A device the coordinator can drive, recording what was done to it.
function fakeDevice() {
  const d = {
    available: true,
    polls: [],
    unavailableReasons: [],
    getName: () => 'Fake LUNA2000',
    getSetting: (k) => ({ username: 'u', system_code: 'c' }[k] ?? null),
    getDevTypes: () => [TYPE],
    onPollData: async (payload) => { d.polls.push(payload); },
    getAvailable: () => d.available,
    setAvailable: async () => { d.available = true; },
    setUnavailable: async (reason) => { d.available = false; d.unavailableReasons.push(reason); },
  };
  return d;
}

// A session whose network calls are replaced by a queue of canned answers, so a whole
// poll can be run without touching the cloud. _withAutoRelogin is the single choke point
// every API call goes through; _ensureDevIds is stubbed because it would use it too.
function fakeSession() {
  const logs = [];
  const homey = {
    log:   (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push('ERROR ' + a.join(' ')),
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
  };
  const s = new StationSession(homey, 'ST1');
  const device = fakeDevice();
  s.addDevice(device);
  s._ensureDevIds = async () => { s._devIdsByType = { [TYPE]: ['dev-1'] }; };
  s._queue = [];
  s._withAutoRelogin = async () => {
    if (!s._queue.length) throw new Error('the test ran out of canned answers');
    return s._queue.shift();
  };
  // One poll per call, regardless of the minimum-gap guard.
  s.poll = async ({ station, dev }) => {
    s._queue = [station, dev];
    s._lastPollAt = 0;
    await s._poll();
  };
  return { s, device, logs, homey };
}

const OK_STATION = { expired: false, kpi: { day_power: 1 } };
const OK_DEV     = { devices: [{ dataItemMap: { battery_soc: 55 } }] };
// What failCode 20056 actually looks like coming back: no throw, no data, a reason.
const DENIED_STATION = {
  expired: false, kpi: null, failCode: 20056,
  failMessage: 'API access is disabled for this plant — enable it under Plant Owner → Configure permissions → Access to API',
};
const DENIED_DEV = { devices: [] };

test('a healthy poll leaves the device available and caches what it got', async () => {
  const { s, device } = fakeSession();
  await s.poll({ station: OK_STATION, dev: OK_DEV });
  assert.strictEqual(device.available, true);
  assert.strictEqual(device.polls.length, 1);
  assert.deepStrictEqual(device.polls[0].freshKpiByType[TYPE], [{ battery_soc: 55 }]);
  assert.ok(s._lastGoodKpiByType[TYPE], 'nothing was cached for the next gap');
  assert.ok(typeof s._lastGoodKpiByType[TYPE].at === 'number',
    'the cache carries no timestamp, so it can never be judged too old');
});

test('a short outage is bridged with the cached reading, and says so', async () => {
  const { s, device, logs } = fakeSession();
  await s.poll({ station: OK_STATION, dev: OK_DEV });
  await s.poll({ station: DENIED_STATION, dev: DENIED_DEV });
  assert.strictEqual(device.available, true, 'one failed poll is not yet a reason to give up');
  assert.deepStrictEqual(device.polls[1].kpiByType[TYPE], [{ battery_soc: 55 }]);
  assert.deepStrictEqual(device.polls[1].freshKpiByType, {},
    'the cached value must not be presented as this cycle\'s live data');
  assert.ok(logs.some((l) => /Using cached KPI/.test(l)));
});

test('past the staleness limit the device goes unavailable, with the reason', async () => {
  const { s, device } = fakeSession();
  await s.poll({ station: OK_STATION, dev: OK_DEV });
  // The outage started 20 minutes ago — past three five-minute cycles.
  await s.poll({ station: DENIED_STATION, dev: DENIED_DEV });
  s._staleSince = Date.now() - 20 * MINUTE;
  await s.poll({ station: DENIED_STATION, dev: DENIED_DEV });

  assert.strictEqual(device.available, false,
    'the device still reports itself healthy while serving hours-old figures');
  assert.match(device.unavailableReasons.at(-1), /Access to API/,
    'the reason must name the setting the owner can actually change');
});

test('past the limit the stale cache is dropped rather than served', async () => {
  const { s, device, logs } = fakeSession();
  await s.poll({ station: OK_STATION, dev: OK_DEV });
  s._lastGoodKpiByType[TYPE].at = Date.now() - 6 * 60 * MINUTE; // six hours, as reported
  await s.poll({ station: DENIED_STATION, dev: DENIED_DEV });

  assert.strictEqual(device.polls[1].kpiByType[TYPE], undefined,
    'a six-hour-old reading was handed to the device as if it were current');
  assert.ok(logs.some((l) => /Dropped cached KPI/.test(l)));
  assert.strictEqual(s._lastGoodKpiByType[TYPE], undefined, 'the expired entry was kept');
});

test('when the API answers again the device recovers by itself', async () => {
  const { s, device } = fakeSession();
  await s.poll({ station: OK_STATION, dev: OK_DEV });
  s._staleSince = Date.now() - 20 * MINUTE;
  await s.poll({ station: DENIED_STATION, dev: DENIED_DEV });
  assert.strictEqual(device.available, false);

  await s.poll({ station: OK_STATION, dev: OK_DEV });
  assert.strictEqual(device.available, true, 'restoring API access should need no re-pairing');
  assert.strictEqual(s._staleSince, null, 'the outage clock has to be reset, or it fires again at once');
});

test('the outage is logged once, not on every poll', async () => {
  const { s, logs } = fakeSession();
  await s.poll({ station: OK_STATION, dev: OK_DEV });
  s._staleSince = Date.now() - 20 * MINUTE;
  for (let i = 0; i < 3; i++) await s.poll({ station: DENIED_STATION, dev: DENIED_DEV });
  const announcements = logs.filter((l) => /nothing fresh for/.test(l)).length;
  assert.strictEqual(announcements, 1,
    'a permanent fault would otherwise fill the log with one identical line every five minutes');
});
