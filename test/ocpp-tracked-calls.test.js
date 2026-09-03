'use strict';

// Every command to the charger waits for its answer. Run: node --test
//
// There used to be two ways to send one: a tracked path that resolved with the charger's
// response, and an untracked one that wrote to the socket and returned. Both sets carried
// the same names, the untracked ones simply without the Async suffix, and call sites picked
// whichever. A field log from 2026-09-03 shows how that reads:
//
//   [OcppServer] → SetChargingProfile
//   [OCPP] Init profile applied: 16A
//
// The second line was an assumption. The charger answers SetChargingProfile with Accepted
// or Rejected, and on the untracked path that answer arrived, found no waiting caller and
// was dropped — so a refused profile and an accepted one produced identical logs. The one
// that went out unchecked was the first profile after connecting: the one that decides
// whether the car may draw current at all.
//
// A comparable app that works well on this hardware has only the tracked form, which is
// what settled the question of whether both were worth keeping.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SRV = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ocpp-server.js'), 'utf8');
const DEV = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');

// The five commands that had an untracked twin.
const COMMANDS = ['remoteStart', 'remoteStop', 'setMaxCurrent', 'setTxProfile', 'changeAvailability'];

test('the untracked sender is gone, not merely unused', () => {
  assert.doesNotMatch(SRV, /_sendCall\(/,
    'the fire-and-forget sender is back; a path that exists is a path a call site will use');
  assert.match(SRV, /_sendCallAsync\(ws, action, payload/,
    'the tracked sender was removed along with it');
});

test('no command has an untracked twin any more', () => {
  for (const name of COMMANDS) {
    assert.doesNotMatch(SRV, new RegExp(`\\n  ${name}\\(`),
      `${name} exists alongside ${name}Async again — two ways to send one command is how `
      + 'the unchecked one got picked in the first place');
    assert.match(SRV, new RegExp(`async ${name}Async\\(`),
      `${name}Async is missing, so nothing sends this command at all`);
  }
});

test('the driver sends every command through the tracked form', () => {
  for (const name of COMMANDS) {
    // `.setMaxCurrent(` must not appear; `.setMaxCurrentAsync(` may.
    const untracked = new RegExp(`\\.${name}\\(`, 'g');
    const hits = [...DEV.matchAll(untracked)];
    assert.strictEqual(hits.length, 0,
      `the driver calls ${name}() ${hits.length} time(s) without awaiting an answer`);
  }
});

// The point of tracking is that the answer reaches the log. A call that is awaited and then
// reported as success regardless would pass every assertion above and still lie.
test('the first profile after connecting reports what the charger said', () => {
  assert.doesNotMatch(DEV, /Init profile applied/,
    'the init log still states the profile was applied rather than what came back');
  assert.doesNotMatch(DEV, /Boot profile applied/,
    'the boot log still states the profile was applied rather than what came back');
  assert.match(DEV, /Init profile \$\{initAmps\}A . \$\{\(r && r\.status\)/,
    'the init profile no longer logs the charger response');
  assert.match(DEV, /Boot profile \$\{bootAmps\}A . \$\{\(r && r\.status\)/,
    'the boot profile no longer logs the charger response');
});

// A command that goes unanswered must be visible, not swallowed. Several of these run in
// timers where an empty catch was the old habit.
// Empty catches elsewhere in the driver are legitimate — a store write or a capability set
// that fails is not worth interrupting a poll for. A command to the charger is different:
// it is the thing the user asked for, and silence about it is what this whole file is about.
test('a command that fails is logged rather than swallowed', () => {
  for (const name of COMMANDS) {
    const re = new RegExp(`${name}Async\\([^;]*;[\\s\\S]{0,400}?catch \\(e\\) \\{ /\\*`, 'g');
    assert.strictEqual([...DEV.matchAll(re)].length, 0,
      `a failed ${name}Async is still swallowed by an empty catch`);
  }
});
