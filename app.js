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
  }

  async onUninit() {
    this.log('FusionSolar app is stopping...');
    if (this._midnightTimer) this.homey.clearTimeout(this._midnightTimer);
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

}

module.exports = FusionSolarKioskApp;
