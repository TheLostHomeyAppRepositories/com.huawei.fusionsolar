'use strict';

// Widget layout, review of 2026-10-11 (1.2.338). Checked against Athom's widget styling guide
// and rendered at 160–360 px wide, the width of a dashboard column on a phone up to a tablet:
//
//   A. ems-device drew its sections with no gap at all: they sit in #content, not in the flex
//      .card that carries the gap, and the script set #content to display:block.
//   B. Three widgets measured their height once (charger-status, netzampel, battery-status) and
//      cut off whatever wrapped later; several laid figures side by side that ran past the
//      frame in a narrow column.
//
// These tests hold the source to the fixes; the layout itself was checked in a browser.
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const W = path.join(__dirname, '..', 'widgets');
const html = (w) => fs.readFileSync(path.join(W, w, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const widgets = fs.readdirSync(W).filter((w) => fs.existsSync(path.join(W, w, 'public', 'index.html')));

// ── B: the height follows the content ─────────────────────────────────────────

test('every widget that brings fitHeight also uses it', () => {
  for (const w of widgets) {
    const src = html(w);
    if (!/function fitHeight\(/.test(src)) continue;
    const calls = (src.match(/fitHeight\(Homey,/g) || []).length;
    assert.ok(calls >= 1, `${w} defines fitHeight and never calls it — its height is measured once`);
  }
});

test('charger-status, netzampel and battery-status refit after every new answer', () => {
  assert.match(html('charger-status'), /tickTimer\(\);\n[\s\S]{0,400}if \(readied\) fitHeight\(Homey, document\.body\);\n  \}/);
  assert.match(html('charger-status'), /Homey\.ready\(\{ height: Math\.ceil\(rect\.bottom\) \+ 8 \}\);\n    readied = true;/);
  assert.match(html('netzampel'), /function settle\(\) \{[\s\S]*?return;\n    \}\n    fitHeight\(Homey, document\.body\);/);
  assert.match(html('netzampel'), /sub\.textContent = T\.stale;\n        settle\(\);/);
  const batt = html('battery-status');
  assert.match(batt, /if \(data\) render\(data\); fitHeight\(Homey, document\.body\); \}/);
  assert.match(batt, /T\.appDown : T\.stale;\n      fitHeight\(Homey, document\.body\);/);
});

test('ems-battery refits when an error message replaces the status line', () => {
  const src = html('ems-battery');
  const start = src.indexOf('function flashError(msg) {');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.ok(start > 0 && /\n    syncHeight\(\);$/.test(body), 'flashError no longer refits the height');
});

test('sensor-chart refits the same box it readied with, and redraws on a new width', () => {
  const src = html('sensor-chart');
  assert.match(src, /fitHeight\(Homey, document\.body\);/);
  assert.doesNotMatch(src, /fitHeight\(Homey, document\.getElementById\('chart-wrap'\)\)/);
  assert.match(src, /addEventListener\('resize', function\(\) \{[\s\S]*?renderChart\(G\.series, G\.hours\);[\s\S]*?settle\(\);/);
});

// ── A: ems-device spacing ─────────────────────────────────────────────────────

test('ems-device spaces its sections, and the script no longer undoes it', () => {
  const src = html('ems-device');
  assert.match(src, /#content \{ display: flex; flex-direction: column; gap: var\(--homey-su-2\); \}/);
  assert.doesNotMatch(src, /content\.style\.display = 'block'/);
  assert.doesNotMatch(src, /carSection\.style\.display = 'block'/);
});

// ── B: narrow columns ─────────────────────────────────────────────────────────

test('rows of figures wrap instead of running past the frame', () => {
  assert.match(html('ems-device'), /\.stats, \.car-stats \{\n    display: grid; grid-template-columns: repeat\(auto-fit, minmax\(84px, 1fr\)\);/);
  assert.match(html('ems-device'), /\.name \{\n    flex: 1 1 96px; min-width: 0;/);
  assert.match(html('charger-status'), /display: grid; grid-template-columns: repeat\(auto-fit, minmax\(64px, 1fr\)\);/);
  assert.match(html('daily-yield'), /\.main-row \{\n    display: flex;\n    flex-wrap: wrap;/);
  assert.match(html('energy-balance'), /\.chip-row \{\n    display: flex;\n    flex-wrap: wrap;/);
  assert.match(html('energy-balance'), /\.chip \{\n    flex: 1 1 96px;/);
  const batt = html('battery-status');
  assert.match(batt, /\.soc-row \{\n    display: flex;\n    flex-wrap: wrap;/);
  assert.match(batt, /\.row-tile \{\n    flex: 1 1 120px;/);
  assert.match(html('ems-forecast'), /\.minmax-row > span \{ white-space: nowrap; \}/);
  assert.match(html('ems-battery'), /\.title \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
});

test('large figures step down a size in a narrow column', () => {
  assert.match(html('netzampel'), /@media \(max-width: 239px\) \{\n    \.status-value \{ font-size: var\(--homey-font-size-large\); line-height: var\(--homey-line-height-large\); \}/);
  assert.match(html('solar-power-flow'), /@media \(max-width: 199px\) \{\n    \.node-value \{ font-size: var\(--homey-font-size-default\);/);
});

test('solar-power-flow keeps its side nodes inside the frame and its lines on the centre', () => {
  const src = html('solar-power-flow');
  assert.match(src, /#node-grid \{ left: max\(16%, 38px\) !important; \}/);
  assert.match(src, /#node-batt \{ left: min\(84%, calc\(100% - 38px\)\) !important; \}/);
  assert.match(src, /@media \(max-width: 179px\) \{ \.hub \{ display: none !important; \} \}/);
  // A hidden hub has no box; the lines must not run to the top-left corner.
  assert.match(src, /var hub   = hubEl\.offsetWidth \? rel\(hubEl, wrap\)\n    : \{ top: wr\.height \/ 2/);
  assert.match(src, /addEventListener\('resize', function \(\) \{ positionLines\(\); \}\);/);
});

test('sensor-chart gives the legend its own line when narrow and names fewer times', () => {
  const src = html('sensor-chart');
  assert.match(src, /\.header \{\n    display: flex;\n    flex-wrap: wrap;/);
  assert.match(src, /\.legend \{[\s\S]*?flex: 1 1 150px;/);
  assert.match(src, /var nX = innerW < 140 \? 1 : \(innerW < 260 \|\| hours > 48\) \? 2 : 4;/);
});

// The positioning rule above, run: with no hub box the four lines meet in the middle.
test('the hub fallback puts the meeting point in the middle of the flow area', () => {
  const src = html('solar-power-flow');
  const body = /function positionLines\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  const lines = {};
  const box = (o) => ({ getBoundingClientRect: () => o });
  const els = {
    'flow-wrap': box({ left: 0, top: 0, right: 144, bottom: 236, width: 144, height: 236 }),
    hub: Object.assign(box({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }), { offsetWidth: 0 }),
    'node-pv': box({ left: 40, top: 10, right: 104, bottom: 60 }),
    'node-house': box({ left: 40, top: 180, right: 104, bottom: 230 }),
    'node-grid': box({ left: 0, top: 100, right: 60, bottom: 140 }),
    'node-batt': box({ left: 84, top: 100, right: 144, bottom: 140 }),
  };
  const document = { getElementById: (id) => els[id] };
  const rel = (el, wrap) => {
    const r = el.getBoundingClientRect(); const w = wrap.getBoundingClientRect();
    return { top: r.top - w.top, bottom: r.bottom - w.top, left: r.left - w.left, right: r.right - w.left,
      cx: (r.left + r.right) / 2 - w.left, cy: (r.top + r.bottom) / 2 - w.top };
  };
  const setCoords = (id, x1, y1, x2, y2) => { lines[id] = [x1, y1, x2, y2]; };
  new Function('document', 'rel', 'setCoords', body)(document, rel, setCoords);
  assert.deepStrictEqual(lines['line-grid'], [60, 118, 72, 118]);
  assert.deepStrictEqual(lines['line-batt'], [72, 118, 84, 118]);
  assert.deepStrictEqual(lines['line-pv'], [72, 60, 72, 118]);
});
