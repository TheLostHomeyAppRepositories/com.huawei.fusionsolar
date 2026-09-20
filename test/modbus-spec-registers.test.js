'use strict';

// The full Huawei register list, and the promises the Registers tab makes about it.
// Run: node --test
//
// lib/modbus-spec-registers.js was not typed out, it was parsed from the specification PDF,
// whose register tables are set in a column so narrow that the layout engine wrapped the
// signal names mid-word and dropped the space at every break: "[Energ / y / storag / e]Max
// / imum / charge / power". Every name in that file is a reconstruction, so the point of
// these tests is that a reconstruction which went wrong cannot reach a user looking like a
// fact.
//
// The strongest check is the last one: wherever the app polls a register the specification
// also describes, the two must agree on type and length. That compares the parse against a
// table written by hand and proven in the field, and it found the only two places where
// they disagree — both of which are the app's choice, not the parser's mistake, and both
// of which stay as they are (see KNOWN_DIVERGENCES).

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SPEC = require('../lib/modbus-spec-registers');
const REG  = require('../lib/modbus-registers');

const LISTS = {
  INVERTER_SPEC_REGISTERS: SPEC.INVERTER_SPEC_REGISTERS,
  BATTERY_SPEC_REGISTERS:  SPEC.BATTERY_SPEC_REGISTERS,
  METER_SPEC_REGISTERS:    SPEC.METER_SPEC_REGISTERS,
};
const ALL = Object.values(LISTS).flat();

// How many 16-bit words each decoder consumes off the wire.
const WORDS = { UINT16: 1, INT16: 1, UINT32: 2, INT32: 2, UINT64: 4 };

// ── the list is a list, not a sketch ────────────────────────────────────────

test('every list has rows, and they are unique and in address order', () => {
  for (const [name, rows] of Object.entries(LISTS)) {
    assert.ok(rows.length > 20, `${name}: only ${rows.length} rows`);
    const seen = new Set();
    let previous = -1;
    for (const r of rows) {
      assert.ok(!seen.has(r.address), `${name}: ${r.address} appears twice`);
      seen.add(r.address);
      assert.ok(r.address > previous, `${name}: ${r.address} is out of order`);
      previous = r.address;
    }
  }
});

test('every row carries every field the Registers tab reads off it', () => {
  for (const [name, rows] of Object.entries(LISTS)) {
    for (const r of rows) {
      const where = `${name}/${r.address}`;
      assert.strictEqual(typeof r.address, 'number', `${where}: address`);
      assert.ok(Number.isInteger(r.length) && r.length >= 1, `${where}: length ${r.length}`);
      assert.ok(typeof r.specType === 'string' && r.specType, `${where}: specType`);
      assert.ok(typeof r.label === 'string' && r.label, `${where}: label`);
      assert.strictEqual(typeof r.unit, 'string', `${where}: unit`);
      assert.ok(Number.isInteger(r.decimalPower), `${where}: decimalPower`);
      assert.ok(['RO', 'RW', 'WO'].includes(r.rw), `${where}: rw is ${JSON.stringify(r.rw)}`);
    }
  }
});

test('a gain is a power of ten and never scales a value up', () => {
  // The spec states Gain as a divisor, so the stored power of ten is zero or negative.
  // A positive one would multiply a reading by ten or more and put a plausible-looking
  // wrong number on screen.
  for (const r of ALL) {
    assert.ok(r.decimalPower <= 0 && r.decimalPower >= -6,
      `${r.address}: decimalPower ${r.decimalPower} (${r.label})`);
  }
});

// ── nothing offers a read it cannot survive ─────────────────────────────────

test('a row is only typed with a decoder lib/modbus-client.js actually has', () => {
  // Read the decoder's own cases rather than restating them: a type dropped there and left
  // here would throw "Unsupported data type" the moment somebody clicked the row.
  const src   = fs.readFileSync(path.join(__dirname, '..', 'lib', 'modbus-client.js'), 'utf8');
  const start = src.indexOf('function parseBuffer(');
  assert.notStrictEqual(start, -1, 'parseBuffer is gone');
  const body      = src.slice(start, src.indexOf('\n}', start));
  const supported = new Set([...body.matchAll(/case '(\w+)':/g)].map((m) => m[1]));
  assert.ok(supported.size >= 5, `only found ${supported.size} decoders`);

  for (const r of ALL) {
    if (r.type === null) continue;
    assert.ok(supported.has(r.type), `${r.address}: type ${r.type} has no decoder (${r.label})`);
  }
});

test('a typed row has at least as many words as its type needs', () => {
  // The specification contradicts itself on 47321 — INT32, one register word — and reading
  // it would ask readInt32BE for four bytes out of two and throw. The generator turns such
  // a row into an untyped one, which is how it stays listed without being offered.
  for (const r of ALL) {
    if (r.type === null || !WORDS[r.type]) continue;
    assert.ok(r.length >= WORDS[r.type],
      `${r.address}: ${r.type} needs ${WORDS[r.type]} words, the spec allots ${r.length} (${r.label})`);
  }
});

test('a row the spec contradicts itself about is listed but never typed', () => {
  const conflicts = ALL.filter((r) => r.conflict);
  assert.ok(conflicts.length > 0, 'the 47321 conflict has disappeared — was the parse re-run?');
  for (const r of conflicts) {
    assert.strictEqual(r.type, null, `${r.address}: marked as a conflict yet still offered for reading`);
  }
  assert.ok(conflicts.some((r) => r.address === 47321), '47321 is no longer flagged');
});

