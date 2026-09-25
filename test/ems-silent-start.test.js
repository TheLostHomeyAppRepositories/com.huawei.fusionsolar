'use strict';

// A start the charger never acted on (lib/ems/chargerControl.js, _stepCharger).
//
// From the 2026-09-25 field log: between 15:10 and 17:30 the EMS started the charger
// eleven times. Every attempt was stopped again within a minute, the dehumidifier was
// pushed into stop-grace by each start and released by each stop — twenty-two mode
// changes — and the car never drew an amp. Charging began only when the owner pressed
// Start in the charger's own app.
//
// The gap: the measurement block in _stepCharger raises `cur` when the meter shows MORE
// than was commanded, and did nothing at all when it showed nothing. A charger that
// ignored its start therefore kept its whole share of the surplus while drawing zero.
//
// These run the real _stepCharger and read the triggers it fires. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const chargerMixin = require('../lib/ems/chargerControl');
const timingMixin  = require('../lib/ems/timing');
const {
  CHARGER_START_GRACE_MS, CHARGER_START_GIVEUP_MS, CHARGER_IGNORED_BACKOFF_MS,
  CHARGER_LIVE_W, STEP_HOLD_MS,
} = require('../lib/ems/constants');

const CH = 'charger-1';
// Anchored to the real clock on purpose. _stepCharger reasons with the `now` it is handed,
// but _chargerStop stamps lastDownStepAt with Date.now() of its own — the same clock in
// production, two clocks months apart under a synthetic T0, and FLIP_COOLDOWN_MS would
// then never expire. That is also why the silent-start clock is stamped inside
// _stepCharger rather than where the start is sent.
const T0   = Date.now();
const TICK = 20_000;          // what the field device runs at
const BUDGET = 2760;          // buys 12 A at one phase, well clear of the 6 A floor
const EXPORTING = -2829;      // the grid reading from the log while all this happened

function makeDevice() {
  const dev = {
    fired: [], logs: [],
    log(m) { this.logs.push(m); },
    error() {},
    _chargerStates: new Map(),
    _warmupDone: true,
    _addHistoryEvent() {},
    homey: {
      flow: {
        getTriggerCard: (id) => ({
          trigger: (tokens) => { dev.fired.push({ id, ...tokens }); return Promise.resolve(); },
        }),
      },
      setTimeout, clearTimeout,
    },
  };
  Object.assign(dev, timingMixin, chargerMixin);
  return dev;
}

const charger = (over = {}) => ({
  id: CH, connected: true, minAmps: 6, maxAmps: 16, phases: 1,
  phaseSwitch: false, powerW: 0, ...over,
});

const step   = (dev, t, over) => dev._stepCharger(charger(over), BUDGET, 1, t, EXPORTING, false);
const starts = (d) => d.fired.filter((f) => f.id === 'ems_start_charger').length;
const zeros  = (d) => d.fired.filter((f) => f.id === 'ems_set_charger_current' && f.amps === 0).length;

// The amp ladder holds a step for STEP_HOLD_MS before committing it, so a start costs two
// ticks. Returns the time of the first tick that SAW the charger commanded and silent —
// which is where the grace clock starts, and therefore what every deadline below counts
// from.
async function startAndGoSilent(dev, t0 = T0) {
  await step(dev, t0);                      // step pending
  await step(dev, t0 + STEP_HOLD_MS + 1);   // start issued
  const silentSince = t0 + STEP_HOLD_MS + 1 + TICK;
  await step(dev, silentSince);             // first silent tick: clock starts
  return silentSince;
}

// ── the grace ───────────────────────────────────────────────────────────────────

test('a charger that has just been started is not stopped for drawing nothing', async () => {
  // The exact shape of the field failure: commanded, silent, killed 57 s later — inside the
  // window a VW MEB car needs between contactor and first amp.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  assert.strictEqual(starts(dev), 1, 'the harness never got it started');

  const r = await step(dev, t + 57_000);

  assert.strictEqual(zeros(dev), 0, 'stopped 57 s after the start, inside the grace');
  assert.ok(r.amps > 0, 'dropped while still within its grace');
});

test('the allocation it holds is the amps it was commanded, not zero', async () => {
  // It still counts against the surplus while we wait: the car may be about to take it, and
  // handing the watts to the dehumidifier only to claw them back is the flapping this ends.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  const held = await step(dev, t + TICK);

  assert.strictEqual(held.amps, 12);
  assert.strictEqual(held.allocatedW, 12 * 230);
});

// ── the retry ───────────────────────────────────────────────────────────────────

test('past the grace the start is sent once more', async () => {
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);

  await step(dev, t + CHARGER_START_GRACE_MS + 1);

  assert.strictEqual(starts(dev), 2, 'the start was not repeated after the grace ran out');
  assert.strictEqual(zeros(dev), 0, 'a retry is not a stop');
});

