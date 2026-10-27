'use strict';

// The Smart Charger behind an EMMA: its power, and whose answer it is reading (1.3.6).
// Run: node --test
//
// Three logs from one installation (f3b5238a, 2a291433, 965c9d46; 2026-10-23):
//
//   - On unit ID 0 register 30000 held a name — the EMMA's own — and 30076 and 30500–30508
//     came back with exception 3. The driver asked for nothing but the name, so pairing took
//     it and two devices reported "Poll OK: state=idle" with not one value behind them. On
//     unit ID 3 the charger answered every register.
//   - On unit 3 measure_power showed 24 230 W while the whole house, car included, used
//     9–13 kW. The estimate was the counter's rise from one poll to the next, and the counter
//     moves in steps: a 30 s poll caught none (0 W) or two (about 200 Wh, so 24 kW).
//
// Andi: "Ja, A und B bauen".

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const realClient = require(path.join('..', 'lib', 'modbus-client.js'));
const realHelper = require(path.join('..', 'lib', 'pairing-helper.js'));

let reads = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  if (request === '../../lib/modbus-client') {
    return { ...realClient, readModbusRegisters: async () => reads.shift() };
  }
  if (request === '../../lib/pairing-helper') {
    return { ...realHelper, pauseDevicesOnHost: async () => [], resumePairedDevices: async () => {} };
  }
  return origLoad.call(this, request, parent, isMain);
};
const ChargerDevice = require(path.join('..', 'drivers', 'smartcharger_emma_modbus', 'device.js'));
const ChargerDriver = require(path.join('..', 'drivers', 'smartcharger_emma_modbus', 'driver.js'));
Module._load = origLoad;

const VALUES = ['ratedPower', 'phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage', 'totalEnergyCharged', 'chargerTemperature'];

// A read result shaped as the client returns it: values, plus the two non-enumerable sets.
// An exception lands in both `unread` and `refused`, a timeout in `unread` only.
function read({ name = 'SCharger-22KT-S0', volts = [230, 231, 229], kwh = 100, unread = [], refused = [] } = {}) {
  const r = {
    offeringName: name, ratedPower: 22,
    phaseAVoltage: volts[0], phaseBVoltage: volts[1], phaseCVoltage: volts[2],
    totalEnergyCharged: kwh, chargerTemperature: 31,
  };
  for (const k of [...unread, ...refused]) r[k] = null;
  Object.defineProperty(r, 'unread',  { value: new Set([...unread, ...refused]), enumerable: false });
  Object.defineProperty(r, 'refusedByDevice', { value: new Set(refused), enumerable: false });
  return r;
}
// What the EMMA's own unit answered in log f3b5238a.
const emmaUnit = () => read({ name: 'EMMA-A02', refused: VALUES });

const i18n = (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k);

function fakeCharger(modbusId = 3) {
  const d = Object.create(ChargerDevice.prototype);
  Object.assign(d, {
    values: {}, fired: [], logs: [], errors: [], store: {}, unavailable: null,
    _failureCount: 0, _prevChargingState: null, _lastPollStart: 0,
    _sessionStartedAt: null, _sessionMeterStartKwh: null,
    _lastMeterKwh: null, _meterStep: null, _lastStepAt: null, _powerBasis: null, _powerEstW: 0,
  });
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.errors.push(a.join(' '));
  d.getName = () => 'Smart Charger (EMMA Modbus)';
  d.getSetting = (k) => ({ address: '192.168.50.4', port: 502, modbus_id: modbusId }[k]);
  d.getAvailable = () => d.unavailable === null;
  d.setAvailable = async () => { d.unavailable = null; };
  d.setUnavailable = async (m) => { d.unavailable = m; };
  d.hasCapability = () => true;
  d.getCapabilityValue = (c) => d.values[c] ?? null;
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.values[c] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = {
    __: i18n,
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async () => { d.fired.push(id); } }) },
  };
  d.poll = async (...results) => {
    for (const r of results) { reads.push(r); await d._fetchAndUpdate(); }
  };
  return d;
}

