'use strict';

// The yield block at 32106-32119 on the SUN2000, read but not published. Run: node --test
//
// The file is named after 32108 because that register is why the block was opened up; it now
// covers all seven addresses in it.
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

// ── the rest of the block ────────────────────────────────────────────────

const BLOCK = [
  ['accumulatedYieldEnergy', 32106, -2],
  ['totalDcInputEnergy',     32108, -2],
  ['generationStatsTime',    32110,  0],
  ['hourlyYieldEnergy',      32112, -2],
  ['dailyYieldEnergy',       32114, -2],
  ['monthlyYieldEnergy',     32116, -2],
  ['yearlyYieldEnergy',      32118, -2],
];

test('every address in the block is declared where wlcrs puts it', () => {
  for (const [name, address, decimalPower] of BLOCK) {
    const def = REGISTERS[name];
    assert.ok(def, `${name} is missing from the register table`);
    assert.strictEqual(def[0], address, `${name} address`);
    assert.strictEqual(def[1], 2, `${name} is a two-word register`);
    assert.strictEqual(def[2], 'UINT32', `${name} type`);
    assert.strictEqual(def[4], decimalPower, `${name} scale`);
  }
});

test('the block is contiguous, so no address is silently skipped', () => {
  const sorted = [...BLOCK].sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < sorted.length; i++) {
    assert.strictEqual(sorted[i][1], sorted[i - 1][1] + 2,
      `gap or overlap between ${sorted[i - 1][0]} and ${sorted[i][0]}`);
  }
});

// A timestamp divided by a hundred is not an earlier date, it is nonsense. The rest of the
// block is kWh with gain 100, so this one is the odd entry that a bulk edit would break.
test('the statistics timestamp is not scaled like the energy counters around it', () => {
  assert.strictEqual(REGISTERS.generationStatsTime[4], 0);
});

test('the whole block still travels in one request', () => {
  const without = { ...REGISTERS };
  for (const [name] of BLOCK) delete without[name];
  const withoutExtras = { ...REGISTERS };
  for (const [name] of BLOCK.slice(2)) delete withoutExtras[name];

  assert.strictEqual(buildReadPlan(REGISTERS).length, buildReadPlan(withoutExtras).length,
    'reading the rest of the block added a request');

  const groups = buildReadPlan(REGISTERS)
    .filter((g) => g.some((r) => BLOCK.some(([name]) => r.name === name)));
  assert.strictEqual(groups.length, 1, 'the block was split across requests');
  assert.strictEqual(groups[0].filter((r) => BLOCK.some(([n]) => n === r.name)).length,
    BLOCK.length);
});

test('the yearly counter decodes as kWh with two decimals', async () => {
  const raw = 526000; // 5 260.00 kWh
  const data = await readRegisters(
    { yearlyYieldEnergy: REGISTERS.yearlyYieldEnergy },
    fakeClient({ 32118: raw >>> 16, 32119: raw & 0xFFFF }));
  assert.strictEqual(data.yearlyYieldEnergy, 5260);
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
  for (const [name] of BLOCK) {
    if (name === 'accumulatedYieldEnergy' || name === 'dailyYieldEnergy') continue; // long published
    assert.ok(!src.includes(name),
      `the driver publishes ${name} — decide what it means before it reaches Energy`);
  }
});
