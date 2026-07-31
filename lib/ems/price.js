'use strict';

// Electricity price, scheduled-flow tasks and the off-peak window. Mixed into
// EmsDevice.prototype; `this` is the device instance. See device.js.
module.exports = {

  async _checkScheduler(cfg) {
    const tasks = Array.isArray(cfg.scheduled_tasks) ? cfg.scheduled_tasks : [];
    if (!tasks.length) return;
    // Wall-clock time in the Homey timezone — Node runs UTC on Homey Pro, so
    // getHours()/getDay() would fire tasks 1–2 h off (same pattern as _offpeakWindow).
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._schedFmt || this._schedFmtTz !== tz) {
      this._schedFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._schedFmtTz = tz;
    }
    const now        = new Date();
    const parts      = Object.fromEntries(this._schedFmt.formatToParts(now).map((p) => [p.type, p.value]));
    const dayOfWeek  = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday] ?? now.getDay();
    const timeStr    = `${parts.hour}:${parts.minute}`;
    for (const task of tasks) {
      if (!task.enabled || !task.flow_id || task.time !== timeStr) continue;
      const lastFired = this._schedulerFired.get(task.id);
      if (lastFired && (now - lastFired) < 60_000) continue; // already fired this minute
      const shouldFire = task.type === 'daily' ||
        (task.type === 'weekday' && Array.isArray(task.weekdays) && task.weekdays.includes(dayOfWeek));
      if (!shouldFire) continue;
      this._schedulerFired.set(task.id, now);
      this.log(`[EMS] Scheduler: "${task.name}" → flow ${task.flow_id}`);
      this._api.triggerFlow(task.flow_id).catch((err) =>
        this.error(`[EMS] Scheduler: "${task.name}" trigger failed: ${err.message}`));
    }
  },

  // Local wall-clock parts in the Homey timezone (Node runs UTC on Homey Pro).
  _priceWallClock() {
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._priceFmt || this._priceFmtTz !== tz) {
      this._priceFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._priceFmtTz = tz;
    }
    const parts     = Object.fromEntries(this._priceFmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const dayOfWeek = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday] ?? new Date().getDay();
    const minutes   = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    return { dayOfWeek, minutes };
  },

  // Returns the current price per kWh (number) or null when unknown.
  //   fixed    → price_fixed
  //   dual     → high_windows[today] decides high vs low (cross-midnight supported)
  //   variable → last value set via the ems_set_electricity_price flow
  //   forecast → current slot of the price forecast (D10), fed via ems_set_price_forecast
  _getCurrentPrice(cfg) {
    const pc   = cfg.price_config || {};
    const mode = pc.mode || 'fixed';
    if (mode === 'variable') return typeof this._variablePrice === 'number' ? this._variablePrice : null;
    if (mode === 'forecast') {
      const fc = this._priceForecastSummary ? this._priceForecastSummary() : null;
      return (fc && !fc.stale && typeof fc.nowPrice === 'number') ? fc.nowPrice : null;
    }
    if (mode === 'fixed')    return Number(pc.price_fixed) || 0;
    // dual tariff
    const { isHigh } = this._dualTariffWindow(cfg);
    return isHigh ? (Number(pc.price_high) || 0) : (Number(pc.price_low) || 0);
  },

  // Whether the dual ("Low / high tariff") price window is currently in its HIGH
  // period, and whether a dual schedule is actually configured at all (mode==='dual'
  // with at least one weekday window set) — used both for the displayed price above
  // and by chargers in "Solar & low tariff" mode (chargerControl.js) to know when to
  // charge, independent of the separate fixed Off-Peak Charging schedule.
  _dualTariffWindow(cfg) {
    const pc = cfg.price_config || {};
    const windows = pc.high_windows || {};
    const configured = pc.mode === 'dual' && Object.values(windows).some((w) => w && w.start && w.end);
    const { dayOfWeek, minutes } = this._priceWallClock();
    const win = windows[dayOfWeek] || windows[String(dayOfWeek)];
    let isHigh = false;
    if (win && win.start && win.end) {
      const s = this._parseTime(win.start);
      const e = this._parseTime(win.end);
      if (s !== null && e !== null) isHigh = s > e ? (minutes >= s || minutes < e) : (minutes >= s && minutes < e);
    }
    return { configured, isHigh };
  },

  // Sets the capability's unit label to "<currency>/kWh" (best-effort).
  async _applyPriceCurrencyUnit(cfg) {
    const currency = (cfg.price_config && cfg.price_config.currency) || 'CHF';
    if (this._priceUnitApplied === currency) return;
    this._priceUnitApplied = currency;
    try { await this.setCapabilityOptions('measure_electricity_price', { units: `${currency}/kWh` }); }
    catch (e) { /* older Homey without runtime options — value still shows */ }
  },

  async _updatePriceCapability(cfg) {
    const price = this._getCurrentPrice(cfg);
    if (price === null) return;
    const rounded = Math.round(price * 1000) / 1000;
    if (rounded !== this._lastPriceFired) {
      this._lastPriceFired = rounded;
      await this._set('measure_electricity_price', rounded);
    }
  },

  // Returns { active: bool, amps: number } for the current off-peak window.
  // Supports separate weekday vs weekend windows; timezone-aware via Homey clock.
  _offpeakWindow(cfg) {
    const tz  = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._offpeakFmt || this._offpeakFmtTz !== tz) {
      this._offpeakFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._offpeakFmtTz = tz;
    }
    const fmt = this._offpeakFmt;
    const parts  = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const t      = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
    const useWeekend = cfg.offpeak_weekend_differs === true && isWeekend;

    const startKey = useWeekend ? 'offpeak_weekend_start' : 'offpeak_start';
    const endKey   = useWeekend ? 'offpeak_weekend_end'   : 'offpeak_end';
    const s = this._parseTime(cfg[startKey] || '22:00');
    const e = this._parseTime(cfg[endKey]   || '06:00');
    if (s === null || e === null) return { active: false, amps: 16 };

    const active = s > e ? (t >= s || t < e) : (t >= s && t < e);
    return { active, amps: parseInt(cfg.offpeak_amps ?? 16, 10) };
  },

  _parseTime(str) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str ?? '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  },

};
