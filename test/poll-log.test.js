'use strict';

// Unit tests for the "Poll OK" log throttle. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const { logPollOk, logPollError, POLL_LOG_HEARTBEAT_MS, ERROR_ALWAYS_FIRST } = require('../lib/poll-log');

function makeDevice() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (l) => lines.push(l), error: (l) => errors.push(l) };
}

test('logPollOk — the first line is always written', () => {
  const d = makeDevice();
  assert.strictEqual(logPollOk(d, 'Poll OK: PV=0W', 1_000), true);
  assert.deepStrictEqual(d.lines, ['Poll OK: PV=0W']);
});

test('logPollOk — further polls inside the window write nothing', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  logPollOk(d, 'first', t0);
  for (let i = 1; i <= 14; i++) {
    assert.strictEqual(logPollOk(d, 'poll ' + i, t0 + i * 60_000), false);
  }
  assert.deepStrictEqual(d.lines, ['first']); // 14 minutes of polling, one line
});

test('logPollOk — the heartbeat line reports how many polls it stands for', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  logPollOk(d, 'first', t0);
  for (let i = 1; i <= 14; i++) logPollOk(d, 'poll ' + i, t0 + i * 60_000);
  assert.strictEqual(logPollOk(d, 'Poll OK: PV=4200W', t0 + POLL_LOG_HEARTBEAT_MS), true);
  assert.strictEqual(d.lines.length, 2);
  assert.match(d.lines[1], /^Poll OK: PV=4200W\s+\(\+14 polls since last line\)$/);
});

test('logPollOk — the counter restarts after each written line', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  logPollOk(d, 'a', t0);
  logPollOk(d, 'b', t0 + 60_000);                          // suppressed, count 1
  logPollOk(d, 'c', t0 + POLL_LOG_HEARTBEAT_MS);           // written, "+1"
  logPollOk(d, 'd', t0 + POLL_LOG_HEARTBEAT_MS * 2);       // written, no suffix again
  assert.match(d.lines[1], /\(\+1 polls since last line\)/);
  assert.strictEqual(d.lines[2], 'd');
});

test('logPollOk — a backwards clock step does not wedge the throttle', () => {
  const d = makeDevice();
  logPollOk(d, 'from the future', 9_000_000);
  // NTP corrects the clock backwards: without the guard this would stay suppressed
  // until real time passed the stale timestamp again.
  assert.strictEqual(logPollOk(d, 'after correction', 1_000_000), true);
  assert.strictEqual(d.lines.length, 2);
});

test('logPollOk — devices throttle independently of each other', () => {
  const t0 = 1_000_000;
  const a = makeDevice(); const b = makeDevice();
  logPollOk(a, 'a1', t0);
  logPollOk(a, 'a2', t0 + 60_000);   // suppressed on a
  assert.strictEqual(logPollOk(b, 'b1', t0 + 60_000), true); // b is untouched by a
  assert.deepStrictEqual(a.lines, ['a1']);
  assert.deepStrictEqual(b.lines, ['b1']);
});

test('logPollOk — one heartbeat per window, i.e. 96 lines a day instead of 1440', () => {
  const d = makeDevice();
  for (let i = 0; i < 1440; i++) logPollOk(d, 'poll', i * 60_000); // 24 h at 60 s
  assert.strictEqual(d.lines.length, 96);
});

// ── logPollError ─────────────────────────────────────────────────────────────
// The rendered line carries a counter that changes every poll, so `key` is what
// decides sameness — exactly as the drivers call it.
const fail = (d, n, msg, t) => logPollError(d, `Fetch error (${n}): ${msg}`, msg, t);

test('logPollError — the descent into "unavailable" is logged in full', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  for (let i = 1; i <= ERROR_ALWAYS_FIRST; i++) {
    assert.strictEqual(fail(d, i, 'No route to 10.0.0.5', t0 + i * 60_000), true);
  }
  // The drivers call setUnavailable on the third failure; all three must be readable.
  assert.strictEqual(d.errors.length, 3);
  assert.match(d.errors[2], /Fetch error \(3\)/);
});

test('logPollError — unchanged repetition past that is throttled', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  for (let i = 1; i <= 14; i++) fail(d, i, 'No route to 10.0.0.5', t0 + i * 60_000);
  assert.strictEqual(d.errors.length, ERROR_ALWAYS_FIRST); // 3, not 14
});