// A charge at a steady `powerW`, polled every `pollMs` with a second of jitter either way. The
// counter it is served is rounded down to `stepWh`, and — with `refreshMs` — only brought up to
// date that often, as a gateway relaying a cached value would. Which of the two this charger
// does is not known; the log fits either. Returns, per poll, the estimate the device holds and
// the one the old poll-to-poll rise would have given.
function charge({ powerW, stepWh = 1, refreshMs = 0, pollMs = 30_000, minutes = 30, offsetMs = 7_000 }) {
  const d = fakeCharger();
  const out = [];
  let t = offsetMs;
  let last = null;
  for (let i = 0; t < minutes * 60_000; i++) {
    const served = refreshMs ? Math.floor(t / refreshMs) * refreshMs : t;
    const wh  = Math.floor((powerW * served / 3_600_000) / stepWh) * stepWh;
    const kWh = (100_000 + wh) / 1000;
    d._estimatePower(kWh, t);
    const old = last ? Math.round((kWh - last.kWh) * 1000 * 3_600_000 / (t - last.t)) : null;
    out.push({ t, est: d._powerEstW, old });
    last = { kWh, t };
    t += pollMs + ((i * 7919) % 2001) - 1000;
  }
  return out;
}

// ── A: the power estimate ────────────────────────────────────────────────────

test('a counter brought up to date once a minute: per poll 0 W or 24 kW, step to step 12 kW', () => {
  const polls = charge({ powerW: 12_000, refreshMs: 60_000 });
  const old = polls.map((p) => p.old).filter((v) => v !== null);
  assert.ok(old.includes(0) && Math.max(...old) > 23_000,
    `the old estimate did not show the log's pattern: ${Math.min(...old)}–${Math.max(...old)} W`);

  const settled = polls.filter((p) => p.t > 4 * 60_000).map((p) => p.est);
  assert.ok(settled.length > 40);
  for (const w of settled) assert.ok(w >= 11_000 && w <= 13_000, `${w} W for a 12 kW charge`);
});

test('a counter in 0.1 kWh steps at 11 kW reads 11 kW, not 0 W and 13 kW by turns', () => {
  const polls = charge({ powerW: 11_000, stepWh: 100 });
  const old = polls.map((p) => p.old).filter((v) => v !== null);
  assert.ok(old.includes(0), 'the old estimate never fell to 0 W here');

  const settled = polls.filter((p) => p.t > 4 * 60_000).map((p) => p.est);
  for (const w of settled) assert.ok(w >= 8_250 && w <= 13_750, `${w} W for an 11 kW charge`);
});

test('a slow charge (1.4 kW, a step every four minutes) holds between steps rather than reading 0 W', () => {
  const polls = charge({ powerW: 1_400, stepWh: 100, minutes: 60 });
  const settled = polls.filter((p) => p.t > 15 * 60_000).map((p) => p.est);
  assert.ok(!settled.includes(0), 'the estimate fell to 0 W between two steps of a running charge');
  for (const w of settled) assert.ok(w >= 1_050 && w <= 1_750, `${w} W for a 1.4 kW charge`);
});

test('a counter that moves on every poll is read as closely as before', () => {
  const polls = charge({ powerW: 7_400, stepWh: 1 });
  const settled = polls.filter((p) => p.t > 4 * 60_000).map((p) => p.est);
  for (const w of settled) assert.ok(Math.abs(w - 7_400) <= 80, `${w} W for a 7.4 kW charge`);
  // and it takes about two and a half minutes to say anything at all
  const first = polls.find((p) => p.est > 0);
  assert.ok(first.t > 120_000 && first.t < 200_000, `first estimate at ${first.t / 1000} s`);
});

test('a counter that stops drops the estimate to 0 W after twice the span it came from', () => {
  const d = fakeCharger();
  const step = (kWh, s) => d._estimatePower(kWh, s * 1000);
  step(100.0, 0);
  step(100.1, 30);                 // first step seen: the span starts
  step(100.5, 150);                // 0.4 kWh in 120 s
  assert.strictEqual(d._powerEstW, 12_000);
  step(100.5, 300);                // 150 s without a step: still within 2 × 120 s
  assert.strictEqual(d._powerEstW, 12_000);
  step(100.5, 391);                // 241 s without a step: the car has stopped drawing
  assert.strictEqual(d._powerEstW, 0);
  step(100.6, 420);                // it draws again: a new span, not one from 150 s
  assert.strictEqual(d._powerEstW, 0);
  step(100.8, 540);
  assert.strictEqual(d._powerEstW, 6_000);
});

test('a reading that went missing changes nothing; a counter that went back starts over', () => {
  const d = fakeCharger();
  const step = (kWh, s) => d._estimatePower(kWh, s * 1000);
  step(100.0, 0); step(100.1, 30); step(100.5, 150);
  step(null, 180); step(undefined, 210);
  assert.strictEqual(d._powerEstW, 12_000);
  assert.strictEqual(d._lastMeterKwh, 100.5);
  step(3.2, 240);                  // a new charger, or a reset counter
  assert.strictEqual(d._meterStep, null);
  step(3.3, 270);                  // its first step only starts a span
  assert.deepStrictEqual(d._meterStep, { kWh: 3.3, at: 270_000 });
  assert.strictEqual(d._powerEstW, 12_000, 'the drop was taken for a reading');
});

