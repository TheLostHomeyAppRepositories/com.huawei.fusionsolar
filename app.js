'use strict';

const { App }             = require('homey');
const OpenAPICoordinator  = require('./lib/openapi-coordinator');

class FusionSolarKioskApp extends App {

  async onInit() {
    this.log('FusionSolar app is running...');

    this._coordinator = new OpenAPICoordinator(this.homey);

    this.homey.flow
      .getConditionCard('is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });

    this.homey.flow
      .getConditionCard('modbus_is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });

    this._scheduleMidnightBaseline();
    this._ensureTodayBaseline();

    // Sensor-chart: initialise in-memory rolling history after drivers are ready
    this._capHistory       = new Map();
    this._capHistoryInited = false;
    this._registerSensorChartAutocomplete();
    this.homey.setTimeout(() => this._initCapHistory(), 5000);
  }

  async onUninit() {
    this.log('FusionSolar app is stopping...');
    if (this._midnightTimer)       this.homey.clearTimeout(this._midnightTimer);
    if (this._capHistoryPollTimer) this.homey.clearInterval(this._capHistoryPollTimer);
    this._saveCapHistory(); // persist before shutdown
  }

  /**
   * Schedules a snapshot of cumulative grid counters every midnight.
   * Stored in homey.settings so the energy-balance widget can compute daily deltas.
   * Uses the Homey timezone so midnight fires at local 00:00 regardless of the
   * Node.js process timezone (which is UTC on Homey Pro).
   */
  _scheduleMidnightBaseline() {
    const msUntilMidnight = this._msUntilLocalMidnight();

    this._midnightTimer = this.homey.setTimeout(() => {
      this._saveMidnightBaseline();
      // Re-schedule for the next midnight
      this._scheduleMidnightBaseline();
    }, msUntilMidnight);

    this.log(`Midnight baseline scheduled in ${Math.round(msUntilMidnight / 60000)} min (tz: ${this._getHomeyTz()})`);
  }

  /** Returns the Homey timezone string (IANA), falling back to 'UTC'. */
  _getHomeyTz() {
    try { return this.homey.clock.getTimezone() || 'UTC'; } catch { return 'UTC'; }
  }

  /**
   * Milliseconds until 00:00:05 of the next calendar day in the Homey timezone.
   * Node.js runs UTC — we use Intl.DateTimeFormat to read the current wall-clock
   * time in the local timezone and compute the offset to the next midnight.
   */
  _msUntilLocalMidnight() {
    const tz  = this._getHomeyTz();
    const now = new Date();

    // Extract current time-of-day parts in the Homey timezone
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: tz,
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    }).formatToParts(now);

    const get = type => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    const secsElapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
    // 5-second buffer past midnight
    return (86400 - secsElapsed + 5) * 1000;
  }

  /**
   * On app start: if no baseline exists for today yet, write one now.
   * We wait 10 s to give drivers time to complete their first poll.
   */
  _ensureTodayBaseline() {
    this.homey.setTimeout(() => {
      const today = this._todayStr();
      const exportStored = (() => { try { return this.homey.settings.get('eb_grid_export_baseline'); } catch { return null; } })();
      const importStored = (() => { try { return this.homey.settings.get('eb_grid_import_baseline'); } catch { return null; } })();
      if (!exportStored || exportStored.date !== today ||
          !importStored || importStored.date !== today) {
        this.log('No baseline for today yet – writing initial baseline');
        this._saveMidnightBaseline();
      }
    }, 10000);
  }

  _saveMidnightBaseline() {
    try {
      const today = this._todayStr();
      const sun2000 = this._getDevice('sun2000_modbus');
      const pmEmma  = this._getDevice('powermeter_emma_modbus');

      const gridExport = this._cap(sun2000, 'meter_power.grid_export');
      const gridImport = this._cap(sun2000, 'meter_power.grid_import');

      if (gridExport !== null) {
        this.homey.settings.set('eb_grid_export_baseline', { date: today, baseline: gridExport });
        this.log(`Midnight baseline saved – export: ${gridExport} kWh`);
      }
      if (gridImport !== null) {
        this.homey.settings.set('eb_grid_import_baseline', { date: today, baseline: gridImport });
        this.log(`Midnight baseline saved – import: ${gridImport} kWh`);
      }
    } catch (err) {
      this.error('Failed to save midnight baseline:', err.message);
    }
  }