test('the start is repeated once, not on every tick', async () => {
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  for (let i = 1; i <= 6; i++) await step(dev, t + CHARGER_START_GRACE_MS + i * TICK);

  assert.strictEqual(starts(dev), 2, 'one original start and exactly one retry');
});

test('the retry does not restart the clock, or giving up would never arrive', async () => {
  // _chargerSetAmps re-enters its start branch with currentAmps cleared. Stamping the clock
  // there would push the deadline out by a grace on every retry.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  await step(dev, t + CHARGER_START_GRACE_MS + 1);

  await step(dev, t + CHARGER_START_GIVEUP_MS);

  assert.strictEqual(zeros(dev), 1, 'the deadline moved with the retry instead of standing still');
});

// ── giving up ───────────────────────────────────────────────────────────────────

test('after the full patience it stops and hands the surplus back', async () => {
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  await step(dev, t + CHARGER_START_GRACE_MS + 1);

  const r = await step(dev, t + CHARGER_START_GIVEUP_MS);

  assert.strictEqual(zeros(dev), 1, 'no stop was sent');
  assert.strictEqual(r.allocatedW, 0, 'the surplus stayed reserved for a charger taking none');
  assert.ok(dev.logs.some((l) => l.includes('ems_start_charger') && l.includes('flow')),
    'the log does not point at the flow that has to be checked');
});

test('after giving up, the surplus path leaves it alone', async () => {
  // The loop this ends: FLIP_COOLDOWN_MS alone let the charger be poked every six minutes
  // for as long as the sun shone — eleven times in the log.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  await step(dev, t + CHARGER_START_GRACE_MS + 1);
  await step(dev, t + CHARGER_START_GIVEUP_MS);
  const before = starts(dev);

  // Well past FLIP_COOLDOWN_MS, still inside the back-off.
  for (const d of [400_000, 800_000, 1_200_000, 1_600_000]) {
    await step(dev, t + CHARGER_START_GIVEUP_MS + d);
  }

  assert.strictEqual(starts(dev), before, 'it was started again during the back-off');
  assert.strictEqual(zeros(dev), 1, 'and stopped again, which means it had been started');
});

test('once the back-off expires it tries again', async () => {
  // A back-off, not a ban: a charger may have been rebooted, a flow fixed, a car swapped.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  await step(dev, t + CHARGER_START_GRACE_MS + 1);
  const gaveUp = t + CHARGER_START_GIVEUP_MS;
  await step(dev, gaveUp);
  const before = starts(dev);

  const after = gaveUp + CHARGER_IGNORED_BACKOFF_MS + 1;
  await step(dev, after);                      // step pending again
  await step(dev, after + STEP_HOLD_MS + 1);   // and committed

  assert.strictEqual(starts(dev), before + 1, 'the back-off never let go');
});

test('the second attempt gets a full grace of its own, not the leftovers of the first', async () => {
  // Found by the mutation probe: dropping the reset in _chargerStop left commandedSince
  // pointing at the FIRST attempt. The next start would then measure its silence from half
  // an hour ago, blow straight past CHARGER_START_GIVEUP_MS on its first silent tick and be
  // stopped again immediately — a charger that had been given a second chance on paper and
  // none at all in practice.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  await step(dev, t + CHARGER_START_GRACE_MS + 1);
  const gaveUp = t + CHARGER_START_GIVEUP_MS;
  await step(dev, gaveUp);
  assert.strictEqual(zeros(dev), 1);

  const after = gaveUp + CHARGER_IGNORED_BACKOFF_MS + 1;
  await step(dev, after);
  await step(dev, after + STEP_HOLD_MS + 1);   // started again
  await step(dev, after + STEP_HOLD_MS + 1 + TICK);  // first silent tick of attempt two

  assert.strictEqual(zeros(dev), 1, 'the second attempt was given up on the moment it began');
  assert.strictEqual(dev._getChargerState(CH).startRetried, false,
    'and it inherited the first attempt\'s spent retry');
});

// ── a charger that does start ───────────────────────────────────────────────────

test('a charger that draws is left entirely alone by all of this', async () => {
  const dev = makeDevice();
  await startAndGoSilent(dev);
  const before = starts(dev);

  for (const d of [1, 2, 20, 40, 60]) {
    await step(dev, T0 + d * 60_000, { powerW: 2500 });
  }

  assert.strictEqual(starts(dev), before, 'a charging car was sent another start');
  assert.strictEqual(zeros(dev), 0, 'a charging car was stopped');
});

