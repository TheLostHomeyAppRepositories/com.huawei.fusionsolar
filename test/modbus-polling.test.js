'use strict';

// Unit tests for the shared Modbus polling mixin, plus a structural guard over the
// drivers that use it. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const modbusPolling = require('../lib/modbus-polling');
const { WATCHDOG_STUCK_MS } = modbusPolling;

// Minimal stand-in for a Homey Device: only what the mixin actually touches.
function makeDevice({ pollDefaultS = 60, pollMinS = 10, settings = {}, caps = {} } = {}) {
  const dev = {
    pollDefaultS, pollMinS,
    constructor: { name: 'FakeDevice' },
    logs: [], errors: [], intervals: [], cleared: [],
    log:   (...a) => dev.logs.push(a.join(' ')),
    error: (...a) => dev.errors.push(a.join(' ')),
    getSetting: (k) => settings[k],
    hasCapability:      (c) => c in caps,
    getCapabilityValue: (c) => caps[c],
    setCapabilityValue: async (c, v) => {
      if (v === 'boom') throw new Error('capability rejected');
      caps[c] = v;
    },
    caps,
    homey: {
      setInterval: (fn, ms) => { const h = { fn, ms }; dev.intervals.push(h); return h; },
      clearInterval: (h) => dev.cleared.push(h),
    },
    _fetchAndUpdate: async () => {},
  };
  Object.assign(dev, modbusPolling);
  return dev;
}

// ── _intervalMs ──────────────────────────────────────────────────────────────
test('_intervalMs — a valid setting wins', () => {
  assert.strictEqual(makeDevice({ settings: { poll_interval: '25' } })._intervalMs(), 25_000);
});
test('_intervalMs — below the minimum falls back to the driver default', () => {
  assert.strictEqual(makeDevice({ settings: { poll_interval: '3' } })._intervalMs(), 60_000);
});
test('_intervalMs — an unparseable setting falls back to the driver default', () => {
  assert.strictEqual(makeDevice({ settings: { poll_interval: 'sixty' } })._intervalMs(), 60_000);
  assert.strictEqual(makeDevice({ settings: {} })._intervalMs(), 60_000);
});
test('_intervalMs — a driver with its own default keeps it (the 30 s EMMA charger)', () => {
  // The regression this whole extraction could most easily have caused: _intervalMs was
  // byte-identical in all eight drivers but closed over per-file constants, and the
  // charger's is 30, not 60. Reading it off the driver is what preserves that.
  const d = makeDevice({ pollDefaultS: 30, settings: { poll_interval: '' } });
  assert.strictEqual(d._intervalMs(), 30_000);
});
test('_intervalMs — a driver that forgets the getters degrades loudly, not fatally', () => {
  const d = makeDevice({ settings: {} });
  d.pollDefaultS = undefined; d.pollMinS = undefined;
  assert.strictEqual(d._intervalMs(), 60_000);
  assert.match(d.errors.join('\n'), /pollDefaultS\/pollMinS not declared/);
});

// ── _startPolling / _stopPolling ─────────────────────────────────────────────
test('_startPolling — registers the poll timer at the configured interval plus a watchdog', async () => {
  const d = makeDevice({ settings: { poll_interval: '20' } });
  await d._startPolling();
  assert.strictEqual(d.intervals.length, 2);
  assert.strictEqual(d.intervals[0].ms, 20_000);
  assert.strictEqual(d.intervals[1].ms, 60_000);
});
test('_stopPolling — clears both timers and drops the handles', async () => {
  const d = makeDevice();
  await d._startPolling();
  const handles = [d._timer, d._watchdogTimer];
  await d._stopPolling();
  assert.deepStrictEqual(d.cleared, handles);
  assert.strictEqual(d._timer, null);
  assert.strictEqual(d._watchdogTimer, null);
});
test('_stopPolling — is safe to call when polling never started', async () => {
  const d = makeDevice();
  await d._stopPolling();
  assert.deepStrictEqual(d.cleared, []);
});

