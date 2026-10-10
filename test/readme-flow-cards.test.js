'use strict';

// The flow-card tables in README.md are built from app.json by scripts/readme-flow-cards.js.
// Written by hand they had fallen a third of the cards behind by 1.2.324 (README review
// 2026-10-10). This fails when a card, its title or its hint changes without the README.
//
// Fix: node scripts/readme-flow-cards.js --write
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { render, START, END } = require('../scripts/readme-flow-cards.js');

const README = path.join(__dirname, '..', 'README.md');
const APP    = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

test('the flow cards in README.md are the ones app.json has — run scripts/readme-flow-cards.js --write', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.ok(readme.includes(START) && readme.includes(END), 'the generated section is gone from README.md');
  assert.ok(render(readme) === readme, 'README.md is out of date with app.json: node scripts/readme-flow-cards.js --write');
});

test('every card that is offered is in it, and no retired one', () => {
  const text = fs.readFileSync(README, 'utf8');
  const section = text.slice(text.indexOf(START), text.indexOf(END));
  for (const kind of ['triggers', 'conditions', 'actions']) {
    for (const card of APP.flow[kind]) {
      const hint = card.hint.en.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
      if (card.deprecated) assert.ok(!section.includes(hint), `retired ${card.id} is listed`);
      else assert.ok(section.includes(hint), `${kind} ${card.id} is missing`);
    }
  }
});

test('the generator is not shipped to the Homey', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.homeyignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('scripts/'));
});