// ── the names survived the reconstruction ───────────────────────────────────

test('no name carries the wreckage of the column it was wrapped in', () => {
  for (const r of ALL) {
    const where = `${r.address} ${JSON.stringify(r.label)}`;
    assert.strictEqual(r.label, r.label.trim(), `${where}: padded`);
    assert.doesNotMatch(r.label, /\s{2}/, `${where}: double space`);
    // A word of one lowercase letter is what a cut looks like when it was read as a space:
    // "discharging period s", "Sw itch", "Featu re". Uppercase ones are real — "A phase
    // active power".
    assert.doesNotMatch(r.label, /(^|\s)[a-z](\s|$)/, `${where}: stray letter`);
    assert.doesNotMatch(r.label, /\*/, `${where}: footnote marker left in`);
  }
});

test('every bracketed prefix is closed and followed by a space', () => {
  for (const r of ALL) {
    const opens = (r.label.match(/\[/g) || []).length;
    const shuts = (r.label.match(/\]/g) || []).length;
    assert.strictEqual(opens, shuts, `${r.address}: unbalanced brackets in ${JSON.stringify(r.label)}`);
    assert.doesNotMatch(r.label, /\][A-Za-z0-9]/,
      `${r.address}: ${JSON.stringify(r.label)} lost the space after its prefix`);
  }
});

// ── it covers the devices it claims to, and no others ───────────────────────

test('each list is attached to a driver that exists', () => {
  for (const driverId of Object.keys(SPEC.DRIVER_SPEC_REGISTERS)) {
    assert.ok(fs.existsSync(path.join('drivers', driverId, 'device.js')),
      `DRIVER_SPEC_REGISTERS names ${driverId}, which is not a driver`);
  }
  assert.deepStrictEqual(
    Object.keys(SPEC.DRIVER_SPEC_REGISTERS).sort(),
    ['dtsu666_modbus', 'luna2000_modbus', 'sun2000_modbus']);
});

test('the drivers this document does not describe get no list', () => {
  // EMMA, the SDongle and the charger are specified elsewhere. Handing them the inverter's
  // list would put addresses on screen that mean something entirely different on that
  // hardware — 40000 is the system time on a SUN2000 and the ESS control mode on an EMMA.
  for (const driverId of ['sun2000_emma_modbus', 'luna2000_emma_modbus',
                          'powermeter_emma_modbus', 'smartcharger_emma_modbus',
                          'sdongle_a_modbus']) {
    assert.strictEqual(SPEC.DRIVER_SPEC_REGISTERS[driverId], undefined,
      `${driverId} was given a list from a document that does not describe it`);
  }
});

// ── and it agrees with the registers the app has been using all along ───────

// Two registers where the app deliberately reads a different sign from the one the
// document states. Neither can misread anything a device actually reports — a grid never
// runs at 327 Hz and a derating is never above 100% — and 40125 was already put to the
// owner in 1.2.226 and left as it was. They are named here so the check below still
// guards every other register instead of being weakened for all of them.
const KNOWN_DIVERGENCES = {
  32085: { app: 'INT16',  spec: 'UINT16', why: 'grid frequency, pinned by modbus-pv-strings.test.js' },
  40125: { app: 'UINT16', spec: 'INT16',  why: 'active power percentage derating, raised in 1.2.226 and not taken up' },
};

test('the known divergences are still exactly the two that were signed off', () => {
  // If one of them is ever brought into line, this test is what says so out loud rather
  // than letting the allowance quietly cover a third register later.
  for (const [address, expected] of Object.entries(KNOWN_DIVERGENCES)) {
    const spec = ALL.find((r) => r.address === Number(address));
    assert.ok(spec, `${address} is no longer in the specification list`);
    assert.strictEqual(spec.type, expected.spec, `${address}: the spec now says ${spec.type}`);
  }
});

test('where the app polls a register this spec also describes, the two agree', () => {
  const PAIRS = [
    ['inverter', SPEC.INVERTER_SPEC_REGISTERS, ['REGISTERS', 'CONTROL_REGISTERS']],
    ['battery',  SPEC.BATTERY_SPEC_REGISTERS,
      ['BATTERY_REGISTERS', 'BATTERY_MODULE_REGISTERS', 'CONTROL_REGISTERS']],
    ['meter',    SPEC.METER_SPEC_REGISTERS, ['POWER_METER_REGISTERS']],
  ];

  let compared = 0;
  for (const [section, rows, maps] of PAIRS) {
    const byAddress = new Map(rows.map((r) => [r.address, r]));
    for (const mapName of maps) {
      for (const [key, def] of Object.entries(REG[mapName])) {
        const spec = byAddress.get(def[0]);
        if (!spec) continue;                 // the app reads things this document omits
        compared++;
        const where = `${section}/${mapName}.${key} (${def[0]}, ${spec.label})`;
        const allowed = KNOWN_DIVERGENCES[def[0]];
        if (spec.type !== null && !allowed) {
          assert.strictEqual(def[2], spec.type, `${where}: type`);
        } else if (allowed) {
          assert.strictEqual(def[2], allowed.app,
            `${where}: this register is listed as a known divergence reading ${allowed.app}, `
            + `but the app now reads ${def[2]} — update or drop the entry`);
        }
        assert.strictEqual(def[1], spec.length, `${where}: word count`);
      }
    }
  }
  assert.ok(compared > 60, `only ${compared} registers overlapped — did a map get renamed?`);
});
