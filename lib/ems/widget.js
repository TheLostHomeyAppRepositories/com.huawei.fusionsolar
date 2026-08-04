'use strict';

// Backend support for the ems-device and ems-battery dashboard widgets. Mixed
// into EmsDevice.prototype; `this` is the device instance. Keeps all
// widget-facing read/write logic in one place, separate from the tick loop
// itself (widgets/ems-device/api.js and widgets/ems-battery/api.js call these).

const CHARGE_MODES = ['solar', 'solar_offpeak', 'solar_lowtariff', 'solar_price', 'always'];

// kind → { cfgKey: where the device lives in ems_config, stateKey: this[stateKey]
// is the Map tracking its on/off bookkeeping (see simpleDevices.js) }
const SIMPLE_KIND = {
  heat_pump:    { cfgKey: 'heat_pump_devices',    stateKey: '_heatPumpStates' },
  boiler:       { cfgKey: 'boiler_devices',       stateKey: '_boilerStates' },
  pool:         { cfgKey: 'pool_devices',         stateKey: '_poolStates' },
  dehumidifier: { cfgKey: 'dehumidifier_devices', stateKey: '_dehumidifierStates' },
};

module.exports = {

  // ── Daily energy/runtime tracking for simple devices (heat pump/boiler/pool/
  // dehumidifier) — these don't have a "plug in → unplug" session like EV
  // chargers, so we accumulate per calendar day instead (reset at local
  // midnight), mirroring how evcc resets heating-device sessions daily.
  // In-memory only (not persisted to store) — an app restart resets today's
  // counter, which is an acceptable tradeoff for a "today so far" widget stat.
  // Called once per device-type per tick from device.js _tickBody, right next
  // to _trackChargeSession.
  _trackSimpleDeviceDaily(devices, stateMap, dtMs) {
    if (!this._simpleDailyStats) this._simpleDailyStats = {};
    const dateStr = this._localDateStr();
    for (const d of devices) {
      const st = stateMap.get(d.id);
      if (!st) continue;
      let rec = this._simpleDailyStats[d.id];
      if (!rec || rec.date !== dateStr) rec = this._simpleDailyStats[d.id] = { date: dateStr, kwh: 0, runtimeMs: 0 };
      if (st.isOn) {
        rec.runtimeMs += dtMs;
        if (d.powerW != null && d.powerW > 0) rec.kwh += (d.powerW / 1000) * (dtMs / 3600_000);
      }
    }
  },

  // Today's accumulated stats for one simple device (0/0 if none yet today).
  _simpleDeviceDaily(id) {
    const rec = (this._simpleDailyStats || {})[id];
    if (!rec || rec.date !== this._localDateStr()) return { kwh: 0, runtimeMs: 0 };
    return { kwh: Math.round(rec.kwh * 100) / 100, runtimeMs: rec.runtimeMs };
  },

  // Local (Homey timezone) calendar date as "YYYY-MM-DD" — used to detect the
  // midnight rollover for daily stats. Node itself always runs UTC on Homey Pro.
  _localDateStr() {
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._dailyFmt || this._dailyFmtTz !== tz) {
      this._dailyFmt   = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      this._dailyFmtTz = tz;
    }
    return this._dailyFmt.format(new Date());
  },

  // ── Device listing (widget settings autocomplete picker) ────────────────
  // Every EV charger and every simple device (heat pump/boiler/pool/dehumidifier)
  // configured on this EMS, with its real Homey device name resolved via the
  // local API where possible (config only stores the raw device id).
  async getEmsControllableDevices() {
    const cfg = this._getConfig();
    let names = {};
    try {
      const all = await this._api.getDevices();
      for (const d of Object.values(all || {})) if (d && d.id) names[d.id] = d.name;
    } catch (e) { /* homey_api_key not set / API unreachable — fall back to short id below */ }
    const nameFor = (id) => names[id] || `${String(id).slice(0, 8)}…`;

    const out = [];
    for (const c of (cfg.chargers || []))
      if (c.id) out.push({ id: c.id, kind: 'charger', name: nameFor(c.id) });
    for (const [kind, { cfgKey }] of Object.entries(SIMPLE_KIND))
      for (const c of (cfg[cfgKey] || []))
        if (c.id) out.push({ id: c.id, kind, name: nameFor(c.id) });
    return out;
  },

  // Finds which list (and raw config entry) a controllable-device id belongs
  // to. Returns null if the id is no longer configured (e.g. removed since the
  // widget was set up).
  _findControllable(cfg, id) {
    const chg = (cfg.chargers || []).find((c) => c.id === id);
    if (chg) return { kind: 'charger', entry: chg };
    for (const [kind, { cfgKey }] of Object.entries(SIMPLE_KIND)) {
      const entry = (cfg[cfgKey] || []).find((c) => c.id === id);
      if (entry) return { kind, entry };
    }
    return null;
  },

  // ── Live status for one controllable device (widget polling, ~5s) ───────
  async getEmsControllableStatus(id) {
    const cfg   = this._getConfig();
    const found = this._findControllable(cfg, id);
    if (!found) return { error: 'not_found' };
    const { kind, entry } = found;

    let name = `${String(id).slice(0, 8)}…`;
    try {
      const dev = await this._api.getDevice(id);
      if (dev && dev.name) name = dev.name;
    } catch (e) { /* ignore — id-derived fallback above stays */ }

    if (kind === 'charger') {
      const [charger] = await this._getChargers({ ...cfg, chargers: [entry] });
      const st  = this._getChargerState(id);
      const car = this._carForCharger(charger);
      return {
        kind, id, name,
        connected:  charger.connected,
        powerW:     charger.powerW,
        chargeMode: charger.chargeMode,
        carName:    car ? car.name : null,
        carSoc:     car ? car.soc : null,
        carTarget:  car ? car.target : null,
        sessionEnergyKwh:  st.sessionActive ? Math.round((st.sessionEnergyKwh || 0) * 100) / 100 : 0,
        sessionStartedAt:  st.sessionActive ? st.sessionStartedAt : null,
      };
    }

    const { cfgKey, stateKey } = SIMPLE_KIND[kind];
    const [device] = await this._getSimpleDevices(cfgKey, { [cfgKey]: [entry] });
    const stateMap = this[stateKey];
    const st     = stateMap ? stateMap.get(id) : null;
    const daily  = this._simpleDeviceDaily(id);
    return {
      kind, id, name,
      isOn:           !!(st && st.isOn),
      powerW:         device.powerW,
      minSurplusW:    device.minSurplusW,
      todayKwh:       daily.kwh,
      runtimeMs:      (st && st.isOn && st.startedAt) ? (Date.now() - st.startedAt) : 0,
      todayRuntimeMs: daily.runtimeMs,
    };
  },

  // ── Writers — patch one field on one configured device, persist, restart ─
  // the tick loop so the change takes effect immediately (same pattern as
  // onConfigChanged for a full settings save).
  async setEmsChargerMode(id, mode) {
    if (!CHARGE_MODES.includes(mode)) return { error: 'invalid_mode' };
    const cfg   = this._getConfig();
    const entry = (cfg.chargers || []).find((c) => c.id === id);
    if (!entry) return { error: 'not_found' };
    entry.charge_mode = mode;
    this.homey.settings.set('ems_config', cfg);
    this._stopTick(); this._startTick();
    return { ok: true };
  },

  async setEmsSimpleDeviceMinSurplus(id, watts) {
    const cfg   = this._getConfig();
    const found = this._findControllable(cfg, id);
    if (!found || found.kind === 'charger') return { error: 'not_found' };
    found.entry.min_surplus_w = Math.max(0, Number(watts) || 0);
    this.homey.settings.set('ems_config', cfg);
    this._stopTick(); this._startTick();
    return { ok: true };
  },

  // ── Battery widget — aggregate view, no per-device picker needed (the SOC
  // zone settings are already global, same as the settings page) ──────────
  async getEmsBatteryStatus() {
    const cfg     = this._getConfig();
    const battery = await this._getBattery(cfg);
    const zones   = this._batteryZones(cfg, battery);
    const devices = cfg.battery_devices || [];
    const priceEnabled = devices.some((d) => d.price_charge_enabled);
    let priceMode = null;
    if (priceEnabled) {
      for (const d of devices) {
        const st = this._batteryStates.get(d.id);
        if (st && st.priceMode && st.priceMode !== 'normal') { priceMode = st.priceMode; break; }
      }
    }
    // Usable capacity (cfg.battery_devices[i].capacity_kwh, same field the adaptive
    // solar-forecast gate uses) summed across batteries → absolute kWh alongside the
    // % SoC, e.g. "8.7 of 13.4 kWh".
    const capacityKwh = devices.reduce((s, d) => s + (Number(d.capacity_kwh) || 0), 0);
    const energyKwh = (capacityKwh > 0 && battery.soc != null)
      ? Math.round(capacityKwh * battery.soc / 100 * 10) / 10
      : null;
    return {
      hasBattery: devices.length > 0,
      soc: battery.soc, powerW: battery.powerW,
      capacityKwh: capacityKwh > 0 ? Math.round(capacityKwh * 10) / 10 : null,
      energyKwh,
      normalSoc: zones.minSoc, reserveSoc: zones.hasLowZone ? zones.minSocLow : null,
      zone: zones.batHardStop ? 'red' : zones.batReserve ? 'orange' : 'green',
      priceEnabled, priceMode,
    };
  },

  async setEmsBatteryZones({ normalSoc, reserveSoc }) {
    const cfg = this._getConfig();
    if (normalSoc  !== undefined && normalSoc  !== null) cfg.min_battery_soc     = Math.max(0, Math.min(100, Number(normalSoc)  || 0));
    if (reserveSoc !== undefined && reserveSoc !== null) cfg.min_battery_soc_low = Math.max(0, Math.min(100, Number(reserveSoc) || 0));
    if (this._validateConfig(cfg)) { /* clamped further — cfg already the object to persist */ }
    this.homey.settings.set('ems_config', cfg);
    this._stopTick(); this._startTick();
    return { ok: true };
  },

};
