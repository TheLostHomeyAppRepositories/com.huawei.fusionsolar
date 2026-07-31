'use strict';

// Electricity price forecast + deadline-based "should I charge now" decision (D10).
// Mixed into EmsDevice.prototype; `this` is the device instance.
//
// Unlike the Solcast PV forecast, this is PUSH-based: the user wires a flow from
// their price app (e.g. "Power by the Hour", Tibber, any day-ahead price source)
// to the `ems_set_price_forecast` action, which calls _ingestPriceForecast(). No
// active fetch, so no rate limit — staleness here just detects a broken/removed
// source flow, not a quota problem.
//
// The core idea (inspired by evcc's charge planner): for a car with a configured
// "ready by" deadline and target SoC, first net off what the Solcast PV forecast
// will deliver by then; only the REMAINING energy is planned against the cheapest
// price slots before the deadline (with a short "precondition" block guaranteed
// right before the deadline, and a fail-safe: if price data is stale/missing, charge
// continuously so the car is never stranded just because the price flow broke).

const { PRICE_FORECAST_STALE_MS, PRICE_SLOT_HOURS } = require('./constants');

module.exports = {

  async _restorePriceForecast() {
    this._priceForecast          = null; // [{ start:<ms>, end:<ms>, price:<num> }] ascending, or null
    this._priceForecastUpdatedAt = null; // ms of last ingest
    try {
      const stored = await this.getStoreValue('priceForecast');
      if (stored && Array.isArray(stored.slots)) {
        this._priceForecast          = stored.slots;
        this._priceForecastUpdatedAt = stored.updatedAt || null;
      }
    } catch (e) { /* ignore */ }
  },

  // Parses a JSON array of hourly prices (as emitted by "Power by the Hour"'s
  // `new_prices` trigger, or any similar day-ahead price app) and merges it into the
  // stored forecast so 'this_day' / 'tomorrow' / 'next_hours' pushes all coexist and
  // overlapping slots are simply overwritten.
  //   period: 'this_day' | 'tomorrow' | 'next_hours' (anchors the array's first slot)
  async _ingestPriceForecast(pricesJson, period, nowMs = Date.now()) {
    let arr;
    try { arr = JSON.parse(pricesJson); } catch (e) { throw new Error(`invalid prices JSON: ${e.message}`); }
    if (!Array.isArray(arr) || !arr.length) throw new Error('prices must be a non-empty array');

    const tz     = this.homey?.clock?.getTimezone?.() || 'UTC';
    const anchor = this._priceForecastAnchor(nowMs, tz, period);
    const slotMs = PRICE_SLOT_HOURS * 3600_000;

    const fresh = [];
    for (let i = 0; i < arr.length; i++) {
      const price = Number(arr[i]);
      if (!Number.isFinite(price)) continue;
      const start = anchor + i * slotMs;
      fresh.push({ start, end: start + slotMs, price });
    }
    // Replace by proximity, not exact-key match: two ingests for the "same" hour can
    // land a few hundred ms apart (anchor computed from the exact Date.now() of each
    // flow run) — a ±2s tolerance self-heals any such near-duplicates (including ones
    // already sitting in the store from before this was fixed) without touching
    // genuinely different, adjacent hours (3.6M ms apart, far outside the tolerance).
    const DRIFT_TOLERANCE_MS = 2000;
    const kept = (this._priceForecast || [])
      .filter((s) => !fresh.some((f) => Math.abs(f.start - s.start) <= DRIFT_TOLERANCE_MS));
    const byStart = new Map([...kept, ...fresh].map((s) => [s.start, s]));
    // Drop slots that ended more than a day ago — keeps the store from growing forever.
    const cutoff = nowMs - 24 * 3600_000;
    const slots = [...byStart.values()].filter((s) => s.end > cutoff).sort((a, b) => a.start - b.start);

    this._priceForecast          = slots;
    this._priceForecastUpdatedAt = nowMs;
    await this.setStoreValue('priceForecast', { slots, updatedAt: nowMs }).catch(() => {});
    this.log(`[EMS] Price forecast ingested (${period}): ${arr.length} slot(s), ${slots.length} total cached`);
  },

  // Pure: anchor time (ms) for the first element of a pushed price array.
  // Reuses pvForecast.js's already-tested _pvMsUntilLocalMidnight instead of
  // reimplementing local-midnight arithmetic (DST-safe by construction).
  _priceForecastAnchor(nowMs, tz, period) {
    if (period === 'this_day' || period === 'tomorrow') {
      // _pvMsUntilLocalMidnight only accounts for whole hour/minute/second, so it
      // preserves nowMs's own sub-second remainder untouched. Two ingests moments
      // apart (different ms remainder) would then anchor to midnight timestamps a
      // few hundred ms apart — same calendar hour, different `start` key — so the
      // Map-based dedup in _ingestPriceForecast never collides and slots pile up
      // (observed as the slot count doubling on every re-trigger). Flooring to
      // whole seconds first makes the midnight anchor exactly reproducible all day.
      const nowSec = Math.floor(nowMs / 1000) * 1000;
      const nextMidnightMs = nowSec + this._pvMsUntilLocalMidnight(nowSec, tz); // start of tomorrow, local
      const todayMidnightMs = nextMidnightMs - 24 * 3600_000;
      return period === 'tomorrow' ? nextMidnightMs : todayMidnightMs;
    }
    // 'next_hours' (or unknown) → floor to the start of the current local hour.
    return this._priceFloorToHour(nowMs, tz);
  },

  // Pure: floor a ms timestamp to the start of its local hour in `tz`. Subtracting the
  // local minutes/seconds-into-hour from the absolute ms lands on the hour boundary
  // correctly regardless of the zone's UTC offset (including half/quarter-hour zones).
  _priceFloorToHour(ts, tz) {
    // Floor to whole seconds first — otherwise ts's own sub-second remainder survives
    // into the result, so two calls within the same hour but different milliseconds
    // (e.g. repeated manual flow test-runs) would return slightly different "same
    // hour" boundaries and defeat the start-keyed dedup in _ingestPriceForecast.
    const tsSec = Math.floor(ts / 1000) * 1000;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(tsSec));
    const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    return tsSec - (get('minute') * 60 + get('second')) * 1000;
  },

  // The forecast is "stale" when there is none, or nothing has been pushed for a
  // long time (the source flow likely broke or was removed).
  _priceForecastStale(nowMs = Date.now()) {
    return !this._priceForecast
      || !this._priceForecastUpdatedAt
      || (nowMs - this._priceForecastUpdatedAt) > PRICE_FORECAST_STALE_MS;
  },

  // Pure: slots overlapping [fromMs, toMs), ascending by start.
  _priceSlotsBetween(fromMs, toMs) {
    if (!Array.isArray(this._priceForecast)) return [];
    return this._priceForecast
      .filter((s) => s.end > fromMs && s.start < toMs)
      .sort((a, b) => a.start - b.start);
  },

  // Pure: ms from nowMs until the next local occurrence of wall-clock time HH:MM —
  // today if it hasn't passed yet, otherwise tomorrow. (Different from pvForecast's
  // _pvMsUntilLocalTime, which returns 0 once passed — a charging deadline instead
  // rolls over to the next day, so this is computed independently rather than composed
  // from that 0-when-passed value.)
  _priceMsUntilDeadline(nowMs, tz, hhmm) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const targetSecs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    let h = get('hour'); if (h === 24) h = 0;
    const nowSecs = h * 3600 + get('minute') * 60 + get('second');
    let diffSecs = targetSecs - nowSecs;
    if (diffSecs <= 0) diffSecs += 86400; // already passed today → next occurrence is tomorrow
    return diffSecs * 1000;
  },

  // Pure: pick slots to cover `hoursNeeded` of charging before the slots' horizon ends.
  // `precondition` (hours) is always included from the END of the horizon regardless of
  // price — a robustness margin in case the forecast/estimate is optimistic. Among the
  // remaining candidates, cheaper slots win; ties prefer the LATER slot (keeps the
  // battery/car topped up for less time, and preserves flexibility for a cheaper slot
  // that might still appear) — same heuristic evcc's planner uses.
  // Returns a Set of selected slot start times (ms).
  _priceSelectCheapestSlots(slots, hoursNeeded, precondition = 0) {
    const selected = new Set();
    if (!Array.isArray(slots) || !slots.length || hoursNeeded <= 0) return selected;

    const sorted = [...slots].sort((a, b) => a.start - b.start);
    let remaining = hoursNeeded;

    if (precondition > 0) {
      let need = precondition;
      for (let i = sorted.length - 1; i >= 0 && need > 0; i--) {
        selected.add(sorted[i].start);
        need -= PRICE_SLOT_HOURS;
        remaining -= PRICE_SLOT_HOURS;
      }
    }
    remaining = Math.max(0, remaining);
    if (remaining <= 0) return selected;

    const candidates = sorted
      .filter((s) => !selected.has(s.start))
      .sort((a, b) => (a.price - b.price) || (b.start - a.start)); // cheapest first, later wins ties

    for (const s of candidates) {
      if (remaining <= 0) break;
      selected.add(s.start);
      remaining -= PRICE_SLOT_HOURS;
    }
    return selected;
  },

  // Pure: is the slot covering nowMs part of the selected set?
  _priceSlotSelectedNow(selected, slots, nowMs) {
    const cur = slots.find((s) => s.start <= nowMs && nowMs < s.end);
    return !!(cur && selected.has(cur.start));
  },

  // Pure: mirror of _priceSelectCheapestSlots for the home-battery discharge reserve —
  // picks the `hoursNeeded` most EXPENSIVE slots (discharge is prioritised/allowed only
  // during these; held back otherwise so capacity survives for the actual price peak).
  // Ties prefer the EARLIER slot — the opposite of the charge tie-break — so the
  // reserve favours claiming the peak as soon as it's identified rather than waiting.
  _priceSelectExpensiveSlots(slots, hoursNeeded) {
    const selected = new Set();
    if (!Array.isArray(slots) || !slots.length || hoursNeeded <= 0) return selected;
    const candidates = [...slots].sort((a, b) => (b.price - a.price) || (a.start - b.start));
    let remaining = hoursNeeded;
    for (const s of candidates) {
      if (remaining <= 0) break;
      selected.add(s.start);
      remaining -= PRICE_SLOT_HOURS;
    }
    return selected;
  },

  // Home-battery price control (evcc-style "battery grid charge" + peak-hour reserve).
  // Two independent decisions per battery, each opt-in via its own config on the
  // battery entry (cfg.battery_devices[]):
  //   charge — grid-charge to `price_target_soc` by `price_charge_by`, using the
  //            cheapest slots before that deadline (same algorithm as EV D10 charging,
  //            just without netting off solar — the battery already gets solar directly
  //            from the inverter, this is only about topping up from the grid when cheap).
  //   hold   — reserve discharge for the `price_discharge_reserve_hours` most expensive
  //            upcoming hours; outside those, block discharge so the battery doesn't
  //            drain during merely-average prices and miss the real peak.
  // Returns { mode: 'charge'|'hold'|'normal', reason }. 'normal' is the safe default —
  // whenever anything is unconfigured, stale, or unknown, this changes nothing.
  _batteryPriceMode(bd, socNow, cfg, nowMs = Date.now()) {
    if (!bd || !bd.price_charge_enabled) return { mode: 'normal', reason: 'price control disabled for this battery' };
    if (socNow === null) return { mode: 'normal', reason: 'battery SoC unknown' };
    if (this._priceForecastStale(nowMs)) return { mode: 'normal', reason: 'no price forecast — default battery behaviour' };

    const tz            = this.homey?.clock?.getTimezone?.() || 'UTC';
    const targetSoc      = Number(bd.price_target_soc ?? 90);
    const chargeByHHMM   = bd.price_charge_by || '06:00';
    const chargePowerW   = Number(bd.price_charge_power_kw ?? 3) * 1000;
    const capacityKwh    = Number(bd.capacity_kwh) || 0;

    if (socNow < targetSoc && capacityKwh > 0 && chargePowerW > 0) {
      const untilDeadlineMs = this._priceMsUntilDeadline(nowMs, tz, chargeByHHMM);
      if (untilDeadlineMs !== null) {
        const deadlineMs   = nowMs + untilDeadlineMs;
        const neededKwh    = ((targetSoc - socNow) / 100) * capacityKwh;
        const hoursNeeded  = (neededKwh * 1000) / chargePowerW;
        const chargeSlots  = this._priceSlotsBetween(nowMs, deadlineMs);
        if (chargeSlots.length) {
          const selected = this._priceSelectCheapestSlots(chargeSlots, hoursNeeded, 0);
          if (this._priceSlotSelectedNow(selected, chargeSlots, nowMs)) {
            return { mode: 'charge', reason: 'in a selected cheap slot before charge-by deadline' };
          }
        }
      }
    }

    const reserveHours = Number(bd.price_discharge_reserve_hours ?? 0);
    if (reserveHours > 0) {
      const horizonMs      = nowMs + 24 * 3600_000;
      const reserveSlots   = this._priceSlotsBetween(nowMs, horizonMs);
      if (reserveSlots.length) {
        const selected = this._priceSelectExpensiveSlots(reserveSlots, reserveHours);
        if (!this._priceSlotSelectedNow(selected, reserveSlots, nowMs)) {
          return { mode: 'hold', reason: 'reserving capacity for the most expensive upcoming hours' };
        }
        return { mode: 'normal', reason: 'in a top-expensive slot — discharge allowed' };
      }
    }

    return { mode: 'normal', reason: 'nothing to do' };
  },

  // The D10 decision: should THIS charger (serving `car`) charge from the grid right
  // now to meet the car's deadline? Nets off the Solcast PV forecast first — grid
  // charging is only planned for what solar won't cover.
  _priceShouldChargeNow(car, chargerPowerW, cfg, nowMs = Date.now()) {
    if (!car || !car.readyBy || !car.capacityKwh) {
      return { shouldCharge: false, reason: 'no deadline/capacity configured for this car' };
    }
    if (car.soc === null || car.target === null) {
      return { shouldCharge: false, reason: 'car SoC/target unknown' };
    }
    if (car.soc >= car.target) {
      return { shouldCharge: false, reason: 'target already reached' };
    }

    const tz = this.homey?.clock?.getTimezone?.() || 'UTC';
    const untilDeadlineMs = this._priceMsUntilDeadline(nowMs, tz, car.readyBy);
    if (untilDeadlineMs === null) {
      return { shouldCharge: false, reason: 'invalid deadline time' };
    }
    const deadlineMs = nowMs + untilDeadlineMs;

    const neededKwh = Math.max(0, ((car.target - car.soc) / 100) * car.capacityKwh);
    const solarKwh  = this._pvForecastStale(nowMs) ? 0 : this._pvSumKwh(this._pvForecast, nowMs, deadlineMs);
    const netNeededKwh = Math.max(0, neededKwh - solarKwh);

    if (netNeededKwh <= 0) {
      return { shouldCharge: false, reason: 'solar forecast covers the remaining need', neededKwh, solarKwh, netNeededKwh: 0 };
    }

    if (chargerPowerW <= 0) return { shouldCharge: false, reason: 'no charger power available' };
    const hoursNeeded = (netNeededKwh * 1000) / chargerPowerW;

    if (this._priceForecastStale(nowMs)) {
      // No usable price data — fail safe: charge continuously so the deadline is met.
      return { shouldCharge: true, reason: 'no price forecast — charging continuously to meet deadline', neededKwh, solarKwh, netNeededKwh, hoursNeeded };
    }

    const slots = this._priceSlotsBetween(nowMs, deadlineMs);
    if (!slots.length) {
      return { shouldCharge: true, reason: 'no price slots before deadline — charging continuously', neededKwh, solarKwh, netNeededKwh, hoursNeeded };
    }

    const precondition = Number(cfg.price_ev_precondition_h ?? 0.5);
    const selected = this._priceSelectCheapestSlots(slots, hoursNeeded, precondition);
    const shouldCharge = this._priceSlotSelectedNow(selected, slots, nowMs);

    return { shouldCharge, reason: shouldCharge ? 'in a selected cheap slot' : 'waiting for a cheaper slot', neededKwh, solarKwh, netNeededKwh, hoursNeeded };
  },

  // Full payload for the API route (summary + raw slots) — read by /ems/price-forecast.
  getPriceForecast() {
    return { ...this._priceForecastSummary(), slots: this._priceForecast || [] };
  },

  // Compact status for diagnostics.
  _priceForecastSummary(nowMs = Date.now()) {
    const slots = this._priceForecast || [];
    const future = slots.filter((s) => s.end > nowMs);
    return {
      configured: slots.length > 0,
      stale:      this._priceForecastStale(nowMs),
      updatedAt:  this._priceForecastUpdatedAt || null,
      ageMin:     this._priceForecastUpdatedAt ? Math.round((nowMs - this._priceForecastUpdatedAt) / 60000) : null,
      slotCount:  future.length,
      nowPrice:   (() => { const s = future.find((x) => x.start <= nowMs && nowMs < x.end); return s ? s.price : null; })(),
    };
  },

};
