'use strict';

/**
 * Time-of-use tariff zones: a fixed daily schedule of named price windows.
 *
 * The "Low / high tariff" model carries exactly one high window per weekday, which cannot
 * express a tariff with three or four periods. Ireland's usual shape is standard / peak /
 * night, often with a fourth cheap window for EV charging inside the night one; Economy 7
 * and 10, German HT/NT with a midday window, and Swiss tariffs with two high blocks are the
 * same problem. Reported by a user in Ireland who had been building the curve by hand.
 *
 * Nothing here decides anything. It turns a schedule into the same hourly
 * `{ start, end, price }` slots that the day-ahead forecast already produces, so the parts
 * that DO decide — grid-charging the battery in the cheapest hours, reserving it for the
 * most expensive ones, EV charging on price, throttling export while the price is negative
 * — work unchanged. That is the whole point of the shape: one more source of slots, not one
 * more set of rules.
 *
 * The config, under `price_config` when `mode === 'zones'`:
 *
 *     zones_default_price: 0.28,        // what an hour costs when no zone covers it
 *     zones: [
 *       { name: 'Night', start: '23:00', end: '08:00', price: 0.11 },
 *       { name: 'Peak',  start: '17:00', end: '19:00', price: 0.42, days: [1,2,3,4,5] },
 *       { name: 'EV',    start: '02:00', end: '04:00', price: 0.08 },
 *     ]
 *
 * Two rules decide which zone owns a minute, and both exist because of that example:
 *
 *   1. A zone with no `days` applies every day; otherwise only on the weekdays it lists
 *      (0 = Sunday, matching Date#getDay and the weekday map used elsewhere in the EMS).
 *
 *   2. When several zones cover the same minute, the NARROWEST window wins, ties going to
 *      the one listed first. Overlaps are not a mistake to be rejected here — the cheap EV
 *      hours sit inside the night window by design, and "the more specific window wins" is
 *      the only reading under which that means what the user meant.
 *
 * A window whose end is at or before its start wraps past midnight, and — as in the
 * low/high model — the DAY selects which definitions apply, then the window wraps within
 * that same day. So `Mon 23:00–08:00` covers Monday 00:00–08:00 and Monday 23:00–24:00.
 * Deviating from that here would give two tariff models different answers for the same
 * input, which is worse than either convention on its own.
 */

const SLOT_MS = 3600_000;   // one hour, matching PRICE_SLOT_HOURS in constants.js
const DAY_MINUTES = 24 * 60;

/**
 * "HH:MM" → minutes since midnight, or null.
 *
 * Deliberately the same expression as EmsDevice#_parseTime rather than a call to it: this
 * module stays free of `this` so it can be tested on its own. A test pins the two against
 * the same table of inputs so they cannot drift apart unnoticed.
 */
function parseTime(str) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str ?? '').trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/**
 * How many minutes of the day a zone covers, or null when its times do not parse.
 *
 * Equal start and end means the whole day, not nothing: a user who writes 00:00–00:00 has
 * described a window with no gap in it. Zero-length would be a window that can never apply,
 * which nobody sits down to configure.
 */
function zoneSpan(zone) {
  const s = parseTime(zone?.start);
  const e = parseTime(zone?.end);
  if (s === null || e === null) return null;
  if (s === e) return DAY_MINUTES;
  return s < e ? e - s : DAY_MINUTES - s + e;
}

/** Whether `zone` applies on `dayOfWeek` (0 = Sunday). No list means every day. */
function zoneAppliesOnDay(zone, dayOfWeek) {
  const days = zone?.days;
  if (!Array.isArray(days) || days.length === 0) return true;
  return days.some((d) => Number(d) === dayOfWeek);
}

/** Whether `zone` covers `minutes` on `dayOfWeek`. */
function zoneCovers(zone, dayOfWeek, minutes) {
  if (!zoneAppliesOnDay(zone, dayOfWeek)) return false;
  const s = parseTime(zone?.start);
  const e = parseTime(zone?.end);
  if (s === null || e === null) return false;
  if (s === e) return true;                       // whole day, see zoneSpan
  return s < e ? (minutes >= s && minutes < e) : (minutes >= s || minutes < e);
}

/** Whether a usable zone schedule is configured at all. */
function zonesConfigured(priceConfig) {
  const zones = priceConfig?.zones;
  return Array.isArray(zones) && zones.some((z) => zoneSpan(z) !== null);
}

/**
 * The zone that owns this minute, or null when none does.
 *
 * Narrowest wins, ties to the earlier entry — see the rules at the top of the file.
 */
function resolveZone(priceConfig, dayOfWeek, minutes) {
  const zones = Array.isArray(priceConfig?.zones) ? priceConfig.zones : [];
  let best = null;
  let bestSpan = Infinity;
  for (const zone of zones) {
    if (!zoneCovers(zone, dayOfWeek, minutes)) continue;
    const span = zoneSpan(zone);
    if (span === null || span >= bestSpan) continue;
    best = zone;
    bestSpan = span;
  }
  return best;
}

/** The number a zone charges, or null when it does not name one. */
function zonePrice(zone) {
  const n = Number(zone?.price);
  return Number.isFinite(n) ? n : null;
}

/**
 * What a kWh costs at this minute: the owning zone's price, else the default.
 *
 * Returns null only when nothing at all is configured — the same "we do not know" every
 * other price source uses, and the value the rest of the EMS already knows how to sit out.
 */
function priceAt(priceConfig, dayOfWeek, minutes) {
  const zone = resolveZone(priceConfig, dayOfWeek, minutes);
  const zoned = zone ? zonePrice(zone) : null;
  if (zoned !== null) return zoned;

  const fallback = Number(priceConfig?.zones_default_price);
  return Number.isFinite(fallback) ? fallback : null;
}

/**
 * Hourly slots covering [fromMs, toMs), in the same shape the day-ahead forecast produces.
 *
 * `wallClockAt(ms) => { dayOfWeek, minutes }` converts an instant to local wall-clock parts.
 * It is passed in rather than computed here because the timezone lives on the Homey device
 * (Node runs UTC on a Homey Pro, so a bare Date would be an hour or two out) — and because
 * a caller-supplied clock is what makes this testable without one.
 *
 * Slots start on the hour and are priced by the zone that owns their FIRST minute. The
 * schedule accepts any HH:MM, so a boundary at 17:30 takes effect for the 17:00 slot. That
 * is the resolution every price consumer in the EMS already works at; the displayed current
 * price, which comes from priceAt() directly, stays exact to the minute.
 */
function slotsBetween(priceConfig, fromMs, toMs, wallClockAt) {
  if (!(toMs > fromMs)) return [];
  if (!zonesConfigured(priceConfig) && !Number.isFinite(Number(priceConfig?.zones_default_price))) return [];

  const slots = [];
  let start = Math.floor(fromMs / SLOT_MS) * SLOT_MS;
  for (; start < toMs; start += SLOT_MS) {
    const { dayOfWeek, minutes } = wallClockAt(start);
    const price = priceAt(priceConfig, dayOfWeek, minutes);
    if (price === null) continue;
    slots.push({ start, end: start + SLOT_MS, price });
  }
  return slots;
}

module.exports = {
  parseTime,
  zoneSpan,
  zoneAppliesOnDay,
  zoneCovers,
  zonesConfigured,
  resolveZone,
  priceAt,
  slotsBetween,
  SLOT_MS,
  DAY_MINUTES,
};