test('an idle spell between two charges is not averaged into the next one', async () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const d = fakeCharger();
    const at = (s, r) => { now = 1_800_000_000_000 + s * 1000; return d.poll(r); };
    await at(0,   read({ kwh: 100.0 }));
    await at(30,  read({ kwh: 100.1 }));
    await at(150, read({ kwh: 100.5 }));
    assert.strictEqual(d.values.measure_power, 12_000);
    await at(180, read({ kwh: 100.5, volts: [0, 0, 0] }));        // unplugged
    assert.strictEqual(d.values.measure_power, 0);
    await at(3600, read({ kwh: 100.5, volts: [0, 0, 0] }));
    await at(3 * 3600, read({ kwh: 100.6 }));                     // plugged in hours later
    assert.strictEqual(d.values.measure_power, 0,
      'the first step of the new charge was spread over the hours in between');
    await at(3 * 3600 + 120, read({ kwh: 101.0 }));
    assert.strictEqual(d.values.measure_power, 12_000);
  } finally { Date.now = realNow; }
});

test('a charge too short for an estimate leaves no starting point behind for the next one', async () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const d = fakeCharger();
    const at = (s, r) => { now = 1_800_000_000_000 + s * 1000; return d.poll(r); };
    await at(0,  read({ kwh: 100.0 }));
    await at(30, read({ kwh: 100.1 }));                           // one step, then unplugged
    await at(60, read({ kwh: 100.1, volts: [0, 0, 0] }));
    await at(3 * 3600, read({ kwh: 100.2 }));                     // the next charge, hours later
    assert.strictEqual(d.values.measure_power, 0,
      'the next charge\'s first step was measured from the last one\'s');
  } finally { Date.now = realNow; }
});

test('the poll line says the power, what it came from and the counter', async () => {
  const d = fakeCharger();
  await d.poll(read({ kwh: 100.0 }));
  // Since 1.3.8 a counter seen once has not risen yet: not charging (emma-charger-state-138).
  assert.match(d.logs.at(-1), /^Poll OK: state=idle, P≈0 W, meter 100 kWh$/);
  d._powerEstW = 12_000;
  d._powerBasis = { kWh: 0.4000000000000057, spanMs: 120_400 };
  d._pollLogAt = undefined;
  await d.poll(read({ kwh: 100.5 }));
  assert.match(d.logs.at(-1), /^Poll OK: state=charging, P≈12000 W \(0\.4 kWh in 120 s\), meter 100\.5 kWh$/);
});

// ── B: the EMMA answering on the charger's unit ──────────────────────────────

test('a name with every charger register refused is the EMMA: unavailable at the third poll, nothing published', async () => {
  const d = fakeCharger(0);
  await d.poll(emmaUnit(), emmaUnit());
  assert.strictEqual(d.unavailable, null, 'one or two odd answers took the device down');
  await d.poll(emmaUnit());
  assert.strictEqual(d.unavailable, 'modbus.errors.chargerIsEmma {"id":0,"name":"EMMA-A02"}');
  assert.deepStrictEqual(d.values, {}, 'the EMMA\'s answer was published as the charger\'s');
  assert.ok(!d.logs.some((l) => /Poll OK/.test(l)), 'it still said "Poll OK"');
  assert.match(d.errors[0], /^Not the charger \(1\): unit 0 answers as "EMMA-A02" and refuses the rated power \(30076\) every charger has$/);
  // and the charger answering again is taken at once
  await d.poll(read());
  assert.strictEqual(d.unavailable, null);
  assert.strictEqual(d.values.smartcharger_offering_name, 'SCharger-22KT-S0');
});

test('registers that were only not read are not taken for the EMMA', async () => {
  const d = fakeCharger(0);
  for (let i = 0; i < 4; i++) await d.poll(read({ unread: VALUES }));   // cut short, timed out
  assert.strictEqual(d.unavailable, null);
  assert.ok(!d.errors.some((l) => /Not the charger/.test(l)));
});

// Log 2aafa4d3 (Thomas_Scherzinger, 1.3.6): this EMMA calls itself "SmartHEMS" and answers
// 30500–30505 on its own unit — its smart meter's status and voltages at gain 100, so the
// charger's phases B and C read some 2300 V — while the rated power, the energy and the
// temperature are refused. "Every charger register refused" let it through, and the device
// showed "charging" with no car.
const smartHems = () => read({ name: 'SmartHEMS', volts: [0, 2305.1, 2298.7],
  refused: ['ratedPower', 'totalEnergyCharged', 'chargerTemperature'] });

