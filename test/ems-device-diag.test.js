'use strict';

// _deviceDiag puts what the EMS measured beside what it believes, per device it steers.
//
// The two columns are the whole point. Every fault found in the field this month lived in
// the gap between them rather than inside either one: a charger drawing 8 kW with
// currentAmps null, a session still open days after the last charge, a heat pump the EMS
// believed running while its own controller had refused. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const deviceDiag   = require('../lib/ems/deviceDiag');
const simpleMixin  = require('../lib/ems/simpleDevices');

const NOW = 1_770_000_000_000;

function makeDevice(extra = {}) {
  const d = {
    log() {},
    _chargerStates: new Map(),
    _heatPumpStates: new Map(), _boilerStates: new Map(), _poolStates: new Map(),
    _dehumidifierStates: new Map(), _airconStates: new Map(),
    _carStates: [],
    _diag: {}, _deviceReadings: [],
  };
  Object.assign(d, simpleMixin, deviceDiag, extra);
  return d;
}

test('a charger reports the commanded current beside the measured draw', () => {
  const d = makeDevice();
  d._chargerStates.set('c1', {
    currentAmps: 12, currentPhases: 1, pendingStepAmps: null, pendingStepSince: null,
    lastDownStepAt: NOW - 90_000, lastPhaseSwitchAt: null, targetReachedCar: null,
    uncommandedTicks: 0, sessionActive: true, sessionEnergyKwh: 6.764, sessionStartedAt: NOW - 3600_000,
  });
  d._deviceReadings = [{ id: 'c1', kind: 'charger', measured: { powerW: 2760, connected: true, chargeMode: 'solar' } }];

  const row = d._deviceDiag(NOW).find((r) => r.id === 'c1');
  assert.strictEqual(row.measured.powerW, 2760);
  assert.strictEqual(row.ems.amps, 12);
  assert.strictEqual(row.ems.phases, 1);
  assert.strictEqual(row.ems.sessionKwh, 6.76);
  assert.strictEqual(row.ems.sessionForS, 3600);
  assert.strictEqual(row.ems.lastDownStepS, 90);
});

test('the gap the EMS cannot see on its own is visible in one row', () => {
  // The July fault: a car charging that the EMS never commanded. One column shows 8 kW,
  // the other shows nothing commanded — and that pairing is the whole diagnosis.
  const d = makeDevice();
  d._chargerStates.set('c1', { currentAmps: null, currentPhases: null, uncommandedTicks: 3 });
  d._deviceReadings = [{ id: 'c1', kind: 'charger', measured: { powerW: 8280, connected: true } }];

  const row = d._deviceDiag(NOW)[0];
  assert.strictEqual(row.measured.powerW, 8280);
  assert.strictEqual(row.ems.amps, null, 'the EMS commanded nothing');
  assert.strictEqual(row.ems.uncommandedTicks, 3);
});

test('simple devices report their timers as ages, not as epochs', () => {
  // A report is read hours later and often in another timezone; 1770000000000 says nothing
  // to a reader, "running for 900 s" says what the min-run window is doing.
  const d = makeDevice();
  d._heatPumpStates.set('hp1', {
    isOn: true, startedAt: NOW - 900_000, surplusOkSince: NOW - 1200_000,
    surplusBadSince: null, lastEmsStopAt: null, powerDropStoppedAt: null, externalOn: false,
  });
  d._deviceReadings = [{ id: 'hp1', kind: 'simple', name: 'Luxtronik',
    measured: { powerW: 0, actualOn: false, stateSource: 'power', minSurplusW: 3000 } }];

  const row = d._deviceDiag(NOW).find((r) => r.id === 'hp1');
  assert.strictEqual(row.kind, 'heat_pump');
  assert.strictEqual(row.name, 'Luxtronik');
  assert.strictEqual(row.ems.isOn, true);
  assert.strictEqual(row.ems.runningForS, 900);
  assert.strictEqual(row.measured.actualOn, false, 'believed on, measured off — the adoption case');
});

test('cars carry their charge level and target', () => {
  // "Why did it stop charging" is answered by soc vs target more often than by anything
  // else in the export.
  const d = makeDevice({ _carStates: [{ id: 'car1', name: 'Audi - Q4', soc: 100, target: 100 }] });
  const row = d._deviceDiag(NOW).find((r) => r.kind === 'car');
  assert.strictEqual(row.measured.soc, 100);
  assert.strictEqual(row.measured.target, 100);
  assert.strictEqual(row.ems, null, 'the EMS commands nothing on a car');
});

