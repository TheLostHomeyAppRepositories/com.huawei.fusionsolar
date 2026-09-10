'use strict';

// Time-of-use tariff zones. Run: node --test
//
// The "Low / high tariff" model carries one high window per weekday, which cannot express
// a three- or four-period tariff. Reported from Ireland, where standard / peak / night is
// the usual shape and a fourth cheap window for EV charging sits inside the night one.
//
// The design bet is that no decision code needed to change: zones produce the same hourly
// slots the day-ahead forecast produces, and the two seams every price decision reads from
// — _priceSlotsBetween and _priceForecastStale — learn about them. The last section is what
// tests that bet, by driving the battery's own decision from nothing but a zone schedule.

const test   = require('node:test');
const assert = require('node:assert');

const tz = require('../lib/ems/tariff-zones.js');
const priceMixin    = require('../lib/ems/price.js');
const forecastMixin = require('../lib/ems/priceForecast.js');

// ── the schedule from the report, in the app's own config shape ──────────────
const IRISH = {
  mode: 'zones',
  currency: 'EUR',
  zones_default_price: 0.28,                                             // standard
  zones: [
    { name: 'Night', start: '23:00', end: '08:00', price: 0.11 },
    { name: 'Peak',  start: '17:00', end: '19:00', price: 0.42, days: [1, 2, 3, 4, 5] },
    { name: 'EV',    start: '02:00', end: '04:00', price: 0.08 },        // inside Night
  ],
};

const WED = 3;
const SUN = 0;
const at = (h, m = 0) => h * 60 + m;

// ── parsing ─────────────────────────────────────────────────────────────────

// The module keeps its own parser so it can be tested without a device. This is what stops
// the two from drifting apart: both are asked the same questions and must agree.
test('parseTime answers exactly what the device\'s own _parseTime answers', () => {
  const device = { _parseTime: priceMixin._parseTime };
  const cases = ['00:00', '7:30', '07:30', '23:59', '24:00', '12:60', '', '  9:05 ',
    'noon', null, undefined, '9', '099:00'];
  for (const c of cases) {
    assert.strictEqual(tz.parseTime(c), device._parseTime(c), `disagreement on ${JSON.stringify(c)}`);
  }
});

// ── windows ─────────────────────────────────────────────────────────────────

test('zoneSpan measures a window, wrapping past midnight when it has to', () => {
  assert.strictEqual(tz.zoneSpan({ start: '17:00', end: '19:00' }), 120);
  assert.strictEqual(tz.zoneSpan({ start: '23:00', end: '08:00' }), 9 * 60);
  assert.strictEqual(tz.zoneSpan({ start: '02:00', end: '04:00' }), 120);
  assert.strictEqual(tz.zoneSpan({ start: 'x', end: '04:00' }), null);
});

// Nobody configures a window that can never apply, so the reading that makes it mean
// something is the one to take.
test('zoneSpan reads equal start and end as the whole day, not as nothing', () => {
  assert.strictEqual(tz.zoneSpan({ start: '00:00', end: '00:00' }), tz.DAY_MINUTES);
  assert.ok(tz.zoneCovers({ start: '06:00', end: '06:00' }, WED, at(3)));
});

test('zoneCovers includes the start minute and excludes the end minute', () => {
  const peak = { start: '17:00', end: '19:00' };
  assert.ok(!tz.zoneCovers(peak, WED, at(16, 59)));
  assert.ok(tz.zoneCovers(peak, WED, at(17, 0)));
  assert.ok(tz.zoneCovers(peak, WED, at(18, 59)));
  assert.ok(!tz.zoneCovers(peak, WED, at(19, 0)));
});

// Same convention as the low/high model: the day picks the definition, then the window
// wraps inside that day. Two tariff models must not answer differently for one input.
test('zoneCovers wraps a night window within its own day', () => {
  const night = { start: '23:00', end: '08:00', days: [WED] };
  assert.ok(tz.zoneCovers(night, WED, at(23, 30)));
  assert.ok(tz.zoneCovers(night, WED, at(2)), 'the early morning of the same weekday');
  assert.ok(!tz.zoneCovers(night, WED, at(12)));
  assert.ok(!tz.zoneCovers(night, SUN, at(2)), 'a day it was not given');
});

