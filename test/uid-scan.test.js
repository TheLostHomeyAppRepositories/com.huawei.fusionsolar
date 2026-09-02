'use strict';

// The Modbus tester's unit-ID scan. Run: node --test
//
// The probing itself is not new — POST /scan/modbus already walked a list of unit IDs and
// identified drivers from register values. What is new is asking it for a range instead of
// the same five, and the two constraints that shape how:
//
//   Huawei devices generally allow ONE TCP session on port 502. Probing in parallel does
//   not just fail, it leaves the device half-open and blocks the next attempt, so the
//   endpoint probes sequentially with a gap. That is why a scan is slow, and why the
//   sensible answer is a short list rather than a faster sweep.
//
//   At 4 s timeout plus a 2 s gap, one silent ID costs six seconds. The list is therefore
//   chosen for what real installations use, and sent in blocks so the page can show
//   progress and be stopped instead of waiting out one long request.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

// Read the list back out of the page rather than restating it here — a test that carries
// its own copy of the answer only proves the copy.
function scanList() {
  const m = SRC.match(/const UID_SCAN_LIST\s*=\s*(.+);/);
  assert.ok(m, 'UID_SCAN_LIST is gone — the scan was removed or renamed');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)();
}
const scanBlock = () => Number((SRC.match(/const UID_SCAN_BLOCK\s*=\s*(\d+)/) || [])[1]);

test('the scan covers the IDs real installations actually use', () => {
  const list = scanList();
  // Inverter is usually 1, EMMA 0 or 1, meters often 11 or 16, SDongle 100/101.
  for (const id of [0, 1, 11, 16, 100, 101]) {
    assert.ok(list.includes(id), `unit ID ${id} is not scanned, and it is one that occurs`);
  }
  assert.deepStrictEqual([...new Set(list)], list, 'the list probes an ID twice');
  for (const id of list) {
    assert.ok(Number.isInteger(id) && id >= 0 && id <= 247,
      `${id} is not a valid Modbus unit ID`);
  }
});

// The reason the list is short. A full 1-247 sweep is roughly 25 minutes of one device
// being held busy — not a feature anyone would use twice, and it blocks polling meanwhile.
test('the scan stays inside a length someone will actually sit through', () => {
  const list = scanList();
  // Both constants are read as a pair, because they sit together in scanModbus and there
  // is a second PROBE_TIMEOUT_MS elsewhere in the file for the single-driver check. An
  // earlier version of this anchored on a trailing comment and broke the moment the
  // comment moved — the estimate then silently became NaN.
  const m = API.match(/PROBE_TIMEOUT_MS\s*=\s*(\d+);[\s\S]{0,200}?INTER_UNIT_GAP_MS\s*=\s*(\d+)/);
  assert.ok(m, 'the probe timings moved — this estimate is meaningless');
  const timeout = Number(m[1]);
  const gap = Number(m[2]);
  // Long enough for a device that has to open a session first: the connect timeout alone
  // is 10 s. Anything shorter measures which device is fastest, not which exist.
  assert.ok(timeout >= 10_000,
    `${timeout} ms per ID is below the 10 s a fresh connection may take, so a slow but `
    + 'healthy device is cut off before it can answer');
  const worstCaseMs = list.length * timeout + (list.length - 1) * gap;
  assert.ok(worstCaseMs <= 3 * 60_000,
    `worst case is ${Math.round(worstCaseMs / 1000)} s for ${list.length} IDs; `
    + 'past about three minutes the scan stops being something a person waits for');
});

test('the scan is sent in blocks, not as one long request', () => {
  const block = scanBlock();
  assert.ok(block >= 1 && block <= 6,
    `a block of ${block} IDs is either pointless overhead or long enough to time out`);
  assert.ok(scanList().length > block,
    'the whole list fits in one block — nothing would ever be reported mid-scan');
  assert.match(SRC, /apiPost\('\/scan\/modbus', \{ host, port, unitIds: block\.join\(','\) \}\)/,
    'the block is no longer passed to the endpoint, so it would fall back to its own five');
});

// The endpoint has always accepted a list; the page just never sent one. If that parameter
// stops being read, the scan silently probes the default five over and over instead.
test('the endpoint still honours the unit-ID list it is given', () => {
  assert.match(API, /const UNIT_IDS = \(typeof unitIds === 'string' && unitIds\.length\)/,
    'POST /scan/modbus ignores its unitIds parameter — every block would probe the defaults');
});

