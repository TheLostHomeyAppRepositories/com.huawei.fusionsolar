'use strict';

// The diagnostic report's own call rate. Run: node --test
//
// Issue #28, and the reason it ran long. The "Fetch All" report fired every device type at
// once through Promise.allSettled, which is exactly what lib/openapi-coordinator.js spaces
// its calls out to avoid — its INTER_REQUEST_DELAY constant says "to avoid 407" in as many
// words. Huawei answered the first type and refused the rest:
//
//   getDevRealKpi(type=1)     → 1 device
//   getDevRealKpi(type=39)    → 0 devices — failCode 407: Rate limit exceeded
//   getDevRealKpi(type=23070) → 0 devices — failCode 407
//   getDevRealKpi(type=23071) → 0 devices — failCode 407
//
// Before 1.2.218 that refusal was discarded and the report said only "0 device(s)", which
// was read — by me as much as by anyone — as the API declining to hand over the battery.
// It was our own burst. The device polls normally through the coordinator, and the same
// plant's dashboard shows the battery's state of charge at the same moment.
//
// A diagnostic that provokes the fault it is used to investigate is worse than none, so the
// pacing is checked here by timing the calls rather than by reading the source: a loop that
// looks sequential but awaits nothing would pass a source check.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

test('the diagnostic and the poller share one delay constant', () => {
  const { INTER_REQUEST_DELAY } = require(path.join(ROOT, 'lib', 'openapi-coordinator.js'));
  assert.strictEqual(typeof INTER_REQUEST_DELAY, 'number',
    'the coordinator no longer exports its delay, so api.js has to keep a second copy');
  assert.ok(INTER_REQUEST_DELAY >= 500,
    `${INTER_REQUEST_DELAY} ms between calls is not pacing`);

  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  assert.match(src, /INTER_REQUEST_DELAY: OPENAPI_INTER_REQUEST_DELAY \} = require\('\.\/lib\/openapi-coordinator'\)/,
    'the diagnostic paces itself by its own number again, which can drift from the poller\'s');
  assert.doesNotMatch(src, /Promise\.allSettled\(\s*\n?\s*kpiEntries/,
    'the device-type calls are fired in parallel again — the burst that caused failCode 407');
});

// The behavioural half, driven through api.js's own handler rather than a copy of its loop.
//
// A copy is what the first version of this test used, and it passed happily while the real
// delay was deleted — it was checking the transcription, not the code. The client is stubbed
// underneath instead, so the timing measured is the one a user's report would produce.
const DELAY = require(path.join(ROOT, 'lib', 'openapi-coordinator.js')).INTER_REQUEST_DELAY;

const calls = [];
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './lib/openapi-client') {
    return {
      login:                async () => 'tok',
      getStationList:       async () => ({ stations: [{ stationCode: 'NE=1', stationName: 'test' }] }),
      getStationRealKpiRaw: async () => ({ raw: {} }),
      getDevList:           async () => ({ devices: [
        { id: 1001, devTypeId: 1 }, { id: 1002, devTypeId: 39 },
        { id: 1003, devTypeId: 23070 }, { id: 1004, devTypeId: 23071 },
      ] }),
      getDevRealKpi: async (baseUrl, token, ids, devTypeId) => {
        calls.push({ devTypeId, at: Date.now() });
        return { devices: [], failCode: 407, failMessage: 'Rate limit exceeded' };
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const api = require(path.join(ROOT, 'api.js'));
Module._load = origLoad;

test('the device-type calls are spaced, not fired together', async () => {
  calls.length = 0;
  const report = await api.fetchOpenapiDebug({
    body: { baseUrl: 'https://eu5.test', username: 'u', systemCode: 's' },
  });

  assert.strictEqual(calls.length, 4, 'not every device type was asked for');
  for (let i = 1; i < calls.length; i++) {
    const gap = calls[i].at - calls[i - 1].at;
    // Timers fire no earlier than asked, but can be a hair short on some platforms.
    assert.ok(gap >= DELAY - 25,
      `type ${calls[i].devTypeId} was called ${gap} ms after the previous one, not ${DELAY} — `
      + 'this is the burst that produced failCode 407 on a real plant');
  }

  // And the report still says what happened, which is the other half of being useful.
  const line = report.steps.find((s) => s.step === 'getDevRealKpi(type=39)');
  assert.ok(line, 'the battery type is missing from the report entirely');
  assert.match(line.data, /0 device\(s\) — failCode 407: Rate limit exceeded/);
});

// The order matters for reading the report: a type that fails after a spaced call has a
// different meaning from one that failed inside a burst.
test('every device type still appears in the report, in the order it was asked', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  const loop = src.slice(src.indexOf('const kpiResults = [];'),
                         src.indexOf('for (const r of kpiResults)'));
  assert.match(loop, /for \(const \[typeId, ids\] of kpiEntries\)/,
    'the report no longer walks every type it found in the device list');
  assert.match(loop, /kpiResults\.push\(await openapiGetDevRealKpi/,
    'the call is not awaited inside the loop, so the spacing does nothing');
  assert.match(loop, /\.catch\(\(err\) => \(\{ typeId, error: err\.message, ok: false \}\)\)/,
    'a throwing type now aborts the whole report instead of being recorded and skipped');
});

// The 407 that started this has to stay legible in the output, or a paced run that still
// trips the limit looks the same as a genuinely empty device type.
test('a rate-limited type is still reported with its code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  assert.match(src, /failCode \$\{r\.failCode\}: \$\{r\.failMessage\}/,
    'the reason was dropped from the report again');

  // Read from the source rather than required: FAIL_MESSAGES is deliberately private, and a
  // `if (exported)` guard around this would have made the assertion vacuous.
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'openapi-client.js'), 'utf8');
  const from   = client.indexOf('const FAIL_MESSAGES');
  assert.notStrictEqual(from, -1, 'the failure-code table is gone');
  const table  = client.slice(from, client.indexOf('};', from));
  assert.match(table, /^\s*407:.*[Rr]ate limit/m,
    '407 no longer reads as a rate limit, which is the one code this report exists to show');
});