test('a draw arriving late clears the whole silent-start state', async () => {
  // The car shook hands at 80 s — inside the grace, and the reason the grace exists.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);
  await step(dev, t + 80_000, { powerW: 2500 });

  const st = dev._getChargerState(CH);
  assert.strictEqual(st.commandedSince, null);
  assert.strictEqual(st.startRetried, false);
  assert.strictEqual(st.startBlockedUntil, null);

  await step(dev, t + CHARGER_START_GIVEUP_MS, { powerW: 2500 });
  assert.strictEqual(starts(dev), 1, 'a car that is charging got another start command');
  assert.strictEqual(zeros(dev), 0);
});

test('a draw below the live threshold is not a charging car', async () => {
  // A charger merely powered on idles well under CHARGER_LIVE_W. Reading that as "it
  // started" would put the old silence straight back.
  const dev = makeDevice();
  const t = await startAndGoSilent(dev);

  await step(dev, t + CHARGER_START_GRACE_MS + 1, { powerW: CHARGER_LIVE_W - 1 });

  assert.strictEqual(starts(dev), 2, 'an idling charger was mistaken for a charging one');
});

// ── a car that has simply finished ──────────────────────────────────────────────

test('a car that stops drawing mid-charge releases the surplus instead of holding it', async () => {
  // Not the reported failure, but the same gap seen from the other end: a finished car
  // leaves the meter at zero while the EMS still commands amps. Before this the allocation
  // stood until something else knocked it over.
  const dev = makeDevice();
  await startAndGoSilent(dev);
  await step(dev, T0 + 120_000, { powerW: 2500 });    // charging normally
  const doneAt = T0 + 180_000;
  await step(dev, doneAt);                            // car finished: draw gone

  const r = await step(dev, doneAt + CHARGER_START_GIVEUP_MS);

  assert.strictEqual(r.allocatedW, 0);
  assert.strictEqual(zeros(dev), 1, 'the charger was left commanded at full amps');
});

// ── no meter, no verdict ────────────────────────────────────────────────────────

test('a charger with no power reading at all is never judged silent', async () => {
  // Caught by the existing _stepCharger tests, which build a charger with no powerW field:
  // a charger device without a power capability reads silent on every tick for ever. An
  // earlier draft stopped it five minutes after every start and then withheld the surplus
  // for half an hour — it would have taken those chargers out of solar charging entirely.
  const dev = makeDevice();
  const noMeter = { ...charger(), powerW: undefined };
  const run = (t) => dev._stepCharger({ ...noMeter }, BUDGET, 1, t, EXPORTING, false);

  await run(T0);
  await run(T0 + STEP_HOLD_MS + 1);
  const before = starts(dev);
  for (const d of [1, 2, 5, 10, 20, 40]) await run(T0 + d * 60_000);

  assert.strictEqual(zeros(dev), 0, 'a charger with no meter was stopped for drawing nothing');
  assert.strictEqual(starts(dev), before, 'and sent a retry it could never answer');
  assert.strictEqual(dev._getChargerState(CH).startBlockedUntil, null, 'and then blocked');
});

test('a null power reading counts as no reading, not as zero', async () => {
  // Homey hands back null for a capability that exists but has never been written.
  const dev = makeDevice();
  const run = (t) => dev._stepCharger({ ...charger(), powerW: null }, BUDGET, 1, t, EXPORTING, false);

  await run(T0);
  await run(T0 + STEP_HOLD_MS + 1);
  for (const d of [1, 5, 10, 20]) await run(T0 + d * 60_000);

  assert.strictEqual(zeros(dev), 0);
});

// ── the cable ───────────────────────────────────────────────────────────────────

test('unplugging clears the back-off', async () => {
  // A different car may be perfectly willing to charge. The hold belongs to the attempt,
  // not to the socket — the same reasoning as targetReachedCar, cleared beside it.
  const fs   = require('fs');
  const path = require('path');
  const src  = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ems', 'chargerControl.js'), 'utf8');
  const from = src.indexOf('P2: No EV connected');
  assert.ok(from > 0, 'the cable-out branch moved — this test points at the wrong code');
  const block = src.slice(from, src.indexOf('const idleSocStr', from));

  assert.ok(/st\.targetReachedCar = null/.test(block), 'not the cable-out branch any more');
  assert.ok(/st\.startBlockedUntil = null/.test(block),
    'unplugging does not clear the ignored-start back-off');
});

// ── the shape of the fix ────────────────────────────────────────────────────────

test('the grace outlasts the 57 s the field log was giving up after', () => {
  assert.ok(CHARGER_START_GRACE_MS > 57_000);
  assert.ok(CHARGER_START_GIVEUP_MS > CHARGER_START_GRACE_MS,
    'giving up must come after the retry, not with it');
  assert.ok(CHARGER_IGNORED_BACKOFF_MS > 5 * 60_000,
    'a back-off no longer than FLIP_COOLDOWN_MS would not slow the loop at all');
});
