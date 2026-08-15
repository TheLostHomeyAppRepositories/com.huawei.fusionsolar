'use strict';

// The Logs tab colours each line by where it came from. Run: node --test
//
// The function lives inside settings/index.html, so it is lifted out and executed here
// rather than reimplemented — a copy in the test would pass while the page was broken.
//
// The escaping assertion is the load-bearing one: a log line is arbitrary text from
// devices, from the network and from other apps' error messages, and it is written into
// the page with innerHTML. Colouring runs over the ALREADY-ESCAPED string precisely so it
// cannot reintroduce markup, and that has to stay true.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const vm     = require('vm');

const html = fs.readFileSync('settings/index.html', 'utf8');

const colourise = (() => {
  const start = html.indexOf('var LOG_TS_RE =');
  assert.ok(start > 0, 'the log colouring block is missing from settings/index.html');
  const fnAt = html.indexOf('function logsColourise', start);
  let depth = 0;
  const open = html.indexOf('{', fnAt);
  let end = open;
  for (let k = open; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}' && --depth === 0) { end = k; break; }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${html.slice(start, end + 1)}\nglobalThis.f = logsColourise;`, sandbox);
  return sandbox.f;
})();

// Same escaping the renderer applies before calling colourise.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const strip = (s) => s.replace(/<span style="color:#[0-9a-f]{6}">/g, '').replace(/<\/span>/g, '');
const count = (s, hex) => (s.match(new RegExp('color:' + hex + '"', 'g')) || []).length;

const EMS = '#5fd0a4', DRIVER = '#d9a55f', TRANSPORT = '#6fa8f5', APP = '#b98ae8', HOMEY = '#6b7280';

test('the EMS, the driver and the transport each get their own colour', () => {
  // Verbatim from the 2026-08-14 field log.
  const line = '2026-08-15T07:40:08.039Z [log] [ManagerDrivers] [Driver:energy_management] [Device:9b88b575] [EMS] tick interval 20s';
  const out = colourise(esc(line));
  assert.strictEqual(count(out, EMS), 1);
  assert.strictEqual(count(out, DRIVER), 2, '[Driver:…] and [Device:…] belong together');
  assert.strictEqual(count(out, HOMEY), 1, '[ManagerDrivers] is Homey plumbing, not our driver');
});

test('modbus and OCPP share the transport colour', () => {
  assert.strictEqual(count(colourise(esc('2026-08-15T07:40:08.682Z [modbus] read plan from 30000')), TRANSPORT), 1);
  assert.strictEqual(count(colourise(esc('2026-08-15T07:40:08.682Z [log] [OCPP] Server error')), TRANSPORT), 1);
});

test('the app object gets its own colour, distinct from its drivers', () => {
  const out = colourise(esc('2026-08-15T07:40:06.780Z [log] [FusionSolarKioskApp] FusionSolar app is running...'));
  assert.strictEqual(count(out, APP), 1);
  assert.strictEqual(count(out, DRIVER), 0);
});

test('colouring never alters the text itself', () => {
  for (const line of [
    '2026-08-15T07:40:08.682Z [modbus] read plan from 30000: 22 registers in 6 request(s)',
    '2026-08-15T00:05:04.554Z [modbus] batch 32106/10 (2 registers) failed: request fc and response fc does not match.',
    '[EMS] a line with no timestamp at all',
  ]) {
    assert.strictEqual(strip(colourise(esc(line))), esc(line));
  }
});

test('brackets inside a message are not mistaken for an origin marker', () => {
  const line = '2026-08-15T00:29:14.173Z [log] [Driver:sun2000_modbus] Write failed [sun2000_startup]: nope';
  const out = colourise(esc(line));
  assert.strictEqual(count(out, DRIVER), 1, 'only the real driver tag');
  assert.ok(out.includes('[sun2000_startup]'), 'the message bracket stays plain');
});

test('hostile log content cannot become markup', () => {
  // Device names, network errors and other apps' messages all end up in this buffer.
  const line = '2026-08-15T00:00:00.000Z [modbus] <img src=x onerror=alert(1)> & "quoted" [Driver:evil]';
  const out = colourise(esc(line));
  assert.ok(!out.includes('<img'), 'an escaped tag must stay escaped');
  assert.ok(out.includes('&lt;img'), 'and survive as readable text');
  assert.ok(out.includes('&amp;'), 'the ampersand stays escaped');
  // Only the spans this function adds may be real markup.
  assert.strictEqual(strip(out).indexOf('<'), -1, 'no bare < outside the added spans');
});

test('a line with no timestamp still gets its origin colour', () => {
  assert.strictEqual(count(colourise(esc('[EMS] something happened')), EMS), 1);
});

test('the legend lists every colour the renderer can produce', () => {
  // A colour with no entry in the legend is a colour nobody can interpret.
  const legend = html.slice(html.indexOf('Legend for the colours below'), html.indexOf('id="logs-output"'));
  for (const [name, hex] of Object.entries({ EMS, DRIVER, TRANSPORT, APP, HOMEY })) {
    assert.ok(legend.includes(hex), `${name} (${hex}) is used but not in the legend`);
  }
  assert.ok(legend.includes('#ff6b64'), 'the error colour belongs in the legend too');
});