test('a zone with no day list applies every day', () => {
  const z = { start: '17:00', end: '19:00' };
  for (let d = 0; d < 7; d++) assert.ok(tz.zoneAppliesOnDay(z, d));
  assert.ok(tz.zoneAppliesOnDay({ ...z, days: [] }, SUN), 'an empty list is not "never"');
});

// ── which zone owns a minute ────────────────────────────────────────────────

// The reason overlaps are allowed at all: the cheap EV hours are inside the night window
// by design, and only "the more specific window wins" reads them the way they were meant.
test('the narrowest window wins where several cover the same minute', () => {
  assert.strictEqual(tz.resolveZone(IRISH, WED, at(3)).name, 'EV');
  assert.strictEqual(tz.resolveZone(IRISH, WED, at(5)).name, 'Night');
  assert.strictEqual(tz.resolveZone(IRISH, WED, at(18)).name, 'Peak');
  assert.strictEqual(tz.resolveZone(IRISH, WED, at(12)), null, 'noon belongs to no zone');
});

test('equally narrow windows go to the one listed first', () => {
  const pc = { zones: [
    { name: 'first',  start: '10:00', end: '11:00', price: 1 },
    { name: 'second', start: '10:00', end: '11:00', price: 2 },
  ] };
  assert.strictEqual(tz.resolveZone(pc, WED, at(10, 30)).name, 'first');
});

test('a zone that does not apply today cannot own the minute', () => {
  assert.strictEqual(tz.resolveZone(IRISH, SUN, at(18)), null, 'weekday peak owned a Sunday');
  assert.strictEqual(tz.priceAt(IRISH, SUN, at(18)), 0.28, 'Sunday evening is standard rate');
});

// ── price ───────────────────────────────────────────────────────────────────

test('an hour no zone covers costs the default', () => {
  assert.strictEqual(tz.priceAt(IRISH, WED, at(12)), 0.28);
});

test('a zone without a price of its own falls through to the default', () => {
  const pc = { zones_default_price: 0.3, zones: [{ name: 'x', start: '01:00', end: '02:00' }] };
  assert.strictEqual(tz.priceAt(pc, WED, at(1, 30)), 0.3);
});

// Same "we do not know" every other price source uses — not a fabricated zero.
test('nothing configured is answered as unknown, not as free', () => {
  assert.strictEqual(tz.priceAt({}, WED, at(12)), null);
  assert.strictEqual(tz.priceAt({ zones: [] }, WED, at(12)), null);
  assert.strictEqual(tz.priceAt({ zones_default_price: 0 }, WED, at(12)), 0, 'zero is an answer');
});

test('zonesConfigured needs a zone whose times actually parse', () => {
  assert.ok(!tz.zonesConfigured({}));
  assert.ok(!tz.zonesConfigured({ zones: [{ name: 'broken', start: 'x', end: 'y' }] }));
  assert.ok(tz.zonesConfigured(IRISH));
});

// ── slots ───────────────────────────────────────────────────────────────────

