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

// A grouped list separates its groups with space, and names them with a label that sits
// quietly above. Drawing a rule beside that label makes it a divider instead of a name,
// and the page then has two dividers doing one job. The rule is easy to reintroduce —
// it looks like a tidy flourish — so the absence is asserted rather than assumed.
test('section headings name their group without ruling it off', () => {
  const css = SRC.slice(0, SRC.indexOf('</style>'));
  assert.doesNotMatch(css, /\.ems-group::(after|before)/,
    'the flexible rule beside the group label is back');
  // Deliberately a floor and a weight rather than one exact size: the page's whole type
  // scale gets nudged from time to time, and a test that pins 13px turns every such nudge
  // into a false failure. What must not come back is the 11px bold label that shouted at
  // the rows it was introducing.
  const sizes = [];
  for (const cls of ['.ems-group', '.section-title']) {
    const block = css.slice(css.indexOf('    ' + cls + ' {'));
    const rule = block.slice(0, block.indexOf('}'));
    const size = Number((rule.match(/font-size:\s*(\d+)px/) || [])[1]);
    assert.ok(size >= 13, `${cls} is ${size}px — too small to introduce anything`);
    assert.match(rule, /font-weight:\s*400/, `${cls} is bold again — a heading that competes with its own rows`);
    sizes.push(size);
  }
  assert.strictEqual(sizes[0], sizes[1],
    'the two section headings disagree about their size, which is what made the page look '
    + 'unfinished before they were brought into step');
});

// Corners had drifted to twelve different values between 1px and 12px. No one notices any
// single one; together they are what makes a page read as assembled over years rather than
// designed. Four steps carry everything, and the ladder is not arbitrary — a pill inside a
// track needs outer minus padding, or it sits crooked in its own well.
const RADIUS_LADDER = [6, 8, 10, 12];

test('corners come from the radius ladder', () => {
  // The whole file, not just the stylesheet: only 39 of the 137 radii live in <style>,
  // the rest are inline on markup the page builds in JavaScript — which is exactly where
  // a one-off value gets typed without anyone seeing the other 136.
  // Single-valued only: one-sided shapes (border-radius: 1px 1px 0 0) and circles (50%)
  // are deliberate and say so by their own syntax.
  const found = [...SRC.matchAll(/border-radius:\s*(\d+)px(?=\s*[;}"'])/g)].map((m) => Number(m[1]));
  assert.ok(found.length >= 100, 'the radii moved — this test found almost none');
  const stray = [...new Set(found.filter((r) => !RADIUS_LADDER.includes(r)))].sort((a, b) => a - b);
  assert.deepStrictEqual(stray, [], 'off-ladder corner radii: ' + stray.join(', '));
});

test('each segmented pill is inset from its track by exactly its padding', () => {
  const css = SRC.slice(0, SRC.indexOf('</style>'));
  const radiusOf = (sel) => {
    const i = css.indexOf('    ' + sel + ' {');
    assert.ok(i >= 0, 'rule not found: ' + sel);
    const block = css.slice(i, i + css.slice(i).indexOf('}'));
    return Number((block.match(/border-radius:\s*(\d+)px/) || [])[1]);
  };
  for (const [track, pill] of [['.tab-bar', '.tab'], ['.sub-tab-bar', '.sub-tab']]) {
    assert.strictEqual(radiusOf(track) - 2, radiusOf(pill),
      `${track}: a ${radiusOf(pill)}px pill in a ${radiusOf(track)}px track with 2px of padding `
      + 'leaves a crescent of track showing at each corner');
  }
});

// iOS's own systemBlue is #007AFF, and it is tempting to use it verbatim. It reaches only
// 4.02 : 1 against white — fine for Apple's 17px type, not for this page's 12–13px labels.
// The pair above enforces the outcome; this records why the value looks "wrong".
test('the accent is not iOS systemBlue, and that is deliberate', () => {
  assert.notStrictEqual(LIGHT['--c-accent'], '#007aff',
    'systemBlue fails AA at this page\'s type sizes — see the contrast pairs above');
});