  _getDevice(driverId) {
    try {
      const driver  = this.homey.drivers.getDriver(driverId);
      const devices = driver.getDevices();
      return devices.length > 0 ? devices[0] : null;
    } catch { return null; }
  }

  _cap(device, id) {
    if (!device) return null;
    try { return device.getCapabilityValue(id) ?? null; } catch { return null; }
  }

  /** Returns today's date as "YYYY-MM-DD" in the Homey (local) timezone. */
  _todayStr() {
    // en-CA locale formats as YYYY-MM-DD which is exactly what we need
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this._getHomeyTz(),
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  getCoordinator() {
    return this._coordinator;
  }

  // ── Sensor-chart: capability history ──────────────────────────────────────

  /**
   * Returns true for capabilities that are meaningful to chart.
   * Limits the list to measure_*, meter_* and target_* — excludes alarm booleans,
   * status enums, module counts, etc.
   */
  /** Only the root measure_power capability — no sub-capabilities (no .pv, .grid …). */
  static _isMeaningfulCap(capId) {
    return capId === 'measure_power';
  }

  /**
   * Register autocomplete listeners for the sensor-chart widget's series1–4 settings.
   * Called once from onInit() — safe to call before any device is ready.
   */
  _registerSensorChartAutocomplete() {
    try {
      const widget = this.homey.dashboards.getWidget('sensor-chart');

      const handler = async (query) => {
        const results = [];
        try {
          const drivers = this.homey.drivers.getDrivers();
          for (const driver of Object.values(drivers)) {
            try {
              for (const device of driver.getDevices()) {
                const deviceId   = device.getData().id;
                const deviceName = device.getName();
                if (!deviceId) continue;

                for (const capId of device.getCapabilities()) {
                  if (!FusionSolarKioskApp._isMeaningfulCap(capId)) continue;
                  const val = device.getCapabilityValue(capId);
                  if (typeof val !== 'number') continue;

                  const id   = `${deviceId}::${capId}`;
                  const name = deviceName; // device name as label suggestion

                  if (!query || query.length === 0
                      || name.toLowerCase().includes(query.toLowerCase())) {
                    results.push({ id, name, description: `${fmtVal(val)} W` });
                  }
                }
              }
            } catch (e) { /* skip unavailable driver */ }
          }
        } catch (e) {
          this.error('sensor-chart autocomplete error:', e.message);
        }
        return results;
      };

      for (const s of ['series1', 'series2', 'series3', 'series4']) {
        widget.registerSettingAutocompleteListener(s, handler);
      }
      this.log('sensor-chart: autocomplete registered (series1–4)');
    } catch (e) {
      this.error('sensor-chart: autocomplete registration failed:', e.message);
    }

    /** Small inline helper — format a numeric value compactly */
    function fmtVal(v) {
      if (v === null || v === undefined) return '—';
      const a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(1) + ' kW';
      return v.toFixed(1);
    }
  }

  // Max data points kept per series in RAM and persisted to settings.
  // 1 500 pts × 60 s = 25 h; compact JSON ≈ 40 KB — well within the settings limit.
  static get CAP_HISTORY_MAX() { return 1500; }

  /**
   * Initialise rolling capability history and start the 60 s polling timer.
   * Called 5 s after app start so drivers have completed their first poll.
   * Guarded by _capHistoryInited — safe to call multiple times.
   */
  _initCapHistory() {
    if (this._capHistoryInited) return;
    this._capHistoryInited = true;

    // Restore persisted history from settings before taking the first snapshot
    this._loadCapHistory();

    // Snapshot current values immediately, then every 60 s
    this._snapshotAllCaps();
    this.log(`sensor-chart: ${this._capHistory.size} series in history`);

    this._capHistoryPollCount  = 0;
    this._capHistoryPollTimer  = this.homey.setInterval(() => {
      this._snapshotAllCaps();
      // Persist every 5 minutes (5 × 60 s ticks)
      this._capHistoryPollCount++;
      if (this._capHistoryPollCount % 5 === 0) this._saveCapHistory();
    }, 60 * 1000);
  }

  /**
   * Load persisted history from homey.settings into _capHistory.
   * Settings key format: sch_hist_<logId>
   * Stored value:        [[timestamp_ms, value], ...]
   */
  _loadCapHistory() {
    let loaded = 0;
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        try {
          for (const device of driver.getDevices()) {
            const deviceId = device.getData().id;
            if (!deviceId) continue;

            for (const capId of device.getCapabilities()) {
              if (!FusionSolarKioskApp._isMeaningfulCap(capId)) continue;

              const logId = `${deviceId}::${capId}`;
              const raw   = this.homey.settings.get(`sch_hist_${logId}`);
              if (!Array.isArray(raw) || raw.length === 0) continue;

              const points = raw.map(([t, v]) => ({ t: new Date(t).toISOString(), v }));
              this._capHistory.set(logId, points);
              loaded++;
            }
          }
        } catch (e) { /* skip */ }
      }
      if (loaded > 0) this.log(`sensor-chart: restored ${loaded} series from settings`);
    } catch (e) {
      this.error('sensor-chart: _loadCapHistory error:', e.message);
    }
  }

  /**
   * Persist all series from _capHistory to homey.settings.
   * Each series is stored as compact [[timestamp_ms, value], ...] array.
   */
  _saveCapHistory() {
    if (!this._capHistory || this._capHistory.size === 0) return;
    try {
      for (const [logId, points] of this._capHistory.entries()) {
        const compact = points.map((p) => [new Date(p.t).getTime(), Math.round(p.v * 100) / 100]);
        this.homey.settings.set(`sch_hist_${logId}`, compact);
      }
      this.log(`sensor-chart: saved ${this._capHistory.size} series to settings`);
    } catch (e) {
      this.error('sensor-chart: _saveCapHistory error:', e.message);
    }
  }

  /**
   * Snapshot the current value of every tracked capability and append it to
   * the rolling buffer.  Also auto-discovers devices added after app start.
   */
  _snapshotAllCaps() {
    if (!this._capHistory) return;
    const now = new Date().toISOString();
    const max = FusionSolarKioskApp.CAP_HISTORY_MAX;
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        try {
          for (const device of driver.getDevices()) {
            const deviceId = device.getData().id;
            if (!deviceId) continue;

            for (const capId of device.getCapabilities()) {
              if (!FusionSolarKioskApp._isMeaningfulCap(capId)) continue;
              const val = device.getCapabilityValue(capId);
              if (typeof val !== 'number') continue;

              const logId = `${deviceId}::${capId}`;
              let pts = this._capHistory.get(logId);
              if (!pts) { pts = []; this._capHistory.set(logId, pts); }

              pts.push({ t: now, v: val });
              if (pts.length > max) pts.splice(0, pts.length - max);
            }
          }
        } catch (e) { /* skip unavailable driver */ }
      }
    } catch (e) {
      this.error('sensor-chart: _snapshotAllCaps error:', e.message);
    }
  }

  /**
   * Called by widgets/sensor-chart/api.js — returns filtered history for up
   * to four capability series.
   *
   * @param {object} query  URL query params: s1–s4 (autocomplete ids), hours
   * @returns {{ series: Array<{id, points}> }}
   */
  getSensorChartData(query) {
    const hours  = Math.max(1, parseFloat(query.hours) || 24);
    const cutoff = Date.now() - hours * 3600 * 1000;
    const series = [];

    for (const key of ['s1', 's2', 's3', 's4']) {
      const id = query[key];
      if (!id) continue;

      const points   = this._capHistory ? (this._capHistory.get(id) || []) : [];
      const filtered = points.filter((p) => new Date(p.t).getTime() >= cutoff);
      series.push({ id, points: filtered });
    }

    return { series };
  }

}

module.exports = FusionSolarKioskApp;
