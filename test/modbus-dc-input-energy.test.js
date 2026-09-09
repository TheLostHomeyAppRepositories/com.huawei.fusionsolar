'use strict';

// Register 32108 on the SUN2000, read but not yet published. Run: node --test
//
// Why it is here: Homey Energy files this driver's solar generation from meter_power, which
// holds register 32106 — the energy the inverter DELIVERED on the AC side. On a hybrid that
// is a different quantity from what the panels generated. Measured on 2026-09-08 against the
// same plant read through the cloud: 13.29 kWh of AC yield against 6.53 kWh of generation,
// the difference being battery discharge counted a second time.
//
// wlcrs/huawei-solar-lib declares 32108 as a lifetime kWh counter for the DC side, which
// would be the generation figure. Its register name says "power" and its unit says kWh, so
// this version only puts it in the table — where the Modbus settings tab lists it and can
// read it from real hardware — and hangs nothing on it. The last test in this file is what
// says so out loud.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { REGISTERS } = require('../lib/modbus-registers.js');
const { readRegisters, buildReadPlan } = require('../lib/modbus-client.js');

test('32108 is declared as a lifetime kWh counter, exactly like the AC one beside it', () => {
  const dc = REGISTERS.totalDcInputEnergy;
  assert.ok(dc, '32108 is not in the register table');
  assert.deepStrictEqual(dc.slice(0, 3), [32108, 2, 'UINT32']);
  assert.strictEqual(dc[4], -2, 'gain 100 means decimalPower -2');

  // Same shape as 32106. A lifetime counter that decodes differently from its neighbour
  // would be wrong in a way no single reading would reveal.
  const ac = REGISTERS.accumulatedYieldEnergy;
  assert.deepStrictEqual([dc[1], dc[2], dc[4]], [ac[1], ac[2], ac[4]]);
});

test('32108 is the address that follows the AC counter, with nothing in between', () => {
  const [addr, words] = REGISTERS.accumulatedYieldEnergy;
  assert.strictEqual(addr + words, REGISTERS.totalDcInputEnergy[0]);
});

// The claim that carrying it is free. 32106 spans 32106-32107, so 32108 lands inside a
// request the driver already makes — and if a later edit moves either register far enough
// apart to need a second one, this is what notices.
test('reading it adds no request to the poll', () => {
  const without = { ...REGISTERS };
  delete without.totalDcInputEnergy;
  assert.strictEqual(buildReadPlan(REGISTERS).length, buildReadPlan(without).length);

  const group = buildReadPlan(REGISTERS)
    .find((g) => g.some((r) => r.name === 'totalDcInputEnergy'));
  assert.ok(group.some((r) => r.name === 'accumulatedYieldEnergy'),
    'it no longer travels with the counter it sits next to');
});

// Answers readHoldingRegisters from a synthetic memory image, so the assertion is on the
// decoded reading rather than on the table that produced it.
function fakeClient(memory) {
  return {
    async readHoldingRegisters(start, count) {
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.writeUInt16BE((memory[start + i] ?? 0) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  };
}

test('a raw reading comes back as kWh with two decimals', async () => {
  // 4 752 434 raw = 47 524.34 kWh, the order of magnitude this plant actually reports.
  const memory = { 32108: 4752434 >>> 16, 32109: 4752434 & 0xFFFF };
  const data = await readRegisters(
    { totalDcInputEnergy: REGISTERS.totalDcInputEnergy }, fakeClient(memory));
  assert.strictEqual(data.totalDcInputEnergy, 47524.34);
});

test('it carries a label, because that label is what the settings tab shows', () => {
  const label = REGISTERS.totalDcInputEnergy[3];
  assert.ok(typeof label === 'string' && label.length > 0);
  assert.match(label, /kWh/, 'the unit belongs in the label — the register list shows no other');
});

// ── the scope of this version ────────────────────────────────────────────────

// Deliberately pinning what was NOT done. Pointing Homey Energy at a different counter
// changes the solar figure on every existing install at the moment of the update, which is
// a decision to take on a measurement rather than on a reading of somebody else's library.
// When that measurement is in and the capability lands, this test is the thing that should
// fail first — update it then, on purpose.
test('nothing is published from it yet, and Homey Energy still reads the AC counter', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const driver = app.drivers.find((d) => d.id === 'sun2000_modbus');

  assert.strictEqual(driver.energy.meterPowerExportedCapability, 'meter_power');
  assert.ok(!driver.capabilities.includes('meter_power.pv_total'),
    'the capability landed without this test being reconsidered');

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'sun2000_modbus', 'device.js'), 'utf8');
  assert.ok(!src.includes('totalDcInputEnergy'),
    'the driver publishes it — decide what it means before it reaches Energy');
});
