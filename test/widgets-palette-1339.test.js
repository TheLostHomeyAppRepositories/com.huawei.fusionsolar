'use strict';

// Widget review of 2026-10-11, packages C and D (1.2.339):
//
//   C. One palette for all widgets. A quantity has one colour on the whole dashboard:
//      - PV amber, house blue, import red, export green, battery violet;
//      - good, warning and fault in Homey's own semantic colours;
//      - figures in the text colour.
//      Before, PV was amber, green or orange depending on the widget, the battery green and
//      orange, and amber figures reached 2.2:1 on white.
//   D. The EMS history marks each event with an icon and a tone instead of 22 dot colours
//      without a legend. Its buttons are 44 px with icons, an error stays on screen while
//      you page through the days, and the height follows the list.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const W = path.join(__dirname, '..', 'widgets');
const html = (w) => fs.readFileSync(path.join(W, w, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const widgets = fs.readdirSync(W).filter((w) => fs.existsSync(path.join(W, w, 'public', 'index.html')));

const PAL_START = '/* One palette for every widget';
function paletteOf(src) {
  const a = src.indexOf(PAL_START);
  if (a < 0) return null;
  const b = src.indexOf('}', src.indexOf(':root {', a)) + 1;
  return src.slice(a, b).split('\n').map((l) => l.trim()).join('\n');
}

function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} is not in the page`);
  let depth = 0, inStr = null;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

// ── C: one palette ──────────────────────────────────────────────────────────────────────

test('every widget that uses the energy colours carries the same palette block', () => {
  const users = widgets.filter((w) => /var\(--energy-/.test(html(w)));
  assert.ok(users.length >= 9, `only ${users.length} widgets use the palette`);
  const first = paletteOf(html(users[0]));
  assert.match(first, /--energy-pv: #F59E0B;\n--energy-battery: #8B5CF6;\n--energy-house: var\(--homey-color-blue\);\n--energy-import: var\(--homey-color-red\);\n--energy-export: var\(--homey-color-green\);/);
  for (const w of users) assert.strictEqual(paletteOf(html(w)), first, `${w}: the palette differs`);
});

test('no widget brings a colour of its own outside the palette', () => {
  // The three that stay: the dark plate behind the charger photo, the white knob of a
  // switch, and the cheap-to-dear scale of the price chart, which is not a quantity.
  const allowed = { 'charger-status': ['#2a2a2e'], 'ems-device': ['#fff'], 'ems-forecast': ['hsl('] };
  for (const w of widgets) {
    const src = html(w);
    const pal = src.indexOf(PAL_START);
    const rest = pal < 0 ? src : src.slice(0, pal) + src.slice(src.indexOf('}', src.indexOf(':root {', pal)) + 1);
    const found = (rest.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|rgba?\(|hsl\(/g) || [])
      .filter((c) => !(allowed[w] || []).includes(c));
    assert.deepStrictEqual(found, [], `${w}: ${found.join(', ')}`);
  }
});

test('figures stay in the text colour', () => {
  assert.match(html('daily-yield'), /\.daily-value \{[^}]*color: var\(--homey-text-color\);/);
  assert.match(html('daily-yield'), /\.co2-text \{[^}]*color: var\(--homey-text-color\);/);
  const amp = html('netzampel');
  assert.deepStrictEqual(amp.match(/value\.style\.color = '[^']*'/g),
    ["value.style.color = 'var(--homey-text-color-light)'", "value.style.color = ''", "value.style.color = ''", "value.style.color = ''"],
    'a grid figure is coloured again');
  assert.doesNotMatch(html('battery-status'), /powerDir\.style\.color/);
  assert.doesNotMatch(html('ems-battery'), /\.soc\.(green|red)/);
  assert.match(html('ems-forecast'), /\.minmax-row \.now \{ color: var\(--homey-text-color\);/);
  for (const w of ['ems-device', 'charger-status']) {
    assert.match(html(w), /\.stat-value \{[^}]*color: var\(--homey-text-color\);/, `${w}: blue figures`);
  }
  const chart = html('sensor-chart');
  assert.match(chart, /val\.className = 'legend-val';\n/);
  assert.match(chart, /'<span class="tt-val">' \+ fmt\(pt\.v\)/);
  assert.doesNotMatch(html('energy-balance'), /pctColor/);
});

test('the battery has one colour, both ways and in every widget', () => {
  const flow = html('solar-power-flow');
  assert.match(flow, /charge:    'var\(--energy-battery\)',\n  discharge: 'var\(--energy-battery\)',/);
  assert.match(html('netzampel'), /batt > thr  \? 'var\(--energy-battery\)'\n\s*: batt < -thr \? 'var\(--energy-battery\)'/);
  const batt = html('battery-status');
  assert.strictEqual((batt.match(/powerIcon\.style\.stroke = 'var\(--energy-battery\)'/g) || []).length, 2);
  assert.match(batt, /var socColor = 'var\(--energy-battery\)';/);
  assert.match(batt, /if \(soc < 20\) socColor = 'var\(--homey-color-danger\)';/);
  assert.match(html('ems-battery'), /\.bar-fill\.green  \{ background: var\(--energy-battery\); \}/);
  assert.match(html('energy-balance'), /style="stroke:var\(--energy-battery\)"[\s\S]*style="stroke:var\(--energy-battery\)"/);
});

test('the power flow hub shows the Netzampel\'s three lights', () => {
  assert.match(html('solar-power-flow'), /var hubColor = importing \? C\.import\n\s*: exporting \? C\.export\n\s*: \(pvOn \|\| battDisch\) \? C\.covered : null;/);
  assert.match(html('solar-power-flow'), /covered:   'var\(--homey-color-orange\)'/);
  assert.match(html('netzampel'), /\.pulse-orange \{ background: var\(--homey-color-orange\);/);
  assert.match(html('netzampel'), /circle\.setAttribute\('class', 'circle pulse-orange'\);/);
});

test('the sensor chart colours its slots as PV, battery, grid and house, the grid split at zero', () => {
  const src = html('sensor-chart');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.match(/var COLORS  = \[[^\]]*\];/)[0] + 'var SPLIT = 2;' + fnSource(src, 'colorAt'), ctx);
  assert.deepStrictEqual([...ctx.COLORS], ['var(--energy-pv)', 'var(--energy-battery)', 'var(--energy-import)', 'var(--energy-house)']);
  assert.strictEqual(ctx.colorAt(2, 1200), 'var(--energy-import)');
  assert.strictEqual(ctx.colorAt(2, -800), 'var(--energy-export)');
  assert.strictEqual(ctx.colorAt(1, -800), 'var(--energy-battery)', 'only the grid splits');
  assert.match(src, /var stroke = i === SPLIT \? 'url\(#gsplit\)' : COLORS\[i\];/);
  // var() inside an SVG attribute is not resolved; the chart sets colours as style.
  assert.doesNotMatch(src, /(stroke|fill|stop-color)="' \+ (COLORS|c\b)/);
  assert.match(src, /body \{ overflow: hidden; color: var\(--homey-text-color\); \}/);
});

test('the session list outlines the running and the paused session in Homey\'s colours', () => {
  const src = html('session-history');
  assert.match(src, /\.active \{\n    border: 1px solid var\(--homey-color-highlight\);/);
  assert.match(src, /\.active\.paused, \.active\.paused:last-child \{ border-color: var\(--homey-color-orange\); \}/);
  assert.doesNotMatch(src, /\.date-range \{ color:/);
});

// ── D: the EMS history ─────────────────────────────────────────────────────────────────

const HIST = html('ems-history');

function histContext() {
  const ctx = { navigator: { language: 'de-CH' } };
  vm.createContext(ctx);
  const dicts = HIST.slice(HIST.indexOf('var DICTS = '), HIST.indexOf('function dictFor('));
  vm.runInContext([
    dicts, fnSource(HIST, 'dictFor'), "var T = dictFor('de');",
    HIST.match(/var ICONS = \{[\s\S]*?\n\};/)[0],
    HIST.match(/var MODE_MARKS = \{[\s\S]*?\};/)[0],
    HIST.match(/var EXTRACT_MODES = \{[^}]*\};/)[0],
    fnSource(HIST, 'markHtml'), fnSource(HIST, 'fmtStatusDetail'), fnSource(HIST, 'eventInfo'),
  ].join('\n'), ctx);
  return ctx;
}

test('every EMS history event gets a mark with a known icon and tone', () => {
  const ctx = histContext();
  const tones = [...HIST.matchAll(/\.tone-([a-z]+) +\{ color: var\(--[a-z-]+\); \}/g)].map((m) => m[1]);
  assert.deepStrictEqual(tones.sort(), ['battery', 'error', 'export', 'grid', 'off', 'on', 'pv', 'warn']);
  const events = [
    ...Object.keys(ctx.T.modes).map((e) => ({ type: 'mode', event: e })),
    ...['app_start', 'app_update', 'forecast_gate_on', 'forecast_gate_off'].map((e) => ({ type: 'system', event: e })),
    ...['start', 'stop', 'manual_on', 'manual_off', 'start_no_effect', 'battery_full', 'battery_low',
      'battery_charge', 'battery_discharge', 'battery_hold', 'battery_normal'].map((e) => ({ type: 'device', event: e, label: 'X' })),
    ...['start', 'set_amps', 'stop', 'stop_ineffective', 'target_reached', 'target_released'].map((e) => ({ type: 'charger', event: e, label: 'X' })),
  ];
  for (const ev of events) {
    const [icon, tone] = ctx.eventInfo(ev).mark.split(' ');
    assert.ok(ctx.ICONS[icon], `${ev.type}/${ev.event}: no icon "${icon}"`);
    assert.ok(tones.includes(tone), `${ev.type}/${ev.event}: no tone "${tone}"`);
  }
  const mark = (type, event) => ctx.eventInfo({ type, event, label: 'X' }).mark;
  assert.strictEqual(mark('mode', 'solar_hp'), 'sun pv');
  assert.strictEqual(mark('mode', 'price_ev'), 'plug grid');
  assert.strictEqual(mark('mode', 'error'), 'alert error');
  assert.strictEqual(mark('device', 'battery_low'), 'battery battery', 'battery events were green like a device start');
  assert.strictEqual(mark('device', 'start'), 'power on');
  assert.strictEqual(mark('device', 'start_no_effect'), 'alert warn');
  assert.strictEqual(mark('charger', 'stop_ineffective'), 'alert warn', 'a warning was grey like a stop');
  assert.strictEqual(mark('charger', 'stop'), 'car off');
  // The warning sign is the icon now, not a character in the words as well.
  for (const l of ['de', 'en', 'nl']) assert.doesNotMatch(vm.runInContext(`dictFor('${l}').stopIneffective`, ctx), /⚠/);
  assert.match(ctx.markHtml('sun pv'), /^<span class="mark tone-pv"><svg viewBox="0 0 24 24" aria-hidden="true"><circle/);
});

test('the EMS history buttons are 44 px with icons, and name themselves', () => {
  assert.match(HIST, /\.nav-btn, \.refresh-btn \{\n  position: relative;\n  width: 44px; height: 44px;/);
  assert.doesNotMatch(HIST, />[◀▶↻]</);
  assert.match(HIST, /<button class="nav-btn" id="nav-prev"><svg viewBox="0 0 24 24" aria-hidden="true">/);
  assert.match(HIST, /getElementById\('nav-prev'\)\.setAttribute\('aria-label', T\.prevDay\);/);
  assert.match(HIST, /@media \(max-width: 239px\) \{ \.refresh-btn \{ display: none; \} \}/);
});

// render() as the page has it, over a stubbed list.
function renderWith(state) {
  const ctx = histContext();
  const list = { innerHTML: '' };
  Object.assign(ctx, {
    document: { getElementById: () => list },
    fitList: () => { ctx.fitted = (ctx.fitted || 0) + 1; },
    fmtDayLabel: () => 'Heute', navLabel: () => 'Heute',
    allEvents: [], dayOffset: 0, loadError: '',
  }, state);
  vm.runInContext([fnSource(HIST, 'dayStart'), fnSource(HIST, 'dayEnd'), fnSource(HIST, 'fmtTime'),
    fnSource(HIST, 'esc'), fnSource(HIST, 'render')].join('\n'), ctx);
  return { ctx, list };
}

test('an error stays on screen while you page through the days', () => {
  const { ctx, list } = renderWith({ loadError: 'Laden fehlgeschlagen' });
  vm.runInContext('render()', ctx);
  assert.match(list.innerHTML, /Laden fehlgeschlagen/);
  vm.runInContext('dayOffset = 1; render()', ctx);
  assert.match(list.innerHTML, /Laden fehlgeschlagen/, 'paging turned the error into "no events"');
  assert.doesNotMatch(list.innerHTML, /Keine Ereignisse/);
  assert.strictEqual(ctx.fitted, 2, 'the height follows each drawing');

  const withEvents = renderWith({ loadError: 'Fehler: timeout', allEvents: [{ ts: Date.now() - 1000, type: 'mode', event: 'solar_ev' }] });
  vm.runInContext('render()', withEvents.ctx);
  assert.match(withEvents.list.innerHTML, /^<div class="notice">Fehler: timeout<\/div>/, 'the list it could not refresh stays, below the error');
  assert.match(withEvents.list.innerHTML, /class="mark tone-pv"/);

  const quiet = renderWith({});
  vm.runInContext('render()', quiet.ctx);
  assert.match(quiet.list.innerHTML, /Keine Ereignisse für Heute/);
});

test('the EMS history reports a height that follows the list, up to 420 px', () => {
  assert.match(HIST, /var MAX_H = 420, MIN_H = 120;/);
  assert.match(HIST, /if \(!readied\) \{ readied = true; fittedH = h; Homey\.ready\(\{ height: h \}\); return; \}/);
  assert.match(HIST, /if \(h !== fittedH\) \{ fittedH = h; Homey\.setHeight\(h\); \}/);
  assert.doesNotMatch(HIST, /Homey\.ready\(\);/);
  assert.match(HIST, /setTimeout\(function \(\) \{ if \(!readied\) fitList\(\); \}, 3000\);/);
  assert.strictEqual(require('../app.json').widgets['ems-history'].height, 420);
});