test('a device with no reading this tick still reports what the EMS believes', () => {
  // The readings come from the last completed tick; a device added since, or a tick that
  // failed early, must not blank the row out entirely.
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true, startedAt: NOW - 60_000 });
  const row = d._deviceDiag(NOW).find((r) => r.id === 'p1');
  assert.strictEqual(row.measured, null);
  assert.strictEqual(row.ems.isOn, true);
});

test('only steered devices appear — meters and inverters do not', () => {
  // Their values are the summed figures already in the diagnostics; a row each would pad
  // the export without adding anything.
  const d = makeDevice();
  d._deviceReadings = [{ id: 'meter1', kind: 'meter', measured: { powerW: 29 } }];
  assert.deepStrictEqual(d._deviceDiag(NOW), []);
});

test('an empty EMS produces an empty list, not a crash', () => {
  const d = makeDevice();
  d._chargerStates = null;
  d._carStates = null;
  assert.deepStrictEqual(d._deviceDiag(NOW), []);
});

test('the raw readings do not travel in the diagnostics beside the assembled rows', () => {
  // getEmsDiag spreads this._diag wholesale. Parking the tick's readings there published
  // them twice in one export — once raw, once as the `devices` rows built from them — and
  // the raw copy is the shape nobody reads.
  //
  // Source-read on purpose: getEmsDiag is on the device class and needs a config, the app
  // manifest, four summaries and two capabilities to call, so where the readings are PUT
  // is the only thing reachable from here. Matched loosely — the assignment used to be an
  // array literal and is now a call to _buildDeviceReadings, and neither spelling is what
  // this test is about.
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  assert.match(dev, /this\._deviceReadings\s*=/, 'the readings have no field of their own');
  assert.ok(!/_diag\.\w*[Rr]eadings/.test(dev),
    'the readings are on _diag again and will be published twice');
});

// ── a device the EMS no longer steers ───────────────────────────────────────
//
// From the configuration export of 2026-09-12: a pool with `enabled: false`, no start card
// and no stop card, reported as `isOn: true, runningForS: 44604` — twelve and a half hours,
// counted from the moment the state entry was seeded at the last app start and never
// touched again. _evaluateSimpleDevices creates the entry and only then skips the device.
//
// The two columns are only worth putting side by side while each one says what it claims
// to. A belief nobody maintains is not a belief; it is the shape of one.

const DISABLED = { isOn: true, startedAt: NOW - 44_604_000, lastEmsStopAt: NOW - 108_855_000 };

function readingFor(id, { emsControlled, actualOn }) {
  return { id, kind: 'simple', name: 'Hydrojet Pool', emsControlled,
    measured: { powerW: 1260, actualOn, stateSource: 'power', minSurplusW: 2000 } };
}

test('a device outside EMS control reports what it is doing, not what the EMS last believed', () => {
  const d = makeDevice();
  d._poolStates.set('p1', DISABLED);
  d._deviceReadings = [readingFor('p1', { emsControlled: false, actualOn: false })];

  const row = d._deviceDiag(NOW).find((r) => r.id === 'p1');
  assert.strictEqual(row.ems.emsControlled, false, 'the export does not say the EMS is out of it');
  assert.strictEqual(row.ems.isOn, false, 'a frozen belief was reported as the current one');
  assert.strictEqual(row.ems.runningForS, null, 'the EMS timed a run it is not running');
});

test('the frozen belief is wrong in both directions', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: false, startedAt: null });
  d._deviceReadings = [readingFor('p1', { emsControlled: false, actualOn: true })];

  assert.strictEqual(d._deviceDiag(NOW).find((r) => r.id === 'p1').ems.isOn, true);
});

test('an unreadable state is reported as unknown, not as the frozen value', () => {
  const d = makeDevice();
  d._poolStates.set('p1', DISABLED);
  d._deviceReadings = [readingFor('p1', { emsControlled: false, actualOn: null })];

  assert.strictEqual(d._deviceDiag(NOW).find((r) => r.id === 'p1').ems.isOn, null);
});

// What the EMS did while it still steered the device stays true and stays reported — it is
// a past event, not a claim about now, and it is often the answer to "why is it off".
test('what the EMS did before it let go is still reported', () => {
  const d = makeDevice();
  d._poolStates.set('p1', DISABLED);
  d._deviceReadings = [readingFor('p1', { emsControlled: false, actualOn: false })];

  assert.strictEqual(d._deviceDiag(NOW).find((r) => r.id === 'p1').ems.sinceEmsStopS, 108_855);
});

