'use strict';

// The settings page's visual system — colour tokens and the focus/tap rules that decide
// how it behaves under a thumb. Run: node --test
//
// Every colour goes through a token, so a shade changes in one place rather than in the
// 59 spots one red used to occupy. The page is deliberately light-only: a dark theme was
// built and then dropped because it was not wanted, and `color-scheme: light` is what
// stops a dark device from colouring the native controls anyway. Two things rot silently
// if nothing watches them: a raw hex slipped back into a component, and a token pair
// whose contrast quietly drops below AA.

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

// Light-only is a decision, not an omission: half a dark theme — the page's own colours
// flipped while the browser still paints selects, scrollbars and date pickers dark — is
// worse than no dark theme at all.
test('the page pins itself to the light theme', () => {
  assert.ok(Object.keys(LIGHT).length >= 20, 'the token block moved — this test found almost none');
  assert.match(SRC, /color-scheme:\s*light/,
    'without this a dark device still renders the native controls dark inside a light page');
  assert.doesNotMatch(SRC, /prefers-color-scheme/,
    'a dark theme is back — if that is wanted, this file has to check both themes again: '
    + 'token parity, and every contrast pair below in each of them');
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

test('every text/surface pair meets AA contrast', () => {
  for (const [fg, bg, min, what] of PAIRS) {
    assert.ok(LIGHT[fg] && LIGHT[bg], `${what}: a token is missing`);
    const r = contrast(LIGHT[fg], LIGHT[bg]);
    assert.ok(r >= min,
      `${what}: ${r.toFixed(2)} : 1, needs ${min}. ${fg} (${LIGHT[fg]}) on ${bg} (${LIGHT[bg]})`);
  }
});

// A segmented control reads as raised-on-recessed, and contrast alone cannot check that:
// two colours can both meet AA against the label while the pill sits *below* its track,
// which would make the selected tab look pressed into the page rather than lifted out.
test('the selected segment is lighter than its track', () => {
  const track = LIGHT['--c-segment-track'];
  const pill  = LIGHT['--c-segment-on'];
  assert.ok(track && pill, 'the segment tokens are missing');
  assert.ok(luminance(pill) > luminance(track),
    `the pill (${pill}) is not lighter than its track (${track})`);
});

// The pointer-versus-keyboard split. Suppressing the focus ring is a one-line edit that
// looks like tidying and quietly removes the only way to operate the page without a
// pointer, so the ring is asserted to still exist — and the tap suppression it sits next
// to is asserted to come with a replacement, or the page feels dead under the thumb.
test('the keyboard focus ring survives, and taps get feedback without it', () => {
  assert.match(SRC, /:focus-visible[^{]*\{\s*outline:\s*2px solid var\(--c-accent\)/,
    'the keyboard focus ring is gone — the page can no longer be operated without a pointer');
  assert.match(SRC, /\.tab:focus:not\(:focus-visible\)/,
    'nothing clears a pointer-induced focus ring, which sits on the segmented pill as a '
    + 'border the design never asked for');
  assert.match(SRC, /-webkit-tap-highlight-color:\s*transparent/,
    'the grey iOS tap flash is back, drawn on top of the control\'s own pressed state');
  assert.match(SRC, /button:active:not\(:disabled\)/,
    'the tap highlight is suppressed with nothing put in its place');
});

// iOS's own systemBlue is #007AFF, and it is tempting to use it verbatim. It reaches only
// 4.02 : 1 against white — fine for Apple's 17px type, not for this page's 12–13px labels.
// The pair above enforces the outcome; this records why the value looks "wrong".
test('the accent is not iOS systemBlue, and that is deliberate', () => {
  assert.notStrictEqual(LIGHT['--c-accent'], '#007aff',
    'systemBlue fails AA at this page\'s type sizes — see the contrast pairs above');
});
