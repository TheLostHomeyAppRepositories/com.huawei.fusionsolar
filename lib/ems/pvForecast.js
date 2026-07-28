'use strict';

// Solcast PV forecast (Hobbyist rooftop tier). Mixed into EmsDevice.prototype;
// `this` is the device instance. Fetches the rooftop-site forecast, caches it and
// exposes aggregate helpers. NOTHING here drives control decisions yet — it is a
// pure data feed for the dashboard / diagnostics and for future price/deadline
// charging (D10) and solar-aware planning (D16).
//
// Rate limits: Solcast's free Hobbyist tier allows ~10 calls/day. We fetch at most
// every PV_FORECAST_MIN_INTERVAL_MS and persist the last fetch time to the device
// store, so frequent app restarts (e.g. during `homey app run`) cannot burn the
// daily budget. On error / HTTP 429 we back off for PV_FORECAST_BACKOFF_MS.

const https = require('https');
const {
  SOLCAST_BASE_URL, PV_FORECAST_MIN_INTERVAL_MS, PV_FORECAST_BACKOFF_MS, PV_FORECAST_TIMEOUT_MS,
  PV_FORECAST_STALE_MS,
} = require('./constants');

module.exports = {

  // Restore the cached forecast + last-fetch time on startup so a restart neither
  // re-fetches immediately (rate-limit) nor loses the current forecast.
  async _restorePvForecast() {
    this._pvForecast          = null;   // [{ end:<ms>, kw, kw10, kw90, h }] ascending, or null
    this._pvForecastFetchedAt = null;   // ms of last successful fetch
    this._pvForecastBackoffUntil = 0;   // ms; skip fetching until then
    this._pvForecastError     = null;   // last error string, or null
    this._pvForecastLoggedErr = false;  // one-shot error log guard
    try {
      const stored = await this.getStoreValue('pvForecast');
      if (stored && Array.isArray(stored.slots)) {
        this._pvForecast          = stored.slots;
        this._pvForecastFetchedAt = stored.fetchedAt || null;
      }
    } catch (e) { /* ignore */ }
  },

  // Called on the slow tick. Decides whether a fetch is due and, if so, performs it.
  // Never throws — all failures are captured in `_pvForecastError`.
  async _maybeFetchPvForecast(cfg) {
    if (!cfg || cfg.pv_forecast_enabled !== true) return;
    const apiKey = (cfg.solcast_api_key || '').trim();
    const ids    = this._solcastResourceIds(cfg);
    if (!apiKey || !ids.length) return;

    const now = Date.now();
    if (now < this._pvForecastBackoffUntil) return;
    // Each site is a separate API call, so scale the minimum interval by the number of
    // sites — keeps the total within the free-tier budget (~8 calls/day) no matter how
    // many rooftops (e.g. north + south) are configured.
    const minInterval = PV_FORECAST_MIN_INTERVAL_MS * ids.length;
    if (this._pvForecastFetchedAt && (now - this._pvForecastFetchedAt) < minInterval) return;

    try {
      // Fetch every site; each catches its own error so one bad site can't sink the rest.
      const results = await Promise.all(ids.map((id) => this._solcastGet(id, apiKey)
        .then((json) => ({ ok: true, slots: this._parseSolcastForecasts(json) }))
        .catch((e) => ({ ok: false, err: e.message }))));

      const good = results.filter((r) => r.ok && r.slots.length);
      if (!good.length) throw new Error(results.find((r) => !r.ok)?.err || 'empty / unparseable forecast response');

      const slots  = this._mergeForecastSlots(good.map((r) => r.slots)); // per-slot sum across sites
      const failed = ids.length - good.length;
      this._pvForecast          = slots;
      this._pvForecastFetchedAt = now;
      this._pvForecastError     = failed ? `${failed} of ${ids.length} sites failed` : null;
      this._pvForecastLoggedErr = false;
      await this.setStoreValue('pvForecast', { slots, fetchedAt: now }).catch(() => {});
      this.log(`[EMS] PV forecast updated: ${good.length}/${ids.length} site(s), ${slots.length} slots, remaining today ≈ ${this._pvForecastRemainingTodayKwh().toFixed(1)} kWh`);
      const s = this._pvForecastSummary(now);
      this.homey.flow.getDeviceTriggerCard('ems_pv_forecast_updated')
        .trigger(this, { remaining_today_kwh: s.remainingTodayKwh, next_6h_kwh: s.next6hKwh, peak_kw: s.peakKw ?? 0 })
        .catch((e) => this.log(`[EMS] pv_forecast_updated trigger failed: ${e.message}`));
    } catch (e) {
      this._pvForecastError = e.message;
      this._pvForecastBackoffUntil = now + PV_FORECAST_BACKOFF_MS;
      if (!this._pvForecastLoggedErr) {
        this.log(`[EMS] PV forecast fetch failed (backing off ${Math.round(PV_FORECAST_BACKOFF_MS / 3600000)} h): ${e.message}`);
        this._pvForecastLoggedErr = true;
      }
    }
  },

  // Parse the config's resource-id field into a list. Accepts a single id or several
  // separated by comma / semicolon / whitespace / newline (north + south roof, etc.).
  _solcastResourceIds(cfg) {
    return String((cfg && cfg.solcast_resource_id) || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  },

  // Pure: sum several parsed forecasts into one, aligned by slot end-time. Solcast uses
  // the same 30-min UTC grid for every site, so grouping by `end` lines them up. kw is
  // summed; the P10/P90 band is summed only where present on all sites, else null.
  _mergeForecastSlots(arrays) {
    if (arrays.length === 1) return arrays[0];
    const byEnd = new Map();
    for (const arr of arrays) {
      for (const s of arr) {
        const cur = byEnd.get(s.end);
        if (!cur) {
          byEnd.set(s.end, { end: s.end, kw: s.kw, kw10: s.kw10, kw90: s.kw90, h: s.h });
        } else {
          cur.kw  += s.kw;
          cur.kw10 = (cur.kw10 != null && s.kw10 != null) ? cur.kw10 + s.kw10 : null;
          cur.kw90 = (cur.kw90 != null && s.kw90 != null) ? cur.kw90 + s.kw90 : null;
        }
      }
    }
    return [...byEnd.values()].sort((a, b) => a.end - b.end);
  },

  // Raw HTTPS GET to the Solcast rooftop-site forecast endpoint (node https to match
  // lib/openapi-client.js style). Resolves the parsed JSON or rejects with a tagged error.
  _solcastGet(resourceId, apiKey) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/rooftop_sites/${encodeURIComponent(resourceId)}/forecasts`, SOLCAST_BASE_URL);
      url.searchParams.set('format', 'json');
      url.searchParams.set('api_key', apiKey);
      const options = {
        hostname: url.hostname,
        port:     443,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { Accept: 'application/json', 'User-Agent': 'Homey/FusionSolar-EMS' },
        timeout:  PV_FORECAST_TIMEOUT_MS,
      };
      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode === 429) return reject(new Error('HTTP 429 rate limited (Solcast daily quota)'));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 120).replace(/\s+/g, ' ').trim()}`));
          }
          try { resolve(JSON.parse(raw)); }
          catch (err) { reject(new Error(`invalid JSON: ${err.message}`)); }
        });
      });
      req.on('error',   (err) => reject(new Error(`network error: ${err.message}`)));
      req.on('timeout', ()    => { req.destroy(); reject(new Error('request timed out')); });
      req.end();
    });
  },

  // Pure: Solcast `{ forecasts: [...] }` → ascending [{ end:<ms>, kw, kw10, kw90, h }].
  // `pv_estimate*` are average AC power (kW) over the interval; `period` is an ISO-8601
  // duration (e.g. "PT30M"); `period_end` is the ISO timestamp at the end of the slot.
  _parseSolcastForecasts(json) {
    const list = json && Array.isArray(json.forecasts) ? json.forecasts : [];
    const out = [];
    for (const f of list) {
      const end = Date.parse(f.period_end);
      const kw  = Number(f.pv_estimate);
      if (!Number.isFinite(end) || !Number.isFinite(kw)) continue;
      out.push({
        end,
        kw,
        kw10: Number.isFinite(Number(f.pv_estimate10)) ? Number(f.pv_estimate10) : null,
        kw90: Number.isFinite(Number(f.pv_estimate90)) ? Number(f.pv_estimate90) : null,
        h:    this._pvPeriodHours(f.period),
      });
    }
    out.sort((a, b) => a.end - b.end);
    return out;
  },

  // Pure: ISO-8601 duration "PT30M" / "PT1H" → hours (default 0.5 h).
  _pvPeriodHours(period) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(period || '');
    if (!m) return 0.5;
    const h = (parseInt(m[1], 10) || 0) + (parseInt(m[2], 10) || 0) / 60;
    return h > 0 ? h : 0.5;
  },

  // Pure: expected energy (kWh) from forecast slots whose end falls in (fromMs, toMs].
  _pvSumKwh(slots, fromMs, toMs) {
    if (!Array.isArray(slots)) return 0;
    let kwh = 0;
    for (const s of slots) {
      if (s.end > fromMs && s.end <= toMs) kwh += s.kw * s.h;
    }
    return kwh;
  },

  // Pure: ms remaining until the next local midnight in the given timezone.
  _pvMsUntilLocalMidnight(nowMs, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(nowMs));
      const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
      let h = get('hour'); if (h === 24) h = 0;
      const secsIntoDay = h * 3600 + get('minute') * 60 + get('second');
      return (86400 - secsIntoDay) * 1000;
    } catch (e) {
      return 0;
    }
  },

  // The forecast is "stale" when there is none, or the last successful fetch is older than
  // PV_FORECAST_STALE_MS (fetches have been failing for a long time). While stale the
  // aggregation helpers all return 0, so flow conditions stay conservative and the device
  // capabilities read as unknown rather than showing confident but outdated numbers.
  _pvForecastStale(nowMs = Date.now()) {
    return !this._pvForecast
      || !this._pvForecastFetchedAt
      || (nowMs - this._pvForecastFetchedAt) > PV_FORECAST_STALE_MS;
  },

  // Expected PV energy (kWh) from now until local midnight tonight.
  _pvForecastRemainingTodayKwh(nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const tz  = this.homey?.clock?.getTimezone?.() || 'UTC';
    const end = nowMs + this._pvMsUntilLocalMidnight(nowMs, tz);
    return this._pvSumKwh(this._pvForecast, nowMs, end);
  },

  // Expected PV energy (kWh) over the next `hours` hours.
  _pvForecastNextKwh(hours, nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    return this._pvSumKwh(this._pvForecast, nowMs, nowMs + hours * 3600_000);
  },

  // Pure: ms from nowMs until the local wall-clock time HH:MM today, in the given
  // timezone. 0 if the time has already passed today (or the input is invalid).
  _pvMsUntilLocalTime(nowMs, tz, cutoff) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(cutoff || '').trim());
    if (!m) return 0;
    const targetSecs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(nowMs));
      const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
      let h = get('hour'); if (h === 24) h = 0;
      const nowSecs = h * 3600 + get('minute') * 60 + get('second');
      const diff = targetSecs - nowSecs;
      return diff > 0 ? diff * 1000 : 0;
    } catch (e) {
      return 0;
    }
  },

  // Expected PV energy (kWh) from now until the given local time HH:MM today.
  // Returns 0 once that cutoff has passed for the day.
  _pvForecastUntilKwh(cutoff, nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const tz = this.homey?.clock?.getTimezone?.() || 'UTC';
    const ms = this._pvMsUntilLocalTime(nowMs, tz, cutoff);
    if (ms <= 0) return 0;
    return this._pvSumKwh(this._pvForecast, nowMs, nowMs + ms);
  },

  // Expected PV energy (kWh) over the whole next local calendar day (tomorrow).
  _pvForecastTomorrowKwh(nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const tz   = this.homey?.clock?.getTimezone?.() || 'UTC';
    const from = nowMs + this._pvMsUntilLocalMidnight(nowMs, tz); // next local midnight
    return this._pvSumKwh(this._pvForecast, from, from + 24 * 3600_000);
  },

  // Forecast power (kW) for the slot currently in progress (first slot ending after now).
  _pvForecastNowKw(nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const s = this._pvForecast.find((x) => x.end > nowMs);
    return s ? s.kw : 0;
  },

  // Solcast is "configured" only when enabled with an API key and at least one site.
  _pvForecastConfigured(cfg) {
    return !!(cfg && cfg.pv_forecast_enabled === true
      && (cfg.solcast_api_key || '').trim()
      && this._solcastResourceIds(cfg).length);
  },

  // Add/remove the three forecast capabilities so they appear on the device only while
  // Solcast is configured. Called from onInit and onConfigChanged.
  async _syncPvForecastCapabilities(cfg) {
    const want = this._pvForecastConfigured(cfg);
    for (const c of ['pv_forecast_today', 'pv_forecast_tomorrow', 'pv_forecast_now']) {
      try {
        if (want && !this.hasCapability(c)) await this.addCapability(c);
        else if (!want && this.hasCapability(c)) await this.removeCapability(c);
      } catch (e) { this.log(`[EMS] pv cap ${c}: ${e.message}`); }
    }
  },

  // Recompute the forecast capability values from the cached slots (cheap, no API call).
  // No-op when the capabilities aren't present (Solcast not configured).
  async _updatePvForecastCapabilities(nowMs = Date.now()) {
    if (!this.hasCapability('pv_forecast_today')) return;
    // Stale forecast → show the capabilities as unknown (null) rather than a confident 0.
    const stale = this._pvForecastStale(nowMs);
    const today = stale ? null : Math.round(this._pvForecastRemainingTodayKwh(nowMs) * 10) / 10;
    const tomo  = stale ? null : Math.round(this._pvForecastTomorrowKwh(nowMs) * 10) / 10;
    const now   = stale ? null : Math.round(this._pvForecastNowKw(nowMs) * 100) / 100;
    await this.setCapabilityValue('pv_forecast_today', today).catch(() => {});
    await this.setCapabilityValue('pv_forecast_tomorrow', tomo).catch(() => {});
    await this.setCapabilityValue('pv_forecast_now', now).catch(() => {});
  },

  // Compact status used by getEmsDiag() (no per-slot array).
  _pvForecastSummary(nowMs = Date.now()) {
    const cfg        = this._getConfig();
    const enabled    = cfg.pv_forecast_enabled === true;
    const ids        = this._solcastResourceIds(cfg);
    const configured = !!(cfg.solcast_api_key && ids.length);
    const slots      = this._pvForecast || [];
    const future     = slots.filter((s) => s.end > nowMs);
    return {
      enabled,
      configured,
      stale:             this._pvForecastStale(nowMs),
      sites:             ids.length,
      fetchedAt:         this._pvForecastFetchedAt || null,
      ageMin:            this._pvForecastFetchedAt ? Math.round((nowMs - this._pvForecastFetchedAt) / 60000) : null,
      error:             this._pvForecastError || null,
      slotCount:         future.length,
      nowKw:             Math.round(this._pvForecastNowKw(nowMs) * 100) / 100,
      remainingTodayKwh: Math.round(this._pvForecastRemainingTodayKwh(nowMs) * 10) / 10,
      tomorrowKwh:       Math.round(this._pvForecastTomorrowKwh(nowMs) * 10) / 10,
      next6hKwh:         Math.round(this._pvForecastNextKwh(6, nowMs) * 10) / 10,
      peakKw:            future.length ? Math.round(Math.max(...future.map((s) => s.kw)) * 100) / 100 : null,
    };
  },

  // Full payload for the API route (summary + raw slots) — read by /ems/pv-forecast.
  getPvForecast() {
    return { ...this._pvForecastSummary(), slots: this._pvForecast || [] };
  },

};
