'use strict';

// What gets packed into the app archive, and what must not. Run: node --test
//
// Two different mistakes are guarded here, and they pull in opposite directions.
//
// The first is shipping what belongs only in the repository: the Huawei reference tables the
// register lists were built from, and the German developer notes. Those are ~193 KB on every
// Homey that installs this app, and nothing on the device ever opens them.
//
// The second is the one that would actually hurt, and it is easy to make while fixing the
// first: README.md is excluded, but README.txt, README.de.txt and README.nl.txt are the App
// Store description in three languages. One tidy-minded `README*` and the store listing goes
// blank in all three. So the rules here are exact names by design, and this file says so in
// a way that fails rather than in a comment that can be read past.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT   = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, '.homeyignore'), 'utf8');

const rules = source
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

test('the repository-only files are kept out of the archive', () => {
  for (const rule of ['test/', 'Modbus Register.xlsx', 'README.md', 'docs/']) {
    assert.ok(rules.includes(rule), `.homeyignore no longer excludes ${rule}`);
  }
});

test('nothing here can sweep up the App Store description', () => {
  // The store text lives in README.txt and its two translations. They are small, they are
  // the only thing a prospective user reads, and they sit next to a 93 KB README.md that is
  // excluded by name. A pattern is the one way to lose them by accident.
  for (const keep of ['README.txt', 'README.de.txt', 'README.nl.txt']) {
    assert.ok(fs.existsSync(path.join(ROOT, keep)), `${keep} is missing from the repository`);
    assert.ok(!rules.includes(keep), `${keep} is the store description — it has to ship`);
  }

  const patterns = rules.filter((rule) => /[*?[\]]/.test(rule));
  assert.deepStrictEqual(patterns, [],
    'a pattern here is one rename away from dropping the store description; use exact names');
});

test('no rule has quietly stopped matching anything', () => {
  // A rule that matches nothing is not harmless: it means the file it named was renamed or
  // moved, and whatever it became is now being packed again without anybody noticing.
  for (const rule of rules) {
    const target = path.join(ROOT, rule.replace(/\/+$/, ''));
    assert.ok(fs.existsSync(target),
      `.homeyignore excludes "${rule}", which does not exist — a rename left the rule doing nothing`);
  }
});