// The counter-case, and the reason the belief column exists at all: for a device the EMS
// steers, the two disagreeing is the diagnosis (adoption), not a fault in the report.
test('for a steered device the belief is still the belief', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true, startedAt: NOW - 900_000 });
  d._deviceReadings = [readingFor('p1', { emsControlled: true, actualOn: false })];

  const row = d._deviceDiag(NOW).find((r) => r.id === 'p1');
  assert.strictEqual(row.ems.emsControlled, true);
  assert.strictEqual(row.ems.isOn, true, 'believed on, measured off — the adoption case');
  assert.strictEqual(row.ems.runningForS, 900);
});

// The readings come from the last completed tick. A device added since has none, and the
// row must still report the belief rather than blanking it as "not steered".
test('no reading this tick is not the same as not steered', () => {
  const d = makeDevice();
  d._poolStates.set('p1', { isOn: true, startedAt: NOW - 60_000 });

  const row = d._deviceDiag(NOW).find((r) => r.id === 'p1');
  assert.strictEqual(row.ems.emsControlled, true);
  assert.strictEqual(row.ems.isOn, true);
  assert.strictEqual(row.ems.runningForS, 60);
});

// ── the readings the rows are built from ────────────────────────────────────
//
// Assembled in _tickBody this was the one part of the export nothing could drive: the
// measured column of every row, and the flag that decides which belief to trust.

test('a charger reading carries the raw draw, not the smoothed one', () => {
  // rawPowerW is what the meter said this tick. powerW elsewhere is damped for the control
  // loop, and a report that showed the damped figure would hide exactly the spikes it is
  // read to find.
  const d = makeDevice();
  const rows = d._buildDeviceReadings(
    [{ id: 'c1', rawPowerW: 2760, powerW: 2400, connected: true, chargeMode: 'solar' }], []);

  assert.strictEqual(rows[0].kind, 'charger');
  assert.strictEqual(rows[0].measured.powerW, 2760);
  assert.strictEqual(rows[0].measured.chargeMode, 'solar');
});

test('a charger with no reading says so rather than saying zero', () => {
  const d = makeDevice();
  const rows = d._buildDeviceReadings([{ id: 'c1', connected: false }], []);
  assert.strictEqual(rows[0].measured.powerW, null, '0 W would read as "measured, drawing nothing"');
});

test('a simple device carries whether the EMS steers it', () => {
  const d = makeDevice();
  const rows = d._buildDeviceReadings([], [
    { id: 'p1', name: 'Hydrojet Pool', enabled: false, powerW: 1260, actualOn: true,
      stateSource: 'power', minSurplusW: 2000 },
    { id: 'b1', name: 'Heizstab Boiler', enabled: true, powerW: 0, actualOn: false,
      stateSource: 'onoff', minSurplusW: 5000 },
  ]);

  assert.strictEqual(rows[0].emsControlled, false);
  assert.strictEqual(rows[1].emsControlled, true);
});

// The per-device toggle arrived after these configs existed; one saved before it has no
// `enabled` field and has always been under EMS control.
test('a config from before the toggle reads as steered', () => {
  const d = makeDevice();
  const rows = d._buildDeviceReadings([], [{ id: 'p1', name: 'Pool', powerW: 100 }]);
  assert.strictEqual(rows[0].emsControlled, true);
});

test('a device with no power reading says unknown, not zero', () => {
  const d = makeDevice();
  const rows = d._buildDeviceReadings([], [
    { id: 'dh1', name: 'Entfeuchter', enabled: true, actualOn: false, stateSource: 'onoff' },
  ]);
  assert.strictEqual(rows[0].measured.powerW, null);
});

// The whole round trip: what one tick read, through the row a reader actually sees.
test('the readings feed the rows that report them', () => {
  const d = makeDevice();
  d._poolStates.set('p1', DISABLED);
  d._deviceReadings = d._buildDeviceReadings([], [
    { id: 'p1', name: 'Hydrojet Pool', enabled: false, powerW: 1260, actualOn: false,
      stateSource: 'power', minSurplusW: 2000 },
  ]);

  const row = d._deviceDiag(NOW).find((r) => r.id === 'p1');
  assert.strictEqual(row.measured.powerW, 1260, 'still drawing, by its own plug');
  assert.strictEqual(row.ems.emsControlled, false);
  assert.strictEqual(row.ems.isOn, false, 'and the belief column no longer claims otherwise');
});
