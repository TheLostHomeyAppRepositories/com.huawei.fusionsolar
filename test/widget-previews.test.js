'use strict';

// scripts/widget-previews.py draws the widget preview images. Hand-drawn previews fell
// behind the widgets; 1.2.339 changed the colours. This holds the drawings and the
// committed images together.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const { spawnSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'widget-previews.py');

test('the preview script draws every widget the app has', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const drawn = [...src.matchAll(/^ {4}'([a-z-]+)': \(\d+, [a-z_]+\),$/gm)].map((m) => m[1]).sort();
  const widgets = fs.readdirSync(path.join(ROOT, 'widgets')).sort();
  assert.deepStrictEqual(drawn, widgets);
  assert.deepStrictEqual(Object.keys(require('../app.json').widgets).sort(), widgets);
  // Not on somebody else's Homey.
  assert.match(fs.readFileSync(path.join(ROOT, '.homeyignore'), 'utf8'), /^scripts\/$/m);
});

// Python with Pillow is a developer tool, not something every machine has; without it the
// comparison is skipped, not failed.
const py = ['python', 'python3', 'py'].find((cmd) =>
  spawnSync(cmd, ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0);

test('the committed previews are the ones the script draws', { skip: !py && 'no Python with Pillow' }, () => {
  const r = spawnSync(py, [SCRIPT, '--check'], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  assert.match(r.stdout, /previews up to date/);
});
