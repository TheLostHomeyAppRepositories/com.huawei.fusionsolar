'use strict';

// When the charger is told what to measure. Run: node --test
//
// Field-caught 2026-09-03, alongside the charging-state bug, in the same log:
//
//   [OcppServer] Client connected: OtthoniTolto (::ffff:192.168.0.121)
//   [OCPP] Charger connected
//   ← StatusNotification  (status: Available)
//   → SetChargingProfile
//   ← Heartbeat  ×N
//
// No BootNotification anywhere. A charger sends that when IT boots, and this one had been
// running for hours — the Homey app had restarted, so the charger merely reconnected its
// WebSocket. Configuration hung off the boot message alone, so MeterValuesSampledData and
// MeterValueSampleInterval were never sent, and a charger that is never told what to sample
// sends no MeterValues at all. Every current, voltage and temperature stayed blank, with no
// error anywhere to explain it.
//
// Asserted on the source rather than by running a WebSocket server: what matters is which
// events lead to the call, and that is a question about wiring.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ocpp-server.js'), 'utf8');

// The body of a method, anchored on its DEFINITION rather than the first mention of its
// name — a call site reads just like one and slices in the wrong place, which is how the
// first version of this file managed to fail against correct code.
function block(name) {
  const at = SRC.indexOf(`\n  ${name} {`);
  assert.ok(at > 0, `${name} is gone or renamed`);
  const end = SRC.indexOf('\n  }\n', at);
  assert.ok(end > at, `could not find the end of ${name}`);
  return SRC.slice(at, end);
}

test('a charger that connects is configured, boot message or not', () => {
  assert.match(block('_onConnection(ws, req)'), /_configureCharger\(stationId, ws\)/,
    'configuration still happens only after a BootNotification, so a charger that '
    + 'reconnects without rebooting is never told what to sample');
});

// The boot path is kept as well. A charger that has just powered up may not accept settings
// immediately, and ChangeConfiguration is idempotent, so arriving twice costs nothing.
test('a real boot still reconfigures', () => {
  assert.match(SRC, /case 'BootNotification':[\s\S]{0,600}?_configureCharger\(stationId, ws\)/,
    'the boot path lost its configuration call');
});

// The whole point of configuring: without these two keys many chargers send no MeterValues,
// which is exactly the blank device the owner reported.
test('the configuration asks for the readings the device shows', () => {
  const body = block('_configureCharger(stationId, ws)');
  assert.match(body, /key:\s*'MeterValuesSampledData'/,
    'the charger is no longer told which measurements to sample');
  assert.match(body, /key:\s*'MeterValueSampleInterval'/,
    'the charger is no longer told how often to send them');
  for (const measurand of ['Power.Active.Import', 'Current.Import', 'Voltage']) {
    assert.ok(body.includes(measurand),
      `${measurand} is not requested, so that row on the device stays blank`);
  }
});

// Sending into a socket that is closing throws, and this runs on a timer after the event.
test('configuration checks the socket is still open before writing to it', () => {
  const body = block('_configureCharger(stationId, ws)');
  assert.match(body, /if \(!ws \|\| ws\.readyState !== ws\.OPEN\) return;/,
    'a charger that disconnected inside the delay would be written to anyway');
});
