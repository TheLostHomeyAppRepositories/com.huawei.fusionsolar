'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { StationSession } = require('../lib/openapi-coordinator');
const resolve = (settings) => StationSession.resolveBaseUrl((k) => settings[k]);

const EU5  = 'https://eu5.fusionsolar.huawei.com';
const INTL = 'https://intl.fusionsolar.huawei.com';

// Die Regionsauswahl traegt die URL als eigenen Wert. Waehlt sie ins Leere, zeigen alle
// API-Aufrufe auf den falschen Host — ohne Fehlermeldung, weil der alte Server ja
// weiterhin antwortet.

test('resolveBaseUrl — the region wins over the text field', () => {
  assert.strictEqual(resolve({ base_url_region: INTL, base_url: EU5 }), INTL);
});

test('resolveBaseUrl — "custom" falls back to the text field', () => {
  assert.strictEqual(resolve({ base_url_region: 'custom', base_url: 'https://example.test' }), 'https://example.test');
});

test('resolveBaseUrl — a device from before the dropdown existed keeps its URL', () => {
  // base_url_region fehlt komplett. Haette der Fallback hier eine Region gewaehlt, waere
  // jede Anlage ausserhalb Europas beim naechsten App-Update stillschweigend umgezogen.
  assert.strictEqual(resolve({ base_url: INTL }), INTL);
});

test('resolveBaseUrl — nothing configured at all falls back to Europe', () => {
  assert.strictEqual(resolve({}), EU5);
});

test('resolveBaseUrl — a trailing slash is dropped so paths do not double up', () => {
  assert.strictEqual(resolve({ base_url_region: 'custom', base_url: EU5 + '/' }), EU5);
  assert.strictEqual(resolve({ base_url_region: 'custom', base_url: '  ' + EU5 + '  ' }), EU5);
});

test('resolveBaseUrl — an empty text field under "custom" still yields a usable host', () => {
  assert.strictEqual(resolve({ base_url_region: 'custom', base_url: '' }), EU5);
});
