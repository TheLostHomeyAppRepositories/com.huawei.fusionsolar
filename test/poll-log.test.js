'use strict';

// Unit tests for the "Poll OK" log throttle. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const { logPollOk, POLL_LOG_HEARTBEAT_MS } = require('../lib/poll-log');

function makeDevice() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
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