// ── watchdog ─────────────────────────────────────────────────────────────────
test('watchdog — releases a fetch flag that has been stuck past the limit', async () => {
  const d = makeDevice();
  await d._startPolling();
  d._fetchInProgress = true;
  d._lastPollStart = Date.now() - (WATCHDOG_STUCK_MS + 10_000);
  d.intervals[1].fn();
  assert.strictEqual(d._fetchInProgress, false);
  assert.match(d.errors.join('\n'), /stuck for \d+s/);
});
test('watchdog — leaves a poll that is merely slow alone', async () => {
  const d = makeDevice();
  await d._startPolling();
  d._fetchInProgress = true;
  d._lastPollStart = Date.now() - 30_000;
  d.intervals[1].fn();
  assert.strictEqual(d._fetchInProgress, true);
  assert.deepStrictEqual(d.errors, []);
});

// ── _set ─────────────────────────────────────────────────────────────────────
test('_set — writes a changed value', async () => {
  const d = makeDevice({ caps: { measure_power: 100 } });
  await d._set('measure_power', 250);
  assert.strictEqual(d.caps.measure_power, 250);
});
test('_set — skips null, undefined, unknown capabilities and unchanged values', async () => {
  const d = makeDevice({ caps: { measure_power: 100 } });
  await d._set('measure_power', null);
  await d._set('measure_power', undefined);
  await d._set('measure_power', 100);
  await d._set('not_a_capability', 5);
  assert.strictEqual(d.caps.measure_power, 100);
  assert.strictEqual('not_a_capability' in d.caps, false);
});
test('_set — a rejecting capability is logged, not thrown', async () => {
  const d = makeDevice({ caps: { measure_power: 1 } });
  await assert.doesNotReject(() => d._set('measure_power', 'boom'));
  assert.match(d.logs.join('\n'), /_set\(measure_power, boom\) failed/);
});

// ── mixin hygiene ────────────────────────────────────────────────────────────
test('the mixin exports only methods, so Object.assign adds no stray members', () => {
  for (const [k, v] of Object.entries(modbusPolling)) {
    assert.strictEqual(typeof v, 'function', `${k} is not a method`);
  }
});

// ── structural guard over the real drivers ───────────────────────────────────
const MODBUS_DRIVERS = fs.readdirSync('drivers')
  .filter((d) => d.endsWith('_modbus') && fs.existsSync(path.join('drivers', d, 'device.js')));

test('every Modbus driver uses the mixin instead of its own copy', () => {
  assert.ok(MODBUS_DRIVERS.length >= 8, 'expected at least 8 Modbus drivers');
  for (const d of MODBUS_DRIVERS) {
    const s = fs.readFileSync(path.join('drivers', d, 'device.js'), 'utf8');
    assert.match(s, /require\('\.\.\/\.\.\/lib\/modbus-polling'\)/, `${d}: does not require the mixin`);
    assert.match(s, /Object\.assign\(\s*\w+\.prototype,\s*modbusPolling\s*\)/, `${d}: does not apply the mixin`);
    for (const m of ['_intervalMs', '_startPolling', '_stopPolling', '_set']) {
      assert.doesNotMatch(s, new RegExp('^  (?:async )?' + m + '\\s*\\(', 'm'), `${d}: still defines its own ${m}`);
    }
  }
});

test('every Modbus driver declares its own poll interval, so the mixin never guesses', () => {
  for (const d of MODBUS_DRIVERS) {
    const s = fs.readFileSync(path.join('drivers', d, 'device.js'), 'utf8');
    assert.match(s, /get pollDefaultS\(\)/, `${d}: missing pollDefaultS`);
    assert.match(s, /get pollMinS\(\)/,     `${d}: missing pollMinS`);
  }
});

test('the EMMA smart charger still polls twice as often as the rest', () => {
  // Pinned as a value, not as "whatever the file says": this is the one driver whose
  // interval differs, and it is the one an extraction would silently normalise away.
  const read = (d) => {
    const s = fs.readFileSync(path.join('drivers', d, 'device.js'), 'utf8');
    return Number(/DEFAULT_INTERVAL_S\s*=\s*(\d+)/.exec(s)[1]);
  };
  assert.strictEqual(read('smartcharger_emma_modbus'), 30);
  for (const d of MODBUS_DRIVERS.filter((x) => x !== 'smartcharger_emma_modbus')) {
    assert.strictEqual(read(d), 60, `${d}: unexpected default interval`);
  }
});