// Serial probing is not a performance choice, it is the whole reason the scan behaves.
test('probing stays sequential with a gap between sessions', () => {
  // Asserted as "it is awaited", not as "the constant exists": a probe loop that declares
  // the gap and never waits it out looks perfectly correct in a grep and still hammers the
  // device. That is the version of this mistake that would actually get written.
  assert.match(API, /if \(i > 0\) await new Promise\(r => setTimeout\(r, INTER_UNIT_GAP_MS\)\)/,
    'the gap between TCP sessions is no longer awaited between probes');
  assert.doesNotMatch(API, /Promise\.all\([^)]*probeModbusUnit/,
    'unit IDs are probed in parallel — Huawei devices allow one session and go half-open');
});

test('stopping is offered, and the running block is allowed to finish', () => {
  assert.match(SRC, /_uidScanAbort/, 'the scan cannot be stopped once started');
  // Checked at the top of the loop, so the request already in flight completes. Cutting a
  // session short is exactly what leaves the device half-open.
  assert.match(SRC, /for \(let i = 0; i < UID_SCAN_LIST\.length; i \+= UID_SCAN_BLOCK\) \{\s*\n\s*if \(_uidScanAbort\) break;/,
    'the abort is not checked between blocks, so it either never stops or stops mid-session');
});

// Field-caught the day after this shipped: the scan reported unit IDs 16, 100 and 101 on a
// plant with one device. `responds` from POST /scan/modbus only means the TCP session
// opened — and in Modbus TCP the connection is made to the HOST, not to a unit ID, so on a
// host with port 502 open EVERY id "responds". The register values are what separate a
// device from an open socket, and the endpoint's own comment says so:
//   "Individual register exceptions ... are captured as null values in the returned
//    object — that still counts as responds: true."
test('an open socket is not reported as a device', () => {
  assert.match(SRC, /if \(!r\.responds \|\| !r\.data\) continue;/,
    'a result without register data is treated as a find again');
  assert.match(SRC, /anyConfirmed/,
    'the scan no longer looks at whether a driver was actually recognised');
  // The GUARD, not the calculation. Computing anyValue and then not acting on it reads
  // perfectly well and lets every open socket through — which is the mistake this test
  // exists for, so asserting that the variable is merely present proves nothing.
  assert.match(SRC, /const anyValue\s+= Object\.values\(r\.data\)\.some\(/,
    'nothing works out whether any register came back with content');
  assert.match(SRC, /if \(!confirmed && !anyValue\) continue;/,
    'the all-null case is computed but no longer skipped, so an open socket counts as a hit');
});

// A button invites a driver check. Offering one for an ID that answered but matched no
// driver sends the user down a path that cannot succeed — it is worth reporting, not
// worth offering.
test('only a recognised device earns a button', () => {
  const fn = SRC.slice(SRC.indexOf('async function scanUnitIds'));
  const body = fn.slice(0, fn.indexOf('\n    function addCustomUid'));
  const guard = body.indexOf('if (!confirmed) continue;');
  const chip  = body.indexOf('chips.appendChild(makeChip(');
  assert.ok(guard > 0 && chip > guard,
    'the chip is added before the confirmed check, so unidentified IDs get buttons too');
});

// The two findings mean different things and are reported as different sentences. One
// combined "found" line is exactly what made an open port look like hardware.
test('recognised and merely-answering IDs are reported separately', () => {
  assert.match(SRC, /settings\.tester\.scanUnknown/, 'the "answered but unknown" case has no message');
  for (const lang of ['en', 'de', 'nl']) {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'))
      .settings.tester;
    assert.strictEqual(typeof t.scanUnknown, 'string', `${lang}: scanUnknown is missing`);
    assert.match(t.scanUnknown, /\{\{ids\}\}/, `${lang}: scanUnknown lost its placeholder`);
  }
});

// Read Device Identification is asked only where the registers recognised nothing. A
// device this app already knows needs no introduction, and asking costs a second TCP
// session on hardware that generally permits one.
test('the device-identification probe is a fallback, not a second pass', () => {
  const scan = API.slice(API.indexOf('async scanModbus'));
  const body = scan.slice(0, scan.indexOf('\n  /**'));
  assert.match(body, /if \(!identified\.anyConfirmed\) \{\s*\n\s*deviceId = await readDeviceIdentification/,
    'the identification probe runs for every unit ID, doubling the sessions opened');
  assert.match(body, /readDeviceIdentification\(host, parseInt\(port, 10\), unitId, 3000\)/,
    'the short timeout is gone — this probe must not cost as much as a register read');
});