test('logPollError — the heartbeat line counts the repetitions it stands for', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  for (let i = 1; i <= 30; i++) fail(d, i, 'No route to 10.0.0.5', t0 + i * 60_000);
  assert.strictEqual(d.errors.length, 4); // 3 + one heartbeat
  assert.match(d.errors[3], /\(\+\d+ identical failures since last line\)/);
});

test('logPollError — a different fault gets its own three lines', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  for (let i = 1; i <= 10; i++) fail(d, i, 'No route to 10.0.0.5', t0 + i * 60_000);
  assert.strictEqual(d.errors.length, 3);
  // The cable is back but Modbus TCP is off: a new symptom, not more of the same.
  for (let i = 11; i <= 13; i++) fail(d, i, 'Connection refused', t0 + i * 60_000);
  assert.strictEqual(d.errors.length, 6);
  assert.match(d.errors[5], /Connection refused/);
});

test('logPollError — a week offline costs a few hundred lines, not ten thousand', () => {
  const polls = 7 * 1440; // one a minute for a week
  const d = makeDevice();
  for (let i = 1; i <= polls; i++) fail(d, i, 'No route to 10.0.0.5', i * 60_000);
  // 3 immediate + one per 15-minute window. The windows are counted from the third
  // failure (minute 3), not from minute 0, so the last one falls past the week's end
  // and 671 fit rather than 672.
  assert.strictEqual(d.errors.length, ERROR_ALWAYS_FIRST + 671);
  assert.strictEqual(d.errors.length, 674);
  assert.ok(d.errors.length / polls < 0.07, 'should be well under a tenth of the polls');
});

// ── the two together ─────────────────────────────────────────────────────────
test('recovery is always logged, even inside the success heartbeat window', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  logPollOk(d, 'Poll OK: PV=4200W', t0);              // written
  fail(d, 1, 'No route to 10.0.0.5', t0 + 60_000);    // written
  // Back a minute later — well inside the 15-minute window, but this line is what
  // closes off the failure above it, so it has to appear.
  assert.strictEqual(logPollOk(d, 'Poll OK: PV=4100W', t0 + 120_000), true);
  assert.deepStrictEqual(d.lines, ['Poll OK: PV=4200W', 'Poll OK: PV=4100W']);
});

// ── structural guard over the real drivers ───────────────────────────────────
test('every Modbus driver routes both its poll lines through the throttles', () => {
  const fs   = require('fs');
  const path = require('path');
  const drivers = fs.readdirSync('drivers')
    .filter((d) => d.endsWith('_modbus') && fs.existsSync(path.join('drivers', d, 'device.js')));
  assert.ok(drivers.length >= 8, 'expected at least 8 Modbus drivers');
  for (const d of drivers) {
    const s = fs.readFileSync(path.join('drivers', d, 'device.js'), 'utf8');
    assert.match(s, /logPollOk\(this,/,    `${d}: success line not throttled`);
    assert.match(s, /logPollError\(this,/, `${d}: poll failure not throttled`);
    // The raw call is what floods the buffer; nothing may reintroduce it.
    assert.doesNotMatch(s, /this\.error\(`Fetch error/, `${d}: still calls this.error directly`);
    assert.doesNotMatch(s, /this\.log\(['`]Poll/,       `${d}: still calls this.log directly`);
  }
});

test('the poll-error throttle keys on the message, never on the rendered line', () => {
  // Guard against the obvious mis-call: the rendered line carries a counter that changes
  // every poll, so passing it as the key would make every failure look new and throttle
  // nothing at all. This is the mistake the two-argument signature exists to prevent.
  const t0 = 1_000_000;
  const d = makeDevice();
  for (let i = 1; i <= 20; i++) {
    const line = `Fetch error (${i}): No route to 10.0.0.5`;
    logPollError(d, line, line, t0 + i * 60_000); // key == line: the wrong way
  }
  assert.strictEqual(d.errors.length, 20); // nothing throttled — as warned
});

test('a success re-arms the full error budget for the next outage', () => {
  const t0 = 1_000_000;
  const d = makeDevice();
  for (let i = 1; i <= 10; i++) fail(d, i, 'No route to 10.0.0.5', t0 + i * 60_000);
  assert.strictEqual(d.errors.length, 3);
  logPollOk(d, 'Poll OK', t0 + 11 * 60_000);
  // Same fault again after recovery: a second outage is a second story.
  for (let i = 1; i <= 10; i++) fail(d, i, 'No route to 10.0.0.5', t0 + (11 + i) * 60_000);
  assert.strictEqual(d.errors.length, 6);
});
