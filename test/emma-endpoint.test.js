'use strict';

// Four Homey devices, one Modbus endpoint. Run: node --test
//
// The EMMA is a gateway. The inverter, the battery, the meter and the charger behind it are
// four separate devices in Homey, but the address a person types is always the EMMA's — the
// registers come out of the EMMA's own Modbus interface, section by section of one Huawei
// document. Three of the four dialogs said so. The charger's said:
//
//     "Enter the network address of your Huawei Smart Charger."
//
// A user on the forum did exactly that, with the charger's own IP, and was turned away. He
// had followed our instructions; the instructions were wrong. Nothing in the test suite
// noticed, because nothing compared the four dialogs with each other.
//
// The unit ID had drifted the same way: three drivers defaulted to 0, the charger to 1 —
// and 1 behind an EMMA is the inverter's RS485 address, so the probe was aimed at a
// different machine. Worse than aimless: on the inverter, the charger's rated-power register
// 30076 lands between "maximum active power" and "maximum apparent power", so a read there
// returns a number rather than an error, and a number is what the check was looking for.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

// Every driver whose register block is answered by an EMMA rather than by the device itself.
const EMMA_DRIVERS = [
  'sun2000_emma_modbus',
  'luna2000_emma_modbus',
  'powermeter_emma_modbus',
  'smartcharger_emma_modbus',
];

const setting = (driverId, id) => {
  const driver = manifest.drivers.find((d) => d.id === driverId);
  assert.ok(driver, `driver ${driverId} is gone`);
  for (const group of driver.settings || []) {
    for (const child of group.children || [group]) if (child.id === id) return child;
  }
  return null;
};

test('every device behind an EMMA is addressed at the EMMA, in every language', () => {
  for (const driverId of EMMA_DRIVERS) {
    const hint = setting(driverId, 'address').hint;
    for (const [lang, text] of Object.entries(hint)) {
      assert.match(text, /EMMA/, `${driverId} / ${lang}: the address hint does not name the EMMA`);
    }
  }
});

test('no EMMA pairing dialog asks for the address of the device behind the gateway', () => {
  // The subtitle is the one sentence somebody reads before typing. It has to name the box
  // the address belongs to, and the charger's named the wrong one for four months.
  for (const driverId of EMMA_DRIVERS) {
    const page = fs.readFileSync(path.join(ROOT, 'drivers', driverId, 'pair', 'start.html'), 'utf8');
    const subtitles = [...page.matchAll(/subtitle: '([^']*(?:\\'[^']*)*)'/g)].map((m) => m[1]);
    assert.ok(subtitles.length >= 2, `${driverId}: expected a subtitle per language, found ${subtitles.length}`);
    for (const text of subtitles) {
      assert.match(text, /EMMA/, `${driverId}: a pairing subtitle does not name the EMMA — "${text}"`);
    }
  }
});

test('every EMMA driver defaults to the unit the EMMA answers on', () => {
  // 0 is the EMMA's own unit. 1 is the inverter's RS485 address behind it, which is where
  // the charger used to point — a different machine answering a register that means
  // something else there.
  for (const driverId of EMMA_DRIVERS) {
    assert.strictEqual(setting(driverId, 'modbus_id').value, 0,
      `${driverId}: the manifest default is not the EMMA's unit`);
  }
});

test('the code agrees with the manifest about that default', () => {
  // The manifest value only covers devices paired from now on. The fallback in the code is
  // what an older device falls back to when its setting is empty, so the two have to match
  // or a device behaves differently from the dialog that created it.
  for (const driverId of EMMA_DRIVERS) {
    for (const file of ['device.js', 'driver.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'drivers', driverId, file), 'utf8');
      for (const m of src.matchAll(/parseIntSafe\(\s*(?:this\.getSetting\('modbus_id'\)|modbusId)\s*,\s*(\d+)\s*\)/g)) {
        assert.strictEqual(m[1], '0',
          `${driverId}/${file}: falls back to unit ${m[1]}, but the EMMA answers on 0`);
      }
    }
  }
});

test('the drivers that talk to a device directly keep their own unit', () => {
  // The counterweight: this must not become "every driver uses 0". A SUN2000 reached
  // directly really is unit 1, and an SDongle really is 100.
  const direct = { sun2000_modbus: 1, luna2000_modbus: 1, dtsu666_modbus: 1, sdongle_a_modbus: 100 };
  for (const [driverId, expected] of Object.entries(direct)) {
    assert.strictEqual(setting(driverId, 'modbus_id').value, expected,
      `${driverId}: a direct connection does not use the EMMA's unit`);
  }
});

test('the charger rated power is called kW wherever it is shown', () => {
  // Read with decimalPower -1, so the value is kW. Four labels and one sentence in the
  // driver check said W, which turned a 22 kW charger into "2.2 W" in the one place a person
  // looks to decide whether the right device answered.
  const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  const labelled = [...api.matchAll(/\[30076, 2, 'UINT32', '([^']+)', (-?\d+)\]/g)];
  assert.ok(labelled.length >= 4, `expected 30076 in every EMMA check, found ${labelled.length}`);
  for (const [, label, power] of labelled) {
    assert.strictEqual(power, '-1', 'the gain changed — re-check the unit in the label');
    assert.match(label, /\(kW\)/, `30076 is labelled "${label}" but read as kW`);
  }
  assert.ok(!/charger rated power\) = \$\{d\.emmaChargerRatedPow\} W`/.test(api),
    'the confirmation sentence still prints kW as W');

  // And the two register files have to agree with it.
  const registers = fs.readFileSync(path.join(ROOT, 'lib', 'modbus-registers.js'), 'utf8');
  assert.match(registers, /30076,\s*2,\s*'UINT32',\s*'Rated Power \(kW\)'/, 'lib/modbus-registers.js disagrees');
});
