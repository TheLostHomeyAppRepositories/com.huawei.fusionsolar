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
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  assert.match(dev, /this\._deviceReadings = \[/, 'the readings are not stashed off _diag');
  assert.ok(!/_diag\.readings/.test(dev), 'the readings are on _diag again and will be published twice');
});
