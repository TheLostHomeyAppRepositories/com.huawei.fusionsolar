'use strict';

// The settings page's colour system. Run: node --test
//
// Every colour goes through a token so the dark-mode block can redefine values without
// touching a single component rule. Two things rot silently if nothing watches them:
// a raw hex slipped back into a component (invisible until someone opens the page in
// dark mode), and a token pair whose contrast quietly drops below AA.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
const HEAD = SRC.slice(0, SRC.indexOf('/* ── Header'));

function tokens(indent) {
  const out = {};
  const re = new RegExp('^' + indent + '(--c-[a-z0-9-]+):\\s*(#[0-9a-f]{6});$', 'gim');
  let m;
  while ((m = re.exec(HEAD))) out[m[1]] = m[2].toLowerCase();
  return out;
}
const LIGHT = tokens('      ');
const DARK  = tokens('        ');

const luminance = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the dark mode redefines exactly the tokens the light mode declares', () => {
  assert.ok(Object.keys(LIGHT).length >= 20, 'the token block moved — this test found almost none');
  assert.deepStrictEqual(Object.keys(DARK).sort(), Object.keys(LIGHT).sort(),
    'a token defined in only one mode falls back to the other mode\'s value, which is how '
    + 'a page ends up with one theme\'s text on the other theme\'s ground');
});

test('every token the page uses is defined, and every defined token is used', () => {
  const used = new Set([...SRC.matchAll(/var\((--c-[a-z0-9-]+)\)/g)].map((m) => m[1]));
  const undefined_ = [...used].filter((t) => !(t in LIGHT));
  assert.deepStrictEqual(undefined_, [], 'used but never defined — renders as nothing at all');
  const unused = Object.keys(LIGHT).filter((t) => !used.has(t));
  assert.deepStrictEqual(unused, [], 'defined but unused — dead weight that still has to be maintained');
});

// The whole point of the exercise: no component may carry its own colour, or dark mode
// cannot reach it. One deliberate exception — the log viewer is a terminal panel, dark
// with light text in BOTH modes, and its origin palette is keyed to that dark ground.
// Those colours are asserted separately by settings-log-colour.test.js.
const LOG_PALETTE = new Set([
  '#1e1e22', '#d6d6d9',                                   // the panel itself
  '#5fd0a4', '#d9a55f', '#6fa8f5', '#b98ae8', '#6b7280',  // origin markers
  '#ff6b64', '#8a5250', '#888',                           // errors, dimmed, system
]);

test('no component rule carries a raw colour any more', () => {
  const body = SRC.slice(SRC.indexOf('/* ── Header'));
  const offenders = [...new Set([...body.matchAll(/(background|color)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)]
    .map((m) => m[2].toLowerCase())
    .filter((hex) => !LOG_PALETTE.has(hex)))];
  assert.deepStrictEqual(offenders, [],
    'these would stay light when the page goes dark: ' + offenders.join(', '));
});

// Contrast, computed rather than eyeballed — the dark mode cannot be checked by opening
// the page here, and "looks fine on my screen" is not a measurement.
const AA_TEXT = 4.5;
const AA_LARGE = 3.0;
const PAIRS = [
  ['--c-label',        '--c-card', AA_TEXT,  'body text on a card'],
  ['--c-label-2',      '--c-card', AA_TEXT,  'secondary text on a card'],
  ['--c-label-3',      '--c-card', AA_LARGE, 'hint text on a card'],
  ['--c-label',        '--c-bg',   AA_TEXT,  'body text on the page'],
  ['--c-label-2',      '--c-bg',   AA_TEXT,  'secondary text on the page'],
  ['--c-danger-text',  '--c-card', AA_TEXT,  'error text'],
  ['--c-success-text', '--c-card', AA_TEXT,  'success text'],
  ['--c-warning-text', '--c-card', AA_TEXT,  'warning text'],
  ['--c-link',         '--c-card', AA_TEXT,  'a link'],
  ['--c-accent',       '--c-card', AA_TEXT,  'the accent used as text'],
  ['--c-accent',       '--c-bg',   AA_TEXT,  'the accent used as text on the page'],
  ['--c-on-fill',      '--c-accent-fill', AA_TEXT, 'white on a filled button'],
  ['--c-danger-text',  '--c-tint-danger',  AA_TEXT, 'error text on its tint'],
  ['--c-success-text', '--c-tint-success', AA_TEXT, 'success text on its tint'],
  ['--c-warning-text', '--c-tint-warning', AA_TEXT, 'warning text on its tint'],
  ['--c-label',        '--c-segment-on',    AA_TEXT, 'the selected segment'],
  ['--c-label',        '--c-segment-track', AA_TEXT, 'an unselected segment'],
];

for (const [mode, set] of [['light', LIGHT], ['dark', DARK]]) {
  test(`${mode} mode meets AA contrast on every text/surface pair`, () => {
    for (const [fg, bg, min, what] of PAIRS) {
      assert.ok(set[fg] && set[bg], `${what}: a token is missing in ${mode} mode`);
      const r = contrast(set[fg], set[bg]);
      assert.ok(r >= min,
        `${what} in ${mode} mode: ${r.toFixed(2)} : 1, needs ${min}. `
        + `${fg} (${set[fg]}) on ${bg} (${set[bg]})`);
    }
  });
}

// A segmented control reads as raised-on-recessed. That relationship inverts between
// themes — white on grey in light, a lighter grey than the track in dark — so it cannot
// be expressed by reusing the card token, and it cannot be checked by contrast alone:
// two colours can meet AA against the label while the pill sits *below* its own track.
test('the selected segment is lighter than its track in both themes', () => {
  for (const [mode, set] of [['light', LIGHT], ['dark', DARK]]) {
    const track = set['--c-segment-track'];
    const pill  = set['--c-segment-on'];
    assert.ok(track && pill, `the segment tokens are missing in ${mode} mode`);
    assert.ok(luminance(pill) > luminance(track),
      `${mode} mode: the pill (${pill}) is not lighter than its track (${track}), so the `
      + 'selected segment reads as sunk rather than raised');
  }
});

// iOS's own systemBlue is #007AFF, and it is tempting to use it verbatim. It reaches only
// 4.02 : 1 against white — fine for Apple's 17px type, not for this page's 12–13px labels.
// The pair above enforces the outcome; this records why the value looks "wrong".
test('the accent is not iOS systemBlue, and that is deliberate', () => {
  assert.notStrictEqual(LIGHT['--c-accent'], '#007aff',
    'systemBlue fails AA at this page\'s type sizes — see the contrast pairs above');
});
