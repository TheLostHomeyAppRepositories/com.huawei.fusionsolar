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
   */
  _scheduleMidnightBaseline() {
    const now     = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const msUntilMidnight = tomorrow - now;

    this._midnightTimer = this.homey.setTimeout(() => {
      this._saveMidnightBaseline();
      // Re-schedule for the next midnight
      this._scheduleMidnightBaseline();
    }, msUntilMidnight);

    this.log(`Midnight baseline scheduled in ${Math.round(msUntilMidnight / 60000)} min`);
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

  _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  getCoordinator() {
    return this._coordinator;
  }

}

module.exports = FusionSolarKioskApp;