test('an EMMA that answers the voltages but not the rated power is still not the charger', async () => {
  const d = fakeCharger(0);
  await d.poll(smartHems(), smartHems(), smartHems());
  assert.strictEqual(d.unavailable, 'modbus.errors.chargerIsEmma {"id":0,"name":"SmartHEMS"}');
  assert.deepStrictEqual(d.values, {}, 'the EMMA\'s meter was published as the charger');
  assert.ok(!d.fired.includes('smartcharger_charging_started'), 'it started a charge');
});

test('a voltage above 800 V is not the charger\'s: not shown, not a voltage that says "no", said once', async () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const d = fakeCharger(3);
    const at = (s, r) => { now = 1_800_000_000_000 + s * 1000; return d.poll(r); };
    await at(0,  read({ kwh: 100.0 }));
    await at(30, read({ kwh: 100.1 }));                                  // charging
    await at(60, read({ volts: [2305.1, 231, 229], kwh: 100.2 }));       // one phase out of range
    assert.strictEqual(d.values['measure_voltage.phase1'], 230, 'the 2305 V was shown');
    assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
    // Since 1.3.8 the counter decides (emma-charger-state-138): three phases out of range say
    // nothing either way, and the charge stands while the counter rises.
    await at(90,  read({ volts: [2305.1, 2298.7, 2301], kwh: 100.3 }));
    await at(120, read({ volts: [2305.1, 2298.7, 2301], kwh: 100.4 }));
    assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
    assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
    assert.strictEqual(d.logs.filter((l) => /above 800 V/.test(l)).length, 1, d.logs.join(' | '));
    assert.match(d.logs.find((l) => /above 800 V/.test(l)), /phaseAVoltage=2305\.1/);
    assert.strictEqual(d.values['measure_voltage.phase2'], 231);
  } finally { Date.now = realNow; }
});

test('a charger that refuses only some of its registers is still the charger', async () => {
  const d = fakeCharger(3);
  for (let i = 0; i < 4; i++) await d.poll(read({ refused: ['totalEnergyCharged', 'chargerTemperature'] }));
  assert.strictEqual(d.unavailable, null);
  assert.strictEqual(d.values.smartcharger_offering_name, 'SCharger-22KT-S0');
  // Without its energy counter nothing says it charges (emma-charger-state-138).
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.ok(d.logs.some((l) => /Energy counter not read for 4 polls/.test(l)));
});

test('pairing turns the EMMA\'s unit away with the reason, and takes the charger\'s', async () => {
  const drv = Object.create(ChargerDriver.prototype);
  drv.homey = { __: i18n };
  drv.log = () => {};
  const handlers = {};
  await drv.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });
  const ask = (modbusId) => handlers.connect({ address: '192.168.50.4', port: 502, modbusId, name: 'Smart Charger' });

  reads.push(emmaUnit());
  await assert.rejects(ask(0), (err) => err.message === 'modbus.errors.chargerIsEmma {"id":0,"name":"EMMA-A02"}');

  reads.push(read({ unread: VALUES }));                // a probe that timed out says nothing
  assert.strictEqual((await ask(0)).success, true);

  // unit 1 in the same log refused the name as well, with exception 4
  reads.push(read({ name: null, refused: [...VALUES, 'offeringName'] }));
  await assert.rejects(ask(1), (err) => err.message === 'modbus.errors.chargerNotDetected');

  // the EMMA that answers its meter's voltages (log 2aafa4d3)
  reads.push(smartHems());
  await assert.rejects(ask(0), (err) => err.message === 'modbus.errors.chargerIsEmma {"id":0,"name":"SmartHEMS"}');

  // a charger that refuses some of its registers is still a charger
  reads.push(read({ refused: ['totalEnergyCharged', 'chargerTemperature'] }));
  assert.strictEqual((await ask(3)).success, true);

  reads.push(read());
  const ok = await ask(3);
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.offeringName, 'SCharger-22KT-S0');
});

test('the message is there in all three languages, with the unit and the name', () => {
  for (const lang of ['en', 'de', 'nl']) {
    const text = require(path.join('..', 'locales', `${lang}.json`)).modbus.errors.chargerIsEmma;
    assert.ok(text && text.includes('{{id}}') && text.includes('{{name}}'), lang);
    assert.match(text, /Tester/, `${lang}: does not say where to find the right unit`);
    assert.doesNotMatch(text, /Home Assistant/i, lang);
  }
});