// A UTC clock keeps the arithmetic in the test readable; the real one comes from Homey.
const utcClock = (ms) => {
  const d = new Date(ms);
  return { dayOfWeek: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

// 2026-09-09 is a Wednesday.
const WED_MIDNIGHT = Date.UTC(2026, 8, 9, 0, 0, 0);

test('a whole day of slots prices every hour from the schedule', () => {
  const slots = tz.slotsBetween(IRISH, WED_MIDNIGHT, WED_MIDNIGHT + 24 * 3600_000, utcClock);
  assert.strictEqual(slots.length, 24);

  const priceAtHour = (h) => slots.find((s) => s.start === WED_MIDNIGHT + h * 3600_000).price;
  assert.strictEqual(priceAtHour(0),  0.11, '00:00 night');
  assert.strictEqual(priceAtHour(2),  0.08, '02:00 EV window inside the night');
  assert.strictEqual(priceAtHour(4),  0.11, '04:00 back to night');
  assert.strictEqual(priceAtHour(8),  0.28, '08:00 standard');
  assert.strictEqual(priceAtHour(17), 0.42, '17:00 peak');
  assert.strictEqual(priceAtHour(18), 0.42, '18:00 peak');
  assert.strictEqual(priceAtHour(19), 0.28, '19:00 standard again');
  assert.strictEqual(priceAtHour(23), 0.11, '23:00 night');
});

test('slots start on the hour even when the window does not', () => {
  const from = WED_MIDNIGHT + 3600_000 + 37 * 60_000; // 01:37
  const slots = tz.slotsBetween(IRISH, from, from + 2 * 3600_000, utcClock);
  assert.strictEqual(slots[0].start, WED_MIDNIGHT + 3600_000, 'the slot containing "from" is included');
  for (const s of slots) {
    assert.strictEqual(s.start % 3600_000, 0);
    assert.strictEqual(s.end - s.start, tz.SLOT_MS);
  }
});

test('an unconfigured schedule produces no slots at all', () => {
  assert.deepStrictEqual(tz.slotsBetween({}, WED_MIDNIGHT, WED_MIDNIGHT + 3600_000, utcClock), []);
  assert.deepStrictEqual(tz.slotsBetween(IRISH, WED_MIDNIGHT, WED_MIDNIGHT, utcClock), []);
});

// ── the device, wired up ────────────────────────────────────────────────────

// Enough of an EmsDevice to run the real mixins: the two price modules, a fixed UTC
// timezone, and a config the test controls.
function makeDevice(priceConfig, { forecast = null, forecastAt = null } = {}) {
  const d = Object.assign({}, priceMixin, forecastMixin);
  d.homey = { clock: { getTimezone: () => 'UTC' } };
  d.log = () => {};
  d.error = () => {};
  d._getConfig = () => ({ price_config: priceConfig });
  d._priceForecast = forecast;
  d._priceForecastUpdatedAt = forecastAt;
  d._pvForecast = null;
  d._pvForecastStale = () => true;
  d._pvSumKwh = () => 0;
  return d;
}

test('a zone schedule is never stale — it is a configuration, not a feed', () => {
  assert.strictEqual(makeDevice(IRISH)._priceForecastStale(Date.now()), false);
});

test('an unusable zone schedule does not pretend to be a price source', () => {
  assert.strictEqual(makeDevice({ mode: 'zones' })._priceForecastStale(Date.now()), true);
  assert.strictEqual(makeDevice({ mode: 'zones', zones: [] })._priceForecastStale(Date.now()), true);
  // A default price with no windows is still a complete answer for every hour.
  assert.strictEqual(makeDevice({ mode: 'zones', zones_default_price: 0.3 })._priceForecastStale(Date.now()), false);
});

test('another tariff model is left entirely alone', () => {
  const dual = makeDevice({ mode: 'dual', price_low: 0.2, price_high: 0.35 });
  assert.strictEqual(dual._priceForecastStale(Date.now()), true, 'dual has no push forecast here');
  assert.deepStrictEqual(dual._priceSlotsBetween(WED_MIDNIGHT, WED_MIDNIGHT + 3600_000), []);
});

// The settings page saves zones_default_price and zones for EVERY tariff model, not just
// this one — so after this version a user on a fixed price carries a complete zone schedule
// in their config without ever having chosen it. The mode check is the only thing standing
// between them and being quietly switched onto it.
test('a schedule sitting unused in the config does not hijack another tariff model', () => {
  const fixedWithLeftovers = {
    mode: 'fixed',
    price_fixed: 0.31,
    zones_default_price: IRISH.zones_default_price,
    zones: IRISH.zones,
  };
  const d = makeDevice(fixedWithLeftovers);
  d._priceWallClock = (ms = Date.now()) => utcClock(ms);

  assert.strictEqual(d._priceForecastStale(Date.now()), true, 'it passed itself off as a price source');
  assert.deepStrictEqual(d._priceSlotsBetween(WED_MIDNIGHT, WED_MIDNIGHT + 24 * 3600_000), []);
  assert.strictEqual(d._getCurrentPrice({ price_config: fixedWithLeftovers }), 0.31);
});

test('the push forecast still reaches the decisions when zones are not selected', () => {
  const slots = [{ start: WED_MIDNIGHT, end: WED_MIDNIGHT + 3600_000, price: 0.5 }];
  const d = makeDevice({ mode: 'forecast' }, { forecast: slots, forecastAt: WED_MIDNIGHT });
  assert.deepStrictEqual(d._priceSlotsBetween(WED_MIDNIGHT, WED_MIDNIGHT + 3600_000), slots);
});

test('on zones the decisions read slots built from the schedule', () => {
  const d = makeDevice(IRISH);
  const slots = d._priceSlotsBetween(WED_MIDNIGHT, WED_MIDNIGHT + 24 * 3600_000);
  assert.strictEqual(slots.length, 24);
  assert.strictEqual(slots.find((s) => s.start === WED_MIDNIGHT + 18 * 3600_000).price, 0.42);
});

// The displayed price is to the minute even though the slots are hourly — a tile that still
// read "low" at 17:30 would be wrong exactly where a user checks it against their bill.
test('the current price follows the schedule to the minute', () => {
  const d = makeDevice(IRISH);
  const cfg = { price_config: IRISH };
  d._priceWallClock = () => ({ dayOfWeek: WED, minutes: at(17, 30) });
  assert.strictEqual(d._getCurrentPrice(cfg), 0.42);
  d._priceWallClock = () => ({ dayOfWeek: WED, minutes: at(16, 30) });
  assert.strictEqual(d._getCurrentPrice(cfg), 0.28);
});

test('the widget payload names the zone in force', () => {
  const d = makeDevice(IRISH);
  d._priceWallClock = (ms = Date.now()) => (ms === undefined ? null : utcClock(ms));
  const status = d.getEmsPriceStatus();
  assert.strictEqual(status.mode, 'zones');
  assert.strictEqual(status.currency, 'EUR');
  assert.strictEqual(status.configured, true);
  assert.ok(typeof status.price === 'number');
  // Slots are hour-aligned, so the one containing "now" starts before it — a 24 h window
  // therefore covers 24 or 25 of them. What matters is that it spans the whole day ahead.
  assert.ok(status.slots.length >= 24, `only ${status.slots.length} slots`);
  assert.ok(status.slots[status.slots.length - 1].end >= Date.now() + 24 * 3600_000);
});

// ── the settings tab ──────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');

// A missing key renders as the key itself, which is how a settings page ends up showing
// "settings.price.zonesDays" to somebody trying to configure their tariff.
test('every string the zone editor asks for exists in all three locales', () => {
  // Two ways the page asks for a string: _H.__('settings.price.x') from script, and
  // data-i18n="price.x" on markup. Both have to resolve, so both are collected.
  const used = [
    ...[...SETTINGS.matchAll(/settings\.price\.(zones[A-Za-z]*)/g)].map((m) => m[1]),
    ...[...SETTINGS.matchAll(/data-i18n="price\.(zones[A-Za-z]*)"/g)].map((m) => m[1]),
  ];
  assert.ok(new Set(used).size >= 10, `only found ${new Set(used).size} zone strings in the page`);

  for (const lang of ['en', 'de', 'nl']) {
    const price = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'))
      .settings.price;
    for (const key of new Set(used)) {
      assert.ok(price[key], `${lang}: settings.price.${key} is missing`);
    }
    assert.ok(price.mode.zones, `${lang}: the tariff dropdown has no name for the zone model`);
    assert.ok(price.subtitle.zones, `${lang}: the collapsed section has no subtitle for it`);
  }
});

test('the tariff dropdown offers the zone model', () => {
  assert.match(SETTINGS, /<option value="zones"/);
});

// The engine reads price_config.zones and price_config.zones_default_price. If the page
// stops sending either, the schedule silently reverts to "everything at one price".
test('the page saves both halves of the schedule', () => {
  const start = SETTINGS.indexOf('function emsGetPriceConfig()');
  assert.ok(start > 0, 'emsGetPriceConfig is gone');
  const block = SETTINGS.slice(start, start + 2500);
  assert.match(block, /zones: emsPriceCollectZones\(\)/);
  assert.match(block, /zones_default_price:/);
});

// ── the point of all of it ──────────────────────────────────────────────────

// Nothing in the battery's decision changed. If this passes, a zone schedule alone buys
// the night-rate charging and the peak-hour reserve that previously needed a day-ahead
// feed — which is the entire reason for the feature.
const BATTERY = {
  price_charge_enabled: true,
  price_target_soc: 90,
  price_charge_power_kw: 3,
  capacity_kwh: 10,
  price_discharge_reserve_hours: 4,
};

test('the battery grid-charges in the cheapest window the schedule offers', () => {
  const d = makeDevice(IRISH);
  d._priceWallClock = (ms = Date.now()) => utcClock(ms);
  // 6 kWh needed at 3 kW is two hours, and the two cheapest on this schedule are the EV
  // window inside the night one — not merely "some night hour".
  const evHour = WED_MIDNIGHT + 2 * 3600_000 + 30 * 60_000; // Wednesday 02:30

  const decision = d._batteryPriceMode(BATTERY, 30, { price_config: IRISH }, evHour);
  assert.strictEqual(decision.mode, 'charge', decision.reason);
  assert.strictEqual(decision.chargeSlots.length, 2);
  for (const slot of decision.chargeSlots) {
    assert.strictEqual(slot.price, 0.08, 'charged outside the cheapest window');
  }
});

// The plan is visible even while it is waiting, which is what makes "why is it not charging
// at the night rate" answerable: because three hours later is cheaper still.
test('at the night rate it waits, with the cheaper hours already picked', () => {
  const d = makeDevice(IRISH);
  d._priceWallClock = (ms = Date.now()) => utcClock(ms);
  const nightHour = WED_MIDNIGHT + 23 * 3600_000 + 30 * 60_000; // Wednesday 23:30

  const decision = d._batteryPriceMode(BATTERY, 30, { price_config: IRISH }, nightHour);
  assert.notStrictEqual(decision.mode, 'charge');
  assert.strictEqual(decision.chargeSlots.length, 2);
  for (const slot of decision.chargeSlots) assert.strictEqual(slot.price, 0.08);
});

test('the battery holds its charge for the peak window instead of discharging into it', () => {
  const d = makeDevice(IRISH);
  d._priceWallClock = (ms = Date.now()) => utcClock(ms);
  const middayHour = WED_MIDNIGHT + 12 * 3600_000; // standard rate, not cheap, not peak

  // Two reserve hours against a two-hour peak: the reserve is then exactly the peak, with
  // no ties among the flat standard hours to muddy what is being asserted.
  const battery  = { ...BATTERY, price_discharge_reserve_hours: 2 };
  const decision = d._batteryPriceMode(battery, 95, { price_config: IRISH }, middayHour);

  assert.strictEqual(decision.mode, 'hold', decision.reason);
  assert.strictEqual(decision.reserveSlots.length, 2);
  for (const slot of decision.reserveSlots) {
    assert.strictEqual(slot.price, 0.42, 'reserved an hour that is not the peak');
  }
});

// And once the peak actually arrives, the hold is released — a reserve that never spends
// itself would be worse than none.
test('in the peak hour itself the battery is allowed to discharge', () => {
  const d = makeDevice(IRISH);
  d._priceWallClock = (ms = Date.now()) => utcClock(ms);
  const peakHour = WED_MIDNIGHT + 18 * 3600_000; // Wednesday 18:00

  const battery  = { ...BATTERY, price_discharge_reserve_hours: 2 };
  const decision = d._batteryPriceMode(battery, 95, { price_config: IRISH }, peakHour);
  assert.strictEqual(decision.mode, 'normal', decision.reason);
});

// The defect a repeating schedule exposed. Among equally priced hours the selector used to
// always take the later one, which is right for a car with a deadline and wrong for a
// battery without: the 24 h lookahead over a daily schedule always contains tomorrow's copy
// of the cheap window, so the battery deferred to it for ever and never charged at all.
test('among equally priced hours the battery takes the earlier, the car the later', () => {
  const d = makeDevice(IRISH);
  const hour = (h) => ({ start: WED_MIDNIGHT + h * 3600_000, end: WED_MIDNIGHT + (h + 1) * 3600_000, price: 0.1 });
  const slots = [hour(2), hour(3), hour(26)];   // three hours at exactly the same price

  const earlier = d._priceSelectCheapestSlots(slots, 2, 0, true);
  assert.deepStrictEqual([...earlier].sort(), [hour(2).start, hour(3).start].sort());

  const later = d._priceSelectCheapestSlots(slots, 2, 0);
  assert.deepStrictEqual([...later].sort(), [hour(3).start, hour(26).start].sort());
});

test('with no schedule the battery falls back to its normal behaviour', () => {
  const d = makeDevice({ mode: 'zones' });
  d._priceWallClock = (ms = Date.now()) => utcClock(ms);
  const decision = d._batteryPriceMode(BATTERY, 30, { price_config: { mode: 'zones' } }, WED_MIDNIGHT);
  assert.strictEqual(decision.mode, 'normal');
  assert.match(decision.reason, /no price forecast/);
});
